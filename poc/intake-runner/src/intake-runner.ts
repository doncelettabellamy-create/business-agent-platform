// Intake runner (proof of concept).
//
// ONE pipeline, two ways to obtain the category and field values:
//   runIntake(input, options)               synchronous and fully deterministic. Values come from a supplied
//                                           "candidate" or from the local classify-extract skill ("skill_config").
//   runIntakeWithModel(input, options)      asynchronous. The classify-request and extract-fields skills ask a
//                                           ModelProvider (today only a local mock) through the model gateway.
//                                           If ANY model answer fails, the item ALWAYS goes to a person (reason
//                                           model_failed, status needs-human, no handoff envelope). The deterministic
//                                           skill still fills in values, but only as suggestions for the reviewer.
// Both then share the same steps: tenant gate, structure check, masking declaration, contract support,
// work_item.v1 build and validation, and the Processing handoff envelope for ready items only.
//
// Not included, by design: any real provider, API key, network call, personal-data detector, database, queue,
// audit chain, vault, approvals, or outbound action. Imports: node:crypto and local files only.
//
// Register mapping (docs/MASTER_BUILD_REGISTER.md): FND-26 (contract skeleton), FND-17 (model gateway shape only),
// INT-12 (work_item.v1 and the Intake skills), PRC-06 (handoff envelope only). All remain Founder-PENDING.

import { createHash } from 'node:crypto';
import {
  WORK_ITEM_CONTRACT, TIMESTAMP, checkKeys, isNonEmptyString, isRecord, isUnitNumber, validateEnvelope, validateWorkItem,
} from './contracts.ts';
import type { FieldEntry, HandoffEnvelopeV1, PiiSummaryEntry, ReasonCode, WorkItemV1 } from './contracts.ts';
import { classifyAndExtract, validateSkillConfig } from './classify-extract.ts';
import type { SkillConfig } from './classify-extract.ts';
import {
  PROMPT_VERSION, buildClassifyRequest, buildExtractRequest, callModel, normalizeCallOptions, parseClassifyOutput, parseExtractOutput,
} from './model-gateway.ts';
import type { ModelCallOptions, ModelFailureCode, ModelProvider } from './model-gateway.ts';
import { INTAKE_SKILLS } from './skills.ts';

export const RUNNER_VERSION = 'intake-runner-poc@0.2.0';
const MAX_MASKED_TEXT = 20000;
const ID_LIKE = /^[A-Za-z0-9_.:-]{1,64}$/;

interface CandidateField { name: string; value: string | null; confidence: number | null }
interface Candidate { category: string | null; fields: CandidateField[] }

export interface IntakeInput {
  workspace_id: string;
  correlation_id: string;
  event_id: string;
  received_at: string;
  channel_ref: string;
  requested_contract?: string;
  masking: { applied: boolean; source: string };
  masked_text: string;
  pii_summary?: PiiSummaryEntry[];
  /** Candidate mode: all three of these are required, and skill_config must be absent. */
  category_list?: string[];
  required_fields?: string[];
  candidate?: Candidate;
  /** Skill mode (deterministic) and model mode: replaces category_list, required_fields, and candidate. */
  skill_config?: SkillConfig;
}

export interface RunOptions {
  /** Minimum overall confidence. Threshold is a founder decision (D-04); there is NO default. If omitted, the check is off.
   *  The local deterministic skill does not score confidence, so with it every item is flagged when this is set. */
  minConfidence?: number;
}

export interface ModelRunOptions extends RunOptions, ModelCallOptions {
  provider: ModelProvider;
  /**
   * @deprecated Ignored. Kept only so existing callers still compile. Every model failure now requires human review
   * (reason model_failed, status needs-human, no handoff envelope) whatever this value is. Deterministic values are
   * attached for the reviewer's assistance only and can never make a failed model run "ready".
   */
  fallback?: 'needs-human' | 'deterministic';
}

