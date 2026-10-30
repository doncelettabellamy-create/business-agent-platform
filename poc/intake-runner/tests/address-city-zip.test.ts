// City and ZIP capture for the private service address (call-state.ts city-and-ZIP mode). Pure state and session tests; the whole-call behaviour (position after the job confirmation, read-back,
// confirmation, bounded retries, privacy in logs and records) is tested with the call rig in founder-call.test.ts. Invented data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cityFrom, createContactState, runContactTool } from '../src/call-state.ts';
import { createCallSession } from '../src/call-session.ts';
import { SAY } from '../src/relay-handler.ts';
import { scriptedQuestion } from '../src/scripted-questions.ts';

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
