// The offline connection between a phone's audio stream and the OpenAI voice service (src/realtime-bridge.ts), run against wire-level stand-ins for both ends
// (tests/helpers/realtime-wire-sim.ts) and, in the second half, with the real cleaning call logic on top. No socket, no network, no key; invented data only.
// A passing test shows behaviour against THESE models of Twilio and OpenAI, not against the services. Run: npm test
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIntakeEntry } from '../src/intake-entry.ts';
import { createTenantRegistry } from '../src/tenant-boundary.ts';
import { mintExecutionContext } from '../src/execution-context.ts';
import { createIntakeRecordStore } from '../src/intake-record-store.ts';
import { createRelayHandler, SAY } from '../src/relay-handler.ts';
import { consentNoticeFor } from '../src/opening.ts';
import type { DialogueModel } from '../src/dialogue-model.ts';
import type { ModelProvider, ModelRequest } from '../src/model-gateway.ts';
import { createRealtimeTransport, SAY_PREFIX, SPEAK_ONLY } from '../src/realtime-transport.ts';
import { createRealtimeBridge, startRealtimeCall } from '../src/realtime-bridge.ts';
import { createPersona, voiceManner } from '../src/persona.ts';
import type { TransportEvent } from '../src/call-transport.ts';
import { b64, createWirePhone, createWireVoice } from './helpers/realtime-wire-sim.ts';
import type { Behaviour } from './helpers/realtime-wire-sim.ts';