export type ErrorCode =
  | 'TENANT_CONTEXT_MISSING'
  | 'INPUT_INVALID'
  | 'MASKING_NOT_DECLARED'
  | 'CONTRACT_UNSUPPORTED'
  | 'CONTRACT_INVALID';

/** Per-skill record of where the values came from. Codes and counts only; never provider text. */
export interface SkillTrace {
  skill: string;
  source: 'model' | 'deterministic' | 'deterministic-fallback';
  provider_id?: string;
  attempts?: number;
  failure?: ModelFailureCode;
}

export type RunResult =
  | { ok: true; outcome: 'handed-off' | 'needs-human'; workItem: WorkItemV1; handoff: HandoffEnvelopeV1 | null; trace?: SkillTrace[] }
  | { ok: false; error: { code: ErrorCode; message: string; paths?: string[] } };

interface Resolved {
  categoryList: string[];
  requiredFields: string[];
  candidate: Candidate;
  categoryAmbiguous: boolean;
  fieldAmbiguous: boolean;
  /** Extra confidence values (for example the model's category confidence) that count toward the overall minimum. */
  extraConfidences: number[];
  /** Skill mode only: per-category extra required field names (a Map, so a category named "constructor" cannot hit a prototype key). */
  categoryRequires?: Map<string, string[]>;
  /** Skill mode only: every field named by any category's `requires`. Applied to a category that the local classifier did not confirm. */
  unionRequires?: string[];
  /** Skill mode only: true when the final category is the one the local keyword match found. */
  categoryVerified?: boolean;
}
interface Meta {
  modelLabel: string;
  promptLabel: string;
  extraReasons: ReasonCode[];
  trace?: SkillTrace[];
}

function fail(code: ErrorCode, message: string, paths?: string[]): RunResult {
  return paths && paths.length ? { ok: false, error: { code, message, paths } } : { ok: false, error: { code, message } };
}

function validateCandidateMode(x: Record<string, unknown>, path: string, errors: string[]): void {
  if (!Array.isArray(x.category_list) || x.category_list.length === 0) errors.push(`${path}.category_list: expected non-empty array`);
  else x.category_list.forEach((c: unknown, i: number) => {
    if (!isNonEmptyString(c)) errors.push(`${path}.category_list[${i}]: expected non-empty string`);
    else if (c === 'unknown') errors.push(`${path}.category_list[${i}]: "unknown" is reserved`);
  });

  if (!Array.isArray(x.required_fields)) errors.push(`${path}.required_fields: expected array`);
  else {
    const seen: string[] = [];
    x.required_fields.forEach((r: unknown, i: number) => {
      if (!isNonEmptyString(r)) errors.push(`${path}.required_fields[${i}]: expected non-empty string`);
      else if (seen.includes(r)) errors.push(`${path}.required_fields[${i}]: duplicate`);
      else seen.push(r);
    });
  }

  if (!isRecord(x.candidate)) { errors.push(`${path}.candidate: expected object`); return; }
  checkKeys(x.candidate, ['category', 'fields'], `${path}.candidate`, errors);
  if (x.candidate.category !== null && !isNonEmptyString(x.candidate.category)) errors.push(`${path}.candidate.category: expected null or non-empty string`);
  if (!Array.isArray(x.candidate.fields)) { errors.push(`${path}.candidate.fields: expected array`); return; }
  const names: string[] = [];
  x.candidate.fields.forEach((f: unknown, i: number) => {
    const fp = `${path}.candidate.fields[${i}]`;
    if (!isRecord(f)) { errors.push(`${fp}: expected object`); return; }
    checkKeys(f, ['name', 'value', 'confidence'], fp, errors);
    if (!isNonEmptyString(f.name)) errors.push(`${fp}.name: expected non-empty string`);
    else if (names.includes(f.name)) errors.push(`${fp}.name: duplicate`);
    else names.push(f.name);
    if (f.value !== null && !isNonEmptyString(f.value)) errors.push(`${fp}.value: expected null or non-empty string`);
    if (f.confidence !== null && !isUnitNumber(f.confidence)) errors.push(`${fp}.confidence: expected null or number from 0 to 1`);
  });
}

