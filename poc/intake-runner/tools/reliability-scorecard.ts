// RELIABILITY SCORECARD. Reads the sanitized call log Drew already writes (founder-voice.log: `<iso time> <CODE> {json}`; codes, flags, counts and short tokens only) and, optionally, a
// private founder attestation file, and scores each call PASS / FAIL / BLOCKED. Read-only: it changes nothing, calls nothing, and sends nothing anywhere. Nothing in src/ imports it.
//
//   node tools/reliability-scorecard.ts <log> [--attest <file>] [--last <n>] [--expect-commit <hash>]
//   exit code: 0 ONLY when at least one call is shown and EVERY call shown is PASS (every check PASS); 1 when any call shown is FAIL or BLOCKED, or when there is no call to show (no evidence is not success);
//              2 = bad usage or an unreadable/invalid file. A release script may therefore treat exit 0 as the only success.
//
// THE RULE THAT PREVENTS A FALSE PASS: a check is PASS only on POSITIVE evidence in the log. FAIL means the log shows a violation. Anything the log cannot show is BLOCKED, never PASS.
// A call is PASS only when every check is PASS. Today most calls are BLOCKED: the log carries no commit, no address-validation row and no record of what was actually said (see the
// blind spots in the report that came with this file), and the founder's own attestation is the only way to supply the truth.
//
// ATTESTATIONS (private; keep the file OUTSIDE the repository, never commit it): a JSON object keyed by the call's start time (the time of its CALL_STREAM_ACCEPTED line):
//   { "2026-11-07T20:27:41Z": { "founderVerdict": "clean" | "failed", "addressMatchesJob": true, "timeAndPriceMatch": true, "emailsReceived": true } }
// Only those four fields, only booleans (and the two verdict words). Free text is refused so that no personal detail can enter the file. An unknown field or a wrong type is refused
// with a count-and-position message, and the whole run stops (exit 2) rather than silently ignoring an attestation.
//
// PRIVACY: the output holds call start times, check ids, PASS/FAIL/BLOCKED and fixed reason tokens. It never prints a log line, a field value or anything from the attestation.

export interface Ev { t: string; code: string; d: Record<string, string | number | boolean> }
export type Entry = Ev | null;   // null = a line that could not be read
export type Status = 'PASS' | 'FAIL' | 'BLOCKED';
export interface Check { id: string; status: Status; why: string }
export interface Call { start: string; events: Ev[]; unparsed: number; server?: Ev }
export interface Attestation { founderVerdict?: 'clean' | 'failed'; addressMatchesJob?: boolean; timeAndPriceMatch?: boolean; emailsReceived?: boolean | null }
export interface CallScore { start: string; checks: Check[]; overall: Status }

const LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) ([A-Z][A-Z0-9_]{2,47})(?: (\{.*\}))?$/;
export function parseLog(text: string): Entry[] {
  const out: Entry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw === '') continue;
    const m = LINE.exec(raw); if (m === null) { out.push(null); continue; }
    let d: unknown = {}; if (m[3] !== undefined) { try { d = JSON.parse(m[3]); } catch { out.push(null); continue; } }
    if (typeof d !== 'object' || d === null || Array.isArray(d) || !Object.values(d).every((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) { out.push(null); continue; }
    out.push({ t: m[1], code: m[2], d: d as Ev['d'] });
  }
  return out;
}
/** One call runs from its CALL_STREAM_ACCEPTED line to the next one or to the next SERVER_START (a restart ends it). Unreadable lines inside a call are counted against that call. */
export function splitCalls(entries: readonly Entry[]): Call[] {
  const calls: Call[] = []; let server: Ev | undefined; let cur: Call | undefined;
  for (const e of entries) {
    if (e === null) { if (cur !== undefined) cur.unparsed++; continue; }
    if (e.code === 'SERVER_START') { server = e; cur = undefined; continue; }
    if (e.code === 'CALL_STREAM_ACCEPTED') { cur = { start: e.t, events: [e], unparsed: 0, ...(server === undefined ? {} : { server }) }; calls.push(cur); continue; }
    if (cur !== undefined) cur.events.push(e);
  }
  return calls;
}

