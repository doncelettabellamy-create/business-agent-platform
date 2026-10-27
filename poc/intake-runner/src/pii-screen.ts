// Personal-data screen and masker for the founder phone test (proof of concept). Pure: no I/O, no clock, no network.
//
// THIS IS NOT THE PLATFORM MASKING STAGE (INT-07 is not started). It is a rule-based masker for ONE controlled test where the caller is the
// founder speaking an INVENTED persona. It replaces what rules can recognise with placeholders the Intake agent already understands
// ([PERSON_n], [ADDRESS_n], [CONTACT_n], [ID_n]) and FAILS CLOSED: if anything personal-looking is still there after masking, or the
// utterance is odd (too long, control characters, brackets), the utterance is refused and never reaches a model.
//
// It is built for how a speech-to-text service writes speech, not how a form is filled in. Besides digits and `@` it recognises:
//   - spoken e-mail ("sam at example dot com", "dot com", "at gmail") and "my e-mail / phone / number is ..." (the rest of the phrase is masked);
//   - addresses with a number (digits or words), "my address is ...", "I live / am located at ...", PO boxes, and a street with NO number
//     ("Elm Street", "Main Road") when the word before it is not an article or a preposition;
//   - post codes (UK and Canadian forms), US ZIP and long digit runs, mixed letter-digit identifiers;
//   - names: those listed in the approved config, introductions ("my name is", "this is" + a capital, "I'm" + a capital), honorifics
//     ("Mr Jones"), "named / called X", and ANY capitalised word that is not at the start of a sentence (speech-to-text capitalises proper
//     nouns), plus a capitalised pair at the start of a sentence. Days, months and a few common words are not names.
// What it still cannot do: recognise a lower-case name or place that nothing introduces ("sam example here", "springfield"), because a rule
// cannot tell it from an ordinary word. That is why the test rule is "speak invented details only". Names listed in the approved config are
// always masked (in any case), and a value once masked stays masked for the rest of that call. The raw-to-placeholder map lives in memory for
// one call and is cleared by dispose().
//
// `piiProblems(text)` is the subset of these detectors that can be applied to already-written text (it cannot use capitalisation, because
// stored category and field names are capitalised); the record store uses it to refuse to save anything personal-looking.

export type PiiType = 'Person' | 'Address' | 'Contact detail' | 'Identifier';
export const PII_TYPES: readonly PiiType[] = ['Person', 'Address', 'Contact detail', 'Identifier'];
export interface PiiCount { type: PiiType; count: number }

const TOKEN: Record<PiiType, string> = { Person: 'PERSON', Address: 'ADDRESS', 'Contact detail': 'CONTACT', Identifier: 'ID' };
/** A placeholder this module produced. Everything matching it is skipped by the detectors. */
const PLACEHOLDER = /\[(?:PERSON|ADDRESS|CONTACT|ID)_\d{1,3}\]/g;

