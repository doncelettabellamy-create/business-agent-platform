// The founder VOICE service end to end, with MOCKED outside services: a stand-in for Twilio (a Media Streams style client on loopback) -> the real WebSocket server (secret path + signature) -> the real voice
// bridge -> the real OpenAI voice socket over a mocked connection -> the Drew persona -> the real call logic, consent notice, masker, Intake agent, record store and (optionally) contact vault, with a mocked OpenAI
// text client for the Intake extraction and the spoken wording. No network, no real key; invented data only. A passing test shows behaviour against the mocks, not against Twilio or OpenAI. Run: npm test
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelayWsServer } from '../src/ws-server.ts';
import { signedUrlCandidates } from '../src/founder-call-gate.ts';
import type { FounderCallConfig } from '../src/founder-call-gate.ts';
import type { FounderVoiceConfig } from '../src/founder-voice-gate.ts';
import { createFounderVoiceService, residentialRouting } from '../src/founder-voice-service.ts';
import { createOpenAiVoiceSocket } from '../src/openai-voice-socket.ts';
import type { WebSocketLike } from '../src/openai-voice-socket.ts';
import { createIntakeRecordStore } from '../src/intake-record-store.ts';
import { mintExecutionContext } from '../src/execution-context.ts';
import { consentNoticeFor } from '../src/opening.ts';
import { SAY } from '../src/relay-handler.ts';
import { SPEAK_ONLY } from '../src/realtime-transport.ts';
import { createPersona, dialogueStyle, voiceManner } from '../src/persona.ts';
import { createOpenAIHttpClient } from '../src/openai-http-client.ts';
import { fallbackText } from '../src/dialogue-model.ts';
import { connectRelay } from './helpers/twilio-sim.ts';
import type { Sim } from './helpers/twilio-sim.ts';
import { b64, createWireVoice } from './helpers/realtime-wire-sim.ts';
import type { WireVoice } from './helpers/realtime-wire-sim.ts';

