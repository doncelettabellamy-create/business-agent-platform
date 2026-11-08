// The INACTIVE ElevenLabs streaming client (src/elevenlabs-speech-source.ts) against a MOCK server on the loopback address (node:http, an ephemeral port) and against fetch stand-ins. No call leaves this
// machine, no real key is used (a canary string stands in for one), and nothing here is wired into a service. A passing test shows behaviour against THIS model of the provider only: the real service's
// content type, chunk framing, error statuses, cancellation and latency are unverified.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { createElevenLabsSpeechSource, ELEVENLABS_ORIGIN, ERROR_BODY_MAX_BYTES, ERROR_BODY_MS, ERROR_REASONS, ERROR_SHAPES, PROVIDER_CODES, errorReasonOf, errorShapeOf, providerCodesOf, speechRequestProblems, VOICE_SETTINGS_DEFAULTS } from '../src/elevenlabs-speech-source.ts';
import { fileDiagSink } from '../src/call-diag.ts';
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
  // Through the adapter: headers arrive, then silence with NO audio -> NO_AUDIO -> OpenAI is asked to speak the line (the fallback; this stand-in never answers, so the call ends); some audio, then silence -> STALLED -> no
  // fallback, the call ends. Both cancel the provider request.
  for (const [piece, why] of [[0, 'NO_AUDIO'], [300, 'STALLED']] as Array<[number, string]>) {
    const m = await mockServer((_q, res) => { audio(res); if (piece > 0) res.write(Buffer.from(pattern(piece))); });
    const inner: SpeakerSocket & { sent: any[] } = { sent: [], send(x: string) { inner.sent.push(JSON.parse(x)); return true; }, close() {}, onOpen() {}, onMessage() {}, onClose() {} };
    const d = diagInto();
    const sp = withSpeaker(inner, createElevenLabsSpeechSource(config(m.origin, { diag: d.diag })), JACK_SPEAKER, { diag: d.diag, firstAudioMs: 150, gapMs: 150, fallbackFirstAudioMs: 120, endDelayMs: 40 });
    const events: any[] = []; sp.onMessage = (x: string) => { events.push(JSON.parse(x)); };
    sp.send(JSON.stringify({ type: 'response.create', response: { instructions: `${SPEAK_ONLY} ${SAY_PREFIX}Hello there.`, metadata: { id: 'r1' } } }));
    await until(() => events.some((e) => e.type === 'response.done'));
    assert.equal(events.find((e) => e.type === 'response.done').response.status, 'failed', why);
    if (piece === 0) {
      assert.ok(d.lines.some((l) => l.code === 'SPEAKER_FALLBACK' && l.why === 'NO_AUDIO'), 'zero audio handed on: OpenAI is asked to speak the line');
      assert.equal(inner.sent.filter((x) => x.type === 'response.create').length, 1);
      assert.ok(d.lines.some((l) => l.code === 'SPEAKER_FAILED' && l.why === 'FALLBACK_NO_AUDIO'), 'and this stand-in never answers, so the call ends');
    } else {
      assert.ok(d.lines.some((l) => l.code === 'SPEAKER_FAILED' && l.why === why), why);
      assert.equal(inner.sent.filter((x) => x.type === 'response.create').length, 0, 'audio had been handed on: no fallback');
    }
    await until(() => events.some((e) => e.type === 'x_speaker_down'));
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

// ---------------------------------------------------------------- fixed-code classification of a provider error (the body is read in a bounded way; only a code from a fixed list is ever logged)
const FIXED_REASONS = ['VOICE_NOT_FOUND', 'QUOTA_EXCEEDED', 'INVALID_API_KEY', 'RATE_LIMIT', 'CONCURRENT_LIMIT', 'CHAR_LIMIT', 'OTHER', 'UNPARSED'];
async function failWith(status: number, body: string | ((res: http.ServerResponse) => void), extra: Partial<ElevenLabsConfig> = {}) {
  const m = await mockServer((_q, res) => { res.writeHead(status, { 'content-type': 'application/json' }); if (typeof body === 'string') res.end(body); else body(res); });
  const { lines, diag } = diagInto(); const c = collector(); const began = Date.now();
  createElevenLabsSpeechSource(config(m.origin, { diag, ...extra })).start(REQUEST, c.sink);
  await until(() => c.count('fail') === 1); const ms = Date.now() - began; await sleep(30);
  return { lines, c, ms, failed: lines.find((l) => l.code === 'ELEVENLABS_FAILED') as { [k: string]: unknown }, m };
}

test('classification: each listed provider status is logged as its fixed code, with the status, and nothing from the body (not the message, not the key, not the text)', async () => {
  const expected: Array<[string, string]> = [['voice_not_found', 'VOICE_NOT_FOUND'], ['quota_exceeded', 'QUOTA_EXCEEDED'], ['invalid_api_key', 'INVALID_API_KEY'], ['rate_limit_exceeded', 'RATE_LIMIT'], ['concurrent_limit_exceeded', 'CONCURRENT_LIMIT'], ['max_character_limit_exceeded', 'CHAR_LIMIT']];
  for (const status of [400, 401, 404]) for (const [word, code] of expected) {
    const r = await failWith(status, JSON.stringify({ detail: { status: word, message: `${DETAIL} ${KEY} ${REQUEST.text} ${REQUEST.voiceId}` } }));
    assert.deepEqual(r.c.order, ['fail'], `${status} ${word}`);
    assert.deepEqual([r.failed.why, r.failed.status, r.failed.reason], ['HTTP_ERROR', status, code], `${status} ${word}`);
    assert.deepEqual(Object.keys(r.failed).sort(), ['code', 'ms', 'reason', 'shape', 'status', 'why'], 'the failure carries exactly these fields');
    const all = JSON.stringify(r.lines);
    assert.ok(!all.match(/CANARY|KEY-/) && !all.includes(REQUEST.text) && !all.includes(REQUEST.voiceId) && !all.includes(word), 'no body text, key, line text, voice id or provider word in any diagnostic');
  }
});

test('classification: the list of provider words is exactly these six, each mapped to its fixed code', () => {
  assert.deepEqual({ ...ERROR_REASONS }, { voice_not_found: 'VOICE_NOT_FOUND', quota_exceeded: 'QUOTA_EXCEEDED', invalid_api_key: 'INVALID_API_KEY', rate_limit_exceeded: 'RATE_LIMIT', concurrent_limit_exceeded: 'CONCURRENT_LIMIT', max_character_limit_exceeded: 'CHAR_LIMIT' });
  assert.ok(Object.isFrozen(ERROR_REASONS));
});

test('classification: anything not on the list is OTHER, anything that is not JSON is UNPARSED, and the provider\'s words never come through', () => {
  const other = [JSON.stringify({ detail: { status: 'something_new', message: DETAIL } }), JSON.stringify({ detail: [{ loc: ['body', 'text'], msg: DETAIL, type: 'x' }] }), JSON.stringify({ detail: { status: 'VOICE_NOT_FOUND' } }), JSON.stringify({ detail: { status: ' voice_not_found' } }),
    JSON.stringify({ detail: { status: ['voice_not_found'] } }), JSON.stringify({ detail: { status: 42 } }), JSON.stringify({ detail: 'voice_not_found' }), JSON.stringify({ status: 'voice_not_found' }), '{"detail":{"status":"__proto__"}}', '{"detail":{"status":"constructor"}}', '{"detail":{"status":"toString"}}', '{"detail":{"status":"hasOwnProperty"}}', '{}', '[]', 'null', '7', '"quota_exceeded"', 'true'];
  for (const text of other) assert.equal(errorReasonOf(text), 'OTHER', text);
  for (const text of ['', ' ', 'not json', `${DETAIL} ${KEY}`, '{"detail":{"status":"voice_not_found"', '<html>quota_exceeded</html>', undefined, null, 5, {}, ['x']]) assert.equal(errorReasonOf(text), 'UNPARSED', String(text));
  for (const [w, c] of [['voice_not_found', 'VOICE_NOT_FOUND'], ['quota_exceeded', 'QUOTA_EXCEEDED'], ['invalid_api_key', 'INVALID_API_KEY'], ['rate_limit_exceeded', 'RATE_LIMIT'], ['concurrent_limit_exceeded', 'CONCURRENT_LIMIT'], ['max_character_limit_exceeded', 'CHAR_LIMIT']]) assert.equal(errorReasonOf(JSON.stringify({ detail: { status: w } })), c);
  // whatever goes in, only a fixed code comes out
  const hostile = ['{"detail":{"status":"' + 'a'.repeat(5000) + '"}}', '{"detail":{"status":"' + KEY + '"}}', '{"detail":{"status":"voice_not_found","message":"' + DETAIL + '"}}', '\u0000\u0001', '{"detail":{"status":"quota_exceeded"}}'.repeat(3)];
  for (const text of hostile) { const out = errorReasonOf(text); assert.ok(FIXED_REASONS.includes(out), out); assert.ok(!out.includes('CANARY') && !out.includes('KEY-')); }
});

test('classification: the body is read in a bounded way: an oversize body is cut at the cap, a body that never ends does not hold the failure past the time bound, and neither puts text in a log', async () => {
  // a valid JSON start followed by a very large tail: only ERROR_BODY_MAX_BYTES are read, so it cannot parse (UNPARSED); the client does not read it to the end
  const big = await failWith(400, (res) => { res.write('{"detail":{"status":"voice_not_found","message":"' + DETAIL + KEY); const chunk = 'x'.repeat(16384); let n = 0; const push = (): void => { while (n < 64 && res.write(chunk)) n++; if (n < 64) res.once('drain', () => { n++; push(); }); else res.end('"}}'); }; push(); });
  assert.deepEqual([big.failed.why, big.failed.status, big.failed.reason], ['HTTP_ERROR', 400, 'UNPARSED']);
  assert.ok(!JSON.stringify(big.lines).match(/CANARY|KEY-/));
  assert.ok(ERROR_BODY_MAX_BYTES <= 4096, 'the cap is small');
  // an endless body from a stand-in fetch: the client pulls only a few pieces (the cap), not until the time bound
  let pulls = 0; let cancelled = false; const piece = new TextEncoder().encode('x'.repeat(1024));
  const endless = new ReadableStream<Uint8Array>({ pull(ctl) { pulls++; ctl.enqueue(piece); }, cancel() { cancelled = true; } });
  const { lines: l2, diag: d2 } = diagInto(); const c2 = collector();
  createElevenLabsSpeechSource({ getKey: () => KEY, fetch: (async () => new Response(endless, { status: 400, headers: { 'content-type': 'application/json' } })) as typeof fetch, diag: d2 }).start(REQUEST, c2.sink);
  await until(() => c2.count('fail') === 1); await sleep(20);
  assert.ok(pulls <= 8, `the cap stops the reading (${pulls} pulls)`); assert.equal(cancelled, true, 'and the stream is cancelled');
  assert.equal((l2.find((l) => l.code === 'ELEVENLABS_FAILED') as { reason?: string }).reason, 'UNPARSED');
  // a body whose first bytes arrive and then stop: the failure comes after about ERROR_BODY_MS, not never
  const slow = await failWith(400, (res) => { res.write('{"detail":{"status":"voice_not_found"'); });
  assert.deepEqual([slow.failed.why, slow.failed.status, slow.failed.reason], ['HTTP_ERROR', 400, 'UNPARSED']);
  assert.ok(slow.ms >= ERROR_BODY_MS - 40 && slow.ms < ERROR_BODY_MS + 900, `the time bound holds (${slow.ms} ms)`);
  assert.deepEqual(slow.c.order, ['fail']);
  // an empty body: the line still fails once
  const none = await failWith(400, '');
  assert.deepEqual([none.failed.status, none.failed.reason], [400, 'UNPARSED']); assert.deepEqual(none.c.order, ['fail']);
});

test('classification: a cancel while the error body is being read ends quietly: the sink hears no failure and no failure line is logged', async () => {
  const m = await mockServer((_q, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.write('{"detail":'); });   // never finishes
  const { lines, diag } = diagInto(); const c = collector();
  const h = createElevenLabsSpeechSource(config(m.origin, { diag })).start(REQUEST, c.sink);
  await until(() => lines.some((l) => l.code === 'ELEVENLABS_HEADERS'));
  h.cancel();
  await sleep(ERROR_BODY_MS + 150);
  assert.deepEqual(c.order, [], 'a cancelled line reports no failure to the sink');
  assert.ok(!lines.some((l) => l.code === 'ELEVENLABS_FAILED'));
  assert.equal(lines.filter((l) => l.code === 'ELEVENLABS_CANCELLED').length, 1);
});

test('classification: through the real log sanitizer the reason survives as a fixed word and the log line holds nothing from the body', async () => {
  const written: string[] = []; const sink = fileDiagSink({ append: (l) => written.push(l.trimEnd()), nowIso: () => '2026-11-08T00:00:00Z' });
  const m = await mockServer((_q, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ detail: { status: 'voice_not_found', message: `${DETAIL} ${KEY} ${REQUEST.text}` } })); });
  const c = collector();
  createElevenLabsSpeechSource(config(m.origin, { diag: (code, detail) => sink(code, detail as Record<string, string | number | boolean>) })).start(REQUEST, c.sink);
  await until(() => c.count('fail') === 1);
  const line = written.find((l) => l.includes(' ELEVENLABS_FAILED ')) ?? '';
  assert.match(line, /^2026-11-08T00:00:00Z ELEVENLABS_FAILED \{"why":"HTTP_ERROR","status":400,"reason":"VOICE_NOT_FOUND","shape":"STATUS_LISTED","ms":\d+\}$/);
  assert.ok(!written.join('\n').match(/CANARY|KEY-|Let me check/));
});

