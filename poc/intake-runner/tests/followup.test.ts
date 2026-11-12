// Stage 1 G4: the owner's follow-up tool. A follow-up is marked HANDLED (or REOPENED) by APPENDING a marker record; nothing is edited, deleted or purged. Local CLI only: the dashboard stays read-only.
// Offline: an on-disk store in a private temp folder (the CLI opens its store by path), the real owner view and a real loopback dashboard server on an ephemeral port. No network, no provider.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { contactsPathFor, createContactVault } from '../src/contact-vault.ts';
import { callRefFor, createIntakeRecordStore } from '../src/intake-record-store.ts';
import type { IntakeRecord, IntakeRecordStore } from '../src/intake-record-store.ts';
import { leadRecord, noticeRecord } from '../src/fast-lead.ts';
import { changeFollowUp, run } from '../src/followup.ts';
import { followUpState, markerCallRef, markerRecord, markerSentence, MARKER_CATEGORY, MAX_TRANSITIONS, parseMarker } from '../src/followup-marker.ts';
import { OWNER_TEXT, toOwnerView } from '../src/owner-view.ts';
import { createDashboardServer } from '../src/dashboard-server.ts';

const dirs: string[] = []; after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const A = 'ws-followup-a'; const B = 'ws-followup-b'; const NOW = Date.parse('2026-11-12T18:00:00Z'); const DAY = { fromIso: '2026-11-12T07:00:00Z', toIso: '2026-11-13T07:00:00Z' };
const KEY = Buffer.alloc(32, 9); const KEY_ENV = KEY.toString('base64'); const WRONG_ENV = Buffer.alloc(32, 4).toString('base64');
const sidOf = (n: number): string => `CA${n.toString(16).padStart(32, '0')}`;
const f = (name: string, value: string | null) => ({ name, value, confidence: value === null ? null : 0.9, found: value !== null });
const readyIntake = (tenant: string, n: number): IntakeRecord => ({
  item_id: `wi-${n}`, workspace_id: tenant, call_ref: n.toString(16).padStart(16, '0'), received_at: '2026-11-12T16:00:00Z', category: 'cleaning', status: 'ready', reasons: [], missing_fields: [],
  fields: [f('job description', 'Standard cleaning'), f('requested time', 'Tuesday at ten')], pii_summary: [], confidence: 0.9, versions: { skill: 'fast-test', model: 'scripted', prompt: 'p' }, handed_off: true, turns: 4, confirmation: 'confirmed', address_status: 'none',
});
const lead = (tenant: string, n: number): IntakeRecord => leadRecord(tenant, callRefFor(tenant, sidOf(n)), { reason: 'BOOKING_NOT_VERIFIED', callSid: sidOf(n), steps: ['A', 'B'], at: NOW - n * 1000 });
const notice = (tenant: string, n: number): IntakeRecord => noticeRecord(tenant, callRefFor(tenant, sidOf(n)), callRefFor(tenant, `${sidOf(n)}:notice`), { callSid: sidOf(n), verdict: 'refused', at: NOW - n * 1000 });
const REF_LEAD_A = callRefFor(A, sidOf(1)); const REF_NOTICE_A = callRefFor(A, `${sidOf(2)}:notice`); const REF_READY_A = (3).toString(16).padStart(16, '0'); const REF_LEAD_B = callRefFor(B, sidOf(7));

/** A private temp folder with a store holding records of two tenants, the encrypted contact vault the CLI proves the key against, and the config. */
function world(opts: { vault?: boolean; config?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'followup-')); dirs.push(dir); const db = join(dir, 'records.sqlite'); const config = join(dir, 'call.config.json');
  const store = createIntakeRecordStore({ path: db });
  for (const r of [lead(A, 1), notice(A, 2), readyIntake(A, 3), lead(B, 7)]) store.put(r.workspace_id, r);
  if (opts.vault !== false) createContactVault({ path: contactsPathFor(db), key: KEY, now: () => NOW }).close();
  if (opts.config !== false) writeFileSync(config, JSON.stringify({ tenant: A, db_path: db }));
  const reopen = (): IntakeRecordStore => { store.close(); return createIntakeRecordStore({ path: db }); };
  return { dir, db, config, store, reopen };
}
function cli(w: { config: string }, args: string[], over: { env?: Record<string, string | undefined>; tty?: boolean } = {}) {
  const out: string[] = []; const err: string[] = [];
  const code = run(['--config', w.config, ...args], over.env ?? { FOUNDER_CONTACT_KEY: KEY_ENV }, { out: (l) => out.push(l), err: (l) => err.push(l), isTty: over.tty ?? true }, () => NOW);
  return { code, out, err, text: [...out, ...err].join('\n') };
}
const markersIn = (s: IntakeRecordStore, tenant: string): IntakeRecord[] => s.list(tenant).filter((r) => r.category === MARKER_CATEGORY);

