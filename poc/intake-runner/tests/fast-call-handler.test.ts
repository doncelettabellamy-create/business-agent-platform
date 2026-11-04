// The fast Drew test call, run against stand-ins: a fake carrier that measures playback, a fake calendar, a fake booking adapter and fake texts. No real call, booking or message exists here, and every name, number and
// address is invented. The hours in SETTINGS are a SYNTHETIC test fixture, not the founder's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AI_ANSWER, createFastCallHandler } from '../src/fast-call-handler.ts';
import type { FastDeps, FastOutcome, FastSettings } from '../src/fast-call-handler.ts';
import { instantOf } from '../src/fast-parsers.ts';
import type { BookingRequest, BookingResult } from '../src/jobber-booking.ts';
import type { Delivery, SendResult } from '../src/twilio-messaging.ts';
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
  await c.hears(/street address/, '123 Invented Lane, Testville, 90210');
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
  assert.equal(readback, 'To confirm: Standard cleaning for Testa Invented on Tuesday, November third, 2026 at 10 A M, at 123 Invented Lane, Testville, 9 0 2 1 0. The price is one hundred ninety-nine dollars. Shall I book it? Say yes or no.');
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
  await t.c.hears(/street address/, '123 Invented Lane');
  await t.c.hears(/What is the city/, 'Testville');
  await t.c.hears(/ZIP code\?$/, '90210');
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
  await t.c.hears(/street address/, '123 Invented Lane, Testville, 90210');
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
  await t.c.hears(/street address/, undefined); assert.match(t.c.lines[0], /street address/, 'the first thing the call says is the address question: the greeting already asked the name');
  assert.ok(!t.logs.some(([c]) => /CONSENT/.test(c)) && !t.c.lines.some((l) => /say yes to continue/i.test(l)), 'no yes is asked for anywhere');
  const y = build(); y.h.serve(y.c.transport); y.c.setup(DREW, undefined, 'yes');
  await y.c.hears(/^Sorry, what is your first and last name\?$/, 'Testa Invented'); await y.c.hears(/street address/, undefined);
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
  await a.c.hears(/^What is your first and last name\?$/, 'Testa Invented'); await a.c.hears(/street address/, undefined);
  // at an information step: the address parts already given are kept, and only the question is repeated
  const b = build(); b.h.serve(b.c.transport); b.c.setup(DREW, undefined, 'Testa Invented');
  await b.c.hears(/street address/, '123 Invented Lane'); await b.c.hears(/What is the city/, 'is this a real person?');
  assert.equal(await b.c.hears(/^Yes, I'm an A I assistant/, undefined), ANSWER);
  await b.c.hears(/^What is the city\?$/, 'Testville'); await b.c.hears(/ZIP code\?$/, '90210'); await b.c.hears(/What day and time/, undefined);
  // at a confirmation unit, over the line while it is still playing: the answer is given, the unit is spoken again after the approved instruction, and the question confirms or denies nothing
  const c = build(); c.h.serve(c.c.transport); await toOffer(c.c);
  await c.c.hears(/is one hundred ninety-nine dollars/, 'am I talking to a human?', { early: true });   // the helper lets everything pending finish, the answer included
  await c.c.until(() => c.c.lines.includes(ANSWER), 'the truthful answer');
  assert.match(await c.c.hears(/Please wait until I have finished, then answer\. A standard cleaning/, 'yes'), /Does that work\?$/);
  assert.equal(c.booked.length, 0); await c.c.hears(/calling from/, 'are you an A I?'); await c.c.hears(/^Yes, I'm an A I assistant/, undefined);
  assert.match(await c.c.hears(/Please wait until I have finished, then answer\. I see you are calling/, 'yes'), /best number/);
  assert.equal(c.logs.filter(([code]) => code === 'FAST_AI_QUESTION').length, 2);
  // every spoken line of the happy path says nothing that claims to be human, and names are not mistaken for the question
  for (const name of ['Bot Johnson', 'Robin Lee', 'Al Machine']) { const n = build(); n.h.serve(n.c.transport); n.c.setup(DREW, undefined, `my name is ${name}`); await n.c.hears(/street address/, undefined); assert.ok(!n.c.lines.some((l) => /A I assistant/.test(l)), name); }
  assert.ok(![...a.c.lines, ...b.c.lines, ...c.c.lines].some((l) => /\b(?:i am|i'm) (?:a )?(?:real |human|person)/i.test(l.replace(/not a person/g, ''))), 'no line claims to be a person');
});

test('only the one priced size is booked: any other size ends politely before the calendar is read', async () => {
  const t = build(); t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented');
  await t.c.hears(/street address/, '123 Invented Lane, Testville, 90210'); await t.c.hears(/What day and time/, 'Tuesday at ten');
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
  assert.match(await t.c.hears(/is one hundred ninety-nine dollars/, 'no'), /Tuesday, November third, 2026 at 12 P M/, 'the calendar\'s busy time moved the offer');
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
  await f.c.hears(/street address/, undefined); f.c.emit({ kind: 'reply_failed' });
  await f.c.hears(/^What is the street address, with the city and ZIP code\?$/, '123 Invented Lane, Testville, 90210'); await f.c.hears(/What day and time/, undefined);
  const h = build(); h.h.serve(h.c.transport); h.c.setup(DREW, undefined, 'Testa Invented'); await h.c.hears(/street address/, undefined); h.c.hangUp();
  assert.equal(h.last().reason, 'CALLER_HUNG_UP'); assert.equal(h.booked.length, 0); assert.equal(h.h.active(), 0);
  const d = build(); d.h.serve(d.c.transport); d.c.setup(DREW, undefined, 'Testa Invented'); await d.c.hears(/street address/, undefined); d.c.emit({ kind: 'speaker_down' }); await d.c.drain(() => d.c.ended > 0); assert.equal(d.last().reason, 'SPEAKER_DOWN');
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
  await t.c.hears(/street address/, '123 Invented Lane');   // street only: the city and ZIP are still to come
  t.c.emit({ kind: 'speech', active: true });               // the caller starts the next piece before the quiet wait is over
  await new Promise((r) => setTimeout(r, 250));              // more than three times the wait: it would have asked by now
  assert.equal(t.c.lines.filter((l) => /^What is the city\?$|^And the ZIP code\?$/.test(l)).length, 0, 'nothing is asked while the caller speaks');
  t.c.emit({ kind: 'speech', active: false });
  await t.c.hears(/What is the city/, 'Testville');
  assert.equal(t.c.lines.filter((l) => /^What is the city\?$/.test(l)).length, 1);
});

test('settle wait: more speech that arrives as an answer cancels the pending question, so the part the caller just said is never asked for', async () => {
  const t = build({ settleMs: 80 }); t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented');
  await t.c.hears(/street address/, '123 Invented Lane');
  t.c.emit({ kind: 'speech', active: true }); t.c.emit({ kind: 'speech', active: false });
  t.c.emit({ kind: 'utterance', text: 'Testville, 90210' });   // the rest arrives inside the wait
  await t.c.hears(/What day and time/, 'Tuesday');
  assert.equal(t.c.lines.filter((l) => /^What is the city\?$|^And the ZIP code\?$/.test(l)).length, 0, 'the city and ZIP were said, so they are not asked');
});

test('settle wait: the default quiet wait is longer than 1.2 seconds, so a pause between the street and the city is not mistaken for the end of the answer', async () => {
  const t = build({ settleMs: null }); t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented');
  await t.c.hears(/street address/, '123 Invented Lane');
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(t.c.lines.filter((l) => /^What is the city\?$|^And the ZIP code\?$/.test(l)).length, 0, 'nothing was asked 1.6 seconds after the street');
  await t.c.hears(/What is the city/, 'Testville');
});

test('dates: one already passed, or beyond the days the calendar is read for, is never taken as asked; the caller is told why and asked again, and nothing is offered or booked from it', async () => {
  const t = build(); t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented');
  await t.c.hears(/street address/, '123 Invented Lane, Testville, 90210');
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
  await t.c.hears(/street address/, '123 Invented Lane, Testville, 90210');
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
  await again.hears(/street address/, '123 Invented Lane, Testville, 90210'); await again.hears(/What day and time/, 'Tuesday at ten'); await again.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  await again.hears(/is one hundred ninety-nine dollars/, 'yes'); await again.hears(/calling from a number ending in/, 'yes'); await again.hears(/To confirm/, 'yes'); await finish(again);
  assert.equal(t.mails.length, 2, 'the same booking is never emailed twice'); assert.deepEqual(t.logs.filter(([c]) => c === 'FAST_EMAILS_SKIPPED').map(([, d]) => d), [{ reason: 'ALREADY_SENT' }]); assert.equal(t.booked.length, 2);
});

// ================================================================ turn hold, fragment settle, goodbye
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('turn hold: a question is not spoken while the caller is speaking; it is spoken after they stop and a short grace, and only numbers are logged', async () => {
  const t = build({ holdGraceMs: 60, holdMaxMs: 800 }); t.h.serve(t.c.transport);
  t.c.emit({ kind: 'setup', to: DREW, callSid: `CA${'ab'.repeat(16)}` }); t.c.emit({ kind: 'speech', active: true }); t.c.emit({ kind: 'utterance', text: 'Testa Invented' });   // the caller is still talking when the next question is due
  await sleep(250); assert.equal(t.c.lines.filter((l) => /street address/.test(l)).length, 0, 'nothing is spoken on top of the caller');
  t.c.emit({ kind: 'speech', active: false }); await t.c.hears(/street address/, '123 Invented Lane, Testville, 90210');
  const hold = t.logs.find(([c]) => c === 'FAST_HOLD')?.[1] as { waitedMs: number; ignored: number }; assert.ok(hold.waitedMs >= 100 && hold.waitedMs < 800, 'it waited, and not to the cap'); assert.equal(hold.ignored, 0);
  assert.deepEqual(Object.keys(hold).sort(), ['ignored', 'waitedMs']); noPersonalDetail(t.logs);
});

test('turn hold: a speech start that never stops cannot block the call: the question is spoken at the cap', async () => {
  const t = build({ holdGraceMs: 60, holdMaxMs: 150 }); t.h.serve(t.c.transport);
  t.c.emit({ kind: 'setup', to: DREW, callSid: `CA${'ab'.repeat(16)}` }); t.c.emit({ kind: 'speech', active: true }); t.c.emit({ kind: 'utterance', text: 'Testa Invented' });
  await t.c.hears(/street address/, '123 Invented Lane, Testville, 90210');
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
  await a.c.hears(/street address/, '123 Invented Lane, Testville, 90210'); await a.c.hears(/What day and time/, 'um'); await sleep(30); a.c.emit({ kind: 'utterance', text: 'tomorrow at ten' });
  await a.c.hears(/bedrooms and bathrooms/, undefined); assert.equal(a.c.lines.filter((l) => /Sorry, which day|^Which day\?$/.test(l)).length, 0, 'the rest arrived in time: nothing was asked');
  const b = build({ settleMs: 80 }); b.h.serve(b.c.transport); b.c.setup(DREW, undefined, 'Testa Invented');
  await b.c.hears(/street address/, '123 Invented Lane, Testville, 90210'); await b.c.hears(/What day and time/, 'at ten'); await sleep(30); b.c.emit({ kind: 'utterance', text: 'tomorrow' });
  await b.c.hears(/bedrooms and bathrooms/, undefined); assert.equal(b.c.lines.filter((l) => /^Which day\?$/.test(l)).length, 0, 'a time, then the day: no "Which day?"');
  const c = build({ settleMs: 80 }); c.h.serve(c.c.transport); c.c.setup(DREW, undefined, 'Testa Invented');
  await c.c.hears(/street address/, '123 Invented Lane, Testville, 90210'); await c.c.hears(/What day and time/, 'um'); await c.c.hears(/^Sorry, which day would you like\?$/, 'um'); await c.c.hears(/^Sorry, which day would you like\?$/, 'um'); await finish(c.c);
  assert.equal(c.last().reason, 'WHEN_UNCLEAR'); assert.equal(c.c.lines.filter((l) => /^Sorry, which day would you like\?$/.test(l)).length, 2, 'asked after the wait each time, and the three tries still end the call');
});

test('fragment settle (size): "two bedrooms" and then "two bathrooms" in two pieces asks nothing in between; three unusable answers still end the call', async () => {
  const a = build({ settleMs: 80 }); a.h.serve(a.c.transport); a.c.setup(DREW, undefined, 'Testa Invented');
  await a.c.hears(/street address/, '123 Invented Lane, Testville, 90210'); await a.c.hears(/What day and time/, 'tomorrow at ten'); await a.c.hears(/bedrooms and bathrooms/, 'two bedrooms'); await sleep(30); a.c.emit({ kind: 'utterance', text: 'two bathrooms' });
  await a.c.hears(/is one hundred ninety-nine dollars/, undefined); assert.equal(a.c.lines.filter((l) => /^And how many|^Sorry, how many/.test(l)).length, 0);
  const b = build({ settleMs: 80 }); b.h.serve(b.c.transport); b.c.setup(DREW, undefined, 'Testa Invented');
  await b.c.hears(/street address/, '123 Invented Lane, Testville, 90210'); await b.c.hears(/What day and time/, 'tomorrow at ten'); await b.c.hears(/bedrooms and bathrooms/, 'um'); await b.c.hears(/^Sorry, how many bedrooms and bathrooms\?$/, 'um'); await b.c.hears(/^Sorry, how many bedrooms and bathrooms\?$/, 'um'); await finish(b.c);
  assert.equal(b.last().reason, 'SIZE_UNCLEAR');
  const c = build({ settleMs: 80 }); c.h.serve(c.c.transport); c.c.setup(DREW, undefined, 'Testa Invented');
  await c.c.hears(/street address/, '123 Invented Lane, Testville, 90210'); await c.c.hears(/What day and time/, 'tomorrow at ten'); await c.c.hears(/bedrooms and bathrooms/, 'two bedrooms'); await c.c.hears(/^And how many bathrooms\?$/, 'two');
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
  assert.equal(t.c.lines.filter((l) => /street address/.test(l)).length, 0, 'still inside the grace: nothing is spoken'); await t.c.hears(/street address/, '123 Invented Lane, Testville, 90210');
});

test('full-name read-back: the read-back says the first AND last name exactly as heard (a name given in two steps too); a wrong name gets a no, and then nothing is booked, texted or emailed', async () => {
  const a = build({ textsEnabled: false, emails: 'accept' }); a.h.serve(a.c.transport); a.c.setup(DREW, undefined, 'Testa'); await a.c.hears(/last name/, 'Invented');
  await a.c.hears(/street address/, '123 Invented Lane, Testville, 90210'); await a.c.hears(/What day and time/, 'Tuesday at ten'); await a.c.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  await a.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await a.c.hears(/calling from a number ending in/, 'yes');
  assert.match(await a.c.hears(/To confirm/, 'yes'), /^To confirm: Standard cleaning for Testa Invented on Tuesday, November third, 2026 at 10 A M, at 123 Invented Lane, Testville, 9 0 2 1 0\. The price is one hundred ninety-nine dollars\. Shall I book it\? Say yes or no\.$/, 'a name said in two steps is read back in full'); await finish(a.c);
  assert.deepEqual([a.booked[0].client.firstName, a.booked[0].client.lastName], ['Testa', 'Invented']);
  // what the recognizer returned is spoken back as it came, so the caller can catch a mishearing; a no books nothing
  const b = build({ textsEnabled: false, emails: 'accept' }); b.h.serve(b.c.transport); b.c.setup(DREW, undefined, 'Done Bill');   // a misheard name, as the transcript gave it
  await b.c.hears(/street address/, '123 Invented Lane, Testville, 90210'); await b.c.hears(/What day and time/, 'Tuesday at ten'); await b.c.hears(/bedrooms and bathrooms/, 'two bedrooms and two bathrooms');
  await b.c.hears(/is one hundred ninety-nine dollars/, 'yes'); await b.c.hears(/calling from a number ending in/, 'yes');
  assert.match(await b.c.hears(/To confirm/, 'no'), /for Done Bill on /, 'the heard name is spoken back in full, unchanged'); await finish(b.c);
  assert.equal(b.last().reason, 'DECLINED_AT_READBACK'); assert.equal(b.booked.length, 0, 'nothing was written to Jobber'); assert.equal(b.mails.length, 0); assert.equal(b.texts.length, 0); assert.match(b.c.lines.at(-1)!, /Nothing was booked/);
  const c = build({ textsEnabled: false, emails: 'accept' }); await toBooked(c); assert.deepEqual([c.booked[0].client.firstName, c.booked[0].client.lastName], ['Testa', 'Invented']);
  noPersonalDetail(b.logs, ['Done', 'Bill']);
});

test('FAST_ADDRESS: one line per address answer with the outcome, reason, which parts are held and a digit-run count; no address text or digit is ever logged, and the questions asked are unchanged', async () => {
  const t = build();
  t.h.serve(t.c.transport); t.c.setup(DREW, undefined, 'Testa Invented');
  await t.c.hears(/street address/, '123 Invented Lane');
  await t.c.hears(/What is the city/, 'Testville');
  await t.c.hears(/^And the ZIP code/, '90210');
  await t.c.hears(/What day and time/);
  const lines = t.logs.filter(([k]) => k === 'FAST_ADDRESS').map(([, v]) => v as Record<string, unknown>);
  assert.deepEqual(lines, [
    { outcome: 'partial', reason: 'NEED_CITY', held: { street: true, city: false, zip: false }, digitRuns: 1 },
    { outcome: 'partial', reason: 'NEED_ZIP', held: { street: true, city: true, zip: false }, digitRuns: 0 },
    { outcome: 'captured', reason: 'JOINED', held: { street: true, city: true, zip: true }, digitRuns: 1 },
  ]);
  // a ZIP followed by extra words is dropped by the parser (unchanged behaviour); the line says so without saying what was heard
  const u = build(); u.h.serve(u.c.transport); u.c.setup(DREW, undefined, 'Testa Invented');
  await u.c.hears(/street address/, '123 Invented Lane, Testville, 90210, that is it');
  await u.c.hears(/What is the city/);
  assert.deepEqual(u.logs.filter(([k]) => k === 'FAST_ADDRESS').map(([, v]) => v), [{ outcome: 'partial', reason: 'NEED_CITY', held: { street: true, city: false, zip: false }, digitRuns: 2 }]);   // the house number and the ZIP are two runs
  // the whole call: the address, its parts and its digits appear in no log line at all
  noPersonalDetail(t.logs, ['Lane', '123', 'Invented Lane']); noPersonalDetail(u.logs, ['Lane', '123', 'Invented Lane']);
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
  await p.c.hears(/street address/, '123 Invented Lane'); await p.c.hears(/What is the city/, 'Testville'); await p.c.hears(/^And the ZIP code/, '90210'); await p.c.hears(/What day and time/, undefined);
  for (const re of [/street address/, /^What is the city/, /^And the ZIP code/, /What day and time/]) { const i = p.c.lines.findIndex((l) => re.test(l)); assert.equal(p.c.speakOpts[i]?.interruptible, false, String(re)); }
  // an answer given before the question finished is still taken, and nothing is asked twice
  const e = build(); e.h.serve(e.c.transport); e.c.setup(DREW, undefined, 'Testa Invented');
  await e.c.hears(/street address/, '123 Invented Lane, Testville, 90210');
  await e.c.hears(/What day and time/, 'Tuesday at ten', { early: true });
  await e.c.until(() => e.c.lines.some((l) => /bedrooms and bathrooms/.test(l)), 'the size question');
  assert.equal(e.c.lines.filter((l) => /What day and time/.test(l)).length, 1); assert.equal(e.c.lines.filter((l) => /bedrooms and bathrooms/.test(l)).length, 1);
});
