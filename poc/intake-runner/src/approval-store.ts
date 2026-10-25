// The approval-state store (proof of concept): the one place where an approval becomes USED, so that it cannot be replayed.
// This file defines the contract (`ApprovalStore`) and an in-memory reference implementation. It is STANDALONE: no agent, tool,
// pipeline or report uses it yet. A durable store must pass the same conformance tests (tests/approval-store.test.ts).
//
// State per tenant and proposal:
//   requested -> approved | declined | expired -> claimed -> succeeded | failed | in_doubt (-> succeeded | failed)
//   * the FIRST decision wins; a different later decision is refused;
//   * `claim` is the single consumption point: an atomic check-and-set approved -> claimed that also re-checks the digest of the
//     action presented now against the approved digest, so exactly one caller wins a race and a changed action is refused;
//   * a claim carries a fence token (claim_id) and a lease; only the holder of the LATEST claim can complete; a lapsed lease
//     becomes `in_doubt` (the tool may or may not have run) and is never retried freely: a retry is allowed only for a tool
//     declared idempotent at setup, within the approval window and an attempt limit; otherwise a QC read-back settles it (`resolve`);
//   * an effect ledger keyed by tenant + step id allows at most one SUCCEEDED effect per step, whatever proposals exist;
//     at most one live (non-terminal) proposal exists per step;
//   * the store's own injected clock decides expiry and leases (not the caller's);
//   * every transition is an event in a hash-linked, per-proposal log that `verifyEventLog` can check.
// The tenant always comes from a minted context. Another tenant's proposal looks exactly like one that does not exist.
// Failures are typed refusals with fixed text and no values; nothing here throws at request time (bad setup throws a RangeError).
// Seals prove origin and integrity in one process only. Imports no network, file, or process APIs (a hash and an id generator only).

import { randomUUID } from 'node:crypto';
import { isRecord, TIMESTAMP } from './contracts.ts';
import { actionDigest, approvalScopeFor, readAction, validateDecision, validateProposal } from './approval.ts';
import type { DecisionV1, ProposalV1 } from './approval.ts';
import { approverCan, isTrustedApprover } from './approver-context.ts';
import { can, isTrusted } from './execution-context.ts';
import { contentDigest, isSealedApprovalDecision, isSealedApprovalProposal } from './handoff-seal.ts';

export const APPROVAL_STATES = ['requested', 'approved', 'declined', 'expired', 'claimed', 'in_doubt', 'succeeded', 'failed'] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];
export const EVENT_TYPES = ['requested', 'approved', 'declined', 'expired', 'claimed', 'lease_lapsed', 'succeeded', 'failed'] as const;

export type StoreErrorCode =
  | 'STORE_NOT_PERMITTED' | 'STORE_NOT_FOUND' | 'STORE_INVALID' | 'STORE_ERROR' | 'PROPOSAL_CONFLICT' | 'ACTIVE_PROPOSAL_EXISTS'
  | 'EFFECT_ALREADY_DONE' | 'DECISION_CONFLICT' | 'NOT_APPROVED' | 'CLAIM_CONFLICT' | 'STALE_CLAIM' | 'IN_DOUBT' | 'RETRY_LIMIT';
type Code = StoreErrorCode | 'CONTEXT_NOT_TRUSTED' | 'TENANT_MISMATCH' | 'APPROVAL_NOT_TRUSTED' | 'PROPOSAL_EXPIRED' | 'ACTION_MISMATCH'
  | 'PROPOSAL_INVALID' | 'DECISION_INVALID' | 'SELF_APPROVAL' | 'APPROVER_SESSION_EXPIRED';
export interface StoreRefusal { ok: false; error: { code: Code; message: string } }
type Ok<T> = { ok: true } & T;
export type StoreResult<T> = Ok<T> | StoreRefusal;

