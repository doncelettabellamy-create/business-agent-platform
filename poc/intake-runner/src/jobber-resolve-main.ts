// Founder-run command: resolve ONE unresolved booking (nothing else imports this file; the logic and its rules are in jobber-resolve.ts).
//
//   node src/jobber-resolve-main.ts --ref DREWTEST-XXXXXXXXXXXX --expect-name "<the Jobber test account name>"
//        DRY RUN: one read-only Jobber lookup (an API READ), then says whether --adopt would be allowed. Changes nothing.
//   node src/jobber-resolve-main.ts --ref DREWTEST-XXXXXXXXXXXX --expect-name "<name>" --adopt --confirm
//        records the ONE verified matching job in the ledger. There is no --clear.
//
// Run it only with the Drew server idle (no call in progress), after taking a dated copy of the ledger files, and each run is its own founder approval (it reads Jobber). The private folder is JOBBER_STORE_DIR, or ".drew-jobber" in the user's home folder.

import { createVault, GRAPHQL_VERSION, JOBBER_ENDPOINTS } from './jobber-connector.ts';
import type { Ctx, FetchLike } from './jobber-connector.ts';
import { windowsProtector } from './jobber-dpapi.ts';
import { privateFolder } from './private-folder.ts';
import { runResolve } from './jobber-resolve.ts';

const vault = createVault(privateFolder(), windowsProtector());   // fail-closed: a test run never gets the real folder (private-folder.ts)
const say = (s: string): void => { console.log(s); };
// A READ-ONLY connector: no `allowWrites`, so `mutate` refuses everything. Diagnostics are dropped (the words printed here are the whole output).
const ctx: Ctx = { vault, endpoints: JOBBER_ENDPOINTS, fetch: globalThis.fetch as unknown as FetchLike, now: () => Date.now(), diag: () => undefined, version: GRAPHQL_VERSION };
vault.loadCredentials().then(async (creds) => {
  if (creds === undefined) { say('refused: no Jobber credentials are stored on this machine (nothing was read or changed)'); process.exitCode = 2; return; }
  process.exitCode = await runResolve(process.argv.slice(2), { ctx, creds, say });
}, () => { console.error('failed: the resolve command could not run (nothing was changed)'); process.exitCode = 1; });
