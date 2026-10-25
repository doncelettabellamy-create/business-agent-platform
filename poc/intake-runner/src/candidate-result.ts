// candidate_result.v1: what Processing hands to Quality Control (proof of concept; the field set is a proposal, not an
// approved contract). References and codes only: no customer text, no raw tool output.
// Linked trace ids: `correlation_id` is the Processing run's own minted id; `parent_correlation_id` is the Intake handoff's;
// `item_id` and each `step_id` tie the result to the work item and to the tool calls.
// `handoff_digest` binds the result to the exact sealed Intake envelope it was built from.
// This file imports contracts.ts and a hash only, and does no I/O.

import { createHash } from 'node:crypto';
import { checkKeys, isNonEmptyString, isRecord, TIMESTAMP } from './contracts.ts';

export const CANDIDATE_CONTRACT = 'candidate_result.v1';
export const STEP_STATUSES = ['ok', 'failed', 'uncertain', 'skipped'] as const;
export const CANDIDATE_STATUSES = ['complete', 'failed', 'uncertain'] as const;
/** A `failed` step means the tool said, definitively, that it did NOT perform the action. */
export const NOT_PERFORMED_CODE = 'TOOL_NOT_PERFORMED';
/** A human said no. Also a definitive "not performed". */
export const DECLINED_CODE = 'APPROVAL_DECLINED';
/** An `uncertain` step means the effect is unknown: the call timed out, raised an error, or answered with something unreadable. It is never retried blindly. */
export const UNCERTAIN_CODES = ['TOOL_FAILED', 'TOOL_TIMEOUT', 'TOOL_OUTPUT_INVALID', 'COMPLETION_NOT_RECORDED'] as const;

const ITEM_ID = /^wi-[0-9a-f]{12}$/;
const STEP_ID = /^st-[0-9a-f]{12}$/;
const TOOL_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const REF = /^[A-Za-z0-9_.:-]{1,64}$/;
const DIGEST = /^[0-9a-f]{64}$/;

/** The deterministic step id. Processing derives it and QC recomputes it, so neither trusts the other's value. */
export function stepIdFor(tenant: string, itemId: string, index: number, tool: string): string {
  return 'st-' + createHash('sha256').update(`${tenant}
${itemId}
${index}
${tool}`).digest('hex').slice(0, 12);
}

export interface StepRecord {
  step_id: string;
  tool: string;
  status: (typeof STEP_STATUSES)[number];
  evidence_ref?: string;
  code?: string;
  /** Present (and `human`) when the step needed a named human's approval. Quality Control cross-checks it against its own configuration. */
  approval?: 'human';
}
export interface CandidateResultV1 {
  contract: typeof CANDIDATE_CONTRACT;
  workspace_id: string;
  item_id: string;
  correlation_id: string;
  parent_correlation_id: string;
  handoff_digest: string;
  status: (typeof CANDIDATE_STATUSES)[number];
  steps: StepRecord[];
  evidence_refs: string[];
  produced_by: 'processing';
  created_at: string;
}

