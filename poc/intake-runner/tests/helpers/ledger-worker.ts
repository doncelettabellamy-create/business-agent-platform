// A child process used by the SQLite ledger race tests: it opens its OWN connection to the shared database file, records one disposition,
// then prints one JSON line. Synthetic data only; no network.
//   node ledger-worker.ts record <db> <tenant> <digest> <item> <maxAttempts>
//   node ledger-worker.ts refuse <db> <tenant> <code>
import { createSqliteReportingLedger } from '../../src/reporting-ledger-sqlite.ts';

const [mode, dbPath, tenant, third, item, cap] = process.argv.slice(2);
const ledger = createSqliteReportingLedger({ path: dbPath, maxAttempts: cap === undefined ? undefined : Number(cap), busyTimeoutMs: 20_000 });
try {
  if (mode === 'record') {
    const r = ledger.record(tenant, {
      kind: 'observation',
      draft: {
        item_id: item, candidate_digest: third, outcome: 'pass', checks: [], broken: [], intake_correlation_id: 'corr-i', processing_correlation_id: 'corr-p',
        qc_correlation_id: 'corr-q', verdict_at: '2026-10-25T18:01:00Z', recorded_at: '2026-10-25T18:00:00Z',
      },
    });
    console.log(JSON.stringify(r.kind === 'appended' ? { kind: r.kind, seq: r.observation.seq, attempt: r.observation.attempt } : r));
  } else if (mode === 'refuse') {
    console.log(JSON.stringify(ledger.record(tenant, { kind: 'refused', code: third })));
  } else throw new Error('mode');
} finally {
  ledger.close();
}