const T = 'ws-founder-plumbing';
const N1 = '+15555550100';
const TOKEN = 'test-auth-token-0123456789';
const FAKE_KEY = 'sk-test-not-a-real-key-0123456789';
const SECRET = 'q7Zr2KfX9mWc4TbV8nHs1LpD6yGe3AuJ5oRi0NxE';
const PATH = `/relay/${SECRET}`;
const URL_WSS = `wss://tunnel.example.test${PATH}`;
const SID = 'CA00000000000000000000000000000001';
const OPENING = 'Hello, how can I help you today?';
const plumbing = JSON.parse(readFileSync(new URL('../examples/skill-plumbing.json', import.meta.url), 'utf8')).skill_config;
const drewConfig = JSON.parse(readFileSync(new URL('../examples/persona-drew-cleaning.json', import.meta.url), 'utf8'));
const persona = createPersona(drewConfig);
const dir = mkdtempSync(join(tmpdir(), 'voice-service-'));
const closers: Array<() => unknown> = [];
after(async () => { for (const c of closers.reverse()) try { await c(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });
/** Waits for a condition; on timeout the error says where the call had got to (log codes and counts only, never speech), so an intermittent failure explains itself. */
// The bound only matters when something is wrong; it is generous because the whole suite runs its files in parallel, and a loaded machine (a CI runner, or a computer short of memory) once took just over four seconds here.
async function until(fn: () => boolean, ms = 20_000, where?: () => string): Promise<void> { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error(`timed out${where === undefined ? '' : ': ' + where()}`); await new Promise<void>((r) => setTimeout(r, 4)); } }
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A mocked OpenAI text API: the Intake extraction (structured output) and the spoken wording (plain text), answering from what it is sent, as the real one would from the masked text. */
function mockOpenAiText(opts: { failDialogue?: boolean; emptyDialogue?: boolean } = {}) {
  const seen: any[] = [];
  const reply = (text: string) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 20, output_tokens: 8 } });
  const fetch = (async (_url: string, init: RequestInit) => {
    const params = JSON.parse(String(init.body));
    seen.push(params);
    if (params.text?.format) {
      const { task, data } = JSON.parse(params.input);
      const text: string = data.masked_text;
      if (task === 'classify_request') return new Response(JSON.stringify(reply(JSON.stringify({ category: /burst pipe|leak|flood/i.test(text) ? 'Emergency leak' : null, confidence: 0.9 }))), { status: 200 });
      const fields = (data.fields ?? []).map((f: { name: string }) => {
        const m = f.name === 'Address' ? /\[ADDRESS_\d+\]/.exec(text) : f.name === 'Job description' ? /burst pipe|leak/i.exec(text) : /tomorrow morning/i.exec(text);
        return { name: f.name, value: m ? m[0] : null, confidence: m ? 0.9 : null };
      });
      return new Response(JSON.stringify(reply(JSON.stringify({ fields }))), { status: 200 });
    }
    if (opts.failDialogue) return new Response('{}', { status: 500 });
    if (opts.emptyDialogue) return new Response(JSON.stringify(reply('')), { status: 200 });
    const next = String(params.instructions).split('\n').pop() ?? '';
    const field = /^NEXT ASK (.+?)(?: \(asked before.*?\))?(?: CHOICES:.*)?$/.exec(next)?.[1];
    return new Response(JSON.stringify(reply(next.startsWith('NEXT OPEN') ? OPENING : field ? `Could you tell me the ${field.toLowerCase()}?` : next.startsWith('NEXT CLARIFY') ? 'Could you say what you need?' : 'Okay, please go on.')), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen, count: () => seen.length };
}

/** A mocked client WebSocket backed by the wire-level voice stand-in. */
function wsOver(v: WireVoice): WebSocketLike {
  const ws: WebSocketLike = {
    readyState: 0, bufferedAmount: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
    send: (d: string) => { if (!v.send(d)) throw new Error('refused'); },
    close: (c?: number) => { ws.readyState = 3; v.close(c); },
  };
  v.onMessage = (t: string) => { ws.onmessage?.({ data: t }); };
  v.onClose = () => { ws.onclose?.({}); };
  setTimeout(() => { ws.readyState = 1; v.open(); ws.onopen?.({}); }, 0);
  return ws;
}

async function rig(o: { key?: () => string | undefined; failDialogue?: boolean; emptyDialogue?: boolean; contacts?: boolean; voice?: Partial<FounderVoiceConfig>; voiceMsPerChar?: number; realTimePlayout?: boolean } = {}) {
  const callConfig: FounderCallConfig = {
    approval_id: 'voice-test', tenant: T, numbers: [N1], model: 'claude-haiku-5-5', max_minutes: 8, max_turns: 30, max_claude_calls: 150, max_calls: 5, expires: '2026-11-20T00:00:00Z', persona_names: ['Sam Example'],
    kill_file: join(dir, 'stop'), public_wss_url: URL_WSS, db_path: join(dir, 'calls.sqlite'), relay_port: 8788, dashboard_port: 8787, after_speech_ms: 0, skill_config: plumbing,
  };
  const voiceConfig: FounderVoiceConfig = { approval_id: 'v1', openai_model: 'gpt-test-model', realtime_model: 'realtime-test-model', transcription_model: 'transcribe-test-model', voice: 'test-voice', max_openai_calls: 50, persona: drewConfig, ...o.voice };
  const store = createIntakeRecordStore({ path: join(dir, `calls-${Math.random().toString(36).slice(2)}.sqlite`) });
  closers.push(() => store.close());
  const text = mockOpenAiText({ failDialogue: o.failDialogue, emptyDialogue: o.emptyDialogue });
  const voices: WireVoice[] = []; const handshakes: Array<{ url: string; headers: Record<string, string> }> = [];
  const logs: Array<{ code: string; detail?: Record<string, unknown> }> = [];
  const diagLines: Array<{ code: string; [k: string]: unknown }> = [];
  const service = createFounderVoiceService({
    diag: (code, detail) => { diagLines.push({ code, ...detail }); },
    config: callConfig, voice: voiceConfig,
    textClient: createOpenAIHttpClient({ getKey: () => FAKE_KEY, fetch: text.fetch }),
    openVoice: (d) => createOpenAiVoiceSocket({
      model: voiceConfig.realtime_model, getKey: o.key ?? (() => FAKE_KEY), connectTimeoutMs: 3000, diag: (code, detail) => { d(code as never, detail); },
      factory: (url, init) => { handshakes.push({ url, headers: init.headers }); const v = createWireVoice({ msPerChar: o.voiceMsPerChar ?? 1, autoOpen: false }); voices.push(v); return wsOver(v); },
    }),
    store,
    async intakeContext(tenant, ref) {
      const r = await mintExecutionContext({ credential: 'test', agent: 'intake' }, { verify: () => ({ kind: 'system', id: 'voice-service-test' }), selectTenant: () => tenant, grants: () => ['intake:run'], newCorrelationId: () => `corr-${ref}` });
      if (!r.ok) throw new Error('context');
      return r.context;
    },
    now: () => Date.now(), nowIso: () => '2026-10-26T12:00:00Z', killed: () => false, log: (code, detail) => { logs.push({ code, detail }); },
  });
  const server = createRelayWsServer({ path: PATH, authToken: TOKEN, urls: signedUrlCandidates(URL_WSS), maxConnections: 2, onConnection: (c) => service.handleStream(c) } as never);
  const port = await server.listen(0);
  closers.push(() => server.close());
  const connect = async (over: Record<string, unknown> = {}): Promise<Sim> => {
    const sim = await connectRelay({ port, token: TOKEN, url: URL_WSS, path: PATH, ...over } as never);
    if (sim.status === 101) {
      let seen = 0; let playEnd = Date.now();   // the phone side: echoes every marker once the audio would have played (at once, or in REAL TIME like a phone line when asked to)
      const timer = setInterval(() => {
        for (; seen < sim.messages.length; seen++) {
          const m = sim.messages[seen];
          if (m.event === 'media' && o.realTimePlayout) playEnd = Math.max(Date.now(), playEnd) + Buffer.from(m.media.payload, 'base64').length / 8;
          else if (m.event === 'mark') { const send = () => { try { sim.send({ event: 'mark', streamSid: m.streamSid, mark: { name: m.mark.name } }); } catch { /* closed */ } }; if (o.realTimePlayout) { const t = setTimeout(send, Math.max(0, playEnd - Date.now())); t.unref?.(); } else send(); }
        }
      }, 5);
      timer.unref?.(); void sim.closed.then(() => clearInterval(timer));
    }
    return sim;
  };
  const start = (sim: Sim, to = N1) => { sim.send({ event: 'connected', protocol: 'Call', version: '1.0.0' }); sim.send({ event: 'start', sequenceNumber: '1', start: { streamSid: 'MZ1', callSid: SID, tracks: ['inbound'], customParameters: { to }, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } }, streamSid: 'MZ1' }); };
  const has = (code: string) => logs.some((l) => l.code === code);
  return { service, store, text, voices, handshakes, logs, diagLines, connect, start, has, handler: service.handler, notice: service.notice };
}
type Rig = Awaited<ReturnType<typeof rig>>;
const spokenCount = (r: Rig) => r.voices[0]?.spoken.length ?? 0;
const where = (r: Rig, sim: Sim): string => JSON.stringify({ logs: r.logs.map((l) => l.code), spoken: spokenCount(r), voiceTypes: (r.voices[0]?.received ?? []).map((m: { type: string }) => m.type), phoneEvents: sim.messages.map((m: { event: string }) => m.event), appended: r.voices[0]?.appended() });
async function say(r: Rig, text: string, n: number) { r.voices[0].hear(text); await until(() => spokenCount(r) >= n); await r.handler.idle(); }
const SECRETS = ['Sam Example', 'sam example', 'Elm Street', '42 Elm', '555 010 0199', '0199'];

