// OFFLINE speaker adapter (proof of concept). A VoiceSocket decorator that lets the caller's words keep going to the OpenAI voice service for LISTENING while every fixed line the call logic
// asks the voice to say is SPOKEN by a separate speech source (the ElevenLabs candidate, "Jack", reached later) instead of by OpenAI. NOTHING HERE IS CONNECTED: it opens no socket, reads no
// key and imports no network or file API; the only source it has ever been run with is a test stand-in. It is not wired into any service, entry point or configuration, so the current speaker
// path (OpenAI speaks) is unchanged until a later, separately approved step wires it.
//
//   bridge  <->  SpeakerSplice  <->  OpenAI voice socket
//
// To the bridge the splice looks like the voice service: for each `response.create` that asks for fixed words ("Say exactly the following words ...") it answers with the same events the voice
// service would send (`response.created`, `response.output_audio.delta` as base64 mu-law 8 kHz, `response.output_audio_transcript.done`, `response.done`). The bridge and the transport are
// therefore UNCHANGED: marks, measured playback (`x_sent_ms`/`x_acked_ms`), the clear on caller speech, `x_played_ms`, and the call logic's CUT / CONFIRM_HELD rules all work as before.
//   * `response.create` and `response.cancel` are answered here and never reach OpenAI, so OpenAI never speaks. Everything else (caller audio, settings, deleting transcript items) passes through.
//   * Any `response.*` event that OpenAI sends anyway is dropped and counted: its audio can never reach the phone.
//   * CANCELLATION: a cancel stops the source request, answers `response.done` with status cancelled, and every audio piece that arrives afterwards (or was queued) is dropped and counted.
//     A cancel of a reply that already ended is answered with the error the voice service gives (`response_cancel_not_active`, carrying the request's event id), which the transport already tolerates.
//   * FAILURE IS HONEST: a source that cannot start, sends nothing, stalls, errors, sends nothing usable or runs too long ends the reply with status `failed` and NO transcript, so the call
//     logic reports a reply that was not heard (and asks again). Audio already handed to the phone stays counted as sent; the reply never passes as played.
//   * The transcript the transport compares with the requested words is the requested words themselves (the source speaks exactly the text it was given). That removes the check that the voice
//     said the right words; how the source PRONOUNCES them (digits, house numbers, amounts) is NOT checked here and stays unverified until it is listened to.
//   * Only the "say exactly" lines are handled. A request for a voice's own words (native conversation) is refused with an error event.
//
// PRIVACY: the text of a line goes to the source only (it is the text a read-back speaks, so it can hold a name, a number or an address, as it does today for OpenAI). The splice stores no text,
// logs no text, and its diagnostics are fixed codes and numbers. It never sees the caller's audio.

import { noDiag } from './call-diag.ts';
import type { DiagSink } from './call-diag.ts';

// ---------------------------------------------------------------- the voice socket, by shape
// This file imports no bridge or transport code (the existing inventory tests allow only the voice service and the connection check to do that). The socket the bridge uses is described by its shape, and the
// words the transport puts in front of a fixed line are repeated below; tests/speaker-adapter.test.ts builds every request with the transport's own constant, so a change there fails the whole suite.
export interface SpeakerSocket {
  send(text: string): boolean;
  close(code?: number): void;
  onOpen: () => void;
  onMessage: (text: string) => void;
  onClose: () => void;
}
const SAY_PREFIX = 'Say exactly the following words, and nothing else: ';
function wordsOf(instructions: string): string { const at = instructions.indexOf(SAY_PREFIX); return at < 0 ? instructions : instructions.slice(at + SAY_PREFIX.length); }

