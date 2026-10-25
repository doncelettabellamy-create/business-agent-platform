// Tests for the controlled synthetic pipeline: verify once, one tenant, four restricted contexts, Intake -> Processing -> QC ->
// Reporting. Mock provider, mock tools, mock sources, synthetic data only. No network, no key, no real side effect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createIntakeEntry } from '../src/intake-entry.ts';
import { createTenantRegistry } from '../src/tenant-boundary.ts';
import type { ExecutionContext } from '../src/execution-context.ts';
import { createProcessingEntry, createToolRegistry } from '../src/processing-entry.ts';
import type { ToolDefinition } from '../src/processing-entry.ts';
import { createMockNoteTool, MOCK_NOTE_READ_SCOPE, MOCK_NOTE_SCOPE } from '../src/mock-tools.ts';
import type { EvidenceReader } from '../src/mock-tools.ts';
import { createQcEntry } from '../src/qc-entry.ts';
import { createReportingEntry } from '../src/reporting-entry.ts';
import { createPipeline } from '../src/pipeline.ts';
import type { PipelineResult } from '../src/pipeline.ts';
import { validateReport } from '../src/report.ts';
import { classifyAnswer, createMockProvider, extractAnswer } from '../src/mock-provider.ts';

const CANARY = 'CANARY-PIPE-4417';
const CLOCK = '2026-10-25T19:00:00Z';
const PW = 'ws-synthetic-plumbing';
const DW = 'ws-synthetic-dental';
const read = (n: string) => JSON.parse(readFileSync(new URL(`../examples/${n}`, import.meta.url), 'utf8'));
const { skill_config: pcfg, ...pmsg } = read('skill-plumbing.json');
const { skill_config: dcfg, ...dmsg } = read('skill-dental.json');
const NEEDS_HUMAN = { ...pmsg, event_id: 'evt-synthetic-needs-human', masked_text: 'Hello, this is [PERSON_1]. There is a burst pipe and a leak in the kitchen.\nJob description: Burst pipe repair' };

const VALUES: Record<string, string> = { Address: '[ADDRESS_1]', 'Job description': 'Burst pipe repair', 'Patient reference': '[ID_1]', 'Insurance provider': 'Example Health' };
const provider = () => createMockProvider({
  classify_request: (req) => classifyAnswer((req.data.categories ?? []).includes('Emergency leak') ? 'Emergency leak' : 'New patient', 0.9),
  extract_fields: (req) => extractAnswer((req.data.fields ?? []).map((f) => ({ name: f.name, value: VALUES[f.name] ?? null, confidence: VALUES[f.name] ? 0.9 : null }))),
});
const ALL_SCOPES = ['intake:run', 'processing:run', MOCK_NOTE_SCOPE, 'quality-control:run', MOCK_NOTE_READ_SCOPE, 'reporting:run', 'admin:everything'];

