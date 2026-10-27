// Tests for the SQLite reference approval store (DEVELOPMENT ONLY): the shared conformance suite on file and in-memory
// databases, plus restart persistence, in-doubt across restarts, multi-process races, tenant-bound statements and safe failure.
// Uses temporary database files only. Mock contexts, mock clock, synthetic data. No network, no key, no agent or tool connected.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteApprovalStore, nodeSupportsSqlite } from '../src/approval-store-sqlite.ts';
import type { SqliteApprovalStore, SqliteStoreConfig } from '../src/approval-store-sqlite.ts';
import { verifyEventLog } from '../src/approval-store.ts';
import type { StoreConfig } from '../src/approval-store.ts';
import { ACTION, at, CANARY, code, conformance, decide, DW, human, nowIso, ok, plus, processing, propose, PW, qcCtx, T0 } from './helpers/store-conformance.ts';

const dir = mkdtempSync(join(tmpdir(), 'approval-sqlite-'));
const open: SqliteApprovalStore[] = [];
let counter = 0;
const newFile = () => join(dir, `db-${++counter}.db`);
function make(config: Partial<SqliteStoreConfig> & StoreConfig, file = newFile()): SqliteApprovalStore {
  const s = createSqliteApprovalStore({ path: file, ...config });
  open.push(s);
  return s;
}
after(() => { for (const s of open) s.close(); rmSync(dir, { recursive: true, force: true }); });

const base = (over: Partial<StoreConfig> = {}): StoreConfig => ({ now: nowIso, newClaimId: ((n) => () => `claim-${String(++n).padStart(6, '0')}`)(0), ...over });

// ---------------------------------------------------------------- the same contract as the in-memory store
conformance('sqlite store (file)', (config) => make(config));
conformance('sqlite store (memory)', (config) => { const s = createSqliteApprovalStore({ path: ':memory:', ...config }); open.push(s); return s; });

// ---------------------------------------------------------------- durability settings
test('sqlite: a file database runs in WAL mode with full synchronous commits and foreign keys on', () => {
  const s = make(base());
  assert.deepEqual(s.settings(), { journal_mode: 'wal', synchronous: 2, foreign_keys: 1 });
  const mem = createSqliteApprovalStore({ path: ':memory:', ...base() });
  open.push(mem);
  assert.equal(mem.settings().synchronous, 2);
  assert.equal(mem.settings().journal_mode, 'memory');
});

// ---------------------------------------------------------------- restart persistence
test('sqlite: approvals, claims, outcomes, the effect ledger and the event log survive a restart', async () => {
  at(T0);
  const file = newFile();
  const s1 = make(base(), file);
  const p = await propose();
  ok(await s1.putProposal(await processing(), p));
  ok(await s1.recordDecision(await human(), await decide(p)));
  at(plus(60));
  const claim = ok(await s1.claim(await processing(), p.proposal_id, ACTION()));
  s1.close();

  const s2 = make(base(), file);
  const mid = ok(await s2.get(await processing(), p.proposal_id)).snapshot;
  assert.deepEqual([mid.state, mid.claim.attempt, mid.attempts, mid.decision.approver_id], ['claimed', 1, 1, 'user-boss']);
  code(await s2.claim(await processing(), p.proposal_id, ACTION()), 'CLAIM_CONFLICT');
  at(plus(90));
  ok(await s2.complete(await processing(), p.proposal_id, claim.grant.claim_id, { status: 'succeeded', evidence_ref: 'mock-note:st-0123456789ab' }));
  s2.close();

  const s3 = make(base(), file);
  const end = ok(await s3.get(await processing(), p.proposal_id)).snapshot;
  assert.deepEqual([end.state, end.outcome], ['succeeded', { status: 'succeeded', evidence_ref: 'mock-note:st-0123456789ab' }]);
  code(await s3.claim(await processing(), p.proposal_id, ACTION()), 'EFFECT_ALREADY_DONE');
  code(await s3.putProposal(await processing(), await propose()), 'EFFECT_ALREADY_DONE');
  const log = ok(await s3.events(await qcCtx(), p.proposal_id)).events;
  assert.deepEqual(log.map((e: any) => e.type), ['requested', 'approved', 'claimed', 'succeeded']);
  assert.equal(verifyEventLog(log), true);
});

