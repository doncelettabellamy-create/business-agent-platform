// Tests for QC's bounded read-back of in-doubt human-approved actions: reconcile only on definitive positive evidence, stay uncertain on
// anything missing or ambiguous, and never run the action again. Runs on the in-memory store and on the development-only SQLite store,
// including restarts. Mock provider, mock tools, mock readers, synthetic data only. No network, no key, no real side effect.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIntakeEntry } from '../src/intake-entry.ts';
import { createTenantRegistry } from '../src/tenant-boundary.ts';
import { mintExecutionContext } from '../src/execution-context.ts';
import type { AgentName, ExecutionContext } from '../src/execution-context.ts';
import { mintApproverContext } from '../src/approver-context.ts';
import type { ApproverContext } from '../src/approver-context.ts';
import { approvalScopeFor, decideProposal } from '../src/approval.ts';
import { createInMemoryApprovalStore, verifyEventLog } from '../src/approval-store.ts';
import type { ApprovalStore } from '../src/approval-store.ts';
import { createSqliteApprovalStore } from '../src/approval-store-sqlite.ts';
import type { SqliteApprovalStore } from '../src/approval-store-sqlite.ts';
import { createProcessingEntry, createToolRegistry, humanApprovalExpectations, idempotentToolNames, PROCESSING_RUN_SCOPE } from '../src/processing-entry.ts';
import type { ToolDefinition } from '../src/processing-entry.ts';
import { createDelayedNoteTool, createMockNoteTool, MOCK_NOTE_READ_SCOPE, MOCK_NOTE_SCOPE } from '../src/mock-tools.ts';
import type { DelayedNoteTool, EvidenceReader } from '../src/mock-tools.ts';
import { createQcEntry, QC_RUN_SCOPE } from '../src/qc-entry.ts';
import { createReportingEntry, REPORTING_RUN_SCOPE } from '../src/reporting-entry.ts';
import { createPipeline } from '../src/pipeline.ts';
import { stepIdFor } from '../src/candidate-result.ts';
import { classifyAnswer, createMockProvider, extractAnswer } from '../src/mock-provider.ts';

const CANARY = 'CANARY-RB-5902';
const T0 = '2026-10-26T01:00:00Z';
let clock = T0;
const nowIso = (): string => clock;
const at = (s: string) => { clock = s; };
const plus = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const PW = 'ws-synthetic-plumbing';
const DW = 'ws-synthetic-dental';
const read = (n: string) => JSON.parse(readFileSync(new URL(`../examples/${n}`, import.meta.url), 'utf8'));
const { skill_config: pcfg, ...pmsg } = read('skill-plumbing.json');
const { skill_config: dcfg, ...dmsg } = read('skill-dental.json');
const tick = () => new Promise((r) => setImmediate(r));

const dir = mkdtempSync(join(tmpdir(), 'qc-readback-'));
const openStores: SqliteApprovalStore[] = [];
let fileCounter = 0;
after(() => { for (const s of openStores) s.close(); rmSync(dir, { recursive: true, force: true }); });

