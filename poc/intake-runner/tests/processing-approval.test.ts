// Tests for the human-approved mock-note path in Processing: propose, pause, resume, durable claim before execution, then the mock
// call. Runs on the in-memory store and on the development-only SQLite store. Mock provider, mock tools, mock contexts, synthetic
// data only. No network, no key, no real side effect.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
import type { ProcessingResult, ToolDefinition } from '../src/processing-entry.ts';
import { createDelayedNoteTool, createMockNoteTool, MOCK_NOTE_READ_SCOPE, MOCK_NOTE_SCOPE } from '../src/mock-tools.ts';
import { stepIdFor, validateCandidate } from '../src/candidate-result.ts';
import { createQcEntry, QC_RUN_SCOPE } from '../src/qc-entry.ts';
import { createReportingEntry, REPORTING_RUN_SCOPE } from '../src/reporting-entry.ts';
import { createPipeline } from '../src/pipeline.ts';
import type { ObsEvent } from '../src/observability.ts';
import { classifyAnswer, createMockProvider, extractAnswer } from '../src/mock-provider.ts';

const CANARY = 'CANARY-HAPP-6671';
const T0 = '2026-10-25T22:00:00Z';
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

const dir = mkdtempSync(join(tmpdir(), 'processing-approval-'));
const openStores: SqliteApprovalStore[] = [];
let fileCounter = 0;
after(() => { for (const s of openStores) s.close(); rmSync(dir, { recursive: true, force: true }); });

async function agentCtx(tenant: string, agent: AgentName, scopes: string[], id = 'user-requester', corr = 'corr-proc'): Promise<ExecutionContext> {
  const r = await mintExecutionContext({ credential: 'c', agent }, { verify: () => ({ kind: 'user', id }), selectTenant: () => tenant, grants: () => scopes, newCorrelationId: () => corr });
  assert.equal(r.ok, true);
  return (r as { context: ExecutionContext }).context;
}
const procCtx = (tenant = PW, scopes: string[] = [PROCESSING_RUN_SCOPE, MOCK_NOTE_SCOPE], corr = 'corr-proc') => agentCtx(tenant, 'processing', scopes, 'user-requester', corr);
const qcCtx = (tenant = PW) => agentCtx(tenant, 'quality-control', ['quality-control:run'], 'user-qc', 'corr-qc');
async function approverCtx(tenant = PW, id = 'user-boss'): Promise<ApproverContext> {
  const r = await mintApproverContext({ credential: 'c', workspace_id: tenant }, {
    verify: () => ({ kind: 'user', id, assurance: 'multi-factor', authenticated_at: T0, session_expires_at: '2026-10-26T06:00:00Z' }),
    membership: () => true, grants: () => [approvalScopeFor('mock-note')], newCorrelationId: () => `corr-${id}`, now: nowIso,
  });
  assert.equal(r.ok, true);
  return (r as { context: ApproverContext }).context;
}

const VALUES: Record<string, string> = { Address: '[ADDRESS_1]', 'Job description': 'Burst pipe repair', 'Patient reference': '[ID_1]', 'Insurance provider': 'Example Health' };
const provider = () => createMockProvider({
  classify_request: (req) => classifyAnswer((req.data.categories ?? []).includes('Emergency leak') ? 'Emergency leak' : 'New patient', 0.9),
  extract_fields: (req) => extractAnswer((req.data.fields ?? []).map((f) => ({ name: f.name, value: VALUES[f.name] ?? null, confidence: VALUES[f.name] ? 0.9 : null }))),
});
const intake = createIntakeEntry({ registry: createTenantRegistry({ [PW]: pcfg, [DW]: dcfg }), provider: provider(), channelRef: 'channel-happ-test', now: () => '2026-10-25T22:00:00Z' });
async function handoffFor(tenant = PW, message: Record<string, unknown> = pmsg) {
  const r = await intake.run(await agentCtx(tenant, 'intake', ['intake:run'], 'user-requester', 'corr-intake'), message);
  assert.equal(r.ok, true);
  return (r as any).handoff;
}

type Kind = 'memory' | 'sqlite';
const humanTool = (base: { scope: string; run: ToolDefinition['run'] }, o: { idempotent?: boolean; args?: unknown } = {}): ToolDefinition => ({
  scope: base.scope, run: base.run, approval: 'human', ...(o.idempotent !== undefined ? { idempotent: o.idempotent } : {}), ...(o.args !== undefined ? { approvalArguments: o.args } : {}),
});
interface Rig { kind: Kind; store: ApprovalStore; entry: ReturnType<typeof createProcessingEntry>; file: string | null; tools: ReturnType<typeof createToolRegistry>; reopen(): Rig }
function rig(kind: Kind, defs: Record<string, ToolDefinition>, over: { plan?: string[]; timeoutMs?: number; ttl?: number; sink?: { write(e: ObsEvent): void }; file?: string; storeWrap?: (s: ApprovalStore) => ApprovalStore; maxAttempts?: number } = {}): Rig {
  at(clock);
  const tools = createToolRegistry(defs);
  const file = kind === 'sqlite' ? (over.file ?? join(dir, `db-${++fileCounter}.db`)) : null;
  const cfg = { now: nowIso, idempotentTools: idempotentToolNames(tools), ...(over.maxAttempts ? { maxAttempts: over.maxAttempts } : {}) };
  let raw: ApprovalStore;
  if (kind === 'sqlite') { const s = createSqliteApprovalStore({ path: file as string, ...cfg }); openStores.push(s); raw = s; } else raw = createInMemoryApprovalStore(cfg);
  const store = over.storeWrap ? over.storeWrap(raw) : raw;
  const entry = createProcessingEntry({ tools, plan: over.plan ?? Object.keys(defs).slice(0, 1), now: nowIso, timeoutMs: over.timeoutMs ?? 5000, approval: { store, ttlSeconds: over.ttl ?? 3600 }, ...(over.sink ? { sink: over.sink } : {}) });
  return {
    kind, store, entry, file, tools,
    reopen() {
      if (kind !== 'sqlite') throw new Error('only the SQLite store can be reopened');
      (raw as SqliteApprovalStore).close();
      return rig(kind, defs, { ...over, file: file as string });
    },
  };
}
function wrap(real: ApprovalStore, over: Partial<Record<keyof ApprovalStore, (...a: any[]) => unknown>>): ApprovalStore {
  const methods = ['putProposal', 'recordDecision', 'claim', 'complete', 'resolve', 'get', 'findByStep', 'events'] as const;
  const out: any = { leaseSeconds: (real as any).leaseSeconds };
  for (const m of methods) out[m] = over[m] ?? ((...a: any[]) => (real as any)[m](...a));
  return Object.freeze(out);
}
const stateOf = async (store: ApprovalStore, tenant: string, step: string): Promise<string> => {
  const r: any = await store.findByStep(await procCtx(tenant), step);
  return r.ok ? r.snapshot.state : r.error.code;
};
async function answer(store: ApprovalStore, pending: any, decision: 'approved' | 'declined' = 'approved', who?: ApproverContext) {
  const ctx = who ?? await approverCtx(pending.proposal.workspace_id);
  const d: any = decideProposal(ctx, pending.proposal, { decision, reason_code: 'within_policy' }, { now: nowIso });
  assert.equal(d.ok, true, JSON.stringify(d.error));
  const r: any = await store.recordDecision(ctx, d.decision);
  assert.equal(r.ok, true, JSON.stringify(r.error));
}
function pendingOf(r: ProcessingResult): any {
  assert.equal(r.ok, true, JSON.stringify((r as any).error));
  assert.ok('pending' in (r as any), `expected pending, got ${JSON.stringify(r)}`);
  return (r as any).pending;
}
function candOf(r: ProcessingResult): any {
  assert.equal(r.ok, true, JSON.stringify((r as any).error));
  assert.ok('candidate' in (r as any), `expected a candidate, got ${JSON.stringify(r)}`);
  const c = (r as any).candidate;
  assert.deepEqual(validateCandidate(c), []);
  return c;
}
function closed(r: ProcessingResult) {
  assert.equal(r.ok, false, 'expected the run to fail closed');
  assert.equal((r as any).error.code, 'PROCESSING_ERROR');
  assert.ok(!(r as any).error.message.includes('CANARY'));
}
const brief = (c: any) => [c.status, c.steps[0].status, c.steps[0].code ?? null];

