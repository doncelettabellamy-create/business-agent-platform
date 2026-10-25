// Tests for the pure approval contracts: proposal, decision, and the pre-execution check. Mock contexts, synthetic data only.
// Nothing here runs a tool or touches Processing, QC, Reporting or the pipeline. No network, no key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { mintExecutionContext } from '../src/execution-context.ts';
import { mintApproverContext } from '../src/approver-context.ts';
import type { ApproverContext } from '../src/approver-context.ts';
import type { ActorKind, AgentName, ExecutionContext } from '../src/execution-context.ts';
import {
  actionDigest, approvalScopeFor, decideProposal, DECISION_CONTRACT, proposeAction, PROPOSAL_CONTRACT, validateDecision, validateProposal, verifyApproval,
} from '../src/approval.ts';
import { classify } from '../src/observability.ts';

const CANARY = 'CANARY-APR-3392';
const PW = 'ws-synthetic-plumbing';
const DW = 'ws-synthetic-dental';
const T0 = '2026-10-25T20:00:00Z';
let clock = T0;
const deps = (extra: Record<string, unknown> = {}) => ({ now: () => clock, ...extra });
const at = (s: string) => { clock = s; };

async function mintCtx(tenant: string, agent: AgentName, o: { kind?: ActorKind; id?: string; corr?: string; scopes?: string[] } = {}): Promise<ExecutionContext> {
  const r = await mintExecutionContext({ credential: 'mock-credential', agent }, {
    verify: () => ({ kind: o.kind ?? 'user', id: o.id ?? 'user-requester' }), selectTenant: () => tenant,
    grants: () => o.scopes ?? [], newCorrelationId: () => o.corr ?? 'corr-1',
  });
  assert.equal(r.ok, true);
  return (r as { ok: true; context: ExecutionContext }).context;
}
const requester = (tenant = PW, o: Parameters<typeof mintCtx>[2] = {}) => mintCtx(tenant, 'processing', { id: 'user-requester', corr: 'corr-req', scopes: ['processing:run'], ...o });
/** A trusted HUMAN-APPROVER context from mock identity, membership and session sources. */
async function approver(tenant = PW, o: { id?: string; corr?: string; scopes?: string[]; assurance?: string; session?: string; proposal_id?: string } = {}): Promise<ApproverContext> {
  const r = await mintApproverContext({ credential: 'mock-credential', workspace_id: tenant, ...(o.proposal_id ? { proposal_id: o.proposal_id } : {}) }, {
    verify: () => ({ kind: 'user', id: o.id ?? 'user-boss', assurance: o.assurance ?? 'multi-factor', authenticated_at: T0, session_expires_at: o.session ?? '2026-10-25T23:00:00Z' }),
    membership: () => true, grants: () => o.scopes ?? [approvalScopeFor('mock-note')], newCorrelationId: () => o.corr ?? 'corr-boss', now: () => clock,
  });
  assert.equal(r.ok, true, `approver mint: ${JSON.stringify((r as any).error)}`);
  return (r as { ok: true; context: ApproverContext }).context;
}
const ACTION = () => ({ item_id: 'wi-0123456789ab', step_id: 'st-0123456789ab', tool: 'mock-note', arguments: { item_id: 'wi-0123456789ab', note: `text ${CANARY}`, tags: ['a', 'b'], nested: { n: 1 } } });

async function proposed(tenant = PW, action: unknown = ACTION()) {
  const r = proposeAction(await requester(tenant), action, deps());
  assert.equal(r.ok, true, `propose: ${JSON.stringify((r as any).error)}`);
  return (r as any).proposal;
}
async function decided(proposal: any, input: unknown = { decision: 'approved', reason_code: 'within_policy' }, who?: ApproverContext) {
  const r = decideProposal(who ?? await approver(proposal.workspace_id), proposal, input, deps());
  assert.equal(r.ok, true, `decide: ${JSON.stringify((r as any).error)}`);
  return (r as any).decision;
}
function code(r: unknown, expected: string) {
  assert.equal((r as any).ok, false, `expected refusal ${expected}`);
  assert.equal((r as any).error.code, expected);
  const m: string = (r as any).error.message;
  assert.ok(m.length > 0 && !m.includes('CANARY') && !m.includes(PW) && !m.includes(DW) && !m.includes('user-'), 'fixed text, no values');
}
const executor = (tenant = PW) => mintCtx(tenant, 'processing', { id: 'user-requester', corr: 'corr-exec', scopes: ['processing:run'] });

