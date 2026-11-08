// Offline tests for tools/reliability-scorecard.ts. Every log below is SYNTHETIC: event codes and tokens only, modelled on the sanitized lines of Live Test #12 (2026-11-07). No log file, no key, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAttestations, parseLog, render, run, scoreAll, scoreCall, splitCalls, streak } from '../tools/reliability-scorecard.ts';
import type { Attestation, Call, CallScore } from '../tools/reliability-scorecard.ts';

type D = Record<string, string | number | boolean>;
type Row = [string, D?];
const iso = (base: string, s: number): string => new Date(Date.parse(base) + s * 1000).toISOString().replace('.000Z', 'Z');
/** Renders rows as log lines, one second apart, the way the sink writes them. */
function lines(base: string, rows: readonly Row[]): string[] { return rows.map(([code, d], i) => `${iso(base, i)} ${code}${d === undefined ? '' : ' ' + JSON.stringify(d)}`); }

const ADDR_PARTIAL: Row[] = [['FAST_ADDRESS', { outcome: 'unclear', reason: 'NOT_AN_ADDRESS', street: false, city: false, zip: false, state: false, digitRuns: 1, zipDigits: 5, words: 1, chars: 6 }], ['FAST_ADDRESS', { outcome: 'partial', reason: 'NEED_CITY', street: true, city: false, zip: true, state: false, digitRuns: 1, zipDigits: 5, words: 1, chars: 6 }], ['FAST_ADDRESS', { outcome: 'captured', reason: 'JOINED', street: true, city: true, zip: true, state: false, digitRuns: 0, zipDigits: 0, words: 1, chars: 8 }]];
/** Live Test #12 as the sanitized log recorded it (tokens as logged; no commit, no address validation, no steps). */
const TEST12: Row[] = [
  ['CALL_STREAM_ACCEPTED', { noticeChars: 61, setupWaitMs: 34270, call: 1, ms: 1 }], ['VOICE_OPEN', { connectMs: 1200, call: 1, ms: 1202 }], ['BRIDGE_VOICE_OPEN', { phoneStarted: true, call: 1, ms: 1203 }],
  ['FAST_NAME', { path: 'CONFIRM', answer: 'yes', no: 0, spelled: true, letters: 10 }], ['FAST_SAY', { id: 'ADDRESS', unit: false }], ...ADDR_PARTIAL, ['FAST_STATE', { state: true, words: 1, chars: 6, tries: 0 }],
  ['FAST_WHEN', { path: 'ANSWER', hasDay: true, hasTime: true }], ['FAST_SIZE', { parsedBeds: true, parsedBaths: true }],
  ['FAST_OFFER', { kind: 'other_day', said: 'DAY_SUBSTITUTED', askedDay: true, askedTime: true, sameDay: false, sameTime: false, dayOffset: 2, startMin: 780, askedMin: 600, refused: 0 }],
  ['FAST_SAY', { id: 'OFFER', unit: true }], ['FAST_SAY', { id: 'CALLBACK', unit: true }], ['FAST_SAY', { id: 'READBACK', unit: true }],
  ['FAST_BOOKING_GUARD', { ok: true, count: 0, startMin: 780, sameAsOffer: true }], ['JOBBER_WRITE_SENT', { fields: 'clientCreate' }], ['JOBBER_WRITE_SENT', { fields: 'jobCreate' }], ['JOBBER_BOOKING_CREATED', { writes: 2 }],
  ['FAST_BOOKING', { status: 'booked_verified' }], ['FAST_EMAIL_ACCEPTED', { role: 'owner' }], ['FAST_EMAIL_ACCEPTED', { role: 'customer' }], ['FAST_EMAILS_SENT', { customer: 'accepted', owner: 'accepted' }], ['FAST_TEXTS_SKIPPED'],
  ['FAST_END', { reason: 'BOOKED', booked: true }], ['FAST_OUTCOME', { reason: 'BOOKED', booked: true, customerText: 'skipped', ownerText: 'skipped', steps: 17 }],
  ['BRIDGE_VOICE_ERROR', { type: 'invalid_request_error', errorCode: 'response_cancel_not_active', param: 'other', call: 1, ms: 160578 }],
];
const START = '2026-11-07T20:27:41Z';
const log = (rows: readonly Row[], start = START, commit?: string): string => [`${iso(start, -3)} SERVER_START ${JSON.stringify({ pid: 1, relayPort: 8788, maxCalls: 3, maxMinutes: 8, ...(commit === undefined ? {} : { commit }) })}`, ...lines(start, rows)].join('\n');
const callOf = (rows: readonly Row[], start = START, commit?: string): Call => { const c = splitCalls(parseLog(log(rows, start, commit))); assert.equal(c.length, 1); return c[0]; };
const status = (s: CallScore, id: string): string => s.checks.find((c) => c.id === id)!.status;
const why = (s: CallScore, id: string): string => s.checks.find((c) => c.id === id)!.why;
const statuses = (s: CallScore): string => s.checks.map((c) => `${c.id}:${c.status[0]}`).join(' ');

