// The cleaning skill example (examples/skill-cleaning.json): its shape, how its keywords classify, how its fields are found, how the existing
// Intake runner treats it with the local skill and with a model, and WHY the date and the time window are separate fields (a model value must be
// copied verbatim from the masked text, and one wrong value fails the whole extraction). Synthetic data and a scripted mock provider only:
// no network, no key. This file changes no source: the skill is data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyAndExtract, LIMITS, validateSkillConfig } from '../src/classify-extract.ts';
import type { SkillConfig } from '../src/classify-extract.ts';
import { runIntake, runIntakeWithModel } from '../src/intake-runner.ts';
import type { RunResult } from '../src/intake-runner.ts';
import { validateEnvelope, validateWorkItem } from '../src/contracts.ts';
import { classifyAnswer, createMockProvider, extractAnswer } from '../src/mock-provider.ts';
import { founderConfigDigest, founderConfigProblems } from '../src/founder-call-gate.ts';
import { toOwnerCall } from '../src/owner-view.ts';
import type { IntakeRecord } from '../src/intake-record-store.ts';

const example = () => JSON.parse(readFileSync(new URL('../examples/skill-cleaning.json', import.meta.url), 'utf8'));
const CFG: SkillConfig = example().skill_config;
const NAMES = ['Job description', 'Number of rooms', 'Preferred date', 'Time window'];
const REQUIRED = ['Number of rooms', 'Preferred date', 'Time window'];

function ok(r: RunResult) {
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) throw new Error('unreachable');
  return r;
}
/** The input with its masked text replaced (the skill stays as the example has it). */
const withText = (masked_text: string) => ({ ...example(), masked_text });
/** What the phone path sends to Intake: one "Caller:" line per utterance, no labels. */
const PHONE = 'Caller: Hi, I would like a house cleaning for four rooms.\nCaller: Tomorrow please, between 9 AM and 1 PM.';

// ---------------------------------------------------------------- shape
test('shape: the example is a valid skill with ONE category and four separate, optional fields in the order the assistant should ask', () => {
  assert.deepEqual(validateSkillConfig(CFG), []);
  assert.deepEqual(CFG.fields.map((f) => f.name), NAMES);
  assert.ok(CFG.fields.every((f) => f.required === false), 'nothing is globally required; the category says what it needs');
  assert.equal(CFG.categories.length, 1);
  assert.equal(CFG.categories[0].name, 'Cleaning request');
  assert.deepEqual(CFG.categories[0].requires, REQUIRED);
});

test('shape: the date and the time window are SEPARATE fields, and no field name asks for two things at once', () => {
  const names = CFG.fields.map((f) => f.name);
  assert.ok(names.includes('Preferred date') && names.includes('Time window') && names.includes('Number of rooms'));
  for (const n of names) assert.ok(!/\band\b|\/|&|\+/.test(n), `"${n}" asks for more than one thing`);
  assert.ok(!names.some((n) => /date.*time|time.*date/i.test(n)), 'no combined date-and-time field');
  assert.equal(new Set(names).size, names.length);
});

test('shape: every requirement names a real field, keywords are unique and within the limits, and there is no plumbing category to tie with', () => {
  const fieldNames = CFG.fields.map((f) => f.name);
  for (const c of CFG.categories) {
    for (const r of c.requires ?? []) assert.ok(fieldNames.includes(r), r);
    const kws = c.keywords.map((k) => k.toLowerCase());
    assert.equal(new Set(kws).size, kws.length, 'duplicate keyword');
    assert.ok(kws.length <= LIMITS.keywordsPerCategory);
    for (const k of kws) assert.ok(k.length > 0 && k.length <= LIMITS.textLength, k);
  }
  assert.ok(!CFG.categories.some((c) => /leak|quote|booking/i.test(c.name)));
});

test('shape: the cleaning forms a caller really uses are all keywords (matching is whole-word, so each form is listed)', () => {
  const kws = CFG.categories[0].keywords;
  for (const k of ['cleaning', 'clean', 'cleaned', 'cleaner', 'cleaners', 'maid', 'housekeeping', 'deep clean', 'house clean']) assert.ok(kws.includes(k), k);
});

