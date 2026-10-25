// Conformance tests for the Reporting ledger. Written against the ReportingLedger interface only: any ledger (in-memory, SQLite, a later
// production one) must pass the same tests. Synthetic data only; no agent, entry or pipeline is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GENESIS_DIGEST, snapshotIsConsistent, verifyObservationLog } from '../../src/reporting-ledger.ts';
import type { Disposition, ReportingLedger } from '../../src/reporting-ledger.ts';

export const T1 = '2026-10-25T18:01:00Z';
export const T2 = '2026-10-25T18:02:00Z';
export const CLOCK = '2026-10-25T18:00:00Z';
export const TA = 'ws-synthetic-plumbing';
export const TB = 'ws-synthetic-dental';

export const draftOf = (digest: string, item = 'wi-aaaaaaaaaaaa', over: Record<string, unknown> = {}) => ({
  item_id: item, candidate_digest: digest, outcome: 'pass' as const, checks: [] as { check: string; reason: string }[], broken: [] as string[],
  intake_correlation_id: 'corr-i', processing_correlation_id: 'corr-p', qc_correlation_id: 'corr-q', verdict_at: T1, recorded_at: CLOCK, ...over,
});
export const obs = (draft: unknown): Disposition => ({ kind: 'observation', draft } as Disposition);
export const refusal = (code: string): Disposition => ({ kind: 'refused', code });

/** The fixed sequence used to compare ledgers with each other: same input, same log, same digests. */
export const SEQUENCE: Array<[string, Disposition]> = [
  [TA, obs(draftOf('d1'))],
  [TA, obs(draftOf('d2', 'wi-aaaaaaaaaaaa', { outcome: 'escalate', verdict_at: T2, checks: [{ check: 'evidence_exists', reason: 'MISSING' }] }))],
  [TA, obs(draftOf('d1'))],
  [TA, refusal('TRIPLE_INVALID')],
  [TB, obs(draftOf('d1', 'wi-bbbbbbbbbbbb', { outcome: 'chain_conflict', broken: ['item_id', 'parent_chain'] }))],
  [TA, obs(draftOf('d3', 'wi-cccccccccccc', { outcome: 'rework' }))],
  [TB, refusal('TENANT_MISMATCH')],
];

