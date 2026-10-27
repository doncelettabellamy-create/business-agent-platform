// The SIMULATION pricing fixture for Drew Cleaning (src/pricing-fixture.ts, examples/pricing-fixture-drew-cleaning.json): a price only for a confirmed, first-clean,
// standard house or apartment with at most 2 bedrooms and 2 bathrooms and no extras; everything else is human pricing with no number. Invented data only; the
// fixture is connected to nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describeQuote, factsFromWorkItem, fixtureProblems, formatCents, loadFixture, parseCount, parseFirstClean, priceQuote, quoteFromWorkItem } from '../src/pricing-fixture.ts';
import type { QuoteFacts } from '../src/pricing-fixture.ts';

const raw = () => JSON.parse(readFileSync(new URL('../examples/pricing-fixture-drew-cleaning.json', import.meta.url), 'utf8'));
const FX = loadFixture(raw());
const GOOD: QuoteFacts = { confirmed: true, service: 'Standard cleaning', property_type: 'house', bedrooms: 2, bathrooms: 2, extras: 'none', first_clean: true, commercial: false };
const price = (over: Partial<QuoteFacts> = {}) => priceQuote(FX, { ...GOOD, ...over });
const reasons = (q: ReturnType<typeof priceQuote>) => (q.outcome === 'human-pricing' ? [...q.reasons] : []);

// ---------------------------------------------------------------- the fixture is labelled and validated
test('fixture: labelled SIMULATION, the stated rule, whole cents, and frozen', () => {
  const x = raw();
  assert.deepEqual(fixtureProblems(x), []);
  assert.equal(x.mode, 'SIMULATION');
  assert.ok(x.label.startsWith('SIMULATION ONLY') && /not an approved rate card/i.test(x.label));
  const [rule] = FX.rules;
  assert.deepEqual([rule.service, rule.property_types, rule.max_bedrooms, rule.max_bathrooms, rule.base_cents, rule.first_clean_discount_cents], ['Standard cleaning', ['house', 'apartment'], 2, 2, 19999, 2500]);
  assert.equal(rule.base_cents - rule.first_clean_discount_cents, 17499);
  assert.equal(FX.rules.length, 1, 'no other service has a price');
  assert.throws(() => { (FX as any).mode = 'LIVE'; }, TypeError);
  assert.throws(() => { (FX.rules[0] as any).base_cents = 1; }, TypeError);
});

test('fixture: anything that is not clearly a simulation fixture is refused', () => {
  const bad: Array<[string, (x: any) => void]> = [
    ['live mode', (x) => { x.mode = 'LIVE'; }], ['lower-case mode', (x) => { x.mode = 'simulation'; }], ['label not marked', (x) => { x.label = 'Drew Cleaning rates'; }],
    ['extra key', (x) => { x.approved_by = 'someone'; }], ['no rules', (x) => { x.rules = []; }], ['currency', (x) => { x.currency = 'EUR'; }],
    ['float cents', (x) => { x.rules[0].base_cents = 199.99; }], ['zero base', (x) => { x.rules[0].base_cents = 0; }], ['discount equals base', (x) => { x.rules[0].first_clean_discount_cents = 19999; }],
    ['negative discount', (x) => { x.rules[0].first_clean_discount_cents = -1; }], ['no property types', (x) => { x.rules[0].property_types = []; }],
    ['duplicate property type', (x) => { x.rules[0].property_types = ['house', 'house']; }], ['upper-case property type', (x) => { x.rules[0].property_types = ['House']; }],
    ['bedrooms limit float', (x) => { x.rules[0].max_bedrooms = 2.5; }], ['zero bathrooms limit', (x) => { x.rules[0].max_bathrooms = 0; }],
    ['rule extra key', (x) => { x.rules[0].extras_price = 500; }], ['duplicate service', (x) => { x.rules.push({ ...x.rules[0] }); }], ['bracket in label', (x) => { x.label = 'SIMULATION [x]'; }],
  ];
  for (const [name, mutate] of bad) { const x = raw(); mutate(x); assert.ok(fixtureProblems(x).length > 0, name); assert.throws(() => loadFixture(x), RangeError, name); }
  for (const x of [null, 'x', [], 7]) assert.ok(fixtureProblems(x).length > 0);
  assert.ok(!JSON.stringify(fixtureProblems({ ...raw(), mode: 'LIVE-SECRET-VALUE' })).includes('LIVE-SECRET-VALUE'), 'no value is echoed');
});

