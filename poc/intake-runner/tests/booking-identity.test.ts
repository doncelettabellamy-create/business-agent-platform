// The booking identity and its keyring (Step 3a foundation; offline). Every secret below is a made-up byte pattern; no network, no real key, no Jobber.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bookingIdentity, describe, IdentityError, identitiesFor, keyringUnchanged, KEYRING_BASE, loadKeyring, normalizeParts, parseGeneration } from '../src/booking-identity.ts';
import type { IdentityParts, Keyring, KeyringVault } from '../src/booking-identity.ts';
import { createVault } from '../src/jobber-connector.ts';
import type { Protector } from '../src/jobber-connector.ts';

const sec = (n: number): string => Buffer.alloc(32, n).toString('base64url');
const S1 = sec(1); const S2 = sec(2); const S3 = sec(3); const S4 = sec(4);
const PARTS: IdentityParts = { phone: '(555) 010-0002', date: '2026-11-03', startTime: '10:00', street: '123 Invented Lane', zip: '90210' };
const AT = '2026-11-09T12:00:00.000Z';
const gen = (n: number, current: { kid: string; secret: string }, retired: Array<{ kid: string; secret: string; retired_at: string }> = []): string => JSON.stringify({ version: 1, gen: n, current, retired });
const k = (kid: string, secret: string) => ({ kid, secret });
const r = (kid: string, secret: string, retired_at = AT) => ({ kid, secret, retired_at });
/** The vault as the keyring reads it: a listing of generation numbers and the text of each file, in memory. */
function mem(files: Record<number, string | undefined>, o: { list?: number[]; throwOn?: number; throwList?: boolean } = {}): KeyringVault {
  return {
    generations: () => { if (o.throwList) throw new Error('listing'); return o.list ?? Object.keys(files).map(Number).sort((a, b) => a - b); },
    loadBlob: async (name: string) => { const n = Number(name.slice(KEYRING_BASE.length + 1)); if (n === o.throwOn) throw new Error('unreadable'); return files[n]; },
  };
}
const chain3 = (): Record<number, string> => ({
  1: gen(1, k('k1', S1)),
  2: gen(2, k('k2', S2), [r('k1', S1)]),
  3: gen(3, k('k3', S3), [r('k2', S2, '2026-11-10T00:00:00Z'), r('k1', S1)]),
});

test('IDENTITY a request gives one key: the same under any phone spelling, any street suffix or unit, and no Call SID is involved; the format is fixed and pinned by a known answer', () => {
  const key = bookingIdentity(S1, PARTS);
  assert.match(key, /^fast2-[0-9a-f]{24}$/); assert.match(key, /^[A-Za-z0-9_-]{16,64}$/, 'it passes the booking request\'s own key pattern');
  assert.equal(key, 'fast2-c202208ba8c5074c98c371ea', 'known answer (cross-checked with an independent HMAC implementation): the algorithm cannot change unnoticed');
  for (const phone of ['5550100002', '+1 555 010 0002', '15550100002', '555.010.0002', ' (555) 010-0002 ']) assert.equal(bookingIdentity(S1, { ...PARTS, phone }), key, phone);
  for (const street of ['123 invented ln', '123 Invented Lane Apt 4', '123 Invented Lane #4B', '123   Other Street Name', '123 X']) assert.equal(bookingIdentity(S1, { ...PARTS, street }), key, street);
  assert.equal(bookingIdentity(S1, { ...PARTS, street: '12a Invented Lane' }), bookingIdentity(S1, { ...PARTS, street: '12A Elsewhere Road' }), 'the house number is compared in upper case');
  assert.notEqual(key, 'fast-' + key.slice(6), 'never an old Call-SID style key');
  assert.equal(bookingIdentity(S1, PARTS), key, 'stable on a second call');
});

