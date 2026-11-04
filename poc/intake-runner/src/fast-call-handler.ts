// The fast Drew TEST call (proof of concept; controlled test only). One short, deterministic conversation on the same carrier interface as the relay handler (call-transport.ts), with NO language model in the loop:
//
//   (greeting, spoken by the carrier, which asks for the name)  ->  name  ->  address, city and ZIP  ->  preferred day and time  ->  bedrooms and bathrooms  ->  $199 for two and two + a time Jobber's calendar supports  ->  agreement
//   ->  callback number (the verified caller ID)  ->  text permission  ->  read-back and yes  ->  create and verify the Jobber test booking  ->  texts to the approved customer and owner test numbers, delivery checked.
//
// What is kept from the long flow, and how:
//   * MEASURED CONFIRMATION. Every yes that matters (the quote and time, the callback number, text permission, the final read-back) is a UNIT: it counts only after the carrier's own playback verdict says the whole line
//     was played to the phone (`playbackDone`). A yes that arrives while the unit is still playing is HELD (CONFIRM_HELD): it confirms nothing, the unit is spoken again after "Please wait until I have finished, then answer.",
//     and only a fresh yes after the whole unit counts. A unit that was cut or never reported is replayed (twice at most), then the call ends unconfirmed. A carrier that cannot measure playback cannot run this flow.
//   * PRIVACY. A name, address, phone number or text is held in memory for the call only and cleared at its end. It goes to Jobber and to Twilio inside the booking and the texts, and to the caller as speech. It is never
//     logged: diagnostics are fixed codes. Nothing the caller says reaches a model; answers are read by the deterministic parsers (fast-parsers.ts, call-state.ts).
//   * NO YES PROMPT. The greeting the carrier speaks first ("Thanks for calling ... I'm Jack. What's your name?") asks the first question itself; the first thing the caller says is the answer. THE CALL IS HONEST ABOUT WHAT JACK IS: a caller who
//     asks whether this is a person, a robot or an A I, at ANY step, is told truthfully that Jack is an A I assistant, and the question in progress is then asked again.
//   * CONTROLLED TEST. Only a caller whose verified caller ID is on the approved test list gets past the opening; anyone else hears one line and the call ends with nothing collected. A booking needs the founder's standing
//     test approval in the settings. Prices and times are never invented: the price is the one configured for exactly two bedrooms and two bathrooms (anything else is not booked), and a time is offered only if
//     fast-availability.ts finds it free in Jobber's own calendar inside the founder's stated hours.
// Every outside thing is handed in (the clock, Twilio, Jobber, the booking adapter), so this file is tested with stand-ins and never reaches the network itself.

import { createHash } from 'node:crypto';
import { createContactState } from './call-state.ts';
import type { ContactState } from './call-state.ts';
import { spokenDigits } from './contact-capture.ts';
import { chooseOffer, lastBookableDate } from './fast-availability.ts';
import type { AvailabilityConfig, Busy, Offer } from './fast-availability.ts';
import { countFrom, instantOf, isAiQuestion, sayDay, sayDayYear, sayDollars, sayTime, sizeFrom, utcOffsetFor, weekdayOf, whenFrom, yesNo } from './fast-parsers.ts';
import type { When } from './fast-parsers.ts';
import type { BookingRequest, BookingResult } from './jobber-booking.ts';
import type { CallTransport, TransportEvent } from './call-transport.ts';
import type { Delivery, SendResult } from './twilio-messaging.ts';
import { callRef } from './fast-consent.ts';
import { customerEmail, ownerEmail } from './fast-email-copy.ts';
import { CUSTOMER_SCRIPT_ID, MAX_TEXT_CHARS, customerConsentLine, customerText, ownerText, zoneLabelOf } from './fast-sms-copy.ts';

