// Personal-data screen and masker for the founder phone test (proof of concept). Pure: no I/O, no clock, no network.
//
// THIS IS NOT THE PLATFORM MASKING STAGE (INT-07 is not started). It is a small rule-based masker for ONE controlled test where the
// caller is the founder speaking an INVENTED persona. It replaces what rules can recognise with placeholders the Intake agent already
// understands ([PERSON_n], [ADDRESS_n], [CONTACT_n], [ID_n]) and FAILS CLOSED: if anything personal-looking is still there after
// masking, or the utterance is odd (too long, control characters), the utterance is refused and never reaches a model.
//
// What it cannot do: recognise a name it was not told about and that was not introduced by a phrase such as "my name is". That is why the
// test rule is "speak invented details only". Names listed in the approved config are always masked, and a name once masked stays masked
// for the rest of that call. The raw-to-placeholder map lives in memory for one call and is cleared by dispose().
//
// `piiProblems(text)` is the same detectors without masking; the record store uses it to refuse to save anything personal-looking.

export type PiiType = 'Person' | 'Address' | 'Contact detail' | 'Identifier';
export const PII_TYPES: readonly PiiType[] = ['Person', 'Address', 'Contact detail', 'Identifier'];
export interface PiiCount { type: PiiType; count: number }

const TOKEN: Record<PiiType, string> = { Person: 'PERSON', Address: 'ADDRESS', 'Contact detail': 'CONTACT', Identifier: 'ID' };
/** A placeholder this module produced. Everything matching it is skipped by the detectors. */
const PLACEHOLDER = /\[(?:PERSON|ADDRESS|CONTACT|ID)_\d{1,3}\]/g;

const NUM_WORD = '(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)';
const STREET = '(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|way|boulevard|blvd|place|pl|terrace|circle|highway|hwy|close|crescent)';
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_LIKE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
const PHONE_LIKE = /\+?\d[\d\s().-]{5,}\d/g;
const SPOKEN_DIGITS = new RegExp(`\\b${NUM_WORD}(?:[\\s,.-]+${NUM_WORD}){4,}\\b`, 'gi');
const ADDRESS_DIGITS = new RegExp(`\\b\\d{1,6}\\s+(?:[A-Za-z][A-Za-z'.-]*\\s+){0,3}${STREET}\\b\\.?`, 'gi');
const ADDRESS_WORDS = new RegExp(`\\b(?:${NUM_WORD}|ten|eleven|twelve|(?:thir|four|fif|six|seven|eigh|nine)teen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)(?:[\\s-]+(?:${NUM_WORD}|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)){0,4}\\s+(?:[A-Za-z][A-Za-z'.-]*\\s+){0,2}${STREET}\\b\\.?`, 'gi');
const PO_BOX = /\bp\.?\s?o\.?\s+box\s+\w+/gi;
const LONG_DIGITS = /\d{5,}/g;
const MIXED_ID = /\b(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9-]{8,}\b/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const STOP = new Set(['a', 'an', 'the', 'about', 'calling', 'regarding', 'my', 'just', 'not', 'so', 'really', 'very', 'in', 'at', 'on', 'for', 'to', 'from', 'with', 'and', 'but', 'having', 'looking', 'trying', 'here', 'there', 'sorry', 'afraid', 'sure', 'ok', 'okay', 'yes', 'no']);

export const MAX_UTTERANCE_CHARS = 1000;

const digitCount = (s: string): number => (s.match(/\d/g) ?? []).length;
function withoutPlaceholders(s: string): string { return s.replace(PLACEHOLDER, ' '); }

/** Codes for personal-looking content in `text` (placeholders are ignored). Empty means nothing was recognised. */
export function piiProblems(text: string): string[] {
  const t = withoutPlaceholders(text);
  const out: string[] = [];
  if (new RegExp(EMAIL.source).test(t)) out.push('email');
  if (new RegExp(URL_LIKE.source, 'i').test(t)) out.push('url');
  for (const m of t.matchAll(PHONE_LIKE)) if (digitCount(m[0]) >= 7) { out.push('phone'); break; }
  if (new RegExp(SPOKEN_DIGITS.source, 'i').test(t)) out.push('spoken_digits');
  if (new RegExp(ADDRESS_DIGITS.source, 'i').test(t) || new RegExp(ADDRESS_WORDS.source, 'i').test(t) || new RegExp(PO_BOX.source, 'i').test(t)) out.push('address');
  if (/\d{5,}/.test(t)) out.push('digits');
  if (new RegExp(MIXED_ID.source).test(t)) out.push('identifier');
  return out;
}

export type MaskResult = { ok: true; text: string } | { ok: false; code: 'TOO_LONG' | 'ODD_TEXT' | 'RESIDUAL' };
export interface Masker {
  /** Masks one utterance. Never throws on text content. */
  mask(raw: unknown): MaskResult;
  /** Counts of placeholders handed out so far. */
  summary(): PiiCount[];
  /** Forgets every raw value. After this, mask() refuses. */
  dispose(): void;
}

