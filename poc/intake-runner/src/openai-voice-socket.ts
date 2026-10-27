// The WebSocket to the OpenAI Realtime service for one phone call (step 5 of the OpenAI plan): the VoiceSocket that realtime-bridge.ts is given. It is the ONLY place that would ever hold the OpenAI key,
// and it holds it only for the instant it builds the handshake headers. NOTHING in src imports it yet, and it has never talked to the real service.
//
// What the official documentation says (read 2026-10-27, summarised; not tested live): a server connects to `wss://api.openai.com/v1/realtime?model=<model>` with the header `Authorization: Bearer <key>`
// (browsers use subprotocols instead; this is a server, so it does not), and may add `OpenAI-Safety-Identifier`. The model is chosen by the founder; there is deliberately no default.
//
// Behaviour, all of it checked with a mocked connection (no network, no key):
//   * THE KEY comes from a function (`getKey`), is read once per call, must be plain header-safe characters (no spaces, no line breaks), is passed only in the handshake headers and is never stored, logged, put
//     in a URL, put in an error or echoed in a diagnostic. A missing or unusable key means no connection is attempted at all.
//   * THE ADDRESS is fixed. It cannot be set by configuration, so the key can only ever be sent to OpenAI's Realtime address. The model is validated and goes in the query string.
//   * FAILURE: a refused handshake (a wrong key, no network) looks to a WebSocket client like an error then a close with code 1006 and no reason; that and a connection that does not open in time are both
//     reported once as "closed" to the bridge, which ends the call. There is NEVER a retry: a second attempt could repeat a paid call, and a call in progress cannot be resumed.
//   * SENDING: only a string, only while open, never past a backlog limit (a slow socket refuses, and the bridge counts the refusal and ends the call if it persists).
//   * RECEIVING: only text frames within a size limit; binary frames and oversize frames are dropped and counted.
//   * CLEANUP: closing is idempotent, uses a close code a WebSocket allows (1000 or 3000-4999), clears the connect timer, detaches every handler from the underlying socket and drops the reference to it, so a
//     call that has ended holds nothing and a late event does nothing.
// Diagnostics are fixed codes only. No frame, header, URL or provider message is ever passed to them.

import type { VoiceSocket } from './realtime-bridge.ts';

/** The part of a WebSocket this file uses. Node's built-in `WebSocket` has it, and so does the fake used in the tests. */
export interface WebSocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}
/** Opens a client WebSocket with request headers. Node's built-in WebSocket accepts `{ headers }` (checked on 2026-10-27 against a loopback listener), so no package is needed. */
export type WebSocketFactory = (url: string, init: { headers: Record<string, string> }) => WebSocketLike;

/** Fixed codes only. */
export type VoiceCode = 'VOICE_KEY_MISSING' | 'VOICE_CONNECT_STARTED' | 'VOICE_OPEN' | 'VOICE_CONNECT_TIMEOUT' | 'VOICE_CONNECT_FAILED' | 'VOICE_CLOSED' | 'VOICE_SEND_REFUSED' | 'VOICE_BINARY_DROPPED' | 'VOICE_OVERSIZE_DROPPED' | 'VOICE_CLOSE_REQUESTED';

export interface OpenAiVoiceOptions {
  /** The exact model id, chosen by the founder. No default. */
  model: string;
  /** Returns the key at the moment a call connects. The file never reads the environment itself. */
  getKey: () => string | undefined;
  /** Opens the connection. Defaults to Node's built-in WebSocket. */
  factory?: WebSocketFactory;
  /** An optional stable, privacy-preserving end-user identifier for OpenAI's `OpenAI-Safety-Identifier` header. Never a phone number or a name. */
  safetyIdentifier?: string;
  /** How long to wait for the connection to open. Default 5000. */
  connectTimeoutMs?: number;
  /** A send is refused while this many bytes are waiting. Default 262144. */
  maxBufferedBytes?: number;
  /** The longest text frame accepted. Default 1048576. */
  maxMessageChars?: number;
  /** Fixed codes only. */
  diag?: (code: VoiceCode) => void;
}

export const REALTIME_URL = 'wss://api.openai.com/v1/realtime';
const OPEN = 1;
const MODEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const KEY = /^[A-Za-z0-9_.-]{8,300}$/;
const SAFETY = /^[A-Za-z0-9_.-]{1,64}$/;
const defaultFactory: WebSocketFactory = (url, init) => {
  const Ctor = (globalThis as { WebSocket?: new (url: string, options: unknown) => WebSocketLike }).WebSocket;
  if (typeof Ctor !== 'function') throw new Error('no WebSocket');
  return new Ctor(url, { headers: init.headers });
};

