// The controlled synthetic pipeline (proof of concept, mock agents only): one request in, Intake -> Processing -> Quality
// Control -> Reporting out. It is the only place that decides how a request's identity moves between the four agents.
//
//   per request, in this order:
//     1. verify the credential ONCE and select ONE tenant ONCE (both bounded by a timeout; the answers are cached for this
//        request, so all four contexts share the same verified actor and the same tenant);
//     2. mint four contexts, one per agent, each with only that agent's scopes: whatever the grants source allows, cut down to
//        a fixed per-agent allow-list set at setup (it can narrow, never widen), each with its own correlation id;
//        if any mint fails, nothing runs;
//     3. run the stages in order, each bounded by `stageTimeoutMs`, stopping at the first refusal, failure or timeout;
//     4. tripwire: every object a stage returns must name the selected tenant before the next stage sees it.
//   The caller supplies only a credential and a message. It cannot supply a context, an entry, a scope, a plan, a reader or a
//   stage. Every stage still runs its own seal, tenant and scope checks; this file adds no trust and removes none.
//   An Intake `needs-human` item stops the run with that outcome (nothing is handed off, so Reporting cannot count it).
//   A timeout abandons a stage's answer; it cannot cancel work a stage already started (a tool write may still finish).
//   RECOVERY (opt-in: `recoverUncertain: true`, and the QC entry must be able to `reconcile`): when a run ends in an ESCALATION because a
//   human-approved action is uncertain, the first outcome is reported as usual and never changed. Then, once and bounded, QC reconciles
//   (a read-back of the tool-side record that settles the step only on definitive positive evidence). Only if something was settled does the
//   pipeline run ONE fresh verification: Processing again (the store now holds the outcome, so no tool is called), QC again, and Reporting
//   again, where the fresh result is a repeat attempt that cannot replace the first outcome. Unresolved, ambiguous or failed recovery leaves
//   the escalation exactly as it was. Recovery never calls a tool, never loops, and never rewrites a report: the report as it stood before
//   recovery is returned beside the final one.
//   Never throws at request time; bad setup throws a RangeError. Results hold ids, fixed words and counts only.
//   This file is a mint importer (with live-run.ts); it calls no raw runner and imports no network, file, or process APIs.

import { isRecord } from './contracts.ts';
import { mintExecutionContext } from './execution-context.ts';
import type { AgentName, ExecutionContext } from './execution-context.ts';
import type { IntakeEntry } from './intake-entry.ts';
import type { ProcessingEntry } from './processing-entry.ts';
import type { QcEntry, ReconcileResult } from './qc-entry.ts';
import type { ReportingEntry } from './reporting-entry.ts';
import type { ReportV1 } from './report.ts';

export type PipelineErrorCode = 'STAGE_TIMEOUT' | 'PIPELINE_ERROR' | 'CONTEXT_MISMATCH';
export type StageName = 'auth' | 'intake' | 'processing' | 'qc' | 'reporting';
export type StageStatus = 'passed' | 'needs-human' | 'awaiting-approval' | 'refused' | 'failed' | 'not-run';
export interface StageRecord { stage: StageName; status: StageStatus; code?: string }
export interface CorrelationIds { intake: string; processing: string; qc: string; reporting: string }
/** What recovery did. Present only when it was attempted. `first` is the outcome that was reported before recovery and is never changed. */
export interface RecoverySummary {
  readonly attempted: true;
  /** True when at least one in-doubt step was recorded as succeeded on definitive evidence. */
  readonly settled: boolean;
  readonly steps: readonly { readonly index: number; readonly outcome: string; readonly reason?: string }[];
  readonly first: { readonly verdict: 'pass' | 'rework' | 'escalate'; readonly counted: 'accepted' | 'duplicate' | 'repeat' };
  /** The one fresh verification, when something was settled. */
  readonly fresh?: { readonly verdict: 'pass' | 'rework' | 'escalate'; readonly counted: 'accepted' | 'duplicate' | 'repeat' };
  /** Why recovery stopped without a fresh verification, as a fixed word. */
  readonly stopped?: 'RECONCILE_FAILED' | 'NOTHING_SETTLED' | 'FRESH_FAILED';
}
export type PipelineResult =
  | { ok: true; outcome: 'reported'; item_id: string; verdict: 'pass' | 'rework' | 'escalate'; counted: 'accepted' | 'duplicate' | 'repeat'; stages: StageRecord[]; correlation_ids: CorrelationIds; report: Readonly<ReportV1>; recovery?: RecoverySummary; prior_report?: Readonly<ReportV1> }
  | { ok: true; outcome: 'needs-human'; stages: StageRecord[]; correlation_ids: CorrelationIds }
  | { ok: true; outcome: 'awaiting-approval'; pending: Readonly<Record<string, unknown>>; stages: StageRecord[]; correlation_ids: CorrelationIds }
  | { ok: false; stage: StageName; error: { code: string; message: string }; stages: StageRecord[]; correlation_ids?: Partial<CorrelationIds> };

