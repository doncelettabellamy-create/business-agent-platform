// The controlled fast-test setup of the two private configs (pure), the gate rules for the `fast_test` section, and the glue's presence checks. Synthetic values only; the open hours are a TEST fixture, not the founder's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answersFromText, applyFastTest, parseClock, parseDays, parseMinutes } from '../src/fast-test-config.ts';
import type { FastTestAnswers } from '../src/fast-test-config.ts';
import { fastSettingsOf, founderVoiceConfigProblems, founderVoiceDigest, founderVoiceGateProblems, fastTestProblems, speakerSettingsOf } from '../src/founder-voice-gate.ts';
import { speakerSettingsProblems } from '../src/speaker-adapter.ts';
import type { FounderVoiceConfig } from '../src/founder-voice-gate.ts';
import { founderConfigDigest, founderConfigProblems } from '../src/founder-call-gate.ts';
import type { FounderCallConfig } from '../src/founder-call-gate.ts';
import { consentNoticeFor } from '../src/opening.ts';
import { buildFastDeps, fastStatus, NUMBERS_BLOB } from '../src/founder-voice-fast.ts';
import { createVault } from '../src/jobber-connector.ts';
import type { Protector } from '../src/jobber-connector.ts';

const plumbing = JSON.parse(readFileSync(new URL('../examples/skill-plumbing.json', import.meta.url), 'utf8')).skill_config;
const persona = JSON.parse(readFileSync(new URL('../examples/persona-drew-cleaning.json', import.meta.url), 'utf8'));
const CALL: FounderCallConfig = { approval_id: 'c1', tenant: 'ws-founder-fasttest', numbers: ['+12025551234'], model: 'claude-haiku-5-5', max_minutes: 8, max_turns: 30, max_claude_calls: 150, max_calls: 3, expires: '2026-11-20T00:00:00Z', persona_names: ['Sam Example'],
  kill_file: 'stop', public_wss_url: `wss://calls.mytunnel.dev/relay/${'q7Zr2KfX9mWc4TbV8nHs1LpD6yGe3AuJ5oRi0NxE'}`, db_path: 'calls.sqlite', relay_port: 8788, dashboard_port: 8787, after_speech_ms: 0, skill_config: plumbing,
  opening: { business_name: 'Drew Cleaning', special: '$25 off a qualifying first standard cleaning', disclosure: 'This is a long disclosure that names OpenAI and ElevenLabs and says details are kept for thirty days and that we do not record the call, and more words.' } };
const VOICE: FounderVoiceConfig = { approval_id: 'v1', openai_model: 'gpt-test-model', realtime_model: 'realtime-test-model', transcription_model: 'transcribe-test-model', voice: 'test-voice', max_openai_calls: 5, persona,
  speaker: { provider: 'elevenlabs', voice_id: '7EzWGsX10sAS4c9m9cPf', model_id: 'eleven_flash_v2_5', speed: 0.95 } };
const ANSWERS: FastTestAnswers = { jobber_account_name: 'Test Cleaning Developer Account', timezone: 'America/Chicago', hours: { 1: [['09:00', '17:00']], 2: [['09:00', '17:00']], 3: [['09:00', '17:00']], 4: [['09:00', '17:00']], 5: [['09:00', '17:00']] }, duration_minutes: 120, standing_approval: true, state: 'CA' };
const fakeProtector: Protector = { protect: async (p) => `P1:${Buffer.from([...Buffer.from(p)].reverse()).toString('hex')}`, unprotect: async (b) => Buffer.from(Buffer.from(b.slice(3), 'hex').reverse()).toString() };

