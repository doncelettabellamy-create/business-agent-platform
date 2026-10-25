// Tests for sealed candidates, the qc_verdict.v1 contract and the independent QC entry. Mock provider, mock tools and mock
// evidence readers only. Synthetic data only. No network, no key, no real side effect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createIntakeEntry } from '../src/intake-entry.ts';
import { createTenantRegistry } from '../src/tenant-boundary.ts';
import { mintExecutionContext, narrow } from '../src/execution-context.ts';
import type { AgentName, ExecutionContext } from '../src/execution-context.ts';
import { createProcessingEntry, createToolRegistry, PROCESSING_RUN_SCOPE } from '../src/processing-entry.ts';
import type { ToolDefinition } from '../src/processing-entry.ts';
import { createMockNoteTool, MOCK_NOTE_READ_SCOPE, MOCK_NOTE_SCOPE } from '../src/mock-tools.ts';
import type { EvidenceReader } from '../src/mock-tools.ts';
import { createQcEntry, QC_RUN_SCOPE } from '../src/qc-entry.ts';
import type { QcResult } from '../src/qc-entry.ts';
import { QC_CONTRACT, validateVerdict, verdictFor } from '../src/qc-verdict.ts';
import { validateCandidate } from '../src/candidate-result.ts';
import { contentDigest } from '../src/handoff-seal.ts';
import type { ObsEvent } from '../src/observability.ts';
import { classifyAnswer, createMockProvider, extractAnswer } from '../src/mock-provider.ts';

const CANARY = 'CANARY-QC-7712';
const CLOCK = '2026-10-25T17:00:00Z';
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
const intake = createIntakeEntry({ registry: createTenantRegistry({ [PW]: pcfg, [DW]: dcfg }), provider: provider(), channelRef: 'channel-qc-test', now: () => CLOCK });
const qcCtx = (tenant = PW, scopes = [QC_RUN_SCOPE, MOCK_NOTE_READ_SCOPE], corr = 'corr-qc-1') => mintCtx(tenant, 'quality-control', corr, scopes);

async function handoffFor(tenant: string, message: Record<string, unknown>) {
  const r = await intake.run(await mintCtx(tenant, 'intake', 'corr-intake-1', ['intake:run']), message);
  assert.equal(r.ok, true);
  return (r as { handoff: Record<string, any> }).handoff;
}
/** Runs the real Processing entry over a real sealed handoff; returns everything QC needs. */
async function pipeline(tenant = PW, message: Record<string, unknown> = pmsg, def?: ToolDefinition) {
  const note = createMockNoteTool();
  const tool: ToolDefinition = def ?? note;
  const proc = createProcessingEntry({ tools: createToolRegistry({ 'mock-note': tool }), plan: ['mock-note'], now: () => CLOCK });
  const envelope = await handoffFor(tenant, message);
  const r = await proc.run(await mintCtx(tenant, 'processing', 'corr-proc-1', [PROCESSING_RUN_SCOPE, MOCK_NOTE_SCOPE]), envelope);
  assert.equal(r.ok, true);
  return { note, envelope, candidate: (r as { candidate: any }).candidate, reader: note.reader };
}
function qc(reader: EvidenceReader, over: Record<string, unknown> = {}) {
  return createQcEntry({ plan: ['mock-note'], readers: { 'mock-note': reader }, now: () => CLOCK, ...over });
}
function verdictOf(r: QcResult) {
  assert.equal(r.ok, true, `expected a verdict, got ${JSON.stringify((r as { error?: unknown }).error)}`);
  const v = (r as Extract<QcResult, { ok: true }>).verdict;
  assert.deepEqual(validateVerdict(v), []);
  return v;
}
function refused(r: QcResult, code: string) {
  assert.equal(r.ok, false, `expected refusal ${code}`);
  const e = (r as { ok: false; error: { code: string; message: string } }).error;
  assert.equal(e.code, code);
  assert.ok(!e.message.includes('CANARY') && !e.message.includes(PW) && !e.message.includes(DW));
}
const results = (v: { checks: { check: string; result: string; reason?: string }[] }) => Object.fromEntries(v.checks.map((c) => [c.check, c.reason ? `${c.result}:${c.reason}` : c.result]));

