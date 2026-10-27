// The founder-test masker and the call session. Pure tests: no network. Every personal-looking value below is INVENTED.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMasker, piiProblems, spokenDigitCount, MAX_UTTERANCE_CHARS } from '../src/pii-screen.ts';
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

// ---------------------------------------------------------------- spoken personal data (how speech-to-text writes it)
/** Each phrase hides something an invented caller might say. After masking, none of the `secrets` may remain, or the utterance must be refused. */
const SPOKEN: Array<[string, string[]]> = [
  ['I live on Elm Street near the park', ['Elm']],
  ['we are at 12 Oak Lane', ['Oak', '12']],
  ['it is on Maple Avenue', ['Maple']],
  ['my email is sam at example dot com', ['sam at', 'example', 'dot com']],
  ['email is sam underscore jones at gmail', ['jones', 'gmail', 'underscore']],
  ['you can write to jo at work dot co dot uk', ['jo at', 'work dot', 'dot uk']],
  ['send it to pat at the office dot net', ['pat at', 'dot net']],
  ['the postcode is SW1A 1AA', ['SW1A', '1AA']],
  ['the postcode is sw1a 1aa', ['sw1a', '1aa']],
  ["it's M5V 2T6", ['M5V', '2T6']],
  ['Mrs Jones lives next door', ['Jones']],
  ['ask for Dr Patel please', ['Patel']],
  ['a plumber named bob came last week', ['bob']],
  ['the lady is called Priya Raman', ['Priya', 'Raman']],
  ['I am in Springfield Illinois', ['Springfield', 'Illinois']],
  ['we moved from Portland, Oregon', ['Portland', 'Oregon']],
  ['Hello, Sam Jones here', ['Sam', 'Jones']],
  ['my cell is five five five zero one nine nine', ['five five']],
  ['phone number is 555-0199 call after six', ['555-0199', '0199']],
  ['my number is two oh one', ['two oh one']],
  ['reach me on 5 5 5 0 1 0 0 1 9 9', ['5 5 5']],
  ['my address is the old mill house', ['old mill']],
  ['I live at the old mill', ['old mill']],
  ['we are located in Riverside Heights', ['Riverside', 'Heights']],
  ['reference AB12CD34EF', ['AB12CD34EF']],
  ['the account is 12345678', ['12345678']],
  ['PO box 77 please', ['77']],
  ['visit www dot example dot com', ['dot com']],
  ['it is http://example.test/a', ['example.test']],
  ['forty-two elm st', ['elm st', 'forty']],
];
test('spoken personal data: each phrase is masked or refused, never passed on as written', () => {
  for (const [text, secrets] of SPOKEN) {
    const m = createMasker({ names: [] });
    const r = m.mask(text);
    if (!r.ok) continue;                         // refusing is the safe answer to anything uncertain
    for (const s of secrets) assert.ok(!r.text.toLowerCase().includes(s.toLowerCase()), `${JSON.stringify(text)} -> ${JSON.stringify(r.text)} still has "${s}"`);
    assert.deepEqual(piiProblems(r.text), [], text);
    assert.ok(/\[(PERSON|ADDRESS|CONTACT|ID)_\d+\]/.test(r.text), `${text} -> ${r.text} should contain a placeholder`);
  }
});

test('spoken personal data: the result always passes the same screen the record store applies', () => {
  const noisy = [...SPOKEN.map(([s]) => s), 'I have a burst pipe in the kitchen', 'Sam Example, 42 Elm Street, 555 010 0199, sam@example.test'];
  for (const text of noisy) {
    const r = createMasker({ names: ['Sam Example'] }).mask(text);
    if (r.ok) assert.deepEqual(piiProblems(r.text), [], text);
  }
});

test('spoken personal data: ordinary speech about the job is left exactly as it was', () => {
  const plain = [
    'I have a burst pipe in the kitchen, it is flooding', 'the road is flooded', 'it started on Saturday morning', 'Thanks, that is all', 'Yes please come tomorrow',
    'water is coming through the ceiling', 'I need someone as soon as possible', 'it is about two feet of water', 'the tap has been dripping for 3 days', 'Hello',
    'Okay, and how much will it cost', 'No, there is nobody else here', 'it happened at about 10 in the morning', 'I tried to turn the water off at the stop tap',
  ];
  for (const text of plain) assert.deepEqual(createMasker().mask(text), { ok: true, text }, text);
});

