// Local, deterministic classification-and-extraction skill (proof of concept).
//
// Works ONLY on already-masked text and ONLY with categories and fields that the caller configures
// explicitly. It contains no industry rules, no vocabulary of its own, no model, no network, no I/O.
//
//   Classification: a category scores one point per distinct configured keyword found as a whole word or
//   phrase (case-insensitive). Highest score wins. No hits -> "none". A tie for the highest score -> "ambiguous".
//   There is no margin or confidence threshold; thresholds are founder decisions (D-04) and are not invented here.
//
//   Extraction: each configured field has one extractor.
//     label: finds "<label>: value" or "<label>= value" (case-insensitive), value ends at a line break or ";".
//     token: finds masked tokens of one configured type, such as [ID_1].
//   Zero matches -> not found. Several matches with the same value -> found. Several different values -> ambiguous
//   (treated as not found, and flagged). Values longer than the limit are treated as not found.
//
//   Required fields: a field with `required: true` is always required. A category may also list `requires` (exact field
//     names); the runner (not this file) adds those for the final category. This file only validates the names.
//
// Deterministic confidence scoring is not attempted: extracted values carry confidence null.
// Error strings from validateSkillConfig contain fixed paths only, never configured values.

import { checkKeys, isNonEmptyString, isRecord } from './contracts.ts';

/** `requires` (optional) names fields that are required for this category in addition to every field with `required: true`. */
/** `route: 'human'` (optional): requests in this category always go to a person. They are never ready and never handed off, and a keyword match here outranks every other category (commercial wording is never treated as residential). */
export interface CategoryConfig { name: string; keywords: string[]; requires?: string[]; route?: 'human' }
export type ExtractorConfig =
  | { kind: 'label'; labels: string[] }
  | { kind: 'token'; token_type: string };
/** `role: 'first_clean'` (optional, at most one field): this field answers "is this the customer's first cleaning with the business?". A bare yes or no then counts for it only as the answer to that very question (relay-handler.ts). `choices` (optional): the business's own list of answers the assistant may OFFER when it asks for this field. It never limits what the caller can say and the assistant never adds to it. */
export interface FieldConfig { name: string; required: boolean; extractor: ExtractorConfig; choices?: string[]; role?: 'first_clean' }
export const MAX_CHOICES_PER_FIELD = 10;
export interface SkillConfig { categories: CategoryConfig[]; fields: FieldConfig[] }

export const LIMITS = {
  categories: 50, keywordsPerCategory: 20, textLength: 64, fields: 50, labelsPerField: 10, valueLength: 200,
} as const;

export type CategoryOutcome = 'matched' | 'none' | 'ambiguous';
export interface SkillResult {
  category: string | null;
  categoryOutcome: CategoryOutcome;
  fields: { name: string; value: string | null; confidence: null }[];
  ambiguousFields: string[];
}

const TOKEN_TYPE = /^[A-Z][A-Z0-9]{0,15}$/;
const WORD_BEFORE = '(?<![\\p{L}\\p{N}_])';
const WORD_AFTER = '(?![\\p{L}\\p{N}_])';

/** Escapes only characters that are valid identity escapes in a unicode-mode regular expression. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** Literal phrase pattern; runs of whitespace in the phrase match a run of whitespace (or spaces and tabs only) in the text. */
function phrasePattern(phrase: string, gap = '\\s+'): string {
  return phrase.trim().split(/\s+/).map(escapeRegExp).join(gap);
}

function shortText(v: unknown): v is string {
  return isNonEmptyString(v) && v.length <= LIMITS.textLength && !/[\r\n]/.test(v);
}

