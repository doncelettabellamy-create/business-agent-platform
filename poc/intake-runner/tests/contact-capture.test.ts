// contact-capture.ts and the session/masker methods behind it. Invented people only; the raw values appear here, in the test, and nowhere else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contactMissing, CONTACT_FIELDS, extractContact, phoneDigits, spokenDigits } from '../src/contact-capture.ts';
import { createMasker } from '../src/pii-screen.ts';
import { createCallSession } from '../src/call-session.ts';

const session = () => createCallSession({ limits: { maxTurns: 30, maxMinutes: 8, maxChars: 4000 }, names: ['Sam Example'], now: () => 0, killed: () => false });

test('phoneDigits: written and spoken numbers become digits; short numbers, e-mail and words alone are not a usable phone', () => {
  assert.equal(phoneDigits('555 010 0123'), '5550100123');
  assert.equal(phoneDigits('(555) 010-0123'), '5550100123');
  assert.equal(phoneDigits('+1 555 010 0123'), '15550100123');
  assert.equal(phoneDigits('five five five oh one zero oh one two three'), '5550100123');
  assert.equal(phoneDigits('555 0100'), undefined, 'seven digits is not a callback number');
  assert.equal(phoneDigits('555 010 0123 4567 8901'), undefined, 'more than fifteen digits');
  assert.equal(phoneDigits('priya at example dot com'), undefined);
  assert.equal(phoneDigits('priya@example.com'), undefined);
  assert.equal(phoneDigits('call me'), undefined);
  assert.equal(phoneDigits(7 as never), undefined);
  assert.equal(spokenDigits('5550100123'), '5 5 5 0 1 0 0 1 2 3');
});

test('extractContact: the first names, the last usable phone and the first address pieces; missing items are named in a fixed order', () => {
  const t = (type: any, raw: string, n: number) => ({ type, token: `[X_${n}]`, raw });
  const all = extractContact([t('Person', 'Priya', 1), t('Person', 'Raman', 2), t('Person', 'Third', 3), t('Contact detail', '555 010 0123', 1), t('Contact detail', 'priya at example dot com', 2),
    t('Contact detail', '555 010 0199', 3), t('Address', '42 Elm Street', 1)]);
  assert.deepEqual(all, { name: 'Priya Raman', phone: '5550100199', address: '42 Elm Street' });
  assert.deepEqual(contactMissing(all), []);
  assert.deepEqual(contactMissing({}), [CONTACT_FIELDS.name, CONTACT_FIELDS.phone, CONTACT_FIELDS.address]);
  assert.deepEqual(contactMissing(extractContact([t('Contact detail', '555 0100', 1)])), [CONTACT_FIELDS.name, CONTACT_FIELDS.phone, CONTACT_FIELDS.address], 'an unusable number does not count');
  assert.deepEqual(extractContact([t('Identifier', 'SW1A 1AA', 1)]), {}, 'an identifier is none of the three');
  for (const n of Object.values(CONTACT_FIELDS)) assert.ok(/^[A-Za-z ]{1,80}$/.test(n), 'fixed names that can be given to the model');
});

test('masker.reveal: the raw values behind the placeholders, in order, and nothing after dispose', () => {
  const m = createMasker({ names: ['Sam Example'] });
  const a = m.mask('My name is Priya Raman and my phone number is 555 010 0123');
  assert.ok(a.ok);
  if (a.ok) assert.ok(!/Priya|Raman|555/.test(a.text), a.text);
  const r = m.reveal();
  assert.ok(r.some((x) => x.type === 'Person' && /Priya/.test(x.raw)) && r.some((x) => x.type === 'Contact detail' && phoneDigits(x.raw) === '5550100123'));
  for (const x of r) assert.match(x.token, /^\[(?:PERSON|ADDRESS|CONTACT|ID)_\d+\]$/);
  r[0].raw = 'changed';
  assert.notEqual(m.reveal()[0].raw, 'changed', 'a copy is returned');
  m.dispose();
  assert.deepEqual(m.reveal(), []);
});

test('session: contactMissing names what is not yet usable, revealContact gives all three or nothing, and dispose wipes them', () => {
  const s = session();
  assert.equal(s.consent('yes'), 'granted');
  assert.deepEqual(s.contactMissing(), [CONTACT_FIELDS.name, CONTACT_FIELDS.phone, CONTACT_FIELDS.address]);
  assert.equal(s.revealContact(), undefined);
  assert.ok(s.hear('My name is Priya Raman').ok);
  assert.deepEqual(s.contactMissing(), [CONTACT_FIELDS.phone, CONTACT_FIELDS.address]);
  assert.ok(s.hear('You can call me on 555 010 0123').ok);
  assert.equal(s.revealContact(), undefined, 'two of three is nothing');
  assert.ok(s.hear('The address is 42 Elm Street').ok);
  assert.deepEqual(s.contactMissing(), []);
  const c = s.revealContact();
  assert.ok(c !== undefined && c.phone === '5550100123' && /Priya/.test(c.name) && /Elm/.test(c.address));
  assert.ok(!/Priya|Raman|555|Elm/.test(s.maskedText()), 'the masked text the models see has none of it');
  s.dispose();
  assert.equal(s.revealContact(), undefined);
  assert.deepEqual(s.contactMissing(), [CONTACT_FIELDS.name, CONTACT_FIELDS.phone, CONTACT_FIELDS.address]);
});

