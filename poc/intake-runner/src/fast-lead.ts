// DURABLE LEAD CAPTURE for the fast cleaning test call (Step 4, offline). When a call ends WITHOUT a booking and the ending would tell the caller that a person will follow up, the call first writes what is true and durable, reads it back, and
// only then is the outcome spoken. Nothing here is invented and nothing here is a promise: it reuses the two stores that already exist, unchanged.
//
//   1. the INTAKE RECORD (intake-record-store.ts): a needs-human, unconfirmed item with a fixed sentence about why the request was not completed. It holds no name, no number and no address; it is what the owner dashboard counts as "Need follow-up".
//   2. the CONTACT (contact-vault.ts: encrypted, its own file, 30-day retention): the caller's CONFIRMED name and CONFIRMED callback number, and only when both were confirmed by the caller's own yes, only for a number on the approved list, and only when the
//      vault is switched on (FOUNDER_CONTACT_KEY). No placeholder name is ever stored, and an unconfirmed caller ID is never kept. The record is written FIRST, so a failed contact write leaves no number behind and a failed record write leaves no contact at all.
//
// The result is one of three words: `stored` (the record AND the contact were written and read back exactly), `recorded` (the record was written and read back, but no number is kept), `failed` (anything else, including a store that throws, a record that
// reads back differently, or a Call SID that cannot be turned into a call reference). The caller is told only what the result supports (fast-call-handler.ts, `leadLine`). The owner finds the number with `contact-lookup` (`--list`, then `--show <call_ref>`).
// Never throws. Writes nothing to any log. Sends nothing to anyone (no text, no email).

import { callRefFor, NOT_CONFIRMED } from './intake-record-store.ts';
import type { IntakeRecord, IntakeRecordStore } from './intake-record-store.ts';
import type { ContactVault } from './contact-vault.ts';

export type LeadResult = 'stored' | 'recorded' | 'failed';
export interface LeadFacts {
  /** The fixed reason code of the ending (for example ADDRESS_NOT_CONFIRMED). */ reason: string;
  /** The Twilio Call SID: used only to make the call reference (a hash), never stored. */ callSid: string;
  /** The name the caller CONFIRMED with a yes, or absent. */ name?: string;
  /** The callback number the caller CONFIRMED with a yes (E.164), already checked against the approved list, or absent. */ callback?: string;
  /** The step tokens reached (only their count is stored). */ steps: readonly string[];
  /** When the call ended, in milliseconds. */ at: number;
}
export interface LeadSink { store: IntakeRecordStore; contacts?: ContactVault; tenant: string }

const CALL_SID = /^CA[0-9a-f]{32}$/;
const E164_US = /^\+1(\d{10})$/;
const REASON = /^[A-Z][A-Z0-9_]{2,47}$/;