// ---------------------------------------------------------------- sealed, handoff-bound candidates
test('candidate: it validates, is frozen, and carries the digest of the exact envelope it was built from', async () => {
  const { candidate, envelope } = await pipeline();
  assert.deepEqual(validateCandidate(candidate), []);
  assert.equal(candidate.handoff_digest, contentDigest(envelope));
  assert.match(candidate.handoff_digest, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(candidate));
});

// ---------------------------------------------------------------- happy path
test('qc: a genuine pipeline result passes every check, with linked trace ids and a digest of the exact candidate', async () => {
  const { candidate, envelope, reader } = await pipeline();
  const v = verdictOf(await qc(reader).run(await qcCtx(), candidate, envelope));
  assert.equal(v.verdict, 'pass');
  assert.deepEqual(results(v), { trace_chain: 'pass', binding: 'pass', plan: 'pass', evidence_exists: 'pass', no_orphans: 'pass', human_approval: 'not_required', action_binding: 'not_required', durable_completion: 'not_required', consistency: 'pass' });
  assert.deepEqual([v.contract, v.workspace_id, v.item_id, v.produced_by, v.created_at], [QC_CONTRACT, PW, envelope.item_id, 'quality-control', CLOCK]);
  assert.equal(v.correlation_id, 'corr-qc-1');
  assert.equal(v.parent_correlation_id, 'corr-proc-1', 'QC -> Processing through the candidate');
  assert.equal(candidate.parent_correlation_id, 'corr-intake-1', 'Processing -> Intake through the envelope');
  assert.equal(v.candidate_digest, contentDigest(candidate));
  assert.ok(Object.isFrozen(v));
  assert.ok(!JSON.stringify(v).match(/Emergency|Address|Burst|ADDRESS_1|mock-note|channel-qc/), 'no content, tool output or channel in the verdict');
});

test('qc: it never edits the candidate or the envelope', async () => {
  const { candidate, envelope, reader } = await pipeline();
  const before = [contentDigest(candidate), contentDigest(envelope)];
  verdictOf(await qc(reader).run(await qcCtx(), candidate, envelope));
  assert.deepEqual([contentDigest(candidate), contentDigest(envelope)], before);
  verdictOf(await qc(reader).run(await qcCtx(), candidate, envelope));   // still the sealed original
});

// ---------------------------------------------------------------- false success claims, missing and orphan evidence
test('false success: a candidate that says "complete" while the tool wrote nothing is sent back for rework (evidence missing)', async () => {
  const liar: ToolDefinition = { scope: MOCK_NOTE_SCOPE, run: () => ({ evidence_ref: 'mock-note:st-000000000000' }) };
  const { candidate, envelope } = await pipeline(PW, pmsg, liar);
  assert.equal(candidate.status, 'complete', 'Processing believed the tool');
  const real = createMockNoteTool();
  const v = verdictOf(await qc(real.reader).run(await qcCtx(), candidate, envelope));
  assert.equal(v.verdict, 'rework');
  assert.deepEqual(results(v), { trace_chain: 'pass', binding: 'pass', plan: 'pass', evidence_exists: 'fail:MISSING', no_orphans: 'pass', human_approval: 'not_required', action_binding: 'not_required', durable_completion: 'not_required', consistency: 'pass' });
});

