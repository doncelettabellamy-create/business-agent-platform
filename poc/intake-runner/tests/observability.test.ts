// Tests for the allow-list emitter and failure taxonomy. Mock sinks and mock trusted sources only. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CLASS_INFO, ERROR_CLASS, FAILURE_CLASSES, UNCLASSIFIED, classify, createEmitter, createPlatformEmitter, describeResult,
} from '../src/observability.ts';
import type { Emitter, ObsEvent, Sink } from '../src/observability.ts';
import { mintExecutionContext } from '../src/execution-context.ts';
import type { AgentName, ExecutionContext } from '../src/execution-context.ts';
import { createIntakeEntry } from '../src/intake-entry.ts';
import { createTenantRegistry } from '../src/tenant-boundary.ts';
import { classifyAnswer, createMockProvider, extractAnswer } from '../src/mock-provider.ts';

const CANARY = 'CANARY-OBS-8841';
const CLOCK = '2026-10-25T14:00:00Z';
const PW = 'ws-synthetic-plumbing';
const DW = 'ws-synthetic-dental';
const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

async function mintCtx(tenant: string, agent: AgentName = 'intake', correlation = 'corr-minted-obs', actorId = 'user-synthetic-1'): Promise<ExecutionContext> {
  const r = await mintExecutionContext({ credential: 'mock-credential', agent }, {
    verify: () => ({ kind: 'user', id: actorId }), selectTenant: () => tenant, grants: () => ['intake:run'], newCorrelationId: () => correlation,
  });
  assert.equal(r.ok, true);
  return (r as { ok: true; context: ExecutionContext }).context;
}
function collector() {
  const events: ObsEvent[] = [];
  const sink: Sink = { write: (e) => { events.push(e); } };
  return { events, sink };
}
const config = (over: Record<string, unknown> = {}) => ({ now: () => CLOCK, ...over });
async function emitterFor(ctx: ExecutionContext, sink: Sink, over: Record<string, unknown> = {}): Promise<Emitter> {
  const r = createEmitter(ctx, sink, config(over));
  assert.equal(r.ok, true);
  return (r as { ok: true; emitter: Emitter }).emitter;
}
const tick = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------- stamping from the trusted context
test('stamping: tenant, correlation id, agent and actor kind come from the minted context; a payload cannot set or override them', async () => {
  const ctx = await mintCtx(PW, 'intake', 'corr-minted-1');
  const { events, sink } = collector();
  const em = await emitterFor(ctx, sink);
  const hostile = {
    event: 'run.finished', item_id: 'wi-0123456789ab', outcome: 'handed-off',
    workspace_id: DW, correlation_id: 'corr-attacker', agent: 'reporting', actor_kind: 'system', level: 'info', timestamp: '2000-01-01T00:00:00Z',
    scope: 'platform', delivery: 'mandatory', schema: 9, failure_class: 'safety_violation', alert: true, retryable: true,
  };
  assert.equal(em.emit(hostile), true);
  const e = events[0];
  assert.deepEqual(
    [e.workspace_id, e.correlation_id, e.agent, e.actor_kind, e.timestamp, e.level, e.scope, e.delivery, e.schema],
    [PW, 'corr-minted-1', 'intake', 'user', CLOCK, 'info', 'tenant', 'best_effort', 1],
  );
  assert.equal(e.failure_class, undefined);
  assert.deepEqual(Object.keys(e).sort(), ['actor_kind', 'agent', 'correlation_id', 'delivery', 'event', 'item_id', 'level', 'outcome', 'schema', 'scope', 'timestamp', 'workspace_id']);
  assert.ok(Object.isFrozen(e));
  assert.ok(!JSON.stringify(e).includes('attacker'));
});

test('forged contexts: copies, clones, parsed JSON, look-alikes and proxies get no emitter, and nothing reaches the sink', async () => {
  const real = await mintCtx(PW);
  const { events, sink } = collector();
  const forged: unknown[] = [
    { workspace_id: PW, correlation_id: 'corr-1', agent: 'intake', actor: { kind: 'user', id: 'u' }, scopes: [] },
    { ...real }, structuredClone(real), JSON.parse(JSON.stringify(real)), Object.create(real), new Proxy(real, {}), null, undefined, 'ctx', 5, [],
  ];
  for (const f of forged) {
    const r = createEmitter(f, sink, config());
    assert.equal(r.ok, false);
    assert.equal((r as { ok: false; error: { code: string } }).error.code, 'CONTEXT_NOT_TRUSTED');
    assert.ok(!JSON.stringify(r).includes('CANARY'));
  }
  assert.equal(events.length, 0);
  assert.equal(createEmitter(real, sink, config()).ok, true);
});

