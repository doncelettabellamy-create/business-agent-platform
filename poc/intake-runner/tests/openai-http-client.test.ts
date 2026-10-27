// The OpenAI Responses HTTP client (src/openai-http-client.ts) and the OpenAI dialogue model (src/openai-dialogue-model.ts), tested with a MOCKED fetch and a mocked client: no network, no real key. Every key here is an
// invented string. A passing test shows behaviour against the mocks, not against OpenAI. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createOpenAIHttpClient, OpenAIHttpError, RESPONSES_URL } from '../src/openai-http-client.ts';
import { createOpenAIProvider } from '../src/openai-provider.ts';
import { buildOpenAIDialogueParams, createOpenAIDialogueModel } from '../src/openai-dialogue-model.ts';
import { DIALOGUE_INSTRUCTION, renderDirective, toMessages } from '../src/dialogue-model.ts';
import { createPersona, dialogueStyle } from '../src/persona.ts';
import type { Directive } from '../src/dialogue-model.ts';

const FAKE_KEY = 'sk-test-not-a-real-key-0123456789';
const CANARY = 'canary-echo-8842';
const drew = createPersona(JSON.parse(readFileSync(new URL('../examples/persona-drew-cleaning.json', import.meta.url), 'utf8')));
const answer = (text: string) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 10, output_tokens: 5 } });
interface Seen { url: string; init: RequestInit }
function mockFetch(respond: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetch = (async (url: string, init: RequestInit) => { const s = { url, init }; seen.push(s); return respond(s); }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// ================================================================ the HTTP client
test('http: the key goes only into the Authorization header, to OpenAI\'s fixed address, with the request as the body', async () => {
  const m = mockFetch(() => json(answer('hello')));
  let reads = 0;
  const client = createOpenAIHttpClient({ getKey: () => { reads++; return FAKE_KEY; }, fetch: m.fetch });
  const params = { model: 'gpt-test', input: 'masked text only', store: false };
  const out = await client.responses.create(params);
  assert.equal(out.status, 'completed');
  assert.equal(m.seen.length, 1);
  assert.equal(m.seen[0].url, RESPONSES_URL);
  assert.equal(RESPONSES_URL, 'https://api.openai.com/v1/responses');
  const init = m.seen[0].init;
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error', 'a redirect cannot carry the key elsewhere');
  assert.deepEqual(init.headers, { Authorization: `Bearer ${FAKE_KEY}`, 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(String(init.body)), params);
  assert.ok(!String(init.body).includes(FAKE_KEY) && !m.seen[0].url.includes(FAKE_KEY));
  assert.equal(reads, 1, 'read once per request');
  await client.responses.create(params);
  assert.equal(reads, 2, 'and again for the next request, never kept');
});

test('http: no usable key means no request at all, and nothing about the key travels in the error', async () => {
  for (const k of [undefined, '', 'short', 'has a space in it 0123', 'line\r\nbreak-0123456789', 'x'.repeat(301), 12 as never]) {
    const m = mockFetch(() => json(answer('x')));
    const client = createOpenAIHttpClient({ getKey: () => k, fetch: m.fetch });
    await assert.rejects(() => client.responses.create({}), (e: unknown) => e instanceof OpenAIHttpError && (e as OpenAIHttpError).status === undefined);
    assert.equal(m.seen.length, 0, String(k).slice(0, 8));
  }
  const m = mockFetch(() => json(answer('x')));
  await assert.rejects(() => createOpenAIHttpClient({ getKey: () => { throw new Error('vault locked'); }, fetch: m.fetch }).responses.create({}), OpenAIHttpError);
  assert.equal(m.seen.length, 0);
});

test('http: a refusal carries its status and nothing else; the body and the provider\'s message never travel', async () => {
  for (const status of [400, 401, 429, 500, 503]) {
    const m = mockFetch(() => new Response(JSON.stringify({ error: { message: `bad request echoing ${CANARY} and ${FAKE_KEY}` } }), { status }));
    const client = createOpenAIHttpClient({ getKey: () => FAKE_KEY, fetch: m.fetch });
    await assert.rejects(() => client.responses.create({ input: CANARY }), (e: unknown) => {
      const err = e as OpenAIHttpError;
      return err instanceof OpenAIHttpError && err.status === status && err.constructor.name === 'OpenAIHttpError' && !String(err.message + err.stack).includes(CANARY) && !String(err.message + err.stack).includes(FAKE_KEY);
    }, String(status));
  }
});

test('http: a transport failure, an unreadable answer, an answer that is not an object and an oversize answer are all plain failures', async () => {
  const boom = mockFetch(() => { throw new Error(`connect failed ${FAKE_KEY}`); });
  await assert.rejects(() => createOpenAIHttpClient({ getKey: () => FAKE_KEY, fetch: boom.fetch }).responses.create({}), (e: unknown) => e instanceof OpenAIHttpError && !String((e as Error).message + (e as Error).stack).includes(FAKE_KEY));
  for (const body of ['not json', '[1,2]', '"text"', 'null']) {
    const m = mockFetch(() => new Response(body, { status: 200 }));
    await assert.rejects(() => createOpenAIHttpClient({ getKey: () => FAKE_KEY, fetch: m.fetch }).responses.create({}), OpenAIHttpError, body);
  }
  const big = mockFetch(() => new Response(JSON.stringify({ pad: 'x'.repeat(200) }), { status: 200 }));
  await assert.rejects(() => createOpenAIHttpClient({ getKey: () => FAKE_KEY, fetch: big.fetch, maxResponseChars: 100 }).responses.create({}), OpenAIHttpError);
});

test('http: a request that never answers is cut off by the timeout, and by the caller\'s own signal', async () => {
  const hang = (seen: Seen) => new Promise<Response>((_res, rej) => { (seen.init.signal as AbortSignal).addEventListener('abort', () => rej(new Error('aborted'))); });
  const a = mockFetch(hang);
  await assert.rejects(() => createOpenAIHttpClient({ getKey: () => FAKE_KEY, fetch: a.fetch, timeoutMs: 30 }).responses.create({}), OpenAIHttpError);
  const b = mockFetch(hang);
  const ctl = new AbortController();
  const p = createOpenAIHttpClient({ getKey: () => FAKE_KEY, fetch: b.fetch, timeoutMs: 10_000 }).responses.create({}, { signal: ctl.signal });
  setTimeout(() => ctl.abort(), 20);
  await assert.rejects(() => p, OpenAIHttpError);
});

test('http: options are validated, and under the Intake provider an HTTP refusal is recorded as a class name and status only', async () => {
  for (const bad of [{}, { getKey: 'x' }, { getKey: () => 'k', fetch: 'x' }, { getKey: () => 'k', timeoutMs: 0 }, { getKey: () => 'k', maxResponseChars: 1.5 }]) assert.throws(() => createOpenAIHttpClient(bad as never), RangeError);
  const m = mockFetch(() => json({}, 401));
  const provider = createOpenAIProvider(createOpenAIHttpClient({ getKey: () => FAKE_KEY, fetch: m.fetch }), { model: 'gpt-test' });
  await assert.rejects(() => provider.complete({ task: 'classify_request', instruction: 'x', data: { masked_text: 'x', categories: ['a'] }, output_format: 'json', max_output_tokens: 64 }, new AbortController().signal), /openai request failed/);
  assert.deepEqual(provider.stats.errors, [{ name: 'OpenAIHttpError', status: 401 }]);
});

// ================================================================ the dialogue model
const directives: Directive[] = [{ kind: 'open' }, { kind: 'ask', field: 'Address' }, { kind: 'ask', field: 'Service', choices: ['standard', 'deep'] }, { kind: 'clarify', categories: ['Emergency leak'] }, { kind: 'listen' }];
const turns = [{ role: 'assistant' as const, text: 'How can I help?' }, { role: 'user' as const, text: 'I need [PERSON_1] cleaned' }];

test('dialogue: the request is the fixed instruction, the Drew line, then the NEXT line last, with only the masked conversation', () => {
  for (const d of directives) {
    const p = buildOpenAIDialogueParams({ turns, directive: d }, 'gpt-test', 160, drew);
    assert.equal(p.instructions, `${DIALOGUE_INSTRUCTION}\n${dialogueStyle(drew)}\n${renderDirective(d)}`);
    assert.ok(p.instructions.split('\n').pop()!.startsWith('NEXT'), 'the NEXT line stays last');
    assert.deepEqual(p.input, toMessages(turns));
    assert.deepEqual([p.store, p.max_output_tokens, p.model], [false, 160, 'gpt-test']);
    const plain = buildOpenAIDialogueParams({ turns, directive: d }, 'gpt-test', 160);
    assert.equal(plain.instructions, `${DIALOGUE_INSTRUCTION}\n${renderDirective(d)}`, 'no persona, no extra line');
  }
  assert.equal(buildOpenAIDialogueParams({ turns, directive: { kind: 'open' } }, 'gpt-test', 160, undefined, 'low').reasoning?.effort, 'low');
  assert.ok(!('reasoning' in buildOpenAIDialogueParams({ turns, directive: { kind: 'open' } }, 'gpt-test', 160)));
});

test('dialogue: every documented effort is accepted, including none, and the effort is sent only when given', () => {
  for (const e of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) assert.deepEqual(buildOpenAIDialogueParams({ turns, directive: { kind: 'listen' } }, 'gpt-test', 160, drew, e).reasoning, { effort: e }, e);
  assert.ok(!('reasoning' in buildOpenAIDialogueParams({ turns, directive: { kind: 'listen' } }, 'gpt-test', 160, drew)));
  for (const e of ['', 'extreme', 'NONE', 5]) assert.throws(() => buildOpenAIDialogueParams({ turns, directive: { kind: 'listen' } }, 'gpt-test', 160, drew, e as never), RangeError, String(e));
});

test('dialogue: options are validated up front, and only a persona made by createPersona is accepted', () => {
  const client = { responses: { create: async () => answer('x') } };
  for (const bad of [{ model: 'claude-haiku-5-5' }, { model: '' }, { model: 'gpt-test', maxTokens: 5 }, { model: 'gpt-test', maxTokens: 500 }, { model: 'gpt-test', persona: { business_name: 'Drew Cleaning' } as never }, { model: 'gpt-test', effort: 'extreme' as never }]) {
    assert.throws(() => createOpenAIDialogueModel(client, bad), RangeError, JSON.stringify(bad));
  }
  assert.throws(() => createOpenAIDialogueModel({} as never, { model: 'gpt-test' }), RangeError);
});

test('dialogue: a completed answer is one piece, and the end is recorded in the same fixed words the Claude model uses', async () => {
  const seen: object[] = [];
  const model = createOpenAIDialogueModel({ responses: { create: async (p) => { seen.push(p); return answer('Hello, how can I help you today?'); } } }, { model: 'gpt-test', persona: drew });
  const pieces: string[] = [];
  for await (const t of model.reply({ turns: [], directive: { kind: 'open' } })) pieces.push(t);
  assert.deepEqual(pieces, ['Hello, how can I help you today?']);
  assert.deepEqual([model.stats.calls, model.stats.last], [1, { stop: 'END_TURN', output_tokens: 5, other_blocks: 0 }]);
  assert.equal(seen.length, 1);
});

test('dialogue: a refusal, a filtered or failed answer, and an empty one say nothing; a truncated one says what it has', async () => {
  const run = async (r: unknown) => { const m = createOpenAIDialogueModel({ responses: { create: async () => r as never } }, { model: 'gpt-test' }); const out: string[] = []; for await (const t of m.reply({ turns, directive: { kind: 'listen' } })) out.push(t); return { out, stop: m.stats.last?.stop }; };
  assert.deepEqual(await run({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }), { out: [], stop: 'REFUSAL' });
  assert.deepEqual(await run({ status: 'failed', output: [] }), { out: [], stop: 'OTHER' });
  assert.deepEqual(await run({ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial' }] }] }), { out: [], stop: 'OTHER' });
  assert.deepEqual(await run(answer('   ')), { out: [], stop: 'END_TURN' });
  assert.deepEqual(await run({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Could you tell me the' }] }] }), { out: ['Could you tell me the'], stop: 'MAX_TOKENS' });
  assert.deepEqual(await run(undefined), { out: [], stop: 'OTHER' });
  const long = await run(answer('word '.repeat(300)));
  assert.equal(long.out[0].length, 600);
});

test('dialogue: a failing client is recorded as a class name and status only and thrown as a plain error', async () => {
  const http = createOpenAIHttpClient({ getKey: () => FAKE_KEY, fetch: mockFetch(() => json({ error: CANARY }, 429)).fetch });
  const model = createOpenAIDialogueModel(http, { model: 'gpt-test' });
  await assert.rejects(async () => { for await (const _ of model.reply({ turns, directive: { kind: 'listen' } })) { /* nothing */ } }, (e: unknown) => (e as Error).message === 'dialogue model failed' && !String((e as Error).stack).includes(CANARY));
  assert.deepEqual(model.stats.errors, [{ name: 'OpenAIHttpError', status: 429 }]);
});

// ================================================================ static guards
test('static: the client reads no environment and logs nothing; the dialogue model imports no SDK; only the voice entry builds the real client', () => {
  const code = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const own = code('openai-http-client.ts');
  for (const bad of [/process\./, /console\./, /require\s*\(/, /\beval\s*\(/, /node:/, /@anthropic-ai|from 'openai'/, /localStorage|writeFile|appendFile/]) assert.ok(!bad.test(own), String(bad));
  assert.deepEqual([...own.matchAll(/https?:\/\/[^'"`\s)]+/g)].map((m) => m[0]), ['https://api.openai.com/v1/responses'], 'one address, and it is OpenAI\'s');
  const dlg = code('openai-dialogue-model.ts');
  for (const bad of [/process\./, /console\./, /fetch\s*\(/, /node:/, /@anthropic-ai|from 'openai'/]) assert.ok(!bad.test(dlg), String(bad));
  for (const f of readdirSync(new URL('../src/', import.meta.url)).filter((n) => n.endsWith('.ts') && n !== 'openai-http-client.ts')) assert.equal(/openai-http-client/.test(code(f)), f === 'founder-voice-entry.ts', `${f}: only the voice entry may build the real OpenAI client`);
});