/** The trusted sources, supplied at setup. Same shape the minting function expects, except one run uses each source once. */
export interface PipelineSources {
  verify(credential: unknown): unknown;
  selectTenant(identity: Readonly<{ kind: string; id: string }>): unknown;
  grants(identity: Readonly<{ kind: string; id: string }>, workspaceId: string, agent: AgentName): unknown;
  newCorrelationId(): string;
}
export interface PipelineConfig {
  intake: IntakeEntry;
  processing: ProcessingEntry;
  qc: QcEntry;
  reporting: ReportingEntry;
  sources: PipelineSources;
  /** Scopes the Processing context may hold besides `processing:run` (its tool scopes). */
  processingToolScopes: readonly string[];
  /** Scopes the QC context may hold besides `quality-control:run` (its evidence-reader scopes). */
  qcReaderScopes: readonly string[];
  /** Per stage and per trusted-source call, 1 to 60000 ms (default 10000). */
  stageTimeoutMs?: number;
  /** Opt in to one bounded recovery of an escalated uncertain human-approved action (see the header). Needs `qc.reconcile`. Default false. */
  recoverUncertain?: boolean;
}
export interface Pipeline { run(credential: unknown, message: unknown): Promise<PipelineResult> }

const SCOPE_LIKE = /^[a-z][a-z0-9_.:-]{0,63}$/;
const TEXT: Record<string, string> = {
  STAGE_TIMEOUT: 'A stage did not answer in time; later stages did not run.',
  PIPELINE_ERROR: 'The request could not be processed; later stages did not run.',
  CONTEXT_MISMATCH: 'A stage returned something that does not belong to the selected tenant; the run was stopped.',
};
const STAGES: readonly StageName[] = ['auth', 'intake', 'processing', 'qc', 'reporting'];

class Timeout extends Error {}
function bounded<T>(work: () => T | Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Timeout()), ms); });
  const call = Promise.resolve().then(work);
  call.catch(() => {});   // a late failure after a timeout must not become an unhandled rejection
  return Promise.race([call, timeout]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}
function scopeList(list: unknown, what: string): string[] {
  if (!Array.isArray(list)) throw new RangeError(`${what} must be a list of scopes`);
  const out: string[] = [];
  for (const s of [...(list as unknown[])]) {
    if (typeof s !== 'string' || !SCOPE_LIKE.test(s) || out.includes(s)) throw new RangeError(`${what} has a scope that is not allowed`);
    out.push(s);
  }
  return out;
}
function deepFreezeSummary<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const c of Object.values(v as Record<string, unknown>)) deepFreezeSummary(c); }
  return v;
}
function hasFns(o: unknown, names: string[]): boolean { return isRecord(o) && names.every((n) => typeof (o as Record<string, unknown>)[n] === 'function'); }
const tenantOf = (x: unknown): unknown => (isRecord(x) ? (x as Record<string, unknown>).workspace_id : undefined);

