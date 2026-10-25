// The Quality Control entry (proof of concept, mock evidence only). It judges a Processing candidate by evidence Processing
// did not write, never by the candidate's own claims.
//
//   Independent sources: (1) the sealed Intake envelope (issued by the Intake entry), (2) QC's own minted context,
//   (3) QC's own expected plan and recomputed step ids, (4) the tool-side evidence readers (private store, read-only).
//   The candidate is only a claim to check; it is sealed by the Processing entry so its origin and integrity are known, but
//   a seal says nothing about whether its claims are TRUE. Truth comes only from the readers.
//
//   Refused with no verdict (the input is not a fair thing to judge): untrusted or wrong-agent context, missing scopes (the
//   QC scope AND every reader's scope, checked before anything is read), a candidate or envelope that is not the sealed
//   original, an invalid contract, a tenant that is not the context's.
//   Judged: nine named checks, six about the work and three about the human approval behind it (see below). A check that cannot be completed (reader missing, throwing, hanging, malformed) is
//   `unverifiable`, which escalates. Pass needs every check to pass. Nothing here edits the candidate (it is a frozen copy).
//   The verdict holds fixed words and ids only. Never throws at request time; bad setup throws a RangeError.
//
//   RECONCILE (a separate operation, `reconcile(ctx, envelope)`; judging never changes anything): for a human-approved step whose claim
//   lapsed to IN-DOUBT, QC does a bounded read-back of the tool-side system of record (at most two reads per step, each bounded) and
//   settles the step in the approval store ONLY on definitive POSITIVE evidence: exactly one record for that step, in this tenant and
//   item, that a second read confirms, for an action QC computes itself and that a human other than the requester approved. Then (and
//   only then) it asks the store to record `succeeded` with that evidence. It never records "failed" from an absence (a missing record
//   proves nothing: the abandoned call may still land), and keeps the step uncertain when the read-back is missing, ambiguous,
//   duplicated, mismatched, unreadable or fails to record. QC has no access to any tool, so it cannot run the action again.
//   This file mints nothing, calls no runner, and imports no network, file, or process APIs.

import { isRecord, TIMESTAMP, validateEnvelope } from './contracts.ts';
import type { HandoffEnvelopeV1 } from './contracts.ts';
import { stepIdFor, validateCandidate } from './candidate-result.ts';
import type { CandidateResultV1 } from './candidate-result.ts';
import { actionDigest, readAction } from './approval.ts';
import { verifyEventLog } from './approval-store.ts';
import type { ApprovalStore, ApprovalSnapshot, StoreEvent } from './approval-store.ts';
import { can, isTrusted } from './execution-context.ts';
import type { ContextErrorCode } from './execution-context.ts';
import { contentDigest, isSealedCandidate, isSealedHandoff, sealVerdict } from './handoff-seal.ts';
import type { EvidenceReader, EvidenceRecord } from './mock-tools.ts';
import { createEmitter } from './observability.ts';
import type { Sink } from './observability.ts';
import { CHECK_NAMES, QC_CONTRACT, validateVerdict, verdictFor } from './qc-verdict.ts';
import type { CheckRecord, QcVerdictV1 } from './qc-verdict.ts';

export const QC_RUN_SCOPE = 'quality-control:run';

export type QcErrorCode = 'CANDIDATE_NOT_TRUSTED' | 'CANDIDATE_INVALID' | 'QC_NOT_PERMITTED' | 'QC_ERROR';
type RefusalCode = QcErrorCode | ContextErrorCode | 'HANDOFF_NOT_TRUSTED';
export interface QcRefusal { ok: false; error: { code: RefusalCode; message: string } }
export type QcResult = { ok: true; verdict: Readonly<QcVerdictV1> } | QcRefusal;