// ---------------------------------------------------------------- eligible
test('eligible: a confirmed first-clean standard house or apartment within 2 bedrooms and 2 bathrooms is $199.99 less $25.00 = $174.99', () => {
  for (const over of [{}, { property_type: 'apartment' }, { bedrooms: 1, bathrooms: 1 }, { bedrooms: 0, bathrooms: 1 }, { bedrooms: 2, bathrooms: 1 }, { bedrooms: 1, bathrooms: 2 }, { service: 'standard cleaning' }, { property_type: ' House ' }]) {
    const q = price(over);
    assert.equal(q.outcome, 'priced', JSON.stringify(over));
    if (q.outcome !== 'priced') continue;
    assert.deepEqual([q.mode, q.currency, q.base_cents, q.discount_cents, q.total_cents, q.fixture_id], ['SIMULATION', 'USD', 19999, 2500, 17499, 'drew-cleaning-simulation-v1']);
    assert.equal(formatCents(q.base_cents), '$199.99'); assert.equal(formatCents(q.discount_cents), '$25.00'); assert.equal(formatCents(q.total_cents), '$174.99');
    assert.equal(describeQuote(q), 'SIMULATION: $199.99 less a first-clean discount of $25.00 is $174.99. This is test data, not an approved price.');
  }
});

// ---------------------------------------------------------------- ineligible: a person prices it, no number appears
test('ineligible: outside the rule gets human pricing and no amount of any kind', () => {
  const cases: Array<[string, Partial<QuoteFacts>, string[]]> = [
    ['three bedrooms', { bedrooms: 3 }, ['bedrooms_over_limit']],
    ['three bathrooms', { bathrooms: 3 }, ['bathrooms_over_limit']],
    ['deep cleaning', { service: 'Deep cleaning' }, ['service_not_priced']],
    ['move-out cleaning', { service: 'Move-in or move-out cleaning' }, ['service_not_priced']],
    ['a condo', { property_type: 'condo' }, ['property_not_priced']],
    ['a townhouse', { property_type: 'townhouse' }, ['property_not_priced']],
    ['not their first clean', { first_clean: false }, ['not_first_clean']],
    ['extras asked for', { extras: 'requested' }, ['extras_requested']],
    ['the caller did not confirm', { confirmed: false }, ['not_confirmed']],
  ];
  for (const [name, over, why] of cases) {
    const q = price(over);
    assert.equal(q.outcome, 'human-pricing', name);
    assert.deepEqual(reasons(q), why, name);
    assert.ok(!('total_cents' in q) && !('base_cents' in q) && !('discount_cents' in q), `${name}: no amount`);
    assert.ok(!/\$|\d{3}/.test(describeQuote(q)), `${name}: no figure in the words`);
    assert.match(describeQuote(q), /^SIMULATION: no price\. A person must price this/);
  }
  assert.deepEqual(reasons(price({ bedrooms: 4, bathrooms: 3, first_clean: false })).sort(), ['bathrooms_over_limit', 'bedrooms_over_limit', 'not_first_clean'], 'every applicable reason is listed');
  assert.deepEqual(reasons(price({ bedrooms: 4, bathrooms: 3, service: 'Deep cleaning', first_clean: false })).sort(), ['not_first_clean', 'service_not_priced'], 'with no rule for the service there is nothing to check the limits against');
});

// ---------------------------------------------------------------- unknown: nothing is guessed
test('unknown: every missing, null or unrecognised fact gives human pricing, never a guessed price', () => {
  const unknowns: Array<[string, Partial<QuoteFacts>, string]> = [
    ['confirmation', { confirmed: null }, 'not_confirmed'], ['service', { service: null }, 'service_unknown'], ['property', { property_type: null }, 'property_unknown'],
    ['bedrooms', { bedrooms: null }, 'bedrooms_unknown'], ['bathrooms', { bathrooms: null }, 'bathrooms_unknown'], ['extras', { extras: null }, 'extras_unknown'],
    ['first clean', { first_clean: null }, 'first_clean_unknown'], ['commercial', { commercial: null }, 'commercial_unknown'],
    ['half a bedroom', { bedrooms: 1.5 }, 'bedrooms_unknown'], ['negative bedrooms', { bedrooms: -1 }, 'bedrooms_unknown'], ['zero bathrooms', { bathrooms: 0 }, 'bathrooms_unknown'],
    ['not a number', { bedrooms: Number.NaN }, 'bedrooms_unknown'], ['an undefined service', { service: 'Window cleaning' }, 'service_not_priced'], ['a blank service', { service: '  ' }, 'service_unknown'],
  ];
  for (const [name, over, why] of unknowns) { const q = price(over); assert.equal(q.outcome, 'human-pricing', name); assert.ok(reasons(q).includes(why as never), `${name}: ${reasons(q)}`); }
  for (const nothing of [{}, null, undefined, 'x' as never, [] as never]) assert.equal(priceQuote(FX, nothing as never).outcome, 'human-pricing');
  const none = priceQuote(FX, {});
  assert.deepEqual(reasons(none).sort(), ['bathrooms_unknown', 'bedrooms_unknown', 'commercial_unknown', 'extras_unknown', 'first_clean_unknown', 'not_confirmed', 'property_unknown', 'service_unknown']);
});

