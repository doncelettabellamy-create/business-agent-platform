// SIMULATED booking path (proof of concept). SIMULATION ONLY: a mock calendar held in memory, the SIMULATION pricing fixture, nothing sent to anyone, no network,
// no file, no process, no real scheduling software. It connects modules that already exist and adds no new authority:
//
//   confirmed Intake record (saved, masked)  ->  eligibleForProcessing gate  ->  Processing plan [quote, availability, booking]  ->  QC  ->  Reporting
//
// - The sealed hand-off is the one the Intake entry issued (the `confirmedHandoff` seam of the call logic hands it over). It is never rebuilt or sealed here: Processing
//   refuses anything that is not the original sealed object.
// - The gate runs BEFORE the pipeline and again inside every tool: an unverified address, an unconfirmed request or a record that is not in the store never reaches a tool.
//   The gate is given a witness for the address state (the encrypted contact vault in production); this file never reads a contact or a contact key.
// - Tools receive only {step_id, item_id, workspace_id}. Anything else they need (service, property answers, preferred date and window) is read from the SAVED, MASKED
//   record by item id. A missing or unrecognised answer is "unknown" and never leads to a price or a slot.
// - The booking is the only human-approved tool, idempotent on the step id; the approval store, QC's read-only checks and Reporting are the existing ones.
// - `outcome` is derived from the pipeline result and never claims a booking that QC did not pass.
// What this is not: a real customer-software connection (DRF-02: per-company profiles, credentials, approvals, real writes). Nothing here writes outside this process.

import { can, isTrusted } from './execution-context.ts';
import { eligibleForProcessing } from './intake-record-store.ts';
import type { AddressWitness, IntakeRecord, IntakeRecordStore } from './intake-record-store.ts';
import { createProcessingEntry, createToolRegistry, humanApprovalExpectations, PROCESSING_RUN_SCOPE } from './processing-entry.ts';
import type { ToolArgs } from './processing-entry.ts';
import { createQcEntry, QC_RUN_SCOPE } from './qc-entry.ts';
import { createReportingEntry, REPORTING_RUN_SCOPE } from './reporting-entry.ts';
import type { ReportingEntry } from './reporting-entry.ts';
import { createPipeline } from './pipeline.ts';
import type { PipelineResult } from './pipeline.ts';
import { quoteFromWorkItem, SIMULATION } from './pricing-fixture.ts';
import type { PricingFixture } from './pricing-fixture.ts';
import type { EvidenceReader, EvidenceRecord } from './mock-tools.ts';
import { INTAKE_RUN_SCOPE } from './tenant-boundary.ts';
import type { HandoffEnvelopeV1 } from './contracts.ts';

export const QUOTE_TOOL = 'mock-quote';
export const AVAILABILITY_TOOL = 'mock-availability';
export const BOOKING_TOOL = 'mock-booking';
const WRITE = (t: string): string => `tool:${t}:write`;
const READ = (t: string): string => `tool:${t}:read`;
export const BOOKING_APPROVAL_ARGUMENTS = Object.freeze({ simulation: true, action: 'book-slot' });

// ---------------------------------------------------------------- the mock calendar
export interface MockSlot { readonly id: string; /** The caller's preferred-date answer, normalised, that selects this slot. */ readonly date_phrase: string; /** Same for the time-window answer. */ readonly window_phrase: string }
/** Test fault: 'throw' makes the booking call fail with an error (its outcome is unknown); 'decline' makes it answer that nothing was booked. */
export type CalendarFault = 'throw' | 'decline';
export interface MockCalendar {
  readonly mode: typeof SIMULATION;
  /** The slot an answer pair selects, exactly (after trimming, lower-casing and removing trailing punctuation), or undefined. Never guesses. */
  slotFor(date: unknown, window: unknown): MockSlot | undefined;
  /** True when the slot is free, or already held by this very item. */
  isFree(tenant: string, slotId: string, itemId: string): boolean;
  /** The booking evidence, or null when the calendar declined (nothing was booked). Throws when it fails (the outcome is then unknown). */
  book(args: ToolArgs, slotId: string): EvidenceRecord | null;
  readonly reader: EvidenceReader;
  /** Test hooks (the tool registry never sees them). */
  readonly bookings: () => ReadonlyArray<EvidenceRecord & { slot_id: string }>;
  readonly bookCalls: () => number;
  setFault(f: CalendarFault | null): void;
}
const norm = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase().replace(/[.!,\s]+$/g, '') : '');

