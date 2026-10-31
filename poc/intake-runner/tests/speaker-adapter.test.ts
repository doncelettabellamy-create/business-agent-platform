// The OFFLINE speaker adapter (src/speaker-adapter.ts) with a STAND-IN speech source (tests/helpers/speaker-stand-in.ts) and a stand-in for the OpenAI voice socket. Part 1 runs the adapter on its own;
// part 2 runs it behind the EXISTING bridge and transport (src/realtime-bridge.ts, src/realtime-transport.ts) against the wire-level phone and voice stand-ins. No socket, no network, no key, no provider;
// invented data only. A passing test shows behaviour against THESE models only. It does not show how a real provider sounds or behaves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APPROVED_SPEAKER_MODELS, JACK_SPEAKER, speakerSettingsProblems, withSpeaker } from '../src/speaker-adapter.ts';
import type { SpeakerOptions, SpeakerSocket, SpeakerSplice } from '../src/speaker-adapter.ts';
import { createRealtimeBridge } from '../src/realtime-bridge.ts';
import { createRealtimeTransport, SAY_PREFIX, SPEAK_ONLY, wordsOf } from '../src/realtime-transport.ts';
import type { TransportEvent } from '../src/call-transport.ts';
import { createWirePhone, createWireVoice } from './helpers/realtime-wire-sim.ts';
import { createStandInSource } from './helpers/speaker-stand-in.ts';
import type { StandInBehaviour, StandInOptions } from './helpers/speaker-stand-in.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 4000): Promise<void> { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await sleep(4); } }
const NOTICE = 'Hello. This is an automated A I assistant for Example Cleaning. Please say yes to continue, or hang up now.';
const LINE = 'Let me check what I have. Property type: house. Please say yes or no. Is that correct?';

// ================================================================ part 1: the adapter on its own
type OpenAiMode = 'ok' | 'silent' | 'fail' | 'stall' | 'empty-done' | 'slow-created';
interface FakeOpenAi { speak?: OpenAiMode; sendFails?: boolean; createdDelayMs?: number; keepSendingAfterCancel?: boolean }
/** A stand-in for the OpenAI voice socket. It records everything it is sent and, when asked to speak a line (the adapter's fallback), answers like the voice service would. */
function fakeVoice(o: FakeOpenAi = {}) {
  const sent: any[] = []; const closed: Array<number | undefined> = []; const cancelled = new Set<string>(); let n = 0; let spoke = 0;
  const v: SpeakerSocket & { sent: any[]; closed: Array<number | undefined>; cancelled: Set<string>; spoke(): number } = {
    sent, closed, cancelled, spoke: () => spoke,
    send(t: string) {
      const m = JSON.parse(t); sent.push(m);
      if (m.type === 'response.create') { if (o.sendFails === true) return false; respond(m); }
      if (m.type === 'response.cancel' && typeof m.response_id === 'string') cancelled.add(m.response_id);
      return true;
    },
    close(c?: number) { closed.push(c); }, onOpen: () => {}, onMessage: () => {}, onClose: () => {},
  };
  function say(msg: unknown): void { v.onMessage(JSON.stringify(msg)); }
  function respond(m: any): void {
    const id = `oai_${++n}`; const mid = m.response.metadata.id as string; const text = wordsOf(String(m.response.instructions)); const mode = o.speak ?? 'ok';
    setTimeout(() => {
      say({ type: 'response.created', response: { id, metadata: { id: mid } } });
      if (mode === 'silent') return;
      if (mode === 'fail') { say({ type: 'response.done', response: { id, status: 'failed', metadata: { id: mid } } }); return; }
      if (mode === 'empty-done') { say({ type: 'response.done', response: { id, status: 'completed', metadata: { id: mid } } }); return; }
      const pieces = mode === 'stall' ? 2 : 6; let k = 0;
      const step = (): void => {
        if (cancelled.has(id) && o.keepSendingAfterCancel !== true) return;
        if (k < pieces) { say({ type: 'response.output_audio.delta', response_id: id, delta: Buffer.alloc(800, 0x7f).toString('base64') }); k++; setTimeout(step, 6); return; }
        if (mode === 'stall') return;
        say({ type: 'response.output_audio_transcript.done', response_id: id, transcript: text });
        say({ type: 'response.done', response: { id, status: 'completed', metadata: { id: mid } } });
        spoke++;
      };
      setTimeout(step, 2);
    }, mode === 'slow-created' ? (o.createdDelayMs ?? 80) : 1);
  }
  return v;
}
function rig(o: { source?: StandInOptions; opts?: SpeakerOptions; openai?: FakeOpenAi } = {}) {
  const inner = fakeVoice(o.openai); const source = createStandInSource(o.source);
  const diagLines: Array<{ code: string; [k: string]: unknown }> = [];
  const sp = withSpeaker(inner, source, JACK_SPEAKER, { diag: (code, detail) => { diagLines.push({ code, ...detail }); }, endDelayMs: 40, ...o.opts });
  const events: any[] = []; sp.onMessage = (t: string) => { events.push(JSON.parse(t)); };
  let closedBy = 0; sp.onClose = () => { closedBy++; };
  return { inner, source, sp, events, diagLines, closes: () => closedBy };
}
const create = (text: string, mid = 'r1', eventId?: string): string => JSON.stringify({ type: 'response.create', ...(eventId === undefined ? {} : { event_id: eventId }), response: { conversation: 'none', output_modalities: ['audio'], instructions: `${SPEAK_ONLY} ${SAY_PREFIX}${text}`, metadata: { id: mid } } });
const cancelMsg = (rid: string, eventId = 'c1'): string => JSON.stringify({ type: 'response.cancel', response_id: rid, event_id: eventId });
const typesOf = (e: any[]) => e.map((x) => x.type);
const ridOf = (e: any[]): string => e.find((x) => x.type === 'response.created').response.id;
const doneOf = (e: any[]) => e.filter((x) => x.type === 'response.done');
const deltaBytes = (e: any[]): number => e.filter((x) => x.type === 'response.output_audio.delta').reduce((n, x) => n + Buffer.from(x.delta, 'base64').length, 0);
const creates = (inner: { sent: any[] }) => inner.sent.filter((m) => m.type === 'response.create');
const failedWhy = (diag: Array<{ code: string; [k: string]: unknown }>) => diag.find((d) => d.code === 'SPEAKER_FAILED')?.why;

