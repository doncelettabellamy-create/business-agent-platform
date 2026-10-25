// Shared by the approval-store test files: mock contexts, a mock clock and the conformance suite.
// Conformance tests for the approval-state store. The suite is written against the ApprovalStore interface only, so a durable
// store must pass the same tests; today it runs against the in-memory reference. Mock contexts and a mock clock only. No agent,
// tool or pipeline is connected. No network, no key, synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mintExecutionContext } from '../../src/execution-context.ts';
import type { AgentName, ExecutionContext } from '../../src/execution-context.ts';
import { mintApproverContext } from '../../src/approver-context.ts';
import type { ApproverContext } from '../../src/approver-context.ts';
import { approvalScopeFor, decideProposal, proposeAction } from '../../src/approval.ts';
import { verifyEventLog } from '../../src/approval-store.ts';
import type { ApprovalStore, StoreConfig } from '../../src/approval-store.ts';
import { classify } from '../../src/observability.ts';

export const CANARY = 'CANARY-STORE-2208';
export const PW = 'ws-synthetic-plumbing';
export const DW = 'ws-synthetic-dental';
export const T0 = '2026-10-25T20:00:00Z';
let clock = T0;
export const nowIso = (): string => clock;
export const at = (s: string) => { clock = s; };
export const plus = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

