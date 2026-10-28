// cleaning-state.ts: the validated current-call cleaning answers shared by the question choice and the saved record. Invented words only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCleaningState, kindOf, countOf, polarityOf, codeOf } from '../src/cleaning-state.ts';
import type { WorkItemV1, FieldEntry } from '../src/contracts.ts';

const fe = (name: string, value: string | null): FieldEntry => ({ name, value, confidence: value === null ? null : 0.9, found: value !== null });
const item = (fields: FieldEntry[], missing: string[] = [], reasons: WorkItemV1['reasons'] = [], status: WorkItemV1['status'] = 'ready'): WorkItemV1 => ({
  item_id: 'i1', workspace_id: 'w', source: { channel_ref: 'c', event_id: 'e' }, category: 'Standard cleaning', fields, missing_fields: missing, message_ref: 'm', pii_summary: [], status, reasons,
  versions: { skill: 's', model: 'm', prompt: 'p' },
});

test('kinds of answer follow the configured field names', () => {
  assert.deepEqual(['Number of bedrooms', 'Number of rooms', 'Cleaning frequency', 'Time window', 'Preferred date', 'Pets', 'Home empty', 'Extras', 'Priority areas', 'Job description'].map(kindOf),
    ['count', 'count', 'frequency', 'time', 'date', 'polarity', 'polarity', 'polarity', 'free', 'free']);
  assert.equal(countOf('three bedrooms'), 3); assert.equal(countOf('2 bathrooms'), 2); assert.equal(countOf('no idea'), undefined);
  assert.deepEqual([polarityOf('No.'), polarityOf('no pets'), polarityOf('yes please'), polarityOf('maybe')], ['neg', 'neg', 'pos', undefined]);
});

test('bind: a plausible answer to the question asked is context for Intake; vague, off-topic and refusing replies are ambiguous and stored nowhere', () => {
  const s = createCleaningState();
  assert.equal(s.bind('Pets', 'no pets'), 'bound');
  assert.equal(s.bind('Cleaning frequency', 'every two weeks'), 'bound');
  assert.equal(s.bind('Preferred date', 'next Tuesday'), 'bound');
  assert.equal(s.bind('Time window', 'in the morning'), 'bound');
  assert.equal(s.bind('Number of bedrooms', 'two bedrooms'), 'bound');
  assert.deepEqual(s.lines(), ['Pets: no pets', 'Cleaning frequency: every two weeks', 'Preferred date: next Tuesday', 'Time window: in the morning', 'Number of bedrooms: two bedrooms']);
  const t = createCleaningState();
  for (const [f, v] of [['Pets', 'hmm'], ['Pets', 'I do not know'], ['Pets', 'I would rather not say'], ['Cleaning frequency', 'maybe'], ['Cleaning frequency', 'tomorrow'], ['Extras', 'just this one time'], ['Number of bedrooms', 'two bathrooms'], ['Number of bedrooms', 'a few'], ['Preferred date', 'um'], ['Time window', 'whenever you like to ask'], ['Number of bathrooms', 'sure']] as const) assert.equal(t.bind(f, v), 'ambiguous', `${f}: ${v}`);
  assert.deepEqual(t.lines(), []);
  assert.equal(t.bind('Priority areas', 'the kitchen and the hall'), 'unchecked', 'free-text fields have no checkable shape: Intake reads them as before');
  assert.deepEqual(t.lines(), []);
});

