// Tests for the trusted tenant and config boundary. Local mock provider only. Synthetic data only. No network, no key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTenantRegistry, runIntakeForTenant, runIntakeWithModelForTenant } from '../src/tenant-boundary.ts';
import type { BoundaryResult } from '../src/tenant-boundary.ts';
import { classifyAnswer, createMockProvider, extractAnswer } from '../src/mock-provider.ts';
import { acceptHandoff, mintExecutionContext, narrow } from '../src/execution-context.ts';
import type { AgentName, ExecutionContext } from '../src/execution-context.ts';

const read = (n: string) => JSON.parse(readFileSync(new URL(`../examples/${n}`, import.meta.url), 'utf8'));
function split(n: string) {
  const { skill_config: config, ...message } = read(n);
  return { message: message as Record<string, unknown>, config };
}
const plumbing = split('skill-plumbing.json');
const dental = split('skill-dental.json');
/** A context minted through the trusted path with mock sources (verify, select tenant, grants). */
async function mintCtx(tenant: string, agent: AgentName = 'intake', scopes: string[] = ['intake:run']): Promise<ExecutionContext> {
  const r = await mintExecutionContext({ credential: 'mock-credential', agent }, {
    verify: () => ({ kind: 'user', id: 'user-synthetic-1' }),
    selectTenant: () => tenant,
    grants: () => scopes,
    newCorrelationId: () => 'corr-minted-test',
  });
  assert.equal(r.ok, true, 'mock mint should succeed');
  return (r as { ok: true; context: ExecutionContext }).context;
}
const P = await mintCtx('ws-synthetic-plumbing');
const D = await mintCtx('ws-synthetic-dental');
const registry = () => createTenantRegistry({ [P.workspace_id]: plumbing.config, [D.workspace_id]: dental.config });

const VALUES: Record<string, string> = { Address: '[ADDRESS_1]', 'Job description': 'Burst pipe repair', 'Patient reference': '[ID_1]', 'Insurance provider': 'Example Health' };
/** One provider shared by every tenant: it answers from whatever vocabulary the request carries. */
const sharedProvider = () => createMockProvider({
  classify_request: (req) => classifyAnswer((req.data.categories ?? []).includes('Emergency leak') ? 'Emergency leak' : 'New patient', 0.9),
  extract_fields: (req) => extractAnswer((req.data.fields ?? []).map((f) => ({ name: f.name, value: VALUES[f.name] ?? null, confidence: VALUES[f.name] ? 0.9 : null }))),
});
const withProvider = (provider: ReturnType<typeof sharedProvider>) => ({ provider });

function refused(r: BoundaryResult, code: string, what = '') {
  assert.equal(r.ok, false, `expected a refusal ${what}`);
  if (r.ok) throw new Error('unreachable');
  assert.equal(r.error.code, code, what);
  return r.error;
}
function ok(r: BoundaryResult) {
  assert.equal(r.ok, true, 'expected ok result');
  if (!r.ok) throw new Error('unreachable');
  return r;
}

// ---------------------------------------------------------------- happy path and isolation
test('tenant boundary: each tenant runs with its own registered config on one shared provider, with no cross-leakage', async () => {
  const reg = registry();
  const p = sharedProvider();
  const a = ok(await runIntakeWithModelForTenant(P, plumbing.message, reg, withProvider(p)));
  const b = ok(await runIntakeWithModelForTenant(D, dental.message, reg, withProvider(p)));
  assert.deepEqual([a.workItem.category, a.outcome, a.workItem.workspace_id, a.handoff?.workspace_id], ['Emergency leak', 'handed-off', P.workspace_id, P.workspace_id]);
  assert.deepEqual([b.workItem.category, b.outcome, b.workItem.workspace_id, b.handoff?.workspace_id], ['New patient', 'handed-off', D.workspace_id, D.workspace_id]);
  assert.equal(p.calls.length, 4);
  const plumbingCalls = JSON.stringify(p.calls.slice(0, 2));
  const dentalCalls = JSON.stringify(p.calls.slice(2));
  for (const foreign of ['New patient', 'Patient reference', 'Insurance provider']) assert.ok(!plumbingCalls.includes(foreign), `plumbing call must not contain ${foreign}`);
  for (const foreign of ['Emergency leak', 'Job description', 'Address']) assert.ok(!dentalCalls.includes(foreign), `dental call must not contain ${foreign}`);
  assert.ok(!(plumbingCalls + dentalCalls).includes('ws-synthetic'), 'no workspace id reaches the provider');
});

