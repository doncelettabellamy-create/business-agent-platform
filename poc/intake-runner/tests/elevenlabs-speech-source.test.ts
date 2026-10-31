// The INACTIVE ElevenLabs streaming client (src/elevenlabs-speech-source.ts) against a MOCK server on the loopback address (node:http, an ephemeral port) and against fetch stand-ins. No call leaves this
// machine, no real key is used (a canary string stands in for one), and nothing here is wired into a service. A passing test shows behaviour against THIS model of the provider only: the real service's
// content type, chunk framing, error statuses, cancellation and latency are unverified.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { createElevenLabsSpeechSource, ELEVENLABS_ORIGIN, speechRequestProblems, VOICE_SETTINGS_DEFAULTS } from '../src/elevenlabs-speech-source.ts';
import type { ElevenLabsConfig } from '../src/elevenlabs-speech-source.ts';
import { JACK_SPEAKER, withSpeaker } from '../src/speaker-adapter.ts';
import type { SpeechRequest, SpeechSink, SpeakerSocket } from '../src/speaker-adapter.ts';
import { createRealtimeBridge } from '../src/realtime-bridge.ts';
import { createRealtimeTransport, SAY_PREFIX, SPEAK_ONLY } from '../src/realtime-transport.ts';
import type { TransportEvent } from '../src/call-transport.ts';
import { createWirePhone, createWireVoice } from './helpers/realtime-wire-sim.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 4000): Promise<void> { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await sleep(4); } }
const KEY = 'KEY-CANARY-do-not-log-0123456789';
const DETAIL = 'CANARY-PROVIDER-DETAIL-voice-limit';
const REQUEST: SpeechRequest = Object.freeze({ text: 'Let me check what I have. Please say yes or no. Is that correct?', voiceId: '7EzWGsX10sAS4c9m9cPf', modelId: 'eleven_flash_v2_5', speed: 0.95, outputFormat: 'ulaw_8000' });
const pattern = (n: number, from = 0): Uint8Array => Uint8Array.from({ length: n }, (_v, i) => (from + i) & 0xff);

// ---------------------------------------------------------------- the mock server
interface Seen { method: string | undefined; url: string | undefined; headers: http.IncomingHttpHeaders; body: string }
const closers: Array<() => unknown> = [];
after(async () => { for (const c of closers.reverse()) try { await c(); } catch { /* already closed */ } });
async function mockServer(handler: (req: http.IncomingMessage, res: http.ServerResponse, n: number) => void) {
  const seen: Seen[] = []; let aborted = 0;
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body }); res.on('close', () => { if (!res.writableFinished) aborted++; }); handler(req, res, seen.length); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const close = async (): Promise<void> => { server.closeAllConnections?.(); await new Promise<void>((r) => server.close(() => r())); };
  closers.push(close);
  return { origin: `http://127.0.0.1:${port}`, seen, aborted: () => aborted, close };
}
function config(origin: string, over: Partial<ElevenLabsConfig> = {}): ElevenLabsConfig {
  return { getKey: () => KEY, fetch: globalThis.fetch, origin, testOnlyAllowLocalHttp: true, ...over };
}
function collector() {
  const chunks: Uint8Array[] = []; const order: string[] = [];
  const sink: SpeechSink = { chunk(u) { chunks.push(u); order.push('chunk'); }, end() { order.push('end'); }, fail() { order.push('fail'); } };
  const bytes = (): number => chunks.reduce((n, c) => n + c.length, 0);
  const joined = (): Uint8Array => { const out = new Uint8Array(bytes()); let at = 0; for (const c of chunks) { out.set(c, at); at += c.length; } return out; };
  return { sink, chunks, order, bytes, joined, count: (w: string) => order.filter((x) => x === w).length };
}
const diagInto = () => { const lines: Array<{ code: string; [k: string]: unknown }> = []; return { lines, diag: (code: string, detail?: Record<string, unknown>) => { lines.push({ code, ...detail }); } }; };
const audio = (res: http.ServerResponse, status = 200, type = 'audio/basic'): void => { res.writeHead(status, { 'content-type': type }); };

