// The contact vault for the cleaning pilot (proof of concept, founder test): where a confirmed caller's name, callback number and service address
// are kept, apart from everything else.
//
//   - Its OWN SQLite file (contactsPathFor), never the intake record store, so no dashboard, export or log path can reach it.
//   - Every value is encrypted with AES-256-GCM under a 32-byte key that comes from the environment (FOUNDER_CONTACT_KEY, base64). The key is never
//     written to disk by this program. The row's tenant, call reference and expiry are bound into the encryption as associated data, so a row
//     copied to another call or tenant, or given a later expiry, fails to decrypt.
//   - Rows are keyed by (tenant, call reference). A second write for the same call is refused. There is no update.
//   - Pilot retention: 30 days at most. Expired rows are deleted whenever the vault is opened, written or read, and are never returned.
//   - Failures say nothing about content or keys: generic messages only.
// Like the other SQLite stores this has no database-level tenant isolation: the tenant is in every key and statement, and a test checks it.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const TENANT = /^[A-Za-z0-9_.:-]{1,64}$/;
const CALL_REF = /^[0-9a-f]{16}$/;
const KIND = 'founder-contact-vault';
const VERSION = '1';
const CHECK = 'vault-check';

/**
 * What is known about the address: `confirmed` (read back to the caller, who said yes; NOT checked against any postal or address data), `unconfirmed` (heard, not confirmed, or
 * not answered), `refused` (the caller declined to give one; none is kept). A contact written without a state is `unconfirmed`.
 */
export type AddressState = 'confirmed' | 'unconfirmed' | 'refused';
export interface StoredContact { name: string; phone: string; address?: string; address_state?: AddressState }
export interface VaultEntry { call_ref: string; created_at: string; expires_at: string }
export interface ContactVault {
  /** Stores one confirmed contact. Throws if the call already has one or the values are not usable. */
  put(tenant: string, callRef: string, contact: StoredContact): void;
  /** The decrypted contact, or undefined when there is none or it has expired. Throws if the row has been tampered with. */
  get(tenant: string, callRef: string): StoredContact | undefined;
  /** The address state held for this call, and nothing else: no personal data. Undefined when there is no contact (or it has expired). Throws if the row has been tampered with. */
  addressState(tenant: string, callRef: string): AddressState | undefined;
  /** Metadata only (no personal data), newest first. */
  list(tenant: string): VaultEntry[];
  purgeExpired(): number;
  close(): void;
}

/** The vault file that goes with an intake database path: `x.sqlite` -> `x-contacts.sqlite`. */
export function contactsPathFor(dbPath: string): string {
  if (typeof dbPath !== 'string' || dbPath.length === 0 || dbPath.length > 1000 || dbPath.includes('\0')) throw new RangeError('dbPath must be a file path');
  return `${dbPath.replace(/\.sqlite$/i, '')}-contacts.sqlite`;
}

/** A 32-byte key from a base64 string, or undefined when it is anything else. */
export function keyFromEnv(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/_-]{43}=?$/.test(value.trim())) return undefined;
  const b = Buffer.from(value.trim().replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return b.length === 32 ? b : undefined;
}

const plain = (v: unknown, max: number): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
function assertContact(c: unknown): asserts c is StoredContact {
  const x = c as Record<string, unknown> | null;
  const bad = (): never => { throw new RangeError('the contact is not usable'); };
  if (typeof x !== 'object' || x === null || !Object.keys(x).every((k) => ['address', 'address_state', 'name', 'phone'].includes(k))) return bad();
  if (!plain(x.name, 120) || typeof x.phone !== 'string' || !/^\d{10,15}$/.test(x.phone)) return bad();
  const st = x.address_state;
  if (st !== undefined && st !== 'confirmed' && st !== 'unconfirmed' && st !== 'refused') return bad();
  if (st === 'refused') { if (x.address !== undefined) return bad(); }        // a refused address is not kept
  else if (x.address === undefined) { if (st !== 'unconfirmed') return bad(); } // only an explicitly unconfirmed contact may lack one
  else if (!plain(x.address, 200)) return bad();
}

