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
