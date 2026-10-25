// SQLite implementation of the Reporting ledger (proof of concept). DEVELOPMENT ONLY.
//
// The same ReportingLedger contract and the same conformance tests as the in-memory ledger (reporting-ledger.ts), but the history survives
// a restart and every `record` is ONE database transaction. It uses Node's built-in `node:sqlite` (release candidate in Node 24), so it adds NO
// npm dependency. Nothing imports it except the tests: no agent, entry or pipeline is wired to it yet.
//
// How the contract is kept:
//   - Every write runs in `BEGIN IMMEDIATE`, which serializes writers across connections AND processes. The duplicate check, the attempt count,
//     the head read, the observation insert and the tally update are all inside that one transaction, committed (WAL, synchronous=FULL) before
//     `record` returns. A crash or an error rolls the whole thing back, so `submitted = observations + duplicates + refused` cannot drift.
//   - UNIQUE (tenant, candidate_digest) and UNIQUE (tenant, item_id, attempt) back the duplicate and attempt rules even if code were wrong;
//     triggers refuse UPDATE and DELETE on the observation table, so the log is append-only at the database level too.
//   - `snapshot` reads the log, the tallies and the head inside one read transaction (one WAL snapshot), so they always agree with each other.
//   - Observations are hashed exactly as in the in-memory ledger (same body, same digest), so a log means the same in either store.
// What it is NOT (limits that stay open, as for the approval store):
//   - no database-level tenant isolation (SQLite has no roles or row-level security): isolation is the tenant column on every key and in every
//     statement (a test checks every statement). It does NOT satisfy FND-02 / R03; production needs enforced policies (D-14 undecided);
//   - single host, single file; the API is synchronous, so each call blocks the event loop;
//   - no encryption at rest (FND-10), no retention policy (C14), no backup plan; file permissions are the operator's job;
//   - tamper-EVIDENT only: anyone with the file can drop the triggers and rewrite rows, tallies and hashes together. A partial edit is caught
//     by `snapshotIsConsistent` (and Reporting then fails closed); it is not the audit store (AU1);
//   - the ledger holds ids, digests, fixed words and times only (never envelope payloads); seals do not persist;
//   - the database path is injected at setup and never comes from a message or a tenant. All values are bound parameters; no SQL text or database
//     message is ever returned. Open it on its OWN file: it refuses a file that another kind of store already marked.
// Imports only node:sqlite, contracts.ts, handoff-seal.ts (a hash) and reporting-ledger.ts. No network, process or clock APIs.

import { DatabaseSync } from 'node:sqlite';
import { isRecord } from './contracts.ts';
import { contentDigest } from './handoff-seal.ts';
import { assertDraft, DEFAULT_MAX_ATTEMPTS, GENESIS_DIGEST, OUTCOME_NAMES } from './reporting-ledger.ts';
import type { LedgerSnapshot, Observation, OutcomeName, RecordResult, ReportingLedger } from './reporting-ledger.ts';

export const LEDGER_SCHEMA_VERSION = '1';
const KIND = 'reporting-ledger';
const CODE = /^[A-Z][A-Z_]{0,39}$/;

export interface SqliteReportingLedgerConfig {
  /** Database file path, or `:memory:`. Injected by the operator; never taken from a message or a tenant. */
  path: string;
  /** Most attempts kept per item, 1 to 1000 (default 20). */
  maxAttempts?: number;
  /** How long a writer waits for another connection's transaction, 1 to 60000 ms (default 5000). */
  busyTimeoutMs?: number;
}
export interface SqliteReportingLedger extends ReportingLedger {
  /** Closes the database. Operations after this throw. */
  close(): void;
  /** The durability settings this connection is actually using. */
  settings(): { journal_mode: string; synchronous: number; foreign_keys: number };
}

/** True when the running Node has the release-candidate `node:sqlite` (24.15 or newer on the 24 line, or a later major). */
export function nodeSupportsSqlite(version: unknown): boolean {
  if (typeof version !== 'string') return false;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 24 || (major === 24 && minor >= 15);
}