test('spoken personal data: a street number said as separate digits is masked whole, with no digit left before the placeholder', () => {
  const spoken = [
    'It is 1 2 3 4 Oak Street', 'It is 1, 2, 3, 4 Oak Street', 'It is 12 34 Oak Street', 'The job is at 1 2 3 4 Oak Street in the morning',
    'Fence repair at 4 2 Cedar Road next week', 'The place is 5 5 5 Maple Avenue please', 'It is 1-2-3-4 Oak Street', 'I live at 1 2 3 4 Oak Street', 'My address is 1 2 3 4 Oak Street',
  ];
  for (const text of spoken) {
    const t = textOf(text);
    assert.equal(/\d/.test(t.replace(/\[[A-Z]+_\d+\]/g, '')), false, `a digit survived: ${t}`);
    assert.deepEqual(piiProblems(t), [], text);
  }
  assert.equal(textOf('It is 1 2 3 4 Oak Street'), 'It is [ADDRESS_1]');
  assert.equal(textOf('I have 2 leaks and the tap has dripped for 3 days'), 'I have 2 leaks and the tap has dripped for 3 days', 'small numbers elsewhere are untouched');
});

test('spoken personal data: digits read out on their own (a zip code, a street number, an id) are masked, whatever the separator', () => {
  const read: Array<[string, string]> = [
    ['It is at 1 5 9 5 1 in the valley', 'It is at [ID_1] in the valley'], ['The zip code is 9 1 3 6 4', 'The zip code is [ID_1]'],
    ['It is 1, 5, 9, 5, 1 near the school', 'It is [ID_1] near the school'], ['It is 1-5-9-5-1 near the school', 'It is [ID_1] near the school'],
    ['Reference 15 951 please', 'Reference [ID_1] please'], ['my code is 1 2 3 4 5 6', 'my code is [ID_1]'], ['Call it 12 34 5', 'Call it [ID_1]'],
  ];
  for (const [said, masked] of read) {
    assert.equal(textOf(said), masked, said);
    assert.deepEqual(piiProblems(masked), [], masked);
  }
  assert.equal(textOf('My address is 1 5 9 5 1'), 'My address is [ADDRESS_1]', 'an address cue still makes it an address');
  assert.equal(textOf('The address is 1 5 9 5 1 Oak Street'), 'The address is [ADDRESS_1]');
});

test('spoken personal data: numbers that are not identifiers are left alone', () => {
  const plain = [
    'We need a cleaning service for 4 rooms from 9 AM to 1 PM on October 27', 'between 2 and 3 in the afternoon', 'it has been 3 days', 'I have 2 leaks and 1 flood',
    'at 9 30 in the morning', 'about 10 12 people', 'October 27th at 4', 'room 2 and room 3', 'one two three',
  ];
  for (const text of plain) assert.deepEqual(createMasker().mask(text), { ok: true, text }, text);
});

test('piiProblems: digits read out one at a time, or in groups, are named even when nothing masked them', () => {
  for (const bad of ['It is 1 5 9 5 1', 'zip 9 1 3 6 4', 'It is 1, 5, 9, 5, 1', 'Reference 15 951', 'ok 12 34 5']) assert.deepEqual(piiProblems(bad), ['digits'], bad);
  for (const ok of ['4 rooms from 9 to 1', 'it has been 3 days', 'at 9 30', 'about 10 12', 'It is [ID_1]']) assert.deepEqual(piiProblems(ok), [], ok);
});

test('piiProblems: digits left standing right before an address placeholder are named as an address problem; a placeholder alone is not', () => {
  for (const bad of ['It is 1 2 3 [ADDRESS_1]', 'It is 12 [ADDRESS_1]', 'It is 1, 2, 3, [ADDRESS_1]', '4 2[ADDRESS_3]']) assert.deepEqual(piiProblems(bad), ['address'], bad);
  for (const ok of ['It is [ADDRESS_1]', 'I have 2 jobs, one at [ADDRESS_1]', '[ADDRESS_2][ADDRESS_1]', 'about 3 days, then [ADDRESS_1]']) assert.deepEqual(piiProblems(ok), [], ok);
});

