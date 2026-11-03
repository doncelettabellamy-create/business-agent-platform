// Real availability for the fast Drew test call (proof of concept). PURE: the open hours, the cleaning duration, the busy times read from Jobber and the clock are all PASSED IN; nothing here reads Jobber or a clock.
//
// A time is offered ONLY when all of these are true: it is inside the founder's stated test hours; the whole cleaning (its duration) fits before closing; it starts at least `leadMinutes` from now; and it overlaps no scheduled
// item that Jobber returned (with `bufferMinutes` of margin). If the hours or duration are missing, or Jobber could not be read completely, NOTHING is offered ("a person will confirm"): there is no default hour, no
// guessed duration and no assumption that an unreadable calendar is empty. The schedule is read from Jobber (jobber-connector.ts readBusyIntervals); the hours and the duration are the founder's own words in the config.

import { addDays, instantOf, pad2, weekdayOf, zonedParts, isoDate } from './fast-parsers.ts';
import type { When } from './fast-parsers.ts';

/** Open intervals by weekday (0 = Sunday .. 6 = Saturday), local clock times "HH:MM". A weekday that is absent or empty is closed. */
export type OpenHours = Readonly<Record<string, ReadonlyArray<readonly [string, string]>>>;
export interface AvailabilityConfig { timezone: string; hours: OpenHours; durationMinutes: number; stepMinutes?: number; leadMinutes?: number; bufferMinutes?: number; horizonDays?: number }
export interface Busy { start: number; end: number }
export interface Offer { date: string; time: string; endTime: string; kind: 'exact' | 'same_day' | 'other_day' }

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const mins = (hm: string): number => { const m = HM.exec(hm); return m === null ? NaN : Number(m[1]) * 60 + Number(m[2]); };
const hm = (total: number): string => `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
const partOf = (t: string): 'morning' | 'afternoon' | 'evening' => { const m = mins(t); return m < 12 * 60 ? 'morning' : m < 17 * 60 ? 'afternoon' : 'evening'; };

/** What is wrong with the availability settings (names only). Empty means usable. */
export function availabilityProblems(c: unknown): string[] {
  const p: string[] = []; const x = c as AvailabilityConfig;
  if (typeof x !== 'object' || x === null) return ['availability'];
  try { new Intl.DateTimeFormat('en-US', { timeZone: x.timezone }); } catch { p.push('timezone'); }
  if (!Number.isInteger(x.durationMinutes) || x.durationMinutes < 30 || x.durationMinutes > 480 || x.durationMinutes % 5 !== 0) p.push('durationMinutes');
  if (typeof x.hours !== 'object' || x.hours === null) p.push('hours');
  else {
    let any = false;
    for (const [day, list] of Object.entries(x.hours)) {
      if (!/^[0-6]$/.test(day) || !Array.isArray(list)) { p.push('hours'); break; }
      for (const iv of list) { if (!Array.isArray(iv) || iv.length !== 2 || !HM.test(iv[0]) || !HM.test(iv[1]) || mins(iv[1]) <= mins(iv[0])) { p.push('hours'); break; } any = true; }
    }
    if (!any && !p.includes('hours')) p.push('hours');
  }
  for (const k of ['stepMinutes', 'leadMinutes', 'bufferMinutes', 'horizonDays'] as const) { const v = x[k]; if (v !== undefined && (!Number.isInteger(v) || v < 0 || v > 60 * 24 * 14)) p.push(k); }
  if (x.stepMinutes !== undefined && x.stepMinutes < 5) p.push('stepMinutes');
  return p;
}

/** Every start time that works on one local date, earliest first. */
export function candidatesOn(date: string, c: AvailabilityConfig, busy: readonly Busy[], nowMs: number): Offer[] {
  const step = c.stepMinutes ?? 30; const lead = (c.leadMinutes ?? 60) * 60_000; const buffer = (c.bufferMinutes ?? 0) * 60_000; const out: Offer[] = [];
  for (const [open, close] of c.hours[String(weekdayOf(date))] ?? []) {
    for (let t = mins(open); t + c.durationMinutes <= mins(close); t += step) {
      const start = instantOf(date, hm(t), c.timezone); const end = start + c.durationMinutes * 60_000;
      if (start < nowMs + lead) continue;
      if (busy.some((b) => start < b.end + buffer && end + buffer > b.start)) continue;
      out.push({ date, time: hm(t), endTime: hm(t + c.durationMinutes), kind: 'same_day' });
    }
  }
  return out;
}

/** The one time to offer for what the caller asked, or undefined when nothing is supported. `skip` lists offers already refused (the same time is never offered twice). */
export function chooseOffer(pref: When, c: AvailabilityConfig, busy: readonly Busy[], nowMs: number, skip: readonly Offer[] = []): Offer | undefined {
  if (availabilityProblems(c).length > 0) return undefined;
  const today = zonedParts(nowMs, c.timezone); const todayIso = isoDate(today.y, today.m, today.d);
  const first = pref.date !== undefined && pref.date >= todayIso ? pref.date : todayIso; const horizon = c.horizonDays ?? 14;
  const refused = (o: Offer): boolean => skip.some((s) => s.date === o.date && s.time === o.time);
  for (let i = 0; i <= horizon; i++) {
    const date = addDays(first, i); const day = candidatesOn(date, c, busy, nowMs).filter((o) => !refused(o));
    if (day.length === 0) continue;
    const sameDay = date === first && pref.date !== undefined;
    const inPart = pref.part === undefined ? day : day.filter((o) => partOf(o.time) === pref.part);
    if (sameDay && pref.time !== undefined) {
      const exact = day.find((o) => o.time === pref.time); if (exact !== undefined) return { ...exact, kind: 'exact' };
      const want = mins(pref.time); const near = [...day].sort((a, b) => Math.abs(mins(a.time) - want) - Math.abs(mins(b.time) - want) || mins(a.time) - mins(b.time))[0];
      return { ...near, kind: 'same_day' };
    }
    if (inPart.length > 0) return { ...inPart[0], kind: sameDay || pref.date === undefined ? 'exact' : 'other_day' };
    if (sameDay) return { ...day[0], kind: 'same_day' };
    if (pref.part === undefined) return { ...day[0], kind: pref.date === undefined ? 'exact' : 'other_day' };
  }
  return undefined;
}