export function validateSkillConfig(x: unknown, path = 'skill_config'): string[] {
  const errors: string[] = [];
  if (!isRecord(x)) return [`${path}: expected object`];
  checkKeys(x, ['categories', 'fields'], path, errors);

  if (!Array.isArray(x.categories) || x.categories.length === 0 || x.categories.length > LIMITS.categories) {
    errors.push(`${path}.categories: expected 1 to ${LIMITS.categories} entries`);
  } else {
    const names: string[] = [];
    x.categories.forEach((c: unknown, i: number) => {
      const cp = `${path}.categories[${i}]`;
      if (!isRecord(c)) { errors.push(`${cp}: expected object`); return; }
      checkKeys(c, ['name', 'keywords'], cp, errors, ['requires', 'route']);
      if ('route' in c && c.route !== 'human') errors.push(`${cp}.route: expected "human" or no route`);
      if (!shortText(c.name)) errors.push(`${cp}.name: expected short single-line string`);
      else if (c.name === 'unknown') errors.push(`${cp}.name: "unknown" is reserved`);
      else if (names.includes(c.name.toLowerCase())) errors.push(`${cp}.name: duplicate`);
      else names.push(c.name.toLowerCase());
      if (!Array.isArray(c.keywords) || c.keywords.length === 0 || c.keywords.length > LIMITS.keywordsPerCategory) {
        errors.push(`${cp}.keywords: expected 1 to ${LIMITS.keywordsPerCategory} entries`);
      } else {
        const seen: string[] = [];
        c.keywords.forEach((k: unknown, j: number) => {
          if (!shortText(k)) errors.push(`${cp}.keywords[${j}]: expected short single-line string`);
          else if (seen.includes(k.trim().toLowerCase())) errors.push(`${cp}.keywords[${j}]: duplicate`);
          else seen.push(k.trim().toLowerCase());
        });
      }
    });
  }

  if (!Array.isArray(x.fields) || x.fields.length > LIMITS.fields) {
    errors.push(`${path}.fields: expected an array of at most ${LIMITS.fields} entries`);
  } else {
    const names: string[] = [];
    let firstCleanRoles = 0;
    x.fields.forEach((f: unknown, i: number) => {
      const fp = `${path}.fields[${i}]`;
      if (!isRecord(f)) { errors.push(`${fp}: expected object`); return; }
      checkKeys(f, ['name', 'required', 'extractor'], fp, errors, ['choices', 'role']);
      if ('role' in f) { if (f.role !== 'first_clean') errors.push(`${fp}.role: expected "first_clean" or no role`); else if (++firstCleanRoles > 1) errors.push(`${fp}.role: only one field may have the role first_clean`); }
      if ('choices' in f) {
        if (!Array.isArray(f.choices) || f.choices.length < 1 || f.choices.length > MAX_CHOICES_PER_FIELD) errors.push(`${fp}.choices: expected 1 to ${MAX_CHOICES_PER_FIELD} entries`);
        else {
          const seenChoices: string[] = [];
          f.choices.forEach((c: unknown, j: number) => {
            if (!shortText(c)) errors.push(`${fp}.choices[${j}]: expected short single-line string`);
            else if (seenChoices.includes(c.trim().toLowerCase())) errors.push(`${fp}.choices[${j}]: duplicate`);
            else seenChoices.push(c.trim().toLowerCase());
          });
        }
      }
      if (!shortText(f.name)) errors.push(`${fp}.name: expected short single-line string`);
      else if (names.includes(f.name)) errors.push(`${fp}.name: duplicate`);
      else names.push(f.name);
      if (typeof f.required !== 'boolean') errors.push(`${fp}.required: expected boolean`);
      const ep = `${fp}.extractor`;
      if (!isRecord(f.extractor)) { errors.push(`${ep}: expected object`); return; }
      if (f.extractor.kind === 'label') {
        checkKeys(f.extractor, ['kind', 'labels'], ep, errors);
        const labels = f.extractor.labels;
        if (!Array.isArray(labels) || labels.length === 0 || labels.length > LIMITS.labelsPerField) {
          errors.push(`${ep}.labels: expected 1 to ${LIMITS.labelsPerField} entries`);
        } else labels.forEach((l: unknown, j: number) => {
          if (!shortText(l) || /[:=;]/.test(l)) errors.push(`${ep}.labels[${j}]: expected short single-line string without : = ;`);
        });
      } else if (f.extractor.kind === 'token') {
        checkKeys(f.extractor, ['kind', 'token_type'], ep, errors);
        if (typeof f.extractor.token_type !== 'string' || !TOKEN_TYPE.test(f.extractor.token_type)) {
          errors.push(`${ep}.token_type: expected capital letters and digits, such as ID`);
        }
      } else {
        errors.push(`${ep}.kind: expected label or token`);
      }
    });
  }

  // `requires`: exact, case-sensitive field names, so a typo can never silently drop a requirement.
  if (Array.isArray(x.categories) && x.categories.length <= LIMITS.categories) {
    const fieldNames = Array.isArray(x.fields) ? x.fields.filter(isRecord).map((f) => f.name).filter((n): n is string => typeof n === 'string') : [];
    x.categories.forEach((c: unknown, i: number) => {
      if (!isRecord(c) || !Object.hasOwn(c, 'requires')) return;
      const rp = `${path}.categories[${i}].requires`;
      const r = c.requires;
      if (!Array.isArray(r) || r.length > LIMITS.fields) { errors.push(`${rp}: expected an array of at most ${LIMITS.fields} field names`); return; }
      const seen: string[] = [];
      r.forEach((n: unknown, j: number) => {
        if (typeof n !== 'string' || !fieldNames.includes(n)) errors.push(`${rp}[${j}]: expected the exact name of a configured field`);
        else if (seen.includes(n)) errors.push(`${rp}[${j}]: duplicate`);
        else seen.push(n);
      });
    });
  }
  return errors;
}

