// FOUNDER-RUN creation and rotation of the booking-identity keyring (Step 3a; OFFLINE ONLY: nothing in a call or a booking uses this, and nothing imports it except the explicit command file `booking-identity-setup-main.ts`).
//
// CREATE: when no keyring exists, makes generation 1 (one random 32-byte secret, key id k1, nothing retired) in the protected private folder, by the vault's exclusive publication (`publishBlob`: a file is linked into place only if that
// name is free). If ANY keyring file is already there (valid or not) it refuses and changes nothing.
//
// ROTATE: publishes generation n+1 (a new random secret as the current key; the old current key becomes the FIRST retired key; every retired key is kept exactly as it was). It never overwrites and never repairs. It drops a key ONLY when the
// retired list is full, the founder asked for it (`dropOldest`), the OLDEST retired key was retired at least RETIRED_KEY_MIN_AGE_DAYS ago, and a ledger check is given and says nothing is unresolved. It refuses
// unless it can show that rotating now is safe: it holds the booking-identity lock (no booking and no other rotation is running), the chain on disk is strictly valid, it is the generation the founder named, there is room for one more retired
// key, nothing unresolved is reported, and the new chain (dry-run) is valid BEFORE anything is written. After publishing it reads the chain back.
//
// It never shows a secret: a result holds only key ids, counts and a four-character fingerprint, an error holds only a fixed reason, and the command prints words.

import { randomBytes } from 'node:crypto';
import { describe, KEYRING_BASE, loadKeyring, MAX_KEYRING_GENERATION, MAX_RETIRED_KEYS, parseGeneration, retiredLongEnough } from './booking-identity.ts';
import type { KeyringProblem, KeyringVault } from './booking-identity.ts';

/** The protected private folder, as much of it as this file uses (the connector's vault satisfies it). */
export interface SetupVault extends KeyringVault { publishBlob(name: string, text: string, guard: () => void): Promise<'published' | 'exists'> }
/** What a lock hands to the code it runs: `assertHeld` throws unless the holder still owns the lock. */
export interface LockLike { assertHeld(): void }
export interface RotateVault extends SetupVault { withLock<T>(name: string, fn: (lock: LockLike) => Promise<T>, waitMs?: number): Promise<T> }
/** The one lock every booking and every rotation is to hold (the bookings take it in a later step; a rotation takes it now). */
export const IDENTITY_LOCK = 'booking-identity';

export type CreateReason = 'EXISTS' | 'UNREADABLE_STATE' | 'BAD_RANDOM' | 'WRITE_FAILED' | 'VERIFY_FAILED';
export type CreateResult = { ok: true; kid: string; fingerprint: string } | { ok: false; reason: CreateReason };

/** 32 bytes from the random source as a secret, or undefined when they cannot have come from a working source: not 32 bytes, or all one byte value. */
function freshSecret(random: (n: number) => Buffer): string | undefined {
  let bytes: unknown; try { bytes = random(32); } catch { return undefined; }
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32 || bytes.every((b) => b === bytes[0])) return undefined;
  return bytes.toString('base64url');
}

/** Creates generation 1, or refuses with a fixed reason. `random` is for tests only (the default is the operating system's cryptographic random). */
export async function createKeyring(vault: SetupVault, o: { random?: (n: number) => Buffer } = {}): Promise<CreateResult> {
  let existing: number[]; try { existing = vault.generations(KEYRING_BASE); } catch { return { ok: false, reason: 'UNREADABLE_STATE' }; }
  if (existing.length > 0) return { ok: false, reason: 'EXISTS' };   // any generation file, valid or not: nothing is overwritten and nothing is repaired
  const secret = freshSecret(o.random ?? randomBytes); if (secret === undefined) return { ok: false, reason: 'BAD_RANDOM' };
  const text = JSON.stringify({ version: 1, gen: 1, current: { kid: 'k1', secret }, retired: [] });
  if (parseGeneration(text, 1) === undefined) return { ok: false, reason: 'BAD_RANDOM' };
  let outcome: 'published' | 'exists'; try { outcome = await vault.publishBlob(`${KEYRING_BASE}.1`, text, () => undefined); } catch { return { ok: false, reason: 'WRITE_FAILED' }; }
  if (outcome === 'exists') return { ok: false, reason: 'EXISTS' };   // another writer got there first: its file is untouched
  // Read it back through the normal loader: what was published must be what the loader will use.
  const back = await loadKeyring(vault);
  if (!back.ok || back.keyring.gen !== 1 || back.keyring.current.kid !== 'k1' || back.keyring.current.secret !== secret) return { ok: false, reason: 'VERIFY_FAILED' };
  return { ok: true, kid: 'k1', fingerprint: describe(back.keyring).fingerprint };
}

