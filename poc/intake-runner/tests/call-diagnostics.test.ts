// Durable, privacy-safe call diagnostics (src/call-diag.ts and the codes the bridge, the adapter, the voice socket, the WebSocket server and the voice service now emit), and the two defects the first founder call
// exposed: the call logic's fixed 5-second wait for `setup` (which hung up on a consent notice that takes about 28 seconds to say) and audio that could not be passed on but still let the notice count as heard.
// Everything is offline with stand-ins; invented data only. A passing test shows behaviour against the stand-ins. Run: npm test
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanDetail, fileDiagSink, scopedDiag } from '../src/call-diag.ts';
import { createRealtimeBridge } from '../src/realtime-bridge.ts';
import { createRealtimeTransport } from '../src/realtime-transport.ts';
import { createOpenAiVoiceSocket } from '../src/openai-voice-socket.ts';
import type { WebSocketLike } from '../src/openai-voice-socket.ts';
import { createRelayWsServer } from '../src/ws-server.ts';
import { signedUrlCandidates } from '../src/founder-call-gate.ts';
import type { TransportEvent } from '../src/call-transport.ts';
import { connectRelay } from './helpers/twilio-sim.ts';
import { createWirePhone, createWireVoice } from './helpers/realtime-wire-sim.ts';
import type { Behaviour } from './helpers/realtime-wire-sim.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOTICE = 'Hello. This is an automated A I assistant for Drew Cleaning. Please say yes to continue, or hang up now.';
const CANARY = 'canary-speech-4471';
const FAKE_KEY = 'sk-test-not-a-real-key-0123456789';
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 4000): Promise<void> { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await pause(4); } }

// ================================================================ the diagnostics module
test('call-diag: only numbers, booleans and short plain tokens survive; speech-like, address-like and structured values are dropped', () => {
  const d = cleanDetail({ ok: true, n: 12.345, bad: NaN, inf: Infinity, status: 'completed', path: 'phone_stop', words: 'hello there how are you', url: 'wss://host.example/relay/secret', key: FAKE_KEY + ' x', nested: { a: 1 }, list: [1, 2], long: 'x'.repeat(60), empty: '', ['Bad Key']: 1, weird: '<b>', nul: null, und: undefined });
  assert.deepEqual(d, { ok: true, n: 12.3, status: 'completed', path: 'phone_stop' });
  assert.deepEqual(cleanDetail('x'), {}); assert.deepEqual(cleanDetail(null), {}); assert.deepEqual(cleanDetail([1]), {});
  const many = cleanDetail(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i])));
  assert.equal(Object.keys(many).length, 16, 'bounded');
});

test('call-diag: a scope adds the call number and the milliseconds since it began; a bad code is dropped; a failing sink never reaches the call', () => {
  let clock = 1000; const got: Array<[string, Record<string, unknown>]> = [];
  const d = scopedDiag((c, det) => { got.push([c, det ?? {}]); }, 3, () => clock);
  d('FIRST_THING', { status: 'ok' }); clock = 1750; d('SECOND_THING', { words: 'a b c' });
  d('lower case', {}); d('X', {}); d('HAS SPACE', {}); d(5 as never);
  assert.deepEqual(got, [['FIRST_THING', { status: 'ok', call: 3, ms: 0 }], ['SECOND_THING', { call: 3, ms: 750 }]]);
  assert.doesNotThrow(() => scopedDiag(() => { throw new Error(FAKE_KEY); }, 1)('SOME_CODE'));
});