export function createContactVault(config: { path: string; key: Buffer; now: () => number; retentionDays?: number }): ContactVault {
  const { path, key, now } = config;
  const days = config.retentionDays ?? RETENTION_DAYS;
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) throw new RangeError('path must be a database file path');
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new RangeError('the key must be 32 bytes');
  if (typeof now !== 'function') throw new RangeError('now must be a function');
  if (!Number.isInteger(days) || days < 1 || days > RETENTION_DAYS) throw new RangeError(`retentionDays must be an integer from 1 to ${RETENTION_DAYS}`);

  const seal = (plaintext: string, aad: string): { nonce: Buffer; ct: Buffer } => {
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, nonce);
    c.setAAD(Buffer.from(aad, 'utf8'));
    const body = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return { nonce, ct: Buffer.concat([body, c.getAuthTag()]) };
  };
  const open = (nonce: Uint8Array, ct: Uint8Array, aad: string): string => {
    const buf = Buffer.from(ct);
    if (buf.length < 17) throw new Error('unreadable');
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce));
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(buf.subarray(buf.length - 16));
    return Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8');
  };
  const aadFor = (tenant: string, callRef: string, expires: number): string => `${tenant}\n${callRef}\n${expires}`;

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { timeout: 5000, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false, defensive: true });
    if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT');
    db.exec(`CREATE TABLE IF NOT EXISTS contacts (
      tenant TEXT NOT NULL, call_ref TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, nonce BLOB NOT NULL, ct BLOB NOT NULL,
      PRIMARY KEY (tenant, call_ref)) STRICT`);
    db.exec("CREATE TRIGGER IF NOT EXISTS contacts_no_update BEFORE UPDATE ON contacts BEGIN SELECT RAISE(ABORT, 'no updates'); END");
    const kind = db.prepare('SELECT value FROM meta WHERE key = ?').get('kind') as { value: string } | undefined;
    if (kind === undefined) {
      const s = seal(CHECK, 'meta');
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('kind', KIND);
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('version', VERSION);
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('check', `${s.nonce.toString('base64')}.${s.ct.toString('base64')}`);
    } else {
      if (kind.value !== KIND) throw new Error('kind');
      const ver = db.prepare('SELECT value FROM meta WHERE key = ?').get('version') as { value: string } | undefined;
      const chk = db.prepare('SELECT value FROM meta WHERE key = ?').get('check') as { value: string } | undefined;
      if (ver?.value !== VERSION || chk === undefined) throw new Error('schema');
      const [n, c] = chk.value.split('.');
      if (open(Buffer.from(n, 'base64'), Buffer.from(c ?? '', 'base64'), 'meta') !== CHECK) throw new Error('key');   // the wrong key is found here
    }
  } catch {
    try { db!.close(); } catch { /* nothing to close */ }
    throw new RangeError('the contact vault could not be opened (wrong key, wrong file or unsupported schema)');
  }
  let closed = false;
  const live = (): void => { if (closed) throw new Error('closed'); };
  const okTenant = (t: unknown): t is string => typeof t === 'string' && TENANT.test(t);
  const okRef = (r: unknown): r is string => typeof r === 'string' && CALL_REF.test(r);
  const purge = (): number => Number(db.prepare('DELETE FROM contacts WHERE expires_at <= ?').run(now()).changes);
  purge();

  const api: ContactVault = {
    put(tenant: string, callRef: string, contact: StoredContact): void {
      live();
      if (!okTenant(tenant) || !okRef(callRef)) throw new RangeError('tenant or call reference is not valid');
      assertContact(contact);
      purge();
      const created = now(); const expires = created + days * DAY_MS;
      const s = seal(JSON.stringify({ n: contact.name, p: contact.phone, ...(contact.address !== undefined ? { a: contact.address } : {}), ...(contact.address_state !== undefined ? { s: contact.address_state } : {}) }), aadFor(tenant, callRef, expires));
      try { db.prepare('INSERT INTO contacts (tenant, call_ref, created_at, expires_at, nonce, ct) VALUES (?, ?, ?, ?, ?, ?)').run(tenant, callRef, created, expires, s.nonce, s.ct); }
      catch { throw new Error('the contact could not be stored'); }
    },
    get(tenant: string, callRef: string): StoredContact | undefined {
      live();
      if (!okTenant(tenant) || !okRef(callRef)) throw new RangeError('tenant or call reference is not valid');
      purge();
      const row = db.prepare('SELECT expires_at, nonce, ct FROM contacts WHERE tenant = ? AND call_ref = ?').get(tenant, callRef) as { expires_at: number; nonce: Uint8Array; ct: Uint8Array } | undefined;
      if (row === undefined) return undefined;
      try {
        const p = JSON.parse(open(row.nonce, row.ct, aadFor(tenant, callRef, row.expires_at))) as { n: string; p: string; a?: string; s?: AddressState };
        const c: StoredContact = { name: p.n, phone: p.p, ...(p.a !== undefined ? { address: p.a } : {}), ...(p.s !== undefined ? { address_state: p.s } : {}) };
        assertContact(c);
        return c;
      } catch { throw new Error('the contact is unreadable'); }
    },
    list(tenant: string): VaultEntry[] {
      live();
      if (!okTenant(tenant)) throw new RangeError('tenant is not valid');
      purge();
      const rows = db.prepare('SELECT call_ref, created_at, expires_at FROM contacts WHERE tenant = ? ORDER BY created_at DESC LIMIT 500').all(tenant) as unknown as { call_ref: string; created_at: number; expires_at: number }[];
      return rows.map((r) => ({ call_ref: r.call_ref, created_at: new Date(r.created_at).toISOString(), expires_at: new Date(r.expires_at).toISOString() }));
    },
    addressState(tenant: string, callRef: string): AddressState | undefined {
      const c = api.get(tenant, callRef);
      return c === undefined ? undefined : c.address_state ?? 'unconfirmed';
    },
    purgeExpired(): number { live(); return purge(); },
    close(): void { if (!closed) { closed = true; try { db.close(); } catch { /* already closed */ } } },
  };
  return Object.freeze(api);
}
