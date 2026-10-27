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