test('tenant boundary: the same event id gives different item ids for different tenants', () => {
  const reg = registry();
  const a = ok(runIntakeForTenant(P, { ...plumbing.message, event_id: 'evt-synthetic-shared' }, reg));
  const b = ok(runIntakeForTenant(D, { ...dental.message, event_id: 'evt-synthetic-shared' }, reg));
  assert.notEqual(a.workItem.item_id, b.workItem.item_id);
});

test('tenant boundary: the deterministic runner also works behind the boundary', () => {
  const reg = registry();
  const a = ok(runIntakeForTenant(P, plumbing.message, reg));
  const b = ok(runIntakeForTenant(D, dental.message, reg));
  assert.deepEqual([a.workItem.category, a.outcome, b.workItem.category, b.outcome], ['Emergency leak', 'handed-off', 'New patient', 'handed-off']);
});

// ---------------------------------------------------------------- mismatch
test('mismatch: a message for another tenant is refused before any provider call', async () => {
  const p = sharedProvider();
  refused(await runIntakeWithModelForTenant(P, dental.message, registry(), withProvider(p)), 'TENANT_MISMATCH');
  assert.equal(p.calls.length, 0);
  refused(runIntakeForTenant(D, plumbing.message, registry()), 'TENANT_MISMATCH');
});

test('mismatch: comparison is strict (case, whitespace) and the message value must be its own property', async () => {
  const p = sharedProvider();
  for (const value of ['WS-SYNTHETIC-PLUMBING', 'ws-synthetic-plumbing ', ' ws-synthetic-plumbing', 'ws-synthetic-plumbing\n', 5, null]) {
    refused(await runIntakeWithModelForTenant(P, { ...plumbing.message, workspace_id: value }, registry(), withProvider(p)), 'TENANT_MISMATCH', String(value));
  }
  const missing = { ...plumbing.message }; delete missing.workspace_id;
  refused(await runIntakeWithModelForTenant(P, missing, registry(), withProvider(p)), 'TENANT_MISMATCH', 'missing');
  const inherited = Object.create({ workspace_id: P.workspace_id }); Object.assign(inherited, missing);
  refused(await runIntakeWithModelForTenant(P, inherited, registry(), withProvider(p)), 'TENANT_MISMATCH', 'inherited');
  assert.equal(p.calls.length, 0);
});

test('missing context: a missing or malformed trusted context is refused before anything else', async () => {
  const p = sharedProvider();
  for (const bad of [undefined, null, {}, { workspace_id: '' }, { workspace_id: 5 }, { workspace_id: 'has space' }, { workspace_id: 'x'.repeat(65) }, 'ws-synthetic-plumbing']) {
    refused(await runIntakeWithModelForTenant(bad as never, plumbing.message, registry(), withProvider(p)), 'TENANT_CONTEXT_MISSING', JSON.stringify(bad));
    refused(runIntakeForTenant(bad as never, plumbing.message, registry()), 'TENANT_CONTEXT_MISSING', JSON.stringify(bad));
  }
  assert.equal(p.calls.length, 0);
});

// ---------------------------------------------------------------- spoofing
test('spoofing: a message may not carry its own config, classification values, or required fields', async () => {
  const p = sharedProvider();
  const attempts: Array<[string, unknown]> = [
    ['skill_config', plumbing.config],                    // the tenant's own config is still refused
    ['skill_config', dental.config],                      // another tenant's config
    ['candidate', { category: 'Emergency leak', fields: [] }],
    ['category_list', ['Emergency leak']],
    ['required_fields', []],
  ];
  for (const [key, value] of attempts) {
    refused(await runIntakeWithModelForTenant(P, { ...plumbing.message, [key]: value }, registry(), withProvider(p)), 'CONFIG_NOT_ALLOWED_IN_INPUT', key);
    refused(runIntakeForTenant(P, { ...plumbing.message, [key]: value }, registry()), 'CONFIG_NOT_ALLOWED_IN_INPUT', key);
  }
  assert.equal(p.calls.length, 0);
});

