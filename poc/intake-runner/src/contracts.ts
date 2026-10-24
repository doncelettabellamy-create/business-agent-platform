// Contract validators for the Intake proof of concept (PoC).
// Pure functions: no I/O, no network, no model, no database.
// Contract fields follow docs/blueprint/TEMPLATES.md (section 6). The contracts are proposals, not approved.
// Error strings contain only fixed field paths and numeric indices, never input values (log hygiene).

export const WORK_ITEM_CONTRACT = 'work_item.v1';

// ambiguous_category and ambiguous_field were added with the local classify-extract skill (draft proposal, unapproved).
export const REASON_CODES = [
  'missing_fields', 'unknown_category', 'ambiguous_category', 'ambiguous_field', 'low_confidence',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const ITEM_STATUSES = ['ready', 'needs-human'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export interface FieldEntry {
  name: string;
  value: string | null;
  confidence: number | null;
  found: boolean;
}

export interface PiiSummaryEntry {
  type: string;
  count: number;
}

export interface WorkItemV1 {
  item_id: string;
  workspace_id: string;
  source: { channel_ref: string; event_id: string };
  category: string;
  fields: FieldEntry[];
  missing_fields: string[];
  message_ref: string;
  pii_summary: PiiSummaryEntry[];
  status: ItemStatus;
  reasons: ReasonCode[];
  versions: { skill: string; model: string; prompt: string };
}

export interface HandoffEnvelopeV1 {
  contract: typeof WORK_ITEM_CONTRACT;
  workspace_id: string;
  correlation_id: string;
  item_id: string;
  payload: WorkItemV1;
  evidence_refs: string[];
  confidence: number | null;
  produced_by: string;
  created_at: string;
}

type Rec = Record<string, unknown>;

export function isRecord(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}
export function isUnitNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

/** Exact key check: every required key present, no unexpected keys. Never echoes key names from the input. */
export function checkKeys(obj: Rec, required: readonly string[], path: string, errors: string[], optional: readonly string[] = []): void {
  for (const k of required) {
    if (!Object.hasOwn(obj, k)) errors.push(`${path}.${k}: missing`);
  }
  for (const k of Object.keys(obj)) {
    if (!required.includes(k) && !optional.includes(k)) errors.push(`${path}: unexpected key`);
  }
}

const ITEM_ID = /^wi-[0-9a-f]{12}$/;
export const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function validateFieldEntry(f: unknown, path: string, errors: string[]): void {
  if (!isRecord(f)) { errors.push(`${path}: expected object`); return; }
  checkKeys(f, ['name', 'value', 'confidence', 'found'], path, errors);
  if (!isNonEmptyString(f.name)) errors.push(`${path}.name: expected non-empty string`);
  if (typeof f.found !== 'boolean') { errors.push(`${path}.found: expected boolean`); return; }
  if (f.found) {
    if (!isNonEmptyString(f.value)) errors.push(`${path}.value: expected non-empty string when found`);
    if (f.confidence !== null && !isUnitNumber(f.confidence)) errors.push(`${path}.confidence: expected null or number from 0 to 1`);
  } else {
    if (f.value !== null) errors.push(`${path}.value: expected null when not found`);
    if (f.confidence !== null) errors.push(`${path}.confidence: expected null when not found`);
  }
}

/** Validates a work_item.v1 object. Returns a list of problems; an empty list means valid. */
export function validateWorkItem(x: unknown, path = 'work_item'): string[] {
  const errors: string[] = [];
  if (!isRecord(x)) return [`${path}: expected object`];
  checkKeys(x, ['item_id', 'workspace_id', 'source', 'category', 'fields', 'missing_fields', 'message_ref',
    'pii_summary', 'status', 'reasons', 'versions'], path, errors);

  if (typeof x.item_id !== 'string' || !ITEM_ID.test(x.item_id)) errors.push(`${path}.item_id: expected id like wi-<12 hex>`);
  if (!isNonEmptyString(x.workspace_id)) errors.push(`${path}.workspace_id: expected non-empty string`);

  if (!isRecord(x.source)) errors.push(`${path}.source: expected object`);
  else {
    checkKeys(x.source, ['channel_ref', 'event_id'], `${path}.source`, errors);
    if (!isNonEmptyString(x.source.channel_ref)) errors.push(`${path}.source.channel_ref: expected non-empty string`);
    if (!isNonEmptyString(x.source.event_id)) errors.push(`${path}.source.event_id: expected non-empty string`);
  }

  if (!isNonEmptyString(x.category)) errors.push(`${path}.category: expected non-empty string`);

  const fieldNames: string[] = [];
  const notFound: string[] = [];
  if (!Array.isArray(x.fields)) errors.push(`${path}.fields: expected array`);
  else {
    x.fields.forEach((f: unknown, i: number) => {
      validateFieldEntry(f, `${path}.fields[${i}]`, errors);
      if (isRecord(f) && isNonEmptyString(f.name)) {
        if (fieldNames.includes(f.name)) errors.push(`${path}.fields[${i}].name: duplicate`);
        fieldNames.push(f.name);
        if (f.found === false) notFound.push(f.name);
      }
    });
  }

  if (!Array.isArray(x.missing_fields)) errors.push(`${path}.missing_fields: expected array`);
  else {
    x.missing_fields.forEach((m: unknown, i: number) => {
      if (!isNonEmptyString(m)) errors.push(`${path}.missing_fields[${i}]: expected non-empty string`);
      else if (!notFound.includes(m)) errors.push(`${path}.missing_fields[${i}]: must name a field that was not found`);
    });
  }

  if (typeof x.message_ref !== 'string' || !x.message_ref.startsWith('msg:') || x.message_ref.length < 5) {
    errors.push(`${path}.message_ref: expected reference starting with msg:`);
  }

  if (!Array.isArray(x.pii_summary)) errors.push(`${path}.pii_summary: expected array`);
  else {
    x.pii_summary.forEach((p: unknown, i: number) => {
      const pp = `${path}.pii_summary[${i}]`;
      if (!isRecord(p)) { errors.push(`${pp}: expected object`); return; }
      checkKeys(p, ['type', 'count'], pp, errors);
      if (!isNonEmptyString(p.type)) errors.push(`${pp}.type: expected non-empty string`);
      if (typeof p.count !== 'number' || !Number.isInteger(p.count) || p.count < 0) errors.push(`${pp}.count: expected integer 0 or more`);
    });
  }

  const statusOk = typeof x.status === 'string' && (ITEM_STATUSES as readonly string[]).includes(x.status);
  if (!statusOk) errors.push(`${path}.status: expected ready or needs-human`);

  const reasons: string[] = [];
  if (!Array.isArray(x.reasons)) errors.push(`${path}.reasons: expected array`);
  else {
    x.reasons.forEach((r: unknown, i: number) => {
      if (typeof r !== 'string' || !(REASON_CODES as readonly string[]).includes(r)) errors.push(`${path}.reasons[${i}]: unknown reason code`);
      else if (reasons.includes(r)) errors.push(`${path}.reasons[${i}]: duplicate`);
      else reasons.push(r);
    });
  }

  if (!isRecord(x.versions)) errors.push(`${path}.versions: expected object`);
  else {
    checkKeys(x.versions, ['skill', 'model', 'prompt'], `${path}.versions`, errors);
    for (const k of ['skill', 'model', 'prompt']) {
      if (!isNonEmptyString(x.versions[k])) errors.push(`${path}.versions.${k}: expected non-empty string`);
    }
  }

  // Consistency rules between status, reasons, category, and missing fields.
  if (statusOk && Array.isArray(x.reasons) && Array.isArray(x.missing_fields)) {
    if (x.status === 'ready') {
      if (reasons.length > 0) errors.push(`${path}.reasons: must be empty when status is ready`);
      if (x.missing_fields.length > 0) errors.push(`${path}.missing_fields: must be empty when status is ready`);
      if (x.category === 'unknown') errors.push(`${path}.category: unknown is not allowed when status is ready`);
    } else if (reasons.length === 0) {
      errors.push(`${path}.reasons: required when status is needs-human`);
    }
    if ((x.missing_fields.length > 0) !== reasons.includes('missing_fields')) {
      errors.push(`${path}.reasons: missing_fields reason must match missing_fields list`);
    }
    // An unknown category needs exactly one explanation (nothing matched, or a tie); a known category needs none.
    const categoryReasons = ['unknown_category', 'ambiguous_category'].filter((r) => reasons.includes(r)).length;
    if (x.category === 'unknown' && categoryReasons !== 1) {
      errors.push(`${path}.reasons: unknown category needs exactly one of unknown_category or ambiguous_category`);
    }
    if (x.category !== 'unknown' && categoryReasons !== 0) {
      errors.push(`${path}.reasons: category reasons are only allowed when the category is unknown`);
    }
  }
  return errors;
}

/** Validates a handoff envelope that carries a work_item.v1 payload. Empty list means valid. */
export function validateEnvelope(x: unknown): string[] {
  const errors: string[] = [];
  const path = 'envelope';
  if (!isRecord(x)) return [`${path}: expected object`];
  checkKeys(x, ['contract', 'workspace_id', 'correlation_id', 'item_id', 'payload', 'evidence_refs', 'confidence',
    'produced_by', 'created_at'], path, errors);

  if (x.contract !== WORK_ITEM_CONTRACT) errors.push(`${path}.contract: unsupported contract or version`);
  if (!isNonEmptyString(x.workspace_id)) errors.push(`${path}.workspace_id: expected non-empty string`);
  if (!isNonEmptyString(x.correlation_id)) errors.push(`${path}.correlation_id: expected non-empty string`);
  if (typeof x.item_id !== 'string' || !ITEM_ID.test(x.item_id)) errors.push(`${path}.item_id: expected id like wi-<12 hex>`);

  const payloadErrors = validateWorkItem(x.payload, `${path}.payload`);
  errors.push(...payloadErrors);
  if (isRecord(x.payload)) {
    if (x.payload.workspace_id !== x.workspace_id) errors.push(`${path}.workspace_id: must match payload workspace`);
    if (x.payload.item_id !== x.item_id) errors.push(`${path}.item_id: must match payload item`);
    if (isRecord(x.payload) && x.payload.status !== 'ready') errors.push(`${path}.payload.status: only ready items may be handed off`);
  }

  if (!Array.isArray(x.evidence_refs) || x.evidence_refs.length === 0) errors.push(`${path}.evidence_refs: expected non-empty array`);
  else x.evidence_refs.forEach((r: unknown, i: number) => {
    if (!isNonEmptyString(r)) errors.push(`${path}.evidence_refs[${i}]: expected non-empty string`);
  });
  if (x.confidence !== null && !isUnitNumber(x.confidence)) errors.push(`${path}.confidence: expected null or number from 0 to 1`);
  if (!isNonEmptyString(x.produced_by)) errors.push(`${path}.produced_by: expected non-empty string`);
  if (typeof x.created_at !== 'string' || !TIMESTAMP.test(x.created_at)) errors.push(`${path}.created_at: expected UTC timestamp`);
  return errors;
}
