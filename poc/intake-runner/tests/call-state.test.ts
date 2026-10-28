// call-state.ts and the session capture behind it: server-validated current-call contact state, kept apart from privacy masking. Invented people only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContactState, runContactTool, nameFrom, addressFrom, addressPiece, CONTACT_TOOL_NAMES, CONTACT_TOOL_DEFINITIONS, MAX_CLARIFICATIONS } from '../src/call-state.ts';
import { createCallSession } from '../src/call-session.ts';
import { CONTACT_FIELDS } from '../src/contact-capture.ts';
import { renderStatus, renderDirective, fallbackText, DIALOGUE_INSTRUCTION } from '../src/dialogue-model.ts';
import { createMasker } from '../src/pii-screen.ts';

const session = () => { const s = createCallSession({ limits: { maxTurns: 30, maxMinutes: 8, maxChars: 4000 }, names: [], now: () => 0, killed: () => false }); assert.equal(s.consent('yes'), 'granted'); return s; };

test('limits: clarification is bounded at two', () => { assert.equal(MAX_CLARIFICATIONS, 2); });

test('name: a bare, lower-case or single name is taken when it is the answer to the name question; non-names are not', () => {
  assert.equal(nameFrom('priya raman'), 'Priya Raman');
  assert.equal(nameFrom('Priya'), 'Priya');
  assert.equal(nameFrom("it's Priya Raman, thanks"), 'Priya Raman');
  assert.equal(nameFrom('my name is Priya and I need a cleaning'), 'Priya');
  assert.equal(nameFrom("O'Neil-Smith"), "O'Neil-Smith");
  for (const bad of ['yes', 'I do not know', 'I would rather not say', '555 010 0123', 'what', 'three bedrooms and two baths today', '', 'x']) assert.equal(nameFrom(bad), undefined, bad);
});

test('address: needs a street number and another word, or a PO box; never a postal check', () => {
  assert.equal(addressFrom('Maple Grove Apartments unit 4'), 'Maple Grove Apartments unit 4');
  assert.equal(addressFrom('my address is 42 elm street, you can reach me on 555 010 0123'), '42 elm street');
  assert.equal(addressFrom('forty two Oak Lane'), 'forty two Oak Lane');
  assert.equal(addressFrom('PO Box 12'), 'PO Box 12');
  for (const bad of ['yes', 'Maple Grove', 'I do not want to say', '42', 'it is a house']) assert.equal(addressFrom(bad), undefined, bad);
});

test('REGRESSION repeated address: the answer to the address question counts although no masking rule would recognise it, and it never reaches a model', () => {
  const s = session();
  const h = s.hear('Maple Grove Apartments unit 4', 'address');
  assert.ok(h.ok && h.line === '[ADDRESS_1]', JSON.stringify(h));
  assert.equal(s.contactStatus().captured.includes(CONTACT_FIELDS.address), true);
  assert.deepEqual(s.contactMissing().includes(CONTACT_FIELDS.address), false);
  assert.ok(!/Maple/.test(s.maskedText() + JSON.stringify(s.dialogue())));
  assert.equal(s.revealContactParts().address, 'Maple Grove Apartments unit 4');
});

test('REGRESSION address answer that cannot be used stays missing and is reported unclear (so the handler can count a clarification)', () => {
  const s = session();
  const h = s.hear('I would rather talk about the price', 'address');
  assert.ok(h.ok && h.contact?.[0].outcome === 'unclear');
  assert.ok(s.contactMissing().includes(CONTACT_FIELDS.address));
});

test('REGRESSION name correction: a later explicit name replaces the earlier one everywhere, and the old one is no longer spoken or stored', () => {
  const s = session();
  s.hear('priya raman', 'name');
  assert.equal(s.revealContactParts().name, 'Priya Raman');
  const h = s.hear('no, the name is Jon Smith', undefined, true);
  assert.ok(h.ok && h.contact?.[0].field === 'name' && h.contact[0].outcome === 'captured');
  assert.equal(s.revealContactParts().name, 'Jon Smith');
  assert.ok(!/priya|raman|jon|smith/i.test(s.maskedText()), 'neither name is in what a model reads');
});

