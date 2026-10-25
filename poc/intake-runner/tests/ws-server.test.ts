// The minimal WebSocket server for Twilio ConversationRelay. Everything runs over 127.0.0.1 with a raw-socket stand-in for Twilio.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRelayWsServer, signatureMatches, twilioSignature } from '../src/ws-server.ts';
import type { RelayConnection } from '../src/ws-server.ts';
import { clientFrame, connectRelay } from './helpers/twilio-sim.ts';

const TOKEN = 'test-auth-token-0123456789';
const URL_WSS = 'wss://tunnel.example.test/relay';
const URL_HTTPS = 'https://tunnel.example.test/relay';
const servers: Array<{ close(): Promise<void> }> = [];
after(async () => { for (const s of servers) await s.close(); });

async function start(over: Record<string, unknown> = {}) {
  const got: string[] = []; const conns: RelayConnection[] = []; let closes = 0;
  const server = createRelayWsServer({
    path: '/relay', authToken: TOKEN, urls: [URL_WSS, URL_HTTPS], maxPayload: 2048, idleMs: 5000, maxConnections: 2,
    onConnection: (c) => { conns.push(c); c.onMessage = (t) => got.push(t); c.onClose = () => { closes++; }; }, ...over,
  } as never);
  const port = await server.listen(0);
  servers.push(server);
  return { server, port, got, conns, closes: () => closes };
}
const open = (port: number, o: Record<string, unknown> = {}) => connectRelay({ port, token: TOKEN, url: URL_WSS, ...o } as never);

test('signature: HMAC-SHA1 of the URL, accepted for either URL form, rejected for anything else, in constant time', () => {
  assert.equal(twilioSignature(TOKEN, URL_WSS), createHmac('sha1', TOKEN).update(URL_WSS).digest('base64'));
  assert.equal(signatureMatches(TOKEN, twilioSignature(TOKEN, URL_WSS), [URL_WSS, URL_HTTPS]), true);
  assert.equal(signatureMatches(TOKEN, twilioSignature(TOKEN, URL_HTTPS), [URL_WSS, URL_HTTPS]), true);
  assert.equal(signatureMatches(TOKEN, twilioSignature(TOKEN, 'wss://other.example.test/relay'), [URL_WSS, URL_HTTPS]), false);
  assert.equal(signatureMatches('another-auth-token-xyz', twilioSignature(TOKEN, URL_WSS), [URL_WSS]), false);
  for (const bad of [undefined, null, '', 12, 'x'.repeat(101), ['a']]) assert.equal(signatureMatches(TOKEN, bad, [URL_WSS]), false);
});

test('handshake: a valid, signed upgrade is accepted; the server listens on loopback only', async () => {
  const s = await start();
  const addr = s.server.server.address() as { address: string };
  assert.equal(addr.address, '127.0.0.1');
  const sim = await open(s.port);
  assert.equal(sim.status, 101);
  assert.equal(s.server.open(), 1);
  sim.end(); await sim.closed;
});

test('handshake: wrong signature, missing signature, wrong path, bad key, bad version, no upgrade are all refused with fixed statuses', async () => {
  const s = await start();
  assert.equal((await open(s.port, { signature: 'AAAA' })).status, 403);
  assert.equal((await open(s.port, { signature: null })).status, 403);
  assert.equal((await open(s.port, { path: '/other' })).status, 404);
  assert.equal((await open(s.port, { key: 'not-a-key' })).status, 400);
  assert.equal((await open(s.port, { version: '8' })).status, 400);
  assert.equal(s.conns.length, 0, 'no connection reached the handler');
  const http = await fetch(`http://127.0.0.1:${s.port}/relay`);
  assert.equal(http.status, 404, 'plain HTTP is not served');
  assert.equal((await fetch(`http://127.0.0.1:${s.port}/`, { method: 'POST', body: 'x' })).status, 404);
});

test('handshake: the connection cap is enforced', async () => {
  const s = await start({ maxConnections: 1 });
  const a = await open(s.port); assert.equal(a.status, 101);
  assert.equal((await open(s.port)).status, 503);
  a.end(); await a.closed;
});