const tok = (s: unknown): string => (typeof s === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(s) ? s : 'other');
/** Validates an attestation file. Returns the entries and a list of problems (positions and kinds only, never content). */
export function parseAttestations(text: string): { byCall: Record<string, Attestation>; problems: string[] } {
  const byCall: Record<string, Attestation> = {}; const problems: string[] = [];
  let j: unknown; try { j = JSON.parse(text); } catch { return { byCall, problems: ['not_json'] }; }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return { byCall, problems: ['not_an_object'] };
  let n = 0;
  for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
    n++;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(k)) { problems.push(`entry_${n}_key_not_a_call_start_time`); continue; }
    if (typeof v !== 'object' || v === null || Array.isArray(v)) { problems.push(`entry_${n}_not_an_object`); continue; }
    const a: Attestation = {}; let ok = true;
    for (const [f, x] of Object.entries(v as Record<string, unknown>)) {
      if (f === 'founderVerdict' && (x === 'clean' || x === 'failed')) a.founderVerdict = x;
      else if ((f === 'addressMatchesJob' || f === 'timeAndPriceMatch') && typeof x === 'boolean') a[f] = x;
      else if (f === 'emailsReceived' && (typeof x === 'boolean' || x === null)) a.emailsReceived = x;
      else { problems.push(`entry_${n}_field_refused`); ok = false; }
    }
    if (ok) byCall[k] = a;
  }
  return { byCall, problems };
}

