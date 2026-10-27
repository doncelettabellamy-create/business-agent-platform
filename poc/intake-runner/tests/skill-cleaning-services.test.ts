// The services cleaning skill (examples/skill-cleaning-services.json): standard, deep and move-in/move-out, each with its own required questions, so the
// assistant asks only what is relevant to the service. Synthetic data and a scripted mock provider only; the live example (skill-cleaning.json) is untouched.
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

const example = () => JSON.parse(readFileSync(new URL('../examples/skill-cleaning-services.json', import.meta.url), 'utf8'));
const CFG: SkillConfig = example().skill_config;
const withText = (masked_text: string) => ({ ...example(), masked_text });
const ok = (r: RunResult) => { assert.equal(r.ok, true, JSON.stringify(r)); if (!r.ok) throw new Error('unreachable'); return r; };

const STANDARD = 'Standard cleaning'; const DEEP = 'Deep cleaning'; const MOVE = 'Move-in or move-out cleaning';
const REQUIRES: Record<string, string[]> = {
  [STANDARD]: ['Number of rooms', 'Cleaning frequency', 'Preferred date', 'Time window'],
  [DEEP]: ['Number of rooms', 'Last professional clean', 'Preferred date', 'Time window'],
  [MOVE]: ['Number of rooms', 'Home empty', 'Preferred date', 'Time window'],
};
const ONLY_FOR: Record<string, string> = { 'Cleaning frequency': STANDARD, 'Last professional clean': DEEP, 'Home empty': MOVE };

test('shape: a valid skill with the three services, each requiring its own questions, and every requirement names a real field', () => {
  assert.deepEqual(validateSkillConfig(CFG), []);
  assert.deepEqual(CFG.categories.map((c) => c.name), [STANDARD, DEEP, MOVE]);
  for (const c of CFG.categories) assert.deepEqual(c.requires, REQUIRES[c.name], c.name);
  const names = CFG.fields.map((f) => f.name);
  for (const c of CFG.categories) for (const r of c.requires ?? []) assert.ok(names.includes(r), r);
  assert.ok(CFG.fields.every((f) => f.required === false), 'requirements live on the services, not on the fields');
  for (const f of ['Pets', 'Add-ons', 'Job description']) assert.ok(names.includes(f) && !CFG.categories.some((c) => c.requires?.includes(f)), `${f} is optional: taken if volunteered, never asked`);
});

test('shape: the date and the time window stay separate fields, no field name asks for two things, and keywords are multi-word and unique across services', () => {
  const names = CFG.fields.map((f) => f.name);
  assert.ok(names.includes('Preferred date') && names.includes('Time window'));
  assert.ok(!names.some((n) => / and /i.test(n)));
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
  for (const [said, want] of cases) {
    const r = ok(runIntake(withText(`Caller: ${said}.`)));
    assert.equal(r.workItem.category, want, said);
  }
});

test('classification: a request that names no service, or two services, is not guessed: it is unknown and goes to a person (the phone path then asks which service)', () => {
  for (const said of ['I need a cleaning for four rooms', 'could someone come and clean my house', 'I need a deep clean and also a move out clean']) {
    const r = ok(runIntake(withText(`Caller: ${said}.`)));
    assert.equal(r.workItem.category, 'unknown', said);
    assert.equal(r.workItem.status, 'needs-human');
    assert.equal(r.handoff, null);
  }
});

test('only relevant questions: each service names exactly its own missing details, never another service\'s', () => {
  const said: Record<string, string> = { [STANDARD]: 'I would like a regular cleaning.', [DEEP]: 'I need a deep clean.', [MOVE]: 'I need a move out clean.' };
  for (const [svc, req] of Object.entries(REQUIRES)) {
    const r = ok(runIntake(withText(`Caller: ${said[svc]}`)));
    assert.equal(r.workItem.category, svc);
    assert.deepEqual(r.workItem.missing_fields, req, `${svc}: its own four, in the order to ask them`);
    for (const [field, owner] of Object.entries(ONLY_FOR)) if (owner !== svc) assert.ok(!r.workItem.missing_fields.includes(field), `${svc} must not ask for ${field}`);
  }
});