// ---------------------------------------------------------------- the marker
test('marker: it is a safe, needs-human, unconfirmed record with a fixed sentence and deterministic ids; it parses back exactly; the sentences differ', () => {
  const s = createIntakeRecordStore({ path: ':memory:' });
  for (const a of ['handled', 'reopened'] as const) {
    const r = markerRecord(A, REF_LEAD_A, 1, a, NOW); assert.equal(s.put(A, r), 'new', a);
    assert.deepEqual(parseMarker(r), { ref: REF_LEAD_A, n: 1, action: a }); assert.equal(r.item_id, `fu-${REF_LEAD_A}-1`); assert.equal(r.call_ref, markerCallRef(A, REF_LEAD_A, 1)); assert.equal(r.fields[0].value, markerSentence(a));
    assert.deepEqual([r.category, r.status, r.confirmation, r.handed_off, r.turns, r.pii_summary], [MARKER_CATEGORY, 'needs-human', 'unconfirmed', false, 0, []]);
    s.purge(A, r.call_ref);
  }
  assert.notEqual(markerSentence('handled'), markerSentence('reopened'));
  const r2 = markerRecord(A, REF_LEAD_A, 2, 'handled', NOW); assert.notEqual(r2.call_ref, markerRecord(A, REF_LEAD_A, 1, 'handled', NOW).call_ref); assert.notEqual(markerCallRef(A, REF_LEAD_A, 1), markerCallRef(B, REF_LEAD_A, 1), 'tenant is part of the identity');
  assert.ok(!/\d/.test(markerSentence('handled') + markerSentence('reopened')) && JSON.stringify(r2).includes('@') === false); s.close();
});

test('marker forgeries: a record that only resembles a marker is not one - wrong hash, wrong tenant, wrong sentence, wrong number, extra reason, wrong category, wrong shape', () => {
  const good = markerRecord(A, REF_LEAD_A, 2, 'handled', NOW); assert.ok(parseMarker(good));
  const bad: Array<[string, IntakeRecord]> = [
    ['wrong call_ref', { ...good, call_ref: markerCallRef(A, REF_LEAD_A, 3) }], ['another tenant\'s hash', { ...good, call_ref: markerCallRef(B, REF_LEAD_A, 2) }],
    ['workspace changed', { ...good, workspace_id: B }], ['sentence', { ...good, fields: [{ ...good.fields[0], value: 'Marked handled.' }] }], ['two fields', { ...good, fields: [good.fields[0], good.fields[0]] }],
    ['reason', { ...good, reasons: ['follow_up_done', 'not_confirmed'] }], ['extra reason', { ...good, reasons: [...good.reasons, 'x'] }], ['category', { ...good, category: 'cleaning' }],
    ['n zero', { ...good, item_id: `fu-${REF_LEAD_A}-0` }], ['n too big', { ...good, item_id: `fu-${REF_LEAD_A}-${MAX_TRANSITIONS + 1}` }], ['n leading zero', { ...good, item_id: `fu-${REF_LEAD_A}-02` }],
    ['uppercase ref', { ...good, item_id: `fu-${REF_LEAD_A.toUpperCase()}-2` }], ['status', { ...good, status: 'ready' as const }], ['handed off', { ...good, handed_off: true }],
  ];
  for (const [label, r] of bad) assert.equal(parseMarker(r), undefined, label);
  assert.equal(parseMarker(null as unknown as IntakeRecord), undefined); assert.equal(parseMarker({} as IntakeRecord), undefined);
});

test('state: the NEWEST marker decides (whatever the order given), forged markers change nothing, and no marker means open', () => {
  const m = (n: number, a: 'handled' | 'reopened') => markerRecord(A, REF_LEAD_A, n, a, NOW);
  const recs = [m(2, 'reopened'), m(1, 'handled'), m(3, 'handled'), { ...m(9, 'reopened'), call_ref: 'f'.repeat(16) }];
  assert.deepEqual([...followUpState(recs)], [[REF_LEAD_A, { n: 3, handled: true }]]); assert.deepEqual([...followUpState([...recs].reverse())], [[REF_LEAD_A, { n: 3, handled: true }]]);
  assert.deepEqual([...followUpState([m(1, 'handled'), m(2, 'reopened')])], [[REF_LEAD_A, { n: 2, handled: false }]]); assert.equal(followUpState([]).size, 0);
});

