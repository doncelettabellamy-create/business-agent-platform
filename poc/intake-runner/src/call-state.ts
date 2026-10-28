// Server-validated contact state for ONE call (proof of concept, founder test). PURE: no I/O, no clock, no model, no randomness.
//
// This is contact CAPTURE, kept apart from privacy MASKING (pii-screen.ts). Masking decides what a text model may read; it is a set of rules that cannot tell a
// bare "Sam" or a street without a suffix from an ordinary word. Capture decides what the caller GAVE when the assistant asked for a name, a callback number or a
// service address: the next caller line is the answer to the question that was asked, and the server validates it. The model never writes this state.
//
// The three tools (collect_name, collect_phone, collect_address) and the two helpers (correct_contact, call_status) in `runContactTool` are the whole surface a
// native Realtime conversation may use for contact details. There is no pricing, booking or hand-off tool here, and an unknown tool name is refused.
//
//   name     1 to 4 words of letters, apostrophes and hyphens; a lead-in ("my name is", "it's", "this is") is stripped; function words, yes/no and anything with a digit are refused.
//            A later name REPLACES an earlier one (a correction).
//   phone    10 to 15 digits, spoken or written. A caller may give it in pieces across answers: the digits are joined until there are enough (progress, not a failure); a whole
//            number said again replaces the pieces; too many digits start over.
//   address  5 to 120 characters with a street number (digits or number words) and at least one more word, or a PO box. Never postal validation: the caller confirms it aloud.
//
// The values are RAW personal data held in memory for one call. They leave only to the caller over the phone (read-back) and to the encrypted vault after a yes.

import { digitsOf, phoneDigits, CONTACT_FIELDS } from './contact-capture.ts';

export type ContactField = 'name' | 'phone' | 'address';
export const CONTACT_FIELD_KEYS: readonly ContactField[] = Object.freeze(['name', 'phone', 'address'] as ContactField[]);
/** How many times a still-missing item may be asked AGAIN after the first ask before the call ends as a safe incomplete outcome. */
export const MAX_CLARIFICATIONS = 2;

export type CollectOutcome = 'captured' | 'partial' | 'unclear';
/**
 * Why a capture turned out as it did: a FIXED code, safe to log (it names a rule, never a value).
 *   CAPTURED          the item was taken.            PIECE            a phone piece was joined to the digits held so far.
 *   MERGED            the new piece repeated the end of the digits held and exactly ONE reading makes a whole number: the repeated digits are said once.   SAME   the piece restated the digits already held: nothing changes.
 *   AMBIGUOUS         the pieces cannot be fitted together (too many digits, or more than one reading): the held digits are forgotten and the caller is asked for the whole number again. No number is guessed.
 *   RESTART           (no longer produced; kept for old logs) the pieces could not make a phone number (a repeated prefix, a stray digit word): the held digits were dropped and this piece started over.
 *   CORRECTED_LAST4   "the last four are ...": the final four digits of the number held were replaced.
 *   NOT_DIGITS        the line carries a date, a time, a duration or another quantity ("October 22", "six months", "9:30"): its digits are not phone digits and are not taken.
 *   NO_DIGITS         the line held no digit words.   TOO_MANY         more than fifteen digits: start over.
 *   NOT_A_NAME        not a usable name.              NO_STREET_NUMBER an address line without a street number.   NOT_AN_ADDRESS  not a usable address.
 *   NEED_STREET       a house number was heard without a street name: it is held and only the street name is asked.   NEED_NUMBER   a street name without a house number.   JOINED   the held part and the new part made the address.
 *   INACTIVE          the call state was already closed.
 */
