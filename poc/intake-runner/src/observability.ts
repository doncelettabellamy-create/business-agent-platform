// Vendor-neutral observability for all four agents (proof of concept): an allow-list event emitter and one failure taxonomy.
// No network, file, or process APIs; no third-party library. A real transport (OpenTelemetry, a log store) would sit
// BEHIND the sink interface later and would receive only what this module lets through.
//
// What an event can contain (everything else is dropped, and nothing is ever copied from a caller's text):
//   stamped by the emitter from the minted ExecutionContext: workspace_id, correlation_id, agent, actor_kind
//   stamped from setup: schema version, timestamp (injected clock), scope, delivery
//   chosen by the caller from FIXED sets only: event name, item id (wi-<12 hex>), outcome, error code (must be a known
//     code), work-item reason codes, step records (skill name, source, small integers, known failure code), counts under
//     fixed names, duration.
// Category names, field names, field values, message text, config keys and error messages are NOT accepted anywhere:
// those are tenant-supplied customer content.
//
// Two paths, kept separate:
//   emit()          best-effort telemetry. Never throws, never waits, never changes the caller's result. Failures are counted.
//   emitMandatory() the audit path. Goes ONLY to a separate audit sink (never the telemetry sink), is awaited, and
//                   returns false on any failure so the CALLER can block the state change. The rule that a failed audit
//                   write blocks the change is an open founder decision (AU2); this only reports the failure faithfully.
//                   With no audit sink configured it always returns false: it never pretends an audit exists.

import { REASON_CODES, TIMESTAMP, isRecord } from './contracts.ts';
import { isTrusted } from './execution-context.ts';
import type { ActorKind, AgentName, ExecutionContext } from './execution-context.ts';

// ---------------------------------------------------------------- failure taxonomy
export const FAILURE_CLASSES = [
  'refused_input', 'refused_authentication', 'refused_permission', 'refused_tenant',
  'dependency_failure', 'contract_failure', 'safety_violation', 'internal_error',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];
export type Level = 'info' | 'warn' | 'error';

export interface ClassInfo { level: Level; retryable: boolean; alert: boolean }
/** How each class is reported. `alert` marks classes that should raise an alert on any occurrence. */
export const CLASS_INFO: Readonly<Record<FailureClass, ClassInfo>> = Object.freeze({
  refused_input: { level: 'warn', retryable: false, alert: false },
  refused_authentication: { level: 'warn', retryable: false, alert: false },
  refused_permission: { level: 'warn', retryable: false, alert: false },
  refused_tenant: { level: 'warn', retryable: false, alert: false },
  dependency_failure: { level: 'error', retryable: true, alert: false },
  contract_failure: { level: 'error', retryable: false, alert: false },
  safety_violation: { level: 'error', retryable: false, alert: true },
  internal_error: { level: 'error', retryable: false, alert: false },
});

/**
 * Every error code the Intake modules can return, with its class. A test reads the code unions from the source files and
 * fails when a code is added without an entry here. Note: CONTRACT_INVALID is also what the tenant boundary returns when a
 * result names a different tenant; the code alone cannot tell the two apart.
 */
