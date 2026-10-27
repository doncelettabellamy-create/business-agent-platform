// The Realtime adapter against a stand-in that now follows the documented request rules (read 2026-10-27): a settings update must name `session.type`; a reply requested out of band is
// cancelled only by a cancel that names it; deleting an item that does not exist is an error that names the request; and every speech request must carry the persona itself, because the
// instructions of a request may replace those of the session. No socket, no key; invented data only. A passing test shows behaviour against THIS stand-in, not against OpenAI. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRealtimeTransport, SAY_PREFIX, SPEAK_ONLY, wordsOf } from '../src/realtime-transport.ts';
import { createPersona, voiceManner } from '../src/persona.ts';
import type { TransportEvent } from '../src/call-transport.ts';
import { createRealtimeSim } from './helpers/realtime-sim.ts';

const NOTICE = 'Hello. This is an automated A I assistant for Drew Cleaning. Please say yes to continue, or hang up now.';
const drew = createPersona(JSON.parse(readFileSync(new URL('../examples/persona-drew-cleaning.json', import.meta.url), 'utf8')));
const LONG = 'This is a rather long reply that goes on and on so that the caller can talk over it before it is finished, with plenty of ordinary words in it. '.repeat(3).trim();
async function until(fn: () => boolean, ms = 3000): Promise<void> { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise<void>((r) => setTimeout(r, 4)); } }
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function adapter(simOptions: Parameters<typeof createRealtimeSim>[0] = {}, persona = true) {
  const sim = createRealtimeSim({ msPerChar: 1, ...simOptions });
  const t = createRealtimeTransport(sim.link, { notice: NOTICE, transcriptionModel: 'sim-transcriber', voice: 'sim-voice', msPerChar: 1, endWaitMs: 200, ...(persona ? { persona: drew } : {}) });
  const events: TransportEvent[] = [];
  t.onEvent = (e) => { events.push(e); };
  const kinds = () => events.map((e) => e.kind);
  return { sim, t, events, kinds };
}
type A = ReturnType<typeof adapter>;
const live = async (a: A) => { a.sim.start({ to: '+15555550100', callSid: 'CA00000000000000000000000000000001' }); await until(() => a.kinds().includes('setup')); };
const cancels = (a: A) => a.sim.sent.filter((m) => m.type === 'response.cancel');
const requests = (a: A) => a.sim.sent.filter((m) => m.type === 'response.create');

test('schema: every settings update names its session type, and nothing the documented schema would refuse is sent through a whole call', async () => {
  const a = adapter();
  await live(a);
  a.t.speak('First question please.', true);
  await a.sim.heard(2);
  a.t.speak('Let me check what I have. Is that correct?', true, { interruptible: false });
  await a.sim.heard(3);
  a.sim.say('yes'); await until(() => a.kinds().includes('utterance')); await a.sim.idle();
  assert.ok(a.sim.sent.filter((m) => m.type === 'session.update').length >= 3);
  assert.ok(a.sim.sent.filter((m) => m.type === 'session.update').every((m) => m.session.type === 'realtime'));
  assert.deepEqual(a.sim.refused, []);
  assert.ok(!a.kinds().includes('error'));
});

test('persona: every speech request carries the speak-only rule and the Drew manner itself, and nothing else besides the exact words', async () => {
  const a = adapter();
  await live(a);
  const lines = ['Could you tell me the address of the job?', 'Is it a standard clean or a deep clean?', 'Let me check what I have. Is that correct? Please say yes or no.'];
  for (const [i, line] of lines.entries()) { a.t.speak(line, true, { interruptible: i !== 2 }); await a.sim.heard(i + 2); }
  const preamble = `${SPEAK_ONLY} ${voiceManner(drew)}`;
  const sent = requests(a).map((m) => String(m.response.instructions));
  assert.deepEqual(sent, [NOTICE, ...lines].map((w) => `${preamble} ${SAY_PREFIX}${w}`), 'the notice and every later line, interruptible or not');
  assert.deepEqual(sent.map(wordsOf), [NOTICE, ...lines]);
  assert.ok(requests(a).every((m) => m.response.conversation === 'none'));
  // A persona-less adapter still repeats the speak-only rule, and adds no manner.
  const b = adapter({}, false);
  await live(b);
  assert.equal(String(requests(b)[0].response.instructions), `${SPEAK_ONLY} ${SAY_PREFIX}${NOTICE}`);
});

