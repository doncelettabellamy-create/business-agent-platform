// Tests for the SQLite Reporting ledger (DEVELOPMENT ONLY): the shared ledger conformance suite on in-memory, file and :memory: databases,
// plus restart, replay, multi-process races, tenant separation, tampering, atomic rollback and safe failure.
// Temporary database files only. Mock contexts and tools, synthetic data. No network, no key; no agent, entry or pipeline uses the ledger except through
// the injected-ledger option under test.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteReportingLedger, nodeSupportsSqlite } from '../src/reporting-ledger-sqlite.ts';
import type { SqliteReportingLedger, SqliteReportingLedgerConfig } from '../src/reporting-ledger-sqlite.ts';
import { createInMemoryReportingLedger, GENESIS_DIGEST, snapshotIsConsistent, verifyObservationLog } from '../src/reporting-ledger.ts';
import { createSqliteApprovalStore } from '../src/approval-store-sqlite.ts';
import { draftOf, ledgerConformance, obs, refusal, SEQUENCE, TA, TB } from './helpers/ledger-conformance.ts';
import { attempt, CANARY, dentalMessage, envelopeFor, okSubmit, plumbingMessage, PW, DW, reportOf, reporting, rptCtx, T1, T2 } from './helpers/reporting-chains.ts';

const dir = mkdtempSync(join(tmpdir(), 'reporting-ledger-sqlite-'));
const opened: SqliteReportingLedger[] = [];
let counter = 0;
const newFile = () => join(dir, `ledger-${++counter}.db`);
function make(config: Partial<SqliteReportingLedgerConfig> = {}, file = newFile()): SqliteReportingLedger {
  const l = createSqliteReportingLedger({ path: file, ...config });
  opened.push(l);
  return l;
}
after(() => { for (const l of opened) l.close(); rmSync(dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------- the same contract as the in-memory ledger
ledgerConformance('memory ledger', (o) => createInMemoryReportingLedger(o));
ledgerConformance('sqlite ledger (file)', (o) => make(o));
ledgerConformance('sqlite ledger (memory)', (o) => { const l = createSqliteReportingLedger({ path: ':memory:', ...o }); opened.push(l); return l; });

test('the same calls give the same log, digests, head and tallies in memory and in SQLite', () => {
  const m = createInMemoryReportingLedger({ maxAttempts: 2 }); const s = make({ maxAttempts: 2 });
  for (const [tenant, d] of SEQUENCE) assert.deepEqual(s.record(tenant, d), m.record(tenant, d));
  for (const tenant of [TA, TB]) assert.deepEqual(s.snapshot(tenant), m.snapshot(tenant));
  assert.equal(s.snapshot(TA).log.length, 3);
});

// ---------------------------------------------------------------- durability settings
test('sqlite ledger: a file database runs in WAL mode with full synchronous commits and foreign keys on', () => {
  const l = make();
  assert.deepEqual(l.settings(), { journal_mode: 'wal', synchronous: 2, foreign_keys: 1 });
});

// ---------------------------------------------------------------- restart
test('restart: the log, the tallies, duplicates and the attempt count survive, and the chain continues from the stored head', () => {
  const file = newFile();
  const first = make({ maxAttempts: 3 }, file);
  for (const [tenant, d] of SEQUENCE) first.record(tenant, d);
  const beforeA = first.snapshot(TA); const beforeB = first.snapshot(TB);
  first.close();
  const second = make({ maxAttempts: 3 }, file);
  assert.deepEqual(second.snapshot(TA), beforeA);
  assert.deepEqual(second.snapshot(TB), beforeB);
  assert.deepEqual(second.record(TA, obs(draftOf('d1'))), { kind: 'duplicate' });                 // replay protection survived
  assert.equal(second.record(TA, obs(draftOf('d4'))).kind, 'appended');                          // attempt 3 of item a
  assert.deepEqual(second.record(TA, obs(draftOf('d5'))), { kind: 'refused', code: 'ATTEMPT_LIMIT' });   // the cap counts the earlier attempts
  const after_ = second.snapshot(TA);
  assert.equal(after_.log.length, 4);
  assert.equal(after_.log[3].previous_digest, beforeA.log[2].digest);
  assert.equal(after_.log[3].attempt, 3);
  assert.equal(verifyObservationLog(after_.log), true);
  assert.equal(snapshotIsConsistent(after_), true);
  assert.deepEqual(second.snapshot(TB), beforeB, 'the other tenant is untouched');
});

test('restart: an empty database reopens empty and a half-used one stays consistent after many restarts', () => {
  const file = newFile();
  make({}, file).close();
  for (let i = 0; i < 5; i++) {
    const l = make({}, file);
    if (i === 0) assert.equal(l.snapshot(TA).log.length, 0);
    l.record(TA, obs(draftOf(`r${i}`, `wi-${String(i).repeat(12)}`)));
    l.record(TA, refusal('TRIPLE_INVALID'));
    l.close();
  }
  const s = make({}, file).snapshot(TA);
  assert.deepEqual([s.log.length, s.tally.submitted, s.tally.refused, s.head.seq], [5, 10, 5, 5]);
  assert.equal(snapshotIsConsistent(s), true);
});

// ---------------------------------------------------------------- Reporting on the SQLite ledger
test('Reporting over SQLite: the report, statuses and history match the in-memory ledger, and a restart changes nothing', async () => {
  const env = await envelopeFor(PW, plumbingMessage('evt-synthetic-sa'));
  const a1 = await attempt(PW, env, { at: T1, down: true });
  const a2 = await attempt(PW, env, { at: T2 });
  const other = await envelopeFor(PW, plumbingMessage('evt-synthetic-sb'));
  const b1 = await attempt(PW, other, { at: T1 });
  const ctx = await rptCtx();
  const mem = reporting({ ledger: createInMemoryReportingLedger() });
  okSubmit(await mem.submit(ctx, [a1, b1, a2, a1, 'junk']));
  const expected = reportOf(await mem.report(ctx));

  const file = newFile();
  const l1 = make({}, file);
  const r1 = reporting({ ledger: l1 });
  const s = okSubmit(await r1.submit(ctx, [a1, b1, a2, a1, 'junk']));
  assert.deepEqual([s.accepted, s.repeat_attempts, s.duplicates, s.refused], [2, 1, 1, 1]);
  assert.deepEqual(reportOf(await r1.report(ctx)), expected);
  l1.close();

  const l2 = make({}, file);
  const r2 = reporting({ ledger: l2 });
  assert.deepEqual(reportOf(await r2.report(ctx)), expected, 'after a restart');
  const again = okSubmit(await r2.submit(ctx, [a1, a2, b1]));
  assert.deepEqual([again.duplicates, again.accepted, again.repeat_attempts], [3, 0, 0], 'replay after a restart is still a duplicate');
  const rep = reportOf(await r2.report(ctx));
  assert.deepEqual(rep.statuses, [
    { item_id: env.item_id, first: 'escalate', current: 'pass', attempts: 2 }, { item_id: other.item_id, first: 'pass', current: 'pass', attempts: 1 },
  ]);
  assert.deepEqual([rep.counts.submitted, rep.counts.duplicates, rep.counts.refused, rep.history.observations], [expected.counts.submitted + 3, 4, 1, 3]);
  const h: any = await r2.history(ctx);
  assert.deepEqual([h.ok, h.verified, h.observations.length], [true, true, 3]);
  // A new attempt after the restart continues the same item's history.
  const a3 = await attempt(PW, env, { at: '2026-10-25T18:03:00Z', down: true });
  const s3 = okSubmit(await r2.submit(ctx, [a3]));
  assert.deepEqual([s3.repeat_attempts, s3.accepted], [1, 0]);
  assert.deepEqual(reportOf(await r2.report(ctx)).statuses[0], { item_id: env.item_id, first: 'escalate', current: 'escalate', attempts: 3 });
});

test('Reporting over SQLite: two tenants share one file and see only their own history', async () => {
  const file = newFile();
  const l = make({}, file);
  const r = reporting({ ledger: l });
  const pctx = await rptCtx(PW); const dctx = await rptCtx(DW, 'corr-ledger-rpt-d');
  const p = await attempt(PW, await envelopeFor(PW, plumbingMessage('evt-synthetic-sc')), { at: T1 });
  const d = await attempt(DW, await envelopeFor(DW, dentalMessage), { at: T1, down: true });
  okSubmit(await r.submit(pctx, [p])); okSubmit(await r.submit(dctx, [d]));
  const foreign = okSubmit(await r.submit(pctx, [d]));
  assert.deepEqual([foreign.accepted, foreign.refused], [0, 1]);
  const prep = reportOf(await r.report(pctx)); const drep = reportOf(await r.report(dctx));
  assert.deepEqual([prep.current.pass, drep.current.escalate, prep.refusals.length, drep.refusals.length], [1, 1, 1, 0]);
  const ph: any = await r.history(pctx);
  assert.ok(ph.observations.every((o: any) => o.workspace_id === PW) && !JSON.stringify(ph).includes(DW));
  l.close();
  const raw = new DatabaseSync(file);
  const tenants = (t: string) => (raw.prepare(`SELECT DISTINCT tenant FROM ${t}`).all() as Array<{ tenant: string }>).map((x) => x.tenant).sort();
  assert.deepEqual([tenants('observations'), tenants('tallies'), tenants('refusals')], [[DW, PW], [DW, PW], [PW]]);
  raw.close();
});

// ---------------------------------------------------------------- races between separate processes
function worker(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL('./helpers/ledger-worker.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (c) => { try { resolve(JSON.parse(out.trim().split('\n').pop() as string)); } catch { reject(new Error(`worker failed (${c}): ${err.slice(0, 300)}`)); } });
  });
}

test('races: six processes recording the same candidate produce exactly one observation and five duplicates', async () => {
  const file = newFile();
  const l = make({}, file);
  const results = await Promise.all(Array.from({ length: 6 }, () => worker(['record', file, TA, 'same-digest', 'wi-aaaaaaaaaaaa'])));
  assert.equal(results.filter((r) => r.kind === 'appended').length, 1, JSON.stringify(results));
  assert.equal(results.filter((r) => r.kind === 'duplicate').length, 5);
  const s = l.snapshot(TA);
  assert.deepEqual([s.log.length, s.tally.submitted, s.tally.duplicates, s.tally.refused], [1, 6, 5, 0]);
  assert.equal(snapshotIsConsistent(s), true);
});

test('races: eight processes adding attempts for one item stop at the cap, with distinct attempt numbers and an unbroken chain', async () => {
  const file = newFile();
  const l = make({ maxAttempts: 3 }, file);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => worker(['record', file, TA, `digest-${i}`, 'wi-aaaaaaaaaaaa', '3'])));
  const appended = results.filter((r) => r.kind === 'appended');
  assert.equal(appended.length, 3, JSON.stringify(results));
  assert.deepEqual(appended.map((r) => r.attempt).sort(), [1, 2, 3]);
  for (const r of results.filter((x) => x.kind !== 'appended')) assert.deepEqual(r, { kind: 'refused', code: 'ATTEMPT_LIMIT' });
  const s = l.snapshot(TA);
  assert.deepEqual([s.log.length, s.tally.submitted, s.tally.refused], [3, 8, 5]);
  assert.deepEqual(s.log.map((o) => o.seq), [1, 2, 3]);
  assert.equal(snapshotIsConsistent(s), true);
});