test('IDENTITY every part of the booking matters: a different phone, date, start time, house number or ZIP is a different key; nothing else is', () => {
  const base = bookingIdentity(S1, PARTS);
  const changed: Array<[string, IdentityParts]> = [
    ['phone', { ...PARTS, phone: '5550100003' }], ['date', { ...PARTS, date: '2026-11-04' }], ['start', { ...PARTS, startTime: '10:30' }],
    ['house', { ...PARTS, street: '124 Invented Lane' }], ['house with letter', { ...PARTS, street: '123A Invented Lane' }], ['zip', { ...PARTS, zip: '90211' }],
  ];
  const seen = new Set([base]);
  for (const [name, p] of changed) { const x = bookingIdentity(S1, p); assert.ok(!seen.has(x), name); seen.add(x); }
  assert.equal(seen.size, 7);
});

test('IDENTITY secrets are separate: another secret is another key, the key shows neither the secret nor the parts, an error and the description never carry a secret', () => {
  const a = bookingIdentity(S1, PARTS); const b = bookingIdentity(S2, PARTS); assert.notEqual(a, b);
  for (const shown of [a, b]) { assert.ok(!shown.includes('5550100002') && !shown.includes('90210') && !shown.includes('2026') && !shown.includes('Invented'), 'no part of the booking is readable in the key'); }
  for (const secret of [S1, S2]) assert.ok(!a.includes(secret.slice(0, 8)) && !b.includes(secret.slice(0, 8)));
  const ring: Keyring = { gen: 2, current: k('k2', S2), retired: [r('k1', S1)] };
  const shown = JSON.stringify(describe(ring)); assert.ok(!shown.includes(S1) && !shown.includes(S2) && !shown.includes(S2.slice(0, 8)) && !shown.includes(S1.slice(0, 8)), 'description: ids and a fingerprint only');
  assert.deepEqual(describe(ring).retired, ['k1']); assert.equal(describe(ring).current, 'k2'); assert.match(describe(ring).fingerprint, /^[0-9a-f]{4}$/);
  assert.equal(describe(ring).fingerprint, createHash('sha256').update(`drew-keyring-fingerprint:${S2}`).digest('hex').slice(0, 4));
  assert.notEqual(describe({ ...ring, current: k('k2', S3) }).fingerprint, describe(ring).fingerprint);
  for (const secret of ['', 'short', S1 + 'A', S1.slice(0, 42), S1.slice(0, 42) + '=', S1.replace(/.$/, '!'), 'A'.repeat(42) + 'B']) {
    assert.throws(() => bookingIdentity(secret, PARTS), (e: unknown) => e instanceof IdentityError && e.code === 'BAD_SECRET' && e.message === 'BAD_SECRET' && !String((e as Error).stack).includes(secret || 'a-secret-never-empty'), JSON.stringify(secret.slice(0, 5)));
  }
  assert.throws(() => bookingIdentity('A'.repeat(42) + 'B', PARTS), IdentityError, 'a 43-character string that is not the canonical spelling of 32 bytes');
});

test('IDENTITY a part that is missing or of the wrong shape is refused with a fixed code and the value never appears in the error', () => {
  const bad: Array<[string, Partial<Record<keyof IdentityParts, unknown>>]> = [
    ['phone short', { phone: '555010000' }], ['phone long', { phone: '255501000022' }], ['phone empty', { phone: '' }], ['phone letters', { phone: 'five five five' }],
    ['date shape', { date: '11/03/2026' }], ['date impossible', { date: '2026-02-30' }], ['date month', { date: '2026-13-01' }], ['date empty', { date: '' }],
    ['time shape', { startTime: '9:00' }], ['time hour', { startTime: '24:00' }], ['time minute', { startTime: '10:60' }],
    ['zip short', { zip: '9021' }], ['zip letters', { zip: '9021a' }], ['zip long', { zip: '902100' }],
    ['street no number', { street: 'Invented Lane' }], ['street empty', { street: '' }], ['street number only', { street: '123' }], ['house is the zip', { street: '90210 Invented Lane' }],
    ['phone number type', { phone: 5550100002 }], ['street undefined', { street: undefined }], ['date null', { date: null }],
  ];
  for (const [name, patch] of bad) {
    const p = { ...PARTS, ...patch } as IdentityParts;
    assert.throws(() => bookingIdentity(S1, p), (e: unknown) => e instanceof IdentityError && e.code === 'BAD_PARTS' && e.message === 'BAD_PARTS', name);
  }
  assert.throws(() => normalizeParts(null as unknown as IdentityParts), IdentityError);
  assert.deepEqual(normalizeParts({ ...PARTS, street: '12a Invented Lane' }), { phone: '5550100002', date: '2026-11-03', start: '10:00', house: '12A', zip: '90210' });
});