// ---------------------------------------------------------------- request shape and audio format
test('the request: POST to the voice\'s streaming path with only output_format=ulaw_8000, the key only in the xi-api-key header, and the candidate settings in the body', async () => {
  const m = await mockServer((_q, res) => { audio(res); res.end(Buffer.from(pattern(10))); });
  const c = collector(); const src = createElevenLabsSpeechSource(config(m.origin));
  src.start(REQUEST, c.sink);
  await until(() => c.count('end') === 1);
  const s = m.seen[0];
  assert.deepEqual([s.method, s.url], ['POST', '/v1/text-to-speech/7EzWGsX10sAS4c9m9cPf/stream?output_format=ulaw_8000']);
  assert.equal(s.headers['xi-api-key'], KEY);
  assert.match(String(s.headers['content-type']), /^application\/json/);
  assert.deepEqual(JSON.parse(s.body), { text: REQUEST.text, model_id: 'eleven_flash_v2_5', voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 0.95 } });
  assert.deepEqual({ ...VOICE_SETTINGS_DEFAULTS }, { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true });
  assert.ok(!String(s.url).includes(KEY) && !s.body.includes(KEY), 'the key is in the header only');
});

test('the audio: every byte the server streams reaches the sink in order, in as many pieces as arrive, then exactly one end', async () => {
  const sent = [pattern(1000), pattern(700, 1000), pattern(333, 1700)];
  const m = await mockServer(async (_q, res) => { audio(res); for (const p of sent) { res.write(Buffer.from(p)); await sleep(15); } res.end(); });
  const c = collector(); createElevenLabsSpeechSource(config(m.origin)).start(REQUEST, c.sink);
  await until(() => c.count('end') === 1);
  assert.deepEqual(c.joined(), pattern(2033));
  assert.deepEqual([c.count('fail'), c.order.at(-1)], [0, 'end']);
  await sleep(50); assert.equal(c.count('end'), 1, 'one end only');
});

test('through the speaker adapter and the real bridge: the provider\'s bytes become the line\'s audio, the playback is measured, and the line counts as played', async () => {
  const total = pattern(8000);   // one second of mu-law
  const m = await mockServer(async (_q, res) => { audio(res); for (let at = 0; at < total.length; at += 2000) { res.write(Buffer.from(total.subarray(at, at + 2000))); await sleep(5); } res.end(); });
  const phone = createWirePhone(); const voice = createWireVoice({ msPerChar: 1 });
  const { lines, diag } = diagInto();
  const sp = withSpeaker(voice, createElevenLabsSpeechSource(config(m.origin, { diag })), JACK_SPEAKER, { diag });
  const bridge = createRealtimeBridge(phone, sp, { playGraceMs: 600 });
  const toAdapter: any[] = []; const NOTICE = 'Hello. Please say yes to continue.';
  const t = createRealtimeTransport(bridge.link, { notice: NOTICE, transcriptionModel: 'sim', voice: 'sim', msPerChar: 1, endWaitMs: 500 });
  const adapterIn = bridge.link.onMessage; bridge.link.onMessage = (x: unknown) => { toAdapter.push(x); adapterIn(x); };
  const events: TransportEvent[] = []; t.onEvent = (e) => { events.push(e); }; t.onClose = () => {};
  phone.start();
  await until(() => events.some((e) => e.kind === 'setup'), 8000);
  const done = toAdapter.find((x) => x.type === 'response.done');
  assert.deepEqual([done.response.status, done.x_sent_ms, done.x_acked_ms], ['completed', 1000, 1000], 'one second sent, one second acknowledged');
  assert.equal(m.seen[0].body.includes(NOTICE), true, 'the provider was asked for exactly the words');
  assert.equal(phone.sent.filter((x) => x.event === 'media').reduce((n, x) => n + Buffer.from(x.media.payload, 'base64').length, 0), 8000);
  assert.equal(voice.received.filter((x: any) => x.type === 'response.create').length, 0, 'OpenAI was never asked to speak');
  assert.ok(lines.some((l) => l.code === 'ELEVENLABS_DONE' && l.bytes === 8000));
});

