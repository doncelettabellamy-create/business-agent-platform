// SIMULATION pricing fixture for the Drew Cleaning test (proof of concept). PURE: no I/O, no clock, no model, no network, no randomness. NOT connected to anything.
//
// This is TEST DATA and the rule that applies it. It is not an approved rate card: every result carries mode SIMULATION and a label that says so, and a fixture
// whose mode is anything else is refused. Roadmap section 3a: real prices come only from rules the business owner has approved, in LIVE mode, which does not exist.
//
// The rule (examples/pricing-fixture-drew-cleaning.json): a STANDARD cleaning of a HOUSE or APARTMENT with at most 2 bedrooms and at most 2 bathrooms is $199.99,
// less a $25.00 first-clean discount: $174.99. A price is given ONLY when every one of these is known and true; otherwise the answer is "a person must price
// this", with fixed reason codes, and no number at all:
//   - the caller confirmed the details (the read-back), and the customer confirmed this is their FIRST clean with the business;
//   - the service is the one the rule names; the property type is one the rule names; bedrooms and bathrooms are known whole numbers within the limits;
//   - no extras were asked for (extras are priced by a person: nothing here prices one); the property is known not to be commercial.
// Anything undefined, unknown, unparseable, extra, commercial or outside the rule is human pricing. Nothing is ever guessed, rounded, estimated or interpolated.
// Amounts are whole cents (no floating point). The fixture knows nothing of the opening, of any "special" announced on the phone, or of any other discount:
// the first-clean discount here is this fixture's own rule only.
//
// HOW PROCESSING COULD USE IT (not done): see the report that accompanies this file. In short, a Processing tool receives ids only (processing-entry.ts ToolArgs),
// so a pricing tool needs an approved, read-only way to get these facts for an item (like QC's evidence reader), builds QuoteFacts with factsFromWorkItem, and
// returns the SimulatedQuote (fixed codes and cents, no customer text) as its evidence.

import { parseFirstClean } from './first-clean.ts';
export { parseFirstClean };

export const SIMULATION = 'SIMULATION' as const;

export interface PricingRule {
  service: string; property_types: string[]; max_bedrooms: number; max_bathrooms: number; base_cents: number; first_clean_discount_cents: number;
}
/** `first_clean_field`: the name of the intake field whose answer says whether this is the customer's first cleaning with the business. */
export interface PricingFixture { fixture_id: string; mode: typeof SIMULATION; label: string; currency: 'USD'; first_clean_field: string; rules: PricingRule[] }
export const DEFAULT_FIRST_CLEAN_FIELD = 'First cleaning with us';

const KEYS = ['currency', 'first_clean_field', 'fixture_id', 'label', 'mode', 'rules'];
const RULE_KEYS = ['base_cents', 'first_clean_discount_cents', 'max_bathrooms', 'max_bedrooms', 'property_types', 'service'];
const TEXT = /^[^\u0000-\u001f\u007f<>[\]{}\\]{1,200}$/;
const isRec = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isInt = (x: unknown, lo: number, hi: number): x is number => Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi;

/** Problems with a fixture. Fixed text; no value is echoed. Empty means valid. */
export function fixtureProblems(x: unknown): string[] {
  if (!isRec(x)) return ['fixture must be an object'];
  const p: string[] = [];
  if (Object.keys(x).sort().join(',') !== KEYS.join(',')) p.push('fixture must have exactly the expected keys');
  if (x.mode !== SIMULATION) p.push('fixture mode must be exactly SIMULATION: a live rate card is not supported');
  if (typeof x.label !== 'string' || !x.label.startsWith('SIMULATION') || !TEXT.test(x.label)) p.push('label must be plain text that starts with SIMULATION');
  if (typeof x.fixture_id !== 'string' || !/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(x.fixture_id)) p.push('fixture_id must be a short lower-case id');
  if (x.currency !== 'USD') p.push('currency must be USD');
  if (typeof x.first_clean_field !== 'string' || !TEXT.test(x.first_clean_field) || x.first_clean_field.length > 64) p.push('first_clean_field must be the short name of an intake field');
  if (!Array.isArray(x.rules) || x.rules.length < 1 || x.rules.length > 20) { p.push('rules must list 1 to 20 rules'); return p; }
  const services: string[] = [];
  x.rules.forEach((r: unknown, i: number) => {
    if (!isRec(r) || Object.keys(r).sort().join(',') !== RULE_KEYS.join(',')) { p.push(`rules[${i}] must have exactly the expected keys`); return; }
    if (typeof r.service !== 'string' || !TEXT.test(r.service) || r.service.length > 64) p.push(`rules[${i}].service must be short plain text`);
    else if (services.includes(r.service.toLowerCase())) p.push(`rules[${i}].service is a duplicate`);
    else services.push(r.service.toLowerCase());
    if (!Array.isArray(r.property_types) || r.property_types.length < 1 || r.property_types.length > 10
      || !r.property_types.every((t: unknown) => typeof t === 'string' && /^[a-z][a-z -]{1,30}$/.test(t)) || new Set(r.property_types).size !== r.property_types.length) p.push(`rules[${i}].property_types must list 1 to 10 distinct lower-case names`);
    if (!isInt(r.max_bedrooms, 0, 10)) p.push(`rules[${i}].max_bedrooms must be a whole number from 0 to 10`);
    if (!isInt(r.max_bathrooms, 1, 10)) p.push(`rules[${i}].max_bathrooms must be a whole number from 1 to 10`);
    if (!isInt(r.base_cents, 1, 10_000_000)) p.push(`rules[${i}].base_cents must be whole cents`);
    else if (!isInt(r.first_clean_discount_cents, 0, (r.base_cents as number) - 1)) p.push(`rules[${i}].first_clean_discount_cents must be whole cents below the base`);
  });
  return p;
}
/** The fixture, or a RangeError. The returned object is deeply frozen. */
export function loadFixture(x: unknown): PricingFixture {
  if (fixtureProblems(x).length > 0) throw new RangeError('the pricing fixture is not valid');
  return JSON.parse(JSON.stringify(x), (_k, v) => (v !== null && typeof v === 'object' ? Object.freeze(v) : v)) as PricingFixture;
}