// ---------------------------------------------------------------- the model path: verbatim values, ready only when the service's own questions are answered
const modelRun = (text: string, category: string | null, fields: Array<{ name: string; value: string | null; confidence: number }>) =>
  runIntakeWithModel(withText(text), { provider: createMockProvider({ classify_request: () => classifyAnswer(category, 0.9), extract_fields: () => extractAnswer(fields) }) });
const f = (name: string, value: string | null) => ({ name, value, confidence: 0.9 });

test('model path: each service is ready when its own details are answered, with no other service\'s detail needed', async () => {
  const text = 'Caller: Four rooms, tomorrow between 9 AM and 1 PM. ';
  const cases: Array<[string, string, Array<{ name: string; value: string | null; confidence: number }>]> = [
    [STANDARD, 'Caller: A regular cleaning, every two weeks.\n' + text, [f('Number of rooms', 'Four rooms'), f('Cleaning frequency', 'every two weeks'), f('Preferred date', 'tomorrow'), f('Time window', 'between 9 AM and 1 PM')]],
    [DEEP, 'Caller: A deep clean, the last one was a year ago.\n' + text, [f('Number of rooms', 'Four rooms'), f('Last professional clean', 'a year ago'), f('Preferred date', 'tomorrow'), f('Time window', 'between 9 AM and 1 PM')]],
    [MOVE, 'Caller: A move out clean, the home is empty.\n' + text, [f('Number of rooms', 'Four rooms'), f('Home empty', 'empty'), f('Preferred date', 'tomorrow'), f('Time window', 'between 9 AM and 1 PM')]],
  ];
  for (const [svc, said, fields] of cases) {
    const r = ok(await modelRun(said, svc, fields));
    assert.deepEqual([r.workItem.category, r.workItem.status, r.workItem.missing_fields, r.workItem.reasons], [svc, 'ready', [], []], svc);
    assert.ok(r.handoff !== null);
    assert.deepEqual(validateWorkItem(r.workItem), []);
    assert.deepEqual(validateEnvelope(r.handoff), []);
  }
});

test('model path: a detail that belongs to another service is ignored when asking and does not make the item ready', async () => {
  const said = 'Caller: A deep clean, four rooms, tomorrow between 9 AM and 1 PM.\n';
  const r = ok(await modelRun(said, DEEP, [f('Number of rooms', 'four rooms'), f('Preferred date', 'tomorrow'), f('Time window', 'between 9 AM and 1 PM')]));
  assert.deepEqual([r.workItem.status, r.workItem.missing_fields], ['needs-human', ['Last professional clean']], 'only the deep clean\'s own missing question is named');
  assert.equal(r.handoff, null);
});

test('model path: a value that is not verbatim still fails the whole extraction, as before', async () => {
  const r = ok(await modelRun('Caller: A deep clean, four rooms, last done a year ago, tomorrow between 9 AM and 1 PM.', DEEP,
    [f('Number of rooms', '4 rooms'), f('Last professional clean', 'a year ago'), f('Preferred date', 'tomorrow'), f('Time window', 'between 9 AM and 1 PM')]));
  assert.equal(r.workItem.status, 'needs-human');
  assert.ok(r.workItem.reasons.includes('model_failed'));
  assert.equal(r.handoff, null);
});

test('the sample input is a complete synthetic record the existing contract accepts, and it is a valid founder skill_config (a new digest, not the live one)', () => {
  const e = example();
  const run = ok(runIntake({ ...e, masked_text: 'Job description: deep clean\nNumber of rooms: four rooms\nLast professional clean: a year ago\nPreferred date: tomorrow\nTime window: 9 to 1' }));
  assert.deepEqual([run.workItem.category, run.workItem.status], [DEEP, 'ready']);
  const live = JSON.parse(readFileSync(new URL('../examples/skill-cleaning.json', import.meta.url), 'utf8'));
  const base = JSON.parse(readFileSync(new URL('../examples/founder-call.config.example.json', import.meta.url), 'utf8'));
  const withNew = { ...base, skill_config: e.skill_config };
  assert.deepEqual(founderConfigProblems(withNew), []);
  assert.notEqual(founderConfigDigest(withNew), founderConfigDigest({ ...base, skill_config: live.skill_config }), 'applying it is a new approval');
});
