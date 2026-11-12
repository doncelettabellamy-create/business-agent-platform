// FOLLOW-UP MARKERS (Stage 1, G4): the append-only way to say "the owner handled this" and "the owner reopened this". Pure: no I/O, no clock, no environment.
//
// The intake record store refuses updates, so a follow-up is never edited. A marker is a SEPARATE record that points at the follow-up's call reference. The follow-up's state is its NEWEST marker (the highest sequence number):
// no marker or `reopened` = open; `handled` = handled. Every marker ever written stays in the store, so the history is complete; nothing here deletes or rewrites anything.
//
// Identity is deterministic, which is the whole duplicate guard:
//   item id   `fu-<target call_ref>-<n>`         n = 1, 2, 3 ... (the nth change to that follow-up)
//   call_ref  hash of `fu:<target call_ref>:<n>`   so two writers racing for the same n collide on the store's UNIQUE rule, and the loser re-reads.
// A marker holds a fixed sentence and its reference and number, and nothing else: no name, number, address, note or SID. It is only believed when it parses EXACTLY (see `parseMarker`), including that its call reference
// is the hash its tenant, target and number imply; a record that merely resembles a marker is ignored by `followUpState` and never shown to the owner as a call.

import { callRefFor, NOT_CONFIRMED } from './intake-record-store.ts';
import type { IntakeRecord } from './intake-record-store.ts';

export type FollowUpAction = 'handled' | 'reopened';
export const MARKER_CATEGORY = 'follow-up-marker';
/** The most changes one follow-up may have (a runaway loop cannot fill the store). */
export const MAX_TRANSITIONS = 50;
const ITEM = /^fu-([0-9a-f]{16})-([1-9][0-9]?)$/;
const REASON = /^follow_up_(handled|reopened)$/;
const SENTENCE: Readonly<Record<FollowUpAction, string>> = Object.freeze({ handled: 'Marked handled by the owner.', reopened: 'Reopened by the owner.' });
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
export const markerCallRef = (tenant: string, ref: string, n: number): string => callRefFor(tenant, `fu:${ref}:${n}`);
export const markerItemId = (ref: string, n: number): string => `fu-${ref}-${n}`;
export const markerSentence = (a: FollowUpAction): string => SENTENCE[a];

/** The marker record for the nth change to the follow-up `ref`. */
export function markerRecord(tenant: string, ref: string, n: number, action: FollowUpAction, at: number): IntakeRecord {
  return {
    item_id: markerItemId(ref, n), workspace_id: tenant, call_ref: markerCallRef(tenant, ref, n), received_at: iso(at), category: MARKER_CATEGORY,
    status: 'needs-human', reasons: [`follow_up_${action}`, NOT_CONFIRMED], missing_fields: [],
    fields: [{ name: 'request', value: SENTENCE[action], confidence: null, found: true }],
    pii_summary: [], confidence: null, versions: { skill: 'follow-up', model: 'owner', prompt: 'follow-up-marker-v1' },
    handed_off: false, turns: 0, confirmation: 'unconfirmed', address_status: 'none',
  };
}

export interface ParsedMarker { ref: string; n: number; action: FollowUpAction }
/** The marker a record IS, or undefined. Believed only when every part matches what `markerRecord` would write for this tenant, target and number. */
export function parseMarker(r: IntakeRecord): ParsedMarker | undefined {
  try {
    if (r.category !== MARKER_CATEGORY) return undefined;
    const item = ITEM.exec(r.item_id); if (item === null) return undefined;
    const reason = Array.isArray(r.reasons) && r.reasons.length === 2 ? REASON.exec(r.reasons[0]) : null; if (reason === null || r.reasons[1] !== NOT_CONFIRMED) return undefined;
    const ref = item[1]; const n = Number(item[2]); const action = reason[1] as FollowUpAction;
    if (n < 1 || n > MAX_TRANSITIONS || r.call_ref !== markerCallRef(r.workspace_id, ref, n)) return undefined;
    if (r.status !== 'needs-human' || r.confirmation !== 'unconfirmed' || r.handed_off !== false || r.fields.length !== 1 || r.fields[0].value !== SENTENCE[action]) return undefined;
    return { ref, n, action };
  } catch { return undefined; }
}

/** For each follow-up that has any marker: its newest marker's number and whether that marker says handled. */
export function followUpState(records: readonly IntakeRecord[]): Map<string, { n: number; handled: boolean }> {
  const out = new Map<string, { n: number; handled: boolean }>();
  for (const r of records) {
    const m = parseMarker(r); if (m === undefined) continue;
    const cur = out.get(m.ref); if (cur === undefined || m.n > cur.n) out.set(m.ref, { n: m.n, handled: m.action === 'handled' });
  }
  return out;
}
