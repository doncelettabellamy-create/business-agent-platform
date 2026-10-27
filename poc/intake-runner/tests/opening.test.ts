// opening.ts: how a call opens. The business and agent are introduced, the disclosure is given, and a special is mentioned ONLY if the config carries one.
// Pure functions and the config gate; synthetic business names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { consentNoticeFor, DEFAULT_CONSENT_NOTICE, DEFAULT_DISCLOSURE, openingProblems, twimlFor } from '../src/opening.ts';
import { founderConfigDigest, founderConfigProblems } from '../src/founder-call-gate.ts';

const example = () => JSON.parse(readFileSync(new URL('../examples/founder-call.config.example.json', import.meta.url), 'utf8'));
const OPEN = { business_name: 'Sparkle Example Cleaning', agent_name: 'Ava' };

test('without an opening block the notice is the original, word for word, and the config digest is unaffected', () => {
  assert.equal(consentNoticeFor(), 'Hello. This is an automated A I assistant, part of a test of a business phone line. We do not record the audio. Our phone provider turns your speech into text, and personal details are masked before an A I model reads it. Please say yes to continue, or hang up now.');
  assert.equal(consentNoticeFor(), DEFAULT_CONSENT_NOTICE);
  assert.deepEqual(founderConfigProblems(example()), []);
  assert.equal(founderConfigDigest(example()), founderConfigDigest({ ...example() }), 'unchanged config, unchanged digest');
});

test('with an opening block: the business and the agent are introduced, then the disclosure, then the request for a yes; no special words appear', () => {
  const n = consentNoticeFor(OPEN);
  assert.equal(n, `Hello. This is Ava, the automated A I assistant for Sparkle Example Cleaning. ${DEFAULT_DISCLOSURE} Please say yes to continue, or hang up now.`);
  assert.ok(/automated A I assistant/.test(n) && n.includes('Sparkle Example Cleaning') && n.includes('Ava'));
  assert.ok(!/special|offer|discount|off\b|free|%|\$/i.test(n), 'nothing like a promotion is added by the code');
});

test('a business may replace the disclosure wording, and a missing full stop is added', () => {
  const n = consentNoticeFor({ ...OPEN, disclosure: 'This call may be recorded for quality' });
  assert.ok(n.includes('This call may be recorded for quality. Please say yes'));
  assert.ok(!n.includes('We do not record the audio'), 'the default disclosure is replaced, not appended');
});

test('a special is spoken only when the business put one in the config, exactly as written, once, before the request for a yes', () => {
  const special = 'This week, first-time customers get a free window clean';
  const n = consentNoticeFor({ ...OPEN, special });
  assert.equal(n.split(special).length, 2, 'exactly once, verbatim');
  assert.ok(n.indexOf(special) > n.indexOf('A I assistant') && n.indexOf(special) < n.indexOf('Please say yes'));
  // No special key, no special words: the notice has nothing between the disclosure and the request.
  const none = consentNoticeFor(OPEN);
  assert.ok(!none.includes('free window') && none.includes(`${DEFAULT_DISCLOSURE} Please say yes`));
  assert.equal(consentNoticeFor({ ...OPEN, special: undefined }), none, 'an absent special is the same as no special');
});

test('a special is never added from anywhere else: different businesses with no special never mention one', () => {
  for (const b of [{ business_name: 'North Example Cleaners', agent_name: 'Sam' }, { business_name: 'Bright Example Maids', agent_name: 'Riley', disclosure: 'We do not record calls.' }]) {
    const n = consentNoticeFor(b);
    assert.ok(!/special|discount|promotion|offer|free|save|deal/i.test(n), n);
  }
});

