// The JOINED fast Drew test call, locally: a stand-in for Twilio's media stream -> the real WebSocket server (secret path and signature) -> the real voice bridge with MEASURED playback (the phone stand-in
// acknowledges each audio mark) -> the real OpenAI voice socket over a mocked connection -> the real fast call handler, wired by the real composition glue (founder-voice-fast.ts) to the REAL Jobber connector and
// booking adapter (against a local stand-in for Jobber's API), the REAL Twilio helpers (against a local stand-in for Twilio) and the real protected-folder pieces. No network, no real key, number or account;
// invented data only. A pass shows behaviour against stand-ins: it does not show what the live Jobber, Twilio, OpenAI or ElevenLabs will do.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelayWsServer } from '../src/ws-server.ts';
import { signedUrlCandidates } from '../src/founder-call-gate.ts';
import type { FounderCallConfig } from '../src/founder-call-gate.ts';
import type { FounderVoiceConfig } from '../src/founder-voice-gate.ts';
import { createFounderVoiceService } from '../src/founder-voice-service.ts';
import { createOpenAiVoiceSocket } from '../src/openai-voice-socket.ts';
import type { WebSocketLike } from '../src/openai-voice-socket.ts';
import { createIntakeRecordStore } from '../src/intake-record-store.ts';
import { mintExecutionContext } from '../src/execution-context.ts';
import { consentNoticeFor } from '../src/opening.ts';
import { createOpenAIHttpClient } from '../src/openai-http-client.ts';
import { createVault } from '../src/jobber-connector.ts';
import type { Protector } from '../src/jobber-connector.ts';
import { buildFastDeps, fastStatus, NUMBERS_BLOB } from '../src/founder-voice-fast.ts';
import { appendConsent, ownerRef, readConsent } from '../src/fast-consent.ts';
import { OWNER_SCRIPT_ID } from '../src/fast-sms-copy.ts';
import type { FastOutcome } from '../src/fast-call-handler.ts';
import { instantOf } from '../src/fast-parsers.ts';
import { createPersona } from '../src/persona.ts';
import { connectRelay } from './helpers/twilio-sim.ts';
import type { Sim } from './helpers/twilio-sim.ts';
import { createWireVoice } from './helpers/realtime-wire-sim.ts';
import type { WireVoice } from './helpers/realtime-wire-sim.ts';
import { ACCOUNT, mockJobber } from './helpers/jobber-mock.ts';
import { CALL, mockTwilio, SID, TOKEN } from './helpers/twilio-mock.ts';

const T = 'ws-founder-fasttest'; const DREW = '+15550100001'; const CUSTOMER = '+15550100002'; const OWNER = '+15550100003';
const STREAM_TOKEN = 'test-auth-token-0123456789'; const FAKE_KEY = 'sk-test-not-a-real-key-0123456789'; const SECRET = 'q7Zr2KfX9mWc4TbV8nHs1LpD6yGe3AuJ5oRi0NxE'; const PATH = `/relay/${SECRET}`; const URL_WSS = `wss://tunnel.example.test${PATH}`;
const NOW = Date.parse('2026-11-02T15:00:00Z');   // Monday 9:00 in Chicago
const fakeProtector: Protector = { protect: async (p) => `P1:${Buffer.from([...Buffer.from(p)].reverse()).toString('hex')}`, unprotect: async (b) => Buffer.from(Buffer.from(b.slice(3), 'hex').reverse()).toString() };
const plumbing = JSON.parse(readFileSync(new URL('../examples/skill-plumbing.json', import.meta.url), 'utf8')).skill_config;
const persona = createPersona(JSON.parse(readFileSync(new URL('../examples/persona-drew-cleaning.json', import.meta.url), 'utf8')));
const root = mkdtempSync(join(tmpdir(), 'fast-joined-')); const closers: Array<() => unknown> = [];
after(async () => { for (const c of closers.reverse()) try { await c(); } catch { /* closed */ } rmSync(root, { recursive: true, force: true }); });
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(fn: () => boolean, label: string, ms = 15_000): Promise<void> { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error(`timed out waiting for ${label}`); await pause(5); } }
function wsOver(v: WireVoice): WebSocketLike {
  const ws: WebSocketLike = { readyState: 0, bufferedAmount: 0, onopen: null, onmessage: null, onclose: null, onerror: null, send: (d: string) => { if (!v.send(d)) throw new Error('refused'); }, close: (c?: number) => { ws.readyState = 3; v.close(c); } };
  v.onMessage = (t: string) => { ws.onmessage?.({ data: t }); }; v.onClose = () => { ws.onclose?.({}); };
  setTimeout(() => { ws.readyState = 1; v.open(); ws.onopen?.({}); }, 0);
  return ws;
}
const HOURS = { 1: [['09:00', '17:00']], 2: [['09:00', '17:00']], 3: [['09:00', '17:00']], 4: [['09:00', '17:00']], 5: [['09:00', '17:00']] } as Record<string, Array<[string, string]>>;

