// The services cleaning skill (examples/skill-cleaning-services.json): standard, deep and move-in/move-out, each with its own required questions, so the
// assistant asks only what is relevant to the service. Property details (type, bedrooms, bathrooms), pets and extras are asked where they matter; frequency,
// priority areas and move-out details are service-specific. Synthetic data and a scripted mock provider only; the live example (skill-cleaning.json) is untouched.
// No price, quote or special lives in this skill, and none is ever asked or applied here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateSkillConfig } from '../src/classify-extract.ts';
import type { SkillConfig } from '../src/classify-extract.ts';
import { runIntake, runIntakeWithModel } from '../src/intake-runner.ts';
import type { RunResult } from '../src/intake-runner.ts';
import { validateEnvelope, validateWorkItem } from '../src/contracts.ts';
import { classifyAnswer, createMockProvider, extractAnswer } from '../src/mock-provider.ts';
import { founderConfigDigest, founderConfigProblems } from '../src/founder-call-gate.ts';
import { DIALOGUE_INSTRUCTION } from '../src/dialogue-model.ts';

const example = () => JSON.parse(readFileSync(new URL('../examples/skill-cleaning-services.json', import.meta.url), 'utf8'));
const CFG: SkillConfig = example().skill_config;
const withText = (masked_text: string) => ({ ...example(), masked_text });
const ok = (r: RunResult) => { assert.equal(r.ok, true, JSON.stringify(r)); if (!r.ok) throw new Error('unreachable'); return r; };

const STANDARD = 'Standard cleaning'; const DEEP = 'Deep cleaning'; const MOVE = 'Move-in or move-out cleaning'; const COMMERCIAL = 'Commercial cleaning';
const RES = () => CFG.categories.filter((c) => c.route !== 'human');
const PROPERTY = ['Property type', 'Number of bedrooms', 'Number of bathrooms'];
const FIRST = 'First cleaning with us';
/** The questions each service asks, in the order they are asked. */
const REQUIRES: Record<string, string[]> = {
  [STANDARD]: [...PROPERTY, 'Pets', 'Cleaning frequency', 'Extras', FIRST, 'Preferred date', 'Time window'],
  [DEEP]: [...PROPERTY, 'Pets', 'Last professional clean', 'Priority areas', 'Extras', FIRST, 'Preferred date', 'Time window'],
  [MOVE]: [...PROPERTY, 'Pets', 'Home empty', 'Extras', FIRST, 'Preferred date', 'Time window'],
};
const ONLY_FOR: Record<string, string> = { 'Cleaning frequency': STANDARD, 'Last professional clean': DEEP, 'Priority areas': DEEP, 'Home empty': MOVE };

test('shape: a valid skill with the three services, each requiring its own questions, and every requirement names a real field', () => {
  assert.deepEqual(validateSkillConfig(CFG), []);
  assert.deepEqual(CFG.categories.map((c) => c.name), [STANDARD, DEEP, MOVE, COMMERCIAL]);
  for (const c of RES()) assert.deepEqual(c.requires, REQUIRES[c.name], c.name);
  const commercial = CFG.categories.find((c) => c.name === COMMERCIAL);
  assert.deepEqual([commercial?.route, commercial?.requires], ['human', []], 'commercial is routed to a person and asks no residential question');
  const names = CFG.fields.map((f) => f.name);
  for (const c of CFG.categories) for (const r of c.requires ?? []) assert.ok(names.includes(r), r);
  assert.ok(CFG.fields.every((f) => f.required === false), 'requirements live on the services, not on the fields');
  for (const f of ['Job description', 'Number of rooms']) assert.ok(names.includes(f) && !CFG.categories.some((c) => c.requires?.includes(f)), `${f} is optional: taken if volunteered, never asked`);
});

test('shape: property details, pets and extras are asked of every service (a move-out home is not assumed empty or pet-free); nothing about price or a special', () => {
  for (const c of RES()) for (const p of PROPERTY) assert.ok(c.requires?.includes(p), `${c.name} asks ${p}`);
  for (const c of RES()) assert.ok(c.requires?.includes('Pets'), `${c.name} asks about pets`);
  const move = CFG.categories.find((c) => c.name === MOVE)?.requires ?? [];
  assert.ok(move.includes('Home empty'), 'whether the home is empty is a question, not an assumption');
  for (const c of RES()) assert.ok(c.requires?.includes('Extras'), `${c.name} asks about extras`);
  const text = JSON.stringify(CFG).toLowerCase();
  for (const word of ['price', 'quote', 'special', 'discount', 'cost', '\$']) assert.ok(!text.includes(word), `the skill must not mention "${word}"`);
});

