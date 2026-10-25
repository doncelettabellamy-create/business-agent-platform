// The Reporting history (proof of concept): an APPEND-ONLY log of observations, one per distinct candidate that reached Reporting, from
// which the current verified status of each item is DERIVED. Nothing is ever overwritten or deleted: a later attempt adds an
// observation, it does not change an earlier one, and the first outcome of every item stays on record forever.
//
//   observation   ids, digests, fixed words and times only (no customer text): the item, the attempt number, the candidate's digest,
//                 the outcome Reporting itself re-derived (pass, rework, escalate, or chain_conflict when the links do not hold),
//                 the failed check names and reasons, the three correlation ids, the QC verdict's own creation time, and the time
//                 it was recorded. Each carries the digest of the one before it, so the log is hash-linked and `verifyObservationLog`
//                 detects an edited, removed, reordered or duplicated entry.
//   duplicates    the same candidate digest is never appended twice (replay protection).
//   current status (deriveStatuses; a pure function of the log, so it can be recomputed for any earlier point with `upToSeq`):
//                 the first observation of an item is its first status. A LATER observation replaces the current status only if
//                   - its chain holds (an observation whose chain does not hold is REJECTED as a status source: it stays in the log,
//                     is counted, and never becomes the current status over an earlier one), and
//                   - its QC verdict is NEWER than the one the current status rests on. If the times are equal the WORSE outcome wins
//                     (escalate < rework < pass), so a tie can never promote a verified status; the one exception is a first
//                     observation whose chain failed, which was never a verified status and is replaced by any valid observation
//                     that is not older. An older verdict that arrives
//                     late is recorded as superseded-on-arrival and changes nothing, so an old pass can never resurrect an item that a newer
//                     verdict has since sent back. Arrival order alone decides nothing.
//   ONE RECORD PER TRIPLE: the ledger's only write is `record(tenant, disposition)`. Whatever happened to a submitted triple (appended, a
//   duplicate, or refused) is counted as submitted AND filed under its outcome in that single operation, so a crash or a failure can never leave
//   `submitted` apart from the outcomes: submitted = observations + duplicates + refused holds after every call. A ledger that cannot do that
//   atomically must not implement this interface. The log, tallies and head are read together with `snapshot`, never with separate reads.
//   Still true: this is a view, not the audit record, and this version is in memory only (a restart loses it; the durable version is a
//   later gate). Imports only contracts.ts and handoff-seal.ts (a hash) and does no I/O.

import { isRecord } from './contracts.ts';
import { contentDigest } from './handoff-seal.ts';

export const GENESIS_DIGEST = '0'.repeat(64);
export const DEFAULT_MAX_ATTEMPTS = 20;
export const OUTCOME_NAMES = ['chain_conflict', 'escalate', 'rework', 'pass'] as const;   // worst first: the index is the rank
export type OutcomeName = (typeof OUTCOME_NAMES)[number];
export const rank = (o: OutcomeName): number => OUTCOME_NAMES.indexOf(o);

export interface ObservationDraft {
  item_id: string;
  candidate_digest: string;
  outcome: OutcomeName;
  checks: readonly { check: string; reason: string }[];
  broken: readonly string[];
  intake_correlation_id: string;
  processing_correlation_id: string;
  qc_correlation_id: string;
  /** When the QC verdict was created (its own clock). The ordering of attempts rests on this, not on arrival. */
  verdict_at: string;
  /** When Reporting recorded it (Reporting's clock). */
  recorded_at: string;
}
export interface Observation extends ObservationDraft {
  readonly workspace_id: string;
  readonly seq: number;
  readonly attempt: number;
  readonly previous_digest: string;
  readonly digest: string;
}
export interface ItemStatus {
  readonly item_id: string;
  readonly first_outcome: OutcomeName;
  readonly current_outcome: OutcomeName;
  readonly attempts: number;
  readonly first_seq: number;
  readonly current_seq: number;
}
export interface Derived {
  readonly statuses: readonly ItemStatus[];
  /** Valid observations that did not take effect because a newer (or equal and better) verdict was already the status. */
  readonly superseded_on_arrival: number;
  /** Observations whose chain did not hold and so could not become a status over an earlier observation. */
  readonly chain_rejected: number;
}

const time = (s: string): number => Date.parse(s);

