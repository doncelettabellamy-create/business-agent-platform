// The owner's restricted way to mark a follow-up HANDLED or REOPEN it (Stage 1, G4; cleaning pilot, proof of concept). A command-line tool, run on this machine only:
//   node src/followup-main.ts --list                         the open and handled follow-ups: call reference, when, kind (call or notice) and state. NO personal data and no sentence from any record.
//   node src/followup-main.ts --handled <call_ref> --confirm  appends a "handled" marker for one OPEN follow-up
//   node src/followup-main.ts --reopen <call_ref> --confirm   appends a "reopened" marker for one HANDLED follow-up
//                                                             [--config <file>]  (default founder-voice-call.config.json: its tenant and db_path)
//
// What restricts it (the same as the contact lookup, which it is modelled on): it needs FOUNDER_CONTACT_KEY to be a valid key AND to open the existing encrypted contact vault (a wrong key is refused; this tool never creates the vault),
// a change is made only from an interactive terminal and only with --confirm, it reads and writes ONE tenant (the config's) so another tenant's records are not found, and there is no network and no web page: the dashboard stays read-only.
// What it does: it only ever APPENDS a marker (src/followup-marker.ts). It never edits, deletes or purges anything, so every record and every earlier marker stays. The marker's identity is deterministic, so repeating a command
// changes nothing ("already handled" / "already open") and two people racing for the same step cannot both write it. The result is read back before it is reported.
// `run` takes its inputs as arguments so a test can drive it; followup-main.ts runs it for real.

import { existsSync, readFileSync } from 'node:fs';
import { contactsPathFor, createContactVault, keyFromEnv } from './contact-vault.ts';
import { createIntakeRecordStore } from './intake-record-store.ts';
import type { IntakeRecord, IntakeRecordStore } from './intake-record-store.ts';
import { followUpState, markerCallRef, markerRecord, MARKER_CATEGORY, MAX_TRANSITIONS, parseMarker } from './followup-marker.ts';
import type { FollowUpAction } from './followup-marker.ts';
import { toOwnerCall } from './owner-view.ts';

export interface FollowUpIo { out(line: string): void; err(line: string): void; isTty: boolean }
const REF = /^[0-9a-f]{16}$/;
const USAGE = 'usage: --list | --handled <call_ref> --confirm | --reopen <call_ref> --confirm   [--config <file>]';
const canon = (x: unknown): string => JSON.stringify(x, (_k, v) => (typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : v));

interface Parsed { command: 'list' | 'handled' | 'reopen'; ref?: string; confirm: boolean; config: string }
/** Strict: exactly one command, known flags only, each value flag with a value. Anything else is undefined (usage). */
function parse(argv: readonly string[]): Parsed | undefined {
  let command: Parsed['command'] | undefined; let ref: string | undefined; let confirm = false; let config: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') { if (command !== undefined) return undefined; command = 'list'; }
    else if (a === '--handled' || a === '--reopen') { if (command !== undefined) return undefined; command = a === '--handled' ? 'handled' : 'reopen'; ref = argv[++i]; if (typeof ref !== 'string') return undefined; }
    else if (a === '--confirm') { if (confirm) return undefined; confirm = true; }
    else if (a === '--config') { if (config !== undefined) return undefined; config = argv[++i]; if (typeof config !== 'string' || config.startsWith('--')) return undefined; }
    else return undefined;
  }
  if (command === undefined) return undefined;
  if (command === 'list' && confirm) return undefined;
  return { command, ...(ref === undefined ? {} : { ref }), confirm, config: config ?? 'founder-voice-call.config.json' };
}

type Change = 'written' | 'already' | 'not_found' | 'not_a_follow_up' | 'not_handled' | 'too_many' | 'failed';
/** Appends the marker that moves follow-up `ref` to `want`, or reports why not. Reads, writes and reads back in ONE tenant. Never throws. */
export function changeFollowUp(store: IntakeRecordStore, tenant: string, ref: string, want: FollowUpAction, now: () => number): Change {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {   // a second pass only if another writer took the same step first
      const records = store.list(tenant);
      const target = records.find((r) => r.call_ref === ref && r.category !== MARKER_CATEGORY);
      if (target === undefined) return 'not_found';
      if (!toOwnerCall(target).needsFollowUp) return 'not_a_follow_up';
      const cur = followUpState(records).get(ref); const handled = cur?.handled === true;
      if (want === 'handled' && handled) return 'already';
      if (want === 'reopened' && !handled) return cur === undefined ? 'not_handled' : 'already';
      const n = (cur?.n ?? 0) + 1; if (n > MAX_TRANSITIONS) return 'too_many';
      const rec = markerRecord(tenant, ref, n, want, now());
      if (store.put(tenant, rec) === 'duplicate') continue;   // somebody else wrote step n: decide again from what is there now
      const back = store.list(tenant).find((r) => r.call_ref === markerCallRef(tenant, ref, n));
      if (back === undefined || parseMarker(back)?.action !== want || canon(back) !== canon(rec)) return 'failed';
      return followUpState(store.list(tenant)).get(ref)?.handled === (want === 'handled') ? 'written' : 'failed';
    }
    return 'failed';
  } catch { return 'failed'; }
}

