// Durable lead capture for the fast cleaning call (offline). Temporary folders, the REAL intake record store and the REAL encrypted contact vault (with a made-up key), a made-up clock: no real call, no real data, no provider, no secret, no server.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contactsPathFor, createContactVault } from '../src/contact-vault.ts';
import type { ContactVault } from '../src/contact-vault.ts';
import { callRefFor, createIntakeRecordStore, eligibleForProcessing } from '../src/intake-record-store.ts';
import type { IntakeRecordStore } from '../src/intake-record-store.ts';
import { toOwnerView } from '../src/owner-view.ts';
import { leadRecord, leadSummary, makeLeadSaver } from '../src/fast-lead.ts';
import type { LeadFacts } from '../src/fast-lead.ts';
import { run as lookup } from '../src/contact-lookup.ts';
import { leadLine } from '../src/fast-call-handler.ts';

const root = mkdtempSync(join(tmpdir(), 'fast-lead-')); after(() => rmSync(root, { recursive: true, force: true }));
const fresh = (): string => mkdtempSync(join(root, 't-'));
const KEY = Buffer.alloc(32, 9); const TENANT = 'ws-fast-lead'; const T0 = Date.parse('2026-11-10T15:00:00Z');
const SID = (n: number): string => `CA${String(n).padStart(32, '0').replace(/0/g, 'a').slice(0, 32)}`;
const facts = (over: Partial<LeadFacts> = {}): LeadFacts => ({ reason: 'BOOKING_NOT_VERIFIED', callSid: SID(1), name: 'Testa Invented', callback: '+15550100002', steps: ['NAME_CONFIRMED', 'OFFER'], at: T0, ...over });
interface Rig { dir: string; db: string; store: IntakeRecordStore; vault: ContactVault; clock: { now: number }; save: ReturnType<typeof makeLeadSaver>; reopen(): Rig; close(): void }
function rig(dir = fresh(), clock = { now: T0 }): Rig {
  const db = join(dir, 'calls.sqlite'); const store = createIntakeRecordStore({ path: db }); const vault = createContactVault({ path: contactsPathFor(db), key: KEY, now: () => clock.now });
  const r: Rig = { dir, db, store, vault, clock, save: makeLeadSaver({ store, contacts: vault, tenant: TENANT }), reopen: () => { r.close(); return rig(dir, clock); }, close: () => { store.close(); vault.close(); } };
  return r;
}
const tok = (r: Rig): string => callRefFor(TENANT, SID(1));

test('STORED: the record AND the contact are written and read back exactly - the confirmed name and the confirmed number only, no address, no placeholder; the record carries no personal data and is never eligible for booking', () => {
  const r = rig();
  try {
    assert.equal(r.save(facts()), 'stored');
    const ref = tok(r); const rec = r.store.list(TENANT); assert.equal(rec.length, 1);
    assert.deepEqual([rec[0].status, rec[0].confirmation, rec[0].handed_off, rec[0].address_status, rec[0].category, rec[0].call_ref], ['needs-human', 'unconfirmed', false, 'none', 'cleaning', ref]);
    assert.deepEqual(rec[0].reasons, ['booking_not_verified', 'not_confirmed']); assert.equal(rec[0].received_at, '2026-11-10T15:00:00Z'); assert.equal(rec[0].turns, 2);
    assert.deepEqual(r.vault.get(TENANT, ref), { name: 'Testa Invented', phone: '5550100002', address_state: 'unconfirmed' });
    const json = JSON.stringify(rec); for (const secret of ['Testa', 'Invented', '5550100002', '555', SID(1)]) assert.ok(!json.includes(secret), `no ${secret} in the record`);
    assert.equal(eligibleForProcessing(rec[0]), false, 'a lead never becomes a booking by itself');
  } finally { r.close(); }
});

