// The confirmation wait starts only after the read-back has finished PLAYING (verified by the voice route), with a bounded failure timeout (2026-10-28). Regression for the live call where a 44 second
// read-back was hung up on after 20 seconds, before the caller could answer. The call logic, the masker, the real Intake entry (stand-in model), the record store and the contact vault are the real ones;
// the voice service and the phone are the offline simulator (tests/helpers/realtime-sim.ts), so a passing test shows behaviour against THIS model of the service, not against OpenAI. Invented data only.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createIntakeEntry } from '../src/intake-entry.ts';
import { createTenantRegistry } from '../src/tenant-boundary.ts';
import { mintExecutionContext } from '../src/execution-context.ts';
import { createIntakeRecordStore } from '../src/intake-record-store.ts';
import { createContactVault } from '../src/contact-vault.ts';
import { createRelayHandler, SAY } from '../src/relay-handler.ts';
import { consentNoticeFor } from '../src/opening.ts';
import type { DialogueModel } from '../src/dialogue-model.ts';
import type { ModelProvider, ModelRequest } from '../src/model-gateway.ts';
import { createRealtimeTransport } from '../src/realtime-transport.ts';
import { toOwnerCall, OWNER_TEXT } from '../src/owner-view.ts';
import { eligibleForProcessing } from '../src/intake-record-store.ts';
import { createRealtimeSim } from './helpers/realtime-sim.ts';
import type { RealtimeSim, RealtimeSimOptions } from './helpers/realtime-sim.ts';

