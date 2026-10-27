// The gate for the founder VOICE test (src/founder-voice-gate.ts) and the command line that uses it (src/founder-voice-entry.ts, run as a child process in DRY RUN and in refused-serve mode only: it opens no port,
// makes no connection and sends nothing). Invented values and invented keys only. Run: npm test
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { founderConfigDigest, founderConfigProblems } from '../src/founder-call-gate.ts';
import { effectiveVoiceSettings, founderVoiceConfigProblems, founderVoiceDigest, founderVoiceGateProblems, voiceBounds } from '../src/founder-voice-gate.ts';
import type { FounderCallConfig } from '../src/founder-call-gate.ts';
import type { FounderVoiceConfig } from '../src/founder-voice-gate.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = '2026-10-27T12:00:00Z';
const SECRET = 'q7Zr2KfX9mWc4TbV8nHs1LpD6yGe3AuJ5oRi0NxE';
const TOKEN = 'invented-twilio-token-0123456789';
const KEY = 'sk-test-not-a-real-key-0123456789';
const CANARY = 'canary-value-5521';
const example = JSON.parse(readFileSync(new URL('../examples/founder-call.config.example.json', import.meta.url), 'utf8'));
const exampleVoice = JSON.parse(readFileSync(new URL('../examples/founder-voice.config.example.json', import.meta.url), 'utf8'));
const callConfig = (over: Record<string, unknown> = {}): FounderCallConfig => ({ ...example, public_wss_url: `wss://tunnel.founder-demo.net/relay/${SECRET}`, numbers: ['+15125553377'], expires: '2026-11-20T00:00:00Z', ...over });
const voiceConfig = (over: Record<string, unknown> = {}): FounderVoiceConfig => ({ ...exampleVoice, openai_model: 'gpt-test-model', realtime_model: 'realtime-test-model', transcription_model: 'gpt-live-transcribe', voice: 'test-voice', ...over });
const okEnv = (c = callConfig(), v = voiceConfig()) => ({ allowLive: 'yes', callApprovedDigest: founderConfigDigest(c), voiceApprovedDigest: founderVoiceDigest(c, v), twilioTokenPresent: true, openaiKeyPresent: true });
const gate = (o: { c?: FounderCallConfig; v?: unknown; env?: Partial<ReturnType<typeof okEnv>>; now?: string } = {}) => {
  const c = o.c ?? callConfig(); const v = o.v ?? voiceConfig();
  return founderVoiceGateProblems({ callConfig: c, voiceConfig: v, env: { ...okEnv(c, v as FounderVoiceConfig), ...o.env }, nowIso: o.now ?? NOW });
};

// ================================================================ the voice config
test('voice config: a complete config with exact model ids and the Drew persona passes; the example file does not until the founder fills in the models', () => {
  assert.deepEqual(founderVoiceConfigProblems(voiceConfig()), []);
  assert.deepEqual(founderVoiceConfigProblems(voiceConfig({ safety_identifier: 'drew-founder-test' })), []);
  assert.ok(founderVoiceConfigProblems(exampleVoice).length > 0, 'the example still holds REPLACE-WITH placeholders, so it cannot be approved by accident');
  assert.deepEqual(exampleVoice.persona, JSON.parse(readFileSync(new URL('../examples/persona-drew-cleaning.json', import.meta.url), 'utf8')), 'the example carries the approved Drew persona');
});

test('voice config: unknown keys, bad models, a bad voice, a bad persona and silly limits are refused with fixed text that echoes nothing', () => {
  const bad: Array<[string, unknown]> = [
    ['extra key', { ...voiceConfig(), [CANARY]: 1 }], ['missing key', (({ voice, ...rest }) => rest)(voiceConfig())], ['claude model', voiceConfig({ openai_model: 'claude-haiku-5-5' })],
    ['model with injection', voiceConfig({ realtime_model: `x&key=${CANARY}` })], ['empty transcription', voiceConfig({ transcription_model: '' })], ['voice with space', voiceConfig({ voice: `a ${CANARY}` })],
    ['zero calls', voiceConfig({ max_openai_calls: 0 })], ['too many calls', voiceConfig({ max_openai_calls: 601 })], ['float calls', voiceConfig({ max_openai_calls: 1.5 })],
    ['free-text trait', voiceConfig({ persona: { business_name: 'Drew Cleaning', traits: [`friendly ${CANARY}`] } })], ['persona not an object', voiceConfig({ persona: 'Drew' })],
    ['bad safety id', voiceConfig({ safety_identifier: `id ${CANARY}` })], ['not an object', 'x'], ['null', null], ['array', []],
  ];
  for (const [name, v] of bad) {
    const problems = founderVoiceConfigProblems(v);
    assert.ok(problems.length > 0, name);
    for (const m of problems) assert.ok(!m.includes(CANARY), `${name}: ${m}`);
  }
});