test('REGRESSION split phone number: pieces are joined, progress is not a failure, a complete restatement replaces, too many digits start over', () => {
  const s = session();
  const a = s.hear('five five five', 'phone'); assert.ok(a.ok && a.contact?.[0].outcome === 'partial');
  assert.ok(s.phonePending() && s.contactMissing().includes(CONTACT_FIELDS.phone));
  const b = s.hear('one two three', 'phone'); assert.ok(b.ok && b.contact?.[0].outcome === 'partial');
  const c = s.hear('four five six seven', 'phone'); assert.ok(c.ok && c.contact?.[0].outcome === 'captured');
  assert.equal(s.revealContactParts().phone, '5551234567');
  assert.equal(s.phonePending(), false);
  assert.ok(!/five|one|two|three|four|six|seven|\d/i.test(s.maskedText().replace(/\[[A-Z]+_\d+\]/g, '')), 'no digit is left in what a model reads');
  const d = s.hear('actually it is 555 010 0199', 'phone', true); assert.ok(d.ok);
  assert.equal(s.revealContactParts().phone, '5550100199');
  const t = createContactState();
  t.collect('phone', '1 2 3 4 5 6 7 8'); assert.equal(t.collect('phone', '9 9 9 9 9 9 9 9 9').outcome, 'unclear');
  assert.equal(t.pendingPhone(), false);
});

test('a number said in an odd way that the masker alone would refuse is kept by the server and shown to a model only as a placeholder', () => {
  const s = session();
  const h = s.hear('five five five oh one zero oh one two three', 'phone');
  assert.ok(h.ok && /^\[CONTACT_\d\]$/.test(h.line), JSON.stringify(h));
  assert.equal(s.revealContactParts().phone, '5550100123');
});

test('the masker learns a captured value, so a later mention is masked even without a rule (a lower-case name)', () => {
  const m = createMasker();
  m.learn('Person', 'priya raman');
  const r = m.mask('tell priya that raman is here');
  assert.ok(r.ok && r.text === 'tell [PERSON_1] that [PERSON_1] is here', JSON.stringify(r));
  m.dispose(); m.learn('Person', 'late'); assert.deepEqual(m.reveal(), []);
});

test('the tool surface: five contact tools only; no pricing, booking or hand-off tool; unknown tools and bad arguments are refused; results hold labels, never values', () => {
  assert.deepEqual([...CONTACT_TOOL_NAMES], ['collect_name', 'collect_phone', 'collect_address', 'correct_contact', 'call_status']);
  assert.deepEqual(CONTACT_TOOL_DEFINITIONS.map((d) => d.name), [...CONTACT_TOOL_NAMES]);
  assert.ok(!CONTACT_TOOL_DEFINITIONS.some((d) => /price|quote|book|slot|calendar|handoff|hand_off|approve/i.test(d.name)));
  const st = createContactState();
  for (const name of ['get_price', 'book_slot', 'offer_slots', 'handoff', 'request_booking', 'end_call', 42, undefined]) assert.deepEqual(runContactTool(st, name, {}), { ok: false, code: 'UNKNOWN_TOOL' });
  assert.deepEqual(runContactTool(st, 'collect_name', { heard: 1 }), { ok: false, code: 'BAD_ARGUMENTS' });
  assert.deepEqual(runContactTool(st, 'collect_name', { heard: 'Priya', extra: 'x' }), { ok: false, code: 'BAD_ARGUMENTS' });
  assert.deepEqual(runContactTool(st, 'correct_contact', { field: 'price', heard: 'x' }), { ok: false, code: 'BAD_ARGUMENTS' });
  assert.deepEqual(runContactTool(st, 'collect_name', null), { ok: false, code: 'BAD_ARGUMENTS' });
  const r = runContactTool(st, 'collect_name', { heard: 'priya raman' });
  assert.ok(r.ok && r.outcome === 'captured' && r.captured.includes(CONTACT_FIELDS.name) && r.missing.includes(CONTACT_FIELDS.phone));
  assert.ok(!/priya|raman/i.test(JSON.stringify({ ...r, learn: undefined })), 'the result carries no value');
  const c = runContactTool(st, 'correct_contact', { field: 'name', heard: 'jon smith' });
  assert.ok(c.ok && st.value('name') === 'Jon Smith');
  const s2 = runContactTool(st, 'call_status', {}); assert.ok(s2.ok && s2.outcome === 'status');
  st.dispose(); assert.deepEqual(st.parts(), {});
});

