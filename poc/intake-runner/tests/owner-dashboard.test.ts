// The owner's dashboard on the local server: `/` (the page, its styles and script), `/data.js` and `/api/owner` (its data). There is ONE
// dashboard. These tests keep every restriction the server has (loopback only, one fixed tenant, GET and HEAD only, exact paths, no query,
// loopback Host, fixed errors), the strict page policy, and the owner view's allow-listed shape; and they check that the retired second
// owner page (`/owner`, `prototype/owner-view`) and the old engineering route (`/api/items`) are gone. Invented data only.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createDashboardServer, localDayBounds } from '../src/dashboard-server.ts';
import { callRefFor, createIntakeRecordStore } from '../src/intake-record-store.ts';
import type { IntakeRecord, IntakeRecordStore } from '../src/intake-record-store.ts';

const tmp = mkdtempSync(join(tmpdir(), 'owner-dash-'));
const closers: Array<() => unknown> = [];
after(async () => { for (const c of closers.reverse()) try { await c(); } catch { /* already closed */ } rmSync(tmp, { recursive: true, force: true }); });
let n = 0;
const A = 'ws-founder-a'; const B = 'ws-founder-b';
const staticDir = new URL('../../../prototype/intake-work-items', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

// "Now" is local noon on 26 October 2026, so "today" means the same thing in any time zone the tests run in.
const NOW = new Date(2026, 9, 26, 12, 0, 0).getTime();
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const TODAY_AM = iso(new Date(2026, 9, 26, 9, 0, 0));
const TODAY_LATE = iso(new Date(2026, 9, 26, 23, 59, 0));
const YESTERDAY = iso(new Date(2026, 9, 25, 23, 59, 0));
const ALL_PATHS = ['/', '/styles.css', '/app.js', '/data.js', '/api/owner'];

const f = (name: string, value: string | null) => ({ name, value, confidence: value === null ? null : 0.9, found: value !== null });
function rec(tenant: string, id: string, over: Partial<IntakeRecord> = {}): IntakeRecord {
  return {
    item_id: id, workspace_id: tenant, call_ref: callRefFor(tenant, `call-${id}`), received_at: TODAY_AM, category: 'Emergency leak', status: 'ready', reasons: [], missing_fields: [],
    fields: [f('Address', '[ADDRESS_1]'), f('Job description', 'burst pipe'), f('Preferred date', 'tomorrow morning')], pii_summary: [{ type: 'Address', count: 1 }], confidence: 0.77,
    versions: { skill: 'skill-v9', model: 'model-m9', prompt: 'prompt-p9' }, handed_off: true, turns: 7, confirmation: 'confirmed', address_status: 'unverified', ...over,
  };
}
const NO_ADDRESS: Partial<IntakeRecord> = { fields: [f('Job description', 'replace a tap')], address_status: 'none' };
const UNCONFIRMED: Partial<IntakeRecord> = { confirmation: 'unconfirmed', status: 'needs-human', handed_off: false, reasons: ['not_confirmed'] };

const open = (path = join(tmp, `r${++n}.sqlite`)) => { const s = createIntakeRecordStore({ path }); closers.push(() => s.close()); return s; };
async function serve(store: IntakeRecordStore, over: Record<string, unknown> = {}) {
  const d = createDashboardServer({ store, tenant: A, staticDir, now: () => NOW, ...over } as never);
  const port = await d.listen(0); closers.push(() => d.close());
  return { d, port, get: (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${p}`, init) };
}
const seeded = () => {
  const s = open();
  s.put(A, rec(A, 'wi-id-one', { received_at: TODAY_AM, ...UNCONFIRMED }));
  s.put(A, rec(A, 'wi-id-two', { received_at: TODAY_LATE, ...NO_ADDRESS }));
  s.put(A, rec(A, 'wi-id-old', { received_at: YESTERDAY }));
  s.put(B, rec(B, 'wi-id-other', { fields: [f('Job description', 'OTHER-TENANT-CANARY')], address_status: 'none' }));
  return s;
};
const leaves = (x: unknown): string[] => (typeof x === 'string' ? [x] : x !== null && typeof x === 'object' ? Object.values(x).flatMap(leaves) : []);

test('dashboard routes: the page, its styles, its script and its data are served, as GET and HEAD, with the right types', async () => {
  const { port, get } = await serve(seeded());
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
  const html = await page.text();
  assert.match(html, /<script src="data\.js">/); assert.match(html, /<script src="app\.js">/);
  assert.match((await get('/styles.css')).headers.get('content-type') ?? '', /^text\/css/);
  assert.match((await get('/app.js')).headers.get('content-type') ?? '', /^text\/javascript/);
  assert.match((await get('/data.js')).headers.get('content-type') ?? '', /^text\/javascript/);
  assert.match((await get('/api/owner')).headers.get('content-type') ?? '', /^application\/json/);
  for (const p of [...ALL_PATHS, '/index.html']) assert.equal((await fetch(`http://127.0.0.1:${port}${p}`, { method: 'HEAD' })).status, 200, p);
});

test('owner data: only the allow-listed shape, only this tenant, and the counts are the true ones for the owner\'s day', async () => {
  const { get } = await serve(seeded());
  const body: any = await (await get('/api/owner')).json();
  assert.deepEqual(Object.keys(body).sort(), ['calls', 'summary']);
  assert.deepEqual(body.summary, { intakesReceivedToday: 2, intakesReceivedTotal: 3, needFollowUp: 2, withRequestedTime: 2, confirmedByCaller: 2 });
  assert.equal(body.calls.length, 3);
  for (const c of body.calls) assert.deepEqual(Object.keys(c).sort(), ['addressGiven', 'at', 'details', 'needsFollowUp', 'nextActions', 'request', 'requestedTime', 'statusText', 'summary']);
  assert.deepEqual(body.calls.map((c: any) => c.at), [TODAY_LATE, TODAY_AM, YESTERDAY], 'newest first');
  assert.ok(!JSON.stringify(body).includes('OTHER-TENANT-CANARY'), 'another tenant\'s record never appears');
  assert.ok(leaves(body).join(' ').includes('replace a tap'), 'this tenant\'s own request is there');
});

test('owner data: nothing technical, identifying or masked is sent at all, by /api/owner or by /data.js', async () => {
  const { get } = await serve(seeded());
  for (const p of ['/api/owner', '/data.js']) {
    const text = await (await get(p)).text();
    for (const s of ['wi-id-', 'skill-v9', 'model-m9', 'prompt-p9', 'confidence', 'versions', 'reasons', 'not_confirmed', 'needs-human', 'ADDRESS_', 'PERSON_', 'call_ref', 'item_id', 'handed', 'turns', 'pii', 'workspace', 'ws-founder', callRefFor(A, 'call-wi-id-one'), 'OTHER-TENANT-CANARY']) {
      assert.ok(!text.includes(s), `${p} must not contain "${s}"`);
    }
  }
  for (const s of leaves(await (await get('/api/owner')).json())) assert.ok(!/[[\]]/.test(s), s);
});

test('owner data: a token inside a stored value is sent as "(withheld)", never as the token', async () => {
  const s = open();
  s.put(A, rec(A, 'wi-1', { fields: [f('Job description', 'leak near [ADDRESS_2] again')], address_status: 'none' }));
  const body: any = await (await (await serve(s)).get('/api/owner')).json();
  assert.equal(body.calls[0].summary, 'leak near (withheld) again');
});

test('headers: every response has the fixed headers and one strict page policy', async () => {
  const { get } = await serve(seeded());
  for (const p of ALL_PATHS) {
    const r = await get(p);
    const csp = r.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'none'/, p); assert.match(csp, /script-src 'self'/); assert.match(csp, /style-src 'self'/); assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /base-uri 'none'/); assert.match(csp, /form-action 'none'/);
    assert.ok(!/unsafe-inline|unsafe-eval|\*|https?:/.test(csp), csp);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin');
  }
});

