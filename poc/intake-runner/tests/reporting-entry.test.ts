// Tests for sealed QC verdicts and the Reporting entry (report.v1). Mock provider, mock tools and readers, synthetic data only.
// No network, no key, no real side effect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createIntakeEntry } from '../src/intake-entry.ts';
import { createTenantRegistry } from '../src/tenant-boundary.ts';
import { mintExecutionContext } from '../src/execution-context.ts';
import type { AgentName, ExecutionContext } from '../src/execution-context.ts';
import { createProcessingEntry, createToolRegistry, PROCESSING_RUN_SCOPE } from '../src/processing-entry.ts';
import type { ToolDefinition } from '../src/processing-entry.ts';
import { createMockNoteTool, MOCK_NOTE_READ_SCOPE, MOCK_NOTE_SCOPE } from '../src/mock-tools.ts';
import type { EvidenceReader } from '../src/mock-tools.ts';
import { createQcEntry, QC_RUN_SCOPE } from '../src/qc-entry.ts';
import { createReportingEntry, REPORTING_RUN_SCOPE } from '../src/reporting-entry.ts';
import type { ReportResult, SubmitResult } from '../src/reporting-entry.ts';
import { NOT_MEASURED, validateReport } from '../src/report.ts';
import { validateVerdict } from '../src/qc-verdict.ts';
import type { ObsEvent } from '../src/observability.ts';
import { classifyAnswer, createMockProvider, extractAnswer } from '../src/mock-provider.ts';

const CANARY = 'CANARY-RPT-9031';
const CLOCK = '2026-10-25T18:00:00Z';
const PW = 'ws-synthetic-plumbing';
const DW = 'ws-synthetic-dental';
const read = (n: string) => JSON.parse(readFileSync(new URL(`../examples/${n}`, import.meta.url), 'utf8'));
const { skill_config: pcfg, ...pmsg } = read('skill-plumbing.json');
const { skill_config: dcfg, ...dmsg } = read('skill-dental.json');

let seq = 0;
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
const intake = createIntakeEntry({ registry: createTenantRegistry({ [PW]: pcfg, [DW]: dcfg }), provider: provider(), channelRef: 'channel-rpt-test', now: () => CLOCK });
const rptCtx = (tenant = PW, scopes = [REPORTING_RUN_SCOPE], corr = 'corr-rpt-1') => mintCtx(tenant, 'reporting', corr, scopes);

interface Chain { envelope: any; candidate: any; verdict: any; triple: { envelope: any; candidate: any; verdict: any } }
/** One real Intake -> Processing -> QC run. Options let a test make the chain fail in a chosen way. */
async function chain(tenant = PW, message: Record<string, unknown> = pmsg, o: { def?: ToolDefinition; reader?: EvidenceReader; envelope?: any; intakeCorr?: string; procCorr?: string; qcCorr?: string } = {}): Promise<Chain> {
  const n = ++seq;
  const note = createMockNoteTool();
  const proc = createProcessingEntry({ tools: createToolRegistry({ 'mock-note': o.def ?? note }), plan: ['mock-note'], now: () => CLOCK });
  let envelope = o.envelope;
  if (!envelope) {
    const r = await intake.run(await mintCtx(tenant, 'intake', o.intakeCorr ?? `corr-intake-${n}`, ['intake:run']), message);
    assert.equal(r.ok, true);
    envelope = (r as any).handoff;
  }
  const pr = await proc.run(await mintCtx(tenant, 'processing', o.procCorr ?? `corr-proc-${n}`, [PROCESSING_RUN_SCOPE, MOCK_NOTE_SCOPE]), envelope);
  assert.equal(pr.ok, true);
  const candidate = (pr as any).candidate;
  const qc = createQcEntry({ plan: ['mock-note'], readers: { 'mock-note': o.reader ?? note.reader }, now: () => CLOCK, timeoutMs: 50 });
  const qr = await qc.run(await mintCtx(tenant, 'quality-control', o.qcCorr ?? `corr-qc-${n}`, [QC_RUN_SCOPE, MOCK_NOTE_READ_SCOPE]), candidate, envelope);
  assert.equal(qr.ok, true);
  const verdict = (qr as any).verdict;
  return { envelope, candidate, verdict, triple: { envelope, candidate, verdict } };
}
const reporting = (over: Record<string, unknown> = {}) => createReportingEntry({ now: () => CLOCK, ...over });
function submitted(r: SubmitResult) { assert.equal(r.ok, true, `expected ok, got ${JSON.stringify((r as any).error)}`); return r as Extract<SubmitResult, { ok: true }>; }
function reportOf(r: ReportResult) {
  assert.equal(r.ok, true, `expected a report, got ${JSON.stringify((r as any).error)}`);
  const rep = (r as Extract<ReportResult, { ok: true }>).report;
  assert.deepEqual(validateReport(rep), []);
  return rep;
}
function refused(r: { ok: boolean }, code: string) {
  assert.equal(r.ok, false, `expected refusal ${code}`);
  const e = (r as any).error;
  assert.equal(e.code, code);
  assert.ok(!e.message.includes('CANARY') && !e.message.includes(PW) && !e.message.includes(DW));
}

