// Tests for the trusted execution context. Mock sources only. Synthetic data only. No network, no key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { AGENTS, acceptHandoff, can, isTrusted, mintExecutionContext, narrow } from '../src/execution-context.ts';
import type { ContextDeps, ContextResult, ExecutionContext, Refusal } from '../src/execution-context.ts';
import { runIntake } from '../src/intake-runner.ts';

const CANARY = 'CANARY-SECRET-4471';
const P = 'ws-synthetic-plumbing';
const D = 'ws-synthetic-dental';

type Calls = { verify: unknown[]; select: unknown[]; grants: unknown[]; corr: number };
/** Mock trusted sources that record what they were given. */
function deps(over: Partial<ContextDeps> = {}, tenant = P, scopes: unknown = ['intake:run', 'tool:read', 'tool:write']) {
  const calls: Calls = { verify: [], select: [], grants: [], corr: 0 };
  const d: ContextDeps = {
    verify: (c) => { calls.verify.push(c); return { kind: 'user', id: 'user-synthetic-1' }; },
    selectTenant: (i) => { calls.select.push(i); return tenant; },
    grants: (i, w, a) => { calls.grants.push([i, w, a]); return scopes; },
    newCorrelationId: () => `corr-minted-${++calls.corr}`,
    ...over,
  };
  return { d, calls };
}
const mint = (over: Partial<ContextDeps> = {}, agent: (typeof AGENTS)[number] = 'processing', tenant = P, scopes?: unknown) => {
  const { d, calls } = deps(over, tenant, scopes ?? ['intake:run', 'tool:read', 'tool:write']);
  return mintExecutionContext({ credential: { token: CANARY }, agent }, d).then((r) => ({ r, calls }));
};
function refused(r: { ok: boolean }, code: string, what = ''): Refusal['error'] {
  assert.equal(r.ok, false, `expected a refusal ${what}`);
  const e = (r as Refusal).error;
  assert.equal(e.code, code, what);
  assert.ok(!e.message.includes('CANARY'), 'no value echoed');
  return e;
}
async function ctxOf(tenant = P, agent: (typeof AGENTS)[number] = 'processing', scopes?: unknown): Promise<ExecutionContext> {
  const { r } = await mint({}, agent, tenant, scopes);
  assert.equal(r.ok, true, 'mint should succeed');
  return (r as Extract<ContextResult, { ok: true }>).context;
}

// ---------------------------------------------------------------- minting
test('mint: verify, then select tenant, then grants; the credential reaches only the verifier', async () => {
  const { r, calls } = await mint();
  assert.equal(r.ok, true);
  const c = (r as Extract<ContextResult, { ok: true }>).context;
  assert.deepEqual([c.workspace_id, c.actor, c.agent, c.correlation_id, [...c.scopes]], [P, { kind: 'user', id: 'user-synthetic-1' }, 'processing', 'corr-minted-1', ['intake:run', 'tool:read', 'tool:write']]);
  assert.equal(isTrusted(c), true);
  assert.equal(calls.verify.length, 1);
  assert.ok(!JSON.stringify([calls.select, calls.grants]).includes('CANARY'), 'selector and grants never see the credential');
  assert.deepEqual(calls.grants[0], [{ kind: 'user', id: 'user-synthetic-1' }, P, 'processing']);
});

test('mint: works with asynchronous trusted sources', async () => {
  const { r } = await mint({ verify: async () => ({ kind: 'service', id: 'svc-1' }), selectTenant: async () => D, grants: async () => ['a:b'] });
  assert.equal(r.ok, true);
  assert.equal((r as Extract<ContextResult, { ok: true }>).context.workspace_id, D);
});

test('mint: the tenant comes only from the selector, never from the credential or from fields on the identity', async () => {
  const { r } = await mint({ verify: () => ({ kind: 'user', id: 'user-1', workspace_id: D, tenant: D }) }, 'intake', P);
  assert.equal((r as Extract<ContextResult, { ok: true }>).context.workspace_id, P);
  const { d } = deps({}, P);
  const out = await mintExecutionContext({ credential: { workspace_id: D }, agent: 'intake' }, d);
  assert.equal((out as Extract<ContextResult, { ok: true }>).context.workspace_id, P);
});

