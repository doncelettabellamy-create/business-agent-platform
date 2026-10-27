// The business owner's projection of stored intake records (src/owner-view.ts): a strict allow-list, truthful counts, fixed next actions,
// and no wording that says or implies a booked appointment. Pure: no server, no database, no browser. All data here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OWNER_LABELS, OWNER_TEXT, ownerSummary, toOwnerCall, toOwnerView } from '../src/owner-view.ts';
import type { DayBounds } from '../src/owner-view.ts';
import type { IntakeRecord } from '../src/intake-record-store.ts';

const T = 'ws-founder-a';
const f = (name: string, value: string | null, confidence = 0.9) => ({ name, value, confidence: value === null ? null : confidence, found: value !== null });
function rec(id: string, over: Partial<IntakeRecord> = {}): IntakeRecord {
  return {
    item_id: id, workspace_id: T, call_ref: '0123456789abcdef', received_at: '2026-10-26T20:09:21Z', category: 'Emergency leak', status: 'ready',
    reasons: [], missing_fields: [], fields: [f('Address', '[ADDRESS_1]'), f('Job description', 'burst pipe'), f('Preferred date', 'tomorrow morning')],
    pii_summary: [{ type: 'Address', count: 1 }, { type: 'Person', count: 2 }], confidence: 0.77, versions: { skill: 'skill-v9', model: 'model-m9', prompt: 'prompt-p9' },
    handed_off: true, turns: 7, confirmation: 'confirmed', address_status: 'unverified', ...over,
  };
}
const NO_ADDRESS: Partial<IntakeRecord> = { fields: [f('Job description', 'burst pipe')], address_status: 'none' };
const UNCONFIRMED: Partial<IntakeRecord> = { confirmation: 'unconfirmed', status: 'needs-human', handed_off: false, reasons: ['not_confirmed'] };
const DAY: DayBounds = { fromIso: '2026-10-26T07:00:00Z', toIso: '2026-10-27T07:00:00Z' };

const CALL_KEYS = ['addressGiven', 'at', 'details', 'needsFollowUp', 'nextActions', 'request', 'requestedTime', 'statusText', 'summary'];
const SUMMARY_KEYS = ['confirmedByCaller', 'intakesReceivedToday', 'intakesReceivedTotal', 'needFollowUp', 'withRequestedTime'];

test('exact keys: the owner call, the summary and the view carry only the allowed fields', () => {
  const call = toOwnerCall(rec('wi-1'));
  assert.deepEqual(Object.keys(call).sort(), CALL_KEYS);
  const view = toOwnerView([rec('wi-1'), rec('wi-2', NO_ADDRESS)], DAY);
  assert.deepEqual(Object.keys(view).sort(), ['calls', 'summary']);
  assert.deepEqual(Object.keys(view.summary).sort(), SUMMARY_KEYS);
  for (const c of view.calls) {
    assert.deepEqual(Object.keys(c).sort(), CALL_KEYS);
    for (const d of c.details) assert.deepEqual(Object.keys(d).sort(), ['label', 'value']);
  }
});

test('privacy: nothing technical or identifying is carried (confidence, codes, tokens, counts of hidden items, steps, versions, ids, the address)', () => {
  const r = rec('wi-id-should-not-appear', {
    call_ref: 'feedfacefeedface', reasons: ['unknown_category', 'low_confidence', 'not_confirmed'], missing_fields: ['Preferred date'],
    fields: [f('Address', 'SECRET-ADDRESS-VALUE'), f('Job description', 'leak near [ADDRESS_2] again'), f('Preferred date', 'tomorrow morning'), f('Number of rooms', 'four')],
    ...UNCONFIRMED,
  });
  const view = toOwnerView([r], DAY);
  const text = JSON.stringify(view);
  for (const s of ['wi-id-should-not-appear', 'feedfacefeedface', 'SECRET-ADDRESS-VALUE', 'skill-v9', 'model-m9', 'prompt-p9', 'unknown_category', 'low_confidence', 'not_confirmed',
    'needs-human', 'ADDRESS_', 'PERSON_', 'confidence', 'versions', 'steps', 'reasons', 'pii', 'turns', 'handed', 'call_ref', 'item_id', '0.77', '0.9']) {
    assert.ok(!text.includes(s), `the owner view must not contain "${s}"`);
  }
  // No text value the owner could read holds a bracket (the JSON's own array brackets are not text).
  const leaves = (x: unknown): string[] => (typeof x === 'string' ? [x] : x !== null && typeof x === 'object' ? Object.values(x).flatMap(leaves) : []);
  for (const s of leaves(view)) assert.ok(!/[[\]]/.test(s), s);
  assert.ok(leaves(view).includes('leak near (withheld) again'));
});

