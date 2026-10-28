// The OpenAI connection check (src/voice-check.ts, src/founder-voice-check.ts, src/hidden-prompt.ts, src/drew-test-opening.ts), tested with MOCKED services: a mocked text API, a mocked Realtime connection backed by the
// wire-level voice stand-in, and a fake terminal for the private key entry. No network, no real key; every key here is an invented string. The command line is run as a child process in PLAN mode and in refused-spend
// modes only. A passing test shows behaviour against the mocks, not against OpenAI. Run: npm test
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECK_LIMITS, planCheck, runCheck } from '../src/voice-check.ts';
import type { CheckPlan } from '../src/voice-check.ts';
import { DREW_TEST_OPENING, DREW_TEST_SPECIAL } from '../src/drew-test-opening.ts';
import { consentNoticeFor, openingProblems } from '../src/opening.ts';
import { looksLikeKey, normalizeKeyEntry, PASTE_HINT, readSecret } from '../src/hidden-prompt.ts';
import { createOpenAiVoiceSocket } from '../src/openai-voice-socket.ts';
import type { WebSocketLike } from '../src/openai-voice-socket.ts';
import { createOpenAIHttpClient } from '../src/openai-http-client.ts';
import type { FounderVoiceConfig } from '../src/founder-voice-gate.ts';
import type { VoiceSocket } from '../src/realtime-bridge.ts';
import { createWireVoice } from './helpers/realtime-wire-sim.ts';
import type { Behaviour, WireVoice } from './helpers/realtime-wire-sim.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FAKE_KEY = 'sk-test-not-a-real-key-0123456789';
const CANARY = 'canary-value-3317';
const exampleVoice = JSON.parse(readFileSync(new URL('../examples/founder-voice.config.example.json', import.meta.url), 'utf8'));
const voiceConfig = (over: Record<string, unknown> = {}): FounderVoiceConfig => ({ ...exampleVoice, openai_model: 'gpt-6-luna', realtime_model: 'gpt-realtime-2.1', transcription_model: 'gpt-transcribe', voice: 'marin', ...over });
const planOf = (v: FounderVoiceConfig = voiceConfig(), opening: unknown = DREW_TEST_OPENING): CheckPlan => { const p = planCheck(v, opening); assert.ok(p.ok, JSON.stringify(p)); return (p as { plan: CheckPlan }).plan; };
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ================================================================ the opening, and the "$25" special
test('opening: the proposed Drew test opening keeps the approved special word for word, once, after the introduction and before the disclosure', () => {
  assert.equal(DREW_TEST_SPECIAL, '$25 off a qualifying first standard cleaning');
  assert.deepEqual(openingProblems(DREW_TEST_OPENING), []);
  const n = consentNoticeFor(DREW_TEST_OPENING);
  assert.equal(n.split(DREW_TEST_SPECIAL).length, 2, 'once, verbatim');
  assert.ok(n.indexOf('Drew Cleaning') < n.indexOf(DREW_TEST_SPECIAL) && n.indexOf(DREW_TEST_SPECIAL) < n.indexOf('OpenAI') && n.indexOf('OpenAI') < n.indexOf('Please say yes to continue'));
  assert.ok(n.endsWith('Please say yes to continue, or hang up now.'));
});

test('opening: the disclosure names OpenAI, says what is true of this route, and does not repeat the old claims that are untrue for it', () => {
  const d = DREW_TEST_OPENING.disclosure as string;
  assert.ok(/made-up details only/.test(d) && /test line/.test(d), 'it is the invented-details test');
  assert.ok(/OpenAI/.test(d) && /hears and transcribes/.test(d) && /thirty days/.test(d) && /do not record/.test(d));
  assert.ok(!/phone provider/i.test(d) && !/masked/i.test(d), 'no claim that the phone provider transcribes or that details are masked before a model reads them');
  assert.ok(!/real customer|customers/i.test(d));
});

