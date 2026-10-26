// One phone call over Twilio ConversationRelay (proof of concept, founder test). Ties the pieces together and adds no judgement of its own:
//
//   Twilio `setup`   the dialed number picks the tenant from a server-side table (never from speech); unknown number, kill switch, a call
//                    already running, or a call id seen before -> the call is ended and nothing is processed. The caller's number is not read.
//   first `prompt`   the answer to the spoken consent notice. Not a plain yes -> goodbye, hang up, nothing kept, no model contacted.
//   later `prompt`   masked (pii-screen.ts); a refused utterance ends the call. The existing Intake agent runs over the masked caller
//                    lines in the background (what is still missing?) while the dialogue model streams the next spoken reply. Intake's
//                    answer steers the NEXT turn.
//   read-back        when Intake says `ready`, a fresh Intake run over everything heard so far is awaited; if it is still ready the server
//                    itself (not the model) reads back the non-address fields in fixed words and asks for a yes or no. The address is
//                    never spoken, in any form. A yes confirms exactly the item that was read back; a no goes back to listening (at most
//                    two read-backs); anything unclear twice, or silence, ends the call unconfirmed.
//   end of call      the record is saved. CONFIRMED only after a yes to the read-back; every other ending (hang-up, limit, timeout, error,
//                    no) is saved from one final Intake run as UNCONFIRMED: needs-human, not handed off, reason `not_confirmed`. The call
//                    state, with its raw-to-placeholder map, is cleared first. The kill switch ends the call without that final run.
// Nothing here logs speech: log() receives fixed codes and counts only. Raw speech is passed to the masker and dropped.

import { callRefFor, NOT_CONFIRMED, RecordRefused } from './intake-record-store.ts';
import type { IntakeRecord, IntakeRecordStore } from './intake-record-store.ts';
import { createCallSession } from './call-session.ts';
import type { CallSession, SessionLimits } from './call-session.ts';
import { runCallIntake } from './call-intake.ts';
import type { IntakeEntry } from './intake-entry.ts';
import type { DialogueModel } from './dialogue-model.ts';
import type { RelayConnection } from './ws-server.ts';
import { isRecord } from './contracts.ts';
import type { WorkItemV1 } from './contracts.ts';
import { piiProblems } from './pii-screen.ts';

const CALL_SID = /^[A-Za-z0-9]{10,40}$/;
const E164 = /^\+[1-9][0-9]{6,14}$/;
const MAX_READBACKS = 2;
const MAX_SPEECH_WAIT_MS = 15_000;
const PLACEHOLDER = /\[[A-Z]+_\d{1,3}\]/g;
/** What the dialogue model is asked to collect when Intake is not ready but names no missing field. */
export const MORE_ABOUT_REQUEST = 'a short description of what the caller needs';

export const SAY = Object.freeze({
  declined: 'No problem. This test line will not continue. Goodbye.',
  unavailable: 'Sorry, this test line is not available right now. Goodbye.',
  trouble: "Sorry, I can't continue this call. A person will follow up. Goodbye.",
  limit: 'Thank you. That is all the time I have for this call. A person will follow up. Goodbye.',
  thanks: 'Thank you. Your request is recorded and a person will follow up. Goodbye.',
  correct: 'Sorry about that. What should I change?',
  yesno: 'Sorry, I did not catch that. Please say yes or no.',
  silence: 'I did not hear a reply. A person will follow up. Goodbye.',
  unconfirmed: 'Thank you. I could not confirm the details, so a person will follow up. Goodbye.',
});

/** How long a spoken line needs to play: a fixed pad plus a time per character, never more than the cap. Pure. */
export function speechDelayMs(text: string, msPerChar = 70, padMs = 1500): number {
  return Math.min(MAX_SPEECH_WAIT_MS, padMs + text.length * msPerChar);
}

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
  /** Calls this handler will accept in its lifetime. Setups after that are refused, which bounds what a leaked path and signature could do. */
  maxCalls: number;
  now(): number;
  nowIso(): string;
  killed(): boolean;
  /** The least time to let the last spoken words play after the record is saved (Twilio ends the call as soon as it gets `end`). */
  afterSpeechMs: number;
  /** How long a line needs to play, in milliseconds (see speechDelayMs). The call is not ended before this has passed (capped at 15 s). */
  speechMs(text: string): number;
  /** How long to wait for the caller's yes or no after a read-back before ending the call unconfirmed. */
  confirmWaitMs: number;
  /** Fixed codes and counts only. */
  log(code: string, detail?: Record<string, string | number>): void;
}
export interface RelayHandler {
  handle(conn: RelayConnection): void;
  active(): number;
  /** Resolves when no call has work in flight (used by the tests and the shutdown path). */
  idle(): Promise<void>;
}