async function rig(o: { jobberWrites?: boolean; ownerConsent?: boolean; texts?: boolean; word?: string; msPerChar?: number } = {}) {
  const dir = mkdtempSync(join(root, 'r-')); const jobber = await mockJobber(); const twilio = await mockTwilio(); closers.push(() => jobber.close(), () => twilio.close());
  const callConfig: FounderCallConfig = { approval_id: 'fast-test', tenant: T, numbers: [DREW], model: 'claude-haiku-5-5', max_minutes: 8, max_turns: 30, max_claude_calls: 150, max_calls: 5, expires: '2026-11-20T00:00:00Z', persona_names: ['Sam Example'], kill_file: join(dir, 'stop'), public_wss_url: URL_WSS, db_path: join(dir, 'calls.sqlite'), relay_port: 8788, dashboard_port: 8787, after_speech_ms: 0, skill_config: plumbing,
    opening: { business_name: 'Drew Cleaning', greeting: "Thanks for calling Drew Cleaning. I'm Jack. What's your name?" } };
  const voiceConfig: FounderVoiceConfig = { approval_id: 'v1', openai_model: 'gpt-test-model', realtime_model: 'realtime-test-model', transcription_model: 'transcribe-test-model', voice: 'test-voice', max_openai_calls: 5, persona: persona as never,
    fast_test: { jobber_account_name: ACCOUNT.name, timezone: 'America/Chicago', hours: HOURS, duration_minutes: 120, price_dollars: 199, bedrooms: 2, bathrooms: 2, service_label: 'Standard cleaning', standing_approval: true, state: 'CA', lead_minutes: 60 } };
  // the private folder, as the setup scripts leave it (protected; invented values)
  const vault = createVault(dir, fakeProtector);
  await vault.saveCredentials({ client_id: 'test-client-id-0001', client_secret: 'test-client-secret-ZZZ-9f8e7d6c' });
  await vault.saveTokens({ access_token: 'tok-valid-0123456789', refresh_token: 'refresh-0123456789', expires_at: NOW + 3_000_000, account_id: ACCOUNT.id, account_name: ACCOUNT.name });
  await vault.saveBlob(NUMBERS_BLOB, JSON.stringify({ account_sid: SID, customer: CUSTOMER, owner: OWNER }));
  // the owner's separately recorded setup consent (protected evidence), unless this rig is the one without it
  if (o.ownerConsent !== false) assert.equal(await appendConsent(vault, { v: 1, role: 'owner', at: new Date(NOW).toISOString(), method: 'private_setup', script: OWNER_SCRIPT_ID, result: 'yes', ref: ownerRef(OWNER) }), true);
  const env = { TWILIO_AUTH_TOKEN: TOKEN, ...(o.texts === false ? (o.word === undefined ? {} : { FAST_TEXTS: o.word }) : { FAST_TEXTS: 'on' }), ...(o.jobberWrites === false ? {} : { JOBBER_ALLOW_WRITES: 'test-account' }) } as Record<string, string>;
  const status = await fastStatus({ vaultDir: dir, protector: fakeProtector, env });
  const logs: Array<{ code: string; detail?: Record<string, unknown> }> = []; const diagLines: Array<{ code: string; [k: string]: unknown }> = []; const outcomes: FastOutcome[] = [];
  const fast = await buildFastDeps({ config: callConfig, voice: voiceConfig, vaultDir: dir, protector: fakeProtector, env, fetch: globalThis.fetch, now: () => NOW, log: (code, detail) => { logs.push({ code, detail }); }, onOutcome: (x) => { outcomes.push(x); }, jobberEndpoints: jobber.endpoints, twilioOrigin: twilio.origin, textFrom: DREW });
  fast.answerWaitMs = 20_000; fast.settleMs = 30; fast.holdGraceMs = 30; fast.holdMaxMs = 300;
  const store = createIntakeRecordStore({ path: join(dir, 'calls.sqlite') }); closers.push(() => store.close());
  const voices: WireVoice[] = [];
  const service = createFounderVoiceService({
    diag: (code, detail) => { diagLines.push({ code, ...detail }); }, config: callConfig, voice: voiceConfig, fast,
    textClient: createOpenAIHttpClient({ getKey: () => FAKE_KEY, fetch: (async () => new Response('{}', { status: 500 })) as unknown as typeof globalThis.fetch }),
    openVoice: (d) => createOpenAiVoiceSocket({ model: voiceConfig.realtime_model, getKey: () => FAKE_KEY, connectTimeoutMs: 3000, diag: (code, detail) => { d(code as never, detail); }, factory: () => { const v = createWireVoice({ msPerChar: o.msPerChar ?? 1, autoOpen: false }); voices.push(v); return wsOver(v); } }),
    store, async intakeContext(tenant, ref) { const r = await mintExecutionContext({ credential: 'test', agent: 'intake' }, { verify: () => ({ kind: 'system', id: 'fast-joined-test' }), selectTenant: () => tenant, grants: () => ['intake:run'], newCorrelationId: () => `corr-${ref}` }); if (!r.ok) throw new Error('context'); return r.context; },
    now: () => Date.now(), nowIso: () => '2026-11-02T15:00:00Z', killed: () => false, log: (code, detail) => { logs.push({ code, detail }); },
  });
  const server = createRelayWsServer({ path: PATH, authToken: STREAM_TOKEN, urls: signedUrlCandidates(URL_WSS), maxConnections: 2, onConnection: (c) => service.handleStream(c) } as never); const port = await server.listen(0); closers.push(() => server.close());
  const connect = async (): Promise<Sim> => {
    const sim = await connectRelay({ port, token: STREAM_TOKEN, url: URL_WSS, path: PATH } as never); let seen = 0;
    const timer = setInterval(() => { for (; seen < sim.messages.length; seen++) { const m = sim.messages[seen]; if (m.event === 'mark') { try { sim.send({ event: 'mark', streamSid: m.streamSid, mark: { name: m.mark.name } }); } catch { /* closed */ } } } }, 5);   // the phone acknowledges every mark: the playback is MEASURED
    timer.unref?.(); void sim.closed.then(() => clearInterval(timer)); return sim;
  };
  const start = (sim: Sim, to = DREW) => { sim.send({ event: 'connected', protocol: 'Call', version: '1.0.0' }); sim.send({ event: 'start', sequenceNumber: '1', start: { streamSid: 'MZ1', callSid: CALL, tracks: ['inbound'], customParameters: { to }, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } }, streamSid: 'MZ1' }); };
  let cursor = 0;
  /** Waits for the next spoken line matching `re` (after the last one matched), then the caller answers. */
  const hears = async (re: RegExp, reply?: string): Promise<string> => { await until(() => (voices[0]?.spoken ?? []).slice(cursor).some((l) => re.test(l)), `a spoken line matching ${re}: ${JSON.stringify((voices[0]?.spoken ?? []).slice(cursor).map((l) => l.slice(0, 40)))}`); const i = voices[0].spoken.findIndex((l, k) => k >= cursor && re.test(l)); cursor = i + 1; const line = voices[0].spoken[i]; await until(() => !voices[0].playing(), 'the line to finish playing'); await pause(10); if (reply !== undefined) voices[0].hear(reply); return line; };
  return { jobber, twilio, logs, diagLines, outcomes, voices, connect, start, hears, service, dir, status, fast, notice: service.notice };
}
const noPersonal = (x: unknown, extra: string[] = []): void => { const all = JSON.stringify(x); for (const s of ['Testa', 'Invented', 'Testville', '90210', '5550100002', '5550100003', '0100002', FAKE_KEY, TOKEN, 'tok-valid', ...extra]) assert.ok(!all.includes(s), `no ${s} in the diagnostics`); };