test('privacy: the address value is never shown, whatever it holds; the view only says that an address was given', () => {
  for (const value of ['[ADDRESS_1]', '1 5 9 5 1', '42 Elm Street', 'SECRET-ADDRESS-VALUE']) {
    const call = toOwnerCall(rec('wi-1', { fields: [f('Address', value), f('Job description', 'burst pipe')] }));
    assert.equal(call.addressGiven, true);
    assert.ok(!JSON.stringify(call).includes(value), value);
    assert.deepEqual([call.summary, call.requestedTime, call.details], ['burst pipe', null, []]);
  }
  assert.equal(toOwnerCall(rec('wi-2', NO_ADDRESS)).addressGiven, false);
});

test('privacy: a mask token inside a value becomes "(withheld)"; a value that still looks personal is dropped; brackets never survive', () => {
  const call = (value: string) => toOwnerCall(rec('wi-1', { ...NO_ADDRESS, fields: [f('Job description', value)] })).summary;
  assert.equal(call('leak near [ADDRESS_2] again'), 'leak near (withheld) again');
  assert.equal(call('[PERSON_1] [PERSON_2]'), '(withheld) (withheld)');
  assert.equal(call('call 555 010 0199'), null);
  assert.equal(call('sam@example.test'), null);
  assert.equal(call('zip 9 1 3 6 4'), null);
  assert.equal(call('42 Elm Street'), null);
  assert.equal(call('a [odd] value'), 'a odd value');
  assert.equal(call('   '), null);
  assert.equal(call('x'.repeat(500))?.length, 160);
});

test('fields: the job description is the summary, a date or time is the requested time, other details are listed, the address and unfound fields never are', () => {
  const call = toOwnerCall(rec('wi-1', {
    fields: [f('Address', '[ADDRESS_1]'), f('Job description', 'burst pipe'), f('Preferred date', 'tomorrow morning'), f('Number of rooms', 'four'), f('Preferred time', '9 to 1'), f('Pets', null)],
  }));
  assert.equal(call.summary, 'burst pipe');
  assert.equal(call.requestedTime, 'tomorrow morning');
  assert.deepEqual(call.details, [{ label: 'Number of rooms', value: 'four' }, { label: 'Preferred time', value: '9 to 1' }]);
  assert.equal(toOwnerCall(rec('wi-2', { fields: [f('Address', '[ADDRESS_1]')] })).summary, null);
  assert.equal(toOwnerCall(rec('wi-3', { fields: [] })).requestedTime, null);
  assert.equal(toOwnerCall(rec('wi-4', { fields: Array.from({ length: 20 }, (_, i) => f(`Extra ${i}`, 'x')) })).details.length, 8, 'the list of details is bounded');
});

test('request: an unknown category is "Not recognised yet"; a configured one is shown as it is; one that holds a token is not shown', () => {
  assert.equal(toOwnerCall(rec('wi-1', { category: 'unknown' })).request, OWNER_TEXT.unknownRequest);
  assert.equal(toOwnerCall(rec('wi-2', { category: 'Quote request' })).request, 'Quote request');
  assert.equal(toOwnerCall(rec('wi-3', { category: '[PERSON_1]' })).request, '(withheld)');
});

test('next actions: a fixed table over the stored state', () => {
  const actions = (over: Partial<IntakeRecord>) => toOwnerCall(rec('wi-1', over));
  // Confirmed, ready, handed off, no address issue: nothing to do but follow up.
  let c = actions(NO_ADDRESS);
  assert.deepEqual([c.nextActions, c.needsFollowUp, c.statusText], [[OWNER_TEXT.ready], false, OWNER_TEXT.confirmed]);
  // Confirmed, but the address was given and never checked.
  c = actions({});
  assert.deepEqual([c.nextActions, c.needsFollowUp], [[OWNER_TEXT.verifyAddress], true]);
  // Not confirmed by the caller (with and without an address).
  c = actions({ ...NO_ADDRESS, ...UNCONFIRMED });
  assert.deepEqual([c.nextActions, c.needsFollowUp, c.statusText], [[OWNER_TEXT.followUpUnconfirmed], true, OWNER_TEXT.notConfirmed]);
  c = actions(UNCONFIRMED);
  assert.deepEqual(c.nextActions, [OWNER_TEXT.followUpUnconfirmed, OWNER_TEXT.verifyAddress]);
  // Missing fields are asked for by their configured names.
  c = actions({ ...NO_ADDRESS, ...UNCONFIRMED, missing_fields: ['Preferred date', 'Number of rooms'] });
  assert.deepEqual(c.nextActions, [OWNER_TEXT.followUpUnconfirmed, 'Ask for: Preferred date, Number of rooms.']);
  // An unknown category is for a person to decide.
  c = actions({ ...NO_ADDRESS, ...UNCONFIRMED, category: 'unknown' });
  assert.deepEqual(c.nextActions, [OWNER_TEXT.followUpUnconfirmed, OWNER_TEXT.decideKind]);
  // Every action together, in a fixed order.
  c = actions({ ...UNCONFIRMED, category: 'unknown', missing_fields: ['Preferred date'] });
  assert.deepEqual(c.nextActions, [OWNER_TEXT.followUpUnconfirmed, OWNER_TEXT.verifyAddress, 'Ask for: Preferred date.', OWNER_TEXT.decideKind]);
  // A confirmed record that is not ready or not handed off is never reported as ready.
  c = actions({ ...NO_ADDRESS, status: 'needs-human', handed_off: false });
  assert.deepEqual([c.nextActions, c.needsFollowUp], [[OWNER_TEXT.review], true]);
  c = actions({ ...NO_ADDRESS, handed_off: false });
  assert.deepEqual([c.nextActions, c.needsFollowUp], [[OWNER_TEXT.review], true]);
  // A missing-field name that holds a token is not shown.
  c = actions({ ...NO_ADDRESS, ...UNCONFIRMED, missing_fields: ['[PERSON_1]'] });
  assert.deepEqual(c.nextActions, [OWNER_TEXT.followUpUnconfirmed]);
});

