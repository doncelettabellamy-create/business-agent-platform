// Stage 1 G3: an owner email notice that was not delivered is an append-only record that the owner's dashboard shows under "Need follow-up", is never counted as an intake, and carries nothing personal. The dashboard also says plainly when the owner's email notices are OFF.
// Offline: an in-memory store, the real owner view, a real loopback dashboard server on an ephemeral port, and the page script run against a stand-in DOM.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createDashboardServer, dataScriptFor } from '../src/dashboard-server.ts';
import { callRefFor, createIntakeRecordStore } from '../src/intake-record-store.ts';
import type { IntakeRecord, IntakeRecordStore } from '../src/intake-record-store.ts';
import { makeNoticeFailureSaver, NOTICE_CATEGORY, NOTICE_REASON, noticeRecord, noticeSentence } from '../src/fast-lead.ts';
import type { NoticeVerdict } from '../src/fast-lead.ts';
import { OWNER_TEXT, toOwnerCall, toOwnerView } from '../src/owner-view.ts';
import { fakeBrowser } from './helpers/fake-dom.ts';

const TENANT = 'ws-notice-test'; const SID = `CA${'cd'.repeat(16)}`; const NOW = Date.parse('2026-11-12T18:00:00Z');
const DAY = { fromIso: '2026-11-12T07:00:00Z', toIso: '2026-11-13T07:00:00Z' };
const VERDICTS: NoticeVerdict[] = ['refused', 'failed', 'timeout'];
const f = (name: string, value: string | null) => ({ name, value, confidence: value === null ? null : 0.9, found: value !== null });
const intake = (n: number, over: Partial<IntakeRecord> = {}): IntakeRecord => ({
  item_id: `wi-${n}`, workspace_id: TENANT, call_ref: n.toString(16).padStart(16, '0'), received_at: '2026-11-12T16:00:00Z', category: 'cleaning', status: 'ready', reasons: [], missing_fields: [],
  fields: [f('job description', 'Standard cleaning'), f('requested time', 'Tuesday at ten')], pii_summary: [], confidence: 0.9, versions: { skill: 'fast-test', model: 'scripted', prompt: 'p' }, handed_off: true, turns: 4, confirmation: 'confirmed', address_status: 'none', ...over,
});

// ---------------------------------------------------------------- the saver and the record
test('record: each outcome is a safe, needs-human, unconfirmed record with its own fixed sentence, an item id linked to the lead, and a call reference that is not the lead\'s', () => {
  const store = createIntakeRecordStore({ path: ':memory:' });
  for (const [i, verdict] of VERDICTS.entries()) {
    const sid = `CA${String(i).repeat(32)}`; const save = makeNoticeFailureSaver({ store, tenant: TENANT });
    assert.equal(save({ callSid: sid, verdict, at: NOW }), 'recorded', verdict);
    const lead = callRefFor(TENANT, sid); const mine = store.list(TENANT).find((r) => r.item_id === `fast-notice-${lead}`)!;
    assert.deepEqual([mine.category, mine.status, mine.confirmation, mine.handed_off, mine.address_status, mine.reasons, mine.turns, mine.pii_summary], [NOTICE_CATEGORY, 'needs-human', 'unconfirmed', false, 'none', [`notice_${verdict}`, 'not_confirmed'], 0, []], verdict);
    assert.deepEqual(mine.fields, [{ name: 'request', value: noticeSentence(verdict), confidence: null, found: true }]); assert.notEqual(mine.call_ref, lead); assert.equal(mine.call_ref, callRefFor(TENANT, `${sid}:notice`));
    assert.ok(NOTICE_REASON.test(mine.reasons[0]));
  }
  assert.equal(new Set(VERDICTS.map(noticeSentence)).size, 3, 'three different sentences');
  for (const v of VERDICTS) { const s = noticeSentence(v); assert.ok(!/\d/.test(s) && !/@/.test(s), 'no digit and no address in a sentence'); assert.ok(s.length <= 200); }
  store.close();
});