test('status for the voice: field names only, before the NEXT line, no values; the instruction tells it never to ask about a captured item', () => {
  const line = renderStatus({ captured: [CONTACT_FIELDS.name, 'Property type'], missing: [CONTACT_FIELDS.phone, 'a [bad] name'] });
  assert.equal(line, 'STATUS captured: Customer name; Property type. still missing: Callback phone number.\n');
  assert.equal(renderStatus(undefined), '');
  assert.equal(renderStatus({ captured: [], missing: [] }), '');
  assert.ok(/Never ask about a captured item/.test(DIALOGUE_INSTRUCTION));
  assert.equal(renderDirective({ kind: 'ask', field: CONTACT_FIELDS.name }), 'NEXT ASK Customer name');
});

test('dispose clears the captured values', () => {
  const s = session(); s.hear('priya raman', 'name'); s.dispose();
  assert.deepEqual(s.revealContactParts(), {});
  assert.equal(s.revealContact(), undefined);
});

// ---------------------------------------------------------------- 2026-10-28 retest: pieces, repeated prefixes, stray digit words and the last-four correction
test('REPRODUCED a repeated prefix is not joined into a wrong number: the held digits are dropped and the piece starts over; a stray "oh" cannot make a number either', () => {
  const t = createContactState();
  assert.equal(t.collect('phone', 'two one two five five five').reason, 'PIECE');
  const r = t.collect('phone', 'five five five zero one four two');
  assert.deepEqual([r.outcome, r.reason, r.digits, r.total], ['partial', 'RESTART', 7, 7]);
  assert.equal(t.value('phone'), undefined, 'thirteen joined digits were not taken as the number');
  const w = t.collect('phone', 'two one two five five five zero one four two');
  assert.deepEqual([w.outcome, w.reason, t.value('phone')], ['captured', 'CAPTURED', '2125550142']);
  const u = createContactState();
  u.collect('phone', 'two one two'); u.collect('phone', 'oh sorry');
  assert.equal(u.collect('phone', 'five five five zero one four two').outcome, 'partial');
  assert.equal(u.value('phone'), undefined, 'a stray "oh" did not produce an eleven digit number');
  const v = createContactState();
  v.collect('phone', 'two one two five five five');
  assert.equal(v.collect('phone', 'zero one four two nine nine').outcome, 'partial', 'twelve joined digits are not a number');
});

test('split numbers still join at the usual lengths (ten, or eleven with a leading one) and a whole line of ten to fifteen digits is taken as said', () => {
  const a = createContactState();
  a.collect('phone', 'two one two'); a.collect('phone', 'five five five');
  assert.deepEqual([a.collect('phone', 'zero one four two').reason, a.value('phone')], ['CAPTURED', '2125550142']);
  const b = createContactState();
  b.collect('phone', 'one'); b.collect('phone', 'two one two five five five');
  assert.equal(b.collect('phone', 'zero one four two').outcome, 'captured');
  assert.equal(b.value('phone'), '12125550142');
  const c = createContactState();
  assert.equal(c.collect('phone', 'four four seven seven zero zero nine zero zero one two three').outcome, 'captured');
  assert.equal(c.value('phone')?.length, 12);
});

