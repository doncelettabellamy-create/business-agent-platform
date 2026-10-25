// Tests for the Processing mock workflow. Mock provider, mock tools, synthetic data only. No network, no key, no real side effect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createIntakeEntry } from '../src/intake-entry.ts';
import { createTenantRegistry } from '../src/tenant-boundary.ts';
import { mintExecutionContext, narrow } from '../src/execution-context.ts';
import type { AgentName, ExecutionContext } from '../src/execution-context.ts';
import { createProcessingEntry, createToolRegistry, PROCESSING_RUN_SCOPE } from '../src/processing-entry.ts';
import type { ProcessingResult, ToolDefinition } from '../src/processing-entry.ts';
import { createMockNoteTool, MOCK_NOTE_SCOPE } from '../src/mock-tools.ts';
import { CANDIDATE_CONTRACT, validateCandidate } from '../src/candidate-result.ts';
import { sealHandoff } from '../src/handoff-seal.ts';
import type { ObsEvent, Sink } from '../src/observability.ts';
import { classifyAnswer, createMockProvider, extractAnswer } from '../src/mock-provider.ts';

const CANARY = 'CANARY-PROC-5530';
const CLOCK = '2026-10-25T16:00:00Z';
const PW = 'ws-synthetic-plumbing';
const DW = 'ws-synthetic-dental';
const read = (n: string) => JSON.parse(readFileSync(new URL(`../examples/${n}`, import.meta.url), 'utf8'));
const { skill_config: pcfg, ...pmsg } = read('skill-plumbing.json');
const { skill_config: dcfg, ...dmsg } = read('skill-dental.json');

async function mintCtx(tenant: string, agent: AgentName, corr: string, scopes: string[]): Promise<ExecutionContext> {
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
const intake = createIntakeEntry({ registry: createTenantRegistry({ [PW]: pcfg, [DW]: dcfg }), provider: provider(), channelRef: 'channel-proc-test', now: () => CLOCK });

/** A real, sealed handoff produced by the real Intake entry. */
async function handoffFor(tenant: string, message: Record<string, unknown>) {
  const ctx = await mintCtx(tenant, 'intake', 'corr-intake-1', ['intake:run']);
  const r = await intake.run(ctx, message);
  assert.equal(r.ok, true);
  const h = (r as { handoff: unknown }).handoff;
  assert.ok(h !== null);
  return h as Record<string, any>;
}
const proc = (tenant: string, scopes: string[] = [PROCESSING_RUN_SCOPE, MOCK_NOTE_SCOPE], corr = 'corr-proc-1') => mintCtx(tenant, 'processing', corr, scopes);

function setup(over: { sink?: Sink; timeoutMs?: number; defs?: Record<string, ToolDefinition>; plan?: string[] } = {}) {
  const note = createMockNoteTool();
  const tools = createToolRegistry(over.defs ?? { 'mock-note': note });
  const entry = createProcessingEntry({ tools, plan: over.plan ?? ['mock-note'], now: () => CLOCK, ...(over.timeoutMs ? { timeoutMs: over.timeoutMs } : {}), ...(over.sink ? { sink: over.sink } : {}) });
  return { note, entry };
}
function okResult(r: ProcessingResult) {
  assert.equal(r.ok, true, `expected ok, got ${JSON.stringify((r as { error?: unknown }).error)}`);
  return (r as Extract<ProcessingResult, { ok: true }>).candidate;
}
function refused(r: ProcessingResult, code: string) {
  assert.equal(r.ok, false, `expected refusal ${code}`);
  const e = (r as { ok: false; error: { code: string; message: string } }).error;
  assert.equal(e.code, code);
  assert.ok(!e.message.includes('CANARY') && !e.message.includes(PW) && !e.message.includes(DW), 'no value echoed');
}

// ---------------------------------------------------------------- happy path
test('workflow: a real sealed Intake handoff produces a validated candidate_result.v1 with evidence and linked trace ids', async () => {
  const { note, entry } = setup();
  const h = await handoffFor(PW, pmsg);
  const c = okResult(await entry.run(await proc(PW), h));
  assert.deepEqual(validateCandidate(c), []);
  assert.deepEqual([c.contract, c.status, c.workspace_id, c.item_id, c.produced_by, c.created_at], [CANDIDATE_CONTRACT, 'complete', PW, h.item_id, 'processing', CLOCK]);
  assert.equal(c.correlation_id, 'corr-proc-1', 'the Processing run keeps its own minted id');
  assert.equal(c.parent_correlation_id, 'corr-intake-1', 'and links to the Intake run that produced the handoff');
  assert.equal(c.steps.length, 1);
  assert.match(c.steps[0].step_id, /^st-[0-9a-f]{12}$/);
  assert.deepEqual(c.evidence_refs, [`mock-note:${c.steps[0].step_id}`]);
  assert.equal(note.writes.length, 1);
  assert.deepEqual(note.writes[0], { evidence_ref: c.evidence_refs[0], step_id: c.steps[0].step_id, item_id: h.item_id, workspace_id: PW });
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.steps[0]));
  assert.ok(!JSON.stringify(c).match(/Emergency|Address|Burst|ADDRESS_1/), 'no customer text or category in the result');
});