let seq = 0;
async function agentCtx(tenant: string, agent: AgentName, scopes: string[], id = 'user-requester', corr = `corr-${++seq}`): Promise<ExecutionContext> {
  const r = await mintExecutionContext({ credential: 'c', agent }, { verify: () => ({ kind: 'user', id }), selectTenant: () => tenant, grants: () => scopes, newCorrelationId: () => corr });
  assert.equal(r.ok, true);
  return (r as { context: ExecutionContext }).context;
}
const procCtx = (tenant = PW) => agentCtx(tenant, 'processing', [PROCESSING_RUN_SCOPE, MOCK_NOTE_SCOPE]);
const advance = (seconds: number) => at(new Date(Date.parse(clock) + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
const qcCtx = (tenant = PW, scopes = [QC_RUN_SCOPE, MOCK_NOTE_READ_SCOPE]) => agentCtx(tenant, 'quality-control', scopes, 'user-qc');
async function approverCtx(tenant = PW, id = 'user-boss'): Promise<ApproverContext> {
  const r = await mintApproverContext({ credential: 'c', workspace_id: tenant }, {
    verify: () => ({ kind: 'user', id, assurance: 'multi-factor', authenticated_at: T0, session_expires_at: '2026-10-26T08:00:00Z' }),
    membership: () => true, grants: () => [approvalScopeFor('mock-note')], newCorrelationId: () => `corr-${id}-${++seq}`, now: nowIso,
  });
  assert.equal(r.ok, true);
  return (r as { context: ApproverContext }).context;
}
const VALUES: Record<string, string> = { Address: '[ADDRESS_1]', 'Job description': 'Burst pipe repair', 'Patient reference': '[ID_1]', 'Insurance provider': 'Example Health' };
const provider = () => createMockProvider({
  classify_request: (req) => classifyAnswer((req.data.categories ?? []).includes('Emergency leak') ? 'Emergency leak' : 'New patient', 0.9),
  extract_fields: (req) => extractAnswer((req.data.fields ?? []).map((f) => ({ name: f.name, value: VALUES[f.name] ?? null, confidence: VALUES[f.name] ? 0.9 : null }))),
});
const intake = createIntakeEntry({ registry: createTenantRegistry({ [PW]: pcfg, [DW]: dcfg }), provider: provider(), channelRef: 'channel-rb-test', now: () => '2026-10-26T01:00:00Z' });
async function handoffFor(tenant = PW, message: Record<string, unknown> = pmsg) {
  const r = await intake.run(await agentCtx(tenant, 'intake', ['intake:run']), message);
  assert.equal(r.ok, true);
  return (r as any).handoff;
}

type Kind = 'memory' | 'sqlite';
const human = (base: { scope: string; run: ToolDefinition['run'] }, o: { idempotent?: boolean; args?: unknown } = {}): ToolDefinition => ({
  scope: base.scope, run: base.run, approval: 'human', ...(o.idempotent !== undefined ? { idempotent: o.idempotent } : {}), ...(o.args !== undefined ? { approvalArguments: o.args } : {}),
});
const failingComplete = (real: ApprovalStore): ApprovalStore => {
  const w: any = { leaseSeconds: real.leaseSeconds };
  for (const m of ['putProposal', 'recordDecision', 'claim', 'resolve', 'get', 'findByStep', 'events'] as const) w[m] = (...a: any[]) => (real as any)[m](...a);
  w.complete = () => { throw new Error(CANARY); };
  return Object.freeze(w);
};
interface Rig {
  kind: Kind; store: ApprovalStore; tools: ReturnType<typeof createToolRegistry>; processing: ReturnType<typeof createProcessingEntry>; file: string | null;
  note: ReturnType<typeof createMockNoteTool>; delayed: DelayedNoteTool | null; reopen(): Rig;
}
function build(kind: Kind, o: { delayed?: boolean; idempotent?: boolean; args?: unknown; unrecordedSuccess?: boolean; file?: string; note?: ReturnType<typeof createMockNoteTool>; delayedTool?: DelayedNoteTool } = {}): Rig {
  const note = o.note ?? createMockNoteTool();
  const delayed = o.delayedTool ?? (o.delayed ? createDelayedNoteTool() : null);
  const tools = createToolRegistry({ 'mock-note': human(delayed ?? note, { ...(o.idempotent !== undefined ? { idempotent: o.idempotent } : {}), ...(o.args !== undefined ? { args: o.args } : {}) }) });
  const cfg = { now: nowIso, idempotentTools: idempotentToolNames(tools) };
  const file = kind === 'sqlite' ? (o.file ?? join(dir, `db-${++fileCounter}.db`)) : null;
  let store: ApprovalStore;
  if (kind === 'sqlite') { const s = createSqliteApprovalStore({ path: file as string, ...cfg }); openStores.push(s); store = s; } else store = createInMemoryApprovalStore(cfg);
  const processing = createProcessingEntry({ tools, plan: ['mock-note'], now: nowIso, timeoutMs: 30, approval: { store: o.unrecordedSuccess ? failingComplete(store) : store } });
  return {
    kind, store, tools, processing, file, note, delayed,
    reopen() {
      if (kind !== 'sqlite') throw new Error('only SQLite can be reopened');
      (store as SqliteApprovalStore).close();
      return build(kind, { ...o, file: file as string, note, ...(delayed ? { delayedTool: delayed } : {}) });
    },
  };
}
async function approve(store: ApprovalStore, pending: any) {
  const ctx = await approverCtx(pending.proposal.workspace_id);
  const d: any = decideProposal(ctx, pending.proposal, { decision: 'approved', reason_code: 'within_policy' }, { now: nowIso });
  assert.equal(d.ok, true, JSON.stringify(d.error));
  const r: any = await store.recordDecision(ctx, d.decision);
  assert.equal(r.ok, true, JSON.stringify(r.error));
}
/** An item whose action was approved and attempted but whose claim was left in doubt. */
async function inDoubt(g: Rig, o: { tenant?: string; message?: Record<string, unknown> } = {}) {
  const tenant = o.tenant ?? PW;
  const h = await handoffFor(tenant, o.message ?? (tenant === PW ? pmsg : dmsg));
  const ctx = await procCtx(tenant);
  const pend: any = ((await g.processing.run(ctx, h)) as any).pending;
  await approve(g.store, pend);
  const cand: any = ((await g.processing.run(ctx, h)) as any).candidate;
  assert.equal(cand.status, 'uncertain');
  advance(120);                                                                // the lease lapses
  const stepId = pend.step_id;
  const st: any = await g.store.findByStep(await qcCtx(tenant), stepId);
  assert.equal(st.snapshot.state, 'in_doubt');
  return { h, ctx, pend, cand, stepId };
}
const stateOf = async (store: ApprovalStore, stepId: string, tenant = PW): Promise<string> => {
  const r: any = await store.findByStep(await qcCtx(tenant), stepId);
  return r.ok ? r.snapshot.state : r.error.code;
};
/** QC with call counters on the store view, the settle capability and the reader. */
function qcFor(g: Rig, o: { settle?: boolean; humanArgs?: unknown; findByStep?: () => unknown; resolve?: () => unknown; list?: (real: any) => unknown; readOne?: (real: any, ref: string) => unknown; snapshot?: (s: any) => any } = {}) {
  const calls = { store: [] as string[], reader: [] as string[], settle: 0 };
  const store: any = {
    findByStep: async (c: unknown, id: unknown) => {
      calls.store.push('findByStep');
      if (o.findByStep) return o.findByStep();
      const r: any = await g.store.findByStep(c, id);
      return r.ok && o.snapshot ? { ok: true, snapshot: o.snapshot(structuredClone(r.snapshot)) } : r;
    },
    events: async (c: unknown, id: unknown) => { calls.store.push('events'); return g.store.events(c, id); },
  };
  const settle = { resolve: async (c: unknown, id: unknown, out: unknown) => { calls.settle++; return o.resolve ? o.resolve() : g.store.resolve(c, id, out); } };
  const source = (g.delayed ?? g.note).reader;
  const reader: EvidenceReader = {
    scope: source.scope,
    list: async (c, item) => { calls.reader.push('list'); return o.list ? o.list(await source.list(c, item)) : source.list(c, item) as any; },
    read: async (c, ref) => { calls.reader.push('read'); return o.readOne ? o.readOne(await source.read(c, ref), ref) : source.read(c, ref) as any; },
  } as any;
  const expectations = o.humanArgs === undefined ? humanApprovalExpectations(g.tools) : { 'mock-note': { arguments: o.humanArgs } };
  const qc = createQcEntry({ plan: ['mock-note'], readers: { 'mock-note': reader }, now: nowIso, timeoutMs: 60, approvals: { store, tools: expectations, ...(o.settle === false ? {} : { settle }) } });
  return { qc, calls };
}
const step0 = (r: any) => r.steps[0];
function each(title: string, fn: (kind: Kind) => Promise<void>) { for (const kind of ['memory', 'sqlite'] as Kind[]) test(`${kind}: ${title}`, () => { at(T0); return fn(kind); }); }
function t(title: string, fn: () => unknown) { test(title, () => { at(T0); return fn(); }); }

// ---------------------------------------------------------------- definitive positive evidence
each('an in-doubt step whose single record is confirmed by a second read is recorded as succeeded, and nothing is run again', async (kind) => {
  const g = build(kind, { unrecordedSuccess: true });
  const f = await inDoubt(g);
  assert.equal(g.note.writes.length, 1, 'the effect happened');
  assert.equal(g.note.calls(), 1);
  const { qc, calls } = qcFor(g);
  const r: any = await qc.reconcile(await qcCtx(), f.h);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual([step0(r).outcome, step0(r).evidence_ref, step0(r).step_id], ['resolved', g.note.writes[0].evidence_ref, f.stepId]);
  assert.deepEqual(calls.reader, ['list', 'read'], 'one listing and one confirming read');
  assert.equal(calls.settle, 1);
  assert.equal(await stateOf(g.store, f.stepId), 'succeeded');
  const events: any = ((await g.store.events(await qcCtx(), f.pend.proposal_id)) as any).events;
  assert.equal(events[events.length - 1].type, 'succeeded');
  assert.equal(events[events.length - 1].data.via, 'resolve');
  assert.equal(verifyEventLog(events), true);
  assert.equal(g.note.calls(), 1, 'QC never ran the action');
  // The next run finds the recorded outcome and makes no call; QC then verifies the whole record.
  const again: any = await g.processing.run(f.ctx, f.h);
  assert.deepEqual([again.candidate.status, again.candidate.evidence_refs], ['complete', [g.note.writes[0].evidence_ref]]);
  assert.equal(g.note.calls(), 1);
  const verdict: any = await qc.run(await qcCtx(), again.candidate, f.h);
  assert.equal(verdict.verdict.verdict, 'pass');
  assert.deepEqual(verdict.verdict.checks.filter((c: any) => c.result !== 'pass'), []);
  const second: any = await qc.reconcile(await qcCtx(), f.h);
  assert.equal(step0(second).outcome, 'not_applicable', 'settling twice does nothing');
  assert.equal(calls.settle, 1);
});

// ---------------------------------------------------------------- missing evidence keeps the step uncertain
each('no record is not proof of failure: the step stays uncertain and nothing is recorded', async (kind) => {
  const g = build(kind, { delayed: true, unrecordedSuccess: true });
  const f = await inDoubt(g);
  const { qc, calls } = qcFor(g);
  const before: any = ((await g.store.events(await qcCtx(), f.pend.proposal_id)) as any).events;
  for (let i = 0; i < 3; i++) {
    const r: any = await qc.reconcile(await qcCtx(), f.h);
    assert.deepEqual([step0(r).outcome, step0(r).reason], ['still_uncertain', 'NO_RECORD']);
  }
  assert.deepEqual([calls.settle, calls.reader.filter((c) => c === 'read').length], [0, 0], 'nothing settled, no confirming read without a record');
  assert.equal(await stateOf(g.store, f.stepId), 'in_doubt');
  assert.deepEqual(((await g.store.events(await qcCtx(), f.pend.proposal_id)) as any).events.slice(0, before.length), before);
  // The abandoned call finally lands, but its late answer could not be recorded by Processing: now the read-back has something definitive.
  (g.delayed as DelayedNoteTool).land(); await tick(); await tick();
  assert.equal(await stateOf(g.store, f.stepId), 'in_doubt', 'still unrecorded');
  const late: any = await qc.reconcile(await qcCtx(), f.h);
  assert.deepEqual([step0(late).outcome, step0(late).evidence_ref], ['resolved', (g.delayed as DelayedNoteTool).writes[0].evidence_ref]);
  assert.equal(await stateOf(g.store, f.stepId), 'succeeded');
  assert.equal((g.delayed as DelayedNoteTool).calls(), 1, 'one call in total, ever');
});

// ---------------------------------------------------------------- ambiguous evidence keeps the step uncertain
each('ambiguous read-backs never settle: duplicates, wrong tenant or item, a record that vanishes or changes, a bad reference', async (kind) => {
  const g = build(kind, { unrecordedSuccess: true });
  const f = await inDoubt(g);
  const rec = g.note.writes[0];
  const cases: [string, Parameters<typeof qcFor>[1]][] = [
    ['two records for the step', { list: (real) => [...real, { ...rec, evidence_ref: 'mock-note:duplicate' }] }],
    ['a record for another tenant', { list: (real) => real.map((r: any) => ({ ...r, workspace_id: DW })) }],
    ['a record for another item', { list: (real) => real.map((r: any) => ({ ...r, item_id: 'wi-ffffffffffff' })) }],
    ['a bad evidence reference', { list: (real) => real.map((r: any) => ({ ...r, evidence_ref: 'has spaces' })) }],
    ['the confirming read finds nothing', { readOne: () => undefined }],
    ['the confirming read finds another record', { readOne: (r) => ({ ...r, evidence_ref: 'mock-note:other' }) }],
    ['the confirming read names another step', { readOne: (r) => ({ ...r, step_id: 'st-ffffffffffff' }) }],
    ['the confirming read names another item', { readOne: (r) => ({ ...r, item_id: 'wi-ffffffffffff' }) }],
  ];
  for (const [name, tamper] of cases) {
    const { qc, calls } = qcFor(g, tamper);
    const r: any = await qc.reconcile(await qcCtx(), f.h);
    assert.equal(step0(r).outcome, 'still_uncertain', name);
    assert.equal(step0(r).reason, 'AMBIGUOUS', name);
    assert.equal(calls.settle, 0, name);
    assert.equal(await stateOf(g.store, f.stepId), 'in_doubt', name);
  }
  // Unrelated records for other steps of the same item are not a reason to refuse.
  const { qc } = qcFor(g, { list: (real) => [...real, { evidence_ref: 'mock-note:st-aaaaaaaaaaaa', step_id: 'st-aaaaaaaaaaaa', item_id: rec.item_id, workspace_id: PW }] });
  assert.equal(step0((await qc.reconcile(await qcCtx(), f.h)) as any).outcome, 'resolved');
});

each('an unreadable read-back keeps the step uncertain, within the time bound', async (kind) => {
  const bad: [string, () => unknown][] = [
    ['throws', () => { throw new Error(CANARY); }], ['rejects', () => Promise.reject(new Error(CANARY))], ['hangs', () => new Promise(() => {})], ['garbage', () => 'nope'],
  ];
  for (const [name, behave] of bad) {
    const g = build(kind, { unrecordedSuccess: true });
    const f = await inDoubt(g, { message: { ...pmsg, event_id: `evt-synthetic-rb-${name}` } });
    for (const which of ['list', 'read'] as const) {
      const { qc, calls } = qcFor(g, which === 'list' ? { list: behave as never } : { readOne: behave as never });
      const started = Date.now();
      const r: any = await qc.reconcile(await qcCtx(), f.h);
      assert.deepEqual([step0(r).outcome, step0(r).reason], ['still_uncertain', 'READ_FAILED'], `${name} ${which}`);
      assert.ok(Date.now() - started < 2000, 'bounded');
      assert.equal(calls.settle, 0);
      assert.ok(!JSON.stringify(r).includes('CANARY'));
    }
    assert.equal(await stateOf(g.store, f.stepId), 'in_doubt', name);
  }
});

// ---------------------------------------------------------------- only an approved, expected, in-doubt action may be settled
each('only an in-doubt claim is settled: an open lease, a finished step and a request that was never claimed are left alone', async (kind) => {
  const g = build(kind, { delayed: true });
  const h = await handoffFor(); const ctx = await procCtx();
  const pend: any = ((await g.processing.run(ctx, h)) as any).pending;
  const { qc, calls } = qcFor(g);
  const requested: any = await qc.reconcile(await qcCtx(), h);
  assert.equal(step0(requested).outcome, 'not_applicable', 'requested');
  await approve(g.store, pend);
  const approved: any = await qc.reconcile(await qcCtx(), h);
  assert.equal(step0(approved).outcome, 'not_applicable', 'approved, not yet claimed');
  await g.processing.run(ctx, h);                                              // claim, then the call times out: claimed with the lease open
  const open: any = await qc.reconcile(await qcCtx(), h);
  assert.deepEqual([step0(open).outcome, step0(open).reason], ['still_uncertain', 'IN_PROGRESS']);
  assert.deepEqual([calls.settle, calls.reader], [0, []], 'no read-back while a lease is open');
  assert.equal(await stateOf(g.store, pend.step_id), 'claimed');
});

each('a declined or already-finished step is not touched', async (kind) => {
  const g = build(kind);
  const h = await handoffFor(); const ctx = await procCtx();
  const pend: any = ((await g.processing.run(ctx, h)) as any).pending;
  const pctx = await approverCtx();
  const d: any = decideProposal(pctx, pend.proposal, { decision: 'declined', reason_code: 'outside_policy' }, { now: nowIso });
  await g.store.recordDecision(pctx, d.decision);
  const { qc, calls } = qcFor(g);
  assert.equal(step0((await qc.reconcile(await qcCtx(), h)) as any).outcome, 'not_applicable');
  assert.equal(calls.settle, 0);
  const done = build(kind);
  const h2 = await handoffFor(PW, { ...pmsg, event_id: 'evt-synthetic-done' });
  const p2: any = ((await done.processing.run(ctx, h2)) as any).pending;
  await approve(done.store, p2);
  await done.processing.run(ctx, h2);
  const q2 = qcFor(done);
  assert.equal(step0((await q2.qc.reconcile(await qcCtx(), h2)) as any).outcome, 'not_applicable', 'succeeded');
  assert.equal(q2.calls.settle, 0);
});

each('an action QC does not expect, or one nobody approved, is not settled even when a record exists', async (kind) => {
  const g = build(kind, { unrecordedSuccess: true, args: { mode: 'a' } });
  const f = await inDoubt(g);
  const wrongArgs = qcFor(g, { humanArgs: { mode: 'b' } });
  const r1: any = await wrongArgs.qc.reconcile(await qcCtx(), f.h);
  assert.deepEqual([step0(r1).outcome, step0(r1).reason], ['still_uncertain', 'MISMATCH']);
  assert.deepEqual([wrongArgs.calls.settle, wrongArgs.calls.reader], [0, []], 'no read-back for an action QC does not expect');
  for (const [name, snapshot] of [
    ['self-approved', (s: any) => ({ ...s, decision: { ...s.decision, approver_id: s.requested_by_id } })],
    ['declined', (s: any) => ({ ...s, decision: { ...s.decision, decision: 'declined' } })],
    ['no decision', (s: any) => { const { decision, ...rest } = s; void decision; return rest; }],
  ] as [string, (s: any) => any][]) {
    const q = qcFor(g, { snapshot });
    const r: any = await q.qc.reconcile(await qcCtx(), f.h);
    assert.deepEqual([step0(r).outcome, step0(r).reason], ['still_uncertain', 'NOT_APPROVED'], name);
    assert.deepEqual([q.calls.settle, q.calls.reader], [0, []], name);
  }
  assert.equal(await stateOf(g.store, f.stepId), 'in_doubt');
});

each('if the store cannot be read, or refuses to record, the step stays uncertain', async (kind) => {
  const g = build(kind, { unrecordedSuccess: true });
  const f = await inDoubt(g);
  const bad: [string, () => unknown][] = [
    ['throws', () => { throw new Error(CANARY); }], ['rejects', () => Promise.reject(new Error(CANARY))], ['hangs', () => new Promise(() => {})],
    ['garbage', () => 'nope'], ['half answer', () => ({ ok: false })], ['refuses', () => ({ ok: false, error: { code: 'STORE_ERROR', message: 'x' } })],
  ];
  for (const [name, findByStep] of bad) {
    const q = qcFor(g, { findByStep });
    const r: any = await q.qc.reconcile(await qcCtx(), f.h);
    assert.deepEqual([step0(r).outcome, step0(r).reason], ['still_uncertain', 'STORE_UNREADABLE'], `lookup ${name}`);
    assert.deepEqual([q.calls.settle, q.calls.reader], [0, []]);
  }
  for (const [name, resolve] of bad) {
    const q = qcFor(g, { resolve });
    const r: any = await q.qc.reconcile(await qcCtx(), f.h);
    assert.deepEqual([step0(r).outcome, step0(r).reason], ['still_uncertain', 'RESOLVE_FAILED'], `record ${name}`);
    assert.equal(q.calls.settle, 1, name);
    assert.equal(await stateOf(g.store, f.stepId), 'in_doubt', `record ${name}: nothing was recorded`);
  }
  assert.equal(step0((await qcFor(g).qc.reconcile(await qcCtx(), f.h)) as any).outcome, 'resolved', 'and when the store is healthy again it settles');
});

// ---------------------------------------------------------------- restarts
test('sqlite: an in-doubt step survives a restart and is settled by a fresh QC against the reopened store', async () => {
  at(T0);
  const note = createMockNoteTool();
  let g = build('sqlite', { unrecordedSuccess: true, note });
  const f = await inDoubt(g);
  g = g.reopen();
  assert.equal(await stateOf(g.store, f.stepId), 'in_doubt', 'still in doubt after the restart');
  const { qc } = qcFor(g);
  const r: any = await qc.reconcile(await qcCtx(), f.h);
  assert.deepEqual([step0(r).outcome, step0(r).evidence_ref], ['resolved', note.writes[0].evidence_ref]);
  g = g.reopen();
  assert.equal(await stateOf(g.store, f.stepId), 'succeeded', 'and the settlement survives another restart');
  const events: any = ((await g.store.events(await qcCtx(), f.pend.proposal_id)) as any).events;
  assert.deepEqual(events.map((e: any) => e.type), ['requested', 'approved', 'claimed', 'lease_lapsed', 'succeeded']);
  assert.equal(verifyEventLog(events), true);
  assert.equal(step0((await qcFor(g).qc.reconcile(await qcCtx(), f.h)) as any).outcome, 'not_applicable');
  const run: any = await g.processing.run(f.ctx, f.h);
  assert.equal(run.candidate.status, 'complete');
  assert.equal(note.calls(), 1, 'across all of this the tool was called once');
});

test('sqlite: without a record the step stays uncertain across restarts, and an idempotent tool is not retried by QC or by the restart', async () => {
  at(T0);
  const tool = createDelayedNoteTool();
  let g = build('sqlite', { delayedTool: tool, idempotent: true, unrecordedSuccess: true });
  const f = await inDoubt(g);
  g = g.reopen();
  const { qc } = qcFor(g);
  const r: any = await qc.reconcile(await qcCtx(), f.h);
  assert.deepEqual([step0(r).outcome, step0(r).reason], ['still_uncertain', 'NO_RECORD']);
  assert.equal(tool.calls(), 1, 'QC does not run the action; only a Processing run could, and none was asked to');
  assert.equal(await stateOf(g.store, f.stepId), 'in_doubt');
});

// ---------------------------------------------------------------- authority and tenants
t('reconcile needs a trusted QC context with its scopes, a sealed envelope for the same tenant, and the capability to settle', async () => {
  const g = build('memory', { unrecordedSuccess: true });
  const f = await inDoubt(g);
  const { qc, calls } = qcFor(g);
  const code = (r: any) => (r.ok ? 'ok' : r.error.code);
  const good = await qcCtx();
  for (const bad of [{ ...good }, structuredClone(good), new Proxy(good, {}), null, undefined, 'ctx']) assert.equal(code(await qc.reconcile(bad, f.h)), 'CONTEXT_NOT_TRUSTED');
  assert.equal(code(await qc.reconcile(await agentCtx(PW, 'processing', [PROCESSING_RUN_SCOPE, QC_RUN_SCOPE, MOCK_NOTE_READ_SCOPE]), f.h)), 'WRONG_RECIPIENT');
  assert.equal(code(await qc.reconcile(await qcCtx(PW, [MOCK_NOTE_READ_SCOPE]), f.h)), 'QC_NOT_PERMITTED');
  assert.equal(code(await qc.reconcile(await qcCtx(PW, [QC_RUN_SCOPE]), f.h)), 'QC_NOT_PERMITTED');
  for (const bad of [structuredClone(f.h), { ...f.h }, null, undefined, 'x', {}, new Proxy(f.h, {})]) assert.ok(['HANDOFF_NOT_TRUSTED', 'ENVELOPE_INVALID'].includes(code(await qc.reconcile(good, bad))));
  assert.equal(code(await qc.reconcile(await qcCtx(DW), f.h)), 'TENANT_MISMATCH');
  assert.deepEqual([calls.settle, calls.reader, calls.store], [0, [], []], 'refusals touched nothing');
  const noSettle = qcFor(g, { settle: false });
  assert.equal(code(await noSettle.qc.reconcile(good, f.h)), 'QC_NOT_PERMITTED', 'a QC that was not given the capability cannot settle');
  const noHuman = createQcEntry({ plan: ['mock-note'], readers: { 'mock-note': g.note.reader }, now: nowIso });
  assert.equal(code(await noHuman.reconcile(good, f.h)), 'QC_NOT_PERMITTED');
  assert.equal(await stateOf(g.store, f.stepId), 'in_doubt');
});

each('tenants are separate: another tenant\'s QC finds nothing to settle and cannot read this tenant\'s record', async (kind) => {
  const g = build(kind, { unrecordedSuccess: true });
  const p = await inDoubt(g, { tenant: PW });
  const d = await inDoubt(g, { tenant: DW });
  const { qc, calls } = qcFor(g);
  const mine: any = await qc.reconcile(await qcCtx(DW), d.h);
  assert.equal(step0(mine).step_id, d.stepId);
  assert.notEqual(d.stepId, p.stepId);
  assert.equal(await stateOf(g.store, p.stepId, PW), 'in_doubt', 'the other tenant\'s step is untouched by a DW reconcile');
  const crossed: any = await qc.reconcile(await qcCtx(DW), p.h);
  assert.equal(crossed.ok, false);
  assert.equal(crossed.error.code, 'TENANT_MISMATCH');
  void calls;
});

// ---------------------------------------------------------------- judging stays read-only
each('judging a verdict never settles anything, even when the record is in doubt', async (kind) => {
  const g = build(kind, { unrecordedSuccess: true });
  const f = await inDoubt(g);
  const { qc, calls } = qcFor(g);
  const r: any = await qc.run(await qcCtx(), f.cand, f.h);
  assert.equal(r.verdict.verdict, 'escalate');
  assert.equal(calls.settle, 0);
  assert.ok(calls.store.every((c) => c === 'findByStep' || c === 'events'));
  assert.equal(await stateOf(g.store, f.stepId), 'in_doubt');
});

t('the old verdict stays what it was: reconciling later does not change an issued candidate, and Reporting keeps its first outcome', async () => {
  const note = createMockNoteTool();
  const g = build('memory', { unrecordedSuccess: true, note });
  const tools = g.tools;
  const reporting = createReportingEntry({ now: nowIso });
  let n = 0;
  const qcEntry = createQcEntry({
    plan: ['mock-note'], readers: { 'mock-note': note.reader }, now: nowIso,
    approvals: { store: g.store, settle: g.store, tools: humanApprovalExpectations(tools) },
  });
  const pipeline = createPipeline({
    intake, processing: g.processing, qc: qcEntry, reporting, processingToolScopes: [MOCK_NOTE_SCOPE], qcReaderScopes: [MOCK_NOTE_READ_SCOPE],
    sources: {
      verify: (c: unknown) => (c === 'cred' ? { kind: 'user', id: 'user-plumbing' } : undefined), selectTenant: () => PW,
      grants: () => ['intake:run', 'processing:run', MOCK_NOTE_SCOPE, 'quality-control:run', MOCK_NOTE_READ_SCOPE, 'reporting:run'], newCorrelationId: () => `corr-rb-${++n}`,
    },
  });
  const first: any = await pipeline.run('cred', pmsg);
  await approve(g.store, first.pending);
  const second: any = await pipeline.run('cred', pmsg);
  assert.deepEqual([second.outcome, second.verdict, second.report.counts.escalate, second.report.counts.verified_simulated_pass], ['reported', 'escalate', 1, 0]);
  at(plus(120));
  const h = await handoffFor();
  const settled: any = await qcEntry.reconcile(await qcCtx(), h);
  assert.equal(step0(settled).outcome, 'resolved');
  const third: any = await pipeline.run('cred', pmsg);
  assert.deepEqual([third.verdict, third.counted], ['pass', 'repeat'], 'the new candidate passes, but Reporting counts it as a repeat attempt');
  assert.deepEqual([third.report.counts.escalate, third.report.counts.verified_simulated_pass, third.report.counts.repeat_attempts], [1, 0, 1], 'the first outcome stands (a recorded limit)');
  assert.equal(note.calls(), 1);
});

// ---------------------------------------------------------------- setup and inventory
t('setup: the settle capability must provide resolve, and a QC given it can still only judge until reconcile is called', () => {
  const note = createMockNoteTool();
  const tools = createToolRegistry({ 'mock-note': human(note) });
  const store = createInMemoryApprovalStore({ now: nowIso });
  const base = { plan: ['mock-note'], readers: { 'mock-note': note.reader }, now: nowIso };
  for (const bad of [null, {}, { resolve: 'x' }, 'resolve']) {
    assert.throws(() => createQcEntry({ ...base, approvals: { store, tools: humanApprovalExpectations(tools), settle: bad as never } }), (e: Error) => e instanceof RangeError && !e.message.includes('CANARY'));
  }
  assert.doesNotThrow(() => createQcEntry({ ...base, approvals: { store, tools: humanApprovalExpectations(tools), settle: store } }));
  const q = createQcEntry({ ...base, approvals: { store, tools: humanApprovalExpectations(tools), settle: store } });
  assert.deepEqual(Object.keys(q).sort(), ['reconcile', 'run']);
  assert.ok(Object.isFrozen(q));
});

t('inventory: QC settles in exactly one place, reads back with two reader calls, has no tool, and imports none', () => {
  const dirSrc = new URL('../src/', import.meta.url);
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const code = strip(readFileSync(new URL('qc-entry.ts', dirSrc), 'utf8'));
  const start = code.indexOf('async function reconcileStep');
  const end = code.indexOf('async function reconcileInner');
  const body = code.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.equal((code.match(/\bsettle\.resolve\(/g) ?? []).length, 1);
  assert.ok(body.includes('settle.resolve('), 'and it is inside the read-back');
  assert.deepEqual([...body.matchAll(/reader\.(\w+)\(/g)].map((m) => m[1]), ['list', 'read'], 'the read-back uses a listing and one confirming read, nothing else');
  assert.ok(!/status:\s*'failed'/.test(body), 'the read-back never records a failure from an absence');
  assert.ok(!/\.run\(/.test(code.replace(/qc\.run\(/g, '')), 'QC never runs a tool');
  assert.ok(!/import \{[^}]*\} from '\.\/mock-tools\.ts'/.test(code), 'QC takes the mock tools module as types only');
  const files = readdirSync(dirSrc).filter((f) => f.endsWith('.ts'));
  const callers = files.filter((f) => !['approval-store.ts', 'approval-store-sqlite.ts'].includes(f) && /\bsettle\.resolve\(/.test(strip(readFileSync(new URL(f, dirSrc), 'utf8'))));
  assert.deepEqual(callers, ['qc-entry.ts'], 'only QC settles');
});