test('sqlite: recording the same proposal again after a restart is still a no-op', async () => {
  at(T0);
  const file = newFile();
  const s1 = make(base(), file);
  const p = await propose();
  ok(await s1.putProposal(await processing(), p));
  s1.close();
  const s2 = make(base(), file);
  const again = ok(await s2.putProposal(await processing(), p));
  assert.deepEqual([again.created, again.snapshot.version], [false, 1]);
});

test('sqlite: a pending request and a decision are still there after a restart', async () => {
  at(T0);
  const file = newFile();
  const s1 = make(base(), file);
  const p = await propose();
  ok(await s1.putProposal(await processing(), p));
  s1.close();
  const s2 = make(base(), file);
  assert.equal(ok(await s2.get(await processing(), p.proposal_id)).snapshot.state, 'requested');
  ok(await s2.recordDecision(await human(), await decide(p)));
  s2.close();
  const s3 = make(base(), file);
  assert.equal(ok(await s3.claim(await processing(), p.proposal_id, ACTION())).grant.attempt, 1, 'the decision persisted, so the claim works without deciding again');
});

// ---------------------------------------------------------------- uncertain execution across restarts
test('sqlite: a claim made before a crash is durable and becomes in-doubt after its lease, even across restarts', async () => {
  at(T0);
  const file = newFile();
  const s1 = make(base({ newClaimId: () => 'claim-first-0001' }), file);
  const p = await propose();
  ok(await s1.putProposal(await processing(), p));
  ok(await s1.recordDecision(await human(), await decide(p)));
  const claim = ok(await s1.claim(await processing(), p.proposal_id, ACTION()));
  s1.close();                                   // the process "crashes" here: no tool outcome was ever recorded
  const s2 = make(base(), file);
  assert.equal(ok(await s2.get(await processing(), p.proposal_id)).snapshot.state, 'claimed', 'durable the moment claim returned');
  at(plus(10 * 60));
  const lapsed = ok(await s2.get(await processing(), p.proposal_id)).snapshot;
  assert.deepEqual([lapsed.state, lapsed.claim.attempt], ['in_doubt', 1]);
  code(await s2.claim(await processing(), p.proposal_id, ACTION()), 'IN_DOUBT');
  s2.close();
  const s3 = make(base({ idempotentTools: ['mock-note'], newClaimId: () => 'claim-second-0002' }), file);
  const retry = ok(await s3.claim(await processing(), p.proposal_id, ACTION()));
  assert.deepEqual([retry.grant.attempt, retry.grant.claim_id === claim.grant.claim_id], [2, false]);
  code(await s3.complete(await processing(), p.proposal_id, claim.grant.claim_id, { status: 'succeeded', evidence_ref: 'mock-note:x' }), 'STALE_CLAIM');
});

test('sqlite: an in-doubt claim is settled by Quality Control after a restart, and the ledger then blocks a new request', async () => {
  at(T0);
  const file = newFile();
  const s1 = make(base(), file);
  const p = await propose();
  ok(await s1.putProposal(await processing(), p));
  ok(await s1.recordDecision(await human(), await decide(p)));
  ok(await s1.claim(await processing(), p.proposal_id, ACTION()));
  s1.close();
  at(plus(5 * 60));
  const s2 = make(base(), file);
  ok(await s2.resolve(await qcCtx(), p.proposal_id, { status: 'succeeded', evidence_ref: 'mock-note:st-0123456789ab' }));
  s2.close();
  const s3 = make(base(), file);
  code(await s3.putProposal(await processing(), await propose()), 'EFFECT_ALREADY_DONE');
  const log = ok(await s3.events(await qcCtx(), p.proposal_id)).events;
  assert.deepEqual(log.map((e: any) => e.type), ['requested', 'approved', 'claimed', 'lease_lapsed', 'succeeded']);
  assert.equal(log[log.length - 1].data.via, 'resolve');
  assert.equal(verifyEventLog(log), true);
});