test('shape: the date and the time window stay separate fields, no field name asks for two things, and keywords are multi-word and unique across services', () => {
  const names = CFG.fields.map((f) => f.name);
  assert.ok(names.includes('Preferred date') && names.includes('Time window'));
  assert.ok(!names.some((n) => / and /i.test(n)), 'one question per field');
  assert.ok(names.every((n) => !/\b(?:name|phone|mobile|cell|e-?mail|callback|contact)\b/i.test(n)), 'no field name is one the record redacts as personal');
  const all = CFG.categories.flatMap((c) => c.keywords.map((k) => k.toLowerCase()));
  assert.equal(new Set(all).size, all.length, 'no keyword is shared between services');
  assert.ok(!all.includes('clean') && !all.includes('cleaning') && !all.includes('cleaned'), 'no single generic word that every service would match');
});

test('classification: each service is recognised from the ways a caller asks for it', () => {
  const cases: Array<[string, string]> = [
    ['I would like a regular cleaning for the house', STANDARD], ['we need weekly cleaning', STANDARD], ['do you offer a maid service', STANDARD],
    ['I need a deep clean before guests arrive', DEEP], ['a spring cleaning please', DEEP], ['I want it deep cleaned', DEEP],
    ['I am moving out and need a move out clean', MOVE], ['we are moving in next week', MOVE], ['end of lease clean please', MOVE],
  ];
  for (const [said, want] of cases) assert.equal(ok(runIntake(withText(`Caller: ${said}.`))).workItem.category, want, said);
});

test('classification: a request that names no service, or two services, is not guessed: it is unknown and goes to a person (the phone path then asks which service)', () => {
  for (const said of ['I need a cleaning for four rooms', 'could someone come and clean my house', 'I need a deep clean and also a move out clean']) {
    const r = ok(runIntake(withText(`Caller: ${said}.`)));
    assert.equal(r.workItem.category, 'unknown', said);
    assert.equal(r.workItem.status, 'needs-human');
    assert.equal(r.handoff, null);
  }
});

test('only relevant questions: each service names exactly its own missing details, in order, never another service\'s', () => {
  const said: Record<string, string> = { [STANDARD]: 'I would like a regular cleaning.', [DEEP]: 'I need a deep clean.', [MOVE]: 'I need a move out clean.' };
  for (const [svc, req] of Object.entries(REQUIRES)) {
    const r = ok(runIntake(withText(`Caller: ${said[svc]}`)));
    assert.equal(r.workItem.category, svc);
    assert.deepEqual(r.workItem.missing_fields, req, `${svc}: its own questions, in the order to ask them`);
    for (const [field, owner] of Object.entries(ONLY_FOR)) if (owner !== svc) assert.ok(!r.workItem.missing_fields.includes(field), `${svc} must not ask for ${field}`);
  }
});

test('answers already given are kept: a detail the caller volunteers is not asked again, whichever service', () => {
  const r = ok(runIntake(withText('Caller: I need a deep clean.\nProperty type: a house\nNumber of bedrooms: three bedrooms\nPets: one dog\nExtras: no extras')));
  assert.equal(r.workItem.category, DEEP);
  assert.deepEqual(r.workItem.missing_fields, ['Number of bathrooms', 'Last professional clean', 'Priority areas', FIRST, 'Preferred date', 'Time window'], 'only what is still missing');
  const got = r.workItem.fields.filter((f) => f.found).map((f) => f.name);
  for (const n of ['Property type', 'Number of bedrooms', 'Pets', 'Extras']) assert.ok(got.includes(n), n);
});

// ---------------------------------------------------------------- the model path: verbatim values, ready only when the service's own questions are answered
const modelRun = (text: string, category: string | null, fields: Array<{ name: string; value: string | null; confidence: number }>) =>
  runIntakeWithModel(withText(text), { provider: createMockProvider({ classify_request: () => classifyAnswer(category, 0.9), extract_fields: () => extractAnswer(fields) }) });