export const ERROR_CLASS: Readonly<Record<string, FailureClass>> = Object.freeze({
  // intake-runner.ts ErrorCode
  TENANT_CONTEXT_MISSING: 'refused_tenant', INPUT_INVALID: 'refused_input', MASKING_NOT_DECLARED: 'refused_input',
  CONTRACT_UNSUPPORTED: 'refused_input', CONTRACT_INVALID: 'contract_failure',
  // model-gateway.ts ModelFailureCode
  MODEL_NOT_PERMITTED: 'refused_permission', MODEL_ERROR: 'dependency_failure', MODEL_TIMEOUT: 'dependency_failure',
  MODEL_OUTPUT_TOO_LARGE: 'contract_failure', MODEL_OUTPUT_INVALID: 'contract_failure', MODEL_OUTPUT_UNGROUNDED: 'contract_failure',
  // tenant-boundary.ts BoundaryErrorCode
  PERMISSION_DENIED: 'refused_permission', TENANT_MISMATCH: 'refused_tenant', CONFIG_NOT_ALLOWED_IN_INPUT: 'refused_input',
  CONFIG_MISSING: 'refused_tenant',
  // execution-context.ts ContextErrorCode
  UNAUTHENTICATED: 'refused_authentication', TENANT_NOT_SELECTED: 'refused_tenant', GRANTS_INVALID: 'internal_error',
  CONTEXT_INVALID: 'internal_error', CONTEXT_NOT_TRUSTED: 'safety_violation', NARROW_ONLY: 'safety_violation',
  ENVELOPE_INVALID: 'contract_failure', WRONG_RECIPIENT: 'refused_permission',
  // intake-entry.ts EntryErrorCode
  SYNTHETIC_ONLY: 'refused_input', ENTRY_ERROR: 'internal_error',
  // live-run.ts LiveRunErrorCode
  FIXTURE_NOT_REVIEWED: 'refused_input', DEV_SETUP_FAILED: 'internal_error',
  // processing-entry.ts ProcessingErrorCode and StepFailureCode
  HANDOFF_NOT_TRUSTED: 'safety_violation', PROCESSING_NOT_PERMITTED: 'refused_permission', PROCESSING_ERROR: 'internal_error',
  CANDIDATE_NOT_TRUSTED: 'safety_violation', CANDIDATE_INVALID: 'contract_failure', QC_NOT_PERMITTED: 'refused_permission', QC_ERROR: 'internal_error',
  REPORT_NOT_PERMITTED: 'refused_permission', BATCH_INVALID: 'refused_input', REPORT_ERROR: 'internal_error', LEDGER_UNAVAILABLE: 'dependency_failure', TRIPLE_INVALID: 'refused_input',
  VERDICT_NOT_TRUSTED: 'safety_violation', VERDICT_INVALID: 'contract_failure',
  STAGE_TIMEOUT: 'dependency_failure', PIPELINE_ERROR: 'internal_error', CONTEXT_MISMATCH: 'safety_violation',
  APPROVAL_NOT_PERMITTED: 'refused_permission', APPROVER_NOT_HUMAN: 'refused_permission', SELF_APPROVAL: 'safety_violation', PROPOSAL_INVALID: 'contract_failure',
  DECISION_INVALID: 'contract_failure', PROPOSAL_EXPIRED: 'refused_input', ACTION_MISMATCH: 'safety_violation', APPROVAL_DECLINED: 'refused_permission',
  APPROVAL_NOT_TRUSTED: 'safety_violation', APPROVAL_ERROR: 'internal_error',
  APPROVER_UNAUTHENTICATED: 'refused_authentication', APPROVER_SESSION_EXPIRED: 'refused_authentication', APPROVER_NOT_MEMBER: 'refused_tenant',
  APPROVER_GRANTS_INVALID: 'internal_error', APPROVER_CONTEXT_INVALID: 'internal_error',
  STORE_NOT_PERMITTED: 'refused_permission', STORE_NOT_FOUND: 'refused_input', STORE_INVALID: 'refused_input', STORE_ERROR: 'internal_error',
  PROPOSAL_CONFLICT: 'safety_violation', ACTIVE_PROPOSAL_EXISTS: 'refused_input', EFFECT_ALREADY_DONE: 'refused_input', DECISION_CONFLICT: 'refused_input',
  NOT_APPROVED: 'refused_permission', CLAIM_CONFLICT: 'refused_input', STALE_CLAIM: 'refused_input', IN_DOUBT: 'dependency_failure', RETRY_LIMIT: 'dependency_failure',
  COMPLETION_NOT_RECORDED: 'dependency_failure', TOOL_NOT_PERFORMED: 'dependency_failure', TOOL_FAILED: 'dependency_failure', TOOL_TIMEOUT: 'dependency_failure', TOOL_OUTPUT_INVALID: 'contract_failure',
});
/** Used when a code is not in the table. The unknown value itself is never copied into an event. */
export const UNCLASSIFIED = 'UNCLASSIFIED';

/** The class of a known code, or `internal_error` for anything else (it is never dropped silently). */
export function classify(code: unknown): FailureClass {
  return typeof code === 'string' && Object.hasOwn(ERROR_CLASS, code) ? ERROR_CLASS[code] : 'internal_error';
}