test('session: a correction replaces the callback number (the last usable one wins)', () => {
  const s = session(); s.consent('yes');
  s.hear('My name is Priya Raman'); s.hear('The address is 42 Elm Street'); s.hear('My number is 555 010 0123'); s.hear('Sorry, my phone number is 555 010 0188');
  assert.equal(s.revealContact()?.phone, '5550100188');
});

test('masker.supersede: addresses set aside no longer count, a later one replaces them, other types are untouched, and dispose clears it all', () => {
  const m = createMasker({ names: ['Sam Example'] });
  m.mask('My name is Priya Raman and the address is 42 Elm Street'); m.mask('You can call me on 555 010 0123');
  const before = m.reveal();
  assert.ok(before.some((x) => x.type === 'Address') && before.some((x) => x.type === 'Person') && before.some((x) => x.type === 'Contact detail'));
  m.supersede('Address');
  const after = m.reveal();
  assert.ok(!after.some((x) => x.type === 'Address'), 'the old address is gone');
  assert.equal(after.filter((x) => x.type !== 'Address').length, before.filter((x) => x.type !== 'Address').length, 'the name and number are untouched');
  m.mask('The address is 77 Oak Lane');
  const now = m.reveal().filter((x) => x.type === 'Address');
  assert.equal(now.length, 1);
  assert.ok(/Oak/.test(now[0].raw) && !/Elm/.test(JSON.stringify(m.reveal())), 'only the corrected address remains');
  m.dispose();
  assert.deepEqual(m.reveal(), []);
});

test('session: forgetAddress makes the address missing again until a corrected one is given; revealContactParts shows what is usable', () => {
  const s = session(); s.consent('yes');
  s.hear('My name is Priya Raman'); s.hear('You can call me on 555 010 0123'); s.hear('The address is 42 Elm Street');
  assert.ok(/Elm/.test(s.revealContactParts().address ?? ''));
  s.forgetAddress();
  assert.deepEqual(s.contactMissing(), [CONTACT_FIELDS.address]);
  assert.equal(s.revealContact(), undefined, 'a contact without its address is not complete');
  const parts = s.revealContactParts();
  assert.deepEqual([parts.address, parts.phone, /Priya/.test(parts.name ?? '')], [undefined, '5550100123', true]);
  s.hear('Sorry, the address is 77 Oak Lane');
  assert.ok(/Oak/.test(s.revealContactParts().address ?? '') && !/Elm/.test(JSON.stringify(s.revealContactParts())));
  assert.deepEqual(s.contactMissing(), []);
  s.dispose();
  assert.deepEqual(s.revealContactParts(), {});
});

test('phoneDigits: "double" and "triple" repeat the digit that follows them, and only that one', () => {
  assert.equal(phoneDigits('five five five oh one double zero one nine nine'), '5550100199');
  assert.equal(phoneDigits('triple five zero one zero zero one nine nine'), '5550100199');
  assert.equal(phoneDigits('treble five oh one oh oh one nine nine'), '5550100199');
  assert.equal(phoneDigits('555 01 double 0 199'), '5550100199');
  assert.equal(phoneDigits('Five Five Five Oh One Double Zero One Nine Nine'), '5550100199');
  assert.equal(phoneDigits('five five five oh one double check one nine nine'), undefined, 'a repeat word before a non-digit repeats nothing and the number is too short');
  assert.equal(phoneDigits('double 10 555 010 0199'), '105550100199', 'a repeat word before a multi-digit group is ignored');
  assert.equal(phoneDigits('double'), undefined);
});

test('session: a callback number said with "double zero" is masked, kept for the callback, and read back as ten digits', () => {
  const s = session();
  assert.equal(s.consent('yes'), 'granted');
  const a = s.hear('my name is Sam Example'); const b = s.hear('call me on five five five oh one double zero one nine nine'); const c = s.hear('I live at 42 Elm Street');
  assert.deepEqual([a.ok, b.ok, c.ok], [true, true, true]);
  assert.ok(b.ok && b.line === 'call me on [CONTACT_1]');
  assert.deepEqual(s.contactMissing(), []);
  const contact = s.revealContact();
  assert.equal(contact?.phone, '5550100199');
  assert.equal(spokenDigits(contact?.phone ?? ''), '5 5 5 0 1 0 0 1 9 9');
  assert.ok(!s.maskedText().includes('double') && !s.maskedText().includes('nine'));
  s.dispose();
});

