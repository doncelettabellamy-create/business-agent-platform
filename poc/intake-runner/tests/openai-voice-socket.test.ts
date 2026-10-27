// The WebSocket to OpenAI Realtime (src/openai-voice-socket.ts), tested with a MOCKED connection: no network, no real key. Every key here is an invented string. It checks how the key is handled, what happens
// when the connection fails, is cancelled or is cleaned up, and how the socket sits under the voice bridge. A passing test shows behaviour against the mock, not against OpenAI. Run: npm test
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { createOpenAiVoiceSocket, REALTIME_URL } from '../src/openai-voice-socket.ts';
import type { OpenAiVoiceOptions, VoiceCode, WebSocketLike } from '../src/openai-voice-socket.ts';
import { createRealtimeBridge } from '../src/realtime-bridge.ts';
import { createRealtimeTransport } from '../src/realtime-transport.ts';
import type { TransportEvent } from '../src/call-transport.ts';
import { createWirePhone } from './helpers/realtime-wire-sim.ts';

const FAKE_KEY = 'sk-test-not-a-real-key-0123456789';
const MODEL = 'gpt-realtime-test';
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000): Promise<void> { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await pause(4); } }

/** A mocked client WebSocket: the test decides when it opens, what it receives and how it ends. */
class FakeWs implements WebSocketLike {
  readyState = 0; bufferedAmount = 0; sent: string[] = []; closeCalls: Array<number | undefined> = []; throwOnSend = false;
  onopen: ((e: unknown) => void) | null = null; onmessage: ((e: { data: unknown }) => void) | null = null; onclose: ((e: unknown) => void) | null = null; onerror: ((e: unknown) => void) | null = null;
  readonly url: string; readonly headers: Record<string, string>;
  constructor(url: string, headers: Record<string, string>) { this.url = url; this.headers = headers; }
  send(data: string): void { if (this.throwOnSend) throw new Error('send failed'); this.sent.push(data); }
  close(code?: number): void { this.closeCalls.push(code); this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.({}); }
  message(data: unknown): void { this.onmessage?.({ data }); }
  /** What a refused handshake (a wrong key, no network) looks like to a WebSocket client: an error, then a close with code 1006. */
  refuse(): void { this.readyState = 3; this.onerror?.({}); this.onclose?.({ code: 1006 }); }
  remoteClose(): void { this.readyState = 3; this.onclose?.({ code: 1000 }); }
}
function rig(over: Partial<OpenAiVoiceOptions> = {}, key: () => string | undefined = () => FAKE_KEY) {
  const made: FakeWs[] = []; const diags: VoiceCode[] = []; let keyReads = 0;
  const voice = createOpenAiVoiceSocket({
    model: MODEL, getKey: () => { keyReads++; return key(); }, diag: (c) => { diags.push(c); }, connectTimeoutMs: 5000,
    factory: (url, init) => { const w = new FakeWs(url, init.headers); made.push(w); return w; }, ...over,
  });
  const got = { opens: 0, messages: [] as string[], closes: 0 };
  voice.onOpen = () => { got.opens++; }; voice.onMessage = (t) => { got.messages.push(t); }; voice.onClose = () => { got.closes++; };
  return { voice, made, diags, got, keyReads: () => keyReads, ws: () => made[0] };
}

// ================================================================ options
test('options: a model that is not an exact id, a missing key function, an unsafe identifier or silly timings are refused, echoing nothing', () => {
  const CANARY = 'canary-value-4417';
  const bad: Array<Partial<OpenAiVoiceOptions>> = [
    { model: '' }, { model: `x&key=${CANARY}` }, { model: 'GPT Realtime' }, { model: `a/${CANARY}` }, { model: undefined as never }, { getKey: undefined as never },
    { safetyIdentifier: `user ${CANARY}` }, { safetyIdentifier: 5 as never }, { connectTimeoutMs: 0 }, { maxBufferedBytes: 1.5 }, { maxMessageChars: -1 }, { factory: 'x' as never }, { diag: 'x' as never },
  ];
  for (const o of bad) assert.throws(() => rig(o), (e: unknown) => e instanceof RangeError && !String((e as Error).message).includes(CANARY), JSON.stringify(o));
  assert.throws(() => createOpenAiVoiceSocket(null as never), RangeError);
});