test('JOINED: the short opening, a yes, name, address with city and ZIP, day and time, size, $199 with a Jobber-supported time, agreement, the verified caller ID as the callback number, text permission, the measured read-back, the Jobber test booking, both texts, delivery checked', async () => {
  const r = await rig();
  assert.deepEqual(r.status, { numbersPresent: true, textsOn: true, ownerConsent: true, jobberConnected: true, jobberWritesOn: true });
  assert.equal(r.notice, "Thanks for calling Drew Cleaning. I'm Jack. What's your name?", 'the opening is exactly the greeting: it asks the name and asks for no yes');
  assert.equal(r.notice, consentNoticeFor({ business_name: 'Drew Cleaning', greeting: "Thanks for calling Drew Cleaning. I'm Jack. What's your name?" }));
  const sim = await r.connect(); r.start(sim);
  await until(() => r.voices.length === 1 && r.voices[0].spoken.length >= 1, 'the opening');
  assert.equal(r.voices[0].spoken[0], r.notice);
  await r.hears(/Thanks for calling Drew Cleaning/, 'Testa Invented');   // the answer to the greeting's question: no yes is asked for
  await r.hears(/street address/, '123 Invented Lane, Testville, CA 90210');
  await r.hears(/What day and time/, 'Tuesday at ten');
  await r.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  assert.equal(await r.hears(/is one hundred ninety-nine dollars/, 'yes'), 'A standard cleaning for two bedrooms and two bathrooms is one hundred ninety-nine dollars. We have Tuesday, November third, 2026 at 10 A M. Does that work?');
  await r.hears(/calling from a number ending in 0 0 0 2/, 'yes');
  await r.hears(/May we send you one automated/, 'yes');
  assert.equal(await r.hears(/^To confirm/, 'yes'), 'To confirm: Standard cleaning for Testa Invented on Tuesday, November third, 2026 at 10 A M, at 123 Invented Lane, Testville, California, 9 0 2 1 0. The price is one hundred ninety-nine dollars. Shall I book it? Say yes or no.');
  const bye = await r.hears(/You are booked/); assert.equal(bye, 'You are booked for Tuesday, November third, 2026 at 10 A M. A confirmation text is on its way. Goodbye.');
  await until(() => r.outcomes.some((o) => o.reason === 'TEXTS_VERIFIED'), 'the delivery check');
  // Jobber: one client, one job, the read-back matched
  assert.equal(r.jobber.clientCount(), 1); assert.equal(r.jobber.jobs.size, 1);
  const job = [...r.jobber.jobs.values()][0] as { visits: { nodes: Array<{ startAt: string; endAt: string }> }; total: number };
  assert.deepEqual([Date.parse(job.visits.nodes[0].startAt), Date.parse(job.visits.nodes[0].endAt), job.total], [instantOf('2026-11-03', '10:00', 'America/Chicago'), instantOf('2026-11-03', '12:00', 'America/Chicago'), 199]);
  const writes = r.jobber.ops.map((x) => x.field).filter((f) => f === 'clientCreate' || f === 'jobCreate'); assert.deepEqual(writes, ['clientCreate', 'jobCreate']);
  assert.ok(r.jobber.ops.findIndex((x) => x.field === 'scheduledItems') < r.jobber.ops.findIndex((x) => x.field === 'clientCreate'), 'the calendar was read before anything was offered or written');
  assert.equal(r.jobber.ops.filter((x) => x.field === 'job').length >= 1, true, 'the booking was read back by id');
  // Twilio: the two texts match the booking and went to the approved numbers only
  assert.deepEqual(r.twilio.messages.map((m) => [m.to, m.from]), [[CUSTOMER, DREW], [OWNER, DREW]]);
  assert.equal(r.twilio.messages[0].body, 'Donceletta Bellamy - Developer Testing: Drew Cleaning DEMO booking confirmed for Tue Nov 3, 10:00 AM-12:00 PM Central, at 123 Invented Lane, Testville, CA 90210. Standard cleaning, 2 bedrooms/2 bathrooms, $199. Test only; no cleaning service will occur. Reply STOP to opt out or HELP for help.');
  assert.equal(r.twilio.messages[1].body, 'Donceletta Bellamy - Developer Testing: New Drew Cleaning DEMO booking for Testa Invented, Tue Nov 3, 10:00 AM-12:00 PM Central, at 123 Invented Lane, Testville, CA 90210. Standard cleaning, 2 bedrooms/2 bathrooms, $199. Test only; no cleaning service will occur. Reply STOP to opt out or HELP for help.');
  // the protected evidence: the owner's setup consent, then the caller's spoken yes; no number, name, address or words in either
  const ev = await readConsent(createVault(r.dir, fakeProtector)); assert.deepEqual(ev.map((e) => [e.role, e.method, e.result]), [['owner', 'private_setup', 'yes'], ['customer', 'call_verbal', 'yes']]);
  assert.ok(!JSON.stringify(ev).match(/555|Testa|Invented|Lane|\+1/), 'the evidence holds no personal detail');
  const last = r.outcomes[r.outcomes.length - 1]; assert.deepEqual([last.reason, last.booked, last.customerText, last.ownerText], ['TEXTS_VERIFIED', true, 'delivered', 'delivered']);
  // measured playback: every response was acknowledged by the phone, and the stream closed after the goodbye
  assert.ok(r.diagLines.some((d) => d.code === 'BRIDGE_RESPONSE_RELEASED' && d.how === 'acked'));
  await sim.closed; assert.equal(sim.closeCode(), 1000);
  noPersonal(r.logs); noPersonal(r.diagLines);
});

