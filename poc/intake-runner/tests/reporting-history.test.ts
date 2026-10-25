// Tests for the Reporting observation history: append-only, hash-linked, duplicate-protected, with a current status derived by QC verdict time.
// Mock provider, mock tools and readers, synthetic data only. No network, no key, no real side effect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createIntakeEntry } from '../src/intake-entry.ts';
import { createTenantRegistry } from '../src/tenant-boundary.ts';
import { mintExecutionContext } from '../src/execution-context.ts';
import type { AgentName, ExecutionContext } from '../src/execution-context.ts';
import { createProcessingEntry, createToolRegistry, PROCESSING_RUN_SCOPE } from '../src/processing-entry.ts';
import { createMockNoteTool, MOCK_NOTE_READ_SCOPE, MOCK_NOTE_SCOPE } from '../src/mock-tools.ts';
import type { EvidenceReader } from '../src/mock-tools.ts';
import { createQcEntry, QC_RUN_SCOPE } from '../src/qc-entry.ts';
import { createReportingEntry, REPORTING_RUN_SCOPE } from '../src/reporting-entry.ts';
import type { ReportResult, SubmitResult } from '../src/reporting-entry.ts';
import { validateReport } from '../src/report.ts';
import { deriveStatuses, verifyObservationLog, createInMemoryReportingLedger, snapshotIsConsistent, GENESIS_DIGEST } from '../src/reporting-ledger.ts';
import type { Disposition, LedgerSnapshot, Observation, RecordResult, ReportingLedger } from '../src/reporting-ledger.ts';
import { classifyAnswer, createMockProvider, extractAnswer } from '../src/mock-provider.ts';

const CANARY = 'CANARY-HIST-4417';
const CLOCK = '2026-10-25T18:00:00Z';
const T1 = '2026-10-25T18:01:00Z';
const T2 = '2026-10-25T18:02:00Z';
const T3 = '2026-10-25T18:03:00Z';
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
const intake = createIntakeEntry({ registry: createTenantRegistry({ [PW]: pcfg, [DW]: dcfg }), provider: provider(), channelRef: 'channel-hist-test', now: () => CLOCK });
const rptCtx = (tenant = PW, scopes = [REPORTING_RUN_SCOPE], corr = 'corr-hist-1') => mintCtx(tenant, 'reporting', corr, scopes);

let seq = 0;
async function envelopeFor(tenant: string, message: Record<string, unknown>): Promise<any> {
  const r = await intake.run(await mintCtx(tenant, 'intake', `corr-hist-intake-${++seq}`, ['intake:run']), message);
  assert.equal(r.ok, true);
  return (r as any).handoff;
}
interface Triple { envelope: any; candidate: any; verdict: any }
/** One real Processing -> QC attempt on an existing envelope. `at` is the QC verdict's own time; `down` makes the read-back fail (an escalation). */
async function attempt(tenant: string, envelope: any, o: { at?: string; down?: boolean } = {}): Promise<Triple> {
  const n = ++seq;
  const note = createMockNoteTool();
  const proc = createProcessingEntry({ tools: createToolRegistry({ 'mock-note': note }), plan: ['mock-note'], now: () => CLOCK });
  const pr = await proc.run(await mintCtx(tenant, 'processing', `corr-hist-proc-${n}`, [PROCESSING_RUN_SCOPE, MOCK_NOTE_SCOPE]), envelope);
  assert.equal(pr.ok, true);
  const candidate = (pr as any).candidate;
  const empty = createMockNoteTool().reader;
  const downReader: EvidenceReader = { scope: empty.scope, read: () => Promise.reject(new Error(CANARY)), list: () => Promise.reject(new Error(CANARY)) };
  const qc = createQcEntry({ plan: ['mock-note'], readers: { 'mock-note': o.down ? downReader : note.reader }, now: () => o.at ?? CLOCK, timeoutMs: 50 });
  const qr = await qc.run(await mintCtx(tenant, 'quality-control', `corr-hist-qc-${n}`, [QC_RUN_SCOPE, MOCK_NOTE_READ_SCOPE]), candidate, envelope);
  assert.equal(qr.ok, true);
  return { envelope, candidate, verdict: (qr as any).verdict };
}
const reporting = (over: Record<string, unknown> = {}) => createReportingEntry({ now: () => CLOCK, ...over });
const ok = (r: SubmitResult) => { assert.equal(r.ok, true, JSON.stringify((r as any).error)); return r as Extract<SubmitResult, { ok: true }>; };
function reportOf(r: ReportResult) {
  assert.equal(r.ok, true, JSON.stringify((r as any).error));
  const rep = (r as Extract<ReportResult, { ok: true }>).report;
  assert.deepEqual(validateReport(rep), []);
  return rep;
}
const msg = (id: string) => ({ ...pmsg, event_id: id });
async function history(r: ReturnType<typeof reporting>, ctx: ExecutionContext) {
  const h = await r.history(ctx);
  assert.equal(h.ok, true);
  return h as Extract<typeof h, { ok: true }>;
}