interface Rig {
  pipeline: ReturnType<typeof createPipeline>;
  note: ReturnType<typeof createMockNoteTool>;
  calls: { verify: number; select: number; grants: number };
  seen: Partial<Record<'intake' | 'processing' | 'qc' | 'reporting', ExecutionContext>>;
  parts: { envelope?: any; candidate?: any; verdict?: any };
  entries: any;
}
/** Builds real entries, wraps them in spies, and a pipeline over mock sources. */
function rig(o: { def?: ToolDefinition; reader?: EvidenceReader; toolScopes?: string[]; readerScopes?: string[]; timeoutMs?: number; sources?: Record<string, unknown>; stubs?: Record<string, unknown>; grants?: () => unknown } = {}): Rig {
  const note = createMockNoteTool();
  const calls = { verify: 0, select: 0, grants: 0 };
  const seen: Rig['seen'] = {}; const parts: Rig['parts'] = {};
  const real = {
    intake: createIntakeEntry({ registry: createTenantRegistry({ [PW]: pcfg, [DW]: dcfg }), provider: provider(), channelRef: 'channel-pipe-test', now: () => CLOCK }),
    processing: createProcessingEntry({ tools: createToolRegistry({ 'mock-note': o.def ?? note }), plan: ['mock-note'], now: () => CLOCK, timeoutMs: 200 }),
    qc: createQcEntry({ plan: ['mock-note'], readers: { 'mock-note': o.reader ?? note.reader }, now: () => CLOCK, timeoutMs: 200 }),
    reporting: createReportingEntry({ now: () => CLOCK }),
  };
  const entries: any = {
    intake: { run: async (c: ExecutionContext, m: unknown) => { seen.intake = c; const r: any = await real.intake.run(c, m); if (r.ok && r.handoff) parts.envelope = r.handoff; return r; } },
    processing: { run: async (c: ExecutionContext, e: unknown) => { seen.processing = c; const r: any = await real.processing.run(c, e); if (r.ok) parts.candidate = r.candidate; return r; } },
    qc: { run: async (c: ExecutionContext, cand: unknown, e: unknown) => { seen.qc = c; const r: any = await real.qc.run(c, cand, e); if (r.ok) parts.verdict = r.verdict; return r; } },
    reporting: { submit: async (c: ExecutionContext, t: unknown) => { seen.reporting = c; return real.reporting.submit(c, t); }, report: (c: ExecutionContext) => real.reporting.report(c) },
    ...(o.stubs ?? {}),
  };
  let n = 0;
  const sources = {
    verify: (cred: unknown) => { calls.verify++; return cred === 'cred-plumbing' ? { kind: 'user', id: 'user-plumbing' } : cred === 'cred-dental' ? { kind: 'user', id: 'user-dental' } : undefined; },
    selectTenant: (id: { id: string }) => { calls.select++; return id.id === 'user-plumbing' ? PW : id.id === 'user-dental' ? DW : undefined; },
    grants: () => { calls.grants++; return o.grants ? o.grants() : ALL_SCOPES; },
    newCorrelationId: () => `corr-pipe-${++n}`,
    ...(o.sources ?? {}),
  };
  const pipeline = createPipeline({
    ...entries, sources: sources as never, processingToolScopes: o.toolScopes ?? [MOCK_NOTE_SCOPE], qcReaderScopes: o.readerScopes ?? [MOCK_NOTE_READ_SCOPE],
    ...(o.timeoutMs ? { stageTimeoutMs: o.timeoutMs } : {}),
  });
  return { pipeline, note, calls, seen, parts, entries };
}
function reported(r: PipelineResult) {
  assert.equal(r.ok, true, `expected ok, got ${JSON.stringify((r as any).error)} at ${(r as any).stage}`);
  assert.equal((r as any).outcome, 'reported');
  const x = r as Extract<PipelineResult, { ok: true; outcome: 'reported' }>;
  assert.deepEqual(validateReport(x.report), []);
  return x;
}
function failed(r: PipelineResult, stage: string, code: string) {
  assert.equal(r.ok, false, `expected failure at ${stage}`);
  const f = r as Extract<PipelineResult, { ok: false }>;
  assert.deepEqual([f.stage, f.error.code], [stage, code]);
  assert.ok(!f.error.message.includes('CANARY') && !f.error.message.includes(PW) && !f.error.message.includes(DW));
  return f;
}
const statuses = (r: PipelineResult) => r.stages.map((s) => `${s.stage}:${s.status}`).join(' ');

// ---------------------------------------------------------------- the whole path
test('pipeline: one request goes Intake -> Processing -> QC -> Reporting, verified once, with one tenant and four distinct correlation ids', async () => {
  const g = rig();
  const r = reported(await g.pipeline.run('cred-plumbing', pmsg));
  assert.deepEqual([r.verdict, r.counted], ['pass', 'accepted']);
  assert.equal(statuses(r), 'auth:passed intake:passed processing:passed qc:passed reporting:passed');
  assert.deepEqual(g.calls, { verify: 1, select: 1, grants: 4 }, 'identity verified once and one tenant selected once; grants asked once per agent');
  assert.equal(new Set(Object.values(r.correlation_ids)).size, 4);
  assert.deepEqual([r.report.workspace_id, r.report.counts.verified_simulated_pass, r.report.counts.counted_items, r.report.basis], [PW, 1, 1, 'verified-simulation']);
  assert.equal(r.report.chains[0].item_id, r.item_id);
  assert.deepEqual([r.report.chains[0].intake_correlation_id, r.report.chains[0].processing_correlation_id, r.report.chains[0].qc_correlation_id], [r.correlation_ids.intake, r.correlation_ids.processing, r.correlation_ids.qc]);
  assert.equal(g.note.writes.length, 1);
  assert.ok(Object.isFrozen(r.report));
});

