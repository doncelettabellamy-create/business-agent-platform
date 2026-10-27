// SQLite store for the Intake records the founder phone test shows on the dashboard (proof of concept). DEVELOPMENT ONLY.
//
// What is stored: the safe view of a work item (ids, category, status, reasons, field names and MASKED values, placeholder counts, version
// labels) plus a call reference that is a hash of the tenant and the phone provider's call id. Never the transcript, never the caller's
// number, never the call id itself. Before anything is saved every string is checked with the same detectors as the masker
// (pii-screen.ts); a record that still looks personal is refused and nothing is written.
//
// Same limits as the other two SQLite stores: no database-level tenant isolation (the tenant is in every key and every statement, and a test
// checks it; FND-02 / R03 not met), single host and file, synchronous calls, no encryption at rest (FND-10), no retention policy (C14), no
// backups. UPDATE is refused by a trigger; DELETE is allowed only through `purge`, which the founder uses to remove a test record.
// The file path is injected by the operator. Own file: it refuses a file another kind of store marked.

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { isRecord } from './contracts.ts';
import { piiProblems } from './pii-screen.ts';

export const RECORD_SCHEMA_VERSION = '2';   // 2: records carry `confirmation` and `address_status`; a version-1 file is refused (delete it)
const KIND = 'intake-records';
const TENANT = /^[A-Za-z0-9_.:-]{1,64}$/;
const CALL_REF = /^[0-9a-f]{16}$/;
const ITEM = /^[A-Za-z0-9_.:-]{1,64}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export interface RecordField { name: string; value: string | null; confidence: number | null; found: boolean }
export interface IntakeRecord {
  item_id: string;
  workspace_id: string;
  call_ref: string;
  received_at: string;
  category: string;
  status: 'ready' | 'needs-human';
  reasons: string[];
  missing_fields: string[];
  fields: RecordField[];
  pii_summary: { type: string; count: number }[];
  confidence: number | null;
  versions: { skill: string; model: string; prompt: string };
  handed_off: boolean;
  turns: number;
  /** 'confirmed' only when the caller said yes to a read-back of exactly these values; every other way a call can end is 'unconfirmed'. */
  confirmation: 'confirmed' | 'unconfirmed';
  /**
   * 'none': no address is held for this call. 'unverified': an address was found or held but is not confirmed (never read back, refused, unanswered, or confirmation could not be
   * stored): a person must check it. 'caller_confirmed': the address was read back to the caller, who said yes, and the contact vault holds it as confirmed. It is NEVER a postal or
   * address-database validation, and it is never inferred: it is written only when the confirmed contact was stored for this call. Records written before 'caller_confirmed' existed
   * only ever hold 'none' or 'unverified' and are read unchanged.
   */
  address_status: 'unverified' | 'none' | 'caller_confirmed';
}
export const NOT_CONFIRMED = 'not_confirmed';
/**
 * The one predicate a future bridge to Processing may use: confirmed by the caller, ready, handed off, and either no address at all or an address the caller confirmed (checked against
 * the encrypted contact via `witness`; never an unverified one).
 * (Nothing connects this store to Processing today.)
 */
/**
 * What can confirm, from the encrypted contact for the SAME tenant and call, that an address was read back and confirmed. It answers with a state only, never the address.
 * The contact vault is one; anything else that fails to answer makes a 'caller_confirmed' record ineligible.
 */
export interface AddressWitness { addressState(tenant: string, callRef: string): 'confirmed' | 'unconfirmed' | 'refused' | undefined }
export function eligibleForProcessing(r: IntakeRecord, witness?: AddressWitness): boolean {
  if (!(r.confirmation === 'confirmed' && r.status === 'ready' && r.handed_off === true)) return false;
  if (r.address_status === 'none') return true;
  if (r.address_status !== 'caller_confirmed') return false;   // 'unverified' (or anything unrecognised) never qualifies
  // A record can only claim a confirmed address; the encrypted contact for this tenant and call must say so too. No witness, no contact, any other state, or any error: not eligible.
  try { return witness !== undefined && witness.addressState(r.workspace_id, r.call_ref) === 'confirmed'; } catch { return false; }
}
export type PutResult = 'new' | 'duplicate';
export interface IntakeRecordStore {
  put(tenant: string, record: IntakeRecord): PutResult;
  /** Newest first. */
  list(tenant: string): IntakeRecord[];
  /** Deletes one test record (and only that one); returns how many rows went. */
  purge(tenant: string, callRef: string): number;
  close(): void;
}
export class RecordRefused extends Error { constructor() { super('record refused'); this.name = 'RecordRefused'; } }

