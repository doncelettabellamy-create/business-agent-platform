// City and ZIP capture for the private service address (call-state.ts city-and-ZIP mode). Pure state and session tests; the whole-call behaviour (position after the job confirmation, read-back,
// confirmation, bounded retries, privacy in logs and records) is tested with the call rig in founder-call.test.ts. Invented data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cityFrom, createContactState, runContactTool } from '../src/call-state.ts';
import { createCallSession } from '../src/call-session.ts';
import { SAY } from '../src/relay-handler.ts';
import { scriptedQuestion } from '../src/scripted-questions.ts';
import { US_STATES, stateFrom, stateName } from '../src/us-state.ts';

const STREET = '1427 Sample Street';
const state = () => createContactState({ cityZip: true });
const say = (s: ReturnType<typeof state>, ...lines: string[]) => lines.map((l) => { const r = s.collect('address', l); return `${r.outcome}:${r.reason}`; });

test('whole, or street first and then the city and ZIP code in either order: the address is whole only with a street address, a city and a five-digit ZIP code', () => {
  for (const lines of [
    [`${STREET}, Springfield, 91364`],
    [`${STREET} Springfield 91364`],
    [`${STREET}, Springfield, nine one three six four`],
    [STREET, 'Springfield', '91364'],
    [STREET, '91364', 'Springfield'],
    ['1427', 'Sample Street', 'Springfield', '91364'],
    [`${STREET} 91364`, 'Springfield'],
  ]) {
    const s = state(); say(s, ...lines);
    assert.equal(s.value('address'), `${STREET}, Springfield, 91364`, JSON.stringify(lines));
    assert.equal(s.addressPart(), undefined);
  }
});

test('only the missing part is named, in order: street pieces, then the city, then the ZIP code', () => {
  const s = state();
  assert.equal(s.addressPart(), undefined, 'nothing held: the whole question is asked');
  say(s, '1427'); assert.equal(s.addressPart(), 'street name');
  say(s, 'Sample Street'); assert.equal(s.addressPart(), 'city');
  say(s, 'Springfield'); assert.equal(s.addressPart(), 'ZIP code');
  assert.equal(s.value('address'), undefined, 'not whole yet');
  say(s, '91364'); assert.equal(s.addressPart(), undefined);
  const t = state(); t.volunteered('the zip code is 91364'); t.volunteered('the city is Springfield'); assert.equal(t.addressPart(), 'street address', 'a city and a ZIP code without a street: only the street is missing');
});

test('invalid ZIP codes are never taken: four or six digits, all zeros and words give nothing and the ZIP code stays missing', () => {
  for (const bad of ['9136', '913640', '00000', 'abcde', '12', 'ninety one']) {
    const s = state(); say(s, STREET, 'Springfield');
    const r = s.collect('address', bad);
    assert.notEqual(r.outcome, 'captured', bad);
    assert.equal(s.value('address'), undefined, bad);
    assert.equal(s.addressPart(), 'ZIP code', bad);
  }
  const s = state(); say(s, STREET, 'Springfield');
  assert.deepEqual([s.collect('address', '9136').reason, s.collect('address', '913640').reason], ['BAD_ZIP', 'BAD_ZIP'], 'a fixed reason code, never the digits');
  assert.equal(s.collect('address', '91364-1234').outcome, 'captured', 'ZIP+4: the first five digits');
  assert.equal(s.value('address'), `${STREET}, Springfield, 91364`);
});

test('a house number or a unit number is never taken for a ZIP code', () => {
  const s = state(); say(s, '1427'); assert.equal(s.addressPart(), 'street name', 'a number alone, with no street yet, is the house number');
  const u = state(); say(u, `${STREET} Apartment 4, Springfield, 91364`);
  assert.equal(u.value('address'), `${STREET} Apartment 4, Springfield, 91364`);
  const w = state(); say(w, '15 Oak Lane, Shelbyville');
  assert.equal(w.addressPart(), 'ZIP code');
});

test('parts already given are kept: a repeated or off-topic answer changes nothing, a new street replaces only the street', () => {
  const s = state(); say(s, STREET, 'Springfield');
  assert.deepEqual(say(s, 'um hold on', 'I am not sure', 'Springfield'), ['unclear:NO_STREET_NUMBER', 'unclear:NO_STREET_NUMBER', 'unclear:NO_STREET_NUMBER'], 'nothing new: a held city is not overwritten by a bare word');
  assert.equal(s.addressPart(), 'ZIP code');
  say(s, '91364');
  say(s, '15 Oak Lane');   // a whole new street: the city and ZIP code stay
  assert.equal(s.value('address'), '15 Oak Lane, Springfield, 91364');
});