test('spoofing: extra identity-like keys and an own __proto__ key are refused and pollute nothing', async () => {
  const p = sharedProvider();
  for (const extra of [{ tenant_id: 'ws-synthetic-dental' }, { workspace: 'ws-synthetic-dental' }]) {
    refused(await runIntakeWithModelForTenant(P, { ...plumbing.message, ...extra }, registry(), withProvider(p)), 'INPUT_INVALID');
  }
  const hostile = JSON.parse(JSON.stringify(plumbing.message).slice(0, -1) + ',"__proto__":{"skill_config":{"categories":[],"fields":[]}}}');
  refused(await runIntakeWithModelForTenant(P, hostile, registry(), withProvider(p)), 'INPUT_INVALID', '__proto__ key');
  assert.equal(({} as Record<string, unknown>).skill_config, undefined, 'Object.prototype is not polluted');
  assert.equal(p.calls.length, 0);
});

test('spoofing: a non-object message is refused', async () => {
  const p = sharedProvider();
  for (const bad of [null, undefined, 'text', 7]) refused(await runIntakeWithModelForTenant(P, bad, registry(), withProvider(p)), 'INPUT_INVALID');
  assert.equal(p.calls.length, 0);
});

// ---------------------------------------------------------------- missing config and registry
test('missing config: a valid but unregistered tenant is refused with no fallback to another tenant', async () => {
  const p = sharedProvider();
  const stranger = await mintCtx('ws-synthetic-other');
  refused(await runIntakeWithModelForTenant(stranger, { ...plumbing.message, workspace_id: stranger.workspace_id }, registry(), withProvider(p)), 'CONFIG_MISSING');
  refused(runIntakeForTenant(stranger, { ...plumbing.message, workspace_id: stranger.workspace_id }, registry()), 'CONFIG_MISSING');
  const only = createTenantRegistry({ [P.workspace_id]: plumbing.config });
  refused(await runIntakeWithModelForTenant(D, dental.message, only, withProvider(p)), 'CONFIG_MISSING');
  refused(runIntakeForTenant(D, dental.message, createTenantRegistry({}) ), 'CONFIG_MISSING');
  assert.equal(p.calls.length, 0);
});

test('missing config: tenant ids such as __proto__ and constructor are ordinary unregistered keys', async () => {
  const p = sharedProvider();
  for (const id of ['__proto__', 'constructor', 'toString']) {
    refused(await runIntakeWithModelForTenant(await mintCtx(id), { ...plumbing.message, workspace_id: id }, registry(), withProvider(p)), 'CONFIG_MISSING', id);
  }
  assert.equal(p.calls.length, 0);
});

test('registry: invalid configs and tenant ids fail at creation without echoing values; registered configs are private and frozen', async () => {
  const bad = structuredClone(plumbing.config);
  bad.categories[0].requires = ['CANARY-FIELD-7741'];
  assert.throws(() => createTenantRegistry({ [P.workspace_id]: bad }), (e: Error) => e instanceof RangeError && !e.message.includes('CANARY'));
  assert.throws(() => createTenantRegistry({ 'has space': plumbing.config }), RangeError);

  const mine = structuredClone(plumbing.config);
  const reg = createTenantRegistry({ [P.workspace_id]: mine });
  mine.categories[0].name = 'Tampered after registration';        // later changes to the caller's object do not reach the registry
  const p = sharedProvider();
  ok(await runIntakeWithModelForTenant(P, plumbing.message, reg, withProvider(p)));
  assert.ok(p.calls[0].data.categories?.includes('Emergency leak'));
  assert.ok(!JSON.stringify(p.calls).includes('Tampered'));
  const stored = reg.get(P.workspace_id)!;
  assert.ok(Object.isFrozen(stored) && Object.isFrozen(stored.categories) && Object.isFrozen(stored.categories[0]));
  assert.throws(() => { (stored.categories[0] as { name: string }).name = 'x'; }, TypeError);
});

// ---------------------------------------------------------------- single read / snapshot
/** A message whose workspace_id is an accessor returning `values` in order (the last value repeats). */
function flipping(base: Record<string, unknown>, values: string[]) {
  const state = { reads: 0 };
  const m: Record<string, unknown> = { ...base };
  delete m.workspace_id;
  Object.defineProperty(m, 'workspace_id', { enumerable: true, get() { return values[Math.min(state.reads++, values.length - 1)]; } });
  return { m, state };
}

