// Tests for the local deterministic classify-extract skill and its wiring into the Intake runner.
// Synthetic data only. No network, database, or model. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runIntake } from '../src/intake-runner.ts';
import type { RunResult } from '../src/intake-runner.ts';
import { classifyAndExtract, classifyRequest, validateSkillConfig } from '../src/classify-extract.ts';
import { validateEnvelope, validateWorkItem } from '../src/contracts.ts';
import { requiresConfig, requiresInput, skillConfig, skillInput } from './skill-fixtures.ts';

function ok(r: RunResult) {
  assert.equal(r.ok, true, 'expected ok result');
  if (!r.ok) throw new Error('unreachable');
  return r;
}
function err(r: RunResult, code: string) {
  assert.equal(r.ok, false, 'expected error result');
  if (r.ok) throw new Error('unreachable');
  assert.equal(r.error.code, code);
  return r.error;
}
function field(r: ReturnType<typeof ok>, name: string) {
  const f = r.workItem.fields.find((x) => x.name === name);
  assert.ok(f, `field ${name} present`);
  return f;
}

// ---------------------------------------------------------------- classification
test('classification: configured keywords select the category, case-insensitively and as whole phrases', () => {
  const cats = skillConfig().categories;
  assert.deepEqual(classifyRequest('Please FOLLOW   UP soon', cats), { outcome: 'matched', category: 'Category A' });
  assert.deepEqual(classifyRequest('Need a Quote for Option B', cats), { outcome: 'matched', category: 'Category B' });
  // whole words only: "alphabet" is not "alpha", "quoted" is not "quote"
  assert.deepEqual(classifyRequest('alphabet soup, quoted text', cats), { outcome: 'none', category: null });
});

test('classification: the category with more distinct keyword hits wins; repeated hits of one keyword count once', () => {
  const cats = skillConfig().categories;
  assert.deepEqual(classifyRequest('alpha bravo quote', cats), { outcome: 'matched', category: 'Category B' });
  assert.deepEqual(classifyRequest('alpha alpha alpha bravo quote', cats), { outcome: 'matched', category: 'Category B' });
});

test('classification: the runner turns a clear match into a ready work item and a valid handoff envelope', () => {
  const r = ok(runIntake(skillInput()));
  assert.equal(r.outcome, 'handed-off');
  assert.equal(r.workItem.category, 'Category A');
  assert.equal(r.workItem.status, 'ready');
  assert.deepEqual(r.workItem.reasons, []);
  assert.deepEqual(validateWorkItem(r.workItem), []);
  assert.ok(r.handoff);
  assert.deepEqual(validateEnvelope(r.handoff), []);
  assert.equal(r.handoff.payload.category, 'Category A');
  assert.equal(r.handoff.confidence, null, 'the local skill does not score confidence');
});

// ---------------------------------------------------------------- extraction
test('extraction: label and token extractors fill the configured fields', () => {
  const r = ok(runIntake(skillInput()));
  assert.equal(field(r, 'Field 1').value, 'Change of details');   // label "Topic", value ends at the line break
  assert.equal(field(r, 'Field 2').value, '[ID_1]');                // token extractor, trailing period not included
  const f3 = field(r, 'Field 3');                                   // optional, absent
  assert.equal(f3.found, false);
  assert.equal(f3.value, null);
  assert.deepEqual(r.workItem.missing_fields, [], 'an absent optional field is not "missing"');
});

test('extraction: labels are case-insensitive, accept : or =, alternative labels, and stop at ";"', () => {
  const cfg = skillConfig();
  const out = classifyAndExtract('SUBJECT = Something here; ignored part\nnote: remember this', cfg);
  assert.equal(out.fields.find((f) => f.name === 'Field 1')?.value, 'Something here');
  assert.equal(out.fields.find((f) => f.name === 'Field 3')?.value, 'remember this');
});

test('extraction: a label must be a whole word and an empty value does not count', () => {
  const cfg = skillConfig();
  const out = classifyAndExtract('Subtopic: not it\nTopic:   \nSubject: ', cfg);
  assert.equal(out.fields.find((f) => f.name === 'Field 1')?.value, null);
  assert.deepEqual(out.ambiguousFields, []);
});

