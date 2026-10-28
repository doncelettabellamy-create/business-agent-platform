// State of ONE phone call (proof of concept, founder test). Pure state machine: no I/O, no network, no clock of its own.
//
//   consent  -> the caller must say yes to the spoken notice before anything else is heard; anything else ends the call
//   active   -> every caller utterance is masked first (pii-screen.ts); only the masked text is kept
//   ended    -> dispose() cleared everything, including the raw-to-placeholder map
//
// It keeps MASKED caller lines (what the Intake agent will read) and a short dialogue (masked caller lines and the assistant's own
// words, for the dialogue model). Raw speech is passed to mask() and dropped; it is never stored here. Limits (turns, characters,
// minutes, kill switch) are checked by `limit()`. The tenant is given at creation by the caller of this module (the relay handler),
// which takes it from its own number table, never from speech.

import { createMasker } from './pii-screen.ts';
import type { PiiCount } from './pii-screen.ts';
import { contactMissing, extractContact } from './contact-capture.ts';
import type { Contact } from './contact-capture.ts';
import { createContactState, runContactTool } from './call-state.ts';
import type { CollectOutcome, CollectReason, ContactField, ContactStatus, ContactToolResult } from './call-state.ts';
import type { PiiType } from './pii-screen.ts';

export interface SessionLimits { maxTurns: number; maxMinutes: number; maxChars: number }
export interface SessionConfig {
  limits: SessionLimits;
  /** Names to always mask (from the approved config). */
  names: readonly string[];
  /** Milliseconds since the epoch. */
  now: () => number;
  /** True when the kill switch is on. */
  killed: () => boolean;
}
export type LimitReason = 'TURNS' | 'TIME' | 'CHARS' | 'KILLED';
/** What the server captured from this line for a contact item (the one just asked for, or one the caller volunteered with an explicit cue). Fixed words only: never the value. */
export interface HeardContact { field: ContactField; outcome: CollectOutcome; reason?: CollectReason; digits?: number; total?: number }
export type Hear = { ok: true; line: string; contact?: HeardContact[] } | { ok: false; code: 'TOO_LONG' | 'ODD_TEXT' | 'RESIDUAL' | 'ENDED' };
export interface DialogueTurn { role: 'user' | 'assistant'; text: string }
export interface CallSession {
  readonly state: 'consent' | 'active' | 'ended';
  /** Judges the caller's answer to the consent notice. Anything but a plain yes is a no. */
  consent(raw: unknown): 'granted' | 'declined';
  /**
   * Takes in one caller line. `expecting` is the contact item the assistant just asked for: the line is taken as its answer and validated by the server (call-state.ts), whether or not
   * a masking rule would have recognised it. `correcting` makes an answer replace an earlier one. An explicit cue ("my name is ...") is always taken. Only the masked line is kept.
   */
  hear(raw: unknown, expecting?: ContactField, correcting?: boolean): Hear;
  /** Judges the caller's answer to the read-back (the MASKED line). A refusal wins over a yes, and a long answer is never a plain yes. */
  answer(line: unknown): 'yes' | 'no' | 'unclear';
  /** Records what the assistant said in full. */
  said(text: string): void;
  /**
   * Records what the VOICE said in its own words (native conversation). The words may repeat something the caller said, so they are masked first; words that cannot be masked cleanly
   * are replaced by a fixed marker. The raw words are not kept.
   */
  saidMasked(text: string): void;
  /** Runs one contact tool the voice asked for (call-state.ts), validated by the server. Refused unless the call is active. Never returns the value the caller gave. */
  tool(name: unknown, args: unknown): ContactToolResult;
  /** The caller talked over the assistant: only the part actually spoken counts. */
  interrupted(spoken: string): void;
  /** The masked caller lines, one per utterance, in order. This is the Intake agent's input. */
  maskedText(): string;
  turns(): number;
  piiSummary(): PiiCount[];
  /** The fixed names of the contact items (name, callback number, service address) the caller has not yet given in a usable form. No caller data. */
  contactMissing(): string[];
  /** Which contact items are captured and which are missing, as fixed labels. No caller data. */
  contactStatus(): ContactStatus;
  /** A phone number heard in pieces, not yet complete. */
  phonePending(): boolean;
  /** Diagnostics only, counts and flags (never a value): which contact items are held, and how many digits of a number heard in pieces. */
  contactDiag(): { name: boolean; phone: boolean; address: boolean; phoneDigits: number };
  /** Which part of the service address is still needed after one part was heard (a fixed word, never the part): the street name, the house number, or none. */
  addressPart(): 'street name' | 'house number' | undefined;
  /**
   * The caller's name, callback number and service address, only when all three are usable. RAW personal data: for the spoken read-back of the number
   * and the encrypted contact vault, nowhere else.
   */
  revealContact(): Contact | undefined;
  /** The contact items usable so far, any of them missing. RAW personal data, for the vault and for reading the address back to the caller over the phone only. */
  revealContactParts(): { name?: string; phone?: string; address?: string };
  /** The caller said the address was wrong: the addresses heard so far no longer count, so the next one they give replaces them. */
  forgetAddress(): void;
  dialogue(): DialogueTurn[];
  limit(): LimitReason | null;
  dispose(): void;
}