test('races: six processes recording different items get consecutive sequence numbers and one valid hash chain', async () => {
  const file = newFile();
  const l = make({}, file);
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => worker(['record', file, TA, `digest-${i}`, `wi-${String(i).repeat(12)}`])));
  assert.deepEqual(results.map((r) => r.seq).sort(), [1, 2, 3, 4, 5, 6], JSON.stringify(results));
  const s = l.snapshot(TA);
  assert.equal(verifyObservationLog(s.log), true);
  assert.equal(snapshotIsConsistent(s), true);
});

test('races: refusals and observations from many processes and two tenants are all counted, and neither tenant sees the other', async () => {
  const file = newFile();
  const l = make({}, file);
  await Promise.all([
    ...Array.from({ length: 4 }, () => worker(['refuse', file, TA, 'TRIPLE_INVALID'])),
    ...Array.from({ length: 3 }, () => worker(['refuse', file, TB, 'TENANT_MISMATCH'])),
    ...Array.from({ length: 3 }, (_, i) => worker(['record', file, TB, `b-${i}`, `wi-${String(i).repeat(12)}`])),
  ]);
  const a = l.snapshot(TA); const b = l.snapshot(TB);
  assert.deepEqual([a.tally.submitted, a.tally.refused, a.log.length], [4, 4, 0]);
  assert.deepEqual([b.tally.submitted, b.tally.refused, b.log.length], [6, 3, 3]);
  assert.deepEqual([[...a.tally.refusals], [...b.tally.refusals]], [[['TRIPLE_INVALID', 4]], [['TENANT_MISMATCH', 3]]]);
  assert.ok(snapshotIsConsistent(a) && snapshotIsConsistent(b));
});

