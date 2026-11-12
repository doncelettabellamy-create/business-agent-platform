// The business owner's view of the founder phone test (proof of concept). PURE: no I/O, no clock, no environment, no network.
//
// It turns stored intake records into a small, fixed shape that is safe to show to the person who owns the business, and it is a strict
// ALLOW-LIST: the output has exactly the keys below and nothing else is copied across. What it never carries: confidence, reason codes,
// mask tokens or counts of hidden items, pipeline steps, versions, ids, call references, turn counts, the hand-off flag, or any
// address value. Nothing is invented: every value comes from the stored record, and every count is a count of the records given.
//
// What the data can and cannot say:
//   - one record is one phone call that reached the point of being saved ("an intake"); there is no call length, caller number or recording;
//   - a "requested time" is what the caller asked for. Nothing here is a booked appointment, and no text says or implies one;
//   - "next actions" come from a fixed table over the stored state, never from model text.

import type { IntakeRecord } from './intake-record-store.ts';
import { piiProblems } from './pii-screen.ts';
import { followUpState, MARKER_CATEGORY } from './followup-marker.ts';

export const OWNER_LABELS = Object.freeze({
  requestedTime: 'Requested time (not booked)',
  summary: 'Request',
  intakesToday: 'Intakes received today',
  intakesTotal: 'Intakes received in total',
  needFollowUp: 'Need follow-up',
  withRequestedTime: 'With a requested time',
  confirmedByCaller: 'Confirmed by the caller',
});
export const OWNER_TEXT = Object.freeze({
  unknownRequest: 'Not recognised yet',
  withheld: '(withheld)',
  confirmed: 'Confirmed by the caller',
  notConfirmed: 'Not confirmed by the caller',
  followUpUnconfirmed: 'Follow up: the caller did not confirm the details.',
  verifyAddress: 'Verify the address with the caller.',
  addressConfirmedLabel: 'Address',
  addressConfirmedValue: 'Confirmed by the caller on the phone. Not checked against any address data.',
  decideKind: 'Decide what kind of request this is.',
  review: 'A person should review this request.',
  ready: 'Ready for follow-up.',
  /** An owner email notice that was not delivered (src/fast-lead.ts): shown under "Need follow-up", never counted as an intake. */
  noticeRequest: 'Email notice to you not delivered',
  noticeStatus: 'Notice not delivered',
  noticeAction: 'Check the other items on this page: an email about a call that needs follow-up did not reach you.',
  /** A follow-up the owner marked handled (src/followup-marker.ts): it stays in "All", is not open, and returns to open if the owner reopens it. */
  handled: 'Marked handled by the owner.',
});

export interface OwnerDetail { label: string; value: string }
export interface OwnerCall {
  /** 'notice': an owner email notice that was not delivered. It needs follow-up but is NOT an intake: the intake counts leave it out. */
  kind: 'intake' | 'notice';
  /** When the call was saved, as an ISO UTC time. The page shows it in the viewer's own time zone. */
  at: string;
  /** The kind of request in plain words. */
  request: string;
  /** What the caller needs, from the job-description style field; null when none was found. */
  summary: string | null;
  /** What the caller asked for as a time or date; null when none was given. This is a request, not a booking. */
  requestedTime: string | null;
  /** Any other details the caller gave (never the address). */
  details: OwnerDetail[];
  statusText: string;
  needsFollowUp: boolean;
  nextActions: string[];
  /** True when the caller gave an address. The address itself is never carried. */
  addressGiven: boolean;
}
export interface OwnerSummary {
  intakesReceivedToday: number;
  intakesReceivedTotal: number;
  needFollowUp: number;
  withRequestedTime: number;
  confirmedByCaller: number;
}
export interface OwnerView { calls: OwnerCall[]; summary: OwnerSummary }
/** The viewer's "today" as two ISO UTC instants: from (included) to (excluded). The page computes them from the viewer's own clock and zone. */
export interface DayBounds { fromIso: string; toIso: string }

const TOKEN = /\[[A-Z]+_\d{1,3}\]/g;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const ADDRESS_NAME = /address/i;
const TIME_NAME = /\b(?:date|time|when|day)\b/i;
const SUMMARY_NAME = /\b(?:job|description|problem|issue|request|summary|work)\b/i;
const MAX_VALUE = 160;
const MAX_DETAILS = 8;

/** A value safe to show: mask tokens become "(withheld)", brackets are gone, and anything that still looks personal is dropped. Null means: show nothing. */
function showable(value: unknown, max = MAX_VALUE): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(TOKEN, OWNER_TEXT.withheld).replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  if (text.length === 0) return null;
  if (piiProblems(text).length > 0) return null;
  return text;
}

const isIso = (s: unknown): s is string => typeof s === 'string' && ISO.test(s) && !Number.isNaN(Date.parse(s));

function checkRecord(r: unknown): asserts r is IntakeRecord {
  const x = r as Record<string, unknown> | null;
  const ok = typeof x === 'object' && x !== null && isIso(x.received_at) && typeof x.category === 'string' && Array.isArray(x.fields) && Array.isArray(x.missing_fields)
    && (x.confirmation === 'confirmed' || x.confirmation === 'unconfirmed') && (x.address_status === 'unverified' || x.address_status === 'none' || x.address_status === 'caller_confirmed')
    && (x.status === 'ready' || x.status === 'needs-human') && typeof x.handed_off === 'boolean'
    && (x.fields as unknown[]).every((f) => typeof f === 'object' && f !== null && typeof (f as Record<string, unknown>).name === 'string');
  if (!ok) throw new RangeError('not an intake record');
}