test('RECORDED, never invented: no confirmed number, no confirmed name, a number that is not a US E.164, no contact vault - each writes the record only; nothing is stored for the contact and no placeholder name exists anywhere', () => {
  const cases: Array<[string, Partial<LeadFacts>, boolean]> = [
    ['no confirmed number', { callback: undefined }, true], ['no confirmed name', { name: undefined }, true], ['neither', { name: undefined, callback: undefined }, true],
    ['a number that is not +1 and ten digits', { callback: '+4420712345' }, true], ['an eleven digit US number', { callback: '+155501000023' }, true], ['digits without the plus', { callback: '5550100002' }, true],
    ['no contact vault', {}, false],
  ];
  for (const [label, over, withVault] of cases) {
    const dir = fresh(); const db = join(dir, 'calls.sqlite'); const store = createIntakeRecordStore({ path: db }); const vault = createContactVault({ path: contactsPathFor(db), key: KEY, now: () => T0 });
    try {
      const save = makeLeadSaver({ store, ...(withVault ? { contacts: vault } : {}), tenant: TENANT });
      assert.equal(save(facts(over)), 'recorded', label); assert.equal(store.list(TENANT).length, 1, label); assert.equal(vault.list(TENANT).length, 0, label + ': no contact row'); assert.equal(vault.get(TENANT, tok({} as Rig)), undefined, label);
    } finally { store.close(); vault.close(); }
  }
});

test('NOTHING is offered to the vault unless the caller confirmed it: with no confirmed name, or no confirmed US number, the vault is never even asked (a vault that would accept anything is not given a placeholder)', () => {
  const r = rig();
  try {
    const puts: unknown[] = []; const permissive = { ...r.vault, put: (...a: unknown[]) => { puts.push(a); }, get: () => ({ name: 'x', phone: '5550100002', address_state: 'unconfirmed' }) } as unknown as ContactVault;
    const save = makeLeadSaver({ store: r.store, contacts: permissive, tenant: TENANT });
    assert.equal(save(facts({ name: undefined, callSid: SID(5) })), 'recorded'); assert.equal(save(facts({ callback: undefined, callSid: SID(6) })), 'recorded'); assert.equal(save(facts({ callback: '+442071234567', callSid: SID(7) })), 'recorded'); assert.equal(save(facts({ callback: 'not a number', callSid: SID(8) })), 'recorded');
    assert.deepEqual(puts, [], 'never offered'); assert.equal(r.store.list(TENANT).length, 4, 'the records were still written');
  } finally { r.close(); }
});

test('FAILED, and no personal data left behind: a store that throws, a record that reads back differently, a Call SID that cannot make a call reference, a reason of the wrong shape - the contact is NEVER written when the record is not', () => {
  const r = rig();
  try {
    const throwing = { ...r.store, put: () => { throw new Error('disk full'); } } as unknown as IntakeRecordStore;
    assert.equal(makeLeadSaver({ store: throwing, contacts: r.vault, tenant: TENANT })(facts()), 'failed'); assert.equal(r.vault.list(TENANT).length, 0, 'no orphan contact');
    const lying = { ...r.store, put: () => 'new', list: () => [] } as unknown as IntakeRecordStore;
    assert.equal(makeLeadSaver({ store: lying, contacts: r.vault, tenant: TENANT })(facts()), 'failed'); assert.equal(r.vault.list(TENANT).length, 0, 'a record that is not there is not enough');
    const altered = { ...r.store, put: () => 'new', list: () => [{ ...leadRecord(TENANT, tok(r), facts()), reasons: ['other', 'not_confirmed'] }] } as unknown as IntakeRecordStore;
    assert.equal(makeLeadSaver({ store: altered, contacts: r.vault, tenant: TENANT })(facts()), 'failed', 'a record that reads back differently'); assert.equal(r.vault.list(TENANT).length, 0);
    for (const bad of ['', 'CA123', `CA${'g'.repeat(32)}`, `ca${'a'.repeat(32)}`, 'x'.repeat(34)]) assert.equal(r.save(facts({ callSid: bad })), 'failed', JSON.stringify(bad));
    assert.equal(r.save(facts({ callSid: undefined as unknown as string })), 'failed');
    assert.equal(r.store.list(TENANT).length, 0, 'nothing was stored for any of those');
    assert.equal(makeLeadSaver({ store: r.store, contacts: r.vault, tenant: 'not a tenant!' })(facts()), 'failed', 'a malformed tenant is refused by the store');
    assert.equal(r.save(facts({ reason: 'lowercase reason with spaces' })), 'stored', 'a reason of the wrong shape is recorded as UNKNOWN, never as given'); assert.deepEqual(r.store.list(TENANT)[0].reasons, ['unknown', 'not_confirmed']);
  } finally { r.close(); }
});