test('races: a reader in another connection always sees a consistent snapshot while writers run', async () => {
  const file = newFile();
  const l = make({}, file);
  const writers = Promise.all(Array.from({ length: 6 }, (_, i) => worker(['record', file, TA, `w-${i}`, `wi-${String(i).repeat(12)}`])));
  for (let i = 0; i < 20; i++) assert.equal(snapshotIsConsistent(l.snapshot(TA)), true);
  await writers;
  assert.equal(l.snapshot(TA).log.length, 6);
});

test('a writer that cannot get the database lock fails closed and changes nothing', () => {
  const file = newFile();
  const l = make({ busyTimeoutMs: 1 }, file);
  l.record(TA, obs(draftOf('d1')));
  const before = l.snapshot(TA);
  const holder = new DatabaseSync(file);
  holder.exec('BEGIN IMMEDIATE');
  assert.throws(() => l.record(TA, obs(draftOf('d2'))));
  assert.throws(() => l.record(TA, refusal('TRIPLE_INVALID')));
  holder.exec('ROLLBACK');
  holder.close();
  assert.deepEqual(l.snapshot(TA), before);
  assert.equal(l.record(TA, obs(draftOf('d2'))).kind, 'appended');
});

// ---------------------------------------------------------------- atomicity
test('atomic: if the tally cannot be updated, the observation is rolled back too and nothing is half-recorded', () => {
  const file = newFile();
  const l = make({}, file);
  l.record(TA, obs(draftOf('d1')));
  const raw = new DatabaseSync(file);
  raw.exec('DROP TABLE tallies');
  assert.throws(() => l.record(TA, obs(draftOf('d2', 'wi-bbbbbbbbbbbb'))));
  assert.equal((raw.prepare('SELECT count(*) AS n FROM observations WHERE tenant = ?').get(TA) as { n: number }).n, 1, 'the observation insert was rolled back');
  raw.exec('CREATE TABLE tallies (tenant TEXT PRIMARY KEY, submitted INTEGER NOT NULL DEFAULT 0, duplicates INTEGER NOT NULL DEFAULT 0, refused INTEGER NOT NULL DEFAULT 0) STRICT');
  raw.close();
  assert.equal(l.record(TA, obs(draftOf('d2', 'wi-bbbbbbbbbbbb'))).kind, 'appended', 'the digest was not reserved by the failed call');
});

