// An offline stand-in for OpenAI Realtime plus the phone layer, for tests only. It talks to src/realtime-transport.ts through the RealtimeLink interface: no socket, no network, no key.
// It plays the part of the voice service: it takes the adapter's session settings and out-of-band "say exactly ..." requests, "plays" each one over time at a configurable pace
// (events arrive in order, a little after the request), and it can hear a caller who talks, including over a reply that is still playing.
//
// IMPORTANT: this is a model of the service built from documentation read on 2026-10-27. It has not been checked against the real service, so a passing test shows how the adapter
// and the call logic behave against THIS model, not against OpenAI. The event names, the transcript events and the `x_played_ms` field (how much of a reply the phone layer says was
// played) are assumptions.
import { wordsOf } from '../../src/realtime-transport.ts';
import type { RealtimeLink } from '../../src/realtime-transport.ts';
import type { CloseInfo } from '../../src/ws-server.ts';

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
/** How a requested reply is played. `words` says every numeral as a word; `{ say }` says other words than the ones asked for. */
export type Behaviour = 'exact' | 'words' | 'silent' | 'fail' | 'incomplete' | 'hang' | { say: string };
export interface RealtimeSimOptions {
  /** Milliseconds of playback per character. Default 2 (fast). The adapter is given the same figure. */
  msPerChar?: number;
  /** How the n-th requested reply is played (n from 1; the consent notice is 1). */
  behave?: (text: string, n: number) => Behaviour;
  /** Whether a send reaches the service. */
  accept?: () => boolean;
  /** A voice service that ignores every cancel (and never stops a reply of its own accord). */
  ignoreCancel?: boolean;
  /** Whether the hang-up works. */
  hangupWorks?: () => boolean;
}

export interface RealtimeSim {
  link: RealtimeLink;
  /** Everything the adapter sent, in order. */
  sent: any[];
  /** Requests the stand-in refused as the documented schema would: a settings update without `session.type`, a cancel that names no reply, a cancel of a reply that is not playing, a delete of an item that does not exist. */
  refused: string[];
  /** What the caller heard, in order: replies that played to the end with words. */
  spoken: string[];
  /** Calls to hangup() and close(), in order, mixed with the replies heard: lets a test see that the goodbye finished before the hang-up. */
  events: string[];
  readonly hungUp: boolean;
  readonly closeCodes: Array<number | undefined>;
  /** Whether a reply is playing right now. */
  playing(): boolean;
  /** The phone layer starts the call. */
  start(o: { to: string; callSid: string }): void;
  /** The caller says something. If a reply is playing, they talk over it; `playedMs` is how much of it the phone layer says was played (default: real elapsed time). */
  say(text: string, o?: { playedMs?: number }): void;
  /** The caller makes a sound that produces no words. */
  mumble(): void;
  /** The link ends. */
  drop(info?: CloseInfo): void;
  /** Resolves when nothing is playing and every queued event has been delivered. */
  idle(): Promise<void>;
  waitFor(fn: () => boolean, ms?: number): Promise<void>;
  /** Resolves when the caller has heard at least `n` replies. */
  heard(n: number, ms?: number): Promise<void>;
}

