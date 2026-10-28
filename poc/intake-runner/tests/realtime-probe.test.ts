// The Realtime diagnosis (src/realtime-probe.ts) and its place in the connection check, tested with MOCKED fetch and a FAKE https request: no network, no real key. Every key here is an invented string. The aim is
// that the founder can see WHY the Realtime connection fails (an HTTP status and a fixed code) while no key, header or response body can ever appear. A passing test shows behaviour against the mocks. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import type { request as httpsRequest } from 'node:https';
import { diagnoseRealtime, findingsFor, probeHandshake } from '../src/realtime-probe.ts';
import type { Diagnosis, HandshakeAnswer } from '../src/realtime-probe.ts';
import { DREW_TEST_OPENING } from '../src/drew-test-opening.ts';
import { planCheck, runCheck } from '../src/voice-check.ts';
import type { FounderVoiceConfig } from '../src/founder-voice-gate.ts';
import { createWireVoice } from './helpers/realtime-wire-sim.ts';

const FAKE_KEY = 'sk-test-not-a-real-key-0123456789';
const CANARY = 'canary-echo-6602';
const MODEL = 'gpt-realtime-2.1';
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A fake node:https request: the script decides what the service answers once the request is sent. */
function fakeHttps(script: (req: EventEmitter, opts: any) => void) {
  const sent: any[] = []; const state = { destroyed: 0, socketsDestroyed: 0 };
  const request = ((opts: any) => {
    sent.push(opts);
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
    req.end = () => script(req, opts);
    req.destroy = () => { state.destroyed++; };
    return req;
  }) as unknown as typeof httpsRequest;
  return { request, sent, state };
}
const answer = (req: EventEmitter, status: number, body: string) => {
  const res = Object.assign(new EventEmitter(), { statusCode: status, setEncoding() {} });
  req.emit('response', res);
  res.emit('data', body); res.emit('end');
};

