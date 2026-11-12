// Tests for src/run-evidence.ts (the running commit and the ordered FAST_STEP tokens) and for the two lines in src/founder-voice-entry.ts that use it. Offline: a fake file reader, no server.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MAX_STEPS, headCommit, logSteps, stepEvents } from '../src/run-evidence.ts';
import { fileDiagSink } from '../src/call-diag.ts';
import { parseLog, scoreCall, splitCalls } from '../tools/reliability-scorecard.ts';

const H1 = '0123456789abcdef0123456789abcdef01234567'; const H2 = 'fedcba9876543210fedcba9876543210fedcba98';
const fsOf = (files: Record<string, string | Error>, seen: string[] = []) => (p: string): string | undefined => { seen.push(p); const v = files[p]; if (v instanceof Error) throw v; return v; };

test('headCommit: a symbolic HEAD gives the first 12 hex characters of its loose ref; a detached HEAD gives its own hash', () => {
  assert.equal(headCommit(fsOf({ 'G/HEAD': 'ref: refs/heads/main\n', 'G/refs/heads/main': H1 + '\n' }), 'G'), H1.slice(0, 12));
  assert.equal(headCommit(fsOf({ 'G/HEAD': H2 + '\n' }), 'G'), H2.slice(0, 12));
  assert.equal(headCommit(fsOf({ 'G/HEAD': 'ref: refs/heads/feature/x-1.2\r\n', 'G/refs/heads/feature/x-1.2': H1 }), 'G'), H1.slice(0, 12));
});

test('headCommit: falls back to packed-refs when the ref is not loose, and takes the matching ref only', () => {
  const packed = `# pack-refs with: peeled fully-peeled sorted\n${H2} refs/heads/other\n${H1} refs/heads/main\n^${H2}\n`;
  assert.equal(headCommit(fsOf({ 'G/HEAD': 'ref: refs/heads/main', 'G/packed-refs': packed }), 'G'), H1.slice(0, 12));
  assert.equal(headCommit(fsOf({ 'G/HEAD': 'ref: refs/heads/missing', 'G/packed-refs': packed }), 'G'), undefined);
  assert.equal(headCommit(fsOf({ 'G/HEAD': 'ref: refs/heads/main', 'G/refs/heads/main': 'not a hash', 'G/packed-refs': packed }), 'G'), H1.slice(0, 12), 'a bad loose ref falls back to packed-refs');
});

test('headCommit: fails safe: anything unreadable, malformed or oversize gives undefined, never a throw, never a guess', () => {
  const bad: Array<Record<string, string | Error>> = [
    {}, { 'G/HEAD': '' }, { 'G/HEAD': 'garbage' }, { 'G/HEAD': 'ref: refs/heads/main' }, { 'G/HEAD': 'ref: refs/heads/main', 'G/refs/heads/main': 'xyz' }, { 'G/HEAD': H1.toUpperCase() },
    { 'G/HEAD': 'ref: refs/heads/../../etc/passwd', 'G/refs/heads/../../etc/passwd': H1 }, { 'G/HEAD': 'ref: /etc/passwd', '/etc/passwd': H1 }, { 'G/HEAD': 'ref: refs//heads/main', 'G/refs//heads/main': H1 }, { 'G/HEAD': 'ref: refs/heads/a b' },
    { 'G/HEAD': 'x'.repeat(5000) }, { 'G/HEAD': new Error('EACCES') }, { 'G/HEAD': 'ref: refs/heads/main', 'G/refs/heads/main': new Error('EIO'), 'G/packed-refs': new Error('EIO') }, { 'G/HEAD': 'ref: refs/heads/main', 'G/packed-refs': 'x'.repeat(3_000_000) },
    { 'G/HEAD': 'ref: refs/heads/main', 'G/packed-refs': `${H1.slice(0, 39)} refs/heads/main\n${H1} refs/heads/main2\n` },
    { 'G/HEAD': H1 + ' '.repeat(5000) }, { 'G/HEAD': 'ref: refs/heads/main', 'G/packed-refs': `${H1} refs/heads/main\n` + '#'.repeat(3_000_000) },   // a valid hash inside an oversize file is still refused
  ];
  for (const files of bad) assert.equal(headCommit(fsOf(files), 'G'), undefined, JSON.stringify(Object.keys(files)));
  for (const gitDir of ['', undefined as unknown as string, 42 as unknown as string]) assert.equal(headCommit(fsOf({ 'G/HEAD': H1 }), gitDir), undefined);
  assert.equal(headCommit(undefined as unknown as never, 'G'), undefined); assert.equal(headCommit((() => { throw new Error('x'); }) as never, 'G'), undefined);
});