/** What a quote needs to know. Every field is optional; a missing, null or unrecognised value is "unknown" and never leads to a price. */
export interface QuoteFacts {
  /** The caller confirmed the read-back of these details. */
  confirmed?: boolean | null;
  /** The configured service name, such as "Standard cleaning". */
  service?: string | null;
  /** Lower-case property type such as "house". */
  property_type?: string | null;
  bedrooms?: number | null;
  bathrooms?: number | null;
  /** "none" only when the customer said there are no extras; "requested" for anything else they asked for. */
  extras?: 'none' | 'requested' | null;
  /** true only when the customer confirmed this is their first clean with the business. Intake does not collect this today. */
  first_clean?: boolean | null;
  /** true when the property or job is commercial; false only when it is known to be residential. */
  commercial?: boolean | null;
}
export type HumanReason =
  | 'not_confirmed' | 'service_unknown' | 'service_not_priced' | 'property_unknown' | 'property_not_priced' | 'commercial' | 'commercial_unknown'
  | 'bedrooms_unknown' | 'bedrooms_over_limit' | 'bathrooms_unknown' | 'bathrooms_over_limit' | 'extras_requested' | 'extras_unknown'
  | 'not_first_clean' | 'first_clean_unknown';
export type SimulatedQuote =
  | { readonly mode: typeof SIMULATION; readonly fixture_id: string; readonly outcome: 'priced'; readonly currency: 'USD'; readonly base_cents: number; readonly discount_cents: number; readonly total_cents: number }
  | { readonly mode: typeof SIMULATION; readonly fixture_id: string; readonly outcome: 'human-pricing'; readonly reasons: readonly HumanReason[] };

/** The quote for these facts under this fixture: a price only when everything is known and eligible, otherwise human pricing with the reasons. Never throws on odd facts. */
export function priceQuote(fixture: PricingFixture, facts: QuoteFacts | null | undefined): SimulatedQuote {
  const f: QuoteFacts = isRec(facts) ? (facts as QuoteFacts) : {};
  const why: HumanReason[] = [];
  if (f.confirmed !== true) why.push('not_confirmed');

  const svc = typeof f.service === 'string' ? f.service.trim().toLowerCase() : '';
  const rule = svc === '' ? undefined : fixture.rules.find((r) => r.service.toLowerCase() === svc);
  if (svc === '') why.push('service_unknown'); else if (rule === undefined) why.push('service_not_priced');

  const prop = typeof f.property_type === 'string' ? f.property_type.trim().toLowerCase() : '';
  if (f.commercial === true) why.push('commercial'); else if (f.commercial !== false) why.push('commercial_unknown');
  if (prop === '') why.push('property_unknown'); else if (rule !== undefined && !rule.property_types.includes(prop)) why.push('property_not_priced');
  else if (rule === undefined && prop !== '') { /* the service reason already stands */ }

  const bed = f.bedrooms; const bath = f.bathrooms;
  if (!Number.isInteger(bed) || (bed as number) < 0) why.push('bedrooms_unknown'); else if (rule !== undefined && (bed as number) > rule.max_bedrooms) why.push('bedrooms_over_limit');
  if (!Number.isInteger(bath) || (bath as number) < 1) why.push('bathrooms_unknown'); else if (rule !== undefined && (bath as number) > rule.max_bathrooms) why.push('bathrooms_over_limit');

  if (f.extras === 'requested') why.push('extras_requested'); else if (f.extras !== 'none') why.push('extras_unknown');
  if (f.first_clean === false) why.push('not_first_clean'); else if (f.first_clean !== true) why.push('first_clean_unknown');

  if (why.length > 0 || rule === undefined) return Object.freeze({ mode: SIMULATION, fixture_id: fixture.fixture_id, outcome: 'human-pricing', reasons: Object.freeze([...new Set(why)]) });
  return Object.freeze({
    mode: SIMULATION, fixture_id: fixture.fixture_id, outcome: 'priced', currency: 'USD',
    base_cents: rule.base_cents, discount_cents: rule.first_clean_discount_cents, total_cents: rule.base_cents - rule.first_clean_discount_cents,
  });
}