// ---------------------------------------------------------------- approval
test('approval: a distinct human approves the exact action and the executor check passes', async () => {
  at(T0);
  const p = await proposed();
  assert.deepEqual(validateProposal(p), []);
  assert.deepEqual([p.contract, p.workspace_id, p.item_id, p.step_id, p.tool, p.requested_at, p.expires_at], [PROPOSAL_CONTRACT, PW, 'wi-0123456789ab', 'st-0123456789ab', 'mock-note', T0, '2026-10-25T21:00:00Z']);
  assert.match(p.proposal_id, /^ap-[0-9a-f]{12}$/);
  assert.deepEqual([p.requested_by.kind, p.requested_by.id, p.requester_correlation_id], ['user', 'user-requester', 'corr-req']);
  assert.equal(p.action_digest, actionDigest({ workspace_id: PW, ...ACTION() }));
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.requested_by));
  at('2026-10-25T20:05:00Z');
  const d = await decided(p);
  assert.deepEqual(validateDecision(d), []);
  assert.deepEqual([d.contract, d.proposal_id, d.workspace_id, d.action_digest, d.decision, d.reason_code, d.approver, d.decided_at, d.expires_at, d.single_use],
    [DECISION_CONTRACT, p.proposal_id, PW, p.action_digest, 'approved', 'within_policy', { kind: 'user', id: 'user-boss' }, '2026-10-25T20:05:00Z', p.expires_at, true]);
  assert.equal(d.approver_correlation_id, 'corr-boss');
  assert.equal(d.approver_assurance, 'multi-factor');
  assert.ok(Object.isFrozen(d));
  at('2026-10-25T20:06:00Z');
  const v = verifyApproval(await executor(), p, d, ACTION(), deps());
  assert.deepEqual(v, { ok: true, proposal_id: p.proposal_id, action_digest: p.action_digest });
});

test('approval: the proposal holds a digest of the arguments, never the arguments, and the same action gives the same id', async () => {
  at(T0);
  const p = await proposed();
  const d = await decided(p);
  assert.ok(!JSON.stringify([p, d]).includes('CANARY'));
  assert.ok(!JSON.stringify(p).includes('"note"'));
  const again = await proposed();
  assert.equal(again.proposal_id, p.proposal_id);
  assert.equal(again.action_digest, p.action_digest);
  const key = { ...ACTION(), arguments: { nested: { n: 1 }, tags: ['a', 'b'], note: `text ${CANARY}`, item_id: 'wi-0123456789ab' } };
  assert.equal((await proposed(PW, key)).action_digest, p.action_digest, 'key order does not matter');
});

// ---------------------------------------------------------------- denial
test('denial: a declined decision is valid, bound and recorded, but never lets the action run', async () => {
  at(T0);
  const p = await proposed();
  const d = await decided(p, { decision: 'declined', reason_code: 'outside_policy' });
  assert.deepEqual(validateDecision(d), []);
  assert.deepEqual([d.decision, d.reason_code], ['declined', 'outside_policy']);
  code(verifyApproval(await executor(), p, d, ACTION(), deps()), 'APPROVAL_DECLINED');
  assert.equal(classify('APPROVAL_DECLINED'), 'refused_permission');
});