// ---------------------------------------------------------------- sealed verdicts
test('verdict: the QC entry seals what it issues; the verdict is valid, frozen and bound to the candidate', async () => {
  const c = await chain();
  assert.deepEqual(validateVerdict(c.verdict), []);
  assert.equal(c.verdict.verdict, 'pass');
  assert.ok(Object.isFrozen(c.verdict));
});

// ---------------------------------------------------------------- happy path and counts
test('report: a genuine pass is a verified simulated pass, labelled as simulation, with linked ids and the unmeasured list', async () => {
  const r = reporting(); const ctx = await rptCtx();
  const c = await chain();
  const s = submitted(await r.submit(ctx, [c.triple]));
  assert.deepEqual([s.submitted, s.accepted, s.duplicates, s.repeat_attempts, s.refused], [1, 1, 0, 0, 0]);
  const rep = reportOf(await r.report(ctx));
  assert.deepEqual([rep.contract, rep.workspace_id, rep.produced_by, rep.basis, rep.created_at, rep.correlation_id], ['report.v1', PW, 'reporting', 'verified-simulation', CLOCK, 'corr-rpt-1']);
  assert.deepEqual(rep.counts, { submitted: 1, counted_items: 1, verified_simulated_pass: 1, rework: 0, escalate: 0, chain_conflict: 0, refused: 0, duplicates: 0, repeat_attempts: 0 });
  assert.deepEqual(rep.chains, [{ item_id: c.envelope.item_id, outcome: 'pass', intake_correlation_id: c.envelope.correlation_id, processing_correlation_id: c.candidate.correlation_id, qc_correlation_id: c.verdict.correlation_id }]);
  assert.deepEqual([rep.exceptions, rep.refusals, rep.lists_truncated], [[], [], false]);
  assert.deepEqual(rep.not_measured, [...NOT_MEASURED]);
  assert.ok(Object.isFrozen(rep));
});

test('missing measurements: an empty report is zero counts plus an explicit not-measured list, never a claim of completeness', async () => {
  const r = reporting(); const ctx = await rptCtx();
  const rep = reportOf(await r.report(ctx));
  assert.equal(rep.counts.submitted, 0);
  assert.deepEqual(rep.not_measured, ['intake_needs_human', 'inputs_never_submitted', 'real_effects']);
  const tampered = JSON.parse(JSON.stringify(rep));
  tampered.not_measured = [];
  assert.notDeepEqual(validateReport(tampered), []);
  tampered.not_measured = ['real_effects'];
  assert.notDeepEqual(validateReport(tampered), []);
});