test('false success: a tool that points at a real record belonging to another item is caught as a mismatch', async () => {
  const note = createMockNoteTool();
  const otherEnvelope = await handoffFor(PW, { ...pmsg, event_id: 'evt-synthetic-other-item' });
  const otherProc = createProcessingEntry({ tools: createToolRegistry({ 'mock-note': note }), plan: ['mock-note'], now: () => CLOCK });
  const other = await otherProc.run(await mintCtx(PW, 'processing', 'corr-proc-x', [PROCESSING_RUN_SCOPE, MOCK_NOTE_SCOPE]), otherEnvelope);
  const stolenRef = (other as any).candidate.evidence_refs[0];
  const liar: ToolDefinition = { scope: MOCK_NOTE_SCOPE, run: () => ({ evidence_ref: stolenRef }) };
  const { candidate, envelope } = await pipeline(PW, pmsg, liar);
  const v = verdictOf(await qc(note.reader).run(await qcCtx(), candidate, envelope));
  assert.equal(v.verdict, 'rework');
  assert.equal(results(v).evidence_exists, 'fail:MISMATCH');
});

test('orphan evidence: a tool-side write the candidate does not mention is flagged, even though the candidate looks fine', async () => {
  const { note, candidate, envelope, reader } = await pipeline();
  await note.run({ step_id: 'st-aaaaaaaaaaaa', item_id: envelope.item_id, workspace_id: PW }, new AbortController().signal);
  const v = verdictOf(await qc(reader).run(await qcCtx(), candidate, envelope));
  assert.equal(v.verdict, 'rework');
  assert.deepEqual(results(v), { trace_chain: 'pass', binding: 'pass', plan: 'pass', evidence_exists: 'pass', no_orphans: 'fail:ORPHAN', human_approval: 'not_required', action_binding: 'not_required', durable_completion: 'not_required', consistency: 'pass' });
});

test('plan: QC compares the candidate with its own expected plan, so a shorter or different plan fails', async () => {
  const { candidate, envelope, reader } = await pipeline();
  const other = createMockNoteTool('tool:other:write', 'tool:other:read');
  const q = createQcEntry({ plan: ['other'], readers: { other: other.reader }, now: () => CLOCK });
  const v = verdictOf(await q.run(await qcCtx(PW, [QC_RUN_SCOPE, 'tool:other:read']), candidate, envelope));
  assert.equal(v.verdict, 'rework');
  assert.equal(results(v).plan, 'fail:MISMATCH');
  void reader;
});

test('honest failure: a tool that says it did not perform the action is sent back for rework, not passed', async () => {
  const none: ToolDefinition = { scope: MOCK_NOTE_SCOPE, run: () => ({ not_performed: true }) };
  const { candidate, envelope } = await pipeline(PW, pmsg, none);
  assert.deepEqual([candidate.status, candidate.steps[0].status, candidate.steps[0].code], ['failed', 'failed', 'TOOL_NOT_PERFORMED']);
  const v = verdictOf(await qc(createMockNoteTool().reader).run(await qcCtx(), candidate, envelope));
  assert.equal(v.verdict, 'rework');
  assert.equal(results(v).consistency, 'fail:CANDIDATE_FAILED');
});

test('uncertain outcome: a tool that threw cannot be judged from the candidate, so QC escalates instead of passing or reworking', async () => {
  const bad: ToolDefinition = { scope: MOCK_NOTE_SCOPE, run: () => { throw new Error(CANARY); } };
  const { candidate, envelope } = await pipeline(PW, pmsg, bad);
  assert.deepEqual([candidate.status, candidate.steps[0].status], ['uncertain', 'uncertain']);
  const v = verdictOf(await qc(createMockNoteTool().reader).run(await qcCtx(), candidate, envelope));
  assert.equal(v.verdict, 'escalate');
  assert.equal(results(v).consistency, 'unverifiable:CANDIDATE_UNCERTAIN');
  assert.ok(!JSON.stringify(v).includes('CANARY'));
});