test('corrections: "the city is ..." and "the zip code is ..." replace only that part; an invalid ZIP correction changes nothing', () => {
  const s = state(); say(s, `${STREET}, Springfield, 91364`);
  assert.deepEqual(s.volunteered('actually the city is Shelbyville').map((r) => r.reason), ['JOINED']);
  assert.equal(s.value('address'), `${STREET}, Shelbyville, 91364`);
  assert.deepEqual(s.volunteered('the zip code is 90210').map((r) => r.reason), ['JOINED']);
  assert.equal(s.value('address'), `${STREET}, Shelbyville, 90210`);
  assert.deepEqual(s.volunteered('the zip code is 123').map((r) => `${r.outcome}:${r.reason}`), ['unclear:BAD_ZIP']);
  assert.equal(s.value('address'), `${STREET}, Shelbyville, 90210`);
  // A bare word does not overwrite a held city (an off-topic answer to the ZIP question): it takes the words "the city is".
  const t = state(); say(t, `${STREET}, Springfield`); say(t, 'maybe'); assert.equal(t.addressPart(), 'ZIP code');
});

test('cities are short plain place names: fillers, numbers, road words and long phrases are refused', () => {
  assert.equal(cityFrom('springfield'), 'Springfield');
  assert.equal(cityFrom('St. Louis'), undefined, 'a road word is not a city (the street flow handles it)');
  assert.equal(cityFrom('Salt Lake City'), 'Salt Lake City');
  for (const bad of ['', 'I do not know', 'two', 'a b c d', 'yes', '91364', 'the house']) assert.equal(cityFrom(bad), undefined, bad);
});

test('the spoken form reads the ZIP code digit by digit; the stored form keeps it whole; nothing is spoken until the address is whole', () => {
  const s = state(); say(s, STREET, 'Springfield');
  assert.equal(s.spokenAddress(), undefined);
  say(s, '91364');
  assert.equal(s.spokenAddress(), `${STREET}, Springfield, 9 1 3 6 4`);
  assert.equal(s.value('address'), `${STREET}, Springfield, 91364`);
  s.clear('address');
  assert.deepEqual([s.value('address'), s.addressPart(), s.spokenAddress()], [undefined, undefined, undefined], 'a cleared address keeps no part');
  say(s, STREET, 'Springfield'); s.dispose(); assert.deepEqual([s.value('address'), s.spokenAddress()], [undefined, undefined]);
});

test('default off: the street address alone is the whole address, exactly as before', () => {
  const s = createContactState();
  assert.deepEqual([s.collect('address', STREET).reason, s.value('address'), s.addressPart(), s.spokenAddress()], ['CAPTURED', STREET, undefined, STREET]);
});

test('the native tool surface never returns the value the caller gave, and a partial address is reported by label only', () => {
  const s = state();
  const r: any = runContactTool(s, 'collect_address', { heard: `${STREET}, Springfield` });
  assert.deepEqual([r.ok, r.outcome, r.missing.includes('Service address')], [true, 'partial', true]);
  assert.ok(!JSON.stringify({ ...r, learn: undefined }).match(/Sample|Springfield|91364/));
});

test('privacy in the session: once the parts are given, none of them reaches the masked text a model reads, and the read-back form is available over the phone only', () => {
  const session = createCallSession({ limits: { maxTurns: 30, maxMinutes: 8, maxChars: 4000 }, names: [], now: () => Date.now(), killed: () => false, addressCityZip: true });
  assert.equal(session.consent('yes'), 'granted');
  session.hear('what is the service address', undefined);
  for (const line of [STREET, 'Canarytown', '90210']) session.hear(line, 'address');
  assert.equal(session.revealContactParts().address, `${STREET}, Canarytown, 90210`);
  assert.equal(session.revealSpokenAddress(), `${STREET}, Canarytown, 9 0 2 1 0`);
  session.hear('and again, Canarytown 90210, Sample Street', undefined);
  const text = session.maskedText();
  assert.ok(!/Canarytown|90210|Sample|1427/.test(text), text);
});

test('wording: the opener and its retry ask for the city and ZIP code; each follow-up names one part; the recovery lines say the same words', () => {
  assert.equal(scriptedQuestion({ field: 'Service address' }).text, 'What is the service address?', 'default unchanged');
  assert.equal(scriptedQuestion({ field: 'Service address', cityZip: true }).text, 'What is the service address, including the city and ZIP code?');
  assert.equal(scriptedQuestion({ field: 'Service address', cityZip: true, rejected: true }).text, 'Sorry, I missed that. What is the service address, including the city and ZIP code?');
  assert.equal(scriptedQuestion({ field: 'Service address', part: 'city' }).text, SAY.addressCity);
  assert.equal(scriptedQuestion({ field: 'Service address', part: 'ZIP code' }).text, SAY.addressZip);
  assert.equal(scriptedQuestion({ field: 'Service address', part: 'street address' }).text, SAY.addressStreetAddress);
  for (const part of ['city', 'ZIP code', 'street address'] as const) assert.match(scriptedQuestion({ field: 'Service address', part }).text, /^Thank you\. What is the [A-Za-z -]+\?$/);
});