const OUTCOME_LIST = OUTCOME_NAMES.map((o) => `'${o}'`).join(',');
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT',
  `CREATE TABLE IF NOT EXISTS observations (
     tenant TEXT NOT NULL, seq INTEGER NOT NULL, item_id TEXT NOT NULL, attempt INTEGER NOT NULL, candidate_digest TEXT NOT NULL,
     outcome TEXT NOT NULL CHECK (outcome IN (${OUTCOME_LIST})), checks TEXT NOT NULL, broken TEXT NOT NULL,
     intake_correlation_id TEXT NOT NULL, processing_correlation_id TEXT NOT NULL, qc_correlation_id TEXT NOT NULL,
     verdict_at TEXT NOT NULL, recorded_at TEXT NOT NULL, previous_digest TEXT NOT NULL, digest TEXT NOT NULL,
     PRIMARY KEY (tenant, seq), UNIQUE (tenant, candidate_digest), UNIQUE (tenant, item_id, attempt)) STRICT`,
  'CREATE TABLE IF NOT EXISTS tallies (tenant TEXT PRIMARY KEY, submitted INTEGER NOT NULL DEFAULT 0, duplicates INTEGER NOT NULL DEFAULT 0, refused INTEGER NOT NULL DEFAULT 0) STRICT',
  'CREATE TABLE IF NOT EXISTS refusals (tenant TEXT NOT NULL, code TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (tenant, code)) STRICT',
  "CREATE TRIGGER IF NOT EXISTS observations_no_update BEFORE UPDATE ON observations BEGIN SELECT RAISE(ABORT, 'append-only'); END",
  "CREATE TRIGGER IF NOT EXISTS observations_no_delete BEFORE DELETE ON observations BEGIN SELECT RAISE(ABORT, 'append-only'); END",
];

interface Row {
  seq: number; item_id: string; attempt: number; candidate_digest: string; outcome: OutcomeName; checks: string; broken: string;
  intake_correlation_id: string; processing_correlation_id: string; qc_correlation_id: string; verdict_at: string; recorded_at: string; previous_digest: string; digest: string;
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const c of Object.values(v as Record<string, unknown>)) deepFreeze(c); }
  return v;
}
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;