test('saver refusals: a bad Call SID, an unknown outcome, a store that throws and a store that reads back something else are all "failed", and nothing is thrown', () => {
  const store = createIntakeRecordStore({ path: ':memory:' }); const save = makeNoticeFailureSaver({ store, tenant: TENANT });
  for (const bad of ['', 'CA123', 'ca' + 'a'.repeat(32), `CA${'a'.repeat(31)}`, `CA${'g'.repeat(32)}`, undefined, null, 12]) assert.equal(save({ callSid: bad as unknown as string, verdict: 'refused', at: NOW }), 'failed', String(bad));
  assert.equal(save({ callSid: SID, verdict: 'whatever' as unknown as NoticeVerdict, at: NOW }), 'failed'); assert.equal(store.list(TENANT).length, 0, 'nothing was written');
  const throws = { put() { throw new Error('disk'); }, list() { return []; }, purge() { return 0; }, close() { /* none */ } } as unknown as IntakeRecordStore;
  assert.equal(makeNoticeFailureSaver({ store: throws, tenant: TENANT })({ callSid: SID, verdict: 'refused', at: NOW }), 'failed');
  const other = { put() { return 'new'; }, list() { return [{ ...noticeRecord(TENANT, 'a'.repeat(16), callRefFor(TENANT, `${SID}:notice`), { callSid: SID, verdict: 'refused', at: NOW }), reasons: ['notice_failed', 'not_confirmed'] }]; }, purge() { return 0; }, close() { /* none */ } } as unknown as IntakeRecordStore;
  assert.equal(makeNoticeFailureSaver({ store: other, tenant: TENANT })({ callSid: SID, verdict: 'refused', at: NOW }), 'failed', 'what was read back differs');
  assert.equal(makeNoticeFailureSaver({ store: { put() { return 'new'; }, list() { throw new Error('x'); }, purge() { return 0; }, close() { /* none */ } } as unknown as IntakeRecordStore, tenant: TENANT })({ callSid: SID, verdict: 'refused', at: NOW }), 'failed');
  store.close();
});

// ---------------------------------------------------------------- the owner view
test('owner view: a notice record is its own kind with fixed words, needs follow-up, carries no detail, and shows nothing technical (no reference, id, reason code or sentence from the record beyond the fixed one)', () => {
  for (const verdict of VERDICTS) {
    const r = noticeRecord(TENANT, callRefFor(TENANT, SID), callRefFor(TENANT, `${SID}:notice`), { callSid: SID, verdict, at: NOW }); const c = toOwnerCall(r);
    assert.equal(c.kind, 'notice'); assert.equal(c.request, OWNER_TEXT.noticeRequest); assert.equal(c.statusText, OWNER_TEXT.noticeStatus); assert.equal(c.needsFollowUp, true); assert.deepEqual(c.nextActions, [OWNER_TEXT.noticeAction]);
    assert.deepEqual([c.requestedTime, c.details, c.addressGiven], [null, [], false]); assert.equal(c.summary, noticeSentence(verdict));
    const text = JSON.stringify(c); for (const s of ['fast-notice', r.call_ref, r.item_id, `notice_${verdict}`, 'owner-notice', 'not_confirmed', SID]) assert.equal(text.includes(s), false, 'not shown: ' + s);
  }
  assert.ok(Object.isFrozen(toOwnerCall(noticeRecord(TENANT, 'a'.repeat(16), 'b'.repeat(16), { callSid: SID, verdict: 'refused', at: NOW }))));
});

