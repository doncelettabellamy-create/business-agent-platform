// End-to-end tests for the controlled pipeline running over the development-only SQLite stores: the Reporting entry is built on an INJECTED
// ReportingLedger (SQLite, or the in-memory default), and the approval store is SQLite too, so a restart closes and reopens every durable part.
// The pipeline itself stays ledger-agnostic: it receives a finished Reporting entry. Mock provider, tools and readers, synthetic data only.
// Temporary database files only. No network, no key, no real side effect.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIntakeEntry } from '../src/intake-entry.ts';
import { createTenantRegistry } from '../src/tenant-boundary.ts';
import { mintApproverContext } from '../src/approver-context.ts';
import { approvalScopeFor, decideProposal } from '../src/approval.ts';
import type { ApprovalStore } from '../src/approval-store.ts';
import { createSqliteApprovalStore } from '../src/approval-store-sqlite.ts';
import type { SqliteApprovalStore } from '../src/approval-store-sqlite.ts';
import { createProcessingEntry, createToolRegistry, humanApprovalExpectations, idempotentToolNames } from '../src/processing-entry.ts';
import type { ToolDefinition } from '../src/processing-entry.ts';
import { createMockNoteTool, MOCK_NOTE_READ_SCOPE, MOCK_NOTE_SCOPE } from '../src/mock-tools.ts';
import { createQcEntry } from '../src/qc-entry.ts';
import { createReportingEntry } from '../src/reporting-entry.ts';
import { createPipeline } from '../src/pipeline.ts';
import { createInMemoryReportingLedger, snapshotIsConsistent } from '../src/reporting-ledger.ts';
import type { ReportingLedger } from '../src/reporting-ledger.ts';
import { createSqliteReportingLedger } from '../src/reporting-ledger-sqlite.ts';
import type { SqliteReportingLedger } from '../src/reporting-ledger-sqlite.ts';
import { validateReport } from '../src/report.ts';
import { classifyAnswer, createMockProvider, extractAnswer } from '../src/mock-provider.ts';

const CANARY = 'CANARY-PLG-6127';
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

const dir = mkdtempSync(join(tmpdir(), 'pipeline-ledger-'));
const closers: Array<() => void> = [];
let fileCounter = 0;
const newFile = () => join(dir, `db-${++fileCounter}.db`);
after(() => { for (const c of closers) { try { c(); } catch { /* already closed */ } } rmSync(dir, { recursive: true, force: true }); });

const VALUES: Record<string, string> = { Address: '[ADDRESS_1]', 'Job description': 'Burst pipe repair', 'Patient reference': '[ID_1]', 'Insurance provider': 'Example Health' };
const intake = createIntakeEntry({
  registry: createTenantRegistry({ [PW]: pcfg, [DW]: dcfg }), channelRef: 'channel-plg-test', now: () => T0,
  provider: createMockProvider({
    classify_request: (req) => classifyAnswer((req.data.categories ?? []).includes('Emergency leak') ? 'Emergency leak' : 'New patient', 0.9),
    extract_fields: (req) => extractAnswer((req.data.fields ?? []).map((f) => ({ name: f.name, value: VALUES[f.name] ?? null, confidence: VALUES[f.name] ? 0.9 : null }))),
  }),
});
const human = (base: { scope: string; run: ToolDefinition['run'] }): ToolDefinition => ({ scope: base.scope, run: base.run, approval: 'human' });
const failingComplete = (real: ApprovalStore): ApprovalStore => {
  const w: any = { leaseSeconds: real.leaseSeconds };
  for (const m of ['putProposal', 'recordDecision', 'claim', 'resolve', 'get', 'findByStep', 'events'] as const) w[m] = (...a: any[]) => (real as any)[m](...a);
  w.complete = () => { throw new Error(CANARY); };
  return Object.freeze(w);
};

