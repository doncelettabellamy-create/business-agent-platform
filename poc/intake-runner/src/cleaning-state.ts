// One validated CLEANING-ANSWER state for ONE call (proof of concept, founder test). PURE: no I/O, no clock, no model, no randomness.
//
// The contact items (name, phone, address) have their own state (call-state.ts). This file does the same job for the cleaning details the Intake model reads out of the conversation
// (property type, bedrooms, bathrooms, pets, frequency, date, time and so on). Before it existed, every turn the whole conversation was read again from nothing, so a detail the caller had
// already given could come back "missing" on a later pass and be asked for again, and the saved record was a different reading from the one the call had steered by.
//
// What it does, in one place shared by the next-question choice and the saved record:
//   bind      a caller's line is the answer to the field that was just asked (and cleanly delivered) when it plausibly is one: a count needs a number and not another room's count, a frequency
//             needs frequency words, a date needs date words, a time needs a time of day, a yes or no needs a yes or no (or a description). A short vague reply ("maybe", "um", "I don't know"),
//             or one that is clearly about another field ("just this one time" to an extras question), is AMBIGUOUS: nothing is stored and the question is asked again within the usual limits.
//             A bound answer is only CONTEXT for Intake (a "Field: answer" line); it counts as accepted, and is never put back into a record, until an Intake pass has itself found it.
//             Free-text fields (no checkable shape) are not bound, EXCEPT for a complete short reply that means something (2026-10-29): for Priority areas no / none / no preference is an answer, for Last professional clean
//             never is, and no / none / no preference there is asked again; a refusal or an "I don't know" that is the whole reply is never an answer for any field. Everything else Intake reads as before.
//   merge     what an Intake pass found is kept once accepted. A later pass that omits it does not un-complete it. A later pass that reads a DIFFERENT value out of the newest caller line is
//             either an explicit correction (the caller said "actually", "sorry", "I meant", "make that" ...) and replaces the old value, or a genuine contradiction and is held as a CONFLICT:
//             the field is asked again and the stale value is never kept silently. A different reading of older lines is ignored (the accepted value stands).
//   lines     the accepted answers as "Field: answer" lines, appended to what Intake reads, so the model is told which field each answer belongs to (as the first-cleaning answer always was).
//   evidence  a field the category does NOT require, and that has a known topic (last professional clean, home empty, priority areas, number of rooms), is kept only when the caller's own words
//             are evidence for it: an answer bound to the question asked in context, or a caller line about that topic that contains the value. Being asked is not evidence, and an unrelated
//             "yes" or "a month" said to another question can never populate it. Required fields are never touched by this rule (Intake's required-field checks stand).
//   overlay   puts accepted answers back into a work item whose pass omitted them, and takes a conflicted value OUT of it (found:false, missing, ambiguous_field), so the question choice, the
//             read-back and the saved record all agree. Required-field rules stay Intake's: nothing here marks a missing field as found without a caller's answer.
//
// Values are the caller's own MASKED words (the same lines Intake already reads), at most 80 characters. Nothing raw is stored; nothing is logged (only fixed codes, by the caller).

import type { FieldEntry, ItemStatus, ReasonCode, WorkItemV1 } from './contracts.ts';

export type FieldKind = 'count' | 'polarity' | 'frequency' | 'date' | 'time' | 'free';
export type BindResult = 'bound' | 'ambiguous' | 'unchecked';
export interface MergeOutcome { readonly accepted: readonly string[]; readonly corrected: readonly string[]; readonly conflicts: readonly string[]; readonly unsupported: readonly string[] }
/**
 * A value that is ONLY mask placeholders (and punctuation), such as "[ADDRESS_1]", is never an answer to a question about the job: it is what the masker put where the caller's words were, and an
 * extraction pass can return it because it is "copied from the masked text". For a field that is not an address or a location it is not found. A value that mixes a placeholder with other words is NOT covered
 * by this rule (a separate, unverified hazard, reported and left alone).
 */