test('shape: the example input is a complete synthetic record that the existing contract accepts', () => {
  const x = example();
  assert.equal(x.workspace_id, 'ws-synthetic-cleaning');
  assert.equal(x.masking.applied, true);
  assert.ok(/^ws-synthetic-/.test(x.workspace_id) && x.masking.source === 'synthetic-fixture');
  const r = ok(runIntake(x));
  assert.deepEqual(validateWorkItem(r.workItem), []);
  assert.deepEqual(validateEnvelope(r.handoff), []);
});

// ---------------------------------------------------------------- classification
test('classification: the ways people ask for a clean are recognised, case does not matter', () => {
  const said: Array<[string, string]> = [
    ['I would like a house cleaning for four rooms tomorrow', 'Cleaning request'], ['Can you send a maid on Friday', 'Cleaning request'],
    ['I need a deep clean before we move', 'Cleaning request'], ['We need the carpets cleaned', 'Cleaning request'], ['Do you do window cleaners', 'Cleaning request'],
    ['HOUSE CLEANING PLEASE', 'Cleaning request'], ['Looking for housekeeping twice a month', 'Cleaning request'], ['It is a move out clean', 'Cleaning request'],
    ['Spring clean of the whole flat', 'Cleaning request'], ['I need a cleaner', 'Cleaning request'],
  ];
  for (const [text, category] of said) {
    const r = classifyAndExtract(text, CFG);
    assert.deepEqual([r.category, r.categoryOutcome], [category, 'matched'], text);
  }
});

test('classification: another service, a greeting and look-alike words are NOT cleaning', () => {
  for (const text of ['My kitchen sink is blocked and I need a plumber', 'Hello', 'I would like a quote for painting', 'cleanliness is next to godliness', 'the uncleaned floor', 'I need to move out']) {
    const r = classifyAndExtract(text, CFG);
    assert.deepEqual([r.category, r.categoryOutcome], [null, 'none'], text);
  }
});

test('classification: with one category there is never a tie, however many cleaning words are said', () => {
  const r = classifyAndExtract('cleaning, a clean, a cleaner, a maid, deep clean and housekeeping please', CFG);
  assert.deepEqual([r.category, r.categoryOutcome], ['Cleaning request', 'matched']);
});

// ---------------------------------------------------------------- local extraction and the Intake runner (deterministic skill)
test('local skill: the example text yields the four values exactly as written, and a ready, handed-off item', () => {
  const r = classifyAndExtract(example().masked_text, CFG);
  assert.deepEqual(r.fields.map((f) => [f.name, f.value]), [['Job description', 'House cleaning'], ['Number of rooms', 'four rooms'], ['Preferred date', 'tomorrow'], ['Time window', 'between 9 AM and 1 PM']]);
  assert.deepEqual(r.ambiguousFields, []);
  const run = ok(runIntake(example()));
  assert.deepEqual([run.outcome, run.workItem.status, run.workItem.category, run.workItem.missing_fields, run.workItem.reasons], ['handed-off', 'ready', 'Cleaning request', [], []]);
  assert.ok(run.handoff !== null);
});

test('local skill: each of the three requirements is enforced on its own, and what is missing is named', () => {
  const lines = ['Job description: House cleaning', 'Number of rooms: four rooms', 'Preferred date: tomorrow', 'Time window: between 9 AM and 1 PM'];
  for (const missing of REQUIRED) {
    const text = ['I would like a house cleaning.', ...lines.filter((l) => !l.startsWith(missing))].join('\n');
    const run = ok(runIntake(withText(text)));
    assert.deepEqual([run.outcome, run.workItem.status, run.workItem.missing_fields, run.workItem.reasons], ['needs-human', 'needs-human', [missing], ['missing_fields']], missing);
    assert.equal(run.handoff, null);
  }
  const noJob = ok(runIntake(withText(['I would like a house cleaning.', ...lines.slice(1)].join('\n'))));
  assert.deepEqual([noJob.workItem.status, noJob.workItem.missing_fields], ['ready', []], 'the job description is optional');
});