test('extraction: the same value repeated is accepted; different values are ambiguous and not extracted', () => {
  const cfg = skillConfig();
  const same = classifyAndExtract('Topic: Same thing\nTopic: same thing', cfg);
  assert.equal(same.fields[0].value, 'Same thing');
  assert.deepEqual(same.ambiguousFields, []);

  const diff = classifyAndExtract('Topic: First\nSubject: Second\n[ID_1] and [ID_2]', cfg);
  assert.equal(diff.fields[0].value, null);
  assert.equal(diff.fields[1].value, null);
  assert.deepEqual(diff.ambiguousFields, ['Field 1', 'Field 2']);
});

test('extraction: missing required fields are reported and flagged for review', () => {
  const x = skillInput();
  x.masked_text = 'Please follow up on my earlier request.';
  const r = ok(runIntake(x));
  assert.equal(r.outcome, 'needs-human');
  assert.deepEqual(r.workItem.missing_fields, ['Field 1', 'Field 2']);
  assert.deepEqual(r.workItem.reasons, ['missing_fields']);
  assert.equal(r.handoff, null);
  assert.deepEqual(validateWorkItem(r.workItem), []);
});

test('extraction: values longer than the limit are treated as not found', () => {
  const cfg = skillConfig();
  const out = classifyAndExtract(`Topic: ${'x'.repeat(201)}`, cfg);
  assert.equal(out.fields[0].value, null);
});

// ---------------------------------------------------------------- ambiguity
test('ambiguity: a tie between categories is not guessed; it becomes unknown with ambiguous_category', () => {
  const x = skillInput();
  x.masked_text = 'alpha and bravo\nTopic: Something\n[ID_1]';
  const r = ok(runIntake(x));
  assert.equal(r.workItem.category, 'unknown');
  assert.deepEqual(r.workItem.reasons, ['ambiguous_category']);
  assert.equal(r.outcome, 'needs-human');
  assert.equal(r.handoff, null);
  assert.deepEqual(validateWorkItem(r.workItem), []);
});

test('ambiguity: conflicting values for a field flag ambiguous_field even when the field is optional', () => {
  const x = skillInput();
  x.masked_text = 'follow up\nTopic: Something\n[ID_1]\nNote: one\nNote: two';
  const r = ok(runIntake(x));
  assert.equal(r.outcome, 'needs-human');
  assert.deepEqual(r.workItem.reasons, ['ambiguous_field']);
  assert.equal(field(r, 'Field 3').found, false);
  assert.deepEqual(r.workItem.missing_fields, [], 'optional field: not missing, but flagged');
});

test('ambiguity: reasons combine in a fixed order', () => {
  const x = skillInput();
  x.masked_text = 'alpha bravo\nTopic: A\nSubject: B';
  const r = ok(runIntake(x));
  assert.deepEqual(r.workItem.reasons, ['missing_fields', 'ambiguous_category', 'ambiguous_field']);
  assert.deepEqual(r.workItem.missing_fields, ['Field 1', 'Field 2']);
});

// ---------------------------------------------------------------- unknown categories
test('unknown category: no configured keyword matches -> unknown_category, not guessed', () => {
  const x = skillInput();
  x.masked_text = 'Something entirely different.\nTopic: Whatever\n[ID_1]';
  const r = ok(runIntake(x));
  assert.equal(r.workItem.category, 'unknown');
  assert.deepEqual(r.workItem.reasons, ['unknown_category']);
  assert.equal(r.handoff, null);
});

test('unknown category: "unknown" is reserved and cannot be configured', () => {
  const cfg = skillConfig();
  cfg.categories[0].name = 'unknown';
  assert.ok(validateSkillConfig(cfg).some((e) => e.includes('reserved')));
  const x = skillInput();
  x.skill_config = cfg;
  err(runIntake(x), 'INPUT_INVALID');
});

