// Founder-run command for the booking-identity keyring (Step 3a; nothing else imports this file).
//
//   node src/booking-identity-setup-main.ts status             read-only: is the keyring present, which generation, which key id, a four-character fingerprint. Never a secret.
//   node src/booking-identity-setup-main.ts create --confirm   makes generation 1 once (a random secret, stored protected for this Windows user). Refuses if any keyring file already exists; never overwrites; never prints the secret.
//
// The private folder is JOBBER_STORE_DIR, or ".drew-jobber" in the user's home folder (outside the repository).

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createVault } from './jobber-connector.ts';
import { windowsProtector } from './jobber-dpapi.ts';
import { ledgerUnresolved } from './jobber-ledger-scan.ts';
import { runSetup } from './booking-identity-setup.ts';

const dir = process.env.JOBBER_STORE_DIR ?? join(homedir(), '.drew-jobber');
const vault = createVault(dir, windowsProtector());
runSetup(process.argv.slice(2), { vault, say: (s) => { console.log(s); }, unresolved: () => ledgerUnresolved(vault) }).then((c) => { process.exitCode = c; }, () => { console.error('failed: the setup could not run (nothing was printed from the secret)'); process.exitCode = 1; });
