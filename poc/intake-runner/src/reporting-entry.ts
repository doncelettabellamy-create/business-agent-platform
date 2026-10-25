// The Reporting entry (proof of concept, mock simulation only). It builds a report.v1 for ONE tenant from sealed
// Intake -> Processing -> QC chains and counts a result as a verified simulated pass only when it re-derives the links itself.
//
//   submit(ctx, triples): each triple is { envelope, candidate, verdict }. Every object must be the sealed original from its
//     own producer (Intake entry, Processing entry, QC entry), copied once, and valid for its contract. Anything else is
//     REFUSED (tallied by code only; the input is never read further, so a forged object adds no id or text to the report).
//   Reporting does NOT trust the verdict's claims: it recomputes the digests and the correlation chain from the sealed
//     envelope and candidate. A pass verdict whose chain does not hold is a `chain_conflict`, never a pass.
//   Replay and history: a per-tenant APPEND-ONLY, hash-linked observation log (reporting-ledger.ts). The same candidate again is a
//     duplicate and appends nothing. A different candidate for an item already seen is a distinct attempt: it IS appended (a repeat
//     attempt in the counts) and can never change the item's FIRST outcome, which stays what the counts, chains and exceptions show.
//     The report adds a verified CURRENT status per item, derived from the log by QC verdict time, not arrival (see the ledger header);
//     a chain that does not hold is recorded but never becomes the current status over an earlier observation. An item over the
//     attempt cap is refused (ATTEMPT_LIMIT). In memory only: a restart loses the history and reopens replay (needs the database, R13).
//   Tenant: the tenant comes only from the minted Reporting context. A triple for any other tenant is refused.
//   Privacy: the ledger and the report hold ids, fixed words and integers only. Envelope payloads (category, fields) are
//     validated but never copied.
//   Read-only: no tools, no evidence readers, no minting, no runners. Never throws at request time; bad setup throws a RangeError.
//   This is a view, not the audit record: a seal proves origin and integrity inside one process, not that the work was real.

import { isRecord, TIMESTAMP, validateEnvelope } from './contracts.ts';
import type { HandoffEnvelopeV1 } from './contracts.ts';
import { validateCandidate } from './candidate-result.ts';
import type { CandidateResultV1 } from './candidate-result.ts';
import { can, isTrusted } from './execution-context.ts';
import type { ContextErrorCode } from './execution-context.ts';
import { contentDigest, isSealedCandidate, isSealedHandoff, isSealedVerdict } from './handoff-seal.ts';
import { createEmitter } from './observability.ts';
import type { Sink } from './observability.ts';
import { BASIS, NOT_MEASURED, REFUSAL_CODES, REPORT_CONTRACT, validateReport } from './report.ts';
import type { ReportChain, ReportException, ReportV1 } from './report.ts';
import { createInMemoryReportingLedger, deriveStatuses, snapshotIsConsistent } from './reporting-ledger.ts';
import type { Disposition, LedgerSnapshot, Observation, ObservationDraft, RecordResult, ReportingLedger } from './reporting-ledger.ts';
import { validateVerdict } from './qc-verdict.ts';
import type { QcVerdictV1 } from './qc-verdict.ts';

export const REPORTING_RUN_SCOPE = 'reporting:run';

export type ReportingErrorCode =
  | 'REPORT_NOT_PERMITTED' | 'BATCH_INVALID' | 'REPORT_ERROR' | 'LEDGER_UNAVAILABLE' | 'TRIPLE_INVALID' | 'VERDICT_NOT_TRUSTED' | 'VERDICT_INVALID';
type RefusalCode = ReportingErrorCode | ContextErrorCode;
export interface ReportingRefusal { ok: false; error: { code: RefusalCode; message: string } }
export type SubmitResult = { ok: true; submitted: number; accepted: number; duplicates: number; repeat_attempts: number; refused: number } | ReportingRefusal;
export type ReportResult = { ok: true; report: Readonly<ReportV1> } | ReportingRefusal;
export type HistoryResult = { ok: true; observations: readonly Observation[]; verified: boolean } | ReportingRefusal;

const TEXT: Record<string, string> = {
  REPORT_NOT_PERMITTED: 'The caller is not permitted to run Reporting; nothing was counted.',
  BATCH_INVALID: 'The batch is not a list of the allowed size; nothing was counted.',
  REPORT_ERROR: 'The request could not be processed; nothing was counted.',
  LEDGER_UNAVAILABLE: 'The history could not be written, so processing stopped. Items earlier in this call may already be recorded; sending the same call again is safe because repeats are ignored.',
  CONTEXT_NOT_TRUSTED: 'A trusted execution context is required; nothing was counted.',
  WRONG_RECIPIENT: 'This agent is not the recipient; refused.',
};
function refuse(code: RefusalCode): ReportingRefusal { return { ok: false, error: { code, message: TEXT[code] ?? TEXT.REPORT_ERROR } }; }