// ---------------------------------------------------------------- forged handoffs
test('forged handoff: hand-built, copied, parsed, proxied, edited and re-wrapped envelopes are all refused, with no tool call', async () => {
  const { note, entry } = setup();
  const ctx = await proc(PW);
  const real = await handoffFor(PW, pmsg);
  const edited = await handoffFor(PW, pmsg);
  edited.payload.category = 'Something else';
  const retargeted = await handoffFor(PW, pmsg);
  retargeted.item_id = 'wi-ffffffffffff';
  const forged: unknown[] = [
    structuredClone(real), JSON.parse(JSON.stringify(real)), { ...real }, Object.create(real), new Proxy(real, {}), edited, retargeted,
    null, undefined, 'x', 5, [], {},
  ];
  for (const f of forged) {
    const r = await entry.run(ctx, f);
    assert.equal(r.ok, false);
    // A proxy cannot even be copied (ENVELOPE_INVALID); everything else copies but is not the sealed object or has changed.
    assert.ok(['HANDOFF_NOT_TRUSTED', 'ENVELOPE_INVALID'].includes((r as { error: { code: string } }).error.code));
    refused(r, (r as { error: { code: string } }).error.code);
  }
  assert.equal(note.calls(), 0);
  // The genuine object still works, so the refusals above are about the forgeries.
  okResult(await entry.run(ctx, real));
  assert.equal(note.calls(), 1);
});

test('forged handoff: a valid-looking envelope sealed by nobody, and a getter that changes after the seal, are refused', async () => {
  const { note, entry } = setup();
  const ctx = await proc(PW);
  const real = await handoffFor(PW, pmsg);
  const handBuilt = structuredClone(real);
  assert.equal(((await entry.run(ctx, handBuilt)) as { error: { code: string } }).error.code, 'HANDOFF_NOT_TRUSTED');
  const flip = await handoffFor(PW, pmsg);
  // A getter added after sealing that shows different content is a change: it is read once, and the copy no longer matches.
  Object.defineProperty(flip, 'evidence_refs', { enumerable: true, get() { return ['forged']; } });
  refused(await entry.run(ctx, flip), 'HANDOFF_NOT_TRUSTED');
  // A getter that returns the sealed content on its one read is the sealed content (nothing was changed).
  const same = await handoffFor(PW, pmsg);
  let reads = 0;
  const original = same.evidence_refs;
  Object.defineProperty(same, 'evidence_refs', { enumerable: true, get() { reads++; return original; } });
  assert.equal((await entry.run(ctx, same)).ok, true);
  assert.equal(reads, 1, 'read exactly once');
  assert.equal(note.calls(), 1);
});

