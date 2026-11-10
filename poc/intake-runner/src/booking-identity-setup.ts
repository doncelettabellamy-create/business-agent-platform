// FOUNDER-RUN creation of the booking-identity keyring (Step 3a; OFFLINE ONLY: nothing in a call or a booking uses this, and nothing imports it except the explicit command file `booking-identity-setup-main.ts`). It does ONE thing: when
// no keyring exists, it makes generation 1 (one random 32-byte secret, key id k1, nothing retired) in the protected private folder, by the vault's exclusive publication (`publishBlob`: a file is linked into place only if that name is free).
// It never overwrites, repairs or rotates: if ANY keyring file is already there (valid or not) it refuses and changes nothing. It never shows a secret: a result holds only the key id and a four-character fingerprint, an error holds only a
// fixed reason, and the command prints words. Rotation is a separate step (not here).

import { randomBytes } from 'node:crypto';
import { describe, KEYRING_BASE, loadKeyring, parseGeneration } from './booking-identity.ts';
import type { KeyringVault } from './booking-identity.ts';

/** The protected private folder, as much of it as this file uses (the connector's vault satisfies it). */
export interface SetupVault extends KeyringVault { publishBlob(name: string, text: string, guard: () => void): Promise<'published' | 'exists'> }
export type CreateReason = 'EXISTS' | 'UNREADABLE_STATE' | 'BAD_RANDOM' | 'WRITE_FAILED' | 'VERIFY_FAILED';
export type CreateResult = { ok: true; kid: string; fingerprint: string } | { ok: false; reason: CreateReason };

/** Creates generation 1, or refuses with a fixed reason. `random` is for tests only (the default is the operating system's cryptographic random). */
export async function createKeyring(vault: SetupVault, o: { random?: (n: number) => Buffer } = {}): Promise<CreateResult> {
  let existing: number[]; try { existing = vault.generations(KEYRING_BASE); } catch { return { ok: false, reason: 'UNREADABLE_STATE' }; }
  if (existing.length > 0) return { ok: false, reason: 'EXISTS' };   // any generation file, valid or not: nothing is overwritten and nothing is repaired
  let bytes: unknown; try { bytes = (o.random ?? randomBytes)(32); } catch { return { ok: false, reason: 'BAD_RANDOM' }; }
  // A secret that is not 32 bytes, or has no variety at all (all one byte value), cannot have come from a working random source: refuse it.
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32 || bytes.every((b) => b === bytes[0])) return { ok: false, reason: 'BAD_RANDOM' };
  const secret = bytes.toString('base64url');
  const text = JSON.stringify({ version: 1, gen: 1, current: { kid: 'k1', secret }, retired: [] });
  if (parseGeneration(text, 1) === undefined) return { ok: false, reason: 'BAD_RANDOM' };
  let outcome: 'published' | 'exists'; try { outcome = await vault.publishBlob(`${KEYRING_BASE}.1`, text, () => undefined); } catch { return { ok: false, reason: 'WRITE_FAILED' }; }
  if (outcome === 'exists') return { ok: false, reason: 'EXISTS' };   // another writer got there first: its file is untouched
  // Read it back through the normal loader: what was published must be what the loader will use.
  const back = await loadKeyring(vault);
  if (!back.ok || back.keyring.gen !== 1 || back.keyring.current.kid !== 'k1' || back.keyring.current.secret !== secret) return { ok: false, reason: 'VERIFY_FAILED' };
  return { ok: true, kid: 'k1', fingerprint: describe(back.keyring).fingerprint };
}

/** The command line, as a function (the command file only passes the real folder and the real console in): `status` (read-only) and `create --confirm`. Prints words, key ids and a fingerprint: never a secret. Returns the exit code. */
export async function runSetup(argv: string[], deps: { vault: SetupVault; say: (s: string) => void; random?: (n: number) => Buffer }): Promise<number> {
  const { vault, say } = deps; const cmd = argv[0];
  if (cmd === 'status') {
    const r = await loadKeyring(vault);
    if (r.ok) { const d = describe(r.keyring); say(`booking identity keyring: present (generation ${d.gen}, current key ${d.current}, fingerprint ${d.fingerprint}, ${d.retired.length} retired)`); return 0; }
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
  say('usage: status | create --confirm'); return 2;
}