// ================================================================ the handshake
test('handshake: a service that accepts the upgrade is reported as upgraded and the socket is closed straight away, with nothing sent over it', async () => {
  let socketDestroyed = 0;
  const f = fakeHttps((req) => req.emit('upgrade', { statusCode: 101 }, { destroy: () => { socketDestroyed++; } }));
  const r = await probeHandshake({ model: MODEL, getKey: () => FAKE_KEY, request: f.request });
  assert.deepEqual(r, { outcome: 'upgraded', status: 101 });
  assert.equal(socketDestroyed, 1);
  const o = f.sent[0];
  assert.deepEqual([o.host, o.port, o.method, o.path], ['api.openai.com', 443, 'GET', `/v1/realtime?model=${MODEL}`]);
  assert.equal(o.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.deepEqual([o.headers.Connection, o.headers.Upgrade, o.headers['Sec-WebSocket-Version']], ['Upgrade', 'websocket', '13']);
  assert.equal(Buffer.from(o.headers['Sec-WebSocket-Key'], 'base64').length, 16);
  assert.ok(!JSON.stringify(r).includes(FAKE_KEY));
});

test('handshake: a refusal is reduced to its status and a strict error code; the message, the body and the key never appear', async () => {
  const cases: Array<[number, string, string | undefined]> = [
    [401, JSON.stringify({ error: { message: `Incorrect key ${FAKE_KEY} ${CANARY}`, type: 'invalid_request_error', code: 'invalid_api_key' } }), 'invalid_api_key'],
    [403, JSON.stringify({ error: { message: CANARY, type: 'permission_error', code: null } }), 'permission_error'],
    [404, JSON.stringify({ error: { message: CANARY, code: 'model_not_found' } }), 'model_not_found'],
    [429, JSON.stringify({ error: { code: 'insufficient_quota' } }), 'insufficient_quota'],
    [500, 'not json at all ' + CANARY, undefined],
    [400, JSON.stringify({ error: { code: `has spaces ${CANARY}` } }), undefined],
    [401, '', undefined],
  ];
  for (const [status, body, code] of cases) {
    const f = fakeHttps((req) => answer(req, status, body));
    const r = await probeHandshake({ model: MODEL, getKey: () => FAKE_KEY, request: f.request });
    assert.deepEqual(r, { outcome: 'refused', status, ...(code === undefined ? {} : { code }) }, String(status));
    const out = JSON.stringify(r);
    assert.ok(!out.includes(CANARY) && !out.includes(FAKE_KEY) && !out.includes('Incorrect'), out);
    assert.ok(f.state.destroyed >= 1, 'the connection is dropped');
  }
});

test('handshake: a network failure keeps only a strict error code, never the message; a silent service times out; both drop the connection', async () => {
  for (const [err, cause] of [[Object.assign(new Error(`connect failed to ${FAKE_KEY}`), { code: 'ENOTFOUND' }), 'ENOTFOUND'], [Object.assign(new Error(CANARY), { cause: { code: 'ECONNRESET' } }), 'ECONNRESET'], [new Error(`x ${FAKE_KEY}`), undefined], [Object.assign(new Error('x'), { code: 'has spaces' }), undefined]] as Array<[Error, string | undefined]>) {
    const f = fakeHttps((req) => req.emit('error', err));
    const r = await probeHandshake({ model: MODEL, getKey: () => FAKE_KEY, request: f.request });
    assert.deepEqual(r, { outcome: 'network', ...(cause === undefined ? {} : { cause }) });
    assert.ok(!JSON.stringify(r).includes(FAKE_KEY) && !JSON.stringify(r).includes(CANARY));
  }
  const silent = fakeHttps(() => {});
  const t = await probeHandshake({ model: MODEL, getKey: () => FAKE_KEY, request: silent.request, timeoutMs: 30 });
  assert.deepEqual(t, { outcome: 'timeout' });
  assert.equal(silent.state.destroyed, 1);
});

test('handshake: no usable key or a bad model id means no request at all', async () => {
  for (const k of [undefined, '', 'short', 'has a space in it 0123', 'line\r\nbreak-0123456789', 12 as never]) {
    const f = fakeHttps(() => {});
    assert.deepEqual(await probeHandshake({ model: MODEL, getKey: () => k, request: f.request }), { outcome: 'no_key' });
    assert.equal(f.sent.length, 0);
  }
  const f = fakeHttps(() => {});
  assert.deepEqual(await probeHandshake({ model: `x&key=${CANARY}`, getKey: () => FAKE_KEY, request: f.request }), { outcome: 'network', cause: 'BAD_MODEL_ID' });
  assert.deepEqual(await probeHandshake({ model: MODEL, getKey: () => { throw new Error('locked'); }, request: f.request }), { outcome: 'no_key' });
  assert.equal(f.sent.length, 0);
});

// ================================================================ the whole diagnosis
function mockApi(routes: Record<string, { status: number; body?: unknown; throwOnText?: boolean }>) {
  const seen: Array<{ method: string; url: string; body?: unknown; headers: Record<string, string> }> = [];
  const reads = { successBodiesRead: 0, cancelled: 0 };
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ method: String(init.method), url, headers: init.headers as Record<string, string>, ...(init.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) });
    const route = routes[`${init.method} ${new URL(url).pathname}`] ?? { status: 404, body: { error: { code: 'not_found' } } };
    const ok = route.status >= 200 && route.status < 300;
    return {
      ok, status: route.status,
      body: { cancel: async () => { reads.cancelled++; } },
      text: async () => { if (ok) reads.successBodiesRead++; return JSON.stringify(route.body ?? {}); },
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen, reads };
}
const upgraded = () => fakeHttps((req) => req.emit('upgrade', { statusCode: 101 }, { destroy() {} })).request;
const refused = (status: number, code: string) => fakeHttps((req) => answer(req, status, JSON.stringify({ error: { code, message: CANARY } }))).request;
const modelList = { data: [{ id: 'gpt-6-luna' }, { id: 'gpt-realtime-2.1' }, { id: 'gpt-realtime-2.1-mini' }, { id: 'gpt-transcribe' }, { id: 'gpt-live-transcribe' }, { id: 'whisper-1' }, { id: 'gpt-5-mini' }, { id: 'text-embedding-3-small' }, { id: 5 }, { id: 'has spaces' }] };

