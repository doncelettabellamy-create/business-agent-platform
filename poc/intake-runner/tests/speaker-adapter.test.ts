// The OFFLINE speaker adapter (src/speaker-adapter.ts) with a STAND-IN speech source (tests/helpers/speaker-stand-in.ts). Part 1 runs the adapter on its own; part 2 runs it behind the EXISTING bridge
// and transport (src/realtime-bridge.ts, src/realtime-transport.ts) against the wire-level phone and voice stand-ins. No socket, no network, no key, no provider; invented data only.
// A passing test shows behaviour against THESE models only. It does not show how a real provider sounds or behaves, and nothing here is wired into the service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APPROVED_SPEAKER_MODELS, JACK_SPEAKER, speakerSettingsProblems, withSpeaker } from '../src/speaker-adapter.ts';
import type { SpeakerOptions, SpeakerSplice } from '../src/speaker-adapter.ts';
import { createRealtimeBridge } from '../src/realtime-bridge.ts';
import type { VoiceSocket } from '../src/realtime-bridge.ts';
import { createRealtimeTransport, SAY_PREFIX, SPEAK_ONLY } from '../src/realtime-transport.ts';
import type { TransportEvent } from '../src/call-transport.ts';
import { createWirePhone, createWireVoice } from './helpers/realtime-wire-sim.ts';
import { createStandInSource } from './helpers/speaker-stand-in.ts';
import type { StandInBehaviour, StandInOptions } from './helpers/speaker-stand-in.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 4000): Promise<void> { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await sleep(4); } }
const NOTICE = 'Hello. This is an automated A I assistant for Example Cleaning. Please say yes to continue, or hang up now.';
const LINE = 'Let me check what I have. Property type: house. Please say yes or no. Is that correct?';

// ================================================================ part 1: the adapter on its own
function fakeVoice() {
  const sent: any[] = []; const closed: Array<number | undefined> = [];
  const v: VoiceSocket & { sent: any[]; closed: Array<number | undefined> } = { sent, closed, send(t: string) { sent.push(JSON.parse(t)); return true; }, close(c?: number) { closed.push(c); }, onOpen: () => {}, onMessage: () => {}, onClose: () => {} };
  return v;
}
function rig(o: { source?: StandInOptions; opts?: SpeakerOptions } = {}) {
  const inner = fakeVoice(); const source = createStandInSource(o.source);
  const diagLines: Array<{ code: string; [k: string]: unknown }> = [];
  const sp = withSpeaker(inner, source, JACK_SPEAKER, { diag: (code, detail) => { diagLines.push({ code, ...detail }); }, ...o.opts });
  const events: any[] = []; sp.onMessage = (t: string) => { events.push(JSON.parse(t)); };
  return { inner, source, sp, events, diagLines };
}
const create = (text: string, mid = 'r1', eventId?: string): string => JSON.stringify({ type: 'response.create', ...(eventId === undefined ? {} : { event_id: eventId }), response: { conversation: 'none', output_modalities: ['audio'], instructions: `${SPEAK_ONLY} ${SAY_PREFIX}${text}`, metadata: { id: mid } } });
const cancelMsg = (rid: string, eventId = 'c1'): string => JSON.stringify({ type: 'response.cancel', response_id: rid, event_id: eventId });
const typesOf = (e: any[]) => e.map((x) => x.type);
const ridOf = (e: any[]): string => e.find((x) => x.type === 'response.created').response.id;
const doneOf = (e: any[]) => e.filter((x) => x.type === 'response.done');
const deltaBytes = (e: any[]): number => e.filter((x) => x.type === 'response.output_audio.delta').reduce((n, x) => n + Buffer.from(x.delta, 'base64').length, 0);

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
});

test('a line is spoken by the source and answered as the voice service would: created, audio, the requested words as the transcript, done; OpenAI is never asked to speak', async () => {
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
  assert.equal(r.inner.sent.filter((m) => m.type === 'response.create' || m.type === 'response.cancel').length, 0, 'the voice service is never asked to speak');
  assert.deepEqual([r.sp.stats().replies, r.sp.stats().completed, r.sp.stats().failed], [1, 1, 0]);
});

test('cancellation: a cancel stops the source, answers cancelled, and every late piece (arriving or already queued) is dropped and counted', async () => {
  // A source that keeps delivering after the cancel.
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
  // A cancel that names nothing is refused, not guessed.
  done.sp.send(JSON.stringify({ type: 'response.cancel', event_id: 'c10' }));
  await until(() => done.events.filter((e) => e.type === 'error').length === 2);
});

