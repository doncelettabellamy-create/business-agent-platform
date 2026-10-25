// The controlled Intake entry (proof of concept). One path in; everything the platform owns is fixed at setup or taken
// from the minted context, never from the caller or the sender.
//
//   fixed at setup (createIntakeEntry): provider, tenant registry, channel, clock, call limits. `run` has no options
//     parameter, so a caller cannot choose another provider, limits, channel, or time.
//   from the minted ExecutionContext: tenant (workspace_id) and correlation id. Identity, agent and the `intake:run`
//     permission are enforced by the tenant boundary (src/tenant-boundary.ts), which this entry always goes through.
//   from the sender (allowlist only): event_id, masked_text, pii_summary, masking (only to be checked), and workspace_id
//     (only to be compared with the context's tenant). Sender-supplied correlation_id, received_at, channel_ref and
//     requested_contract are DROPPED and replaced. Any other key is refused. Config keys are refused by the boundary.
//
// SYNTHETIC ONLY: no platform masking stage exists yet (INT-07 is not started), so this entry cannot vouch that text is
// masked. It accepts only explicitly synthetic records and refuses everything else. Real data cannot enter by this path.
//   ONE narrow, opt-in exception, the FOUNDER TEST TIER: when the setup config names `founderTest: { tenant }` (a tenant beginning
//   `ws-founder-`), records for exactly that tenant are also accepted if they declare masking source `founder-test-call` and an event id
//   beginning `evt-founder-`. It is off unless the composition root sets it, it names one tenant fixed at setup, and the caller cannot
//   choose either. It does not relax anything else: the tenant boundary, the permission check, the allow-list and the model gateway are
//   unchanged. The text must already have been masked by the caller's masker (src/pii-screen.ts); this entry still cannot vouch for that.
//
// Request-time failures never throw: every unexpected error becomes a typed refusal with fixed text. Bad setup throws a
// RangeError at startup (fail fast), with fixed text and no values.
// This file imports no network, file, or process APIs.

import { isRecord, TIMESTAMP } from './contracts.ts';
import { can, isTrusted } from './execution-context.ts';
import { normalizeCallOptions } from './model-gateway.ts';
import { sealHandoff } from './handoff-seal.ts';
import { createEmitter, describeResult } from './observability.ts';
import type { Sink } from './observability.ts';
import type { ModelCallOptions, ModelProvider } from './model-gateway.ts';
import { INTAKE_RUN_SCOPE, runIntakeWithModelForTenant } from './tenant-boundary.ts';
import type { BoundaryResult, TenantRegistry } from './tenant-boundary.ts';

const ID_LIKE = /^[A-Za-z0-9_.:-]{1,64}$/;
/** Keys the sender may supply. */
const SENDER_KEYS = ['event_id', 'masked_text', 'pii_summary', 'masking', 'workspace_id'] as const;
/** Platform-owned fields: if the sender supplies them they are ignored and replaced. */
const PLATFORM_OWNED = ['correlation_id', 'received_at', 'channel_ref', 'requested_contract'] as const;
/** Config and classification keys: passed on so the boundary refuses them with its own code. */
const CONFIG_KEYS = ['skill_config', 'category_list', 'required_fields', 'candidate'] as const;

export type EntryErrorCode = 'SYNTHETIC_ONLY' | 'ENTRY_ERROR';
export interface EntryRefusal { ok: false; error: { code: EntryErrorCode; message: string } }
export type EntryResult = BoundaryResult | EntryRefusal;

export interface IntakeEntryConfig {
  registry: TenantRegistry;
  provider: ModelProvider;
  /** Optional call limits, validated at setup. */
  limits?: ModelCallOptions & { minConfidence?: number };
  /** The channel this entry is bound to. Taken from here, never from the message. */
  channelRef: string;
  /** UTC timestamp source (`YYYY-MM-DDTHH:MM:SSZ`). Taken from here, never from the message. */
  now: () => string;
  /**
   * Optional telemetry sink, fixed at setup. When present, each run sends one best-effort event (run.finished or run.refused)
   * stamped from the minted context. A failing sink never changes the result. A context that is not trusted gets no event.
   */
  sink?: Sink;
  /** Opt-in founder test tier (see the header). Omit it and only synthetic records are accepted. */
  founderTest?: { tenant: string };
}
export interface IntakeEntry {
  run(ctx: unknown, message: unknown): Promise<EntryResult>;
}

const TEXT: Record<EntryErrorCode, string> = {
  SYNTHETIC_ONLY: 'Only explicitly synthetic records are accepted until a platform masking stage exists; nothing was processed.',
  ENTRY_ERROR: 'The request could not be processed; nothing was handed off.',
};
function refuse(code: EntryErrorCode): EntryRefusal { return { ok: false, error: { code, message: TEXT[code] } }; }
function inputInvalid(): BoundaryResult { return { ok: false, error: { code: 'INPUT_INVALID', message: 'The message does not match the allowed fields.' } }; }

