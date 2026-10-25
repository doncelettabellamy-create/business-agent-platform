// A child process used by the SQLite store race tests: it opens its OWN connection to the shared database file and tries one
// operation, then prints one JSON line. Synthetic data only; mock contexts; no network.
//   node sqlite-worker.ts claim <db> <tenant> <proposalId> <nowIso>
//   node sqlite-worker.ts put   <db> <tenant> <index>      <nowIso>
//   node sqlite-worker.ts find  <db> <tenant> <stepId>     <nowIso>
import { createSqliteApprovalStore } from '../../src/approval-store-sqlite.ts';
import { mintExecutionContext } from '../../src/execution-context.ts';
import type { ExecutionContext } from '../../src/execution-context.ts';
import { proposeAction } from '../../src/approval.ts';

const [mode, dbPath, tenant, third, nowIso] = process.argv.slice(2);
const ACTION = { item_id: 'wi-0123456789ab', step_id: 'st-0123456789ab', tool: 'mock-note', arguments: { note: 'text CANARY-STORE-2208', n: 1 } };

async function processing(corr: string): Promise<ExecutionContext> {
  const r = await mintExecutionContext({ credential: 'c', agent: 'processing' }, {
    verify: () => ({ kind: 'user', id: 'user-requester' }), selectTenant: () => tenant, grants: () => ['processing:run'], newCorrelationId: () => corr,
  });
  if (!r.ok) throw new Error('mint');
  return r.context;
}

const store = createSqliteApprovalStore({ path: dbPath, now: () => nowIso, busyTimeoutMs: 20_000 });
try {
  if (mode === 'claim') {
    const ctx = await processing(`corr-worker-${process.pid}`);
    const r = await store.claim(ctx, third, ACTION);
    console.log(JSON.stringify(r.ok ? { ok: true } : { ok: false, code: r.error.code }));
  } else if (mode === 'find') {
    const r = await store.findByStep(await processing(`corr-worker-${process.pid}`), third);
    console.log(JSON.stringify(r.ok ? { ok: true, state: r.snapshot.state, proposal_id: r.snapshot.proposal_id } : { ok: false, code: r.error.code }));
  } else if (mode === 'put') {
    const index = Number(third);
    const at = new Date(Date.parse(nowIso) + index * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const proposal = proposeAction(await processing(`corr-worker-${index}`), ACTION, { now: () => at });
    if (!proposal.ok) throw new Error('propose');
    const r = await store.putProposal(await processing(`corr-worker-${index}`), proposal.proposal);
    console.log(JSON.stringify(r.ok ? { ok: true } : { ok: false, code: r.error.code }));
  } else throw new Error('mode');
} finally {
  store.close();
}
