// The trusted human-approver context (proof of concept). A human who approves a side-effect action is NOT one of the four
// agents, so this is a separate kind of context with its own private registry:
//   - no agent field, and a human actor only (kind `user`);
//   - approval-only scopes (`approval:decide:<tool>`): a grants source that returns anything else is refused, so an approver
//     context can never hold an agent scope such as `processing:run`;
//   - the verified identity, its authentication assurance and its session life come from an injected identity/session
//     source; the person must be a member of the tenant (injected check); the session must still be valid, and its life here is
//     capped, so a long identity-provider session does not become a long-lived approver context;
//   - optionally pinned to ONE proposal (`proposal_id`), so the context cannot be reused for another;
//   - recognised by object identity (a private WeakSet): a copy, clone, parsed JSON, look-alike or proxy is not trusted, and an
//     agent ExecutionContext is not an approver context (and the reverse: no agent entry accepts this one).
// Whoever supplies the sources defines what the context means (the same remaining trust assumption as the agent contexts).
// Scope names, assurance levels, the role model and session limits are proposals (D-08, FND-07, FND-28). No identity provider
// is chosen. Every source call is bounded by a timeout. Never throws; refusals carry fixed text and no values.
// Imports only contracts.ts and does no I/O.

import { isRecord, TIMESTAMP } from './contracts.ts';

export const ASSURANCE_LEVELS = ['mock', 'single-factor', 'multi-factor'] as const;
export type Assurance = (typeof ASSURANCE_LEVELS)[number];

export interface ApproverContext {
  readonly workspace_id: string;
  readonly approver: { readonly kind: 'user'; readonly id: string };
  /** The approval session's own run id (never the requester's). */
  readonly correlation_id: string;
  readonly scopes: readonly string[];
  readonly assurance: Assurance;
  readonly authenticated_at: string;
  /** The session ends here (already capped). */
  readonly session_expires_at: string;
  /** Present when the context is pinned to one proposal. */
  readonly proposal_id?: string;
}

export type ApproverContextErrorCode =
  | 'APPROVER_UNAUTHENTICATED' | 'APPROVER_SESSION_EXPIRED' | 'APPROVER_NOT_MEMBER' | 'APPROVER_GRANTS_INVALID' | 'APPROVER_CONTEXT_INVALID';
export interface ApproverRefusal { ok: false; error: { code: ApproverContextErrorCode; message: string } }
export type ApproverResult = { ok: true; context: ApproverContext } | ApproverRefusal;

/** What the injected, trusted sources must provide. Each may be synchronous or asynchronous. */
export interface ApproverDeps {
  /** Receives the credential and nothing else. Returns { kind: 'user', id, assurance, authenticated_at, session_expires_at }, or nothing. */
  verify(credential: unknown): unknown;
  /** Receives the verified identity and the requested tenant. Must return exactly `true` for a member. */
  membership(identity: Readonly<{ id: string }>, workspaceId: string): unknown;
  /** Returns the approval scopes this person holds in this tenant. Only `approval:decide:<tool>` scopes are accepted. */
  grants(identity: Readonly<{ id: string }>, workspaceId: string): unknown;
  newCorrelationId(): string;
  /** UTC timestamp source (`YYYY-MM-DDTHH:MM:SSZ`). */
  now(): string;
  /** Lowest accepted assurance (default `single-factor`; `mock` is only accepted when asked for explicitly). */
  minAssurance?: Assurance;
  /** Longest session this context may carry, 1 to 86400 s (default 3600). */
  maxSessionSeconds?: number;
  /** Per source call, 1 to 60000 ms (default 5000). */
  timeoutMs?: number;
}

const TEXT: Record<ApproverContextErrorCode, string> = {
  APPROVER_UNAUTHENTICATED: 'The approver could not be verified; nothing was approved.',
  APPROVER_SESSION_EXPIRED: 'The approver session has ended; nothing was approved.',
  APPROVER_NOT_MEMBER: 'The approver is not a member of this tenant; nothing was approved.',
  APPROVER_GRANTS_INVALID: 'Approval permissions could not be determined; nothing was approved.',
  APPROVER_CONTEXT_INVALID: 'The approver context could not be created; nothing was approved.',
};
function refuse(code: ApproverContextErrorCode): ApproverRefusal { return { ok: false, error: { code, message: TEXT[code] } }; }

const ID_LIKE = /^[A-Za-z0-9_.:-]{1,64}$/;
const APPROVAL_SCOPE = /^approval:decide:[a-z][a-z0-9-]{0,31}$/;
const PROPOSAL_ID = /^ap-[0-9a-f]{12}$/;
const MAX_SCOPES = 32;

/** Contexts created by this module. Identity-based: copies and look-alikes are not members. */
const minted = new WeakSet<object>();

/** True only for an approver context created by this module. An agent ExecutionContext is not one. */
export function isTrustedApprover(x: unknown): x is ApproverContext {
  return typeof x === 'object' && x !== null && minted.has(x);
}
/** True when the approver context holds this scope (default deny). */
export function approverCan(ctx: unknown, scope: unknown): boolean {
  return isTrustedApprover(ctx) && typeof scope === 'string' && ctx.scopes.includes(scope);
}