test('call-diag: the file sink writes one line per event, in a fixed shape, and a full disk or closed console never reaches the call', () => {
  const lines: string[] = []; const echoed: string[] = [];
  const sink = fileDiagSink({ append: (l) => { lines.push(l); }, nowIso: () => '2026-10-27T20:53:01Z', echo: (l) => { echoed.push(l); } });
  sink('CALL_STREAM_ACCEPTED', { noticeChars: 407, call: 2, ms: 0, note: 'free text here' });
  sink('bad code', {});
  assert.deepEqual(lines, ['2026-10-27T20:53:01Z CALL_STREAM_ACCEPTED {"noticeChars":407,"call":2,"ms":0}\n']);
  assert.deepEqual(echoed, ['2026-10-27T20:53:01Z CALL_STREAM_ACCEPTED {"noticeChars":407,"call":2,"ms":0}']);
  assert.doesNotThrow(() => fileDiagSink({ append: () => { throw new Error('disk full'); }, nowIso: () => 'x', echo: () => { throw new Error('closed'); } })('SOME_CODE'));
});

// ================================================================ the bridge and the adapter, path by path
interface Line { code: string; [k: string]: unknown }
function rig(o: { voice?: Parameters<typeof createWireVoice>[0]; phone?: Parameters<typeof createWirePhone>[0]; bridge?: Parameters<typeof createRealtimeBridge>[2]; notice?: string } = {}) {
  const phone = createWirePhone(o.phone); const voice = createWireVoice({ msPerChar: 1, ...o.voice });
  const lines: Line[] = [];
  const diag = scopedDiag((code, detail) => { lines.push({ code, ...detail }); }, 1);
  const b = createRealtimeBridge(phone, voice, { ...o.bridge, diag });
  const t = createRealtimeTransport(b.link, { notice: o.notice ?? NOTICE, transcriptionModel: 'sim-transcriber', voice: 'sim-voice', msPerChar: 1, endWaitMs: 300, diag });
  const events: TransportEvent[] = []; const closes: unknown[] = [];
  t.onEvent = (e) => { events.push(e); }; t.onClose = (i) => { closes.push(i); };
  const codes = () => lines.map((l) => l.code);
  const find = (code: string) => lines.filter((l) => l.code === code);
  const end = () => find('BRIDGE_END')[0];
  return { phone, voice, bridge: b, t, lines, events, closes, codes, find, end, kinds: () => events.map((e) => e.kind) };
}
type R = ReturnType<typeof rig>;
const live = async (r: R) => { r.phone.start(); await until(() => r.kinds().includes('setup')); };
const behave = (first: Behaviour) => ({ behave: (_t: string, n: number): Behaviour => (n === 1 ? first : 'exact') });

test('diagnostics: a healthy call logs phone start, voice open, the announcement, the first audio, the reply\'s end and its release, in order, with the milliseconds between them', async () => {
  const r = rig();
  r.voice.open();
  await live(r);
  const order = ['BRIDGE_ANNOUNCED', 'ADAPTER_CALL_START', 'ADAPTER_NOTICE_REQUESTED', 'BRIDGE_RESPONSE_STARTED', 'BRIDGE_FIRST_AUDIO_OUT', 'BRIDGE_RESPONSE_DONE', 'BRIDGE_RESPONSE_RELEASED', 'BRIDGE_NOTICE_HEARD', 'ADAPTER_REPLY_DONE', 'ADAPTER_NOTICE_PLAYED', 'ADAPTER_SETUP_EMITTED'];
  const got = r.codes().filter((c) => order.includes(c));
  assert.deepEqual([...new Set(got)], order, r.codes().join(' '));
  assert.ok(r.codes().indexOf('BRIDGE_PHONE_START') < r.codes().indexOf('BRIDGE_ANNOUNCED') && r.codes().indexOf('BRIDGE_VOICE_OPEN') < r.codes().indexOf('BRIDGE_ANNOUNCED'), 'the call is announced only once the phone has started AND the voice is open');
  const released = r.find('BRIDGE_RESPONSE_RELEASED')[0];
  assert.deepEqual([released.status, released.how, released.lost], ['completed', 'acked', false]);
  assert.equal(r.find('BRIDGE_NOTICE_HEARD')[0].ok, true);
  const done = r.find('ADAPTER_REPLY_DONE')[0];
  assert.deepEqual([done.kind, done.status, done.played, done.requestedChars], ['notice', 'completed', true, NOTICE.length]);
  assert.ok(r.lines.every((l, i) => typeof l.ms === 'number' && l.call === 1 && (i === 0 || (l.ms as number) >= (r.lines[i - 1].ms as number) - 1)), 'every line carries the call number and a non-decreasing time');
  assert.ok(r.end() === undefined, 'a call that has not ended has no end line');
});

