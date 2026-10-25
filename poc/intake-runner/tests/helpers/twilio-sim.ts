// A tiny stand-in for Twilio's side of a ConversationRelay connection, for local tests over 127.0.0.1 only. It speaks raw RFC 6455 over a
// plain socket so the tests can also send malformed frames. It signs the handshake the way the phone provider does (HMAC-SHA1 of the URL).
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { twilioSignature } from '../../src/ws-server.ts';

export function clientFrame(opcode: number, payload: Buffer | string, o: { fin?: boolean; mask?: boolean; lengthField?: number } = {}): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const mask = o.mask !== false;
  const len = o.lengthField ?? data.length;
  const first = (o.fin === false ? 0 : 0x80) | opcode;
  let head: Buffer;
  if (len < 126) head = Buffer.from([first, (mask ? 0x80 : 0) | len]);
  else if (len < 65536) head = Buffer.from([first, (mask ? 0x80 : 0) | 126, len >> 8, len & 255]);
  else { head = Buffer.alloc(10); head[0] = first; head[1] = (mask ? 0x80 : 0) | 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
  if (!mask) return Buffer.concat([head, data]);
  const key = randomBytes(4);
  const body = Buffer.from(data);
  for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3];
  return Buffer.concat([head, key, body]);
}

export interface SimFrame { opcode: number; data: Buffer }
export interface Sim {
  status: number;
  send(message: unknown): void;
  raw(bytes: Buffer): void;
  /** Resolves with the next JSON text message that matches, or rejects after `ms`. */
  next(match?: (m: any) => boolean, ms?: number): Promise<any>;
  messages: any[];
  frames: SimFrame[];
  closeCode(): number | undefined;
  closed: Promise<void>;
  end(): void;
}

export interface ConnectOptions {
  port: number; token: string; url: string; path?: string; signature?: string | null; key?: string; headers?: Record<string, string>; version?: string;
}
/** Opens a connection. `status` is the HTTP status of the handshake answer (101 when accepted). */
export function connectRelay(o: ConnectOptions): Promise<Sim> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(o.port, '127.0.0.1');
    let head = Buffer.alloc(0); let upgraded = false; let status = 0; let buf = Buffer.alloc(0);
    const taken = new Set<number>();
    const messages: any[] = []; const frames: SimFrame[] = []; const waiters: Array<() => void> = [];
    let code: number | undefined; let resolveClosed!: () => void;
    const closed = new Promise<void>((r) => { resolveClosed = r; });
    const lines = [
      `GET ${o.path ?? '/relay'} HTTP/1.1`, `Host: 127.0.0.1:${o.port}`, 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Key: ${o.key ?? randomBytes(16).toString('base64')}`, `Sec-WebSocket-Version: ${o.version ?? '13'}`,
    ];
    if (o.signature !== null) lines.push(`X-Twilio-Signature: ${o.signature ?? twilioSignature(o.token, o.url)}`);
    for (const [k, v] of Object.entries(o.headers ?? {})) lines.push(`${k}: ${v}`);
    socket.on('connect', () => socket.write(lines.join('\r\n') + '\r\n\r\n'));
    function pump(): void {
      while (buf.length >= 2) {
        let len = buf[1] & 0x7f; let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(6); off = 10; }
        if (buf.length < off + len) return;
        const f = { opcode: buf[0] & 0x0f, data: Buffer.from(buf.subarray(off, off + len)) };
        buf = buf.subarray(off + len);
        frames.push(f);
        if (f.opcode === 0x1) { try { messages.push(JSON.parse(f.data.toString('utf8'))); } catch { /* ignore */ } }
        if (f.opcode === 0x8 && f.data.length >= 2) code = f.data.readUInt16BE(0);
        for (const w of waiters.splice(0)) w();
      }
    }
    socket.on('data', (chunk) => {
      if (!upgraded) {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) return;
        status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head.subarray(0, end).toString('latin1'))?.[1] ?? 0);
        upgraded = true;
        buf = head.subarray(end + 4); head = Buffer.alloc(0);
        const sim: Sim = {
          status, messages, frames, closed,
          send: (m) => { socket.write(clientFrame(0x1, JSON.stringify(m))); },
          raw: (b) => { socket.write(b); },
          closeCode: () => code,
          end: () => socket.end(),
          async next(match = () => true, ms = 3000) {
            const deadline = Date.now() + ms;
            for (;;) {
              const i = messages.findIndex((m, idx) => !taken.has(idx) && match(m));
              if (i >= 0) { taken.add(i); return messages[i]; }
              const left = deadline - Date.now();
              if (left <= 0) throw new Error('timed out waiting for a message');
              await new Promise<void>((r) => { const t = setTimeout(r, Math.min(left, 25)); waiters.push(() => { clearTimeout(t); r(); }); });
            }
          },
        };
        resolve(sim);
        pump();
      } else { buf = Buffer.concat([buf, chunk]); pump(); }
    });
    socket.on('close', () => { if (!upgraded) resolve({ status, messages, frames, closed, send() {}, raw() {}, closeCode: () => code, end() {}, next: () => Promise.reject(new Error('refused')) }); resolveClosed(); });
    socket.on('error', (e) => { if (!upgraded) reject(e); });
  });
}
