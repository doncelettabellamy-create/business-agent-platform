// Tests that the live developer path goes through the controlled Intake entry, accepts only reviewed synthetic fixtures,
// and cannot reach the raw runners or choose its own authority. Mock provider only. No SDK, no key, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REVIEWED_FIXTURES, fixtureDigest, reviewedFixtureProblems } from '../src/reviewed-fixtures.ts';
import { runReviewedLive } from '../src/live-run.ts';
import type { LiveRunRequest, LiveRunResult } from '../src/live-run.ts';
import { parseLiveArgs } from '../src/live-gate.ts';
import { classifyAnswer, createMockProvider, extractAnswer } from '../src/mock-provider.ts';

const CANARY = 'CANARY-LIVE-3305';
const CLOCK = '2026-10-25T13:00:00Z';
const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const example = (name: string): Record<string, any> => JSON.parse(read(`examples/${name}`));
const FILES = ['skill-input', 'skill-ambiguous-input', 'skill-plumbing', 'skill-dental'];

const VALUES: Record<string, string> = { 'Field 1': 'Quote request', 'Field 2': '[ID_1]', Address: '[ADDRESS_1]', 'Job description': 'Burst pipe repair', 'Patient reference': '[ID_1]', 'Insurance provider': 'Example Health' };
function provider() {
  return createMockProvider({
    classify_request: (req) => {
      const c = req.data.categories ?? [];
      return classifyAnswer(c.includes('Emergency leak') ? 'Emergency leak' : c.includes('New patient') ? 'New patient' : 'Category B', 0.9);
    },
    extract_fields: (req) => extractAnswer((req.data.fields ?? []).map((f) => ({ name: f.name, value: VALUES[f.name] ?? null, confidence: VALUES[f.name] ? 0.9 : null }))),
  });
}
const request = (over: Partial<LiveRunRequest> = {}, file = 'skill-input'): LiveRunRequest & { provider: ReturnType<typeof provider> } => ({
  path: `examples/${file}.json`, input: example(`${file}.json`), provider: provider(), maxOutputTokens: 512, timeoutMs: 5000, now: () => CLOCK, ...over,
}) as never;
function refused(r: LiveRunResult, code: string, what = '') {
  assert.equal(r.ok, false, `expected a refusal ${what}`);
  const e = (r as { ok: false; error: { code: string; message: string } }).error;
  assert.equal(e.code, code, what);
  assert.ok(!e.message.includes('CANARY') && !JSON.stringify(e).includes(CANARY), 'no value echoed');
}

// ---------------------------------------------------------------- reviewed fixtures
test('reviewed fixtures: exactly the four synthetic examples are pinned, and each pin matches the file today', () => {
  assert.deepEqual(Object.keys(REVIEWED_FIXTURES).sort(), FILES.map((f) => `examples/${f}.json`).sort());
  for (const f of FILES) {
    const digest = REVIEWED_FIXTURES[`examples/${f}.json`];
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(fixtureDigest(example(`${f}.json`)), digest, f);
    assert.deepEqual(reviewedFixtureProblems(`examples/${f}.json`, example(`${f}.json`)), [], f);
  }
  assert.ok(Object.isFrozen(REVIEWED_FIXTURES));
});

test('reviewed fixtures: key order does not matter, but any content change does', () => {
  const base = example('skill-input.json');
  const reordered = Object.fromEntries(Object.entries(base).reverse());
  assert.deepEqual(reviewedFixtureProblems('examples/skill-input.json', reordered), []);
  const changes: [string, (r: Record<string, any>) => void][] = [
    ['text changed', (r) => { r.masked_text = `${r.masked_text} ${CANARY}`; }],
    ['real-looking text', (r) => { r.masked_text = 'Hello, my name is Jane Roe, phone 555-0101.'; }],
    ['tenant changed', (r) => { r.workspace_id = 'ws-customer-77'; }],
    ['masking source changed', (r) => { r.masking.source = 'sms-gateway'; }],
    ['field added', (r) => { r.extra = 1; }],
    ['field removed', (r) => { delete r.pii_summary; }],
    ['config changed', (r) => { r.skill_config.categories[0].keywords.push('refund'); }],
  ];
  for (const [name, mutate] of changes) {
    const r = structuredClone(base); mutate(r);
    const p = reviewedFixtureProblems('examples/skill-input.json', r);
    assert.equal(p.length, 1, name);
    assert.ok(!JSON.stringify(p).includes('Jane') && !JSON.stringify(p).includes('CANARY'), `${name}: no content echoed`);
  }
});

