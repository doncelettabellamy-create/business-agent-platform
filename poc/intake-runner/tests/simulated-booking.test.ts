// End-to-end regressions for the SIMULATED booking path: eligible confirmed Intake record -> mock availability and pricing -> approved mock booking -> QC -> Reporting.
// SIMULATION ONLY. Synthetic data, a mock model, an in-memory mock calendar, the in-memory approval store and a test witness for the address state: no network, no key,
// no contact vault, no contact key, no real side effect. The saved booking outcome is checked against what QC and Reporting say.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createIntakeEntry } from '../src/intake-entry.ts';
import { createTenantRegistry } from '../src/tenant-boundary.ts';
import { mintExecutionContext } from '../src/execution-context.ts';
import type { ExecutionContext } from '../src/execution-context.ts';
import { mintApproverContext } from '../src/approver-context.ts';
import { approvalScopeFor, decideProposal } from '../src/approval.ts';
import { createInMemoryApprovalStore } from '../src/approval-store.ts';
import { classifyAnswer, createMockProvider, extractAnswer } from '../src/mock-provider.ts';
import { createIntakeRecordStore } from '../src/intake-record-store.ts';
import type { AddressWitness, IntakeRecord } from '../src/intake-record-store.ts';
import { loadFixture } from '../src/pricing-fixture.ts';
import { BOOKING_TOOL, createMockCalendar, createSimulatedBooking, IDEMPOTENT_BOOKING_TOOLS } from '../src/simulated-booking.ts';
import type { CalendarFault } from '../src/simulated-booking.ts';
import { validateReport } from '../src/report.ts';
import type { HandoffEnvelopeV1 } from '../src/contracts.ts';

const T0 = '2026-10-29T02:00:00Z';
const nowIso = (): string => T0;
const CW = 'ws-synthetic-cleaning';
const read = (n: string) => JSON.parse(readFileSync(new URL(`../examples/${n}`, import.meta.url), 'utf8'));
const { skill_config: cfg, ...baseMsg } = read('skill-cleaning-services.json');
const fixture = loadFixture(read('pricing-fixture-drew-cleaning.json'));

// Synthetic, masked answers for a house the SIMULATION fixture can price and the mock calendar can book.
const GOOD: Record<string, string> = {
  'Property type': 'house', 'Number of bedrooms': 'two', 'Number of bathrooms': 'one', Pets: 'no', 'Cleaning frequency': 'weekly', Extras: 'none',
  'First cleaning with us': 'yes', 'Preferred date': 'Friday', 'Time window': 'morning',
};
const intakeFor = (values: Record<string, string>) => createIntakeEntry({
  registry: createTenantRegistry({ [CW]: cfg }), channelRef: 'channel-sim-booking', now: nowIso,
  provider: createMockProvider({
    classify_request: () => classifyAnswer('Standard cleaning', 0.9),
    extract_fields: (req) => extractAnswer((req.data.fields ?? []).map((f) => ({ name: f.name, value: values[f.name] ?? null, confidence: values[f.name] ? 0.9 : null }))),
  }),
});
let seq = 0;
async function intakeCtx(): Promise<ExecutionContext> {
  const r = await mintExecutionContext({ credential: 'c', agent: 'intake' }, { verify: () => ({ kind: 'user', id: 'user-sim' }), selectTenant: () => CW, grants: () => ['intake:run'], newCorrelationId: () => `corr-intake-${++seq}` });
  assert.equal(r.ok, true);
  return (r as { context: ExecutionContext }).context;
}
/** A REAL sealed hand-off from the real Intake entry (the original object, as the call logic's seam would hand it over). */
async function handoffFor(values: Record<string, string> = GOOD, eventId = 'evt-synthetic-sim-booking-001'): Promise<HandoffEnvelopeV1> {
  const r: any = await intakeFor(values).run(await intakeCtx(), { ...baseMsg, event_id: eventId, masked_text: `Caller: I need a standard cleaning. ${Object.values(values).join('. ')}.` });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.handoff, 'the synthetic request must be ready and handed off: ' + JSON.stringify([r.workItem?.status, r.workItem?.reasons, r.workItem?.missing_fields]));
  return r.handoff as HandoffEnvelopeV1;
}
const hex = (n: number): string => n.toString(16).padStart(16, '0');
/** The saved record the call logic would have written for this hand-off. */
function recordFor(h: HandoffEnvelopeV1, n: number, over: Partial<IntakeRecord> = {}): IntakeRecord {
  const w = h.payload;
  return {
    item_id: w.item_id, workspace_id: CW, call_ref: hex(n), received_at: T0, category: w.category, status: 'ready', reasons: [], missing_fields: [],
    fields: w.fields.map((f) => ({ name: f.name, value: f.value === null ? null : String(f.value), confidence: f.confidence, found: f.found })),
    pii_summary: [], confidence: 0.9, versions: { ...w.versions }, handed_off: true, turns: 12, confirmation: 'confirmed', address_status: 'caller_confirmed', ...over,
  };
}
const confirmedWitness: AddressWitness = { addressState: () => 'confirmed' };
const SLOTS = [{ id: 'slot-fri-am', date_phrase: 'friday', window_phrase: 'morning' }, { id: 'slot-fri-pm', date_phrase: 'friday', window_phrase: 'afternoon' }];

