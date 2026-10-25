// Focused tests: timeouts, throws and unreadable answers are UNCERTAIN, a definitive "not performed" is different, and an
// uncertain action is never tried again blindly. A write that lands late cannot cause a second tool call in the same process.
// Mock provider, mock tools, synthetic data only. No network, no key, no real side effect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createIntakeEntry } from '../src/intake-entry.ts';
import { createTenantRegistry } from '../src/tenant-boundary.ts';
import { mintExecutionContext } from '../src/execution-context.ts';
import type { AgentName, ExecutionContext } from '../src/execution-context.ts';
import { createProcessingEntry, createToolRegistry, PROCESSING_RUN_SCOPE } from '../src/processing-entry.ts';
import type { ProcessingResult, ToolDefinition } from '../src/processing-entry.ts';
import { createDelayedNoteTool, createMockNoteTool, MOCK_NOTE_SCOPE } from '../src/mock-tools.ts';
import { validateCandidate } from '../src/candidate-result.ts';
import { classify } from '../src/observability.ts';
import type { ObsEvent } from '../src/observability.ts';
import { classifyAnswer, createMockProvider, extractAnswer } from '../src/mock-provider.ts';

const CANARY = 'CANARY-UNC-8830';
const CLOCK = '2026-10-25T21:00:00Z';
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
const intake = createIntakeEntry({ registry: createTenantRegistry({ [PW]: pcfg, [DW]: dcfg }), provider: provider(), channelRef: 'channel-unc-test', now: () => CLOCK });
async function handoffFor(tenant: string, message: Record<string, unknown> = pmsg) {
  const r = await intake.run(await mintCtx(tenant, 'intake', 'corr-intake-1', ['intake:run']), message);
  assert.equal(r.ok, true);
  return (r as any).handoff;
}
const proc = (tenant = PW, corr = 'corr-proc-1') => mintCtx(tenant, 'processing', corr, [PROCESSING_RUN_SCOPE, MOCK_NOTE_SCOPE]);
const tick = () => new Promise((r) => setImmediate(r));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function entryFor(def: ToolDefinition, over: { timeoutMs?: number; sink?: { write(e: ObsEvent): void } } = {}) {
  return createProcessingEntry({ tools: createToolRegistry({ 'mock-note': def }), plan: ['mock-note'], now: () => CLOCK, timeoutMs: over.timeoutMs ?? 30, ...(over.sink ? { sink: over.sink } : {}) });
}
function cand(r: ProcessingResult) {
  assert.equal(r.ok, true, JSON.stringify((r as any).error));
  const c = (r as Extract<ProcessingResult, { ok: true }>).candidate;
  assert.deepEqual(validateCandidate(c), []);
  return c;
}
const summary = (c: ReturnType<typeof cand>) => [c.status, c.steps[0].status, c.steps[0].code ?? null];

// ---------------------------------------------------------------- the late write
test('late write: after a timeout the tool is never called again, and a write that lands later is learned, not repeated', async () => {
  const tool = createDelayedNoteTool();
  const entry = entryFor(tool);
  const h = await handoffFor(PW);
  const ctx = await proc();
  const first = cand(await entry.run(ctx, h));
  assert.deepEqual(summary(first), ['uncertain', 'uncertain', 'TOOL_TIMEOUT']);
  assert.equal(tool.calls(), 1);
  assert.equal(tool.signals()[0].aborted, true, 'the abandoned call was told to stop');

  const second = cand(await entry.run(ctx, h));        // retried before the write lands
  assert.deepEqual(summary(second), ['uncertain', 'uncertain', 'TOOL_TIMEOUT']);
  assert.equal(tool.calls(), 1, 'no second call while the first is uncertain');

  tool.land();                                         // the late write arrives
  await tick();
  assert.equal(tool.writes.length, 1);
  const third = cand(await entry.run(ctx, h));         // retried after the write landed
  assert.deepEqual(summary(third), ['complete', 'ok', null]);
  assert.deepEqual(third.evidence_refs, [tool.writes[0].evidence_ref], 'the late evidence is used as it is');
  assert.equal(tool.calls(), 1, 'still one call in total');
  assert.equal(tool.writes.length, 1, 'still one write');
  assert.deepEqual(summary(first), ['uncertain', 'uncertain', 'TOOL_TIMEOUT'], 'an issued candidate is never rewritten');
  assert.ok(Object.isFrozen(first));
});

test('late write: a write that lands while a retry is running cannot start a second call', async () => {
  const tool = createDelayedNoteTool();
  const entry = entryFor(tool);
  const h = await handoffFor(PW);
  const ctx = await proc();
  cand(await entry.run(ctx, h));
  const [retry] = await Promise.all([entry.run(ctx, h), Promise.resolve().then(() => tool.land())]);
  assert.equal(tool.calls(), 1);
  assert.equal(tool.writes.length, 1);
  assert.ok(['uncertain', 'complete'].includes(cand(retry).status), 'the retry saw either the doubt or the landed write, and made no call');
  const after = cand(await entry.run(ctx, h));
  assert.equal(after.status, 'complete');
  assert.equal(tool.calls(), 1);
});