const NUM_WORD = '(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)';
const STREET = '(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|way|boulevard|blvd|place|pl|terrace|circle|highway|hwy|close|crescent)';
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SPOKEN_EMAIL = /\b[\w.+-]+(?:\s+(?:underscore|dash|hyphen|dot|plus)\s+[\w.+-]+)*\s+at\s+(?:[\w-]+\s+){0,3}?dot\s+[\w-]+(?:\s+dot\s+[\w-]+)*\b/gi;
const DOT_TLD = /\bdot\s+(?:com|net|org|edu|gov|io|co|uk|us|info|biz|ca|au|de|fr)\b/gi;
const MAIL_HOST = /\bat\s+(?:gmail|yahoo|hotmail|outlook|icloud|aol|proton(?:mail)?|msn)\b/gi;
const URL_LIKE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
const PHONE_LIKE = /\+?\d[\d\s().-]{5,}\d/g;
/** One digit as spoken ("five"), written ("5") or a whole group of written digits ("0199"), optionally repeated: "double zero", "triple 5" ("treble" is the British form). */
const SPOKEN_TOKEN = `(?:(?:double|triple|treble)[\\s-]+)?(?:${NUM_WORD}|\\d+)`;
/** A run of two or more such tokens. It is only a candidate: it is a number when it has at least one spoken word in it (a run of written digits alone has its own rules below) and stands for 5 or more digits. */
const SPOKEN_DIGITS = new RegExp(`\\b${SPOKEN_TOKEN}(?:[\\s,.-]+${SPOKEN_TOKEN})+\\b`, 'gi');
const REPEATS: Readonly<Record<string, number>> = { double: 2, triple: 3, treble: 3 };
/** How many digits a run stands for: "double zero" is two, "triple five" three, "0199" four. A repeat word repeats one digit only, never a group. */
export function spokenDigitCount(run: string): number {
  let n = 0; let times = 1;
  for (const w of run.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w === '') continue;
    if (REPEATS[w] !== undefined) { times = REPEATS[w]; continue; }
    n += /^\d+$/.test(w) ? (w.length === 1 ? times : w.length) : times;
    times = 1;
  }
  return n;
}
const MIN_SPOKEN_RUN = 5;
/** A run that mixes or consists of spoken digit words and stands for a number of 5 or more digits. Digits written alone are left to the rules for written digits. */
const isSpokenNumber = (run: string): boolean => /[a-z]/i.test(run) && spokenDigitCount(run) >= MIN_SPOKEN_RUN;
const hasSpokenDigits = (t: string): boolean => [...t.matchAll(new RegExp(SPOKEN_DIGITS.source, 'gi'))].some((m) => isSpokenNumber(m[0]));
const ADDRESS_DIGITS = new RegExp(`\\b\\d{1,6}(?:[\\s,.-]+\\d{1,6})*\\s+(?:[A-Za-z][A-Za-z'.-]*\\s+){0,3}${STREET}\\b\\.?`, 'gi');
/** Digits left standing right before an address placeholder: the number of a street whose name was masked but whose digits were not. */
const DIGITS_BEFORE_ADDRESS = /\d(?:[\s,.-]+\d)*[\s,]*\[ADDRESS_\d{1,3}\]/;
const ADDRESS_WORDS = new RegExp(`\\b(?:${NUM_WORD}|ten|eleven|twelve|(?:thir|four|fif|six|seven|eigh|nine)teen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)(?:[\\s-]+(?:${NUM_WORD}|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)){0,4}\\s+(?:[A-Za-z][A-Za-z'.-]*\\s+){0,2}${STREET}\\b\\.?`, 'gi');
const PO_BOX = /\bp\.?\s?o\.?\s+box\s+\w+/gi;
const POSTCODE = /\b(?:[a-z]{1,2}\d[a-z\d]?\s?\d[a-z]{2}|[a-z]\d[a-z]\s?\d[a-z]\d)\b/gi;
const LONG_DIGITS = /\d{5,}/g;
/** Digits said one at a time or in groups ("1 5 9 5 1", "15 951", "1, 5, 9, 5, 1"): a zip code, a street number or an id read out, 5 or more digits in all. */
const DIGIT_GROUPS = /\b\d{1,6}(?:\s+\d{1,6})+\b/g;
const SINGLE_DIGITS = /\b\d(?:[\s,.-]+\d){4,}\b/g;
const MIN_SPOKEN_DIGITS = 5;
const MIXED_ID = /\b(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9-]{8,}\b/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const STOP = new Set(['a', 'an', 'the', 'about', 'calling', 'regarding', 'my', 'just', 'not', 'so', 'really', 'very', 'in', 'at', 'on', 'for', 'to', 'from', 'with', 'and', 'but', 'having', 'looking', 'trying', 'here', 'there', 'sorry', 'afraid', 'sure', 'ok', 'okay', 'yes', 'no']);
/** Words that may stand before "street / road ..." without being part of a street name, and words that never follow "named / called" as a name. */
const NOT_NAME = new Set([...STOP, 'our', 'your', 'this', 'that', 'these', 'those', 'near', 'down', 'up', 'across', 'along', 'of', 'same', 'other', 'next', 'front', 'back', 'whole', 'entire', 'fast', 'slow', 'side', 'it', 'them', 'you', 'me', 'us', 'him', 'her', 'again', 'earlier', 'yesterday', 'today', 'twice', 'once', 'someone', 'somebody', 'anyone', 'already', 'before', 'out', 'off', 'over', 'is', 'was', 'are', 'be', 'have', 'has', 'had', 'i', 'we', 'he', 'she', 'they', 'if', 'or', 'by', 'into', 'onto', 'under', 'through', 'around', 'outside', 'inside', 'one', 'any', 'some', 'which', 'what', 'where']);
/** Capitalised words that are not names. Anything else capitalised in the middle of a sentence is treated as a name or a place. */
const ALLOWED_CAPS = new Set(['Mr', 'Mrs', 'Ms', 'Mx', 'Miss', 'Dr', 'Mister', 'Missus', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
  'Okay', 'Yes', 'No', 'Hi', 'Hello', 'Hey', 'Thanks', 'Thank', 'Please', 'Sorry', 'Well', 'So', 'And', 'But', 'Also', 'Then', 'Now', 'Right', 'Sure', 'Good', 'Great', 'Yeah', 'Yep', 'Nope', 'Today', 'Tomorrow', 'Yesterday', 'Morning', 'Afternoon', 'Evening', 'Tonight', 'Goodbye', 'Bye']);
