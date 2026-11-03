// The deterministic answer parsers of the fast Drew test call. Synthetic phrases only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, countFrom, instantOf, isAiQuestion, sayDay, sayDayYear, sayDollars, sayTime, sizeFrom, utcOffsetFor, weekdayOf, whenFrom, yesNo, zonedParts } from '../src/fast-parsers.ts';

const TZ = 'America/Chicago';
const NOW = Date.parse('2026-11-02T15:00:00Z');   // Monday 2 November 2026, 9:00 in Chicago (standard time, UTC-6; summer time ended on 1 November)

test('yes and no: the first of the two in the line wins; anything else is unclear', () => {
  for (const y of ['yes', 'Yes.', 'yeah', 'yep that works', 'sure', 'correct', 'that is right', "yes that's right", 'okay', 'go ahead', 'sounds good', 'absolutely', 'please do']) assert.equal(yesNo(y), 'yes', y);
  for (const n of ['no', 'No.', 'nope', "no that's not right", "that's not right", "that's wrong", 'not really', "don't", 'cancel that', 'never mind']) assert.equal(yesNo(n), 'no', n);
  for (const u of ['', 'um', 'hello', 'tuesday', 'two bedrooms', 'what', 'maybe later', 'let me think']) assert.equal(yesNo(u), 'unclear', u);
  assert.equal(yesNo(undefined), 'unclear'); assert.equal(yesNo('y'.repeat(400)), 'unclear');
});

test('size: bedrooms and bathrooms in the ways they are said; only what is said is returned', () => {
  assert.deepEqual(sizeFrom('two bedrooms and two bathrooms'), { beds: 2, baths: 2 });
  assert.deepEqual(sizeFrom('2 bed 2 bath'), { beds: 2, baths: 2 });
  assert.deepEqual(sizeFrom('two bedroom, two bathroom'), { beds: 2, baths: 2 });
  assert.deepEqual(sizeFrom('three bedrooms and one and a half bathrooms'), { beds: 3, baths: 1.5 });
  assert.deepEqual(sizeFrom('it has 4 bedrooms and 3 baths'), { beds: 4, baths: 3 });
  assert.deepEqual(sizeFrom('two and two'), { beds: 2, baths: 2 });
  assert.deepEqual(sizeFrom('3 2'), { beds: 3, baths: 2 });
  assert.deepEqual(sizeFrom('a studio and one bath'), { beds: 0, baths: 1 });
  assert.deepEqual(sizeFrom('two bedrooms'), { beds: 2 });
  assert.deepEqual(sizeFrom('two bathrooms'), { baths: 2 });
  assert.deepEqual(sizeFrom('2 and a half baths'), { baths: 2.5 });
  for (const none of ['', 'a lot', 'big house', 'yes', 'tuesday at ten']) assert.deepEqual(sizeFrom(none), {}, none);
  assert.deepEqual(sizeFrom('fifty bedrooms'), {});
  assert.equal(countFrom('two'), 2); assert.equal(countFrom('2'), 2); assert.equal(countFrom('one and a half'), 1.5); assert.equal(countFrom('two or three'), undefined); assert.equal(countFrom('lots'), undefined);
});

test('time zones: the local date and weekday of an instant, the UTC offset on that date (standard or summer time), and the instant of a local date and time', () => {
  assert.deepEqual(zonedParts(NOW, TZ), { y: 2026, m: 11, d: 2, weekday: 1, hour: 9, minute: 0 });
  assert.equal(utcOffsetFor(NOW, TZ), '-06:00'); assert.equal(utcOffsetFor(Date.parse('2026-07-15T12:00:00Z'), TZ), '-05:00');
  assert.equal(instantOf('2026-11-10', '09:30', TZ), Date.parse('2026-11-10T15:30:00Z')); assert.equal(instantOf('2026-07-15', '09:30', TZ), Date.parse('2026-07-15T14:30:00Z'));
  assert.equal(addDays('2026-11-30', 1), '2026-12-01'); assert.equal(addDays('2026-12-31', 1), '2027-01-01'); assert.equal(weekdayOf('2026-11-10'), 2);
});

