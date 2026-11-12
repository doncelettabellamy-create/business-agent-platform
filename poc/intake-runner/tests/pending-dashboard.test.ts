// The owner dashboard's "Bookings needing a person" panel (Stage 1; offline): the cached snapshot (src/pending-snapshot.ts), GET /api/pending on the existing dashboard server, and the small panel script (prototype/intake-work-items/pending.js).
// A temporary folder per test, the test protector (reversible, NOT secure), made-up ids: nothing touches the real private folder, a provider or the network (the dashboard listens on loopback only).
// What they keep: the booking, Jobber, voice and email code is untouched; the panel reads only a cached snapshot; it shows a reference and a state word and nothing else; and anything doubtful is "could not check", never "nothing needs a person".
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { runInNewContext } from 'node:vm';
import { createDashboardServer, pendingBodyFor } from '../src/dashboard-server.ts';
import { createIntakeRecordStore } from '../src/intake-record-store.ts';
import { createVault } from '../src/jobber-connector.ts';
import type { Protector } from '../src/jobber-connector.ts';
import { markerFor } from '../src/jobber-booking.ts';
import { pendingReport } from '../src/jobber-ledger-scan.ts';
import { createPendingSnapshot, MAX_ITEMS, sanitizeSource } from '../src/pending-snapshot.ts';
import { fakeBrowser } from './helpers/fake-dom.ts';

const fakeProtector: Protector = { protect: async (p) => `P1:${Buffer.from([...Buffer.from(p)].reverse()).toString('hex')}`, unprotect: async (b) => Buffer.from(Buffer.from(b.slice(3), 'hex').reverse()).toString() };
const root = mkdtempSync(join(tmpdir(), 'pending-dash-'));
const closers: Array<() => unknown> = [];
after(async () => { for (const c of closers.reverse()) try { await c(); } catch { /* already closed */ } rmSync(root, { recursive: true, force: true }); });
let n = 0; const fresh = (): string => mkdtempSync(join(root, `p${++n}-`));
const dirUrl = new URL('../../../prototype/intake-work-items/', import.meta.url);
const staticDir = dirUrl.pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '');
const PAGE_JS = readFileSync(new URL('pending.js', dirUrl), 'utf8');
const HTML = readFileSync(new URL('index.html', dirUrl), 'utf8');

const keyOf = (k: number): string => `fast2-${String(k).padStart(24, '0')}`;
const refOf = (k: number): string => markerFor(keyOf(k));
const baseOf = (k: number): string => `jobber-booking-ledger-${refOf(k).toLowerCase()}`;
type Entry = { state: string; clientId?: string; propertyId?: string; jobId?: string };
const CREATED: Entry = { state: 'created', clientId: 'CLIENT-LEDGERID-1', propertyId: 'PROP-LEDGERID-1', jobId: 'JOB-LEDGERID-1' };
const PENDING: Entry = { state: 'pending' };
const CLIENT: Entry = { state: 'client_created', clientId: 'CLIENT-LEDGERID-3', propertyId: 'PROP-LEDGERID-3' };
async function put(dir: string, k: number, gen: number, entry: Entry): Promise<void> { writeFileSync(join(dir, `${baseOf(k)}.${gen}.enc`), await fakeProtector.protect(JSON.stringify({ version: 2, marker: refOf(k), gen, entry }))); }
const chain = async (dir: string, k: number, entries: Entry[]): Promise<void> => { for (let g = 0; g < entries.length; g++) await put(dir, k, g + 1, entries[g]); };
const readerOf = (dir: string) => () => pendingReport(createVault(dir, fakeProtector));
const REF = (k: number) => refOf(k);
const good = (verdict: string, items: Array<{ ref: string; state: string }> = []) => async () => ({ scan: { verdict }, items });

