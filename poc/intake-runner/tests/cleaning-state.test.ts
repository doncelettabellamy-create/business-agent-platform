// cleaning-state.ts: the validated current-call cleaning answers shared by the question choice and the saved record. Invented words only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCleaningState, kindOf, countOf, polarityOf, codeOf, requiredFieldsOf, answerMeaning, isRefusalOrUnsure } from '../src/cleaning-state.ts';
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
  assert.deepEqual(s.merge(item([fe('Pets', null), fe('Number of bedrooms', null)], ['Pets', 'Number of bedrooms'], ['missing_fields'], 'needs-human'), 'next line'), { accepted: [], corrected: [], conflicts: [], unsupported: [] });
  assert.ok(s.has('Pets') && s.has('Number of bedrooms'));
  const older = s.merge(item([fe('Number of bedrooms', 'three bedrooms')]), 'something unrelated');
  assert.deepEqual(older, { accepted: [], corrected: [], conflicts: [], unsupported: [] }, 'a reading that is not in the newest line is an older reading: ignored');
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

// ---------------------------------------------------------------- 2026-10-28: optional fields are kept only with the caller's own evidence
const lines = (...l: string[]) => ({ required: new Set(['Pets', 'Cleaning frequency']), lines: l });

test('evidence: an optional field with a known topic is dropped when only unrelated lines contain its value, kept when a caller line about the topic does, or the value names it', () => {
  const s = createCleaningState();
  const ctx = lines('Caller: just one time', 'yes', 'once a month');
  assert.deepEqual(s.merge(item([fe('Home empty', 'Yes'), fe('Last professional clean', 'A month'), fe('Priority areas', 'The two')]), 'x', ctx).unsupported.sort(), ['Home empty', 'Last professional clean', 'Priority areas']);
  const o = s.overlay(item([fe('Home empty', 'Yes'), fe('Last professional clean', 'A month'), fe('Pets', 'No')], [], [], 'ready'), ctx);
  assert.deepEqual([o.dropped.sort(), o.item.fields.map((f) => f.found), o.item.missing_fields, o.item.status], [['Home empty', 'Last professional clean'], [false, false, true], [], 'ready']);
  const good = createCleaningState();
  const c2 = lines('yes the house is empty', 'my last professional clean was six months ago', 'the kitchen mostly');
  assert.deepEqual(good.merge(item([fe('Home empty', 'yes'), fe('Last professional clean', 'six months ago'), fe('Priority areas', 'the kitchen')]), 'x', c2).accepted.sort(), ['Home empty', 'Last professional clean', 'Priority areas']);
  assert.equal(good.overlay(item([fe('Home empty', 'yes')]), c2).changed, false);
});

test('evidence: a required field and a field with no known topic are never policed, and no context means no policing', () => {
  const s = createCleaningState();
  const ctx = { required: new Set(['Home empty', 'Last professional clean']), lines: ['yes', 'once a month'] };
  assert.deepEqual(s.merge(item([fe('Home empty', 'yes'), fe('Last professional clean', 'a month'), fe('Preferred date', 'tomorrow')]), 'x', ctx).unsupported, []);
  assert.deepEqual(createCleaningState().merge(item([fe('Home empty', 'yes')]), 'x').unsupported, []);
  assert.equal(createCleaningState().overlay(item([fe('Home empty', 'yes')])).changed, false);
});

test('evidence: being asked is not evidence; a plausible answer bound in context is, a vague one is not', () => {
  const s = createCleaningState();
  const ctx = lines('maybe', 'yes');
  assert.equal(s.bind('Home empty', 'maybe'), 'ambiguous');
  assert.deepEqual(s.merge(item([fe('Home empty', 'yes')]), 'x', ctx).unsupported, ['Home empty'], 'asked and not answered: no evidence');
  assert.equal(s.bind('Home empty', 'yes'), 'bound');
  assert.deepEqual(s.merge(item([fe('Home empty', 'yes')]), 'x', ctx).accepted, ['Home empty'], 'answered in context: evidence');
});

test('"clean" alone is not about a professional clean: a frequency said with the word clean does not support last professional clean', () => {
  const s = createCleaningState();
  assert.deepEqual(s.merge(item([fe('Last professional clean', 'a month')]), 'x', lines('I clean it myself about once a month')).unsupported, ['Last professional clean']);
});

test('requiredFieldsOf: fields marked required plus the category list', () => {
  const skill = { fields: [{ name: 'Job description', required: true }, { name: 'Pets' }], categories: [{ name: 'Standard cleaning', requires: ['Pets', 'Extras'] }] };
  assert.deepEqual(requiredFieldsOf(skill, 'Standard cleaning'), ['Job description', 'Pets', 'Extras']);
  assert.deepEqual(requiredFieldsOf(skill, 'Unknown'), ['Job description']);
});

// ---------------------------------------------------------------- 2026-10-29: a mask placeholder is never an answer to a question about the job (the Pets value of the 12:05 PM call)
import { isPlaceholderOnly } from '../src/cleaning-state.ts';