const paths: Array<[string, (r: R) => void | Promise<void>, Record<string, unknown>]> = [
  ['phone_stop', (r) => r.phone.stop(), { cause: 'PEER', closedPhone: false }],
  ['phone_closed', (r) => r.phone.onClose({ cause: 'PEER', code: 1006 }), { cause: 'PEER', closedPhone: false }],
  ['voice_closed', (r) => r.voice.onClose(), { cause: 'PEER', closeCode: 1006, closedPhone: true }],
  ['adapter_hangup', (r) => { r.t.endCall(); }, { cause: 'HANDLER', closedPhone: true }],
  ['adapter_close', (r) => r.t.close(1008), { cause: 'HANDLER', closeCode: 1008, closedPhone: true }],
];
for (const [path, act, expect] of paths) {
  test(`diagnostics: the end of a live call by "${path}" is named exactly, with what the call had done by then`, async () => {
    const r = rig(); r.voice.open(); await live(r);
    r.phone.frames(3); await pause(20);
    await act(r);
    await until(() => r.end() !== undefined);
    const e = r.end();
    assert.equal(e.path, path);
    for (const [k, v] of Object.entries(expect)) assert.equal(e[k], v, `${path}: ${k}`);
    assert.ok(r.find('BRIDGE_END').length === 1, 'ended once');
    assert.equal(e.announced, true); assert.equal(e.noticeHeard, true); assert.ok((e.audioOut as number) > 0 && (e.audioIn as number) >= 3);
    assert.ok(r.find('BRIDGE_VOICE_EVENT_COUNT').some((l) => l.type === 'response.done' && l.n === 1), 'the kinds of event the voice service sent are counted');
    if (path === 'phone_closed') assert.deepEqual([r.find('BRIDGE_PHONE_CLOSED')[0].cause, r.find('BRIDGE_PHONE_CLOSED')[0].closeCode], ['PEER', 1006]);
    if (path === 'adapter_close') assert.equal(r.find('ADAPTER_CLOSE')[0].closeCode, 1008);
  });
}

test('diagnostics: the paths that end a call BEFORE the notice is heard are named: a voice that never opens, a call past its ceiling, a start the bridge cannot carry', async () => {
  const a = rig({ voice: { autoOpen: false }, bridge: { openWaitMs: 40 } });
  a.phone.start(); await until(() => a.end() !== undefined);
  assert.equal(a.end().path, 'open_timeout'); assert.equal(a.find('BRIDGE_OPEN_TIMEOUT')[0].voiceOpen, false); assert.equal(a.end().announced, false);
  const b = rig({ bridge: { maxCallMs: 80 } }); b.phone.start(); await until(() => b.end() !== undefined);
  assert.equal(b.end().path, 'max_call'); assert.equal(b.find('BRIDGE_MAX_CALL')[0].maxCallMs, 80);
  for (const [bad, why] of [[{ encoding: 'audio/L16' }, 'format'], [{ sampleRate: 16000 }, 'format']] as const) {
    const c = rig(); c.phone.start(bad); await until(() => c.end() !== undefined);
    assert.equal(c.end().path, 'bad_start'); assert.equal(c.find('BRIDGE_START_REFUSED')[0].why, why);
  }
  const d = rig(); d.phone.raw(JSON.stringify({ event: 'start', start: {} })); await until(() => d.end() !== undefined);
  assert.equal(d.find('BRIDGE_START_REFUSED')[0].why, 'shape');
});

