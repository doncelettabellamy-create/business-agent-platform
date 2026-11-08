// Offline tests for tools/google-validation-trial.ts. No network, no key, no Google: every response below is a SYNTHETIC FIXTURE shaped like the ones in Google's own documentation
// (understand-response, accept/fix/confirm address examples, read 2026-11-07). They are never sent anywhere.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ENDPOINT, MAX_REQUESTS, PLAN, bodyFor, evaluate, runTrial, summarize } from '../tools/google-validation-trial.ts';
import type { PlanItem, TrialInput } from '../tools/google-validation-trial.ts';

const IN: TrialInput = { street: '1600 Amphitheatre Parkway', city: 'Mountain View', state: 'CA', zip: '94043' };
const comp = (componentType: string, extra: Record<string, unknown> = {}) => ({ componentName: { text: 'x' }, componentType, confirmationLevel: 'CONFIRMED', ...extra });
/** A clean US response (Google's documented good example, trimmed): premise-level, complete, ZIP+4 inferred, DPV confirmed. */
function good(over: { verdict?: Record<string, unknown>; address?: Record<string, unknown>; usps?: Record<string, unknown>; drop?: string[] } = {}) {
  const r: Record<string, unknown> = {
    verdict: { inputGranularity: 'PREMISE', validationGranularity: 'PREMISE', geocodeGranularity: 'PREMISE', addressComplete: true, hasInferredComponents: true, ...over.verdict },
    address: { postalAddress: { regionCode: 'US', postalCode: '94043-1351', administrativeArea: 'CA', locality: 'Mountain View' }, addressComponents: [comp('street_number'), comp('route'), comp('locality'), comp('postal_code'), comp('administrative_area_level_1'), comp('postal_code_suffix', { inferred: true })], ...over.address },
    uspsData: { standardizedAddress: { state: 'CA', zipCode: '94043', zipCodeExtension: '1351' }, dpvConfirmation: 'Y', ...over.usps },
  };
  for (const k of over.drop ?? []) delete r[k];
  return { result: r };
}
const verdictOf = (body: unknown, input = IN) => { const e = evaluate(input, body); return [e.verdict.status, 'field' in e.verdict ? e.verdict.field : undefined, e.reasons[0]]; };

test('evaluate: a clean, complete, premise-level, USPS-confirmed address whose state and ZIP are the ones asked about is valid (inferred ZIP+4 alone is harmless; case does not matter)', () => {
  assert.deepEqual(verdictOf(good()), ['valid', undefined, 'clean']);
  assert.deepEqual(verdictOf(good({ verdict: { validationGranularity: 'SUB_PREMISE' } })), ['valid', undefined, 'clean']);
  assert.deepEqual(verdictOf(good(), { street: '1600 amphitheatre pkwy', city: 'mountain view', state: 'ca', zip: '94043' }), ['valid', undefined, 'clean']);
});

test('evaluate: every documented FIX, CONFIRM and ACCEPT edge case fails closed (nothing but a clean address is valid)', () => {
  // FIX: missing city and ZIP -> granularity OTHER, nothing confirmed
  assert.deepEqual(verdictOf({ result: { verdict: { inputGranularity: 'PREMISE', validationGranularity: 'OTHER', geocodeGranularity: 'OTHER', hasUnconfirmedComponents: true, possibleNextAction: 'FIX' } } }), ['mismatch', 'street', 'granularity_other']);
  // FIX: missing street number -> ROUTE, missingComponentTypes
  assert.deepEqual(verdictOf({ result: { verdict: { inputGranularity: 'PREMISE_PROXIMITY', validationGranularity: 'ROUTE', geocodeGranularity: 'ROUTE', possibleNextAction: 'FIX' }, address: { missingComponentTypes: ['street_number'] } } }), ['mismatch', 'house_number', 'granularity_route']);
  // US unconfirmed street number -> PREMISE_PROXIMITY and DPV N
  assert.deepEqual(verdictOf(good({ verdict: { validationGranularity: 'PREMISE_PROXIMITY' }, usps: { dpvConfirmation: 'N' } })), ['mismatch', 'house_number', 'granularity_premise_proximity']);
  // US premise-level but DPV N
  assert.deepEqual(verdictOf(good({ usps: { dpvConfirmation: 'N' } })), ['mismatch', 'house_number', 'dpv_n']);
  // missing subpremise (San Francisco assessor example): PREMISE, no addressComplete, missing subpremise, DPV D
  assert.deepEqual(verdictOf(good({ verdict: { addressComplete: undefined }, address: { missingComponentTypes: ['subpremise'] }, usps: { dpvConfirmation: 'D' } })), ['unknown', undefined, 'missing_component']);
  // CONFIRM: a replaced ZIP (Kirkland entered as Seattle): the returned ZIP is not the one asked about
  assert.deepEqual(verdictOf(good({ verdict: { hasReplacedComponents: true }, usps: { standardizedAddress: { state: 'CA', zipCode: '98104' } }, address: { postalAddress: { postalCode: '98104', administrativeArea: 'CA' } } })), ['mismatch', 'zip_city', 'zip_differs']);
  // CONFIRM: replaced component, same state and ZIP
  assert.deepEqual(verdictOf(good({ verdict: { hasReplacedComponents: true }, address: { addressComponents: [comp('postal_code', { replaced: true })] } })), ['mismatch', 'zip_city', 'replaced_postal_code']);
  // CONFIRM: inferred city and ZIP suffix (the Springfield example): Google says CONFIRM; Drew treats an inferred city as corrected
  assert.deepEqual(verdictOf(good({ address: { addressComponents: [comp('locality', { inferred: true }), comp('postal_code_suffix', { inferred: true })] } })), ['corrected', undefined, 'inferred']);
  // spell-corrected
  assert.deepEqual(verdictOf(good({ verdict: { hasSpellCorrectedComponents: true } })), ['corrected', undefined, 'spell_corrected']);
  // unexpected or unconfirmed component (the Chingford / Gloucestershire examples)
  assert.deepEqual(verdictOf(good({ verdict: { hasUnconfirmedComponents: true } })), ['unknown', undefined, 'unconfirmed']);
  assert.deepEqual(verdictOf(good({ address: { addressComponents: [comp('sublocality_level_1', { unexpected: true })] } })), ['unknown', undefined, 'unconfirmed']);
  // not complete
  assert.deepEqual(verdictOf(good({ verdict: { addressComplete: undefined } })), ['unknown', undefined, 'incomplete']);
  // Google's own "incomplete USPS data" ACCEPT example (no DPV code): Drew's rule is stricter and fails closed
  assert.deepEqual(verdictOf(good({ usps: { dpvConfirmation: undefined } })), ['unknown', undefined, 'dpv_missing']);
  // a non-US address has no USPS data: unknown for a US-only product
  assert.deepEqual(verdictOf({ result: { verdict: { validationGranularity: 'PREMISE', addressComplete: true }, address: { postalAddress: { regionCode: 'GB', postalCode: 'SW1W 9TQ' } } } }), ['unknown', undefined, 'no_returned_location']);
});

