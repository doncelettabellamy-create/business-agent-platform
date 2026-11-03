// Opens the Jobber approval page in Microsoft Edge on Windows (standalone helper for the Jobber connector entry point; nothing else imports it).
// The earlier launch ran PowerShell with `-Command 'Start-Process $args[0]' <url>`; with -Command the extra argument is appended to the command text instead of arriving in $args, so nothing opened and nothing failed.
// This starts msedge.exe directly with the link as ONE argument (no shell, no quoting problems), detached, and reports a fixed reason code if it cannot. The link is never printed or logged.

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

export type LaunchResult = { launched: true } | { launched: false; reason: 'NO_EDGE' | 'SPAWN_FAILED' | 'BAD_LINK' };
export interface LaunchDeps { spawn?: (file: string, args: string[], o: SpawnOptions) => ChildProcess; exists?: (p: string) => boolean; env?: Record<string, string | undefined> }

/** The Edge executable: JOBBER_BROWSER (an explicit path) first, then the two standard install folders. */
export function findEdge(exists: (p: string) => boolean = existsSync, env: Record<string, string | undefined> = process.env): string | undefined {
  const candidates = [env.JOBBER_BROWSER, `${env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'}\\Microsoft\\Edge\\Application\\msedge.exe`, `${env.ProgramFiles ?? 'C:\\Program Files'}\\Microsoft\\Edge\\Application\\msedge.exe`];
  return candidates.find((c): c is string => typeof c === 'string' && c.length > 0 && /msedge\.exe$/i.test(c) && exists(c));
}

/** Opens `link` (an https or loopback http address only) in a new Edge tab. Resolves once the process has started, or with the reason it could not. */
export function openInEdge(link: string, deps: LaunchDeps = {}): Promise<LaunchResult> {
  if (typeof link !== 'string' || !/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(link) || link.length > 4000 || /[\s"<>]/.test(link)) return Promise.resolve({ launched: false, reason: 'BAD_LINK' });
  const edge = findEdge(deps.exists, deps.env);
  if (edge === undefined) return Promise.resolve({ launched: false, reason: 'NO_EDGE' });
  const spawn = deps.spawn ?? nodeSpawn;
  return new Promise((resolve) => {
    try {
      const child = spawn(edge, ['--new-tab', link], { detached: true, stdio: 'ignore', windowsHide: false });
      child.once('error', () => resolve({ launched: false, reason: 'SPAWN_FAILED' }));
      child.once('spawn', () => { try { child.unref(); } catch { /* already gone */ } resolve({ launched: true }); });
    } catch { resolve({ launched: false, reason: 'SPAWN_FAILED' }); }
  });
}

/** Last resort when no browser could be opened: puts the link on the clipboard (never on the screen) so it can be pasted into Edge. */
export function copyToClipboard(link: string, spawn: (file: string, args: string[], o: SpawnOptions) => ChildProcess = nodeSpawn): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const c = spawn('clip.exe', [], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      c.once('error', () => resolve(false)); c.once('close', (code) => resolve(code === 0));
      c.stdin?.on('error', () => undefined); c.stdin?.end(link);
    } catch { resolve(false); }
  });
}