test('full call: the notice, a yes, the cleaning questions, the fixed read-back and a saved confirmed record, all over the stream, with the Drew persona on every spoken line', async () => {
  const r = await rig();
  const sim = await r.connect();
  assert.equal(sim.status, 101);
  r.start(sim);
  await until(() => r.voices.length === 1 && r.voices[0].spoken.length >= 1, 20_000, () => where(r, sim));
  sim.send({ event: 'media', media: { payload: b64(160) } });   // sound during the notice
  assert.equal(r.voices[0].appended(), 0, 'no caller audio reaches the voice service before the notice has been played');
  await until(() => r.has('CALL_STARTED'), 20_000, () => where(r, sim));
  assert.equal(r.voices[0].spoken[0], r.notice);
  assert.equal(r.notice, consentNoticeFor(undefined), 'the notice is the one the existing call logic uses');
  sim.send({ event: 'media', media: { payload: b64(160) } });
  await until(() => r.voices[0].appended() === 1);
  await say(r, 'yes I agree', 2);
  assert.equal(r.voices[0].spoken[1], OPENING);
  assert.ok(r.has('CONSENT_GRANTED'));
  await say(r, 'Hi, I have a burst pipe in the kitchen', 3);
  await say(r, 'The address is 42 Elm Street', 4);
  assert.equal(r.voices[0].spoken[3], 'Let me check what I have. Job description: burst pipe. Is that correct? Please say yes or no.', 'the read-back is the server\'s fixed wording');
  await say(r, 'yes that is right', 5);
  await sim.closed;
  assert.equal(sim.closeCode(), 1000, 'the stream is closed after the goodbye, which is what lets the TwiML hang up');
  await r.handler.idle();
  assert.equal(r.voices[0].spoken[4], SAY.thanks);
  const [rec] = r.store.list(T);
  assert.deepEqual([rec.confirmation, rec.handed_off, rec.status, rec.category], ['confirmed', true, 'ready', 'Emergency leak']);
  // The Drew persona is on every speech request, in front of the exact words.
  const creates = r.voices[0].received.filter((m) => m.type === 'response.create');
  assert.equal(creates.length, 5);
  assert.ok(creates.every((m) => String(m.response.instructions).startsWith(`${SPEAK_ONLY} ${voiceManner(persona)} `)));
  assert.ok(creates.every((m) => m.response.conversation === 'none'));
  assert.ok(r.voices[0].received.filter((m) => m.type === 'session.update').every((m) => m.session.type === 'realtime' && m.session.audio.input.format.type === 'audio/pcmu'));
  assert.deepEqual(r.voices[0].refused, [], 'nothing the documented schema would refuse was sent');
  // The spoken wording came from the OpenAI text model with the persona line before the NEXT line, which is last.
  const dialogue = r.text.seen.filter((p) => !p.text);
  assert.ok(dialogue.length >= 2, 'the opening question and the address question were worded by the text model');
  for (const p of dialogue) {
    const lines = String(p.instructions).split('\n').filter((l) => !l.startsWith('STATUS '));   // the STATUS line (field names only) sits between the persona line and NEXT
    assert.equal(lines[lines.length - 2], dialogueStyle(persona));
    assert.ok(lines[lines.length - 1].startsWith('NEXT'));
    assert.equal(p.store, false);
  }
});