/** A test that starts from a fresh clock. */
function t(title: string, fn: () => unknown) { test(title, () => { at(T0); return fn(); }); }

function each(title: string, fn: (kind: Kind) => Promise<void>) {
  for (const kind of ['memory', 'sqlite'] as Kind[]) test(`${kind}: ${title}`, () => { at(T0); return fn(kind); });
}

// ---------------------------------------------------------------- pause and resume
each('the first run proposes and pauses without calling the tool; running it again changes nothing', async (kind) => {
  const note = createMockNoteTool();
  const g = rig(kind, { 'mock-note': humanTool(note) });
  const h = await handoffFor();
  const ctx = await procCtx();
  const p1 = pendingOf(await g.entry.run(ctx, h));
  assert.deepEqual([p1.kind, p1.tool, p1.item_id, p1.step_id], ['awaiting_approval', 'mock-note', h.item_id, stepIdFor(PW, h.item_id, 0, 'mock-note')]);
  assert.match(p1.proposal_id, /^ap-[0-9a-f]{12}$/);
  assert.ok(p1.proposal && p1.proposal.proposal_id === p1.proposal_id, 'the sealed proposal is handed to an in-process approval surface');
  assert.ok(Object.isFrozen(p1));
  assert.equal(note.calls(), 0);
  assert.equal(await stateOf(g.store, PW, p1.step_id), 'requested');
  const p2 = pendingOf(await g.entry.run(ctx, h));
  assert.equal(p2.proposal_id, p1.proposal_id, 'the same request, not a second one');
  const events: any = await g.store.events(ctx, p1.proposal_id);
  assert.equal(events.events.length, 1, 'nothing new was recorded');
  assert.equal(note.calls(), 0);
});

each('after approval the next run claims first, then calls the tool once, then records the evidence; a replay makes no call', async (kind) => {
  const note = createMockNoteTool();
  const seen: any[] = [];
  const probe = await procCtx();
  const g = rig(kind, { 'mock-note': humanTool({ scope: MOCK_NOTE_SCOPE, run: async (args, sig) => {
    const r: any = await g.store.findByStep(probe, args.step_id);
    seen.push({ keys: Object.keys(args).sort(), state: r.snapshot.state, attempt: r.snapshot.claim?.attempt });
    return note.run(args, sig);
  } }) });
  const h = await handoffFor();
  const ctx = await procCtx();
  const pend = pendingOf(await g.entry.run(ctx, h));
  await answer(g.store, pend);
  const c = candOf(await g.entry.run(ctx, h));
  assert.deepEqual(brief(c), ['complete', 'ok', null]);
  assert.equal(note.calls(), 1);
  assert.deepEqual(c.evidence_refs, [note.writes[0].evidence_ref]);
  assert.deepEqual(seen, [{ keys: ['item_id', 'step_id', 'workspace_id'], state: 'claimed', attempt: 1 }], 'already claimed when the tool ran, and the tool never sees the fence token');
  assert.equal(await stateOf(g.store, PW, pend.step_id), 'succeeded');
  const again = candOf(await g.entry.run(ctx, h));
  assert.deepEqual(again.evidence_refs, c.evidence_refs);
  assert.equal(note.calls(), 1, 'a replay makes no second call');
});

t('sqlite: the claim is committed to the database file before the tool is called', async () => {
  const note = createMockNoteTool();
  let file = '';
  const rows: any[] = [];
  const g = rig('sqlite', { 'mock-note': humanTool({ scope: MOCK_NOTE_SCOPE, run: async (args, sig) => {
    const raw = new DatabaseSync(file);                       // a separate connection sees only what is committed
    rows.push(raw.prepare('SELECT state, attempts, claim_id IS NOT NULL AS has_claim FROM approvals WHERE tenant = ? AND step_id = ?').get(PW, args.step_id));
    raw.close();
    return note.run(args, sig);
  } }) });
  file = g.file as string;
  const h = await handoffFor();
  const ctx = await procCtx();
  await answer(g.store, pendingOf(await g.entry.run(ctx, h)));
  candOf(await g.entry.run(ctx, h));
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ state: 'claimed', attempts: 1, has_claim: 1 }]);
});

// ---------------------------------------------------------------- decline, expiry, wrong approvals
each('a declined request fails the step with APPROVAL_DECLINED, calls nothing, and stays declined', async (kind) => {
  const note = createMockNoteTool();
  const g = rig(kind, { 'mock-note': humanTool(note) });
  const h = await handoffFor(); const ctx = await procCtx();
  await answer(g.store, pendingOf(await g.entry.run(ctx, h)), 'declined');
  for (let i = 0; i < 2; i++) assert.deepEqual(brief(candOf(await g.entry.run(ctx, h))), ['failed', 'failed', 'APPROVAL_DECLINED']);
  assert.equal(note.calls(), 0);
});

each('an unanswered request expires and the next run asks again; nothing is called', async (kind) => {
  const note = createMockNoteTool();
  const g = rig(kind, { 'mock-note': humanTool(note) }, { ttl: 120 });
  const h = await handoffFor(); const ctx = await procCtx();
  const first = pendingOf(await g.entry.run(ctx, h));
  at(plus(200));
  const second = pendingOf(await g.entry.run(ctx, h));
  assert.notEqual(second.proposal_id, first.proposal_id);
  assert.equal(second.kind, 'awaiting_approval');
  const old: any = await g.store.events(ctx, first.proposal_id);
  assert.deepEqual(old.events.map((e: any) => e.type), ['requested', 'expired']);
  assert.equal(note.calls(), 0);
});

