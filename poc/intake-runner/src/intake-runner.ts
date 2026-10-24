// Deterministic Intake runner (proof of concept).
//
// Takes ONE already-masked synthetic input record and builds a work_item.v1 deterministically. The category
// and field values come from ONE of two sources (never both):
//   - "candidate": values supplied in the record (the original PoC mode), or
//   - "skill_config": explicitly configured categories and fields, applied by the local deterministic
//     classify-extract skill to the masked text.
// The work item is validated and, only for status "ready", wrapped in a handoff envelope for Processing.
//
// Not included, by design: model calls, personal-data detection, database, network, queue, audit chain,
// vault, approvals, outbound actions. Imports: node:crypto and local files only.
//
// Register mapping (docs/MASTER_BUILD_REGISTER.md): FND-26 (contract skeleton), INT-12 (work_item.v1 and
// a deterministic stand-in for the Intake skills), PRC-06 (handoff envelope only). All three rows remain
// Founder-PENDING; this PoC does not mark any of them complete.

import { createHash } from 'node:crypto';
import {
  WORK_ITEM_CONTRACT, TIMESTAMP, checkKeys, isNonEmptyString, isRecord, isUnitNumber, validateEnvelope, validateWorkItem,
} from './contracts.ts';
import type { FieldEntry, HandoffEnvelopeV1, PiiSummaryEntry, ReasonCode, WorkItemV1 } from './contracts.ts';
import { classifyAndExtract, validateSkillConfig } from './classify-extract.ts';
import type { SkillConfig } from './classify-extract.ts';

export const RUNNER_VERSION = 'intake-runner-poc@0.1.0';
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
  /** Skill mode: replaces category_list, required_fields, and candidate (all three must be absent). */
  skill_config?: SkillConfig;
}

export interface RunOptions {
  /** Minimum overall confidence. Threshold is a founder decision (D-04); there is NO default. If omitted, the check is off.
   *  The local skill does not score confidence, so with skill_config every item is flagged when this is set. */
  minConfidence?: number;
}

export type ErrorCode =
  | 'TENANT_CONTEXT_MISSING'
  | 'INPUT_INVALID'
  | 'MASKING_NOT_DECLARED'
  | 'CONTRACT_UNSUPPORTED'
  | 'CONTRACT_INVALID';

export type RunResult =
  | { ok: true; outcome: 'handed-off' | 'needs-human'; workItem: WorkItemV1; handoff: HandoffEnvelopeV1 | null }
  | { ok: false; error: { code: ErrorCode; message: string; paths?: string[] } };

interface Resolved {
  categoryList: string[];
  requiredFields: string[];
  candidate: Candidate;
  categoryAmbiguous: boolean;
  fieldAmbiguous: boolean;
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

  // Exactly one source for categories and fields.
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

function resolveSource(input: IntakeInput): Resolved {
  if (input.skill_config) {
    const sr = classifyAndExtract(input.masked_text, input.skill_config);
    return {
      categoryList: input.skill_config.categories.map((c) => c.name),
      requiredFields: input.skill_config.fields.filter((f) => f.required).map((f) => f.name),
      candidate: { category: sr.category, fields: sr.fields },
      categoryAmbiguous: sr.categoryOutcome === 'ambiguous',
      fieldAmbiguous: sr.ambiguousFields.length > 0,
    };
  }
  return {
    categoryList: input.category_list as string[],
    requiredFields: input.required_fields as string[],
    candidate: input.candidate as Candidate,
    categoryAmbiguous: false,
    fieldAmbiguous: false,
  };
}

function buildWorkItem(input: IntakeInput, src: Resolved, options: RunOptions): { item: WorkItemV1; overallConfidence: number | null } {
  // Fields: the candidate or skill values as they are, plus any required field that was not mentioned at all.
  const fields: FieldEntry[] = src.candidate.fields.map((f) => ({
    name: f.name,
    value: f.value,
    confidence: f.value === null ? null : f.confidence,
    found: f.value !== null,
  }));
  for (const name of src.requiredFields) {
    if (!fields.some((f) => f.name === name)) fields.push({ name, value: null, confidence: null, found: false });
  }

  const missing = src.requiredFields.filter((n) => !fields.some((f) => f.name === n && f.found));

  const cand = src.candidate.category;
  const category = cand !== null && src.categoryList.includes(cand) ? cand : 'unknown';

  const confidences = fields.filter((f) => f.found && f.confidence !== null).map((f) => f.confidence as number);
  const overall = confidences.length ? Math.min(...confidences) : null;

  const reasons: ReasonCode[] = [];
  if (missing.length) reasons.push('missing_fields');
  if (category === 'unknown') reasons.push(src.categoryAmbiguous ? 'ambiguous_category' : 'unknown_category');
  if (src.fieldAmbiguous) reasons.push('ambiguous_field');
  if (options.minConfidence !== undefined && (overall === null || overall < options.minConfidence)) reasons.push('low_confidence');

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
    versions: { skill: RUNNER_VERSION, model: 'none (deterministic)', prompt: 'none' },
  };
  return { item, overallConfidence: overall };
}

export function runIntake(input: unknown, options: RunOptions = {}): RunResult {
  if (options.minConfidence !== undefined && !isUnitNumber(options.minConfidence)) {
    throw new RangeError('minConfidence must be a number from 0 to 1');
  }

  // 1. Tenant first: without a tenant nothing else is examined (fail closed).
  if (!isRecord(input) || !isNonEmptyString(input.workspace_id)) {
    return fail('TENANT_CONTEXT_MISSING', 'No tenant (workspace) was provided; nothing was processed.');
  }

  // 2. Structure.
  const problems = validateInput(input);
  if (problems.length) return fail('INPUT_INVALID', 'The input record does not match the expected structure.', problems);
  const typed = input as unknown as IntakeInput;

  // 3. The runner trusts a masking declaration; it cannot detect personal data (see README limitations).
  if (typed.masking.applied !== true) {
    return fail('MASKING_NOT_DECLARED', 'The input is not declared as masked; it was refused.');
  }

  // 4. Only work_item.v1 is supported.
  const requested = typed.requested_contract ?? WORK_ITEM_CONTRACT;
  if (requested !== WORK_ITEM_CONTRACT) {
    return fail('CONTRACT_UNSUPPORTED', 'The requested contract or version is not supported.');
  }

  // 5. Classify and extract (skill mode) or take the supplied candidate; build and validate the work item.
  const { item, overallConfidence } = buildWorkItem(typed, resolveSource(typed), options);
  const itemProblems = validateWorkItem(item);
  if (itemProblems.length) return fail('CONTRACT_INVALID', 'The work item did not satisfy work_item.v1.', itemProblems);

  // 6. Needs-human items are NOT handed off (they wait for review; review is out of scope for this PoC).
  if (item.status === 'needs-human') return { ok: true, outcome: 'needs-human', workItem: item, handoff: null };

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
  return { ok: true, outcome: 'handed-off', workItem: item, handoff: envelope };
}