test('settings: with none configured the documented defaults reach the wire (minimal voice reasoning, no text reasoning), and a transcriber that documents no hints gets none', async () => {
  const r = await rig();
  const sim = await r.connect(); r.start(sim);
  await until(() => r.has('CALL_STARTED'));
  await say(r, 'yes I agree', 2);
  await say(r, 'Hi, I have a burst pipe in the kitchen', 3);
  const v = r.voices[0];
  const updates = v.received.filter((m) => m.type === 'session.update');
  assert.ok(updates.length >= 2 && updates.every((m) => m.session.reasoning.effort === 'minimal'));
  assert.deepEqual(updates[0].session.audio.input.transcription, { model: 'transcribe-test-model' });
  assert.ok(v.received.filter((m) => m.type === 'response.create').every((m) => m.response.reasoning.effort === 'minimal'));
  assert.ok(r.text.seen.length >= 3, 'extraction and wording were both asked');
  assert.ok(r.text.seen.every((p) => p.reasoning.effort === 'none'), 'every text request, Intake and wording, carries the text reasoning default');
  assert.deepEqual(v.refused, []);
  sim.end(); await pause(20);
});

test('settings: a transcriber that documents hints gets English by default, and explicit settings reach both the voice and the text models', async () => {
  const d = await rig({ voice: { transcription_model: 'gpt-live-transcribe' } });
  const s1 = await d.connect(); d.start(s1);
  await until(() => d.has('CALL_STARTED'));
  assert.deepEqual(d.voices[0].received.find((m) => m.type === 'session.update').session.audio.input.transcription, { model: 'gpt-live-transcribe', languages: ['en'] });
  assert.deepEqual(d.voices[0].refused, []);
  s1.end(); await pause(20);
  const e = await rig({ voice: { transcription_model: 'gpt-live-transcribe', realtime_reasoning: 'low', text_reasoning: 'low', transcription: { languages: ['en'], keywords: ['Drew Cleaning'] } } });
  const s2 = await e.connect(); e.start(s2);
  await until(() => e.has('CALL_STARTED'));
  await say(e, 'yes I agree', 2);
  await say(e, 'Hi, I have a burst pipe in the kitchen', 3);
  const u = e.voices[0].received.find((m) => m.type === 'session.update');
  assert.equal(u.session.reasoning.effort, 'low');
  assert.deepEqual(u.session.audio.input.transcription, { model: 'gpt-live-transcribe', languages: ['en'], keywords: ['Drew Cleaning'] });
  assert.ok(e.voices[0].received.filter((m) => m.type === 'response.create').every((m) => m.response.reasoning.effort === 'low'));
  assert.ok(e.text.seen.every((p) => p.reasoning.effort === 'low'));
  assert.deepEqual(e.voices[0].refused, []);
  s2.end(); await pause(20);
});