test('settings: Jack, Flash v2.5, speed 0.95, mu-law 8 kHz are the only accepted candidate; anything else is refused before a call', () => {
  assert.deepEqual({ ...JACK_SPEAKER }, { provider: 'elevenlabs', voiceId: '7EzWGsX10sAS4c9m9cPf', modelId: 'eleven_flash_v2_5', speed: 0.95, outputFormat: 'ulaw_8000' });
  assert.ok(Object.isFrozen(JACK_SPEAKER));
  assert.deepEqual(speakerSettingsProblems(JACK_SPEAKER), []);
  assert.deepEqual([...APPROVED_SPEAKER_MODELS], ['eleven_flash_v2_5']);
  for (const bad of [
    { ...JACK_SPEAKER, voiceId: 'short' }, { ...JACK_SPEAKER, voiceId: '7EzWGsX10sAS4c9m9cP!' }, { ...JACK_SPEAKER, modelId: 'eleven_v3' }, { ...JACK_SPEAKER, modelId: 'eleven_multilingual_v2' },
    { ...JACK_SPEAKER, speed: 0.5 }, { ...JACK_SPEAKER, speed: 1.5 }, { ...JACK_SPEAKER, speed: Number.NaN }, { ...JACK_SPEAKER, outputFormat: 'mp3_44100_128' }, { ...JACK_SPEAKER, provider: 'openai' },
    { ...JACK_SPEAKER, extra: true }, null, 'x',
  ]) {
    assert.notDeepEqual(speakerSettingsProblems(bad), [], JSON.stringify(bad));
    assert.throws(() => withSpeaker(fakeVoice(), createStandInSource(), bad as never), RangeError);
  }
  assert.throws(() => withSpeaker(fakeVoice(), {} as never, JACK_SPEAKER), RangeError);
  assert.throws(() => withSpeaker(fakeVoice(), createStandInSource(), JACK_SPEAKER, { firstAudioMs: 0 }), RangeError);
  assert.throws(() => withSpeaker(fakeVoice(), createStandInSource(), JACK_SPEAKER, { fallbackFirstAudioMs: 0 }), RangeError);
  assert.throws(() => withSpeaker(fakeVoice(), createStandInSource(), JACK_SPEAKER, { endDelayMs: -1 }), RangeError);
});

test('a line is spoken by the source and answered as the voice service would: created, audio, the requested words as the transcript, done; OpenAI is not asked to speak', async () => {
  const r = rig();
  assert.equal(r.sp.send(create(LINE)), true);
  await until(() => doneOf(r.events).length === 1);
  const types = typesOf(r.events);
  assert.equal(types[0], 'response.created');
  assert.deepEqual(types.slice(-2), ['response.output_audio_transcript.done', 'response.done']);
  assert.ok(types.slice(1, -2).every((t) => t === 'response.output_audio.delta') && types.length > 3);
  const rid = ridOf(r.events);
  assert.ok(r.events.filter((e) => e.type === 'response.output_audio.delta').every((e) => e.response_id === rid && Buffer.from(e.delta, 'base64').length <= 1600));
  assert.equal(r.events.at(-2).transcript, LINE, 'the transcript is the requested words');
  assert.deepEqual([doneOf(r.events)[0].response.status, doneOf(r.events)[0].response.id, doneOf(r.events)[0].response.metadata], ['completed', rid, { id: 'r1' }]);
  assert.equal(deltaBytes(r.events), r.source.emitted() * 800, 'every byte the source produced reached the bridge, in order');
  assert.deepEqual(r.source.requests, [{ text: LINE, voiceId: '7EzWGsX10sAS4c9m9cPf', modelId: 'eleven_flash_v2_5', speed: 0.95, outputFormat: 'ulaw_8000' }], 'the source is asked for exactly the words, with the candidate settings');
  assert.equal(creates(r.inner).length + r.inner.sent.filter((m) => m.type === 'response.cancel').length, 0, 'the voice service is never asked to speak when the source works');
  assert.deepEqual([r.sp.stats().replies, r.sp.stats().completed, r.sp.stats().failed, r.sp.stats().fallbacks, r.sp.stats().callEnds], [1, 1, 0, 0, 0]);
});