// ---------------------------------------------------------------- restricted contexts
test('contexts: each agent gets only its own scopes (cut from a broad grant), the same actor and the same tenant', async () => {
  const g = rig();
  reported(await g.pipeline.run('cred-plumbing', pmsg));
  const s = g.seen as Record<string, ExecutionContext>;
  assert.deepEqual([...s.intake.scopes], ['intake:run']);
  assert.deepEqual([...s.processing.scopes].sort(), ['processing:run', MOCK_NOTE_SCOPE].sort());
  assert.deepEqual([...s.qc.scopes].sort(), ['quality-control:run', MOCK_NOTE_READ_SCOPE].sort());
  assert.deepEqual([...s.reporting.scopes], ['reporting:run']);
  for (const c of Object.values(s)) {
    assert.equal(c.workspace_id, PW);
    assert.deepEqual([c.actor.kind, c.actor.id], ['user', 'user-plumbing']);
    assert.ok(!c.scopes.includes('admin:everything'));
  }
  assert.deepEqual(Object.values(s).map((c) => c.agent), ['intake', 'processing', 'quality-control', 'reporting']);
});

test('contexts: a grants source cannot widen an agent; a narrower grant narrows it further', async () => {
  const g = rig({ grants: () => ['intake:run', 'processing:run', 'reporting:run'] });
  failed(await g.pipeline.run('cred-plumbing', pmsg), 'processing', 'PROCESSING_NOT_PERMITTED');
  assert.deepEqual([...(g.seen.intake as ExecutionContext).scopes], ['intake:run'], 'intake did not get processing:run');
  assert.ok(!(g.seen.processing as ExecutionContext).scopes.includes(MOCK_NOTE_SCOPE));
});

test('contexts: the tenant is chosen once, so a source that answers differently the second time changes nothing', async () => {
  let n = 0;
  const g = rig({ sources: { selectTenant: () => (n++ === 0 ? PW : DW) } });
  reported(await g.pipeline.run('cred-plumbing', pmsg));
  assert.equal(n, 1);
  assert.ok(Object.values(g.seen).every((c) => (c as ExecutionContext).workspace_id === PW));
});

test('contexts: the caller cannot inject a context, entry, scope or stage; a context passed as the credential is not a credential', async () => {
  const g = rig();
  const sneaky = (g.seen.intake ?? null);
  void sneaky;
  failed(await g.pipeline.run({ workspace_id: PW, scopes: ALL_SCOPES }, pmsg), 'auth', 'UNAUTHENTICATED');
  failed(await g.pipeline.run(null, pmsg), 'auth', 'UNAUTHENTICATED');
  assert.equal(g.pipeline.run.length, 2, 'run takes a credential and a message and nothing else');
  assert.deepEqual(Object.keys(g.pipeline), ['run']);
  assert.ok(Object.isFrozen(g.pipeline));
  assert.deepEqual(g.note.calls(), 0);
});

// ---------------------------------------------------------------- stage failures
test('failure: authentication, tenant selection and grants failures stop everything before any stage runs', async () => {
  const cases: [string, ReturnType<typeof rig>, unknown, string][] = [
    ['unknown credential', rig(), 'cred-unknown', 'UNAUTHENTICATED'],
    ['verify throws', rig({ sources: { verify: () => { throw new Error(CANARY); } } }), 'cred-plumbing', 'UNAUTHENTICATED'],
    ['no tenant', rig({ sources: { selectTenant: () => undefined } }), 'cred-plumbing', 'TENANT_NOT_SELECTED'],
    ['grants garbage', rig({ grants: () => 'all' }), 'cred-plumbing', 'GRANTS_INVALID'],
    ['bad correlation id', rig({ sources: { newCorrelationId: () => '' } }), 'cred-plumbing', 'CONTEXT_INVALID'],
  ];
  for (const [name, g, cred, code] of cases) {
    const r = failed(await g.pipeline.run(cred, pmsg), 'auth', code);
    assert.equal(statuses(r), 'auth:refused intake:not-run processing:not-run qc:not-run reporting:not-run', name);
    assert.deepEqual(g.seen, {}, name);
    assert.ok(!JSON.stringify(r).includes('CANARY'));
  }
});

test('failure: Intake refusals stop the run and nothing is handed on', async () => {
  const g = rig();
  const bad: [string, unknown, string][] = [
    ['config in message', { ...pmsg, skill_config: {} }, 'CONFIG_NOT_ALLOWED_IN_INPUT'],
    ['other tenant in message', { ...pmsg, workspace_id: DW }, 'TENANT_MISMATCH'],
    ['not synthetic', { ...pmsg, masking: { applied: true, source: 'real' } }, 'SYNTHETIC_ONLY'],
    ['not an object', 'x', 'INPUT_INVALID'],
  ];
  for (const [name, message, code] of bad) {
    const r = failed(await g.pipeline.run('cred-plumbing', message), 'intake', code);
    assert.equal(statuses(r), 'auth:passed intake:refused processing:not-run qc:not-run reporting:not-run', name);
  }
  assert.equal(g.note.calls(), 0);
  assert.equal(g.parts.envelope, undefined);
});