// ---------------------------------------------------------------- forged results and trace
test('forged results: copies, edits, JSON, proxies and hand-built twins of the candidate or envelope are refused, with no verdict and no read', async () => {
  const { candidate, envelope, reader } = await pipeline();
  let reads = 0;
  const counting: EvidenceReader = { scope: reader.scope, read: (c, r) => { reads++; return reader.read(c, r); }, list: (c, i) => { reads++; return reader.list(c, i); } };
  const q = qc(counting);
  const ctx = await qcCtx();
  const bad = [structuredClone(candidate), JSON.parse(JSON.stringify(candidate)), { ...candidate }, Object.create(candidate), new Proxy(candidate, {}),
    { ...structuredClone(candidate), status: 'complete', evidence_refs: ['mock-note:st-000000000000'] }, null, undefined, 'x', 5, [], {}];
  for (const f of bad) {
    const r = await q.run(ctx, f, envelope);
    assert.equal(r.ok, false);
    assert.ok(['CANDIDATE_NOT_TRUSTED', 'CANDIDATE_INVALID'].includes((r as any).error.code));
  }
  for (const f of [structuredClone(envelope), JSON.parse(JSON.stringify(envelope)), { ...envelope }, null, undefined, 'x']) {
    const r = await q.run(ctx, candidate, f);
    assert.equal(r.ok, false);
    assert.ok(['HANDOFF_NOT_TRUSTED', 'ENVELOPE_INVALID'].includes((r as any).error.code));
  }
  assert.equal(reads, 0);
  verdictOf(await q.run(ctx, candidate, envelope));
});

test('trace and binding: a genuine candidate paired with a different genuine envelope fails; QC reusing Processing\'s correlation id fails', async () => {
  const { candidate, envelope, reader } = await pipeline();
  const otherEnvelope = await handoffFor(PW, { ...pmsg, event_id: 'evt-synthetic-other-item' });
  const v = verdictOf(await qc(reader).run(await qcCtx(), candidate, otherEnvelope));
  assert.equal(v.verdict, 'rework');
  assert.equal(results(v).binding, 'fail:MISMATCH');
  assert.equal(results(v).trace_chain, 'fail:MISMATCH');
  const same = verdictOf(await qc(reader).run(await qcCtx(PW, undefined, 'corr-proc-1'), candidate, envelope));
  assert.equal(results(same).trace_chain, 'fail:MISMATCH');
  assert.equal(same.verdict, 'rework');
});

// ---------------------------------------------------------------- tenant isolation
test('tenant isolation: a QC context for another tenant, or an envelope from another tenant, is refused', async () => {
  const plumbing = await pipeline(PW, pmsg);
  const dental = await pipeline(DW, dmsg);
  refused(await qc(plumbing.reader).run(await qcCtx(DW), plumbing.candidate, plumbing.envelope), 'TENANT_MISMATCH');
  refused(await qc(plumbing.reader).run(await qcCtx(PW), plumbing.candidate, dental.envelope), 'TENANT_MISMATCH');
  refused(await qc(dental.reader).run(await qcCtx(PW), dental.candidate, dental.envelope), 'TENANT_MISMATCH');
});

test('tenant isolation: the reader answers only for the context\'s tenant, and a missing record looks the same as another tenant\'s', async () => {
  const note = createMockNoteTool();
  const proc = createProcessingEntry({ tools: createToolRegistry({ 'mock-note': note }), plan: ['mock-note'], now: () => CLOCK });
  const hp = await handoffFor(PW, pmsg);
  const hd = await handoffFor(DW, dmsg);
  const cp = (await proc.run(await mintCtx(PW, 'processing', 'corr-p', [PROCESSING_RUN_SCOPE, MOCK_NOTE_SCOPE]), hp) as any).candidate;
  const cd = (await proc.run(await mintCtx(DW, 'processing', 'corr-d', [PROCESSING_RUN_SCOPE, MOCK_NOTE_SCOPE]), hd) as any).candidate;
  const p = await qcCtx(PW); const d = await qcCtx(DW);
  assert.equal((await note.reader.read(p, cp.evidence_refs[0]))?.workspace_id, PW);
  assert.equal(await note.reader.read(d, cp.evidence_refs[0]), undefined, 'another tenant\'s record is not found');
  assert.equal(await note.reader.read(d, 'mock-note:st-nope00000000'), undefined, 'indistinguishable from a record that does not exist');
  assert.deepEqual(await note.reader.list(d, hp.item_id), []);
  assert.equal((await note.reader.list(p, hp.item_id)).length, 1);
  assert.equal((await note.reader.list(d, hd.item_id)).length, 1);
  const q = qc(note.reader);
  assert.equal(verdictOf(await q.run(p, cp, hp)).verdict, 'pass');
  assert.equal(verdictOf(await q.run(d, cd, hd)).verdict, 'pass');
});