test('snapshot: a getter that shows another tenant first is a mismatch, with no provider call', async () => {
  const p = sharedProvider();
  const { m, state } = flipping(plumbing.message, [D.workspace_id, P.workspace_id]);
  refused(await runIntakeWithModelForTenant(P, m, registry(), withProvider(p)), 'TENANT_MISMATCH');
  assert.equal(state.reads, 1);
  assert.equal(p.calls.length, 0);
});

test('snapshot: a getter that matches first and then switches tenant cannot change what runs', async () => {
  const p = sharedProvider();
  const { m, state } = flipping(plumbing.message, [P.workspace_id, D.workspace_id]);
  const r = ok(await runIntakeWithModelForTenant(P, m, registry(), withProvider(p)));
  assert.equal(state.reads, 1, 'workspace_id is read once');
  assert.deepEqual([r.workItem.workspace_id, r.handoff?.workspace_id, r.workItem.category], [P.workspace_id, P.workspace_id, 'Emergency leak']);
  assert.ok(!JSON.stringify(p.calls).includes('New patient'), 'the plumbing config ran, not another');
  const d = ok(runIntakeForTenant(P, flipping(plumbing.message, [P.workspace_id, D.workspace_id]).m, registry()));
  assert.equal(d.workItem.workspace_id, P.workspace_id);
});

test('snapshot: an enumerable getter on a forbidden key is refused; a hidden (non-enumerable) one never reaches the runner', async () => {
  const p = sharedProvider();
  const loud: Record<string, unknown> = { ...plumbing.message };
  Object.defineProperty(loud, 'skill_config', { enumerable: true, get() { return dental.config; } });
  refused(await runIntakeWithModelForTenant(P, loud, registry(), withProvider(p)), 'CONFIG_NOT_ALLOWED_IN_INPUT');
  assert.equal(p.calls.length, 0);
  const hidden: Record<string, unknown> = { ...plumbing.message };
  Object.defineProperty(hidden, 'skill_config', { enumerable: false, get() { return dental.config; } });
  const r = ok(await runIntakeWithModelForTenant(P, hidden, registry(), withProvider(p)));
  assert.equal(r.workItem.category, 'Emergency leak', 'the registered plumbing config ran, not the hidden one');
  assert.ok(!JSON.stringify(p.calls).includes('New patient'));
});

test('context: a getter object is not a context, so a tenant-switching context cannot be used at all', async () => {
  const p = sharedProvider();
  const state = { reads: 0 };
  const ctx = { get workspace_id() { return [P.workspace_id, D.workspace_id, 'has space'][Math.min(state.reads++, 2)]; } };
  refused(await runIntakeWithModelForTenant(ctx as never, plumbing.message, registry(), withProvider(p)), 'TENANT_CONTEXT_MISSING');
  refused(runIntakeForTenant(ctx as never, plumbing.message, registry()), 'TENANT_CONTEXT_MISSING');
  assert.equal(state.reads, 0, 'a non-minted context is never even read');
  assert.equal(p.calls.length, 0);
});

// ---------------------------------------------------------------- Stage 3: minted authority and the intake:run permission
test('minted authority: a plain object, copy, clone, parsed JSON, look-alike or proxy is refused before any provider call', async () => {
  const p = sharedProvider();
  const lookalike = { workspace_id: P.workspace_id, actor: { kind: 'user', id: 'user-synthetic-1' }, agent: 'intake', correlation_id: 'corr-1', scopes: ['intake:run'] };
  const forged: unknown[] = [
    { workspace_id: P.workspace_id },                       // the old caller-made tenant
    lookalike, { ...P }, Object.assign({}, P), structuredClone(P), JSON.parse(JSON.stringify(P)),
    Object.create(P), new Proxy(P, {}), Object.freeze({ ...P }),
  ];
  for (const f of forged) {
    refused(await runIntakeWithModelForTenant(f as never, plumbing.message, registry(), withProvider(p)), 'TENANT_CONTEXT_MISSING', 'model runner');
    refused(runIntakeForTenant(f as never, plumbing.message, registry()), 'TENANT_CONTEXT_MISSING', 'deterministic runner');
  }
  assert.equal(p.calls.length, 0);
  ok(await runIntakeWithModelForTenant(P, plumbing.message, registry(), withProvider(sharedProvider())));   // the minted one still works
});