test('denial: the default is no. No decision, a decision for another proposal, or an unknown outcome never verifies', async () => {
  at(T0);
  const p = await proposed();
  const other = await proposed(PW, { ...ACTION(), step_id: 'st-aaaaaaaaaaaa' });
  const dOther = await decided(other);
  code(verifyApproval(await executor(), p, dOther, ACTION(), deps()), 'ACTION_MISMATCH');
  for (const bad of [undefined, null, 'approved', {}, []]) code(verifyApproval(await executor(), p, bad, ACTION(), deps()), 'APPROVAL_NOT_TRUSTED');
  for (const input of [{ decision: 'maybe', reason_code: 'other' }, { decision: 'approved', reason_code: 'because I said so' }, { decision: 'approved' }, { reason_code: 'other' }, null, 'approved']) {
    code(decideProposal(await approver(), p, input, deps()), 'DECISION_INVALID');
  }
});

// ---------------------------------------------------------------- expiry
test('expiry: no decision after the proposal expires, and an old approval stops working at the boundary', async () => {
  at(T0);
  const p = await proposed();
  at('2026-10-25T20:59:59Z');
  const d = await decided(p);
  at('2026-10-25T20:59:59Z');
  assert.equal(verifyApproval(await executor(), p, d, ACTION(), deps()).ok, true);
  at('2026-10-25T21:00:00Z');
  code(verifyApproval(await executor(), p, d, ACTION(), deps()), 'PROPOSAL_EXPIRED');
  code(decideProposal(await approver(), p, { decision: 'approved', reason_code: 'within_policy' }, deps()), 'PROPOSAL_EXPIRED');
  at('2027-01-01T00:00:00Z');
  code(verifyApproval(await executor(), p, d, ACTION(), deps()), 'PROPOSAL_EXPIRED');
});

test('expiry: the window is set by the proposal; a decision cannot extend it; a clock that goes backwards fails closed', async () => {
  at(T0);
  const p = await proposed();
  at('2026-10-25T20:30:00Z');
  const d = await decided(p);
  assert.equal(d.expires_at, p.expires_at);
  at('2026-10-25T19:00:00Z');
  const back = verifyApproval(await executor(), p, d, ACTION(), deps());
  assert.equal(back.ok, false, 'an approval is not valid before it was given');
  at(T0);
  assert.equal(proposeAction(await requester(), ACTION(), { now: () => clock, ttlSeconds: 60 }).ok, true);
  for (const ttlSeconds of [0, -1, 86_401, 1.5, NaN, '60']) code(proposeAction(await requester(), ACTION(), { now: () => clock, ttlSeconds: ttlSeconds as never }), 'PROPOSAL_INVALID');
  for (const bad of [() => 'bad', () => { throw new Error(CANARY); }, () => 5, () => '2026-13-45T99:99:99Z']) {
    code(proposeAction(await requester(), ACTION(), { now: bad as never }), 'APPROVAL_ERROR');
  }
  code(proposeAction(await requester(), ACTION(), null as never), 'PROPOSAL_INVALID');
});

// ---------------------------------------------------------------- forged identity
test('identity: the approver is whoever the minted context says; a body cannot name one', async () => {
  at(T0);
  const p = await proposed();
  for (const extra of [{ approver: { kind: 'user', id: 'user-ceo' } }, { approver_id: 'user-ceo' }, { workspace_id: DW }, { decided_at: T0 }, { actor: 'user-ceo' }, { __proto__: { approver: 'x' }, approver: 'x' }]) {
    code(decideProposal(await approver(), p, { decision: 'approved', reason_code: 'within_policy', ...extra }, deps()), 'DECISION_INVALID');
  }
  const d = await decided(p);
  assert.equal(d.approver.id, 'user-boss');
});