test('reviewed fixtures: an unlisted path, a path trick, a non-string path or an unreadable value is never reviewed', () => {
  const input = example('skill-input.json');
  for (const path of ['examples/valid-input.json', 'examples/new-file.json', 'examples/../examples/skill-input.json', '../examples/skill-input.json',
    'skill-input.json', 'examples/skill-input.json ', 'EXAMPLES/skill-input.json', '__proto__', 'constructor', 'toString', undefined, null, 5, {}]) {
    assert.equal(reviewedFixtureProblems(path, input).length, 1, String(path));
  }
  const cyclic: Record<string, unknown> = { a: 1 }; cyclic.self = cyclic;
  assert.equal(reviewedFixtureProblems('examples/skill-input.json', cyclic).length, 1);
  for (const bad of [null, undefined, 'x', 7, []]) assert.equal(reviewedFixtureProblems('examples/skill-input.json', bad).length, 1);
});

// ---------------------------------------------------------------- the live path, run with a mock provider
test('live path: each reviewed fixture runs through the controlled entry under developer authority', async () => {
  for (const f of FILES) {
    const req = request({}, f);
    const r = await runReviewedLive(req);
    assert.equal(r.ok, true, f);
    const ok = r as Extract<LiveRunResult, { ok: true }>;
    assert.equal(ok.workItem.workspace_id, example(`${f}.json`).workspace_id);
    assert.equal(req.provider.calls.length, 2, `${f}: exactly the two planned calls`);
    if (ok.handoff) {
      assert.match(ok.handoff.correlation_id, /^corr-synthetic-live-/, 'platform-minted, not the file\'s');
      assert.notEqual(ok.handoff.correlation_id, example(`${f}.json`).correlation_id);
      assert.equal(ok.handoff.created_at, CLOCK);
    }
    assert.equal(ok.workItem.source.channel_ref, 'channel-dev-live');
  }
});

test('live path: real customer data cannot be sent, because content that differs from a pinned fixture is refused before any provider call', async () => {
  const base = example('skill-input.json');
  const bad: [string, Partial<LiveRunRequest>][] = [
    ['real-looking text', { input: { ...base, masked_text: 'Hello, my name is Jane Roe. Phone 555-0101. Topic: refund' } }],
    ['customer tenant', { input: { ...base, workspace_id: 'ws-customer-77' } }],
    ['real masking source', { input: { ...base, masking: { applied: true, source: 'sms-gateway' } } }],
    ['unlisted path, same content', { path: 'examples/copy-of-skill-input.json' }],
    ['unlisted real file name', { path: 'examples/customer-export.json', input: { ...base, masked_text: CANARY } }],
    ['no skill_config', { input: (({ skill_config, ...rest }) => rest)(base) }],
    ['not an object', { input: 'text' }],
    ['null input', { input: null }],
  ];
  for (const [name, over] of bad) {
    const req = request(over);
    refused(await runReviewedLive(req), 'FIXTURE_NOT_REVIEWED', name);
    assert.equal(req.provider.calls.length, 0, `${name}: nothing sent`);
  }
});

test('live path: the caller cannot choose the tenant, agent, scope, channel, correlation id or clock', async () => {
  const req = request({
    ...({ workspace_id: 'ws-synthetic-evil', tenant: 'ws-synthetic-evil', agent: 'processing', scopes: ['*'], channelRef: 'channel-x', correlation_id: 'corr-attacker', registry: {}, ctx: { workspace_id: 'ws-synthetic-evil' } } as object),
  });
  const r = await runReviewedLive(req) as Extract<LiveRunResult, { ok: true }>;
  assert.equal(r.ok, true);
  assert.equal(r.workItem.workspace_id, 'ws-synthetic-a', 'the tenant is the pinned fixture\'s');
  assert.equal(r.workItem.source.channel_ref, 'channel-dev-live');
  assert.ok(!JSON.stringify(r).includes('attacker') && !JSON.stringify(r).includes('evil'));
});