test('owner view: the intake counts leave notice records out, "Need follow-up" counts them, and an ordinary intake is untouched', () => {
  const lead = intake(1, { status: 'needs-human', confirmation: 'unconfirmed', reasons: ['booking_not_verified', 'not_confirmed'], handed_off: false });
  const ok = intake(2); const n = (i: number, v: NoticeVerdict) => noticeRecord(TENANT, `${i}`.repeat(16), `${i + 3}`.repeat(16), { callSid: SID, verdict: v, at: NOW - i });
  const view = toOwnerView([lead, ok, n(1, 'refused'), n(2, 'timeout')], DAY);
  assert.deepEqual(view.summary, { intakesReceivedToday: 2, intakesReceivedTotal: 2, needFollowUp: 3, withRequestedTime: 2, confirmedByCaller: 1 });
  assert.equal(view.calls.filter((c) => c.kind === 'notice').length, 2); assert.equal(view.calls.filter((c) => c.kind === 'intake').length, 2);
  assert.equal(toOwnerCall(ok).kind, 'intake'); assert.deepEqual(toOwnerView([n(1, 'failed')], DAY).summary, { intakesReceivedToday: 0, intakesReceivedTotal: 0, needFollowUp: 1, withRequestedTime: 0, confirmedByCaller: 0 });
});

test('owner view: only the exact pair (the category AND one of the three reasons) makes a notice; either alone is an ordinary intake, and the literals match the voice code\'s', () => {
  const real = noticeRecord(TENANT, 'a'.repeat(16), 'b'.repeat(16), { callSid: SID, verdict: 'refused', at: NOW });
  assert.equal(toOwnerCall({ ...real, category: 'cleaning' }).kind, 'intake'); assert.equal(toOwnerCall({ ...real, reasons: ['other', 'not_confirmed'] }).kind, 'intake'); assert.equal(toOwnerCall({ ...real, reasons: ['notice_refused_x', 'not_confirmed'] }).kind, 'intake');
  assert.equal(toOwnerCall(real).kind, 'notice'); assert.equal(NOTICE_CATEGORY, 'owner-notice');
  const view = readFileSync(new URL('../src/owner-view.ts', import.meta.url), 'utf8'); assert.ok(view.includes("const NOTICE_CATEGORY = 'owner-notice'") && view.includes(String(NOTICE_REASON).slice(1, -1).replace(/\//g, '/')), 'the same literals');
  assert.deepEqual([...view.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]), ['./intake-record-store.ts', './pii-screen.ts', './followup-marker.ts'], 'the owner view imports nothing from the voice code (only the pure follow-up marker rules)');
});

// ---------------------------------------------------------------- the dashboard server and the page
const servers: Array<{ close(): Promise<void> }> = [];
after(async () => { for (const s of servers) await s.close(); });
async function serve(emailNotices?: 'on' | 'off', records: IntakeRecord[] = []) {
  const store = createIntakeRecordStore({ path: ':memory:' }); for (const r of records) store.put(TENANT, r);
  const d = createDashboardServer({ store, tenant: TENANT, staticDir: fileURLToPath(new URL('../../../prototype/intake-work-items', import.meta.url)), now: () => NOW, ...(emailNotices === undefined ? {} : { emailNotices }) });
  const port = await d.listen(0); servers.push(d);
  const get = (path: string): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => { const q = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (x) => { b += x; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b })); }); q.on('error', reject); q.end(); });
  return { get, store };
}

test('dashboard: with emailNotices the owner data carries exactly {notices:{email}} (a word, nothing else) in /api/owner and /data.js; without it neither has the key; a bad value is refused at creation', async () => {
  const off = await serve('off'); const o = JSON.parse((await off.get('/api/owner')).body); assert.deepEqual(o.notices, { email: 'off' }); assert.deepEqual(Object.keys(o).sort(), ['calls', 'notices', 'summary']);
  assert.ok((await off.get('/data.js')).body.includes('"notices":{"email":"off"}'));
  const on = await serve('on'); assert.deepEqual(JSON.parse((await on.get('/api/owner')).body).notices, { email: 'on' });
  const plain = await serve(); const p = JSON.parse((await plain.get('/api/owner')).body); assert.deepEqual(Object.keys(p).sort(), ['calls', 'summary']); assert.ok(!(await plain.get('/data.js')).body.includes('notices'));
  const store = createIntakeRecordStore({ path: ':memory:' });
  for (const bad of ['ON', 'yes', '', 1, null, true]) assert.throws(() => createDashboardServer({ store, tenant: TENANT, staticDir: '.', emailNotices: bad as unknown as 'on' }), RangeError, String(bad));
  assert.ok(dataScriptFor({ calls: [], summary: { intakesReceivedToday: 0, intakesReceivedTotal: 0, needFollowUp: 0, withRequestedTime: 0, confirmedByCaller: 0 }, notices: { email: 'off' } }).includes('"email":"off"')); store.close();
});