test('KEYRING a generation is parsed strictly: exactly the five fields, the right number, well-formed ids and secrets, no id or secret twice, at most five retired keys', () => {
  const good = gen(1, k('k1', S1)); assert.deepEqual(parseGeneration(good, 1), { gen: 1, current: k('k1', S1), retired: [] });
  const base = { version: 1, gen: 2, current: k('k2', S2), retired: [r('k1', S1)] };
  assert.deepEqual(parseGeneration(JSON.stringify(base), 2)?.retired, [r('k1', S1)]);
  const bads: Array<[string, string | undefined]> = [
    ['undefined', undefined], ['empty', ''], ['not json', '{'], ['array', '[]'], ['null', 'null'], ['string', '"x"'], ['number', '7'],
    ['version 2', JSON.stringify({ ...base, version: 2 })], ['version missing', JSON.stringify({ gen: 2, current: base.current, retired: base.retired })], ['version string', JSON.stringify({ ...base, version: '1' })],
    ['gen mismatch', JSON.stringify({ ...base, gen: 3 })], ['gen string', JSON.stringify({ ...base, gen: '2' })], ['gen missing', JSON.stringify({ version: 1, current: base.current, retired: base.retired })],
    ['extra field', JSON.stringify({ ...base, note: 'x' })], ['proto key', '{"version":1,"gen":2,"current":{"kid":"k2","secret":"' + S2 + '"},"retired":[],"__proto__":{"x":1}}'],
    ['current missing', JSON.stringify({ version: 1, gen: 2, retired: [] })], ['current array', JSON.stringify({ ...base, current: [] })], ['current extra', JSON.stringify({ ...base, current: { ...base.current, x: 1 } })],
    ['kid bad', JSON.stringify({ ...base, current: k('K2', S2) })], ['kid zero', JSON.stringify({ ...base, current: k('k0', S2) })], ['kid leading zero', JSON.stringify({ ...base, current: k('k01', S2) })], ['kid long', JSON.stringify({ ...base, current: k('k1000', S2) })],
    ['secret short', JSON.stringify({ ...base, current: k('k2', S2.slice(0, 42)) })], ['secret padded', JSON.stringify({ ...base, current: k('k2', S2 + '=') })], ['secret non-canonical', JSON.stringify({ ...base, current: k('k2', 'A'.repeat(42) + 'B') })], ['secret number', JSON.stringify({ ...base, current: { kid: 'k2', secret: 7 } })],
    ['retired missing', JSON.stringify({ version: 1, gen: 2, current: base.current })], ['retired object', JSON.stringify({ ...base, retired: {} })], ['retired entry no stamp', JSON.stringify({ ...base, retired: [k('k1', S1)] })],
    ['retired entry extra', JSON.stringify({ ...base, retired: [{ ...r('k1', S1), x: 1 }] })], ['retired stamp bad', JSON.stringify({ ...base, retired: [r('k1', S1, 'yesterday')] })], ['retired stamp no zone', JSON.stringify({ ...base, retired: [r('k1', S1, '2026-11-09T12:00:00')] })],
    ['retired stamp impossible', JSON.stringify({ ...base, retired: [r('k1', S1, '2026-13-45T25:61:61Z')] })],
    ['duplicate kid', JSON.stringify({ ...base, retired: [r('k2', S1)] })], ['duplicate secret', JSON.stringify({ ...base, retired: [r('k1', S2)] })],
    ['two retired same kid', JSON.stringify({ ...base, retired: [r('k1', S1), r('k1', S3)] })], ['two retired same secret', JSON.stringify({ ...base, retired: [r('k1', S1), r('k3', S1)] })],
    ['six retired', JSON.stringify({ ...base, retired: [1, 2, 3, 4, 5, 6].map((i) => r(`k${i + 10}`, sec(i + 10))) })],
  ];
  for (const [name, text] of bads) assert.equal(parseGeneration(text, 2), undefined, name);
  assert.deepEqual(parseGeneration(JSON.stringify({ ...base, retired: [1, 2, 3, 4, 5].map((i) => r(`k${i + 10}`, sec(i + 10))) }), 2)?.retired.length, 5, 'five retired keys are allowed');
});