/** A call that would be a clean completion: Test #12's events plus a commit on SERVER_START and a valid address check. */
function cleanRows(): Row[] {
  const r = TEST12.map((x) => x); const i = r.findIndex(([c, d]) => c === 'FAST_SAY' && d?.id === 'READBACK');
  r.splice(i, 0, ['FAST_ADDRESS_VALIDATE', { status: 'valid', attempt: 1 }]);
  return r;
}
const CLEAN_ATT: Attestation = { founderVerdict: 'clean', addressMatchesJob: true, timeAndPriceMatch: true, emailsReceived: true };
const COMMIT = 'fcf2323';

test('Live Test #12 as the sanitized log recorded it: the log alone is BLOCKED, never PASS, on the checks it cannot prove (commit, address validation, ground truth)', () => {
  const s = scoreCall(callOf(TEST12));
  assert.equal(s.overall, 'BLOCKED');
  assert.equal(statuses(s), 'LOG:P CODE:B CALLER:P INTAKE:P ADDRESS:B CONFIRM:P JOBBER:P EMAIL:P SMS:P VOICE:P CONSISTENCY:P TRUTH:B');
  assert.deepEqual([why(s, 'CODE'), why(s, 'ADDRESS'), why(s, 'TRUTH')], ['NO_COMMIT_LOGGED', 'NO_VALIDATION_EVIDENCE', 'NO_ATTESTATION_OFFER_SUBSTITUTED']);
});

test('Live Test #12 with the founder\'s own attestation: "failed" makes it FAIL whatever the log says; an attested mismatch is FAIL; nothing the founder leaves out is assumed', () => {
  const c = callOf(TEST12);
  assert.equal(scoreCall(c, { founderVerdict: 'failed' }).overall, 'FAIL'); assert.equal(why(scoreCall(c, { founderVerdict: 'failed' }), 'TRUTH'), 'FOUNDER_SAYS_FAILED');
  assert.equal(why(scoreCall(c, { founderVerdict: 'clean', addressMatchesJob: false, timeAndPriceMatch: true, emailsReceived: true }), 'TRUTH'), 'ATTESTED_MISMATCH');
  assert.equal(why(scoreCall(c, { founderVerdict: 'clean', addressMatchesJob: true, timeAndPriceMatch: false, emailsReceived: true }), 'TRUTH'), 'ATTESTED_MISMATCH');
  assert.equal(why(scoreCall(c, { founderVerdict: 'clean', addressMatchesJob: true, timeAndPriceMatch: true, emailsReceived: false }), 'TRUTH'), 'ATTESTED_MISMATCH', 'emails were sent, so "not received" is a failure');
  for (const part of [{ addressMatchesJob: true, timeAndPriceMatch: true, emailsReceived: true }, { founderVerdict: 'clean' as const, timeAndPriceMatch: true, emailsReceived: true }, { founderVerdict: 'clean' as const, addressMatchesJob: true, emailsReceived: true }, { founderVerdict: 'clean' as const, addressMatchesJob: true, timeAndPriceMatch: true }] as Attestation[]) assert.equal(why(scoreCall(c, part), 'TRUTH'), 'ATTESTATION_INCOMPLETE');
  // even a fully clean attestation cannot lift it to PASS: the log still lacks a commit and an address validation
  const s = scoreCall(c, CLEAN_ATT); assert.equal(status(s, 'TRUTH'), 'PASS'); assert.equal(s.overall, 'BLOCKED');
});