test('exceptions: rework, escalate and a failed candidate are listed with check names and reasons, never counted as passes', async () => {
  const liar: ToolDefinition = { scope: MOCK_NOTE_SCOPE, run: () => ({ evidence_ref: 'mock-note:st-000000000000' }) };
  const bad: ToolDefinition = { scope: MOCK_NOTE_SCOPE, run: () => ({ not_performed: true }) };
  const empty = createMockNoteTool().reader;
  const down: EvidenceReader = { scope: empty.scope, read: () => Promise.reject(new Error(CANARY)), list: () => Promise.reject(new Error(CANARY)) };
  const falseClaim = await chain(PW, pmsg, { def: liar, reader: empty });
  const failed = await chain(PW, { ...pmsg, event_id: 'evt-synthetic-b' }, { def: bad, reader: empty });
  const unreadable = await chain(PW, { ...pmsg, event_id: 'evt-synthetic-c' }, { reader: down });
  const good = await chain(PW, { ...pmsg, event_id: 'evt-synthetic-d' });
  const r = reporting(); const ctx = await rptCtx();
  submitted(await r.submit(ctx, [falseClaim.triple, failed.triple, unreadable.triple, good.triple]));
  const rep = reportOf(await r.report(ctx));
  assert.deepEqual([rep.counts.verified_simulated_pass, rep.counts.rework, rep.counts.escalate, rep.counts.counted_items], [1, 2, 1, 4]);
  const by = Object.fromEntries(rep.exceptions.map((e) => [e.item_id, e]));
  assert.deepEqual(by[falseClaim.envelope.item_id].checks, [{ check: 'evidence_exists', reason: 'MISSING' }]);
  assert.deepEqual(by[failed.envelope.item_id].checks, [{ check: 'consistency', reason: 'CANDIDATE_FAILED' }]);
  assert.equal(by[unreadable.envelope.item_id].kind, 'escalate');
  assert.deepEqual(by[unreadable.envelope.item_id].checks.map((k) => k.reason), ['READ_FAILED', 'READ_FAILED']);
  assert.equal(by[good.envelope.item_id], undefined);
  assert.ok(!JSON.stringify(rep).includes('CANARY'));
});

test('exceptions: an uncertain tool outcome is escalated and reported with its own reason, never as a pass or a plain failure', async () => {
  const threw: ToolDefinition = { scope: MOCK_NOTE_SCOPE, run: () => { throw new Error(CANARY); } };
  const u = await chain(PW, { ...pmsg, event_id: 'evt-synthetic-u' }, { def: threw });
  assert.equal(u.candidate.status, 'uncertain');
  const r = reporting(); const ctx = await rptCtx();
  submitted(await r.submit(ctx, [u.triple]));
  const rep = reportOf(await r.report(ctx));
  assert.deepEqual([rep.counts.verified_simulated_pass, rep.counts.escalate, rep.counts.rework], [0, 1, 0]);
  assert.deepEqual(rep.exceptions[0].checks, [{ check: 'consistency', reason: 'CANDIDATE_UNCERTAIN' }]);
  assert.ok(!JSON.stringify(rep).includes('CANARY'));
});

// ---------------------------------------------------------------- forged chains
test('forged inputs: unsealed, copied, edited, proxied or hand-built verdicts, candidates and envelopes are refused and add nothing', async () => {
  const c = await chain();
  const r = reporting(); const ctx = await rptCtx();
  const variants: [string, any, string[]][] = [
    ['verdict clone', { ...c.triple, verdict: structuredClone(c.verdict) }, ['VERDICT_NOT_TRUSTED']],
    ['verdict json', { ...c.triple, verdict: JSON.parse(JSON.stringify(c.verdict)) }, ['VERDICT_NOT_TRUSTED']],
    ['verdict spread', { ...c.triple, verdict: { ...c.verdict } }, ['VERDICT_NOT_TRUSTED']],
    ['verdict hand-built pass', { ...c.triple, verdict: { ...structuredClone(c.verdict), verdict: 'pass' } }, ['VERDICT_NOT_TRUSTED']],
    ['verdict proxy', { ...c.triple, verdict: new Proxy(c.verdict, {}) }, ['VERDICT_INVALID']],
    ['candidate clone', { ...c.triple, candidate: structuredClone(c.candidate) }, ['CANDIDATE_NOT_TRUSTED']],
    ['candidate proxy', { ...c.triple, candidate: new Proxy(c.candidate, {}) }, ['CANDIDATE_INVALID']],
    ['envelope clone', { ...c.triple, envelope: structuredClone(c.envelope) }, ['HANDOFF_NOT_TRUSTED']],
    ['envelope proxy', { ...c.triple, envelope: new Proxy(c.envelope, {}) }, ['ENVELOPE_INVALID']],
    ['missing key', { envelope: c.envelope, candidate: c.candidate }, ['TRIPLE_INVALID']],
    ['extra key', { ...c.triple, extra: 1 }, ['TRIPLE_INVALID']],
    ['not an object', 'x', ['TRIPLE_INVALID']], ['null', null, ['TRIPLE_INVALID']], ['array', [], ['TRIPLE_INVALID']],
  ];
  for (const [name, t, codes] of variants) {
    const s = submitted(await r.submit(ctx, [t]));
    assert.deepEqual([s.accepted, s.refused], [0, 1], name);
    const rep = reportOf(await r.report(ctx));
    assert.ok(codes.every((code) => rep.refusals.some((x) => x.code === code)), `${name} should be tallied under ${codes}`);
  }
  const rep = reportOf(await r.report(ctx));
  assert.deepEqual([rep.counts.counted_items, rep.counts.verified_simulated_pass, rep.counts.refused], [0, 0, variants.length]);
  assert.deepEqual(rep.exceptions, []);
  submitted(await r.submit(ctx, [c.triple]));   // the genuine chain still counts
  assert.equal(reportOf(await r.report(ctx)).counts.verified_simulated_pass, 1);
});

