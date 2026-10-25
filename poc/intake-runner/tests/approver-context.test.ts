// Tests for the trusted human-approver context: a separate kind of context with no agent identity and approval-only scopes.
// Mock identity, membership, grants and clock sources only. No network, no key, synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { acceptHandoff, can, isTrusted, mintExecutionContext, narrow } from '../src/execution-context.ts';
import type { ExecutionContext } from '../src/execution-context.ts';
import { approverCan, isTrustedApprover, mintApproverContext } from '../src/approver-context.ts';
import type { ApproverContext, ApproverDeps } from '../src/approver-context.ts';
import { classify } from '../src/observability.ts';

const CANARY = 'CANARY-APCTX-6104';
const PW = 'ws-synthetic-plumbing';
const DW = 'ws-synthetic-dental';
const NOW = '2026-10-25T20:00:00Z';
const SCOPE = 'approval:decide:mock-note';

function sources(over: Partial<Record<keyof ApproverDeps, unknown>> = {}) {
  const calls = { verify: 0, membership: 0, grants: 0, corr: 0, now: 0 };
  const deps = {
    verify: () => { calls.verify++; return { kind: 'user', id: 'user-boss', assurance: 'multi-factor', authenticated_at: '2026-10-25T19:50:00Z', session_expires_at: '2026-10-25T20:30:00Z' }; },
    membership: () => { calls.membership++; return true; },
    grants: () => { calls.grants++; return [SCOPE]; },
    newCorrelationId: () => { calls.corr++; return 'corr-approver-1'; },
    now: () => { calls.now++; return NOW; },
    ...over,
  } as unknown as ApproverDeps;
  return { deps, calls };
}
async function mint(over: Partial<Record<keyof ApproverDeps, unknown>> = {}, request: Record<string, unknown> = {}) {
  const s = sources(over);
  const r = await mintApproverContext({ credential: 'mock-credential', workspace_id: PW, ...request } as never, s.deps);
  return { r, ...s };
}
function refused(r: unknown, code: string) {
  assert.equal((r as any).ok, false, `expected ${code}`);
  assert.equal((r as any).error.code, code);
  const m: string = (r as any).error.message;
  assert.ok(m.length > 0 && !m.includes('CANARY') && !m.includes(PW) && !m.includes('user-boss'), 'fixed text, no values');
}
const hang = () => new Promise<never>(() => {});

// ---------------------------------------------------------------- the context
test('approver context: verified human, one tenant, approval-only scopes, assurance and session, and no agent identity', async () => {
  const { r, calls } = await mint();
  assert.equal((r as any).ok, true);
  const c = (r as { context: ApproverContext }).context;
  assert.deepEqual([c.workspace_id, c.approver, c.correlation_id, [...c.scopes], c.assurance, c.authenticated_at, c.session_expires_at],
    [PW, { kind: 'user', id: 'user-boss' }, 'corr-approver-1', [SCOPE], 'multi-factor', '2026-10-25T19:50:00Z', '2026-10-25T20:30:00Z']);
  assert.deepEqual(Object.keys(c).sort(), ['approver', 'assurance', 'authenticated_at', 'correlation_id', 'scopes', 'session_expires_at', 'workspace_id']);
  assert.equal('agent' in c, false);
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.approver) && Object.isFrozen(c.scopes));
  assert.deepEqual(calls, { verify: 1, membership: 1, grants: 1, corr: 1, now: 1 }, 'each source is asked once');
  assert.equal(isTrustedApprover(c), true);
  assert.equal(approverCan(c, SCOPE), true);
  assert.equal(approverCan(c, 'approval:decide:other'), false, 'default deny');
});

test('approver context: a session can be pinned to one proposal', async () => {
  const { r } = await mint({}, { proposal_id: 'ap-0123456789ab' });
  assert.equal(((r as any).context as ApproverContext).proposal_id, 'ap-0123456789ab');
  for (const bad of ['ap-1', 'x', 5, '', 'ap-0123456789AB']) refused((await mint({}, { proposal_id: bad })).r, 'APPROVER_CONTEXT_INVALID');
});

