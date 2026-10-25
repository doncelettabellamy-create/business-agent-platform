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
export type Hear = { ok: true; line: string } | { ok: false; code: 'TOO_LONG' | 'ODD_TEXT' | 'RESIDUAL' | 'ENDED' };
export interface DialogueTurn { role: 'user' | 'assistant'; text: string }
export interface CallSession {
  readonly state: 'consent' | 'active' | 'ended';
  /** Judges the caller's answer to the consent notice. Anything but a plain yes is a no. */
  consent(raw: unknown): 'granted' | 'declined';
  hear(raw: unknown): Hear;
  /** Records what the assistant said in full. */
  said(text: string): void;
  /** The caller talked over the assistant: only the part actually spoken counts. */
  interrupted(spoken: string): void;
  /** The masked caller lines, one per utterance, in order. This is the Intake agent's input. */
  maskedText(): string;
  turns(): number;
  piiSummary(): PiiCount[];
  dialogue(): DialogueTurn[];
  limit(): LimitReason | null;
  dispose(): void;
}

const YES = /^\s*(?:yes|yeah|yep|yup|sure|ok|okay|i agree|i do|agreed|go ahead|that'?s fine|fine|alright|all right|absolutely|of course)\b/i;
const NO = /\b(?:no|not|don'?t|do not|stop|never|nope|hang up|disagree)\b/i;
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
    hear(raw: unknown): Hear {
      if (state !== 'active') return { ok: false, code: 'ENDED' };
      const m = masker.mask(raw);
      if (!m.ok) return { ok: false, code: m.code };
      lines.push(`Caller: ${m.text}`);
      chars += m.text.length + 8;
      talk.push({ role: 'user', text: m.text });
      if (talk.length > MAX_DIALOGUE) talk = talk.slice(-MAX_DIALOGUE);
      return { ok: true, line: m.text };
    },
    said(text: string): void {
      if (state !== 'active' || typeof text !== 'string' || text.length === 0) return;
      talk.push({ role: 'assistant', text: text.slice(0, MAX_ASSISTANT_CHARS) });
      if (talk.length > MAX_DIALOGUE) talk = talk.slice(-MAX_DIALOGUE);
    },
    interrupted(spoken: string): void {
      if (state !== 'active') return;
      const last = talk[talk.length - 1];
      if (last === undefined || last.role !== 'assistant') return;
      const part = typeof spoken === 'string' ? spoken.slice(0, MAX_ASSISTANT_CHARS) : '';
      if (part.length === 0) talk.pop(); else last.text = part;
    },
    maskedText(): string { return lines.join('\n'); },
    turns(): number { return lines.length; },
    piiSummary(): PiiCount[] { return masker.summary(); },
    dialogue(): DialogueTurn[] { return talk.map((t) => ({ ...t })); },
    limit(): LimitReason | null {
      if (config.killed()) return 'KILLED';
      if (lines.length >= limits.maxTurns) return 'TURNS';
      if (chars >= limits.maxChars) return 'CHARS';
      if (config.now() - started >= limits.maxMinutes * 60_000) return 'TIME';
      return null;
    },
    dispose(): void { state = 'ended'; lines = []; talk = []; chars = 0; masker.dispose(); },
  };
}