// ---------------------------------------------------------------- the change (store level)
test('change: handled, repeat, reopen, repeat, handled again - every step appends exactly one marker or none, the original is byte-for-byte unchanged, and the history keeps growing', () => {
  const w = world(); const before = JSON.stringify(w.store.list(A).filter((r) => r.call_ref === REF_LEAD_A)[0]);
  const step = (want: 'handled' | 'reopened') => changeFollowUp(w.store, A, REF_LEAD_A, want, () => NOW);
  assert.equal(step('handled'), 'written'); assert.equal(markersIn(w.store, A).length, 1); assert.equal(step('handled'), 'already'); assert.equal(markersIn(w.store, A).length, 1, 'a repeat writes nothing');
  assert.equal(step('reopened'), 'written'); assert.equal(markersIn(w.store, A).length, 2); assert.equal(step('reopened'), 'already'); assert.equal(markersIn(w.store, A).length, 2);
  assert.equal(step('handled'), 'written'); assert.equal(markersIn(w.store, A).length, 3, 'every change is kept; nothing is purged');
  assert.deepEqual(markersIn(w.store, A).map((r) => parseMarker(r)?.n).sort(), [1, 2, 3]); assert.equal(JSON.stringify(w.store.list(A).filter((r) => r.call_ref === REF_LEAD_A)[0]), before, 'the original record is unchanged');
  assert.equal(followUpState(w.store.list(A)).get(REF_LEAD_A)?.handled, true); w.store.close();
});

test('change refusals: an unknown reference, a call that needs no follow-up, a marker as the target, reopening something never handled, and tenant isolation (the other tenant\'s follow-up is not found, and nothing is written for it)', () => {
  const w = world(); const go = (ref: string, want: 'handled' | 'reopened' = 'handled', tenant = A) => changeFollowUp(w.store, tenant, ref, want, () => NOW); const count = () => w.store.list(A).length + w.store.list(B).length;
  const n0 = count();
  assert.equal(go('0123456789abcdef'), 'not_found'); assert.equal(go(REF_READY_A), 'not_a_follow_up'); assert.equal(go(REF_LEAD_B), 'not_found', 'another tenant\'s follow-up'); assert.equal(go(REF_LEAD_A, 'reopened'), 'not_handled'); assert.equal(count(), n0, 'nothing was written');
  assert.equal(go(REF_LEAD_A), 'written'); const marker = markersIn(w.store, A)[0]; assert.equal(go(marker.call_ref), 'not_found', 'a marker is not a follow-up'); assert.equal(count(), n0 + 1);
  assert.equal(go(REF_LEAD_B, 'handled', B), 'written'); assert.equal(markersIn(w.store, B).length, 1); assert.equal(markersIn(w.store, A).length, 1, 'each tenant has only its own marker');
  assert.equal(followUpState(w.store.list(A)).has(REF_LEAD_B), false); assert.equal(followUpState(w.store.list(B)).has(REF_LEAD_A), false); w.store.close();
});

test('change limit: a follow-up can be changed at most MAX_TRANSITIONS times', () => {
  const w = world(); let last = '';
  for (let i = 0; i < MAX_TRANSITIONS; i++) last = changeFollowUp(w.store, A, REF_NOTICE_A, i % 2 === 0 ? 'handled' : 'reopened', () => NOW); assert.equal(last, 'written');
  assert.equal(changeFollowUp(w.store, A, REF_NOTICE_A, MAX_TRANSITIONS % 2 === 0 ? 'handled' : 'reopened', () => NOW), 'too_many'); assert.equal(markersIn(w.store, A).length, MAX_TRANSITIONS); w.store.close();
});