test('cancellation: a cancel stops the source, answers cancelled, and every late piece (arriving or already queued) is dropped and counted', async () => {
  const slow = rig({ source: { msPerChar: 50, gapMs: 15, keepEmittingAfterCancel: true } });
  slow.sp.send(create(LINE));
  await until(() => slow.events.filter((e) => e.type === 'response.output_audio.delta').length >= 2);
  const rid = ridOf(slow.events);
  slow.sp.send(cancelMsg(rid));
  await until(() => doneOf(slow.events).length === 1);
  assert.equal(doneOf(slow.events)[0].response.status, 'cancelled');
  const deltasAtCancel = slow.events.filter((e) => e.type === 'response.output_audio.delta').length;
  await sleep(250);
  assert.equal(slow.events.filter((e) => e.type === 'response.output_audio.delta').length, deltasAtCancel, 'nothing is delivered after the cancel');
  assert.equal(slow.events.filter((e) => e.type === 'response.output_audio_transcript.done').length, 0, 'a cancelled line has no transcript');
  assert.equal(slow.source.cancelled(), 1);
  assert.ok(slow.source.lateEmitted() > 0 && slow.sp.stats().lateDropped >= slow.source.lateEmitted(), 'the source kept sending and the adapter dropped every piece');
  assert.equal(creates(slow.inner).length, 0, 'a cancel never starts the fallback');
  // Pieces already QUEUED for delivery when the cancel comes are dropped too.
  const burst = rig({ source: { behave: () => 'burst' } });
  burst.sp.send(create(LINE));
  burst.sp.send(cancelMsg('spk_1'));
  await until(() => doneOf(burst.events).length === 1);
  assert.deepEqual(typesOf(burst.events), ['response.created', 'response.done']);
  assert.equal(doneOf(burst.events)[0].response.status, 'cancelled');
  assert.ok(burst.sp.stats().lateDropped >= 5);
  // A cancel of a reply that already ended gets the error the voice service gives, with the request's event id (the transport tolerates exactly this).
  const done = rig();
  done.sp.send(create(LINE)); await until(() => doneOf(done.events).length === 1);
  done.sp.send(cancelMsg(ridOf(done.events), 'c9'));
  await until(() => done.events.some((e) => e.type === 'error'));
  const err = done.events.find((e) => e.type === 'error');
  assert.deepEqual([err.error.code, err.error.event_id], ['response_cancel_not_active', 'c9']);
  assert.equal(doneOf(done.events).length, 1, 'no second done');
  done.sp.send(JSON.stringify({ type: 'response.cancel', event_id: 'c10' }));
  await until(() => done.events.filter((e) => e.type === 'error').length === 2);
});