test('phoneDigits: numbers that mix spoken words, written digits and repeat words give the same ten digits', () => {
  for (const raw of ['five five five 0 1 0 oh one nine nine', '5 5 5 zero one zero zero one nine nine', 'five five five 0 1 double 0 1 9 9', '5 5 5 0 1 double 0 1 9 9', 'call 555 oh one oh oh one nine nine',
    '555-010 oh one nine nine', 'triple 5 0 1 0 0 1 9 9', '555 010 0 1 double nine', 'five, five, five, 0, 1, 0, oh, one, nine, nine', 'five-five-five-0-1-0-oh-one-nine-nine', 'five-5-5-0-1-double-0-1-9-9']) {
    assert.equal(phoneDigits(raw), '5550100199', raw);
  }
  assert.equal(phoneDigits('five five five 0 1 0 oh one'), undefined, 'eight digits is not a callback number');
  assert.equal(phoneDigits('seven 6 four three three'), undefined, 'five digits is a zip code, not a callback number');
});

test('session: a callback number that mixes spoken digits, numerals and repeat words is masked, captured, read back and replaced by a correction', () => {
  const s = session();
  assert.equal(s.consent('yes'), 'granted');
  const lines = ['my name is Sam Example', 'you can call me on five five five 0 1 double 0 1 9 9', 'I live at 42 Elm Street'].map((x) => s.hear(x));
  assert.deepEqual(lines.map((x) => x.ok), [true, true, true]);
  assert.ok(lines[1].ok && lines[1].line === 'you can call me on [CONTACT_1]');
  assert.deepEqual(s.contactMissing(), []);
  assert.equal(s.revealContact()?.phone, '5550100199');
  assert.equal(spokenDigits(s.revealContact()?.phone ?? ''), '5 5 5 0 1 0 0 1 9 9');
  assert.ok(!/\d|five|nine|double/i.test(s.maskedText().replace(/\[[A-Z]+_\d+\]/g, '')), 'no digit of the number is left in what is kept');
  assert.ok(s.hear('sorry it is 5 5 5 0 1 0 0 1 two three').ok);
  assert.equal(s.revealContact()?.phone, '5550100123', 'the later number wins');
  s.dispose();
  assert.equal(s.revealContact(), undefined);
});

test('session: a mixed number that is too short to be a callback number leaves the phone missing, and nothing of it is kept', () => {
  const s = session();
  assert.equal(s.consent('yes'), 'granted');
  assert.ok(s.hear('my name is Sam Example').ok && s.hear('I live at 42 Elm Street').ok);
  const h = s.hear('the number is five five five 0 1 0 oh one');
  assert.ok(h.ok && h.line === 'the number is [CONTACT_1]', 'it is masked all the same');
  assert.ok(s.contactMissing().includes(CONTACT_FIELDS.phone));
  assert.equal(s.revealContact(), undefined);
});

test('phoneDigits: a spoken "oh" that ends a run of ten digits is the interjection, not an eleventh digit; a written zero or a real leading digit is kept', () => {
  assert.equal(phoneDigits('five five five 0 1 0 0 1 9 9 oh'), '5550100199');
  assert.equal(phoneDigits('five five five oh one zero zero one nine nine oh'), '5550100199');
  assert.equal(phoneDigits('five five five 0 1 0 0 1 9 9 0'), '55501001990', 'a written zero is a digit');
  assert.equal(phoneDigits('one five five five 0 1 0 0 1 9 9'), '15550100199', 'a leading 1 is a country code and stays');
  assert.equal(phoneDigits('one five five five 0 1 0 0 1 9 oh'), '15550100190', 'an 11-digit number starting with 1 keeps its last digit');
  assert.equal(phoneDigits('oh seven seven oh oh nine oh oh one two oh'), '07700900120', 'a number with a leading zero keeps its last digit');
});

test('session: "oh well" after a spoken number does not corrupt the callback number', () => {
  const s = session();
  assert.equal(s.consent('yes'), 'granted');
  assert.ok(s.hear('my name is Sam Example').ok && s.hear('I live at 42 Elm Street').ok);
  const h = s.hear('my number is five five five 0 1 0 0 1 9 9 oh well');
  assert.ok(h.ok && h.line === 'my number is [CONTACT_1] well', h.ok ? h.line : h.code);
  assert.equal(s.revealContact()?.phone, '5550100199');
});
