// The booking IDENTITY (Step 3a foundation; OFFLINE ONLY, not wired into any call or booking yet). A booking is identified by WHAT was booked, not by which call booked it: the callback number, the date, the start time, the house number
// and the ZIP code, run through an HMAC with a secret that only the private folder holds. The same request, however many times the caller rings, gives the same key; a different request gives a different one; and nobody who sees
// a key (it is printed into the Jobber job title and into file names) can work out the phone number, date or address from it without the secret.
//
// The secrets live in a KEYRING: an append-only chain of generation files `booking-identity-keys.<n>` (n = 1, 2, 3 ... with no gap), each published once and never replaced (the vault's `publishBlob`; this file only READS the chain). The
// newest generation holds the current key and the retired ones (a rotation moves the old current into `retired`). Every generation is checked strictly, and so is the way each follows the one before it. Anything unreadable, malformed, gapped,
// over the cap or out of order is a refusal with a fixed reason (never a guess, never a fall-back to an older generation).
//
// NOTHING HERE WRITES: no rotation script, no lock and no Jobber call. It imports no Jobber module, reads no environment variable and logs nothing. Nothing in this file prints, returns in an error or logs a secret: an error carries only a
// fixed code, and `describe` gives the key ids and a four-character fingerprint, never a secret.

import { createHash, createHmac } from 'node:crypto';

export const KEYRING_BASE = 'booking-identity-keys';
/** Most generations a chain may hold (the same cap as the booking ledger's). */
export const MAX_KEYRING_GENERATION = 99;
/** Most retired keys one generation may carry. */
export const MAX_RETIRED_KEYS = 5;

export interface KeyEntry { kid: string; secret: string }
export interface RetiredKey extends KeyEntry { retired_at: string }
export interface Keyring { gen: number; current: KeyEntry; retired: RetiredKey[] }
/** The protected private folder, as much of it as this file uses (the connector's vault satisfies it; this file imports no Jobber module). */
export interface KeyringVault { loadBlob(name: string): Promise<string | undefined>; generations(base: string): number[] }

export type KeyringProblem = 'MISSING' | 'GAP' | 'TOO_MANY' | 'UNREADABLE' | 'MALFORMED' | 'SUCCESSION';
export type KeyringLoad = { ok: true; keyring: Keyring; generations: number[] } | { ok: false; problem: KeyringProblem; gen?: number };

/** A fixed code and nothing else: no value, no secret, no part of the request. */
export class IdentityError extends Error {
  readonly code: 'BAD_PARTS' | 'BAD_SECRET';
  constructor(code: 'BAD_PARTS' | 'BAD_SECRET') { super(code); this.name = 'IdentityError'; this.code = code; }
}

const KID = /^k[1-9][0-9]{0,2}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
/** A secret is exactly 32 random bytes as 43 base64url characters, in the one canonical spelling (43 canonical characters decode to exactly 32 bytes, so no separate length check is needed). */
const secretOk = (s: unknown): s is string => typeof s === 'string' && SECRET.test(s) && Buffer.from(s, 'base64url').toString('base64url') === s;
const isRec = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const exactly = (o: Record<string, unknown>, keys: string[]): boolean => { const k = Object.keys(o); return k.length === keys.length && keys.every((x) => Object.hasOwn(o, x)); };

function entryOk(x: unknown, retired: boolean): x is KeyEntry {
  if (!isRec(x) || !exactly(x, retired ? ['kid', 'secret', 'retired_at'] : ['kid', 'secret'])) return false;
  if (typeof x.kid !== 'string' || !KID.test(x.kid) || !secretOk(x.secret)) return false;
  return !retired || (typeof x.retired_at === 'string' && STAMP.test(x.retired_at) && Number.isFinite(Date.parse(x.retired_at)));
}

/** One generation file, strictly: exactly `{version:1, gen, current, retired}` for the number in its name, every key id and secret well formed, and no id or secret used twice inside it. Undefined when anything is off. */
export function parseGeneration(text: string | undefined, gen: number): Keyring | undefined {
  if (typeof text !== 'string') return undefined;
  let o: unknown; try { o = JSON.parse(text); } catch { return undefined; }
  if (!isRec(o) || !exactly(o, ['version', 'gen', 'current', 'retired']) || o.version !== 1 || o.gen !== gen) return undefined;
  if (!entryOk(o.current, false) || !Array.isArray(o.retired) || o.retired.length > MAX_RETIRED_KEYS || !o.retired.every((r) => entryOk(r, true))) return undefined;
  const current = o.current as KeyEntry; const retired = o.retired as RetiredKey[];
  const all = [current, ...retired];
  if (new Set(all.map((k) => k.kid)).size !== all.length || new Set(all.map((k) => k.secret)).size !== all.length) return undefined;
  return { gen, current: { kid: current.kid, secret: current.secret }, retired: retired.map((r) => ({ kid: r.kid, secret: r.secret, retired_at: r.retired_at })) };
}

const same = (a: KeyEntry, b: KeyEntry): boolean => a.kid === b.kid && a.secret === b.secret;
/** How a generation must follow the one before it: the old current is the FIRST retired key, the other retired keys are kept in order or dropped (never changed, never brought back), and the new current key is new (its id and its secret were never used before). */
function follows(prev: Keyring, next: Keyring, ever: ReadonlySet<string>): boolean {
  if (ever.has(next.current.kid) || ever.has(next.current.secret)) return false;
  if (next.retired.length === 0 || !same(next.retired[0], prev.current)) return false;
  let at = 0;   // the rest must be a subsequence of the previous retired list, entry for entry
  for (const r of next.retired.slice(1)) {
    while (at < prev.retired.length && !(same(prev.retired[at], r) && prev.retired[at].retired_at === r.retired_at)) at++;
    if (at >= prev.retired.length) return false;
    at++;
  }
  return true;
}

