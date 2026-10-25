// The Processing entry (proof of concept, mock tools only). It consumes ONE trusted in-process Intake handoff and runs a
// fixed plan of allow-listed tools, returning a validated candidate_result.v1.
//
//   fixed at setup: tool registry, the plan (ordered tool names), clock, per-call timeout, optional telemetry sink, and
//     (only if a plan tool needs it) the approval store. `run` has no options parameter: a caller or an envelope cannot choose
//     tools, scopes, arguments, or a store.
//   authority: a minted Processing context (agent `processing`) with `processing:run`, plus each tool's own scope.
//     ALL scopes are checked before the first tool call, so a missing scope means no partial work (default deny).
//   input: an envelope that the Intake entry sealed (handoff-seal.ts) and that still matches its seal, then the existing
//     receiver check acceptHandoff (trusted context, recipient, contract, tenant). Copied once; getters are read once.
//   tool arguments: step id, item id and the CONTEXT's tenant only. No message text, no category, no field values.
//   idempotency: a step id is derived from tenant, item and position; a repeated or concurrent run of the same item reuses
//     the first successful result and makes no second call.
//   three kinds of tool outcome, never confused:
//     performed       `{ evidence_ref }`: the step is `ok`.
//     NOT performed   `{ not_performed: true }`: the tool says, definitively, that nothing happened. The step is `failed`
//                     (TOOL_NOT_PERFORMED) and ONLY this outcome may be tried again later.
//     UNCERTAIN       a timeout, a thrown error, or an unreadable answer: the effect is unknown (the call may have written,
//                     or may still write later). The step is `uncertain` (TOOL_TIMEOUT / TOOL_FAILED / TOOL_OUTPUT_INVALID) and
//                     the tool is NEVER called again for that step by blind retry. A late answer from the abandoned call is
//                     only learned from: a late success is remembered (later runs return that evidence without calling),
//                     a late not-performed clears the doubt, a late error changes nothing.
//   ASSISTED tools (the default) keep that knowledge in this process only (a restart forgets it).
//   HUMAN-APPROVED tools (`approval: 'human'`, needs the approval store) pause for a named human and keep their state durably in
//     the store, which is the authority, never this process:
//       first run   no request yet (or the last one expired unanswered or ended in a definitive "not performed"): propose,
//                   record the request, and PAUSE. The result is `pending`; nothing was called.
//       resume      the same item run again (Intake's item id is deterministic, so it finds the same step):
//                   requested -> still pending; claimed by another run -> pending (in progress); declined -> the step is
//                   `failed` (APPROVAL_DECLINED) and stays so; succeeded -> `ok` from the recorded evidence, no call;
//                   approved -> CLAIM durably first (one atomic claim; the store re-checks that the action presented now is the
//                   action approved), and only then call the tool with the step id as its idempotency key.
//       after the call  evidence -> record `succeeded`; `{ not_performed: true }` -> record `failed`. If the store does NOT accept that
//                   record, the step is `uncertain` (COMPLETION_NOT_RECORDED), never `ok` and never `failed`: an outcome that is not durably
//                   recorded is not verified, and the claim lapses to in-doubt for a read-back. Timeout, throw or an
//                   unreadable answer -> record NOTHING: the claim lapses to in-doubt, the step is `uncertain`, and a later run
//                   calls the tool again only if it is declared idempotent, within the store's attempt limit. A late answer from
//                   an abandoned call is recorded if its claim is still the latest.
//       store trouble  any store error, timeout or unreadable answer FAILS CLOSED: no call, the run is refused.
//       lease          the store's claim lease must be longer than three tool timeouts (the claim answer, the call, and the record may
//                   each take one), checked at setup; a store that does not state its lease is refused.
//     The fence token of a claim never reaches the tool. A pending proposal can be handed to an approver only while this
//     process lives (seals do not persist; seal recovery is a later gate).
//   never throws at request time; bad setup throws a RangeError. No real side effects: tools here are mocks.
// Imports no network, file, or process APIs.

