// Availability for the fast Drew test call: only times inside the founder's stated hours that fit the whole cleaning and overlap nothing Jobber returned. The hours below are a SYNTHETIC test fixture, not the founder's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availabilityProblems, candidatesOn, chooseOffer } from '../src/fast-availability.ts';
import type { AvailabilityConfig } from '../src/fast-availability.ts';
import { instantOf } from '../src/fast-parsers.ts';

const TZ = 'America/Chicago';
const NOW = Date.parse('2026-11-02T15:00:00Z');   // Monday 9:00 in Chicago
const CFG: AvailabilityConfig = { timezone: TZ, hours: { 1: [['09:00', '17:00']], 2: [['09:00', '17:00']], 3: [['09:00', '17:00']], 4: [['09:00', '17:00']], 5: [['09:00', '17:00']] }, durationMinutes: 120, stepMinutes: 30, leadMinutes: 60 };
const busyOn = (date: string, from: string, to: string) => ({ start: instantOf(date, from, TZ), end: instantOf(date, to, TZ) });
const times = (date: string, busy = [] as ReturnType<typeof busyOn>[]) => candidatesOn(date, CFG, busy, NOW).map((o) => o.time);

test('settings: hours and a duration are required and checked; nothing is defaulted', () => {
  assert.deepEqual(availabilityProblems(CFG), []);
  assert.ok(availabilityProblems({ ...CFG, hours: {} }).includes('hours'));
  assert.ok(availabilityProblems({ ...CFG, hours: { 1: [['17:00', '09:00']] } }).includes('hours'));
  assert.ok(availabilityProblems({ ...CFG, hours: { 9: [['09:00', '10:00']] } }).includes('hours'));
  assert.ok(availabilityProblems({ ...CFG, durationMinutes: 10 }).includes('durationMinutes'));
  assert.ok(availabilityProblems({ ...CFG, durationMinutes: undefined as never }).includes('durationMinutes'));
  assert.ok(availabilityProblems({ ...CFG, timezone: 'Not/AZone' }).includes('timezone'));
  assert.ok(availabilityProblems(undefined).length > 0);
  assert.equal(chooseOffer({ date: '2026-11-03' }, { ...CFG, durationMinutes: undefined as never }, [], NOW), undefined, 'no duration, no offer');
  assert.equal(chooseOffer({ date: '2026-11-03' }, { ...CFG, hours: {} }, [], NOW), undefined, 'no hours, no offer');
});

test('candidates: only start times where the whole cleaning fits before closing, after the lead time, and clear of Jobber\'s busy time', () => {
  assert.deepEqual(times('2026-11-03'), ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00'], 'the last start is 15:00: it ends at 17:00');
  assert.deepEqual(times('2026-11-02'), ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00'], 'today: nothing before now plus the 60-minute lead');
  assert.deepEqual(times('2026-11-07'), [], 'a closed day has none');
  assert.deepEqual(times('2026-11-03', [busyOn('2026-11-03', '10:00', '12:00')]), ['12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00'], 'a visit that would overlap is not offered; one that ends exactly at the busy start would be');
  assert.deepEqual(times('2026-11-03', [busyOn('2026-11-03', '12:00', '13:00')]).slice(0, 3), ['09:00', '09:30', '10:00'].slice(0, 3));
  assert.ok(!times('2026-11-03', [busyOn('2026-11-03', '12:00', '13:00')]).includes('10:30'), '10:30 to 12:30 would overlap the 12:00 item');
  const withBuffer = candidatesOn('2026-11-03', { ...CFG, bufferMinutes: 30 }, [busyOn('2026-11-03', '12:00', '13:00')], NOW).map((o) => o.time);
  assert.ok(times('2026-11-03', [busyOn('2026-11-03', '12:00', '13:00')]).includes('10:00') && !withBuffer.includes('10:00') && withBuffer.includes('09:30'), 'a visit ending exactly when the busy time starts is fine without a buffer and refused with one');
  assert.ok(!withBuffer.includes('13:00') && withBuffer.includes('13:30'), 'and the buffer also keeps the time after it');
});

test('the offer: the exact time when it is free, else the nearest free time that day, else the next open day; an afternoon asked for is an afternoon offered; a refused time is never offered again', () => {
  assert.deepEqual(chooseOffer({ date: '2026-11-03', time: '10:00' }, CFG, [], NOW), { date: '2026-11-03', time: '10:00', endTime: '12:00', kind: 'exact' });
  assert.deepEqual(chooseOffer({ date: '2026-11-03', time: '10:00' }, CFG, [busyOn('2026-11-03', '10:00', '12:00')], NOW), { date: '2026-11-03', time: '12:00', endTime: '14:00', kind: 'same_day' });
  assert.deepEqual(chooseOffer({ date: '2026-11-02', time: '09:30' }, CFG, [], NOW), { date: '2026-11-02', time: '10:00', endTime: '12:00', kind: 'same_day' }, 'too soon today: the nearest allowed');
  assert.deepEqual(chooseOffer({ date: '2026-11-03', part: 'afternoon' }, CFG, [], NOW), { date: '2026-11-03', time: '12:00', endTime: '14:00', kind: 'exact' });
  assert.deepEqual(chooseOffer({ date: '2026-11-03', part: 'morning' }, CFG, [], NOW), { date: '2026-11-03', time: '09:00', endTime: '11:00', kind: 'exact' });
  assert.deepEqual(chooseOffer({ date: '2026-11-03', flexible: true }, CFG, [], NOW)?.time, '09:00');
  assert.deepEqual(chooseOffer({ date: '2026-11-07', time: '10:00' }, CFG, [], NOW), { date: '2026-11-09', time: '09:00', endTime: '11:00', kind: 'other_day' }, 'a closed Saturday: the next open day, earliest time');
  assert.deepEqual(chooseOffer({ date: '2026-11-03', time: '10:00' }, CFG, [busyOn('2026-11-03', '08:00', '18:00')], NOW), { date: '2026-11-04', time: '09:00', endTime: '11:00', kind: 'other_day' });
  const first = chooseOffer({ date: '2026-11-03', time: '10:00' }, CFG, [], NOW)!;
  assert.equal(chooseOffer({ date: '2026-11-03', time: '10:00' }, CFG, [], NOW, [first])?.time, '09:30', 'the refused 10:00 is skipped; the nearest remaining is offered (ties go earlier)');
  assert.deepEqual(chooseOffer({}, CFG, [], NOW)?.date, '2026-11-02', 'no day asked: the earliest open time from now');
  assert.equal(chooseOffer({ date: '2026-11-03' }, { ...CFG, horizonDays: 0 }, [busyOn('2026-11-03', '00:00', '23:59')], NOW), undefined, 'nothing within the horizon: no offer');
  assert.equal(chooseOffer({ date: '2026-10-20' }, CFG, [], NOW)?.date, '2026-11-02', 'a day in the past is not offered');
});
