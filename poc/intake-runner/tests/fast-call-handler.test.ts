// The fast Drew test call, run against stand-ins: a fake carrier that measures playback, a fake calendar, a fake booking adapter and fake texts. No real call, booking or message exists here, and every name, number and
// address is invented. The hours in SETTINGS are a SYNTHETIC test fixture, not the founder's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AI_ANSWER, confirmedMismatches, createFastCallHandler, spellOut } from '../src/fast-call-handler.ts';
import type { FastDeps, FastOutcome, FastSettings } from '../src/fast-call-handler.ts';
import { instantOf } from '../src/fast-parsers.ts';
import type { BookingRequest, BookingResult } from '../src/jobber-booking.ts';
import type { Delivery, SendResult } from '../src/twilio-messaging.ts';
import { cleanDetail } from '../src/call-diag.ts';
import { fakeCarrier } from './helpers/fake-carrier.ts';

const TZ = 'America/Chicago'; const NOW = Date.parse('2026-11-02T15:00:00Z');   // Monday 9:00 in Chicago
const DREW = '+15550100001'; const CUSTOMER = '+15550100002'; const OWNER = '+15550100003'; const STRANGER = '+15550100099';
const SETTINGS: FastSettings = { businessName: 'Drew Cleaning', serviceLabel: 'Standard cleaning', bedrooms: 2, bathrooms: 2, priceDollars: 199, standingApproval: true, state: 'CA',
  availability: { timezone: TZ, hours: { 1: [['09:00', '17:00']], 2: [['09:00', '17:00']], 3: [['09:00', '17:00']], 4: [['09:00', '17:00']], 5: [['09:00', '17:00']] }, durationMinutes: 120, stepMinutes: 30, leadMinutes: 60 } };

function build(o: { settings?: Partial<FastSettings>; caller?: string | undefined; busy?: { busy: Array<{ start: number; end: number }>; complete: boolean }; book?: (r: BookingRequest) => BookingResult; send?: (to: string, body: string) => SendResult; delivery?: Delivery; customers?: string[]; textsEnabled?: boolean; ownerConsent?: boolean; consentOk?: boolean; answerWaitMs?: number; settleMs?: number | null; busyLater?: { busy: Array<{ start: number; end: number }>; complete: boolean }; emails?: 'accept' | 'refuse' | 'throw'; holdGraceMs?: number; holdMaxMs?: number; maxCalls?: number } = {}) {
  const logs: Array<[string, unknown]> = []; const outcomes: FastOutcome[] = []; const mails: Array<{ role: string; subject: string; text: string }> = []; const booked: BookingRequest[] = []; const texts: Array<{ to: string; body: string }> = []; const consents: Array<{ result: string; script: string; ref: string }> = []; let busyCalls = 0;
  const deps: FastDeps = {
    settings: { ...SETTINGS, ...o.settings }, numbers: new Set([DREW]), approvedCallers: new Set([CUSTOMER]), approvedCustomerNumbers: new Set(o.customers ?? [CUSTOMER]), ownerNumber: OWNER, maxCalls: o.maxCalls ?? 5,
    now: () => NOW, callerOf: async () => ('caller' in o ? o.caller : CUSTOMER), busy: async () => { busyCalls++; return (busyCalls > 1 && o.busyLater !== undefined ? o.busyLater : o.busy) ?? { busy: [], complete: true }; },
    book: async (r) => { booked.push(r); return (o.book ?? (() => ({ status: 'booked_verified', jobId: 'JOB-1', jobNumber: 1001, writes: 2 })))(r); },
    sendText: async (to, body) => { texts.push({ to, body }); return (o.send ?? (() => ({ ok: true, sid: `SM${'1'.repeat(32)}` })))(to, body); },
    textsEnabled: o.textsEnabled ?? true, ownerConsent: o.ownerConsent ?? true, recordConsent: async (e) => { consents.push(e); return o.consentOk ?? true; },
    verifyText: async () => o.delivery ?? 'delivered', log: (c, d) => { logs.push([c, d]); }, onOutcome: (x) => { outcomes.push(x); },
    emailsEnabled: o.emails !== undefined, ...(o.emails === undefined ? {} : { sendEmail: async (role: 'customer' | 'owner', subject: string, text: string) => { mails.push({ role, subject, text }); if (o.emails === 'throw') throw new Error('mail down'); return { ok: o.emails === 'accept' }; } }),
    answerWaitMs: o.answerWaitMs ?? 5000, settleMs: o.settleMs === null ? undefined : o.settleMs ?? 15, playbackMaxMs: 5000, afterSpeechMs: 5, holdGraceMs: o.holdGraceMs ?? 15, holdMaxMs: o.holdMaxMs ?? 300,
  };
  const h = createFastCallHandler(deps); const c = fakeCarrier();
  return { h, c, logs, outcomes, mails, booked, texts, consents, busyCalls: () => busyCalls, last: () => outcomes[outcomes.length - 1] };
}
/** The caller's side of a complete call up to the offer, with the usual answers. */
async function toOffer(c: ReturnType<typeof fakeCarrier>, when = 'Tuesday at ten'): Promise<void> {
  c.setup(DREW, undefined, 'Testa Invented');   // the greeting asked for the name; this is the answer
  await c.hears(/Is that right\? Say yes or no/, 'yes'); await c.hears(/street address/, '123 Invented Lane, Testville, CA 90210');
  await c.hears(/What day and time/, when);
  await c.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
}
const finish = async (c: ReturnType<typeof fakeCarrier>): Promise<void> => { await c.drain(() => c.ended > 0 && c.closed > 0, 'the call to end'); };
const noPersonalDetail = (logs: Array<[string, unknown]>, extra: string[] = []): void => { const all = JSON.stringify(logs); for (const s of ['Testa', 'Invented', 'Testville', '90210', '5550100002', '5550100003', '0100002', ...extra]) assert.ok(!all.includes(s), `no ${s} in the diagnostics`); };