test('a fully evidenced clean call is PASS only with every proof present: commit, address validation, a verified booking, both emails, no voice error, and the founder\'s clean attestation', () => {
  const s = scoreCall(callOf(cleanRows(), START, COMMIT), CLEAN_ATT);
  assert.equal(s.overall, 'PASS', statuses(s));
  assert.equal(status(scoreCall(callOf(cleanRows(), START, COMMIT), CLEAN_ATT, { expectCommit: COMMIT }), 'CODE'), 'PASS');
  assert.equal(why(scoreCall(callOf(cleanRows(), START, COMMIT), CLEAN_ATT, { expectCommit: 'abcdef1' }), 'CODE'), 'DIFFERENT_COMMIT'); assert.equal(scoreCall(callOf(cleanRows(), START, COMMIT), CLEAN_ATT, { expectCommit: 'abcdef1' }).overall, 'FAIL');
});

test('missing evidence never becomes PASS: removing any one required event from a clean call leaves it BLOCKED or FAIL', () => {
  const required = ['FAST_NAME', 'FAST_STATE', 'FAST_WHEN', 'FAST_SIZE', 'FAST_OFFER', 'FAST_ADDRESS', 'FAST_ADDRESS_VALIDATE', 'FAST_BOOKING_GUARD', 'JOBBER_WRITE_SENT', 'FAST_BOOKING', 'FAST_EMAILS_SENT', 'FAST_TEXTS_SKIPPED', 'FAST_END', 'FAST_OUTCOME', 'BRIDGE_VOICE_OPEN'];
  for (const code of required) { const rows = cleanRows().filter(([c]) => c !== code); const o = scoreCall(callOf(rows, START, COMMIT), CLEAN_ATT).overall; assert.notEqual(o, 'PASS', 'without ' + code); }
  const noReadback = cleanRows().filter(([c, d]) => !(c === 'FAST_SAY' && d?.id === 'READBACK')); assert.notEqual(scoreCall(callOf(noReadback, START, COMMIT), CLEAN_ATT).overall, 'PASS', 'without the read-back');
  assert.notEqual(scoreCall(callOf(cleanRows(), START), CLEAN_ATT).overall, 'PASS', 'without a commit on SERVER_START');
  assert.notEqual(scoreCall(callOf(cleanRows(), START, COMMIT)).overall, 'PASS', 'without an attestation');
  const only1 = cleanRows().filter(([c, d]) => !(c === 'JOBBER_WRITE_SENT' && d?.fields === 'jobCreate')); assert.equal(why(scoreCall(callOf(only1, START, COMMIT), CLEAN_ATT), 'JOBBER'), 'UNEXPECTED_WRITE_PATTERN');
});