test('KEYRING a chain is read as a whole: one generation, three generations, retired keys dropped in a later one; the newest is the keyring and the list of generations is returned', async () => {
  const one = await loadKeyring(mem({ 1: gen(1, k('k1', S1)) })); assert.ok(one.ok); assert.deepEqual(one.generations, [1]); assert.deepEqual(one.keyring, { gen: 1, current: k('k1', S1), retired: [] });
  const three = await loadKeyring(mem(chain3())); assert.ok(three.ok); assert.deepEqual(three.generations, [1, 2, 3]); assert.equal(three.keyring.current.kid, 'k3'); assert.deepEqual(three.keyring.retired.map((x) => x.kid), ['k2', 'k1']);
  const dropped = chain3(); dropped[4] = gen(4, k('k4', S4), [r('k3', S3), r('k2', S2, '2026-11-10T00:00:00Z')]);   // k1 dropped by retention
  const four = await loadKeyring(mem(dropped)); assert.ok(four.ok); assert.deepEqual(four.keyring.retired.map((x) => x.kid), ['k3', 'k2']);
});

test('KEYRING a chain that is missing, gapped, too long, unreadable or out of order is refused with one fixed reason: nothing is repaired, skipped or read from an older generation', async () => {
  const p = async (v: KeyringVault) => { const x = await loadKeyring(v); return x.ok ? 'ok' : `${x.problem}${x.gen === undefined ? '' : `@${x.gen}`}`; };
  const c = chain3();
  assert.equal(await p(mem({})), 'MISSING');
  assert.equal(await p(mem({ 1: c[1], 3: c[3] })), 'GAP@2', 'generation 2 is missing');
  assert.equal(await p(mem({ 2: c[2], 3: c[3] })), 'GAP@1', 'the chain must start at 1');
  assert.equal(await p(mem({ 1: c[1], 2: c[2] }, { list: [0, 1, 2] })), 'GAP@1', 'generation 0 is not part of a chain');
  assert.equal(await p(mem({ 1: c[1], 2: c[2] }, { list: [1, 2, 100] })), 'TOO_MANY@100');
  assert.equal(await p(mem(c, { throwList: true })), 'UNREADABLE');
  assert.equal(await p(mem(c, { throwOn: 3 })), 'UNREADABLE@3', 'the newest cannot be read: never fall back to generation 2');
  assert.equal(await p(mem({ 1: c[1], 2: undefined })), 'UNREADABLE@2', 'listed but not there');
  assert.equal(await p(mem({ ...c, 3: 'not json' })), 'MALFORMED@3');
  assert.equal(await p(mem({ ...c, 2: gen(2, k('k2', S2), [r('k1', S1)]).replace('"gen":2', '"gen":3') })), 'MALFORMED@2');
  // the way a generation follows the one before it
  assert.equal(await p(mem({ 1: gen(1, k('k1', S1), [r('k0x', S4)]) })), 'MALFORMED@1', 'a retired key with a bad id');
  assert.equal(await p(mem({ 1: gen(1, k('k1', S1), [r('k9', S4)]) })), 'SUCCESSION@1', 'the first generation has nothing to retire');
  assert.equal(await p(mem({ 1: c[1], 2: gen(2, k('k2', S2)) })), 'SUCCESSION@2', 'the old current key is not carried into retired');
  assert.equal(await p(mem({ 1: c[1], 2: gen(2, k('k2', S2), [r('k7', S3)]) })), 'SUCCESSION@2', 'retired[0] is not the old current key');
  assert.equal(await p(mem({ 1: c[1], 2: gen(2, k('k1', S2), [r('k1', S1)]) })), 'MALFORMED@2', 'the same id twice in one generation');
  assert.equal(await p(mem({ 1: c[1], 2: gen(2, k('k1', S3), [r('k1b', S1)]) })), 'MALFORMED@2');
  assert.equal(await p(mem({ 1: c[1], 2: gen(2, k('k2', S1), [r('k1', S1)]) })), 'MALFORMED@2', 'the same secret twice in one generation');
  const reuse = { ...c, 3: gen(3, k('k2', S3), [r('k2', S2), r('k1', S1)]) }; assert.equal(await p(mem(reuse)), 'MALFORMED@3');
  assert.equal(await p(mem({ ...c, 3: gen(3, k('k1', sec(9)), [r('k2', S2), r('k9', sec(8))]) })), 'SUCCESSION@3', 'a new current key may not reuse a key id used before');
  assert.equal(await p(mem({ ...c, 3: gen(3, k('k3', S1), [r('k2', S2), r('k9', sec(8))]) })), 'SUCCESSION@3', 'a new current key may not reuse a secret used before');
  assert.equal(await p(mem({ ...c, 3: gen(3, k('k1', sec(9)), [r('k2', S2)]) })), 'SUCCESSION@3', 'a key id that was dropped from retired may not come back as the new current key');
  assert.equal(await p(mem({ ...c, 3: gen(3, k('k3', S1), [r('k2', S2)]) })), 'SUCCESSION@3', 'a secret that was dropped from retired may not come back as the new current secret');
  assert.equal(await p(mem({ ...c, 3: gen(3, k('k3', S3), [r('k2', S2), r('k1', S1, '2026-01-01T00:00:00Z')]) })), 'SUCCESSION@3', 'a retired key may not change its retirement time');
  assert.equal(await p(mem({ ...c, 3: gen(3, k('k3', S3), [r('k2', S2), r('k1', S4)]) })), 'SUCCESSION@3', 'a retired key may not change its secret');
  assert.equal(await p(mem({ ...c, 3: gen(3, k('k3', S3), [r('k1', S1), r('k2', S2)]) })), 'SUCCESSION@3', 'the old current key must come first');
  const d = chain3(); d[4] = gen(4, k('k4', S4), [r('k3', S3), r('k2', S2, '2026-11-10T00:00:00Z')]); d[5] = gen(5, k('k5', sec(5)), [r('k4', S4), r('k3', S3), r('k2', S2, '2026-11-10T00:00:00Z'), r('k1', S1)]);
  assert.equal(await p(mem(d)), 'SUCCESSION@5', 'a dropped retired key may not come back');
  assert.equal(await p(mem({ ...c, 3: c[3].replace(',"retired_at"', ',"retired_at"') })), 'ok', 'control: an untouched chain loads');
});