test('forged handoff: an envelope sealed by an unauthorized module is the only way past; the seal function has one importer', () => {
  const dir = new URL('../src/', import.meta.url);
  const importers = readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'handoff-seal.ts'
    && /\bsealHandoff\b/.test(readFileSync(new URL(f, dir), 'utf8').replace(/\/\/.*$/gm, '')));
  assert.deepEqual(importers, ['intake-entry.ts']);
  assert.equal(typeof sealHandoff, 'function');
});

// ---------------------------------------------------------------- authority
test('authority: forged, wrong-agent and look-alike contexts are refused before the envelope is read', async () => {
  const { note, entry } = setup();
  const real = await handoffFor(PW, pmsg);
  const good = await proc(PW);
  let touched = 0;
  const probe = new Proxy({}, { get() { touched++; throw new Error(CANARY); }, ownKeys() { touched++; throw new Error(CANARY); } });
  for (const bad of [{ workspace_id: PW }, { ...good }, structuredClone(good), JSON.parse(JSON.stringify(good)), new Proxy(good, {}), null, undefined, 'ctx']) {
    refused(await entry.run(bad, probe), 'CONTEXT_NOT_TRUSTED');
  }
  refused(await entry.run(await mintCtx(PW, 'intake', 'corr-x', ['intake:run', PROCESSING_RUN_SCOPE, MOCK_NOTE_SCOPE]), real), 'WRONG_RECIPIENT');
  refused(await entry.run(await mintCtx(PW, 'quality-control', 'corr-x', [PROCESSING_RUN_SCOPE, MOCK_NOTE_SCOPE]), real), 'WRONG_RECIPIENT');
  assert.equal(touched, 0);
  assert.equal(note.calls(), 0);
});

test('permissions: processing:run is required, and so is every tool scope; nothing runs on a partial grant', async () => {
  const { note, entry } = setup();
  const real = await handoffFor(PW, pmsg);
  refused(await entry.run(await proc(PW, []), real), 'PROCESSING_NOT_PERMITTED');
  refused(await entry.run(await proc(PW, [MOCK_NOTE_SCOPE]), real), 'PROCESSING_NOT_PERMITTED');
  refused(await entry.run(await proc(PW, [PROCESSING_RUN_SCOPE]), real), 'PROCESSING_NOT_PERMITTED');
  refused(await entry.run(await proc(PW, [PROCESSING_RUN_SCOPE, 'tool:other:write']), real), 'PROCESSING_NOT_PERMITTED');
  refused(await entry.run(await proc(PW, ['PROCESSING:RUN'.toLowerCase() + 'x', MOCK_NOTE_SCOPE]), real), 'PROCESSING_NOT_PERMITTED');
  assert.equal(note.calls(), 0);
  // A two-tool plan with only one tool scope granted runs NEITHER tool.
  const a = createMockNoteTool('tool:a:write'); const b = createMockNoteTool('tool:b:write');
  const two = createProcessingEntry({ tools: createToolRegistry({ a, b }), plan: ['a', 'b'], now: () => CLOCK });
  refused(await two.run(await proc(PW, [PROCESSING_RUN_SCOPE, 'tool:a:write']), real), 'PROCESSING_NOT_PERMITTED');
  assert.deepEqual([a.calls(), b.calls()], [0, 0]);
  okResult(await two.run(await proc(PW, [PROCESSING_RUN_SCOPE, 'tool:a:write', 'tool:b:write']), real));
  assert.deepEqual([a.calls(), b.calls()], [1, 1]);
});

test('permissions: narrowing away a scope turns it off', async () => {
  const { note, entry } = setup();
  const real = await handoffFor(PW, pmsg);
  const full = await proc(PW);
  const n = narrow(full, { keep_scopes: [PROCESSING_RUN_SCOPE] });
  assert.equal(n.ok, true);
  refused(await entry.run((n as { context: ExecutionContext }).context, real), 'PROCESSING_NOT_PERMITTED');
  assert.equal(note.calls(), 0);
});

