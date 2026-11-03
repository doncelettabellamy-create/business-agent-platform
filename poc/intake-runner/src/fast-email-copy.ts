// The exact words of the controlled Drew test's booking-confirmation EMAILS (proof of concept). PURE: strings only; nothing here is sent by itself. They carry the same facts as the two text messages, with the full date
// and year, and say plainly that this is a test and no cleaning will occur. The tests pin every word. Every value placed in a line has control characters (including line breaks) removed, so nothing can add a header or a line.

import { SENDER_LABEL } from './fast-sms-copy.ts';

export interface EmailFacts {
  businessName: string; serviceLabel: string; bedrooms: number; bathrooms: number; priceDollars: number;
  /** "2026-11-03" */ date: string; /** "10:00 AM" */ startText: string; /** "12:00 PM" */ endText: string; /** "Central" */ zoneLabel: string;
  /** "123 Invented Lane, Testville, TX 90210" */ address: string; customerName: string;
  /** Jobber's own number for the job, as its read-back reported it; absent when Jobber gave none. */ jobNumber?: number;
}
export interface EmailMessage { subject: string; text: string }

const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
/** "2026-11-03" -> "Tuesday, November 3, 2026" (the date as written, whatever the machine's own zone). */
export const emailDay = (date: string): string => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

function body(f: EmailFacts, intro: string): string {
  return [
    intro, '',
    `Name: ${clean(f.customerName)}`,
    `Service: ${clean(f.serviceLabel)}, ${f.bedrooms} bedrooms / ${f.bathrooms} bathrooms`,
    `When: ${emailDay(f.date)}, ${clean(f.startText)} - ${clean(f.endText)} ${clean(f.zoneLabel)}`,
    `Where: ${clean(f.address)}`,
    `Price: $${f.priceDollars}`,
    ...(typeof f.jobNumber === 'number' && Number.isInteger(f.jobNumber) && f.jobNumber > 0 ? [`Booking reference: Jobber job #${f.jobNumber}`] : []), '',
    'The booking was created in a developer test account and read back from it to confirm it. Test only: no cleaning service will occur and nothing was charged.',
    `Sent by ${SENDER_LABEL}. This address was approved for this test only.`, '',
  ].join('\n');
}
export function customerEmail(f: EmailFacts): EmailMessage {
  const first = clean(f.customerName).split(' ')[0] ?? '';
  return { subject: `${clean(f.businessName)} DEMO booking confirmed: ${emailDay(f.date)}`, text: body(f, `Hello${first === '' ? '' : ` ${first}`},\n\nThis is a test confirmation from ${clean(f.businessName)} (a fictional business).`) };
}
export function ownerEmail(f: EmailFacts): EmailMessage {
  return { subject: `${clean(f.businessName)} DEMO: new booking, ${emailDay(f.date)}`, text: body(f, `New ${clean(f.businessName)} DEMO booking for ${clean(f.customerName)}.`) };
}