export interface ScoreOptions { expectCommit?: string }
const WRITE_PATTERN = 'clientCreate,jobCreate';
export function scoreCall(call: Call, att?: Attestation, opts: ScoreOptions = {}): CallScore {
  const E = call.events; const idx = (code: string, pred: (e: Ev) => boolean = () => true): number[] => E.flatMap((e, i) => (e.code === code && pred(e) ? [i] : []));
  const has = (code: string): boolean => E.some((e) => e.code === code);
  const checks: Check[] = []; const add = (id: string, status: Status, why: string): void => { checks.push({ id, status, why }); };
  const fast = E.some((e) => e.code.startsWith('FAST_'));
  const endIdx = idx('FAST_END'); const bookings = idx('FAST_BOOKING'); const bookIdx = bookings[0] ?? -1;
  const verified = bookings.length === 1 && E[bookIdx].d.status === 'booked_verified';
  const writes = idx('JOBBER_WRITE_SENT');

  // LOG: the log must be readable, complete and from the fast path before anything else can be believed.
  if (!fast) add('LOG', 'BLOCKED', 'NOT_FAST_PATH'); else if (call.unparsed > 0) add('LOG', 'BLOCKED', 'UNREADABLE_LINES'); else if (endIdx.length === 0) add('LOG', 'BLOCKED', 'CALL_NOT_ENDED_IN_LOG'); else add('LOG', 'PASS', 'READABLE_AND_ENDED');

  // CODE: which commit ran. SERVER_START has not carried one so far, so this is BLOCKED until it does.
  const commit = call.server?.d.commit;
  if (typeof commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(commit)) add('CODE', 'BLOCKED', 'NO_COMMIT_LOGGED');
  else if (opts.expectCommit !== undefined && !(commit.startsWith(opts.expectCommit) || opts.expectCommit.startsWith(commit))) add('CODE', 'FAIL', 'DIFFERENT_COMMIT');
  else add('CODE', 'PASS', opts.expectCommit === undefined ? 'COMMIT_LOGGED' : 'COMMIT_AS_EXPECTED');

  // CALLER: a refusal is a failure of an expected test call; success is not logged, so PASS rests on the call having got past the opening to the name step.
  if (has('FAST_CALLER_REFUSED')) add('CALLER', 'FAIL', 'CALLER_REFUSED'); else if (has('FAST_NAME')) add('CALLER', 'PASS', 'NOT_REFUSED_AND_PROGRESSED'); else add('CALLER', 'BLOCKED', 'NEVER_REACHED_NAME');

  // INTAKE: every part of the request must have been captured.
  const missing = ['FAST_NAME', 'FAST_STATE', 'FAST_WHEN', 'FAST_SIZE', 'FAST_OFFER'].filter((c) => !has(c)); if (idx('FAST_ADDRESS', (e) => e.d.outcome === 'captured').length === 0) missing.push('FAST_ADDRESS');
  if (missing.length === 0) add('INTAKE', 'PASS', 'ALL_PARTS_CAPTURED'); else add('INTAKE', bookings.length > 0 ? 'FAIL' : 'BLOCKED', bookings.length > 0 ? 'BOOKED_WITH_MISSING_PARTS' : 'INCOMPLETE_CALL');

  // ADDRESS: positive proof needs an independent validation row that said valid. None exists today, so this is BLOCKED, never PASS.
  const guardRefusals = idx('FAST_ADDRESS_GUARD', (e) => e.d.ok === false); const val = idx('FAST_ADDRESS_VALIDATE'); const lastVal = val.length === 0 ? undefined : E[val[val.length - 1]];
  if (bookings.length > 0 && guardRefusals.length > 0) add('ADDRESS', 'FAIL', 'BOOKED_AFTER_GUARD_REFUSAL');
  else if (lastVal !== undefined && lastVal.d.status !== 'valid') add('ADDRESS', bookings.length > 0 ? 'FAIL' : 'BLOCKED', bookings.length > 0 ? 'BOOKED_WITHOUT_VALID_ADDRESS' : 'ADDRESS_NOT_VALIDATED');
  else if (lastVal === undefined) add('ADDRESS', 'BLOCKED', 'NO_VALIDATION_EVIDENCE');
  else if (bookings.length > 0 && val[val.length - 1] > bookIdx) add('ADDRESS', 'FAIL', 'VALIDATED_AFTER_BOOKING');
  else add('ADDRESS', 'PASS', 'VALIDATED');

  // CONFIRM: the read-back is spoken, then the booking guard confirms the facts, then the booking. In that order.
  const readback = idx('FAST_SAY', (e) => e.d.id === 'READBACK')[0] ?? -1; const guardOk = idx('FAST_BOOKING_GUARD', (e) => e.d.ok === true)[0] ?? -1;
  if (bookings.length > 0) { if (readback >= 0 && guardOk > readback && bookIdx > guardOk) add('CONFIRM', 'PASS', 'READBACK_GUARD_BOOKING_IN_ORDER'); else add('CONFIRM', 'FAIL', 'BOOKED_WITHOUT_CONFIRMED_READBACK'); }
  else if (has('FAST_BOOKING_GUARD') && guardOk < 0) add('CONFIRM', 'BLOCKED', 'GUARD_REFUSED_NOT_BOOKED'); else add('CONFIRM', 'BLOCKED', 'NOT_REACHED');

  // JOBBER: exactly one booking, verified by the independent read-back, with the two expected writes.
  const writeList = writes.map((i) => String(E[i].d.fields)).join(',');
  if (bookings.length === 0) add('JOBBER', writes.length > 0 ? 'FAIL' : 'BLOCKED', writes.length > 0 ? 'WRITE_WITHOUT_BOOKING' : 'NO_BOOKING');
  else if (bookings.length > 1) add('JOBBER', 'FAIL', 'MULTIPLE_BOOKINGS');
  else if (!verified) add('JOBBER', 'FAIL', 'STATUS_' + tok(E[bookIdx].d.status) + (E[bookIdx].d.reason === undefined ? '' : '_' + tok(E[bookIdx].d.reason)));
  else if (writes.length > 2) add('JOBBER', 'FAIL', 'MORE_THAN_TWO_WRITES');
  else if (typeof E[bookIdx].d.readBackDiffs === 'number' && E[bookIdx].d.readBackDiffs > 0) add('JOBBER', 'FAIL', 'READBACK_DIFFERENCES');
  else if (writeList !== WRITE_PATTERN) add('JOBBER', 'BLOCKED', 'UNEXPECTED_WRITE_PATTERN');
  else add('JOBBER', 'PASS', 'VERIFIED_TWO_WRITES');

  // EMAIL: only after a verified booking, both accepted. "Accepted" means the mail server took it, not that it reached an inbox (see TRUTH).
  const sent = idx('FAST_EMAILS_SENT'); const sentEv = sent.length === 0 ? undefined : E[sent[0]];
  if (sentEv !== undefined && !verified) add('EMAIL', 'FAIL', 'EMAILS_WITHOUT_VERIFIED_BOOKING');
  else if (sentEv !== undefined && sent[0] < bookIdx) add('EMAIL', 'FAIL', 'EMAILS_BEFORE_BOOKING');
  else if (sentEv !== undefined) add('EMAIL', sentEv.d.customer === 'accepted' && sentEv.d.owner === 'accepted' ? 'PASS' : 'FAIL', sentEv.d.customer === 'accepted' && sentEv.d.owner === 'accepted' ? 'BOTH_ACCEPTED' : 'EMAIL_NOT_ACCEPTED');
  else if (has('FAST_EMAILS_SKIPPED')) add('EMAIL', 'BLOCKED', 'EMAILS_OFF'); else add('EMAIL', 'BLOCKED', verified ? 'NO_EMAIL_EVIDENCE' : 'NO_BOOKING');

  // SMS: stays OFF.
  if (has('FAST_TEXTS_SENT')) add('SMS', 'FAIL', 'TEXT_SENT'); else if (has('FAST_TEXTS_SKIPPED')) add('SMS', 'PASS', 'TEXTS_SKIPPED'); else add('SMS', 'BLOCKED', 'NO_TEXT_EVIDENCE');

  // VOICE: no voice-service error other than the harmless "nothing to cancel" one. Absence only counts when the voice link opened at all.
  const bad = E.filter((e) => (e.code === 'BRIDGE_VOICE_ERROR' && e.d.errorCode !== 'response_cancel_not_active') || e.code === 'ADAPTER_VOICE_ERROR_EVENT').length;
  if (bad > 0) add('VOICE', 'FAIL', 'VOICE_ERROR'); else if (has('BRIDGE_VOICE_OPEN')) add('VOICE', 'PASS', 'NO_VOICE_ERROR'); else add('VOICE', 'BLOCKED', 'VOICE_LINK_NOT_SEEN');

  // CONSISTENCY: the end of the call, its outcome row and the booking must tell the same story.
  const end = endIdx.length === 0 ? undefined : E[endIdx[0]]; const out = E.find((e) => e.code === 'FAST_OUTCOME');
  if (end === undefined) add('CONSISTENCY', 'BLOCKED', 'NO_END');
  else if (out === undefined) add('CONSISTENCY', 'BLOCKED', 'NO_OUTCOME_ROW');
  else if (end.d.booked !== verified || out.d.booked !== verified || (end.d.reason === 'BOOKED') !== verified || out.d.reason !== end.d.reason) add('CONSISTENCY', 'FAIL', 'END_AND_BOOKING_DISAGREE');
  else add('CONSISTENCY', 'PASS', 'END_OUTCOME_BOOKING_AGREE');

  // TRUTH: what was said versus what was booked and received cannot be in the log. Only the founder's attestation supplies it.
  const offer = E.find((e) => e.code === 'FAST_OFFER'); const substituted = offer !== undefined && (offer.d.sameDay === false || offer.d.sameTime === false);
  if (att === undefined) add('TRUTH', 'BLOCKED', substituted ? 'NO_ATTESTATION_OFFER_SUBSTITUTED' : 'NO_ATTESTATION');
  else if (att.founderVerdict === 'failed' || att.addressMatchesJob === false || att.timeAndPriceMatch === false || (sentEv !== undefined && att.emailsReceived === false)) add('TRUTH', 'FAIL', att.founderVerdict === 'failed' ? 'FOUNDER_SAYS_FAILED' : 'ATTESTED_MISMATCH');
  else if (att.founderVerdict !== 'clean' || att.addressMatchesJob !== true || att.timeAndPriceMatch !== true || (sentEv !== undefined && att.emailsReceived !== true)) add('TRUTH', 'BLOCKED', 'ATTESTATION_INCOMPLETE');
  else add('TRUTH', 'PASS', 'FOUNDER_ATTESTED_CLEAN');

  const overall: Status = checks.some((c) => c.status === 'FAIL') ? 'FAIL' : checks.some((c) => c.status === 'BLOCKED') ? 'BLOCKED' : 'PASS';
  return { start: call.start, checks, overall };
}
/** Scores every call that has a start time, newest last. */
export function scoreAll(calls: readonly Call[], byCall: Readonly<Record<string, Attestation>> = {}, opts: ScoreOptions = {}): CallScore[] { return calls.map((c) => scoreCall(c, byCall[c.start], opts)); }
/** The clean-completion streak: how many of the most recent calls in a row are PASS (the gate asks for three, then the founder's written acceptance). */
export function streak(scores: readonly CallScore[]): number { let n = 0; for (let i = scores.length - 1; i >= 0 && scores[i].overall === 'PASS'; i--) n++; return n; }