// ---------------------------------------------------------------- forged identity
test('forged identity: an unverified, malformed, non-human or failing identity gets no context and later sources are not asked', async () => {
  const id = { kind: 'user', id: 'user-boss', assurance: 'multi-factor', authenticated_at: '2026-10-25T19:50:00Z', session_expires_at: '2026-10-25T20:30:00Z' };
  const bad: [string, () => unknown][] = [
    ['nothing', () => undefined], ['null', () => null], ['string', () => 'user-boss'], ['array', () => []], ['throws', () => { throw new Error(CANARY); }],
    ['rejects', () => Promise.reject(new Error(CANARY))],
    ['service', () => ({ ...id, kind: 'service' })], ['agent', () => ({ ...id, kind: 'agent' })], ['system', () => ({ ...id, kind: 'system' })], ['no kind', () => ({ ...id, kind: undefined })],
    ['no id', () => ({ ...id, id: undefined })], ['bad id', () => ({ ...id, id: 'has space' })], ['long id', () => ({ ...id, id: 'x'.repeat(65) })], ['number id', () => ({ ...id, id: 5 })],
    ['unknown assurance', () => ({ ...id, assurance: 'trust-me' })], ['no assurance', () => ({ ...id, assurance: undefined })],
    ['bad auth time', () => ({ ...id, authenticated_at: 'yesterday' })], ['auth in the future', () => ({ ...id, authenticated_at: '2026-10-25T21:00:00Z' })],
    ['session before auth', () => ({ ...id, session_expires_at: '2026-10-25T19:00:00Z' })], ['no session', () => ({ ...id, session_expires_at: undefined })],
  ];
  for (const [name, verify] of bad) {
    const m = await mint({ verify });
    refused(m.r, 'APPROVER_UNAUTHENTICATED');
    assert.deepEqual([m.calls.membership, m.calls.grants, m.calls.corr], [0, 0, 0], name);
  }
  assert.equal(classify('APPROVER_UNAUTHENTICATED'), 'refused_authentication');
});

test('forged identity: a hanging source is bounded and refused, for every source', async () => {
  const started = Date.now();
  const cases: [string, Partial<Record<keyof ApproverDeps, unknown>>, string][] = [
    ['verify', { verify: hang }, 'APPROVER_UNAUTHENTICATED'], ['membership', { membership: hang }, 'APPROVER_NOT_MEMBER'],
    ['grants', { grants: hang }, 'APPROVER_GRANTS_INVALID'], ['now', { now: hang }, 'APPROVER_CONTEXT_INVALID'],
  ];
  for (const [, over, code] of cases) refused((await mint({ ...over, timeoutMs: 30 })).r, code);
  assert.ok(Date.now() - started < 3000);
});

test('forged identity: properties of the identity answer are read once, so a changing getter cannot switch the approver', async () => {
  let reads = 0;
  const answer: Record<string, unknown> = { kind: 'user', assurance: 'multi-factor', authenticated_at: '2026-10-25T19:50:00Z', session_expires_at: '2026-10-25T20:30:00Z' };
  Object.defineProperty(answer, 'id', { enumerable: true, get() { return reads++ === 0 ? 'user-boss' : 'user-ceo'; } });
  const { r } = await mint({ verify: () => answer });
  assert.equal(((r as any).context as ApproverContext).approver.id, 'user-boss');
  assert.equal(reads, 1);
});

// ---------------------------------------------------------------- assurance
test('assurance: a mock identity is refused unless asked for explicitly, and the minimum can be raised', async () => {
  const withAssurance = (assurance: string) => () => ({ kind: 'user', id: 'user-boss', assurance, authenticated_at: '2026-10-25T19:50:00Z', session_expires_at: '2026-10-25T20:30:00Z' });
  refused((await mint({ verify: withAssurance('mock') })).r, 'APPROVER_UNAUTHENTICATED');
  assert.equal(((await mint({ verify: withAssurance('mock'), minAssurance: 'mock' })).r as any).ok, true);
  assert.equal(((await mint({ verify: withAssurance('single-factor') })).r as any).ok, true);
  refused((await mint({ verify: withAssurance('single-factor'), minAssurance: 'multi-factor' })).r, 'APPROVER_UNAUTHENTICATED');
  assert.equal(((await mint({ verify: withAssurance('multi-factor'), minAssurance: 'multi-factor' })).r as any).ok, true);
  refused((await mint({ minAssurance: 'whatever' })).r, 'APPROVER_CONTEXT_INVALID');
});