function rig(o: { witness?: AddressWitness | null; fault?: CalendarFault } = {}) {
  const records = createIntakeRecordStore({ path: ':memory:' });
  const calendar = createMockCalendar(SLOTS);
  if (o.fault) calendar.setFault(o.fault);
  const store = createInMemoryApprovalStore({ now: nowIso, idempotentTools: [...IDEMPOTENT_BOOKING_TOOLS] });
  const booking = createSimulatedBooking({ records, ...(o.witness === null ? {} : { witness: o.witness ?? confirmedWitness }), fixture, calendar, store, now: nowIso });
  const save = (r: IntakeRecord) => { assert.equal(records.put(CW, r), 'new'); return r; };
  return { records, calendar, store, booking, save };
}
async function approve(store: ReturnType<typeof rig>['store'], pending: any): Promise<void> {
  const m: any = await mintApproverContext({ credential: 'c', workspace_id: CW }, {
    verify: () => ({ kind: 'user', id: 'user-owner', assurance: 'multi-factor', authenticated_at: T0, session_expires_at: '2026-10-29T12:00:00Z' }),
    membership: () => true, grants: () => [approvalScopeFor(BOOKING_TOOL)], newCorrelationId: () => `corr-owner-${++seq}`, now: nowIso,
  });
  assert.equal(m.ok, true);
  const d: any = decideProposal(m.context, pending.proposal, { decision: 'approved', reason_code: 'within_policy' }, { now: nowIso });
  assert.equal(d.ok, true, JSON.stringify(d.error));
  const r: any = await store.recordDecision(m.context, d.decision);
  assert.equal(r.ok, true, JSON.stringify(r.error));
}
/** Run, approve the waiting booking, run again: the booking is attempted and the pipeline reports. */
async function bookWithApproval(g: ReturnType<typeof rig>, h: HandoffEnvelopeV1, n: number) {
  const first: any = await g.booking.run(h, { tenant: CW, callRef: hex(n) });
  assert.equal(first.status, 'awaiting_approval', JSON.stringify(first.reason));
  await approve(g.store, first.pending);
  return { first, second: (await g.booking.run(h, { tenant: CW, callRef: hex(n) })) as any };
}
async function reportOf(g: ReturnType<typeof rig>): Promise<any> {
  const r: any = await g.booking.reporting.report(await intakeCtxFor('reporting', ['reporting:run']));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(validateReport(r.report), []);
  return r.report;
}
async function intakeCtxFor(agent: any, scopes: string[]): Promise<ExecutionContext> {
  const r = await mintExecutionContext({ credential: 'c', agent }, { verify: () => ({ kind: 'user', id: 'user-sim' }), selectTenant: () => CW, grants: () => scopes, newCorrelationId: () => `corr-x-${++seq}` });
  assert.equal(r.ok, true);
  return (r as { context: ExecutionContext }).context;
}
const nothingHappened = (g: ReturnType<typeof rig>) => assert.deepEqual([g.calendar.bookCalls(), g.calendar.bookings().length, g.booking.quoteChecks(), g.booking.availabilityChecks()], [0, 0, 0, 0]);