test('no booking is ever implied: no output mentions an appointment, a schedule or a booking, and the label says "not booked"', () => {
  const records = [rec('wi-1'), rec('wi-2', NO_ADDRESS), rec('wi-3', UNCONFIRMED), rec('wi-4', { category: 'unknown', ...UNCONFIRMED, missing_fields: ['Preferred date'] })];
  const text = JSON.stringify(toOwnerView(records, DAY));
  assert.ok(!/appointment|schedul|book(?:ed|ing)?\b/i.test(text), text);
  assert.ok(!/appointment|schedul/i.test(JSON.stringify(OWNER_TEXT) + JSON.stringify(OWNER_LABELS)));
  assert.match(OWNER_LABELS.requestedTime, /not booked/);
  assert.equal(OWNER_LABELS.intakesToday, 'Intakes received today');
});

test('counts: each is a count of the records given, with the day as the viewer gives it; nothing is added', () => {
  const at = (t: string, over: Partial<IntakeRecord> = {}) => rec(`wi-${t}`, { received_at: t, ...over });
  const records = [
    at('2026-10-26T06:59:59Z'),                                     // just before the day; confirmed, address unchecked (follow-up), has a requested time
    at('2026-10-26T07:00:00Z', NO_ADDRESS),                         // first instant of the day: counts; ready, no requested time
    at('2026-10-26T20:09:21Z', UNCONFIRMED),                        // today, not confirmed (follow-up), has a requested time
    at('2026-10-27T06:59:59Z', NO_ADDRESS),                         // last instant of the day: counts; ready, no requested time
    at('2026-10-27T07:00:00Z', NO_ADDRESS),                         // first instant of the next day; ready, no requested time
  ];
  const s = toOwnerView(records, DAY).summary;
  assert.deepEqual(s, { intakesReceivedToday: 3, intakesReceivedTotal: 5, needFollowUp: 2, withRequestedTime: 2, confirmedByCaller: 4 });
  // Changing one record changes exactly the counts it should.
  const s2 = toOwnerView(records.map((r, i) => (i === 2 ? { ...r, confirmation: 'confirmed' as const, status: 'ready' as const, handed_off: true, reasons: [] } : r)), DAY).summary;
  assert.deepEqual([s2.intakesReceivedToday, s2.intakesReceivedTotal, s2.confirmedByCaller], [3, 5, 5]);
  // Nothing at all gives zeros, not made-up numbers.
  assert.deepEqual(toOwnerView([], DAY).summary, { intakesReceivedToday: 0, intakesReceivedTotal: 0, needFollowUp: 0, withRequestedTime: 0, confirmedByCaller: 0 });
  // The summary is a function of the calls alone.
  const calls = records.map(toOwnerCall);
  assert.deepEqual(ownerSummary(calls, DAY), s);
});

test('day bounds: two ISO UTC instants with the start before the end; anything else is refused', () => {
  const calls = [toOwnerCall(rec('wi-1'))];
  for (const bad of [undefined, null, {}, { fromIso: DAY.toIso, toIso: DAY.fromIso }, { fromIso: DAY.fromIso, toIso: DAY.fromIso }, { fromIso: '2026-10-26', toIso: DAY.toIso },
    { fromIso: DAY.fromIso, toIso: 'tomorrow' }, { fromIso: 12, toIso: DAY.toIso }]) {
    assert.throws(() => ownerSummary(calls, bad as never), RangeError, JSON.stringify(bad));
  }
});