test('atomic: a failure while filing a refusal counts nothing', () => {
  const file = newFile();
  const l = make({}, file);
  l.record(TA, refusal('TRIPLE_INVALID'));
  const raw = new DatabaseSync(file);
  raw.exec('DROP TABLE refusals');
  assert.throws(() => l.record(TA, refusal('TRIPLE_INVALID')));
  assert.equal((raw.prepare('SELECT submitted FROM tallies WHERE tenant = ?').get(TA) as { submitted: number }).submitted, 1, 'submitted was rolled back with it');
  raw.close();
});

// ---------------------------------------------------------------- tampering
function build(): { file: string; l: SqliteReportingLedger } {
  const file = newFile();
  const l = make({}, file);
  for (const [tenant, d] of SEQUENCE) l.record(tenant, d);
  l.record(TA, obs(draftOf('d4', 'wi-cccccccccccc', { outcome: 'pass', verdict_at: T2 })));
  return { file, l };
}
const dropTriggers = (raw: DatabaseSync) => { raw.exec('DROP TRIGGER observations_no_update'); raw.exec('DROP TRIGGER observations_no_delete'); };

test('tampering: the database itself refuses to update or delete an observation', () => {
  const { file, l } = build();
  const raw = new DatabaseSync(file);
  assert.throws(() => raw.prepare("UPDATE observations SET outcome = 'pass' WHERE tenant = ? AND seq = 2").run(TA));
  assert.throws(() => raw.prepare('DELETE FROM observations WHERE tenant = ? AND seq = 1').run(TA));
  raw.close();
  assert.equal(snapshotIsConsistent(l.snapshot(TA)), true);
});