test('spoken personal data: a capitalised word in the middle of a sentence is treated as a name or place, a lone sentence-start word is not', () => {
  const m = createMasker();
  assert.equal((m.mask('Please send someone to Riverside') as { text: string }).text, 'Please send someone to [PERSON_1]');
  assert.equal((m.mask('Riverside is the area') as { text: string }).text, '[PERSON_1] is the area', 'the same word is recognised again, even at a sentence start');
  assert.equal((m.mask('Tomorrow is fine, and Saturday too') as { text: string }).text, 'Tomorrow is fine, and Saturday too');
  assert.equal((m.mask('Water everywhere') as { text: string }).text, 'Water everywhere');
  assert.equal((m.mask('Maple Grove is the estate') as { text: string }).text, '[PERSON_2] is the estate', 'a capitalised pair at the start is a name');
});

test('spoken personal data: a street name needs a name before it, so "the road" is not an address', () => {
  assert.equal((createMasker().mask('the road is flooded') as { text: string }).text, 'the road is flooded');
  assert.equal((createMasker().mask('on the street outside') as { text: string }).text, 'on the street outside');
  assert.equal((createMasker().mask('Elm Street') as { text: string }).text, '[ADDRESS_1]');
  assert.equal((createMasker().mask('it is on Elm Street, near us') as { text: string }).text, 'it is on [ADDRESS_1], near us');
});

test('spoken personal data: the screen the record store uses also recognises these forms', () => {
  for (const [text, code] of [['sam at example dot com', 'spoken_email'], ['visit dot com', 'spoken_email'], ['write to me at gmail', 'spoken_email'], ['SW1A 1AA', 'postcode'], ['M5V 2T6', 'postcode'],
    ['Elm Street', 'address'], ['near Oak Lane', 'address']] as const) {
    assert.ok(piiProblems(text).includes(code), `${text} -> ${piiProblems(text).join(',')}`);
  }
  for (const text of ['Emergency leak', 'Job description', 'Preferred date', 'burst pipe', 'the road', '[ADDRESS_1]', 'Address']) assert.deepEqual(piiProblems(text), [], text);
});