test('identity: forged, copied, cloned, JSON and proxied approver contexts cannot approve, and nothing is produced', async () => {
  at(T0);
  const p = await proposed();
  const good = await approver();
  const forgedShape = { workspace_id: PW, approver: { kind: 'user', id: 'user-ceo' }, correlation_id: 'c', scopes: [approvalScopeFor('mock-note')], assurance: 'multi-factor', authenticated_at: T0, session_expires_at: '2099-01-01T00:00:00Z' };
  for (const bad of [forgedShape, { ...good }, structuredClone(good), JSON.parse(JSON.stringify(good)), new Proxy(good, {}), Object.create(good), null, undefined, 'ctx', 5]) {
    code(decideProposal(bad, p, { decision: 'approved', reason_code: 'within_policy' }, deps()), 'CONTEXT_NOT_TRUSTED');
  }
  for (const bad of [{ ...(await executor()) }, null]) code(verifyApproval(bad, p, await decided(p), ACTION(), deps()), 'CONTEXT_NOT_TRUSTED');
  for (const bad of [{ ...(await requester()) }, null, undefined]) code(proposeAction(bad, ACTION(), deps()), 'CONTEXT_NOT_TRUSTED');
  assert.ok(Object.isFrozen(good) && Object.isFrozen(good.approver) && Object.isFrozen(good.scopes));
  assert.equal('agent' in good, false, 'an approver context has no agent identity');
});

test('identity: an agent context is refused as an approver, even for a human actor holding the approval scope', async () => {
  at(T0);
  const p = await proposed();
  for (const agent of ['intake', 'processing', 'quality-control', 'reporting'] as const) {
    const agentCtx = await mintCtx(PW, agent, { id: 'user-boss', corr: 'corr-boss', scopes: [approvalScopeFor('mock-note'), 'processing:run'] });
    code(decideProposal(agentCtx, p, { decision: 'approved', reason_code: 'within_policy' }, deps()), 'APPROVER_NOT_HUMAN');
  }
  assert.equal(classify('APPROVER_NOT_HUMAN'), 'refused_permission');
});

test('identity: an expired approver session cannot decide, and the boundary is exclusive', async () => {
  at(T0);
  const p = await proposed();
  const ctx = await approver(PW, { session: '2026-10-25T20:10:00Z' });
  at('2026-10-25T20:09:59Z');
  assert.equal(decideProposal(ctx, p, { decision: 'approved', reason_code: 'within_policy' }, deps()).ok, true);
  at('2026-10-25T20:10:00Z');
  code(decideProposal(ctx, p, { decision: 'approved', reason_code: 'within_policy' }, deps()), 'APPROVER_SESSION_EXPIRED');
  at('2026-10-25T22:00:00Z');
  code(decideProposal(ctx, p, { decision: 'approved', reason_code: 'within_policy' }, deps()), 'APPROVER_SESSION_EXPIRED');
  assert.equal(classify('APPROVER_SESSION_EXPIRED'), 'refused_authentication');
  at(T0);
});

test('identity: a context pinned to one proposal cannot decide another', async () => {
  at(T0);
  const p = await proposed();
  const other = await proposed(PW, { ...ACTION(), step_id: 'st-bbbbbbbbbbbb' });
  const pinned = await approver(PW, { proposal_id: p.proposal_id });
  assert.equal(decideProposal(pinned, p, { decision: 'approved', reason_code: 'within_policy' }, deps()).ok, true);
  code(decideProposal(pinned, other, { decision: 'approved', reason_code: 'within_policy' }, deps()), 'ACTION_MISMATCH');
});

test('identity: the requester cannot approve their own request, by actor id or by run', async () => {
  at(T0);
  const p = await proposed();
  const self = await approver(PW, { id: 'user-requester' });
  code(decideProposal(self, p, { decision: 'approved', reason_code: 'within_policy' }, deps()), 'SELF_APPROVAL');
  const sameRun = await approver(PW, { id: 'user-someone-else', corr: 'corr-req' });
  code(decideProposal(sameRun, p, { decision: 'approved', reason_code: 'within_policy' }, deps()), 'SELF_APPROVAL');
  assert.equal(classify('SELF_APPROVAL'), 'safety_violation');
});