test('live path: command-line flags cannot name a tenant, agent, scope, channel, provider or fixture content', () => {
  for (const flag of ['--workspace', '--tenant', '--agent', '--scope', '--scopes', '--channel', '--provider', '--correlation-id', '--registry', '--context', '--skill-config']) {
    const { problems } = parseLiveArgs([flag, 'x']);
    assert.ok(problems.length > 0, flag);
  }
});

test('live path: failures never throw and echo nothing (provider fails, setup fails, clock fails)', async () => {
  const broken = { id: 'broken', complete: async () => { throw new Error(CANARY); } } as never;
  const r = await runReviewedLive(request({ provider: broken }));
  assert.equal(r.ok, true);
  const ok = r as Extract<LiveRunResult, { ok: true }>;
  assert.deepEqual([ok.outcome, ok.handoff, ok.workItem.status], ['needs-human', null, 'needs-human']);
  assert.ok(ok.workItem.reasons.includes('model_failed'));
  assert.ok(!JSON.stringify(r).includes('CANARY'));

  refused(await runReviewedLive(request({ provider: null as never })), 'DEV_SETUP_FAILED', 'no provider');
  refused(await runReviewedLive(request({ maxOutputTokens: 99999 })), 'DEV_SETUP_FAILED', 'limits out of range');
  refused(await runReviewedLive(request({ timeoutMs: 0 })), 'DEV_SETUP_FAILED', 'bad timeout');
  const badClock = await runReviewedLive(request({ now: () => { throw new Error(CANARY); } }));
  assert.equal(badClock.ok, false);
  assert.ok(!JSON.stringify(badClock).includes('CANARY'));
});

// ---------------------------------------------------------------- static guarantees about the wiring
test('wiring: live-entry never imports or calls the raw runners, the boundary, the entry factory or the minting function', () => {
  const src = read('src/live-entry.ts');
  const code = src.replace(/\/\/.*$/gm, '');
  assert.ok(!/runIntake(WithModel)?\s*\(/.test(code), 'no direct runner call');
  assert.ok(!/import\s*\{[^}]*\}\s*from\s*'\.\/intake-runner\.ts'/.test(code), 'only a type import of the runner module is allowed');
  for (const forbidden of ["'./tenant-boundary.ts'", "'./intake-entry.ts'", "'./execution-context.ts'", 'mintExecutionContext', 'createIntakeEntry', 'createTenantRegistry']) {
    assert.ok(!code.includes(forbidden), `live-entry must not use ${forbidden}`);
  }
  assert.equal(code.split('runReviewedLive(').length - 1, 1, 'exactly one run, through live-run');
  const gateCall = code.indexOf('liveGateProblems(');
  const reviewed = code.indexOf('reviewedFixtureProblems(args.inputPath, input)', gateCall);
  const sdk = code.indexOf("import('@anthropic-ai/sdk')");
  assert.ok(gateCall > 0 && reviewed > gateCall && sdk > reviewed, 'order: gate, reviewed-fixture check, then the SDK import');
  assert.ok(/gate\.push\(\.\.\.reviewedFixtureProblems/.test(code), 'a failed reviewed-fixture check refuses the live call');
});

test('wiring: live-run is the developer composition root with one fixed scope, the intake agent, and no raw runner, provider or I/O', () => {
  const code = read('src/live-run.ts').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/from\s*'\.\/intake-runner\.ts'/.test(code) && !/runIntake(WithModel)?\s*\(/.test(code));
  assert.ok(!/tenant-boundary\.ts'[\s\S]*runIntake/.test(code));
  assert.ok(!/claude-provider|@anthropic-ai|new Anthropic/.test(code), 'it creates no provider');
  assert.equal(code.split("agent: 'intake'").length - 1, 1);
  assert.ok(/grants:\s*\(\)\s*=>\s*\['intake:run'\]/.test(code), 'exactly one scope');
  assert.equal(code.split('mintExecutionContext(').length - 1, 1, 'one mint');
  assert.ok(!/node:(?!crypto)|\bfetch\b|\bprocess\b|\bconsole\b|\brequire\(|\bimport\(/.test(code), 'no I/O, process or dynamic import beyond node:crypto for the id');
});

test('wiring: reviewed-fixtures reads no files and uses no network or process APIs', () => {
  const code = read('src/reviewed-fixtures.ts').replace(/\/\/.*$/gm, '');
  assert.ok(!/node:(?!crypto)|\bfetch\b|\bprocess\b|\bconsole\b|readFile|\bimport\(/.test(code));
});