test('unknown category: a different configuration changes the result (no built-in vocabulary)', () => {
  const x = skillInput();
  x.skill_config = { categories: [{ name: 'Category Z', keywords: ['zulu'] }], fields: [] };
  const r = ok(runIntake(x));
  assert.equal(r.workItem.category, 'unknown');           // "follow up" means nothing without configuration
  x.masked_text = 'zulu';
  assert.equal(ok(runIntake(x)).workItem.category, 'Category Z');
});

// ---------------------------------------------------------------- safe fallback
test('safe fallback: invalid configuration is refused with fixed paths and no echo of configured values', () => {
  const x = skillInput();
  const cfg = skillConfig() as unknown as Record<string, unknown>;
  (cfg.categories as Array<Record<string, unknown>>)[0].keywords = ['CANARY-VALUE-4417', 123, ''];
  (cfg.fields as Array<Record<string, unknown>>)[1].extractor = { kind: 'token', token_type: 'bad-type' };
  (cfg as Record<string, unknown>).surprise = 'CANARY-KEY-8820';
  x.skill_config = cfg as unknown as typeof x.skill_config;
  const e = err(runIntake(x), 'INPUT_INVALID');
  assert.ok((e.paths ?? []).length >= 3);
  assert.ok(!JSON.stringify(e).includes('CANARY-VALUE-4417'));
  assert.ok(!JSON.stringify(e).includes('CANARY-KEY-8820'));
  assert.ok(!JSON.stringify(e).includes('bad-type'));
});

test('per-category requires: exact field names only; unknown, case-different, duplicate, and malformed entries are refused without echo', () => {
  const bad = (requires: unknown) => {
    const cfg = requiresConfig() as unknown as { categories: Array<Record<string, unknown>> };
    cfg.categories[0].requires = requires;
    return validateSkillConfig(cfg);
  };
  assert.deepEqual(validateSkillConfig(requiresConfig()), []);
  assert.ok(bad(['F9-CANARY-5521']).length === 1, 'unknown field name');
  assert.ok(bad(['f1']).length === 1, 'case-different name');
  assert.ok(bad(['F1', 'F1']).some((e) => e.includes('duplicate')));
  assert.ok(bad('F1').length === 1, 'not an array');
  assert.ok(bad([1]).length === 1, 'not a string');
  assert.ok(!JSON.stringify(bad(['F9-CANARY-5521'])).includes('CANARY'), 'no echo of configured values');
  const x = requiresInput('pword', ['F0']);
  (x.skill_config as unknown as { categories: Array<Record<string, unknown>> }).categories[0].requires = ['Nope'];
  err(runIntake(x), 'INPUT_INVALID');
});

test('per-category requires (local path): a matched category adds its requirement; none or a tie uses the base set only', () => {
  const p = ok(runIntake(requiresInput('pword', ['F0'])));
  assert.deepEqual([p.workItem.category, p.workItem.missing_fields, p.workItem.reasons, p.handoff], ['Cat P', ['F1'], ['missing_fields'], null]);
  const r = ok(runIntake(requiresInput('rword', ['F0'])));
  assert.deepEqual([r.workItem.category, r.workItem.missing_fields, r.outcome], ['Cat R', [], 'handed-off']);
  const tie = ok(runIntake(requiresInput('pword qword', ['F0'])));
  assert.deepEqual([tie.workItem.category, tie.workItem.missing_fields, tie.workItem.reasons], ['unknown', [], ['ambiguous_category']]);
  const none = ok(runIntake(requiresInput('nothing here', ['F0'])));
  assert.deepEqual([none.workItem.category, none.workItem.missing_fields, none.workItem.reasons], ['unknown', [], ['unknown_category']]);
});

test('per-category requires (edge): an empty list is accepted and adds nothing', () => {
  const cfg = requiresConfig();
  cfg.categories[0].requires = [];
  assert.deepEqual(validateSkillConfig(cfg), []);
  const r = ok(runIntake(requiresInput('pword', ['F0'], cfg)));
  assert.deepEqual([r.workItem.category, r.workItem.missing_fields, r.outcome], ['Cat P', [], 'handed-off']);
});