test('day and time: weekdays, relative days, dates and times in the ways they are said, read against a fixed Monday morning', () => {
  const w = (s: string) => whenFrom(s, NOW, TZ);
  assert.deepEqual(w('tuesday at ten'), { date: '2026-11-03', time: '10:00' });
  assert.deepEqual(w('Tuesday at 10 a.m.'), { date: '2026-11-03', time: '10:00' });
  assert.deepEqual(w('tomorrow morning'), { date: '2026-11-03', part: 'morning' });
  assert.deepEqual(w('tomorrow at two thirty'), { date: '2026-11-03', time: '14:30' });
  assert.deepEqual(w('next friday afternoon'), { date: '2026-11-06', part: 'afternoon' });
  assert.deepEqual(w('monday'), { date: '2026-11-09' }, 'the same weekday as today is the next one');
  assert.deepEqual(w('today at 3 pm'), { date: '2026-11-02', time: '15:00' });
  assert.deepEqual(w('November 10th at nine'), { date: '2026-11-10', time: '09:00' });
  assert.deepEqual(w('the tenth of november at 9:30 am'), { date: '2026-11-10', time: '09:30' });
  assert.deepEqual(w('11/12 at noon'), { date: '2026-11-12', time: '12:00' });
  assert.deepEqual(w('the 15th'), { date: '2026-11-15' });
  assert.deepEqual(w('the first'), { past: true }, 'a day of the month already past is flagged, never moved to next month');
  assert.deepEqual(w('january fifth'), { past: true }, 'a month and day already past is flagged, never moved to next year');
  assert.deepEqual(w('october 4th'), { past: true }); assert.deepEqual(w('10/4'), { past: true }, 'the 4 October reading of the founder call is no longer silently read as 2027');
  assert.deepEqual(w('january fifth 2027'), { date: '2027-01-05' }, 'a four-digit year said by the caller is used as said');
  assert.deepEqual(w('february thirtieth'), {}, 'a day that does not exist is not a date');
  assert.deepEqual(w('november third'), { date: '2026-11-03' }); assert.deepEqual(w('tuesday'), { date: '2026-11-03' });
  assert.equal(sayDayYear('2026-11-03'), 'Tuesday, November third, 2026');
  assert.deepEqual(w('wednesday at 8'), { date: '2026-11-04', time: '08:00' });
  assert.deepEqual(w('thursday at four'), { date: '2026-11-05', time: '16:00' });
  assert.deepEqual(w('saturday at 14:00'), { date: '2026-11-07', time: '14:00' });
  assert.deepEqual(w('tuesday in the evening'), { date: '2026-11-03', part: 'evening' });
  assert.deepEqual(w('any time tuesday'), { date: '2026-11-03', flexible: true });
  assert.deepEqual(w('ten in the morning'), { time: '10:00' }, 'a time without a day (the morning is already in the time)');
  assert.deepEqual(w('whenever'), { flexible: true });
  for (const none of ['', 'yes', 'two bedrooms', 'I do not know']) assert.deepEqual(w(none), {}, none);
});

test('speech: dates and times are spoken in full so a wrong reading is heard and corrected', () => {
  assert.equal(sayDay('2026-11-10'), 'Tuesday, November tenth'); assert.equal(sayDay('2026-12-01'), 'Tuesday, December first'); assert.equal(sayDay('2026-11-23'), 'Monday, November twenty third');
  assert.equal(sayTime('10:00'), '10 A M'); assert.equal(sayTime('14:30'), '2 30 P M'); assert.equal(sayTime('12:00'), '12 P M'); assert.equal(sayTime('00:15'), '12 15 A M'); assert.equal(sayTime('09:05'), '9 05 A M');
});

test('isAiQuestion: a caller asking whether this is a person, a robot or an A I is recognised; names, ordinary answers and unrelated questions are not', () => {
  for (const q of ['are you a robot', 'Are you actually a person?', 'is this a bot', 'am I talking to a human', 'are you an AI', 'is this a real person', 'are you a computer?', 'Hi, are you a real person or a machine'])
    assert.equal(isAiQuestion(q), true, q);
  for (const n of ['my name is Bot Johnson', 'Robin Lee', 'Al Machine', 'Testa Invented', 'yes', 'Tuesday at ten', '123 Invented Lane', 'are you open on Tuesday', 'is this the price'])
    assert.equal(isAiQuestion(n), false, n);
});

test('the price in words: the voice is never asked to read a dollar sign and digits', () => {
  const cases: Array<[number, string]> = [[199, 'one hundred ninety-nine dollars'], [1, 'one dollar'], [0, 'zero dollars'], [100, 'one hundred dollars'], [205, 'two hundred five dollars'], [250, 'two hundred fifty dollars'],
    [11, 'eleven dollars'], [20, 'twenty dollars'], [21, 'twenty-one dollars'], [999, 'nine hundred ninety-nine dollars'], [1000, 'one thousand dollars'], [1250, 'one thousand two hundred fifty dollars'],
    [199.5, 'one hundred ninety-nine dollars and fifty cents'], [0.01, 'zero dollars and one cent'], [12.25, 'twelve dollars and twenty-five cents']];
  for (const [n, words] of cases) assert.equal(sayDollars(n), words, String(n));
  for (const bad of [NaN, -1, 1_000_000, Infinity]) assert.ok(!/[\$]/.test(sayDollars(bad)) && sayDollars(bad).endsWith(' dollars'), String(bad));
  for (let n = 1; n <= 999; n++) assert.ok(/^[a-z -]+ dollars?$/.test(sayDollars(n)), `${n} has only words`);
});
