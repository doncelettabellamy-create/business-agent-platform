// OpenAI Realtime carrier for one phone call (step 3 of the OpenAI plan; OFFLINE ONLY). It implements the call logic's CallTransport (call-transport.ts) over a
// RealtimeLink, so the cleaning phone workflow in relay-handler.ts can run unchanged on a voice service that hears and speaks for itself, while OUR SERVER stays in charge
// of what is said (the design chosen as "Option 2"):
//
//   * The voice service is told never to speak on its own (automatic replies are switched off). It speaks only when this adapter asks, and the request carries the exact
//     words: the consent notice, a question the call logic worded, a fixed read-back, a fixed goodbye. Each request is out-of-band (conversation "none").
//   * What it said is checked against what was asked. A reply that fails, makes no sound, or says different words is reported to the call logic as `reply_failed`, so a
//     question the caller did not hear is never treated as asked and a read-back they did not hear is never treated as confirmed.
//   * The caller's words come back as a transcript. The raw transcript goes to the call logic and nowhere else, and the item that held it is deleted from the voice service's
//     conversation straight away. The adapter never sends audio, and sends no caller detail except inside the exact words it is asked to speak.
//   * The consent notice is spoken first and cannot be talked over. Nothing the caller says before it has finished playing is taken, and the call logic is not told the call has
//     started until it has: if the notice does not play, the call is ended and the call logic never sees it.
//
// THIS FILE HAS NEVER TALKED TO THE REAL SERVICE. The event and field names follow OpenAI's documented Realtime events as understood on 2026-10-27 and are NOT verified; every
// field whose name starts with `x_` and every `carrier.*` message is this adapter's own assumption about what a telephony layer can report (how much of a reply was played, when
// a call started). It imports no SDK, reads no environment variable, holds no credential and opens no connection: the link is handed in. Nothing in src imports it yet.

import type { CallTransport, TransportEvent } from './call-transport.ts';
import type { CloseInfo } from './ws-server.ts';
import { isPersona, voiceManner } from './persona.ts';
import { isRealtimeEffort, transcriptionHintProblems } from './realtime-settings.ts';
import { noDiag } from './call-diag.ts';
import type { DiagSink } from './call-diag.ts';
import type { RealtimeEffort, RealtimeTranscription } from './realtime-settings.ts';
import type { Persona } from './persona.ts';

/** The two-way link to the voice service and the phone. A fake with this shape is used in tests. */
export interface RealtimeLink {
  /** Sends one JSON message to the voice service. False when it could not be sent. */
  send(message: unknown): boolean;
  /** Ends the phone call itself. False when it could not be done. */
  hangup(): boolean;
  close(code?: number): void;
  /** Set by the adapter. Called with each JSON message from the voice service or the phone layer. */
  onMessage: (message: unknown) => void;
  /** Set by the adapter. Called once when the link ends for any reason. */
  onClose: (info?: CloseInfo) => void;
}

export interface RealtimeOptions {
  /** The consent notice, word for word. */
  notice: string;
  /** Chosen by the founder; there is deliberately no default. */
  transcriptionModel: string;
  voice: string;
  /** Used to estimate how much of a reply was spoken when a played-time is reported. Default 70, the same pace the call logic uses to time a hang-up. */
  msPerChar?: number;
  /** The longest a hang-up waits for a reply that is still playing. Default 3000. */
  endWaitMs?: number;
  /** The receptionist persona (persona.ts). It changes how the exact words are delivered, never the words. Only a persona made by createPersona is accepted. */
  persona?: Persona;
  /** How hard the voice model reasons (realtime-settings.ts). Sent on the session and on every speech request when set; when absent nothing is sent and the model's own default applies. */
  reasoningEffort?: RealtimeEffort;
  /** Hints for the live transcriber (languages, keywords), sent only when set. Valid only for the transcribers that document them (the voice gate checks that). */
  transcription?: RealtimeTranscription;
  /** Fixed-code diagnostics (call-diag.ts): the notice requested, played or failed (and why), each reply's end, interruptions, and the hang-up and close paths. Codes and numbers only. */
  diag?: DiagSink;
}