// ================================================================ reasoning and transcription settings
const without = (o: Record<string, unknown>, ...keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

test('settings: with none given, the documented defaults apply: minimal voice reasoning, no text reasoning, English hints for the transcribers that document them', () => {
  const bare = without(voiceConfig(), 'realtime_reasoning', 'text_reasoning', 'transcription') as unknown as FounderVoiceConfig;
  assert.deepEqual(founderVoiceConfigProblems(bare), []);
  assert.deepEqual(effectiveVoiceSettings(bare), { realtimeReasoning: 'minimal', textReasoning: 'none', transcription: { languages: ['en'] } });
  const whisper = { ...bare, transcription_model: 'whisper-1' } as FounderVoiceConfig;
  assert.deepEqual(founderVoiceConfigProblems(whisper), [], 'another transcriber is allowed when no hints are asked for');
  assert.equal(effectiveVoiceSettings(whisper).transcription, undefined, 'and gets no hints');
});

test('settings: explicit values are used as given, and the example carries the proposed ones in plain sight', () => {
  const v = voiceConfig({ realtime_reasoning: 'low', text_reasoning: 'medium', transcription: { languages: ['en', 'es'], keywords: ['Drew Cleaning', 'deep clean'] } });
  assert.deepEqual(founderVoiceConfigProblems(v), []);
  assert.deepEqual(effectiveVoiceSettings(v), { realtimeReasoning: 'low', textReasoning: 'medium', transcription: { languages: ['en', 'es'], keywords: ['Drew Cleaning', 'deep clean'] } });
  assert.deepEqual([exampleVoice.realtime_reasoning, exampleVoice.text_reasoning, exampleVoice.transcription], ['minimal', 'none', { languages: ['en'], keywords: ['Drew Cleaning'] }]);
  for (const e of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) assert.deepEqual(founderVoiceConfigProblems(voiceConfig({ text_reasoning: e })), [], e);
  for (const e of ['minimal', 'low', 'medium', 'high', 'xhigh']) assert.deepEqual(founderVoiceConfigProblems(voiceConfig({ realtime_reasoning: e })), [], e);
});

test('settings: invalid values are refused with fixed text that echoes nothing, and hints need a transcriber that documents them', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['voice effort none', { realtime_reasoning: 'none' }], ['voice effort max', { realtime_reasoning: 'max' }], ['voice effort junk', { realtime_reasoning: CANARY }], ['voice effort number', { realtime_reasoning: 3 }],
    ['text effort junk', { text_reasoning: CANARY }], ['text effort number', { text_reasoning: 1 }], ['text effort empty', { text_reasoning: '' }],
    ['hints not an object', { transcription: 'en' }], ['unknown hint key', { transcription: { prompt: CANARY } }], ['delay hint', { transcription: { delay: 'low' } }], ['bad language', { transcription: { languages: [CANARY] } }],
    ['bracket keyword', { transcription: { keywords: [`<${CANARY}>`] } }], ['hints for whisper', { transcription_model: 'whisper-1', transcription: { languages: ['en'] } }],
    ['hints for another transcriber', { transcription_model: `other-${CANARY}`, transcription: { languages: ['en'] } }],
  ];
  for (const [name, over] of bad) {
    const problems = founderVoiceConfigProblems(voiceConfig(over));
    assert.ok(problems.length > 0, name);
    for (const m of problems) assert.ok(!m.includes(CANARY), `${name}: ${m}`);
  }
});

test('settings: changing a setting withdraws the approval, because the digest covers the file as written', () => {
  const c = callConfig(); const v = voiceConfig();
  const env = okEnv(c, v);
  for (const v2 of [voiceConfig({ realtime_reasoning: 'low' }), voiceConfig({ text_reasoning: 'low' }), voiceConfig({ transcription: { languages: ['en'] } }), voiceConfig({ transcription: { languages: ['en'], keywords: ['Other'] } })]) {
    assert.ok(founderVoiceGateProblems({ callConfig: c, voiceConfig: v2, env, nowIso: NOW }).some((p) => /FOUNDER_VOICE_APPROVED_DIGEST/.test(p)));
  }
});

// ================================================================ the gate
test('gate: every check passes only when both configs are valid, both digests match, the live switch is on and both credentials are present', () => {
  assert.deepEqual(gate(), []);
  assert.deepEqual(voiceBounds(callConfig(), voiceConfig()), { calls: example.max_calls, minutesPerCall: example.max_minutes, maxVoiceMinutes: example.max_calls * example.max_minutes, maxOpenaiCalls: 100 });
});