test('change failures: a store that throws, a read-back that differs, a list that fails, and a writer that always loses the race are all "failed" and throw nothing; a lost race that left the wanted state is "already"', () => {
  const w = world(); const real = w.store; const wrap = (over: Partial<IntakeRecordStore>): IntakeRecordStore => ({ put: real.put.bind(real), list: real.list.bind(real), purge: real.purge.bind(real), close: () => undefined, ...over });
  assert.equal(changeFollowUp(wrap({ put() { throw new Error('disk'); } }), A, REF_LEAD_A, 'handled', () => NOW), 'failed');
  assert.equal(changeFollowUp(wrap({ list() { throw new Error('locked'); } }), A, REF_LEAD_A, 'handled', () => NOW), 'failed');
  assert.equal(changeFollowUp(wrap({ put() { return 'new'; } }), A, REF_LEAD_A, 'handled', () => NOW), 'failed', 'reported new but nothing is there');
  assert.equal(changeFollowUp(wrap({ put() { return 'duplicate'; } }), A, REF_LEAD_A, 'handled', () => NOW), 'failed', 'a writer that keeps losing gives up after one more look');
  assert.equal(markersIn(real, A).length, 0, 'none of that wrote a marker');
  let raced = false; const racer = wrap({ put(t, r) { if (!raced) { raced = true; real.put(t, markerRecord(A, REF_LEAD_A, 1, 'handled', NOW)); return 'duplicate'; } return real.put(t, r); } });
  assert.equal(changeFollowUp(racer, A, REF_LEAD_A, 'handled', () => NOW), 'already', 'the other writer already handled it'); assert.equal(markersIn(real, A).length, 1);
  const mismatch = wrap({ list(t) { return real.list(t).map((r) => (r.category === MARKER_CATEGORY ? { ...r, received_at: '2020-01-01T00:00:00Z' } : r)); } });
  assert.equal(changeFollowUp(mismatch, A, REF_NOTICE_A, 'handled', () => NOW), 'failed', 'what was read back is not what was written'); real.close();
});

// ---------------------------------------------------------------- the owner view
test('owner view: a handled follow-up stays in All with a plain "handled" action, is not open or counted as needing follow-up, the intake counts do not move, and reopening restores it exactly; markers are never calls', () => {
  const w = world(); const records = () => w.store.list(A); const plain = toOwnerView(records(), DAY);
  assert.equal(plain.summary.needFollowUp, 2, 'the lead and the notice'); assert.equal(plain.calls.length, 3);
  changeFollowUp(w.store, A, REF_LEAD_A, 'handled', () => NOW); changeFollowUp(w.store, A, REF_NOTICE_A, 'handled', () => NOW);
  const h = toOwnerView(records(), DAY); assert.equal(h.calls.length, 3, 'still in All, and the markers are not calls'); assert.equal(h.summary.needFollowUp, 0);
  assert.deepEqual({ ...h.summary, needFollowUp: 0 }, { ...plain.summary, needFollowUp: 0 }, 'the intake counts did not move');
  assert.equal(h.calls.filter((c) => c.needsFollowUp).length, 0); assert.deepEqual(h.calls.filter((c) => c.nextActions[0] === OWNER_TEXT.handled).length, 2);
  changeFollowUp(w.store, A, REF_LEAD_A, 'reopened', () => NOW); const r = toOwnerView(records(), DAY); assert.equal(r.summary.needFollowUp, 1);
  assert.deepEqual(r.calls.find((c) => c.kind === 'intake' && c.needsFollowUp), plain.calls.find((c) => c.kind === 'intake' && c.needsFollowUp), 'reopened is exactly as it was');
  assert.equal(JSON.stringify(h).includes('fu-'), false); assert.equal(JSON.stringify(h).includes(MARKER_CATEGORY), false); w.store.close();
});

test('owner view: a forged marker changes nothing and is not shown, a marker for a call that is not there does nothing, and a ready call is never affected', () => {
  const w = world(); const forged: IntakeRecord = { ...markerRecord(A, REF_LEAD_A, 1, 'handled', NOW), call_ref: 'e'.repeat(16) };
  const ghost = markerRecord(A, '1111111111111111', 1, 'handled', NOW); const onReady = markerRecord(A, REF_READY_A, 1, 'handled', NOW);
  const v = toOwnerView([...w.store.list(A), forged, ghost, onReady], DAY); assert.equal(v.calls.length, 3, 'no marker-like record is a call'); assert.equal(v.summary.needFollowUp, 2, 'the forged one did not handle the lead');
  assert.deepEqual(v.summary, toOwnerView(w.store.list(A), DAY).summary); w.store.close();
});

