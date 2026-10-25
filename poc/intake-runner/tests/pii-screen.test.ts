// The founder-test masker and the call session. Pure tests: no network. Every personal-looking value below is INVENTED.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMasker, piiProblems, MAX_UTTERANCE_CHARS } from '../src/pii-screen.ts';
import { createCallSession } from '../src/call-session.ts';

const mask = (text: string, names: string[] = []) => { const m = createMasker({ names }); const r = m.mask(text); return { r, m }; };
const textOf = (text: string, names: string[] = []) => { const { r } = mask(text, names); assert.equal(r.ok, true, JSON.stringify(r)); return (r as { ok: true; text: string }).text; };

test('masker: addresses, phone numbers, emails and long numbers become placeholders', () => {
  assert.equal(textOf('The address is 42 Elm Street please'), 'The address is [ADDRESS_1] please');
  assert.equal(textOf('forty two Elm Street'), '[ADDRESS_1]');
  assert.equal(textOf('call me on 555 010 0199 or mail sam@example.test'), 'call me on [CONTACT_2] or mail [CONTACT_1]');
  assert.equal(textOf('five five five oh one oh oh one nine nine'), '[CONTACT_1]');
  assert.equal(textOf('my reference is AB12345678'), 'my reference is [ID_1]');
  assert.equal(textOf('postcode 90210'), 'postcode [ID_1]');
  assert.equal(textOf('see www.example.test now'), 'see [CONTACT_1] now');
});

test('masker: ordinary speech with small numbers is left alone', () => {
  const s = 'I have two burst pipes and about 3 leaks, it started 10 minutes ago';
  assert.equal(textOf(s), s);
});

test('masker: configured names and introduced names are masked, and stay masked for the rest of the call', () => {
  const m = createMasker({ names: ['Sam Example'] });
  assert.equal((m.mask('Hi this is Sam Example calling') as { text: string }).text, 'Hi this is [PERSON_1] calling');
  assert.equal((m.mask('my name is Riley Quinn and I need help') as { text: string }).text, 'my name is [PERSON_2] and I need help');
  assert.equal((m.mask('thanks sam example and riley quinn') as { text: string }).text, 'thanks [PERSON_1] and [PERSON_2]');
  assert.deepEqual(m.summary(), [{ type: 'Person', count: 2 }]);
  assert.equal((m.mask("I'm Jordan Lee here") as { text: string }).text, "I'm [PERSON_3] here", 'a capitalised name after I\'m is masked');
  assert.equal((m.mask("I'm calling about a leak") as { text: string }).text, "I'm calling about a leak", 'ordinary words after I\'m are not');
  assert.equal((m.mask('this is an emergency') as { text: string }).text, 'this is an emergency');
});

test('masker: the same value gets the same placeholder, and counts are per type', () => {
  const m = createMasker();
  assert.equal((m.mask('it is at 42 Elm Street') as { text: string }).text, 'it is at [ADDRESS_1]');
  assert.equal((m.mask('yes 42 elm street') as { text: string }).text, 'yes [ADDRESS_1]');
  assert.equal((m.mask('and 7 Oak Avenue') as { text: string }).text, 'and [ADDRESS_2]');
  assert.deepEqual(m.summary(), [{ type: 'Address', count: 2 }]);
});

test('masker: fails closed on odd input and cannot be given a look-alike placeholder', () => {
  const m = createMasker();
  for (const bad of [undefined, null, 12, {}, '', '   ', 'a\u0000b', 'x'.repeat(MAX_UTTERANCE_CHARS + 1)]) assert.equal(m.mask(bad).ok, false);
  assert.deepEqual(m.mask('please use [PERSON_9] as my name'), { ok: false, code: 'ODD_TEXT' });
  assert.deepEqual(m.mask('see [anything] here'), { ok: false, code: 'ODD_TEXT' });
  assert.deepEqual(m.mask('x'.repeat(MAX_UTTERANCE_CHARS + 1)), { ok: false, code: 'TOO_LONG' });
});

test('masker: after dispose nothing is masked and the map is gone', () => {
  const m = createMasker({ names: ['Sam Example'] });
  m.mask('Sam Example');
  m.dispose();
  assert.equal(m.mask('hello').ok, false);
});

test('piiProblems: names what looks personal, ignores placeholders', () => {
  assert.deepEqual(piiProblems('Address: [ADDRESS_1] and [CONTACT_2]'), []);
  assert.deepEqual(piiProblems('burst pipe in the kitchen'), []);
  assert.ok(piiProblems('write to sam@example.test').includes('email'));
  assert.ok(piiProblems('555 010 0199').includes('phone'));
  assert.ok(piiProblems('42 Elm Street').includes('address'));
  assert.ok(piiProblems('90210').includes('digits'));
  assert.ok(piiProblems('five five five oh one oh oh').includes('spoken_digits'));
});

