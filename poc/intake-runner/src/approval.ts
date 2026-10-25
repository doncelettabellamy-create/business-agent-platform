// Approval contracts for side-effect actions (proof of concept; field set and scope names are proposals, D-08 and FND-07).
// PURE: this file builds, checks and validates approval objects. It runs no tool, keeps no state, and is NOT connected to
// Processing, QC, Reporting or the pipeline. The design follows the concepts of Microsoft's action-bound approval ADR 0030
// (suspended decision, action digest, revalidation before execution, approver identity from authenticated context, fail
// closed); no code or package is taken from anywhere.
//
//   proposeAction(ctx, action, deps)  -> a sealed approval_proposal.v1: WHAT is being asked, bound to an action digest over
//     tenant, item, step, tool and the exact arguments. The arguments themselves are NOT stored, only their digest.
//   decideProposal(ctx, proposal, input, deps) -> a sealed approval_decision.v1: approved or declined by a DISTINCT HUMAN.
//     `ctx` must be a trusted HUMAN-APPROVER context (approver-context.ts), never an agent context. The approver's identity
//     comes ONLY from that context; the input holds a decision and a fixed reason code and
//     nothing else, so a body cannot name an approver. Refused: an approver who is not a human (`user`), who is the requester,
//     who is in another tenant, who lacks the per-tool approval scope, whose session has ended, or after the proposal has expired.
//   verifyApproval(ctx, proposal, decision, presentedAction, deps) -> the check an executor MUST make immediately before
//     running the tool: both objects are the sealed originals, same tenant as the executor, the decision belongs to this
//     proposal, the digest of the action presented NOW equals the approved digest (a changed argument fails), the decision is
//     an approval, it is inside its validity window, and the approver is a human other than the requester.
//   NOT done here (needs state, so a later gate): consuming an approval once, and a durable record. `single_use` is declared
//     in the decision but cannot be enforced by a pure function. Seals prove origin and integrity in one process only.
// Never throws; every refusal is a typed code with fixed text and no input value.
// Imports only contracts.ts, execution-context.ts, approver-context.ts and handoff-seal.ts, and does no I/O.

import { checkKeys, isNonEmptyString, isRecord, TIMESTAMP } from './contracts.ts';
import { approverCan, ASSURANCE_LEVELS, isTrustedApprover } from './approver-context.ts';
import type { Assurance } from './approver-context.ts';
import { can, isTrusted } from './execution-context.ts';
import type { ActorKind, ContextErrorCode } from './execution-context.ts';
import { contentDigest, isSealedApprovalDecision, isSealedApprovalProposal, sealApprovalDecision, sealApprovalProposal } from './handoff-seal.ts';

export const PROPOSAL_CONTRACT = 'approval_proposal.v1';
export const DECISION_CONTRACT = 'approval_decision.v1';
export const DECISIONS = ['approved', 'declined'] as const;
/** Fixed reason words; no free text. */
export const REASON_CODES = ['within_policy', 'customer_confirmed', 'outside_policy', 'unclear_request', 'too_risky', 'other'] as const;
export const REQUESTER_RUN_SCOPE = 'processing:run';
export const DEFAULT_TTL_SECONDS = 3600;
export const approvalScopeFor = (tool: string): string => `approval:decide:${tool}`;

export type ApprovalErrorCode =
  | 'APPROVAL_NOT_PERMITTED' | 'APPROVER_NOT_HUMAN' | 'SELF_APPROVAL' | 'PROPOSAL_INVALID' | 'DECISION_INVALID'
  | 'PROPOSAL_EXPIRED' | 'ACTION_MISMATCH' | 'APPROVAL_DECLINED' | 'APPROVAL_NOT_TRUSTED' | 'APPROVAL_ERROR' | 'APPROVER_SESSION_EXPIRED';
type RefusalCode = ApprovalErrorCode | ContextErrorCode;
export interface ApprovalRefusal { ok: false; error: { code: RefusalCode; message: string } }

export interface Identity { kind: ActorKind; id: string }
export interface ProposalV1 {
  contract: typeof PROPOSAL_CONTRACT;
  proposal_id: string;
  workspace_id: string;
  item_id: string;
  step_id: string;
  tool: string;
  action_digest: string;
  arguments_digest: string;
  requested_by: Identity;
  requester_correlation_id: string;
  requested_at: string;
  expires_at: string;
}
export interface DecisionV1 {
  contract: typeof DECISION_CONTRACT;
  proposal_id: string;
  workspace_id: string;
  action_digest: string;
  decision: (typeof DECISIONS)[number];
  reason_code: (typeof REASON_CODES)[number];
  approver: Identity;
  approver_assurance: Assurance;
  approver_correlation_id: string;
  decided_at: string;
  expires_at: string;
  single_use: true;
}
/** What a caller may describe. The tenant is never part of it: it comes from the context. */
export interface ActionInput { item_id: string; step_id: string; tool: string; arguments: unknown }
export interface ApprovalDeps { now: () => string; ttlSeconds?: number }