test('setup: the short test opening replaces the long disclosure and the special, the fast_test section is added with the founder\'s answers and the documented size and price, and both new configs are valid; the originals are untouched', () => {
  const before = JSON.stringify([CALL, VOICE]);
  const r = applyFastTest(CALL, VOICE, ANSWERS);
  assert.equal(r.ok, true); if (!r.ok) return;
  assert.equal(r.opening, "Thanks for calling Drew Cleaning. I'm Jack. What's your name?", 'the exact opening');
  assert.equal(r.opening, consentNoticeFor(r.call.opening)); assert.equal(r.call.opening?.special, undefined); assert.equal(r.call.opening?.disclosure, undefined); assert.equal(r.call.opening?.greeting, "Thanks for calling Drew Cleaning. I'm Jack. What's your name?"); assert.ok(!/say yes|AI|A I/i.test(r.opening), 'no yes prompt in the opening');
  assert.deepEqual([r.voice.fast_test?.price_dollars, r.voice.fast_test?.bedrooms, r.voice.fast_test?.bathrooms, r.voice.fast_test?.service_label, r.voice.fast_test?.standing_approval, r.voice.fast_test?.state, r.voice.fast_test?.duration_minutes], [199, 2, 2, 'Standard cleaning', true, 'CA', 120]);
  assert.deepEqual([founderConfigProblems(r.call), founderVoiceConfigProblems(r.voice)], [[], []]);
  assert.notEqual(founderConfigDigest(r.call), founderConfigDigest(CALL)); assert.notEqual(founderVoiceDigest(r.call, r.voice), founderVoiceDigest(CALL, VOICE));
  assert.equal(JSON.stringify([CALL, VOICE]), before, 'the inputs were not changed');
  const s = fastSettingsOf(r.voice, 'Drew Cleaning'); assert.deepEqual([s?.priceDollars, s?.bedrooms, s?.bathrooms, s?.availability.durationMinutes, s?.availability.timezone, s?.state], [199, 2, 2, 120, 'America/Chicago', 'CA']);
});

test('setup refuses what it cannot take: a missing or invalid business fact is a problem, never a default, and nothing is produced', () => {
  for (const [label, bad] of [['no hours', { hours: {} }], ['bad zone', { timezone: 'Nowhere/Land' }], ['short duration', { duration_minutes: 10 }], ['no duration', { duration_minutes: undefined }], ['empty account', { jobber_account_name: ' ' }], ['approval not a boolean', { standing_approval: 'yes' }], ['bad state', { state: 'California' }], ['bad price', { price_dollars: 0 }]] as const) {
    const r = applyFastTest(CALL, VOICE, { ...ANSWERS, ...(bad as object) } as FastTestAnswers); assert.equal(r.ok, false, label);
  }
  assert.equal(applyFastTest({ ...CALL, numbers: [] }, VOICE, ANSWERS).ok, false, 'an invalid starting config is refused too');
  assert.deepEqual(fastTestProblems({ ...ANSWERS, jobber_account_name: 'x', price_dollars: 199, bedrooms: 2, bathrooms: 2, service_label: 'Standard cleaning', extra: 1 }).length > 0, true, 'unknown keys are refused');
});