test('diagnostics: the voice service logs each call from the moment the stream is accepted, with the wait it allows for the notice, and every line belongs to its call', async () => {
  const r = await rig();
  const sim = await r.connect(); r.start(sim);
  await until(() => r.has('CALL_STARTED'));
  await say(r, 'yes I agree', 2);
  const codes = r.diagLines.map((l) => l.code);
  for (const c of ['CALL_STREAM_ACCEPTED', 'VOICE_CONNECT_STARTED', 'VOICE_OPEN', 'BRIDGE_PHONE_START', 'BRIDGE_ANNOUNCED', 'ADAPTER_NOTICE_REQUESTED', 'BRIDGE_FIRST_AUDIO_OUT', 'BRIDGE_NOTICE_HEARD', 'ADAPTER_SETUP_EMITTED']) assert.ok(codes.includes(c), `${c} missing from: ${codes.join(' ')}`);
  assert.equal(codes[0], 'CALL_STREAM_ACCEPTED');
  assert.ok(r.diagLines.every((l) => l.call === 1 && typeof l.ms === 'number'));
  const accepted = r.diagLines[0];
  assert.equal(accepted.noticeChars, r.notice.length);
  assert.equal(accepted.setupWaitMs, Math.min(300_000, Math.max(5000, Math.ceil(r.notice.length * 70) + 30_000)), 'the call logic waits for the notice, not for 5 seconds');
  assert.ok((accepted.setupWaitMs as number) > r.notice.length * 70, 'longer than the notice takes to say');
  const out = JSON.stringify(r.diagLines);
  for (const s of [FAKE_KEY, 'yes I agree', r.notice.slice(0, 30), 'wss://', 'relay/']) assert.ok(!out.includes(s), `a diagnostic holds: ${s}`);
  const second = await r.connect(); r.start(second);   // a second call is numbered 2
  await until(() => r.diagLines.some((l) => l.call === 2 && l.code === 'CALL_STREAM_ACCEPTED'));
  sim.end(); second.end(); await pause(30);
});

test('a consent notice that takes longer than 5 seconds to say (as the real one does, about 28 seconds) does not end the call: the call logic waits for the notice to be heard, not for 5 seconds', async () => {
  const r = await rig({ voiceMsPerChar: 30, realTimePlayout: true });      // the default notice is about 280 characters: about 8 seconds of speech here, played in real time like a phone line (the real one takes 28 s)
  const sim = await r.connect(); r.start(sim);
  await until(() => r.voices.length === 1 && r.voices[0].spoken.length >= 1, 15_000);
  const closedEarly = sim.closeCode() !== undefined;
  await until(() => r.has('CALL_STARTED') || r.has('SETUP_TIMEOUT'), 15_000, () => where(r, sim));
  assert.ok(!r.has('SETUP_TIMEOUT'), 'the call logic gave up on the carrier after 5 seconds, while the notice was still being said');
  assert.ok(!closedEarly && r.has('CALL_STARTED'));
  await say(r, 'yes I agree', 2);
  assert.equal(r.voices[0].spoken[1], OPENING);
  sim.end(); await pause(30);
}, { timeout: 60_000 });

