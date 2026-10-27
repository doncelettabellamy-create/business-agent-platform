// Offline stand-ins for the two ends of src/realtime-bridge.ts, for tests only: a phone (a Media Streams style audio connection that plays what it is sent, in time, and echoes marks as
// they are played) and a voice service (a WebSocket that takes settings, audio and "say exactly ..." requests and answers with audio, transcripts and events). No socket, no network, no key.
//
// IMPORTANT: both are models built from documentation read on 2026-10-27. Nothing here has been checked against Twilio or OpenAI, so a passing test shows behaviour against THESE models only.
import { wordsOf } from '../../src/realtime-transport.ts';
import { refusalFor } from './realtime-schema-rules.ts';
import type { VoiceSocket } from '../../src/realtime-bridge.ts';
import type { CloseInfo, RelayConnection } from '../../src/ws-server.ts';

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
export type Behaviour = 'exact' | 'words' | 'currency' | 'silent' | 'fail' | { say: string };
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const numberWords = (n: number): string => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 === 0 ? '' : '-' + ONES[n % 10]}`);
/** How a voice model reads an amount: "$25 off" becomes "twenty-five dollars off". */
export const asSpokenCurrency = (s: string): string => s.replace(/\$(\d{1,2})\b/g, (_m, n: string) => `${numberWords(Number(n))} dollars`);
const tick = (ms = 0): Promise<void> => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
export const b64 = (bytes: number): string => Buffer.alloc(bytes, 0x7f).toString('base64');

export interface WirePhone extends RelayConnection {
  /** Everything the bridge sent to the phone, in order. */
  sent: any[];
  closedWith: Array<number | undefined>;
  /** Total milliseconds of audio the phone has actually played. */
  playedMs(): number;
  /** Whether it still holds audio it has not played. */
  playing(): boolean;
  /** The phone starts the stream. */
  start(o?: { to?: string; callSid?: string; streamSid?: string; encoding?: string; sampleRate?: number }): void;
  /** The caller's audio: `n` frames of 20 ms. */
  frames(n: number): void;
  raw(text: string): void;
  stop(): void;
  /** Resolves when the phone has nothing left to play. */
  drained(): Promise<void>;
  /** Stops answering marks (a phone that never reports played audio). */
  muteMarks: boolean;
}
export interface WireVoice extends VoiceSocket {
  received: any[];
  /** Requests refused as the documented schema would (see the link-level stand-in). */
  refused: string[];
  appended(): number;
  /** The settings last sent. */
  settings(): any;
  spoken: string[];
  closedWith: Array<number | undefined>;
  open(): void;
  /** The caller speaks (the voice service hears it): over a reply if one is playing. */
  hear(text: string): void;
  playing(): boolean;
  emit(m: unknown): void;
  emitRaw(t: string): void;
  idle(): Promise<void>;
}

export function createWirePhone(o: { speed?: number } = {}): WirePhone {
  const speed = o.speed ?? 1;
  let playEnd = 0; let played = 0;
  const pending: Array<{ name: string; at: number; timer: ReturnType<typeof setTimeout> }> = [];
  const phone: WirePhone = {
    sent: [], closedWith: [], muteMarks: false,
    playedMs: () => Math.floor(played), playing: () => pending.length > 0,
    send(m: unknown): boolean {
      const msg = m as any;
      phone.sent.push(structuredClone(msg));
      const nowT = Date.now();
      if (msg.event === 'media') {
        const ms = Buffer.from(String(msg.media.payload), 'base64').length / 8;
        playEnd = Math.max(nowT, playEnd) + ms / speed; played += ms;
      } else if (msg.event === 'mark' && !phone.muteMarks) {
        const entry = { name: String(msg.mark.name), at: playEnd, timer: undefined as unknown as ReturnType<typeof setTimeout> };
        entry.timer = setTimeout(() => { const i = pending.indexOf(entry); if (i >= 0) pending.splice(i, 1); phone.onMessage(JSON.stringify({ event: 'mark', streamSid: 'MZ1', mark: { name: entry.name } })); }, Math.max(0, entry.at - nowT));
        entry.timer.unref?.();
        pending.push(entry);
      } else if (msg.event === 'clear') {
        // The phone drops what it has not played and reports every pending marker at once, as Twilio does.
        const all = pending.splice(0);
        const left = Math.max(0, playEnd - nowT); played -= left * speed; playEnd = nowT;
        for (const p of all) { clearTimeout(p.timer); phone.onMessage(JSON.stringify({ event: 'mark', streamSid: 'MZ1', mark: { name: p.name } })); }
      }
      return true;
    },
    close(code?: number): void { phone.closedWith.push(code); },
    onMessage: () => {},
    onClose: (_i?: CloseInfo) => {},
    start(s = {}) {
      phone.onMessage(JSON.stringify({ event: 'start', start: { streamSid: s.streamSid ?? 'MZ1', callSid: s.callSid ?? 'CA00000000000000000000000000000001', customParameters: { to: s.to ?? '+15555550100' }, mediaFormat: { encoding: s.encoding ?? 'audio/x-mulaw', sampleRate: s.sampleRate ?? 8000, channels: 1 } } }));
    },
    frames(n) { for (let i = 0; i < n; i++) phone.onMessage(JSON.stringify({ event: 'media', media: { payload: b64(160), track: 'inbound' } })); },
    raw(text) { phone.onMessage(text); },
    stop() { phone.onMessage(JSON.stringify({ event: 'stop' })); },
    async drained() { for (let i = 0; i < 400 && pending.length > 0; i++) await tick(3); },
  };
  return phone;
}

export function createWireVoice(o: { msPerChar?: number; behave?: (text: string, n: number) => Behaviour; accept?: () => boolean; autoOpen?: boolean } = {}): WireVoice {
  const mpc = o.msPerChar ?? 2;
  const received: any[] = []; const refused: string[] = []; const items = new Set<string>(); const spoken: string[] = []; const closedWith: Array<number | undefined> = [];
  let isOpen = false; let interruptible = true; let n = 0; let item = 0; let appended = 0; let settings: any;
  let chain: Promise<void> = Promise.resolve();
  interface Play { rid: string; mid: string; text: string; b: Behaviour; timer?: ReturnType<typeof setTimeout>; cancelled: boolean }
  let play: Play | undefined;
  const deliver = (m: unknown): void => { chain = chain.then(() => tick(0)).then(() => { if (isOpen) v.onMessage(JSON.stringify(m)); }); };
  const asWords = (s: string): string => s.replace(/\d/g, (d) => ` ${WORDS[Number(d)]} `).replace(/\s+/g, ' ').trim();

  function begin(m: any): void {
    const ins = String(m.response?.instructions ?? '');
    const text = wordsOf(ins);
    n++;
    const p: Play = { rid: `resp_${n}`, mid: String(m.response?.metadata?.id), text, b: o.behave?.(text, n) ?? 'exact', cancelled: false };
    play = p;
    deliver({ type: 'response.created', response: { id: p.rid, metadata: { id: p.mid } } });
    const bytes = p.b === 'fail' || p.b === 'silent' ? 0 : text.length * mpc * 8;
    const chunk = 800;   // 100 ms of audio
    let sent = 0;
    const step = (): void => {
      if (p.cancelled) return;
      if (sent < bytes) {
        const k = Math.min(chunk, bytes - sent); sent += k;
        deliver({ type: 'response.output_audio.delta', response_id: p.rid, delta: b64(k) });
        p.timer = setTimeout(step, Math.max(1, Math.floor(k / 8 / 4))); p.timer.unref?.();   // generated four times faster than it plays
        return;
      }
      play = undefined;
      let status = 'completed'; let transcript: string | undefined = p.text;
      if (p.b === 'words') transcript = asWords(p.text);
      else if (p.b === 'currency') transcript = asSpokenCurrency(p.text);
      else if (p.b === 'silent') transcript = undefined;
      else if (p.b === 'fail') { status = 'failed'; transcript = undefined; }
      else if (typeof p.b === 'object') transcript = p.b.say;
      if (transcript !== undefined) deliver({ type: 'response.output_audio_transcript.done', response_id: p.rid, transcript });
      if (status === 'completed' && transcript !== undefined) spoken.push(transcript);
      const audioTokens = Math.ceil((p.text.length * mpc) / 50);
      deliver({ type: 'response.done', response: { id: p.rid, status, metadata: { id: p.mid }, usage: { input_tokens: 150, output_tokens: audioTokens, output_token_details: { audio_tokens: audioTokens, text_tokens: 0 } } } });
    };
    p.timer = setTimeout(step, 1); p.timer.unref?.();
  }
  function cancel(): void {
    const p = play; if (p === undefined) return;
    p.cancelled = true; if (p.timer !== undefined) clearTimeout(p.timer); play = undefined;
    deliver({ type: 'response.done', response: { id: p.rid, status: 'cancelled', metadata: { id: p.mid } } });
  }
  const refuse = (m: any, why: string, code: string): void => { refused.push(why); deliver({ type: 'error', error: { type: 'invalid_request_error', code, message: why, event_id: m.event_id ?? null } }); };
  const v: WireVoice = {
    received, refused, spoken, closedWith,
    appended: () => appended, settings: () => settings, playing: () => play !== undefined,
    send(text: string): boolean {
      if (!isOpen || !(o.accept?.() ?? true)) return false;
      const m = JSON.parse(text);
      received.push(m);
      if (m.type === 'input_audio_buffer.append') appended++;
      else if (m.type === 'session.update') { { const why = refusalFor(m); if (why !== undefined) { refuse(m, why, 'invalid_request_error'); return true; } } deliver({ type: 'session.updated', session: m.session }); settings = m.session; const td = m.session?.audio?.input?.turn_detection; if (td && typeof td.interrupt_response === 'boolean') interruptible = td.interrupt_response; }
      else if (m.type === 'response.create') { const why = refusalFor(m); if (why !== undefined) refuse(m, why, 'invalid_request_error'); else begin(m); }
      else if (m.type === 'response.cancel') {
        if (typeof m.response_id !== 'string') refused.push('response.cancel without response_id');   // not in the default conversation: it reaches nothing
        else if (play === undefined || play.rid !== m.response_id) refuse(m, 'response.cancel of a reply that is not playing', 'response_cancel_not_active');
        else cancel();
      } else if (m.type === 'conversation.item.delete') {
        if (typeof m.item_id !== 'string' || !items.has(m.item_id)) refuse(m, 'conversation.item.delete of an item that does not exist', 'item_not_found');
        else { items.delete(m.item_id); deliver({ type: 'conversation.item.deleted', item_id: m.item_id }); }
      }
      return true;
    },
    close(code?: number): void { closedWith.push(code); isOpen = false; },
    onOpen: () => {}, onMessage: () => {}, onClose: () => {},
    open() { isOpen = true; v.onOpen(); },
    hear(text) {
      const id = `item_${++item}`; items.add(id);
      deliver({ type: 'input_audio_buffer.speech_started' });
      if (play !== undefined && interruptible) chain = chain.then(() => { cancel(); });
      deliver({ type: 'input_audio_buffer.speech_stopped' });
      deliver({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: text });
    },
    emit(m) { deliver(m); },
    emitRaw(t) { chain = chain.then(() => tick(0)).then(() => { v.onMessage(t); }); },
    async idle() { for (let i = 0; i < 400; i++) { const before = chain; await before; await tick(3); if (play === undefined && before === chain) return; await tick(4); } throw new Error('the voice stand-in did not go idle'); },
  };
  if (o.autoOpen !== false) queueMicrotask(() => { void tick(0).then(() => v.open()); });
  return v;
}