test('gate: with fast_test the long ElevenLabs-naming notice is not required, but the private pieces are (numbers, Jobber, writes); without fast_test the old rule holds exactly', () => {
  const r = applyFastTest(CALL, VOICE, ANSWERS); assert.equal(r.ok, true); if (!r.ok) return;
  const env = { allowLive: 'yes', callApprovedDigest: founderConfigDigest(r.call), voiceApprovedDigest: founderVoiceDigest(r.call, r.voice), twilioTokenPresent: true, openaiKeyPresent: true, elevenlabsKeyPresent: true };
  const gate = (call: FounderCallConfig, voice: FounderVoiceConfig, e: object) => founderVoiceGateProblems({ callConfig: call, voiceConfig: voice, nowIso: '2026-11-02T12:00:00Z', env: { ...env, callApprovedDigest: founderConfigDigest(call), voiceApprovedDigest: founderVoiceDigest(call, voice), ...e } });
  assert.deepEqual(gate(r.call, r.voice, { fastTest: { numbersPresent: true, textsOn: true, ownerConsent: true, jobberConnected: true, jobberWritesOn: true, keyringReady: true } }), []);
  const missing = gate(r.call, r.voice, {}); assert.equal(missing.filter((m) => /numbers|Jobber|JOBBER/.test(m)).length, 3);
  assert.ok(gate(r.call, r.voice, { fastTest: { numbersPresent: false, textsOn: true, ownerConsent: true, jobberConnected: true, jobberWritesOn: true, keyringReady: true } }).some((m) => /approved test numbers/.test(m)));
  assert.ok(gate(r.call, r.voice, { fastTest: { numbersPresent: true, textsOn: true, ownerConsent: false, jobberConnected: true, jobberWritesOn: true, keyringReady: true } }).some((m) => /owner text consent is not recorded/.test(m)), 'no recorded owner consent: the gate refuses');
  assert.ok(gate(r.call, r.voice, { fastTest: { numbersPresent: true, textsOn: true, ownerConsent: true, jobberConnected: false, jobberWritesOn: true, keyringReady: true } }).some((m) => /not connected/.test(m)));
  assert.ok(gate(r.call, r.voice, { fastTest: { numbersPresent: true, textsOn: true, ownerConsent: true, jobberConnected: true, jobberWritesOn: false, keyringReady: true } }).some((m) => /JOBBER_ALLOW_WRITES/.test(m)));
  const ring = (x: object) => gate(r.call, r.voice, { fastTest: { numbersPresent: true, textsOn: true, ownerConsent: true, jobberConnected: true, jobberWritesOn: true, ...x } }).filter((m) => /keyring/.test(m));
  assert.deepEqual(ring({ keyringReady: true }), []); assert.equal(ring({ keyringReady: false, keyringProblem: 'MISSING' }).length, 1); assert.match(ring({ keyringReady: false, keyringProblem: 'MISSING' })[0], /keyring is not ready \(MISSING\): every booking would fail closed/);
  assert.match(ring({ keyringReady: false, keyringProblem: 'GAP' })[0], /\(GAP\)/); assert.match(ring({ keyringReady: false, keyringProblem: 'a secret?' })[0], /\(UNKNOWN\)/, 'only a fixed reason is ever shown'); assert.equal(ring({}).length, 1, 'a status without the answer is not ready'); assert.equal(gate(r.call, r.voice, {}).filter((m) => /keyring/.test(m)).length, 1);
  // the same short notice WITHOUT fast_test is still refused for the ElevenLabs speaker
  const shortNoFast = { ...r.call }; assert.ok(gate(shortNoFast, VOICE, {}).some((m) => /does not name ElevenLabs/.test(m)));
  // the long notice that names ElevenLabs still passes without fast_test
  const named = { ...CALL, opening: { ...CALL.opening!, disclosure: 'ElevenLabs turns our replies into speech and may keep them, and we do not record the call at all here' } };
  assert.deepEqual(gate(named, VOICE, {}), []);
  assert.ok(founderVoiceConfigProblems({ ...r.voice, conversation: 'native' }).some((m) => /fast test works with scripted/.test(m)));
});

