// Windows DPAPI protection for the Jobber connector's stored credentials and tokens (proof of concept). The text goes to PowerShell on STANDARD INPUT only (never in an argument, so it is not in a process list),
// is protected for the CURRENT WINDOWS USER (ConvertFrom-SecureString without a key), and only the protected blob is written to disk. Another user, or another machine, cannot unprotect it.
// No secret is logged: a failure is a fixed code word.

import { spawn } from 'node:child_process';
import { JobberError } from './jobber-connector.ts';
import type { Protector } from './jobber-connector.ts';

const PROTECT = "[Console]::InputEncoding = [Text.Encoding]::UTF8; $p = [Console]::In.ReadToEnd(); ConvertTo-SecureString $p -AsPlainText -Force | ConvertFrom-SecureString";
const UNPROTECT = "[Console]::InputEncoding = [Text.Encoding]::UTF8; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $c = [Console]::In.ReadToEnd().Trim(); $s = ConvertTo-SecureString $c; [Console]::Out.Write([Net.NetworkCredential]::new('', $s).Password)";

function run(script: string, input: string, timeoutMs = 20_000): Promise<string> {
  return new Promise((ok, fail) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const out: Buffer[] = []; let done = false;
    const end = (e?: unknown, v?: string): void => { if (done) return; done = true; clearTimeout(timer); e === undefined ? ok(v ?? '') : fail(e); };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } end(new JobberError('TIMEOUT')); }, timeoutMs);
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.on('error', () => end(new JobberError('BAD_CONFIG')));
    child.on('close', (code) => (code === 0 ? end(undefined, Buffer.concat(out).toString('utf8')) : end(new JobberError('BAD_CONFIG'))));
    child.stdin.on('error', () => undefined);
    child.stdin.end(input, 'utf8');
  });
}

export function windowsProtector(): Protector {
  return {
    async protect(plain: string): Promise<string> { const r = (await run(PROTECT, plain)).trim(); if (!/^[0-9a-f]{20,}$/i.test(r)) throw new JobberError('BAD_CONFIG'); return r; },
    async unprotect(blob: string): Promise<string> { return run(UNPROTECT, blob); },
  };
}