test('the whole call: name, address with city and ZIP, day and time, size, $199 with a time the calendar supports, agreement, verified caller ID as the callback number, text permission, read-back, the Jobber test booking, both texts, delivery checked', async () => {
  const t = build();
  t.h.serve(t.c.transport); await toOffer(t.c);
  const offer = await t.c.hears(/is one hundred ninety-nine dollars/, 'yes');
  assert.equal(offer, 'A standard cleaning for two bedrooms and two bathrooms is one hundred ninety-nine dollars. We have Tuesday, November third, 2026 at 10 A M. Does that work?');
  assert.equal(await t.c.hears(/calling from a number ending in/, 'yes'), 'I see you are calling from a number ending in 0 0 0 2. Is that the best number to reach you?');
  await t.c.hears(/May we send you one automated/, 'yes');
  const readback = await t.c.hears(/To confirm/, 'yes');
  assert.equal(readback, 'To confirm: Standard cleaning for Testa Invented on Tuesday, November third, 2026 at 10 A M, at 123 Invented Lane, Testville, California, 9 0 2 1 0. The price is one hundred ninety-nine dollars. Shall I book it? Say yes or no.');
  await finish(t.c);
  assert.equal(t.booked.length, 1);
  const r = t.booked[0];
  assert.deepEqual([r.client, r.address, r.when, r.title, r.priceDollars], [{ firstName: 'Testa', lastName: 'Invented', phone: '5550100002' }, { street1: '123 Invented Lane', city: 'Testville', postalCode: '90210', province: 'CA' }, { date: '2026-11-03', startTime: '10:00', endTime: '12:00', utcOffset: '-06:00' }, 'Standard cleaning', 199]);
  assert.deepEqual(r.gate, { eligibleRecord: true, approvedByPerson: true, callerAgreed: true }); assert.match(r.key, /^fast-[0-9a-f]{24}$/);
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
  await b.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await b.c.hears(/calling from/, 'yes'); await b.c.hears(/May we send you one automated/, 'yes'); await b.c.hears(/To confirm/, 'no'); await finish(b.c);
  assert.equal(b.booked.length, 0); assert.equal(b.texts.length, 0); assert.equal(b.last().reason, 'DECLINED_AT_READBACK');
  const c = build({ settings: { standingApproval: false } }); c.h.serve(c.c.transport); await toOffer(c.c);
  await c.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await c.c.hears(/calling from/, 'yes'); await c.c.hears(/May we send you one automated/, 'yes'); await c.c.hears(/To confirm/, 'yes'); await finish(c.c);
  assert.equal(c.booked.length, 0); assert.equal(c.last().reason, 'NO_STANDING_APPROVAL'); assert.equal(c.texts.length, 0);
});