/** Returns the process exit code. */
export function run(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, io: FollowUpIo, now: () => number = () => Date.now()): number {
  const p = parse(argv);
  if (p === undefined) { io.err(USAGE); return 64; }
  if (p.command !== 'list') {
    if (p.ref === undefined || !REF.test(p.ref)) { io.err('usage: a call reference is 16 hex characters (from --list)'); return 64; }
    if (!io.isTty) { io.err('refused: a follow-up is changed only from an interactive terminal'); return 78; }
    if (!p.confirm) { io.err('refused: add --confirm to make this change (the opposite command reverses it; no record is ever removed)'); return 78; }
  }
  const key = keyFromEnv(env.FOUNDER_CONTACT_KEY);
  if (key === undefined) { io.err('refused: FOUNDER_CONTACT_KEY is not set to a valid 32-byte key'); return 78; }
  let tenant: string; let dbPath: string;
  try {
    const cfg = JSON.parse(readFileSync(p.config, 'utf8')) as { tenant?: unknown; db_path?: unknown };
    if (typeof cfg.tenant !== 'string' || typeof cfg.db_path !== 'string') throw new Error('config');
    tenant = cfg.tenant; dbPath = cfg.db_path;
  } catch { io.err('refused: the config could not be read'); return 78; }
  try {   // the key must open the EXISTING encrypted contact vault: the same proof of ownership the contact lookup asks for. This tool never creates it.
    const vaultPath = contactsPathFor(dbPath); if (!existsSync(vaultPath)) throw new Error('missing');
    createContactVault({ path: vaultPath, key, now }).close();
  } catch { io.err('refused: the contact vault could not be opened (wrong key or file)'); return 78; }

  let store: IntakeRecordStore;
  try { store = createIntakeRecordStore({ path: dbPath }); } catch { io.err('refused: the record store could not be opened'); return 78; }
  try {
    if (p.command === 'list') {
      let records: IntakeRecord[]; try { records = store.list(tenant); } catch { io.err('refused: the records could not be read'); return 1; }
      const state = followUpState(records); let shown = 0;
      for (const r of records) {
        if (r.category === MARKER_CATEGORY) continue;
        const c = toOwnerCall(r); const handled = state.get(r.call_ref)?.handled === true;
        if (!c.needsFollowUp) continue;
        io.out(`${r.call_ref}  ${r.received_at}  ${c.kind === 'notice' ? 'notice' : 'call'}  ${handled ? 'handled' : 'open'}`); shown++;
      }
      if (shown === 0) io.out('No follow-ups.');
      return 0;
    }
    const want: FollowUpAction = p.command === 'handled' ? 'handled' : 'reopened';
    const r = changeFollowUp(store, tenant, p.ref as string, want, now);
    switch (r) {
      case 'written': io.out(want === 'handled' ? 'Marked handled. The original record is unchanged.' : 'Reopened. The original record is unchanged.'); return 0;
      case 'already': io.out(want === 'handled' ? 'Already handled. Nothing was written.' : 'Already open. Nothing was written.'); return 0;
      case 'not_found': io.err('No follow-up with that call reference in this tenant.'); return 1;
      case 'not_a_follow_up': io.err('That call does not need follow-up, so there is nothing to mark.'); return 1;
      case 'not_handled': io.out('Already open (it was never marked handled). Nothing was written.'); return 0;
      case 'too_many': io.err('refused: this follow-up has been changed too many times.'); return 1;
      default: io.err('failed: the change could not be saved and read back. Nothing is known to have changed; run --list.'); return 1;
    }
  } finally { try { store.close(); } catch { /* already closed */ } }
}