// ================================================================ the snapshot
test('SNAPSHOT before any scan it is unknown (never none); after a good scan it is none or some, sorted, with only a reference and a state word', async () => {
  let t = 1_000_000; const s = createPendingSnapshot({ read: good('some', [{ ref: REF(2), state: 'client_created' }, { ref: REF(1), state: 'pending' }]), now: () => t });
  assert.deepEqual(s.view(), { status: 'unknown', asOf: null, items: [] });
  await s.refresh(); const v = s.view();
  assert.equal(v.status, 'some'); assert.deepEqual(v.items.map((i) => i.ref), [REF(1), REF(2)].sort()); assert.deepEqual(Object.keys(v).sort(), ['asOf', 'items', 'status']);
  for (const i of v.items) assert.deepEqual(Object.keys(i).sort(), ['ref', 'state']);
  assert.match(v.asOf!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  const none = createPendingSnapshot({ read: good('none'), now: () => t }); await none.refresh(); assert.deepEqual([none.view().status, none.view().items], ['none', []]);
});

test('SNAPSHOT a scan that throws, or answers in a shape that cannot be trusted, is unknown at once; and it recovers on the next good scan', async () => {
  const bad: Array<[string, () => Promise<unknown>]> = [
    ['throws', async () => { throw new Error('boom SECRET'); }],
    ['not an object', async () => 'x'], ['no scan', async () => ({ items: [] })], ['a verdict that is not a verdict', good('fine')],
    ['no item list', async () => ({ scan: { verdict: 'none' } })], ['an item that is not an object', async () => ({ scan: { verdict: 'some' }, items: ['DREWTEST-0123456789AB'] })],
    ['a reference in lower case', good('some', [{ ref: REF(1).toLowerCase(), state: 'pending' }])], ['a reference with an id in it', good('some', [{ ref: 'DREWTEST-0123456789AB CLIENT-1', state: 'pending' }])],
    ['a path where a reference should be', good('some', [{ ref: 'C:\\Users\\x\\.drew-jobber\\jobber-booking-ledger-x.1.enc', state: 'pending' }])],
    ['a state that is not one of the two', good('some', [{ ref: REF(1), state: 'created' }])], ['"none" with a booking listed', good('none', [{ ref: REF(1), state: 'pending' }])],
    [`more than ${MAX_ITEMS} items`, good('some', Array.from({ length: MAX_ITEMS + 1 }, (_, i) => ({ ref: `DREWTEST-${String(i).padStart(12, '0').replace(/[^0-9A-F]/g, '0')}`, state: 'pending' })))],
  ];
  for (const [name, read] of bad) {
    const s = createPendingSnapshot({ read: read as never }); await s.refresh();
    assert.deepEqual(s.view(), { status: 'unknown', asOf: null, items: [] }, name);
    assert.equal(sanitizeSource(await read().catch(() => undefined)), undefined, `${name}: the pure check agrees`);
  }
  let ok = false; const s = createPendingSnapshot({ read: async () => { if (!ok) throw new Error('x'); return { scan: { verdict: 'none' }, items: [] }; } });
  await s.refresh(); assert.equal(s.view().status, 'unknown'); ok = true; await s.refresh(); assert.equal(s.view().status, 'none');
});

test('SNAPSHOT a failed scan after a good "none" shows unknown at once (not "none", not after the snapshot goes stale), and keeps the time of the last good scan', async () => {
  let t = Date.UTC(2026, 10, 11, 20, 0, 0); let fail = false;
  const s = createPendingSnapshot({ read: async () => { if (fail) throw new Error('x'); return { scan: { verdict: 'none' }, items: [] }; }, now: () => t });
  await s.refresh(); const first = s.view(); assert.equal(first.status, 'none');
  t += 30_000; fail = true; await s.refresh(); const v = s.view();
  assert.deepEqual([v.status, v.items], ['unknown', []]); assert.equal(v.asOf, first.asOf, 'asOf is the last scan that was read, not the failed one');
});

test('SNAPSHOT a stale snapshot is unknown, and so is one whose clock went backwards; "unknown" from the scan itself lists nothing', async () => {
  let t = 5_000_000; const s = createPendingSnapshot({ read: good('some', [{ ref: REF(1), state: 'pending' }]), now: () => t, staleMs: 180_000 });
  await s.refresh(); assert.equal(s.view().status, 'some');
  t += 179_000; assert.equal(s.view().status, 'some', 'still fresh');
  t += 2_000; const old = s.view(); assert.deepEqual([old.status, old.items], ['unknown', []], 'older than staleMs');
  t = 5_000_000 - 10_000; assert.equal(s.view().status, 'unknown', 'a clock that went backwards is not trusted');
  const u = createPendingSnapshot({ read: good('unknown', [{ ref: REF(1), state: 'pending' }]) }); await u.refresh(); assert.deepEqual([u.view().status, u.view().items], ['unknown', []]);
  const later = createPendingSnapshot({ read: good('some', []) }); await later.refresh(); assert.deepEqual([later.view().status, later.view().items], ['some', []], '"some" with nothing to list (an older-ledger entry) is still some');
});

test('SNAPSHOT resolution: a booking leaves the list when the ledger shows it finished, and none comes only from a scan that says none', async () => {
  const d = fresh(); await chain(d, 1, [PENDING]); await chain(d, 2, [PENDING, CLIENT]); await chain(d, 3, [CREATED]);
  const s = createPendingSnapshot({ read: readerOf(d) }); await s.refresh();
  assert.deepEqual(s.view().items, [{ ref: REF(1), state: 'pending' }, { ref: REF(2), state: 'client_created' }].sort((a, b) => (a.ref < b.ref ? -1 : 1)), 'unresolved ones only; the finished booking is not listed');
  await put(d, 1, 2, CREATED); await s.refresh();
  assert.deepEqual(s.view().items.map((i) => i.ref), [REF(2)], 'finished: gone after the next scan');
  await put(d, 2, 3, CREATED); await s.refresh(); assert.deepEqual([s.view().status, s.view().items], ['none', []]);
  writeFileSync(join(d, `${baseOf(4)}.1.enc`), 'garbage'); await s.refresh(); assert.deepEqual([s.view().status, s.view().items], ['unknown', []], 'an unreadable entry is unknown, never none');
});

test('SNAPSHOT refresh is single-flight (a burst of outcomes makes one more scan, not many) and never rejects; start scans at once and on the timer; stop ends it', async () => {
  let reads = 0; let release: () => void = () => {}; const gate = new Promise<void>((r) => { release = r; });
  const slow = createPendingSnapshot({ read: async () => { reads++; if (reads === 1) await gate; return { scan: { verdict: 'none' }, items: [] }; } });
  const p = [slow.refresh(), slow.refresh(), slow.refresh(), slow.refresh()]; release(); await Promise.all(p);
  assert.equal(reads, 2, 'four calls during one scan: that scan, and one more');
  const throwing = createPendingSnapshot({ read: async () => { throw new Error('x'); } }); await assert.doesNotReject(throwing.refresh());
  let timed = 0; const t = createPendingSnapshot({ read: async () => { timed++; return { scan: { verdict: 'none' }, items: [] }; }, intervalMs: 20 });
  t.start(); t.start(); await new Promise((r) => setTimeout(r, 130)); t.stop(); const at = timed; await new Promise((r) => setTimeout(r, 80));
  assert.ok(at >= 3, `scanned at startup and on the timer (${at})`); assert.equal(timed, at, 'stop() ends it');
});

test('SNAPSHOT hands out copies: changing what view() returned changes nothing in the snapshot', async () => {
  const s = createPendingSnapshot({ read: good('some', [{ ref: REF(1), state: 'pending' }]) }); await s.refresh();
  const v = s.view(); v.items.push({ ref: 'x', state: 'pending' }); v.items[0].ref = 'DREWTEST-FFFFFFFFFFFF'; v.status = 'none';
  assert.deepEqual(s.view().items, [{ ref: REF(1), state: 'pending' }]); assert.equal(s.view().status, 'some');
});

test('SNAPSHOT source: it imports nothing, and has no way to write, delete, call out, spawn, read the environment or log', () => {
  const src = readFileSync(new URL('../src/pending-snapshot.ts', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.deepEqual([...code.matchAll(/^\s*import\b/gm)], [], 'no imports at all');
  for (const word of ['fetch(', 'process.', 'console.', 'child_process', 'writeFile', 'appendFile', 'unlink', 'rmSync', 'renameSync', 'saveBlob', 'publishBlob', 'withLock', 'require(', 'readFile', 'readdir', 'https', 'node:']) assert.ok(!code.includes(word), word);
});

// ================================================================ GET /api/pending on the existing dashboard server
async function serve(over: Record<string, unknown> = {}) {
  const store = createIntakeRecordStore({ path: join(fresh(), 'r.sqlite') }); closers.push(() => store.close());
  const d = createDashboardServer({ store, tenant: 'ws-founder-a', staticDir, now: () => new Date(2026, 9, 26, 12).getTime(), ...over } as never);
  const port = await d.listen(0); closers.push(() => d.close());
  return { port, get: (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${p}`, init) };
}

test('ENDPOINT it answers from the cached snapshot with exactly a status, a time and the references, under the dashboard\'s own headers', async () => {
  const d = fresh(); await chain(d, 1, [PENDING, CLIENT]); await chain(d, 2, [PENDING]);
  const snap = createPendingSnapshot({ read: readerOf(d) }); await snap.refresh();
  const { get, port } = await serve({ pending: snap });
  const r = await get('/api/pending'); assert.equal(r.status, 200); assert.match(r.headers.get('content-type') ?? '', /^application\/json/);
  const body: any = await r.json();
  assert.deepEqual(Object.keys(body).sort(), ['asOf', 'items', 'status']); assert.equal(body.status, 'some');
  assert.deepEqual(body.items.map((i: any) => i.ref).sort(), [REF(1), REF(2)].sort());
  for (const i of body.items) { assert.deepEqual(Object.keys(i).sort(), ['ref', 'state']); assert.match(i.ref, /^DREWTEST-[0-9A-F]{12}$/); }
  const csp = r.headers.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'none'.*script-src 'self'.*connect-src 'self'.*frame-ancestors 'none'/); assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
  assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.equal(r.headers.get('referrer-policy'), 'no-referrer'); assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(r.headers.get('access-control-allow-origin'), null, 'no cross-origin permission is ever given');
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/pending`, { method: 'HEAD' })).status, 200);
});

test('ENDPOINT security: GET and HEAD only, no query, exact path, loopback Host only, loopback bind', async () => {
  const snap = createPendingSnapshot({ read: good('none') }); await snap.refresh();
  const s = await serve({ pending: snap });
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await fetch(`http://127.0.0.1:${s.port}/api/pending`, { method, body: method === 'DELETE' ? undefined : 'x' })).status, 405, method);
  for (const q of ['/api/pending?x=1', '/api/pending?', '/api/pending?tenant=ws-founder-b', '/pending.js?x=1']) assert.equal((await s.get(q)).status, 400, q);
  for (const p of ['/api/pending/', '/api/Pending', '/api/PENDING', '/api/pending.json', '/api/pending/x', '/%61pi/pending', '/api//pending']) assert.equal((await s.get(p)).status, 404, p);
  const status = await new Promise<number>((resolve, reject) => { const q = request({ host: '127.0.0.1', port: s.port, path: '/api/pending', headers: { Host: 'evil.example.test' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }); q.on('error', reject); q.end(); });
  assert.equal(status, 421, 'a Host that is not loopback is refused (DNS rebinding)');
  const code = readFileSync(new URL('../src/dashboard-server.ts', import.meta.url), 'utf8');
  assert.ok(/server\.listen\(p, '127\.0\.0\.1'/.test(code) && !/0\.0\.0\.0|'::'|hostname|options\.host/.test(code));
});

test('ENDPOINT privacy: the body holds no ledger path, file name, Jobber id, booking key, name, number or address, and the existing /api/owner and /data.js never carry a reference', async () => {
  const d = fresh(); await chain(d, 1, [PENDING, CLIENT]); await chain(d, 2, [PENDING, { state: 'pending', clientId: 'CLIENT-LEDGERID-2', propertyId: 'PROP-LEDGERID-2' }]);
  const snap = createPendingSnapshot({ read: readerOf(d) }); await snap.refresh();
  const { get } = await serve({ pending: snap });
  const text = await (await get('/api/pending')).text();
  for (const bad of [d, d.replace(/\\/g, '/'), 'jobber-booking-ledger', '.enc', '.drew-jobber', 'LEDGERID', 'CLIENT-', 'PROP-', 'JOB-', 'fast2-', 'Users', 'C:\\', 'unreadable', 'legacy', 'chains']) assert.ok(!text.includes(bad), `the body must not contain ${bad}`);
  assert.ok(!/[0-9]{3}[-. ]?[0-9]{3}[-. ]?[0-9]{4}/.test(text.replace(/DREWTEST-[0-9A-F]{12}/g, '')) && !/@/.test(text), 'no number or email address');
  for (const p of ['/api/owner', '/data.js', '/', '/app.js']) assert.ok(!(await (await get(p)).text()).includes('DREWTEST-'), `${p} never carries a booking reference`);
});

test('ENDPOINT the existing dashboard is preserved: without a snapshot /api/pending does not exist, and /api/owner, /data.js and the page are byte-for-byte the same with or without it', async () => {
  const without = await serve(); const snap = createPendingSnapshot({ read: good('some', [{ ref: REF(1), state: 'pending' }]) }); await snap.refresh(); const withIt = await serve({ pending: snap });
  assert.equal((await without.get('/api/pending')).status, 404); assert.equal(await (await without.get('/api/pending')).text(), '{"error":"NOT_FOUND"}');
  for (const p of ['/api/owner', '/data.js', '/', '/index.html', '/app.js', '/styles.css']) assert.equal(await (await withIt.get(p)).text(), await (await without.get(p)).text(), p);
  const js = await withIt.get('/pending.js'); assert.equal(js.status, 200); assert.match(js.headers.get('content-type') ?? '', /^text\/javascript/); assert.equal(await js.text(), PAGE_JS);
});

test('ENDPOINT a snapshot that throws, lies or contradicts itself gives unknown (200), never none; and the request never runs a scan', async () => {
  const views: Array<[string, unknown]> = [
    ['throws', null], ['not an object', 'x'], ['a status that is not one', { status: 'fine', asOf: null, items: [] }], ['a time that is not a time', { status: 'none', asOf: 'yesterday', items: [] }],
    ['items missing', { status: 'none', asOf: null }], ['none with a booking', { status: 'none', asOf: null, items: [{ ref: REF(1), state: 'pending' }] }], ['unknown with a booking', { status: 'unknown', asOf: null, items: [{ ref: REF(1), state: 'pending' }] }],
    ['a reference with an id', { status: 'some', asOf: null, items: [{ ref: 'DREWTEST-0123456789AB-CLIENT-9', state: 'pending' }] }], ['a state that is not allowed', { status: 'some', asOf: null, items: [{ ref: REF(1), state: 'created' }] }],
  ];
  for (const [name, v] of views) {
    const s = await serve({ pending: { view: () => { if (v === null) throw new Error('boom'); return v; } } });
    const r = await s.get('/api/pending'); assert.equal(r.status, 200, name); assert.deepEqual(await r.json(), { status: 'unknown', asOf: null, items: [] }, name);
  }
  let scans = 0; const snap = createPendingSnapshot({ read: async () => { scans++; return { scan: { verdict: 'none' }, items: [] }; } });
  const s = await serve({ pending: snap }); const before = await (await s.get('/api/pending')).json();
  for (let i = 0; i < 5; i++) await s.get('/api/pending');
  assert.equal(scans, 0, 'requests never scan the ledger'); assert.deepEqual(before, { status: 'unknown', asOf: null, items: [] }, 'before any scan it says unknown');
});

test('ENDPOINT extra fields on the snapshot are dropped field by field, never passed through', () => {
  const body = JSON.parse(pendingBodyFor({ view: () => ({ status: 'some', asOf: '2026-11-11T20:00:00Z', secret: 'S', path: 'C:\\x', items: [{ ref: REF(1), state: 'pending', clientId: 'CLIENT-1', dir: 'C:\\y' }] }) }));
  assert.deepEqual(body, { status: 'some', asOf: '2026-11-11T20:00:00Z', items: [{ ref: REF(1), state: 'pending' }] });
  assert.deepEqual(JSON.parse(pendingBodyFor(undefined)), { status: 'unknown', asOf: null, items: [] });
});

test('ENDPOINT resolution end to end: a booking listed from the ledger disappears from the endpoint once the ledger shows it finished and the snapshot refreshes', async () => {
  const d = fresh(); await chain(d, 1, [PENDING]); const snap = createPendingSnapshot({ read: readerOf(d) }); await snap.refresh();
  const { get } = await serve({ pending: snap });
  assert.deepEqual((await (await get('/api/pending')).json() as any).items, [{ ref: REF(1), state: 'pending' }]);
  await put(d, 1, 2, CREATED); await snap.refresh();
  const b: any = await (await get('/api/pending')).json(); assert.deepEqual([b.status, b.items], ['none', []]);
});

// ================================================================ the panel script, run against a stand-in DOM
const ok = (data: unknown, status = 200) => () => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(data) });
const down = () => Promise.reject(new Error('down'));
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
async function boot(answers: Array<() => Promise<unknown>>) {
  const calls: Array<{ url: string; init: any }> = []; let k = 0;
  const b = fakeBrowser({ fetch: (url: string, init: unknown) => { calls.push({ url, init }); return answers[Math.min(k++, answers.length - 1)](); } });
  const panel = b.node('pending'); panel.hidden = true;   // index.html starts the panel hidden
  runInNewContext(PAGE_JS, { window: b.window, document: b.document }); await flush();
  const again = async () => { const t = b.timers.filter((x) => !x.cancelled).at(-1); t?.fn(); await flush(); };
  return { b, calls, panel, text: () => panel.textContent, again };
}
const SOME = { status: 'some', asOf: '2026-11-11T20:00:00Z', items: [{ ref: 'DREWTEST-ABCDEF012345', state: 'pending' }, { ref: 'DREWTEST-123456789ABC', state: 'client_created' }] };