test('PARTIAL WRITES: the record goes first; if the contact cannot be stored or read back the result is "recorded" (the record stays, no number); a contact that reads back differently is not "stored"', () => {
  const r = rig();
  try {
    const noPut = { ...r.vault, put: () => { throw new Error('locked'); } } as unknown as ContactVault;
    assert.equal(makeLeadSaver({ store: r.store, contacts: noPut, tenant: TENANT })(facts()), 'recorded'); assert.equal(r.store.list(TENANT).length, 1, 'the record stays'); assert.equal(r.vault.list(TENANT).length, 0);
    const unreadable = { ...r.vault, put: r.vault.put.bind(r.vault), get: () => { throw new Error('tampered'); } } as unknown as ContactVault;
    assert.equal(makeLeadSaver({ store: r.store, contacts: unreadable, tenant: TENANT })(facts({ callSid: SID(2) })), 'recorded');
    const different = { ...r.vault, put: () => undefined, get: () => ({ name: 'Someone Else', phone: '5550100002', address_state: 'unconfirmed' }) } as unknown as ContactVault;
    assert.equal(makeLeadSaver({ store: r.store, contacts: different, tenant: TENANT })(facts({ callSid: SID(3) })), 'recorded', 'a contact that is not exactly what was written');
    const withAddress = { ...r.vault, put: () => undefined, get: () => ({ name: 'Testa Invented', phone: '5550100002', address: '1 Invented Lane', address_state: 'confirmed' }) } as unknown as ContactVault;
    assert.equal(makeLeadSaver({ store: r.store, contacts: withAddress, tenant: TENANT })(facts({ callSid: SID(4) })), 'recorded', 'an address that was never written is not accepted');
  } finally { r.close(); }
});

test('DUPLICATE call reference: the same lead again is "stored" again with nothing doubled; another reason for the same call reads back differently and is "failed"; a second contact write is refused by the vault and the original is kept', () => {
  const r = rig();
  try {
    assert.equal(r.save(facts()), 'stored'); assert.equal(r.save(facts()), 'stored', 'the same facts: the record is a duplicate, the contact is already there and identical');
    assert.equal(r.store.list(TENANT).length, 1); assert.equal(r.vault.list(TENANT).length, 1);
    assert.equal(r.save(facts({ reason: 'SIZE_NOT_OFFERED' })), 'failed', 'the stored record is for a different ending of this call: it is not claimed'); assert.deepEqual(r.store.list(TENANT)[0].reasons, ['booking_not_verified', 'not_confirmed'], 'the first record is untouched');
    assert.equal(r.save(facts({ callback: '+15550100004' })), 'recorded', 'a different number for the same call: the vault keeps the first and the new one is not claimed'); assert.equal(r.vault.get(TENANT, tok(r))?.phone, '5550100002');
  } finally { r.close(); }
});

test('RESTART: after both files are closed and reopened, the record and the contact are still there and read back exactly; the owner view still counts the item', () => {
  const a = rig(); assert.equal(a.save(facts()), 'stored'); const b = a.reopen();
  try {
    assert.equal(b.store.list(TENANT).length, 1); assert.deepEqual(b.vault.get(TENANT, tok(b)), { name: 'Testa Invented', phone: '5550100002', address_state: 'unconfirmed' });
    assert.equal(b.save(facts()), 'stored', 'saving again after a restart is a safe repeat');
    const view = toOwnerView(b.store.list(TENANT), { fromIso: '2026-11-10T06:00:00Z', toIso: '2026-11-11T06:00:00Z' });
    assert.equal(view.summary.needFollowUp, 1); assert.equal(view.calls[0].needsFollowUp, true); assert.equal(view.calls[0].statusText, 'Not confirmed by the caller'); assert.equal(view.calls[0].summary, leadSummary('BOOKING_NOT_VERIFIED'));
    assert.ok(/Check Jobber/.test(String(view.calls[0].summary)), 'the owner is told why, in words'); const shown = JSON.stringify(view); for (const secret of ['Testa', '5550100002', SID(1), 'booking_not_verified']) assert.ok(!shown.includes(secret), `no ${secret} in the owner view`);
  } finally { b.close(); }
});