/** Structural validation of the synthetic input record. Messages never echo input values. */
export function validateInput(x: unknown): string[] {
  const errors: string[] = [];
  const path = 'input';
  if (!isRecord(x)) return [`${path}: expected object`];
  checkKeys(x, ['workspace_id', 'correlation_id', 'event_id', 'received_at', 'channel_ref', 'masking', 'masked_text'],
    path, errors, ['requested_contract', 'pii_summary', 'category_list', 'required_fields', 'candidate', 'skill_config']);

  for (const k of ['workspace_id', 'correlation_id', 'event_id', 'channel_ref']) {
    if (typeof x[k] !== 'string' || !ID_LIKE.test(x[k] as string)) errors.push(`${path}.${k}: expected id-like string (letters, digits, _ . : -)`);
  }
  if (typeof x.received_at !== 'string' || !TIMESTAMP.test(x.received_at)) errors.push(`${path}.received_at: expected UTC timestamp`);
  if (x.requested_contract !== undefined && !isNonEmptyString(x.requested_contract)) errors.push(`${path}.requested_contract: expected non-empty string`);

  if (!isRecord(x.masking)) errors.push(`${path}.masking: expected object`);
  else {
    checkKeys(x.masking, ['applied', 'source'], `${path}.masking`, errors);
    if (typeof x.masking.applied !== 'boolean') errors.push(`${path}.masking.applied: expected boolean`);
    if (!isNonEmptyString(x.masking.source)) errors.push(`${path}.masking.source: expected non-empty string`);
  }

  if (typeof x.masked_text !== 'string' || x.masked_text.length === 0) errors.push(`${path}.masked_text: expected non-empty string`);
  else if (x.masked_text.length > MAX_MASKED_TEXT) errors.push(`${path}.masked_text: too long`);

  if (x.pii_summary !== undefined) {
    if (!Array.isArray(x.pii_summary)) errors.push(`${path}.pii_summary: expected array`);
    else x.pii_summary.forEach((p: unknown, i: number) => {
      const pp = `${path}.pii_summary[${i}]`;
      if (!isRecord(p)) { errors.push(`${pp}: expected object`); return; }
      checkKeys(p, ['type', 'count'], pp, errors);
      if (!isNonEmptyString(p.type)) errors.push(`${pp}.type: expected non-empty string`);
      if (typeof p.count !== 'number' || !Number.isInteger(p.count) || p.count < 0) errors.push(`${pp}.count: expected integer 0 or more`);
    });
  }

  // Exactly one source of categories and fields.
  const hasSkill = Object.hasOwn(x, 'skill_config');
  const hasCandidateKeys = ['category_list', 'required_fields', 'candidate'].some((k) => Object.hasOwn(x, k));
  if (hasSkill && hasCandidateKeys) {
    errors.push(`${path}: skill_config cannot be combined with category_list, required_fields, or candidate`);
  } else if (hasSkill) {
    errors.push(...validateSkillConfig(x.skill_config, `${path}.skill_config`));
  } else {
    validateCandidateMode(x, path, errors);
  }
  return errors;
}

function itemIdFor(workspaceId: string, eventId: string): string {
  return 'wi-' + createHash('sha256').update(`${workspaceId}\n${eventId}`).digest('hex').slice(0, 12);
}