test('reader: it rejects an untrusted context and a context without its read scope; it cannot write', async () => {
  const { reader, candidate } = await pipeline();
  const ref = candidate.evidence_refs[0];
  for (const bad of [{ workspace_id: PW }, null, undefined, 'ctx', await qcCtx(PW, [QC_RUN_SCOPE]), await mintCtx(PW, 'processing', 'c', [MOCK_NOTE_SCOPE])]) {
    await assert.rejects(reader.read(bad, ref));
    await assert.rejects(reader.list(bad, 'wi-000000000000'));
  }
  assert.deepEqual(Object.keys(reader).sort(), ['list', 'read', 'scope']);
  assert.ok(Object.isFrozen(reader));
});

// ---------------------------------------------------------------- authority
test('authority: forged and wrong-agent contexts and missing scopes are refused before any input is read or evidence is read', async () => {
  const { candidate, envelope, reader } = await pipeline();
  let reads = 0;
  const counting: EvidenceReader = { scope: reader.scope, read: (c, r) => { reads++; return reader.read(c, r); }, list: (c, i) => { reads++; return reader.list(c, i); } };
  const q = qc(counting);
  let touched = 0;
  const probe = new Proxy({}, { get() { touched++; throw new Error(CANARY); }, ownKeys() { touched++; throw new Error(CANARY); } });
  const good = await qcCtx();
  for (const bad of [{ workspace_id: PW }, { ...good }, structuredClone(good), new Proxy(good, {}), null, undefined, 'ctx']) refused(await q.run(bad, probe, probe), 'CONTEXT_NOT_TRUSTED');
  refused(await q.run(await mintCtx(PW, 'processing', 'c', [QC_RUN_SCOPE, MOCK_NOTE_READ_SCOPE]), probe, probe), 'WRONG_RECIPIENT');
  refused(await q.run(await qcCtx(PW, [MOCK_NOTE_READ_SCOPE]), probe, probe), 'QC_NOT_PERMITTED');
  refused(await q.run(await qcCtx(PW, [QC_RUN_SCOPE]), probe, probe), 'QC_NOT_PERMITTED');
  refused(await q.run(await qcCtx(PW, []), probe, probe), 'QC_NOT_PERMITTED');
  const narrowed = narrow(good, { keep_scopes: [QC_RUN_SCOPE] });
  refused(await q.run((narrowed as { context: ExecutionContext }).context, candidate, envelope), 'QC_NOT_PERMITTED');
  assert.equal(touched, 0);
  assert.equal(reads, 0);
});

// ---------------------------------------------------------------- failing readers
test('failing readers: a throwing, rejecting, hanging or garbage reader gives unverifiable checks and escalation, never a pass', async () => {
  const { candidate, envelope, reader } = await pipeline();
  const hang = () => new Promise<never>(() => {});
  const makers: [string, Partial<EvidenceReader>][] = [
    ['throw', { read: () => { throw new Error(CANARY); }, list: () => { throw new Error(CANARY); } }],
    ['reject', { read: () => Promise.reject(new Error(CANARY)), list: () => Promise.reject(new Error(CANARY)) }],
    ['hang', { read: hang, list: hang }],
    ['garbage', { read: (async () => 'not a record') as never, list: (async () => 'not a list') as never }],
    ['bad-record', { read: (async () => ({ evidence_ref: 1 })) as never, list: (async () => [{ nope: true }]) as never }],
  ];
  for (const [name, over] of makers) {
    const bad: EvidenceReader = { scope: reader.scope, read: reader.read, list: reader.list, ...over };
    const v = verdictOf(await qc(bad, { timeoutMs: 20 }).run(await qcCtx(), candidate, envelope));
    assert.equal(v.verdict, 'escalate', name);
    assert.deepEqual([results(v).evidence_exists, results(v).no_orphans], ['unverifiable:READ_FAILED', 'unverifiable:READ_FAILED'], name);
    assert.ok(!JSON.stringify(v).includes('CANARY'));
  }
  // One good check and one failed read: still escalate, not pass.
  const half: EvidenceReader = { scope: reader.scope, read: reader.read, list: () => Promise.reject(new Error('x')) };
  assert.equal(verdictOf(await qc(half).run(await qcCtx(), candidate, envelope)).verdict, 'escalate');
});

