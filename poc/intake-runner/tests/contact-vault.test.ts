// contact-vault.ts and the owner's restricted lookup. Invented people only. The raw values live in this test; the assertions are that they are NOT in the file.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { contactsPathFor, createContactVault, keyFromEnv, RETENTION_DAYS } from '../src/contact-vault.ts';
import { run } from '../src/contact-lookup.ts';

const dir = mkdtempSync(join(tmpdir(), 'contact-vault-'));
const open: Array<{ close(): void }> = [];
after(() => { for (const v of open) try { v.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });
let n = 0;
const T = 'ws-founder-cleaning'; const OTHER = 'ws-founder-other';
const REF = 'a1b2c3d4e5f60718'; const REF2 = '0123456789abcdef';
const C = { name: 'Priya Raman', phone: '5550100123', address: '42 Elm Street' };
const DAY = 86_400_000;
const fileBytes = (path: string) => readdirSync(dir).filter((f) => f.startsWith(path.split(/[\\/]/).pop() as string)).map((f) => readFileSync(join(dir, f)).toString('latin1')).join('');
const make = (o: { key?: Buffer; now?: () => number; path?: string; retentionDays?: number } = {}) => {
  const path = o.path ?? join(dir, `v${++n}.sqlite`);
  const clock = { t: 1_800_000_000_000 };
  const vault = createContactVault({ path, key: o.key ?? randomBytes(32), now: o.now ?? (() => clock.t), retentionDays: o.retentionDays });
  open.push(vault);
  return { vault, path, clock };
};

test('keyFromEnv: exactly 32 bytes of base64, nothing else', () => {
  const k = randomBytes(32);
  assert.deepEqual(keyFromEnv(k.toString('base64')), k);
  assert.deepEqual(keyFromEnv(k.toString('base64url')), k);
  for (const bad of [undefined, '', 'short', randomBytes(16).toString('base64'), randomBytes(33).toString('base64'), 'x'.repeat(43) + '!', 5]) assert.equal(keyFromEnv(bad), undefined, String(bad));
});

test('the vault stores a contact encrypted: the file holds none of the values, and the same key reads them back', () => {
  const key = randomBytes(32);
  const a = make({ key });
  a.vault.put(T, REF, C);
  assert.deepEqual(a.vault.get(T, REF), C);
  a.vault.close();
  const bytes = fileBytes(a.path);
  for (const secret of [C.name, 'Priya', 'Raman', C.phone, '555', 'Elm', C.address]) assert.ok(!bytes.includes(secret), `the vault file must not contain "${secret}"`);
  const again = createContactVault({ path: a.path, key, now: () => a.clock.t });
  assert.deepEqual(again.get(T, REF), C, 'it survives a restart');
  again.close();
});

test('the wrong key, or a file of another kind, cannot open the vault', () => {
  const a = make(); a.vault.put(T, REF, C); a.vault.close();
  assert.throws(() => createContactVault({ path: a.path, key: randomBytes(32), now: () => 0 }), (e: Error) => e instanceof RangeError && !/Priya|key bytes/.test(e.message));
  const other = join(dir, 'not-a-vault.sqlite');
  const db = new DatabaseSync(other); db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; INSERT INTO meta VALUES ('kind', 'something-else')"); db.close();
  assert.throws(() => createContactVault({ path: other, key: randomBytes(32), now: () => 0 }), RangeError);
  assert.throws(() => createContactVault({ path: join(dir, 'x.sqlite'), key: randomBytes(16), now: () => 0 }), RangeError);
});

test('rows are bound to their tenant and call: a copied row, a moved row and a later expiry all fail to decrypt', () => {
  const a = make();
  a.vault.put(T, REF, C);
  assert.equal(a.vault.get(OTHER, REF), undefined, 'another tenant sees nothing');
  assert.deepEqual(a.vault.list(OTHER), []);
  const db = new DatabaseSync(a.path);
  const row = db.prepare('SELECT * FROM contacts').get() as any;
  db.prepare('INSERT INTO contacts (tenant, call_ref, created_at, expires_at, nonce, ct) VALUES (?, ?, ?, ?, ?, ?)').run(T, REF2, row.created_at, row.expires_at, row.nonce, row.ct);   // moved to another call
  db.prepare('INSERT INTO contacts (tenant, call_ref, created_at, expires_at, nonce, ct) VALUES (?, ?, ?, ?, ?, ?)').run(OTHER, REF, row.created_at, row.expires_at, row.nonce, row.ct);   // moved to another tenant
  db.prepare('INSERT INTO contacts (tenant, call_ref, created_at, expires_at, nonce, ct) VALUES (?, ?, ?, ?, ?, ?)').run(T, 'ffffffffffffffff', row.created_at, row.expires_at + 90 * DAY, row.nonce, row.ct);   // longer life
  assert.throws(() => db.prepare("UPDATE contacts SET expires_at = expires_at + 1").run(), /no updates/, 'rows cannot be updated in place');
  db.close();
  assert.throws(() => a.vault.get(T, REF2), /unreadable/);
  assert.throws(() => a.vault.get(OTHER, REF), /unreadable/);
  assert.throws(() => a.vault.get(T, 'ffffffffffffffff'), /unreadable/);
  assert.deepEqual(a.vault.get(T, REF), C, 'the genuine row still reads');
});

test('one contact per call: a second write is refused and nothing changes', () => {
  const a = make();
  a.vault.put(T, REF, C);
  assert.throws(() => a.vault.put(T, REF, { ...C, phone: '5550100999' }), /could not be stored/);
  assert.deepEqual(a.vault.get(T, REF), C);
  assert.equal(a.vault.list(T).length, 1);
});

test('retention: 30 days at most; an expired contact is never returned and is deleted', () => {
  assert.equal(RETENTION_DAYS, 30);
  const a = make();
  a.vault.put(T, REF, C);
  const [entry] = a.vault.list(T);
  assert.equal(Date.parse(entry.expires_at) - Date.parse(entry.created_at), 30 * DAY);
  assert.ok(!JSON.stringify(a.vault.list(T)).match(/Priya|555|Elm/), 'the listing carries no personal data');
  a.clock.t += 30 * DAY - 1;
  assert.deepEqual(a.vault.get(T, REF), C, 'still there a moment before 30 days');
  a.clock.t += 1;
  assert.equal(a.vault.get(T, REF), undefined, 'gone at 30 days');
  assert.deepEqual(a.vault.list(T), []);
  const db = new DatabaseSync(a.path); assert.equal((db.prepare('SELECT count(*) AS c FROM contacts').get() as any).c, 0, 'deleted, not just hidden'); db.close();
  for (const days of [0, 31, 1.5]) assert.throws(() => make({ retentionDays: days }), RangeError, String(days));
  const short = make({ retentionDays: 1 }); short.vault.put(T, REF, C); short.clock.t += DAY; assert.equal(short.vault.get(T, REF), undefined);
});

test('purgeExpired removes only expired rows, and writing a new contact also clears old ones', () => {
  const a = make();
  a.vault.put(T, REF, C);
  a.clock.t += 31 * DAY;
  a.vault.put(T, REF2, { ...C, phone: '5550100124' });
  assert.deepEqual(a.vault.list(T).map((e) => e.call_ref), [REF2]);
  assert.equal(a.vault.purgeExpired(), 0);
});

test('validation: unusable contacts, bad ids and extra keys are refused before anything is written', () => {
  const a = make();
  for (const bad of [{ ...C, phone: '555' }, { ...C, phone: '555-010-0123' }, { ...C, name: '' }, { ...C, address: 'x'.repeat(201) }, { ...C, name: 'a\nb' }, { ...C, extra: 'x' }, { name: 'x', phone: '5550100123' }, null]) {
    assert.throws(() => a.vault.put(T, REF, bad as never), RangeError, JSON.stringify(bad));
  }
  assert.throws(() => a.vault.put('bad tenant', REF, C), RangeError);
  assert.throws(() => a.vault.put(T, 'not-a-ref', C), RangeError);
  assert.deepEqual(a.vault.list(T), []);
  a.vault.close();
  assert.throws(() => a.vault.get(T, REF));
});

test('contactsPathFor: a separate file beside the intake database', () => {
  assert.equal(contactsPathFor('founder-call.sqlite'), 'founder-call-contacts.sqlite');
  assert.equal(contactsPathFor('C:/x/calls.SQLITE'), 'C:/x/calls-contacts.sqlite');
  assert.equal(contactsPathFor('data'), 'data-contacts.sqlite');
  assert.throws(() => contactsPathFor(''), RangeError);
});

// ---------------------------------------------------------------- the owner's restricted lookup
function lookupRig() {
  const key = randomBytes(32);
  const dbPath = join(dir, `calls${++n}.sqlite`);
  const cfg = join(dir, `cfg${n}.json`);
  writeFileSync(cfg, JSON.stringify({ tenant: T, db_path: dbPath }));
  const v = createContactVault({ path: contactsPathFor(dbPath), key, now: () => Date.now() });
  v.put(T, REF, C); v.close();
  const io = (isTty: boolean) => { const out: string[] = []; const err: string[] = []; return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), isTty } }; };
  return { key: key.toString('base64'), cfg, io };
}