test('JOINED: a caller who is not on the approved list hears one short line after the opening and nothing is read from Jobber, booked or texted', async () => {
  const r = await rig(); r.twilio.opts.callerFrom = '+15550100099';
  const sim = await r.connect(); r.start(sim);
  await until(() => r.voices.length === 1 && r.voices[0].spoken.length >= 1, 'the opening');
  await r.hears(/Thanks for calling Drew Cleaning/);   // no answer is sent: the refusal follows the greeting by itself, and an answer could cut it off
  await r.hears(/private test line/);
  await sim.closed; await until(() => r.outcomes.length > 0, 'the outcome');
  assert.equal(r.outcomes[0].reason, 'NOT_APPROVED'); assert.deepEqual(r.voices[0].spoken.length, 2);
  assert.equal(r.jobber.ops.length, 0); assert.equal(r.twilio.messages.length, 0);
});

test('JOINED: Jobber writes switched off, the calendar busy, or the booking not verified each end honestly, with no text sent and no claim of a booking', async () => {
  // 1. writes off: the booking is refused by the connector and the call says a person will follow up
  const a = await rig({ jobberWrites: false }); assert.equal(a.status.jobberWritesOn, false);
  const sa = await a.connect(); a.start(sa); await until(() => a.voices.length === 1 && a.voices[0].spoken.length >= 1, 'the opening');
  await a.hears(/Thanks for calling/, 'Testa Invented'); await a.hears(/street address/, '123 Invented Lane, Testville, CA 90210'); await a.hears(/What day and time/, 'Tuesday at ten'); await a.hears(/bedrooms and bathrooms/, 'two and two');
  await a.hears(/is one hundred ninety-nine dollars/, 'yes'); await a.hears(/calling from/, 'yes'); await a.hears(/May we send you one automated/, 'yes'); await a.hears(/^To confirm/, 'yes');
  assert.match(await a.hears(/could not confirm the booking/), /a person will follow up/); await sa.closed;
  assert.equal(a.jobber.jobs.size, 0); assert.equal(a.twilio.messages.length, 0); assert.equal(a.outcomes[a.outcomes.length - 1].reason, 'BOOKING_NOT_VERIFIED');
  // 2. the 10 A M slot is busy in Jobber's calendar: a later time is offered instead, never the busy one
  const b = await rig(); b.jobber.opts.scheduled = [{ startAt: new Date(instantOf('2026-11-03', '09:00', 'America/Chicago')).toISOString(), endAt: new Date(instantOf('2026-11-03', '12:00', 'America/Chicago')).toISOString() }];
  const sb = await b.connect(); b.start(sb); await until(() => b.voices.length === 1 && b.voices[0].spoken.length >= 1, 'the opening');
  await b.hears(/Thanks for calling/, 'Testa Invented'); await b.hears(/street address/, '123 Invented Lane, Testville, CA 90210'); await b.hears(/What day and time/, 'Tuesday at ten'); await b.hears(/bedrooms and bathrooms/, 'two and two');
  const offer = await b.hears(/is one hundred ninety-nine dollars/); assert.match(offer, /Tuesday, November third, 2026 at 12 P M/); sb.end(); await pause(30);
  assert.equal(b.jobber.jobs.size, 0);
  // 3. Jobber says more items exist than were returned: the calendar is treated as unreadable, nothing is offered
  const c = await rig(); c.jobber.opts.hasMoreScheduled = true;
  const sc = await c.connect(); c.start(sc); await until(() => c.voices.length === 1 && c.voices[0].spoken.length >= 1, 'the opening');
  await c.hears(/Thanks for calling/, 'Testa Invented'); await c.hears(/street address/, '123 Invented Lane, Testville, CA 90210'); await c.hears(/What day and time/, 'Tuesday at ten'); await c.hears(/bedrooms and bathrooms/, 'two and two');
  assert.match(await c.hears(/cannot check the schedule/), /a person will call you/); await sc.closed;
  assert.ok(!c.voices[0].spoken.some((l) => /is one hundred ninety-nine dollars/.test(l)), 'no price or time was offered'); assert.equal(c.jobber.jobs.size, 0);
});

