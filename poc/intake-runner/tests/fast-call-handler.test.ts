// The fast Drew test call, run against stand-ins: a fake carrier that measures playback, a fake calendar, a fake booking adapter and fake texts. No real call, booking or message exists here, and every name, number and
// address is invented. The hours in SETTINGS are a SYNTHETIC test fixture, not the founder's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AI_ANSWER, addressIssues, confirmedMismatches, spellHouseNumber, transcriptShape, createFastCallHandler, spellOut, spellStreet } from '../src/fast-call-handler.ts';
import type { AddressToValidate, AddressVerdict, FastDeps, FastOutcome, FastSettings } from '../src/fast-call-handler.ts';
import { instantOf } from '../src/fast-parsers.ts';
import type { BookingRequest, IdentityBookingRequest, BookingResult } from '../src/jobber-booking.ts';
import { requestProblems } from '../src/jobber-booking.ts';
import type { Delivery, SendResult } from '../src/twilio-messaging.ts';
import { cleanDetail } from '../src/call-diag.ts';
import { fakeCarrier } from './helpers/fake-carrier.ts';
import { callRefFor, createIntakeRecordStore } from '../src/intake-record-store.ts';
import { createContactVault } from '../src/contact-vault.ts';
import { makeLeadSaver } from '../src/fast-lead.ts';
import { createRealtimeBridge } from '../src/realtime-bridge.ts';
import { createRealtimeTransport } from '../src/realtime-transport.ts';
import { createWirePhone, createWireVoice } from './helpers/realtime-wire-sim.ts';

const TZ = 'America/Chicago'; const NOW = Date.parse('2026-11-02T15:00:00Z');   // Monday 9:00 in Chicago
const TENANT = 'ws-fast-test'; const CONTACT_KEY = Buffer.alloc(32, 7);   // a made-up key of this test
const DREW = '+15550100001'; const CUSTOMER = '+15550100002'; const OWNER = '+15550100003'; const STRANGER = '+15550100099';
const SETTINGS: FastSettings = { businessName: 'Drew Cleaning', serviceLabel: 'Standard cleaning', bedrooms: 2, bathrooms: 2, priceDollars: 199, standingApproval: true, state: 'CA',
  availability: { timezone: TZ, hours: { 1: [['09:00', '17:00']], 2: [['09:00', '17:00']], 3: [['09:00', '17:00']], 4: [['09:00', '17:00']], 5: [['09:00', '17:00']] }, durationMinutes: 120, stepMinutes: 30, leadMinutes: 60 } };

function build(o: { /** The durable lead sink: a REAL intake store and a REAL encrypted contact vault, both in memory ('none': no sink at all; 'record-only': no contact vault). */ leads?: 'none' | 'record-only'; saveLead?: FastDeps['saveLead']; settings?: Partial<FastSettings>; caller?: string | undefined; busy?: { busy: Array<{ start: number; end: number }>; complete: boolean }; book?: (r: BookingRequest | IdentityBookingRequest) => BookingResult | Promise<BookingResult>; busyHold?: Promise<void>; slotHoldMs?: number; send?: (to: string, body: string) => SendResult; delivery?: Delivery; customers?: string[]; textsEnabled?: boolean; ownerConsent?: boolean; consentOk?: boolean; answerWaitMs?: number; settleMs?: number | null; busyLater?: { busy: Array<{ start: number; end: number }>; complete: boolean }; emails?: 'accept' | 'refuse' | 'throw' | 'hang'; followUpMs?: number; emailsOff?: boolean; holdGraceMs?: number; holdMaxMs?: number; maxCalls?: number; validate?: (a: AddressToValidate) => Promise<unknown>; validateMs?: number } = {}) {
  const logs: Array<[string, unknown]> = []; const outcomes: FastOutcome[] = []; const mails: Array<{ role: string; subject: string; text: string }> = []; const booked: Array<BookingRequest | IdentityBookingRequest> = []; const texts: Array<{ to: string; body: string }> = []; const consents: Array<{ result: string; script: string; ref: string }> = []; let busyCalls = 0;
  const records = createIntakeRecordStore({ path: ':memory:' }); const vault = createContactVault({ path: ':memory:', key: CONTACT_KEY, now: () => NOW });
  const deps: FastDeps = {
    ...(o.leads === 'none' ? {} : { saveLead: o.saveLead ?? makeLeadSaver({ store: records, ...(o.leads === 'record-only' ? {} : { contacts: vault }), tenant: TENANT }) }),
    settings: { ...SETTINGS, ...o.settings }, numbers: new Set([DREW]), approvedCallers: new Set([CUSTOMER]), approvedCustomerNumbers: new Set(o.customers ?? [CUSTOMER]), ownerNumber: OWNER, maxCalls: o.maxCalls ?? 5,
    now: () => NOW, callerOf: async () => ('caller' in o ? o.caller : CUSTOMER), busy: async () => { busyCalls++; if (o.busyHold !== undefined && busyCalls > 1) await o.busyHold; return (busyCalls > 1 && o.busyLater !== undefined ? o.busyLater : o.busy) ?? { busy: [], complete: true }; },
    book: async (r) => { booked.push(r); return (o.book ?? (() => ({ status: 'booked_verified', jobId: 'JOB-1', jobNumber: 1001, writes: 2 })))(r); },
    sendText: async (to, body) => { texts.push({ to, body }); return (o.send ?? (() => ({ ok: true, sid: `SM${'1'.repeat(32)}` })))(to, body); },
    textsEnabled: o.textsEnabled ?? true, ownerConsent: o.ownerConsent ?? true, recordConsent: async (e) => { consents.push(e); return o.consentOk ?? true; },
    verifyText: async () => o.delivery ?? 'delivered', log: (c, d) => { logs.push([c, d]); }, onOutcome: (x) => { outcomes.push(x); },
    emailsEnabled: o.emails !== undefined && o.emailsOff !== true, ...(o.emails === undefined ? {} : { sendEmail: async (role: 'customer' | 'owner', subject: string, text: string) => { mails.push({ role, subject, text }); if (o.emails === 'hang') return new Promise<{ ok: boolean }>(() => undefined); if (o.emails === 'throw') throw new Error('mail down'); return { ok: o.emails === 'accept' }; } }),
    answerWaitMs: o.answerWaitMs ?? 5000, settleMs: o.settleMs === null ? undefined : o.settleMs ?? 15, playbackMaxMs: 5000, afterSpeechMs: 5, holdGraceMs: o.holdGraceMs ?? 15, holdMaxMs: o.holdMaxMs ?? 300,
    ...(o.validate === undefined ? {} : { validateAddress: o.validate as (a: AddressToValidate) => Promise<AddressVerdict> }), ...(o.validateMs === undefined ? {} : { validateMs: o.validateMs }), ...(o.followUpMs === undefined ? {} : { followUpMs: o.followUpMs }), ...(o.slotHoldMs === undefined ? {} : { slotHoldMs: o.slotHoldMs }),
  };
  const h = createFastCallHandler(deps); const c = fakeCarrier();
  return { h, c, logs, outcomes, mails, booked, texts, consents, records, vault, busyCalls: () => busyCalls, last: () => outcomes[outcomes.length - 1] };
}
/** The caller's side of a complete call up to the offer, with the usual answers. */
async function toOffer(c: ReturnType<typeof fakeCarrier>, when = 'Tuesday at ten'): Promise<void> {
  c.setup(DREW, undefined, 'Testa Invented');   // the greeting asked for the name; this is the answer
  await c.hears(/Is that right\? Say yes or no/, 'yes'); await c.hears(/street address/, '123 Invented Lane, Testville, CA 90210');
  await c.hears(/What day and time/, when);
  await c.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
}
const finish = async (c: ReturnType<typeof fakeCarrier>): Promise<void> => { await c.drain(() => c.ended > 0 && c.closed > 0, 'the call to end'); };
const FOLLOW_UP_SUBJECT = 'Drew Cleaning DEMO: call needs a follow-up';
/** The BOOKING emails only. The owner's follow-up notice (M1) is a different message, tested on its own: at most one per call, and only to the owner role. */
const bookingMails = (t: ReturnType<typeof build>) => { const n = t.mails.filter((m) => m.subject === FOLLOW_UP_SUBJECT); assert.ok(n.length <= 1 && n.every((m) => m.role === 'owner'), 'at most one follow-up notice, to the owner role only'); return t.mails.filter((m) => m.subject !== FOLLOW_UP_SUBJECT); };
const noPersonalDetail = (logs: Array<[string, unknown]>, extra: string[] = []): void => { const all = JSON.stringify(logs); for (const s of ['Testa', 'Invented', 'Testville', '90210', '5550100002', '5550100003', '0100002', ...extra]) assert.ok(!all.includes(s), `no ${s} in the diagnostics`); };

test('the whole call: name, address with city and ZIP, day and time, size, $199 with a time the calendar supports, agreement, verified caller ID as the callback number, text permission, read-back, the Jobber test booking, both texts, delivery checked', async () => {
  const t = build();
  t.h.serve(t.c.transport); await toOffer(t.c);
  const offer = await t.c.hears(/is one hundred ninety-nine dollars/, 'yes');
  assert.equal(offer, 'A standard cleaning for two bedrooms and two bathrooms is one hundred ninety-nine dollars. We have Tuesday, November third, 2026 at 10 A M. Does that work?');
  assert.equal(await t.c.hears(/calling from a number ending in/, 'yes'), 'I see you are calling from a number ending in 0 0 0 2. Is that the best number to reach you?');
  await t.c.hears(/May we send you one automated/, 'yes');
  const readback = await t.c.hears(/To confirm/, 'yes');
  assert.equal(readback, 'To confirm: Standard cleaning for Testa Invented on Tuesday, November third, 2026 at 10 A M, at 123 Invented Lane, house number 1 2 3, street spelled I N V E N T E D, L A N E, Testville, California, 9 0 2 1 0. The price is one hundred ninety-nine dollars. Shall I book it? Say yes or no.');
  await finish(t.c);
  assert.equal(t.booked.length, 1);
  const r = t.booked[0];
  assert.deepEqual([r.client, r.address, r.when, r.title, r.priceDollars], [{ firstName: 'Testa', lastName: 'Invented', phone: '5550100002' }, { street1: '123 Invented Lane', city: 'Testville', postalCode: '90210', province: 'CA' }, { date: '2026-11-03', startTime: '10:00', endTime: '12:00', utcOffset: '-06:00' }, 'Standard cleaning', 199]);
  assert.deepEqual(r.gate, { eligibleRecord: true, approvedByPerson: true, callerAgreed: true }); assert.equal((r as { key?: string }).key, undefined, 'no key is made from the call'); assert.deepEqual((r as IdentityBookingRequest).identity, { phone: '5550100002', date: '2026-11-03', startTime: '10:00', street: '123 Invented Lane', zip: '90210' }, 'the identity is the booking itself');
  assert.deepEqual(t.texts.map((x) => x.to), [CUSTOMER, OWNER]);
  assert.equal(t.texts[0].body, 'Donceletta Bellamy - Developer Testing: Drew Cleaning DEMO booking confirmed for Tue Nov 3, 10:00 AM-12:00 PM Central, at 123 Invented Lane, Testville, CA 90210. Standard cleaning, 2 bedrooms/2 bathrooms, $199. Test only; no cleaning service will occur. Reply STOP to opt out or HELP for help.');
  assert.equal(t.texts[1].body, 'Donceletta Bellamy - Developer Testing: New Drew Cleaning DEMO booking for Testa Invented, Tue Nov 3, 10:00 AM-12:00 PM Central, at 123 Invented Lane, Testville, CA 90210. Standard cleaning, 2 bedrooms/2 bathrooms, $199. Test only; no cleaning service will occur. Reply STOP to opt out or HELP for help.');
  assert.deepEqual(t.consents.map((c) => [c.result, c.script]), [['yes', 'fast-consent-v1-customer']]); assert.match(t.consents[0].ref, /^[0-9a-f]{24}$/);
  assert.equal(t.c.lines.at(-1), 'You are booked for Tuesday, November third, 2026 at 10 A M. A confirmation text is on its way. Goodbye.');
  assert.deepEqual([t.last().reason, t.last().booked, t.last().customerText, t.last().ownerText], ['TEXTS_VERIFIED', true, 'delivered', 'delivered']);
  const asks = t.c.lines.filter((l) => /\?|Say yes or no/.test(l)); assert.equal(new Set(asks).size, asks.length, 'no question was asked twice');
  noPersonalDetail(t.logs);
});

test('answers are kept: an address said in pieces asks only for what is missing, once each; a day without a time and a size said in two answers are not asked again', async () => {
  const t = build();
  t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented');
  await t.c.hears(/Is that right\? Say yes or no/, 'yes'); await t.c.hears(/street address/, '123 Invented Lane');
  await t.c.hears(/What is the city/, 'Testville');
  await t.c.hears(/ZIP code\?$/, 'CA 90210');
  await t.c.hears(/What day and time/, 'Tuesday');
  await t.c.hears(/bedrooms and bathrooms/, 'two bedrooms');
  await t.c.hears(/And how many bathrooms/, 'two');
  const offer = await t.c.hears(/is one hundred ninety-nine dollars/, 'no');
  assert.match(offer, /We have Tuesday, November third, 2026 at 9 A M\./, 'only a day was asked for: the earliest time that day');
  const count = (re: RegExp): number => t.c.lines.filter((l) => re.test(l)).length;
  assert.deepEqual([count(/the street address/), count(/^What is the city\?$/), count(/^And the ZIP code\?$/), count(/What day and time/), count(/How many bedrooms and bathrooms/)], [1, 1, 1, 1, 1]);
  assert.equal(count(/first and last name/), 0, 'the greeting asked the name; the call never asks it again');
});

test('a name said in one word asks only for the last name; the first and last are used as said', async () => {
  const t = build(); t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa');
  await t.c.hears(/last name/, 'Invented');
  await t.c.hears(/Is that right\? Say yes or no/, 'yes'); await t.c.hears(/street address/, '123 Invented Lane, Testville, CA 90210');
  assert.equal(t.c.lines.filter((l) => /first and last name/.test(l)).length, 0);
});

test('measured confirmation: a yes before the line has finished playing is HELD and confirms nothing; the line is spoken again after the approved instruction and only a fresh yes after the whole line counts', async () => {
  const t = build(); t.h.serve(t.c.transport); await toOffer(t.c);
  await t.c.hears(/is one hundred ninety-nine dollars/, 'yes', { early: true });
  assert.ok(t.logs.some(([c]) => c === 'CONFIRM_HELD'));
  const again = await t.c.hears(/Please wait until I have finished, then answer\. A standard cleaning/, 'yes');
  assert.match(again, /We have Tuesday, November third, 2026 at 10 A M\. Does that work\?$/);
  await t.c.hears(/calling from a number ending in/, 'yes');
  await t.c.hears(/May we send you one automated/, 'yes');
  await t.c.hears(/To confirm/, 'yes', { early: true });   // an early yes to the read-back
  assert.equal(t.booked.length, 0, 'an early yes booked nothing');
  await t.c.hears(/Please wait until I have finished, then answer\. To confirm/, 'yes');
  await finish(t.c); assert.equal(t.booked.length, 1);
});

test('a read-back that was cut or never reported is replayed; after two replays the call ends unconfirmed and nothing is booked', async () => {
  const t = build(); t.h.serve(t.c.transport); await toOffer(t.c);
  await t.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await t.c.hears(/calling from/, 'yes'); await t.c.hears(/May we send you one automated/, 'yes');
  await t.c.hears(/^To confirm/, undefined, { verdict: 'cut' });
  await t.c.hears(/Please wait until I have finished, then answer\. To confirm/, undefined, { verdict: 'timeout' });
  await t.c.hears(/Please wait until I have finished, then answer\. Please wait|Please wait until I have finished, then answer\. To confirm/, undefined, { verdict: 'cut' });
  await finish(t.c);
  assert.equal(t.booked.length, 0); assert.equal(t.last().reason, 'UNCONFIRMED'); assert.match(t.c.lines.at(-1)!, /could not confirm that/);
});

test('controlled test: a caller who is not on the approved list, or whose caller ID cannot be read, hears one line and the call ends with nothing asked, read or booked', async () => {
  for (const caller of [STRANGER, undefined]) {
    const t = build({ caller }); t.h.serve(t.c.transport); t.c.setup(DREW);
    await t.c.drain(() => t.c.ended > 0 && t.c.closed > 0);
    assert.deepEqual(t.c.lines, ['This is a private test line. Goodbye.']); assert.equal(t.busyCalls(), 0); assert.equal(t.booked.length, 0); assert.equal(t.last().reason, 'NOT_APPROVED');
  }
  const t = build(); t.h.serve(t.c.transport); t.c.setup('+15550100077'); await t.c.drain(() => t.c.ended > 0); assert.equal(t.last().reason, 'UNKNOWN_NUMBER'); assert.deepEqual(t.c.lines, []);
});

test('no yes prompt: the greeting from the carrier asks for the name, so nothing is spoken first and the first thing the caller says is the answer; a yes or an off-topic line is not a name and the name is asked for again; silence is reprompted once and ends the call', async () => {
  const t = build(); t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented');
  await t.c.hears(/Is that right\? Say yes or no/, 'yes'); await t.c.hears(/street address/, undefined); assert.match(t.c.lines[0], /^I have Testa, T E S T A, Invented, I N V E N T E D\. Is that right\?/, 'the first thing the call says is the name confirmation: the greeting already asked the name'); assert.match(t.c.lines[1], /street address/, 'then the address question');
  assert.ok(!t.logs.some(([c]) => /CONSENT/.test(c)) && !t.c.lines.some((l) => /say yes to continue/i.test(l)), 'no yes is asked for anywhere');
  const y = build(); y.h.serve(y.c.transport); y.c.setup(DREW, undefined, 'yes');
  await y.c.hears(/^Sorry, what is your first and last name\?$/, 'Testa Invented'); await y.c.hears(/Is that right\? Say yes or no/, 'yes'); await y.c.hears(/street address/, undefined);
  const s = build({ answerWaitMs: 60 }); s.h.serve(s.c.transport); s.c.setup(DREW);
  await s.c.hears(/Sorry, I did not catch that\. What is your first and last name/, undefined); await s.c.drain(() => s.c.ended > 0 && s.c.closed > 0);
  assert.equal(s.last().reason, 'NO_ANSWER'); assert.equal(s.busyCalls(), 0);
});