// ---------------------------------------------------------------- races between separate processes
function worker(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL('./helpers/sqlite-worker.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (c) => { try { resolve(JSON.parse(out.trim().split('\n').pop() as string)); } catch { reject(new Error(`worker failed (${c}): ${err.slice(0, 300)}`)); } });
  });
}

test('sqlite: six separate processes claiming the same approval produce exactly one winner', async () => {
  at(T0);
  const file = newFile();
  const s = make(base(), file);
  const p = await propose();
  ok(await s.putProposal(await processing(), p));
  ok(await s.recordDecision(await human(), await decide(p)));
  const results = await Promise.all(Array.from({ length: 6 }, () => worker(['claim', file, PW, p.proposal_id, T0])));
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  for (const r of results.filter((x) => !x.ok)) assert.equal(r.code, 'CLAIM_CONFLICT');
  const snap = ok(await s.get(await processing(), p.proposal_id)).snapshot;
  assert.deepEqual([snap.state, snap.attempts], ['claimed', 1]);
  assert.equal(verifyEventLog(ok(await s.events(await processing(), p.proposal_id)).events), true);
});

test('sqlite: six separate processes proposing for the same step leave exactly one live request', async () => {
  at(T0);
  const file = newFile();
  const s = make(base(), file);
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => worker(['put', file, PW, String(i), T0])));
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  for (const r of results.filter((x) => !x.ok)) assert.equal(r.code, 'ACTIVE_PROPOSAL_EXISTS');
  const raw = new DatabaseSync(file);
  assert.equal((raw.prepare('SELECT count(*) AS n FROM approvals WHERE tenant = ? AND step_id = ?').get(PW, 'st-0123456789ab') as { n: number }).n, 1);
  raw.close();
  s.close();
});

test('sqlite: findByStep gives the same answers after every restart, and the newest request always wins', async () => {
  at(T0);
  const file = newFile();
  const find = async (s: SqliteApprovalStore) => ok(await s.findByStep(await processing(), 'st-0123456789ab')).snapshot;
  const long = () => human(PW, { session: plus(100_000) });

  let s = make(base(), file);
  const d1 = await propose();
  ok(await s.putProposal(await processing(), d1));
  ok(await s.recordDecision(await long(), await decide(d1, 'declined')));
  s.close();
  s = make(base(), file);
  assert.deepEqual([(await find(s)).proposal_id, (await find(s)).state], [d1.proposal_id, 'declined']);

  at(plus(1));
  const d2 = await propose();
  ok(await s.putProposal(await processing(), d2));
  s.close();
  s = make(base(), file);
  let f = await find(s);
  assert.deepEqual([f.proposal_id, f.state], [d2.proposal_id, 'requested'], 'the live request wins after a restart');

  ok(await s.recordDecision(await long(), await decide(d2)));
  const claim = ok(await s.claim(await processing(), d2.proposal_id, ACTION()));
  s.close();
  s = make(base(), file);
  f = await find(s);
  assert.deepEqual([f.state, f.claim.attempt], ['claimed', 1]);

  at(plus(10 * 60));                                      // the lease ran out while nothing was running
  s.close();
  s = make(base(), file);
  assert.equal((await find(s)).state, 'in_doubt');
  ok(await s.complete(await processing(), d2.proposal_id, claim.grant.claim_id, { status: 'failed' }));
  s.close();
  s = make(base(), file);
  f = await find(s);
  assert.deepEqual([f.proposal_id, f.state], [d2.proposal_id, 'failed'], 'the newest finished request, not the older declined one');
  assert.equal(verifyEventLog(ok(await s.events(await processing(), d2.proposal_id)).events), true);
});