test('failure: an item that needs a human stops after Intake with its own outcome; no handoff, no tool call', async () => {
  const g = rig();
  const r = await g.pipeline.run('cred-plumbing', NEEDS_HUMAN);
  assert.equal(r.ok, true);
  assert.equal((r as any).outcome, 'needs-human');
  assert.equal(statuses(r), 'auth:passed intake:needs-human processing:not-run qc:not-run reporting:not-run');
  assert.equal((r as any).report, undefined);
  assert.equal(g.note.calls(), 0);
});

test('failure: Processing and QC scope problems refuse at their own stage and later stages do not run', async () => {
  const noTool = rig({ toolScopes: [] });
  const r1 = failed(await noTool.pipeline.run('cred-plumbing', pmsg), 'processing', 'PROCESSING_NOT_PERMITTED');
  assert.equal(statuses(r1), 'auth:passed intake:passed processing:refused qc:not-run reporting:not-run');
  assert.equal(noTool.note.calls(), 0);
  const noReader = rig({ readerScopes: [] });
  const r2 = failed(await noReader.pipeline.run('cred-plumbing', pmsg), 'qc', 'QC_NOT_PERMITTED');
  assert.equal(statuses(r2), 'auth:passed intake:passed processing:passed qc:refused reporting:not-run');
});

test('failure: a failing tool or a false success claim still reaches Reporting, as an exception and never as a pass', async () => {
  const bad = rig({ def: { scope: MOCK_NOTE_SCOPE, run: () => ({ not_performed: true }) } });
  const r1 = reported(await bad.pipeline.run('cred-plumbing', pmsg));
  assert.deepEqual([r1.verdict, r1.report.counts.verified_simulated_pass, r1.report.counts.rework], ['rework', 0, 1]);
  const threw = rig({ def: { scope: MOCK_NOTE_SCOPE, run: () => { throw new Error(CANARY); } } });
  const r0 = reported(await threw.pipeline.run('cred-plumbing', pmsg));
  assert.deepEqual([r0.verdict, r0.report.counts.verified_simulated_pass, r0.report.counts.escalate], ['escalate', 0, 1], 'an uncertain outcome is escalated, never reworked blindly');
  assert.deepEqual(r0.report.exceptions[0].checks, [{ check: 'consistency', reason: 'CANDIDATE_UNCERTAIN' }]);
  assert.ok(!JSON.stringify([r0, r1]).includes('CANARY'));
  const liar = rig({ def: { scope: MOCK_NOTE_SCOPE, run: () => ({ evidence_ref: 'mock-note:st-000000000000' }) } });
  const r2 = reported(await liar.pipeline.run('cred-plumbing', pmsg));
  assert.deepEqual([r2.verdict, r2.report.counts.verified_simulated_pass, r2.report.exceptions[0].checks], ['rework', 0, [{ check: 'evidence_exists', reason: 'MISSING' }]]);
  const down: EvidenceReader = { scope: MOCK_NOTE_READ_SCOPE, read: () => Promise.reject(new Error(CANARY)), list: () => Promise.reject(new Error(CANARY)) };
  const r3 = reported(await rig({ reader: down }).pipeline.run('cred-plumbing', pmsg));
  assert.deepEqual([r3.verdict, r3.report.counts.escalate], ['escalate', 1]);
});