test('forged chains: sealed parts that do not belong together are chain conflicts, never passes, and name what is broken', async () => {
  const a = await chain(PW, pmsg);
  const b = await chain(PW, { ...pmsg, event_id: 'evt-synthetic-b' });
  const r = reporting(); const ctx = await rptCtx();
  // A genuine pass verdict for A attached to B's candidate; and A's candidate with B's envelope.
  submitted(await r.submit(ctx, [{ envelope: b.envelope, candidate: b.candidate, verdict: a.verdict }]));
  const c2 = await chain(PW, { ...pmsg, event_id: 'evt-synthetic-c' });
  submitted(await r.submit(ctx, [{ envelope: b.envelope, candidate: c2.candidate, verdict: c2.verdict }]));
  const rep = reportOf(await r.report(ctx));
  assert.deepEqual([rep.counts.counted_items, rep.counts.chain_conflict, rep.counts.verified_simulated_pass], [2, 2, 0]);
  const first = rep.exceptions.find((e) => e.item_id === b.envelope.item_id);
  assert.ok(first && first.kind === 'chain_conflict');
  assert.ok(first.broken.includes('candidate_digest') && first.broken.includes('item_id') && first.broken.includes('parent_chain'));
  const second = rep.exceptions.find((e) => e.item_id === c2.envelope.item_id);
  assert.ok(second && second.broken.includes('handoff_digest') && second.broken.includes('item_id'));
});

test('forged chains: a chain that reuses a correlation id passes QC but not Reporting\'s own check', async () => {
  const c = await chain(PW, pmsg, { intakeCorr: 'corr-shared', procCorr: 'corr-shared' });
  assert.equal(c.verdict.verdict, 'pass', 'QC does not check these two against each other');
  const r = reporting(); const ctx = await rptCtx();
  submitted(await r.submit(ctx, [c.triple]));
  const rep = reportOf(await r.report(ctx));
  assert.deepEqual([rep.counts.verified_simulated_pass, rep.counts.chain_conflict], [0, 1]);
  assert.deepEqual(rep.exceptions[0].broken, ['correlation_ids']);
});

// ---------------------------------------------------------------- replays and distinct attempts
test('replay: the same chain again, in the same or another call, is a duplicate and changes no outcome; a re-run verdict is still a duplicate', async () => {
  const c = await chain();
  const r = reporting(); const ctx = await rptCtx();
  const first = submitted(await r.submit(ctx, [c.triple, c.triple, c.triple]));
  assert.deepEqual([first.accepted, first.duplicates], [1, 2]);
  assert.equal(submitted(await r.submit(ctx, [c.triple])).duplicates, 1);
  // A second QC verdict for the very same candidate (a different, failing reader) must not replace or add to the first.
  const qc2 = createQcEntry({ plan: ['mock-note'], readers: { 'mock-note': createMockNoteTool().reader }, now: () => CLOCK });
  const second = await qc2.run(await mintCtx(PW, 'quality-control', 'corr-qc-rerun', [QC_RUN_SCOPE, MOCK_NOTE_READ_SCOPE]), c.candidate, c.envelope);
  assert.equal(second.ok, true);
  assert.equal((second as any).verdict.verdict, 'rework', 'the re-run disagrees');
  const dup = submitted(await r.submit(ctx, [{ envelope: c.envelope, candidate: c.candidate, verdict: (second as any).verdict }]));
  assert.deepEqual([dup.duplicates, dup.accepted, dup.refused], [1, 0, 0]);
  const rep = reportOf(await r.report(ctx));
  assert.deepEqual([rep.counts.submitted, rep.counts.counted_items, rep.counts.verified_simulated_pass, rep.counts.rework, rep.counts.duplicates], [5, 1, 1, 0, 4]);
});