test('REPRODUCED the last-four correction replaces the final four digits of the number held, is masked, and is reported with a fixed reason', () => {
  const s = session();
  s.hear('two one two five five five zero one four two', 'phone');
  assert.equal(s.revealContactParts().phone, '2125550142');
  const h = s.hear('sorry, the last four are nine nine nine nine');
  assert.ok(h.ok && h.contact?.[0].field === 'phone' && h.contact[0].reason === 'CORRECTED_LAST4' && h.contact[0].digits === 4 && h.contact[0].total === 10, JSON.stringify(h));
  assert.equal(s.revealContactParts().phone, '2125559999');
  assert.ok(!/nine|\d{3,}/i.test(s.maskedText().replace(/\[[A-Z_]+\d*\]/g, '')), 'no digit is left in what a model reads');
  assert.equal(s.contactDiag().phone, true);
  const none = createContactState();
  assert.equal(none.volunteered('the last four are nine nine nine nine').length, 0, 'with no number held there is nothing to correct');
});

test('every collect result carries a fixed reason and counts, never a value', () => {
  const t = createContactState();
  assert.equal(t.collect('name', 'maybe later').reason, 'NOT_A_NAME');
  assert.equal(t.collect('name', 'Priya Raman').reason, 'CAPTURED');
  assert.equal(t.collect('address', 'I would rather not say').reason, 'NO_STREET_NUMBER');
  assert.equal(t.collect('address', '42 Elm Street').reason, 'CAPTURED');
  assert.equal(t.collect('phone', 'hello there').reason, 'NO_DIGITS');
  assert.equal(t.collect('phone', 'five five five').reason, 'PIECE');
  assert.equal(t.pendingDigits(), 3);
});

// ---------------------------------------------------------------- 2026-10-28 service address in parts
test('ADDRESS a house number alone is never an address, however it is said; a street name needs no particular suffix; unit-only text is not a street', () => {
  for (const bad of ['742', '742.', 'it is 742', 'the address is 742', 'seven four two', 'seven forty two', 'forty two', 'apartment 4', 'unit 4', '4 B', '']) assert.equal(addressFrom(bad), undefined, bad);
  for (const [ok, want] of [['742 Evergreen', '742 Evergreen'], ['742 Evergreen Terrace', '742 Evergreen Terrace'], ['forty two Oak Lane', 'forty two Oak Lane'], ['Maple Grove Apartments unit 4', 'Maple Grove Apartments unit 4'], ['PO Box 12', 'PO Box 12'], ['Evergreen Terrace 742', 'Evergreen Terrace 742'], ['my address is 5 Broadway', '5 Broadway']] as const) assert.equal(addressFrom(ok), want, ok);
});

test('ADDRESS pieces: a house number (digits or number words) and a street name are told apart; conversation, a road word alone and a phone-length number are neither', () => {
  assert.deepEqual(addressPiece('742'), { kind: 'number', text: '742' });
  assert.deepEqual(addressPiece('it is 742.'), { kind: 'number', text: '742' });
  assert.deepEqual(addressPiece('seven four two'), { kind: 'number', text: 'seven four two' });
  assert.deepEqual(addressPiece('the house number is forty two'), { kind: 'number', text: 'forty two' });
  assert.deepEqual(addressPiece('Evergreen Terrace.'), { kind: 'street', text: 'Evergreen Terrace' });
  assert.deepEqual(addressPiece('evergreen'), { kind: 'street', text: 'Evergreen' });
  assert.deepEqual(addressPiece("it's Maple Grove"), { kind: 'street', text: 'Maple Grove' });
  for (const none of ['street', 'Avenue', 'let me check', 'hold on', 'one moment', 'yes', 'no', 'I would rather not say', 'about the price', 'I do not know', '212 555 0142', 'two one two five five five zero one four two', 'apartment 4', '']) assert.equal(addressPiece(none), undefined, none);
});