// ---------------------------------------------------------------- ordering
test('ordering: a later verdict for the same item becomes the current status; the first outcome stays on record', async () => {
  const env = await envelopeFor(PW, msg('evt-synthetic-ha'));
  const first = await attempt(PW, env, { at: T1, down: true });
  const second = await attempt(PW, env, { at: T2 });
  assert.equal(first.verdict.verdict, 'escalate');
  assert.equal(second.verdict.verdict, 'pass');
  const r = reporting(); const ctx = await rptCtx();
  const s = ok(await r.submit(ctx, [first, second]));
  assert.deepEqual([s.accepted, s.repeat_attempts, s.duplicates, s.refused], [1, 1, 0, 0]);
  const rep = reportOf(await r.report(ctx));
  assert.deepEqual([rep.counts.escalate, rep.counts.verified_simulated_pass, rep.counts.counted_items, rep.counts.repeat_attempts], [1, 0, 1, 1]);
  assert.deepEqual(rep.statuses, [{ item_id: env.item_id, first: 'escalate', current: 'pass', attempts: 2 }]);
  assert.deepEqual(rep.current, { pass: 1, rework: 0, escalate: 0, chain_conflict: 0 });
  assert.deepEqual([rep.history.observations, rep.history.verified, rep.history.superseded_on_arrival, rep.history.chain_rejected], [2, true, 0, 0]);
  assert.equal(rep.chains[0].outcome, 'escalate');
  assert.deepEqual(rep.exceptions.map((e) => e.item_id), [env.item_id]);
});

test('ordering: arrival order decides nothing; an older verdict arriving late is recorded but cannot change the status', async () => {
  const env = await envelopeFor(PW, msg('evt-synthetic-hb'));
  const older = await attempt(PW, env, { at: T1, down: true });
  const newer = await attempt(PW, env, { at: T2 });
  const r = reporting(); const ctx = await rptCtx();
  ok(await r.submit(ctx, [newer]));
  ok(await r.submit(ctx, [older]));
  const rep = reportOf(await r.report(ctx));
  assert.deepEqual(rep.statuses, [{ item_id: env.item_id, first: 'pass', current: 'pass', attempts: 2 }]);
  assert.deepEqual([rep.history.superseded_on_arrival, rep.counts.verified_simulated_pass, rep.counts.escalate, rep.counts.repeat_attempts], [1, 1, 0, 1]);
  const h = await history(r, ctx);
  assert.deepEqual(h.observations.map((o) => [o.seq, o.attempt, o.outcome]), [[1, 1, 'pass'], [2, 2, 'escalate']]);
});

test('ordering: a newer failure supersedes an older pass, so an old pass can never hold an item that was sent back', async () => {
  const env = await envelopeFor(PW, msg('evt-synthetic-hc'));
  const pass = await attempt(PW, env, { at: T1 });
  const fail = await attempt(PW, env, { at: T2, down: true });
  const r = reporting(); const ctx = await rptCtx();
  ok(await r.submit(ctx, [pass, fail]));
  const rep = reportOf(await r.report(ctx));
  assert.deepEqual(rep.statuses, [{ item_id: env.item_id, first: 'pass', current: 'escalate', attempts: 2 }]);
  assert.deepEqual(rep.current, { pass: 0, rework: 0, escalate: 1, chain_conflict: 0 });
  assert.equal(rep.counts.verified_simulated_pass, 1);   // the first outcome is still what the counts say
});

test('ordering: equal verdict times never promote an item, in either arrival order', async () => {
  for (const order of ['pass-first', 'fail-first'] as const) {
    const env = await envelopeFor(PW, msg(`evt-synthetic-htie${order}`));
    const pass = await attempt(PW, env, { at: T1 });
    const fail = await attempt(PW, env, { at: T1, down: true });
    const r = reporting(); const ctx = await rptCtx();
    ok(await r.submit(ctx, order === 'pass-first' ? [pass, fail] : [fail, pass]));
    const rep = reportOf(await r.report(ctx));
    assert.equal(rep.statuses[0].current, 'escalate', order);
    assert.equal(rep.statuses[0].attempts, 2, order);
  }
});

test('ordering: statuses can be re-derived for any earlier point of the log, deterministically', async () => {
  const env = await envelopeFor(PW, msg('evt-synthetic-hd'));
  const a1 = await attempt(PW, env, { at: T1, down: true });
  const a2 = await attempt(PW, env, { at: T2 });
  const a3 = await attempt(PW, env, { at: T3, down: true });
  const r = reporting(); const ctx = await rptCtx();
  ok(await r.submit(ctx, [a1, a2, a3]));
  const log = (await history(r, ctx)).observations;
  assert.deepEqual([1, 2, 3].map((n) => deriveStatuses(log, n).statuses[0].current_outcome), ['escalate', 'pass', 'escalate']);
  assert.deepEqual(deriveStatuses(log), deriveStatuses([...log]));
  assert.deepEqual(deriveStatuses([], 5).statuses, []);
});

