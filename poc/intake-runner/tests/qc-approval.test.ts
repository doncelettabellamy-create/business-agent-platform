// Tests for the read-only Quality Control checks of human approval, action binding and durable completion. Runs on the in-memory store
// and on the development-only SQLite store; tampered views of the store are used to prove each way a record can be wrong.
// Mock provider, mock tools, mock contexts, synthetic data only. No network, no key, no real side effect.
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
import { createQcEntry, QC_RUN_SCOPE } from '../src/qc-entry.ts';
import { CHECK_NAMES, CHECK_REASONS, CHECK_RESULTS, HUMAN_CHECKS, validateVerdict, verdictFor } from '../src/qc-verdict.ts';
import { createReportingEntry, REPORTING_RUN_SCOPE } from '../src/reporting-entry.ts';
import { validateReport } from '../src/report.ts';
import { createPipeline } from '../src/pipeline.ts';
import { classifyAnswer, createMockProvider, extractAnswer } from '../src/mock-provider.ts';

const CANARY = 'CANARY-QCAP-3120';
const T0 = '2026-10-25T23:00:00Z';
let clock = T0;
const nowIso = (): string => clock;
const at = (s: string) => { clock = s; };
const plus = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const PW = 'ws-synthetic-plumbing';
const DW = 'ws-synthetic-dental';
const read = (n: string) => JSON.parse(readFileSync(new URL(`../examples/${n}`, import.meta.url), 'utf8'));
const { skill_config: pcfg, ...pmsg } = read('skill-plumbing.json');
const { skill_config: dcfg, ...dmsg } = read('skill-dental.json');

const dir = mkdtempSync(join(tmpdir(), 'qc-approval-'));
const openStores: SqliteApprovalStore[] = [];
let fileCounter = 0;
after(() => { for (const s of openStores) s.close(); rmSync(dir, { recursive: true, force: true }); });