test('wrong agent: a minted context for another agent cannot run Intake, even with the intake:run scope', async () => {
  const p = sharedProvider();
  for (const agent of ['processing', 'quality-control', 'reporting'] as const) {
    const ctx = await mintCtx(P.workspace_id, agent, ['intake:run']);
    refused(await runIntakeWithModelForTenant(ctx, plumbing.message, registry(), withProvider(p)), 'TENANT_CONTEXT_MISSING', agent);
    refused(runIntakeForTenant(ctx, plumbing.message, registry()), 'TENANT_CONTEXT_MISSING', agent);
  }
  assert.equal(p.calls.length, 0);
});

test('no scope: without the explicit intake:run permission Intake is refused (default deny)', async () => {
  const p = sharedProvider();
  // (an uppercase name such as INTAKE:RUN cannot be minted at all; that is covered in execution-context.test.ts)
  const cases: string[][] = [[], ['tool:read'], ['intake:run-all'], ['intake:'], ['intake'], ['run']];
  for (const scopes of cases) {
    const ctx = await mintCtx(P.workspace_id, 'intake', scopes);
    refused(await runIntakeWithModelForTenant(ctx, plumbing.message, registry(), withProvider(p)), 'PERMISSION_DENIED', scopes.join(','));
    refused(runIntakeForTenant(ctx, plumbing.message, registry()), 'PERMISSION_DENIED', scopes.join(','));
  }
  assert.equal(p.calls.length, 0);
});

test('narrowing: dropping other scopes keeps Intake working; dropping intake:run turns it off', async () => {
  const wide = await mintCtx(P.workspace_id, 'intake', ['intake:run', 'tool:read']);
  const keep = narrow(wide, { keep_scopes: ['intake:run'] });
  assert.equal(keep.ok, true);
  ok(runIntakeForTenant((keep as { ok: true; context: ExecutionContext }).context, plumbing.message, registry()));
  const drop = narrow(wide, { keep_scopes: ['tool:read'] });
  refused(runIntakeForTenant((drop as { ok: true; context: ExecutionContext }).context, plumbing.message, registry()), 'PERMISSION_DENIED');
  ok(runIntakeForTenant(wide, plumbing.message, registry()));                       // the parent is unchanged
});

test('cross-tenant: the context fixes the tenant; the message cannot choose another, and the order of refusals is fixed', async () => {
  const p = sharedProvider();
  refused(await runIntakeWithModelForTenant(P, dental.message, registry(), withProvider(p)), 'TENANT_MISMATCH', 'plumbing context, dental message');
  refused(await runIntakeWithModelForTenant(D, plumbing.message, registry(), withProvider(p)), 'TENANT_MISMATCH', 'dental context, plumbing message');
  // a context with no scope for a different tenant is refused for permission first, before the message is even looked at
  const noScopeDental = await mintCtx(D.workspace_id, 'intake', []);
  refused(runIntakeForTenant(noScopeDental, plumbing.message, registry()), 'PERMISSION_DENIED');
  assert.equal(p.calls.length, 0);
});

test('end to end: a minted Intake context produces a handoff that only the same tenant\'s Processing context accepts', async () => {
  const r = ok(runIntakeForTenant(P, plumbing.message, registry()));
  assert.ok(r.handoff, 'fixture must be handed off');
  const processingP = await mintCtx(P.workspace_id, 'processing', []);
  const processingD = await mintCtx(D.workspace_id, 'processing', []);
  assert.equal(acceptHandoff(processingP, r.handoff).ok, true);
  const refusedByOther = acceptHandoff(processingD, r.handoff);
  assert.equal(refusedByOther.ok, false);
  assert.equal((refusedByOther as { ok: false; error: { code: string } }).error.code, 'TENANT_MISMATCH');
  assert.equal(acceptHandoff(await mintCtx(P.workspace_id, 'intake', []), r.handoff).ok, false, 'Intake is not the recipient');
});

