// A READ-ONLY scan of the booking ledger in the private folder, for the founder-run keyring commands (Step 3a, slice C; nothing in a call or a booking uses it). It answers one question conservatively: is any booking still UNRESOLVED?
//
// A key's state is its highest ledger generation (jobber-booking.ts). `created` and a cleared (`none`) key are finished. `pending` and `client_created` are NOT: something was started and nobody knows how it ended, so a person must resolve it.
// Anything that cannot be read as exactly what the booking code writes (a gap in the generation numbers, a file that does not decode, a name it does not recognise, a damaged older single-file ledger) is UNKNOWN, never "empty".
// The scan writes nothing, removes nothing, and returns counts and a verdict only: no marker, no job id, no personal detail.

import { readdirSync } from 'node:fs';
import { parseLedgerGeneration, validLedgerEntry } from './jobber-booking.ts';

/** The private folder, as much of it as this scan uses (the connector's vault satisfies it). */
export interface LedgerVault { dir: string; hasBlob(name: string): boolean; loadBlob(name: string): Promise<string | undefined>; generations(base: string): number[] }
export interface LedgerScan {
  /** How many keys have a generation chain. */ chains: number; created: number; cleared: number; pending: number; clientCreated: number;
  /** Chains or files that could not be read as valid. */ unreadable: number;
  /** The older single-file ledger. */ legacy: 'absent' | 'resolved' | 'unresolved' | 'unreadable';
  /** 'none' only when every key is finished and nothing was unreadable. */ verdict: 'none' | 'some' | 'unknown';
}

/** One unresolved key, as the founder's pending-booking report shows it: the booking reference (the marker in the Jobber job's title and instructions, to search for in Jobber), its state, how many ledger steps it has, and whether Jobber ids are HELD (yes or no only: never an id). No name, address, number or key. */
export interface PendingItem { ref: string; state: 'pending' | 'client_created'; step: number; clientHeld: boolean; jobHeld: boolean }
/** The scan plus the unresolved keys listed one by one (sorted by reference). */
export interface PendingReport { scan: LedgerScan; items: PendingItem[] }

const PREFIX = 'jobber-booking-ledger-'; const LEGACY = 'jobber-booking-ledger';
const CHAIN_FILE = /^jobber-booking-ledger-(drewtest-[0-9a-f]{12})\.(0|[1-9][0-9]{0,2})\.enc$/;
const MAX_GENERATION = 99;

async function scanDetailed(vault: LedgerVault): Promise<PendingReport> {
  const items: PendingItem[] = [];
  const s: LedgerScan = { chains: 0, created: 0, cleared: 0, pending: 0, clientCreated: 0, unreadable: 0, legacy: 'absent', verdict: 'unknown' };
  let names: string[]; try { names = readdirSync(vault.dir); } catch { s.unreadable++; return { scan: s, items }; }   // a folder that cannot be listed is unknown, never empty
  const bases = new Set<string>();
  for (const f of names) {
    if (!f.startsWith(PREFIX) || f.endsWith('.tmp')) continue;   // an unfinished temporary file never became a state
    const m = CHAIN_FILE.exec(f); if (m === null) s.unreadable++; else bases.add(m[1]);
  }
  for (const id of [...bases].sort()) {
    s.chains++; const base = `${PREFIX}${id}`; const marker = id.toUpperCase();
    let gens: number[]; try { gens = vault.generations(base); } catch { s.unreadable++; continue; }
    const top = gens[gens.length - 1];
    if (gens.length === 0 || top > MAX_GENERATION || gens.length !== top || gens[0] !== 1) { s.unreadable++; continue; }
    let text: string | undefined; try { text = await vault.loadBlob(`${base}.${top}`); } catch { text = undefined; }
    const entry = parseLedgerGeneration(text, marker, top);
    if (entry === undefined) s.unreadable++;
    else if (entry.state === 'created') s.created++; else if (entry.state === 'none') s.cleared++;
    else {
      if (entry.state === 'pending') s.pending++; else s.clientCreated++;
      items.push({ ref: marker, state: entry.state, step: top, clientHeld: entry.clientId !== undefined && entry.propertyId !== undefined, jobHeld: entry.jobId !== undefined });   // listed, never changed
    }
  }
  if (vault.hasBlob(LEGACY)) {
    s.legacy = 'unreadable';
    let text: string | undefined; try { text = await vault.loadBlob(LEGACY); } catch { text = undefined; }
    if (text !== undefined) {
      let j: unknown; try { j = JSON.parse(text); } catch { j = undefined; }
      const o = typeof j === 'object' && j !== null && !Array.isArray(j) ? j as Record<string, unknown> : {};
      const entries = o.entries;
      if (o.version === 1 && typeof entries === 'object' && entries !== null && !Array.isArray(entries)) {
        const states = Object.values(entries).map((e) => validLedgerEntry(e, false));
        s.legacy = states.some((e) => e === undefined) ? 'unreadable' : states.some((e) => e?.state === 'pending' || e?.state === 'client_created') ? 'unresolved' : 'resolved';
      }
    }
    if (s.legacy === 'unreadable') s.unreadable++;
  }
  s.verdict = s.pending + s.clientCreated > 0 || s.legacy === 'unresolved' ? 'some' : s.unreadable > 0 ? 'unknown' : 'none';
  return { scan: s, items };
}

/** The scan the keyring commands rely on: counts and a verdict only (its shape is unchanged). */
export async function scanLedger(vault: LedgerVault): Promise<LedgerScan> { return (await scanDetailed(vault)).scan; }

/** The founder's PENDING-BOOKING REPORT: the same read-only scan, with each unresolved key listed (reference, state, step, whether ids are held). It writes nothing, retries nothing, resolves nothing and clears nothing; a scan that fails is `unknown` with no items. */
export async function pendingReport(vault: LedgerVault): Promise<PendingReport> {
  try { return await scanDetailed(vault); }   // the scan visits the keys in sorted order, so the items are sorted by reference
  catch { return { scan: { chains: 0, created: 0, cleared: 0, pending: 0, clientCreated: 0, unreadable: 1, legacy: 'absent', verdict: 'unknown' }, items: [] }; }
}

/** The answer the keyring rotation asks for: anything but 'none' refuses it (and a scan that fails is 'unknown'). */
export async function ledgerUnresolved(vault: LedgerVault): Promise<'none' | 'some' | 'unknown'> {
  try { return (await scanLedger(vault)).verdict; } catch { return 'unknown'; }
}