test('late write: many callers at once share the one call and the one timeout; none starts another', async () => {
  const tool = createDelayedNoteTool();
  const entry = entryFor(tool);
  const h = await handoffFor(PW);
  const ctx = await proc();
  const all = await Promise.all(Array.from({ length: 8 }, () => entry.run(ctx, h)));
  for (const r of all) assert.deepEqual(summary(cand(r)), ['uncertain', 'uncertain', 'TOOL_TIMEOUT']);
  assert.equal(tool.calls(), 1);
  tool.land(); await tick();
  assert.equal(tool.writes.length, 1);
});

test('late write: a late "not performed" clears the doubt, so a retry is allowed; a late error changes nothing', async () => {
  const declined = createDelayedNoteTool();
  const entry = entryFor(declined);
  const h = await handoffFor(PW);
  const ctx = await proc();
  assert.equal(cand(await entry.run(ctx, h)).status, 'uncertain');
  declined.decline(); await tick();
  const retry = cand(await entry.run(ctx, h));          // known not to have happened: a retry is not blind
  assert.equal(declined.calls(), 2);
  assert.deepEqual(summary(retry), ['uncertain', 'uncertain', 'TOOL_TIMEOUT'], 'and it can be uncertain again');
  declined.land(); await tick();
  assert.equal(declined.writes.length, 1);
  assert.equal(cand(await entry.run(ctx, h)).status, 'complete');
  assert.equal(declined.calls(), 2);

  const crashed = createDelayedNoteTool();
  const e2 = entryFor(crashed);
  const h2 = await handoffFor(PW, { ...pmsg, event_id: 'evt-synthetic-crash' });
  assert.equal(cand(await e2.run(ctx, h2)).status, 'uncertain');
  crashed.crash(); await tick();
  assert.deepEqual(summary(cand(await e2.run(ctx, h2))), ['uncertain', 'uncertain', 'TOOL_TIMEOUT'], 'a late error does not prove nothing happened');
  assert.equal(crashed.calls(), 1);
});

test('late write: an abandoned call that fails later does not become an unhandled rejection', async () => {
  const seen: unknown[] = [];
  const on = (e: unknown) => { seen.push(e); };
  process.on('unhandledRejection', on);
  try {
    const tool = createDelayedNoteTool();
    const entry = entryFor(tool);
    cand(await entry.run(await proc(), await handoffFor(PW)));
    tool.crash(); await tick(); await tick();
  } finally { process.off('unhandledRejection', on); }
  assert.deepEqual(seen, []);
});

// ---------------------------------------------------------------- uncertain is not failed
test('uncertain outcomes: a throw, a rejection and every unreadable answer are uncertain and are never retried', async () => {
  const cases: [string, ToolDefinition['run'], string][] = [
    ['throw', () => { throw new Error(CANARY); }, 'TOOL_FAILED'],
    ['reject', () => Promise.reject(new Error(CANARY)), 'TOOL_FAILED'],
    ['wrong shape', () => ({ other: 1 }), 'TOOL_OUTPUT_INVALID'],
    ['bad ref', () => ({ evidence_ref: `${CANARY} has spaces` }), 'TOOL_OUTPUT_INVALID'],
    ['string', () => 'done', 'TOOL_OUTPUT_INVALID'],
    ['nothing', () => undefined, 'TOOL_OUTPUT_INVALID'],
    ['not_performed with evidence', () => ({ not_performed: true, evidence_ref: 'mock-note:x' }), 'TOOL_OUTPUT_INVALID'],
    ['not_performed false', () => ({ not_performed: false }), 'TOOL_OUTPUT_INVALID'],
    ['not_performed as text', () => ({ not_performed: 'yes' }), 'TOOL_OUTPUT_INVALID'],
  ];
  for (const [name, run, code] of cases) {
    let calls = 0;
    const entry = entryFor({ scope: MOCK_NOTE_SCOPE, run: (a, s) => { calls++; return run(a, s); } });
    const h = await handoffFor(PW);
    const ctx = await proc();
    for (let i = 0; i < 3; i++) {
      const c = cand(await entry.run(ctx, h));
      assert.deepEqual(summary(c), ['uncertain', 'uncertain', code], `${name} (run ${i + 1})`);
      assert.deepEqual(c.evidence_refs, []);
      assert.ok(!JSON.stringify(c).includes('CANARY'));
    }
    assert.equal(calls, 1, `${name}: one call across three runs`);
  }
});

test('uncertain outcomes: the uncertain step stops the plan and later tools are never called', async () => {
  const first = createDelayedNoteTool('tool:a:write'); const later = createMockNoteTool('tool:c:write');
  const entry = createProcessingEntry({ tools: createToolRegistry({ a: first, c: later }), plan: ['a', 'c'], now: () => CLOCK, timeoutMs: 30 });
  const ctx = await mintCtx(PW, 'processing', 'corr-p', [PROCESSING_RUN_SCOPE, 'tool:a:write', 'tool:c:write']);
  const c = cand(await entry.run(ctx, await handoffFor(PW)));
  assert.deepEqual(c.steps.map((s) => s.status), ['uncertain', 'skipped']);
  assert.equal(c.status, 'uncertain');
  assert.equal(later.calls(), 0);
});