test('HONESTY: asked whether this is a person, a robot or an A I - at ANY step, even over a line that is still playing - Jack says truthfully that he is an A I assistant, and the question in progress is asked again; the question is never taken as an answer', async () => {
  const ANSWER = "Yes, I'm an A I assistant for Drew Cleaning, not a person. This is a test call.";
  assert.equal(AI_ANSWER, ANSWER);
  // at the name step (the greeting's question)
  const a = build(); a.h.serve(a.c.transport); a.c.setup(DREW, undefined, 'are you a robot?');
  assert.equal(await a.c.hears(/^Yes, I'm an A I assistant/, undefined), ANSWER);
  await a.c.hears(/^What is your first and last name\?$/, 'Testa Invented'); await a.c.hears(/Is that right\? Say yes or no/, 'yes'); await a.c.hears(/street address/, undefined);
  // at an information step: the address parts already given are kept, and only the question is repeated
  const b = build(); b.h.serve(b.c.transport); b.c.setup(DREW, undefined, 'Testa Invented');
  await b.c.hears(/Is that right\? Say yes or no/, 'yes'); await b.c.hears(/street address/, '123 Invented Lane'); await b.c.hears(/What is the city/, 'is this a real person?');
  assert.equal(await b.c.hears(/^Yes, I'm an A I assistant/, undefined), ANSWER);
  await b.c.hears(/^What is the city\?$/, 'Testville'); await b.c.hears(/ZIP code\?$/, 'CA 90210'); await b.c.hears(/What day and time/, undefined);
  // at a confirmation unit, over the line while it is still playing: the answer is given, the unit is spoken again after the approved instruction, and the question confirms or denies nothing
  const c = build(); c.h.serve(c.c.transport); await toOffer(c.c);
  await c.c.hears(/is one hundred ninety-nine dollars/, 'am I talking to a human?', { early: true });   // the helper lets everything pending finish, the answer included
  await c.c.until(() => c.c.lines.includes(ANSWER), 'the truthful answer');
  assert.match(await c.c.hears(/Please wait until I have finished, then answer\. A standard cleaning/, 'yes'), /Does that work\?$/);
  assert.equal(c.booked.length, 0); await c.c.hears(/calling from/, 'are you an A I?'); await c.c.hears(/^Yes, I'm an A I assistant/, undefined);
  assert.match(await c.c.hears(/Please wait until I have finished, then answer\. I see you are calling/, 'yes'), /best number/);
  assert.equal(c.logs.filter(([code]) => code === 'FAST_AI_QUESTION').length, 2);
  // every spoken line of the happy path says nothing that claims to be human, and names are not mistaken for the question
  for (const name of ['Bot Johnson', 'Robin Lee', 'Al Machine']) { const n = build(); n.h.serve(n.c.transport); n.c.setup(DREW, undefined, `my name is ${name}`); await n.c.hears(/Is that right\? Say yes or no/, 'yes'); await n.c.hears(/street address/, undefined); assert.ok(!n.c.lines.some((l) => /A I assistant/.test(l)), name); }
  assert.ok(![...a.c.lines, ...b.c.lines, ...c.c.lines].some((l) => /\b(?:i am|i'm) (?:a )?(?:real |human|person)/i.test(l.replace(/not a person/g, ''))), 'no line claims to be a person');
});

test('only the one priced size is booked: any other size ends politely before the calendar is read', async () => {
  const t = build(); t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented');
  await t.c.hears(/Is that right\? Say yes or no/, 'yes'); await t.c.hears(/street address/, '123 Invented Lane, Testville, CA 90210'); await t.c.hears(/What day and time/, 'Tuesday at ten');
  await t.c.hears(/bedrooms and bathrooms/, 'three bedrooms and two bathrooms');
  await finish(t.c);
  assert.equal(t.last().reason, 'SIZE_NOT_OFFERED'); assert.equal(t.busyCalls(), 0); assert.equal(t.booked.length, 0); assert.match(t.c.lines.at(-1)!, /only book two bedroom, two bathroom homes/);
});

test('no time is invented: an unreadable or incomplete calendar, missing hours, or no opening each end with "a person will call" and no offer, no price promise on a time and no booking', async () => {
  for (const [label, o, reason] of [['incomplete', { busy: { busy: [], complete: false } }, 'CALENDAR_UNREADABLE'], ['no hours', { settings: { availability: { ...SETTINGS.availability, hours: {} } } }, 'NO_OPENING'], ['all busy', { busy: { busy: [{ start: NOW, end: NOW + 40 * 86_400_000 }], complete: true } }, 'NO_OPENING']] as const) {
    const t = build(o as never); t.h.serve(t.c.transport); await toOffer(t.c); await finish(t.c);
    assert.equal(t.last().reason, reason, label); assert.equal(t.booked.length, 0, label); assert.ok(!t.c.lines.some((l) => /is one hundred ninety-nine dollars/.test(l)), `${label}: no offer was spoken`);
  }
  const t = build({ busy: { busy: [{ start: instantOf('2026-11-03', '09:00', TZ), end: instantOf('2026-11-03', '12:00', TZ) }], complete: true } }); t.h.serve(t.c.transport); await toOffer(t.c);
  assert.match(await t.c.hears(/is one hundred ninety-nine dollars/, 'no'), /I do not have 10 A M on Tuesday, November third, 2026. The nearest time I have that day is 12 P M./, 'the calendar\'s busy time moved the offer');
});

test('the caller can decline the time: a different one is offered and the same time is never offered twice; two refusals end the call with nothing booked', async () => {
  const t = build(); t.h.serve(t.c.transport); await toOffer(t.c);
  const first = await t.c.hears(/is one hundred ninety-nine dollars/, 'no'); assert.match(first, /10 A M/);
  await t.c.hears(/What other day and time/, 'Tuesday at ten again');
  const second = await t.c.hears(/is one hundred ninety-nine dollars/, 'no'); assert.ok(!/at 10 A M/.test(second), 'the refused 10 A M is not offered again');
  await finish(t.c); assert.equal(t.last().reason, 'OFFER_DECLINED'); assert.equal(t.booked.length, 0);
});

test('callback number: the caller ID is the candidate; a no asks for a number, said in pieces, read back and confirmed; a text goes only to an approved customer number, the owner is texted either way', async () => {
  const t = build({ customers: [CUSTOMER] }); t.h.serve(t.c.transport); await toOffer(t.c);
  await t.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await t.c.hears(/calling from a number ending in/, 'no');
  await t.c.hears(/What is the best number/, 'five five five zero one');
  await t.c.hears(/remaining 5 digits/, 'zero zero zero nine nine');
  assert.equal(await t.c.hears(/I heard/, 'yes'), 'I heard 5 5 5 0 1 0 0 0 9 9. Is that right?');
  await t.c.hears(/May we send you one automated/, 'yes'); await t.c.hears(/To confirm/, 'yes'); await finish(t.c);
  assert.equal(t.booked[0].client.phone, '5550100099');
  assert.deepEqual(t.texts.map((x) => x.to), [OWNER], 'the number given is not on the approved list: no customer text');
  assert.ok(!/text is on its way/.test(t.c.lines.at(-1)!) && /could not send the text/.test(t.c.lines.at(-1)!));
});

test('text permission: a no books without a customer text and the owner is still texted; a final no books nothing; no standing approval books nothing', async () => {
  const a = build(); a.h.serve(a.c.transport); await toOffer(a.c);
  await a.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await a.c.hears(/calling from/, 'yes'); await a.c.hears(/May we send you one automated/, 'no'); await a.c.hears(/To confirm/, 'yes'); await finish(a.c);
  assert.deepEqual(a.texts.map((x) => x.to), [OWNER]); assert.equal(a.booked.length, 1); assert.doesNotMatch(a.c.lines.at(-1)!, /text/i);
  const b = build(); b.h.serve(b.c.transport); await toOffer(b.c);
  await b.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await b.c.hears(/calling from/, 'yes'); await b.c.hears(/May we send you one automated/, 'yes'); await b.c.hears(/To confirm/, 'no'); await b.c.hears(/Which part is wrong/, 'never mind'); await finish(b.c);
  assert.equal(b.booked.length, 0); assert.equal(b.texts.length, 0); assert.equal(b.last().reason, 'DECLINED_AT_READBACK');
  const c = build({ settings: { standingApproval: false } }); c.h.serve(c.c.transport); await toOffer(c.c);
  await c.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await c.c.hears(/calling from/, 'yes'); await c.c.hears(/May we send you one automated/, 'yes'); await c.c.hears(/To confirm/, 'yes'); await finish(c.c);
  assert.equal(c.booked.length, 0); assert.equal(c.last().reason, 'NO_STANDING_APPROVAL'); assert.equal(c.texts.length, 0);
});

test('honesty: a booking that is not verified sends no text and says only that the request is recorded; a refused customer text is not claimed; an undelivered or unconfirmed text is reported, not assumed', async () => {
  const a = build({ book: () => ({ status: 'uncertain', reason: 'READBACK_MISMATCH', mismatches: ['visit_time'], writes: 2 }) }); a.h.serve(a.c.transport); await toOffer(a.c);
  await a.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await a.c.hears(/calling from/, 'yes'); await a.c.hears(/May we send you one automated/, 'yes'); await a.c.hears(/To confirm/, 'yes'); await finish(a.c);
  assert.equal(a.texts.length, 0); assert.equal(a.last().reason, 'BOOKING_NOT_VERIFIED'); assert.equal(a.last().booked, false); assert.equal(a.c.lines.at(-1), 'I could not confirm the booking. Your request is recorded. Goodbye.', 'the request was saved and read back, so "recorded" is true; no callback is promised');
  const b = build({ send: (to) => (to === CUSTOMER ? { ok: false, error: 'REFUSED', twilioCode: 21608 } : { ok: true, sid: `SM${'2'.repeat(32)}` }), delivery: 'unconfirmed' }); b.h.serve(b.c.transport); await toOffer(b.c);
  await b.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await b.c.hears(/calling from/, 'yes'); await b.c.hears(/May we send you one automated/, 'yes'); await b.c.hears(/To confirm/, 'yes');
  await b.c.drain(() => b.outcomes.some((o) => o.reason === 'TEXTS_VERIFIED'), 'delivery to be checked');
  assert.doesNotMatch(b.c.lines.at(-1)!, /on its way/); assert.match(b.c.lines.at(-1)!, /could not send the text/);
  assert.deepEqual([b.last().customerText, b.last().ownerText], ['not_sent', 'unconfirmed']);
});

test('turn-taking: silence is reprompted once and then ends the call; a line the carrier says failed is spoken again once; a caller who hangs up ends it without a booking; speaker failure ends it', async () => {
  const s = build({ answerWaitMs: 60 }); s.h.serve(s.c.transport); s.c.setup(DREW);
  await s.c.hears(/Sorry, I did not catch that\. What is your first and last name/, undefined);
  await s.c.drain(() => s.c.ended > 0 && s.c.closed > 0); assert.equal(s.last().reason, 'NO_ANSWER'); assert.match(s.c.lines.at(-1)!, /not hearing a reply/);
  const f = build(); f.h.serve(f.c.transport); f.c.setup(DREW, undefined, 'Testa Invented');
  await f.c.hears(/Is that right\? Say yes or no/, 'yes'); await f.c.hears(/street address/, undefined); f.c.emit({ kind: 'reply_failed' });
  await f.c.hears(/^What is the street address, with the city and ZIP code\?$/, '123 Invented Lane, Testville, CA 90210'); await f.c.hears(/What day and time/, undefined);
  const h = build(); h.h.serve(h.c.transport); h.c.setup(DREW, undefined, 'Testa Invented'); await h.c.hears(/Is that right\? Say yes or no/, 'yes'); await h.c.hears(/street address/, undefined); h.c.hangUp();
  assert.equal(h.last().reason, 'CALLER_HUNG_UP'); assert.equal(h.booked.length, 0); assert.equal(h.h.active(), 0);
  const d = build(); d.h.serve(d.c.transport); d.c.setup(DREW, undefined, 'Testa Invented'); await d.c.hears(/Is that right\? Say yes or no/, 'yes'); await d.c.hears(/street address/, undefined); d.c.emit({ kind: 'speaker_down' }); await d.c.drain(() => d.c.ended > 0); assert.equal(d.last().reason, 'SPEAKER_DOWN');
});

test('the line limits: a carrier that cannot measure playback is refused; one call at a time; the call cap', async () => {
  const t = build(); const bad = fakeCarrier({ measures: false }); t.h.serve(bad.transport); assert.equal(bad.closed, 1); assert.equal(t.c.lines.length, 0);
  t.h.serve(t.c.transport); const second = fakeCarrier(); t.h.serve(second.transport); assert.equal(second.closed, 1, 'a second call at once is refused');
  const cap = build({ maxCalls: 1 }); const one = fakeCarrier(); cap.h.serve(one.transport); one.hangUp(); const two = fakeCarrier(); cap.h.serve(two.transport); assert.equal(two.closed, 1, 'past the cap');
});

test('privacy: a whole call writes no name, address, number, caller word or text to any diagnostic; the outcome holds fixed codes only', async () => {
  const t = build(); t.h.serve(t.c.transport); await toOffer(t.c);
  await t.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await t.c.hears(/calling from/, 'yes'); await t.c.hears(/May we send you one automated/, 'yes'); await t.c.hears(/To confirm/, 'yes'); await finish(t.c);
  await t.c.drain(() => t.outcomes.some((o) => o.reason === 'TEXTS_VERIFIED'));
  noPersonalDetail(t.logs, ['Lane', 'Tue Nov', 'booked for']);
  assert.ok(t.last().steps.every((s) => /^[A-Z_]+$/.test(s)), 'steps are fixed codes'); assert.ok(!JSON.stringify(t.outcomes).includes('Testa'));
});

const CONSENT_LINE = "This is Donceletta Bellamy's developer test using the fictional Drew Cleaning business. May we send you one automated booking-details text per completed test booking? Message and data rates may apply. Reply STOP to unsubscribe or HELP for help. Texting is optional. Our privacy policy and SMS terms are available on our developer test website and will be provided before you consent. Do you agree?";
async function through(t: ReturnType<typeof build>, consentAnswer: string): Promise<string> {
  t.h.serve(t.c.transport); await toOffer(t.c);
  await t.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await t.c.hears(/calling from/, 'yes'); const line = await t.c.hears(/May we send you one automated/, consentAnswer); await t.c.hears(/To confirm/, 'yes'); await finish(t.c); return line;
}

test('SUBMITTED consent script: the caller is asked, word for word, as one measured unit; a yes is recorded as minimal evidence and a no is recorded too', async () => {
  const y = build(); assert.equal(await through(y, 'yes'), CONSENT_LINE);
  assert.deepEqual(y.consents.map((c) => [c.result, c.script]), [['yes', 'fast-consent-v1-customer']]); assert.equal(y.texts.length, 2);
  assert.ok(!JSON.stringify(y.consents).match(/555|Testa|Invented|Lane/), 'the evidence holds no number, name or address');
  const n = build(); await through(n, 'no'); assert.deepEqual(n.consents.map((c) => c.result), ['no']);
  assert.deepEqual(n.texts.map((x) => x.to), [OWNER], 'no customer text after a no; the booking is not conditional on it'); assert.equal(n.booked.length, 1);
  // an early yes during the long line is held, like every unit, and the line is asked again after the approved instruction
  const e = build(); e.h.serve(e.c.transport); await toOffer(e.c); await e.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await e.c.hears(/calling from/, 'yes');
  await e.c.hears(/May we send you one automated/, 'yes', { early: true }); assert.equal(e.consents.length, 0, 'a yes before the line finished is not consent');
  assert.match(await e.c.hears(/Please wait until I have finished, then answer\. This is Donceletta/, 'yes'), /Do you agree\?$/); assert.deepEqual(e.consents.map((c) => c.result), ['yes']);
});

test('consent is required per recipient: no recorded caller yes means no customer text; no recorded owner setup consent means no owner text; each is reported as not sent', async () => {
  const a = build({ consentOk: false }); await through(a, 'yes');
  assert.deepEqual(a.texts.map((x) => x.to), [OWNER], 'a yes that could not be recorded sends no customer text'); assert.ok(a.logs.some(([c]) => c === 'FAST_CONSENT_NOT_RECORDED'));
  assert.doesNotMatch(a.c.lines.at(-1)!, /on its way/); assert.match(a.c.lines.at(-1)!, /could not send the text/);
  const b = build({ ownerConsent: false }); await through(b, 'yes');
  assert.deepEqual(b.texts.map((x) => x.to), [CUSTOMER], 'without the owner setup consent the owner is never texted'); assert.equal(b.last().ownerText, 'not_sent'); assert.equal(b.booked.length, 1);
  const c = build({ ownerConsent: false, consentOk: false }); await through(c, 'yes'); assert.equal(c.texts.length, 0); assert.equal(c.booked.length, 1);
  const f = (x: ReturnType<typeof build>) => x.logs.filter(([code]) => code === 'FAST_TEXTS_SENT').map(([, d]) => d); assert.deepEqual(f(b), [{ customer: 'accepted', owner: 'not_sent' }]);
});

test('a text longer than the limit is never cut or sent; the booking stands and the call says honestly that no text was sent', async () => {
  const t = build({ settings: { businessName: `Drew Cleaning ${'Z'.repeat(260)}` } }); await through(t, 'yes');
  assert.equal(t.texts.length, 0); assert.equal(t.booked.length, 1); assert.match(t.c.lines.at(-1)!, /could not send the text/);
});

test('TEXTS OFF: no text question is asked, no consent is recorded, nothing is sent, the booking is unchanged, and both texts are reported as skipped (never delivered) while the goodbye says so', async () => {
  const t = build({ textsEnabled: false, ownerConsent: false }); t.h.serve(t.c.transport); await toOffer(t.c);
  await t.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await t.c.hears(/calling from/, 'yes');
  assert.match(await t.c.hears(/To confirm/, 'yes'), /^To confirm: Standard cleaning for Testa/, 'the read-back follows the callback number directly'); await finish(t.c);
  assert.equal(t.booked.length, 1); assert.equal(t.texts.length, 0); assert.equal(t.consents.length, 0);
  assert.equal(t.c.lines.at(-1), 'You are booked for Tuesday, November third, 2026 at 10 A M. Goodbye.');
  assert.ok(!t.c.lines.some((l) => /May we send you|automated booking-details|on its way/.test(l)));
  assert.deepEqual([t.last().reason, t.last().booked, t.last().customerText, t.last().ownerText], ['BOOKED', true, 'skipped', 'skipped']);
  assert.ok(t.logs.some(([c]) => c === 'FAST_TEXTS_SKIPPED') && !t.logs.some(([c]) => /TEXTS_SENT|TEXTS_VERIFIED/.test(c)));
  // a different number still goes through its own confirmation, then straight to the read-back
  const n = build({ textsEnabled: false }); n.h.serve(n.c.transport); await toOffer(n.c); await n.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await n.c.hears(/calling from/, 'no');
  await n.c.hears(/best number/, 'five five five zero one zero zero zero zero two'); await n.c.hears(/I heard/, 'yes'); await n.c.hears(/To confirm/, 'yes'); await finish(n.c);
  assert.equal(n.booked.length, 1); assert.equal(n.texts.length, 0); assert.equal(n.last().customerText, 'skipped');
});

test('settle wait: an address said in pieces is not asked for again while the caller is still speaking; the missing part is asked only after they stop and the quiet wait has passed', async () => {
  const t = build({ settleMs: 80 }); t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented');
  await t.c.hears(/Is that right\? Say yes or no/, 'yes'); await t.c.hears(/street address/, '123 Invented Lane');   // street only: the city and ZIP are still to come
  t.c.emit({ kind: 'speech', active: true });               // the caller starts the next piece before the quiet wait is over
  await new Promise((r) => setTimeout(r, 250));              // more than three times the wait: it would have asked by now
  assert.equal(t.c.lines.filter((l) => /^What is the city\?$|^And the ZIP code\?$/.test(l)).length, 0, 'nothing is asked while the caller speaks');
  t.c.emit({ kind: 'speech', active: false });
  await t.c.hears(/What is the city/, 'Testville');
  assert.equal(t.c.lines.filter((l) => /^What is the city\?$/.test(l)).length, 1);
});

test('settle wait: more speech that arrives as an answer cancels the pending question, so the part the caller just said is never asked for', async () => {
  const t = build({ settleMs: 80 }); t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented');
  await t.c.hears(/Is that right\? Say yes or no/, 'yes'); await t.c.hears(/street address/, '123 Invented Lane');
  t.c.emit({ kind: 'speech', active: true }); t.c.emit({ kind: 'speech', active: false });
  t.c.emit({ kind: 'utterance', text: 'Testville, CA 90210' });   // the rest arrives inside the wait
  await t.c.hears(/What day and time/, 'Tuesday');
  assert.equal(t.c.lines.filter((l) => /^What is the city\?$|^And the ZIP code\?$/.test(l)).length, 0, 'the city and ZIP were said, so they are not asked');
});

test('settle wait: the default quiet wait is longer than 1.2 seconds, so a pause between the street and the city is not mistaken for the end of the answer', async () => {
  const t = build({ settleMs: null }); t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented');
  await t.c.hears(/Is that right\? Say yes or no/, 'yes'); await t.c.hears(/street address/, '123 Invented Lane');
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(t.c.lines.filter((l) => /^What is the city\?$|^And the ZIP code\?$/.test(l)).length, 0, 'nothing was asked 1.6 seconds after the street');
  await t.c.hears(/What is the city/, 'Testville');
});

test('dates: one already passed, or beyond the days the calendar is read for, is never taken as asked; the caller is told why and asked again, and nothing is offered or booked from it', async () => {
  const t = build(); t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented');
  await t.c.hears(/Is that right\? Say yes or no/, 'yes'); await t.c.hears(/street address/, '123 Invented Lane, Testville, CA 90210');
  await t.c.hears(/What day and time/, 'October fourth at ten');
  await t.c.hears(/^That date has already passed\. Which day would you like\?$/, 'December fifteenth at ten');
  await t.c.hears(/^Sorry, I can only book within the next two weeks, up to Monday, November sixteenth\. Which day would you like\?$/, 'Tuesday at ten');
  await t.c.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  const offer = await t.c.hears(/is one hundred ninety-nine dollars/, 'no');
  assert.match(offer, /We have Tuesday, November third, 2026 at 10 A M\. Does that work\?$/, 'the year is spoken with the day and the time');
  assert.equal(t.booked.length, 0);
});

test('dates: after three dates that cannot be used the call ends with a person to follow up, and nothing is booked', async () => {
  const t = build(); t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented');
  await t.c.hears(/Is that right\? Say yes or no/, 'yes'); await t.c.hears(/street address/, '123 Invented Lane, Testville, CA 90210');
  await t.c.hears(/What day and time/, 'October fourth');
  await t.c.hears(/already passed/, 'October fifth');
  await t.c.hears(/already passed/, 'October sixth');
  await finish(t.c); assert.equal(t.last().reason, 'WHEN_UNCLEAR'); assert.equal(t.booked.length, 0);
});

test('availability is read again right before the write: a time that was taken in between, or a calendar that cannot be read now, ends the call with nothing booked', async () => {
  const taken = build({ busyLater: { busy: [{ start: instantOf('2026-11-03', '09:00', TZ), end: instantOf('2026-11-03', '17:00', TZ) }], complete: true } });
  taken.h.serve(taken.c.transport); await toOffer(taken.c);
  await taken.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await taken.c.hears(/calling from/, 'yes'); await taken.c.hears(/May we send you one automated/, 'yes'); await taken.c.hears(/To confirm/, 'yes');
  await finish(taken.c);
  assert.equal(taken.booked.length, 0, 'no write was sent'); assert.equal(taken.last().reason, 'NO_LONGER_AVAILABLE'); assert.match(taken.c.lines.at(-1)!, /no longer available/);
  assert.ok(taken.logs.some(([c]) => c === 'FAST_SLOT_RECHECK_FAILED'));
  const unreadable = build({ busyLater: { busy: [], complete: false } });
  unreadable.h.serve(unreadable.c.transport); await toOffer(unreadable.c);
  await unreadable.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await unreadable.c.hears(/calling from/, 'yes'); await unreadable.c.hears(/May we send you one automated/, 'yes'); await unreadable.c.hears(/To confirm/, 'yes');
  await finish(unreadable.c);
  assert.equal(unreadable.booked.length, 0); assert.equal(unreadable.last().reason, 'CALENDAR_UNREADABLE');
});

/** A whole call to a verified booking with texts OFF (no text question): the usual answers. */
async function toBooked(t: ReturnType<typeof build>): Promise<void> {
  t.h.serve(t.c.transport); await toOffer(t.c);
  await t.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await t.c.hears(/calling from a number ending in/, 'yes'); await t.c.hears(/To confirm/, 'yes'); await finish(t.c);
}
const MAIL_LINES = ['Name: Testa Invented', 'Service: Standard cleaning, 2 bedrooms / 2 bathrooms', 'When: Tuesday, November 3, 2026, 10:00 AM - 12:00 PM Central', 'Where: 123 Invented Lane, Testville, CA 90210', 'Price: $199', 'Booking reference: Jobber job #1001'];

test('test emails (on, texts off): after Jobber returns booked_verified, one fixed email goes to the customer role and one to the owner role with the verified details, the goodbye says so only because both were accepted, and the outcome records them', async () => {
  const t = build({ textsEnabled: false, emails: 'accept' }); await toBooked(t);
  assert.equal(t.booked.length, 1); assert.deepEqual(t.mails.map((m) => m.role).sort(), ['customer', 'owner']);
  for (const m of t.mails) for (const line of MAIL_LINES) assert.ok(m.text.split('\n').includes(line), `${m.role}: ${line}`);
  assert.equal(t.mails.find((m) => m.role === 'customer')!.subject, 'Drew Cleaning DEMO booking confirmed: Tuesday, November 3, 2026');
  assert.equal(t.c.lines.at(-1), 'You are booked for Tuesday, November third, 2026 at 10 A M. A confirmation email is on its way. Goodbye.');
  assert.deepEqual([t.last().reason, t.last().booked, t.last().customerEmail, t.last().ownerEmail, t.last().customerText], ['BOOKED', true, 'accepted', 'accepted', 'skipped']);
  assert.deepEqual(t.logs.find(([c]) => c === 'FAST_EMAILS_SENT')?.[1], { customer: 'accepted', owner: 'accepted' });
  assert.equal(t.texts.length, 0, 'texts stay off'); noPersonalDetail(t.logs);
});

test('test emails (on, texts on): the goodbye names the text and the email, and the last outcome carries both email verdicts after delivery is checked', async () => {
  const t = build({ emails: 'accept' }); t.h.serve(t.c.transport); await toOffer(t.c);
  await t.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await t.c.hears(/calling from a number ending in/, 'yes'); await t.c.hears(/May we send you one automated/, 'yes'); await t.c.hears(/To confirm/, 'yes'); await finish(t.c);
  assert.equal(t.c.lines.at(-1), 'You are booked for Tuesday, November third, 2026 at 10 A M. A confirmation text is on its way. A confirmation email is on its way. Goodbye.');
  assert.deepEqual([t.last().reason, t.last().customerEmail, t.last().ownerEmail, t.last().customerText], ['TEXTS_VERIFIED', 'accepted', 'accepted', 'delivered']);
  assert.equal(t.mails.length, 2);
});

test('test emails: nothing is emailed unless the booking is verified (an unverified booking, a declined read-back, a taken time, a refused caller)', async () => {
  const unverified = build({ textsEnabled: false, emails: 'accept', book: () => ({ status: 'uncertain', reason: 'READBACK_MISMATCH', writes: 2 }) }); await toBooked(unverified);
  assert.equal(bookingMails(unverified).length, 0); assert.equal(unverified.last().reason, 'BOOKING_NOT_VERIFIED'); assert.equal(unverified.last().customerEmail, undefined);
  const declined = build({ textsEnabled: false, emails: 'accept' }); declined.h.serve(declined.c.transport); await toOffer(declined.c);
  await declined.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await declined.c.hears(/calling from a number ending in/, 'yes'); await declined.c.hears(/To confirm/, 'no'); await declined.c.hears(/Which part is wrong/, 'no'); await finish(declined.c);
  assert.equal(declined.mails.length, 0); assert.equal(declined.last().reason, 'DECLINED_AT_READBACK');
  const stranger = build({ textsEnabled: false, emails: 'accept', caller: STRANGER }); stranger.h.serve(stranger.c.transport); stranger.c.setup(DREW, undefined, 'Testa Invented'); await finish(stranger.c);
  assert.equal(stranger.mails.length, 0); assert.equal(stranger.booked.length, 0);
});

test('test emails: a refused or failing mail server changes nothing about the booking, and the caller is not told an email is coming', async () => {
  for (const mode of ['refuse', 'throw'] as const) {
    const t = build({ textsEnabled: false, emails: mode }); await toBooked(t);
    assert.equal(t.booked.length, 1); assert.equal(t.last().reason, 'BOOKED'); assert.equal(t.last().booked, true); assert.deepEqual([t.last().customerEmail, t.last().ownerEmail], ['refused', 'refused']);
    assert.equal(t.c.lines.at(-1), 'You are booked for Tuesday, November third, 2026 at 10 A M. Goodbye.', mode);
  }
});

test('test emails: off by default: no email is built or sent, the goodbye and the outcome are exactly as before, and no email field appears', async () => {
  const t = build({ textsEnabled: false }); await toBooked(t);
  assert.equal(t.mails.length, 0); assert.equal(t.c.lines.at(-1), 'You are booked for Tuesday, November third, 2026 at 10 A M. Goodbye.');
  assert.ok(!('customerEmail' in t.last()) && !('ownerEmail' in t.last())); assert.ok(!t.logs.some(([c]) => c === 'FAST_EMAILS_SENT'));
});

test('the price is spoken in words everywhere it is spoken: no dollar sign reaches the voice, while the texts and the Jobber amount keep 199', async () => {
  const t = build({ emails: 'accept' }); t.h.serve(t.c.transport); await toOffer(t.c);
  const offer = await t.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await t.c.hears(/calling from a number ending in/, 'yes'); await t.c.hears(/May we send you one automated/, 'yes'); const readback = await t.c.hears(/To confirm/, 'yes'); await finish(t.c);
  assert.match(offer, /bathrooms is one hundred ninety-nine dollars\. We have Tuesday, November third, 2026 at 10 A M\. Does that work\?$/); assert.match(readback, /The price is one hundred ninety-nine dollars\. Shall I book it\? Say yes or no\.$/);
  assert.ok(t.c.lines.every((l) => !l.includes('$')), 'no spoken line holds a dollar sign'); assert.ok(t.c.lines.every((l) => !/\b199\b/.test(l)), 'no spoken line holds the digits 199');
  assert.equal(t.booked.length, 1); assert.equal(t.booked[0].priceDollars, 199, 'the Jobber amount is unchanged');
  assert.ok(t.texts.every((x) => x.body.includes('$199')), 'the texts keep $199'); assert.ok(t.mails.every((m) => m.text.includes('Price: $199')), 'the emails keep $199');
});

test('callback number in the OWNER\'s email: the confirmed number (the verified caller ID, or the one the caller gave and confirmed) is in the owner email only; no log line holds it', async () => {
  const a = build({ textsEnabled: false, emails: 'accept' }); await toBooked(a);
  const ao = a.mails.find((m) => m.role === 'owner')!; const ac = a.mails.find((m) => m.role === 'customer')!;
  assert.ok(ao.text.split('\n').includes('Callback number: (555) 010-0002'), 'the caller ID the caller confirmed'); assert.ok(!/callback|5550100002|\(555\)/i.test(ac.text + ac.subject + ao.subject), 'not in the customer email or any subject');
  noPersonalDetail(a.logs);
  const b = build({ textsEnabled: false, emails: 'accept' }); b.h.serve(b.c.transport); await toOffer(b.c);
  await b.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await b.c.hears(/calling from a number ending in/, 'no'); await b.c.hears(/What is the best number/, 'five five five zero one');
  await b.c.hears(/remaining 5 digits/, 'zero zero zero nine nine'); await b.c.hears(/I heard/, 'yes'); await b.c.hears(/To confirm/, 'yes'); await finish(b.c);
  assert.ok(b.mails.find((m) => m.role === 'owner')!.text.split('\n').includes('Callback number: (555) 010-0099'), 'the number the caller gave and confirmed'); assert.ok(!b.mails.find((m) => m.role === 'customer')!.text.includes('010-0099'));
  noPersonalDetail(b.logs, ['5550100099', '0100099']);
});

test('duplicate guard: a verified duplicate (same job, every field matched) ends ALREADY_BOOKED with no text and no email to anyone, and a booking whose job was already emailed in this process is not emailed twice', async () => {
  const dup = build({ textsEnabled: true, emails: 'accept', book: () => ({ status: 'booked_verified', jobId: 'JOB-1', jobNumber: 1001, writes: 0, duplicate: true }) }); await toBookedWithTexts(dup);
  assert.equal(dup.mails.length, 0); assert.equal(dup.texts.length, 0); assert.ok(!dup.logs.some(([c]) => /^FAST_(EMAILS_SENT|TEXTS_SENT|TEXTS_VERIFIED)$/.test(c)));
  assert.equal(dup.c.lines.at(-1), 'That visit is already booked, so nothing new was sent. Goodbye.');
  assert.deepEqual([dup.last().reason, dup.last().booked, dup.last().customerText, dup.last().ownerText, dup.last().customerEmail, dup.last().ownerEmail], ['ALREADY_BOOKED', true, 'skipped', 'skipped', 'not_sent', 'not_sent']); assert.deepEqual(dup.logs.find(([c]) => c === 'FAST_BOOKING_DUPLICATE')?.[1], { status: 'booked_verified' });
  const t = build({ textsEnabled: false, emails: 'accept' }); await toBooked(t); assert.equal(t.mails.length, 2);
  const again = fakeCarrier(); t.h.serve(again.transport); again.setup(DREW, undefined, 'Testa Invented');   // the same booking again (the same verified job)
  await again.hears(/Is that right\? Say yes or no/, 'yes'); await again.hears(/street address/, '123 Invented Lane, Testville, CA 90210'); await again.hears(/What day and time/, 'Tuesday at ten'); await again.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  await again.hears(/is one hundred ninety-nine dollars/, 'yes'); await again.hears(/calling from a number ending in/, 'yes'); await again.hears(/To confirm/, 'yes'); await finish(again);
  assert.equal(t.mails.length, 2, 'the same booking is never emailed twice'); assert.deepEqual(t.logs.filter(([c]) => c === 'FAST_EMAILS_SKIPPED').map(([, d]) => d), [{ reason: 'ALREADY_SENT' }]); assert.equal(t.booked.length, 2);
});

// ================================================================ turn hold, fragment settle, goodbye
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('turn hold: a question is not spoken while the caller is speaking; it is spoken after they stop and a short grace, and only numbers are logged', async () => {
  const t = build({ holdGraceMs: 60, holdMaxMs: 800 }); t.h.serve(t.c.transport);
  t.c.emit({ kind: 'setup', to: DREW, callSid: `CA${'ab'.repeat(16)}` }); t.c.emit({ kind: 'speech', active: true }); t.c.emit({ kind: 'utterance', text: 'Testa Invented' });   // the caller is still talking when the next question is due
  await sleep(250); assert.equal(t.c.lines.filter((l) => /street address/.test(l)).length, 0, 'nothing is spoken on top of the caller');
  t.c.emit({ kind: 'speech', active: false }); await t.c.hears(/Is that right\? Say yes or no/, 'yes'); await t.c.hears(/street address/, '123 Invented Lane, Testville, CA 90210');
  const hold = t.logs.find(([c]) => c === 'FAST_HOLD')?.[1] as { waitedMs: number; ignored: number }; assert.ok(hold.waitedMs >= 100 && hold.waitedMs < 800, 'it waited, and not to the cap'); assert.equal(hold.ignored, 0);
  assert.deepEqual(Object.keys(hold).sort(), ['ignored', 'waitedMs']); noPersonalDetail(t.logs);
});

test('turn hold: a speech start that never stops cannot block the call: the question is spoken at the cap', async () => {
  const t = build({ holdGraceMs: 60, holdMaxMs: 150 }); t.h.serve(t.c.transport);
  t.c.emit({ kind: 'setup', to: DREW, callSid: `CA${'ab'.repeat(16)}` }); t.c.emit({ kind: 'speech', active: true }); t.c.emit({ kind: 'utterance', text: 'Testa Invented' });
  await t.c.hears(/Is that right\? Say yes or no/, 'yes'); await t.c.hears(/street address/, '123 Invented Lane, Testville, CA 90210');
  const hold = t.logs.find(([c]) => c === 'FAST_HOLD')?.[1] as { waitedMs: number }; assert.ok(hold.waitedMs >= 150 && hold.waitedMs <= 300, `waited ${hold.waitedMs}`);
});

test('turn hold: with the caller quiet nothing waits and nothing is logged; a whole call books as before', async () => {
  const t = build({ textsEnabled: false }); await toBooked(t);
  assert.ok(!t.logs.some(([c]) => c === 'FAST_HOLD')); assert.equal(t.booked.length, 1); assert.equal(t.last().reason, 'BOOKED');
});

test('turn hold: words said before a confirmation line was even spoken confirm nothing and are not a reason to replay it; the line is spoken once and the next yes counts', async () => {
  const t = build({ textsEnabled: false, holdGraceMs: 60, holdMaxMs: 800 }); t.h.serve(t.c.transport); await toOffer(t.c);
  await t.c.hears(/is one hundred ninety-nine dollars/, undefined);
  t.c.emit({ kind: 'speech', active: true }); t.c.emit({ kind: 'utterance', text: 'yes' });   // the answer to the offer, while the caller is still going on
  await sleep(60); assert.equal(t.c.lines.filter((l) => /calling from a number ending in/.test(l)).length, 0, 'the next question waits');
  t.c.emit({ kind: 'utterance', text: 'yes that is right' }); await sleep(30); t.c.emit({ kind: 'speech', active: false });   // the rest of what the caller was saying
  await t.c.hears(/calling from a number ending in/, 'yes'); await t.c.hears(/To confirm/, 'yes'); await finish(t.c);
  assert.equal(t.c.lines.filter((l) => /calling from a number ending in/.test(l)).length, 1, 'asked once');
  assert.ok(!t.logs.some(([c]) => c === 'CONFIRM_REPLAY' || c === 'CONFIRM_HELD'), 'no replay, no held yes');
  assert.equal((t.logs.find(([c]) => c === 'FAST_HOLD')?.[1] as { ignored: number }).ignored, 1); assert.equal(t.booked.length, 1);
});

test('fragment settle (day): an answer with nothing usable, or a time without a day, waits for the rest; no follow-up is asked if it arrives, and one is asked if it does not', async () => {
  const a = build({ settleMs: 80 }); a.h.serve(a.c.transport); a.c.setup(DREW, undefined, 'Testa Invented');
  await a.c.hears(/Is that right\? Say yes or no/, 'yes'); await a.c.hears(/street address/, '123 Invented Lane, Testville, CA 90210'); await a.c.hears(/What day and time/, 'um'); await sleep(30); a.c.emit({ kind: 'utterance', text: 'tomorrow at ten' });
  await a.c.hears(/bedrooms and bathrooms/, undefined); assert.equal(a.c.lines.filter((l) => /Sorry, which day|^Which day\?$/.test(l)).length, 0, 'the rest arrived in time: nothing was asked');
  const b = build({ settleMs: 80 }); b.h.serve(b.c.transport); b.c.setup(DREW, undefined, 'Testa Invented');
  await b.c.hears(/Is that right\? Say yes or no/, 'yes'); await b.c.hears(/street address/, '123 Invented Lane, Testville, CA 90210'); await b.c.hears(/What day and time/, 'at ten'); await sleep(30); b.c.emit({ kind: 'utterance', text: 'tomorrow' });
  await b.c.hears(/bedrooms and bathrooms/, undefined); assert.equal(b.c.lines.filter((l) => /^Which day\?$/.test(l)).length, 0, 'a time, then the day: no "Which day?"');
  const c = build({ settleMs: 80 }); c.h.serve(c.c.transport); c.c.setup(DREW, undefined, 'Testa Invented');
  await c.c.hears(/Is that right\? Say yes or no/, 'yes'); await c.c.hears(/street address/, '123 Invented Lane, Testville, CA 90210'); await c.c.hears(/What day and time/, 'um'); await c.c.hears(/^Sorry, which day would you like\?$/, 'um'); await c.c.hears(/^Sorry, which day would you like\?$/, 'um'); await finish(c.c);
  assert.equal(c.last().reason, 'WHEN_UNCLEAR'); assert.equal(c.c.lines.filter((l) => /^Sorry, which day would you like\?$/.test(l)).length, 2, 'asked after the wait each time, and the three tries still end the call');
});

test('fragment settle (size): "two bedrooms" and then "two bathrooms" in two pieces asks nothing in between; three unusable answers still end the call', async () => {
  const a = build({ settleMs: 80 }); a.h.serve(a.c.transport); a.c.setup(DREW, undefined, 'Testa Invented');
  await a.c.hears(/Is that right\? Say yes or no/, 'yes'); await a.c.hears(/street address/, '123 Invented Lane, Testville, CA 90210'); await a.c.hears(/What day and time/, 'tomorrow at ten'); await a.c.hears(/bedrooms and bathrooms/, 'two bedrooms'); await sleep(30); a.c.emit({ kind: 'utterance', text: 'two bathrooms' });
  await a.c.hears(/is one hundred ninety-nine dollars/, undefined); assert.equal(a.c.lines.filter((l) => /^And how many|^Sorry, how many/.test(l)).length, 0);
  const b = build({ settleMs: 80 }); b.h.serve(b.c.transport); b.c.setup(DREW, undefined, 'Testa Invented');
  await b.c.hears(/Is that right\? Say yes or no/, 'yes'); await b.c.hears(/street address/, '123 Invented Lane, Testville, CA 90210'); await b.c.hears(/What day and time/, 'tomorrow at ten'); await b.c.hears(/bedrooms and bathrooms/, 'um'); await b.c.hears(/^Sorry, how many bedrooms and bathrooms\?$/, 'um'); await b.c.hears(/^Sorry, how many bedrooms and bathrooms\?$/, 'um'); await finish(b.c);
  assert.equal(b.last().reason, 'SIZE_UNCLEAR');
  const c = build({ settleMs: 80 }); c.h.serve(c.c.transport); c.c.setup(DREW, undefined, 'Testa Invented');
  await c.c.hears(/Is that right\? Say yes or no/, 'yes'); await c.c.hears(/street address/, '123 Invented Lane, Testville, CA 90210'); await c.c.hears(/What day and time/, 'tomorrow at ten'); await c.c.hears(/bedrooms and bathrooms/, 'two bedrooms'); await c.c.hears(/^And how many bathrooms\?$/, 'two');
  await c.c.hears(/is one hundred ninety-nine dollars/, undefined);
});

test('the goodbye: with texts off it says only the booking and "Goodbye", with no sentence about text messages; texts on and emails on keep their own lines', async () => {
  const t = build({ textsEnabled: false }); await toBooked(t);
  assert.equal(t.c.lines.at(-1), 'You are booked for Tuesday, November third, 2026 at 10 A M. Goodbye.'); assert.ok(!t.c.lines.some((l) => /does not send text messages/.test(l)));
  const e = build({ textsEnabled: false, emails: 'accept' }); await toBooked(e); assert.equal(e.c.lines.at(-1), 'You are booked for Tuesday, November third, 2026 at 10 A M. A confirmation email is on its way. Goodbye.');
});

test('turn hold: after the caller stops, the question still waits out the grace before it is spoken', async () => {
  const t = build({ holdGraceMs: 300, holdMaxMs: 2000 }); t.h.serve(t.c.transport);
  t.c.emit({ kind: 'setup', to: DREW, callSid: `CA${'ab'.repeat(16)}` }); t.c.emit({ kind: 'speech', active: true }); t.c.emit({ kind: 'utterance', text: 'Testa Invented' });
  await sleep(100); t.c.emit({ kind: 'speech', active: false }); await sleep(120);
  assert.equal(t.c.lines.filter((l) => /street address/.test(l)).length, 0, 'still inside the grace: nothing is spoken'); await t.c.hears(/Is that right\? Say yes or no/, 'yes'); await t.c.hears(/street address/, '123 Invented Lane, Testville, CA 90210');
});

test('full-name read-back: the read-back says the first AND last name exactly as heard (a name given in two steps too); a wrong name gets a no, and then nothing is booked, texted or emailed', async () => {
  const a = build({ textsEnabled: false, emails: 'accept' }); a.h.serve(a.c.transport); a.c.setup(DREW, undefined, 'Testa'); await a.c.hears(/last name/, 'Invented');
  await a.c.hears(/Is that right\? Say yes or no/, 'yes'); await a.c.hears(/street address/, '123 Invented Lane, Testville, CA 90210'); await a.c.hears(/What day and time/, 'Tuesday at ten'); await a.c.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  await a.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await a.c.hears(/calling from a number ending in/, 'yes');
  assert.match(await a.c.hears(/To confirm/, 'yes'), /^To confirm: Standard cleaning for Testa Invented on Tuesday, November third, 2026 at 10 A M, at 123 Invented Lane, house number 1 2 3, street spelled I N V E N T E D, L A N E, Testville, California, 9 0 2 1 0\. The price is one hundred ninety-nine dollars\. Shall I book it\? Say yes or no\.$/, 'a name said in two steps is read back in full'); await finish(a.c);
  assert.deepEqual([a.booked[0].client.firstName, a.booked[0].client.lastName], ['Testa', 'Invented']);
  // what the recognizer returned is spoken back as it came, so the caller can catch a mishearing; a no books nothing
  const b = build({ textsEnabled: false, emails: 'accept' }); b.h.serve(b.c.transport); b.c.setup(DREW, undefined, 'Done Bill');   // a misheard name, as the transcript gave it
  await b.c.hears(/Is that right\? Say yes or no/, 'yes'); await b.c.hears(/street address/, '123 Invented Lane, Testville, CA 90210'); await b.c.hears(/What day and time/, 'Tuesday at ten'); await b.c.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  await b.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await b.c.hears(/calling from a number ending in/, 'yes');
  assert.match(await b.c.hears(/To confirm/, 'no'), /for Done Bill on /, 'the heard name is spoken back in full, unchanged'); await b.c.hears(/Which part is wrong/, 'no'); await finish(b.c);
  assert.equal(b.last().reason, 'DECLINED_AT_READBACK'); assert.equal(b.booked.length, 0, 'nothing was written to Jobber'); assert.equal(b.mails.length, 0); assert.equal(b.texts.length, 0); assert.match(b.c.lines.at(-1)!, /Nothing was booked/);
  const c = build({ textsEnabled: false, emails: 'accept' }); await toBooked(c); assert.deepEqual([c.booked[0].client.firstName, c.booked[0].client.lastName], ['Testa', 'Invented']);
  noPersonalDetail(b.logs, ['Done', 'Bill']);
});

test('interruption: every question that is not a confirmation unit, and the info lines, are spoken non-interruptible; OFFER, CALLBACK, texts consent and READBACK (and their replays) stay interruptible; the call still books as before', async () => {
  const t = build({ textsEnabled: false, emails: 'accept' }); await toBooked(t);
  assert.equal(t.booked.length, 1, 'booking behaviour is unchanged');
  const rows = t.c.lines.map((l, i) => ({ l, i, flag: t.c.speakOpts[i]?.interruptible }));
  const units = rows.filter((r) => /^(A standard cleaning|I see you are calling|To confirm|Please wait until)/.test(r.l));
  const short = rows.filter((r) => /street address|What day and time|bedrooms and bathrooms|^One moment|^Booking that now/.test(r.l));
  assert.ok(units.length >= 3 && short.length >= 5, 'the lines were found: ' + units.length + ' units, ' + short.length + ' short lines');
  for (const r of units) assert.notEqual(r.flag, false, 'a confirmation unit stays interruptible: ' + r.l.slice(0, 30));
  for (const r of short) assert.equal(r.flag, false, 'a short line cannot be cleared by the caller: ' + r.l.slice(0, 30));
  // the questions that ask only for what is missing are short lines too
  const p = build(); p.h.serve(p.c.transport); p.c.setup(DREW, undefined, 'Testa Invented');
  await p.c.hears(/Is that right\? Say yes or no/, 'yes'); await p.c.hears(/street address/, '123 Invented Lane'); await p.c.hears(/What is the city/, 'Testville'); await p.c.hears(/^And the ZIP code/, 'CA 90210'); await p.c.hears(/What day and time/, undefined);
  for (const re of [/street address/, /^What is the city/, /^And the ZIP code/, /What day and time/]) { const i = p.c.lines.findIndex((l) => re.test(l)); assert.equal(p.c.speakOpts[i]?.interruptible, false, String(re)); }
  // an answer given before the question finished is still taken, and nothing is asked twice
  const e = build(); e.h.serve(e.c.transport); e.c.setup(DREW, undefined, 'Testa Invented');
  await e.c.hears(/Is that right\? Say yes or no/, 'yes'); await e.c.hears(/street address/, '123 Invented Lane, Testville, CA 90210');
  await e.c.hears(/What day and time/, 'Tuesday at ten', { early: true });
  await e.c.until(() => e.c.lines.some((l) => /bedrooms and bathrooms/.test(l)), 'the size question');
  assert.equal(e.c.lines.filter((l) => /What day and time/.test(l)).length, 1); assert.equal(e.c.lines.filter((l) => /bedrooms and bathrooms/.test(l)).length, 1);
});

test('FAST_ADDRESS: one line per address answer with the outcome, reason, four flat booleans for street, city, ZIP and state, and counts; every field survives the log sink, no address text or digit is logged, and the questions asked are unchanged', async () => {
  const sizes = (s: string) => ({ digitRuns: (s.match(/\d+/g) ?? []).length, words: s.trim().split(/\s+/).length, chars: s.trim().length });
  const t = build();
  t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented');
  await t.c.hears(/Is that right\? Say yes or no/, 'yes'); await t.c.hears(/street address/, '123 Invented Lane');
  await t.c.hears(/What is the city/, 'Testville');
  await t.c.hears(/^And the ZIP code/, 'CA 90210');
  await t.c.hears(/What day and time/, undefined);
  const lines = t.logs.filter(([k]) => k === 'FAST_ADDRESS').map(([, v]) => v as Record<string, unknown>);
  assert.deepEqual(lines, [
    { outcome: 'partial', reason: 'NEED_CITY', street: true, city: false, zip: false, state: false, zipDigits: 0, ...sizes('123 Invented Lane') },
    { outcome: 'partial', reason: 'NEED_ZIP', street: true, city: true, zip: false, state: false, zipDigits: 0, digitRuns: 0, words: 1, chars: 9 },
    { outcome: 'captured', reason: 'JOINED', street: true, city: true, zip: true, state: true, zipDigits: 5, ...sizes('CA 90210') },
  ]);
  // a ZIP followed by extra words is dropped by the parser (unchanged behaviour); the line says so without saying what was heard
  const said = '123 Invented Lane, Testville, CA 90210, that is it';
  const u = build(); u.h.serve(u.c.transport); u.c.setup(DREW, undefined, 'Testa Invented');
  await u.c.hears(/Is that right\? Say yes or no/, 'yes'); await u.c.hears(/street address/, said);
  await u.c.hears(/What is the city/, undefined);
  assert.deepEqual(u.logs.filter(([k]) => k === 'FAST_ADDRESS').map(([, v]) => v), [{ outcome: 'partial', reason: 'NEED_CITY', street: true, city: false, zip: false, state: false, zipDigits: 0, ...sizes(said) }]);
  // every field is a flat boolean, number or short token, so the real log sink keeps all of them (it drops anything else)
  for (const l of [...t.logs, ...u.logs]) if (l[0] === 'FAST_ADDRESS') assert.deepEqual(cleanDetail(l[1]), l[1], 'the sink keeps every field');
  // the whole call: the address, its parts and its digits appear in no log line at all
  noPersonalDetail(t.logs, ['Lane', '123', 'Invented Lane']); noPersonalDetail(u.logs, ['Lane', '123', 'Invented Lane']);
});

test('FAST_SIZE: one line per size answer says what the parser found (booleans and counts only); three unreadable answers still end the call as before; the words said are never logged', async () => {
  const flat = (logs: Array<[string, unknown]>) => logs.filter(([k]) => k === 'FAST_SIZE').map(([, v]) => v as Record<string, unknown>);
  // 1. nothing readable, then a lone number-less answer, then both: the retry wording and the count of tries are unchanged
  const t = build(); t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented');
  await t.c.hears(/Is that right\? Say yes or no/, 'yes'); await t.c.hears(/street address/, '123 Invented Lane, Testville, CA 90210'); await t.c.hears(/What day and time/, 'Tuesday at ten');
  await t.c.hears(/bedrooms and bathrooms/, 'banana smoothie please');
  await t.c.hears(/^Sorry, how many bedrooms and bathrooms\?$/, 'two bedrooms');
  await t.c.hears(/^And how many bathrooms/, 'two');
  await t.c.hears(/is one hundred ninety-nine dollars/, undefined);
  assert.deepEqual(flat(t.logs), [
    { parsedBeds: false, parsedBaths: false, bareCount: false, hadBeds: false, hadBaths: false, haveBeds: false, haveBaths: false, numberTokens: 0, bedWord: false, bathWord: false, numberWords: 0, homophone: false, words: 3, chars: 22, tries: 0, verdict: 'NONE' },
    { parsedBeds: true, parsedBaths: false, bareCount: true, hadBeds: false, hadBaths: false, haveBeds: true, haveBaths: false, numberTokens: 1, bedWord: true, bathWord: false, numberWords: 1, homophone: false, words: 2, chars: 12, tries: 1, verdict: 'BEDS_ONLY' },
    { parsedBeds: false, parsedBaths: false, bareCount: true, hadBeds: true, hadBaths: false, haveBeds: true, haveBaths: true, numberTokens: 1, bedWord: false, bathWord: false, numberWords: 1, homophone: false, words: 1, chars: 3, tries: 1, verdict: 'BOTH' },   // tries is not reset by a partial answer (unchanged behaviour)
  ]);
  // 2. three answers with no size in them: the third ends the call exactly as before (SIZE_UNCLEAR), and the tries read 0, 1, 2
  const g = build(); g.h.serve(g.c.transport); g.c.setup(DREW, undefined, 'Testa Invented');
  await g.c.hears(/Is that right\? Say yes or no/, 'yes'); await g.c.hears(/street address/, '123 Invented Lane, Testville, CA 90210'); await g.c.hears(/What day and time/, 'Tuesday at ten');
  await g.c.hears(/bedrooms and bathrooms/, 'hmm');
  await g.c.hears(/^Sorry, how many bedrooms and bathrooms\?$/, 'okay then');
  await g.c.hears(/^Sorry, how many bedrooms and bathrooms\?$/, 'thank you');
  await finish(g.c);
  assert.equal(g.last().reason, 'SIZE_UNCLEAR'); assert.equal(g.booked.length, 0);
  assert.deepEqual(flat(g.logs).map((l) => [l.tries, l.verdict]), [[0, 'NONE'], [1, 'NONE'], [2, 'NONE']]);
  // 3. every field is a flat boolean, number or short token, so the real log sink keeps all of them; nothing said is in any line
  for (const l of [...t.logs, ...g.logs]) if (l[0] === 'FAST_SIZE') assert.deepEqual(cleanDetail(l[1]), l[1], 'the sink keeps every field');
  noPersonalDetail(t.logs, ['banana', 'smoothie']); noPersonalDetail(g.logs, ['okay', 'thank you', 'hmm']);
});

// ---------------------------------------------------------------- the state: the caller's own, asked once when missing, never taken from the config

test('STATE said with the address: no question is asked; the read-back speaks its name; Jobber, the emails and the log use the caller\'s state, never the configured one', async () => {
  const t = build({ emails: 'accept', textsEnabled: false });   // the config's state is CA (SETTINGS); the caller says Texas
  t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented');
  await t.c.hears(/Is that right\? Say yes or no/, 'yes'); await t.c.hears(/street address/, '123 Invented Lane, Testville, Texas 90210');
  await t.c.hears(/What day and time/, 'Tuesday at ten');
  await t.c.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  await t.c.hears(/is one hundred ninety-nine dollars/, 'yes');
  await t.c.hears(/calling from a number ending in/, 'yes');
  const readback = await t.c.hears(/To confirm/, 'yes');
  assert.match(readback, /at 123 Invented Lane, house number 1 2 3, street spelled I N V E N T E D, L A N E, Testville, Texas, 9 0 2 1 0\. The price is/, 'the state is read back by its full name');
  await finish(t.c);
  assert.equal(t.c.lines.filter((l) => /What state/.test(l)).length, 0, 'a state already said is never asked for');
  assert.deepEqual(t.booked.map((r) => r.address), [{ street1: '123 Invented Lane', city: 'Testville', postalCode: '90210', province: 'TX' }], 'the Jobber address keeps its shape; the province is the caller\'s');
  assert.equal(t.mails.length, 2); for (const m of t.mails) { assert.match(m.text, /123 Invented Lane, Testville, TX 90210/); assert.ok(!/\bCA\b/.test(m.text), 'the configured state is not used'); }
  assert.deepEqual([t.last().reason, t.last().booked], ['BOOKED', true]);
  assert.ok(!t.logs.some(([c]) => c === 'FAST_STATE'), 'no state question, no state line');
  noPersonalDetail(t.logs, ['Texas', 'Invented Lane']);
});

test('STATE missing: asked ONCE ("What state is that in?"), kept, never asked again, and never taken from the config; the answer is read back by name and booked as said', async () => {
  const t = build({ emails: 'accept', textsEnabled: false });   // config state CA
  t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented');
  await t.c.hears(/Is that right\? Say yes or no/, 'yes'); await t.c.hears(/street address/, '123 Invented Lane, Testville, 90210');
  await t.c.hears(/^What state is that in\?$/, 'it is Florida');
  await t.c.hears(/What day and time/, 'Tuesday at ten');
  await t.c.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  await t.c.hears(/is one hundred ninety-nine dollars/, 'yes');
  await t.c.hears(/calling from a number ending in/, 'yes');
  assert.match(await t.c.hears(/To confirm/, 'yes'), /Testville, Florida, 9 0 2 1 0\./);
  await finish(t.c);
  assert.equal(t.c.lines.filter((l) => /What state/.test(l)).length, 1, 'asked once');
  assert.equal(t.booked.length, 1); assert.equal(t.booked[0].address.province, 'FL', 'the caller\'s state, not the configured CA');
  assert.ok(t.mails.every((m) => /Testville, FL 90210/.test(m.text) && !/\bCA\b/.test(m.text)));
  const asks = t.c.lines.filter((l) => /\?|Say yes or no/.test(l)); assert.equal(new Set(asks).size, asks.length, 'no question was asked twice');
  const st = t.logs.filter(([c]) => c === 'FAST_STATE').map(([, v]) => v);
  assert.deepEqual(st, [{ state: true, words: 3, chars: 13, tries: 0 }], 'a boolean and counts only');
  for (const [, v] of t.logs.filter(([c]) => c === 'FAST_STATE' || c === 'FAST_ADDRESS')) assert.deepEqual(cleanDetail(v), v, 'the log sink keeps every field');
  noPersonalDetail(t.logs, ['Florida', 'Invented Lane']);
});

test('STATE in pieces: a state said with the city, or before the ZIP, is kept and not asked for again; only what is missing is asked', async () => {
  const t = build(); t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented');
  await t.c.hears(/Is that right\? Say yes or no/, 'yes'); await t.c.hears(/street address/, '123 Invented Lane');
  await t.c.hears(/What is the city/, 'Testville, Texas');
  await t.c.hears(/^And the ZIP code/, '90210');
  await t.c.hears(/What day and time/, undefined);
  assert.equal(t.c.lines.filter((l) => /What state/.test(l)).length, 0);
  const rows = t.logs.filter(([c]) => c === 'FAST_ADDRESS').map(([, v]) => v as Record<string, unknown>);
  assert.deepEqual(rows.map((r) => [r.reason, r.state]), [['NEED_CITY', false], ['NEED_ZIP', true], ['JOINED', true]]);
});

test('no state, no booking: two answers that are not a state end the call with a person to follow up; no read-back, no booking, no email, and the question is not asked a third time', async () => {
  const t = build({ emails: 'accept' }); t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented');
  await t.c.hears(/Is that right\? Say yes or no/, 'yes'); await t.c.hears(/street address/, '123 Invented Lane, Testville, 90210');
  await t.c.hears(/^What state is that in\?$/, 'I do not know');
  await t.c.hears(/^Sorry, which state is that in\?$/, 'banana');
  await finish(t.c);
  assert.deepEqual([t.last().reason, t.last().booked], ['STATE_UNCLEAR', false]);
  assert.equal(t.c.lines.filter((l) => /state is that in/.test(l)).length, 2, 'asked, and once more only because the answer was not understood');
  assert.equal(t.c.lines.filter((l) => /To confirm|What day and time/.test(l)).length, 0, 'nothing after the address was asked or read back');
  assert.equal(t.booked.length, 0); assert.equal(bookingMails(t).length, 0); assert.equal(t.texts.length, 0);
  assert.equal(t.c.lines.at(-1), 'Sorry, I am having trouble with that. Your request is recorded. Goodbye.');
  assert.deepEqual(t.logs.filter(([c]) => c === 'FAST_STATE').map(([, v]) => (v as { state: boolean }).state), [false, false]);
  noPersonalDetail(t.logs, ['banana', 'Invented Lane']);
});

// ---------------------------------------------------------------- reliability batch after Live Test #6: lower-case state, number homophones, an address said in many pieces

test('lower-case state: "tx" before the ZIP is the state and nothing is asked; a bare "ny" answers the state question once; the booking carries the caller\'s state and nothing is asked twice', async () => {
  const a = build({ settleMs: 80 }); a.h.serve(a.c.transport); a.c.setup(DREW, undefined, 'Testa Invented');
  await a.c.hears(/Is that right\? Say yes or no/, 'yes'); await a.c.hears(/street address/, '123 Invented Lane, Testville, tx 90210'); await a.c.hears(/What day and time/, undefined);
  assert.equal(a.c.lines.filter((l) => /What state/.test(l)).length, 0);
  assert.deepEqual(a.logs.filter(([k]) => k === 'FAST_ADDRESS').map(([, v]) => [(v as Record<string, unknown>).outcome, (v as Record<string, unknown>).state, (v as Record<string, unknown>).zipDigits]), [['captured', true, 5]], 'the ZIP has five digits and the state is held');
  const b = build({ emails: 'accept', textsEnabled: false }); b.h.serve(b.c.transport); b.c.setup(DREW, undefined, 'Testa Invented');
  await b.c.hears(/Is that right\? Say yes or no/, 'yes'); await b.c.hears(/street address/, '123 Invented Lane, Testville 90210'); await b.c.hears(/^What state is that in\?$/, 'ny');
  await b.c.hears(/What day and time/, 'Tuesday at ten'); await b.c.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  await b.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await b.c.hears(/calling from a number ending in/, 'yes');
  assert.match(await b.c.hears(/To confirm/, 'yes'), /Testville, New York, 9 0 2 1 0\./); await finish(b.c);
  assert.equal(b.booked[0].address.province, 'NY'); assert.equal(b.c.lines.filter((l) => /What state/.test(l)).length, 1);
  const asks = b.c.lines.filter((l) => /\?|Say yes or no/.test(l)); assert.equal(new Set(asks).size, asks.length, 'no question was asked twice');
  // a lone word that is also a code is not a state: the question is asked again, and only then the booking can go on
  const c = build({ settleMs: 80 }); c.h.serve(c.c.transport); c.c.setup(DREW, undefined, 'Testa Invented');
  await c.c.hears(/Is that right\? Say yes or no/, 'yes'); await c.c.hears(/street address/, '123 Invented Lane, Testville 90210'); await c.c.hears(/^What state is that in\?$/, 'in'); await c.c.hears(/^Sorry, which state is that in\?$/, 'tx'); await c.c.hears(/What day and time/, undefined);
  assert.equal(c.c.lines.filter((l) => /state is that in/.test(l)).length, 2);
});

test('size: "to bathrooms" said as a second piece, a lone "too", and "to bedrooms and to bathrooms" are read (Live Test #6); "a couple" is never guessed; nothing already answered is asked again', async () => {
  const start = async (...pieces: string[]) => {
    const t = build({ settleMs: 80 }); t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented');
    await t.c.hears(/Is that right\? Say yes or no/, 'yes'); await t.c.hears(/street address/, '123 Invented Lane, Testville, CA 90210'); await t.c.hears(/What day and time/, 'tomorrow at ten'); await t.c.hears(/bedrooms and bathrooms/, pieces[0]);
    for (const p of pieces.slice(1)) { await sleep(30); t.c.emit({ kind: 'utterance', text: p }); }
    return t;
  };
  const asked = (t: ReturnType<typeof build>): number => t.c.lines.filter((l) => /^And how many|^Sorry, how many/.test(l)).length;
  for (const pieces of [['two bedrooms', 'to bathrooms'], ['two bedrooms', 'too'], ['two bedrooms', 'to baths'], ['to bedrooms and to bathrooms']]) {
    const t = await start(...pieces); await t.c.hears(/is one hundred ninety-nine dollars/, undefined);
    assert.equal(asked(t), 0, `${pieces.join(' + ')}: no size question was asked again`);
  }
  // never guessed: "a couple" has no number, so the question is asked again and the shape of the answer is logged without its words
  const d = await start('a couple of bedrooms'); await d.c.hears(/^Sorry, how many bedrooms and bathrooms\?$/, 'two bedrooms and two bathrooms'); await d.c.hears(/is one hundred ninety-nine dollars/, undefined);
  const rows = d.logs.filter(([k]) => k === 'FAST_SIZE').map(([, v]) => v as Record<string, unknown>);
  assert.deepEqual([rows[0].verdict, rows[0].bedWord, rows[0].bathWord, rows[0].numberWords, rows[0].homophone], ['NONE', true, false, 0, false]);
  for (const l of d.logs) if (l[0] === 'FAST_SIZE') assert.deepEqual(cleanDetail(l[1]), l[1], 'the sink keeps every field');
  noPersonalDetail(d.logs, ['couple', 'bedrooms']);
  // a homophone that is not next to a bedroom or bathroom word is still just a word: three of those in a row still end the call, nothing booked
  const e = build({ settleMs: 80 }); e.h.serve(e.c.transport); e.c.setup(DREW, undefined, 'Testa Invented');
  await e.c.hears(/Is that right\? Say yes or no/, 'yes'); await e.c.hears(/street address/, '123 Invented Lane, Testville, CA 90210'); await e.c.hears(/What day and time/, 'tomorrow at ten'); await e.c.hears(/bedrooms and bathrooms/, 'for sure'); await e.c.hears(/^Sorry, how many bedrooms and bathrooms\?$/, 'I need to think'); await e.c.hears(/^Sorry, how many bedrooms and bathrooms\?$/, 'to the left'); await finish(e.c);
  assert.equal(e.last().reason, 'SIZE_UNCLEAR'); assert.equal(e.booked.length, 0);
});

test('an address said in many pieces (Live Test #6: seven segments, two unusable): unusable pieces between pieces that add something do not end the call; nothing is asked while the caller keeps talking; four unusable in a row still end it', async () => {
  const a = build({ settleMs: 80 }); a.h.serve(a.c.transport); a.c.setup(DREW, undefined, 'Testa Invented');
  await a.c.hears(/Is that right\? Say yes or no/, 'yes'); await a.c.hears(/street address/, 'um');
  for (const piece of ['123', 'okay', 'Invented Lane', 'uh', 'hmm', 'Testville', 'um', 'tx 90210']) { await sleep(20); a.c.emit({ kind: 'utterance', text: piece }); }   // four unusable pieces in all, never four in a row
  await a.c.hears(/What day and time/, undefined);
  assert.equal(a.c.lines.filter((l) => /street address/.test(l)).length, 1);
  assert.equal(a.c.lines.filter((l) => /^What is the (?:city|street name|house number)|^And the ZIP code|^What state/.test(l)).length, 0, 'everything the caller said was kept, so nothing was asked for');
  const rows = a.logs.filter(([k]) => k === 'FAST_ADDRESS').map(([, v]) => v as Record<string, unknown>);
  assert.equal(rows.length, 9); assert.deepEqual([rows.at(-1)!.outcome, rows.at(-1)!.zipDigits, rows.at(-1)!.state], ['captured', 5, true]);
  for (const r of rows) assert.deepEqual(cleanDetail(r), r, 'the sink keeps every field'); noPersonalDetail(a.logs, ['Invented Lane', 'okay', 'hmm']);
  const b = build({ settleMs: 80 }); b.h.serve(b.c.transport); b.c.setup(DREW, undefined, 'Testa Invented');
  await b.c.hears(/Is that right\? Say yes or no/, 'yes'); await b.c.hears(/street address/, 'um'); for (const piece of ['uh', 'hmm', 'okay']) { await sleep(20); b.c.emit({ kind: 'utterance', text: piece }); }
  await finish(b.c); assert.equal(b.last().reason, 'ADDRESS_UNCLEAR'); assert.equal(b.booked.length, 0);
});

// ---------------------------------------------------------------- the name: confirmed on its own, corrected before anything is booked, spelled when saying it again is not enough (Live Test #6: "Don" was booked and emailed as "Done")

/** The rest of an ordinary call after the name is confirmed, up to the read-back; the caller's yes to the read-back is the last thing it does. */
async function afterName(t: ReturnType<typeof build>): Promise<string> {
  await t.c.hears(/street address/, '123 Invented Lane, Testville, CA 90210'); await t.c.hears(/What day and time/, 'Tuesday at ten'); await t.c.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  await t.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await t.c.hears(/calling from a number ending in/, 'yes'); return t.c.hears(/To confirm/, 'yes');
}

test('NAME: the name is confirmed on its own before the address is asked; a no lets the caller say it again, and the corrected name (Done becomes Don) is what the read-back, Jobber and both emails carry', async () => {
  const t = build({ emails: 'accept', textsEnabled: false, settleMs: 80 }); t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Done Bellamy');   // what the voice service wrote in Live Test #6
  assert.equal(await t.c.hears(/^I have Done, D O N E, Bellamy, B E L L A M Y\./, 'no'), 'I have Done, D O N E, Bellamy, B E L L A M Y. Is that right? Say yes or no.');
  assert.equal(t.c.lines.filter((l) => /street address/.test(l)).length, 0, 'nothing else is asked while the name is wrong');
  await t.c.hears(/^Sorry\. Please say your first and last name again\.$/, 'Don Bellamy');
  await t.c.hears(/^I have Don, D O N, Bellamy, B E L L A M Y\. Is that right\?/, 'yes');
  assert.match(await afterName(t), /for Don Bellamy on/, 'the read-back says the corrected name'); await finish(t.c);
  assert.deepEqual(t.booked.map((r) => r.client), [{ firstName: 'Don', lastName: 'Bellamy', phone: '5550100002' }]);
  assert.equal(t.mails.length, 2); for (const m of t.mails) { assert.match(m.text, /Don Bellamy/); assert.ok(!/\bDone\b/.test(m.text), 'the wrong name is nowhere in the email'); }
  assert.deepEqual(t.logs.filter(([c]) => c === 'FAST_NAME').map(([, v]) => v), [{ path: 'CONFIRM', answer: 'no', no: 0, spelled: true, letters: 11 }, { path: 'CONFIRM', answer: 'yes', no: 1, spelled: true, letters: 10 }], 'a token and a count: never the name');
  const asks = t.c.lines.filter((l) => /\?|Say yes or no/.test(l)); assert.equal(new Set(asks).size, asks.length, 'no question was asked twice');
  noPersonalDetail(t.logs, ['Done', 'Bellamy']);
});

test('NAME: a name said in one word asks only for the last name, and the whole name is then confirmed once; a yes goes straight on and nothing is asked twice', async () => {
  const t = build(); t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Don');
  await t.c.hears(/last name/, 'Bellamy'); await t.c.hears(/^I have Don, D O N, Bellamy, B E L L A M Y\. Is that right\? Say yes or no\.$/, 'yes'); await t.c.hears(/street address/, undefined);
  assert.equal(t.c.lines.filter((l) => /first and last name|^I have /.test(l)).length, 1, 'the name was confirmed once and never asked for again');
});

test('NAME spelling: after a second no the caller spells the first and then the last name, one letter at a time and in pieces; only letters are read, and the spelled name is confirmed and then booked exactly', async () => {
  const t = build({ emails: 'accept', textsEnabled: false, settleMs: 80 }); t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Done Bellamy');
  await t.c.hears(/^I have Done, D O N E, Bellamy, B E L L A M Y\./, 'no'); await t.c.hears(/^Sorry\. Please say your first and last name again\.$/, 'Dawn Bellamy');   // still wrong
  await t.c.hears(/^I have Dawn, D A W N, Bellamy, B E L L A M Y\./, 'no');
  await t.c.hears(/^Please spell your first name, one letter at a time\.$/, 'D O'); await sleep(30); t.c.emit({ kind: 'utterance', text: 'N' });   // in two pieces
  await t.c.hears(/^Please spell your last name, one letter at a time\.$/, 'B E double L'); await sleep(30); t.c.emit({ kind: 'utterance', text: 'A as in Alpha, M, Y' });
  await t.c.hears(/^I have Don, D O N, Bellamy, B E L L A M Y\. Is that right\?/, 'yes');
  assert.match(await afterName(t), /for Don Bellamy on/); await finish(t.c);
  assert.deepEqual(t.booked.map((r) => [r.client.firstName, r.client.lastName]), [['Don', 'Bellamy']]); assert.ok(t.mails.every((m) => /Don Bellamy/.test(m.text) && !/Dawn|Done/.test(m.text)));
  assert.equal(t.c.lines.filter((l) => /spell your (?:first|last) name/.test(l)).length, 2, 'each part was asked once: the pieces were joined, not re-asked');
  const rows = t.logs.filter(([c]) => c === 'FAST_NAME').map(([, v]) => v as Record<string, unknown>);
  for (const r of rows) assert.deepEqual(cleanDetail(r), r, 'the sink keeps every field');
  assert.deepEqual(rows.filter((r) => r.path === 'SPELL_FIRST').map((r) => [r.letters, r.held]), [[2, 0], [1, 2]], 'counts of letters only');
  noPersonalDetail(t.logs, ['Done', 'Dawn', 'Bellamy', 'Alpha']);
});

test('NAME failure: a third no, a spelling that gives nothing twice, or three unclear answers to the confirmation each end the call with a person to follow up; nothing is asked after it, booked or emailed', async () => {
  // a third no (after the name was said again and then spelled)
  const a = build({ emails: 'accept', settleMs: 80 }); a.h.serve(a.c.transport); a.c.setup(DREW, undefined, 'Done Bellamy');
  await a.c.hears(/^I have Done, D O N E, Bellamy, B E L L A M Y\./, 'no'); await a.c.hears(/^Sorry\. Please say your first and last name again\.$/, 'Dawn Bellamy'); await a.c.hears(/^I have Dawn, D A W N, Bellamy, B E L L A M Y\./, 'no');
  await a.c.hears(/^Please spell your first name/, 'D A W N'); await a.c.hears(/^Please spell your last name/, 'B E L L A M Y'); await a.c.hears(/^I have Dawn, D A W N, Bellamy, B E L L A M Y\./, 'no'); await finish(a.c);
  assert.deepEqual([a.last().reason, a.last().booked], ['NAME_NOT_CONFIRMED', false]); assert.equal(a.booked.length, 0); assert.equal(bookingMails(a).length, 0); assert.equal(a.texts.length, 0);
  assert.equal(a.c.lines.filter((l) => /street address|To confirm/.test(l)).length, 0, 'the address was never asked and nothing was read back');
  // a spelling that is not letters, twice: nothing is guessed
  const b = build({ settleMs: 80 }); b.h.serve(b.c.transport); b.c.setup(DREW, undefined, 'Done Bellamy');
  await b.c.hears(/^I have Done, D O N E, Bellamy, B E L L A M Y\./, 'no'); await b.c.hears(/^Sorry\. Please say your first and last name again\.$/, 'Dawn Bellamy'); await b.c.hears(/^I have Dawn, D A W N, Bellamy, B E L L A M Y\./, 'no');
  await b.c.hears(/^Please spell your first name/, 'banana'); await b.c.hears(/^Sorry, please spell your first name again/, 'dee oh en'); await finish(b.c);
  assert.deepEqual([b.last().reason, b.last().booked], ['NAME_UNCLEAR', false]); assert.equal(b.booked.length, 0); assert.equal(b.c.lines.filter((l) => /street address/.test(l)).length, 0);
  // three answers that are neither yes nor no
  const c = build({ settleMs: 80 }); c.h.serve(c.c.transport); c.c.setup(DREW, undefined, 'Done Bellamy');
  await c.c.hears(/^I have Done, D O N E, Bellamy, B E L L A M Y\./, 'maybe'); await c.c.hears(/^Please say yes or no\. I have Done, D O N E, Bellamy, B E L L A M Y/, 'maybe'); await c.c.hears(/^Please say yes or no\. I have Done, D O N E, Bellamy, B E L L A M Y/, 'maybe'); await finish(c.c);
  assert.deepEqual([c.last().reason, c.last().booked], ['UNCONFIRMED', false]); assert.equal(c.booked.length, 0); assert.equal(c.c.lines.filter((l) => /street address/.test(l)).length, 0);
  noPersonalDetail([...a.logs, ...b.logs, ...c.logs], ['Done', 'Dawn', 'Bellamy', 'banana']);
});

test('NAME: letters said one at a time are never kept as a name ("D O N" is not the names "D" and "O N"); the name is asked for again', async () => {
  const t = build(); t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'D O N B E L L A M Y');
  await t.c.hears(/^Sorry, what is your first and last name\?$/, 'Don Bellamy'); await t.c.hears(/^I have Don, D O N, Bellamy, B E L L A M Y\. Is that right\?/, 'yes'); await t.c.hears(/street address/, undefined);
  assert.equal(t.c.lines.filter((l) => /^I have /.test(l)).length, 1);
});

// ---------------------------------------------------------------- Live Test #7: the name spelled aloud, an alternate time said plainly, a time said in a second piece kept, decisions logged, and a booking that fails closed

test('name spelling: the confirmation says the name AND spells it letter by letter, so "Done" cannot pass for "Don" by ear; the letters are exactly the kept name and never reach a log', async () => {
  assert.equal(spellOut('Done'), 'D O N E'); assert.equal(spellOut('Bellamy'), 'B E L L A M Y'); assert.equal(spellOut("O'Brien"), 'O apostrophe B R I E N'); assert.equal(spellOut('Ann-Marie'), 'A N N dash M A R I E'); assert.equal(spellOut('De La Cruz'), 'D E, L A, C R U Z'); assert.equal(spellOut('José'), 'J O S É');
  const t = build(); t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Done Bellamy');   // what the voice service wrote in Live Test #7
  assert.equal(await t.c.hears(/^I have /, 'no'), 'I have Done, D O N E, Bellamy, B E L L A M Y. Is that right? Say yes or no.');
  await t.c.hears(/^Sorry\. Please say your first and last name again\.$/, 'Don Bellamy');
  assert.equal(await t.c.hears(/^I have Don,/, 'yes'), 'I have Don, D O N, Bellamy, B E L L A M Y. Is that right? Say yes or no.', 'the corrected name is spelled too: the E is gone');
  const all = JSON.stringify(t.logs); for (const s of ['D O N', 'B E L L A M Y', 'Bellamy', 'Done']) assert.ok(!all.includes(s), `no ${s} in the diagnostics`);
  for (const r of t.logs.filter(([c]) => c === 'FAST_NAME').map(([, v]) => v)) assert.deepEqual(cleanDetail(r), r, 'the sink keeps every field');
});

test('alternate time: a time, a part of the day or a day that cannot be given is SAID ("I do not have 9 A M ... the nearest time I have that day is 11 A M"); an exact time is offered in the plain words; the decision is logged as flags and numbers', async () => {
  const busy = { busy: [{ start: instantOf('2026-11-03', '09:00', TZ), end: instantOf('2026-11-03', '11:00', TZ) }], complete: true };
  const a = build({ busy }); a.h.serve(a.c.transport); await toOffer(a.c, 'Tuesday at 9 a.m.');   // Live Test #7: 9 A M asked, the nearest free time is 11 A M
  assert.equal(await a.c.hears(/is one hundred ninety-nine dollars/, 'no'), 'A standard cleaning for two bedrooms and two bathrooms is one hundred ninety-nine dollars. I do not have 9 A M on Tuesday, November third, 2026. The nearest time I have that day is 11 A M. Does that work?');
  const row = a.logs.find(([k]) => k === 'FAST_OFFER')![1] as Record<string, unknown>;
  assert.deepEqual(row, { kind: 'same_day', said: 'TIME_SUBSTITUTED', askedDay: true, askedTime: true, askedPart: false, sameDay: true, sameTime: false, dayOffset: 1, startMin: 660, askedMin: 540, refused: 0 });
  const b = build(); b.h.serve(b.c.transport); await toOffer(b.c, 'Tuesday at 9 a.m.');   // free: the plain words, unchanged
  assert.equal(await b.c.hears(/is one hundred ninety-nine dollars/, 'no'), 'A standard cleaning for two bedrooms and two bathrooms is one hundred ninety-nine dollars. We have Tuesday, November third, 2026 at 9 A M. Does that work?');
  assert.deepEqual([b.logs.find(([k]) => k === 'FAST_OFFER')![1]].map((r) => [(r as Record<string, unknown>).kind, (r as Record<string, unknown>).said, (r as Record<string, unknown>).sameTime]), [['exact', 'PLAIN', true]]);
  const c = build(); c.h.serve(c.c.transport); await toOffer(c.c, 'Tuesday evening');   // no evening time in the hours
  assert.match(await c.c.hears(/is one hundred ninety-nine dollars/, 'no'), /I do not have an evening time on Tuesday, November third, 2026\. The nearest time I have that day is 9 A M\. Does that work\?$/);
  const d = build(); d.h.serve(d.c.transport); await toOffer(d.c, 'Sunday');   // no hours on a Sunday
  assert.match(await d.c.hears(/is one hundred ninety-nine dollars/, 'no'), /I do not have an opening on Sunday, November eighth, 2026\. The next opening I have is Monday, November ninth, 2026 at 9 A M\. Does that work\?$/);
  const e = build(); e.h.serve(e.c.transport); await toOffer(e.c, 'Tuesday');   // a day with no time: the earliest time that day is the plain offer, not a substitution
  assert.match(await e.c.hears(/is one hundred ninety-nine dollars/, 'no'), /We have Tuesday, November third, 2026 at 9 A M\. Does that work\?$/);
  for (const t of [a, b, c, d, e]) { for (const r of t.logs.filter(([k]) => k === 'FAST_OFFER' || k === 'FAST_WHEN').map(([, v]) => v)) assert.deepEqual(cleanDetail(r), r, 'the sink keeps every field'); noPersonalDetail(t.logs, ['Tuesday', 'Sunday', 'November', '11 A M', '9 A M']); }
});

test('a time said in a second piece is kept: "Tuesday" then "at 9 a.m." (even while the size is being asked) gives a 9 A M offer, the size question is not asked twice, and a real size answer is still read', async () => {
  const start = async (settleMs: number) => { const t = build({ settleMs }); t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented'); await t.c.hears(/Is that right\? Say yes or no/, 'yes'); await t.c.hears(/street address/, '123 Invented Lane, Testville, CA 90210'); return t; };
  const sizeAsks = (t: ReturnType<typeof build>): number => t.c.lines.filter((l) => /bedrooms and bathrooms\?$|^And how many/.test(l)).length;
  // (a) the time arrives inside the quiet wait after the day
  const a = await start(80); await a.c.hears(/What day and time/, 'Tuesday'); await sleep(30); a.c.emit({ kind: 'utterance', text: 'at 9 a.m.' });
  await a.c.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  assert.match(await a.c.hears(/is one hundred ninety-nine dollars/, undefined), /We have Tuesday, November third, 2026 at 9 A M\. Does that work\?$/); assert.equal(sizeAsks(a), 1);
  // (b) Live Test #7: the day was answered, the size question was already asked, and the time arrives as its own piece
  const b = await start(5); await b.c.hears(/What day and time/, 'Tuesday'); await b.c.hears(/^How many bedrooms and bathrooms\?$/, undefined);
  b.c.emit({ kind: 'utterance', text: 'at 9 a.m.' }); await sleep(30); b.c.emit({ kind: 'utterance', text: 'two bedrooms and two bathrooms' });
  assert.match(await b.c.hears(/is one hundred ninety-nine dollars/, undefined), /We have Tuesday, November third, 2026 at 9 A M\. Does that work\?$/);
  assert.equal(b.c.lines.filter((l) => /^Sorry, how many/.test(l)).length, 0, 'the time was not mistaken for a failed size answer, so no "Sorry" question');
  assert.deepEqual(b.logs.filter(([k]) => k === 'FAST_WHEN').map(([, v]) => (v as Record<string, unknown>).path), ['ANSWER', 'LATE_TIME']);
  // (c) a real size answer, and a bare count for the bathrooms, are never taken for a time
  const c = await start(80); await c.c.hears(/What day and time/, 'Tuesday at ten'); await c.c.hears(/bedrooms and bathrooms/, 'two bedrooms'); await sleep(30); c.c.emit({ kind: 'utterance', text: 'two' });
  assert.match(await c.c.hears(/is one hundred ninety-nine dollars/, undefined), /We have Tuesday, November third, 2026 at 10 A M\./); assert.ok(!c.logs.some(([k, v]) => k === 'FAST_WHEN' && (v as Record<string, unknown>).path === 'LATE_TIME'));
  // (d) a day with no time still goes on after the quiet wait, once
  const d = await start(80); await d.c.hears(/What day and time/, 'Tuesday'); await d.c.hears(/^How many bedrooms and bathrooms\?$/, 'two bedrooms and two bathrooms');
  assert.match(await d.c.hears(/is one hundred ninety-nine dollars/, undefined), /We have Tuesday, November third, 2026 at 9 A M\./); assert.equal(sizeAsks(d), 1);
  const w = d.logs.filter(([k]) => k === 'FAST_WHEN').map(([, v]) => v as Record<string, unknown>); assert.deepEqual(w.map((r) => [r.path, r.hasDay, r.hasTime]), [['ANSWER', true, false]]);
  for (const r of [...a.logs, ...b.logs, ...c.logs, ...d.logs].filter(([k]) => k === 'FAST_WHEN').map(([, v]) => v)) assert.deepEqual(cleanDetail(r), r, 'the sink keeps every field');
  noPersonalDetail([...a.logs, ...b.logs, ...d.logs], ['Tuesday', 'a.m.', 'November']);
});

test('fail closed: the booking carries exactly what the caller confirmed; any difference names the field and sends nothing; a "verified" result that still names a differing field is not a booking and nothing is emailed', async () => {
  const req = (over: Partial<{ first: string; start: string; state: string }> = {}): BookingRequest => ({ key: 'fast-0123456789abcdef01234567', gate: { eligibleRecord: true, approvedByPerson: true, callerAgreed: true }, client: { firstName: over.first ?? 'Don', lastName: 'Bellamy', phone: '5550100002' }, address: { street1: '123 Invented Lane', city: 'Testville', postalCode: '90210', province: over.state ?? 'TX' }, when: { date: '2026-11-03', startTime: over.start ?? '09:00', endTime: '11:00', utcOffset: '-06:00' }, title: 'Standard cleaning', service: 'Standard cleaning 2 bed 2 bath', priceDollars: 199 });
  const ok = { first: 'Don', last: 'Bellamy', date: '2026-11-03', start: '09:00', end: '11:00', street: '123 Invented Lane', city: 'Testville', zip: '90210', state: 'TX', price: 199 };
  assert.deepEqual(confirmedMismatches(ok, req()), []); assert.deepEqual(confirmedMismatches(undefined, req()), ['confirmation']);
  assert.deepEqual(confirmedMismatches(ok, req({ first: 'Done' })), ['first_name']); assert.deepEqual(confirmedMismatches(ok, req({ start: '11:00' })), ['start_time']); assert.deepEqual(confirmedMismatches(ok, req({ state: 'CA' })), ['state']);
  assert.deepEqual(confirmedMismatches({ ...ok, zip: '90211', price: 200, date: '2026-11-04' }, req()), ['date', 'zip', 'price']);
  // the normal path logs the guard as a flag and numbers, and the request equals the offer
  const t = build({ emails: 'accept', textsEnabled: false }); await toBooked(t);
  assert.deepEqual(t.logs.filter(([k]) => k === 'FAST_BOOKING_GUARD').map(([, v]) => v), [{ ok: true, count: 0, startMin: 600, sameAsOffer: true }]);
  assert.deepEqual([t.booked[0].when.date, t.booked[0].when.startTime, t.booked[0].when.endTime], ['2026-11-03', '10:00', '12:00']);
  // Jobber's own read-back names a differing field although the status says verified: the call ends, nothing is emailed, texted or claimed
  const m = build({ emails: 'accept', textsEnabled: true, book: () => ({ status: 'booked_verified', jobId: 'JOB-1', jobNumber: 1001, writes: 2, mismatches: ['visit_time'] }) });
  m.h.serve(m.c.transport); await toOffer(m.c); await m.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await m.c.hears(/calling from a number ending in/, 'yes'); await m.c.hears(/May we send you one automated/, 'yes'); await m.c.hears(/To confirm/, 'yes'); await finish(m.c);
  assert.deepEqual([m.last().reason, m.last().booked], ['BOOKING_NOT_VERIFIED', false]); assert.equal(bookingMails(m).length, 0); assert.equal(m.texts.length, 0);
  assert.ok(!m.c.lines.some((l) => /You are booked|confirmation (?:text|email)/.test(l)), 'no booking is claimed');
  assert.deepEqual(m.logs.filter(([k]) => k === 'FAST_BOOKING').map(([, v]) => v), [{ status: 'booked_verified', readBackDiffs: 1 }], 'a count of differing fields, never their values');
});


// ---------------------------------------------------------------- Live Test #8: the street is spelled in the read-back, and a "no" opens the correction of the address (as the name's confirmation does)
/** A call up to the read-back; the caller's answer to it is left to the test. */
async function toReadback(t: ReturnType<typeof build>): Promise<void> {
  t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented');
  await t.c.hears(/Is that right\? Say yes or no/, 'yes'); await t.c.hears(/street address/, '123 Invented Lane, Testville, CA 90210'); await t.c.hears(/What day and time/, 'Tuesday at ten'); await t.c.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  await t.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await t.c.hears(/calling from a number ending in/, 'yes');
}
const nothingSent = (t: ReturnType<typeof build>): void => { assert.equal(t.booked.length, 0, 'nothing was written to Jobber'); assert.equal(bookingMails(t).length, 0); assert.equal(t.texts.length, 0); };

test('ADDRESS spelling: the street name is spelled letter by letter, word by word, after the house number; the house number is not spelled', () => {
  assert.equal(spellStreet('123 Invented Lane'), 'I N V E N T E D, L A N E');
  assert.equal(spellStreet('456 Woodland Hills Drive'), 'W O O D L A N D, H I L L S, D R I V E');
  assert.equal(spellStreet("45 O'Brien St."), 'O apostrophe B R I E N, S T');
  assert.equal(spellStreet('12-B Elm Way'), 'E L M, W A Y');
  assert.equal(spellStreet('PO Box 12'), 'P O, B O X, 12', 'a PO box has no house number to leave out');
  assert.equal(spellStreet(''), '');
});

test('ADDRESS: the read-back spells the street name; a no asks which part is wrong, and only the street is said again, spelled back, confirmed, read back again and then booked, with the new street in Jobber and in both emails', async () => {
  const t = build({ emails: 'accept', textsEnabled: false }); await toReadback(t);
  assert.match(await t.c.hears(/To confirm/, 'no'), /at 123 Invented Lane, house number 1 2 3, street spelled I N V E N T E D, L A N E, Testville, California, 9 0 2 1 0\./);
  assert.equal(await t.c.hears(/Which part is wrong/, 'the address'), 'Sorry about that. Which part is wrong: the address, the day and time, or the name?');
  await t.c.hears(/^Please say the street address again: the house number and the street name\.$/, '456 Woodland Hills Drive');
  assert.equal(await t.c.hears(/^I have 456/, 'yes'), 'I have 456 Woodland Hills Drive, house number 4 5 6, street spelled W O O D L A N D, H I L L S, D R I V E. Is that right? Say yes or no.');
  assert.match(await t.c.hears(/To confirm/, 'yes'), /at 456 Woodland Hills Drive, house number 4 5 6, street spelled W O O D L A N D, H I L L S, D R I V E, Testville, California, 9 0 2 1 0\./); await finish(t.c);
  assert.deepEqual(t.booked.map((r) => r.address), [{ street1: '456 Woodland Hills Drive', city: 'Testville', postalCode: '90210', province: 'CA' }], 'only the street changed: the city, ZIP code and state were kept');
  assert.equal(t.mails.length, 2); for (const m of t.mails) { assert.match(m.text, /456 Woodland Hills Drive, Testville, CA 90210/); assert.ok(!/Invented Lane/.test(m.text), 'the old street is nowhere in the email'); }
  assert.deepEqual([t.last().reason, t.last().booked], ['BOOKED', true]);
  assert.equal(t.c.lines.filter((l) => /^What is the city|^And the ZIP code|What state is that in|What day and time/.test(l)).length, 1, 'nothing but the street was asked again');
  assert.deepEqual(t.logs.filter(([k]) => k === 'FAST_BOOKING_GUARD').map(([, v]) => v), [{ ok: true, count: 0, startMin: 600, sameAsOffer: true }], 'the guard compared the booking with the corrected read-back');
  const rows = t.logs.filter(([k]) => k === 'FAST_ADDRESS_FIX').map(([, v]) => v as Record<string, unknown>);
  assert.deepEqual(rows, [{ path: 'FIELD', field: 'address', retry: false, words: 2, chars: 11 }, { path: 'SAY', outcome: 'captured', attempt: 1, bad: 0, words: 4, chars: 24 }, { path: 'CONFIRM', answer: 'yes', no: 0, spelled: true, letters: 18 }], 'tokens, flags and counts: never the street');
  for (const r of rows) assert.deepEqual(cleanDetail(r), r, 'the sink keeps every field');
  const asks = t.c.lines.filter((l) => /\?|Say yes or no/.test(l)); assert.equal(new Set(asks).size, asks.length, 'no question was asked twice');
  noPersonalDetail(t.logs, ['Woodland', 'Hills', '456']);
});

test('ADDRESS: a no with "never mind" ends as before; a wrong day and time, or a wrong name, ends with a person to follow up; an unclear or two-part answer is asked once more, then ends; nothing is booked, emailed or texted in any of them', async () => {
  const a = build({ emails: 'accept', textsEnabled: false }); await toReadback(a); await a.c.hears(/To confirm/, 'no'); await a.c.hears(/Which part is wrong/, 'never mind'); await finish(a.c);
  assert.equal(a.last().reason, 'DECLINED_AT_READBACK'); assert.match(a.c.lines.at(-1)!, /Nothing was booked/); nothingSent(a);
  for (const said of ['the day and time', 'my name']) {
    const b = build({ emails: 'accept', textsEnabled: false }); await toReadback(b); await b.c.hears(/To confirm/, 'no'); await b.c.hears(/Which part is wrong/, said); await finish(b.c);
    assert.equal(b.last().reason, 'FIELD_NOT_SUPPORTED', said); assert.equal(b.c.lines.at(-1), 'Sorry, I can only change the address on this call, so nothing was booked. Your request is recorded. Goodbye.'); nothingSent(b);
  }
  const c = build({ emails: 'accept', textsEnabled: false }); await toReadback(c); await c.c.hears(/To confirm/, 'no'); await c.c.hears(/Which part is wrong/, 'hmm');
  await c.c.hears(/^Sorry, which part is wrong/, 'the name and the address'); await finish(c.c);
  assert.equal(c.last().reason, 'UNCONFIRMED'); nothingSent(c);
  const d = build({ emails: 'accept', textsEnabled: false }); await toReadback(d); await d.c.hears(/To confirm/, 'no'); await d.c.hears(/Which part is wrong/, 'the street name');
  assert.equal(d.c.lines.filter((l) => /Which part is wrong/.test(l)).length, 1, '"the street name" names the address alone: asked once'); await d.c.hears(/^Please say the street address again/, undefined); d.c.hangUp();
});

test('ADDRESS spelling input: a second wrong street gets a spelling, word by word and in pieces; the spelled street is confirmed, read back and booked exactly; each prompt is asked once', async () => {
  const t = build({ emails: 'accept', textsEnabled: false, settleMs: 80 }); await toReadback(t);
  await t.c.hears(/To confirm/, 'no'); await t.c.hears(/Which part is wrong/, 'the street'); await t.c.hears(/^Please say the street address again/, '456 Willin Hills Drive');   // heard wrong, as in Live Test #8
  await t.c.hears(/^I have 456 Willin Hills Drive, house number 4 5 6, street spelled W I L L I N, H I L L S, D R I V E\./, 'no');
  await t.c.hears(/^Please spell the street name, one letter at a time, with a pause between words\. Leave out the house number\.$/, 'W O O D L A N D'); await sleep(30); t.c.emit({ kind: 'utterance', text: 'H I L L S' }); await sleep(30); t.c.emit({ kind: 'utterance', text: 'Drive' });
  assert.equal(await t.c.hears(/^I have 456 Woodland/, 'yes'), 'I have 456 Woodland Hills Drive, house number 4 5 6, street spelled W O O D L A N D, H I L L S, D R I V E. Is that right? Say yes or no.');
  assert.match(await t.c.hears(/To confirm/, 'yes'), /at 456 Woodland Hills Drive, house number 4 5 6, street spelled W O O D L A N D, H I L L S, D R I V E, Testville/); await finish(t.c);
  assert.deepEqual(t.booked.map((r) => r.address.street1), ['456 Woodland Hills Drive']); assert.ok(t.mails.every((m) => /456 Woodland Hills Drive/.test(m.text) && !/Willin|Invented Lane/.test(m.text)));
  assert.equal(t.c.lines.filter((l) => /^Please spell the street name/.test(l)).length, 1, 'the pieces were joined, not re-asked');
  const rows = t.logs.filter(([k]) => k === 'FAST_ADDRESS_FIX').map(([, v]) => v as Record<string, unknown>);
  for (const r of rows) assert.deepEqual(cleanDetail(r), r, 'the sink keeps every field');
  assert.deepEqual(rows.filter((r) => r.path === 'SPELL').map((r) => [r.parsed, r.spokenWords, r.held]), [[true, 1, 0], [true, 1, 1], [true, 1, 2]], 'counts and flags only');
  noPersonalDetail(t.logs, ['Woodland', 'Willin', 'Hills', '456']);
});

test('ADDRESS failure: two no answers to the spelled street, a spelling that gives nothing twice, or three unclear answers end the call with a person to follow up; the street under correction is never read back or booked', async () => {
  const a = build({ emails: 'accept', textsEnabled: false, settleMs: 80 }); await toReadback(a);
  await a.c.hears(/To confirm/, 'no'); await a.c.hears(/Which part is wrong/, 'the address'); await a.c.hears(/^Please say the street address again/, '456 Willin Hills Drive');
  await a.c.hears(/^I have 456 Willin Hills Drive, house number 4 5 6, street spelled/, 'no'); await a.c.hears(/^Please spell the street name/, 'W I L L I N. H I L L S. D R I V E');   // the spelling is the same wrong word
  await a.c.hears(/^I have 456 Willin Hills Drive, house number 4 5 6, street spelled/, 'no'); await finish(a.c);
  assert.equal(a.last().reason, 'ADDRESS_NOT_CONFIRMED'); assert.equal(a.c.lines.at(-1), 'Sorry, I am having trouble with that. Your request is recorded. Goodbye.'); nothingSent(a); assert.equal(a.c.lines.filter((l) => /^To confirm/.test(l)).length, 1, 'no second read-back');
  const b = build({ emails: 'accept', textsEnabled: false, settleMs: 80 }); await toReadback(b);
  await b.c.hears(/To confirm/, 'no'); await b.c.hears(/Which part is wrong/, 'the address'); await b.c.hears(/^Please say the street address again/, '456 Willin Hills Drive'); await b.c.hears(/^I have 456/, 'no');
  await b.c.hears(/^Please spell the street name/, 'not sure'); await b.c.hears(/^Sorry, please spell the street name again/, 'two bedrooms'); await finish(b.c);
  assert.equal(b.last().reason, 'ADDRESS_NOT_CONFIRMED'); nothingSent(b);
  const c = build({ emails: 'accept', textsEnabled: false, settleMs: 80 }); await toReadback(c);
  await c.c.hears(/To confirm/, 'no'); await c.c.hears(/Which part is wrong/, 'the address'); await c.c.hears(/^Please say the street address again/, '456 Woodland Hills Drive');
  await c.c.hears(/^I have 456/, 'hmm'); await c.c.hears(/^Please say yes or no\. I have 456/, 'hmm'); await c.c.hears(/^Please say yes or no\. I have 456/, 'hmm'); await finish(c.c);
  assert.equal(c.last().reason, 'UNCONFIRMED'); nothingSent(c); assert.equal(c.c.lines.filter((l) => /^To confirm/.test(l)).length, 1, 'the corrected street was never read back');
  const d = build({ emails: 'accept', textsEnabled: false, settleMs: 80 }); await toReadback(d);
  await d.c.hears(/To confirm/, 'no'); await d.c.hears(/Which part is wrong/, 'the address'); await d.c.hears(/^Please say the street address again/, undefined); d.c.hangUp(); await sleep(60);
  nothingSent(d);
});

test('ADDRESS: the address can be corrected twice in one call; a third correction ends the call with a person to follow up and nothing booked', async () => {
  const t = build({ emails: 'accept', textsEnabled: false }); await toReadback(t);
  for (const n of [1, 2]) { await t.c.hears(/To confirm/, 'no'); await t.c.hears(/Which part is wrong/, 'the address'); await t.c.hears(/^Please say the street address again/, `45${n} Woodland Hills Drive`); await t.c.hears(/^I have 45/, 'yes'); }
  await t.c.hears(/To confirm/, 'no'); await t.c.hears(/Which part is wrong/, 'the address'); await finish(t.c);
  assert.equal(t.last().reason, 'ADDRESS_NOT_CONFIRMED'); nothingSent(t);
});

test('ADDRESS pieces: a house number said first and the street name after it are put together; a street name said alone keeps the house number that was held; a street never heard is asked for once more, then ends', async () => {
  const a = build({ emails: 'accept', textsEnabled: false, settleMs: 80 }); await toReadback(a);
  await a.c.hears(/To confirm/, 'no'); await a.c.hears(/Which part is wrong/, 'the address'); await a.c.hears(/^Please say the street address again/, '456'); await sleep(30); a.c.emit({ kind: 'utterance', text: 'Woodland Hills Drive' });
  await a.c.hears(/^I have 456 Woodland Hills Drive, house number 4 5 6, street spelled/, 'yes'); await a.c.hears(/To confirm/, 'yes'); await finish(a.c);
  assert.deepEqual(a.booked.map((r) => r.address.street1), ['456 Woodland Hills Drive']);
  const b = build({ emails: 'accept', textsEnabled: false, settleMs: 80 }); await toReadback(b);
  await b.c.hears(/To confirm/, 'no'); await b.c.hears(/Which part is wrong/, 'the address'); await b.c.hears(/^Please say the street address again/, 'Woodland Hills Drive');
  await b.c.hears(/^I have 123 Woodland Hills Drive, house number 1 2 3, street spelled/, 'yes'); await b.c.hears(/To confirm/, 'yes'); await finish(b.c);
  assert.deepEqual(b.booked.map((r) => [r.address.street1, r.address.city, r.address.postalCode]), [['123 Woodland Hills Drive', 'Testville', '90210']]);
  const c = build({ emails: 'accept', textsEnabled: false, settleMs: 80 }); await toReadback(c);
  await c.c.hears(/To confirm/, 'no'); await c.c.hears(/Which part is wrong/, 'the address'); await c.c.hears(/^Please say the street address again/, 'hmm'); await c.c.hears(/^Sorry, please say the house number and the street name\.$/, 'yeah'); await c.c.hears(/^Sorry, please say the house number and the street name\.$/, 'hmm'); await finish(c.c);
  assert.equal(c.last().reason, 'ADDRESS_NOT_CONFIRMED'); nothingSent(c);
});

test('ADDRESS (DEFECT-1-3): a no to the read-back can be taken back: "it is fine" speaks the read-back again, which still needs its own yes; at most twice, then the call ends; nothing changes', async () => {
  const t = build({ emails: 'accept', textsEnabled: false }); await toReadback(t);
  const first = await t.c.hears(/To confirm/, 'no'); await t.c.hears(/Which part is wrong/, "no, it's fine, go ahead");
  assert.equal(await t.c.hears(/To confirm/, 'yes'), first, 'the same read-back, word for word'); await finish(t.c);
  assert.deepEqual(t.booked.map((r) => r.address), [{ street1: '123 Invented Lane', city: 'Testville', postalCode: '90210', province: 'CA' }], 'the street is the one first heard and read back');
  assert.equal(t.mails.length, 2); assert.deepEqual([t.last().reason, t.last().booked], ['BOOKED', true]);
  assert.deepEqual(t.logs.filter(([k]) => k === 'FAST_ADDRESS_FIX').map(([, v]) => v), [{ path: 'FIELD', field: 'ok', retry: false, words: 5, chars: 23 }], 'a short token and counts');
  const u = build({ emails: 'accept', textsEnabled: false }); await toReadback(u);
  for (let i = 0; i < 2; i++) { await u.c.hears(/To confirm/, 'no'); await u.c.hears(/Which part is wrong/, 'that is right'); }
  await u.c.hears(/To confirm/, 'no'); await u.c.hears(/Which part is wrong/, 'everything is fine'); await finish(u.c);
  assert.equal(u.last().reason, 'UNCONFIRMED'); nothingSent(u); assert.equal(u.c.lines.filter((l) => /^To confirm/.test(l)).length, 3, 'the read-back was spoken three times, never more');
  const v = build({ emails: 'accept', textsEnabled: false }); await toReadback(v); await v.c.hears(/To confirm/, 'no'); await v.c.hears(/Which part is wrong/, 'it is not fine'); await finish(v.c);
  assert.equal(v.last().reason, 'DECLINED_AT_READBACK', 'a negated phrase is not "it is fine"'); nothingSent(v);
});

test('ADDRESS (DEFECT-1-3): "the name of the street" goes straight to the street; a word that is not a street name is asked for again and never spends a correction', async () => {
  const t = build({ emails: 'accept', textsEnabled: false, settleMs: 80 }); await toReadback(t);
  await t.c.hears(/To confirm/, 'no'); await t.c.hears(/Which part is wrong/, 'the name of the street');
  assert.equal(t.c.lines.filter((l) => /Which part is wrong/.test(l)).length, 1, 'named once: the address');
  await t.c.hears(/^Please say the street address again/, 'Sorry'); await t.c.hears(/^Sorry, please say the house number and the street name\.$/, 'Woodland Hills Drive');
  await t.c.hears(/^I have 123 Woodland Hills Drive, house number 1 2 3, street spelled/, 'yes'); await t.c.hears(/To confirm/, 'yes'); await finish(t.c);
  assert.deepEqual(t.booked.map((r) => r.address.street1), ['123 Woodland Hills Drive']); assert.equal(t.c.lines.filter((l) => /^I have 123/.test(l)).length, 1, 'the word "Sorry" was never read back as a street');
  assert.ok(!t.c.lines.some((l) => /S O R R Y/.test(l)));
});

test('ADDRESS (COMMA-NUMBER): a house number written with thousands commas is taken, said whole or after the street name, and the call still reaches the read-back and books it', async () => {
  const t = build({ emails: 'accept', textsEnabled: false, settleMs: 80 });
  t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented');
  await t.c.hears(/Is that right[?] Say yes or no/, 'yes'); await t.c.hears(/street address/, 'Woodland Hills Drive.');
  await t.c.hears(/house number/, '15,951.'); await t.c.hears(/city|ZIP/, 'Testville, CA 90210');
  await t.c.hears(/What day and time/, 'Tuesday at ten'); await t.c.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  await t.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await t.c.hears(/calling from a number ending in/, 'yes');
  const text = await t.c.hears(/To confirm/, 'yes'); assert.match(text, /at 15951 Woodland Hills Drive, house number 1 5 9 5 1, street spelled/, 'the number is read back as one number'); await finish(t.c);
  assert.deepEqual(t.booked.map((r) => r.address.street1), ['15951 Woodland Hills Drive']); assert.equal(t.last().booked, true);
  const u = build({ emails: 'accept', textsEnabled: false });
  u.h.serve(u.c.transport); u.c.setup(DREW, undefined, 'Testa Invented');
  await u.c.hears(/Is that right[?] Say yes or no/, 'yes'); await u.c.hears(/street address/, '15,951 Woodland Hills Drive, Testville, CA 90210'); await u.c.hears(/What day and time/, 'Tuesday at ten');
  assert.ok(!u.c.lines.some((l) => /house number/.test(l)), 'the number was not asked for again');
});

test('ADDRESS (ZIP-AS-NUMBER, Live Test #10): a ZIP said where the house number was wanted is never booked as the number; the number is asked again, spelled digit by digit, confirmed, and only then booked; an address without a real number ends with nothing sent', async () => {
  const t = build({ emails: 'accept', textsEnabled: false, settleMs: 80 });
  t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented');
  await t.c.hears(/Is that right[?] Say yes or no/, 'yes'); await t.c.hears(/street address/, 'Woodland Hills Drive.');
  await t.c.hears(/house number/, '90210.'); await t.c.hears(/city/, 'Testville.'); await t.c.hears(/ZIP/, '90210.');
  await t.c.hears(/house number/, '15951.');
  await t.c.hears(/What state/, 'California'); await t.c.hears(/What day and time/, 'Tuesday at ten'); await t.c.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  await t.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await t.c.hears(/calling from a number ending in/, 'yes');
  const text = await t.c.hears(/To confirm/, 'yes'); assert.match(text, /at 15951 Woodland Hills Drive, house number 1 5 9 5 1, street spelled/); assert.doesNotMatch(text, /90210 Woodland/); await finish(t.c);
  assert.deepEqual(t.booked.map((r) => r.address.street1), ['15951 Woodland Hills Drive']); assert.equal(t.booked[0].address.postalCode, '90210');
  const u = build({ emails: 'accept', textsEnabled: false, settleMs: 80 });
  u.h.serve(u.c.transport); u.c.setup(DREW, undefined, 'Testa Invented');
  await u.c.hears(/Is that right[?] Say yes or no/, 'yes'); await u.c.hears(/street address/, 'Woodland Hills Drive.');
  await u.c.hears(/house number/, '90210.'); await u.c.hears(/city/, 'Testville.'); await u.c.hears(/ZIP/, '90210.');
  for (let i = 0; i < 4; i++) await u.c.hears(/house number/, '90210.').catch(() => undefined);
  assert.equal(u.booked.length, 0, 'nothing is booked'); assert.ok(!u.c.lines.some((l) => /^To confirm/.test(l)), 'no read-back of a wrong address');
});

test('ADDRESS guard: addressIssues names what is wrong and never a value; spellHouseNumber says the number digit by digit; the booking request needs a leading house number, a two-letter state, and a number that is not the ZIP', () => {
  const ok = { street: '15951 Woodland Hills Drive', city: 'Encino', zip: '91436', state: 'CA' };
  assert.deepEqual(addressIssues(ok), []);
  assert.deepEqual(addressIssues({ ...ok, street: '91436 Woodland Hills Drive' }), ['house_number_is_zip']);
  assert.deepEqual(addressIssues({ ...ok, street: 'Woodland Hills Drive' }), ['house_number']); assert.deepEqual(addressIssues({ ...ok, street: '91436' }), ['house_number']);
  assert.deepEqual(addressIssues({ ...ok, state: undefined }), ['state']); assert.deepEqual(addressIssues({ ...ok, zip: '9143' }), ['zip']); assert.deepEqual(addressIssues({ ...ok, city: '' }), ['city']);
  assert.equal(spellHouseNumber('15951 Woodland Hills Drive'), '1 5 9 5 1'); assert.equal(spellHouseNumber('12-B Elm Way'), '1 2 dash B'); assert.equal(spellHouseNumber('Woodland Hills Drive'), '');
});

test('ADDRESS shape log: a rejected address answer logs only its shape (digit 9, letter a, space _, punctuation by position); accepted and partial answers log none; no letter, digit or raw transcript reaches the log', async () => {
  assert.equal(transcriptShape('15,951.'), '99C999.'); assert.equal(transcriptShape('12, 345.'), '99C_999.'); assert.equal(transcriptShape('1-5-9'), '9-9-9'); assert.equal(transcriptShape('15951-1234'), '99999-9999');
  assert.equal(transcriptShape("O'Brien St. #4/5:"), 'aQaaaaa_aa._H9S9:'); assert.equal(transcriptShape('  \u00c9lm  '), 'aaa'); assert.equal(transcriptShape('a@b!'), 'aPaP'); assert.equal(transcriptShape(''), '');
  assert.equal(transcriptShape('x'.repeat(100)).length, 48, 'capped at the sink limit'); assert.equal(transcriptShape('12345'), '99999', 'the digits are gone');
  assert.deepEqual(cleanDetail({ shape: transcriptShape("O'Brien, 12-5 #4/5: x.y!") }), { shape: transcriptShape("O'Brien, 12-5 #4/5: x.y!") }, 'the real log sink keeps the shape whole');
  const t = build({ emails: 'accept', textsEnabled: false, settleMs: 80 });
  t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented');
  await t.c.hears(/Is that right[?] Say yes or no/, 'yes'); await t.c.hears(/street address/, 'Zorblax 2468, Quentin');
  await t.c.hears(/./, 'Quibble Zorblax'); await t.c.hears(/./, '2468 Quibble Lane');
  const rows = t.logs.filter(([k]) => k === 'FAST_ADDRESS').map(([, v]) => v as Record<string, unknown>);
  assert.ok(rows.length >= 2); for (const r of rows) assert.equal('shape' in r, r.outcome === 'unclear', 'a shape only for a rejected answer'); assert.ok(rows.some((r) => r.outcome === 'unclear'), 'the test did reject an answer');
  for (const r of rows) { assert.deepEqual(cleanDetail(r), r, 'the sink keeps every field'); if (typeof r.shape === 'string') assert.match(r.shape, /^[a9_.:CQSHP-]{1,48}$/); }
  const all = JSON.stringify(t.logs); for (const secret of ['Zorblax', 'Quentin', 'Quibble', '2468', 'Zorblax 2468']) assert.ok(!all.includes(secret), `${secret} must not appear in any log`);
});

// ---- Live Test #11: early NO and false-interruption recovery over a confirmation unit (no VAD change; a YES is never taken early)
const noiseCut = async (c: ReturnType<typeof fakeCarrier>, re: RegExp): Promise<void> => {
  await c.hears(re, undefined, { verdict: 'cut', before: () => c.emit({ kind: 'speech', active: true }) });   // the caller's speech cuts the line ...
  c.emit({ kind: 'speech', active: false }); c.emit({ kind: 'partial' });   // ... and proves to be noise: nothing could be transcribed
};

test('early NO: a no said over the offer is taken at once (no held yes, no replay), nothing is booked; a YES said over it is still held and confirms nothing', async () => {
  const a = build({ emails: 'accept', textsEnabled: false, holdGraceMs: 30 }); a.h.serve(a.c.transport); await toOffer(a.c);
  await a.c.hears(/is one hundred ninety-nine dollars/, 'no', { early: true });
  assert.equal(a.logs.filter(([c]) => c === 'CONFIRM_EARLY_NO').length, 1); assert.ok(!a.logs.some(([c]) => c === 'CONFIRM_HELD' || c === 'CONFIRM_REPLAY'), 'a no needs no replay');
  await sleep(120); assert.ok(!a.c.lines.some((l) => /^Please wait until I have finished/.test(l)), 'the line was not read again'); assert.equal(a.booked.length, 0);
  const b = build({ emails: 'accept', textsEnabled: false, holdGraceMs: 30 }); b.h.serve(b.c.transport); await toOffer(b.c);
  await b.c.hears(/is one hundred ninety-nine dollars/, 'yes', { early: true });
  assert.ok(b.logs.some(([c]) => c === 'CONFIRM_HELD')); assert.ok(!b.logs.some(([c]) => c === 'CONFIRM_EARLY_NO'));
  await b.c.hears(/^Please wait until I have finished, then answer\. /, 'yes'); await b.c.hears(/calling from a number ending in/, undefined);
});

test('early NO at the read-back: nothing is booked and the correction is asked; an early YES at the read-back books nothing until a fresh yes after the whole line', async () => {
  const a = build({ emails: 'accept', textsEnabled: false, holdGraceMs: 30 }); await toReadback(a);
  await a.c.hears(/^To confirm/, 'no', { early: true });
  assert.ok(a.logs.some(([c]) => c === 'CONFIRM_EARLY_NO')); await a.c.until(() => a.c.lines.some((l) => /Which part is wrong/.test(l)), 'the correction question');
  assert.equal(a.booked.length, 0, 'a no never books'); assert.ok(!a.logs.some(([c]) => c === 'JOBBER_BOOKING_CREATED'));
  const b = build({ emails: 'accept', textsEnabled: false, holdGraceMs: 30 }); await toReadback(b);
  await b.c.hears(/^To confirm/, 'yes', { early: true });
  assert.ok(b.logs.some(([c]) => c === 'CONFIRM_HELD')); await sleep(60); assert.equal(b.booked.length, 0, 'a yes before the whole read-back confirms nothing');
  await b.c.hears(/^Please wait until I have finished, then answer\. To confirm/, 'yes'); await finish(b.c);
  assert.equal(b.booked.length, 1, 'only the fresh yes after the whole line books'); assert.equal(b.last().booked, true);
});

test('false interruption: noise that cuts a confirmation line (an empty transcript) replays it plainly, without "please wait", and does not use up the replays; a real cut still does', async () => {
  const t = build({ emails: 'accept', textsEnabled: false, holdGraceMs: 30 }); t.h.serve(t.c.transport); await toOffer(t.c);
  for (let i = 0; i < 4; i++) await noiseCut(t.c, i === 0 ? /is one hundred ninety-nine dollars/ : /^(?!Please wait).*is one hundred ninety-nine dollars/);
  assert.equal(t.logs.filter(([c]) => c === 'CONFIRM_FALSE_CUT').length, 4, 'four noise cuts, each recovered');
  assert.ok(!t.c.lines.some((l) => /^Please wait until I have finished/.test(l)), 'a plain replay each time');
  await t.c.hears(/^(?!Please wait).*is one hundred ninety-nine dollars/, 'yes'); await t.c.hears(/calling from a number ending in/, 'yes');
  const text = await t.c.hears(/^To confirm/, 'yes'); assert.match(text, /^To confirm/); await finish(t.c); assert.equal(t.booked.length, 1, 'the booking still needs, and gets, its own yes after the whole read-back');
  const u = build({ emails: 'accept', textsEnabled: false, holdGraceMs: 30 }); u.h.serve(u.c.transport); await toOffer(u.c);
  for (let i = 0; i < 3; i++) { await u.c.hears(i === 0 ? /is one hundred ninety-nine dollars/ : /^Please wait.*is one hundred ninety-nine dollars/, undefined, { verdict: 'cut', before: () => u.c.emit({ kind: 'speech', active: true }) }); u.c.emit({ kind: 'speech', active: false }); }   // cut, and no empty transcript: not noise
  await sleep(120); assert.ok(u.c.lines.some((l) => /I could not confirm that/.test(l)), 'real cuts still end an unconfirmed call'); assert.equal(u.logs.filter(([c]) => c === 'CONFIRM_FALSE_CUT').length, 0); assert.equal(u.booked.length, 0);
});

test('ADDRESS (DASHED-DIGITS and HELD-STREET, Live Test #12): the number said digit by digit first, then the street name; or the street name, then a city before the number: the right street is read back digit by digit and booked, never a place name', async () => {
  const a = build({ emails: 'accept', textsEnabled: false, settleMs: 80 });
  a.h.serve(a.c.transport); a.c.setup(DREW, undefined, 'Testa Invented');
  await a.c.hears(/Is that right[?] Say yes or no/, 'yes'); await a.c.hears(/street address/, '1-5-9-5-1.');
  await a.c.hears(/street name/, 'Woodland Hills Drive.'); await a.c.hears(/city|ZIP/, 'Testville, CA 90210');
  await a.c.hears(/What day and time/, 'Tuesday at ten'); await a.c.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  await a.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await a.c.hears(/calling from a number ending in/, 'yes');
  const text = await a.c.hears(/To confirm/, 'yes'); assert.match(text, /at 15951 Woodland Hills Drive, house number 1 5 9 5 1, street spelled W O O D L A N D/); await finish(a.c);
  assert.deepEqual(a.booked.map((r) => r.address.street1), ['15951 Woodland Hills Drive']); assert.equal(a.last().booked, true);
  const b = build({ emails: 'accept', textsEnabled: false, settleMs: 80 });
  b.h.serve(b.c.transport); b.c.setup(DREW, undefined, 'Testa Invented');
  await b.c.hears(/Is that right[?] Say yes or no/, 'yes'); await b.c.hears(/street address/, 'Woodland Hills Drive.');
  await b.c.hears(/house number/, 'Testville.'); await b.c.hears(/house number/, '1-5-9-5-1.');
  await b.c.hears(/ZIP/, '90210.'); await b.c.hears(/What state/, 'California');
  await b.c.hears(/What day and time/, 'Tuesday at ten'); await b.c.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  await b.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await b.c.hears(/calling from a number ending in/, 'yes');
  const t2 = await b.c.hears(/To confirm/, 'yes'); assert.match(t2, /at 15951 Woodland Hills Drive, house number 1 5 9 5 1, street spelled W O O D L A N D, H I L L S, D R I V E, Testville/); assert.doesNotMatch(t2, /Testville Drive|15951 Testville/); await finish(b.c);
  assert.deepEqual(b.booked.map((r) => [r.address.street1, r.address.city, r.address.postalCode]), [['15951 Woodland Hills Drive', 'Testville', '90210']]);
  const rows = b.logs.filter(([k]) => k === 'FAST_ADDRESS').map(([, v]) => v as Record<string, unknown>); assert.ok(rows.length >= 3); for (const r of rows) { assert.deepEqual(cleanDetail(r), r, 'the sink keeps every field'); }
  const all = JSON.stringify(b.logs); for (const secret of ['Woodland', 'Testville', '15951', '90210']) assert.ok(!all.includes(secret), secret + ' must not appear in any log');
});

test('ADDRESS (UNCHECKED-STREET): a house number, then a name with no road word, must be confirmed spelled out BEFORE the read-back; a wrong name gets a no and a spelling; nothing is read back or booked until the street is confirmed; a right roadless name is kept', async () => {
  const a = build({ emails: 'accept', textsEnabled: false, settleMs: 80 });
  a.h.serve(a.c.transport); a.c.setup(DREW, undefined, 'Testa Invented');
  await a.c.hears(/Is that right[?] Say yes or no/, 'yes'); await a.c.hears(/street address/, '15951.');
  await a.c.hears(/street name/, 'Testville.'); await a.c.hears(/city|ZIP/, 'Testville, CA 90210');
  await a.c.hears(/What day and time/, 'Tuesday at ten'); await a.c.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  await a.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await a.c.hears(/calling from a number ending in/, 'yes');
  const ask = await a.c.hears(/^I have 15951 Testville, house number 1 5 9 5 1, street spelled T E S T V I L L E[.] Is that right[?] Say yes or no[.]$/, 'no');
  assert.ok(ask.length > 0); assert.ok(!a.c.lines.some((l) => /^To confirm/.test(l)), 'no read-back before the street is confirmed'); assert.equal(a.booked.length, 0);
  await a.c.hears(/^Please spell the street name/, 'W O O D L A N D. H I L L S. D R I V E');
  await a.c.hears(/^I have 15951 Woodland Hills Drive, house number 1 5 9 5 1, street spelled W O O D L A N D, H I L L S, D R I V E[.]/, 'yes');
  const text = await a.c.hears(/^To confirm/, 'yes'); assert.match(text, /at 15951 Woodland Hills Drive, house number 1 5 9 5 1, street spelled W O O D L A N D, H I L L S, D R I V E, Testville/); await finish(a.c);
  assert.deepEqual(a.booked.map((r) => r.address.street1), ['15951 Woodland Hills Drive']); assert.equal(a.last().booked, true);
  assert.ok(a.logs.some(([c, v]) => c === 'FAST_ADDRESS_CHECK' && (v as { reason: string }).reason === 'ROADLESS'));
  const b = build({ emails: 'accept', textsEnabled: false, settleMs: 80 });
  b.h.serve(b.c.transport); b.c.setup(DREW, undefined, 'Testa Invented');
  await b.c.hears(/Is that right[?] Say yes or no/, 'yes'); await b.c.hears(/street address/, '15951.');
  await b.c.hears(/street name/, 'Broadway.'); await b.c.hears(/city|ZIP/, 'Testville, CA 90210');
  await b.c.hears(/What day and time/, 'Tuesday at ten'); await b.c.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  await b.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await b.c.hears(/calling from a number ending in/, 'yes');
  await b.c.hears(/^I have 15951 Broadway, house number 1 5 9 5 1, street spelled B R O A D W A Y[.]/, 'yes'); await b.c.hears(/^To confirm/, 'yes'); await finish(b.c);
  assert.deepEqual(b.booked.map((r) => r.address.street1), ['15951 Broadway'], 'a right roadless street is kept');
  const c = build({ emails: 'accept', textsEnabled: false, settleMs: 80 });
  c.h.serve(c.c.transport); c.c.setup(DREW, undefined, 'Testa Invented');
  await c.c.hears(/Is that right[?] Say yes or no/, 'yes'); await c.c.hears(/street address/, '15951.');
  await c.c.hears(/street name/, 'Testville.'); await c.c.hears(/city|ZIP/, 'Testville, CA 90210');
  await c.c.hears(/What day and time/, 'Tuesday at ten'); await c.c.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  await c.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await c.c.hears(/calling from a number ending in/, 'yes');
  await c.c.hears(/^I have 15951 Testville/, 'no'); await c.c.hears(/^Please spell the street name/, 'banana'); await c.c.hears(/^Sorry, please spell the street name again/, 'apple'); await finish(c.c);
  assert.equal(c.booked.length, 0, 'an unconfirmed roadless street is never booked'); assert.ok(!c.c.lines.some((l) => /^To confirm/.test(l)), 'and never read back'); assert.equal(c.last().booked, false);
});

test('ADDRESS (SPOKEN-DIGIT-WORDS): a house number said as single digit words, whole or in pieces, is booked as digits; an ambiguous word number ("forty two") is never booked and the call ends with a person to follow up', async () => {
  const a = build({ emails: 'accept', textsEnabled: false, settleMs: 80 });
  a.h.serve(a.c.transport); a.c.setup(DREW, undefined, 'Testa Invented');
  await a.c.hears(/Is that right[?] Say yes or no/, 'yes'); await a.c.hears(/street address/, 'one five nine five one Woodland Hills Drive, Testville, CA nine oh two one oh');
  await a.c.hears(/What day and time/, 'Tuesday at ten'); await a.c.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  await a.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await a.c.hears(/calling from a number ending in/, 'yes');
  const text = await a.c.hears(/^To confirm/, 'yes'); assert.match(text, /at 15951 Woodland Hills Drive, house number 1 5 9 5 1,/); await finish(a.c);
  assert.deepEqual(a.booked.map((r) => [r.address.street1, r.address.postalCode]), [['15951 Woodland Hills Drive', '90210']]);
  const b = build({ emails: 'accept', textsEnabled: false, settleMs: 80 });
  b.h.serve(b.c.transport); b.c.setup(DREW, undefined, 'Testa Invented');
  await b.c.hears(/Is that right[?] Say yes or no/, 'yes'); await b.c.hears(/street address/, 'one five nine five one.');
  await b.c.hears(/street name/, 'Woodland Hills Drive.'); await b.c.hears(/city|ZIP/, 'Testville, CA 90210');
  await b.c.hears(/What day and time/, 'Tuesday at ten'); await b.c.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  await b.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await b.c.hears(/calling from a number ending in/, 'yes');
  await b.c.hears(/^To confirm/, 'yes'); await finish(b.c); assert.deepEqual(b.booked.map((r) => r.address.street1), ['15951 Woodland Hills Drive']);
  const c = build({ emails: 'accept', textsEnabled: false, settleMs: 80 });
  c.h.serve(c.c.transport); c.c.setup(DREW, undefined, 'Testa Invented');
  await c.c.hears(/Is that right[?] Say yes or no/, 'yes'); await c.c.hears(/street address/, 'forty two Woodland Hills Drive, Testville, CA 90210');
  await c.c.hears(/What day and time/, 'Tuesday at ten'); await c.c.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  await c.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await c.c.hears(/calling from a number ending in/, 'yes'); await finish(c.c);
  assert.equal(c.booked.length, 0, 'an ambiguous number is never booked'); assert.ok(!c.c.lines.some((l) => /^To confirm/.test(l)), 'and never read back'); assert.equal(c.last().reason, 'ADDRESS_INVALID');
  assert.ok(c.logs.some(([k, v]) => k === 'FAST_ADDRESS_GUARD' && (v as { field: string }).field === 'house_number'));
});

/** The caller's side of a complete call, with the usual answers, up to the answer to the text-permission question (the next thing is the address check, then the read-back). */
async function toTexts(c: ReturnType<typeof fakeCarrier>): Promise<void> {
  await toOffer(c);
  await c.hears(/is one hundred ninety-nine dollars/, 'yes'); await c.hears(/calling from a number ending in/, 'yes');
  await c.hears(/May we send you one automated/, 'yes');
}
const GOOD: AddressToValidate = { street: '123 Invented Lane', city: 'Testville', state: 'CA', zip: '90210' };

test('ADDRESS CHECK (VALID): the checker is asked once, with exactly the address that is booked; a valid verdict lets the read-back and the booking go on; the diagnostics hold a status token and a count, never the address', async () => {
  const asked: AddressToValidate[] = [];
  const t = build({ validate: async (a) => { asked.push(a); return { status: 'valid' }; } });
  t.h.serve(t.c.transport); await toTexts(t.c);
  const readback = await t.c.hears(/To confirm/, 'yes'); assert.match(readback, /at 123 Invented Lane, house number 1 2 3/);
  await finish(t.c);
  assert.deepEqual(asked, [GOOD], 'asked once, with the address that was heard');
  assert.deepEqual(t.booked.map((r) => r.address), [{ street1: '123 Invented Lane', city: 'Testville', postalCode: '90210', province: 'CA' }]);
  assert.equal(t.last().booked, true);
  const rows = t.logs.filter(([k]) => k === 'FAST_ADDRESS_VALIDATE').map(([, v]) => v as Record<string, unknown>);
  assert.deepEqual(rows, [{ status: 'valid', attempt: 1 }]);
  noPersonalDetail(t.logs, ['Lane']);
});

test('ADDRESS CHECK (NO CHECKER): without a validateAddress dependency nothing changes: no check is logged and the call books as before', async () => {
  const t = build();
  t.h.serve(t.c.transport); await toTexts(t.c);
  await t.c.hears(/To confirm/, 'yes'); await finish(t.c);
  assert.equal(t.booked.length, 1); assert.ok(!t.logs.some(([k]) => k === 'FAST_ADDRESS_VALIDATE'));
});

test('ADDRESS CHECK (MISMATCH ON ZIP, UNKNOWN, MALFORMED, THROW, TIMEOUT): each fails closed: no read-back, nothing sent to Jobber, no text, no email, a person follows up', async () => {
  const cases: Array<[string, (a: AddressToValidate) => Promise<unknown>, string, Record<string, unknown>, number?]> = [
    ['zip does not fit the state', async () => ({ status: 'mismatch', field: 'zip_state' }), 'ADDRESS_UNVERIFIED', { status: 'mismatch', field: 'zip_state', attempt: 1 }],
    ['zip does not fit the city', async () => ({ status: 'mismatch', field: 'zip_city' }), 'ADDRESS_UNVERIFIED', { status: 'mismatch', field: 'zip_city', attempt: 1 }],
    ['unknown', async () => ({ status: 'unknown' }), 'ADDRESS_UNVERIFIED', { status: 'unknown', attempt: 1 }],
    ['a mismatch with no known field', async () => ({ status: 'mismatch', field: 'whatever' }), 'ADDRESS_UNVERIFIED', { status: 'malformed', attempt: 1 }],
    ['a malformed answer', async () => 'valid', 'ADDRESS_UNVERIFIED', { status: 'malformed', attempt: 1 }],
    ['no answer value', async () => undefined, 'ADDRESS_UNVERIFIED', { status: 'error', attempt: 1 }],
    ['the checker throws', async () => { throw new Error('checker down'); }, 'ADDRESS_UNVERIFIED', { status: 'error', attempt: 1 }],
    ['the checker never answers', () => new Promise<unknown>(() => undefined), 'ADDRESS_UNVERIFIED', { status: 'timeout', attempt: 1 }, 40],
  ];
  for (const [label, validate, reason, row, ms] of cases) {
    const t = build({ emails: 'accept', validate, ...(ms === undefined ? {} : { validateMs: ms }) });
    t.h.serve(t.c.transport); await toTexts(t.c); await finish(t.c);
    assert.equal(t.last().reason, reason, label); assert.equal(t.last().booked, false, label);
    assert.equal(t.booked.length, 0, label + ': nothing sent to Jobber'); assert.equal(t.texts.length, 0, label + ': no text'); assert.equal(bookingMails(t).length, 0, label + ': no email');
    assert.ok(!t.c.lines.some((l) => /^To confirm/.test(l)), label + ': nothing was read back');
    assert.deepEqual(t.logs.filter(([k]) => k === 'FAST_ADDRESS_VALIDATE').map(([, v]) => v), [row], label);
    noPersonalDetail(t.logs, ['Lane']);
  }
});

test('ADDRESS CHECK (MISMATCH ON THE STREET, THEN A CORRECTION): the caller is asked once for the street, hears it spelled, and the corrected address is checked AGAIN before the read-back; the booking carries the corrected, validated street', async () => {
  const asked: AddressToValidate[] = [];
  const t = build({ validate: async (a) => { asked.push(a); return a.street === '123 Invented Lane' ? { status: 'mismatch', field: 'street' } : { status: 'valid' }; } });
  t.h.serve(t.c.transport); await toTexts(t.c);
  await t.c.hears(/^Sorry, I could not match that address[.] Please say the street address again/, '456 Sample Street');
  assert.ok(!t.c.lines.some((l) => /^To confirm/.test(l)), 'nothing is read back before the corrected street is confirmed and checked');
  await t.c.hears(/^I have 456 Sample Street, house number 4 5 6, street spelled S A M P L E, S T R E E T[.]/, 'yes');
  const readback = await t.c.hears(/To confirm/, 'yes'); assert.match(readback, /at 456 Sample Street, house number 4 5 6/);
  await finish(t.c);
  assert.deepEqual(asked.map((a) => a.street), ['123 Invented Lane', '456 Sample Street'], 'the corrected address is checked again');
  assert.deepEqual(t.booked.map((r) => r.address.street1), ['456 Sample Street']); assert.equal(t.last().booked, true);
  assert.deepEqual(t.logs.filter(([k]) => k === 'FAST_ADDRESS_VALIDATE').map(([, v]) => v), [{ status: 'mismatch', field: 'street', attempt: 1 }, { status: 'valid', attempt: 2 }]);
  noPersonalDetail(t.logs, ['Lane', 'Sample']);
});

test('ADDRESS CHECK (HOUSE NUMBER MISMATCH, CORRECTED VERDICT): a house-number mismatch, or a checker that would CHANGE the address, asks for the street once; a second failure ends the call with nothing booked (a corrected address is never booked silently)', async () => {
  for (const [label, first] of [['house number', { status: 'mismatch', field: 'house_number' }], ['corrected', { status: 'corrected' }]] as Array<[string, unknown]>) {
    const t = build({ emails: 'accept', validate: async () => first });
    t.h.serve(t.c.transport); await toTexts(t.c);
    await t.c.hears(/^Sorry, I could not match that address/, '456 Sample Street');
    await t.c.hears(/^I have 456 Sample Street/, 'yes'); await finish(t.c);
    assert.equal(t.last().reason, 'ADDRESS_UNVERIFIED', label); assert.equal(t.booked.length, 0, label); assert.equal(bookingMails(t).length, 0, label); assert.equal(t.texts.length, 0, label);
    assert.ok(!t.c.lines.some((l) => /^To confirm/.test(l)), label + ': never read back');
    assert.equal(t.logs.filter(([k]) => k === 'FAST_ADDRESS_VALIDATE').length, 2, label + ': checked twice, no more');
    noPersonalDetail(t.logs, ['Lane', 'Sample']);
  }
});

test('ADDRESS CHECK (BOOKING BLOCK): a read-back "no" that corrects the street makes the old verdict worthless: the new street is checked, a failing check ends the call, and what was booked is never an address the checker did not call valid', async () => {
  const asked: string[] = [];
  const t = build({ emails: 'accept', validate: async (a) => { asked.push(a.street); return a.street === '123 Invented Lane' ? { status: 'valid' } : { status: 'mismatch', field: 'street' }; } });
  t.h.serve(t.c.transport); await toTexts(t.c);
  await t.c.hears(/To confirm/, 'no'); await t.c.hears(/Which part is wrong/, 'the address');
  await t.c.hears(/Please say the street address again/, '456 Sample Street'); await t.c.hears(/^I have 456 Sample Street/, 'yes');
  await t.c.hears(/^Sorry, I could not match that address/, '789 Other Road'); await t.c.hears(/^I have 789 Other Road/, 'yes'); await finish(t.c);
  assert.deepEqual(asked, ['123 Invented Lane', '456 Sample Street', '789 Other Road']);
  assert.equal(t.booked.length, 0, 'the first street was valid but the caller changed it; the later ones failed'); assert.equal(t.last().reason, 'ADDRESS_UNVERIFIED'); assert.equal(bookingMails(t).length, 0);
});

test('ADDRESS CHECK (NOT ASKED FOR AN UNUSABLE ADDRESS): an address the shape guard already refuses never reaches the checker', async () => {
  let calls = 0;
  const t = build({ validate: async () => { calls++; return { status: 'valid' }; } });
  t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented');
  await t.c.hears(/Is that right[?] Say yes or no/, 'yes'); await t.c.hears(/street address/, 'forty two Woodland Hills Drive, Testville, CA 90210');
  await t.c.hears(/What day and time/, 'Tuesday at ten'); await t.c.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  await t.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await t.c.hears(/calling from a number ending in/, 'yes'); await t.c.hears(/May we send you one automated/, 'yes'); await finish(t.c);
  assert.equal(calls, 0); assert.equal(t.last().reason, 'ADDRESS_INVALID'); assert.equal(t.booked.length, 0);
});

// ---------------------------------------------------------------- M1: the owner's follow-up notice (an ending that tells the caller "a person will ..." sends the OWNER one fixed email)
const notices = (t: ReturnType<typeof build>) => t.mails.filter((m) => m.subject === FOLLOW_UP_SUBJECT);
const FOLLOW_UP_LINES: RegExp[] = [/^A Drew Cleaning DEMO call ended without completing the request, and it needs a follow-up\. Nobody else has been told\.$/, /^$/, /^Reason code: [A-Z][A-Z0-9_]{2,47}$/, /^Callback number: (\(555\) 010-\d{4}|not available)$/, /^Call ended: [A-Za-z0-9:, ]+$/, /^Call SID: CA[0-9a-f]{32}$/,
  /^Steps reached: ([A-Z][A-Z0-9_]{2,47})(, [A-Z][A-Z0-9_]{2,47})*$|^Steps reached: none$/, /^(Check Jobber \(the Developer Test Account\): the booking request was sent, so a job may exist even though it was not verified\.|No booking was sent to Jobber\.)$/,
  /^This notice holds no name, address or anything else the caller said\.$/, /^Sent by .+\. This address was approved for this test only\.$/];

test('M1: an ending that promised a person sends the owner ONE fixed notice: the reason code, the time, the callback number and the steps reached; nothing else', async () => {
  const t = build({ textsEnabled: false, emails: 'accept', book: () => ({ status: 'uncertain', reason: 'READBACK_MISMATCH', writes: 2 }) }); await toBooked(t);
  assert.equal(t.last().reason, 'BOOKING_NOT_VERIFIED'); assert.equal(t.c.lines.at(-1), 'I could not confirm the booking. Your request is recorded. Goodbye.');
  assert.deepEqual(t.mails.map((m) => [m.role, m.subject]), [['owner', FOLLOW_UP_SUBJECT]], 'one email, to the owner role only, and no booking email');
  const lines = t.mails[0].text.split('\n');
  assert.ok(lines.includes('Reason code: BOOKING_NOT_VERIFIED')); assert.ok(lines.includes('Callback number: (555) 010-0002'));
  assert.ok(lines.some((l) => /^Call ended: Monday, November 2, 2026 at 9:00 AM Central$/.test(l)), 'the time of the call, in the business zone');
  assert.ok(lines.some((l) => l.startsWith('Steps reached: ') && /CALLER_VERIFIED/.test(l) && /BOOKING_UNCERTAIN/.test(l)), 'the steps, in order');
  assert.ok(lines.includes('Check Jobber (the Developer Test Account): the booking request was sent, so a job may exist even though it was not verified.'), 'the request had been sent');
  for (const l of lines) assert.ok(FOLLOW_UP_LINES.some((re) => re.test(l)), `an unexpected line: ${l}`);
  assert.deepEqual(t.logs.filter(([c]) => c === 'FAST_FOLLOWUP').map(([, d]) => d), [{ owner: 'accepted', reason: 'BOOKING_NOT_VERIFIED' }]);
  assert.deepEqual([t.last().customerEmail, t.last().ownerEmail], [undefined, undefined], 'the outcome carries no booking-email verdict');
});

test('M1: every kind of promised ending sends exactly one notice, and one that never reached Jobber says so', async () => {
  const cases: Array<[string, () => Promise<ReturnType<typeof build>>, string, boolean]> = [
    ['the calendar cannot be read', async () => { const t = build({ textsEnabled: false, emails: 'accept', busy: { busy: [], complete: false } }); t.h.serve(t.c.transport); await toOffer(t.c); await finish(t.c); return t; }, 'CALENDAR_UNREADABLE', false],
    ['a field the call cannot change', async () => { const t = build({ textsEnabled: false, emails: 'accept' }); await toReadback(t); await t.c.hears(/To confirm/, 'no'); await t.c.hears(/Which part is wrong/, 'my name'); await finish(t.c); return t; }, 'FIELD_NOT_SUPPORTED', false],
    ['two answers that are not a state', async () => { const t = build({ emails: 'accept' }); t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented'); await t.c.hears(/Is that right\? Say yes or no/, 'yes'); await t.c.hears(/street address/, '123 Invented Lane, Testville, 90210'); await t.c.hears(/^What state is that in\?$/, 'I do not know'); await t.c.hears(/^Sorry, which state is that in\?$/, 'banana'); await finish(t.c); return t; }, 'STATE_UNCLEAR', false],
    ['the booking request was sent and not verified', async () => { const t = build({ textsEnabled: false, emails: 'accept', book: () => ({ status: 'uncertain', reason: 'NOT_FOUND', writes: 1 }) }); await toBooked(t); return t; }, 'BOOKING_NOT_VERIFIED', true],
  ];
  for (const [label, run, reason, sent] of cases) {
    const t = await run(); await t.h.idle();
    assert.equal(t.last().reason, reason, label); assert.equal(notices(t).length, 1, `${label}: one notice`); assert.equal(t.mails.length, 1, `${label}: and nothing else`); assert.equal(t.mails[0].role, 'owner', label);
    const lines = t.mails[0].text.split('\n'); assert.ok(lines.includes(`Reason code: ${reason}`), label);
    assert.ok(lines.includes(sent ? 'Check Jobber (the Developer Test Account): the booking request was sent, so a job may exist even though it was not verified.' : 'No booking was sent to Jobber.'), label);
    assert.equal(t.booked.length, sent ? 1 : 0, label);
  }
});

test('M1: endings that promised nothing, and a booked call, send no notice: a declined read-back, a stranger, a hang-up and a verified booking', async () => {
  const declined = build({ textsEnabled: false, emails: 'accept' }); await toReadback(declined); await declined.c.hears(/To confirm/, 'no'); await declined.c.hears(/Which part is wrong/, 'never mind'); await finish(declined.c); await declined.h.idle();
  assert.equal(declined.last().reason, 'DECLINED_AT_READBACK'); assert.equal(declined.mails.length, 0);
  const stranger = build({ textsEnabled: false, emails: 'accept', caller: STRANGER }); stranger.h.serve(stranger.c.transport); stranger.c.setup(DREW, undefined, 'Testa Invented'); await finish(stranger.c); await stranger.h.idle();
  assert.equal(stranger.last().reason, 'NOT_APPROVED'); assert.equal(stranger.mails.length, 0);
  const hung = build({ textsEnabled: false, emails: 'accept' }); hung.h.serve(hung.c.transport); hung.c.setup(DREW, undefined, 'Testa Invented'); await hung.c.hears(/Is that right\? Say yes or no/, 'yes'); await hung.c.hears(/street address/, undefined); hung.c.hangUp(); await sleep(60); await hung.h.idle();
  assert.equal(hung.last().reason, 'CALLER_HUNG_UP'); assert.equal(hung.mails.length, 0);
  const ok = build({ textsEnabled: false, emails: 'accept' }); await toBooked(ok); await ok.h.idle();
  assert.equal(ok.last().reason, 'BOOKED'); assert.deepEqual(ok.mails.map((m) => m.role).sort(), ['customer', 'owner']); assert.equal(notices(ok).length, 0, 'a booked call sends its two booking emails and no follow-up notice');
  assert.ok(!ok.logs.some(([c]) => c === 'FAST_FOLLOWUP'));
});

test('M1: once only: a call sends at most one notice, however it ends: more words, a hang-up or a second close after the ending change nothing, and each call has its own', async () => {
  const t = build({ textsEnabled: false, emails: 'accept', maxCalls: 5 }); await toReadback(t); await t.c.hears(/To confirm/, 'no'); await t.c.hears(/Which part is wrong/, 'the day and time'); await finish(t.c);
  t.c.emit({ kind: 'utterance', text: 'yes' }); t.c.emit({ kind: 'utterance', text: 'the time' }); t.c.hangUp(); t.c.transport.close(1000); await sleep(60); await t.h.idle();
  assert.equal(t.last().reason, 'FIELD_NOT_SUPPORTED'); assert.equal(notices(t).length, 1); assert.equal(t.logs.filter(([c]) => c === 'FAST_FOLLOWUP').length, 1); assert.equal(t.outcomes.length, 1, 'one outcome');
  // a second call on the same handler has its own single notice
  const second = fakeCarrier(); t.h.serve(second.transport); second.setup(DREW, undefined, 'Testa Invented');
  await second.hears(/Is that right\? Say yes or no/, 'yes'); await second.hears(/street address/, '123 Invented Lane, Testville, 90210'); await second.hears(/^What state is that in\?$/, 'I do not know'); await second.hears(/^Sorry, which state is that in\?$/, 'banana');
  await second.drain(() => second.ended > 0 && second.closed > 0, 'the second call to end'); await sleep(40); await t.h.idle();
  assert.equal(notices(t).length, 2, 'one notice per call'); assert.equal(t.logs.filter(([c]) => c === 'FAST_FOLLOWUP').length, 2);
});

test('M1: a refused, failing or silent mail server changes nothing about the ending: the same spoken line, the same outcome, the call still ends at once, and the notice never blocks', async () => {
  for (const mode of ['refuse', 'throw', 'hang'] as const) {
    const t = build({ textsEnabled: false, emails: mode, followUpMs: 150, book: () => ({ status: 'uncertain', reason: 'READBACK_MISMATCH', writes: 2 }) });
    const began = Date.now(); await toBooked(t); const ended = Date.now() - began;
    assert.equal(t.last().reason, 'BOOKING_NOT_VERIFIED', mode); assert.equal(t.c.lines.at(-1), 'I could not confirm the booking. Your request is recorded. Goodbye.', mode); assert.equal(t.c.ended, 1, mode); assert.equal(t.c.closed, 1, mode);
    if (mode === 'hang') { assert.ok(!t.logs.some(([c]) => c === 'FAST_FOLLOWUP'), 'the call ended while the notice was still pending'); assert.ok(ended < 1000, `the call did not wait for the mail (${ended} ms)`); }
    await t.h.idle();
    assert.deepEqual(t.logs.filter(([c]) => c === 'FAST_FOLLOWUP').map(([, d]) => (d as { owner: string }).owner), [mode === 'refuse' || mode === 'throw' ? 'refused' : 'timeout'], mode);
    assert.equal(t.mails.length, 1, mode); assert.equal(t.booked.length, 1, 'the booking request is not repeated');
  }
});

test('M1: off unless test emails are on: no notice is built or sent, and the log has no follow-up row', async () => {
  const off = build({ textsEnabled: false, book: () => ({ status: 'uncertain', reason: 'READBACK_MISMATCH', writes: 2 }) }); await toBooked(off); await off.h.idle();
  assert.equal(off.last().reason, 'BOOKING_NOT_VERIFIED'); assert.equal(off.mails.length, 0); assert.ok(!off.logs.some(([c]) => c === 'FAST_FOLLOWUP'));
  assert.ok(!('customerEmail' in off.last()) && !('ownerEmail' in off.last()));
  // the switch is off but a sender exists behind it: still nothing is sent
  const sw = build({ textsEnabled: false, emails: 'accept', emailsOff: true, book: () => ({ status: 'uncertain', reason: 'READBACK_MISMATCH', writes: 2 }) }); await toBooked(sw); await sw.h.idle();
  assert.equal(sw.last().reason, 'BOOKING_NOT_VERIFIED'); assert.equal(sw.mails.length, 0); assert.ok(!sw.logs.some(([c]) => c === 'FAST_FOLLOWUP'));
});

test('M1 privacy: the notice and the log hold no name, address, ZIP, price, day or spoken word; the callback number is in the body only, the sender is the owner role, and the subject is fixed', async () => {
  const t = build({ textsEnabled: false, emails: 'accept', book: () => ({ status: 'uncertain', reason: 'READBACK_MISMATCH', writes: 2 }) }); await toBooked(t); await t.h.idle();
  const m = t.mails[0]; const all = `${m.subject}\n${m.text}`;
  for (const s of ['Testa', 'Invented', 'Testville', '90210', '123', 'Lane', '199', 'Tuesday', 'November 3', '10:00', '5550100002', '+1555', 'Standard cleaning', 'Jobber job #', 'Name:', 'Where:', 'Price:']) assert.ok(!all.includes(s), `the notice must not hold: ${s}`);
  assert.equal(m.subject, FOLLOW_UP_SUBJECT); assert.ok(!/\(555\)|010-/.test(m.subject), 'no number in the subject'); assert.ok(m.text.includes('(555) 010-0002'), 'the callback number is in the body');
  const logAll = JSON.stringify(t.logs); assert.ok(!logAll.includes('(555)') && !logAll.includes('010-0002')); noPersonalDetail(t.logs);
  assert.deepEqual(t.logs.find(([c]) => c === 'FAST_FOLLOWUP')?.[1], { owner: 'accepted', reason: 'BOOKING_NOT_VERIFIED' }, 'the log row holds two fixed words');
  assert.ok(!t.texts.some((x) => /follow/i.test(x.body)), 'no text is involved');
});

test('M1 callback number: the number the caller gave and confirmed is the one in the notice, not the caller ID', async () => {
  const b = build({ textsEnabled: false, emails: 'accept', book: () => ({ status: 'uncertain', reason: 'READBACK_MISMATCH', writes: 2 }) }); b.h.serve(b.c.transport); await toOffer(b.c);
  await b.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await b.c.hears(/calling from a number ending in/, 'no'); await b.c.hears(/What is the best number/, 'five five five zero one');
  await b.c.hears(/remaining 5 digits/, 'zero zero zero nine nine'); await b.c.hears(/I heard/, 'yes'); await b.c.hears(/To confirm/, 'yes'); await finish(b.c); await b.h.idle();
  assert.equal(b.last().reason, 'BOOKING_NOT_VERIFIED'); assert.ok(notices(b)[0].text.split('\n').includes('Callback number: (555) 010-0099')); assert.ok(!notices(b)[0].text.includes('010-0002'));
});

test('M1 source guard: the notice is built from a short fixed list, sent to the owner role only, from the one place a call ends, and never from what the caller said', () => {
  const src = readFileSync(new URL('../src/fast-call-handler.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const fn = /function sendOwnerNotice[\s\S]*?\r?\n    \}\r?\n/.exec(src)?.[0] ?? ''; assert.ok(fn.length > 200, 'the function was found');
  assert.ok(!/firstName|lastName|heard|contact\.|street|zip|\bp\.|offer|pref|size|price|confirmed/i.test(fn.replace(/priceDollars/g, '')), 'no caller-given value is read');
  assert.ok(/send\('owner', msg\.subject, msg\.text\)/.test(fn) && !/'customer'/.test(fn), 'the owner role only');
  assert.equal([...src.matchAll(/notifyFollowUp\(/g)].length, 3, 'defined once and called from end(): when the call ends and when an ending is reached after a hang-up');
  assert.equal([...src.matchAll(/sendOwnerNotice\(/g)].length, 4, 'defined once and called from the promise check, from the skipped booking and from the speaker failure');
  assert.ok(/deps\.onOutcome\?\.\(\{ reason, booked, customerText: 'not_sent', ownerText: 'not_sent', steps, \.\.\.\(lead === undefined \? \{\} : \{ lead \}\), \.\.\.extra \}\);\r?\n\s+notifyFollowUp\(reason, line, booked\);/.test(src), 'called from end(), after the outcome, with the ORIGINAL words (what the ending meant), not the words that were spoken');
});

// ---------------------------------------------------------------- M2: the caller hangs up while the Jobber booking is pending
const gate = <T>() => { let res!: (v: T) => void; let rej!: (e: unknown) => void; const p = new Promise<T>((a, b) => { res = a; rej = b; }); return { p, res, rej }; };
/** The caller's side up to "yes" at the read-back; returns once the booking request has reached the (held) booking adapter. */
async function toPendingWrite(t: ReturnType<typeof build>, texts = false): Promise<void> {
  t.h.serve(t.c.transport); await toOffer(t.c);
  await t.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await t.c.hears(/calling from a number ending in/, 'yes');
  if (texts) await t.c.hears(/May we send you one automated/, 'yes');
  await t.c.hears(/To confirm/, 'yes'); await t.c.until(() => t.booked.length === 1, 'the booking request');
}
const OK_RESULT: BookingResult = { status: 'booked_verified', jobId: 'JOB-1', jobNumber: 1001, writes: 2 };
const row = (t: ReturnType<typeof build>, code: string): unknown => t.logs.find(([c]) => c === code)?.[1];
const outcomes = (t: ReturnType<typeof build>): Array<[string, boolean]> => t.outcomes.map((o) => [o.reason, o.booked]);

test('M2 verified after the hang-up: the booking is recorded as booked (after the hang-up outcome), the two booking emails go out once, nothing is spoken and no text is sent, even with texts on', async () => {
  for (const texts of [false, true]) {
    const g = gate<BookingResult>(); const t = build({ textsEnabled: texts, emails: 'accept', book: () => g.p });
    await toPendingWrite(t, texts); const spokenBefore = t.c.lines.length; t.c.hangUp(); g.res(OK_RESULT); await t.h.idle();
    assert.deepEqual(outcomes(t), [['CALLER_HUNG_UP', false], ['BOOKED', true]], `texts ${texts}`); assert.equal(t.booked.length, 1);
    assert.deepEqual(row(t, 'FAST_BOOKING_AFTER_HANGUP'), { status: 'booked_verified', verified: true });
    assert.deepEqual(t.mails.map((m) => m.role).sort(), ['customer', 'owner']); assert.equal(notices(t).length, 0, 'a booked call sends no follow-up notice');
    assert.equal(t.c.lines.length, spokenBefore, 'nothing was spoken after the hang-up'); assert.equal(t.texts.length, 0, 'no text to a caller who has gone');
    assert.deepEqual([t.last().customerEmail, t.last().ownerEmail, t.last().customerText, t.last().ownerText], ['accepted', 'accepted', 'skipped', 'skipped']);
    if (texts) assert.deepEqual(row(t, 'FAST_TEXTS_SKIPPED'), { reason: 'CALLER_HUNG_UP' });
    assert.equal(t.logs.filter(([c]) => c === 'FAST_END').length, 2, 'the hang-up and the late ending'); assert.equal(t.h.active(), 0); noPersonalDetail(t.logs);
  }
});

test('M2 not verified after the hang-up (uncertain, refused after a write, or an error): the owner is told once that a job may exist, no booking email is sent, and the outcome says not booked', async () => {
  const cases: Array<[string, (g: ReturnType<typeof gate<BookingResult>>) => void]> = [
    ['uncertain', (g) => g.res({ status: 'uncertain', reason: 'READBACK_MISMATCH', writes: 2 })],
    ['not found', (g) => g.res({ status: 'uncertain', reason: 'NOT_FOUND', jobId: 'JOB-9', writes: 2 })],
    ['refused after a client was written', (g) => g.res({ status: 'refused', reason: 'JOBBER_REFUSED', writes: 1 })],
    ['the adapter throws', (g) => g.rej(new Error('adapter down'))],
    ['a verified result that still names a differing field', (g) => g.res({ ...OK_RESULT, mismatches: ['street'] })],
  ];
  for (const [label, settle] of cases) {
    const g = gate<BookingResult>(); const t = build({ textsEnabled: false, emails: 'accept', book: () => g.p });
    await toPendingWrite(t); t.c.hangUp(); settle(g); await t.h.idle();
    assert.deepEqual(outcomes(t), [['CALLER_HUNG_UP', false], ['BOOKING_NOT_VERIFIED', false]], label);
    assert.deepEqual(t.mails.map((m) => [m.role, m.subject]), [['owner', FOLLOW_UP_SUBJECT]], `${label}: one owner notice and no booking email`);
    const lines = t.mails[0].text.split('\n'); assert.ok(lines.includes('Reason code: BOOKING_NOT_VERIFIED'), label); assert.ok(lines.includes('Check Jobber (the Developer Test Account): the booking request was sent, so a job may exist even though it was not verified.'), label);
    for (const l of lines) assert.ok(FOLLOW_UP_LINES.some((re) => re.test(l)), `${label}: an unexpected line: ${l}`);
    assert.equal((row(t, 'FAST_BOOKING_AFTER_HANGUP') as { verified: boolean }).verified, false, label); assert.equal(t.logs.filter(([c]) => c === 'FAST_FOLLOWUP').length, 1, label);
    assert.equal(t.booked.length, 1, `${label}: the request is never repeated`); assert.equal(t.texts.length, 0); noPersonalDetail(t.logs);
  }
});

test('M2 refused before any write (nothing can exist): the owner notice says no booking was sent', async () => {
  const g = gate<BookingResult>(); const t = build({ textsEnabled: false, emails: 'accept', book: () => g.p });
  await toPendingWrite(t); t.c.hangUp(); g.res({ status: 'refused', reason: 'WRITES_OFF', writes: 0 }); await t.h.idle();
  assert.deepEqual(outcomes(t), [['CALLER_HUNG_UP', false], ['BOOKING_NOT_VERIFIED', false]]); assert.equal(t.mails.length, 1);
  assert.ok(t.mails[0].text.split('\n').includes('No booking was sent to Jobber.'));
});

test('M2 hang-up before the write begins: nothing is written, the owner is told that no booking was made, and the booking emails are never sent', async () => {
  const hold = gate<void>(); const t = build({ textsEnabled: false, emails: 'accept', busyHold: hold.p });
  t.h.serve(t.c.transport); await toOffer(t.c); await t.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await t.c.hears(/calling from a number ending in/, 'yes'); await t.c.hears(/To confirm/, 'yes');
  await t.c.until(() => t.busyCalls() >= 2, 'the last availability check'); t.c.hangUp(); hold.res(); await t.h.idle();
  assert.equal(t.booked.length, 0, 'the booking adapter was never called'); assert.ok(!t.logs.some(([c]) => c === 'FAST_BOOKING'));
  assert.deepEqual(row(t, 'FAST_BOOKING_SKIPPED'), { reason: 'CALLER_HUNG_UP' }); assert.deepEqual(outcomes(t), [['CALLER_HUNG_UP', false], ['BOOKING_SKIPPED_HUNG_UP', false]]);
  assert.deepEqual(t.mails.map((m) => [m.role, m.subject]), [['owner', FOLLOW_UP_SUBJECT]]); const lines = t.mails[0].text.split('\n');
  assert.ok(lines.includes('Reason code: BOOKING_SKIPPED_HUNG_UP')); assert.ok(lines.includes('No booking was sent to Jobber.')); assert.equal(t.logs.filter(([c]) => c === 'FAST_FOLLOWUP').length, 1); noPersonalDetail(t.logs);
});

test('M2 duplicate: a result Jobber reports as already booked, after a hang-up, writes nothing new and sends no second email', async () => {
  const g = gate<BookingResult>(); const t = build({ textsEnabled: false, emails: 'accept', book: () => g.p });
  await toPendingWrite(t); t.c.hangUp(); g.res({ ...OK_RESULT, writes: 0, duplicate: true }); await t.h.idle();
  assert.equal(t.booked.length, 1); assert.equal(t.mails.length, 0); assert.equal(t.texts.length, 0); assert.deepEqual(row(t, 'FAST_BOOKING_DUPLICATE'), { status: 'booked_verified' }); assert.deepEqual(outcomes(t), [['CALLER_HUNG_UP', false], ['ALREADY_BOOKED', true]]);
});

// ================================================================ Slice B: the booking identity from the confirmed callback number; duplicates and identity errors
/** The whole call with texts ON: the caller also says yes to the text permission, so a customer text WOULD be sent unless the ending stops it. */
async function toBookedWithTexts(t: ReturnType<typeof build>): Promise<void> {
  t.h.serve(t.c.transport); await toOffer(t.c);
  await t.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await t.c.hears(/calling from a number ending in/, 'yes'); await t.c.hears(/May we send you one automated/, 'yes'); await t.c.hears(/To confirm/, 'yes'); await finish(t.c);
}
const BAD_RESULTS: Array<[string, BookingResult]> = [
  ['an uncertain duplicate (the read-back did not match)', { status: 'uncertain', reason: 'READBACK_MISMATCH', mismatches: ['price'], writes: 0, duplicate: true, jobId: 'JOB-1' }],
  ['an uncertain duplicate (the job cannot be found)', { status: 'uncertain', reason: 'NOT_FOUND', writes: 0, duplicate: true, jobId: 'JOB-1' }],
  ['a "verified" duplicate that still names a differing field', { status: 'booked_verified', jobId: 'JOB-1', writes: 0, duplicate: true, mismatches: ['visit_time'] }],
  ['a "verified" duplicate with no job id', { status: 'booked_verified', writes: 0, duplicate: true }],
  ['a verified booking with no job id', { status: 'booked_verified', writes: 2 }],
  ['IDENTITY_UNAVAILABLE', { status: 'not_booked', reason: 'IDENTITY_UNAVAILABLE', writes: 0 }],
  ['IDENTITY_STALE before any write', { status: 'not_booked', reason: 'IDENTITY_STALE', writes: 0 }],
  ['IDENTITY_STALE after a write', { status: 'uncertain', reason: 'IDENTITY_STALE', writes: 1 }],
  ['an uncertain retired-key result', { status: 'uncertain', reason: 'DUPLICATE_MARKERS', writes: 0 }],
];
test('only a VERIFIED duplicate with its job id is ALREADY_BOOKED: every uncertain, mismatching, job-less or identity-error result ends BOOKING_NOT_VERIFIED - nothing is texted or confirmed by email, nothing is said that sounds booked, the request is recorded', async () => {
  for (const [label, result] of BAD_RESULTS) {
    const t = build({ textsEnabled: true, emails: 'accept', book: () => result }); await toBookedWithTexts(t); await t.h.idle(); assert.equal(t.consents.length, 1, label + ': the caller did give the text permission');
    assert.equal(t.last().reason, 'BOOKING_NOT_VERIFIED', label); assert.equal(t.last().booked, false, label); assert.equal(t.texts.length, 0, label);
    assert.equal(t.c.lines.at(-1), 'I could not confirm the booking. Your request is recorded. Goodbye.', label);
    assert.ok(!t.mails.some((m) => m.role === 'customer'), label + ': no email to the customer'); assert.ok(!t.logs.some(([c]) => /^FAST_(EMAILS_SENT|TEXTS_SENT|BOOKING_DUPLICATE)$/.test(c)), label);
  }
});

test('two DIFFERENT bookings in one process are each emailed: the guard is the verified job, not a shared key (no identity request has a key)', async () => {
  let n = 0; const t = build({ textsEnabled: false, emails: 'accept', book: () => ({ status: 'booked_verified', jobId: `JOB-${++n}`, jobNumber: 1000 + n, writes: 2 }) }); await toBooked(t);
  assert.equal(t.mails.length, 2);
  const again = fakeCarrier(); t.h.serve(again.transport); again.setup(DREW, undefined, 'Testa Invented');
  await again.hears(/Is that right\? Say yes or no/, 'yes'); await again.hears(/street address/, '123 Invented Lane, Testville, CA 90210'); await again.hears(/What day and time/, 'Tuesday at ten'); await again.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  await again.hears(/is one hundred ninety-nine dollars/, 'yes'); await again.hears(/calling from a number ending in/, 'yes'); await again.hears(/To confirm/, 'yes'); await finish(again);
  assert.equal(t.mails.length, 4, 'the second booking (another job) is emailed too'); assert.ok(!t.logs.some(([c]) => c === 'FAST_EMAILS_SKIPPED'));
});

test('the identity phone is the CONFIRMED callback number: a different number the caller gave is the booking phone and the identity phone, and the two always agree', async () => {
  const n = build({ textsEnabled: false }); n.h.serve(n.c.transport); await toOffer(n.c); await n.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await n.c.hears(/calling from/, 'no');
  await n.c.hears(/best number/, 'five five five zero one zero zero zero zero four'); await n.c.hears(/I heard/, 'yes'); await n.c.hears(/To confirm/, 'yes'); await finish(n.c);
  const r = n.booked[0] as IdentityBookingRequest; assert.equal(n.booked.length, 1); assert.deepEqual([r.client.phone, r.identity.phone], ['5550100004', '5550100004']);
  assert.deepEqual(requestProblems(r, NOW), [], 'the real booking module accepts the request the handler built');
});

test('Slice B source: the handler makes no key and no hash of the Call SID, builds the identity from the booking itself, and keeps the fail-closed gates in front of it', () => {
  const src = readFileSync(new URL('../src/fast-call-handler.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/createHash|drew-fast|req\.key|node:crypto/.test(src), 'no key from the call');
  assert.ok(/identity: \{ phone: digits, date: o\.date, startTime: o\.time, street: p\.street, zip: p\.zip \}/.test(src));
  const at = (x: string): number => src.indexOf(x);
  assert.ok(at('FAST_ADDRESS_GUARD') < at('FAST_SLOT_RECHECK_FAILED') && at('FAST_SLOT_RECHECK_FAILED') < at('confirmedMismatches(confirmed, req)') && at('confirmedMismatches(confirmed, req)') < at('deps.book(req)'), 'the gates still come first');
  assert.ok(at("res.jobId === undefined) return end('BOOKING_NOT_VERIFIED'") < at("end('ALREADY_BOOKED'") && at("end('ALREADY_BOOKED'") < at('deps.sendEmail!(role') && at("end('ALREADY_BOOKED'") < at('deps.sendText(callback'), 'the duplicate ends before any email or text');
  assert.equal([...src.matchAll(/end\('ALREADY_BOOKED'/g)].length, 1);
});

test('M2 redial protection: while a booking is still being written after a hang-up the line is busy, then it is free again; a booking that never settles frees it after the bound; a normal ending frees it at once', async () => {
  const g = gate<BookingResult>(); const t = build({ textsEnabled: false, emails: 'accept', book: () => g.p });
  await toPendingWrite(t); t.c.hangUp(); assert.equal(t.h.active(), 1, 'the call keeps its slot while the booking is in flight');
  const second = fakeCarrier(); t.h.serve(second.transport); assert.equal(second.closed, 1, 'a redial is refused'); assert.deepEqual(row(t, 'FAST_REFUSED'), { reason: 'BUSY' });
  g.res(OK_RESULT); await t.h.idle(); assert.equal(t.h.active(), 0); const third = fakeCarrier(); t.h.serve(third.transport); assert.equal(third.closed, 0, 'free again once the booking settled'); third.hangUp();
  // a booking that never answers: the slot is held for at most slotHoldMs
  const stuck = build({ textsEnabled: false, emails: 'accept', slotHoldMs: 40, book: () => new Promise<BookingResult>(() => undefined) });
  await toPendingWrite(stuck); stuck.c.hangUp(); assert.equal(stuck.h.active(), 1); await sleep(160); assert.equal(stuck.h.active(), 0, 'released after the bound');
  const next = fakeCarrier(); stuck.h.serve(next.transport); assert.equal(next.closed, 0); next.hangUp();
  // a normal ending (no hang-up) frees the slot immediately, as before
  const n = build({ textsEnabled: false, emails: 'accept' }); await toBooked(n); await sleep(30); assert.equal(n.h.active(), 0); const after = fakeCarrier(); n.h.serve(after.transport); assert.equal(after.closed, 0);
});

test('M2 recovery: a failing or silent mail server after the hang-up never throws and never blocks; the outcome and the log are still written', async () => {
  for (const mode of ['throw', 'refuse', 'hang'] as const) {
    const g = gate<BookingResult>(); const t = build({ textsEnabled: false, emails: mode, followUpMs: 120, book: () => g.p });
    await toPendingWrite(t); t.c.hangUp(); g.res({ status: 'uncertain', reason: 'READBACK_MISMATCH', writes: 2 }); await t.h.idle();
    assert.deepEqual(outcomes(t), [['CALLER_HUNG_UP', false], ['BOOKING_NOT_VERIFIED', false]], mode);
    assert.deepEqual((row(t, 'FAST_FOLLOWUP') as { owner: string }).owner, mode === 'hang' ? 'timeout' : 'refused', mode); assert.equal(t.h.active(), 0, mode);
  }
});

test('M2 off by default: with test emails off the hang-up path records the outcome and sends nothing', async () => {
  const g = gate<BookingResult>(); const t = build({ textsEnabled: false, book: () => g.p });
  await toPendingWrite(t); t.c.hangUp(); g.res({ status: 'uncertain', reason: 'READBACK_MISMATCH', writes: 2 }); await t.h.idle();
  assert.deepEqual(outcomes(t), [['CALLER_HUNG_UP', false], ['BOOKING_NOT_VERIFIED', false]]); assert.equal(t.mails.length, 0); assert.ok(!t.logs.some(([c]) => c === 'FAST_FOLLOWUP'));
});

test('M2 unchanged behaviour: a hang-up before the read-back yes records only the hang-up and writes nothing; a caller who hangs up after a normal ending adds no late outcome', async () => {
  const early = build({ textsEnabled: false, emails: 'accept' }); early.h.serve(early.c.transport); early.c.setup(DREW, undefined, 'Testa Invented'); await early.c.hears(/Is that right\? Say yes or no/, 'yes'); await early.c.hears(/street address/, undefined); early.c.hangUp(); await sleep(60); await early.h.idle();
  assert.deepEqual(outcomes(early), [['CALLER_HUNG_UP', false]]); assert.equal(early.booked.length, 0); assert.equal(early.mails.length, 0);
  const normal = build({ textsEnabled: false, emails: 'accept' }); await toBooked(normal); normal.c.hangUp(); await sleep(40); await normal.h.idle();
  assert.deepEqual(outcomes(normal), [['BOOKED', true]], 'a hang-up after the call already ended adds no outcome'); assert.equal(normal.mails.length, 2);
});

test('M2 source guard: the hang-up flag is set only by a hang-up, nothing is written or texted after it, and the late ending is the one place that records and notifies', () => {
  const src = readFileSync(new URL('../src/fast-call-handler.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  assert.equal([...src.matchAll(/hungUp = true/g)].length, 2, 'set in two places only'); assert.ok(/t\.onClose = \(info\?: TransportCloseInfo\) => \{ if \(!done && info\?\.speakerDown === true\) speakerFailed\(info\.callSid\); if \(!done\) \{ done = true; hungUp = true;/.test(src), 'inside the hang-up branch (after the speaker-failure check)'); assert.ok(/function speakerFailed\(sid: unknown\): void \{ hungUp = true;/.test(src), 'and in the one speaker-failure function (the voice is gone)');
  assert.ok(src.indexOf("deps.log('FAST_BOOKING_SKIPPED'") > 0 && src.indexOf("deps.log('FAST_BOOKING_SKIPPED'") < src.indexOf('await deps.book(req)'), 'the skip comes before the booking request');
  assert.ok(src.indexOf("deps.log('FAST_TEXTS_SKIPPED', { reason: 'CALLER_HUNG_UP' })") > 0 && src.indexOf("deps.log('FAST_TEXTS_SKIPPED', { reason: 'CALLER_HUNG_UP' })") < src.indexOf('await deps.sendText(callback'), 'the text skip comes before any text');
  assert.ok(/async function book\(\): Promise<void> \{ booking = true; try \{ await bookInner\(\); \} finally \{ booking = false; releaseSlot\(\); \} \}/.test(src), 'the slot is released when the booking settles');
  assert.ok(/if \(done\) \{ if \(hungUp && !lateEnd\) \{ lateEnd = true;/.test(src), 'one late ending');
});

// ================================================================ the speaker fails (Jack is gone): the call is treated like a hang-up; nothing unsent is written, a write in flight is recorded when it settles, the slot is held until then, and the owner is told at most once
/** The speaker adapter's two signals, in order: the call logic is told, then the connection closes (1011). */
const speakerDown = (c: ReturnType<typeof fakeCarrier>): void => { c.emit({ kind: 'speaker_down' }); c.transport.close(1011); };
const nothingPersonal = (t: ReturnType<typeof build>): void => { noPersonalDetail(t.logs); for (const m of notices(t)) for (const s of ['Testa', 'Invented', 'Testville', '90210', '5550100003']) assert.ok(!m.text.includes(s) && !m.subject.includes(s), 'no caller detail in a follow-up notice: ' + s); };

test('speaker down at intake: the call ends as SPEAKER_DOWN, nothing is booked, the owner gets exactly one fixed notice (no caller words), the slot is free, and a second signal or the close changes nothing', async () => {
  const t = build({ textsEnabled: false, emails: 'accept' });
  t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented'); await t.c.hears(/Is that right\? Say yes or no/, 'yes'); await t.c.hears(/street address/, undefined);
  speakerDown(t.c); t.c.emit({ kind: 'speaker_down' }); t.c.hangUp(); await t.h.idle();
  assert.deepEqual(outcomes(t), [['SPEAKER_DOWN', false]]); assert.equal(t.booked.length, 0); assert.equal(t.texts.length, 0);
  assert.deepEqual(t.mails.map((m) => [m.role, m.subject]), [['owner', FOLLOW_UP_SUBJECT]], 'one owner notice and nothing else');
  const lines = t.mails[0].text.split('\n'); assert.ok(lines.includes('Reason code: SPEAKER_DOWN')); assert.ok(lines.includes('No booking was sent to Jobber.')); assert.deepEqual(lines.filter((l) => l.startsWith('Call SID')), ['Call SID: ' + SID], 'the call is named once');
  for (const l of lines) assert.ok(FOLLOW_UP_LINES.some((re) => re.test(l)), 'an unexpected line: ' + l);
  assert.equal(t.logs.filter(([c]) => c === 'FAST_FOLLOWUP').length, 1); assert.equal(t.h.active(), 0); nothingPersonal(t);
  assert.deepEqual(row(t, 'FAST_FOLLOWUP'), { owner: 'accepted', reason: 'SPEAKER_DOWN' });
});

test('speaker down with test emails off: the outcome is recorded, nothing is sent and nothing is logged as a notice', async () => {
  const t = build({ textsEnabled: false });
  t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented'); await t.c.hears(/Is that right\? Say yes or no/, 'yes'); speakerDown(t.c); await t.h.idle();
  assert.deepEqual(outcomes(t), [['SPEAKER_DOWN', false]]); assert.equal(t.mails.length, 0); assert.ok(!t.logs.some(([c]) => c === 'FAST_FOLLOWUP')); assert.equal(t.h.active(), 0);
});

test('speaker down while the Jobber write is in flight, verified later: the booking is recorded as booked, the two booking emails go out once, no follow-up notice, nothing more is spoken or texted, and the slot stays busy until the write settles', async () => {
  for (const texts of [false, true]) {
    const g = gate<BookingResult>(); const t = build({ textsEnabled: texts, emails: 'accept', book: () => g.p });
    await toPendingWrite(t, texts); speakerDown(t.c); const spokenBefore = t.c.lines.length;
    assert.deepEqual(outcomes(t), [['SPEAKER_DOWN', false]], 'the failure is recorded at once'); assert.equal(t.mails.length, 0, 'no notice while the write is unresolved');
    assert.equal(t.h.active(), 1, 'the slot is held while the write is unresolved');
    const redial = fakeCarrier(); t.h.serve(redial.transport); assert.equal(redial.closed, 1, 'a redial is refused'); assert.deepEqual(row(t, 'FAST_REFUSED'), { reason: 'BUSY' });
    g.res(OK_RESULT); await t.h.idle();
    assert.deepEqual(outcomes(t), [['SPEAKER_DOWN', false], ['BOOKED', true]], 'texts ' + texts); assert.equal(t.booked.length, 1, 'the request is never repeated');
    assert.deepEqual(t.mails.map((m) => m.role).sort(), ['customer', 'owner']); assert.equal(notices(t).length, 0);
    assert.equal(t.c.lines.length, spokenBefore, 'nothing spoken after the failure'); assert.equal(t.texts.length, 0, 'no text after the failure');
    assert.equal(t.h.active(), 0, 'free once settled'); const after = fakeCarrier(); t.h.serve(after.transport); assert.equal(after.closed, 0); after.hangUp(); nothingPersonal(t);
  }
});

test('speaker down while the write is in flight, not verified (uncertain, refused after a write, an error): the result is recorded, the owner is told once that a job may exist, and the request is never repeated', async () => {
  const cases: Array<[string, (g: ReturnType<typeof gate<BookingResult>>) => void, string]> = [
    ['uncertain', (g) => g.res({ status: 'uncertain', reason: 'READBACK_MISMATCH', writes: 2 }), 'Check Jobber (the Developer Test Account): the booking request was sent, so a job may exist even though it was not verified.'],
    ['refused after a client was written', (g) => g.res({ status: 'refused', reason: 'JOBBER_REFUSED', writes: 1 }), 'Check Jobber (the Developer Test Account): the booking request was sent, so a job may exist even though it was not verified.'],
    ['the adapter throws', (g) => g.rej(new Error('adapter down')), 'Check Jobber (the Developer Test Account): the booking request was sent, so a job may exist even though it was not verified.'],
    ['refused before any write', (g) => g.res({ status: 'refused', reason: 'WRITES_OFF', writes: 0 }), 'No booking was sent to Jobber.'],
  ];
  for (const [label, settle, line] of cases) {
    const g = gate<BookingResult>(); const t = build({ textsEnabled: false, emails: 'accept', book: () => g.p });
    await toPendingWrite(t); speakerDown(t.c); assert.equal(t.mails.length, 0, label + ': nothing yet'); settle(g); await t.h.idle();
    assert.deepEqual(outcomes(t), [['SPEAKER_DOWN', false], ['BOOKING_NOT_VERIFIED', false]], label);
    assert.deepEqual(t.mails.map((m) => [m.role, m.subject]), [['owner', FOLLOW_UP_SUBJECT]], label + ': one owner notice and no booking email');
    const lines = t.mails[0].text.split('\n'); assert.ok(lines.includes('Reason code: BOOKING_NOT_VERIFIED'), label); assert.ok(lines.includes(line), label);
    assert.equal(t.booked.length, 1, label); assert.equal(t.logs.filter(([c]) => c === 'FAST_FOLLOWUP').length, 1, label); assert.equal(t.h.active(), 0, label); nothingPersonal(t);
  }
});

test('speaker down before the request is sent (the last availability check still running): nothing is written, the one notice says so, and the booking emails are never sent', async () => {
  const hold = gate<void>(); const t = build({ textsEnabled: false, emails: 'accept', busyHold: hold.p });
  t.h.serve(t.c.transport); await toOffer(t.c); await t.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await t.c.hears(/calling from a number ending in/, 'yes'); await t.c.hears(/To confirm/, 'yes');
  await t.c.until(() => t.busyCalls() >= 2, 'the last availability check'); speakerDown(t.c); hold.res(); await t.h.idle();
  assert.equal(t.booked.length, 0, 'the booking adapter was never called'); assert.deepEqual(outcomes(t), [['SPEAKER_DOWN', false], ['BOOKING_SKIPPED_HUNG_UP', false]]);
  assert.deepEqual(t.mails.map((m) => [m.role, m.subject]), [['owner', FOLLOW_UP_SUBJECT]]); assert.ok(t.mails[0].text.split('\n').includes('No booking was sent to Jobber.')); assert.equal(t.h.active(), 0); nothingPersonal(t);
});

test('speaker down while a write never settles: the slot is held for at most slotHoldMs, and no booking is ever repeated (limitation: an unresolved write sends no notice)', async () => {
  const t = build({ textsEnabled: false, emails: 'accept', slotHoldMs: 40, book: () => new Promise<BookingResult>(() => undefined) });
  await toPendingWrite(t); speakerDown(t.c); assert.equal(t.h.active(), 1); await sleep(160);
  assert.equal(t.h.active(), 0, 'released after the bound'); assert.equal(t.booked.length, 1); assert.equal(t.mails.length, 0, 'documented limitation: nothing is sent while the write is still unresolved');
  assert.deepEqual(outcomes(t), [['SPEAKER_DOWN', false]]);
});

test('speaker down, as a property: at every step of the call, with the signal repeated and followed by hang-ups, there is at most one booking request, at most one owner notice, a recorded outcome, and the slot ends free', async () => {
  const cases: Array<[string, (t: ReturnType<typeof build>, g: ReturnType<typeof gate<BookingResult>>) => Promise<void>]> = [
    ['after the name prompt', async (t) => { t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented'); await t.c.until(() => t.c.lines.length > 0, 'a line'); }],
    ['at the offer', async (t) => { t.h.serve(t.c.transport); await toOffer(t.c); await t.c.hears(/is one hundred ninety-nine dollars/, undefined); }],
    ['at the read-back', async (t) => { t.h.serve(t.c.transport); await toOffer(t.c); await t.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await t.c.hears(/calling from a number ending in/, 'yes'); await t.c.hears(/To confirm/, undefined); }],
    ['write in flight, then verified', async (t, g) => { await toPendingWrite(t); setTimeout(() => g.res(OK_RESULT), 10); }],
    ['write in flight, then uncertain', async (t, g) => { await toPendingWrite(t); setTimeout(() => g.res({ status: 'uncertain', reason: 'NOT_FOUND', writes: 2 }), 10); }],
    ['write in flight, then an error', async (t, g) => { await toPendingWrite(t); setTimeout(() => g.rej(new Error('down')), 10); }],
  ];
  for (const [label, go] of cases) {
    const g = gate<BookingResult>(); const t = build({ textsEnabled: false, emails: 'accept', book: () => g.p });
    await go(t, g); speakerDown(t.c); t.c.emit({ kind: 'speaker_down' }); t.c.hangUp(); t.c.hangUp(); await sleep(60); await t.h.idle();
    assert.ok(t.booked.length <= 1, label + ': at most one booking request'); assert.ok(notices(t).length <= 1, label + ': at most one notice'); assert.equal(t.mails.filter((m) => m.role === 'customer').length <= 1, true, label);
    assert.equal(outcomes(t)[0][0], 'SPEAKER_DOWN', label); if (t.booked.length === 1) assert.ok(outcomes(t).some(([r]) => r === 'BOOKED' || r === 'BOOKING_NOT_VERIFIED'), label + ': a sent request always has its result recorded');
    assert.equal(t.h.active(), 0, label + ': the slot ends free'); nothingPersonal(t);
  }
});

test('speaker down source guard: the failure sets the hang-up flag before it ends the call, notifies at once only when no write is in flight, and the notice is guarded to once per call', () => {
  const src = readFileSync(new URL('../src/fast-call-handler.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  assert.equal([...src.matchAll(/ev\.kind === 'speaker_down'/g)].length, 1);
  assert.ok(/if \(ev\.kind === 'speaker_down'\) \{ speakerFailed\(callSid\); return; \}/.test(src), 'the live event calls the one function');
  assert.ok(/function speakerFailed\(sid: unknown\): void \{ hungUp = true; speakerSid = sidOf\(sid\) \?\? sidOf\(callSid\); if \(!booking\) sendOwnerNotice\('SPEAKER_DOWN', bookSent\); void end\('SPEAKER_DOWN'\); \}/.test(src), 'flag, the validated SID, then the guarded notice, then the end');
  assert.equal([...src.matchAll(/speakerSid = /g)].length, 1, 'the SID is set in the speaker-failure function only (behavior is pinned by the Call SID tests)');
  assert.equal([...src.matchAll(/speakerFailed\(/g)].length, 3, 'defined once, called from the live event and from the close that says the notice failed');
  assert.ok(/function sendOwnerNotice\(reason: string, mayExist: boolean\): void \{\r?\n\s+if \(noticed\) return; noticed = true;/.test(src), 'the once-per-call guard is the first statement');
  assert.equal([...src.matchAll(/noticed = true/g)].length, 1);
});

// ================================================================ the Call SID in the speaker-failure notice (and only there)
const SID = 'CA' + 'ab'.repeat(16);   // the fake carrier's default
const sidLines = (t: ReturnType<typeof build>): string[] => notices(t).flatMap((m) => m.text.split('\n').filter((l) => l.startsWith('Call SID')));
const allLinesFixed = (t: ReturnType<typeof build>): void => { for (const m of notices(t)) for (const l of m.text.split('\n')) assert.ok(FOLLOW_UP_LINES.some((re) => re.test(l)), 'an unexpected line: ' + l); };
const sidAnywhereElse = (t: ReturnType<typeof build>, sid: string): void => { assert.ok(!JSON.stringify(t.logs).includes(sid), 'the SID is not in the diagnostics'); for (const m of t.mails.filter((x) => x.subject !== FOLLOW_UP_SUBJECT)) assert.ok(!m.text.includes(sid) && !m.subject.includes(sid), 'the SID is not in a booking email'); for (const x of t.texts) assert.ok(!x.body.includes(sid)); };

test('Call SID, valid: every speaker-failure notice (at intake, with a write in flight that is not verified, and before the request is sent) names the call once, with fixed lines only and no caller detail; the SID appears nowhere else', async () => {
  // at intake
  const a = build({ textsEnabled: false, emails: 'accept' }); a.h.serve(a.c.transport); a.c.setup(DREW, SID, 'Testa Invented'); await a.c.hears(/Is that right\? Say yes or no/, 'yes'); speakerDown(a.c); await a.h.idle();
  assert.deepEqual(sidLines(a), ['Call SID: ' + SID]); allLinesFixed(a); nothingPersonal(a); sidAnywhereElse(a, SID);
  // a write in flight: the notice is deferred until the result, and still names the call
  const g = gate<BookingResult>(); const b = build({ textsEnabled: false, emails: 'accept', book: () => g.p }); await toPendingWrite(b); speakerDown(b.c);
  assert.equal(b.mails.length, 0, 'deferred'); g.res({ status: 'uncertain', reason: 'NOT_FOUND', writes: 2 }); await b.h.idle();
  assert.deepEqual(sidLines(b), ['Call SID: ' + SID]); assert.equal(notices(b).length, 1); allLinesFixed(b); nothingPersonal(b); sidAnywhereElse(b, SID);
  // before the request is sent
  const hold = gate<void>(); const c = build({ textsEnabled: false, emails: 'accept', busyHold: hold.p });
  c.h.serve(c.c.transport); await toOffer(c.c); await c.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await c.c.hears(/calling from a number ending in/, 'yes'); await c.c.hears(/To confirm/, 'yes');
  await c.c.until(() => c.busyCalls() >= 2, 'the last availability check'); speakerDown(c.c); hold.res(); await c.h.idle();
  assert.deepEqual(sidLines(c), ['Call SID: ' + SID]); assert.equal(notices(c).length, 1); allLinesFixed(c); sidAnywhereElse(c, SID);
});

test('Call SID, deferred and verified: a write that verifies after the voice failed sends no follow-up notice, so the SID is sent nowhere', async () => {
  const g = gate<BookingResult>(); const t = build({ textsEnabled: false, emails: 'accept', book: () => g.p }); await toPendingWrite(t); speakerDown(t.c); g.res(OK_RESULT); await t.h.idle();
  assert.equal(notices(t).length, 0); assert.deepEqual(sidLines(t), []); sidAnywhereElse(t, SID);
});

test('Call SID, missing or malformed (it reached the handler unchecked): the notice is still sent, once, with no Call SID line and nothing else changed', async () => {
  const bad: unknown[] = [undefined, null, '', 'CA', 'ca' + 'ab'.repeat(16), 'CA' + 'AB'.repeat(16), 'CA' + 'ab'.repeat(16) + '0', 'CA' + 'ab'.repeat(15), SID + '\nInjected: yes', ' ' + SID, 42, {}, [SID]];
  for (const x of bad) {
    const t = build({ textsEnabled: false, emails: 'accept' }); t.h.serve(t.c.transport); t.c.emit({ kind: 'setup', to: DREW, callSid: x }); t.c.emit({ kind: 'utterance', text: 'Testa Invented' });
    await t.c.hears(/Is that right\? Say yes or no/, 'yes'); speakerDown(t.c); await t.h.idle();
    assert.equal(notices(t).length, 1, JSON.stringify(x)); assert.deepEqual(sidLines(t), [], 'no SID line: ' + JSON.stringify(x)); allLinesFixed(t); assert.ok(notices(t)[0].text.split('\n').includes('Reason code: SPEAKER_DOWN'));
  }
});

test('Call SID, early: the voice fails before the caller-ID check has finished; a valid SID is named, a malformed one is not, and the call is not booked either way', async () => {
  for (const [sid, want] of [[SID, ['Call SID: ' + SID]], ['CA-not-a-sid', []]] as Array<[string, string[]]>) {
    const t = build({ textsEnabled: false, emails: 'accept' }); t.h.serve(t.c.transport); t.c.emit({ kind: 'setup', to: DREW, callSid: sid }); t.c.emit({ kind: 'speaker_down' }); t.c.transport.close(1011); await t.h.idle();
    assert.deepEqual(sidLines(t), want, sid); assert.equal(notices(t).length, 1); assert.equal(t.booked.length, 0); allLinesFixed(t); assert.deepEqual(outcomes(t), [['SPEAKER_DOWN', false]]);
  }
});

test('Call SID, other notices unchanged: a declined or unverified booking, a skipped booking after a hang-up, and a caller hang-up never name the call, even though the call has a valid SID', async () => {
  // M1: an unverified booking, no speaker failure
  const a = build({ textsEnabled: false, emails: 'accept', book: () => ({ status: 'uncertain', reason: 'READBACK_MISMATCH', writes: 2 }) }); await toBooked(a);
  assert.equal(notices(a).length, 1); assert.deepEqual(sidLines(a), []); assert.ok(!notices(a)[0].text.includes(SID)); allLinesFixed(a);
  // M2: hang-up with a write in flight, not verified
  const g = gate<BookingResult>(); const b = build({ textsEnabled: false, emails: 'accept', book: () => g.p }); await toPendingWrite(b); b.c.hangUp(); g.res({ status: 'uncertain', reason: 'NOT_FOUND', writes: 2 }); await b.h.idle();
  assert.equal(notices(b).length, 1); assert.deepEqual(sidLines(b), []); assert.ok(!notices(b)[0].text.includes(SID)); allLinesFixed(b);
  // M2: hang-up before the request is sent
  const hold = gate<void>(); const c = build({ textsEnabled: false, emails: 'accept', busyHold: hold.p });
  c.h.serve(c.c.transport); await toOffer(c.c); await c.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await c.c.hears(/calling from a number ending in/, 'yes'); await c.c.hears(/To confirm/, 'yes');
  await c.c.until(() => c.busyCalls() >= 2, 'the last availability check'); c.c.hangUp(); hold.res(); await c.h.idle();
  assert.equal(notices(c).length, 1); assert.deepEqual(sidLines(c), []); assert.ok(!notices(c)[0].text.includes(SID));
  // a caller who hangs up with nothing promised sends no notice at all
  const d = build({ textsEnabled: false, emails: 'accept' }); d.h.serve(d.c.transport); d.c.setup(DREW, SID, 'Testa Invented'); await d.c.hears(/Is that right\? Say yes or no/, 'yes'); d.c.hangUp(); await d.h.idle(); assert.equal(notices(d).length, 0);
});

// ================================================================ the speaker fails during the consent notice (the call logic never saw the call start)
const SIDN = 'CA' + '0123456789abcdef'.repeat(2);
/** The transport's close for a notice the speaker answered "failed" (its raw SID), then the connection closes. */
const noticeFailedClose = (c: ReturnType<typeof fakeCarrier>, callSid: unknown, flag: boolean = true): void => { c.transport.onClose({ cause: 'PROTOCOL', code: 1011, ...(flag ? { speakerDown: true as const, callSid } : {}) }); };
const onlyLines = (t: ReturnType<typeof build>): string[] => notices(t).flatMap((m) => m.text.split('\n'));

test('consent-phase speaker failure: the call is recorded as SPEAKER_DOWN (not a hang-up), the owner gets exactly one fixed notice with the Call SID, a number that is not available and no steps, nothing is booked, spoken or texted, and the slot is free', async () => {
  const t = build({ textsEnabled: false, emails: 'accept' }); t.h.serve(t.c.transport); assert.equal(t.h.active(), 1, 'the call holds the slot from the start');
  noticeFailedClose(t.c, SIDN); await t.h.idle();
  assert.deepEqual(outcomes(t), [['SPEAKER_DOWN', false]]); assert.equal(t.booked.length, 0); assert.equal(t.texts.length, 0); assert.equal(t.c.lines.length, 0, 'nothing spoken'); assert.equal(t.h.active(), 0);
  assert.deepEqual(t.mails.map((m) => [m.role, m.subject]), [['owner', FOLLOW_UP_SUBJECT]]);
  const lines = onlyLines(t); assert.ok(lines.includes('Reason code: SPEAKER_DOWN')); assert.ok(lines.includes('Callback number: not available')); assert.ok(lines.includes('Steps reached: none')); assert.ok(lines.includes('No booking was sent to Jobber.')); assert.deepEqual(lines.filter((l) => l.startsWith('Call SID')), ['Call SID: ' + SIDN]);
  allLinesFixed(t); nothingPersonal(t); assert.deepEqual(row(t, 'FAST_FOLLOWUP'), { owner: 'accepted', reason: 'SPEAKER_DOWN' }); assert.ok(!t.logs.some(([c, d]) => c === 'FAST_END' && (d as { reason: string }).reason === 'CALLER_HUNG_UP'));
});

test('consent-phase speaker failure, the SID: missing, malformed or hostile adds no Call SID line and the notice is still sent once', async () => {
  const bad: unknown[] = [undefined, null, '', 'CA', 'ca' + '0123456789abcdef'.repeat(2), 'CA' + '0123456789ABCDEF'.repeat(2), SIDN + '0', SIDN.slice(1), SIDN + '\nInjected: yes', ' ' + SIDN, 42, {}, [SIDN]];
  for (const x of bad) {
    const t = build({ textsEnabled: false, emails: 'accept' }); t.h.serve(t.c.transport); noticeFailedClose(t.c, x); await t.h.idle();
    assert.equal(notices(t).length, 1, JSON.stringify(x)); assert.deepEqual(sidLines(t), [], 'no SID line: ' + JSON.stringify(x)); allLinesFixed(t); assert.deepEqual(outcomes(t), [['SPEAKER_DOWN', false]]); assert.equal(t.h.active(), 0);
  }
});

test('consent-phase close that is not a speaker failure is unchanged: a caller who hangs up, a protocol close without the flag, and a flag arriving after the call already ended record the hang-up (or nothing more) and send no notice', async () => {
  const a = build({ textsEnabled: false, emails: 'accept' }); a.h.serve(a.c.transport); a.c.hangUp(); await a.h.idle();
  assert.deepEqual(outcomes(a), [['CALLER_HUNG_UP', false]]); assert.equal(a.mails.length, 0); assert.equal(a.h.active(), 0);
  const b = build({ textsEnabled: false, emails: 'accept' }); b.h.serve(b.c.transport); noticeFailedClose(b.c, SIDN, false); await b.h.idle();
  assert.deepEqual(outcomes(b), [['CALLER_HUNG_UP', false]]); assert.equal(b.mails.length, 0); assert.equal(b.h.active(), 0);
  // the flag after the call has already ended changes nothing
  const c = build({ textsEnabled: false, emails: 'accept' }); c.h.serve(c.c.transport); c.c.hangUp(); noticeFailedClose(c.c, SIDN); await c.h.idle();
  assert.deepEqual(outcomes(c), [['CALLER_HUNG_UP', false]]); assert.equal(c.mails.length, 0);
  // a call that ended normally earlier and then closes with the flag sends nothing new
  const d = build({ textsEnabled: false, emails: 'accept', caller: STRANGER }); d.h.serve(d.c.transport); d.c.setup(DREW); await d.c.drain(() => d.outcomes.length > 0, 'the refusal'); const before = d.mails.length; noticeFailedClose(d.c, SIDN); await d.h.idle();
  assert.equal(d.mails.length, before); assert.equal(d.outcomes.length, 1);
});

test('consent-phase speaker failure, repeated: more closes, a later live speaker_down and a caller hang-up give one outcome and at most one notice', async () => {
  const t = build({ textsEnabled: false, emails: 'accept' }); t.h.serve(t.c.transport);
  noticeFailedClose(t.c, SIDN); noticeFailedClose(t.c, SIDN); t.c.emit({ kind: 'speaker_down' }); t.c.hangUp(); t.c.transport.close(1011); await t.h.idle();
  assert.deepEqual(outcomes(t), [['SPEAKER_DOWN', false]]); assert.equal(notices(t).length, 1); assert.equal(t.logs.filter(([c]) => c === 'FAST_FOLLOWUP').length, 1); assert.equal(t.h.active(), 0);
});

test('consent-phase speaker failure, attempt versus delivery: the outcome is always recorded; with emails off no attempt is made; a refusing, throwing or silent mail server is one attempt whose verdict is logged, and the call still ends', async () => {
  const off = build({ textsEnabled: false }); off.h.serve(off.c.transport); noticeFailedClose(off.c, SIDN); await off.h.idle();
  assert.deepEqual(outcomes(off), [['SPEAKER_DOWN', false]]); assert.equal(off.mails.length, 0); assert.ok(!off.logs.some(([c]) => c === 'FAST_FOLLOWUP'), 'no attempt, no verdict');
  for (const [mode, verdict] of [['refuse', 'refused'], ['throw', 'refused'], ['hang', 'timeout']] as const) {
    const t = build({ textsEnabled: false, emails: mode, followUpMs: 40 }); t.h.serve(t.c.transport); noticeFailedClose(t.c, SIDN); await t.h.idle();
    assert.deepEqual(outcomes(t), [['SPEAKER_DOWN', false]], mode); assert.equal(t.mails.length, 1, mode + ': one attempt'); assert.deepEqual(row(t, 'FAST_FOLLOWUP'), { owner: verdict, reason: 'SPEAKER_DOWN' }, mode); assert.equal(t.h.active(), 0);
  }
});

test('consent-phase speaker failure, as a property: for every flag, SID value and mail mode there is exactly one outcome, at most one mail attempt, never a booking, and the slot ends free', async () => {
  let combos = 0;
  for (const flag of [true, false]) for (const sid of [SIDN, undefined, 'CA-bad', 7]) for (const mode of [undefined, 'accept', 'refuse', 'throw'] as const) {
    const t = build({ textsEnabled: false, ...(mode === undefined ? {} : { emails: mode }) }); t.h.serve(t.c.transport); noticeFailedClose(t.c, sid, flag); noticeFailedClose(t.c, sid, flag); await t.h.idle(); combos++;
    assert.equal(t.outcomes.length, 1); assert.equal(t.outcomes[0].reason, flag ? 'SPEAKER_DOWN' : 'CALLER_HUNG_UP'); assert.ok(t.mails.length <= (flag && mode !== undefined ? 1 : 0)); assert.equal(t.booked.length, 0); assert.equal(t.h.active(), 0);
  }
  assert.equal(combos, 2 * 4 * 4);
});

test('consent-phase speaker failure, end to end through the real transport and bridge: the speaker answers the notice "failed", the handler records SPEAKER_DOWN and sends one notice with the carrier\'s SID; a silent notice is a plain hang-up with no notice', async () => {
  for (const [how, reason, mails] of [['fail', 'SPEAKER_DOWN', 1], ['silent', 'CALLER_HUNG_UP', 0]] as const) {
    const t = build({ textsEnabled: false, emails: 'accept' });
    const phone = createWirePhone(); const voice = createWireVoice({ msPerChar: 1, behave: (_x: string, n: number) => (n === 1 ? how : 'exact') });
    const b = createRealtimeBridge(phone, voice, {}); const transport = createRealtimeTransport(b.link, { notice: 'Hello. This is an automated A I assistant for Drew Cleaning. Please say yes to continue, or hang up now.', transcriptionModel: 'x', voice: 'y', msPerChar: 1, endWaitMs: 300 });
    t.h.serve(transport); voice.open(); phone.start({ to: DREW, callSid: SIDN });
    await t.c.until(() => t.outcomes.length > 0, 'the outcome'); await t.h.idle();
    assert.deepEqual(outcomes(t), [[reason, false]], how); assert.equal(t.mails.length, mails, how); assert.equal(t.booked.length, 0); assert.equal(t.h.active(), 0);
    if (mails === 1) { assert.deepEqual(sidLines(t), ['Call SID: ' + SIDN]); allLinesFixed(t); nothingPersonal(t); }
  }
});

// ================================================================ durable lead capture: an ending that would promise a person is SAVED and READ BACK before it is spoken, and says only what was saved
const LEAD_SID = `CA${'ab'.repeat(16)}`; const LEAD_REF = callRefFor(TENANT, LEAD_SID);
const LEAD_FAILED = 'Sorry, I could not complete that, and I could not save your request. Please call back later. Goodbye.';
const UNVERIFIED = (): BookingResult => ({ status: 'uncertain', reason: 'READBACK_MISMATCH', writes: 2 });
const sizeNotOffered = async (t: ReturnType<typeof build>): Promise<void> => {
  t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented');
  await t.c.hears(/Is that right\? Say yes or no/, 'yes'); await t.c.hears(/street address/, '123 Invented Lane, Testville, CA 90210'); await t.c.hears(/What day and time/, 'Tuesday at ten'); await t.c.hears(/bedrooms and bathrooms/, 'three bedrooms and two bathrooms'); await finish(t.c);
};
const otherNumber = async (t: ReturnType<typeof build>): Promise<void> => {
  t.h.serve(t.c.transport); await toOffer(t.c); await t.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await t.c.hears(/calling from/, 'no');
  await t.c.hears(/best number/, 'five five five zero one zero zero zero zero four'); await t.c.hears(/I heard/, 'yes'); await t.c.hears(/To confirm/, 'yes'); await finish(t.c);
};
type LeadFactsSeen = Parameters<NonNullable<FastDeps['saveLead']>>[0];

test('LEAD stored: a failure after the caller confirmed the name and the number saves the record and the encrypted contact, reads both back, and then says only that the request is recorded; with the owner\'s follow-up attestation the original words stand', async () => {
  const t = build({ textsEnabled: false, book: UNVERIFIED }); await toBooked(t); await t.h.idle();
  assert.equal(t.last().lead, 'stored'); assert.equal(t.last().reason, 'BOOKING_NOT_VERIFIED');
  assert.deepEqual(t.records.list(TENANT).map((r) => [r.call_ref, r.status, r.confirmation, r.handed_off]), [[LEAD_REF, 'needs-human', 'unconfirmed', false]]);
  assert.deepEqual(t.vault.get(TENANT, LEAD_REF), { name: 'Testa Invented', phone: '5550100002', address_state: 'unconfirmed' });
  assert.equal(t.c.lines.at(-1), 'I could not confirm the booking. Your request is recorded. Goodbye.'); assert.deepEqual(row(t, 'FAST_LEAD'), { result: 'stored', reason: 'BOOKING_NOT_VERIFIED' });
  const a = build({ textsEnabled: false, book: UNVERIFIED, settings: { followUpProcess: true } }); await toBooked(a); await a.h.idle();
  assert.equal(a.last().lead, 'stored'); assert.equal(a.c.lines.at(-1), 'I could not confirm the booking, so a person will follow up. Goodbye.', 'stored AND attested: the original words');
  const u = build({ textsEnabled: false, book: UNVERIFIED, leads: 'record-only', settings: { followUpProcess: true } }); await toBooked(u); await u.h.idle();
  assert.equal(u.last().lead, 'recorded'); assert.equal(u.c.lines.at(-1), 'I could not confirm the booking. Your request is recorded. Goodbye.', 'an attestation without a stored number promises nothing');
});

test('LEAD recorded: a failure BEFORE the callback number was confirmed saves the record only - the verified caller ID is known but was never confirmed by the caller, so no number and no name placeholder is kept', async () => {
  const t = build(); await sizeNotOffered(t);
  assert.equal(t.last().reason, 'SIZE_NOT_OFFERED'); assert.equal(t.last().lead, 'recorded'); assert.equal(t.records.list(TENANT).length, 1); assert.deepEqual(t.vault.list(TENANT), []);
  assert.equal(t.c.lines.at(-1), 'Sorry, on this test line I can only book two bedroom, two bathroom homes. Your request is recorded. Goodbye.'); assert.equal(t.booked.length, 0);
});

test('LEAD facts: only what the caller confirmed reaches the saver - the name after the caller\'s yes, the callback number after the caller\'s yes and only if it is on the approved list; steps are fixed tokens; nothing the caller said', async () => {
  const seen: LeadFactsSeen[] = []; const spy = (f: LeadFactsSeen) => { seen.push(f); return 'recorded' as const; };
  const a = build({ saveLead: spy }); await sizeNotOffered(a);
  const b = build({ saveLead: spy, book: UNVERIFIED, textsEnabled: false }); await toBooked(b);
  const c = build({ saveLead: spy, book: UNVERIFIED, textsEnabled: false }); await otherNumber(c);                              // a number the caller gave, NOT on the approved list
  const d = build({ saveLead: spy, book: UNVERIFIED, textsEnabled: false, customers: [CUSTOMER, '+15550100004'] }); await otherNumber(d);   // the same, on the list
  const e = build({ saveLead: spy, emails: 'accept', settleMs: 80 }); e.h.serve(e.c.transport); e.c.setup(DREW, undefined, 'Done Bellamy');
  await e.c.hears(/^I have Done, D O N E, Bellamy, B E L L A M Y\./, 'no'); await e.c.hears(/^Sorry\. Please say your first and last name again\.$/, 'Dawn Bellamy'); await e.c.hears(/^I have Dawn, D A W N, Bellamy, B E L L A M Y\./, 'no');
  await e.c.hears(/^Please spell your first name/, 'D A W N'); await e.c.hears(/^Please spell your last name/, 'B E L L A M Y'); await e.c.hears(/^I have Dawn, D A W N, Bellamy, B E L L A M Y\./, 'no'); await finish(e.c);
  assert.deepEqual(seen.map((f) => [f.reason, f.name, f.callback]), [
    ['SIZE_NOT_OFFERED', 'Testa Invented', undefined], ['BOOKING_NOT_VERIFIED', 'Testa Invented', '+15550100002'], ['BOOKING_NOT_VERIFIED', 'Testa Invented', undefined], ['BOOKING_NOT_VERIFIED', 'Testa Invented', '+15550100004'], ['NAME_NOT_CONFIRMED', undefined, undefined],
  ]);
  for (const f of seen) { assert.deepEqual(Object.keys(f).filter((k) => f[k as keyof LeadFactsSeen] !== undefined).sort(), ['at', 'callSid', 'reason', ...(f.callback === undefined ? [] : ['callback']), ...(f.name === undefined ? [] : ['name']), 'steps'].sort()); assert.ok(f.steps.every((s) => /^[A-Z][A-Z0-9_]*$/.test(s)), 'steps are fixed tokens'); assert.equal(f.callSid, LEAD_SID); }
  assert.equal(JSON.stringify(a.logs).includes('Invented'), false); assert.equal(JSON.stringify(b.logs).includes('5550100002'), false, 'no number in a log');
});

test('LEAD an approved number the caller gave is stored with its own digits; one that is not approved is not (the record alone)', async () => {
  const ok = build({ book: UNVERIFIED, textsEnabled: false, customers: [CUSTOMER, '+15550100004'] }); await otherNumber(ok);
  assert.equal(ok.last().lead, 'stored'); assert.deepEqual(ok.vault.get(TENANT, LEAD_REF), { name: 'Testa Invented', phone: '5550100004', address_state: 'unconfirmed' });
  const no = build({ book: UNVERIFIED, textsEnabled: false }); await otherNumber(no);
  assert.equal(no.last().lead, 'recorded'); assert.deepEqual(no.vault.list(TENANT), []); assert.equal(no.records.list(TENANT).length, 1);
});

test('LEAD failed: no sink at all, a saver that throws or rejects, or one that answers anything but "stored" or "recorded" - the ending says that nothing could be saved, never "recorded" and never a promise', async () => {
  const cases: Array<[string, { leads?: 'none'; saveLead?: FastDeps['saveLead'] }]> = [
    ['no sink', { leads: 'none' }], ['throws', { saveLead: () => { throw new Error('disk full'); } }], ['rejects', { saveLead: async () => { throw new Error('locked'); } }],
    ['garbage', { saveLead: (() => 'yes') as unknown as FastDeps['saveLead'] }], ['undefined', { saveLead: (() => undefined) as unknown as FastDeps['saveLead'] }], ['an explicit failure', { saveLead: () => 'failed' }],
  ];
  for (const [label, over] of cases) {
    const t = build({ textsEnabled: false, book: UNVERIFIED, settings: { followUpProcess: true }, ...over }); await toBooked(t); await t.h.idle();
    assert.equal(t.last().lead, 'failed', label); assert.equal(t.c.lines.at(-1), LEAD_FAILED, label); assert.deepEqual(row(t, 'FAST_LEAD'), { result: 'failed', reason: 'BOOKING_NOT_VERIFIED' }, label);
  }
});

test('LEAD order and count: the lead is saved BEFORE the ending is spoken, exactly once per call; a booked ending and ALREADY_BOOKED save nothing', async () => {
  const calls: Array<{ spoken: number; reason: string }> = [];
  const t: ReturnType<typeof build> = build({ textsEnabled: false, book: UNVERIFIED, saveLead: async (f) => { calls.push({ spoken: t.c.lines.length, reason: f.reason }); return 'recorded'; } });
  await toBooked(t); await t.h.idle();
  assert.equal(calls.length, 1); assert.equal(calls[0].spoken, t.c.lines.length - 1, 'every line but the ending had been spoken'); assert.equal(t.c.lines.at(-1), 'I could not confirm the booking. Your request is recorded. Goodbye.');
  let count = 0; const ok = build({ textsEnabled: false, saveLead: () => { count++; return 'stored'; } }); await toBooked(ok); await ok.h.idle();
  const dup = build({ textsEnabled: false, saveLead: () => { count++; return 'stored'; }, book: () => ({ ...OK_RESULT, writes: 0, duplicate: true }) }); await toBooked(dup); await dup.h.idle();
  assert.deepEqual([ok.last().reason, dup.last().reason, count], ['BOOKED', 'ALREADY_BOOKED', 0]); assert.equal(ok.last().lead, undefined); assert.equal(ok.records.list(TENANT).length, 0);
});

test('LEAD after a hang-up: a booking that is not verified once the caller is gone saves the lead once, speaks nothing, and the outcome carries the result', async () => {
  const g = gate<BookingResult>(); const t = build({ textsEnabled: false, book: () => g.p });
  await toPendingWrite(t); t.c.hangUp(); g.res(UNVERIFIED()); await t.h.idle();
  assert.deepEqual(outcomes(t), [['CALLER_HUNG_UP', false], ['BOOKING_NOT_VERIFIED', false]]); assert.equal(t.last().lead, 'stored'); assert.equal(t.records.list(TENANT).length, 1);
  assert.equal(t.c.lines.some((l) => /recorded|person will/.test(l)), false, 'nothing is spoken to a caller who has gone'); assert.equal(t.logs.filter(([c]) => c === 'FAST_LEAD').length, 1);
});

test('LEAD owner notice is unchanged and does not rest on the lead: the owner email still goes once for the ending, and it no longer says what the caller was told', async () => {
  const t = build({ textsEnabled: false, emails: 'accept', book: UNVERIFIED, leads: 'none' }); await toBooked(t); await t.h.idle();
  assert.equal(t.last().lead, 'failed'); assert.deepEqual(t.mails.map((m) => m.role), ['owner']); const body = t.mails[0].text.split('\n');
  assert.equal(body[0], 'A Drew Cleaning DEMO call ended without completing the request, and it needs a follow-up. Nobody else has been told.'); assert.ok(!t.mails[0].text.includes('told the caller'));
});

test('LEAD source: the lead path sends nothing and keeps no placeholder, only a confirmed name and an approved confirmed number reach it, and the record is written before the contact', () => {
  const src = readFileSync(new URL('../src/fast-call-handler.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const fn = /async function saveLeadFor[\s\S]*?\n    \}\n/.exec(src)?.[0] ?? ''; assert.ok(fn.length > 300, 'found');
  assert.ok(!/sendText|sendEmail|sendOwnerNotice|recordConsent/.test(fn), 'the lead path sends nothing'); assert.ok(/deps\.approvedCustomerNumbers\.has\(callback\)/.test(fn) && /nameOk/.test(fn), 'only a confirmed name and an approved, confirmed number');
  assert.ok(!/'Name not|\(name not/i.test(src), 'no placeholder name');
  const lead = readFileSync(new URL('../src/fast-lead.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.deepEqual([...lead.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]), ['./intake-record-store.ts', './intake-record-store.ts', './contact-vault.ts']); assert.ok(!/process\.env|fetch\(|console\.|writeFile|setTimeout|sendText|sendEmail/.test(lead));
  assert.ok(lead.indexOf('sink.store.put') < lead.indexOf('sink.contacts.put'), 'the record is written before the contact');
});
