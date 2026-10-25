// report.v1: the status report Reporting builds from sealed, independently checked Intake -> Processing -> QC chains
// (proof of concept; the field set is a proposal, the name follows AGENT_SPECS section 5). Fixed words, ids and integers
// only: no customer text, no category or field names, no tool output.
//
// `basis` is always 'verified-simulation': every tool in this proof of concept is a mock, so a counted pass means the
// pipeline mechanics held, not that real work was done. `not_measured` is a fixed list so that absence is never read as zero.
// This file imports only contracts.ts and qc-verdict.ts and does no I/O.

import { checkKeys, isNonEmptyString, isRecord, TIMESTAMP } from './contracts.ts';
import { CHECK_NAMES, CHECK_REASONS } from './qc-verdict.ts';

export const REPORT_CONTRACT = 'report.v1';
export const BASIS = 'verified-simulation';
export const NOT_MEASURED = ['intake_needs_human', 'inputs_never_submitted', 'real_effects'] as const;
export const EXCEPTION_KINDS = ['rework', 'escalate', 'chain_conflict'] as const;
export const BROKEN_LINKS = ['candidate_digest', 'handoff_digest', 'parent_chain', 'item_id', 'correlation_ids', 'candidate_status'] as const;
/** Codes a refused input can be tallied under. */
export const REFUSAL_CODES = [
  'TRIPLE_INVALID', 'HANDOFF_NOT_TRUSTED', 'CANDIDATE_NOT_TRUSTED', 'VERDICT_NOT_TRUSTED',
  'ENVELOPE_INVALID', 'CANDIDATE_INVALID', 'VERDICT_INVALID', 'TENANT_MISMATCH', 'ATTEMPT_LIMIT',
] as const;
export const COUNT_KEYS = ['submitted', 'counted_items', 'verified_simulated_pass', 'rework', 'escalate', 'chain_conflict', 'refused', 'duplicates', 'repeat_attempts'] as const;
export const OUTCOMES = ['pass', 'rework', 'escalate', 'chain_conflict'] as const;

export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];
export interface ReportException { item_id: string; kind: ExceptionKind; checks: { check: (typeof CHECK_NAMES)[number]; reason: (typeof CHECK_REASONS)[number] }[]; broken: (typeof BROKEN_LINKS)[number][] }
export interface ReportChain { item_id: string; outcome: (typeof OUTCOMES)[number]; intake_correlation_id: string; processing_correlation_id: string; qc_correlation_id: string }
export interface ReportV1 {
  contract: typeof REPORT_CONTRACT;
  workspace_id: string;
  correlation_id: string;
  created_at: string;
  produced_by: 'reporting';
  basis: typeof BASIS;
  counts: Record<(typeof COUNT_KEYS)[number], number>;
  exceptions: ReportException[];
  chains: ReportChain[];
  /** The append-only observation log behind the report: its size, head and whether its hash chain verified. */
  history: { observations: number; head_seq: number; head_digest: string; verified: boolean; superseded_on_arrival: number; chain_rejected: number };
  /** Items by CURRENT verified status (derived from the log by QC verdict time). `counts` above stay first-outcome. */
  current: Record<(typeof OUTCOMES)[number], number>;
  statuses: { item_id: string; first: (typeof OUTCOMES)[number]; current: (typeof OUTCOMES)[number]; attempts: number }[];
  refusals: { code: (typeof REFUSAL_CODES)[number]; count: number }[];
  lists_truncated: boolean;
  not_measured: string[];
}

const ITEM_ID = /^wi-[0-9a-f]{12}$/;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000;
const oneOf = (list: readonly string[], v: unknown) => typeof v === 'string' && list.includes(v);