// ---------------------------------------------------------------- event shape
export const TENANT_EVENTS = ['run.finished', 'run.refused', 'handoff.accepted', 'handoff.refused', 'safety.violation'] as const;
export const PLATFORM_EVENTS = ['platform.check_failed'] as const;
export type TenantEventName = (typeof TENANT_EVENTS)[number];
export type PlatformEventName = (typeof PLATFORM_EVENTS)[number];
/** Events that must carry an error code (a missing one is reported as UNCLASSIFIED). */
const NEEDS_CODE: readonly string[] = ['run.refused', 'handoff.refused', 'safety.violation', 'platform.check_failed'];

const ITEM_ID = /^wi-[0-9a-f]{12}$/;
const OUTCOMES = ['handed-off', 'needs-human'] as const;
const SKILLS = ['classify-request', 'extract-fields', 'validate-completeness', 'create-work-item'] as const;
const SOURCES = ['model', 'deterministic', 'deterministic-fallback'] as const;
const COUNT_KEYS = ['attempts', 'model_calls', 'model_failures', 'missing_fields', 'reasons'] as const;
const MAX_STEPS = 8;
const MAX_DURATION_MS = 3_600_000;
const MAX_COUNT = 100_000;

export interface Step { skill: (typeof SKILLS)[number]; source: (typeof SOURCES)[number]; attempts?: number; failure?: string }
/** What a caller may ask to emit. Anything outside these fields is ignored. */
export interface EventInput {
  event: string;
  item_id?: unknown;
  outcome?: unknown;
  error_code?: unknown;
  reasons?: unknown;
  steps?: unknown;
  duration_ms?: unknown;
  counts?: unknown;
}
export interface ObsEvent {
  readonly schema: 1;
  readonly event: TenantEventName | PlatformEventName;
  readonly timestamp: string;
  readonly level: Level;
  readonly scope: 'tenant' | 'platform';
  readonly delivery: 'best_effort' | 'mandatory';
  readonly workspace_id?: string;
  readonly correlation_id?: string;
  readonly agent?: AgentName;
  readonly actor_kind?: ActorKind;
  readonly item_id?: string;
  readonly outcome?: (typeof OUTCOMES)[number];
  readonly error_code?: string;
  readonly failure_class?: FailureClass;
  readonly retryable?: boolean;
  readonly alert?: boolean;
  readonly reasons?: readonly string[];
  readonly steps?: readonly Step[];
  readonly duration_ms?: number;
  readonly counts?: Readonly<Record<string, number>>;
}

export interface Sink { write(event: Readonly<ObsEvent>): unknown }
export interface EmitterStats { emitted: number; rejected: number; sink_failures: number; mandatory_written: number; mandatory_failed: number }
export interface Emitter {
  /** Best-effort. Returns true if the event was handed to the sink; never throws; never waits. */
  emit(input: unknown): boolean;
  /** Audit path. Resolves true only if the separate audit sink accepted the event; false otherwise (including no audit sink). */
  emitMandatory(input: unknown): Promise<boolean>;
  stats(): Readonly<EmitterStats>;
}
export interface EmitterConfig {
  /** UTC timestamp source (`YYYY-MM-DDTHH:MM:SSZ`). */
  now: () => string;
  /** The separate audit sink. If absent, emitMandatory() always returns false. */
  auditSink?: Sink;
}
export type EmitterResult = { ok: true; emitter: Emitter } | { ok: false; error: { code: 'CONTEXT_NOT_TRUSTED'; message: string } };

function isInt(v: unknown, max: number): v is number { return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max; }
function oneOf<T extends string>(list: readonly T[], v: unknown): v is T { return typeof v === 'string' && (list as readonly string[]).includes(v); }
function freezeDeep<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const child of Object.values(v as Record<string, unknown>)) freezeDeep(child);
  }
  return v;
}