interface Preview { item: WorkItemV1; handedOff: boolean }

/** The read-back, in fixed words: the non-address fields only. A placeholder is never spoken, and a value that still looks personal is left out. */
export function readBackText(item: WorkItemV1): string {
  const parts: string[] = [];
  for (const f of item.fields) {
    if (!f.found || f.value === null || /address/i.test(f.name)) continue;
    const v = String(f.value).replace(PLACEHOLDER, 'a detail you gave').slice(0, 120).trim();
    if (v.length === 0 || piiProblems(v).length > 0) continue;
    parts.push(`${f.name}: ${v}.`);
  }
  return `Let me check what I have. ${parts.length > 0 ? parts.join(' ') : 'I have your request.'} Is that correct? Please say yes or no.`;
}

export function createRelayHandler(deps: RelayDeps): RelayHandler {
  const fns = ['fieldNames', 'intakeContext', 'now', 'nowIso', 'killed', 'log', 'speechMs'] as const;
  if (!isRecord(deps) || !(deps.numbers instanceof Map) || !isRecord(deps.intake) || !isRecord(deps.dialogue) || !isRecord(deps.store) || !isRecord(deps.limits)
    || !Array.isArray(deps.names) || !Number.isInteger(deps.afterSpeechMs) || !Number.isInteger(deps.confirmWaitMs) || deps.confirmWaitMs < 1 || !Number.isInteger(deps.maxCalls) || deps.maxCalls < 1
    || !fns.every((f) => typeof (deps as unknown as Record<string, unknown>)[f] === 'function')) {
    throw new RangeError('the relay handler needs every dependency');
  }
  let active = 0;
  let accepted = 0;
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
    let latest: Preview | undefined;   // the newest successful Intake run over everything heard
    let background: Promise<void> | undefined;
    let previewN = 0;
    let phase: 'collect' | 'confirm' = 'collect';
    let readbacks = 0;
    let unclear = 0;
    let readBack: Preview | undefined;   // exactly what the caller was asked to confirm
    let confirmTimer: ReturnType<typeof setTimeout> | undefined;
    let setupSeen = false;   // a prompt may arrive while setup is still being prepared: it waits behind it
    let hardStop: ReturnType<typeof setTimeout> | undefined;
    const setupTimer = setTimeout(() => { if (session === undefined) { deps.log('SETUP_TIMEOUT'); conn.close(1008); } }, 5000);
    setupTimer.unref?.();

    /** `final` lines end the call, so the caller cannot talk over them. */
    const say = (text: string, final = false): void => { conn.send(final ? { type: 'text', token: text, last: true, interruptible: false } : { type: 'text', token: text, last: true }); };
    const clearConfirmTimer = (): void => { if (confirmTimer !== undefined) { clearTimeout(confirmTimer); confirmTimer = undefined; } };
    function release(): void {
      clearTimeout(setupTimer);
      clearConfirmTimer();
      if (hardStop !== undefined) clearTimeout(hardStop);
      if (counted) { counted = false; active--; }
    }
    /** Ends the call after the spoken line has had time to play: at least afterSpeechMs, and at least the line's own length from when it was sent. */
    const hangUp = async (spoken?: string, spokeAt?: number): Promise<void> => {
      const need = spoken === undefined ? 0 : Math.min(MAX_SPEECH_WAIT_MS, Math.max(0, deps.speechMs(spoken)));
      const left = need - (spokeAt === undefined ? 0 : deps.now() - spokeAt);
      const wait = Math.max(deps.afterSpeechMs, left);
      if (wait > 0) await new Promise<void>((r) => { setTimeout(r, wait); });
      conn.send({ type: 'end' }); conn.close(1000);
    };
    /** A closing line, then the save (while it plays), then the hang-up. */
    async function farewell(line: string, save: boolean): Promise<void> {
      say(line, true);
      const at = deps.now();
      await finish(save);
      await hangUp(line, at);
    }

    /**
     * The save. The state is cleared first so nothing raw or masked outlives the call. With `confirmed`, the record is exactly the item the caller
     * said yes to; otherwise one final Intake run is made, and the record is held for a person whatever that run says.
     */
    async function finish(save: boolean, confirmed?: Preview): Promise<void> {
      if (done) return;
      done = true;
      release();
      const s = session;
      if (s === undefined) return;
      const text = s.maskedText(); const pii = s.piiSummary(); const turns = s.turns();
      s.dispose();
      if (!save || turns === 0) { deps.log('CALL_ENDED', { turns, saved: 0 }); return; }
      let w: WorkItemV1; let handedOff: boolean;
      if (confirmed !== undefined) { w = confirmed.item; handedOff = confirmed.handedOff; }
      else {
        const r = await runCallIntake(deps.intake, ctx, { tenant, callId, tag: 'final', maskedText: text, pii });
        if (!r.ok) { deps.log('FINAL_INTAKE_FAILED', { code: r.code }); return; }
        w = r.item; handedOff = r.handedOff;
      }
      const ok = confirmed !== undefined && w.status === 'ready' && handedOff;
      const found = w.fields.filter((f) => f.found && f.confidence !== null).map((f) => f.confidence as number);
      const record: IntakeRecord = {
        item_id: w.item_id, workspace_id: tenant, call_ref: ref, received_at: deps.nowIso(), category: w.category,
        status: ok ? w.status : 'needs-human',
        reasons: ok ? [...w.reasons] : [...new Set([...w.reasons, NOT_CONFIRMED])], missing_fields: [...w.missing_fields],
        fields: w.fields.map((f) => ({ name: f.name, value: f.value, confidence: f.confidence, found: f.found })),
        pii_summary: w.pii_summary.map((p) => ({ type: p.type, count: p.count })),
        confidence: found.length > 0 ? Math.min(...found) : null, versions: { ...w.versions }, handed_off: ok, turns,
        confirmation: ok ? 'confirmed' : 'unconfirmed',
        address_status: w.fields.some((f) => f.found && /address/i.test(f.name)) ? 'unverified' : 'none',
      };
      deps.log(ok ? 'CONFIRMED' : 'UNCONFIRMED', { turns });
      try { deps.log('RECORD_' + deps.store.put(tenant, record).toUpperCase(), { turns }); }
      catch (e) { deps.log(e instanceof RecordRefused ? 'RECORD_REFUSED' : 'RECORD_FAILED'); }
    }

    /** One Intake run over everything heard so far. A failure clears `ready`, so a stale yes is never read back. */
    function runPreview(): Promise<void> {
      const s = session;
      if (s === undefined || s.turns() === 0) return Promise.resolve();
      const tag = `p${++previewN % 1000}`;
      const text = s.maskedText(); const pii = s.piiSummary();
      return track(runCallIntake(deps.intake, ctx, { tenant, callId, tag, maskedText: text, pii }).then((r) => {
        if (done) return;
        if (r.ok) { missing = [...r.item.missing_fields]; ready = r.item.status === 'ready'; latest = { item: r.item, handedOff: r.handedOff }; }
        else { deps.log('PREVIEW_FAILED', { code: r.code }); ready = false; latest = undefined; }
      }, () => { ready = false; latest = undefined; }));
    }
    function previewIntake(): void {
      if (background !== undefined) return;
      const p = runPreview().finally(() => { if (background === p) background = undefined; });
      background = p;
    }
    /** Waits for any background run, then makes a fresh one that includes the caller's latest words. */
    async function previewNow(): Promise<void> {
      if (background !== undefined) await background;
      if (!done) await runPreview();
    }

    async function speak(): Promise<void> {
      const s = session as CallSession;
      const controller = new AbortController();
      streaming = controller;
      let said = '';
      try {
        // An empty list means "wrap up" to the dialogue model, and only the server's own read-back may end a call. When Intake is not ready but
        // lists nothing missing (an unknown category, say), the model is asked for more about the request instead of saying goodbye.
        const stillNeeded = missing.length > 0 ? missing : [MORE_ABOUT_REQUEST];
        for await (const piece of deps.dialogue.reply({ turns: s.dialogue(), missing: stillNeeded, signal: controller.signal })) {
          if (controller.signal.aborted || done) break;
          said += piece;
          conn.send({ type: 'text', token: piece, last: false });
        }
        if (!controller.signal.aborted && !done) conn.send({ type: 'text', token: '', last: true });
      } catch {
        deps.log('DIALOGUE_FAILED');
        if (!done) await farewell(SAY.trouble, true);
        return;
      } finally { streaming = undefined; }
      if (done) return;
      s.said(said);
      if (controller.signal.aborted) { s.interrupted(interruptedText); interruptedText = ''; }
    }
    let interruptedText = '';

    function armConfirmTimer(): void {
      clearConfirmTimer();
      confirmTimer = setTimeout(() => {
        chain = chain.then(async () => {
          if (done || phase !== 'confirm') return;
          deps.log('CONFIRM_TIMEOUT');
          await farewell(SAY.silence, true);
        }).catch(() => deps.log('HANDLER_ERROR'));
        void track(chain);
      }, deps.confirmWaitMs);
      confirmTimer.unref?.();
    }

    function startReadback(item: Preview): void {
      const s = session as CallSession;
      phase = 'confirm'; readbacks++; unclear = 0; readBack = item;
      const text = readBackText(item.item);
      say(text);
      s.said(text);
      deps.log('READBACK', { n: readbacks });
      armConfirmTimer();
    }

    async function onAnswer(line: string): Promise<void> {
      const s = session as CallSession;
      const a = s.answer(line);
      if (a === 'yes') {
        const item = readBack;
        say(SAY.thanks, true);
        const at = deps.now();
        await finish(true, item);
        return await hangUp(SAY.thanks, at);
      }
      if (a === 'no') {
        if (readbacks >= MAX_READBACKS) return await farewell(SAY.unconfirmed, true);
        phase = 'collect'; ready = true; latest = undefined; readBack = undefined;   // `ready` here means: check again after the correction
        say(SAY.correct); s.said(SAY.correct);
        return;
      }
      if (++unclear > 1) return await farewell(SAY.unconfirmed, true);
      say(SAY.yesno); s.said(SAY.yesno);
      armConfirmTimer();
    }

    async function onPrompt(raw: unknown): Promise<void> {
      const s = session;
      if (s === undefined || done) return;
      clearConfirmTimer();
      if (s.state === 'consent') {
        if (s.consent(raw) === 'declined') { await farewell(SAY.declined, false); return; }
        deps.log('CONSENT_GRANTED');
        return speak();
      }
      const limit = s.limit();
      if (limit === 'KILLED') { await farewell(SAY.unavailable, false); return; }
      if (limit !== null) { await farewell(SAY.limit, true); return; }   // the cap is reached BEFORE this utterance is taken in
      const heard = s.hear(raw);
      if (!heard.ok) { deps.log('UTTERANCE_REFUSED', { code: heard.code }); await farewell(SAY.trouble, true); return; }
      if (phase === 'confirm') return onAnswer(heard.line);
      if (ready) {
        await previewNow();
        if (done) return;
        if (ready && latest !== undefined) return startReadback(latest);
      } else previewIntake();
      return speak();
    }

    async function onSetup(m: Record<string, unknown>): Promise<void> {
      clearTimeout(setupTimer);
      const to = m.to; const sid = m.callSid;
      const t = typeof to === 'string' && E164.test(to) ? deps.numbers.get(to) : undefined;
      if (t === undefined || typeof sid !== 'string' || !CALL_SID.test(sid)) { deps.log('SETUP_REFUSED'); done = true; return await hangUp(); }
      if (deps.killed()) { deps.log('KILLED'); done = true; say(SAY.unavailable, true); return await hangUp(SAY.unavailable, deps.now()); }
      if (accepted >= deps.maxCalls) { deps.log('CALL_BUDGET'); done = true; return await hangUp(); }
      const r = callRefFor(t, sid);
      if (active >= 1 || seen.has(r)) { deps.log(active >= 1 ? 'BUSY' : 'REPLAY'); done = true; return await hangUp(); }
      try { if (deps.store.list(t).some((x) => x.call_ref === r)) { deps.log('REPLAY'); done = true; return await hangUp(); } }
      catch { deps.log('STORE_UNAVAILABLE'); done = true; return await hangUp(); }
      seen.add(r); accepted++; active++; counted = true;
      tenant = t; callId = sid; ref = r;
      try { ctx = await deps.intakeContext(t, r); } catch { deps.log('CONTEXT_FAILED'); done = true; release(); return await hangUp(); }
      session = createCallSession({ limits: deps.limits, names: deps.names, now: deps.now, killed: deps.killed });
      missing = deps.fieldNames(t);
      hardStop = setTimeout(() => { void track(finish(true).then(() => hangUp())); }, (deps.limits.maxMinutes + 1) * 60_000);
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
        clearConfirmTimer();   // an answer is on its way: the silence timer must not win the race against it
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