const PLACEHOLDER_TOKEN = /\[[A-Z]+_\d{1,3}\]/g;
export function isPlaceholderOnly(value: unknown): boolean {
  if (typeof value !== 'string' || !PLACEHOLDER_TOKEN.test(value)) { PLACEHOLDER_TOKEN.lastIndex = 0; return false; }
  PLACEHOLDER_TOKEN.lastIndex = 0;
  return value.replace(PLACEHOLDER_TOKEN, '').replace(/[\s.,;:!?'"()\-]/g, '') === '';
}
const ADDRESS_LIKE = /address|location/i;
export interface OverlayResult { readonly item: WorkItemV1; readonly changed: boolean; readonly restored: readonly string[]; readonly withheld: readonly string[]; readonly dropped: readonly string[] }
/** What the evidence rule needs: the fields the item's category requires (undefined: do not police) and the caller's masked lines. */
export interface EvidenceContext { readonly required?: ReadonlySet<string>; readonly lines: readonly string[] }

const MAX_VALUE = 80;
const NUM_WORDS: Readonly<Record<string, number>> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
const STOP = new Set(['a', 'an', 'the', 'i', 'im', "i'm", 'it', 'its', "it's", 'is', 'are', 'was', 'my', 'we', 'our', 'um', 'uh', 'well', 'so', 'just', 'like', 'you', 'know', 'of', 'and', 'to', 'in', 'for', 'that', 'this', 'me', 'be', 'at', 'on', 'about', 'around', 'maybe', 'okay', 'ok', 'please', 'thanks', 'yeah', 'yes', 'no', 'there', 'have', 'has', 'do', 'does', 'any', 'some']);
const AMBIGUOUS = /^(?:um+|uh+|hmm+|er+|okay|ok|sure|maybe|perhaps|i (?:do not|don't|dont) know|(?:i'?m )?not sure|i guess|what\??|pardon\??|sorry\??|could you repeat that\??)[\s.!?,]*$/i;
/** A refusal or deflection is not an answer to anything. */
const DEFLECT = /\b(?:rather not|prefer not|do not want|don'?t want|dont want|not telling|not going to|won'?t (?:say|tell)|no comment|not say(?:ing)?|do not know|don'?t know|dont know|not sure|no idea|why do you)\b/i;
const FREQUENCY = /\b(?:weekly|biweekly|bi-weekly|fortnightly|monthly|daily|yearly|annual(?:ly)?|quarterly|every|once|twice|one[- ]time|one time|just this|per (?:week|month|year)|a (?:week|month|year)|recurring|regular)\b/i;
const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec';
const DATE = new RegExp(`\\b(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|next|(?:${MONTHS})|\\d{1,2}(?:st|nd|rd|th)|asap|soonest|(?:this|next) (?:week|month))\\b`, 'i');
const TIME = /\b(?:morning|afternoon|evening|noon|midday|tonight|night|a\.?m\.?|p\.?m\.?|o'clock|between|before|after|anytime|any time|flexible|\d{1,2}:\d{2})\b/i;
const NEG = /\b(?:no|none|nope|nothing|nobody|nah|without|not any|not really)\b|n't\b/i;
const POS = /\b(?:yes|yeah|yep|yup|definitely|absolutely|of course|correct|we do|i do|there (?:is|are)|dogs?|cats?|the oven|the fridge|the windows?)\b/i;
const CORRECTION = /\b(?:actually|sorry|correction|i meant|i mean|make that|change (?:that|it)|instead|no,? (?:it'?s|it is|that'?s|make)|rather)\b|\bnot\b[^.!?]{0,40}\bbut\b/i;
const UNITS: ReadonlyArray<readonly [string, RegExp]> = [['bedroom', /\bbed ?rooms?\b/i], ['bathroom', /\bbath ?rooms?\b/i], ['room', /\b(?:rooms?)\b/i]];

/** The words of an answer for whole-answer tests: lower case, plain apostrophes, no punctuation, leading fillers ("um", "well", "oh") removed. */
function wholeAnswer(v: string): string {
  let t = String(v).toLowerCase().replace(/[‘’]/g, "'").replace(/[.,!?;:"()]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3 && /^(?:um+|uh+|hmm+|well|oh|so|er+) /.test(t); i++) t = t.replace(/^(?:um+|uh+|hmm+|well|oh|so|er+) /, '');
  return t;
}
/** A caller who declines to answer, or says they do not know: the COMPLETE answer must be that and nothing else, so "we don't know the old cleaner but it was in March" and "no pets" are ordinary answers. */
const REFUSAL_OR_UNSURE = /^(?:(?:i(?:'d| would)? )?(?:rather|prefer) not(?: to)?(?: (?:answer|say|tell|share|give|talk about)(?: that| it| this)?)?|i (?:do not|don't|dont|won't|wont|will not|can't|cant|cannot) (?:want to )?(?:answer|say|tell|share|give|know)(?: that| it| this)?|(?:i )?(?:do not|don't|dont) know|(?:i'?m )?(?:really )?(?:not sure|unsure)|no (?:idea|comment)|not telling|pass|skip(?: it| that| this)?|i guess|maybe|perhaps)$/;
export function isRefusalOrUnsure(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 120 && REFUSAL_OR_UNSURE.test(wholeAnswer(value));
}
// Field-specific meanings of a COMPLETE short answer (founder-approved 2026-10-29), for the two Deep-cleaning fields whose answers have no checkable shape. The caller's own words are kept; nothing is inferred, no date or history is invented.
const NONE_ANSWER = /^(?:no|none|nope|nothing|no preferences?)$/;
const NEVER_ANSWER = /^(?:(?:we|i) )?(?:have )?never(?: (?:had|been|done|used|hired)(?: [a-z' ]{0,30})?)?$|^not ever$/;
const FIELD_MEANINGS: ReadonlyArray<readonly [RegExp, RegExp, RegExp | undefined]> = [
  [/^priority areas?/i, NONE_ANSWER, undefined],       // "any areas you would like us to focus on?": no / none / no preference is an answer
  [/^last professional clean/i, NEVER_ANSWER, NONE_ANSWER],   // "when was the last time ...?": never is an answer; no / none / no preference does not say when, so it is asked again
];
/** 'valid': a complete answer that means something for this field; 'unclear': a complete reply that is not an answer to it (asked again); undefined: an ordinary answer (or no rule for the field). */
export function answerMeaning(field: string, value: unknown): 'valid' | 'unclear' | undefined {
  if (typeof value !== 'string' || value.length > 120) return undefined;
  const m = FIELD_MEANINGS.find(([name]) => name.test(String(field)));
  if (m === undefined) return undefined;
  const t = wholeAnswer(value);
  if (m[1].test(t)) return 'valid';
  return m[2] !== undefined && m[2].test(t) ? 'unclear' : undefined;
}
/** Whether the complete value is a refusal, an expression of not knowing, or (for the field) a reply that is not an answer: such a value is never accepted for a field. */
const heldAnswer = (field: string, value: unknown): boolean => isRefusalOrUnsure(value) || answerMeaning(field, value) === 'unclear';

/** What kind of answer a field takes, by its configured name. */
export function kindOf(field: string): FieldKind {
  const f = String(field).toLowerCase();
  if (/^number of /.test(f)) return 'count';
  if (/frequency/.test(f)) return 'frequency';
  if (/time window|time of day|preferred time/.test(f)) return 'time';
  if (/\bdate\b|\bday\b/.test(f)) return 'date';
  if (/^(?:pets?|home empty|extras|first cleaning)/.test(f)) return 'polarity';
  return 'free';
}
/** One line, no label-looking colon: a stored answer can never forge another field's "Label: value" line. */
const clean = (s: string): string => s.replace(/\s+/g, ' ').replace(/(\p{L}):(?=\s|$)/gu, '$1 -').trim();
const tokens = (s: string): string[] => (s.toLowerCase().match(/[a-z0-9']+/g) ?? []).map((t) => (t in NUM_WORDS ? String(NUM_WORDS[t]) : t.replace(/^(\d+)(?:st|nd|rd|th)$/, '$1')));
const content = (s: string): string[] => tokens(s).filter((t) => !STOP.has(t));
/** The first whole number in the words (digits or number words up to twenty), or undefined. */
export function countOf(v: string): number | undefined {
  const m = /\b(\d{1,2}|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/i.exec(v);
  if (m === null) return undefined;
  const t = m[1].toLowerCase();
  return t in NUM_WORDS ? NUM_WORDS[t] : Number(t);
}
export function polarityOf(v: string): 'neg' | 'pos' | undefined {
  const n = NEG.test(v); const p = POS.test(v);
  return n && !p ? 'neg' : p && !n ? 'pos' : undefined;
}
/** The field's own unit word for a count ("Number of bedrooms" -> bedroom), when it has one. */
const unitOf = (field: string): string | undefined => { const m = /^number of ([a-z]+?)s?$/i.exec(String(field).trim()); return m === null ? undefined : m[1].toLowerCase(); };

/** Whether the words could plausibly be the answer to a field of this kind (and to this very field). */
function rejection(field: string, kind: FieldKind, v: string): string | undefined {
  if (v.length === 0) return 'EMPTY';
  if (AMBIGUOUS.test(v)) return 'VAGUE';
  if (isRefusalOrUnsure(v)) return 'REFUSAL_OR_UNSURE';
  switch (kind) {
    case 'count': {
      const n = countOf(v);
      if (n === undefined) return 'NO_NUMBER';
      if (n > 20) return 'NUMBER_TOO_LARGE';
      if (DATE.test(v)) return 'DATE_WORD';   // a day of the month or a time of day is not a number of rooms
      if (TIME.test(v)) return 'TIME_WORD';
      const own = unitOf(field);
      const others = UNITS.filter(([name, re]) => name !== own && re.test(v) && !(own !== undefined && new RegExp(`\\b${own}s?\\b`, 'i').test(v)));
      return others.length === 0 ? undefined : 'OTHER_UNIT';
    }
    case 'polarity':
      if (polarityOf(v) !== undefined) return undefined;
      if (FREQUENCY.test(v)) return 'FREQUENCY_WORD';   // "just this one time", "October 22" or "in the morning" is not an answer about extras or pets
      if (DATE.test(v)) return 'DATE_WORD';
      if (TIME.test(v)) return 'TIME_WORD';
      if (DEFLECT.test(v)) return 'DEFLECT_PHRASE';
      return content(v).length >= 2 ? undefined : 'TOO_SHORT';
    case 'frequency': if (!FREQUENCY.test(v)) return 'NO_FREQUENCY_WORD'; return DEFLECT.test(v) ? 'DEFLECT_PHRASE' : undefined;
    case 'date': if (!DATE.test(v)) return 'NO_DATE_WORD'; return DEFLECT.test(v) ? 'DEFLECT_PHRASE' : undefined;
    case 'time': if (!TIME.test(v)) return 'NO_TIME_WORD'; return DEFLECT.test(v) ? 'DEFLECT_PHRASE' : undefined;
    default: {
      const m = answerMeaning(field, v);
      if (m !== undefined) return m === 'valid' ? undefined : 'NOT_AN_ANSWER_FOR_FIELD';
      if (content(v).length < 1) return 'NO_CONTENT';
      return DEFLECT.test(v) ? 'DEFLECT_PHRASE' : undefined;
    }
  }
}
const plausible = (field: string, kind: FieldKind, v: string): boolean => rejection(field, kind, v) === undefined;
/** Whether two answers say the same thing for this kind of field. */
function same(kind: FieldKind, a: string, b: string): boolean {
  if (kind === 'count') { const x = countOf(a); const y = countOf(b); if (x !== undefined && y !== undefined) return x === y; }
  if (kind === 'polarity') { const x = polarityOf(a); const y = polarityOf(b); if (x !== undefined && y !== undefined) return x === y; }
  const x = new Set(content(a)); const y = new Set(content(b));
  if (x.size === 0 || y.size === 0) return clean(a).toLowerCase() === clean(b).toLowerCase();
  const [small, big] = x.size <= y.size ? [x, y] : [y, x];
  return [...small].every((t) => big.has(t));
}
const decisive = (kind: FieldKind): boolean => kind !== 'free';
/** Whether every word of the value is in the newest caller line (so the value is NEW evidence from that line, not an older reading). */
const groundedIn = (value: string, line: string): boolean => { const l = new Set(tokens(line)); const c = content(value); return c.length > 0 && c.every((t) => l.has(t)); };

/** Topics of the optional cleaning fields: what a caller's line must be about for a value to count as theirs. "Clean" alone is not enough ("I clean it once a month" is a frequency). */
const TOPICS: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/^last professional clean/i, /\b(?:professional|maid|cleaner|cleaners|cleaning (?:company|service)|ago|since|never|last|previous(?:ly)?|before)\b/i],
  [/^home empty/i, /\b(?:empty|vacant|unoccupied|unfurnished|furnished|furniture|belongings|nobody (?:is )?(?:home|there|living)|no ?one (?:is )?(?:home|there|living)|moved? out|moving out)\b/i],
  [/^priority areas?/i, /\b(?:priority|priorities|focus|mostly|especially|kitchen|bath(?:room)?s?|bedrooms?|living room|areas?|floors?|windows?|oven|garage|basement|stairs|carpets?)\b/i],
  [/^number of rooms/i, /\brooms?\b/i],
];
/** The fields a category needs: every field marked required, plus the category's own list. The one place the call logic and the tests get it from. */
export function requiredFieldsOf(skill: { fields?: ReadonlyArray<{ name: string; required?: boolean }>; categories?: ReadonlyArray<{ name: string; requires?: readonly string[] }> }, category: string): string[] {
  const own = skill.categories?.find((c) => c.name === category)?.requires ?? [];
  return [...new Set([...(skill.fields ?? []).filter((f) => f.required === true).map((f) => f.name), ...own])];
}

export interface CleaningState {
  /** The caller's line as the answer to `field` (the question just asked and cleanly delivered). Replaces any earlier answer and clears a conflict on that field. */
  bind(field: string, line: string): BindResult;
  /**
   * Why the newest bind() gave its verdict: a FIXED CODE for the branch actually taken (never a caller word, digit or value), or undefined before any bind. For the call's diagnostics only; it does not take part in any decision.
   * Codes: OK (the words have the shape the field takes), FIELD_MEANING (a complete short reply that means something for the field), FREE_TEXT (no checkable shape: Intake reads it), UNUSABLE, and, for a reply that is not
   * taken: EMPTY, VAGUE, REFUSAL_OR_UNSURE, NO_NUMBER, NUMBER_TOO_LARGE, DATE_WORD, TIME_WORD, OTHER_UNIT, FREQUENCY_WORD, DEFLECT_PHRASE, TOO_SHORT, NO_FREQUENCY_WORD, NO_DATE_WORD, NO_TIME_WORD, NOT_AN_ANSWER_FOR_FIELD, NO_CONTENT.
   */
  lastBind(): { readonly result: BindResult; readonly why: string } | undefined;
  /** Folds one validated Intake pass into the state. `newest` is the caller's newest line. */
  merge(item: Pick<WorkItemV1, 'fields'>, newest: string, ctx?: EvidenceContext): MergeOutcome;
  has(field: string): boolean;
  conflicts(): string[];
  names(): string[];
  /** "Field: answer" lines for what Intake reads. */
  lines(): string[];
  /** The work item with omitted accepted answers put back and conflicted ones taken out, and whether anything changed. */
  overlay(item: WorkItemV1, ctx?: EvidenceContext): OverlayResult;
  dispose(): void;
}

export function createCleaningState(options: { exclude?: readonly string[] } = {}): CleaningState {
  const exclude = new Set((options.exclude ?? []).map((n) => String(n)));
  let accepted = new Map<string, string>();   // found by an Intake pass and plausible: kept across passes
  let candidates = new Map<string, string>();   // the caller's answer to the question just asked: context for Intake until a pass finds it
  let conflicted = new Set<string>();
  let answered = new Set<string>();   // fields the caller answered in context (a plausible answer to the question asked): evidence for an optional field
  let disposed = false;
  let lastVerdict: { result: BindResult; why: string } | undefined;
  /** Whether the caller's own words support this value for this field. Required fields and fields with no known topic are not policed. */
  const supported = (field: string, value: string, ctx: EvidenceContext | undefined): boolean => {
    if (ctx === undefined || ctx.required === undefined || ctx.required.has(field)) return true;
    const topic = TOPICS.find(([name]) => name.test(field));
    if (topic === undefined || answered.has(field)) return true;
    if (topic[1].test(value)) return true;
    const want = tokens(value).filter((t) => !STOP.has(t) || t === 'yes' || t === 'no');
    return ctx.lines.some((l) => { if (!topic[1].test(l)) return false; const have = new Set(tokens(l)); return want.length === 0 || want.some((t) => have.has(t)); });
  };
  const usable = (field: string): boolean => typeof field === 'string' && field.length > 0 && field.length <= 60 && !/[\r\n:[\]<>]/.test(field) && !exclude.has(field);
  return {
    lastBind() { return lastVerdict; },
    bind(field, line) {
      const out = (result: BindResult, why: string): BindResult => { lastVerdict = { result, why }; return result; };
      if (disposed || !usable(field) || typeof line !== 'string') return out('ambiguous', 'UNUSABLE');
      const kind = kindOf(field);
      let v = clean(line).slice(0, MAX_VALUE);
      let ok = 'OK';
      if (kind === 'free') {
        // A free-text field has no checkable shape, except for the complete short replies that mean something: a valid one is bound (a labelled line for Intake, in the caller's own words); a refusal, an "I don't know" or a reply that is not an answer to THIS question is held and the question is asked again.
        v = v.replace(/[.!?,;\s]+$/, '');
        const m = answerMeaning(field, v);
        if (m === undefined) return isRefusalOrUnsure(v) ? out('ambiguous', 'REFUSAL_OR_UNSURE') : out('unchecked', 'FREE_TEXT');
        if (m === 'unclear') return out('ambiguous', 'NOT_AN_ANSWER_FOR_FIELD');
        ok = 'FIELD_MEANING';
      } else {
        const why = rejection(field, kind, v);
        if (why !== undefined) return out('ambiguous', why);
      }
      if (conflicted.has(field)) { accepted.set(field, v); candidates.delete(field); conflicted.delete(field); answered.add(field); return out('bound', ok); }   // the caller answered the very question the contradiction raised: the new answer replaces the stale value
      candidates.set(field, v); answered.add(field);
      return out('bound', ok);
    },
    merge(item, newest, ctx) {
      const out = { accepted: [] as string[], corrected: [] as string[], conflicts: [] as string[], unsupported: [] as string[] };
      if (disposed || item === undefined || !Array.isArray(item.fields)) return out;
      const corrects = typeof newest === 'string' && CORRECTION.test(newest);
      for (const f of item.fields as FieldEntry[]) {
        if (!f.found || typeof f.value !== 'string' || !usable(f.name)) continue;
        const v = clean(f.value).slice(0, MAX_VALUE);
        const kind = kindOf(f.name);
        // A mask placeholder returned as the answer to a question about the job is not an answer and is never accepted (the overlay below holds the field and the question is asked again; an accepted answer stands).
        if (isPlaceholderOnly(v) && !ADDRESS_LIKE.test(f.name)) continue;
        if (!plausible(f.name, kind, v)) continue;
        if (!supported(f.name, v, ctx)) { out.unsupported.push(f.name); continue; }
        const had = accepted.get(f.name);
        if (had === undefined) { accepted.set(f.name, v); candidates.delete(f.name); out.accepted.push(f.name); continue; }
        if (same(kind, had, v)) continue;
        if (typeof newest !== 'string' || !groundedIn(v, newest)) continue;   // an older reading: the accepted answer stands
        if (corrects) { accepted.set(f.name, v); candidates.delete(f.name); conflicted.delete(f.name); out.corrected.push(f.name); }
        else if (decisive(kind)) { conflicted.add(f.name); out.conflicts.push(f.name); }
      }
      return out;
    },
    has(field) { return !disposed && accepted.has(field); },
    conflicts() { return disposed ? [] : [...conflicted]; },
    names() { return disposed ? [] : [...accepted.keys()]; },
    lines() { return disposed ? [] : [...accepted, ...[...candidates].filter(([n]) => !accepted.has(n))].filter(([n]) => !conflicted.has(n)).map(([n, v]) => `${n}: ${v}`); },
    overlay(item, ctx) {
      if (disposed) return { item, changed: false, restored: [], withheld: [], dropped: [] };
      const restored: string[] = []; const withheld: string[] = []; const dropped: string[] = [];
      let missing = [...item.missing_fields];
      const fields = item.fields.map((f) => {
        if (conflicted.has(f.name)) { if (f.found || f.value !== null || !missing.includes(f.name)) withheld.push(f.name); return { ...f, value: null, confidence: null, found: false }; }
        const a = accepted.get(f.name);
        // Placeholder-only value, nothing accepted: held (not found, asked first), on every path including the final pass; an accepted answer is restored by the rule below.
        if (a === undefined && f.found && isPlaceholderOnly(f.value) && !ADDRESS_LIKE.test(f.name)) { withheld.push(f.name); return { ...f, value: null, confidence: null, found: false }; }
        // A refusal, an "I don't know" or (for the field) a reply that is not an answer, returned by a pass for a field with nothing accepted, is not an answer: held, asked again, never saved or read back. An accepted answer is untouched (the rule below), and a value that merely CONTAINS such words is an ordinary answer.
        if (a === undefined && f.found && heldAnswer(f.name, f.value) && !ADDRESS_LIKE.test(f.name)) { withheld.push(f.name); return { ...f, value: null, confidence: null, found: false }; }
        // An optional field the caller's words do not support (Intake filled it from other wording) is taken out: not found, not missing, nothing invented, no required field touched.
        if (a === undefined && f.found && typeof f.value === 'string' && !supported(f.name, clean(f.value), ctx)) { dropped.push(f.name); return { ...f, value: null, confidence: null, found: false }; }
        if (a !== undefined && (!f.found || f.value === null)) { restored.push(f.name); return { ...f, value: a, confidence: 0.8, found: true }; }
        // A pass that read an older or different value for a field already accepted does not overrule it: the record says what the call was steered by.
        if (a !== undefined && typeof f.value === 'string' && !same(kindOf(f.name), a, f.value)) { restored.push(f.name); return { ...f, value: a, confidence: f.confidence ?? 0.8, found: true }; }
        return f;
      });
      if (restored.length === 0 && withheld.length === 0 && dropped.length === 0) return { item, changed: false, restored: [], withheld: [], dropped: [] };
      missing = missing.filter((m) => !restored.includes(m));
      missing = [...withheld, ...missing.filter((m) => !withheld.includes(m))];   // a contradiction is asked about before anything that was simply never answered
      let reasons = item.reasons.filter((r) => !(r === 'missing_fields' && missing.length === 0));
      if (missing.length > 0 && !reasons.includes('missing_fields')) reasons = [...reasons, 'missing_fields'];
      if (withheld.length > 0 && !reasons.includes('ambiguous_field')) reasons = [...reasons, 'ambiguous_field' as ReasonCode];
      const status: ItemStatus = reasons.length === 0 ? 'ready' : 'needs-human';
      return { item: { ...item, fields, missing_fields: missing, reasons, status }, changed: true, restored, withheld, dropped };
    },
    dispose() { disposed = true; accepted = new Map(); candidates = new Map(); conflicted = new Set(); answered = new Set(); },
  };
}

/** A fixed, log-safe code for a configured field or category name: capital letters and underscores only ("Number of bedrooms" -> NUMBER_OF_BEDROOMS). Never a caller's word. */
export function codeOf(name: unknown): string {
  const s = typeof name === 'string' ? name.toUpperCase().replace(/[^A-Z]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) : '';
  return s.length > 0 ? s : 'NONE';
}
