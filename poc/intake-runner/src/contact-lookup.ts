// The owner's restricted way to read a confirmed caller's contact (cleaning pilot, proof of concept). A command-line tool, run on this machine only:
//
//   node src/contact-lookup-main.ts --list                 which calls have a contact on file, with the call's time and kind (NO personal data), newest first
//   node src/contact-lookup-main.ts --show <call_ref>      the name, callback number and service address of ONE call, printed to the terminal
//   node src/contact-lookup-main.ts --new-key              a fresh random key for FOUNDER_CONTACT_KEY (printed once; keep it somewhere private)
//
// What restricts it: it needs FOUNDER_CONTACT_KEY (without it nothing can be decrypted), it needs the files on this disk, `--show` prints only to an
// interactive terminal (never into a pipe or a file, so a redirect or a log capture cannot keep the contact), it shows one call at a time, and an
// expired or unknown call shows nothing. There is no network and no web page: the dashboard cannot reach the vault.
// `run` takes its inputs as arguments so a test can drive it; contact-lookup-main.ts runs it for real.

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { contactsPathFor, createContactVault, keyFromEnv } from './contact-vault.ts';
import { createIntakeRecordStore } from './intake-record-store.ts';

export interface LookupIo { out(line: string): void; err(line: string): void; isTty: boolean }

/** Returns the process exit code. */
export function run(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, io: LookupIo, now: () => number = () => Date.now()): number {
  const cfgAt = argv.indexOf('--config');
  const configPath = cfgAt >= 0 && argv[cfgAt + 1] !== undefined ? argv[cfgAt + 1] : 'founder-call.config.json';
  const wants = (flag: string): boolean => argv.includes(flag);

  if (wants('--new-key')) {
    if (!io.isTty) { io.err('refused: the new key is shown only on an interactive terminal'); return 78; }
    io.out(randomBytes(32).toString('base64'));
    return 0;
  }
  if (!wants('--list') && !wants('--show')) { io.err('usage: --list | --show <call_ref> | --new-key   [--config <file>]'); return 64; }

  const key = keyFromEnv(env.FOUNDER_CONTACT_KEY);
  if (key === undefined) { io.err('refused: FOUNDER_CONTACT_KEY is not set to a valid 32-byte key'); return 78; }
  let tenant: string; let dbPath: string;
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as { tenant?: unknown; db_path?: unknown };
    if (typeof cfg.tenant !== 'string' || typeof cfg.db_path !== 'string') throw new Error('config');
    tenant = cfg.tenant; dbPath = cfg.db_path;
  } catch { io.err('refused: the config could not be read'); return 78; }

  let vault: ReturnType<typeof createContactVault>;
  try { vault = createContactVault({ path: contactsPathFor(dbPath), key, now }); }
  catch { io.err('refused: the contact vault could not be opened (wrong key or file)'); return 78; }
  try {
    if (wants('--list')) {
      let records: Array<{ call_ref: string; received_at: string; category: string; confirmation: string }> = [];
      try { const s = createIntakeRecordStore({ path: dbPath }); records = s.list(tenant); s.close(); } catch { /* the list still works without the join */ }
      const byRef = new Map(records.map((r) => [r.call_ref, r]));
      const rows = vault.list(tenant);
      if (rows.length === 0) io.out('No contacts on file.');
      for (const r of rows) {
        const rec = byRef.get(r.call_ref);
        io.out(`${r.call_ref}  call ${rec?.received_at ?? '?'}  ${rec?.category ?? '?'}  stored ${r.created_at}  expires ${r.expires_at}`);
      }
      return 0;
    }
    const at = argv.indexOf('--show');
    const ref = argv[at + 1];
    if (typeof ref !== 'string' || !/^[0-9a-f]{16}$/.test(ref)) { io.err('usage: --show <call_ref> (16 hex characters, from --list)'); return 64; }
    if (!io.isTty) { io.err('refused: a contact is shown only on an interactive terminal, never into a pipe or a file'); return 78; }
    const c = vault.get(tenant, ref);
    if (c === undefined) { io.err('No contact on file for that call (unknown, or past its 30-day retention).'); return 1; }
    io.out(`Name:    ${c.name}`);
    io.out(`Phone:   ${c.phone}`);
    io.out(`Address: ${c.address}`);
    return 0;
  } catch { io.err('refused: the contact could not be read'); return 1; }
  finally { vault.close(); }
}