test('PANEL "some": it shows the references and a plain state for each, and asks only GET /api/pending', async () => {
  const p = await boot([ok(SOME)]);
  assert.equal(p.panel.hidden, false); const t = p.text();
  assert.match(t, /Bookings needing a person/); assert.ok(t.includes('DREWTEST-ABCDEF012345') && t.includes('DREWTEST-123456789ABC'));
  assert.match(t, /DREWTEST-ABCDEF012345: started; Jobber has not confirmed the outcome/); assert.match(t, /DREWTEST-123456789ABC: the customer was created in Jobber; the visit is not confirmed/);
  assert.match(t, /Search for the reference in Jobber/);
  assert.deepEqual(p.calls.map((c) => c.url), ['/api/pending']); assert.equal(p.calls[0].init.method, 'GET'); assert.equal(p.calls[0].init.cache, 'no-store'); assert.equal(p.calls[0].init.credentials, 'same-origin');
  assert.ok(p.b.timers.some((x) => x.ms === 15000 && !x.cancelled), 'it refreshes itself');
});

test('PANEL "none" hides it; "some" with nothing to list says so; it is never shown as an empty "all clear"', async () => {
  const none = await boot([ok({ status: 'none', asOf: null, items: [] })]); assert.equal(none.panel.hidden, true); assert.equal(none.text(), '');
  const legacy = await boot([ok({ status: 'some', asOf: null, items: [] })]); assert.equal(legacy.panel.hidden, false); assert.match(legacy.text(), /cannot be listed here/);
  assert.ok(!/no bookings|nothing needs|all clear/i.test(legacy.text()));
});