test('KEYRING the chain on disk is compared with the one that was loaded: a rotation, a removal or an unreadable listing all make it changed', async () => {
  const c = chain3(); const files: Record<number, string | undefined> = { 1: c[1], 2: c[2] };
  const vault = mem(files); const loaded = await loadKeyring(vault); assert.ok(loaded.ok);
  assert.equal(keyringUnchanged(vault, loaded.generations), true);
  files[3] = c[3]; assert.equal(keyringUnchanged(vault, loaded.generations), false, 'a newer generation was published');
  delete files[3]; delete files[2]; assert.equal(keyringUnchanged(vault, loaded.generations), false, 'the newest generation was removed');
  assert.equal(keyringUnchanged(mem(files, { throwList: true }), [1]), false, 'an unreadable listing is changed, never "same"');
  assert.equal(keyringUnchanged(mem({ 1: c[1] }, { list: [1, 2] }), [1]), false); assert.equal(keyringUnchanged(mem({ 1: c[1] }, { list: [] }), [1]), false);
  assert.equal(keyringUnchanged(mem({ 1: c[1] }, { list: [1] }), []), false); assert.equal(keyringUnchanged(mem({ 1: c[1] }), [1]), true);
});

test('IDENTITIES the key is the current secret\'s and the aliases are the retired secrets\' in the keyring\'s order; after a rotation the old key is the first alias; all are different', async () => {
  const c = chain3(); const loaded = await loadKeyring(mem(c)); assert.ok(loaded.ok);
  const ids = identitiesFor(loaded.keyring, PARTS);
  assert.equal(ids.key, bookingIdentity(S3, PARTS)); assert.deepEqual(ids.aliases, [bookingIdentity(S2, PARTS), bookingIdentity(S1, PARTS)]);
  assert.equal(new Set([ids.key, ...ids.aliases]).size, 3);
  const before = await loadKeyring(mem({ 1: c[1] })); assert.ok(before.ok); const was = identitiesFor(before.keyring, PARTS);
  const after = await loadKeyring(mem({ 1: c[1], 2: c[2] })); assert.ok(after.ok);
  assert.equal(identitiesFor(after.keyring, PARTS).aliases[0], was.key, 'what was booked under the key before the rotation is found as an alias after it');
  assert.deepEqual(identitiesFor({ gen: 1, current: k('k1', S1), retired: [] }, PARTS).aliases, []);
});