test('privacy: the raw caller words never reach the OpenAI text model, the key is only in the handshake, and no log line holds speech', async () => {
  const r = await rig();
  const sim = await r.connect(); r.start(sim);
  await until(() => r.has('CALL_STARTED'));
  await say(r, 'yes I agree', 2);
  await say(r, 'Hi this is Sam Example, I have a burst pipe in the kitchen', 3);
  await say(r, 'The address is 42 Elm Street and call me on 555 010 0199', 4);
  const sentToText = JSON.stringify(r.text.seen);
  for (const s of SECRETS) assert.ok(!sentToText.includes(s), `raw text reached the text model: ${s}`);
  assert.ok(sentToText.includes('[PERSON_1]') || sentToText.includes('[ADDRESS_1]'), 'masked placeholders are what it sees');
  assert.equal(r.handshakes.length, 1);
  assert.equal(r.handshakes[0].url, 'wss://api.openai.com/v1/realtime?model=realtime-test-model');
  assert.equal(r.handshakes[0].headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.ok(!JSON.stringify(r.voices[0].received).includes(FAKE_KEY), 'the key is never in anything sent over the voice connection');
  assert.ok(!sentToText.includes(FAKE_KEY));
  const logText = JSON.stringify(r.logs);
  for (const s of [...SECRETS, FAKE_KEY, 'burst pipe']) assert.ok(!logText.includes(s), `a log line holds: ${s}`);
  sim.end();
});

test('consent: anything but a plain yes ends the call with the fixed goodbye; no text model is contacted and nothing is kept', async () => {
  const r = await rig();
  const sim = await r.connect(); r.start(sim);
  await until(() => r.has('CALL_STARTED'));
  r.voices[0].hear('no thank you');
  await sim.closed;
  assert.equal(r.voices[0].spoken[1], SAY.declined);
  assert.equal(r.text.count(), 0, 'no OpenAI text call was made');
  assert.equal(r.store.list(T).length, 0);
  assert.ok(!r.has('CONSENT_GRANTED'));
  await r.handler.idle();
});

test('consent-before-audio, as it is: the answer to the consent question is audio the voice service hears before the server has checked it', async () => {
  const r = await rig();
  const sim = await r.connect(); r.start(sim);
  await until(() => r.has('CALL_STARTED'));
  sim.send({ event: 'media', media: { payload: b64(160) } });   // the caller's "no", as audio
  await until(() => r.voices[0].appended() === 1);
  assert.equal(r.voices[0].appended(), 1, 'THE OPEN GAP: closing it needs consent collected on the phone side first');
  sim.end(); await pause(20);
});

test('safeguards: an unknown number is refused (after the notice, a known gap), a stream with no dialed number is refused, and neither contacts a text model or keeps a record', async () => {
  for (const to of ['+15555550177', '']) {
    const r = await rig();
    const sim = await r.connect(); r.start(sim, to);
    await sim.closed;
    assert.equal(r.text.count(), 0, to);
    assert.equal(r.store.list(T).length, 0, to);
    await r.handler.idle();
  }
});

test('safeguards: the stream endpoint refuses a wrong signature and a wrong path, so no voice connection and no key use happen', async () => {
  const r = await rig();
  const bad = [await r.connect({ signature: null }), await r.connect({ signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=' }), await r.connect({ path: '/relay/wrongwrongwrongwrongwrongwrongwrongwrong' })];
  assert.ok(bad.every((b) => b.status !== 101));
  await pause(30);
  assert.deepEqual([r.voices.length, r.handshakes.length, r.text.count()], [0, 0, 0]);
});

test('safeguards: with no usable key the call ends before anything is said, no connection is made and no record is kept', async () => {
  const r = await rig({ key: () => undefined });
  const sim = await r.connect(); r.start(sim);
  await sim.closed;
  assert.deepEqual([r.handshakes.length, r.text.count(), r.store.list(T).length], [0, 0, 0]);
  assert.ok(!r.has('CALL_STARTED'));
  await r.handler.idle();
});

test('limits: the caller hanging up mid-call closes the voice connection and saves the request unconfirmed, nothing is left open', async () => {
  const r = await rig();
  const sim = await r.connect(); r.start(sim);
  await until(() => r.has('CALL_STARTED'));
  await say(r, 'yes I agree', 2);
  await say(r, 'Hi, I have a burst pipe in the kitchen', 3);
  sim.send({ event: 'stop', sequenceNumber: '9', stop: { callSid: SID }, streamSid: 'MZ1' });
  await until(() => r.voices[0].closedWith.length > 0);
  await r.handler.idle();
  assert.deepEqual(r.voices[0].closedWith, [1000]);
  assert.equal(r.handler.active(), 0);
});

test('failure: when the OpenAI text model answers with nothing, the caller is not left in silence: one retry, then the server asks in its own fixed wording', async () => {
  const r = await rig({ emptyDialogue: true });
  const sim = await r.connect(); r.start(sim);
  await until(() => r.has('CALL_STARTED'));
  r.voices[0].hear('yes I agree');
  await until(() => spokenCount(r) >= 2, 8000);
  assert.equal(r.voices[0].spoken[1], fallbackText({ kind: 'open' }));
  assert.ok(r.has('REPLY_FALLBACK_SENT'));
  assert.equal(r.text.seen.filter((p) => !p.text).length, 2, 'asked, retried once, then the fixed wording');
  sim.end(); await pause(20);
});

test('failure: when the OpenAI text model keeps erroring, each turn is retried and answered in fixed words, and the third failed turn in a row ends the call with the fixed apology, saved unconfirmed with nothing handed on, and the stream closed', async () => {
  const r = await rig({ failDialogue: true });
  const sim = await r.connect(); r.start(sim);
  await until(() => r.has('CALL_STARTED'));
  await say(r, 'yes I agree', 2);
  assert.equal(r.voices[0].spoken[1], fallbackText({ kind: 'open' }), 'the opening is said in the server\'s own words');
  await say(r, 'I have a burst pipe', 3);
  r.voices[0].hear('it is flooding');
  await sim.closed;
  await r.handler.idle();
  assert.equal(r.voices[0].spoken[3], SAY.trouble);
  assert.equal(sim.closeCode(), 1000);
  assert.ok(r.store.list(T).every((x) => x.handed_off === false));
});

test('failure: a voice service that drops mid-call ends the call and closes the stream', async () => {
  const r = await rig();
  const sim = await r.connect(); r.start(sim);
  await until(() => r.has('CALL_STARTED'));
  r.voices[0].onClose();
  await sim.closed;
  await r.handler.idle();
  assert.equal(r.handler.active(), 0);
});

test('native conversation (voice config conversation: "native"): the voice is offered the five contact tools and nothing else, the notice is still spoken word for word, and the default stays scripted', async () => {
  const s = await rig();
  const c0 = await s.connect(); s.start(c0);
  await until(() => s.has('CALL_STARTED'));
  assert.ok(s.voices[0].received.filter((m) => m.type === 'session.update').every((m) => m.session.tools === undefined), 'scripted by default: no tools');
  c0.end(); await pause(20);
  const n = await rig({ voice: { conversation: 'native' } });
  const c1 = await n.connect(); n.start(c1);
  await until(() => n.has('CALL_STARTED'));
  const updates = n.voices[0].received.filter((m) => m.type === 'session.update');
  assert.ok(updates.length >= 1 && updates.every((m) => m.session.tool_choice === 'auto' && m.session.tools.map((t: any) => t.name).join() === 'collect_name,collect_phone,collect_address,correct_contact,call_status'));
  assert.ok(!updates.some((m) => m.session.tools.some((t: any) => /price|quote|book|slot|calendar|process|handoff/i.test(t.name))));
  assert.equal(n.voices[0].spoken[0], n.notice, 'the consent notice is exact');
  assert.deepEqual(n.voices[0].refused, []);
  c1.end(); await pause(20);
});

test('residential-only wiring: Drew\'s service declines the skill\'s person-routed (commercial) category with the founder\'s exact question, and a skill without one is unchanged', () => {
  const cleaning = JSON.parse(readFileSync(new URL('../examples/skill-cleaning-services.json', import.meta.url), 'utf8')).skill_config;
  const r = residentialRouting(cleaning.categories, 'Drew Cleaning');
  assert.ok(r !== undefined);
  assert.deepEqual(r.declined, ['Commercial cleaning']);
  assert.equal(r.question, 'Drew Cleaning cleans houses, apartments, condos and townhouses. We don’t offer commercial cleaning. Is your request for a residential property?');
  assert.ok(r.keywords.includes('office') && r.keywords.includes('commercial'));
  assert.ok(!/call|follow|contact/i.test(r.declineLine));
  assert.equal(residentialRouting(plumbing.categories, 'Drew Cleaning'), undefined);
});
