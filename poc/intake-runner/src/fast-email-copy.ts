// The exact words of the controlled Drew test's booking-confirmation EMAILS (proof of concept). PURE: strings only; nothing here is sent by itself. They carry the same facts as the two text messages, with the full date
// and year, and say plainly that this is a test and no cleaning will occur. The tests pin every word. Every value placed in a line has control characters (including line breaks) removed, so nothing can add a header or a line.

import { SENDER_LABEL } from './fast-sms-copy.ts';

export interface EmailFacts {
  businessName: string; serviceLabel: string; bedrooms: number; bathrooms: number; priceDollars: number;
  /** "2026-11-03" */ date: string; /** "10:00 AM" */ startText: string; /** "12:00 PM" */ endText: string; /** "Central" */ zoneLabel: string;
  /** "123 Invented Lane, Testville, TX 90210" */ address: string; customerName: string;
  /** Jobber's own number for the job, as its read-back reported it; absent when Jobber gave none. */ jobNumber?: number;
  /** The callback number the caller CONFIRMED, E.164 ("+15550100002"). Shown in the OWNER's email only; the customer's email never carries it; omitted unless it is a plain US number. */ callbackNumber?: string;
}
export interface EmailMessage { subject: string; text: string }

const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
/** "2026-11-03" -> "Tuesday, November 3, 2026" (the date as written, whatever the machine's own zone). */
export const emailDay = (date: string): string => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

/** "+15550100002" -> "(555) 010-0002"; anything that is not a plain US number gives undefined. */
const usPhone = (e164: unknown): string | undefined => { const m = typeof e164 === 'string' ? /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164) : null; return m === null ? undefined : `(${m[1]}) ${m[2]}-${m[3]}`; };
const BOOKED_NOTE = 'The booking was created in a developer test account and read back from it to confirm it. Test only: no cleaning service will occur and nothing was charged.';
function body(f: EmailFacts, intro: string, forOwner = false, note = BOOKED_NOTE): string {
  const phone = forOwner ? usPhone(f.callbackNumber) : undefined;
  return [
    intro, '',
    `Name: ${clean(f.customerName)}`,
    ...(phone === undefined ? [] : [`Callback number: ${phone}`]),
    `Service: ${clean(f.serviceLabel)}, ${f.bedrooms} bedrooms / ${f.bathrooms} bathrooms`,
    `When: ${emailDay(f.date)}, ${clean(f.startText)} - ${clean(f.endText)} ${clean(f.zoneLabel)}`,
    `Where: ${clean(f.address)}`,
    `Price: $${f.priceDollars}`,
    ...(typeof f.jobNumber === 'number' && Number.isInteger(f.jobNumber) && f.jobNumber > 0 ? [`Booking reference: Jobber job #${f.jobNumber}`] : []), '',
    note,
    `Sent by ${SENDER_LABEL}. This address was approved for this test only.`, '',
  ].join('\n');
}
export function customerEmail(f: EmailFacts): EmailMessage {
  const first = clean(f.customerName).split(' ')[0] ?? '';
  return { subject: `${clean(f.businessName)} DEMO booking confirmed: ${emailDay(f.date)}`, text: body(f, `Hello${first === '' ? '' : ` ${first}`},\n\nThis is a test confirmation from ${clean(f.businessName)} (a fictional business).`) };
}
/** The ONE message the setup's email check sends (to the owner address only): invented sample facts, clearly marked, no real name, address, number or booking. */
export function sampleEmail(businessName = 'Drew Cleaning'): EmailMessage {
  const f: EmailFacts = { businessName, serviceLabel: 'Standard cleaning', bedrooms: 2, bathrooms: 2, priceDollars: 199, date: '2027-01-06', startText: '10:00 AM', endText: '12:00 PM', zoneLabel: 'Central', address: '123 Sample Street, Sampleville, CA 90000', customerName: 'Sample Customer', callbackNumber: '+15550100100' };
  return { subject: `${clean(businessName)} DEMO SAMPLE: email check (no booking exists)`, text: `${body(f, 'This is a SAMPLE email from the Drew test setup check. No booking exists, no call happened and nothing was charged. Every detail below is invented.', true, 'This sample has no booking behind it: nothing was created in Jobber and no cleaning will occur.')}If you can read this, the sender login and this address work. Check that it reached the inbox and not the spam folder.\n` };
}
export function ownerEmail(f: EmailFacts): EmailMessage {
  return { subject: `${clean(f.businessName)} DEMO: new booking, ${emailDay(f.date)}`, text: body(f, `New ${clean(f.businessName)} DEMO booking for ${clean(f.customerName)}.`, true) };
}

// ---------------------------------------------------------------- the owner's follow-up notice
export interface FollowUpFacts {
  businessName: string;
  /** The ending's fixed reason code. Anything that is not an upper-case code of at most 48 characters is shown as UNKNOWN. */
  reason: string;
  /** When the call ended, as text built by the caller of this function (a date, a time and the zone). */
  whenText: string;
  /** The callback number: E.164. Shown only when it is a plain US number. */
  callbackNumber?: string;
  /** The call's step tokens in order (fixed codes). Anything that is not such a code is dropped, so nothing a caller said can appear. */
  steps: readonly string[];
  /** True when the booking request had already been sent to Jobber when the call ended: a job may exist even though it was not verified. */
  bookingMayExist: boolean;
  /** The Twilio Call SID, so the owner can find the call. Shown only when it is exactly `CA` and 32 lower-case hex characters; anything else adds no line at all. Passed only for a speaker failure. */
  callSid?: string;
}
const CALL_SID = /^CA[0-9a-f]{32}$/;
const CODE = /^[A-Z][A-Z0-9_]{2,47}$/;
/**
 * The ONE notice the owner gets when a call ended without completing the request and needs a follow-up: the reason code, the time, the callback number and the steps reached. Fixed words only; no name,
 * address, day, price or anything else the caller said (none of it is passed in). PURE: strings only.
 */
export function followUpEmail(f: FollowUpFacts): EmailMessage {
  const phone = usPhone(f.callbackNumber);
  const steps = (Array.isArray(f.steps) ? f.steps : []).filter((s): s is string => typeof s === 'string' && CODE.test(s)).slice(0, 40);
  const reason = typeof f.reason === 'string' && CODE.test(f.reason) ? f.reason : 'UNKNOWN';
  const sid = typeof f.callSid === 'string' && CALL_SID.test(f.callSid) ? f.callSid : undefined;
  return {
    subject: `${clean(f.businessName)} DEMO: call needs a follow-up`,
    text: [
      `A ${clean(f.businessName)} DEMO call ended without completing the request, and it needs a follow-up. Nobody else has been told.`, '',
      `Reason code: ${reason}`,
      `Callback number: ${phone ?? 'not available'}`,
      `Call ended: ${clean(f.whenText)}`,
      ...(sid === undefined ? [] : [`Call SID: ${sid}`]),
      `Steps reached: ${steps.length === 0 ? 'none' : steps.join(', ')}`,
      f.bookingMayExist === true ? 'Check Jobber (the Developer Test Account): the booking request was sent, so a job may exist even though it was not verified.' : 'No booking was sent to Jobber.', '',
      'This notice holds no name, address or anything else the caller said.',
      `Sent by ${SENDER_LABEL}. This address was approved for this test only.`, '',
    ].join('\n'),
  };
}