// ---------------------------------------------------------------- definitive non-performance
test('not performed: a tool that says so is a failed step, and only that outcome may be tried again', async () => {
  let calls = 0; let answer: unknown = { not_performed: true };
  const entry = entryFor({ scope: MOCK_NOTE_SCOPE, run: () => { calls++; return answer; } });
  const h = await handoffFor(PW);
  const ctx = await proc();
  const c = cand(await entry.run(ctx, h));
  assert.deepEqual(summary(c), ['failed', 'failed', 'TOOL_NOT_PERFORMED']);
  assert.deepEqual(c.evidence_refs, []);
  answer = { evidence_ref: 'ev-ok' };
  const retried = cand(await entry.run(ctx, h));
  assert.deepEqual(summary(retried), ['complete', 'ok', null]);
  assert.equal(calls, 2, 'the retry was allowed because the first outcome was definitive');
  assert.equal(classify('TOOL_NOT_PERFORMED'), 'dependency_failure');
});

// ---------------------------------------------------------------- scope of the memory
test('isolation: the doubt belongs to one tenant, item and step; other work is not blocked', async () => {
  const stuck = createDelayedNoteTool();
  const entry = entryFor(stuck);
  const ctxP = await proc(PW);
  const ctxD = await proc(DW);
  const hp = await handoffFor(PW); const hd = await handoffFor(DW, dmsg); const other = await handoffFor(PW, { ...pmsg, event_id: 'evt-synthetic-other' });
  cand(await entry.run(ctxP, hp));
  assert.equal(stuck.calls(), 1);
  cand(await entry.run(ctxD, hd));                      // another tenant: its own call
  cand(await entry.run(ctxP, other));                   // another item: its own call
  assert.equal(stuck.calls(), 3);
  cand(await entry.run(ctxP, hp));                      // the same item: still blocked
  assert.equal(stuck.calls(), 3);
});

test('isolation: a restart forgets the doubt, which is why settling an uncertain step for good needs a durable record', async () => {
  const tool = createDelayedNoteTool();
  const h = await handoffFor(PW);
  const ctx = await proc();
  cand(await entryFor(tool).run(ctx, h));
  assert.equal(tool.calls(), 1);
  cand(await entryFor(tool).run(ctx, h));               // a new entry has no memory: this is the documented limit
  assert.equal(tool.calls(), 2);
});

// ---------------------------------------------------------------- contract and telemetry
test('contract: failed means not performed, uncertain means unknown, and the candidate status follows from the steps', async () => {
  const good = JSON.parse(JSON.stringify(cand(await entryFor(createMockNoteTool()).run(await proc(), await handoffFor(PW)))));
  const unc = JSON.parse(JSON.stringify(cand(await entryFor({ scope: MOCK_NOTE_SCOPE, run: () => { throw new Error('x'); } }).run(await proc(), await handoffFor(PW)))));
  const fail = JSON.parse(JSON.stringify(cand(await entryFor({ scope: MOCK_NOTE_SCOPE, run: () => ({ not_performed: true }) }).run(await proc(), await handoffFor(PW)))));
  for (const ok of [good, unc, fail]) assert.deepEqual(validateCandidate(ok), []);
  const step = (c: any, patch: object) => ({ ...c, steps: [{ ...c.steps[0], ...patch }] });
  const bad: any[] = [
    { ...good, status: 'uncertain' }, { ...good, status: 'failed' }, { ...unc, status: 'complete' }, { ...unc, status: 'failed' },
    { ...fail, status: 'uncertain' }, { ...fail, status: 'complete' },
    step(unc, { code: 'TOOL_NOT_PERFORMED' }), step(unc, { code: undefined }), step(unc, { code: 'SOMETHING_ELSE' }), step(unc, { evidence_ref: 'ev-1' }),
    step(fail, { code: 'TOOL_TIMEOUT' }), step(fail, { code: 'TOOL_FAILED' }), step(fail, { evidence_ref: 'ev-1' }),
  ];
  for (const b of bad) assert.notDeepEqual(validateCandidate(b), []);
});

test('telemetry: an uncertain run is reported with its code and class; a failing sink changes nothing', async () => {
  const events: ObsEvent[] = [];
  const tool = createDelayedNoteTool();
  const entry = entryFor(tool, { sink: { write: (e: ObsEvent) => { events.push(e); } } });
  cand(await entry.run(await proc(PW, 'corr-unc-t'), await handoffFor(PW)));
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].event, events[0].error_code, events[0].failure_class, events[0].correlation_id], ['run.finished', 'TOOL_TIMEOUT', 'dependency_failure', 'corr-unc-t']);
  const noisy = entryFor(createDelayedNoteTool(), { sink: { write: () => { throw new Error(CANARY); } } });
  assert.equal(cand(await noisy.run(await proc(), await handoffFor(PW))).status, 'uncertain');
  await wait(1);
});