// ---------------------------------------------------------------- commercial
test('commercial: a commercial or possibly commercial job is never priced, however well it otherwise fits', () => {
  assert.deepEqual(reasons(price({ commercial: true })), ['commercial']);
  assert.deepEqual(reasons(price({ commercial: null })), ['commercial_unknown']);
  for (const prop of ['office', 'restaurant', 'shop', 'warehouse']) {
    const facts = factsFromWorkItem({ category: 'Standard cleaning', fields: [
      { name: 'Property type', value: prop, found: true }, { name: 'Number of bedrooms', value: 'two bedrooms', found: true }, { name: 'Number of bathrooms', value: 'one bathroom', found: true }, { name: 'Extras', value: 'no extras', found: true },
    ] }, true, true);
    assert.equal(facts.commercial, true, prop);
    const q = priceQuote(FX, facts);
    assert.equal(q.outcome, 'human-pricing', prop);
    assert.ok(reasons(q).includes('commercial'), prop);
  }
  // Commercial wording in ANY answer is enough, even when the property type says house.
  const sneaky = factsFromWorkItem({ category: 'Standard cleaning', fields: [
    { name: 'Property type', value: 'house', found: true }, { name: 'Job description', value: 'it is my business premises', found: true }, { name: 'Number of bedrooms', value: '2', found: true }, { name: 'Number of bathrooms', value: '1', found: true }, { name: 'Extras', value: 'none', found: true },
  ] }, true, true);
  assert.equal(priceQuote(FX, sneaky).outcome, 'human-pricing');
});

// ---------------------------------------------------------------- the whole space: a price is given exactly when every condition holds
test('exhaustive: over every combination of known, unknown and out-of-range facts a price appears exactly when all conditions hold, and is always $174.99', () => {
  const services = ['Standard cleaning', 'Deep cleaning', 'Move-in or move-out cleaning', null];
  const props = ['house', 'apartment', 'condo', 'office', null];
  const counts = [null, 0, 1, 2, 3];
  let priced = 0; let total = 0;
  for (const service of services) for (const property_type of props) for (const bedrooms of counts) for (const bathrooms of counts)
    for (const extras of [null, 'none', 'requested'] as const) for (const first_clean of [null, false, true]) for (const commercial of [null, false, true]) for (const confirmed of [false, true]) {
      const facts: QuoteFacts = { confirmed, service, property_type, bedrooms, bathrooms, extras, first_clean, commercial };
      const q = priceQuote(FX, facts);
      const should = confirmed && service === 'Standard cleaning' && (property_type === 'house' || property_type === 'apartment') && bedrooms !== null && bedrooms <= 2
        && bathrooms !== null && bathrooms >= 1 && bathrooms <= 2 && extras === 'none' && first_clean === true && commercial === false;
      total++;
      assert.equal(q.outcome === 'priced', should, JSON.stringify(facts));
      if (q.outcome === 'priced') { priced++; assert.equal(q.total_cents, 17499); } else assert.ok(q.reasons.length > 0 && !('total_cents' in q));
    }
  assert.equal(total, 4 * 5 * 5 * 5 * 3 * 3 * 3 * 2);
  assert.equal(priced, 2 * 3 * 2);   // house or apartment, bedrooms 0/1/2, bathrooms 1/2
});

// ---------------------------------------------------------------- from a work item
test('parseCount: one clear whole number, or null; a vague or doubled answer is never turned into a count', () => {
  const ok: Array<[string, number]> = [['2', 2], ['two bedrooms', 2], ['Two', 2], ['three bathrooms', 3], ['one bathroom', 1], ['10 rooms', 10]];
  for (const [v, n] of ok) assert.equal(parseCount(v), n, v);
  for (const v of ['a couple of bedrooms', 'two or three', '2 to 3', '2-3', 'about two', 'maybe two', 'several', 'one and a half bathrooms', 'two bedrooms and two bathrooms', 'at least two', 'lots', '', 'a few']) assert.equal(parseCount(v), null, v);
  for (const v of [undefined, null, 7, {}, 'x'.repeat(81)]) assert.equal(parseCount(v as never), null);
  assert.equal(parseCount('studio', true), 0);
  assert.equal(parseCount('studio'), null, 'a studio is zero bedrooms only when asked about bedrooms');
});

