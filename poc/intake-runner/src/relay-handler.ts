// One phone call over Twilio ConversationRelay (proof of concept, founder test). Ties the pieces together and adds no judgement of its own:
//
//   Twilio `setup`   the dialed number picks the tenant from a server-side table (never from speech); unknown number, kill switch, a call
//                    already running, or a call id seen before -> the call is ended and nothing is processed. The caller's number is not read.
//   first `prompt`   the answer to the spoken consent notice. Not a plain yes -> goodbye, hang up, nothing kept, no model contacted.
//   later `prompt`   masked (pii-screen.ts); a refused utterance ends the call. ONE Intake run over all the masked caller lines is awaited
//                    for every turn (within `previewBudgetMs`). A result that is validated (no `model_failed`) and covers every line so far
//                    is fresh; next-field.ts then chooses, by code, what happens next: read back, ask one named field, clarify, or just listen.
//                    The dialogue model is told that one directive and nothing else. A late, failed or stale result chooses nothing.
//   read-back        when the fresh result is `ready`, the server itself (not the model) reads back the non-address fields in fixed words
//                    and asks for a yes or no, on the same turn. The address is
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
import type { DialogueModel, Directive } from './dialogue-model.ts';
import { freshFrom, selectNext } from './next-field.ts';
import { spokenDigits } from './contact-capture.ts';
import { isBareAnswer, parseFirstClean } from './first-clean.ts';
import type { Contact } from './contact-capture.ts';
import type { AddressState, ContactVault, StoredContact } from './contact-vault.ts';
import type { Fresh } from './next-field.ts';
import type { CloseInfo, RelayConnection } from './ws-server.ts';
import { isRecord } from './contracts.ts';
import type { HandoffEnvelopeV1, WorkItemV1 } from './contracts.ts';
import { piiProblems } from './pii-screen.ts';

const CALL_SID = /^[A-Za-z0-9]{10,40}$/;
const E164 = /^\+[1-9][0-9]{6,14}$/;
const MAX_READBACKS = 2;
/** A caller declining to give the address (not merely correcting it). */
const ADDRESS_REFUSAL = /\b(?:rather not|prefer not|not comfortable|refuse|decline)\b|\b(?:do not|don't|dont) want to (?:give|share|say|tell)\b|\b(?:won't|will not|am not going to|not going to|not gonna) (?:give|share|say|tell)\b|\bnot (?:giving|sharing)\b/i;
const MAX_SPEECH_WAIT_MS = 15_000;
const PLACEHOLDER = /\[[A-Z]+_\d{1,3}\]/g;
const SENSITIVE_NAME = /\b(?:name|phone|mobile|cell|e-?mail|callback|contact)\b/i;
/** The record's fields with every name, phone, mobile or e-mail field's value replaced by a placeholder. Pure. */
export function redactSensitive(fields: readonly { name: string; value: string | number | boolean | null; confidence: number | null; found: boolean }[]): { name: string; value: string | number | boolean | null; confidence: number | null; found: boolean }[] {
  return fields.map((f) => ({ name: f.name, value: f.found && f.value !== null && SENSITIVE_NAME.test(f.name) ? '[CONTACT_1]' : f.value, confidence: f.confidence, found: f.found }));
}
/** Reason on a confirmed request whose contact could not be stored: it is held for a person. */
export const CONTACT_MISSING = 'contact_missing';

export const SAY = Object.freeze({
  declined: 'No problem. This test line will not continue. Goodbye.',
  unavailable: 'Sorry, this test line is not available right now. Goodbye.',
  trouble: "Sorry, I can't continue this call. Goodbye.",
  limit: 'Thank you. That is all the time I have for this call. Goodbye.',
  thanks: 'Thank you. Your request is recorded. Goodbye.',
  correct: 'Sorry about that. What should I change?',
  yesno: 'Sorry, I did not catch that. Please say yes or no.',
  silence: 'I did not hear a reply. Goodbye.',
  addressAsk: 'I have your service address. Is that correct? Please say yes or no.',   // what the dialogue history keeps: the address itself is never in it
  addressWrong: 'Sorry about that. What is the correct service address?',
  addressMissing: 'I did not catch an address. What is the service address?',
  addressRefused: 'Understood. I will not keep an address. Your request is recorded. Goodbye.',
  unconfirmed: 'Thank you. I could not confirm the details. Goodbye.',
});

