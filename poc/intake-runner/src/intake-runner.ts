// Deterministic Intake runner (proof of concept).
//
// Takes ONE already-masked synthetic input record, builds a work_item.v1 deterministically from the
// candidate values supplied in that record, validates it, and (only for status "ready") wraps it in a
// handoff envelope for Processing.
//
// Not included, by design: model calls, personal-data detection, database, network, queue, audit chain,
// vault, approvals, outbound actions. The only imports are node:crypto (hashing) and the local contracts file.
//
// Register mapping (docs/MASTER_BUILD_REGISTER.md): FND-26 (contract skeleton), INT-12 (work_item.v1 and
// a deterministic stand-in for the four Intake skills), PRC-06 (handoff envelope only). All three rows remain
// Founder-PENDING; this PoC does not mark any of them complete.

import { createHash } from 'node:crypto';
import {
  WORK_ITEM_CONTRACT, TIMESTAMP, checkKeys, isNonEmptyString, isRecord, isUnitNumber, validateEnvelope, validateWorkItem,
} from './contracts.ts';
import type { FieldEntry, HandoffEnvelopeV1, PiiSummaryEntry, ReasonCode, WorkItemV1 } from './contracts.ts';

export const RUNNER_VERSION = 'intake-runner-poc@0.0.0';
const MAX_MASKED_TEXT = 20000;
const ID_LIKE = /^[A-Za-z0-9_.:-]{1,64}$/;

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
  category_list: string[];
  required_fields: string[];
  candidate: { category: string | null; fields: { name: string; value: string | null; confidence: number | null }[] };
}

export interface RunOptions {
  /** Minimum overall confidence. Threshold is a founder decision (D-04); there is NO default. If omitted, the check is off. */
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

function fail(code: ErrorCode, message: string, paths?: string[]): RunResult {
  return paths && paths.length ? { ok: false, error: { code, message, paths } } : { ok: false, error: { code, message } };
}

/** Structural validation of the synthetic input record. Messages never echo input values. */
export function validateInput(x: unknown): string[] {
  const errors: string[] = [];
  const path = 'input';
  if (!isRecord(x)) return [`${path}: expected object`];
  checkKeys(x, ['workspace_id', 'correlation_id', 'event_id', 'received_at', 'channel_ref', 'masking', 'masked_text',
    'category_list', 'required_fields', 'candidate'], path, errors, ['requested_contract', 'pii_summary']);

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

  if (!isRecord(x.candidate)) errors.push(`${path}.candidate: expected object`);
  else {
    checkKeys(x.candidate, ['category', 'fields'], `${path}.candidate`, errors);
    if (x.candidate.category !== null && !isNonEmptyString(x.candidate.category)) errors.push(`${path}.candidate.category: expected null or non-empty string`);
    if (!Array.isArray(x.candidate.fields)) errors.push(`${path}.candidate.fields: expected array`);
    else {
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
  }
  return errors;
}

function itemIdFor(workspaceId: string, eventId: string): string {
  return 'wi-' + createHash('sha256').update(`${workspaceId}\n${eventId}`).digest('hex').slice(0, 12);
}

function buildWorkItem(input: IntakeInput, options: RunOptions): { item: WorkItemV1; overallConfidence: number | null } {
  // "extract-fields" stand-in: take the supplied candidate values as they are.
  const fields: FieldEntry[] = input.candidate.fields.map((f) => ({
    name: f.name,
    value: f.value,
    confidence: f.value === null ? null : f.confidence,
    found: f.value !== null,
  }));
  for (const name of input.required_fields) {
    if (!fields.some((f) => f.name === name)) fields.push({ name, value: null, confidence: null, found: false });
  }

  // "validate-completeness" stand-in.
  const missing = input.required_fields.filter((n) => !fields.some((f) => f.name === n && f.found));

  // "classify-request" stand-in: accept the supplied category only if it is in the configured list.
  const cand = input.candidate.category;
  const category = cand !== null && input.category_list.includes(cand) ? cand : 'unknown';

  const confidences = fields.filter((f) => f.found && f.confidence !== null).map((f) => f.confidence as number);
  const overall = confidences.length ? Math.min(...confidences) : null;

  const reasons: ReasonCode[] = [];
  if (missing.length) reasons.push('missing_fields');
  if (category === 'unknown') reasons.push('unknown_category');
  if (options.minConfidence !== undefined && (overall === null || overall < options.minConfidence)) reasons.push('low_confidence');

  // "create-work-item" stand-in.
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

  // 5. Build and validate the work item (internal self-check).
  const { item, overallConfidence } = buildWorkItem(typed, options);
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