test('mint: the correlation id is minted by the platform and two runs get different ones', async () => {
  const { d } = deps();
  const a = (await mintExecutionContext({ credential: 1, agent: 'intake' }, d)) as Extract<ContextResult, { ok: true }>;
  const b = (await mintExecutionContext({ credential: 1, agent: 'intake' }, d)) as Extract<ContextResult, { ok: true }>;
  assert.notEqual(a.context.correlation_id, b.context.correlation_id);
});

// ---------------------------------------------------------------- fail closed
test('mint: an unverified caller is refused and later sources are never called', async () => {
  for (const answer of [undefined, null, 'user', 7, [], {}, { kind: 'user' }, { id: 'u-1' }, { kind: 'admin', id: 'u-1' }, { kind: 'user', id: 'has space' }, { kind: 'user', id: 5 }, { kind: 'user', id: '' }]) {
    const { r, calls } = await mint({ verify: () => answer });
    refused(r, 'UNAUTHENTICATED', JSON.stringify(answer));
    assert.deepEqual([calls.select.length, calls.grants.length], [0, 0]);
  }
});

test('mint: a verifier that throws or rejects is refused without echoing its message', async () => {
  for (const verify of [() => { throw new Error(CANARY); }, async () => { throw new Error(CANARY); }, () => Promise.reject(new Error(CANARY))]) {
    const { r, calls } = await mint({ verify });
    refused(r, 'UNAUTHENTICATED');
    assert.equal(calls.select.length, 0);
  }
});

test('mint: no tenant, several tenants or a bad tenant id is refused and grants are never asked', async () => {
  for (const answer of [undefined, null, '', 'has space', 'x'.repeat(65), 5, [P], [P, D], { workspace_id: P }]) {
    const { r, calls } = await mint({ selectTenant: () => answer });
    refused(r, 'TENANT_NOT_SELECTED', JSON.stringify(answer));
    assert.equal(calls.grants.length, 0);
  }
  for (const selectTenant of [() => { throw new Error(CANARY); }, async () => { throw new Error(CANARY); }]) {
    refused((await mint({ selectTenant })).r, 'TENANT_NOT_SELECTED');
  }
});

test('mint: malformed, duplicated, oversized or throwing grants are refused', async () => {
  const many = Array.from({ length: 65 }, (_, i) => `s:${i}`);
  for (const answer of [undefined, null, 'a:b', { 0: 'a:b', length: 1 }, [1], [null], ['Has Caps'], ['has space'], ['a:b', 'a:b'], [''], many, ['__proto__x y']]) {
    refused((await mint({ grants: () => answer })).r, 'GRANTS_INVALID', JSON.stringify(answer)?.slice(0, 40));
  }
  for (const grants of [() => { throw new Error(CANARY); }, async () => { throw new Error(CANARY); }]) {
    refused((await mint({ grants })).r, 'GRANTS_INVALID');
  }
});

test('mint: a bad correlation id source or agent name is refused', async () => {
  for (const newCorrelationId of [() => '', () => 'has space', () => 5 as never, () => { throw new Error(CANARY); }]) {
    refused((await mint({ newCorrelationId })).r, 'CONTEXT_INVALID');
  }
  const { d, calls } = deps();
  for (const agent of ['Processing', 'admin', '', undefined, 5, '__proto__']) {
    refused(await mintExecutionContext({ credential: 1, agent: agent as never }, d), 'CONTEXT_INVALID', String(agent));
  }
  assert.equal(calls.verify.length, 0, 'a bad agent never reaches the verifier');
  refused(await mintExecutionContext(null as never, d), 'CONTEXT_INVALID');
});