// ================================================================ authentication handling
test('auth: the key goes only into the handshake header, to OpenAI\'s fixed Realtime address, with the model in the query and nothing else', () => {
  const r = rig({ safetyIdentifier: 'drew-founder-test' });
  assert.equal(r.made.length, 1);
  assert.equal(r.ws().url, `wss://api.openai.com/v1/realtime?model=${MODEL}`);
  assert.equal(r.ws().url.split('?')[0], REALTIME_URL);
  assert.deepEqual(r.ws().headers, { Authorization: `Bearer ${FAKE_KEY}`, 'OpenAI-Safety-Identifier': 'drew-founder-test' });
  assert.ok(!r.ws().url.includes(FAKE_KEY), 'never in the address');
  assert.equal(r.keyReads(), 1, 'read once per call');
  assert.ok(!JSON.stringify(r.diags).includes(FAKE_KEY));
  assert.deepEqual(rig().ws().headers, { Authorization: `Bearer ${FAKE_KEY}` }, 'no identifier unless one is given');
});

test('auth: the address cannot be changed by configuration, so the key can only go to OpenAI', () => {
  const r = rig({ url: 'wss://evil.example.test/steal', baseUrl: 'wss://evil.example.test', host: 'evil.example.test' } as never);
  assert.equal(r.ws().url, `wss://api.openai.com/v1/realtime?model=${MODEL}`);
});

test('auth: no usable key means no connection is attempted at all; the bridge is told the socket closed, once, on the next turn', async () => {
  for (const k of [undefined, '', 'short', 'has a space in it', 'line\r\nbreak-0123456789', 'quote"in-the-key-0123456789', 'x'.repeat(301), 12 as never]) {
    const r = rig({}, () => k);
    assert.equal(r.made.length, 0, String(k).slice(0, 10));
    assert.equal(r.got.closes, 0, 'not reported inside the call that built the socket: the bridge has not attached yet');
    await pause(5);
    assert.deepEqual([r.got.closes, r.got.opens], [1, 0]);
    assert.deepEqual(r.diags, ['VOICE_KEY_MISSING', 'VOICE_CLOSED']);
    assert.equal(r.voice.send('{}'), false);
  }
  const thrown = rig({}, () => { throw new Error('vault locked'); });
  await pause(5);
  assert.deepEqual([thrown.made.length, thrown.got.closes], [0, 1]);
});

// ================================================================ connection failure
test('failure: a refused handshake (error, then close 1006) is reported once as closed, with no retry', async () => {
  const r = rig();
  r.ws().refuse();
  assert.deepEqual([r.got.opens, r.got.closes], [0, 1]);
  assert.equal(r.made.length, 1, 'no second attempt');
  assert.equal(r.voice.send('{}'), false);
  await pause(30);
  assert.equal(r.made.length, 1);
  assert.ok(r.diags.includes('VOICE_CONNECT_FAILED') && r.diags.includes('VOICE_CLOSED'));
  assert.ok(!r.diags.includes('VOICE_CONNECT_TIMEOUT'), 'the connect timer was cleared');
});

test('failure: a connection that does not open in time is closed and reported once; a late open does nothing', async () => {
  const r = rig({ connectTimeoutMs: 30 });
  await until(() => r.got.closes === 1);
  assert.deepEqual(r.ws().closeCalls, [1000]);
  assert.ok(r.diags.includes('VOICE_CONNECT_TIMEOUT'));
  assert.equal(r.ws().onopen, null, 'handlers are detached');
  assert.doesNotThrow(() => r.ws().open());
  assert.deepEqual([r.got.opens, r.got.closes], [0, 1]);
  assert.equal(r.made.length, 1);
});

test('failure: a factory that throws is a failed connection, reported once, with no retry', async () => {
  let calls = 0;
  const r = rig({ factory: () => { calls++; throw new Error('boom'); } });
  await pause(5);
  assert.deepEqual([calls, r.got.closes], [1, 1]);
  assert.deepEqual(r.diags, ['VOICE_CONNECT_FAILED', 'VOICE_CLOSED']);
});

test('failure: the remote end closing after the call has started is reported once and cleans up', async () => {
  const r = rig();
  r.ws().open();
  assert.equal(r.got.opens, 1);
  assert.equal(r.voice.send('{"type":"x"}'), true);
  r.ws().remoteClose();
  assert.equal(r.got.closes, 1);
  assert.equal(r.voice.send('{}'), false);
  r.voice.close(1000);
  assert.equal(r.got.closes, 1, 'not reported twice');
  assert.equal(r.ws().onmessage, null);
});