test('classification: the client source reads a response body only through its two readers and never logs a message', () => {
  const src = readFileSync(new URL('../src/elevenlabs-speech-source.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  assert.ok(!/\.text\(\)|\.json\(\)|\.arrayBuffer\(\)|\.blob\(\)/.test(src), 'no unbounded read of a response');
  assert.equal([...src.matchAll(/getReader\(\)/g)].length, 2, 'one reader for the bounded error body, one for the audio');
  assert.ok(/await readBounded\(res, ERROR_BODY_MS, ERROR_BODY_MAX_BYTES\)/.test(src));
  assert.ok(/diag\('ELEVENLABS_FAILED', \{ why, \.\.\.\(status === undefined \? \{\} : \{ status \}\), \.\.\.\(reason === undefined \? \{\} : \{ reason \}\), \.\.\.\(shape === undefined \? \{\} : \{ shape \}\), ms: Date\.now\(\) - began \}\)/.test(src), 'the failure line carries only why, status, reason, shape and ms');
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
  const d = diagInto(); const sp = withSpeaker(inner, createElevenLabsSpeechSource(config(empty.origin)), JACK_SPEAKER, { diag: d.diag, fallbackFirstAudioMs: 100, endDelayMs: 40 });
  const ev: any[] = []; sp.onMessage = (x: string) => { ev.push(JSON.parse(x)); };
  sp.send(JSON.stringify({ type: 'response.create', response: { instructions: `${SPEAK_ONLY} ${SAY_PREFIX}Hello there.`, metadata: { id: 'r1' } } }));
  await until(() => ev.some((e) => e.type === 'response.done'));
  assert.equal(ev.find((e) => e.type === 'response.done').response.status, 'failed');
  assert.ok(d.lines.some((l) => l.code === 'SPEAKER_FALLBACK' && l.why === 'EMPTY'), 'an empty body is zero audio: OpenAI is asked to speak the line');
  assert.ok(d.lines.some((l) => l.code === 'SPEAKER_FAILED' && l.why === 'FALLBACK_NO_AUDIO'), 'and this stand-in never answers, so the call ends');
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
  const d = diagInto(); const sp = withSpeaker(inner, src, JACK_SPEAKER, { diag: d.diag, fallbackFirstAudioMs: 100, endDelayMs: 40 });
  const ev: any[] = []; sp.onMessage = (x: string) => { ev.push(JSON.parse(x)); };
  sp.send(JSON.stringify({ type: 'response.create', response: { instructions: `${SPEAK_ONLY} ${SAY_PREFIX}Hello there.`, metadata: { id: 'r1' } } }));
  await until(() => ev.some((e) => e.type === 'response.done'));
  assert.ok(d.lines.some((l) => l.code === 'SPEAKER_FALLBACK' && l.why === 'START_FAILED'), 'no key is zero audio: OpenAI is asked to speak the line');
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

// ---------------------------------------------------------------- the error SHAPE (a fixed word) and the allowlisted provider identifiers (diagnostic hook only)
const refuse = (status: number, body: unknown) => (_q: http.IncomingMessage, res: http.ServerResponse): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const ALLOWED_CODES = ['validation_error', 'invalid_request', 'authentication_error', 'payment_required', 'authorization_error', 'not_found', 'conflict', 'rate_limit_error', 'internal_error', 'service_unavailable',
  'text_too_long', 'text_too_short', 'invalid_text', 'empty_text', 'invalid_parameters', 'missing_required_field', 'invalid_voice_settings', 'invalid_voice_id', 'unsupported_model', 'invalid_output_format',
  'bad_request', 'malformed_json', 'invalid_content_type', 'request_too_large', 'invalid_api_key', 'missing_api_key', 'invalid_authorization_header', 'unauthorized',
  'forbidden', 'insufficient_permissions', 'voice_access_denied', 'model_access_denied', 'feature_not_available', 'subscription_required', 'missing_permissions', 'voice_not_found', 'model_not_found',
  'rate_limit_exceeded', 'concurrent_limit_exceeded', 'system_busy', 'insufficient_credits', 'quota_exceeded', 'max_character_limit_exceeded', 'maintenance'];

test('shape and codes: the allowlist is exactly this fixed list of provider identifiers, and the shapes are exactly these fixed words', () => {
  assert.deepEqual([...PROVIDER_CODES], ALLOWED_CODES); assert.ok(Object.isFrozen(PROVIDER_CODES)); assert.equal(new Set(PROVIDER_CODES).size, PROVIDER_CODES.length, 'no repeats');
  for (const c of PROVIDER_CODES) assert.match(c, /^[a-z][a-z_]{2,47}$/);
  assert.deepEqual([...ERROR_SHAPES], ['STATUS_LISTED', 'STATUS_UNLISTED', 'NO_STATUS', 'DETAIL_LIST', 'DETAIL_TEXT', 'NO_DETAIL', 'NOT_OBJECT', 'UNPARSED']); assert.ok(Object.isFrozen(ERROR_SHAPES));
});

test('errorShapeOf: names only the STRUCTURE of the body, as one fixed word, whatever the body says', () => {
  const cases: Array<[unknown, string]> = [
    [JSON.stringify({ detail: { status: 'voice_not_found', message: DETAIL } }), 'STATUS_LISTED'], [JSON.stringify({ detail: { status: 'something_new', message: DETAIL } }), 'STATUS_UNLISTED'],
    [JSON.stringify({ detail: { status: ['x'] } }), 'NO_STATUS'], [JSON.stringify({ detail: { message: DETAIL } }), 'NO_STATUS'], [JSON.stringify({ detail: { status: 7 } }), 'NO_STATUS'],
    [JSON.stringify({ detail: [{ loc: ['body'], msg: DETAIL }] }), 'DETAIL_LIST'], [JSON.stringify({ detail: `${DETAIL} ${KEY}` }), 'DETAIL_TEXT'], [JSON.stringify({ message: DETAIL }), 'NO_DETAIL'], ['{}', 'NO_DETAIL'],
    [JSON.stringify({ detail: 5 }), 'NOT_OBJECT'], [JSON.stringify({ detail: null }), 'NOT_OBJECT'], ['[]', 'NOT_OBJECT'], ['null', 'NOT_OBJECT'], ['7', 'NOT_OBJECT'], ['"detail"', 'NOT_OBJECT'],
    ['', 'UNPARSED'], ['not json', 'UNPARSED'], [`${DETAIL} ${KEY}`, 'UNPARSED'], ['{"detail":{"status":"voice_not_found"', 'UNPARSED'], [undefined, 'UNPARSED'], [null, 'UNPARSED'], [5, 'UNPARSED'], [{}, 'UNPARSED'],
  ];
  for (const [text, shape] of cases) { assert.equal(errorShapeOf(text), shape, String(text)); assert.ok(ERROR_SHAPES.includes(errorShapeOf(text))); }
  for (const hostile of ['{"detail":{"status":"' + 'a'.repeat(5000) + '"}}', '{"detail":{"status":"' + KEY + '"}}', '\u0000\u0001', '{"detail":{"status":"__proto__"}}', '{"detail":{"status":"toString"}}']) { const s = errorShapeOf(hostile); assert.ok(ERROR_SHAPES.includes(s), s); assert.ok(!s.includes('CANARY') && !s.includes('KEY')); }
});

test('providerCodesOf: returns only identifiers that are EXACTLY on the allowlist, from status, code and type only; never the message, a look-alike, a mixed-case or padded word, or anything from a list or text body', () => {
  const codes = (detail: unknown): string[] => providerCodesOf(JSON.stringify({ detail }));
  assert.deepEqual(codes({ status: 'voice_not_found', message: DETAIL }), ['voice_not_found']);
  assert.deepEqual(codes({ status: 'insufficient_credits', code: 'quota_exceeded', type: 'payment_required' }), ['insufficient_credits', 'quota_exceeded', 'payment_required']);
  assert.deepEqual(codes({ status: 'quota_exceeded', code: 'quota_exceeded', type: 'quota_exceeded' }), ['quota_exceeded'], 'no repeats');
  assert.deepEqual(codes({ type: 'validation_error', code: 'invalid_voice_id' }), ['invalid_voice_id', 'validation_error']);
  for (const word of ALLOWED_CODES) assert.deepEqual(codes({ status: word }), [word], word);
  for (const bad of ['Voice_Not_Found', 'VOICE_NOT_FOUND', ' voice_not_found', 'voice_not_found ', 'voice_not_found\n', 'voice-not-found', 'voice_not_found_x', 'voice_not_foun', 'something_new', 'canary_status_leak', KEY, `${KEY}_x`, '', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'a'.repeat(5000), 'voice_not_found,quota_exceeded'])
    assert.deepEqual(codes({ status: bad, message: 'voice_not_found' }), [], JSON.stringify(bad).slice(0, 40));
  assert.deepEqual(codes({ message: 'voice_not_found', error: 'quota_exceeded', msg: 'invalid_api_key', detail: 'forbidden' }), [], 'only status, code and type are read');
  for (const text of [JSON.stringify({ detail: [{ status: 'voice_not_found' }] }), JSON.stringify({ detail: 'voice_not_found' }), JSON.stringify({ status: 'voice_not_found' }), JSON.stringify({ detail: ['voice_not_found'] }), JSON.stringify({ detail: { status: ['voice_not_found'] } }), JSON.stringify({ detail: { status: 7 } }), 'not json', '', undefined, null, 7, {}, '[]', 'null'])
    assert.deepEqual(providerCodesOf(text), [], String(text));
  const ok = providerCodesOf(JSON.stringify({ detail: { status: 'voice_not_found', code: KEY, type: 'canary_status_leak' } })); assert.deepEqual(ok, ['voice_not_found']); assert.ok(!JSON.stringify(ok).includes('CANARY'));
});

test('the diagnostic hook: a refused request tells it the shape and the allowlisted identifiers only (never the body, a message, the key or the text); it is not called for a success; a throwing hook changes nothing; without it nothing extra is logged but the shape', async () => {
  const seen: Array<{ shape: string; codes: readonly string[] }> = [];
  const m = await mockServer(refuse(400, { detail: { status: 'insufficient_credits', code: 'canary_code_leak', message: `${DETAIL} ${KEY} ${REQUEST.text}` } }));
  const { lines, diag } = diagInto(); const c = collector();
  createElevenLabsSpeechSource(config(m.origin, { diag, onErrorDetail: (d) => { seen.push(d); } })).start(REQUEST, c.sink);
  await until(() => c.count('fail') === 1);
  assert.deepEqual(seen, [{ shape: 'STATUS_UNLISTED', codes: ['insufficient_credits'] }]); assert.deepEqual(Object.keys(seen[0]).sort(), ['codes', 'shape']);
  assert.ok(!JSON.stringify(seen).match(/CANARY|KEY-|canary/i) && !JSON.stringify(seen).includes(REQUEST.text), 'nothing from the body, the key or the text reaches the hook');
  const failed = lines.find((l) => l.code === 'ELEVENLABS_FAILED') as { [k: string]: unknown }; assert.equal(failed.shape, 'STATUS_UNLISTED'); assert.ok(!('providerCode' in failed) && !('codes' in failed), 'the call log gets the shape only');
  // a success: the hook is never called
  const ok = await mockServer((_q, res) => { audio(res); res.end(Buffer.alloc(10, 7)); }); const c2 = collector(); let called = 0;
  createElevenLabsSpeechSource(config(ok.origin, { onErrorDetail: () => { called++; } })).start(REQUEST, c2.sink); await until(() => c2.count('end') === 1); assert.equal(called, 0);
  // a hook that throws: the line still fails once, with the same log
  const bad = await mockServer(refuse(401, { detail: { status: 'invalid_api_key', message: DETAIL } })); const { lines: l3, diag: d3 } = diagInto(); const c3 = collector();
  createElevenLabsSpeechSource(config(bad.origin, { diag: d3, onErrorDetail: () => { throw new Error(`${KEY}`); } })).start(REQUEST, c3.sink); await until(() => c3.count('fail') === 1); await sleep(30);
  assert.deepEqual(c3.order, ['fail']); assert.deepEqual((l3.find((l) => l.code === 'ELEVENLABS_FAILED') as { reason: string; shape: string }).reason, 'INVALID_API_KEY');
  // no hook (what Drew's entry does): the same failure, and only the shape is added to the log
  const none = await mockServer(refuse(400, { detail: { status: 'voice_not_found' } })); const { lines: l4, diag: d4 } = diagInto(); const c4 = collector();
  createElevenLabsSpeechSource(config(none.origin, { diag: d4 })).start(REQUEST, c4.sink); await until(() => c4.count('fail') === 1);
  assert.deepEqual(Object.keys(l4.find((l) => l.code === 'ELEVENLABS_FAILED')!).sort(), ['code', 'ms', 'reason', 'shape', 'status', 'why']);
});

test('the hook source guard: the raw body never leaves the client: it reaches the hook only as a shape and allowlisted identifiers, and Drew\'s entry does not pass the hook', () => {
  const src = readFileSync(new URL('../src/elevenlabs-speech-source.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  assert.ok(/config\.onErrorDetail\?\.\(\{ shape, codes: providerCodesOf\(text\) \}\)/.test(src), 'the hook gets a shape and the allowlisted codes only');
  assert.equal([...src.matchAll(/onErrorDetail/g)].length, 2, 'declared once, called once');
  for (const f of readdirSync(new URL('../src/', import.meta.url))) { const s = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'); if (f !== 'elevenlabs-speech-source.ts') assert.ok(!/onErrorDetail/.test(s), `${f} must not use the diagnostic hook`); }
});