export const SPEAK_ONLY = 'You are only a voice on a phone line. Never speak on your own. When you are asked to say words, say exactly those words and nothing else: no greeting, no comment, no change of wording, and every digit exactly as given.';
export const SAY_PREFIX = 'Say exactly the following words, and nothing else: ';
/** The words a speech request asks for: everything after the first SAY_PREFIX (a request that has none is returned whole). Pure. */
export function wordsOf(instructions: string): string {
  const at = instructions.indexOf(SAY_PREFIX);
  return at < 0 ? instructions : instructions.slice(at + SAY_PREFIX.length);
}
const UNITS: Readonly<Record<string, string>> = { zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19' };
const TENS: Readonly<Record<string, string>> = { twenty: '2', thirty: '3', forty: '4', fifty: '5', sixty: '6', seventy: '7', eighty: '8', ninety: '9' };

/** One canonical form for comparing what was asked with what was said: case, punctuation and spacing are ignored; a number may be said as words ("five", "twenty-five") or written as numerals ("5", "25"); "$25" and "twenty-five dollars" agree. Pure. */
function spokenForm(s: string): string {
  return s.toLowerCase()
    .replace(/\$\s?(\d+(?:\.\d+)?)/g, '$1 dollars')   // "$25" -> "25 dollars" (a comma-grouped or spoken-hundreds amount is not folded, so it fails closed)
    .replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-]+(one|two|three|four|five|six|seven|eight|nine)\b/g, (_m, tens: string, unit: string) => TENS[tens] + UNITS[unit])   // twenty-five -> 25
    .replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/g, (_m, tens: string) => `${TENS[tens]}0`)   // twenty -> 20
    .replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\b/g, (w: string) => UNITS[w])
    .replace(/\bdollars?\b/g, 'dollar')
    .replace(/[^a-z0-9]+/g, '');
}
/** Whether two spoken texts are the same words (see spokenForm). Nothing said is never a match. Pure. */
export function sameSpeech(a: string, b: string): boolean {
  return typeof a === 'string' && typeof b === 'string' && spokenForm(a).length > 0 && spokenForm(a) === spokenForm(b);
}

const BENIGN: ReadonlySet<string> = new Set(['session.created', 'session.updated', 'input_audio_buffer.speech_stopped', 'input_audio_buffer.committed', 'conversation.item.created', 'conversation.item.added', 'conversation.item.done',
  'conversation.item.deleted', 'rate_limits.updated', 'response.output_item.added', 'response.output_item.done', 'response.content_part.added', 'response.content_part.done', 'response.output_audio.delta', 'response.output_audio.done',
  'response.output_audio_transcript.delta', 'output_audio_buffer.started', 'output_audio_buffer.stopped', 'output_audio_buffer.cleared']);
interface Out { id: string; text: string; kind: 'notice' | 'reply'; interruptible: boolean; responseId?: string; transcript?: string; interrupted?: boolean; cancelPending?: boolean }
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