test('merge: an accepted answer survives later passes that omit it; an older or different reading of old lines does not replace it', () => {
  const s = createCleaningState();
  assert.deepEqual(s.merge(item([fe('Pets', 'No.'), fe('Number of bedrooms', 'two bedrooms')]), 'no').accepted, ['Pets', 'Number of bedrooms']);
  assert.deepEqual(s.merge(item([fe('Pets', null), fe('Number of bedrooms', null)], ['Pets', 'Number of bedrooms'], ['missing_fields'], 'needs-human'), 'next line'), { accepted: [], corrected: [], conflicts: [] });
  assert.ok(s.has('Pets') && s.has('Number of bedrooms'));
  const older = s.merge(item([fe('Number of bedrooms', 'three bedrooms')]), 'something unrelated');
  assert.deepEqual(older, { accepted: [], corrected: [], conflicts: [] }, 'a reading that is not in the newest line is an older reading: ignored');
  assert.ok(s.lines().includes('Number of bedrooms: two bedrooms'));
  assert.deepEqual(s.merge(item([fe('Number of bedrooms', '2 bedrooms')]), 'it is 2 bedrooms').corrected, [], 'the same answer in other words is not a change');
});

test('merge: an explicit correction replaces; a different value from the newest line without correction wording is a conflict, not silently kept', () => {
  const s = createCleaningState();
  s.merge(item([fe('Number of bedrooms', 'two bedrooms'), fe('Time window', 'morning')]), 'two bedrooms');
  assert.deepEqual(s.merge(item([fe('Number of bedrooms', 'three bedrooms')]), 'sorry, three bedrooms').corrected, ['Number of bedrooms']);
  assert.ok(s.lines().includes('Number of bedrooms: three bedrooms'));
  const r = s.merge(item([fe('Time window', 'afternoon')]), 'the afternoon');
  assert.deepEqual(r.conflicts, ['Time window']);
  assert.deepEqual(s.conflicts(), ['Time window']);
  assert.ok(!s.lines().some((l) => l.startsWith('Time window')), 'the stale value is no longer fed to Intake');
});

test('bind resolves a conflict: the answer to the question the contradiction raised replaces the stale value', () => {
  const s = createCleaningState();
  s.merge(item([fe('Time window', 'morning')]), 'morning');
  s.merge(item([fe('Time window', 'evening')]), 'the evening');
  assert.deepEqual(s.conflicts(), ['Time window']);
  assert.equal(s.bind('Time window', 'maybe'), 'ambiguous'); assert.deepEqual(s.conflicts(), ['Time window'], 'a vague reply leaves it open');
  assert.equal(s.bind('Time window', 'the afternoon please'), 'bound');
  assert.deepEqual(s.conflicts(), []);
  assert.deepEqual(s.lines(), ['Time window: the afternoon please']);
});

test('overlay: omitted accepted answers are put back, a different reading is replaced, conflicted ones are taken out; missing and reasons follow; nothing is invented', () => {
  const s = createCleaningState();
  s.merge(item([fe('Pets', 'No.'), fe('Number of bedrooms', 'two bedrooms'), fe('Time window', 'morning')]), 'x');
  const pass = item([fe('Pets', null), fe('Number of bedrooms', 'three bedrooms'), fe('Time window', 'morning'), fe('Extras', null)], ['Pets', 'Extras'], ['missing_fields'], 'needs-human');
  const o = s.overlay(pass);
  assert.equal(o.changed, true);
  assert.deepEqual(o.restored.sort(), ['Number of bedrooms', 'Pets']);
  assert.deepEqual(o.item.fields.map((f) => [f.name, f.value, f.found]), [['Pets', 'No.', true], ['Number of bedrooms', 'two bedrooms', true], ['Time window', 'morning', true], ['Extras', null, false]]);
  assert.deepEqual(o.item.missing_fields, ['Extras'], 'only what the caller never gave stays missing');
  assert.equal(o.item.status, 'needs-human'); assert.ok(o.item.reasons.includes('missing_fields'));
  const done = s.overlay(item([fe('Pets', null)], ['Pets'], ['missing_fields'], 'needs-human'));
  assert.deepEqual([done.item.missing_fields, done.item.reasons, done.item.status], [[], [], 'ready']);
  s.merge(item([fe('Time window', 'evening')]), 'the evening');
  const c = s.overlay(item([fe('Time window', 'morning')], [], [], 'ready'));
  assert.deepEqual([c.withheld, c.item.fields[0].found, c.item.missing_fields, c.item.status], [['Time window'], false, ['Time window'], 'needs-human']);
  assert.ok(c.item.reasons.includes('ambiguous_field') && c.item.reasons.includes('missing_fields'));
  const same = s.overlay(item([fe('Pets', 'No.')]));
  assert.equal(same.changed, false);
});