test('tampering: an edited, removed, reordered, forged or tally-edited row makes the snapshot inconsistent', () => {
  const edits: Record<string, (raw: DatabaseSync) => void> = {
    'edited outcome': (raw) => { raw.prepare("UPDATE observations SET outcome = 'pass' WHERE tenant = ? AND seq = 2").run(TA); },
    'edited verdict time': (raw) => { raw.prepare("UPDATE observations SET verdict_at = '2030-01-01T00:00:00Z' WHERE tenant = ? AND seq = 1").run(TA); },
    'edited correlation id': (raw) => { raw.prepare("UPDATE observations SET qc_correlation_id = 'corr-forged' WHERE tenant = ? AND seq = 3").run(TA); },
    'edited checks': (raw) => { raw.prepare("UPDATE observations SET checks = '[]' WHERE tenant = ? AND seq = 2").run(TA); },
    'removed first row': (raw) => { raw.prepare('DELETE FROM observations WHERE tenant = ? AND seq = 1').run(TA); },
    'removed middle row': (raw) => { raw.prepare('DELETE FROM observations WHERE tenant = ? AND seq = 2').run(TA); },
    'swapped sequence numbers': (raw) => {
      raw.prepare('UPDATE observations SET seq = 99 WHERE tenant = ? AND seq = 1').run(TA);
      raw.prepare('UPDATE observations SET seq = 1 WHERE tenant = ? AND seq = 2').run(TA);
      raw.prepare('UPDATE observations SET seq = 2 WHERE tenant = ? AND seq = 99').run(TA);
    },
    'forged row with no valid digest': (raw) => {
      raw.prepare(`INSERT INTO observations (tenant, seq, item_id, attempt, candidate_digest, outcome, checks, broken, intake_correlation_id, processing_correlation_id, qc_correlation_id,
                     verdict_at, recorded_at, previous_digest, digest) VALUES (?, 5, 'wi-dddddddddddd', 1, 'forged', 'pass', '[]', '[]', 'i', 'p', 'q', '2026-10-25T18:01:00Z', '2026-10-25T18:00:00Z', ?, ?)`)
        .run(TA, 'f'.repeat(64), 'e'.repeat(64));
    },
    'tally submitted raised': (raw) => { raw.prepare('UPDATE tallies SET submitted = submitted + 1 WHERE tenant = ?').run(TA); },
    'tally duplicates lowered': (raw) => { raw.prepare('UPDATE tallies SET duplicates = 0 WHERE tenant = ?').run(TA); },
    'refusal count edited': (raw) => { raw.prepare("UPDATE refusals SET n = 5 WHERE tenant = ? AND code = 'TRIPLE_INVALID'").run(TA); },
    'refusal row removed': (raw) => { raw.prepare('DELETE FROM refusals WHERE tenant = ?').run(TA); },
    'tally row removed': (raw) => { raw.prepare('DELETE FROM tallies WHERE tenant = ?').run(TA); },
  };
  for (const [name, edit] of Object.entries(edits)) {
    const { file, l } = build();
    assert.equal(snapshotIsConsistent(l.snapshot(TA)), true, `${name}: starts consistent`);
    const raw = new DatabaseSync(file);
    dropTriggers(raw);
    edit(raw);
    raw.close();
    assert.equal(snapshotIsConsistent(l.snapshot(TA)), false, name);
    assert.equal(snapshotIsConsistent(l.snapshot(TB)), true, `${name}: the other tenant is unaffected`);
  }
});