/** What the owner sees about why: fixed sentences, never a code and never anything the caller said. */
export function leadSummary(reason: string): string {
  const head = 'Cleaning request not completed';
  if (/^(ADDRESS|STATE)_/.test(reason)) return `${head}: the address was not confirmed.`;
  if (/^NAME_/.test(reason)) return `${head}: the name was not confirmed.`;
  if (/^(WHEN_UNCLEAR|NO_OPENING|NO_LONGER_AVAILABLE|CALENDAR_UNREADABLE)$/.test(reason)) return `${head}: no time could be set.`;
  if (/^SIZE_/.test(reason)) return `${head}: the home size is not one this line books.`;
  if (reason === 'CALLER_HUNG_UP') return `${head}: the caller hung up before the call was finished.`;
  if (reason === 'SPEAKER_DOWN') return `${head}: the call's voice failed before the call was finished.`;
  if (reason === 'BOOKING_SKIPPED_HUNG_UP') return `${head}: the caller hung up before the booking was sent. Nothing was booked.`;
  if (reason === 'NUMBER_UNCLEAR') return `${head}: the callback number was not confirmed.`;
  if (reason === 'BOOKING_NOT_VERIFIED' || reason === 'BOOKING_CHANGED') return `${head}: the booking could not be confirmed. Check Jobber.`;
  return `${head}.`;
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const canon = (x: unknown): string => JSON.stringify(x, (_k, v) => (typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : v));

/** The intake record for one failed call: needs a person, not confirmed, nothing personal in it. */
export function leadRecord(tenant: string, callRef: string, f: LeadFacts): IntakeRecord {
  const code = REASON.test(f.reason) ? f.reason : 'UNKNOWN';
  return {
    item_id: `fast-${callRef}`, workspace_id: tenant, call_ref: callRef, received_at: iso(f.at), category: 'cleaning',
    status: 'needs-human', reasons: [code.toLowerCase(), NOT_CONFIRMED], missing_fields: [],
    fields: [{ name: 'request', value: leadSummary(code), confidence: null, found: true }],
    pii_summary: [], confidence: null, versions: { skill: 'fast-test', model: 'scripted', prompt: 'fast-lead-v1' },
    handed_off: false, turns: Math.min(f.steps.length, 1000), confirmation: 'unconfirmed', address_status: 'none',
  };
}

// ---------------------------------------------------------------- OWNER-NOTICE FAILURE (Stage 1, G3)
// When the owner's email notice for a call that needs follow-up is REFUSED by the mail server, FAILED (an error), or did not finish in time (TIMEOUT: it may still arrive), the owner is told on the dashboard by one more append-only record.
// The lead for the call is already saved and cannot be changed (the store refuses updates), so this is a SEPARATE record: its own call reference (a hash of the Call SID plus a fixed suffix, so it cannot be mistaken for the lead's), and an item id that ends with the LEAD's call reference (`fast-notice-<lead ref>`), which links the two without showing the SID.
// It holds no name, number, address, SID or reason code: a fixed sentence per outcome. The owner view lists it under "Need follow-up" and never counts it as an intake. At most one per call (the unique references make a second write a duplicate). A disabled notice (emails off) is a configured state, shown once on the dashboard, and is not recorded here.
export type NoticeVerdict = 'refused' | 'failed' | 'timeout';
export type NoticeResult = 'recorded' | 'failed';
export interface NoticeFacts { callSid: string; verdict: NoticeVerdict; at: number }
export const NOTICE_CATEGORY = 'owner-notice';
export const NOTICE_REASON = /^notice_(refused|failed|timeout)$/;
const NOTICE_SENTENCE: Readonly<Record<NoticeVerdict, string>> = Object.freeze({
  refused: 'The email notice to you was refused by the mail server, so you were not emailed about a call that needs follow-up. Check the other items on this page.',
  failed: 'The email notice to you could not be sent because of an error, so you were not emailed about a call that needs follow-up. Check the other items on this page.',
  timeout: 'The email notice to you did not finish in time and may not have been delivered. Check the other items on this page.',
});
export const noticeSentence = (v: NoticeVerdict): string => NOTICE_SENTENCE[v];

/** The record for one undelivered owner notice. */
export function noticeRecord(tenant: string, leadRef: string, noticeRef: string, f: NoticeFacts): IntakeRecord {
  return {
    item_id: `fast-notice-${leadRef}`, workspace_id: tenant, call_ref: noticeRef, received_at: iso(f.at), category: NOTICE_CATEGORY,
    status: 'needs-human', reasons: [`notice_${f.verdict}`, NOT_CONFIRMED], missing_fields: [],
    fields: [{ name: 'request', value: NOTICE_SENTENCE[f.verdict], confidence: null, found: true }],
    pii_summary: [], confidence: null, versions: { skill: 'fast-test', model: 'scripted', prompt: 'fast-notice-v1' },
    handed_off: false, turns: 0, confirmation: 'unconfirmed', address_status: 'none',
  };
}

/** The saver for one server: the record is written and read back exactly. Never throws; anything else is `failed`. */
export function makeNoticeFailureSaver(sink: { store: IntakeRecordStore; tenant: string }): (facts: NoticeFacts) => NoticeResult {
  return (facts) => {
    try {
      if (typeof facts.callSid !== 'string' || !CALL_SID.test(facts.callSid) || !(facts.verdict in NOTICE_SENTENCE)) return 'failed';
      const leadRef = callRefFor(sink.tenant, facts.callSid); const noticeRef = callRefFor(sink.tenant, `${facts.callSid}:notice`);
      const record = noticeRecord(sink.tenant, leadRef, noticeRef, facts);
      try { sink.store.put(sink.tenant, record); } catch { return 'failed'; }   // 'duplicate' is not an error: what is stored is compared below
      const back = sink.store.list(sink.tenant).find((r) => r.call_ref === noticeRef);
      return back !== undefined && canon(back) === canon(record) ? 'recorded' : 'failed';
    } catch { return 'failed'; }
  };
}

/** The saver for one server: record first, contact second, both read back exactly. */
export function makeLeadSaver(sink: LeadSink): (facts: LeadFacts) => LeadResult {
  return (facts) => {
    try {
      if (typeof facts.callSid !== 'string' || !CALL_SID.test(facts.callSid)) return 'failed';
      const callRef = callRefFor(sink.tenant, facts.callSid);
      const record = leadRecord(sink.tenant, callRef, facts);
      try { sink.store.put(sink.tenant, record); } catch { return 'failed'; }   // 'duplicate' is not an error: what is stored is compared below
      const back = sink.store.list(sink.tenant).find((r) => r.call_ref === callRef);
      if (back === undefined || canon(back) !== canon(record)) return 'failed';
      const m = facts.callback === undefined ? null : E164_US.exec(facts.callback);
      if (sink.contacts === undefined || facts.name === undefined || m === null) return 'recorded';
      const phone = m[1];
      try { sink.contacts.put(sink.tenant, callRef, { name: facts.name, phone, address_state: 'unconfirmed' }); } catch { /* a refused second write for this call, or a real failure: the read-back below decides */ }
      let got; try { got = sink.contacts.get(sink.tenant, callRef); } catch { return 'recorded'; }
      return got !== undefined && got.name === facts.name && got.phone === phone && got.address === undefined && got.address_state === 'unconfirmed' ? 'stored' : 'recorded';
    } catch { return 'failed'; }
  };
}
