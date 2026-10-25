// The record store and the local dashboard server for the founder phone test. Loopback only; invented data only.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertSafeRecord, callRefFor, createIntakeRecordStore, RecordRefused } from '../src/intake-record-store.ts';
import type { IntakeRecord, IntakeRecordStore } from '../src/intake-record-store.ts';
import { createDashboardServer, dataScriptFor, toDashboardItem } from '../src/dashboard-server.ts';
import { createSqliteReportingLedger } from '../src/reporting-ledger-sqlite.ts';
import { createSqliteApprovalStore } from '../src/approval-store-sqlite.ts';

const dir = mkdtempSync(join(tmpdir(), 'founder-dash-'));
const closers: Array<() => unknown> = [];
after(() => { for (const c of closers.reverse()) try { c(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });
let n = 0;
const fileDb = () => join(dir, `r${++n}.sqlite`);
const A = 'ws-founder-a';
const B = 'ws-founder-b';
const staticDir = new URL('../../../prototype/intake-work-items', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function rec(tenant: string, id: string, over: Partial<IntakeRecord> = {}): IntakeRecord {
  return {
    item_id: id, workspace_id: tenant, call_ref: callRefFor(tenant, `call-${id}`), received_at: '2026-10-26T12:30:00Z', category: 'Emergency leak', status: 'ready',
    reasons: [], missing_fields: [],
    fields: [{ name: 'Address', value: '[ADDRESS_1]', confidence: 0.9, found: true }, { name: 'Job description', value: 'burst pipe', confidence: 0.8, found: true }, { name: 'Preferred date', value: null, confidence: null, found: false }],
    pii_summary: [{ type: 'Address', count: 1 }], confidence: 0.8, versions: { skill: 'v', model: 'm', prompt: 'p' }, handed_off: true, turns: 3, ...over,
  };
}
const open = (path = fileDb()) => { const s = createIntakeRecordStore({ path }); closers.push(() => s.close()); return s; };

// ---------------------------------------------------------------- store
test('store: a record is saved, listed newest first, and a repeat of the same call or item is a duplicate', () => {
  const s = open();
  assert.equal(s.put(A, rec(A, 'wi-1', { received_at: '2026-10-26T12:00:00Z' })), 'new');
  assert.equal(s.put(A, rec(A, 'wi-2', { received_at: '2026-10-26T13:00:00Z' })), 'new');
  assert.equal(s.put(A, rec(A, 'wi-1')), 'duplicate');
  assert.equal(s.put(A, rec(A, 'wi-3', { call_ref: callRefFor(A, 'call-wi-1') })), 'duplicate', 'same call, different item');
  assert.deepEqual(s.list(A).map((r) => r.item_id), ['wi-2', 'wi-1']);
});

test('store: the history survives a restart', () => {
  const path = fileDb();
  const a = createIntakeRecordStore({ path }); a.put(A, rec(A, 'wi-9')); a.close();
  const b = open(path);
  assert.deepEqual(b.list(A).map((r) => r.item_id), ['wi-9']);
  assert.equal(b.put(A, rec(A, 'wi-9')), 'duplicate');
});

test('tenants: each tenant sees only its own records, and a record cannot be saved under another tenant', () => {
  const s = open();
  s.put(A, rec(A, 'wi-a')); s.put(B, rec(B, 'wi-b'));
  assert.deepEqual(s.list(A).map((r) => r.item_id), ['wi-a']);
  assert.deepEqual(s.list(B).map((r) => r.item_id), ['wi-b']);
  assert.deepEqual(s.list('ws-founder-none'), []);
  assert.throws(() => s.put(A, rec(B, 'wi-x')), RecordRefused);
  assert.equal(s.purge(B, rec(A, 'wi-a').call_ref), 0, 'another tenant cannot delete it');
  assert.equal(s.list(A).length, 1);
});

test('privacy: a record that looks personal anywhere is refused and nothing is written', () => {
  const s = open();
  const personal: Array<[string, Partial<IntakeRecord>]> = [
    ['email in a value', { fields: [{ name: 'Address', value: 'sam@example.test', confidence: 0.9, found: true }] }],
    ['phone in a value', { fields: [{ name: 'Address', value: 'call 555 010 0199', confidence: 0.9, found: true }] }],
    ['street address in a value', { fields: [{ name: 'Address', value: '42 Elm Street', confidence: 0.9, found: true }] }],
    ['long number in a field name', { fields: [{ name: 'Ref 1234567', value: null, confidence: null, found: false }] }],
    ['address in the category', { category: '7 Oak Avenue' }],
    ['phone in a reason', { reasons: ['call +1 555 010 0199'] }],
    ['email as the item id', { item_id: 'a@b.test' }],
  ];
  for (const [name, over] of personal) assert.throws(() => s.put(A, rec(A, 'wi-p', over)), RecordRefused, name);
  assert.deepEqual(s.list(A), []);
});

test('shape: extra keys, wrong types and inconsistent records are refused', () => {
  const s = open();
  const bad: Array<[string, any]> = [
    ['extra key', { ...rec(A, 'wi-1'), transcript: 'hello' }], ['missing key', (() => { const r: any = rec(A, 'wi-1'); delete r.turns; return r; })()],
    ['status', rec(A, 'wi-1', { status: 'done' as never })], ['handed off but needs-human', rec(A, 'wi-1', { status: 'needs-human', handed_off: true })],
    ['found without value', rec(A, 'wi-1', { fields: [{ name: 'Address', value: null, confidence: null, found: true }] })],
    ['confidence', rec(A, 'wi-1', { confidence: 3 })], ['call ref', rec(A, 'wi-1', { call_ref: 'CA0123456789abcdef0123456789abcdef' })],
    ['time', rec(A, 'wi-1', { received_at: 'yesterday' })], ['not an object', 'x'],
  ];
  for (const [name, r] of bad) assert.throws(() => s.put(A, r), RecordRefused, name);
  assert.throws(() => assertSafeRecord(A, null), RecordRefused);
});

test('call ref: a hash of tenant and call id that reveals neither', () => {
  const r = callRefFor(A, 'CA0123456789abcdef0123456789abcdef');
  assert.match(r, /^[0-9a-f]{16}$/);
  assert.notEqual(r, callRefFor(B, 'CA0123456789abcdef0123456789abcdef'));
  assert.ok(!r.includes('CA0123'));
});

test('purge: removes exactly one record of one tenant', () => {
  const s = open();
  const a = rec(A, 'wi-a'); s.put(A, a); s.put(A, rec(A, 'wi-b'));
  assert.equal(s.purge(A, a.call_ref), 1);
  assert.equal(s.purge(A, a.call_ref), 0);
  assert.deepEqual(s.list(A).map((r) => r.item_id), ['wi-b']);
  for (const bad of ['', 'x', 'CA0123456789abcdef0123456789abcdef', undefined as never]) assert.throws(() => s.purge(A, bad), RecordRefused);
});

test('tampering: a row edited in the file is refused when read (fail closed), and updates are blocked by the database', () => {
  const path = fileDb();
  const s = createIntakeRecordStore({ path }); s.put(A, rec(A, 'wi-1')); s.close();
  const raw = new DatabaseSync(path);
  assert.throws(() => raw.exec("UPDATE records SET body = '{}'"), /no updates/);
  raw.exec('DROP TRIGGER records_no_update');
  const body = JSON.parse((raw.prepare('SELECT body FROM records').get() as { body: string }).body);
  body.fields[0].value = 'sam@example.test';
  raw.prepare('UPDATE records SET body = ?').run(JSON.stringify(body));
  raw.close();
  const again = open(path);
  assert.throws(() => again.list(A), RecordRefused);
});

test('file: holds ids, placeholders, fixed words and counts only (a scan of the bytes)', () => {
  const path = fileDb();
  const s = createIntakeRecordStore({ path });
  s.put(A, rec(A, 'wi-1')); s.close();
  const bytes = readFileSync(path).toString('latin1');
  for (const needle of ['Elm Street', '@example', '555 010', 'Sam Example', 'CA0123456789abcdef']) assert.ok(!bytes.includes(needle), needle);
  assert.ok(bytes.includes('[ADDRESS_1]'));
});

test('safe failure: closed, corrupt, other-kind and bad-path stores fail without echoing anything', () => {
  const s = open(); s.close();
  assert.throws(() => s.list(A), /closed/);
  const bad = join(dir, 'corrupt.sqlite'); writeFileSync(bad, 'not a database'.repeat(50));
  assert.throws(() => createIntakeRecordStore({ path: bad }), (e: Error) => e instanceof RangeError && !e.message.includes('corrupt'));
  const ledger = fileDb(); const l = createSqliteReportingLedger({ path: ledger }); l.close();
  assert.throws(() => createIntakeRecordStore({ path: ledger }), RangeError);
  const approvals = fileDb(); const ap = createSqliteApprovalStore({ path: approvals, now: () => '2026-10-26T12:00:00Z' }); ap.close();
  assert.throws(() => createIntakeRecordStore({ path: approvals }), RangeError);
  for (const p of ['', 'a\0b', 5 as never]) assert.throws(() => createIntakeRecordStore({ path: p }), RangeError);
  const mine = fileDb(); open(mine).close();
  assert.throws(() => createSqliteReportingLedger({ path: mine }), RangeError, 'and the other stores refuse this file');
});

test('statements: every data statement is a literal bound to a tenant', () => {
  const code = readFileSync(new URL('../src/intake-record-store.ts', import.meta.url), 'utf8');
  for (const m of code.matchAll(/db\.prepare\(\s*(['"`])([\s\S]*?)\1/g)) {
    const sql = m[2];
    if (/FROM meta|INTO meta/.test(sql) || /SELECT 1 FROM meta/.test(sql)) continue;
    assert.ok(/tenant/.test(sql), sql);
  }
  assert.ok(!/\$\{/.test(code.split('db.prepare').slice(1).map((s) => s.slice(0, 200)).join('\n')), 'no interpolated SQL');
});

// ---------------------------------------------------------------- dashboard mapping
test('dashboard data: items keep the prototype shape, every reason has text, and nothing can end the script', () => {
  const r = rec(A, 'wi-1', { fields: [{ name: 'Job description', value: '</script><b>x</b> & "q"  ', confidence: 0.5, found: true }] });
  const item = toDashboardItem(r);
  assert.deepEqual([item.id, item.status, item.category, item.received, item.handedOff, item.message], ['wi-1', 'ready', 'Emergency leak', '2026-10-26 12:30', true, null]);
  assert.equal(item.steps.length, 8);
  assert.deepEqual(toDashboardItem(rec(A, 'wi-2', { status: 'needs-human', handed_off: false, category: 'unknown', reasons: ['missing_fields'] })).steps[7].status, 'skipped');
  assert.equal(toDashboardItem(rec(A, 'wi-2', { category: 'unknown' })).category, null);
  const js = dataScriptFor([r]);
  assert.ok(js.startsWith('/*') && js.includes('window.PROTO_DATA ='));
  assert.ok(!js.includes('</script>') && !js.includes('<b>') && !js.includes(' '));
  const data = new Function('window', `${js}; return window.PROTO_DATA;`)({}) as any;
  assert.equal(data.items[0].fields[0].value, '</script><b>x</b> & "q"  ');
  for (const code of ['missing_fields', 'unknown_category', 'ambiguous_category', 'ambiguous_field', 'low_confidence', 'model_failed']) assert.ok(typeof data.reasons[code] === 'string' && data.reasons[code].length > 10, code);
});

// ---------------------------------------------------------------- dashboard server
async function dash(store: IntakeRecordStore, tenant = A) {
  const d = createDashboardServer({ store, tenant, staticDir });
  const port = await d.listen(0);
  closers.push(() => d.close());
  return { d, port, url: (p: string) => `http://127.0.0.1:${port}${p}`, get: (p: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${p}`, { headers }) };
}

test('server: serves the prototype page and live data for exactly one tenant, on loopback', async () => {
  const s = open(); s.put(A, rec(A, 'wi-a')); s.put(B, rec(B, 'wi-b'));
  const { d, get } = await dash(s);
  assert.equal((d.server.address() as { address: string }).address, '127.0.0.1');
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<script src="data.js">/);
  assert.equal((await get('/app.js')).status, 200);
  assert.equal((await get('/styles.css')).status, 200);
  const data = await (await get('/data.js')).text();
  assert.ok(data.includes('wi-a') && !data.includes('wi-b'), 'only tenant A');
  const api: any = await (await get('/api/items')).json();
  assert.deepEqual(api.items.map((i: any) => i.id), ['wi-a']);
  const other = await dash(s, B);
  assert.deepEqual(((await (await other.get('/api/items')).json()) as any).items.map((i: any) => i.id), ['wi-b']);
});

test('server: fixed headers, GET and HEAD only, no query string, no other paths, loopback Host only', async () => {
  const s = open(); s.put(A, rec(A, 'wi-a'));
  const { port, get } = await dash(s);
  const r = await get('/data.js');
  assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'self'.*frame-ancestors 'none'/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await fetch(`http://127.0.0.1:${port}/data.js`, { method: 'HEAD' })).status, 200);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await fetch(`http://127.0.0.1:${port}/data.js`, { method, body: method === 'DELETE' ? undefined : 'x' })).status, 405, method);
  for (const q of ['/api/items?tenant=ws-founder-b', '/data.js?workspace_id=ws-founder-b', '/?x=1']) assert.equal((await get(q)).status, 400, q);
  for (const p of ['/nope', '/../package.json', '/%2e%2e/package.json', '/index.html/', '/api/items/wi-b', '/data.json', '/app.js.map']) assert.equal((await get(p)).status, 404, p);
  const body = await (await get('/nope')).text();
  assert.equal(body, '{"error":"NOT_FOUND"}');
});

test('server: a request whose Host header is not loopback is refused (DNS rebinding)', async () => {
  const s = open(); s.put(A, rec(A, 'wi-a'));
  const { port } = await dash(s);
  const http = await import('node:http');
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/data.js', headers: { Host: 'evil.example.test' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 421);
});

test('server: a failing or tampered store gives a fixed 503 and leaks nothing', async () => {
  const path = fileDb();
  const s = createIntakeRecordStore({ path }); s.put(A, rec(A, 'wi-a')); s.close();
  const raw = new DatabaseSync(path); raw.exec('DROP TRIGGER records_no_update'); raw.exec("UPDATE records SET body = '{\"leak\":\"CANARY-DASH-1\"}'"); raw.close();
  const { get } = await dash(open(path));
  for (const p of ['/data.js', '/api/items']) {
    const r = await get(p);
    assert.equal(r.status, 503);
    assert.equal(await r.text(), '{"error":"UNAVAILABLE"}');
  }
  assert.equal((await get('/')).status, 200, 'the static page does not need the store');
});

test('server: setup is validated and the host cannot be chosen', () => {
  const s = open();
  for (const bad of [{ tenant: '' }, { tenant: 'a b' }, { store: {} }, { staticDir: '' }]) assert.throws(() => createDashboardServer({ store: s, tenant: A, staticDir, ...bad } as never), RangeError);
  const code = readFileSync(new URL('../src/dashboard-server.ts', import.meta.url), 'utf8');
  assert.ok(/server\.listen\(p, '127\.0\.0\.1'/.test(code) && !/0\.0\.0\.0|'::'|hostname|options\.host/.test(code));
});