test('mint: answers are read once (getters on the identity and grants cannot switch values)', async () => {
  const reads = { kind: 0, id: 0, g: 0 };
  const identity = { get kind() { reads.kind++; return reads.kind === 1 ? 'user' : 'system'; }, get id() { reads.id++; return reads.id === 1 ? 'user-1' : 'user-2'; } };
  const grants = ['a:b', 'c:d'];
  Object.defineProperty(grants, 0, { get() { reads.g++; return reads.g === 1 ? 'a:b' : 'z:z'; } });
  const { r } = await mint({ verify: () => identity, grants: () => grants });
  const c = (r as Extract<ContextResult, { ok: true }>).context;
  assert.deepEqual([reads.kind, reads.id, reads.g], [1, 1, 1]);
  assert.deepEqual([c.actor.kind, c.actor.id, [...c.scopes]], ['user', 'user-1', ['a:b', 'c:d']]);
});

// ---------------------------------------------------------------- forged or copied authority
test('forged authority: copies, clones, parsed JSON, look-alikes and proxies are not contexts', async () => {
  const c = await ctxOf();
  const lookalike = { workspace_id: P, actor: { kind: 'user', id: 'user-1' }, agent: 'processing', correlation_id: 'corr-1', scopes: ['tool:write'] };
  const copies: unknown[] = [
    lookalike, { ...c }, Object.assign({}, c), structuredClone(c), JSON.parse(JSON.stringify(c)),
    Object.create(c), new Proxy(c, {}), Object.freeze({ ...c }), null, undefined, 'ctx', 5, [],
  ];
  for (const x of copies) {
    assert.equal(isTrusted(x), false);
    assert.equal(can(x, 'tool:write'), false);
    refused(narrow(x, { keep_scopes: [] }), 'CONTEXT_NOT_TRUSTED');
    refused(acceptHandoff(x, {}), 'CONTEXT_NOT_TRUSTED');
  }
  assert.equal(isTrusted(c), true);
});

// ---------------------------------------------------------------- immutability and one tenant
test('immutability: the context, its identity and its scopes cannot be changed; later edits to inputs do not reach it', async () => {
  const granted = ['a:b', 'c:d'];
  const identity = { kind: 'user' as const, id: 'user-1' };
  const { r } = await mint({ verify: () => identity, grants: () => granted });
  const c = (r as Extract<ContextResult, { ok: true }>).context;
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.actor) && Object.isFrozen(c.scopes));
  const m = c as unknown as Record<string, unknown>;
  assert.throws(() => { m.workspace_id = D; }, TypeError);
  assert.throws(() => { m.agent = 'intake'; }, TypeError);
  assert.throws(() => { m.scopes = ['*']; }, TypeError);
  assert.throws(() => { (c.actor as { id: string }).id = 'root'; }, TypeError);
  assert.throws(() => { (c.scopes as string[]).push('admin:all'); }, TypeError);
  assert.throws(() => { delete m.workspace_id; }, TypeError);
  assert.throws(() => { m.extra = 1; }, TypeError);
  granted.push('late:grant'); identity.id = 'someone-else';
  assert.deepEqual([[...c.scopes], c.actor.id], [['a:b', 'c:d'], 'user-1']);
  assert.equal(can(c, 'late:grant'), false);
});

test('one tenant per run: two runs for two tenants stay independent', async () => {
  const a = await ctxOf(P, 'processing', ['x:y', 'z:w']);
  const b = await ctxOf(D, 'processing', ['x:y']);
  assert.deepEqual([a.workspace_id, b.workspace_id], [P, D]);
  const na = narrow(a, { keep_scopes: ['x:y'] }) as Extract<ContextResult, { ok: true }>;
  assert.equal(na.context.workspace_id, P);
  assert.deepEqual([[...a.scopes], [...b.scopes]], [['x:y', 'z:w'], ['x:y']], 'narrowing one leaves the other untouched');
});

// ---------------------------------------------------------------- default deny and narrowing
test('default deny: only an exact granted scope is allowed', async () => {
  const none = await ctxOf(P, 'processing', []);
  const some = await ctxOf(P, 'processing', ['tool:read']);
  for (const s of ['tool:read', 'tool:write', '', '*', 'admin', '__proto__', 'constructor', 'toString']) assert.equal(can(none, s), false, s);
  assert.equal(can(some, 'tool:read'), true);
  for (const s of ['tool:write', 'tool:', 'TOOL:READ', 'tool:read ', undefined, null, 5, ['tool:read'], { toString: () => 'tool:read' }]) assert.equal(can(some, s), false, String(s));
});