// ---------------------------------------------------------------- sessions
test('session: an ended session is refused, the end is exclusive, and a long provider session is capped', async () => {
  const session = (end: string) => () => ({ kind: 'user', id: 'user-boss', assurance: 'multi-factor', authenticated_at: '2026-10-25T19:00:00Z', session_expires_at: end });
  refused((await mint({ verify: session('2026-10-25T19:59:59Z') })).r, 'APPROVER_SESSION_EXPIRED');
  refused((await mint({ verify: session(NOW) })).r, 'APPROVER_SESSION_EXPIRED');
  const ok = await mint({ verify: session('2026-10-25T20:00:01Z') });
  assert.equal(((ok.r as any).context as ApproverContext).session_expires_at, '2026-10-25T20:00:01Z');
  const longSession = await mint({ verify: session('2027-10-25T20:00:00Z') });
  assert.equal(((longSession.r as any).context as ApproverContext).session_expires_at, '2026-10-25T21:00:00Z', 'capped at one hour by default');
  const short = await mint({ verify: session('2027-10-25T20:00:00Z'), maxSessionSeconds: 60 });
  assert.equal(((short.r as any).context as ApproverContext).session_expires_at, '2026-10-25T20:01:00Z');
  for (const bad of [0, -1, 86_401, 1.5, '60']) refused((await mint({ maxSessionSeconds: bad })).r, 'APPROVER_CONTEXT_INVALID');
  assert.equal(classify('APPROVER_SESSION_EXPIRED'), 'refused_authentication');
});

test('session: a bad or wrong clock is not trusted', async () => {
  for (const now of [() => 'later', () => 5, () => { throw new Error(CANARY); }, () => '2026-13-45T99:99:99Z']) refused((await mint({ now })).r, 'APPROVER_CONTEXT_INVALID');
});

// ---------------------------------------------------------------- cross-tenant
test('tenant: only a member of the requested tenant gets a context, and the tenant is the one requested', async () => {
  const members = new Map([['user-boss', new Set([PW])]]);
  const membership = (identity: { id: string }, ws: string) => members.get(identity.id)?.has(ws) === true;
  const own = await mint({ membership }, { workspace_id: PW });
  assert.equal(((own.r as any).context as ApproverContext).workspace_id, PW);
  const other = await mint({ membership }, { workspace_id: DW });
  refused(other.r, 'APPROVER_NOT_MEMBER');
  assert.equal(other.calls.grants, 0, 'no grants are looked up for a tenant the person does not belong to');
  assert.equal(classify('APPROVER_NOT_MEMBER'), 'refused_tenant');
});

test('tenant: membership must be exactly true; a truthy value, a throw or a hang is not membership', async () => {
  for (const membership of [() => 'true', () => 1, () => ({}), () => [true], () => undefined, () => false, () => { throw new Error(CANARY); }, () => Promise.reject(new Error(CANARY))]) {
    refused((await mint({ membership })).r, 'APPROVER_NOT_MEMBER');
  }
});

test('tenant: the membership source is told the verified id and the tenant, and nothing else', async () => {
  let seen: unknown[] = [];
  await mint({ membership: (...args: unknown[]) => { seen = args; return true; } }, { workspace_id: DW });
  assert.deepEqual(seen, [{ id: 'user-boss' }, DW]);
  assert.ok(Object.isFrozen(seen[0]));
});

// ---------------------------------------------------------------- approval-only scopes
test('scopes: only approval scopes are accepted, so an approver context can never hold an agent scope', async () => {
  const bad: unknown[] = [
    ['processing:run'], ['intake:run'], ['reporting:run'], [SCOPE, 'processing:run'], ['*'], ['approval:decide'], ['approval:decide:'], ['approval:decide:Bad'], ['approval:decide:' + 'x'.repeat(40)],
    ['approval:grant:mock-note'], [SCOPE, SCOPE], [5], [null], 'approval:decide:mock-note', undefined, null, { 0: SCOPE },
    Array.from({ length: 33 }, (_, i) => `approval:decide:tool-${i}`),
  ];
  for (const grants of bad) refused((await mint({ grants: () => grants })).r, 'APPROVER_GRANTS_INVALID');
  refused((await mint({ grants: () => { throw new Error(CANARY); } })).r, 'APPROVER_GRANTS_INVALID');
  refused((await mint({ grants: () => Promise.reject(new Error(CANARY)) })).r, 'APPROVER_GRANTS_INVALID');
  const empty = await mint({ grants: () => [] });
  assert.deepEqual([...((empty.r as any).context as ApproverContext).scopes], [], 'no grants means nothing is allowed');
  const many = await mint({ grants: () => ['approval:decide:a', 'approval:decide:b'] });
  assert.equal(approverCan((many.r as any).context, 'approval:decide:b'), true);
});