test('identity: the per-tool approval scope is required; a scope for another tool does not count, and an approver context cannot hold agent scopes at all', async () => {
  at(T0);
  const p = await proposed();
  const none = await approver(PW, { scopes: [] });
  const other = await approver(PW, { scopes: [approvalScopeFor('mock-other')] });
  for (const ctx of [none, other]) code(decideProposal(ctx, p, { decision: 'approved', reason_code: 'within_policy' }, deps()), 'APPROVAL_NOT_PERMITTED');
  const mixed = await mintApproverContext({ credential: 'c', workspace_id: PW }, {
    verify: () => ({ kind: 'user', id: 'user-boss', assurance: 'multi-factor', authenticated_at: T0, session_expires_at: '2026-10-25T23:00:00Z' }),
    membership: () => true, grants: () => [approvalScopeFor('mock-note'), 'processing:run'], newCorrelationId: () => 'c', now: () => clock });
  assert.equal((mixed as any).error.code, 'APPROVER_GRANTS_INVALID');
});

test('identity: a hand-built, cloned or edited proposal or decision is not the issued original', async () => {
  at(T0);
  const p = await proposed();
  const d = await decided(p);
  const ex = await executor();
  const forgedDecision = { ...structuredClone(d), approver: { kind: 'user', id: 'user-ceo' } };
  const flipped = { ...structuredClone(d), decision: 'approved' };
  for (const [prop, dec] of [[p, structuredClone(d)], [p, forgedDecision], [p, flipped], [p, JSON.parse(JSON.stringify(d))], [p, { ...d }], [p, new Proxy(d, {})], [structuredClone(p), d], [{ ...p }, d], [new Proxy(p, {}), d]]) {
    code(verifyApproval(ex, prop, dec, ACTION(), deps()), 'APPROVAL_NOT_TRUSTED');
  }
  code(decideProposal(await approver(), structuredClone(p), { decision: 'approved', reason_code: 'within_policy' }, deps()), 'APPROVAL_NOT_TRUSTED');
  code(decideProposal(await approver(), { ...p, expires_at: '2099-01-01T00:00:00Z' }, { decision: 'approved', reason_code: 'within_policy' }, deps()), 'APPROVAL_NOT_TRUSTED');
  assert.equal(classify('APPROVAL_NOT_TRUSTED'), 'safety_violation');
});

// ---------------------------------------------------------------- changed arguments
test('exact action: any change to the arguments, item, step, tool or nesting stops the action from verifying', async () => {
  at(T0);
  const p = await proposed();
  const d = await decided(p);
  const ex = await executor();
  const base = ACTION();
  const variants: [string, any][] = [
    ['changed value', { ...base, arguments: { ...base.arguments, note: 'something else' } }],
    ['extra key', { ...base, arguments: { ...base.arguments, extra: 1 } }],
    ['missing key', { ...base, arguments: { item_id: base.arguments.item_id } }],
    ['changed nested', { ...base, arguments: { ...base.arguments, nested: { n: 2 } } }],
    ['array order', { ...base, arguments: { ...base.arguments, tags: ['b', 'a'] } }],
    ['number vs string', { ...base, arguments: { ...base.arguments, nested: { n: '1' } } }],
    ['other item', { ...base, item_id: 'wi-ffffffffffff' }],
    ['other step', { ...base, step_id: 'st-ffffffffffff' }],
    ['other tool', { ...base, tool: 'mock-other' }],
    ['tenant smuggled in', { ...base, workspace_id: DW }],
    ['not an action', 'run it'], ['null', null], ['empty', {}],
  ];
  for (const [name, action] of variants) code(verifyApproval(ex, p, d, action, deps()), 'ACTION_MISMATCH');
  assert.equal(verifyApproval(ex, p, d, base, deps()).ok, true, 'the unchanged action still verifies');
  assert.equal(classify('ACTION_MISMATCH'), 'safety_violation');
});

