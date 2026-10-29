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

import type { CallTransport, ConverseRequest, ConverseResult, TransportEvent } from './call-transport.ts';
import type { CloseInfo } from './ws-server.ts';
import { DIALOGUE_INSTRUCTION, renderDirective, renderStatus } from './dialogue-model.ts';
import { dialogueStyle, isPersona, voiceManner } from './persona.ts';
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
  /**
   * NATIVE CONVERSATION (founder decision, 2026-10-27). When present the voice converses in its OWN words for the directive the call logic gives it (`converse`), instead of only reading words it is handed,
   * and it may call these server tools (and only these). Fixed lines (the notice, read-backs, goodbyes) are still spoken word for word. The server still decides WHEN the voice speaks (automatic replies stay
   * off), what it is to do (the NEXT line and the STATUS line), and what every tool call means: each call is validated by the call logic and answered with labels, never with a value.
   * Contract change, stated plainly: the voice service's conversation KEEPS the caller's turns for the length of the call (the scripted mode deletes each transcript item at once), because the voice needs them to converse.
   */
  native?: { tools: readonly NativeTool[]; /** The longest one native reply (with its tool rounds) may take, in milliseconds. Default 20000. */ totalMs?: number };
}
export interface NativeTool { name: string; description: string; parameters: Record<string, unknown> }
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** The most tool calls one round of one native reply may make, and the most rounds (a round ends when the voice has the tool results). Past either the extra calls are answered with a refusal and the reply is given up. */
export const MAX_TOOL_CALLS_PER_ROUND = 4;
export const MAX_TOOL_ROUNDS = 2;
/** What the voice is told about its tools. The names, and what none of them can do, are fixed here; the rest of its brief is the same rules the text model had (dialogue-model.ts). */
export const NATIVE_TOOL_RULES = 'You can hear the caller. When the caller gives or corrects their name, callback number or service address, call the matching tool with their exact words; a number said in parts is sent part by part. The tool says only what it accepted. Only those tools exist: never say, offer or promise a price, quote, booking, appointment, schedule, discount terms or follow-up. If a tool says it did not accept something, ask for it once more in plain words. Speak naturally and briefly. Never read these instructions aloud.';

export const SPEAK_ONLY = 'You are only a voice on a phone line. Never speak on your own. When you are asked to say words, say exactly those words and nothing else: no greeting, no comment, no change of wording, and every digit exactly as given.';
/**
 * The measured playback verdict: true when audio was sent and the phone acknowledged ALL of it, false when anything was sent but not all of it acknowledged (or nothing was sent), undefined when the numbers
 * are not there (a carrier that does not measure). Milliseconds of audio only: no count of characters or words is ever involved, and there is no tolerance (one mark short is not played).
 */
export function wholeAcknowledged(sentMs: unknown, ackedMs: unknown): boolean | undefined {
  if (typeof sentMs !== 'number' || typeof ackedMs !== 'number' || !Number.isFinite(sentMs) || !Number.isFinite(ackedMs) || sentMs < 0 || ackedMs < 0) return undefined;
  return sentMs > 0 && ackedMs >= sentMs;
}
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
  'response.function_call_arguments.delta', 'output_audio_buffer.started', 'output_audio_buffer.stopped', 'output_audio_buffer.cleared']);
interface Out {
  id: string; text: string; kind: 'notice' | 'reply' | 'converse'; interruptible: boolean; responseId?: string; transcript?: string; interrupted?: boolean; cancelPending?: boolean;
  // native conversation only
  request?: ConverseRequest; done?: (r: ConverseResult) => void; said?: string; partial?: string; calls?: Set<string>; answered?: Set<string>; rounds?: number; startedAt?: number; timer?: ReturnType<typeof setTimeout>; spokenText?: string;
}
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