// ---------------------------------------------------------------- registry: read-only membership and clone-first
test('registry: membership cannot be changed at runtime (no set, delete, clear; frozen; not a Map)', async () => {
  const reg = registry();
  const r = reg as unknown as Record<string, unknown>;
  assert.ok(Object.isFrozen(reg) && !(reg instanceof Map));
  for (const name of ['set', 'delete', 'clear']) assert.equal(r[name], undefined, name);
  assert.throws(() => { r.set = () => reg; }, TypeError);
  assert.throws(() => { r.get = () => dental.config; }, TypeError);
  assert.throws(() => { r.extra = 1; }, TypeError);
  assert.equal(reg.size, 2);
  // Even borrowing a Map's methods cannot reach the private membership.
  assert.throws(() => Map.prototype.set.call(reg, 'ws-synthetic-evil', dental.config), TypeError);
  assert.equal(reg.has('ws-synthetic-evil'), false);
  const p = sharedProvider();
  refused(await runIntakeWithModelForTenant(await mintCtx('ws-synthetic-evil'), { ...plumbing.message, workspace_id: 'ws-synthetic-evil' }, reg, withProvider(p)), 'CONFIG_MISSING');
  assert.equal(p.calls.length, 0);
  ok(await runIntakeWithModelForTenant(P, plumbing.message, reg, withProvider(sharedProvider())));   // still works
});

test('registry: the caller\'s registry object and configs object cannot add tenants later', () => {
  const configs: Record<string, typeof plumbing.config> = { [P.workspace_id]: plumbing.config };
  const reg = createTenantRegistry(configs);
  configs[D.workspace_id] = dental.config;
  assert.equal(reg.has(D.workspace_id), false);
  assert.equal(reg.size, 1);
  refused(runIntakeForTenant(D, dental.message, reg), 'CONFIG_MISSING');
});

test('registry: a getter is read once, and the stored config is the one that was validated', () => {
  const good = structuredClone(plumbing.config);
  const state = { reads: 0 };
  const flipping = structuredClone(plumbing.config);
  Object.defineProperty(flipping, 'categories', { enumerable: true, get() { state.reads++; return state.reads === 1 ? good.categories : [{ name: 'CANARY-NAME-5521', keywords: [] }]; } });
  const reg = createTenantRegistry({ [P.workspace_id]: flipping });
  assert.equal(state.reads, 1);
  assert.equal(reg.get(P.workspace_id)!.categories[0].name, 'Emergency leak');
  // First read invalid, later reads valid: rejected, because the first read is what is checked.
  const s2 = { reads: 0 };
  const bad = structuredClone(plumbing.config);
  Object.defineProperty(bad, 'categories', { enumerable: true, get() { s2.reads++; return s2.reads === 1 ? [] : good.categories; } });
  assert.throws(() => createTenantRegistry({ [P.workspace_id]: bad }), RangeError);
  assert.equal(s2.reads, 1);
});

test('registry: uncloneable configs fail closed with fixed text and no customer values', () => {
  const secret = 'CANARY-VALUE-9913';
  const withFn = structuredClone(plumbing.config) as Record<string, unknown>;
  withFn.categories = [{ name: secret, keywords: ['x'], note: () => secret }];
  const throwing = structuredClone(plumbing.config);
  Object.defineProperty(throwing, 'fields', { enumerable: true, get() { throw new Error(secret); } });
  const proxied = new Proxy(structuredClone(plumbing.config), {});
  for (const config of [withFn, throwing, proxied, null, 'text', 5]) {
    assert.throws(() => createTenantRegistry({ [P.workspace_id]: config as never }), (e: Error) => {
      assert.ok(e instanceof RangeError, 'always a RangeError');
      assert.ok(!e.message.includes('CANARY'), 'no customer value in the message');
      return true;
    });
  }
  for (const bad of [null, undefined, 'x', [1]]) assert.throws(() => createTenantRegistry(bad as never), RangeError);
  assert.equal(createTenantRegistry({}).size, 0);
});

test('boundary: safety rules still apply behind it (missing required field is reviewed, not handed off)', async () => {
  const text = 'Hello, this is [PERSON_1]. There is a burst pipe and a leak in the kitchen.\nJob description: Burst pipe repair';
  const r = ok(await runIntakeWithModelForTenant(P, { ...plumbing.message, masked_text: text }, registry(), withProvider(sharedProvider())));
  assert.deepEqual([r.workItem.category, r.workItem.missing_fields, r.outcome, r.handoff], ['Emergency leak', ['Address'], 'needs-human', null]);
});