each('an approval for another item never releases this one', async (kind) => {
  const note = createMockNoteTool();
  const g = rig(kind, { 'mock-note': humanTool(note) });
  const ctx = await procCtx();
  const a = await handoffFor(PW, pmsg); const b = await handoffFor(PW, { ...pmsg, event_id: 'evt-synthetic-b' });
  const pa = pendingOf(await g.entry.run(ctx, a)); const pb = pendingOf(await g.entry.run(ctx, b));
  assert.notEqual(pa.proposal_id, pb.proposal_id);
  await answer(g.store, pb);
  assert.equal(pendingOf(await g.entry.run(ctx, a)).kind, 'awaiting_approval');
  assert.equal(note.calls(), 0);
  assert.deepEqual(brief(candOf(await g.entry.run(ctx, b))), ['complete', 'ok', null]);
  assert.equal(note.calls(), 1);
  assert.equal(note.writes[0].item_id, b.item_id);
});

each('the requester cannot approve their own request, so the run stays paused', async (kind) => {
  const note = createMockNoteTool();
  const g = rig(kind, { 'mock-note': humanTool(note) });
  const h = await handoffFor(); const ctx = await procCtx();
  const pend = pendingOf(await g.entry.run(ctx, h));
  const self: any = decideProposal(await approverCtx(PW, 'user-requester'), pend.proposal, { decision: 'approved', reason_code: 'within_policy' }, { now: nowIso });
  assert.equal(self.error.code, 'SELF_APPROVAL');
  const agentAsApprover: any = decideProposal(ctx, pend.proposal, { decision: 'approved', reason_code: 'within_policy' }, { now: nowIso });
  assert.equal(agentAsApprover.error.code, 'APPROVER_NOT_HUMAN');
  assert.equal(pendingOf(await g.entry.run(ctx, h)).kind, 'awaiting_approval');
  assert.equal(note.calls(), 0);
});

each('a changed action at claim time is refused: nothing is called and the approval is not used up', async (kind) => {
  const note = createMockNoteTool();
  const g = rig(kind, { 'mock-note': humanTool(note, { args: { mode: 'a' } }) });
  const h = await handoffFor(); const ctx = await procCtx();
  const pend = pendingOf(await g.entry.run(ctx, h));
  await answer(g.store, pend);
  const changed = createProcessingEntry({
    tools: createToolRegistry({ 'mock-note': humanTool(note, { args: { mode: 'b' } }) }), plan: ['mock-note'], now: nowIso, approval: { store: g.store },
  });
  closed(await changed.run(ctx, h));
  assert.equal(note.calls(), 0);
  assert.equal(await stateOf(g.store, PW, pend.step_id), 'approved');
  assert.deepEqual(brief(candOf(await g.entry.run(ctx, h))), ['complete', 'ok', null], 'the original action still works');
});

each('four runs at once after approval make one call; the others report that it is in progress', async (kind) => {
  const note = createMockNoteTool();
  const g = rig(kind, { 'mock-note': humanTool(note) });
  const h = await handoffFor(); const ctx = await procCtx();
  await answer(g.store, pendingOf(await g.entry.run(ctx, h)));
  const results = await Promise.all(Array.from({ length: 4 }, () => g.entry.run(ctx, h)));
  const cands = results.filter((r) => 'candidate' in (r as any));
  const waits = results.filter((r) => 'pending' in (r as any));
  assert.equal(cands.length, 1);
  assert.deepEqual(waits.map((r) => (r as any).pending.kind), ['in_progress', 'in_progress', 'in_progress']);
  assert.equal(note.calls(), 1);
});

// ---------------------------------------------------------------- uncertainty is preserved
each('a timeout leaves the claim open: no blind retry, and a non-idempotent tool is not called again after the lease lapses', async (kind) => {
  const tool = createDelayedNoteTool();
  const g = rig(kind, { 'mock-note': humanTool(tool) }, { timeoutMs: 30 });
  const h = await handoffFor(); const ctx = await procCtx();
  const pend = pendingOf(await g.entry.run(ctx, h));
  await answer(g.store, pend);
  assert.deepEqual(brief(candOf(await g.entry.run(ctx, h))), ['uncertain', 'uncertain', 'TOOL_TIMEOUT']);
  assert.equal(tool.calls(), 1);
  assert.equal(await stateOf(g.store, PW, pend.step_id), 'claimed', 'nothing was recorded as failed');
  assert.equal(pendingOf(await g.entry.run(ctx, h)).kind, 'in_progress', 'the lease is still open');
  assert.equal(tool.calls(), 1);
  at(plus(120));
  assert.deepEqual(brief(candOf(await g.entry.run(ctx, h))), ['uncertain', 'uncertain', 'TOOL_TIMEOUT']);
  assert.equal(await stateOf(g.store, PW, pend.step_id), 'in_doubt');
  assert.equal(tool.calls(), 1, 'never called again');
});

each('an idempotent tool is retried only after the lapse, with the same step id, and only up to the attempt limit', async (kind) => {
  const tool = createDelayedNoteTool();
  const g = rig(kind, { 'mock-note': humanTool(tool, { idempotent: true }) }, { timeoutMs: 30, maxAttempts: 2 });
  const h = await handoffFor(); const ctx = await procCtx();
  const pend = pendingOf(await g.entry.run(ctx, h));
  await answer(g.store, pend);
  await g.entry.run(ctx, h);
  assert.equal(tool.calls(), 1);
  await g.entry.run(ctx, h);
  assert.equal(tool.calls(), 1, 'not while the lease is open');
  at(plus(120));
  assert.equal(candOf(await g.entry.run(ctx, h)).status, 'uncertain');
  assert.equal(tool.calls(), 2, 'one retry');
  at(plus(300));
  assert.equal(candOf(await g.entry.run(ctx, h)).status, 'uncertain');
  assert.equal(tool.calls(), 2, 'the attempt limit stops it');
  assert.equal(await stateOf(g.store, PW, pend.step_id), 'in_doubt');
});

each('a write that lands after a timeout is recorded; it never causes a second call', async (kind) => {
  const tool = createDelayedNoteTool();
  const g = rig(kind, { 'mock-note': humanTool(tool, { idempotent: true }) }, { timeoutMs: 30 });
  const h = await handoffFor(); const ctx = await procCtx();
  const pend = pendingOf(await g.entry.run(ctx, h));
  await answer(g.store, pend);
  assert.equal(candOf(await g.entry.run(ctx, h)).status, 'uncertain');
  tool.land(); await tick(); await tick();
  assert.equal(await stateOf(g.store, PW, pend.step_id), 'succeeded', 'the late write was recorded');
  const c = candOf(await g.entry.run(ctx, h));
  assert.deepEqual(brief(c), ['complete', 'ok', null]);
  assert.deepEqual(c.evidence_refs, [tool.writes[0].evidence_ref]);
  assert.equal(tool.calls(), 1, 'even though the tool is idempotent');
});