test('restrictions: GET and HEAD only, no query or fragment, exact paths only, loopback Host only', async () => {
  const { port, get } = await serve(seeded());
  for (const p of ALL_PATHS) {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await fetch(`http://127.0.0.1:${port}${p}`, { method, body: method === 'DELETE' ? undefined : 'x' })).status, 405, `${method} ${p}`);
  }
  for (const q of ['/?x=1', '/api/owner?tenant=ws-founder-b', '/api/owner?workspace_id=ws-founder-b', '/app.js?v=1', '/styles.css?x', '/data.js?x=1', '/api/owner?']) assert.equal((await get(q)).status, 400, q);
  for (const p of ['/index.html/', '/api/owner/', '/api/owner/x', '/api/owner.json', '/api/Owner', '/api/OWNER', '/app.js.map', '/App.js', '/styles.css/', '/data.json', '/%61pp.js', '/..%2fapp.js', '/../package.json', '/%2e%2e/package.json']) {
    assert.equal((await get(p)).status, 404, p);
  }
  assert.equal(await (await get('/api/owner/')).text(), '{"error":"NOT_FOUND"}');
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/owner', headers: { Host: 'evil.example.test' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 421, 'a Host that is not loopback is refused (DNS rebinding)');
});

test('one dashboard: the retired owner page and the old engineering route are gone, from the routes, the code and the folder tree', async () => {
  const { get } = await serve(seeded());
  for (const p of ['/owner', '/owner/', '/owner.js', '/owner.css', '/owner.html', '/OWNER', '/api/items', '/api/items/x', '/prototype/owner-view/owner.js']) assert.equal((await get(p)).status, 404, p);
  assert.equal(existsSync(new URL('../../../prototype/owner-view', import.meta.url)), false, 'the duplicate folder is gone');
  const server = readFileSync(new URL('../src/dashboard-server.ts', import.meta.url), 'utf8');
  const entry = readFileSync(new URL('../src/founder-call-entry.ts', import.meta.url), 'utf8');
  for (const [name, code] of [['dashboard-server.ts', server], ['founder-call-entry.ts', entry]] as const) {
    const live = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/ownerDir|OWNER_STATIC|owner-view\/|'\/owner'|\/owner\.(?:js|css)/.test(live), `${name} still mentions the retired owner page`);
  }
  assert.ok(!/ownerDir/.test(server), 'there is no second page directory setting');
  assert.match(entry, /Owner dashboard: http:\/\/127\.0\.0\.1:\$\{config\.dashboard_port\}\/ /, 'the startup message names the one dashboard address');
  assert.ok(!/Owner view:|\/owner\b/.test(entry.replace(/\/\/.*$/gm, '')), 'the startup message no longer points at /owner');
});