// ---------------------------------------------------------------- the settings the founder chose (a PREFERRED CANDIDATE, not a production approval)
export interface SpeakerSettings {
  readonly provider: 'elevenlabs';
  readonly voiceId: string;
  readonly modelId: string;
  /** Speaking speed, 1.0 normal. */
  readonly speed: number;
  readonly outputFormat: 'ulaw_8000';
}
/** Jack John (founder audition, 2026-10-30), Flash v2.5, speed 0.95, mu-law 8 kHz (the phone's format, so nothing is converted). */
export const JACK_SPEAKER: SpeakerSettings = Object.freeze({ provider: 'elevenlabs', voiceId: '7EzWGsX10sAS4c9m9cPf', modelId: 'eleven_flash_v2_5', speed: 0.95, outputFormat: 'ulaw_8000' });
/** The models this adapter will use. A different model is a code change with its own approval. */
export const APPROVED_SPEAKER_MODELS: readonly string[] = Object.freeze(['eleven_flash_v2_5']);
/** The project's own bounds for the speed. The provider's documented range is not on file, so this is deliberately narrow. */
export const SPEED_MIN = 0.7;
export const SPEED_MAX = 1.2;

/** Why the settings are not acceptable, as fixed text (never a value). Empty when they are. Pure. */
export function speakerSettingsProblems(x: unknown): string[] {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return ['speaker settings must be an object'];
  const s = x as Record<string, unknown>;
  const p: string[] = [];
  if (Object.keys(s).sort().join(',') !== 'modelId,outputFormat,provider,speed,voiceId') p.push('speaker settings must have exactly the expected keys');
  if (s.provider !== 'elevenlabs') p.push('provider must be elevenlabs');
  if (typeof s.voiceId !== 'string' || !/^[A-Za-z0-9]{20}$/.test(s.voiceId)) p.push('voiceId must be a 20-character provider id');
  if (typeof s.modelId !== 'string' || !APPROVED_SPEAKER_MODELS.includes(s.modelId)) p.push('modelId is not an approved model');
  if (typeof s.speed !== 'number' || !Number.isFinite(s.speed) || s.speed < SPEED_MIN || s.speed > SPEED_MAX) p.push('speed is outside the allowed range');
  if (s.outputFormat !== 'ulaw_8000') p.push('outputFormat must be ulaw_8000 (the phone format)');
  return p;
}

// ---------------------------------------------------------------- the source (where a real ElevenLabs client plugs in later)
export interface SpeechRequest {
  /** The exact words to say. The only caller-related content that ever reaches a source. */
  readonly text: string;
  readonly voiceId: string;
  readonly modelId: string;
  readonly speed: number;
  readonly outputFormat: 'ulaw_8000';
}
export type SpeechFailure = 'START_FAILED' | 'NO_AUDIO' | 'STALLED' | 'TOO_LONG' | 'SOURCE_ERROR' | 'EMPTY' | 'BAD_AUDIO';
export interface SpeechSink {
  /** A piece of mu-law 8 kHz audio. Pieces that arrive after the reply ended, was cancelled or failed are dropped and counted. */
  chunk(mulaw: Uint8Array): void;
  /** The source has sent all the audio. */
  end(): void;
  /** The source cannot go on. */
  fail(): void;
}
export interface SpeechHandle { cancel(): void }
export interface SpeechSource {
  /** Starts one line. May throw (counted as a failed start). Must not block. */
  start(request: SpeechRequest, sink: SpeechSink): SpeechHandle;
}

// ---------------------------------------------------------------- the splice
export interface SpeakerOptions {
  diag?: DiagSink;
  /** How long to wait for the first audio of a line. Default 4000. */
  firstAudioMs?: number;
  /** The longest quiet gap between pieces once audio has started. Default 2500. */
  gapMs?: number;
  /** The longest a line may take from start to end. Default 30000. */
  totalMs?: number;
  /** The longest line of text accepted, in characters. Default 1500. */
  maxChars?: number;
  /** The longest single piece accepted, in bytes. Default 65536. */
  maxChunkBytes?: number;
  /** The longest audio one line may hold, in milliseconds. Default 120000. */
  maxAudioMs?: number;
}
export interface SpeakerStats {
  replies: number; completed: number; cancelled: number; failed: number; chunksOut: number; lateDropped: number; fromVoiceDropped: number; refused: number; passedThrough: number;
}
export interface SpeakerSplice extends SpeakerSocket { stats(): SpeakerStats }