test('setup: a bad sink, config or clock fails at startup with a RangeError that echoes nothing', async () => {
  const ctx = await mintCtx(PW);
  const { sink } = collector();
  const bad: [string, () => unknown][] = [
    ['no sink', () => createEmitter(ctx, null as never, config())],
    ['sink without write', () => createEmitter(ctx, { write: CANARY } as never, config())],
    ['no config', () => createEmitter(ctx, sink, null as never)],
    ['no clock', () => createEmitter(ctx, sink, {} as never)],
    ['audit sink without write', () => createEmitter(ctx, sink, config({ auditSink: { write: CANARY } }))],
    ['audit sink is the telemetry sink', () => createEmitter(ctx, sink, config({ auditSink: sink }))],
    ['platform: no sink', () => createPlatformEmitter(null as never, config())],
    ['platform: no clock', () => createPlatformEmitter(sink, {} as never)],
  ];
  for (const [name, fn] of bad) assert.throws(fn, (e: Error) => e instanceof RangeError && !e.message.includes('CANARY'), name);
});

// ---------------------------------------------------------------- cross-tenant stamping
test('cross-tenant: two tenants emitting into one sink, interleaved, are never stamped with each other\'s identity', async () => {
  const a = await mintCtx(PW, 'intake', 'corr-plumbing-1', 'user-plumbing');
  const b = await mintCtx(DW, 'processing', 'corr-dental-1', 'user-dental');
  const { events, sink } = collector();
  const ea = await emitterFor(a, sink);
  const eb = await emitterFor(b, sink);
  for (let i = 0; i < 5; i++) {
    ea.emit({ event: 'run.finished', outcome: 'handed-off', workspace_id: DW, correlation_id: 'corr-dental-1' });
    eb.emit({ event: 'handoff.accepted', workspace_id: PW, correlation_id: 'corr-plumbing-1' });
  }
  assert.equal(events.length, 10);
  for (const e of events) {
    if (e.event === 'run.finished') assert.deepEqual([e.workspace_id, e.correlation_id, e.agent], [PW, 'corr-plumbing-1', 'intake']);
    else assert.deepEqual([e.workspace_id, e.correlation_id, e.agent], [DW, 'corr-dental-1', 'processing']);
  }
  assert.ok(!events.some((e) => e.workspace_id === PW && e.correlation_id === 'corr-dental-1'));
});

test('cross-tenant: an emitter keeps the identity it was created with, even if the caller later holds other contexts', async () => {
  const a = await mintCtx(PW, 'intake', 'corr-a');
  const { events, sink } = collector();
  const ea = await emitterFor(a, sink);
  await mintCtx(DW, 'intake', 'corr-b');
  ea.emit({ event: 'run.finished' });
  assert.deepEqual([events[0].workspace_id, events[0].correlation_id], [PW, 'corr-a']);
});

// ---------------------------------------------------------------- no customer text or configuration names
test('allow-list: category, field names and values, messages, config keys and unknown values never reach an event', async () => {
  const ctx = await mintCtx(PW);
  const { events, sink } = collector();
  const em = await emitterFor(ctx, sink);
  em.emit({
    event: 'run.refused', error_code: `${CANARY}-CODE`, category: `${CANARY}-CATEGORY`, fields: [{ name: `${CANARY}-FIELD`, value: `${CANARY}-VALUE` }],
    message: `${CANARY}-MESSAGE`, masked_text: `${CANARY}-TEXT`, skill_config: { categories: [CANARY] }, error: { message: CANARY },
    item_id: `${CANARY}-ITEM`, outcome: CANARY, reasons: [CANARY, 'missing_fields', 'missing_fields', 'model_failed'],
    steps: [{ skill: CANARY, source: 'model' }, { skill: 'classify-request', source: CANARY }, { skill: 'classify-request', source: 'model', attempts: 2, failure: `${CANARY}-F`, text: CANARY }],
    duration_ms: -5, counts: { attempts: 2, [`${CANARY}-key`]: 7, model_calls: CANARY, missing_fields: 1.5 },
  });
  const e = events[0];
  assert.ok(!JSON.stringify(events).includes('CANARY'));
  assert.deepEqual([e.error_code, e.failure_class, e.item_id, e.outcome, e.duration_ms], [UNCLASSIFIED, 'internal_error', undefined, undefined, undefined]);
  assert.deepEqual(e.reasons, ['missing_fields', 'model_failed']);
  assert.deepEqual(e.steps, [{ skill: 'classify-request', source: 'model', attempts: 2 }]);
  assert.deepEqual(e.counts, { attempts: 2 });
});