test('server: it listens on loopback only, only reads, and checks its clock and directory at setup', () => {
  const s = open();
  for (const bad of [{ staticDir: '' }, { staticDir: 7 }, { now: 5 }, { tenant: '' }, { store: {} }]) assert.throws(() => createDashboardServer({ store: s, tenant: A, staticDir, ...bad } as never), RangeError, JSON.stringify(bad));
  const code = readFileSync(new URL('../src/dashboard-server.ts', import.meta.url), 'utf8');
  assert.ok(/server\.listen\(p, '127\.0\.0\.1'/.test(code) && !/0\.0\.0\.0|'::'|hostname|options\.host/.test(code));
  assert.ok(!/writeFile|appendFile|unlink|createWriteStream|\.put\(|\.purge\(/.test(code), 'the server only reads');
});

test('failures: a failing, tampered or malformed store gives a fixed 503 and leaks nothing; the static page does not need the store', async () => {
  const path = join(tmp, `t${++n}.sqlite`);
  const s = createIntakeRecordStore({ path }); s.put(A, rec(A, 'wi-a')); s.close();
  const raw = new DatabaseSync(path); raw.exec('DROP TRIGGER records_no_update'); raw.exec("UPDATE records SET body = '{\"leak\":\"CANARY-OWNER-1\"}'"); raw.close();
  const { get } = await serve(open(path));
  for (const p of ['/api/owner', '/data.js']) {
    const r = await get(p);
    assert.equal(r.status, 503, p);
    assert.equal(await r.text(), '{"error":"UNAVAILABLE"}');
  }
  assert.equal((await get('/')).status, 200);
  // A store that hands back something that is not a record is refused too, with the same fixed answer.
  const odd = { list: () => [{ hello: 'CANARY-OWNER-2' }], put: () => 'new', purge: () => 0, close: () => {} } as unknown as IntakeRecordStore;
  const r2 = await (await serve(odd)).get('/api/owner');
  assert.equal(r2.status, 503);
  assert.equal(await r2.text(), '{"error":"UNAVAILABLE"}');
});

test('reading: asking never changes the store', async () => {
  const path = join(tmp, `ro${++n}.sqlite`);
  const s = createIntakeRecordStore({ path }); s.put(A, rec(A, 'wi-a')); s.close();
  const count = () => { const db = new DatabaseSync(path, { readOnly: true }); try { return (db.prepare('SELECT count(*) AS c FROM records').get() as { c: number }).c; } finally { db.close(); } };
  const before = count();
  const { get } = await serve(open(path));
  for (let i = 0; i < 3; i++) for (const p of ALL_PATHS) await get(p);
  assert.equal(count(), before);
});

test('owner day: the owner\'s "today" is the server machine\'s calendar day, from its start to the start of the next', () => {
  const b = localDayBounds(NOW);
  assert.match(b.fromIso, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/); assert.match(b.toIso, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(b.fromIso, iso(new Date(2026, 9, 26, 0, 0, 0)));
  assert.equal(b.toIso, iso(new Date(2026, 9, 27, 0, 0, 0)));
  const midnight = new Date(2026, 9, 26, 0, 0, 0).getTime();
  assert.equal(localDayBounds(midnight).fromIso, b.fromIso, 'the first instant of the day belongs to that day');
  assert.equal(localDayBounds(midnight - 1000).toIso, b.fromIso, 'one second earlier belongs to the day before');
  for (const t of [NOW, midnight + 86_400_000 - 1000, new Date(2026, 2, 8, 12).getTime(), new Date(2026, 10, 1, 12).getTime()]) {
    const d = localDayBounds(t);
    assert.ok(Date.parse(d.fromIso) <= t && t < Date.parse(d.toIso));
    const hours = (Date.parse(d.toIso) - Date.parse(d.fromIso)) / 3_600_000;
    assert.ok(hours >= 23 && hours <= 25, `a day is ${hours} hours`);
  }
});
