// Turns the two private configs (the call config and the voice config) into the controlled FAST TEST setup (proof of concept). PURE: it takes the parsed configs and the founder's answers and returns the new configs, or a list of
// problems; the entry point (fast-test-config-main.ts) does the file work, with backups. Nothing here invents a business fact: the time zone, the open hours, the cleaning duration, the Jobber account name and the standing
// approval all come from the founder's answers, and a missing one is a problem, not a default.
//
// What changes, and nothing else:
//   * the call config's `opening` becomes the controlled test greeting, word for word ("Thanks for calling Drew Cleaning. I'm Jack. What's your name?"): no long disclosure, no special (its price and discount are undecided) and no request to say yes;
//   * the voice config gains the `fast_test` section (the founder's business facts and the standing test approval).
// (The opening is exactly the founder's greeting; it has no request to say yes, and the voice gate allows it only together with the fast test section.)
// Both are part of the approval digest, so the founder approves the new pair by running the start helper, which recomputes both digests.

import { founderConfigProblems } from './founder-call-gate.ts';
import type { FounderCallConfig } from './founder-call-gate.ts';
import { founderVoiceConfigProblems } from './founder-voice-gate.ts';
import type { FastTestConfig, FounderVoiceConfig } from './founder-voice-gate.ts';
import { consentNoticeFor } from './opening.ts';

/** The controlled test's greeting, word for word. It asks the first question itself and asks the caller for no yes. */
export const TEST_GREETING = "Thanks for calling Drew Cleaning. I'm Jack. What's your name?";
export interface FastTestAnswers {
  jobber_account_name: string; timezone: string; hours: Record<string, Array<[string, string]>>; duration_minutes: number; standing_approval: boolean;
  state?: string; price_dollars?: number; bedrooms?: number; bathrooms?: number; service_label?: string; lead_minutes?: number;
}
export type ApplyResult = { ok: true; call: FounderCallConfig; voice: FounderVoiceConfig; opening: string } | { ok: false; problems: string[] };

export function applyFastTest(call: unknown, voice: unknown, a: FastTestAnswers): ApplyResult {
  const before = [...founderConfigProblems(call), ...founderVoiceConfigProblems(voice)];
  if (before.length > 0) return { ok: false, problems: before.map((p) => `before: ${p}`) };
  const c = call as FounderCallConfig; const v = voice as FounderVoiceConfig;
  const fast: FastTestConfig = {
    jobber_account_name: a.jobber_account_name, timezone: a.timezone, hours: a.hours, duration_minutes: a.duration_minutes,
    price_dollars: a.price_dollars ?? 199, bedrooms: a.bedrooms ?? 2, bathrooms: a.bathrooms ?? 2, service_label: a.service_label ?? 'Standard cleaning', standing_approval: a.standing_approval,
    ...(a.state === undefined ? {} : { state: a.state }), ...(a.lead_minutes === undefined ? {} : { lead_minutes: a.lead_minutes }),
  };
  if (c.opening?.business_name === undefined) return { ok: false, problems: ['before: the call config has no opening block with a business name'] };
  const nextCall: FounderCallConfig = { ...c, opening: { business_name: c.opening.business_name, greeting: TEST_GREETING } };
  const nextVoice: FounderVoiceConfig = { ...v, fast_test: fast };
  const after = [...founderConfigProblems(nextCall), ...founderVoiceConfigProblems(nextVoice)];
  if (after.length > 0) return { ok: false, problems: after };
  return { ok: true, call: nextCall, voice: nextVoice, opening: consentNoticeFor(nextCall.opening) };
}