// ================================================================ the plan and the spending ceiling
test('plan: the notice, the settings and a ceiling are computed before anything is sent, and an unknown model has no ceiling and no run', () => {
  const full = planOf();
  assert.equal(full.notice, consentNoticeFor(DREW_TEST_OPENING));
  assert.ok(full.notice.includes('$25 off a qualifying first standard cleaning'));
  assert.deepEqual(full.models, { text: 'gpt-6-luna', realtime: 'gpt-realtime-2.1', transcription: 'gpt-transcribe', voice: 'marin' });
  assert.deepEqual(full.settings, { realtimeReasoning: 'minimal', textReasoning: 'none', hints: '1 language(s), 1 keyword(s)' });
  assert.ok(full.noticeSeconds >= 20 && full.noticeSeconds <= 30);
  assert.equal(full.ceilingUsd, 0.14, JSON.stringify(full.breakdown));
  const mini = planOf(voiceConfig({ realtime_model: 'gpt-realtime-2.1-mini' }));
  assert.equal(mini.ceilingUsd, 0.04);
  assert.ok(mini.ceilingUsd < full.ceilingUsd);
  const noPrice = planCheck(voiceConfig({ realtime_model: 'gpt-realtime-9' }), DREW_TEST_OPENING);
  assert.ok(!noPrice.ok && (noPrice as { problems: string[] }).problems.some((p) => /no price is on file for the Realtime model/.test(p)));
  const noText = planCheck(voiceConfig({ openai_model: 'gpt-unknown-model' }), DREW_TEST_OPENING);
  assert.ok(!noText.ok && (noText as { problems: string[] }).problems.some((p) => /text model/.test(p)));
  assert.ok(CHECK_LIMITS.maxSpeechRequests === 3 && CHECK_LIMITS.maxTextRequests === 2 && CHECK_LIMITS.maxSeconds === 75);
});

test('plan: an invalid voice config or opening is refused with fixed text that echoes nothing', () => {
  for (const [v, o] of [[voiceConfig({ openai_model: `claude-${CANARY}` }), DREW_TEST_OPENING], [exampleVoice, DREW_TEST_OPENING], [voiceConfig(), { business_name: 'D' }], [voiceConfig(), { business_name: 'Drew Cleaning', special: `<${CANARY}>` }], [voiceConfig(), null]] as Array<[unknown, unknown]>) {
    const p = planCheck(v, o);
    assert.ok(!p.ok);
    for (const m of (p as { problems: string[] }).problems) assert.ok(!m.includes(CANARY), m);
  }
});