export type CollectReason = 'CAPTURED' | 'PIECE' | 'MERGED' | 'SAME' | 'AMBIGUOUS' | 'NOT_DIGITS' | 'RESTART' | 'CORRECTED_LAST4' | 'NO_DIGITS' | 'TOO_MANY' | 'NOT_A_NAME' | 'NO_STREET_NUMBER' | 'NOT_AN_ADDRESS' | 'NEED_STREET' | 'NEED_NUMBER' | 'JOINED' | 'INACTIVE';
export interface CollectResult {
  readonly field: ContactField;
  readonly outcome: CollectOutcome;
  /** Raw pieces the masker must also learn (so they are masked in this and later lines). Never logged, never sent to a model. */
  readonly learn: readonly string[];
  /** A fixed reason code (never a value). */
  readonly reason?: CollectReason;
  /** Phone only: how many digits this line held, and how many are held after it (a count, never the digits). */
  readonly digits?: number;
  readonly total?: number;
}
export interface ContactStatus { readonly captured: readonly string[]; readonly missing: readonly string[] }

const FILLER = new Set(['i', 'im', "i'm", 'is', 'my', 'the', 'an', 'to', 'for', 'with', 'that', 'this', 'it', 'what', 'why', 'how', 'no', 'yes', 'not', 'dont', "don't", 'do', 'can', 'would', 'um', 'uh', 'hello', 'hi', 'okay', 'ok', 'number', 'address', 'phone', 'name', 'sorry', 'please', 'thanks', 'thank', 'rather', 'prefer', 'know', 'none', 'nothing', 'sure', 'well', 'wait', 'actually', 'correct', 'wrong',
  // words of a cleaning request that are never a person's name
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'bedroom', 'bedrooms', 'bathroom', 'bathrooms', 'house', 'apartment', 'condo', 'townhouse', 'cleaning', 'clean', 'deep', 'standard', 'pet', 'pets', 'dog', 'dogs', 'cat', 'cats', 'extras', 'rooms', 'room', 'today', 'tomorrow', 'morning', 'afternoon', 'evening', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'weekly', 'monthly', 'once', 'twice', 'later']);
const NAME_WORD = /^[\p{L}][\p{L}'’-]{0,29}$/u;
const NAME_LEAD = /^(?:(?:no|yes|yeah|well|um|uh|okay|ok|sure|so|hi|hello)[,.\s]+)*(?:(?:my|the)\s+name(?:'s|\s+is)?\s+|name(?:'s|\s+is)\s+|it(?:'s|\s+is)\s+|this\s+is\s+|i\s+am\s+|i'm\s+|call\s+me\s+|actually[,\s]+(?:it(?:'s|\s+is)\s+)?|that(?:'s|\s+is)\s+)?/i;
const NAME_TAIL = /[\s,.]*(?:please|thanks|thank you|is my name)?[\s,.!?]*$/i;
const NUM_WORD = '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|(?:thir|four|fif|six|seven|eigh|nine)teen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)';
const ADDRESS_LEAD = /^(?:(?:no|yes|yeah|well|um|uh|okay|ok|sure|so)[,.\s]+)*(?:(?:my|the)\s+(?:service\s+)?address\s+(?:is|:)\s+|(?:service\s+)?address\s+(?:is|:)\s+|i\s+live\s+(?:at|on)\s+|it(?:'s|\s+is)\s+(?:at\s+)?|located\s+at\s+|that(?:'s|\s+is)\s+|at\s+|actually[,\s]+(?:it(?:'s|\s+is)\s+)?)?/i;
const ADDRESS_TAIL = /[\s,.]*(?:please|thanks|thank you)?[\s,.!?]*$/i;
const PO_BOX = /\bp\.?\s?o\.?\s+box\s+\w+/i;
const ADDRESS_NUMBER = new RegExp(`(?:\\b\\d{1,6}\\b|\\b${NUM_WORD}\\b)`, 'i');

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();
/** Where a name stops when the caller runs on ("Sam and I need a cleaning", "Sam, I have a leak"). */
const NAME_CUT = /(?:,|\s+(?:and|but|so|because|i|i'm|im|my|we|the|calling|about|for|with|from|at)\b).*$/i;
/** Where an address stops when the caller runs on ("42 Elm Street, you can reach me ..."). */
const ADDRESS_CUT = /(?:,\s*|\s+)(?:and\s+)?(?:you can|you could|please|my (?:phone|number|cell|name|email|e-mail)|call me|reach me|the (?:phone|number)|and I|and we|thanks|thank you)\b.*$/i;
const DIGIT_TOKEN = '(?:(?:double|triple|treble)[\\s-]+)?(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|\\d+)';
/** The stretches of a line that are digits said or written ("five five five 0 1 double 0"), so only those are taught to the masker, not the words around them. */
const DIGIT_RUNS = new RegExp(`\\b${DIGIT_TOKEN}(?:[\\s,.-]+${DIGIT_TOKEN})*\\b`, 'gi');
export function digitRuns(raw: string): string[] { return [...raw.matchAll(DIGIT_RUNS)].map((m) => m[0]).filter((s) => s.length > 0); }
const CLOCK_TIME = /\b(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|oh|fifteen|thirty|forty[- ]five)\s*(?:a\.?\s?m\.?|p\.?\s?m\.?)(?![a-z])/i;
/** The digit runs of five or more digits (never a day of the month, a count or a year). */
function longDigitRuns(raw: string): string[] { return digitRuns(raw).filter((r) => (digitsOf(r) ?? '').length >= 5); }
const NOT_PHONE_WORDS = new Set(['january', 'february', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'jan', 'feb', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'today', 'tomorrow', 'tonight', 'morning', 'afternoon', 'evening', 'noon', 'midnight', 'week', 'weeks', 'month', 'months', 'year', 'years', 'day', 'days',
  'hour', 'hours', 'minute', 'minutes', "o'clock", 'bedroom', 'bedrooms', 'bathroom', 'bathrooms', 'room', 'rooms', 'dollars', 'dollar', 'percent', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
  'hundred', 'thousand', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']);
/** Whether the line is a date, a time, a duration or another quantity rather than phone digits. A phone number is spoken digit by digit, so ordinals, tens words, clock times and calendar words rule a line out. */
function looksLikeDateOrQuantity(raw: string): boolean {
  // A clock time is a number WITH am or pm ("10 am", "ten pm", "nine thirty a.m.", "9:30"); the word "am" in "I am" is only conversation.
  if (/\b\d{1,2}:\d{2}\b/.test(raw) || CLOCK_TIME.test(raw)) return true;
  return raw.toLowerCase().split(/[^a-z0-9']+/).some((t) => NOT_PHONE_WORDS.has(t) || /^\d+(?:st|nd|rd|th)$/.test(t));
}

/** The name in a caller's words, or undefined when it is not a usable name. Pure. */
export function nameFrom(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 200) return undefined;
  let t = clean(raw).replace(NAME_LEAD, '').replace(NAME_CUT, '').replace(NAME_TAIL, '').trim();
  t = t.replace(/[.,!?]+$/, '');
  if (t.length < 2 || t.length > 60 || /[\d@\[\]<>]/.test(t)) return undefined;
  const words = t.split(' ');
  if (words.length < 1 || words.length > 4) return undefined;
  if (!words.every((w) => NAME_WORD.test(w) && !FILLER.has(w.toLowerCase()))) return undefined;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Address words. A STREET word is a word of two or more letters that is not a number word and not only a unit designator ("apartment 4" is not a street). No particular street suffix is required.
const NUMBER_WORD_ONLY = new RegExp(`^${NUM_WORD}$`, 'i');
const UNIT_WORD = new Set(['apartment', 'apt', 'unit', 'suite', 'ste', 'floor', 'fl', 'room', 'rm', 'number', 'no', 'lot', 'building', 'bldg', 'house', 'address', 'service', 'the', 'my', 'at', 'is', 'it', "it's", 'a', 'an', 'and']);
const isStreetWord = (w: string): boolean => /^\p{L}{2,}[\p{L}'’.-]*$/u.test(w) && !NUMBER_WORD_ONLY.test(w) && !UNIT_WORD.has(w.toLowerCase());

/** The address in a caller's words, or undefined when it has no street number plus a street name (or a PO box). A house number alone is NOT an address. Never a postal check. Pure. */
export function addressFrom(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 300) return undefined;
  let t = clean(raw).replace(ADDRESS_LEAD, '').replace(ADDRESS_CUT, '').replace(ADDRESS_TAIL, '').trim();
  if (t.length < 5 || t.length > 120 || /[@\[\]<>]/.test(t)) return undefined;
  const words = t.split(' ').filter((w) => /[\p{L}\d]/u.test(w));
  if (PO_BOX.test(t)) return t;
  if (!ADDRESS_NUMBER.test(t) || words.length < 2 || !words.some((w) => isStreetWord(w) && !NOT_A_STREET.has(w.toLowerCase()))) return undefined;
  return t;
}

// One component of an address, said on its own: the HOUSE NUMBER ("742", "seven four two") or the STREET NAME ("Evergreen Terrace"). Each is held across turns and joined to the other; nothing is invented.
const HOUSE_NUMBER_LEAD = /^(?:the\s+)?(?:house|street)\s+number\s+(?:is\s+)?/i;
/** Words of conversation (not of a street name): a line holding one is never taken for a street name on its own. */
const NOT_A_STREET = new Set(['about', 'price', 'quote', 'cost', 'talk', 'want', 'need', 'like', 'have', 'get', 'tell', 'ask', 'say', 'think', 'maybe', 'later', 'also', 'just', 'really', 'thing', 'something', 'anything', 'everything', 'here', 'there', 'where', 'when', 'which', 'who', 'from', 'in', 'on', 'of', 'and', 'but', 'or', 'so', 'because', 'if', 'then', 'than', 'are', 'was', 'were', 'be', 'been', 'am', 'let', 'me', 'check', 'look', 'find', 'give', 'hold', 'hang', 'moment', 'second', 'minute', 'repeat', 'pardon', 'hmm', 'yeah', 'yep', 'nope', 'nah', 'house', 'apartment', 'apt', 'unit', 'suite', 'floor', 'room', 'a']);
/** Generic road words: they may be part of a street name ("Elm Street") but are not a street name by themselves. No suffix is ever REQUIRED. */
const ROAD_WORD = new Set(['street', 'st', 'avenue', 'ave', 'road', 'rd', 'lane', 'ln', 'drive', 'dr', 'court', 'ct', 'way', 'place', 'pl', 'terrace', 'boulevard', 'blvd']);
export type AddressPiece = { readonly kind: 'number' | 'street'; readonly text: string };
const numericWord = (w: string): boolean => /^\d{1,6}[a-z]?$/i.test(w) || NUMBER_WORD_ONLY.test(w) || /^(?:oh|double|triple|treble)$/i.test(w);
/** A house number alone, or a street name alone, from a caller's line; undefined for anything else (a whole address is addressFrom's). Pure. */
export function addressPiece(raw: unknown): AddressPiece | undefined {
  if (typeof raw !== 'string' || raw.length > 200) return undefined;
  const t = clean(raw).replace(ADDRESS_LEAD, '').replace(HOUSE_NUMBER_LEAD, '').replace(ADDRESS_CUT, '').replace(ADDRESS_TAIL, '').trim().replace(/[.,!?]+$/, '');
  if (t.length < 1 || t.length > 80 || /[@\[\]<>]/.test(t)) return undefined;
  const words = t.split(/[\s,]+/).filter((w) => w.length > 0);
  if (words.length === 0 || words.length > 4) return undefined;
  if (words.every(numericWord)) {
    const digitChars = words.filter((w) => /^\d/.test(w)).join('').length;
    return digitChars <= 6 ? { kind: 'number', text: words.join(' ') } : undefined;
  }
  const lower = words.map((w) => w.toLowerCase());
  if (!words.every((w) => /^\p{L}[\p{L}'’.-]*$/u.test(w))) return undefined;
  if (words.some((w, i) => numericWord(w) || FILLER.has(lower[i]) || NOT_A_STREET.has(lower[i]))) return undefined;
  if (lower.every((w) => ROAD_WORD.has(w))) return undefined;   // "street" alone is not a street name
  return { kind: 'street', text: words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') };
}

// Volunteered details: explicit cues only, so a stray sentence is never taken for a contact detail. The latest cue wins (a correction).
const CUE_NAME = /\b(?:my name is|my name's|the name is|the name's|name should be|(?:change|correct) (?:my |the )?name to)\s+([^.!?;]{2,60})/i;
const CUE_PHONE = /\b(?:my (?:phone |cell |mobile |contact |callback )?number is|(?:phone |cell |mobile |contact |callback )?number is|call me at|reach me at)\s+([^!?;]{3,80})/i;
const CUE_ADDRESS = /\b(?:my (?:service )?address is|(?:service )?address is|i live at|i am located at|i'm located at)\s+([^!?;]{5,140})/i;

export interface ContactState {
  /** Takes the caller's line as the answer to `field` (the field just asked). `replace` makes it a correction. Returns what happened. */
  collect(field: ContactField, raw: unknown, replace?: boolean): CollectResult;
  /** Applies any explicit cue ("my name is ...", "my number is ...", "my address is ...") in the line. Each is a replacement. */
  volunteered(raw: unknown): CollectResult[];
  /** Forgets one item (for example an address the caller said was wrong). */
  clear(field: ContactField): void;
  /** Sets one item outright (a complete number detected in the line replaces an earlier one: the newest wins). */
  set(field: ContactField, value: string): void;
  /** Sets one item from a detected value only when it has no value yet (the masker's guess, a fallback). */
  fallback(field: ContactField, value: string | undefined): void;
  value(field: ContactField): string | undefined;
  parts(): { name?: string; phone?: string; address?: string };
  /** Pieces of a phone number heard so far, when there are not yet enough digits. */
  pendingPhone(): boolean;
  /** How many digits of a number heard in pieces are held (a count only; zero once a number is held). */
  pendingDigits(): number;
  /** What the next phone question should ask for, as COUNTS only (never a digit): how many digits are still needed after some were heard, or 'restate' when the pieces could not be fitted together. */
  phoneNeed(): number | 'restate' | undefined;
  /** The caller declined to go on: forgets the pieces held for one item (a phone number, or one part of an address). */
  abandon(field: ContactField): void;
  /** Which part of the service address is still needed after one part was heard (never the part itself): the street name, the house number, or none. */
  addressPart(): 'street name' | 'house number' | undefined;
  status(): ContactStatus;
  dispose(): void;
}

export function createContactState(): ContactState {
  let values: { name?: string; phone?: string; address?: string } = {};
  let pending = '';   // digits of a phone number heard in pieces
  let phoneAmbiguous = false;   // the pieces heard could not be fitted together and were forgotten: the caller is asked for the whole number again
  let pendNumber = ''; let pendStreet = '';   // one part of a service address heard on its own, held until the other arrives
  let disposed = false;

  /** Digits joined from pieces make a number only at the usual length: ten, or eleven with a leading 1. (A whole line of 10 to 15 digits is still taken as said.) */
  const PIECED_NUMBER = /^(?:\d{10}|1\d{10})$/;
  const held = (): number => (values.phone !== undefined ? values.phone.length : pending.length);

  function setPhone(raw: string, replace: boolean): CollectResult {
    // A date, a time or a duration is not a phone number whatever digits it holds ("October 22" answered to the phone question once became the first two digits of the number). Nothing is taken, the held
    // pieces stay as they were, and a long run of digits in such a line is still taught to the masker (so it is protected) while short ones (a day of the month) are left alone.
    if (looksLikeDateOrQuantity(raw)) return { field: 'phone', outcome: 'unclear', learn: longDigitRuns(raw), reason: 'NOT_DIGITS', digits: 0, total: held() };
    const learn = digitRuns(raw);
    const whole = phoneDigits(raw);
    if (whole !== undefined) { values.phone = whole; pending = ''; return { field: 'phone', outcome: 'captured', learn, reason: 'CAPTURED', digits: whole.length, total: whole.length }; }
    const piece = digitsOf(raw);
    if (piece === undefined || piece.length === 0) return { field: 'phone', outcome: 'unclear', learn: [], reason: 'NO_DIGITS', digits: 0, total: held() };
    const before = replace ? '' : pending;
    const captured = (digits: string, reason: CollectReason): CollectResult => { values.phone = digits; pending = ''; phoneAmbiguous = false; return { field: 'phone', outcome: 'captured', learn, reason, digits: piece.length, total: digits.length }; };
    const forget = (reason: CollectReason): CollectResult => { pending = ''; phoneAmbiguous = true; return { field: 'phone', outcome: 'unclear', learn, reason, digits: piece.length, total: 0 }; };
    if (piece.length > 15) return forget('TOO_MANY');
    if (before.length === 0) { pending = piece; phoneAmbiguous = false; return { field: 'phone', outcome: 'partial', learn, reason: 'PIECE', digits: piece.length, total: piece.length }; }
    // Digits held from earlier pieces, and a new piece. Only what the caller actually said is ever used; nothing is guessed:
    //   1. appended, they make a whole number (ten digits, or eleven with a leading 1): taken. (Legitimate repeated digits, "five five five" then "five five five zero one four two", land here.)
    //   2. the new piece starts by repeating the END of what is held (at least three digits) and exactly ONE way of saying the repeated digits once makes a whole number: merged. Two different readings: ambiguous.
    //   3. the new piece is the digits already held (six or more, so it cannot be a legitimate continuation): a restatement, nothing changes.
    //   4. appended it is still short of a whole number (at most ten digits): another piece.
    //   5. otherwise the pieces do not fit together: the held digits are forgotten and the caller is asked for the whole number again.
    const joined = before + piece;
    if (PIECED_NUMBER.test(joined)) return captured(joined, 'CAPTURED');
    const merges = new Set<string>();
    for (let k = Math.min(before.length, piece.length - 1); k >= 3; k--) { if (before.endsWith(piece.slice(0, k))) { const m = before + piece.slice(k); if (PIECED_NUMBER.test(m)) merges.add(m); } }
    if (merges.size === 1) return captured([...merges][0], 'MERGED');
    if (merges.size > 1) return forget('AMBIGUOUS');
    if (piece === before && before.length >= 6) return { field: 'phone', outcome: 'partial', learn, reason: 'SAME', digits: piece.length, total: before.length };
    if (joined.length <= 10) { pending = joined; phoneAmbiguous = false; return { field: 'phone', outcome: 'partial', learn, reason: 'PIECE', digits: piece.length, total: joined.length }; }
    return forget('AMBIGUOUS');
  }
  /** "the last four are nine nine nine nine": replaces the last four digits of the number already held. Undefined when no number is held or the line does not say exactly four digits. */
  const LAST_FOUR = /\b(?:the\s+)?(?:last|final)\s+(?:four|4)(?:\s+digits?)?\s+(?:are|is|should\s+be|were)\s+([^!?;]{3,40})/i;
  function correctLastFour(raw: string): CollectResult | undefined {
    if (values.phone === undefined) return undefined;
    const m = LAST_FOUR.exec(raw);
    if (m === null) return undefined;
    const d = digitsOf(m[1]);
    if (d === undefined || d.length !== 4) return undefined;
    values.phone = values.phone.slice(0, -4) + d; pending = '';
    return { field: 'phone', outcome: 'captured', learn: digitRuns(m[1]), reason: 'CORRECTED_LAST4', digits: 4, total: values.phone.length };
  }

  return {
    collect(field, raw, replace = false) {
      if (disposed || typeof raw !== 'string') return { field, outcome: 'unclear', learn: [], reason: 'INACTIVE' };
      if (field === 'name') {
        const n = nameFrom(raw);
        if (n === undefined) return { field, outcome: 'unclear', learn: [], reason: 'NOT_A_NAME' };
        values.name = n; return { field, outcome: 'captured', learn: [n], reason: 'CAPTURED' };
      }
      if (field === 'address') {
        if (replace) { pendNumber = ''; pendStreet = ''; }
        const a = addressFrom(raw);
        if (a !== undefined) { values.address = a; pendNumber = ''; pendStreet = ''; return { field, outcome: 'captured', learn: [a], reason: 'CAPTURED' }; }
        const piece = addressPiece(raw);
        if (piece === undefined) return { field, outcome: 'unclear', learn: [], reason: ADDRESS_NUMBER.test(raw) ? 'NOT_AN_ADDRESS' : 'NO_STREET_NUMBER' };
        // A part said on its own is progress, never a complete address: it is held, joined to the other part when that arrives, and the caller then confirms the whole address aloud.
        const number = piece.kind === 'number' ? piece.text : pendNumber;
        const street = piece.kind === 'street' ? piece.text : pendStreet;
        if (number !== '' && street !== '') {
          const joined = addressFrom(`${number} ${street}`);
          if (joined !== undefined) { values.address = joined; pendNumber = ''; pendStreet = ''; return { field, outcome: 'captured', learn: [joined], reason: 'JOINED' }; }
        }
        // A lone small number word ("two") is not taught to the masker on its own: it would mask the same word in "two bedrooms". The whole address is taught when it is joined.
        if (piece.kind === 'number') { pendNumber = piece.text; return { field, outcome: 'partial', learn: /\d{3,}/.test(piece.text) || piece.text.split(' ').length >= 2 ? [piece.text] : [], reason: 'NEED_STREET' }; }
        pendStreet = piece.text; return { field, outcome: 'partial', learn: [piece.text], reason: 'NEED_NUMBER' };
      }
      return setPhone(raw, replace);
    },
    volunteered(raw) {
      const out: CollectResult[] = [];
      if (disposed || typeof raw !== 'string' || raw.length > 1000) return out;
      const l4 = correctLastFour(raw);
      if (l4 !== undefined) out.push(l4);
      const nm = CUE_NAME.exec(raw);
      if (nm !== null) { const r = this.collect('name', nm[1], true); if (r.outcome !== 'unclear') out.push(r); }
      const ph = l4 === undefined ? CUE_PHONE.exec(raw) : null;
      if (ph !== null) { const r = this.collect('phone', ph[1], true); if (r.outcome !== 'unclear') out.push(r); }
      const ad = CUE_ADDRESS.exec(raw);
      if (ad !== null) { const r = this.collect('address', ad[1], true); if (r.outcome !== 'unclear') out.push(r); }
      return out;
    },
    clear(field) { delete values[field]; if (field === 'phone') { pending = ''; phoneAmbiguous = false; } if (field === 'address') { pendNumber = ''; pendStreet = ''; } },
    set(field, value) { if (disposed) return; values[field] = value; if (field === 'phone') pending = ''; if (field === 'address') { pendNumber = ''; pendStreet = ''; } },
    fallback(field, value) { if (!disposed && values[field] === undefined && typeof value === 'string' && value.length > 0) values[field] = value; },
    value(field) { return disposed ? undefined : values[field]; },
    parts() { return disposed ? {} : { ...values }; },
    pendingPhone() { return !disposed && pending.length > 0 && values.phone === undefined; },
    pendingDigits() { return disposed || values.phone !== undefined ? 0 : pending.length; },
    phoneNeed() { if (disposed || values.phone !== undefined) return undefined; if (pending.length >= 1 && pending.length <= 9) return 10 - pending.length; return phoneAmbiguous ? 'restate' : undefined; },
    abandon(field) { if (field === 'phone') { pending = ''; phoneAmbiguous = false; } else if (field === 'address') { pendNumber = ''; pendStreet = ''; } },
    addressPart() { return disposed || values.address !== undefined ? undefined : pendNumber !== '' ? 'street name' : pendStreet !== '' ? 'house number' : undefined; },
    status() {
      const captured: string[] = []; const missing: string[] = [];
      for (const k of CONTACT_FIELD_KEYS) (values[k] === undefined ? missing : captured).push(CONTACT_FIELDS[k]);
      return { captured, missing };
    },
    dispose() { disposed = true; values = {}; pending = ''; phoneAmbiguous = false; pendNumber = ''; pendStreet = ''; },
  };
}

// ---------------------------------------------------------------- the tool surface for a native Realtime conversation
export const CONTACT_TOOL_NAMES = Object.freeze(['collect_name', 'collect_phone', 'collect_address', 'correct_contact', 'call_status'] as const);
export type ContactToolName = (typeof CONTACT_TOOL_NAMES)[number];
/** The tool definitions (names, descriptions and argument shapes). A model may only REQUEST these; the server runs and validates them. No pricing, booking or hand-off tool exists. */
export const CONTACT_TOOL_DEFINITIONS = Object.freeze([
  { name: 'collect_name', description: "Record the caller's name as they just said it. The server validates it.", parameters: { type: 'object', properties: { heard: { type: 'string' } }, required: ['heard'], additionalProperties: false } },
  { name: 'collect_phone', description: 'Record the caller\'s callback number, or the next piece of it if they give it in parts. The server joins and validates the digits.', parameters: { type: 'object', properties: { heard: { type: 'string' } }, required: ['heard'], additionalProperties: false } },
  { name: 'collect_address', description: "Record the service address as the caller just said it. The server validates it; it is confirmed aloud, never looked up.", parameters: { type: 'object', properties: { heard: { type: 'string' } }, required: ['heard'], additionalProperties: false } },
  { name: 'correct_contact', description: 'Replace one contact item with a corrected value the caller just gave.', parameters: { type: 'object', properties: { field: { type: 'string', enum: ['name', 'phone', 'address'] }, heard: { type: 'string' } }, required: ['field', 'heard'], additionalProperties: false } },
  { name: 'call_status', description: 'Which contact items are captured and which are still missing (labels only).', parameters: { type: 'object', properties: {}, additionalProperties: false } },
] as const);

export type ContactToolResult =
  | { readonly ok: true; readonly outcome: CollectOutcome | 'status'; readonly field?: ContactField; readonly captured: readonly string[]; readonly missing: readonly string[]; readonly learn: readonly string[] }
  | { readonly ok: false; readonly code: 'UNKNOWN_TOOL' | 'BAD_ARGUMENTS' | 'NOT_ACTIVE' | 'TOO_MANY' };
const MAX_HEARD_CHARS = 300;

/** Runs one requested tool against the state. The result holds labels and a fixed outcome word only, never the value the caller gave. Unknown tools and bad arguments are refused. */
export function runContactTool(state: ContactState, name: unknown, args: unknown): ContactToolResult {
  if (typeof name !== 'string' || !(CONTACT_TOOL_NAMES as readonly string[]).includes(name)) return { ok: false, code: 'UNKNOWN_TOOL' };
  const a = args !== null && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : undefined;
  if (a === undefined) return { ok: false, code: 'BAD_ARGUMENTS' };
  const keys = Object.keys(a);
  const done = (r: CollectResult): ContactToolResult => { const s = state.status(); return { ok: true, outcome: r.outcome, field: r.field, captured: s.captured, missing: s.missing, learn: r.learn }; };
  if (name === 'call_status') {
    if (keys.length > 0) return { ok: false, code: 'BAD_ARGUMENTS' };
    const s = state.status(); return { ok: true, outcome: 'status', captured: s.captured, missing: s.missing, learn: [] };
  }
  if (name === 'correct_contact') {
    if (keys.length !== 2 || typeof a.heard !== 'string' || a.heard.length > MAX_HEARD_CHARS || (a.field !== 'name' && a.field !== 'phone' && a.field !== 'address')) return { ok: false, code: 'BAD_ARGUMENTS' };
    return done(state.collect(a.field, a.heard, true));
  }
  if (keys.length !== 1 || typeof a.heard !== 'string' || a.heard.length > MAX_HEARD_CHARS) return { ok: false, code: 'BAD_ARGUMENTS' };
  return done(state.collect(name === 'collect_name' ? 'name' : name === 'collect_phone' ? 'phone' : 'address', a.heard));
}