export function createRealtimeSim(o: RealtimeSimOptions = {}): RealtimeSim {
  const msPerChar = o.msPerChar ?? 2;
  const sent: any[] = []; const spoken: string[] = []; const events: string[] = []; const closeCodes: Array<number | undefined> = [];
  const refused: string[] = []; const items = new Set<string>();
  let hungUp = false; let interruptible = true; let n = 0; let item = 0;
  let chain: Promise<void> = Promise.resolve();
  interface Play { rid: string; mid: string; text: string; behaviour: Behaviour; startedAt: number; timer: ReturnType<typeof setTimeout> }
  let play: Play | undefined;

  const deliver = (m: unknown): void => { chain = chain.then(() => new Promise<void>((r) => setTimeout(r, 0))).then(() => { link.onMessage(m); }); };
  const asWords = (s: string): string => s.replace(/\d/g, (d) => ` ${WORDS[Number(d)]} `).replace(/\s+/g, ' ').trim();

  function finish(p: Play): void {
    if (play !== p) return;
    play = undefined;
    const b = p.behaviour;
    let status = 'completed'; let transcript: string | undefined = p.text;
    if (b === 'words') transcript = asWords(p.text);
    else if (b === 'silent') transcript = undefined;
    else if (b === 'fail') { status = 'failed'; transcript = undefined; }
    else if (b === 'incomplete') { status = 'incomplete'; transcript = p.text.slice(0, Math.max(1, Math.floor(p.text.length / 2))); }
    else if (typeof b === 'object') transcript = b.say;
    if (transcript !== undefined) deliver({ type: 'response.output_audio_transcript.done', response_id: p.rid, transcript });
    if (status === 'completed' && transcript !== undefined && transcript.trim() !== '') { chain = chain.then(() => { spoken.push(transcript as string); events.push('heard: ' + transcript); }); }
    deliver({ type: 'response.done', response: { id: p.rid, status, metadata: { id: p.mid } } });
  }
  function cancel(): void {
    const p = play;
    if (p === undefined || o.ignoreCancel === true) return;
    clearTimeout(p.timer); play = undefined;
    deliver({ type: 'response.done', response: { id: p.rid, status: 'cancelled', metadata: { id: p.mid } } });
  }
  /** The service answers a refused request with an error that names the request (`error.event_id`), as the documented server does. */
  const refuse = (m: any, why: string, code: string): void => { refused.push(why); deliver({ type: 'error', error: { type: 'invalid_request_error', code, message: why, event_id: m.event_id ?? null } }); };
  function handle(m: any): void {
    if (m?.type === 'session.update') {
      if (m.session?.type !== 'realtime') { refuse(m, 'session.update without session.type', 'missing_required_parameter'); return; }
      const td = m.session?.audio?.input?.turn_detection;
      if (td && typeof td.interrupt_response === 'boolean') interruptible = td.interrupt_response;
    } else if (m?.type === 'response.create') {
      const instructions = String(m.response?.instructions ?? '');
      const text = wordsOf(instructions);
      n++;
      const rid = `resp_${n}`;
      const behaviour = o.behave?.(text, n) ?? 'exact';
      const p: Play = { rid, mid: String(m.response?.metadata?.id), text, behaviour, startedAt: Date.now(), timer: setTimeout(() => { /* replaced below */ }, 0) };
      clearTimeout(p.timer);
      p.timer = setTimeout(() => { if (behaviour !== 'hang') finish(p); }, Math.max(1, text.length * msPerChar)); p.timer.unref?.();   // a long reply must not keep the test process alive
      play = p;
      deliver({ type: 'response.created', response: { id: rid, metadata: { id: p.mid } } });
    } else if (m?.type === 'response.cancel') {
      // A reply requested out of band is not in the default conversation: only a cancel that names it reaches it.
      if (typeof m.response_id !== 'string') { refused.push('response.cancel without response_id'); return; }
      if (play === undefined || play.rid !== m.response_id) { refuse(m, 'response.cancel of a reply that is not playing', 'response_cancel_not_active'); return; }
      cancel();
    } else if (m?.type === 'conversation.item.delete') {
      if (typeof m.item_id !== 'string' || !items.has(m.item_id)) { refuse(m, 'conversation.item.delete of an item that does not exist', 'item_not_found'); return; }
      items.delete(m.item_id);
      deliver({ type: 'conversation.item.deleted', item_id: m.item_id });
    }
  }

  const link: RealtimeLink = {
    send(m: unknown): boolean {
      if (!(o.accept?.() ?? true)) return false;
      sent.push(structuredClone(m));
      handle(m);
      return true;
    },
    hangup(): boolean { if (!(o.hangupWorks?.() ?? true)) return false; hungUp = true; events.push('hangup'); return true; },
    close(code?: number): void { closeCodes.push(code); events.push('close'); },
    onMessage: () => {},
    onClose: () => {},
  };
  const sim: RealtimeSim = {
    link, sent, refused, spoken, events, closeCodes,
    get hungUp() { return hungUp; },
    playing: () => play !== undefined,
    start(c) { deliver({ type: 'carrier.start', to: c.to, callSid: c.callSid }); },
    say(text, opts) {
      const id = `item_${++item}`; items.add(id);
      const talkingOver = play !== undefined;
      const playedMs = opts?.playedMs ?? (play ? Date.now() - play.startedAt : 0);
      deliver({ type: 'input_audio_buffer.speech_started', ...(talkingOver ? { x_played_ms: playedMs } : {}) });
      if (talkingOver && interruptible) chain = chain.then(() => { cancel(); });   // the service stops its own reply when the caller talks over it, if interruption is on
      deliver({ type: 'input_audio_buffer.speech_stopped' });
      deliver({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: text });
    },
    mumble() { const id = `item_${++item}`; items.add(id); deliver({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: '  ' }); },
    drop(info) { chain = chain.then(() => { link.onClose(info); }); },
    async idle() {
      for (let i = 0; i < 200; i++) {
        const before = chain;
        await before;
        await new Promise<void>((r) => setTimeout(r, 3));
        if (play === undefined && before === chain) return;
        if (play !== undefined) await new Promise<void>((r) => setTimeout(r, Math.max(2, play ? play.text.length * msPerChar : 2)));
      }
      throw new Error('the simulator did not go idle');
    },
    async waitFor(fn, ms = 3000) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise<void>((r) => setTimeout(r, 4)); } },
    async heard(k, ms = 3000) { await sim.waitFor(() => spoken.length >= k, ms); await sim.idle(); },
  };
  return sim;
}