import { isRecord, TIMESTAMP } from './contracts.ts';
import type { HandoffEnvelopeV1 } from './contracts.ts';
import { proposeAction } from './approval.ts';
import type { ProposalV1 } from './approval.ts';
import type { ApprovalStore } from './approval-store.ts';
import { CANDIDATE_CONTRACT, NOT_PERFORMED_CODE, stepIdFor, validateCandidate } from './candidate-result.ts';
import type { CandidateResultV1, StepRecord } from './candidate-result.ts';
import { acceptHandoff, can, isTrusted } from './execution-context.ts';
import type { ContextErrorCode } from './execution-context.ts';
import { contentDigest, isSealedHandoff, sealCandidate } from './handoff-seal.ts';
import { createEmitter } from './observability.ts';
import type { Sink } from './observability.ts';

export const PROCESSING_RUN_SCOPE = 'processing:run';

export type ProcessingErrorCode = 'HANDOFF_NOT_TRUSTED' | 'PROCESSING_NOT_PERMITTED' | 'PROCESSING_ERROR';
export type StepFailureCode = 'TOOL_FAILED' | 'TOOL_TIMEOUT' | 'TOOL_OUTPUT_INVALID' | 'COMPLETION_NOT_RECORDED' | 'TOOL_NOT_PERFORMED' | 'APPROVAL_DECLINED';
export interface ProcessingRefusal { ok: false; error: { code: ProcessingErrorCode | ContextErrorCode; message: string } }
/** A human-approved step that cannot proceed yet. Nothing was called. `proposal` is present only while this process holds the sealed object. */
export interface PendingApproval {
  readonly kind: 'awaiting_approval' | 'in_progress';
  readonly proposal_id: string;
  readonly item_id: string;
  readonly step_id: string;
  readonly tool: string;
  readonly expires_at: string;
  readonly proposal?: Readonly<ProposalV1>;
}
export type ProcessingResult = { ok: true; candidate: Readonly<CandidateResultV1> } | { ok: true; pending: Readonly<PendingApproval> } | ProcessingRefusal;

const TEXT: Record<ProcessingErrorCode, string> = {
  HANDOFF_NOT_TRUSTED: 'The handoff was not issued by the Intake entry or was changed; nothing was processed.',
  PROCESSING_NOT_PERMITTED: 'The caller is not permitted to run Processing or its tools; nothing was processed.',
  PROCESSING_ERROR: 'The request could not be processed; nothing was done.',
};
const CONTEXT_TEXT: Partial<Record<ContextErrorCode, string>> = {
  CONTEXT_NOT_TRUSTED: 'A trusted execution context is required; nothing was processed.',
  WRONG_RECIPIENT: 'This agent is not the recipient of this handoff; refused.',
  ENVELOPE_INVALID: 'The handoff envelope is not valid; refused.',
  TENANT_MISMATCH: 'The handoff does not belong to this tenant; refused.',
};
function refuse(code: ProcessingErrorCode | ContextErrorCode): ProcessingRefusal {
  const message = code in TEXT ? TEXT[code as ProcessingErrorCode] : (CONTEXT_TEXT[code as ContextErrorCode] ?? TEXT.PROCESSING_ERROR);
  return { ok: false, error: { code, message } };
}

// ---------------------------------------------------------------- tool registry
const TOOL_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const SCOPE_LIKE = /^[a-z][a-z0-9_.:-]{0,63}$/;
const REF = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_APPROVAL_ARGUMENT_CHARS = 1000;

export interface ToolArgs { readonly step_id: string; readonly item_id: string; readonly workspace_id: string }
export interface ToolDefinition {
  scope: string;
  run(args: ToolArgs, signal: AbortSignal): Promise<unknown> | unknown;
  /** `human`: the step needs a named human's approval, recorded in the approval store, before it may run. */
  approval?: 'human';
  /** The tool dedupes on the step id, so an in-doubt step may be retried (human-approved tools only). Default: not idempotent. */
  idempotent?: boolean;
  /** Plain JSON fixed at setup that is part of the approved action (human-approved tools only). Default `{}`. Never customer data. */
  approvalArguments?: unknown;
}
export interface Tool {
  readonly name: string; readonly scope: string; readonly run: ToolDefinition['run'];
  readonly approval?: 'human'; readonly idempotent?: boolean; readonly approvalArguments?: unknown;
}
export interface ToolRegistry { get(name: string): Tool | undefined; has(name: string): boolean; list(): readonly Tool[]; readonly size: number }

