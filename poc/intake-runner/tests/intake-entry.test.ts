// Tests for the controlled Intake entry. Mock provider and mock trusted sources only. Synthetic data only. No network, no key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createIntakeEntry } from '../src/intake-entry.ts';
import type { EntryResult, IntakeEntryConfig } from '../src/intake-entry.ts';
import { createTenantRegistry } from '../src/tenant-boundary.ts';
import { mintExecutionContext, narrow } from '../src/execution-context.ts';
import type { AgentName, ExecutionContext } from '../src/execution-context.ts';
import { classifyAnswer, createMockProvider, extractAnswer } from '../src/mock-provider.ts';

const CANARY = 'CANARY-ENTRY-6620';
const read = (n: string) => JSON.parse(readFileSync(new URL(`../examples/${n}`, import.meta.url), 'utf8'));
function split(n: string) {
  const { skill_config: config, ...message } = read(n);
  return { message: message as Record<string, unknown>, config };
}
const plumbing = split('skill-plumbing.json');
const dental = split('skill-dental.json');
const PW = 'ws-synthetic-plumbing';
const DW = 'ws-synthetic-dental';
const CLOCK = '2026-10-25T12:00:00Z';
const CHANNEL = 'channel-entry-test';

async function mintCtx(tenant: string, agent: AgentName = 'intake', scopes: string[] = ['intake:run']): Promise<ExecutionContext> {
  const r = await mintExecutionContext({ credential: 'mock-credential', agent }, {
    verify: () => ({ kind: 'user', id: 'user-synthetic-1' }),
    selectTenant: () => tenant,
    grants: () => scopes,
    newCorrelationId: () => 'corr-minted-entry',
  });
  assert.equal(r.ok, true, 'mock mint should succeed');
  return (r as { ok: true; context: ExecutionContext }).context;
}
const P = await mintCtx(PW);
const D = await mintCtx(DW);

const VALUES: Record<string, string> = { Address: '[ADDRESS_1]', 'Job description': 'Burst pipe repair', 'Patient reference': '[ID_1]', 'Insurance provider': 'Example Health' };
const sharedProvider = () => createMockProvider({
  classify_request: (req) => classifyAnswer((req.data.categories ?? []).includes('Emergency leak') ? 'Emergency leak' : 'New patient', 0.9),
  extract_fields: (req) => extractAnswer((req.data.fields ?? []).map((f) => ({ name: f.name, value: VALUES[f.name] ?? null, confidence: VALUES[f.name] ? 0.9 : null }))),
});
const registry = () => createTenantRegistry({ [PW]: plumbing.config, [DW]: dental.config });
function setup(over: Partial<IntakeEntryConfig> = {}, provider = sharedProvider()) {
  const entry = createIntakeEntry({ registry: registry(), provider, channelRef: CHANNEL, now: () => CLOCK, ...over });
  return { entry, provider };
}
function ok(r: EntryResult) {
  assert.equal(r.ok, true, `expected ok, got ${JSON.stringify((r as { error?: unknown }).error)}`);
  return r as Extract<EntryResult, { ok: true }>;
}
function refused(r: EntryResult, code: string, what = '') {
  assert.equal(r.ok, false, `expected a refusal ${what}`);
  const e = (r as { ok: false; error: { code: string; message: string } }).error;
  assert.equal(e.code, code, what);
  assert.ok(!e.message.includes('CANARY'), 'no value echoed');
  return e;
}

// ---------------------------------------------------------------- happy path and tenant separation
test('entry: each tenant runs through one entry with its own config; no cross-leakage to the shared provider', async () => {
  const { entry, provider } = setup();
  const a = ok(await entry.run(P, plumbing.message));
  const b = ok(await entry.run(D, dental.message));
  assert.deepEqual([a.workItem.category, a.outcome, a.workItem.workspace_id], ['Emergency leak', 'handed-off', PW]);
  assert.deepEqual([b.workItem.category, b.outcome, b.workItem.workspace_id], ['New patient', 'handed-off', DW]);
  assert.equal(provider.calls.length, 4);
  const first = JSON.stringify(provider.calls.slice(0, 2));
  const second = JSON.stringify(provider.calls.slice(2));
  for (const x of ['New patient', 'Patient reference', 'Insurance provider', 'ws-synthetic']) assert.ok(!first.includes(x), `plumbing calls must not contain ${x}`);
  for (const x of ['Emergency leak', 'Job description', 'Address', 'ws-synthetic']) assert.ok(!second.includes(x), `dental calls must not contain ${x}`);
});

test('tenant: the context fixes the tenant; a message for another tenant is refused before any provider call', async () => {
  const { entry, provider } = setup();
  refused(await entry.run(P, dental.message), 'TENANT_MISMATCH', 'plumbing context, dental message');
  refused(await entry.run(D, plumbing.message), 'TENANT_MISMATCH', 'dental context, plumbing message');
  assert.equal(provider.calls.length, 0);
});

