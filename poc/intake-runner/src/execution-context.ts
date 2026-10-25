// Trusted execution context (proof of concept). Mock-tested foundation only: no network, file, or process APIs.
//
// Three questions are kept apart, and each is answered by a different injected, trusted source:
//   verified identity  (who is acting)           <- deps.verify(credential)           ; the credential goes ONLY here
//   tenant selection   (which business)          <- deps.selectTenant(identity)       ; never from a message
//   permissions        (what may be done)        <- deps.grants(identity, tenant, agent) ; default deny
// A context can be created only by mintExecutionContext() or narrow(). It is frozen, carries exactly ONE tenant, and is
// recognized by identity (a module-private registry), so a copy, a clone, a JSON round trip, a look-alike, or a proxy is
// not a context. narrow() can only drop scopes: workspace, actor, agent and correlation id never change.
// A handoff envelope carries NO authority: the receiver checks it against its own context (acceptHandoff).
//
// This chooses no identity provider, no role model, and no scope names (undecided: FND-27, FND-28, D-08).
// Failures are refusals with fixed text; no input value is ever echoed.

import { isRecord, validateEnvelope } from './contracts.ts';
import type { HandoffEnvelopeV1 } from './contracts.ts';

const ID_LIKE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SCOPE_LIKE = /^[a-z][a-z0-9_.:-]{0,63}$/;
const MAX_SCOPES = 64;