test('JOINED, TEXTS OFF (the default, campaign approval pending): the same call and the same real-Jobber booking, no text question, no consent recorded, no request to Twilio\'s message endpoint, and the texts reported as SKIPPED, never delivered', async () => {
  const r = await rig({ texts: false, ownerConsent: false });
  assert.deepEqual(r.status, { numbersPresent: true, textsOn: false, ownerConsent: false, jobberConnected: true, jobberWritesOn: true });
  const sim = await r.connect(); r.start(sim);
  await until(() => r.voices.length === 1 && r.voices[0].spoken.length >= 1, 'the opening');
  await r.hears(/Thanks for calling Drew Cleaning/, 'Testa Invented');
  await r.hears(/street address/, '123 Invented Lane, Testville, CA 90210');
  await r.hears(/What day and time/, 'Tuesday at ten');
  await r.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  assert.equal(await r.hears(/is one hundred ninety-nine dollars/, 'yes'), 'A standard cleaning for two bedrooms and two bathrooms is one hundred ninety-nine dollars. We have Tuesday, November third, 2026 at 10 A M. Does that work?');
  // the verified caller ID is still the callback candidate; with texts off the very next question is the read-back
  assert.equal(await r.hears(/calling from a number ending in 0 0 0 2/, 'yes'), 'I see you are calling from a number ending in 0 0 0 2. Is that the best number to reach you?');
  assert.match(await r.hears(/^To confirm/, 'yes'), /^To confirm: Standard cleaning for Testa Invented on Tuesday, November third, 2026 at 10 A M, at 123 Invented Lane, Testville, California, 9 0 2 1 0\. The price is one hundred ninety-nine dollars\./);
  assert.equal(await r.hears(/You are booked/), 'You are booked for Tuesday, November third, 2026 at 10 A M. Goodbye.');
  await until(() => r.outcomes.some((o) => o.reason === 'BOOKED'), 'the outcome');
  const spoken = r.voices[0].spoken.join(' | '); assert.ok(!/May we send you|automated booking-details|confirmation text is on its way/.test(spoken), 'no text question, no promise of a text');
  // the real Jobber booking is unchanged: calendar read first, one client, one job, independent read-back by id, $199
  assert.equal(r.jobber.clientCount(), 1); assert.equal(r.jobber.jobs.size, 1);
  const job = [...r.jobber.jobs.values()][0] as { total: number }; assert.equal(job.total, 199);
  assert.ok(r.jobber.ops.findIndex((x) => x.field === 'scheduledItems') < r.jobber.ops.findIndex((x) => x.field === 'clientCreate'));
  assert.equal(r.jobber.ops.filter((x) => x.field === 'job').length >= 1, true, 'the booking was read back by id');
  // SMS: nothing sent, nothing consented, nothing claimed
  assert.deepEqual(r.twilio.messages, [], 'no message request reached Twilio'); assert.deepEqual(await readConsent(createVault(r.dir, fakeProtector)), [], 'no consent record exists or was needed');
  const last = r.outcomes[r.outcomes.length - 1]; assert.deepEqual([last.reason, last.booked, last.customerText, last.ownerText], ['BOOKED', true, 'skipped', 'skipped']);
  assert.ok(r.logs.some((l) => l.code === 'FAST_TEXTS_SKIPPED') && !r.logs.some((l) => /TEXTS_SENT|TEXTS_VERIFIED/.test(l.code)), 'logged as skipped, never as sent or verified');
  await sim.closed; noPersonal(r.logs); noPersonal(r.diagLines);
});