/** Copies only allowed values out of the caller's input (each property is read once). Returns null if the event name is not allowed. */
function sanitize(input: unknown, allowed: readonly string[]): { name: string; body: Record<string, unknown> } | null {
  if (!isRecord(input)) return null;
  const snap: Record<string, unknown> = { ...input };
  const name = snap.event;
  if (!oneOf(allowed, name)) return null;
  const body: Record<string, unknown> = {};

  if (typeof snap.item_id === 'string' && ITEM_ID.test(snap.item_id)) body.item_id = snap.item_id;
  if (oneOf(OUTCOMES, snap.outcome)) body.outcome = snap.outcome;
  if (isInt(snap.duration_ms, MAX_DURATION_MS)) body.duration_ms = snap.duration_ms;

  // The error code is copied only if it is a known code; anything else becomes UNCLASSIFIED (the value is never echoed).
  const rawCode = snap.error_code;
  if (typeof rawCode === 'string' || NEEDS_CODE.includes(name)) {
    body.error_code = typeof rawCode === 'string' && Object.hasOwn(ERROR_CLASS, rawCode) ? rawCode : UNCLASSIFIED;
  }

  if (Array.isArray(snap.reasons)) {
    const reasons: string[] = [];
    for (const r of [...snap.reasons] as unknown[]) if (oneOf(REASON_CODES, r) && !reasons.includes(r) && reasons.length < REASON_CODES.length) reasons.push(r);
    if (reasons.length) body.reasons = reasons;
  }

  if (Array.isArray(snap.steps)) {
    const steps: Step[] = [];
    for (const s of [...snap.steps] as unknown[]) {
      if (steps.length >= MAX_STEPS || !isRecord(s)) continue;
      const rec: Record<string, unknown> = { ...s };
      if (!oneOf(SKILLS, rec.skill) || !oneOf(SOURCES, rec.source)) continue;
      const step: Step = { skill: rec.skill, source: rec.source };
      if (isInt(rec.attempts, 10)) step.attempts = rec.attempts;
      if (typeof rec.failure === 'string' && Object.hasOwn(ERROR_CLASS, rec.failure)) step.failure = rec.failure;
      steps.push(step);
    }
    if (steps.length) body.steps = steps;
  }

  if (isRecord(snap.counts)) {
    const src: Record<string, unknown> = { ...snap.counts };
    const counts: Record<string, number> = {};
    for (const k of COUNT_KEYS) if (Object.hasOwn(src, k) && isInt(src[k], MAX_COUNT)) counts[k] = src[k] as number;
    if (Object.keys(counts).length) body.counts = counts;
  }
  return { name, body };
}

function validSink(s: unknown): s is Sink { return isRecord(s) && typeof (s as { write?: unknown }).write === 'function'; }

function build(
  clock: () => string, scope: 'tenant' | 'platform', delivery: 'best_effort' | 'mandatory',
  stamp: Record<string, unknown>, clean: { name: string; body: Record<string, unknown> },
): ObsEvent | null {
  let ts: unknown;
  try { ts = clock(); } catch { return null; }
  if (typeof ts !== 'string' || !TIMESTAMP.test(ts)) return null;
  const code = clean.body.error_code as string | undefined;
  const cls = code === undefined ? undefined : classify(code);
  const info = cls === undefined ? undefined : CLASS_INFO[cls];
  const event: Record<string, unknown> = {
    schema: 1, event: clean.name, timestamp: ts, level: info ? info.level : 'info', scope, delivery,
    ...stamp, ...clean.body,
    ...(cls === undefined || info === undefined ? {} : { failure_class: cls, retryable: info.retryable, alert: info.alert }),
  };
  return freezeDeep(event as unknown as ObsEvent);
}