// ---------------------------------------------------------------- broken chains
test('broken chains: an attempt whose links do not hold is recorded but never becomes the status over an earlier observation', async () => {
  const env = await envelopeFor(PW, msg('evt-synthetic-he'));
  const good = await attempt(PW, env, { at: T1 });
  const other = await attempt(PW, env, { at: T2 });
  const forged: Triple = { envelope: env, candidate: other.candidate, verdict: good.verdict };   // a verdict for a different candidate
  const r = reporting(); const ctx = await rptCtx();
  const s = ok(await r.submit(ctx, [good, forged]));
  assert.deepEqual([s.accepted, s.repeat_attempts, s.refused], [1, 1, 0]);
  const rep = reportOf(await r.report(ctx));
  assert.deepEqual(rep.statuses, [{ item_id: env.item_id, first: 'pass', current: 'pass', attempts: 2 }]);
  assert.deepEqual([rep.history.chain_rejected, rep.counts.chain_conflict], [1, 0]);
  const h = await history(r, ctx);
  assert.equal(h.observations[1].outcome, 'chain_conflict');
  assert.ok(h.observations[1].broken.includes('candidate_digest'));
});

test('broken chains: a first observation that is a conflict is replaced by a later, newer, valid one, and the conflict stays on record', async () => {
  const env = await envelopeFor(PW, msg('evt-synthetic-hf'));
  const one = await attempt(PW, env, { at: T1 });
  const two = await attempt(PW, env, { at: T2 });
  const r = reporting(); const ctx = await rptCtx();
  ok(await r.submit(ctx, [{ envelope: env, candidate: one.candidate, verdict: two.verdict }, two]));
  const rep = reportOf(await r.report(ctx));
  assert.deepEqual(rep.statuses, [{ item_id: env.item_id, first: 'chain_conflict', current: 'pass', attempts: 2 }]);
  assert.deepEqual([rep.counts.chain_conflict, rep.counts.verified_simulated_pass], [1, 0]);
  assert.equal(rep.exceptions[0].kind, 'chain_conflict');
});

test('broken chains: forged, unsealed or copied objects are refused and add nothing to the history', async () => {
  const env = await envelopeFor(PW, msg('evt-synthetic-hg'));
  const good = await attempt(PW, env, { at: T1 });
  const r = reporting(); const ctx = await rptCtx();
  const s = ok(await r.submit(ctx, [
    { ...good, verdict: structuredClone(good.verdict) },
    { ...good, candidate: { ...structuredClone(good.candidate) } },
    { envelope: { ...structuredClone(env), item_id: 'wi-000000000000' }, candidate: good.candidate, verdict: good.verdict },
    { envelope: env, candidate: good.candidate },
    'not a triple',
  ]));
  assert.deepEqual([s.accepted, s.refused], [0, 5]);
  const h = await history(r, ctx);
  assert.deepEqual([h.observations.length, h.verified], [0, true]);
  const rep = reportOf(await r.report(ctx));
  assert.deepEqual([rep.history.observations, rep.history.head_digest], [0, GENESIS_DIGEST]);
});

// ---------------------------------------------------------------- replay
test('replay: the same candidate again, in the same or another call or with a re-run verdict, appends nothing', async () => {
  const env = await envelopeFor(PW, msg('evt-synthetic-hh'));
  const t = await attempt(PW, env, { at: T1 });
  const r = reporting(); const ctx = await rptCtx();
  ok(await r.submit(ctx, [t, t]));
  const headBefore = (await history(r, ctx)).observations;
  assert.equal(headBefore.length, 1);
  const again = ok(await r.submit(ctx, [t]));
  assert.deepEqual([again.duplicates, again.accepted, again.repeat_attempts], [1, 0, 0]);
  const qc = createQcEntry({ plan: ['mock-note'], readers: { 'mock-note': createMockNoteTool().reader }, now: () => T3, timeoutMs: 50 });
  const rerun = await qc.run(await mintCtx(PW, 'quality-control', 'corr-hist-rerun', [QC_RUN_SCOPE, MOCK_NOTE_READ_SCOPE]), t.candidate, env);
  assert.equal(rerun.ok, true);
  const s = ok(await r.submit(ctx, [{ envelope: env, candidate: t.candidate, verdict: (rerun as any).verdict }]));
  assert.deepEqual([s.duplicates, s.accepted], [1, 0]);
  const after = (await history(r, ctx)).observations;
  assert.deepEqual(after, headBefore);
  const rep = reportOf(await r.report(ctx));
  assert.deepEqual([rep.counts.submitted, rep.counts.duplicates, rep.counts.repeat_attempts, rep.history.observations], [4, 3, 0, 1]);
});

test('replay: report() and history() are repeatable and the log is not changed by reading it', async () => {
  const env = await envelopeFor(PW, msg('evt-synthetic-hi'));
  const r = reporting(); const ctx = await rptCtx();
  ok(await r.submit(ctx, [await attempt(PW, env, { at: T1 }), await attempt(PW, env, { at: T2, down: true })]));
  const a = reportOf(await r.report(ctx)); const b = reportOf(await r.report(ctx));
  assert.deepEqual(a, b);
  assert.deepEqual((await history(r, ctx)).observations, (await history(r, ctx)).observations);
});