/** A stable reference for a call that does not reveal the provider's call id. */
export function callRefFor(tenant: string, callId: string): string {
  return createHash('sha256').update(`${tenant}\n${callId}`).digest('hex').slice(0, 16);
}

export function nodeSupportsSqlite(version: unknown): boolean {
  if (typeof version !== 'string') return false;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 24 || (major === 24 && minor >= 15);
}

const KEYS = 'address_status,call_ref,category,confidence,confirmation,fields,handed_off,item_id,missing_fields,pii_summary,reasons,received_at,status,turns,versions,workspace_id';
const text = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length <= max;

/** Throws RecordRefused unless `r` is exactly the safe shape for `tenant` and nothing in it looks personal. */
export function assertSafeRecord(tenant: string, r: unknown): asserts r is IntakeRecord {
  const bad = (): never => { throw new RecordRefused(); };
  if (!isRecord(r) || Object.keys(r).sort().join(',') !== KEYS) bad();
  const x = r as Record<string, unknown>;
  if (x.workspace_id !== tenant || !TENANT.test(tenant)) bad();
  if (!text(x.item_id) || !ITEM.test(x.item_id) || !text(x.call_ref) || !CALL_REF.test(x.call_ref)) bad();
  if (!text(x.received_at) || !TIME.test(x.received_at) || !text(x.category, 100)) bad();
  if (x.status !== 'ready' && x.status !== 'needs-human') bad();
  if (typeof x.handed_off !== 'boolean' || (x.handed_off && x.status !== 'ready')) bad();
  // Confirmation: only a caller's yes to the read-back makes a record hand-off-able; anything else is held for a person.
  if (x.confirmation !== 'confirmed' && x.confirmation !== 'unconfirmed') bad();
  if (x.address_status !== 'unverified' && x.address_status !== 'none' && x.address_status !== 'caller_confirmed') bad();
  if (x.address_status === 'caller_confirmed' && x.confirmation !== 'confirmed') bad();   // an unconfirmed request cannot claim a confirmed address
  if (x.handed_off && x.confirmation !== 'confirmed') bad();
  const reasonList = x.reasons;
  if (Array.isArray(reasonList)) {
    const flagged = reasonList.includes(NOT_CONFIRMED);
    if (x.confirmation === 'unconfirmed' && (!flagged || x.status !== 'needs-human' || x.handed_off)) bad();
    if (x.confirmation === 'confirmed' && flagged) bad();
  }
  if (!Number.isInteger(x.turns) || (x.turns as number) < 0 || (x.turns as number) > 1000) bad();
  if (x.confidence !== null && (typeof x.confidence !== 'number' || !(x.confidence >= 0 && x.confidence <= 1))) bad();
  for (const k of ['reasons', 'missing_fields'] as const) {
    const a = x[k];
    if (!Array.isArray(a) || a.length > 50 || !a.every((s) => text(s, 100))) bad();
  }
  const f = x.fields;
  if (!Array.isArray(f) || f.length > 50) bad();
  for (const e of f as unknown[]) {
    if (!isRecord(e) || Object.keys(e).sort().join(',') !== 'confidence,found,name,value') bad();
    const y = e as Record<string, unknown>;
    if (!text(y.name, 100) || typeof y.found !== 'boolean' || !(y.value === null || text(y.value)) || (y.found !== (y.value !== null))) bad();
    if (y.confidence !== null && (typeof y.confidence !== 'number' || !(y.confidence >= 0 && y.confidence <= 1))) bad();
  }
  const addressFound = (f as RecordField[]).some((e) => e.found && /address/i.test(e.name));
  // A found address field is never 'none': the address is either unverified or confirmed by the caller. 'unverified' or 'caller_confirmed' without such a field is allowed: the address may be held
  // elsewhere (the contact vault).
  if (addressFound && x.address_status === 'none') bad();
  const p = x.pii_summary;
  if (!Array.isArray(p) || p.length > 10) bad();
  for (const e of p as unknown[]) {
    if (!isRecord(e) || Object.keys(e).sort().join(',') !== 'count,type' || !text((e as Record<string, unknown>).type, 40) || !Number.isInteger((e as Record<string, unknown>).count)) bad();
  }
  const v = x.versions;
  if (!isRecord(v) || Object.keys(v).sort().join(',') !== 'model,prompt,skill' || !Object.values(v).every((s) => text(s, 100))) bad();
  // Privacy: nothing saved may look personal. Placeholders are fine; they are what the masker produces. (item_id is a hash the platform derives and is
  // restricted by its own pattern above; call_ref is a hash too. Neither can carry free text.)
  const strings: string[] = [x.category as string, ...(x.reasons as string[]), ...(x.missing_fields as string[]),
    ...(f as RecordField[]).flatMap((e) => [e.name, ...(e.value === null ? [] : [e.value])])];
  for (const s of strings) if (piiProblems(s).length > 0) bad();
}

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT',
  `CREATE TABLE IF NOT EXISTS records (
     tenant TEXT NOT NULL, seq INTEGER NOT NULL, call_ref TEXT NOT NULL, item_id TEXT NOT NULL, received_at TEXT NOT NULL, body TEXT NOT NULL,
     PRIMARY KEY (tenant, seq), UNIQUE (tenant, call_ref), UNIQUE (tenant, item_id)) STRICT`,
  "CREATE TRIGGER IF NOT EXISTS records_no_update BEFORE UPDATE ON records BEGIN SELECT RAISE(ABORT, 'no updates'); END",
];