function plainJson(v: unknown, depth = 0): unknown | undefined {
  if (depth > 4) return undefined;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (Array.isArray(v)) { const out: unknown[] = []; for (const x of v as unknown[]) { const c = plainJson(x, depth + 1); if (c === undefined) return undefined; out.push(c); } return out; }
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
function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const c of Object.values(v as Record<string, unknown>)) deepFreeze(c); }
  return v;
}

/** Frozen allow-list of tools. Each definition is read once; names and scopes are validated; membership cannot change later. */
export function createToolRegistry(defs: Record<string, ToolDefinition>): ToolRegistry {
  if (!isRecord(defs)) throw new RangeError('tool definitions must be an object');
  const tools = new Map<string, Tool>();
  for (const name of Object.keys(defs)) {
    if (!TOOL_NAME.test(name)) throw new RangeError('tool name is not allowed');
    const def: unknown = defs[name];
    if (!isRecord(def)) throw new RangeError('tool definition must be an object');
    const scope: unknown = def.scope;
    const run: unknown = def.run;
    const approval: unknown = def.approval;
    const idempotent: unknown = def.idempotent;
    const approvalArguments: unknown = def.approvalArguments;
    if (typeof scope !== 'string' || !SCOPE_LIKE.test(scope) || scope === PROCESSING_RUN_SCOPE) throw new RangeError('tool scope is not allowed');
    if (typeof run !== 'function') throw new RangeError('tool must have a run function');
    if (approval !== undefined && approval !== 'human') throw new RangeError('tool approval must be "human" or absent');
    if (idempotent !== undefined && typeof idempotent !== 'boolean') throw new RangeError('tool idempotent flag must be true or false');
    if ((idempotent !== undefined || approvalArguments !== undefined) && approval !== 'human') throw new RangeError('idempotent and approvalArguments belong to human-approved tools');
    let args: unknown;
    if (approval === 'human') {
      args = approvalArguments === undefined ? {} : plainJson(approvalArguments);
      if (args === undefined || JSON.stringify(args).length > MAX_APPROVAL_ARGUMENT_CHARS) throw new RangeError('approvalArguments must be small plain JSON');
    }
    tools.set(name, Object.freeze({
      name, scope, run: run as ToolDefinition['run'],
      ...(approval === 'human' ? { approval: 'human' as const, idempotent: idempotent === true, approvalArguments: deepFreeze(args) } : {}),
    }));
  }
  if (tools.size === 0) throw new RangeError('at least one tool is required');
  const list = Object.freeze([...tools.values()]);
  return Object.freeze({
    get: (name: string) => (typeof name === 'string' ? tools.get(name) : undefined),
    has: (name: string) => typeof name === 'string' && tools.has(name),
    list: () => list,
    size: tools.size,
  });
}
/**
 * The human-approved tools of a registry, with the arguments that are part of each approved action: what Quality Control needs to be told so
 * that it can check approvals itself. Build Quality Control's `approvals.tools` from this, so the two cannot disagree about which tools need a human.
 */
export function humanApprovalExpectations(tools: ToolRegistry): Record<string, { arguments: unknown }> {
  const out: Record<string, { arguments: unknown }> = {};
  for (const t of tools.list()) if (t.approval === 'human') out[t.name] = { arguments: t.approvalArguments ?? {} };
  return out;
}
/** The tools declared idempotent: the one source for the approval store's `idempotentTools`, so the two cannot drift apart. */
export function idempotentToolNames(tools: ToolRegistry): string[] {
  return tools.list().filter((t) => t.approval === 'human' && t.idempotent === true).map((t) => t.name);
}