/** Whole cents as dollars: 17499 -> "$174.99". */
export function formatCents(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new RangeError('cents must be a whole non-negative number');
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
/** One line, always starting SIMULATION, safe to show an owner. It is not words for a caller to hear as a real quote. */
export function describeQuote(q: SimulatedQuote): string {
  if (q.outcome === 'priced') return `SIMULATION: ${formatCents(q.base_cents)} less a first-clean discount of ${formatCents(q.discount_cents)} is ${formatCents(q.total_cents)}. This is test data, not an approved price.`;
  return `SIMULATION: no price. A person must price this (${q.reasons.join(', ')}).`;
}

// ---------------------------------------------------------------- facts from a work item (strict; anything not clearly understood is unknown)
const NUMBER_WORDS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const VAGUE = /\b(?:or|to|about|around|approximately|maybe|perhaps|couple|few|several|plus|more|than|least|most|half|some|roughly|and a)\b|\d\s*-\s*\d/;
/** A single whole number said in a short answer ("two bedrooms", "2", "studio" for bedrooms), or null when the answer is vague, has two numbers, or none. */
export function parseCount(value: unknown, studioIsZero = false): number | null {
  if (typeof value !== 'string' || value.length > 80) return null;
  const t = value.toLowerCase();
  if (VAGUE.test(t)) return null;
  const found: number[] = [];
  for (const m of t.matchAll(/\b(\d{1,2})\b|\b(zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/g)) found.push(m[1] !== undefined ? Number(m[1]) : NUMBER_WORDS[m[2]]);
  if (found.length === 0) return studioIsZero && /\bstudio\b/.test(t) ? 0 : null;
  return new Set(found).size === 1 && found.length === 1 ? found[0] : null;
}
const COMMERCIAL = /\b(?:office|offices|shop|store|retail|restaurant|cafe|bar|warehouse|factory|clinic|school|church|hotel|commercial|business|building|salon|gym)\b/i;
const RESIDENTIAL = ['house', 'apartment', 'condo', 'townhouse', 'townhome', 'flat', 'duplex'];
const NO_EXTRAS = /^(?:no extras?|none|nothing|no thanks|no thank you|nope|no)$/;

export interface WorkItemLike { category: string; fields: ReadonlyArray<{ name: string; value: string | number | boolean | null; found: boolean }> }
/**
 * Facts for the quote from a work item that the caller CONFIRMED. Only the non-personal property answers are read. Commercial wording anywhere in a found answer makes
 * the job commercial. First-clean status comes from the item's first-cleaning field (named by the fixture, default "First cleaning with us") through parseFirstClean:
 * a missing, unclear or hedged answer is unknown and never qualifies. `firstClean`, when passed, is an explicit already-confirmed value that replaces the field (for tests
 * and manual use); the Processing path would omit it.
 */
export function factsFromWorkItem(item: WorkItemLike, confirmed: boolean, firstClean?: boolean | null, firstCleanField: string = DEFAULT_FIRST_CLEAN_FIELD): QuoteFacts {
  const value = (name: string): string | null => {
    const f = item.fields.find((x) => x.name === name && x.found && typeof x.value === 'string');
    return f === undefined ? null : String(f.value).trim();
  };
  const prop = value('Property type')?.toLowerCase() ?? null;
  const anyCommercial = item.fields.some((x) => x.found && typeof x.value === 'string' && COMMERCIAL.test(x.value));
  const commercial = anyCommercial ? true : prop !== null && RESIDENTIAL.includes(prop) ? false : null;
  const extrasText = value('Extras')?.toLowerCase().replace(/[.!,\s]+$/g, '') ?? null;
  return {
    confirmed,
    service: typeof item.category === 'string' && item.category !== 'unknown' ? item.category : null,
    property_type: prop,
    commercial,
    bedrooms: parseCount(value('Number of bedrooms'), true),
    bathrooms: parseCount(value('Number of bathrooms')),
    extras: extrasText === null ? null : NO_EXTRAS.test(extrasText) ? 'none' : 'requested',
    first_clean: firstClean !== undefined ? firstClean : parseFirstClean(value(firstCleanField)),
  };
}

/** The simulated quote for a confirmed work item under a fixture, with first-clean status read from the item's own field. */
export function quoteFromWorkItem(fixture: PricingFixture, item: WorkItemLike, confirmed: boolean): SimulatedQuote {
  return priceQuote(fixture, factsFromWorkItem(item, confirmed, undefined, fixture.first_clean_field));
}
