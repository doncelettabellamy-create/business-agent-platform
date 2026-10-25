// Trusted tenant and config boundary around the Intake runners (proof of concept).
//
// Today the runners read both the tenant (`workspace_id`) and the vocabulary (`skill_config`) from the message record,
// so whoever builds the record chooses both. This wrapper moves that choice to the trusted caller:
//   - the TENANT comes from a MINTED ExecutionContext (src/execution-context.ts), never from the message. A plain
//     object, a copy, a clone, parsed JSON or a context for another agent is not accepted;
//   - the PERMISSION comes from the context's scopes: running Intake needs the explicit scope `intake:run` (default deny);
//   - the CONFIG comes from a registry keyed by that tenant, never from the message;
//   - anything that disagrees or is missing is refused BEFORE any provider call (fail closed).
// The runners themselves are unchanged and still apply their own gates afterwards.
//
// This file imports no network, file, or process APIs. The registry is in memory; a real one needs a tenant-scoped
// store (FND-02). Whoever supplies the trusted sources to mintExecutionContext decides what a context means: only one
// composition root may do that (see the bypass-inventory test).

import { runIntake, runIntakeWithModel } from './intake-runner.ts';
import { can, isTrusted } from './execution-context.ts';
import type { ExecutionContext } from './execution-context.ts';
import type { IntakeInput, ModelRunOptions, RunOptions, RunResult } from './intake-runner.ts';
import { validateSkillConfig } from './classify-extract.ts';
import type { SkillConfig } from './classify-extract.ts';
import { isRecord } from './contracts.ts';

/** Same pattern as the runner's workspace id check (src/intake-runner.ts). */
const ID_LIKE = /^[A-Za-z0-9_.:-]{1,64}$/;
/** A message may never choose its own vocabulary or supply classification results. */
const FORBIDDEN_KEYS = ['skill_config', 'category_list', 'required_fields', 'candidate'] as const;

/** The permission needed to run Intake through this boundary. A placeholder name until the scope vocabulary is decided (D-08). */
export const INTAKE_RUN_SCOPE = 'intake:run';
/** Must be minted by execution-context.ts for the `intake` agent. Never derived from the message. */
export type TenantContext = ExecutionContext;
export type InboundMessage = Omit<IntakeInput, 'skill_config' | 'category_list' | 'required_fields' | 'candidate'>;
/** Read-only at runtime, not just in the type: lookups only, no set, delete or clear. */
export interface TenantRegistry {
  get(workspaceId: string): SkillConfig | undefined;
  has(workspaceId: string): boolean;
  readonly size: number;
}

export type BoundaryErrorCode = 'TENANT_CONTEXT_MISSING' | 'PERMISSION_DENIED' | 'TENANT_MISMATCH' | 'CONFIG_NOT_ALLOWED_IN_INPUT' | 'CONFIG_MISSING';
export type BoundaryResult = RunResult | { ok: false; error: { code: BoundaryErrorCode; message: string } };

function refuse(code: BoundaryErrorCode, message: string): { ok: false; error: { code: BoundaryErrorCode; message: string } } {
  return { ok: false, error: { code, message } };
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const child of Object.values(v as Record<string, unknown>)) deepFreeze(child);
  }
  return v;
}

/**
 * Validates every tenant's config once, at creation, and keeps a frozen private copy in a Map (so ids such as
 * "__proto__" or "constructor" are ordinary keys). Throws on the first bad tenant id or config; messages contain
 * counts only, never configured values.
 */
export function createTenantRegistry(configs: Record<string, SkillConfig>): TenantRegistry {
  if (!isRecord(configs)) throw new RangeError('configs must be an object keyed by tenant id');
  const members = new Map<string, SkillConfig>();
  for (const [id, config] of Object.entries(configs)) {
    if (!ID_LIKE.test(id)) throw new RangeError('tenant id must be an id-like string');
    // Clone FIRST (each getter or property is read once), then validate and keep only the clone, so what was
    // checked is exactly what is stored. A config that cannot be cloned fails with fixed text, never its values.
    let copy: SkillConfig;
    try { copy = structuredClone(config); } catch { throw new RangeError('skill_config for a tenant cannot be copied'); }
    const problems = validateSkillConfig(copy);
    if (problems.length) throw new RangeError(`skill_config for a tenant is invalid (${problems.length} problem${problems.length === 1 ? '' : 's'})`);
    members.set(id, deepFreeze(copy));
  }
  // The Map stays private to these closures; the returned object is frozen and has no way to add, replace or remove.
  return Object.freeze({
    get: (id: string) => members.get(id),
    has: (id: string) => members.has(id),
    get size() { return members.size; },
  });
}