/** Counts distinct configured keywords found per category and picks a winner, or reports none or a tie. */
export function classifyRequest(text: string, categories: CategoryConfig[]): { outcome: CategoryOutcome; category: string | null } {
  let best = 0;
  let winners: string[] = [];
  const hitsBy = new Map<string, number>();
  for (const c of categories) {
    let hits = 0;
    const seen = new Set<string>();
    for (const k of c.keywords) {
      const key = k.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (new RegExp(`${WORD_BEFORE}${phrasePattern(k)}${WORD_AFTER}`, 'iu').test(text)) hits++;
    }
    hitsBy.set(c.name, hits);
    if (hits > best) { best = hits; winners = [c.name]; }
    else if (hits === best && hits > 0) winners.push(c.name);
  }
  // A match in a human-route category outranks every other category, whatever else was said: such a request is never classified as an automated service.
  const human = categories.filter((c) => c.route === 'human' && (hitsBy.get(c.name) ?? 0) > 0);
  if (human.length > 0) {
    const top = Math.max(...human.map((c) => hitsBy.get(c.name) as number));
    const tops = human.filter((c) => hitsBy.get(c.name) === top);
    return tops.length === 1 ? { outcome: 'matched', category: tops[0].name } : { outcome: 'ambiguous', category: null };
  }
  if (best === 0) return { outcome: 'none', category: null };
  if (winners.length > 1) return { outcome: 'ambiguous', category: null };
  return { outcome: 'matched', category: winners[0] };
}

type Extracted = { state: 'found'; value: string } | { state: 'none' } | { state: 'ambiguous' };

function resolve(values: string[]): Extracted {
  if (values.length === 0) return { state: 'none' };
  const distinct = new Set(values.map((v) => v.toLowerCase()));
  if (distinct.size > 1) return { state: 'ambiguous' };
  const value = values[0];
  return value.length > LIMITS.valueLength ? { state: 'none' } : { state: 'found', value };
}

function extractOne(text: string, f: FieldConfig): Extracted {
  const values: string[] = [];
  if (f.extractor.kind === 'label') {
    for (const label of f.extractor.labels) {
      // Spaces and tabs only around the separator: a line break must end an empty value, never be skipped over.
      const re = new RegExp(`${WORD_BEFORE}${phrasePattern(label, '[ \\t]+')}[ \\t]*[:=][ \\t]*([^\\r\\n;]*)`, 'giu');
      for (const m of text.matchAll(re)) {
        const v = m[1].trim().replace(/[.,\s]+$/, '');
        if (v.length > 0) values.push(v);
      }
    }
  } else {
    const re = new RegExp(`\\[${f.extractor.token_type}_\\d+\\]`, 'g');
    for (const m of text.matchAll(re)) values.push(m[0]);
  }
  return resolve(values);
}

/** The whole skill: classify, then extract every configured field. Never throws on text content. */
export function classifyAndExtract(text: string, config: SkillConfig): SkillResult {
  const cls = classifyRequest(text, config.categories);
  const ambiguousFields: string[] = [];
  const fields = config.fields.map((f) => {
    const r = extractOne(text, f);
    if (r.state === 'ambiguous') ambiguousFields.push(f.name);
    return { name: f.name, value: r.state === 'found' ? r.value : null, confidence: null as null };
  });
  return { category: cls.category, categoryOutcome: cls.outcome, fields, ambiguousFields };
}