export interface ReportingEntryConfig {
  now: () => string;
  /** Most triples per submit call, 1 to 1000 (default 100). */
  maxBatch?: number;
  /** Most entries in each list of a report, 1 to 1000 (default 200). Longer lists are cut and flagged. */
  maxList?: number;
  sink?: Sink;
  /** Most attempts kept per item, 1 to 1000 (default 20). Further attempts are refused (ATTEMPT_LIMIT). */
  maxAttempts?: number;
  /**
   * Where the history lives (default: a new in-memory ledger). Its only write is `record`, one atomic operation per triple, so the
   * tallies can never drift from the log. When a ledger is given, the attempt cap is the ledger's own: do not also pass `maxAttempts`.
   */
  ledger?: ReportingLedger;
}
export interface ReportingEntry {
  submit(ctx: unknown, triples: unknown): Promise<SubmitResult>;
  report(ctx: unknown): Promise<ReportResult>;
  /** The caller's own tenant's append-only observation log (frozen entries), with whether its hash chain verifies. Read-only. */
  history(ctx: unknown): Promise<HistoryResult>;
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const c of Object.values(v as Record<string, unknown>)) deepFreeze(c); }
  return v;
}
function int(v: unknown, lo: number, hi: number, fallback: number, what: string): number {
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw new RangeError(`${what} must be an integer from ${lo} to ${hi}`);
  return v;
}