test('gate: each missing approval is named, and the existing call gate still applies in full', () => {
  assert.ok(gate({ env: { allowLive: undefined } }).some((p) => /INTAKE_ALLOW_LIVE_CALLS/.test(p)));
  assert.ok(gate({ env: { allowLive: 'true' } }).some((p) => /INTAKE_ALLOW_LIVE_CALLS/.test(p)));
  assert.ok(gate({ env: { twilioTokenPresent: false } }).some((p) => /Twilio/.test(p)));
  assert.ok(gate({ env: { openaiKeyPresent: false } }).some((p) => /OpenAI key/.test(p)));
  assert.ok(gate({ env: { callApprovedDigest: undefined } }).some((p) => /FOUNDER_CALL_APPROVED_DIGEST/.test(p)));
  assert.ok(gate({ env: { voiceApprovedDigest: undefined } }).some((p) => /FOUNDER_VOICE_APPROVED_DIGEST/.test(p)));
  assert.ok(gate({ env: { voiceApprovedDigest: founderConfigDigest(callConfig()) } }).some((p) => /FOUNDER_VOICE_APPROVED_DIGEST/.test(p)), 'the call digest is not the voice digest');
  assert.ok(gate({ now: '2026-12-01T00:00:00Z' }).some((p) => /expired/.test(p)), 'an expired approval');
  assert.ok(gate({ c: callConfig({ expires: '2027-06-01T00:00:00Z' }) }).some((p) => /days/.test(p)), 'longer than 30 days');
  assert.ok(gate({ c: callConfig({ public_wss_url: example.public_wss_url }) }).some((p) => /placeholder/.test(p)), 'placeholders in the call config');
  assert.ok(gate({ c: callConfig({ numbers: ['+15125550142', '+14155550100'] }) }).some((p) => /placeholder/.test(p)));
  assert.ok(gate({ c: callConfig({ tenant: 'someone-else' }) }).some((p) => /ws-founder-/.test(p)));
});

test('gate: editing EITHER file after approval withdraws the approval, and the voice digest changes with the call config too', () => {
  const c = callConfig(); const v = voiceConfig();
  const env = okEnv(c, v);
  assert.deepEqual(founderVoiceGateProblems({ callConfig: c, voiceConfig: v, env, nowIso: NOW }), []);
  for (const v2 of [voiceConfig({ voice: 'other-voice' }), voiceConfig({ max_openai_calls: 101 }), voiceConfig({ realtime_model: 'realtime-other-model' }), voiceConfig({ persona: { ...v.persona, pace: 'normal' } })]) {
    assert.ok(founderVoiceGateProblems({ callConfig: c, voiceConfig: v2, env, nowIso: NOW }).some((p) => /FOUNDER_VOICE_APPROVED_DIGEST/.test(p)), JSON.stringify(v2).slice(0, 60));
  }
  const c2 = callConfig({ max_calls: 2 });
  const withNewCall = { ...env, callApprovedDigest: founderConfigDigest(c2) };   // the call digest re-approved, the voice digest not
  assert.ok(founderVoiceGateProblems({ callConfig: c2, voiceConfig: v, env: withNewCall, nowIso: NOW }).some((p) => /FOUNDER_VOICE_APPROVED_DIGEST/.test(p)));
  assert.notEqual(founderVoiceDigest(c, v), founderVoiceDigest(c2, v));
});

test('gate: the problems never echo a value from either config', () => {
  const c = callConfig({ tenant: CANARY, numbers: [CANARY] });
  const v = voiceConfig({ voice: CANARY, openai_model: CANARY });
  for (const m of founderVoiceGateProblems({ callConfig: c, voiceConfig: v, env: okEnv(), nowIso: NOW })) assert.ok(!m.includes(CANARY), m);
  assert.ok(founderConfigProblems(c).length > 0);
});