const f = (name: string, value: string | null) => ({ name, value, confidence: 0.9 });
const PROP_TEXT = 'Caller: A house, three bedrooms, two bathrooms.\n';
const PROP_FIELDS = [f('Property type', 'A house'), f('Number of bedrooms', 'three bedrooms'), f('Number of bathrooms', 'two bathrooms')];
const WHEN_TEXT = 'Caller: No extras. My first cleaning with you. Tomorrow, between 9 AM and 1 PM.\n';
const WHEN_FIELDS = [f('Extras', 'No extras'), f('First cleaning with us', 'My first cleaning with you'), f('Preferred date', 'Tomorrow'), f('Time window', 'between 9 AM and 1 PM')];

test('model path: each service is ready when its own details are answered, with no other service\'s detail needed', async () => {
  const cases: Array<[string, string, Array<{ name: string; value: string | null; confidence: number }>]> = [
    [STANDARD, 'Caller: A regular cleaning, every two weeks, we have one dog.\n' + PROP_TEXT + WHEN_TEXT, [...PROP_FIELDS, f('Pets', 'one dog'), f('Cleaning frequency', 'every two weeks'), ...WHEN_FIELDS]],
    [DEEP, 'Caller: A deep clean, one cat, the last one was a year ago, the kitchen matters most.\n' + PROP_TEXT + WHEN_TEXT, [...PROP_FIELDS, f('Pets', 'one cat'), f('Last professional clean', 'a year ago'), f('Priority areas', 'the kitchen'), ...WHEN_FIELDS]],
    [MOVE, 'Caller: A move out clean, the home is empty, no pets.\n' + PROP_TEXT + WHEN_TEXT, [...PROP_FIELDS, f('Pets', 'no pets'), f('Home empty', 'empty'), ...WHEN_FIELDS]],
  ];
  for (const [svc, said, fields] of cases) {
    const r = ok(await modelRun(said, svc, fields));
    assert.deepEqual([r.workItem.category, r.workItem.status, r.workItem.missing_fields, r.workItem.reasons], [svc, 'ready', [], []], svc);
    assert.ok(r.handoff !== null);
    assert.deepEqual(validateWorkItem(r.workItem), []);
    assert.deepEqual(validateEnvelope(r.handoff), []);
  }
});

test('model path: a detail that belongs to another service does not make the item ready, and only the service\'s own missing question is named', async () => {
  const said = 'Caller: A deep clean, one dog, and weekly after that.\n' + PROP_TEXT + WHEN_TEXT;
  const r = ok(await modelRun(said, DEEP, [...PROP_FIELDS, f('Pets', 'one dog'), ...WHEN_FIELDS, f('Cleaning frequency', 'weekly')]));
  assert.equal(r.workItem.status, 'needs-human');
  assert.deepEqual(r.workItem.missing_fields, ['Last professional clean', 'Priority areas']);
  assert.equal(r.handoff, null);
});

test('model path: a value that is not verbatim still fails the whole extraction, as before', async () => {
  const r = ok(await modelRun('Caller: A deep clean.\n' + PROP_TEXT + WHEN_TEXT, DEEP, [f('Property type', 'A house'), f('Number of bedrooms', '3 bedrooms'), f('Number of bathrooms', 'two bathrooms')]));
  assert.equal(r.workItem.status, 'needs-human');
  assert.ok(r.workItem.reasons.includes('model_failed'));
  assert.equal(r.handoff, null);
});

test('no price is asked, stored or applied: the assistant is told never to suggest options, extras, specials or prices, and the skill has no price field', () => {
  assert.match(DIALOGUE_INSTRUCTION, /never suggest options, examples, extras, services, specials or prices of your own/);
  assert.match(DIALOGUE_INSTRUCTION, /Do not give prices/);
  assert.ok(!CFG.fields.some((x) => /price|quote|cost|special|discount|\$/i.test(x.name)));
});