test('allow-list: unknown event names and non-objects are rejected, and an event that needs a code gets UNCLASSIFIED if none is given', async () => {
  const ctx = await mintCtx(PW);
  const { events, sink } = collector();
  const em = await emitterFor(ctx, sink);
  for (const bad of ['run.finished', null, undefined, 5, [], { event: 'made.up' }, { event: `${CANARY}` }, { event: 'platform.check_failed' }, {}]) assert.equal(em.emit(bad), false, String(bad));
  assert.equal(events.length, 0);
  assert.equal(em.stats().rejected, 9);
  assert.equal(em.emit({ event: 'safety.violation' }), true);
  assert.deepEqual([events[0].error_code, events[0].failure_class], [UNCLASSIFIED, 'internal_error']);
});

test('allow-list: values are read once (getters) and lists are capped', async () => {
  const ctx = await mintCtx(PW);
  const { events, sink } = collector();
  const em = await emitterFor(ctx, sink);
  const reads = { id: 0 };
  const input: Record<string, unknown> = { event: 'run.finished' };
  Object.defineProperty(input, 'item_id', { enumerable: true, get() { return reads.id++ === 0 ? 'wi-aaaaaaaaaaaa' : `${CANARY}`; } });
  input.steps = Array.from({ length: 20 }, () => ({ skill: 'extract-fields', source: 'deterministic' }));
  em.emit(input);
  assert.equal(reads.id, 1);
  assert.equal(events[0].item_id, 'wi-aaaaaaaaaaaa');
  assert.equal(events[0].steps?.length, 8);
});

// ---------------------------------------------------------------- real results through the real entry
test('results: a handed-off, a needs-human and a refused result become events with no category, field or value, tied to the minted correlation id', async () => {
  const plumbing = JSON.parse(read('examples/skill-plumbing.json'));
  const { skill_config: cfg, ...message } = plumbing;
  const VALUES: Record<string, string> = { Address: '[ADDRESS_1]', 'Job description': 'Burst pipe repair' };
  const provider = createMockProvider({
    classify_request: () => classifyAnswer('Emergency leak', 0.9),
    extract_fields: (req) => extractAnswer((req.data.fields ?? []).map((f) => ({ name: f.name, value: VALUES[f.name] ?? null, confidence: VALUES[f.name] ? 0.9 : null }))),
  });
  const entry = createIntakeEntry({ registry: createTenantRegistry({ [PW]: cfg }), provider, channelRef: 'channel-obs', now: () => CLOCK });
  const ctx = await mintCtx(PW, 'intake', 'corr-minted-obs');
  const { events, sink } = collector();
  const em = await emitterFor(ctx, sink);

  const good = await entry.run(ctx, message);
  em.emit(describeResult(good));
  const review = await entry.run(ctx, { ...message, masked_text: 'Hello, this is [PERSON_1]. There is a burst pipe and a leak in the kitchen.\nJob description: Burst pipe repair' });
  em.emit(describeResult(review));
  const refusedResult = await entry.run({ workspace_id: PW }, message);
  em.emit(describeResult(refusedResult));

  const [a, b, c] = events;
  assert.deepEqual([a.event, a.outcome, a.workspace_id, a.correlation_id], ['run.finished', 'handed-off', PW, 'corr-minted-obs']);
  assert.match(a.item_id ?? '', /^wi-[0-9a-f]{12}$/);
  assert.deepEqual(a.steps?.map((s) => [s.skill, s.source]), [['classify-request', 'model'], ['extract-fields', 'model']]);
  assert.deepEqual([b.event, b.outcome, b.counts], ['run.finished', 'needs-human', { missing_fields: 1 }]);
  assert.ok(b.reasons?.includes('missing_fields'), 'the reason codes are fixed words, not customer text');
  assert.equal(b.correlation_id, 'corr-minted-obs', 'a needs-human item (no envelope) is still traceable through its event');
  assert.notEqual(a.item_id, undefined);
  assert.deepEqual([c.event, c.error_code, c.failure_class, c.level], ['run.refused', 'TENANT_CONTEXT_MISSING', 'refused_tenant', 'warn']);
  const text = JSON.stringify(events);
  for (const customer of ['Emergency leak', 'Address', 'Job description', 'Burst pipe', '[ADDRESS_1]', 'PERSON_1', 'ws-synthetic-dental', 'channel-obs']) assert.ok(!text.includes(customer), `event leaked ${customer}`);
});