/** The parts that outlive a restart: the external "system" the note tool writes to, and the two database files. */
interface Durable { note: ReturnType<typeof createMockNoteTool>; approvals: string; ledger: string | null }
interface Life {
  pipeline: ReturnType<typeof createPipeline>; store: SqliteApprovalStore; ledger: ReportingLedger; sqliteLedger: SqliteReportingLedger | null; reporting: ReturnType<typeof createReportingEntry>;
  durable: Durable; close(): void;
}
let qcLast = 0;
/** A QC clock that never repeats a second, so successive verdicts have distinct times. */
const tickingQc = () => { qcLast = Math.max(qcLast + 1000, Date.parse(clock)); return new Date(qcLast).toISOString().replace(/\.\d{3}Z$/, 'Z'); };
let corrSeq = 0;

function open(durable: Durable, o: { unrecordedSuccess?: boolean; ticking?: boolean; maxAttempts?: number } = {}): Life {
  const tools = createToolRegistry({ 'mock-note': human(durable.note) });
  const store = createSqliteApprovalStore({ path: durable.approvals, now: nowIso, idempotentTools: idempotentToolNames(tools) });
  let sqliteLedger: SqliteReportingLedger | null = null;
  try { sqliteLedger = durable.ledger === null ? null : createSqliteReportingLedger({ path: durable.ledger, ...(o.maxAttempts === undefined ? {} : { maxAttempts: o.maxAttempts }) }); }
  catch (e) { store.close(); throw e; }                                      // a failed startup leaves nothing open
  const ledger = sqliteLedger ?? createInMemoryReportingLedger();
  const processing = createProcessingEntry({ tools, plan: ['mock-note'], now: nowIso, timeoutMs: 30, approval: { store: o.unrecordedSuccess ? failingComplete(store) : store } });
  const qc = createQcEntry({
    plan: ['mock-note'], readers: { 'mock-note': durable.note.reader }, now: o.ticking ? tickingQc : nowIso, timeoutMs: 60,
    approvals: { store, tools: humanApprovalExpectations(tools), settle: store },
  });
  const reporting = createReportingEntry({ now: nowIso, ledger });          // the injected ledger; omit it for the in-memory default
  let n = 0;
  const pipeline = createPipeline({
    intake, processing, qc, reporting, processingToolScopes: [MOCK_NOTE_SCOPE], qcReaderScopes: [MOCK_NOTE_READ_SCOPE], stageTimeoutMs: 500, recoverUncertain: true, sleep: async () => { advance(1); },
    sources: {
      verify: (c: unknown) => (c === 'cred-plumbing' ? { kind: 'user', id: 'user-plumbing' } : c === 'cred-dental' ? { kind: 'user', id: 'user-dental' } : undefined),
      selectTenant: (id: { id: string }) => (id.id === 'user-plumbing' ? PW : DW),
      grants: () => ['intake:run', 'processing:run', MOCK_NOTE_SCOPE, 'quality-control:run', MOCK_NOTE_READ_SCOPE, 'reporting:run'], newCorrelationId: () => `corr-plg-${++corrSeq}-${++n}`,
    },
  });
  const life: Life = { pipeline, store, ledger, sqliteLedger, reporting, durable, close() { store.close(); sqliteLedger?.close(); } };
  closers.push(() => life.close());
  return life;
}
const fresh = (kind: 'sqlite' | 'memory'): Durable => ({ note: createMockNoteTool(), approvals: newFile(), ledger: kind === 'sqlite' ? newFile() : null });
/** A restart: every durable part is closed and reopened; the entries, the pipeline and every seal are new. */
const restart = (g: Life, o: Parameters<typeof open>[1] = {}): Life => { g.close(); return open(g.durable, o); };

