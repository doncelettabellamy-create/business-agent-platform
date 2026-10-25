// End-to-end tests for the pipeline's bounded recovery of an escalated, uncertain human-approved action: the first outcome is reported and
// never changed, QC reconciles once, and only if something was settled one fresh verification runs. Nothing is ever executed again by
// recovery. Runs on the in-memory store and on the development-only SQLite store, including restarts. Mock provider, tools and readers,
// synthetic data only. No network, no key, no real side effect.
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
import { createInMemoryApprovalStore } from '../src/approval-store.ts';
import type { ApprovalStore } from '../src/approval-store.ts';
import { createSqliteApprovalStore } from '../src/approval-store-sqlite.ts';
import type { SqliteApprovalStore } from '../src/approval-store-sqlite.ts';
import { createProcessingEntry, createToolRegistry, humanApprovalExpectations, idempotentToolNames, PROCESSING_RUN_SCOPE } from '../src/processing-entry.ts';
import type { ToolDefinition } from '../src/processing-entry.ts';
import { createDelayedNoteTool, createMockNoteTool, MOCK_NOTE_READ_SCOPE, MOCK_NOTE_SCOPE } from '../src/mock-tools.ts';
import type { DelayedNoteTool } from '../src/mock-tools.ts';
import { createQcEntry } from '../src/qc-entry.ts';
import { createReportingEntry, REPORTING_RUN_SCOPE } from '../src/reporting-entry.ts';
import { createPipeline } from '../src/pipeline.ts';
import { validateReport } from '../src/report.ts';
import { classifyAnswer, createMockProvider, extractAnswer } from '../src/mock-provider.ts';