test('sqlite: an unanswered request expires on the first read after a restart, with one expiry event', async () => {
  at(T0);
  const file = newFile();
  let s = make(base(), file);
  const p = await propose();
  ok(await s.putProposal(await processing(), p));
  s.close();
  at(plus(3600 + 30));
  s = make(base(), file);
  for (let i = 0; i < 3; i++) assert.equal(ok(await s.findByStep(await processing(), 'st-0123456789ab')).snapshot.state, 'expired');
  const types = ok(await s.events(await processing(), p.proposal_id)).events.map((e: any) => e.type);
  assert.deepEqual(types, ['requested', 'expired']);
  s.close();
  s = make(base(), file);
  assert.equal(ok(await s.findByStep(await processing(), 'st-0123456789ab')).snapshot.state, 'expired');
  assert.equal(ok(await s.events(await processing(), p.proposal_id)).events.length, 2, 'a second restart adds nothing');
});

test('sqlite: readers in separate processes see a consistent step while claims race, and one claim wins', async () => {
  at(T0);
  const file = newFile();
  const s = make(base(), file);
  const p = await propose();
  ok(await s.putProposal(await processing(), p));
  ok(await s.recordDecision(await human(), await decide(p)));
  const jobs = [
    ...Array.from({ length: 3 }, () => worker(['claim', file, PW, p.proposal_id, T0])),
    ...Array.from({ length: 5 }, () => worker(['find', file, PW, 'st-0123456789ab', T0])),
  ];
  const results = await Promise.all(jobs);
  const claims = results.slice(0, 3); const finds = results.slice(3);
  assert.equal(claims.filter((r) => r.ok).length, 1, JSON.stringify(claims));
  for (const r of claims.filter((x) => !x.ok)) assert.equal(r.code, 'CLAIM_CONFLICT');
  for (const r of finds) { assert.equal(r.ok, true, JSON.stringify(r)); assert.ok(['approved', 'claimed'].includes(r.state)); assert.equal(r.proposal_id, p.proposal_id); }
  assert.equal(ok(await s.findByStep(await processing(), 'st-0123456789ab')).snapshot.state, 'claimed');
});

test('sqlite: a writer that cannot get the database lock fails closed and changes nothing', async () => {
  at(T0);
  const file = newFile();
  const s = make(base({}), file);
  const slow = make({ ...base(), busyTimeoutMs: 50 }, file);
  const p = await propose();
  ok(await s.putProposal(await processing(), p));
  ok(await s.recordDecision(await human(), await decide(p)));
  const holder = new DatabaseSync(file);
  holder.exec('BEGIN IMMEDIATE');               // another connection holds the write lock
  const started = Date.now();
  code(await slow.claim(await processing(), p.proposal_id, ACTION()), 'STORE_ERROR');
  assert.ok(Date.now() - started < 3000, 'bounded wait');
  holder.exec('ROLLBACK'); holder.close();
  assert.equal(ok(await s.get(await processing(), p.proposal_id)).snapshot.state, 'approved', 'nothing changed');
  ok(await slow.claim(await processing(), p.proposal_id, ACTION()));
});