async function approverCtx(tenant: string) {
  const r = await mintApproverContext({ credential: 'c', workspace_id: tenant }, {
    verify: () => ({ kind: 'user', id: 'user-boss', assurance: 'multi-factor', authenticated_at: T0, session_expires_at: '2026-10-26T12:00:00Z' }),
    membership: () => true, grants: () => [approvalScopeFor('mock-note')], newCorrelationId: () => `corr-boss-${++corrSeq}`, now: nowIso,
  });
  assert.equal(r.ok, true);
  return (r as { context: any }).context;
}
async function approve(store: ApprovalStore, pending: any) {
  const ctx = await approverCtx(pending.proposal.workspace_id);
  const d: any = decideProposal(ctx, pending.proposal, { decision: 'approved', reason_code: 'within_policy' }, { now: nowIso });
  assert.equal(d.ok, true, JSON.stringify(d.error));
  const r: any = await store.recordDecision(ctx, d.decision);
  assert.equal(r.ok, true, JSON.stringify(r.error));
}
/** Pause, approve, run once more. */
async function attempted(g: Life, cred = 'cred-plumbing', message: Record<string, unknown> = pmsg) {
  const first: any = await g.pipeline.run(cred, message);
  assert.equal(first.outcome, 'awaiting-approval', JSON.stringify(first.error));
  await approve(g.store, first.pending);
  const second: any = await g.pipeline.run(cred, message);
  assert.equal(second.outcome, 'reported', JSON.stringify(second.error));
  return { first, second };
}
const reportNow = async (g: Life, tenant = PW) => {
  const ctxResult = await (async () => {
    const { mintExecutionContext } = await import('../src/execution-context.ts');
    return mintExecutionContext({ credential: 'c', agent: 'reporting' }, { verify: () => ({ kind: 'user', id: 'user-r' }), selectTenant: () => tenant, grants: () => ['reporting:run'], newCorrelationId: () => `corr-plg-r-${++corrSeq}` });
  })();
  assert.equal(ctxResult.ok, true);
  const r: any = await g.reporting.report((ctxResult as any).context);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(validateReport(r.report), []);
  return r.report;
};
function t(title: string, fn: () => unknown) { test(title, () => { at(T0); qcLast = 0; return fn(); }); }

// ---------------------------------------------------------------- the same pipeline results on either ledger
t('the in-memory default and an injected SQLite ledger give the same results and reports end to end', async () => {
  const results: any[] = [];
  for (const kind of ['memory', 'sqlite'] as const) {
    corrSeq = 0;
    const g = open(fresh(kind));
    const a = await attempted(g);
    assert.deepEqual([a.second.verdict, a.second.counted], ['pass', 'accepted'], kind);
    const again: any = await g.pipeline.run('cred-plumbing', pmsg);
    assert.deepEqual([again.verdict, again.counted], ['pass', 'repeat'], kind);
    results.push([a.second.report, again.report, again.item_id]);
    g.close();
  }
  assert.deepEqual(results[1], results[0]);
});

// ---------------------------------------------------------------- restart
t('restart: the report, the history and the first outcome survive, a repeated request is a repeat attempt, and the action is not repeated', async () => {
  let g = open(fresh('sqlite'));
  const a = await attempted(g);
  const before = a.second.report;
  assert.deepEqual([before.counts.verified_simulated_pass, before.history.observations], [1, 1]);
  g = restart(g);
  assert.deepEqual({ ...(await reportNow(g)), correlation_id: 'same' }, { ...before, correlation_id: 'same' }, 'the report is the same after a restart apart from its own correlation id');
  const again: any = await g.pipeline.run('cred-plumbing', pmsg);
  assert.deepEqual([again.outcome, again.verdict, again.counted], ['reported', 'pass', 'repeat']);
  assert.equal(g.durable.note.writes.length, 1, 'one write in the external system, ever');
  assert.deepEqual([again.report.counts.counted_items, again.report.counts.repeat_attempts, again.report.history.observations], [1, 1, 2]);
  assert.deepEqual(again.report.statuses, [{ item_id: a.second.item_id, first: 'pass', current: 'pass', attempts: 2 }]);
  assert.equal(again.report.history.verified, true);
  assert.equal(g.sqliteLedger && snapshotIsConsistent(g.sqliteLedger.snapshot(PW)), true);
});

t('restart: with the in-memory default the history is lost at a restart, so the same request is accepted as new (the gap the SQLite ledger closes)', async () => {
  let g = open(fresh('memory'));
  await attempted(g);
  g = restart(g);
  const again: any = await g.pipeline.run('cred-plumbing', pmsg);
  assert.deepEqual([again.verdict, again.counted, again.report.history.observations], ['pass', 'accepted', 1]);
});