// ---------------------------------------------------------------- the log itself
test('log: observations are frozen, hash-linked and verifiable; an edited, removed, reordered, inserted or duplicated entry fails verification', async () => {
  const r = reporting(); const ctx = await rptCtx();
  const env = await envelopeFor(PW, msg('evt-synthetic-hj'));
  const other = await envelopeFor(PW, msg('evt-synthetic-hk'));
  ok(await r.submit(ctx, [await attempt(PW, env, { at: T1 }), await attempt(PW, other, { at: T1 }), await attempt(PW, env, { at: T2 })]));
  const h = await history(r, ctx);
  const log = h.observations as Observation[];
  assert.equal(h.verified, true);
  assert.equal(log.length, 3);
  assert.deepEqual(log.map((o) => o.seq), [1, 2, 3]);
  assert.deepEqual(log.map((o) => o.attempt), [1, 1, 2]);
  assert.equal(log[0].previous_digest, GENESIS_DIGEST);
  assert.equal(log[1].previous_digest, log[0].digest);
  assert.ok(log.every((o) => Object.isFrozen(o) && Object.isFrozen(o.checks) && Object.isFrozen(o.broken)));
  assert.equal(verifyObservationLog(log), true);
  const copy = () => JSON.parse(JSON.stringify(log));
  const edited = copy(); edited[0].outcome = 'pass'; edited[0].verdict_at = T3;
  assert.equal(verifyObservationLog(edited), false);
  const editedKeepingDigest = copy(); editedKeepingDigest[1].qc_correlation_id = 'corr-forged';
  assert.equal(verifyObservationLog(editedKeepingDigest), false);
  assert.equal(verifyObservationLog(copy().slice(1)), false);
  assert.equal(verifyObservationLog(copy().slice(0, 2)), true);                 // a shorter prefix is still a valid log
  const reordered = copy(); [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  assert.equal(verifyObservationLog(reordered), false);
  const inserted = copy(); inserted.splice(1, 0, copy()[0]);
  assert.equal(verifyObservationLog(inserted), false);
  const duplicated = copy(); duplicated.push({ ...duplicated[0] });
  assert.equal(verifyObservationLog(duplicated), false);
  assert.deepEqual([verifyObservationLog(null), verifyObservationLog({}), verifyObservationLog([null]), verifyObservationLog([1])], [false, false, false, false]);
  assert.equal(verifyObservationLog([]), true);
  assert.throws(() => { (log[0] as any).outcome = 'pass'; });
  assert.throws(() => { (log[0].checks as any[]).push({ check: 'x', reason: 'y' }); });
});

const draftOf = (digest: string, item = 'wi-aaaaaaaaaaaa', over: Record<string, unknown> = {}) => ({
  item_id: item, candidate_digest: digest, outcome: 'pass' as const, checks: [], broken: [], intake_correlation_id: 'i', processing_correlation_id: 'p', qc_correlation_id: 'q', verdict_at: T1, recorded_at: CLOCK, ...over,
});
const obs = (draft: any): Disposition => ({ kind: 'observation', draft });

test('log: the ledger refuses a repeated digest and an over-long attempt history on its own, and a bad cap fails at setup', () => {
  const ledger = createInMemoryReportingLedger({ maxAttempts: 2 });
  assert.equal(ledger.record('t', obs(draftOf('d1'))).kind, 'appended');
  assert.deepEqual(ledger.record('t', obs(draftOf('d1'))), { kind: 'duplicate' });
  assert.equal(ledger.record('t', obs(draftOf('d2'))).kind, 'appended');
  assert.deepEqual(ledger.record('t', obs(draftOf('d3'))), { kind: 'refused', code: 'ATTEMPT_LIMIT' });
  assert.equal(ledger.record('t', obs(draftOf('d4', 'wi-bbbbbbbbbbbb'))).kind, 'appended');
  const s = ledger.snapshot('t');
  assert.equal(s.log.length, 3);
  assert.equal(verifyObservationLog(s.log), true);
  assert.equal(snapshotIsConsistent(s), true);
  for (const bad of [0, -1, 1.5, 1001, '2', NaN]) assert.throws(() => createInMemoryReportingLedger({ maxAttempts: bad as any }), RangeError);
  for (const bad of [0, 1001, 'x']) assert.throws(() => reporting({ maxAttempts: bad }), RangeError);
});

// ---------------------------------------------------------------- one atomic record per triple
test('atomic record: every outcome of a triple is counted as submitted in the same operation, and the invariant holds after every call', () => {
  const ledger = createInMemoryReportingLedger({ maxAttempts: 2 });
  const steps: Disposition[] = [
    obs(draftOf('a1')), obs(draftOf('a1')), { kind: 'refused', code: 'TRIPLE_INVALID' }, obs(draftOf('a2')), obs(draftOf('a3')),
    obs(draftOf('b1', 'wi-bbbbbbbbbbbb', { outcome: 'chain_conflict', broken: ['item_id'] })), { kind: 'refused', code: 'TENANT_MISMATCH' }, { kind: 'refused', code: 'TRIPLE_INVALID' },
  ];
  const kinds: string[] = [];
  for (const d of steps) {
    kinds.push(ledger.record('t', d).kind);
    const s = ledger.snapshot('t');
    assert.equal(snapshotIsConsistent(s), true);
    assert.equal(s.tally.submitted, s.log.length + s.tally.duplicates + s.tally.refused);
  }
  assert.deepEqual(kinds, ['appended', 'duplicate', 'refused', 'appended', 'refused', 'appended', 'refused', 'refused']);
  const s = ledger.snapshot('t');
  assert.deepEqual([s.tally.submitted, s.tally.duplicates, s.tally.refused, s.log.length], [8, 1, 4, 3]);
  assert.deepEqual([...s.tally.refusals].sort(), [['ATTEMPT_LIMIT', 1], ['TENANT_MISMATCH', 1], ['TRIPLE_INVALID', 2]]);
  assert.deepEqual(ledger.snapshot('other'), { log: [], tally: { submitted: 0, duplicates: 0, refused: 0, refusals: new Map() }, head: { seq: 0, digest: GENESIS_DIGEST } });
});

test('atomic record: a malformed disposition throws before anything changes, so nothing is counted', () => {
  const ledger = createInMemoryReportingLedger();
  ledger.record('t', obs(draftOf('d1')));
  const before = ledger.snapshot('t');
  const bad: unknown[] = [
    null, 'x', {}, { kind: 'other' }, { kind: 'refused' }, { kind: 'refused', code: 'lower case' }, { kind: 'refused', code: 'X'.repeat(41) }, { kind: 'observation' }, { kind: 'observation', draft: null },
    obs(draftOf('d2', 'wi-aaaaaaaaaaaa', { outcome: 'done' })), obs(draftOf('d2', 'wi-aaaaaaaaaaaa', { verdict_at: 'yesterday' })), obs(draftOf('d2', 'wi-aaaaaaaaaaaa', { recorded_at: 5 })),
    obs(draftOf('d2', 'wi-aaaaaaaaaaaa', { extra: 1 })), obs(draftOf('', 'wi-aaaaaaaaaaaa')), obs(draftOf('d2', 'wi-aaaaaaaaaaaa', { checks: [{ check: 'a' }] })), obs(draftOf('d2', 'wi-aaaaaaaaaaaa', { broken: 'x' })),
    obs(draftOf('d2', 'wi-aaaaaaaaaaaa', { checks: Array.from({ length: 21 }, () => ({ check: 'c', reason: 'r' })) })),
  ];
  for (const d of bad) assert.throws(() => ledger.record('t', d as any), TypeError, JSON.stringify(d));
  assert.throws(() => ledger.record('', obs(draftOf('d2'))), TypeError);
  assert.throws(() => ledger.snapshot(''), TypeError);
  assert.deepEqual(ledger.snapshot('t'), before);
  assert.equal(snapshotIsConsistent(before), true);
});

test('atomic record: if hashing fails after the checks, the book is exactly as it was', () => {
  const ledger = createInMemoryReportingLedger();
  ledger.record('t', obs(draftOf('d1')));
  const before = ledger.snapshot('t');
  const hostile: any = draftOf('d2');
  hostile.checks = [{ check: 'c', get reason(): string { throw new Error(CANARY); } }];
  assert.throws(() => ledger.record('t', obs(hostile)));
  assert.deepEqual(ledger.snapshot('t'), before);
  assert.equal(ledger.record('t', obs(draftOf('d2'))).kind, 'appended');   // the digest was not reserved by the failed attempt
});

test('atomic record: snapshotIsConsistent rejects numbers that do not agree', () => {
  const ledger = createInMemoryReportingLedger();
  ledger.record('t', obs(draftOf('d1'))); ledger.record('t', obs(draftOf('d1'))); ledger.record('t', { kind: 'refused', code: 'TRIPLE_INVALID' });
  const s = ledger.snapshot('t');
  assert.equal(snapshotIsConsistent(s), true);
  const bent = (f: (x: any) => void) => { const x: any = { log: [...s.log], tally: { ...s.tally, refusals: new Map(s.tally.refusals) }, head: { ...s.head } }; f(x); return snapshotIsConsistent(x); };
  assert.equal(bent((x) => { x.tally.submitted++; }), false);
  assert.equal(bent((x) => { x.tally.duplicates++; }), false);
  assert.equal(bent((x) => { x.tally.refusals.set('TRIPLE_INVALID', 2); }), false);
  assert.equal(bent((x) => { x.head.seq = 5; }), false);
  assert.equal(bent((x) => { x.head.digest = GENESIS_DIGEST; }), false);
  assert.equal(bent((x) => { x.log = []; }), false);
  assert.equal(snapshotIsConsistent(null as any), false);
});

// ---------------------------------------------------------------- the injected ledger
/** A ledger that delegates to a real one and misbehaves on demand. */
function flaky(over: { failOn?: number[]; after?: boolean; snapshot?: (real: LedgerSnapshot) => unknown; record?: (d: Disposition, real: RecordResult) => unknown } = {}) {
  const real = createInMemoryReportingLedger();
  let n = 0;
  const ledger: ReportingLedger = {
    record(tenant, d) {
      n++;
      if (over.failOn?.includes(n) && !over.after) throw new Error(CANARY);
      const r = real.record(tenant, d);
      if (over.failOn?.includes(n) && over.after) throw new Error(CANARY);
      return (over.record ? over.record(d, r) : r) as RecordResult;
    },
    snapshot: (tenant) => (over.snapshot ? over.snapshot(real.snapshot(tenant)) : real.snapshot(tenant)) as LedgerSnapshot,
  };
  return { ledger, real, calls: () => n };
}

test('injected ledger: Reporting uses the ledger it is given, and history and statuses are the same as with the default', async () => {
  const env = await envelopeFor(PW, msg('evt-synthetic-hp'));
  const a1 = await attempt(PW, env, { at: T1, down: true });
  const a2 = await attempt(PW, env, { at: T2 });
  const mine = createInMemoryReportingLedger();
  const withInjected = reporting({ ledger: mine }); const withDefault = reporting();
  const ctx = await rptCtx();
  for (const r of [withInjected, withDefault]) ok(await r.submit(ctx, [a1, a2, a1]));
  assert.deepEqual(reportOf(await withInjected.report(ctx)), reportOf(await withDefault.report(ctx)));
  assert.equal(mine.snapshot(PW).log.length, 2);
  assert.deepEqual([mine.snapshot(PW).tally.submitted, mine.snapshot(PW).tally.duplicates], [3, 1]);
  // Two entries over one ledger share one history (the shape a durable ledger will have after a restart).
  const second = reporting({ ledger: mine });
  const s = ok(await second.submit(ctx, [a1, a2]));
  assert.deepEqual([s.duplicates, s.accepted], [2, 0]);
  assert.deepEqual(reportOf(await second.report(ctx)).statuses, [{ item_id: env.item_id, first: 'escalate', current: 'pass', attempts: 2 }]);
});

test('injected ledger: bad ledgers and a cap given twice fail at startup without echoing values', () => {
  for (const bad of [null, 5, 'x', {}, { record: () => 1 }, { snapshot: () => 1 }, { record: 1, snapshot: 2 }]) {
    assert.throws(() => reporting({ ledger: bad }), (e: Error) => e instanceof RangeError && !e.message.includes('x'));
  }
  assert.throws(() => reporting({ ledger: createInMemoryReportingLedger(), maxAttempts: 3 }), RangeError);
  assert.doesNotThrow(() => reporting({ ledger: createInMemoryReportingLedger({ maxAttempts: 3 }) }));
});

test('injected ledger: a ledger that fails on one triple stops the call, counts nothing for that triple, and a re-send repairs it', async () => {
  const env1 = await envelopeFor(PW, msg('evt-synthetic-hq'));
  const env2 = await envelopeFor(PW, msg('evt-synthetic-hr'));
  const env3 = await envelopeFor(PW, msg('evt-synthetic-hs'));
  const t1 = await attempt(PW, env1, { at: T1 }); const t2 = await attempt(PW, env2, { at: T1 }); const t3 = await attempt(PW, env3, { at: T1 });
  for (const after of [false, true]) {
    const f = flaky({ failOn: [2], after });
    const r = reporting({ ledger: f.ledger }); const ctx = await rptCtx();
    const res: any = await r.submit(ctx, [t1, t2, t3]);
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'LEDGER_UNAVAILABLE');
    assert.ok(!res.error.message.includes('CANARY') && !JSON.stringify(res).includes(PW));
    assert.equal(f.calls(), 2, 'the call stopped at the failure');
    // Whatever the ledger did or did not keep, the report it gives is internally consistent.
    const mid = reportOf(await r.report(ctx));
    assert.equal(mid.counts.submitted, mid.counts.counted_items + mid.counts.refused + mid.counts.duplicates + mid.counts.repeat_attempts);
    // Sending the same batch again is safe: what was recorded is a duplicate, the rest is added once.
    const again = ok(await r.submit(ctx, [t1, t2, t3]));
    assert.equal(again.accepted + again.duplicates, 3);
    const rep = reportOf(await r.report(ctx));
    assert.deepEqual([rep.counts.counted_items, rep.history.observations, rep.counts.repeat_attempts], [3, 3, 0], `after=${after}`);
    assert.deepEqual(rep.current, { pass: 3, rework: 0, escalate: 0, chain_conflict: 0 });
  }
});