// ---------------------------------------------------------------- the first-test fallback rule: OpenAI may take over ONLY if zero source audio was handed on
test('fallback: when the source fails with zero audio handed on, OpenAI speaks the SAME line as one reply (one id, OpenAI\'s audio and its own transcript), the source is stopped, and the next line goes to the source again', async () => {
  const cases: Array<[StandInBehaviour, string]> = [['fail-start', 'START_FAILED'], ['never', 'NO_AUDIO'], [{ failAfter: 0 }, 'SOURCE_ERROR'], ['empty', 'EMPTY'], ['bad-audio', 'BAD_AUDIO'], ['huge', 'BAD_AUDIO']];
  for (const [b, why] of cases) {
    const r = rig({ source: { behave: (_q, n) => (n === 1 ? b : 'ok') }, opts: { firstAudioMs: 60 } });
    r.sp.send(create(LINE, 'r1', 'e1'));
    await until(() => doneOf(r.events).length === 1);
    const rid = ridOf(r.events);
    assert.deepEqual(typesOf(r.events).filter((t) => t === 'response.created').length, 1, `${why}: one reply id`);
    assert.equal(doneOf(r.events)[0].response.status, 'completed', why);
    assert.deepEqual([doneOf(r.events)[0].response.id, doneOf(r.events)[0].response.metadata], [rid, { id: 'r1' }], why);
    assert.ok(r.events.filter((e) => e.type === 'response.output_audio.delta').every((e) => e.response_id === rid), why);
    assert.equal(deltaBytes(r.events), 6 * 800, `${why}: the audio is OpenAI's, none of the source's`);
    assert.equal(r.events.find((e) => e.type === 'response.output_audio_transcript.done').transcript, LINE, `${why}: OpenAI's own transcript is relayed`);
    assert.equal(creates(r.inner).length, 1, why);
    assert.equal(JSON.parse(JSON.stringify(creates(r.inner)[0])).response.metadata.id, 'r1');
    assert.equal(wordsOf(String(creates(r.inner)[0].response.instructions)), LINE, `${why}: the same words`);
    assert.ok(r.diagLines.some((d) => d.code === 'SPEAKER_FALLBACK' && d.why === why), why);
    assert.ok(!r.events.some((e) => e.type === 'x_speaker_down') && r.closes() === 0 && r.inner.closed.length === 0, `${why}: the call goes on`);
    assert.equal(r.source.cancelled(), b === 'fail-start' ? 0 : 1, `${why}: the failed source request was stopped (a source that never started has nothing to stop)`);
    r.sp.send(create(LINE, 'r2'));
    await until(() => doneOf(r.events).length === 2);
    assert.equal(doneOf(r.events)[1].response.status, 'completed');
    assert.equal(r.source.started(), 2, `${why}: the next line went to the source again`);
    assert.equal(creates(r.inner).length, 1, `${why}: and OpenAI was not asked again`);
    assert.deepEqual([r.sp.stats().fallbacks, r.sp.stats().failed, r.sp.stats().callEnds], [1, 0, 0], why);
  }
  // A line that is too long for the adapter has no source audio either: OpenAI speaks it.
  const wordy = rig({ opts: { maxChars: 20 } });
  wordy.sp.send(create(LINE)); await until(() => doneOf(wordy.events).length === 1);
  assert.deepEqual([doneOf(wordy.events)[0].response.status, wordy.source.started(), creates(wordy.inner).length], ['completed', 0, 1]);
});

test('late audio: pieces the failed source still delivers after the fallback began are dropped, and OpenAI events that do not belong to the fallback reply are dropped', async () => {
  const r = rig({ source: { behave: () => ({ failAfter: 0 }), keepEmittingAfterCancel: true, gapMs: 5 } });
  r.sp.send(create(LINE));
  await until(() => doneOf(r.events).length === 1);
  await sleep(120);
  assert.equal(deltaBytes(r.events), 6 * 800, 'only the fallback\'s audio reached the bridge');
  // An event of some other reply, and a stray audio piece, are dropped.
  const before = r.events.length;
  r.inner.onMessage(JSON.stringify({ type: 'response.output_audio.delta', response_id: 'oai_other', delta: 'AAAA' }));
  r.inner.onMessage(JSON.stringify({ type: 'response.done', response: { id: 'oai_other', status: 'completed' } }));
  await sleep(20);
  assert.equal(r.events.length, before);
  assert.ok(r.sp.stats().fromVoiceDropped >= 2);
});

// ---------------------------------------------------------------- once source audio has been handed on there is no fallback: the call ends within a defined time
test('the source fails AFTER audio started: no fallback, the line is answered failed with no transcript, the call logic is told, and the voice socket is closed within the delay; no later line is spoken', async () => {
  for (const [b, why] of [[{ failAfter: 2 }, 'SOURCE_ERROR'], [{ stallAfter: 2 }, 'STALLED']] as Array<[StandInBehaviour, string]>) {
    const r = rig({ source: { behave: () => b }, opts: { gapMs: 60 } });
    const t0 = Date.now();
    r.sp.send(create(LINE, 'r1'));
    await until(() => r.closes() === 1);
    assert.ok(deltaBytes(r.events) > 0, `${why}: some audio had been handed on`);
    assert.deepEqual(creates(r.inner), [], `${why}: OpenAI is not asked to take over`);
    const done = doneOf(r.events);
    assert.deepEqual([done.length, done[0].response.status], [1, 'failed'], why);
    assert.equal(r.events.filter((e) => e.type === 'response.output_audio_transcript.done').length, 0, `${why}: a failed line has no transcript, so it never counts as heard`);
    const order = typesOf(r.events);
    assert.ok(order.indexOf('response.done') < order.indexOf('x_speaker_down'), `${why}: the line is reported failed, then the call logic is told`);
    assert.deepEqual(r.inner.closed, [1011]);
    assert.ok(Date.now() - t0 < 60 + 40 + 400, `${why}: within the defined time (gap bound + end delay)`);
    assert.equal(failedWhy(r.diagLines), why);
    assert.ok(r.diagLines.some((d) => d.code === 'SPEAKER_CALL_END'));
    assert.equal(r.sp.send(create(LINE, 'r2')), false, 'no further line is spoken');
    assert.deepEqual([r.sp.stats().failed, r.sp.stats().callEnds, r.sp.stats().fallbacks], [1, 1, 0], why);
  }
});