const TEXT: Record<string, string> = {
  CANDIDATE_NOT_TRUSTED: 'The candidate was not issued by the Processing entry or was changed; nothing was judged.',
  CANDIDATE_INVALID: 'The candidate does not match its contract; nothing was judged.',
  QC_NOT_PERMITTED: 'The caller is not permitted to run Quality Control or read its evidence; nothing was judged.',
  QC_ERROR: 'The request could not be processed; nothing was judged.',
  HANDOFF_NOT_TRUSTED: 'The handoff was not issued by the Intake entry or was changed; nothing was judged.',
  CONTEXT_NOT_TRUSTED: 'A trusted execution context is required; nothing was judged.',
  WRONG_RECIPIENT: 'This agent is not the recipient; refused.',
  ENVELOPE_INVALID: 'The handoff envelope is not valid; refused.',
  TENANT_MISMATCH: 'The input does not belong to this tenant; refused.',
};
function refuse(code: RefusalCode): QcRefusal { return { ok: false, error: { code, message: TEXT[code] ?? TEXT.QC_ERROR } }; }

/** What Quality Control may do with the approval store: look. It has no way to decide, claim, complete or settle anything. */
export type ReadOnlyApprovals = Pick<ApprovalStore, 'findByStep' | 'events'>;
/** The one thing QC may change in the approval store, and only inside `reconcile`: record the outcome of an in-doubt claim. */
export type SettleOnly = Pick<ApprovalStore, 'resolve'>;
export interface QcApprovalConfig {
  /** Needed only for `reconcile`. Without it QC can judge but never settle. */
  settle?: SettleOnly;
  store: ReadOnlyApprovals;
  /** The human-approved tools QC expects in the plan, with the arguments that were approved (plain JSON). Build it from the tool registry. */
  tools: Readonly<Record<string, { arguments: unknown }>>;
}
export interface QcEntryConfig {
  /** The expected plan: ordered tool names, fixed at setup, from QC's own configuration (never from the candidate). */
  plan: readonly string[];
  /** One evidence reader per planned tool. */
  readers: Readonly<Record<string, EvidenceReader>>;
  now: () => string;
  /** Per reader call, 1 to 30000 ms (default 5000). */
  timeoutMs?: number;
  sink?: Sink;
  /** Needed when the plan has a human-approved tool. Read-only. */
  approvals?: QcApprovalConfig;
}
export type ReconcileReason = 'NO_RECORD' | 'AMBIGUOUS' | 'READ_FAILED' | 'MISMATCH' | 'NOT_APPROVED' | 'IN_PROGRESS' | 'RESOLVE_FAILED' | 'STORE_UNREADABLE';
export interface ReconcileStep {
  readonly step_id: string;
  readonly tool: string;
  /** resolved: recorded as succeeded on definitive evidence. still_uncertain: nothing was changed. not_applicable: not an in-doubt claim. */
  readonly outcome: 'resolved' | 'still_uncertain' | 'not_applicable';
  readonly reason?: ReconcileReason;
  readonly evidence_ref?: string;
}
export type ReconcileResult = { ok: true; steps: readonly ReconcileStep[] } | QcRefusal;
export interface QcEntry {
  run(ctx: unknown, candidate: unknown, envelope: unknown): Promise<QcResult>;
  reconcile(ctx: unknown, envelope: unknown): Promise<ReconcileResult>;
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const c of Object.values(v as Record<string, unknown>)) deepFreeze(c); }
  return v;
}
class ReadFailure extends Error {}

