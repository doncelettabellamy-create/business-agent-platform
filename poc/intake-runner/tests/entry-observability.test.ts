// Tests for the optional emitter wired into the controlled Intake entry. Mock provider, mock sinks, synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createIntakeEntry } from '../src/intake-entry.ts';
import { createTenantRegistry } from '../src/tenant-boundary.ts';
import { mintExecutionContext } from '../src/execution-context.ts';
import type { AgentName, ExecutionContext } from '../src/execution-context.ts';
import type { ObsEvent, Sink } from '../src/observability.ts';
import { classifyAnswer, createMockProvider, extractAnswer } from '../src/mock-provider.ts';

const CLOCK = '2026-10-25T15:00:00Z';
const PW = 'ws-synthetic-plumbing';
const DW = 'ws-synthetic-dental';
const { skill_config: pcfg, ...pmsg } = JSON.parse(readFileSync(new URL('../examples/skill-plumbing.json', import.meta.url), 'utf8'));
const { skill_config: dcfg, ...dmsg } = JSON.parse(readFileSync(new URL('../examples/skill-dental.json', import.meta.url), 'utf8'));

async function mintCtx(tenant: string, corr: string, agent: AgentName = 'intake', scopes: string[] = ['intake:run']): Promise<ExecutionContext> {
  const r = await mintExecutionContext({ credential: 'mock-credential', agent }, {
    verify: () => ({ kind: 'user', id: 'user-synthetic-1' }), selectTenant: () => tenant, grants: () => scopes, newCorrelationId: () => corr,
  });
  assert.equal(r.ok, true);
  return (r as { ok: true; context: ExecutionContext }).context;
}
const VALUES: Record<string, string> = { Address: '[ADDRESS_1]', 'Job description': 'Burst pipe repair', 'Patient reference': '[ID_1]', 'Insurance provider': 'Example Health' };
const provider = () => createMockProvider({
  classify_request: (req) => classifyAnswer((req.data.categories ?? []).includes('Emergency leak') ? 'Emergency leak' : 'New patient', 0.9),
  extract_fields: (req) => extractAnswer((req.data.fields ?? []).map((f) => ({ name: f.name, value: VALUES[f.name] ?? null, confidence: VALUES[f.name] ? 0.9 : null }))),
});
function collector() { const events: ObsEvent[] = []; const sink: Sink = { write: (e) => { events.push(e); } }; return { events, sink }; }
function make(sink?: Sink) {
  return createIntakeEntry({ registry: createTenantRegistry({ [PW]: pcfg, [DW]: dcfg }), provider: provider(), channelRef: 'channel-entry-obs', now: () => CLOCK, ...(sink ? { sink } : {}) });
}
const REVIEW = { ...pmsg, masked_text: 'Hello, this is [PERSON_1]. There is a burst pipe and a leak in the kitchen.\nJob description: Burst pipe repair' };

test('entry emitter: a handed-off run emits one run.finished stamped from the minted context', async () => {
  const { events, sink } = collector();
  const r = await make(sink).run(await mintCtx(PW, 'corr-e-1'), pmsg);
  assert.equal(r.ok, true);
  assert.equal(events.length, 1);
  const e = events[0];
  assert.deepEqual([e.event, e.outcome, e.workspace_id, e.correlation_id, e.agent, e.actor_kind, e.timestamp, e.delivery], ['run.finished', 'handed-off', PW, 'corr-e-1', 'intake', 'user', CLOCK, 'best_effort']);
  assert.match(e.item_id ?? '', /^wi-[0-9a-f]{12}$/);
});

test('entry emitter: needs-human emits run.finished with the item id and correlation id', async () => {
  const { events, sink } = collector();
  const r = await make(sink).run(await mintCtx(PW, 'corr-e-2'), REVIEW);
  assert.equal((r as { outcome?: string }).outcome, 'needs-human');
  assert.deepEqual([events[0].event, events[0].outcome, events[0].correlation_id], ['run.finished', 'needs-human', 'corr-e-2']);
  assert.match(events[0].item_id ?? '', /^wi-/);
});

