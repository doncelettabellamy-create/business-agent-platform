// Reading an answer to "is this your first cleaning with us?" (proof of concept). PURE: no I/O, no clock, no model. Imported by nothing but the phone handler and the
// SIMULATION pricing fixture.
//
// Two ideas, kept apart:
//   parseFirstClean   what a SHORT answer says: true (first), false (not first) or null (anything else, however plausible). Only exact short forms count.
//   isBareAnswer      whether the answer is only a plain yes or no. A bare yes or no says nothing about WHICH question it answers: it counts only when it follows the
//                     first-cleaning question being asked (the phone handler knows that). Explicit wording ("my first cleaning", "not my first") carries its own meaning and
//                     counts wherever it was said.
// Nothing is inferred, completed or guessed: a hedge ("I think so", "not sure"), a mixed answer ("yes but I used another company") and everything unrecognised is null.

const norm = (v: string): string => v.toLowerCase().replace(/[‘’]/g, "'").replace(/[.,!?;:]+/g, ' ').replace(/\s+/g, ' ').trim();
const LEADING_FILLER = /^(?:actually|sorry|well|um|uh|oh|hmm|okay|ok|so)(?: |$)/;
/** Lower-case, punctuation-free, with leading fillers ("actually", "sorry", "well") removed, so a correction such as "Actually, it's not my first" reads as what it says. */
function clean(value: string): string {
  let t = norm(value);
  for (let i = 0; i < 3 && LEADING_FILLER.test(t); i++) t = t.replace(LEADING_FILLER, '').trim();
  return t;
}
const WITH = '(?: with (?:you|us|them|drew cleaning))?';
const POLITE = '(?: (?:please|thanks|thank you))?';
const FIRST = '(?:my|our) first(?: (?:cleaning|time|clean|one))?';
const BARE_YES = new RegExp(`^(?:yes|yeah|yep|yup)(?: (?:it is|this is|it's|that's right|that is right|i am|we are))?${POLITE}$`);
const BARE_NO = new RegExp(`^(?:no|nope|nah)(?: (?:it is not|it isn't|it's not|this is not|we have|i have))?${POLITE}$`);
const EXPLICIT_YES = [
  new RegExp(`^(?:(?:it is|it's|this is|that is|that's) )?${FIRST}${WITH}${POLITE}$`),
  new RegExp(`^first(?: (?:cleaning|time|clean))?${WITH}${POLITE}$`),
  new RegExp(`^(?:yes|yeah|yep|yup) (?:(?:it is|it's|this is) )?${FIRST}${WITH}${POLITE}$`),
];
const EXPLICIT_NO = [
  new RegExp(`^(?:(?:it is|it's|this is|that is|that's) )?not (?:my|our|the) first(?: (?:cleaning|time|clean|one))?${WITH}${POLITE}$`),
  new RegExp(`^(?:no|nope) (?:(?:it is|it's|this is) )?not (?:my|our|the) first(?: (?:cleaning|time|clean|one))?${WITH}${POLITE}$`),
  new RegExp(`^(?:second|third|fourth|another) (?:cleaning|time|clean)${WITH}${POLITE}$`),
  /^(?:i|we) (?:have|ve|'ve) (?:used you|been|booked)(?: with you| with us)? before$/,
  /^(?:a )?(?:returning|regular|existing) customer$/,
];

/** true: first cleaning; false: not the first; null: missing, unclear, hedged, mixed or anything else. */
export function parseFirstClean(value: unknown): boolean | null {
  if (typeof value !== 'string' || value.length > 80) return null;
  const t = clean(value);
  if (t === '') return null;
  const yes = BARE_YES.test(t) || EXPLICIT_YES.some((r) => r.test(t));
  const no = BARE_NO.test(t) || EXPLICIT_NO.some((r) => r.test(t));
  return yes === no ? null : yes;
}
/** True when the whole answer is only a plain yes or no (so it could answer any yes/no question). False for everything else, including an explicit first-time answer. */
export function isBareAnswer(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 80) return false;
  const t = clean(value);
  return BARE_YES.test(t) || BARE_NO.test(t);
}
