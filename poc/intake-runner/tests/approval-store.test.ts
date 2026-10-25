// Tests for the approval-state store: the in-memory reference runs the shared conformance suite, plus its own specifics.
// Mock contexts and a mock clock only. No agent, tool or pipeline is connected. No network, no key, synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createInMemoryApprovalStore } from '../src/approval-store.ts';
import { at, code, conformance, CANARY, decide, DW, human, nowIso, ok, plus, processing, propose, ACTION, T0 } from './helpers/store-conformance.ts';

conformance('in-memory store', (config) => createInMemoryApprovalStore(config));


// ---------------------------------------------------------------- reference-implementation specifics
test('in-memory store: bad setup fails at startup without echoing values', () => {
  const now = () => T0;
  for (const [name, fn] of [
    ['no config', () => createInMemoryApprovalStore(null as never)], ['no clock', () => createInMemoryApprovalStore({} as never)],
    ['lease', () => createInMemoryApprovalStore({ now, leaseSeconds: 0 })], ['lease big', () => createInMemoryApprovalStore({ now, leaseSeconds: 3601 })],
    ['attempts', () => createInMemoryApprovalStore({ now, maxAttempts: 0 })], ['attempts big', () => createInMemoryApprovalStore({ now, maxAttempts: 11 })],
    ['tools', () => createInMemoryApprovalStore({ now, idempotentTools: [`Bad ${CANARY}`] })], ['tools not a list', () => createInMemoryApprovalStore({ now, idempotentTools: 'x' as never })],
    ['claim ids', () => createInMemoryApprovalStore({ now, newClaimId: 'x' as never })],
  ] as [string, () => unknown][]) assert.throws(fn, (e: Error) => e instanceof RangeError && !e.message.includes('CANARY'), name);
});

test('in-memory store: a bad fence token from its generator fails closed', async () => {
  at(T0);
  const s = createInMemoryApprovalStore({ now: nowIso, newClaimId: () => 'x' });
  const p = await propose();
  ok(await s.putProposal(await processing(), p));
  ok(await s.recordDecision(await human(), await decide(p)));
  code(await s.claim(await processing(), p.proposal_id, ACTION()), 'STORE_ERROR');
  assert.equal(ok(await s.get(await processing(), p.proposal_id)).snapshot.attempts, 0);
});

test('in-memory store: the default fence tokens are unique and unguessable-looking', async () => {
  at(T0);
  const s = createInMemoryApprovalStore({ now: nowIso, idempotentTools: ['mock-note'] });
  const p = await propose();
  ok(await s.putProposal(await processing(), p));
  ok(await s.recordDecision(await human(), await decide(p)));
  const a = ok(await s.claim(await processing(), p.proposal_id, ACTION()));
  at(plus(3 * 60));
  const b = ok(await s.claim(await processing(), p.proposal_id, ACTION()));
  assert.notEqual(a.grant.claim_id, b.grant.claim_id);
  assert.match(a.grant.claim_id, /^[0-9a-f-]{36}$/);
});

test('in-memory store: only Processing (as a type) and QC (a read-only view) use it; no Reporting, tool or pipeline does; it has no I/O', () => {
  const dir = new URL('../src/', import.meta.url);
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  const text = (f: string) => strip(readFileSync(new URL(f, dir), 'utf8'));
  assert.deepEqual(files.filter((f) => f !== 'approval-store.ts' && /\.\/approval-store\.ts/.test(text(f))), ['approval-store-sqlite.ts', 'processing-entry.ts', 'qc-entry.ts'], 'only the SQLite reference store, the Processing entry and the read-only QC checks import it');
  assert.match(text('processing-entry.ts'), /import type \{ ApprovalStore \} from '\.\/approval-store\.ts'/, 'Processing takes the store only as a type: it receives one at setup and never builds one');
  const code_ = text('approval-store.ts');
  for (const m of code_.matchAll(/from\s+'([^']+)'/g)) assert.ok(m[1].startsWith('./') || m[1] === 'node:crypto', `imports ${m[1]}`);
  assert.ok(!/from\s+'\.\/(processing-entry|qc-entry|reporting-entry|pipeline|intake-entry|mock-tools|live-run)\.ts'/.test(code_));
  assert.ok(!/\b(fetch|process\.env|readFile|writeFile|child_process|mintExecutionContext|mintApproverContext|Math\.random|Date\.now|setTimeout)\b/.test(code_), 'no I/O, no hidden clock');
});