// ---------------------------------------------------------------- tenant isolation
test('tenant isolation: a handoff for another tenant is refused; each tenant\'s steps and writes are separate', async () => {
  const { note, entry } = setup();
  const hp = await handoffFor(PW, pmsg);
  const hd = await handoffFor(DW, dmsg);
  refused(await entry.run(await proc(DW), hp), 'TENANT_MISMATCH');
  refused(await entry.run(await proc(PW), hd), 'TENANT_MISMATCH');
  assert.equal(note.calls(), 0);
  const a = okResult(await entry.run(await proc(PW, undefined, 'corr-p'), hp));
  const b = okResult(await entry.run(await proc(DW, undefined, 'corr-d'), hd));
  assert.deepEqual([a.workspace_id, b.workspace_id], [PW, DW]);
  assert.notEqual(a.steps[0].step_id, b.steps[0].step_id);
  assert.deepEqual(note.writes.map((w) => w.workspace_id).sort(), [DW, PW]);
  for (const w of note.writes) assert.equal(w.item_id, w.workspace_id === PW ? hp.item_id : hd.item_id);
});

test('tenant isolation: the tool is given the context\'s tenant, never a value from the envelope', async () => {
  const seen: unknown[] = [];
  const { entry } = setup({ defs: { 'mock-note': { scope: MOCK_NOTE_SCOPE, run: (args) => { seen.push(args); return { evidence_ref: 'ev-1' }; } } } });
  const h = await handoffFor(PW, pmsg);
  okResult(await entry.run(await proc(PW), h));
  assert.deepEqual(Object.keys(seen[0] as object).sort(), ['item_id', 'step_id', 'workspace_id']);
  assert.equal((seen[0] as { workspace_id: string }).workspace_id, PW);
  assert.ok(Object.isFrozen(seen[0]));
});

// ---------------------------------------------------------------- duplicates
test('duplicate steps: running the same handoff again, or at the same time, makes one write and returns the same evidence', async () => {
  const { note, entry } = setup();
  const h = await handoffFor(PW, pmsg);
  const ctx = await proc(PW);
  const [x, y] = await Promise.all([entry.run(ctx, h), entry.run(ctx, h)]);
  const z = await entry.run(ctx, h);
  assert.deepEqual([okResult(x).evidence_refs, okResult(y).evidence_refs], [okResult(z).evidence_refs, okResult(z).evidence_refs]);
  assert.equal(note.calls(), 1, 'one tool call in total');
  assert.equal(note.writes.length, 1);
});

test('duplicate steps: a plan that repeats a tool, or names an unknown one, fails at setup', () => {
  const note = createMockNoteTool();
  const tools = createToolRegistry({ 'mock-note': note });
  assert.throws(() => createProcessingEntry({ tools, plan: ['mock-note', 'mock-note'], now: () => CLOCK }), RangeError);
  assert.throws(() => createProcessingEntry({ tools, plan: ['nope'], now: () => CLOCK }), (e: Error) => e instanceof RangeError && !e.message.includes('nope'));
  assert.throws(() => createProcessingEntry({ tools, plan: [], now: () => CLOCK }), RangeError);
});

// ---------------------------------------------------------------- tool failures
test('tool failure: a throwing tool is uncertain, not failed; nothing is retried blindly (see processing-uncertain.test.ts)', async () => {
  let calls = 0;
  const { entry } = setup({ defs: { 'mock-note': { scope: MOCK_NOTE_SCOPE, run: () => { calls++; throw new Error(CANARY); } } } });
  const h = await handoffFor(PW, pmsg);
  const ctx = await proc(PW);
  const c = okResult(await entry.run(ctx, h));
  assert.deepEqual(validateCandidate(c), []);
  assert.deepEqual([c.status, c.steps[0].status, c.steps[0].code, c.evidence_refs], ['uncertain', 'uncertain', 'TOOL_FAILED', []]);
  assert.ok(!JSON.stringify(c).includes('CANARY'));
  const again = okResult(await entry.run(ctx, h));
  assert.deepEqual([again.status, again.steps[0].code, calls], ['uncertain', 'TOOL_FAILED', 1], 'the doubt is remembered and the tool is not called again');
});

