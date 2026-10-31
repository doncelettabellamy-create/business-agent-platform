// OFFLINE speaker adapter (proof of concept). A VoiceSocket decorator that lets the caller's words keep going to the OpenAI voice service for LISTENING while every fixed line the call logic
// asks the voice to say is SPOKEN by a separate speech source (the ElevenLabs candidate, "Jack", reached later) instead of by OpenAI. NOTHING HERE IS CONNECTED: it opens no socket, reads no
// key and imports no network or file API; the only source it has ever been run with is a test stand-in. It is selected only by the switch in founder-voice-speaker.ts (off by default), so the
// current speaker path (OpenAI speaks) is unchanged unless the voice config says otherwise.
//
//   bridge  <->  SpeakerSplice  <->  OpenAI voice socket
//
// To the bridge the splice looks like the voice service: for each `response.create` that asks for fixed words ("Say exactly the following words ...") it answers with the same events the voice
// service would send (`response.created`, `response.output_audio.delta` as base64 mu-law 8 kHz, `response.output_audio_transcript.done`, `response.done`). The bridge and the transport are
// therefore UNCHANGED: marks, measured playback (`x_sent_ms`/`x_acked_ms`), the clear on caller speech, `x_played_ms`, and the call logic's CUT / CONFIRM_HELD rules all work as before.
//   * `response.create` and `response.cancel` are answered here. Everything else (caller audio, settings, deleting transcript items) passes through.
//   * CANCELLATION: a cancel stops whatever is speaking the line (the source request, or the fallback below), answers `response.done` with status cancelled once, and every audio piece that
//     arrives afterwards (or was queued) is dropped and counted. A cancel of a reply that already ended is answered with the error the voice service gives (`response_cancel_not_active`).
//   * FALLBACK, the first-test rule: if the source fails and **zero source audio was handed on** (it could not start, answered with an error or no audio, sent nothing usable, or ended empty), OpenAI
//     speaks the SAME line instead, as one reply: the original request goes to OpenAI and its events are relayed under the same reply id. There is no hold buffer and no estimate of playout time:
//     once a single piece of source audio has been handed on, there is no fallback.
//   * THE CALL ENDS, within a defined time, when (a) the source fails AFTER audio started, or (b) the fallback fails (OpenAI errors, answers with no audio in time, or does not complete). The
//     line is answered `failed` with no transcript (so it never counts as heard), a `x_speaker_down` event tells the call logic (which saves what was collected as an incomplete, unconfirmed
//     call and ends it), and `endDelayMs` later the splice closes the voice socket itself as a backstop. After that no line is spoken. The caller hears the line close: when both voices are
//     down nothing can explain it aloud.
//   * The transcript the transport compares with the requested words is the requested words themselves for a source line (the source speaks exactly the text it was given). That removes the
//     check that the voice said the right words; how the source PRONOUNCES them (digits, house numbers, amounts) is NOT checked and stays unverified until it is listened to. A fallback line
//     carries OpenAI's own transcript, so the check applies to it.
//   * Any `response.*` event OpenAI sends that does not belong to an active fallback reply is dropped and counted. Only the "say exactly" lines are handled; a voice's own words are refused.
//
// PRIVACY: the text of a line goes to the source, and (only on a fallback) to OpenAI, as the same line does today. The splice stores no text, logs no text, and its diagnostics are fixed codes
// and numbers. It never sees the caller's audio.

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
/** Why the call was ended: a source failure after audio started, or a failure of the fallback. Fixed words. */
export type EndReason = SpeechFailure | 'FALLBACK_SEND_FAILED' | 'FALLBACK_NO_AUDIO' | 'FALLBACK_STALLED' | 'FALLBACK_TOO_LONG' | 'FALLBACK_FAILED' | 'FALLBACK_BAD_AUDIO';
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
  /** How long to wait for the first audio of a line from the source. Default 4000. */
  firstAudioMs?: number;
  /** The longest quiet gap between pieces from the source once audio has started. Default 2500. */
  gapMs?: number;
  /** The longest a source line may take from start to end. Default 30000. */
  totalMs?: number;
  /** The longest line of text accepted, in characters. Default 1500. */
  maxChars?: number;
  /** The longest single piece accepted, in bytes. Default 65536. */
  maxChunkBytes?: number;
  /** The longest audio one line may hold, in milliseconds. Default 120000. */
  maxAudioMs?: number;
  /** How long to wait for the FALLBACK's first audio from OpenAI. Default 4000. */
  fallbackFirstAudioMs?: number;
  /** The longest quiet gap in the fallback's audio. Default 2500. */
  fallbackGapMs?: number;
  /** The longest the fallback may take, start to end. Default 30000. */
  fallbackTotalMs?: number;
  /** After a failure that ends the call: how long to let the failure reach the call logic before the splice closes the voice socket itself. Default 300. */
  endDelayMs?: number;
}
export interface SpeakerStats {
  replies: number; completed: number; cancelled: number; failed: number; chunksOut: number; lateDropped: number; fromVoiceDropped: number; refused: number; passedThrough: number;
  /** Lines OpenAI spoke because the source failed with zero audio handed on. */
  fallbacks: number;
  /** Times the call was ended because of a speaker failure. */
  callEnds: number;
}
export interface SpeakerSplice extends SpeakerSocket { stats(): SpeakerStats }