export function createSqliteReportingLedger(config: SqliteReportingLedgerConfig): SqliteReportingLedger {
  if (!isRecord(config)) throw new RangeError('config must be an object');
  const { path } = config;
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024 || path.includes('\0')) throw new RangeError('path must be a database file path');
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const busy = config.busyTimeoutMs ?? 5000;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 1000) throw new RangeError('maxAttempts must be an integer from 1 to 1000');
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
      if (kind === undefined && (marked.get('schema_version') as { value: string } | undefined) !== undefined) throw new Error('kind');   // another store's file
    }
    for (const statement of SCHEMA) db.exec(statement);
    const existing = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
    if (existing === undefined) {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', LEDGER_SCHEMA_VERSION);
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('kind', KIND);
    } else if (existing.value !== LEDGER_SCHEMA_VERSION) throw new Error('schema');
  } catch {
    try { db!.close(); } catch { /* nothing to close */ }
    throw new RangeError('the database could not be opened or has an unsupported schema');
  }
  let closed = false;

  /** One write transaction. A refusal is a normal return and is committed; only an exception rolls back. */
  function tx<T>(fn: () => T): T {
    if (closed) throw new Error('closed');
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
  }

  function bump(tenant: string, what: 'duplicates' | 'refused' | null, code?: string): void {
    db.prepare('INSERT INTO tallies (tenant, submitted) VALUES (?, 1) ON CONFLICT (tenant) DO UPDATE SET submitted = submitted + 1').run(tenant);
    if (what === 'duplicates') db.prepare('UPDATE tallies SET duplicates = duplicates + 1 WHERE tenant = ?').run(tenant);
    if (what === 'refused') {
      db.prepare('UPDATE tallies SET refused = refused + 1 WHERE tenant = ?').run(tenant);
      db.prepare('INSERT INTO refusals (tenant, code, n) VALUES (?, ?, 1) ON CONFLICT (tenant, code) DO UPDATE SET n = n + 1').run(tenant, code as string);
    }
  }
  function toObservation(tenant: string, r: Row): Observation {
    return deepFreeze({
      item_id: r.item_id, candidate_digest: r.candidate_digest, outcome: r.outcome, checks: JSON.parse(r.checks), broken: JSON.parse(r.broken),
      intake_correlation_id: r.intake_correlation_id, processing_correlation_id: r.processing_correlation_id, qc_correlation_id: r.qc_correlation_id,
      verdict_at: r.verdict_at, recorded_at: r.recorded_at, workspace_id: tenant, seq: r.seq, attempt: r.attempt, previous_digest: r.previous_digest, digest: r.digest,
    }) as Observation;
  }

  const ledger: SqliteReportingLedger = {
    record(tenant, disposition): RecordResult {
      // Everything that can be judged without the database is judged first, so a malformed call never opens a transaction.
      if (!isText(tenant) || !isRecord(disposition)) throw new TypeError('record');
      if (disposition.kind === 'refused') {
        const code = disposition.code;
        if (typeof code !== 'string' || !CODE.test(code)) throw new TypeError('record');
        return tx(() => { bump(tenant, 'refused', code); return { kind: 'refused' as const, code }; });
      }
      if (disposition.kind !== 'observation') throw new TypeError('record');
      const draft: unknown = disposition.draft;
      assertDraft(draft);
      return tx((): RecordResult => {
        if (db.prepare('SELECT 1 AS x FROM observations WHERE tenant = ? AND candidate_digest = ?').get(tenant, draft.candidate_digest)) { bump(tenant, 'duplicates'); return { kind: 'duplicate' }; }
        const n = db.prepare('SELECT count(*) AS n FROM observations WHERE tenant = ? AND item_id = ?').get(tenant, draft.item_id) as { n: number };
        const attempt = n.n + 1;
        if (attempt > maxAttempts) { bump(tenant, 'refused', 'ATTEMPT_LIMIT'); return { kind: 'refused', code: 'ATTEMPT_LIMIT' }; }
        const last = db.prepare('SELECT seq, digest FROM observations WHERE tenant = ? ORDER BY seq DESC LIMIT 1').get(tenant) as { seq: number; digest: string } | undefined;
        const body = {
          ...draft, checks: draft.checks.map((c) => ({ check: c.check, reason: c.reason })), broken: [...draft.broken],
          workspace_id: tenant, seq: (last?.seq ?? 0) + 1, attempt, previous_digest: last?.digest ?? GENESIS_DIGEST,
        };
        const digest = contentDigest(body);
        db.prepare(`INSERT INTO observations (tenant, seq, item_id, attempt, candidate_digest, outcome, checks, broken, intake_correlation_id, processing_correlation_id,
                      qc_correlation_id, verdict_at, recorded_at, previous_digest, digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(tenant, body.seq, body.item_id, attempt, body.candidate_digest, body.outcome, JSON.stringify(body.checks), JSON.stringify(body.broken),
            body.intake_correlation_id, body.processing_correlation_id, body.qc_correlation_id, body.verdict_at, body.recorded_at, body.previous_digest, digest);
        bump(tenant, null);
        return { kind: 'appended', observation: deepFreeze({ ...body, digest }) as Observation };
      });
    },

    snapshot(tenant): LedgerSnapshot {
      if (!isText(tenant)) throw new TypeError('snapshot');
      if (closed) throw new Error('closed');
      db.exec('BEGIN');                                   // one read transaction: the log, the tallies and the head come from one snapshot
      try {
        const rows = db.prepare(`SELECT seq, item_id, attempt, candidate_digest, outcome, checks, broken, intake_correlation_id, processing_correlation_id, qc_correlation_id,
                                   verdict_at, recorded_at, previous_digest, digest FROM observations WHERE tenant = ? ORDER BY seq`).all(tenant) as unknown as Row[];
        const t = db.prepare('SELECT submitted, duplicates, refused FROM tallies WHERE tenant = ?').get(tenant) as { submitted: number; duplicates: number; refused: number } | undefined;
        const refusals = db.prepare('SELECT code, n FROM refusals WHERE tenant = ? ORDER BY code').all(tenant) as Array<{ code: string; n: number }>;
        db.exec('COMMIT');
        const log = rows.map((r) => toObservation(tenant, r));
        const last = log.length === 0 ? undefined : log[log.length - 1];
        return {
          log, tally: { submitted: t?.submitted ?? 0, duplicates: t?.duplicates ?? 0, refused: t?.refused ?? 0, refusals: new Map(refusals.map((r) => [r.code, r.n])) },
          head: { seq: log.length, digest: last === undefined ? GENESIS_DIGEST : last.digest },
        };
      } catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
    },

    close() { if (!closed) { closed = true; try { db.close(); } catch { /* already closed */ } } },
    settings() {
      const j = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      const s = db.prepare('PRAGMA synchronous').get() as { synchronous: number };
      const f = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
      return { journal_mode: j.journal_mode, synchronous: s.synchronous, foreign_keys: f.foreign_keys };
    },
  };
  return Object.freeze(ledger);
}