const CANARY = 'CANARY-REC-4471';
const T0 = '2026-10-26T02:00:00Z';
let clock = T0;
const nowIso = (): string => clock;
const at = (s: string) => { clock = s; };
const advance = (seconds: number) => at(new Date(Date.parse(clock) + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
const PW = 'ws-synthetic-plumbing';
const DW = 'ws-synthetic-dental';
const read = (n: string) => JSON.parse(readFileSync(new URL(`../examples/${n}`, import.meta.url), 'utf8'));
const { skill_config: pcfg, ...pmsg } = read('skill-plumbing.json');
const { skill_config: dcfg, ...dmsg } = read('skill-dental.json');
const tick = () => new Promise((r) => setImmediate(r));

const dir = mkdtempSync(join(tmpdir(), 'pipeline-recovery-'));
const openStores: SqliteApprovalStore[] = [];
let fileCounter = 0;
after(() => { for (const s of openStores) s.close(); rmSync(dir, { recursive: true, force: true }); });

let seq = 0;
async function agentCtx(tenant: string, agent: AgentName, scopes: string[], id = 'user-requester'): Promise<ExecutionContext> {
  const r = await mintExecutionContext({ credential: 'c', agent }, { verify: () => ({ kind: 'user', id }), selectTenant: () => tenant, grants: () => scopes, newCorrelationId: () => `corr-x-${++seq}` });
  assert.equal(r.ok, true);
  return (r as { context: ExecutionContext }).context;
}
async function approverCtx(tenant = PW, id = 'user-boss'): Promise<ApproverContext> {
  const r = await mintApproverContext({ credential: 'c', workspace_id: tenant }, {
    verify: () => ({ kind: 'user', id, assurance: 'multi-factor', authenticated_at: T0, session_expires_at: '2026-10-26T12:00:00Z' }),
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
const intake = createIntakeEntry({ registry: createTenantRegistry({ [PW]: pcfg, [DW]: dcfg }), provider: provider(), channelRef: 'channel-rec-test', now: () => '2026-10-26T02:00:00Z' });

type Kind = 'memory' | 'sqlite';
const human = (base: { scope: string; run: ToolDefinition['run'] }, idempotent?: boolean): ToolDefinition => ({
  scope: base.scope, run: base.run, approval: 'human', ...(idempotent !== undefined ? { idempotent } : {}),
});
const failingComplete = (real: ApprovalStore): ApprovalStore => {
  const w: any = { leaseSeconds: real.leaseSeconds };
  for (const m of ['putProposal', 'recordDecision', 'claim', 'resolve', 'get', 'findByStep', 'events'] as const) w[m] = (...a: any[]) => (real as any)[m](...a);
  w.complete = () => { throw new Error(CANARY); };
  return Object.freeze(w);
};
interface Opts { kind: Kind; delayed?: boolean; idempotent?: boolean; unrecordedSuccess?: boolean; recover?: boolean | undefined; settle?: boolean; readerWrap?: (reader: any) => any; qcWrap?: (c: Counts, qc: any) => any; processingWrap?: (c: Counts, p: any) => any; reportingWrap?: (c: Counts, r: any) => any; stageTimeoutMs?: number; sleep?: (ms: number) => unknown }
interface Counts { processing: number; qcRun: number; reconcile: number; submit: number }
interface Rig {
  pipeline: ReturnType<typeof createPipeline>; store: ApprovalStore; counts: Counts; note: ReturnType<typeof createMockNoteTool>; delayed: DelayedNoteTool | null; tool: { calls(): number; writes: readonly unknown[] };
  reporting: ReturnType<typeof createReportingEntry>; reopen(): Rig; file: string | null; opts: Opts;
}
function build(o: Opts, keep?: { file: string; note: ReturnType<typeof createMockNoteTool>; delayed: DelayedNoteTool | null; reporting: ReturnType<typeof createReportingEntry>; counts: Counts }): Rig {
  const note = keep?.note ?? createMockNoteTool();
  const delayed = keep ? keep.delayed : (o.delayed ? createDelayedNoteTool() : null);
  const tool = delayed ?? note;
  const tools = createToolRegistry({ 'mock-note': human(tool, o.idempotent) });
  const cfg = { now: nowIso, idempotentTools: idempotentToolNames(tools) };
  const file = o.kind === 'sqlite' ? (keep?.file ?? join(dir, `db-${++fileCounter}.db`)) : null;
  let store: ApprovalStore;
  if (o.kind === 'sqlite') { const s = createSqliteApprovalStore({ path: file as string, ...cfg }); openStores.push(s); store = s; } else store = createInMemoryApprovalStore(cfg);
  const counts: Counts = keep?.counts ?? { processing: 0, qcRun: 0, reconcile: 0, submit: 0 };
  const processing = createProcessingEntry({ tools, plan: ['mock-note'], now: nowIso, timeoutMs: 30, approval: { store: o.unrecordedSuccess ? failingComplete(store) : store } });
  const qc = createQcEntry({
    plan: ['mock-note'], readers: { 'mock-note': o.readerWrap ? o.readerWrap(tool.reader) : tool.reader }, now: nowIso, timeoutMs: 60,
    approvals: { store, tools: humanApprovalExpectations(tools), ...(o.settle === false ? {} : { settle: store }) },
  });
  const reporting = keep?.reporting ?? createReportingEntry({ now: nowIso });
  const pw = { run: (c: any, e: any) => { counts.processing++; return processing.run(c, e); } };
  const qw = { run: (...a: any[]) => { counts.qcRun++; return (qc.run as any)(...a); }, reconcile: (...a: any[]) => { counts.reconcile++; return (qc.reconcile as any)(...a); } };
  const rw = { submit: (...a: any[]) => { counts.submit++; return (reporting.submit as any)(...a); }, report: (c: any) => reporting.report(c) };
  let n = 0;
  const pipeline = createPipeline({
    intake, processing: o.processingWrap ? o.processingWrap(counts, pw) : pw, qc: o.qcWrap ? o.qcWrap(counts, qw) : qw, reporting: o.reportingWrap ? o.reportingWrap(counts, rw) : rw,
    processingToolScopes: [MOCK_NOTE_SCOPE], qcReaderScopes: [MOCK_NOTE_READ_SCOPE], stageTimeoutMs: o.stageTimeoutMs ?? 500,
    sleep: o.sleep ?? (async () => { advance(1); }),   // recovery waits for QC's clock to pass the first verdict's second
    ...(o.recover === undefined ? {} : { recoverUncertain: o.recover }),
    sources: {
      verify: (c: unknown) => (c === 'cred-plumbing' ? { kind: 'user', id: 'user-plumbing' } : c === 'cred-dental' ? { kind: 'user', id: 'user-dental' } : undefined),
      selectTenant: (id: { id: string }) => (id.id === 'user-plumbing' ? PW : DW),
      grants: () => ['intake:run', 'processing:run', MOCK_NOTE_SCOPE, 'quality-control:run', MOCK_NOTE_READ_SCOPE, 'reporting:run'], newCorrelationId: () => `corr-rec-${++seq}-${++n}`,
    },
  });
  return {
    pipeline, store, counts, note, delayed, tool, reporting, file, opts: o,
    reopen() {
      if (o.kind !== 'sqlite') throw new Error('only SQLite can be reopened');
      (store as SqliteApprovalStore).close();
      return build(o, { file: file as string, note, delayed, reporting, counts });
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
/** Pause, approve, and run once more: the action is attempted and its outcome is not recorded. */
async function attempted(g: Rig, cred = 'cred-plumbing', message: Record<string, unknown> = pmsg) {
  const first: any = await g.pipeline.run(cred, message);
  assert.equal(first.outcome, 'awaiting-approval', JSON.stringify(first.error));
  await approve(g.store, first.pending);
  const second: any = await g.pipeline.run(cred, message);
  assert.equal(second.outcome, 'reported', JSON.stringify(second.error));
  return { first, second, stepId: first.pending.step_id as string, proposalId: first.pending.proposal_id as string };
}
const stateOf = async (g: Rig, stepId: string, tenant = PW): Promise<string> => {
  const r: any = await g.store.findByStep(await agentCtx(tenant, 'quality-control', ['quality-control:run']), stepId);
  return r.ok ? r.snapshot.state : r.error.code;
};
const counts = (r: any) => r.report.counts;
function each(title: string, fn: (kind: Kind) => Promise<void>) { for (const kind of ['memory', 'sqlite'] as Kind[]) test(`${kind}: ${title}`, () => { at(T0); return fn(kind); }); }
function t(title: string, fn: () => unknown) { test(title, () => { at(T0); return fn(); }); }

// ---------------------------------------------------------------- the whole recovery
each('a lapsed, unrecorded success is escalated first, then reconciled and freshly verified; the first report is kept and nothing is repeated', async (kind) => {
  const g = build({ kind, unrecordedSuccess: true, recover: true });
  const a = await attempted(g);
  // Run 2: the tool ran and its success could not be recorded. The claim is still open, so there is nothing to settle yet.
  assert.deepEqual([a.second.verdict, a.second.counted], ['escalate', 'accepted']);
  assert.deepEqual([a.second.recovery.attempted, a.second.recovery.settled, a.second.recovery.stopped, a.second.recovery.steps[0].reason], [true, false, 'NOTHING_SETTLED', 'IN_PROGRESS']);
  assert.equal(g.tool.calls(), 1);
  assert.equal(await stateOf(g, a.stepId), 'claimed');

  advance(120);                                                                 // the lease lapses: in doubt
  const before = { reconcile: g.counts.reconcile, processing: g.counts.processing, qcRun: g.counts.qcRun, submit: g.counts.submit };
  const third: any = await g.pipeline.run('cred-plumbing', pmsg);
  assert.equal(third.outcome, 'reported');
  // The pipeline made exactly one recovery round: one reconcile, and one fresh Processing, QC and Reporting step on top of the normal run.
  assert.deepEqual([g.counts.reconcile - before.reconcile, g.counts.processing - before.processing, g.counts.qcRun - before.qcRun, g.counts.submit - before.submit], [1, 2, 3, 2]);   // QC ran a third time: the fresh verdict fell in the first one's second, so QC judged the same candidate again after the sleep
  assert.deepEqual([third.recovery.settled, third.recovery.first, third.recovery.fresh, third.recovery.stopped], [true, { verdict: 'escalate', counted: 'repeat' }, { verdict: 'pass', counted: 'repeat' }, undefined]);
  assert.deepEqual(third.recovery.steps.map((s: any) => s.outcome), ['resolved']);
  assert.deepEqual([third.verdict, third.counted], ['pass', 'repeat'], 'the final state is the fresh verification, labelled as a repeat');
  // The report as it stood before recovery is kept beside the final one, and neither overwrote the first outcome.
  assert.deepEqual(validateReport(third.prior_report), []);
  assert.deepEqual([third.prior_report.counts.escalate, third.prior_report.counts.verified_simulated_pass, third.prior_report.counts.repeat_attempts], [1, 0, 1]);
  assert.deepEqual([counts(third).escalate, counts(third).verified_simulated_pass, counts(third).repeat_attempts, counts(third).counted_items], [1, 0, 2, 1]);
  assert.equal(third.report.chains[0].outcome, 'escalate', 'the first outcome stands in the report');
  assert.equal(g.tool.calls(), 1, 'the action was never repeated');
  assert.equal(g.note.writes.length, 1);
  assert.equal(await stateOf(g, a.stepId), 'succeeded');
  // Later runs find the recorded outcome and need no recovery.
  const reconcileBefore = g.counts.reconcile;
  const fourth: any = await g.pipeline.run('cred-plumbing', pmsg);
  assert.deepEqual([fourth.verdict, fourth.counted, fourth.recovery, fourth.prior_report], ['pass', 'repeat', undefined, undefined]);
  assert.equal(g.counts.reconcile, reconcileBefore, 'no further reconcile');
  assert.equal(g.tool.calls(), 1);
  assert.ok(Object.isFrozen(third.recovery) && Object.isFrozen(third.recovery.steps));
  assert.ok(!JSON.stringify([third.recovery, third.prior_report]).match(/CANARY|Emergency|Address|Burst|mock-note/));
});

// ---------------------------------------------------------------- the fresh verdict must be strictly later (Option A)
/** Runs the lapsed-success scenario up to the recovery run and returns the recovery run's result with what changed in it. */
async function recoveryRun(g: ReturnType<typeof build>) {
  const a = await attempted(g);
  advance(120);
  const before = { reconcile: g.counts.reconcile, processing: g.counts.processing, qcRun: g.counts.qcRun, submit: g.counts.submit };
  const third: any = await g.pipeline.run('cred-plumbing', pmsg);
  const d = { reconcile: g.counts.reconcile - before.reconcile, processing: g.counts.processing - before.processing, qcRun: g.counts.qcRun - before.qcRun, submit: g.counts.submit - before.submit };
  return { a, third, d };
}
/** After a stop, nothing from the fresh pass is filed, the first escalation stands, and the action ran exactly once. */
function assertStoppedSafely(g: ReturnType<typeof build>, r: Awaited<ReturnType<typeof recoveryRun>>) {
  assert.equal(r.third.outcome, 'reported');
  assert.deepEqual([r.third.recovery.settled, r.third.recovery.stopped, r.third.recovery.fresh], [true, 'FRESH_NOT_LATER', undefined]);
  assert.deepEqual([r.third.verdict, r.third.counted], ['escalate', 'repeat'], 'the result is still the escalation that was already reported');
  assert.equal(r.d.reconcile, 1);
  assert.equal(r.d.submit, 1, 'only the normal run was filed; the fresh verdict was not');
  assert.equal(g.tool.calls(), 1, 'the approved action was never repeated');
  assert.equal(g.note.writes.length, 1);
  assert.equal(r.third.report.statuses[0].current, 'escalate');
  assert.equal(r.third.report.counts.repeat_attempts, 1);
  assert.deepEqual(validateReport(r.third.report), []);
  assert.ok(!JSON.stringify(r.third).includes(CANARY));
}

each('same second: QC judges the same candidate once more after one injected sleep, then the later verdict is filed', async (kind) => {
  const slept: unknown[] = [];
  const g = build({ kind, unrecordedSuccess: true, recover: true, sleep: async (ms) => { slept.push(ms); advance(1); } });
  const r = await recoveryRun(g);
  assert.deepEqual(slept, [1000], 'one sleep of one second, no more');
  assert.deepEqual([r.d.processing, r.d.qcRun, r.d.submit], [2, 3, 2], 'Processing is not run again for the retry; QC is');
  assert.deepEqual([r.third.recovery.stopped, r.third.recovery.fresh], [undefined, { verdict: 'pass', counted: 'repeat' }]);
  assert.equal(r.third.report.statuses[0].current, 'pass', 'the later verdict now promotes the item');
  assert.equal(g.tool.calls(), 1);
});
each('a QC clock that already moved on needs no sleep and no retry', async (kind) => {
  let slept = 0;
  const g = build({
    kind, unrecordedSuccess: true, recover: true, sleep: async () => { slept++; },
    qcWrap: (_c, qc) => ({ run: async (...a: any[]) => { advance(1); return (qc.run as any)(...a); }, reconcile: (...a: any[]) => qc.reconcile(...a) }),
  });
  const r = await recoveryRun(g);
  assert.equal(slept, 0);
  assert.deepEqual([r.d.qcRun, r.third.recovery.stopped, r.third.report.statuses[0].current], [2, undefined, 'pass']);
});
each('frozen clock: after one sleep and one retry the pipeline stops with FRESH_NOT_LATER and files nothing more', async (kind) => {
  let slept = 0;
  const g = build({ kind, unrecordedSuccess: true, recover: true, sleep: async () => { slept++; } });
  const r = await recoveryRun(g);
  assert.equal(slept, 1);
  assert.equal(r.d.qcRun, 3, 'one retry, never a loop');
  assertStoppedSafely(g, r);
});
each('backward clock: a verdict that is earlier than the first is not accepted either', async (kind) => {
  const g = build({ kind, unrecordedSuccess: true, recover: true, sleep: async () => { advance(-30); } });
  const r = await recoveryRun(g);
  assert.equal(r.d.qcRun, 3);
  assertStoppedSafely(g, r);
});
each('stale result: a replayed copy of the first verdict, or a sleep that throws or hangs, cannot get a fresh verdict filed', async (kind) => {
  let armed = false; let n = 0; let firstResult: any;
  const g = build({
    kind, unrecordedSuccess: true, recover: true, sleep: async () => { advance(1); },
    qcWrap: (_c, qc) => ({
      run: async (...a: any[]) => { const res = await (qc.run as any)(...a); if (!armed) return res; n++; if (n === 1) firstResult = res; return n === 3 ? firstResult : res; },
      reconcile: (...a: any[]) => qc.reconcile(...a),
    }),
  });
  const first = await attempted(g);
  assert.equal(first.second.verdict, 'escalate');
  advance(120);
  armed = true;
  const before = { submit: g.counts.submit, qcRun: g.counts.qcRun };
  const third: any = await g.pipeline.run('cred-plumbing', pmsg);
  assert.equal(g.counts.qcRun - before.qcRun, 3);
  assert.deepEqual([third.recovery.stopped, third.recovery.fresh, g.counts.submit - before.submit], ['FRESH_NOT_LATER', undefined, 1]);
  assert.equal(third.report.statuses[0].current, 'escalate');
  assert.equal(g.tool.calls(), 1);

  for (const bad of [async () => { throw new Error(CANARY); }, () => { throw new Error(CANARY); }, () => new Promise(() => {})] as ((ms: number) => unknown)[]) {
    at(T0);
    const h = build({ kind, unrecordedSuccess: true, recover: true, sleep: bad, stageTimeoutMs: 80 });
    assertStoppedSafely(h, await recoveryRun(h));   // a sleep that throws or hangs only ends the wait; the retry still sees the same second and stops
  }
});
// ---------------------------------------------------------------- unresolved recovery keeps the escalation
each('with no record the escalation stays, no fresh round runs, and a non-idempotent action is never repeated', async (kind) => {
  const g = build({ kind, delayed: true, unrecordedSuccess: true, recover: true });
  const a = await attempted(g);
  assert.equal(a.second.verdict, 'escalate');
  advance(120);
  const processingBefore = g.counts.processing;
  const third: any = await g.pipeline.run('cred-plumbing', pmsg);
  assert.deepEqual([third.verdict, third.counted], ['escalate', 'repeat']);
  assert.deepEqual([third.recovery.settled, third.recovery.stopped, third.recovery.steps[0].reason, third.recovery.fresh], [false, 'NOTHING_SETTLED', 'NO_RECORD', undefined]);
  assert.equal(g.counts.processing - processingBefore, 1, 'only the normal run: no fresh round without a settlement');
  assert.equal(g.tool.calls(), 1);
  assert.equal(await stateOf(g, a.stepId), 'in_doubt');
  assert.equal(third.report.counts.verified_simulated_pass, 0);
  // Asking again changes nothing and repeats nothing.
  for (let i = 0; i < 2; i++) { const again: any = await g.pipeline.run('cred-plumbing', pmsg); assert.equal(again.verdict, 'escalate'); }
  assert.equal(g.tool.calls(), 1);
  // The abandoned call finally lands (its late answer could not be recorded): now the next run can settle and verify.
  (g.delayed as DelayedNoteTool).land(); await tick(); await tick();
  assert.equal(await stateOf(g, a.stepId), 'in_doubt');
  const settled: any = await g.pipeline.run('cred-plumbing', pmsg);
  assert.deepEqual([settled.recovery.settled, settled.verdict, settled.recovery.first.verdict], [true, 'pass', 'escalate']);
  assert.equal(g.tool.calls(), 1, 'one call in total, ever');
  assert.equal(await stateOf(g, a.stepId), 'succeeded');
});

each('recovery is off by default: the same in-doubt run escalates and nothing is reconciled', async (kind) => {
  for (const recover of [undefined, false]) {
    const g = build({ kind, unrecordedSuccess: true, recover });
    const a = await attempted(g);
    advance(120);
    const third: any = await g.pipeline.run('cred-plumbing', pmsg);
    assert.deepEqual([third.verdict, third.recovery, third.prior_report], ['escalate', undefined, undefined]);
    assert.equal(g.counts.reconcile, 0);
    assert.equal(await stateOf(g, a.stepId), 'in_doubt');
    at(T0);
  }
});

each('an ambiguous read-back keeps the escalation and settles nothing', async (kind) => {
  const dup = (reader: any) => ({
    scope: reader.scope,
    read: (c: unknown, ref: string) => reader.read(c, ref),
    list: async (c: unknown, item: string) => { const real: any[] = await reader.list(c, item); return real.length ? [...real, { ...real[0], evidence_ref: 'mock-note:duplicate' }] : real; },
  });
  const g = build({ kind, unrecordedSuccess: true, recover: true, readerWrap: dup });
  const a = await attempted(g);
  advance(120);
  const third: any = await g.pipeline.run('cred-plumbing', pmsg);
  assert.deepEqual([third.verdict, third.recovery.settled, third.recovery.stopped, third.recovery.steps[0].reason], ['escalate', false, 'NOTHING_SETTLED', 'AMBIGUOUS']);
  assert.equal(await stateOf(g, a.stepId), 'in_doubt');
  assert.equal(g.tool.calls(), 1);
});

// ---------------------------------------------------------------- failures inside recovery
t('a failing reconcile leaves the escalation exactly as reported, within the time bound', async () => {
  const bad: [string, (c: Counts, qc: any) => any][] = [
    ['throws', (c, qc) => ({ ...qc, reconcile: () => { c.reconcile++; throw new Error(CANARY); } })],
    ['rejects', (c, qc) => ({ ...qc, reconcile: () => { c.reconcile++; return Promise.reject(new Error(CANARY)); } })],
    ['hangs', (c, qc) => ({ ...qc, reconcile: () => { c.reconcile++; return new Promise(() => {}); } })],
    ['garbage', (c, qc) => ({ ...qc, reconcile: () => { c.reconcile++; return 'nope'; } })],
    ['refuses', (c, qc) => ({ ...qc, reconcile: () => { c.reconcile++; return { ok: false, error: { code: 'QC_ERROR', message: 'x' } }; } })],
  ];
  for (const [name, qcWrap] of bad) {
    at(T0);
    const g = build({ kind: 'memory', unrecordedSuccess: true, recover: true, qcWrap, stageTimeoutMs: 80 });
    const a = await attempted(g);
    advance(120);
    const started = Date.now();
    const third: any = await g.pipeline.run('cred-plumbing', pmsg);
    assert.ok(Date.now() - started < 3000, `${name}: bounded`);
    assert.deepEqual([third.verdict, third.recovery.settled, third.recovery.stopped], ['escalate', false, 'RECONCILE_FAILED'], name);
    assert.equal(g.tool.calls(), 1, name);
    assert.equal(await stateOf(g, a.stepId), 'in_doubt', name);
    assert.ok(!JSON.stringify(third).includes('CANARY'));
  }
});

t('a QC that was not given the settle capability cannot recover: the escalation stays', async () => {
  const g = build({ kind: 'memory', unrecordedSuccess: true, recover: true, settle: false });
  const a = await attempted(g);
  advance(120);
  const third: any = await g.pipeline.run('cred-plumbing', pmsg);
  assert.deepEqual([third.verdict, third.recovery.stopped], ['escalate', 'RECONCILE_FAILED']);
  assert.equal(await stateOf(g, a.stepId), 'in_doubt');
});

t('if the fresh verification itself fails, the settlement stands but the reported escalation is not replaced', async () => {
  for (const stage of ['processing', 'qc', 'reporting'] as const) {
    at(T0);
    // The fault is armed only once reconcile has settled something, so it hits exactly the one fresh verification.
    const fault = { armed: false, hit: 0 };
    const trip = () => { if (fault.armed) { fault.armed = false; fault.hit++; return true; } return false; };
    const g = build({
      kind: 'memory', unrecordedSuccess: true, recover: true,
      qcWrap: (c, q) => ({
        run: (...a: any[]) => { c.qcRun++; if (stage === 'qc' && trip()) throw new Error(CANARY); return q.run(...a); },
        reconcile: async (...a: any[]) => { const r = await q.reconcile(...a); if (r?.ok && r.steps.some((x: any) => x.outcome === 'resolved')) fault.armed = true; return r; },
      }),
      processingWrap: (c, p) => ({ run: (...a: any[]) => { if (stage === 'processing' && trip()) return Promise.reject(new Error(CANARY)); return p.run(...a); } }),
      reportingWrap: (c, r) => ({ ...r, submit: (...a: any[]) => { if (stage === 'reporting' && trip()) throw new Error(CANARY); return r.submit(...a); } }),
    });
    const a = await attempted(g);
    advance(120);
    const third: any = await g.pipeline.run('cred-plumbing', pmsg);
    assert.equal(fault.hit, 1, `${stage}: the fault hit the fresh verification`);
    assert.deepEqual([third.verdict, third.recovery.settled, third.recovery.stopped, third.recovery.fresh], ['escalate', true, 'FRESH_FAILED', undefined], stage);
    assert.equal(third.report.chains[0].outcome, 'escalate', `${stage}: the first outcome is not replaced`);
    assert.equal(await stateOf(g, a.stepId), 'succeeded', `${stage}: the settlement is durable`);
    assert.equal(g.tool.calls(), 1, stage);
    assert.ok(!JSON.stringify(third).includes('CANARY'));
    const later: any = await g.pipeline.run('cred-plumbing', pmsg);
    assert.deepEqual([later.verdict, later.recovery], ['pass', undefined], `${stage}: a later run verifies normally`);
    assert.equal(g.tool.calls(), 1, stage);
  }
});

// ---------------------------------------------------------------- idempotent tools, other tools, other tenants
each('recovery adds no tool call of its own, even for an idempotent tool', async (kind) => {
  const g = build({ kind, unrecordedSuccess: true, idempotent: true, recover: true });
  const a = await attempted(g);
  advance(120);
  const callsBefore = g.tool.calls();
  const third: any = await g.pipeline.run('cred-plumbing', pmsg);
  // The normal run may retry an idempotent tool under Processing's own rules (same step id; the mock dedupes). Recovery itself calls nothing.
  assert.ok(g.tool.calls() - callsBefore <= 1);
  assert.equal(g.note.writes.length, 1, 'still one write');
  assert.ok(['escalate', 'pass'].includes(third.verdict));
  assert.equal(g.counts.reconcile >= 1, true);
  void a;
});

t('an uncertain step of an assisted tool is not recovered: only human-approved steps are', async () => {
  at(T0);
  const note = createMockNoteTool();
  const tools = createToolRegistry({ 'mock-note': { scope: MOCK_NOTE_SCOPE, run: () => { throw new Error(CANARY); } } });
  const processing = createProcessingEntry({ tools, plan: ['mock-note'], now: nowIso });
  const store = createInMemoryApprovalStore({ now: nowIso });
  const qc = createQcEntry({ plan: ['mock-note'], readers: { 'mock-note': note.reader }, now: nowIso, approvals: { store, tools: humanApprovalExpectations(tools), settle: store } });
  let reconciles = 0;
  const qw = { run: (...a: any[]) => (qc.run as any)(...a), reconcile: (...a: any[]) => { reconciles++; return (qc.reconcile as any)(...a); } };
  let n = 0;
  const pipeline = createPipeline({
    intake, processing, qc: qw as never, reporting: createReportingEntry({ now: nowIso }), processingToolScopes: [MOCK_NOTE_SCOPE], qcReaderScopes: [MOCK_NOTE_READ_SCOPE], recoverUncertain: true, sleep: async () => { advance(1); },
    sources: { verify: () => ({ kind: 'user', id: 'user-plumbing' }), selectTenant: () => PW, grants: () => ['intake:run', 'processing:run', MOCK_NOTE_SCOPE, 'quality-control:run', MOCK_NOTE_READ_SCOPE, 'reporting:run'], newCorrelationId: () => `corr-asst-${++n}` },
  });
  const r: any = await pipeline.run('cred', pmsg);
  assert.deepEqual([r.verdict, r.recovery], ['escalate', undefined]);
  assert.equal(reconciles, 0);
});

each('tenants stay apart: recovering one tenant\'s item never settles another\'s', async (kind) => {
  const g = build({ kind, unrecordedSuccess: true, recover: true });
  const p = await attempted(g, 'cred-plumbing', pmsg);
  const d = await attempted(g, 'cred-dental', dmsg);
  advance(120);
  assert.notEqual(p.stepId, d.stepId);
  const pr: any = await g.pipeline.run('cred-plumbing', pmsg);
  assert.equal(pr.recovery.settled, true);
  assert.equal(await stateOf(g, p.stepId, PW), 'succeeded');
  assert.equal(await stateOf(g, d.stepId, DW), 'in_doubt', 'the other tenant is untouched');
  assert.ok(!JSON.stringify(pr).includes(d.stepId) && !JSON.stringify(pr).includes(DW));
  const dr: any = await g.pipeline.run('cred-dental', dmsg);
  assert.equal(dr.recovery.settled, true);
  assert.equal(await stateOf(g, d.stepId, DW), 'succeeded');
  assert.equal(g.tool.calls(), 2, 'one call per tenant, none from recovery');
});

// ---------------------------------------------------------------- restarts
test('sqlite: recovery works across a restart of the store, the entries and the pipeline, with the reports kept', async () => {
  at(T0);
  let g = build({ kind: 'sqlite', unrecordedSuccess: true, recover: true });
  const a = await attempted(g);
  assert.equal(a.second.verdict, 'escalate');
  g = g.reopen();                                                               // a new store connection, new entries, a new pipeline
  assert.equal(await stateOf(g, a.stepId), 'claimed', 'the claim survived');
  advance(120);
  assert.equal(await stateOf(g, a.stepId), 'in_doubt');
  const third: any = await g.pipeline.run('cred-plumbing', pmsg);
  assert.deepEqual([third.recovery.settled, third.recovery.fresh.verdict, third.verdict], [true, 'pass', 'pass']);
  assert.equal(third.report.chains[0].outcome, 'escalate', 'the first outcome is still the one on record');
  assert.equal(g.tool.calls(), 1);
  g = g.reopen();
  assert.equal(await stateOf(g, a.stepId), 'succeeded', 'and the settlement survives another restart');
  const fourth: any = await g.pipeline.run('cred-plumbing', pmsg);
  assert.deepEqual([fourth.verdict, fourth.recovery], ['pass', undefined]);
  assert.equal(g.tool.calls(), 1);
});

test('sqlite: an unresolved recovery stays escalated across restarts and repeats nothing', async () => {
  at(T0);
  let g = build({ kind: 'sqlite', delayed: true, unrecordedSuccess: true, recover: true });
  const a = await attempted(g);
  advance(120);
  g = g.reopen();
  for (let i = 0; i < 2; i++) {
    const r: any = await g.pipeline.run('cred-plumbing', pmsg);
    assert.deepEqual([r.verdict, r.recovery.stopped, r.recovery.steps[0].reason], ['escalate', 'NOTHING_SETTLED', 'NO_RECORD']);
    g = g.reopen();
  }
  assert.equal(g.tool.calls(), 1);
  assert.equal(await stateOf(g, a.stepId), 'in_doubt');
});

// ---------------------------------------------------------------- setup and inventory
t('setup: recovery must be a boolean and needs a QC that can reconcile', () => {
  const base = () => {
    const note = createMockNoteTool();
    const tools = createToolRegistry({ 'mock-note': human(note) });
    const store = createInMemoryApprovalStore({ now: nowIso });
    return {
      intake, processing: createProcessingEntry({ tools, plan: ['mock-note'], now: nowIso, approval: { store } }),
      qc: createQcEntry({ plan: ['mock-note'], readers: { 'mock-note': note.reader }, now: nowIso, approvals: { store, tools: humanApprovalExpectations(tools), settle: store } }),
      reporting: createReportingEntry({ now: nowIso }), processingToolScopes: [MOCK_NOTE_SCOPE], qcReaderScopes: [MOCK_NOTE_READ_SCOPE],
      sources: { verify() {}, selectTenant() {}, grants() {}, newCorrelationId() { return 'c'; } },
    } as any;
  };
  for (const bad of ['yes', 1, null, {}]) assert.throws(() => createPipeline({ ...base(), recoverUncertain: bad as never }), (e: Error) => e instanceof RangeError && !e.message.includes('CANARY'));
  const b = base();
  assert.throws(() => createPipeline({ ...b, qc: { run: b.qc.run }, recoverUncertain: true }), RangeError);
  assert.doesNotThrow(() => createPipeline({ ...b, qc: { run: b.qc.run }, recoverUncertain: false }));
  assert.doesNotThrow(() => createPipeline({ ...b, recoverUncertain: true }));
  for (const bad of ['x', 1, null, {}]) assert.throws(() => createPipeline({ ...b, sleep: bad as never }), (e: Error) => e instanceof RangeError && !e.message.includes('CANARY'));
  assert.doesNotThrow(() => createPipeline({ ...b, sleep: () => undefined }));
});

t('inventory: the pipeline reconciles in one place, never touches a store or a tool, and recovery is opt-in', () => {
  const dirSrc = new URL('../src/', import.meta.url);
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const code = strip(readFileSync(new URL('pipeline.ts', dirSrc), 'utf8'));
  assert.equal((code.match(/\.reconcile\(/g) ?? []).length, 1);
  assert.ok(!/approval-store|approver-context|mock-tools|handoff-seal/.test(code), 'no store, approver, tool or seal');
  assert.ok(!/\.(?:resolve|claim|complete|putProposal|recordDecision|findByStep)\(/.test(code.replace(/Promise\.resolve\(/g, '')), 'the pipeline never touches a store');
  assert.ok(/const recover = recoverUncertain === true/.test(code), 'off unless asked for');
  assert.equal((code.match(/await sleep\(/g) ?? []).length, 1, 'the injected sleep has one call site, inside recovery');
  assert.ok(/stopFresh\('FRESH_NOT_LATER'\)/.test(code) && code.indexOf('await sleep(') > code.indexOf('const recover ='), 'a fresh verdict that is not later stops recovery');
  const files = readdirSync(dirSrc).filter((f) => f.endsWith('.ts'));
  const callers = files.filter((f) => /\.reconcile\(/.test(strip(readFileSync(new URL(f, dirSrc), 'utf8'))));
  assert.deepEqual(callers, ['pipeline.ts'], 'only the pipeline asks QC to reconcile');
});