test('RETENTION: the contact is gone 30 days after it was stored (the lookup says so), the record stays on the dashboard without a number, and nothing of the number remains in the vault file', () => {
  const clock = { now: T0 }; const r = rig(fresh(), clock);
  try {
    assert.equal(r.save(facts()), 'stored'); clock.now = T0 + 29 * 86_400_000; assert.ok(r.vault.get(TENANT, tok(r)), 'still there on day 29');
    clock.now = T0 + 30 * 86_400_000 + 1000; assert.equal(r.vault.get(TENANT, tok(r)), undefined); assert.equal(r.vault.list(TENANT).length, 0);
    assert.equal(r.store.list(TENANT).length, 1, 'the dashboard item remains (the record store has no retention)');
    const out: string[] = []; const err: string[] = [];
    const code = lookup(['--show', tok(r), '--config', cfgFor(r)], { FOUNDER_CONTACT_KEY: KEY.toString('base64') }, { out: (l) => out.push(l), err: (l) => err.push(l), isTty: true }, () => clock.now);
    assert.equal(code, 1); assert.match(err.join(' '), /past its 30-day retention/);
    const file = readFileSync(contactsPathFor(r.db)); assert.ok(!file.includes(Buffer.from('5550100002')) && !file.includes(Buffer.from('Testa')), 'the vault file never held the plain number or name');
  } finally { r.close(); }
});

function cfgFor(r: Rig): string { const p = join(r.dir, 'founder-call.config.json'); writeFileSync(p, JSON.stringify({ tenant: TENANT, db_path: r.db })); return p; }

test('OWNER RETRIEVAL: the real lookup tool lists the lead with its call time, and shows the right name and number for the right call among two leads, only on a terminal and only with the key', () => {
  const clock = { now: T0 }; const r = rig(fresh(), clock);
  try {
    assert.equal(r.save(facts({ at: T0 })), 'stored'); clock.now = T0 + 3_600_000;
    assert.equal(r.save(facts({ callSid: SID(2), at: T0 + 3_600_000, name: 'Other Person', callback: '+15550100004', reason: 'ADDRESS_NOT_CONFIRMED' })), 'stored');
    const cfg = cfgFor(r); const env = { FOUNDER_CONTACT_KEY: KEY.toString('base64') };
    const list: string[] = []; assert.equal(lookup(['--list', '--config', cfg], env, { out: (l) => list.push(l), err: () => undefined, isTty: false }, () => clock.now), 0);
    assert.equal(list.length, 2); assert.match(list[0], new RegExp(`^${callRefFor(TENANT, SID(2))}  call 2026-11-10T16:00:00Z  cleaning  stored `)); assert.match(list[1], new RegExp(`^${tok(r)}  call 2026-11-10T15:00:00Z  cleaning  stored `));
    const view = toOwnerView(r.store.list(TENANT), { fromIso: '2026-11-10T06:00:00Z', toIso: '2026-11-11T06:00:00Z' }); assert.deepEqual(view.calls.map((c) => c.at), ['2026-11-10T16:00:00Z', '2026-11-10T15:00:00Z'], 'the dashboard times match the list times');
    for (const [sid, name, phone] of [[SID(1), 'Testa Invented', '5550100002'], [SID(2), 'Other Person', '5550100004']] as const) {
      const out: string[] = []; assert.equal(lookup(['--show', callRefFor(TENANT, sid), '--config', cfg], env, { out: (l) => out.push(l), err: () => undefined, isTty: true }, () => clock.now), 0);
      assert.deepEqual(out.slice(0, 3), [`Name:    ${name}`, `Phone:   ${phone}`, 'Address: (none kept)']); assert.match(out[3], /NOT confirmed by the caller/);
    }
    const err: string[] = [];
    assert.equal(lookup(['--show', tok(r), '--config', cfg], env, { out: () => undefined, err: (l) => err.push(l), isTty: false }, () => clock.now), 78, 'never into a pipe');
    assert.equal(lookup(['--show', tok(r), '--config', cfg], {}, { out: () => undefined, err: (l) => err.push(l), isTty: true }, () => clock.now), 78, 'never without the key');
  } finally { r.close(); }
});