/** The whole chain, read and checked: every generation 1..n with no gap (n at most 99), each strictly valid, each following the one before. The newest one is the keyring. Every failure is a fixed reason (and the generation number); nothing is repaired or skipped. */
export async function loadKeyring(vault: KeyringVault): Promise<KeyringLoad> {
  let gens: number[]; try { gens = vault.generations(KEYRING_BASE); } catch { return { ok: false, problem: 'UNREADABLE' }; }
  if (gens.length === 0) return { ok: false, problem: 'MISSING' };
  if (gens[gens.length - 1] > MAX_KEYRING_GENERATION) return { ok: false, problem: 'TOO_MANY', gen: gens[gens.length - 1] };
  for (let i = 0; i < gens.length; i++) if (gens[i] !== i + 1) return { ok: false, problem: 'GAP', gen: i + 1 };
  let prev: Keyring | undefined; const ever = new Set<string>();
  for (const n of gens) {
    let text: string | undefined; try { text = await vault.loadBlob(`${KEYRING_BASE}.${n}`); } catch { return { ok: false, problem: 'UNREADABLE', gen: n }; }
    if (text === undefined) return { ok: false, problem: 'UNREADABLE', gen: n };   // listed, but not there to read
    const k = parseGeneration(text, n); if (k === undefined) return { ok: false, problem: 'MALFORMED', gen: n };
    if (prev === undefined ? k.retired.length !== 0 : !follows(prev, k, ever)) return { ok: false, problem: 'SUCCESSION', gen: n };
    for (const e of [k.current, ...k.retired]) { ever.add(e.kid); ever.add(e.secret); }
    prev = k;
  }
  return { ok: true, keyring: prev as Keyring, generations: gens };
}

/** True only when the chain on disk is exactly the one that was loaded (a rotation, a removal or an unreadable folder all make it false). A process that loaded generation n must stop booking when this is false. */
export function keyringUnchanged(vault: KeyringVault, loaded: readonly number[]): boolean {
  try { const now = vault.generations(KEYRING_BASE); return now.length === loaded.length && now.every((g, i) => g === loaded[i]); } catch { return false; }
}

/** The key ids and a four-character fingerprint of the current secret: what may be shown or logged. Never a secret. */
export function describe(k: Keyring): { gen: number; current: string; retired: string[]; fingerprint: string } {
  return { gen: k.gen, current: k.current.kid, retired: k.retired.map((r) => r.kid), fingerprint: createHash('sha256').update(`drew-keyring-fingerprint:${k.current.secret}`).digest('hex').slice(0, 4) };
}

/** What identifies a booking: nothing that is not part of the booking itself, and no Call SID. `street` is the confirmed street line; only its house number is used (the rest is compared by the Jobber read-back). */
export interface IdentityParts { phone: string; date: string; startTime: string; street: string; zip: string }

/** The parts in their one spelling: a 10-digit number (a leading 1 dropped), a real calendar date, a clock time, the upper-case house number, a five-digit ZIP. A part that is missing or not of that shape is BAD_PARTS (the code only, never the value). */
export function normalizeParts(p: IdentityParts): { phone: string; date: string; start: string; house: string; zip: string } {
  const bad = (): never => { throw new IdentityError('BAD_PARTS'); };
  if (typeof p !== 'object' || p === null || [p.phone, p.date, p.startTime, p.street, p.zip].some((x) => typeof x !== 'string')) return bad();
  let phone = p.phone.replace(/\D/g, ''); if (phone.length === 11 && phone.startsWith('1')) phone = phone.slice(1);
  if (!/^\d{10}$/.test(phone)) return bad();
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p.date); if (d === null) return bad();
  const t = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3])); if (new Date(t).toISOString().slice(0, 10) !== p.date) return bad();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(p.startTime)) return bad();
  if (!/^\d{5}$/.test(p.zip)) return bad();
  const h = /^\s*(\d[\d-]*[A-Za-z]?)\s+\S/.exec(p.street); if (h === null) return bad();
  const house = h[1].toUpperCase(); if (house === p.zip) return bad();   // a ZIP said as a house number is no house number
  return { phone, date: p.date, start: p.startTime, house, zip: p.zip };
}

/** The booking key for these parts under one secret: `fast2-` and 24 hex characters (it can never equal an old Call-SID key, which starts `fast-`). HMAC-SHA256 over one unambiguous string (no part can hold the NUL that separates them). */
export function bookingIdentity(secret: string, parts: IdentityParts): string {
  if (!secretOk(secret)) throw new IdentityError('BAD_SECRET');
  const n = normalizeParts(parts);
  const mac = createHmac('sha256', Buffer.from(secret, 'base64url')).update(`drew-booking-identity-v1\0${n.phone}\0${n.date}\0${n.start}\0${n.house}\0${n.zip}`).digest('hex');
  return `fast2-${mac.slice(0, 24)}`;
}

/** The key to book under (the current secret) and the keys the same booking may already be under (each retired secret, in the keyring's order). */
export function identitiesFor(k: Keyring, parts: IdentityParts): { key: string; aliases: string[] } {
  return { key: bookingIdentity(k.current.secret, parts), aliases: k.retired.map((r) => bookingIdentity(r.secret, parts)) };
}