/** The statuses implied by the log, up to and including `upToSeq` (default: all). Pure and deterministic. */
export function deriveStatuses(observations: readonly Observation[], upToSeq: number = Number.MAX_SAFE_INTEGER): Derived {
  const items = new Map<string, { first: Observation; current: Observation; attempts: number }>();
  let superseded = 0; let rejected = 0;
  for (const o of observations) {
    if (o.seq > upToSeq) break;
    const st = items.get(o.item_id);
    if (!st) { items.set(o.item_id, { first: o, current: o, attempts: 1 }); continue; }
    st.attempts++;
    if (o.outcome === 'chain_conflict') { rejected++; continue; }                        // a broken chain is never accepted over an earlier observation
    const tNew = time(o.verdict_at); const tCur = time(st.current.verdict_at);
    if (tNew > tCur) st.current = o;
    else if (tNew === tCur && st.current.outcome === 'chain_conflict') st.current = o;      // a first observation whose chain failed was never a verified status
    else if (tNew === tCur && rank(o.outcome) < rank(st.current.outcome)) st.current = o; // otherwise a tie can only make things worse
    else superseded++;
  }
  const statuses = [...items.values()].map((s) => ({
    item_id: s.first.item_id, first_outcome: s.first.outcome, current_outcome: s.current.outcome, attempts: s.attempts, first_seq: s.first.seq, current_seq: s.current.seq,
  }));
  return { statuses, superseded_on_arrival: superseded, chain_rejected: rejected };
}

function bodyOf(o: Observation): Record<string, unknown> {
  const { digest, ...rest } = o;
  void digest;
  return rest;
}
/** Checks a log without trusting it: sequence numbers, the hash links and every digest. */
export function verifyObservationLog(observations: unknown): boolean {
  try {
    if (!Array.isArray(observations)) return false;
    let previous = GENESIS_DIGEST;
    const perItem = new Map<string, number>();
    const seen = new Set<string>();
    for (let i = 0; i < observations.length; i++) {
      const o: unknown = (observations as unknown[])[i];
      if (!isRecord(o) || o.seq !== i + 1 || o.previous_digest !== previous || typeof o.digest !== 'string') return false;
      if (typeof o.item_id !== 'string' || typeof o.candidate_digest !== 'string' || seen.has(o.candidate_digest)) return false;
      seen.add(o.candidate_digest);
      const n = (perItem.get(o.item_id) ?? 0) + 1;
      perItem.set(o.item_id, n);
      if (o.attempt !== n) return false;
      if (o.digest !== contentDigest(bodyOf(o as unknown as Observation))) return false;
      previous = o.digest;
    }
    return true;
  } catch { return false; }
}

export interface Tally { readonly submitted: number; readonly duplicates: number; readonly refused: number; readonly refusals: ReadonlyMap<string, number> }
export interface LedgerSnapshot { readonly log: readonly Observation[]; readonly tally: Tally; readonly head: { seq: number; digest: string } }
/** What happened to one submitted triple. A refusal is filed by a fixed code. */
export type Disposition = { kind: 'observation'; draft: ObservationDraft } | { kind: 'refused'; code: string };
export type RecordResult = { kind: 'appended'; observation: Observation } | { kind: 'duplicate' } | { kind: 'refused'; code: string };

const CODE = /^[A-Z][A-Z_]{0,39}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
/** Throws on a draft that is not exactly an ObservationDraft. Called before anything is changed. */
export function assertDraft(d: unknown): asserts d is ObservationDraft {
  if (!isRecord(d)) throw new TypeError('draft');
  const keys = Object.keys(d).sort().join(',');
  if (keys !== 'broken,candidate_digest,checks,intake_correlation_id,item_id,outcome,processing_correlation_id,qc_correlation_id,recorded_at,verdict_at') throw new TypeError('draft');
  if (!text(d.item_id) || !text(d.candidate_digest) || !text(d.intake_correlation_id) || !text(d.processing_correlation_id) || !text(d.qc_correlation_id)) throw new TypeError('draft');
  if (typeof d.outcome !== 'string' || !(OUTCOME_NAMES as readonly string[]).includes(d.outcome)) throw new TypeError('draft');
  if (typeof d.verdict_at !== 'string' || !TIME.test(d.verdict_at) || Number.isNaN(Date.parse(d.verdict_at))) throw new TypeError('draft');
  if (typeof d.recorded_at !== 'string' || !TIME.test(d.recorded_at) || Number.isNaN(Date.parse(d.recorded_at))) throw new TypeError('draft');
  if (!Array.isArray(d.broken) || d.broken.length > 10 || !d.broken.every(text)) throw new TypeError('draft');
  if (!Array.isArray(d.checks) || d.checks.length > 20 || !d.checks.every((c) => isRecord(c) && Object.keys(c).length === 2 && text(c.check) && text(c.reason))) throw new TypeError('draft');
}