test('spoken personal data: a name listed in the config is masked in any case and in any position, and a value masked once stays masked', () => {
  const m = createMasker({ names: ['Priya Raman'] });
  assert.equal((m.mask('this is priya raman speaking') as { text: string }).text, 'this is [PERSON_1] speaking');
  assert.equal((m.mask('PRIYA RAMAN is the owner') as { text: string }).text, '[PERSON_1] is the owner');
  assert.equal((m.mask('tell Priya  Raman thanks') as { text: string }).text, 'tell [PERSON_1] thanks');
  assert.equal((m.mask('I live on Elm Street') as { text: string }).text, 'I live on [ADDRESS_1]');
  assert.equal((m.mask('yes elm street') as { text: string }).text, 'yes [ADDRESS_1]');
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

test('session: the answer to a read-back is yes only for a short plain yes; any refusal or doubt wins; anything else is unclear', () => {
  const s = createCallSession(cfg());
  const yes = ['yes', 'Yes please', 'yeah', 'yep', 'correct', 'that is right', "that's correct", 'right', 'okay', 'absolutely', 'yes that is right'];
  const no = ['no', 'No.', 'nope', 'that is not right', 'wrong', 'incorrect', 'yes but it is different', 'actually it is tomorrow', "that isn't it", 'yes and no', 'I do not think so'];
  const unclear = ['', 'banana', 'hmm what was that', 'maybe', 'pardon', 'yes ' + 'and then I would like to say a great many other things about the job '.repeat(3), 'what', 'the pipe is in the kitchen'];
  for (const t of yes) assert.equal(s.answer(t), 'yes', t);
  for (const t of no) assert.equal(s.answer(t), 'no', t);
  for (const t of unclear) assert.notEqual(s.answer(t), 'yes', t);
  for (const t of ['banana', 'hmm what was that', 'maybe', 'pardon', '']) assert.equal(s.answer(t), 'unclear', t);
  for (const t of [undefined, null, 12, {}, ['yes']]) assert.equal(s.answer(t as never), 'unclear');
  assert.equal(s.answer('x'.repeat(401)), 'unclear');
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

// ---------------------------------------------------------------- spoken repeats: "double zero", "triple five" (invented numbers only)
test('masker: a number said with "double" or "triple" is masked whole, with nothing of it left behind', () => {
  assert.equal(textOf('call me at five five five oh one double zero one nine nine'), 'call me at [CONTACT_1]');
  assert.equal(textOf('five five five oh one double zero one nine nine'), '[CONTACT_1]');
  assert.equal(textOf('triple five zero one zero zero one nine nine'), '[CONTACT_1]');
  assert.equal(textOf('my number is treble five oh one oh oh one nine nine'), 'my number is [CONTACT_1]');
  assert.equal(textOf('five-five-five-oh-one-double-zero-one-nine-nine'), '[CONTACT_1]');
  assert.equal(textOf('five five five, oh one, double zero, one nine nine'), '[CONTACT_1]');
  assert.equal(textOf('Double Five Oh One Double Zero One Nine Nine', ['Sam Example']).includes('Double'), false);
  assert.equal(textOf('double nine zero one two'), '[CONTACT_1]', 'five digits in all, said as four words');
  assert.equal(textOf('call me at five five five oh one double zero one nine nine or on 555 010 0198'), 'call me at [CONTACT_1] or on [CONTACT_2]');
});

test('masker: "double" and "triple" in ordinary speech, and short repeats, are left alone', () => {
  for (const s of ['please double check the oven', 'a triple layer cake', 'it is a double bed and a triple dresser', 'the double doors are stuck', 'double double toil and trouble',
    'I want it done in two or three days', 'double zero seven', 'double five', 'triple nine', 'I have two double beds and one single', 'the oven is double wide']) {
    assert.equal(textOf(s), s, s);
  }
});

test('masker: spokenDigitCount counts repeats as their digits, and piiProblems sees a repeated-digit number but not ordinary speech', () => {
  assert.equal(spokenDigitCount('five five five oh one double zero one nine nine'), 10);
  assert.equal(spokenDigitCount('triple five'), 3);
  assert.equal(spokenDigitCount('treble five'), 3);
  assert.equal(spokenDigitCount('double Zero'), 2);
  assert.ok(piiProblems('five five five oh one double zero one nine nine').includes('spoken_digits'));
  assert.ok(piiProblems('triple five zero one zero zero one nine nine').includes('spoken_digits'));
  assert.deepEqual(piiProblems('please double check the oven and the triple layer cake'), []);
  assert.deepEqual(piiProblems('double zero seven'), []);
});

test('masker: the stored utterance never keeps a repeated-digit number, and the raw number is available to the contact capture only', () => {
  const m = createMasker({ names: [] });
  const r = m.mask('you can reach me on five five five oh one double zero one nine nine');
  assert.deepEqual(r, { ok: true, text: 'you can reach me on [CONTACT_1]' });
  assert.deepEqual(m.reveal().map((x) => [x.type, x.raw]), [['Contact detail', 'five five five oh one double zero one nine nine']]);
  m.dispose();
  assert.deepEqual(m.reveal(), []);
});

// ---------------------------------------------------------------- numbers that mix spoken digits, written digits and repeat words (invented numbers only)
test('masker: a number that mixes spoken digits, written digits and repeat words is masked whole', () => {
  const whole: Array<[string, string]> = [
    ['five five five 0 1 0 oh one nine nine', '[CONTACT_1]'],
    ['my number is five five five 0 1 0 0 1 9 9', 'my number is [CONTACT_1]'],
    ['5 5 5 zero one zero zero one nine nine', '[CONTACT_1]'],
    ['five five five 0 1 0 double 0 1 9 9', '[CONTACT_1]'],
    ['5 5 5 0 1 double 0 1 9 9', '[CONTACT_1]'],
    ['call me at 555 oh one oh oh one nine nine', 'call me at [CONTACT_1]'],
    ['reach me on 555-010 oh one nine nine', 'reach me on [CONTACT_1]'],
    ['my number is triple 5 0 1 0 0 1 9 9', 'my number is [CONTACT_1]'],
    ['my number is 555 010 double nine nine', 'my number is [CONTACT_1]'],
    ['the zip is seven 6 four three three', 'the zip is [CONTACT_1]'],
    ['five-five-five-0-1-0-oh-one-nine-nine', '[CONTACT_1]'],
    ['five, five, five, 0, 1, 0, oh, one, nine, nine', '[CONTACT_1]'],
    ['it is five five five 0 1 0 oh one nine nine and I live at 42 Elm Street', 'it is [CONTACT_1] and I live at [ADDRESS_1]'],
    ['call me on five five five 0 1 0 oh one nine nine or on 555 010 0198', 'call me on [CONTACT_1] or on [CONTACT_2]'],
  ];
  for (const [raw, masked] of whole) assert.equal(textOf(raw), masked, raw);
});

test('masker: any ten-digit number built from spoken words, written digits and repeat words is masked whole, in every spacing', () => {
  const words = ['zero', 'oh', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  let seed = 3; const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const seps = [' ', ', ', '-', ' - '];
  let mixed = 0;
  for (let k = 0; k < 300; k++) {
    const sep = seps[Math.floor(rnd() * seps.length)];
    const parts: string[] = []; let digits = 0; let usedWord = false; let usedNumeral = false;
    while (digits < 10) {
      const d = Math.floor(rnd() * 10); const style = rnd();
      if (style < 0.4 && d !== 0) { parts.push(words[d + 1]); usedWord = true; }
      else if (style < 0.5) { parts.push(d === 0 ? 'oh' : words[d + 1]); usedWord = true; }
      else if (style < 0.6 && digits <= 8) { parts.push((rnd() < 0.5 ? 'double ' : 'triple ') + (rnd() < 0.5 ? String(d) : (d === 0 ? 'zero' : words[d + 1]))); digits += (parts[parts.length - 1].startsWith('double') ? 1 : 2); usedWord = true; }
      else { parts.push(String(d)); usedNumeral = true; }
      digits++;
    }
    if (!usedWord) continue;   // digits written alone have their own rules (they become an identifier, not a contact detail)
    if (usedNumeral) mixed++;
    const lead = ['', 'call me on ', 'reach me at '][k % 3]; const tail = ['', ' please'][k % 2];
    const raw = lead + parts.join(sep) + tail;
    const { r } = mask(raw);
    if (!r.ok) continue;   // refusing the utterance is also safe: it never reaches a model
    assert.equal(r.text, lead + '[CONTACT_1]' + tail, raw);
  }
  assert.ok(mixed > 100, 'the sweep really did mix styles: ' + mixed);
});

test('masker: fail-closed for mixed numbers, an utterance that still looks like a number is refused, and the check sees them', () => {
  for (const raw of ['five five five 0 1 0 oh one nine nine', '5 5 5 0 1 double 0 1 9 9', 'seven 6 four three three', 'triple 5 0 1 0 0 1 9 9']) {
    assert.ok(piiProblems(raw).includes('spoken_digits'), raw);
    assert.ok(!piiProblems(textOf(raw)).includes('spoken_digits'), 'the masked text no longer looks like a number');
  }
  assert.deepEqual(piiProblems('a three bedroom 2 bath house, every two weeks'), []);
  // A number the masker cannot mask cleanly (here it runs into the word "street") is refused rather than passed on with digits in it.
  for (const raw of ['my number is 3. 7. one. six. three. 4. 4. 1 street', 'the zip is 0. zero. 1. 6. zero. three. 7. nine street']) {
    const { r } = mask(raw);
    assert.deepEqual(r, { ok: false, code: 'RESIDUAL' }, raw);
  }
  // A caller cannot forge a placeholder to hide digits behind.
  assert.deepEqual(mask('five five [CONTACT_1] 0 1 nine nine').r, { ok: false, code: 'ODD_TEXT' });
});

test('masker: ordinary speech with small numbers beside number words is left exactly as said', () => {
  for (const s of ['a three bedroom 2 bath house', 'every two weeks starting June 5', 'about 1800 square feet with two bedrooms', 'it is a one bedroom with 2 bathrooms', 'around 3 or 4 rooms',
    'we have 2 dogs and one cat', 'between 9 and 5', 'two 20 minute visits', 'I have 3 5 gallon buckets', 'we are 4 people and 2 kids', 'one 12 foot ladder', 'ten 15 minute breaks',
    'two bedrooms and 2 baths please', 'about 2 or 3 bedrooms, 1 or 2 baths', 'I need it by the 15th', 'on the 3rd and the 4th', 'from 8 to 10 in the morning', 'three 4 and a half', 'two or 3 days',
    'a double bed, 2 bathrooms and a triple dresser']) {
    assert.equal(textOf(s), s, s);
  }
});

test('masker: the raw mixed number is available to the contact capture only, in the order it was said, and is gone after dispose', () => {
  const m = createMasker({ names: [] });
  assert.deepEqual(m.mask('you can reach me on five five five 0 1 0 oh one nine nine'), { ok: true, text: 'you can reach me on [CONTACT_1]' });
  assert.deepEqual(m.reveal().map((x) => [x.type, x.raw]), [['Contact detail', 'five five five 0 1 0 oh one nine nine']]);
  m.dispose();
  assert.deepEqual(m.reveal(), []);
});