const TEXT: Record<RefusalCode, string> = {
  APPROVAL_NOT_PERMITTED: 'The caller is not permitted to do this; nothing was approved.',
  APPROVER_NOT_HUMAN: 'Only a human approver can decide; nothing was approved.',
  SELF_APPROVAL: 'The requester cannot approve their own request; nothing was approved.',
  PROPOSAL_INVALID: 'The proposal or action is not valid; nothing was approved.',
  DECISION_INVALID: 'The decision is not valid; nothing was approved.',
  PROPOSAL_EXPIRED: 'The proposal or approval has expired; nothing may run.',
  ACTION_MISMATCH: 'The action is not the action that was approved; nothing may run.',
  APPROVAL_DECLINED: 'The request was declined; nothing may run.',
  APPROVAL_NOT_TRUSTED: 'The approval object was not issued by the approval module or was changed; nothing may run.',
  APPROVAL_ERROR: 'The request could not be processed; nothing was approved.',
  APPROVER_SESSION_EXPIRED: 'The approver session has ended; nothing was approved.',
  CONTEXT_NOT_TRUSTED: 'A trusted execution context is required; nothing was approved.',
  TENANT_MISMATCH: 'The request does not belong to this tenant; refused.',
  UNAUTHENTICATED: '', TENANT_NOT_SELECTED: '', GRANTS_INVALID: '', CONTEXT_INVALID: '', NARROW_ONLY: '', ENVELOPE_INVALID: '', WRONG_RECIPIENT: 'This agent is not the right recipient; refused.',
};
function refuse(code: RefusalCode): ApprovalRefusal { return { ok: false, error: { code, message: TEXT[code] || TEXT.APPROVAL_ERROR } }; }

const ITEM_ID = /^wi-[0-9a-f]{12}$/;
const STEP_ID = /^st-[0-9a-f]{12}$/;
const PROPOSAL_ID = /^ap-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const TOOL = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_ARG_CHARS = 4000;

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const c of Object.values(v as Record<string, unknown>)) deepFreeze(c); }
  return v;
}
/** Plain JSON data only: no functions, symbols, undefined, dates, cycles, or accessors; bounded depth. Returns a copy or null. */
function plainJson(v: unknown, depth = 0): unknown | null | undefined {
  if (depth > 5) return undefined;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const x of v as unknown[]) { const c = plainJson(x, depth + 1); if (c === undefined) return undefined; out.push(c); }
    return out;
  }
  if (isRecord(v) && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) {
      const d = Object.getOwnPropertyDescriptor(v, k);
      if (!d || !('value' in d) || k === '__proto__') return undefined;
      const c = plainJson(d.value, depth + 1);
      if (c === undefined) return undefined;
      out[k] = c;
    }
    return out;
  }
  return undefined;
}
/** The digest an approval is bound to. Key order does not matter; any change to tenant, item, step, tool or arguments changes it. */
export function actionDigest(a: { workspace_id: string; item_id: string; step_id: string; tool: string; arguments: unknown }): string {
  return contentDigest({ schema_version: 1, workspace_id: a.workspace_id, item_id: a.item_id, step_id: a.step_id, tool: a.tool, arguments_digest: contentDigest(a.arguments) });
}
/** The action as a clean copy, or null if it is not a valid action description. */
export function readAction(input: unknown): { item_id: string; step_id: string; tool: string; arguments: unknown } | null {
  if (!isRecord(input)) return null;
  let snap: Record<string, unknown>;
  try { snap = { ...input }; } catch { return null; }
  if (Object.keys(snap).sort().join(',') !== 'arguments,item_id,step_id,tool') return null;
  if (typeof snap.item_id !== 'string' || !ITEM_ID.test(snap.item_id) || typeof snap.step_id !== 'string' || !STEP_ID.test(snap.step_id)
    || typeof snap.tool !== 'string' || !TOOL.test(snap.tool)) return null;
  const args = plainJson(snap.arguments);
  if (args === undefined || JSON.stringify(args).length > MAX_ARG_CHARS) return null;
  return { item_id: snap.item_id, step_id: snap.step_id, tool: snap.tool, arguments: args };
}
function readClock(now: unknown): number | null {
  try {
    const t: unknown = (now as () => unknown)();
    return typeof t === 'string' && TIMESTAMP.test(t) && !Number.isNaN(Date.parse(t)) ? Date.parse(t) : null;
  } catch { return null; }
}
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
function ttl(deps: ApprovalDeps): number | null {
  const s = deps.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  return Number.isInteger(s) && s >= 1 && s <= 86_400 ? s : null;
}
function copyOnce(x: unknown): unknown | undefined { try { return structuredClone(x); } catch { return undefined; } }