test('placeholder-only values: only mask placeholders and punctuation count; a placeholder with other words is NOT covered by this rule', () => {
  for (const v of ['[ADDRESS_1]', ' [ADDRESS_12]. ', '[PERSON_1], [ADDRESS_2]', '"[CONTACT_3]"', '[ID_1]!']) assert.equal(isPlaceholderOnly(v), true, v);
  for (const v of ['No', 'no pets', 'two dogs and a cat', 'no [PERSON_1]', 'at [ADDRESS_1]', '', '[address_1]', '[ADDRESS_]', '[]', 42, null, undefined]) assert.equal(isPlaceholderOnly(v as never), false, String(v));
  assert.equal(isPlaceholderOnly('[ADDRESS_1]'), true, 'repeated calls give the same answer (no stale regex state)');
});

test('overlay: a placeholder-only value for a job field with nothing accepted is held: not found, missing and asked first, with the ambiguous-field reason; the record cannot be ready', () => {
  const s = createCleaningState();
  const out = s.overlay(item([fe('Pets', '[ADDRESS_1]'), fe('Extras', 'No extras')]));
  assert.equal(out.changed, true); assert.deepEqual([...out.withheld], ['Pets']);
  const pets = out.item.fields.find((f) => f.name === 'Pets') as FieldEntry;
  assert.deepEqual([pets.found, pets.value], [false, null]);
  assert.deepEqual(out.item.missing_fields, ['Pets']);
  assert.ok(out.item.reasons.includes('missing_fields') && out.item.reasons.includes('ambiguous_field'));
  assert.notEqual(out.item.status, 'ready');
  assert.equal(out.item.fields.find((f) => f.name === 'Extras')?.value, 'No extras', 'other fields are untouched');
});

test('merge ignores a placeholder-only value (never accepted), and the next real answer is accepted and restored over later placeholders', () => {
  const s = createCleaningState();
  const m = s.merge(item([fe('Pets', '[ADDRESS_1]')]), 'whatever', undefined);
  assert.deepEqual(m.accepted, []); assert.equal(s.has('Pets'), false);
  s.merge(item([fe('Pets', 'no pets')]), 'no pets', undefined);
  assert.equal(s.has('Pets'), true);
  const out = s.overlay(item([fe('Pets', '[ADDRESS_1]')]));
  assert.equal(out.item.fields.find((f) => f.name === 'Pets')?.value, 'no pets', 'the accepted answer stands over a later placeholder');
  assert.equal(out.item.fields.find((f) => f.name === 'Pets')?.found, true);
  assert.deepEqual([...out.withheld], []);
});

test('an address or location field keeps its placeholder: that is what the masker is meant to put there', () => {
  const s = createCleaningState();
  for (const name of ['Address', 'Service address', 'Job location']) {
    const out = s.overlay(item([fe(name, '[ADDRESS_1]')]));
    assert.equal(out.changed, false, name);
    assert.equal(out.item.fields[0].value, '[ADDRESS_1]');
  }
});

test('legitimate answers are untouched: yes and no answers, a descriptive answer, and a correction', () => {
  const s = createCleaningState();
  for (const [v, w] of [['No', 'No'], ['no pets', 'no pets'], ['two dogs and a cat', 'two dogs and a cat']] as const) {
    const t = createCleaningState();
    const m = t.merge(item([fe('Pets', v)]), v, undefined);
    assert.deepEqual(m.accepted, ['Pets'], v);
    assert.equal(t.overlay(item([fe('Pets', v)])).changed, false);
    assert.equal(t.has('Pets'), true); void w;
  }
  s.merge(item([fe('Pets', 'no pets')]), 'no pets', undefined);
  const c = s.merge(item([fe('Pets', 'a dog')]), 'actually we do have a dog', undefined);
  assert.deepEqual(c.corrected, ['Pets'], 'a correction still replaces an accepted answer');
});

test('KNOWN HAZARD, OUTSIDE THIS FIX: a value that mixes a placeholder with other words is not held and no safety claim is made for it', () => {
  const s = createCleaningState();
  const out = s.overlay(item([fe('Pets', 'no [PERSON_1]')]));
  assert.equal(out.changed, false, 'unchanged by design here; widening the rule needs its own evidence and approval');
});

// ---- 2026-10-29: refusal / uncertainty protection for non-address job fields, and the field-specific meanings for the two Deep-cleaning free-text fields
test('answerMeaning: Priority areas takes no / none / no preference; Last professional clean takes never, and asks again for no / none / no preference; a longer answer is ordinary', () => {
  const m = (f: string, v: string) => answerMeaning(f, v);
  for (const v of ['no', 'None', 'No preference.', 'no preferences', 'nothing', 'Um, none']) assert.equal(m('Priority areas', v), 'valid', v);
  for (const v of ['never', 'Never.', 'not ever', 'we have never had one', 'I have never had a professional clean']) assert.equal(m('Last professional clean', v), 'valid', v);
  for (const v of ['no', 'none', 'no preference', 'Nope.', 'nothing']) assert.equal(m('Last professional clean', v), 'unclear', v);
  for (const v of ['the kitchen', 'no preference for the kitchen but the bathrooms', 'a year ago', 'never, but we cleaned it ourselves last week']) assert.equal(m(v.startsWith('a year') || v.startsWith('never,') ? 'Last professional clean' : 'Priority areas', v), undefined, v);
  assert.equal(m('Priority areas', 'never'), undefined, 'never says nothing about areas: an ordinary reply');
  assert.equal(m('Pets', 'none'), undefined, 'no rule for other fields');
});

