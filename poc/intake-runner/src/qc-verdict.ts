// qc_verdict.v1: what Quality Control returns about a candidate_result.v1 (proof of concept; the field set is a proposal and
// the name follows AGENT_SPECS section 4). It holds fixed words and ids only: no candidate content, no tool output, no
// customer text. `candidate_digest` ties the verdict to the exact candidate that was checked; `parent_correlation_id` is the
// candidate's (Processing) correlation id, so the chain is QC -> Processing -> Intake through the candidate's own parent id.
// This file imports only contracts.ts and does no I/O.

import { checkKeys, isNonEmptyString, isRecord, TIMESTAMP } from './contracts.ts';

export const QC_CONTRACT = 'qc_verdict.v1';
export const VERDICTS = ['pass', 'rework', 'escalate'] as const;
export const CHECK_NAMES = ['trace_chain', 'binding', 'plan', 'evidence_exists', 'no_orphans', 'human_approval', 'action_binding', 'durable_completion', 'consistency'] as const;
/** The checks about human approval and its durable record. They read the approval store, and say `not_required` when the plan has no human-approved tool. */
export const HUMAN_CHECKS: readonly (typeof CHECK_NAMES)[number][] = ['human_approval', 'action_binding', 'durable_completion'];
export const CHECK_RESULTS = ['pass', 'fail', 'unverifiable', 'not_required'] as const;
export const CHECK_REASONS = ['MISMATCH', 'MISSING', 'ORPHAN', 'READ_FAILED', 'CANDIDATE_FAILED', 'CANDIDATE_UNCERTAIN', 'RECORD_UNCERTAIN'] as const;

export type Verdict = (typeof VERDICTS)[number];
export interface CheckRecord { check: (typeof CHECK_NAMES)[number]; result: (typeof CHECK_RESULTS)[number]; reason?: (typeof CHECK_REASONS)[number] }
export interface QcVerdictV1 {
  contract: typeof QC_CONTRACT;
  workspace_id: string;
  item_id: string;
  correlation_id: string;
  parent_correlation_id: string;
  candidate_digest: string;
  verdict: Verdict;
  checks: CheckRecord[];
  produced_by: 'quality-control';
  created_at: string;
}

const ITEM_ID = /^wi-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;

/**
 * The verdict implied by the checks. Pass needs every check to pass (a human-approval check may say `not_required` when the plan has no
 * human-approved tool, and no other check may); anything unverifiable escalates; a failure asks for rework.
 */
export function verdictFor(checks: readonly { result: string }[]): Verdict {
  if (checks.some((c) => c.result === 'unverifiable')) return 'escalate';
  if (checks.some((c) => c.result === 'fail')) return 'rework';
  return checks.length === CHECK_NAMES.length && checks.every((c, i) => c.result === 'pass' || (c.result === 'not_required' && HUMAN_CHECKS.includes(CHECK_NAMES[i]))) ? 'pass' : 'escalate';
}

/** Validates a qc_verdict.v1. Empty list means valid. Never echoes input values. */
export function validateVerdict(x: unknown): string[] {
  const errors: string[] = [];
  const path = 'verdict';
  if (!isRecord(x)) return [`${path}: expected object`];
  checkKeys(x, ['contract', 'workspace_id', 'item_id', 'correlation_id', 'parent_correlation_id', 'candidate_digest', 'verdict', 'checks', 'produced_by', 'created_at'], path, errors);
  if (x.contract !== QC_CONTRACT) errors.push(`${path}.contract: unsupported contract or version`);
  if (!isNonEmptyString(x.workspace_id)) errors.push(`${path}.workspace_id: expected non-empty string`);
  if (typeof x.item_id !== 'string' || !ITEM_ID.test(x.item_id)) errors.push(`${path}.item_id: expected id like wi-<12 hex>`);
  if (!isNonEmptyString(x.correlation_id)) errors.push(`${path}.correlation_id: expected non-empty string`);
  if (!isNonEmptyString(x.parent_correlation_id)) errors.push(`${path}.parent_correlation_id: expected non-empty string`);
  if (typeof x.candidate_digest !== 'string' || !DIGEST.test(x.candidate_digest)) errors.push(`${path}.candidate_digest: expected a sha256 hex digest`);
  if (!(VERDICTS as readonly unknown[]).includes(x.verdict)) errors.push(`${path}.verdict: expected pass, rework or escalate`);
  if (x.produced_by !== 'quality-control') errors.push(`${path}.produced_by: expected quality-control`);
  if (typeof x.created_at !== 'string' || !TIMESTAMP.test(x.created_at)) errors.push(`${path}.created_at: expected UTC timestamp`);

  if (!Array.isArray(x.checks) || x.checks.length !== CHECK_NAMES.length) errors.push(`${path}.checks: expected exactly the ${CHECK_NAMES.length} named checks`);
  else {
    x.checks.forEach((c: unknown, i: number) => {
      const p = `${path}.checks[${i}]`;
      if (!isRecord(c)) { errors.push(`${p}: expected object`); return; }
      checkKeys(c, ['check', 'result'], p, errors, ['reason']);
      if (c.check !== CHECK_NAMES[i]) errors.push(`${p}.check: expected ${CHECK_NAMES[i]}`);
      if (!(CHECK_RESULTS as readonly unknown[]).includes(c.result)) errors.push(`${p}.result: expected pass, fail, unverifiable or not_required`);
      if (c.result === 'not_required' && !HUMAN_CHECKS.includes(CHECK_NAMES[i])) errors.push(`${p}.result: only a human-approval check may be not_required`);
      if ((c.result === 'pass' || c.result === 'not_required') && Object.hasOwn(c, 'reason')) errors.push(`${p}.reason: not allowed on a check that did not fail`);
      if (c.result !== 'pass' && c.result !== 'not_required' && !(CHECK_REASONS as readonly unknown[]).includes(c.reason)) errors.push(`${p}.reason: required when a check does not pass`);
    });
    if (errors.length === 0 && x.verdict !== verdictFor(x.checks as { result: string }[])) errors.push(`${path}.verdict: does not follow from the checks`);
  }
  return errors;
}
