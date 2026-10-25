// SQLite reference implementation of the approval-state store (proof of concept). DEVELOPMENT ONLY.
//
// Same contract and same conformance tests as the in-memory store (approval-store.ts), but state survives a restart and a claim
// is an atomic database transaction. It uses Node's built-in `node:sqlite` (release candidate in Node 24: the API may still
// change), so it adds NO npm dependency. It is standalone: no agent, tool or pipeline uses it.
//
// What it is: a durable, single-host reference. Every write runs in `BEGIN IMMEDIATE`, which serializes writers across
// connections AND processes; a claim is a state check plus update inside that transaction, committed (WAL, synchronous=FULL)
// BEFORE the claim is returned, so the claim is durable before any tool could run.
// What it is NOT (limits that stay open):
//   - no database-level tenant isolation: SQLite has no roles and no row-level security, so isolation is only the tenant column
//     on every key and in every statement (a test checks every statement). It does NOT satisfy FND-02 / R03. Production needs a
//     database with enforced policies (PostgreSQL with forced row-level security is the candidate; D-14 is undecided).
//   - single host, single file; the API is synchronous, so each call blocks the event loop;
//   - no encryption at rest (FND-10), no retention policy (C14), no backup plan, file permissions are the operator's job;
//   - the log is hash-linked but anyone with the file can rewrite state AND log together; it is tamper-EVIDENT only against
//     partial edits, and it is not the audit store (AU1);
//   - seals are in-process identity and do not persist: after a restart a pending decision must be made again;
//   - the claim is durable but the window between a tool's write and `complete` cannot be removed: uncertain executions become
//     `in_doubt` and are settled by a read-back (see approval-store.ts).
// The database path is injected at setup and never comes from a message or a tenant. All values are bound parameters; no SQL
// text or database message is ever returned to a caller. Imports no network or process APIs.

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { isRecord, TIMESTAMP } from './contracts.ts';
import { actionDigest, approvalScopeFor, readAction, validateDecision, validateProposal } from './approval.ts';
import type { DecisionV1, ProposalV1 } from './approval.ts';
import { storeShared } from './approval-store.ts';
import type { ApprovalSnapshot, ApprovalState, ApprovalStore, StoreConfig, StoreEvent, StoreRefusal } from './approval-store.ts';
import { approverCan, isTrustedApprover } from './approver-context.ts';
import { can, isTrusted } from './execution-context.ts';
import { contentDigest, isSealedApprovalDecision, isSealedApprovalProposal } from './handoff-seal.ts';

const { refuse, iso, PROPOSAL_ID, STEP_ID, GENESIS, readOutcome, deepFreeze } = storeShared;
export const SCHEMA_VERSION = '1';

export interface SqliteStoreConfig extends StoreConfig {
  /** Database file path, or `:memory:`. Injected by the operator; never taken from a message or a tenant. */
  path: string;
  /** How long a writer waits for another connection's transaction, 1 to 60000 ms (default 5000). */
  busyTimeoutMs?: number;
}
export interface SqliteApprovalStore extends ApprovalStore {
  /** Closes the database. Operations after this fail closed. */
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

const LIVE_STATES = "('requested','approved','claimed','in_doubt')";
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT',
  `CREATE TABLE IF NOT EXISTS approvals (
     tenant TEXT NOT NULL, proposal_id TEXT NOT NULL, step_id TEXT NOT NULL, item_id TEXT NOT NULL, tool TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('requested','approved','declined','expired','claimed','in_doubt','succeeded','failed')),
     action_digest TEXT NOT NULL, proposal_digest TEXT NOT NULL, requested_by_id TEXT NOT NULL, requester_correlation_id TEXT NOT NULL,
     expires_at TEXT NOT NULL, expires_ms INTEGER NOT NULL,
     decision TEXT, decision_digest TEXT, approver_id TEXT, approver_assurance TEXT, decided_at TEXT,
     claim_id TEXT, claim_attempt INTEGER, lease_until_ms INTEGER,
     attempts INTEGER NOT NULL DEFAULT 0, outcome_status TEXT, evidence_ref TEXT, version INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (tenant, proposal_id)) STRICT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS one_live_request_per_step ON approvals (tenant, step_id) WHERE state IN ${LIVE_STATES}`,
  'CREATE TABLE IF NOT EXISTS effects (tenant TEXT NOT NULL, step_id TEXT NOT NULL, proposal_id TEXT NOT NULL, PRIMARY KEY (tenant, step_id)) STRICT',
  `CREATE TABLE IF NOT EXISTS events (
     tenant TEXT NOT NULL, proposal_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL,
     previous_digest TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY (tenant, proposal_id, seq)) STRICT`,
];