test('the fallback FAILS: OpenAI errors, sends no audio in time, stalls, completes empty, or cannot be asked - the line fails with no transcript and the call ends within the defined time', async () => {
  const cases: Array<[OpenAiMode | 'send-fails', string]> = [['fail', 'FALLBACK_FAILED'], ['silent', 'FALLBACK_NO_AUDIO'], ['stall', 'FALLBACK_STALLED'], ['empty-done', 'FALLBACK_NO_AUDIO'], ['send-fails', 'FALLBACK_SEND_FAILED']];
  for (const [mode, why] of cases) {
    const r = rig({ source: { behave: () => 'fail-start' }, openai: mode === 'send-fails' ? { sendFails: true } : { speak: mode }, opts: { fallbackFirstAudioMs: 80, fallbackGapMs: 80 } });
    const t0 = Date.now();
    r.sp.send(create(LINE, 'r1'));
    await until(() => r.closes() === 1);
    assert.equal(doneOf(r.events)[0].response.status, 'failed', why);
    assert.equal(doneOf(r.events).length, 1, why);
    assert.equal(r.events.filter((e) => e.type === 'response.output_audio_transcript.done').length, 0, `${why}: never claimed as heard`);
    assert.ok(r.events.some((e) => e.type === 'x_speaker_down'), why);
    assert.deepEqual(r.inner.closed, [1011], why);
    assert.equal(failedWhy(r.diagLines), why);
    assert.ok(Date.now() - t0 < 80 + 80 + 40 + 500, `${why}: within the defined time`);
    assert.equal(r.sp.send(create(LINE, 'r2')), false, why);
  }
});

test('cancellation during the switch: before OpenAI is asked, while OpenAI has not yet named its reply, and while OpenAI is speaking; late OpenAI audio is dropped', async () => {
  // (1) a cancel while the SOURCE is still working never starts the fallback
  const a = rig({ source: { behave: () => 'never' }, opts: { firstAudioMs: 500 } });
  a.sp.send(create(LINE)); await sleep(20); a.sp.send(cancelMsg('spk_1'));
  await until(() => doneOf(a.events).length === 1); await sleep(120);
  assert.deepEqual([doneOf(a.events)[0].response.status, creates(a.inner).length, a.source.cancelled()], ['cancelled', 0, 1]);
  // (2) the fallback was requested but OpenAI has not named its reply: the cancel is remembered and applied when it is named; nothing it sends reaches the bridge
  const b = rig({ source: { behave: () => 'fail-start' }, openai: { speak: 'slow-created', createdDelayMs: 100, keepSendingAfterCancel: true } });
  b.sp.send(create(LINE, 'r1'));
  await until(() => creates(b.inner).length === 1);
  b.sp.send(cancelMsg('spk_1', 'c7'));
  await until(() => doneOf(b.events).length === 1);
  assert.equal(doneOf(b.events)[0].response.status, 'cancelled');
  await until(() => b.inner.sent.some((m) => m.type === 'response.cancel' && m.response_id === 'oai_1'));   // applied once OpenAI named it
  await sleep(150);
  assert.equal(deltaBytes(b.events), 0, 'nothing OpenAI said reached the bridge');
  assert.equal(b.events.filter((e) => e.type === 'response.output_audio_transcript.done').length, 0);
  assert.equal(doneOf(b.events).length, 1);
  // (3) OpenAI is speaking: the cancel names OpenAI's reply, the line is answered cancelled once, and OpenAI's late audio is dropped and counted
  const c = rig({ source: { behave: () => 'fail-start' }, openai: { speak: 'ok', keepSendingAfterCancel: true } });
  c.sp.send(create(LINE, 'r1'));
  await until(() => c.events.some((e) => e.type === 'response.output_audio.delta'));
  c.sp.send(cancelMsg(ridOf(c.events), 'c8'));
  await until(() => doneOf(c.events).length === 1);
  const at = deltaBytes(c.events);
  assert.equal(doneOf(c.events)[0].response.status, 'cancelled');
  assert.ok(c.inner.sent.some((m) => m.type === 'response.cancel' && m.response_id === 'oai_1' && m.event_id === 'c8'));
  await sleep(120);
  assert.equal(deltaBytes(c.events), at, 'late OpenAI audio never reaches the bridge');
  assert.ok(c.sp.stats().fromVoiceDropped > 0);
  assert.equal(doneOf(c.events).length, 1);
  assert.ok(!c.events.some((e) => e.type === 'x_speaker_down'), 'a cancel is not a failure');
});