test('narrowing: scopes can be dropped but never added; everything else stays the same', async () => {
  const c = await ctxOf(P, 'processing', ['a:b', 'c:d', 'e:f']);
  const n = narrow(c, { keep_scopes: ['c:d', 'a:b'] }) as Extract<ContextResult, { ok: true }>;
  assert.equal(n.ok, true);
  const k = n.context;
  assert.deepEqual([k.workspace_id, k.actor, k.agent, k.correlation_id, [...k.scopes]], [c.workspace_id, c.actor, c.agent, c.correlation_id, ['a:b', 'c:d']]);
  assert.equal(isTrusted(k), true);
  assert.ok(Object.isFrozen(k) && Object.isFrozen(k.scopes));
  assert.deepEqual([...c.scopes], ['a:b', 'c:d', 'e:f'], 'the parent is unchanged');
  assert.equal(can(k, 'e:f'), false);
  const none = narrow(c, { keep_scopes: [] }) as Extract<ContextResult, { ok: true }>;
  assert.deepEqual([none.ok, [...none.context.scopes], can(none.context, 'a:b')], [true, [], false]);
});

test('narrowing: adding a scope, regaining a dropped one, or changing workspace, actor, agent or correlation is refused', async () => {
  const c = await ctxOf(P, 'processing', ['a:b', 'c:d']);
  refused(narrow(c, { keep_scopes: ['a:b', 'new:scope'] }), 'NARROW_ONLY', 'add');
  const child = (narrow(c, { keep_scopes: ['a:b'] }) as Extract<ContextResult, { ok: true }>).context;
  refused(narrow(child, { keep_scopes: ['a:b', 'c:d'] }), 'NARROW_ONLY', 'regain');
  for (const bad of [
    { keep_scopes: ['a:b'], workspace_id: D }, { keep_scopes: ['a:b'], agent: 'intake' }, { keep_scopes: ['a:b'], actor: { kind: 'system', id: 'root' } },
    { keep_scopes: ['a:b'], correlation_id: 'corr-x' }, { keep_scopes: ['a:b'], scopes: ['*'] }, { workspace_id: D }, {},
    { keep_scopes: 'a:b' }, { keep_scopes: [5] }, { keep_scopes: ['a:b', 'a:b'] }, { keep_scopes: ['__proto__'] }, null, 'x', undefined,
  ]) refused(narrow(c, bad as never), 'NARROW_ONLY', JSON.stringify(bad));
});

// ---------------------------------------------------------------- handoff receiver
const plumbing = JSON.parse(readFileSync(new URL('../examples/skill-plumbing.json', import.meta.url), 'utf8'));
function envelope() {
  const r = runIntake(structuredClone(plumbing));
  assert.ok(r.ok && r.handoff, 'fixture must produce a handoff');
  return structuredClone((r as { handoff: unknown }).handoff) as Record<string, any>;
}

test('handoff: the Processing context for the same tenant accepts a valid envelope and gets a private, frozen copy', async () => {
  const c = await ctxOf(P, 'processing');
  const env = envelope();
  const r = acceptHandoff(c, env);
  assert.equal(r.ok, true);
  const got = (r as Extract<typeof r, { ok: true }>).envelope;
  assert.deepEqual(got, env);
  assert.ok(Object.isFrozen(got) && Object.isFrozen(got.payload));
  env.workspace_id = D;                       // later changes to the sender's object do not reach the receiver's copy
  assert.equal(got.workspace_id, P);
});