test('isRefusalOrUnsure: only the COMPLETE reply counts, so legitimate negative answers and phrases that contain those words are untouched', () => {
  for (const v of ["I'd rather not answer", 'I would rather not say', 'rather not', 'I prefer not to say', "I don't know", 'Not sure.', "I'm not sure", 'no comment', 'not telling', 'pass', 'maybe', 'I do not want to answer that', 'Um, I don’t know']) assert.equal(isRefusalOrUnsure(v), true, v);
  for (const v of ['no', 'none', 'no pets', 'nothing', 'never', "we don't want any extras", "I don't know the old cleaner but it was in March", 'not sure about the oven but yes the fridge', 'no preference for the kitchen', 'two dogs', 'it was a long time ago and I do not remember who', 'the kitchen', '', 'pass the kitchen first']) assert.equal(isRefusalOrUnsure(v), false, v);
  assert.equal(isRefusalOrUnsure(42 as never), false);
});

test('bind: a valid Deep-field reply is bound in the caller\'s words, a reply that is not an answer to THAT question or a refusal is ambiguous and stored nowhere, anything else is unchecked as before', () => {
  const s = createCleaningState();
  assert.equal(s.bind('Priority areas', 'No preference.'), 'bound');
  assert.deepEqual(s.lines(), ['Priority areas: No preference']);
  assert.equal(s.bind('Last professional clean', 'none'), 'ambiguous');
  assert.equal(s.bind('Last professional clean', "I'd rather not answer"), 'ambiguous');
  assert.equal(s.bind('Last professional clean', 'a year ago'), 'unchecked');
  assert.equal(s.bind('Last professional clean', 'never'), 'bound');
  assert.deepEqual(s.lines(), ['Priority areas: No preference', 'Last professional clean: never']);
  assert.equal(s.bind('Job description', 'not sure'), 'ambiguous', 'a refusal or an I-do-not-know is never an answer, for any free-text field');
  assert.equal(s.bind('Job description', 'a burst pipe'), 'unchecked');
});

test('merge and overlay: a refusal, an uncertain reply or (for the field) a reply that is not an answer is held when nothing is accepted: not found, missing, asked again, never ready', () => {
  for (const [field, v] of [['Priority areas', "I'd rather not answer"], ['Priority areas', 'not sure'], ['Last professional clean', 'no'], ['Last professional clean', 'none'], ['Pets', 'maybe'], ['Number of bedrooms', "I don't know"]] as const) {
    const s = createCleaningState();
    const it = item([fe(field, v)]);
    const m = s.merge(it, v, undefined);
    assert.deepEqual(m.accepted, [], `${field}: ${v} is not accepted`);
    const out = s.overlay(it);
    assert.equal(out.changed, true, `${field}: ${v}`);
    assert.deepEqual([out.item.fields[0].found, out.item.fields[0].value, out.item.missing_fields[0], out.item.status], [false, null, field, 'needs-human']);
    assert.ok(out.item.reasons.includes('ambiguous_field') && out.item.reasons.includes('missing_fields'));
  }
});

test('merge and overlay: valid answers and answers that contain those words are kept; an accepted answer is never overruled by a later refusal; a correction still replaces it', () => {
  for (const [field, v] of [['Priority areas', 'no'], ['Priority areas', 'none'], ['Last professional clean', 'never'], ['Pets', 'no pets'], ['Last professional clean', "I don't know who it was but it was in March"], ['Extras', "we don't want the oven cleaned"]] as const) {
    const s = createCleaningState();
    const it = item([fe(field, v)]);
    s.merge(it, v, undefined);
    assert.equal(s.overlay(it).item.fields[0].found, true, `${field}: ${v} stays found`);
  }
  const s = createCleaningState();
  s.merge(item([fe('Priority areas', 'none')]), 'none', undefined);
  const later = s.overlay(item([fe('Priority areas', "I'd rather not answer")]));
  assert.deepEqual([later.item.fields[0].found, later.item.fields[0].value], [true, 'none'], 'the accepted answer stands over a later refusal');
  const omitted = s.overlay(item([fe('Priority areas', null)], ['Priority areas'], ['missing_fields'], 'needs-human'));
  assert.deepEqual([omitted.item.fields[0].value, omitted.restored], ['none', ['Priority areas']]);
  const c = s.merge(item([fe('Priority areas', 'the kitchen')]), 'actually the kitchen', undefined);
  assert.deepEqual(c.corrected, ['Priority areas'], 'an explicit correction replaces it');
});