test('each violation the log can show is a FAIL, with a fixed reason token', () => {
  const swap = (f: (r: Row[]) => Row[]): CallScore => scoreCall(callOf(f(cleanRows()), START, COMMIT), CLEAN_ATT);
  const set = (rows: Row[], code: string, d: D): Row[] => rows.map((r) => (r[0] === code ? [code, d] as Row : r));
  let s = swap((r) => set(r, 'FAST_BOOKING', { status: 'uncertain', reason: 'READBACK_MISMATCH' })); assert.deepEqual([s.overall, why(s, 'JOBBER')], ['FAIL', 'STATUS_uncertain_READBACK_MISMATCH']);
  s = swap((r) => set(r, 'FAST_BOOKING', { status: 'booked_verified', readBackDiffs: 1 })); assert.equal(why(s, 'JOBBER'), 'READBACK_DIFFERENCES');
  s = swap((r) => [...r.slice(0, r.findIndex(([c]) => c === 'FAST_BOOKING')), ['JOBBER_WRITE_SENT', { fields: 'jobCreate' }], ...r.slice(r.findIndex(([c]) => c === 'FAST_BOOKING'))]); assert.equal(why(s, 'JOBBER'), 'MORE_THAN_TWO_WRITES');
  s = swap((r) => [...r, ['FAST_BOOKING', { status: 'booked_verified' }]]); assert.equal(why(s, 'JOBBER'), 'MULTIPLE_BOOKINGS');
  s = swap((r) => r.filter(([c, d]) => !(c === 'FAST_BOOKING_GUARD') && !(c === 'FAST_SAY' && d?.id === 'READBACK'))); assert.equal(why(s, 'CONFIRM'), 'BOOKED_WITHOUT_CONFIRMED_READBACK');
  s = swap((r) => { const g = r.find(([c]) => c === 'FAST_BOOKING_GUARD')!; return [...r.filter((x) => x !== g), g]; }); assert.equal(why(s, 'CONFIRM'), 'BOOKED_WITHOUT_CONFIRMED_READBACK', 'guard after the booking');
  s = swap((r) => set(r, 'FAST_EMAILS_SENT', { customer: 'accepted', owner: 'refused' })); assert.equal(why(s, 'EMAIL'), 'EMAIL_NOT_ACCEPTED');
  s = swap((r) => set(r, 'FAST_BOOKING', { status: 'uncertain' })); assert.equal(why(s, 'EMAIL'), 'EMAILS_WITHOUT_VERIFIED_BOOKING');
  s = swap((r) => { const e = r.filter(([c]) => c === 'FAST_EMAIL_ACCEPTED' || c === 'FAST_EMAILS_SENT'); const rest = r.filter((x) => !e.includes(x)); const b = rest.findIndex(([c]) => c === 'FAST_BOOKING'); return [...rest.slice(0, b), ...e, ...rest.slice(b)]; }); assert.equal(why(s, 'EMAIL'), 'EMAILS_BEFORE_BOOKING');
  s = swap((r) => [...r, ['FAST_TEXTS_SENT', { n: 1 }]]); assert.equal(why(s, 'SMS'), 'TEXT_SENT');
  s = swap((r) => [...r, ['BRIDGE_VOICE_ERROR', { type: 'authentication_error', errorCode: 'invalid_api_key', call: 1, ms: 5 }]]); assert.equal(why(s, 'VOICE'), 'VOICE_ERROR');
  s = swap((r) => [...r, ['ADAPTER_VOICE_ERROR_EVENT', { phase: 'notice', call: 1, ms: 5 }]]); assert.equal(why(s, 'VOICE'), 'VOICE_ERROR');
  s = swap((r) => set(r, 'FAST_END', { reason: 'CALLER_HUNG_UP', booked: false })); assert.equal(why(s, 'CONSISTENCY'), 'END_AND_BOOKING_DISAGREE');
  s = swap((r) => set(r, 'FAST_ADDRESS_VALIDATE', { status: 'mismatch', field: 'zip_state', attempt: 1 })); assert.equal(why(s, 'ADDRESS'), 'BOOKED_WITHOUT_VALID_ADDRESS');
  s = swap((r) => [...r.filter(([c]) => c !== 'FAST_ADDRESS_VALIDATE'), ['FAST_ADDRESS_VALIDATE', { status: 'valid', attempt: 1 }]]); assert.equal(why(s, 'ADDRESS'), 'VALIDATED_AFTER_BOOKING');
  s = swap((r) => [...r.slice(0, 5), ['FAST_ADDRESS_GUARD', { ok: false, count: 1, field: 'house_number' }], ...r.slice(5)]); assert.equal(why(s, 'ADDRESS'), 'BOOKED_AFTER_GUARD_REFUSAL');
  s = swap((r) => [...r, ['FAST_CALLER_REFUSED', { verified: true }]]); assert.equal(why(s, 'CALLER'), 'CALLER_REFUSED');
  s = swap((r) => r.filter(([c]) => c !== 'FAST_STATE')); assert.deepEqual([status(s, 'INTAKE'), why(s, 'INTAKE')], ['FAIL', 'BOOKED_WITH_MISSING_PARTS']);
});