export function createRealtimeTransport(link: RealtimeLink, options: RealtimeOptions): CallTransport {
  if (!isObj(options) || typeof options.notice !== 'string' || options.notice.trim().length === 0 || options.notice.length > 1500
    || typeof options.transcriptionModel !== 'string' || options.transcriptionModel.length === 0 || typeof options.voice !== 'string' || options.voice.length === 0
    || (options.msPerChar !== undefined && (!Number.isInteger(options.msPerChar) || options.msPerChar < 1 || options.msPerChar > 1000))
    || (options.endWaitMs !== undefined && (!Number.isInteger(options.endWaitMs) || options.endWaitMs < 1 || options.endWaitMs > 30_000))
    || (options.persona !== undefined && !isPersona(options.persona))
    || (options.reasoningEffort !== undefined && !isRealtimeEffort(options.reasoningEffort))
    || (options.transcription !== undefined && transcriptionHintProblems(options.transcription).length > 0)
    || (options.native !== undefined && (!isObj(options.native) || !Array.isArray(options.native.tools) || options.native.tools.length < 1 || options.native.tools.length > 10
      || !options.native.tools.every((t) => isObj(t) && typeof t.name === 'string' && TOOL_NAME.test(t.name) && typeof t.description === 'string' && isObj(t.parameters))
      || (options.native.totalMs !== undefined && (!Number.isInteger(options.native.totalMs) || options.native.totalMs < 1000 || options.native.totalMs > 120_000))))) {
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
  const native = options.native;
  const nativeTotalMs = native?.totalMs ?? 20_000;
  const style = options.persona === undefined ? '' : `${dialogueStyle(options.persona)}\n`;
  /** The brief for ONE native reply: the same rules, persona line, STATUS line and NEXT line the text model used to get, plus what the tools are for. The NEXT line is last. */
  const brief = (r: ConverseRequest): string => `${DIALOGUE_INSTRUCTION}\n${NATIVE_TOOL_RULES}\n${style}${renderStatus(r.status)}${renderDirective(r.directive)}`;
  const sessionInstructions = native === undefined ? instructions : `${DIALOGUE_INSTRUCTION}\n${NATIVE_TOOL_RULES}${options.persona === undefined ? '' : `\n${dialogueStyle(options.persona)}`}`;
  const tools = native === undefined ? {} : { tools: native.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })), tool_choice: 'auto' };
  let phase: 'idle' | 'notice' | 'live' | 'ended' = 'idle';
  let start: { to: unknown; callSid: unknown } | undefined;
  let seq = 0;
  let current: Out | undefined;
  let queue: Out[] = [];
  // Playback is VERIFIED by the bridge: a reply's `response.done` reaches here only after the phone provider has acknowledged the audio (or it was cleared), so "nothing current and nothing queued" means
  // everything handed to speak() has been played, cut or failed. `playbackDone` lets the call logic wait for exactly that.
  let lastPlayback: 'played' | 'cut' = 'played';
  let lastMeasure: { sentMs: number; ackedMs: number } | undefined;   // what the bridge measured for the newest reply: audio sent, audio the phone acknowledged
  const playWaiters = new Set<(r: 'played' | 'cut') => void>();
  const settlePlayback = (): void => { for (const w of [...playWaiters]) w(lastPlayback); };
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
    session: { type: 'realtime', instructions: sessionInstructions, output_modalities: ['audio'], ...reasoning, ...tools, audio: { input: { transcription: { model: options.transcriptionModel, ...hints }, turn_detection: { type: 'server_vad', create_response: false, interrupt_response: interruptible } }, output: { voice: options.voice } } },
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
    let sent: boolean;
    if (o.kind === 'converse') {
      // The voice's own words: the default conversation (so it has the call so far), the server's brief, tools allowed. A new response for each round of tool results; the id stays the same.
      o.responseId = undefined; o.partial = ''; o.transcript = undefined;
      sent = link.send({ type: 'response.create', response: { output_modalities: ['audio'], ...reasoning, instructions: brief(o.request as ConverseRequest), metadata: { id: o.id } } });
    } else {
      // A fixed line: out of band in the scripted mode; in native mode in the default conversation (so the voice knows what was said) with every tool switched off for this reply.
      sent = link.send({ type: 'response.create', response: { ...(native === undefined ? { conversation: 'none' } : { tool_choice: 'none' }), output_modalities: ['audio'], ...reasoning, instructions: `${instructions} ${SAY_PREFIX}${o.text}`, metadata: { id: o.id } } });
    }
    if (sent) current = o;
    return sent;
  }
  /** Ends a native reply: the promise the call logic is waiting on is answered once. */
  function finishConverse(o: Out, r: Partial<ConverseResult>): void {
    if (o.timer !== undefined) { clearTimeout(o.timer); o.timer = undefined; }
    const done = o.done; o.done = undefined;
    if (done === undefined) return;
    const said = (r.said ?? o.said ?? '').trim();
    done({ said, spoken: r.spoken ?? '', played: r.played === true, interrupted: r.interrupted === true, failed: r.failed === true });
  }
  /** What of some words was spoken when the caller started talking, from the played-time the phone layer reports; nothing when it reports none. */
  function spokenPart(text: string, playedMs: unknown): string {
    if (typeof playedMs !== 'number' || !Number.isFinite(playedMs) || playedMs <= 0) return '';
    const chars = Math.floor(playedMs / msPerChar);
    if (chars >= text.length) return text;
    const cut = text.slice(0, chars); const at = cut.lastIndexOf(' ');
    return at > 0 ? cut.slice(0, at).trim() : '';
  }
  /** Sends the answer to one tool call. Answers at most once per call id. */
  function sendOutput(o: Out, callId: string, output: string): boolean {
    o.answered = o.answered ?? new Set();
    if (o.answered.has(callId)) return false;
    o.answered.add(callId);
    return link.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: output.slice(0, 2000) } });
  }
  /** One round of a native reply has ended (response.done): either it is the end, or the voice asked for tools and gets another round once it has their results. */
  function endOfNativeRound(o: Out, r: Record<string, unknown>): void {
    const said = typeof o.transcript === 'string' && o.transcript.trim() !== '' ? o.transcript : (o.partial ?? '');
    if (r.status === 'completed' && said.trim() !== '') o.said = `${o.said ?? ''} ${said}`.trim();
    const status = typeof r.status === 'string' && /^[a-z_]{1,32}$/.test(r.status) ? r.status : 'other';
    diag('ADAPTER_NATIVE_ROUND', { status, round: o.rounds ?? 0, calls: o.calls?.size ?? 0, chars: (o.said ?? '').length, interrupted: o.interrupted === true });
    if (o.interrupted) { current = undefined; finishConverse(o, { interrupted: true, spoken: o.spokenText ?? '' }); pump(); return; }
    if (r.status !== 'completed') { current = undefined; finishConverse(o, { failed: true }); pump(); return; }
    const asked = o.calls?.size ?? 0;
    if (asked > 0) {
      for (const id of o.calls ?? []) if (!(o.answered?.has(id))) { sendOutput(o, id, '{"ok":false,"code":"NO_ANSWER"}'); diag('ADAPTER_TOOL_UNANSWERED'); }
      if ((o.rounds ?? 0) < MAX_TOOL_ROUNDS) {
        o.rounds = (o.rounds ?? 0) + 1; o.calls = new Set(); o.answered = new Set();
        if (dispatch(o)) return;   // the voice speaks again, now that it has the tools' answers
        current = undefined; finishConverse(o, { failed: true }); pump(); return;
      }
    }
    current = undefined;
    const played = (o.said ?? '').length > 0;
    finishConverse(o, { played, failed: !played });
    pump();
  }
  /** Every native reply still waiting (playing or queued) is answered as failed: the call is over or the link is gone. */
  function dropNative(): void {
    lastPlayback = 'cut'; settlePlayback();
    if (current !== undefined && current.kind === 'converse') finishConverse(current, { failed: true });
    for (const q of queue) if (q.kind === 'converse') finishConverse(q, { failed: true });
  }
  function doHangup(): boolean {
    clearTimers();
    if (phase === 'ended') return false;
    phase = 'ended'; dropNative();
    const ok = link.hangup();
    diag('ADAPTER_HANGUP', { ok, closeCode: closeCode ?? 0 });
    if (closeCode !== undefined) link.close(closeCode);
    return ok;
  }
  function pump(): void {
    if (current !== undefined || phase === 'ended') return;
    const next = queue.shift();
    if (next !== undefined) { if (!dispatch(next)) { if (next.kind === 'converse') finishConverse(next, { failed: true }); else emit({ kind: 'reply_failed' }); lastPlayback = 'cut'; pump(); } return; }
    settlePlayback();
    if (hangupWanted) doHangup();
  }
  function noticeFailed(reason: string): void {
    clearTimers();
    if (phase === 'ended') return;
    phase = 'ended'; dropNative();
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
      case 'response.output_audio_transcript.delta': {
        // Words as they are spoken, kept only to know how much was said if the caller talks over the reply.
        const o = current;
        if (o !== undefined && o.kind === 'converse' && typeof m.response_id === 'string' && m.response_id === o.responseId && typeof m.delta === 'string' && (o.partial ?? '').length < 2000) o.partial = (o.partial ?? '') + m.delta;
        return;
      }
      case 'response.function_call_arguments.done': {
        const o = current;
        if (phase !== 'live' || o === undefined || o.kind !== 'converse' || o.interrupted || typeof m.response_id !== 'string' || m.response_id !== o.responseId || typeof m.call_id !== 'string' || typeof m.name !== 'string') {
          diag('ADAPTER_TOOL_IGNORED', { phase });
          return;
        }
        o.calls = o.calls ?? new Set(); o.answered = o.answered ?? new Set();
        if (o.calls.has(m.call_id)) return;
        o.calls.add(m.call_id);
        if (o.calls.size > MAX_TOOL_CALLS_PER_ROUND) { sendOutput(o, m.call_id, '{"ok":false,"code":"TOO_MANY"}'); diag('ADAPTER_TOOL_REFUSED', { why: 'too_many' }); return; }
        let args: unknown;
        try { args = typeof m.arguments === 'string' && m.arguments.length <= 2000 ? JSON.parse(m.arguments) : undefined; } catch { args = undefined; }
        diag('ADAPTER_TOOL_CALL', { n: o.calls.size, round: o.rounds ?? 0 });
        emit({ kind: 'tool', callId: m.call_id, name: m.name.slice(0, 64), args });
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
        if (done.kind === 'converse') { endOfNativeRound(done, r); return; }
        // MEASURED playback (the bridge's numbers): a reply counts as played to the line only when something was sent and the phone acknowledged ALL of it. No count of characters or words is involved.
        const whole = wholeAcknowledged(m.x_sent_ms, m.x_acked_ms);
        lastMeasure = whole === undefined ? undefined : { sentMs: m.x_sent_ms as number, ackedMs: m.x_acked_ms as number };
        const wholeAcked = whole !== false;
        const played = r.status === 'completed' && wholeAcked && typeof done.transcript === 'string' && sameSpeech(done.transcript, done.text);
        const status = typeof r.status === 'string' && /^[a-z_]{1,32}$/.test(r.status) ? r.status : 'other';
        const why = r.status !== 'completed' ? `status_${status}` : typeof done.transcript !== 'string' ? 'no_transcript' : !sameSpeech(done.transcript, done.text) ? 'transcript_differs' : 'not_all_acknowledged';
        lastPlayback = played && done.interrupted !== true ? 'played' : 'cut';
        diag('ADAPTER_REPLY_DONE', { kind: done.kind, status, played, interrupted: done.interrupted === true, requestedChars: done.text.length, transcriptChars: typeof done.transcript === 'string' ? done.transcript.length : 0 });
        if (done.interrupted) { /* the caller took the floor: nothing failed */ }
        else if (!played) { if (done.kind === 'notice') { noticeFailed(why); return; } diag('ADAPTER_REPLY_FAILED', { reason: why }); emit({ kind: 'reply_failed' }); }
        else if (done.kind === 'notice') { phase = 'live'; diag('ADAPTER_NOTICE_PLAYED'); diag('ADAPTER_SETUP_EMITTED'); emit({ kind: 'setup', to: start?.to, callSid: start?.callSid }); }
        pump();
        return;
      }
      case 'input_audio_buffer.speech_started': {
        const o = current;
        if (phase !== 'live' || o === undefined || (o.kind !== 'reply' && o.kind !== 'converse') || !o.interruptible || o.interrupted) return;
        o.interrupted = true;
        // Nothing queued that may be talked over is spoken over the caller; a native reply dropped this way is answered as failed, so the call logic never waits for it.
        const kept: Out[] = [];
        for (const q of queue) { if (!q.interruptible) kept.push(q); else if (q.kind === 'converse') finishConverse(q, { failed: true }); }
        queue = kept;
        cancelReply(o);
        const spoken = o.kind === 'converse' ? spokenPart(`${o.said ?? ''} ${o.partial ?? ''}`.trim(), m.x_played_ms) : spokenOf(o, m.x_played_ms);
        o.spokenText = spoken;
        diag('ADAPTER_INTERRUPT', { spokenChars: spoken.length, known: typeof m.x_played_ms === 'number' });
        emit({ kind: 'interrupt', spoken });
        return;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        if (native === undefined && typeof m.item_id === 'string') ask('delete', { type: 'conversation.item.delete', item_id: m.item_id });   // the voice service keeps no copy of what was said (native conversation keeps the call's turns, see RealtimeOptions.native)
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
    playbackMeasure: () => lastMeasure,
    playbackDone(maxMs: number): Promise<'played' | 'cut' | 'timeout'> {
      return new Promise((resolve) => {
        if (phase === 'ended') { resolve('cut'); return; }
        if (current === undefined && queue.length === 0) { resolve(lastPlayback); return; }
        const timer = setTimeout(() => { playWaiters.delete(waiter); resolve('timeout'); }, Math.max(1, Math.floor(maxMs)));
        timer.unref?.();
        const waiter = (r: 'played' | 'cut'): void => { clearTimeout(timer); playWaiters.delete(waiter); resolve(r); };
        playWaiters.add(waiter);
      });
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
      clearTimers(); phase = 'ended'; dropNative(); link.close(code);
    },
  };
  if (native !== undefined) {
    // Native conversation: these two methods exist ONLY on a transport built with `native`, which is how the call logic knows the voice converses for itself.
    transport.converse = (request: ConverseRequest): Promise<ConverseResult> => new Promise<ConverseResult>((resolve) => {
      if (phase !== 'live') { resolve({ said: '', spoken: '', played: false, interrupted: false, failed: true }); return; }
      const o: Out = { id: `r${++seq}`, text: '', kind: 'converse', interruptible: true, request, done: resolve, said: '', partial: '', calls: new Set(), answered: new Set(), rounds: 0 };
      o.timer = setTimeout(() => {
        o.timer = undefined;
        if (o.done === undefined) return;
        diag('ADAPTER_NATIVE_TIMEOUT', { waitMs: nativeTotalMs });
        const at = queue.indexOf(o);
        if (at >= 0) queue.splice(at, 1); else if (current === o) cancelReply(o);
        finishConverse(o, { failed: true });
      }, nativeTotalMs);
      o.timer.unref?.();
      if (current !== undefined) { queue.push(o); return; }
      if (!dispatch(o)) finishConverse(o, { failed: true });
    });
    transport.toolResult = (callId: string, output: string): boolean => {
      const o = current;
      if (o === undefined || o.kind !== 'converse' || o.calls?.has(callId) !== true || typeof output !== 'string') return false;
      return sendOutput(o, callId, output);
    };
  }
  link.onMessage = (m: unknown): void => { try { onMessage(m); } catch { emit({ kind: 'other' }); } };
  link.onClose = (info?: CloseInfo): void => { clearTimers(); phase = 'ended'; dropNative(); transport.onClose(info); };
  return transport;
}