/** All boundary rules, in order. Returns the runner input (message plus the tenant's own config) or a refusal. */
function admit(ctx: unknown, message: unknown, registry: TenantRegistry):
  { ok: true; tenant: string; input: IntakeInput } | ReturnType<typeof refuse> | Extract<RunResult, { ok: false }> {
  // 1. A minted context for the Intake agent, holding the explicit scope. A minted context is frozen and its tenant was
  //    checked when it was minted, so reading the tenant once here is enough.
  if (!isTrusted(ctx) || ctx.agent !== 'intake') {
    return refuse('TENANT_CONTEXT_MISSING', 'No valid trusted tenant context was provided; nothing was processed.');
  }
  if (!can(ctx, INTAKE_RUN_SCOPE)) {
    return refuse('PERMISSION_DENIED', 'The caller is not permitted to run Intake; nothing was processed.');
  }
  const tenant = ctx.workspace_id;
  // 2. Snapshot the message once (each own property is read once). Every check below, and the run itself, use this
  //    snapshot, so a getter or proxy cannot show one tenant to the check and another to the runner.
  if (!isRecord(message)) return { ok: false, error: { code: 'INPUT_INVALID', message: 'The message must be an object.' } };
  const snapshot: Record<string, unknown> = { ...message };
  // The message must belong to exactly that tenant (strict equality, own property, no normalization).
  if (!Object.hasOwn(snapshot, 'workspace_id') || snapshot.workspace_id !== tenant) {
    return refuse('TENANT_MISMATCH', 'The message does not belong to the trusted tenant; nothing was processed.');
  }
  // 3. The sender never supplies the vocabulary or the classification result.
  for (const key of FORBIDDEN_KEYS) {
    if (Object.hasOwn(snapshot, key)) return refuse('CONFIG_NOT_ALLOWED_IN_INPUT', 'The message may not carry configuration or classification values.');
  }
  // 4. The tenant's own registered config; no default and no fallback to another tenant.
  const config = registry.get(tenant);
  if (!config) return refuse('CONFIG_MISSING', 'No configuration is registered for this tenant; nothing was processed.');
  return { ok: true, tenant, input: { ...snapshot, workspace_id: tenant, skill_config: config } as unknown as IntakeInput };
}

/** Defense in depth: nothing the runner returns may name a different tenant. `tenant` is the id captured by admit(). */
export function owned(tenant: string, result: RunResult): BoundaryResult {
  if (!result.ok) return result;
  const handoffWorkspace = result.handoff ? result.handoff.workspace_id : tenant;
  if (result.workItem.workspace_id !== tenant || handoffWorkspace !== tenant) {
    return { ok: false, error: { code: 'CONTRACT_INVALID', message: 'The result does not belong to the trusted tenant; refused.' } };
  }
  return result;
}

/** Deterministic runner behind the boundary. */
export function runIntakeForTenant(ctx: TenantContext, message: unknown, registry: TenantRegistry, options: RunOptions = {}): BoundaryResult {
  const admitted = admit(ctx, message, registry);
  if (!admitted.ok) return admitted;
  return owned(admitted.tenant, runIntake(admitted.input, options));
}

/** Model-ready runner behind the boundary. A refusal happens before the provider is ever called. */
export async function runIntakeWithModelForTenant(ctx: TenantContext, message: unknown, registry: TenantRegistry, options: ModelRunOptions): Promise<BoundaryResult> {
  const admitted = admit(ctx, message, registry);
  if (!admitted.ok) return admitted;
  return owned(admitted.tenant, await runIntakeWithModel(admitted.input, options));
}