test('distinct attempts: a second candidate for an item already counted is a repeat attempt; the first outcome stands', async () => {
  const first = await chain();
  const again = await chain(PW, pmsg, { envelope: first.envelope, procCorr: 'corr-proc-second', qcCorr: 'corr-qc-second' });
  assert.notEqual(JSON.stringify(again.candidate), JSON.stringify(first.candidate), 'a different attempt');
  const r = reporting(); const ctx = await rptCtx();
  const s = submitted(await r.submit(ctx, [first.triple, again.triple]));
  assert.deepEqual([s.accepted, s.repeat_attempts, s.duplicates], [1, 1, 0]);
  const rep = reportOf(await r.report(ctx));
  assert.deepEqual([rep.counts.submitted, rep.counts.counted_items, rep.counts.repeat_attempts, rep.counts.verified_simulated_pass], [2, 1, 1, 1]);
  assert.equal(rep.chains.length, 1);
  assert.equal(rep.chains[0].processing_correlation_id, first.candidate.correlation_id);
});

test('counts: across mixed batches the arithmetic always holds and report() is repeatable', async () => {
  const r = reporting(); const ctx = await rptCtx();
  const pass1 = await chain(PW, { ...pmsg, event_id: 'evt-synthetic-m1' });
  const pass2 = await chain(PW, { ...pmsg, event_id: 'evt-synthetic-m2' });
  const empty = createMockNoteTool().reader;
  const liar: ToolDefinition = { scope: MOCK_NOTE_SCOPE, run: () => ({ evidence_ref: 'mock-note:st-000000000000' }) };
  const rework = await chain(PW, { ...pmsg, event_id: 'evt-synthetic-m3' }, { def: liar, reader: empty });
  await r.submit(ctx, [pass1.triple, rework.triple, pass1.triple, { nope: 1 }]);
  await r.submit(ctx, [pass2.triple, rework.triple]);
  const a = reportOf(await r.report(ctx));
  const b = reportOf(await r.report(ctx));
  assert.deepEqual(a, b);
  const c = a.counts;
  assert.equal(c.submitted, c.counted_items + c.refused + c.duplicates + c.repeat_attempts);
  assert.equal(c.counted_items, c.verified_simulated_pass + c.rework + c.escalate + c.chain_conflict);
  assert.deepEqual([c.submitted, c.counted_items, c.verified_simulated_pass, c.rework, c.duplicates, c.refused], [6, 3, 2, 1, 2, 1]);
});

test('lists: long lists are cut and flagged, and the counts stay complete', async () => {
  const r = reporting({ maxList: 2 }); const ctx = await rptCtx();
  const items = [];
  for (let i = 0; i < 4; i++) items.push((await chain(PW, { ...pmsg, event_id: `evt-synthetic-l${i}` })).triple);
  submitted(await r.submit(ctx, items));
  const rep = reportOf(await r.report(ctx));
  assert.deepEqual([rep.counts.verified_simulated_pass, rep.chains.length, rep.lists_truncated], [4, 2, true]);
});

// ---------------------------------------------------------------- tenant isolation
test('tenant isolation: each tenant\'s report has only its own chains; a foreign chain is refused and leaves no trace', async () => {
  const p = await chain(PW, pmsg);
  const d = await chain(DW, dmsg);
  const r = reporting();
  const pctx = await rptCtx(PW); const dctx = await rptCtx(DW, undefined, 'corr-rpt-d');
  submitted(await r.submit(pctx, [p.triple]));
  const cross = submitted(await r.submit(pctx, [d.triple]));
  assert.deepEqual([cross.accepted, cross.refused], [0, 1]);
  submitted(await r.submit(dctx, [d.triple]));
  const pr = reportOf(await r.report(pctx)); const dr = reportOf(await r.report(dctx));
  assert.deepEqual(pr.refusals, [{ code: 'TENANT_MISMATCH', count: 1 }]);
  assert.deepEqual([pr.counts.counted_items, dr.counts.counted_items, dr.counts.refused], [1, 1, 0]);
  const ptext = JSON.stringify(pr);
  for (const x of [d.envelope.item_id, d.candidate.correlation_id, d.verdict.correlation_id, DW]) assert.ok(!ptext.includes(x), `plumbing report leaked ${x}`);
  const dtext = JSON.stringify(dr);
  for (const x of [p.envelope.item_id, p.candidate.correlation_id, PW]) assert.ok(!dtext.includes(x), `dental report leaked ${x}`);
  // The same item id counted for one tenant does not make it a duplicate for another.
  assert.equal(reportOf(await r.report(dctx)).counts.verified_simulated_pass, 1);
});