export interface ApprovalSnapshot {
  readonly proposal_id: string;
  readonly state: ApprovalState;
  readonly item_id: string;
  readonly step_id: string;
  readonly tool: string;
  readonly action_digest: string;
  readonly expires_at: string;
  readonly requested_by_id: string;
  readonly decision?: { readonly decision: 'approved' | 'declined'; readonly approver_id: string; readonly assurance: string; readonly decided_at: string };
  readonly claim?: { readonly attempt: number; readonly lease_until: string };
  readonly outcome?: { readonly status: 'succeeded' | 'failed'; readonly evidence_ref?: string };
  readonly attempts: number;
  readonly version: number;
}
export interface ClaimGrant { readonly proposal_id: string; readonly step_id: string; readonly claim_id: string; readonly attempt: number; readonly lease_until: string }
export interface StoreEvent {
  readonly seq: number;
  readonly type: (typeof EVENT_TYPES)[number];
  readonly at: string;
  readonly tenant: string;
  readonly proposal_id: string;
  readonly data: Readonly<Record<string, string | number>>;
  readonly previous_digest: string;
  readonly digest: string;
}

export interface ApprovalStore {
  /** Seconds a claim stays valid before it becomes in-doubt. Callers must make sure a tool call and its recording fit inside it. */
  readonly leaseSeconds: number;
  /** A Processing context records a sealed proposal. Idempotent for the same proposal. */
  putProposal(ctx: unknown, proposal: unknown): Promise<StoreResult<{ created: boolean; snapshot: ApprovalSnapshot }>>;
  /** A human-approver context records a sealed decision. The first decision wins. */
  recordDecision(ctx: unknown, decision: unknown): Promise<StoreResult<{ snapshot: ApprovalSnapshot }>>;
  /** A Processing context consumes an approval to start execution. Atomic: exactly one caller wins. */
  claim(ctx: unknown, proposalId: unknown, presentedAction: unknown): Promise<StoreResult<{ grant: ClaimGrant }>>;
  /** The holder of the latest claim records the outcome. */
  complete(ctx: unknown, proposalId: unknown, claimId: unknown, outcome: unknown): Promise<StoreResult<{ snapshot: ApprovalSnapshot }>>;
  /** A Quality Control context settles an in-doubt claim after reading the system of record. */
  resolve(ctx: unknown, proposalId: unknown, outcome: unknown): Promise<StoreResult<{ snapshot: ApprovalSnapshot }>>;
  /** Read-only view for any trusted agent context in the tenant. */
  get(ctx: unknown, proposalId: unknown): Promise<StoreResult<{ snapshot: ApprovalSnapshot }>>;
  /**
   * The request for a step, for any trusted agent context in the tenant: the one LIVE (open) request if there is one, otherwise the
   * latest finished request. Time-based transitions (expiry, a lapsed lease) are applied first, so an unanswered request that has run out
   * is returned as `expired`. A step with no request, another tenant's step and a malformed id all give the same `STORE_NOT_FOUND`.
   */
  findByStep(ctx: unknown, stepId: unknown): Promise<StoreResult<{ snapshot: ApprovalSnapshot }>>;
  /** The hash-linked event log for one proposal. */
  events(ctx: unknown, proposalId: unknown): Promise<StoreResult<{ events: readonly StoreEvent[] }>>;
}

export interface StoreConfig {
  /** The store's own UTC clock (`YYYY-MM-DDTHH:MM:SSZ`). It alone decides expiry and leases. */
  now: () => string;
  /** Seconds a claim stays valid before it becomes in-doubt, 1 to 3600 (default 60). */
  leaseSeconds?: number;
  /** Most claims per approval (first try plus retries), 1 to 10 (default 3). Retries are only for idempotent tools. */
  maxAttempts?: number;
  /** Tools whose steps are idempotent on the step id, so an in-doubt claim may be retried. Fixed at setup. */
  idempotentTools?: readonly string[];
  /** Fence-token source (default: random UUID). */
  newClaimId?: () => string;
}