test('failure is honest: a source that cannot start, sends nothing, stalls, errors, is empty or sends bad audio ends the line as failed with no transcript, and the next line still works', async () => {
  const cases: Array<[StandInBehaviour, string]> = [
    ['fail-start', 'START_FAILED'], ['never', 'NO_AUDIO'], [{ stallAfter: 2 }, 'STALLED'], [{ failAfter: 2 }, 'SOURCE_ERROR'], ['empty', 'EMPTY'], ['bad-audio', 'BAD_AUDIO'], ['huge', 'BAD_AUDIO'],
  ];
  for (const [b, why] of cases) {
    const r = rig({ source: { behave: (_q, n) => (n === 1 ? b : 'ok') }, opts: { firstAudioMs: 60, gapMs: 60 } });
    r.sp.send(create(LINE, 'r1'));
    await until(() => doneOf(r.events).length === 1);
    assert.equal(doneOf(r.events)[0].response.status, 'failed', why);
    assert.equal(r.events.filter((e) => e.type === 'response.output_audio_transcript.done').length, 0, `${why}: a failed line has no transcript`);
    assert.ok(r.diagLines.some((d) => d.code === 'SPEAKER_FAILED' && d.why === why), why);
    const after = r.events.length; await sleep(120);
    assert.equal(r.events.length, after, `${why}: nothing more arrives for the failed line`);
    r.sp.send(create(LINE, 'r2'));
    await until(() => doneOf(r.events).length === 2);
    assert.equal(doneOf(r.events)[1].response.status, 'completed', `${why}: the next line is spoken`);
    assert.equal(r.sp.stats().failed, 1);
  }
  // Too much audio for the text, or text too long for the adapter, also fails closed.
  const long = rig({ source: { msPerChar: 10 }, opts: { maxAudioMs: 300 } });
  long.sp.send(create(LINE)); await until(() => doneOf(long.events).length === 1);
  assert.equal(doneOf(long.events)[0].response.status, 'failed');
  const wordy = rig({ opts: { maxChars: 20 } });
  wordy.sp.send(create(LINE)); await until(() => doneOf(wordy.events).length === 1);
  assert.deepEqual([doneOf(wordy.events)[0].response.status, wordy.source.started()], ['failed', 0], 'a line over the limit never reaches the source');
});

