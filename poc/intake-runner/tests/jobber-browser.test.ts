// The Jobber approval page is opened in Microsoft Edge by starting msedge.exe directly with the link as one argument (the earlier PowerShell `-Command ... $args[0]` launch opened nothing and reported nothing).
// No browser is started here: spawn and the file check are stand-ins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { copyToClipboard, findEdge, openInEdge } from '../src/jobber-browser.ts';

const LINK = 'https://api.getjobber.com/api/oauth/authorize?response_type=code&client_id=test-client-id-0001&redirect_uri=http%3A%2F%2Flocalhost%3A8765%2Fjobber%2Fcallback&state=abc_DEF-123&code_challenge=xyz&code_challenge_method=S256';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const fakeChild = (outcome: 'spawn' | 'error') => { const c = new EventEmitter() as EventEmitter & { unref(): void; stdin: null }; c.unref = () => undefined; c.stdin = null; queueMicrotask(() => c.emit(outcome, outcome === 'error' ? new Error('x') : undefined)); return c as never; };

test('Edge is found at the standard folders or at the explicit JOBBER_BROWSER path, and only an msedge.exe path counts', () => {
  assert.equal(findEdge((p) => p === EDGE, {}), EDGE);
  assert.equal(findEdge((p) => p === 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', {}), 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');
  assert.equal(findEdge(() => true, { JOBBER_BROWSER: 'D:\\tools\\msedge.exe' }), 'D:\\tools\\msedge.exe');
  assert.equal(findEdge(() => true, { JOBBER_BROWSER: 'D:\\tools\\evil.exe', 'ProgramFiles(x86)': 'Z:\\x', ProgramFiles: 'Z:\\y' }), 'Z:\\x\\Microsoft\\Edge\\Application\\msedge.exe');
  assert.equal(findEdge(() => false, {}), undefined);
});

test('launch: msedge.exe is started directly (no shell) with the whole link as ONE argument, detached; the result is launched', async () => {
  const calls: Array<{ file: string; args: string[]; o: Record<string, unknown> }> = [];
  const r = await openInEdge(LINK, { exists: (p) => p === EDGE, env: {}, spawn: (file, args, o) => { calls.push({ file, args, o: o as Record<string, unknown> }); return fakeChild('spawn'); } });
  assert.deepEqual(r, { launched: true });
  assert.equal(calls.length, 1); assert.equal(calls[0].file, EDGE);
  assert.deepEqual(calls[0].args, ['--new-tab', LINK]);
  assert.equal(calls[0].o.detached, true); assert.ok(calls[0].o.shell !== true);
});

test('launch failures are fixed reason codes: no Edge, a spawn error, and a link that is not an https or loopback address (nothing is started for those)', async () => {
  let started = 0;
  const spawn = () => { started++; return fakeChild('error'); };
  assert.deepEqual(await openInEdge(LINK, { exists: () => false, env: {}, spawn }), { launched: false, reason: 'NO_EDGE' });
  assert.deepEqual(await openInEdge(LINK, { exists: () => true, env: {}, spawn }), { launched: false, reason: 'SPAWN_FAILED' });
  const before = started;
  for (const bad of ['file:///C:/x', 'javascript:alert(1)', 'ftp://x', 'https://x y', 'https://x"y', '', 'https://' + 'a'.repeat(4000)]) assert.deepEqual(await openInEdge(bad, { exists: () => true, env: {}, spawn }), { launched: false, reason: 'BAD_LINK' }, bad.slice(0, 20));
  assert.equal(started, before, 'a bad link never reaches spawn');
});

test('clipboard fallback: the link goes to clip.exe on standard input, never in an argument', async () => {
  const seen: { file: string; args: string[]; written: string } = { file: '', args: [], written: '' };
  const spawn = (file: string, args: string[]) => {
    const c = new EventEmitter() as EventEmitter & { stdin: { on(): void; end(s: string): void } };
    c.stdin = { on: () => undefined, end: (s: string) => { seen.written = s; queueMicrotask(() => c.emit('close', 0)); } };
    seen.file = file; seen.args = args; return c as never;
  };
  assert.equal(await copyToClipboard(LINK, spawn), true);
  assert.deepEqual([seen.file, seen.args, seen.written], ['clip.exe', [], LINK]);
});

test('regression and containment: the entry point no longer runs PowerShell with $args to open a page, prints no link, and nothing but the entry point imports the browser helper', () => {
  const src = join(import.meta.dirname, '..', 'src');
  const main = readFileSync(join(src, 'jobber-connect-main.ts'), 'utf8'); const browser = readFileSync(join(src, 'jobber-browser.ts'), 'utf8');
  assert.ok(!/\$args\[0\]/.test(main) && !/Start-Process/.test(main + browser.replace(/\/\/.*$/gm, '')), 'the broken launch is gone');
  assert.ok(!/\$\{[^}]*\b(?:url|link)\b[^}]*\}/.test(main), 'the link is never interpolated into any printed text');
  assert.ok(!/(?:say|console\.log|console\.error)\(\s*(?:s\.url|url|link)\s*\)/.test(main), 'the link is never printed directly');
});