each('a late "not performed" ends the request so a new approval can be asked; a late error changes nothing', async (kind) => {
  const tool = createDelayedNoteTool();
  const g = rig(kind, { 'mock-note': humanTool(tool) }, { timeoutMs: 30 });
  const h = await handoffFor(); const ctx = await procCtx();
  const pend = pendingOf(await g.entry.run(ctx, h));
  await answer(g.store, pend);
  await g.entry.run(ctx, h);
  tool.decline(); await tick(); await tick();
  assert.equal(await stateOf(g.store, PW, pend.step_id), 'failed');
  at(plus(2));
  assert.equal(pendingOf(await g.entry.run(ctx, h)).kind, 'awaiting_approval');
  assert.equal(tool.calls(), 1);

  const crashing = createDelayedNoteTool();
  const g2 = rig(kind, { 'mock-note': humanTool(crashing) }, { timeoutMs: 30 });
  const h2 = await handoffFor(PW, { ...pmsg, event_id: 'evt-synthetic-crash' });
  const p2 = pendingOf(await g2.entry.run(ctx, h2));
  await answer(g2.store, p2);
  await g2.entry.run(ctx, h2);
  crashing.crash(); await tick(); await tick();
  assert.equal(await stateOf(g2.store, PW, p2.step_id), 'claimed', 'a late error proves nothing');
});

each('a throw or an unreadable answer is uncertain and records nothing; Quality Control settles it and no call follows', async (kind) => {
  for (const [name, run] of [['throw', () => { throw new Error(CANARY); }], ['garbage', () => 'done'], ['no evidence', () => ({ other: 1 })]] as [string, ToolDefinition['run']][]) {
    let calls = 0;
    const g = rig(kind, { 'mock-note': humanTool({ scope: MOCK_NOTE_SCOPE, run: (a, s) => { calls++; return run(a, s); } }) });
    const h = await handoffFor(PW, { ...pmsg, event_id: `evt-synthetic-${name.replace(' ', '-')}` }); const ctx = await procCtx();
    const pend = pendingOf(await g.entry.run(ctx, h));
    await answer(g.store, pend);
    const c = candOf(await g.entry.run(ctx, h));
    assert.equal(c.status, 'uncertain', name);
    assert.ok(!JSON.stringify(c).includes('CANARY'));
    assert.equal(await stateOf(g.store, PW, pend.step_id), 'claimed', `${name}: nothing recorded`);
    at(plus(120));
    assert.equal(candOf(await g.entry.run(ctx, h)).status, 'uncertain');
    assert.equal(calls, 1, name);
    const settled: any = await g.store.resolve(await qcCtx(), pend.proposal_id, { status: 'succeeded', evidence_ref: 'mock-note:settled' });
    assert.equal(settled.ok, true, JSON.stringify(settled.error));
    const done = candOf(await g.entry.run(ctx, h));
    assert.deepEqual([done.status, done.evidence_refs], ['complete', ['mock-note:settled']]);
    assert.equal(calls, 1, `${name}: settled without another call`);
    at(T0);
  }
});