// ---------------------------------------------------------------- proposal
export function proposeAction(ctx: unknown, action: unknown, deps: ApprovalDeps): { ok: true; proposal: Readonly<ProposalV1> } | ApprovalRefusal {
  try {
    if (!isTrusted(ctx)) return refuse('CONTEXT_NOT_TRUSTED');
    if (ctx.agent !== 'processing' || !can(ctx, REQUESTER_RUN_SCOPE)) return refuse('APPROVAL_NOT_PERMITTED');
    const a = readAction(action);
    const seconds = isRecord(deps) ? ttl(deps) : null;
    if (!a || seconds === null) return refuse('PROPOSAL_INVALID');
    const nowMs = isRecord(deps) ? readClock(deps.now) : null;
    if (nowMs === null) return refuse('APPROVAL_ERROR');
    const digest = actionDigest({ workspace_id: ctx.workspace_id, ...a });
    const proposal: ProposalV1 = {
      contract: PROPOSAL_CONTRACT, proposal_id: `ap-${contentDigest({ digest, requester: ctx.actor.id, requested_at: iso(nowMs) }).slice(0, 12)}`,
      workspace_id: ctx.workspace_id, item_id: a.item_id, step_id: a.step_id, tool: a.tool, action_digest: digest, arguments_digest: contentDigest(a.arguments),
      requested_by: { kind: ctx.actor.kind, id: ctx.actor.id }, requester_correlation_id: ctx.correlation_id, requested_at: iso(nowMs), expires_at: iso(nowMs + seconds * 1000),
    };
    if (validateProposal(proposal).length > 0) return refuse('PROPOSAL_INVALID');
    deepFreeze(proposal);
    sealApprovalProposal(proposal);
    return { ok: true, proposal };
  } catch { return refuse('APPROVAL_ERROR'); }
}

// ---------------------------------------------------------------- decision
export function decideProposal(
  ctx: unknown, proposalIn: unknown, input: unknown, deps: ApprovalDeps,
): { ok: true; decision: Readonly<DecisionV1> } | ApprovalRefusal {
  try {
    // Only a trusted HUMAN-APPROVER context may decide. An agent ExecutionContext is refused, even one for a human actor.
    if (!isTrustedApprover(ctx)) return refuse(isTrusted(ctx) ? 'APPROVER_NOT_HUMAN' : 'CONTEXT_NOT_TRUSTED');
    const copy = copyOnce(proposalIn);
    if (copy === undefined || !isSealedApprovalProposal(proposalIn, copy)) return refuse('APPROVAL_NOT_TRUSTED');
    if (validateProposal(copy).length > 0) return refuse('PROPOSAL_INVALID');
    const proposal = copy as ProposalV1;
    if (ctx.workspace_id !== proposal.workspace_id) return refuse('TENANT_MISMATCH');
    if (ctx.proposal_id !== undefined && ctx.proposal_id !== proposal.proposal_id) return refuse('ACTION_MISMATCH');
    if (!approverCan(ctx, approvalScopeFor(proposal.tool))) return refuse('APPROVAL_NOT_PERMITTED');
    if (ctx.approver.id === proposal.requested_by.id || ctx.correlation_id === proposal.requester_correlation_id) return refuse('SELF_APPROVAL');
    const sessionNow = isRecord(deps) ? readClock(deps.now) : null;
    if (sessionNow === null) return refuse('APPROVAL_ERROR');
    if (sessionNow >= Date.parse(ctx.session_expires_at)) return refuse('APPROVER_SESSION_EXPIRED');

    // The input names a decision and a fixed reason code and nothing else: no identity, no tenant, no time.
    if (!isRecord(input)) return refuse('DECISION_INVALID');
    const snap: Record<string, unknown> = { ...input };
    if (Object.keys(snap).sort().join(',') !== 'decision,reason_code') return refuse('DECISION_INVALID');
    if (!(DECISIONS as readonly unknown[]).includes(snap.decision) || !(REASON_CODES as readonly unknown[]).includes(snap.reason_code)) return refuse('DECISION_INVALID');
    const nowMs = isRecord(deps) ? readClock(deps.now) : null;
    if (nowMs === null) return refuse('APPROVAL_ERROR');
    if (nowMs >= Date.parse(proposal.expires_at)) return refuse('PROPOSAL_EXPIRED');
    if (nowMs < Date.parse(proposal.requested_at)) return refuse('APPROVAL_ERROR');

    const decision: DecisionV1 = {
      contract: DECISION_CONTRACT, proposal_id: proposal.proposal_id, workspace_id: proposal.workspace_id, action_digest: proposal.action_digest,
      decision: snap.decision as DecisionV1['decision'], reason_code: snap.reason_code as DecisionV1['reason_code'],
      approver: { kind: 'user', id: ctx.approver.id }, approver_assurance: ctx.assurance, approver_correlation_id: ctx.correlation_id,
      decided_at: iso(nowMs), expires_at: proposal.expires_at, single_use: true,
    };
    if (validateDecision(decision).length > 0) return refuse('DECISION_INVALID');
    deepFreeze(decision);
    sealApprovalDecision(decision);
    return { ok: true, decision };
  } catch { return refuse('APPROVAL_ERROR'); }
}