test('diagnostics: a voice that keeps refusing caller audio is named (the first refusal, then the path that ends the call)', async () => {
  let ok = true;
  const r = rig({ voice: { accept: () => ok }, bridge: { maxRefused: 3 } });
  r.voice.open(); await live(r);
  ok = false; r.phone.frames(6);
  await until(() => r.end() !== undefined);
  assert.equal(r.end().path, 'voice_refused_audio');
  assert.equal(r.find('BRIDGE_VOICE_SEND_REFUSED').length, 1, 'said once');
});

test('diagnostics: a notice whose audio the phone never confirms is released as incomplete by its timer, and the call ends by the adapter, each step named', async () => {
  const r = rig({ bridge: { playGraceMs: 60 } });
  r.phone.muteMarks = true; r.voice.open(); r.phone.start();
  await until(() => r.end() !== undefined);
  const wait = r.find('BRIDGE_RELEASE_WAIT')[0];
  assert.ok((wait.waitMs as number) >= 60 && wait.graceMs === 60);
  const rel = r.find('BRIDGE_RESPONSE_RELEASED')[0];
  assert.deepEqual([rel.status, rel.how], ['incomplete', 'timeout']);
  assert.equal(r.find('ADAPTER_NOTICE_FAILED')[0].reason, 'status_incomplete');
  assert.equal(r.end().path, 'adapter_hangup');
  assert.ok(!r.kinds().includes('setup'));
});

test('diagnostics: a notice read in other words, or one that fails or is silent, ends the call with the reason named', async () => {
  const cases: Array<[Behaviour, string]> = [[{ say: 'Hi, how can I help?' }, 'transcript_differs'], ['fail', 'status_failed'], ['silent', 'no_transcript']];
  for (const [b, reason] of cases) {
    const r = rig({ voice: behave(b) }); r.voice.open(); r.phone.start();
    await until(() => r.end() !== undefined);
    assert.equal(r.find('ADAPTER_NOTICE_FAILED')[0].reason, reason, JSON.stringify(b));
    assert.ok(!r.kinds().includes('setup'));
  }
});

test('FAIL CLOSED: audio of a live reply that cannot be passed on (a piece larger than the limit) makes the notice count as NOT heard; the call ends and the call logic is never told it started', async () => {
  const r = rig({ bridge: { maxVoiceChars: 1000 } });   // every audio piece of the stand-in (about 1100 characters) is too large
  r.voice.open(); r.phone.start();
  await until(() => r.end() !== undefined);
  assert.ok(r.find('BRIDGE_VOICE_MESSAGE_DROPPED').length >= 1, 'the oversize message is named');
  assert.equal(r.find('BRIDGE_VOICE_MESSAGE_DROPPED')[0].why, 'too_long');
  const rel = r.find('BRIDGE_RESPONSE_RELEASED')[0];
  assert.deepEqual([rel.status, rel.lost], ['incomplete', true]);
  assert.equal(r.find('ADAPTER_NOTICE_FAILED')[0].reason, 'status_incomplete');
  assert.ok(!r.kinds().includes('setup'), 'the notice was never fully delivered, so consent is never asked for');
});

test('FAIL CLOSED: an audio piece that is not valid audio data makes its reply count as not played, and is named', async () => {
  const r = rig(); r.voice.open(); await live(r);
  r.voice.emit({ type: 'response.created', response: { id: 'resp_bad', metadata: { id: 'zz' } } });
  r.voice.emit({ type: 'response.output_audio.delta', response_id: 'resp_bad', delta: '***not base64***' });
  r.voice.emit({ type: 'response.done', response: { id: 'resp_bad', status: 'completed', metadata: { id: 'zz' } } });
  await until(() => r.find('BRIDGE_RESPONSE_RELEASED').length >= 2);
  const dropped = r.find('BRIDGE_AUDIO_DROPPED')[0];
  assert.deepEqual([dropped.why, dropped.chars], ['not_base64', 16]);
  const rel = r.find('BRIDGE_RESPONSE_RELEASED')[1];
  assert.deepEqual([rel.status, rel.lost], ['incomplete', true]);
});