/** Shared gates: tenant, structure, masking declaration, contract support. */
function prepare(input: unknown): { ok: true; typed: IntakeInput } | { ok: false; result: RunResult } {
  // 1. Tenant first: without a tenant nothing else is examined (fail closed).
  if (!isRecord(input) || !isNonEmptyString(input.workspace_id)) {
    return { ok: false, result: fail('TENANT_CONTEXT_MISSING', 'No tenant (workspace) was provided; nothing was processed.') };
  }
  // 2. Structure.
  const problems = validateInput(input);
  if (problems.length) return { ok: false, result: fail('INPUT_INVALID', 'The input record does not match the expected structure.', problems) };
  const typed = input as unknown as IntakeInput;
  // 3. The runner trusts a masking declaration; it cannot detect personal data (see README limitations).
  if (typed.masking.applied !== true) return { ok: false, result: fail('MASKING_NOT_DECLARED', 'The input is not declared as masked; it was refused.') };
  // 4. Only work_item.v1 is supported.
  if ((typed.requested_contract ?? WORK_ITEM_CONTRACT) !== WORK_ITEM_CONTRACT) {
    return { ok: false, result: fail('CONTRACT_UNSUPPORTED', 'The requested contract or version is not supported.') };
  }
  return { ok: true, typed };
}

function resolveDeterministic(input: IntakeInput): Resolved {
  if (input.skill_config) {
    const sr = classifyAndExtract(input.masked_text, input.skill_config);
    return {
      categoryList: input.skill_config.categories.map((c) => c.name),
      requiredFields: input.skill_config.fields.filter((f) => f.required).map((f) => f.name),
      candidate: { category: sr.category, fields: sr.fields },
      categoryAmbiguous: sr.categoryOutcome === 'ambiguous',
      fieldAmbiguous: sr.ambiguousFields.length > 0,
      extraConfidences: [],
      categoryRequires: new Map(input.skill_config.categories.map((c) => [c.name, c.requires ?? []])),
      unionRequires: [...new Set(input.skill_config.categories.flatMap((c) => c.requires ?? []))],
      categoryVerified: true,   // the local result is its own confirmation; the model path recomputes this
    };
  }
  return {
    categoryList: input.category_list as string[],
    requiredFields: input.required_fields as string[],
    candidate: input.candidate as Candidate,
    categoryAmbiguous: false,
    fieldAmbiguous: false,
    extraConfidences: [],
  };
}

/**
 * Required field names for the final category. The global `required: true` fields always apply. A category's `requires`
 * adds fields only when the local classifier confirmed that category; a category that came from the model alone (local
 * match absent or tied) must satisfy every category's `requires`, so a model-only pick cannot lower the bar. A category
 * the local keyword match confirmed can still be wrong (for example through planted keywords); see the README limitations.
 */
function requiredFor(input: IntakeInput, src: Resolved, category: string): string[] {
  if (!input.skill_config || !src.categoryRequires || category === 'unknown') return src.requiredFields;
  const extra = new Set(src.categoryVerified === false ? src.unionRequires ?? [] : src.categoryRequires.get(category) ?? []);
  const base = new Set(src.requiredFields);
  return input.skill_config.fields.map((f) => f.name).filter((n) => base.has(n) || extra.has(n));
}

