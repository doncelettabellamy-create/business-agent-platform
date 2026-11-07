// The one place that knows the names of the US states, for one job: hearing which state a caller says in their service address. PURE: no I/O, no clock, no model, no randomness.
// It never guesses. A state is taken only when the caller says it (the full name, or the two-letter code written in capitals), at the END of what was said; a word that is also a street word is not taken when a house number is all that comes before it.

export const US_STATES: Readonly<Record<string, string>> = Object.freeze({
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
});

const CODE_BY_NAME = new Map<string, string>(Object.entries(US_STATES).map(([code, name]) => [name.toLowerCase(), code]));
const NAMES_LONGEST_FIRST = [...CODE_BY_NAME.keys()].sort((a, b) => b.length - a.length);   // "west virginia" before "virginia"
/** Two-letter codes that are also common words: taken on their own only when the caller gave nothing else (not as a bare "OK"), and at the end of a line only in capitals. */
const WORDLIKE_CODES = new Set(['OK', 'IN', 'OR', 'ME', 'HI', 'OH']);
/** In lower case, a lone pair is not taken for these: the common words above and the codes that are also short words or names ("pa", "la", "ma", "de", "co", "id", "al", "md"). */
const LOWER_BARE_NEVER = new Set([...WORDLIKE_CODES, 'AL', 'DE', 'ID', 'LA', 'MA', 'PA', 'CO', 'MD', 'CT', 'NE']);
/** Codes that are also how a street ends ("Oak Ct", "Main Street NE"): as a code they are taken only right after a comma. */
const STREET_SUFFIX_CODES = new Set(['CT', 'NE']);
const LEAD = /^(?:(?:no|yes|yeah|well|um|uh|okay|ok|sure|so)[,.\s]+)*(?:(?:the\s+)?state\s+(?:is\s+)?|it(?:'s|\s+is)\s+(?:in\s+)?|in\s+|actually[,\s]+(?:it(?:'s|\s+is)\s+)?)?/i;
const TAIL = /[\s,.!?]*(?:please|thanks|thank you)?[\s,.!?]*$/i;

/** The full name of a state code, for the read-back spoken to the caller. Undefined for anything that is not a code. */
export function stateName(code: unknown): string | undefined { return typeof code === 'string' && Object.hasOwn(US_STATES, code) ? US_STATES[code] : undefined; }
/** A state written as a field value (a record read back from Jobber, a booking request): its two-letter code, from the code in any case ("CA", "ca") or from the full name in any case ("California", "new york"). EXACT only: nothing is searched for inside longer text and nothing is guessed. Undefined when it is neither (empty, "Calif.", "Ontario", a sentence, a code that is no state). Pure. */
export function stateCodeOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim().replace(/\s+/g, ' ');
  if (/^[A-Za-z]{2}$/.test(t)) { const c = t.toUpperCase(); return Object.hasOwn(US_STATES, c) ? c : undefined; }
  return CODE_BY_NAME.get(t.toLowerCase());
}

/**
 * The state said at the END of a line: its two-letter code, and what is left of the line without it. "Austin, Texas" gives TX and "Austin"; "Austin, TX" gives TX and "Austin"; "Texas" or "the state is Texas" gives TX and an empty rest.
 * Undefined when no state is said. A house number right before the word ("123 Washington") is a street, not a state. A code in capitals is taken at the end of the line; in lower case ("tx") only when anchored (after a comma, right after a ZIP code taken off the line, or as the whole answer);
 * a code that is a common word ("in", "or", "ok") is never taken on its own, and "CT" and "NE", which also end street names, only after a comma. `afterZip`: the caller of this function has just taken a ZIP code off the end of the line.
 */
export function stateFrom(raw: unknown, afterZip = false): { code: string; rest: string } | undefined {
  if (typeof raw !== 'string' || raw.length > 200) return undefined;
  const t = raw.replace(/[’]/g, "'").replace(/\s+/g, ' ').trim().replace(LEAD, '').replace(TAIL, '').trim();
  if (t === '') return undefined;
  const restOf = (cut: number): string => t.slice(0, cut).replace(/[\s,]+$/, '');
  const lower = t.toLowerCase();
  const take = (code: string, cut: number, wordlike: boolean, byCode = false): { code: string; rest: string } | undefined => {
    const rest = restOf(cut);
    if (rest !== '' && /\d$/.test(rest)) return undefined;   // "123 Washington": a street, not a state
    if (rest === '' && wordlike && WORDLIKE_CODES.has(code)) return undefined;
    if (byCode && rest !== '' && STREET_SUFFIX_CODES.has(code) && !/,\s*$/.test(t.slice(0, cut))) return undefined;   // "Oak Ct", "Main Street NE" end a street: as a code they count only after a comma ("Hartford, CT"); the full name always counts
    return { code, rest };
  };
  for (const name of NAMES_LONGEST_FIRST) {
    if (!lower.endsWith(name)) continue;
    const cut = t.length - name.length;
    if (cut > 0 && /[a-z]/i.test(t[cut - 1])) continue;   // inside a longer word
    return take(CODE_BY_NAME.get(name)!, cut, false);
  }
  // The two-letter code ("TX"), or the two letters spelled ("T X"). In capitals it is taken at the end of the line. In lower or mixed case ("tx", "Tx") a pair is also an ordinary word, so it is taken only when something anchors it:
  // it sits right after a comma or right before the ZIP code that was just taken off the end of the line (`afterZip`), or it is the whole answer; a code that is a common word is never taken in lower case, and the weaker ones only after a ZIP or a comma.
  const pair = /(?:^|[\s,])([A-Za-z]{2})$/.exec(t) ?? /(?:^|[\s,])([A-Za-z])\.?\s+([A-Za-z])\.?$/.exec(t);
  if (pair !== null) {
    const letters = pair[2] === undefined ? pair[1] : `${pair[1]}${pair[2]}`; const code = letters.toUpperCase();
    if (Object.hasOwn(US_STATES, code)) {
      const start = pair.index + (pair[0].length - pair[0].replace(/^[\s,]/, '').length);   // where the letters begin
      if (letters === code) return take(code, start, true, true);
      const rest = restOf(start); const anchored = afterZip || /,\s*$/.test(t.slice(0, start));
      if (rest === '' ? !LOWER_BARE_NEVER.has(code) : anchored && !WORDLIKE_CODES.has(code)) return take(code, start, false, true);
    }
  }
  return undefined;
}
