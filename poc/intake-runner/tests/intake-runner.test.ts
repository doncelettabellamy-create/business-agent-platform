// Automated tests for the synthetic Intake runner PoC. Run with: npm test (or node --test tests/intake-runner.test.ts).
// Synthetic data only. No network, no database, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runIntake, validateInput } from '../src/intake-runner.ts';
import type { RunResult } from '../src/intake-runner.ts';
import { validateEnvelope, validateWorkItem } from '../src/contracts.ts';
import { validInput } from './fixtures.ts';

function expectOk(r: RunResult) {
  assert.equal(r.ok, true, 'expected ok result');
  if (!r.ok) throw new Error('unreachable');
  return r;
}
function expectError(r: RunResult, code: string) {
  assert.equal(r.ok, false, 'expected error result');
  if (r.ok) throw new Error('unreachable');
  assert.equal(r.error.code, code);
  return r.error;
}

// ---------------------------------------------------------------- valid input
test('valid input: ready work item, validated, handed off in an envelope', () => {
  const r = expectOk(runIntake(validInput()));
  assert.equal(r.outcome, 'handed-off');
  assert.equal(r.workItem.status, 'ready');
  assert.equal(r.workItem.category, 'Category A');
  assert.deepEqual(r.workItem.reasons, []);
  assert.deepEqual(r.workItem.missing_fields, []);
  assert.deepEqual(validateWorkItem(r.workItem), []);

  const env = r.handoff;
  assert.ok(env, 'handoff envelope present');
  assert.deepEqual(validateEnvelope(env), []);
  assert.equal(env.contract, 'work_item.v1');
  assert.equal(env.workspace_id, 'ws-synthetic-a');
  assert.equal(env.correlation_id, 'corr-synthetic-0001');
  assert.equal(env.item_id, r.workItem.item_id);
  assert.deepEqual(env.payload, r.workItem);
  assert.deepEqual(env.evidence_refs, ['msg:evt-synthetic-0001']);
  assert.equal(env.confidence, 0.88);              // lowest found-field confidence
  assert.equal(env.created_at, '2026-10-24T09:12:00Z');
});

test('valid input: output is deterministic and does not copy the masked text', () => {
  const a = runIntake(validInput());
  const b = runIntake(validInput());
  assert.deepEqual(a, b);
  assert.ok(!JSON.stringify(a).includes('SENTINEL-MASKED-TEXT-7731'), 'masked text must not appear in the output');
  assert.ok(!JSON.stringify(a).includes('[PERSON_1]'), 'message tokens must not appear in the output');
});

test('valid input: item ids differ across tenants for the same event id', () => {
  const a = expectOk(runIntake(validInput()));
  const other = validInput();
  other.workspace_id = 'ws-synthetic-b';
  const b = expectOk(runIntake(other));
  assert.notEqual(a.workItem.item_id, b.workItem.item_id);
  assert.equal(b.workItem.workspace_id, 'ws-synthetic-b');
});

test('example files in examples/ behave as documented', () => {
  const valid = JSON.parse(readFileSync(new URL('../examples/valid-input.json', import.meta.url), 'utf8'));
  const flagged = JSON.parse(readFileSync(new URL('../examples/needs-human-input.json', import.meta.url), 'utf8'));
  assert.equal(expectOk(runIntake(valid)).outcome, 'handed-off');
  const f = expectOk(runIntake(flagged));
  assert.equal(f.outcome, 'needs-human');
  assert.equal(f.handoff, null);
});

// ---------------------------------------------------------------- missing tenant
test('missing tenant: refused, nothing built, nothing handed off', () => {
  const noTenant: unknown[] = [];
  const a = validInput() as unknown as Record<string, unknown>; delete a.workspace_id; noTenant.push(a);
  const b = validInput() as unknown as Record<string, unknown>; b.workspace_id = ''; noTenant.push(b);
  const c = validInput() as unknown as Record<string, unknown>; c.workspace_id = '   '; noTenant.push(c);
  const d = validInput() as unknown as Record<string, unknown>; d.workspace_id = 42; noTenant.push(d);
  const e = validInput() as unknown as Record<string, unknown>; e.workspace_id = null; noTenant.push(e);
  noTenant.push(null, undefined, 'text', []);
  for (const input of noTenant) {
    const r = runIntake(input);
    expectError(r, 'TENANT_CONTEXT_MISSING');
    assert.ok(!('workItem' in r) && !('handoff' in r), 'no work item or envelope on a missing tenant');
  }
});

