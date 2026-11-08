// The ISOLATED one-request ElevenLabs diagnostic (tools/elevenlabs-jack-check.ts) against a MOCK server on the loopback address (node:http, an ephemeral port) and fetch stand-ins. No call leaves this machine,
// no real key is used (a canary string stands in for one), and nothing here sends anything to ElevenLabs. A pass shows behaviour against THIS model of the provider only.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CHECK_TEXT, CONFIRM, MAX_REQUESTS, runCheck, show } from '../tools/elevenlabs-jack-check.ts';
import type { CheckCode, CheckResult } from '../tools/elevenlabs-jack-check.ts';
import { JACK_SPEAKER } from '../src/speaker-adapter.ts';
import { VOICE_SETTINGS_DEFAULTS } from '../src/elevenlabs-speech-source.ts';

const KEY = 'KEYCANARY-do-not-log-0123456789';
const DETAIL = 'CANARY-PROVIDER-DETAIL-voice-limit';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Seen { method: string | undefined; url: string | undefined; headers: http.IncomingHttpHeaders; body: string }
const closers: Array<() => unknown> = [];
after(async () => { for (const c of closers.reverse()) try { await c(); } catch { /* already closed */ } });
async function mockServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => { let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body }); handler(req, res); }); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const close = async (): Promise<void> => { server.closeAllConnections?.(); await new Promise<void>((r) => server.close(() => r())); };
  closers.push(close);
  return { origin: `http://127.0.0.1:${port}`, seen };
}
const audio = (res: http.ServerResponse, n: number): void => { res.writeHead(200, { 'content-type': 'audio/basic' }); res.end(Buffer.alloc(n, 7)); };
const refuse = (status: number, body: unknown) => (_q: http.IncomingMessage, res: http.ServerResponse): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
const SHOW_LINES: RegExp[] = [/^RESULT: (PASS|FAIL)$/, /^CODE: [A-Z_]+$/, /^HTTP_STATUS: (none|\d{3})$/, /^PROVIDER_REASON: (none|[A-Z_]+)$/, /^AUDIO_BYTES: \d+$/, /^LATENCY_MS: \d+$/, /^TEXT_CHARACTERS_SENT: \d+$/, /^REQUESTS_SENT: [01]$/,
  /^MEANING: [A-Za-z0-9_ ,.()'"-]+$/, /^Nothing else was sent\. No key, response text or customer data is shown\.$/];
const allowedLines = (text: string): void => { for (const l of text.split('\n')) assert.ok(SHOW_LINES.some((re) => re.test(l)), `an unexpected output line: ${l}`); };

test('the request: ONE POST to Jack\'s streaming path, the key only in the xi-api-key header, the approved model and speed, and one fixed line; a clean answer is a PASS that counts the audio and keeps none of it', async () => {
  const m = await mockServer((_q, res) => audio(res, 10));
  const r = await runCheck({ key: KEY, fetch: globalThis.fetch, origin: m.origin });
  assert.equal(m.seen.length, MAX_REQUESTS, 'one request, never more'); const s = m.seen[0];
  assert.deepEqual([s.method, s.url], ['POST', `/v1/text-to-speech/${JACK_SPEAKER.voiceId}/stream?output_format=ulaw_8000`]);
  assert.equal(s.headers['xi-api-key'], KEY); assert.equal(s.headers['content-type'], 'application/json'); assert.ok(!(s.url ?? '').includes('KEYCANARY') && !s.body.includes('KEYCANARY'), 'the key is nowhere but the header');
  assert.deepEqual(JSON.parse(s.body), { text: CHECK_TEXT, model_id: 'eleven_flash_v2_5', voice_settings: { ...VOICE_SETTINGS_DEFAULTS, speed: 0.95 } });
  assert.equal(CHECK_TEXT.length, 10); assert.deepEqual([r.result, r.code, r.audioBytes, r.requests, r.chars], ['PASS', 'AUDIO_RECEIVED', 10, 1, 10]); assert.equal(r.status, undefined);
  const out = show(r); allowedLines(out); assert.ok(out.includes('RESULT: PASS') && out.includes('AUDIO_BYTES: 10') && out.includes('REQUESTS_SENT: 1'));
  assert.ok(!out.includes('KEYCANARY') && !out.includes(CHECK_TEXT) && !out.includes(JACK_SPEAKER.voiceId));
});

test('fixed-code outcomes: every refused status is a FAIL with the HTTP status and one fixed reason; the provider\'s words, the key and the text never appear; and a refusal is never retried', async () => {
  const words: Array<[string, string]> = [['voice_not_found', 'VOICE_NOT_FOUND'], ['quota_exceeded', 'QUOTA_EXCEEDED'], ['invalid_api_key', 'INVALID_API_KEY'], ['rate_limit_exceeded', 'RATE_LIMIT'], ['concurrent_limit_exceeded', 'CONCURRENT_LIMIT'], ['max_character_limit_exceeded', 'CHAR_LIMIT']];
  for (const status of [400, 401, 403, 404]) for (const [word, code] of words) {
    const m = await mockServer(refuse(status, { detail: { status: word, message: `${DETAIL} ${KEY} ${CHECK_TEXT}` } }));
    const r = await runCheck({ key: KEY, fetch: globalThis.fetch, origin: m.origin });
    assert.equal(m.seen.length, 1, `${status} ${word}: not retried`); assert.deepEqual([r.result, r.code, r.status, r.reason, r.audioBytes, r.requests], ['FAIL', 'HTTP_ERROR', status, code, 0, 1], `${status} ${word}`);
    const out = show(r); allowedLines(out); assert.ok(!/CANARY|KEYCANARY|voice_not_found|quota_exceeded/.test(out) && !out.includes(CHECK_TEXT), `${status} ${word}`);
  }
  for (const [status, body, reason] of [[400, 'not json', 'UNPARSED'], [422, { detail: [{ loc: ['body'], msg: DETAIL }] }, 'OTHER'], [429, { detail: { status: 'something_new', message: DETAIL } }, 'OTHER'], [500, '', 'UNPARSED'], [502, `${DETAIL} ${KEY}`, 'UNPARSED']] as Array<[number, unknown, string]>) {
    const m = await mockServer(refuse(status, body)); const r = await runCheck({ key: KEY, fetch: globalThis.fetch, origin: m.origin });
    assert.deepEqual([r.code, r.status, r.reason, m.seen.length], ['HTTP_ERROR', status, reason, 1], String(status)); assert.ok(!/CANARY/.test(show(r)));
  }
});

test('no key, or a value that is not shaped like a key: nothing is sent at all', async () => {
  let calls = 0; const fetchStandIn = (async () => { calls++; return new Response('x'); }) as typeof fetch;
  for (const [key, code] of [[undefined, 'NO_KEY'], ['', 'NO_KEY'], ['short', 'BAD_KEY_SHAPE'], ['has a space in it 12345', 'BAD_KEY_SHAPE'], ['quote"inside12345', 'BAD_KEY_SHAPE'], ['line\nbreak12345', 'BAD_KEY_SHAPE'], ['x'.repeat(301), 'BAD_KEY_SHAPE']] as Array<[string | undefined, CheckCode]>) {
    const r = await runCheck({ key, fetch: fetchStandIn }); assert.deepEqual([r.result, r.code, r.requests, r.audioBytes], ['FAIL', code, 0, 0], String(key)); const out = show(r); allowedLines(out); assert.ok(out.includes('TEXT_CHARACTERS_SENT: 0') && out.includes('REQUESTS_SENT: 0'));
  }
  assert.equal(calls, 0, 'the network was never touched');
});

test('every other failure ends as its own fixed code after exactly one request: an empty answer, a non-audio answer, a reset, silence, a stalled stream, a stream that is too long, a failing network', async () => {
  const cases: Array<[string, (q: http.IncomingMessage, res: http.ServerResponse) => void, Partial<Parameters<typeof runCheck>[0]>, CheckCode]> = [
    ['empty', (_q, res) => { res.writeHead(200, { 'content-type': 'audio/basic' }); res.end(); }, {}, 'EMPTY_AUDIO'],
    ['not audio', (_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(`{"message":"${DETAIL}"}`); }, {}, 'BAD_TYPE'],
    ['reset', (_q, res) => { res.socket?.destroy(); }, {}, 'REQUEST_ERROR'],
    ['silent', () => { /* never answers */ }, { headersTimeoutMs: 60 }, 'TIMEOUT_HEADERS'],
    ['stalled after headers', (_q, res) => { res.writeHead(200, { 'content-type': 'audio/basic' }); res.write(Buffer.alloc(5, 1)); }, { totalMs: 120 }, 'TIMEOUT_TOTAL'],
    ['too long', (_q, res) => audio(res, 5000), { maxBytes: 100 }, 'TOO_BIG'],
  ];
  for (const [label, handler, extra, code] of cases) {
    const m = await mockServer(handler); const r = await runCheck({ key: KEY, fetch: globalThis.fetch, origin: m.origin, ...extra });
    assert.deepEqual([r.result, r.code, r.requests], ['FAIL', code, 1], label); assert.equal(m.seen.length, 1, `${label}: one request`); allowedLines(show(r)); assert.ok(!/CANARY/.test(show(r)), label);
  }
  let calls = 0; const r = await runCheck({ key: KEY, fetch: (async () => { calls++; throw new Error(`${DETAIL} ${KEY}`); }) as typeof fetch });
  assert.deepEqual([r.code, r.requests, calls], ['REQUEST_ERROR', 1, 1], 'a failing network is reported once and not retried'); assert.ok(!/CANARY/.test(show(r)));
});

test('show: every code has a fixed meaning, and the output is fixed words and numbers only', () => {
  const codes: CheckCode[] = ['AUDIO_RECEIVED', 'NO_KEY', 'BAD_KEY_SHAPE', 'HTTP_ERROR', 'TIMEOUT_HEADERS', 'REQUEST_ERROR', 'BAD_TYPE', 'READ_ERROR', 'TOO_BIG', 'EMPTY_AUDIO', 'TIMEOUT_TOTAL', 'START_FAILED'];
  for (const code of codes) for (const reason of [undefined, 'VOICE_NOT_FOUND', 'QUOTA_EXCEEDED', 'INVALID_API_KEY', 'RATE_LIMIT', 'CONCURRENT_LIMIT', 'CHAR_LIMIT', 'OTHER', 'UNPARSED']) {
    const r: CheckResult = { result: code === 'AUDIO_RECEIVED' ? 'PASS' : 'FAIL', code, ...(code === 'HTTP_ERROR' ? { status: 400 } : {}), ...(reason === undefined ? {} : { reason }), audioBytes: 0, ms: 12.4, chars: 10, requests: 1 };
    const out = show(r); allowedLines(out); assert.ok(!/MEANING: $/m.test(out), `${code} ${reason}: a meaning is given`);
  }
});

// ---------------------------------------------------------------- the command line, as a real child process against the mock server
const TOOL = fileURLToPath(new URL('../tools/elevenlabs-jack-check.ts', import.meta.url));
function runTool(args: string[], input: string, env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TOOL, ...args], { env: { ...process.env, ELEVENLABS_API_KEY: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
    child.on('close', (code) => resolve({ code, out })); child.stdin.end(input);
  });
}

test('the command line: with no --run nothing is read into a request or sent, and the plan is shown with the key only as present or not; an unconfirmed --run sends nothing', async () => {
  const m = await mockServer((_q, res) => audio(res, 10));
  const dry = await runTool(['--origin', m.origin], '', { ELEVENLABS_API_KEY: KEY });
  assert.equal(dry.code, 0); assert.ok(dry.out.includes('Dry run') && dry.out.includes('Present here: yes') && dry.out.includes(`ends ${JACK_SPEAKER.voiceId.slice(-4)}`)); assert.ok(!dry.out.includes('KEYCANARY') && !dry.out.includes(JACK_SPEAKER.voiceId) && !dry.out.includes('RESULT:'));
  assert.ok(/Credits: 10 characters/.test(dry.out) && /UNVERIFIED/.test(dry.out), 'the credit implication is stated as unverified');
  for (const typed of ['', 'no\n', 'run-1\n', 'RUN-2\n', 'RUN-1 please\n']) {
    const r = await runTool(['--run', '--origin', m.origin], typed, { ELEVENLABS_API_KEY: KEY });
    assert.ok(r.out.includes('Not confirmed. Nothing was sent.'), JSON.stringify(typed)); assert.equal(r.code, 2); assert.ok(!r.out.includes('RESULT:') && !r.out.includes('KEYCANARY'));
  }
  assert.equal(m.seen.length, 0, 'nothing reached the server');
  const bad = await runTool(['--run', '--origin', 'http://example.com'], `${CONFIRM}\n`, { ELEVENLABS_API_KEY: KEY });
  assert.ok(bad.out.includes('--origin accepts only a loopback address') && bad.code === 2 && !bad.out.includes('RESULT:'), 'only a loopback test server is accepted as an origin');
});

test('the command line: a confirmed run sends exactly one request and prints the fixed result; the exit code is 0 only for a PASS; the key is never printed', async () => {
  const ok = await mockServer((_q, res) => audio(res, 33));
  const pass = await runTool(['--run', '--origin', ok.origin], `${CONFIRM}\n`, { ELEVENLABS_API_KEY: KEY });
  assert.equal(pass.code, 0); assert.ok(pass.out.includes('RESULT: PASS') && pass.out.includes('AUDIO_BYTES: 33') && pass.out.includes('REQUESTS_SENT: 1')); assert.equal(ok.seen.length, 1); assert.equal(ok.seen[0].headers['xi-api-key'], KEY); assert.ok(!pass.out.includes('KEYCANARY'));
  const no = await mockServer(refuse(400, { detail: { status: 'voice_not_found', message: DETAIL } }));
  const fail = await runTool(['--run', '--origin', no.origin], `${CONFIRM}\n`, { ELEVENLABS_API_KEY: KEY });
  assert.equal(fail.code, 1); assert.ok(fail.out.includes('RESULT: FAIL') && fail.out.includes('HTTP_STATUS: 400') && fail.out.includes('PROVIDER_REASON: VOICE_NOT_FOUND')); assert.equal(no.seen.length, 1); assert.ok(!/CANARY/.test(fail.out));
  const nokey = await runTool(['--run', '--origin', ok.origin], `${CONFIRM}\n`, { ELEVENLABS_API_KEY: '' });
  assert.ok(nokey.out.includes('CODE: NO_KEY') && nokey.out.includes('REQUESTS_SENT: 0') && nokey.code === 1); assert.equal(ok.seen.length, 1, 'no key: no second request');
  await sleep(10);
});

test('isolation: nothing in src/ imports the check; it reads one environment variable, writes nothing, starts no process, and holds the limit of one request', () => {
  const dir = fileURLToPath(new URL('../src/', import.meta.url));
  for (const f of readdirSync(dir)) assert.ok(!/elevenlabs-jack-check/.test(readFileSync(dir + f, 'utf8')), `${f} must not import the diagnostic`);
  const src = readFileSync(TOOL, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.deepEqual([...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]).sort(), ['../src/elevenlabs-speech-source.ts', '../src/hidden-prompt.ts', '../src/speaker-adapter.ts', 'node:readline/promises']);
  assert.deepEqual([...src.matchAll(/process\.env\.[A-Z_]+/g)].map((m) => m[0]), ['process.env.ELEVENLABS_API_KEY'], 'one variable, read once');
  assert.ok(!/writeFile|appendFile|createWriteStream|child_process|execSync|spawn|process\.stdout\.write/.test(src), 'writes no file and starts no process');
  assert.ok(/export const MAX_REQUESTS = 1;/.test(src) && /export const CONFIRM = 'RUN-1';/.test(src));
  assert.equal([...src.matchAll(/source\.start\(/g)].length, 1, 'the request is started in one place');
  const bare = src.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/`(?:[^`\\]|\\.)*`/g, '``');   // the words inside quotes are text, not variables
  assert.ok(!/console\.log\([^)]*\b(?:key|process\.env)\b/.test(bare), 'the key is never handed to a print');
});
