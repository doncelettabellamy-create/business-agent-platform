// THE CACHED "BOOKINGS NEEDING A PERSON" VIEW for the owner dashboard (Stage 1). One in-memory snapshot of the unresolved bookings in the booking ledger, refreshed at startup, on a timer and after each call outcome, and read
// SYNCHRONOUSLY by the dashboard (a real scan decrypts every ledger file, so it is never run per request).
//
// WHAT IT NEVER DOES: write, retry, resolve or clear anything; call a provider; hold or show an id, a name, an address, a number or a path. It keeps only a booking reference (DREWTEST- and 12 hex characters) and one of two state words.
// THE RULE: anything but a fresh, well-formed, consistent scan is `unknown`, never `none`: a scan that throws, an answer of the wrong shape, a reference that is not exactly a reference, "none" with items, a snapshot older than `staleMs`, or no scan yet.
// It imports nothing: the ledger reader is handed in by the entry (tests hand in their own), so this file has no way to reach the ledger, a provider or the disk.

export interface PendingRow { ref: string; state: 'pending' | 'client_created' }
export interface PendingSnapshotView { status: 'none' | 'some' | 'unknown'; /** ISO time of the last scan that was read successfully; null when there has been none. */ asOf: string | null; items: PendingRow[] }
/** The part of the ledger report this needs (src/jobber-ledger-scan.ts `PendingReport` has this shape and more). Anything else on it is ignored. */
export interface PendingSource { scan: { verdict: string }; items: ReadonlyArray<{ ref: string; state: string }> }
export interface PendingSnapshotOptions { read: () => Promise<PendingSource>; now?: () => number; /** A snapshot older than this is unknown (default 180 s: three refresh intervals). */ staleMs?: number; /** The refresh interval (default 60 s). */ intervalMs?: number }
export interface PendingSnapshot { view(): PendingSnapshotView; /** Scans now. Single-flight: a call during a scan makes exactly one more scan after it. Never rejects. */ refresh(): Promise<void>; start(): void; stop(): void }

export const PENDING_REF = /^DREWTEST-[0-9A-F]{12}$/;
export const DEFAULT_INTERVAL_MS = 60_000;
export const DEFAULT_STALE_MS = 180_000;
export const MAX_ITEMS = 200;
const UNKNOWN: PendingSnapshotView = Object.freeze({ status: 'unknown', asOf: null, items: [] }) as PendingSnapshotView;

/** The snapshot content for a scan answer, or undefined when the answer cannot be trusted (it is then `unknown`). Pure. */
export function sanitizeSource(r: unknown): { status: 'none' | 'some' | 'unknown'; items: PendingRow[] } | undefined {
  try {
    const o = r as { scan?: { verdict?: unknown }; items?: unknown };
    const verdict = o?.scan?.verdict;
    if (verdict !== 'none' && verdict !== 'some' && verdict !== 'unknown') return undefined;
    if (!Array.isArray(o.items) || o.items.length > MAX_ITEMS) return undefined;
    const seen = new Set<string>(); const items: PendingRow[] = [];
    for (const i of o.items as Array<{ ref?: unknown; state?: unknown }>) {
      if (typeof i !== 'object' || i === null || typeof i.ref !== 'string' || !PENDING_REF.test(i.ref) || (i.state !== 'pending' && i.state !== 'client_created')) return undefined;
      if (seen.has(i.ref)) continue; seen.add(i.ref); items.push({ ref: i.ref, state: i.state });
    }
    items.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
    if (verdict === 'none') return items.length === 0 ? { status: 'none', items: [] } : undefined;   // "none" with a booking listed contradicts itself
    if (verdict === 'unknown') return { status: 'unknown', items: [] };   // part of the ledger could not be read: nothing is listed as if it were the whole truth
    return { status: 'some', items };   // "some" may have no items (an unresolved entry of the older ledger cannot be listed)
  } catch { return undefined; }
}

export function createPendingSnapshot(o: PendingSnapshotOptions): PendingSnapshot {
  const now = o.now ?? ((): number => Date.now());
  const staleMs = o.staleMs ?? DEFAULT_STALE_MS; const intervalMs = o.intervalMs ?? DEFAULT_INTERVAL_MS;
  let cur: { status: 'none' | 'some' | 'unknown'; items: PendingRow[]; at: number } | undefined;   // the latest scan, good or not
  let lastGoodAt: number | undefined;                                                                // the latest scan that was read successfully
  let inflight: Promise<void> | undefined; let again = false; let timer: ReturnType<typeof setInterval> | undefined;

  const scanOnce = async (): Promise<void> => {
    let parsed: ReturnType<typeof sanitizeSource>;
    try { parsed = sanitizeSource(await o.read()); } catch { parsed = undefined; }
    const at = now();
    if (parsed === undefined) { cur = { status: 'unknown', items: [], at }; return; }   // a failed scan is shown at once as unknown (not after the snapshot goes stale)
    cur = { ...parsed, at }; if (parsed.status !== 'unknown') lastGoodAt = at;
  };
  const refresh = (): Promise<void> => {
    if (inflight !== undefined) { again = true; return inflight; }
    inflight = (async () => { try { do { again = false; await scanOnce(); } while (again); } catch { cur = { status: 'unknown', items: [], at: now() }; } finally { inflight = undefined; } })();
    return inflight;
  };
  const view = (): PendingSnapshotView => {
    try {
      if (cur === undefined) return { ...UNKNOWN, items: [] };
      const asOf = lastGoodAt === undefined ? null : new Date(lastGoodAt).toISOString().replace(/\.\d{3}Z$/, 'Z');
      if (now() - cur.at > staleMs || now() < cur.at - 1000) return { status: 'unknown', asOf, items: [] };   // too old (or a clock that went backwards): not trusted
      return { status: cur.status, asOf, items: cur.items.map((i) => ({ ...i })) };
    } catch { return { ...UNKNOWN, items: [] }; }
  };
  return {
    view, refresh,
    start(): void { if (timer !== undefined) return; void refresh(); timer = setInterval(() => { void refresh(); }, intervalMs); timer.unref?.(); },
    stop(): void { if (timer !== undefined) { clearInterval(timer); timer = undefined; } },
  };
}