// ---------------------------------------------------------------- cancellation and late audio
test('cancel: the request is aborted (the server sees the connection drop), nothing reaches the sink afterwards, and a second cancel does nothing', async () => {
  const m = await mockServer((_q, res) => { audio(res); const t = setInterval(() => { if (!res.write(Buffer.from(pattern(400)))) { /* back-pressure */ } }, 15); res.on('close', () => clearInterval(t)); });
  const c = collector(); const h = createElevenLabsSpeechSource(config(m.origin)).start(REQUEST, c.sink);
  await until(() => c.count('chunk') >= 2);
  h.cancel(); const atCancel = c.order.length;
  await until(() => m.aborted() === 1);
  await sleep(150);
  assert.equal(c.order.length, atCancel, 'no piece, end or fail after the cancel');
  h.cancel();
  assert.equal(c.order.length, atCancel);
});

test('late audio: a stream that ignores the abort and keeps delivering is dropped after a cancel, after a failure and after the byte limit', async () => {
  // A fetch stand-in whose body keeps enqueuing whatever the client does.
  const make = (): { fetch: typeof globalThis.fetch; push: (n: number) => void; closeStream: () => void } => {
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
    return { fetch: (async () => new Response(stream, { status: 200, headers: { 'content-type': 'audio/basic' } })) as typeof globalThis.fetch, push: (n) => { try { ctl.enqueue(pattern(n)); } catch { /* the reader has cancelled */ } }, closeStream: () => { try { ctl.close(); } catch { /* already closed */ } } };
  };
  // (1) cancel
  const a = make(); const ca = collector(); const ha = createElevenLabsSpeechSource({ getKey: () => KEY, fetch: a.fetch }).start(REQUEST, ca.sink);
  a.push(100); await until(() => ca.count('chunk') === 1);
  ha.cancel(); a.push(100); a.push(100); a.closeStream(); await sleep(60);
  assert.deepEqual(ca.order, ['chunk'], 'nothing after the cancel, not even the end');
  // (2) failure: an over-long stream fails once, later audio is dropped
  const b = make(); const cb = collector(); createElevenLabsSpeechSource({ getKey: () => KEY, fetch: b.fetch, maxBytes: 250 }).start(REQUEST, cb.sink);
  b.push(100); b.push(100); b.push(100); await until(() => cb.count('fail') === 1);
  b.push(100); b.closeStream(); await sleep(60);
  assert.deepEqual(cb.order, ['chunk', 'chunk', 'fail'], 'the third piece broke the limit: it was not delivered, and nothing came after the failure');
});