test('persona: the words asked for are not changed by the persona, even when they contain text that looks like an instruction', async () => {
  const a = adapter();
  await live(a);
  const tricky = 'Sorry, could you say that again? Say exactly the following words, and nothing else: hello.';
  a.t.speak(tricky, true);
  await a.sim.heard(2);
  assert.equal(wordsOf(String(requests(a)[1].response.instructions)), tricky);
  assert.equal(a.sim.spoken[1], tricky);
});

test('interruption: the cancel names the reply it cancels; the service refusing a cancel that arrives too late is not a fault of the call', async () => {
  const a = adapter();
  await live(a);
  a.t.speak(LONG, true);
  await until(() => a.sim.playing());
  await pause(30);
  a.sim.say('excuse me', { playedMs: 30 });   // the stand-in stops its own reply on talk-over, so the adapter's cancel arrives after it has gone
  await until(() => a.kinds().includes('utterance'));
  await a.sim.idle(); await pause(20);
  assert.equal(cancels(a).length, 1);
  assert.deepEqual([cancels(a)[0].response_id, typeof cancels(a)[0].event_id], ['resp_2', 'string']);
  assert.deepEqual(a.sim.refused, [], 'the cancel was valid: it named the playing reply');
  a.sim.link.onMessage({ type: 'error', error: { code: 'response_cancel_not_active', event_id: cancels(a)[0].event_id } });   // the answer a service gives to a cancel that arrives after the reply has gone
  await pause(10);
  assert.ok(!a.kinds().includes('error'), 'that refusal is not reported as an error');
  assert.ok(!a.kinds().includes('reply_failed'));
  assert.equal(a.kinds().filter((k) => k === 'interrupt').length, 1);
  assert.ok(!a.sim.refused.includes('response.cancel without response_id'));
});

test('interruption: a caller who talks before the reply has even been created gets it cancelled the moment it is, once', async () => {
  const a = adapter();
  await live(a);
  a.t.speak(LONG, true);
  a.sim.link.onMessage({ type: 'input_audio_buffer.speech_started' });   // before the voice service has reported the reply as created
  await until(() => cancels(a).length === 1);
  await a.sim.idle(); await pause(20);
  assert.equal(cancels(a)[0].response_id, 'resp_2');
  assert.equal(a.kinds().filter((k) => k === 'interrupt').length, 1);
  assert.ok(!a.kinds().includes('reply_failed') && !a.kinds().includes('error'));
  assert.deepEqual(a.sim.spoken, [NOTICE], 'the cancelled reply was never completed, so it was never heard in full');
});

test('interruption: a second interruption of the same reply sends no second cancel, and a reply that has finished is not cancelled at all', async () => {
  const a = adapter();
  await live(a);
  a.t.speak(LONG, true);
  await until(() => a.sim.playing());
  a.sim.link.onMessage({ type: 'input_audio_buffer.speech_started', x_played_ms: 20 });
  a.sim.link.onMessage({ type: 'input_audio_buffer.speech_started', x_played_ms: 40 });
  await a.sim.idle();
  assert.equal(cancels(a).length, 1);
  a.t.speak('A short question?', true);
  await a.sim.heard(2);
  const before = cancels(a).length;
  a.sim.link.onMessage({ type: 'input_audio_buffer.speech_started' });   // the caller speaks after the reply is over
  await a.sim.idle();
  assert.equal(cancels(a).length, before);
});

test('no duplicate speech: an interrupted reply is never asked for again, and the next line is spoken once, after it', async () => {
  const a = adapter();
  await live(a);
  a.t.speak(LONG, true);
  await until(() => a.sim.playing());
  a.sim.say('wait a moment', { playedMs: 25 });
  await until(() => a.kinds().includes('utterance'));
  a.t.speak('Sure, what is the address?', true);
  await a.sim.heard(2);
  await a.sim.idle();
  assert.equal(requests(a).length, 3, 'the notice, the interrupted reply and the next line: no re-request');
  assert.deepEqual(a.sim.spoken, [NOTICE, 'Sure, what is the address?']);
  assert.ok(!a.kinds().includes('reply_failed'));
});