test('PANEL "unknown" says plainly that Drew could not check; it never reads as none', async () => {
  const p = await boot([ok({ status: 'unknown', asOf: null, items: [] })]);
  assert.equal(p.panel.hidden, false); assert.match(p.text(), /could not check whether any bookings need a person/);
  assert.ok(!/no bookings|nothing needs|all clear|none/i.test(p.text().replace(/Bookings needing a person/, '')));
});

test('PANEL once it has worked, a failure to reach the server, a bad status or a bad shape becomes "could not check", never none; a server without the panel (404) shows nothing', async () => {
  for (const [name, bad] of [['network down', down], ['server error', ok({}, 503)], ['wrong shape', ok({ status: 'none' })], ['an unknown status word', ok({ status: 'fine', asOf: null, items: [] })], ['a hostile reference', ok({ status: 'some', asOf: null, items: [{ ref: '<img src=x onerror=alert(1)>', state: 'pending' }] })]] as const) {
    const p = await boot([ok(SOME), bad]); assert.match(p.text(), /DREWTEST-ABCDEF012345/, name);
    await p.again(); assert.equal(p.panel.hidden, false, name); assert.match(p.text(), /could not check/, name); assert.ok(!p.text().includes('<img') && !/onerror/.test(p.text()), name);
  }
  const first = await boot([down]); assert.equal(first.panel.hidden, true, 'before it has ever worked a failure shows nothing (an older server has no panel)');
  const none = await boot([ok({ status: 'none', asOf: null, items: [] }), down]); await none.again(); assert.match(none.text(), /could not check/, 'after a good "none", a failure is not "none"');
  const old = await boot([ok({}, 404)]); assert.equal(old.panel.hidden, true); assert.equal(old.text(), '');
  const back = await boot([ok(SOME), ok({ status: 'none', asOf: null, items: [] })]); await back.again(); assert.equal(back.panel.hidden, true, 'resolved: the panel goes away');
});