test('texts stay off unless FAST_TEXTS is exactly on (any other word, any other case, is off)', async () => {
  const dir = (await rig({ texts: false })).dir; assert.equal((await fastStatus({ vaultDir: dir, protector: fakeProtector, env: {} })).textsOn, false);
  for (const word of ['yes', '', '1', 'true', 'off']) assert.equal((await fastStatus({ vaultDir: dir, protector: fakeProtector, env: { FAST_TEXTS: word } })).textsOn, false, word);
  assert.equal((await fastStatus({ vaultDir: dir, protector: fakeProtector, env: { FAST_TEXTS: 'ON' } })).textsOn, false);
  assert.equal((await fastStatus({ vaultDir: dir, protector: fakeProtector, env: { FAST_TEXTS: 'on' } })).textsOn, true);
});

test('texts off, defense in depth: even if something asked, the wired send is refused before any request to Twilio, no consent can be written, and the owner is never marked consenting', async () => {
  const r = await rig({ texts: false });
  assert.deepEqual(await r.fast.sendText(CUSTOMER, 'Hello test'), { ok: false, error: 'REFUSED' });
  assert.equal(await r.fast.recordConsent({ result: 'yes', script: 'fast-consent-v1-customer', ref: 'a'.repeat(24) }), false);
  assert.deepEqual([r.fast.textsEnabled, r.fast.ownerConsent], [false, false]); assert.deepEqual(r.twilio.messages, []);
  const on = await rig({ texts: true }); assert.deepEqual([on.fast.textsEnabled, on.fast.ownerConsent], [true, true]);
});