export type RotateReason = 'NO_KEYRING' | 'CHAIN_INVALID' | 'STALE_EXPECTATION' | 'RETENTION_LIMIT' | 'RETENTION_TOO_RECENT' | 'GENERATION_LIMIT' | 'UNRESOLVED' | 'LOCKED' | 'LOCK_LOST' | 'BAD_RANDOM' | 'REUSED_KEY' | 'CONFLICT' | 'WRITE_FAILED' | 'VERIFY_FAILED';
export type RotateResult = { ok: true; gen: number; kid: string; retiredKid: string; retired: number; fingerprint: string; /** The key id of the oldest retired key that was dropped to make room. */ dropped?: string } | { ok: false; reason: RotateReason; problem?: KeyringProblem };
export interface RotateOptions {
  /** The generation the founder is rotating FROM (the one `status` showed). A different generation on disk refuses: two operators cannot rotate twice by mistake. */
  expectGeneration: number;
  /** What is known about unresolved bookings: only 'none' allows a rotation ('some', 'unknown' and a failing check all refuse). */
  unresolved?: () => Promise<'none' | 'some' | 'unknown'>;
  /** With a full retired list: drop the OLDEST retired key to make room (only if it is old enough and `unresolved` is given and says 'none'). Without it a full list refuses. */
  dropOldest?: boolean;
  random?: (n: number) => Buffer; now?: () => number;
  /** How long to wait for the booking-identity lock (default 30000). A booking or another rotation holding it makes a longer wait refuse as LOCKED. */
  lockWaitMs?: number;
}

/** Publishes generation n+1, or refuses with a fixed reason and writes nothing. */
export async function rotateKeyring(vault: RotateVault, o: RotateOptions): Promise<RotateResult> {
  try {
    return await vault.withLock(IDENTITY_LOCK, (lock) => rotateLocked(vault, lock, o), o.lockWaitMs ?? 30_000);
  } catch (e) {
    const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;   // only the fixed code of an error is looked at, never its message
    return { ok: false, reason: code === 'TIMEOUT' ? 'LOCKED' : code === 'LOCK_LOST' ? 'LOCK_LOST' : 'WRITE_FAILED' };
  }
}