test('evaluate: a returned state or ZIP that differs from the one asked about is a mismatch; malformed bodies are unknown', () => {
  assert.deepEqual(verdictOf(good({ usps: { standardizedAddress: { state: 'NV', zipCode: '94043' } }, address: { postalAddress: { administrativeArea: 'NV', postalCode: '94043' } } })), ['mismatch', 'zip_state', 'state_differs']);
  assert.deepEqual(verdictOf(good({ usps: { standardizedAddress: { state: 'CA', zipCode: '95014' } }, address: { postalAddress: { administrativeArea: 'CA', postalCode: '95014' } } })), ['mismatch', 'zip_city', 'zip_differs']);
  for (const bad of [undefined, null, 'ok', 42, [], {}, { result: null }, { result: { verdict: 'x' } }, { result: { verdict: {} } }]) assert.equal(evaluate(IN, bad).verdict.status, 'unknown', String(bad));
});

test('evaluate: the evaluation holds tokens only: no input text and no text of the response', () => {
  const body = good({ address: { addressComponents: [comp('route', { componentName: { text: 'SECRET-STREET-TEXT' } })] }, usps: { standardizedAddress: { state: 'CA', zipCode: '94043', firstAddressLine: 'SECRET-LINE' } } });
  const all = JSON.stringify(evaluate(IN, body));
  for (const s of ['SECRET', 'Amphitheatre', 'Mountain View', '94043', '1600']) assert.ok(!all.includes(s), s);
});