test('injected ledger: a failure while recording a refusal also stops the call, and nothing leaks', async () => {
  const f = flaky({ failOn: [1] });
  const r = reporting({ ledger: f.ledger }); const ctx = await rptCtx();
  const res: any = await r.submit(ctx, ['not a triple', 'again']);
  assert.deepEqual([res.ok, res.error.code], [false, 'LEDGER_UNAVAILABLE']);
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.real.snapshot(PW).tally.submitted, 0);
});

test('injected ledger: a ledger that answers wrongly is treated as unavailable, never trusted', async () => {
  const env = await envelopeFor(PW, msg('evt-synthetic-ht'));
  const t = await attempt(PW, env, { at: T1 });
  const lies: Array<(d: Disposition, real: RecordResult) => unknown> = [
    () => undefined, () => 'appended', () => ({ kind: 'weird' }),
    (d) => (d.kind === 'observation' ? { kind: 'refused', code: 'OTHER_CODE' } : { kind: 'refused', code: 'X' }),
    (d, real) => (real.kind === 'appended' ? { kind: 'appended', observation: { ...real.observation, item_id: 'wi-000000000000' } } : real),
    (d, real) => (real.kind === 'appended' ? { kind: 'appended', observation: { ...real.observation, attempt: 0 } } : real),
  ];
  for (const lie of lies) {
    const f = flaky({ record: lie });
    const r = reporting({ ledger: f.ledger }); const ctx = await rptCtx();
    const res: any = await r.submit(ctx, [t]);
    assert.deepEqual([res.ok, res.error?.code], [false, 'LEDGER_UNAVAILABLE'], String(lie));
  }
});