test('results: describeResult reads no tenant text even from a hostile result object', () => {
  const hostile = {
    ok: true, outcome: 'needs-human',
    workItem: { item_id: 'wi-0123456789ab', category: `${CANARY}-CAT`, fields: [{ name: `${CANARY}-N`, value: `${CANARY}-V` }], missing_fields: [`${CANARY}-M`], reasons: ['unknown_category'], message_ref: `${CANARY}` },
    trace: [{ skill: 'classify-request', source: 'model', provider_id: `${CANARY}-P`, attempts: 1 }],
  };
  const input = describeResult(hostile);
  assert.ok(!JSON.stringify(input).includes('CANARY'));
  for (const odd of [null, undefined, 'x', 5, { ok: true }, { ok: false }, { ok: false, error: null }, new Proxy({}, { ownKeys() { throw new Error(CANARY); } })]) {
    const r = describeResult(odd);
    assert.equal(r.event, 'run.refused');
    assert.ok(!JSON.stringify(r).includes('CANARY'));
  }
});

// ---------------------------------------------------------------- classification
test('classification: each class has a level, retry and alert setting, and a few codes land where expected', () => {
  assert.deepEqual([...FAILURE_CLASSES].sort(), Object.keys(CLASS_INFO).sort());
  assert.equal(classify('MODEL_TIMEOUT'), 'dependency_failure');
  assert.deepEqual(CLASS_INFO.dependency_failure, { level: 'error', retryable: true, alert: false });
  assert.equal(classify('CONTEXT_NOT_TRUSTED'), 'safety_violation');
  assert.equal(CLASS_INFO.safety_violation.alert, true);
  assert.equal(classify('NARROW_ONLY'), 'safety_violation');
  assert.equal(classify('PERMISSION_DENIED'), 'refused_permission');
  assert.equal(classify('UNAUTHENTICATED'), 'refused_authentication');
  assert.equal(classify('TENANT_MISMATCH'), 'refused_tenant');
  assert.equal(classify('ENTRY_ERROR'), 'internal_error');
  assert.equal(classify('SYNTHETIC_ONLY'), 'refused_input');
  for (const unknown of ['NOT_A_CODE', '', '__proto__', 'constructor', 'toString', undefined, null, 5, { x: 1 }]) assert.equal(classify(unknown), 'internal_error', String(unknown));
  for (const c of Object.values(ERROR_CLASS)) assert.ok((FAILURE_CLASSES as readonly string[]).includes(c));
  assert.ok(Object.isFrozen(ERROR_CLASS) && Object.isFrozen(CLASS_INFO));
});

test('classification: an error event carries the class, level, retryable and alert flags from the table', async () => {
  const ctx = await mintCtx(PW);
  const { events, sink } = collector();
  const em = await emitterFor(ctx, sink);
  em.emit({ event: 'run.refused', error_code: 'MODEL_TIMEOUT' });
  em.emit({ event: 'safety.violation', error_code: 'CONTEXT_NOT_TRUSTED' });
  em.emit({ event: 'handoff.refused', error_code: 'TENANT_MISMATCH' });
  assert.deepEqual(events.map((e) => [e.failure_class, e.level, e.retryable, e.alert]), [
    ['dependency_failure', 'error', true, false], ['safety_violation', 'error', false, true], ['refused_tenant', 'warn', false, false],
  ]);
});

