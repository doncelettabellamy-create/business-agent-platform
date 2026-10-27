// The connection between one phone call and the OpenAI voice service (step 5 of the OpenAI plan; OFFLINE ONLY). realtime-transport.ts speaks to the voice service through an abstract
// RealtimeLink; this file is the link: it joins the phone's two-way audio stream (a Twilio Media Streams style connection, the same RelayConnection the server already accepts) to a
// VoiceSocket (a WebSocket to the voice service, handed in). It adds no decisions about the call: consent, masking, questions, read-backs and limits stay in relay-handler.ts.
//
//   phone -> voice   caller audio, as base64 mu-law 8 kHz frames, forwarded as audio-buffer appends. NOTHING is forwarded until the consent notice has been heard by the caller
//                    (held back, not buffered, counted); after the call logic ends the call, nothing more is forwarded. Frames are validated and size-capped.
//   voice -> phone   the audio of the replies, forwarded frame by frame, each followed by a mark so the phone says when it was actually played. The audio itself is never passed on
//                    to the adapter, and nothing is logged. A reply is reported finished only after the phone has PLAYED it all (a marker that never comes back is reported as incomplete,
//                    which makes the call logic send the question again rather than treat it as heard).
//   interruption     when the caller starts talking over a reply that may be talked over, the bridge works out how much of it was really played (from the phone's marks), tells the
//                    adapter (`x_played_ms`), and clears the phone's queued audio. A reply that may not be talked over (the notice, a read-back) is never cleared.
//   hang-up          the call is ended by closing the phone stream (the TwiML must continue with a hang-up verb), so no phone-provider credential is needed here.
//
// WHAT THIS DOES NOT DO: it has never talked to the real voice service or the real phone layer. Every message and field name on both sides (Media Streams `start`, `media`, `mark`, `clear`;
// the voice service's audio-format settings, audio deltas and transcripts; whether a mark's echo can be trusted as "played") follows documentation read on 2026-10-27 and is UNVERIFIED.
// It reads no environment variable, holds no key, opens no connection (the composition root will build the VoiceSocket and the key), and nothing in src imports it yet.
//
// PRIVACY: the caller's raw audio is sent to the voice service (the founder accepted that for invented-detail tests only). The first things sent are the settings and the notice text; the
// caller's first words (their answer to the consent notice) DO reach the voice service before the server has checked that answer. That is the consent-before-audio gap, narrowed but not closed.

import type { CallTransport } from './call-transport.ts';
import type { CloseInfo, RelayConnection } from './ws-server.ts';
import { createRealtimeTransport } from './realtime-transport.ts';
import type { RealtimeLink, RealtimeOptions } from './realtime-transport.ts';
import { isRecord } from './contracts.ts';

/** A WebSocket to the voice service, text frames only. A fake with this shape is used in tests; the real one is built by the composition root, with the key. */
export interface VoiceSocket {
  /** Sends one text frame. False when the socket is not open or is too slow to take it. */
  send(text: string): boolean;
  close(code?: number): void;
  /** Set by the bridge. Called once when the socket is open and ready for messages. */
  onOpen: () => void;
  /** Set by the bridge. Called with each text frame. */
  onMessage: (text: string) => void;
  /** Set by the bridge. Called once when the socket ends for any reason. */
  onClose: () => void;
}

export interface BridgeOptions {
  /** The audio format of both sides (one value, no conversion). Default 'audio/pcmu': mu-law 8 kHz, which is what the phone sends. */
  audioFormat?: 'audio/pcmu';
  /** How long to wait for the voice socket to open once the phone has started. Default 8000. */
  openWaitMs?: number;
  /** The most a call may last, whatever the call logic says; an independent ceiling on audio cost. Default 600000 (10 minutes). */
  maxCallMs?: number;
  /** After a reply's audio has all been sent, how long past its length to wait for the phone to confirm it was played. Default 3000. */
  playGraceMs?: number;
  /** The largest caller audio frame accepted, in decoded bytes (a 20 ms frame is 160). Default 1600. */
  maxFrameBytes?: number;
  /** The largest voice-service message accepted, in characters. Default 262144. */
  maxVoiceChars?: number;
  /** Consecutive caller frames the voice socket may refuse before the call is ended. Default 100. */
  maxRefused?: number;
}