const PIECE_BYTES = 1600;   // 200 ms of mu-law: finer pieces give the bridge finer marks, so a cut reports a closer played time
const BYTES_PER_MS = 8;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const within = (n: unknown, lo: number, hi: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi;

interface Reply {
  rid: string; mid: string; text: string; handle?: SpeechHandle;
  closed: boolean; dropAudio: boolean; chunks: number; bytes: number; began: number;
  firstTimer?: ReturnType<typeof setTimeout>; gapTimer?: ReturnType<typeof setTimeout>; totalTimer?: ReturnType<typeof setTimeout>;
}

export function withSpeaker(inner: SpeakerSocket, source: SpeechSource, settings: SpeakerSettings, options: SpeakerOptions = {}): SpeakerSplice {
  if (speakerSettingsProblems(settings).length > 0) throw new RangeError('the speaker settings are not acceptable');
  if (typeof source !== 'object' || source === null || typeof source.start !== 'function') throw new RangeError('the speech source must have a start function');
  const o = {
    firstAudioMs: options.firstAudioMs ?? 4000, gapMs: options.gapMs ?? 2500, totalMs: options.totalMs ?? 30_000,
    maxChars: options.maxChars ?? 1500, maxChunkBytes: options.maxChunkBytes ?? 65_536, maxAudioMs: options.maxAudioMs ?? 120_000,
  };
  if (!within(o.firstAudioMs, 1, 600_000) || !within(o.gapMs, 1, 600_000) || !within(o.totalMs, 1, 3_600_000) || !within(o.maxChars, 1, 20_000) || !within(o.maxChunkBytes, 1, 8_388_608) || !within(o.maxAudioMs, 1, 3_600_000)) {
    throw new RangeError('the speaker options are not acceptable');
  }
  const diag = options.diag ?? noDiag;
  const stats: SpeakerStats = { replies: 0, completed: 0, cancelled: 0, failed: 0, chunksOut: 0, lateDropped: 0, fromVoiceDropped: 0, refused: 0, passedThrough: 0 };
  let seq = 0;
  let active: Reply | undefined;
  let ended = false;
  let lateNoted = 0;

  // One serial delivery queue: events reach the bridge one at a time, later than the call that caused them (as over a real socket), never nested inside the bridge's own handler. Audio of a reply that
  // has since ended or been cancelled is dropped here, even if it was already queued.
  interface Out { msg: Record<string, unknown>; audioOf?: Reply }
  const queue: Out[] = [];
  let draining = false;
  const push = (msg: Record<string, unknown>, audioOf?: Reply): void => { queue.push({ msg, audioOf }); if (!draining) queueMicrotask(drain); };
  function drain(): void {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const e = queue.shift() as Out;
        if (ended) continue;
        if (e.audioOf !== undefined && e.audioOf.dropAudio) { stats.lateDropped++; if (lateNoted++ < 5) diag('SPEAKER_LATE_DROPPED', { n: stats.lateDropped, where: 'queued' }); continue; }
        try { splice.onMessage(JSON.stringify(e.msg)); } catch { /* the bridge never throws into the speaker */ }
      }
    } finally { draining = false; }
  }
  const errorEvent = (code: string, message: string, eventId: unknown): void => {
    stats.refused++;
    push({ type: 'error', error: { type: 'invalid_request_error', code, message, event_id: typeof eventId === 'string' ? eventId : null } });
  };

  function stopTimers(r: Reply): void {
    for (const t of [r.firstTimer, r.gapTimer, r.totalTimer]) if (t !== undefined) clearTimeout(t);
    r.firstTimer = undefined; r.gapTimer = undefined; r.totalTimer = undefined;
  }
  function cancelSource(r: Reply): void { try { r.handle?.cancel(); } catch { /* a source that cannot be cancelled still has its pieces dropped */ } }
  function finish(r: Reply, status: 'completed' | 'cancelled' | 'failed', why?: SpeechFailure): void {
    if (r.closed) return;
    r.closed = true;
    if (status !== 'completed') r.dropAudio = true;   // audio still queued for a cancelled or failed reply is dropped; a completed reply's queued audio is still delivered
    stopTimers(r);
    if (status !== 'completed') cancelSource(r);
    if (active === r) active = undefined;
    const audioMs = Math.floor(r.bytes / BYTES_PER_MS);
    if (status === 'completed') {
      stats.completed++;
      diag('SPEAKER_DONE', { chunks: r.chunks, audioMs, ms: Date.now() - r.began });
      // The words the source was given ARE the transcript: it speaks exactly them. (Pronunciation is not checked: see the header.)
      push({ type: 'response.output_audio_transcript.done', response_id: r.rid, transcript: r.text });
    } else if (status === 'cancelled') { stats.cancelled++; diag('SPEAKER_CANCELLED', { chunks: r.chunks, audioMs }); }
    else { stats.failed++; diag('SPEAKER_FAILED', { why: why ?? 'SOURCE_ERROR', chunks: r.chunks, audioMs }); }
    push({ type: 'response.done', response: { id: r.rid, status, metadata: { id: r.mid } } });
  }

  function onCreate(m: Record<string, unknown>): boolean {
    const eventId = m.event_id;
    const resp = isObj(m.response) ? m.response : undefined;
    const instr = resp !== undefined && typeof resp.instructions === 'string' ? resp.instructions : undefined;
    const meta = resp !== undefined && isObj(resp.metadata) ? resp.metadata : undefined;
    const mid = meta !== undefined && typeof meta.id === 'string' && meta.id.length >= 1 && meta.id.length <= 64 ? meta.id : undefined;
    if (instr === undefined || !instr.includes(SAY_PREFIX) || mid === undefined) { diag('SPEAKER_REFUSED', { why: 'not_fixed_line' }); errorEvent('invalid_request_error', 'the speaker says fixed lines only', eventId); return true; }
    if (active !== undefined) { diag('SPEAKER_REFUSED', { why: 'busy' }); errorEvent('conversation_already_has_active_response', 'a reply is already active', eventId); return true; }
    const text = wordsOf(instr);
    const r: Reply = { rid: `spk_${++seq}`, mid, text, closed: false, dropAudio: false, chunks: 0, bytes: 0, began: Date.now() };
    stats.replies++;
    active = r;
    push({ type: 'response.created', response: { id: r.rid, metadata: { id: mid } } });
    diag('SPEAKER_START', { chars: text.length });
    if (text.length === 0 || text.length > o.maxChars) { finish(r, 'failed', 'TOO_LONG'); return true; }
    const arm = (ms: number, why: SpeechFailure): ReturnType<typeof setTimeout> => { const t = setTimeout(() => finish(r, 'failed', why), ms); t.unref?.(); return t; };
    r.firstTimer = arm(o.firstAudioMs, 'NO_AUDIO');
    r.totalTimer = arm(o.totalMs, 'TOO_LONG');
    const sink: SpeechSink = {
      chunk(mulaw: Uint8Array): void {
        if (r.closed) { stats.lateDropped++; if (lateNoted++ < 5) diag('SPEAKER_LATE_DROPPED', { n: stats.lateDropped, where: 'source' }); return; }
        if (!(mulaw instanceof Uint8Array) || mulaw.length === 0 || mulaw.length > o.maxChunkBytes) { finish(r, 'failed', 'BAD_AUDIO'); return; }
        if ((r.bytes + mulaw.length) / BYTES_PER_MS > o.maxAudioMs) { finish(r, 'failed', 'TOO_LONG'); return; }
        if (r.firstTimer !== undefined) { clearTimeout(r.firstTimer); r.firstTimer = undefined; diag('SPEAKER_FIRST_AUDIO', { ms: Date.now() - r.began }); }
        if (r.gapTimer !== undefined) clearTimeout(r.gapTimer);
        r.gapTimer = arm(o.gapMs, 'STALLED');
        for (let at = 0; at < mulaw.length; at += PIECE_BYTES) {
          const piece = mulaw.subarray(at, Math.min(mulaw.length, at + PIECE_BYTES));
          r.chunks++; r.bytes += piece.length; stats.chunksOut++;
          push({ type: 'response.output_audio.delta', response_id: r.rid, delta: Buffer.from(piece).toString('base64') }, r);
        }
      },
      end(): void {
        if (r.closed) { stats.lateDropped++; return; }
        if (r.bytes === 0) { finish(r, 'failed', 'EMPTY'); return; }
        finish(r, 'completed');
      },
      fail(): void { if (r.closed) { stats.lateDropped++; return; } finish(r, 'failed', 'SOURCE_ERROR'); },
    };
    try { r.handle = source.start(Object.freeze({ text, voiceId: settings.voiceId, modelId: settings.modelId, speed: settings.speed, outputFormat: settings.outputFormat }), sink); }
    catch { finish(r, 'failed', 'START_FAILED'); }
    if (r.closed) cancelSource(r);   // a source that finished or failed before `start` returned has nothing more to do, but a handle that arrived late is still told
    return true;
  }
  function onCancel(m: Record<string, unknown>): boolean {
    const rid = typeof m.response_id === 'string' ? m.response_id : undefined;
    const r = active;
    if (rid === undefined) { errorEvent('invalid_request_error', 'a cancel must name a reply', m.event_id); return true; }
    if (r === undefined || r.rid !== rid || r.closed) { errorEvent('response_cancel_not_active', 'that reply is not playing', m.event_id); return true; }
    finish(r, 'cancelled');
    return true;
  }

  const splice: SpeakerSplice = {
    send(text: string): boolean {
      if (ended) return false;
      let m: unknown;
      try { m = JSON.parse(text); } catch { return inner.send(text); }
      if (isObj(m) && m.type === 'response.create') return onCreate(m);
      if (isObj(m) && m.type === 'response.cancel') return onCancel(m);
      stats.passedThrough++;
      return inner.send(text);
    },
    close(code?: number): void {
      if (ended) return;
      ended = true;
      if (active !== undefined) { const r = active; r.closed = true; r.dropAudio = true; stopTimers(r); cancelSource(r); active = undefined; }
      queue.length = 0;
      inner.close(code);
    },
    onOpen: () => {}, onMessage: () => {}, onClose: () => {},
    stats: () => ({ ...stats }),
  };
  inner.onOpen = (): void => { if (!ended) splice.onOpen(); };
  inner.onClose = (): void => { ended = true; if (active !== undefined) { const r = active; r.closed = true; r.dropAudio = true; stopTimers(r); cancelSource(r); active = undefined; } queue.length = 0; splice.onClose(); };
  inner.onMessage = (text: string): void => {
    if (ended) return;
    let type: unknown;
    try { const m = JSON.parse(text); type = isObj(m) ? m.type : undefined; } catch { type = undefined; }
    // The voice service is never asked to reply, so any reply event from it is unexpected: it is dropped, so its audio can never reach the phone.
    if (typeof type === 'string' && type.startsWith('response.')) { stats.fromVoiceDropped++; diag('SPEAKER_VOICE_EVENT_DROPPED', { type: /^[a-z_.]{3,60}$/.test(type) ? type : 'other' }); return; }
    splice.onMessage(text);
  };
  return splice;
}
