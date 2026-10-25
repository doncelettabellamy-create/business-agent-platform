// Real Intake -> Processing -> QC chains for Reporting tests that need sealed triples. Mock provider, mock tools, synthetic data only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createIntakeEntry } from '../../src/intake-entry.ts';
import { createTenantRegistry } from '../../src/tenant-boundary.ts';
import { mintExecutionContext } from '../../src/execution-context.ts';
import type { AgentName, ExecutionContext } from '../../src/execution-context.ts';
import { createProcessingEntry, createToolRegistry, PROCESSING_RUN_SCOPE } from '../../src/processing-entry.ts';
import { createMockNoteTool, MOCK_NOTE_READ_SCOPE, MOCK_NOTE_SCOPE } from '../../src/mock-tools.ts';
import type { EvidenceReader } from '../../src/mock-tools.ts';
import { createQcEntry, QC_RUN_SCOPE } from '../../src/qc-entry.ts';
import { createReportingEntry, REPORTING_RUN_SCOPE } from '../../src/reporting-entry.ts';
import type { ReportResult, SubmitResult } from '../../src/reporting-entry.ts';
import { validateReport } from '../../src/report.ts';
import { classifyAnswer, createMockProvider, extractAnswer } from '../../src/mock-provider.ts';

export const CANARY = 'CANARY-LEDGER-5530';
export const CLOCK = '2026-10-25T18:00:00Z';
export const T1 = '2026-10-25T18:01:00Z';
export const T2 = '2026-10-25T18:02:00Z';
export const PW = 'ws-synthetic-plumbing';
export const DW = 'ws-synthetic-dental';
const read = (n: string) => JSON.parse(readFileSync(new URL(`../../examples/${n}`, import.meta.url), 'utf8'));
const { skill_config: pcfg, ...pmsg } = read('skill-plumbing.json');
const { skill_config: dcfg, ...dmsg } = read('skill-dental.json');
export const plumbingMessage = (id: string) => ({ ...pmsg, event_id: id });
export const dentalMessage = dmsg;

export async function mintCtx(tenant: string, agent: AgentName, corr: string, scopes: string[]): Promise<ExecutionContext> {
  const r = await mintExecutionContext({ credential: 'mock-credential', agent }, {
    verify: () => ({ kind: 'user', id: 'user-synthetic-1' }), selectTenant: () => tenant, grants: () => scopes, newCorrelationId: () => corr,
  });
  assert.equal(r.ok, true);
  return (r as { ok: true; context: ExecutionContext }).context;
}
const VALUES: Record<string, string> = { Address: '[ADDRESS_1]', 'Job description': 'Burst pipe repair', 'Patient reference': '[ID_1]', 'Insurance provider': 'Example Health' };
const intake = createIntakeEntry({
  registry: createTenantRegistry({ [PW]: pcfg, [DW]: dcfg }), channelRef: 'channel-ledger-test', now: () => CLOCK,
  provider: createMockProvider({
    classify_request: (req) => classifyAnswer((req.data.categories ?? []).includes('Emergency leak') ? 'Emergency leak' : 'New patient', 0.9),
    extract_fields: (req) => extractAnswer((req.data.fields ?? []).map((f) => ({ name: f.name, value: VALUES[f.name] ?? null, confidence: VALUES[f.name] ? 0.9 : null }))),
  }),
});
let seq = 0;
export const rptCtx = (tenant = PW, corr = 'corr-ledger-rpt') => mintCtx(tenant, 'reporting', corr, [REPORTING_RUN_SCOPE]);
export async function envelopeFor(tenant: string, message: Record<string, unknown>): Promise<any> {
  const r = await intake.run(await mintCtx(tenant, 'intake', `corr-ledger-intake-${++seq}`, ['intake:run']), message);
  assert.equal(r.ok, true);
  return (r as any).handoff;
}
export interface Triple { envelope: any; candidate: any; verdict: any }
/** One real Processing -> QC attempt on an existing envelope. `at` is the QC verdict's own time; `down` makes the read-back fail (an escalation). */
export async function attempt(tenant: string, envelope: any, o: { at?: string; down?: boolean } = {}): Promise<Triple> {
  const n = ++seq;
  const note = createMockNoteTool();
  const proc = createProcessingEntry({ tools: createToolRegistry({ 'mock-note': note }), plan: ['mock-note'], now: () => CLOCK });
  const pr = await proc.run(await mintCtx(tenant, 'processing', `corr-ledger-proc-${n}`, [PROCESSING_RUN_SCOPE, MOCK_NOTE_SCOPE]), envelope);
  assert.equal(pr.ok, true);
  const candidate = (pr as any).candidate;
  const empty = createMockNoteTool().reader;
  const downReader: EvidenceReader = { scope: empty.scope, read: () => Promise.reject(new Error(CANARY)), list: () => Promise.reject(new Error(CANARY)) };
  const qc = createQcEntry({ plan: ['mock-note'], readers: { 'mock-note': o.down ? downReader : note.reader }, now: () => o.at ?? CLOCK, timeoutMs: 50 });
  const qr = await qc.run(await mintCtx(tenant, 'quality-control', `corr-ledger-qc-${n}`, [QC_RUN_SCOPE, MOCK_NOTE_READ_SCOPE]), candidate, envelope);
  assert.equal(qr.ok, true);
  return { envelope, candidate, verdict: (qr as any).verdict };
}
export const reporting = (over: Record<string, unknown> = {}) => createReportingEntry({ now: () => CLOCK, ...over });
export const okSubmit = (r: SubmitResult) => { assert.equal(r.ok, true, JSON.stringify((r as any).error)); return r as Extract<SubmitResult, { ok: true }>; };
export function reportOf(r: ReportResult) {
  assert.equal(r.ok, true, JSON.stringify((r as any).error));
  const rep = (r as Extract<ReportResult, { ok: true }>).report;
  assert.deepEqual(validateReport(rep), []);
  return rep;
}