// ---------------------------------------------------------------- the CLI
test('cli usage: no command, two commands, an unknown flag, a missing or bad reference, a stray value, --list with --confirm and a dangling --config are all refused (64) and write nothing', () => {
  const w = world(); const n0 = w.store.list(A).length;
  for (const args of [[], ['--list', '--handled', REF_LEAD_A], ['--list', '--x'], ['--handled'], ['--handled', 'nothex'], ['--handled', REF_LEAD_A.toUpperCase(), '--confirm'], ['--handled', `${REF_LEAD_A}0`, '--confirm'], ['--list', '--confirm'], ['--list', 'extra'], ['--purge', REF_LEAD_A, '--confirm'], ['--clear'], ['--handled', REF_LEAD_A, '--confirm', '--confirm']]) {
    const r = cli(w, args); assert.equal(r.code, 64, args.join(' ')); assert.ok(/usage/.test(r.text), args.join(' '));
  }
  const dangling = run(['--list', '--config'], { FOUNDER_CONTACT_KEY: KEY_ENV }, { out: () => undefined, err: () => undefined, isTty: true }); assert.equal(dangling, 64);
  assert.equal(w.store.list(A).length, n0); w.store.close();
});

test('cli guards: a change needs an interactive terminal and --confirm; every command needs a valid key that opens the EXISTING contact vault (a wrong key, no key, a bad key, a missing vault - which is not created - and a bad config are all refused); none of it writes', () => {
  const w = world(); const n0 = w.store.list(A).length; const write = ['--handled', REF_LEAD_A, '--confirm'];
  assert.equal(cli(w, write, { tty: false }).code, 78); assert.match(cli(w, write, { tty: false }).text, /interactive terminal/); assert.equal(cli(w, ['--handled', REF_LEAD_A]).code, 78); assert.match(cli(w, ['--handled', REF_LEAD_A]).text, /--confirm/);
  for (const env of [{}, { FOUNDER_CONTACT_KEY: '' }, { FOUNDER_CONTACT_KEY: 'short' }, { FOUNDER_CONTACT_KEY: WRONG_ENV }]) { for (const a of [write, ['--list']]) { const r = cli(w, a, { env }); assert.equal(r.code, 78, JSON.stringify(env) + a[0]); assert.ok(!r.text.includes(WRONG_ENV) && !r.text.includes(KEY_ENV), 'a key is never printed'); } }
  const nov = world({ vault: false }); assert.equal(cli(nov, ['--list']).code, 78); assert.equal(existsSync(contactsPathFor(nov.db)), false, 'the tool never creates the vault'); nov.store.close();
  const noc = world({ config: false }); assert.equal(cli(noc, ['--list']).code, 78); assert.match(cli(noc, ['--list']).text, /config/); noc.store.close();
  writeFileSync(w.config, JSON.stringify({ tenant: 5, db_path: w.db })); assert.equal(cli(w, ['--list']).code, 78);
  const after1 = createIntakeRecordStore({ path: w.db }); assert.equal(after1.list(A).length, n0, 'nothing was written'); after1.close(); w.store.close();
});

test('cli list: open and handled follow-ups only, one line each (reference, time, kind, state), no sentence and no personal data; it works without a terminal; an empty tenant says so', () => {
  const w = world(); const l1 = cli(w, ['--list'], { tty: false }); assert.equal(l1.code, 0); const line = /^[0-9a-f]{16}  \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z  (call|notice)  (open|handled)$/;
  assert.equal(l1.out.length, 2, 'the lead and the notice; not the ready call, not the other tenant'); for (const o of l1.out) assert.match(o, line);
  assert.deepEqual(l1.out.map((o) => o.split('  ')[0]).sort(), [REF_LEAD_A, REF_NOTICE_A].sort()); assert.equal(l1.text.includes(REF_LEAD_B), false); assert.equal(l1.text.includes(REF_READY_A), false);
  assert.ok(!/Cleaning request|notice to you|Invented|\d{10}/.test(l1.text), 'no sentence from any record');
  assert.equal(cli(w, ['--handled', REF_LEAD_A, '--confirm']).code, 0); const l2 = cli(w, ['--list'], { tty: false }); assert.equal(l2.out.find((o) => o.startsWith(REF_LEAD_A))?.endsWith('handled'), true); assert.equal(l2.out.length, 2, 'markers are never listed');
  const empty = world(); writeFileSync(empty.config, JSON.stringify({ tenant: 'ws-nobody', db_path: empty.db })); const e = cli(empty, ['--list']); assert.deepEqual([e.code, e.out], [0, ['No follow-ups.']]); empty.store.close(); w.store.close();
});