export interface FastSettings {
  businessName: string; serviceLabel: string;
  availability: AvailabilityConfig;
  /** The ONE size and price this test books: exactly this many bedrooms and bathrooms, at this price. */
  bedrooms: number; bathrooms: number; priceDollars: number;
  /** The founder's standing approval of test bookings (config-bound). Without it nothing is ever booked. */
  standingApproval: boolean;
  /** Two letters, sent with the address to Jobber when given. */
  state?: string;
}
export type EmailVerdict = 'accepted' | 'refused' | 'not_sent';
export interface FastOutcome { reason: string; booked: boolean; customerText: Delivery | 'not_sent' | 'skipped'; ownerText: Delivery | 'not_sent' | 'skipped'; /** Present only when test emails are on: whether the mail server ACCEPTED each (not that it reached an inbox). */ customerEmail?: EmailVerdict; ownerEmail?: EmailVerdict; steps: string[] }
export interface FastDeps {
  settings: FastSettings;
  /** The dialed numbers the test line answers on (E.164). */
  numbers: ReadonlySet<string>;
  /** Callers (verified caller ID, E.164) allowed past the opening. */
  approvedCallers: ReadonlySet<string>;
  /** Numbers a customer text may go to; the owner's number. */
  approvedCustomerNumbers: ReadonlySet<string>; ownerNumber: string;
  maxCalls: number;
  now(): number;
  callerOf(callSid: unknown): Promise<string | undefined>;
  busy(fromIso: string, toIso: string): Promise<{ busy: Busy[]; complete: boolean }>;
  book(req: BookingRequest): Promise<BookingResult>;
  /** TEXTS ON. False is the voice + real Jobber test mode with every real text disabled (campaign approval pending): the call asks no text question, sends nothing, records no text consent and reports the texts as SKIPPED, never delivered. */
  textsEnabled: boolean;
  sendText(to: string, body: string): Promise<SendResult>;
  /** The owner's setup consent is on record for the current owner number (protected evidence). Without it no owner text is ever sent. */
  ownerConsent: boolean;
  /** Writes the caller's spoken answer to the text-consent question as minimal protected evidence; true only if it was written. A yes that could not be recorded sends no text. */
  recordConsent(e: { result: 'yes' | 'no'; script: string; ref: string }): Promise<boolean>;
  verifyText(sid: string): Promise<Delivery>;
  /** TEST EMAILS ON (default off). After a VERIFIED booking one fixed test email goes to the founder-approved customer address and one to the owner address. A failure never changes the booking. */
  emailsEnabled?: boolean;
  /** Sends one fixed test email to a ROLE's approved address. The addresses live only behind this function: the call logic never holds or chooses one. */
  sendEmail?(role: 'customer' | 'owner', subject: string, text: string): Promise<{ ok: boolean }>;
  /** Fixed codes and counts only. */
  log(code: string, detail?: Record<string, string | number | boolean>): void;
  onOutcome?(o: FastOutcome): void;
  /** Timings (milliseconds). Defaults: answer wait 12000, contact settle 1200, playback bound 60000, after-speech 400. */
  answerWaitMs?: number; settleMs?: number; playbackMaxMs?: number; afterSpeechMs?: number;
  /** A question waits while the caller is speaking and this long after they stop (default 600), for at most holdMaxMs in all (default 3000). */
  holdGraceMs?: number; holdMaxMs?: number;
}
export interface FastHandler { serve(transport: CallTransport): void; active(): number; idle(): Promise<void> }

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; const WDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const textDay = (date: string): string => `${WDAY[weekdayOf(date)]} ${MON[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
const textTime = (hm: string): string => { const h = Number(hm.slice(0, 2)); return `${h % 12 === 0 ? 12 : h % 12}:${hm.slice(3, 5)} ${h >= 12 ? 'PM' : 'AM'}`; };
const num = (n: number): string => ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'][n] ?? String(n);
const first = (s: string): string => s.trim().split(/\s+/)[0] ?? '';

/** What Jack says, truthfully, when asked whether he is a person or a machine. */
export const AI_ANSWER = "Yes, I'm an A I assistant for Drew Cleaning, not a person. This is a test call.";
interface Awaiting { id: string; text: string; unit: boolean; playing: boolean; heldEarly: boolean; replays: number; reprompts: number; /** The caller asked if this is an A I: the question is repeated only after that answer has played. */ deferred?: boolean; /** The question is waiting for the caller to stop speaking; nothing has been said yet. */ holding?: boolean; ignored?: number; onAnswer: (heard: string) => Promise<void> }

export function createFastCallHandler(deps: FastDeps): FastHandler {
  if (typeof deps !== 'object' || deps === null || !Number.isInteger(deps.maxCalls) || deps.maxCalls < 1 || typeof deps.settings !== 'object' || !(deps.numbers instanceof Set) || !(deps.approvedCallers instanceof Set) || !(deps.approvedCustomerNumbers instanceof Set) || !/^\+[1-9]\d{9,14}$/.test(String(deps.ownerNumber))
    || ['callerOf', 'busy', 'book', 'sendText', 'verifyText', 'now', 'log'].some((k) => typeof (deps as unknown as Record<string, unknown>)[k] !== 'function')) throw new RangeError('the fast call handler needs its dependencies');
  const answerWaitMs = deps.answerWaitMs ?? 12_000; const settleMs = deps.settleMs ?? 3000; const playbackMaxMs = deps.playbackMaxMs ?? 60_000; const afterSpeechMs = deps.afterSpeechMs ?? 400; const holdGraceMs = deps.holdGraceMs ?? 600; const holdMaxMs = deps.holdMaxMs ?? 3000;
  const S = deps.settings; const emailedKeys = new Set<string>(); let active = 0; let accepted = 0; const work = new Set<Promise<unknown>>();

  function serve(t: CallTransport): void {
    if (typeof t.playbackDone !== 'function') { deps.log('FAST_REFUSED', { reason: 'NO_PLAYBACK_MEASURE' }); t.close(1011); return; }   // a carrier that cannot measure playback cannot confirm anything
    if (active > 0 || accepted >= deps.maxCalls) { deps.log('FAST_REFUSED', { reason: active > 0 ? 'BUSY' : 'CAP' }); t.close(1013); return; }
    active++; accepted++;
    const contact: ContactState = createContactState({ cityZip: true });
    const steps: string[] = []; let done = false; let queue: Promise<void> = Promise.resolve();
    let awaiting: Awaiting | undefined; let answerTimer: ReturnType<typeof setTimeout> | undefined; let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let graceOver = true; let graceTimer: ReturnType<typeof setTimeout> | undefined; let holdTimer: ReturnType<typeof setTimeout> | undefined;
    let settleFn: (() => Promise<void>) | undefined; let speakingSince: number | undefined;   // the pending "ask only what is missing", and when the caller last started speaking
    let callSid: unknown; let pref: When = {}; let size: { beds?: number; baths?: number } = {}; let offer: Offer | undefined; const refused: Offer[] = []; let offerTries = 0;
    let caller = ''; let callback = ''; let textsOk = false; let wantsText = false; let firstName = ''; let lastName = ''; let tries = 0;
    const note = (s: string): void => { if (steps.length < 40) steps.push(s); };
    const clearTimers = (): void => { if (answerTimer !== undefined) clearTimeout(answerTimer); if (settleTimer !== undefined) clearTimeout(settleTimer); answerTimer = undefined; settleTimer = undefined; settleFn = undefined; if (holdTimer !== undefined) clearTimeout(holdTimer); holdTimer = undefined; };
    /** True while the voice detection says the caller is speaking. A start that never gets its stop stops counting after ten seconds, so a lost event cannot silence the call for good. */
    const callerSpeaking = (): boolean => speakingSince !== undefined && deps.now() - speakingSince < 10_000;
    const fireSettle = (): void => {
      settleTimer = undefined; const f = settleFn; if (f === undefined || callerSpeaking()) return;   // while the caller speaks it stays pending; the end of their speech starts the wait again
      settleFn = undefined; enqueue(async () => { if (callerSpeaking()) { settleFn = f; return; } await f(); });
    };
    /** True while the caller is speaking and for a short grace after they stop. */
    const callerBusy = (): boolean => callerSpeaking() || !graceOver;
    /** A question is not spoken on top of the caller: it waits until they are quiet (and a short grace has passed), for at most holdMaxMs, then is spoken anyway. Only a number is logged. */
    function holdThenPlay(a: Awaiting, text: string): void {
      let waited = 0; a.holding = true; a.ignored = 0;
      const tick = (): void => {
        holdTimer = undefined; if (done || awaiting !== a) return;
        if (callerBusy() && waited < holdMaxMs) { waited += 25; holdTimer = setTimeout(tick, 25); holdTimer.unref?.(); return; }
        a.holding = false; deps.log('FAST_HOLD', { waitedMs: waited, ignored: a.ignored ?? 0 }); speakIt(a, text);
      };
      holdTimer = setTimeout(tick, 25); holdTimer.unref?.();
    }
    /** Waits `settleMs` of quiet, then runs `fn` (ask only for what is missing). More speech, or any new answer, cancels or postpones it. */
    const armSettle = (fn: () => Promise<void>): void => { if (settleTimer !== undefined) clearTimeout(settleTimer); settleFn = fn; settleTimer = callerSpeaking() ? undefined : setTimeout(fireSettle, settleMs); };
    const enqueue = (fn: () => Promise<void>): void => { const p = (queue = queue.then(async () => { if (!done) await fn(); }).catch(() => { deps.log('FAST_ERROR'); void end('ERROR', 'Sorry, something went wrong, so I will end the call. Goodbye.'); })); const w = p.then(() => undefined); work.add(w); void w.finally(() => work.delete(w)); };

    // ---------------------------------------------------------------- speaking, with the measured playback verdict
    function play(a: Awaiting, text: string): void {
      a.playing = true; a.heldEarly = false;
      if (callerBusy()) { holdThenPlay(a, text); return; }
      speakIt(a, text);
    }
    /** Speaks the question and watches its measured playback. */
    function speakIt(a: Awaiting, text: string): void {
      if (!t.speak(text, true)) { void end('SPEAK_FAILED'); return; }
      deps.log('FAST_SAY', { id: a.id, unit: a.unit });
      void t.playbackDone!(playbackMaxMs).then((v) => enqueue(async () => { if (awaiting !== a || a.deferred === true) return; a.playing = false;
        if (a.unit && (v !== 'played' || a.heldEarly)) {
          a.replays++; deps.log('CONFIRM_REPLAY', { id: a.id, verdict: v, held: a.heldEarly, n: a.replays });
          if (a.replays > 2) return end('UNCONFIRMED', 'I could not confirm that, so I will end the call. Goodbye.');
          return play(a, `Please wait until I have finished, then answer. ${a.text}`);
        }
        armAnswerTimer(a);
      }));
    }
    /** Waits for an answer to something the carrier already said (the opening): nothing is spoken now; silence reprompts once with `text`. */
    function listen(id: string, text: string, onAnswer: Awaiting['onAnswer']): void { clearTimers(); const a: Awaiting = { id, text, unit: false, playing: false, heldEarly: false, replays: 0, reprompts: 0, onAnswer }; awaiting = a; note(id); armAnswerTimer(a); }
    function ask(id: string, text: string, onAnswer: Awaiting['onAnswer'], unit = false): void { clearTimers(); const a: Awaiting = { id, text, unit, playing: true, heldEarly: false, replays: 0, reprompts: 0, onAnswer }; awaiting = a; note(id); play(a, text); }
    function armAnswerTimer(a: Awaiting): void { if (answerTimer !== undefined) clearTimeout(answerTimer); answerTimer = setTimeout(() => enqueue(async () => { if (awaiting !== a || a.playing) return; if (callerSpeaking()) return armAnswerTimer(a); a.reprompts++; deps.log('FAST_SILENCE', { id: a.id, n: a.reprompts }); if (a.reprompts >= 2) return end('NO_ANSWER', 'I am not hearing a reply, so I will end the call. Goodbye.'); play(a, `Sorry, I did not catch that. ${a.text}`); }), answerWaitMs); }
    /** A line that needs no answer, played to its end (its measured verdict is not needed). */
    async function say(text: string): Promise<void> { if (done) return; if (!t.speak(text, true)) return; deps.log('FAST_SAY', { id: 'info', unit: false }); await t.playbackDone!(playbackMaxMs); }
    async function end(reason: string, line?: string, booked = false, extra: Partial<FastOutcome> = {}): Promise<void> {
      if (done) return; done = true; clearTimers(); awaiting = undefined;
      try { if (line !== undefined) { if (t.speak(line, true)) await t.playbackDone!(playbackMaxMs); } } catch { /* the call is going anyway */ }
      deps.log('FAST_END', { reason, booked });
      deps.onOutcome?.({ reason, booked, customerText: 'not_sent', ownerText: 'not_sent', steps, ...extra });
      contact.dispose(); try { t.endCall(); } catch { /* gone */ }
      setTimeout(() => { try { t.close(1000); } catch { /* gone */ } }, afterSpeechMs).unref?.();
    }
    const giveUp = (reason: string): Promise<void> => end(reason, 'Sorry, I am having trouble with that, so a person will follow up. Goodbye.');

    // ---------------------------------------------------------------- the questions
    const nameAnswer = async (heard: string): Promise<void> => {
      const r = contact.collect('name', heard, true);
      if (r.outcome !== 'captured') { if (++tries >= 3) return giveUp('NAME_UNCLEAR'); return askName(true); }
      const words = (contact.value('name') ?? '').split(' '); firstName = words[0]; lastName = words.slice(1).join(' '); tries = 0;
      if (lastName === '') return askLast(); return askAddress();
    };
    function askName(retry = false): void { ask('NAME', retry ? 'Sorry, what is your first and last name?' : 'What is your first and last name?', nameAnswer); }
    /** The greeting the carrier spoke first already asked for the name: nothing is spoken now, and the first thing the caller says is the answer. */
    function listenName(): void { listen('NAME', 'What is your first and last name?', nameAnswer); }
    /** The truthful answer to "are you a person?", at any step; then the question in progress is asked again (a unit after the approved instruction). */
    async function answerAi(): Promise<void> {
      deps.log('FAST_AI_QUESTION');
      const a = awaiting;
      if (!t.speak(AI_ANSWER, true)) return void end('SPEAK_FAILED');
      if (a === undefined) return;   // nothing is being asked (for example the booking is running): the answer is all that is needed
      clearTimers(); a.deferred = true; a.playing = true;
      void t.playbackDone!(playbackMaxMs).then(() => enqueue(async () => { if (awaiting !== a) return; a.deferred = false; a.playing = false; play(a, a.unit ? `Please wait until I have finished, then answer. ${a.text}` : a.text); }));
    }
    function askLast(): void {
      ask('LAST_NAME', 'And your last name?', async (heard) => {
        const r = contact.collect('name', heard, true); const w = (contact.value('name') ?? '').split(' ');
        if (r.outcome !== 'captured' || w.length === 0) { if (++tries >= 3) return giveUp('NAME_UNCLEAR'); return askLast(); }
        lastName = w[w.length - 1]; tries = 0; if (w.length >= 2) firstName = w[0]; return askAddress();
      });
    }
    function askAddress(lead?: string): void {
      const text = lead ?? 'What is the street address, with the city and ZIP code?';
      ask('ADDRESS', text, async (heard) => {
        const r = contact.collect('address', heard);
        if (r.outcome === 'captured') { tries = 0; return askWhen(); }
        if ((r.outcome === 'unclear' || r.reason === 'SAME') && ++tries >= 4) return giveUp('ADDRESS_UNCLEAR');
        // Pieces are kept; wait a moment in case the rest follows, then ask ONLY for what is missing.
        armSettle(async () => {
          const part = contact.addressPart();
          askAddress(part === 'city' ? 'What is the city?' : part === 'ZIP code' ? 'And the ZIP code?' : part === 'street name' ? 'What is the street name?' : part === 'house number' ? 'What is the house number?' : 'Sorry, what is the street address?');
        });
      });
    }
    function askWhen(lead?: string): void {
      ask('WHEN', lead ?? 'What day and time would you like?', async (heard) => {
        const w = whenFrom(heard, deps.now(), S.availability.timezone); const last = lastBookableDate(deps.now(), S.availability);
        // A date that has passed, or lies beyond the days the calendar is read for, is never taken as asked: the caller is told why and asked again.
        if (w.past === true && w.date === undefined) { if (++tries >= 3) return giveUp('WHEN_UNCLEAR'); return askWhen('That date has already passed. Which day would you like?'); }
        if (w.date !== undefined && w.date > last) { if (++tries >= 3) return giveUp('WHEN_UNCLEAR'); return askWhen(`Sorry, I can only book within the next two weeks, up to ${sayDay(last)}. Which day would you like?`); }
        pref = { ...pref, ...w };
        if (pref.date === undefined && pref.time === undefined && pref.part === undefined && pref.flexible !== true) { if (++tries >= 3) return giveUp('WHEN_UNCLEAR'); return armSettle(async () => askWhen('Sorry, which day would you like?')); }
        if (pref.date === undefined) return armSettle(async () => askWhen('Which day?'));
        tries = 0; return size.beds !== undefined && size.baths !== undefined ? checkAndOffer() : askSize();
      });
    }
    function askSize(lead?: string): void {
      ask('SIZE', lead ?? 'How many bedrooms and bathrooms?', async (heard) => {
        const s = sizeFrom(heard);
        if (s.beds !== undefined) size.beds = s.beds; if (s.baths !== undefined) size.baths = s.baths;
        if (s.beds === undefined && s.baths === undefined) {   // a bare "two" answers whichever one was just asked about
          const one = countFrom(heard);
          if (one !== undefined && size.beds !== undefined && size.baths === undefined) size.baths = one; else if (one !== undefined && size.baths !== undefined && size.beds === undefined) size.beds = one;
        }
        if (size.beds === undefined && size.baths === undefined) { if (++tries >= 3) return giveUp('SIZE_UNCLEAR'); return armSettle(async () => askSize('Sorry, how many bedrooms and bathrooms?')); }
        if (size.beds === undefined) return armSettle(async () => askSize('And how many bedrooms?'));
        if (size.baths === undefined) return armSettle(async () => askSize('And how many bathrooms?'));
        tries = 0;
        if (size.beds !== S.bedrooms || size.baths !== S.bathrooms) return end('SIZE_NOT_OFFERED', `Sorry, on this test line I can only book ${num(S.bedrooms)} bedroom, ${num(S.bathrooms)} bathroom homes, so a person will follow up. Goodbye.`);
        return checkAndOffer();
      });
    }
    /** The days the calendar is read for (today through the last bookable date, with a day to spare); nothing is offered or booked outside it. */
    const calendarWindow = (): { from: string; to: string } => ({ from: new Date(deps.now()).toISOString(), to: new Date(deps.now() + (S.availability.horizonDays ?? 14) * 86_400_000 + 86_400_000).toISOString() });
    async function checkAndOffer(): Promise<void> {
      clearTimers(); awaiting = undefined;
      const { from, to } = calendarWindow();
      void say('One moment.');   // spoken while the calendar is read; nothing waits on it
      let cal: { busy: Busy[]; complete: boolean };
      try { cal = await deps.busy(from, to); } catch { cal = { busy: [], complete: false }; }
      if (!cal.complete) { deps.log('FAST_CALENDAR_UNREADABLE'); return end('CALENDAR_UNREADABLE', 'Sorry, I cannot check the schedule right now, so a person will call you to set a time. Goodbye.'); }
      const o = chooseOffer(pref, S.availability, cal.busy, deps.now(), refused);
      if (o === undefined) return end('NO_OPENING', 'Sorry, I do not have an opening in the next two weeks, so a person will call you. Goodbye.');
      offer = o;
      const line = `A standard cleaning for ${num(S.bedrooms)} bedrooms and ${num(S.bathrooms)} bathrooms is ${sayDollars(S.priceDollars)}. We have ${sayDayYear(o.date)} at ${sayTime(o.time)}. Does that work?`;
      ask('OFFER', line, async (heard) => {
        const y = yesNo(heard);
        if (y === 'yes') return askCallback();
        if (y === 'no') { refused.push(o); if (++offerTries >= 2) return end('OFFER_DECLINED', 'No problem. A person will call you to find a time. Goodbye.'); pref = {}; return askWhen('What other day and time would you like?'); }
        return replayUnclear();
      }, true);
    }
    function replayUnclear(): void { const a = awaiting; if (a === undefined) return; if (++a.replays > 2) { void end('UNCONFIRMED', 'I could not confirm that, so I will end the call. Goodbye.'); return; } play(a, `Please say yes or no. ${a.text}`); }
    function askCallback(): void {
      const last4 = caller.slice(-4).split('').join(' ');
      ask('CALLBACK', `I see you are calling from a number ending in ${last4}. Is that the best number to reach you?`, async (heard) => {
        const y = yesNo(heard);
        if (y === 'yes') { callback = caller; return afterNumber(); }
        if (y === 'no') return askNumber();
        return replayUnclear();
      }, true);
    }
    function askNumber(lead?: string): void {
      ask('NUMBER', lead ?? 'What is the best number to reach you?', async (heard) => {
        const r = contact.collect('phone', heard);
        if (r.outcome === 'captured') { const d = contact.value('phone') ?? ''; return confirmNumber(d.length === 10 ? `+1${d}` : d.length === 11 && d.startsWith('1') ? `+${d}` : ''); }
        if (r.outcome === 'unclear' && ++tries >= 4) return giveUp('NUMBER_UNCLEAR');
        const need = contact.phoneNeed();
        armSettle(async () => askNumber(typeof need === 'number' ? `What are the remaining ${need} digits?` : need === 'restate' ? 'Could you say the whole number again, from the start?' : 'Sorry, what is the best number to reach you?'));
      });
    }
    function confirmNumber(e164: string): void {
      if (e164 === '') { contact.clear('phone'); return askNumber('Sorry, I need a ten digit number. What is the best number to reach you?'); }
      ask('NUMBER_CONFIRM', `I heard ${spokenDigits(e164.slice(2))}. Is that right?`, async (heard) => {
        const y = yesNo(heard);
        if (y === 'yes') { callback = e164; return afterNumber(); }
        if (y === 'no') { contact.clear('phone'); if (++tries >= 3) return giveUp('NUMBER_UNCLEAR'); return askNumber(); }
        return replayUnclear();
      }, true);
    }
    /** With texts disabled there is nothing to consent to: the call goes straight to the read-back. */
    function afterNumber(): void { if (deps.textsEnabled) return askTexts(); tries = 0; return finalReadback(); }
    function askTexts(): void {
      tries = 0;
      ask('TEXTS', customerConsentLine(S.businessName), async (heard) => {
        const y = yesNo(heard);
        if (y === 'yes') { wantsText = true; textsOk = await deps.recordConsent({ result: 'yes', script: CUSTOMER_SCRIPT_ID, ref: callRef(callSid) }).catch(() => false); if (!textsOk) deps.log('FAST_CONSENT_NOT_RECORDED'); else note('TEXT_CONSENT_YES'); return finalReadback(); }
        if (y === 'no') { textsOk = false; await deps.recordConsent({ result: 'no', script: CUSTOMER_SCRIPT_ID, ref: callRef(callSid) }).catch(() => false); note('TEXT_CONSENT_NO'); return finalReadback(); }
        return replayUnclear();
      }, true);
    }
    function finalReadback(): void {
      const o = offer!; const p = contact.addressParts();
      if (p === undefined) return void giveUp('ADDRESS_MISSING');
      const spokenZip = p.zip.split('').join(' ');
      ask('READBACK', `To confirm: ${S.serviceLabel} for ${`${firstName} ${lastName}`.trim()} on ${sayDayYear(o.date)} at ${sayTime(o.time)}, at ${p.street}, ${p.city}, ${spokenZip}. The price is ${sayDollars(S.priceDollars)}. Shall I book it? Say yes or no.`, async (heard) => {
        const y = yesNo(heard);
        if (y === 'yes') return book();
        if (y === 'no') return end('DECLINED_AT_READBACK', 'No problem. Nothing was booked. Goodbye.');
        return replayUnclear();
      }, true);
    }

    // ---------------------------------------------------------------- the booking, then the two texts
    async function book(): Promise<void> {
      clearTimers(); awaiting = undefined;
      const o = offer!; const p = contact.addressParts();
      if (p === undefined || !S.standingApproval) return end(S.standingApproval ? 'ADDRESS_MISSING' : 'NO_STANDING_APPROVAL', 'Your request is recorded, and a person will confirm the booking. Goodbye.');
      // Availability is checked once more, from the calendar, right before anything is written: the time must lie inside the window that was read and still be free.
      { const { from, to } = calendarWindow(); let cal: { busy: Busy[]; complete: boolean }; try { cal = await deps.busy(from, to); } catch { cal = { busy: [], complete: false }; }
        const still = cal.complete ? chooseOffer({ date: o.date, time: o.time }, S.availability, cal.busy, deps.now(), []) : undefined;
        if (!cal.complete || still === undefined || still.date !== o.date || still.time !== o.time) {
          deps.log('FAST_SLOT_RECHECK_FAILED', { calendar: cal.complete ? 'read' : 'unreadable' });
          return end(cal.complete ? 'NO_LONGER_AVAILABLE' : 'CALENDAR_UNREADABLE', cal.complete ? 'Sorry, that time is no longer available, so nothing was booked and a person will call you. Goodbye.' : 'Sorry, I cannot check the schedule right now, so nothing was booked and a person will call you. Goodbye.');
        } }
      void say('Booking that now.');
      const digits = callback.replace(/^\+1/, '');
      const req: BookingRequest = {
        key: `fast-${createHash('sha256').update(`drew-fast:${String(callSid)}`).digest('hex').slice(0, 24)}`,
        gate: { eligibleRecord: true, approvedByPerson: true, callerAgreed: true },   // read back, measured and confirmed above; the standing test approval is the founder's, from the settings
        client: { firstName, lastName, phone: digits }, address: { street1: p.street, city: p.city, postalCode: p.zip, ...(S.state === undefined ? {} : { province: S.state }) },
        when: { date: o.date, startTime: o.time, endTime: o.endTime, utcOffset: utcOffsetFor(instantOf(o.date, o.time, S.availability.timezone), S.availability.timezone) },
        title: S.serviceLabel, service: `${S.serviceLabel} ${S.bedrooms} bed ${S.bathrooms} bath`, priceDollars: S.priceDollars,
      };
      let res: BookingResult;
      try { res = await deps.book(req); } catch { res = { status: 'uncertain', reason: 'API_ERROR', writes: 0 }; }
      note(`BOOKING_${res.status.toUpperCase()}`); deps.log('FAST_BOOKING', { status: res.status, ...(res.reason === undefined ? {} : { reason: res.reason }) });
      if (res.status !== 'booked_verified') return end('BOOKING_NOT_VERIFIED', 'I could not confirm the booking, so a person will follow up. Goodbye.');
      // Test emails (default OFF): only now that Jobber's read-back verified the booking, only to the two approved addresses (held behind `sendEmail`), and a failure changes nothing about the booking.
      const mail: { customer: EmailVerdict; owner: EmailVerdict } = { customer: 'not_sent', owner: 'not_sent' };
      if (deps.emailsEnabled === true && deps.sendEmail !== undefined && (res.duplicate === true || emailedKeys.has(req.key))) {
        deps.log('FAST_EMAILS_SKIPPED', { reason: res.duplicate === true ? 'DUPLICATE' : 'ALREADY_SENT' }); note('EMAILS_SKIPPED');   // one booking is never emailed twice
      } else if (deps.emailsEnabled === true && deps.sendEmail !== undefined) {
        emailedKeys.add(req.key);
        const tzE = S.availability.timezone;
        const ef = { businessName: S.businessName, serviceLabel: S.serviceLabel, bedrooms: S.bedrooms, bathrooms: S.bathrooms, priceDollars: S.priceDollars, date: o.date, startText: textTime(o.time), endText: textTime(o.endTime), zoneLabel: zoneLabelOf(tzE, instantOf(o.date, o.time, tzE)),
          address: `${p.street}, ${p.city}${S.state === undefined ? '' : `, ${S.state}`} ${p.zip}`, customerName: `${firstName} ${lastName}`.trim(), callbackNumber: callback, ...(res.jobNumber === undefined ? {} : { jobNumber: res.jobNumber }) };
        const one = async (role: 'customer' | 'owner', m: { subject: string; text: string }): Promise<EmailVerdict> => { try { return (await deps.sendEmail!(role, m.subject, m.text)).ok ? 'accepted' : 'refused'; } catch { return 'refused'; } };
        [mail.customer, mail.owner] = await Promise.all([one('customer', customerEmail(ef)), one('owner', ownerEmail(ef))]);
        deps.log('FAST_EMAILS_SENT', { customer: mail.customer, owner: mail.owner }); note('EMAILS_SENT');
      }
      const mailOutcome: Partial<FastOutcome> = deps.emailsEnabled === true ? { customerEmail: mail.customer, ownerEmail: mail.owner } : {};
      const emailLine = mail.customer === 'accepted' ? ' A confirmation email is on its way.' : '';   // said only when the mail server took it
      if (!deps.textsEnabled) {
        deps.log('FAST_TEXTS_SKIPPED'); note('TEXTS_SKIPPED');
        return end('BOOKED', `You are booked for ${sayDayYear(o.date)} at ${sayTime(o.time)}.${emailLine} Goodbye.`, true, { customerText: 'skipped', ownerText: 'skipped', ...mailOutcome });
      }
      // Texts: the details match the verified booking exactly. Each is sent only to an approved number, the customer's only with permission.
      // The words are the SUBMITTED campaign samples (fast-sms-copy.ts). The customer's text needs the caller's recorded yes; the owner's needs the owner's recorded setup consent. A body over the limit is never cut: it is not sent.
      const tz = S.availability.timezone;
      const facts = { businessName: S.businessName, serviceLabel: S.serviceLabel, bedrooms: S.bedrooms, bathrooms: S.bathrooms, priceDollars: S.priceDollars, dateText: textDay(o.date), startText: textTime(o.time), endText: textTime(o.endTime), zoneLabel: zoneLabelOf(tz, instantOf(o.date, o.time, tz)),
        address: `${p.street}, ${p.city}${S.state === undefined ? '' : `, ${S.state}`} ${p.zip}`, customerName: `${firstName} ${lastName}`.trim() };
      const customerBody = customerText(facts); const ownerBody = ownerText(facts);
      const customerSend = textsOk && customerBody.length <= MAX_TEXT_CHARS && deps.approvedCustomerNumbers.has(callback) ? await deps.sendText(callback, customerBody) : undefined;
      const ownerSend = deps.ownerConsent && ownerBody.length <= MAX_TEXT_CHARS ? await deps.sendText(deps.ownerNumber, ownerBody) : undefined;
      const customerAccepted = customerSend !== undefined && customerSend.ok; const ownerAccepted = ownerSend !== undefined && ownerSend.ok;
      deps.log('FAST_TEXTS_SENT', { customer: customerSend === undefined ? 'not_sent' : customerSend.ok ? 'accepted' : 'refused', owner: ownerSend === undefined ? 'not_sent' : ownerSend.ok ? 'accepted' : 'refused' });
      const bye = `You are booked for ${sayDayYear(o.date)} at ${sayTime(o.time)}.${customerAccepted ? ' A confirmation text is on its way.' : wantsText ? ' I could not send the text on this test line.' : ''}${emailLine} Goodbye.`;
      // Delivery is checked while the goodbye plays and after it; the result goes to the log and the outcome, never to the caller.
      const verifying = Promise.all([customerSend !== undefined && customerSend.ok ? deps.verifyText(customerSend.sid) : Promise.resolve<Delivery | 'not_sent'>('not_sent'), ownerSend !== undefined && ownerSend.ok ? deps.verifyText(ownerSend.sid) : Promise.resolve<Delivery | 'not_sent'>('not_sent')]);
      await end('BOOKED', bye, true, mailOutcome);
      const [c, w] = await verifying; deps.log('FAST_TEXTS_VERIFIED', { customer: c, owner: w });
      deps.onOutcome?.({ reason: 'TEXTS_VERIFIED', booked: true, customerText: c, ownerText: w, ...mailOutcome, steps });
    }

    // ---------------------------------------------------------------- events
    t.onClose = () => { if (!done) { done = true; deps.log('FAST_END', { reason: 'CALLER_HUNG_UP', booked: false }); deps.onOutcome?.({ reason: 'CALLER_HUNG_UP', booked: false, customerText: 'not_sent', ownerText: 'not_sent', steps }); } clearTimers(); contact.dispose(); active = Math.max(0, active - 1); };
    t.onEvent = (ev: TransportEvent): void => {
      if (done) return;
      if (ev.kind === 'setup') {
        callSid = ev.callSid;
        if (typeof ev.to !== 'string' || !deps.numbers.has(ev.to)) { void end('UNKNOWN_NUMBER'); return; }
        enqueue(async () => {
          const from = await deps.callerOf(callSid);
          if (from === undefined || !deps.approvedCallers.has(from)) { deps.log('FAST_CALLER_REFUSED', { verified: from !== undefined }); return end('NOT_APPROVED', 'This is a private test line. Goodbye.'); }
          caller = from; note('CALLER_VERIFIED');
          // The greeting (spoken by the carrier, and confirmed played before this call started) asked for the name: the first thing the caller says is the answer.
          listenName();
        });
        return;
      }
      if (ev.kind === 'utterance') {
        const heard = ev.text;
        // A new utterance cancels a pending "ask the missing part": more of the answer may be following.
        if (settleTimer !== undefined) { clearTimeout(settleTimer); settleTimer = undefined; } settleFn = undefined;
        if (isAiQuestion(heard)) { if (answerTimer !== undefined) { clearTimeout(answerTimer); answerTimer = undefined; } enqueue(async () => answerAi()); return; }   // answered truthfully before anything else, even over a line that is still playing
        const a = awaiting;
        if (a !== undefined && a.unit && a.holding === true) { a.ignored = (a.ignored ?? 0) + 1; return; }   // said before this line was spoken at all: it confirms nothing, and it is not a reason to replay the line
        if (a !== undefined && a.unit && a.playing) { a.heldEarly = true; deps.log('CONFIRM_HELD', { id: a.id }); return; }   // a yes before the whole line was played confirms nothing
        if (answerTimer !== undefined) { clearTimeout(answerTimer); answerTimer = undefined; }
        enqueue(async () => { const cur = awaiting; if (cur === undefined || cur.playing && cur.unit) return; cur.reprompts = 0; await cur.onAnswer(heard); });
        return;
      }
      if (ev.kind === 'speech') {   // the caller is talking: hold back any "ask only what is missing" until they have stopped and the quiet wait has passed
        if (ev.active) { speakingSince = deps.now(); if (settleTimer !== undefined) clearTimeout(settleTimer); settleTimer = settleFn === undefined ? undefined : setTimeout(fireSettle, 10_000 + settleMs); }   // the long timer only matters if the matching stop never arrives
        else { speakingSince = undefined; if (settleFn !== undefined) { if (settleTimer !== undefined) clearTimeout(settleTimer); settleTimer = setTimeout(fireSettle, settleMs); } }
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        if (ev.active) { graceOver = false; graceTimer = setTimeout(() => { graceOver = true; graceTimer = undefined; }, 10_000 + holdGraceMs); }   // the long timer only matters if the matching stop never arrives
        else graceTimer = setTimeout(() => { graceOver = true; graceTimer = undefined; }, holdGraceMs);
        graceTimer.unref?.();
        return;
      }
      if (ev.kind === 'reply_failed') { const a = awaiting; if (a !== undefined) enqueue(async () => { if (awaiting !== a) return; if (++a.replays > 2) return end('REPLY_FAILED', undefined); play(a, a.text); }); return; }
      if (ev.kind === 'speaker_down') { void end('SPEAKER_DOWN'); return; }
    };
  }

  return { serve, active: () => active, async idle(): Promise<void> { while (work.size > 0) await Promise.allSettled([...work]); } };
}