const TEXT: Record<Code, string> = {
  STORE_NOT_PERMITTED: 'The caller is not permitted to do this; nothing changed.',
  STORE_NOT_FOUND: 'No such approval for this tenant; nothing changed.',
  STORE_INVALID: 'The request is not valid; nothing changed.',
  STORE_ERROR: 'The request could not be processed; nothing changed.',
  PROPOSAL_CONFLICT: 'A different proposal already uses this id; nothing changed.',
  ACTIVE_PROPOSAL_EXISTS: 'Another request for this step is still open; nothing changed.',
  EFFECT_ALREADY_DONE: 'This step has already been carried out; nothing changed.',
  DECISION_CONFLICT: 'A different decision was already recorded; nothing changed.',
  NOT_APPROVED: 'This request is not approved for use; nothing may run.',
  CLAIM_CONFLICT: 'This approval is already in use; nothing may run.',
  STALE_CLAIM: 'The claim is not the current one; nothing changed.',
  IN_DOUBT: 'The earlier attempt is uncertain and must be settled first; nothing may run.',
  RETRY_LIMIT: 'The attempt limit has been reached; nothing may run.',
  CONTEXT_NOT_TRUSTED: 'A trusted context is required; nothing changed.',
  TENANT_MISMATCH: 'The request does not belong to this tenant; refused.',
  APPROVAL_NOT_TRUSTED: 'The approval object was not issued by the approval module or was changed; nothing changed.',
  PROPOSAL_EXPIRED: 'The proposal has expired; nothing may run.',
  ACTION_MISMATCH: 'The action is not the action that was approved; nothing may run.',
  PROPOSAL_INVALID: 'The proposal is not valid; nothing changed.',
  DECISION_INVALID: 'The decision is not valid; nothing changed.',
  SELF_APPROVAL: 'The requester cannot approve their own request; nothing changed.',
  APPROVER_SESSION_EXPIRED: 'The approver session has ended; nothing changed.',
};
function refuse(code: Code): StoreRefusal { return { ok: false, error: { code, message: TEXT[code] } }; }

const PROPOSAL_ID = /^ap-[0-9a-f]{12}$/;
const STEP_ID = /^st-[0-9a-f]{12}$/;
const REF = /^[A-Za-z0-9_.:-]{1,64}$/;
const GENESIS = '0'.repeat(64);
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const TERMINAL: readonly ApprovalState[] = ['declined', 'expired', 'succeeded', 'failed'];

interface Rec {
  tenant: string; proposal: ProposalV1; proposalDigest: string; state: ApprovalState;
  decision?: DecisionV1; decisionDigest?: string;
  claim?: { claim_id: string; attempt: number; lease_until: number };
  attempts: number; outcome?: { status: 'succeeded' | 'failed'; evidence_ref?: string };
  version: number; events: StoreEvent[];
}
function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const c of Object.values(v as Record<string, unknown>)) deepFreeze(c); }
  return v;
}

/** Checks a hash-linked event log without trusting it: sequence, links and digests. */
export function verifyEventLog(events: unknown): boolean {
  try {
    if (!Array.isArray(events)) return false;
    let previous = GENESIS;
    for (let i = 0; i < events.length; i++) {
      const e: unknown = (events as unknown[])[i];
      if (!isRecord(e) || e.seq !== i + 1 || e.previous_digest !== previous) return false;
      const { digest, ...rest } = e as Record<string, unknown>;
      if (digest !== contentDigest(rest)) return false;
      previous = digest as string;
    }
    return true;
  } catch { return false; }
}