// the real vault: generation files published the way the booking ledger's are, listed and read back through the same functions
const fakeProtector: Protector = { protect: async (p) => `P1:${Buffer.from([...Buffer.from(p)].reverse()).toString('hex')}`, unprotect: async (b) => Buffer.from(Buffer.from(b.slice(3), 'hex').reverse()).toString() };
const root = mkdtempSync(join(tmpdir(), 'booking-identity-')); after(() => rmSync(root, { recursive: true, force: true }));
test('KEYRING works on the real vault: published generations are listed and read; a removed middle file is a gap; a rewritten file that no longer follows is refused', async () => {
  const dir = mkdtempSync(join(root, 'v-')); const vault = createVault(dir, fakeProtector); const c = chain3();
  assert.deepEqual(await loadKeyring(vault), { ok: false, problem: 'MISSING' });
  for (const n of [1, 2, 3]) assert.equal(await vault.publishBlob(`${KEYRING_BASE}.${n}`, c[n], () => undefined), 'published');
  const ok = await loadKeyring(vault); assert.ok(ok.ok); assert.deepEqual(ok.generations, [1, 2, 3]); assert.equal(ok.keyring.current.kid, 'k3');
  assert.ok(!readFileSync(join(dir, `${KEYRING_BASE}.1.enc`), 'utf8').includes(S1), 'the file holds the protector\'s output, not the plain secret');
  assert.equal(await vault.publishBlob(`${KEYRING_BASE}.3`, c[3], () => undefined), 'exists', 'a generation is never replaced');
  assert.equal(keyringUnchanged(vault, ok.generations), true);
  unlinkSync(join(dir, `${KEYRING_BASE}.2.enc`));
  assert.deepEqual(await loadKeyring(vault), { ok: false, problem: 'GAP', gen: 2 }); assert.equal(keyringUnchanged(vault, ok.generations), false);
  const dir2 = mkdtempSync(join(root, 'w-')); const v2 = createVault(dir2, fakeProtector);
  await v2.publishBlob(`${KEYRING_BASE}.1`, c[1], () => undefined); await v2.publishBlob(`${KEYRING_BASE}.2`, gen(2, k('k2', S2)), () => undefined);
  assert.deepEqual(await loadKeyring(v2), { ok: false, problem: 'SUCCESSION', gen: 2 });
  const strict: Protector = { protect: fakeProtector.protect, unprotect: async () => { throw new Error('cannot decode'); } };
  assert.deepEqual(await loadKeyring(createVault(dir2, strict)), { ok: false, problem: 'UNREADABLE', gen: 1 }, 'a file the protector cannot decode is UNREADABLE');
});

test('SOURCE the module only reads: it imports no Jobber module, no file system, no network and no environment, never logs, and never writes a secret into an error or a log', () => {
  const src = readFileSync(new URL('../src/booking-identity.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.deepEqual([...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]), ['node:crypto']);
  for (const word of ['process.env', 'console.', 'fetch(', 'writeFile', 'publishBlob(', 'saveBlob', 'withLock', 'diag(', 'setTimeout']) assert.ok(!src.includes(word), word);
  assert.ok(!/throw new Error\(/.test(src), 'the only thrown error carries a fixed code');
});