test('TENANT isolation: another tenant sees neither the record nor the contact, and a call reference is different per tenant', () => {
  const r = rig();
  try {
    assert.equal(r.save(facts()), 'stored'); assert.deepEqual(r.store.list('ws-someone-else'), []); assert.equal(r.vault.get('ws-someone-else', tok(r)), undefined); assert.deepEqual(r.vault.list('ws-someone-else'), []);
    assert.notEqual(callRefFor(TENANT, SID(1)), callRefFor('ws-someone-else', SID(1)));
    const other = makeLeadSaver({ store: r.store, contacts: r.vault, tenant: 'ws-someone-else' }); assert.equal(other(facts()), 'stored'); assert.equal(r.store.list(TENANT).length, 1); assert.equal(r.store.list('ws-someone-else').length, 1, 'each tenant has its own');
  } finally { r.close(); }
});

test('SUMMARY sentences: every reason class has a fixed sentence the PII screen accepts, with no code and no value in it', () => {
  const reasons = ['ADDRESS_NOT_CONFIRMED', 'ADDRESS_INVALID', 'ADDRESS_MISSING', 'ADDRESS_UNCLEAR', 'ADDRESS_UNVERIFIED', 'STATE_MISSING', 'STATE_UNCLEAR', 'NAME_UNCLEAR', 'NAME_NOT_CONFIRMED', 'NAME_UNCONFIRMED', 'WHEN_UNCLEAR', 'NO_OPENING', 'NO_LONGER_AVAILABLE', 'CALENDAR_UNREADABLE', 'SIZE_UNCLEAR', 'SIZE_NOT_OFFERED', 'NUMBER_UNCLEAR', 'BOOKING_NOT_VERIFIED', 'BOOKING_CHANGED', 'FIELD_NOT_SUPPORTED', 'UNCONFIRMED', 'NO_STANDING_APPROVAL', 'UNKNOWN'];
  const r = rig();
  try {
    const seen = new Set<string>();
    reasons.forEach((reason, i) => { assert.equal(r.save(facts({ reason, callSid: SID(i + 1) })), 'stored', reason); const s = leadSummary(reason); assert.match(s, /^Cleaning request not completed(: [a-z ,.A-Z]+)?\.$/, reason); assert.ok(!/[_0-9]/.test(s), reason); seen.add(s); });
    assert.equal(r.store.list(TENANT).length, reasons.length); assert.ok(seen.size >= 7, 'the classes differ');
  } finally { r.close(); }
});