test('presence checks and wiring: nothing printed, a missing private piece is reported as such, and building the dependencies without them is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fast-cfg-')); try {
    const r = applyFastTest(CALL, VOICE, ANSWERS); assert.equal(r.ok, true); if (!r.ok) return;
    assert.deepEqual(await fastStatus({ vaultDir: dir, protector: fakeProtector, env: {} }), { numbersPresent: false, textsOn: false, ownerConsent: false, jobberConnected: false, jobberWritesOn: false, keyringReady: false, keyringProblem: 'MISSING' });
    await assert.rejects(buildFastDeps({ config: r.call, voice: r.voice, vaultDir: dir, protector: fakeProtector, env: {}, fetch: globalThis.fetch, now: () => 0, log: () => undefined }), RangeError);
    const v = createVault(dir, fakeProtector);
    await v.saveBlob(NUMBERS_BLOB, JSON.stringify({ account_sid: 'AC123', customer: '+15550100002', owner: '+15550100003' }));
    assert.equal((await fastStatus({ vaultDir: dir, protector: fakeProtector, env: {} })).numbersPresent, false, 'a malformed record is not "present"');
    await v.saveBlob(NUMBERS_BLOB, JSON.stringify({ account_sid: `AC${'a1'.repeat(16)}`, customer: '+15550100002', owner: '+15550100002' }));
    assert.equal((await fastStatus({ vaultDir: dir, protector: fakeProtector, env: {} })).numbersPresent, false, 'the customer and owner numbers must differ');
    await v.saveBlob(NUMBERS_BLOB, JSON.stringify({ account_sid: `AC${'a1'.repeat(16)}`, customer: '+15550100002', owner: '+15550100003' }));
    assert.deepEqual(await fastStatus({ vaultDir: dir, protector: fakeProtector, env: { JOBBER_ALLOW_WRITES: 'test-account' } }), { numbersPresent: true, textsOn: false, ownerConsent: false, jobberConnected: false, jobberWritesOn: true, keyringReady: false, keyringProblem: 'MISSING' });
    // the keyring: ready only when every generation is valid; every problem is a fixed reason, never a secret
    const ok1 = JSON.stringify({ version: 1, gen: 1, current: { kid: 'k1', secret: Buffer.alloc(32, 9).toString('base64url') }, retired: [] });
    assert.equal(await v.publishBlob('booking-identity-keys.1', ok1, () => undefined), 'published'); assert.deepEqual([(await fastStatus({ vaultDir: dir, protector: fakeProtector, env: {} })).keyringReady, (await fastStatus({ vaultDir: dir, protector: fakeProtector, env: {} })).keyringProblem], [true, undefined]);
    assert.equal(await v.publishBlob('booking-identity-keys.2', 'not a generation', () => undefined), 'published'); const bad = await fastStatus({ vaultDir: dir, protector: fakeProtector, env: {} }); assert.deepEqual([bad.keyringReady, bad.keyringProblem], [false, 'MALFORMED']); assert.ok(!JSON.stringify(bad).includes(Buffer.alloc(32, 9).toString('base64url')));
    assert.equal((await fastStatus({ vaultDir: dir, protector: fakeProtector, env: { JOBBER_ALLOW_WRITES: 'yes' } })).jobberWritesOn, false, 'only the exact word switches writes on');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the entry point: a dry run writes nothing; apply makes two identical backups first, writes both files, and refuses to overwrite a backup (rollback is a copy)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fast-cli-')); try {
    const callP = join(dir, 'call.json'); const voiceP = join(dir, 'voice.json'); writeFileSync(callP, JSON.stringify(CALL, null, 2)); writeFileSync(voiceP, JSON.stringify(VOICE, null, 2));
    const run = (cmd: string, input: string) => spawnSync('node', [join(import.meta.dirname, '..', 'src', 'fast-test-config-main.ts'), cmd, '--call', callP, '--voice', voiceP], { input, encoding: 'utf8' });
    const orig = [readFileSync(callP, 'utf8'), readFileSync(voiceP, 'utf8')];
    const d = run('dry-run', JSON.stringify(ANSWERS)); assert.equal(d.status, 0); assert.ok(d.stdout.includes("Thanks for calling Drew Cleaning. I'm Jack. What's your name?")); assert.match(d.stdout, /honest if asked/);
    assert.deepEqual([readFileSync(callP, 'utf8'), readFileSync(voiceP, 'utf8')], orig, 'a dry run changes nothing'); assert.equal(readdirSync(dir).length, 2);
    const bad = run('apply', JSON.stringify({ ...ANSWERS, duration_minutes: 10 })); assert.equal(bad.status, 1); assert.match(bad.stdout, /nothing was changed/); assert.deepEqual([readFileSync(callP, 'utf8'), readFileSync(voiceP, 'utf8')], orig);
    const a = run('apply', JSON.stringify(ANSWERS)); assert.equal(a.status, 0); assert.match(a.stdout, /APPLIED/);
    const backups = readdirSync(dir).filter((n) => n.includes('.before-fast-test-')); assert.equal(backups.length, 2);
    assert.deepEqual(backups.map((b) => readFileSync(join(dir, b), 'utf8')).sort(), [...orig].sort(), 'each backup is an exact copy of the original');
    assert.ok(JSON.parse(readFileSync(voiceP, 'utf8')).fast_test !== undefined && JSON.parse(readFileSync(callP, 'utf8')).opening.greeting === "Thanks for calling Drew Cleaning. I'm Jack. What's your name?");
    assert.ok(!existsSync(join(dir, 'call.json.tmp')) && readdirSync(dir).every((n) => !n.includes('.tmp-')), 'no temporary file is left');
    assert.equal(run('apply', 'not json').status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('gate: a greeting opening is refused without the fast_test section, and allowed with it', () => {
  const r = applyFastTest(CALL, VOICE, ANSWERS); assert.equal(r.ok, true); if (!r.ok) return;
  const env = { allowLive: 'yes', callApprovedDigest: founderConfigDigest(r.call), voiceApprovedDigest: founderVoiceDigest(r.call, r.voice), twilioTokenPresent: true, openaiKeyPresent: true, elevenlabsKeyPresent: true };
  const gate = (call: FounderCallConfig, voice: FounderVoiceConfig, e: object) => founderVoiceGateProblems({ callConfig: call, voiceConfig: voice, nowIso: '2026-11-02T12:00:00Z', env: { ...env, callApprovedDigest: founderConfigDigest(call), voiceApprovedDigest: founderVoiceDigest(call, voice), ...e } });
  const { fast_test: _drop, ...plainVoice } = r.voice;
  assert.ok(gate(r.call, plainVoice as typeof VOICE, {}).some((m) => /greeting is only for the controlled fast test/.test(m)));
  assert.ok(!gate(r.call, r.voice, { fastTest: { numbersPresent: true, textsOn: true, ownerConsent: true, jobberConnected: true, jobberWritesOn: true, keyringReady: true } }).some((m) => /greeting/.test(m)));
});

test('typed schedule answers: the approved Drew settings are understood in every natural spelling, and a wrong answer is named, never silently changed', () => {
  assert.deepEqual(parseDays('1-5'), [1, 2, 3, 4, 5]); assert.deepEqual(parseDays('1,2,3,4,5'), [1, 2, 3, 4, 5]); assert.deepEqual(parseDays('Mon-Fri'), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseDays('Monday through Friday'), [1, 2, 3, 4, 5]); assert.deepEqual(parseDays('Monday - Friday'), [1, 2, 3, 4, 5]); assert.deepEqual(parseDays(' mon, wed and fri '), [1, 3, 5]); assert.deepEqual(parseDays('5-1'), [0, 1, 5, 6], 'a range may wrap past Saturday');
  for (const bad of ['', 'weekdays', '7', '1-9', 'Mon-']) assert.equal(parseDays(bad), undefined, bad);
  for (const [t, v] of [['09:00', '09:00'], ['9:00', '09:00'], ['9', '09:00'], ['9am', '09:00'], ['9 a.m.', '09:00'], ['5pm', '17:00'], ['5:30 PM', '17:30'], ['17:00', '17:00'], ['12am', '00:00'], ['12 pm', '12:00']] as const) assert.equal(parseClock(t), v, t);
  for (const bad of ['', 'noon', '25:00', '9:75', '13pm', '0am']) assert.equal(parseClock(bad), undefined, bad);
  for (const [t, v] of [['120', 120], ['120 minutes', 120], ['2 hours', 120], ['2 hrs', 120], ['1.5 hours', 90], ['2h', 120]] as const) assert.equal(parseMinutes(t), v, t);
  for (const bad of ['', 'two hours', '1.3 minutes']) assert.equal(parseMinutes(bad), undefined, bad);
  const typed = { account: '', timezone: 'Central Time', days: 'Monday-Friday', open: '9 a.m.', close: '5 p.m.', duration: '2 hours', state: 'tx', approval: 'YES' };
  const r = answersFromText(typed); assert.equal(r.ok, true); if (!r.ok) return;
  assert.deepEqual(r.answers, { jobber_account_name: 'Drew Cleaning-Developer Test Account', timezone: 'America/Chicago', hours: { 1: [['09:00', '17:00']], 2: [['09:00', '17:00']], 3: [['09:00', '17:00']], 4: [['09:00', '17:00']], 5: [['09:00', '17:00']] }, duration_minutes: 120, standing_approval: true, state: 'TX' });
  assert.equal(applyFastTest(CALL, VOICE, r.answers).ok, true, 'the approved settings pass the whole validation');
  const appr = (v: string | undefined) => { const x = answersFromText({ ...typed, approval: v }); return x.ok ? x.answers.standing_approval : 'problem'; };
  for (const yes of ['YES', 'yes', 'Yes', ' YES ', 'YES.', '"YES"']) assert.equal(appr(yes), true, yes);
  for (const no of ['', undefined, 'no', 'NO', 'n']) assert.equal(appr(no), false, String(no));
  for (const odd of ['y', 'ok', 'sure', 'yes please', 'true', '1']) assert.equal(appr(odd), 'problem', odd + ' is never silently taken as a no');
  const w = answersFromText({ ...typed, days: 'weekdays', open: '5pm', close: '9am', duration: 'two hours', state: 'Texas' }); assert.equal(w.ok, false);
  if (!w.ok) assert.deepEqual(w.problems.map((p) => p.split(':')[0]), ['days', 'open time must be earlier than the close time'.split(':')[0], 'cleaning duration', 'state']);
});

test('the entry point takes the answers as typed, and says which answer is wrong', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fast-raw-')); try {
    const callP = join(dir, 'call.json'); const voiceP = join(dir, 'voice.json'); writeFileSync(callP, JSON.stringify(CALL, null, 2)); writeFileSync(voiceP, JSON.stringify(VOICE, null, 2));
    const run = (input: string) => spawnSync('node', [join(import.meta.dirname, '..', 'src', 'fast-test-config-main.ts'), 'dry-run', '--call', callP, '--voice', voiceP], { input, encoding: 'utf8' });
    const ok = run(JSON.stringify({ raw: { account: '', timezone: 'America/Chicago', days: '1-5', open: '09:00', close: '17:00', duration: '120', state: 'TX', approval: 'YES' } }));
    assert.equal(ok.status, 0); assert.match(ok.stdout, /120 minutes, America\/Chicago, standing test approval true/);
    const bad = run(JSON.stringify({ raw: { timezone: 'America/Chicago', days: 'weekdays', open: '9am', close: '5pm', duration: '120' } }));
    assert.equal(bad.status, 1); assert.match(bad.stdout, /problem: days: not understood/); assert.match(bad.stdout, /nothing was changed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- the Jack guard: the fast test needs the ElevenLabs speaker (OpenAI must never speak the pilot's calls)
const NEEDS_SPEAKER = 'the fast test needs the ElevenLabs speaker section (without it OpenAI would speak the calls)';
const SPEAKER_OK = { provider: 'elevenlabs', voice_id: '7EzWGsX10sAS4c9m9cPf', model_id: 'eleven_flash_v2_5', speed: 0.95 };
const without = <T extends object>(o: T, k: string): Record<string, unknown> => { const c: Record<string, unknown> = { ...o }; delete c[k]; return c; };

test('Jack guard: a voice config with fast_test and NO speaker section is refused at load (the config check, the gate and the setup program), with fixed text and no value', () => {
  const r = applyFastTest(CALL, VOICE, ANSWERS); assert.equal(r.ok, true); if (!r.ok) return;
  const bare = without(r.voice, 'speaker');
  assert.deepEqual(founderVoiceConfigProblems(bare).filter((m) => /speaker/.test(m)), [NEEDS_SPEAKER], 'exactly one problem about the speaker, in fixed words');
  const env = { allowLive: 'yes', callApprovedDigest: founderConfigDigest(r.call), voiceApprovedDigest: 'x', twilioTokenPresent: true, openaiKeyPresent: true, elevenlabsKeyPresent: true, fastTest: { numbersPresent: true, textsOn: false, ownerConsent: false, jobberConnected: true, jobberWritesOn: true, keyringReady: true } };
  assert.ok(founderVoiceGateProblems({ callConfig: r.call, voiceConfig: bare, nowIso: '2026-11-02T12:00:00Z', env }).includes(NEEDS_SPEAKER), 'the gate refuses too');
  // the setup program will not ADD a fast test to a voice config that has no speaker
  const a = applyFastTest(CALL, without(VOICE, 'speaker'), ANSWERS); assert.equal(a.ok, false);
  if (!a.ok) assert.ok(a.problems.some((m) => m.includes(NEEDS_SPEAKER)), 'the setup says why');
  // a valid pair passes and selects the speaker
  assert.deepEqual(founderVoiceConfigProblems(r.voice), []); assert.notEqual(speakerSettingsOf(r.voice), undefined);
});

test('Jack guard: a speaker section that is present but null, empty, not ElevenLabs, extended with a switch, or with a wrong model or speed is refused; native conversation is refused with it', () => {
  const r = applyFastTest(CALL, VOICE, ANSWERS); assert.equal(r.ok, true); if (!r.ok) return;
  const variants: unknown[] = [null, {}, [], 'elevenlabs', true, { ...SPEAKER_OK, provider: 'openai' }, { ...SPEAKER_OK, enabled: false }, { ...SPEAKER_OK, extra: 1 }, without(SPEAKER_OK, 'voice_id'),
    { ...SPEAKER_OK, model_id: 'eleven_multilingual_v2' }, { ...SPEAKER_OK, speed: 0 }, { ...SPEAKER_OK, speed: 3 }, { ...SPEAKER_OK, speed: '0.95' }];
  for (const speaker of variants) {
    const p = founderVoiceConfigProblems({ ...r.voice, speaker });
    assert.ok(p.some((m) => /speaker must be/.test(m)), `refused: ${JSON.stringify(speaker)}`); assert.ok(!p.includes(NEEDS_SPEAKER), 'it is present, so the problem is its content, not its absence');
  }
  assert.ok(founderVoiceConfigProblems({ ...r.voice, conversation: 'native' }).some((m) => /speaker works with scripted/.test(m)));
  assert.ok(founderVoiceConfigProblems({ ...r.voice, conversation: 'scripted' }).length === 0);
});

test('Jack guard: the rule is for the fast test only: a voice config with neither section (the long flow) is unchanged, and a valid speaker alone still passes', () => {
  const plain = without(without(VOICE, 'speaker'), 'fast_test'); assert.deepEqual(founderVoiceConfigProblems(plain), [], 'neither section: unchanged');
  assert.deepEqual(founderVoiceConfigProblems({ ...plain, speaker: SPEAKER_OK }), [], 'a speaker without the fast test: unchanged');
});

test('Jack guard, as a property: over every combination of speaker, fast_test and conversation, any config that passes the load check and has a fast test has a valid speaker selected', () => {
  const r = applyFastTest(CALL, VOICE, ANSWERS); assert.equal(r.ok, true); if (!r.ok) return;
  const speakers: unknown[] = ['absent', SPEAKER_OK, null, {}, [], { ...SPEAKER_OK, provider: 'openai' }, { ...SPEAKER_OK, enabled: false }, { ...SPEAKER_OK, speed: 9 }];
  const fasts: unknown[] = ['absent', r.voice.fast_test, null, {}, 'on', { ...r.voice.fast_test, price_dollars: -1 }];
  const convs: unknown[] = ['absent', 'scripted', 'native', 'other'];
  let passedWithFast = 0; let combos = 0;
  for (const s of speakers) for (const f of fasts) for (const cv of convs) {
    const v: Record<string, unknown> = { ...without(without(without(r.voice, 'speaker'), 'fast_test'), 'conversation') };
    if (s !== 'absent') v.speaker = s; if (f !== 'absent') v.fast_test = f; if (cv !== 'absent') v.conversation = cv; combos++;
    if (founderVoiceConfigProblems(v).length === 0 && 'fast_test' in v) {
      passedWithFast++; const sel = speakerSettingsOf(v as unknown as FounderVoiceConfig);
      assert.ok(sel !== undefined && speakerSettingsProblems(sel).length === 0, `a passing fast config must select a valid speaker: ${JSON.stringify([s, f, cv])}`);
    }
  }
  assert.equal(combos, speakers.length * fasts.length * convs.length); assert.ok(passedWithFast >= 1, 'the property is not vacuous: the valid combination passes');
});

test('voice pin: a different but well-formed voice_id is refused at load, by the config check, the gate and the setup program, with fixed text and no id; Jack passes', () => {
  const r = applyFastTest(CALL, VOICE, ANSWERS); assert.equal(r.ok, true); if (!r.ok) return;
  assert.deepEqual(founderVoiceConfigProblems(r.voice), [], 'Jack passes');
  const env = { allowLive: 'yes', callApprovedDigest: founderConfigDigest(r.call), voiceApprovedDigest: 'x', twilioTokenPresent: true, openaiKeyPresent: true, elevenlabsKeyPresent: true, fastTest: { numbersPresent: true, textsOn: false, ownerConsent: false, jobberConnected: true, jobberWritesOn: true, keyringReady: true } };
  for (const id of ['aaaaaaaaaaaaaaaaaaaa', 'AAAAAAAAAAAAAAAAAAAA', '7EzWGsX10sAS4c9m9cPg', '7ezwgsx10sas4c9m9cpf', '12345678901234567890']) {
    const wrong = { ...r.voice, speaker: { ...SPEAKER_OK, voice_id: id } };
    const p = founderVoiceConfigProblems(wrong);
    assert.ok(p.some((m) => /speaker must be/.test(m)), id.slice(-4)); assert.ok(!p.join(' ').includes(id), 'no id in the message');
    assert.ok(founderVoiceGateProblems({ callConfig: r.call, voiceConfig: wrong, nowIso: '2026-11-02T12:00:00Z', env }).some((m) => /speaker must be/.test(m)), 'the gate refuses too');
    const a = applyFastTest(CALL, { ...VOICE, speaker: { ...SPEAKER_OK, voice_id: id } }, ANSWERS); assert.equal(a.ok, false, 'the setup will not add a fast test to a wrong voice');
  }
});

test('voice pin, as a property: any passing voice config (with or without the fast test) that has a speaker selects exactly the approved voice id', () => {
  const r = applyFastTest(CALL, VOICE, ANSWERS); assert.equal(r.ok, true); if (!r.ok) return;
  let passed = 0;
  for (const id of ['7EzWGsX10sAS4c9m9cPf', 'aaaaaaaaaaaaaaaaaaaa', 'AAAAAAAAAAAAAAAAAAAA', '7EzWGsX10sAS4c9m9cPg', '7ezwgsx10sas4c9m9cpf', '12345678901234567890']) for (const withFast of [true, false]) {
    const v: Record<string, unknown> = { ...r.voice, speaker: { ...SPEAKER_OK, voice_id: id } }; if (!withFast) delete v.fast_test;
    if (founderVoiceConfigProblems(v).length === 0) { passed++; assert.equal(speakerSettingsOf(v as never)?.voiceId, '7EzWGsX10sAS4c9m9cPf'); }
  }
  assert.equal(passed, 2, 'only Jack passes, with and without the fast test');
});

test('fast_test.follow_up_process: optional, true or false only (the owner\'s statement that someone works the follow-up list), default off, and part of the approved configuration', () => {
  const r = applyFastTest(CALL, VOICE, ANSWERS); assert.equal(r.ok, true); if (!r.ok) return;
  const withFlag = (v: unknown): object => ({ ...r.voice, fast_test: { ...r.voice.fast_test, follow_up_process: v } });
  assert.deepEqual(founderVoiceConfigProblems(r.voice), [], 'absent: valid'); assert.equal(fastSettingsOf(r.voice, 'Drew Cleaning')?.followUpProcess, undefined, 'absent: not attested');
  for (const v of [true, false]) assert.deepEqual(founderVoiceConfigProblems(withFlag(v)), [], String(v));
  assert.equal(fastSettingsOf(withFlag(true) as typeof r.voice, 'Drew Cleaning')?.followUpProcess, true); assert.equal(fastSettingsOf(withFlag(false) as typeof r.voice, 'Drew Cleaning')?.followUpProcess, undefined, 'false is the same as absent');
  for (const bad of ['true', 1, 0, null, 'yes', {}]) assert.ok(founderVoiceConfigProblems(withFlag(bad)).some((m) => /follow_up_process must be true or false/.test(m)), JSON.stringify(bad));
  assert.notEqual(founderVoiceDigest(r.call, r.voice), founderVoiceDigest(r.call, withFlag(true) as typeof r.voice), 'switching the statement on changes the digest, so it needs a new approval');
});