function makeEmitter(
  scope: 'tenant' | 'platform', allowed: readonly string[], stamp: Record<string, unknown>, sink: Sink, config: EmitterConfig,
): Emitter {
  const clock = config.now;
  const audit = config.auditSink;
  const stats: EmitterStats = { emitted: 0, rejected: 0, sink_failures: 0, mandatory_written: 0, mandatory_failed: 0 };
  const fixedStamp = Object.freeze({ ...stamp });

  function emit(input: unknown): boolean {
    try {
      const clean = sanitize(input, allowed);
      const event = clean ? build(clock, scope, 'best_effort', fixedStamp, clean) : null;
      if (!event) { stats.rejected++; return false; }
      const out = sink.write(event);
      if (out !== null && typeof out === 'object' && typeof (out as { then?: unknown }).then === 'function') {
        (out as Promise<unknown>).then(undefined, () => { stats.sink_failures++; });
      }
      stats.emitted++;
      return true;
    } catch {
      stats.sink_failures++;
      return false;
    }
  }

  async function emitMandatory(input: unknown): Promise<boolean> {
    try {
      if (!audit) { stats.mandatory_failed++; return false; }
      const clean = sanitize(input, allowed);
      const event = clean ? build(clock, scope, 'mandatory', fixedStamp, clean) : null;
      if (!event) { stats.mandatory_failed++; return false; }
      await audit.write(event);
      stats.mandatory_written++;
      return true;
    } catch {
      stats.mandatory_failed++;
      return false;
    }
  }

  return Object.freeze({ emit, emitMandatory, stats: () => Object.freeze({ ...stats }) });
}

function checkSetup(sink: unknown, config: unknown): config is EmitterConfig {
  if (!validSink(sink)) throw new RangeError('sink must have a write function');
  if (!isRecord(config) || typeof config.now !== 'function') throw new RangeError('config must provide a now function');
  if (config.auditSink !== undefined && !validSink(config.auditSink)) throw new RangeError('auditSink must have a write function');
  if (config.auditSink !== undefined && config.auditSink === sink) throw new RangeError('the audit sink must be separate from the telemetry sink');
  return true;
}

/**
 * Tenant emitter. Tenant, correlation id, agent and actor kind come ONLY from the minted context; a payload cannot set or
 * override them. A context that was not minted by execution-context.ts is refused (fail closed). Bad sink or config throws a
 * RangeError at setup.
 */
export function createEmitter(ctx: unknown, sink: Sink, config: EmitterConfig): EmitterResult {
  checkSetup(sink, config);
  if (!isTrusted(ctx)) return { ok: false, error: { code: 'CONTEXT_NOT_TRUSTED', message: 'A trusted execution context is required; no emitter was created.' } };
  const c: ExecutionContext = ctx;
  const stamp = { workspace_id: c.workspace_id, correlation_id: c.correlation_id, agent: c.agent, actor_kind: c.actor.kind };
  return { ok: true, emitter: makeEmitter('tenant', TENANT_EVENTS, stamp, sink, config) };
}

/** Platform emitter for events that belong to no tenant. It carries no tenant fields and refuses tenant events. */
export function createPlatformEmitter(sink: Sink, config: EmitterConfig): Emitter {
  checkSetup(sink, config);
  return makeEmitter('platform', PLATFORM_EVENTS, {}, sink, config);
}

/**
 * Turns a runner or entry result into an event input WITHOUT reading any tenant-supplied text: no category, no field names
 * or values, no messages. An ok result becomes run.finished (item id, outcome, reason codes, trace steps, a count of missing
 * fields); a refusal becomes run.refused with its code. This also ties item_id to the context's correlation id, so a
 * needs-human item (which has no envelope) stays traceable.
 */
export function describeResult(result: unknown): EventInput {
  try {
    if (!isRecord(result)) return { event: 'run.refused', error_code: UNCLASSIFIED };
    const r: Record<string, unknown> = { ...result };
    if (r.ok === true && isRecord(r.workItem)) {
      const w: Record<string, unknown> = { ...r.workItem };
      const trace = Array.isArray(r.trace) ? ([...r.trace] as unknown[]) : [];
      return {
        event: 'run.finished',
        item_id: w.item_id,
        outcome: r.outcome,
        reasons: w.reasons,
        steps: trace.map((t) => (isRecord(t) ? { skill: t.skill, source: t.source, attempts: t.attempts, failure: t.failure } : null)),
        counts: { missing_fields: Array.isArray(w.missing_fields) ? w.missing_fields.length : undefined },
      };
    }
    if (r.ok === false && isRecord(r.error)) return { event: 'run.refused', error_code: (r.error as Record<string, unknown>).code };
  } catch { /* fall through */ }
  return { event: 'run.refused', error_code: UNCLASSIFIED };
}