export function createIntakeRecordStore(config: { path: string; busyTimeoutMs?: number }): IntakeRecordStore {
  if (!isRecord(config)) throw new RangeError('config must be an object');
  const { path } = config;
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024 || path.includes('\0')) throw new RangeError('path must be a database file path');
  const busy = config.busyTimeoutMs ?? 5000;
  if (!Number.isInteger(busy) || busy < 1 || busy > 60_000) throw new RangeError('busyTimeoutMs must be an integer from 1 to 60000');
  if (!nodeSupportsSqlite(process.versions.node)) throw new RangeError('this Node version does not have the required built-in SQLite');

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { timeout: busy, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false, defensive: true });
    if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    let hasMeta = true;
    try { db.prepare('SELECT 1 FROM meta LIMIT 1').get(); } catch { hasMeta = false; }
    if (hasMeta) {
      const marked = db.prepare('SELECT value FROM meta WHERE key = ?');
      const kind = marked.get('kind') as { value: string } | undefined;
      if (kind !== undefined && kind.value !== KIND) throw new Error('kind');
      if (kind === undefined && (marked.get('schema_version') as { value: string } | undefined) !== undefined) throw new Error('kind');
    }
    for (const s of SCHEMA) db.exec(s);
    const existing = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
    if (existing === undefined) {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', RECORD_SCHEMA_VERSION);
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('kind', KIND);
    } else if (existing.value !== RECORD_SCHEMA_VERSION) throw new Error('schema');
  } catch {
    try { db!.close(); } catch { /* nothing to close */ }
    throw new RangeError('the database could not be opened or has an unsupported schema');
  }
  let closed = false;
  const live = (): void => { if (closed) throw new Error('closed'); };
  const okTenant = (t: unknown): t is string => typeof t === 'string' && TENANT.test(t);

  return Object.freeze({
    put(tenant: string, record: IntakeRecord): PutResult {
      live();
      if (!okTenant(tenant)) throw new RecordRefused();
      assertSafeRecord(tenant, record);
      db.exec('BEGIN IMMEDIATE');
      try {
        const dup = db.prepare('SELECT 1 AS x FROM records WHERE tenant = ? AND (call_ref = ? OR item_id = ?)').get(tenant, record.call_ref, record.item_id);
        if (dup) { db.exec('COMMIT'); return 'duplicate' as PutResult; }
        const last = db.prepare('SELECT max(seq) AS m FROM records WHERE tenant = ?').get(tenant) as { m: number | null };
        db.prepare('INSERT INTO records (tenant, seq, call_ref, item_id, received_at, body) VALUES (?, ?, ?, ?, ?, ?)')
          .run(tenant, (last.m ?? 0) + 1, record.call_ref, record.item_id, record.received_at, JSON.stringify(record));
        db.exec('COMMIT');
        return 'new' as PutResult;
      } catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
    },
    list(tenant: string): IntakeRecord[] {
      live();
      if (!okTenant(tenant)) throw new RecordRefused();
      const rows = db.prepare('SELECT body FROM records WHERE tenant = ? ORDER BY received_at DESC, seq DESC LIMIT 500').all(tenant) as unknown as { body: string }[];
      return rows.map((r) => {
        let parsed: unknown;
        try { parsed = JSON.parse(r.body); } catch { throw new RecordRefused(); }
        assertSafeRecord(tenant, parsed);   // a row edited in the file is refused when read: fail closed
        return parsed;
      });
    },
    purge(tenant: string, callRef: string): number {
      live();
      if (!okTenant(tenant) || typeof callRef !== 'string' || !CALL_REF.test(callRef)) throw new RecordRefused();
      db.exec('BEGIN IMMEDIATE');
      try { const r = db.prepare('DELETE FROM records WHERE tenant = ? AND call_ref = ?').run(tenant, callRef); db.exec('COMMIT'); return Number(r.changes); }
      catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
    },
    close(): void { if (!closed) { closed = true; try { db.close(); } catch { /* already closed */ } } },
  });
}