test('per-category requires (edge): naming a field that is already required: true is accepted and is reported once', () => {
  const cfg = requiresConfig();
  cfg.categories[0].requires = ['F0', 'F1'];
  assert.deepEqual(validateSkillConfig(cfg), []);
  const r = ok(runIntake(requiresInput('pword', [], cfg)));
  assert.deepEqual(r.workItem.missing_fields, ['F0', 'F1']);
  assert.equal(r.workItem.fields.filter((f) => f.name === 'F0').length, 1, 'no duplicate field entry');
  assert.deepEqual(r.workItem.reasons, ['missing_fields']);
});

test('per-category requires (edge): conflicting values for a category-required field are missing and flagged ambiguous', () => {
  const x = requiresInput('pword', ['F0', 'F1']);
  x.masked_text += '\nf1: other';                    // a1 vs other: two different values
  const r = ok(runIntake(x));
  assert.deepEqual(r.workItem.missing_fields, ['F1']);
  assert.deepEqual(r.workItem.reasons, ['missing_fields', 'ambiguous_field']);
  assert.equal(r.handoff, null);
});

test('per-category requires (edge): category names constructor and __proto__ are safe on the local path too', () => {
  const cfg = requiresConfig();
  cfg.categories = [
    { name: 'constructor', keywords: ['cword'], requires: ['F1'] },
    { name: '__proto__', keywords: ['dword'], requires: ['F2'] },
  ];
  assert.deepEqual(ok(runIntake(requiresInput('cword', ['F0'], cfg))).workItem.missing_fields, ['F1']);
  assert.deepEqual(ok(runIntake(requiresInput('dword', ['F0'], cfg))).workItem.missing_fields, ['F2']);
  const none = ok(runIntake(requiresInput('nothing here', ['F0'], cfg)));
  assert.deepEqual([none.workItem.category, none.workItem.reasons], ['unknown', ['unknown_category']]);
});

test('per-category requires (plumbing fixture): a booking change needs only a preferred date and is ready without an address', () => {
  const x = JSON.parse(readFileSync(new URL('../examples/skill-plumbing.json', import.meta.url), 'utf8'));
  x.masked_text = 'Hello, this is [PERSON_1]. Please reschedule my visit.\nPreferred date: Friday afternoon';
  const r = ok(runIntake(x));
  assert.deepEqual([r.workItem.category, r.workItem.missing_fields, r.workItem.reasons, r.outcome], ['Booking change', [], [], 'handed-off']);
  assert.ok(r.handoff && validateEnvelope(r.handoff).length === 0);
});

test('per-category requires (plumbing fixture): an emergency leak without an address is flagged and not handed off', () => {
  const x = JSON.parse(readFileSync(new URL('../examples/skill-plumbing.json', import.meta.url), 'utf8'));
  x.masked_text = 'Hello, this is [PERSON_1]. There is a burst pipe and a leak in the kitchen.\nJob description: Burst pipe repair';
  const r = ok(runIntake(x));
  assert.deepEqual([r.workItem.category, r.workItem.missing_fields, r.workItem.reasons, r.outcome, r.handoff], ['Emergency leak', ['Address'], ['missing_fields'], 'needs-human', null]);
});

test('safe fallback: exactly one source of categories and fields is allowed', () => {
  const both = skillInput() as unknown as Record<string, unknown>;
  both.candidate = { category: 'Category A', fields: [] };
  err(runIntake(both), 'INPUT_INVALID');

  const mixed = skillInput() as unknown as Record<string, unknown>;
  mixed.category_list = ['Category A'];
  err(runIntake(mixed), 'INPUT_INVALID');

  const neither = skillInput() as unknown as Record<string, unknown>;
  delete neither.skill_config;
  err(runIntake(neither), 'INPUT_INVALID');
});

test('safe fallback: tenant, masking, and contract gates still apply in skill mode', () => {
  const a = skillInput() as unknown as Record<string, unknown>; delete a.workspace_id;
  err(runIntake(a), 'TENANT_CONTEXT_MISSING');
  const b = skillInput(); b.masking.applied = false;
  err(runIntake(b), 'MASKING_NOT_DECLARED');
  const c = skillInput(); c.requested_contract = 'work_item.v2';
  err(runIntake(c), 'CONTRACT_UNSUPPORTED');
});