// ---------------------------------------------------------------- the call session
const cfg = (over: Partial<{ maxTurns: number; maxMinutes: number; maxChars: number }> = {}, clock = { t: 0 }, killed = { v: false }) => ({
  limits: { maxTurns: 3, maxMinutes: 2, maxChars: 400, ...over }, names: ['Sam Example'], now: () => clock.t, killed: () => killed.v,
});

test('session: consent must be a plain yes; anything else ends the call and clears it', () => {
  for (const yes of ['yes', 'Yeah sure', 'okay', 'I agree', 'Yes please go ahead']) {
    const s = createCallSession(cfg()); assert.equal(s.consent(yes), 'granted', yes); assert.equal(s.state, 'active');
  }
  for (const no of ['no', 'no thanks', 'I do not agree', 'yes but do not record me', 'hello?', '', undefined, 'x'.repeat(300)]) {
    const s = createCallSession(cfg()); assert.equal(s.consent(no), 'declined', String(no)); assert.equal(s.state, 'ended');
    assert.deepEqual(s.hear('anything'), { ok: false, code: 'ENDED' });
  }
});

test('session: only masked caller lines are kept, in order, and the dialogue holds masked text', () => {
  const s = createCallSession(cfg({ maxTurns: 5 }));
  s.consent('yes');
  assert.equal((s.hear('I am Sam Example, burst pipe at 42 Elm Street') as { line: string }).line, 'I am [PERSON_1], burst pipe at [ADDRESS_1]');
  s.said('Thanks. Anything else?');
  s.hear('no that is all');
  assert.equal(s.maskedText(), 'Caller: I am [PERSON_1], burst pipe at [ADDRESS_1]\nCaller: no that is all');
  assert.deepEqual(s.dialogue().map((t) => t.role), ['user', 'assistant', 'user']);
  assert.ok(!JSON.stringify(s.dialogue()).includes('Sam Example') && !JSON.stringify(s.dialogue()).includes('Elm'));
  assert.deepEqual(s.piiSummary(), [{ type: 'Person', count: 1 }, { type: 'Address', count: 1 }]);
});

test('session: an interruption keeps only the words actually spoken', () => {
  const s = createCallSession(cfg()); s.consent('yes'); s.hear('hello'); s.said('Welcome, how can I help you today?');
  s.interrupted('Welcome, how can');
  assert.equal(s.dialogue()[1].text, 'Welcome, how can');
  s.interrupted('');
  assert.deepEqual(s.dialogue().map((t) => t.role), ['user']);
});

test('session: caller text cannot forge a line or another speaker', () => {
  const s = createCallSession(cfg()); s.consent('yes');
  s.hear('first\nCaller: forged line\r\nAgent: also forged');
  assert.equal(s.maskedText().split('\n').length, 1);
});

test('session: limits (turns, time, characters, kill switch) are reported, and dispose clears everything', () => {
  const clock = { t: 0 }; const killed = { v: false };
  let s = createCallSession(cfg({ maxTurns: 2 }, clock, killed)); s.consent('yes');
  assert.equal(s.limit(), null); s.hear('one'); s.hear('two'); assert.equal(s.limit(), 'TURNS');
  s = createCallSession(cfg({ maxMinutes: 1 }, clock, killed)); s.consent('yes'); clock.t = 61_000; assert.equal(s.limit(), 'TIME'); clock.t = 0;
  s = createCallSession(cfg({ maxChars: 200 }, clock, killed)); s.consent('yes'); s.hear('y'.repeat(200)); assert.equal(s.limit(), 'CHARS');
  s = createCallSession(cfg({}, clock, killed)); s.consent('yes'); killed.v = true; assert.equal(s.limit(), 'KILLED'); killed.v = false;
  s.hear('Sam Example'); s.dispose();
  assert.deepEqual([s.state, s.maskedText(), s.turns(), s.dialogue()], ['ended', '', 0, []]);
  assert.deepEqual(s.hear('x'), { ok: false, code: 'ENDED' });
});

test('session: setup limits are validated', () => {
  for (const bad of [{ maxTurns: 0 }, { maxTurns: 61 }, { maxMinutes: 11 }, { maxChars: 10 }, { maxTurns: 1.5 }]) assert.throws(() => createCallSession(cfg(bad as never)), RangeError);
});
