// The minimal WebSocket server for Twilio ConversationRelay. Everything runs over 127.0.0.1 with a raw-socket stand-in for Twilio.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRelayWsServer, signatureMatches, twilioSignature } from '../src/ws-server.ts';
import type { RelayConnection } from '../src/ws-server.ts';
import { clientFrame, connectRelay } from './helpers/twilio-sim.ts';
import { signedUrlCandidates } from '../src/founder-call-gate.ts';

const TOKEN = 'test-auth-token-0123456789';
const PATH = '/relay/q7Zr2KfX9mWc4TbV8nHs1LpD6yGe3AuJ5oRi0NxE';
const URL_WSS = `wss://tunnel.example.test${PATH}`;
const URL_HTTPS = `https://tunnel.example.test${PATH}`;
const servers: Array<{ close(): Promise<void> }> = [];
after(async () => { for (const s of servers) await s.close(); });

async function start(over: Record<string, unknown> = {}) {
  const got: string[] = []; const conns: RelayConnection[] = []; let closes = 0;
  const server = createRelayWsServer({
    path: PATH, authToken: TOKEN, urls: [URL_WSS, URL_HTTPS], maxPayload: 2048, idleMs: 5000, maxConnections: 2,
    onConnection: (c) => { conns.push(c); c.onMessage = (t) => got.push(t); c.onClose = () => { closes++; }; }, ...over,
  } as never);
  const port = await server.listen(0);
  servers.push(server);
  return { server, port, got, conns, closes: () => closes };
}
const open = (port: number, o: Record<string, unknown> = {}) => connectRelay({ port, token: TOKEN, url: URL_WSS, path: PATH, ...o } as never);

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
  const s = await start({ lockout: { failures: 100, windowMs: 60_000 } });
  assert.equal((await open(s.port, { signature: 'AAAA' })).status, 403);
  assert.equal((await open(s.port, { signature: null })).status, 403);
  assert.equal((await open(s.port, { path: '/other' })).status, 404);
  for (const near of ['/relay', `${PATH}/`, `${PATH}x`, PATH.slice(0, -1), PATH.toUpperCase()]) assert.equal((await open(s.port, { path: near })).status, 404, near);
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

test('signature forms: a handshake signed over the wss or https address, with or without a trailing slash, is accepted; any other form is refused', async () => {
  const s = await start({ urls: signedUrlCandidates(URL_WSS), lockout: { failures: 100, windowMs: 60_000 }, maxConnections: 10 });
  for (const form of [URL_WSS, URL_HTTPS, `${URL_WSS}/`, `${URL_HTTPS}/`]) assert.equal((await open(s.port, { url: form })).status, 101, form);
  for (const form of [`${URL_WSS}//`, `${URL_WSS}?x=1`, `${URL_HTTPS}#frag`, URL_WSS.toUpperCase(), URL_WSS.replace('tunnel.example.test', 'other.example.test'), URL_HTTPS.replace('https:', 'http:'), URL_WSS.replace(PATH, `${PATH}/extra`), URL_WSS.slice(0, -1)]) {
    assert.equal((await open(s.port, { url: form })).status, 403, form);
  }
});

test('signature forms: a port in the configured address also accepts the forms without it', async () => {
  const withPort = URL_WSS.replace('tunnel.example.test', 'tunnel.example.test:8443');
  const s = await start({ urls: signedUrlCandidates(withPort), lockout: { failures: 100, windowMs: 60_000 }, maxConnections: 10 });
  for (const form of [withPort, withPort.replace('wss:', 'https:'), `${withPort}/`, URL_WSS, URL_HTTPS, `${URL_WSS}/`, `${URL_HTTPS}/`]) assert.equal((await open(s.port, { url: form })).status, 101, form);
  assert.equal((await open(s.port, { url: URL_WSS.replace('tunnel.example.test', 'tunnel.example.test:9999') })).status, 403, 'a different port is not a candidate');
});

test('signature forms: a trailing slash on the SIGNED address does not widen the request path, which must still be exact', async () => {
  const s = await start({ urls: signedUrlCandidates(URL_WSS), lockout: { failures: 100, windowMs: 60_000 }, maxConnections: 10 });
  assert.equal((await open(s.port, { url: `${URL_WSS}/` })).status, 101);
  assert.equal((await open(s.port, { url: `${URL_WSS}/`, path: `${PATH}/` })).status, 404);
});