// ---------------------------------------------------------------- entry
/** What Processing may do with the approval store: propose, look up, claim and complete. Never decide, never settle. */
export type ProcessingStore = Pick<ApprovalStore, 'putProposal' | 'claim' | 'complete' | 'findByStep' | 'leaseSeconds'>;
export interface ProcessingApprovalConfig {
  store: ApprovalStore;
  /** How long a request stays open, 1 to 86400 s (default 3600). */
  ttlSeconds?: number;
}
export interface ProcessingEntryConfig {
  tools: ToolRegistry;
  /** Ordered tool names, fixed at setup, 1 to 8, no repeats. */
  plan: readonly string[];
  now: () => string;
  /** Per tool call and per approval-store call, 1 to 30000 ms (default 5000). */
  timeoutMs?: number;
  /** Optional best-effort telemetry sink; events are stamped from the minted context. */
  sink?: Sink;
  /** Required when a plan tool is human-approved. */
  approval?: ProcessingApprovalConfig;
}
export interface ProcessingEntry { run(ctx: unknown, envelope: unknown): Promise<ProcessingResult> }

type UncertainCode = 'TOOL_FAILED' | 'TOOL_TIMEOUT' | 'TOOL_OUTPUT_INVALID' | 'COMPLETION_NOT_RECORDED';
type Outcome =
  | { kind: 'ok'; ref: string } | { kind: 'not_performed' } | { kind: 'declined' } | { kind: 'uncertain'; code: UncertainCode };
/** What this process knows about one ASSISTED step. No entry means: never tried, or known not to have happened. */
type Slot = { state: 'running'; shared: Promise<Outcome> } | { state: 'succeeded'; ref: string } | { state: 'uncertain'; code: UncertainCode };
type HumanResult = { kind: 'outcome'; outcome: Outcome } | { kind: 'pending'; pending: PendingApproval } | { kind: 'closed' };
const STORE_FAILED = Symbol('store failed');

/** Reads a tool's answer. Only two exact shapes mean something; anything else is unreadable, which is uncertain, not failed. */
function interpret(out: unknown): Outcome {
  if (isRecord(out)) {
    const o = out as Record<string, unknown>;
    if (Object.hasOwn(o, 'not_performed')) return o.not_performed === true && !Object.hasOwn(o, 'evidence_ref') ? { kind: 'not_performed' } : { kind: 'uncertain', code: 'TOOL_OUTPUT_INVALID' };
    if (typeof o.evidence_ref === 'string' && REF.test(o.evidence_ref)) return { kind: 'ok', ref: o.evidence_ref };
  }
  return { kind: 'uncertain', code: 'TOOL_OUTPUT_INVALID' };
}