test('failure: a stage that throws or returns garbage becomes a typed failure at that stage, with no values', async () => {
  const stages: [string, any, string][] = [
    ['intake', { intake: { run: () => { throw new Error(CANARY); } } }, 'PIPELINE_ERROR'],
    ['processing', { processing: { run: () => Promise.reject(new Error(CANARY)) } }, 'PIPELINE_ERROR'],
    ['qc', { qc: { run: () => { throw new Error(CANARY); } } }, 'PIPELINE_ERROR'],
    ['reporting', { reporting: { submit: () => { throw new Error(CANARY); }, report: () => ({}) } }, 'PIPELINE_ERROR'],
  ];
  for (const [stage, stubs, code] of stages) {
    const r = failed(await rig({ stubs }).pipeline.run('cred-plumbing', pmsg), stage, code);
    assert.ok(!JSON.stringify(r).includes('CANARY'));
  }
  failed(await rig({ stubs: { intake: { run: async () => 'garbage' } } }).pipeline.run('cred-plumbing', pmsg), 'intake', 'PIPELINE_ERROR');
  failed(await rig({ stubs: { qc: { run: async () => ({ ok: true }) } } }).pipeline.run('cred-plumbing', pmsg), 'qc', 'PIPELINE_ERROR');
  failed(await rig({ stubs: { reporting: { submit: async () => ({ ok: true, refused: 1, duplicates: 0, repeat_attempts: 0 }), report: async () => ({}) } } }).pipeline.run('cred-plumbing', pmsg), 'reporting', 'PIPELINE_ERROR');
});

// ---------------------------------------------------------------- timeouts
test('timeouts: a hanging stage is abandoned after the bound, named, and later stages do not run', async () => {
  const hang = () => new Promise<never>(() => {});
  const cases: [string, any][] = [
    ['intake', { intake: { run: hang } }], ['processing', { processing: { run: hang } }], ['qc', { qc: { run: hang } }],
    ['reporting', { reporting: { submit: hang, report: hang } }],
  ];
  for (const [stage, stubs] of cases) {
    const started = Date.now();
    const r = failed(await rig({ stubs, timeoutMs: 40 }).pipeline.run('cred-plumbing', pmsg), stage, 'STAGE_TIMEOUT');
    assert.ok(Date.now() - started < 2000, `${stage} was bounded`);
    assert.equal(r.stages.find((s) => s.stage === stage)?.status, 'failed');
  }
});

test('timeouts: a hanging trusted source cannot hold the request; nothing runs', async () => {
  const hang = () => new Promise<never>(() => {});
  for (const sources of [{ verify: hang }, { selectTenant: hang }, { grants: hang }]) {
    const g = rig({ sources, timeoutMs: 40 });
    const started = Date.now();
    const r = await g.pipeline.run('cred-plumbing', pmsg);
    assert.equal(r.ok, false);
    assert.equal((r as any).stage, 'auth');
    assert.ok(Date.now() - started < 2000);
    assert.deepEqual(g.seen, {});
  }
});

// ---------------------------------------------------------------- tenant isolation
test('isolation: two tenants through one pipeline get separate contexts, results and reports', async () => {
  const g = rig();
  const p = reported(await g.pipeline.run('cred-plumbing', pmsg));
  const d = reported(await g.pipeline.run('cred-dental', dmsg));
  assert.deepEqual([p.report.workspace_id, d.report.workspace_id], [PW, DW]);
  assert.deepEqual([p.report.counts.counted_items, d.report.counts.counted_items], [1, 1]);
  assert.ok(!JSON.stringify(p).includes(d.item_id) && !JSON.stringify(d).includes(p.item_id));
  assert.ok(!JSON.stringify(p).includes(DW) && !JSON.stringify(d).includes(PW));
  assert.equal((g.seen.reporting as ExecutionContext).workspace_id, DW);
});

test('isolation: the tripwire stops a stage that returns another tenant\'s object, before the next stage sees it', async () => {
  const donor = rig();
  reported(await donor.pipeline.run('cred-dental', dmsg));
  const foreign = donor.parts;
  const intakeStub = rig({ stubs: { intake: { run: async () => ({ ok: true, outcome: 'handed-off', handoff: foreign.envelope }) } } });
  const a = failed(await intakeStub.pipeline.run('cred-plumbing', pmsg), 'intake', 'CONTEXT_MISMATCH');
  assert.equal(statuses(a), 'auth:passed intake:failed processing:not-run qc:not-run reporting:not-run');
  const procStub = rig({ stubs: { processing: { run: async () => ({ ok: true, candidate: foreign.candidate }) } } });
  failed(await procStub.pipeline.run('cred-plumbing', pmsg), 'processing', 'CONTEXT_MISMATCH');
  const qcStub = rig({ stubs: { qc: { run: async () => ({ ok: true, verdict: foreign.verdict }) } } });
  failed(await qcStub.pipeline.run('cred-plumbing', pmsg), 'qc', 'CONTEXT_MISMATCH');
  assert.deepEqual([procStub.seen.qc, procStub.seen.reporting], [undefined, undefined], 'the next stages never saw the foreign object');
});

