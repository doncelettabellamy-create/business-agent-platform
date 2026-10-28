// The tool that prepares the private Drew voice files from the existing call config (src/founder-voice-prepare.ts), tested with invented configs and invented secrets in memory and in a temporary folder. It must
// leave the existing config and Twilio untouched, keep the approved special, never overwrite, and never print a secret address, a host or a number. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveVoiceCallConfig, PROPOSED_VOICE_SETTINGS, runPrepare } from '../src/founder-voice-prepare.ts';
import { founderConfigDigest, founderConfigProblems } from '../src/founder-call-gate.ts';
import { founderVoiceConfigProblems } from '../src/founder-voice-gate.ts';
import { consentNoticeFor } from '../src/opening.ts';
import { DREW_TEST_OPENING, DREW_TEST_SPECIAL } from '../src/drew-test-opening.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OLD_SECRET = 'oldSecretPathAbcdefghijklmnopqrstuvwxyz0123456789';
const NEW_SECRET = 'newSecretPathZyxwvutsrqponmlkjihgfedcba9876543210';
const HOST = 'tunnel.founder-demo.net';
const NUMBER = '+15125553377';
const example = JSON.parse(readFileSync(new URL('../examples/founder-call.config.example.json', import.meta.url), 'utf8'));
const source = (over: Record<string, unknown> = {}) => ({ ...example, public_wss_url: `wss://${HOST}:8443/relay/${OLD_SECRET}`, numbers: [NUMBER], expires: new Date(Date.now() + 12 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z'), opening: { business_name: 'Drew Cleaning', special: DREW_TEST_SPECIAL }, ...over });

// ================================================================ the derivation
test('derive: a separate call config with its own id, the OpenAI disclosure, the special kept, and a new secret path on the same host and port; everything else copied', () => {
  const s = source();
  const r = deriveVoiceCallConfig(s, NEW_SECRET);
  assert.ok(r.ok);
  const c = (r as { callConfig: any }).callConfig;
  assert.deepEqual(founderConfigProblems(c), []);
  assert.equal(c.public_wss_url, `wss://${HOST}:8443/relay/${NEW_SECRET}`);
  assert.equal(c.approval_id, 'founder-voice-001');
  assert.deepEqual(c.opening, { business_name: 'Drew Cleaning', special: DREW_TEST_SPECIAL, disclosure: DREW_TEST_OPENING.disclosure });
  for (const k of Object.keys(s).filter((k) => !['approval_id', 'opening', 'public_wss_url'].includes(k))) assert.deepEqual(c[k], (s as Record<string, unknown>)[k], `${k} is copied as it is`);
  assert.notEqual(founderConfigDigest(c), founderConfigDigest(s), 'a different approval: the old one is not reused');
  const notice = consentNoticeFor(c.opening);
  assert.equal(notice.split(DREW_TEST_SPECIAL).length, 2, 'the special is spoken once, verbatim');
  assert.ok(/OpenAI/.test(notice) && !/phone provider/.test(notice));
});

test('derive: the business special in the source is kept as it is, even when it differs from the proposal, and an agent name is kept', () => {
  const r = deriveVoiceCallConfig(source({ opening: { business_name: 'Drew Cleaning', agent_name: 'Ava', special: '$30 off a qualifying first deep cleaning' } }), NEW_SECRET) as { ok: true; callConfig: any; specialMatchesProposal: boolean };
  assert.ok(r.ok);
  assert.deepEqual([r.callConfig.opening.special, r.callConfig.opening.agent_name, r.specialMatchesProposal], ['$30 off a qualifying first deep cleaning', 'Ava', false]);
  const { opening: _gone, ...withoutOpening } = source();   // a source config that never had an opening block
  void _gone;
  const none = deriveVoiceCallConfig(withoutOpening, NEW_SECRET) as { ok: true; callConfig: any };
  assert.equal(none.callConfig.opening.special, DREW_TEST_SPECIAL, 'with no opening in the source, the approved Drew special is used');
});

test('derive: an invalid source, an odd address or a weak secret is refused with fixed text that echoes nothing', () => {
  for (const bad of [{ ...source(), tenant: 'nope' }, source({ public_wss_url: 'wss://host.example.net/other/path' }), null, 'x']) {
    const r = deriveVoiceCallConfig(bad, NEW_SECRET);
    assert.ok(!r.ok);
    assert.ok((r as { problems: string[] }).problems.every((p) => !p.includes(OLD_SECRET) && !p.includes(HOST)));
  }
  assert.ok(!deriveVoiceCallConfig(source(), 'short').ok);
  assert.ok(!deriveVoiceCallConfig(source(), `${NEW_SECRET}!!`).ok);
  assert.deepEqual(founderVoiceConfigProblems(PROPOSED_VOICE_SETTINGS), [], 'the proposed voice settings are valid');
});

// ================================================================ the command, in memory
function memory(files: Record<string, string>) {
  const fs = new Map(Object.entries(files)); const out: string[] = []; const err: string[] = []; const written: string[] = [];
  const io = {
    read: (p: string) => { const t = fs.get(p); if (t === undefined) throw new Error('missing'); return t; },
    exists: (p: string) => fs.has(p), writeNew: (p: string, t: string) => { if (fs.has(p)) throw new Error('exists'); fs.set(p, t); written.push(p); },
    log: (s: string) => { out.push(s); }, err: (s: string) => { err.push(s); }, now: () => Date.now(), secret: () => NEW_SECRET,
  };
  return { io, fs, out, err, written };
}

test('command: writes both private files, leaves the source byte for byte as it was, and prints no secret, host or number', () => {
  const text = JSON.stringify(source());
  const m = memory({ 'founder-call.config.json': text });
  assert.equal(runPrepare([], m.io), 0, m.err.join('|'));
  assert.deepEqual(m.written.sort(), ['founder-voice-call.config.json', 'founder-voice.config.json']);
  assert.equal(m.fs.get('founder-call.config.json'), text, 'the existing config is untouched');
  assert.deepEqual(founderConfigProblems(JSON.parse(m.fs.get('founder-voice-call.config.json')!)), []);
  assert.deepEqual(founderVoiceConfigProblems(JSON.parse(m.fs.get('founder-voice.config.json')!)), []);
  const shown = [...m.out, ...m.err].join('\n');
  for (const s of [OLD_SECRET, NEW_SECRET, HOST, NUMBER, '8443', 'sk-']) assert.ok(!shown.includes(s), `printed: ${s}`);
  assert.ok(shown.includes(DREW_TEST_SPECIAL) && /NEW random secret path/.test(shown) && /Twilio was not touched/.test(shown) && /days from now/.test(shown));
});

test('command: an existing voice call config is never overwritten, and an existing voice settings file is left exactly as it is', () => {
  const mine = '{"approval_id":"mine"}';
  const a = memory({ 'founder-call.config.json': JSON.stringify(source()), 'founder-voice-call.config.json': mine });
  assert.equal(runPrepare([], a.io), 73);
  assert.deepEqual(a.written, []);
  assert.equal(a.fs.get('founder-voice-call.config.json'), mine);
  const settings = '{"approval_id":"founder-voice-001","custom":true}';
  const b = memory({ 'founder-call.config.json': JSON.stringify(source()), 'founder-voice.config.json': settings });
  assert.equal(runPrepare([], b.io), 0);
  assert.deepEqual(b.written, ['founder-voice-call.config.json']);
  assert.equal(b.fs.get('founder-voice.config.json'), settings, 'the founder\'s own settings are not replaced');
  assert.ok(b.out.some((l) => /Left founder-voice.config.json exactly as it was/.test(l)));
});

test('command: an expired or too-distant approval is flagged in plain words, and bad arguments or sources stop with their own codes', () => {
  const expired = memory({ 'founder-call.config.json': JSON.stringify(source({ expires: '2026-01-01T00:00:00Z' })) });
  assert.equal(runPrepare([], expired.io), 0);
  assert.ok(expired.out.some((l) => /EXPIRED/.test(l)));
  const far = memory({ 'founder-call.config.json': JSON.stringify(source({ expires: new Date(Date.now() + 90 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z') })) });
  assert.equal(runPrepare([], far.io), 0);
  assert.ok(far.out.some((l) => /more than 30 days/.test(l)));
  const m = memory({ 'founder-call.config.json': JSON.stringify(source()) });
  assert.equal(runPrepare(['--bogus'], m.io), 64);
  assert.equal(runPrepare(['--to', '../x.json'], m.io), 64);
  assert.equal(runPrepare(['--to', 'founder-call.config.json'], m.io), 64, 'the three names must differ');
  assert.equal(runPrepare(['--from', 'missing.json'], m.io), 66);
  assert.equal(runPrepare([], memory({ 'founder-call.config.json': '{"tenant":"x"}' }).io), 65);
  assert.deepEqual(m.written, []);
});

// ================================================================ the real command in a temporary folder
test('command line: run for real in a temporary folder it writes the files, prints no secret, refuses to run twice, and the voice entry\'s dry run accepts the result', () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-prepare-'));
  try {
    const original = JSON.stringify(source({ kill_file: 'stop.flag', db_path: 'calls.sqlite' }));
    writeFileSync(join(dir, 'founder-call.config.json'), original);
    const base: Record<string, string> = { PATH: process.env.PATH ?? '' }; if (process.env.SystemRoot) base.SystemRoot = process.env.SystemRoot;
    const run = (script: string, args: string[]) => spawnSync(process.execPath, [join(ROOT, 'src', script), ...args], { cwd: dir, env: base, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
    const first = run('founder-voice-prepare.ts', []);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(readdirSync(dir).sort(), ['founder-call.config.json', 'founder-voice-call.config.json', 'founder-voice.config.json']);
    assert.equal(readFileSync(join(dir, 'founder-call.config.json'), 'utf8'), original);
    const made = JSON.parse(readFileSync(join(dir, 'founder-voice-call.config.json'), 'utf8'));
    assert.notEqual(made.public_wss_url, JSON.parse(original).public_wss_url);
    assert.ok(/\/relay\/[A-Za-z0-9_-]{43}$/.test(made.public_wss_url), 'a fresh 256-bit secret path');
    for (const s of [OLD_SECRET, made.public_wss_url.split('/relay/')[1], HOST, NUMBER]) assert.ok(!first.stdout.includes(s) && !first.stderr.includes(s), `printed: ${s.slice(0, 6)}`);
    assert.equal(run('founder-voice-prepare.ts', []).status, 73, 'a second run refuses to overwrite');
    // The result is accepted by the voice entry (dry run only: no port, no key, nothing sent). Its output holds the new address, so only its status and a few fixed lines are checked here.
    const dry = run('founder-voice-entry.ts', ['--config', 'founder-voice-call.config.json', '--voice-config', 'founder-voice.config.json']);
    assert.equal(dry.status, 0, dry.stderr);
    assert.ok(dry.stdout.includes('DRY RUN') && dry.stdout.includes('<Stream url="wss://') && dry.stdout.includes('<Hangup />'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ================================================================ the private files stay out of git
test('git: both new private file names are ignored, and the tool reads no key and no environment variable', () => {
  const ignore = readFileSync(new URL('../../../.gitignore', import.meta.url), 'utf8');
  for (const name of ['founder-call.config.json', 'founder-voice-call.config.json', 'founder-voice.config.json']) assert.ok(ignore.split(/\r?\n/).includes(name), `${name} must be git-ignored`);
  const code = readFileSync(new URL('../src/founder-voice-prepare.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/process\.env|OPENAI|fetch\s*\(|node:https?|node:net/.test(code), 'no key, no environment, no network');
});