// ---------------------------------------------------------------- privacy
test('privacy: no category, field name, value, channel, tool or payload text reaches the report', async () => {
  const r = reporting(); const ctx = await rptCtx();
  const good = await chain();
  const liar: ToolDefinition = { scope: MOCK_NOTE_SCOPE, run: () => ({ evidence_ref: 'mock-note:st-000000000000' }) };
  const bad = await chain(PW, { ...pmsg, event_id: 'evt-synthetic-priv' }, { def: liar, reader: createMockNoteTool().reader });
  await r.submit(ctx, [good.triple, bad.triple, { envelope: structuredClone(good.envelope), candidate: good.candidate, verdict: good.verdict }]);
  const text = JSON.stringify(reportOf(await r.report(ctx)));
  for (const x of ['Emergency leak', 'Address', 'Job description', 'Burst pipe', 'ADDRESS_1', 'PERSON_1', 'channel-rpt-test', 'mock-note', 'evt-synthetic', 'masked_text', 'fields']) assert.ok(!text.includes(x), `report leaked ${x}`);
});

// ---------------------------------------------------------------- authority and setup
test('authority: forged, wrong-agent and unscoped contexts and bad batches are refused before anything is read', async () => {
  const c = await chain();
  const r = reporting();
  let touched = 0;
  const probe = new Proxy([], { get() { touched++; throw new Error(CANARY); }, ownKeys() { touched++; throw new Error(CANARY); } });
  const good = await rptCtx();
  for (const bad of [{ workspace_id: PW }, { ...good }, structuredClone(good), new Proxy(good, {}), null, undefined]) {
    refused(await r.submit(bad, probe), 'CONTEXT_NOT_TRUSTED');
    refused(await r.report(bad), 'CONTEXT_NOT_TRUSTED');
  }
  refused(await r.submit(await mintCtx(PW, 'quality-control', 'c', [REPORTING_RUN_SCOPE]), probe), 'WRONG_RECIPIENT');
  refused(await r.submit(await rptCtx(PW, []), [c.triple]), 'REPORT_NOT_PERMITTED');
  refused(await r.report(await rptCtx(PW, [QC_RUN_SCOPE])), 'REPORT_NOT_PERMITTED');
  for (const bad of [null, undefined, 'x', {}, [], new Array(101).fill(c.triple)]) refused(await r.submit(good, bad), 'BATCH_INVALID');
  assert.equal(touched, 0);
  assert.equal(reportOf(await r.report(good)).counts.submitted, 0, 'refused calls counted nothing');
});

test('setup: bad configuration fails at startup without echoing values', () => {
  for (const [name, fn] of [
    ['no clock', () => createReportingEntry({} as never)], ['bad batch', () => reporting({ maxBatch: 0 })], ['bad list', () => reporting({ maxList: 1.5 })],
    ['bad sink', () => reporting({ sink: { write: CANARY } })], ['null', () => createReportingEntry(null as never)],
  ] as [string, () => unknown][]) assert.throws(fn, (e: Error) => e instanceof RangeError && !e.message.includes('CANARY'), name);
  const clock = reporting({ now: () => 'bad' });
  return rptCtx().then(async (ctx) => refused(await clock.report(ctx), 'REPORT_ERROR'));
});

