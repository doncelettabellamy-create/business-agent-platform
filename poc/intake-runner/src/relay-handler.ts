// One phone call over Twilio ConversationRelay (proof of concept, founder test). Ties the pieces together and adds no judgement of its own:
//
//   Twilio `setup`   the dialed number picks the tenant from a server-side table (never from speech); unknown number, kill switch, a call
//                    already running, or a call id seen before -> the call is ended and nothing is processed. The caller's number is not read.
//   first `prompt`   the answer to the spoken consent notice. Not a plain yes -> goodbye, hang up, nothing kept, no model contacted.
//   later `prompt`   masked (pii-screen.ts); a refused utterance ends the call. ONE Intake run over all the masked caller lines is awaited
//                    for every turn (within `previewBudgetMs`). A result that is validated (no `model_failed`) and covers every line so far
//                    is fresh; next-field.ts then chooses, by code, what happens next: read back, ask one named field, clarify, or just listen.
//                    The dialogue model is told that one directive and nothing else. A late, failed or stale result chooses nothing.
//   read-back        when the fresh result is `ready`, the server itself (not the model) reads back the non-address fields in fixed words
//                    and asks for a yes or no, on the same turn. The address is
//                    never spoken, in any form. A yes confirms exactly the item that was read back; a no goes back to listening (at most
//                    two read-backs); anything unclear twice, or silence, ends the call unconfirmed.
//   end of call      the record is saved. CONFIRMED only after a yes to the read-back; every other ending (hang-up, limit, timeout, error,
//                    no) is saved from one final Intake run as UNCONFIRMED: needs-human, not handed off, reason `not_confirmed`. The call
//                    state, with its raw-to-placeholder map, is cleared first. The kill switch ends the call without that final run.
// Nothing here logs speech: log() receives fixed codes and counts only. Raw speech is passed to the masker and dropped.

import { callRefFor, NOT_CONFIRMED, RecordRefused } from './intake-record-store.ts';
import type { IntakeRecord, IntakeRecordStore } from './intake-record-store.ts';
import { createCallSession } from './call-session.ts';
import type { CallSession, SessionLimits } from './call-session.ts';
import { runCallIntake } from './call-intake.ts';
import type { IntakeEntry } from './intake-entry.ts';
import { fallbackText } from './dialogue-model.ts';
import type { ScriptedAsk, ScriptedQuestion } from './scripted-questions.ts';
import type { CallStatus, DialogueModel, Directive } from './dialogue-model.ts';
import { freshFrom, selectNext } from './next-field.ts';
import { CONTACT_FIELDS, spokenDigits } from './contact-capture.ts';
import { createCleaningState, codeOf, kindOf } from './cleaning-state.ts';
import type { EvidenceContext } from './cleaning-state.ts';
import { MAX_CLARIFICATIONS } from './call-state.ts';
import type { ContactField } from './call-state.ts';
import { isBareAnswer, parseFirstClean } from './first-clean.ts';
import { classifyPropertyAnswer, propertyChoiceOf, propertyMentions } from './property-choice.ts';
import type { Contact } from './contact-capture.ts';
import type { AddressState, ContactVault, StoredContact } from './contact-vault.ts';
import type { Fresh } from './next-field.ts';
import type { CloseInfo, RelayConnection } from './ws-server.ts';
import { createConversationRelayTransport } from './call-transport.ts';
import type { CallTransport, TransportEvent } from './call-transport.ts';
import { isRecord } from './contracts.ts';
import type { HandoffEnvelopeV1, ReasonCode, WorkItemV1 } from './contracts.ts';
import { piiProblems } from './pii-screen.ts';

const CALL_SID = /^[A-Za-z0-9]{10,40}$/;
const E164 = /^\+[1-9][0-9]{6,14}$/;
const MAX_READBACKS = 2;
const MAX_HELD_QUESTIONS = 2;   // repeats of the question alone, after a yes that came before it was heard
/** A caller declining to give the address (not merely correcting it). */
const ADDRESS_REFUSAL = /\b(?:rather not|prefer not|not comfortable|refuse|decline)\b|\b(?:do not|don't|dont) want to (?:give|share|say|tell)\b|\b(?:won't|will not|am not going to|not going to|not gonna) (?:give|share|say|tell)\b|\bnot (?:giving|sharing)\b/i;
const MAX_SPEECH_WAIT_MS = 15_000;
const PLAYBACK_MAX_MS = 90_000;
/** The longest one wait for a caller to finish a number or an address may last, and how many turns in a row may skip their question for more speech. */
const DEFAULT_COLLECT_MAX_MS = 8000;
const MAX_SETTLE_SKIPS = 6;
/** Asks forgiven per call because the answer added digits or an address part (a phone number has at most ten digits, so this cannot be exceeded by one number). */
const MAX_PROGRESS_CREDITS = 20;
const PLACEHOLDER = /\[[A-Z]+_\d{1,3}\]/g;
const SENSITIVE_NAME = /\b(?:name|phone|mobile|cell|e-?mail|callback|contact)\b/i;
/** The record's fields with every name, phone, mobile or e-mail field's value replaced by a placeholder. Pure. */
export function redactSensitive(fields: readonly { name: string; value: string | number | boolean | null; confidence: number | null; found: boolean }[]): { name: string; value: string | number | boolean | null; confidence: number | null; found: boolean }[] {
  return fields.map((f) => ({ name: f.name, value: f.found && f.value !== null && SENSITIVE_NAME.test(f.name) ? '[CONTACT_1]' : f.value, confidence: f.confidence, found: f.found }));
}
/** Reason on a confirmed request whose contact could not be stored: it is held for a person. */
export const CONTACT_MISSING = 'contact_missing';
/** Reason on a request saved when the business only serves residential properties and the request is (or was left) commercial: it is held for a person and never handed on. */
export const COMMERCIAL_DECLINED = 'commercial_declined';
/** Reason on a request saved after an item was asked for and still not obtained (the safe incomplete outcome): it is held for a person, never handed off. */
export const INCOMPLETE = 'incomplete_call';
/** The contact items by the fixed label the assistant is told to ask for. */
/** Flags and a digit count only: which contact items are held, and how many digits of a phone number heard in pieces. Never a value. */
const contactFlags = (s: CallSession): { name: number; phone: number; address: number; phoneDigits: number } => { const d = s.contactDiag(); return { name: d.name ? 1 : 0, phone: d.phone ? 1 : 0, address: d.address ? 1 : 0, phoneDigits: d.phoneDigits }; };
/** The caller declining to give an item (not an unclear answer): its pieces are forgotten and it is not pressed in the same way. */
const CONTACT_REFUSAL = /\b(?:rather not|prefer not|do not want|don'?t want|dont want|not comfortable|not giving|won'?t (?:give|say|tell)|no thanks)\b/i;
const CONTACT_OF_LABEL: Readonly<Record<string, ContactField>> = Object.freeze({ [CONTACT_FIELDS.name]: 'name', [CONTACT_FIELDS.phone]: 'phone', [CONTACT_FIELDS.address]: 'address' });
/** Consecutive caller turns on which the dialogue model failed outright (after one retry each) before the call is ended with the apology. */
const MAX_MODEL_FAILURES = 3;
/** Native conversation: the most tool calls one call may make, and the number of refused calls (unknown tool, bad arguments) after which the call ends with the apology. */
const MAX_TOOL_CALLS = 60;
const MAX_TOOL_REFUSALS = 5;

export const SAY = Object.freeze({
  declined: 'No problem. This test line will not continue. Goodbye.',
  unavailable: 'Sorry, this test line is not available right now. Goodbye.',
  trouble: "Sorry, I can't continue this call. Goodbye.",
  refused: "Sorry, I can't continue this call. If this is an emergency, please hang up and dial your local emergency number. Goodbye.",
  limit: 'Thank you. That is all the time I have for this call. Goodbye.',
  thanks: 'Thank you. Your request is recorded. Goodbye.',
  correct: 'Sorry about that. What should I change?',
  question: 'Please say yes or no. Is that correct?',
  yesno: 'Sorry, I did not catch that. Please say yes or no. Is that correct?',
  silence: 'I did not hear a reply. Goodbye.',
  addressAsk: 'I have your service address. Please say yes or no. Is that correct?',   // what the dialogue history keeps: the address itself is never in it
  addressWrong: 'Sorry about that. What is the correct service address?',
  addressMissing: 'I did not catch an address. What is the service address?',
  addressStreet: 'Thank you. What is the street name?',
  addressNumber: 'Thank you. What is the house number?',
  addressRefused: 'Understood. I will not keep an address. Your request is recorded. Goodbye.',
  unconfirmed: 'Thank you. I could not confirm the details. Goodbye.',
  incomplete: 'Thank you. I could not get all the details I need, so I cannot complete this request. Goodbye.',
});

/**
 * The caller's answer to "Is your request for a residential property?" (their MASKED words), by fixed rules: a plain yes is residential, a plain no is commercial, a residential word alone is residential,
 * a commercial word alone is commercial, and anything that mixes the two or says neither is unclear. "No, it's my house" and "yes, it's my office" contradict themselves, so they are unclear too. Pure.
 */
