// One phone call over Twilio ConversationRelay (proof of concept, founder test). Ties the pieces together and adds no judgement of its own:
//
//   Twilio `setup`   the dialed number picks the tenant from a server-side table (never from speech); unknown number, kill switch, a call
//                    already running, or a call id seen before -> the call is ended and nothing is processed. The caller's number is not read.
//   first `prompt`   the answer to the spoken consent notice. Not a plain yes -> goodbye, hang up, nothing kept, no model contacted.
//   later `prompt`   masked (pii-screen.ts); a refused utterance ends the call. The existing Intake agent runs over the masked caller
//                    lines in the background (what is still missing?) while the dialogue model streams the next spoken reply. Intake's
//                    answer steers the NEXT turn; when it says `ready`, the next reply wraps up and the call ends.
//   end of call      one final Intake run over all masked caller lines produces the record, which is saved in the record store. The call
//                    state, with its raw-to-placeholder map, is cleared first. The kill switch ends the call without that final run.
// Nothing here logs speech: log() receives fixed codes and counts only. Raw speech is passed to the masker and dropped.

import { callRefFor, RecordRefused } from './intake-record-store.ts';
import type { IntakeRecord, IntakeRecordStore } from './intake-record-store.ts';
import { createCallSession } from './call-session.ts';
import type { CallSession, SessionLimits } from './call-session.ts';
import { runCallIntake } from './call-intake.ts';
import type { IntakeEntry } from './intake-entry.ts';
import type { DialogueModel } from './dialogue-model.ts';
import type { RelayConnection } from './ws-server.ts';
import { isRecord } from './contracts.ts';

const CALL_SID = /^[A-Za-z0-9]{10,40}$/;
const E164 = /^\+[1-9][0-9]{6,14}$/;

export const SAY = Object.freeze({
  declined: 'No problem. This test line will not continue. Goodbye.',
  unavailable: 'Sorry, this test line is not available right now. Goodbye.',
  trouble: "Sorry, I can't continue this call. A person will follow up. Goodbye.",
  limit: 'Thank you. That is all the time I have for this call. A person will follow up. Goodbye.',
});

export interface RelayDeps {
  /** Dialed number (E.164) -> tenant. The only way a tenant is chosen. */
  numbers: ReadonlyMap<string, string>;
  /** The field names of the tenant's configuration, used as the first "missing" list. */
  fieldNames(tenant: string): string[];
  intake: IntakeEntry;
  /** A minted Intake context for this call (the composition root mints it; this file never does). */
  intakeContext(tenant: string, callRef: string): Promise<unknown>;
  dialogue: DialogueModel;
  store: IntakeRecordStore;
  limits: SessionLimits;
  names: readonly string[];
  now(): number;
  nowIso(): string;
  killed(): boolean;
  /** How long to let the last spoken words play before the call is ended (Twilio ends the call as soon as it gets `end`). */
  afterSpeechMs: number;
  /** Fixed codes and counts only. */
  log(code: string, detail?: Record<string, string | number>): void;
}
export interface RelayHandler {
  handle(conn: RelayConnection): void;
  active(): number;
  /** Resolves when no call has work in flight (used by the tests and the shutdown path). */
  idle(): Promise<void>;
}