test('missing tenant is checked before anything else, even if the rest is also invalid', () => {
  const r = runIntake({ masking: { applied: false }, candidate: 'nonsense' });
  expectError(r, 'TENANT_CONTEXT_MISSING');
});

test('a malformed tenant id is rejected as invalid input, not accepted', () => {
  const x = validInput();
  x.workspace_id = 'ws bad/id';
  expectError(runIntake(x), 'INPUT_INVALID');
});

// ---------------------------------------------------------------- invalid contract
test('invalid contract: unsupported requested contract or version is refused', () => {
  for (const requested of ['work_item.v2', 'work_item', 'candidate_result.v1']) {
    const x = validInput();
    x.requested_contract = requested;
    expectError(runIntake(x), 'CONTRACT_UNSUPPORTED');
  }
});

test('invalid contract: work_item.v1 validator rejects malformed work items', () => {
  const good = expectOk(runIntake(validInput())).workItem;
  assert.deepEqual(validateWorkItem(good), []);
  const clone = () => structuredClone(good) as unknown as Record<string, unknown>;
  const cases: Array<[string, (w: Record<string, unknown>) => void]> = [
    ['bad status', (w) => { w.status = 'done'; }],
    ['missing key', (w) => { delete w.versions; }],
    ['unexpected key', (w) => { w.masked_text = 'x'; }],
    ['bad item id', (w) => { w.item_id = 'item-1'; }],
    ['empty workspace', (w) => { w.workspace_id = ''; }],
    ['ready with reasons', (w) => { w.reasons = ['missing_fields']; }],
    ['needs-human without reasons', (w) => { w.status = 'needs-human'; }],
    ['ready but unknown category', (w) => { w.category = 'unknown'; }],
    ['missing_fields names a found field', (w) => { w.missing_fields = ['Field 1']; w.reasons = ['missing_fields']; w.status = 'needs-human'; }],
    ['confidence out of range', (w) => { (w.fields as Array<Record<string, unknown>>)[0].confidence = 1.5; }],
    ['found field without value', (w) => { (w.fields as Array<Record<string, unknown>>)[0].value = null; }],
    ['bad message_ref', (w) => { w.message_ref = 'Hello this is raw text'; }],
    ['negative pii count', (w) => { w.pii_summary = [{ type: 'Person', count: -1 }]; }],
    ['not an object', () => { /* replaced below */ }],
  ];
  for (const [name, mutate] of cases) {
    const w = clone();
    mutate(w);
    const target = name === 'not an object' ? 'text' : w;
    assert.ok(validateWorkItem(target).length > 0, `validator should reject: ${name}`);
  }
});

test('invalid contract: envelope validator rejects tenant mismatch, wrong contract, and handed-off needs-human items', () => {
  const env = structuredClone(expectOk(runIntake(validInput())).handoff) as unknown as Record<string, unknown>;
  assert.deepEqual(validateEnvelope(env), []);

  const wrongTenant = structuredClone(env); wrongTenant.workspace_id = 'ws-synthetic-b';
  assert.ok(validateEnvelope(wrongTenant).some((e) => e.includes('workspace')));

  const wrongContract = structuredClone(env); wrongContract.contract = 'work_item.v2';
  assert.ok(validateEnvelope(wrongContract).some((e) => e.includes('contract')));

  const flagged = structuredClone(env) as { payload: Record<string, unknown> };
  flagged.payload.status = 'needs-human';
  assert.ok(validateEnvelope(flagged).length > 0);

  const noEvidence = structuredClone(env); noEvidence.evidence_refs = [];
  assert.ok(validateEnvelope(noEvidence).length > 0);
});

test('invalid input: structural problems are refused and error text never echoes input values', () => {
  const secretLooking = 'LEAK-CANARY-9921';
  const bad = validInput() as unknown as Record<string, unknown>;
  bad.surprise_key = secretLooking;                       // unexpected key
  (bad.candidate as Record<string, unknown>).category = 12345;
  (bad.candidate as { fields: Array<Record<string, unknown>> }).fields[0].confidence = secretLooking;
  const err = expectError(runIntake(bad), 'INPUT_INVALID');
  assert.ok((err.paths ?? []).length >= 2);
  assert.ok(!JSON.stringify(err).includes(secretLooking), 'error output must not contain input values');
  assert.ok(!JSON.stringify(err).includes('surprise_key'), 'error output must not contain input key names');

  const tooLong = validInput(); tooLong.masked_text = 'x'.repeat(20001);
  expectError(runIntake(tooLong), 'INPUT_INVALID');
  assert.ok(validateInput(null).length > 0);
});