test('everything else passes through, an unexpected reply event from the voice service is dropped, and a line that is not a fixed one is refused', async () => {
  const r = rig();
  const append = JSON.stringify({ type: 'input_audio_buffer.append', audio: 'AAAA' });
  const update = JSON.stringify({ type: 'session.update', session: { type: 'realtime' } });
  const del = JSON.stringify({ type: 'conversation.item.delete', item_id: 'item_1' });
  for (const m of [append, update, del]) assert.equal(r.sp.send(m), true);
  assert.deepEqual(r.inner.sent.map((m) => m.type), ['input_audio_buffer.append', 'session.update', 'conversation.item.delete']);
  r.inner.onMessage(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
  r.inner.onMessage(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_1', transcript: 'yes' }));
  r.inner.onMessage(JSON.stringify({ type: 'response.output_audio.delta', response_id: 'resp_1', delta: 'AAAA' }));
  r.inner.onMessage(JSON.stringify({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } }));
  r.inner.onMessage(JSON.stringify({ type: 'error', error: { code: 'x' } }));
  assert.deepEqual(typesOf(r.events), ['input_audio_buffer.speech_started', 'conversation.item.input_audio_transcription.completed', 'error']);
  assert.equal(r.sp.stats().fromVoiceDropped, 2);
  r.sp.send(JSON.stringify({ type: 'response.create', response: { instructions: 'Answer the caller kindly.', metadata: { id: 'r5' } } }));
  await until(() => r.events.filter((e) => e.type === 'error').length === 2);
  assert.equal(r.source.started(), 0);
  const busy = rig({ source: { msPerChar: 30, gapMs: 20 } });
  busy.sp.send(create(LINE, 'r1')); busy.sp.send(create(LINE, 'r2', 'e2'));
  await until(() => busy.events.some((e) => e.type === 'error'));
  assert.equal(busy.events.find((e) => e.type === 'error').error.code, 'conversation_already_has_active_response');
  await until(() => doneOf(busy.events).length === 1);
  assert.deepEqual([doneOf(busy.events)[0].response.status, busy.source.started()], ['completed', 1]);
});

test('closing the splice cancels the line in progress, drops what is queued and closes the voice socket with the same code', async () => {
  const r = rig({ source: { msPerChar: 50, gapMs: 20, keepEmittingAfterCancel: true } });
  r.sp.send(create(LINE)); await until(() => r.events.some((e) => e.type === 'response.output_audio.delta'));
  r.sp.close(1000);
  assert.deepEqual(r.inner.closed, [1000]);
  assert.equal(r.source.cancelled(), 1);
  const n = r.events.length; await sleep(150);
  assert.equal(r.events.length, n, 'nothing is delivered after the close');
  assert.equal(r.sp.send(create(LINE)), false);
});

test('privacy: the adapter keeps and logs no text; the diagnostics are fixed codes and numbers; the words reach the source, and OpenAI only when it speaks them as the fallback', async () => {
  const CANARY = 'CANARY-ZIP-90210 Springfield 742 Evergreen';
  const r = rig({ source: { behave: (_q, n) => (n === 2 ? 'fail-start' : 'ok') } });
  r.sp.send(create(`Your address: ${CANARY}. Is that correct?`, 'r1')); await until(() => doneOf(r.events).length === 1);
  assert.equal(creates(r.inner).length, 0, 'while the source works, nothing reaches OpenAI');
  r.sp.send(create(`Again: ${CANARY}`, 'r2')); await until(() => doneOf(r.events).length === 2);
  assert.ok(r.diagLines.length >= 4 && r.diagLines.some((d) => d.code === 'SPEAKER_FALLBACK'));
  assert.ok(!JSON.stringify([r.diagLines, r.sp.stats()]).match(/CANARY|90210|Springfield|Evergreen/), 'no diagnostic or statistic holds any of the words');
  assert.ok(r.diagLines.every((d) => /^SPEAKER_[A-Z_]+$/.test(d.code) && Object.values(d).every((v) => typeof v === 'number' || typeof v === 'string')));
  assert.ok(r.source.requests[0].text.includes(CANARY), 'the words reach the source');
  assert.equal(creates(r.inner).length, 1, 'and OpenAI only for the line it spoke as the fallback');
  const src = readFileSync(new URL('../src/speaker-adapter.ts', import.meta.url), 'utf8');
  assert.ok(!/from 'node:(?:fs|net|http|https|child_process|dgram|tls|dns|worker_threads)'|\bfetch\(|WebSocket|process\.env|ELEVEN_?LABS_API|xi-api-key/i.test(src), 'no network, file, process or key access');
});

// ================================================================ part 2: behind the existing bridge and transport
function bridgeRig(o: { source?: StandInOptions; opts?: SpeakerOptions; voice?: Parameters<typeof createWireVoice>[0] } = {}) {
  const phone = createWirePhone(); const voice = createWireVoice({ msPerChar: 1, ...o.voice }); const source = createStandInSource(o.source);
  const diagLines: Array<{ code: string; [k: string]: unknown }> = [];
  const sp: SpeakerSplice = withSpeaker(voice, source, JACK_SPEAKER, { diag: (code, detail) => { diagLines.push({ code, ...detail }); }, endDelayMs: 50, ...o.opts });
  const bridge = createRealtimeBridge(phone, sp, { playGraceMs: 600 });
  const toAdapter: any[] = [];
  const t = createRealtimeTransport(bridge.link, { notice: NOTICE, transcriptionModel: 'sim-transcriber', voice: 'sim-voice', msPerChar: 1, endWaitMs: 500 });
  const adapterIn = bridge.link.onMessage; bridge.link.onMessage = (m: unknown) => { toAdapter.push(m); adapterIn(m); };
  const events: TransportEvent[] = []; const closes: unknown[] = []; t.onEvent = (e) => { events.push(e); }; t.onClose = (i) => { closes.push(i); };
  const kinds = () => events.map((e) => e.kind);
  const media = () => phone.sent.filter((m) => m.event === 'media').length;
  const live = async () => { phone.start(); await until(() => kinds().includes('setup'), 8000); };
  return { phone, voice, source, sp, bridge, t, events, closes, toAdapter, diagLines, kinds, media, live };
}

test('behind the bridge: the notice is spoken by the source, the phone plays it, the playback is MEASURED, and only then does the caller\'s microphone open to the voice service', async () => {
  const h = bridgeRig();
  h.phone.start();
  await until(() => h.phone.sent.some((m) => m.event === 'media'));
  h.phone.frames(2);
  assert.equal(h.voice.appended(), 0, 'held back while the notice plays');
  await until(() => h.kinds().includes('setup'), 8000);
  const done = h.toAdapter.find((m) => m.type === 'response.done');
  const bytes = h.source.emitted() * 800;
  assert.deepEqual([done.x_sent_ms, done.x_acked_ms, done.response.status], [bytes / 8, bytes / 8, 'completed'], 'sent and acknowledged milliseconds are the source audio\'s length');
  assert.equal(h.t.playbackMeasure?.()?.sentMs, bytes / 8);
  assert.equal(h.source.requests[0].text, NOTICE);
  assert.equal(h.voice.received.filter((m: any) => m.type === 'response.create').length, 0);
  h.phone.frames(3);
  await until(() => h.voice.appended() === 3);
  assert.equal(h.bridge.stats().audioHeldBack, 2);
});

test('behind the bridge: the CONSENT NOTICE falls back too - OpenAI speaks it when the source gives no audio, the microphone stays closed until the whole OpenAI notice is acknowledged, and setup follows only then', async () => {
  const h = bridgeRig({ source: { behave: () => 'fail-start' }, voice: { msPerChar: 12 } });
  h.phone.start();
  await until(() => h.voice.received.some((m: any) => m.type === 'response.create'));
  h.phone.frames(2);
  assert.equal(h.voice.appended(), 0);
  await sleep(60);
  assert.ok(!h.kinds().includes('setup'), 'not before the notice has been played');
  await until(() => h.kinds().includes('setup'), 8000);
  assert.equal(h.voice.spoken[0], NOTICE, 'OpenAI spoke the notice, word for word');
  const done = h.toAdapter.find((m) => m.type === 'response.done');
  assert.deepEqual([done.response.status, done.x_acked_ms === done.x_sent_ms, done.x_sent_ms > 1000], ['completed', true, true]);
  assert.equal(h.media() > 0 && h.source.emitted() === 0, true, 'no source audio was handed on');
  h.phone.frames(2);
  await until(() => h.voice.appended() === 2);
  assert.ok(h.diagLines.some((d) => d.code === 'SPEAKER_FALLBACK' && d.why === 'START_FAILED'));
});

test('behind the bridge: the caller talks over a question - the phone is cleared, the source is cancelled, late pieces never reach the phone, the played time is measured, and the next line plays in full', async () => {
  const h = bridgeRig({ source: { msPerChar: 10, gapMs: 30, keepEmittingAfterCancel: true } });
  await h.live();
  const question = 'Which kind of property is it? You can say house, apartment, condo or townhouse, whichever fits best.';
  const base = h.media();
  h.t.speak(question, true);
  await until(() => h.media() >= base + 4);
  const sentBefore = h.media();
  h.voice.hear('it is a house');
  await until(() => h.phone.sent.some((m) => m.event === 'clear'));
  await until(() => h.source.cancelled() === 1);
  const interrupt = h.events.find((e) => e.kind === 'interrupt') as { spoken: string } | undefined;
  assert.ok(interrupt !== undefined && typeof interrupt.spoken === 'string', 'the call logic hears the interruption');
  const stoppedAt = h.media();
  await sleep(350);
  assert.equal(h.media(), stoppedAt, 'no piece reaches the phone after the clear');
  assert.ok(h.media() >= sentBefore && h.sp.stats().lateDropped > 0 && h.source.lateEmitted() > 0, 'the source kept sending; the adapter dropped it');
  const cut = h.toAdapter.filter((m) => m.type === 'response.done').at(-1);
  assert.equal(cut.response.status, 'cancelled');
  assert.equal(await h.t.playbackDone(2000), 'cut');
  assert.ok(!h.kinds().includes('reply_failed') && !h.kinds().includes('speaker_down'), 'a talked-over line is not a failure');
  const heard = h.toAdapter.find((m) => m.type === 'input_audio_buffer.speech_started');
  assert.ok(typeof heard.x_played_ms === 'number' && heard.x_played_ms <= cut.x_sent_ms);
  h.t.speak('Thank you.', true);
  assert.equal(await h.t.playbackDone(5000), 'played');
  const m = h.t.playbackMeasure?.();
  assert.ok(m !== undefined && m.sentMs > 0 && m.ackedMs === m.sentMs);
});

test('behind the bridge: a line OpenAI speaks as the fallback is played in full and verified like any other, and a caller who talks over it clears the phone, cancels OpenAI\'s reply and cuts the line', async () => {
  const h = bridgeRig({ source: { behave: (_q, n) => (n === 2 || n === 3 ? 'never' : 'ok') }, opts: { firstAudioMs: 80 }, voice: { msPerChar: 12 } });
  await h.live();
  const base = h.media();
  h.t.speak('How many bedrooms does the home have?', true);   // source gives no audio: OpenAI speaks it
  assert.equal(await h.t.playbackDone(8000), 'played');
  const m = h.t.playbackMeasure?.();
  assert.ok(m !== undefined && m.sentMs > 300 && m.ackedMs === m.sentMs, 'the whole fallback line was sent and acknowledged');
  assert.equal(h.voice.spoken.at(-1), 'How many bedrooms does the home have?');
  assert.ok(h.media() > base);
  // The same again, but talked over while OpenAI is speaking it.
  const base2 = h.media();
  h.t.speak('How many bathrooms does the home have?', true);
  await until(() => h.media() >= base2 + 3);
  h.voice.hear('two');
  await until(() => h.phone.sent.some((x, i) => x.event === 'clear' && i > 0));
  assert.equal(await h.t.playbackDone(3000), 'cut');
  assert.ok(!h.kinds().includes('speaker_down') && !h.kinds().includes('reply_failed'));
  assert.equal(h.toAdapter.filter((x) => x.type === 'response.done').at(-1).response.status, 'cancelled');
});

test('behind the bridge: a source that fails AFTER audio started ends the call within the bound - the line is reported not heard, the call logic is told, the phone stream is closed, nothing more is spoken', async () => {
  const h = bridgeRig({ source: { behave: (_q, n) => (n === 2 ? { failAfter: 2 } : 'ok') }, opts: { endDelayMs: 80 } });
  await h.live();
  const t0 = Date.now();
  h.t.speak('Is it a house or an apartment?', true);
  await until(() => h.kinds().includes('reply_failed') && h.kinds().includes('speaker_down'));
  assert.ok(h.kinds().indexOf('reply_failed') < h.kinds().indexOf('speaker_down'), 'not heard first, then the call is ended');
  await until(() => h.closes.length === 1 || h.phone.closedWith.length > 0, 3000);
  assert.ok(Date.now() - t0 < 2000, 'within the defined time');
  assert.ok(h.phone.closedWith.length > 0, 'the phone stream is closed, which ends the call');
  assert.equal(h.toAdapter.filter((x) => x.type === 'response.done').at(-1).response.status, 'failed');
  assert.deepEqual(h.voice.received.filter((x: any) => x.type === 'response.create'), [], 'OpenAI was never asked to speak');
  assert.equal(h.t.speak('Anything else?', true), false, 'no further line is spoken');
});

test('behind the bridge: when the fallback fails as well, the call ends within the bound and the line is never reported played', async () => {
  const h = bridgeRig({ source: { behave: (_q, n) => (n === 2 ? 'fail-start' : 'ok') }, opts: { endDelayMs: 60, fallbackFirstAudioMs: 300 }, voice: { behave: () => 'fail' } });
  await h.live();
  const t0 = Date.now();
  h.t.speak('How many bedrooms?', true);
  await until(() => h.kinds().includes('speaker_down'), 4000);
  await until(() => h.phone.closedWith.length > 0, 3000);
  assert.ok(Date.now() - t0 < 3000);
  assert.ok(h.kinds().includes('reply_failed'));
  assert.equal(h.toAdapter.filter((x) => x.type === 'response.done').at(-1).response.status, 'failed');
  assert.equal(h.t.playbackMeasure?.() === undefined || h.t.playbackMeasure()!.ackedMs <= h.t.playbackMeasure()!.sentMs, true);
});

test('behind the bridge: a reply the voice service sends that is not the fallback never reaches the phone', async () => {
  const h = bridgeRig();
  await h.live();
  const before = h.media();
  h.voice.emit({ type: 'response.created', response: { id: 'resp_x', metadata: { id: 'rX' } } });
  h.voice.emit({ type: 'response.output_audio.delta', response_id: 'resp_x', delta: 'f39/fw==' });
  await sleep(60);
  assert.equal(h.media(), before);
  assert.equal(h.sp.stats().fromVoiceDropped, 2);
});