// ---------------------------------------------------------------- the state: said by the caller, kept apart from the city, never filled in

test('the state said with the address is kept apart from the city: a full name or two capital letters, with or without commas, spoken letters too; the ZIP code and the street are unchanged', () => {
  for (const [line, city, code] of [
    [`${STREET}, Springfield, Texas 91364`, 'Springfield', 'TX'],
    [`${STREET}, Springfield Texas 91364`, 'Springfield', 'TX'],
    [`${STREET}, Springfield, TX 91364`, 'Springfield', 'TX'],
    [`${STREET} Springfield TX 91364`, 'Springfield', 'TX'],
    [`${STREET}, Springfield, T X 91364`, 'Springfield', 'TX'],
    [`${STREET}, Kansas City, New York 91364`, 'Kansas City', 'NY'],
    [`${STREET}, Charleston, West Virginia 91364`, 'Charleston', 'WV'],
    [`${STREET}, Oklahoma City, Oklahoma 91364`, 'Oklahoma City', 'OK'],
  ]) {
    const s = state(); say(s, line);
    assert.deepEqual(s.addressParts(), { street: STREET, city, zip: '91364', state: code }, line);
    assert.equal(s.value('address'), `${STREET}, ${city}, 91364`, 'the whole address is still street, city and ZIP; the state is held beside it');
  }
});

test('the state said in pieces or on its own is kept and never becomes part of the city or the street; said again, it replaces the held one', () => {
  const s = state(); say(s, STREET, 'Springfield', '91364');
  assert.equal(s.addressParts()?.state, undefined, 'a whole address without a state has none: nothing fills it in');
  assert.deepEqual(s.addressHeld(), { street: true, city: true, zip: true, state: false });
  for (const [heard, code] of [['Texas', 'TX'], ['the state is Florida', 'FL'], ["it's in New York", 'NY'], ['Oregon, please', 'OR'], ['TX', 'TX'], ['Washington', 'WA']] as const) {
    const r = s.collect('address', heard);
    assert.equal(r.outcome, 'captured', heard);
    assert.deepEqual(s.addressParts(), { street: STREET, city: 'Springfield', zip: '91364', state: code }, heard);
  }
  // before the rest of the address: held, and joined when the rest arrives
  const t = state(); say(t, 'Texas'); assert.deepEqual(t.addressHeld(), { street: false, city: false, zip: false, state: true });
  assert.equal(t.value('address'), undefined, 'a state alone is never an address');
  say(t, STREET, 'Springfield', '91364'); assert.equal(t.addressParts()?.state, 'TX');
  // a city and a state in one answer
  const u = state(); say(u, STREET, 'Springfield, Texas', '91364'); assert.deepEqual(u.addressParts(), { street: STREET, city: 'Springfield', zip: '91364', state: 'TX' });
});

test('a state is never guessed: a house number before a state word is a street, a bare "OK" or "in" is not Oklahoma or Indiana, a lower-case pair is not a code, and a city that ends in a state word stays a city', () => {
  const a = state(); say(a, '123 Washington'); assert.equal(a.addressHeld().state, false, 'a house number then a state word is a street, not a state');
  for (const word of ['OK', 'in', 'or', 'me', 'okay', 'hi']) { const s = state(); say(s, STREET, 'Springfield', '91364'); s.collect('address', word); assert.equal(s.addressParts()?.state, undefined, word); }
  const b = state(); say(b, `${STREET}, Oklahoma City 91364`); assert.deepEqual(b.addressParts(), { street: STREET, city: 'Oklahoma City', zip: '91364' }, 'ends in "City", so no state was said');
  const c = state(); say(c, `${STREET}, Springfield 91364`); assert.equal(c.addressParts()?.state, undefined);
  assert.equal(c.spokenAddress(), `${STREET}, Springfield, 9 1 3 6 4`, 'with no state held the read-back line is exactly as before');
  assert.equal(c.value('address'), `${STREET}, Springfield, 91364`);
});

test('the read-back speaks the state by its full name; clearing the address forgets the state; the log booleans say whether a state is held and never which', () => {
  const s = state(); say(s, `${STREET}, Springfield, TX 91364`);
  assert.equal(s.spokenAddress(), `${STREET}, Springfield, Texas, 9 1 3 6 4`);
  assert.deepEqual(s.addressHeld(), { street: true, city: true, zip: true, state: true });
  assert.ok(!JSON.stringify(s.addressHeld()).includes('TX'));
  s.clear('address'); assert.deepEqual(s.addressHeld(), { street: false, city: false, zip: false, state: false });
  const t = state(); say(t, `${STREET}, Springfield, TX 91364`); t.abandon('address'); assert.equal(t.addressHeld().state, false);
  const u = state(); say(u, `${STREET}, Springfield, TX 91364`); u.dispose(); assert.equal(u.addressParts(), undefined); assert.equal(u.addressHeld().state, false);
});