test('ADDRESS a house number then a street name are held across turns and joined; the parts are masked, never reach a model, and the caller confirms the whole aloud', () => {
  const s = session();
  const a = s.hear('742', 'address');
  assert.ok(a.ok && a.contact?.[0].outcome === 'partial' && a.contact[0].reason === 'NEED_STREET', JSON.stringify(a));
  assert.equal(s.addressPart(), 'street name');
  assert.ok(s.contactMissing().includes(CONTACT_FIELDS.address), 'a number alone does not satisfy the address');
  assert.equal(s.revealContactParts().address, undefined);
  const b = s.hear('Evergreen Terrace', 'address');
  assert.ok(b.ok && b.contact?.[0].outcome === 'captured' && b.contact[0].reason === 'JOINED', JSON.stringify(b));
  assert.equal(s.revealContactParts().address, '742 Evergreen Terrace');
  assert.equal(s.addressPart(), undefined);
  assert.ok(!/742|evergreen/i.test(s.maskedText() + JSON.stringify(s.dialogue())), 'no part of the address is in what a model reads');
  assert.equal(s.contactDiag().address, true);
});

test('ADDRESS a street name first and then the house number joins the other way round; written or spoken numbers both join', () => {
  const t = createContactState();
  assert.deepEqual([t.collect('address', 'Oak Lane').outcome, t.addressPart()], ['partial', 'house number']);
  assert.deepEqual([t.collect('address', 'forty two').reason, t.value('address')], ['JOINED', 'forty two Oak Lane']);
  const u = createContactState();
  u.collect('address', 'Evergreen'); assert.equal(u.collect('address', '742').reason, 'JOINED'); assert.equal(u.value('address'), '742 Evergreen');
  const v = createContactState();
  v.collect('address', 'seven four two'); assert.equal(v.collect('address', 'Evergreen Terrace').reason, 'JOINED'); assert.equal(v.value('address'), 'seven four two Evergreen Terrace');
});

test('ADDRESS corrections: a different number replaces the held one, a correction clears held parts, a whole address replaces them, and a wrong address leaves nothing behind', () => {
  const t = createContactState();
  t.collect('address', '742'); t.collect('address', '724');
  assert.equal(t.collect('address', 'Evergreen Terrace').reason, 'JOINED'); assert.equal(t.value('address'), '724 Evergreen Terrace');
  const u = createContactState();
  u.collect('address', '742'); assert.equal(u.addressPart(), 'street name');
  const w = u.collect('address', 'Oak Lane', true);   // a correction starts over: the held number is dropped, so a street alone is only a street
  assert.deepEqual([w.outcome, w.reason, u.addressPart()], ['partial', 'NEED_NUMBER', 'house number']);
  u.collect('address', '9 Birch Road'); assert.deepEqual([u.value('address'), u.addressPart()], ['9 Birch Road', undefined]);
  const x = createContactState();
  x.collect('address', '742'); x.clear('address'); assert.equal(x.addressPart(), undefined);
  x.collect('address', '742'); x.set('address', '1 Main Street'); assert.equal(x.addressPart(), undefined);
  const s = session();
  s.hear('742', 'address'); s.hear('Evergreen Terrace', 'address'); s.forgetAddress();
  assert.equal(s.revealContactParts().address, undefined); assert.equal(s.addressPart(), undefined);
  s.hear('Oak Lane', 'address'); s.forgetAddress(); assert.equal(s.addressPart(), undefined, 'a held part does not survive "that is wrong"');
});

test('ADDRESS refusal, noise and an incomplete address: nothing is invented, a held number stays only a number, and a different call never sees it', () => {
  const t = createContactState();
  t.collect('address', '742');
  for (const noise of ['I would rather not say', 'let me check', 'one moment', 'about the price', 'hello']) assert.equal(t.collect('address', noise).outcome, 'unclear', noise);
  assert.equal(t.value('address'), undefined);
  assert.equal(t.addressPart(), 'street name', 'the held number survives noise but is still not an address');
  assert.deepEqual(t.status().missing.includes(CONTACT_FIELDS.address), true);
  const other = createContactState();
  assert.equal(other.addressPart(), undefined, 'state is per call');
  t.dispose(); assert.equal(t.addressPart(), undefined); assert.equal(t.collect('address', 'Evergreen').outcome, 'unclear');
});