// ================================================================ the run, against mocks
function mockText(over: { status?: number; empty?: boolean } = {}) {
  const seen: any[] = [];
  const answer = (text: string) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 300, output_tokens: 20 } });
  const fetch = (async (_u: string, init: RequestInit) => {
    const params = JSON.parse(String(init.body)); seen.push(params);
    if (over.status !== undefined) return new Response(JSON.stringify({ error: { message: CANARY } }), { status: over.status });
    if (over.empty) return new Response(JSON.stringify(answer('')), { status: 200 });
    if (params.text?.format) return new Response(JSON.stringify(answer(JSON.stringify({ category: 'Standard cleaning', confidence: 0.9 }))), { status: 200 });
    return new Response(JSON.stringify(answer('Hello, how can I help you today?')), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { client: createOpenAIHttpClient({ getKey: () => FAKE_KEY, fetch }), seen };
}
function wsOver(v: WireVoice): WebSocketLike {
  const ws: WebSocketLike = { readyState: 0, bufferedAmount: 0, onopen: null, onmessage: null, onclose: null, onerror: null, send: (d: string) => { if (!v.send(d)) throw new Error('refused'); }, close: (c?: number) => { ws.readyState = 3; v.close(c); } };
  v.onMessage = (t: string) => { ws.onmessage?.({ data: t }); };
  v.onClose = () => { ws.onclose?.({}); };
  setTimeout(() => { ws.readyState = 1; v.open(); ws.onopen?.({}); }, 0);
  return ws;
}
function mockVoice(o: { behave?: (text: string, n: number) => Behaviour; accept?: () => boolean } = {}) {
  const wires: WireVoice[] = []; const handshakes: Array<{ url: string; headers: Record<string, string> }> = [];
  const socket = createOpenAiVoiceSocket({
    model: 'gpt-realtime-2.1', getKey: () => FAKE_KEY, connectTimeoutMs: 3000,
    factory: (url, init) => { handshakes.push({ url, headers: init.headers }); const v = createWireVoice({ msPerChar: 1, autoOpen: false, behave: o.behave ?? ((_t, n) => (n === 1 ? 'currency' : 'exact')), accept: o.accept }); wires.push(v); return wsOver(v); },
  });
  return { socket, wires, handshakes };
}

test('run: against healthy mocks every check passes, the "$25" greeting is verified in its spoken form, and the spend is within the ceiling', async () => {
  const plan = planOf(); const text = mockText(); const voice = mockVoice();
  const report = await runCheck({ plan, voice: voiceConfig(), textClient: text.client, voiceSocket: voice.socket, now: () => Date.now() });
  assert.deepEqual(report.checks.map((c) => [c.name, c.ok]), [['text_structured', true], ['text_wording', true], ['session_accepted', true], ['notice_verified', true], ['speech_verified', true], ['cancel_by_id', true], ['audio_flowed', true], ['cleanup', true]], JSON.stringify(report.checks));
  const notice = report.checks.find((c) => c.name === 'notice_verified')!;
  assert.deepEqual([notice.detail?.transcriptMatchesExactly, notice.detail?.transcriptMatchesSpokenForm, notice.detail?.specialIncluded], [false, true, true], 'said as "twenty-five dollars", accepted as the same words as "$25"');
  assert.ok(report.allPassed && report.withinCeiling);
  assert.deepEqual([report.counts.speechRequests, report.counts.textRequests, report.counts.blockedSends], [3, 2, 0]);
  assert.ok(report.counts.audioFrames > 0 && report.counts.audioMs > 0);
  assert.ok(report.estimatedUsd > 0 && report.estimatedUsd <= report.ceilingUsd, `${report.estimatedUsd} vs ${report.ceilingUsd}`);
  // The wire carried the real settings, with no caller audio and nothing the documented schema would refuse.
  const w = voice.wires[0];
  assert.equal(w.appended(), 0, 'no caller audio was ever sent');
  assert.deepEqual(w.refused, []);
  const sent = w.received;
  assert.equal(sent.filter((m) => m.type === 'response.create').length, 3);
  assert.equal(sent.find((m) => m.type === 'session.update').session.reasoning.effort, 'minimal');
  assert.deepEqual(sent.find((m) => m.type === 'session.update').session.audio.input.transcription, { model: 'gpt-transcribe', languages: ['en'], keywords: ['Drew Cleaning'] });
  const cancel = sent.find((m) => m.type === 'response.cancel');
  assert.deepEqual([typeof cancel.response_id, cancel.event_id], ['string', 'check-cancel-1']);
  assert.equal(voice.handshakes.length, 1);
  assert.equal(voice.handshakes[0].url, 'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1');
  assert.ok(text.seen.every((p) => p.store === false && p.reasoning.effort === 'none'));
  // The report holds fixed codes, numbers and booleans only: no key, no caller-like text, no greeting.
  const out = JSON.stringify(report);
  for (const s of [FAKE_KEY, 'Drew Cleaning', 'burst', '[PERSON_1]', 'two bedroom', 'OpenAI', 'qualifying']) assert.ok(!out.includes(s), `the report holds: ${s}`);
});

test('run: a connection that opens while the text requests are still running does not lose its open event (the defect behind the first paid check CONNECTION_FAILED)', async () => {
  const slowFetch = (async (_u: string, init: RequestInit) => {
    await new Promise((r) => setTimeout(r, 150));   // real text requests take seconds; the connection opens long before the bridge exists
    const params = JSON.parse(String(init.body));
    const answer = (text: string) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 300, output_tokens: 20 } });
    return new Response(JSON.stringify(params.text?.format ? answer(JSON.stringify({ category: 'Standard cleaning', confidence: 0.9 })) : answer('Hello, how can I help you today?')), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const voice = mockVoice();                          // the socket is created now and opens within a few milliseconds
  const report = await runCheck({ plan: planOf(), voice: voiceConfig(), textClient: createOpenAIHttpClient({ getKey: () => FAKE_KEY, fetch: slowFetch }), voiceSocket: voice.socket, now: () => Date.now() });
  assert.deepEqual(report.checks.map((c) => [c.name, c.ok]), [['text_structured', true], ['text_wording', true], ['session_accepted', true], ['notice_verified', true], ['speech_verified', true], ['cancel_by_id', true], ['audio_flowed', true], ['cleanup', true]], JSON.stringify(report.checks));
  assert.ok(report.allPassed);
});

test('run: a notice the voice reads in other words fails the check rather than passing it, and nothing further is spoken', async () => {
  for (const behave of [(_t: string, n: number): Behaviour => (n === 1 ? { say: 'Hi, how can I help you today?' } : 'exact'), (_t: string, n: number): Behaviour => (n === 1 ? 'fail' : 'exact'), (_t: string, n: number): Behaviour => (n === 1 ? 'silent' : 'exact')]) {
    const voice = mockVoice({ behave });
    const report = await runCheck({ plan: planOf(), voice: voiceConfig(), textClient: mockText().client, voiceSocket: voice.socket, now: () => Date.now(), maxMs: 8000 });
    assert.ok(!report.allPassed);
    assert.equal(report.checks.find((c) => c.name === 'notice_verified')!.ok, false);
    assert.deepEqual(report.checks.filter((c) => c.name === 'speech_verified' || c.name === 'cancel_by_id').map((c) => c.code), ['NOT_RUN', 'NOT_RUN']);
    assert.equal(report.counts.speechRequests, 1, 'no further line was requested once the notice failed');
  }
});

test('run: a session setting the service rejects is reported by the names of its error type, code and field, never its message', async () => {
  let socketOnMessage: ((t: string) => void) | undefined;
  const sent: any[] = [];
  const rejecting: VoiceSocket = {
    send(t: string) { const m = JSON.parse(t); sent.push(m); if (m.type === 'session.update') setTimeout(() => socketOnMessage?.(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_value', param: 'session.reasoning.effort', message: `bad ${CANARY} ${FAKE_KEY}` } })), 0); return true; },
    close() {}, onOpen: () => {}, onClose: () => {},
    get onMessage() { return socketOnMessage ?? (() => {}); }, set onMessage(fn: (t: string) => void) { socketOnMessage = fn; },
  } as VoiceSocket;
  setTimeout(() => rejecting.onOpen(), 0);
  const report = await runCheck({ plan: planOf(), voice: voiceConfig(), textClient: mockText().client, voiceSocket: rejecting, now: () => Date.now(), maxMs: 4000 });
  const s = report.checks.find((c) => c.name === 'session_accepted')!;
  assert.deepEqual([s.ok, s.code, s.detail], [false, 'SESSION_REJECTED', { errorType: 'invalid_request_error', errorCode: 'invalid_value', errorParam: 'session.reasoning.effort' }]);
  const out = JSON.stringify(report);
  assert.ok(!out.includes(CANARY) && !out.includes(FAKE_KEY));
  assert.ok(sent.filter((m) => m.type === 'response.create').length <= 1);
});

test('run: a connection that is refused or never answers ends within the wall-clock limit with clear codes, cleaned up', async () => {
  const refused = mockVoice({ accept: () => false });
  const a = await runCheck({ plan: planOf(), voice: voiceConfig(), textClient: mockText().client, voiceSocket: refused.socket, now: () => Date.now(), maxMs: 5000 });
  assert.ok(!a.allPassed && !a.checks.find((c) => c.name === 'notice_verified')!.ok);
  const slow = Date.now();
  const never: VoiceSocket = { send: () => true, close() {}, onOpen: () => {}, onMessage: () => {}, onClose: () => {} };
  const b = await runCheck({ plan: planOf(), voice: voiceConfig(), textClient: mockText().client, voiceSocket: never, now: () => Date.now(), maxMs: 300 });
  assert.ok(Date.now() - slow < 3000, 'bounded by the limit, not by the service');
  assert.deepEqual([b.allPassed, b.checks.find((c) => c.name === 'session_accepted')!.code], [false, 'CONNECTION_FAILED']);
  assert.equal(b.counts.speechRequests, 0);
});

test('run: text failures are reported without the provider\'s message, and the voice part still runs', async () => {
  for (const t of [mockText({ status: 401 }), mockText({ status: 429 }), mockText({ empty: true })]) {
    const report = await runCheck({ plan: planOf(), voice: voiceConfig(), textClient: t.client, voiceSocket: mockVoice().socket, now: () => Date.now() });
    assert.equal(report.checks.find((c) => c.name === 'text_structured')!.ok, false);
    assert.equal(report.checks.find((c) => c.name === 'text_wording')!.ok, false);
    assert.equal(report.checks.find((c) => c.name === 'notice_verified')!.ok, true);
    assert.ok(!JSON.stringify(report).includes(CANARY));
    assert.ok(t.seen.length <= CHECK_LIMITS.maxTextRequests);
  }
});

// ================================================================ the private key entry
class FakeTty {
  isTTY = true; raw: boolean[] = []; resumed = 0; paused = 0; listeners: Array<(c: Buffer | string) => void> = [];
  setRawMode(on: boolean) { this.raw.push(on); }
  resume() { this.resumed++; } pause() { this.paused++; }
  on(_e: 'data', l: (c: Buffer | string) => void) { this.listeners.push(l); }
  removeListener(_e: 'data', l: (c: Buffer | string) => void) { this.listeners = this.listeners.filter((x) => x !== l); }
  send(s: string | Buffer) { for (const l of [...this.listeners]) l(s); }
}
const outputOf = () => { const writes: string[] = []; return { writes, write: (t: string) => { writes.push(t); } }; };
const REAL_SHAPE = 'sk-proj-' + 'Ab3_dE-fGh1.JkLm'.repeat(10);   // an invented key of the shape and length of a real project key (about 160 characters)
const settle = () => new Promise<void>((r) => setImmediate(r));

test('key entry: the key is read without being shown, comes back in memory only, and the terminal is restored', async () => {
  const tty = new FakeTty(); const out = outputOf();
  const p = readSecret(tty, out, 'Enter the key: ');
  tty.send(FAKE_KEY.slice(0, 10)); tty.send(FAKE_KEY.slice(10) + '\r\n');
  assert.equal(await p, FAKE_KEY);
  assert.deepEqual(out.writes, ['Enter the key: ', '\n'], 'only the prompt and a line break are ever written');
  assert.ok(!out.writes.join('').includes(FAKE_KEY.slice(0, 6)));
  assert.deepEqual(tty.raw, [true, false]);
  assert.deepEqual([tty.resumed, tty.paused, tty.listeners.length], [1, 1, 0]);
  tty.send('more'); // nothing listens any more
});

test('key entry: a stray Enter left over from the previous prompt is not an answer (the likely cause of "no usable key" on Windows), and a hint is written once', async () => {
  for (const stray of ['\n', '\r', '\r\n', '\n\n']) {
    const tty = new FakeTty(); const out = outputOf();
    const p = readSecret(tty, out, '> ');
    tty.send(stray);                       // the Enter that ended the confirmation, arriving late
    await settle();
    tty.send(REAL_SHAPE + '\r');
    assert.equal(await p, REAL_SHAPE, JSON.stringify(stray));
    assert.deepEqual(out.writes.filter((w) => w !== '> ' && w !== '\n'), [PASTE_HINT], 'one fixed hint, no secret');
  }
  const t = new FakeTty(); const pending = readSecret(t, outputOf(), '> ');
  t.send('\r'); t.send('\r'); t.send('\r');
  let settled = false; void pending.then(() => { settled = true; });
  await settle();
  assert.equal(settled, false, 'Enter on an empty entry never ends the prompt');
  t.send('\u0003');
  assert.equal(await pending, undefined);
});

test('key entry: a paste in one chunk, with line ends, bracketed-paste markers, or one character at a time, all come back as the same key', async () => {
  const cases: Array<[string, string[]]> = [
    ['one chunk then CRLF', [REAL_SHAPE + '\r\n']], ['one chunk with LF', [REAL_SHAPE + '\n']], ['CR only', [REAL_SHAPE + '\r']],
    ['bracketed paste', ['\u001b[200~' + REAL_SHAPE + '\u001b[201~\r']], ['bracketed paste in pieces', ['\u001b[20', '0~', REAL_SHAPE.slice(0, 50), REAL_SHAPE.slice(50), '\u001b[201~', '\r']],
    ['leading Enter then paste', ['\r\n', REAL_SHAPE, '\r']], ['character by character', [...REAL_SHAPE, '\r']],
    ['arrow keys in the middle', [REAL_SHAPE.slice(0, 20), '\u001b[D\u001b[C\u001b[A\u001bOA', REAL_SHAPE.slice(20), '\r']],
  ];
  for (const [name, chunks] of cases) {
    const tty = new FakeTty(); const out = outputOf();
    const p = readSecret(tty, out, '> ');
    for (const c of chunks) tty.send(c);
    const got = await p;
    assert.equal(got, REAL_SHAPE, name);
    assert.ok(!out.writes.join('').includes(REAL_SHAPE.slice(10, 20)), `${name}: nothing of the key is written`);
  }
});

test('key entry: Ctrl+V arrives as a control key and pastes nothing, so a hint is written and the entry carries on', async () => {
  const tty = new FakeTty(); const out = outputOf();
  const p = readSecret(tty, out, '> ');
  tty.send('\u0016'); tty.send('\u0016');
  tty.send(FAKE_KEY + '\r');
  assert.equal(await p, FAKE_KEY);
  assert.deepEqual(out.writes.filter((w) => w === PASTE_HINT).length, 1, 'said once');
});

test('key entry: backspace, other control keys and a too-long paste behave; a lone Escape or Ctrl-C cancels and drops what was typed', async () => {
  const a = new FakeTty(); const pa = readSecret(a, outputOf(), '> ');
  a.send('abcXY'); a.send('\u007f\u007f'); a.send('d\u0001\u0002ef\n');
  assert.equal(await pa, 'abcdef');
  const b = new FakeTty(); const pb = readSecret(b, outputOf(), '> ');
  b.send(Buffer.from('x'.repeat(1200) + '\r'));
  assert.equal((await pb)?.length, 1000, 'kept up to 1000 so that a too-long paste is reported as too long');
  for (const cancel of ['\u0003', '\u001b']) {
    const t = new FakeTty(); const out = outputOf();
    const p = readSecret(t, out, '> ');
    t.send(FAKE_KEY.slice(0, 12)); t.send(cancel); t.send(FAKE_KEY.slice(12) + '\r');
    assert.equal(await p, undefined, JSON.stringify(cancel));
    assert.ok(!out.writes.join('').includes(FAKE_KEY.slice(0, 6)));
    assert.deepEqual(t.raw, [true, false]);
  }
});

test('key entry: it works straight after a readline prompt on the same stream, as in the command line (the confirmation, then the key)', async () => {
  const { PassThrough } = await import('node:stream');
  const { createInterface } = await import('node:readline');
  class TtyStream extends PassThrough { isTTY = true; raw: boolean[] = []; setRawMode(on: boolean) { this.raw.push(on); return this; } }
  const input = new TtyStream(); const sink = outputOf();
  const rl = createInterface({ input, output: { write: () => true } as never, terminal: false });
  const typed = await new Promise<string>((resolve) => { rl.question('Type 0.14: ', resolve); input.write('0.14\r\n'); });
  rl.close();
  assert.equal(typed.trim(), '0.14');
  const p = readSecret(input as never, sink, 'Enter the key: ');
  input.write('\n');                                  // a late Enter, as some Windows consoles send after the line
  await settle();
  input.write('  "' + REAL_SHAPE + '"  \r\n');          // pasted with spaces and quotes
  const raw = await p;
  assert.equal(normalizeKeyEntry(raw).key, REAL_SHAPE);
  assert.deepEqual(input.raw, [true, false]);
  assert.ok(!sink.writes.join('').includes(REAL_SHAPE.slice(10, 20)));
});

test('key entry: a paste is cleaned (spaces, quotes, zero-width characters), and a bad entry is reported by its kind and length only, never a character', () => {
  for (const raw of [REAL_SHAPE, ` ${REAL_SHAPE} `, `"${REAL_SHAPE}"`, `'${REAL_SHAPE}'`, `﻿${REAL_SHAPE}`, `${REAL_SHAPE}​`, `  "${REAL_SHAPE}"\r\n`, REAL_SHAPE + '\u0000']) assert.deepEqual(normalizeKeyEntry(raw), { key: REAL_SHAPE, length: REAL_SHAPE.length }, JSON.stringify(raw.slice(0, 12)));
  const bad: Array<[unknown, string, number]> = [['', 'empty', 0], ['   ', 'empty', 0], [undefined, 'empty', 0], [12, 'empty', 0], ['""', 'empty', 0], ['short', 'too_short', 5], ['has a space inside the key 123', 'bad_characters', 30], ['sk-proj-ab/cd+ef=gh1234', 'bad_characters', 23], ['x'.repeat(301), 'too_long', 301], [`sk-${CANARY}%`, 'bad_characters', 3 + CANARY.length + 1]];
  for (const [raw, problem, length] of bad) {
    const r = normalizeKeyEntry(raw);
    assert.deepEqual([r.key, r.problem, r.length], [undefined, problem, length], String(raw).slice(0, 12));
    assert.ok(!JSON.stringify(r).includes(CANARY) && !JSON.stringify(r).includes('inside'), 'no character of the entry is reported');
  }
  assert.deepEqual([looksLikeKey(REAL_SHAPE), looksLikeKey('short'), looksLikeKey('has space in it 12345'), looksLikeKey('x'.repeat(301)), looksLikeKey(undefined), looksLikeKey(5)], [true, false, false, false, false, false]);
});

test('key entry: with no interactive terminal nothing is read, so a key cannot be piped in', async () => {
  const t = new FakeTty(); t.isTTY = false;
  assert.equal(await readSecret(t, outputOf(), '> '), undefined);
  assert.deepEqual([t.raw, t.listeners.length, t.resumed], [[], 0, 0]);
  const noRaw = new FakeTty() as unknown as Record<string, unknown>; noRaw.setRawMode = undefined;
  assert.equal(await readSecret(noRaw as never, outputOf(), '> '), undefined);
});

// ================================================================ the command line (plan mode and refused spends only)
const dirs: string[] = [];
function files(over: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(ROOT, '.check-test-'));
  dirs.push(dir);
  const vp = join(dir, 'voice.json'); const cp = join(dir, 'call.json');
  writeFileSync(vp, JSON.stringify(voiceConfig(over)));
  writeFileSync(cp, JSON.stringify({ opening: DREW_TEST_OPENING }));
  const rel = (p: string) => relative(ROOT, p).replace(/\\/g, '/');
  return { vp: rel(vp), cp: rel(cp), dir };
}
function run(args: string[], env: Record<string, string> = {}) {
  const base: Record<string, string> = { PATH: process.env.PATH ?? '' };
  if (process.env.SystemRoot) base.SystemRoot = process.env.SystemRoot;
  return spawnSync(process.execPath, ['src/founder-voice-check.ts', ...args], { cwd: ROOT, env: { ...base, ...env }, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
}
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test('command line: plan mode prints the notice with the special, the ceiling and what it can and cannot prove, and sends and reads nothing', () => {
  const f = files();
  const r = run(['--voice-config', f.vp], { OPENAI_API_KEY: FAKE_KEY });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('PLAN ONLY') && r.stdout.includes('Nothing was sent'));
  assert.equal(r.stdout.split(DREW_TEST_SPECIAL).length, 2, 'the special appears once, in the notice');
  assert.ok(/Spending ceiling: \$0\.14/.test(r.stdout) && /Can prove:/.test(r.stdout) && /Cannot prove:/.test(r.stdout) && /--max-usd 0\.14/.test(r.stdout));
  assert.ok(r.stdout.includes('proposed Drew test opening'));
  assert.ok(!r.stdout.includes(FAKE_KEY) && !r.stderr.includes(FAKE_KEY), 'a key in the environment is neither used nor printed in plan mode');
  const fromCall = run(['--voice-config', f.vp, '--config', f.cp]);
  assert.equal(fromCall.status, 0, fromCall.stderr);
  assert.ok(fromCall.stdout.includes('the opening block of the call config'));
});

test('command line: a spend is refused without a limit, with a limit below the ceiling or above $1, and without an interactive terminal; none of these reads or prints a key', () => {
  const f = files();
  const env = { OPENAI_API_KEY: FAKE_KEY };
  const cases: Array<[string[], RegExp]> = [
    [['--voice-config', f.vp, '--spend'], /give a spending limit/], [['--voice-config', f.vp, '--spend', '--max-usd', 'abc'], /give a spending limit/], [['--voice-config', f.vp, '--spend', '--max-usd', '0'], /give a spending limit/],
    [['--voice-config', f.vp, '--spend', '--max-usd', '0.05'], /below the computed ceiling/], [['--voice-config', f.vp, '--spend', '--max-usd', '5'], /may not exceed \$1\.00/],
    [['--voice-config', f.vp, '--spend', '--max-usd', '0.20'], /interactive terminal/], [['--voice-config', f.vp, '--spend', '--max-usd', '0.20', '--key-from-env'], /interactive terminal/],
  ];
  for (const [args, msg] of cases) {
    const r = run(args, env);
    assert.equal(r.status, 78, args.join(' '));
    assert.ok(msg.test(r.stderr), `${args.join(' ')}: ${r.stderr}`);
    assert.ok(!r.stdout.includes('Running the check') && !r.stdout.includes(FAKE_KEY) && !r.stderr.includes(FAKE_KEY));
  }
});

test('command line: the free diagnosis is offered in plan mode, needs an interactive terminal and the key, cannot be combined with a spend, and never prints a key', () => {
  const f = files();
  const plan = run(['--voice-config', f.vp]);
  assert.ok(plan.stdout.includes('--diagnose') && plan.stdout.includes('no speech and no text request'));
  const env = { OPENAI_API_KEY: FAKE_KEY };
  const piped = run(['--voice-config', f.vp, '--diagnose'], env);
  assert.equal(piped.status, 78);
  assert.ok(/diagnose refused: this needs an interactive terminal/.test(piped.stderr));
  const fromEnv = run(['--voice-config', f.vp, '--diagnose', '--key-from-env'], env);
  assert.equal(fromEnv.status, 78, 'even with the key in the environment a terminal is required');
  for (const r of [plan, piped, fromEnv]) assert.ok(!r.stdout.includes(FAKE_KEY) && !r.stderr.includes(FAKE_KEY));
  const both = run(['--voice-config', f.vp, '--spend', '--diagnose', '--max-usd', '0.20'], env);
  assert.equal(both.status, 64);
  assert.ok(/not both/.test(both.stderr));
});

test('command line: bad arguments, unreadable files, invalid configs and models with no price stop with their own codes and echo nothing', () => {
  const f = files();
  assert.equal(run(['--voice-config', f.vp, '--bogus']).status, 64);
  assert.equal(run(['--voice-config', '../x.json']).status, 64);
  assert.equal(run(['--voice-config', 'does-not-exist.json']).status, 66);
  const bad = files({ openai_model: `claude-${CANARY}` });
  const r = run(['--voice-config', bad.vp]);
  assert.equal(r.status, 65);
  assert.ok(!r.stderr.includes(CANARY) && !r.stdout.includes(CANARY));
  const noPrice = run(['--voice-config', files({ realtime_model: 'gpt-realtime-9' }).vp]);
  assert.equal(noPrice.status, 65);
  assert.ok(/no price is on file/.test(noPrice.stderr));
});

// ================================================================ static guards
test('static: the check logic reads no environment and logs nothing; only the command line holds the key, and it never prints, writes or exports it', () => {
  const code = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const f of ['voice-check.ts', 'hidden-prompt.ts', 'drew-test-opening.ts']) for (const bad of [/process\./, /console\./, /\bfetch\s*\(/, /node:/, /require\s*\(/, /\beval\s*\(/]) assert.ok(!bad.test(code(f)), `${f}: ${bad}`);
  const cli = code('founder-voice-check.ts');
  assert.equal([...cli.matchAll(/process\.env\.OPENAI_API_KEY/g)].length, 1, 'the environment key is read in exactly one place, behind --key-from-env');
  assert.ok(!/process\.env\.\w+\s*=[^=]/.test(cli), 'nothing is exported to the environment');
  assert.ok(!/console\.\w+\([^)]*(\$\{\s*key\b|\+\s*key\b|,\s*key\s*\))/.test(cli) && !/\$\{key\}/.test(cli), 'the key variable is never put in a message');
  assert.ok(!/writeFile|appendFile|createWriteStream/.test(cli), 'nothing is written to a file');
  assert.ok(!/argv[^;]*key/i.test(cli.replace(/--key-from-env/g, '')), 'the key is not taken from the command line');
  for (const f of readdirSync(new URL('../src/', import.meta.url)).filter((n) => n.endsWith('.ts') && n !== 'voice-check.ts')) assert.equal(/\bvoice-check\b/.test(code(f).replace(/founder-voice-check/g, '')), f === 'founder-voice-check.ts', `${f}: only the command line may use the check`);
  for (const f of readdirSync(new URL('../src/', import.meta.url)).filter((n) => n.endsWith('.ts') && n !== 'hidden-prompt.ts')) assert.equal(/hidden-prompt/.test(code(f)), f === 'founder-voice-check.ts', `${f}: only the command line may read a secret privately`);
});