test('injected ledger: a snapshot that is inconsistent, forged or from another tenant makes report and history fail closed', async () => {
  const env = await envelopeFor(PW, msg('evt-synthetic-hu'));
  const t = await attempt(PW, env, { at: T1 });
  const bends: Record<string, (s: LedgerSnapshot) => unknown> = {
    'submitted too high': (s) => ({ ...s, tally: { ...s.tally, submitted: s.tally.submitted + 1 } }),
    'refusal total off': (s) => ({ ...s, tally: { ...s.tally, refused: 1 } }),
    'head not the last': (s) => ({ ...s, head: { seq: 7, digest: s.head.digest } }),
    'edited entry': (s) => ({ ...s, log: s.log.map((o) => ({ ...o, outcome: 'escalate' })) }),
    'another tenant': (s) => ({ ...s, log: s.log.map((o) => ({ ...o, workspace_id: DW })) }),
    'not a snapshot': () => 'nope',
    'no log': (s) => ({ ...s, log: null }),
    'null': () => null,
  };
  for (const [name, bend] of Object.entries(bends)) {
    const f = flaky({ snapshot: bend });
    const r = reporting({ ledger: f.ledger }); const ctx = await rptCtx();
    ok(await r.submit(ctx, [t]));
    const rep: any = await r.report(ctx); const h: any = await r.history(ctx);
    assert.deepEqual([rep.ok, rep.error?.code, h.ok, h.error?.code], [false, 'REPORT_ERROR', false, 'REPORT_ERROR'], name);
    assert.ok(!JSON.stringify([rep, h]).includes(DW), name);
  }
});