/** How long a spoken line needs to play: a fixed pad plus a time per character, never more than the cap. Pure. */
export function speechDelayMs(text: string, msPerChar = 70, padMs = 1500): number {
  return Math.min(MAX_SPEECH_WAIT_MS, padMs + text.length * msPerChar);
}

export interface RelayDeps {
  /** Dialed number (E.164) -> tenant. The only way a tenant is chosen. */
  numbers: ReadonlyMap<string, string>;
  /** The category names of the tenant's configuration, offered to a caller whose request was not recognised (never customer data). */
  categoryNames(tenant: string): string[];
  /** The business-configured choices for a field, if the skill gives any. Optional: without it no choices are ever offered. */
  choicesFor?(tenant: string, field: string): readonly string[] | undefined;
  /**
   * The skill's first-cleaning question, if it has one (the field with role first_clean) and whether a category requires it. With it, a plain yes or no counts as the answer
   * ONLY when it follows that very question being asked; explicit wording ("my first cleaning", "not my first") counts wherever it was said, and the newest such answer wins.
   * Optional: without it nothing changes.
   */
  firstClean?: { field: string; required(tenant: string, category: string): boolean };
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
  /** The longest to wait for the Intake run of a turn. A result that misses it chooses nothing; the assistant just listens. */
  previewBudgetMs: number;
  /**
   * The cleaning pilot's encrypted contact vault. When present, a name, a usable callback number and a service address are required before a request
   * is ready, the number is read back with the job, and a yes stores the contact (and only then can the request be handed off). When absent, nothing
   * about contacts changes.
   */
  contacts?: ContactVault;
  /**
   * Called once, after the record is saved, when (and only when) the caller confirmed and the confirmed record is ready and handed off. It receives the ORIGINAL
   * sealed handoff envelope of the very Intake result that was read back, and the tenant and call reference. It is the single seam for a later bridge to Processing;
   * nothing here decides eligibility or uses the envelope. `addressConfirmed` is true only when the caller was read the address back and said yes (never postal validation); it is
   * in memory only and is NOT in the saved record, whose address_status stays `unverified` because that contract has no way to say "confirmed by the caller". The object is never logged or stored. A throw or rejection is caught and logged as a fixed code.
   */
  confirmedHandoff?(handoff: HandoffEnvelopeV1, call: { tenant: string; callRef: string; addressConfirmed: boolean }): unknown;
  /** Fixed codes and counts only. */
  log(code: string, detail?: Record<string, string | number>): void;
}
export interface RelayHandler {
  handle(conn: RelayConnection): void;
  active(): number;
  /** Resolves when no call has work in flight (used by the tests and the shutdown path). */
  idle(): Promise<void>;
}

/** One Intake result. `handoff` is the original sealed envelope object (in memory only: never logged, stored, copied or sent anywhere). */
interface Preview { item: WorkItemV1; handedOff: boolean; handoff: HandoffEnvelopeV1 | null }

/** The read-back, in fixed words: the non-address fields only. A placeholder is never spoken, and a value that still looks personal is left out. */
export function readBackText(item: WorkItemV1, phone?: string): string {
  const parts: string[] = [];
  for (const f of item.fields) {
    if (!f.found || f.value === null || /address/i.test(f.name)) continue;
    const v = String(f.value).replace(PLACEHOLDER, 'a detail you gave').slice(0, 120).trim();
    if (v.length === 0 || piiProblems(v).length > 0) continue;
    parts.push(`${f.name}: ${v}.`);
  }
  const callback = phone === undefined ? '' : ` Your callback number: ${spokenDigits(phone)}.`;
  return `Let me check what I have. ${parts.length > 0 ? parts.join(' ') : 'I have your request.'}${callback} Is that correct? Please say yes or no.`;
}