test('the default limit accepts audio pieces far larger than the old one (256 KB), which a real voice service may send', async () => {
  const phone = createWirePhone(); const voice = createWireVoice({ msPerChar: 1 });
  const lines: Line[] = []; const diag = scopedDiag((code, detail) => { lines.push({ code, ...detail }); }, 1);
  const b = createRealtimeBridge(phone, voice, { diag });
  const t = createRealtimeTransport(b.link, { notice: NOTICE, transcriptionModel: 'x', voice: 'y', msPerChar: 1, diag });
  const events: TransportEvent[] = []; t.onEvent = (e) => { events.push(e); };
  voice.open(); phone.start(); await until(() => events.some((e) => e.kind === 'setup'));
  const before = phone.sent.filter((m) => m.event === 'media').length;
  voice.emit({ type: 'response.created', response: { id: 'resp_big', metadata: { id: 'zz' } } });
  voice.emit({ type: 'response.output_audio.delta', response_id: 'resp_big', delta: Buffer.alloc(600_000, 0x7f).toString('base64') });   // 800000 characters
  await pause(60);
  assert.equal(phone.sent.filter((m) => m.event === 'media').length, before + 1, 'a large piece goes through');
  assert.ok(!lines.some((l) => l.code === 'BRIDGE_AUDIO_DROPPED'));
});

test('diagnostics: an error event from the voice service is logged by its type, code and field name only, never its message', async () => {
  const r = rig(); r.voice.open(); await live(r);
  r.voice.emit({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_value', param: 'session.reasoning.effort', message: `bad value ${CANARY} ${FAKE_KEY}` } });
  r.voice.emit({ type: 'error', error: { type: 'Has Spaces!', code: `x ${CANARY}`, param: '<script>', message: CANARY } });
  await until(() => r.find('BRIDGE_VOICE_ERROR').length === 2);
  assert.deepEqual([r.find('BRIDGE_VOICE_ERROR')[0].type, r.find('BRIDGE_VOICE_ERROR')[0].errorCode, r.find('BRIDGE_VOICE_ERROR')[0].param], ['invalid_request_error', 'invalid_value', 'session.reasoning.effort']);
  assert.deepEqual([r.find('BRIDGE_VOICE_ERROR')[1].type, r.find('BRIDGE_VOICE_ERROR')[1].errorCode, r.find('BRIDGE_VOICE_ERROR')[1].param], ['other', 'other', 'other']);
  assert.ok(!JSON.stringify(r.lines).includes(CANARY) && !JSON.stringify(r.lines).includes(FAKE_KEY));
});

test('PRIVACY: a whole call with speech-like text everywhere logs nothing but fixed codes and plain values; no line holds the notice, a transcript, a key or an address', async () => {
  const spoken = `${CANARY} my address is 42 Elm Street and my number is 555 010 0199`;
  const r = rig({ voice: behave({ say: spoken }) });   // the voice "says" something else; its transcript is full of canary text
  r.voice.open(); r.phone.start();
  await until(() => r.end() !== undefined);
  r.voice.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: spoken });
  const all = r.lines.map((l) => `${l.code} ${JSON.stringify(l)}`).join('\n');
  for (const s of [CANARY, 'Elm Street', '555', NOTICE, 'Drew Cleaning', 'Hello', FAKE_KEY, 'wss://', 'relay/', 'sk-']) assert.ok(!all.includes(s), `a line holds: ${s}`);
  for (const l of r.lines) { assert.match(l.code, /^[A-Z][A-Z0-9_]{2,47}$/); for (const v of Object.values(l)) assert.ok(typeof v === 'number' || typeof v === 'boolean' || /^[A-Za-z0-9_.:-]{1,48}$/.test(String(v))); }
});