test('tool failure: a rejecting, hanging and malformed tool are uncertain with TOOL_FAILED, TOOL_TIMEOUT and TOOL_OUTPUT_INVALID', async () => {
  const h = await handoffFor(PW, pmsg);
  const cases: [string, ToolDefinition['run'], number][] = [
    ['TOOL_FAILED', () => Promise.reject(new Error(CANARY)), 5000],
    ['TOOL_TIMEOUT', () => new Promise(() => {}), 20],
    ['TOOL_OUTPUT_INVALID', () => ({ evidence_ref: `${CANARY} with spaces` }), 5000],
    ['TOOL_OUTPUT_INVALID', () => 'not an object', 5000],
    ['TOOL_OUTPUT_INVALID', () => ({ other: 1 }), 5000],
  ];
  for (const [code, run, timeoutMs] of cases) {
    const { entry } = setup({ defs: { 'mock-note': { scope: MOCK_NOTE_SCOPE, run } }, timeoutMs });
    const c = okResult(await entry.run(await proc(PW), h));
    assert.deepEqual([c.status, c.steps[0].status, c.steps[0].code], ['uncertain', 'uncertain', code]);
    assert.ok(!JSON.stringify(c).includes('CANARY'));
  }
});

test('tool failure: a step that is not ok stops the plan; later steps are skipped and never called', async () => {
  const a = createMockNoteTool('tool:a:write'); const c = createMockNoteTool('tool:c:write');
  const bad: ToolDefinition = { scope: 'tool:b:write', run: () => { throw new Error('x'); } };
  const entry = createProcessingEntry({ tools: createToolRegistry({ a, b: bad, c }), plan: ['a', 'b', 'c'], now: () => CLOCK });
  const res = okResult(await entry.run(await proc(PW, [PROCESSING_RUN_SCOPE, 'tool:a:write', 'tool:b:write', 'tool:c:write']), await handoffFor(PW, pmsg)));
  assert.deepEqual(res.steps.map((s) => s.status), ['ok', 'uncertain', 'skipped']);
  assert.deepEqual(validateCandidate(res), []);
  assert.equal(res.evidence_refs.length, 1);
  assert.equal(c.calls(), 0);
});

test('failures: a bad clock is a refusal before any tool call, and the run never throws', async () => {
  const note = createMockNoteTool();
  const entry = createProcessingEntry({ tools: createToolRegistry({ 'mock-note': note }), plan: ['mock-note'], now: () => 'bad' });
  refused(await entry.run(await proc(PW), await handoffFor(PW, pmsg)), 'PROCESSING_ERROR');
  assert.equal(note.calls(), 0);
});

// ---------------------------------------------------------------- contract
test('candidate_result.v1: the validator rejects incomplete, inconsistent and padded results', async () => {
  const h = await handoffFor(PW, pmsg);
  const good = JSON.parse(JSON.stringify(okResult(await setup().entry.run(await proc(PW), h))));
  assert.deepEqual(validateCandidate(good), []);
  const bad: Record<string, unknown>[] = [
    { ...good, contract: 'candidate_result.v2' }, { ...good, extra: 1 }, { ...good, status: 'failed' }, { ...good, evidence_refs: [] },
    { ...good, evidence_refs: ['other'] }, { ...good, steps: [] }, { ...good, produced_by: 'intake' }, { ...good, created_at: 'now' },
    { ...good, item_id: 'x' }, { ...good, parent_correlation_id: '' },
    { ...good, steps: [{ ...good.steps[0], status: 'failed' }] },
    { ...good, steps: [{ ...good.steps[0], code: 'TOOL_FAILED' }] },
    { ...good, steps: [good.steps[0], good.steps[0]] },
  ];
  for (const b of bad) assert.notDeepEqual(validateCandidate(b), []);
  for (const odd of [null, undefined, 'x', [], 5]) assert.notDeepEqual(validateCandidate(odd), []);
});