class Timeout extends Error {}
function bounded<T>(work: () => T | Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Timeout()), ms); });
  const call = Promise.resolve().then(work);
  call.catch(() => {});
  return Promise.race([call, timeout]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const stamp = (v: unknown): number | null => (typeof v === 'string' && TIMESTAMP.test(v) && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : null);

export async function mintApproverContext(request: { credential: unknown; workspace_id: string; proposal_id?: string }, deps: ApproverDeps): Promise<ApproverResult> {
  try {
    if (!isRecord(request) || !isRecord(deps)) return refuse('APPROVER_CONTEXT_INVALID');
    for (const f of ['verify', 'membership', 'grants', 'newCorrelationId', 'now'] as const) if (typeof deps[f] !== 'function') return refuse('APPROVER_CONTEXT_INVALID');
    const credential: unknown = request.credential;
    const workspace: unknown = request.workspace_id;
    const pinned: unknown = request.proposal_id;
    if (typeof workspace !== 'string' || !ID_LIKE.test(workspace)) return refuse('APPROVER_CONTEXT_INVALID');
    if (pinned !== undefined && (typeof pinned !== 'string' || !PROPOSAL_ID.test(pinned))) return refuse('APPROVER_CONTEXT_INVALID');
    const timeoutMs = deps.timeoutMs ?? 5000;
    const maxSession = deps.maxSessionSeconds ?? 3600;
    const minAssurance = deps.minAssurance ?? 'single-factor';
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 || !Number.isInteger(maxSession) || maxSession < 1 || maxSession > 86_400
      || !(ASSURANCE_LEVELS as readonly unknown[]).includes(minAssurance)) return refuse('APPROVER_CONTEXT_INVALID');

    let nowMs: number | null;
    try { nowMs = stamp(await bounded(() => deps.now(), timeoutMs)); } catch { return refuse('APPROVER_CONTEXT_INVALID'); }
    if (nowMs === null) return refuse('APPROVER_CONTEXT_INVALID');

    // 1. Verified human identity, assurance and session, each property read once.
    let v: unknown;
    try { v = await bounded(() => deps.verify(credential), timeoutMs); } catch { return refuse('APPROVER_UNAUTHENTICATED'); }
    if (!isRecord(v)) return refuse('APPROVER_UNAUTHENTICATED');
    const kind: unknown = v.kind; const id: unknown = v.id; const assurance: unknown = v.assurance;
    const authAt = stamp(v.authenticated_at); const sessionEnd = stamp(v.session_expires_at);
    if (kind !== 'user' || typeof id !== 'string' || !ID_LIKE.test(id)) return refuse('APPROVER_UNAUTHENTICATED');
    if (typeof assurance !== 'string' || !(ASSURANCE_LEVELS as readonly string[]).includes(assurance)) return refuse('APPROVER_UNAUTHENTICATED');
    if (ASSURANCE_LEVELS.indexOf(assurance as Assurance) < ASSURANCE_LEVELS.indexOf(minAssurance)) return refuse('APPROVER_UNAUTHENTICATED');
    if (authAt === null || sessionEnd === null || authAt > nowMs || sessionEnd <= authAt) return refuse('APPROVER_UNAUTHENTICATED');
    if (sessionEnd <= nowMs) return refuse('APPROVER_SESSION_EXPIRED');
    const identity = Object.freeze({ id });

    // 2. Membership in exactly this tenant (the tenant is the one requested for the proposal; the source must confirm it).
    let member: unknown;
    try { member = await bounded(() => deps.membership(identity, workspace), timeoutMs); } catch { return refuse('APPROVER_NOT_MEMBER'); }
    if (member !== true) return refuse('APPROVER_NOT_MEMBER');

    // 3. Approval-only scopes.
    let granted: unknown;
    try { granted = await bounded(() => deps.grants(identity, workspace), timeoutMs); } catch { return refuse('APPROVER_GRANTS_INVALID'); }
    if (!Array.isArray(granted)) return refuse('APPROVER_GRANTS_INVALID');
    const items: unknown[] = [...(granted as unknown[])];
    if (items.length > MAX_SCOPES) return refuse('APPROVER_GRANTS_INVALID');
    const scopes: string[] = [];
    for (const s of items) {
      if (typeof s !== 'string' || !APPROVAL_SCOPE.test(s) || scopes.includes(s)) return refuse('APPROVER_GRANTS_INVALID');
      scopes.push(s);
    }

    let corr: unknown;
    try { corr = deps.newCorrelationId(); } catch { return refuse('APPROVER_CONTEXT_INVALID'); }
    if (typeof corr !== 'string' || !ID_LIKE.test(corr)) return refuse('APPROVER_CONTEXT_INVALID');

    const capped = Math.min(sessionEnd, nowMs + maxSession * 1000);
    const ctx: ApproverContext = Object.freeze({
      workspace_id: workspace, approver: Object.freeze({ kind: 'user' as const, id }), correlation_id: corr, scopes: Object.freeze([...scopes]),
      assurance: assurance as Assurance, authenticated_at: iso(authAt), session_expires_at: iso(capped),
      ...(pinned === undefined ? {} : { proposal_id: pinned as string }),
    });
    minted.add(ctx);
    return { ok: true, context: ctx };
  } catch { return refuse('APPROVER_CONTEXT_INVALID'); }
}
