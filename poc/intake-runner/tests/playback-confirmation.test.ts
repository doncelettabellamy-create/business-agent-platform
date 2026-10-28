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
import { createRelayHandler } from '../src/relay-handler.ts';
import { consentNoticeFor } from '../src/opening.ts';
import type { DialogueModel } from '../src/dialogue-model.ts';
import type { ModelProvider, ModelRequest } from '../src/model-gateway.ts';
import { createRealtimeTransport } from '../src/realtime-transport.ts';
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