test('failing readers: a reader that reports another tenant\'s record is a mismatch, not evidence', async () => {
  const { candidate, envelope, reader } = await pipeline();
  const ref = candidate.evidence_refs[0];
  const stepId = candidate.steps[0].step_id;
  const wrong: EvidenceReader = {
    scope: reader.scope,
    read: async () => ({ evidence_ref: ref, step_id: stepId, item_id: envelope.item_id, workspace_id: DW }),
    list: async () => [{ evidence_ref: ref, step_id: stepId, item_id: envelope.item_id, workspace_id: DW }],
  };
  const v = verdictOf(await qc(wrong).run(await qcCtx(), candidate, envelope));
  assert.equal(v.verdict, 'rework');
  assert.deepEqual([results(v).evidence_exists, results(v).no_orphans], ['fail:MISMATCH', 'fail:MISMATCH']);
});

// ---------------------------------------------------------------- contract
test('qc_verdict.v1: the validator rejects inconsistent, padded and incomplete verdicts; the verdict follows from the checks', async () => {
  const { candidate, envelope, reader } = await pipeline();
  const good = JSON.parse(JSON.stringify(verdictOf(await qc(reader).run(await qcCtx(), candidate, envelope))));
  assert.deepEqual(validateVerdict(good), []);
  const bad: Record<string, unknown>[] = [
    { ...good, contract: 'qc_verdict.v2' }, { ...good, extra: 1 }, { ...good, verdict: 'rework' }, { ...good, verdict: 'allow' }, { ...good, checks: [] },
    { ...good, checks: good.checks.slice(1) }, { ...good, checks: [...good.checks].reverse() }, { ...good, produced_by: 'processing' },
    { ...good, candidate_digest: 'abc' }, { ...good, item_id: 'x' }, { ...good, created_at: 'now' }, { ...good, parent_correlation_id: '' },
    { ...good, checks: good.checks.map((c: any, i: number) => (i === 0 ? { ...c, result: 'fail' } : c)) },
    { ...good, checks: good.checks.map((c: any, i: number) => (i === 0 ? { ...c, reason: 'MISSING' } : c)) },
  ];
  for (const b of bad) assert.notDeepEqual(validateVerdict(b), []);
  for (const odd of [null, undefined, 'x', [], 5]) assert.notDeepEqual(validateVerdict(odd), []);
  assert.equal(verdictFor([{ result: 'pass' }, { result: 'unverifiable' }, { result: 'fail' }]), 'escalate');
  assert.equal(verdictFor([{ result: 'pass' }, { result: 'fail' }]), 'rework');
  assert.equal(verdictFor([]), 'escalate', 'an empty set of checks is never a pass');
});