export function createQcEntry(config: QcEntryConfig): QcEntry {
  if (!isRecord(config)) throw new RangeError('QC configuration must be an object');
  const { plan, readers, now, timeoutMs, sink, approvals } = config;
  if (!Array.isArray(plan) || plan.length < 1 || plan.length > 8) throw new RangeError('plan must list 1 to 8 tools');
  const names: string[] = [...(plan as unknown[])].map((n) => { if (typeof n !== 'string' || n.length === 0) throw new RangeError('plan entries must be tool names'); return n; });
  if (new Set(names).size !== names.length) throw new RangeError('plan must not repeat a tool');
  if (!isRecord(readers)) throw new RangeError('readers must be an object');
  const fixedReaders = new Map<string, EvidenceReader>();
  for (const n of names) {
    const r: unknown = Object.hasOwn(readers, n) ? readers[n] : undefined;
    if (!isRecord(r) || typeof r.read !== 'function' || typeof r.list !== 'function' || typeof r.scope !== 'string' || r.scope.length === 0) throw new RangeError('every planned tool needs an evidence reader');
    const rd = r as unknown as EvidenceReader;
    fixedReaders.set(n, Object.freeze({ scope: rd.scope, read: (c, ref) => rd.read.call(r, c, ref), list: (c, item) => rd.list.call(r, c, item) }));
  }
  if (typeof now !== 'function') throw new RangeError('now must be a function');
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)) throw new RangeError('timeoutMs must be an integer from 1 to 30000');
  if (sink !== undefined && (!isRecord(sink) || typeof sink.write !== 'function')) throw new RangeError('sink must have a write function');

  // Human-approved tools: QC's own expectation of which plan steps needed a human, and the action that was approved for each.
  const humanArgs = new Map<string, unknown>();
  let approvalStore: ReadOnlyApprovals | undefined;
  let settler: SettleOnly | undefined;
  if (approvals !== undefined) {
    if (!isRecord(approvals) || !isRecord(approvals.store) || typeof approvals.store.findByStep !== 'function' || typeof approvals.store.events !== 'function' || !isRecord(approvals.tools)) {
      throw new RangeError('approvals must provide a read-only store (findByStep, events) and the human-approved tools');
    }
    const st = approvals.store;
    approvalStore = Object.freeze({ findByStep: (c, i) => st.findByStep(c, i), events: (c, i) => st.events(c, i) });
    if (approvals.settle !== undefined) {
      const cap = approvals.settle as SettleOnly;
      if (!isRecord(cap) || typeof cap.resolve !== 'function') throw new RangeError('settle must provide resolve');
      settler = Object.freeze({ resolve: (c, i, o) => cap.resolve(c, i, o) });
    }
    for (const name of Object.keys(approvals.tools)) {
      if (!names.includes(name)) throw new RangeError('a human-approved tool must be part of the plan');
      const spec: unknown = approvals.tools[name];
      const probe = isRecord(spec) ? readAction({ item_id: 'wi-000000000000', step_id: 'st-000000000000', tool: name, arguments: (spec as Record<string, unknown>).arguments }) : null;
      if (!probe) throw new RangeError('a human-approved tool needs small plain-JSON arguments');
      humanArgs.set(name, probe.arguments);
    }
    if (humanArgs.size > 0 && approvalStore === undefined) throw new RangeError('human-approved tools need an approval store');
  }
  const fixedPlan: readonly string[] = Object.freeze(names);
  const limit = timeoutMs ?? 5000;
  const clock = now;
  const fixedSink: Sink | undefined = sink === undefined ? undefined : Object.freeze({ write: (e) => sink.write(e) });

  function report(ctx: unknown, result: QcResult): void {
    if (fixedSink === undefined) return;
    try {
      const made = createEmitter(ctx, fixedSink, { now: clock });
      if (!made.ok) return;
      if (result.ok) made.emitter.emit({ event: 'run.finished', item_id: result.verdict.item_id, counts: { attempts: result.verdict.checks.length } });
      else {
        const handoffSide = ['HANDOFF_NOT_TRUSTED', 'CANDIDATE_NOT_TRUSTED', 'ENVELOPE_INVALID', 'TENANT_MISMATCH', 'WRONG_RECIPIENT'].includes(result.error.code);
        made.emitter.emit({ event: handoffSide ? 'handoff.refused' : 'run.refused', error_code: result.error.code });
      }
    } catch { /* telemetry must not affect the run */ }
  }

  function bounded<T>(p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ReadFailure()), limit); });
    p.catch(() => {});
    return Promise.race([p, timeout]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
  }
  function validRecord(r: unknown): r is EvidenceRecord {
    return isRecord(r) && typeof r.evidence_ref === 'string' && typeof r.step_id === 'string' && typeof r.item_id === 'string' && typeof r.workspace_id === 'string';
  }

  type R = { result: CheckRecord['result']; reason?: CheckRecord['reason'] };
  const PASS: R = { result: 'pass' };
  const failR = (reason: NonNullable<CheckRecord['reason']>): R => ({ result: 'fail', reason });
  const unverifiable = (reason: NonNullable<CheckRecord['reason']>): R => ({ result: 'unverifiable', reason });
  const worse = (a: R, b: R): R => (a.result === 'unverifiable' ? a : b.result === 'unverifiable' ? b : a.result === 'fail' ? a : b.result === 'fail' ? b : a);

  /** One attempted human-approved step, judged from the approval store alone (read-only). Returns the three human checks. */
  async function judgeHumanStep(ctx: unknown, tool: string, index: number, stepId: string, itemId: string, tenant: string, step: CandidateResultV1['steps'][number]): Promise<{ approval: R; binding: R; completion: R }> {
    const store = approvalStore as ReadOnlyApprovals;
    const all = (r: R) => ({ approval: r, binding: r, completion: r });
    let found: any;
    try { found = await bounded(Promise.resolve(store.findByStep(ctx, stepId))); } catch { return all(unverifiable('READ_FAILED')); }
    if (!isRecord(found) || typeof found.ok !== 'boolean') return all(unverifiable('READ_FAILED'));
    if (found.ok === false) {
      const code = isRecord(found.error) ? found.error.code : undefined;
      return code === 'STORE_NOT_FOUND' ? all(failR('MISSING')) : all(unverifiable('READ_FAILED'));
    }
    const snap = found.snapshot as ApprovalSnapshot | undefined;
    if (!isRecord(snap) || typeof snap.proposal_id !== 'string' || typeof snap.state !== 'string' || typeof snap.requested_by_id !== 'string') return all(unverifiable('READ_FAILED'));

    // action_binding: the approved action is the action QC expects, computed from QC's own configuration, not from the store or the candidate.
    const expected = actionDigest({ workspace_id: tenant, item_id: itemId, step_id: stepId, tool, arguments: humanArgs.get(tool) });
    const binding: R = snap.action_digest === expected && snap.step_id === stepId && snap.item_id === itemId && snap.tool === tool ? PASS : failR('MISMATCH');

    let events: StoreEvent[] | null = null;
    try {
      const ev: any = await bounded(Promise.resolve(store.events(ctx, snap.proposal_id)));
      if (isRecord(ev) && ev.ok === true && Array.isArray(ev.events)) events = ev.events as StoreEvent[];
    } catch { /* handled below */ }
    if (events === null) return { approval: unverifiable('READ_FAILED'), binding, completion: unverifiable('READ_FAILED') };
    const types = events.map((x) => x.type);
    const logOk = verifyEventLog(events) && types[0] === 'requested';

    // human_approval: a human OTHER than the requester approved this action, and before anything was claimed.
    let approval: R;
    if (step.status === 'failed' && step.code === 'APPROVAL_DECLINED') {
      approval = snap.state === 'declined' && snap.decision?.decision === 'declined' && logOk ? PASS : failR('MISMATCH');
    } else {
      const firstClaim = types.indexOf('claimed');
      const approvedAt = types.indexOf('approved');
      approval = snap.decision?.decision === 'approved' && snap.decision.approver_id !== snap.requested_by_id && approvedAt > 0 && (firstClaim === -1 || approvedAt < firstClaim) && logOk
        ? PASS : failR('MISMATCH');
    }

    // durable_completion: what the candidate says happened is what the store durably recorded.
    let completion: R;
    const claims = types.filter((x) => x === 'claimed').length;
    const successes = types.filter((x) => x === 'succeeded').length;
    if (step.status === 'ok') {
      completion = snap.state === 'succeeded' && snap.outcome?.status === 'succeeded' && snap.outcome.evidence_ref === step.evidence_ref
        && successes === 1 && types[types.length - 1] === 'succeeded' && claims >= 1 && claims === snap.attempts && logOk ? PASS : failR('MISMATCH');
    } else if (step.status === 'uncertain') {
      completion = unverifiable('RECORD_UNCERTAIN');                   // the candidate itself does not know; whatever the store says, a human must look
    } else if (step.code === 'APPROVAL_DECLINED') {
      completion = snap.state === 'declined' && claims === 0 ? PASS : failR('MISMATCH');
    } else {
      completion = snap.state === 'failed' && snap.outcome?.status === 'failed' && logOk ? PASS : failR('MISMATCH');
    }
    return { approval, binding, completion };
  }

  async function runInner(ctx: unknown, candidateIn: unknown, envelopeIn: unknown): Promise<QcResult> {
    // 1. Authority first, before any input is touched.
    if (!isTrusted(ctx)) return refuse('CONTEXT_NOT_TRUSTED');
    if (ctx.agent !== 'quality-control') return refuse('WRONG_RECIPIENT');
    if (!can(ctx, QC_RUN_SCOPE)) return refuse('QC_NOT_PERMITTED');
    for (const n of fixedPlan) if (!can(ctx, (fixedReaders.get(n) as EvidenceReader).scope)) return refuse('QC_NOT_PERMITTED');
    const tenant = ctx.workspace_id;

    // 2. Copy each input once; both must be the sealed originals from their own producers.
    let candCopy: unknown; let envCopy: unknown;
    try { candCopy = structuredClone(candidateIn); } catch { return refuse('CANDIDATE_INVALID'); }
    try { envCopy = structuredClone(envelopeIn); } catch { return refuse('ENVELOPE_INVALID'); }
    if (!isSealedCandidate(candidateIn, candCopy)) return refuse('CANDIDATE_NOT_TRUSTED');
    if (!isSealedHandoff(envelopeIn, envCopy)) return refuse('HANDOFF_NOT_TRUSTED');
    if (validateCandidate(candCopy).length > 0) return refuse('CANDIDATE_INVALID');
    if (validateEnvelope(envCopy).length > 0) return refuse('ENVELOPE_INVALID');
    const cand = deepFreeze(candCopy as CandidateResultV1);
    const env = deepFreeze(envCopy as HandoffEnvelopeV1);
    if (cand.workspace_id !== tenant || env.workspace_id !== tenant) return refuse('TENANT_MISMATCH');

    // 3. Clock before any read.
    let createdAt: unknown;
    try { createdAt = clock(); } catch { return refuse('QC_ERROR'); }
    if (typeof createdAt !== 'string' || !TIMESTAMP.test(createdAt)) return refuse('QC_ERROR');

    // 4. The six checks.
    const checks: CheckRecord[] = [];
    const add = (check: CheckRecord['check'], result: CheckRecord['result'], reason?: CheckRecord['reason']) => checks.push(reason === undefined ? { check, result } : { check, result, reason });

    // trace_chain: the candidate descends from the Intake run in the envelope, and the QC run is a distinct run.
    const traceOk = cand.parent_correlation_id === env.correlation_id && cand.item_id === env.item_id
      && cand.correlation_id !== ctx.correlation_id && env.correlation_id !== ctx.correlation_id;
    traceOk ? add('trace_chain', 'pass') : add('trace_chain', 'fail', 'MISMATCH');
    // binding: the candidate was built from exactly this envelope.
    cand.handoff_digest === contentDigest(env) ? add('binding', 'pass') : add('binding', 'fail', 'MISMATCH');
    // plan: tools, order and step ids equal QC's own expectation (ids recomputed, not read from the candidate).
    const planOk = cand.steps.length === fixedPlan.length
      && cand.steps.every((s, i) => s.tool === fixedPlan[i] && s.step_id === stepIdFor(tenant, env.item_id, i, fixedPlan[i]));
    planOk ? add('plan', 'pass') : add('plan', 'fail', 'MISMATCH');

    // evidence_exists: every step the candidate claims succeeded is backed by a tool-side record in this tenant.
    // no_orphans: the tool side holds nothing for this item that the candidate does not claim.
    const okSteps = cand.steps.filter((s) => s.status === 'ok');
    let existsResult: CheckRecord['result'] = 'pass'; let existsReason: CheckRecord['reason'];
    let orphanResult: CheckRecord['result'] = 'pass'; let orphanReason: CheckRecord['reason'];
    for (const tool of fixedPlan) {
      const rd = fixedReaders.get(tool) as EvidenceReader;
      const mine = okSteps.filter((s) => s.tool === tool);
      try {
        for (const s of mine) {
          const rec: unknown = await bounded(Promise.resolve(rd.read(ctx, s.evidence_ref as string)));
          if (rec === undefined) { if (existsResult === 'pass') { existsResult = 'fail'; existsReason = 'MISSING'; } continue; }
          if (!validRecord(rec)) throw new ReadFailure();
          if (rec.workspace_id !== tenant || rec.item_id !== env.item_id || rec.step_id !== s.step_id || rec.evidence_ref !== s.evidence_ref) {
            if (existsResult === 'pass') { existsResult = 'fail'; existsReason = 'MISMATCH'; }
          }
        }
      } catch { existsResult = 'unverifiable'; existsReason = 'READ_FAILED'; }
      try {
        const all: unknown = await bounded(Promise.resolve(rd.list(ctx, env.item_id)));
        if (!Array.isArray(all) || !(all as unknown[]).every(validRecord)) throw new ReadFailure();
        const claimed = new Set(mine.map((s) => s.step_id));
        const foreign = (all as EvidenceRecord[]).some((r) => r.workspace_id !== tenant || r.item_id !== env.item_id);
        const orphan = (all as EvidenceRecord[]).some((r) => !claimed.has(r.step_id));
        if ((foreign || orphan) && orphanResult === 'pass') { orphanResult = 'fail'; orphanReason = foreign ? 'MISMATCH' : 'ORPHAN'; }
      } catch { orphanResult = 'unverifiable'; orphanReason = 'READ_FAILED'; }
    }
    add('evidence_exists', existsResult, existsResult === 'pass' ? undefined : existsReason);
    add('no_orphans', orphanResult, orphanResult === 'pass' ? undefined : orphanReason);
    // human_approval, action_binding, durable_completion: read-only checks of the approval store for every human-approved step the candidate attempted.
    // A check is `not_required` only when QC expects no human-approved tool AND the candidate flags none. If the two disagree, the gate was
    // skipped or QC is misconfigured: either way nothing is waived, and the item is sent back.
    const flagged = cand.steps.some((s) => s.approval === 'human');
    let hApproval: R = { result: 'not_required' }; let hBinding: R = { result: 'not_required' }; let hCompletion: R = { result: 'not_required' };
    if (humanArgs.size > 0 || flagged) {
      hApproval = PASS; hBinding = PASS; hCompletion = PASS;
      const bothMismatch = () => { hApproval = worse(hApproval, failR('MISMATCH')); hBinding = worse(hBinding, failR('MISMATCH')); hCompletion = worse(hCompletion, failR('MISMATCH')); };
      for (let i = 0; i < fixedPlan.length; i++) {
        const tool = fixedPlan[i];
        const step = cand.steps[i];
        const expects = humanArgs.has(tool);
        if (!planOk || !step) { if (expects || flagged) bothMismatch(); continue; }
        if (expects !== (step.approval === 'human')) { bothMismatch(); continue; }   // QC expects a human but the step ran without one, or the reverse
        if (!expects || step.status === 'skipped') continue;                       // not a human step, or never attempted: nothing to approve
        const r = await judgeHumanStep(ctx, tool, i, step.step_id, env.item_id, tenant, step);
        hApproval = worse(hApproval, r.approval); hBinding = worse(hBinding, r.binding); hCompletion = worse(hCompletion, r.completion);
      }
    }
    add('human_approval', hApproval.result, hApproval.reason);
    add('action_binding', hBinding.result, hBinding.reason);
    add('durable_completion', hCompletion.result, hCompletion.reason);
    // consistency: an honest failed candidate is not a pass.
    // An uncertain candidate cannot be judged from the candidate alone: it escalates (settling it needs a read-back and a durable record).
    if (cand.status === 'complete') add('consistency', 'pass');
    else if (cand.status === 'uncertain') add('consistency', 'unverifiable', 'CANDIDATE_UNCERTAIN');
    else add('consistency', 'fail', 'CANDIDATE_FAILED');

    const verdict: QcVerdictV1 = {
      contract: QC_CONTRACT, workspace_id: tenant, item_id: env.item_id, correlation_id: ctx.correlation_id, parent_correlation_id: cand.correlation_id,
      candidate_digest: contentDigest(cand), verdict: verdictFor(checks), checks, produced_by: 'quality-control', created_at: createdAt,
    };
    if (validateVerdict(verdict).length > 0 || checks.map((c) => c.check).join() !== CHECK_NAMES.join()) return refuse('QC_ERROR');
    deepFreeze(verdict);
    sealVerdict(verdict);   // Reporting accepts only verdicts this entry issued, unchanged
    return { ok: true, verdict };
  }

  // ---------------------------------------------------------------- reconcile: read back, and settle only on definitive positive evidence
  const REF = /^[A-Za-z0-9_.:-]{1,64}$/;
  const STILL = (tool: string, step_id: string, reason: ReconcileReason): ReconcileStep => ({ step_id, tool, outcome: 'still_uncertain', reason });

  async function reconcileStep(ctx: unknown, tool: string, stepId: string, itemId: string, tenant: string): Promise<ReconcileStep> {
    const store = approvalStore as ReadOnlyApprovals;
    const na: ReconcileStep = { step_id: stepId, tool, outcome: 'not_applicable' };
    let found: any;
    try { found = await bounded(Promise.resolve(store.findByStep(ctx, stepId))); } catch { return STILL(tool, stepId, 'STORE_UNREADABLE'); }
    if (!isRecord(found) || typeof found.ok !== 'boolean') return STILL(tool, stepId, 'STORE_UNREADABLE');
    if (found.ok === false) return isRecord(found.error) && found.error.code === 'STORE_NOT_FOUND' ? na : STILL(tool, stepId, 'STORE_UNREADABLE');
    const snap = found.snapshot as ApprovalSnapshot | undefined;
    if (!isRecord(snap) || typeof snap.proposal_id !== 'string' || typeof snap.state !== 'string' || typeof snap.requested_by_id !== 'string') return STILL(tool, stepId, 'STORE_UNREADABLE');
    if (snap.state === 'claimed') return STILL(tool, stepId, 'IN_PROGRESS');       // a lease is still open: not ours to settle
    if (snap.state !== 'in_doubt') return na;

    // Only an approved action that is the action QC expects may be settled.
    const expected = actionDigest({ workspace_id: tenant, item_id: itemId, step_id: stepId, tool, arguments: humanArgs.get(tool) });
    if (snap.action_digest !== expected || snap.step_id !== stepId || snap.item_id !== itemId || snap.tool !== tool) return STILL(tool, stepId, 'MISMATCH');
    if (snap.decision?.decision !== 'approved' || snap.decision.approver_id === snap.requested_by_id) return STILL(tool, stepId, 'NOT_APPROVED');

    // Read-back, bounded: one listing and one confirming read. Anything but a single, consistent, confirmed record keeps the step uncertain.
    const reader = fixedReaders.get(tool) as EvidenceReader;
    let listed: unknown;
    try { listed = await bounded(Promise.resolve(reader.list(ctx, itemId))); } catch { return STILL(tool, stepId, 'READ_FAILED'); }
    if (!Array.isArray(listed) || !(listed as unknown[]).every(validRecord)) return STILL(tool, stepId, 'READ_FAILED');
    const own = (listed as EvidenceRecord[]).filter((r) => r.step_id === stepId);
    if (own.length === 0) return STILL(tool, stepId, 'NO_RECORD');                  // an absence proves nothing: the abandoned call may still land
    if (own.length > 1) return STILL(tool, stepId, 'AMBIGUOUS');
    const rec = own[0];
    if (rec.workspace_id !== tenant || rec.item_id !== itemId || !REF.test(rec.evidence_ref)) return STILL(tool, stepId, 'AMBIGUOUS');
    let again: unknown;
    try { again = await bounded(Promise.resolve(reader.read(ctx, rec.evidence_ref))); } catch { return STILL(tool, stepId, 'READ_FAILED'); }
    if (!validRecord(again)) return STILL(tool, stepId, again === undefined ? 'AMBIGUOUS' : 'READ_FAILED');
    if (again.evidence_ref !== rec.evidence_ref || again.step_id !== stepId || again.item_id !== itemId || again.workspace_id !== tenant) return STILL(tool, stepId, 'AMBIGUOUS');

    // Definitive positive evidence. Record it; QC never runs the action.
    const settle = settler as SettleOnly;
    let res: any;
    try { res = await bounded(Promise.resolve(settle.resolve(ctx, snap.proposal_id, { status: 'succeeded', evidence_ref: rec.evidence_ref }))); } catch { return STILL(tool, stepId, 'RESOLVE_FAILED'); }
    if (!isRecord(res) || res.ok !== true) return STILL(tool, stepId, 'RESOLVE_FAILED');
    return { step_id: stepId, tool, outcome: 'resolved', evidence_ref: rec.evidence_ref };
  }

  async function reconcileInner(ctx: unknown, envelopeIn: unknown): Promise<ReconcileResult> {
    if (!isTrusted(ctx)) return refuse('CONTEXT_NOT_TRUSTED');
    if (ctx.agent !== 'quality-control') return refuse('WRONG_RECIPIENT');
    if (!can(ctx, QC_RUN_SCOPE)) return refuse('QC_NOT_PERMITTED');
    for (const n of fixedPlan) if (!can(ctx, (fixedReaders.get(n) as EvidenceReader).scope)) return refuse('QC_NOT_PERMITTED');
    if (approvalStore === undefined || settler === undefined || humanArgs.size === 0) return refuse('QC_NOT_PERMITTED');   // not set up to settle
    const tenant = ctx.workspace_id;
    let envCopy: unknown;
    try { envCopy = structuredClone(envelopeIn); } catch { return refuse('ENVELOPE_INVALID'); }
    if (!isSealedHandoff(envelopeIn, envCopy)) return refuse('HANDOFF_NOT_TRUSTED');
    if (validateEnvelope(envCopy).length > 0) return refuse('ENVELOPE_INVALID');
    const env = envCopy as HandoffEnvelopeV1;
    if (env.workspace_id !== tenant) return refuse('TENANT_MISMATCH');
    const steps: ReconcileStep[] = [];
    for (let i = 0; i < fixedPlan.length; i++) {
      const tool = fixedPlan[i];
      if (!humanArgs.has(tool)) continue;
      steps.push(deepFreeze(await reconcileStep(ctx, tool, stepIdFor(tenant, env.item_id, i, tool), env.item_id, tenant)));
    }
    return { ok: true, steps: Object.freeze(steps) };
  }

  async function reconcile(ctx: unknown, envelope: unknown): Promise<ReconcileResult> {
    try { return await reconcileInner(ctx, envelope); } catch { return refuse('QC_ERROR'); }
  }

  async function run(ctx: unknown, candidate: unknown, envelope: unknown): Promise<QcResult> {
    let result: QcResult;
    try { result = await runInner(ctx, candidate, envelope); } catch { result = refuse('QC_ERROR'); }
    report(ctx, result);
    return result;
  }

  return Object.freeze({ run, reconcile });
}