test('validation: required names, exact keys, length limits and plain single-line text; nothing is echoed', () => {
  assert.deepEqual(openingProblems(OPEN), []);
  assert.deepEqual(openingProblems({ ...OPEN, disclosure: 'We do not record calls.', special: 'Ask about our spring offer' }), []);
  const bad: Array<[string, unknown]> = [
    ['not an object', 'x'], ['null', null], ['array', []], ['no business', { agent_name: 'Ava' }], ['no agent', { business_name: 'Sparkle Example Cleaning' }],
    ['extra key', { ...OPEN, price: '10' }], ['business too short', { ...OPEN, business_name: 'S' }], ['business too long', { ...OPEN, business_name: 'x'.repeat(81) }],
    ['agent too long', { ...OPEN, agent_name: 'x'.repeat(41) }], ['special too long', { ...OPEN, special: 'x'.repeat(201) }], ['disclosure too short', { ...OPEN, disclosure: 'short' }],
    ['newline', { ...OPEN, special: 'line one\nline two' }], ['angle bracket', { ...OPEN, special: '<b>sale</b>' }], ['square bracket (a placeholder look-alike)', { ...OPEN, agent_name: '[PERSON_1]' }],
    ['curly bracket', { ...OPEN, special: 'save {amount}' }], ['backslash', { ...OPEN, business_name: 'Sparkle\\Cleaning' }], ['padded', { ...OPEN, business_name: ' Sparkle Example Cleaning' }],
    ['number', { ...OPEN, agent_name: 7 }], ['empty special', { ...OPEN, special: '' }],
  ];
  for (const [name, v] of bad) {
    const p = openingProblems(v);
    assert.ok(p.length > 0, name);
    assert.ok(!JSON.stringify(p).includes('Sparkle') && !JSON.stringify(p).includes('Ava'), `${name}: a value was echoed`);
    if (typeof v === 'object' && v !== null && !Array.isArray(v) && 'business_name' in v && 'agent_name' in v) assert.throws(() => consentNoticeFor(v as never), RangeError, name);
  }
});

test('config gate: opening is the one optional key; it is validated; changing any part changes the approval digest', () => {
  const base = { ...example() };
  const withOpening = (o: unknown) => ({ ...base, opening: o });
  assert.deepEqual(founderConfigProblems(withOpening(OPEN)), []);
  assert.ok(founderConfigProblems(withOpening({ ...OPEN, special: '<x>' })).length > 0, 'a bad opening is refused');
  assert.ok(founderConfigProblems(withOpening('text')).length > 0);
  assert.ok(founderConfigProblems({ ...base, extra: 1 }).length > 0, 'any other extra key is still refused');
  assert.ok(founderConfigProblems({ ...withOpening(OPEN), extra: 1 }).length > 0);
  const d0 = founderConfigDigest(base);
  const d1 = founderConfigDigest(withOpening(OPEN));
  const d2 = founderConfigDigest(withOpening({ ...OPEN, special: 'Ask about our spring offer' }));
  const d3 = founderConfigDigest(withOpening({ ...OPEN, agent_name: 'Mia' }));
  const d4 = founderConfigDigest(withOpening({ ...OPEN, disclosure: 'We do not record calls.' }));
  assert.equal(new Set([d0, d1, d2, d3, d4]).size, 5, 'every change needs a new approval');
});

test('twiml: the greeting carries the notice, escaped, with no way to break out of the attribute', () => {
  const url = 'wss://calls.example.test/relay/abcdefghijklmnopqrstuvwxyz012345';
  assert.ok(twimlFor(url).includes(`welcomeGreeting="${DEFAULT_CONSENT_NOTICE}"`), 'the original TwiML is unchanged');
  const t = twimlFor(url, { business_name: 'Smith & Sons "Clean"', agent_name: 'Ava', special: "Ask about today's offer" });
  assert.ok(t.includes('Smith &amp; Sons &quot;Clean&quot;') && t.includes("today's offer"));
  assert.equal((t.match(/welcomeGreeting="/g) ?? []).length, 1);
  const value = /welcomeGreeting="([^"]*)"/.exec(t);
  assert.ok(value !== null && value[1].includes('&quot;Clean&quot;') && !value[1].includes('"'), 'the whole notice sits inside the attribute with no raw quote');
  assert.match(t, /welcomeGreetingInterruptible="none" \/>/);
});