const T = 'ws-founder-plumbing';
const N1 = '+15555550100';
const MPC = 1;
const NOTICE = 'Hello. This is an automated A I assistant for Example Cleaning. Please say yes to continue, or hang up now.';
const drew = JSON.parse(readFileSync(new URL('../examples/persona-drew-cleaning.json', import.meta.url), 'utf8'));
const plumbing = JSON.parse(readFileSync(new URL('../examples/skill-plumbing.json', import.meta.url), 'utf8')).skill_config;
const dir = mkdtempSync(join(tmpdir(), 'realtime-bridge-'));
const closers: Array<() => unknown> = [];
after(async () => { for (const c of closers.reverse()) try { await c(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });

async function until(fn: () => boolean, ms = 3000): Promise<void> { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise<void>((r) => setTimeout(r, 4)); } }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface HOptions { voice?: Parameters<typeof createWireVoice>[0]; phone?: Parameters<typeof createWirePhone>[0]; bridge?: Parameters<typeof createRealtimeBridge>[2]; realtime?: Record<string, unknown> }
function harness(o: HOptions = {}) {
  const phone = createWirePhone(o.phone);
  const voice = createWireVoice({ msPerChar: MPC, ...o.voice });
  const bridge = createRealtimeBridge(phone, voice, o.bridge);
  const toAdapter: unknown[] = [];
  const orig = bridge.link.onMessage;   // set by the adapter below; wrapped so the test can see everything the adapter is given
  const t = createRealtimeTransport(bridge.link, { notice: NOTICE, transcriptionModel: 'sim-transcriber', voice: 'sim-voice', msPerChar: MPC, endWaitMs: 500, ...o.realtime });
  const adapterIn = bridge.link.onMessage; void orig;
  bridge.link.onMessage = (m: unknown) => { toAdapter.push(m); adapterIn(m); };
  const events: TransportEvent[] = []; const closes: unknown[] = [];
  t.onEvent = (e) => { events.push(e); }; t.onClose = (i) => { closes.push(i); };
  const kinds = () => events.map((e) => e.kind);
  return { phone, voice, bridge, t, events, closes, toAdapter, kinds };
}
type H = ReturnType<typeof harness>;
const mediaSent = (h: { phone: { sent: any[] } }): number => h.phone.sent.filter((m) => m.event === 'media').length;
const live = async (h: H) => { h.phone.start(); await until(() => h.kinds().includes('setup')); };

// ================================================================ setup and settings
test('setup: the voice service is set to the phone\'s audio format in both directions, with the adapter\'s own settings kept and its object left alone', async () => {
  const h = harness();
  await live(h);
  const first = h.voice.received[0];
  assert.equal(first.type, 'session.update');
  assert.deepEqual(first.session.audio.input.format, { type: 'audio/pcmu' });
  assert.deepEqual(first.session.audio.output.format, { type: 'audio/pcmu' });
  assert.equal(first.session.audio.input.turn_detection.create_response, false, 'the voice service still never replies on its own');
  assert.equal(first.session.instructions, SPEAK_ONLY);
  assert.deepEqual(h.voice.received.map((m) => m.type).slice(0, 3), ['session.update', 'session.update', 'response.create']);
  const setup = h.events.find((e) => e.kind === 'setup') as { to: unknown; callSid: unknown };
  assert.deepEqual([setup.to, setup.callSid], [N1, 'CA00000000000000000000000000000001'], 'the dialed number and call id reach the call logic from the stream\'s start parameters');
});

test('setup: the reasoning effort and the transcription hints pass through the bridge untouched, next to the audio format it adds', async () => {
  const h = harness({ realtime: { reasoningEffort: 'minimal', transcriptionModel: 'gpt-live-transcribe', transcription: { languages: ['en'], keywords: ['Drew Cleaning'] } } });
  await live(h);
  const first = h.voice.received[0];
  assert.equal(first.session.reasoning.effort, 'minimal');
  assert.deepEqual(first.session.audio.input.transcription, { model: 'gpt-live-transcribe', languages: ['en'], keywords: ['Drew Cleaning'] });
  assert.deepEqual(first.session.audio.input.format, { type: 'audio/pcmu' });
  assert.ok(h.voice.received.filter((m) => m.type === 'response.create').every((m) => m.response.reasoning.effort === 'minimal'));
  assert.deepEqual(h.voice.refused, []);
});

test('setup: the Drew persona reaches the voice service as manner only, and the notice is still spoken word for word first', async () => {
  const p = createPersona(drew);
  const h = harness({ realtime: { persona: p } });
  await live(h);
  assert.equal(h.voice.received[0].session.instructions, `${SPEAK_ONLY} ${voiceManner(p)}`);
  assert.equal(h.voice.received[2].response.instructions, `${SPEAK_ONLY} ${voiceManner(p)} ${SAY_PREFIX}${NOTICE}`, 'the Drew manner is in the request itself, not only the session');
  assert.deepEqual(h.voice.refused, []);
  assert.equal(h.voice.received[0].session.type, 'realtime');
  assert.equal(h.voice.spoken[0], NOTICE);
  assert.throws(() => harness({ realtime: { persona: { business_name: 'Drew Cleaning' } } }), RangeError, 'a lookalike is refused');
});

test('setup: nothing starts until the voice socket is open; a socket that never opens ends the call and the call logic never sees it', async () => {
  const slow = harness({ voice: { autoOpen: false }, bridge: { openWaitMs: 60 } });
  slow.phone.start();
  await sleep(20);
  assert.deepEqual(slow.events, [], 'the phone started but the voice service is not ready');
  slow.voice.open();
  await until(() => slow.kinds().includes('setup'));
  const never = harness({ voice: { autoOpen: false }, bridge: { openWaitMs: 40 } });
  never.phone.start();
  await until(() => never.closes.length > 0);
  assert.deepEqual(never.closes[0], { cause: 'PROTOCOL', code: 1011 });
  assert.deepEqual(never.phone.closedWith, [1000], 'the phone stream is closed, so the TwiML hang-up ends the call');
  assert.ok(!never.kinds().includes('setup'));
});

test('setup: audio the bridge cannot carry (not mu-law 8 kHz) is refused before anything is sent to the voice service', async () => {
  for (const bad of [{ encoding: 'audio/L16' }, { sampleRate: 16000 }]) {
    const h = harness();
    h.phone.start(bad);
    await until(() => h.closes.length > 0);
    assert.deepEqual(h.voice.received, [], JSON.stringify(bad));
    assert.ok(!h.kinds().includes('setup'));
  }
  const h = harness();
  h.phone.raw(JSON.stringify({ event: 'start', start: {} }));
  await until(() => h.closes.length > 0);
  assert.deepEqual(h.voice.received, []);
});

// ================================================================ consent before audio
test('consent-before-audio: no caller audio reaches the voice service until the notice has been played to the end; frames before that are dropped, not stored', async () => {
  const h = harness();
  h.phone.start();
  await until(() => h.voice.playing());
  h.phone.frames(10);                       // the caller makes sound during the notice
  assert.equal(h.voice.appended(), 0);
  await until(() => h.kinds().includes('setup'));
  h.phone.frames(5);                        // after the notice
  await until(() => h.voice.appended() === 5);
  const s = h.bridge.stats();
  assert.deepEqual([s.audioHeldBack, s.audioIn], [10, 5], 'held back frames are counted and gone');
  assert.equal(h.voice.appended(), 5, 'the frames held back are never sent late');
});

test('consent-before-audio: a notice that is never confirmed played, or is said wrongly, leaves the caller\'s microphone closed for good', async () => {
  const unplayed = harness({ phone: {}, bridge: { playGraceMs: 40 } });
  unplayed.phone.muteMarks = true;           // the phone never reports the audio as played
  unplayed.phone.start();
  await until(() => unplayed.closes.length > 0);
  unplayed.phone.frames(5);
  assert.equal(unplayed.voice.appended(), 0);
  assert.ok(!unplayed.kinds().includes('setup'));
  for (const behave of ['fail', 'silent', { say: 'Hi, how can I help?' }] as Behaviour[]) {
    const h = harness({ voice: { behave: () => behave } });
    h.phone.start();
    await until(() => h.closes.length > 0);
    h.phone.frames(5);
    assert.equal(h.voice.appended(), 0, JSON.stringify(behave));
    assert.ok(!h.kinds().includes('setup'), JSON.stringify(behave));
  }
});

test('consent-before-audio: THE GAP, stated as a test: the caller\'s answer to the consent question is audio the voice service hears before the server has checked it', async () => {
  const h = harness();
  await live(h);
  h.phone.frames(3);                         // the caller says "no" (audio)
  await until(() => h.voice.appended() === 3);
  assert.equal(h.voice.appended(), 3, 'a no is heard by the voice service: closing this needs consent to be collected on the phone side first (not built)');
});

// ================================================================ playing, played time and failures
test('replies: a reply is reported finished only when the phone has played it; its audio goes to the phone and never to the call logic', async () => {
  const h = harness();
  await live(h);
  const text = 'Could you tell me the address of the job please? ' .repeat(3).trim();
  h.t.speak(text, true);
  await until(() => h.phone.sent.some((m) => m.event === 'media'));
  assert.ok(h.phone.sent.some((m) => m.event === 'mark'), 'every piece of audio is followed by a marker');
  assert.ok(h.phone.sent.filter((m) => m.event === 'media').every((m) => m.streamSid === 'MZ1'));
  await h.voice.idle(); await h.phone.drained();
  await sleep(20);
  assert.equal(h.voice.spoken[1], text);
  assert.ok(!h.kinds().includes('reply_failed'));
  assert.ok(h.bridge.stats().audioOut >= 3);
  const seen = JSON.stringify(h.toAdapter);
  assert.ok(!seen.includes('output_audio.delta') && !seen.includes(b64(800)), 'audio never reaches the adapter');
});

test('replies: a reply whose audio the phone never confirms is reported as not played, so the question is asked again rather than taken as heard', async () => {
  const h = harness({ bridge: { playGraceMs: 40 } });
  await live(h);
  h.phone.muteMarks = true;
  h.t.speak('Could you tell me the address of the job please?', true);
  await until(() => h.kinds().includes('reply_failed'));
  assert.equal(h.kinds().filter((k) => k === 'reply_failed').length, 1);
});

test('replies: audio that cannot be sent to the phone makes the reply count as not played', async () => {
  const h = harness();
  await live(h);
  const send = h.phone.send.bind(h.phone);
  h.phone.send = (m: unknown) => ((m as { event?: string }).event === 'media' ? false : send(m));
  h.t.speak('Could you tell me the address of the job please?', true);
  await until(() => h.kinds().includes('reply_failed'));
});

test('replies: words that differ from the request, or no sound at all, are reported as failed (the adapter\'s check still applies through the bridge)', async () => {
  for (const behave of [{ say: 'Sure, that will be fifty dollars.' }, 'silent', 'fail'] as Behaviour[]) {
    const h = harness({ voice: { behave: (_t, n) => (n === 1 ? 'exact' : behave) } });
    await live(h);
    h.t.speak('Could you tell me the address of the job please?', true);
    await until(() => h.kinds().includes('reply_failed'));
  }
});

// ================================================================ interruptions
test('interruption: talking over a reply gives the call logic the part that was really played (from the phone\'s markers) and clears what was queued', async () => {
  const h = harness();
  await live(h);
  const text = 'This is a rather long reply that goes on and on so that the caller can talk over it before it is finished, with plenty of ordinary words in it. '.repeat(2).trim();
  const before = mediaSent(h);
  h.t.speak(text, true);
  await until(() => mediaSent(h) > before);
  await sleep(150);
  h.voice.hear('excuse me');
  await until(() => h.kinds().includes('interrupt') && h.kinds().includes('utterance'));
  assert.ok(h.phone.sent.some((m) => m.event === 'clear'), 'the phone is told to drop what it has not played');
  const spoken = (h.events.find((e) => e.kind === 'interrupt') as { spoken: string }).spoken;
  assert.ok(spoken.length > 0 && spoken.length < text.length && text.startsWith(spoken), 'a prefix of the reply, not all of it and not none');
  assert.ok(h.toAdapter.some((m) => (m as { x_played_ms?: number }).x_played_ms !== undefined));
  await h.voice.idle(); await sleep(30);
  assert.ok(!h.kinds().includes('reply_failed'), 'an interrupted reply is not a failed one');
});

test('interruption: late audio and late markers of a reply that was cleared are dropped, not played and not counted as progress', async () => {
  const h = harness();
  await live(h);
  const text = 'This is a rather long reply that goes on and on so that the caller can talk over it before it is finished. '.repeat(3).trim();
  const before = mediaSent(h);
  h.t.speak(text, true);
  await until(() => mediaSent(h) > before);
  h.voice.hear('wait');
  await until(() => h.phone.sent.some((m) => m.event === 'clear'));
  const media = h.phone.sent.filter((m) => m.event === 'media').length;
  h.voice.emit({ type: 'response.output_audio.delta', response_id: 'resp_2', delta: b64(160) });
  h.phone.raw(JSON.stringify({ event: 'mark', mark: { name: 'm99' } }));
  await h.voice.idle(); await sleep(30);
  assert.equal(h.phone.sent.filter((m) => m.event === 'media').length, media, 'nothing more is played after the clear');
  assert.ok(h.bridge.stats().marksLate >= 1);
});

test('interruption: through the bridge the cancel names the reply, the phone is cleared once, and the next line is spoken once with the Drew manner', async () => {
  const p = createPersona(drew);
  const h = harness({ realtime: { persona: p } });
  await live(h);
  const before = mediaSent(h);
  h.t.speak('This is a rather long reply that goes on and on so that the caller can talk over it before it is finished. '.repeat(3).trim(), true);
  await until(() => mediaSent(h) > before);
  h.voice.hear('excuse me');
  await until(() => h.kinds().includes('utterance'));
  h.t.speak('Sure, what is the address?', true);
  await until(() => h.voice.spoken.length >= 2);
  await h.voice.idle(); await h.phone.drained(); await sleep(30);
  const cancels = h.voice.received.filter((m) => m.type === 'response.cancel');
  assert.equal(cancels.length, 1);
  assert.equal(typeof cancels[0].response_id, 'string');
  assert.equal(h.phone.sent.filter((m) => m.event === 'clear').length, 1);
  assert.deepEqual(h.voice.spoken, [NOTICE, 'Sure, what is the address?'], 'the interrupted reply never finished and was not repeated');
  assert.ok(h.voice.received.filter((m) => m.type === 'response.create').every((m) => String(m.response.instructions).startsWith(`${SPEAK_ONLY} ${voiceManner(p)} `)), 'every request keeps the persona');
  assert.ok(!h.kinds().includes('reply_failed') && !h.kinds().includes('error'));
  assert.deepEqual(h.voice.refused.filter((r) => !r.startsWith('response.cancel of a reply')), []);
});

test('interruption: the consent notice is never cleared or cut off, even if the caller talks over it', async () => {
  const h = harness();
  h.phone.start();
  await until(() => h.voice.playing());
  h.voice.hear('yes yes');
  await until(() => h.kinds().includes('setup'));
  assert.ok(!h.phone.sent.some((m) => m.event === 'clear'));
  assert.equal(h.voice.spoken[0], NOTICE);
  assert.ok(!h.kinds().includes('utterance'), 'a yes given during the notice is not taken');
});

test('interruption: a line the caller must not talk over (not interruptible) is not cleared either', async () => {
  const h = harness();
  await live(h);
  const before = mediaSent(h);
  h.t.speak('Let me check what I have. Job description: burst pipe. Is that correct? Please say yes or no.', true, { interruptible: false });
  await until(() => mediaSent(h) > before);
  h.voice.hear('yes');
  await until(() => h.kinds().includes('utterance'));
  assert.ok(!h.phone.sent.some((m) => m.event === 'clear'));
  assert.equal(h.voice.settings().audio.input.turn_detection.interrupt_response, false);
});

// ================================================================ malformed input and limits
test('input: unreadable, mistyped, non-base64 and oversized caller frames are dropped and counted; nothing bad reaches the voice service', async () => {
  const h = harness();
  await live(h);
  h.phone.raw('not json');
  h.phone.raw(JSON.stringify({ event: 'media', media: { payload: '***not base64***' } }));
  h.phone.raw(JSON.stringify({ event: 'media', media: { payload: b64(2000) } }));
  h.phone.raw(JSON.stringify({ event: 'media', media: {} }));
  h.phone.raw(JSON.stringify([1, 2]));
  h.phone.raw(JSON.stringify({ event: 'dtmf', dtmf: { digit: '1' } }));
  await sleep(20);
  assert.equal(h.voice.appended(), 0);
  assert.equal(h.bridge.stats().audioBad, 5);
});

test('input: a damaged voice-service message is counted and handed on as unreadable, and an oversized one is dropped', async () => {
  const h = harness({ bridge: { maxVoiceChars: 5000 } });
  await live(h);
  h.voice.emitRaw('{broken');
  h.voice.emitRaw(JSON.stringify({ type: 'x', pad: 'a'.repeat(6000) }));
  await sleep(30);
  assert.equal(h.bridge.stats().voiceBad, 2);
  assert.ok(h.kinds().includes('malformed'));
});

test('limits: a voice socket that keeps refusing caller audio ends the call', async () => {
  const ok = { v: true };
  const h = harness({ voice: { accept: () => ok.v }, bridge: { maxRefused: 3 } });
  await live(h);
  ok.v = false;
  h.phone.frames(5);
  await until(() => h.closes.length > 0);
  assert.deepEqual(h.phone.closedWith, [1000]);
});

test('limits: a call is ended at the bridge\'s own ceiling whatever else happens', async () => {
  const h = harness({ bridge: { maxCallMs: 500 } });
  h.phone.start();
  await until(() => h.closes.length > 0);
  assert.deepEqual(h.phone.closedWith, [1000]);
  assert.deepEqual(h.voice.closedWith, [1000]);
});

test('limits: bridge options are validated', () => {
  const p = createWirePhone(); const v = createWireVoice();
  for (const bad of [{ maxCallMs: 0 }, { openWaitMs: 1.5 }, { maxFrameBytes: -1 }, { audioFormat: 'audio/pcm' as never }, { playGraceMs: 99_999_999 }]) {
    assert.throws(() => createRealtimeBridge(p, v, bad), RangeError, JSON.stringify(bad));
  }
});

// ================================================================ ending
test('ending: hanging up closes the phone stream and the voice socket, and nothing more is forwarded afterwards', async () => {
  const h = harness();
  await live(h);
  h.phone.frames(2);
  await until(() => h.voice.appended() === 2);
  assert.equal(h.t.endCall(), true);
  assert.deepEqual([h.phone.closedWith, h.voice.closedWith], [[1000], [1000]]);
  h.phone.frames(5); h.phone.start();
  await sleep(10);
  assert.equal(h.voice.appended(), 2);
  assert.deepEqual(h.closes[0], { cause: 'HANDLER', code: 1000 });
});

test('ending: the phone hanging up, or the voice service dropping, ends the call once and closes the other side', async () => {
  const a = harness(); await live(a);
  a.phone.stop();
  assert.deepEqual(a.closes, [{ cause: 'PEER', code: 1000 }]); assert.deepEqual(a.voice.closedWith, [1000]);
  const b = harness(); await live(b);
  b.voice.onClose();
  assert.deepEqual(b.closes, [{ cause: 'PEER', code: 1006 }]); assert.deepEqual(b.phone.closedWith, [1000]);
  b.phone.stop();
  assert.equal(b.closes.length, 1, 'ended once');
});

test('ending: a goodbye is played in full before the hang-up closes the stream', async () => {
  const h = harness();
  await live(h);
  const bye = 'Thank you for calling. Goodbye.';
  h.t.speak(bye, true);
  h.t.endCall();
  await until(() => h.closes.length > 0);
  assert.equal(h.voice.spoken[1], bye);
  const played = h.phone.sent.filter((m) => m.event === 'mark').length;
  assert.ok(played >= 1 && h.phone.closedWith.length === 1);
});

// ================================================================ the real call logic on top
function intakeModel(): ModelProvider {
  return {
    id: 'stub:bridge',
    async complete(req: ModelRequest) {
      const text = req.data.masked_text;
      if (req.task === 'classify_request') return { text: JSON.stringify({ category: /burst pipe|leak/i.test(text) ? 'Emergency leak' : null, confidence: 0.9 }) };
      const fields = (req.data.fields ?? []).map((f) => { const m = f.name === 'Job description' ? /burst pipe|leak/i.exec(text) : null; return { name: f.name, value: m ? m[0] : null, confidence: m ? 0.9 : null }; });
      return { text: JSON.stringify({ fields }) };
    },
  };
}
const OPENING = 'Hello, how can I help you today?';
const words: DialogueModel = { stats: { calls: 0, errors: [] }, async *reply(input) { const d = input.directive; yield d.kind === 'open' ? OPENING : d.kind === 'ask' ? `Could you tell me the ${d.field.toLowerCase()}?` : 'Okay, please go on.'; } };
let dbn = 0;
function callRig(h: { phone: ReturnType<typeof createWirePhone>; voice: ReturnType<typeof createWireVoice> }, numbers = new Map([[N1, T]])) {
  const store = createIntakeRecordStore({ path: join(dir, `calls${++dbn}.sqlite`) });
  closers.push(() => store.close());
  const logs: Array<{ code: string; detail?: Record<string, unknown> }> = [];
  const intake = createIntakeEntry({
    registry: createTenantRegistry({ [T]: plumbing }), channelRef: 'channel-founder-phone', now: () => '2026-10-26T12:00:00Z',
    provider: intakeModel(), limits: { maxOutputTokens: 1024, timeoutMs: 2000, maxAttempts: 1 }, founderTest: { tenant: T },
  });
  const handler = createRelayHandler({
    numbers, categoryNames: () => plumbing.categories.map((c: { name: string }) => c.name), intake,
    async intakeContext(tenant, ref) {
      const r = await mintExecutionContext({ credential: 'test', agent: 'intake' }, { verify: () => ({ kind: 'system', id: 'bridge-test' }), selectTenant: () => tenant, grants: () => ['intake:run'], newCorrelationId: () => `corr-${ref}` });
      if (!r.ok) throw new Error('context');
      return r.context;
    },
    dialogue: words, store, limits: { maxTurns: 30, maxMinutes: 8, maxChars: 4000 }, names: ['Sam Example'], maxCalls: 50,
    now: () => Date.now(), nowIso: () => '2026-10-26T12:00:00Z', killed: () => false, afterSpeechMs: 0, speechMs: () => 0, confirmWaitMs: 5000, previewBudgetMs: 3000,
    log: (code, detail) => { logs.push({ code, detail }); },
  });
  const call = startRealtimeCall(h.phone, h.voice, (t) => handler.serve(t), { notice: NOTICE, transcriptionModel: 'sim-transcriber', voice: 'sim-voice', msPerChar: MPC, endWaitMs: 500, persona: createPersona(drew) });
  return { handler, store, logs, call };
}

test('call logic: the full consent path over the connection, with the Drew persona on: notice, a yes, then the opening question, all heard in full', async () => {
  const h = { phone: createWirePhone(), voice: createWireVoice({ msPerChar: MPC }) };
  const r = callRig(h);
  h.phone.start();
  await until(() => h.voice.spoken.length >= 1);
  assert.equal(h.voice.spoken[0], NOTICE);
  await until(() => r.logs.some((l) => l.code === 'CALL_STARTED'));
  h.phone.frames(4); h.voice.hear('yes I agree');
  await until(() => h.voice.spoken.length >= 2);
  assert.equal(h.voice.spoken[1], OPENING);
  assert.ok(r.logs.some((l) => l.code === 'CONSENT_GRANTED'));
  h.phone.stop(); await r.handler.idle();
});

test('call logic: anything but a plain yes ends the call with the fixed goodbye, and nothing is kept or sent to a model', async () => {
  const h = { phone: createWirePhone(), voice: createWireVoice({ msPerChar: MPC }) };
  const r = callRig(h);
  h.phone.start();
  await until(() => r.logs.some((l) => l.code === 'CALL_STARTED'));
  h.voice.hear('no thank you');
  await until(() => h.phone.closedWith.length > 0);
  assert.equal(h.voice.spoken[1], SAY.declined, 'the goodbye is played in full before the stream is closed');
  await r.handler.idle();
  assert.equal(r.store.list(T).length, 0);
  assert.ok(!r.logs.some((l) => l.code === 'CONSENT_GRANTED'));
});

test('call logic: a number that is not on the list is refused (but hears the notice first: a known gap)', async () => {
  const h = { phone: createWirePhone(), voice: createWireVoice({ msPerChar: MPC }) };
  const r = callRig(h);
  h.phone.start({ to: '+15555550177' });
  await until(() => h.phone.closedWith.length > 0);
  assert.equal(h.voice.spoken[0], NOTICE, 'the gap: the notice is spoken before the number is checked');
  assert.equal(r.store.list(T).length, 0);
  assert.equal(h.voice.appended(), 0);
  await r.handler.idle();
});

test('call logic: a reply the phone never confirms is asked again, not treated as heard', async () => {
  const h = { phone: createWirePhone(), voice: createWireVoice({ msPerChar: MPC }) };
  const r = callRig(h);
  h.phone.start();
  await until(() => r.logs.some((l) => l.code === 'CALL_STARTED'));
  h.phone.muteMarks = true;
  h.voice.hear('yes I agree');
  await until(() => r.logs.some((l) => l.code === 'REPLY_NOT_PLAYED' || l.code === 'REPLY_SEND_FAILED' || l.code === 'REPLY_FALLBACK_SENT'), 8000);
  h.phone.stop(); await r.handler.idle();
});

// ================================================================ static guards
test('static: the bridge opens no connection, reads no environment, holds no key and imports no SDK; only the voice composition uses it, never the live Claude entry', () => {
  const code = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const own = code('realtime-bridge.ts');
  for (const bad of [/process\.env/, /\bfetch\s*\(/, /\bimport\s*\(/, /@anthropic-ai|from 'openai'|from "openai"/, /new\s+WebSocket/, /node:(net|http|https|tls|dgram)/, /console\./, /\bpersona\b|createPersona|isPersona/i, /api[_-]?key|secret|authorization|bearer/i]) {
    assert.ok(!bad.test(own), String(bad));
  }
  for (const f of readdirSync(new URL('../src/', import.meta.url)).filter((x) => x.endsWith('.ts') && x !== 'realtime-bridge.ts' && x !== 'openai-voice-socket.ts')) {   // the voice socket names the bridge's VoiceSocket type only
    assert.equal(/realtime-bridge/.test(code(f)), f === 'founder-voice-service.ts', `${f}: only the voice service (not the live Claude entry) may use the bridge`);
  }
});
