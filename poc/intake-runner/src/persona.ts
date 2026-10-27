// The receptionist persona for a business's phone line (proof of concept; OFFLINE, not wired into the live path). PURE: no I/O, no clock, no model, no network.
//
// A persona changes HOW the assistant sounds, never WHAT it may say or do. It is a business-configurable manner: a few chosen traits (warm, clear, patient,
// professional, concise and so on), a cap on sentences per reply, a pace, and the business's name and the agent's name if the business gives one. From that it
// builds two short pieces of text:
//
//   dialogueStyle   one line added to the text model's instruction, before the NEXT line, so the questions it words sound like the business's receptionist;
//   voiceManner     one line added to the voice service's speak-only instruction, so the exact words it is asked to say are delivered in the same manner.
//
// What it does NOT touch, by construction:
//   * the AI introduction, the disclosure and the request to say yes: those are built only by opening.ts from the approved config (consentNoticeFor), word for word.
//     This file never writes, repeats or rewords them, and imports nothing from it except the rule for a plain-text name;
//   * the cleaning questions: which field is asked, in what order, with which choices, is decided by code (next-field.ts) and given to the model as a NEXT line;
//   * the safety rules in the dialogue instruction (no prices, advice, promises, availability, follow-up, no invented facts, the emergency line, no goodbyes):
//     the style line is added AFTER them and says every rule and every NEXT line still applies exactly;
//   * the masker, consent, limits, records and the dashboard.
// Every phrase is fixed text chosen from a closed list. There is no free-text field, so a persona cannot be used to smuggle in an offer, a price or a promise, and
// the model and voice adapters accept only a persona object made here (isPersona), never a string.
//
// The persona text is a proposal for the business to approve, like any wording the business owns. It has not been heard on a call.

import { openingProblems } from './opening.ts';

/** The traits a business may choose. The words are fixed here; a business picks from the list and cannot add to it. */
export const TRAIT_PHRASES = Object.freeze({
  warm: 'warm',
  friendly: 'friendly',
  clear: 'clear and plain-spoken',
  patient: 'patient and unhurried',
  professional: 'professional and courteous',
  concise: 'brief',
  calm: 'calm and reassuring',
} as const);
export type Trait = keyof typeof TRAIT_PHRASES;
export const DEFAULT_TRAITS: readonly Trait[] = Object.freeze(['warm', 'clear', 'patient', 'professional', 'concise'] as Trait[]);

export interface PersonaConfig {
  business_name: string;
  agent_name?: string;
  traits?: readonly Trait[];
  /** At most this many short sentences per reply: 1 or 2. Two is also the limit in the dialogue instruction, so a persona cannot raise it. Default 2. */
  max_sentences?: 1 | 2;
  /** Default 'calm'. */
  pace?: 'calm' | 'normal';
}
declare const issued: unique symbol;
/** A validated persona. Only createPersona makes one. */
export interface Persona {
  readonly [issued]?: true;
  readonly business_name: string;
  readonly agent_name?: string;
  readonly traits: readonly Trait[];
  readonly max_sentences: 1 | 2;
  readonly pace: 'calm' | 'normal';
}

const KEYS = ['agent_name', 'business_name', 'max_sentences', 'pace', 'traits'];
const registry = new WeakSet<object>();

/** Problems with a persona config. Fixed text; no value is echoed. Empty means valid. */
export function personaProblems(c: unknown): string[] {
  if (typeof c !== 'object' || c === null || Array.isArray(c)) return ['persona must be an object'];
  const x = c as Record<string, unknown>;
  const p: string[] = [];
  for (const k of Object.keys(x)) if (!KEYS.includes(k)) p.push('persona has an unexpected key');
  const has = (k: string): boolean => k in x && x[k] !== undefined;
  // The names follow the same rules as the opening block, so the persona and the introduction can never disagree about what a valid name is.
  if (!has('business_name')) p.push('persona.business_name is required');
  const names: Record<string, unknown> = {};
  if (has('business_name')) names.business_name = x.business_name;
  if (has('agent_name')) names.agent_name = x.agent_name;
  if (has('business_name') && openingProblems(names).length > 0) p.push('persona.business_name and persona.agent_name must be plain single-line text of a sensible length, with no brackets');
  if (!has('business_name') && has('agent_name')) p.push('persona.agent_name needs a business_name');
  if (has('traits')) {
    const t = x.traits;
    if (!Array.isArray(t) || t.length < 1 || t.length > 6) p.push('persona.traits must list 1 to 6 traits');
    else {
      if (t.some((v) => typeof v !== 'string' || !Object.prototype.hasOwnProperty.call(TRAIT_PHRASES, v))) p.push('persona.traits may only use the listed traits');
      if (new Set(t).size !== t.length) p.push('persona.traits must not repeat a trait');
    }
  }
  if (has('max_sentences') && x.max_sentences !== 1 && x.max_sentences !== 2) p.push('persona.max_sentences must be 1 or 2');
  if (has('pace') && x.pace !== 'calm' && x.pace !== 'normal') p.push('persona.pace must be calm or normal');
  return p;
}

/** Validates and freezes a persona. Throws RangeError (with no value in the message) for an invalid config. */
export function createPersona(config: PersonaConfig): Persona {
  if (personaProblems(config).length > 0) throw new RangeError('the persona is not valid');
  const p = Object.freeze({
    business_name: config.business_name,
    ...(config.agent_name === undefined ? {} : { agent_name: config.agent_name }),
    traits: Object.freeze([...(config.traits ?? DEFAULT_TRAITS)]),
    max_sentences: config.max_sentences ?? 2,
    pace: config.pace ?? 'calm',
  }) as Persona;
  registry.add(p);
  return p;
}
/** True only for an object createPersona made. */
export function isPersona(x: unknown): x is Persona { return typeof x === 'object' && x !== null && registry.has(x); }

const listOf = (items: readonly string[]): string => (items.length <= 1 ? items.join('') : items.length === 2 ? `${items[0]} and ${items[1]}` : `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`);
const soundOf = (p: Persona): string => listOf(p.traits.map((t) => TRAIT_PHRASES[t]));
const sentences = (p: Persona): string => (p.max_sentences === 1 ? 'one short sentence' : 'at most two short sentences');
const who = (p: Persona): string => (p.agent_name === undefined ? '' : `, ${p.agent_name}`);

/**
 * One line for the text model, placed after its instruction (and so after every rule in it) and before the NEXT line. It says who the assistant is, how it sounds, and that
 * nothing else changes. It contains no number, price, offer, promise or time.
 */
export function dialogueStyle(p: Persona): string {
  if (!isPersona(p)) throw new RangeError('a persona made by createPersona is required');
  return `Persona: you are the receptionist for ${p.business_name}${who(p)}, an automated A I assistant and never a person; if the caller asks, say plainly that you are an automated A I assistant. `
    + `Sound ${soundOf(p)}. Keep every reply to ${sentences(p)} in plain words, at a ${p.pace} pace. `
    + 'If the caller seems unsure or asks you to repeat, stay patient and say the same thing again simply and kindly, without adding anything. '
    + 'This persona changes only how you sound. It adds no service, offer, price, availability or promise, and every rule above and the NEXT line still apply exactly.';
}

/** One line for the voice service, added to its speak-only instruction. It changes the delivery of the words it is given, never the words. */
export function voiceManner(p: Persona): string {
  if (!isPersona(p)) throw new RangeError('a persona made by createPersona is required');
  return `Speak as the receptionist for ${p.business_name}: sound ${soundOf(p)}, at a ${p.pace} pace. This changes only how the words are delivered. Do not add, drop or change any word.`;
}