// ================================================================ sending and receiving
test('send: only text, only while open, never past the backlog limit, and a throwing socket is a refusal', () => {
  const r = rig({ maxBufferedBytes: 1000 });
  assert.equal(r.voice.send('{}'), false, 'not open yet');
  r.ws().open();
  assert.equal(r.voice.send('{"a":1}'), true);
  assert.deepEqual(r.ws().sent, ['{"a":1}']);
  assert.equal(r.voice.send(5 as never), false);
  assert.equal(r.voice.send(Buffer.from('x') as never), false);
  r.ws().bufferedAmount = 1001;
  assert.equal(r.voice.send('{}'), false);
  assert.ok(r.diags.includes('VOICE_SEND_REFUSED'));
  r.ws().bufferedAmount = 0; r.ws().throwOnSend = true;
  assert.equal(r.voice.send('{}'), false);
  r.ws().throwOnSend = false; r.ws().readyState = 2;
  assert.equal(r.voice.send('{}'), false, 'closing');
});

test('receive: text is passed on; binary frames and oversize frames are dropped and counted', () => {
  const r = rig({ maxMessageChars: 50 });
  r.ws().open();
  r.ws().message('{"type":"session.created"}');
  r.ws().message(Buffer.from('audio bytes'));
  r.ws().message(new ArrayBuffer(8));
  r.ws().message(undefined);
  r.ws().message('x'.repeat(51));
  assert.deepEqual(r.got.messages, ['{"type":"session.created"}']);
  assert.deepEqual(r.diags.filter((d) => d === 'VOICE_BINARY_DROPPED').length, 3);
  assert.equal(r.diags.filter((d) => d === 'VOICE_OVERSIZE_DROPPED').length, 1);
});

// ================================================================ cancellation and cleanup
test('cancel: when the bridge closes it, the connection is closed with a legal code, nothing is reported back, and every handler is detached', () => {
  const r = rig();
  r.ws().open();
  r.voice.close(1000);
  assert.deepEqual(r.ws().closeCalls, [1000]);
  assert.equal(r.got.closes, 0, 'the bridge asked; it is not told');
  assert.deepEqual([r.ws().onopen, r.ws().onmessage, r.ws().onclose, r.ws().onerror], [null, null, null, null]);
  r.voice.close(1000); r.voice.close(1000);
  assert.equal(r.ws().closeCalls.length, 1, 'closed once');
  assert.equal(r.voice.send('{}'), false);
  assert.doesNotThrow(() => { r.ws().message('late'); r.ws().remoteClose(); });
  assert.deepEqual([r.got.messages, r.got.closes], [[], 0], 'a late event does nothing');
});

test('cancel: a close code a WebSocket does not allow is replaced by 1000, and a code in the allowed application range is kept', () => {
  for (const [asked, used] of [[1005, 1000], [1006, 1000], [1011, 1000], [undefined, 1000], [2999, 1000], [3000, 3000], [4999, 4999], [5000, 1000]] as const) {
    const r = rig(); r.ws().open(); r.voice.close(asked as number | undefined);
    assert.deepEqual(r.ws().closeCalls, [used], String(asked));
  }
});

test('cancel: closing before the connection has opened stops the timer and the call, with no report and no later close', async () => {
  const r = rig({ connectTimeoutMs: 30 });
  r.voice.close(1000);
  await pause(80);
  assert.deepEqual([r.got.closes, r.ws().closeCalls.length], [0, 1]);
  assert.ok(!r.diags.includes('VOICE_CONNECT_TIMEOUT'));
});

// ================================================================ under the voice bridge
function underBridge(key: () => string | undefined = () => FAKE_KEY) {
  const made: FakeWs[] = [];
  const voice = createOpenAiVoiceSocket({ model: MODEL, getKey: key, connectTimeoutMs: 5000, factory: (url, init) => { const w = new FakeWs(url, init.headers); made.push(w); return w; } });
  const phone = createWirePhone();
  const bridge = createRealtimeBridge(phone, voice);
  const t = createRealtimeTransport(bridge.link, { notice: 'Hello. This is an automated A I assistant. Please say yes to continue, or hang up now.', transcriptionModel: 'sim-transcriber', voice: 'sim-voice', msPerChar: 1 });
  const events: TransportEvent[] = []; const closes: unknown[] = [];
  t.onEvent = (e) => { events.push(e); }; t.onClose = (i) => { closes.push(i); };
  return { made, phone, events, closes, voice };
}