test('PANEL rendering is text only: it creates only headings, paragraphs and list items, and a reference is never treated as markup', async () => {
  const p = await boot([ok(SOME)]);
  assert.ok(p.b.created.every((t) => ['h2', 'p', 'ul', 'li'].includes(t)), `created: ${[...new Set(p.b.created)].join(',')}`);
  const code = PAGE_JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const banned of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /\beval\b/, /new Function/, /\bFunction\(/, /document\.write/, /indexedDB/, /localStorage/, /sessionStorage/, /XMLHttpRequest/, /WebSocket/, /sendBeacon/, /https?:\/\//, /\bimport\s*\(/, /\.src\s*=/, /setAttribute\('on/]) assert.ok(!banned.test(code), String(banned));
  assert.deepEqual([...code.matchAll(/fetch\(\s*'([^']+)'/g)].map((m) => m[1]), ['/api/pending']);
  assert.equal(code.includes('POST'), false);
});

// ================================================================ the page, and nothing else changed
test('PAGE index.html has the panel and loads its script after the existing two; the existing app script is untouched in what it asks for', () => {
  assert.ok(HTML.includes('id="pending"') && /<section id="pending"[^>]* hidden>/.test(HTML), 'the panel starts hidden');
  assert.deepEqual([...HTML.matchAll(/<script[^>]*>/g)].map((m) => m[0]), ['<script src="data.js">', '<script src="app.js">', '<script src="pending.js">']);
  assert.ok(!/<style|style=|\son[a-z]+=|https?:\/\//i.test(HTML));
  const app = readFileSync(new URL('app.js', dirUrl), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.deepEqual([...app.matchAll(/fetch\(\s*'([^']+)'/g)].map((m) => m[1]), ['/api/owner'], 'the existing page still asks only for /api/owner');
  assert.ok(!/pending/i.test(app), 'the existing app script knows nothing of the panel');
});

test('WIRING the entry refreshes after each call outcome, starts the snapshot once serving, stops it on exit, and no booking, Jobber, voice or email file knows about the panel', () => {
  const src = readFileSync(new URL('../src/founder-voice-entry.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(/createPendingSnapshot\(\{ read: \(\) => pendingReport\(createVault\(fastDir, windowsProtector\(\)\)\) \}\)/.test(src), 'the reader is the existing read-only ledger report');
  assert.ok(/logSteps\(sink, o\.steps\); refreshPending\(\); \}/.test(src), 'after each outcome');
  assert.ok(/\.\.\.\(pendingSnapshot === undefined \? \{\} : \{ pending: pendingSnapshot \}\)/.test(src));
  assert.ok(src.indexOf('await relay.listen(config.relay_port);\npendingSnapshot?.start();') > 0, 'started once serving');
  assert.ok(/pendingSnapshot\?\.stop\(\)/.test(src));
  assert.ok(/try \{ void pendingSnapshot\?\.refresh\(\); \} catch/.test(src), 'a refresh can never interrupt a call');
  for (const f of ['fast-call-handler.ts', 'jobber-booking.ts', 'jobber-connector.ts', 'jobber-ledger-scan.ts', 'fast-email.ts', 'fast-email-copy.ts', 'founder-voice-service.ts', 'founder-voice-fast.ts', 'speaker-adapter.ts', 'elevenlabs-speech-source.ts', 'intake-record-store.ts', 'owner-view.ts']) {
    const t = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'); assert.ok(!/pending-snapshot|pendingBodyFor|\/api\/pending/.test(t), `${f} knows nothing of the panel`);
  }
  assert.equal([...src.matchAll(/appendFileSync\(/g)].length, 1, 'the entry still writes only its one log');
});