test('tenant: a message that omits workspace_id belongs to the context\'s tenant', async () => {
  const { entry } = setup();
  const m = { ...plumbing.message }; delete m.workspace_id;
  assert.equal(ok(await entry.run(P, m)).workItem.workspace_id, PW);
});

test('tenant: a getter that shows one tenant and then another is read once', async () => {
  const { entry, provider } = setup();
  const state = { reads: 0 };
  const m: Record<string, unknown> = { ...plumbing.message }; delete m.workspace_id;
  Object.defineProperty(m, 'workspace_id', { enumerable: true, get() { return state.reads++ === 0 ? DW : PW; } });
  refused(await entry.run(P, m), 'TENANT_MISMATCH');
  assert.equal(state.reads, 1);
  assert.equal(provider.calls.length, 0);
});

// ---------------------------------------------------------------- permissions and forged contexts
test('permissions: forged, copied, wrong-agent and no-scope contexts are refused with zero provider calls', async () => {
  const { entry, provider } = setup();
  const forged: unknown[] = [
    { workspace_id: PW }, { ...P }, structuredClone(P), JSON.parse(JSON.stringify(P)), Object.create(P), new Proxy(P, {}),
    null, undefined, 'ctx', 5,
  ];
  for (const f of forged) refused(await entry.run(f, plumbing.message), 'TENANT_CONTEXT_MISSING');
  for (const agent of ['processing', 'quality-control', 'reporting'] as const) {
    refused(await entry.run(await mintCtx(PW, agent), plumbing.message), 'TENANT_CONTEXT_MISSING', agent);
  }
  for (const scopes of [[], ['tool:read'], ['intake:run-all']]) {
    refused(await entry.run(await mintCtx(PW, 'intake', scopes), plumbing.message), 'PERMISSION_DENIED', scopes.join(','));
  }
  assert.equal(provider.calls.length, 0);
});

test('permissions: a narrowed context keeps working while it still holds intake:run, and stops when it does not', async () => {
  const { entry } = setup();
  const wide = await mintCtx(PW, 'intake', ['intake:run', 'tool:read']);
  const keep = (narrow(wide, { keep_scopes: ['intake:run'] }) as { ok: true; context: ExecutionContext }).context;
  const drop = (narrow(wide, { keep_scopes: ['tool:read'] }) as { ok: true; context: ExecutionContext }).context;
  ok(await entry.run(keep, plumbing.message));
  refused(await entry.run(drop, plumbing.message), 'PERMISSION_DENIED');
});

test('permissions: the permission is checked before the message is examined', async () => {
  const { entry } = setup();
  const noScope = await mintCtx(PW, 'intake', []);
  refused(await entry.run(noScope, { not: 'even valid', masking: null }), 'PERMISSION_DENIED');
});

// ---------------------------------------------------------------- platform-owned metadata
test('metadata: sender-supplied correlation id, time, channel and contract are replaced by platform values', async () => {
  const { entry, provider } = setup();
  const hostile = {
    ...plumbing.message,
    correlation_id: 'corr-attacker', received_at: '2000-01-01T00:00:00Z', channel_ref: 'channel-attacker', requested_contract: 'work_item.v9',
  };
  const r = ok(await entry.run(P, hostile));
  assert.equal(r.outcome, 'handed-off');
  assert.deepEqual([r.handoff?.correlation_id, r.handoff?.created_at, r.workItem.source.channel_ref], ['corr-minted-entry', CLOCK, CHANNEL]);
  const everything = JSON.stringify([r, provider.calls]);
  for (const s of ['corr-attacker', '2000-01-01', 'channel-attacker', 'work_item.v9']) assert.ok(!everything.includes(s), s);
});

test('metadata: a minimal message with only sender fields works', async () => {
  const { entry } = setup();
  const { event_id, masked_text, masking, pii_summary } = plumbing.message as Record<string, unknown>;
  const r = ok(await entry.run(P, { event_id, masked_text, masking, pii_summary }));
  assert.deepEqual([r.handoff?.workspace_id, r.handoff?.correlation_id], [PW, 'corr-minted-entry']);
});

test('metadata: the clock is read fresh for each run, and a bad clock fails closed', async () => {
  const times = ['2026-10-25T12:00:00Z', '2026-10-25T12:00:07Z'];
  let i = 0;
  const { entry, provider } = setup({ now: () => times[i++] });
  assert.equal(ok(await entry.run(P, plumbing.message)).handoff?.created_at, times[0]);
  assert.equal(ok(await entry.run(P, plumbing.message)).handoff?.created_at, times[1]);
  const calls = provider.calls.length;
  for (const now of [() => '', () => 'yesterday', () => 5 as never, () => { throw new Error(CANARY); }]) {
    const s = setup({ now });
    refused(await s.entry.run(P, plumbing.message), 'ENTRY_ERROR');
    assert.equal(s.provider.calls.length, 0);
  }
  assert.equal(provider.calls.length, calls);
});