const T = 'ws-founder-plumbing';
const N1 = '+15555550100';
const SID = (n: number) => `CA${String(n).padStart(32, '0')}`;
const plumbing = JSON.parse(readFileSync(new URL('../examples/skill-plumbing.json', import.meta.url), 'utf8')).skill_config;
const dir = mkdtempSync(join(tmpdir(), 'playback-conf-'));
const closers: Array<() => unknown> = [];
after(async () => { for (const c of closers.reverse()) try { await c(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });
const NOTICE = consentNoticeFor({ business_name: 'Example Cleaning' });

function intakeModel(): ModelProvider {
  return {
    id: 'stub:playback',
    async complete(req: ModelRequest) {
      const text = req.data.masked_text;
      if (req.task === 'classify_request') return { text: JSON.stringify({ category: /burst pipe|leak|flood/i.test(text) ? 'Emergency leak' : null, confidence: 0.9 }) };
      const fields = (req.data.fields ?? []).map((f) => {
        const m = f.name === 'Address' ? /\[ADDRESS_\d+\]/.exec(text) : f.name === 'Job description' ? /burst pipe|leak/i.exec(text) : /tomorrow morning/i.exec(text);
        return { name: f.name, value: m ? m[0] : null, confidence: m ? 0.9 : null };
      });
      return { text: JSON.stringify({ fields }) };
    },
  };
}
const quiet: DialogueModel = { stats: { calls: 0, errors: [] }, async *reply() { yield 'Okay. '; } };

interface Opts { mpc?: number; confirmWaitMs?: number; playbackMaxMs?: number; behave?: RealtimeSimOptions['behave'] }
let dbn = 0;
async function rig(o: Opts = {}) {
  const store = createIntakeRecordStore({ path: join(dir, `calls${++dbn}.sqlite`) });
  closers.push(() => store.close());
  const vault = createContactVault({ path: join(dir, `contacts${dbn}.sqlite`), key: randomBytes(32), now: () => Date.now() });
  closers.push(() => vault.close());
  const logs: Array<{ code: string; detail?: Record<string, unknown>; at: number }> = [];
  const intake = createIntakeEntry({
    registry: createTenantRegistry({ [T]: plumbing }), channelRef: 'channel-founder-phone', now: () => '2026-10-26T12:00:00Z',
    provider: intakeModel(), limits: { maxOutputTokens: 1024, timeoutMs: 2000, maxAttempts: 1 }, founderTest: { tenant: T },
  });
  const handler = createRelayHandler({
    numbers: new Map([[N1, T]]), categoryNames: () => plumbing.categories.map((c: { name: string }) => c.name), intake,
    async intakeContext(tenant, ref) {
      const r = await mintExecutionContext({ credential: 'test', agent: 'intake' }, { verify: () => ({ kind: 'system', id: 'playback-test' }), selectTenant: () => tenant, grants: () => ['intake:run'], newCorrelationId: () => `corr-${ref}` });
      if (!r.ok) throw new Error('context');
      return r.context;
    },
    dialogue: quiet, store, limits: { maxTurns: 40, maxMinutes: 8, maxChars: 4000 }, names: [], maxCalls: 50,
    now: () => Date.now(), nowIso: () => '2026-10-26T12:00:00Z', killed: () => false, afterSpeechMs: 0, speechMs: () => 0,
    confirmWaitMs: o.confirmWaitMs ?? 400, ...(o.playbackMaxMs === undefined ? {} : { playbackMaxMs: o.playbackMaxMs }), previewBudgetMs: 3000, replyRetryMs: 500, replyFirstWordMs: 500, contacts: vault,
    log: (code, detail) => { logs.push({ code, detail, at: Date.now() }); },
  });
  const sim: RealtimeSim = createRealtimeSim({ msPerChar: o.mpc ?? 1, ...(o.behave === undefined ? {} : { behave: o.behave }) });
  handler.serve(createRealtimeTransport(sim.link, { notice: NOTICE, transcriptionModel: 'sim-transcriber', voice: 'sim-voice', msPerChar: o.mpc ?? 1, endWaitMs: 1000 }));
  return { sim, handler, store, vault, logs };
}
type Rig = Awaited<ReturnType<typeof rig>>;
const has = (r: Rig, code: string) => r.logs.some((l) => l.code === code);
const at = (r: Rig, code: string) => r.logs.find((l) => l.code === code)?.at;
const asked = (r: Rig) => r.logs.filter((l) => l.code === 'ASK').map((l) => String(l.detail?.field));

async function turn(r: Rig, text: string) {
  const before = r.sim.spoken.length;
  r.sim.say(text);
  await r.sim.waitFor(() => r.sim.spoken.length > before || r.sim.hungUp || has(r, 'READBACK'), 8000);
  await r.handler.idle();
}
/** Consent, a request, then the answers the questions ask for, until the read-back has been requested. */
async function toReadback(r: Rig) {
  r.sim.start({ to: N1, callSid: SID(1) });
  await r.sim.heard(1, 15_000);
  r.sim.say('yes I agree'); await r.sim.heard(2, 15_000); await r.handler.idle();
  await turn(r, 'I have a burst pipe in the kitchen');
  for (let i = 0; i < 16 && !has(r, 'READBACK'); i++) {
    const field = asked(r).at(-1);
    await turn(r, field === 'CUSTOMER_NAME' ? 'priya raman' : field === 'CALLBACK_PHONE_NUMBER' ? 'two one two five five five zero one four two' : field === 'SERVICE_ADDRESS' ? '742 Evergreen Terrace' : field === 'ADDRESS' ? '742 Evergreen Terrace' : 'the pipe is burst');
  }
  assert.ok(has(r, 'READBACK'), 'the read-back was reached: ' + JSON.stringify(asked(r)));
}

test('long read-back: the silence wait starts when the playback is over, so a read-back longer than the wait is not hung up on, and a yes after it is heard', async () => {
  const r = await rig({ mpc: 20, confirmWaitMs: 500 });
  await toReadback(r);
  const readbackAt = at(r, 'READBACK') as number;
  assert.ok(r.sim.playing(), 'the read-back is still being spoken when the logic has asked it');
  await new Promise((res) => setTimeout(res, 600));   // longer than the wait, but the read-back is still playing (several seconds at this pace)
  assert.equal(has(r, 'CONFIRM_TIMEOUT'), false, 'no timeout while the read-back is still being spoken');
  assert.equal(r.sim.hungUp, false);
  await r.sim.waitFor(() => has(r, 'PLAYBACK_SETTLED'), 15_000);
  const settledAt = at(r, 'PLAYBACK_SETTLED') as number;
  assert.equal(r.logs.find((l) => l.code === 'PLAYBACK_SETTLED')?.detail?.outcome, 'PLAYED');
  assert.ok(settledAt - readbackAt > 1000, `the read-back took ${settledAt - readbackAt} ms to play, longer than the ${500} ms wait`);
  assert.equal(has(r, 'CONFIRM_TIMEOUT'), false);
  const before = r.sim.spoken.length;
  r.sim.say('yes');
  await r.sim.waitFor(() => r.sim.spoken.length > before, 8000); await r.handler.idle();
  assert.ok(has(r, 'ADDRESS_READBACK'), 'the yes was heard and the address confirmation followed');
  assert.equal(has(r, 'CONFIRM_TIMEOUT'), false);
});

test('silence after a long read-back: the timeout comes the full wait AFTER the playback ended, not after it started', async () => {
  const r = await rig({ mpc: 20, confirmWaitMs: 500 });
  await toReadback(r);
  await r.sim.waitFor(() => has(r, 'CONFIRM_TIMEOUT'), 20_000);
  const [readbackAt, settledAt, timeoutAt] = [at(r, 'READBACK'), at(r, 'PLAYBACK_SETTLED'), at(r, 'CONFIRM_TIMEOUT')] as number[];
  assert.ok(settledAt - readbackAt > 1000, 'the playback was long');
  assert.ok(timeoutAt - settledAt >= 450, `the silence wait (${timeoutAt - settledAt} ms) ran from the end of the playback`);
  await r.sim.waitFor(() => r.sim.hungUp, 15_000);
  const [rec] = r.store.list(T);
  assert.deepEqual([rec.confirmation, rec.handed_off], ['unconfirmed', false], 'a caller who really stayed silent still ends unconfirmed and held');
});

test('interruption: a caller who talks over the read-back stops its wait; the follow-up question gets its own playback-verified wait, and a yes then is heard', async () => {
  const r = await rig({ mpc: 20, confirmWaitMs: 600 });
  await toReadback(r);
  const before = r.sim.spoken.length;
  r.sim.say('hang on', { playedMs: 300 });
  await r.sim.waitFor(() => r.sim.spoken.length > before, 15_000); await r.handler.idle();
  assert.equal(has(r, 'CONFIRM_TIMEOUT'), false, 'the caller is talking: no timeout');
  assert.ok(r.logs.filter((l) => l.code === 'PLAYBACK_SETTLED').every((l) => l.detail?.outcome !== 'TIMEOUT'), 'no playback wait ran out');
  const n = r.sim.spoken.length;
  r.sim.say('yes');
  await r.sim.waitFor(() => has(r, 'ADDRESS_READBACK') || r.sim.spoken.length > n, 15_000); await r.handler.idle();
  assert.equal(has(r, 'CONFIRM_TIMEOUT'), false);
});

test('bounded failure: a read-back whose playback is never reported complete does not hold the call open for ever: the wait for it is bounded, then the silence wait runs', async () => {
  const r = await rig({ mpc: 1, confirmWaitMs: 300, playbackMaxMs: 500, behave: (text) => (text.startsWith('Let me check') ? 'hang' : 'exact') });
  await toReadback(r);
  const readbackAt = at(r, 'READBACK') as number;
  await r.sim.waitFor(() => has(r, 'CONFIRM_TIMEOUT') || r.sim.hungUp, 20_000);
  const settled = r.logs.find((l) => l.code === 'PLAYBACK_SETTLED');
  assert.ok(settled !== undefined, 'the bounded wait reported');
  assert.ok(['TIMEOUT', 'CUT'].includes(String(settled?.detail?.outcome)), 'a playback that never completed is TIMEOUT (or CUT if the transport gave up first): ' + JSON.stringify(settled?.detail));
  const done = (at(r, 'CONFIRM_TIMEOUT') ?? at(r, 'UNCONFIRMED') ?? Date.now()) - readbackAt;
  assert.ok(done < 5000, `the call did not stay open: ${done} ms`);
});

// ================================================================ 2026-10-29: ONE confirmation flow for the job read-back and the address question, decided by MEASURED playback (not by estimated characters).
// A yes counts only when the unit it answers (the details and the question, the last words being the question) was played to the line in full. An earlier yes confirms nothing and never becomes valid later.
const sleepMs = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
const readbacksHeard = (r: Rig) => r.sim.spoken.filter((s) => s.startsWith('Let me check')).length;
const heldList = (r: Rig) => r.logs.filter((l) => l.code === 'CONFIRM_HELD').map((l) => `${l.detail?.kind}/${l.detail?.why}`);
const settled = (r: Rig) => r.logs.filter((l) => l.code === 'PLAYBACK_SETTLED').length;
/** Waits until the newest speech has been played in full and the call logic has the verdict. */
async function heardInFull(r: Rig, n = settled(r) + 1) { await r.sim.waitFor(() => settled(r) >= n, 30_000); await r.sim.idle(); await r.handler.idle(); await sleepMs(20); }
const ADDR_SPOKEN = (r: Rig) => r.sim.spoken.filter((s) => s.includes('I have your service address as'));   // the repeated question may carry the fixed wait instruction in front

test('CONFIRM live replay (job): the details and question were heard in full, an unclear line followed, and the caller\'s yes came over the repeated question: it is held, only the question is asked again, and a fresh yes after it was heard goes on', async () => {
  const r = await rig({ mpc: 20, confirmWaitMs: 8000 });
  await toReadback(r);
  await heardInFull(r);                                        // the whole read-back reached the line (the live call: 32,700 of 32,700 ms)
  assert.equal(readbacksHeard(r), 1);
  r.sim.say('hmm what was that');                               // an unclear line: the short question is spoken
  await r.sim.waitFor(() => r.sim.playing(), 5000);
  r.sim.say('yes');                                            // the live call's yes: it cut the short question at 0 acknowledged
  await r.sim.waitFor(() => heldList(r).length > 0, 10_000);
  await r.sim.idle(); await r.handler.idle();
  assert.deepEqual(heldList(r), ['QUESTION/CUT']);
  assert.equal(has(r, 'ADDRESS_READBACK'), false, 'the early yes confirmed nothing');
  await r.sim.waitFor(() => r.sim.spoken.includes(SAY.question), 15_000);     // only the question, not the whole read-back
  assert.equal(r.sim.spoken.filter((s) => s === SAY.question).length, 1, 'the question was cut once and then played once in full');
  await r.sim.idle(); await r.handler.idle(); await sleepMs(20);
  assert.equal(readbacksHeard(r), 1, 'the details were not read again');
  assert.equal(has(r, 'ADDRESS_READBACK'), false, 'the old yes did not become valid when the question finished playing');
  r.sim.say('yes');                                            // a fresh yes, after the question was heard
  await r.sim.waitFor(() => has(r, 'ADDRESS_READBACK'), 10_000);
  assert.deepEqual(heldList(r), ['QUESTION/CUT']);
});

test('CONFIRM live replay (address): the question cut with 6,000 of 7,450 ms acknowledged is not heard; the yes is held, the question is asked in full again, and only a fresh yes after it confirms', async () => {
  const r = await rig({ mpc: 25, confirmWaitMs: 8000 });
  await toReadback(r);
  await heardInFull(r);
  r.sim.say('yes');
  await r.sim.waitFor(() => has(r, 'ADDRESS_READBACK'), 15_000);
  await r.sim.waitFor(() => r.sim.playing(), 5000);
  r.sim.say('correct');                                        // over the address question
  await r.sim.waitFor(() => has(r, 'ADDRESS_ANSWER_IGNORED'), 10_000);
  assert.deepEqual(heldList(r), ['ADDRESS/CUT']);
  assert.equal(has(r, 'ADDRESS_CONFIRMED'), false);
  await r.sim.waitFor(() => ADDR_SPOKEN(r).length >= 1, 20_000);               // the repeated question played in full
  await heardInFull(r, settled(r));
  assert.equal(has(r, 'ADDRESS_CONFIRMED'), false, 'the early yes did not become valid later');
  assert.ok(r.logs.filter((l) => l.code === 'ADDRESS_READBACK').length >= 2);
  r.sim.say('correct');
  await r.sim.waitFor(() => has(r, 'ADDRESS_CONFIRMED'), 10_000);
  await r.sim.waitFor(() => r.sim.hungUp, 15_000);
  const [rec] = r.store.list(T);
  assert.deepEqual([rec.confirmation, rec.address_status], ['confirmed', 'caller_confirmed']);
});

test('CONFIRM a yes over the details of the job read-back is held, the read-back is said again, and with no fresh yes the call still ends unconfirmed (the early yes never becomes valid)', async () => {
  const r = await rig({ mpc: 20, confirmWaitMs: 500 });
  await toReadback(r);
  r.sim.say('yes');                                            // the read-back is still playing
  await r.sim.waitFor(() => heldList(r).length > 0, 10_000);
  assert.deepEqual(heldList(r), ['JOB/CUT']);
  await r.sim.waitFor(() => readbacksHeard(r) >= 1, 20_000);                  // said again in full
  assert.equal(has(r, 'ADDRESS_READBACK'), false);
  await r.sim.waitFor(() => has(r, 'CONFIRM_TIMEOUT') || r.sim.hungUp, 20_000);
  assert.equal(has(r, 'ADDRESS_READBACK'), false, 'nothing was confirmed by the early yes');
  await r.sim.waitFor(() => r.sim.hungUp, 15_000);
  const [rec] = r.store.list(T);
  assert.deepEqual([rec.confirmation, rec.handed_off], ['unconfirmed', false]);
});

test('CONFIRM differing speech speeds: whatever the pace, a yes after the whole unit was played is accepted and a yes during it is held (nothing depends on characters per second)', async () => {
  for (const mpc of [2, 45]) {
    const slow = await rig({ mpc, confirmWaitMs: 8000 });
    await toReadback(slow);
    await heardInFull(slow);
    slow.sim.say('yes');
    await slow.sim.waitFor(() => has(slow, 'ADDRESS_READBACK'), 15_000);
    assert.deepEqual(heldList(slow), [], `pace ${mpc}: a yes after the read-back was heard is not held`);
    const fast = await rig({ mpc, confirmWaitMs: 8000 });
    await toReadback(fast);
    fast.sim.say('yes');
    await fast.sim.waitFor(() => heldList(fast).length > 0 || has(fast, 'ADDRESS_READBACK'), 15_000);
    if (mpc >= 20) assert.deepEqual(heldList(fast), ['JOB/CUT'], `pace ${mpc}: a yes during the read-back is held`);
    assert.equal(has(fast, 'ADDRESS_READBACK'), false, `pace ${mpc}: and it confirmed nothing`);
  }
});

test('CONFIRM one mark short: a read-back whose last mark the phone never acknowledged was not played to the line, so a yes does not confirm it; the read-back is said again and a yes to that one does', async () => {
  let n = 0;
  const r = await rig({ mpc: 3, confirmWaitMs: 8000, behave: (text) => (text.startsWith('Let me check') && n++ === 0 ? 'short' : 'exact') });
  await toReadback(r);
  await r.sim.waitFor(() => has(r, 'REPLY_NOT_PLAYED'), 20_000);
  await r.sim.idle(); await r.handler.idle();
  r.sim.say('yes');
  await r.sim.waitFor(() => heldList(r).length > 0, 10_000);
  assert.deepEqual(heldList(r), ['JOB/LOST']);
  assert.equal(has(r, 'ADDRESS_READBACK'), false);
  await r.sim.waitFor(() => readbacksHeard(r) >= 1, 20_000);
  await heardInFull(r, settled(r));
  r.sim.say('yes that is right');
  await r.sim.waitFor(() => has(r, 'ADDRESS_READBACK'), 10_000);
});

test('CONFIRM a no or a correction is processed normally even when the unit was not heard in full; only a yes needs the whole unit', async () => {
  const j = await rig({ mpc: 20, confirmWaitMs: 8000 });
  await toReadback(j);
  j.sim.say('no that is wrong');                                // over the read-back
  await j.sim.waitFor(() => j.sim.spoken.includes(SAY.correct), 15_000);
  assert.deepEqual(heldList(j), [], 'a no is not held');
  const a = await rig({ mpc: 25, confirmWaitMs: 8000 });
  await toReadback(a);
  await heardInFull(a);
  a.sim.say('yes');
  await a.sim.waitFor(() => has(a, 'ADDRESS_READBACK'), 15_000);
  await a.sim.waitFor(() => a.sim.playing(), 5000);
  a.sim.say('no that is wrong');                                // over the address question
  await a.sim.waitFor(() => a.sim.spoken.includes(SAY.addressWrong), 15_000);
  assert.deepEqual(heldList(a), []);
  assert.equal(has(a, 'ADDRESS_CORRECTION'), true);
});

test('CONFIRM bounded: repeated early yes answers end the call unconfirmed for human review; they never confirm', async () => {
  const r = await rig({ mpc: 20, confirmWaitMs: 8000 });
  await toReadback(r);
  r.sim.say('yes');                                            // over read-back 1: held, said again
  await r.sim.waitFor(() => r.logs.filter((l) => l.code === 'READBACK').length >= 2, 10_000);
  r.sim.say('yes');                                            // over read-back 2: the limit is reached
  await r.sim.waitFor(() => r.sim.hungUp, 30_000);
  assert.equal(has(r, 'ADDRESS_READBACK'), false);
  assert.equal(heldList(r).length, 2);
  const [rec] = r.store.list(T);
  assert.deepEqual([rec.confirmation, rec.handed_off], ['unconfirmed', false]);
});

test('CONFIRM the log holds fixed codes and millisecond counts only: the measured numbers agree with the verdict (all acknowledged when played, fewer when cut) and no word of the call appears', async () => {
  const r = await rig({ mpc: 20, confirmWaitMs: 8000 });
  await toReadback(r);
  r.sim.say('yes');
  await r.sim.waitFor(() => heldList(r).length > 0, 10_000);
  await r.sim.waitFor(() => readbacksHeard(r) >= 1, 20_000); await r.sim.idle(); await r.handler.idle(); await sleepMs(20);
  const sets = r.logs.filter((l) => l.code === 'CONFIRM_UNIT').map((l) => l.detail as Record<string, unknown>);
  const cut = r.logs.find((l) => l.code === 'CONFIRM_HELD')?.detail as Record<string, unknown> | undefined; const played = sets.filter((d) => d.outcome === 'PLAYED').at(-1);
  assert.ok(cut !== undefined && typeof cut.sent_ms === 'number' && typeof cut.acked_ms === 'number' && (cut.acked_ms as number) < (cut.sent_ms as number), JSON.stringify(sets));
  assert.ok(played !== undefined && played.sent_ms === played.acked_ms && (played.sent_ms as number) > 0, JSON.stringify(sets));
  const logged = JSON.stringify(r.logs.map((l) => [l.code, l.detail]));
  assert.ok(!/burst pipe|Evergreen|priya|raman/i.test(logged) && !/\d{5,}/.test(logged.replace(/"[a-z_]*ms":\d+/g, '')), 'no caller word or digit string in any log');
});

// ---- 2026-10-29: the address confirmation (record #28 of the PID 22132 call 2). Two affirmations were each held by the measured rule (the question was not acknowledged in full when speech began), the step ended unconfirmed, and the caller heard only
// that the request was recorded. The bounded repair, founder-approved: an affirmation that comes before the question was played in full is held as before (the measured rule is NOT loosened) and the question is asked again with a fixed instruction to wait and
// answer again; a fresh yes after the whole question confirms; if the recovery is exhausted (the existing limit) the caller is told plainly that the address still needs verification. These tests check what was SAID and SAVED; what a caller heard is not
// established by audio that was or was not acknowledged.
/** The closing line is recorded as heard a moment after the hang-up flag: wait for whichever ending was said. */
const closingSpoken = (r: Rig) => r.sim.waitFor(() => r.sim.spoken.some((s) => s === SAY.thanks || s === SAY.addressUnconfirmed || s === SAY.addressRefused), 15_000).then(() => r.sim.idle());
const witnessOf = (r: Rig) => ({ addressState: (tenant: string, callRef: string) => r.vault.get(tenant, callRef)?.address_state });

test('CONFIRM address exhausted (record #28 reproduced): two affirmations over the address question are each held and confirm nothing; the question is asked again with the wait instruction; the call ends by telling the caller the address could not be confirmed; address unverified, follow-up for the owner, no ADDRESS_CONFIRMED, never eligible for processing', async () => {
  assert.equal(typeof SAY.addressUnconfirmed, 'string', 'the approved ending exists');
  assert.equal(SAY.addressUnconfirmed, 'Your request is recorded, but I could not confirm the address. Someone will need to verify it with you. Goodbye.');
  assert.equal(typeof SAY.addressWait, 'string', 'the fixed instruction exists');
  const r = await rig({ mpc: 25, confirmWaitMs: 8000 });
  await toReadback(r);
  await heardInFull(r);                                        // the job read-back reached the line in full (the live call: 31,400 of 31,400 ms)
  r.sim.say('yes');                                            // the job is confirmed; the address question follows
  await r.sim.waitFor(() => has(r, 'ADDRESS_READBACK'), 15_000);
  await r.sim.waitFor(() => r.sim.playing(), 5000);
  r.sim.say('yes');                                            // the first affirmation, before the address question was acknowledged in full
  await r.sim.waitFor(() => heldList(r).length >= 1, 10_000);
  await r.sim.waitFor(() => r.logs.filter((l) => l.code === 'ADDRESS_READBACK').length >= 2, 10_000);   // the question is asked again
  await r.sim.waitFor(() => r.sim.playing(), 5000);
  r.sim.say('yes');                                            // the second affirmation, shortly into the replay (the live call: 0 ms acknowledged)
  await r.sim.waitFor(() => has(r, 'ADDRESS_UNCONFIRMED'), 10_000);
  await r.sim.waitFor(() => r.sim.hungUp, 15_000);
  await closingSpoken(r);
  assert.deepEqual(heldList(r), ['ADDRESS/CUT', 'ADDRESS/CUT'], 'both affirmations were held by the measured rule');
  assert.equal(has(r, 'ADDRESS_CONFIRMED'), false, 'a held affirmation never confirms');
  // The replay was cut, so the simulator records no transcript of it; what was REQUESTED from the voice service is what shows the instruction was put in front of the question.
  const asked = (r.sim as any).sent.map((m: unknown) => JSON.stringify(m)).filter((m: string) => m.includes('I have your service address as'));
  assert.equal(asked.length, 2, 'the address question was requested twice');
  assert.ok(!asked[0].includes(SAY.addressWait) && asked[1].includes(SAY.addressWait), 'the second request, and only it, carries the fixed wait instruction');
  assert.ok(r.sim.spoken.includes(SAY.addressUnconfirmed), 'the caller was told the address could not be confirmed');
  assert.ok(!r.sim.spoken.includes(SAY.thanks), 'not the ending of a confirmed address');
  assert.equal(r.sim.spoken.at(-1), SAY.addressUnconfirmed, 'it is the last thing said');
  const [rec] = r.store.list(T);
  assert.deepEqual([rec.confirmation, rec.status, rec.address_status], ['confirmed', 'ready', 'unverified'], 'the job was confirmed; the address was not');
  assert.equal(r.vault.get(T, rec.call_ref)?.address_state, 'unconfirmed', 'the contact is stored with the address marked not confirmed');
  assert.equal(eligibleForProcessing(rec, witnessOf(r)), false, 'an unverified address can never authorise anything downstream');
  const owner = toOwnerCall(rec);
  assert.equal(owner.needsFollowUp, true);
  assert.ok(owner.nextActions.includes(OWNER_TEXT.verifyAddress), 'the owner is told to verify the address');
  assert.ok(!/742|evergreen/i.test(JSON.stringify(owner)), 'no address in the owner view');
  // The log entries of this rig carry an epoch-millisecond timestamp (`at`); a plain "742" search matched digits inside it on about one run in twelve (CI run #41, reproduced locally: the match was inside "at":...742), which is not an address.
  // The timestamp is left out of the search; the street name and the number followed by the street are what an address in a log would look like.
  assert.ok(!/evergreen|\b742\s+(?:evergreen|terrace)/i.test(JSON.stringify(r.logs.map(({ at: _at, ...rest }) => rest))), 'no address in any log');
});

test('CONFIRM address recovery: an early affirmation is held, the question comes again with the wait instruction, and a fresh yes after the WHOLE replayed question confirms the address; the ending is the ordinary one and the record is eligible', async () => {
  const r = await rig({ mpc: 25, confirmWaitMs: 8000 });
  await toReadback(r);
  await heardInFull(r);
  r.sim.say('yes');
  await r.sim.waitFor(() => has(r, 'ADDRESS_READBACK'), 15_000);
  await r.sim.waitFor(() => r.sim.playing(), 5000);
  r.sim.say('yes');                                            // held once
  await r.sim.waitFor(() => ADDR_SPOKEN(r).length >= 1, 20_000);               // the repeated question played in full
  assert.ok(r.sim.spoken.some((s) => s.startsWith(SAY.addressWait + ' ')), 'with the wait instruction');
  await heardInFull(r, settled(r));
  assert.equal(has(r, 'ADDRESS_CONFIRMED'), false, 'the early yes did not become valid later');
  r.sim.say('yes');                                            // a fresh yes after the whole question
  await r.sim.waitFor(() => has(r, 'ADDRESS_CONFIRMED'), 10_000);
  await r.sim.waitFor(() => r.sim.hungUp, 15_000);
  await closingSpoken(r);
  assert.ok(r.sim.spoken.includes(SAY.thanks));
  assert.ok(!r.sim.spoken.includes(SAY.addressUnconfirmed));
  assert.equal(has(r, 'ADDRESS_UNCONFIRMED'), false);
  const [rec] = r.store.list(T);
  assert.deepEqual([rec.confirmation, rec.address_status], ['confirmed', 'caller_confirmed']);
  assert.equal(r.vault.get(T, rec.call_ref)?.address_state, 'confirmed');
});

test('CONFIRM address ordinary: a yes after the whole address question confirms it with no hold, no instruction and the ordinary ending', async () => {
  const r = await rig({ mpc: 25, confirmWaitMs: 8000 });
  await toReadback(r);
  await heardInFull(r);
  r.sim.say('yes');
  await r.sim.waitFor(() => has(r, 'ADDRESS_READBACK'), 15_000);
  await heardInFull(r, settled(r) + 1);                        // the whole address question reached the line
  r.sim.say('yes');
  await r.sim.waitFor(() => has(r, 'ADDRESS_CONFIRMED'), 10_000);
  await r.sim.waitFor(() => r.sim.hungUp, 15_000);
  await closingSpoken(r);
  assert.deepEqual(heldList(r), []);
  assert.ok(!r.sim.spoken.some((s) => s.startsWith(SAY.addressWait)), 'no instruction when nothing was held');
  assert.ok(r.sim.spoken.includes(SAY.thanks) && !r.sim.spoken.includes(SAY.addressUnconfirmed), 'last spoken: ' + JSON.stringify(r.sim.spoken.slice(-3).map((s) => s.slice(0, 50))));
  const [rec] = r.store.list(T);
  assert.deepEqual([rec.confirmation, rec.address_status, eligibleForProcessing(rec, witnessOf(r))], ['confirmed', 'caller_confirmed', true]);
});