/** Validates a candidate_result.v1. Empty list means valid. Never echoes input values. */
export function validateCandidate(x: unknown): string[] {
  const errors: string[] = [];
  const path = 'candidate';
  if (!isRecord(x)) return [`${path}: expected object`];
  checkKeys(x, ['contract', 'workspace_id', 'item_id', 'correlation_id', 'parent_correlation_id', 'handoff_digest', 'status', 'steps', 'evidence_refs', 'produced_by', 'created_at'], path, errors);
  if (x.contract !== CANDIDATE_CONTRACT) errors.push(`${path}.contract: unsupported contract or version`);
  if (!isNonEmptyString(x.workspace_id)) errors.push(`${path}.workspace_id: expected non-empty string`);
  if (typeof x.item_id !== 'string' || !ITEM_ID.test(x.item_id)) errors.push(`${path}.item_id: expected id like wi-<12 hex>`);
  if (!isNonEmptyString(x.correlation_id)) errors.push(`${path}.correlation_id: expected non-empty string`);
  if (!isNonEmptyString(x.parent_correlation_id)) errors.push(`${path}.parent_correlation_id: expected non-empty string`);
  if (typeof x.handoff_digest !== 'string' || !DIGEST.test(x.handoff_digest)) errors.push(`${path}.handoff_digest: expected a sha256 hex digest`);
  if (!(CANDIDATE_STATUSES as readonly unknown[]).includes(x.status)) errors.push(`${path}.status: expected complete, failed or uncertain`);
  if (x.produced_by !== 'processing') errors.push(`${path}.produced_by: expected processing`);
  if (typeof x.created_at !== 'string' || !TIMESTAMP.test(x.created_at)) errors.push(`${path}.created_at: expected UTC timestamp`);

  const okRefs: string[] = [];
  if (!Array.isArray(x.steps) || x.steps.length === 0 || x.steps.length > 8) errors.push(`${path}.steps: expected 1 to 8 steps`);
  else {
    const seen = new Set<string>();
    x.steps.forEach((s: unknown, i: number) => {
      const p = `${path}.steps[${i}]`;
      if (!isRecord(s)) { errors.push(`${p}: expected object`); return; }
      checkKeys(s, ['step_id', 'tool', 'status'], p, errors, ['evidence_ref', 'code', 'approval']);
      if (Object.hasOwn(s, 'approval') && s.approval !== 'human') errors.push(`${p}.approval: only "human" is allowed`);
      if (typeof s.step_id !== 'string' || !STEP_ID.test(s.step_id)) errors.push(`${p}.step_id: expected id like st-<12 hex>`);
      else if (seen.has(s.step_id)) errors.push(`${p}.step_id: duplicate`);
      else seen.add(s.step_id);
      if (typeof s.tool !== 'string' || !TOOL_NAME.test(s.tool)) errors.push(`${p}.tool: expected a tool name`);
      if (!(STEP_STATUSES as readonly unknown[]).includes(s.status)) errors.push(`${p}.status: expected ok, failed, uncertain or skipped`);
      if (s.status === 'ok') {
        if (typeof s.evidence_ref !== 'string' || !REF.test(s.evidence_ref)) errors.push(`${p}.evidence_ref: required for an ok step`);
        else okRefs.push(s.evidence_ref);
        if (Object.hasOwn(s, 'code')) errors.push(`${p}.code: not allowed on an ok step`);
      } else {
        if (Object.hasOwn(s, 'evidence_ref')) errors.push(`${p}.evidence_ref: only an ok step has evidence`);
        if (s.status === 'failed' && s.code !== NOT_PERFORMED_CODE && s.code !== DECLINED_CODE) errors.push(`${p}.code: a failed step must say the action was not performed or was declined`);
        if (s.status === 'uncertain' && !(UNCERTAIN_CODES as readonly unknown[]).includes(s.code)) errors.push(`${p}.code: an uncertain step needs an uncertainty code`);
        if (s.status === 'skipped' && Object.hasOwn(s, 'code')) errors.push(`${p}.code: not allowed on a skipped step`);
      }
    });
    const all = x.steps as Array<Record<string, unknown>>;
    const has = (st: string) => all.some((s) => isRecord(s) && s.status === st);
    if (x.status === 'complete' && !all.every((s) => isRecord(s) && s.status === 'ok')) errors.push(`${path}.status: complete needs every step ok`);
    if (x.status === 'failed' && (!has('failed') || has('uncertain'))) errors.push(`${path}.status: failed needs a failed step and no uncertain step`);
    if (x.status === 'uncertain' && !has('uncertain')) errors.push(`${path}.status: uncertain needs an uncertain step`);
  }
  if (!Array.isArray(x.evidence_refs)) errors.push(`${path}.evidence_refs: expected array`);
  else {
    const refs = x.evidence_refs as unknown[];
    if (refs.length !== okRefs.length || refs.some((r, i) => r !== okRefs[i])) errors.push(`${path}.evidence_refs: must list exactly the ok steps' evidence, in order`);
    if (x.status === 'complete' && refs.length === 0) errors.push(`${path}.evidence_refs: a complete result needs evidence`);
  }
  return errors;
}