/** Validates a report.v1, including its arithmetic. Empty list means valid. Never echoes input values. */
export function validateReport(x: unknown): string[] {
  const errors: string[] = [];
  const path = 'report';
  if (!isRecord(x)) return [`${path}: expected object`];
  checkKeys(x, ['contract', 'workspace_id', 'correlation_id', 'created_at', 'produced_by', 'basis', 'counts', 'exceptions', 'chains', 'history', 'current', 'statuses', 'refusals', 'lists_truncated', 'not_measured'], path, errors);
  if (x.contract !== REPORT_CONTRACT) errors.push(`${path}.contract: unsupported contract or version`);
  if (!isNonEmptyString(x.workspace_id)) errors.push(`${path}.workspace_id: expected non-empty string`);
  if (!isNonEmptyString(x.correlation_id)) errors.push(`${path}.correlation_id: expected non-empty string`);
  if (typeof x.created_at !== 'string' || !TIMESTAMP.test(x.created_at)) errors.push(`${path}.created_at: expected UTC timestamp`);
  if (x.produced_by !== 'reporting') errors.push(`${path}.produced_by: expected reporting`);
  if (x.basis !== BASIS) errors.push(`${path}.basis: expected ${BASIS}`);
  if (typeof x.lists_truncated !== 'boolean') errors.push(`${path}.lists_truncated: expected boolean`);
  if (!Array.isArray(x.not_measured) || x.not_measured.join('|') !== NOT_MEASURED.join('|')) errors.push(`${path}.not_measured: must list exactly what is not measured`);

  let c: Record<string, number> | null = null;
  if (!isRecord(x.counts)) errors.push(`${path}.counts: expected object`);
  else {
    checkKeys(x.counts, COUNT_KEYS, `${path}.counts`, errors);
    if (COUNT_KEYS.every((k) => isCount((x.counts as Record<string, unknown>)[k]))) c = x.counts as Record<string, number>;
    else errors.push(`${path}.counts: every count must be a non-negative integer`);
  }
  if (!Array.isArray(x.refusals)) errors.push(`${path}.refusals: expected array`);
  let refusalTotal = 0;
  if (Array.isArray(x.refusals)) {
    const seen = new Set<string>();
    (x.refusals as unknown[]).forEach((r, i) => {
      const p = `${path}.refusals[${i}]`;
      if (!isRecord(r)) { errors.push(`${p}: expected object`); return; }
      checkKeys(r, ['code', 'count'], p, errors);
      if (!oneOf(REFUSAL_CODES, r.code)) errors.push(`${p}.code: unknown code`);
      else if (seen.has(r.code as string)) errors.push(`${p}.code: duplicate`);
      else seen.add(r.code as string);
      if (!isCount(r.count) || r.count === 0) errors.push(`${p}.count: expected a positive integer`);
      else refusalTotal += r.count;
    });
  }
  if (c) {
    if (c.submitted !== c.counted_items + c.refused + c.duplicates + c.repeat_attempts) errors.push(`${path}.counts: submitted must equal counted + refused + duplicates + repeat attempts`);
    if (c.counted_items !== c.verified_simulated_pass + c.rework + c.escalate + c.chain_conflict) errors.push(`${path}.counts: counted items must equal the four outcomes`);
    if (c.refused !== refusalTotal) errors.push(`${path}.refusals: must add up to the refused count`);
  }
  if (!Array.isArray(x.exceptions)) errors.push(`${path}.exceptions: expected array`);
  else (x.exceptions as unknown[]).forEach((e, i) => {
    const p = `${path}.exceptions[${i}]`;
    if (!isRecord(e)) { errors.push(`${p}: expected object`); return; }
    checkKeys(e, ['item_id', 'kind', 'checks', 'broken'], p, errors);
    if (typeof e.item_id !== 'string' || !ITEM_ID.test(e.item_id)) errors.push(`${p}.item_id: expected id like wi-<12 hex>`);
    if (!oneOf(EXCEPTION_KINDS, e.kind)) errors.push(`${p}.kind: unknown kind`);
    if (!Array.isArray(e.checks) || !(e.checks as unknown[]).every((k) => isRecord(k) && Object.keys(k).length === 2 && oneOf(CHECK_NAMES, k.check) && oneOf(CHECK_REASONS, k.reason))) errors.push(`${p}.checks: expected check names with reasons`);
    if (!Array.isArray(e.broken) || !(e.broken as unknown[]).every((b) => oneOf(BROKEN_LINKS, b))) errors.push(`${p}.broken: expected link names`);
    if (e.kind === 'chain_conflict' && Array.isArray(e.broken) && e.broken.length === 0) errors.push(`${p}.broken: a chain conflict must name what is broken`);
    if (e.kind !== 'chain_conflict' && Array.isArray(e.broken) && e.broken.length > 0) errors.push(`${p}.broken: only a chain conflict names broken links`);
  });
  if (!Array.isArray(x.chains)) errors.push(`${path}.chains: expected array`);
  else (x.chains as unknown[]).forEach((e, i) => {
    const p = `${path}.chains[${i}]`;
    if (!isRecord(e)) { errors.push(`${p}: expected object`); return; }
    checkKeys(e, ['item_id', 'outcome', 'intake_correlation_id', 'processing_correlation_id', 'qc_correlation_id'], p, errors);
    if (typeof e.item_id !== 'string' || !ITEM_ID.test(e.item_id)) errors.push(`${p}.item_id: expected id like wi-<12 hex>`);
    if (!oneOf(OUTCOMES, e.outcome)) errors.push(`${p}.outcome: unknown outcome`);
    for (const k of ['intake_correlation_id', 'processing_correlation_id', 'qc_correlation_id']) if (!isNonEmptyString(e[k])) errors.push(`${p}.${k}: expected non-empty string`);
  });
  // History, current status, statuses.
  const HEX64 = /^[0-9a-f]{64}$/;
  if (!isRecord(x.history)) errors.push(`${path}.history: expected object`);
  else {
    const h = x.history;
    checkKeys(h, ['observations', 'head_seq', 'head_digest', 'verified', 'superseded_on_arrival', 'chain_rejected'], `${path}.history`, errors);
    for (const k of ['observations', 'head_seq', 'superseded_on_arrival', 'chain_rejected']) if (!isCount(h[k])) errors.push(`${path}.history.${k}: expected a non-negative integer`);
    if (typeof h.head_digest !== 'string' || !HEX64.test(h.head_digest)) errors.push(`${path}.history.head_digest: expected a 64-hex digest`);
    if (h.verified !== true) errors.push(`${path}.history.verified: the observation log must verify`);
    if (isCount(h.observations) && isCount(h.head_seq) && h.observations !== h.head_seq) errors.push(`${path}.history: head sequence must equal the number of observations`);
    if (c && isCount(h.observations) && h.observations !== c.counted_items + c.repeat_attempts) errors.push(`${path}.history.observations: must equal counted items plus repeat attempts`);
    if (isCount(h.observations) && isCount(h.superseded_on_arrival) && isCount(h.chain_rejected) && h.superseded_on_arrival + h.chain_rejected > h.observations) errors.push(`${path}.history: more observations set aside than exist`);
  }
  if (!isRecord(x.current)) errors.push(`${path}.current: expected object`);
  else {
    checkKeys(x.current, OUTCOMES, `${path}.current`, errors);
    const cur = x.current;
    if (OUTCOMES.every((k) => isCount(cur[k]))) {
      const total = OUTCOMES.reduce((n, k) => n + (cur[k] as number), 0);
      if (c && total !== c.counted_items) errors.push(`${path}.current: current statuses must cover every counted item`);
    } else errors.push(`${path}.current: every count must be a non-negative integer`);
  }
  if (!Array.isArray(x.statuses)) errors.push(`${path}.statuses: expected array`);
  else {
    const seenItems = new Set<string>();
    (x.statuses as unknown[]).forEach((s, i) => {
      const p = `${path}.statuses[${i}]`;
      if (!isRecord(s)) { errors.push(`${p}: expected object`); return; }
      checkKeys(s, ['item_id', 'first', 'current', 'attempts'], p, errors);
      if (typeof s.item_id !== 'string' || !ITEM_ID.test(s.item_id)) errors.push(`${p}.item_id: expected id like wi-<12 hex>`);
      else if (seenItems.has(s.item_id)) errors.push(`${p}.item_id: duplicate`);
      else seenItems.add(s.item_id);
      if (!oneOf(OUTCOMES, s.first)) errors.push(`${p}.first: unknown outcome`);
      if (!oneOf(OUTCOMES, s.current)) errors.push(`${p}.current: unknown outcome`);
      if (!isCount(s.attempts) || s.attempts < 1) errors.push(`${p}.attempts: expected a positive integer`);
    });
    if (x.lists_truncated === false && c && x.statuses.length !== c.counted_items) errors.push(`${path}.statuses: must list every counted item when not truncated`);
  }
  if (c && Array.isArray(x.exceptions) && Array.isArray(x.chains) && x.lists_truncated === false) {
    if (x.exceptions.length !== c.rework + c.escalate + c.chain_conflict) errors.push(`${path}.exceptions: must list every exception when not truncated`);
    if (x.chains.length !== c.counted_items) errors.push(`${path}.chains: must list every counted item when not truncated`);
  }
  return errors;
}