test('any word other than exactly on leaves the composed dependencies in texts-off mode', async () => {
  for (const word of ['yes', 'ON', 'true', '1', 'off', '']) { const r = await rig({ texts: false, word }); assert.equal(r.fast.textsEnabled, false, word || '(empty)'); assert.equal(r.status.textsOn, false, word || '(empty)'); }
});

test('JOINED: an UNASSIGNED visit in Jobber (how Drew\'s own bookings are stored) blocks the offer and blocks the booking right before the write', async () => {
  const busyAt = (from: string, to: string) => ({ startAt: new Date(instantOf('2026-11-03', from, 'America/Chicago')).toISOString(), endAt: new Date(instantOf('2026-11-03', to, 'America/Chicago')).toISOString(), unassigned: true });
  // 1. an unassigned visit at 9 to 12: the 10 A M asked for is not offered, and the query said it wants unassigned items
  const a = await rig(); a.jobber.opts.scheduled = [busyAt('09:00', '12:00')];
  const sa = await a.connect(); a.start(sa); await until(() => a.voices.length === 1 && a.voices[0].spoken.length >= 1, 'the opening');
  await a.hears(/Thanks for calling/, 'Testa Invented'); await a.hears(/street address/, '123 Invented Lane, Testville, CA 90210'); await a.hears(/What day and time/, 'Tuesday at ten'); await a.hears(/bedrooms and bathrooms/, 'two and two');
  const offer = await a.hears(/is one hundred ninety-nine dollars/); assert.match(offer, /Tuesday, November third, 2026 at 12 P M/, 'the unassigned visit was seen, so a later time is offered'); sa.end(); await pause(30);
  const read = a.jobber.ops.find((x) => x.field === 'scheduledItems')!; assert.equal((read.variables.filter as { includeUnassigned?: unknown }).includeUnassigned, true); assert.equal(a.jobber.jobs.size, 0);
  // 2. the slot is free at the offer, then an unassigned visit appears before the caller's final yes: the second read stops the booking and nothing is written
  const b = await rig(); const sb = await b.connect(); b.start(sb); await until(() => b.voices.length === 1 && b.voices[0].spoken.length >= 1, 'the opening');
  await b.hears(/Thanks for calling/, 'Testa Invented'); await b.hears(/street address/, '123 Invented Lane, Testville, CA 90210'); await b.hears(/What day and time/, 'Tuesday at ten'); await b.hears(/bedrooms and bathrooms/, 'two and two');
  assert.match(await b.hears(/is one hundred ninety-nine dollars/, 'yes'), /at 10 A M/); await b.hears(/calling from/, 'yes'); await b.hears(/May we send you one automated/, 'yes');
  await b.hears(/^To confirm/); b.jobber.opts.scheduled = [busyAt('10:00', '12:00')]; b.voices[0].hear('yes');   // someone else took the time (an unassigned visit) while the read-back was being said
  assert.match(await b.hears(/no longer available/), /nothing was booked/); await sb.closed;
  assert.equal(b.jobber.jobs.size, 0); assert.equal(b.jobber.clientCount(), 0); assert.ok(!b.jobber.ops.some((x) => x.field === 'clientCreate' || x.field === 'jobCreate'), 'no Jobber write was sent');
  assert.equal(b.outcomes[b.outcomes.length - 1].reason, 'NO_LONGER_AVAILABLE'); assert.equal(b.twilio.messages.length, 0);
});