interface Row {
  tenant: string; proposal_id: string; step_id: string; item_id: string; tool: string; state: ApprovalState; action_digest: string; proposal_digest: string;
  requested_by_id: string; requester_correlation_id: string; expires_at: string; expires_ms: number;
  decision: 'approved' | 'declined' | null; decision_digest: string | null; approver_id: string | null; approver_assurance: string | null; decided_at: string | null;
  claim_id: string | null; claim_attempt: number | null; lease_until_ms: number | null; attempts: number;
  outcome_status: 'succeeded' | 'failed' | null; evidence_ref: string | null; version: number;
}

export function createSqliteApprovalStore(config: SqliteStoreConfig): SqliteApprovalStore {
  if (!isRecord(config) || typeof config.now !== 'function') throw new RangeError('config must provide a now function');
  const { path } = config;
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024 || path.includes('\0')) throw new RangeError('path must be a database file path');
  const lease = config.leaseSeconds ?? 60;
  const maxAttempts = config.maxAttempts ?? 3;
  const busy = config.busyTimeoutMs ?? 5000;
  if (!Number.isInteger(lease) || lease < 1 || lease > 3600) throw new RangeError('leaseSeconds must be an integer from 1 to 3600');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new RangeError('maxAttempts must be an integer from 1 to 10');
  if (!Number.isInteger(busy) || busy < 1 || busy > 60_000) throw new RangeError('busyTimeoutMs must be an integer from 1 to 60000');
  const tools = config.idempotentTools ?? [];
  if (!Array.isArray(tools) || !tools.every((t) => typeof t === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(t))) throw new RangeError('idempotentTools must be a list of tool names');
  if (config.newClaimId !== undefined && typeof config.newClaimId !== 'function') throw new RangeError('newClaimId must be a function');
  if (!nodeSupportsSqlite(process.versions.node)) throw new RangeError('this Node version does not have the required built-in SQLite');
  const idempotent = new Set<string>(tools);
  const clock = config.now;
  const newClaimId = config.newClaimId ?? (() => randomUUID());

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { timeout: busy, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false, defensive: true });
    if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    for (const statement of SCHEMA) db.exec(statement);
    const existing = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
    if (existing === undefined) db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
    else if (existing.value !== SCHEMA_VERSION) throw new Error('schema');
  } catch {
    try { db!.close(); } catch { /* nothing to close */ }
    throw new RangeError('the database could not be opened or has an unsupported schema');
  }
  let closed = false;

  const readNow = (): number | null => {
    try { const t: unknown = clock(); return typeof t === 'string' && TIMESTAMP.test(t) && !Number.isNaN(Date.parse(t)) ? Date.parse(t) : null; } catch { return null; }
  };
  /** One write transaction. A refusal is a normal return and is committed (settled expiry stays settled); only an exception rolls back. */
  function tx<T>(fn: () => T): T {
    if (closed) throw new Error('closed');
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
  }
  const guard = <T>(fn: () => T): Promise<T | StoreRefusal> => {
    try { return Promise.resolve(tx(fn)); } catch { return Promise.resolve(refuse('STORE_ERROR')); }
  };

  const loadRow = (tenant: string, id: string): Row | undefined => db.prepare('SELECT * FROM approvals WHERE tenant = ? AND proposal_id = ?').get(tenant, id) as Row | undefined;
  const find = (tenant: string, id: unknown): Row | undefined => (typeof id === 'string' && PROPOSAL_ID.test(id) ? loadRow(tenant, id) : undefined);

  function append(r: Row, type: StoreEvent['type'], at: number, data: Record<string, string | number> = {}): void {
    const last = db.prepare('SELECT seq, digest FROM events WHERE tenant = ? AND proposal_id = ? ORDER BY seq DESC LIMIT 1').get(r.tenant, r.proposal_id) as { seq: number; digest: string } | undefined;
    const body = { seq: (last?.seq ?? 0) + 1, type, at: iso(at), tenant: r.tenant, proposal_id: r.proposal_id, data, previous_digest: last?.digest ?? GENESIS };
    db.prepare('INSERT INTO events (tenant, proposal_id, seq, type, at, data, previous_digest, digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.tenant, r.proposal_id, body.seq, type, body.at, JSON.stringify(data), body.previous_digest, contentDigest(body));
    db.prepare('UPDATE approvals SET version = version + 1 WHERE tenant = ? AND proposal_id = ?').run(r.tenant, r.proposal_id);
    r.version++;
  }
  /** Applies the time-based transitions (expiry, lapsed lease), in the same transaction as the operation. */
  function settle(r: Row, now: number): Row {
    if ((r.state === 'requested' || r.state === 'approved') && now >= r.expires_ms) {
      db.prepare("UPDATE approvals SET state = 'expired' WHERE tenant = ? AND proposal_id = ?").run(r.tenant, r.proposal_id);
      r.state = 'expired'; append(r, 'expired', now);
    } else if (r.state === 'claimed' && r.lease_until_ms !== null && now >= r.lease_until_ms) {
      db.prepare("UPDATE approvals SET state = 'in_doubt' WHERE tenant = ? AND proposal_id = ?").run(r.tenant, r.proposal_id);
      r.state = 'in_doubt'; append(r, 'lease_lapsed', now, { attempt: r.claim_attempt ?? 0 });
    }
    return r;
  }
  function snap(r: Row): ApprovalSnapshot {
    return deepFreeze({
      proposal_id: r.proposal_id, state: r.state, item_id: r.item_id, step_id: r.step_id, tool: r.tool, action_digest: r.action_digest, expires_at: r.expires_at, requested_by_id: r.requested_by_id,
      ...(r.decision ? { decision: { decision: r.decision, approver_id: r.approver_id as string, assurance: r.approver_assurance as string, decided_at: r.decided_at as string } } : {}),
      ...(r.claim_id !== null && (r.state === 'claimed' || r.state === 'in_doubt') ? { claim: { attempt: r.claim_attempt as number, lease_until: iso(r.lease_until_ms as number) } } : {}),
      ...(r.outcome_status ? { outcome: { status: r.outcome_status, ...(r.evidence_ref !== null ? { evidence_ref: r.evidence_ref } : {}) } } : {}),
      attempts: r.attempts, version: r.version,
    });
  }
  function agentTenant(ctx: unknown, agent: 'processing' | 'quality-control' | null, scope: string | null): { tenant: string } | StoreRefusal {
    if (!isTrusted(ctx)) return refuse('CONTEXT_NOT_TRUSTED');
    if (agent !== null && (ctx.agent !== agent || !can(ctx, scope))) return refuse('STORE_NOT_PERMITTED');
    return { tenant: ctx.workspace_id };
  }
  function finishWith(r: Row, o: { status: 'succeeded' | 'failed'; evidence_ref?: string }, now: number, via: 'complete' | 'resolve'): StoreRefusal | null {
    if (o.status === 'succeeded') {
      const done = db.prepare('SELECT 1 AS x FROM effects WHERE tenant = ? AND step_id = ?').get(r.tenant, r.step_id);
      if (done) return refuse('EFFECT_ALREADY_DONE');
      db.prepare('INSERT INTO effects (tenant, step_id, proposal_id) VALUES (?, ?, ?)').run(r.tenant, r.step_id, r.proposal_id);
    }
    db.prepare('UPDATE approvals SET state = ?, outcome_status = ?, evidence_ref = ? WHERE tenant = ? AND proposal_id = ?')
      .run(o.status, o.status, o.evidence_ref ?? null, r.tenant, r.proposal_id);
    r.state = o.status; r.outcome_status = o.status; r.evidence_ref = o.evidence_ref ?? null;
    append(r, o.status, now, { via, attempt: r.claim_attempt ?? 0 });
    return null;
  }

  const store: SqliteApprovalStore = {
    leaseSeconds: lease,
    putProposal: (ctx, proposalIn) => guard(() => {
      const a = agentTenant(ctx, 'processing', 'processing:run');
      if ('ok' in a) return a;
      let copy: unknown; try { copy = structuredClone(proposalIn); } catch { return refuse('STORE_INVALID'); }
      if (!isSealedApprovalProposal(proposalIn, copy)) return refuse('APPROVAL_NOT_TRUSTED');
      if (validateProposal(copy).length > 0) return refuse('PROPOSAL_INVALID');
      const p = copy as ProposalV1;
      if (p.workspace_id !== a.tenant) return refuse('TENANT_MISMATCH');
      const now = readNow();
      if (now === null) return refuse('STORE_ERROR');
      const existing = loadRow(a.tenant, p.proposal_id);
      if (existing) {
        settle(existing, now);
        return existing.proposal_digest === contentDigest(p) ? { ok: true as const, created: false, snapshot: snap(existing) } : refuse('PROPOSAL_CONFLICT');
      }
      if (now >= Date.parse(p.expires_at)) return refuse('PROPOSAL_EXPIRED');
      if (db.prepare('SELECT 1 AS x FROM effects WHERE tenant = ? AND step_id = ?').get(a.tenant, p.step_id)) return refuse('EFFECT_ALREADY_DONE');
      // The one live request for this step may have lapsed without anyone touching it: settle it before judging.
      const liveRow = db.prepare(`SELECT * FROM approvals WHERE tenant = ? AND step_id = ? AND state IN ${LIVE_STATES}`).get(a.tenant, p.step_id) as Row | undefined;
      if (liveRow) { settle(liveRow, now); if (['requested', 'approved', 'claimed', 'in_doubt'].includes(liveRow.state)) return refuse('ACTIVE_PROPOSAL_EXISTS'); }
      db.prepare(`INSERT INTO approvals (tenant, proposal_id, step_id, item_id, tool, state, action_digest, proposal_digest, requested_by_id, requester_correlation_id, expires_at, expires_ms)
                  VALUES (?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?)`)
        .run(a.tenant, p.proposal_id, p.step_id, p.item_id, p.tool, p.action_digest, contentDigest(p), p.requested_by.id, p.requester_correlation_id, p.expires_at, Date.parse(p.expires_at));
      const row = loadRow(a.tenant, p.proposal_id) as Row;
      append(row, 'requested', now, { expires: p.expires_at });
      return { ok: true as const, created: true, snapshot: snap(row) };
    }) as never,

    recordDecision: (ctx, decisionIn) => guard(() => {
      if (!isTrustedApprover(ctx)) return refuse(isTrusted(ctx) ? 'STORE_NOT_PERMITTED' : 'CONTEXT_NOT_TRUSTED');
      let copy: unknown; try { copy = structuredClone(decisionIn); } catch { return refuse('STORE_INVALID'); }
      if (!isSealedApprovalDecision(decisionIn, copy)) return refuse('APPROVAL_NOT_TRUSTED');
      if (validateDecision(copy).length > 0) return refuse('DECISION_INVALID');
      const d = copy as DecisionV1;
      if (d.workspace_id !== ctx.workspace_id) return refuse('TENANT_MISMATCH');
      const found = find(ctx.workspace_id, d.proposal_id);
      if (!found) return refuse('STORE_NOT_FOUND');
      const now = readNow();
      if (now === null) return refuse('STORE_ERROR');
      const r = settle(found, now);
      if (d.approver.id !== ctx.approver.id || d.approver_correlation_id !== ctx.correlation_id) return refuse('STORE_NOT_PERMITTED');
      if (ctx.proposal_id !== undefined && ctx.proposal_id !== r.proposal_id) return refuse('ACTION_MISMATCH');
      if (!approverCan(ctx, approvalScopeFor(r.tool))) return refuse('STORE_NOT_PERMITTED');
      if (now >= Date.parse(ctx.session_expires_at)) return refuse('APPROVER_SESSION_EXPIRED');
      if (d.action_digest !== r.action_digest || d.expires_at !== r.expires_at) return refuse('ACTION_MISMATCH');
      if (d.approver.id === r.requested_by_id || d.approver_correlation_id === r.requester_correlation_id) return refuse('SELF_APPROVAL');
      if (r.decision !== null) return r.decision_digest === contentDigest(d) ? { ok: true as const, snapshot: snap(r) } : refuse('DECISION_CONFLICT');
      if (r.state === 'expired') return refuse('PROPOSAL_EXPIRED');
      if (r.state !== 'requested') return refuse('DECISION_CONFLICT');
      const next = d.decision === 'approved' ? 'approved' : 'declined';
      db.prepare('UPDATE approvals SET state = ?, decision = ?, decision_digest = ?, approver_id = ?, approver_assurance = ?, decided_at = ? WHERE tenant = ? AND proposal_id = ?')
        .run(next, d.decision, contentDigest(d), d.approver.id, d.approver_assurance, d.decided_at, r.tenant, r.proposal_id);
      r.state = next; r.decision = d.decision; r.decision_digest = contentDigest(d); r.approver_id = d.approver.id; r.approver_assurance = d.approver_assurance; r.decided_at = d.decided_at;
      append(r, next, now, { reason: d.reason_code, assurance: d.approver_assurance });
      return { ok: true as const, snapshot: snap(r) };
    }) as never,

    claim: (ctx, proposalId, presented) => guard(() => {
      const a = agentTenant(ctx, 'processing', 'processing:run');
      if ('ok' in a) return a;
      const found = find(a.tenant, proposalId);
      if (!found) return refuse('STORE_NOT_FOUND');
      const now = readNow();
      if (now === null) return refuse('STORE_ERROR');
      const r = settle(found, now);
      const act = readAction(presented);
      if (!act || act.item_id !== r.item_id || act.step_id !== r.step_id || act.tool !== r.tool || actionDigest({ workspace_id: a.tenant, ...act }) !== r.action_digest) return refuse('ACTION_MISMATCH');
      if (r.state === 'claimed') return refuse('CLAIM_CONFLICT');
      if (r.state === 'succeeded') return refuse('EFFECT_ALREADY_DONE');
      if (r.state === 'expired') return refuse('PROPOSAL_EXPIRED');
      if (r.state === 'in_doubt') {
        if (!idempotent.has(r.tool)) return refuse('IN_DOUBT');
        if (r.attempts >= maxAttempts) return refuse('RETRY_LIMIT');
        if (now >= r.expires_ms) return refuse('PROPOSAL_EXPIRED');
      } else if (r.state !== 'approved') return refuse('NOT_APPROVED');
      const claimId = newClaimId();
      if (typeof claimId !== 'string' || !/^[A-Za-z0-9_.:-]{8,64}$/.test(claimId)) return refuse('STORE_ERROR');
      const attempt = r.attempts + 1;
      const leaseUntil = now + lease * 1000;
      db.prepare("UPDATE approvals SET state = 'claimed', claim_id = ?, claim_attempt = ?, lease_until_ms = ?, attempts = ? WHERE tenant = ? AND proposal_id = ?")
        .run(claimId, attempt, leaseUntil, attempt, r.tenant, r.proposal_id);
      r.attempts = attempt;
      append(r, 'claimed', now, { attempt });
      return { ok: true as const, grant: deepFreeze({ proposal_id: r.proposal_id, step_id: r.step_id, claim_id: claimId, attempt, lease_until: iso(leaseUntil) }) };
    }) as never,

    complete: (ctx, proposalId, claimId, outcome) => guard(() => {
      const a = agentTenant(ctx, 'processing', 'processing:run');
      if ('ok' in a) return a;
      const found = find(a.tenant, proposalId);
      if (!found) return refuse('STORE_NOT_FOUND');
      const o = readOutcome(outcome);
      if (!o || typeof claimId !== 'string') return refuse('STORE_INVALID');
      const now = readNow();
      if (now === null) return refuse('STORE_ERROR');
      const r = settle(found, now);
      if ((r.state !== 'claimed' && r.state !== 'in_doubt') || r.claim_id === null || r.claim_id !== claimId) return refuse('STALE_CLAIM');
      return finishWith(r, o, now, 'complete') ?? { ok: true as const, snapshot: snap(r) };
    }) as never,

    resolve: (ctx, proposalId, outcome) => guard(() => {
      const a = agentTenant(ctx, 'quality-control', 'quality-control:run');
      if ('ok' in a) return a;
      const found = find(a.tenant, proposalId);
      if (!found) return refuse('STORE_NOT_FOUND');
      const o = readOutcome(outcome);
      if (!o) return refuse('STORE_INVALID');
      const now = readNow();
      if (now === null) return refuse('STORE_ERROR');
      const r = settle(found, now);
      if (r.state !== 'in_doubt') return refuse('NOT_APPROVED');
      return finishWith(r, o, now, 'resolve') ?? { ok: true as const, snapshot: snap(r) };
    }) as never,

    get: (ctx, proposalId) => guard(() => {
      const a = agentTenant(ctx, null, null);
      if ('ok' in a) return a;
      const found = find(a.tenant, proposalId);
      if (!found) return refuse('STORE_NOT_FOUND');
      const now = readNow();
      if (now === null) return refuse('STORE_ERROR');
      return { ok: true as const, snapshot: snap(settle(found, now)) };
    }) as never,

    findByStep: (ctx, stepId) => guard(() => {
      const a = agentTenant(ctx, null, null);
      if ('ok' in a) return a;
      if (typeof stepId !== 'string' || !STEP_ID.test(stepId)) return refuse('STORE_NOT_FOUND');
      const now = readNow();
      if (now === null) return refuse('STORE_ERROR');
      // The one live request may have lapsed untouched: settle it first, then prefer it if it is still open.
      const liveRow = db.prepare(`SELECT * FROM approvals WHERE tenant = ? AND step_id = ? AND state IN ${LIVE_STATES}`).get(a.tenant, stepId) as Row | undefined;
      if (liveRow) { settle(liveRow, now); if (['requested', 'approved', 'claimed', 'in_doubt'].includes(liveRow.state)) return { ok: true as const, snapshot: snap(liveRow) }; }
      // Otherwise the newest request for this step (insertion order), whatever its end state.
      const latest = db.prepare('SELECT * FROM approvals WHERE tenant = ? AND step_id = ? ORDER BY rowid DESC LIMIT 1').get(a.tenant, stepId) as Row | undefined;
      if (!latest) return refuse('STORE_NOT_FOUND');
      return { ok: true as const, snapshot: snap(settle(latest, now)) };
    }) as never,

    events: (ctx, proposalId) => guard(() => {
      const a = agentTenant(ctx, null, null);
      if ('ok' in a) return a;
      const found = find(a.tenant, proposalId);
      if (!found) return refuse('STORE_NOT_FOUND');
      const now = readNow();
      if (now === null) return refuse('STORE_ERROR');
      settle(found, now);
      const rows = db.prepare('SELECT seq, type, at, tenant, proposal_id, data, previous_digest, digest FROM events WHERE tenant = ? AND proposal_id = ? ORDER BY seq')
        .all(a.tenant, found.proposal_id) as Array<{ seq: number; type: StoreEvent['type']; at: string; tenant: string; proposal_id: string; data: string; previous_digest: string; digest: string }>;
      return { ok: true as const, events: rows.map((e) => deepFreeze({ seq: e.seq, type: e.type, at: e.at, tenant: e.tenant, proposal_id: e.proposal_id, data: JSON.parse(e.data), previous_digest: e.previous_digest, digest: e.digest })) as readonly StoreEvent[] };
    }) as never,

    close() { if (!closed) { closed = true; try { db.close(); } catch { /* already closed */ } } },
    settings() {
      const j = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      const s = db.prepare('PRAGMA synchronous').get() as { synchronous: number };
      const f = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
      return { journal_mode: j.journal_mode, synchronous: s.synchronous, foreign_keys: f.foreign_keys };
    },
  };
  return Object.freeze(store);
}
