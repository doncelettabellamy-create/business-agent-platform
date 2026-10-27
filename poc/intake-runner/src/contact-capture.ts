// Contact capture for the cleaning pilot (proof of concept, founder test). PURE: no I/O, no clock, no model.
//
// The masker (pii-screen.ts) replaces a caller's name, phone number and address with placeholders before anything reaches a model, and keeps the raw
// values only in the call's memory. This file turns that in-memory list into the three things a callback needs, and says which of them are still
// missing. The raw values it returns go to exactly two places: the spoken read-back of the CALLBACK NUMBER (to the caller, over the phone) and the
// encrypted contact vault (contact-vault.ts) after the caller says yes. They never go into a prompt, a log, an intake record or the dashboard.
//
// How each value is found (a rule-based heuristic, like the masker; the owner confirms by calling back):
//   name     the first one or two names the masker recognised as a person, in the order they were said;
//   phone    the LAST contact detail that is a phone number: 10 to 15 digits once spoken digits ("five five five") are turned into digits;
//            an e-mail address is never a phone number;
//   address  the first three address pieces the masker recognised, in the order they were said.

import type { PiiType } from './pii-screen.ts';

export interface RevealedToken { readonly type: PiiType; readonly token: string; readonly raw: string }
export interface Contact { readonly name: string; readonly phone: string; readonly address: string }

/** The names the assistant is told to ask for. They are fixed text, never caller data. */
export const CONTACT_FIELDS = Object.freeze({ name: 'Customer name', phone: 'Callback phone number', address: 'Service address' });

const WORD: Readonly<Record<string, string>> = { zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
const MAX_PART = 120;

/** The digits of a spoken or written phone number, or undefined when it is not a usable one (10 to 15 digits, no e-mail). */
export function phoneDigits(raw: string): string | undefined {
  if (typeof raw !== 'string' || raw.length > 200 || raw.includes('@') || /\bdot\b/i.test(raw)) return undefined;
  let digits = '';
  for (const t of raw.toLowerCase().split(/[^a-z0-9]+/)) {
    if (/^\d+$/.test(t)) digits += t;
    else if (WORD[t] !== undefined) digits += WORD[t];
  }
  return /^\d{10,15}$/.test(digits) ? digits : undefined;
}

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, MAX_PART);

/** What is known so far; a missing key means that item is not usable yet. */
export function extractContact(tokens: readonly RevealedToken[]): { name?: string; phone?: string; address?: string } {
  const out: { name?: string; phone?: string; address?: string } = {};
  const people = tokens.filter((t) => t.type === 'Person').slice(0, 2).map((t) => clean(t.raw)).filter((s) => s.length >= 2);
  if (people.length > 0) out.name = people.join(' ');
  for (const t of tokens) {
    if (t.type !== 'Contact detail') continue;
    const d = phoneDigits(t.raw);
    if (d !== undefined) out.phone = d;   // the last usable one wins: a correction replaces it
  }
  const places = tokens.filter((t) => t.type === 'Address').slice(0, 3).map((t) => clean(t.raw)).filter((s) => s.length >= 2);
  if (places.length > 0) out.address = places.join(', ').slice(0, 200);
  return out;
}

/** The fixed names of the items still missing, in a fixed order. */
export function contactMissing(c: { name?: string; phone?: string; address?: string }): string[] {
  const out: string[] = [];
  if (c.name === undefined) out.push(CONTACT_FIELDS.name);
  if (c.phone === undefined) out.push(CONTACT_FIELDS.phone);
  if (c.address === undefined) out.push(CONTACT_FIELDS.address);
  return out;
}

/** Digits with a space between them, so speech synthesis reads them one at a time. */
export const spokenDigits = (phone: string): string => phone.split('').join(' ');