test('calls that never completed are BLOCKED, not FAIL and never PASS: a hang-up, a guard refusal, a restart mid-call, an older non-fast call, unreadable lines', () => {
  const upTo = (code: string): Row[] => { const r = cleanRows(); return r.slice(0, r.findIndex(([c]) => c === code)); };
  let s = scoreCall(callOf([...upTo('FAST_OFFER'), ['FAST_END', { reason: 'CALLER_HUNG_UP', booked: false }], ['FAST_OUTCOME', { reason: 'CALLER_HUNG_UP', booked: false, steps: 4 }]], START, COMMIT), CLEAN_ATT);
  assert.equal(s.overall, 'BLOCKED'); assert.deepEqual([why(s, 'INTAKE'), why(s, 'JOBBER'), why(s, 'CONFIRM')], ['INCOMPLETE_CALL', 'NO_BOOKING', 'NOT_REACHED']);
  s = scoreCall(callOf(upTo('FAST_END'), START, COMMIT), CLEAN_ATT); assert.deepEqual([s.overall, why(s, 'LOG')], ['BLOCKED', 'CALL_NOT_ENDED_IN_LOG']);
  s = scoreCall(callOf([['CALL_STREAM_ACCEPTED', { call: 1 }], ['BRIDGE_VOICE_OPEN', { call: 1 }], ['ADAPTER_CALL_START', { call: 1 }]], START, COMMIT), CLEAN_ATT); assert.deepEqual([s.overall, why(s, 'LOG')], ['BLOCKED', 'NOT_FAST_PATH']);
  const noisy = log(cleanRows(), START, COMMIT).split('\n'); noisy.splice(8, 0, 'this line is not a log line'); const c = splitCalls(parseLog(noisy.join('\n')))[0];
  s = scoreCall(c, CLEAN_ATT); assert.deepEqual([s.overall, why(s, 'LOG'), c.unparsed], ['BLOCKED', 'UNREADABLE_LINES', 1]);
  const bad = parseLog('2026-11-07T20:27:41Z FAST_END {"a":{"b":1}}\n2026-11-07T20:27:41Z FAST_END {broken\nnot a line\n2026-11-07T20:27:41Z lower_case_code {}'); assert.deepEqual(bad, [null, null, null, null]);
  // a restart ends the call: a SERVER_START in the middle closes it
  const cut = [log(cleanRows().slice(0, 6), START, COMMIT), `${iso(START, 20)} SERVER_START {"pid":2}`, ...lines(iso(START, 21), cleanRows().slice(6))].join('\n'); const calls = splitCalls(parseLog(cut)); assert.equal(calls.length, 1); assert.equal(scoreCall(calls[0], CLEAN_ATT).overall, 'BLOCKED');
  // a guard that refused the facts and ended the call without booking
  s = scoreCall(callOf([...upTo('FAST_BOOKING_GUARD'), ['FAST_BOOKING_GUARD', { ok: false, count: 1, field: 'street' }], ['FAST_END', { reason: 'BOOKING_CHANGED', booked: false }], ['FAST_OUTCOME', { reason: 'BOOKING_CHANGED', booked: false, steps: 9 }]], START, COMMIT), CLEAN_ATT);
  assert.equal(why(s, 'CONFIRM'), 'GUARD_REFUSED_NOT_BOOKED'); assert.notEqual(s.overall, 'PASS');
});

test('attestation files: only the four allowed fields with booleans (and the two verdict words) are accepted; free text, unknown fields and bad keys are refused without echoing them', () => {
  const ok = parseAttestations(JSON.stringify({ [START]: CLEAN_ATT, '2026-11-07T21:00:00Z': { founderVerdict: 'failed', emailsReceived: null } })); assert.deepEqual(ok.problems, []); assert.deepEqual(ok.byCall[START], CLEAN_ATT); assert.equal(ok.byCall['2026-11-07T21:00:00Z'].emailsReceived, null);
  for (const [label, text] of [['not json', '{'], ['array', '[]'], ['bad key', JSON.stringify({ tonight: {} })], ['not an object', JSON.stringify({ [START]: true })], ['free text', JSON.stringify({ [START]: { note: 'Jane Doe at 12 Elm St' } })], ['text in a boolean', JSON.stringify({ [START]: { addressMatchesJob: 'yes' } })], ['bad verdict', JSON.stringify({ [START]: { founderVerdict: 'maybe' } })]] as Array<[string, string]>) {
    const p = parseAttestations(text); assert.ok(p.problems.length > 0, label); assert.ok(!JSON.stringify(p).includes('Jane') && !JSON.stringify(p).includes('Elm'), label + ': the content is never echoed');
  }
});