test('lookup: --list shows which calls have a contact, never the contact; --show prints one contact, only to an interactive terminal and only with the key', () => {
  const r = lookupRig();
  let o = r.io(false);
  assert.equal(run(['--list', '--config', r.cfg], { FOUNDER_CONTACT_KEY: r.key }, o.io), 0);
  assert.ok(o.out.join('\n').includes(REF) && !/Priya|Raman|555|Elm/.test(o.out.join('\n')));

  o = r.io(false);
  assert.equal(run(['--show', REF, '--config', r.cfg], { FOUNDER_CONTACT_KEY: r.key }, o.io), 78, 'a pipe or a file gets nothing');
  assert.deepEqual(o.out, []);

  o = r.io(true);
  assert.equal(run(['--show', REF, '--config', r.cfg], { FOUNDER_CONTACT_KEY: r.key }, o.io), 0);
  assert.deepEqual(o.out, ['Name:    Priya Raman', 'Phone:   5550100123', 'Address: 42 Elm Street']);

  for (const env of [{}, { FOUNDER_CONTACT_KEY: randomBytes(32).toString('base64') }, { FOUNDER_CONTACT_KEY: 'nope' }]) {
    o = r.io(true);
    assert.notEqual(run(['--show', REF, '--config', r.cfg], env, o.io), 0);
    assert.deepEqual(o.out, [], 'no key or the wrong key shows nothing');
    assert.ok(!/Priya|555|Elm/.test(o.err.join('')));
  }
  o = r.io(true);
  assert.equal(run(['--show', 'ffffffffffffffff', '--config', r.cfg], { FOUNDER_CONTACT_KEY: r.key }, o.io), 1);
  assert.equal(run(['--show', '../etc', '--config', r.cfg], { FOUNDER_CONTACT_KEY: r.key }, r.io(true).io), 64);
  assert.equal(run([], {}, r.io(true).io), 64);
});

test('lookup: an expired contact shows nothing, and --new-key prints a valid key only to a terminal', () => {
  const r = lookupRig();
  const later = () => Date.now() + 31 * DAY;
  const o = r.io(true);
  assert.equal(run(['--show', REF, '--config', r.cfg], { FOUNDER_CONTACT_KEY: r.key }, o.io, later), 1);
  assert.deepEqual(o.out, []);
  const k = r.io(true);
  assert.equal(run(['--new-key'], {}, k.io), 0);
  assert.ok(keyFromEnv(k.out[0]) !== undefined);
  const piped = r.io(false);
  assert.equal(run(['--new-key'], {}, piped.io), 78);
  assert.deepEqual(piped.out, []);
});