test('one correct booking: the record is gated, the booking waits for approval, then QC passes it and Reporting counts it once; the saved outcome agrees', async () => {
  const g = rig(); const h = await handoffFor(); g.save(recordFor(h, 1));
  const first: any = await g.booking.run(h, { tenant: CW, callRef: hex(1) });
  assert.equal(first.status, 'awaiting_approval');
  assert.equal(g.calendar.bookings().length, 0, 'nothing is booked before the owner approves');
  assert.equal(g.calendar.bookCalls(), 0);
  await approve(g.store, first.pending);
  const done: any = await g.booking.run(h, { tenant: CW, callRef: hex(1) });
  assert.deepEqual([done.status, done.verdict, done.counted, done.slot_id], ['booked', 'pass', 'accepted', 'slot-fri-am']);
  // The calendar holds exactly the one booking QC verified, under the evidence the outcome names.
  assert.equal(g.calendar.bookings().length, 1);
  assert.deepEqual([g.calendar.bookings()[0].evidence_ref, g.calendar.bookings()[0].item_id, g.calendar.bookings()[0].slot_id], [done.evidence_ref, h.item_id, done.slot_id]);
  assert.equal(g.booking.quoteChecks(), 1, 'the SIMULATION quote was priced from the saved record');
  assert.equal(g.booking.availabilityChecks(), 1);
  const report = await reportOf(g);
  assert.deepEqual([report.counts.submitted, report.counts.counted_items, report.counts.verified_simulated_pass, report.counts.rework, report.counts.escalate], [1, 1, 1, 0, 0]);
  assert.deepEqual(report.statuses.map((s: any) => [s.item_id, s.current]), [[h.item_id, 'pass']]);
  assert.deepEqual(g.booking.outcomeFor(CW, h.item_id), done, 'the saved outcome is the one returned');
  // Privacy: the outcome carries ids, the slot and fixed words, never an answer or a contact value.
  assert.ok(!JSON.stringify({ ...done, pending: undefined }).match(/house|Friday|morning|weekly|two/), JSON.stringify(done));
});

test('a retry books nothing more: the same request again finds the recorded booking, Reporting counts a repeat, the calendar is called once', async () => {
  const g = rig(); const h = await handoffFor(); g.save(recordFor(h, 2));
  const { second } = await bookWithApproval(g, h, 2);
  assert.equal(second.status, 'booked');
  for (let i = 0; i < 2; i++) {
    const again: any = await g.booking.run(h, { tenant: CW, callRef: hex(2) });
    assert.deepEqual([again.status, again.verdict, again.counted, again.slot_id], ['booked', 'pass', 'repeat', 'slot-fri-am']);
  }
  assert.deepEqual([g.calendar.bookCalls(), g.calendar.bookings().length], [1, 1]);
  const report = await reportOf(g);
  assert.deepEqual([report.counts.counted_items, report.counts.verified_simulated_pass, report.counts.repeat_attempts], [1, 1, 2]);
  assert.equal(report.statuses.length, 1);
});

test('blocked: an unverified address, an unconfirmed request, a missing or unwitnessed confirmation, no record, a mismatch or a forged hand-off never reach a tool', async () => {
  const h = await handoffFor();
  const cases: Array<[string, IntakeRecord | null, Parameters<typeof rig>[0], string]> = [
    ['unverified address', recordFor(h, 3, { address_status: 'unverified' }), {}, 'NOT_ELIGIBLE'],
    ['unconfirmed request', recordFor(h, 3, { confirmation: 'unconfirmed', status: 'needs-human', reasons: ['not_confirmed'], handed_off: false, address_status: 'unverified' }), {}, 'NOT_ELIGIBLE'],
    ['held for a person', recordFor(h, 3, { status: 'needs-human', reasons: ['human_review'], handed_off: false }), {}, 'NOT_ELIGIBLE'],
    ['caller_confirmed without a witness', recordFor(h, 3), { witness: null }, 'NOT_ELIGIBLE'],
    ['vault says unconfirmed', recordFor(h, 3), { witness: { addressState: () => 'unconfirmed' } }, 'NOT_ELIGIBLE'],
    ['witness fails', recordFor(h, 3), { witness: { addressState: () => { throw new Error('vault unavailable'); } } }, 'NOT_ELIGIBLE'],
    ['no saved record', null, {}, 'NO_RECORD'],
  ];
  for (const [label, rec, opts, reason] of cases) {
    const g = rig(opts); if (rec) g.save(rec);
    const out: any = await g.booking.run(h, { tenant: CW, callRef: hex(3) });
    assert.deepEqual([label, out.status, out.reason], [label, 'blocked', reason]);
    nothingHappened(g);
    assert.equal((await reportOf(g)).counts.submitted, 0, `${label}: nothing was reported either`);
  }
  // A record for another item under the same call reference.
  const other = await handoffFor(GOOD, 'evt-synthetic-sim-booking-002');
  const g1 = rig(); g1.save(recordFor(other, 3));
  const mism: any = await g1.booking.run(h, { tenant: CW, callRef: hex(3) });
  assert.deepEqual([mism.status, mism.reason], ['blocked', 'RECORD_MISMATCH']); nothingHappened(g1);
  // A forged copy of an eligible hand-off is not the sealed original: Processing refuses it, so no tool runs.
  const g2 = rig(); g2.save(recordFor(h, 4));
  const forged: any = await g2.booking.run(structuredClone(h), { tenant: CW, callRef: hex(4) });
  assert.deepEqual([forged.status, forged.reason], ['failed', 'PIPELINE_REFUSED']); nothingHappened(g2);
});