test('headCommit: reads only HEAD, the one ref file and packed-refs: never .git/config or anything else', () => {
  const seen: string[] = []; headCommit(fsOf({ 'G/HEAD': 'ref: refs/heads/main' }, seen), 'G'); headCommit(fsOf({ 'G/HEAD': 'ref: refs/heads/main', 'G/packed-refs': `${H1} refs/heads/main` }, seen), 'G');
  for (const p of seen) assert.ok(['G/HEAD', 'G/refs/heads/main', 'G/packed-refs'].includes(p), p);
  assert.ok(!seen.some((p) => /config|credentials|hooks|index/.test(p)));
});

test('headCommit: on the real repository it agrees with git (when git is available)', () => {
  const gitDir = fileURLToPath(new URL('../../../.git', import.meta.url));
  const mine = headCommit((p) => { try { return readFileSync(p, 'utf8'); } catch { return undefined; } }, gitDir);
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(new URL('../../..', import.meta.url)), encoding: 'utf8' });
  if (r.status !== 0) return;   // no git here: nothing to compare with
  assert.equal(mine, r.stdout.trim().slice(0, 12)); assert.match(mine ?? '', /^[0-9a-f]{12}$/);
});

test('stepEvents: keeps fixed codes in their original order with their original position; drops everything else, so nothing a caller said can reach the log', () => {
  assert.deepEqual(stepEvents(['NAME', 'ADDRESS', 'NAME_CONFIRMED', 'READBACK', 'BOOKING_BOOKED_VERIFIED', 'EMAILS_SENT']), [{ n: 1, s: 'NAME' }, { n: 2, s: 'ADDRESS' }, { n: 3, s: 'NAME_CONFIRMED' }, { n: 4, s: 'READBACK' }, { n: 5, s: 'BOOKING_BOOKED_VERIFIED' }, { n: 6, s: 'EMAILS_SENT' }]);
  assert.deepEqual(stepEvents(['NAME', 'Jane Doe', 'ADDRESS', '15951 Woodland', 'lower', 'AB', 'A'.repeat(49), 'OK_STEP', '', 42, null, undefined, {}, ['X']]), [{ n: 1, s: 'NAME' }, { n: 3, s: 'ADDRESS' }, { n: 8, s: 'OK_STEP' }], 'the gaps in n show what was dropped');
  assert.deepEqual(stepEvents(Array.from({ length: 60 }, (_, i) => 'STEP_' + String.fromCharCode(65 + (i % 26)))).length, MAX_STEPS, 'at most 40');
  for (const notList of [undefined, null, 'NAME', 7, {}, { length: 3 }]) assert.deepEqual(stepEvents(notList), []);
  const hostile = new Proxy([], { get() { throw new Error('boom'); } }); assert.deepEqual(stepEvents(hostile), []);
});