// ---------------------------------------------------------------- duplicates
test('duplicates: the same request again does not write twice or count twice; Reporting files it as a repeat attempt', async () => {
  const g = rig();
  const first = reported(await g.pipeline.run('cred-plumbing', pmsg));
  const second = reported(await g.pipeline.run('cred-plumbing', pmsg));
  assert.deepEqual([first.counted, second.counted], ['accepted', 'repeat']);
  assert.equal(second.item_id, first.item_id);
  assert.equal(g.note.writes.length, 1, 'one tool write for the item');
  assert.deepEqual([second.report.counts.submitted, second.report.counts.counted_items, second.report.counts.verified_simulated_pass, second.report.counts.repeat_attempts], [2, 1, 1, 1]);
  assert.equal(second.verdict, 'pass', 'QC still finds the one real record and no orphan');
  assert.notEqual(second.correlation_ids.intake, first.correlation_ids.intake, 'a fresh run identity each time');
});

// ---------------------------------------------------------------- privacy and setup
test('privacy: results hold ids, fixed words and counts only', async () => {
  const g = rig();
  const text = JSON.stringify([
    await g.pipeline.run('cred-plumbing', pmsg), await g.pipeline.run('cred-plumbing', NEEDS_HUMAN), await g.pipeline.run('cred-plumbing', { ...pmsg, skill_config: { x: CANARY } }),
    await g.pipeline.run('cred-unknown', pmsg),
  ]);
  for (const x of ['Emergency leak', 'Address', 'Job description', 'Burst pipe', 'ADDRESS_1', 'PERSON_1', 'channel-pipe-test', 'mock-note', 'masked_text', 'CANARY']) assert.ok(!text.includes(x), `leaked ${x}`);
});

test('setup: missing entries or sources, bad scopes and bad timeouts fail at startup without echoing values', () => {
  const g = rig();
  const base = { ...g.entries, sources: { verify() {}, selectTenant() {}, grants() {}, newCorrelationId() { return 'c'; } }, processingToolScopes: [], qcReaderScopes: [] } as any;
  const bad: [string, () => unknown][] = [
    ['null', () => createPipeline(null as never)], ['no intake', () => createPipeline({ ...base, intake: undefined })], ['no reporting fn', () => createPipeline({ ...base, reporting: { submit() {} } })],
    ['no sources', () => createPipeline({ ...base, sources: {} })], ['bad scope', () => createPipeline({ ...base, processingToolScopes: [`BAD ${CANARY}`] })],
    ['repeat scope', () => createPipeline({ ...base, qcReaderScopes: ['a:b', 'a:b'] })], ['scopes not a list', () => createPipeline({ ...base, qcReaderScopes: 'x' })],
    ['timeout', () => createPipeline({ ...base, stageTimeoutMs: 0 })], ['timeout big', () => createPipeline({ ...base, stageTimeoutMs: 60_001 })],
  ];
  for (const [name, fn] of bad) assert.throws(fn, (e: Error) => e instanceof RangeError && !e.message.includes('CANARY'), name);
});

// ---------------------------------------------------------------- inventory
test('inventory: only the pipeline and the developer path mint; the pipeline calls no raw runner, seal or tool, and reads no I/O', () => {
  const code = readFileSync(new URL('../src/pipeline.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const specs = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  for (const s of specs) assert.ok(s.startsWith('./'), `imports ${s}`);
  assert.deepEqual([...new Set(specs)].sort(), ['./contracts.ts', './execution-context.ts', './intake-entry.ts', './pipeline.ts', './processing-entry.ts', './qc-entry.ts', './report.ts', './reporting-entry.ts'].filter((s) => s !== './pipeline.ts'));
  assert.ok(!/from\s+'\.\/(tenant-boundary|intake-runner|mock-tools|handoff-seal|live-run|candidate-result|qc-verdict)\.ts'/.test(code));
  assert.ok(!/\b(runIntake|runIntakeWithModel|runIntakeForTenant|seal(Handoff|Candidate|Verdict)|createIntakeEntry|createProcessingEntry|createQcEntry|createReportingEntry|fetch|process\.env|readFile|writeFile|child_process)\b/.test(code));
  // The type-only imports of the four entries are not runtime imports.
  for (const name of ['IntakeEntry', 'ProcessingEntry', 'QcEntry', 'ReportingEntry']) assert.ok(new RegExp(`import type \\{[^}]*\\b${name}\\b`).test(code), `${name} is a type import`);
});