test('JOINED: a caller who talks over a short question is not interrupted (no ADAPTER_INTERRUPT), the early answer is taken, nothing is asked twice and the booking completes; talking over the OFFER still clears it and the OFFER is replayed', async () => {
  const r = await rig({ msPerChar: 30 });   // slow enough to be spoken over
  const sim = await r.connect(); r.start(sim);
  await until(() => r.voices.length === 1 && r.voices[0].spoken.length >= 1, 'the opening');
  const asked = (re: RegExp): number => (r.voices[0].spoken).filter((l) => re.test(l)).length;
  const said = (id: string): number => r.logs.filter((l) => l.code === 'FAST_SAY' && l.detail?.id === id).length;
  // the line is being spoken (not just handed over: the OFFER waits behind "One moment."), and the caller starts to talk
  const talkOver = async (id: string, text: string, after?: RegExp): Promise<void> => { await until(() => said(id) > 0 && (after === undefined || r.voices[0].spoken.some((l) => after.test(l))) && r.voices[0].playing(), 'the ' + id + ' line to be playing'); r.voices[0].hear(text); };
  await r.hears(/Thanks for calling/, 'Testa Invented'); await r.hears(/street address/, '123 Invented Lane, Testville, CA 90210');
  // 1. the WHEN question is being spoken: the caller answers over it
  await talkOver('WHEN', 'Tuesday at ten');
  await r.hears(/What day and time/); await r.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  assert.equal(asked(/What day and time/), 1, 'the question was spoken once, to its end'); assert.equal(asked(/bedrooms and bathrooms/), 1);
  const cuts = (): number => r.diagLines.filter((d) => d.code === 'ADAPTER_INTERRUPT').length;   // the transport's own record that the caller took the floor from a line
  assert.equal(cuts(), 0, 'the short question was not interrupted');
  // 2. the OFFER is a unit: talking over it clears it, and it is spoken again
  await talkOver('OFFER', 'yes', /^One moment/);
  await until(() => r.logs.some((l) => l.code === 'CONFIRM_REPLAY' && l.detail?.id === 'OFFER'), 'the OFFER to be replayed');
  assert.equal(cuts(), 1, 'the unit was interrupted');
  // 3. the call goes on to the booking as before
  await r.hears(/Please wait until I have finished, then answer\. A standard cleaning/, 'yes');
  await r.hears(/calling from a number ending in/, 'yes'); await r.hears(/May we send you one automated/, 'yes');
  await r.hears(/^To confirm/, 'yes'); await r.hears(/You are booked/);
  await until(() => r.outcomes.some((o) => o.reason === 'TEXTS_VERIFIED'), 'the delivery check');
  assert.equal(r.jobber.clientCount(), 1); assert.equal(r.jobber.jobs.size, 1);
  await sim.closed; noPersonal(r.logs); noPersonal(r.diagLines);
});