function buildWorkItem(input: IntakeInput, src: Resolved, options: RunOptions, meta: Meta): { item: WorkItemV1; overallConfidence: number | null } {
  const cand = src.candidate.category;
  const category = cand !== null && src.categoryList.includes(cand) ? cand : 'unknown';
  const requiredFields = requiredFor(input, src, category);

  // Fields: the candidate or skill values as they are, plus any required field that was not mentioned at all.
  const fields: FieldEntry[] = src.candidate.fields.map((f) => ({
    name: f.name,
    value: f.value,
    confidence: f.value === null ? null : f.confidence,
    found: f.value !== null,
  }));
  for (const name of requiredFields) {
    if (!fields.some((f) => f.name === name)) fields.push({ name, value: null, confidence: null, found: false });
  }

  const missing = requiredFields.filter((n) => !fields.some((f) => f.name === n && f.found));

  const confidences = fields.filter((f) => f.found && f.confidence !== null).map((f) => f.confidence as number).concat(src.extraConfidences);
  const overall = confidences.length ? Math.min(...confidences) : null;

  const reasons: ReasonCode[] = [];
  if (missing.length) reasons.push('missing_fields');
  if (category === 'unknown') reasons.push(src.categoryAmbiguous ? 'ambiguous_category' : 'unknown_category');
  if (src.fieldAmbiguous) reasons.push('ambiguous_field');
  if (options.minConfidence !== undefined && (overall === null || overall < options.minConfidence)) reasons.push('low_confidence');
  for (const r of meta.extraReasons) if (!reasons.includes(r)) reasons.push(r);

  const item: WorkItemV1 = {
    item_id: itemIdFor(input.workspace_id, input.event_id),
    workspace_id: input.workspace_id,
    source: { channel_ref: input.channel_ref, event_id: input.event_id },
    category,
    fields,
    missing_fields: missing,
    message_ref: `msg:${input.event_id}`,   // reference only; the masked text itself is never copied into the output
    pii_summary: (input.pii_summary ?? []).map((p) => ({ type: p.type, count: p.count })),
    status: reasons.length ? 'needs-human' : 'ready',
    reasons,
    versions: { skill: RUNNER_VERSION, model: meta.modelLabel, prompt: meta.promptLabel },
  };
  return { item, overallConfidence: overall };
}

/** Shared tail: build, validate, and (for ready items only) wrap in the handoff envelope. */
function finish(typed: IntakeInput, src: Resolved, options: RunOptions, meta: Meta): RunResult {
  const { item, overallConfidence } = buildWorkItem(typed, src, options, meta);
  const itemProblems = validateWorkItem(item);
  if (itemProblems.length) return fail('CONTRACT_INVALID', 'The work item did not satisfy work_item.v1.', itemProblems);

  const withTrace = meta.trace ? { trace: meta.trace } : {};
  // Needs-human items are NOT handed off (they wait for review; review is out of scope for this PoC).
  if (item.status === 'needs-human') return { ok: true, outcome: 'needs-human', workItem: item, handoff: null, ...withTrace };

  const envelope: HandoffEnvelopeV1 = {
    contract: WORK_ITEM_CONTRACT,
    workspace_id: item.workspace_id,
    correlation_id: typed.correlation_id,
    item_id: item.item_id,
    payload: item,
    evidence_refs: [item.message_ref],
    confidence: overallConfidence,
    produced_by: RUNNER_VERSION,
    created_at: typed.received_at,
  };
  const envelopeProblems = validateEnvelope(envelope);
  if (envelopeProblems.length) return fail('CONTRACT_INVALID', 'The handoff envelope did not satisfy its contract.', envelopeProblems);
  return { ok: true, outcome: 'handed-off', workItem: item, handoff: envelope, ...withTrace };
}

function checkMinConfidence(options: RunOptions): void {
  if (options.minConfidence !== undefined && !isUnitNumber(options.minConfidence)) {
    throw new RangeError('minConfidence must be a number from 0 to 1');
  }
}

/** Deterministic runner (no model). This stays the default and the fallback path. */
export function runIntake(input: unknown, options: RunOptions = {}): RunResult {
  checkMinConfidence(options);
  const p = prepare(input);
  if (!p.ok) return p.result;
  return finish(p.typed, resolveDeterministic(p.typed), options, { modelLabel: 'none (deterministic)', promptLabel: 'none' , extraReasons: [] });
}