test('the sample input is a complete synthetic record the existing contract accepts, and it is a valid founder skill_config (a new digest, not the live one)', () => {
  const e = example();
  const run = ok(runIntake({ ...e, masked_text: 'Job description: deep clean\nProperty type: a house\nNumber of bedrooms: three bedrooms\nNumber of bathrooms: two bathrooms\nPets: one dog\nLast professional clean: a year ago\nPriority areas: the kitchen\nExtras: no extras\nFirst cleaning with us: my first cleaning\nPreferred date: tomorrow\nTime window: 9 to 1' }));
  assert.deepEqual([run.workItem.category, run.workItem.status], [DEEP, 'ready']);
  const live = JSON.parse(readFileSync(new URL('../examples/skill-cleaning.json', import.meta.url), 'utf8'));
  const base = JSON.parse(readFileSync(new URL('../examples/founder-call.config.example.json', import.meta.url), 'utf8'));
  const withNew = { ...base, skill_config: e.skill_config };
  assert.deepEqual(founderConfigProblems(withNew), []);
  assert.notEqual(founderConfigDigest(withNew), founderConfigDigest({ ...base, skill_config: live.skill_config }), 'applying it is a new approval');
});

// ---------------------------------------------------------------- business-configured choices
test('choices: a field may carry the business\'s own choices; only the property type and the first-cleaning question do here; nothing is invented for services, extras or prices', () => {
  const withChoices = CFG.fields.filter((x) => x.choices !== undefined);
  assert.deepEqual(withChoices.map((x) => x.name), ['Property type', FIRST]);
  assert.deepEqual(withChoices[0].choices, ['house', 'apartment', 'condo', 'townhouse']);
  assert.deepEqual(withChoices[1].choices, ['yes', 'no']);
  assert.ok(!CFG.fields.find((x) => x.name === 'Extras')?.choices, 'the business has not said what extras it offers, so none are offered');
  assert.ok(!CFG.fields.find((x) => x.name === 'Pets')?.choices);
  assert.ok(withChoices[0].choices?.every((c) => !/[$%\d]/.test(c)), 'a choice is a plain answer, not a price');
});

test('choices: validation accepts 1 to 10 distinct short single-line choices and refuses anything else, including unknown field keys', () => {
  const field = (extra: Record<string, unknown>) => ({ ...CFG, fields: [{ name: 'Property type', required: false, extractor: { kind: 'label', labels: ['property type'] }, ...extra }] }) as unknown as SkillConfig;
  const fine = { ...CFG, categories: CFG.categories.map((c) => ({ ...c, requires: [] })) };
  const check = (extra: Record<string, unknown>) => validateSkillConfig({ ...fine, fields: field(extra).fields });
  assert.deepEqual(check({ choices: ['house', 'apartment'] }), []);
  assert.deepEqual(check({}), [], 'choices are optional');
  const bad: Array<[string, unknown]> = [['empty list', []], ['not a list', 'house'], ['too many', Array.from({ length: 11 }, (_, i) => `type ${i}`)], ['duplicate', ['house', 'House']], ['number', [7]], ['empty string', ['']],
    ['too long', ['x'.repeat(65)]], ['two lines', ['house\napartment']]];
  for (const [name, v] of bad) assert.ok(check({ choices: v }).length > 0, name);
  assert.ok(check({ choices: ['house'], other: 1 }).length > 0, 'an unknown key on a field is still refused');
});

// ---------------------------------------------------------------- commercial requests: a human-review route, never a residential service
const SERVICE_WORDING: Array<[string, string]> = [['standard', 'a regular cleaning'], ['deep', 'a deep clean'], ['move-out', 'a move out clean']];
const PLACES = ['our office', 'our restaurant', 'my shop'];

test('commercial (local): office, restaurant and shop requests with standard, deep and move-out wording all go to a person as commercial, never to a residential service, never handed off', () => {
  let n = 0;
  for (const place of PLACES) for (const [, wording] of SERVICE_WORDING) {
    const r = ok(runIntake(withText(`Caller: I need ${wording} for ${place}.`)));
    assert.equal(r.workItem.category, COMMERCIAL, `${wording} for ${place}`);
    assert.deepEqual([r.workItem.status, r.workItem.reasons, r.workItem.missing_fields], ['needs-human', ['human_review'], []], `${wording} for ${place}`);
    assert.equal(r.handoff, null);
    assert.deepEqual(validateWorkItem(r.workItem), [], 'the work item with the new reason is valid');
    n++;
  }
  assert.equal(n, 9);
});

test('commercial (local): the commercial wording wins wherever it appears in the conversation, even after residential details were given', () => {
  const r = ok(runIntake(withText('Caller: A regular cleaning, three bedrooms.\nCaller: Actually it is for my shop.')));
  assert.equal(r.workItem.category, COMMERCIAL);
  assert.equal(r.handoff, null);
  assert.deepEqual(r.workItem.reasons, ['human_review']);
});