async function agentCtx(tenant: string, agent: AgentName, scopes: string[], id = 'user-requester', corr = 'corr-proc'): Promise<ExecutionContext> {
  const r = await mintExecutionContext({ credential: 'c', agent }, { verify: () => ({ kind: 'user', id }), selectTenant: () => tenant, grants: () => scopes, newCorrelationId: () => corr });
  assert.equal(r.ok, true);
  return (r as { context: ExecutionContext }).context;
}
let seq = 0;
const procCtx = (tenant = PW) => agentCtx(tenant, 'processing', [PROCESSING_RUN_SCOPE, MOCK_NOTE_SCOPE], 'user-requester', `corr-proc-${++seq}`);
const qcCtx = (tenant = PW) => agentCtx(tenant, 'quality-control', [QC_RUN_SCOPE, MOCK_NOTE_READ_SCOPE], 'user-qc', `corr-qc-${++seq}`);
async function approverCtx(tenant = PW, id = 'user-boss'): Promise<ApproverContext> {
  const r = await mintApproverContext({ credential: 'c', workspace_id: tenant }, {
    verify: () => ({ kind: 'user', id, assurance: 'multi-factor', authenticated_at: T0, session_expires_at: '2026-10-26T06:00:00Z' }),
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
const intake = createIntakeEntry({ registry: createTenantRegistry({ [PW]: pcfg, [DW]: dcfg }), provider: provider(), channelRef: 'channel-qcap-test', now: () => '2026-10-25T23:00:00Z' });
async function handoffFor(tenant = PW, message: Record<string, unknown> = pmsg) {
  const r = await intake.run(await agentCtx(tenant, 'intake', ['intake:run'], 'user-requester', `corr-intake-${++seq}`), message);
  assert.equal(r.ok, true);
  return (r as any).handoff;
}

type Kind = 'memory' | 'sqlite';
const human = (base: { scope: string; run: ToolDefinition['run'] }, o: { idempotent?: boolean; args?: unknown } = {}): ToolDefinition => ({
  scope: base.scope, run: base.run, approval: 'human', ...(o.idempotent !== undefined ? { idempotent: o.idempotent } : {}), ...(o.args !== undefined ? { approvalArguments: o.args } : {}),
});
/** A view of the store that records what QC asks, and can alter what it is told. */
function view(real: ApprovalStore, o: { snapshot?: (s: any) => any; events?: (e: any[]) => any[]; findByStep?: () => unknown; eventsCall?: () => unknown } = {}) {
  const calls: string[] = [];
  const out: any = {
    findByStep: async (c: unknown, id: unknown) => {
      calls.push('findByStep');
      if (o.findByStep) return o.findByStep();
      const r: any = await real.findByStep(c, id);
      return r.ok && o.snapshot ? { ok: true, snapshot: o.snapshot(structuredClone(r.snapshot)) } : r;
    },
    events: async (c: unknown, id: unknown) => {
      calls.push('events');
      if (o.eventsCall) return o.eventsCall();
      const r: any = await real.events(c, id);
      return r.ok && o.events ? { ok: true, events: o.events(structuredClone(r.events)) } : r;
    },
  };
  return { store: out as ApprovalStore, calls };
}
interface Rig {
  kind: Kind; store: ApprovalStore; tools: ReturnType<typeof createToolRegistry>; processing: ReturnType<typeof createProcessingEntry>;
  note: ReturnType<typeof createMockNoteTool>; qcWith(o?: Parameters<typeof view>[1], humanArgs?: unknown): { qc: ReturnType<typeof createQcEntry>; calls: string[] };
}
function build(kind: Kind, o: { tool?: ToolDefinition; note?: ReturnType<typeof createMockNoteTool>; timeoutMs?: number; idempotent?: boolean; args?: unknown; processingStoreWrap?: (s: ApprovalStore) => ApprovalStore } = {}): Rig {
  at(T0);
  const note = o.note ?? createMockNoteTool();
  const tools = createToolRegistry({ 'mock-note': o.tool ?? human(note, { ...(o.idempotent !== undefined ? { idempotent: o.idempotent } : {}), ...(o.args !== undefined ? { args: o.args } : {}) }) });
  const cfg = { now: nowIso, idempotentTools: idempotentToolNames(tools) };
  let store: ApprovalStore;
  if (kind === 'sqlite') { const s = createSqliteApprovalStore({ path: join(dir, `db-${++fileCounter}.db`), ...cfg }); openStores.push(s); store = s; } else store = createInMemoryApprovalStore(cfg);
  const processing = createProcessingEntry({ tools, plan: ['mock-note'], now: nowIso, timeoutMs: o.timeoutMs ?? 5000, approval: { store: o.processingStoreWrap ? o.processingStoreWrap(store) : store } });
  return {
    kind, store, tools, processing, note,
    qcWith(v = {}, humanArgs) {
      const w = view(store, v);
      const expectations = humanArgs === undefined ? humanApprovalExpectations(tools) : { 'mock-note': { arguments: humanArgs } };
      return { qc: createQcEntry({ plan: ['mock-note'], readers: { 'mock-note': note.reader }, now: nowIso, timeoutMs: 100, approvals: { store: w.store, tools: expectations } }), calls: w.calls };
    },
  };
}
async function approve(store: ApprovalStore, pending: any, decision: 'approved' | 'declined' = 'approved') {
  const ctx = await approverCtx(pending.proposal.workspace_id);
  const d: any = decideProposal(ctx, pending.proposal, { decision, reason_code: 'within_policy' }, { now: nowIso });
  assert.equal(d.ok, true, JSON.stringify(d.error));
  const r: any = await store.recordDecision(ctx, d.decision);
  assert.equal(r.ok, true, JSON.stringify(r.error));
}
/** Runs Processing to a finished candidate: propose, approve (or decline), run again. */
async function finished(g: Rig, o: { decision?: 'approved' | 'declined'; message?: Record<string, unknown>; tenant?: string } = {}) {
  const tenant = o.tenant ?? PW;
  const h = await handoffFor(tenant, o.message ?? (tenant === PW ? pmsg : dmsg));
  const ctx = await procCtx(tenant);
  const pend: any = ((await g.processing.run(ctx, h)) as any).pending;
  assert.ok(pend, 'expected a pause');
  await approve(g.store, pend, o.decision ?? 'approved');
  const r: any = await g.processing.run(ctx, h);
  assert.ok(r.candidate, JSON.stringify(r));
  return { h, ctx, pend, candidate: r.candidate };
}
async function judge(g: Rig, f: { h: any; candidate: any }, o: Parameters<typeof view>[1] = {}, humanArgs?: unknown, tenant = PW) {
  const { qc, calls } = g.qcWith(o, humanArgs);
  const r: any = await qc.run(await qcCtx(tenant), f.candidate, f.h);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(validateVerdict(r.verdict), []);
  return { v: r.verdict, calls, by: Object.fromEntries(r.verdict.checks.map((c: any) => [c.check, c.reason ? `${c.result}:${c.reason}` : c.result])) as Record<string, string> };
}
const HUMAN = ['human_approval', 'action_binding', 'durable_completion'] as const;
const humanOf = (by: Record<string, string>) => HUMAN.map((k) => by[k]);
function each(title: string, fn: (kind: Kind) => Promise<void>) { for (const kind of ['memory', 'sqlite'] as Kind[]) test(`${kind}: ${title}`, () => { at(T0); return fn(kind); }); }
function t(title: string, fn: () => unknown) { test(title, () => { at(T0); return fn(); }); }

// ---------------------------------------------------------------- the whole record agrees
each('a human-approved, durably completed step passes all nine checks, and QC only looked', async (kind) => {
  const g = build(kind);
  const f = await finished(g);
  const before: any = await g.store.events(await qcCtx(), f.pend.proposal_id);
  const { v, by, calls } = await judge(g, f);
  assert.equal(v.verdict, 'pass');
  assert.deepEqual(v.checks.map((c: any) => c.check), [...CHECK_NAMES]);
  assert.deepEqual(humanOf(by), ['pass', 'pass', 'pass']);
  assert.equal(by.consistency, 'pass');
  assert.ok(calls.length >= 2 && calls.every((c) => c === 'findByStep' || c === 'events'), `QC used only ${[...new Set(calls)]}`);
  const after: any = await g.store.events(await qcCtx(), f.pend.proposal_id);
  assert.deepEqual(after.events, before.events, 'the record is untouched');
  const snap: any = await g.store.findByStep(await qcCtx(), f.pend.step_id);
  assert.deepEqual([snap.snapshot.state, snap.snapshot.attempts], ['succeeded', 1]);
});

each('Reporting counts that chain as a verified pass', async (kind) => {
  const g = build(kind);
  const f = await finished(g);
  const { v } = await judge(g, f);
  const reporting = createReportingEntry({ now: nowIso });
  const rctx = await agentCtx(PW, 'reporting', [REPORTING_RUN_SCOPE], 'user-rpt', 'corr-rpt');
  await reporting.submit(rctx, [{ envelope: f.h, candidate: f.candidate, verdict: v }]);
  const rep: any = ((await reporting.report(rctx)) as any).report;
  assert.deepEqual(validateReport(rep), []);
  assert.deepEqual([rep.counts.verified_simulated_pass, rep.counts.escalate, rep.counts.rework], [1, 0, 0]);
});

t('a plan with no human-approved tool says "not required" for the three checks, and never touches the store', async () => {
  const note = createMockNoteTool();
  const tools = createToolRegistry({ 'mock-note': note });
  const store = createInMemoryApprovalStore({ now: nowIso });
  const w = view(store);
  const processing = createProcessingEntry({ tools, plan: ['mock-note'], now: nowIso });
  const qc = createQcEntry({ plan: ['mock-note'], readers: { 'mock-note': note.reader }, now: nowIso, approvals: { store: w.store, tools: humanApprovalExpectations(tools) } });
  const h = await handoffFor();
  const cand: any = ((await processing.run(await procCtx(), h)) as any).candidate;
  const r: any = await qc.run(await qcCtx(), cand, h);
  assert.equal(r.verdict.verdict, 'pass');
  assert.deepEqual(r.verdict.checks.filter((c: any) => c.result === 'not_required').map((c: any) => c.check), [...HUMAN]);
  assert.deepEqual(w.calls, []);
  const noConfig = createQcEntry({ plan: ['mock-note'], readers: { 'mock-note': note.reader }, now: nowIso });
  assert.equal(((await noConfig.run(await qcCtx(), cand, h)) as any).verdict.verdict, 'pass');
  assert.deepEqual(humanApprovalExpectations(tools), {}, 'an assisted tool is not on the list');
});

// ---------------------------------------------------------------- missing and mismatched records escalate or send back
each('a candidate with no approval record behind it fails all three checks as MISSING', async (kind) => {
  const g = build(kind);
  const f = await finished(g);
  const empty = build(kind);                                                 // a store that has never heard of this step
  const qc = createQcEntry({ plan: ['mock-note'], readers: { 'mock-note': g.note.reader }, now: nowIso, approvals: { store: empty.store, tools: humanApprovalExpectations(g.tools) } });
  const r: any = await qc.run(await qcCtx(), f.candidate, f.h);
  const by = Object.fromEntries(r.verdict.checks.map((c: any) => [c.check, `${c.result}:${c.reason}`]));
  assert.deepEqual(humanOf(by), ['fail:MISSING', 'fail:MISSING', 'fail:MISSING']);
  assert.equal(r.verdict.verdict, 'rework');
});

each('an action that differs from the one QC expects fails action_binding, and only that', async (kind) => {
  const g = build(kind, { args: { mode: 'a' } });
  const f = await finished(g);
  const { v, by } = await judge(g, f, {}, { mode: 'b' });
  assert.deepEqual(humanOf(by), ['pass', 'fail:MISMATCH', 'pass']);
  assert.equal(v.verdict, 'rework');
  const same = await judge(g, f, {}, { mode: 'a' });
  assert.equal(same.v.verdict, 'pass');
});

t('every way a store record can disagree with the candidate is caught', async () => {
  const g = build('memory');
  const f = await finished(g);
  const requester = 'user-requester';
  const cases: [string, Parameters<typeof view>[1], string[]][] = [
    ['self-approval', { snapshot: (s) => ({ ...s, decision: { ...s.decision, approver_id: requester } }) }, ['fail:MISMATCH', 'pass', 'pass']],
    ['declined while the candidate says ok', { snapshot: (s) => ({ ...s, decision: { ...s.decision, decision: 'declined' } }) }, ['fail:MISMATCH', 'pass', 'pass']],
    ['no decision at all', { snapshot: (s) => { const { decision, ...rest } = s; void decision; return rest; } }, ['fail:MISMATCH', 'pass', 'pass']],
    ['another action digest', { snapshot: (s) => ({ ...s, action_digest: '0'.repeat(64) }) }, ['pass', 'fail:MISMATCH', 'pass']],
    ['another step', { snapshot: (s) => ({ ...s, step_id: 'st-ffffffffffff' }) }, ['pass', 'fail:MISMATCH', 'pass']],
    ['another tool', { snapshot: (s) => ({ ...s, tool: 'mock-other' }) }, ['pass', 'fail:MISMATCH', 'pass']],
    ['evidence differs', { snapshot: (s) => ({ ...s, outcome: { ...s.outcome, evidence_ref: 'mock-note:other' } }) }, ['pass', 'pass', 'fail:MISMATCH']],
    ['not succeeded', { snapshot: (s) => ({ ...s, state: 'claimed', outcome: undefined }) }, ['pass', 'pass', 'fail:MISMATCH']],
    ['two attempts but one claim', { snapshot: (s) => ({ ...s, attempts: 2 }) }, ['pass', 'pass', 'fail:MISMATCH']],
    ['an event edited', { events: (e) => { e[1] = { ...e[1], type: 'declined' }; return e; } }, ['fail:MISMATCH', 'pass', 'fail:MISMATCH']],
    ['approved after the claim', { events: (e) => { const [a, b] = [e[1], e[2]]; e[1] = b; e[2] = a; return e; } }, ['fail:MISMATCH', 'pass', 'fail:MISMATCH']],
    ['an event missing', { events: (e) => e.filter((x: any) => x.type !== 'approved') }, ['fail:MISMATCH', 'pass', 'fail:MISMATCH']],
    ['a second success', { events: (e) => [...e, e[e.length - 1]] }, ['fail:MISMATCH', 'pass', 'fail:MISMATCH']],
  ];
  for (const [name, tamper, expected] of cases) {
    const { v, by } = await judge(g, f, tamper);
    assert.deepEqual(humanOf(by), expected, name);
    assert.equal(v.verdict, 'rework', name);
  }
});

t('a record from another tenant does not verify this one', async () => {
  const g = build('memory');
  const p = await finished(g, { tenant: PW });
  const d = await finished(g, { tenant: DW });
  const other: any = await g.store.findByStep(await qcCtx(DW), d.pend.step_id);
  const otherEvents: any = await g.store.events(await qcCtx(DW), d.pend.proposal_id);
  assert.notEqual(other.snapshot.proposal_id, p.pend.proposal_id);
  const { by } = await judge(g, p, { findByStep: () => other, eventsCall: () => otherEvents });
  assert.equal(by.action_binding, 'fail:MISMATCH', 'the digest includes the tenant');
  const own = await judge(g, d, {}, undefined, DW);
  assert.equal(own.v.verdict, 'pass', 'each tenant verifies against its own record');
});

// ---------------------------------------------------------------- uncertain records escalate, and QC does not settle them
each('a timed-out step is uncertain: durable_completion cannot be verified, the verdict escalates, and nothing is resolved', async (kind) => {
  const tool = createDelayedNoteTool();
  const g = build(kind, { tool: human(tool), timeoutMs: 30 });
  const h = await handoffFor(); const ctx = await procCtx();
  const pend: any = ((await g.processing.run(ctx, h)) as any).pending;
  await approve(g.store, pend);
  const cand: any = ((await g.processing.run(ctx, h)) as any).candidate;
  assert.equal(cand.status, 'uncertain');
  const f = { h, candidate: cand };
  const log = async () => ((await g.store.events(await qcCtx(), pend.proposal_id)) as any).events;
  const before = await log();
  const first = await judge(g, f);
  assert.equal(first.v.verdict, 'escalate');
  assert.deepEqual(humanOf(first.by), ['pass', 'pass', 'unverifiable:RECORD_UNCERTAIN']);
  assert.equal(first.by.consistency, 'unverifiable:CANDIDATE_UNCERTAIN');
  at(plus(120));                                                              // the lease lapses: in-doubt
  const second = await judge(g, f);
  assert.equal(second.v.verdict, 'escalate');
  assert.equal(humanOf(second.by)[2], 'unverifiable:RECORD_UNCERTAIN');
  const state: any = await g.store.findByStep(await qcCtx(), pend.step_id);
  assert.deepEqual([state.snapshot.state, state.snapshot.attempts], ['in_doubt', 1], 'QC did not settle it');
  const after = await log();
  assert.deepEqual(after.slice(0, before.length), before, 'only the time-based lapse was added, by the store');
  assert.ok([...first.calls, ...second.calls].every((c) => c === 'findByStep' || c === 'events'));
});

each('a success the store could not record escalates: the effect exists, the record does not', async (kind) => {
  const note = createMockNoteTool();
  const g = build(kind, { note, processingStoreWrap: (real) => {
    const w: any = { leaseSeconds: real.leaseSeconds };
    for (const m of ['putProposal', 'recordDecision', 'claim', 'resolve', 'get', 'findByStep', 'events'] as const) w[m] = (...a: any[]) => (real as any)[m](...a);
    w.complete = () => { throw new Error(CANARY); };
    return Object.freeze(w);
  } });
  const f = await finished(g);
  assert.equal(f.candidate.status, 'uncertain');
  assert.equal(note.writes.length, 1);
  const { v, by } = await judge(g, f);
  assert.equal(v.verdict, 'escalate');
  assert.equal(by.durable_completion, 'unverifiable:RECORD_UNCERTAIN');
  assert.equal(by.no_orphans, 'fail:ORPHAN');
  assert.ok(!JSON.stringify(v).includes('CANARY'));
});

each('a denial the store confirms is consistent; a denial the store contradicts is not', async (kind) => {
  const g = build(kind);
  const f = await finished(g, { decision: 'declined' });
  assert.equal(f.candidate.steps[0].code, 'APPROVAL_DECLINED');
  const honest = await judge(g, f);
  assert.deepEqual(humanOf(honest.by), ['pass', 'pass', 'pass']);
  assert.equal(honest.by.consistency, 'fail:CANDIDATE_FAILED');
  assert.equal(honest.v.verdict, 'rework', 'the item was not done, which is a rework, not a pass');
  if (kind === 'memory') {
    const lie = await judge(g, f, { snapshot: (s) => ({ ...s, state: 'approved', decision: { ...s.decision, decision: 'approved' } }) });
    assert.deepEqual(humanOf(lie.by), ['fail:MISMATCH', 'pass', 'fail:MISMATCH']);
  }
});

each('a tool that said it did not perform is confirmed by a failed record', async (kind) => {
  const g = build(kind, { tool: human({ scope: MOCK_NOTE_SCOPE, run: () => ({ not_performed: true }) }) });
  const f = await finished(g);
  assert.equal(f.candidate.steps[0].code, 'TOOL_NOT_PERFORMED');
  const { v, by } = await judge(g, f);
  assert.deepEqual(humanOf(by), ['pass', 'pass', 'pass']);
  assert.equal(v.verdict, 'rework');
  if (kind === 'memory') {
    const lie = await judge(g, f, { snapshot: (s) => ({ ...s, state: 'succeeded', outcome: { status: 'succeeded', evidence_ref: 'mock-note:x' } }) });
    assert.equal(lie.by.durable_completion, 'fail:MISMATCH');
  }
});

// ---------------------------------------------------------------- the store cannot be read
t('a store that cannot be read makes the three checks unverifiable, and the verdict an escalation', async () => {
  const g = build('memory');
  const f = await finished(g);
  const bad: [string, () => unknown][] = [
    ['throws', () => { throw new Error(CANARY); }], ['rejects', () => Promise.reject(new Error(CANARY))], ['hangs', () => new Promise(() => {})],
    ['garbage', () => 'nope'], ['half answer', () => ({ ok: false })], ['refuses', () => ({ ok: false, error: { code: 'STORE_ERROR', message: 'x' } })],
    ['a snapshot without ids', () => ({ ok: true, snapshot: { state: 'succeeded' } })],
  ];
  for (const [name, findByStep] of bad) {
    const { v, by } = await judge(g, f, { findByStep });
    assert.deepEqual(humanOf(by), ['unverifiable:READ_FAILED', 'unverifiable:READ_FAILED', 'unverifiable:READ_FAILED'], name);
    assert.equal(v.verdict, 'escalate', name);
    assert.ok(!JSON.stringify(v).includes('CANARY'));
  }
  for (const [name, eventsCall] of bad.slice(0, 6)) {
    const { v, by } = await judge(g, f, { eventsCall });
    assert.deepEqual(humanOf(by), ['unverifiable:READ_FAILED', 'pass', 'unverifiable:READ_FAILED'], `events ${name}`);
    assert.equal(v.verdict, 'escalate');
  }
});

// ---------------------------------------------------------------- contract
t('qc_verdict.v1: not_required belongs to the human checks only, carries no reason, and the verdict still follows from the checks', async () => {
  assert.deepEqual([...CHECK_NAMES], ['trace_chain', 'binding', 'plan', 'evidence_exists', 'no_orphans', 'human_approval', 'action_binding', 'durable_completion', 'consistency']);
  assert.ok(CHECK_RESULTS.includes('not_required') && CHECK_REASONS.includes('RECORD_UNCERTAIN'));
  const g = build('memory');
  const f = await finished(g);
  const good = JSON.parse(JSON.stringify((await judge(g, f)).v));
  assert.deepEqual(validateVerdict(good), []);
  const set = (i: number, patch: object) => ({ ...good, checks: good.checks.map((c: any, k: number) => (k === i ? { ...c, ...patch } : c)) });
  const coreIdx = [0, 1, 2, 3, 4, 8];
  for (const i of coreIdx) assert.notDeepEqual(validateVerdict(set(i, { result: 'not_required' })), [], `check ${i} may not be not_required`);
  for (const i of [5, 6, 7]) assert.deepEqual(validateVerdict(set(i, { result: 'not_required' })), [], `check ${i} may be not_required`);
  assert.notDeepEqual(validateVerdict(set(5, { result: 'not_required', reason: 'MISSING' })), []);
  assert.notDeepEqual(validateVerdict(set(5, { result: 'unverifiable' })), [], 'a reason is needed');
  assert.deepEqual(validateVerdict({ ...set(7, { result: 'unverifiable', reason: 'RECORD_UNCERTAIN' }), verdict: 'escalate' }), []);
  assert.notDeepEqual(validateVerdict({ ...set(7, { result: 'unverifiable', reason: 'RECORD_UNCERTAIN' }), verdict: 'pass' }), []);
  assert.equal(verdictFor(good.checks), 'pass');
  assert.equal(verdictFor(set(5, { result: 'not_required' }).checks), 'pass');
  assert.equal(verdictFor(set(0, { result: 'not_required' }).checks), 'escalate', 'a core check cannot be waived');
  assert.deepEqual([...HUMAN_CHECKS], ['human_approval', 'action_binding', 'durable_completion']);
});

each('Reporting files the new checks and reasons without trouble', async (kind) => {
  const tool = createDelayedNoteTool();
  const g = build(kind, { tool: human(tool), timeoutMs: 30 });
  const h = await handoffFor(); const ctx = await procCtx();
  const pend: any = ((await g.processing.run(ctx, h)) as any).pending;
  await approve(g.store, pend);
  const cand: any = ((await g.processing.run(ctx, h)) as any).candidate;
  const { v } = await judge(g, { h, candidate: cand });
  const reporting = createReportingEntry({ now: nowIso });
  const rctx = await agentCtx(PW, 'reporting', [REPORTING_RUN_SCOPE], 'user-rpt', 'corr-rpt');
  const s: any = await reporting.submit(rctx, [{ envelope: h, candidate: cand, verdict: v }]);
  assert.deepEqual([s.ok, s.accepted], [true, 1]);
  const rep: any = ((await reporting.report(rctx)) as any).report;
  assert.deepEqual(validateReport(rep), []);
  assert.deepEqual([rep.counts.escalate, rep.counts.verified_simulated_pass], [1, 0]);
  assert.deepEqual(rep.exceptions[0].checks.map((c: any) => `${c.check}:${c.reason}`).sort(), ['consistency:CANDIDATE_UNCERTAIN', 'durable_completion:RECORD_UNCERTAIN']);
});

// ---------------------------------------------------------------- setup
t('setup: the approvals configuration is validated, and QC is given a read-only view', async () => {
  const note = createMockNoteTool();
  const tools = createToolRegistry({ 'mock-note': human(note, { args: { mode: 'a' } }), plain: { scope: 'tool:p:write', run: () => ({ evidence_ref: 'e' }) } });
  assert.deepEqual(humanApprovalExpectations(tools), { 'mock-note': { arguments: { mode: 'a' } } });
  const store = createInMemoryApprovalStore({ now: nowIso });
  const base = { plan: ['mock-note'], readers: { 'mock-note': note.reader }, now: nowIso };
  const good = { store, tools: humanApprovalExpectations(tools) };
  assert.doesNotThrow(() => createQcEntry({ ...base, approvals: good }));
  const bad: [string, unknown][] = [
    ['null', null], ['no store', { tools: good.tools }], ['store without methods', { store: {}, tools: good.tools }], ['store with one method', { store: { findByStep() {} }, tools: good.tools }],
    ['no tools', { store }], ['tool not in the plan', { store, tools: { other: { arguments: {} } } }], ['arguments missing', { store, tools: { 'mock-note': {} } }],
    ['arguments not plain', { store, tools: { 'mock-note': { arguments: { f: () => 1 } } } }], ['arguments too big', { store, tools: { 'mock-note': { arguments: { t: 'x'.repeat(5000) } } } }],
    ['tool spec not an object', { store, tools: { 'mock-note': 'human' } }],
  ];
  for (const [name, approvals] of bad) assert.throws(() => createQcEntry({ ...base, approvals: approvals as never }), (e: Error) => e instanceof RangeError && !e.message.includes('CANARY'), name);
  // QC may only ever ask the store two things.
  const asked = new Set<string>();
  const spy = new Proxy(store, { get(target, prop) { asked.add(String(prop)); return (target as any)[prop]; } });
  const g = build('memory');
  const f = await finished(g);
  const qc = createQcEntry({ plan: ['mock-note'], readers: { 'mock-note': g.note.reader }, now: nowIso, approvals: { store: new Proxy(g.store, { get(target, prop) { asked.add(String(prop)); return (target as any)[prop]; } }), tools: humanApprovalExpectations(g.tools) } });
  assert.equal(((await qc.run(await qcCtx(), f.candidate, f.h)) as any).verdict.verdict, 'pass');
  assert.deepEqual([...asked].filter((p) => !['findByStep', 'events'].includes(p)), [], 'QC touched nothing but findByStep and events');
  void spy;
});

// ---------------------------------------------------------------- the whole pipeline
t('pipeline: pause, approve, resume, and the verdict carries nine passing checks; an unrecorded success escalates through the human checks', async () => {
  for (const unrecorded of [false, true]) {
    const note = createMockNoteTool();
    const tools = createToolRegistry({ 'mock-note': human(note) });
    const real = createInMemoryApprovalStore({ now: nowIso, idempotentTools: idempotentToolNames(tools) });
    const procStore = unrecorded ? ((): ApprovalStore => { const w: any = { leaseSeconds: real.leaseSeconds }; for (const m of ['putProposal', 'recordDecision', 'claim', 'resolve', 'get', 'findByStep', 'events'] as const) w[m] = (...a: any[]) => (real as any)[m](...a); w.complete = () => Promise.reject(new Error(CANARY)); return Object.freeze(w); })() : real;
    const processing = createProcessingEntry({ tools, plan: ['mock-note'], now: nowIso, approval: { store: procStore } });
    const qc = createQcEntry({ plan: ['mock-note'], readers: { 'mock-note': note.reader }, now: nowIso, approvals: { store: real, tools: humanApprovalExpectations(tools) } });
    const reporting = createReportingEntry({ now: nowIso });
    let n = 0;
    const pipeline = createPipeline({
      intake, processing, qc, reporting, processingToolScopes: [MOCK_NOTE_SCOPE], qcReaderScopes: [MOCK_NOTE_READ_SCOPE],
      sources: {
        verify: (c: unknown) => (c === 'cred' ? { kind: 'user', id: 'user-plumbing' } : undefined), selectTenant: () => PW,
        grants: () => ['intake:run', 'processing:run', MOCK_NOTE_SCOPE, 'quality-control:run', MOCK_NOTE_READ_SCOPE, 'reporting:run'], newCorrelationId: () => `corr-qcap-${++n}`,
      },
    });
    const first: any = await pipeline.run('cred', pmsg);
    assert.equal(first.outcome, 'awaiting-approval');
    await approve(real, first.pending);
    const second: any = await pipeline.run('cred', pmsg);
    assert.equal(second.outcome, 'reported');
    if (!unrecorded) {
      assert.deepEqual([second.verdict, second.report.counts.verified_simulated_pass], ['pass', 1]);
    } else {
      assert.deepEqual([second.verdict, second.report.counts.verified_simulated_pass, second.report.counts.escalate], ['escalate', 0, 1]);
      assert.ok(second.report.exceptions[0].checks.some((c: any) => c.check === 'durable_completion' && c.reason === 'RECORD_UNCERTAIN'));
    }
  }
});

// ---------------------------------------------------------------- QC and Processing must agree on which steps need a human
each('a QC that was not told about the human-approved tool cannot wave the step through: the human checks fail', async (kind) => {
  const g = build(kind);
  const f = await finished(g);
  assert.equal(f.candidate.steps[0].approval, 'human', 'the step says it needed a human');
  const unaware = createQcEntry({ plan: ['mock-note'], readers: { 'mock-note': g.note.reader }, now: nowIso });
  const r: any = await unaware.run(await qcCtx(), f.candidate, f.h);
  const by = Object.fromEntries(r.verdict.checks.map((c: any) => [c.check, c.reason ? `${c.result}:${c.reason}` : c.result]));
  assert.deepEqual(humanOf(by), ['fail:MISMATCH', 'fail:MISMATCH', 'fail:MISMATCH']);
  assert.equal(r.verdict.verdict, 'rework', 'never a pass');
  const empty = createQcEntry({ plan: ['mock-note'], readers: { 'mock-note': g.note.reader }, now: nowIso, approvals: { store: g.store, tools: {} } });
  assert.equal(((await empty.run(await qcCtx(), f.candidate, f.h)) as any).verdict.verdict, 'rework', 'an empty list waives nothing either');
});

t('a step that ran without the human gate fails when QC expects one, even though the store has no record to contradict it', async () => {
  const note = createMockNoteTool();
  const assistedTools = createToolRegistry({ 'mock-note': note });                    // Processing treats the tool as assisted
  const processing = createProcessingEntry({ tools: assistedTools, plan: ['mock-note'], now: nowIso });
  const h = await handoffFor();
  const cand: any = ((await processing.run(await procCtx(), h)) as any).candidate;
  assert.equal(cand.status, 'complete');
  assert.equal('approval' in cand.steps[0], false, 'an assisted step carries no approval flag');
  const store = createInMemoryApprovalStore({ now: nowIso });
  const w = view(store);
  const qc = createQcEntry({ plan: ['mock-note'], readers: { 'mock-note': note.reader }, now: nowIso, approvals: { store: w.store, tools: { 'mock-note': { arguments: {} } } } });
  const r: any = await qc.run(await qcCtx(), cand, h);
  const by = Object.fromEntries(r.verdict.checks.map((c: any) => [c.check, c.reason ? `${c.result}:${c.reason}` : c.result]));
  assert.deepEqual(humanOf(by), ['fail:MISMATCH', 'fail:MISMATCH', 'fail:MISMATCH']);
  assert.equal(r.verdict.verdict, 'rework');
  assert.deepEqual(w.calls, [], 'the store was not needed to see that the gate was skipped');
});

each('a skipped human step is not judged, and the flag is on every step of a human tool but on no other', async (kind) => {
  at(T0);
  const first = createMockNoteTool('tool:a:write', 'tool:a:read');
  const note = createMockNoteTool();
  const tools = createToolRegistry({ a: { scope: 'tool:a:write', run: () => { throw new Error(CANARY); } }, 'mock-note': human(note) });
  const cfg = { now: nowIso, idempotentTools: idempotentToolNames(tools) };
  let store: ApprovalStore;
  if (kind === 'sqlite') { const s2 = createSqliteApprovalStore({ path: join(dir, `db-${++fileCounter}.db`), ...cfg }); openStores.push(s2); store = s2; } else store = createInMemoryApprovalStore(cfg);
  const processing = createProcessingEntry({ tools, plan: ['a', 'mock-note'], now: nowIso, approval: { store } });
  const h = await handoffFor();
  const ctx = await agentCtx(PW, 'processing', [PROCESSING_RUN_SCOPE, 'tool:a:write', MOCK_NOTE_SCOPE], 'user-requester', 'corr-skip');
  const cand: any = ((await processing.run(ctx, h)) as any).candidate;
  assert.deepEqual(cand.steps.map((x: any) => [x.tool, x.status, x.approval ?? null]), [['a', 'uncertain', null], ['mock-note', 'skipped', 'human']]);
  const w = view(store);
  const qc = createQcEntry({ plan: ['a', 'mock-note'], readers: { a: first.reader, 'mock-note': note.reader }, now: nowIso, approvals: { store: w.store, tools: humanApprovalExpectations(tools) } });
  const qctx = await agentCtx(PW, 'quality-control', [QC_RUN_SCOPE, 'tool:a:read', MOCK_NOTE_READ_SCOPE], 'user-qc', 'corr-qc-skip');
  const r: any = await qc.run(qctx, cand, h);
  const by = Object.fromEntries(r.verdict.checks.map((c: any) => [c.check, c.reason ? `${c.result}:${c.reason}` : c.result]));
  assert.deepEqual(humanOf(by), ['pass', 'pass', 'pass'], 'nothing was attempted, so nothing needed approval yet');
  assert.equal(r.verdict.verdict, 'escalate', 'the uncertain first step still escalates');
  assert.deepEqual(w.calls, []);
});

t('the approval flag is validated: only "human", and only as an optional step key', async () => {
  const g = build('memory');
  const f = await finished(g);
  const good = JSON.parse(JSON.stringify(f.candidate));
  const { validateCandidate } = await import('../src/candidate-result.ts');
  assert.deepEqual(validateCandidate(good), []);
  for (const bad of ['robot', true, 1, null, '', 'Human']) assert.notDeepEqual(validateCandidate({ ...good, steps: [{ ...good.steps[0], approval: bad }] }), [], String(bad));
  const { approval, ...without } = good.steps[0]; void approval;
  assert.deepEqual(validateCandidate({ ...good, steps: [without] }), [], 'a candidate without the flag is still a valid candidate (QC is what notices)');
});

// ---------------------------------------------------------------- inventory
t('inventory: QC judges with two read-only calls, settles in one place only, and imports no producer, tool or concrete store', () => {
  const dirSrc = new URL('../src/', import.meta.url);
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const code = strip(readFileSync(new URL('qc-entry.ts', dirSrc), 'utf8'));
  assert.ok(/\.findByStep\(/.test(code) && /\.events\(/.test(code));
  const allowed = code.replace(/Promise\.resolve\(/g, '').replace(/\bcap\.resolve\(/g, '').replace(/\bsettle\.resolve\(/g, '');
  assert.equal((code.match(/\bsettle\.resolve\(/g) ?? []).length, 1, 'exactly one place settles an in-doubt claim: the read-back in reconcile');
  assert.ok(!/\.(?:claim|complete|putProposal|recordDecision|resolve)\(/.test(allowed), 'QC calls none of the other store operations that change anything');
  assert.ok(/Pick<ApprovalStore, 'findByStep' \| 'events'>/.test(code), 'QC takes a two-operation view');
  for (const m of code.matchAll(/from\s+'([^']+)'/g)) assert.ok(m[1].startsWith('./'), `imports ${m[1]}`);
  assert.ok(!/from\s+'\.\/(processing-entry|intake-entry|tenant-boundary|live-run|approval-store-sqlite|approver-context|mock-tools)\.ts'/.test(code.replace(/import type[^;]*mock-tools\.ts';/, '')));
  assert.ok(/import type \{[^}]*ApprovalStore[^}]*\} from '\.\/approval-store\.ts'/.test(code) && /import \{ verifyEventLog \} from '\.\/approval-store\.ts'/.test(code), 'only the log checker is a value import');
  const files = readdirSync(dirSrc).filter((f) => f.endsWith('.ts'));
  assert.deepEqual(files.filter((f) => /humanApprovalExpectations/.test(strip(readFileSync(new URL(f, dirSrc), 'utf8')))), ['processing-entry.ts'], 'one place says which tools need a human');
});