test('order and purity: newest first, the input is not changed, and the output cannot be changed', () => {
  const records = [rec('wi-a', { received_at: '2026-10-26T10:00:00Z' }), rec('wi-b', { received_at: '2026-10-26T12:00:00Z' }), rec('wi-c', { received_at: '2026-10-26T11:00:00Z' })];
  const before = structuredClone(records);
  const view = toOwnerView(records, DAY);
  assert.deepEqual(view.calls.map((c) => c.at), ['2026-10-26T12:00:00Z', '2026-10-26T11:00:00Z', '2026-10-26T10:00:00Z']);
  assert.deepEqual(records, before);
  assert.ok(Object.isFrozen(view) && Object.isFrozen(view.summary) && Object.isFrozen(view.calls[0]) && Object.isFrozen(view.calls[0].nextActions) && Object.isFrozen(view.calls[0].details));
  assert.deepEqual(toOwnerView(records, DAY), view, 'the same input gives the same output');
});

test('bad input is refused, never guessed at', () => {
  const good = rec('wi-1');
  for (const bad of [null, undefined, 'x', 12, {}, { ...good, received_at: 'yesterday' }, { ...good, confirmation: 'maybe' }, { ...good, address_status: 'verified' }, { ...good, status: 'done' },
    { ...good, fields: 'x' }, { ...good, fields: [null] }, { ...good, handed_off: 'yes' }, { ...good, missing_fields: null }, { ...good, category: 7 }]) {
    assert.throws(() => toOwnerCall(bad as never), RangeError, JSON.stringify(bad));
  }
  assert.throws(() => toOwnerView('x' as never, DAY), RangeError);
  assert.throws(() => toOwnerView([good, null as never], DAY), RangeError);
});

test('inventory: the module is pure (no I/O, no clock, no environment, no network) and imports only the personal-data screen and a type', () => {
  const code = readFileSync(new URL('../src/owner-view.ts', import.meta.url), 'utf8');
  const imports = [...code.matchAll(/^import (?:type )?[^;]*from '([^']+)';/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['./intake-record-store.ts', './pii-screen.ts']);
  assert.ok(/^import type \{ IntakeRecord \}/m.test(code), 'the store is imported as a type only');
  for (const banned of [/node:/, /\bprocess\b/, /\bfetch\(/, /Date\.now/, /new Date\(/, /Math\.random/, /\bfs\b/, /readFile/, /writeFile/, /\bsetTimeout\b/, /\brequire\(/]) {
    assert.ok(!banned.test(code.replace(/\/\/.*$/gm, '')), String(banned));
  }
});

test('caller_confirmed: the owner is told plainly that the caller confirmed it and that nothing checked it, is not told to verify it, and no address value is carried', () => {
  const call = toOwnerCall(rec('wi-cc', { address_status: 'caller_confirmed' }));
  assert.equal(call.addressGiven, true);
  assert.ok(!call.nextActions.includes(OWNER_TEXT.verifyAddress), 'the caller already confirmed it');
  assert.deepEqual(call.nextActions, [OWNER_TEXT.ready]);
  assert.equal(call.needsFollowUp, false);
  assert.deepEqual(call.details[0], { label: 'Address', value: 'Confirmed by the caller on the phone. Not checked against any address data.' }, 'first, so it is never cut off by the details limit');
  const text = JSON.stringify(call);
  assert.ok(!/\[[A-Z]+_\d+\]|valid|verified by|usps|postal code/i.test(text.replace('Not checked against any address data', '')), 'never claims a validation, never carries a value');
  assert.ok(!/book|appointment|schedul/i.test(text));
});

test('caller_confirmed: the other statuses read exactly as before, a confirmed address on a held request is still reviewed, and an unrecognised status is refused', () => {
  const unv = toOwnerCall(rec('wi-u', { address_status: 'unverified' }));
  assert.equal(unv.addressGiven, true);
  assert.ok(unv.nextActions.includes(OWNER_TEXT.verifyAddress));
  assert.ok(!unv.details.some((d) => d.label === 'Address'));
  const none = toOwnerCall(rec('wi-n', NO_ADDRESS));
  assert.equal(none.addressGiven, false);
  const held = toOwnerCall(rec('wi-h', { address_status: 'caller_confirmed', status: 'needs-human', handed_off: false, reasons: ['human_review'] }));
  assert.deepEqual(held.nextActions, [OWNER_TEXT.review], 'confirmed address, but a person still has to look at the request');
  assert.throws(() => toOwnerCall(rec('wi-x', { address_status: 'validated' as never })), RangeError);
});
