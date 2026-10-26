// Minimal WebSocket server for Twilio ConversationRelay (proof of concept). Built on node:http's `upgrade` event and node:crypto only, so
// it adds NO npm dependency. It implements just enough of RFC 6455 for one peer that sends small JSON text frames, and refuses the rest:
//
//   handshake  GET on one exact path, which is a long random SECRET (the signature below is the same for every call, so on its own it is a
//              fixed password that a tunnel provider could read; the secret path is a second factor, compared in constant time); WebSocket version 13; a well-formed key; a valid X-Twilio-Signature (HMAC-SHA1 of the public URL
//              with the account's auth token, compared in constant time); a connection cap. Anything else gets a fixed refusal and the
//              socket is closed. After too many refused handshakes in a short window every upgrade is refused for a while. Plain HTTP requests (not upgrades) get a fixed 404, so this port serves nothing else.
//   frames     client frames must be masked; text, ping, pong and close only; no fragmentation, no extensions, no compression; payload
//              capped (default 64 KB, checked from the length field BEFORE buffering); text must be valid UTF-8; an idle timeout.
//   output     unmasked text frames and close frames; a queue limit closes a stuck peer.
// It binds to 127.0.0.1. The founder's tunnel (their act, not this code's) is what makes it reachable from Twilio.
// Which URL form Twilio signs for the WebSocket handshake (wss:// or https://) is not stated in the pages read when this was written, so the
// caller passes the candidates and any of them is accepted; the first real handshake confirms which one it is.

import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const KEY = /^[A-Za-z0-9+/]{22}==$/;

/** The signature Twilio computes for a request with no form parameters: base64(HMAC-SHA1(token, url)). */
export function twilioSignature(authToken: string, url: string): string {
  return createHmac('sha1', authToken).update(url, 'utf8').digest('base64');
}
export function signatureMatches(authToken: string, header: unknown, urls: readonly string[]): boolean {
  if (typeof header !== 'string' || header.length === 0 || header.length > 100) return false;
  const given = Buffer.from(header, 'utf8');
  let ok = false;
  for (const u of urls) {
    const want = Buffer.from(twilioSignature(authToken, u), 'utf8');
    if (want.length === given.length && timingSafeEqual(want, given)) ok = true;   // no early exit: the time does not depend on which URL matched
  }
  return ok;
}

export interface RelayConnection {
  /** Sends one JSON message. False when the peer is gone or too slow. */
  send(message: unknown): boolean;
  close(code?: number): void;
  /** Set by the handler. Called with each text frame (already valid UTF-8, within the size cap). */
  onMessage: (text: string) => void;
  /** Called once when the connection ends for any reason. */
  onClose: () => void;
}
export interface RelayWsConfig {
  /** Exact request path, for example `/relay`. */
  path: string;
  /** Twilio auth token, taken from the environment by the composition root. Never logged. */
  authToken: string;
  /** Every URL form that may have been signed (see the header). */
  urls: readonly string[];
  maxPayload?: number;
  idleMs?: number;
  maxConnections?: number;
  /** After `failures` refused handshakes within `windowMs`, every upgrade is refused (503) until the window clears. Default 8 in 60 s. */
  lockout?: { failures: number; windowMs: number };
  onConnection(conn: RelayConnection): void;
}
export interface RelayWsServer {
  listen(port: number): Promise<number>;
  close(): Promise<void>;
  open(): number;
  readonly server: Server;
}