test('ADDRESS the native tools take the same parts and report only labels and a fixed outcome', () => {
  const t = createContactState();
  const a = runContactTool(t, 'collect_address', { heard: '742' });
  assert.ok(a.ok && a.outcome === 'partial' && a.missing.includes(CONTACT_FIELDS.address));
  const b = runContactTool(t, 'collect_address', { heard: 'Evergreen Terrace' });
  assert.ok(b.ok && b.outcome === 'captured' && b.captured.includes(CONTACT_FIELDS.address));
  assert.equal(t.value('address'), '742 Evergreen Terrace');
});

test('ADDRESS the directive names only the missing part, in one fixed line, and the spoken fallback asks only for it', () => {
  assert.equal(renderDirective({ kind: 'ask', field: 'Service address', part: 'street name' }), 'NEXT ASK Service address (the house number is already heard: ask only for the street name)');
  assert.equal(renderDirective({ kind: 'ask', field: 'Service address', part: 'house number', again: true }), 'NEXT ASK Service address (asked before: ask it a different way) (the street name is already heard: ask only for the house number)');
  assert.equal(renderDirective({ kind: 'ask', field: 'Service address' }), 'NEXT ASK Service address');
  assert.equal(fallbackText({ kind: 'ask', field: 'Service address', part: 'street name' }), 'Sorry about the pause. What is the street name?');
  assert.ok(!/[\r\n[\]<>]/.test(renderDirective({ kind: 'ask', field: 'Service address', part: 'house number' })));
});

// ---------------------------------------------------------------- 2026-10-28: dates, times and durations are not phone digits
test('PHONE a date, a time, a duration or a quantity is never phone digits: nothing is taken, held pieces stay as they were, and a long digit run in the line is still taught to the masker', () => {
  const s = createContactState();
  s.collect('phone', 'two one two five five five');
  for (const bad of ['October 22', 'on the 22nd', 'six months ago', '9:30', '10 am', 'nine thirty', 'twenty two', 'tomorrow morning at nine', 'three bedrooms', 'two weeks']) {
    const r = s.collect('phone', bad);
    assert.deepEqual([r.outcome, r.reason, r.digits, s.pendingDigits()], ['unclear', 'NOT_DIGITS', 0, 6], bad);
    assert.deepEqual(r.learn, [], `${bad}: a short run (a day, an hour) is left alone`);
  }
  const long = s.collect('phone', 'on October 22 call 5550142 tomorrow');
  assert.deepEqual([long.reason, long.learn.length], ['NOT_DIGITS', 1], 'the seven digit run is taught to the masker so it stays protected');
  assert.equal(s.collect('phone', 'zero one four two').reason, 'CAPTURED');
  assert.equal(s.value('phone'), '2125550142');
});

test('PHONE ordinary spoken or written numbers still count, with filler words around them', () => {
  for (const [line, digits] of [['212 555 0142', '2125550142'], ['my number is two one two five five five zero one four two', '2125550142'], ['sorry, it is one two one two five five five zero one four two', '12125550142'], ['area code two one two', undefined]] as const) {
    const t = createContactState(); const r = t.collect('phone', line);
    assert.equal(t.value('phone'), digits, line);
    assert.notEqual(r.reason, 'NOT_DIGITS', line);
  }
});

test('masking: an ordinary date stays intact when no phone piece was accepted, and an ACCEPTED piece is still masked wherever it is said next', () => {
  const s = session();
  const a = s.hear('October 22', 'phone');
  assert.ok(a.ok && a.line === 'October 22' && a.contact?.[0].reason === 'NOT_DIGITS', JSON.stringify(a));
  const b = s.hear('five five five zero', 'phone');
  assert.ok(b.ok && /^\[CONTACT_\d\]$/.test(b.line) && b.contact?.[0].reason === 'PIECE', JSON.stringify(b));
  const c = s.hear('it was five five five zero', 'phone');
  assert.ok(c.ok && !/five/.test(c.line), 'the piece is masked again later: ' + JSON.stringify(c));
  assert.ok(/October 22/.test(s.maskedText()), 'the date is still in what a model reads');
  assert.ok(!/five five five zero/.test(s.maskedText()));
});
