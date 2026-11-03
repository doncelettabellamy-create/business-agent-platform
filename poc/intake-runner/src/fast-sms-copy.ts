// The exact words of the controlled Drew test's texts and text-consent script (proof of concept). PURE: strings only. They match what was SUBMITTED in the Twilio sole-proprietor campaign (samples 1 and 2 and the consent
// script), so the code, the campaign and the public pages say the same thing; the tests pin every word. Nothing here is sent or spoken by itself.

/** Who the texts say they come from. The founder's own identity and the purpose, as submitted. */
export const SENDER_LABEL = 'Donceletta Bellamy - Developer Testing';
export const CUSTOMER_SCRIPT_ID = 'fast-consent-v1-customer';
export const OWNER_SCRIPT_ID = 'fast-consent-v1-owner';
/** A text body is plain ASCII of at most this many characters (three segments); longer is refused, never cut. */
export const MAX_TEXT_CHARS = 459;

/** The question the caller is asked before any text (spoken as one confirmation unit; a yes counts only after the whole line has played). */
export function customerConsentLine(businessName: string): string {
  return `This is Donceletta Bellamy's developer test using the fictional ${businessName} business. May we send you one automated booking-details text per completed test booking? Message and data rates may apply. Reply STOP to unsubscribe or HELP for help. Texting is optional. Our privacy policy and SMS terms are available on our developer test website and will be provided before you consent. Do you agree?`;
}
/** What the OWNER reads and agrees to once, in the private setup, before any owner text can ever be sent. */
export function ownerConsentText(businessName: string): string {
  return `This is Donceletta Bellamy's developer test using the fictional ${businessName} business. May we send you one automated booking-details text per completed test booking, to the owner test number? Message and data rates may apply. Reply STOP to unsubscribe or HELP for help. Texting is optional. Our privacy policy and SMS terms are available on our developer test website (https://doncelettabellamy-create.github.io/intake-developer-test-site/privacy.html and .../sms-terms.html) and were provided before you consent.`;
}

export interface TextFacts {
  businessName: string; serviceLabel: string; bedrooms: number; bathrooms: number; priceDollars: number;
  /** "Tue Nov 3" */ dateText: string; /** "10:00 AM" */ startText: string; /** "12:00 PM" */ endText: string; /** "Central" */ zoneLabel: string;
  /** "123 Invented Lane, Testville, TX 90210" */ address: string; customerName: string;
}
const tail = (f: TextFacts): string => `${f.serviceLabel}, ${f.bedrooms} bedrooms/${f.bathrooms} bathrooms, $${f.priceDollars}. Test only; no cleaning service will occur. Reply STOP to opt out or HELP for help.`;
export function customerText(f: TextFacts): string {
  return `${SENDER_LABEL}: ${f.businessName} DEMO booking confirmed for ${f.dateText}, ${f.startText}-${f.endText} ${f.zoneLabel}, at ${f.address}. ${tail(f)}`;
}
export function ownerText(f: TextFacts): string {
  return `${SENDER_LABEL}: New ${f.businessName} DEMO booking for ${f.customerName}, ${f.dateText}, ${f.startText}-${f.endText} ${f.zoneLabel}, at ${f.address}. ${tail(f)}`;
}
/** "America/Chicago" -> "Central" (the first word of the zone's long name). */
export function zoneLabelOf(timeZone: string, atMs: number): string {
  try { const p = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'long' }).formatToParts(new Date(atMs)).find((x) => x.type === 'timeZoneName')?.value ?? ''; return p.split(' ')[0] ?? ''; } catch { return ''; }
}