export function createRelayHandler(deps: RelayDeps): RelayHandler {
  const fns = ['categoryNames', 'intakeContext', 'now', 'nowIso', 'killed', 'log', 'speechMs'] as const;
  if (!isRecord(deps) || !(deps.numbers instanceof Map) || !isRecord(deps.intake) || !isRecord(deps.dialogue) || !isRecord(deps.store) || !isRecord(deps.limits)
    || !Array.isArray(deps.names) || !Number.isInteger(deps.afterSpeechMs) || !Number.isInteger(deps.confirmWaitMs) || deps.confirmWaitMs < 1 || !Number.isInteger(deps.previewBudgetMs) || deps.previewBudgetMs < 1 || !Number.isInteger(deps.maxCalls) || deps.maxCalls < 1
    || (deps.confirmedHandoff !== undefined && typeof deps.confirmedHandoff !== 'function')
    || (deps.contacts !== undefined && (!isRecord(deps.contacts) || typeof deps.contacts.put !== 'function'))
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
    let lastValid: Preview | undefined;   // the newest validated Intake run, kept only to save a record if the final run fails
    let lastValidCovers = 0;
    let previewN = 0;
    const lastAskedAt = new Map<string, number>();   // field -> caller-line count when it was last asked
    let clarified = false;
    // The field the assistant asked about most recently, but ONLY once that question was cleanly delivered (words produced, every write accepted, not cut short by the caller
    // or the end of the call) and not since reported as talked over. Until the caller's next line is read. See speak() and the interrupt handler.
    let activeAsk: string | undefined;
    let lastReply = '';   // the full text of the assistant's most recent reply, to compare with what the phone provider says was spoken before an interruption
    let capture: { yes: boolean; text: string } | undefined;   // the caller's newest attributable first-cleaning answer (their own masked words)
    let phase: 'collect' | 'confirm' | 'address' | 'addressfix' = 'collect';
    // The service-address confirmation that follows the first yes when contact capture is on.
    let addressState: AddressState | undefined; let addressTries = 0; let addressUnclear = 0;
    let addressAsked = false;   // the address question was sent in full and has not since been reported talked over: only then can a yes or no answer it
    let lastAddressText = '';
    let readbacks = 0;
    let unclear = 0;
    let readBack: Preview | undefined;   // exactly what the caller was asked to confirm
    let readBackContact: Contact | undefined;   // the contact as it stood when the number was read back: RAW, never logged, never sent to a model, cleared in finish()
    let confirmTimer: ReturnType<typeof setTimeout> | undefined;
    let setupSeen = false;   // a prompt may arrive while setup is still being prepared: it waits behind it
    let hardStop: ReturnType<typeof setTimeout> | undefined;
    // Diagnostics: counts and milliseconds only. Nothing here ever holds, or is derived from, what anyone said.
    const startedAt = deps.now();
    let lastPromptAt: number | undefined;   // when the newest FINAL caller utterance arrived
    let lastReplyEndAt: number | undefined; // when the assistant last finished (or stopped) a reply
    let replies = 0; let failedSends = 0; let partialPrompts = 0; let interrupts = 0; let otherFrames = 0;
    const setupTimer = setTimeout(() => { if (session === undefined) { deps.log('SETUP_TIMEOUT'); conn.close(1008); } }, 5000);
    setupTimer.unref?.();

    /** `final` lines end the call, so the caller cannot talk over them. */
    /** What Intake reads: the masked conversation, plus the caller's attributable first-cleaning answer on its own labelled line. */
    const intakeText = (s: CallSession): string => s.maskedText() + (capture !== undefined && deps.firstClean !== undefined ? `\n${deps.firstClean.field}: ${capture.text}` : '');
    /**
     * The first-cleaning guard. A value for the first-cleaning field survives only if it is the caller's newest attributable answer, or explicit wording said with no newer
     * attributable answer. A plain yes or no that no first-cleaning question was asked for, and anything that disagrees with the newest attributable answer, is dropped:
     * the field is not found, the item is held (reason ambiguous_field, and missing_fields when the category requires it) and its handoff is discarded. An unclear answer
     * is kept as said (it is not a yes, and the pricing fixture reads it as unknown).
     */
    function guardFirstClean(item: WorkItemV1, handoff: HandoffEnvelopeV1 | null, handedOff: boolean): { item: WorkItemV1; handoff: HandoffEnvelopeV1 | null; handedOff: boolean } {
      const fc = deps.firstClean;
      if (fc === undefined) return { item, handoff, handedOff };
      const f = item.fields.find((x) => x.name === fc.field);
      if (f === undefined || !f.found || typeof f.value !== 'string') return { item, handoff, handedOff };
      const v = parseFirstClean(f.value);
      const keep = capture !== undefined ? v !== null && v === capture.yes : !isBareAnswer(f.value);
      if (keep) return { item, handoff, handedOff };
      deps.log('FIRST_CLEAN_DROPPED');
      const required = fc.required(tenant, item.category);
      const missing = required && !item.missing_fields.includes(fc.field) ? [...item.missing_fields, fc.field] : [...item.missing_fields];
      const reasons = [...new Set([...item.reasons, ...(required ? ['missing_fields' as const] : []), 'ambiguous_field' as const])];
      const held: WorkItemV1 = { ...item, fields: item.fields.map((x) => (x.name === fc.field ? { ...x, value: null, confidence: null, found: false } : x)), missing_fields: missing, reasons, status: 'needs-human' };
      return { item: held, handoff: null, handedOff: false };
    }

    /** Every outgoing message goes through here so a refused write (the peer gone or too slow) is counted, never silently lost. */
    const sendCounted = (m: unknown): boolean => { const ok = conn.send(m); if (!ok) failedSends++; return ok; };
    const say = (text: string, final = false): boolean => sendCounted(final ? { type: 'text', token: text, last: true, interruptible: false } : { type: 'text', token: text, last: true });
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
      sendCounted({ type: 'end' }); conn.close(1000);
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
      const text = intakeText(s); const pii = s.piiSummary(); const turns = s.turns();
      const fallback = lastValid; lastValid = undefined;
      const confirmedContact = readBackContact; readBackContact = undefined;
      const parts = s.revealContactParts();   // RAW: used only to build the stored contact below
      // A call that ends while the address is being confirmed keeps what the caller already confirmed (the job and the number), with the address marked unconfirmed.
      if (confirmed === undefined && (phase === 'address' || phase === 'addressfix') && readBack !== undefined) { confirmed = readBack; addressState = addressState ?? 'unconfirmed'; }
      let contact: StoredContact | undefined;
      if (confirmed !== undefined && confirmedContact !== undefined) {
        const st: AddressState = addressState ?? 'unconfirmed';
        const address = st === 'refused' ? undefined : parts.address;
        contact = { name: confirmedContact.name, phone: confirmedContact.phone, address_state: st === 'confirmed' && address === undefined ? 'unconfirmed' : st, ...(address !== undefined ? { address } : {}) };
      }
      s.dispose();
      if (!save || turns === 0) { deps.log('CALL_ENDED', { turns, saved: 0 }); return; }
      let w: WorkItemV1; let handedOff: boolean;
      const sealed = confirmed?.handoff ?? null;   // the original object of the confirmed read-back; used only for the confirmedHandoff seam below
      if (confirmed !== undefined) { w = confirmed.item; handedOff = confirmed.handedOff; }
      else {
        const r = await runCallIntake(deps.intake, ctx, { tenant, callId, tag: 'final', maskedText: text, pii });
        if (r.ok && (fallback === undefined || freshFrom(r.item, 1) !== undefined)) { const g = guardFirstClean(r.item, r.handoff, r.handedOff); w = g.item; handedOff = g.handedOff; }
        else if (fallback !== undefined) {
          // The final run failed or was not validated (`model_failed`). An earlier validated run is still better than a guess or losing the request; it is saved unconfirmed like any other.
          deps.log('FINAL_INTAKE_FAILED', { code: r.ok ? 0 : r.code }); deps.log('FALLBACK_RECORD', { turns });
          w = fallback.item; handedOff = fallback.handedOff;
        } else { deps.log('FINAL_INTAKE_FAILED', { code: r.code }); return; }
      }
      // Contact: stored only after a yes, before the record. A request is not actionable unless its contact is safely stored.
      let contactOk = deps.contacts === undefined;
      if (confirmed !== undefined && deps.contacts !== undefined) {
        if (contact === undefined) deps.log('CONTACT_MISSING');
        else {
          try { deps.contacts.put(tenant, ref, contact); contactOk = true; deps.log('CONTACT_STORED'); }
          catch { deps.log('CONTACT_STORE_FAILED'); }
        }
      }
      const addressStored = confirmed !== undefined && deps.contacts !== undefined && contactOk && contact !== undefined;
      const ok = confirmed !== undefined && w.status === 'ready' && handedOff && contactOk;
      // A request the business routes to a person (human_review) that the caller confirmed is a CONFIRMED request held for a person: never handed off, not "unconfirmed".
      const reviewed = !ok && confirmed !== undefined && contactOk && w.status === 'needs-human' && w.reasons.length > 0 && w.reasons.every((r) => r === 'human_review');
      const found = w.fields.filter((f) => f.found && f.confidence !== null).map((f) => f.confidence as number);
      const record: IntakeRecord = {
        item_id: w.item_id, workspace_id: tenant, call_ref: ref, received_at: deps.nowIso(), category: w.category,
        status: ok ? w.status : 'needs-human',
        reasons: ok || reviewed ? [...w.reasons] : [...new Set([...w.reasons, NOT_CONFIRMED, ...(confirmed !== undefined && !contactOk ? [CONTACT_MISSING] : [])])], missing_fields: [...w.missing_fields],
        // A field that holds a person's name, number or e-mail never keeps its value in the record, even if the masker missed it (a lower-case name).
        fields: redactSensitive(w.fields),
        pii_summary: w.pii_summary.map((p) => ({ type: p.type, count: p.count })),
        confidence: found.length > 0 ? Math.min(...found) : null, versions: { ...w.versions }, handed_off: ok, turns,
        confirmation: ok || reviewed ? 'confirmed' : 'unconfirmed',
        // An address nobody has checked: one found in a field, or one held in the contact vault for this call (the cleaning skill has no address field).
        // 'caller_confirmed' only when the caller confirmed the address AND the confirmed contact was stored for this call AND the record itself is confirmed; every other held address is
        // 'unverified' (a refused, unanswered, unconfirmed or unstored one included), and 'none' means no address is held. Never a postal check.
        address_status: addressStored && (ok || reviewed) && contact?.address_state === 'confirmed' ? 'caller_confirmed' : w.fields.some((f) => f.found && /address/i.test(f.name)) || addressStored ? 'unverified' : 'none',
      };
      deps.log(ok ? 'CONFIRMED' : reviewed ? 'CONFIRMED_FOR_REVIEW' : 'UNCONFIRMED', { turns });
      let saved = false;
      try { const put = deps.store.put(tenant, record); saved = put === 'new'; deps.log('RECORD_' + put.toUpperCase(), { turns }); }
      catch (e) { deps.log(e instanceof RecordRefused ? 'RECORD_REFUSED' : 'RECORD_FAILED'); }
      if (saved && ok && sealed !== null && deps.confirmedHandoff !== undefined) {
        try { await deps.confirmedHandoff(sealed, { tenant, callRef: ref, addressConfirmed: contact?.address_state === 'confirmed' }); }
        catch { deps.log('HANDOFF_SEAM_FAILED'); }
      }
    }

    /**
     * One Intake run over every caller line so far, awaited for at most `previewBudgetMs`. Returns a preview only when the run finished in time, was
     * validated (not `model_failed`) and covers every line; anything else returns undefined and the turn only listens. A run that finishes late still
     * updates `lastValid` (never backwards), which is used only as a fallback record, never to choose a question.
     */
    async function freshPreview(covers: number): Promise<{ fresh: Fresh; preview: Preview } | undefined> {
      const s = session as CallSession;
      const tag = `p${++previewN % 1000}`;
      const text = intakeText(s); const pii = s.piiSummary();
      const started = deps.now();
      const run = track(runCallIntake(deps.intake, ctx, { tenant, callId, tag, maskedText: text, pii }).then((r) => {
        if (done) return undefined;
        if (!r.ok) { deps.log('PREVIEW_FAILED', { code: r.code }); return undefined; }
        const g = guardFirstClean(r.item, r.handoff, r.handedOff);
        const fresh = freshFrom(g.item, covers);
        if (fresh === undefined) { deps.log('PREVIEW_UNUSABLE'); return undefined; }
        const preview: Preview = { item: g.item, handedOff: g.handedOff, handoff: g.handoff };
        if (covers >= lastValidCovers) { lastValid = preview; lastValidCovers = covers; }
        return { fresh, preview };
      }, () => { deps.log('PREVIEW_FAILED', { code: 0 }); return undefined; }));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), deps.previewBudgetMs); timer.unref?.(); });
      const got = await Promise.race([run, late]);
      if (timer !== undefined) clearTimeout(timer);
      deps.log('TIMING', { preview_ms: Math.max(0, deps.now() - started) });
      if (got === 'late') { deps.log('PREVIEW_BUDGET_EXCEEDED', { budget_ms: deps.previewBudgetMs }); return undefined; }
      return got;
    }

    /** Speaks one reply. True only when the reply was produced in full and every write to the socket was accepted: it still cannot prove the phone provider played it. */
    async function speak(directive: Directive): Promise<boolean> {
      const s = session as CallSession;
      const controller = new AbortController();
      streaming = controller;
      let said = '';
      const began = deps.now();
      let firstTokenAt: number | undefined; let chars = 0; let parts = 0; let failed = 0; let threw = false;
      const send = (m: unknown): void => { if (!sendCounted(m)) failed++; };
      try {
        for await (const piece of deps.dialogue.reply({ turns: s.dialogue(), directive, signal: controller.signal })) {
          if (controller.signal.aborted || done) break;
          if (firstTokenAt === undefined) firstTokenAt = deps.now();
          said += piece; chars += piece.length; parts++;
          send({ type: 'text', token: piece, last: false });
        }
        if (!controller.signal.aborted && !done) send({ type: 'text', token: '', last: true });
      } catch {
        threw = true;
        deps.log('DIALOGUE_FAILED', { chars, parts, failed_sends: failed });
        if (!done) await farewell(SAY.trouble, true);
        return false;
      } finally { streaming = undefined; lastReplyEndAt = deps.now(); replies++; }
      // What happened to this reply, in numbers: how much was produced, how soon, whether any write was refused, and whether it was cut short.
      // (REPLY_SENT proves words were produced and written to the socket; it cannot prove the phone provider spoke them.)
      const total = Math.max(0, deps.now() - began);
      const detail: Record<string, number> = { chars, parts, failed_sends: failed, total_ms: total };
      if (firstTokenAt !== undefined) {
        detail.first_token_ms = Math.max(0, firstTokenAt - began);
        if (lastPromptAt !== undefined) detail.since_prompt_ms = Math.max(0, firstTokenAt - lastPromptAt);
      }
      if (controller.signal.aborted) deps.log('REPLY_INTERRUPTED', detail);
      else if (done) deps.log('REPLY_CUT', detail);
      else if (chars === 0 && !threw) deps.log('REPLY_EMPTY', detail);
      else deps.log('REPLY_SENT', detail);
      if (failed > 0) deps.log('REPLY_SEND_FAILED', { failed_sends: failed });
      if (done) return false;
      s.said(said);
      if (controller.signal.aborted) { s.interrupted(interruptedText); interruptedText = ''; return false; }
      lastReply = said;
      return chars > 0 && failed === 0;
    }
    let interruptedText = '';

    function armConfirmTimer(): void {
      clearConfirmTimer();
      confirmTimer = setTimeout(() => {
        chain = chain.then(async () => {
          if (done || phase === 'collect') return;
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
      readBackContact = deps.contacts === undefined ? undefined : s.revealContact();
      // The caller hears the number; the dialogue history (which goes to the model on later turns) gets the same words WITHOUT it.
      say(readBackText(item.item, readBackContact?.phone));
      s.said(readBackText(item.item));
      deps.log('READBACK', { n: readbacks });
      armConfirmTimer();
    }

    /** Reads the captured service address back to the caller (over the phone only) and asks for a yes or no. The dialogue history keeps a version without the address. */
    function askAddress(): void {
      const s = session as CallSession;
      const address = s.revealContactParts().address;
      if (address === undefined) { phase = 'addressfix'; addressAsked = say(SAY.addressMissing); s.said(SAY.addressMissing); armConfirmTimer(); return; }
      phase = 'address';
      lastAddressText = `I have your service address as ${address}. Is that correct? Please say yes or no.`;
      addressAsked = say(lastAddressText);   // false when the write was refused: that question cannot be answered
      s.said(SAY.addressAsk);
      deps.log('ADDRESS_READBACK', { n: addressTries + 1 });
      armConfirmTimer();
    }
    async function finishAddress(state: AddressState): Promise<void> {
      addressState = state;
      deps.log(state === 'confirmed' ? 'ADDRESS_CONFIRMED' : state === 'refused' ? 'ADDRESS_REFUSED' : 'ADDRESS_UNCONFIRMED');
      const line = state === 'refused' ? SAY.addressRefused : SAY.thanks;
      say(line, true);
      const at = deps.now();
      await finish(true, readBack);
      return await hangUp(line, at);
    }
    async function onAddressAnswer(line: string): Promise<void> {
      const s = session as CallSession;
      if (ADDRESS_REFUSAL.test(line)) return await finishAddress('refused');
      const a = s.answer(line);
      if (!addressAsked) {   // the question was never sent in full, or was talked over: this answer cannot be taken as an answer to it
        deps.log('ADDRESS_ANSWER_IGNORED');
        if (++addressUnclear > 1) return await finishAddress('unconfirmed');
        askAddress();
        return;
      }
      if (a === 'yes') return await finishAddress('confirmed');
      if (a === 'no') {
        if (++addressTries > 2) { s.forgetAddress(); return await finishAddress('unconfirmed'); }   // the caller said this address is wrong: it is not kept
        deps.log('ADDRESS_CORRECTION', { n: addressTries });
        s.forgetAddress(); phase = 'addressfix'; addressAsked = false; addressUnclear = 0;
        say(SAY.addressWrong); s.said(SAY.addressWrong); armConfirmTimer();
        return;
      }
      if (++addressUnclear > 1) return await finishAddress('unconfirmed');
      askAddress();
    }
    async function onAddressFix(line: string): Promise<void> {
      const s = session as CallSession;
      if (ADDRESS_REFUSAL.test(line)) return await finishAddress('refused');
      if (s.revealContactParts().address !== undefined) { addressUnclear = 0; askAddress(); return; }
      if (++addressUnclear > 1) return await finishAddress('unconfirmed');
      say(SAY.addressMissing); s.said(SAY.addressMissing); armConfirmTimer();
    }

    async function onAnswer(line: string): Promise<void> {
      const s = session as CallSession;
      const a = s.answer(line);
      if (a === 'yes' && deps.contacts !== undefined && readBackContact !== undefined) { addressTries = 0; addressUnclear = 0; addressState = undefined; askAddress(); return; }
      if (a === 'yes') {
        const item = readBack;
        say(SAY.thanks, true);
        const at = deps.now();
        await finish(true, item);
        return await hangUp(SAY.thanks, at);
      }
      if (a === 'no') {
        if (readbacks >= MAX_READBACKS) return await farewell(SAY.unconfirmed, true);
        phase = 'collect'; readBack = undefined; readBackContact = undefined;   // the next turn makes a fresh Intake run over everything, correction included
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
        return speak({ kind: 'open' });
      }
      const limit = s.limit();
      if (limit === 'KILLED') { await farewell(SAY.unavailable, false); return; }
      if (limit !== null) { await farewell(SAY.limit, true); return; }   // the cap is reached BEFORE this utterance is taken in
      const heard = s.hear(raw);
      if (!heard.ok) { deps.log('UTTERANCE_REFUSED', { code: heard.code }); await farewell(SAY.trouble, true); return; }
      if (phase === 'confirm') return onAnswer(heard.line);
      if (phase === 'address') return onAddressAnswer(heard.line);
      if (phase === 'addressfix') return onAddressFix(heard.line);
      if (deps.firstClean !== undefined) {
        // A plain yes or no is the answer to the first-cleaning question only if that was the question just asked; explicit wording counts anywhere. The newest one wins.
        const answer = parseFirstClean(heard.line);
        if (answer !== null && (activeAsk === deps.firstClean.field || !isBareAnswer(heard.line))) capture = { yes: answer, text: heard.line.trim().slice(0, 80) };
      }
      activeAsk = undefined;
      const covers = s.turns();
      const got = await freshPreview(covers);
      if (done) return;
      // With the contact vault on, the three contact items are required too: they are added to what is missing, by code, from this turn's lines.
      let fresh = got?.fresh;
      if (fresh !== undefined && deps.contacts !== undefined) {
        const need = s.contactMissing();
        fresh = { ...fresh, missing: [...fresh.missing, ...need], ready: fresh.ready && need.length === 0 };
      }
      const next = selectNext(fresh, covers, { lastAskedAt, clarified });
      if (next.kind === 'ready' && got !== undefined) return startReadback(got.preview);
      if (next.kind === 'ask') {
        lastAskedAt.set(next.field, covers);
        deps.log('ASK', { again: next.again ? 1 : 0, lines: covers });
        const choices = deps.choicesFor?.(tenant, next.field);
        const delivered = await speak({ kind: 'ask', field: next.field, again: next.again, ...(choices !== undefined && choices.length > 0 ? { choices } : {}) });
        // Only a question that was actually produced and sent in full can make the caller's next plain yes or no an answer to it.
        activeAsk = delivered ? next.field : undefined;
        return;
      }
      if (next.kind === 'clarify') {
        clarified = true;
        deps.log('CLARIFY', { first: next.first ? 1 : 0, lines: covers });
        return speak(next.first ? { kind: 'clarify', categories: deps.categoryNames(tenant).filter((c) => c !== 'unknown') } : { kind: 'clarify' });
      }
      deps.log('LISTEN', { lines: covers });
      return speak({ kind: 'listen' });
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
        interrupts++;
        const spoken = typeof msg.utteranceUntilInterrupt === 'string' ? msg.utteranceUntilInterrupt.slice(0, 600) : '';
        if (streaming !== undefined) { interruptedText = spoken; streaming.abort(); }
        else {
          // The reply had been sent, but the caller talked over it. Unless the phone provider reports that all of it was spoken, the question cannot be assumed heard.
          const flat = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          if (activeAsk !== undefined && !(flat(lastReply).length > 0 && flat(spoken).length >= flat(lastReply).length)) activeAsk = undefined;
          if (addressAsked && phase === 'address' && !(flat(lastAddressText).length > 0 && flat(spoken).length >= flat(lastAddressText).length)) addressAsked = false;
          session?.interrupted(spoken);
        }
        return;
      }
      if (msg.type === 'setup') { if (!setupSeen && !done) { setupSeen = true; chain = chain.then(() => onSetup(msg)).catch(() => deps.log('HANDLER_ERROR')); } return; }
      if (!setupSeen) { if (++bad > 5) conn.close(1008); return; }
      if (msg.type === 'prompt') {
        if (msg.last !== true || typeof msg.voicePrompt !== 'string') { partialPrompts++; return; }   // a partial result is not acted on, but it is counted
        lastPromptAt = deps.now();
        const heard = msg.voicePrompt;
        clearConfirmTimer();   // an answer is on its way: the silence timer must not win the race against it
        chain = chain.then(() => onPrompt(heard)).catch(() => deps.log('HANDLER_ERROR'));
        void track(chain);
        return;
      }
      // dtmf, error and anything else: not used. Twilio's own error text is never logged.
      otherFrames++;
      if (msg.type === 'error') deps.log('TWILIO_ERROR');
    };
    conn.onClose = (info?: CloseInfo): void => {
      // One line per connection, whoever ended it: who closed (a fixed word), the WebSocket close code, how long since the last caller utterance and the last reply, and counts.
      const now = deps.now();
      deps.log('CALL_CLOSED', {
        by: info?.cause ?? 'PEER', code: info?.code ?? 0, since_prompt_ms: Math.max(0, now - (lastPromptAt ?? startedAt)), since_reply_ms: Math.max(0, now - (lastReplyEndAt ?? startedAt)),
        mid_reply: streaming === undefined ? 0 : 1, replies, failed_sends: failedSends, partial_prompts: partialPrompts, interrupts, other_frames: otherFrames,
      });
      void track(chain.then(async () => { if (!done) await finish(!deps.killed()); release(); }).catch(() => deps.log('HANDLER_ERROR')));
    };
  }

  return Object.freeze({
    handle,
    active: () => active,
    async idle(): Promise<void> { while (work.size > 0) await Promise.allSettled([...work]); },
  });
}