// ================================================================ the voice socket and the WebSocket server
class FakeWs implements WebSocketLike {
  readyState = 0; bufferedAmount = 0; onopen: ((e: unknown) => void) | null = null; onmessage: ((e: { data: unknown }) => void) | null = null; onclose: ((e: unknown) => void) | null = null; onerror: ((e: unknown) => void) | null = null; closeCalls: Array<number | undefined> = [];
  send(): void {} close(code?: number): void { this.closeCalls.push(code); this.readyState = 3; }
}
test('voice socket: the codes carry the time to open, the close code a remote end sent, and the wait that timed out', async () => {
  const seen: Array<[string, Record<string, unknown>]> = []; const made: FakeWs[] = [];
  const s = createOpenAiVoiceSocket({ model: 'gpt-realtime-test', getKey: () => FAKE_KEY, connectTimeoutMs: 5000, diag: (c, d) => { seen.push([c, d ?? {}]); }, factory: () => { const w = new FakeWs(); made.push(w); return w; } });
  s.onOpen = () => {}; s.onMessage = () => {}; s.onClose = () => {};
  await pause(15); made[0].readyState = 1; made[0].onopen?.({}); await pause(5); made[0].onclose?.({ code: 1011 });
  const open = seen.find(([c]) => c === 'VOICE_OPEN')![1]; const rc = seen.find(([c]) => c === 'VOICE_REMOTE_CLOSE')![1];
  assert.ok((open.connectMs as number) >= 10);
  assert.deepEqual([rc.closeCode, rc.wasOpen], [1011, true]);
  assert.ok(seen.some(([c]) => c === 'VOICE_CLOSED'));
  const t2: Array<[string, Record<string, unknown>]> = [];
  createOpenAiVoiceSocket({ model: 'gpt-realtime-test', getKey: () => FAKE_KEY, connectTimeoutMs: 40, diag: (c, d) => { t2.push([c, d ?? {}]); }, factory: () => new FakeWs() });
  await pause(90);
  assert.deepEqual(t2.find(([c]) => c === 'VOICE_CONNECT_TIMEOUT')![1], { waitMs: 40 });
  const asked: Array<[string, Record<string, unknown>]> = [];
  const s3 = createOpenAiVoiceSocket({ model: 'gpt-realtime-test', getKey: () => FAKE_KEY, diag: (c, d) => { asked.push([c, d ?? {}]); }, factory: () => { const w = new FakeWs(); queueMicrotask(() => { w.readyState = 1; w.onopen?.({}); }); return w; } });
  await pause(10); s3.close(1000);
  assert.deepEqual([asked.find(([c]) => c === 'VOICE_CLOSE_REQUESTED')![1].closeCode, asked.find(([c]) => c === 'VOICE_CLOSE_REQUESTED')![1].wasOpen], [1000, true]);
});