test('from a work item: understood answers become facts; anything vague stays unknown and so is never priced', () => {
  const item = (fields: Array<[string, string | null]>) => ({ category: 'Standard cleaning', fields: fields.map(([name, value]) => ({ name, value, found: value !== null })) });
  const full = factsFromWorkItem(item([['Property type', 'House'], ['Number of bedrooms', 'two bedrooms'], ['Number of bathrooms', 'two bathrooms'], ['Extras', 'No extras.']]), true, true);
  assert.deepEqual(full, { confirmed: true, service: 'Standard cleaning', property_type: 'house', commercial: false, bedrooms: 2, bathrooms: 2, extras: 'none', first_clean: true });
  assert.equal(priceQuote(FX, full).outcome, 'priced');
  assert.equal(factsFromWorkItem(item([['Extras', 'no, but I want the oven cleaned']]), true, true).extras, 'requested', 'only a plain "no" is no extras');
  assert.equal(factsFromWorkItem(item([['Extras', 'the oven']]), true, true).extras, 'requested');
  assert.equal(factsFromWorkItem(item([]), true, true).extras, null);
  const vague = factsFromWorkItem(item([['Property type', 'house'], ['Number of bedrooms', 'two or three'], ['Number of bathrooms', 'one'], ['Extras', 'none']]), true, true);
  assert.equal(vague.bedrooms, null);
  assert.equal(priceQuote(FX, vague).outcome, 'human-pricing');
  assert.equal(factsFromWorkItem({ category: 'unknown', fields: [] }, true, true).service, null);
  const unknownProp = factsFromWorkItem(item([['Property type', 'a loft']]), true, true);
  assert.deepEqual([unknownProp.property_type, unknownProp.commercial], ['a loft', null]);
  assert.equal(factsFromWorkItem(item([['Property type', 'house']]), true, null).first_clean, null, 'first-clean status is an explicit input, never assumed');
  assert.equal(priceQuote(FX, factsFromWorkItem(item([['Property type', 'house'], ['Number of bedrooms', '2'], ['Number of bathrooms', '1'], ['Extras', 'none']]), true, null)).outcome, 'human-pricing');
  assert.equal(priceQuote(FX, factsFromWorkItem(item([['Property type', 'house'], ['Number of bedrooms', '2'], ['Number of bathrooms', '1'], ['Extras', 'none']]), false, true)).outcome, 'human-pricing', 'an unconfirmed call is never priced');
});