test('injected ledger: a ledger that throws on read gives REPORT_ERROR, and telemetry about it cannot break the call', async () => {
  const events: any[] = [];
  const f = flaky({ snapshot: () => { throw new Error(CANARY); } });
  const r = reporting({ ledger: f.ledger, sink: { write: (e: unknown) => { events.push(e); throw new Error(CANARY); } } }); const ctx = await rptCtx();
  const rep: any = await r.report(ctx);
  assert.deepEqual([rep.ok, rep.error.code], [false, 'REPORT_ERROR']);
  assert.ok(!JSON.stringify(rep).includes('CANARY'));
  assert.ok(events.length >= 1);
});

test('injected ledger: a bad clock is refused before anything is counted', async () => {
  const f = flaky();
  const env = await envelopeFor(PW, msg('evt-synthetic-hv'));
  const t = await attempt(PW, env, { at: T1 });
  for (const bad of ['', 'now', 5, null]) {
    const r = createReportingEntry({ now: (() => bad) as any, ledger: f.ledger }); const ctx = await rptCtx();
    const res: any = await r.submit(ctx, [t]);
    assert.deepEqual([res.ok, res.error.code], [false, 'REPORT_ERROR']);
  }
  assert.equal(f.calls(), 0);
  assert.equal(f.real.snapshot(PW).tally.submitted, 0);
});

test('attempt cap: attempts over the cap are refused with a fixed code, tallied, and never change the history or the arithmetic', async () => {
  const env = await envelopeFor(PW, msg('evt-synthetic-hl'));
  const r = reporting({ maxAttempts: 2 }); const ctx = await rptCtx();
  const s = ok(await r.submit(ctx, [await attempt(PW, env, { at: T1 }), await attempt(PW, env, { at: T2 }), await attempt(PW, env, { at: T3 })]));
  assert.deepEqual([s.accepted, s.repeat_attempts, s.refused], [1, 1, 1]);
  const rep = reportOf(await r.report(ctx));
  assert.deepEqual(rep.refusals, [{ code: 'ATTEMPT_LIMIT', count: 1 }]);
  assert.deepEqual([rep.counts.submitted, rep.history.observations], [3, 2]);
});