export function createIntakeEntry(config: IntakeEntryConfig): IntakeEntry {
  if (!isRecord(config)) throw new RangeError('entry configuration must be an object');
  const { registry, provider, limits, channelRef, now, sink, founderTest } = config;

  if (!isRecord(registry) || typeof registry.get !== 'function' || typeof registry.has !== 'function' || !Object.isFrozen(registry)) {
    throw new RangeError('registry must be a frozen tenant registry');
  }
  if (!isRecord(provider) || typeof provider.id !== 'string' || provider.id.length === 0 || typeof provider.complete !== 'function') {
    throw new RangeError('provider must have an id and a complete function');
  }
  if (typeof channelRef !== 'string' || !ID_LIKE.test(channelRef)) throw new RangeError('channelRef must be an id-like string');
  if (typeof now !== 'function') throw new RangeError('now must be a function');
  if (sink !== undefined && (!isRecord(sink) || typeof sink.write !== 'function')) throw new RangeError('sink must have a write function');

  if (founderTest !== undefined && (!isRecord(founderTest) || typeof founderTest.tenant !== 'string' || !ID_LIKE.test(founderTest.tenant) || !founderTest.tenant.startsWith('ws-founder-'))) {
    throw new RangeError('founderTest.tenant must be an id-like string beginning ws-founder-');
  }
  const founderTenant: string | undefined = founderTest === undefined ? undefined : founderTest.tenant;

  let callOptions: Required<ModelCallOptions>;
  let minConfidence: number | undefined;
  if (limits !== undefined && !isRecord(limits)) throw new RangeError('limits must be an object');
  try {
    callOptions = normalizeCallOptions({ maxAttempts: limits?.maxAttempts, maxOutputTokens: limits?.maxOutputTokens, timeoutMs: limits?.timeoutMs });
  } catch { throw new RangeError('limits are outside the allowed range'); }
  if (limits?.minConfidence !== undefined) {
    if (typeof limits.minConfidence !== 'number' || !Number.isFinite(limits.minConfidence) || limits.minConfidence < 0 || limits.minConfidence > 1) {
      throw new RangeError('minConfidence must be a number from 0 to 1');
    }
    minConfidence = limits.minConfidence;
  }

  // Snapshot everything the run depends on, so later changes to the caller's objects do not reach it.
  const providerId = provider.id;
  const providerComplete = provider.complete;
  const fixedProvider: ModelProvider = Object.freeze({
    id: providerId,
    complete: (request, signal) => providerComplete.call(provider, request, signal),
  });
  const fixedOptions = Object.freeze({ ...callOptions, ...(minConfidence === undefined ? {} : { minConfidence }), provider: fixedProvider });
  const fixedChannel = channelRef;
  const clock = now;
  const fixedSink: Sink | undefined = sink === undefined ? undefined : Object.freeze({ write: (e) => sink.write(e) });

  /** Best-effort: one event per run, identity from the minted context only. Never throws, never alters the result. */
  function report(ctx: unknown, result: EntryResult): void {
    if (fixedSink === undefined) return;
    try {
      const made = createEmitter(ctx, fixedSink, { now: clock });
      if (made.ok) made.emitter.emit(describeResult(result));
    } catch { /* telemetry must not affect the run */ }
  }

  async function run(ctx: unknown, message: unknown): Promise<EntryResult> {
    const result = await runInner(ctx, message);
    report(ctx, result);
    return result;
  }

  async function runInner(ctx: unknown, message: unknown): Promise<EntryResult> {
    try {
      // 1. Minted Intake context with the explicit permission, before the message is looked at.
      if (!isTrusted(ctx) || ctx.agent !== 'intake') {
        return { ok: false, error: { code: 'TENANT_CONTEXT_MISSING', message: 'No valid trusted tenant context was provided; nothing was processed.' } };
      }
      if (!can(ctx, INTAKE_RUN_SCOPE)) {
        return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'The caller is not permitted to run Intake; nothing was processed.' } };
      }
      const tenant = ctx.workspace_id;
      const correlationId = ctx.correlation_id;

      // 2. Snapshot the message once, then allowlist.
      if (!isRecord(message)) return inputInvalid();
      const snap: Record<string, unknown> = { ...message };
      const known = new Set<string>([...SENDER_KEYS, ...PLATFORM_OWNED, ...CONFIG_KEYS]);
      if (Object.keys(snap).some((k) => !known.has(k)) || Object.hasOwn(snap, '__proto__')) return inputInvalid();

      // 3. Synthetic fixtures only.
      const masking = snap.masking;
      const synthetic = isRecord(masking) && masking.applied === true && masking.source === 'synthetic-fixture'
        && typeof snap.event_id === 'string' && snap.event_id.startsWith('evt-synthetic-') && tenant.startsWith('ws-synthetic-');
      const founder = founderTenant !== undefined && tenant === founderTenant && isRecord(masking) && masking.applied === true && masking.source === 'founder-test-call'
        && typeof snap.event_id === 'string' && snap.event_id.startsWith('evt-founder-');
      if (!synthetic && !founder) return refuse('SYNTHETIC_ONLY');

      // 4. Build the runner input: sender fields from the allowlist, platform-owned fields from setup and the context.
      const receivedAt: unknown = clock();
      if (typeof receivedAt !== 'string' || !TIMESTAMP.test(receivedAt)) return refuse('ENTRY_ERROR');
      const input: Record<string, unknown> = {
        workspace_id: Object.hasOwn(snap, 'workspace_id') ? snap.workspace_id : tenant,   // compared with the context by the boundary
        correlation_id: correlationId,
        event_id: snap.event_id,
        received_at: receivedAt,
        channel_ref: fixedChannel,
        masking: { applied: true, source: founder ? 'founder-test-call' : 'synthetic-fixture' },
        masked_text: snap.masked_text,
      };
      if (Object.hasOwn(snap, 'pii_summary')) input.pii_summary = snap.pii_summary;
      for (const k of CONFIG_KEYS) if (Object.hasOwn(snap, k)) input[k] = snap[k];

      const res = await runIntakeWithModelForTenant(ctx, input, registry, fixedOptions);
      // The handoff leaves this entry sealed, so Processing can tell it from a hand-built one.
      if (res.ok && res.handoff !== null && typeof res.handoff === 'object') sealHandoff(res.handoff);
      return res;
    } catch {
      return refuse('ENTRY_ERROR');
    }
  }

  return Object.freeze({ run });
}