test('diagnosis: a healthy key asks three free questions with the right shape, reads nothing from a success, and says the connection problem is on the client or network side', async () => {
  const api = mockApi({ 'GET /v1/models/gpt-realtime-2.1': { status: 200, body: { id: MODEL } }, 'POST /v1/realtime/client_secrets': { status: 200, body: { value: `ek_${CANARY}`, expires_at: 1 } }, 'GET /v1/models': { status: 200, body: modelList } });
  const d = await diagnoseRealtime({ model: MODEL, getKey: () => FAKE_KEY, fetch: api.fetch, request: upgraded() });
  assert.deepEqual(api.seen.map((s) => `${s.method} ${new URL(s.url).host}${new URL(s.url).pathname}`), ['GET api.openai.com/v1/models/gpt-realtime-2.1', 'POST api.openai.com/v1/realtime/client_secrets', 'GET api.openai.com/v1/models']);
  assert.deepEqual(api.seen[1].body, { expires_after: { anchor: 'created_at', seconds: 10 }, session: { type: 'realtime', model: MODEL } }, 'the shortest documented life, and nothing else');
  assert.ok(api.seen.every((s) => s.headers.Authorization === `Bearer ${FAKE_KEY}`));
  assert.equal(api.reads.successBodiesRead, 1, 'only the model list is read; the lookup and the session secret are thrown away unread');
  assert.equal(api.reads.cancelled, 2);
  assert.deepEqual(d.handshake, { outcome: 'upgraded', status: 101 });
  assert.deepEqual([d.modelLookup.status, d.clientSecret.status, d.listStatus], [200, 200, 200]);
  assert.deepEqual(d.visible, { ids: ['gpt-live-transcribe', 'gpt-realtime-2.1', 'gpt-realtime-2.1-mini', 'gpt-transcribe', 'whisper-1'], hasModel: true, total: 8 });
  assert.ok(d.findings[0].startsWith('HANDSHAKE_OK') && d.findings.some((f) => f.startsWith('MODEL_VISIBLE')) && d.findings.some((f) => f.startsWith('REALTIME_PERMISSION_OK')));
  const out = JSON.stringify(d);
  for (const s of [FAKE_KEY, CANARY, 'ek_', 'has spaces']) assert.ok(!out.includes(s), `the diagnosis holds: ${s}`);
});

test('diagnosis: a model the key cannot see is named with the voice and transcription models it can', async () => {
  const api = mockApi({ 'GET /v1/models/gpt-realtime-2.1': { status: 404, body: { error: { code: 'model_not_found', message: CANARY } } }, 'POST /v1/realtime/client_secrets': { status: 400, body: { error: { code: 'invalid_model' } } }, 'GET /v1/models': { status: 200, body: { data: [{ id: 'gpt-realtime' }, { id: 'gpt-4o-transcribe' }, { id: 'gpt-5-mini' }] } } });
  const d = await diagnoseRealtime({ model: MODEL, getKey: () => FAKE_KEY, fetch: api.fetch, request: refused(404, 'model_not_found') });
  assert.deepEqual([d.handshake.status, d.handshake.code, d.modelLookup.status, d.modelLookup.code, d.clientSecret.status, d.clientSecret.code], [404, 'model_not_found', 404, 'model_not_found', 400, 'invalid_model']);
  assert.deepEqual(d.visible, { ids: ['gpt-4o-transcribe', 'gpt-realtime'], hasModel: false, total: 3 });
  assert.ok(d.findings.some((f) => f.startsWith('MODEL_OR_ENDPOINT_NOT_FOUND')) && d.findings.some((f) => f.startsWith('MODEL_NOT_VISIBLE')) && d.findings.some((f) => f.startsWith('MODEL_NOT_LISTED')));
  assert.ok(!JSON.stringify(d).includes(CANARY));
});