// ---------------------------------------------------------------- timeouts
test('timeouts: no response headers within the bound fails the line once and drops the request; a stall after the headers is the adapter\'s bound, which also drops the request', async () => {
  const slow = await mockServer((_q, res) => { setTimeout(() => { try { audio(res); res.end(Buffer.from(pattern(10))); } catch { /* closed */ } }, 1500); });
  const { lines, diag } = diagInto();
  const c = collector(); createElevenLabsSpeechSource(config(slow.origin, { headersTimeoutMs: 80, diag })).start(REQUEST, c.sink);
  await until(() => c.count('fail') === 1);
  await until(() => slow.aborted() === 1);
  assert.deepEqual(c.order, ['fail']);
  assert.ok(lines.some((l) => l.code === 'ELEVENLABS_FAILED' && l.why === 'TIMEOUT_HEADERS'));
  // Through the adapter: headers arrive, then silence (never any audio) -> NO_AUDIO; some audio, then silence -> STALLED. Both cancel the provider request.
  for (const [piece, why] of [[0, 'NO_AUDIO'], [300, 'STALLED']] as Array<[number, string]>) {
    const m = await mockServer((_q, res) => { audio(res); if (piece > 0) res.write(Buffer.from(pattern(piece))); });
    const inner: SpeakerSocket & { sent: any[] } = { sent: [], send(x: string) { inner.sent.push(JSON.parse(x)); return true; }, close() {}, onOpen() {}, onMessage() {}, onClose() {} };
    const d = diagInto();
    const sp = withSpeaker(inner, createElevenLabsSpeechSource(config(m.origin, { diag: d.diag })), JACK_SPEAKER, { diag: d.diag, firstAudioMs: 150, gapMs: 150 });
    const events: any[] = []; sp.onMessage = (x: string) => { events.push(JSON.parse(x)); };
    sp.send(JSON.stringify({ type: 'response.create', response: { instructions: `${SPEAK_ONLY} ${SAY_PREFIX}Hello there.`, metadata: { id: 'r1' } } }));
    await until(() => events.some((e) => e.type === 'response.done'));
    assert.equal(events.find((e) => e.type === 'response.done').response.status, 'failed', why);
    assert.ok(d.lines.some((l) => l.code === 'SPEAKER_FAILED' && l.why === why), why);
    assert.equal(events.filter((e) => e.type === 'response.output_audio_transcript.done').length, 0, `${why}: no transcript for a failed line`);
    await until(() => m.aborted() === 1);
  }
});

// ---------------------------------------------------------------- provider errors
test('provider errors: every error status fails the line once with no audio, records only the status, and never puts the provider\'s message or the key anywhere', async () => {
  for (const status of [400, 401, 403, 404, 422, 429, 500, 502, 503]) {
    const m = await mockServer((_q, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(`${DETAIL} ${KEY} ` + JSON.stringify({ detail: [{ loc: ['body', 'text'], msg: DETAIL, type: 'x' }], key: KEY })); });   // the body starts with the canaries, so any reading of it into a diagnostic shows
    const { lines, diag } = diagInto(); const c = collector();
    createElevenLabsSpeechSource(config(m.origin, { diag })).start(REQUEST, c.sink);
    await until(() => c.count('fail') === 1);
    await sleep(40);
    assert.deepEqual(c.order, ['fail'], String(status));
    assert.ok(lines.some((l) => l.code === 'ELEVENLABS_FAILED' && l.why === 'HTTP_ERROR' && l.status === status), String(status));
    assert.ok(!JSON.stringify(lines).match(/CANARY|KEY-/), 'no provider message or key in a diagnostic');
  }
});