test('classification coverage: every error code in the six source unions has a class, and the table has nothing extra', () => {
  const sources: [string, string][] = [
    ['src/intake-runner.ts', 'ErrorCode'], ['src/model-gateway.ts', 'ModelFailureCode'], ['src/tenant-boundary.ts', 'BoundaryErrorCode'],
    ['src/execution-context.ts', 'ContextErrorCode'], ['src/intake-entry.ts', 'EntryErrorCode'], ['src/live-run.ts', 'LiveRunErrorCode'],
    ['src/processing-entry.ts', 'ProcessingErrorCode'], ['src/processing-entry.ts', 'StepFailureCode'], ['src/qc-entry.ts', 'QcErrorCode'], ['src/reporting-entry.ts', 'ReportingErrorCode'], ['src/pipeline.ts', 'PipelineErrorCode'], ['src/approval.ts', 'ApprovalErrorCode'], ['src/approver-context.ts', 'ApproverContextErrorCode'], ['src/approval-store.ts', 'StoreErrorCode'],
  ];
  const found = new Set<string>();
  for (const [file, type] of sources) {
    const m = read(file).match(new RegExp(`export type ${type} =([^;]*);`));
    assert.ok(m, `${type} not found in ${file}`);
    const codes = [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
    assert.ok(codes.length > 0, `${type} has no codes`);
    for (const c of codes) { assert.ok(Object.hasOwn(ERROR_CLASS, c), `${c} (${file}) has no failure class`); found.add(c); }
  }
  assert.deepEqual([...found].sort(), Object.keys(ERROR_CLASS).sort(), 'the table has no code that no source declares');
  assert.equal(found.size, 77);
});

// ---------------------------------------------------------------- failed sinks and bad clocks
test('failed sinks: a throwing, rejecting or hanging sink never throws, never blocks, and is counted', async () => {
  const ctx = await mintCtx(PW);
  const throwing = await emitterFor(ctx, { write: () => { throw new Error(CANARY); } });
  assert.doesNotThrow(() => throwing.emit({ event: 'run.finished' }));
  assert.equal(throwing.emit({ event: 'run.finished' }), false);
  assert.equal(throwing.stats().sink_failures, 2);

  const rejecting = await emitterFor(ctx, { write: async () => { throw new Error(CANARY); } });
  assert.equal(rejecting.emit({ event: 'run.finished' }), true);
  await tick();
  assert.deepEqual([rejecting.stats().emitted, rejecting.stats().sink_failures], [1, 1]);

  let started = 0;
  const hanging = await emitterFor(ctx, { write: () => { started++; return new Promise(() => {}); } });
  const t0 = Date.now();
  assert.equal(hanging.emit({ event: 'run.finished' }), true);
  assert.ok(Date.now() - t0 < 100, 'emit does not wait for the sink');
  assert.equal(started, 1);

  const odd = await emitterFor(ctx, { write: () => ({ then: 5 }) });
  assert.equal(odd.emit({ event: 'run.finished' }), true);
  const tampering = await emitterFor(ctx, { write: (e) => { (e as { workspace_id: string }).workspace_id = DW; } });
  assert.equal(tampering.emit({ event: 'run.finished' }), false, 'a sink cannot rewrite the event: it is frozen');
});

test('failed sinks: a failure never changes the caller\'s result or leaks the sink\'s error text', async () => {
  const ctx = await mintCtx(PW);
  const em = await emitterFor(ctx, { write: () => { throw new Error(CANARY); } });
  const result = { ok: true, value: 42 };
  const before = JSON.stringify(result);
  em.emit(describeResult(result));
  assert.equal(JSON.stringify(result), before);
  assert.ok(!JSON.stringify(em.stats()).includes('CANARY'));
});

test('bad clocks: a throwing or malformed clock drops the event instead of emitting a bad one', async () => {
  const ctx = await mintCtx(PW);
  for (const now of [() => '', () => 'yesterday', () => 5 as never, () => { throw new Error(CANARY); }]) {
    const { events, sink } = collector();
    const em = await emitterFor(ctx, sink, { now });
    assert.equal(em.emit({ event: 'run.finished' }), false);
    assert.equal(events.length, 0);
    assert.equal(em.stats().rejected, 1);
  }
});

test('garbage input never throws', async () => {
  const ctx = await mintCtx(PW);
  const { sink } = collector();
  const em = await emitterFor(ctx, sink);
  const weird = [Symbol('x'), () => 1, new Proxy({}, { ownKeys() { throw new Error(CANARY); } }), { event: 'run.finished', steps: new Proxy([], { get() { throw new Error(CANARY); } }) }, { get event() { throw new Error(CANARY); } }];
  for (const w of weird) assert.doesNotThrow(() => em.emit(w));
});

// ---------------------------------------------------------------- mandatory audit stays separate
test('mandatory audit: with no audit sink it always reports failure and never uses the telemetry sink', async () => {
  const ctx = await mintCtx(PW);
  const { events, sink } = collector();
  const em = await emitterFor(ctx, sink);
  assert.equal(await em.emitMandatory({ event: 'run.finished', outcome: 'handed-off' }), false);
  assert.equal(events.length, 0, 'a mandatory event is never downgraded to telemetry');
  assert.equal(em.stats().mandatory_failed, 1);
});

test('mandatory audit: with an audit sink the event goes only there, marked mandatory; best-effort events never go there', async () => {
  const ctx = await mintCtx(PW, 'intake', 'corr-audit-1');
  const tele = collector();
  const audit = collector();
  const em = await emitterFor(ctx, tele.sink, { auditSink: audit.sink });
  assert.equal(await em.emitMandatory({ event: 'handoff.accepted', item_id: 'wi-0123456789ab', workspace_id: DW }), true);
  assert.equal(em.emit({ event: 'run.finished' }), true);
  assert.equal(audit.events.length, 1);
  assert.deepEqual([audit.events[0].delivery, audit.events[0].workspace_id, audit.events[0].correlation_id], ['mandatory', PW, 'corr-audit-1']);
  assert.equal(tele.events.length, 1);
  assert.equal(tele.events[0].delivery, 'best_effort');
  assert.deepEqual([em.stats().mandatory_written, em.stats().emitted], [1, 1]);
});

test('mandatory audit: a failing audit sink is reported as failure (never swallowed as success) so the caller can block the change', async () => {
  const ctx = await mintCtx(PW);
  for (const write of [() => { throw new Error(CANARY); }, async () => { throw new Error(CANARY); }, () => Promise.reject(new Error(CANARY))]) {
    const tele = collector();
    const em = await emitterFor(ctx, tele.sink, { auditSink: { write } });
    assert.equal(await em.emitMandatory({ event: 'run.finished' }), false);
    assert.equal(em.stats().mandatory_failed, 1);
    assert.equal(tele.events.length, 0);
  }
  const tele = collector();
  const em = await emitterFor(ctx, tele.sink, { auditSink: { write: () => {} } });
  assert.equal(await em.emitMandatory({ event: 'made.up' }), false, 'an invalid mandatory event is a failure too');
});

// ---------------------------------------------------------------- platform scope
test('platform scope: platform events carry no tenant fields, and the two scopes cannot emit each other\'s events', async () => {
  const { events, sink } = collector();
  const platform = createPlatformEmitter(sink, config());
  assert.equal(platform.emit({ event: 'platform.check_failed', error_code: 'DEV_SETUP_FAILED', workspace_id: PW, correlation_id: 'corr-x', agent: 'intake' }), true);
  const e = events[0];
  assert.deepEqual([e.scope, e.workspace_id, e.correlation_id, e.agent, e.actor_kind, e.failure_class], ['platform', undefined, undefined, undefined, undefined, 'internal_error']);
  assert.equal(platform.emit({ event: 'run.finished' }), false);
  const tenant = await emitterFor(await mintCtx(PW), sink);
  assert.equal(tenant.emit({ event: 'platform.check_failed' }), false);
  assert.equal(events.length, 1);
});

// ---------------------------------------------------------------- static guarantees
test('static: observability.ts imports only contracts and the execution context, touches no I/O, and never reads customer-text properties', () => {
  const raw = read('src/observability.ts');
  const code = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const imports = [...new Set([...code.matchAll(/^import[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]))].sort();
  assert.deepEqual(imports, ['./contracts.ts', './execution-context.ts']);
  assert.ok(!/node:|\bfetch\b|\bprocess\b|\bconsole\b|\brequire\(|\bimport\(/.test(code), 'no I/O, process or dynamic import');
  assert.ok(!/\.category\b|\.fields\b|\.value\b|\.masked_text\b|\.skill_config\b|\.message\b|\.provider_id\b/.test(code), 'no customer-text or configuration property is read');
});