/** The four agents are founder-fixed (FC-01). */
export const AGENTS = ['intake', 'processing', 'quality-control', 'reporting'] as const;
export type AgentName = (typeof AGENTS)[number];
/** Proposed actor kinds (not yet approved). */
export const ACTOR_KINDS = ['user', 'service', 'agent', 'system'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export interface ExecutionContext {
  readonly workspace_id: string;
  readonly actor: { readonly kind: ActorKind; readonly id: string };
  readonly agent: AgentName;
  readonly correlation_id: string;
  readonly scopes: readonly string[];
}

export type ContextErrorCode =
  | 'UNAUTHENTICATED' | 'TENANT_NOT_SELECTED' | 'GRANTS_INVALID' | 'CONTEXT_INVALID'
  | 'CONTEXT_NOT_TRUSTED' | 'NARROW_ONLY'
  | 'ENVELOPE_INVALID' | 'TENANT_MISMATCH' | 'WRONG_RECIPIENT';
export interface Refusal { ok: false; error: { code: ContextErrorCode; message: string } }
export type ContextResult = { ok: true; context: ExecutionContext } | Refusal;
export type HandoffResult = { ok: true; envelope: Readonly<HandoffEnvelopeV1> } | Refusal;

/** What the trusted sources must provide. Each may be synchronous or asynchronous. */
export interface ContextDeps {
  /** Receives the credential and nothing else. Returns { kind, id } for a verified actor, or nothing. */
  verify(credential: unknown): unknown;
  /** Receives the verified identity only (never the credential or a message). Returns the one workspace id, or nothing. */
  selectTenant(identity: Readonly<{ kind: ActorKind; id: string }>): unknown;
  /** Returns the granted scope names (an array of strings). An empty array means nothing is allowed. */
  grants(identity: Readonly<{ kind: ActorKind; id: string }>, workspaceId: string, agent: AgentName): unknown;
  /** Platform-minted correlation id for this run. */
  newCorrelationId(): string;
}

/** Contexts created by this module. Identity-based: copies and look-alikes are not members. */
const minted = new WeakSet<object>();

const REFUSAL_TEXT: Record<ContextErrorCode, string> = {
  UNAUTHENTICATED: 'The caller could not be verified; nothing was processed.',
  TENANT_NOT_SELECTED: 'No single tenant could be selected for this caller; nothing was processed.',
  GRANTS_INVALID: 'Permissions could not be determined; nothing was processed.',
  CONTEXT_INVALID: 'The execution context could not be created; nothing was processed.',
  CONTEXT_NOT_TRUSTED: 'A trusted execution context is required; nothing was processed.',
  NARROW_ONLY: 'A context can only be narrowed by dropping scopes; refused.',
  ENVELOPE_INVALID: 'The handoff envelope is not valid; refused.',
  TENANT_MISMATCH: 'The handoff does not belong to this tenant; refused.',
  WRONG_RECIPIENT: 'This agent is not the recipient of this handoff; refused.',
};
function refuse(code: ContextErrorCode): Refusal {
  return { ok: false, error: { code, message: REFUSAL_TEXT[code] } };
}

/** True only for a context created by this module (not a copy, clone, parsed JSON, look-alike, or proxy). */
export function isTrusted(x: unknown): x is ExecutionContext {
  return typeof x === 'object' && x !== null && minted.has(x);
}

function seal(workspaceId: string, actor: { kind: ActorKind; id: string }, agent: AgentName, correlationId: string, scopes: string[]): ExecutionContext {
  const ctx: ExecutionContext = Object.freeze({
    workspace_id: workspaceId,
    actor: Object.freeze({ kind: actor.kind, id: actor.id }),
    agent,
    correlation_id: correlationId,
    scopes: Object.freeze([...scopes]),
  });
  minted.add(ctx);
  return ctx;
}

/** Each property of a trusted source's answer is read exactly once. */
function readIdentity(v: unknown): { kind: ActorKind; id: string } | null {
  if (!isRecord(v)) return null;
  const kind: unknown = v.kind;
  const id: unknown = v.id;
  if (typeof kind !== 'string' || !(ACTOR_KINDS as readonly string[]).includes(kind)) return null;
  if (typeof id !== 'string' || !ID_LIKE.test(id)) return null;
  return { kind: kind as ActorKind, id };
}

function readScopes(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const items: unknown[] = [...v];            // one pass over the array
  if (items.length > MAX_SCOPES) return null;
  const out: string[] = [];
  for (const s of items) {
    if (typeof s !== 'string' || !SCOPE_LIKE.test(s) || out.includes(s)) return null;
    out.push(s);
  }
  return out;
}

/**
 * Verify, then select the tenant, then look up grants. Stops at the first failure (later sources are not called).
 * Any throw, rejection or malformed answer fails closed with fixed text. A source that never answers is NOT bounded
 * here (no timeout yet); a real verifier needs one.
 */
export async function mintExecutionContext(request: { credential: unknown; agent: AgentName }, deps: ContextDeps): Promise<ContextResult> {
  const agent: unknown = isRecord(request) ? request.agent : undefined;
  if (typeof agent !== 'string' || !(AGENTS as readonly string[]).includes(agent)) return refuse('CONTEXT_INVALID');
  const credential: unknown = request.credential;

  let identity: { kind: ActorKind; id: string } | null;
  try { identity = readIdentity(await deps.verify(credential)); } catch { return refuse('UNAUTHENTICATED'); }
  if (!identity) return refuse('UNAUTHENTICATED');
  const frozenIdentity = Object.freeze({ kind: identity.kind, id: identity.id });

  let tenant: unknown;
  try { tenant = await deps.selectTenant(frozenIdentity); } catch { return refuse('TENANT_NOT_SELECTED'); }
  if (typeof tenant !== 'string' || !ID_LIKE.test(tenant)) return refuse('TENANT_NOT_SELECTED');

  let scopes: string[] | null;
  try { scopes = readScopes(await deps.grants(frozenIdentity, tenant, agent as AgentName)); } catch { return refuse('GRANTS_INVALID'); }
  if (!scopes) return refuse('GRANTS_INVALID');

  let correlationId: unknown;
  try { correlationId = deps.newCorrelationId(); } catch { return refuse('CONTEXT_INVALID'); }
  if (typeof correlationId !== 'string' || !ID_LIKE.test(correlationId)) return refuse('CONTEXT_INVALID');

  return { ok: true, context: seal(tenant, identity, agent as AgentName, correlationId, scopes) };
}

/**
 * A narrower context for a sub-task or a tool: same workspace, actor, agent and correlation id, and a subset of the
 * scopes. Anything else in `change` (including an attempt to name a workspace, actor or agent) is refused.
 */
export function narrow(ctx: unknown, change: { keep_scopes: readonly string[] }): ContextResult {
  if (!isTrusted(ctx)) return refuse('CONTEXT_NOT_TRUSTED');
  if (!isRecord(change)) return refuse('NARROW_ONLY');
  const keys = Object.keys(change);
  if (keys.length !== 1 || keys[0] !== 'keep_scopes') return refuse('NARROW_ONLY');
  const wanted: unknown = change.keep_scopes;
  if (!Array.isArray(wanted)) return refuse('NARROW_ONLY');
  const items: unknown[] = [...wanted];
  const keep: string[] = [];
  for (const s of items) {
    if (typeof s !== 'string' || keep.includes(s) || !ctx.scopes.includes(s)) return refuse('NARROW_ONLY');
    keep.push(s);
  }
  return { ok: true, context: seal(ctx.workspace_id, ctx.actor, ctx.agent, ctx.correlation_id, ctx.scopes.filter((s) => keep.includes(s))) };
}

/** Default deny: true only for a trusted context that holds exactly this scope. */
export function can(ctx: unknown, scope: unknown): boolean {
  return isTrusted(ctx) && typeof scope === 'string' && ctx.scopes.includes(scope);
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const child of Object.values(v as Record<string, unknown>)) deepFreeze(child);
  }
  return v;
}

/**
 * The receiving agent's check of a work_item.v1 handoff against ITS OWN trusted context. The envelope is copied once
 * (getters are read once; a proxy or uncloneable value is refused), validated against the contract, and must name the
 * context's one tenant. The recipient of work_item.v1 is Processing. The envelope grants no permission.
 */
export function acceptHandoff(ctx: unknown, envelope: unknown): HandoffResult {
  if (!isTrusted(ctx)) return refuse('CONTEXT_NOT_TRUSTED');
  if (ctx.agent !== 'processing') return refuse('WRONG_RECIPIENT');
  let copy: unknown;
  try { copy = structuredClone(envelope); } catch { return refuse('ENVELOPE_INVALID'); }
  if (!isRecord(copy) || validateEnvelope(copy).length > 0) return refuse('ENVELOPE_INVALID');
  if (copy.workspace_id !== ctx.workspace_id) return refuse('TENANT_MISMATCH');
  return { ok: true, envelope: deepFreeze(copy as unknown as HandoffEnvelopeV1) };
}