export function createMockCalendar(slots: readonly MockSlot[]): MockCalendar {
  const list = Object.freeze(slots.map((s) => Object.freeze({ ...s })));
  const rows: Array<EvidenceRecord & { slot_id: string }> = [];
  const byStep = new Map<string, EvidenceRecord & { slot_id: string }>();
  let calls = 0; let fault: CalendarFault | null = null;
  const allowed = (ctx: unknown): string => { if (!isTrusted(ctx) || !can(ctx, READ(BOOKING_TOOL))) throw new Error('reader not permitted'); return ctx.workspace_id; };
  const strip = (r: EvidenceRecord & { slot_id: string }): EvidenceRecord => ({ evidence_ref: r.evidence_ref, step_id: r.step_id, item_id: r.item_id, workspace_id: r.workspace_id });
  const reader: EvidenceReader = Object.freeze({
    scope: READ(BOOKING_TOOL),
    async read(ctx: unknown, ref: string) { const t = allowed(ctx); const r = rows.find((x) => x.workspace_id === t && x.evidence_ref === ref); return r && strip(r); },
    async list(ctx: unknown, itemId: string) { const t = allowed(ctx); return rows.filter((x) => x.workspace_id === t && x.item_id === itemId).map(strip); },
  });
  return {
    mode: SIMULATION,
    slotFor: (date, window) => list.find((s) => s.date_phrase === norm(date) && s.window_phrase === norm(window)),
    isFree: (tenant, slotId, itemId) => !rows.some((r) => r.workspace_id === tenant && r.slot_id === slotId && r.item_id !== itemId),
    book(args, slotId) {
      calls++;
      if (fault === 'throw') throw new Error('mock calendar failure');
      if (fault === 'decline') return null;
      const key = `${args.workspace_id}\n${args.step_id}`;
      const seen = byStep.get(key); if (seen) return strip(seen);
      // One booking per item and per slot: a second request for the same item or a taken slot books nothing.
      const mine = rows.find((r) => r.workspace_id === args.workspace_id && r.item_id === args.item_id);
      if (mine) return strip(mine);
      const row = Object.freeze({ evidence_ref: `mock-booking:${args.step_id}`, step_id: args.step_id, item_id: args.item_id, workspace_id: args.workspace_id, slot_id: slotId });
      rows.push(row); byStep.set(key, row);
      return strip(row);
    },
    reader,
    bookings: () => rows.slice(),
    bookCalls: () => calls,
    setFault: (f) => { fault = f; },
  };
}

// ---------------------------------------------------------------- tool-side evidence (quote and availability checks)
function checkStore(tool: string) {
  const rows: EvidenceRecord[] = []; const byStep = new Map<string, string>();
  const allowed = (ctx: unknown): string => { if (!isTrusted(ctx) || !can(ctx, READ(tool))) throw new Error('reader not permitted'); return ctx.workspace_id; };
  const reader: EvidenceReader = Object.freeze({
    scope: READ(tool),
    async read(ctx: unknown, ref: string) { const t = allowed(ctx); return rows.find((r) => r.workspace_id === t && r.evidence_ref === ref); },
    async list(ctx: unknown, itemId: string) { const t = allowed(ctx); return rows.filter((r) => r.workspace_id === t && r.item_id === itemId); },
  });
  return {
    reader,
    note(args: ToolArgs): { evidence_ref: string } {
      const key = `${args.workspace_id}\n${args.step_id}`; const seen = byStep.get(key);
      if (seen) return { evidence_ref: seen };
      const ref = `${tool}:${args.step_id}`;
      rows.push(Object.freeze({ evidence_ref: ref, step_id: args.step_id, item_id: args.item_id, workspace_id: args.workspace_id })); byStep.set(key, ref);
      return { evidence_ref: ref };
    },
    count: () => rows.length,
  };
}

// ---------------------------------------------------------------- the saved booking outcome
export type BookingStatus = 'booked' | 'awaiting_approval' | 'not_booked' | 'not_verified' | 'blocked' | 'failed';
export type BlockReason = 'NO_RECORD' | 'RECORD_MISMATCH' | 'NOT_ELIGIBLE';
export interface BookingOutcome {
  readonly mode: typeof SIMULATION;
  readonly item_id: string;
  readonly workspace_id: string;
  readonly status: BookingStatus;
  /** Fixed word saying why, when the status is not 'booked'. */
  readonly reason?: BlockReason | 'NOT_PERFORMED' | 'UNCERTAIN' | 'QC_DID_NOT_PASS' | 'PIPELINE_REFUSED' | 'APPROVAL_PENDING';
  /** Present only for 'booked': the calendar slot and the evidence QC verified. */
  readonly slot_id?: string;
  readonly evidence_ref?: string;
  /** What QC and Reporting said about this run, when the pipeline reported. */
  readonly verdict?: 'pass' | 'rework' | 'escalate';
  readonly counted?: 'accepted' | 'duplicate' | 'repeat';
  /** Present only while the booking waits for the owner's approval: the existing pending-approval object (the sealed proposal is in it while this process holds it). */
  readonly pending?: Readonly<Record<string, unknown>>;
}