export function createPipeline(config: PipelineConfig): Pipeline {
  if (!isRecord(config)) throw new RangeError('pipeline configuration must be an object');
  const { intake, processing, qc, reporting, sources, processingToolScopes, qcReaderScopes, stageTimeoutMs, recoverUncertain } = config;
  if (!hasFns(intake, ['run']) || !hasFns(processing, ['run']) || !hasFns(qc, ['run']) || !hasFns(reporting, ['submit', 'report'])) throw new RangeError('every stage entry must be provided');
  if (!hasFns(sources, ['verify', 'selectTenant', 'grants', 'newCorrelationId'])) throw new RangeError('every trusted source must be provided');
  if (stageTimeoutMs !== undefined && (!Number.isInteger(stageTimeoutMs) || stageTimeoutMs < 1 || stageTimeoutMs > 60_000)) throw new RangeError('stageTimeoutMs must be an integer from 1 to 60000');
  const limit = stageTimeoutMs ?? 10_000;
  if (recoverUncertain !== undefined && typeof recoverUncertain !== 'boolean') throw new RangeError('recoverUncertain must be true or false');
  const recover = recoverUncertain === true;
  if (recover && typeof (qc as { reconcile?: unknown }).reconcile !== 'function') throw new RangeError('recovery needs a QC entry that can reconcile');

  // Fixed per-agent scope allow-lists. The grants source can only narrow these.
  const allow: Readonly<Record<AgentName, readonly string[]>> = Object.freeze({
    intake: Object.freeze(['intake:run']),
    processing: Object.freeze(['processing:run', ...scopeList(processingToolScopes, 'processingToolScopes')]),
    'quality-control': Object.freeze(['quality-control:run', ...scopeList(qcReaderScopes, 'qcReaderScopes')]),
    reporting: Object.freeze(['reporting:run']),
  });
  const stageIntake = intake; const stageProcessing = processing; const stageQc = qc; const stageReporting = reporting;
  const src = sources;

  /** Auth first, then every other stage in order; a stage that never ran is reported as not-run. */
  function fill(stages: StageRecord[]): StageRecord[] {
    return [...stages.filter((r) => r.stage === 'auth'), ...STAGES.filter((s) => s !== 'auth').map((s) => stages.find((r) => r.stage === s) ?? { stage: s, status: 'not-run' as StageStatus })];
  }
  function fail(stage: StageName, code: string, stages: StageRecord[], ids?: Partial<CorrelationIds>): PipelineResult {
    return { ok: false, stage, error: { code, message: TEXT[code] ?? `The ${stage} stage refused the request; later stages did not run.` }, stages: fill(stages), ...(ids ? { correlation_ids: ids } : {}) };
  }

  async function runInner(credential: unknown, message: unknown): Promise<PipelineResult> {
    const stages: StageRecord[] = [];

    // 1 and 2. Verify once, select one tenant once, then mint four restricted contexts.
    let verifyPromise: Promise<unknown> | undefined;
    let tenantPromise: Promise<unknown> | undefined;
    const deps = {
      verify: (c: unknown) => (verifyPromise ??= bounded(() => src.verify(c), limit)),
      selectTenant: (identity: Readonly<{ kind: never; id: string }>) => (tenantPromise ??= bounded(() => src.selectTenant(identity), limit)),
      grants: async (identity: Readonly<{ kind: never; id: string }>, ws: string, agent: AgentName) => {
        const granted: unknown = await bounded(() => src.grants(identity, ws, agent), limit);
        return Array.isArray(granted) ? [...(granted as unknown[])].filter((s) => typeof s === 'string' && allow[agent].includes(s)) : granted;
      },
      newCorrelationId: () => src.newCorrelationId(),
    };
    const agents: AgentName[] = ['intake', 'processing', 'quality-control', 'reporting'];
    const ctx: Partial<Record<AgentName, ExecutionContext>> = {};
    for (const agent of agents) {
      let minted: Awaited<ReturnType<typeof mintExecutionContext>>;
      try { minted = await mintExecutionContext({ credential, agent }, deps as never); } catch { stages.push({ stage: 'auth', status: 'failed', code: 'PIPELINE_ERROR' }); return fail('auth', 'PIPELINE_ERROR', stages); }
      if (!minted.ok) { stages.push({ stage: 'auth', status: 'refused', code: minted.error.code }); return fail('auth', minted.error.code, stages); }
      ctx[agent] = minted.context;
    }
    const [ci, cp, cq, cr] = [ctx.intake, ctx.processing, ctx['quality-control'], ctx.reporting] as ExecutionContext[];
    const ids: CorrelationIds = { intake: ci.correlation_id, processing: cp.correlation_id, qc: cq.correlation_id, reporting: cr.correlation_id };
    const tenant = ci.workspace_id;
    const same = [cp, cq, cr].every((c) => c.workspace_id === tenant && c.actor.id === ci.actor.id && c.actor.kind === ci.actor.kind);
    if (!same || new Set(Object.values(ids)).size !== 4) { stages.push({ stage: 'auth', status: 'failed', code: 'CONTEXT_MISMATCH' }); return fail('auth', 'CONTEXT_MISMATCH', stages, ids); }
    stages.push({ stage: 'auth', status: 'passed' });

    // Runs one stage with a bound; any throw or timeout becomes a typed failure.
    async function stage<T>(name: StageName, work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; result: PipelineResult }> {
      try { return { ok: true, value: await bounded(work, limit) }; }
      catch (e) {
        const code = e instanceof Timeout ? 'STAGE_TIMEOUT' : 'PIPELINE_ERROR';
        stages.push({ stage: name, status: 'failed', code });
        return { ok: false, result: fail(name, code, stages, ids) };
      }
    }
    const refused = (name: StageName, code: unknown): PipelineResult => {
      const c = typeof code === 'string' ? code : 'PIPELINE_ERROR';
      stages.push({ stage: name, status: 'refused', code: c });
      return fail(name, c, stages, ids);
    };
    const mismatch = (name: StageName): PipelineResult => { stages.push({ stage: name, status: 'failed', code: 'CONTEXT_MISMATCH' }); return fail(name, 'CONTEXT_MISMATCH', stages, ids); };

    // 3a. Intake.
    const a = await stage('intake', () => stageIntake.run(ci, message));
    if (!a.ok) return a.result;
    const ir: unknown = a.value;
    if (!isRecord(ir) || (ir as Record<string, unknown>).ok !== true) return refused('intake', isRecord(ir) && isRecord(ir.error) ? ir.error.code : undefined);
    if ((ir as Record<string, unknown>).outcome === 'needs-human' || !isRecord(ir.handoff)) {
      stages.push({ stage: 'intake', status: 'needs-human' });
      return { ok: true, outcome: 'needs-human', stages: fill(stages), correlation_ids: ids };
    }
    const envelope = ir.handoff as Record<string, unknown>;
    if (tenantOf(envelope) !== tenant) return mismatch('intake');
    stages.push({ stage: 'intake', status: 'passed' });

    // 3b. Processing.
    const b = await stage('processing', () => stageProcessing.run(cp, envelope));
    if (!b.ok) return b.result;
    const pr: unknown = b.value;
    if (isRecord(pr) && pr.ok === true && isRecord(pr.pending)) {
      // A human-approved step is waiting (or another run is carrying it out). Nothing is handed on; the same message run again resumes it.
      stages.push({ stage: 'processing', status: 'awaiting-approval' });
      return { ok: true, outcome: 'awaiting-approval', pending: pr.pending as Readonly<Record<string, unknown>>, stages: fill(stages), correlation_ids: ids };
    }
    if (!isRecord(pr) || pr.ok !== true || !isRecord(pr.candidate)) return refused('processing', isRecord(pr) && isRecord(pr.error) ? pr.error.code : undefined);
    const candidate = pr.candidate as Record<string, unknown>;
    if (tenantOf(candidate) !== tenant) return mismatch('processing');
    stages.push({ stage: 'processing', status: 'passed' });

    // 3c. Quality Control.
    const c = await stage('qc', () => stageQc.run(cq, candidate, envelope));
    if (!c.ok) return c.result;
    const qr: unknown = c.value;
    if (!isRecord(qr) || qr.ok !== true || !isRecord(qr.verdict)) return refused('qc', isRecord(qr) && isRecord(qr.error) ? qr.error.code : undefined);
    const verdict = qr.verdict as Record<string, unknown>;
    if (tenantOf(verdict) !== tenant) return mismatch('qc');
    stages.push({ stage: 'qc', status: 'passed' });

    // 3d. Reporting: submit the triple, then read the tenant's report.
    const d = await stage('reporting', async () => {
      const s = await stageReporting.submit(cr, [{ envelope, candidate, verdict }]);
      if (!isRecord(s) || s.ok !== true) return { refusal: isRecord(s) && isRecord(s.error) ? s.error.code : undefined };
      if (s.refused !== 0) return { refusal: 'PIPELINE_ERROR' };
      const r = await stageReporting.report(cr);
      if (!isRecord(r) || r.ok !== true) return { refusal: isRecord(r) && isRecord(r.error) ? r.error.code : undefined };
      return { counted: s.duplicates > 0 ? 'duplicate' as const : s.repeat_attempts > 0 ? 'repeat' as const : 'accepted' as const, report: r.report as ReportV1 };
    });
    if (!d.ok) return d.result;
    const out = d.value as { refusal?: unknown; counted?: 'accepted' | 'duplicate' | 'repeat'; report?: ReportV1 };
    if (out.report === undefined || out.counted === undefined) return refused('reporting', out.refusal);
    if (out.report.workspace_id !== tenant) return mismatch('reporting');
    stages.push({ stage: 'reporting', status: 'passed' });
    const base = {
      ok: true as const, outcome: 'reported' as const, item_id: envelope.item_id as string, verdict: verdict.verdict as 'pass' | 'rework' | 'escalate',
      counted: out.counted, correlation_ids: ids, report: out.report,
    };

    // 4. Recovery, only when asked for and only for an ESCALATION caused by an uncertain human-approved step. The outcome above is already reported.
    const uncertainHuman = (candidate.steps as unknown[] | undefined)?.some((s) => isRecord(s) && s.approval === 'human' && s.status === 'uncertain') === true;
    if (!recover || base.verdict !== 'escalate' || !uncertainHuman) return { ...base, stages: fill(stages) };
    const first = { verdict: base.verdict, counted: base.counted };
    const attempt = async <T>(work: () => Promise<T>): Promise<T | undefined> => { try { return await bounded(work, limit); } catch { return undefined; } };

    const rec = (await attempt(() => stageQc.reconcile(cq, envelope))) as ReconcileResult | undefined;
    if (!isRecord(rec) || rec.ok !== true || !Array.isArray(rec.steps)) {
      return { ...base, stages: fill(stages), recovery: deepFreezeSummary({ attempted: true, settled: false, steps: [], first, stopped: 'RECONCILE_FAILED' }), prior_report: out.report };
    }
    const summarySteps = (rec.steps as unknown[]).filter(isRecord).map((s, index) => ({ index, outcome: String(s.outcome), ...(typeof s.reason === 'string' ? { reason: s.reason } : {}) }));
    const settled = (rec.steps as unknown[]).some((s) => isRecord(s) && s.outcome === 'resolved');
    if (!settled) {
      return { ...base, stages: fill(stages), recovery: deepFreezeSummary({ attempted: true, settled: false, steps: summarySteps, first, stopped: 'NOTHING_SETTLED' }), prior_report: out.report };
    }

    // One fresh verification. Processing finds the recorded outcome and calls no tool; QC judges the new candidate; Reporting files it as a repeat.
    const stopFresh = (): PipelineResult => ({ ...base, stages: fill(stages), recovery: deepFreezeSummary({ attempted: true, settled: true, steps: summarySteps, first, stopped: 'FRESH_FAILED' }), prior_report: out.report });
    const again = (await attempt(() => stageProcessing.run(cp, envelope))) as Record<string, unknown> | undefined;
    if (!isRecord(again) || again.ok !== true || !isRecord(again.candidate) || tenantOf(again.candidate) !== tenant) return stopFresh();
    const candidate2 = again.candidate as Record<string, unknown>;
    const qr2 = (await attempt(() => stageQc.run(cq, candidate2, envelope))) as Record<string, unknown> | undefined;
    if (!isRecord(qr2) || qr2.ok !== true || !isRecord(qr2.verdict) || tenantOf(qr2.verdict) !== tenant) return stopFresh();
    const verdict2 = qr2.verdict as Record<string, unknown>;
    const filed = (await attempt(async () => {
      const s = await stageReporting.submit(cr, [{ envelope, candidate: candidate2, verdict: verdict2 }]);
      if (!isRecord(s) || s.ok !== true || s.refused !== 0) return undefined;
      const r = await stageReporting.report(cr);
      return isRecord(r) && r.ok === true ? { counted: s.duplicates > 0 ? 'duplicate' as const : s.repeat_attempts > 0 ? 'repeat' as const : 'accepted' as const, report: r.report as ReportV1 } : undefined;
    })) as { counted: 'accepted' | 'duplicate' | 'repeat'; report: ReportV1 } | undefined;
    if (!filed || filed.report.workspace_id !== tenant) return stopFresh();
    const fresh = { verdict: verdict2.verdict as 'pass' | 'rework' | 'escalate', counted: filed.counted };
    return {
      ...base, verdict: fresh.verdict, counted: fresh.counted, report: filed.report, stages: fill(stages),
      recovery: deepFreezeSummary({ attempted: true, settled: true, steps: summarySteps, first, fresh }), prior_report: out.report,
    };
  }

  async function run(credential: unknown, message: unknown): Promise<PipelineResult> {
    try { return await runInner(credential, message); }
    catch { return { ok: false, stage: 'auth', error: { code: 'PIPELINE_ERROR', message: TEXT.PIPELINE_ERROR }, stages: [{ stage: 'auth', status: 'failed', code: 'PIPELINE_ERROR' }] }; }
  }

  return Object.freeze({ run });
}