export function createRelayHandler(deps: RelayDeps): RelayHandler {
  const fns = ['fieldNames', 'intakeContext', 'now', 'nowIso', 'killed', 'log'] as const;
  if (!isRecord(deps) || !(deps.numbers instanceof Map) || !isRecord(deps.intake) || !isRecord(deps.dialogue) || !isRecord(deps.store) || !isRecord(deps.limits)
    || !Array.isArray(deps.names) || !Number.isInteger(deps.afterSpeechMs) || !fns.every((f) => typeof (deps as unknown as Record<string, unknown>)[f] === 'function')) {
    throw new RangeError('the relay handler needs every dependency');
  }
  let active = 0;
  const seen = new Set<string>();
  const work = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>): Promise<T> => { work.add(p); void p.finally(() => work.delete(p)).catch(() => {}); return p; };

  function handle(conn: RelayConnection): void {
    let session: CallSession | undefined;
    let tenant = '';
    let callId = '';
    let ref = '';
    let ctx: unknown;
    let counted = false;
    let done = false;
    let bad = 0;
    let chain: Promise<unknown> = Promise.resolve();
    let streaming: AbortController | undefined;
    let missing: string[] = [];
    let ready = false;
    let previewRunning = false;
    let previewN = 0;
    let setupSeen = false;   // a prompt may arrive while setup is still being prepared: it waits behind it
    let hardStop: ReturnType<typeof setTimeout> | undefined;
    const setupTimer = setTimeout(() => { if (session === undefined) { deps.log('SETUP_TIMEOUT'); conn.close(1008); } }, 5000);
    setupTimer.unref?.();

    const say = (text: string): void => { conn.send({ type: 'text', token: text, last: true }); };
    function release(): void {
      clearTimeout(setupTimer);
      if (hardStop !== undefined) clearTimeout(hardStop);
      if (counted) { counted = false; active--; }
    }
    const hangUp = async (): Promise<void> => {
      if (deps.afterSpeechMs > 0) await new Promise<void>((r) => { setTimeout(r, deps.afterSpeechMs); });
      conn.send({ type: 'end' }); conn.close(1000);
    };

    /** The final run and the save. The state is cleared first so nothing raw or masked outlives the call. */
    async function finish(save: boolean): Promise<void> {
      if (done) return;
      done = true;
      release();
      const s = session;
      if (s === undefined) return;
      const text = s.maskedText(); const pii = s.piiSummary(); const turns = s.turns();
      s.dispose();
      if (!save || turns === 0) { deps.log('CALL_ENDED', { turns, saved: 0 }); return; }
      const r = await runCallIntake(deps.intake, ctx, { tenant, callId, tag: 'final', maskedText: text, pii });
      if (!r.ok) { deps.log('FINAL_INTAKE_FAILED', { code: r.code }); return; }
      const w = r.item;
      const found = w.fields.filter((f) => f.found && f.confidence !== null).map((f) => f.confidence as number);
      const record: IntakeRecord = {
        item_id: w.item_id, workspace_id: tenant, call_ref: ref, received_at: deps.nowIso(), category: w.category, status: w.status,
        reasons: [...w.reasons], missing_fields: [...w.missing_fields],
        fields: w.fields.map((f) => ({ name: f.name, value: f.value, confidence: f.confidence, found: f.found })),
        pii_summary: w.pii_summary.map((p) => ({ type: p.type, count: p.count })),
        confidence: found.length > 0 ? Math.min(...found) : null, versions: { ...w.versions }, handed_off: r.handedOff, turns,
      };
      try { deps.log('RECORD_' + deps.store.put(tenant, record).toUpperCase(), { turns }); }
      catch (e) { deps.log(e instanceof RecordRefused ? 'RECORD_REFUSED' : 'RECORD_FAILED'); }
    }

    function previewIntake(): void {
      const s = session;
      if (s === undefined || previewRunning || s.turns() === 0) return;
      previewRunning = true;
      const tag = `p${++previewN % 1000}`;
      const text = s.maskedText(); const pii = s.piiSummary();
      void track(runCallIntake(deps.intake, ctx, { tenant, callId, tag, maskedText: text, pii }).then((r) => {
        previewRunning = false;
        if (done) return;
        if (r.ok) { missing = [...r.item.missing_fields]; ready = r.item.status === 'ready'; } else deps.log('PREVIEW_FAILED', { code: r.code });
      }, () => { previewRunning = false; }));
    }

    async function speak(wrapUp: boolean): Promise<void> {
      const s = session as CallSession;
      const controller = new AbortController();
      streaming = controller;
      let said = '';
      try {
        for await (const piece of deps.dialogue.reply({ turns: s.dialogue(), missing: wrapUp ? [] : missing, signal: controller.signal })) {
          if (controller.signal.aborted || done) break;
          said += piece;
          conn.send({ type: 'text', token: piece, last: false });
        }
        if (!controller.signal.aborted && !done) conn.send({ type: 'text', token: '', last: true });
      } catch {
        deps.log('DIALOGUE_FAILED');
        if (!done) { say(SAY.trouble); await finish(true); await hangUp(); }
        return;
      } finally { streaming = undefined; }
      if (done) return;
      s.said(said);
      if (controller.signal.aborted) { s.interrupted(interruptedText); interruptedText = ''; }
      if (wrapUp) { await finish(true); await hangUp(); }
    }
    let interruptedText = '';

    async function onPrompt(raw: unknown): Promise<void> {
      const s = session;
      if (s === undefined || done) return;
      if (s.state === 'consent') {
        if (s.consent(raw) === 'declined') { say(SAY.declined); await finish(false); await hangUp(); return; }
        deps.log('CONSENT_GRANTED');
        return speak(false);
      }
      const limit = s.limit();
      if (limit === 'KILLED') { say(SAY.unavailable); await finish(false); await hangUp(); return; }
      if (limit !== null) { say(SAY.limit); await finish(true); await hangUp(); return; }   // the cap is reached BEFORE this utterance is taken in
      const heard = s.hear(raw);
      if (!heard.ok) { deps.log('UTTERANCE_REFUSED', { code: heard.code }); say(SAY.trouble); await finish(true); await hangUp(); return; }
      const wrap = ready;
      previewIntake();
      return speak(wrap);
    }

    async function onSetup(m: Record<string, unknown>): Promise<void> {
      clearTimeout(setupTimer);
      const to = m.to; const sid = m.callSid;
      const t = typeof to === 'string' && E164.test(to) ? deps.numbers.get(to) : undefined;
      if (t === undefined || typeof sid !== 'string' || !CALL_SID.test(sid)) { deps.log('SETUP_REFUSED'); done = true; return await hangUp(); }
      if (deps.killed()) { deps.log('KILLED'); done = true; say(SAY.unavailable); return await hangUp(); }
      const r = callRefFor(t, sid);
      if (active >= 1 || seen.has(r)) { deps.log(active >= 1 ? 'BUSY' : 'REPLAY'); done = true; return await hangUp(); }
      try { if (deps.store.list(t).some((x) => x.call_ref === r)) { deps.log('REPLAY'); done = true; return await hangUp(); } }
      catch { deps.log('STORE_UNAVAILABLE'); done = true; return await hangUp(); }
      seen.add(r); active++; counted = true;
      tenant = t; callId = sid; ref = r;
      try { ctx = await deps.intakeContext(t, r); } catch { deps.log('CONTEXT_FAILED'); done = true; release(); return await hangUp(); }
      session = createCallSession({ limits: deps.limits, names: deps.names, now: deps.now, killed: deps.killed });
      missing = deps.fieldNames(t);
      hardStop = setTimeout(() => { void track(finish(true).then(hangUp)); }, (deps.limits.maxMinutes + 1) * 60_000);
      hardStop.unref?.();
      deps.log('CALL_STARTED');
    }

    conn.onMessage = (text: string): void => {
      let m: unknown;
      try { m = JSON.parse(text); } catch { if (++bad > 5) conn.close(1008); return; }
      if (!isRecord(m) || typeof m.type !== 'string') { if (++bad > 5) conn.close(1008); return; }
      const msg = m as Record<string, unknown>;
      if (msg.type === 'interrupt') {
        const spoken = typeof msg.utteranceUntilInterrupt === 'string' ? msg.utteranceUntilInterrupt.slice(0, 600) : '';
        if (streaming !== undefined) { interruptedText = spoken; streaming.abort(); } else session?.interrupted(spoken);
        return;
      }
      if (msg.type === 'setup') { if (!setupSeen && !done) { setupSeen = true; chain = chain.then(() => onSetup(msg)).catch(() => deps.log('HANDLER_ERROR')); } return; }
      if (!setupSeen) { if (++bad > 5) conn.close(1008); return; }
      if (msg.type === 'prompt') {
        if (msg.last !== true || typeof msg.voicePrompt !== 'string') return;
        const heard = msg.voicePrompt;
        chain = chain.then(() => onPrompt(heard)).catch(() => deps.log('HANDLER_ERROR'));
        void track(chain);
        return;
      }
      // dtmf, error and anything else: not used. Twilio's own error text is never logged.
      if (msg.type === 'error') deps.log('TWILIO_ERROR');
    };
    conn.onClose = (): void => {
      void track(chain.then(async () => { if (!done) await finish(!deps.killed()); release(); }).catch(() => deps.log('HANDLER_ERROR')));
    };
  }

  return Object.freeze({
    handle,
    active: () => active,
    async idle(): Promise<void> { while (work.size > 0) await Promise.allSettled([...work]); },
  });
}