/** The approval store, as Processing takes it (this file builds none and never imports a concrete store). */
type ApprovalStore = NonNullable<NonNullable<Parameters<typeof createProcessingEntry>[0]['approval']>['store']>;

export interface SimulatedBookingConfig {
  /** The saved, masked Intake records (production: the dashboard's store). */
  records: Pick<IntakeRecordStore, 'list'>;
  /** Answers the address state of a call from the encrypted contact. Required for a record that claims a caller-confirmed address. */
  witness?: AddressWitness;
  fixture: PricingFixture;
  calendar: MockCalendar;
  store: ApprovalStore;
  now: () => string;
  reporting?: ReportingEntry;
  stageTimeoutMs?: number;
}
export interface SimulatedBooking {
  /** `handoff` is the original sealed object from the Intake entry; `call` is what the seam supplies. Never throws. */
  run(handoff: HandoffEnvelopeV1, call: { tenant: string; callRef: string }): Promise<BookingOutcome>;
  /** The latest saved outcome for an item, or undefined. */
  outcomeFor(tenant: string, itemId: string): BookingOutcome | undefined;
  readonly reporting: ReportingEntry;
  /** Test hooks. */
  readonly quoteChecks: () => number;
  readonly availabilityChecks: () => number;
}

export function createSimulatedBooking(config: SimulatedBookingConfig): SimulatedBooking {
  const { records, witness, fixture, calendar, store, now } = config;
  const quotes = checkStore(QUOTE_TOOL); const avail = checkStore(AVAILABILITY_TOOL);

  /** The record a tool may act on: saved, for this tenant and item, and eligible. Anything else: undefined. */
  const eligible = (tenant: string, itemId: string): IntakeRecord | undefined => {
    try { const r = records.list(tenant).find((x) => x.item_id === itemId); return r !== undefined && eligibleForProcessing(r, witness) ? r : undefined; } catch { return undefined; }
  };
  const slotOf = (r: IntakeRecord): MockSlot | undefined => {
    const v = (n: string): string | null => r.fields.find((f) => f.name === n && f.found)?.value ?? null;
    return calendar.slotFor(v('Preferred date'), v('Time window'));
  };

  const tools = createToolRegistry({
    [QUOTE_TOOL]: {
      scope: WRITE(QUOTE_TOOL),
      run: (a: ToolArgs) => {
        const r = eligible(a.workspace_id, a.item_id);
        if (r === undefined) return { not_performed: true };
        const q = quoteFromWorkItem(fixture, { category: r.category, fields: r.fields }, r.confirmation === 'confirmed');
        return q.outcome === 'priced' ? quotes.note(a) : { not_performed: true };   // a person must price anything else
      },
    },
    [AVAILABILITY_TOOL]: {
      scope: WRITE(AVAILABILITY_TOOL),
      run: (a: ToolArgs) => {
        const r = eligible(a.workspace_id, a.item_id); const s = r && slotOf(r);
        return r !== undefined && s !== undefined && s !== null && calendar.isFree(a.workspace_id, s.id, a.item_id) ? avail.note(a) : { not_performed: true };
      },
    },
    [BOOKING_TOOL]: {
      scope: WRITE(BOOKING_TOOL), approval: 'human', idempotent: true, approvalArguments: BOOKING_APPROVAL_ARGUMENTS,
      run: (a: ToolArgs) => {
        const r = eligible(a.workspace_id, a.item_id); const s = r && slotOf(r);
        if (r === undefined || s === undefined || s === null || !calendar.isFree(a.workspace_id, s.id, a.item_id)) return { not_performed: true };
        return calendar.book(a, s.id) ?? { not_performed: true };
      },
    },
  });
  const plan = [QUOTE_TOOL, AVAILABILITY_TOOL, BOOKING_TOOL];
  const processing = createProcessingEntry({ tools, plan, now, timeoutMs: 100, approval: { store } });
  const qc = createQcEntry({
    plan, now, timeoutMs: 100,
    readers: { [QUOTE_TOOL]: quotes.reader, [AVAILABILITY_TOOL]: avail.reader, [BOOKING_TOOL]: calendar.reader },
    approvals: { store, tools: humanApprovalExpectations(tools), settle: store },
  });
  const reporting = config.reporting ?? createReportingEntry({ now });
  const saved = new Map<string, BookingOutcome>();
  let seq = 0;

  function derive(handoff: HandoffEnvelopeV1, r: PipelineResult): BookingOutcome {
    const base = { mode: SIMULATION, item_id: handoff.item_id, workspace_id: handoff.workspace_id } as const;
    if (!r.ok) return { ...base, status: 'failed', reason: 'PIPELINE_REFUSED' };
    if (r.outcome === 'awaiting-approval') return { ...base, status: 'awaiting_approval', reason: 'APPROVAL_PENDING', pending: r.pending };
    if (r.outcome === 'needs-human') return { ...base, status: 'failed', reason: 'PIPELINE_REFUSED' };
    const seen = { verdict: r.verdict, counted: r.counted };
    if (r.verdict === 'pass') {
      const row = calendar.bookings().find((b) => b.workspace_id === handoff.workspace_id && b.item_id === handoff.item_id);
      // QC passed, so the calendar must hold exactly the booking QC verified; if it does not, nothing is claimed.
      return row !== undefined ? { ...base, status: 'booked', slot_id: row.slot_id, evidence_ref: row.evidence_ref, ...seen } : { ...base, status: 'not_verified', reason: 'QC_DID_NOT_PASS', ...seen };
    }
    return { ...base, status: r.verdict === 'rework' ? 'not_booked' : 'not_verified', reason: r.verdict === 'rework' ? 'NOT_PERFORMED' : 'UNCERTAIN', ...seen };
  }

  async function run(handoff: HandoffEnvelopeV1, call: { tenant: string; callRef: string }): Promise<BookingOutcome> {
    const tenant = typeof handoff?.workspace_id === 'string' ? handoff.workspace_id : '';
    const itemId = typeof handoff?.item_id === 'string' ? handoff.item_id : '';
    const blocked = (reason: BlockReason): BookingOutcome => { const o: BookingOutcome = { mode: SIMULATION, item_id: itemId, workspace_id: tenant, status: 'blocked', reason }; saved.set(`${tenant}\n${itemId}`, o); return o; };
    try {
      let rec: IntakeRecord | undefined;
      try { rec = records.list(call.tenant).find((x) => x.call_ref === call.callRef); } catch { rec = undefined; }
      if (rec === undefined) return blocked('NO_RECORD');
      if (call.tenant !== tenant || rec.item_id !== itemId || rec.workspace_id !== tenant) return blocked('RECORD_MISMATCH');
      if (!eligibleForProcessing(rec, witness)) return blocked('NOT_ELIGIBLE');

      const pipeline = createPipeline({
        // Intake already ran (it issued this sealed hand-off); this stage only passes the original object on. Processing refuses anything that is not the sealed original.
        intake: { run: async (_ctx: unknown, message: unknown) => ({ ok: true as const, outcome: 'handed-off' as const, handoff: message }) } as never,
        processing, qc, reporting,
        processingToolScopes: plan.map(WRITE), qcReaderScopes: plan.map(READ), stageTimeoutMs: config.stageTimeoutMs ?? 500,
        sources: {
          verify: () => ({ kind: 'service', id: 'svc-simulated-booking' }),
          selectTenant: () => tenant,
          grants: () => [INTAKE_RUN_SCOPE, PROCESSING_RUN_SCOPE, ...plan.map(WRITE), QC_RUN_SCOPE, ...plan.map(READ), REPORTING_RUN_SCOPE],
          newCorrelationId: () => `corr-sim-booking-${++seq}`,
        },
      });
      const result = await pipeline.run('sim', handoff);
      const out = derive(handoff, result);
      saved.set(`${tenant}\n${itemId}`, out);
      return out;
    } catch {
      const o: BookingOutcome = { mode: SIMULATION, item_id: itemId, workspace_id: tenant, status: 'failed', reason: 'PIPELINE_REFUSED' };
      saved.set(`${tenant}\n${itemId}`, o);
      return o;
    }
  }

  return Object.freeze({
    run, outcomeFor: (tenant: string, itemId: string) => saved.get(`${tenant}\n${itemId}`), reporting,
    quoteChecks: quotes.count, availabilityChecks: avail.count,
  });
}

/** The tool names the approval store must treat as idempotent for this path. */
export const IDEMPOTENT_BOOKING_TOOLS: readonly string[] = Object.freeze([BOOKING_TOOL]);