test('invalid contract: input not declared as masked is refused', () => {
  const x = validInput();
  x.masking.applied = false;
  expectError(runIntake(x), 'MASKING_NOT_DECLARED');
  const y = validInput() as unknown as Record<string, unknown>;
  y.masking = { applied: 'yes', source: 'synthetic-fixture' };
  expectError(runIntake(y), 'INPUT_INVALID');
});

// ---------------------------------------------------------------- needs-human fallback
test('needs-human fallback: missing required fields', () => {
  const x = validInput();
  x.required_fields = ['Field 1', 'Field 2', 'Field 3'];
  x.candidate.fields[1] = { name: 'Field 2', value: null, confidence: null };
  const r = expectOk(runIntake(x));
  assert.equal(r.outcome, 'needs-human');
  assert.equal(r.handoff, null);
  assert.equal(r.workItem.status, 'needs-human');
  assert.deepEqual(r.workItem.reasons, ['missing_fields']);
  assert.deepEqual(r.workItem.missing_fields, ['Field 2', 'Field 3']);
  assert.deepEqual(validateWorkItem(r.workItem), [], 'a needs-human item is still a valid work_item.v1');
});

test('needs-human fallback: category not in the configured list becomes unknown', () => {
  const x = validInput();
  x.candidate.category = 'Category Z';
  const r = expectOk(runIntake(x));
  assert.equal(r.workItem.category, 'unknown');
  assert.deepEqual(r.workItem.reasons, ['unknown_category']);
  assert.equal(r.handoff, null);

  const y = validInput();
  y.candidate.category = null;
  const r2 = expectOk(runIntake(y));
  assert.equal(r2.workItem.category, 'unknown');
  assert.equal(r2.outcome, 'needs-human');
});

test('needs-human fallback: low confidence only applies when a threshold is supplied (threshold is TBD, D-04)', () => {
  const x = validInput();                       // lowest confidence is 0.88
  assert.equal(expectOk(runIntake(x)).outcome, 'handed-off');                       // no threshold: check is off
  assert.equal(expectOk(runIntake(x, { minConfidence: 0.8 })).outcome, 'handed-off');   // test value only
  const low = expectOk(runIntake(x, { minConfidence: 0.9 }));                        // test value only
  assert.equal(low.outcome, 'needs-human');
  assert.deepEqual(low.workItem.reasons, ['low_confidence']);
  assert.throws(() => runIntake(x, { minConfidence: 1.5 }), RangeError);
});

test('needs-human fallback: several reasons are reported together and in a fixed order', () => {
  const x = validInput();
  x.candidate.category = 'Category Z';
  x.candidate.fields = [{ name: 'Field 1', value: 'Follow-up', confidence: 0.4 }];
  const r = expectOk(runIntake(x, { minConfidence: 0.9 }));
  assert.deepEqual(r.workItem.reasons, ['missing_fields', 'unknown_category', 'low_confidence']);
  assert.deepEqual(r.workItem.missing_fields, ['Field 2']);
  assert.equal(r.handoff, null);
});

test('needs-human fallback: no required fields and no found values still flags when a threshold is set', () => {
  const x = validInput();
  x.required_fields = [];
  x.candidate.fields = [];
  assert.equal(expectOk(runIntake(x)).outcome, 'handed-off');
  const r = expectOk(runIntake(x, { minConfidence: 0.5 }));
  assert.deepEqual(r.workItem.reasons, ['low_confidence']);
});

// ---------------------------------------------------------------- guard on the claims in the README
test('static guard: runner and contracts import only node:crypto and local files, and use no network or process APIs', () => {
  for (const name of ['../src/intake-runner.ts', '../src/contracts.ts', '../src/classify-extract.ts']) {
    const src = readFileSync(new URL(name, import.meta.url), 'utf8');
    const imports = [...src.matchAll(/^import[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(spec === 'node:crypto' || spec.startsWith('./'), `unexpected import in ${name}: ${spec}`);
    }
    for (const banned of [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /child_process/, /node:(net|http|https|dns|tls|fs|worker_threads)/, /process\.env/, /\bconsole\./]) {
      assert.ok(!banned.test(src), `banned API in ${name}: ${banned}`);
    }
  }
});