export function residentialAnswer(line: string, commercialWords: readonly string[] = []): 'residential' | 'commercial' | 'unclear' {
  if (typeof line !== 'string' || line.length === 0 || line.length > 400) return 'unclear';
  const t = line.toLowerCase();
  const esc = (s: string): string => s.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const RES = /\b(?:residential|house|houses|home|apartment|apartments|condo|condos|condominium|townhouse|townhome|flat|duplex)\b/;
  const NEG = /\b(?:not|isn't|isnt|is not|aren't|no)\b[^.]{0,20}\b(?:residential|house|home|apartment|condo|townhouse)\b/;
  const COM = new RegExp(`(?<![a-z0-9])(?:commercial|business|company|${commercialWords.map(esc).filter((w) => w.length > 0).join('|') || 'commercial'})(?![a-z0-9])`);
  const neg = NEG.test(t);
  const res = RES.test(t) && !neg;
  const com = COM.test(t) || neg;
  if (/^\s*(?:no|nope|nah)\b/.test(t)) {
    // The leading no is the answer; what follows may contradict it ("no, it's my house").
    const rest = t.replace(/^\s*(?:no|nope|nah)\b[,.\s]*/, '');
    return RES.test(rest) && !NEG.test(rest) && !COM.test(rest) ? 'unclear' : 'commercial';
  }
  if (/^\s*(?:yes|yeah|yep|yup|correct|right|exactly|sure|that's right|that is right)\b/.test(t)) return neg || COM.test(t) ? 'unclear' : 'residential';   // "yes, it's my office" contradicts itself
  if (res && !com) return 'residential';
  if (com && !res) return 'commercial';
  return 'unclear';
}

/** How long a spoken line needs to play: a fixed pad plus a time per character, never more than the cap. Pure. */
export function speechDelayMs(text: string, msPerChar = 70, padMs = 1500): number {
  return Math.min(MAX_SPEECH_WAIT_MS, padMs + text.length * msPerChar);
}

export interface RelayDeps {
  /** Dialed number (E.164) -> tenant. The only way a tenant is chosen. */
  numbers: ReadonlyMap<string, string>;
  /** The category names of the tenant's configuration, offered to a caller whose request was not recognised (never customer data). */
  categoryNames(tenant: string): string[];
  /** The business-configured choices for a field, if the skill gives any. Optional: without it no choices are ever offered. */
  choicesFor?(tenant: string, field: string): readonly string[] | undefined;
  /**
   * The skill's first-cleaning question, if it has one (the field with role first_clean) and whether a category requires it. With it, a plain yes or no counts as the answer
   * ONLY when it follows that very question being asked; explicit wording ("my first cleaning", "not my first") counts wherever it was said, and the newest such answer wins.
   * Optional: without it nothing changes.
   */
  firstClean?: { field: string; required(tenant: string, category: string): boolean;
    /**
     * The question in EXACTLY these words, spoken as a fixed line instead of being worded by the text model (founder-approved 2026-10-28: "Is this your first cleaning with Drew Cleaning?").
     * Yes means first cleaning; no means returning customer. A model-worded question could be phrased the other way round ("have you used us before?"), which reverses what a plain no means.
     */
    question?: string };
  intake: IntakeEntry;
  /** A minted Intake context for this call (the composition root mints it; this file never does). */
  intakeContext(tenant: string, callRef: string): Promise<unknown>;
  dialogue: DialogueModel;
  store: IntakeRecordStore;
  limits: SessionLimits;
  names: readonly string[];
  /** Calls this handler will accept in its lifetime. Setups after that are refused, which bounds what a leaked path and signature could do. */
  maxCalls: number;
  /**
   * RESIDENTIAL-ONLY routing (Drew Cleaning). The categories in `declined` are not offered as services (they are never named in a clarifying question). When Intake classifies a request into one of
   * them the caller is asked the fixed `question` and nothing else happens until they answer: a confirmed residential answer goes on (the words in `keywords` that triggered the commercial
   * classification are neutralised for Intake, so a "home office" is not read as commercial); a commercial answer, or one that stays unclear after a second try, ends the call with the fixed
   * `declineLine`. A declined request is saved unconfirmed with the reason commercial_declined, is never read back, never priced or booked, and never handed on.
   */
  residential?: { declined: readonly string[]; keywords: readonly string[]; question: string; declineLine: string };
  now(): number;
  nowIso(): string;
  killed(): boolean;
  /** The least time to let the last spoken words play after the record is saved (Twilio ends the call as soon as it gets `end`). */
  afterSpeechMs: number;
  /** How long a line needs to play, in milliseconds (see speechDelayMs). The call is not ended before this has passed (capped at 15 s). */
  speechMs(text: string): number;
  /** How long to wait for the caller's yes or no after a read-back before ending the call unconfirmed. It runs from the END of the read-back's playback when the carrier verifies playback, otherwise from the estimated end of its speech. */
  confirmWaitMs: number;
  /** The fields the category requires (every field marked required plus the category's own list). With it, an OPTIONAL field with a known topic is kept only when the caller's own words support it (cleaning-state.ts); without it nothing is policed. */
  requiredFields?(tenant: string, category: string): readonly string[];
  /** The longest to wait for the carrier to report that a read-back finished playing (a bounded failure timeout). Default 90 seconds. */
  playbackMaxMs?: number;
  /**
   * CONTACT COLLECTION SETTLE WINDOW. After a piece of a phone number or an address was heard (one more piece may follow), the call waits until the caller has been quiet for this many milliseconds
   * before it asks again, and asks nothing while a later fragment is already waiting. A caller who says a number in bursts is therefore not talked over, and fragments of one number are merged
   * instead of each being answered. 0 (the default) turns the wait off.
   */
  contactSettleMs?: number;
  /** The longest ONE such wait may last, however much speech keeps arriving (so activity can never hold the call open). Default 8000 ms. */
  contactCollectMaxMs?: number;
  /** Questions spoken in EXACTLY these words (never worded by the text model), by field name; the first-cleaning question is `firstClean.question`. */
  fixedQuestions?: Readonly<Record<string, string>>;
  /**
   * SCRIPTED QUESTIONS (scripted-questions.ts). With it, and while the carrier does not converse natively, EVERY question for a required item (and the category question) is one of the table's fixed sentences,
   * chosen by the field the code selected; the text model never words a request for a required item. Without it nothing changes. The `ASK`/`SCRIPTED_ASK` logs carry the template id (a fixed code), never the words.
   */
  scripted?: { ask(a: ScriptedAsk): ScriptedQuestion; clarify(categories: readonly string[], first: boolean): ScriptedQuestion };
  /** The longest to wait for the Intake run of a turn. A result that misses it chooses nothing; the assistant just listens. */
  previewBudgetMs: number;
  /** The longest the one retry of an EMPTY model reply waits for its first word, in milliseconds (default 4000). After that the server asks in fixed words. */
  replyRetryMs?: number;
  /** The longest the FIRST try at a reply waits for its first word, in milliseconds (default 5000). A model that stalls is treated like an empty reply: one retry, then the fixed wording. */
  replyFirstWordMs?: number;
  /** The longest to wait for the NEXT piece once a reply has started, in milliseconds (default 4000). A reply that stalls is closed where it stands, never repeated, and the server asks the same thing in fixed words. */
  replyGapMs?: number;
  /** The longest a whole reply may take, in milliseconds (default 15000), however steadily it arrives. */
  replyTotalMs?: number;
  /**
   * How long to wait for the carrier's `setup` before giving up on the call, in milliseconds (default 5000, right for ConversationRelay, which sends setup at once). A carrier that speaks the consent notice itself
   * (the OpenAI voice route) sends setup only AFTER the notice has been heard, which takes as long as the notice is long (about 28 seconds for Drew's); with the default the call logic would hang up on a notice
   * that is still being said, after exactly 5 seconds, so that carrier's composition sets this from the notice's length.
   */
  setupTimeoutMs?: number;
  /**
   * The cleaning pilot's encrypted contact vault. When present, a name, a usable callback number and a service address are required before a request
   * is ready, the number is read back with the job, and a yes stores the contact (and only then can the request be handed off). When absent, nothing
   * about contacts changes.
   */
  contacts?: ContactVault;
  /**
   * Called once, after the record is saved, when (and only when) the caller confirmed and the confirmed record is ready and handed off. It receives the ORIGINAL
   * sealed handoff envelope of the very Intake result that was read back, and the tenant and call reference. It is the single seam for a later bridge to Processing;
   * nothing here decides eligibility or uses the envelope. `addressConfirmed` is true only when the caller was read the address back and said yes (never postal validation); it is
   * in memory only and is NOT in the saved record, whose address_status stays `unverified` because that contract has no way to say "confirmed by the caller". The object is never logged or stored. A throw or rejection is caught and logged as a fixed code.
   */
  confirmedHandoff?(handoff: HandoffEnvelopeV1, call: { tenant: string; callRef: string; addressConfirmed: boolean }): unknown;
  /** Fixed codes and counts only. */
  log(code: string, detail?: Record<string, string | number>): void;
}
export interface RelayHandler {
  handle(conn: RelayConnection): void;
  /** Runs one call over any carrier (call-transport.ts). `handle` is this over the ConversationRelay carrier. */
  serve(transport: CallTransport): void;
  active(): number;
  /** Resolves when no call has work in flight (used by the tests and the shutdown path). */
  idle(): Promise<void>;
}

/** One try at a reply (see attemptReply). */
interface Attempt { said: string; chars: number; parts: number; failed: number; threw: boolean; timedOut: boolean; stalled: boolean; aborted: boolean; began: number; firstTokenAt: number | undefined }

/** One Intake result. `handoff` is the original sealed envelope object (in memory only: never logged, stored, copied or sent anywhere). */
interface Preview { item: WorkItemV1; handedOff: boolean; handoff: HandoffEnvelopeV1 | null; /** The server edited the item (put an answer back, took a contradicted or unsupported one out): its sealed handoff no longer describes it, so it is held for a person even when the caller confirms it. */ edited?: boolean }

/** The read-back, in fixed words: the non-address fields only. A placeholder is never spoken, and a value that still looks personal is left out. */
export function readBackText(item: WorkItemV1, phone?: string, name?: string): string {
  const parts: string[] = [];
  for (const f of item.fields) {
    if (!f.found || f.value === null || /address/i.test(f.name)) continue;
    const v = String(f.value).replace(PLACEHOLDER, 'a detail you gave').slice(0, 120).trim();
    if (v.length === 0 || piiProblems(v).length > 0) continue;
    parts.push(`${f.name}: ${v}.`);
  }
  const who = name === undefined ? '' : ` Your name: ${name}.`;
  const callback = phone === undefined ? '' : ` Your callback number: ${spokenDigits(phone)}.`;
  return `Let me check what I have. ${parts.length > 0 ? parts.join(' ') : 'I have your request.'}${who}${callback} Please say yes or no. Is that correct?`;
}

export function createRelayHandler(deps: RelayDeps): RelayHandler {
  const fns = ['categoryNames', 'intakeContext', 'now', 'nowIso', 'killed', 'log', 'speechMs'] as const;
  if (!isRecord(deps) || !(deps.numbers instanceof Map) || !isRecord(deps.intake) || !isRecord(deps.dialogue) || !isRecord(deps.store) || !isRecord(deps.limits)
    || !Array.isArray(deps.names) || !Number.isInteger(deps.afterSpeechMs) || !Number.isInteger(deps.confirmWaitMs) || deps.confirmWaitMs < 1 || !Number.isInteger(deps.previewBudgetMs) || deps.previewBudgetMs < 1 || !Number.isInteger(deps.maxCalls) || deps.maxCalls < 1
    || (deps.playbackMaxMs !== undefined && (!Number.isInteger(deps.playbackMaxMs) || deps.playbackMaxMs < 1))
    || (deps.contactSettleMs !== undefined && (!Number.isInteger(deps.contactSettleMs) || deps.contactSettleMs < 0 || deps.contactSettleMs > 10_000))
    || (deps.contactCollectMaxMs !== undefined && (!Number.isInteger(deps.contactCollectMaxMs) || deps.contactCollectMaxMs < 1 || deps.contactCollectMaxMs > 30_000))
    || (deps.fixedQuestions !== undefined && (typeof deps.fixedQuestions !== 'object' || deps.fixedQuestions === null || Object.values(deps.fixedQuestions).some((q) => typeof q !== 'string' || q.length < 5 || q.length > 200 || /[\r\n[\]<>]/.test(q))))
    || (deps.replyFirstWordMs !== undefined && (!Number.isInteger(deps.replyFirstWordMs) || deps.replyFirstWordMs < 1))
    || (deps.replyGapMs !== undefined && (!Number.isInteger(deps.replyGapMs) || deps.replyGapMs < 1))
    || (deps.replyTotalMs !== undefined && (!Number.isInteger(deps.replyTotalMs) || deps.replyTotalMs < 1))
    || (deps.replyRetryMs !== undefined && (!Number.isInteger(deps.replyRetryMs) || deps.replyRetryMs < 1))
    || (deps.setupTimeoutMs !== undefined && (!Number.isInteger(deps.setupTimeoutMs) || deps.setupTimeoutMs < 1000 || deps.setupTimeoutMs > 300_000))
    || (deps.confirmedHandoff !== undefined && typeof deps.confirmedHandoff !== 'function')
    || (deps.residential !== undefined && (!isRecord(deps.residential) || !Array.isArray(deps.residential.declined) || deps.residential.declined.length < 1 || !deps.residential.declined.every((c) => typeof c === 'string' && c.length > 0)
      || !Array.isArray(deps.residential.keywords) || !deps.residential.keywords.every((k) => typeof k === 'string' && k.trim().length > 0 && k.length <= 64)
      || typeof deps.residential.question !== 'string' || deps.residential.question.length < 10 || deps.residential.question.length > 400
      || typeof deps.residential.declineLine !== 'string' || deps.residential.declineLine.length < 10 || deps.residential.declineLine.length > 400))
    || (deps.contacts !== undefined && (!isRecord(deps.contacts) || typeof deps.contacts.put !== 'function'))
    || !fns.every((f) => typeof (deps as unknown as Record<string, unknown>)[f] === 'function')) {
    throw new RangeError('the relay handler needs every dependency');
  }
  const replyRetryMs = deps.replyRetryMs ?? 4000;
  const replyFirstWordMs = deps.replyFirstWordMs ?? 5000;
  const replyGapMs = deps.replyGapMs ?? 4000;
  const replyTotalMs = deps.replyTotalMs ?? 15_000;
  const setupTimeoutMs = deps.setupTimeoutMs ?? 5000;
  let active = 0;
  let accepted = 0;
  const seen = new Set<string>();
  const work = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>): Promise<T> => { work.add(p); void p.finally(() => work.delete(p)).catch(() => {}); return p; };

  function handle(conn: RelayConnection): void { serve(createConversationRelayTransport(conn)); }

  function serve(carrier: CallTransport): void {
    // All of the carrier's wire format lives in a call-transport implementation: this function sees normalised events and speaks through three methods.
    let session: CallSession | undefined;
    let tenant = '';
    let callId = '';
    let ref = '';
    let ctx: unknown;
    let counted = false;
    let done = false;
    let bad = 0;
    let chain: Promise<unknown> = Promise.resolve();
    let streaming: AbortController | undefined;
    let lastValid: Preview | undefined;   // the newest validated Intake run, kept only to save a record if the final run fails
    let lastValidCovers = 0;
    let previewN = 0;
    const lastAskedAt = new Map<string, number>();   // field -> caller-line count when it was last asked
    let clarified = false;
    // The field the assistant asked about most recently, but ONLY once that question was cleanly delivered (words produced, every write accepted, not cut short by the caller
    // or the end of the call) and not since reported as talked over. Until the caller's next line is read. See speak() and the interrupt handler.
    let activeAsk: string | undefined;
    // Current-call state beyond the rotation (call-state.ts holds the contact values themselves). The contact item just asked for, and whether the question was HEARD: the caller's next line is taken as its
    // answer and validated by the server. How many times each item has been asked AND heard (a question talked over does not count), the model-failure run, and whether this is a correction turn.
    let contactAsk: { field: ContactField; heard: boolean } | undefined;
    const contactRejected = new Map<ContactField, boolean>();   // whether the caller's last answer to a contact item was not usable (selects the situation-specific retry question)
    let partialLabel: string | undefined;   // the contact item being completed (some pieces heard): asked next, before any other item, until it is whole, declined, or its existing limit ends the call
    let lastAsk: { field: string; prevAt: number | undefined; counted: boolean } | undefined;
    const askCount = new Map<string, number>();
    let modelFailures = 0;
    let toolCalls = 0; let toolRefused = 0;   // native conversation: tool calls the voice made, and how many were refused
    let progressCredits = 0;   // asks forgiven because the caller's answer added to what was being collected (at most MAX_PROGRESS_CREDITS per call, so noise cannot keep a question alive for ever)
    let utteranceSeq = 0;   // utterances received so far (a later one waiting means this turn must not talk over it)
    let lastSpeechAt = 0;   // the newest sign that the caller is speaking: an interim result, an utterance or a talk-over
    let settleSkips = 0;   // consecutive turns whose ask was skipped for more speech (bounded)
    let correcting = false;
    let incompleteCall = false;
    let lastReply = '';   // the full text of the assistant's most recent reply, to compare with what the phone provider says was spoken before an interruption
    // PROPERTY TYPE (founder-approved 2026-10-29; this field only). An answer that is not one of the configured choices is asked about ONCE, in fixed words listing the choices; an unambiguous supported answer is accepted;
    // anything else is kept as the caller's own masked words and the record is saved for a person (confirmed, needs-human, never ready or handed off). Nothing is guessed, replaced or normalised, and a negated choice is not accepted.
    const PROPERTY_FIELD = /^property type$/i;
    const property: { field: string | undefined; pending: boolean; asked: boolean; lines: string[]; firstIdx: number | undefined; replyIdx: number | undefined; noted: boolean } = { field: undefined, pending: false, asked: false, lines: [], firstIdx: undefined, replyIdx: undefined, noted: false };
    const CORRECTION_CUE = /\b(?:actually|sorry|correction|i meant|i mean|make that|change (?:that|it)|instead)\b/i;
    let capture: { yes: boolean; text: string } | undefined;   // the caller's newest attributable first-cleaning answer (their own masked words)
    // The cleaning answers accepted so far (cleaning-state.ts): shared by the question choice and the saved record, so a detail once given is never asked for again, a correction replaces it, and a
    // contradiction is asked about instead of the stale value being kept.
    const cleaning = createCleaningState({ exclude: deps.firstClean === undefined ? [] : [deps.firstClean.field] });
    /** The evidence the call holds for an optional field: the category's required fields and the caller's masked lines. Undefined (nothing policed) when the dependency is not given or the category is unknown. */
    const evidenceFor = (category: string, maskedText: string): EvidenceContext | undefined => (deps.requiredFields === undefined || category === 'unknown' ? undefined : { required: new Set(deps.requiredFields(tenant, category)), lines: maskedText.split('\n').map((l) => l.replace(/^Caller: /, '')) });
    let lastCategory = '';
    let incompleteSnap: { item: WorkItemV1; covers: number } | undefined;   // the very pass whose missing list ended the call: the saved record is that pass, so the two agree
    let phase: 'collect' | 'confirm' | 'address' | 'addressfix' = 'collect';
    // The service-address confirmation that follows the first yes when contact capture is on.
    let addressState: AddressState | undefined; let addressTries = 0; let addressUnclear = 0;
    let addressParts = 0;   // how many times only the missing part of the address was asked for after the confirmation step (bounded)
    let lastAddressText = '';
    let readbacks = 0;
    let unclear = 0;
    let heldQuestions = 0;
    let lastSendOk = true;
    const lastSent = (): boolean => lastSendOk;
    let readBack: Preview | undefined;   // exactly what the caller was asked to confirm
    // ONE confirmation flow for the job read-back and the address question. Whatever confirmation speech was sent last is the UNIT: it counts as heard only when the carrier's own playback verdict says every word of it
    // was played to the line (for the voice route: every audio mark acknowledged, nothing cleared, nothing lost). No count of characters or words is ever used for that. A yes that arrives before the unit is
    // heard confirms nothing, and does not become valid later: the unit is spoken again and a fresh yes is required.
    interface Unit { kind: 'job' | 'address' | 'question'; text: string; heard: boolean | undefined; why: string }
    let unit: Unit | undefined;
    let detailsHeard = false;   // the job read-back itself (not a later repeat of its question) was played in full
    let readBackContact: Contact | undefined;   // the contact as it stood when the number was read back: RAW, never logged, never sent to a model, cleared in finish()
    let confirmTimer: ReturnType<typeof setTimeout> | undefined;
    let setupSeen = false;   // a prompt may arrive while setup is still being prepared: it waits behind it
    let hardStop: ReturnType<typeof setTimeout> | undefined;
    // Diagnostics: counts and milliseconds only. Nothing here ever holds, or is derived from, what anyone said.
    const startedAt = deps.now();
    let lastPromptAt: number | undefined;   // when the newest FINAL caller utterance arrived
    let lastReplyEndAt: number | undefined; // when the assistant last finished (or stopped) a reply
    let replies = 0; let failedSends = 0; let partialPrompts = 0; let interrupts = 0; let otherFrames = 0;
    const setupTimer = setTimeout(() => { if (session === undefined) { deps.log('SETUP_TIMEOUT', { waitMs: setupTimeoutMs }); carrier.close(1008); } }, setupTimeoutMs);
    setupTimer.unref?.();

    /** `final` lines end the call, so the caller cannot talk over them. */
    /** What Intake reads: the masked conversation, plus the caller's attributable first-cleaning answer on its own labelled line. */
    // Residential-only routing state: nothing asked yet, the question asked and unanswered, or the caller confirmed a residential property.
    let residential: 'none' | 'asked' | 'residential' = 'none';
    let residentialUnclear = 0;
    let commercialDeclined = false;
    const declined = new Set(deps.residential?.declined ?? []);
    const isDeclined = (category: string): boolean => declined.has(category);
    // The words that made the request look commercial, longest first. After the caller confirms a residential property they are neutralised for Intake ("home office" is a room of a home).
    const trigger = deps.residential === undefined || deps.residential.keywords.length === 0 ? undefined
      : new RegExp(`(?<![A-Za-z0-9])(?:${[...deps.residential.keywords].sort((a, b) => b.length - a.length).map((k) => k.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|')})(?![A-Za-z0-9])`, 'gi');
    const neutral = (text: string): string => (residential === 'residential' && trigger !== undefined ? text.replace(trigger, 'property') : text);
    const intakeText = (s: CallSession): string => { const held = cleaning.lines(); return neutral(s.maskedText() + (held.length > 0 ? `\n${held.join('\n')}` : '')) + (capture !== undefined && deps.firstClean !== undefined ? `\n${deps.firstClean.field}: ${capture.text}` : '') + (property.replyIdx !== undefined && property.field !== undefined && classifyPropertyAnswer(property.lines[property.replyIdx], deps.choicesFor?.(tenant, property.field)) === 'choice' ? `\n${property.field}: ${property.lines[property.replyIdx]}` : ''); };
    /**
     * The property-type guard (see the state above). Applied beside the first-cleaning guard to every Intake result. `canAsk` is false for the final run, which cannot ask anything. A choice returned by Intake is accepted unless the caller's own
     * words say otherwise, wherever they were said: (1) the caller's answer to the property question or to the clarification is negated or names two choices; (2) a LATER line negates that choice ("this is not a house", in the request or in a reply
     * to another question) and no explicit answer settled it since; (3) the caller's answer to the question names a different choice from the one Intake returned (a stale or wrong extraction), unless a later correction follows. A mere,
     * un-negated mention of another property ("my sister has an apartment") never overwrites anything. When the doubt is raised and the clarification has not been asked (and can be), the field is held so it is asked about once; otherwise
     * the caller's own words are kept as said and the item is marked for a person. Any change here means the sealed handoff no longer describes the item, so it is never handed off.
     */
    function guardProperty<T extends { item: WorkItemV1; handoff: HandoffEnvelopeV1 | null; handedOff: boolean; edited?: true }>(g: T, canAsk: boolean): T {
      const field = g.item.fields.find((x) => PROPERTY_FIELD.test(x.name));
      const choices = field === undefined ? undefined : deps.choicesFor?.(tenant, field.name);
      if (field === undefined || choices === undefined || choices.length === 0) return g;
      property.field = field.name;
      const held = field.found && typeof field.value === 'string' ? field.value : undefined;
      const heldKind = held === undefined ? undefined : classifyPropertyAnswer(held, choices);
      const heldChoice = heldKind === 'choice' ? propertyChoiceOf(held, choices) : undefined;
      const lineAt = (i: number | undefined): string | undefined => (i === undefined ? undefined : property.lines[i]);
      const answerIdx = property.asked ? property.replyIdx : property.firstIdx;
      const answerLine = lineAt(answerIdx);
      const lineKind = answerLine === undefined ? undefined : classifyPropertyAnswer(answerLine, choices);
      // The newest explicit answer that settled the property (a supported choice said to the question or to the clarification).
      const settledAt = Math.max(-1, ...[property.firstIdx, property.replyIdx].filter((i): i is number => i !== undefined && classifyPropertyAnswer(property.lines[i], choices) === 'choice'));
      // A later line that negates the choice Intake returned (not an answer line: those are judged above), newest first.
      let contradictionIdx: number | undefined;
      if (heldChoice !== undefined) property.lines.forEach((l, i) => { if (i > settledAt && i !== property.firstIdx && i !== property.replyIdx && propertyMentions(l, choices).negated.includes(heldChoice)) contradictionIdx = i; });
      const contradiction = lineAt(contradictionIdx);
      // The clarification answer against a stale or wrong extraction (unless the caller corrected it afterwards: Intake and the answer state handle corrections).
      const replyLine = lineAt(property.replyIdx);
      const replyChoice = property.asked && replyLine !== undefined ? propertyChoiceOf(replyLine, choices) : undefined;
      const answerChoice = answerLine === undefined ? undefined : propertyChoiceOf(answerLine, choices);
      const corrected = answerIdx !== undefined && property.lines.some((l, i) => i > answerIdx && CORRECTION_CUE.test(l));
      const disagrees = heldChoice !== undefined && answerChoice !== undefined && answerChoice !== heldChoice && !corrected && contradictionIdx === undefined;
      if (heldChoice !== undefined && lineKind !== 'negated' && lineKind !== 'multi' && contradictionIdx === undefined && !disagrees) return g;
      if (held === undefined && replyLine === undefined) return g;   // nothing has been said about it yet
      if (!property.asked && canAsk && held !== undefined && !disagrees && deps.scripted !== undefined && carrier.converse === undefined) {
        if (!property.pending) deps.log('PROPERTY_CLARIFY');
        property.pending = true;
        cleaning.release(field.name);   // the guard's hold is authoritative: an older accepted answer must not be put back over it
        const missing = [field.name, ...g.item.missing_fields.filter((m) => m !== field.name)];
        const reasons = [...new Set([...g.item.reasons, 'missing_fields' as const, 'ambiguous_field' as const])];
        return { ...g, item: { ...g.item, fields: g.item.fields.map((x) => (x === field ? { ...x, value: null, confidence: null, found: false } : x)), missing_fields: missing, reasons, status: 'needs-human' as const }, handoff: null, handedOff: false, edited: true };
      }
      const asWords = (s: string): string => s.replace(/[.!?,;\s]+$/, '');   // the caller's own masked words, without the trailing full stop the read-back adds itself
      const supported = disagrees || (replyChoice !== undefined && (contradictionIdx === undefined || contradictionIdx < (property.replyIdx as number)));
      let value: string;
      if (supported) value = asWords(disagrees ? (answerLine as string) : (replyLine as string));
      else if (heldKind === 'choice' || held === undefined) {   // the choice Intake returned cannot be kept: the caller's newest relevant words are
        const newest = [answerIdx, contradictionIdx].filter((i): i is number => i !== undefined).sort((x, y) => y - x)[0];
        value = newest !== undefined ? asWords(property.lines[newest]) : (held ?? asWords(replyLine as string));
      } else value = held;
      const missing = g.item.missing_fields.filter((m) => m !== field.name);
      let reasons = g.item.reasons.filter((r) => !(r === 'missing_fields' && missing.length === 0));
      if (!supported && !reasons.includes('human_review')) reasons = [...reasons, 'human_review' as const];
      cleaning.release(field.name);   // the value decided here (the caller's words) replaces whatever was accepted before
      if (!property.noted) { property.noted = true; deps.log(supported ? 'PROPERTY_RESOLVED' : 'PROPERTY_UNRESOLVED'); }
      return { ...g, item: { ...g.item, fields: g.item.fields.map((x) => (x === field ? { ...x, value, confidence: x.confidence ?? 0.8, found: true } : x)), missing_fields: missing, reasons, status: reasons.length === 0 ? ('ready' as const) : ('needs-human' as const) }, handoff: null, handedOff: false, edited: true };
    }
    /**
     * The first-cleaning guard. It is also DURABLE: when the caller's own newest attributable answer exists, a pass that omits it or reads something else does not overrule it (see below). A value for the first-cleaning field survives only if it is the caller's newest attributable answer, or explicit wording said with no newer
     * attributable answer. A plain yes or no that no first-cleaning question was asked for, and anything that disagrees with the newest attributable answer, is dropped:
     * the field is not found, the item is held (reason ambiguous_field, and missing_fields when the category requires it) and its handoff is discarded. An unclear answer
     * is kept as said (it is not a yes, and the pricing fixture reads it as unknown).
     */
    function guardFirstClean(item: WorkItemV1, handoff: HandoffEnvelopeV1 | null, handedOff: boolean): { item: WorkItemV1; handoff: HandoffEnvelopeV1 | null; handedOff: boolean; edited?: true } {
      const fc = deps.firstClean;
      if (fc === undefined) return { item, handoff, handedOff };
      const f = item.fields.find((x) => x.name === fc.field);
      if (f === undefined) return { item, handoff, handedOff };
      // DURABLE: the caller's own newest attributable answer is what the call was steered by. A pass that omitted it, returned something unclear, or read a different value does not overrule it (only the caller's
      // own newer answer replaces it, in onPrompt). It is put back as the caller said it, and the item is marked edited: its sealed handoff no longer describes it, so it is held for a person if confirmed.
      if (capture !== undefined && (!f.found || typeof f.value !== 'string' || parseFirstClean(f.value) !== capture.yes)) {
        deps.log('FIRST_CLEAN_RESTORED');
        const missing = item.missing_fields.filter((m) => m !== fc.field);
        const reasons = item.reasons.filter((r) => !(r === 'missing_fields' && missing.length === 0));
        const restored: WorkItemV1 = { ...item, fields: item.fields.map((x) => (x.name === fc.field ? { ...x, value: capture!.text, confidence: x.confidence ?? 0.8, found: true } : x)), missing_fields: missing, reasons, status: reasons.length === 0 ? 'ready' : 'needs-human' };
        return { item: restored, handoff: null, handedOff: false, edited: true };
      }
      if (!f.found || typeof f.value !== 'string') return { item, handoff, handedOff };
      const v = parseFirstClean(f.value);
      const keep = capture !== undefined ? v !== null && v === capture.yes : !isBareAnswer(f.value);
      if (keep) return { item, handoff, handedOff };
      deps.log('FIRST_CLEAN_DROPPED');
      const required = fc.required(tenant, item.category);
      const missing = required && !item.missing_fields.includes(fc.field) ? [...item.missing_fields, fc.field] : [...item.missing_fields];
      const reasons = [...new Set([...item.reasons, ...(required ? ['missing_fields' as const] : []), 'ambiguous_field' as const])];
      const held: WorkItemV1 = { ...item, fields: item.fields.map((x) => (x.name === fc.field ? { ...x, value: null, confidence: null, found: false } : x)), missing_fields: missing, reasons, status: 'needs-human' };
      return { item: held, handoff: null, handedOff: false };
    }

    /** Every outgoing message goes through here so a refused write (the peer gone or too slow) is counted, never silently lost. */
    const tally = (ok: boolean): boolean => { if (!ok) failedSends++; return ok; };
    let lastSay = '';   // the words of the newest fixed line sent (for the speech estimate when the carrier cannot verify playback)
    let confirmGen = 0;   // bumps whenever the confirmation wait is cleared or re-armed, so a late playback report cannot start a stale timer
    const say = (text: string, final = false): boolean => { lastSay = text; lastSendOk = tally(final ? carrier.speak(text, true, { interruptible: false }) : carrier.speak(text, true)); return lastSendOk; };
    const clearConfirmTimer = (): void => { confirmGen++; if (confirmTimer !== undefined) { clearTimeout(confirmTimer); confirmTimer = undefined; } };
    function release(): void {
      clearTimeout(setupTimer);
      clearConfirmTimer();
      if (hardStop !== undefined) clearTimeout(hardStop);
      if (counted) { counted = false; active--; }
    }
    /** Ends the call after the spoken line has had time to play: at least afterSpeechMs, and at least the line's own length from when it was sent. */
    const hangUp = async (spoken?: string, spokeAt?: number): Promise<void> => {
      const need = spoken === undefined ? 0 : Math.min(MAX_SPEECH_WAIT_MS, Math.max(0, deps.speechMs(spoken)));
      const left = need - (spokeAt === undefined ? 0 : deps.now() - spokeAt);
      const wait = Math.max(deps.afterSpeechMs, left);
      if (wait > 0) await new Promise<void>((r) => { setTimeout(r, wait); });
      tally(carrier.endCall()); carrier.close(1000);
    };
    /** A closing line, then the save (while it plays), then the hang-up. */
    async function farewell(line: string, save: boolean): Promise<void> {
      say(line, true);
      const at = deps.now();
      await finish(save);
      await hangUp(line, at);
    }

    /**
     * The save. The state is cleared first so nothing raw or masked outlives the call. With `confirmed`, the record is exactly the item the caller
     * said yes to; otherwise one final Intake run is made, and the record is held for a person whatever that run says.
     */
    async function finish(save: boolean, confirmed?: Preview): Promise<void> {
      try { await finishCall(save, confirmed); } finally { cleaning.dispose(); }
    }
    async function finishCall(save: boolean, confirmed?: Preview): Promise<void> {
      if (done) return;
      done = true;
      release();
      const s = session;
      if (s === undefined) return;
      const text = intakeText(s); const pii = s.piiSummary(); const turns = s.turns();
      const callerText = s.maskedText();   // read before the state is cleared: the evidence the optional-field rule needs
      const fallback = lastValid; lastValid = undefined;
      const confirmedContact = readBackContact; readBackContact = undefined;
      const parts = s.revealContactParts();   // RAW: used only to build the stored contact below
      // A call that ends while the address is being confirmed keeps what the caller already confirmed (the job and the number), with the address marked unconfirmed.
      if (confirmed === undefined && (phase === 'address' || phase === 'addressfix') && readBack !== undefined) { confirmed = readBack; addressState = addressState ?? 'unconfirmed'; }
      // Defence in depth: a request in a category the business does not serve is never saved as confirmed, whatever happened before.
      if (confirmed !== undefined && deps.residential !== undefined && isDeclined(confirmed.item.category)) { deps.log('COMMERCIAL_CONFIRM_BLOCKED'); confirmed = undefined; commercialDeclined = true; }
      let contact: StoredContact | undefined;
      if (confirmed !== undefined && confirmedContact !== undefined) {
        const st: AddressState = addressState ?? 'unconfirmed';
        const address = st === 'refused' ? undefined : parts.address;
        contact = { name: confirmedContact.name, phone: confirmedContact.phone, address_state: st === 'confirmed' && address === undefined ? 'unconfirmed' : st, ...(address !== undefined ? { address } : {}) };
      }
      s.dispose();
      if (!save || turns === 0) { deps.log('CALL_ENDED', { turns, saved: 0 }); return; }
      let w: WorkItemV1; let handedOff: boolean;
      const sealed = confirmed?.handoff ?? null;   // the original object of the confirmed read-back; used only for the confirmedHandoff seam below
      if (confirmed !== undefined) {
        w = confirmed.item; handedOff = confirmed.handedOff;
        // The caller confirmed exactly what was read back, but the server had edited the item (its sealed handoff no longer describes it): it is a CONFIRMED request held for a person, never handed off.
        if (confirmed.edited === true) w = { ...w, status: 'needs-human', reasons: [...new Set([...w.reasons, 'human_review' as ReasonCode])] };
      }
      else if (incompleteSnap !== undefined && incompleteSnap.covers === turns) { w = incompleteSnap.item; handedOff = false; deps.log('FINAL_FROM_LAST_PASS'); }
      else {
        const r = await runCallIntake(deps.intake, ctx, { tenant, callId, tag: 'final', maskedText: text, pii });
        if (r.ok && (fallback === undefined || freshFrom(r.item, 1) !== undefined)) {
          const g = guardProperty(guardFirstClean(r.item, r.handoff, r.handedOff), false);
          // The same accepted answers that steered the call: one an extraction pass omitted is put back, a contradicted one is taken out, and the record is then held for a person (never handed off).
          const ov = cleaning.overlay(g.item, evidenceFor(g.item.category, callerText));
          if (ov.changed) { deps.log('FIELDS_RESTORED', { restored: ov.restored.length, withheld: ov.withheld.length, dropped: ov.dropped.length }); w = ov.item; handedOff = false; } else { w = g.item; handedOff = g.handedOff; }
        }
        else if (fallback !== undefined) {
          // The final run failed or was not validated (`model_failed`). An earlier validated run is still better than a guess or losing the request; it is saved unconfirmed like any other.
          deps.log('FINAL_INTAKE_FAILED', { code: r.ok ? 0 : r.code }); deps.log('FALLBACK_RECORD', { turns });
          w = fallback.item; handedOff = fallback.handedOff;
        } else { deps.log('FINAL_INTAKE_FAILED', { code: r.code }); return; }
      }
      // Contact: stored only after a yes, before the record. A request is not actionable unless its contact is safely stored.
      let contactOk = deps.contacts === undefined;
      if (confirmed !== undefined && deps.contacts !== undefined) {
        if (contact === undefined) deps.log('CONTACT_MISSING');
        else {
          try { deps.contacts.put(tenant, ref, contact); contactOk = true; deps.log('CONTACT_STORED'); }
          catch { deps.log('CONTACT_STORE_FAILED'); }
        }
      }
      const addressStored = confirmed !== undefined && deps.contacts !== undefined && contactOk && contact !== undefined;
      const ok = confirmed !== undefined && w.status === 'ready' && handedOff && contactOk;
      // A request the business routes to a person (human_review) that the caller confirmed is a CONFIRMED request held for a person: never handed off, not "unconfirmed".
      const reviewed = !ok && confirmed !== undefined && contactOk && w.status === 'needs-human' && w.reasons.length > 0 && w.reasons.every((r) => r === 'human_review');
      const found = w.fields.filter((f) => f.found && f.confidence !== null).map((f) => f.confidence as number);
      const record: IntakeRecord = {
        item_id: w.item_id, workspace_id: tenant, call_ref: ref, received_at: deps.nowIso(), category: w.category,
        status: ok ? w.status : 'needs-human',
        reasons: ok || reviewed ? [...w.reasons] : [...new Set([...w.reasons, NOT_CONFIRMED, ...(confirmed !== undefined && !contactOk ? [CONTACT_MISSING] : []), ...(incompleteCall ? [INCOMPLETE] : []), ...(commercialDeclined || (deps.residential !== undefined && isDeclined(w.category) && residential !== 'residential') ? [COMMERCIAL_DECLINED] : [])])], missing_fields: [...w.missing_fields],
        // A field that holds a person's name, number or e-mail never keeps its value in the record, even if the masker missed it (a lower-case name).
        fields: redactSensitive(w.fields),
        pii_summary: w.pii_summary.map((p) => ({ type: p.type, count: p.count })),
        confidence: found.length > 0 ? Math.min(...found) : null, versions: { ...w.versions }, handed_off: ok, turns,
        confirmation: ok || reviewed ? 'confirmed' : 'unconfirmed',
        // An address nobody has checked: one found in a field, or one held in the contact vault for this call (the cleaning skill has no address field).
        // 'caller_confirmed' only when the caller confirmed the address AND the confirmed contact was stored for this call AND the record itself is confirmed; every other held address is
        // 'unverified' (a refused, unanswered, unconfirmed or unstored one included), and 'none' means no address is held. Never a postal check.
        address_status: addressStored && (ok || reviewed) && contact?.address_state === 'confirmed' ? 'caller_confirmed' : w.fields.some((f) => f.found && /address/i.test(f.name)) || addressStored ? 'unverified' : 'none',
      };
      deps.log(ok ? 'CONFIRMED' : reviewed ? 'CONFIRMED_FOR_REVIEW' : 'UNCONFIRMED', { turns });
      let saved = false;
      try { const put = deps.store.put(tenant, record); saved = put === 'new'; deps.log('RECORD_' + put.toUpperCase(), { turns }); }
      catch (e) { deps.log(e instanceof RecordRefused ? 'RECORD_REFUSED' : 'RECORD_FAILED'); }
      if (saved && ok && sealed !== null && deps.confirmedHandoff !== undefined) {
        try { await deps.confirmedHandoff(sealed, { tenant, callRef: ref, addressConfirmed: contact?.address_state === 'confirmed' }); }
        catch { deps.log('HANDOFF_SEAM_FAILED'); }
      }
    }

    /**
     * One Intake run over every caller line so far, awaited for at most `previewBudgetMs`. Returns a preview only when the run finished in time, was
     * validated (not `model_failed`) and covers every line; anything else returns undefined and the turn only listens. A run that finishes late still
     * updates `lastValid` (never backwards), which is used only as a fallback record, never to choose a question.
     */
    async function freshPreview(covers: number): Promise<{ fresh: Fresh; preview: Preview } | undefined> {
      const s = session as CallSession;
      const tag = `p${++previewN % 1000}`;
      const text = intakeText(s); const pii = s.piiSummary();
      const started = deps.now();
      const run = track(runCallIntake(deps.intake, ctx, { tenant, callId, tag, maskedText: text, pii }).then((r) => {
        if (done) return undefined;
        if (!r.ok) { deps.log('PREVIEW_FAILED', { code: r.code }); return undefined; }
        const g = guardProperty(guardFirstClean(r.item, r.handoff, r.handedOff), true);
        const fresh = freshFrom(g.item, covers);
        if (fresh === undefined) { deps.log('PREVIEW_UNUSABLE'); return undefined; }
        const preview: Preview = { item: g.item, handedOff: g.handedOff, handoff: g.handoff, ...(g.edited === true ? { edited: true } : {}) };
        if (covers >= lastValidCovers) { lastValid = preview; lastValidCovers = covers; }
        return { fresh, preview };
      }, () => { deps.log('PREVIEW_FAILED', { code: 0 }); return undefined; }));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), deps.previewBudgetMs); timer.unref?.(); });
      const got = await Promise.race([run, late]);
      if (timer !== undefined) clearTimeout(timer);
      deps.log('TIMING', { preview_ms: Math.max(0, deps.now() - started) });
      if (got === 'late') { deps.log('PREVIEW_BUDGET_EXCEEDED', { budget_ms: deps.previewBudgetMs }); return undefined; }
      return got;
    }

    /** One try at a reply: streams the model's words to the phone as they come. Returns what happened, in counts. `limitMs` bounds the wait for the FIRST word only. */
    /**
     * One native reply: the voice says it in its own words and may call tools meanwhile (each call is answered by onTool). The result is shaped like an ordinary try so the rest of speak() (retry once, the
     * server's fixed words if the voice says nothing, an interruption) is the same. The voice's words are held here only long enough to count them: they are never logged, and only a fixed marker is kept.
     */
    async function attemptNative(directive: Directive, status?: CallStatus): Promise<Attempt> {
      const controller = new AbortController();
      streaming = controller;   // a caller who talks over the reply is handled by the same interrupt path as a streamed one
      const a: Attempt = { said: '', chars: 0, parts: 0, failed: 0, threw: false, timedOut: false, stalled: false, aborted: false, began: deps.now(), firstTokenAt: undefined };
      try {
        const r = await (carrier.converse as NonNullable<CallTransport['converse']>)({ directive, ...(status === undefined ? {} : { status }) });
        a.said = r.said; a.chars = r.said.length; a.parts = r.said.length > 0 ? 1 : 0; a.firstTokenAt = deps.now();
        if (r.interrupted) { a.aborted = true; interruptedText = r.spoken; }
        else if (r.failed || !r.played) { if (a.chars === 0) a.timedOut = true; else a.stalled = true; }
      } catch { a.threw = true; }
      finally { streaming = undefined; lastReplyEndAt = deps.now(); }
      if (controller.signal.aborted) a.aborted = true;
      return a;
    }
    async function attemptReply(directive: Directive, limitMs?: number, status?: CallStatus): Promise<Attempt> {
      const s = session as CallSession;
      const controller = new AbortController();
      streaming = controller;
      const a: Attempt = { said: '', chars: 0, parts: 0, failed: 0, threw: false, timedOut: false, stalled: false, aborted: false, began: deps.now(), firstTokenAt: undefined };
      const send = (token: string, last: boolean): void => { if (!tally(carrier.speak(token, last))) a.failed++; };
      // Three bounds: the first word (`limitMs`), the gap between pieces once words have begun, and the whole reply. Past any of them the try is stopped where it stands.
      const expire = (): void => { if (controller.signal.aborted) return; if (a.chars === 0) a.timedOut = true; else a.stalled = true; controller.abort(); };
      let timer: ReturnType<typeof setTimeout> | undefined; let gap: ReturnType<typeof setTimeout> | undefined;
      if (limitMs !== undefined) { timer = setTimeout(() => { if (a.chars === 0) expire(); }, limitMs); timer.unref?.(); }
      const total = setTimeout(expire, replyTotalMs); total.unref?.();
      const stopped = new Promise<'stop'>((resolve) => { controller.signal.addEventListener('abort', () => resolve('stop'), { once: true }); });
      try {
        const it = deps.dialogue.reply({ turns: s.dialogue(), directive, ...(status === undefined ? {} : { status }), signal: controller.signal })[Symbol.asyncIterator]();
        for (;;) {
          const pending = it.next(); pending.catch(() => {});   // a model that fails after we stopped waiting must not become an unhandled rejection
          const n = await Promise.race([pending, stopped]);
          if (n === 'stop') { void Promise.resolve(it.return?.()).catch(() => {}); break; }   // interrupted or out of time: stop waiting at once, even if the model ignores the signal
          if (n.done) break;
          if (controller.signal.aborted || done) break;
          const piece = n.value;
          if (a.firstTokenAt === undefined) a.firstTokenAt = deps.now();
          a.said += piece; a.chars += piece.length; a.parts++;
          send(piece, false);
          if (gap !== undefined) clearTimeout(gap);
          gap = setTimeout(expire, replyGapMs); gap.unref?.();
        }
        // The end marker closes words that were sent. An empty try sends nothing at all, so a retry or the fixed wording never follows a stray end marker.
        // A reply that stalled after it began is closed the same way, so the words already spoken are not left open.
        if (a.chars > 0 && !done && (!controller.signal.aborted || a.stalled)) send('', true);
      } catch {
        // A model that fails AFTER the caller talked over it (or the wait ran out) is not a failure of the call; any other failure is.
        if (!controller.signal.aborted) a.threw = true;
      } finally { if (timer !== undefined) clearTimeout(timer); if (gap !== undefined) clearTimeout(gap); clearTimeout(total); streaming = undefined; lastReplyEndAt = deps.now(); }
      a.aborted = controller.signal.aborted;
      return a;
    }

    /**
     * Speaks one reply. True only when the reply was produced in full and every write to the socket was accepted: it still cannot prove the phone provider played it.
     * A reply with NO words (the model streamed nothing and did not fail) (or a stall past `replyFirstWordMs` to the first word) is tried once more, for at most `replyRetryMs` to the first word; a refusal (the model's own stop reason) is not retried; if that is empty too, or
     * runs out of time, the server asks the same thing itself in fixed words (fallbackText). Nothing is retried once any word has been sent, so nothing is said twice, and
     * a caller who talks over the reply stops both the retry and the fallback.
     */
    async function speak(directive: Directive, status?: CallStatus): Promise<boolean> {
      const s = session as CallSession;
      // Native conversation: the carrier's voice converses in its own words for this directive (it has `converse`); otherwise the text model words it and the carrier speaks those words.
      const nativeMode = carrier.converse !== undefined;
      const run = (limitMs: number): Promise<Attempt> => (nativeMode ? attemptNative(directive, status) : attemptReply(directive, limitMs, status));
      const began = deps.now();
      // What happened to a try, in numbers: how much was produced, how soon, whether any write was refused. Plus, for an empty try, how the model's stream ended (fixed word and numbers).
      const detailOf = (a: Attempt, extra: Record<string, number | string> = {}): Record<string, number | string> => {
        const d: Record<string, number | string> = { chars: a.chars, parts: a.parts, failed_sends: a.failed, total_ms: Math.max(0, deps.now() - a.began), ...extra };
        if (a.firstTokenAt !== undefined) {
          d.first_token_ms = Math.max(0, a.firstTokenAt - a.began);
          if (lastPromptAt !== undefined) d.since_prompt_ms = Math.max(0, a.firstTokenAt - lastPromptAt);
        }
        return d;
      };
      const modelEnd = (): Record<string, number | string> => {
        const l = deps.dialogue.stats?.last;
        return l === undefined || l === null ? {} : { stop: /^[A-Z_]{1,20}$/.test(String(l.stop)) ? String(l.stop) : 'OTHER', output_tokens: typeof l.output_tokens === 'number' ? l.output_tokens : -1, other_blocks: Number.isInteger(l.other_blocks) ? l.other_blocks : 0 };
      };
      // A refusal is the model's own stop reason on a stream with no words (never inferred from text): retrying the same request is pointless, so it goes straight to the fixed wording.
      const refused = (x: Attempt): boolean => !nativeMode && !x.threw && !x.timedOut && !x.stalled && !x.aborted && modelEnd().stop === 'REFUSAL';
      // The model's own error, as fixed words and a status number (never its message).
      const failure = (a: Attempt): Record<string, number | string> => {
        const errs = deps.dialogue.stats?.errors;
        const l = Array.isArray(errs) && errs.length > 0 ? errs[errs.length - 1] : undefined;
        const name = l === undefined || l === null ? '' : String(l.name ?? '').replace(/[^A-Za-z]+/g, '_').toUpperCase().slice(0, 30);
        return { chars: a.chars, parts: a.parts, failed_sends: a.failed, ...(/^[A-Z_]+$/.test(name) ? { error: name } : {}), ...(l !== undefined && l !== null && typeof l.status === 'number' ? { status: l.status } : {}) };
      };
      let a = await run(replyFirstWordMs);
      let tries = 1;
      if (a.threw && a.chars === 0 && !a.aborted && !done) {
        // A transient model error: nothing was said, so one more try is safe.
        deps.log('DIALOGUE_FAILED', failure(a));
        deps.log('REPLY_RETRY');
        a = await run(replyRetryMs);
        tries = 2;
      } else if (!a.threw && (!a.aborted || a.timedOut) && !done && a.chars === 0 && !refused(a)) {
        deps.log('REPLY_EMPTY', detailOf(a, { attempt: 1, timed_out: a.timedOut ? 1 : 0, ...modelEnd() }));
        deps.log('REPLY_RETRY');
        a = await run(replyRetryMs);
        tries = 2;
      }
      replies++;
      if (a.threw) {
        deps.log('DIALOGUE_FAILED', failure(a));
        modelFailures++;
        // The call goes on in the server's fixed words; only a run of failed turns ends it.
        if (done || modelFailures >= MAX_MODEL_FAILURES) {
          if (!done) await farewell(SAY.trouble, true);
          return false;
        }
      } else if (a.chars > 0) modelFailures = 0;
      if (refused(a)) {
        // The model itself declined (its own stop reason, never inferred from text). The request is not retried and intake does not simply carry on: whatever words were produced
        // have been closed, a fixed goodbye with the emergency line is said, and the call is saved unconfirmed.
        deps.log('REPLY_REFUSED', detailOf(a, { attempts: tries, ...modelEnd() }));
        if (a.failed > 0) deps.log('REPLY_SEND_FAILED', { failed_sends: a.failed });
        if (!done) await farewell(SAY.refused, true);
        return false;
      }
      const empty = a.chars === 0 && !done && (!a.aborted || a.timedOut);
      const detail = detailOf(a, { attempts: tries, ...(empty ? { attempt: tries, timed_out: a.timedOut ? 1 : 0, ...modelEnd() } : {}), ...(a.stalled ? { stalled: 1 } : {}) });
      if (a.aborted && !a.timedOut && !a.stalled) deps.log('REPLY_INTERRUPTED', detail);
      else if (done) deps.log('REPLY_CUT', detail);
      else if (a.threw) { /* DIALOGUE_FAILED was logged above */ }
      else if (a.stalled) deps.log('REPLY_STALLED', detail);
      else if (empty) deps.log('REPLY_EMPTY', detail);
      else deps.log('REPLY_SENT', detail);
      if (a.failed > 0) deps.log('REPLY_SEND_FAILED', { failed_sends: a.failed });
      if (done) return false;
      if (empty || a.stalled || a.threw) {
        // Nothing was said, or the reply stopped part-way (its words are closed and are never repeated or kept as a question): the server asks the same thing in fixed words, and keeps only those in the dialogue history.
        const text = fallbackText(directive);
        if (!say(text)) {
          // Not even this could be sent: the connection is not carrying words. The request is saved unconfirmed and the call is ended.
          deps.log('REPLY_FALLBACK_FAILED', { total_ms: Math.max(0, deps.now() - began) });
          await finish(true);
          await hangUp();
          return false;
        }
        deps.log('REPLY_FALLBACK_SENT', { chars: text.length, total_ms: Math.max(0, deps.now() - began) });
        s.said(text); lastReply = text;
        return true;
      }
      if (nativeMode) s.saidMasked(a.said); else s.said(a.said);
      if (a.aborted) { s.interrupted(interruptedText); interruptedText = ''; return false; }
      lastReply = a.said;
      return a.chars > 0 && a.failed === 0;
    }
    let interruptedText = '';

    /**
     * Waits for the caller's yes or no. The wait is for SILENCE after the question: it starts when the question has finished playing (verified by the carrier when it can say so, bounded by
     * playbackMaxMs; otherwise from the estimated end of its speech), never while the caller is still being read to. A caller who speaks clears it (onPrompt).
     */
    function armConfirmTimer(): void {
      clearConfirmTimer();
      const gen = confirmGen;
      const begin = (waitMs: number): void => {
        if (gen !== confirmGen || done) return;
        confirmTimer = setTimeout(() => {
          chain = chain.then(async () => {
            if (done || phase === 'collect') return;
            deps.log('CONFIRM_TIMEOUT');
            await farewell(SAY.silence, true);
          }).catch(() => deps.log('HANDLER_ERROR'));
          void track(chain);
        }, waitMs);
        confirmTimer.unref?.();
      };
      if (typeof carrier.playbackDone === 'function') {
        // The carrier bounds its own report; this bound is the handler's own, so a carrier that never answers cannot hold the call open either.
        const max = deps.playbackMaxMs ?? PLAYBACK_MAX_MS;
        let guard: ReturnType<typeof setTimeout> | undefined;
        const bounded = Promise.race([carrier.playbackDone(max), new Promise<'timeout'>((resolve) => { guard = setTimeout(() => resolve('timeout'), max + 500); guard.unref?.(); })]);
        bounded.then((outcome) => {
          if (guard !== undefined) clearTimeout(guard);
          if (gen !== confirmGen || done) return;
          const m = carrier.playbackMeasure?.();   // the carrier's measurement of the newest reply, when it has one (numbers only)
          deps.log('PLAYBACK_SETTLED', { outcome: outcome === 'played' ? 'PLAYED' : outcome === 'cut' ? 'CUT' : 'TIMEOUT', ...(m === undefined ? {} : { sent_ms: m.sentMs, acked_ms: m.ackedMs }) });
          begin(deps.confirmWaitMs);
        }, () => { if (guard !== undefined) clearTimeout(guard); begin(deps.confirmWaitMs); });
        return;
      }
      begin(deps.confirmWaitMs + (lastSay === '' ? 0 : Math.min(MAX_SPEECH_WAIT_MS, Math.max(0, deps.speechMs(lastSay)))));
    }

    const flatText = (x: string): string => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    function markHeard(u: Unit, heard: boolean, why: string): void {
      if (u.heard !== undefined && !(u.heard === true && !heard)) return;   // a verdict is only ever made worse after the fact (a cut), never better
      u.heard = heard; u.why = heard ? '' : why;
      if (u.kind === 'job') detailsHeard = heard;
    }
    /**
     * Opens the confirmation unit for speech just sent. With a carrier that verifies playback the verdict is the carrier's own (played to the line in full, or not); with one that cannot, a sent unit counts
     * as heard until an interruption report shows otherwise. Never a count of characters.
     */
    function openUnit(kind: Unit['kind'], text: string, sent: boolean): void {
      const u: Unit = { kind, text, heard: undefined, why: '' };
      unit = u;
      if (kind === 'job') detailsHeard = false;
      if (!sent) { markHeard(u, false, 'LOST'); return; }
      if (typeof carrier.playbackDone !== 'function') { markHeard(u, true, ''); return; }
      const max = deps.playbackMaxMs ?? PLAYBACK_MAX_MS;
      let guard: ReturnType<typeof setTimeout> | undefined;
      const bounded = Promise.race([carrier.playbackDone(max), new Promise<'timeout'>((resolve) => { guard = setTimeout(() => resolve('timeout'), max + 500); guard.unref?.(); })]);
      const settle = (o: 'played' | 'cut' | 'timeout'): void => {
        if (guard !== undefined) clearTimeout(guard);
        if (unit !== u) return;
        const m = carrier.playbackMeasure?.();   // the carrier's measurement of this unit's speech: audio milliseconds sent and acknowledged (numbers only)
        deps.log('CONFIRM_UNIT', { kind: u.kind.toUpperCase(), outcome: o === 'played' ? 'PLAYED' : o === 'cut' ? 'CUT' : 'TIMEOUT', ...(m === undefined ? {} : { sent_ms: m.sentMs, acked_ms: m.ackedMs }) });
        markHeard(u, o === 'played', o === 'cut' ? 'CUT' : 'TIMEOUT');
      };
      bounded.then(settle, () => settle('timeout'));
    }
    /** A yes that arrived before the unit was heard: it confirms nothing and is not kept. Fixed codes only. */
    function logHeld(why: string): void {
      const m = carrier.playbackMeasure?.();   // the newest finished reply's measurement (numbers only), so the log shows how much of the unit reached the line
      deps.log('CONFIRM_HELD', { kind: (unit?.kind ?? 'job').toUpperCase(), why, ...(m === undefined ? {} : { sent_ms: m.sentMs, acked_ms: m.ackedMs }) });
    }

    function startReadback(item: Preview): void {
      const s = session as CallSession;
      phase = 'confirm'; readbacks++; unclear = 0; readBack = item;
      readBackContact = deps.contacts === undefined ? undefined : s.revealContact();
      // The caller hears the number; the dialogue history (which goes to the model on later turns) gets the same words WITHOUT it.
      // Words that could not be sent were never heard: a yes cannot confirm them, and the history does not claim they were said. The next answer sends them again (up to the same limit).
      const sent = say(readBackText(item.item, readBackContact?.phone, readBackContact?.name));
      openUnit('job', readBackText(item.item), sent);
      if (sent) s.said(readBackText(item.item));
      deps.log('READBACK', { n: readbacks });
      if (!sent) deps.log('READBACK_NOT_SENT');
      armConfirmTimer();
    }

    /** Reads the captured service address back to the caller (over the phone only) and asks for a yes or no. The dialogue history keeps a version without the address. */
    function askAddress(): void {
      const s = session as CallSession;
      const address = s.revealContactParts().address;
      if (address === undefined) { phase = 'addressfix'; say(SAY.addressMissing); s.said(SAY.addressMissing); armConfirmTimer(); return; }
      phase = 'address';
      lastAddressText = `I have your service address as ${address}. Please say yes or no. Is that correct?`;
      openUnit('address', lastAddressText, say(lastAddressText));   // a refused write is never heard
      s.said(SAY.addressAsk);
      deps.log('ADDRESS_READBACK', { n: addressTries + 1 });
      armConfirmTimer();
    }
    async function finishAddress(state: AddressState): Promise<void> {
      addressState = state;
      deps.log(state === 'confirmed' ? 'ADDRESS_CONFIRMED' : state === 'refused' ? 'ADDRESS_REFUSED' : 'ADDRESS_UNCONFIRMED');
      const line = state === 'refused' ? SAY.addressRefused : SAY.thanks;
      say(line, true);
      const at = deps.now();
      await finish(true, readBack);
      return await hangUp(line, at);
    }
    async function onAddressAnswer(line: string, heardFirst: boolean): Promise<void> {
      const s = session as CallSession;
      if (ADDRESS_REFUSAL.test(line)) return await finishAddress('refused');
      const a = s.answer(line);
      if (a === 'yes' && !heardFirst) {   // a yes before the whole question was played to the line confirms nothing, now or later: the question is asked again and a fresh yes is needed
        logHeld(unit?.why || 'EARLY'); deps.log('ADDRESS_ANSWER_IGNORED');
        if (++addressUnclear > 1) return await finishAddress('unconfirmed');
        askAddress();
        return;
      }
      if (a === 'yes') return await finishAddress('confirmed');
      if (a === 'no') {
        if (++addressTries > 2) { s.forgetAddress(); return await finishAddress('unconfirmed'); }   // the caller said this address is wrong: it is not kept
        deps.log('ADDRESS_CORRECTION', { n: addressTries });
        s.forgetAddress(); phase = 'addressfix'; unit = undefined; addressUnclear = 0;
        say(SAY.addressWrong); s.said(SAY.addressWrong); armConfirmTimer();
        return;
      }
      if (++addressUnclear > 1) return await finishAddress('unconfirmed');
      askAddress();
    }
    async function onAddressFix(line: string): Promise<void> {
      const s = session as CallSession;
      if (ADDRESS_REFUSAL.test(line)) return await finishAddress('refused');
      if (s.revealContactParts().address !== undefined) { addressUnclear = 0; askAddress(); return; }
      // One part of the address was heard on its own: it is kept and only the missing part is asked for (a few times at most, so this can never go on for ever).
      const part = s.addressPart();
      if (part !== undefined && ++addressParts <= 3) { const line = part === 'street name' ? SAY.addressStreet : SAY.addressNumber; say(line); s.said(line); armConfirmTimer(); return; }
      if (++addressUnclear > 1) return await finishAddress('unconfirmed');
      say(SAY.addressMissing); s.said(SAY.addressMissing); armConfirmTimer();
    }

    async function onAnswer(line: string, heardFirst: boolean): Promise<void> {
      const s = session as CallSession;
      const a = s.answer(line);
      if (a === 'yes' && !heardFirst && readBack !== undefined) {
        // A yes before the read-back and its question were played in full (or one that was never sent) confirms nothing, and does not become valid later. If the details themselves were heard and only a repeat of
        // the question was cut, only the question is asked again; otherwise the read-back is said again, up to the same limits. Either way a fresh yes is needed.
        logHeld(unit?.why || 'EARLY'); deps.log('READBACK_NOT_HEARD');
        if (detailsHeard) {
          if (++heldQuestions > MAX_HELD_QUESTIONS) return await farewell(SAY.unconfirmed, true);
          say(SAY.question); openUnit('question', SAY.question, lastSent()); s.said(SAY.question); armConfirmTimer();
          return;
        }
        if (readbacks >= MAX_READBACKS) return await farewell(SAY.unconfirmed, true);
        startReadback(readBack);
        return;
      }
      if (a === 'yes' && deps.contacts !== undefined && readBackContact !== undefined) { addressTries = 0; addressUnclear = 0; addressState = undefined; askAddress(); return; }
      if (a === 'yes') {
        const item = readBack;
        say(SAY.thanks, true);
        const at = deps.now();
        await finish(true, item);
        return await hangUp(SAY.thanks, at);
      }
      if (a === 'no') {
        if (readbacks >= MAX_READBACKS) return await farewell(SAY.unconfirmed, true);
        phase = 'collect'; readBack = undefined; readBackContact = undefined;   // the next turn makes a fresh Intake run over everything, correction included
        correcting = true;   // a name, number or address the caller states next (with "my name is ...", "my number is ...") replaces the one read back
        say(SAY.correct); s.said(SAY.correct);
        return;
      }
      if (++unclear > 1) return await farewell(SAY.unconfirmed, true);
      say(SAY.yesno); openUnit('question', SAY.yesno, lastSent()); s.said(SAY.yesno);
      armConfirmTimer();
    }

    /**
     * Waits until the caller has been quiet for `contactSettleMs` after the newest sign of speech, for at most `contactCollectMaxMs`. Returns 'MORE' at once when a later utterance is already waiting or
     * arrives meanwhile (that turn is handled next and nothing is asked now), 'QUIET' when the caller stopped, 'MAX' when the bound was reached while speech kept coming.
     */
    async function settleForMoreSpeech(idx: number, since?: number): Promise<'MORE' | 'QUIET' | 'MAX'> {
      const settle = deps.contactSettleMs ?? 0;
      if (settle <= 0) return utteranceSeq !== idx ? 'MORE' : 'QUIET';
      const max = deps.contactCollectMaxMs ?? DEFAULT_COLLECT_MAX_MS;
      const began = since ?? deps.now();
      for (;;) {
        if (done) return 'QUIET';
        if (utteranceSeq !== idx) return 'MORE';
        const now = deps.now();
        const quietFor = now - lastSpeechAt;
        if (quietFor >= settle) return 'QUIET';
        if (now - began >= max) return 'MAX';
        await new Promise<void>((resolve) => { const t = setTimeout(resolve, Math.max(1, Math.min(settle - quietFor, max - (now - began), 100))); t.unref?.(); });
      }
    }

    async function onPrompt(raw: unknown, idx = utteranceSeq, unitOk = false): Promise<void> {
      const s = session;
      if (s === undefined || done) return;
      clearConfirmTimer();
      const turnStart = deps.now();
      if (s.state === 'consent') {
        if (s.consent(raw) === 'declined') { await farewell(SAY.declined, false); return; }
        deps.log('CONSENT_GRANTED');
        return speak({ kind: 'open' });
      }
      const limit = s.limit();
      if (limit === 'KILLED') { await farewell(SAY.unavailable, false); return; }
      if (limit !== null) { await farewell(SAY.limit, true); return; }   // the cap is reached BEFORE this utterance is taken in
      // The caller's line is the answer to the contact question that was just asked (server-validated, whether or not a masking rule would recognise it).
      const expecting: ContactField | undefined = phase === 'addressfix' ? 'address' : phase === 'collect' && deps.contacts !== undefined ? contactAsk?.field : undefined;
      const heard = s.hear(raw, expecting, phase === 'collect' && correcting);
      if (!heard.ok) { deps.log('UTTERANCE_REFUSED', { code: heard.code }); await farewell(SAY.trouble, true); return; }
      if (phase === 'confirm') return onAnswer(heard.line, unitOk);
      if (phase === 'address') return onAddressAnswer(heard.line, unitOk);
      if (phase === 'addressfix') return onAddressFix(heard.line);
      let madeProgress = false;   // this turn ADDED to what is being collected (more digits, or the missing part of an address): it is never a failed attempt
      const askedBefore = contactAsk;
      if (contactAsk !== undefined) {
        const took = heard.contact?.find((c) => c.field === contactAsk?.field);
        madeProgress = took?.outcome === 'partial' && (took.reason === 'PIECE' || took.reason === 'NEED_STREET' || took.reason === 'NEED_NUMBER');
        // A number said in pieces is progress, not a failed attempt: the question is not counted against the item (once per ask; the credits per call are bounded, and a piece that adds nothing earns none).
        if (madeProgress && lastAsk?.counted && progressCredits < MAX_PROGRESS_CREDITS) { progressCredits++; askCount.set(lastAsk.field, Math.max(0, (askCount.get(lastAsk.field) ?? 1) - 1)); lastAsk.counted = false; }
        // Privacy-safe: the item's label, a fixed reason code and digit COUNTS (this line, and held after it). Never a value, a word of the caller's or a transcript.
        deps.log('CONTACT_ANSWER', { field: contactAsk.field.toUpperCase(), outcome: took === undefined ? 0 : took.outcome === 'captured' ? 1 : took.outcome === 'partial' ? 2 : 3, reason: took?.reason ?? 'NOT_HEARD', heard: contactAsk.heard ? 1 : 0, ...(contactAsk.field === 'phone' ? { digits: took?.digits ?? 0, held: took?.total ?? s.contactDiag().phoneDigits } : {}), n: askCount.get(CONTACT_FIELDS[contactAsk.field]) ?? 0 });
        contactRejected.set(contactAsk.field, took === undefined || took.outcome === 'unclear');
        // A caller who declines to go on with that item ("I'd rather not give my number") ends its completion: the pieces held are forgotten, and the item goes back to the ordinary rotation and its limit.
        if (CONTACT_REFUSAL.test(heard.line)) { s.abandonPartial(contactAsk.field); deps.log('CONTACT_DECLINED', { field: contactAsk.field.toUpperCase() }); }
        contactAsk = undefined;
      }
      partialLabel = s.phoneNeed() !== undefined && s.contactDiag().phoneDigits > 0 ? CONTACT_FIELDS.phone : s.addressPart() !== undefined ? CONTACT_FIELDS.address : s.phoneNeed() === 'restate' ? CONTACT_FIELDS.phone : undefined;
      // The caller added to a number or an address that is not whole yet: wait for them to finish before asking again (bounded). Later speech already waiting, or arriving meanwhile, is handled next
      // and nothing is said now; the same item stays the one being answered.
      if (madeProgress && partialLabel !== undefined && deps.contactSettleMs !== undefined && deps.contactSettleMs > 0) {
        const waited = await settleForMoreSpeech(idx);
        if (done) return;
        if (waited === 'MORE' && settleSkips < MAX_SETTLE_SKIPS) { settleSkips++; contactAsk = askedBefore; deps.log('CONTACT_SETTLE', { outcome: 'MORE', skips: settleSkips }); return; }
        deps.log('CONTACT_SETTLE', { outcome: waited === 'MORE' ? 'MAX' : waited, skips: settleSkips });
        settleSkips = 0;
      } else settleSkips = 0;
      correcting = false; lastAsk = undefined;
      // Residential-only routing: the answer to the residential question is read before anything else happens on this turn.
      if (deps.residential !== undefined && residential === 'asked') {
        const verdict = residentialAnswer(heard.line, deps.residential.keywords);
        if (verdict === 'commercial') return await declineCommercial('COMMERCIAL_CONFIRMED');
        if (verdict === 'unclear') {
          if (++residentialUnclear > 1) return await declineCommercial('COMMERCIAL_UNRESOLVED');
          deps.log('RESIDENTIAL_REASK');
          askResidential(); return;
        }
        residential = 'residential'; deps.log('RESIDENTIAL_CONFIRMED');
      }
      if (deps.firstClean !== undefined) {
        // A plain yes or no is the answer to the first-cleaning question only if that was the question just asked; explicit wording counts anywhere. The newest one wins.
        const answer = parseFirstClean(heard.line);
        if (answer !== null && (activeAsk === deps.firstClean.field || !isBareAnswer(heard.line))) capture = { yes: answer, text: heard.line.trim().slice(0, 80) };
      }
      // The caller's line is the answer to the cleaning question that was just asked and cleanly delivered, when it plausibly is one (a vague or off-topic reply is not stored and the question is asked again).
      // Every caller line, in order (masked, bounded): the property guard looks for a negation or a different choice wherever it was said. The answer to the property question and to the clarification are remembered by position.
      if (property.lines.length < 80) property.lines.push(heard.line.trim().slice(0, 200));
      if (activeAsk !== undefined && PROPERTY_FIELD.test(activeAsk) && property.lines.length > 0) {
        if (!property.asked) { if (property.firstIdx === undefined) property.firstIdx = property.lines.length - 1; }
        else if (property.replyIdx === undefined) property.replyIdx = property.lines.length - 1;
      }
      if (activeAsk !== undefined && CONTACT_OF_LABEL[activeAsk] === undefined && activeAsk !== deps.firstClean?.field) {
        const b = cleaning.bind(activeAsk, heard.line);
        // Fixed codes and two counts only: the selected field, the verdict, the branch that gave it (why), the kind of field and the size of the MASKED reply the classifier was given (characters, words). The counts describe
        // that line; they are not proof that it matches what the caller said or what any transcript shows. No caller word, digit or value is ever logged.
        deps.log('FIELD_ANSWER', { field: codeOf(activeAsk), result: b === 'bound' ? 'BOUND' : b === 'ambiguous' ? 'AMBIGUOUS' : 'UNCHECKED', why: cleaning.lastBind()?.why ?? 'NONE', kind: kindOf(activeAsk).toUpperCase(), chars: heard.line.length, words: heard.line.trim().split(/\s+/).filter((w) => w.length > 0).length });
      }
      const activeBefore = activeAsk;
      activeAsk = undefined;
      const covers = s.turns();
      let got = await freshPreview(covers);
      if (done) return;
      if (got !== undefined) {
        const evidence = evidenceFor(got.preview.item.category, s.maskedText());
        const m = cleaning.merge(got.preview.item, heard.line, evidence);
        if (m.unsupported.length > 0) deps.log('FIELD_UNSUPPORTED', { n: m.unsupported.length, f1: codeOf(m.unsupported[0]) });
        if (m.corrected.length > 0) deps.log('FIELD_CORRECTED', { n: m.corrected.length, f1: codeOf(m.corrected[0]) });
        if (m.conflicts.length > 0) deps.log('FIELD_CONFLICT', { n: m.conflicts.length, f1: codeOf(m.conflicts[0]) });
        const cat = got.preview.item.category;
        if (cat !== lastCategory) { deps.log('CATEGORY', { to: codeOf(cat), from: codeOf(lastCategory) }); lastCategory = cat; }
        const ov = cleaning.overlay(got.preview.item, evidence);
        if (ov.changed) {
          deps.log('FIELDS_RESTORED', { restored: ov.restored.length, withheld: ov.withheld.length, dropped: ov.dropped.length, ...(ov.dropped[0] !== undefined ? { f1: codeOf(ov.dropped[0]) } : {}) });
          const patched: Preview = { item: ov.item, handedOff: false, handoff: null, edited: true };
          const nf = freshFrom(ov.item, covers);
          if (nf !== undefined) { got = { fresh: nf, preview: patched }; if (covers >= lastValidCovers) { lastValid = patched; lastValidCovers = covers; } }
        }
      }
      // With the contact vault on, the three contact items are required too: they are added to what is missing, by code, from this turn's lines.
      let fresh = got?.fresh;
      if (fresh !== undefined && deps.contacts !== undefined) {
        const need = s.contactMissing();
        fresh = { ...fresh, missing: [...fresh.missing, ...need], ready: fresh.ready && need.length === 0 };
      }
      // A request Intake classified into a category the business does not serve. Until the caller confirms a residential property nothing else is asked, read back, priced, booked or handed on. If it is
      // still that category after they have confirmed (the wording could not be neutralised), it is declined rather than guessed at.
      if (deps.residential !== undefined && fresh !== undefined && fresh.covers === covers && isDeclined(fresh.category)) {
        if (residential === 'residential') return await declineCommercial('COMMERCIAL_REMAINS');
        if (residential === 'none') { residential = 'asked'; deps.log('RESIDENTIAL_ASK'); askResidential(); return; }
      }
      const next = selectNext(fresh, covers, { lastAskedAt, clarified, ...(partialLabel !== undefined ? { keep: partialLabel } : property.pending && !property.asked && property.field !== undefined ? { keep: property.field } : {}) });
      // The preview above takes seconds. Immediately before anything is spoken, look again: a later utterance already waiting (or, while a number or address is still being given, speech that resumed
      // after the quiet window) makes this question stale. It is not said; the waiting line is handled next, as a continuation of the same item. Bounded like the first wait.
      if (next.kind !== 'ready' && !done) {
        const again = madeProgress && partialLabel !== undefined && (deps.contactSettleMs ?? 0) > 0 ? await settleForMoreSpeech(idx, turnStart) : utteranceSeq !== idx ? 'MORE' : 'QUIET';
        if (done) return;
        if (again === 'MORE' && settleSkips < MAX_SETTLE_SKIPS) { settleSkips++; contactAsk = askedBefore; activeAsk = activeBefore; deps.log('CONTACT_SETTLE', { outcome: 'MORE', stage: 'AFTER_PREVIEW', skips: settleSkips }); return; }
        if (again === 'MAX') deps.log('CONTACT_SETTLE', { outcome: 'MAX', stage: 'AFTER_PREVIEW', skips: settleSkips });
      }
      if (next.kind === 'ready' && got !== undefined) return startReadback(got.preview);
      if (next.kind === 'ask') {
        // An item asked and heard the first time plus MAX_CLARIFICATIONS more times and still not obtained: the call ends as a safe incomplete outcome, saved unconfirmed, never handed off.
        if (!madeProgress && (askCount.get(next.field) ?? 0) >= 1 + MAX_CLARIFICATIONS) {
          const gone = fresh?.missing ?? [];
          deps.log('INCOMPLETE', { clarifications: MAX_CLARIFICATIONS, lines: covers, item: (CONTACT_OF_LABEL[next.field] ?? 'content').toUpperCase(), field: codeOf(next.field), cat: codeOf(fresh?.category), miss: gone.length, ...(gone[0] !== undefined ? { m1: codeOf(gone[0]) } : {}), ...(gone[1] !== undefined ? { m2: codeOf(gone[1]) } : {}), ...(gone[2] !== undefined ? { m3: codeOf(gone[2]) } : {}), ...contactFlags(s) });
          if (got !== undefined) incompleteSnap = { item: got.preview.item, covers };
          incompleteCall = true;
          await farewell(SAY.incomplete, true);
          return;
        }
        const prevAt = lastAskedAt.get(next.field);
        lastAskedAt.set(next.field, covers);
        deps.log('ASK', { again: next.again ? 1 : 0, lines: covers, item: ((deps.contacts === undefined ? undefined : CONTACT_OF_LABEL[next.field]) ?? 'content').toUpperCase(), n: (askCount.get(next.field) ?? 0) + 1, field: codeOf(next.field), cat: codeOf(fresh?.category), ...(deps.contacts !== undefined && CONTACT_OF_LABEL[next.field] === 'phone' && s.phoneNeed() !== undefined ? { need: s.phoneNeed() === 'restate' ? 0 : Number(s.phoneNeed()) } : {}) });
        const choices = deps.choicesFor?.(tenant, next.field);
        // After one part of the service address was heard (a house number without a street name, or the reverse) only the missing part is asked for.
        const part = deps.contacts !== undefined && CONTACT_OF_LABEL[next.field] === 'address' ? s.addressPart() : undefined;
        // Part of a phone number was heard: the question asks for the digits still needed (a COUNT, never a digit), or for the whole number again when the pieces did not fit together.
        const phoneNeed = deps.contacts !== undefined && CONTACT_OF_LABEL[next.field] === 'phone' ? s.phoneNeed() : undefined;
        // Scripted turn control: a question for a required item is a fixed sentence chosen by the selected field (scripted-questions.ts), never the text model's wording. Native conversation keeps its own voice.
        const contactField0 = deps.contacts === undefined ? undefined : CONTACT_OF_LABEL[next.field];
        const own = deps.fixedQuestions?.[next.field] ?? (deps.firstClean !== undefined && next.field === deps.firstClean.field ? deps.firstClean.question : undefined);
        const tpl: ScriptedQuestion | undefined = own === undefined && deps.scripted !== undefined && carrier.converse === undefined
          ? deps.scripted.ask({ field: next.field, ...(choices !== undefined && choices.length > 0 ? { choices } : {}), ...(part !== undefined ? { part } : {}), ...(phoneNeed !== undefined ? { phone: phoneNeed } : {}), ...(property.pending && !property.asked && PROPERTY_FIELD.test(next.field) ? { clarify: true } : {}), rejected: contactField0 !== undefined && contactRejected.get(contactField0) === true })
          : undefined;
        const fixed = own ?? tpl?.text;
        let delivered: boolean;
        if (fixed !== undefined) {
          // A fixed question is never reworded: the same words on every ask (a repeat does not become a different question), spoken as written, kept in the dialogue history as said. It offers no
          // weekday, no availability and no confirmation: it only asks.
          delivered = say(fixed);
          if (delivered) { s.said(fixed); lastReply = fixed; deps.log(tpl !== undefined ? 'SCRIPTED_ASK' : deps.firstClean !== undefined && next.field === deps.firstClean.field ? 'FIRST_CLEAN_ASKED' : 'FIXED_QUESTION_ASKED', { field: codeOf(next.field), ...(tpl !== undefined ? { tpl: tpl.id } : {}) }); } else deps.log('REPLY_SEND_FAILED', { failed_sends: 1 });
        } else delivered = await speak({ kind: 'ask', field: next.field, again: next.again, ...(choices !== undefined && choices.length > 0 ? { choices } : {}), ...(part !== undefined ? { part } : {}), ...(phoneNeed !== undefined ? { phone: phoneNeed } : {}) }, statusOf(s, got));
        // Only a question that was actually produced and sent in full counts as asked, and can make the caller's next plain yes or no an answer to it.
        if (delivered) { askCount.set(next.field, (askCount.get(next.field) ?? 0) + 1); lastAsk = { field: next.field, prevAt, counted: true }; }
        else { if (prevAt === undefined) lastAskedAt.delete(next.field); else lastAskedAt.set(next.field, prevAt); }
        if (delivered && tpl?.id === 'JOB_PROPERTY_TYPE_CLARIFY') { property.asked = true; property.pending = false; }   // asked once, and only once it was actually delivered
        const contactField = deps.contacts === undefined ? undefined : CONTACT_OF_LABEL[next.field];
        if (contactField !== undefined) contactAsk = { field: contactField, heard: delivered };
        activeAsk = delivered ? next.field : undefined;
        return;
      }
      if (next.kind === 'clarify') {
        clarified = true;
        deps.log('CLARIFY', { first: next.first ? 1 : 0, lines: covers });
        if (deps.scripted !== undefined && carrier.converse === undefined) {
          const q = deps.scripted.clarify(deps.categoryNames(tenant).filter((c) => c !== 'unknown' && !isDeclined(c)), next.first);
          if (say(q.text)) { s.said(q.text); lastReply = q.text; deps.log('SCRIPTED_ASK', { field: 'CATEGORY', tpl: q.id }); } else deps.log('REPLY_SEND_FAILED', { failed_sends: 1 });
          return;
        }
        return speak(next.first ? { kind: 'clarify', categories: deps.categoryNames(tenant).filter((c) => c !== 'unknown' && !isDeclined(c)) } : { kind: 'clarify' });
      }
      deps.log('LISTEN', { lines: covers });
      return speak({ kind: 'listen' }, statusOf(s, got));
    }

    /** The fixed residential question, in exactly the configured words. Nothing else is said on this turn. */
    function askResidential(): void {
      const s = session as CallSession;
      const q = (deps.residential as NonNullable<RelayDeps['residential']>).question;
      say(q); s.said(q); lastReply = q;
    }
    /** Ends the call because the request is commercial (or could not be confirmed residential): a fixed goodbye, saved unconfirmed with the reason, never read back, priced, booked or handed on. */
    async function declineCommercial(code: string): Promise<void> {
      deps.log(code);
      commercialDeclined = true;
      await farewell((deps.residential as NonNullable<RelayDeps['residential']>).declineLine, true);
    }

    /**
     * A tool the voice asked for (native conversation). EVERY call is validated by the session (call-state.ts): an unknown tool, bad arguments, a call before consent or after the end, or too many calls
     * is refused with a fixed code. The answer to the voice holds labels and an outcome word only, never what the caller gave. A run of refused calls ends the call (safe recovery); the count is bounded.
     */
    function onTool(ev: { callId: string; name: string; args: unknown }): void {
      toolCalls++;
      const s = session;
      const r: ReturnType<CallSession['tool']> = s === undefined || done ? { ok: false, code: 'NOT_ACTIVE' } : toolCalls > MAX_TOOL_CALLS ? { ok: false, code: 'TOO_MANY' } : s.tool(ev.name, ev.args);
      if (!r.ok) toolRefused++;
      deps.log('TOOL', { ok: r.ok ? 1 : 0, calls: toolCalls, refused: toolRefused });
      const out = r.ok ? { ok: true, outcome: r.outcome, captured: r.captured, missing: r.missing } : { ok: false, code: r.code };
      if (carrier.toolResult?.(ev.callId, JSON.stringify(out)) !== true) deps.log('TOOL_ANSWER_NOT_SENT');
      if (toolRefused >= MAX_TOOL_REFUSALS && !done) {
        deps.log('TOOLS_REFUSED_TOO_OFTEN', { refused: toolRefused });
        chain = chain.then(async () => { if (!done) await farewell(SAY.trouble, true); }).catch(() => deps.log('HANDLER_ERROR'));
        void track(chain);
      }
    }

    /** What the server holds and still needs, as field names only (never a value), for the voice: captured contact items and found Intake fields, and what is still missing. */
    function statusOf(s: CallSession, got: { fresh: Fresh; preview: Preview } | undefined): CallStatus | undefined {
      const contact = deps.contacts === undefined ? { captured: [] as string[], missing: [] as string[] } : s.contactStatus();
      const found = got === undefined ? [] : got.preview.item.fields.filter((f) => f.found && !SENSITIVE_NAME.test(f.name)).map((f) => f.name);
      const missing = [...(got === undefined ? [] : got.fresh.missing), ...contact.missing];
      const captured = [...found, ...contact.captured];
      return captured.length === 0 && missing.length === 0 ? undefined : { captured, missing: [...new Set(missing)] };
    }

    async function onSetup(m: Record<string, unknown>): Promise<void> {
      clearTimeout(setupTimer);
      const to = m.to; const sid = m.callSid;
      const t = typeof to === 'string' && E164.test(to) ? deps.numbers.get(to) : undefined;
      if (t === undefined || typeof sid !== 'string' || !CALL_SID.test(sid)) { deps.log('SETUP_REFUSED'); done = true; return await hangUp(); }
      if (deps.killed()) { deps.log('KILLED'); done = true; say(SAY.unavailable, true); return await hangUp(SAY.unavailable, deps.now()); }
      if (accepted >= deps.maxCalls) { deps.log('CALL_BUDGET'); done = true; return await hangUp(); }
      const r = callRefFor(t, sid);
      if (active >= 1 || seen.has(r)) { deps.log(active >= 1 ? 'BUSY' : 'REPLAY'); done = true; return await hangUp(); }
      try { if (deps.store.list(t).some((x) => x.call_ref === r)) { deps.log('REPLAY'); done = true; return await hangUp(); } }
      catch { deps.log('STORE_UNAVAILABLE'); done = true; return await hangUp(); }
      seen.add(r); accepted++; active++; counted = true;
      tenant = t; callId = sid; ref = r;
      try { ctx = await deps.intakeContext(t, r); } catch { deps.log('CONTEXT_FAILED'); done = true; release(); return await hangUp(); }
      session = createCallSession({ limits: deps.limits, names: deps.names, now: deps.now, killed: deps.killed });
      hardStop = setTimeout(() => { void track(finish(true).then(() => hangUp())); }, (deps.limits.maxMinutes + 1) * 60_000);
      hardStop.unref?.();
      deps.log('CALL_STARTED');
    }

    carrier.onEvent = (ev: TransportEvent): void => {
      if (ev.kind === 'malformed') { if (++bad > 5) carrier.close(1008); return; }
      if (ev.kind === 'interrupt') {
        interrupts++; lastSpeechAt = deps.now();
        const spoken = ev.spoken;
        if (streaming !== undefined) { interruptedText = spoken; streaming.abort(); }
        else {
          // The reply had been sent, but the caller talked over it. Unless the phone provider reports that all of it was spoken, the question cannot be assumed heard.
          const flat = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          const fully = flat(lastReply).length > 0 && flat(spoken).length >= flat(lastReply).length;
          if (activeAsk !== undefined && !fully) activeAsk = undefined;
          if (!fully && lastAsk !== undefined && lastAsk.counted) {
            // The question was talked over before it was heard: it does not count as asked, and the rotation puts it back.
            askCount.set(lastAsk.field, Math.max(0, (askCount.get(lastAsk.field) ?? 1) - 1));
            if (lastAsk.prevAt === undefined) lastAskedAt.delete(lastAsk.field); else lastAskedAt.set(lastAsk.field, lastAsk.prevAt);
            lastAsk.counted = false;
            if (contactAsk !== undefined) contactAsk.heard = false;
          }
          // A confirmation unit that is not yet heard and is talked over was cut. With a carrier that verifies playback that is the whole story; a carrier that cannot says only what was spoken, and then the
          // provider's own report must cover the unit's words.
          if (unit !== undefined && unit.heard !== false) {
            if (typeof carrier.playbackDone === 'function') { if (unit.heard === undefined) markHeard(unit, false, 'CUT'); }
            else if (!(flatText(unit.text).length > 0 && flatText(spoken).length >= flatText(unit.text).length)) { unit.heard = undefined; markHeard(unit, false, 'CUT'); }
          }
          session?.interrupted(spoken);
        }
        return;
      }
      if (ev.kind === 'setup') { if (!setupSeen && !done) { setupSeen = true; chain = chain.then(() => onSetup({ to: ev.to, callSid: ev.callSid })).catch(() => deps.log('HANDLER_ERROR')); } return; }
      if (!setupSeen) { if (++bad > 5) carrier.close(1008); return; }
      if (ev.kind === 'tool') { onTool(ev); return; }
      if (ev.kind === 'reply_failed') {
        // A question the caller did not hear is not delivered: nothing may treat their next plain yes or no as its answer.
        failedSends++; deps.log('REPLY_NOT_PLAYED');
        activeAsk = undefined;
        if (unit !== undefined && unit.heard !== false) { unit.heard = undefined; markHeard(unit, false, 'LOST'); }
        return;
      }
      if (ev.kind === 'partial') { partialPrompts++; lastSpeechAt = deps.now(); return; }   // a partial result is not acted on, but it is counted, and it shows the caller is still speaking
      if (ev.kind === 'utterance') {
        lastPromptAt = deps.now(); lastSpeechAt = lastPromptAt;
        const heard = ev.text; const idx = ++utteranceSeq;
        const unitOk = unit?.heard === true;   // judged NOW, when the caller's line arrived: a unit that finishes playing later does not rescue an earlier yes
        clearConfirmTimer();   // an answer is on its way: the silence timer must not win the race against it
        chain = chain.then(() => onPrompt(heard, idx, unitOk)).catch(() => deps.log('HANDLER_ERROR'));
        void track(chain);
        return;
      }
      // keypad digits, error and anything else: not used. The carrier's own error text is never logged.
      otherFrames++;
      if (ev.kind === 'error') deps.log('TWILIO_ERROR');
    };
    carrier.onClose = (info?: CloseInfo): void => {
      // One line per connection, whoever ended it: who closed (a fixed word), the WebSocket close code, how long since the last caller utterance and the last reply, and counts.
      const now = deps.now();
      deps.log('CALL_CLOSED', {
        by: info?.cause ?? 'PEER', code: info?.code ?? 0, since_prompt_ms: Math.max(0, now - (lastPromptAt ?? startedAt)), since_reply_ms: Math.max(0, now - (lastReplyEndAt ?? startedAt)),
        mid_reply: streaming === undefined ? 0 : 1, replies, failed_sends: failedSends, partial_prompts: partialPrompts, interrupts, other_frames: otherFrames,
      });
      void track(chain.then(async () => { if (!done) await finish(!deps.killed()); release(); }).catch(() => deps.log('HANDLER_ERROR')));
    };
  }

  return Object.freeze({
    handle,
    serve,
    active: () => active,
    async idle(): Promise<void> { while (work.size > 0) await Promise.allSettled([...work]); },
  });
}