// ---------------------------------------------------------------- contract
test('report.v1: the validator rejects tampered arithmetic, unknown codes, padded lists and wrong labels', async () => {
  const r = reporting(); const ctx = await rptCtx();
  submitted(await r.submit(ctx, [(await chain()).triple, { nope: 1 }]));
  const good = JSON.parse(JSON.stringify(reportOf(await r.report(ctx))));
  assert.deepEqual(validateReport(good), []);
  const bad: Record<string, any>[] = [
    { ...good, contract: 'report.v2' }, { ...good, extra: 1 }, { ...good, basis: 'live' }, { ...good, produced_by: 'qc' }, { ...good, created_at: 'now' },
    { ...good, counts: { ...good.counts, verified_simulated_pass: 5 } }, { ...good, counts: { ...good.counts, submitted: 9 } }, { ...good, counts: { ...good.counts, refused: 0 } },
    { ...good, counts: { ...good.counts, extra: 1 } }, { ...good, counts: { ...good.counts, rework: -1 } }, { ...good, refusals: [{ code: 'NOPE', count: 1 }] },
    { ...good, refusals: [{ code: 'TRIPLE_INVALID', count: 2 }] }, { ...good, chains: [] }, { ...good, lists_truncated: 'no' },
    { ...good, exceptions: [{ item_id: 'wi-000000000000', kind: 'chain_conflict', checks: [], broken: [] }] },
  ];
  for (const b of bad) assert.notDeepEqual(validateReport(b), []);
  for (const odd of [null, undefined, 'x', [], 5]) assert.notDeepEqual(validateReport(odd), []);
});

// ---------------------------------------------------------------- telemetry
test('telemetry: events are stamped from the Reporting context; a failing sink never changes a count or a report', async () => {
  const events: ObsEvent[] = [];
  const c = await chain();
  const r = reporting({ sink: { write: (e: ObsEvent) => { events.push(e); } } });
  const ctx = await rptCtx(PW, undefined, 'corr-rpt-t');
  await r.submit(ctx, [c.triple]);
  await r.report(ctx);
  await r.submit({ forged: true }, [c.triple]);
  await r.submit(await rptCtx(PW, []), [c.triple]);
  assert.deepEqual(events.map((e) => [e.event, e.error_code ?? null]), [['run.finished', null], ['run.finished', null], ['run.refused', 'REPORT_NOT_PERMITTED']]);
  assert.deepEqual([events[0].agent, events[0].workspace_id, events[0].correlation_id], ['reporting', PW, 'corr-rpt-t']);
  assert.ok(!JSON.stringify(events).match(/Emergency|Address|mock-note|channel-rpt|wi-[0-9a-f]{12}/));
  for (const w of [() => { throw new Error(CANARY); }, () => Promise.reject(new Error(CANARY)), () => new Promise(() => {})]) {
    const q = reporting({ sink: { write: w } });
    const k = await rptCtx();
    assert.equal(submitted(await q.submit(k, [c.triple])).accepted, 1);
    assert.equal(reportOf(await q.report(k)).counts.verified_simulated_pass, 1);
  }
  await new Promise((res) => setImmediate(res));
});

// ---------------------------------------------------------------- inventory
test('inventory: only the QC entry seals verdicts; Reporting mints nothing, runs nothing, reads no tools and imports no producer', () => {
  const dir = new URL('../src/', import.meta.url);
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  const using = (name: string) => files.filter((f) => f !== 'handoff-seal.ts' && new RegExp(`\\b${name}\\b`).test(strip(readFileSync(new URL(f, dir), 'utf8'))));
  assert.deepEqual(using('sealVerdict'), ['qc-entry.ts']);
  assert.deepEqual(using('sealCandidate'), ['processing-entry.ts']);
  assert.deepEqual(using('sealHandoff'), ['intake-entry.ts']);
  for (const f of ['reporting-entry.ts', 'report.ts']) {
    const code = strip(readFileSync(new URL(f, dir), 'utf8'));
    for (const m of code.matchAll(/from\s+'([^']+)'/g)) assert.ok(m[1].startsWith('./'), `${f} imports ${m[1]}`);
    assert.ok(!/from\s+'\.\/(processing-entry|intake-entry|qc-entry|tenant-boundary|live-run|mock-tools)\.ts'/.test(code), `${f} imports a producer or a tool`);
    assert.ok(!/\b(mintExecutionContext|runIntake|runIntakeWithModel|createIntakeEntry|createProcessingEntry|createQcEntry|seal(Handoff|Candidate|Verdict)|fetch|process\.env|readFile|writeFile|child_process)\b/.test(code), `${f} uses a forbidden name`);
  }
});