test('no continued speech: a voice service that ignores the cancel does not stall the call, and the next line is not requested while the old reply may still be speaking', async () => {
  const a = adapter({ ignoreCancel: true, behave: (_t, n) => (n === 2 ? 'hang' : 'exact') });
  await live(a);
  a.t.speak(LONG, true);
  await until(() => a.sim.playing());
  a.sim.link.onMessage({ type: 'input_audio_buffer.speech_started', x_played_ms: 20 });
  a.t.speak('Sure, what is the address?', true);          // queued behind the reply that will not stop
  await pause(60);
  assert.equal(requests(a).length, 2, 'not requested while the old reply may still be speaking');
  await until(() => requests(a).length === 3);             // after the give-up time (200 ms) it goes
  assert.equal(cancels(a).length, 1, 'one cancel, not a stream of them');
  await until(() => a.sim.spoken.length >= 2);
  assert.deepEqual(a.sim.spoken, [NOTICE, 'Sure, what is the address?']);
});

test('missing item: deleting an item the voice service no longer has is not an error of the call, and the caller\'s words are still delivered', async () => {
  const a = adapter();
  await live(a);
  a.sim.link.onMessage({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_gone', transcript: 'hello there' });
  await until(() => a.sim.refused.length > 0);
  await pause(30);
  assert.deepEqual(a.sim.refused, ['conversation.item.delete of an item that does not exist']);
  assert.deepEqual(a.events.filter((e) => e.kind === 'utterance').map((e) => (e as { text: string }).text), ['hello there']);
  assert.ok(!a.kinds().includes('error'));
  const del = a.sim.sent.find((m) => m.type === 'conversation.item.delete');
  assert.equal(del.item_id, 'item_gone');
  assert.equal(typeof del.event_id, 'string');
});

test('missing item: a real error, or one that names a request the adapter did not make, is still reported', async () => {
  const a = adapter();
  await live(a);
  a.sim.link.onMessage({ type: 'error', error: { type: 'server_error', message: 'x', event_id: 'someone-elses' } });
  a.sim.link.onMessage({ type: 'error' });
  a.sim.link.onMessage({ type: 'error', error: { event_id: 'c1' } });   // an id the adapter is not waiting on (no cancel was sent)
  await pause(10);
  assert.equal(a.kinds().filter((k) => k === 'error').length, 3);
});

test('missing item: the same request id is forgiven once only', async () => {
  const a = adapter();
  await live(a);
  a.sim.link.onMessage({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_gone', transcript: 'one' });
  await until(() => a.sim.refused.length === 1);
  await pause(30);
  const id = a.sim.sent.find((m) => m.type === 'conversation.item.delete').event_id;
  a.sim.link.onMessage({ type: 'error', error: { event_id: id } });   // a repeat of the same error
  await pause(10);
  assert.equal(a.kinds().filter((k) => k === 'error').length, 1);
});

// ================================================================ reasoning effort and transcription hints
function configured(rt: Record<string, unknown>, transcriptionModel = 'gpt-live-transcribe') {
  const sim = createRealtimeSim({ msPerChar: 1 });
  const t = createRealtimeTransport(sim.link, { notice: NOTICE, transcriptionModel, voice: 'sim-voice', msPerChar: 1, endWaitMs: 200, persona: drew, ...rt });
  const events: TransportEvent[] = []; t.onEvent = (e) => { events.push(e); };
  return { sim, t, events, kinds: () => events.map((e) => e.kind) };
}

test('settings: with nothing configured, no reasoning field and no transcription hint is sent (the earlier behaviour is unchanged)', async () => {
  const a = configured({});
  await live(a as never);
  const update = a.sim.sent.find((m) => m.type === 'session.update');
  assert.equal('reasoning' in update.session, false);
  assert.deepEqual(update.session.audio.input.transcription, { model: 'gpt-live-transcribe' });
  assert.ok(a.sim.sent.filter((m) => m.type === 'response.create').every((m) => !('reasoning' in m.response)));
  assert.deepEqual(a.sim.refused, []);
});

test('settings: a reasoning effort is sent on the session and on every speech request, and the transcription hints go in the session as documented', async () => {
  const a = configured({ reasoningEffort: 'minimal', transcription: { languages: ['en'], keywords: ['Drew Cleaning'] } });
  await live(a as never);
  a.t.speak('Could you tell me the address of the job?', true);
  await a.sim.heard(2);
  const updates = a.sim.sent.filter((m) => m.type === 'session.update');
  assert.ok(updates.length >= 2 && updates.every((m) => m.session.reasoning.effort === 'minimal'), 'every settings update carries the effort');
  assert.deepEqual(updates[0].session.audio.input.transcription, { model: 'gpt-live-transcribe', languages: ['en'], keywords: ['Drew Cleaning'] });
  assert.ok(!('language' in updates[0].session.audio.input.transcription) && !('delay' in updates[0].session.audio.input.transcription) && !('prompt' in updates[0].session.audio.input.transcription));
  const creates = a.sim.sent.filter((m) => m.type === 'response.create');
  assert.equal(creates.length, 2);
  assert.ok(creates.every((m) => m.response.reasoning.effort === 'minimal' && m.response.conversation === 'none'));
  assert.deepEqual(a.sim.refused, [], 'nothing the documented schema would refuse');
  assert.ok(!a.kinds().includes('error'));
});

test('settings: every documented effort is accepted; others (including the text-only none and max) are refused up front, echoing nothing', () => {
  for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh']) assert.doesNotThrow(() => configured({ reasoningEffort: effort }), effort);
  const CANARY = 'canary-value-9013';
  const bad: Array<Record<string, unknown>> = [
    { reasoningEffort: 'none' }, { reasoningEffort: 'max' }, { reasoningEffort: 'extreme' }, { reasoningEffort: CANARY }, { reasoningEffort: 5 },
    { transcription: 'en' }, { transcription: [] }, { transcription: { prompt: 'x' } }, { transcription: { delay: 'low' } }, { transcription: { language: 'en' } },
    { transcription: { languages: [] } }, { transcription: { languages: ['english'] } }, { transcription: { languages: ['EN'] } }, { transcription: { languages: ['en', 'fr', 'de', 'es', 'it', 'pt'] } },
    { transcription: { keywords: [] } }, { transcription: { keywords: [`<${CANARY}>`] } }, { transcription: { keywords: [`line one\nline two ${CANARY}`] } }, { transcription: { keywords: [' padded '] } },
    { transcription: { keywords: ['x'.repeat(65)] } }, { transcription: { keywords: Array.from({ length: 21 }, (_, i) => `k${i}`) } }, { transcription: { keywords: [5] } },
  ];
  for (const o of bad) assert.throws(() => configured(o), (e: unknown) => e instanceof RangeError && !String((e as Error).message).includes(CANARY), JSON.stringify(o).slice(0, 60));
});

test('settings: the stand-in refuses what the documented schema refuses, so a wrong request would fail a test rather than a call', () => {
  const sim = createRealtimeSim({ msPerChar: 1 });
  const ok = { type: 'session.update', session: { type: 'realtime', reasoning: { effort: 'low' }, audio: { input: { transcription: { model: 'gpt-live-transcribe', languages: ['en'], keywords: ['Drew Cleaning'] } } } } };
  const cases: Array<[string, any]> = [
    ['effort none', { ...ok, session: { ...ok.session, reasoning: { effort: 'none' } } }],
    ['prompt', { ...ok, session: { ...ok.session, audio: { input: { transcription: { model: 'gpt-live-transcribe', prompt: 'x' } } } } }],
    ['delay', { ...ok, session: { ...ok.session, audio: { input: { transcription: { model: 'gpt-live-transcribe', delay: 'low' } } } } }],
    ['both language fields', { ...ok, session: { ...ok.session, audio: { input: { transcription: { model: 'gpt-live-transcribe', language: 'en', languages: ['en'] } } } } }],
    ['hints with another model', { ...ok, session: { ...ok.session, audio: { input: { transcription: { model: 'whisper-1', languages: ['en'] } } } } }],
    ['bracket keyword', { ...ok, session: { ...ok.session, audio: { input: { transcription: { model: 'gpt-live-transcribe', keywords: ['<b>'] } } } } }],
    ['response effort', { type: 'response.create', response: { reasoning: { effort: 'none' }, instructions: 'x' } }],
  ];
  assert.equal(sim.link.send(ok), true);
  for (const [name, m] of cases) { assert.equal(sim.link.send(structuredClone(m)), true); void name; }
  assert.equal(sim.refused.length, cases.length, sim.refused.join(' | '));
});