test('honesty: a booking that is not verified sends no text and says a person will follow up; a refused customer text is not claimed; an undelivered or unconfirmed text is reported, not assumed', async () => {
  const a = build({ book: () => ({ status: 'uncertain', reason: 'READBACK_MISMATCH', mismatches: ['visit_time'], writes: 2 }) }); a.h.serve(a.c.transport); await toOffer(a.c);
  await a.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await a.c.hears(/calling from/, 'yes'); await a.c.hears(/May we send you one automated/, 'yes'); await a.c.hears(/To confirm/, 'yes'); await finish(a.c);
  assert.equal(a.texts.length, 0); assert.equal(a.last().reason, 'BOOKING_NOT_VERIFIED'); assert.equal(a.last().booked, false); assert.match(a.c.lines.at(-1)!, /could not confirm the booking, so a person will follow up/);
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
  assert.equal(unverified.mails.length, 0); assert.equal(unverified.last().reason, 'BOOKING_NOT_VERIFIED'); assert.equal(unverified.last().customerEmail, undefined);
  const declined = build({ textsEnabled: false, emails: 'accept' }); declined.h.serve(declined.c.transport); await toOffer(declined.c);
  await declined.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await declined.c.hears(/calling from a number ending in/, 'yes'); await declined.c.hears(/To confirm/, 'no'); await finish(declined.c);
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

test('duplicate-email guard: a booking Jobber reports as already made, and a booking key already emailed in this process, send no second email', async () => {
  const dup = build({ textsEnabled: false, emails: 'accept', book: () => ({ status: 'booked_verified', jobId: 'JOB-1', jobNumber: 1001, writes: 0, duplicate: true }) }); await toBooked(dup);
  assert.equal(dup.mails.length, 0); assert.deepEqual(dup.logs.find(([c]) => c === 'FAST_EMAILS_SKIPPED')?.[1], { reason: 'DUPLICATE' });
  assert.equal(dup.c.lines.at(-1), 'You are booked for Tuesday, November third, 2026 at 10 A M. Goodbye.', 'no email is promised'); assert.deepEqual([dup.last().customerEmail, dup.last().ownerEmail, dup.last().booked], ['not_sent', 'not_sent', true]);
  const t = build({ textsEnabled: false, emails: 'accept' }); await toBooked(t); assert.equal(t.mails.length, 2);
  const again = fakeCarrier(); t.h.serve(again.transport); again.setup(DREW, undefined, 'Testa Invented');   // the same call id: the same booking key
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
  assert.match(await a.c.hears(/To confirm/, 'yes'), /^To confirm: Standard cleaning for Testa Invented on Tuesday, November third, 2026 at 10 A M, at 123 Invented Lane, Testville, California, 9 0 2 1 0\. The price is one hundred ninety-nine dollars\. Shall I book it\? Say yes or no\.$/, 'a name said in two steps is read back in full'); await finish(a.c);
  assert.deepEqual([a.booked[0].client.firstName, a.booked[0].client.lastName], ['Testa', 'Invented']);
  // what the recognizer returned is spoken back as it came, so the caller can catch a mishearing; a no books nothing
  const b = build({ textsEnabled: false, emails: 'accept' }); b.h.serve(b.c.transport); b.c.setup(DREW, undefined, 'Done Bill');   // a misheard name, as the transcript gave it
  await b.c.hears(/Is that right\? Say yes or no/, 'yes'); await b.c.hears(/street address/, '123 Invented Lane, Testville, CA 90210'); await b.c.hears(/What day and time/, 'Tuesday at ten'); await b.c.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  await b.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await b.c.hears(/calling from a number ending in/, 'yes');
  assert.match(await b.c.hears(/To confirm/, 'no'), /for Done Bill on /, 'the heard name is spoken back in full, unchanged'); await finish(b.c);
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
  assert.match(readback, /at 123 Invented Lane, Testville, Texas, 9 0 2 1 0\. The price is/, 'the state is read back by its full name');
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
  assert.equal(t.booked.length, 0); assert.equal(t.mails.length, 0); assert.equal(t.texts.length, 0);
  assert.equal(t.c.lines.at(-1), 'Sorry, I am having trouble with that, so a person will follow up. Goodbye.');
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
  assert.deepEqual([a.last().reason, a.last().booked], ['NAME_NOT_CONFIRMED', false]); assert.equal(a.booked.length, 0); assert.equal(a.mails.length, 0); assert.equal(a.texts.length, 0);
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
  assert.deepEqual([m.last().reason, m.last().booked], ['BOOKING_NOT_VERIFIED', false]); assert.equal(m.mails.length, 0); assert.equal(m.texts.length, 0);
  assert.ok(!m.c.lines.some((l) => /You are booked|confirmation (?:text|email)/.test(l)), 'no booking is claimed');
  assert.deepEqual(m.logs.filter(([k]) => k === 'FAST_BOOKING').map(([, v]) => v), [{ status: 'booked_verified', readBackDiffs: 1 }], 'a count of differing fields, never their values');
});