async function rotateLocked(vault: RotateVault, lock: LockLike, o: RotateOptions): Promise<RotateResult> {
  const loaded = await loadKeyring(vault);
  if (!loaded.ok) return loaded.problem === 'MISSING' ? { ok: false, reason: 'NO_KEYRING' } : { ok: false, reason: 'CHAIN_INVALID', problem: loaded.problem };
  const prev = loaded.keyring;
  if (!Number.isInteger(o.expectGeneration) || prev.gen !== o.expectGeneration) return { ok: false, reason: 'STALE_EXPECTATION' };
  if (prev.gen >= MAX_KEYRING_GENERATION) return { ok: false, reason: 'GENERATION_LIMIT' };
  const now = (o.now ?? Date.now)(); let kept = prev.retired; let dropped: string | undefined;
  if (prev.retired.length >= MAX_RETIRED_KEYS) {
    if (o.dropOldest !== true) return { ok: false, reason: 'RETENTION_LIMIT' };   // a key is dropped only when the founder asks for it
    if (o.unresolved === undefined) return { ok: false, reason: 'UNRESOLVED' };   // and never without a ledger check
    const oldest = prev.retired[prev.retired.length - 1];
    if (!retiredLongEnough(oldest, now)) return { ok: false, reason: 'RETENTION_TOO_RECENT' };
    kept = prev.retired.slice(0, -1); dropped = oldest.kid;
  }
  if (o.unresolved !== undefined) { let u: 'none' | 'some' | 'unknown'; try { u = await o.unresolved(); } catch { u = 'unknown'; } if (u !== 'none') return { ok: false, reason: 'UNRESOLVED' }; }
  const secret = freshSecret(o.random ?? randomBytes); if (secret === undefined) return { ok: false, reason: 'BAD_RANDOM' };
  if ([prev.current, ...prev.retired].some((k) => k.secret === secret)) return { ok: false, reason: 'REUSED_KEY' };   // a secret already in the keyring is never made current again
  const n = prev.gen + 1; const kid = `k${Number(prev.current.kid.slice(1)) + 1}`;
  const text = JSON.stringify({ version: 1, gen: n, current: { kid, secret }, retired: [{ kid: prev.current.kid, secret: prev.current.secret, retired_at: new Date(now).toISOString() }, ...kept] });
  // Dry run: the whole chain WITH the new generation must be valid (it was never used before, it follows the last one) before a byte is written.
  const dry = await loadKeyring({ generations: () => [...loaded.generations, n], loadBlob: (name) => (name === `${KEYRING_BASE}.${n}` ? Promise.resolve(text) : vault.loadBlob(name)) });
  if (!dry.ok) return { ok: false, reason: dry.problem === 'SUCCESSION' ? 'REUSED_KEY' : 'CHAIN_INVALID', problem: dry.problem };
  if (await vault.publishBlob(`${KEYRING_BASE}.${n}`, text, () => lock.assertHeld()) === 'exists') return { ok: false, reason: 'CONFLICT' };   // the lock is checked right before the link; a taken name is never replaced
  const back = await loadKeyring(vault);
  if (!back.ok || back.keyring.gen !== n || back.keyring.current.kid !== kid || back.keyring.current.secret !== secret || back.keyring.retired[0]?.secret !== prev.current.secret || back.keyring.retired.length !== kept.length + 1) return { ok: false, reason: 'VERIFY_FAILED' };
  return { ok: true, gen: n, kid, retiredKid: prev.current.kid, retired: back.keyring.retired.length, fingerprint: describe(back.keyring).fingerprint, ...(dropped === undefined ? {} : { dropped }) };
}

