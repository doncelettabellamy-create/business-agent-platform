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
export interface CollectResult {
  readonly field: ContactField;
  readonly outcome: CollectOutcome;
  /** Raw pieces the masker must also learn (so they are masked in this and later lines). Never logged, never sent to a model. */
  readonly learn: readonly string[];
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

/** The address in a caller's words, or undefined when it has no street number plus another word (or a PO box). Never a postal check. Pure. */
export function addressFrom(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 300) return undefined;
  let t = clean(raw).replace(ADDRESS_LEAD, '').replace(ADDRESS_CUT, '').replace(ADDRESS_TAIL, '').trim();
  if (t.length < 5 || t.length > 120 || /[@\[\]<>]/.test(t)) return undefined;
  const words = t.split(' ').filter((w) => /[\p{L}\d]/u.test(w));
  if (PO_BOX.test(t)) return t;
  if (!ADDRESS_NUMBER.test(t) || words.length < 2 || !words.some((w) => /\p{L}{2,}/u.test(w))) return undefined;
  return t;
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
  status(): ContactStatus;
  dispose(): void;
}

export function createContactState(): ContactState {
  let values: { name?: string; phone?: string; address?: string } = {};
  let pending = '';   // digits of a phone number heard in pieces
  let disposed = false;

  function setPhone(raw: string, replace: boolean): CollectResult {
    const learn = digitRuns(raw);
    const whole = phoneDigits(raw);
    if (whole !== undefined) { values.phone = whole; pending = ''; return { field: 'phone', outcome: 'captured', learn }; }
    const piece = digitsOf(raw);
    if (piece === undefined || piece.length === 0) return { field: 'phone', outcome: 'unclear', learn: [] };
    const joined = (replace ? '' : pending) + piece;
    if (/^\d{10,15}$/.test(joined)) { values.phone = joined; pending = ''; return { field: 'phone', outcome: 'captured', learn }; }
    if (joined.length > 15) { pending = ''; return { field: 'phone', outcome: 'unclear', learn }; }
    pending = joined;
    return { field: 'phone', outcome: 'partial', learn };
  }

  return {
    collect(field, raw, replace = false) {
      if (disposed || typeof raw !== 'string') return { field, outcome: 'unclear', learn: [] };
      if (field === 'name') {
        const n = nameFrom(raw);
        if (n === undefined) return { field, outcome: 'unclear', learn: [] };
        values.name = n; return { field, outcome: 'captured', learn: [n] };
      }
      if (field === 'address') {
        const a = addressFrom(raw);
        if (a === undefined) return { field, outcome: 'unclear', learn: [] };
        values.address = a; return { field, outcome: 'captured', learn: [a] };
      }
      return setPhone(raw, replace);
    },
    volunteered(raw) {
      const out: CollectResult[] = [];
      if (disposed || typeof raw !== 'string' || raw.length > 1000) return out;
      const nm = CUE_NAME.exec(raw);
      if (nm !== null) { const r = this.collect('name', nm[1], true); if (r.outcome !== 'unclear') out.push(r); }
      const ph = CUE_PHONE.exec(raw);
      if (ph !== null) { const r = this.collect('phone', ph[1], true); if (r.outcome !== 'unclear') out.push(r); }
      const ad = CUE_ADDRESS.exec(raw);
      if (ad !== null) { const r = this.collect('address', ad[1], true); if (r.outcome !== 'unclear') out.push(r); }
      return out;
    },
    clear(field) { delete values[field]; if (field === 'phone') pending = ''; },
    set(field, value) { if (disposed) return; values[field] = value; if (field === 'phone') pending = ''; },
    fallback(field, value) { if (!disposed && values[field] === undefined && typeof value === 'string' && value.length > 0) values[field] = value; },
    value(field) { return disposed ? undefined : values[field]; },
    parts() { return disposed ? {} : { ...values }; },
    pendingPhone() { return !disposed && pending.length > 0 && values.phone === undefined; },
    status() {
      const captured: string[] = []; const missing: string[] = [];
      for (const k of CONTACT_FIELD_KEYS) (values[k] === undefined ? missing : captured).push(CONTACT_FIELDS[k]);
      return { captured, missing };
    },
    dispose() { disposed = true; values = {}; pending = ''; },
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
