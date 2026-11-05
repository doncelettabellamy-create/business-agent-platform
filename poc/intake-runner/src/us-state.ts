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
const LEAD = /^(?:(?:no|yes|yeah|well|um|uh|okay|ok|sure|so)[,.\s]+)*(?:(?:the\s+)?state\s+(?:is\s+)?|it(?:'s|\s+is)\s+(?:in\s+)?|in\s+|actually[,\s]+(?:it(?:'s|\s+is)\s+)?)?/i;
const TAIL = /[\s,.!?]*(?:please|thanks|thank you)?[\s,.!?]*$/i;

/** The full name of a state code, for the read-back spoken to the caller. Undefined for anything that is not a code. */
export function stateName(code: unknown): string | undefined { return typeof code === 'string' && Object.hasOwn(US_STATES, code) ? US_STATES[code] : undefined; }

/**
 * The state said at the END of a line: its two-letter code, and what is left of the line without it. "Austin, Texas" gives TX and "Austin"; "Austin, TX" gives TX and "Austin"; "Texas" or "the state is Texas" gives TX and an empty rest.
 * Undefined when no state is said. A house number right before the word ("123 Washington") is a street, not a state; a code in lower case, or one that is a common word on its own, is not taken.
 */
export function stateFrom(raw: unknown): { code: string; rest: string } | undefined {
  if (typeof raw !== 'string' || raw.length > 200) return undefined;
  const t = raw.replace(/[’]/g, "'").replace(/\s+/g, ' ').trim().replace(LEAD, '').replace(TAIL, '').trim();
  if (t === '') return undefined;
  const restOf = (cut: number): string => t.slice(0, cut).replace(/[\s,]+$/, '');
  const lower = t.toLowerCase();
  const take = (code: string, cut: number, wordlike: boolean): { code: string; rest: string } | undefined => {
    const rest = restOf(cut);
    if (rest !== '' && /\d$/.test(rest)) return undefined;   // "123 Washington": a street, not a state
    if (rest === '' && wordlike && WORDLIKE_CODES.has(code)) return undefined;
    return { code, rest };
  };
  for (const name of NAMES_LONGEST_FIRST) {
    if (!lower.endsWith(name)) continue;
    const cut = t.length - name.length;
    if (cut > 0 && /[a-z]/i.test(t[cut - 1])) continue;   // inside a longer word
    return take(CODE_BY_NAME.get(name)!, cut, false);
  }
  // The two-letter code, in capitals ("TX"), or the two letters spelled ("T X").
  const code = /(?:^|[\s,])([A-Z]{2})$/.exec(t); if (code !== null && Object.hasOwn(US_STATES, code[1])) return take(code[1], t.length - 2, true);
  const spelled = /(?:^|[\s,])([A-Z])\.?\s+([A-Z])\.?$/.exec(t);
  if (spelled !== null) { const c = `${spelled[1]}${spelled[2]}`; if (Object.hasOwn(US_STATES, c)) return take(c, spelled.index + (spelled[0].length - spelled[0].replace(/^[\s,]/, '').length), true); }
  return undefined;
}