test('a request a person must price or schedule is not booked: no price, an unknown slot or a taken slot stop the plan before the approval step', async () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['four bedrooms: the fixture does not price it', { ...GOOD, 'Number of bedrooms': 'four' }],
    ['not a first clean', { ...GOOD, 'First cleaning with us': 'no' }],
    ['extras requested', { ...GOOD, Extras: 'inside the oven' }],
    ['a date the mock calendar does not know', { ...GOOD, 'Preferred date': 'sometime next week' }],
  ];
  let n = 10;
  for (const [label, values] of cases) {
    const g = rig(); const h = await handoffFor(values, `evt-synthetic-sim-booking-${++n}`); g.save(recordFor(h, n));
    const out: any = await g.booking.run(h, { tenant: CW, callRef: hex(n) });
    assert.deepEqual([label, out.status, out.verdict, out.pending], [label, 'not_booked', 'rework', undefined]);
    assert.deepEqual([g.calendar.bookCalls(), g.calendar.bookings().length], [0, 0], label);
    const report = await reportOf(g);
    assert.deepEqual([report.counts.rework, report.counts.verified_simulated_pass], [1, 0], label);
  }
  // A slot another request already holds is not offered to a second one.
  const g = rig(); const a = await handoffFor(GOOD, 'evt-synthetic-sim-booking-021'); const b = await handoffFor(GOOD, 'evt-synthetic-sim-booking-022');
  g.save(recordFor(a, 21)); g.save(recordFor(b, 22));
  assert.equal((await bookWithApproval(g, a, 21)).second.status, 'booked');
  const second: any = await g.booking.run(b, { tenant: CW, callRef: hex(22) });
  assert.deepEqual([second.status, second.verdict], ['not_booked', 'rework']);
  assert.equal(g.calendar.bookings().length, 1, 'one booking per slot');
});

test('honest tool failure: a calendar that throws or declines never leaves a claimed booking, and Reporting does not count a pass', async () => {
  // The calendar fails after the owner approved: the outcome is unknown, so it is escalated and never reported as booked.
  const g = rig({ fault: 'throw' }); const h = await handoffFor(); g.save(recordFor(h, 30));
  const { second } = await bookWithApproval(g, h, 30);
  assert.deepEqual([second.status, second.verdict], ['not_verified', 'escalate']);
  assert.equal(g.calendar.bookings().length, 0);
  assert.equal(g.calendar.bookCalls(), 1);
  const again: any = await g.booking.run(h, { tenant: CW, callRef: hex(30) });
  assert.notEqual(again.status, 'booked', 'running it again does not turn an unknown outcome into a booking');
  assert.equal(g.calendar.bookings().length, 0);
  const report = await reportOf(g);
  assert.deepEqual([report.counts.verified_simulated_pass, report.counts.escalate], [0, 1]);
  assert.equal(g.booking.outcomeFor(CW, h.item_id)?.status, again.status);

  // The calendar answers that it did not book: a definite "not done", reworked, not a pass.
  const d = rig({ fault: 'decline' }); const h2 = await handoffFor(GOOD, 'evt-synthetic-sim-booking-031'); d.save(recordFor(h2, 31));
  const { second: s2 } = await bookWithApproval(d, h2, 31);
  assert.deepEqual([s2.status, s2.verdict], ['not_booked', 'rework']);
  assert.equal(d.calendar.bookings().length, 0);
  const r2 = await reportOf(d);
  assert.deepEqual([r2.counts.verified_simulated_pass, r2.counts.rework], [0, 1]);
});

test('mock only: the module has no network, file, process or contact-vault access', () => {
  const src = readFileSync(new URL('../src/simulated-booking.ts', import.meta.url), 'utf8');
  assert.ok(!/from 'node:(?:fs|net|http|https|child_process|dgram|tls|dns|worker_threads)'|\bfetch\(|WebSocket|process\.env|createContactVault|contact-vault|contactsPathFor|keyFromEnv/.test(src));
});