export function createOpenAiVoiceSocket(options: OpenAiVoiceOptions): VoiceSocket {
  if (typeof options !== 'object' || options === null || typeof options.model !== 'string' || !MODEL.test(options.model) || typeof options.getKey !== 'function'
    || (options.factory !== undefined && typeof options.factory !== 'function') || (options.diag !== undefined && typeof options.diag !== 'function')
    || (options.safetyIdentifier !== undefined && (typeof options.safetyIdentifier !== 'string' || !SAFETY.test(options.safetyIdentifier)))
    || [options.connectTimeoutMs, options.maxBufferedBytes, options.maxMessageChars].some((n) => n !== undefined && (!Number.isInteger(n) || n < 1 || n > 100_000_000))) {
    throw new RangeError('the voice socket options are not acceptable');
  }
  const connectTimeoutMs = options.connectTimeoutMs ?? 5000;
  const maxBuffered = options.maxBufferedBytes ?? 262_144;
  const maxChars = options.maxMessageChars ?? 1_048_576;
  const diag = (code: VoiceCode): void => { try { options.diag?.(code); } catch { /* diagnostics never throw into the call */ } };
  let ws: WebSocketLike | undefined;
  let open = false;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const v: VoiceSocket = {
    onOpen: () => {}, onMessage: () => {}, onClose: () => {},
    send(text: string): boolean {
      if (!open || ws === undefined || typeof text !== 'string' || ws.readyState !== OPEN) return false;
      if (ws.bufferedAmount > maxBuffered) { diag('VOICE_SEND_REFUSED'); return false; }
      try { ws.send(text); return true; } catch { return false; }
    },
    close(code?: number): void {
      if (finished) return;
      diag('VOICE_CLOSE_REQUESTED');
      end(code, false);
    },
  };

  /** The one place the socket is let go: idempotent. `report` says whether the bridge is told (it is not when the bridge itself asked for the close). */
  function end(code: number | undefined, report: boolean): void {
    if (finished) return;
    finished = true; open = false;
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    const s = ws; ws = undefined;
    if (s !== undefined) {
      s.onopen = null; s.onmessage = null; s.onclose = null; s.onerror = null;   // a late event from a socket that has been let go does nothing
      try { s.close(code === 1000 || (typeof code === 'number' && code >= 3000 && code <= 4999) ? code : 1000); } catch { /* already gone */ }
    }
    if (report) { diag('VOICE_CLOSED'); try { v.onClose(); } catch { /* the bridge never throws into the socket */ } }
  }

  // ---- connect (once; never retried)
  let key: string | undefined;
  try { key = options.getKey(); } catch { key = undefined; }
  if (typeof key !== 'string' || !KEY.test(key)) {
    key = undefined;
    diag('VOICE_KEY_MISSING');
    queueMicrotask(() => end(undefined, true));   // the bridge has not attached its handlers yet: report on the next turn
    return v;
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (options.safetyIdentifier !== undefined) headers['OpenAI-Safety-Identifier'] = options.safetyIdentifier;
  const url = `${REALTIME_URL}?model=${options.model}`;
  try {
    ws = (options.factory ?? defaultFactory)(url, { headers });
  } catch {
    key = undefined;
    diag('VOICE_CONNECT_FAILED');
    queueMicrotask(() => end(undefined, true));
    return v;
  }
  key = undefined;   // not needed again
  diag('VOICE_CONNECT_STARTED');
  timer = setTimeout(() => { timer = undefined; if (!open) { diag('VOICE_CONNECT_TIMEOUT'); end(1000, true); } }, connectTimeoutMs);
  timer.unref?.();
  ws.onopen = (): void => { if (finished) return; open = true; if (timer !== undefined) { clearTimeout(timer); timer = undefined; } diag('VOICE_OPEN'); try { v.onOpen(); } catch { /* never into the socket */ } };
  ws.onmessage = (ev: { data: unknown }): void => {
    if (finished) return;
    if (typeof ev?.data !== 'string') { diag('VOICE_BINARY_DROPPED'); return; }
    if (ev.data.length > maxChars) { diag('VOICE_OVERSIZE_DROPPED'); return; }
    try { v.onMessage(ev.data); } catch { /* never into the socket */ }
  };
  ws.onerror = (): void => { if (finished) return; if (!open) diag('VOICE_CONNECT_FAILED'); /* the close that follows is what ends the call */ };
  ws.onclose = (): void => { end(1000, true); };
  return v;
}
