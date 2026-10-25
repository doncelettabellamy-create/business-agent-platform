// Runs the EXISTING Intake agent over a call's masked caller lines (proof of concept, founder test). This file adds no classification,
// extraction or validation of its own: it builds the one message Intake accepts and reads the result. The same function serves the
// per-turn preview (what is still missing?) and the final run (the record), so what steers the conversation is what validates the record.

import type { IntakeEntry } from './intake-entry.ts';
import type { PiiCount } from './pii-screen.ts';
import type { WorkItemV1 } from './contracts.ts';

export const FOUNDER_MASKING_SOURCE = 'founder-test-call';
const CALL_ID = /^[A-Za-z0-9]{10,40}$/;
const TAG = /^(?:p[0-9]{1,3}|final)$/;

export type CallIntakeResult =
  | { ok: true; item: WorkItemV1; handedOff: boolean }
  | { ok: false; code: string };

export async function runCallIntake(
  entry: IntakeEntry, ctx: unknown,
  call: { tenant: string; callId: string; tag: string; maskedText: string; pii: readonly PiiCount[] },
): Promise<CallIntakeResult> {
  try {
    if (!CALL_ID.test(call.callId) || !TAG.test(call.tag) || call.maskedText.length === 0) return { ok: false, code: 'CALL_INVALID' };
    const r = await entry.run(ctx, {
      workspace_id: call.tenant,
      event_id: `evt-founder-${call.callId}-${call.tag}`,
      masked_text: call.maskedText,
      pii_summary: call.pii.map((p) => ({ type: p.type, count: p.count })),
      masking: { applied: true, source: FOUNDER_MASKING_SOURCE },
    });
    if (!r.ok) return { ok: false, code: String(r.error.code) };
    return { ok: true, item: r.workItem, handedOff: r.handoff !== null };
  } catch {
    return { ok: false, code: 'INTAKE_ERROR' };
  }
}