test('everything else passes through, a reply event from the voice service is dropped, and a line that is not a fixed one is refused', async () => {
  const r = rig();
  const append = JSON.stringify({ type: 'input_audio_buffer.append', audio: 'AAAA' });
  const update = JSON.stringify({ type: 'session.update', session: { type: 'realtime' } });
  const del = JSON.stringify({ type: 'conversation.item.delete', item_id: 'item_1' });
  for (const m of [append, update, del]) assert.equal(r.sp.send(m), true);
  assert.deepEqual(r.inner.sent.map((m) => m.type), ['input_audio_buffer.append', 'session.update', 'conversation.item.delete']);
  // From the voice service: listening events pass; any reply event is dropped (its audio can never reach the phone).
  r.inner.onMessage(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
  r.inner.onMessage(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_1', transcript: 'yes' }));
  r.inner.onMessage(JSON.stringify({ type: 'response.output_audio.delta', response_id: 'resp_1', delta: 'AAAA' }));
  r.inner.onMessage(JSON.stringify({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } }));
  r.inner.onMessage(JSON.stringify({ type: 'error', error: { code: 'x' } }));
  assert.deepEqual(typesOf(r.events), ['input_audio_buffer.speech_started', 'conversation.item.input_audio_transcription.completed', 'error']);
  assert.equal(r.sp.stats().fromVoiceDropped, 2);
  // A voice's own words (no fixed-line prefix) are not handled here.
  r.sp.send(JSON.stringify({ type: 'response.create', response: { instructions: 'Answer the caller kindly.', metadata: { id: 'r5' } } }));
  await until(() => r.events.filter((e) => e.type === 'error').length === 2);
  assert.equal(r.source.started(), 0);
  // One line at a time: a second request while one is active is refused and the first is not disturbed.
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

test('privacy: the adapter keeps and logs no text; the diagnostics are fixed codes and numbers; only the source sees the words', async () => {
  const CANARY = 'CANARY-ZIP-90210 Springfield 742 Evergreen';
  const r = rig({ source: { behave: (_q, n) => (n === 2 ? { failAfter: 1 } : 'ok') } });
  r.sp.send(create(`Your address: ${CANARY}. Is that correct?`, 'r1')); await until(() => doneOf(r.events).length === 1);
  r.sp.send(create(`Again: ${CANARY}`, 'r2')); await until(() => doneOf(r.events).length === 2);
  assert.ok(r.diagLines.length >= 4);
  assert.ok(!JSON.stringify([r.diagLines, r.sp.stats()]).match(/CANARY|90210|Springfield|Evergreen/), 'no diagnostic or statistic holds any of the words');
  assert.ok(r.diagLines.every((d) => /^SPEAKER_[A-Z_]+$/.test(d.code) && Object.values(d).every((v) => typeof v === 'number' || typeof v === 'string')));
  assert.ok(r.source.requests[0].text.includes(CANARY), 'the words reach the source (unavoidable for a spoken line)');
  assert.ok(!r.inner.sent.some((m) => JSON.stringify(m).includes('CANARY')), 'and nothing reaches the voice service');
  const src = readFileSync(new URL('../src/speaker-adapter.ts', import.meta.url), 'utf8');
  assert.ok(!/from 'node:(?:fs|net|http|https|child_process|dgram|tls|dns|worker_threads)'|\bfetch\(|WebSocket|process\.env|ELEVEN_?LABS_API|xi-api-key/i.test(src), 'no network, file, process or key access');
});

// ================================================================ part 2: behind the existing bridge and transport
function bridgeRig(o: { source?: StandInOptions; opts?: SpeakerOptions } = {}) {
  const phone = createWirePhone(); const voice = createWireVoice({ msPerChar: 1 }); const source = createStandInSource(o.source);
  const diagLines: Array<{ code: string; [k: string]: unknown }> = [];
  const sp: SpeakerSplice = withSpeaker(voice, source, JACK_SPEAKER, { diag: (code, detail) => { diagLines.push({ code, ...detail }); }, ...o.opts });
  const bridge = createRealtimeBridge(phone, sp, { playGraceMs: 600 });
  const toAdapter: any[] = [];
  const t = createRealtimeTransport(bridge.link, { notice: NOTICE, transcriptionModel: 'sim-transcriber', voice: 'sim-voice', msPerChar: 1, endWaitMs: 500 });
  const adapterIn = bridge.link.onMessage; bridge.link.onMessage = (m: unknown) => { toAdapter.push(m); adapterIn(m); };
  const events: TransportEvent[] = []; t.onEvent = (e) => { events.push(e); }; t.onClose = () => {};
  const kinds = () => events.map((e) => e.kind);
  const media = () => phone.sent.filter((m) => m.event === 'media').length;
  const live = async () => { phone.start(); await until(() => kinds().includes('setup'), 8000); };
  return { phone, voice, source, sp, bridge, t, events, toAdapter, diagLines, kinds, media, live };
}

test('behind the bridge: the notice is spoken by the source, the phone plays it, the playback is MEASURED, and only then does the caller\'s microphone open to the voice service', async () => {
  const h = bridgeRig();
  h.phone.start();
  await until(() => h.phone.sent.some((m) => m.event === 'media'));
  h.phone.frames(2);   // caller audio during the notice
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

test('behind the bridge: the caller talks over a question - the phone is cleared, the source is cancelled, late pieces never reach the phone, the played time is measured, and the next line plays in full', async () => {
  const h = bridgeRig({ source: { msPerChar: 10, gapMs: 30, keepEmittingAfterCancel: true } });
  await h.live();
  const question = 'Which kind of property is it? You can say house, apartment, condo or townhouse, whichever fits best.';
  const base = h.media();   // the notice's pieces are already counted
  h.t.speak(question, true);
  await until(() => h.media() >= base + 4);   // part of the question has been handed to the phone
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
  assert.ok(!h.kinds().includes('reply_failed'), 'a talked-over line is not a failure');
  const heard = h.toAdapter.find((m) => m.type === 'input_audio_buffer.speech_started');
  assert.ok(typeof heard.x_played_ms === 'number' && heard.x_played_ms <= cut.x_sent_ms, 'the played time the bridge measured is within what was sent');
  // The next line is spoken in full and verified played.
  h.t.speak('Thank you.', true);
  assert.equal(await h.t.playbackDone(5000), 'played');
  const m = h.t.playbackMeasure?.();
  assert.ok(m !== undefined && m.sentMs > 0 && m.ackedMs === m.sentMs);
});

test('behind the bridge: a source that fails part-way is reported as a line that was NOT heard, never as played, and the call can go on', async () => {
  const h = bridgeRig({ source: { behave: (_q, n) => (n === 2 ? { failAfter: 2 } : 'ok') } });
  await h.live();
  h.t.speak('Is it a house or an apartment?', true);
  await until(() => h.kinds().includes('reply_failed'));
  assert.equal(await h.t.playbackDone(2000), 'cut');
  assert.ok(h.diagLines.some((d) => d.code === 'SPEAKER_FAILED' && d.why === 'SOURCE_ERROR'));
  assert.equal(h.toAdapter.filter((m) => m.type === 'response.done').at(-1).response.status, 'failed');
  h.t.speak('Is it a house or an apartment?', true);   // asked again
  assert.equal(await h.t.playbackDone(5000), 'played');
});

test('behind the bridge: a source that never produces audio fails the line within its bound; nothing hangs and the next line is spoken', async () => {
  const h = bridgeRig({ source: { behave: (_q, n) => (n === 2 ? 'never' : 'ok') }, opts: { firstAudioMs: 120 } });
  await h.live();
  const t0 = Date.now();
  h.t.speak('How many bedrooms?', true);
  await until(() => h.kinds().includes('reply_failed'));
  assert.ok(Date.now() - t0 < 2000);
  h.t.speak('How many bedrooms?', true);
  assert.equal(await h.t.playbackDone(5000), 'played');
});

test('behind the bridge: a reply the voice service sends anyway never reaches the phone', async () => {
  const h = bridgeRig();
  await h.live();
  const before = h.media();
  h.voice.emit({ type: 'response.created', response: { id: 'resp_x', metadata: { id: 'rX' } } });
  h.voice.emit({ type: 'response.output_audio.delta', response_id: 'resp_x', delta: 'f39/fw==' });
  await sleep(60);
  assert.equal(h.media(), before);
  assert.equal(h.sp.stats().fromVoiceDropped, 2);
});