test('WebSocket server: every refused handshake is reported by its HTTP status only (no header, path or address), so a call that never got in shows up in the log', async () => {
  const TOKEN = 'test-auth-token-0123456789'; const PATH = '/relay/q7Zr2KfX9mWc4TbV8nHs1LpD6yGe3AuJ5oRi0NxE'; const URL_WSS = `wss://tunnel.example.test${PATH}`;
  const refused: number[] = []; let connections = 0;
  const server = createRelayWsServer({ path: PATH, authToken: TOKEN, urls: signedUrlCandidates(URL_WSS), maxConnections: 2, onConnection: () => { connections++; }, onRefuse: (s) => { refused.push(s); } } as never);
  const port = await server.listen(0);
  try {
    await connectRelay({ port, token: TOKEN, url: URL_WSS, path: PATH, signature: null });
    await connectRelay({ port, token: TOKEN, url: URL_WSS, path: PATH, signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=' });
    await connectRelay({ port, token: TOKEN, url: URL_WSS, path: '/relay/wrongwrongwrongwrongwrongwrongwrongwrong' });
    const ok = await connectRelay({ port, token: TOKEN, url: URL_WSS, path: PATH });
    assert.equal(ok.status, 101); ok.end();
    assert.deepEqual(refused.sort(), [403, 403, 404]);
    assert.equal(connections, 1);
  } finally { await server.close(); }
  const throwing = createRelayWsServer({ path: PATH, authToken: TOKEN, urls: [URL_WSS], onConnection: () => {}, onRefuse: () => { throw new Error('log failed'); } } as never);
  const p2 = await throwing.listen(0);
  try { const r = await connectRelay({ port: p2, token: TOKEN, url: URL_WSS, path: PATH, signature: null }); assert.notEqual(r.status, 101, 'a failing log never lets a bad handshake in'); } finally { await throwing.close(); }
});

// ================================================================ the command line and the log file
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
test('entry: serve mode prints no digest and no TwiML (so no console filter is needed), the dry run still does, and the diagnostics go to a git-ignored file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'diag-entry-')); dirs.push(dir);
  const example = JSON.parse(readFileSync(new URL('../examples/founder-call.config.example.json', import.meta.url), 'utf8'));
  const exampleVoice = JSON.parse(readFileSync(new URL('../examples/founder-voice.config.example.json', import.meta.url), 'utf8'));
  const SECRET = 'q7Zr2KfX9mWc4TbV8nHs1LpD6yGe3AuJ5oRi0NxE';
  const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  writeFileSync(join(dir, 'c.json'), JSON.stringify({ ...example, public_wss_url: `wss://tunnel.founder-demo.net/relay/${SECRET}`, numbers: ['+15125553377'], expires: soon, kill_file: 'stop', db_path: 'calls.sqlite' }));
  writeFileSync(join(dir, 'v.json'), JSON.stringify({ ...exampleVoice, openai_model: 'gpt-test-model', realtime_model: 'realtime-test-model', transcription_model: 'gpt-live-transcribe', voice: 'test-voice' }));
  const base: Record<string, string> = { PATH: process.env.PATH ?? '' }; if (process.env.SystemRoot) base.SystemRoot = process.env.SystemRoot;
  const run = (args: string[]) => spawnSync(process.execPath, [join(ROOT, 'src', 'founder-voice-entry.ts'), ...args, '--config', 'c.json', '--voice-config', 'v.json'], { cwd: dir, env: base, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const dry = run([]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(/[0-9a-f]{64}/.test(dry.stdout) && dry.stdout.includes('<Stream url="wss://'), 'the dry run shows the digests and the TwiML (that is its job)');
  const serve = run(['--serve']);   // refused (no approvals), but its summary is what matters here
  assert.equal(serve.status, 78);
  assert.ok(!/[0-9a-f]{64}/.test(serve.stdout) && !serve.stdout.includes('<Stream') && !serve.stdout.includes(SECRET) && !serve.stdout.includes('wss://'), 'serve mode prints no digest, no TwiML and no address');
  assert.ok(serve.stdout.includes('nothing secret is printed here'));
  const src = readFileSync(new URL('../src/founder-voice-entry.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(/DIAG_FILE = 'founder-voice\.log'/.test(src) && /appendFileSync\(DIAG_FILE/.test(src), 'one file, appended to');
  assert.equal([...src.matchAll(/appendFileSync\(/g)].length, 1, 'the only thing the entry writes is that log');
  assert.ok(!/writeFileSync|createWriteStream|writeFile\(/.test(src));
  const ignore = readFileSync(new URL('../../../.gitignore', import.meta.url), 'utf8').split(/\r?\n/);
  assert.ok(ignore.includes('*.log'), 'founder-voice.log is covered by the *.log rule');
});