test('local skill: a request that is not cleaning is unknown and needs a person, with nothing handed off', () => {
  const run = ok(runIntake(withText('My kitchen sink is blocked, I need a plumber.\nNumber of rooms: four rooms\nPreferred date: tomorrow\nTime window: 9 to 1')));
  assert.deepEqual([run.workItem.category, run.workItem.status, run.workItem.reasons], ['unknown', 'needs-human', ['unknown_category']]);
  assert.equal(run.handoff, null);
});

// ---------------------------------------------------------------- the live (model) path: verbatim values, and why the fields are separate
const modelRun = (text: string, fields: Array<{ name: string; value: string | null; confidence: number }>, category: string | null = 'Cleaning request') =>
  runIntakeWithModel(withText(text), { provider: createMockProvider({ classify_request: () => classifyAnswer(category, 0.9), extract_fields: () => extractAnswer(fields) }) });

test('model path: values copied exactly from the caller\'s words are accepted, and the item is ready for the read-back', async () => {
  const run = ok(await modelRun(PHONE, [
    { name: 'Job description', value: 'house cleaning', confidence: 0.9 }, { name: 'Number of rooms', value: 'four rooms', confidence: 0.9 },
    { name: 'Preferred date', value: 'Tomorrow', confidence: 0.9 }, { name: 'Time window', value: 'between 9 AM and 1 PM', confidence: 0.9 },
  ]));
  assert.deepEqual([run.workItem.status, run.workItem.category, run.workItem.missing_fields, run.workItem.reasons], ['ready', 'Cleaning request', [], []]);
  assert.deepEqual(run.workItem.fields.map((f) => [f.name, f.value, f.found]), [['Job description', 'house cleaning', true], ['Number of rooms', 'four rooms', true], ['Preferred date', 'Tomorrow', true], ['Time window', 'between 9 AM and 1 PM', true]]);
});

test('model path: a value that is not verbatim ("4 rooms" for "four rooms") fails the WHOLE extraction, and the item goes to a person', async () => {
  const run = ok(await modelRun(PHONE, [
    { name: 'Job description', value: 'house cleaning', confidence: 0.9 }, { name: 'Number of rooms', value: '4 rooms', confidence: 0.9 },
    { name: 'Preferred date', value: 'Tomorrow', confidence: 0.9 }, { name: 'Time window', value: 'between 9 AM and 1 PM', confidence: 0.9 },
  ]));
  assert.equal(run.workItem.status, 'needs-human');
  assert.ok(run.workItem.reasons.includes('model_failed'));
  assert.equal(run.handoff, null);
  assert.ok(run.workItem.fields.every((f) => !f.found), 'the good values were not kept either');
});

test('model path: ONE field for date and time cannot work, because the two parts are not next to each other in what the caller said', async () => {
  const merged = JSON.parse(JSON.stringify(CFG)) as SkillConfig;
  merged.fields = [{ name: 'Number of rooms', required: false, extractor: { kind: 'label', labels: ['rooms'] } }, { name: 'Preferred date and time', required: false, extractor: { kind: 'label', labels: ['date'] } }];
  merged.categories[0].requires = ['Number of rooms', 'Preferred date and time'];
  assert.deepEqual(validateSkillConfig(merged), []);
  const text = 'Caller: A cleaning for four rooms please.\nCaller: Tomorrow works for me, I am out between 9 AM and 1 PM.';
  const joined = await runIntakeWithModel({ ...example(), masked_text: text, skill_config: merged }, { provider: createMockProvider({
    classify_request: () => classifyAnswer('Cleaning request', 0.9),
    extract_fields: () => extractAnswer([{ name: 'Number of rooms', value: 'four rooms', confidence: 0.9 }, { name: 'Preferred date and time', value: 'Tomorrow, between 9 AM and 1 PM', confidence: 0.9 }]),
  }) });
  const bad = ok(joined);
  assert.deepEqual([bad.workItem.status, bad.workItem.reasons.includes('model_failed')], ['needs-human', true], 'a value joined from two places is not in the text');
  // The same words as two fields, each copied from one place, work.
  const split = ok(await modelRun(text, [
    { name: 'Number of rooms', value: 'four rooms', confidence: 0.9 }, { name: 'Preferred date', value: 'Tomorrow', confidence: 0.9 }, { name: 'Time window', value: 'between 9 AM and 1 PM', confidence: 0.9 },
  ]));
  assert.deepEqual([split.workItem.status, split.workItem.missing_fields], ['ready', []]);
});