t('restart: two tenants share one ledger file and keep separate reports before and after a restart', async () => {
  let g = open(fresh('sqlite'));
  await attempted(g, 'cred-plumbing', pmsg);
  await attempted(g, 'cred-dental', dmsg);
  g = restart(g);
  const p: any = await g.pipeline.run('cred-plumbing', pmsg);
  const d: any = await g.pipeline.run('cred-dental', dmsg);
  for (const [r, tenant] of [[p, PW], [d, DW]] as const) {
    assert.equal(r.report.workspace_id, tenant);
    assert.deepEqual([r.verdict, r.counted, r.report.counts.counted_items, r.report.history.observations], ['pass', 'repeat', 1, 2]);
  }
  assert.notEqual(p.item_id, d.item_id);
  assert.ok(!JSON.stringify(p.report).includes(d.item_id) && !JSON.stringify(d.report).includes(p.item_id));
  assert.equal(g.durable.note.writes.length, 2);
});

// ---------------------------------------------------------------- recovery, reported
for (const ticking of [false, true]) {
  t(`recovery across a restart (${ticking ? 'distinct verdict times' : 'same-second verdict times, retried after one sleep'}): the first escalation is kept, the settled item is freshly verified, and the current status follows the verdict times`, async () => {
    let g = open(fresh('sqlite'), { unrecordedSuccess: true, ticking });
    const a = await attempted(g);                                          // the tool ran; its success could not be recorded
    assert.deepEqual([a.second.verdict, a.second.counted], ['escalate', 'accepted']);
    assert.equal(g.durable.note.writes.length, 1);
    advance(120);                                                          // the lease lapses: the step is in doubt
    g = restart(g, { ticking });                                           // the process died: stores, ledger, entries and seals are all new
    const third: any = await g.pipeline.run('cred-plumbing', pmsg);
    assert.equal(third.outcome, 'reported', JSON.stringify(third.error));
    assert.deepEqual([third.recovery.settled, third.recovery.first.verdict, third.recovery.fresh.verdict, third.recovery.stopped], [true, 'escalate', 'pass', undefined]);
    assert.equal(g.durable.note.writes.length, 1, 'recovery never repeats the action');
    // The history holds every attempt, in order, across the restart: the escalation before it, the escalation after it, and the fresh pass.
    const rep = third.report;
    assert.deepEqual([rep.history.observations, rep.history.verified, rep.counts.counted_items, rep.counts.repeat_attempts], [3, true, 1, 2]);
    assert.equal(rep.counts.escalate, 1, 'the first outcome is still the one that counts');
    assert.equal(rep.chains[0].outcome, 'escalate');
    assert.deepEqual(rep.statuses, [{ item_id: a.second.item_id, first: 'escalate', current: 'pass', attempts: 3 }]);
    assert.deepEqual(rep.current, { pass: 1, rework: 0, escalate: 0, chain_conflict: 0 });   // same-second times are retried after one sleep, so the fresh pass is strictly later either way
    assert.deepEqual(third.prior_report.counts.repeat_attempts, 1);
    assert.deepEqual(validateReport(third.prior_report), []);
    // A later restart changes nothing and recovery is not needed again.
    g = restart(g, { ticking });
    advance(5);                                                            // with second-resolution times, an attempt in the same second as the last would only tie
    const fourth: any = await g.pipeline.run('cred-plumbing', pmsg);
    assert.deepEqual([fourth.verdict, fourth.counted, fourth.recovery, fourth.report.history.observations], ['pass', 'repeat', undefined, 4]);
    assert.equal(fourth.report.statuses[0].current, 'pass', 'a later, strictly newer verdict promotes the item either way');
    assert.equal(g.durable.note.writes.length, 1);
  });
}