// ---------------------------------------------------------------- the check an executor must make before running a tool
export function verifyApproval(
  ctx: unknown, proposalIn: unknown, decisionIn: unknown, presented: unknown, deps: ApprovalDeps,
): { ok: true; proposal_id: string; action_digest: string } | ApprovalRefusal {
  try {
    if (!isTrusted(ctx)) return refuse('CONTEXT_NOT_TRUSTED');
    if (ctx.agent !== 'processing' || !can(ctx, REQUESTER_RUN_SCOPE)) return refuse('APPROVAL_NOT_PERMITTED');
    const pc = copyOnce(proposalIn); const dc = copyOnce(decisionIn);
    if (pc === undefined || dc === undefined) return refuse('APPROVAL_NOT_TRUSTED');
    if (!isSealedApprovalProposal(proposalIn, pc) || !isSealedApprovalDecision(decisionIn, dc)) return refuse('APPROVAL_NOT_TRUSTED');
    if (validateProposal(pc).length > 0) return refuse('PROPOSAL_INVALID');
    if (validateDecision(dc).length > 0) return refuse('DECISION_INVALID');
    const p = pc as ProposalV1; const d = dc as DecisionV1;
    if (p.workspace_id !== ctx.workspace_id || d.workspace_id !== ctx.workspace_id) return refuse('TENANT_MISMATCH');
    if (d.proposal_id !== p.proposal_id || d.action_digest !== p.action_digest || d.expires_at !== p.expires_at) return refuse('ACTION_MISMATCH');
    // The action as it would run NOW must be the action that was approved (tenant comes from the executor's context).
    const a = readAction(presented);
    if (!a) return refuse('ACTION_MISMATCH');
    if (actionDigest({ workspace_id: ctx.workspace_id, ...a }) !== p.action_digest || a.item_id !== p.item_id || a.step_id !== p.step_id || a.tool !== p.tool) return refuse('ACTION_MISMATCH');
    if (d.approver.kind !== 'user') return refuse('APPROVER_NOT_HUMAN');
    if (d.approver.id === p.requested_by.id || d.approver_correlation_id === p.requester_correlation_id) return refuse('SELF_APPROVAL');
    const nowMs = isRecord(deps) ? readClock(deps.now) : null;
    if (nowMs === null) return refuse('APPROVAL_ERROR');
    if (nowMs >= Date.parse(p.expires_at)) return refuse('PROPOSAL_EXPIRED');
    if (Date.parse(d.decided_at) < Date.parse(p.requested_at) || Date.parse(d.decided_at) >= Date.parse(p.expires_at) || nowMs < Date.parse(d.decided_at)) return refuse('APPROVAL_ERROR');
    if (d.decision !== 'approved') return refuse('APPROVAL_DECLINED');
    return { ok: true, proposal_id: p.proposal_id, action_digest: p.action_digest };
  } catch { return refuse('APPROVAL_ERROR'); }
}