test('bridge: the call starts only when the connection is open, and sends the settings and the notice request over it', async () => {
  const b = underBridge();
  b.phone.start();
  await pause(20);
  assert.deepEqual(b.made[0].sent, [], 'the phone has started but the connection is not open');
  b.made[0].open();
  await until(() => b.made[0].sent.length >= 3);
  assert.deepEqual(b.made[0].sent.map((s) => JSON.parse(s).type), ['session.update', 'session.update', 'response.create']);
  assert.equal(JSON.parse(b.made[0].sent[0]).session.type, 'realtime');
  assert.ok(!b.made[0].sent.join('').includes(FAKE_KEY), 'the key is never in anything sent over the connection');
});

test('bridge: a refused connection ends the call before the call logic ever sees it, and the phone stream is closed', async () => {
  const b = underBridge();
  b.phone.start();
  b.made[0].refuse();
  await until(() => b.closes.length === 1);
  assert.deepEqual(b.phone.closedWith, [1000]);
  assert.ok(!b.events.some((e) => e.kind === 'setup'));
  assert.equal(b.made.length, 1);
});

test('bridge: no key means the call ends and the phone is closed without a connection ever being made', async () => {
  const b = underBridge(() => undefined);
  b.phone.start();
  await until(() => b.closes.length === 1);
  assert.deepEqual([b.made.length, b.phone.closedWith], [0, [1000]]);
});

test('bridge: the caller hanging up closes the connection; the connection dropping mid-call closes the phone; neither is closed twice', async () => {
  const a = underBridge(); a.phone.start(); a.made[0].open(); await until(() => a.made[0].sent.length >= 3);
  a.phone.stop();
  assert.deepEqual(a.made[0].closeCalls, [1000]);
  assert.equal(a.closes.length, 1);
  const b = underBridge(); b.phone.start(); b.made[0].open(); await until(() => b.made[0].sent.length >= 3);
  b.made[0].remoteClose();
  assert.equal(b.closes.length, 1);
  assert.deepEqual(b.phone.closedWith, [1000]);
  assert.ok(b.made[0].closeCalls.length <= 1, 'closed at most once');
});

// ================================================================ what Node itself gives us
const servers: net.Server[] = [];
after(() => { for (const s of servers) s.close(); });
test('platform: Node\'s built-in WebSocket sends custom request headers (checked on loopback with an invented token), so the connection needs no package', async () => {
  const seen = await new Promise<string[]>((resolve) => {
    const srv = net.createServer((s) => { s.once('data', (d) => { resolve(d.toString('latin1').split('\r\n').filter((l) => /^(authorization|openai-safety-identifier):/i.test(l))); s.destroy(); }); });
    servers.push(srv);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      const Ctor = (globalThis as unknown as { WebSocket: new (u: string, o: unknown) => { onerror: unknown; onclose: unknown } }).WebSocket;
      const ws = new Ctor(`ws://127.0.0.1:${port}/v1/realtime?model=x`, { headers: { Authorization: 'Bearer invented-token-0123456789', 'OpenAI-Safety-Identifier': 'test-id' } });
      ws.onerror = () => {}; ws.onclose = () => {};
    });
  });
  assert.deepEqual(seen.sort(), ['Authorization: Bearer invented-token-0123456789', 'OpenAI-Safety-Identifier: test-id']);
});

// ================================================================ static guards
test('static: the file reads no environment, logs nothing, imports only a type, holds the key in no variable that outlives the connect, and nothing in src uses it yet', () => {
  const code = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const own = code('openai-voice-socket.ts');
  for (const bad of [/process\./, /console\./, /\bfetch\s*\(/, /require\s*\(/, /\beval\s*\(/, /node:/, /@anthropic-ai|from 'openai'/, /OpenAI-Beta/, /localStorage|writeFile|appendFile/]) assert.ok(!bad.test(own), String(bad));
  assert.deepEqual([...own.matchAll(/^import[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]), ['./realtime-bridge.ts']);
  assert.ok(/^import type \{ VoiceSocket \}/m.test(own), 'a type import only');
  assert.deepEqual([...own.matchAll(/wss?:\/\/[^'"`\s)]+/g)].map((m) => m[0]), ['wss://api.openai.com/v1/realtime'], 'one address, and it is OpenAI\'s');
  assert.ok(!/diag\((?!'VOICE_[A-Z_]+'\))/.test(own), 'every diagnostic is a fixed code literal, never a variable');
  for (const f of readdirSync(new URL('../src/', import.meta.url)).filter((n) => n.endsWith('.ts') && n !== 'openai-voice-socket.ts')) assert.ok(!/openai-voice-socket/.test(code(f)), `${f} must not use the voice socket yet`);
});