test('us-state: every state and DC round-trips between its name and its code; names are found only at the end of the line; anything else is not a state', () => {
  assert.equal(Object.keys(US_STATES).length, 51);
  for (const [code, name] of Object.entries(US_STATES)) {
    assert.equal(stateName(code), name);
    assert.deepEqual(stateFrom(name), { code, rest: '' }, name);
    assert.deepEqual(stateFrom(`Springfield, ${name}`), { code, rest: 'Springfield' }, name);
    if (!['OK', 'IN', 'OR', 'ME', 'HI', 'OH'].includes(code)) assert.deepEqual(stateFrom(code), { code, rest: '' }, code);
  }
  assert.equal(stateName('ZZ'), undefined); assert.equal(stateName(undefined), undefined); assert.equal(stateName('tx'), undefined, 'a name is looked up by the stored upper-case code only');
  for (const bad of [undefined, null, 5, '', '   ', 'Texas Avenue', 'Texas Street, Springfield', 'x'.repeat(300), 'banana', 'I do not know']) assert.equal(stateFrom(bad), undefined, String(bad));
  assert.deepEqual(stateFrom('Austin, TX'), { code: 'TX', rest: 'Austin' });
  assert.deepEqual(stateFrom('it is Texas, thanks'), { code: 'TX', rest: '' });
  assert.deepEqual(stateFrom('West Virginia'), { code: 'WV', rest: '' }, 'the longer name wins over "Virginia"');
});

test('a lower-case or mixed-case state is taken only when something anchors it: after a comma, right after the ZIP code, or as the whole answer; a word that is also a code, and a street ending that is also a code, are not states (Live Test #6 follow-up)', () => {
  for (const [line, code] of [
    [`${STREET}, Springfield, tx 91364`, 'TX'], [`${STREET} Springfield tx 91364`, 'TX'], [`${STREET}, Springfield, Tx 91364`, 'TX'], [`${STREET}, Springfield, t x 91364`, 'TX'], [`${STREET}, Springfield, ny 91364`, 'NY'], [`${STREET}, Springfield, pa 91364`, 'PA'],
    [`${STREET}, Omaha, NE 91364`, 'NE'], [`${STREET}, Hartford, CT 91364`, 'CT'], [`${STREET}, Washington, DC 91364`, 'DC'],
  ] as const) {
    const s = state(); say(s, line);
    assert.equal(s.addressParts()?.state, code, line); assert.ok(!/\b(?:tx|Tx|ny|pa|t x)\b/.test(s.addressParts()?.city ?? ''), `${line}: the state is not left in the city`);
  }
  const c = state(); say(c, `${STREET}, Springfield, tx`); assert.deepEqual(c.addressHeld(), { street: true, city: true, zip: false, state: true }, 'after a comma, with no ZIP yet');
  for (const word of ['tx', 'ny', 'wa']) { const s = state(); say(s, STREET, 'Springfield', '91364'); s.collect('address', word); assert.equal(s.addressParts()?.state, word.toUpperCase(), `the whole answer: ${word}`); }
  // not states: common words, short names, and street endings
  for (const word of ['in', 'or', 'me', 'hi', 'oh', 'ok', 'al', 'de', 'id', 'la', 'ma', 'pa', 'co', 'md', 'ct', 'ne', 'Pa']) { const s = state(); say(s, STREET, 'Springfield', '91364'); s.collect('address', word); assert.equal(s.addressParts()?.state, undefined, `as the whole answer: ${word}`); }
  for (const line of [`1427 Sample Ct 91364`, `1427 Sample Street NE 91364`, `1427 Sample Street, Springfield tx`]) { const s = state(); say(s, line); assert.equal(s.addressHeld().state, false, line); }
  assert.deepEqual(stateFrom('Hartford, CT'), { code: 'CT', rest: 'Hartford' }); assert.equal(stateFrom('Hartford CT'), undefined, 'no comma: it may end a street'); assert.deepEqual(stateFrom('Hartford Connecticut'), { code: 'CT', rest: 'Hartford' }, 'the full name always counts');
  assert.deepEqual(stateFrom('Springfield, tx'), { code: 'TX', rest: 'Springfield' }); assert.equal(stateFrom('Springfield tx'), undefined, 'lower case with no anchor'); assert.deepEqual(stateFrom('Springfield tx', true), { code: 'TX', rest: 'Springfield' }, 'anchored by a ZIP code just taken off');
});