test('diagnosis: a restricted key, an unreachable network and a missing key each read as themselves, and the list failing is not fatal', async () => {
  const api = mockApi({ 'GET /v1/models/gpt-realtime-2.1': { status: 403, body: { error: { code: 'insufficient_permissions' } } }, 'POST /v1/realtime/client_secrets': { status: 403, body: { error: { type: 'permission_error' } } }, 'GET /v1/models': { status: 403, body: { error: { code: 'insufficient_permissions' } } } });
  const d = await diagnoseRealtime({ model: MODEL, getKey: () => FAKE_KEY, fetch: api.fetch, request: refused(403, 'insufficient_permissions') });
  assert.deepEqual([d.handshake.status, d.modelLookup.status, d.clientSecret.status, d.listStatus, d.visible], [403, 403, 403, 403, undefined]);
  assert.ok(d.findings.some((f) => f.startsWith('KEY_NOT_ALLOWED_FOR_REALTIME')) && d.findings.some((f) => f.startsWith('MODEL_LIST_403')));
  const down = (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }) as unknown as typeof globalThis.fetch;
  const n = await diagnoseRealtime({ model: MODEL, getKey: () => FAKE_KEY, fetch: down, request: fakeHttps((req) => req.emit('error', Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).request });
  assert.deepEqual([n.handshake, n.modelLookup, n.listStatus], [{ outcome: 'network', cause: 'ENOTFOUND' }, { status: 'none', why: 'network', cause: 'ENOTFOUND' }, 'none']);
  assert.ok(n.findings[0].startsWith('NETWORK_PROBLEM') && n.findings[0].includes('ENOTFOUND'));
  const none = mockApi({});
  const k = await diagnoseRealtime({ model: MODEL, getKey: () => undefined, fetch: none.fetch, request: fakeHttps(() => {}).request });
  assert.equal(none.seen.length, 0, 'no key, no request');
  assert.deepEqual([k.handshake.outcome, k.modelLookup.why], ['no_key', 'no_key']);
});

test('findings: each handshake answer has its own fixed reading, and none carries text from the service', () => {
  const ok: Diagnosis['visible'] = undefined;
  const lookup = { status: 200 as const }; const secret = { status: 200 as const };
  const cases: Array<[HandshakeAnswer, string]> = [
    [{ outcome: 'upgraded', status: 101 }, 'HANDSHAKE_OK'], [{ outcome: 'no_key' }, 'NO_KEY'], [{ outcome: 'timeout' }, 'HANDSHAKE_TIMEOUT'], [{ outcome: 'network', cause: 'ECONNRESET' }, 'NETWORK_PROBLEM'],
    [{ outcome: 'refused', status: 401 }, 'KEY_REJECTED_FOR_REALTIME'], [{ outcome: 'refused', status: 403 }, 'KEY_NOT_ALLOWED_FOR_REALTIME'], [{ outcome: 'refused', status: 404 }, 'MODEL_OR_ENDPOINT_NOT_FOUND'],
    [{ outcome: 'refused', status: 400 }, 'REQUEST_REJECTED'], [{ outcome: 'refused', status: 429 }, 'QUOTA_OR_RATE_LIMIT'], [{ outcome: 'refused', status: 503 }, 'SERVICE_ERROR'], [{ outcome: 'refused', status: 418 }, 'HANDSHAKE_REFUSED'],
  ];
  for (const [h, code] of cases) { const f = findingsFor(h, lookup, secret, ok, 200); assert.ok(f[0].startsWith(code), `${code}: ${f[0]}`); assert.ok(f.every((x) => /^[A-Z_0-9]+: /.test(x))); }
});