/** Model-ready runner. Same gates and the same work_item.v1 / handoff path; values come from the provider when it answers well. */
export async function runIntakeWithModel(input: unknown, options: ModelRunOptions): Promise<RunResult> {
  checkMinConfidence(options);
  const call = normalizeCallOptions(options);           // throws RangeError on bad limits before anything runs

  const p = prepare(input);                             // tenant, structure, masking, and contract gates run BEFORE any provider call
  if (!p.ok) return p.result;
  const typed = p.typed;
  if (!typed.skill_config) {
    return fail('INPUT_INVALID', 'Model mode needs skill_config (the configured categories and fields).', ['input.skill_config: required for model mode']);
  }
  const cfg = typed.skill_config;
  const det = resolveDeterministic(typed);              // always computed locally: the fallback values
  const categories = cfg.categories.map((c) => c.name);
  const fieldDefs = cfg.fields.map((f) => ({ name: f.name, required: f.required }));
  const provider = options.provider;
  const trace: SkillTrace[] = [];
  let failed = false;
  let modelUsed = 0;

  // classify-request
  let category = det.candidate.category;
  let categoryAmbiguous = det.categoryAmbiguous;
  const extraConfidences: number[] = [];
  const cls = await callModel(provider, INTAKE_SKILLS['classify-request'],
    buildClassifyRequest(typed.masked_text, categories, call.maxOutputTokens),
    (t) => parseClassifyOutput(t, categories), call);
  if (cls.ok) {
    modelUsed++;
    category = cls.value.category;
    categoryAmbiguous = false;
    // Veto: a model category that conflicts with a clear local keyword match is not trusted; a person decides.
    if (category !== null && det.candidate.category !== null && category !== det.candidate.category) {
      category = null;
      categoryAmbiguous = true;
    }
    if (cls.value.confidence !== null) extraConfidences.push(cls.value.confidence);
    trace.push({ skill: 'classify-request', source: 'model', provider_id: provider.id, attempts: cls.attempts });
  } else {
    failed = true;
    trace.push({ skill: 'classify-request', source: 'deterministic-fallback', provider_id: provider.id, attempts: cls.attempts, failure: cls.code });
  }

  // extract-fields
  let fields = det.candidate.fields;
  let fieldAmbiguous = det.fieldAmbiguous;
  const ext = await callModel(provider, INTAKE_SKILLS['extract-fields'],
    buildExtractRequest(typed.masked_text, fieldDefs, call.maxOutputTokens),
    (t) => parseExtractOutput(t, fieldDefs.map((f) => f.name), typed.masked_text), call);
  if (ext.ok) {
    modelUsed++;
    fields = cfg.fields.map((f) => {
      const hit = ext.value.fields.find((x) => x.name === f.name);
      return { name: f.name, value: hit ? hit.value : null, confidence: hit && hit.value !== null ? hit.confidence : null };
    });
    fieldAmbiguous = false;
    trace.push({ skill: 'extract-fields', source: 'model', provider_id: provider.id, attempts: ext.attempts });
  } else {
    failed = true;
    trace.push({ skill: 'extract-fields', source: 'deterministic-fallback', provider_id: provider.id, attempts: ext.attempts, failure: ext.code });
  }

  const modelLabel = modelUsed === 2 ? provider.id : modelUsed === 0 ? 'none (deterministic fallback)' : `${provider.id} + deterministic fallback`;
  const src: Resolved = {
    categoryList: det.categoryList,
    requiredFields: det.requiredFields,
    candidate: { category, fields },
    categoryAmbiguous,
    fieldAmbiguous,
    extraConfidences,
    categoryRequires: det.categoryRequires,
    unionRequires: det.unionRequires,
    categoryVerified: category !== null && det.candidate.category === category,
  };
  // Any model failure ALWAYS requires human review. There is no configuration that turns this off.
  const result = finish(typed, src, options, {
    modelLabel,
    promptLabel: modelUsed > 0 ? PROMPT_VERSION : 'none',
    extraReasons: failed ? ['model_failed'] : [],
    trace,
  });

  // Post-condition (defense in depth): a run with a failed model answer must never leave with a ready item or an envelope.
  if (failed && result.ok && (result.outcome !== 'needs-human' || result.handoff !== null || result.workItem.status !== 'needs-human')) {
    return fail('CONTRACT_INVALID', 'A failed model run must be reviewed by a person; refused.');
  }
  return result;
}