const PIECE_BYTES = 1600;   // 200 ms of mu-law: finer pieces give the bridge finer marks, so a cut reports a closer played time
const BYTES_PER_MS = 8;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const within = (n: unknown, lo: number, hi: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi;
const decodedLength = (b64: string): number => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

interface Reply {
  rid: string; mid: string; text: string; original: string; handle?: SpeechHandle;
  /** 'source': the speech source is speaking. 'fallback': OpenAI speaks the same line. */
  phase: 'source' | 'fallback';
  closed: boolean; dropAudio: boolean; chunks: number; bytes: number; began: number;
  /** The fallback's own reply id from OpenAI, once known; and a cancel that arrived before it was. */
  fbRid?: string; fbBytes: number;
  firstTimer?: ReturnType<typeof setTimeout>; gapTimer?: ReturnType<typeof setTimeout>; totalTimer?: ReturnType<typeof setTimeout>;
}

export function withSpeaker(inner: SpeakerSocket, source: SpeechSource, settings: SpeakerSettings, options: SpeakerOptions = {}): SpeakerSplice {
  if (speakerSettingsProblems(settings).length > 0) throw new RangeError('the speaker settings are not acceptable');
  if (typeof source !== 'object' || source === null || typeof source.start !== 'function') throw new RangeError('the speech source must have a start function');
  const o = {
    firstAudioMs: options.firstAudioMs ?? 4000, gapMs: options.gapMs ?? 2500, totalMs: options.totalMs ?? 30_000,
    maxChars: options.maxChars ?? 1500, maxChunkBytes: options.maxChunkBytes ?? 65_536, maxAudioMs: options.maxAudioMs ?? 120_000,
    fbFirstMs: options.fallbackFirstAudioMs ?? 4000, fbGapMs: options.fallbackGapMs ?? 2500, fbTotalMs: options.fallbackTotalMs ?? 30_000, endDelayMs: options.endDelayMs ?? 300,
  };
  if (!within(o.firstAudioMs, 1, 600_000) || !within(o.gapMs, 1, 600_000) || !within(o.totalMs, 1, 3_600_000) || !within(o.maxChars, 1, 20_000) || !within(o.maxChunkBytes, 1, 8_388_608) || !within(o.maxAudioMs, 1, 3_600_000)
    || !within(o.fbFirstMs, 1, 600_000) || !within(o.fbGapMs, 1, 600_000) || !within(o.fbTotalMs, 1, 3_600_000) || !within(o.endDelayMs, 0, 60_000)) {
    throw new RangeError('the speaker options are not acceptable');
  }
  const diag = options.diag ?? noDiag;
  const stats: SpeakerStats = { replies: 0, completed: 0, cancelled: 0, failed: 0, chunksOut: 0, lateDropped: 0, fromVoiceDropped: 0, refused: 0, passedThrough: 0, fallbacks: 0, callEnds: 0 };
  let seq = 0;
  let active: Reply | undefined;
  let ended = false;          // the voice socket is closed (by the bridge, by the voice service, or by this splice)
  let down = false;           // a speaker failure ended the call: no further line is spoken
  let endTimer: ReturnType<typeof setTimeout> | undefined;
  let lateNoted = 0;
  /** Message ids of fallback requests whose reply was cancelled before OpenAI named it: when it is named, it is cancelled too. */
  const orphanMids = new Set<string>();

  // One serial delivery queue: events reach the bridge one at a time, later than the call that caused them (as over a real socket), never nested inside the bridge's own handler. Audio of a reply that
  // has since been cancelled or has failed is dropped here, even if it was already queued.
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
  const arm = (r: Reply, ms: number, fire: () => void): ReturnType<typeof setTimeout> => { const t = setTimeout(fire, ms); t.unref?.(); return t; };
  /** Asks OpenAI to stop the fallback reply (or remembers to, once OpenAI names it). */
  function cancelFallback(r: Reply, eventId?: unknown): void {
    if (r.phase !== 'fallback') return;
    if (r.fbRid !== undefined) inner.send(JSON.stringify({ type: 'response.cancel', response_id: r.fbRid, ...(typeof eventId === 'string' ? { event_id: eventId } : {}) }));
    else orphanMids.add(r.mid);
  }

  /** Ends a reply that completed, was cancelled, or (without ending the call) is finished for another reason. */
  function finish(r: Reply, status: 'completed' | 'cancelled', transcript?: string): void {
    if (r.closed) return;
    r.closed = true;
    if (status === 'cancelled') r.dropAudio = true;   // audio still queued for a cancelled reply is dropped; a completed reply's queued audio is still delivered
    stopTimers(r);
    if (status === 'cancelled') { cancelSource(r); cancelFallback(r); }
    if (active === r) active = undefined;
    const audioMs = Math.floor((r.bytes + r.fbBytes) / BYTES_PER_MS);
    if (status === 'completed') {
      stats.completed++;
      diag('SPEAKER_DONE', { chunks: r.chunks, audioMs, ms: Date.now() - r.began, via: r.phase === 'fallback' ? 'FALLBACK' : 'SOURCE' });
      // A source line's transcript is the words it was given (it speaks exactly them); a fallback line carries OpenAI's own transcript.
      if (transcript !== undefined) push({ type: 'response.output_audio_transcript.done', response_id: r.rid, transcript });
    } else { stats.cancelled++; diag('SPEAKER_CANCELLED', { chunks: r.chunks, audioMs }); }
    push({ type: 'response.done', response: { id: r.rid, status, metadata: { id: r.mid } } });
  }

  /** The speaker cannot go on: the line is answered failed (no transcript), the call logic is told, and the voice socket is closed after a short, defined delay. */
  function endCall(r: Reply, why: EndReason): void {
    if (r.closed) return;
    r.closed = true; r.dropAudio = true;
    stopTimers(r); cancelSource(r); cancelFallback(r);
    if (active === r) active = undefined;
    down = true; stats.failed++; stats.callEnds++;
    diag('SPEAKER_FAILED', { why, chunks: r.chunks, audioMs: Math.floor((r.bytes + r.fbBytes) / BYTES_PER_MS), phase: r.phase === 'fallback' ? 'FALLBACK' : 'SOURCE' });
    diag('SPEAKER_CALL_END', { why, delayMs: o.endDelayMs });
    push({ type: 'response.done', response: { id: r.rid, status: 'failed', metadata: { id: r.mid } } });
    push({ type: 'x_speaker_down' });
    endTimer = setTimeout(() => {
      endTimer = undefined;
      if (ended) return;
      ended = true; queue.length = 0;
      try { inner.close(1011); } catch { /* already closed */ }
      splice.onClose();
    }, o.endDelayMs);
    endTimer.unref?.();
  }

  /** The source failed. Zero source audio handed on: OpenAI speaks the same line. Any audio handed on: the call ends. */
  function sourceFailed(r: Reply, why: SpeechFailure): void {
    if (r.closed || r.phase !== 'source') return;
    if (r.bytes > 0) { endCall(r, why); return; }
    stopTimers(r); cancelSource(r);
    r.phase = 'fallback';
    stats.fallbacks++;
    diag('SPEAKER_FALLBACK', { why });
    let sent = false;
    try { sent = inner.send(r.original); } catch { sent = false; }
    if (!sent) { endCall(r, 'FALLBACK_SEND_FAILED'); return; }
    r.firstTimer = arm(r, o.fbFirstMs, () => endCall(r, 'FALLBACK_NO_AUDIO'));
    r.totalTimer = arm(r, o.fbTotalMs, () => endCall(r, 'FALLBACK_TOO_LONG'));
  }

  function onCreate(m: Record<string, unknown>, raw: string): boolean {
    const eventId = m.event_id;
    const resp = isObj(m.response) ? m.response : undefined;
    const instr = resp !== undefined && typeof resp.instructions === 'string' ? resp.instructions : undefined;
    const meta = resp !== undefined && isObj(resp.metadata) ? resp.metadata : undefined;
    const mid = meta !== undefined && typeof meta.id === 'string' && meta.id.length >= 1 && meta.id.length <= 64 ? meta.id : undefined;
    if (down) { diag('SPEAKER_REFUSED', { why: 'down' }); return false; }
    if (instr === undefined || !instr.includes(SAY_PREFIX) || mid === undefined) { diag('SPEAKER_REFUSED', { why: 'not_fixed_line' }); errorEvent('invalid_request_error', 'the speaker says fixed lines only', eventId); return true; }
    if (active !== undefined) { diag('SPEAKER_REFUSED', { why: 'busy' }); errorEvent('conversation_already_has_active_response', 'a reply is already active', eventId); return true; }
    const text = wordsOf(instr);
    const r: Reply = { rid: `spk_${++seq}`, mid, text, original: raw, phase: 'source', closed: false, dropAudio: false, chunks: 0, bytes: 0, began: Date.now(), fbBytes: 0 };
    stats.replies++;
    active = r;
    push({ type: 'response.created', response: { id: r.rid, metadata: { id: mid } } });
    diag('SPEAKER_START', { chars: text.length });
    if (text.length === 0 || text.length > o.maxChars) { sourceFailed(r, 'TOO_LONG'); return true; }
    r.firstTimer = arm(r, o.firstAudioMs, () => sourceFailed(r, 'NO_AUDIO'));
    r.totalTimer = arm(r, o.totalMs, () => sourceFailed(r, 'TOO_LONG'));
    const sink: SpeechSink = {
      chunk(mulaw: Uint8Array): void {
        if (r.closed || r.phase !== 'source') { stats.lateDropped++; if (lateNoted++ < 5) diag('SPEAKER_LATE_DROPPED', { n: stats.lateDropped, where: 'source' }); return; }
        if (!(mulaw instanceof Uint8Array) || mulaw.length === 0 || mulaw.length > o.maxChunkBytes) { sourceFailed(r, 'BAD_AUDIO'); return; }
        if ((r.bytes + mulaw.length) / BYTES_PER_MS > o.maxAudioMs) { sourceFailed(r, 'TOO_LONG'); return; }
        if (r.firstTimer !== undefined) { clearTimeout(r.firstTimer); r.firstTimer = undefined; diag('SPEAKER_FIRST_AUDIO', { ms: Date.now() - r.began }); }
        if (r.gapTimer !== undefined) clearTimeout(r.gapTimer);
        r.gapTimer = arm(r, o.gapMs, () => sourceFailed(r, 'STALLED'));
        for (let at = 0; at < mulaw.length; at += PIECE_BYTES) {
          const piece = mulaw.subarray(at, Math.min(mulaw.length, at + PIECE_BYTES));
          r.chunks++; r.bytes += piece.length; stats.chunksOut++;
          push({ type: 'response.output_audio.delta', response_id: r.rid, delta: Buffer.from(piece).toString('base64') }, r);
        }
      },
      end(): void {
        if (r.closed || r.phase !== 'source') { stats.lateDropped++; return; }
        if (r.bytes === 0) { sourceFailed(r, 'EMPTY'); return; }
        finish(r, 'completed', r.text);
      },
      fail(): void { if (r.closed || r.phase !== 'source') { stats.lateDropped++; return; } sourceFailed(r, 'SOURCE_ERROR'); },
    };
    try { r.handle = source.start(Object.freeze({ text, voiceId: settings.voiceId, modelId: settings.modelId, speed: settings.speed, outputFormat: settings.outputFormat }), sink); }
    catch { sourceFailed(r, 'START_FAILED'); }
    if (r.closed || r.phase !== 'source') cancelSource(r);   // a source that finished or failed before `start` returned has nothing more to do, but a handle that arrived late is still told
    return true;
  }
  function onCancel(m: Record<string, unknown>): boolean {
    const rid = typeof m.response_id === 'string' ? m.response_id : undefined;
    const r = active;
    if (rid === undefined) { errorEvent('invalid_request_error', 'a cancel must name a reply', m.event_id); return true; }
    if (r === undefined || r.rid !== rid || r.closed) { errorEvent('response_cancel_not_active', 'that reply is not playing', m.event_id); return true; }
    if (r.phase === 'fallback') {
      // OpenAI is speaking this line: it is asked to stop (or will be, once it names the reply), and anything it still sends is dropped.
      if (r.fbRid !== undefined) inner.send(JSON.stringify({ type: 'response.cancel', response_id: r.fbRid, ...(typeof m.event_id === 'string' ? { event_id: m.event_id } : {}) }));
      else orphanMids.add(r.mid);
      r.phase = 'source';   // (the cancel is made here; finish() must not cancel the fallback a second time)
      r.fbRid = undefined;
    }
    finish(r, 'cancelled');
    return true;
  }

  /** Events OpenAI sends about the fallback reply are relayed under the splice's own reply id; anything else about a reply is dropped. */
  function fromVoice(text: string, type: string, m: Record<string, unknown>): void {
    const r = active;
    const resp = isObj(m.response) ? m.response : undefined;
    const meta = resp !== undefined && isObj(resp.metadata) ? resp.metadata : undefined;
    if (type === 'response.created' && typeof resp?.id === 'string' && typeof meta?.id === 'string') {
      if (orphanMids.has(meta.id)) { orphanMids.delete(meta.id); inner.send(JSON.stringify({ type: 'response.cancel', response_id: resp.id })); return; }
      if (r !== undefined && !r.closed && r.phase === 'fallback' && r.fbRid === undefined && meta.id === r.mid) { r.fbRid = resp.id; return; }
    }
    if (r === undefined || r.closed || r.phase !== 'fallback' || r.fbRid === undefined) { stats.fromVoiceDropped++; diag('SPEAKER_VOICE_EVENT_DROPPED', { type: /^[a-z_.]{3,60}$/.test(type) ? type : 'other' }); return; }
    const belongs = (type === 'response.done' ? resp?.id : m.response_id) === r.fbRid;
    if (!belongs) { stats.fromVoiceDropped++; diag('SPEAKER_VOICE_EVENT_DROPPED', { type: /^[a-z_.]{3,60}$/.test(type) ? type : 'other' }); return; }
    if (type === 'response.output_audio.delta' || type === 'response.audio.delta') {
      const delta = typeof m.delta === 'string' ? m.delta : undefined;
      if (delta === undefined || !B64.test(delta) || delta.length === 0) { endCall(r, 'FALLBACK_BAD_AUDIO'); return; }
      const n = decodedLength(delta);
      if ((r.fbBytes + n) / BYTES_PER_MS > o.maxAudioMs) { endCall(r, 'FALLBACK_TOO_LONG'); return; }
      if (r.firstTimer !== undefined) { clearTimeout(r.firstTimer); r.firstTimer = undefined; diag('SPEAKER_FALLBACK_FIRST_AUDIO', { ms: Date.now() - r.began }); }
      if (r.gapTimer !== undefined) clearTimeout(r.gapTimer);
      r.gapTimer = arm(r, o.fbGapMs, () => endCall(r, 'FALLBACK_STALLED'));
      r.fbBytes += n; stats.chunksOut++;
      push({ type: 'response.output_audio.delta', response_id: r.rid, delta }, r);
      return;
    }
    if (type === 'response.output_audio_transcript.done' || type === 'response.audio_transcript.done') {
      if (typeof m.transcript === 'string') push({ type: 'response.output_audio_transcript.done', response_id: r.rid, transcript: m.transcript });
      return;
    }
    if (type === 'response.done') {
      const status = resp !== undefined && typeof resp.status === 'string' ? resp.status : 'failed';
      if (status === 'completed' && r.fbBytes > 0) { finish(r, 'completed'); return; }   // the transcript, if any, was already relayed
      endCall(r, status === 'completed' ? 'FALLBACK_NO_AUDIO' : 'FALLBACK_FAILED');
      return;
    }
    // other events about the fallback reply (text deltas, output items, content parts): not needed by the bridge
    stats.fromVoiceDropped++;
  }

  const splice: SpeakerSplice = {
    send(text: string): boolean {
      if (ended) return false;
      let m: unknown;
      try { m = JSON.parse(text); } catch { return inner.send(text); }
      if (isObj(m) && m.type === 'response.create') return onCreate(m, text);
      if (isObj(m) && m.type === 'response.cancel') return onCancel(m);
      stats.passedThrough++;
      return inner.send(text);
    },
    close(code?: number): void {
      if (ended) return;
      ended = true;
      if (endTimer !== undefined) { clearTimeout(endTimer); endTimer = undefined; }
      if (active !== undefined) { const r = active; r.closed = true; r.dropAudio = true; stopTimers(r); cancelSource(r); active = undefined; }
      queue.length = 0;
      inner.close(code);
    },
    onOpen: () => {}, onMessage: () => {}, onClose: () => {},
    stats: () => ({ ...stats }),
  };
  inner.onOpen = (): void => { if (!ended) splice.onOpen(); };
  inner.onClose = (): void => {
    if (endTimer !== undefined) { clearTimeout(endTimer); endTimer = undefined; }
    const was = ended; ended = true;
    if (active !== undefined) { const r = active; r.closed = true; r.dropAudio = true; stopTimers(r); cancelSource(r); active = undefined; }
    queue.length = 0;
    if (!was) splice.onClose();
  };
  inner.onMessage = (text: string): void => {
    if (ended) return;
    let m: Record<string, unknown> | undefined; let type: unknown;
    try { const parsed = JSON.parse(text); if (isObj(parsed)) { m = parsed; type = parsed.type; } } catch { m = undefined; }
    // A reply event is relayed only when it belongs to the active fallback reply; any other is unexpected and dropped, so its audio can never reach the phone.
    if (m !== undefined && typeof type === 'string' && type.startsWith('response.')) { fromVoice(text, type, m); return; }
    splice.onMessage(text);
  };
  return splice;
}