export async function agent(tenant: string, name: AgentName, scopes: string[], id = 'user-requester', corr = 'corr-req'): Promise<ExecutionContext> {
  const r = await mintExecutionContext({ credential: 'c', agent: name }, { verify: () => ({ kind: 'user', id }), selectTenant: () => tenant, grants: () => scopes, newCorrelationId: () => corr });
  assert.equal(r.ok, true);
  return (r as { context: ExecutionContext }).context;
}
export const processing = (tenant = PW, o: { scopes?: string[]; corr?: string } = {}) => agent(tenant, 'processing', o.scopes ?? ['processing:run'], 'user-requester', o.corr ?? 'corr-req');
export const qcCtx = (tenant = PW, scopes = ['quality-control:run']) => agent(tenant, 'quality-control', scopes, 'user-qc', 'corr-qc');
export async function human(tenant = PW, o: { id?: string; corr?: string; scopes?: string[]; session?: string } = {}): Promise<ApproverContext> {
  const r = await mintApproverContext({ credential: 'c', workspace_id: tenant }, {
    verify: () => ({ kind: 'user', id: o.id ?? 'user-boss', assurance: 'multi-factor', authenticated_at: T0, session_expires_at: o.session ?? '2026-10-25T23:00:00Z' }),
    membership: () => true, grants: () => o.scopes ?? [approvalScopeFor('mock-note')], newCorrelationId: () => o.corr ?? 'corr-boss', now: () => clock,
  });
  assert.equal(r.ok, true);
  return (r as { context: ApproverContext }).context;
}
export const ACTION = (step = 'st-0123456789ab', item = 'wi-0123456789ab') => ({ item_id: item, step_id: step, tool: 'mock-note', arguments: { note: `text ${CANARY}`, n: 1 } });
export async function propose(tenant = PW, action = ACTION()): Promise<any> {
  const r = proposeAction(await processing(tenant), action, { now: () => clock });
  assert.equal(r.ok, true);
  return (r as any).proposal;
}
export async function decide(proposal: any, decision: 'approved' | 'declined' = 'approved', who?: ApproverContext): Promise<any> {
  const r = decideProposal(who ?? await human(proposal.workspace_id), proposal, { decision, reason_code: 'within_policy' }, { now: () => clock });
  assert.equal(r.ok, true, JSON.stringify((r as any).error));
  return (r as any).decision;
}
export function code(r: any, expected: string) {
  assert.equal(r.ok, false, `expected refusal ${expected}`);
  assert.equal(r.error.code, expected);
  assert.ok(r.error.message.length > 0 && !r.error.message.includes('CANARY') && !r.error.message.includes(PW) && !r.error.message.includes(DW) && !r.error.message.includes('user-'), 'fixed text, no values');
}
export function ok(r: any) { assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r.error)}`); return r; }

export function conformance(name: string, make: (config: StoreConfig) => ApprovalStore) {
  const store = (over: Partial<StoreConfig> = {}) => { at(T0); return make({ now: () => clock, newClaimId: counter(), ...over }); };
  function counter() { let n = 0; return () => `claim-${String(++n).padStart(4, '0')}`; }
  /** A store with one approved proposal ready to claim. */
  async function approved(s: ApprovalStore, tenant = PW, action = ACTION()) {
    const p = await propose(tenant, action);
    ok(await s.putProposal(await processing(tenant), p));
    ok(await s.recordDecision(await human(tenant), await decide(p)));
    return p;
  }
  const claimOf = async (s: ApprovalStore, p: any, tenant = PW, action = ACTION()) => (await s.claim(await processing(tenant), p.proposal_id, action)) as any;

  // ------------------------------------------------------------ lifecycle
  test(`${name}: proposal, decision, claim and completion move through the states, with a verifiable log`, async () => {
    const s = store();
    const p = await propose();
    const put = ok(await s.putProposal(await processing(), p));
    assert.deepEqual([put.created, put.snapshot.state, put.snapshot.attempts], [true, 'requested', 0]);
    at(plus(60));
    const dec = ok(await s.recordDecision(await human(), await decide(p)));
    assert.deepEqual([dec.snapshot.state, dec.snapshot.decision.decision, dec.snapshot.decision.approver_id, dec.snapshot.decision.assurance], ['approved', 'approved', 'user-boss', 'multi-factor']);
    at(plus(120));
    const claim = ok(await s.claim(await processing(), p.proposal_id, ACTION()));
    assert.deepEqual([claim.grant.attempt, claim.grant.proposal_id, claim.grant.step_id, claim.grant.lease_until], [1, p.proposal_id, 'st-0123456789ab', plus(180)]);
    assert.equal(ok(await s.get(await processing(), p.proposal_id)).snapshot.state, 'claimed');
    at(plus(150));
    const done = ok(await s.complete(await processing(), p.proposal_id, claim.grant.claim_id, { status: 'succeeded', evidence_ref: 'mock-note:st-0123456789ab' }));
    assert.deepEqual([done.snapshot.state, done.snapshot.outcome], ['succeeded', { status: 'succeeded', evidence_ref: 'mock-note:st-0123456789ab' }]);
    const log = ok(await s.events(await qcCtx(), p.proposal_id)).events;
    assert.deepEqual(log.map((e: any) => e.type), ['requested', 'approved', 'claimed', 'succeeded']);
    assert.equal(verifyEventLog(log), true);
    assert.ok(Object.isFrozen(done.snapshot) && Object.isFrozen(log[0]));
  });

  test(`${name}: recording the same proposal again is a no-op that returns the existing state`, async () => {
    const s = store();
    const p = await propose();
    ok(await s.putProposal(await processing(), p));
    const again = ok(await s.putProposal(await processing(), p));
    assert.equal(again.created, false);
    assert.equal(again.snapshot.version, 1, 'no second event');
  });

  // ------------------------------------------------------------ decisions
  test(`${name}: the first decision wins; the same decision is a no-op; a different one is refused`, async () => {
    const s = store();
    const p = await propose();
    ok(await s.putProposal(await processing(), p));
    const approve = await decide(p, 'approved');
    const decline = await decide(p, 'declined', await human(PW, { id: 'user-boss-2', corr: 'corr-boss-2' }));
    ok(await s.recordDecision(await human(), approve));
    const same = ok(await s.recordDecision(await human(), approve));
    assert.equal(same.snapshot.version, 2);
    code(await s.recordDecision(await human(PW, { id: 'user-boss-2', corr: 'corr-boss-2' }), decline), 'DECISION_CONFLICT');
    assert.equal(ok(await s.get(await processing(), p.proposal_id)).snapshot.state, 'approved');
  });

  test(`${name}: an approve and a decline racing at once leave exactly one decision`, async () => {
    const s = store();
    const p = await propose();
    ok(await s.putProposal(await processing(), p));
    const a = await human(PW, { id: 'user-a', corr: 'corr-a' }); const b = await human(PW, { id: 'user-b', corr: 'corr-b' });
    const [da, db] = [await decide(p, 'approved', a), await decide(p, 'declined', b)];
    const results = await Promise.all([s.recordDecision(a, da), s.recordDecision(b, db)]);
    assert.deepEqual(results.map((r: any) => r.ok).sort(), [false, true]);
    const final = ok(await s.get(await processing(), p.proposal_id)).snapshot;
    assert.equal(final.decision.decision, results[0].ok ? 'approved' : 'declined');
  });

  test(`${name}: decisions from the wrong place are refused: unsealed, expired, unknown, another identity, an agent, another tenant`, async () => {
    const s = store();
    const p = await propose();
    ok(await s.putProposal(await processing(), p));
    const good = await decide(p);
    const boss = await human();
    code(await s.recordDecision(boss, structuredClone(good)), 'APPROVAL_NOT_TRUSTED');
    code(await s.recordDecision(boss, { ...good }), 'APPROVAL_NOT_TRUSTED');
    code(await s.recordDecision(await human(PW, { id: 'user-other', corr: 'corr-other' }), good), 'STORE_NOT_PERMITTED');
    code(await s.recordDecision(await human(PW, { scopes: [] }), good), 'STORE_NOT_PERMITTED');
    code(await s.recordDecision(await processing(), good), 'STORE_NOT_PERMITTED');
    code(await s.recordDecision({ ...boss }, good), 'CONTEXT_NOT_TRUSTED');
    code(await s.recordDecision(await human(DW), good), 'TENANT_MISMATCH');
    const stranger = await propose(PW, ACTION('st-aaaaaaaaaaaa'));
    code(await s.recordDecision(boss, await decide(stranger)), 'STORE_NOT_FOUND');
    at(plus(30 * 60));
    const late = await human(PW, { session: '2026-10-25T23:00:00Z' });
    at(plus(3600));
    code(await s.recordDecision(late, good), 'PROPOSAL_EXPIRED');
    assert.equal(ok(await s.get(await processing(), p.proposal_id)).snapshot.state, 'expired');
  });

  test(`${name}: an approver session that has ended cannot record a decision`, async () => {
    const s = store();
    const p = await propose();
    ok(await s.putProposal(await processing(), p));
    const ctx = await human(PW, { session: plus(120) });
    const d = await decide(p, 'approved', ctx);
    at(plus(120));
    code(await s.recordDecision(ctx, d), 'APPROVER_SESSION_EXPIRED');
  });

  // ------------------------------------------------------------ claims, races, replay
  test(`${name}: ten claims at once produce exactly one winner`, async () => {
    const s = store();
    const p = await approved(s);
    const ctx = await processing();
    const results = await Promise.all(Array.from({ length: 10 }, () => s.claim(ctx, p.proposal_id, ACTION()))) as any[];
    assert.equal(results.filter((r) => r.ok).length, 1);
    for (const r of results.filter((x) => !x.ok)) code(r, 'CLAIM_CONFLICT');
    assert.equal(ok(await s.get(ctx, p.proposal_id)).snapshot.attempts, 1);
  });

  test(`${name}: an approval cannot be replayed after it was used, whatever happened to the execution`, async () => {
    const s = store();
    const p = await approved(s);
    const c = ok(await claimOf(s, p));
    ok(await s.complete(await processing(), p.proposal_id, c.grant.claim_id, { status: 'succeeded', evidence_ref: 'mock-note:st-0123456789ab' }));
    code(await claimOf(s, p), 'EFFECT_ALREADY_DONE');
    // a failed execution also uses up its approval
    const s2 = store();
    const q = await approved(s2);
    const c2 = ok(await claimOf(s2, q));
    ok(await s2.complete(await processing(), q.proposal_id, c2.grant.claim_id, { status: 'failed' }));
    code(await claimOf(s2, q), 'NOT_APPROVED');
  });

  test(`${name}: only an approved, unexpired approval can be claimed`, async () => {
    const s = store();
    const open = await propose(PW, ACTION('st-111111111111'));
    ok(await s.putProposal(await processing(), open));
    code(await claimOf(s, open, PW, ACTION('st-111111111111')), 'NOT_APPROVED');
    const declined = await propose(PW, ACTION('st-222222222222'));
    ok(await s.putProposal(await processing(), declined));
    ok(await s.recordDecision(await human(), await decide(declined, 'declined')));
    code(await claimOf(s, declined, PW, ACTION('st-222222222222')), 'NOT_APPROVED');
    const stale = await approved(s, PW, ACTION('st-333333333333'));
    at(plus(3600));
    code(await claimOf(s, stale, PW, ACTION('st-333333333333')), 'PROPOSAL_EXPIRED');
    code(await s.claim(await processing(), 'ap-ffffffffffff', ACTION()), 'STORE_NOT_FOUND');
    for (const bad of [undefined, null, 5, 'x', {}, [], 'ap-1']) code(await s.claim(await processing(), bad, ACTION()), 'STORE_NOT_FOUND');
  });

  test(`${name}: the action presented at claim time must be the approved one, and a refusal consumes nothing`, async () => {
    const s = store();
    const p = await approved(s);
    const base = ACTION();
    const variants: any[] = [
      { ...base, arguments: { ...base.arguments, n: 2 } }, { ...base, arguments: {} }, { ...base, item_id: 'wi-ffffffffffff' }, { ...base, step_id: 'st-ffffffffffff' },
      { ...base, tool: 'mock-other' }, { ...base, workspace_id: DW }, null, 'run', {},
    ];
    for (const v of variants) code(await s.claim(await processing(), p.proposal_id, v), 'ACTION_MISMATCH');
    const snap = ok(await s.get(await processing(), p.proposal_id)).snapshot;
    assert.deepEqual([snap.state, snap.attempts], ['approved', 0]);
    ok(await s.claim(await processing(), p.proposal_id, base));
  });

  test(`${name}: claims need a trusted Processing context with processing:run`, async () => {
    const s = store();
    const p = await approved(s);
    const good = await processing();
    for (const bad of [{ ...good }, null, undefined, 'ctx', await human()]) code(await s.claim(bad, p.proposal_id, ACTION()), 'CONTEXT_NOT_TRUSTED');
    for (const bad of [await processing(PW, { scopes: [] }), await qcCtx(), await agent(PW, 'reporting', ['reporting:run'])]) code(await s.claim(bad, p.proposal_id, ACTION()), 'STORE_NOT_PERMITTED');
    assert.equal(ok(await s.get(good, p.proposal_id)).snapshot.attempts, 0);
  });

  // ------------------------------------------------------------ stale claims and uncertain execution
  test(`${name}: a lapsed claim becomes in-doubt, and a non-idempotent tool is never retried freely`, async () => {
    const s = store();
    const p = await approved(s);
    const c = ok(await claimOf(s, p));
    at(plus(59)); assert.equal(ok(await s.get(await processing(), p.proposal_id)).snapshot.state, 'claimed');
    at(c.grant.lease_until);
    const d = ok(await s.get(await processing(), p.proposal_id)).snapshot;
    assert.deepEqual([d.state, d.claim.attempt], ['in_doubt', 1], 'the lease end is exclusive');
    code(await claimOf(s, p), 'IN_DOUBT');
    assert.equal(classify('IN_DOUBT'), 'dependency_failure');
    const log = ok(await s.events(await processing(), p.proposal_id)).events;
    assert.deepEqual(log.map((e: any) => e.type), ['requested', 'approved', 'claimed', 'lease_lapsed']);
  });

  test(`${name}: an idempotent tool may be retried after a lapse, with a new fence token, and the old one is stale`, async () => {
    const s = store({ idempotentTools: ['mock-note'] });
    const p = await approved(s);
    const first = ok(await claimOf(s, p));
    at(plus(3 * 60));
    const second = ok(await claimOf(s, p));
    assert.deepEqual([second.grant.attempt, second.grant.claim_id === first.grant.claim_id], [2, false]);
    code(await s.complete(await processing(), p.proposal_id, first.grant.claim_id, { status: 'succeeded', evidence_ref: 'mock-note:x' }), 'STALE_CLAIM');
    code(await s.complete(await processing(), p.proposal_id, 'claim-unknown', { status: 'failed' }), 'STALE_CLAIM');
    ok(await s.complete(await processing(), p.proposal_id, second.grant.claim_id, { status: 'succeeded', evidence_ref: 'mock-note:st-0123456789ab' }));
    code(await s.complete(await processing(), p.proposal_id, second.grant.claim_id, { status: 'succeeded', evidence_ref: 'mock-note:st-0123456789ab' }), 'STALE_CLAIM');
  });

  test(`${name}: retries stop at the attempt limit and at the end of the approval window`, async () => {
    const s = store({ idempotentTools: ['mock-note'], maxAttempts: 2 });
    const p = await approved(s);
    ok(await claimOf(s, p)); at(plus(3 * 60));
    ok(await claimOf(s, p)); at(plus(6 * 60));
    code(await claimOf(s, p), 'RETRY_LIMIT');
    const s2 = store({ idempotentTools: ['mock-note'] });
    const q = await approved(s2);
    ok(await claimOf(s2, q)); at(plus(3600));
    code(await claimOf(s2, q), 'PROPOSAL_EXPIRED');
    assert.equal(ok(await s2.get(await processing(), q.proposal_id)).snapshot.state, 'in_doubt', 'an expired window does not erase an uncertain execution');
  });

  test(`${name}: a late completion by the latest claim holder is accepted; the work really finished`, async () => {
    const s = store();
    const p = await approved(s);
    const c = ok(await claimOf(s, p));
    at(plus(10 * 60));
    assert.equal(ok(await s.get(await processing(), p.proposal_id)).snapshot.state, 'in_doubt');
    const done = ok(await s.complete(await processing(), p.proposal_id, c.grant.claim_id, { status: 'succeeded', evidence_ref: 'mock-note:st-0123456789ab' }));
    assert.equal(done.snapshot.state, 'succeeded');
  });

  test(`${name}: uncertain execution is settled by Quality Control after a read-back, and only by Quality Control`, async () => {
    const s = store();
    const p = await approved(s);
    ok(await claimOf(s, p));
    code(await s.resolve(await qcCtx(), p.proposal_id, { status: 'succeeded', evidence_ref: 'mock-note:x' }), 'NOT_APPROVED');
    at(plus(3 * 60));
    code(await s.resolve(await processing(), p.proposal_id, { status: 'succeeded', evidence_ref: 'mock-note:x' }), 'STORE_NOT_PERMITTED');
    code(await s.resolve(await qcCtx(PW, []), p.proposal_id, { status: 'succeeded', evidence_ref: 'mock-note:x' }), 'STORE_NOT_PERMITTED');
    for (const bad of [{ status: 'succeeded' }, { status: 'failed', evidence_ref: 'x' }, { status: 'maybe' }, null, 'ok', { status: 'succeeded', evidence_ref: 'has space' }, { status: 'succeeded', evidence_ref: 'x', extra: 1 }]) {
      code(await s.resolve(await qcCtx(), p.proposal_id, bad), 'STORE_INVALID');
    }
    const r = ok(await s.resolve(await qcCtx(), p.proposal_id, { status: 'succeeded', evidence_ref: 'mock-note:st-0123456789ab' }));
    assert.equal(r.snapshot.state, 'succeeded');
    const log = ok(await s.events(await qcCtx(), p.proposal_id)).events;
    assert.equal(log[log.length - 1].data.via, 'resolve');
    code(await s.resolve(await qcCtx(), p.proposal_id, { status: 'failed' }), 'NOT_APPROVED');
  });

  // ------------------------------------------------------------ one effect per step, expiry
  test(`${name}: at most one live request per step, and one succeeded effect per step whatever is proposed later`, async () => {
    const s = store();
    const first = await approved(s);
    at(plus(1));
    const second = await propose();
    assert.notEqual(second.proposal_id, first.proposal_id, 'a later request is a new request');
    code(await s.putProposal(await processing(), second), 'ACTIVE_PROPOSAL_EXISTS');
    const c = ok(await claimOf(s, first));
    ok(await s.complete(await processing(), first.proposal_id, c.grant.claim_id, { status: 'succeeded', evidence_ref: 'mock-note:st-0123456789ab' }));
    code(await s.putProposal(await processing(), second), 'EFFECT_ALREADY_DONE');
    ok(await s.putProposal(await processing(), await propose(PW, ACTION('st-999999999999'))));
  });

  test(`${name}: a declined, expired or failed request frees the step for a new request`, async () => {
    const s = store();
    const d = await propose();
    ok(await s.putProposal(await processing(), d));
    ok(await s.recordDecision(await human(), await decide(d, 'declined')));
    at(plus(1)); ok(await s.putProposal(await processing(), await propose()));
    at(plus(3600 + 5));
    const next = await propose();
    ok(await s.putProposal(await processing(), next));
    assert.equal(ok(await s.get(await processing(), d.proposal_id)).snapshot.state, 'declined');
    ok(await s.recordDecision(await human(PW, { session: plus(10_000) }), await decide(next)));
    const c = ok(await s.claim(await processing(), next.proposal_id, ACTION()));
    ok(await s.complete(await processing(), next.proposal_id, c.grant.claim_id, { status: 'failed' }));
    at(plus(3600 + 10)); ok(await s.putProposal(await processing(), await propose()));
  });

  test(`${name}: expiry is decided by the store's clock; an unexpired approval in flight survives the window`, async () => {
    const s = store({ leaseSeconds: 3600 });
    const p = await approved(s);
    const c = ok(await claimOf(s, p));
    at(plus(3600 + 30));
    const mid = ok(await s.get(await processing(), p.proposal_id)).snapshot;
    assert.ok(['claimed', 'in_doubt'].includes(mid.state));
    const done = ok(await s.complete(await processing(), p.proposal_id, c.grant.claim_id, { status: 'succeeded', evidence_ref: 'mock-note:st-0123456789ab' }));
    assert.equal(done.snapshot.state, 'succeeded');
  });

  test(`${name}: an unusable store clock fails closed and changes nothing`, async () => {
    let bad = false;
    at(T0);
    const s = make({ now: () => (bad ? 'later' : clock) });
    const p = await propose();
    ok(await s.putProposal(await processing(), p));
    bad = true;
    code(await s.recordDecision(await human(), await decide(p)), 'STORE_ERROR');
    code(await s.get(await processing(), p.proposal_id), 'STORE_ERROR');
    code(await s.claim(await processing(), p.proposal_id, ACTION()), 'STORE_ERROR');
    bad = false;
    assert.equal(ok(await s.get(await processing(), p.proposal_id)).snapshot.state, 'requested');
    const throwing = make({ now: () => { throw new Error(CANARY); } });
    code(await throwing.putProposal(await processing(), p), 'STORE_ERROR');
  });

  // ------------------------------------------------------------ tenant isolation
  test(`${name}: another tenant's approval looks exactly like one that does not exist`, async () => {
    const s = store();
    const p = await approved(s, PW);
    const other = await processing(DW); const otherQc = await qcCtx(DW);
    const missing = 'ap-ffffffffffff';
    const forOther = [
      await s.get(other, p.proposal_id), await s.events(other, p.proposal_id), await s.claim(other, p.proposal_id, ACTION()),
      await s.complete(other, p.proposal_id, 'claim-0001', { status: 'failed' }), await s.resolve(otherQc, p.proposal_id, { status: 'failed' }),
    ] as any[];
    const forMissing = [
      await s.get(other, missing), await s.events(other, missing), await s.claim(other, missing, ACTION()),
      await s.complete(other, missing, 'claim-0001', { status: 'failed' }), await s.resolve(otherQc, missing, { status: 'failed' }),
    ] as any[];
    assert.deepEqual(forOther, forMissing);
    for (const r of forOther) code(r, 'STORE_NOT_FOUND');
    assert.equal(ok(await s.get(await processing(PW), p.proposal_id)).snapshot.state, 'approved');
  });

  test(`${name}: the same step in two tenants has separate requests, ledgers and claims`, async () => {
    const s = store();
    const a = await approved(s, PW); const b = await approved(s, DW);
    assert.notEqual(a.action_digest, b.action_digest);
    const ca = ok(await claimOf(s, a, PW)); ok(await claimOf(s, b, DW));
    ok(await s.complete(await processing(PW), a.proposal_id, ca.grant.claim_id, { status: 'succeeded', evidence_ref: 'mock-note:st-0123456789ab' }));
    assert.equal(ok(await s.get(await processing(DW), b.proposal_id)).snapshot.state, 'claimed', "one tenant's success does not touch the other");
    code(await s.complete(await processing(DW), b.proposal_id, ca.grant.claim_id, { status: 'succeeded', evidence_ref: 'x' }), 'STALE_CLAIM');
    code(await s.putProposal(await processing(PW), await propose(DW)), 'TENANT_MISMATCH');
  });

  // ------------------------------------------------------------ reads, log, privacy, robustness
  test(`${name}: snapshots and logs hold ids and fixed words only, and are copies`, async () => {
    const s = store();
    const p = await approved(s);
    const c = ok(await claimOf(s, p));
    ok(await s.complete(await processing(), p.proposal_id, c.grant.claim_id, { status: 'succeeded', evidence_ref: 'mock-note:st-0123456789ab' }));
    const snap = ok(await s.get(await processing(), p.proposal_id)).snapshot;
    const events = ok(await s.events(await processing(), p.proposal_id)).events;
    const text = JSON.stringify([snap, events]);
    assert.ok(!text.includes('CANARY') && !text.includes('"note"') && !text.includes('arguments'), 'no argument text');
    assert.throws(() => { (snap as any).state = 'approved'; }, TypeError);
    const mutable = JSON.parse(JSON.stringify(events));
    mutable[0].data.x = 1;
    assert.equal(verifyEventLog(ok(await s.events(await processing(), p.proposal_id)).events), true, 'changing a copy changes nothing');
  });

  test(`${name}: reads need a trusted context and never reveal whether a missing approval is missing or foreign`, async () => {
    const s = store();
    const p = await approved(s);
    for (const bad of [null, undefined, 'ctx', { workspace_id: PW }, { ...(await processing()) }]) {
      code(await s.get(bad, p.proposal_id), 'CONTEXT_NOT_TRUSTED');
      code(await s.events(bad, p.proposal_id), 'CONTEXT_NOT_TRUSTED');
    }
  });

  test(`${name}: the event log detects tampering`, async () => {
    const s = store();
    const p = await approved(s);
    ok(await claimOf(s, p));
    const log = JSON.parse(JSON.stringify(ok(await s.events(await processing(), p.proposal_id)).events));
    assert.equal(verifyEventLog(log), true);
    const edit = (f: (l: any[]) => void) => { const c = JSON.parse(JSON.stringify(log)); f(c); return verifyEventLog(c); };
    assert.equal(edit((l) => { l[1].type = 'declined'; }), false, 'edited type');
    assert.equal(edit((l) => { l[2].data.attempt = 9; }), false, 'edited data');
    assert.equal(edit((l) => { l[0].at = '2000-01-01T00:00:00Z'; }), false, 'edited time');
    assert.equal(edit((l) => { l.splice(1, 1); }), false, 'removed event');
    assert.equal(edit((l) => { l.reverse(); }), false, 'reordered');
    assert.equal(edit((l) => { l[3] = { ...l[2], seq: 4 }; }), false, 'duplicated event');
    assert.equal(edit((l) => { l[2].digest = '0'.repeat(64); }), false, 'edited digest');
    assert.equal(edit((l) => { l.pop(); }), true, 'a prefix is itself a valid log');
    for (const odd of [null, undefined, 'x', {}, [null], [{}], 5]) assert.equal(verifyEventLog(odd), false);
  });

  test(`${name}: garbage input never throws and changes nothing`, async () => {
    const s = store();
    const p = await approved(s);
    const garbage: unknown[] = [undefined, null, 5, 'x', [], {}, new Proxy({}, { get() { throw new Error(CANARY); }, ownKeys() { throw new Error(CANARY); } })];
    for (const g of garbage) {
      await assert.doesNotReject(s.putProposal(g, g));
      await assert.doesNotReject(s.recordDecision(g, g));
      await assert.doesNotReject(s.claim(g, g, g));
      await assert.doesNotReject(s.complete(g, g, g, g));
      await assert.doesNotReject(s.resolve(g, g, g));
      await assert.doesNotReject(s.get(g, g));
      await assert.doesNotReject(s.findByStep(g, g));
      await assert.doesNotReject(s.events(g, g));
    }
    const ctx = await processing();
    for (const g of garbage) {
      await assert.doesNotReject(s.putProposal(ctx, g));
      await assert.doesNotReject(s.complete(ctx, p.proposal_id, g, g));
      await assert.doesNotReject(s.claim(ctx, p.proposal_id, g));
    }
    assert.equal(ok(await s.get(ctx, p.proposal_id)).snapshot.state, 'approved');
  });

  test(`${name}: the store states its lease, so a caller can check that a tool call and its record fit inside it`, async () => {
    assert.equal(store().leaseSeconds, 60);
    assert.equal(store({ leaseSeconds: 7 }).leaseSeconds, 7);
    assert.equal(Number.isInteger(store().leaseSeconds), true);
  });

  // ------------------------------------------------------------ findByStep
  const STEP = 'st-0123456789ab';
  const find = async (s: ApprovalStore, tenant = PW, step: unknown = STEP): Promise<any> => s.findByStep(await processing(tenant), step);

  test(`${name}: findByStep returns the live request through every open state, and then the finished one`, async () => {
    const s = store();
    const p = await propose();
    ok(await s.putProposal(await processing(), p));
    const seen = async () => ok(await find(s)).snapshot;
    let f = await seen();
    assert.deepEqual([f.proposal_id, f.state, f.step_id, f.item_id, f.tool], [p.proposal_id, 'requested', STEP, 'wi-0123456789ab', 'mock-note']);
    ok(await s.recordDecision(await human(), await decide(p)));
    assert.equal((await seen()).state, 'approved');
    ok(await claimOf(s, p));
    f = await seen();
    assert.deepEqual([f.state, f.claim.attempt, f.attempts], ['claimed', 1, 1]);
    at(plus(120));
    assert.equal((await seen()).state, 'in_doubt');
    ok(await s.resolve(await qcCtx(), p.proposal_id, { status: 'succeeded', evidence_ref: 'mock-note:st-0123456789ab' }));
    f = await seen();
    assert.deepEqual([f.state, f.outcome.status], ['succeeded', 'succeeded']);
    assert.deepEqual(f, ok(await s.get(await processing(), p.proposal_id)).snapshot, 'the same view as get() for that request');
    assert.ok(Object.isFrozen(f));
  });

  test(`${name}: findByStep finds nothing for an unknown step, and malformed ids and other tenants look exactly the same`, async () => {
    const s = store();
    await approved(s);
    const missing = await find(s, PW, 'st-ffffffffffff');
    code(missing, 'STORE_NOT_FOUND');
    assert.deepEqual(await find(s, DW), missing, "another tenant's step looks like a step that does not exist");
    for (const bad of [undefined, null, 5, 'x', {}, [], 'st-1', 'ST-0123456789AB', 'wi-0123456789ab', 'st-0123456789abc', `${STEP} `]) assert.deepEqual(await s.findByStep(await processing(PW), bad), missing);
  });

  test(`${name}: findByStep returns the live request over older finished ones, and otherwise the newest finished one`, async () => {
    const s = store();
    const human1 = () => human(PW, { session: plus(100_000) });
    const d1 = await propose(); ok(await s.putProposal(await processing(), d1));
    ok(await s.recordDecision(await human1(), await decide(d1, 'declined')));
    let f = ok(await find(s)).snapshot;
    assert.deepEqual([f.proposal_id, f.state], [d1.proposal_id, 'declined']);

    at(plus(1));
    const d2 = await propose(); ok(await s.putProposal(await processing(), d2));
    f = ok(await find(s)).snapshot;
    assert.deepEqual([f.proposal_id, f.state], [d2.proposal_id, 'requested'], 'the new live request wins over the older declined one');

    at(plus(3600 + 5));                                 // d2 runs out unanswered
    f = ok(await find(s)).snapshot;
    assert.deepEqual([f.proposal_id, f.state], [d2.proposal_id, 'expired'], 'the newest finished one, not the older declined one');

    at(plus(3600 + 10));
    const d3 = await propose(); ok(await s.putProposal(await processing(), d3));
    ok(await s.recordDecision(await human1(), await decide(d3)));
    const c = ok(await s.claim(await processing(), d3.proposal_id, ACTION()));
    ok(await s.complete(await processing(), d3.proposal_id, c.grant.claim_id, { status: 'failed' }));
    f = ok(await find(s)).snapshot;
    assert.deepEqual([f.proposal_id, f.state], [d3.proposal_id, 'failed']);

    at(plus(3600 + 20));
    const d4 = await propose(); ok(await s.putProposal(await processing(), d4));
    f = ok(await find(s)).snapshot;
    assert.deepEqual([f.proposal_id, f.state], [d4.proposal_id, 'requested']);
    assert.equal(new Set([d1, d2, d3, d4].map((x) => x.proposal_id)).size, 4);
  });

  test(`${name}: findByStep applies expiry and a lapsed lease itself, exactly once`, async () => {
    const s = store();
    const p = await propose(); ok(await s.putProposal(await processing(), p));
    at(plus(3599)); assert.equal(ok(await find(s)).snapshot.state, 'requested');
    at(plus(3600)); assert.equal(ok(await find(s)).snapshot.state, 'expired', 'the end of the window is exclusive');
    assert.equal(ok(await find(s)).snapshot.state, 'expired');
    const log = ok(await s.events(await processing(), p.proposal_id)).events;
    assert.deepEqual(log.map((e: any) => e.type), ['requested', 'expired'], 'one expiry event, however often it is read');
    assert.equal(verifyEventLog(log), true);

    const s2 = store();
    const q = await approved(s2);
    ok(await claimOf(s2, q));
    at(plus(120));
    assert.equal(ok(await find(s2)).snapshot.state, 'in_doubt');
    assert.equal(ok(await find(s2)).snapshot.state, 'in_doubt');
    const log2 = ok(await s2.events(await processing(), q.proposal_id)).events;
    assert.deepEqual(log2.map((e: any) => e.type), ['requested', 'approved', 'claimed', 'lease_lapsed']);
  });

  test(`${name}: findByStep keeps tenants apart and answers only to trusted agent contexts`, async () => {
    const s = store();
    const a = await approved(s, PW); const b = await approved(s, DW);
    assert.equal(ok(await find(s, PW)).snapshot.proposal_id, a.proposal_id);
    assert.equal(ok(await find(s, DW)).snapshot.proposal_id, b.proposal_id);
    ok(await claimOf(s, a, PW));
    assert.equal(ok(await find(s, PW)).snapshot.state, 'claimed');
    assert.equal(ok(await find(s, DW)).snapshot.state, 'approved', "one tenant's claim does not touch the other");
    assert.equal(ok(await s.findByStep(await qcCtx(), STEP)).snapshot.state, 'claimed', 'a read-only agent context may look');
    assert.equal(ok(await s.findByStep(await agent(PW, 'reporting', ['reporting:run']), STEP)).snapshot.state, 'claimed');
    const good = await processing();
    for (const bad of [{ ...good }, structuredClone(good), new Proxy(good, {}), null, undefined, 'ctx', await human()]) code(await s.findByStep(bad, STEP), 'CONTEXT_NOT_TRUSTED');
  });

  test(`${name}: findByStep under concurrency never shows an impossible state, and claims still have one winner`, async () => {
    const s = store();
    const p = await approved(s);
    const ctx = await processing();
    const jobs: Promise<any>[] = [];
    for (let i = 0; i < 10; i++) { jobs.push(s.claim(ctx, p.proposal_id, ACTION())); jobs.push(s.findByStep(ctx, STEP)); jobs.push(s.findByStep(ctx, STEP)); }
    const results = await Promise.all(jobs);
    const claims = results.filter((_, i) => i % 3 === 0);
    assert.equal(claims.filter((r) => r.ok).length, 1);
    for (const r of results.filter((_, i) => i % 3 !== 0)) { ok(r); assert.ok(['approved', 'claimed'].includes(r.snapshot.state), r.snapshot.state); assert.equal(r.snapshot.proposal_id, p.proposal_id); }
    const end = ok(await find(s)).snapshot;
    assert.deepEqual([end.state, end.attempts], ['claimed', 1]);
    assert.equal(verifyEventLog(ok(await s.events(ctx, p.proposal_id)).events), true);

    const s2 = store();
    const q = await propose(); ok(await s2.putProposal(ctx, q));
    at(plus(3600));
    const reads = await Promise.all(Array.from({ length: 12 }, () => s2.findByStep(ctx, STEP)));
    for (const r of reads) assert.equal(ok(r).snapshot.state, 'expired');
    const types = ok(await s2.events(ctx, q.proposal_id)).events.map((e: any) => e.type);
    assert.deepEqual(types, ['requested', 'expired'], 'twelve readers, one expiry event');
  });

  test(`${name}: findByStep exposes ids and fixed words only`, async () => {
    const s = store();
    const p = await approved(s);
    const snap = ok(await find(s)).snapshot;
    const text = JSON.stringify(snap);
    assert.ok(!text.includes('CANARY') && !text.includes('arguments') && !text.includes('"note"'));
    assert.ok(text.includes(p.action_digest));
    assert.throws(() => { (snap as any).state = 'declined'; }, TypeError);
    assert.equal(ok(await find(s)).snapshot.state, 'approved');
  });
}