// ---------------------------------------------------------------- request and setup
test('request: a malformed request or sources fail closed without throwing or echoing values', async () => {
  const { deps } = sources();
  const garbage: unknown[] = [undefined, null, 5, 'x', [], {}, new Proxy({}, { get() { throw new Error(CANARY); }, ownKeys() { throw new Error(CANARY); } })];
  for (const g of garbage) {
    const a = await mintApproverContext(g as never, deps);
    assert.equal(a.ok, false);
    const b = await mintApproverContext({ credential: 'c', workspace_id: PW }, g as never);
    assert.equal(b.ok, false);
  }
  for (const ws of [undefined, '', 'has space', 5, 'x'.repeat(65)]) refused((await mint({}, { workspace_id: ws })).r, 'APPROVER_CONTEXT_INVALID');
  for (const f of ['verify', 'membership', 'grants', 'newCorrelationId', 'now']) refused((await mint({ [f]: undefined })).r, 'APPROVER_CONTEXT_INVALID');
  for (const corr of [() => '', () => 5, () => 'has space', () => { throw new Error(CANARY); }]) refused((await mint({ newCorrelationId: corr })).r, 'APPROVER_CONTEXT_INVALID');
  for (const t of [0, 60_001, 1.5, '5']) refused((await mint({ timeoutMs: t })).r, 'APPROVER_CONTEXT_INVALID');
});

// ---------------------------------------------------------------- separation from agent contexts
test('separation: an approver context is not an agent context and an agent context is not an approver context', async () => {
  const a = await mint();
  const approverCtx = (a.r as any).context as ApproverContext;
  const m = await mintExecutionContext({ credential: 'c', agent: 'processing' }, {
    verify: () => ({ kind: 'user', id: 'user-boss' }), selectTenant: () => PW, grants: () => [SCOPE, 'processing:run'], newCorrelationId: () => 'corr-agent',
  });
  const agentCtx = (m as { context: ExecutionContext }).context;
  assert.equal(isTrusted(approverCtx), false, 'no agent entry will accept it');
  assert.equal(can(approverCtx, SCOPE), false);
  assert.equal((narrow(approverCtx, { keep_scopes: [] }) as any).error.code, 'CONTEXT_NOT_TRUSTED');
  assert.equal((acceptHandoff(approverCtx, {}) as any).error.code, 'CONTEXT_NOT_TRUSTED');
  assert.equal(isTrustedApprover(agentCtx), false, 'even a human actor holding the approval scope');
  assert.equal(approverCan(agentCtx, SCOPE), false);
  for (const bad of [{ ...approverCtx }, structuredClone(approverCtx), JSON.parse(JSON.stringify(approverCtx)), new Proxy(approverCtx, {}), Object.create(approverCtx), null, undefined, 'ctx']) {
    assert.equal(isTrustedApprover(bad), false);
    assert.equal(approverCan(bad, SCOPE), false);
  }
});

test('separation: each mint is a new context with its own session id', async () => {
  const one = await mint();
  const two = await mint({ newCorrelationId: () => 'corr-approver-2' });
  assert.notEqual((one.r as any).context, (two.r as any).context);
  assert.notEqual((one.r as any).context.correlation_id, (two.r as any).context.correlation_id);
});

// ---------------------------------------------------------------- inventory
test('inventory: nothing in src mints an approver context yet; only approval.ts reads it; the module has no I/O', () => {
  const dir = new URL('../src/', import.meta.url);
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  const text = (f: string) => strip(readFileSync(new URL(f, dir), 'utf8'));
  assert.deepEqual(files.filter((f) => f !== 'approver-context.ts' && /\bmintApproverContext\b/.test(text(f))), [], 'no source file mints an approver context');
  assert.deepEqual(files.filter((f) => f !== 'approver-context.ts' && /\.\/approver-context\.ts/.test(text(f))), ['approval-store-sqlite.ts', 'approval-store.ts', 'approval.ts']);
  const code = text('approver-context.ts');
  for (const m of code.matchAll(/from\s+'([^']+)'/g)) assert.equal(m[1], './contracts.ts');
  assert.ok(!/\b(fetch|process\.env|readFile|writeFile|child_process|mintExecutionContext|Math\.random|Date\.now|new Date\(\)\b)/.test(code.replace(/new Date\(ms\)/g, '')), 'no I/O, no hidden clock');
  // The agent mint is still the only agent-context mint; this module adds no agent.
  assert.ok(!/\bagent\b\s*:/.test(code.split('export interface ApproverContext')[1].split('}')[0]), 'no agent field on the interface');
});