test('handoff: another tenant, a forged schema-valid envelope, or the wrong recipient is refused', async () => {
  const env = envelope();
  refused(acceptHandoff(await ctxOf(D, 'processing'), env), 'TENANT_MISMATCH');
  const forged = envelope(); forged.workspace_id = D; forged.payload.workspace_id = D;       // schema-valid, but not this tenant
  refused(acceptHandoff(await ctxOf(P, 'processing'), forged), 'TENANT_MISMATCH', 'forged');
  for (const agent of ['intake', 'quality-control', 'reporting'] as const) refused(acceptHandoff(await ctxOf(P, agent), env), 'WRONG_RECIPIENT', agent);
});

test('handoff: invalid envelopes are refused (payload tenant mismatch, needs-human, wrong contract, extra keys, non-objects)', async () => {
  const c = await ctxOf(P, 'processing');
  const bad: unknown[] = [];
  const a = envelope(); a.payload.workspace_id = D; bad.push(a);
  const b = envelope(); b.payload.status = 'needs-human'; bad.push(b);
  const d = envelope(); d.contract = 'work_item.v2'; bad.push(d);
  const e = envelope(); e.scopes = ['*']; bad.push(e);
  const f = envelope(); delete f.correlation_id; bad.push(f);
  bad.push(null, undefined, 'env', 5, [], {});
  for (const x of bad) refused(acceptHandoff(c, x), 'ENVELOPE_INVALID', JSON.stringify(x)?.slice(0, 40));
});

test('handoff: the envelope is read once (a tenant-switching getter or a proxy cannot slip through)', async () => {
  const c = await ctxOf(P, 'processing');
  const env = envelope();
  const state = { reads: 0 };
  const shifty = { ...env };
  delete (shifty as Record<string, unknown>).workspace_id;
  Object.defineProperty(shifty, 'workspace_id', { enumerable: true, get() { return state.reads++ === 0 ? P : D; } });
  const r = acceptHandoff(c, shifty);
  // the payload still names P and the one read gave P, so the copy is consistent and accepted; a second read never happens
  assert.equal(state.reads, 1);
  assert.equal(r.ok, true);
  assert.equal((r as Extract<typeof r, { ok: true }>).envelope.workspace_id, P);
  const flipped = { ...env };
  delete (flipped as Record<string, unknown>).workspace_id;
  const s2 = { reads: 0 };
  Object.defineProperty(flipped, 'workspace_id', { enumerable: true, get() { return s2.reads++ === 0 ? D : P; } });
  refused(acceptHandoff(c, flipped), 'ENVELOPE_INVALID', 'first read disagrees with the payload');
  refused(acceptHandoff(c, new Proxy(env, {})), 'ENVELOPE_INVALID', 'proxy');
});

test('handoff: the envelope grants no authority (acceptance gives the receiver no scopes)', async () => {
  const c = await ctxOf(P, 'processing', []);
  const r = acceptHandoff(c, envelope());
  assert.equal(r.ok, true);
  assert.equal(can(c, 'intake:run'), false);
});

// ---------------------------------------------------------------- bypass inventory and module hygiene
test('bypass inventory: only the known files import the raw runners, and this module imports neither runner nor any I/O API', () => {
  const dir = new URL('../src/', import.meta.url);
  const importers: string[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const text = readFileSync(new URL(f, dir), 'utf8');
    if (/import\s*(?:type\s*)?\{[^}]*\b(runIntake|runIntakeWithModel)\b[^}]*\}\s*from\s*'\.\/intake-runner\.ts'/.test(text)) importers.push(f);
  }
  // cli.ts and demo.ts are local synthetic scripts (deterministic or mock only) that skip the tenant boundary; they are
  // listed on purpose. live-entry.ts no longer calls the raw runners: it goes through live-run.ts and the controlled entry.
  assert.deepEqual(importers.sort(), ['cli.ts', 'demo.ts', 'tenant-boundary.ts']);
  const own = readFileSync(new URL('execution-context.ts', dir), 'utf8');
  assert.ok(!/from\s*'\.\/intake-runner\.ts'/.test(own));
  const code = own.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/node:|\bfetch\b|\bprocess\b|\bconsole\b|\brequire\(|\bimport\(/.test(code), 'no I/O, process or dynamic import');
});