test('entry emitter: refusals emit run.refused with the code; trusted ids only; nothing for an untrusted context', async () => {
  const { events, sink } = collector();
  const entry = make(sink);
  await entry.run(await mintCtx(PW, 'corr-e-3', 'intake', []), pmsg);
  await entry.run(await mintCtx(PW, 'corr-e-4'), { ...pmsg, workspace_id: DW });
  await entry.run(await mintCtx(PW, 'corr-e-5'), { ...pmsg, masking: { applied: true, source: 'real' } });
  await entry.run(await mintCtx(PW, 'corr-e-6'), { ...pmsg, skill_config: {} });
  await entry.run({ workspace_id: PW, correlation_id: 'corr-forged' }, pmsg);
  await entry.run(null, pmsg);
  assert.deepEqual(events.map((e) => [e.event, e.error_code, e.correlation_id]), [
    ['run.refused', 'PERMISSION_DENIED', 'corr-e-3'],
    ['run.refused', 'TENANT_MISMATCH', 'corr-e-4'],
    ['run.refused', 'SYNTHETIC_ONLY', 'corr-e-5'],
    ['run.refused', 'CONFIG_NOT_ALLOWED_IN_INPUT', 'corr-e-6'],
  ]);
  assert.ok(events.every((e) => e.workspace_id === PW), 'stamped from the context, not the message');
  assert.ok(!JSON.stringify(events).includes('corr-forged'));
});

test('entry emitter: results are identical with and without a sink, and tenants never share identity', async () => {
  const { events, sink } = collector();
  const withSink = make(sink);
  const without = make();
  const a = await mintCtx(PW, 'corr-p');
  const b = await mintCtx(DW, 'corr-d');
  assert.deepEqual(await withSink.run(a, pmsg), await without.run(a, pmsg));
  assert.deepEqual(await withSink.run(b, dmsg), await without.run(b, dmsg));
  assert.deepEqual(events.map((e) => [e.workspace_id, e.correlation_id]), [[PW, 'corr-p'], [DW, 'corr-d']]);
});

test('entry emitter: throwing, rejecting and hanging sinks never change or delay the result', async () => {
  const baseline = await make().run(await mintCtx(PW, 'corr-f'), pmsg);
  const sinks: Sink[] = [
    { write: () => { throw new Error('CANARY-SINK'); } },
    { write: () => Promise.reject(new Error('CANARY-SINK')) },
    { write: () => new Promise(() => {}) },
  ];
  for (const s of sinks) {
    assert.deepEqual(await make(s).run(await mintCtx(PW, 'corr-f'), pmsg), baseline);
    const bad = await make(s).run(await mintCtx(PW, 'corr-f', 'intake', []), pmsg);
    assert.equal((bad as { ok: boolean }).ok, false);
  }
  await new Promise((r) => setImmediate(r));
});

test('entry emitter: a bad sink fails at setup; a bad clock still returns the normal refusal', async () => {
  assert.throws(() => make({ write: 'x' } as never), (e: Error) => e instanceof RangeError && !e.message.includes('CANARY'));
  assert.throws(() => make({} as never), RangeError);
  const { events, sink } = collector();
  const entry = createIntakeEntry({ registry: createTenantRegistry({ [PW]: pcfg }), provider: provider(), channelRef: 'channel-entry-obs', now: () => 'bad', sink });
  const r = await entry.run(await mintCtx(PW, 'corr-c'), pmsg);
  assert.equal((r as { error?: { code: string } }).error?.code, 'ENTRY_ERROR');
  assert.equal(events.length, 0);
});

test('entry emitter: no customer text, categories, field names or channel reach the sink', async () => {
  const { events, sink } = collector();
  const entry = make(sink);
  await entry.run(await mintCtx(PW, 'corr-l'), pmsg);
  await entry.run(await mintCtx(PW, 'corr-l'), REVIEW);
  const text = JSON.stringify(events);
  for (const x of ['Emergency leak', 'Address', 'Job description', 'Burst pipe', '[ADDRESS_1]', 'PERSON_1', 'channel-entry-obs', 'ws-synthetic-dental']) assert.ok(!text.includes(x), `leaked ${x}`);
});