function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function createMasker(options: { names?: readonly string[] } = {}): Masker {
  const names = (options.names ?? []).filter((n) => typeof n === 'string' && n.trim().length >= 2).map((n) => n.trim());
  const counters: Record<PiiType, number> = { Person: 0, Address: 0, 'Contact detail': 0, Identifier: 0 };
  const counts: Record<PiiType, number> = { Person: 0, Address: 0, 'Contact detail': 0, Identifier: 0 };
  let known = new Map<string, string>();   // raw value (lower case) -> placeholder, for this call only
  let disposed = false;

  function tokenFor(type: PiiType, raw: string): string {
    const key = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    const have = known.get(key);
    if (have !== undefined) return have;
    counters[type]++;
    counts[type]++;
    const token = `[${TOKEN[type]}_${counters[type]}]`;
    known.set(key, token);
    return token;
  }
  const sub = (text: string, re: RegExp, type: PiiType, accept: (m: string) => boolean = () => true): string =>
    text.replace(re, (m) => (accept(m) ? tokenFor(type, m) : m));

  /** Splits on placeholders so a later rule never rewrites an earlier placeholder. */
  function eachSegment(text: string, fn: (segment: string) => string): string {
    let out = ''; let last = 0;
    for (const m of text.matchAll(PLACEHOLDER)) { out += fn(text.slice(last, m.index)) + m[0]; last = (m.index as number) + m[0].length; }
    return out + fn(text.slice(last));
  }

  return {
    mask(raw: unknown): MaskResult {
      if (disposed || typeof raw !== 'string') return { ok: false, code: 'ODD_TEXT' };
      if (raw.length > MAX_UTTERANCE_CHARS) return { ok: false, code: 'TOO_LONG' };
      if (CONTROL.test(raw) || /[[\]]/.test(raw)) return { ok: false, code: 'ODD_TEXT' };   // speech never contains brackets, so a caller cannot supply a look-alike placeholder
      let t = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
      if (t.length === 0) return { ok: false, code: 'ODD_TEXT' };

      // 1. Values already masked earlier in this call (case-insensitive, whole words).
      for (const [value, token] of [...known.entries()].sort((a, b) => b[0].length - a[0].length)) {
        t = eachSegment(t, (s) => s.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(value).replace(/ /g, '\\s+')}(?![A-Za-z0-9])`, 'gi'), token));
      }
      // 2. Names listed in the approved config.
      for (const n of names) t = eachSegment(t, (s) => sub(s, new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(n).replace(/ /g, '\\s+')}(?![A-Za-z0-9])`, 'gi'), 'Person'));
      // 3. Introductions: "my name is ..." masks the next one or two words; "this is / I am / I'm" only when the next word is capitalised.
      t = eachSegment(t, (s) => s.replace(/\b(my name is|my name's|name's|call me)\s+([A-Za-z][A-Za-z'-]*)(?:\s+([A-Za-z][A-Za-z'-]*))?/gi, (m, lead: string, a: string, b?: string) => {
        if (STOP.has(a.toLowerCase())) return m;
        const second = b !== undefined && !STOP.has(b.toLowerCase()) ? ` ${b}` : '';
        return `${lead} ${tokenFor('Person', a + second)}${b !== undefined && second === '' ? ` ${b}` : ''}`;
      }));
      t = eachSegment(t, (s) => s.replace(/\b([Tt]his is|[Ii] am|[Ii]'m)\s+([A-Z][A-Za-z'-]*)(?:\s+([A-Z][A-Za-z'-]*))?/g, (m, lead: string, a: string, b?: string) => {
        if (STOP.has(a.toLowerCase())) return m;
        const second = b !== undefined && !STOP.has(b.toLowerCase()) ? ` ${b}` : '';
        return `${lead} ${tokenFor('Person', a + second)}${b !== undefined && second === '' ? ` ${b}` : ''}`;
      }));
      // 4. Rules, most specific first. Each pass skips text that is already a placeholder.
      t = eachSegment(t, (s) => sub(s, EMAIL, 'Contact detail'));
      t = eachSegment(t, (s) => sub(s, URL_LIKE, 'Contact detail'));
      t = eachSegment(t, (s) => sub(s, MIXED_ID, 'Identifier'));
      t = eachSegment(t, (s) => sub(s, PHONE_LIKE, 'Contact detail', (m) => digitCount(m) >= 7));
      t = eachSegment(t, (s) => sub(s, SPOKEN_DIGITS, 'Contact detail'));
      t = eachSegment(t, (s) => sub(s, ADDRESS_DIGITS, 'Address'));
      t = eachSegment(t, (s) => sub(s, ADDRESS_WORDS, 'Address'));
      t = eachSegment(t, (s) => sub(s, PO_BOX, 'Address'));
      t = eachSegment(t, (s) => sub(s, LONG_DIGITS, 'Identifier'));

      // 5. Fail closed: the result must not look personal, and must not contain a bracket token this module did not make.
      if (piiProblems(t).length > 0) return { ok: false, code: 'RESIDUAL' };
      if (/[[\]]/.test(withoutPlaceholders(t))) return { ok: false, code: 'ODD_TEXT' };   // a caller cannot smuggle in a look-alike placeholder
      return { ok: true, text: t };
    },
    summary(): PiiCount[] {
      return PII_TYPES.filter((type) => counts[type] > 0).map((type) => ({ type, count: counts[type] }));
    },
    dispose(): void { disposed = true; known = new Map(); },
  };
}