test('frames: text messages arrive intact, including multi-byte text, and the handler can answer', async () => {
  const s = await start();
  const sim = await open(s.port);
  sim.send({ type: 'prompt', voicePrompt: 'café 🔧', last: true });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(JSON.parse(s.got[0]), { type: 'prompt', voicePrompt: 'café 🔧', last: true });
  assert.equal(s.conns[0].send({ type: 'text', token: 'ok', last: true }), true);
  assert.deepEqual(await sim.next((m) => m.type === 'text'), { type: 'text', token: 'ok', last: true });
  const big = 'y'.repeat(1500);   // a 16-bit length field
  sim.send({ big }); await new Promise((r) => setTimeout(r, 60));
  assert.equal(JSON.parse(s.got[1]).big.length, 1500);
  sim.end(); await sim.closed;
});

test('frames: ping gets a pong; a close frame is answered and the handler is told once', async () => {
  const s = await start();
  const sim = await open(s.port);
  sim.raw(clientFrame(0x9, 'hi'));
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(sim.frames.some((f) => f.opcode === 0xa && f.data.toString() === 'hi'));
  const c = Buffer.alloc(2); c.writeUInt16BE(1000, 0);
  sim.raw(clientFrame(0x8, c));
  await sim.closed;
  assert.equal(sim.closeCode(), 1000);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(s.closes(), 1);
});

test('frames: unmasked, fragmented, binary, reserved-bit, oversize (by length field alone) and invalid UTF-8 frames each close with the right code', async () => {
  const cases: Array<[string, Buffer, number]> = [
    ['unmasked', clientFrame(0x1, '{}', { mask: false }), 1002],
    ['fragmented', clientFrame(0x1, '{}', { fin: false }), 1003],
    ['binary', clientFrame(0x2, Buffer.from([1, 2, 3])), 1003],
    ['continuation', clientFrame(0x0, '{}'), 1003],
    ['reserved bit', Buffer.concat([Buffer.from([0xc1, 0x80]), Buffer.from([1, 2, 3, 4])]), 1002],
    ['oversize', clientFrame(0x1, 'x', { lengthField: 5000 }), 1009],
    ['invalid utf-8', clientFrame(0x1, Buffer.from([0xff, 0xfe, 0xfd])), 1007],
    ['long control frame', clientFrame(0x9, Buffer.alloc(126)), 1002],
  ];
  for (const [name, bytes, code] of cases) {
    const s = await start();
    const sim = await open(s.port);
    sim.raw(bytes);
    await sim.closed;
    assert.equal(sim.closeCode(), code, name);
    assert.equal(s.got.length, 0, `${name}: nothing reached the handler`);
  }
});

test('frames: a 64-bit length with high bits set is refused without buffering', async () => {
  const s = await start();
  const sim = await open(s.port);
  const f = Buffer.alloc(14); f[0] = 0x81; f[1] = 0x80 | 127; f.writeUInt32BE(1, 2); f.writeUInt32BE(0, 6);
  sim.raw(f);
  await sim.closed;
  assert.equal(sim.closeCode(), 1009);
});

test('idle: a silent connection is closed after the idle time', async () => {
  const s = await start({ idleMs: 150 });
  const sim = await open(s.port);
  await sim.closed;
  assert.equal(sim.closeCode(), 1001);
});

test('handler errors never break the server: a throwing onMessage is contained', async () => {
  const s = await start({ onConnection: (c: RelayConnection) => { c.onMessage = () => { throw new Error('boom'); }; } });
  const sim = await open(s.port);
  sim.send({ a: 1 }); sim.send({ a: 2 });
  await new Promise((r) => setTimeout(r, 60));
  const again = await open(s.port);
  assert.equal(again.status, 101);
});

test('setup is validated', () => {
  const ok = { path: '/relay', authToken: TOKEN, urls: [URL_WSS], onConnection: () => {} };
  assert.doesNotThrow(() => createRelayWsServer(ok));
  for (const bad of [{ path: 'relay' }, { authToken: 'short' }, { urls: [] }, { urls: ['http://x'] }, { onConnection: 1 }, { maxPayload: 10 }, { idleMs: 1 }, { maxConnections: 0 }]) {
    assert.throws(() => createRelayWsServer({ ...ok, ...bad } as never), RangeError);
  }
});
