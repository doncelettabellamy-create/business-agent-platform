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
//             Free-text fields (no checkable shape) are not bound at all: Intake reads them from the conversation exactly as before.
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
function plausible(field: string, kind: FieldKind, v: string): boolean {
  if (v.length === 0 || AMBIGUOUS.test(v)) return false;
  switch (kind) {
    case 'count': {
      const n = countOf(v);
      if (n === undefined || n > 20 || DATE.test(v) || TIME.test(v)) return false;   // a day of the month or a time of day is not a number of rooms
      const own = unitOf(field);
      const others = UNITS.filter(([name, re]) => name !== own && re.test(v) && !(own !== undefined && new RegExp(`\\b${own}s?\\b`, 'i').test(v)));
      return others.length === 0;
    }
    case 'polarity':
      if (polarityOf(v) !== undefined) return true;
      if (FREQUENCY.test(v) || DATE.test(v) || TIME.test(v) || DEFLECT.test(v)) return false;   // "just this one time", "October 22" or "in the morning" is not an answer about extras or pets
      return content(v).length >= 2;
    case 'frequency': return FREQUENCY.test(v) && !DEFLECT.test(v);
    case 'date': return DATE.test(v) && !DEFLECT.test(v);
    case 'time': return TIME.test(v) && !DEFLECT.test(v);
    default: return content(v).length >= 1 && !DEFLECT.test(v);
  }
}
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
    bind(field, line) {
      if (disposed || !usable(field) || typeof line !== 'string') return 'ambiguous';
      const kind = kindOf(field);
      if (kind === 'free') return 'unchecked';
      const v = clean(line).slice(0, MAX_VALUE);
      if (!plausible(field, kind, v)) return 'ambiguous';
      if (conflicted.has(field)) { accepted.set(field, v); candidates.delete(field); conflicted.delete(field); answered.add(field); return 'bound'; }   // the caller answered the very question the contradiction raised: the new answer replaces the stale value
      candidates.set(field, v); answered.add(field);
      return 'bound';
    },
    merge(item, newest, ctx) {
      const out = { accepted: [] as string[], corrected: [] as string[], conflicts: [] as string[], unsupported: [] as string[] };
      if (disposed || item === undefined || !Array.isArray(item.fields)) return out;
      const corrects = typeof newest === 'string' && CORRECTION.test(newest);
      for (const f of item.fields as FieldEntry[]) {
        if (!f.found || typeof f.value !== 'string' || !usable(f.name)) continue;
        const v = clean(f.value).slice(0, MAX_VALUE);
        const kind = kindOf(f.name);
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