test('tool registry: bad names, scopes and definitions fail at setup; membership cannot change later', () => {
  for (const defs of [{}, { 'Bad Name': { scope: 's:a', run: () => 1 } }, { ok: { scope: 'BAD', run: () => 1 } }, { ok: { scope: PROCESSING_RUN_SCOPE, run: () => 1 } },
    { ok: { scope: 's:a' } }, { ok: null }, null] as unknown[]) {
    assert.throws(() => createToolRegistry(defs as never), RangeError);
  }
  const defs: Record<string, ToolDefinition> = { ok: { scope: 'tool:ok:write', run: () => ({ evidence_ref: 'e' }) } };
  const reg = createToolRegistry(defs);
  defs.late = { scope: 'tool:late:write', run: () => ({ evidence_ref: 'e' }) };
  assert.equal(reg.has('late'), false);
  assert.ok(Object.isFrozen(reg) && Object.isFrozen(reg.get('ok')));
  assert.equal(reg.get('__proto__' as string), undefined);
});

// ---------------------------------------------------------------- telemetry
test('telemetry: events are stamped from the Processing context; a failing sink changes nothing', async () => {
  const events: ObsEvent[] = [];
  const { entry } = setup({ sink: { write: (e) => { events.push(e); } } });
  const h = await handoffFor(PW, pmsg);
  const ctx = await proc(PW, undefined, 'corr-proc-t');
  okResult(await entry.run(ctx, h));
  await entry.run(await proc(DW), h);
  await entry.run(await proc(PW, []), h);
  await entry.run(await proc(PW), structuredClone(h));
  await entry.run({ forged: true }, h);
  assert.deepEqual(events.map((e) => [e.event, e.error_code ?? null]), [
    ['run.finished', null], ['handoff.refused', 'TENANT_MISMATCH'], ['run.refused', 'PROCESSING_NOT_PERMITTED'], ['handoff.refused', 'HANDOFF_NOT_TRUSTED'],
  ]);
  assert.deepEqual([events[0].agent, events[0].workspace_id, events[0].correlation_id, events[0].item_id], ['processing', PW, 'corr-proc-t', h.item_id]);
  assert.equal(events[3].failure_class, 'safety_violation');
  assert.ok(!JSON.stringify(events).match(/Emergency|Address|Burst|mock-note|channel-proc/));

  for (const w of [() => { throw new Error(CANARY); }, () => Promise.reject(new Error(CANARY)), () => new Promise(() => {})]) {
    const s = setup({ sink: { write: w } });
    const c = okResult(await s.entry.run(await proc(PW), h));
    assert.equal(c.status, 'complete');
  }
  assert.throws(() => setup({ sink: { write: 'x' } as never }), RangeError);
  await new Promise((r) => setImmediate(r));
});

// ---------------------------------------------------------------- inventory
test('inventory: processing-entry mints nothing, uses no raw runner or boundary function, and touches no I/O', () => {
  const dir = new URL('../src/', import.meta.url);
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const f of ['processing-entry.ts', 'candidate-result.ts', 'mock-tools.ts', 'handoff-seal.ts']) {
    const code = strip(readFileSync(new URL(f, dir), 'utf8'));
    const specs = new Set([...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]));
    for (const s of specs) assert.ok(s.startsWith('./') || s === 'node:crypto', `${f} imports ${s}`);
    assert.ok(!/\b(mintExecutionContext|runIntake|runIntakeWithModel|runIntakeForTenant|runIntakeWithModelForTenant|fetch|process\.env|readFile|writeFile|child_process)\b/.test(code), `${f} touches a forbidden API`);
  }
  assert.ok(!/node:crypto/.test(strip(readFileSync(new URL('mock-tools.ts', dir), 'utf8'))));
});