test('dashboard: a notice record shows in /api/owner as its own kind, outside the intake counts, and nothing in the response holds a reference, an item id or a reason code; the security surface (paths, methods) is unchanged', async () => {
  const rec = noticeRecord(TENANT, callRefFor(TENANT, SID), callRefFor(TENANT, `${SID}:notice`), { callSid: SID, verdict: 'timeout', at: NOW });
  const s = await serve('off', [intake(1), rec]); const body = (await s.get('/api/owner')).body; const o = JSON.parse(body);
  assert.deepEqual(o.summary, { intakesReceivedToday: 1, intakesReceivedTotal: 1, needFollowUp: 1, withRequestedTime: 1, confirmedByCaller: 1 }); assert.deepEqual(o.calls.map((c: { kind: string }) => c.kind).sort(), ['intake', 'notice']);
  for (const x of ['fast-notice', rec.call_ref, 'notice_timeout', 'owner-notice', SID]) assert.equal(body.includes(x), false, 'not in the response: ' + x);
  assert.equal((await s.get('/api/owner?x=1')).status, 400); assert.equal((await s.get('/api/notices')).status, 404);
});

const PAGE_JS = readFileSync(new URL('../../../prototype/intake-work-items/app.js', import.meta.url), 'utf8');
const ok = (data: unknown) => () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
const SUMMARY = { intakesReceivedToday: 0, intakesReceivedTotal: 0, needFollowUp: 0, withRequestedTime: 0, confirmedByCaller: 0 };
async function page(first: unknown, served: unknown) {
  const b = fakeBrowser({ fetch: ok(served) }); const banner = b.node('banner'); banner.hidden = true;
  (b.window as Record<string, unknown>).PROTO_DATA = first;
  runInNewContext(PAGE_JS, { window: b.window, document: b.document }); await flush();
  return { banner };
}

test('page: when the server says the owner\'s email notices are OFF the banner says so plainly; ON, or a server that does not say, shows nothing; the sample banner and the error banner are unchanged', async () => {
  const off = await page(undefined, { calls: [], summary: SUMMARY, notices: { email: 'off' } }); assert.equal(off.banner.hidden, false); assert.match(off.banner.textContent, /Email notices to you are OFF/); assert.match(off.banner.textContent, /check this page/);
  const on = await page(undefined, { calls: [], summary: SUMMARY, notices: { email: 'on' } }); assert.equal(on.banner.hidden, true); assert.equal(on.banner.textContent, '');
  const silent = await page(undefined, { calls: [], summary: SUMMARY }); assert.equal(silent.banner.hidden, true);
  const junk = await page(undefined, { calls: [], summary: SUMMARY, notices: { email: { x: 1 } } }); assert.equal(junk.banner.hidden, true, 'anything but the word "off" shows nothing');
  const first = await page({ calls: [], summary: SUMMARY, notices: { email: 'off' } }, { calls: [], summary: SUMMARY, notices: { email: 'on' } }); assert.equal(first.banner.hidden, true, 'the next refresh (email now on) clears it');
  assert.ok(/textContent = text === null \? '' : text/.test(PAGE_JS) && !/innerHTML|insertAdjacentHTML|document\.write|eval\(/.test(PAGE_JS), 'written as text, never as HTML');
});