test('other provider failures: a non-audio success, a reset before the headers, a drop mid-stream, an empty body, a refused connection and an over-long stream', async () => {
  // 200 with a JSON (error) body, and with HTML
  for (const type of ['application/json', 'text/html']) {
    const m = await mockServer((_q, res) => { res.writeHead(200, { 'content-type': type }); res.end(JSON.stringify({ message: DETAIL })); });
    const c = collector(); const { lines, diag } = diagInto(); createElevenLabsSpeechSource(config(m.origin, { diag })).start(REQUEST, c.sink);
    await until(() => c.count('fail') === 1); assert.deepEqual(c.order, ['fail'], type);
    assert.ok(lines.some((l) => l.why === 'BAD_TYPE'), type); assert.ok(!JSON.stringify(lines).includes('CANARY'));
  }
  // reset before any headers
  const reset = await mockServer((_q, res) => { res.socket?.destroy(); });
  const c1 = collector(); createElevenLabsSpeechSource(config(reset.origin)).start(REQUEST, c1.sink);
  await until(() => c1.count('fail') === 1); assert.deepEqual(c1.order, ['fail']);
  // dropped part-way: the pieces that arrived were delivered, then one fail, no end
  const cut = await mockServer(async (_q, res) => { audio(res); res.write(Buffer.from(pattern(500))); await sleep(30); res.socket?.destroy(); });
  const c2 = collector(); createElevenLabsSpeechSource(config(cut.origin)).start(REQUEST, c2.sink);
  await until(() => c2.count('fail') === 1); assert.deepEqual([c2.bytes(), c2.count('end'), c2.order.at(-1)], [500, 0, 'fail']);
  // empty 200: the client ends the stream; the ADAPTER turns "no audio at all" into a failed line
  const empty = await mockServer((_q, res) => { audio(res); res.end(); });
  const inner: SpeakerSocket = { send: () => true, close() {}, onOpen() {}, onMessage() {}, onClose() {} };
  const d = diagInto(); const sp = withSpeaker(inner, createElevenLabsSpeechSource(config(empty.origin)), JACK_SPEAKER, { diag: d.diag });
  const ev: any[] = []; sp.onMessage = (x: string) => { ev.push(JSON.parse(x)); };
  sp.send(JSON.stringify({ type: 'response.create', response: { instructions: `${SPEAK_ONLY} ${SAY_PREFIX}Hello there.`, metadata: { id: 'r1' } } }));
  await until(() => ev.some((e) => e.type === 'response.done'));
  assert.equal(ev.find((e) => e.type === 'response.done').response.status, 'failed');
  assert.ok(d.lines.some((l) => l.code === 'SPEAKER_FAILED' && l.why === 'EMPTY'));
  // refused connection
  const gone = await mockServer(() => {}); const origin = gone.origin; await gone.close();
  const c3 = collector(); createElevenLabsSpeechSource(config(origin)).start(REQUEST, c3.sink);
  await until(() => c3.count('fail') === 1); assert.deepEqual(c3.order, ['fail']);
  // a stream longer than the limit
  const big = await mockServer((_q, res) => { audio(res); res.write(Buffer.from(pattern(900))); setTimeout(() => res.end(Buffer.from(pattern(900))), 20); });
  const c4 = collector(); createElevenLabsSpeechSource(config(big.origin, { maxBytes: 1000 })).start(REQUEST, c4.sink);
  await until(() => c4.count('fail') === 1); await sleep(60); assert.deepEqual(c4.order, ['chunk', 'fail']);
});

// ---------------------------------------------------------------- the key, the settings and inactivity
test('the key: asked for when a line starts and not before; no key means the line cannot start, with a fixed message and no request; the key is in no error', async () => {
  let asked = 0; let hits = 0;
  const m = await mockServer((_q, res) => { hits++; audio(res); res.end(Buffer.from(pattern(10))); });
  const src = createElevenLabsSpeechSource(config(m.origin, { getKey: () => { asked++; return undefined; } }));
  assert.equal(asked, 0, 'not asked at setup');
  for (const bad of [undefined, '']) {
    const s2 = createElevenLabsSpeechSource(config(m.origin, { getKey: () => { asked++; return bad; } }));
    assert.throws(() => s2.start(REQUEST, collector().sink), (e: Error) => e.message === 'no key' && !e.message.includes(KEY));
  }
  assert.throws(() => src.start(REQUEST, collector().sink), /no key/);
  assert.equal(hits, 0, 'no request was made');
  // Through the adapter a missing key is a line that failed to start.
  const inner: SpeakerSocket = { send: () => true, close() {}, onOpen() {}, onMessage() {}, onClose() {} };
  const d = diagInto(); const sp = withSpeaker(inner, src, JACK_SPEAKER, { diag: d.diag });
  const ev: any[] = []; sp.onMessage = (x: string) => { ev.push(JSON.parse(x)); };
  sp.send(JSON.stringify({ type: 'response.create', response: { instructions: `${SPEAK_ONLY} ${SAY_PREFIX}Hello there.`, metadata: { id: 'r1' } } }));
  await until(() => ev.some((e) => e.type === 'response.done'));
  assert.ok(d.lines.some((l) => l.code === 'SPEAKER_FAILED' && l.why === 'START_FAILED'));
  assert.ok(!JSON.stringify(d.lines).includes('KEY-'));
});