// ---------------------------------------------------------------- allowlist
test('allowlist: unknown keys are refused and config keys are refused by the boundary, all before any provider call', async () => {
  const { entry, provider } = setup();
  for (const extra of [{ tenant_id: DW }, { workspace: DW }, { extra: 1 }, { actor: 'root' }, { scopes: ['*'] }, { provider: 'x' }]) {
    refused(await entry.run(P, { ...plumbing.message, ...extra }), 'INPUT_INVALID', Object.keys(extra)[0]);
  }
  const hostile = JSON.parse(JSON.stringify(plumbing.message).slice(0, -1) + ',"__proto__":{"skill_config":{}}}');
  refused(await entry.run(P, hostile), 'INPUT_INVALID', '__proto__');
  for (const [k, v] of [['skill_config', dental.config], ['category_list', ['x']], ['required_fields', []], ['candidate', { category: null, fields: [] }]] as const) {
    refused(await entry.run(P, { ...plumbing.message, [k]: v }), 'CONFIG_NOT_ALLOWED_IN_INPUT', k);
  }
  for (const bad of [null, undefined, 'text', 7, []]) refused(await entry.run(P, bad), 'INPUT_INVALID');
  assert.equal(provider.calls.length, 0);
});

// ---------------------------------------------------------------- synthetic only
test('synthetic only: non-synthetic masking, event ids or tenants are refused before any provider call', async () => {
  const { entry, provider } = setup();
  const m = plumbing.message as Record<string, any>;
  const cases: [string, Record<string, unknown>][] = [
    ['real masking source', { ...m, masking: { applied: true, source: 'sms-gateway' } }],
    ['not applied', { ...m, masking: { applied: false, source: 'synthetic-fixture' } }],
    ['no masking', (({ masking, ...rest }) => rest)(m)],
    ['masking not an object', { ...m, masking: 'synthetic-fixture' }],
    ['real event id', { ...m, event_id: 'evt-real-0001' }],
    ['no event id', (({ event_id, ...rest }) => rest)(m)],
  ];
  for (const [name, msg] of cases) refused(await entry.run(P, msg), 'SYNTHETIC_ONLY', name);
  const real = await mintCtx('ws-acme-1');
  refused(await entry.run(real, { ...m, workspace_id: 'ws-acme-1' }), 'SYNTHETIC_ONLY', 'non-synthetic tenant');
  assert.equal(provider.calls.length, 0);
});

// ---------------------------------------------------------------- fixed at setup
test('setup: a caller cannot choose another provider, options, channel or clock per run', async () => {
  const { entry, provider } = setup();
  const decoy = createMockProvider({ classify_request: () => classifyAnswer('Emergency leak', 0.9), extract_fields: () => extractAnswer([]) }, 'decoy');
  const extra = [{ provider: decoy, channelRef: 'channel-x', now: () => '1999-01-01T00:00:00Z', maxOutputTokens: 4096 }, decoy, 'x'] as unknown[];
  const r = ok(await (entry.run as (...a: unknown[]) => Promise<EntryResult>)(P, plumbing.message, ...extra));
  assert.equal(decoy.calls.length, 0);
  assert.equal(provider.calls.length, 2);
  assert.deepEqual([r.workItem.source.channel_ref, r.handoff?.created_at, r.workItem.versions.model], [CHANNEL, CLOCK, 'mock-local']);
  assert.ok(Object.isFrozen(entry));
  assert.throws(() => { (entry as { run: unknown }).run = () => null; }, TypeError);
});

test('setup: later changes to the provider or to the limits object do not reach the entry', async () => {
  const provider = sharedProvider();
  const limits = { maxOutputTokens: 256 };
  const { entry } = setup({ limits }, provider);
  (provider as { complete: unknown }).complete = async () => { throw new Error(CANARY); };
  limits.maxOutputTokens = 99999;
  const r = ok(await entry.run(P, plumbing.message));
  assert.equal(r.outcome, 'handed-off');
  assert.equal(provider.calls.length, 2, 'the original complete still ran');
});