test('exact action: arguments that are not plain data cannot be proposed or presented', async () => {
  at(T0);
  const cyc: any = { a: 1 }; cyc.self = cyc;
  const getter = {}; Object.defineProperty(getter, 'x', { enumerable: true, get() { return CANARY; } });
  const deep = JSON.parse('{"a":{"b":{"c":{"d":{"e":{"f":{"g":1}}}}}}}');
  const bad: unknown[] = [undefined, () => 1, Symbol('s'), new Date(), cyc, getter, deep, 'x'.repeat(5000), { n: NaN }, { n: Infinity }, { f: () => 1 }, { u: undefined }, new Map(), Object.create({ inherited: 1 }), JSON.parse('{"__proto__":{"x":1}}')];
  for (const args of bad) code(proposeAction(await requester(), { ...ACTION(), arguments: args }, deps()), 'PROPOSAL_INVALID');
  for (const action of [null, 'x', [], { item_id: 'x', step_id: 'y', tool: 'z', arguments: {} }, { ...ACTION(), extra: 1 }, { item_id: ACTION().item_id }]) code(proposeAction(await requester(), action, deps()), 'PROPOSAL_INVALID');
  const p = await proposed(PW, { ...ACTION(), arguments: { ok: true } });
  assert.equal(p.tenant, undefined);
});

test('exact action: arguments are read once, so a changing getter cannot show one value to the proposal and another to the tool', async () => {
  at(T0);
  let reads = 0;
  const args: Record<string, unknown> = {};
  Object.defineProperty(args, 'n', { enumerable: true, get() { reads++; return reads; } });
  code(proposeAction(await requester(), { ...ACTION(), arguments: args }, deps()), 'PROPOSAL_INVALID');
  const holder = { ...ACTION() } as Record<string, unknown>;
  let tools = 0;
  Object.defineProperty(holder, 'tool', { enumerable: true, get() { return tools++ === 0 ? 'mock-note' : 'mock-other'; } });
  const r = proposeAction(await requester(), holder, deps());
  assert.equal(r.ok, true);
  assert.equal(tools, 1);
  assert.equal((r as any).proposal.tool, 'mock-note');
});

// ---------------------------------------------------------------- cross-tenant
test('tenant: an approver, executor or proposal from another tenant is rejected, and ids alone do not cross tenants', async () => {
  at(T0);
  const p = await proposed(PW);
  code(decideProposal(await approver(DW), p, { decision: 'approved', reason_code: 'within_policy' }, deps()), 'TENANT_MISMATCH');
  const d = await decided(p);
  code(verifyApproval(await executor(DW), p, d, ACTION(), deps()), 'TENANT_MISMATCH');
  const q = await proposed(DW);
  const dq = await decided(q);
  assert.notEqual(q.action_digest, p.action_digest, 'the same item, step and arguments digest differently per tenant');
  assert.notEqual(q.proposal_id === p.proposal_id && q.workspace_id === p.workspace_id, true);
  code(verifyApproval(await executor(PW), p, dq, ACTION(), deps()), 'TENANT_MISMATCH');
  code(verifyApproval(await executor(PW), q, dq, ACTION(), deps()), 'TENANT_MISMATCH');
  code(verifyApproval(await executor(PW), q, d, ACTION(), deps()), 'TENANT_MISMATCH');
  assert.equal(verifyApproval(await executor(DW), q, dq, ACTION(), deps()).ok, true);
  assert.equal(verifyApproval(await executor(PW), p, d, ACTION(), deps()).ok, true);
});

test('tenant: the tenant on every object comes from a context, so a caller cannot propose into another tenant', async () => {
  at(T0);
  const r = proposeAction(await requester(PW), { ...ACTION(), workspace_id: DW }, deps());
  code(r, 'PROPOSAL_INVALID');
  const p = await proposed(PW);
  assert.equal(p.workspace_id, PW);
});

// ---------------------------------------------------------------- requester authority
test('requester: only a Processing context with processing:run may propose or present an action', async () => {
  at(T0);
  const p = await proposed();
  const d = await decided(p);
  const wrongAgent = await mintCtx(PW, 'quality-control', { id: 'user-requester', scopes: ['processing:run'] });
  const noScope = await mintCtx(PW, 'processing', { id: 'user-requester', scopes: [] });
  for (const ctx of [wrongAgent, noScope]) {
    code(proposeAction(ctx, ACTION(), deps()), 'APPROVAL_NOT_PERMITTED');
    code(verifyApproval(ctx, p, d, ACTION(), deps()), 'APPROVAL_NOT_PERMITTED');
  }
});