// ---------------------------------------------------------------- startup and runtime failures
t('startup: a corrupt, wrong-kind or unsupported ledger file stops setup before any pipeline exists, and the approval store is untouched', async () => {
  const d = fresh('sqlite');
  const healthy = open(d); await attempted(healthy); healthy.close();
  const corrupt = newFile();
  writeFileSync(corrupt, `${CANARY} this is not a database `.repeat(200));
  for (const bad of [corrupt, d.approvals, join(dir, `missing-${CANARY}`, 'x.db')]) {
    assert.throws(() => open({ ...d, ledger: bad }), (e: Error) => e instanceof RangeError && !e.message.includes('CANARY') && !e.message.includes(dir));
  }
  const back = open(d);                                                    // the original files still open and still hold the history
  const again: any = await back.pipeline.run('cred-plumbing', pmsg);
  assert.deepEqual([again.verdict, again.counted, again.report.history.observations], ['pass', 'repeat', 2]);
});

t('startup: a bad injected ledger, a cap given twice and an entry without its functions are refused at setup, without echoing values', () => {
  for (const bad of [null, 5, 'x', {}, { record: () => 1 }]) {
    assert.throws(() => createReportingEntry({ now: nowIso, ledger: bad as never }), (e: Error) => e instanceof RangeError && !e.message.includes('x'));
  }
  assert.throws(() => createReportingEntry({ now: nowIso, ledger: createInMemoryReportingLedger(), maxAttempts: 2 }), RangeError);
  const g = open(fresh('memory'));
  const base: any = { intake, processing: createProcessingEntry({ tools: createToolRegistry({ 'mock-note': createMockNoteTool() }), plan: ['mock-note'], now: nowIso }), qc: { run: () => 1 }, processingToolScopes: [MOCK_NOTE_SCOPE], qcReaderScopes: [MOCK_NOTE_READ_SCOPE], sources: {} };
  for (const bad of [undefined, null, {}, { submit: () => 1 }, { report: () => 1 }]) assert.throws(() => createPipeline({ ...base, reporting: bad }), RangeError);
  g.close();
});

t('runtime: a ledger that goes away mid-life stops the run at the Reporting stage, leaks nothing, loses no work, and a reopened ledger completes the same request', async () => {
  let g = open(fresh('sqlite'));
  const first: any = await g.pipeline.run('cred-plumbing', pmsg);
  assert.equal(first.outcome, 'awaiting-approval');
  await approve(g.store, first.pending);
  g.sqliteLedger?.close();                                                 // the ledger fails; the approval store is fine
  const failed: any = await g.pipeline.run('cred-plumbing', pmsg);
  assert.equal(failed.ok, false);
  assert.equal(failed.stage, 'reporting');
  assert.deepEqual(Object.fromEntries(failed.stages.map((s: any) => [s.stage, s.status])), { auth: 'passed', intake: 'passed', processing: 'passed', qc: 'passed', reporting: 'refused' });
  assert.ok(!JSON.stringify(failed).match(/CANARY|ws-synthetic|\.db|SELECT|observations/), JSON.stringify(failed));
  assert.equal(g.durable.note.writes.length, 1, 'the approved action happened once and is not lost');
  g = restart(g);                                                          // operator fixes the ledger and restarts
  const done: any = await g.pipeline.run('cred-plumbing', pmsg);
  assert.deepEqual([done.outcome, done.verdict, done.counted, done.report.history.observations], ['reported', 'pass', 'accepted', 1], 'nothing had been recorded, so it is a first outcome');
  assert.equal(g.durable.note.writes.length, 1, 'and still only one write in the external system');
  const next: any = await g.pipeline.run('cred-plumbing', pmsg);
  assert.deepEqual([next.counted, next.report.statuses[0].attempts], ['repeat', 2]);
});

// ---------------------------------------------------------------- structure
t('the pipeline stays ledger-agnostic: it takes a finished Reporting entry and imports no ledger, store or Reporting implementation', () => {
  const src = readFileSync(new URL('../src/pipeline.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const imports = [...src.matchAll(/^import (type )?.* from '(.+)';$/gm)].map((m) => `${m[1] ?? ''}${m[2]}`);
  assert.ok(imports.includes('type ./reporting-entry.ts'), imports.join(','));
  assert.ok(!imports.some((i) => /ledger|sqlite|approval-store/.test(i)), imports.join(','));
  assert.ok(!/\bcreateReportingEntry\b|\bcreateSqlite|\bcreateInMemory/.test(src));
});