test('setup: bad configuration fails at startup with a RangeError that echoes no values', () => {
  const good = { registry: registry(), provider: sharedProvider(), channelRef: CHANNEL, now: () => CLOCK };
  const bad: [string, unknown][] = [
    ['no config', null], ['registry null', { ...good, registry: null }], ['registry plain object', { ...good, registry: { get: () => undefined, has: () => false } }],
    ['registry unfrozen', { ...good, registry: Object.assign({}, registry()) }],
    ['provider null', { ...good, provider: null }], ['provider no id', { ...good, provider: { complete: async () => ({ text: '' }) } }],
    ['provider no complete', { ...good, provider: { id: 'p' } }],
    ['channel bad', { ...good, channelRef: `has space ${CANARY}` }], ['channel missing', { ...good, channelRef: undefined }],
    ['now missing', { ...good, now: undefined }],
    ['attempts 0', { ...good, limits: { maxAttempts: 0 } }], ['attempts 4', { ...good, limits: { maxAttempts: 4 } }],
    ['tokens huge', { ...good, limits: { maxOutputTokens: 100000 } }], ['timeout 0', { ...good, limits: { timeoutMs: 0 } }],
    ['minConfidence 2', { ...good, limits: { minConfidence: 2 } }], ['minConfidence text', { ...good, limits: { minConfidence: CANARY } }],
    ['limits text', { ...good, limits: CANARY }],
  ];
  for (const [name, cfg] of bad) {
    assert.throws(() => createIntakeEntry(cfg as never), (e: Error) => e instanceof RangeError && !e.message.includes('CANARY'), name);
  }
  assert.doesNotThrow(() => createIntakeEntry(good));
});

// ---------------------------------------------------------------- failures never throw
test('failures: an unexpected error at request time is a typed refusal with fixed text, never an exception', async () => {
  const throwingRegistry = Object.freeze({ get: () => { throw new Error(CANARY); }, has: () => false, size: 0 });
  const { entry } = setup({ registry: throwingRegistry as never });
  refused(await entry.run(P, plumbing.message), 'ENTRY_ERROR');
  const { entry: normal } = setup();
  for (const [c, m] of [[undefined, undefined], [null, null], [P, Symbol('x')], [P, new Proxy({}, { ownKeys() { throw new Error(CANARY); } })]] as unknown[][]) {
    const r = await normal.run(c, m);
    assert.equal(r.ok, false);
    assert.ok(!JSON.stringify(r).includes('CANARY'));
  }
});

test('failures: a provider that throws or rejects fails closed to a human, with no handoff', async () => {
  for (const complete of [async () => { throw new Error(CANARY); }, () => { throw new Error(CANARY); }]) {
    const provider = { id: 'broken', complete } as never;
    const { entry } = setup({}, provider);
    const r = ok(await entry.run(P, plumbing.message));
    assert.deepEqual([r.outcome, r.handoff, r.workItem.status], ['needs-human', null, 'needs-human']);
    assert.ok(r.workItem.reasons.includes('model_failed'));
    assert.ok(!JSON.stringify(r).includes('CANARY'));
  }
});

test('failures: safety rules still apply behind the entry (a missing required field is reviewed, not handed off)', async () => {
  const { entry } = setup();
  const text = 'Hello, this is [PERSON_1]. There is a burst pipe and a leak in the kitchen.\nJob description: Burst pipe repair';
  const r = ok(await entry.run(P, { ...plumbing.message, masked_text: text }));
  assert.deepEqual([r.workItem.category, r.workItem.missing_fields, r.outcome, r.handoff], ['Emergency leak', ['Address'], 'needs-human', null]);
});

// ---------------------------------------------------------------- single path (inventory)
test('single path: only this entry imports the boundary runners; nobody in src mints contexts; this file touches no I/O', () => {
  const dir = new URL('../src/', import.meta.url);
  const files = readdirSync(dir).filter((n) => n.endsWith('.ts'));
  const importers = (re: RegExp) => files.filter((f) => re.test(readFileSync(new URL(f, dir), 'utf8'))).sort();
  assert.deepEqual(importers(/import\s*(?:type\s*)?\{[^}]*\b(runIntakeForTenant|runIntakeWithModelForTenant)\b[^}]*\}\s*from\s*'\.\/tenant-boundary\.ts'/), ['intake-entry.ts']);
  assert.deepEqual(importers(/import\s*(?:type\s*)?\{[^}]*\bmintExecutionContext\b[^}]*\}\s*from\s*'\.\/execution-context\.ts'/), ['live-run.ts', 'pipeline.ts'], 'the composition roots are the synthetic developer path and the controlled pipeline');
  // the raw runners: only the two local scripts and the boundary; neither intake-entry.ts nor live-entry.ts may appear
  assert.deepEqual(importers(/import\s*(?:type\s*)?\{[^}]*\b(runIntake|runIntakeWithModel)\b[^}]*\}\s*from\s*'\.\/intake-runner\.ts'/), ['cli.ts', 'demo.ts', 'tenant-boundary.ts']);
  const own = readFileSync(new URL('intake-entry.ts', dir), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/node:|\bfetch\b|\bprocess\b|\bconsole\b|\brequire\(|\bimport\(/.test(own), 'no I/O, process or dynamic import');
  assert.ok(!/claude-provider|@anthropic-ai/.test(own), 'the entry never names a real provider');
});