test('cli changes: handled, a repeat, reopen, a repeat; unknown, not-a-follow-up and other-tenant references are refused (1); exit codes and the history in the store are right', () => {
  const w = world(); const h = (a: string[]) => cli(w, a);
  const a1 = h(['--handled', REF_LEAD_A, '--confirm']); assert.deepEqual([a1.code, a1.out[0]], [0, 'Marked handled. The original record is unchanged.']);
  const a2 = h(['--handled', REF_LEAD_A, '--confirm']); assert.deepEqual([a2.code, a2.out[0]], [0, 'Already handled. Nothing was written.']);
  const a3 = h(['--reopen', REF_LEAD_A, '--confirm']); assert.deepEqual([a3.code, a3.out[0]], [0, 'Reopened. The original record is unchanged.']);
  const a4 = h(['--reopen', REF_LEAD_A, '--confirm']); assert.deepEqual([a4.code, a4.out[0]], [0, 'Already open. Nothing was written.']);
  const a5 = h(['--reopen', REF_NOTICE_A, '--confirm']); assert.deepEqual([a5.code, a5.out[0]], [0, 'Already open (it was never marked handled). Nothing was written.']);
  assert.equal(h(['--handled', '0123456789abcdef', '--confirm']).code, 1); assert.equal(h(['--handled', REF_READY_A, '--confirm']).code, 1); assert.match(h(['--handled', REF_READY_A, '--confirm']).text, /does not need follow-up/);
  assert.equal(h(['--handled', REF_LEAD_B, '--confirm']).code, 1); assert.match(h(['--handled', REF_LEAD_B, '--confirm']).text, /in this tenant/);
  const s = createIntakeRecordStore({ path: w.db }); assert.equal(markersIn(s, A).length, 2); assert.equal(markersIn(s, B).length, 0); assert.equal(followUpState(s.list(A)).get(REF_LEAD_A)?.handled, false); s.close(); w.store.close();
});

test('cli never purges, deletes or edits, and the dashboard stays read-only: source guards on the tool, the marker module, and the dashboard server', () => {
  const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const cliSrc = read('../src/followup.ts'); const marker = read('../src/followup-marker.ts'); const dash = read('../src/dashboard-server.ts'); const view = read('../src/owner-view.ts');
  assert.ok(!/\.purge\(|DELETE|UPDATE|fetch\(|node:http|node:net|node:child_process|process\.env|writeFile|unlink|rmSync|console\./i.test(cliSrc), 'the tool only appends: no purge, delete, update, network or file write');
  assert.deepEqual([...cliSrc.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]), ['node:fs', './contact-vault.ts', './intake-record-store.ts', './intake-record-store.ts', './followup-marker.ts', './followup-marker.ts', './owner-view.ts']);
  assert.deepEqual([...marker.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]), ['./intake-record-store.ts', './intake-record-store.ts']); assert.ok(!/process\.env|fetch\(|setTimeout|Date\.now|\.put\(|\.list\(/.test(marker), 'the marker module is pure');
  assert.ok(!/followup|follow-up-marker/i.test(dash), 'the dashboard server knows nothing of markers'); assert.ok(!/\bPOST\b|\.put\(/.test(dash), 'and has no write path'); assert.ok(/req\.method !== 'GET' && req\.method !== 'HEAD'/.test(dash));
  assert.ok(view.includes("from './followup-marker.ts'")); assert.ok(!/\.put\(|\.purge\(/.test(view));
});

test('dashboard: it shows a handled follow-up from the markers (read-only), a POST is still refused, and the response holds no marker, reference or id', async () => {
  const w = world(); changeFollowUp(w.store, A, REF_LEAD_A, 'handled', () => NOW);
  const d = createDashboardServer({ store: w.store, tenant: A, staticDir: fileURLToPath(new URL('../../../prototype/intake-work-items', import.meta.url)), now: () => NOW }); const port = await d.listen(0);
  try {
    const get = (method: string): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => { const q = request({ host: '127.0.0.1', port, path: '/api/owner', method }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (x) => { b += x; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b })); }); q.on('error', reject); q.end(method === 'GET' ? undefined : 'x'); });
    const g = await get('GET'); const o = JSON.parse(g.body); assert.equal(g.status, 200); assert.equal(o.summary.needFollowUp, 1); assert.equal(o.calls.length, 3); assert.equal(o.calls.filter((c: { nextActions: string[] }) => c.nextActions[0] === OWNER_TEXT.handled).length, 1);
    for (const x of [REF_LEAD_A, 'fu-', MARKER_CATEGORY, 'follow_up_']) assert.equal(g.body.includes(x), false, 'not in the response: ' + x);
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await fetch(`http://127.0.0.1:${port}/api/owner`, { method: m, body: m === 'DELETE' ? undefined : 'x' })).status, 405, m);
  } finally { await d.close(); w.store.close(); }
});