test('settings: only the approved candidate is accepted - a different voice shape, model, speed or format is refused before any request; the origin is the provider\'s unless a test turns on loopback', async () => {
  let fetched = 0; const counting = (async () => { fetched++; return new Response(null, { status: 500 }); }) as typeof globalThis.fetch;
  const src = createElevenLabsSpeechSource({ getKey: () => KEY, fetch: counting });
  for (const bad of [{ voiceId: 'short' }, { modelId: 'eleven_v3' }, { speed: 0.5 }, { speed: 1.5 }, { outputFormat: 'mp3_44100_128' }, { text: '' }]) {
    const r = { ...REQUEST, ...bad } as SpeechRequest;
    assert.notDeepEqual(speechRequestProblems(r), [], JSON.stringify(bad));
    assert.throws(() => src.start(r, collector().sink), RangeError);
  }
  assert.deepEqual(speechRequestProblems(REQUEST), []);
  assert.equal(fetched, 0);
  assert.equal(ELEVENLABS_ORIGIN, 'https://api.elevenlabs.io');
  for (const origin of ['http://api.elevenlabs.io', 'https://evil.example', 'https://api.elevenlabs.io/extra', 'http://127.0.0.1:9', 'http://10.0.0.1:80']) {
    assert.throws(() => createElevenLabsSpeechSource({ getKey: () => KEY, fetch: counting, origin }), RangeError, origin);
  }
  assert.throws(() => createElevenLabsSpeechSource({ getKey: () => KEY, fetch: counting, origin: 'http://10.0.0.1:80', testOnlyAllowLocalHttp: true }), RangeError, 'loopback only');
  assert.throws(() => createElevenLabsSpeechSource({ getKey: 1, fetch: counting } as never), RangeError);
  assert.throws(() => createElevenLabsSpeechSource({ getKey: () => KEY, fetch: counting, headersTimeoutMs: 0 }), RangeError);
});

test('contained: only the switch module imports the client, it reads no environment, opens no connection of its own and holds no key; the call logic, the bridge, the transport and the voice service name neither it nor the adapter', () => {
  const code = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const own = code('elevenlabs-speech-source.ts');
  for (const bad of [/process\./, /node:/, /\bimport\s*\(/, /new\s+WebSocket/, /\bfetch\s*\(/, /require\s*\(/, /console\./, /\bsk-[A-Za-z0-9]/, /ELEVEN_?LABS_API_KEY/i, /https?:\/\/(?!api\.elevenlabs\.io)/]) assert.ok(!bad.test(own), String(bad));
  assert.equal((own.match(/xi-api-key/g) ?? []).length, 1, 'the key header is named once');
  assert.equal(readFileSync(new URL('../src/elevenlabs-speech-source.ts', import.meta.url), 'utf8').split("'xi-api-key': key").length - 1, 1);
  for (const f of readdirSync(new URL('../src/', import.meta.url)).filter((n) => n.endsWith('.ts') && n !== 'elevenlabs-speech-source.ts')) {
    assert.equal(/elevenlabs-speech-source/.test(code(f)), f === 'founder-voice-speaker.ts', `${f}: only the switch module (founder-voice-speaker.ts) may import the client`);
    assert.equal(/speaker-adapter/.test(code(f)), ['founder-voice-speaker.ts', 'founder-voice-gate.ts', 'elevenlabs-speech-source.ts'].includes(f), `${f}: only the switch, the gate (settings checks) and the client may use the adapter`);
  }
  for (const f of ['founder-voice-service.ts', 'relay-handler.ts', 'realtime-bridge.ts', 'realtime-transport.ts', 'call-session.ts', 'call-state.ts']) assert.ok(!/speaker-adapter|elevenlabs|founder-voice-speaker/i.test(code(f)), `${f}: the current speaker path does not name the adapter or the client`);
});