export function createReportingEntry(config: ReportingEntryConfig): ReportingEntry {
  if (!isRecord(config)) throw new RangeError('reporting configuration must be an object');
  const { now, maxBatch, maxList, sink, maxAttempts, ledger: injected } = config;
  if (typeof now !== 'function') throw new RangeError('now must be a function');
  const batchLimit = int(maxBatch, 1, 1000, 100, 'maxBatch');
  const listLimit = int(maxList, 1, 1000, 200, 'maxList');
  if (sink !== undefined && (!isRecord(sink) || typeof sink.write !== 'function')) throw new RangeError('sink must have a write function');
  const clock = now;
  const fixedSink: Sink | undefined = sink === undefined ? undefined : Object.freeze({ write: (e) => sink.write(e) });
  if (injected !== undefined && (!isRecord(injected) || typeof injected.record !== 'function' || typeof injected.snapshot !== 'function')) throw new RangeError('ledger must provide record and snapshot');
  if (injected !== undefined && maxAttempts !== undefined) throw new RangeError('maxAttempts belongs to the ledger when one is given');
  const base: ReportingLedger = injected ?? createInMemoryReportingLedger({ maxAttempts });   // a bad cap throws a RangeError here, at setup
  const ledger: ReportingLedger = Object.freeze({ record: (tenant, d) => base.record(tenant, d), snapshot: (tenant) => base.snapshot(tenant) });

  /** The ledger is a dependency, not a trusted part: its answers are checked before they are used. */
  function sane(r: unknown, sent: Disposition): r is RecordResult {
    if (!isRecord(r)) return false;
    if (sent.kind === 'refused') return r.kind === 'refused' && r.code === sent.code;
    if (r.kind === 'duplicate') return true;
    if (r.kind === 'refused') return r.code === 'ATTEMPT_LIMIT';
    return r.kind === 'appended' && isRecord(r.observation) && r.observation.item_id === sent.draft.item_id && r.observation.candidate_digest === sent.draft.candidate_digest
      && typeof r.observation.attempt === 'number' && r.observation.attempt >= 1;
  }
  /** One tenant's consistent view, or null when the ledger answered with anything that does not hold together. */
  function view(tenant: string): LedgerSnapshot | null {
    const s: unknown = base.snapshot(tenant);
    if (!isRecord(s) || !Array.isArray(s.log) || !isRecord(s.tally) || !isRecord(s.head)) return null;
    const snap = s as unknown as LedgerSnapshot;
    if (!snap.log.every((o) => isRecord(o) && o.workspace_id === tenant)) return null;
    return snapshotIsConsistent(snap) ? snap : null;
  }
  function tell(ctx: unknown, event: Record<string, unknown>): void {
    if (fixedSink === undefined) return;
    try { const made = createEmitter(ctx, fixedSink, { now: clock }); if (made.ok) made.emitter.emit(event); } catch { /* telemetry must not affect the run */ }
  }
  /** Authority first. Returns the tenant, or a refusal. */
  function authorize(ctx: unknown): { tenant: string } | ReportingRefusal {
    if (!isTrusted(ctx)) return refuse('CONTEXT_NOT_TRUSTED');
    if (ctx.agent !== 'reporting') return refuse('WRONG_RECIPIENT');
    if (!can(ctx, REPORTING_RUN_SCOPE)) return refuse('REPORT_NOT_PERMITTED');
    return { tenant: ctx.workspace_id };
  }

  /** Judges one triple and says what is to be recorded for it: a refusal code, or an observation. Touches nothing. */
  function judge(tenant: string, raw: unknown, recordedAt: string): Disposition {
    const j = judgeRaw(tenant, raw, recordedAt);
    return 'refused' in j ? { kind: 'refused', code: j.refused } : { kind: 'observation', draft: j.draft };
  }
  function judgeRaw(tenant: string, raw: unknown, recordedAt: string): { refused: string } | { draft: ObservationDraft } {
    if (!isRecord(raw)) return { refused: 'TRIPLE_INVALID' };
    const t: Record<string, unknown> = { ...raw };
    const keys = Object.keys(t).sort().join(',');
    if (keys !== 'candidate,envelope,verdict') return { refused: 'TRIPLE_INVALID' };
    let envC: unknown; let candC: unknown; let verC: unknown;
    try { envC = structuredClone(t.envelope); } catch { return { refused: 'ENVELOPE_INVALID' }; }
    try { candC = structuredClone(t.candidate); } catch { return { refused: 'CANDIDATE_INVALID' }; }
    try { verC = structuredClone(t.verdict); } catch { return { refused: 'VERDICT_INVALID' }; }
    if (!isSealedHandoff(t.envelope, envC)) return { refused: 'HANDOFF_NOT_TRUSTED' };
    if (!isSealedCandidate(t.candidate, candC)) return { refused: 'CANDIDATE_NOT_TRUSTED' };
    if (!isSealedVerdict(t.verdict, verC)) return { refused: 'VERDICT_NOT_TRUSTED' };
    if (validateEnvelope(envC).length > 0) return { refused: 'ENVELOPE_INVALID' };
    if (validateCandidate(candC).length > 0) return { refused: 'CANDIDATE_INVALID' };
    if (validateVerdict(verC).length > 0) return { refused: 'VERDICT_INVALID' };
    const env = envC as HandoffEnvelopeV1; const cand = candC as CandidateResultV1; const ver = verC as QcVerdictV1;
    if (env.workspace_id !== tenant || cand.workspace_id !== tenant || ver.workspace_id !== tenant) return { refused: 'TENANT_MISMATCH' };

    // Replay is decided on the candidate itself, not on anything the verdict claims; the ledger applies it atomically.
    const digest = contentDigest(cand);

    // Independent re-derivation of the links.
    const broken: ReportException['broken'] = [];
    if (ver.candidate_digest !== digest) broken.push('candidate_digest');
    if (cand.handoff_digest !== contentDigest(env)) broken.push('handoff_digest');
    if (ver.parent_correlation_id !== cand.correlation_id || cand.parent_correlation_id !== env.correlation_id) broken.push('parent_chain');
    if (ver.item_id !== cand.item_id || cand.item_id !== env.item_id) broken.push('item_id');
    if (new Set([env.correlation_id, cand.correlation_id, ver.correlation_id]).size !== 3) broken.push('correlation_ids');
    if (ver.verdict === 'pass' && cand.status !== 'complete') broken.push('candidate_status');

    const outcome: ReportChain['outcome'] = broken.length > 0 ? 'chain_conflict' : ver.verdict;
    const checks: ReportException['checks'] = outcome === 'rework' || outcome === 'escalate'
      ? ver.checks.flatMap((c) => (c.result !== 'pass' && c.reason !== undefined ? [{ check: c.check, reason: c.reason }] : []))
      : [];
    return {
      draft: {
        item_id: cand.item_id, candidate_digest: digest, outcome, checks, broken,
        intake_correlation_id: env.correlation_id, processing_correlation_id: cand.correlation_id, qc_correlation_id: ver.correlation_id,
        verdict_at: ver.created_at, recorded_at: recordedAt,
      },
    };
  }

  async function submit(ctx: unknown, triples: unknown): Promise<SubmitResult> {
    let result: SubmitResult;
    try {
      const auth = authorize(ctx);
      if ('ok' in auth) result = auth;
      else if (!Array.isArray(triples) || triples.length < 1 || triples.length > batchLimit) result = refuse('BATCH_INVALID');
      else {
        const list: unknown[] = [...(triples as unknown[])];
        const at: unknown = clock();
        if (typeof at !== 'string' || !TIMESTAMP.test(at)) result = refuse('REPORT_ERROR');
        else {
          const tally = { accepted: 0, duplicates: 0, repeat_attempts: 0, refused: 0 };
          let stopped = false;
          for (const raw of list) {
            let d: Disposition;
            try { d = judge(auth.tenant, raw, at); } catch { d = { kind: 'refused', code: 'TRIPLE_INVALID' }; }
            let r: unknown;
            try { r = ledger.record(auth.tenant, d); } catch { stopped = true; break; }    // nothing of this triple was counted; stop, keep what was recorded
            if (!sane(r, d)) { stopped = true; break; }
            if (r.kind === 'refused') tally.refused++;
            else if (r.kind === 'duplicate') tally.duplicates++;
            else if (r.observation.attempt > 1) tally.repeat_attempts++;
            else tally.accepted++;
          }
          result = stopped ? refuse('LEDGER_UNAVAILABLE') : { ok: true, submitted: list.length, ...tally };
        }
      }
    } catch { result = refuse('REPORT_ERROR'); }
    tell(ctx, result.ok ? { event: 'run.finished', counts: { attempts: result.submitted } } : { event: 'run.refused', error_code: result.error.code });
    return result;
  }

  async function report(ctx: unknown): Promise<ReportResult> {
    let result: ReportResult;
    try {
      const auth = authorize(ctx);
      if ('ok' in auth) result = auth;
      else {
        const c = ctx as { correlation_id: string };
        const createdAt: unknown = clock();
        if (typeof createdAt !== 'string' || !TIMESTAMP.test(createdAt)) result = refuse('REPORT_ERROR');
        else {
          const v = view(auth.tenant);
          if (v === null) throw new Error('ledger');
          const { log, tally, head } = v;
          const derived = deriveStatuses(log);
          const firsts = log.filter((o) => o.attempt === 1);                       // the first outcome of every item, in arrival order
          const count = (o: string) => firsts.filter((e) => e.outcome === o).length;
          const currentCount = (o: string) => derived.statuses.filter((s) => s.current_outcome === o).length;
          const exceptions = firsts.filter((e) => e.outcome !== 'pass');
          const refusals = REFUSAL_CODES.flatMap((code) => (tally.refusals.has(code) ? [{ code, count: tally.refusals.get(code) as number }] : []));
          const report: ReportV1 = {
            contract: REPORT_CONTRACT, workspace_id: auth.tenant, correlation_id: c.correlation_id, created_at: createdAt, produced_by: 'reporting', basis: BASIS,
            counts: {
              submitted: tally.submitted, counted_items: firsts.length, verified_simulated_pass: count('pass'), rework: count('rework'), escalate: count('escalate'),
              chain_conflict: count('chain_conflict'), refused: tally.refused, duplicates: tally.duplicates, repeat_attempts: log.length - firsts.length,
            },
            exceptions: exceptions.slice(0, listLimit).map((e) => ({ item_id: e.item_id, kind: e.outcome as ReportException['kind'], checks: e.checks.map((k) => ({ ...k })) as ReportException['checks'], broken: [...e.broken] as ReportException['broken'] })),
            chains: firsts.slice(0, listLimit).map((e): ReportChain => ({ item_id: e.item_id, outcome: e.outcome, intake_correlation_id: e.intake_correlation_id, processing_correlation_id: e.processing_correlation_id, qc_correlation_id: e.qc_correlation_id })),
            history: { observations: log.length, head_seq: head.seq, head_digest: head.digest, verified: true, superseded_on_arrival: derived.superseded_on_arrival, chain_rejected: derived.chain_rejected },
            current: { pass: currentCount('pass'), rework: currentCount('rework'), escalate: currentCount('escalate'), chain_conflict: currentCount('chain_conflict') },
            statuses: derived.statuses.slice(0, listLimit).map((s) => ({ item_id: s.item_id, first: s.first_outcome, current: s.current_outcome, attempts: s.attempts })),
            refusals, lists_truncated: exceptions.length > listLimit || firsts.length > listLimit, not_measured: [...NOT_MEASURED],
          };
          result = validateReport(report).length > 0 ? refuse('REPORT_ERROR') : { ok: true, report: deepFreeze(report) };
        }
      }
    } catch { result = refuse('REPORT_ERROR'); }
    tell(ctx, result.ok ? { event: 'run.finished', counts: { attempts: result.report.counts.submitted } } : { event: 'run.refused', error_code: result.error.code });
    return result;
  }

  async function history(ctx: unknown): Promise<HistoryResult> {
    try {
      const auth = authorize(ctx);
      if ('ok' in auth) return auth;
      const v = view(auth.tenant);
      if (v === null) return refuse('REPORT_ERROR');
      return { ok: true, observations: v.log, verified: true };
    } catch { return refuse('REPORT_ERROR'); }
  }

  return Object.freeze({ submit, report, history });
}