test('tampering: Reporting over an edited database fails closed for report and history, and keeps counting nothing it cannot trust', async () => {
  const env = await envelopeFor(PW, plumbingMessage('evt-synthetic-sd'));
  const t = await attempt(PW, env, { at: T1 });
  const file = newFile();
  const l = make({}, file);
  const r = reporting({ ledger: l }); const ctx = await rptCtx();
  okSubmit(await r.submit(ctx, [t]));
  assert.equal(reportOf(await r.report(ctx)).counts.counted_items, 1);
  const raw = new DatabaseSync(file);
  dropTriggers(raw);
  raw.prepare("UPDATE observations SET outcome = 'escalate' WHERE tenant = ?").run(PW);
  raw.close();
  const rep: any = await r.report(ctx); const h: any = await r.history(ctx);
  assert.deepEqual([rep.ok, rep.error.code, h.ok, h.error.code], [false, 'REPORT_ERROR', false, 'REPORT_ERROR']);
  assert.ok(!JSON.stringify([rep, h]).includes(PW));
});

// ---------------------------------------------------------------- privacy
test('the database file holds ids, digests, fixed words and times only, never payload text', async () => {
  const env = await envelopeFor(PW, plumbingMessage('evt-synthetic-se'));
  const file = newFile();
  const l = make({}, file);
  const r = reporting({ ledger: l }); const ctx = await rptCtx();
  okSubmit(await r.submit(ctx, [await attempt(PW, env, { at: T1, down: true }), await attempt(PW, env, { at: T2 }), 'junk']));
  l.close();
  const raw = new DatabaseSync(file);
  const dump = JSON.stringify(['observations', 'tallies', 'refusals', 'meta'].map((t) => raw.prepare(`SELECT * FROM ${t}`).all()));
  raw.close();
  for (const leak of [CANARY, '[ADDRESS_1]', 'Burst pipe repair', 'Emergency leak', 'channel-ledger-test', 'mock-note:', 'Example Health']) assert.ok(!dump.includes(leak), leak);
  assert.ok(dump.includes(PW) && dump.includes(env.item_id) && dump.includes('TRIPLE_INVALID'));
});

// ---------------------------------------------------------------- safe failure and setup
test('safe failure: a closed ledger throws, a corrupt file, an unsupported schema and another store\'s file are refused without echoing paths or SQL', () => {
  const l = make();
  l.close(); l.close();
  assert.throws(() => l.record(TA, obs(draftOf('d1'))));
  assert.throws(() => l.snapshot(TA));

  const garbage = newFile();
  writeFileSync(garbage, `${CANARY} this is not a database `.repeat(200));
  assert.throws(() => createSqliteReportingLedger({ path: garbage }), (e: Error) => e instanceof RangeError && !e.message.includes('CANARY') && !e.message.includes(dir));

  const versioned = newFile();
  make({}, versioned).close();
  const raw = new DatabaseSync(versioned);
  raw.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
  raw.close();
  assert.throws(() => createSqliteReportingLedger({ path: versioned }), (e: Error) => e instanceof RangeError && !e.message.includes('99'));

  const wrongKind = newFile();
  make({}, wrongKind).close();
  const raw2 = new DatabaseSync(wrongKind);
  raw2.prepare("UPDATE meta SET value = 'something-else' WHERE key = 'kind'").run();
  raw2.close();
  assert.throws(() => createSqliteReportingLedger({ path: wrongKind }), (e: Error) => e instanceof RangeError && !e.message.includes('something-else'));

  const approval = newFile();
  createSqliteApprovalStore({ path: approval, now: () => T1 }).close();
  assert.throws(() => createSqliteReportingLedger({ path: approval }), RangeError, 'an approval store file is not a ledger');

  assert.throws(() => createSqliteReportingLedger({ path: join(dir, `missing-${CANARY}`, 'x.db') }), (e: Error) => e instanceof RangeError && !e.message.includes('CANARY'));
});