export function render(scores: readonly CallScore[]): string {
  const L: string[] = [];
  for (const s of scores) {
    L.push(`${s.start}  ${s.overall.padEnd(7)} ${s.checks.map((c) => `${c.id}:${c.status[0]}`).join(' ')}`);
    for (const c of s.checks) if (c.status !== 'PASS') L.push(`    ${c.id.padEnd(11)} ${c.status.padEnd(7)} ${c.why}`);
  }
  const t = { PASS: 0, FAIL: 0, BLOCKED: 0 }; for (const s of scores) t[s.overall]++;
  L.push(`calls=${scores.length} PASS=${t.PASS} FAIL=${t.FAIL} BLOCKED=${t.BLOCKED} cleanStreak=${streak(scores)} (the gate needs 3, then the founder's written acceptance)`);
  return L.join('\n');
}

export interface Io { readFile(path: string): string; write(text: string): void }
/** The command line, with its file access passed in so tests need no files. Returns the exit code. */
export function run(args: readonly string[], io: Io): number {
  let log: string | undefined; let attest: string | undefined; let last: number | undefined; let expectCommit: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--attest') attest = args[++i]; else if (a === '--last') last = Number(args[++i]); else if (a === '--expect-commit') expectCommit = args[++i];
    else if (!a.startsWith('--') && log === undefined) log = a; else { io.write('usage: reliability-scorecard.ts <log> [--attest <file>] [--last <n>] [--expect-commit <hash>]'); return 2; }
  }
  if (log === undefined || (last !== undefined && (!Number.isInteger(last) || last < 1)) || (expectCommit !== undefined && !/^[0-9a-f]{7,40}$/.test(expectCommit))) { io.write('usage: reliability-scorecard.ts <log> [--attest <file>] [--last <n>] [--expect-commit <hash>]'); return 2; }
  let text: string; try { text = io.readFile(log); } catch { io.write('cannot read the log file'); return 2; }
  let byCall: Record<string, Attestation> = {};
  if (attest !== undefined) {
    let at: string; try { at = io.readFile(attest); } catch { io.write('cannot read the attestation file'); return 2; }
    const p = parseAttestations(at); if (p.problems.length > 0) { io.write(`the attestation file was refused (${p.problems.length} problem${p.problems.length === 1 ? '' : 's'}: ${p.problems.slice(0, 5).join(', ')}); nothing was scored`); return 2; }
    byCall = p.byCall;
  }
  const all = scoreAll(splitCalls(parseLog(text)), byCall, expectCommit === undefined ? {} : { expectCommit }); const shown = last === undefined ? all : all.slice(-last);
  io.write(render(shown)); return shown.length > 0 && shown.every((s) => s.overall === 'PASS') ? 0 : 1;   // success only on positive evidence: BLOCKED, FAIL and an empty log are all not-success
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  const { readFileSync } = await import('node:fs');
  process.exitCode = run(process.argv.slice(2), { readFile: (p) => readFileSync(p, 'utf8'), write: (t) => console.log(t) });
}