// ---------------------------------------------------------------- tenants
test('tenant isolation: each tenant has its own log and statuses; a foreign triple is refused and leaves no trace; history needs Reporting authority', async () => {
  const r = reporting();
  const pctx = await rptCtx(PW); const dctx = await rptCtx(DW, [REPORTING_RUN_SCOPE], 'corr-hist-d');
  const penv = await envelopeFor(PW, msg('evt-synthetic-hm'));
  const denv = await envelopeFor(DW, dmsg);
  const pt = await attempt(PW, penv, { at: T1 });
  const dt = await attempt(DW, denv, { at: T1, down: true });
  ok(await r.submit(pctx, [pt]));
  ok(await r.submit(dctx, [dt]));
  const foreign = ok(await r.submit(pctx, [dt]));
  assert.deepEqual([foreign.accepted, foreign.refused], [0, 1]);
  const ph = await history(r, pctx); const dh = await history(r, dctx);
  assert.deepEqual([ph.observations.length, dh.observations.length], [1, 1]);
  assert.ok(ph.observations.every((o) => o.workspace_id === PW) && dh.observations.every((o) => o.workspace_id === DW));
  assert.ok(!JSON.stringify(ph.observations).includes(DW) && !JSON.stringify(ph.observations).includes(denv.item_id));
  const prep = reportOf(await r.report(pctx)); const drep = reportOf(await r.report(dctx));
  assert.deepEqual([prep.current.pass, prep.current.escalate, drep.current.pass, drep.current.escalate], [1, 0, 0, 1]);
  assert.deepEqual(prep.refusals, [{ code: 'TENANT_MISMATCH', count: 1 }]);
  assert.deepEqual(drep.refusals, []);
  // The same candidate reported by the other tenant is not a duplicate there: replay protection is per tenant.
  const second = reporting(); const x = await rptCtx(PW, [REPORTING_RUN_SCOPE], 'corr-hist-x');
  ok(await second.submit(x, [pt]));
  assert.equal((await history(second, x)).observations.length, 1);
  // Authority.
  for (const bad of [await rptCtx(PW, []), await mintCtx(PW, 'processing', 'corr-hist-p', [REPORTING_RUN_SCOPE]), { workspace_id: PW, agent: 'reporting', scopes: [REPORTING_RUN_SCOPE] }, null, undefined]) {
    const res: any = await r.history(bad);
    assert.equal(res.ok, false);
    assert.ok(!JSON.stringify(res).includes(PW));
  }
});

// ---------------------------------------------------------------- privacy and the contract
test('privacy: the history and the report hold ids, digests, fixed words and times only', async () => {
  const env = await envelopeFor(PW, msg('evt-synthetic-hn'));
  const r = reporting(); const ctx = await rptCtx();
  ok(await r.submit(ctx, [await attempt(PW, env, { at: T1, down: true }), await attempt(PW, env, { at: T2 })]));
  const h = await history(r, ctx);
  const rep = reportOf(await r.report(ctx));
  for (const o of h.observations) {
    assert.deepEqual(Object.keys(o).sort(), ['attempt', 'broken', 'candidate_digest', 'checks', 'digest', 'intake_correlation_id', 'item_id', 'outcome', 'previous_digest', 'processing_correlation_id', 'qc_correlation_id', 'recorded_at', 'seq', 'verdict_at', 'workspace_id']);
  }
  for (const text of [JSON.stringify(h.observations), JSON.stringify(rep)]) {
    for (const leak of [CANARY, '[ADDRESS_1]', 'Burst pipe repair', 'Emergency leak', 'channel-hist-test', 'mock-note:']) assert.ok(!text.includes(leak), leak);
  }
});

test('report.v1: the validator rejects a tampered history, current counts or statuses', async () => {
  const env = await envelopeFor(PW, msg('evt-synthetic-ho'));
  const r = reporting(); const ctx = await rptCtx();
  ok(await r.submit(ctx, [await attempt(PW, env, { at: T1, down: true }), await attempt(PW, env, { at: T2 })]));
  const rep = reportOf(await r.report(ctx));
  const mutate = (f: (x: any) => void) => { const x = JSON.parse(JSON.stringify(rep)); f(x); return validateReport(x); };
  assert.deepEqual(mutate(() => {}), []);
  const cases: Record<string, (x: any) => void> = {
    'unverified log': (x) => { x.history.verified = false; },
    'short head': (x) => { x.history.head_seq = 1; },
    'bad digest': (x) => { x.history.head_digest = 'nope'; },
    'wrong observation total': (x) => { x.history.observations = 5; x.history.head_seq = 5; },
    'too many set aside': (x) => { x.history.superseded_on_arrival = 9; },
    'current does not cover items': (x) => { x.current.pass = 2; },
    'unknown current outcome': (x) => { x.statuses[0].current = 'done'; },
    'zero attempts': (x) => { x.statuses[0].attempts = 0; },
    'duplicate item status': (x) => { x.statuses.push({ ...x.statuses[0] }); },
    'missing status': (x) => { x.statuses = []; },
    'extra key': (x) => { x.history.note = 'x'; },
    'missing history': (x) => { delete x.history; },
    'missing current': (x) => { delete x.current; },
    'missing statuses': (x) => { delete x.statuses; },
  };
  for (const [name, f] of Object.entries(cases)) assert.notDeepEqual(mutate(f), [], name);
  assert.equal(rep.refusals.length, 0);
});

test('inventory: the history is built from contracts.ts and handoff-seal.ts only and does no I/O', () => {
  const src = readFileSync(new URL('../src/reporting-ledger.ts', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import .* from '(.+)';$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['./contracts.ts', './handoff-seal.ts']);
  for (const banned of ['node:', 'fetch(', 'process.', 'setTimeout', 'Math.random', 'Date.now', 'new Date(']) assert.ok(!src.includes(banned), banned);
});