/** Counts only: no audio, no speech, no ids. */
export interface BridgeStats {
  audioIn: number; audioHeldBack: number; audioBad: number; audioRefused: number; audioOut: number; marksLate: number; voiceBad: number; cleared: number;
}

const BYTES_PER_MS = 8;   // mu-law, 8 kHz, one byte per sample
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
const decodedLength = (b64: string): number => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
const str = (x: unknown, max: number): string | undefined => (typeof x === 'string' && x.length > 0 && x.length <= max ? x : undefined);

interface Resp { id: string; sentMs: number; ackedMs: number; marks: Map<string, number>; lost?: boolean; finished?: { message: Record<string, unknown>; timer?: ReturnType<typeof setTimeout> }; cleared: boolean }

export function createRealtimeBridge(phone: RelayConnection, voice: VoiceSocket, options: BridgeOptions = {}): { link: RealtimeLink; stats(): BridgeStats } {
  const o = { openWaitMs: options.openWaitMs ?? 8000, maxCallMs: options.maxCallMs ?? 600_000, playGraceMs: options.playGraceMs ?? 3000, maxFrameBytes: options.maxFrameBytes ?? 1600, maxVoiceChars: options.maxVoiceChars ?? 262_144, maxRefused: options.maxRefused ?? 100 };
  const fmt = options.audioFormat ?? 'audio/pcmu';
  if (fmt !== 'audio/pcmu' || [o.openWaitMs, o.maxCallMs, o.playGraceMs, o.maxFrameBytes, o.maxVoiceChars, o.maxRefused].some((n) => !Number.isInteger(n) || n < 1 || n > 3_600_000)) {
    throw new RangeError('the bridge options are not acceptable');
  }
  const stats: BridgeStats = { audioIn: 0, audioHeldBack: 0, audioBad: 0, audioRefused: 0, audioOut: 0, marksLate: 0, voiceBad: 0, cleared: 0 };
  let streamSid: string | undefined;
  let started: { to: unknown; callSid: unknown } | undefined;
  let voiceOpen = false;
  let announced = false;
  let ended = false;
  let firstDone = false;
  let noticeHeard = false;          // the caller has heard the consent notice to the end: only now is caller audio forwarded
  let interruptible = true;         // as last set by the adapter's session settings
  let refused = 0;
  let markSeq = 0;
  const responses = new Map<string, Resp>();
  const markOwner = new Map<string, string>();   // mark name -> response id
  let timers: Array<ReturnType<typeof setTimeout>> = [];
  const later = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => { const t = setTimeout(fn, ms); t.unref?.(); timers.push(t); return t; };

  const toAdapter = (m: unknown): void => { try { link.onMessage(m); } catch { /* the adapter never throws into the bridge */ } };
  function finishCall(info: CloseInfo, closePhone: boolean): void {
    if (ended) return;
    ended = true;
    for (const t of timers) clearTimeout(t);
    timers = [];
    for (const r of responses.values()) if (r.finished?.timer !== undefined) clearTimeout(r.finished.timer);
    responses.clear(); markOwner.clear();
    try { voice.close(1000); } catch { /* already gone */ }
    if (closePhone) { try { phone.close(1000); } catch { /* already gone */ } }
    try { link.onClose(info); } catch { /* the adapter never throws into the bridge */ }
  }
  function announce(): void {
    if (announced || ended || started === undefined || !voiceOpen) return;
    announced = true;
    toAdapter({ type: 'carrier.start', to: started.to, callSid: started.callSid });
  }

  // ---------------------------------------------------------------- voice service -> adapter and phone
  function release(r: Resp, status?: string): void {
    const f = r.finished;
    if (f === undefined) return;
    if (f.timer !== undefined) clearTimeout(f.timer);
    responses.delete(r.id);
    for (const name of r.marks.keys()) markOwner.delete(name);
    const msg = status === undefined ? f.message : { ...f.message, response: { ...(isRecord(f.message.response) ? f.message.response : {}), status } };
    // The first reply is the consent notice; only one that was fully played opens the caller's microphone to the voice service.
    if (!firstDone) { firstDone = true; const s = isRecord(msg.response) ? msg.response.status : undefined; noticeHeard = s === 'completed'; }
    toAdapter(msg);
  }
  function onVoice(text: string): void {
    if (ended) return;
    if (text.length > o.maxVoiceChars) { stats.voiceBad++; return; }
    let m: unknown;
    try { m = JSON.parse(text); } catch { stats.voiceBad++; toAdapter(null); return; }
    if (!isRecord(m) || typeof m.type !== 'string') { toAdapter(m); return; }
    const msg = m as Record<string, unknown>;
    switch (msg.type) {
      case 'response.created': {
        const rid = isRecord(msg.response) ? str(msg.response.id, 200) : undefined;
        if (rid !== undefined && !responses.has(rid)) responses.set(rid, { id: rid, sentMs: 0, ackedMs: 0, marks: new Map(), cleared: false });
        toAdapter(msg); return;
      }
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        const rid = str(msg.response_id, 200); const delta = str(msg.delta, o.maxVoiceChars);
        const r = rid === undefined ? undefined : responses.get(rid);
        if (r === undefined || r.cleared || delta === undefined || !B64.test(delta) || streamSid === undefined) { stats.voiceBad += r === undefined || r.cleared ? 0 : 1; return; }   // audio of a cleared reply is dropped
        const bytes = decodedLength(delta);
        const name = `m${++markSeq}`;
        if (!phone.send({ event: 'media', streamSid, media: { payload: delta } }) || !phone.send({ event: 'mark', streamSid, mark: { name } })) { r.lost = true; return; }   // some of it never reached the phone: it will be reported as incomplete
        r.sentMs += bytes / BYTES_PER_MS;
        r.marks.set(name, r.sentMs); markOwner.set(name, r.id);
        stats.audioOut++;
        return;   // the audio itself never goes to the adapter
      }
      case 'response.done': {
        const rid = isRecord(msg.response) ? str(msg.response.id, 200) : undefined;
        const r = rid === undefined ? undefined : responses.get(rid);
        const status = isRecord(msg.response) ? msg.response.status : undefined;
        if (r === undefined || r.cleared || status !== 'completed' || r.marks.size === 0 || r.lost === true) {
          if (r !== undefined) { r.finished = { message: msg }; release(r, r.lost === true && status === 'completed' ? 'incomplete' : undefined); } else toAdapter(msg);
          return;
        }
        // Everything was sent, but it counts as finished only when the phone says it was played; a marker that never returns is reported as incomplete (fail closed).
        const wait = Math.max(0, r.sentMs - r.ackedMs) + o.playGraceMs;
        r.finished = { message: msg };
        r.finished.timer = later(() => { if (responses.get(r.id) === r) release(r, 'incomplete'); }, wait);
        return;
      }
      case 'input_audio_buffer.speech_started': {
        // The reply that is playing, if any: the one with audio the phone has not confirmed played.
        const playing = [...responses.values()].find((r) => !r.cleared && r.marks.size > 0);
        if (playing !== undefined && interruptible) {
          const playedMs = Math.floor(playing.ackedMs);
          playing.cleared = true;
          for (const name of playing.marks.keys()) markOwner.delete(name);
          playing.marks.clear();
          if (streamSid !== undefined) phone.send({ event: 'clear', streamSid });
          stats.cleared++;
          toAdapter({ ...msg, x_played_ms: playedMs });   // the call logic hears of the interruption first
          if (playing.finished !== undefined) release(playing, 'cancelled');   // then a reply that had all been sent is closed: its audio is gone
        } else toAdapter(msg);
        return;
      }
      default: toAdapter(msg);
    }
  }

  // ---------------------------------------------------------------- phone -> voice service
  function onPhone(text: string): void {
    if (ended) return;
    let m: unknown;
    try { m = JSON.parse(text); } catch { stats.audioBad++; return; }
    if (!isRecord(m) || typeof m.event !== 'string') { stats.audioBad++; return; }
    switch (m.event) {
      case 'start': {
        const s = isRecord(m.start) ? m.start : undefined;
        const sid = s === undefined ? undefined : str(s.streamSid, 100);
        const fmtOk = s !== undefined && isRecord(s.mediaFormat) && s.mediaFormat.encoding === 'audio/x-mulaw' && s.mediaFormat.sampleRate === 8000;
        if (started !== undefined) return;   // a second start is ignored
        if (s === undefined || sid === undefined || !fmtOk) { finishCall({ cause: 'PROTOCOL', code: 1008 }, true); return; }   // not the audio we can carry: refuse the call
        streamSid = sid;
        started = { to: isRecord(s.customParameters) ? s.customParameters.to : undefined, callSid: s.callSid };
        later(() => { if (!announced) finishCall({ cause: 'PROTOCOL', code: 1011 }, true); }, o.openWaitMs);   // the voice socket never opened
        announce();
        return;
      }
      case 'media': {
        const payload = isRecord(m.media) ? m.media.payload : undefined;
        if (typeof payload !== 'string' || payload.length === 0 || !B64.test(payload) || decodedLength(payload) > o.maxFrameBytes) { stats.audioBad++; return; }
        if (!announced || !noticeHeard) { stats.audioHeldBack++; return; }   // not forwarded, not kept: the caller's microphone is closed to the voice service until the notice has been played
        stats.audioIn++;
        if (voice.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: payload }))) refused = 0;
        else { stats.audioRefused++; if (++refused >= o.maxRefused) finishCall({ cause: 'PROTOCOL', code: 1011 }, true); }
        return;
      }
      case 'mark': {
        const name = isRecord(m.mark) ? m.mark.name : undefined;
        const rid = typeof name === 'string' ? markOwner.get(name) : undefined;
        const r = rid === undefined ? undefined : responses.get(rid);
        if (typeof name !== 'string' || r === undefined) { stats.marksLate++; return; }   // a marker of a cleared or finished reply
        const upto = r.marks.get(name) ?? 0;
        r.marks.delete(name); markOwner.delete(name);
        r.ackedMs = Math.max(r.ackedMs, upto);
        if (r.marks.size === 0 && r.finished !== undefined) release(r);
        return;
      }
      case 'stop': finishCall({ cause: 'PEER', code: 1000 }, false); return;
      default: return;   // connected, dtmf and the rest: not used
    }
  }

  const link: RealtimeLink = {
    send(message: unknown): boolean {
      if (ended || !voiceOpen) return false;
      let out = message;
      if (isRecord(message) && message.type === 'session.update' && isRecord(message.session)) {
        // The phone carries mu-law: both directions are set to it here, so the adapter stays free of carrier details. A copy, never the adapter's object.
        const s = message.session as Record<string, unknown>;
        const audio = isRecord(s.audio) ? s.audio : {};
        const input = isRecord(audio.input) ? audio.input : {};
        const output = isRecord(audio.output) ? audio.output : {};
        if (isRecord(input.turn_detection) && typeof input.turn_detection.interrupt_response === 'boolean') interruptible = input.turn_detection.interrupt_response;
        out = { ...message, session: { ...s, audio: { ...audio, input: { ...input, format: { type: fmt } }, output: { ...output, format: { type: fmt } } } } };
      }
      try { return voice.send(JSON.stringify(out)); } catch { return false; }
    },
    hangup(): boolean {
      if (ended) return false;
      finishCall({ cause: 'HANDLER', code: 1000 }, true);   // closing the stream ends the call: the TwiML continues with a hang-up verb
      return true;
    },
    close(code?: number): void { finishCall({ cause: 'HANDLER', code: code ?? 1000 }, true); },
    onMessage: () => {},
    onClose: () => {},
  };

  phone.onMessage = (t: string): void => { try { onPhone(t); } catch { stats.audioBad++; } };
  phone.onClose = (): void => { finishCall({ cause: 'PEER', code: 1000 }, false); };
  voice.onOpen = (): void => { voiceOpen = true; announce(); };
  voice.onMessage = (t: string): void => { try { onVoice(t); } catch { stats.voiceBad++; } };
  voice.onClose = (): void => { finishCall({ cause: 'PEER', code: 1006 }, true); };
  later(() => finishCall({ cause: 'IDLE', code: 1000 }, true), o.maxCallMs);   // the independent ceiling on one call
  return { link, stats: () => ({ ...stats }) };
}

/** Everything one call needs, in one place: the phone stream, the voice socket, and the adapter options (the notice, the voice, the persona). Hands the transport to the call logic. */
export function startRealtimeCall(phone: RelayConnection, voice: VoiceSocket, serve: (transport: CallTransport) => void, realtime: RealtimeOptions, bridge?: BridgeOptions): { stats(): BridgeStats } {
  const b = createRealtimeBridge(phone, voice, bridge);
  serve(createRealtimeTransport(b.link, realtime));
  return { stats: b.stats };
}