test('the command line: scores from the files given, honours --last, --attest and --expect-commit, exits 0 only when every call shown is PASS, 1 on a FAIL or BLOCKED, 2 on bad input, and prints tokens only', () => {
  const text = [log(TEST12, START), log(cleanRows(), '2026-11-07T22:00:00Z', COMMIT)].join('\n');
  const files: Record<string, string> = { 'call.log': text, 'att.json': JSON.stringify({ [START]: { founderVerdict: 'failed' }, '2026-11-07T22:00:00Z': CLEAN_ATT }), 'bad.json': JSON.stringify({ [START]: { note: 'Jane Doe' } }) };
  const run1 = (args: string[]): [number, string] => { let out = ''; const code = run(args, { readFile: (p) => { if (!(p in files)) throw new Error('missing'); return files[p]; }, write: (t) => { out += t; } }); return [code, out]; };
  let [code, out] = run1(['call.log']); assert.equal(code, 1, 'BLOCKED is not success'); assert.match(out, /calls=2 PASS=0 FAIL=0 BLOCKED=2 cleanStreak=0/);
  [code, out] = run1(['call.log', '--attest', 'att.json']); assert.equal(code, 1); assert.match(out, /calls=2 PASS=1 FAIL=1 BLOCKED=0 cleanStreak=1/); assert.match(out, /FOUNDER_SAYS_FAILED/);
  [code, out] = run1(['call.log', '--attest', 'att.json', '--last', '1']); assert.equal(code, 0, 'the only call shown is a full PASS'); assert.match(out, /calls=1 PASS=1/);
  [code, out] = run1(['call.log', '--attest', 'att.json', '--expect-commit', 'abcdef1']); assert.equal(code, 1); assert.match(out, /DIFFERENT_COMMIT/);
  for (const args of [[], ['nope.log'], ['call.log', '--attest', 'nope.json'], ['call.log', '--attest', 'bad.json'], ['call.log', '--last', '0'], ['call.log', '--expect-commit', 'zz'], ['call.log', '--wat']]) { [code, out] = run1(args); assert.equal(code, 2, args.join(' ')); assert.ok(!out.includes('Jane')); }
  [code, out] = run1(['call.log', '--attest', 'att.json']);
  for (const l of out.split('\n')) assert.match(l, /^[A-Za-z0-9_ :=.,()'-]*$/, 'tokens only: ' + l);
});

test('the scorecard never prints a value from the log: an extra field carrying personal-looking text is ignored and does not appear in the output', () => {
  const rows = cleanRows().map((r) => (r[0] === 'FAST_NAME' ? ['FAST_NAME', { ...r[1], street: 'SECRETSTREET', who: 'Jane-Doe' }] as Row : r));
  const out = render([scoreCall(callOf(rows, START, COMMIT), CLEAN_ATT)]); assert.ok(!out.includes('SECRET') && !out.includes('Jane'));
});

test('streak counts only the most recent unbroken PASS calls; one FAIL or BLOCKED resets it', () => {
  const mk = (o: CallScore['overall']): CallScore => ({ start: START, checks: [], overall: o });
  assert.equal(streak([]), 0); assert.equal(streak([mk('PASS'), mk('PASS'), mk('PASS')]), 3); assert.equal(streak([mk('PASS'), mk('BLOCKED'), mk('PASS'), mk('PASS')]), 2); assert.equal(streak([mk('PASS'), mk('PASS'), mk('FAIL')]), 0);
  const calls = splitCalls(parseLog([log(cleanRows(), '2026-11-07T10:00:00Z', COMMIT), log(cleanRows(), '2026-11-07T11:00:00Z', COMMIT), log(cleanRows(), '2026-11-07T12:00:00Z', COMMIT)].join('\n')));
  const att: Record<string, Attestation> = { '2026-11-07T10:00:00Z': CLEAN_ATT, '2026-11-07T11:00:00Z': CLEAN_ATT, '2026-11-07T12:00:00Z': CLEAN_ATT };
  assert.equal(streak(scoreAll(calls, att)), 3); assert.equal(streak(scoreAll(calls, { ...att, '2026-11-07T12:00:00Z': { founderVerdict: 'failed' } })), 0); assert.equal(streak(scoreAll(calls, { ...att, '2026-11-07T10:00:00Z': { founderVerdict: 'failed' } })), 2);
});

test('emails switched off are BLOCKED, never PASS: a clean call without emails cannot be a clean completion of the emailed path', () => {
  const rows = cleanRows().filter(([c]) => c !== 'FAST_EMAILS_SENT' && c !== 'FAST_EMAIL_ACCEPTED'); rows.splice(rows.findIndex(([c]) => c === 'FAST_TEXTS_SKIPPED'), 0, ['FAST_EMAILS_SKIPPED']);
  const s = scoreCall(callOf(rows, START, COMMIT), { founderVerdict: 'clean', addressMatchesJob: true, timeAndPriceMatch: true });
  assert.deepEqual([status(s, 'EMAIL'), why(s, 'EMAIL'), s.overall], ['BLOCKED', 'EMAILS_OFF', 'BLOCKED']);
});

test('release success (exit 0) is impossible without positive evidence: historical Test #12, every missing-evidence variant, an empty log and a log with no calls all exit 1', () => {
  const exit = (logText: string, att?: Record<string, Attestation>, extra: string[] = []): number => run(['c.log', ...(att === undefined ? [] : ['--attest', 'a.json']), ...extra], { readFile: (p) => (p === 'c.log' ? logText : JSON.stringify(att)), write: () => undefined });
  // historical Test #12: the log alone, with a clean attestation, with a failed attestation, and the last call only
  assert.equal(exit(log(TEST12)), 1, 'Test #12 from the log alone');
  assert.equal(exit(log(TEST12), { [START]: CLEAN_ATT }), 1, 'Test #12 with a clean attestation: the log still lacks a commit and an address validation');
  assert.equal(exit(log(TEST12), { [START]: { founderVerdict: 'failed' } }), 1, 'Test #12 as the founder reported it');
  assert.equal(exit(log(TEST12), { [START]: CLEAN_ATT }, ['--last', '1']), 1);
  // the control: a fully evidenced call is the only thing that exits 0
  assert.equal(exit(log(cleanRows(), START, COMMIT), { [START]: CLEAN_ATT }), 0, 'control: every proof present');
  // missing evidence: removing any one required event (or the commit, or the attestation) leaves exit 1
  for (const code of ['FAST_NAME', 'FAST_STATE', 'FAST_WHEN', 'FAST_SIZE', 'FAST_OFFER', 'FAST_ADDRESS', 'FAST_ADDRESS_VALIDATE', 'FAST_BOOKING_GUARD', 'JOBBER_WRITE_SENT', 'FAST_BOOKING', 'FAST_EMAILS_SENT', 'FAST_TEXTS_SKIPPED', 'FAST_END', 'FAST_OUTCOME', 'BRIDGE_VOICE_OPEN']) assert.equal(exit(log(cleanRows().filter(([c]) => c !== code), START, COMMIT), { [START]: CLEAN_ATT }), 1, 'without ' + code);
  assert.equal(exit(log(cleanRows(), START), { [START]: CLEAN_ATT }), 1, 'no commit'); assert.equal(exit(log(cleanRows(), START, COMMIT)), 1, 'no attestation');
  assert.equal(exit(log(cleanRows(), START, COMMIT), { [START]: CLEAN_ATT }, ['--expect-commit', 'abcdef1']), 1, 'a different commit than expected');
  // no evidence at all is not success either
  assert.equal(exit(''), 1, 'an empty log'); assert.equal(exit('garbage\nmore garbage'), 1, 'a log with no readable call'); assert.equal(exit(`${iso(START, -3)} SERVER_START {"pid":1}`), 1, 'a server start and no call');
  // one passing call among blocked ones is still not a release success when the blocked ones are shown
  const mixed = [log(TEST12), log(cleanRows(), '2026-11-07T22:00:00Z', COMMIT)].join('\n');
  assert.equal(exit(mixed, { '2026-11-07T22:00:00Z': CLEAN_ATT }), 1, 'a blocked call is in view'); assert.equal(exit(mixed, { '2026-11-07T22:00:00Z': CLEAN_ATT }, ['--last', '1']), 0, 'only the passing call is in view');
});