test('commercial (model): a model that calls it residential, calls it commercial, or has no opinion cannot move it into an automated service; it is never ready', async () => {
  const text = (place: string) => `Caller: A regular cleaning for ${place}, two bedrooms, one bathroom, no pets, every two weeks, no extras, tomorrow between 9 AM and 1 PM.\n`;
  const fields = [f('Property type', null), f('Number of bedrooms', 'two bedrooms'), f('Number of bathrooms', 'one bathroom'), f('Pets', 'no pets'), f('Cleaning frequency', 'every two weeks'), f('Extras', 'no extras'), f('Preferred date', 'tomorrow'), f('Time window', 'between 9 AM and 1 PM')];
  for (const place of PLACES) for (const said of [STANDARD, DEEP, MOVE, COMMERCIAL, null]) {
    const r = ok(await modelRun(text(place), said, fields));
    assert.equal(r.workItem.category, COMMERCIAL, `${place} / model said ${said}`);
    assert.equal(r.workItem.status, 'needs-human');
    assert.ok(r.workItem.reasons.includes('human_review') && !r.workItem.reasons.includes('ambiguous_category'), `${place} / model said ${said}`);
    assert.equal(r.handoff, null, 'a commercial request is never handed off, however complete its answers');
  }
});

test('commercial (model): a commercial request the keywords do not catch is still routed to a person when the model says commercial', async () => {
  const r = ok(await modelRun('Caller: I need our dental practice cleaned every Friday.\n', COMMERCIAL, []));
  assert.deepEqual([r.workItem.category, r.workItem.status, r.workItem.reasons], [COMMERCIAL, 'needs-human', ['human_review']]);
  assert.equal(r.handoff, null);
});

test('commercial: residential regression, ordinary residential wording, including words that merely resemble the commercial keywords, is unaffected', () => {
  const cases: Array<[string, string]> = [
    ['I would like a regular cleaning for the house', STANDARD], ['we need weekly cleaning', STANDARD], ['do you offer a maid service', STANDARD],
    ['I need a deep clean before guests arrive', DEEP], ['a spring cleaning please', DEEP], ['I want it deep cleaned', DEEP],
    ['I am moving out and need a move out clean', MOVE], ['we are moving in next week', MOVE], ['end of lease clean please', MOVE],
    ['a regular cleaning for my house near the shopping centre', STANDARD], ['a deep clean, we keep boxes in storage', DEEP], ['a regular cleaning, the officer next door recommended you', STANDARD],
    ['a regular cleaning, my son does gymnastics', STANDARD], ['a move out clean, the schoolhouse road is closed', MOVE],
  ];
  for (const [said, want] of cases) {
    const r = ok(runIntake(withText(`Caller: ${said}.`)));
    assert.equal(r.workItem.category, want, said);
    assert.ok(!r.workItem.reasons.includes('human_review'), said);
  }
});

test('commercial: the route is business-configured: a category is routed only when its config says route human, and anything else is refused', () => {
  assert.deepEqual(validateSkillConfig(CFG), []);
  const without = { ...CFG, categories: CFG.categories.map((c) => { const { route, ...rest } = c; return rest; }) } as SkillConfig;
  assert.deepEqual(validateSkillConfig(without), [], 'route is optional');
  for (const bad of ['robot', true, 1, '', 'Human']) {
    const cfg = { ...CFG, categories: CFG.categories.map((c) => (c.name === COMMERCIAL ? { ...c, route: bad } : c)) } as unknown as SkillConfig;
    assert.ok(validateSkillConfig(cfg).length > 0, String(bad));
  }
  // With the route removed the same words fall back to the residential classification: the route, not the wording, is what protects them.
  const r = ok(runIntake({ ...example(), skill_config: without, masked_text: 'Caller: I need a regular cleaning for our office.' }));
  assert.equal(r.workItem.category, 'unknown', 'two categories match the words: held as ambiguous, not routed');
  const other = ok(runIntake({ ...example(), skill_config: { ...CFG, categories: CFG.categories.map((c) => (c.name === COMMERCIAL ? { ...c, keywords: ['dental practice'] } : c)) }, masked_text: 'Caller: I need a regular cleaning for our office.' }));
  assert.equal(other.workItem.category, STANDARD, 'the business\'s own keyword list decides what is commercial');
});