test('values are one line, carry no label-looking colon, are bounded, and the first-cleaning field is never taken', () => {
  const s = createCleaningState({ exclude: ['First cleaning with us'] });
  s.merge(item([fe('Priority areas', 'the kitchen:\nAddress: elsewhere and the hall and a lot more words to make this very long indeed so it is cut off somewhere')]), 'x');
  const [line] = s.lines();
  assert.ok(!/\n/.test(line) && !/Address: elsewhere/.test(line) && line.length <= 'Priority areas: '.length + 80, line);
  assert.equal(s.bind('First cleaning with us', 'yes'), 'ambiguous');
  s.merge(item([fe('First cleaning with us', 'yes')]), 'yes'); assert.ok(!s.has('First cleaning with us'));
});

test('dispose forgets everything; a disposed state accepts and reports nothing', () => {
  const s = createCleaningState();
  s.merge(item([fe('Pets', 'No.')]), 'x'); s.bind('Time window', 'morning');
  s.dispose();
  assert.deepEqual([s.names(), s.lines(), s.conflicts(), s.has('Pets'), s.bind('Time window', 'morning')], [[], [], [], false, 'ambiguous']);
  assert.equal(s.overlay(item([fe('Pets', null)], ['Pets'])).changed, false);
});

test('log codes are fixed capital-letter tokens built from configured names only', () => {
  assert.equal(codeOf('Number of bedrooms'), 'NUMBER_OF_BEDROOMS');
  assert.equal(codeOf('Move-in or move-out cleaning'), 'MOVE_IN_OR_MOVE_OUT_CLEANING');
  assert.equal(codeOf(''), 'NONE'); assert.equal(codeOf(undefined), 'NONE');
  assert.ok(/^[A-Z_]+$/.test(codeOf('Last professional clean')));
});

// ---------------------------------------------------------------- 2026-10-28: clearly mismatched answers are not stored
test('bind: a date, a time of day or a frequency is not an answer to a yes/no, count, frequency, date or time question for another field', () => {
  const s = createCleaningState();
  for (const [f, v] of [['Pets', 'October 22'], ['Pets', 'in the morning'], ['Pets', 'once a month'], ['Extras', 'next Tuesday'], ['Home empty', 'tomorrow afternoon'], ['Number of bedrooms', 'October 22'], ['Number of bedrooms', 'at 9:30'], ['Number of bedrooms', '22'],
    ['Cleaning frequency', 'in the morning'], ['Cleaning frequency', 'October 22'], ['Preferred date', 'once a month'], ['Preferred date', 'in the morning'], ['Time window', 'October 22'], ['Time window', 'weekly']] as const) assert.equal(s.bind(f, v), 'ambiguous', `${f}: ${v}`);
  assert.deepEqual(s.lines(), []);
  for (const [f, v] of [['Pets', 'no pets'], ['Pets', 'two dogs'], ['Extras', 'yes the oven please'], ['Number of bedrooms', 'three bedrooms'], ['Cleaning frequency', 'every two weeks'], ['Preferred date', 'October 22'], ['Time window', 'in the morning']] as const) assert.equal(s.bind(f, v), 'bound', `${f}: ${v}`);
});

test('merge: a mismatched reading Intake produced (a date in an extras field) is not accepted', () => {
  const s = createCleaningState();
  const out = s.merge(item([fe('Extras', 'October 22'), fe('Pets', 'in the morning'), fe('Preferred date', 'October 22')]), 'October 22');
  assert.deepEqual(out.accepted, ['Preferred date']);
});