export function createInMemoryApprovalStore(config: StoreConfig): ApprovalStore {
  if (!isRecord(config) || typeof config.now !== 'function') throw new RangeError('config must provide a now function');
  const lease = config.leaseSeconds ?? 60;
  const maxAttempts = config.maxAttempts ?? 3;
  if (!Number.isInteger(lease) || lease < 1 || lease > 3600) throw new RangeError('leaseSeconds must be an integer from 1 to 3600');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new RangeError('maxAttempts must be an integer from 1 to 10');
  const tools = config.idempotentTools ?? [];
  if (!Array.isArray(tools) || !tools.every((t) => typeof t === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(t))) throw new RangeError('idempotentTools must be a list of tool names');
  if (config.newClaimId !== undefined && typeof config.newClaimId !== 'function') throw new RangeError('newClaimId must be a function');
  const idempotent = new Set<string>(tools);
  const clock = config.now;
  const newClaimId = config.newClaimId ?? (() => randomUUID());

  const tenants = new Map<string, Map<string, Rec>>();
  const ledger = new Map<string, string>();     // tenant + step -> proposal id of the SUCCEEDED effect
  const live = new Map<string, string>();       // tenant + step -> proposal id of the one non-terminal proposal
  const keyOf = (tenant: string, step: string) => `${tenant}\n${step}`;

  function readNow(): number | null {
    try { const t: unknown = clock(); return typeof t === 'string' && TIMESTAMP.test(t) && !Number.isNaN(Date.parse(t)) ? Date.parse(t) : null; } catch { return null; }
  }
  function agentTenant(ctx: unknown, agent: 'processing' | 'quality-control' | null, scope: string | null): { tenant: string } | StoreRefusal {
    if (!isTrusted(ctx)) return refuse('CONTEXT_NOT_TRUSTED');
    if (agent !== null && (ctx.agent !== agent || !can(ctx, scope))) return refuse('STORE_NOT_PERMITTED');
    return { tenant: ctx.workspace_id };
  }
  function append(r: Rec, type: StoreEvent['type'], at: number, data: Record<string, string | number> = {}): void {
    const previous = r.events.length === 0 ? GENESIS : r.events[r.events.length - 1].digest;
    const body = { seq: r.events.length + 1, type, at: iso(at), tenant: r.tenant, proposal_id: r.proposal.proposal_id, data, previous_digest: previous };
    r.events.push(deepFreeze({ ...body, digest: contentDigest(body) }));
    r.version++;
  }
  function finish(r: Rec): void {
    if (TERMINAL.includes(r.state)) { const k = keyOf(r.tenant, r.proposal.step_id); if (live.get(k) === r.proposal.proposal_id) live.delete(k); }
  }
  /** Applies the time-based transitions (expiry, lapsed lease). Called before every operation on a record. */
  function settle(r: Rec, now: number): void {
    if ((r.state === 'requested' || r.state === 'approved') && now >= Date.parse(r.proposal.expires_at)) {
      r.state = 'expired'; append(r, 'expired', now); finish(r);
    } else if (r.state === 'claimed' && r.claim && now >= r.claim.lease_until) {
      r.state = 'in_doubt'; append(r, 'lease_lapsed', now, { attempt: r.claim.attempt });
    }
  }
  function snap(r: Rec): ApprovalSnapshot {
    return deepFreeze({
      proposal_id: r.proposal.proposal_id, state: r.state, item_id: r.proposal.item_id, step_id: r.proposal.step_id, tool: r.proposal.tool,
      action_digest: r.proposal.action_digest, expires_at: r.proposal.expires_at, requested_by_id: r.proposal.requested_by.id,
      ...(r.decision ? { decision: { decision: r.decision.decision, approver_id: r.decision.approver.id, assurance: r.decision.approver_assurance, decided_at: r.decision.decided_at } } : {}),
      ...(r.claim && (r.state === 'claimed' || r.state === 'in_doubt') ? { claim: { attempt: r.claim.attempt, lease_until: iso(r.claim.lease_until) } } : {}),
      ...(r.outcome ? { outcome: { ...r.outcome } } : {}),
      attempts: r.attempts, version: r.version,
    });
  }
  function find(tenant: string, id: unknown): Rec | undefined {
    return typeof id === 'string' && PROPOSAL_ID.test(id) ? tenants.get(tenant)?.get(id) : undefined;
  }
  function readOutcome(o: unknown): { status: 'succeeded' | 'failed'; evidence_ref?: string } | null {
    if (!isRecord(o)) return null;
    const snapshot: Record<string, unknown> = { ...o };
    const keys = Object.keys(snapshot).sort().join(',');
    if (keys !== 'status' && keys !== 'evidence_ref,status') return null;
    if (snapshot.status !== 'succeeded' && snapshot.status !== 'failed') return null;
    if (snapshot.status === 'succeeded' && (typeof snapshot.evidence_ref !== 'string' || !REF.test(snapshot.evidence_ref))) return null;
    if (snapshot.status === 'failed' && Object.hasOwn(snapshot, 'evidence_ref')) return null;
    return snapshot.status === 'succeeded' ? { status: 'succeeded', evidence_ref: snapshot.evidence_ref as string } : { status: 'failed' };
  }
  function settleOutcome(r: Rec, o: { status: 'succeeded' | 'failed'; evidence_ref?: string }, now: number, via: 'complete' | 'resolve'): StoreRefusal | null {
    const k = keyOf(r.tenant, r.proposal.step_id);
    if (o.status === 'succeeded') {
      if (ledger.has(k)) return refuse('EFFECT_ALREADY_DONE');
      ledger.set(k, r.proposal.proposal_id);
    }
    r.state = o.status; r.outcome = o;
    append(r, o.status, now, { via, attempt: r.claim?.attempt ?? 0 });
    finish(r);
    return null;
  }
  // Every operation runs its read-check-write in ONE synchronous block (no await between), so concurrent callers cannot interleave.
  const guard = <T>(fn: () => StoreResult<T>): Promise<StoreResult<T>> => {
    try { return Promise.resolve(fn()); } catch { return Promise.resolve(refuse('STORE_ERROR')); }
  };

  return Object.freeze({
    leaseSeconds: lease,
    putProposal: (ctx, proposalIn) => guard(() => {
      const a = agentTenant(ctx, 'processing', 'processing:run');
      if ('ok' in a) return a;
      let copy: unknown; try { copy = structuredClone(proposalIn); } catch { return refuse('STORE_INVALID'); }
      if (!isSealedApprovalProposal(proposalIn, copy)) return refuse('APPROVAL_NOT_TRUSTED');
      if (validateProposal(copy).length > 0) return refuse('PROPOSAL_INVALID');
      const p = copy as ProposalV1;
      if (p.workspace_id !== a.tenant) return refuse('TENANT_MISMATCH');
      const now = readNow();
      if (now === null) return refuse('STORE_ERROR');
      const map = tenants.get(a.tenant) ?? new Map<string, Rec>();
      const existing = map.get(p.proposal_id);
      if (existing) {
        settle(existing, now);
        return existing.proposalDigest === contentDigest(p) ? { ok: true, created: false, snapshot: snap(existing) } : refuse('PROPOSAL_CONFLICT');
      }
      if (now >= Date.parse(p.expires_at)) return refuse('PROPOSAL_EXPIRED');
      const k = keyOf(a.tenant, p.step_id);
      if (ledger.has(k)) return refuse('EFFECT_ALREADY_DONE');
      // The one live request for this step may have lapsed without anyone touching it: settle it before judging.
      const liveId = live.get(k);
      const liveRec = liveId === undefined ? undefined : map.get(liveId);
      if (liveRec) settle(liveRec, now);
      if (live.has(k)) return refuse('ACTIVE_PROPOSAL_EXISTS');
      const r: Rec = { tenant: a.tenant, proposal: deepFreeze(p), proposalDigest: contentDigest(p), state: 'requested', attempts: 0, version: 0, events: [] };
      append(r, 'requested', now, { expires: p.expires_at });
      map.set(p.proposal_id, r); tenants.set(a.tenant, map); live.set(k, p.proposal_id);
      return { ok: true, created: true, snapshot: snap(r) };
    }),

    recordDecision: (ctx, decisionIn) => guard(() => {
      if (!isTrustedApprover(ctx)) return refuse(isTrusted(ctx) ? 'STORE_NOT_PERMITTED' : 'CONTEXT_NOT_TRUSTED');
      let copy: unknown; try { copy = structuredClone(decisionIn); } catch { return refuse('STORE_INVALID'); }
      if (!isSealedApprovalDecision(decisionIn, copy)) return refuse('APPROVAL_NOT_TRUSTED');
      if (validateDecision(copy).length > 0) return refuse('DECISION_INVALID');
      const d = copy as DecisionV1;
      if (d.workspace_id !== ctx.workspace_id) return refuse('TENANT_MISMATCH');
      const r = find(ctx.workspace_id, d.proposal_id);
      if (!r) return refuse('STORE_NOT_FOUND');
      const now = readNow();
      if (now === null) return refuse('STORE_ERROR');
      settle(r, now);
      if (d.approver.id !== ctx.approver.id || d.approver_correlation_id !== ctx.correlation_id) return refuse('STORE_NOT_PERMITTED');
      if (ctx.proposal_id !== undefined && ctx.proposal_id !== r.proposal.proposal_id) return refuse('ACTION_MISMATCH');
      if (!approverCan(ctx, approvalScopeFor(r.proposal.tool))) return refuse('STORE_NOT_PERMITTED');
      if (now >= Date.parse(ctx.session_expires_at)) return refuse('APPROVER_SESSION_EXPIRED');
      if (d.action_digest !== r.proposal.action_digest || d.expires_at !== r.proposal.expires_at) return refuse('ACTION_MISMATCH');
      if (d.approver.id === r.proposal.requested_by.id || d.approver_correlation_id === r.proposal.requester_correlation_id) return refuse('SELF_APPROVAL');
      if (r.decision) return r.decisionDigest === contentDigest(d) ? { ok: true, snapshot: snap(r) } : refuse('DECISION_CONFLICT');
      if (r.state === 'expired') return refuse('PROPOSAL_EXPIRED');
      if (r.state !== 'requested') return refuse('DECISION_CONFLICT');
      r.decision = deepFreeze(d); r.decisionDigest = contentDigest(d);
      r.state = d.decision === 'approved' ? 'approved' : 'declined';
      append(r, r.state === 'approved' ? 'approved' : 'declined', now, { reason: d.reason_code, assurance: d.approver_assurance });
      finish(r);
      return { ok: true, snapshot: snap(r) };
    }),

    claim: (ctx, proposalId, presented) => guard(() => {
      const a = agentTenant(ctx, 'processing', 'processing:run');
      if ('ok' in a) return a;
      const r = find(a.tenant, proposalId);
      if (!r) return refuse('STORE_NOT_FOUND');
      const now = readNow();
      if (now === null) return refuse('STORE_ERROR');
      settle(r, now);
      // The action presented NOW must be the action that was approved (tenant from the context, not the caller).
      const act = readAction(presented);
      if (!act || act.item_id !== r.proposal.item_id || act.step_id !== r.proposal.step_id || act.tool !== r.proposal.tool
        || actionDigest({ workspace_id: a.tenant, ...act }) !== r.proposal.action_digest) return refuse('ACTION_MISMATCH');
      if (r.state === 'claimed') return refuse('CLAIM_CONFLICT');
      if (r.state === 'succeeded') return refuse('EFFECT_ALREADY_DONE');
      if (r.state === 'expired') return refuse('PROPOSAL_EXPIRED');
      if (r.state === 'in_doubt') {
        if (!idempotent.has(r.proposal.tool)) return refuse('IN_DOUBT');
        if (r.attempts >= maxAttempts) return refuse('RETRY_LIMIT');
        if (now >= Date.parse(r.proposal.expires_at)) return refuse('PROPOSAL_EXPIRED');
      } else if (r.state !== 'approved') return refuse('NOT_APPROVED');
      const claimId = newClaimId();
      if (typeof claimId !== 'string' || !/^[A-Za-z0-9_.:-]{8,64}$/.test(claimId)) return refuse('STORE_ERROR');
      r.attempts++;
      r.claim = { claim_id: claimId, attempt: r.attempts, lease_until: now + lease * 1000 };
      r.state = 'claimed';
      append(r, 'claimed', now, { attempt: r.attempts });
      return { ok: true, grant: deepFreeze({ proposal_id: r.proposal.proposal_id, step_id: r.proposal.step_id, claim_id: claimId, attempt: r.attempts, lease_until: iso(r.claim.lease_until) }) };
    }),

    complete: (ctx, proposalId, claimId, outcome) => guard(() => {
      const a = agentTenant(ctx, 'processing', 'processing:run');
      if ('ok' in a) return a;
      const r = find(a.tenant, proposalId);
      if (!r) return refuse('STORE_NOT_FOUND');
      const o = readOutcome(outcome);
      if (!o || typeof claimId !== 'string') return refuse('STORE_INVALID');
      const now = readNow();
      if (now === null) return refuse('STORE_ERROR');
      settle(r, now);
      // Only the LATEST claim may complete, even after its lease lapsed (the work really finished) and nothing newer exists.
      if ((r.state !== 'claimed' && r.state !== 'in_doubt') || !r.claim || r.claim.claim_id !== claimId) return refuse('STALE_CLAIM');
      const failure = settleOutcome(r, o, now, 'complete');
      return failure ?? { ok: true, snapshot: snap(r) };
    }),

    resolve: (ctx, proposalId, outcome) => guard(() => {
      const a = agentTenant(ctx, 'quality-control', 'quality-control:run');
      if ('ok' in a) return a;
      const r = find(a.tenant, proposalId);
      if (!r) return refuse('STORE_NOT_FOUND');
      const o = readOutcome(outcome);
      if (!o) return refuse('STORE_INVALID');
      const now = readNow();
      if (now === null) return refuse('STORE_ERROR');
      settle(r, now);
      if (r.state !== 'in_doubt') return refuse('NOT_APPROVED');
      const failure = settleOutcome(r, o, now, 'resolve');
      return failure ?? { ok: true, snapshot: snap(r) };
    }),

    get: (ctx, proposalId) => guard(() => {
      const a = agentTenant(ctx, null, null);
      if ('ok' in a) return a;
      const r = find(a.tenant, proposalId);
      if (!r) return refuse('STORE_NOT_FOUND');
      const now = readNow();
      if (now === null) return refuse('STORE_ERROR');
      settle(r, now);
      return { ok: true, snapshot: snap(r) };
    }),

    findByStep: (ctx, stepId) => guard(() => {
      const a = agentTenant(ctx, null, null);
      if ('ok' in a) return a;
      if (typeof stepId !== 'string' || !STEP_ID.test(stepId)) return refuse('STORE_NOT_FOUND');
      const now = readNow();
      if (now === null) return refuse('STORE_ERROR');
      const map = tenants.get(a.tenant);
      if (!map) return refuse('STORE_NOT_FOUND');
      // The one live request may have lapsed untouched: settle it first, then prefer it if it is still open.
      const liveId = live.get(keyOf(a.tenant, stepId));
      const liveRec = liveId === undefined ? undefined : map.get(liveId);
      if (liveRec) { settle(liveRec, now); if (!TERMINAL.includes(liveRec.state)) return { ok: true, snapshot: snap(liveRec) }; }
      let latest: Rec | undefined;
      for (const r of map.values()) if (r.proposal.step_id === stepId) latest = r;      // insertion order: the last one is the newest
      if (!latest) return refuse('STORE_NOT_FOUND');
      settle(latest, now);
      return { ok: true, snapshot: snap(latest) };
    }),

    events: (ctx, proposalId) => guard(() => {
      const a = agentTenant(ctx, null, null);
      if ('ok' in a) return a;
      const r = find(a.tenant, proposalId);
      if (!r) return refuse('STORE_NOT_FOUND');
      const now = readNow();
      if (now === null) return refuse('STORE_ERROR');
      settle(r, now);
      return { ok: true, events: r.events.map((e) => deepFreeze({ ...e, data: { ...e.data } })) as readonly StoreEvent[] };
    }),
  });
}

/**
 * Pieces shared with other store implementations (for example the SQLite reference store), so every implementation gives the
 * same refusals, outcome rules and log format. Not part of the store interface that callers use.
 */
export const storeShared = Object.freeze({
  STEP_ID,
  refuse,
  iso,
  PROPOSAL_ID,
  REF,
  GENESIS,
  TERMINAL,
  readOutcome(o: unknown): { status: 'succeeded' | 'failed'; evidence_ref?: string } | null {
    if (!isRecord(o)) return null;
    const snapshot: Record<string, unknown> = { ...o };
    const keys = Object.keys(snapshot).sort().join(',');
    if (keys !== 'status' && keys !== 'evidence_ref,status') return null;
    if (snapshot.status !== 'succeeded' && snapshot.status !== 'failed') return null;
    if (snapshot.status === 'succeeded' && (typeof snapshot.evidence_ref !== 'string' || !REF.test(snapshot.evidence_ref))) return null;
    if (snapshot.status === 'failed' && Object.hasOwn(snapshot, 'evidence_ref')) return null;
    return snapshot.status === 'succeeded' ? { status: 'succeeded', evidence_ref: snapshot.evidence_ref as string } : { status: 'failed' };
  },
  deepFreeze,
});