// ---------------------------------------------------------------- the first-cleaning question
test('first cleaning: every residential service asks it once, by a business-named field, and commercial requests do not', () => {
  for (const c of RES()) assert.ok(c.requires?.includes(FIRST), `${c.name} asks ${FIRST}`);
  assert.ok(!CFG.categories.find((c) => c.name === COMMERCIAL)?.requires?.includes(FIRST));
  assert.ok(CFG.fields.some((x) => x.name === FIRST), 'the field is configuration: a business renames it here and in the pricing fixture');
  assert.ok(!/\b(?:name|phone|mobile|cell|e-?mail|callback|contact)\b/i.test(FIRST), 'not a field the record redacts');
  const fixture = JSON.parse(readFileSync(new URL('../examples/pricing-fixture-drew-cleaning.json', import.meta.url), 'utf8'));
  assert.equal(fixture.first_clean_field, FIRST, 'the pricing fixture reads the answer from this same field');
});

test('first cleaning: an answer already given is kept, and only a missing one is asked', () => {
  const given = ok(runIntake(withText('Caller: I would like a regular cleaning.\nFirst cleaning with us: my first cleaning')));
  assert.ok(!given.workItem.missing_fields.includes(FIRST), 'not asked again');
  assert.equal(given.workItem.fields.find((x) => x.name === FIRST)?.value, 'my first cleaning');
  const none = ok(runIntake(withText('Caller: I would like a regular cleaning.')));
  assert.ok(none.workItem.missing_fields.includes(FIRST));
  assert.ok(none.workItem.missing_fields.indexOf(FIRST) > none.workItem.missing_fields.indexOf('Extras') && none.workItem.missing_fields.indexOf(FIRST) < none.workItem.missing_fields.indexOf('Preferred date'), 'asked after the service questions and before the date');
});

test('first cleaning: a hedged or unclear answer is kept as said but is not a yes, and a missing answer keeps the item not ready', async () => {
  const text = (said: string) => `Caller: A regular cleaning, every two weeks, a house, two bedrooms, one bathroom, no pets, no extras. ${said} Tomorrow, between 9 AM and 1 PM.\n`;
  const base = [f('Property type', 'a house'), f('Number of bedrooms', 'two bedrooms'), f('Number of bathrooms', 'one bathroom'), f('Pets', 'no pets'), f('Cleaning frequency', 'every two weeks'), f('Extras', 'no extras'), f('Preferred date', 'Tomorrow'), f('Time window', 'between 9 AM and 1 PM')];
  const unclear = ok(await modelRun(text('I am not sure if it is my first.'), STANDARD, [...base, f(FIRST, 'I am not sure if it is my first')]));
  assert.equal(unclear.workItem.status, 'ready', 'the answer was given, so the intake is complete; whether it earns anything is the pricing fixture\'s strict reading');
  assert.equal(unclear.workItem.fields.find((x) => x.name === FIRST)?.value, 'I am not sure if it is my first');
  const missing = ok(await modelRun(text(''), STANDARD, base));
  assert.deepEqual([missing.workItem.status, missing.workItem.missing_fields], ['needs-human', [FIRST]]);
  assert.equal(missing.handoff, null);
});

test('first cleaning: the field carries the role first_clean (at most one field may), and any other role is refused', () => {
  assert.deepEqual(CFG.fields.filter((x) => x.role === 'first_clean').map((x) => x.name), ['First cleaning with us']);
  const withRole = (role: unknown, onField = 'Pets') => ({ ...CFG, fields: CFG.fields.map((x) => (x.name === onField ? { ...x, role } : x)) }) as unknown as SkillConfig;
  assert.ok(validateSkillConfig(withRole('first_clean')).some((e) => /only one field/.test(e)), 'a second field with the role is refused');
  for (const bad of ['yes_no', true, 1, '']) assert.ok(validateSkillConfig(withRole(bad)).length > 0, String(bad));
  const none = { ...CFG, fields: CFG.fields.map((x) => { const { role, ...rest } = x; return rest; }) } as SkillConfig;
  assert.deepEqual(validateSkillConfig(none), [], 'the role is optional');
});