const REFUSALS: Record<number, string> = { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 426: 'Upgrade Required', 503: 'Service Unavailable' };
/** Equal-length byte comparison in constant time; different lengths are simply not equal. */
function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8'); const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}
function refuseSocket(socket: Duplex, status: number): void {
  try { socket.end(`HTTP/1.1 ${status} ${REFUSALS[status] ?? 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ }
  socket.destroy();
}

/** A server-to-client frame (never masked). Exported for the tests. */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : (() => {
    const h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(n, 6); return h;
  })();
  return Buffer.concat([head, payload]);
}

export function createRelayWsServer(config: RelayWsConfig): RelayWsServer {
  const { path, authToken, urls, onConnection } = config;
  if (typeof path !== 'string' || !/^\/[A-Za-z0-9_./-]{0,127}$/.test(path)) throw new RangeError('path must be an absolute path');
  if (typeof authToken !== 'string' || authToken.length < 8) throw new RangeError('authToken is required');
  if (!Array.isArray(urls) || urls.length === 0 || !urls.every((u) => typeof u === 'string' && /^(wss|https):\/\//.test(u))) throw new RangeError('urls must be wss:// or https:// addresses');
  if (typeof onConnection !== 'function') throw new RangeError('onConnection is required');
  const maxPayload = config.maxPayload ?? 65_536;
  const idleMs = config.idleMs ?? 60_000;
  const maxConnections = config.maxConnections ?? 2;
  const lockFailures = config.lockout?.failures ?? 8;
  const lockWindow = config.lockout?.windowMs ?? 60_000;
  if (!Number.isInteger(lockFailures) || lockFailures < 1 || lockFailures > 100) throw new RangeError('lockout.failures must be 1 to 100');
  if (!Number.isInteger(lockWindow) || lockWindow < 50 || lockWindow > 3_600_000) throw new RangeError('lockout.windowMs must be 50 to 3600000');
  const refusals: number[] = [];
  const locked = (): boolean => { const now = Date.now(); while (refusals.length > 0 && now - refusals[0] > lockWindow) refusals.shift(); return refusals.length >= lockFailures; };
  if (!Number.isInteger(maxPayload) || maxPayload < 1024 || maxPayload > 1_048_576) throw new RangeError('maxPayload must be 1024 to 1048576');
  if (!Number.isInteger(idleMs) || idleMs < 100 || idleMs > 600_000) throw new RangeError('idleMs must be 100 to 600000');
  if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 10) throw new RangeError('maxConnections must be 1 to 10');

  const sockets = new Set<Duplex>();
  const server = createServer((_req, res) => { res.writeHead(404, { 'Content-Length': '0', Connection: 'close' }); res.end(); });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      const h = req.headers;
      if (locked()) return refuseSocket(socket, 503);
      const refuse = (status: number): void => { refusals.push(Date.now()); if (refusals.length > 1000) refusals.shift(); refuseSocket(socket, status); };
      const pathOnly = String(req.url ?? '');
      if (req.method !== 'GET' || !sameText(pathOnly, path)) return refuse(404);
      if (String(h.upgrade ?? '').toLowerCase() !== 'websocket' || !String(h.connection ?? '').toLowerCase().split(',').map((s) => s.trim()).includes('upgrade')) return refuse(426);
      if (h['sec-websocket-version'] !== '13' || typeof h['sec-websocket-key'] !== 'string' || !KEY.test(h['sec-websocket-key'])) return refuse(400);
      if (!signatureMatches(authToken, h['x-twilio-signature'], urls)) return refuse(403);
      if (sockets.size >= maxConnections) return refuseSocket(socket, 503);
      const accept = createHash('sha1').update(h['sec-websocket-key'] + GUID).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      accepted(socket, head);
    } catch { refuseSocket(socket, 400); }
  });

  function accepted(socket: Duplex, head: Buffer): void {
    sockets.add(socket);
    let buf: Buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
    let closing = false;
    let ended = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const conn: RelayConnection = {
      send(message: unknown): boolean {
        if (closing || ended || socket.destroyed) return false;
        if (socket.writableLength > 1_048_576) { shut(1013); return false; }
        try { socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(message), 'utf8'))); return true; } catch { return false; }
      },
      close(code = 1000): void { shut(code); },
      onMessage: () => {},
      onClose: () => {},
    };
    function finish(): void {
      if (ended) return;
      ended = true;
      if (timer !== undefined) clearTimeout(timer);
      sockets.delete(socket);
      try { conn.onClose(); } catch { /* the handler must not break the server */ }
    }
    function shut(code: number): void {
      if (closing) return;
      closing = true;
      try { const p = Buffer.alloc(2); p.writeUInt16BE(code, 0); socket.write(encodeFrame(0x8, p)); } catch { /* gone */ }
      try { socket.end(); } catch { /* gone */ }
      setTimeout(() => { try { socket.destroy(); } catch { /* gone */ } }, 1000).unref();
    }
    const touch = (): void => { if (timer !== undefined) clearTimeout(timer); timer = setTimeout(() => shut(1001), idleMs); timer.unref?.(); };
    touch();

    function parse(): void {
      while (!closing && buf.length >= 2) {
        const b0 = buf[0]; const b1 = buf[1];
        if ((b0 & 0x70) !== 0) return shut(1002);                  // reserved bits: no extensions were negotiated
        const fin = (b0 & 0x80) !== 0; const op = b0 & 0x0f; const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f; let off = 2;
        if (!masked) return shut(1002);                            // clients must mask
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; if (buf.readUInt32BE(2) !== 0) return shut(1009); len = buf.readUInt32BE(6); off = 10; }
        if (len > maxPayload) return shut(1009);                   // refused from the length field, before any buffering
        if (op >= 0x8 && (len > 125 || !fin)) return shut(1002);   // control frames are short and whole
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
        buf = buf.subarray(off + 4 + len);
        touch();
        if (op === 0x1) {
          if (!fin) return shut(1003);                             // no fragmented messages
          let textValue: string;
          try { textValue = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { return shut(1007); }
          try { conn.onMessage(textValue); } catch { /* the handler must not break the server */ }
        } else if (op === 0x9) { try { socket.write(encodeFrame(0xa, data)); } catch { /* gone */ } }
        else if (op === 0xa) { /* pong: nothing to do */ }
        else if (op === 0x8) { return shut(1000); }
        else return shut(1003);                                    // binary, continuation and unknown opcodes
      }
    }
    socket.on('data', (chunk: Buffer) => {
      if (closing) return;
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      if (buf.length > maxPayload + 14 + 4096) return shut(1009);
      parse();
    });
    socket.on('error', () => { /* the close event follows */ });
    socket.on('close', finish);
    socket.on('end', () => { shut(1000); finish(); });
    try { onConnection(conn); } catch { shut(1011); }
    if (buf.length > 0) parse();
  }

  return Object.freeze({
    server,
    open(): number { return sockets.size; },
    listen(p: number): Promise<number> {
      if (!Number.isInteger(p) || p < 0 || p > 65535) throw new RangeError('port must be an integer from 0 to 65535');
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(p, '127.0.0.1', () => { const a = server.address(); resolve(typeof a === 'object' && a !== null ? a.port : p); });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); server.closeAllConnections?.(); });
    },
  });
}