/** The next actions for one record: a fixed table over stored state. Empty list never happens: a record that needs nothing says it is ready. */
function actionsFor(r: IntakeRecord): { actions: string[]; needsFollowUp: boolean } {
  const actions: string[] = [];
  if (r.confirmation !== 'confirmed') actions.push(OWNER_TEXT.followUpUnconfirmed);
  if (r.address_status === 'unverified') actions.push(OWNER_TEXT.verifyAddress);
  const asks = r.missing_fields.map((n) => showable(n, 60)).filter((n): n is string => n !== null && n !== OWNER_TEXT.withheld);
  if (asks.length > 0) actions.push(`Ask for: ${asks.join(', ')}.`);
  if (r.category === 'unknown') actions.push(OWNER_TEXT.decideKind);
  const ready = r.confirmation === 'confirmed' && r.status === 'ready' && r.handed_off === true;
  if (actions.length === 0 && !ready) actions.push(OWNER_TEXT.review);
  if (actions.length === 0) return { actions: [OWNER_TEXT.ready], needsFollowUp: false };
  return { actions, needsFollowUp: true };
}

/** An undelivered-owner-notice record (src/fast-lead.ts writes it): its own category AND one of its three fixed reasons. Kept here as two literals so this file imports nothing from the voice code (a test pins that they match). */
const NOTICE_CATEGORY = 'owner-notice'; const NOTICE_REASON = /^notice_(refused|failed|timeout)$/;
const isNotice = (r: IntakeRecord): boolean => r.category === NOTICE_CATEGORY && r.reasons.some((x) => NOTICE_REASON.test(x));

/** One record in the owner's shape. Throws RangeError for anything that is not a record. */
export function toOwnerCall(record: IntakeRecord): OwnerCall {
  checkRecord(record);
  if (isNotice(record)) {
    const field = record.fields.find((f) => f.found && f.value !== null && f.name === 'request');
    return Object.freeze({
      kind: 'notice' as const, at: record.received_at, request: OWNER_TEXT.noticeRequest, summary: showable(field?.value ?? null), requestedTime: null, details: Object.freeze([]) as OwnerDetail[],
      statusText: OWNER_TEXT.noticeStatus, needsFollowUp: true, nextActions: Object.freeze([OWNER_TEXT.noticeAction]) as string[], addressGiven: false,
    });
  }
  let summary: string | null = null;
  let requestedTime: string | null = null;
  const details: OwnerDetail[] = [];
  for (const f of record.fields) {
    if (!f.found || f.value === null || ADDRESS_NAME.test(f.name)) continue;
    const value = showable(f.value);
    const label = showable(f.name, 60);
    if (value === null || label === null) continue;
    if (requestedTime === null && TIME_NAME.test(f.name)) requestedTime = value;
    else if (summary === null && SUMMARY_NAME.test(f.name)) summary = value;
    else if (details.length < MAX_DETAILS) details.push({ label, value });
  }
  // A caller-confirmed address is stated as exactly that, first so it is never cut off, and never as a check.
  if (record.address_status === 'caller_confirmed') details.unshift({ label: OWNER_TEXT.addressConfirmedLabel, value: OWNER_TEXT.addressConfirmedValue });
  const { actions, needsFollowUp } = actionsFor(record);
  const category = record.category === 'unknown' ? null : showable(record.category, 80);
  return Object.freeze({
    kind: 'intake' as const, at: record.received_at,
    request: category ?? OWNER_TEXT.unknownRequest,
    summary, requestedTime,
    details: Object.freeze(details) as OwnerDetail[],
    statusText: record.confirmation === 'confirmed' ? OWNER_TEXT.confirmed : OWNER_TEXT.notConfirmed,
    needsFollowUp,
    nextActions: Object.freeze(actions) as string[],
    addressGiven: record.address_status === 'unverified' || record.address_status === 'caller_confirmed',
  });
}

/** Counts over the calls given, and nothing else. "Today" is the viewer's day, given as two instants. */
export function ownerSummary(calls: readonly OwnerCall[], day: DayBounds): OwnerSummary {
  if (!isIso(day?.fromIso) || !isIso(day?.toIso) || !(Date.parse(day.fromIso) < Date.parse(day.toIso))) throw new RangeError('the day must be two ISO UTC times, from before to');
  const from = Date.parse(day.fromIso); const to = Date.parse(day.toIso);
  const intakes = calls.filter((c) => c.kind !== 'notice');   // an undelivered-notice item needs follow-up but is not a call that was received
  return Object.freeze({
    intakesReceivedToday: intakes.filter((c) => { const t = Date.parse(c.at); return t >= from && t < to; }).length,
    intakesReceivedTotal: intakes.length,
    needFollowUp: calls.filter((c) => c.needsFollowUp).length,
    withRequestedTime: intakes.filter((c) => c.requestedTime !== null).length,
    confirmedByCaller: intakes.filter((c) => c.statusText === OWNER_TEXT.confirmed).length,
  });
}

/** Everything the owner's page needs: the calls, newest first, and the counts. */
export function toOwnerView(records: readonly IntakeRecord[], day: DayBounds): OwnerView {
  if (!Array.isArray(records)) throw new RangeError('records must be a list');
  // Markers are the owner's "handled" / "reopened" notes (src/followup-marker.ts). They are never calls: any record in the marker category is left out, and only a marker that parses exactly can change a state.
  const state = followUpState(records);
  const calls = records.filter((r) => r?.category !== MARKER_CATEGORY).map((r) => {
    const c = toOwnerCall(r);
    return c.needsFollowUp && state.get(r.call_ref)?.handled === true ? Object.freeze({ ...c, needsFollowUp: false, nextActions: Object.freeze([OWNER_TEXT.handled]) as string[] }) : c;   // handled: shown in All, not open, not counted as needing follow-up
  }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return Object.freeze({ calls, summary: ownerSummary(calls, day) });
}
