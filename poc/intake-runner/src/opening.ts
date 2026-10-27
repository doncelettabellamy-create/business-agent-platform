// How a founder-test call opens (proof of concept). PURE: no I/O, no clock, no model.
//
// The first words a caller hears are spoken by the phone provider from the TwiML (welcomeGreeting), before any model is involved, and they end by asking the
// caller to say yes. This file builds that text. By default it is the original test notice, word for word. When the approved config carries an optional
// `opening` block it is built from the business's own words instead:
//
//   1. the CONFIGURED BUSINESS and the AGENT are introduced by name;
//   2. the DISCLOSURE is given (that this is an automated A I assistant, and what happens to speech); the business may replace the default disclosure wording;
//   3. a SPECIAL is mentioned ONLY if the business put one in the config. Nothing here, and no model, ever writes, adds, completes or rewords a special:
//      no `special` key means no special words at all.
// Because the block is part of the config, it is part of the approval digest: changing a name, the disclosure or the special changes the digest, so the
// founder must approve it again. The wording needs a legal check by the business. The model never sees or produces any of this.

export interface Opening { business_name: string; agent_name: string; disclosure?: string; special?: string }

/** The original notice, unchanged: used whenever the config has no `opening` block. */
export const DEFAULT_CONSENT_NOTICE = 'Hello. This is an automated A I assistant, part of a test of a business phone line. We do not record the audio. Our phone provider turns your speech into text, and personal details are masked before an A I model reads it. Please say yes to continue, or hang up now.';
/** The disclosure used with an `opening` block that gives none of its own. */
export const DEFAULT_DISCLOSURE = 'We do not record the audio. Our phone provider turns your speech into text, and personal details are masked before an A I model reads it.';

const KEYS = ['agent_name', 'business_name', 'disclosure', 'special'];
const LIMITS: Record<string, [number, number]> = { business_name: [2, 80], agent_name: [2, 40], disclosure: [10, 400], special: [3, 200] };
/** One line of plain speech: no control characters, no angle or square or curly brackets (a placeholder look-alike or markup cannot be smuggled in). */
const LINE = /^[^\u0000-\u001f\u007f<>[\]{}\\]+$/;

/** Problems with an opening block. Fixed text; no value is echoed. Empty means valid. */
export function openingProblems(o: unknown): string[] {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return ['opening must be an object'];
  const p: string[] = [];
  const x = o as Record<string, unknown>;
  for (const k of Object.keys(x)) if (!KEYS.includes(k)) p.push('opening has an unexpected key');
  // An optional key that is present but undefined counts as absent (JSON cannot carry undefined; code may spread one).
  const has = (k: string): boolean => k in x && x[k] !== undefined;
  for (const k of ['business_name', 'agent_name']) if (!has(k)) p.push(`opening.${k} is required`);
  for (const k of KEYS) {
    if (!has(k)) continue;
    const v = x[k];
    const [lo, hi] = LIMITS[k];
    if (typeof v !== 'string' || v !== v.trim() || v.length < lo || v.length > hi || !LINE.test(v)) p.push(`opening.${k} must be ${lo} to ${hi} characters of plain single-line text, with no brackets`);
  }
  return p;
}

const endSentence = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`);

/**
 * The text spoken before the caller's yes. Without an opening block: the original notice. With one: introduction, disclosure, the business's special only if it
 * gave one, then the same request to say yes. Throws RangeError for an invalid block (the config check refuses it first).
 */
export function consentNoticeFor(opening?: Opening): string {
  if (opening === undefined) return DEFAULT_CONSENT_NOTICE;
  if (openingProblems(opening).length > 0) throw new RangeError('the opening block is not valid');
  const intro = `Hello. This is ${opening.agent_name}, the automated A I assistant for ${opening.business_name}.`;
  const disclosure = endSentence(opening.disclosure ?? DEFAULT_DISCLOSURE);
  const special = opening.special === undefined ? '' : ` ${endSentence(opening.special)}`;
  return `${intro} ${disclosure}${special} Please say yes to continue, or hang up now.`;
}

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The TwiML to paste into a Twilio TwiML Bin (so the phone provider hosts it and this machine exposes no HTTP endpoint for it). */
export function twimlFor(publicWssUrl: string, opening?: Opening): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Connect>\n    <ConversationRelay url="${xml(publicWssUrl)}" language="en-US" welcomeGreeting="${xml(consentNoticeFor(opening))}" welcomeGreetingInterruptible="none" />\n  </Connect>\n</Response>\n`;
}