/** The command line, as a function (the command file only passes the real folder and the real console in): `status` (read-only), `create --confirm` and `rotate`. Prints words, key ids and a fingerprint: never a secret. Returns the exit code. */
export async function runSetup(argv: string[], deps: { vault: RotateVault; say: (s: string) => void; random?: (n: number) => Buffer; now?: () => number; unresolved?: () => Promise<'none' | 'some' | 'unknown'>; lockWaitMs?: number }): Promise<number> {
  const { vault, say } = deps; const cmd = argv[0];
  if (cmd === 'status') {
    const r = await loadKeyring(vault);
    if (r.ok) { const d = describe(r.keyring); say(`booking identity keyring: present (generation ${d.gen}, current key ${d.current}, fingerprint ${d.fingerprint}, ${d.retired.length} retired)`);
      if (deps.unresolved !== undefined) { let u: string; try { u = await deps.unresolved(); } catch { u = 'unknown'; } say(`unresolved bookings in the ledger: ${u === 'none' ? 'none' : u === 'some' ? 'SOME (a rotation would be refused)' : 'UNKNOWN (a rotation would be refused)'}`); }
      return 0; }
    say(r.problem === 'MISSING' ? 'booking identity keyring: absent (nothing has been created)' : `booking identity keyring: PROBLEM ${r.problem}${r.gen === undefined ? '' : ` at generation ${r.gen}`} (nothing was changed)`); return 1;
  }
  if (cmd === 'create') {
    if (!argv.includes('--confirm')) { say('refused: nothing was created. This makes the secret that identifies bookings in the private folder (once; it is never shown and never replaced). Run it again with --confirm to create it.'); return 2; }
    const r = await createKeyring(vault, deps.random === undefined ? {} : { random: deps.random });
    if (r.ok) { say(`created: the booking identity keyring, generation 1, key ${r.kid}, fingerprint ${r.fingerprint}. The secret is stored protected for this Windows user and was not printed.`); return 0; }
    const why: Record<CreateReason, string> = {
      EXISTS: 'a keyring already exists (rotation is a separate step)', UNREADABLE_STATE: 'the private folder could not be read', BAD_RANDOM: 'no usable random secret could be made',
      WRITE_FAILED: 'the file could not be written', VERIFY_FAILED: 'the file was written but could not be read back as expected (run status; do not run create again)',
    };
    say(`refused: ${why[r.reason]}; ${r.reason === 'VERIFY_FAILED' ? 'a file may exist' : 'nothing was changed'} (${r.reason})`); return 1;
  }
  if (cmd === 'rotate') {
    const at = argv.indexOf('--expect-generation'); const expect = at >= 0 && /^[1-9][0-9]{0,2}$/.test(argv[at + 1] ?? '') ? Number(argv[at + 1]) : undefined;
    const missing = ['--confirm', '--no-unresolved-bookings', '--server-stopped'].filter((f) => !argv.includes(f)); if (expect === undefined) missing.push('--expect-generation N');
    if (deps.unresolved === undefined) { say('refused: nothing was rotated. This command has no way to check the booking ledger, so it cannot rule out unresolved bookings (nothing was changed)'); return 2; }
    if (missing.length > 0 || expect === undefined) {
      say(`refused: nothing was rotated. Rotation needs ALL of: --confirm; --no-unresolved-bookings (you confirm no booking is waiting for a person to resolve it); --server-stopped (the Drew server is stopped, and is restarted after); --expect-generation N (the generation that status shows). Missing: ${missing.join(' ')}`); return 2;
    }
    const r = await rotateKeyring(vault, { expectGeneration: expect, ...(argv.includes('--drop-oldest-retired') ? { dropOldest: true } : {}), ...(deps.random === undefined ? {} : { random: deps.random }), ...(deps.now === undefined ? {} : { now: deps.now }), ...(deps.unresolved === undefined ? {} : { unresolved: deps.unresolved }), ...(deps.lockWaitMs === undefined ? {} : { lockWaitMs: deps.lockWaitMs }) });
    if (r.ok) { say(`rotated: generation ${r.gen}, new current key ${r.kid} (fingerprint ${r.fingerprint}); ${r.retiredKid} is retired and kept (${r.retired} retired in all).${r.dropped === undefined ? '' : ` The oldest retired key ${r.dropped} was dropped (it was old enough, and no booking is unresolved).`} No secret was printed. Restart the Drew server before it books again.`); return 0; }
    const why: Record<RotateReason, string> = {
      NO_KEYRING: 'there is no keyring yet (use create)', CHAIN_INVALID: 'the keyring on disk is not valid', STALE_EXPECTATION: 'the keyring is not at the generation you named (run status; nothing is rotated twice by mistake)',
      RETENTION_LIMIT: `the keyring already holds ${MAX_RETIRED_KEYS} retired keys (add --drop-oldest-retired to drop the oldest, once it is old enough)`, RETENTION_TOO_RECENT: 'the oldest retired key is not old enough to drop yet (bookings made under it may still be ahead)', GENERATION_LIMIT: 'the chain is at its last generation', UNRESOLVED: 'unresolved bookings are not ruled out',
      LOCKED: 'a booking or another rotation holds the lock', LOCK_LOST: 'the lock was lost before the file could be published', BAD_RANDOM: 'no usable random secret could be made', REUSED_KEY: 'the new key would reuse an earlier key',
      CONFLICT: 'another writer published that generation first (its file is untouched)', WRITE_FAILED: 'the file could not be written', VERIFY_FAILED: 'the file was written but could not be read back as expected (run status; do not rotate again)',
    };
    say(`refused: ${why[r.reason]}; ${r.reason === 'VERIFY_FAILED' ? 'a file may exist' : 'nothing was changed'} (${r.reason}${r.problem === undefined ? '' : `: ${r.problem}`})`); return 1;
  }
  say('usage: status | create --confirm | rotate --confirm --no-unresolved-bookings --server-stopped --expect-generation N [--drop-oldest-retired]'); return 2;
}