/** The founder's schedule answers exactly as typed (every field a string). */
export interface RawScheduleAnswers { account?: string; timezone?: string; days?: string; open?: string; close?: string; duration?: string; state?: string; approval?: string }
const DAY_NAMES: Record<string, number> = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
const ZONE_ALIASES: Record<string, string> = { 'central': 'America/Chicago', 'central time': 'America/Chicago', 'ct': 'America/Chicago', 'cst': 'America/Chicago', 'cdt': 'America/Chicago' };
/** "1,2,3", "1-5", "Mon-Fri", "Monday through Friday", "Mon, Wed" -> sorted day numbers (0 = Sunday); undefined if any part is not understood. */
export function parseDays(raw: string): number[] | undefined {
  const s = raw.trim().toLowerCase().replace(/\s+(?:through|thru|to)\s+/g, '-').replace(/\s*[-–—]\s*/g, '-').replace(/\s*(?:,|and|&)\s*/g, ',');
  if (s === '') return undefined;
  const one = (x: string): number | undefined => (/^[0-6]$/.test(x) ? Number(x) : DAY_NAMES[x]);
  const days = new Set<number>();
  for (const part of s.split(',')) {
    const r = part.split('-');
    if (r.length === 1) { const d = one(part.trim()); if (d === undefined) return undefined; days.add(d); continue; }
    if (r.length !== 2) return undefined;
    const a = one(r[0].trim()); const b = one(r[1].trim()); if (a === undefined || b === undefined) return undefined;
    for (let d = a; ; d = (d + 1) % 7) { days.add(d); if (d === b) break; }
  }
  return [...days].sort((x, y) => x - y);
}
/** "09:00", "9:00", "9", "9am", "9 a.m.", "5pm", "5:30 PM", "17:00" -> "HH:MM"; undefined if not a time. "12 am" is 00:00 and "12 pm" is 12:00. */
export function parseClock(raw: string): string | undefined {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(a\.?m?\.?|p\.?m?\.?)?$/i.exec(raw.trim()); if (m === null) return undefined;
  let h = Number(m[1]); const min = m[2] === undefined ? 0 : Number(m[2]); const ap = m[3]?.[0].toLowerCase();
  if (min > 59) return undefined;
  if (ap !== undefined) { if (h < 1 || h > 12) return undefined; h = (h % 12) + (ap === 'p' ? 12 : 0); } else if (h > 24) return undefined;
  if (h === 24 && min !== 0) return undefined;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
/** "120", "120 minutes", "2 hours", "2 hrs", "1.5 hours" -> minutes. */
export function parseMinutes(raw: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|h|m)?$/i.exec(raw.trim()); if (m === null) return undefined;
  const n = Number(m[1]) * (m[2] !== undefined && /^h/i.test(m[2]) ? 60 : 1); return Number.isInteger(n) ? n : undefined;
}
/** The answers as typed -> the validated answers, or a list of what was wrong, field by field (nothing is defaulted except the account name the founder named). */
export function answersFromText(raw: RawScheduleAnswers): { ok: true; answers: FastTestAnswers } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const account = (raw.account ?? '').trim() || 'Drew Cleaning-Developer Test Account';
  const tzIn = (raw.timezone ?? '').trim(); const timezone = ZONE_ALIASES[tzIn.toLowerCase()] ?? tzIn;
  if (timezone === '') problems.push('time zone: missing (for example America/Chicago, or the word Central)');
  const days = parseDays(raw.days ?? ''); if (days === undefined) problems.push('days: not understood (use 1-5, 1,2,3,4,5 or Mon-Fri; 0 is Sunday)');
  const open = parseClock(raw.open ?? ''); if (open === undefined) problems.push('open time: not understood (for example 09:00, 9:00 or 9am)');
  const close = parseClock(raw.close ?? ''); if (close === undefined) problems.push('close time: not understood (for example 17:00 or 5pm)');
  if (open !== undefined && close !== undefined && open >= close) problems.push('open time must be earlier than the close time');
  const duration = parseMinutes(raw.duration ?? ''); if (duration === undefined) problems.push('cleaning duration: not understood (for example 120, 120 minutes or 2 hours)');
  const st = (raw.state ?? '').trim(); if (st !== '' && !/^[A-Za-z]{2}$/.test(st)) problems.push('state: two letters (for example TX), or leave it empty');
  const ap = (raw.approval ?? '').trim().toLowerCase().replace(/^["'`]|["'`.!]$/g, '').trim();   // YES in any letter case, even with a stray quote or full stop; anything else that is not empty is NOT silently taken as a no
  if (ap !== '' && ap !== 'yes' && ap !== 'no' && ap !== 'n') problems.push('standing approval: type YES to give it, or NO (or press Enter) to withhold it');
  if (problems.length > 0 || days === undefined || open === undefined || close === undefined || duration === undefined) return { ok: false, problems };
  const hours: Record<string, Array<[string, string]>> = {}; for (const d of days) hours[String(d)] = [[open, close]];
  return { ok: true, answers: { jobber_account_name: account, timezone, hours, duration_minutes: duration, standing_approval: ap === 'yes', ...(st === '' ? {} : { state: st.toUpperCase() }) } };
}