// ---------------------------------------------------------------- validators (shape and arithmetic only; they do not prove origin)
function validIdentity(x: unknown): boolean {
  return isRecord(x) && Object.keys(x).sort().join(',') === 'id,kind' && ['user', 'service', 'agent', 'system'].includes(x.kind as string) && isNonEmptyString(x.id);
}
export function validateProposal(x: unknown): string[] {
  try { return checkProposal(x); } catch { return ['proposal: unreadable']; }
}
function checkProposal(x: unknown): string[] {
  const errors: string[] = [];
  const path = 'proposal';
  if (!isRecord(x)) return [`${path}: expected object`];
  checkKeys(x, ['contract', 'proposal_id', 'workspace_id', 'item_id', 'step_id', 'tool', 'action_digest', 'arguments_digest', 'requested_by', 'requester_correlation_id', 'requested_at', 'expires_at'], path, errors);
  if (x.contract !== PROPOSAL_CONTRACT) errors.push(`${path}.contract: unsupported contract or version`);
  if (typeof x.proposal_id !== 'string' || !PROPOSAL_ID.test(x.proposal_id)) errors.push(`${path}.proposal_id: expected id like ap-<12 hex>`);
  if (!isNonEmptyString(x.workspace_id)) errors.push(`${path}.workspace_id: expected non-empty string`);
  if (typeof x.item_id !== 'string' || !ITEM_ID.test(x.item_id)) errors.push(`${path}.item_id: expected id like wi-<12 hex>`);
  if (typeof x.step_id !== 'string' || !STEP_ID.test(x.step_id)) errors.push(`${path}.step_id: expected id like st-<12 hex>`);
  if (typeof x.tool !== 'string' || !TOOL.test(x.tool)) errors.push(`${path}.tool: expected a tool name`);
  for (const k of ['action_digest', 'arguments_digest']) if (typeof x[k] !== 'string' || !DIGEST.test(x[k] as string)) errors.push(`${path}.${k}: expected a sha256 hex digest`);
  if (!validIdentity(x.requested_by)) errors.push(`${path}.requested_by: expected an identity`);
  if (!isNonEmptyString(x.requester_correlation_id)) errors.push(`${path}.requester_correlation_id: expected non-empty string`);
  for (const k of ['requested_at', 'expires_at']) if (typeof x[k] !== 'string' || !TIMESTAMP.test(x[k] as string)) errors.push(`${path}.${k}: expected UTC timestamp`);
  if (errors.length === 0 && !(Date.parse(x.expires_at as string) > Date.parse(x.requested_at as string))) errors.push(`${path}.expires_at: must be after requested_at`);
  return errors;
}
export function validateDecision(x: unknown): string[] {
  try { return checkDecision(x); } catch { return ['decision: unreadable']; }
}
function checkDecision(x: unknown): string[] {
  const errors: string[] = [];
  const path = 'decision';
  if (!isRecord(x)) return [`${path}: expected object`];
  checkKeys(x, ['contract', 'proposal_id', 'workspace_id', 'action_digest', 'decision', 'reason_code', 'approver', 'approver_assurance', 'approver_correlation_id', 'decided_at', 'expires_at', 'single_use'], path, errors);
  if (x.contract !== DECISION_CONTRACT) errors.push(`${path}.contract: unsupported contract or version`);
  if (typeof x.proposal_id !== 'string' || !PROPOSAL_ID.test(x.proposal_id)) errors.push(`${path}.proposal_id: expected id like ap-<12 hex>`);
  if (!isNonEmptyString(x.workspace_id)) errors.push(`${path}.workspace_id: expected non-empty string`);
  if (typeof x.action_digest !== 'string' || !DIGEST.test(x.action_digest)) errors.push(`${path}.action_digest: expected a sha256 hex digest`);
  if (!(DECISIONS as readonly unknown[]).includes(x.decision)) errors.push(`${path}.decision: expected approved or declined`);
  if (!(REASON_CODES as readonly unknown[]).includes(x.reason_code)) errors.push(`${path}.reason_code: expected a fixed reason code`);
  if (!validIdentity(x.approver)) errors.push(`${path}.approver: expected an identity`);
  else if ((x.approver as Identity).kind !== 'user') errors.push(`${path}.approver: an approver must be a human`);
  if (!(ASSURANCE_LEVELS as readonly unknown[]).includes(x.approver_assurance)) errors.push(`${path}.approver_assurance: expected an assurance level`);
  if (!isNonEmptyString(x.approver_correlation_id)) errors.push(`${path}.approver_correlation_id: expected non-empty string`);
  for (const k of ['decided_at', 'expires_at']) if (typeof x[k] !== 'string' || !TIMESTAMP.test(x[k] as string)) errors.push(`${path}.${k}: expected UTC timestamp`);
  if (x.single_use !== true) errors.push(`${path}.single_use: must be true`);
  if (errors.length === 0 && !(Date.parse(x.decided_at as string) < Date.parse(x.expires_at as string))) errors.push(`${path}.decided_at: must be before expires_at`);
  return errors;
}