test('safe fallback: regular-expression characters in configuration are literal, and hostile text is handled quickly', () => {
  const cfg = {
    categories: [{ name: 'Category A', keywords: ['a+b(c)', '[x]*', 'c++'] }],
    fields: [{ name: 'Field 1', required: false, extractor: { kind: 'label' as const, labels: ['t.o(p)'] } }],
  };
  assert.deepEqual(validateSkillConfig(cfg), []);
  assert.equal(classifyRequest('we saw a+b(c) today', cfg.categories).category, 'Category A');
  assert.equal(classifyRequest('aab(c) and aaab', cfg.categories).outcome, 'none');
  assert.equal(classifyAndExtract('t.o(p): ok', cfg).fields[0].value, 'ok');
  assert.equal(classifyAndExtract('txo(p): nope', cfg).fields[0].value, null);

  const hostile = 'a'.repeat(19000) + ' ' + ':'.repeat(900);
  const started = performance.now();
  classifyAndExtract(hostile, skillConfig());
  assert.ok(performance.now() - started < 1000, 'must not take long on hostile text');
});

test('safe fallback: oversized or empty text is refused or flagged, never crashes', () => {
  const big = skillInput(); big.masked_text = 'x'.repeat(20001);
  err(runIntake(big), 'INPUT_INVALID');
  const empty = skillInput(); empty.masked_text = '';
  err(runIntake(empty), 'INPUT_INVALID');
  const blank = skillInput(); blank.masked_text = '   \n  ';
  const r = ok(runIntake(blank));
  assert.equal(r.outcome, 'needs-human');
  assert.equal(r.workItem.category, 'unknown');
});

test('safe fallback: a confidence threshold flags every skill-mode item because the skill does not score confidence', () => {
  const r = ok(runIntake(skillInput(), { minConfidence: 0.5 }));
  assert.equal(r.outcome, 'needs-human');
  assert.deepEqual(r.workItem.reasons, ['low_confidence']);
});

// ---------------------------------------------------------------- wiring and determinism
test('wiring: deterministic, never copies masked text, item id follows tenant', () => {
  const a = runIntake(skillInput());
  const b = runIntake(skillInput());
  assert.deepEqual(a, b);
  const text = JSON.stringify(a);
  assert.ok(!text.includes('SENTINEL-SKILL-TEXT-5512'));
  assert.ok(!text.includes('[PERSON_1]'), 'tokens from the text must not appear except as extracted field values');
  const other = skillInput(); other.workspace_id = 'ws-synthetic-b';
  assert.notEqual(ok(runIntake(other)).workItem.item_id, ok(a).workItem.item_id);
});

test('wiring: skill example files behave as documented', () => {
  const read = (n: string) => JSON.parse(readFileSync(new URL(`../examples/${n}`, import.meta.url), 'utf8'));
  const clear = ok(runIntake(read('skill-input.json')));
  assert.equal(clear.outcome, 'handed-off');
  assert.equal(clear.workItem.category, 'Category B');
  // The ambiguous example ties on category, has conflicting Topic/Subject values, and has no [ID_n] token.
  const tie = ok(runIntake(read('skill-ambiguous-input.json')));
  assert.equal(tie.outcome, 'needs-human');
  assert.equal(tie.handoff, null);
  assert.deepEqual(tie.workItem.reasons, ['missing_fields', 'ambiguous_category', 'ambiguous_field']);
  assert.deepEqual(tie.workItem.missing_fields, ['Field 1', 'Field 2']);
});

test('static guard: the skill module imports only local files and uses no network, process, or I/O APIs', () => {
  const src = readFileSync(new URL('../src/classify-extract.ts', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]);
  assert.deepEqual(imports, ['./contracts.ts']);
  for (const banned of [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /child_process/, /node:/, /process\./, /\bconsole\./, /\beval\s*\(/, /new Function/]) {
    assert.ok(!banned.test(src), `banned API in classify-extract.ts: ${banned}`);
  }
});
