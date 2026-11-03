// Minimal, PROTECTED evidence of text consent (proof of concept). One record per consent decision: who gave it (role), when, which script, the answer, how it was given, and an opaque reference. NO phone number, name, address
// or words are stored. The records live in the private folder as a protected file (the same protection as the tokens), capped, written under a lock. The owner's setup record is tied to the owner number by a hash held only
// inside the protected file, so changing the owner number cancels the consent.

import { createHash } from 'node:crypto';
import { OWNER_SCRIPT_ID } from './fast-sms-copy.ts';

export const CONSENT_BLOB = 'consent-evidence';
export interface ConsentEvidence { v: 1; role: 'customer' | 'owner'; at: string; script: string; result: 'yes' | 'no'; method: 'call_verbal' | 'private_setup'; ref: string }
/** The protected private folder, as much of it as this file uses (the connector's vault satisfies it; this file imports no Jobber module). */
export interface Vault { loadBlob(name: string): Promise<string | undefined>; saveBlob(name: string, text: string): Promise<void>; withLock<T>(name: string, fn: () => Promise<T>, waitMs?: number): Promise<T> }
const MAX_RECORDS = 500;
const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 24);
export const callRef = (callSid: unknown): string => sha(`consent-call:${String(callSid)}`);
export const ownerRef = (ownerNumber: string): string => sha(`consent-owner:${ownerNumber}`);

function valid(x: unknown): x is ConsentEvidence {
  if (typeof x !== 'object' || x === null) return false; const e = x as Record<string, unknown>;
  return e.v === 1 && (e.role === 'customer' || e.role === 'owner') && typeof e.at === 'string' && !Number.isNaN(Date.parse(e.at)) && typeof e.script === 'string' && /^[a-z0-9-]{3,40}$/.test(e.script)
    && (e.result === 'yes' || e.result === 'no') && (e.method === 'call_verbal' || e.method === 'private_setup') && typeof e.ref === 'string' && /^[0-9a-f]{24}$/.test(e.ref) && Object.keys(e).length === 7;
}
export async function readConsent(vault: Vault): Promise<ConsentEvidence[]> {
  const t = await vault.loadBlob(CONSENT_BLOB); if (t === undefined) return [];
  try { const j = JSON.parse(t) as unknown; return Array.isArray(j) ? j.filter(valid) : []; } catch { return []; }
}
/** Appends one record; true only when it was written (a refused or failed write means no text may rely on it). */
export async function appendConsent(vault: Vault, e: ConsentEvidence): Promise<boolean> {
  if (!valid(e)) return false;
  try { return await vault.withLock('consent', async () => { const all = await readConsent(vault); all.push(e); await vault.saveBlob(CONSENT_BLOB, JSON.stringify(all.slice(-MAX_RECORDS))); return true; }); } catch { return false; }
}
/** Is the owner's setup consent on record, for exactly this owner number and the current script? The LATEST owner record counts, so a later "no" cancels an earlier yes. */
export async function ownerConsentOn(vault: Vault, ownerNumber: string): Promise<boolean> {
  const last = (await readConsent(vault)).filter((e) => e.role === 'owner').at(-1);
  return last !== undefined && last.result === 'yes' && last.script === OWNER_SCRIPT_ID && last.method === 'private_setup' && last.ref === ownerRef(ownerNumber);
}