// ---------------------------------------------------------------- validators, purity
test('validators: they reject padded, malformed and inconsistent objects', async () => {
  at(T0);
  const p = JSON.parse(JSON.stringify(await proposed()));
  const d = JSON.parse(JSON.stringify(await decided(await proposed())));
  const badP: any[] = [{ ...p, contract: 'x' }, { ...p, extra: 1 }, { ...p, proposal_id: 'ap-1' }, { ...p, item_id: 'w' }, { ...p, tool: 'Bad Tool' }, { ...p, action_digest: 'abc' },
    { ...p, requested_by: { kind: 'robot', id: 'x' } }, { ...p, requested_by: { kind: 'user', id: '' } }, { ...p, expires_at: p.requested_at }, { ...p, requested_at: 'now' }];
  const badD: any[] = [{ ...d, contract: 'x' }, { ...d, extra: 1 }, { ...d, decision: 'maybe' }, { ...d, reason_code: 'free text' }, { ...d, approver: { kind: 'service', id: 'x' } },
    { ...d, single_use: false }, { ...d, decided_at: d.expires_at }, { ...d, action_digest: 'abc' }, { ...d, approver_correlation_id: '' }];
  for (const b of badP) assert.notDeepEqual(validateProposal(b), []);
  for (const b of badD) assert.notDeepEqual(validateDecision(b), []);
  for (const odd of [null, undefined, 'x', [], 5]) { assert.notDeepEqual(validateProposal(odd), []); assert.notDeepEqual(validateDecision(odd), []); }
  assert.deepEqual(validateProposal(p), []);
  assert.deepEqual(validateDecision(d), []);
});

test('purity: the approval module never throws, keeps no state, and is not connected to execution', async () => {
  at(T0);
  const garbage: unknown[] = [undefined, null, 5, 'x', [], {}, new Proxy({}, { get() { throw new Error(CANARY); }, ownKeys() { throw new Error(CANARY); } })];
  for (const g of garbage) {
    assert.doesNotThrow(() => proposeAction(g, g, g as never));
    assert.doesNotThrow(() => decideProposal(g, g, g, g as never));
    assert.doesNotThrow(() => verifyApproval(g, g, g, g, g as never));
    assert.doesNotThrow(() => validateProposal(g));
    assert.doesNotThrow(() => validateDecision(g));
  }
  const dir = new URL('../src/', import.meta.url);
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  assert.deepEqual(files.filter((f) => f !== 'approval.ts' && /\.\/approval\.ts/.test(strip(readFileSync(new URL(f, dir), 'utf8')))), ['approval-store-sqlite.ts', 'approval-store.ts', 'processing-entry.ts', 'qc-entry.ts'], 'only the approval stores, the Processing entry (to propose) and QC (to recompute an action digest) import the approval module; Reporting, tools and the pipeline do not');
  const code_ = strip(readFileSync(new URL('approval.ts', dir), 'utf8'));
  for (const m of code_.matchAll(/from\s+'([^']+)'/g)) assert.ok(['./contracts.ts', './execution-context.ts', './approver-context.ts', './handoff-seal.ts'].includes(m[1]), `approval.ts imports ${m[1]}`);
  assert.ok(!/\b(fetch|process\.env|readFile|writeFile|child_process|mintExecutionContext|runIntake|setTimeout|Date\.now|new Date\(\)|Math\.random)\b/.test(code_), 'no I/O, no hidden clock, no randomness');
  const using = (n: string) => files.filter((f) => f !== 'handoff-seal.ts' && new RegExp(`\\b${n}\\b`).test(strip(readFileSync(new URL(f, dir), 'utf8'))));
  assert.deepEqual(using('sealApprovalProposal'), ['approval.ts']);
  assert.deepEqual(using('sealApprovalDecision'), ['approval.ts']);
  assert.deepEqual(using('sealHandoff'), ['intake-entry.ts']);
});