// ================================================================ the command line (dry run and refused serve only)
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function workdir(over: { call?: Record<string, unknown>; voice?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(join(ROOT, '.voice-test-'));
  dirs.push(dir); mkdirSync(dir, { recursive: true });
  const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const c = callConfig({ expires: soon, kill_file: join(dir, 'stop'), db_path: join(dir, 'calls.sqlite').replace(/\\/g, '/'), ...over.call });
  const v = voiceConfig(over.voice);
  const cp = join(dir, 'call.json'); const vp = join(dir, 'voice.json');
  writeFileSync(cp, JSON.stringify(c)); writeFileSync(vp, JSON.stringify(v));
  return { dir, c, v, args: ['--config', relative(ROOT, cp).replace(/\\/g, '/'), '--voice-config', relative(ROOT, vp).replace(/\\/g, '/')] };
}
function run(args: string[], env: Record<string, string> = {}) {
  const base: Record<string, string> = { PATH: process.env.PATH ?? '' };
  if (process.env.SystemRoot) base.SystemRoot = process.env.SystemRoot;
  return spawnSync(process.execPath, ['src/founder-voice-entry.ts', ...args], { cwd: ROOT, env: { ...base, ...env }, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
}

test('command line: a dry run prints both digests, the bounds, the gate, and the stream TwiML for each number, and opens nothing', () => {
  const w = workdir();
  const r = run(w.args);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('DRY RUN') && r.stdout.includes('OpenAI voice route'));
  assert.ok(r.stdout.includes(founderConfigDigest(w.c)) && r.stdout.includes(founderVoiceDigest(w.c, w.v)));
  assert.ok(r.stdout.includes('[--]') && /INTAKE_ALLOW_LIVE_CALLS/.test(r.stdout), 'the gate is closed without the approvals');
  assert.ok(/at most \d+ calls of \d+ minutes/.test(r.stdout) && /No dollar ceiling is computed/.test(r.stdout));
  assert.ok(r.stdout.includes('voice reasoning minimal; text reasoning none; transcription hints: 1 language(s), 1 keyword(s)') && /UNVERIFIED until a live call/.test(r.stdout), 'the dry run prints the settings in effect');
  assert.ok(r.stdout.includes('<Stream url="wss://tunnel.founder-demo.net/relay/') && r.stdout.includes('<Hangup />') && r.stdout.includes('<Parameter name="to" value="+15125553377" />'));
  assert.ok(!/ConversationRelay/.test(r.stdout), 'the live TwiML is not the one printed');
  assert.ok(r.stdout.includes('No port was opened and nothing was sent'));
  assert.ok(!r.stdout.includes('Serving'));
});

test('command line: with every approval present the dry run reports the gate open, still opens nothing, and never prints a credential', () => {
  const w = workdir();
  const env = { INTAKE_ALLOW_LIVE_CALLS: 'yes', TWILIO_AUTH_TOKEN: TOKEN, OPENAI_API_KEY: KEY, FOUNDER_CALL_APPROVED_DIGEST: founderConfigDigest(w.c), FOUNDER_VOICE_APPROVED_DIGEST: founderVoiceDigest(w.c, w.v) };
  const r = run(w.args, env);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('[ok] all checks pass'));
  assert.ok(r.stdout.includes('No port was opened and nothing was sent'));
  for (const secret of [KEY, TOKEN]) assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret), 'no credential is printed');
});

test('command line: serve without the full gate is refused before anything is built, with the reasons and no key printed', () => {
  const w = workdir();
  const r = run([...w.args, '--serve'], { OPENAI_API_KEY: KEY, TWILIO_AUTH_TOKEN: TOKEN });
  assert.equal(r.status, 78);
  assert.ok(/serve refused: INTAKE_ALLOW_LIVE_CALLS/.test(r.stderr) && /FOUNDER_VOICE_APPROVED_DIGEST/.test(r.stderr));
  assert.ok(!r.stdout.includes('Serving') && !r.stdout.includes('Contact capture'));
  for (const secret of [KEY, TOKEN]) assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret));
  const noKey = run([...w.args, '--serve'], { INTAKE_ALLOW_LIVE_CALLS: 'yes', TWILIO_AUTH_TOKEN: TOKEN, FOUNDER_CALL_APPROVED_DIGEST: founderConfigDigest(w.c), FOUNDER_VOICE_APPROVED_DIGEST: founderVoiceDigest(w.c, w.v) });
  assert.equal(noKey.status, 78);
  assert.ok(/OpenAI key is not set/.test(noKey.stderr) && !noKey.stdout.includes('Serving'), 'everything approved but the key: still refused');
});

test('command line: bad arguments, unreadable files and invalid configs stop with their own exit codes and echo nothing', () => {
  const w = workdir();
  assert.equal(run([...w.args, '--bogus']).status, 64);
  assert.equal(run(['--config', '../outside.json']).status, 64);
  assert.equal(run(['--config', 'C:/abs.json']).status, 64);
  assert.equal(run(['--config', 'does-not-exist.json', '--voice-config', w.args[3]]).status, 66);
  const badVoice = workdir({ voice: { openai_model: `claude-${CANARY}` } });
  const r = run(badVoice.args);
  assert.equal(r.status, 65);
  assert.ok(!r.stderr.includes(CANARY) && !r.stdout.includes(CANARY));
  const badCall = workdir({ call: { max_minutes: 99 } });
  assert.equal(run(badCall.args).status, 65);
});