// ---------------------------------------------------------------- tenant-bound queries, privacy, tamper evidence
test('sqlite: every statement on a tenant table is bound to a tenant, and no value is ever concatenated into SQL', () => {
  const src = readFileSync(new URL('../src/approval-store-sqlite.ts', import.meta.url), 'utf8');
  const statements = [...src.matchAll(/db\.(?:prepare|exec)\(\s*(`[^`]*`|'[^']*'|"[^"]*")\s*\)/g)].map((m) => m[1].slice(1, -1));
  assert.ok(statements.length >= 20, 'found the statements');
  const onTenantTables = statements.filter((q) => /\b(approvals|effects|events)\b/.test(q) && !/^\s*CREATE/i.test(q));
  assert.ok(onTenantTables.length >= 15);
  for (const q of onTenantTables) {
    assert.ok(/tenant\s*=\s*\?/.test(q) || /^INSERT INTO (approvals|effects|events) \(tenant,/.test(q.trim()), `unbound statement: ${q.slice(0, 80)}`);
    assert.ok(!q.replace('${LIVE_STATES}', '').includes('${'), 'no interpolated values');
  }
  const calls = (src.match(/db\.(?:prepare|exec)\(/g) ?? []).length;
  assert.ok(calls - statements.length <= 1, 'every statement is a literal, except the one schema loop');
  assert.ok(/for \(const statement of SCHEMA\) db\.exec\(statement\)/.test(src), 'the one non-literal call runs the fixed schema list');
});

test('sqlite: the database file holds ids, digests and fixed words only, never action arguments or text', async () => {
  at(T0);
  const file = newFile();
  const s = make(base(), file);
  const p = await propose();
  ok(await s.putProposal(await processing(), p));
  ok(await s.recordDecision(await human(), await decide(p)));
  const c = ok(await s.claim(await processing(), p.proposal_id, ACTION()));
  ok(await s.complete(await processing(), p.proposal_id, c.grant.claim_id, { status: 'succeeded', evidence_ref: 'mock-note:st-0123456789ab' }));
  const raw = new DatabaseSync(file);
  const dump = JSON.stringify(['approvals', 'effects', 'events', 'meta'].map((t) => raw.prepare(`SELECT * FROM ${t}`).all()));
  raw.close();
  assert.ok(!dump.includes('CANARY') && !dump.includes('"note"') && !dump.includes('arguments'));
  assert.ok(dump.includes(p.action_digest) && dump.includes(PW));
});

test('sqlite: editing the event log in the file is detected; the log is evidence, not protection', async () => {
  at(T0);
  const file = newFile();
  const s = make(base(), file);
  const p = await propose();
  ok(await s.putProposal(await processing(), p));
  ok(await s.recordDecision(await human(), await decide(p)));
  assert.equal(verifyEventLog(ok(await s.events(await processing(), p.proposal_id)).events), true);
  const raw = new DatabaseSync(file);
  raw.prepare("UPDATE events SET type = 'declined' WHERE tenant = ? AND proposal_id = ? AND seq = 2").run(PW, p.proposal_id);
  assert.equal(verifyEventLog(ok(await s.events(await processing(), p.proposal_id)).events), false, 'edited event');
  raw.prepare("UPDATE events SET type = 'approved' WHERE tenant = ? AND proposal_id = ? AND seq = 2").run(PW, p.proposal_id);
  assert.equal(verifyEventLog(ok(await s.events(await processing(), p.proposal_id)).events), true, 'restored');
  raw.prepare('DELETE FROM events WHERE tenant = ? AND proposal_id = ? AND seq = 1').run(PW, p.proposal_id);
  assert.equal(verifyEventLog(ok(await s.events(await processing(), p.proposal_id)).events), false, 'removed event');
  raw.close();
});

// ---------------------------------------------------------------- safe failure and setup
test('sqlite: a closed store, a corrupt file and an unsupported schema fail closed without echoing paths or SQL', async () => {
  at(T0);
  const s = make(base());
  const p = await propose();
  s.close(); s.close();
  for (const r of [await s.putProposal(await processing(), p), await s.get(await processing(), p.proposal_id), await s.claim(await processing(), p.proposal_id, ACTION())]) code(r, 'STORE_ERROR');

  const garbage = newFile();
  writeFileSync(garbage, `${CANARY} this is not a database `.repeat(200));
  assert.throws(() => createSqliteApprovalStore({ path: garbage, ...base() }), (e: Error) => e instanceof RangeError && !e.message.includes('CANARY') && !e.message.includes(dir));

  const versioned = newFile();
  make(base(), versioned).close();
  const raw = new DatabaseSync(versioned);
  raw.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
  raw.close();
  assert.throws(() => createSqliteApprovalStore({ path: versioned, ...base() }), (e: Error) => e instanceof RangeError && !e.message.includes('99'));

  assert.throws(() => createSqliteApprovalStore({ path: join(dir, `missing-${CANARY}`, 'x.db'), ...base() }), (e: Error) => e instanceof RangeError && !e.message.includes('CANARY'));
});

test('sqlite: bad setup fails at startup without echoing values', () => {
  const now = () => T0;
  for (const [name, config] of [
    ['no path', {}], ['empty path', { path: '' }], ['nul path', { path: 'a\0b' }], ['long path', { path: 'x'.repeat(1025) }], ['number path', { path: 5 }],
    ['busy', { path: ':memory:', busyTimeoutMs: 0 }], ['busy big', { path: ':memory:', busyTimeoutMs: 60_001 }], ['lease', { path: ':memory:', leaseSeconds: 0 }],
    ['attempts', { path: ':memory:', maxAttempts: 11 }], ['tools', { path: ':memory:', idempotentTools: [`Bad ${CANARY}`] }], ['claim ids', { path: ':memory:', newClaimId: 'x' }],
  ] as [string, any][]) assert.throws(() => createSqliteApprovalStore({ now, ...config }), (e: Error) => e instanceof RangeError && !e.message.includes('CANARY'), name);
  assert.throws(() => createSqliteApprovalStore(null as never), RangeError);
  assert.throws(() => createSqliteApprovalStore({ path: ':memory:' } as never), RangeError);
});

test('sqlite: the Node version guard accepts only versions that have the built-in module', () => {
  for (const [v, expected] of [['24.15.0', true], ['24.21.0', true], ['25.0.0', true], ['26.1.2', true], ['24.14.9', false], ['24.0.0', false], ['22.13.0', false], ['23.9.0', false], ['junk', false], ['', false], [24, false], [null, false]] as [unknown, boolean][]) {
    assert.equal(nodeSupportsSqlite(v), expected, String(v));
  }
  assert.equal(nodeSupportsSqlite(process.versions.node), true, 'this machine can run the store');
});

test('sqlite: tenants are separate in a shared file', async () => {
  at(T0);
  const s = make(base());
  const a = await propose(PW); const b = await propose(DW);
  ok(await s.putProposal(await processing(PW), a));
  ok(await s.putProposal(await processing(DW), b));
  ok(await s.recordDecision(await human(PW), await decide(a)));
  assert.equal(ok(await s.get(await processing(DW), b.proposal_id)).snapshot.state, 'requested');
  code(await s.get(await processing(DW), a.proposal_id), 'STORE_NOT_FOUND');
  code(await s.claim(await processing(DW), a.proposal_id, ACTION()), 'STORE_NOT_FOUND');
});

// ---------------------------------------------------------------- inventory
test('sqlite: only this store imports node:sqlite, nothing imports the store, and no agent, tool or pipeline is involved', () => {
  const dirSrc = new URL('../src/', import.meta.url);
  const strip = (x: string) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const files = readdirSync(dirSrc).filter((f) => f.endsWith('.ts'));
  const text = (f: string) => strip(readFileSync(new URL(f, dirSrc), 'utf8'));
  assert.deepEqual(files.filter((f) => /node:sqlite/.test(text(f))).sort(), ['approval-store-sqlite.ts', 'contact-vault.ts', 'intake-record-store.ts', 'reporting-ledger-sqlite.ts']);   // the Reporting ledger and the founder-test record store are the other SQLite modules
  assert.deepEqual(files.filter((f) => f !== 'approval-store-sqlite.ts' && /\.\/approval-store-sqlite\.ts/.test(text(f))), []);
  const code_ = text('approval-store-sqlite.ts');
  for (const m of code_.matchAll(/from\s+'([^']+)'/g)) assert.ok(m[1].startsWith('./') || ['node:sqlite', 'node:crypto'].includes(m[1]), `imports ${m[1]}`);
  assert.ok(!/from\s+'\.\/(processing-entry|qc-entry|reporting-entry|pipeline|intake-entry|mock-tools|live-run)\.ts'/.test(code_));
  assert.ok(!/\b(fetch|process\.env|readFile|writeFile|child_process|mintExecutionContext|mintApproverContext|Math\.random|Date\.now|setTimeout|loadExtension)\b/.test(code_));
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies?: Record<string, string> };
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ['@anthropic-ai/sdk'], 'still exactly one dependency: SQLite adds none');
});