test('setup: a missing reader, repeated plan, bad timeout or bad sink fails at startup without echoing values', async () => {
  const { reader } = await pipeline();
  const bad: [string, () => unknown][] = [
    ['no reader', () => createQcEntry({ plan: ['mock-note'], readers: {}, now: () => CLOCK })],
    ['bad reader', () => createQcEntry({ plan: ['mock-note'], readers: { 'mock-note': { scope: 's' } as never }, now: () => CLOCK })],
    ['repeat', () => createQcEntry({ plan: ['mock-note', 'mock-note'], readers: { 'mock-note': reader }, now: () => CLOCK })],
    ['empty', () => createQcEntry({ plan: [], readers: {}, now: () => CLOCK })],
    ['no clock', () => createQcEntry({ plan: ['mock-note'], readers: { 'mock-note': reader } } as never)],
    ['timeout', () => qc(reader, { timeoutMs: 0 })],
    ['sink', () => qc(reader, { sink: { write: CANARY } })],
  ];
  for (const [name, fn] of bad) assert.throws(fn, (e: Error) => e instanceof RangeError && !e.message.includes('CANARY'), name);
});

// ---------------------------------------------------------------- telemetry
test('telemetry: QC events are stamped from the QC context; a failing sink changes nothing', async () => {
  const { candidate, envelope, reader } = await pipeline();
  const events: ObsEvent[] = [];
  const q = qc(reader, { sink: { write: (e: ObsEvent) => { events.push(e); } } });
  await q.run(await qcCtx(PW, undefined, 'corr-qc-t'), candidate, envelope);
  await q.run(await qcCtx(PW, [QC_RUN_SCOPE]), candidate, envelope);
  await q.run(await qcCtx(PW), structuredClone(candidate), envelope);
  await q.run({ forged: true }, candidate, envelope);
  assert.deepEqual(events.map((e) => [e.event, e.error_code ?? null]), [['run.finished', null], ['run.refused', 'QC_NOT_PERMITTED'], ['handoff.refused', 'CANDIDATE_NOT_TRUSTED']]);
  assert.deepEqual([events[0].agent, events[0].workspace_id, events[0].correlation_id, events[0].item_id], ['quality-control', PW, 'corr-qc-t', envelope.item_id]);
  assert.equal(events[2].failure_class, 'safety_violation');
  assert.ok(!JSON.stringify(events).match(/Emergency|Address|Burst|mock-note|channel-qc/));
  for (const w of [() => { throw new Error(CANARY); }, () => Promise.reject(new Error(CANARY)), () => new Promise(() => {})]) {
    assert.equal(verdictOf(await qc(reader, { sink: { write: w } }).run(await qcCtx(), candidate, envelope)).verdict, 'pass');
  }
  await new Promise((r) => setImmediate(r));
});

// ---------------------------------------------------------------- inventory
test('inventory: only the right modules seal, QC mints and runs nothing, and the tool store is not reachable from the registry', async () => {
  const dir = new URL('../src/', import.meta.url);
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  const using = (name: string) => files.filter((f) => f !== 'handoff-seal.ts' && new RegExp(`\\b${name}\\b`).test(strip(readFileSync(new URL(f, dir), 'utf8'))));
  assert.deepEqual(using('sealHandoff'), ['intake-entry.ts']);
  assert.deepEqual(using('sealCandidate'), ['processing-entry.ts']);
  for (const f of ['qc-entry.ts', 'qc-verdict.ts']) {
    const code = strip(readFileSync(new URL(f, dir), 'utf8'));
    const specs = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const s of specs) assert.ok(s.startsWith('./'), `${f} imports ${s}`);
    assert.ok(!/\b(mintExecutionContext|runIntake|runIntakeWithModel|createProcessingEntry|createIntakeEntry|sealCandidate|sealHandoff|fetch|process\.env|readFile|writeFile|child_process)\b/.test(code), `${f} uses a forbidden name`);
    assert.ok(!/from\s+'\.\/(processing-entry|intake-entry|tenant-boundary|live-run)\.ts'/.test(code), `${f} imports a producer`);
  }
  // The registry hands Processing only name, scope and run: the reader and the test hooks are not on it.
  const note = createMockNoteTool();
  const tool = createToolRegistry({ 'mock-note': note }).get('mock-note') as object;
  assert.deepEqual(Object.keys(tool).sort(), ['name', 'run', 'scope']);
});