test('PLAN: nine real published addresses, none altered, two with CASS, under the hard limit of ten; the request body is the documented shape and carries no key', () => {
  assert.equal(MAX_REQUESTS, 10); assert.equal(PLAN.length, 9); assert.equal(PLAN.filter((p) => p.cass).length, 2); assert.deepEqual(PLAN.map((p) => p.id), ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9']);
  assert.deepEqual(PLAN.slice(0, 5).map((p) => [p.input.street, p.input.city, p.input.state, p.input.zip]), [
    ['1600 Amphitheatre Parkway', 'Mountain View', 'CA', '94043'], ['1600 Pennsylvania Avenue, N.W.', 'Washington', 'DC', '20500'], ['One Microsoft Way', 'Redmond', 'WA', '98052'], ['1 First Street, NE', 'Washington', 'DC', '20543'], ['8601 Adelphi Road', 'College Park', 'MD', '20740'],
  ], 'the five published addresses are pinned: an accidental edit fails here');
  assert.deepEqual(PLAN[5].input, { street: '1600 amphitheatre pkwy', city: 'mountain view', state: 'ca', zip: '94043' }); assert.equal(PLAN[5].input.zip, PLAN[0].input.zip);
  assert.deepEqual(JSON.parse(bodyFor(PLAN[0])), { address: { regionCode: 'US', locality: 'Mountain View', administrativeArea: 'CA', postalCode: '94043', addressLines: ['1600 Amphitheatre Parkway'] } });
  assert.equal(JSON.parse(bodyFor(PLAN[6])).enableUspsCass, true);
  for (const p of PLAN) assert.ok(!/key|AIza/i.test(bodyFor(p)));
});

type Answer = { status: number; body: unknown } | 'throw' | ((req: { address: { administrativeArea: string; postalCode: string } }) => { status: number; body: unknown });
/** A clean answer for whichever address was asked about (state and ZIP echoed back, as a real clean answer would). */
const cleanFor = (req: { address: { administrativeArea: string; postalCode: string } }) => ({ status: 200, body: good({ usps: { standardizedAddress: { state: req.address.administrativeArea.toUpperCase(), zipCode: req.address.postalCode } }, address: { postalAddress: { administrativeArea: req.address.administrativeArea.toUpperCase(), postalCode: req.address.postalCode } } }) });
function fakeFetch(answers: Answer[]) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = []; let i = 0;
  return { calls, fetch: async (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => {
    calls.push({ url, headers: init.headers, body: init.body }); const raw = answers[Math.min(i++, answers.length - 1)]; if (raw === 'throw') throw new Error('network down with KEY-IN-ERROR'); const a = typeof raw === 'function' ? raw(JSON.parse(init.body)) : raw;
    return { status: a.status, text: async () => JSON.stringify(a.body) };
  } };
}
let tick = 0; const clock = () => (tick += 100);

test('runTrial: sends the plan once each, never more than ten, the key only in the header, and returns tokens only; a clean fixture passes the summary', async () => {
  const f = fakeFetch([cleanFor]);
  const rows = await runTrial({ key: 'FAKE-KEY-0123456789', fetch: f.fetch, clock });
  assert.equal(f.calls.length, 9); assert.ok(f.calls.length <= MAX_REQUESTS);
  for (const c of f.calls) { assert.equal(c.url, ENDPOINT); assert.equal(c.headers['X-Goog-Api-Key'], 'FAKE-KEY-0123456789'); assert.ok(!c.url.includes('FAKE-KEY') && !c.url.includes('?'), 'the key is never in the URL'); assert.ok(!c.body.includes('FAKE-KEY')); }
  const s = summarize(rows); assert.deepEqual([s.requests, s.falseRejects, s.allHttp200, s.repeatable], [9, 0, true, true]);
  const all = JSON.stringify(rows); for (const x of ['FAKE-KEY', 'Amphitheatre', 'Mountain View', '94043', 'Pennsylvania']) assert.ok(!all.includes(x), x);
});

test('runTrial: stops at the first answer that is not HTTP 200 (no retry), records the API error enumeration only, and never leaks the key from an error', async () => {
  const f = fakeFetch([{ status: 200, body: good() }, { status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'key FAKE-KEY-0123456789 project 12345' } } }]);
  const rows = await runTrial({ key: 'FAKE-KEY-0123456789', fetch: f.fetch, clock });
  assert.equal(f.calls.length, 2); assert.equal(rows.length, 2); assert.deepEqual([rows[1].http, rows[1].outcome, rows[1].apiError], [403, 'not_run', 'PERMISSION_DENIED']);
  assert.ok(!JSON.stringify(rows).includes('FAKE-KEY') && !JSON.stringify(rows).includes('12345'));
  const t = fakeFetch(['throw']); const r2 = await runTrial({ key: 'FAKE-KEY-0123456789', fetch: t.fetch, clock });
  assert.equal(t.calls.length, 1); assert.deepEqual([r2[0].http, r2[0].reasons], [-1, ['network_or_timeout']]); assert.ok(!JSON.stringify(r2).includes('KEY-IN-ERROR'));
  assert.equal(summarize(rows).pass, false);
});

test('runTrial: a plan longer than the hard limit is refused before anything is sent', async () => {
  const long: PlanItem[] = Array.from({ length: MAX_REQUESTS + 1 }, (_, i) => ({ id: 'X' + i, label: 'x', cass: false, input: IN }));
  const f = fakeFetch([{ status: 200, body: good() }]);
  await assert.rejects(runTrial({ key: 'FAKE-KEY-0123456789', fetch: f.fetch, clock, plan: long }), RangeError); assert.equal(f.calls.length, 0);
});

test('summarize: a finding is reported, not hidden: a false reject, a slow call or a different repeat is not a pass', async () => {
  const mk = async (answers: Answer[], ms = 100) => { let t = 0; const f = fakeFetch(answers); return runTrial({ key: 'FAKE-KEY-0123456789', fetch: f.fetch, clock: () => (t += ms) }); };
  assert.equal(summarize(await mk([cleanFor])).pass, true);
  assert.equal(summarize(await mk([{ status: 200, body: good({ usps: { dpvConfirmation: undefined } }) }])).pass, false, 'every call is a false reject');
  assert.equal(summarize(await mk([cleanFor], 4000)).pass, false, 'too slow');
  const s = summarize(await mk([cleanFor])); assert.deepEqual([s.median, s.max], [100, 100]);
});