test('logSteps: one FAST_STEP line per step, in order, through the real sanitizer; it never throws, even when the sink does', () => {
  const lines: string[] = []; const sink = fileDiagSink({ append: (l) => lines.push(l.trimEnd()), nowIso: () => '2026-11-07T20:00:00Z' });
  logSteps(sink, ['CALLER_VERIFIED', 'NAME_CONFIRMED', 'STREET_CONFIRMED', 'READBACK', 'BOOKING_BOOKED_VERIFIED', 'Jane Doe at 12 Elm St']);
  assert.deepEqual(lines, ['2026-11-07T20:00:00Z FAST_STEP {"n":1,"s":"CALLER_VERIFIED"}', '2026-11-07T20:00:00Z FAST_STEP {"n":2,"s":"NAME_CONFIRMED"}', '2026-11-07T20:00:00Z FAST_STEP {"n":3,"s":"STREET_CONFIRMED"}', '2026-11-07T20:00:00Z FAST_STEP {"n":4,"s":"READBACK"}', '2026-11-07T20:00:00Z FAST_STEP {"n":5,"s":"BOOKING_BOOKED_VERIFIED"}']);
  assert.ok(!lines.join('\n').includes('Jane'));
  let tries = 0; const thrower = () => { tries++; throw new Error('disk full'); };
  assert.doesNotThrow(() => logSteps(thrower, ['NAME', 'ADDRESS', 'READBACK'])); assert.equal(tries, 3, 'one lost line does not stop the rest');
  assert.doesNotThrow(() => logSteps(thrower, undefined)); assert.doesNotThrow(() => logSteps(undefined as never, ['NAME']));
  assert.doesNotThrow(() => logSteps(thrower, new Proxy([], { get() { throw new Error('boom'); } })));
});

test('the entry: SERVER_START carries the commit only through headCommit, FAST_STEP goes through logSteps after FAST_OUTCOME, and the entry still writes nothing but its one log', () => {
  const src = readFileSync(new URL('../src/founder-voice-entry.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(/import \{ headCommit, logSteps \} from '\.\/run-evidence\.ts'/.test(src));
  assert.ok(/const commit = headCommit\(/.test(src) && /sink\('SERVER_START', \{[^}]*\.\.\.\(commit === undefined \? \{\} : \{ commit \}\)/.test(src), 'the commit is optional on SERVER_START');
  assert.ok(/onOutcome: \(o\) => \{ sink\('FAST_OUTCOME'[^;]*\); logSteps\(sink, o\.steps\);( refreshPending\(\);)? \}/.test(src), 'logSteps follows FAST_OUTCOME');   // refreshPending(): the dashboard's pending-booking snapshot refresh (tests/pending-dashboard.test.ts); it comes after the step log and can never throw
  assert.equal([...src.matchAll(/appendFileSync\(/g)].length, 1, 'the only thing the entry writes is its log'); assert.ok(!/writeFileSync|createWriteStream|writeFile\(|child_process|execSync|spawn/.test(src), 'no process is started and nothing else is written');
  const mod = readFileSync(new URL('../src/run-evidence.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\bimport\b|process\.env|child_process|fetch\(|writeFile|appendFile|require\(/.test(mod), 'the module imports nothing, reads no environment and writes nothing');
});

test('the scorecard: a SERVER_START that carries the logged commit makes the CODE check PASS, and one without it stays BLOCKED', () => {
  const sink = (lines: string[]) => fileDiagSink({ append: (l) => lines.push(l.trimEnd()), nowIso: () => '2026-11-07T20:00:00Z' });
  const call = (commit: string | undefined): string => { const lines: string[] = []; const s = sink(lines); s('SERVER_START', { pid: 1, relayPort: 8788, ...(commit === undefined ? {} : { commit }) }); s('CALL_STREAM_ACCEPTED', { call: 1 }); s('FAST_NAME', { path: 'CONFIRM' }); return lines.join('\n'); };
  const check = (text: string) => scoreCall(splitCalls(parseLog(text))[0]).checks.find((c) => c.id === 'CODE')!;
  assert.deepEqual([check(call(H1.slice(0, 12))).status, check(call(H1.slice(0, 12))).why], ['PASS', 'COMMIT_LOGGED']);
  assert.deepEqual([check(call(undefined)).status, check(call(undefined)).why], ['BLOCKED', 'NO_COMMIT_LOGGED']);
});