const YES = /^\s*(?:yes|yeah|yep|yup|sure|ok|okay|i agree|i do|agreed|go ahead|that'?s fine|fine|alright|all right|absolutely|of course)\b/i;
const NO = /\b(?:no|not|don'?t|do not|stop|never|nope|hang up|disagree)\b/i;
const CONFIRM_YES = /^\s*(?:yes|yeah|yep|yup|correct|right|exactly|absolutely|affirmative|sure|ok|okay|that'?s (?:right|correct|fine|good)|that is (?:right|correct|fine|good))\b/i;
const CONFIRM_NO = /\b(?:no|nope|not|wrong|incorrect|isn'?t|aren'?t|don'?t|do not|change|different|actually|wait|but)\b/i;
const MAX_ANSWER_CHARS = 60;
const MAX_DIALOGUE = 80;
const MAX_ASSISTANT_CHARS = 600;

export function createCallSession(config: SessionConfig): CallSession {
  const { limits } = config;
  for (const [k, lo, hi] of [['maxTurns', 1, 60], ['maxMinutes', 1, 10], ['maxChars', 200, 8000]] as const) {
    const v = limits[k];
    if (!Number.isInteger(v) || v < lo || v > hi) throw new RangeError(`${k} must be an integer from ${lo} to ${hi}`);
  }
  const started = config.now();
  const masker = createMasker({ names: config.names });
  const contact = createContactState();
  let seenPhone: string | undefined;
  let lastWasVoice = false;   // the newest assistant entry in the dialogue came from the voice's own words (native conversation)
  const TYPE: Record<ContactField, PiiType> = { name: 'Person', phone: 'Contact detail', address: 'Address' };
  /** The server-captured items, with the masker's detections filling only what the server has not captured (a caller who volunteered details unasked). */
  const parts = (): { name?: string; phone?: string; address?: string } => {
    const seen = extractContact(masker.reveal());
    for (const k of ['name', 'phone', 'address'] as const) contact.fallback(k, seen[k]);
    return contact.parts();
  };
  let state: 'consent' | 'active' | 'ended' = 'consent';
  let lines: string[] = [];
  let talk: DialogueTurn[] = [];
  let chars = 0;

  return {
    get state() { return state; },
    consent(raw: unknown): 'granted' | 'declined' {
      if (state !== 'consent') return 'declined';
      const ok = typeof raw === 'string' && raw.length <= 200 && YES.test(raw) && !NO.test(raw);
      state = ok ? 'active' : 'ended';
      if (!ok) this.dispose();
      return ok ? 'granted' : 'declined';
    },
    hear(raw: unknown, expecting?: ContactField, correcting = false): Hear {
      if (state !== 'active') return { ok: false, code: 'ENDED' };
      // Capture first (server-validated), then mask: what was captured is taught to the masker so this line never carries it to a model.
      const heardContact: HeardContact[] = [];
      if (typeof raw === 'string' && raw.length <= 1000) {
        const results = contact.volunteered(raw);
        if (expecting !== undefined && !results.some((r) => r.field === expecting)) results.push(contact.collect(expecting, raw, correcting));
        for (const r of results) { heardContact.push({ field: r.field, outcome: r.outcome, ...(r.reason !== undefined ? { reason: r.reason } : {}), ...(r.digits !== undefined ? { digits: r.digits } : {}), ...(r.total !== undefined ? { total: r.total } : {}) }); for (const l of r.learn) masker.learn(r.field === 'address' && r.outcome === 'partial' ? 'Contact detail' : TYPE[r.field], l); }
      }
      let m = masker.mask(raw);
      // A contact answer the masker's own fail-closed rules would refuse (a number said in an odd way) is not lost and does not end the call: the server already holds it, and the
      // line the model reads is only a placeholder.
      if (!m.ok && (m.code === 'RESIDUAL') && expecting !== undefined && heardContact.some((h) => h.field === expecting && h.outcome !== 'unclear')) m = { ok: true, text: '[CONTACT_0]' };
      if (!m.ok) return { ok: false, code: m.code };
      // A complete callback number the masker recognised in this line replaces an earlier one, whether or not it was asked for (the newest wins).
      const seenNow = extractContact(masker.reveal()).phone;
      if (seenNow !== undefined && seenNow !== seenPhone) { seenPhone = seenNow; contact.set('phone', seenNow); }
      lines.push(`Caller: ${m.text}`);
      chars += m.text.length + 8;
      talk.push({ role: 'user', text: m.text });
      if (talk.length > MAX_DIALOGUE) talk = talk.slice(-MAX_DIALOGUE);
      return { ok: true, line: m.text, ...(heardContact.length > 0 ? { contact: heardContact } : {}) };
    },
    answer(line: unknown): 'yes' | 'no' | 'unclear' {
      if (typeof line !== 'string' || line.length === 0 || line.length > 400) return 'unclear';
      if (CONFIRM_NO.test(line)) return 'no';
      return line.length <= MAX_ANSWER_CHARS && CONFIRM_YES.test(line) ? 'yes' : 'unclear';
    },
    said(text: string): void {
      if (state !== 'active' || typeof text !== 'string' || text.length === 0) return;
      lastWasVoice = false;
      talk.push({ role: 'assistant', text: text.slice(0, MAX_ASSISTANT_CHARS) });
      if (talk.length > MAX_DIALOGUE) talk = talk.slice(-MAX_DIALOGUE);
    },
    saidMasked(text: string): void {
      if (state !== 'active' || typeof text !== 'string' || text.length === 0) return;
      // The voice's own words may repeat what the caller said, and running them through the masker would mint placeholders for the assistant's own capitals (its name, a business name). Nothing reads
      // this history in native conversation (the voice has its own context), so only a fixed marker is kept; the words themselves are never stored.
      talk.push({ role: 'assistant', text: '[the assistant spoke]' });
      lastWasVoice = true;
      if (talk.length > MAX_DIALOGUE) talk = talk.slice(-MAX_DIALOGUE);
    },
    tool(name: unknown, args: unknown): ContactToolResult {
      if (state !== 'active') return { ok: false, code: 'NOT_ACTIVE' };
      const r = runContactTool(contact, name, args);
      if (r.ok && r.field !== undefined) for (const l of r.learn) masker.learn(TYPE[r.field], l);   // what the voice captured is masked from now on, wherever it is said
      return r;
    },
    interrupted(spoken: string): void {
      if (state !== 'active') return;
      const last = talk[talk.length - 1];
      if (last === undefined || last.role !== 'assistant') return;
      const part = typeof spoken === 'string' ? spoken.slice(0, MAX_ASSISTANT_CHARS) : '';
      if (part.length === 0) talk.pop(); else if (!lastWasVoice) last.text = part;   // a voice's own interrupted words are never kept
    },
    maskedText(): string { return lines.join('\n'); },
    turns(): number { return lines.length; },
    piiSummary(): PiiCount[] { return masker.summary(); },
    contactMissing(): string[] { return contactMissing(parts()); },
    contactStatus(): ContactStatus { parts(); return contact.status(); },
    phonePending(): boolean { return contact.pendingPhone(); },
    addressPart() { return contact.addressPart(); },
    contactDiag() { parts(); return { name: contact.value('name') !== undefined, phone: contact.value('phone') !== undefined, address: contact.value('address') !== undefined, phoneDigits: contact.pendingDigits() }; },
    revealContactParts(): { name?: string; phone?: string; address?: string } { return parts(); },
    forgetAddress(): void { masker.supersede('Address'); contact.clear('address'); },
    revealContact(): Contact | undefined {
      const c = parts();
      return c.name !== undefined && c.phone !== undefined && c.address !== undefined ? { name: c.name, phone: c.phone, address: c.address } : undefined;
    },
    dialogue(): DialogueTurn[] { return talk.map((t) => ({ ...t })); },
    limit(): LimitReason | null {
      if (config.killed()) return 'KILLED';
      if (lines.length >= limits.maxTurns) return 'TURNS';
      if (chars >= limits.maxChars) return 'CHARS';
      if (config.now() - started >= limits.maxMinutes * 60_000) return 'TIME';
      return null;
    },
    dispose(): void { state = 'ended'; lines = []; talk = []; chars = 0; contact.dispose(); masker.dispose(); },
  };
}