const NAME_WORD = "(?:[A-Z]['’])?[A-Z][a-z][A-Za-z'’-]*";
const CAPITAL_RUN = new RegExp(`${NAME_WORD}(?:\\s+${NAME_WORD})*`, 'g');
const END = "(?=\\s+(?:and|but|so|because|then|please|thanks|thank)\\b|[.,;!?]|$)";
const ADDRESS_CUE = new RegExp(`\\b(?:address\\s*(?:is|:)|(?:live|lives|living|located)\\s+(?:at|on|in))\\s+([^.,;!?]{1,60}?)${END}`, 'gi');
const CONTACT_CUE = new RegExp(`\\b(?:e-?mail(?:\\s+address)?|phone(?:\\s+number)?|(?:cell|mobile|contact)(?:\\s+number)?|number)\\s*(?:is|:)\\s+([^.,;!?]{1,60}?)${END}`, 'gi');
const HONORIFIC = /\b(?:mr|mrs|ms|mx|miss|dr|mister|missus)\.?\s+([A-Za-z][A-Za-z'’-]*)/gi;
const NAMED = /\b(?:named|called)\s+([A-Za-z][A-Za-z'’-]*)(?:\s+([A-Z][A-Za-z'’-]*))?/g;
const PLAIN_STREET = /\b((?:[A-Za-z][A-Za-z'’.-]*\s+){1,2})(street|avenue|road|boulevard|terrace|highway|lane)\b/gi;

export const MAX_UTTERANCE_CHARS = 1000;

const digitCount = (s: string): number => (s.match(/\d/g) ?? []).length;
function withoutPlaceholders(s: string): string { return s.replace(PLACEHOLDER, ' '); }

/** A street WITHOUT a number: returns [startOffset, endOffset] pairs of the street name plus its suffix, leaving out articles and prepositions before it. */
function plainStreets(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of text.matchAll(PLAIN_STREET)) {
    const lead = m[1]; const words = [...lead.matchAll(/\S+/g)];
    let k = 0;
    while (k < words.length && NOT_NAME.has(words[k][0].toLowerCase())) k++;
    if (k >= words.length) continue;                                    // "the road", "on lane": not a name
    const start = (m.index as number) + (words[k].index as number);
    out.push([start, (m.index as number) + m[0].length]);
  }
  return out;
}

/** Codes for personal-looking content in `text` (placeholders are ignored). Empty means nothing was recognised. */
export function piiProblems(text: string): string[] {
  const t = withoutPlaceholders(text);
  const out: string[] = [];
  if (new RegExp(EMAIL.source).test(t)) out.push('email');
  if (new RegExp(SPOKEN_EMAIL.source, 'i').test(t) || new RegExp(DOT_TLD.source, 'i').test(t) || new RegExp(MAIL_HOST.source, 'i').test(t)) out.push('spoken_email');
  if (new RegExp(URL_LIKE.source, 'i').test(t)) out.push('url');
  for (const m of t.matchAll(PHONE_LIKE)) if (digitCount(m[0]) >= 7) { out.push('phone'); break; }
  if (hasSpokenDigits(t)) out.push('spoken_digits');
  if (new RegExp(ADDRESS_DIGITS.source, 'i').test(t) || new RegExp(ADDRESS_WORDS.source, 'i').test(t) || new RegExp(PO_BOX.source, 'i').test(t) || plainStreets(t).length > 0 || DIGITS_BEFORE_ADDRESS.test(text)) out.push('address');
  if (new RegExp(POSTCODE.source, 'i').test(t)) out.push('postcode');
  if (/\d{5,}/.test(t)) out.push('digits');
  else if (new RegExp(SINGLE_DIGITS.source).test(t) || [...t.matchAll(DIGIT_GROUPS)].some((m) => digitCount(m[0]) >= MIN_SPOKEN_DIGITS)) out.push('digits');
  if (new RegExp(MIXED_ID.source).test(t)) out.push('identifier');
  return out;
}

export type MaskResult = { ok: true; text: string } | { ok: false; code: 'TOO_LONG' | 'ODD_TEXT' | 'RESIDUAL' };
export interface Masker {
  /** Masks one utterance. Never throws on text content. */
  mask(raw: unknown): MaskResult;
  /** Counts of placeholders handed out so far. */
  summary(): PiiCount[];
  /**
   * The raw value behind every placeholder handed out in this call, in the order they were made. For the one caller that must have them (the contact
   * capture of the cleaning pilot, which sends them only to the caller over the phone and to the encrypted contact vault). Empty after dispose().
   */
  reveal(): { type: PiiType; token: string; raw: string }[];
  /** Sets aside every value of this type heard so far: reveal() no longer returns them, so a correction replaces rather than adds to them. Placeholders in text already masked stay. */
  supersede(type: PiiType): void;
  /** Forgets every raw value. After this, mask() refuses. */
  dispose(): void;
}

function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function createMasker(options: { names?: readonly string[] } = {}): Masker {
  const names = (options.names ?? []).filter((n) => typeof n === 'string' && n.trim().length >= 2).map((n) => n.trim());
  const counters: Record<PiiType, number> = { Person: 0, Address: 0, 'Contact detail': 0, Identifier: 0 };
  const counts: Record<PiiType, number> = { Person: 0, Address: 0, 'Contact detail': 0, Identifier: 0 };
  let known = new Map<string, string>();   // raw value (lower case) -> placeholder, for this call only
  let ignored = new Set<string>();   // tokens set aside by supersede()
  let originals: { type: PiiType; token: string; raw: string }[] = [];   // the same values as first said, for reveal(); cleared by dispose()
  let disposed = false;

  function tokenFor(type: PiiType, raw: string): string {
    const key = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    const have = known.get(key);
    if (have !== undefined) return have;
    counters[type]++;
    counts[type]++;
    const token = `[${TOKEN[type]}_${counters[type]}]`;
    known.set(key, token);
    originals.push({ type, token, raw: raw.trim().slice(0, 200) });
    return token;
  }
  const sub = (text: string, re: RegExp, type: PiiType, accept: (m: string) => boolean = () => true): string =>
    text.replace(re, (m) => (accept(m) ? tokenFor(type, m) : m));
  /** Masks only the captured group of a cue such as "my number is <this part>". */
  const subCue = (text: string, re: RegExp, type: PiiType): string =>
    text.replace(re, (m: string, g: string) => (g.trim().length === 0 ? m : m.slice(0, m.length - g.length) + tokenFor(type, g)));

  /** Splits on placeholders so a later rule never rewrites an earlier placeholder. The callback also learns whether the segment starts the utterance. */
  function eachSegment(text: string, fn: (segment: string, first: boolean) => string): string {
    let out = ''; let last = 0; let first = true;
    for (const m of text.matchAll(PLACEHOLDER)) { out += fn(text.slice(last, m.index), first) + m[0]; last = (m.index as number) + m[0].length; first = false; }
    return out + fn(text.slice(last), first);
  }

  function maskStreets(s: string): string {
    const spans = plainStreets(s);
    let out = ''; let at = 0;
    for (const [a, b] of spans) { if (a < at) continue; out += s.slice(at, a) + tokenFor('Address', s.slice(a, b)); at = b; }
    return out + s.slice(at);
  }

  /** Capitalised words that are not at the start of a sentence are treated as names or places; so is a capitalised pair at a sentence start. */
  function maskCapitalised(s: string, first: boolean): string {
    return s.replace(CAPITAL_RUN, (run: string, offset: number) => {
      const before = s.slice(0, offset).trimEnd();
      const sentenceStart = (offset === 0 && first) || /[.!?]$/.test(before);
      const words = [...run.matchAll(/\S+/g)].map((w) => ({ text: w[0], index: w.index as number }));
      if (sentenceStart && words.length === 1) return run;
      let a = 0; let b = words.length - 1;
      while (a <= b && ALLOWED_CAPS.has(words[a].text)) a++;
      while (b >= a && ALLOWED_CAPS.has(words[b].text)) b--;
      if (a > b) return run;
      if (sentenceStart && a === b && a === 0) return run;               // a single sentence-start word after trimming allowed ones is not enough to call it a name
      const startAt = words[a].index; const endAt = words[b].index + words[b].text.length;
      return run.slice(0, startAt) + tokenFor('Person', run.slice(startAt, endAt)) + run.slice(endAt);
    });
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
      // 3b. Honorifics and "named / called".
      t = eachSegment(t, (s) => s.replace(HONORIFIC, (m: string, w: string) => (NOT_NAME.has(w.toLowerCase()) ? m : m.slice(0, m.length - w.length) + tokenFor('Person', w))));
      t = eachSegment(t, (s) => s.replace(NAMED, (m: string, a: string, b?: string) => {
        if (NOT_NAME.has(a.toLowerCase())) return m;
        const lead = m.slice(0, m.indexOf(a));
        return `${lead}${tokenFor('Person', a + (b !== undefined && !NOT_NAME.has(b.toLowerCase()) ? ` ${b}` : ''))}${b !== undefined && NOT_NAME.has(b.toLowerCase()) ? ` ${b}` : ''}`;
      }));
      // 4. Rules, most specific first. Each pass skips text that is already a placeholder.
      t = eachSegment(t, (s) => sub(s, EMAIL, 'Contact detail'));
      t = eachSegment(t, (s) => sub(s, SPOKEN_EMAIL, 'Contact detail'));
      t = eachSegment(t, (s) => sub(s, URL_LIKE, 'Contact detail'));
      // A number said in words, digits or both comes before the identifier rule, so one joined with hyphens ("five-5-0-oh-1-...") is a contact detail, not an identifier.
      t = eachSegment(t, (s) => sub(s, SPOKEN_DIGITS, 'Contact detail', isSpokenNumber));
      t = eachSegment(t, (s) => sub(s, MIXED_ID, 'Identifier'));
      t = eachSegment(t, (s) => sub(s, PHONE_LIKE, 'Contact detail', (m) => digitCount(m) >= 7));
      t = eachSegment(t, (s) => sub(s, ADDRESS_DIGITS, 'Address'));
      t = eachSegment(t, (s) => sub(s, ADDRESS_WORDS, 'Address'));
      t = eachSegment(t, (s) => sub(s, PO_BOX, 'Address'));
      t = eachSegment(t, (s) => maskStreets(s));
      t = eachSegment(t, (s) => sub(s, POSTCODE, 'Identifier'));
      t = eachSegment(t, (s) => sub(s, LONG_DIGITS, 'Identifier'));
      // 4b. Cues: "my e-mail / phone / number is ..." and "my address is ...", "I live at ...": whatever follows, if not already masked, is masked.
      t = eachSegment(t, (s) => subCue(s, CONTACT_CUE, 'Contact detail'));
      t = eachSegment(t, (s) => subCue(s, ADDRESS_CUE, 'Address'));
      // 4b'. Digits read out on their own ("the zip is 9 1 3 6 4"): after the cues, so "my address is ..." still counts as an address.
      t = eachSegment(t, (s) => sub(s, SINGLE_DIGITS, 'Identifier'));
      t = eachSegment(t, (s) => sub(s, DIGIT_GROUPS, 'Identifier', (m) => digitCount(m) >= MIN_SPOKEN_DIGITS));
      // 4c. Anything left that is still a trace of an e-mail address ("dot com", "at gmail") is masked on its own.
      t = eachSegment(t, (s) => sub(sub(s, DOT_TLD, 'Contact detail'), MAIL_HOST, 'Contact detail'));
      // 4d. Capitalised words in the middle of a sentence are names or places.
      t = eachSegment(t, (s, first) => maskCapitalised(s, first));

      // 5. Fail closed: the result must not look personal, and must not contain a bracket token this module did not make.
      if (piiProblems(t).length > 0) return { ok: false, code: 'RESIDUAL' };
      if (/[[\]]/.test(withoutPlaceholders(t))) return { ok: false, code: 'ODD_TEXT' };   // a caller cannot smuggle in a look-alike placeholder
      return { ok: true, text: t };
    },
    summary(): PiiCount[] {
      return PII_TYPES.filter((type) => counts[type] > 0).map((type) => ({ type, count: counts[type] }));
    },
    reveal(): { type: PiiType; token: string; raw: string }[] { return disposed ? [] : originals.filter((o) => !ignored.has(o.token)).map((o) => ({ ...o })); },
    supersede(type: PiiType): void { for (const o of originals) if (o.type === type) ignored.add(o.token); },
    dispose(): void { disposed = true; known = new Map(); originals = []; ignored = new Set(); },
  };
}