test('lockout: repeated refused handshakes lock the door for a while, even to the right caller, then it reopens', async () => {
  const s = await start({ lockout: { failures: 3, windowMs: 400 } });
  assert.equal((await open(s.port)).status, 101, 'before the lockout');
  for (let i = 0; i < 3; i++) assert.equal((await open(s.port, { signature: 'AAAA' })).status, 403);
  assert.equal((await open(s.port)).status, 503, 'locked, even with the right credentials');
  assert.equal((await open(s.port, { signature: 'AAAA' })).status, 503, 'and locked-out attempts are not counted again');
  await new Promise((r) => setTimeout(r, 450));
  assert.equal((await open(s.port)).status, 101, 'reopened after the window');
});

test('lockout: successful handshakes never count against the caller', async () => {
  const s = await start({ lockout: { failures: 2, windowMs: 5000 }, maxConnections: 10 });
  for (let i = 0; i < 6; i++) assert.equal((await open(s.port)).status, 101);
});

test('setup is validated', () => {
  const ok = { path: PATH, authToken: TOKEN, urls: [URL_WSS], onConnection: () => {} };
  assert.doesNotThrow(() => createRelayWsServer(ok));
  for (const bad of [{ path: 'relay' }, { authToken: 'short' }, { urls: [] }, { urls: ['http://x'] }, { onConnection: 1 }, { maxPayload: 10 }, { idleMs: 1 }, { maxConnections: 0 }, { lockout: { failures: 0, windowMs: 1000 } }, { lockout: { failures: 3, windowMs: 1 } }]) {
    assert.throws(() => createRelayWsServer({ ...ok, ...bad } as never), RangeError);
  }
});

// ---------------------------------------------------------------- who closed the connection (a fixed word and a number; used for diagnostics)
async function startWithInfo(over: Record<string, unknown> = {}) {
  const infos: Array<{ cause: string; code: number } | undefined> = []; const conns: RelayConnection[] = [];
  const server = createRelayWsServer({
    path: PATH, authToken: TOKEN, urls: [URL_WSS, URL_HTTPS], maxPayload: 2048, idleMs: 5000, maxConnections: 2,
    onConnection: (c) => { conns.push(c); c.onClose = (i) => { infos.push(i); }; }, ...over,
  } as never);
  const port = await server.listen(0);
  servers.push(server);
  return { port, infos, conns };
}
const until = async (fn: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 15)); } };

test('close cause: the phone provider ending the connection is PEER (with its close code when it sent one)', async () => {
  const s = await startWithInfo();
  const a = await open(s.port); a.end(); await until(() => s.infos.length === 1);
  assert.deepEqual(s.infos[0], { cause: 'PEER', code: 0 });
  const b = await open(s.port); b.raw(clientFrame(0x8, Buffer.from([0x03, 0xe9]))); await until(() => s.infos.length === 2);
  assert.deepEqual(s.infos[1], { cause: 'PEER', code: 1001 });
});

test('close cause: the handler closing is HANDLER, the idle timer is IDLE, and a protocol violation is PROTOCOL', async () => {
  const s = await startWithInfo();
  await open(s.port); await until(() => s.conns.length === 1);
  s.conns[0].close(1000); await until(() => s.infos.length === 1);
  assert.deepEqual(s.infos[0], { cause: 'HANDLER', code: 1000 });

  const idle = await startWithInfo({ idleMs: 150 });
  await open(idle.port); await until(() => idle.infos.length === 1);
  assert.deepEqual(idle.infos[0], { cause: 'IDLE', code: 1001 });

  const bad = await startWithInfo();
  const c = await open(bad.port); c.raw(clientFrame(0x1, 'x', { mask: false })); await until(() => bad.infos.length === 1);
  assert.deepEqual(bad.infos[0], { cause: 'PROTOCOL', code: 1002 });
});

test('close cause: the first reason wins, and onClose is still called exactly once', async () => {
  const s = await startWithInfo();
  const a = await open(s.port); await until(() => s.conns.length === 1);
  s.conns[0].close(1000); a.end(); await new Promise((r) => setTimeout(r, 150));
  assert.equal(s.infos.length, 1);
  assert.equal(s.infos[0]?.cause, 'HANDLER');
});