export function createRealtimeTransport(link: RealtimeLink, options: RealtimeOptions): CallTransport {
  if (!isObj(options) || typeof options.notice !== 'string' || options.notice.trim().length === 0 || options.notice.length > 1500
    || typeof options.transcriptionModel !== 'string' || options.transcriptionModel.length === 0 || typeof options.voice !== 'string' || options.voice.length === 0
    || (options.msPerChar !== undefined && (!Number.isInteger(options.msPerChar) || options.msPerChar < 1 || options.msPerChar > 1000))
    || (options.endWaitMs !== undefined && (!Number.isInteger(options.endWaitMs) || options.endWaitMs < 1 || options.endWaitMs > 30_000))
    || (options.persona !== undefined && !isPersona(options.persona))
    || (options.reasoningEffort !== undefined && !isRealtimeEffort(options.reasoningEffort))
    || (options.transcription !== undefined && transcriptionHintProblems(options.transcription).length > 0)) {
    throw new RangeError('the realtime transport needs a notice, a transcription model, a voice, and sane timings');
  }
  const diag = options.diag ?? noDiag;
  const msPerChar = options.msPerChar ?? 70;
  const endWaitMs = options.endWaitMs ?? 3000;
  const reasoning = options.reasoningEffort === undefined ? {} : { reasoning: { effort: options.reasoningEffort } };
  const hints = options.transcription === undefined ? {} : {
    ...(options.transcription.languages === undefined ? {} : { languages: [...options.transcription.languages] }),
    ...(options.transcription.keywords === undefined ? {} : { keywords: [...options.transcription.keywords] }),
  };
  const instructions = options.persona === undefined ? SPEAK_ONLY : `${SPEAK_ONLY} ${voiceManner(options.persona)}`;
  let phase: 'idle' | 'notice' | 'live' | 'ended' = 'idle';
  let start: { to: unknown; callSid: unknown } | undefined;
  let seq = 0;
  let current: Out | undefined;
  let queue: Out[] = [];
  let buffer = '';
  let interruptOff = false;
  let hangupWanted = false;
  let hangupTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  const asked = new Map<string, 'cancel' | 'delete'>();   // requests whose failure is expected and harmless: a cancel of a reply that has just finished, a delete of an item that is already gone
  let askSeq = 0;
  let closeCode: number | undefined;   // a close asked for while a reply was still playing waits for the hang-up, so the last words are not cut off

  const session = (interruptible: boolean): unknown => ({
    type: 'session.update',
    session: { type: 'realtime', instructions, output_modalities: ['audio'], ...reasoning, audio: { input: { transcription: { model: options.transcriptionModel, ...hints }, turn_detection: { type: 'server_vad', create_response: false, interrupt_response: interruptible } }, output: { voice: options.voice } } },
  });
  const clearTimers = (): void => {
    if (hangupTimer !== undefined) { clearTimeout(hangupTimer); hangupTimer = undefined; }
    if (cancelTimer !== undefined) { clearTimeout(cancelTimer); cancelTimer = undefined; }
  };
  /** Sends a request with an id of its own, so that an error the voice service answers it with can be recognised (the error names the request that caused it). */
  function ask(kind: 'cancel' | 'delete', message: Record<string, unknown>): void {
    const id = `${kind[0]}${++askSeq}`;
    asked.set(id, kind);
    if (asked.size > 64) asked.delete(asked.keys().next().value as string);
    link.send({ ...message, event_id: id });
  }
  /** Cancels ONE reply by its id. A reply requested out of band is not part of the default conversation, so a cancel that names no reply would not reach it. */
  function cancelReply(o: Out): void {
    if (o.responseId === undefined) { o.cancelPending = true; return; }   // not created yet: cancelled the moment it is
    o.cancelPending = false;
    ask('cancel', { type: 'response.cancel', response_id: o.responseId });
    if (cancelTimer === undefined) {
      // If the voice service never closes the reply, the call must not wait for it for ever: after a while the reply is given up and the next line may go, and the late reply (if it ever speaks) is dropped by the phone layer.
      cancelTimer = setTimeout(() => { cancelTimer = undefined; if (current === o) { diag('ADAPTER_CANCEL_GAVE_UP', { waitMs: endWaitMs }); current = undefined; pump(); } }, endWaitMs);
      cancelTimer.unref?.();
    }
  }
  const emit = (e: TransportEvent): void => { try { transport.onEvent(e); } catch { /* the call logic never throws into the carrier */ } };

  function dispatch(o: Out): boolean {
    // A line the caller must not talk over turns the voice service's own interruption off first, and the next interruptible line turns it back on.
    if (!o.interruptible && !interruptOff) { if (!link.send(session(false))) return false; interruptOff = true; }
    else if (o.interruptible && interruptOff) { if (!link.send(session(true))) return false; interruptOff = false; }
    const sent = link.send({ type: 'response.create', response: { conversation: 'none', output_modalities: ['audio'], ...reasoning, instructions: `${instructions} ${SAY_PREFIX}${o.text}`, metadata: { id: o.id } } });
    if (sent) current = o;
    return sent;
  }
  function doHangup(): boolean {
    clearTimers();
    if (phase === 'ended') return false;
    phase = 'ended';
    const ok = link.hangup();
    diag('ADAPTER_HANGUP', { ok, closeCode: closeCode ?? 0 });
    if (closeCode !== undefined) link.close(closeCode);
    return ok;
  }
  function pump(): void {
    if (current !== undefined || phase === 'ended') return;
    const next = queue.shift();
    if (next !== undefined) { if (!dispatch(next)) { emit({ kind: 'reply_failed' }); pump(); } return; }
    if (hangupWanted) doHangup();
  }
  function noticeFailed(reason: string): void {
    clearTimers();
    if (phase === 'ended') return;
    phase = 'ended';
    diag('ADAPTER_NOTICE_FAILED', { reason });   // the call ends here: the caller did not hear the consent notice as it was written
    link.hangup();
    transport.onClose({ cause: 'PROTOCOL', code: 1011 });
  }
  /** What of a reply was spoken when the caller started talking, from a played-time the phone layer reports. Nothing when it reports none: then it is treated as not heard. */
  function spokenOf(o: Out, playedMs: unknown): string {
    if (typeof playedMs !== 'number' || !Number.isFinite(playedMs) || playedMs <= 0) return '';
    const chars = Math.floor(playedMs / msPerChar);
    if (chars >= o.text.length) return o.text;
    const cut = o.text.slice(0, chars);
    const at = cut.lastIndexOf(' ');
    return at > 0 ? cut.slice(0, at).trim() : '';
  }

  function onMessage(m: unknown): void {
    if (!isObj(m) || typeof m.type !== 'string') { emit({ kind: 'malformed' }); return; }
    switch (m.type) {
      case 'carrier.start': {
        if (phase !== 'idle') { emit({ kind: 'other' }); return; }
        start = { to: m.to, callSid: m.callSid };
        phase = 'notice';
        diag('ADAPTER_CALL_START', { noticeChars: options.notice.length });
        if (!link.send(session(true))) { noticeFailed('send_failed'); return; }
        if (!dispatch({ id: 'notice', text: options.notice, kind: 'notice', interruptible: false })) noticeFailed('send_failed');
        else diag('ADAPTER_NOTICE_REQUESTED');
        return;
      }
      case 'response.created': {
        const r = isObj(m.response) ? m.response : {};
        const meta = isObj(r.metadata) ? r.metadata : {};
        if (current !== undefined && meta.id === current.id && typeof r.id === 'string') { current.responseId = r.id; if (current.cancelPending) cancelReply(current); }
        return;
      }
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done': {
        if (current !== undefined && typeof m.response_id === 'string' && m.response_id === current.responseId && typeof m.transcript === 'string') current.transcript = m.transcript;
        return;
      }
      case 'response.done': {
        const r = isObj(m.response) ? m.response : {};
        const meta = isObj(r.metadata) ? r.metadata : {};
        const done = current;
        if (done === undefined || meta.id !== done.id) return;
        current = undefined;
        if (cancelTimer !== undefined) { clearTimeout(cancelTimer); cancelTimer = undefined; }
        const played = r.status === 'completed' && typeof done.transcript === 'string' && sameSpeech(done.transcript, done.text);
        const status = typeof r.status === 'string' && /^[a-z_]{1,32}$/.test(r.status) ? r.status : 'other';
        const why = r.status !== 'completed' ? `status_${status}` : typeof done.transcript !== 'string' ? 'no_transcript' : 'transcript_differs';
        diag('ADAPTER_REPLY_DONE', { kind: done.kind, status, played, interrupted: done.interrupted === true, requestedChars: done.text.length, transcriptChars: typeof done.transcript === 'string' ? done.transcript.length : 0 });
        if (done.interrupted) { /* the caller took the floor: nothing failed */ }
        else if (!played) { if (done.kind === 'notice') { noticeFailed(why); return; } diag('ADAPTER_REPLY_FAILED', { reason: why }); emit({ kind: 'reply_failed' }); }
        else if (done.kind === 'notice') { phase = 'live'; diag('ADAPTER_NOTICE_PLAYED'); diag('ADAPTER_SETUP_EMITTED'); emit({ kind: 'setup', to: start?.to, callSid: start?.callSid }); }
        pump();
        return;
      }
      case 'input_audio_buffer.speech_started': {
        const o = current;
        if (phase !== 'live' || o === undefined || o.kind !== 'reply' || !o.interruptible || o.interrupted) return;
        o.interrupted = true;
        queue = queue.filter((q) => !q.interruptible);   // nothing queued is spoken over the caller
        cancelReply(o);
        const spoken = spokenOf(o, m.x_played_ms);
        diag('ADAPTER_INTERRUPT', { spokenChars: spoken.length, known: typeof m.x_played_ms === 'number' });
        emit({ kind: 'interrupt', spoken });
        return;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        if (typeof m.item_id === 'string') ask('delete', { type: 'conversation.item.delete', item_id: m.item_id });   // the voice service keeps no copy of what was said
        if (phase !== 'live') return;   // nothing said before the notice has played, or after the call has ended, is taken
        if (typeof m.transcript !== 'string' || m.transcript.trim().length === 0) emit({ kind: 'partial' });
        else emit({ kind: 'utterance', text: m.transcript });
        return;
      }
      case 'conversation.item.input_audio_transcription.delta':
      case 'conversation.item.input_audio_transcription.failed':
        if (phase === 'live') emit({ kind: 'partial' });
        return;
      case 'error': {
        // An error that answers one of our own cancel or delete requests (the reply had just finished; the item was already gone) is not a fault of the call.
        const cause = isObj(m.error) && typeof m.error.event_id === 'string' ? m.error.event_id : undefined;
        if (cause !== undefined && asked.delete(cause)) return;
        diag('ADAPTER_VOICE_ERROR_EVENT', { phase });
        emit({ kind: 'error' });
        return;
      }
      default:
        if (BENIGN.has(m.type)) return;   // routine bookkeeping from the voice service: not a frame the call logic should count
        emit({ kind: 'other' });
    }
  }

  const transport: CallTransport = {
    onEvent: () => {},
    onClose: () => {},
    speak(token: string, last: boolean, opts?: { interruptible?: boolean }): boolean {
      if (phase !== 'live') return false;
      buffer += token;
      if (!last) return true;
      const text = buffer.trim(); buffer = '';
      if (text.length === 0) return true;
      const out: Out = { id: `r${++seq}`, text, kind: 'reply', interruptible: opts?.interruptible !== false };
      if (current !== undefined) { queue.push(out); return true; }
      return dispatch(out);
    },
    endCall(): boolean {
      if (phase === 'ended') return false;
      hangupWanted = true;
      diag('ADAPTER_END_REQUESTED', { replyPlaying: current !== undefined, queued: queue.length });
      if (current === undefined && queue.length === 0) return doHangup();
      if (hangupTimer === undefined) { hangupTimer = setTimeout(() => { doHangup(); }, endWaitMs); hangupTimer.unref?.(); }
      return true;
    },
    close(code?: number): void {
      if (hangupWanted && phase !== 'ended') { closeCode = code ?? 1000; return; }
      diag('ADAPTER_CLOSE', { closeCode: code ?? 1000, waitingForHangup: hangupWanted && phase !== 'ended' });
      clearTimers(); phase = 'ended'; link.close(code);
    },
  };
  link.onMessage = (m: unknown): void => { try { onMessage(m); } catch { emit({ kind: 'other' }); } };
  link.onClose = (info?: CloseInfo): void => { clearTimers(); phase = 'ended'; transport.onClose(info); };
  return transport;
}