export function ledgerConformance(name: string, make: (opts: { maxAttempts?: number }) => ReportingLedger) {
  const t = (title: string, fn: () => void | Promise<void>) => test(`${name}: ${title}`, fn);

  t('an empty tenant has an empty, consistent snapshot', () => {
    const l = make({});
    const s = l.snapshot(TA);
    assert.deepEqual([s.log.length, s.tally.submitted, s.tally.duplicates, s.tally.refused, s.tally.refusals.size, s.head.seq, s.head.digest], [0, 0, 0, 0, 0, 0, GENESIS_DIGEST]);
    assert.equal(snapshotIsConsistent(s), true);
  });

  t('observations get consecutive sequence numbers, per-item attempt numbers and hash links, and come back frozen', () => {
    const l = make({});
    const r1 = l.record(TA, obs(draftOf('d1')));
    const r2 = l.record(TA, obs(draftOf('d2', 'wi-bbbbbbbbbbbb')));
    const r3 = l.record(TA, obs(draftOf('d3')));
    assert.deepEqual([r1.kind, r2.kind, r3.kind], ['appended', 'appended', 'appended']);
    const s = l.snapshot(TA);
    assert.deepEqual(s.log.map((o) => [o.seq, o.item_id, o.attempt]), [[1, 'wi-aaaaaaaaaaaa', 1], [2, 'wi-bbbbbbbbbbbb', 1], [3, 'wi-aaaaaaaaaaaa', 2]]);
    assert.equal(s.log[0].previous_digest, GENESIS_DIGEST);
    assert.equal(s.log[1].previous_digest, s.log[0].digest);
    assert.equal(s.log[2].previous_digest, s.log[1].digest);
    assert.deepEqual(s.head, { seq: 3, digest: s.log[2].digest });
    assert.ok(s.log.every((o) => o.workspace_id === TA && Object.isFrozen(o) && Object.isFrozen(o.checks) && Object.isFrozen(o.broken)));
    assert.equal(verifyObservationLog(s.log), true);
    if (r1.kind === 'appended') assert.deepEqual(r1.observation, s.log[0]);
  });

  t('the same candidate digest is a duplicate: nothing is appended and only submitted and duplicates move', () => {
    const l = make({});
    l.record(TA, obs(draftOf('d1')));
    const before = l.snapshot(TA);
    assert.deepEqual(l.record(TA, obs(draftOf('d1'))), { kind: 'duplicate' });
    assert.deepEqual(l.record(TA, obs(draftOf('d1', 'wi-bbbbbbbbbbbb', { outcome: 'escalate' }))), { kind: 'duplicate' });   // the digest decides, not the rest
    const after = l.snapshot(TA);
    assert.deepEqual(after.log, before.log);
    assert.deepEqual(after.head, before.head);
    assert.deepEqual([after.tally.submitted, after.tally.duplicates, after.tally.refused], [3, 2, 0]);
    assert.equal(snapshotIsConsistent(after), true);
  });

  t('the attempt cap refuses further attempts for an item with ATTEMPT_LIMIT, tallies the refusal, and leaves other items alone', () => {
    const l = make({ maxAttempts: 2 });
    assert.equal(l.record(TA, obs(draftOf('d1'))).kind, 'appended');
    assert.equal(l.record(TA, obs(draftOf('d2'))).kind, 'appended');
    assert.deepEqual(l.record(TA, obs(draftOf('d3'))), { kind: 'refused', code: 'ATTEMPT_LIMIT' });
    assert.deepEqual(l.record(TA, obs(draftOf('d3'))), { kind: 'refused', code: 'ATTEMPT_LIMIT' });          // refused again: a refusal reserves nothing
    assert.equal(l.record(TA, obs(draftOf('d4', 'wi-bbbbbbbbbbbb'))).kind, 'appended');
    const s = l.snapshot(TA);
    assert.deepEqual([s.log.length, s.tally.submitted, s.tally.refused, s.tally.duplicates], [3, 5, 2, 0]);
    assert.deepEqual([...s.tally.refusals], [['ATTEMPT_LIMIT', 2]]);
    assert.equal(snapshotIsConsistent(s), true);
  });

  t('a refusal is counted as submitted and filed under its code in the same call', () => {
    const l = make({});
    assert.deepEqual(l.record(TA, refusal('TRIPLE_INVALID')), { kind: 'refused', code: 'TRIPLE_INVALID' });
    l.record(TA, refusal('TRIPLE_INVALID')); l.record(TA, refusal('TENANT_MISMATCH'));
    const s = l.snapshot(TA);
    assert.deepEqual([s.tally.submitted, s.tally.refused, s.log.length], [3, 3, 0]);
    assert.deepEqual([...s.tally.refusals].sort(), [['TENANT_MISMATCH', 1], ['TRIPLE_INVALID', 2]]);
    assert.equal(snapshotIsConsistent(s), true);
  });

  t('submitted = observations + duplicates + refused after every single call', () => {
    const l = make({ maxAttempts: 2 });
    for (const [tenant, d] of [...SEQUENCE, [TA, obs(draftOf('d9'))] as [string, Disposition], [TA, obs(draftOf('d10'))] as [string, Disposition]]) {
      l.record(tenant, d);
      for (const who of [TA, TB]) {
        const s = l.snapshot(who);
        assert.equal(s.tally.submitted, s.log.length + s.tally.duplicates + s.tally.refused);
        assert.equal(snapshotIsConsistent(s), true);
      }
    }
  });

  t('tenants are separate: logs, sequence numbers, duplicates, attempts, tallies and heads', () => {
    const l = make({ maxAttempts: 2 });
    l.record(TA, obs(draftOf('d1')));
    l.record(TA, obs(draftOf('d2')));
    assert.equal(l.record(TB, obs(draftOf('d1'))).kind, 'appended');        // the same digest and item in another tenant is new there
    assert.equal(l.record(TB, obs(draftOf('d2'))).kind, 'appended');
    assert.equal(l.record(TB, obs(draftOf('d3'))).kind, 'refused');         // B's own cap, counted for B only
    l.record(TA, refusal('TRIPLE_INVALID'));
    const a = l.snapshot(TA); const b = l.snapshot(TB);
    assert.deepEqual([a.log.length, b.log.length], [2, 2]);
    assert.deepEqual([a.tally.refused, b.tally.refused, a.tally.refusals.size, b.tally.refusals.size], [1, 1, 1, 1]);
    assert.ok(a.log.every((o) => o.workspace_id === TA) && b.log.every((o) => o.workspace_id === TB));
    assert.deepEqual([a.log[0].seq, b.log[0].seq], [1, 1]);
    assert.notEqual(a.log[0].digest, b.log[0].digest);                      // the tenant is part of what is hashed
    assert.ok(!JSON.stringify(a).includes(TB) && !JSON.stringify(b).includes(TA));
    assert.deepEqual(l.snapshot('ws-synthetic-other').log, []);
  });

  t('malformed calls throw and change nothing', () => {
    const l = make({});
    l.record(TA, obs(draftOf('d1')));
    const before = l.snapshot(TA);
    const bad: unknown[] = [
      null, 'x', 5, {}, { kind: 'other' }, { kind: 'refused' }, { kind: 'refused', code: 'lower' }, { kind: 'refused', code: 7 }, { kind: 'observation' }, { kind: 'observation', draft: null },
      obs(draftOf('d2', 'wi-aaaaaaaaaaaa', { outcome: 'done' })), obs(draftOf('d2', 'wi-aaaaaaaaaaaa', { verdict_at: 'yesterday' })), obs(draftOf('d2', 'wi-aaaaaaaaaaaa', { recorded_at: 5 })),
      obs(draftOf('d2', 'wi-aaaaaaaaaaaa', { extra: 1 })), obs(draftOf('')), obs(draftOf('d2', 'wi-aaaaaaaaaaaa', { checks: [{ check: 'a' }] })), obs(draftOf('d2', 'wi-aaaaaaaaaaaa', { broken: 'x' })),
    ];
    for (const d of bad) assert.throws(() => l.record(TA, d as Disposition), TypeError, JSON.stringify(d));
    for (const tenant of ['', null, 5, undefined]) {
      assert.throws(() => l.record(tenant as string, obs(draftOf('d2'))), TypeError);
      assert.throws(() => l.snapshot(tenant as string), TypeError);
    }
    assert.deepEqual(l.snapshot(TA), before);
    assert.equal(l.record(TA, obs(draftOf('d2'))).kind, 'appended');       // nothing was reserved by the failed calls
  });

  t('the setup refuses a bad attempt cap', () => {
    for (const bad of [0, -1, 1.5, 1001, '2', NaN]) assert.throws(() => make({ maxAttempts: bad as number }), RangeError);
  });

  t('snapshots are copies: changing one changes neither the ledger nor the next snapshot', () => {
    const l = make({});
    l.record(TA, obs(draftOf('d1'))); l.record(TA, refusal('TRIPLE_INVALID'));
    const s: any = l.snapshot(TA);
    try { s.log.push(null); } catch { /* a frozen list is fine too */ }
    try { s.tally.refusals.set('X', 9); } catch { /* ignored */ }
    const again = l.snapshot(TA);
    assert.equal(again.log.length, 1);
    assert.deepEqual([...again.tally.refusals], [['TRIPLE_INVALID', 1]]);
    assert.equal(snapshotIsConsistent(again), true);
  });
}