test('model path: a missing time window is named, the item is not ready, and no envelope is made', async () => {
  const run = ok(await modelRun('Caller: A house cleaning for four rooms, tomorrow please.', [
    { name: 'Job description', value: 'house cleaning', confidence: 0.9 }, { name: 'Number of rooms', value: 'four rooms', confidence: 0.9 },
    { name: 'Preferred date', value: 'tomorrow', confidence: 0.9 }, { name: 'Time window', value: null, confidence: 0 },
  ]));
  assert.deepEqual([run.workItem.status, run.workItem.missing_fields, run.workItem.reasons], ['needs-human', ['Time window'], ['missing_fields']]);
  assert.equal(run.handoff, null);
});

test('model path: if the model alone names the category (no keyword in the words), every requirement still has to be met', async () => {
  const run = ok(await modelRun('Caller: Could somebody come and scrub the flat, four rooms?', [
    { name: 'Number of rooms', value: 'four rooms', confidence: 0.9 }, { name: 'Preferred date', value: null, confidence: 0 }, { name: 'Time window', value: null, confidence: 0 },
  ]));
  assert.equal(run.workItem.category, 'Cleaning request');
  assert.deepEqual([run.workItem.status, run.workItem.missing_fields], ['needs-human', ['Preferred date', 'Time window']]);
});

test('model path: another service stays unknown even if the model is eager', async () => {
  const run = ok(await modelRun('Caller: My sink is blocked, I need a plumber, tomorrow, four rooms.', [
    { name: 'Number of rooms', value: 'four rooms', confidence: 0.9 }, { name: 'Preferred date', value: 'tomorrow', confidence: 0.9 }, { name: 'Time window', value: null, confidence: 0 },
  ], null));
  assert.deepEqual([run.workItem.category, run.workItem.status, run.workItem.reasons.includes('unknown_category')], ['unknown', 'needs-human', true]);
});

// ---------------------------------------------------------------- how the rest of the platform treats these fields
test('owner view: rooms and the window show under details, the date is the requested time, and the job is the summary (no code needed)', () => {
  const f = (name: string, value: string | null) => ({ name, value, confidence: value === null ? null : 0.9, found: value !== null });
  const record: IntakeRecord = {
    item_id: 'wi-0123456789ab', workspace_id: 'ws-founder-x', call_ref: '0123456789abcdef', received_at: '2026-10-26T20:09:21Z', category: 'Cleaning request', status: 'ready', reasons: [], missing_fields: [],
    fields: [f('Job description', 'house cleaning'), f('Number of rooms', 'four rooms'), f('Preferred date', 'tomorrow'), f('Time window', 'between 9 AM and 1 PM')],
    pii_summary: [], confidence: 0.9, versions: { skill: 'v', model: 'm', prompt: 'p' }, handed_off: true, turns: 4, confirmation: 'confirmed', address_status: 'none',
  };
  const call = toOwnerCall(record);
  assert.deepEqual([call.request, call.summary, call.requestedTime], ['Cleaning request', 'house cleaning', 'tomorrow']);
  assert.deepEqual(call.details, [{ label: 'Number of rooms', value: 'four rooms' }, { label: 'Time window', value: 'between 9 AM and 1 PM' }]);
  assert.deepEqual(call.nextActions, ['Ready for follow-up.']);
});

test('founder config: swapping in this skill is a valid config and changes the approval digest (so it must be approved again)', () => {
  const base = JSON.parse(readFileSync(new URL('../examples/founder-call.config.example.json', import.meta.url), 'utf8'));
  const cleaning = { ...base, skill_config: CFG };
  assert.deepEqual(founderConfigProblems(cleaning), []);
  assert.notEqual(founderConfigDigest(cleaning), founderConfigDigest(base));
  assert.equal(founderConfigDigest(cleaning), founderConfigDigest(JSON.parse(JSON.stringify(cleaning))), 'the digest is stable');
  const edited = JSON.parse(JSON.stringify(cleaning)); edited.skill_config.fields[1].name = 'Rooms';
  assert.notEqual(founderConfigDigest(edited), founderConfigDigest(cleaning), 'any edit to the skill is a new digest');
});