// ================================================================ the spoken outcome (the one place that chooses it)
const ORIGINALS: Array<[string, string, string]> = [
  ['Sorry, I am having trouble with that, so a person will follow up. Goodbye.', 'Sorry, I am having trouble with that. Your request is recorded. Goodbye.', 'giveUp'],
  ['Sorry, on this test line I can only book two bedroom, two bathroom homes, so a person will follow up. Goodbye.', 'Sorry, on this test line I can only book two bedroom, two bathroom homes. Your request is recorded. Goodbye.', 'SIZE_NOT_OFFERED'],
  ['Sorry, I cannot check the schedule right now, so a person will call you to set a time. Goodbye.', 'Sorry, I cannot check the schedule right now. Your request is recorded. Goodbye.', 'CALENDAR_UNREADABLE'],
  ['Sorry, I do not have an opening in the next two weeks, so a person will call you. Goodbye.', 'Sorry, I do not have an opening in the next two weeks. Your request is recorded. Goodbye.', 'NO_OPENING'],
  ['Sorry, I can only change the address on this call, so nothing was booked and a person will follow up. Goodbye.', 'Sorry, I can only change the address on this call, so nothing was booked. Your request is recorded. Goodbye.', 'FIELD_NOT_SUPPORTED'],
  ['Your request is recorded, and a person will confirm the booking. Goodbye.', 'Your request is recorded. Goodbye.', 'ADDRESS_* and the standing approval'],
  ['Sorry, that time is no longer available, so nothing was booked and a person will call you. Goodbye.', 'Sorry, that time is no longer available, so nothing was booked. Your request is recorded. Goodbye.', 'NO_LONGER_AVAILABLE'],
  ['Sorry, I cannot check the schedule right now, so nothing was booked and a person will call you. Goodbye.', 'Sorry, I cannot check the schedule right now, so nothing was booked. Your request is recorded. Goodbye.', 'CALENDAR_UNREADABLE (re-check)'],
  ['I could not confirm the booking, so a person will follow up. Goodbye.', 'I could not confirm the booking. Your request is recorded. Goodbye.', 'BOOKING_CHANGED and BOOKING_NOT_VERIFIED'],
];
const FAILED_LINE = 'Sorry, I could not complete that, and I could not save your request. Please call back later. Goodbye.';
test('SPOKEN OUTCOME: stored with the owner\'s follow-up attestation keeps the original words; stored without it, or only recorded, says only that the request is recorded; failed says nothing was saved - and no output says a person will call except the attested one', () => {
  for (const [original, recorded, label] of ORIGINALS) {
    assert.equal(leadLine(original, 'stored', true), original, label + ': attested + stored keeps the words');
    for (const lead of ['stored', 'recorded'] as const) assert.equal(leadLine(original, lead, false), recorded, `${label}: ${lead}, not attested`);
    assert.equal(leadLine(original, 'recorded', true), recorded, label + ': an attestation without a stored number is not enough');
    assert.equal(leadLine(original, 'failed', true), FAILED_LINE, label + ': failed, even attested'); assert.equal(leadLine(original, 'failed', false), FAILED_LINE);
    for (const out of [recorded, FAILED_LINE]) { assert.ok(!/a person will|call you|follow up/i.test(out), label + ': no callback promise'); assert.ok(out.endsWith('Goodbye.')); assert.equal((out.match(/Your request is recorded/g) ?? []).length <= 1, true); }
  }
  assert.ok(!/recorded/i.test(FAILED_LINE), 'a failed save never says "recorded"');
});

test('SPOKEN OUTCOME source guard: every line in the handler that promises a person is in the table above (a new one cannot be added without a decision), and the lead is saved before the ending is spoken', () => {
  const src = readFileSync(new URL('../src/fast-call-handler.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const lines = [...src.matchAll(/'([^'\n]*a person will[^'\n]*)'|`([^`\n]*a person will[^`\n]*)`/g)].map((m) => (m[1] ?? m[2]).replace(/\$\{num\(S\.bedrooms\)\}/, 'two').replace(/\$\{num\(S\.bathrooms\)\}/, 'two'));
  assert.ok(lines.length >= 9); const known = new Set(ORIGINALS.map((o) => o[0]));
  for (const l of lines) assert.ok(known.has(l), `a promising line is covered by the table: ${l}`);
  const endBody = src.slice(src.indexOf('async function end('), src.indexOf('const giveUp'));
  assert.ok(endBody.indexOf('saveLeadFor(reason)') >= 0 && endBody.indexOf('saveLeadFor(reason)') < endBody.indexOf('t.speak('), 'saved first, then spoken');
  assert.equal([...src.matchAll(/saveLeadFor\(/g)].length, 3, 'defined once, called from the late ending and from the ending that is spoken');
});