// ================================================================ in the connection check
const voiceConfig = (): FounderVoiceConfig => ({ ...JSON.parse(readFileSync(new URL('../examples/founder-voice.config.example.json', import.meta.url), 'utf8')), openai_model: 'gpt-6-luna', realtime_model: 'gpt-realtime-2.1', transcription_model: 'gpt-transcribe', voice: 'marin' });
function textOk() {
  const answerJson = (text: string) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 10, output_tokens: 5 } });
  return { responses: { create: async (p: any) => (p.text?.format ? answerJson(JSON.stringify({ category: 'Standard cleaning', confidence: 0.9 })) : answerJson('Hello, how can I help you today?')) } };
}
const deadVoice = () => ({ send: () => true, close() {}, onOpen: () => {}, onMessage: () => {}, onClose: () => {} });

test('check: when the Realtime part fails the diagnosis is asked for and attached; when it works it is not asked', async () => {
  const plan = (planCheck(voiceConfig(), DREW_TEST_OPENING) as { plan: any }).plan;
  let asked = 0;
  const dx: Diagnosis = { handshake: { outcome: 'refused', status: 403, code: 'permission_error' }, modelLookup: { status: 200 }, clientSecret: { status: 403 }, listStatus: 200, findings: ['KEY_NOT_ALLOWED_FOR_REALTIME: x'] };
  const bad = await runCheck({ plan, voice: voiceConfig(), textClient: textOk() as never, voiceSocket: deadVoice(), now: () => Date.now(), maxMs: 300, diagnose: async () => { asked++; return dx; } });
  assert.equal(asked, 1);
  assert.deepEqual(bad.diagnosis, dx);
  assert.equal(bad.checks.find((c) => c.name === 'session_accepted')!.code, 'CONNECTION_FAILED');
  const wire = createWireVoice({ msPerChar: 1, behave: (_t, n) => (n === 1 ? 'currency' : 'exact') });
  setTimeout(() => wire.open(), 0);
  let askedAgain = 0;
  const good = await runCheck({ plan, voice: voiceConfig(), textClient: textOk() as never, voiceSocket: wire, now: () => Date.now(), diagnose: async () => { askedAgain++; return dx; } });
  assert.ok(good.allPassed);
  assert.equal(askedAgain, 0);
  assert.equal(good.diagnosis, undefined);
  const thrown = await runCheck({ plan, voice: voiceConfig(), textClient: textOk() as never, voiceSocket: deadVoice(), now: () => Date.now(), maxMs: 300, diagnose: async () => { throw new Error(FAKE_KEY); } });
  assert.equal(thrown.diagnosis, undefined, 'a failing diagnosis never breaks the report or leaks into it');
  assert.ok(!JSON.stringify(thrown).includes(FAKE_KEY));
});

// ================================================================ static guards
test('static: the probe has one fixed host, reads no environment, logs nothing and holds no key beyond a request; only the check command uses it', () => {
  const code = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const own = code('realtime-probe.ts');
  for (const bad of [/process\./, /console\./, /require\s*\(/, /\beval\s*\(/, /writeFile|appendFile|createWriteStream/, /@anthropic-ai|from 'openai'/]) assert.ok(!bad.test(own), String(bad));
  assert.deepEqual([...own.matchAll(/^import[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]), ['node:https', 'node:crypto']);
  assert.ok(!/https?:\/\/(?!\$\{HOST\}|api\.openai\.com)/.test(own), 'every address is the one fixed host');
  assert.equal([...own.matchAll(/'api\.openai\.com'/g)].length, 1, 'the host is written once');
  assert.ok(!/diag|log\(/.test(own.replace(/diagnoseRealtime|Diagnosis/g, '')), 'nothing is logged');
  for (const f of readdirSync(new URL('../src/', import.meta.url)).filter((n) => n.endsWith('.ts') && n !== 'realtime-probe.ts')) {
    const c = code(f);
    assert.equal(/realtime-probe/.test(c), ['founder-voice-check.ts', 'voice-check.ts'].includes(f), `${f}: only the check command (and the check's type import) may use the probe`);
  }
  assert.ok(/import type \{ Diagnosis \} from '.\/realtime-probe.ts'/.test(code('voice-check.ts')) && !/import \{[^}]*\} from '.\/realtime-probe.ts'/.test(code('voice-check.ts')), 'the check logic imports only a type');
  void pause;
});
