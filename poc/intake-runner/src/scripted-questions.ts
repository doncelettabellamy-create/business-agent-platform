// The scripted question table (proof of concept, founder phone test; founder-approved 2026-10-29).
// PURE: no I/O, no clock, no model, no state. With scripted turn control every question the server asks for a required item is one of these fixed
// sentences, chosen by the field the code selected (next-field.ts) and the situation (what was already heard), never worded by a text model. A repeat is the
// same sentence again; there is no generic apology prefix. A sentence holds no word of the caller's, no bracket and no digit; the only variable parts are the
// configured choices, a COUNT of digits and the configured category names. Business names live in the approved first-cleaning question, not here.
//
// Out of scope here (kept as they are): the first-cleaning, date and time questions (fixed in founder-voice-service.ts), the residential question, the read-back, and the open
// and "listen" turns, which are not requests for a required item.
import { CONTACT_FIELDS } from './contact-capture.ts';
import { orList } from './dialogue-model.ts';
import type { AddressPart } from './dialogue-model.ts';

/** What the code knows when it asks. `rejected`: the caller's last answer to this contact item was not usable (nothing heard, no digits, not a name or an address). */
export interface ScriptedAsk {
  field: string;
  choices?: readonly string[];
  part?: AddressPart;
  phone?: number | 'restate';
  rejected?: boolean;
  /** The property-type clarification (asked once, when the first answer is not one of the configured choices): the fixed sentence lists the configured choices once. */
  clarify?: boolean;
}
/** `id` is a fixed code (logged); `text` is spoken exactly as written. */
export interface ScriptedQuestion { id: string; text: string }

const NAME = /^[^\r\n[\]<>]{1,80}$/;
/** The job fields' questions, by the configured label (compared without case or surrounding space). Only the wording is here; whether a field is required comes from the skill's category. */
export const JOB_QUESTIONS: Readonly<Record<string, string>> = Object.freeze({
  'property type': 'What type of property is it?',
  'number of bedrooms': 'How many bedrooms?',
  'number of bathrooms': 'How many bathrooms?',
  'pets': 'Do you have any pets?',
  'cleaning frequency': 'How often would you like us to clean?',
  'last professional clean': 'When was it last professionally cleaned?',
  'priority areas': 'Any areas you would like us to focus on?',
  'home empty': 'Will the home be empty during the cleaning?',
  // Offers no extra, service or price of its own.
  'extras': 'Would you like anything extra included?',
});

const key = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');
const idOf = (s: string): string => key(s).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase().slice(0, 40);
const good = (s: unknown): s is string => typeof s === 'string' && NAME.test(s) && s.trim().length > 0;

/** The fixed question for the selected field and situation. Always returns one: a field without an entry gets the plain generic sentence and the id GENERIC (a gap the tests report). */
export function scriptedQuestion(a: ScriptedAsk): ScriptedQuestion {
  const f = key(String(a.field));
  if (f === key(CONTACT_FIELDS.name)) return a.rejected === true
    ? { id: 'NAME_RETRY', text: 'Sorry, I missed that. What is your name?' }
    : { id: 'NAME', text: 'May I have your name, please?' };
  if (f === key(CONTACT_FIELDS.phone)) {
    if (typeof a.phone === 'number' && Number.isInteger(a.phone) && a.phone >= 1 && a.phone <= 9) return { id: 'PHONE_REMAINING', text: `Thank you. What are the remaining ${a.phone} digits?` };
    if (a.phone === 'restate') return { id: 'PHONE_RESTATE', text: 'Could you say the whole number again, from the start?' };
    return a.rejected === true
      ? { id: 'PHONE_RETRY', text: 'Sorry, I missed that. What is the best number to reach you?' }
      : { id: 'PHONE', text: 'What is the best number to reach you?' };
  }
  if (f === key(CONTACT_FIELDS.address)) {
    if (a.part === 'street name') return { id: 'ADDRESS_STREET', text: 'Thank you. What is the street name?' };
    if (a.part === 'house number') return { id: 'ADDRESS_NUMBER', text: 'Thank you. What is the house number?' };
    return a.rejected === true
      ? { id: 'ADDRESS_RETRY', text: 'Sorry, I missed that. What is the service address?' }
      : { id: 'ADDRESS', text: 'What is the service address?' };
  }
  const choices = (a.choices ?? []).slice(0, 10).filter(good).map((c) => c.trim());
  const offer = choices.length > 0 ? ` You can say ${orList(choices)}.` : '';
  if (a.clarify === true && f === 'property type' && choices.length > 0) return { id: 'JOB_PROPERTY_TYPE_CLARIFY', text: `Just to be sure, is it a ${orList(choices)}?` };
  // The offered choices are part of the question itself ("... is it: house, apartment, condo, or townhouse?") for the property type, so the sentence stays one short question.
  if (f === 'property type' && choices.length > 0) return { id: 'JOB_PROPERTY_TYPE', text: `What type of property is it: ${orList(choices)}?` };
  const own = JOB_QUESTIONS[f];
  if (own !== undefined) return { id: `JOB_${idOf(a.field)}`, text: `${own}${offer}` };
  return { id: 'GENERIC', text: good(a.field) ? `Can you tell me about ${a.field.trim().toLowerCase()}?${offer}` : 'Could you tell me a little more about that?' };
}

/** The category question, from the business's own configured category names (the ones it serves). The first time the names are offered; afterwards the open question. */
export function scriptedClarify(categories: readonly string[], first: boolean): ScriptedQuestion {
  const names = (categories ?? []).slice(0, 10).filter(good).map((c) => c.trim());
  if (first && names.length > 0) return { id: 'CATEGORY', text: `Are you calling about ${orList(names)}?` };
  return { id: 'CATEGORY_OPEN', text: 'Could you say in a few words what you need?' };
}