test('setup: bad configuration fails at startup without echoing values', () => {
  const f = newFile();
  for (const bad of [null, undefined, 5, 'x', [], {}, { path: '' }, { path: 5 }, { path: 'a\0b' }, { path: 'x'.repeat(1025) }]) {
    assert.throws(() => createSqliteReportingLedger(bad as any), RangeError);
  }
  for (const bad of [0, -1, 1.5, 1001, '3', NaN]) assert.throws(() => createSqliteReportingLedger({ path: f, maxAttempts: bad as any }), RangeError);
  for (const bad of [0, 60_001, 1.5, '5', NaN]) assert.throws(() => createSqliteReportingLedger({ path: f, busyTimeoutMs: bad as any }), RangeError);
});

test('the Node version guard accepts only versions that have the built-in module', () => {
  for (const v of ['24.15.0', '24.20.1', '25.0.0', '26.1.2']) assert.equal(nodeSupportsSqlite(v), true, v);
  for (const v of ['24.14.9', '24.0.0', '22.9.0', 'x', '', null, 24, undefined]) assert.equal(nodeSupportsSqlite(v), false, String(v));
  assert.equal(nodeSupportsSqlite(process.versions.node), true);
});

// ---------------------------------------------------------------- structure
test('every statement on a tenant table is bound to a tenant, and no value is ever concatenated into SQL', () => {
  const src = readFileSync(new URL('../src/reporting-ledger-sqlite.ts', import.meta.url), 'utf8');
  const statements = [...src.matchAll(/db\.(?:prepare|exec)\(\s*(`[^`]*`|'[^']*'|"[^"]*")\s*\)/g)].map((m) => m[1].slice(1, -1));
  assert.ok(statements.length >= 14, 'found the statements');
  const onTenantTables = statements.filter((q) => /\b(observations|tallies|refusals)\b/.test(q) && !/^\s*CREATE/i.test(q));
  assert.ok(onTenantTables.length >= 8);
  for (const q of onTenantTables) {
    assert.ok(/tenant\s*=\s*\?/.test(q) || /^INSERT INTO (observations|tallies|refusals) \(tenant,/.test(q.trim()), `unbound statement: ${q.slice(0, 80)}`);
    assert.ok(!q.includes('${'), 'no interpolated values');
  }
  const calls = (src.match(/db\.(?:prepare|exec)\(/g) ?? []).length;
  assert.ok(calls - statements.length <= 1, 'every statement is a literal, except the one schema loop');
  assert.ok(/for \(const statement of SCHEMA\) db\.exec\(statement\)/.test(src), 'the one non-literal call runs the fixed schema list');
});

test('inventory: only the two SQLite modules import node:sqlite, nothing but tests imports the ledger, and no agent, tool or pipeline is involved', () => {
  const dirSrc = new URL('../src/', import.meta.url);
  const strip = (x: string) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const files = readdirSync(dirSrc).filter((f) => f.endsWith('.ts'));
  const text = (f: string) => strip(readFileSync(new URL(f, dirSrc), 'utf8'));
  assert.deepEqual(files.filter((f) => /node:sqlite/.test(text(f))).sort(), ['approval-store-sqlite.ts', 'contact-vault.ts', 'intake-record-store.ts', 'reporting-ledger-sqlite.ts']);
  assert.deepEqual(files.filter((f) => f !== 'reporting-ledger-sqlite.ts' && /\.\/reporting-ledger-sqlite\.ts/.test(text(f))), []);
  const code_ = text('reporting-ledger-sqlite.ts');
  const imports = [...code_.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['./contracts.ts', './handoff-seal.ts', './reporting-ledger.ts', './reporting-ledger.ts', 'node:sqlite']);
  assert.ok(!/\b(fetch|process\.env|readFile|writeFile|child_process|mintExecutionContext|Math\.random|Date\.now|new Date|setTimeout|loadExtension|randomUUID)\b/.test(code_));
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies?: Record<string, string> };
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ['@anthropic-ai/sdk'], 'still exactly one dependency: SQLite adds none');
  assert.equal(GENESIS_DIGEST.length, 64);
});