export function createProcessingEntry(config: ProcessingEntryConfig): ProcessingEntry {
  if (!isRecord(config)) throw new RangeError('processing configuration must be an object');
  const { tools, plan, now, timeoutMs, sink, approval } = config;
  if (!isRecord(tools) || typeof tools.get !== 'function' || typeof tools.has !== 'function' || !Object.isFrozen(tools)) throw new RangeError('tools must be a frozen tool registry');
  if (!Array.isArray(plan) || plan.length < 1 || plan.length > 8) throw new RangeError('plan must list 1 to 8 tools');
  const names: string[] = [...(plan as unknown[])].map((n) => { if (typeof n !== 'string' || !tools.has(n)) throw new RangeError('plan names a tool that is not registered'); return n; });
  if (new Set(names).size !== names.length) throw new RangeError('plan must not repeat a tool');
  if (typeof now !== 'function') throw new RangeError('now must be a function');
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)) throw new RangeError('timeoutMs must be an integer from 1 to 30000');
  if (sink !== undefined && (!isRecord(sink) || typeof sink.write !== 'function')) throw new RangeError('sink must have a write function');

  const fixedPlan: readonly Tool[] = Object.freeze(names.map((n) => tools.get(n) as Tool));
  let store: ProcessingStore | undefined;
  let ttl = 3600;
  if (approval !== undefined) {
    const st: unknown = isRecord(approval) ? approval.store : undefined;
    if (!isRecord(st) || ['putProposal', 'claim', 'complete', 'findByStep'].some((f) => typeof (st as Record<string, unknown>)[f] !== 'function')) throw new RangeError('approval store must provide putProposal, claim, complete and findByStep');
    const s = st as unknown as ApprovalStore;
    // Least authority: Processing keeps only the four operations it uses. It can neither record a decision nor settle an in-doubt claim.
    store = Object.freeze({
      leaseSeconds: s.leaseSeconds,
      putProposal: (c, p) => s.putProposal(c, p), claim: (c, i, a) => s.claim(c, i, a), complete: (c, i, k, o) => s.complete(c, i, k, o), findByStep: (c, i) => s.findByStep(c, i),
    });
    const ttlSeconds = (approval as ProcessingApprovalConfig).ttlSeconds;
    if (ttlSeconds !== undefined) {
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86_400) throw new RangeError('ttlSeconds must be an integer from 1 to 86400');
      ttl = ttlSeconds;
    }
  }
  if (fixedPlan.some((t) => t.approval === 'human') && store === undefined) throw new RangeError('a human-approved tool needs an approval store');
  const limit = timeoutMs ?? 5000;
  // A claim must still be open when the tool has answered and the answer has been recorded. Three bounded steps can each take one timeout.
  if (store !== undefined && fixedPlan.some((t) => t.approval === 'human')) {
    const lease = (store as ProcessingStore).leaseSeconds;
    if (typeof lease !== 'number' || !Number.isInteger(lease) || lease * 1000 <= 3 * limit) throw new RangeError('the approval store lease must be longer than three tool timeouts');
  }
  const approvals = store;
  const clock = now;
  const fixedSink: Sink | undefined = sink === undefined ? undefined : Object.freeze({ write: (e) => sink.write(e) });
  /** step id -> what is known about it (ASSISTED tools only). Concurrent runs share one call; an uncertain step is not called again. */
  const slots = new Map<string, Slot>();
  /** Sealed proposals this process created, so an in-process approval surface can be handed the object. */
  const known = new Map<string, ProposalV1>();

  function report(ctx: unknown, result: ProcessingResult): void {
    if (fixedSink === undefined) return;
    try {
      const made = createEmitter(ctx, fixedSink, { now: clock });
      if (!made.ok) return;
      const em = made.emitter;
      if (result.ok && 'candidate' in result) {
        const failed = result.candidate.steps.find((s) => s.status === 'failed' || s.status === 'uncertain');
        em.emit({ event: 'run.finished', item_id: result.candidate.item_id, counts: { attempts: result.candidate.steps.length }, ...(failed?.code ? { error_code: failed.code } : {}) });
      } else if (result.ok) {
        em.emit({ event: 'run.finished', item_id: result.pending.item_id, counts: { attempts: 1 } });
      } else {
        const handoffSide = ['HANDOFF_NOT_TRUSTED', 'ENVELOPE_INVALID', 'TENANT_MISMATCH', 'WRONG_RECIPIENT'].includes(result.error.code);
        em.emit({ event: handoffSide ? 'handoff.refused' : 'run.refused', error_code: result.error.code });
      }
    } catch { /* telemetry must not affect the run */ }
  }

  /**
   * Starts the one call for a step. The returned promise never rejects and settles at the answer or the timeout, whichever is first.
   * `first` sees that outcome; `late` sees the answer of an abandoned call that finishes after the timeout.
   */
  function startCall(tool: Tool, args: ToolArgs, hooks: { first?: (o: Outcome) => void; late?: (o: Outcome) => void }): Promise<Outcome> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<Outcome>((resolve) => { timer = setTimeout(() => { timedOut = true; controller.abort(); resolve({ kind: 'uncertain', code: 'TOOL_TIMEOUT' }); }, limit); });
    const underlying: Promise<Outcome> = (async () => {
      let out: unknown;
      try { out = await tool.run(args, controller.signal); } catch { return { kind: 'uncertain', code: 'TOOL_FAILED' } as Outcome; }
      return interpret(out);
    })();
    const shared = Promise.race([underlying, timeout]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
    shared.then((o) => { try { hooks.first?.(o); } catch { /* bookkeeping must not break the run */ } });
    underlying.then((o) => { if (timedOut) { try { hooks.late?.(o); } catch { /* same */ } } });
    return shared;
  }

  /** One ASSISTED step: the in-process memory is the authority. */
  function assistedStep(stepId: string, tool: Tool, args: ToolArgs): Promise<Outcome> | Outcome {
    const slot = slots.get(stepId);
    if (slot?.state === 'succeeded') return { kind: 'ok', ref: slot.ref };
    if (slot?.state === 'uncertain') return { kind: 'uncertain', code: slot.code };   // known to be uncertain: no call
    if (slot?.state === 'running') return slot.shared;                                // someone is already calling: share it
    const shared = startCall(tool, args, {
      first: (o) => {
        if (o.kind === 'ok') slots.set(stepId, { state: 'succeeded', ref: o.ref });
        else if (o.kind === 'not_performed') slots.delete(stepId);
        else if (o.kind === 'uncertain') slots.set(stepId, { state: 'uncertain', code: o.code });
      },
      // The abandoned call may still answer after the timeout. Learn from it; never call again because of it.
      late: (o) => {
        if (o.kind === 'ok') slots.set(stepId, { state: 'succeeded', ref: o.ref });
        else if (o.kind === 'not_performed') slots.delete(stepId);
      },
    });
    slots.set(stepId, { state: 'running', shared });
    return shared;
  }

  // ---------------------------------------------------------------- human-approved steps (the store is the authority)
  /** A bounded store call. Any throw, rejection, timeout or unreadable answer is STORE_FAILED, which fails the run closed. */
  async function storeCall(fn: () => unknown): Promise<{ ok: true; [k: string]: any } | { ok: false; error: { code: string } } | typeof STORE_FAILED> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const gate = new Promise<typeof STORE_FAILED>((resolve) => { timer = setTimeout(() => resolve(STORE_FAILED), limit); });
      const call = Promise.resolve().then(fn).catch(() => STORE_FAILED);
      call.catch(() => {});
      const r: unknown = await Promise.race([call, gate]);
      if (r === STORE_FAILED || !isRecord(r) || typeof (r as Record<string, unknown>).ok !== 'boolean') return STORE_FAILED;
      if ((r as Record<string, unknown>).ok === false && !(isRecord((r as Record<string, unknown>).error) && typeof ((r as Record<string, any>).error).code === 'string')) return STORE_FAILED;
      return r as { ok: true } | { ok: false; error: { code: string } };
    } catch { return STORE_FAILED; } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  /** True when the store accepted the record. A record the store did not accept is not a verified outcome (see the caller). */
  async function record(ctx: unknown, proposalId: string, claimId: string, o: Outcome): Promise<boolean> {
    if (approvals === undefined) return false;
    let r: Awaited<ReturnType<typeof storeCall>> | undefined;
    if (o.kind === 'ok') r = await storeCall(() => approvals.complete(ctx, proposalId, claimId, { status: 'succeeded', evidence_ref: o.ref }));
    else if (o.kind === 'not_performed') r = await storeCall(() => approvals.complete(ctx, proposalId, claimId, { status: 'failed' }));
    else return true;                                   // an uncertain outcome records nothing, by design
    return r !== undefined && r !== STORE_FAILED && r.ok === true;
  }

  async function humanStep(ctx: unknown, tool: Tool, stepId: string, itemId: string, tenant: string): Promise<HumanResult> {
    const st = approvals as ProcessingStore;
    // One frozen action object, built once: it is what is proposed, what is claimed, and what the tool is asked to do.
    const action = deepFreeze({ item_id: itemId, step_id: stepId, tool: tool.name, arguments: tool.approvalArguments ?? {} });
    const pendingOf = (kind: PendingApproval['kind'], snap: any): HumanResult => {
      const proposal = known.get(snap.proposal_id);
      return { kind: 'pending', pending: deepFreeze({ kind, proposal_id: snap.proposal_id, item_id: itemId, step_id: stepId, tool: tool.name, expires_at: snap.expires_at, ...(proposal ? { proposal } : {}) }) };
    };
    for (let round = 0; round < 4; round++) {
      const found = await storeCall(() => st.findByStep(ctx, stepId));
      if (found === STORE_FAILED) return { kind: 'closed' };
      let snap: any = null;
      if (found.ok) snap = (found as any).snapshot;
      else if (found.error.code !== 'STORE_NOT_FOUND') return { kind: 'closed' };
      const state: string | undefined = snap?.state;

      if (state === 'succeeded') {
        const ref = snap.outcome?.evidence_ref;
        return typeof ref === 'string' && REF.test(ref) ? { kind: 'outcome', outcome: { kind: 'ok', ref } } : { kind: 'closed' };
      }
      if (state === 'declined') return { kind: 'outcome', outcome: { kind: 'declined' } };
      if (state === 'requested') return pendingOf('awaiting_approval', snap);
      if (state === 'claimed') return pendingOf('in_progress', snap);

      if (state === undefined || state === 'expired' || state === 'failed') {
        const made = proposeAction(ctx, action, { now: clock, ttlSeconds: ttl });
        if (!made.ok) return { kind: 'closed' };
        const put = await storeCall(() => st.putProposal(ctx, made.proposal));
        if (put === STORE_FAILED) return { kind: 'closed' };
        if (put.ok && (put as any).created === true) { known.set(made.proposal.proposal_id, made.proposal); return pendingOf('awaiting_approval', (put as any).snapshot); }
        continue;   // another run proposed first, or this is the same request again: look once more
      }

      // approved, or in doubt after a lapsed claim
      if (state === 'in_doubt' && tool.idempotent !== true) return { kind: 'outcome', outcome: { kind: 'uncertain', code: 'TOOL_TIMEOUT' } };
      const got = await storeCall(() => st.claim(ctx, snap.proposal_id, action));
      if (got === STORE_FAILED) return { kind: 'closed' };
      if (!got.ok) {
        const c = got.error.code;
        if (c === 'CLAIM_CONFLICT') return pendingOf('in_progress', snap);
        if (c === 'IN_DOUBT' || c === 'RETRY_LIMIT') return { kind: 'outcome', outcome: { kind: 'uncertain', code: 'TOOL_TIMEOUT' } };
        if (c === 'EFFECT_ALREADY_DONE' || c === 'NOT_APPROVED' || c === 'PROPOSAL_EXPIRED') continue;   // the state moved: look again
        return { kind: 'closed' };                                                                       // ACTION_MISMATCH, not permitted, store error...
      }
      const grant = (got as any).grant;
      if (!isRecord(grant) || typeof grant.claim_id !== 'string') return { kind: 'closed' };
      const proposalId: string = snap.proposal_id;
      const claimId: string = grant.claim_id;

      // The claim is durable now. Only now may the tool run; the fence token stays here.
      const outcome = await startCall(tool, Object.freeze({ step_id: stepId, item_id: itemId, workspace_id: tenant }), {
        late: (o) => { void record(ctx, proposalId, claimId, o); },     // a late answer is recorded if its claim is still the latest
      });
      // An outcome the store did not accept is not durable, so it is not verified: report it as uncertain and leave the claim to lapse
      // to in-doubt for a read-back. (An uncertain outcome records nothing, by design.)
      if (!(await record(ctx, proposalId, claimId, outcome))) return { kind: 'outcome', outcome: { kind: 'uncertain', code: 'COMPLETION_NOT_RECORDED' } };
      return { kind: 'outcome', outcome };
    }
    return { kind: 'closed' };
  }

  async function runInner(ctx: unknown, envelope: unknown): Promise<ProcessingResult> {
    // 1. Authority first, before the envelope is touched.
    if (!isTrusted(ctx)) return refuse('CONTEXT_NOT_TRUSTED');
    if (ctx.agent !== 'processing') return refuse('WRONG_RECIPIENT');
    if (!can(ctx, PROCESSING_RUN_SCOPE)) return refuse('PROCESSING_NOT_PERMITTED');
    const tenant = ctx.workspace_id;
    const correlation = ctx.correlation_id;

    // 2. The handoff: copied once, then it must be a sealed Intake handoff, then the receiver check.
    let copy: unknown;
    try { copy = structuredClone(envelope); } catch { return refuse('ENVELOPE_INVALID'); }
    if (!isSealedHandoff(envelope, copy)) return refuse('HANDOFF_NOT_TRUSTED');
    const accepted = acceptHandoff(ctx, copy);
    if (!accepted.ok) return refuse(accepted.error.code);
    const env: Readonly<HandoffEnvelopeV1> = accepted.envelope;

    // 3. Every scope the plan needs, before any tool runs.
    for (const tool of fixedPlan) if (!can(ctx, tool.scope)) return refuse('PROCESSING_NOT_PERMITTED');

    // 4. Clock before any side effect, so a bad clock cannot leave work half done.
    let createdAt: unknown;
    try { createdAt = clock(); } catch { return refuse('PROCESSING_ERROR'); }
    if (typeof createdAt !== 'string' || !TIMESTAMP.test(createdAt)) return refuse('PROCESSING_ERROR');

    // 5. Run the fixed plan in order; stop at the first step that is not ok (or that must wait for a human).
    const steps: StepRecord[] = [];
    let stopped = false;
    for (let i = 0; i < fixedPlan.length; i++) {
      const tool = fixedPlan[i];
      const stepId = stepIdFor(tenant, env.item_id, i, tool.name);
      const needsHuman = tool.approval === 'human' ? ({ approval: 'human' } as const) : {};   // the step says so, so QC can tell a gate that was skipped
      if (stopped) { steps.push({ step_id: stepId, tool: tool.name, status: 'skipped', ...needsHuman }); continue; }
      let outcome: Outcome;
      if (tool.approval === 'human') {
        const h = await humanStep(ctx, tool, stepId, env.item_id, tenant);
        if (h.kind === 'closed') return refuse('PROCESSING_ERROR');         // store trouble fails closed: nothing more is called
        if (h.kind === 'pending') return { ok: true, pending: h.pending };    // paused: no candidate yet
        outcome = h.outcome;
      } else {
        outcome = await assistedStep(stepId, tool, Object.freeze({ step_id: stepId, item_id: env.item_id, workspace_id: tenant }));
      }
      if (outcome.kind === 'ok') steps.push({ step_id: stepId, tool: tool.name, status: 'ok', evidence_ref: outcome.ref, ...needsHuman });
      else {
        stopped = true;
        steps.push(outcome.kind === 'not_performed'
          ? { step_id: stepId, tool: tool.name, status: 'failed', code: NOT_PERFORMED_CODE, ...needsHuman }
          : outcome.kind === 'declined'
            ? { step_id: stepId, tool: tool.name, status: 'failed', code: 'APPROVAL_DECLINED', ...needsHuman }
            : { step_id: stepId, tool: tool.name, status: 'uncertain', code: outcome.code, ...needsHuman });
      }
    }

    const anyUncertain = steps.some((s) => s.status === 'uncertain');
    const candidate: CandidateResultV1 = {
      contract: CANDIDATE_CONTRACT, workspace_id: tenant, item_id: env.item_id, correlation_id: correlation, parent_correlation_id: env.correlation_id, handoff_digest: contentDigest(env),
      status: anyUncertain ? 'uncertain' : steps.some((s) => s.status === 'failed') ? 'failed' : 'complete', steps,
      evidence_refs: steps.flatMap((s) => (s.status === 'ok' && s.evidence_ref !== undefined ? [s.evidence_ref] : [])),
      produced_by: 'processing', created_at: createdAt,
    };
    if (validateCandidate(candidate).length > 0) return refuse('PROCESSING_ERROR');
    deepFreeze(candidate);
    sealCandidate(candidate);   // QC accepts only candidates this entry issued, unchanged
    return { ok: true, candidate };
  }

  async function run(ctx: unknown, envelope: unknown): Promise<ProcessingResult> {
    let result: ProcessingResult;
    try { result = await runInner(ctx, envelope); } catch { result = refuse('PROCESSING_ERROR'); }
    report(ctx, result);
    return result;
  }

  return Object.freeze({ run });
}