/** The storage behind Reporting. This is the in-memory implementation; a durable one must behave the same (a later gate). */
export interface ReportingLedger {
  /** The single write. Atomic: either the triple is fully counted (submitted plus its outcome) or nothing changed and this throws. */
  record(tenant: string, disposition: Disposition): RecordResult;
  /** A consistent read of the log (frozen observations, oldest first), the tallies and the head, taken together. */
  snapshot(tenant: string): LedgerSnapshot;
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const c of Object.values(v as Record<string, unknown>)) deepFreeze(c); }
  return v;
}

export function createInMemoryReportingLedger(options: { maxAttempts?: number } = {}): ReportingLedger {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 1000) throw new RangeError('maxAttempts must be an integer from 1 to 1000');
  interface Book { log: Observation[]; digests: Set<string>; perItem: Map<string, number>; submitted: number; duplicates: number; refused: number; refusals: Map<string, number> }
  const books = new Map<string, Book>();
  const book = (tenant: string): Book => {
    let b = books.get(tenant);
    if (!b) { b = { log: [], digests: new Set(), perItem: new Map(), submitted: 0, duplicates: 0, refused: 0, refusals: new Map() }; books.set(tenant, b); }
    return b;
  };
  const refuseWith = (b: Book, code: string): RecordResult => {
    b.submitted++; b.refused++; b.refusals.set(code, (b.refusals.get(code) ?? 0) + 1);
    return { kind: 'refused', code };
  };
  return Object.freeze({
    record(tenant, disposition): RecordResult {
      if (!text(tenant) || !isRecord(disposition)) throw new TypeError('record');
      // Everything that can throw happens BEFORE the first change, so a failure leaves the book exactly as it was.
      if (disposition.kind === 'refused') {
        if (typeof disposition.code !== 'string' || !CODE.test(disposition.code)) throw new TypeError('record');
        return refuseWith(book(tenant), disposition.code);
      }
      if (disposition.kind !== 'observation') throw new TypeError('record');
      const draft: unknown = disposition.draft;
      assertDraft(draft);
      const b = book(tenant);
      if (b.digests.has(draft.candidate_digest)) { b.submitted++; b.duplicates++; return { kind: 'duplicate' }; }
      const attempt = (b.perItem.get(draft.item_id) ?? 0) + 1;
      if (attempt > maxAttempts) return refuseWith(b, 'ATTEMPT_LIMIT');
      const previous = b.log.length === 0 ? GENESIS_DIGEST : b.log[b.log.length - 1].digest;
      const body = {
        ...draft, checks: draft.checks.map((c) => ({ check: c.check, reason: c.reason })), broken: [...draft.broken],
        workspace_id: tenant, seq: b.log.length + 1, attempt, previous_digest: previous,
      };
      const observation = deepFreeze({ ...body, digest: contentDigest(body) }) as Observation;   // may throw: still nothing changed
      b.log.push(observation); b.digests.add(draft.candidate_digest); b.perItem.set(draft.item_id, attempt); b.submitted++;
      return { kind: 'appended', observation };
    },
    snapshot(tenant): LedgerSnapshot {
      if (!text(tenant)) throw new TypeError('snapshot');
      const b = book(tenant);
      const last = b.log.length === 0 ? undefined : b.log[b.log.length - 1];
      return { log: [...b.log], tally: { submitted: b.submitted, duplicates: b.duplicates, refused: b.refused, refusals: new Map(b.refusals) }, head: { seq: b.log.length, digest: last === undefined ? GENESIS_DIGEST : last.digest } };
    },
  });
}

/** True when a snapshot's own numbers agree: submitted = observations + duplicates + refused, refusals add up, head matches the log. */
export function snapshotIsConsistent(s: LedgerSnapshot): boolean {
  try {
    let byCode = 0;
    for (const n of s.tally.refusals.values()) byCode += n;
    const last = s.log.length === 0 ? undefined : s.log[s.log.length - 1];
    return s.tally.submitted === s.log.length + s.tally.duplicates + s.tally.refused && byCode === s.tally.refused
      && s.head.seq === s.log.length && s.head.digest === (last === undefined ? GENESIS_DIGEST : last.digest) && verifyObservationLog(s.log);
  } catch { return false; }
}