// ---------------------------------------------------------------- hygiene
test('privacy and isolation: results carry only fixed codes and cents, never the input text, and the module is pure and knows nothing of the opening or any special', () => {
  const q = priceQuote(FX, { confirmed: true, service: 'Elm Street 42 secret', property_type: '<script>alert(1)</script>', bedrooms: 2, bathrooms: 2, extras: 'none', first_clean: true, commercial: false });
  assert.equal(q.outcome, 'human-pricing');
  const out = JSON.stringify(q);
  for (const leak of ['Elm', 'secret', 'script', 'alert']) assert.ok(!out.includes(leak), leak);
  const src = readFileSync(new URL('../src/pricing-fixture.ts', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const imports = [...code.matchAll(/^\s*import\s.*from\s+'([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['./first-clean.ts'], 'imports only the pure first-clean reader');
  for (const banned of ['fetch(', 'Date.now', 'Math.random', 'process.', 'readFileSync', 'opening', 'special']) assert.ok(!code.includes(banned), `must not use ${banned}`);
});

test('commercial: a work item routed as commercial is never priced, even with perfect residential answers', () => {
  const facts = factsFromWorkItem({ category: 'Commercial cleaning', fields: [
    { name: 'Property type', value: 'house', found: true }, { name: 'Number of bedrooms', value: '2', found: true }, { name: 'Number of bathrooms', value: '1', found: true }, { name: 'Extras', value: 'none', found: true },
  ] }, true, true);
  const q = priceQuote(FX, facts);
  assert.equal(q.outcome, 'human-pricing');
  assert.ok(reasons(q).includes('service_not_priced'));
  assert.ok(!('total_cents' in q));
});

// ---------------------------------------------------------------- how the first-cleaning answer reaches the quote
const FIRST_FIELD = 'First cleaning with us';
const residential = (first: string | null, over: Array<[string, string | null]> = []) => ({ category: 'Standard cleaning', fields: [
  ['Property type', 'house'], ['Number of bedrooms', 'two bedrooms'], ['Number of bathrooms', 'one bathroom'], ['Extras', 'no extras'], [FIRST_FIELD, first], ...over,
].map(([name, value]) => ({ name: name as string, value: value as string | null, found: value !== null })) });

test('first cleaning: the answer is read strictly: plain yes or first-time wording is true, plain no or not-first wording is false, everything else is unknown', () => {
  for (const v of ['yes', 'Yes.', 'yeah', 'Yes, it is', 'my first cleaning', 'This is my first cleaning with you', "it's my first", 'first time', 'First cleaning with us']) assert.equal(parseFirstClean(v), true, v);
  for (const v of ['no', 'Nope', 'not my first', "It's not my first cleaning", 'second time', 'third cleaning', 'we have used you before', 'a returning customer']) assert.equal(parseFirstClean(v), false, v);
  for (const v of ['maybe', 'I think so', 'not sure', 'I am not sure if it is my first', 'yes but I used another company', 'yes and no', 'probably', 'first and second', 'I guess', 'it depends', 'used you before', '', '   ', 'x'.repeat(81)]) assert.equal(parseFirstClean(v), null, JSON.stringify(v));
  for (const v of [undefined, null, 5, {}, ['yes']]) assert.equal(parseFirstClean(v as never), null);
});

test('first cleaning: the answer in the work item reaches the quote: yes earns the discount, anything else is human pricing with no number', () => {
  const q = quoteFromWorkItem(FX, residential('my first cleaning'), true);
  assert.deepEqual([q.outcome, q.outcome === 'priced' ? q.total_cents : null], ['priced', 17499]);
  assert.equal(quoteFromWorkItem(FX, residential('yes'), true).outcome, 'priced');
  const cases: Array<[string, string | null, string]> = [
    ['no', 'no', 'not_first_clean'], ['not my first', 'not my first', 'not_first_clean'], ['second time', 'second time', 'not_first_clean'],
    ['unclear', 'I am not sure if it is my first', 'first_clean_unknown'], ['hedged', 'yes but I used another company', 'first_clean_unknown'], ['maybe', 'maybe', 'first_clean_unknown'],
    ['never answered', null, 'first_clean_unknown'],
  ];
  for (const [name, answer, why] of cases) {
    const r = quoteFromWorkItem(FX, residential(answer), true);
    assert.equal(r.outcome, 'human-pricing', name);
    assert.deepEqual(reasons(r), [why], name);
    assert.ok(!('total_cents' in r) && !('discount_cents' in r), `${name}: no amount and no discount`);
  }
});

test('first cleaning: the discount needs the call confirmed too, and a missing field or an unknown field name never qualifies', () => {
  assert.deepEqual(reasons(quoteFromWorkItem(FX, residential('yes'), false)), ['not_confirmed'], 'an unconfirmed call is never priced, however clear the answer');
  const noField = { category: 'Standard cleaning', fields: residential('yes').fields.filter((x) => x.name !== FIRST_FIELD) };
  assert.deepEqual(reasons(quoteFromWorkItem(FX, noField, true)), ['first_clean_unknown']);
  const renamed = { category: 'Standard cleaning', fields: residential('yes').fields.map((x) => (x.name === FIRST_FIELD ? { ...x, name: 'First clean' } : x)) };
  assert.deepEqual(reasons(quoteFromWorkItem(FX, renamed, true)), ['first_clean_unknown'], 'only the field the fixture names is read');
  assert.equal(priceQuote(FX, factsFromWorkItem(renamed, true, undefined, 'First clean')).outcome, 'priced', 'a business that renames the field points the fixture at the new name');
  assert.equal(factsFromWorkItem(residential('yes'), true, null).first_clean, null, 'an explicit unknown overrides the field');
});

test('first cleaning: the discount applies to the standard house or apartment rule only, so other services stay with a person even after a yes', () => {
  const deep = { category: 'Deep cleaning', fields: residential('yes').fields };
  const q = quoteFromWorkItem(FX, deep, true);
  assert.equal(q.outcome, 'human-pricing');
  assert.deepEqual(reasons(q), ['service_not_priced']);
});