each('a tool that says it did not perform is recorded as failed, and only then may a new approval be asked', async (kind) => {
  let calls = 0;
  const g = rig(kind, { 'mock-note': humanTool({ scope: MOCK_NOTE_SCOPE, run: () => { calls++; return { not_performed: true }; } }) });
  const h = await handoffFor(); const ctx = await procCtx();
  const pend = pendingOf(await g.entry.run(ctx, h));
  await answer(g.store, pend);
  assert.deepEqual(brief(candOf(await g.entry.run(ctx, h))), ['failed', 'failed', 'TOOL_NOT_PERFORMED']);
  assert.equal(await stateOf(g.store, PW, pend.step_id), 'failed');
  at(plus(2));
  assert.equal(pendingOf(await g.entry.run(ctx, h)).kind, 'awaiting_approval');
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------- the store fails: the run fails closed
const BEHAVIOURS: [string, () => unknown][] = [
  ['throws', () => { throw new Error(CANARY); }], ['rejects', () => Promise.reject(new Error(CANARY))], ['hangs', () => new Promise(() => {})],
  ['returns garbage', () => 'nope'], ['returns a half answer', () => ({ ok: false })], ['refuses', () => ({ ok: false, error: { code: 'STORE_ERROR', message: 'x' } })],
];
each('a failing store fails the run closed at every step: no call, no pause, never a throw', async (kind) => {
  for (const [name, behave] of BEHAVIOURS) {
    for (const method of ['findByStep', 'putProposal', 'claim'] as const) {
      const note = createMockNoteTool();
      const g = rig(kind, { 'mock-note': humanTool(note) }, { timeoutMs: 30, storeWrap: (real) => wrap(real, {}) });
      // Build a second entry over the same real store but with one broken method.
      const real = g.store;
      const h = await handoffFor(PW, { ...pmsg, event_id: `evt-synthetic-${method}-${name.replace(/ /g, '-')}` }); const ctx = await procCtx();
      if (method === 'claim') { const pend = pendingOf(await g.entry.run(ctx, h)); await answer(real, pend); }
      const broken = createProcessingEntry({ tools: g.tools, plan: ['mock-note'], now: nowIso, timeoutMs: 30, approval: { store: wrap(real, { [method]: behave }) } });
      closed(await broken.run(ctx, h));
      assert.equal(note.calls(), 0, `${method} ${name}`);
      const state = await stateOf(real, PW, stepIdFor(PW, h.item_id, 0, 'mock-note'));
      assert.equal(state, method === 'claim' ? 'approved' : method === 'putProposal' ? 'STORE_NOT_FOUND' : 'STORE_NOT_FOUND', `${method} ${name}: nothing changed`);
    }
  }
});

// ---------------------------------------------------------------- an outcome the store did not accept is not verified
const REFUSALS: [string, () => unknown][] = [
  ...BEHAVIOURS,
  ['a stale claim', () => ({ ok: false, error: { code: 'STALE_CLAIM', message: 'x' } })],
  ['an effect already done', () => ({ ok: false, error: { code: 'EFFECT_ALREADY_DONE', message: 'x' } })],
];
async function unrecorded(kind: Kind, run: ToolDefinition['run'], behave: () => unknown, label: string, o: { idempotent?: boolean } = {}) {
  const calls = { n: 0 };
  const note = createMockNoteTool();
  const g = rig(kind, { 'mock-note': humanTool({ scope: MOCK_NOTE_SCOPE, run: (a, sg) => { calls.n++; return run === (null as any) ? note.run(a, sg) : run(a, sg); } }, o) }, { timeoutMs: 30 });
  const h = await handoffFor(PW, { ...pmsg, event_id: `evt-synthetic-rec-${label.replace(/[^a-z]+/gi, '-')}` });
  const ctx = await procCtx();
  const pend = pendingOf(await g.entry.run(ctx, h));
  await answer(g.store, pend);
  const broken = createProcessingEntry({ tools: g.tools, plan: ['mock-note'], now: nowIso, timeoutMs: 30, approval: { store: wrap(g.store, { complete: behave }) } });
  return { g, h, ctx, pend, broken, note, calls };
}

each('if the store does not accept the record of a success, the step is uncertain, never ok, and claims no evidence', async (kind) => {
  for (const [name, behave] of REFUSALS) {
    const u = await unrecorded(kind, null as any, behave, name);
    const c = candOf(await u.broken.run(u.ctx, u.h));
    assert.deepEqual(brief(c), ['uncertain', 'uncertain', 'COMPLETION_NOT_RECORDED'], name);
    assert.deepEqual(c.evidence_refs, [], `${name}: no evidence is claimed`);
    assert.ok(!JSON.stringify(c).includes('CANARY'));
    assert.equal(u.calls.n, 1, name);
    assert.equal(u.note.writes.length, 1, `${name}: the effect did happen, which is exactly why it must not be reported as verified`);
    assert.equal(await stateOf(u.g.store, PW, u.pend.step_id), 'claimed', `${name}: not recorded as succeeded`);
    at(plus(120));
    assert.equal(await stateOf(u.g.store, PW, u.pend.step_id), 'in_doubt', `${name}: the claim lapses to in-doubt`);
    at(T0);
  }
});

each('a "not performed" answer the store does not accept is also uncertain, not a recorded failure', async (kind) => {
  for (const [name, behave] of REFUSALS.slice(0, 4)) {
    const u = await unrecorded(kind, () => ({ not_performed: true }), behave, `np-${name}`);
    const c = candOf(await u.broken.run(u.ctx, u.h));
    assert.deepEqual(brief(c), ['uncertain', 'uncertain', 'COMPLETION_NOT_RECORDED'], name);
    assert.equal(await stateOf(u.g.store, PW, u.pend.step_id), 'claimed', name);
  }
});

each('after an unrecorded success: a non-idempotent tool is not called again, Quality Control settles it, and then the evidence is used', async (kind) => {
  const note = createMockNoteTool();
  const g = rig(kind, { 'mock-note': humanTool(note) }, { timeoutMs: 30 });
  const h = await handoffFor(); const ctx = await procCtx();
  const pend = pendingOf(await g.entry.run(ctx, h));
  await answer(g.store, pend);
  const broken = createProcessingEntry({ tools: g.tools, plan: ['mock-note'], now: nowIso, timeoutMs: 30, approval: { store: wrap(g.store, { complete: () => { throw new Error(CANARY); } }) } });
  assert.equal(candOf(await broken.run(ctx, h)).status, 'uncertain');
  assert.equal(note.calls(), 1);
  at(plus(120));
  assert.equal(candOf(await g.entry.run(ctx, h)).status, 'uncertain');
  assert.equal(note.calls(), 1, 'no blind second call');
  const evidence = note.writes[0].evidence_ref;
  const settled: any = await g.store.resolve(await qcCtx(), pend.proposal_id, { status: 'succeeded', evidence_ref: evidence });
  assert.equal(settled.ok, true, JSON.stringify(settled.error));
  const done = candOf(await g.entry.run(ctx, h));
  assert.deepEqual([done.status, done.evidence_refs], ['complete', [evidence]]);
  assert.equal(note.calls(), 1, 'settled without another call');
});

each('after an unrecorded success an idempotent tool is retried once with the same step id and the record is then accepted', async (kind) => {
  const note = createMockNoteTool();
  const g = rig(kind, { 'mock-note': humanTool(note, { idempotent: true }) }, { timeoutMs: 30 });
  const h = await handoffFor(); const ctx = await procCtx();
  const pend = pendingOf(await g.entry.run(ctx, h));
  await answer(g.store, pend);
  const broken = createProcessingEntry({ tools: g.tools, plan: ['mock-note'], now: nowIso, timeoutMs: 30, approval: { store: wrap(g.store, { complete: () => Promise.reject(new Error(CANARY)) }) } });
  assert.equal(candOf(await broken.run(ctx, h)).status, 'uncertain');
  at(plus(120));
  const c = candOf(await g.entry.run(ctx, h));
  assert.deepEqual(brief(c), ['complete', 'ok', null]);
  assert.equal(note.calls(), 2, 'the retry reached the tool');
  assert.equal(note.writes.length, 1, 'the tool deduped on the step id: one write');
  assert.equal(await stateOf(g.store, PW, pend.step_id), 'succeeded');
});

// ---------------------------------------------------------------- Quality Control and Reporting do not verify an unrecorded success
async function unrecordedChain(kind: Kind, tag: string) {
  const note = createMockNoteTool();
  const g = rig(kind, { 'mock-note': humanTool(note) }, { timeoutMs: 30 });
  const h = await handoffFor(PW, { ...pmsg, event_id: `evt-synthetic-chain-${tag}` });
  const ctx = await procCtx();
  const pend = pendingOf(await g.entry.run(ctx, h));
  await answer(g.store, pend);
  const broken = createProcessingEntry({ tools: g.tools, plan: ['mock-note'], now: nowIso, timeoutMs: 30, approval: { store: wrap(g.store, { complete: () => { throw new Error(CANARY); } }) } });
  const candidate = candOf(await broken.run(ctx, h));
  const qc = createQcEntry({ plan: ['mock-note'], readers: { 'mock-note': note.reader }, now: nowIso, approvals: { store: g.store, tools: humanApprovalExpectations(g.tools) }, timeoutMs: 100 });
  const qr: any = await qc.run(await agentCtx(PW, 'quality-control', [QC_RUN_SCOPE, MOCK_NOTE_READ_SCOPE], 'user-qc', `corr-qc-${tag}`), candidate, h);
  assert.equal(qr.ok, true, JSON.stringify(qr.error));
  return { note, g, h, candidate, verdict: qr.verdict, pend };
}
each('Quality Control does not verify an unrecorded success: the effect exists, but the verdict is escalate, never pass', async (kind) => {
  const u = await unrecordedChain(kind, `qc-${kind}`);
  assert.equal(u.note.writes.length, 1, 'the effect did happen');
  assert.deepEqual([u.candidate.status, u.candidate.evidence_refs], ['uncertain', []]);
  assert.equal(u.verdict.verdict, 'escalate');
  const by = Object.fromEntries(u.verdict.checks.map((c: any) => [c.check, c.reason ? `${c.result}:${c.reason}` : c.result]));
  assert.equal(by.consistency, 'unverifiable:CANDIDATE_UNCERTAIN');
  assert.equal(by.no_orphans, 'fail:ORPHAN', 'the tool-side record is not accounted for by the candidate');
  assert.ok(!JSON.stringify(u.verdict).includes('CANARY'));
});

each('Reporting does not count an unrecorded success as a verified pass: it is an escalation, with its reasons', async (kind) => {
  const u = await unrecordedChain(kind, `rpt-${kind}`);
  const reporting = createReportingEntry({ now: nowIso });
  const rctx = await agentCtx(PW, 'reporting', [REPORTING_RUN_SCOPE], 'user-rpt', 'corr-rpt');
  const sub: any = await reporting.submit(rctx, [{ envelope: u.h, candidate: u.candidate, verdict: u.verdict }]);
  assert.deepEqual([sub.ok, sub.accepted], [true, 1]);
  const rep: any = (await reporting.report(rctx) as any).report;
  assert.deepEqual([rep.counts.verified_simulated_pass, rep.counts.escalate, rep.counts.rework, rep.counts.chain_conflict], [0, 1, 0, 0]);
  assert.deepEqual(rep.exceptions[0].checks.map((c: any) => `${c.check}:${c.reason}`).sort(), ['consistency:CANDIDATE_UNCERTAIN', 'durable_completion:RECORD_UNCERTAIN', 'no_orphans:ORPHAN']);
});

t('pipeline: a run whose success could not be recorded ends as an escalation, never a verified pass', async () => {
  const note = createMockNoteTool();
  const real = createInMemoryApprovalStore({ now: nowIso });
  const store = wrap(real, { complete: () => { throw new Error(CANARY); } });
  const tools = createToolRegistry({ 'mock-note': humanTool(note) });
  const processing = createProcessingEntry({ tools, plan: ['mock-note'], now: nowIso, approval: { store } });
  const qc = createQcEntry({ plan: ['mock-note'], readers: { 'mock-note': note.reader }, now: nowIso, approvals: { store: real, tools: humanApprovalExpectations(tools) } });
  const reporting = createReportingEntry({ now: nowIso });
  let n = 0;
  const pipeline = createPipeline({
    intake, processing, qc, reporting, processingToolScopes: [MOCK_NOTE_SCOPE], qcReaderScopes: [MOCK_NOTE_READ_SCOPE],
    sources: {
      verify: (c: unknown) => (c === 'cred' ? { kind: 'user', id: 'user-plumbing' } : undefined), selectTenant: () => PW,
      grants: () => ['intake:run', 'processing:run', MOCK_NOTE_SCOPE, 'quality-control:run', MOCK_NOTE_READ_SCOPE, 'reporting:run'], newCorrelationId: () => `corr-unrec-${++n}`,
    },
  });
  const first: any = await pipeline.run('cred', pmsg);
  assert.equal(first.outcome, 'awaiting-approval');
  await answer(real, first.pending, 'approved', await approverCtx(PW, 'user-manager'));
  const second: any = await pipeline.run('cred', pmsg);
  assert.deepEqual([second.ok, second.outcome, second.verdict], [true, 'reported', 'escalate']);
  assert.deepEqual([second.report.counts.verified_simulated_pass, second.report.counts.escalate], [0, 1]);
  assert.equal(note.writes.length, 1);
  assert.ok(!JSON.stringify(second).includes('CANARY'));
});

// ---------------------------------------------------------------- the lease must outlast the work
t('setup: the store lease must be longer than three tool timeouts, and a store that does not state a usable lease is refused', () => {
  const tools = createToolRegistry({ 'mock-note': humanTool(createMockNoteTool()) });
  const make = (leaseSeconds: number, timeoutMs?: number) => createProcessingEntry({
    tools, plan: ['mock-note'], now: nowIso, ...(timeoutMs === undefined ? {} : { timeoutMs }), approval: { store: createInMemoryApprovalStore({ now: nowIso, leaseSeconds }) },
  });
  const bad = (e: Error) => e instanceof RangeError && /lease/.test(e.message) && !e.message.includes('CANARY');
  // default tool timeout 5 s: the lease must exceed 15 s
  assert.throws(() => make(1), bad);
  assert.throws(() => make(15), bad, 'equal to three timeouts is not enough');
  assert.doesNotThrow(() => make(16));
  assert.doesNotThrow(() => make(60));
  // other timeouts
  assert.throws(() => make(3, 1000), bad); assert.doesNotThrow(() => make(4, 1000));
  assert.throws(() => make(90, 30_000), bad); assert.doesNotThrow(() => make(91, 30_000));
  assert.throws(() => make(60, 20_000), bad); assert.doesNotThrow(() => make(60, 19_999));
  assert.doesNotThrow(() => make(1, 1), 'a one-second lease easily covers three 1 ms timeouts');
});

t('setup: a lease that is missing, not a whole number or not positive is refused, even if the store works otherwise', () => {
  const tools = createToolRegistry({ 'mock-note': humanTool(createMockNoteTool()) });
  const real = createInMemoryApprovalStore({ now: nowIso });
  const withLease = (leaseSeconds: unknown) => ({ ...wrap(real, {}), ...(leaseSeconds === undefined ? { leaseSeconds: undefined } : { leaseSeconds }) });
  for (const lease of [undefined, null, '60', NaN, Infinity, -60, 0, 60.5, {}, [60], true]) {
    assert.throws(() => createProcessingEntry({ tools, plan: ['mock-note'], now: nowIso, approval: { store: withLease(lease) as never } }), (e: Error) => e instanceof RangeError && !e.message.includes('CANARY'), String(lease));
  }
  const noLease: any = {}; for (const m of ['putProposal', 'claim', 'complete', 'findByStep']) noLease[m] = () => ({ ok: true });
  assert.throws(() => createProcessingEntry({ tools, plan: ['mock-note'], now: nowIso, approval: { store: noLease } }), RangeError, 'a store with no stated lease cannot be checked');
  // An assisted-only plan never claims, so the lease does not matter.
  const plain = createToolRegistry({ 'mock-note': createMockNoteTool() });
  assert.doesNotThrow(() => createProcessingEntry({ tools: plain, plan: ['mock-note'], now: nowIso, approval: { store: noLease } }));
});

t('setup: the SQLite store states its lease too, and the same rule applies to it', () => {
  const tools = createToolRegistry({ 'mock-note': humanTool(createMockNoteTool()) });
  const sqlite = createSqliteApprovalStore({ path: ':memory:', now: nowIso, leaseSeconds: 5 });
  openStores.push(sqlite);
  assert.equal(sqlite.leaseSeconds, 5);
  assert.doesNotThrow(() => createProcessingEntry({ tools, plan: ['mock-note'], now: nowIso, timeoutMs: 1666, approval: { store: sqlite } }));
  assert.throws(() => createProcessingEntry({ tools, plan: ['mock-note'], now: nowIso, timeoutMs: 1667, approval: { store: sqlite } }), (e: Error) => e instanceof RangeError && /lease/.test(e.message));
  assert.throws(() => createProcessingEntry({ tools, plan: ['mock-note'], now: nowIso, approval: { store: sqlite } }), RangeError, 'the default 5 s timeout needs more than 15 s');
});

// ---------------------------------------------------------------- assisted tools and plans
each('assisted tools behave as before, and mix with a human-approved step without being run twice', async (kind) => {
  const assisted = createMockNoteTool('tool:a:write');
  const note = createMockNoteTool();
  const defs: Record<string, ToolDefinition> = { a: assisted, 'mock-note': humanTool(note) };
  const g = rig(kind, defs, { plan: ['a', 'mock-note'] });
  const h = await handoffFor();
  const ctx = await procCtx(PW, [PROCESSING_RUN_SCOPE, MOCK_NOTE_SCOPE, 'tool:a:write']);
  const pend = pendingOf(await g.entry.run(ctx, h));
  assert.equal(assisted.calls(), 1, 'the assisted step ran before the pause');
  await answer(g.store, pend);
  const c = candOf(await g.entry.run(ctx, h));
  assert.deepEqual(c.steps.map((s: any) => s.status), ['ok', 'ok']);
  assert.deepEqual([assisted.calls(), note.calls()], [1, 1]);

  const first = rig(kind, { 'mock-note': humanTool(createMockNoteTool()), a: assisted }, { plan: ['mock-note', 'a'] });
  const h2 = await handoffFor(PW, { ...pmsg, event_id: 'evt-synthetic-order' });
  pendingOf(await first.entry.run(ctx, h2));
  assert.equal(assisted.calls(), 1, 'a human step first holds back everything after it');
});

t('setup: a human-approved tool needs a store, a store without human tools is fine, and bad store or lifetime settings fail', () => {
  const note = createMockNoteTool();
  const human = createToolRegistry({ 'mock-note': humanTool(note) });
  const plain = createToolRegistry({ 'mock-note': note });
  const store = createInMemoryApprovalStore({ now: nowIso });
  assert.throws(() => createProcessingEntry({ tools: human, plan: ['mock-note'], now: nowIso }), (e: Error) => e instanceof RangeError);
  assert.doesNotThrow(() => createProcessingEntry({ tools: plain, plan: ['mock-note'], now: nowIso, approval: { store } }));
  assert.doesNotThrow(() => createProcessingEntry({ tools: plain, plan: ['mock-note'], now: nowIso }));
  for (const bad of [null, {}, { store: null }, { store: {} }, { store: { putProposal() {}, claim() {}, complete() {} } }, { store, ttlSeconds: 0 }, { store, ttlSeconds: 86_401 }, { store, ttlSeconds: 1.5 }]) {
    assert.throws(() => createProcessingEntry({ tools: human, plan: ['mock-note'], now: nowIso, approval: bad as never }), (e: Error) => e instanceof RangeError && !e.message.includes('CANARY'));
  }
});

t('registry: human-approval fields are validated, defaults are safe, and a plain tool is exactly as before', () => {
  const run = () => ({ evidence_ref: 'e' });
  for (const [name, def] of [
    ['bad approval', { scope: 's:a', run, approval: 'robot' }], ['idempotent without approval', { scope: 's:a', run, idempotent: true }],
    ['arguments without approval', { scope: 's:a', run, approvalArguments: {} }], ['idempotent not boolean', { scope: 's:a', run, approval: 'human', idempotent: 'yes' }],
    ['function argument', { scope: 's:a', run, approval: 'human', approvalArguments: { f: () => 1 } }], ['too big', { scope: 's:a', run, approval: 'human', approvalArguments: { t: 'x'.repeat(1001) } }],
    ['too deep', { scope: 's:a', run, approval: 'human', approvalArguments: JSON.parse('{"a":{"b":{"c":{"d":{"e":{"f":1}}}}}}') }],
    ['getter', { scope: 's:a', run, approval: 'human', approvalArguments: Object.defineProperty({}, 'x', { enumerable: true, get: () => CANARY }) }],
  ] as [string, any][]) assert.throws(() => createToolRegistry({ t: def }), (e: Error) => e instanceof RangeError && !e.message.includes('CANARY'), name);
  const reg = createToolRegistry({ plain: { scope: 'tool:p:write', run }, h: { scope: 'tool:h:write', run, approval: 'human' }, hi: { scope: 'tool:i:write', run, approval: 'human', idempotent: true, approvalArguments: { mode: 'x' } } });
  assert.deepEqual(Object.keys(reg.get('plain') as object).sort(), ['name', 'run', 'scope'], 'a plain tool is unchanged');
  const h = reg.get('h') as any; const hi = reg.get('hi') as any;
  assert.deepEqual([h.approval, h.idempotent, h.approvalArguments], ['human', false, {}]);
  assert.deepEqual([hi.idempotent, hi.approvalArguments], [true, { mode: 'x' }]);
  assert.ok(Object.isFrozen(h) && Object.isFrozen(h.approvalArguments) && Object.isFrozen(reg.list()));
  assert.deepEqual(idempotentToolNames(reg), ['hi'], 'the one source for the store\'s idempotent tools');
});

// ---------------------------------------------------------------- tenants, scopes, shape
each('tenants are separate: the same step in two tenants has two requests, and an approver cannot cross over', async (kind) => {
  const note = createMockNoteTool();
  const g = rig(kind, { 'mock-note': humanTool(note) });
  const ph = await handoffFor(PW, pmsg); const dh = await handoffFor(DW, dmsg);
  const pctx = await procCtx(PW); const dctx = await procCtx(DW);
  const pp = pendingOf(await g.entry.run(pctx, ph)); const dp = pendingOf(await g.entry.run(dctx, dh));
  assert.notEqual(pp.proposal_id, dp.proposal_id);
  const cross: any = decideProposal(await approverCtx(DW), pp.proposal, { decision: 'approved', reason_code: 'within_policy' }, { now: nowIso });
  assert.equal(cross.error.code, 'TENANT_MISMATCH');
  await answer(g.store, pp);
  assert.equal(candOf(await g.entry.run(pctx, ph)).status, 'complete');
  assert.equal(pendingOf(await g.entry.run(dctx, dh)).kind, 'awaiting_approval', 'the other tenant is untouched');
  assert.equal(note.calls(), 1);
  assert.equal(note.writes[0].workspace_id, PW);
});

each('scopes and contexts: the tool scope is needed before anything is proposed, and only a Processing context may run', async (kind) => {
  const note = createMockNoteTool();
  const g = rig(kind, { 'mock-note': humanTool(note) });
  const h = await handoffFor();
  const noTool: any = await g.entry.run(await procCtx(PW, [PROCESSING_RUN_SCOPE]), h);
  assert.equal(noTool.error.code, 'PROCESSING_NOT_PERMITTED');
  assert.equal(await stateOf(g.store, PW, stepIdFor(PW, h.item_id, 0, 'mock-note')), 'STORE_NOT_FOUND', 'nothing was proposed');
  const approver = await approverCtx();
  for (const bad of [approver, { ...(await procCtx()) }, null, undefined]) assert.equal(((await g.entry.run(bad, h)) as any).error.code, 'CONTEXT_NOT_TRUSTED');
  assert.equal(((await g.entry.run(await qcCtx(), h)) as any).error.code, 'WRONG_RECIPIENT');
  assert.equal(note.calls(), 0);
});

each('the pending result is frozen, holds ids only, and is reported as an event; a failing sink changes nothing', async (kind) => {
  const events: ObsEvent[] = [];
  const g = rig(kind, { 'mock-note': humanTool(createMockNoteTool()) }, { sink: { write: (e) => { events.push(e); } } });
  const h = await handoffFor();
  const pend = pendingOf(await g.entry.run(await procCtx(PW, undefined, 'corr-pend'), h));
  assert.ok(Object.isFrozen(pend));
  assert.ok(!JSON.stringify({ ...pend, proposal: undefined }).match(/Emergency|Address|Burst|channel-happ|CANARY/));
  assert.deepEqual([events[0].event, events[0].correlation_id, events[0].item_id, events[0].agent], ['run.finished', 'corr-pend', h.item_id, 'processing']);
  const noisy = rig(kind, { 'mock-note': humanTool(createMockNoteTool()) }, { sink: { write: () => { throw new Error(CANARY); } } });
  assert.equal(pendingOf(await noisy.entry.run(await procCtx(), h)).kind, 'awaiting_approval');
});

// ---------------------------------------------------------------- restarts (SQLite)
t('sqlite: a pending request and an approval survive a restart; a restart never causes a second call', async () => {
  const note = createMockNoteTool();
  const defs = { 'mock-note': humanTool(note) };
  let g = rig('sqlite', defs);
  const h = await handoffFor(); const ctx = await procCtx();
  const pend = pendingOf(await g.entry.run(ctx, h));
  g = g.reopen();
  const after1 = pendingOf(await g.entry.run(ctx, h));
  assert.equal(after1.proposal_id, pend.proposal_id, 'the same request after a restart');
  assert.equal(after1.proposal, undefined, 'but the sealed object is gone: handing it to an approver needs the seal-recovery gate');
  await answer(g.store, pend);                       // decided with the object from the first process
  g = g.reopen();
  assert.equal(candOf(await g.entry.run(ctx, h)).status, 'complete');
  assert.equal(note.calls(), 1);
  g = g.reopen();
  assert.equal(candOf(await g.entry.run(ctx, h)).status, 'complete');
  assert.equal(note.calls(), 1, 'a replay after another restart still makes no call');
});

t('sqlite: a crash after the claim but before the tool answered is in-doubt after the restart, and is not called blindly', async () => {
  for (const idempotent of [false, true]) {
    const tool = createDelayedNoteTool();
    const defs = { 'mock-note': humanTool(tool, { idempotent }) };
    let g = rig('sqlite', defs, { timeoutMs: 30 });
    const h = await handoffFor(PW, { ...pmsg, event_id: `evt-synthetic-crash-${idempotent}` }); const ctx = await procCtx();
    const pend = pendingOf(await g.entry.run(ctx, h));
    await answer(g.store, pend);
    const first = candOf(await g.entry.run(ctx, h));          // the call timed out and the process "crashes"
    assert.equal(first.status, 'uncertain');
    g = g.reopen();
    at(plus(120));
    const next = candOf(await g.entry.run(ctx, h));
    assert.equal(next.status, 'uncertain');
    assert.equal(tool.calls(), idempotent ? 2 : 1, idempotent ? 'an idempotent tool is retried once with the same step id' : 'a non-idempotent tool is never called again');
    at(T0);
  }
});

// ---------------------------------------------------------------- the whole pipeline
t('pipeline: a human-approved run pauses before Quality Control, and the resumed run reaches a verified pass; a replay writes nothing', async () => {
  const note = createMockNoteTool();
  const store = createInMemoryApprovalStore({ now: nowIso });
  const tools = createToolRegistry({ 'mock-note': humanTool(note) });
  const processing = createProcessingEntry({ tools, plan: ['mock-note'], now: nowIso, approval: { store } });
  const qc = createQcEntry({ plan: ['mock-note'], readers: { 'mock-note': note.reader }, now: nowIso, approvals: { store: store, tools: humanApprovalExpectations(tools) } });
  const reporting = createReportingEntry({ now: nowIso });
  let n = 0;
  const pipeline = createPipeline({
    intake, processing, qc, reporting, processingToolScopes: [MOCK_NOTE_SCOPE], qcReaderScopes: [MOCK_NOTE_READ_SCOPE],
    sources: {
      verify: (c: unknown) => (c === 'cred' ? { kind: 'user', id: 'user-plumbing' } : undefined), selectTenant: () => PW,
      grants: () => ['intake:run', 'processing:run', MOCK_NOTE_SCOPE, 'quality-control:run', MOCK_NOTE_READ_SCOPE, 'reporting:run'], newCorrelationId: () => `corr-happ-${++n}`,
    },
  });
  const first: any = await pipeline.run('cred', pmsg);
  assert.deepEqual([first.ok, first.outcome], [true, 'awaiting-approval']);
  assert.equal(first.stages.map((s: any) => `${s.stage}:${s.status}`).join(' '), 'auth:passed intake:passed processing:awaiting-approval qc:not-run reporting:not-run');
  assert.equal(note.calls(), 0);
  assert.equal(first.pending.kind, 'awaiting_approval');
  await answer(store, first.pending, 'approved', await approverCtx(PW, 'user-manager'));
  const second: any = await pipeline.run('cred', pmsg);
  assert.deepEqual([second.ok, second.outcome, second.verdict, second.counted], [true, 'reported', 'pass', 'accepted']);
  assert.equal(second.report.counts.verified_simulated_pass, 1);
  assert.equal(note.calls(), 1);
  const third: any = await pipeline.run('cred', pmsg);
  assert.deepEqual([third.outcome, third.verdict, third.counted], ['reported', 'pass', 'repeat']);
  assert.equal(note.calls(), 1, 'a replay of the same request made no second write');
  assert.equal(note.writes.length, 1);
});

// ---------------------------------------------------------------- inventory
t('inventory: only Processing uses the store to propose, claim and complete; the store is a type import; no tool gets it', () => {
  const dirSrc = new URL('../src/', import.meta.url);
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const files = readdirSync(dirSrc).filter((f) => f.endsWith('.ts'));
  const text = (f: string) => strip(readFileSync(new URL(f, dirSrc), 'utf8'));
  const callers = (re: RegExp) => files.filter((f) => !['approval-store.ts', 'approval-store-sqlite.ts'].includes(f) && re.test(text(f)));
  assert.deepEqual(callers(/\.(?:claim|putProposal)\(/), ['processing-entry.ts'], 'claim and propose');
  assert.deepEqual(callers(/\.findByStep\(/), ['processing-entry.ts', 'qc-entry.ts'], 'look up: Processing to act, QC to read');
  assert.deepEqual(callers(/(?:approvals|store|st)\.complete\(/), ['processing-entry.ts']);
  assert.deepEqual(callers(/\.recordDecision\(/), [], 'no agent records a decision');
  assert.deepEqual(callers(/\b(?:approvals|store|st)\.resolve\(/), [], 'nothing resolves an in-doubt claim yet (Quality Control, a later gate)');
  const code = text('processing-entry.ts');
  assert.ok(/import type \{ ApprovalStore \}/.test(code));
  assert.ok(!/node:sqlite|approver-context|mintExecutionContext|mintApproverContext|createInMemoryApprovalStore|createSqliteApprovalStore|handoff-seal.*sealApproval/.test(code));
  assert.ok(/startCall\(tool, Object\.freeze\(\{ step_id: stepId, item_id: itemId, workspace_id: tenant \}\)/.test(code), 'the tool is handed exactly the three ids');
  assert.ok(!/startCall\([^)]*claimId/.test(code), 'the fence token is not passed to the tool');
});
