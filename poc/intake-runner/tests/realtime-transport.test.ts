// The cleaning phone workflow run over an OFFLINE model of OpenAI Realtime (tests/helpers/realtime-sim.ts) instead of Twilio ConversationRelay. The call logic (relay-handler.ts), the
// masker, the REAL Intake entry (with a local stand-in model), the record store and the contact vault are the real ones; only the voice service and the phone layer are simulated.
// Nothing here touches the network or any key, and a passing test shows behaviour against THIS model of the service, not against OpenAI. Invented data only. Run: npm test
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createIntakeEntry } from '../src/intake-entry.ts';
import { createTenantRegistry } from '../src/tenant-boundary.ts';
import { mintExecutionContext } from '../src/execution-context.ts';
import { createIntakeRecordStore } from '../src/intake-record-store.ts';
import { createContactVault } from '../src/contact-vault.ts';
import { createRelayHandler, readBackText, SAY } from '../src/relay-handler.ts';
import { consentNoticeFor } from '../src/opening.ts';
import { fallbackText } from '../src/dialogue-model.ts';
import type { DialogueModel, Directive } from '../src/dialogue-model.ts';
import type { DialogueTurn } from '../src/call-session.ts';
import type { ModelProvider, ModelRequest } from '../src/model-gateway.ts';
import { createRealtimeTransport, sameSpeech, SAY_PREFIX, SPEAK_ONLY, wordsOf } from '../src/realtime-transport.ts';
import type { TransportEvent } from '../src/call-transport.ts';
import { createRealtimeSim } from './helpers/realtime-sim.ts';
import type { Behaviour, RealtimeSim } from './helpers/realtime-sim.ts';

const T = 'ws-founder-plumbing';
const N1 = '+15555550100';
const SID = (n: number) => `CA${String(n).padStart(32, '0')}`;
const MPC = 1;   // milliseconds of playback per character, in the simulator and the adapter
const plumbing = JSON.parse(readFileSync(new URL('../examples/skill-plumbing.json', import.meta.url), 'utf8')).skill_config;
const dir = mkdtempSync(join(tmpdir(), 'realtime-sim-'));
const closers: Array<() => unknown> = [];
after(async () => { for (const c of closers.reverse()) try { await c(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });

const NOTICE = consentNoticeFor({ business_name: 'Example Cleaning' });
const OPENING = 'Hello, how can I help you today?';
const SECRETS = ['Sam Example', 'sam example', 'Elm Street', '42 Elm', '555 010 0199', '5 5 5 0 1 0 0 1 9 9', '0199'];

/** The local stand-in for the Intake model: it answers from the masked text only, like the one in the phone tests. */
function intakeModel(seen: string[]): ModelProvider {
  return {
    id: 'stub:realtime-sim',
    async complete(req: ModelRequest) {
      seen.push(JSON.stringify(req));
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
/** A dialogue model with fixed wording that records the conversation it was shown. `quiet(n)` makes the n-th call (from 1) produce nothing. */
function wording(quiet: (n: number) => boolean = () => false) {
  const turns: DialogueTurn[][] = []; const directives: Directive[] = []; let calls = 0;
  const model: DialogueModel = {
    stats: { calls: 0, errors: [] },
    async *reply(input) {
      calls++; turns.push(input.turns.map((t) => ({ ...t }))); directives.push(input.directive);
      if (quiet(calls)) return;
      const d = input.directive;
      yield d.kind === 'open' ? OPENING : d.kind === 'ask' ? `Could you tell me the ${d.field.toLowerCase()}?` : d.kind === 'clarify' ? 'Could you say what you need?' : 'Okay, please go on.';
    },
  };
  return { model, turns, directives, calls: () => calls };
}

interface RigOptions {
  behave?: (text: string, n: number) => Behaviour; accept?: () => boolean; hangupWorks?: () => boolean; contacts?: boolean;
  limits?: { maxTurns?: number; maxMinutes?: number }; confirmWaitMs?: number; maxCalls?: number; dialogue?: ReturnType<typeof wording>;
  killed?: { v: boolean }; clock?: { offset: number }; mpc?: number; replyRetryMs?: number; replyFirstWordMs?: number; endWaitMs?: number;
}
let dbn = 0;
async function rig(o: RigOptions = {}) {
  const path = join(dir, `calls${++dbn}.sqlite`);
  const store = createIntakeRecordStore({ path });
  closers.push(() => store.close());
  const vault = o.contacts ? createContactVault({ path: join(dir, `contacts${dbn}.sqlite`), key: randomBytes(32), now: () => Date.now() }) : undefined;
  if (vault) closers.push(() => vault.close());
  const logs: Array<{ code: string; detail?: Record<string, unknown> }> = [];
  const intakeSeen: string[] = [];
  const words = o.dialogue ?? wording();
  const killed = o.killed ?? { v: false };
  const clock = o.clock ?? { offset: 0 };
  const intake = createIntakeEntry({
    registry: createTenantRegistry({ [T]: plumbing }), channelRef: 'channel-founder-phone', now: () => '2026-10-26T12:00:00Z',
    provider: intakeModel(intakeSeen), limits: { maxOutputTokens: 1024, timeoutMs: 2000, maxAttempts: 1 }, founderTest: { tenant: T },
  });
  const handler = createRelayHandler({
    numbers: new Map([[N1, T]]), categoryNames: () => plumbing.categories.map((c: { name: string }) => c.name), intake,
    async intakeContext(tenant, ref) {
      const r = await mintExecutionContext({ credential: 'test', agent: 'intake' }, { verify: () => ({ kind: 'system', id: 'realtime-sim-test' }), selectTenant: () => tenant, grants: () => ['intake:run'], newCorrelationId: () => `corr-${ref}` });
      if (!r.ok) throw new Error('context');
      return r.context;
    },
    dialogue: words.model, store, limits: { maxTurns: o.limits?.maxTurns ?? 30, maxMinutes: o.limits?.maxMinutes ?? 8, maxChars: 4000 }, names: ['Sam Example'], maxCalls: o.maxCalls ?? 50,
    now: () => Date.now() + clock.offset, nowIso: () => '2026-10-26T12:00:00Z', killed: () => killed.v, afterSpeechMs: 0, speechMs: () => 0,
    confirmWaitMs: o.confirmWaitMs ?? 5000, previewBudgetMs: 3000, ...(o.replyRetryMs === undefined ? {} : { replyRetryMs: o.replyRetryMs }), ...(o.replyFirstWordMs === undefined ? {} : { replyFirstWordMs: o.replyFirstWordMs }),
    ...(vault === undefined ? {} : { contacts: vault }), log: (code, detail) => { logs.push({ code, detail }); },
  });
  const calls: RealtimeSim[] = [];
  const newCall = (so: Partial<RigOptions> = {}): RealtimeSim => {
    const sim = createRealtimeSim({ msPerChar: o.mpc ?? MPC, behave: so.behave ?? o.behave, accept: so.accept ?? o.accept, hangupWorks: so.hangupWorks ?? o.hangupWorks });
    handler.serve(createRealtimeTransport(sim.link, { notice: NOTICE, transcriptionModel: 'sim-transcriber', voice: 'sim-voice', msPerChar: o.mpc ?? MPC, endWaitMs: o.endWaitMs ?? 1000 }));
    calls.push(sim);
    return sim;
  };
  const sim = newCall();
  return { sim, newCall, handler, store, vault, logs, words, intakeSeen, killed, clock, path, dirName: dir };
}
type Rig = Awaited<ReturnType<typeof rig>>;
const codes = (r: Rig, code: string) => r.logs.filter((l) => l.code === code);
const has = (r: Rig, code: string) => codes(r, code).length > 0;
const SAYS = (sim: RealtimeSim) => sim.sent.filter((m) => m.type === 'response.create').map((m) => wordsOf(String(m.response.instructions)));
const raw = (x: unknown) => JSON.stringify(x);

/** Starts the call, lets the notice play, and gives consent. The opening question is then the second thing heard. */
async function consent(r: Rig, sim = r.sim, sid = SID(1)) {
  sim.start({ to: N1, callSid: sid });
  await sim.heard(1);
  sim.say('yes I agree');
  await sim.heard(2); await r.handler.idle();
}
/** Gets to the fixed read-back (no contact capture): the notice, the opening, a question, then the read-back. */
async function toReadback(r: Rig, sim = r.sim, sid = SID(1)) {
  await consent(r, sim, sid);
  sim.say('Hi, I have a burst pipe in the kitchen'); await sim.heard(3); await r.handler.idle();
  sim.say('The address is 42 Elm Street'); await sim.heard(4); await r.handler.idle();
}
const READBACK = 'Let me check what I have. Job description: burst pipe. Is that correct? Please say yes or no.';
const ended = async (r: Rig, sim = r.sim) => { await sim.waitFor(() => sim.hungUp); await sim.idle(); await r.handler.idle(); };

// ================================================================ consent
test('consent: the notice is spoken first, exactly, and cannot be talked over; the call logic is not told the call has started until it has played', async () => {
  const r = await rig();
  r.sim.start({ to: N1, callSid: SID(1) });
  await r.sim.waitFor(() => r.sim.playing());
  assert.ok(!has(r, 'CALL_STARTED'), 'no call yet: the notice is still playing');
  await r.sim.heard(1);
  await r.sim.waitFor(() => has(r, 'CALL_STARTED'));
  assert.equal(r.sim.spoken[0], NOTICE);
  assert.deepEqual(r.sim.sent.map((m) => m.type), ['session.update', 'session.update', 'response.create']);
  assert.deepEqual(r.sim.sent.slice(0, 2).map((m) => m.session.audio.input.turn_detection.interrupt_response), [true, false], 'interruption on, then off for the notice, then the request to speak it');
  assert.equal(r.sim.sent[2].response.instructions, `${SPEAK_ONLY} ${SAY_PREFIX}${NOTICE}`, 'every request repeats the speak-only rule, because the instructions of a request may replace those of the session');
  assert.equal(wordsOf(r.sim.sent[2].response.instructions), NOTICE);
  assert.ok(r.sim.sent.filter((m) => m.type === 'session.update').every((m) => m.session.type === 'realtime'), 'every settings update names its session type');
  assert.deepEqual(r.sim.refused, [], 'the stand-in refused nothing the documented schema would refuse');
  assert.equal(r.sim.sent[2].response.conversation, 'none', 'out of band: nothing is added to the voice service\'s own conversation');
  assert.equal(r.sim.sent[0].session.instructions, SPEAK_ONLY);
  assert.equal(r.sim.sent[0].session.audio.input.turn_detection.create_response, false, 'the voice service never replies on its own');
  assert.equal(r.handler.active(), 1);
  r.sim.drop({ cause: 'PEER', code: 1000 }); await r.handler.idle();
});

test('consent: anything the caller says while the notice is playing is not taken, even a yes; only a yes after it has played counts', async () => {
  const r = await rig();
  r.sim.start({ to: N1, callSid: SID(1) });
  await r.sim.waitFor(() => r.sim.playing());
  r.sim.say('yes yes I agree');   // talking over the notice
  await r.sim.heard(1); await r.handler.idle();
  assert.ok(!has(r, 'CONSENT_GRANTED'), 'a yes given before the disclosure was heard is not consent');
  assert.equal(r.sim.sent.filter((m) => m.type === 'response.cancel').length, 0, 'the notice was not cut off');
  assert.equal(r.sim.spoken[0], NOTICE);
  assert.ok(r.sim.sent.some((m) => m.type === 'conversation.item.delete'), 'even that item is deleted from the voice service');
  assert.equal(r.words.calls(), 0);
  r.sim.say('yes I agree'); await r.sim.heard(2); await r.handler.idle();
  assert.ok(has(r, 'CONSENT_GRANTED'));
  r.sim.drop({ cause: 'PEER', code: 1000 }); await r.handler.idle();
});

test('consent: anything but a plain yes ends the call with the fixed goodbye played in full; nothing is kept and no model is contacted', async () => {
  for (const answer of ['no thank you', 'hello?', 'yes but do not process my details']) {
    const r = await rig();
    r.sim.start({ to: N1, callSid: SID(1) });
    await r.sim.heard(1);
    r.sim.say(answer);
    await r.sim.heard(2);
    await ended(r);
    assert.equal(r.sim.spoken[1], SAY.declined);
    assert.ok(r.sim.events.indexOf('hangup') > r.sim.events.indexOf('heard: ' + SAY.declined), 'the goodbye finished before the hang-up');
    assert.deepEqual([r.words.calls(), r.intakeSeen.length, r.store.list(T).length, has(r, 'CONSENT_GRANTED')], [0, 0, 0, false], answer);
  }
});

test('consent: a notice that fails, makes no sound, or is said in other words ends the call before the call logic ever sees it', async () => {
  for (const behave of ['fail', 'silent', { say: 'Hi there, how can I help?' }, 'incomplete'] as const) {
    const r = await rig({ behave: () => behave });
    r.sim.start({ to: N1, callSid: SID(1) });
    await r.sim.waitFor(() => r.sim.hungUp);
    await r.sim.idle(); await r.handler.idle();
    assert.ok(!has(r, 'CALL_STARTED') && !has(r, 'CONSENT_GRANTED'), raw(behave));
    assert.deepEqual([r.words.calls(), r.intakeSeen.length, r.store.list(T).length, r.handler.active()], [0, 0, 0, 0], raw(behave));
    const closed = codes(r, 'CALL_CLOSED')[0]?.detail as Record<string, unknown>;
    assert.deepEqual([closed.by, closed.code], ['PROTOCOL', 1011]);
    r.sim.say('yes');   // a caller who answers anyway is not heard
    await r.sim.idle(); await r.handler.idle();
    assert.ok(!has(r, 'CONSENT_GRANTED'));
  }
});

test('consent: a notice that cannot even be sent ends the call', async () => {
  let ok = true;
  const r = await rig({ accept: () => ok });
  ok = false;
  r.sim.start({ to: N1, callSid: SID(1) });
  await r.sim.waitFor(() => r.sim.hungUp);
  await r.sim.idle(); await r.handler.idle();
  assert.ok(!has(r, 'CALL_STARTED'));
  assert.equal(r.sim.sent.length, 0);
});

// ================================================================ fixed read-backs
test('read-back: the server\'s fixed read-back is requested word for word, never holds the address or a placeholder, and a yes confirms exactly it', async () => {
  const r = await rig();
  await toReadback(r);
  assert.equal(r.sim.spoken[3], READBACK);
  assert.equal(SAYS(r.sim)[3], READBACK, 'the request to speak carries exactly the fixed words');
  assert.ok(!/Elm|\[|ADDRESS/.test(r.sim.spoken[3]));
  r.sim.say('yes that is right');
  await r.sim.heard(5);
  await ended(r);
  assert.equal(r.sim.spoken[4], SAY.thanks);
  const [rec] = r.store.list(T);
  assert.deepEqual([rec.confirmation, rec.handed_off, rec.status, rec.category, rec.turns], ['confirmed', true, 'ready', 'Emergency leak', 3]);
  assert.ok(r.sim.events.indexOf('hangup') > r.sim.events.indexOf('heard: ' + SAY.thanks), 'the closing line was heard in full before the hang-up');
});

test('read-back: the closing line cannot be talked over (interruption is switched off for it) and is heard to the end', async () => {
  const r = await rig();
  await toReadback(r);
  r.sim.say('yes that is right');
  await r.sim.waitFor(() => r.sim.sent.some((m) => m.type === 'response.create' && String(m.response.instructions).endsWith(SAY.thanks)));
  await r.sim.waitFor(() => r.sim.playing());
  r.sim.say('wait wait');   // talking over the goodbye
  await ended(r);
  assert.equal(r.sim.spoken[4], SAY.thanks);
  assert.equal(r.sim.sent.filter((m) => m.type === 'response.cancel').length, 0);
  const at = r.sim.sent.findIndex((m) => m.type === 'response.create' && String(m.response.instructions).endsWith(SAY.thanks));
  assert.equal(r.sim.sent[at - 1].session.audio.input.turn_detection.interrupt_response, false, 'interruption off just before the goodbye');
  assert.equal(r.store.list(T)[0].confirmation, 'confirmed');
});

test('read-back: a read-back said in other words is not a read-back; the caller\'s yes is not taken, and it is said again until it is heard right', async () => {
  let drifted = 0;
  const r = await rig({ behave: (text) => (text === READBACK && drifted++ === 0 ? { say: 'Let me check what I have. Job description: leaking tap. Is that correct? Please say yes or no.' } : 'exact') });
  await consent(r);
  r.sim.say('Hi, I have a burst pipe in the kitchen'); await r.sim.heard(3); await r.handler.idle();
  r.sim.say('The address is 42 Elm Street');
  await r.sim.waitFor(() => has(r, 'REPLY_NOT_PLAYED')); await r.sim.idle(); await r.handler.idle();
  assert.equal(r.sim.spoken.filter((s) => s.includes('leaking tap')).length, 1, 'the caller did hear the wrong words, and the system knows it');
  r.sim.say('yes');   // answers words that were not the read-back
  await r.sim.heard(4); await r.handler.idle();
  assert.ok(has(r, 'READBACK_NOT_HEARD'));
  assert.equal(r.store.list(T).length, 0, 'nothing was confirmed');
  assert.equal(SAYS(r.sim).filter((s) => s === READBACK).length, 2, 'said again');
  r.sim.say('yes that is right'); await r.sim.heard(5); await ended(r);
  assert.equal(r.store.list(T)[0].confirmation, 'confirmed');
});

test('read-back: if it is never heard right, the call ends unconfirmed after the same two read-backs as ever', async () => {
  const r = await rig({ behave: (text) => (text === READBACK ? 'silent' : 'exact') });
  await consent(r);
  r.sim.say('Hi, I have a burst pipe in the kitchen'); await r.sim.heard(3); await r.handler.idle();
  r.sim.say('The address is 42 Elm Street');
  await r.sim.waitFor(() => codes(r, 'REPLY_NOT_PLAYED').length === 1); await r.sim.idle(); await r.handler.idle();
  r.sim.say('yes'); await r.sim.waitFor(() => codes(r, 'REPLY_NOT_PLAYED').length === 2); await r.sim.idle(); await r.handler.idle();
  r.sim.say('yes'); await r.sim.heard(4); await ended(r);
  assert.equal(r.sim.spoken[3], SAY.unconfirmed);
  const [rec] = r.store.list(T);
  assert.deepEqual([rec.confirmation, rec.handed_off, rec.status, rec.reasons.includes('not_confirmed')], ['unconfirmed', false, 'needs-human', true]);
  assert.equal(codes(r, 'READBACK').length, 2);
});

test('read-back with contact capture: the callback number is requested digit for digit, a digit said wrong is caught, and a numeral said as a word is accepted', async () => {
  const NUMBER = '5 5 5 0 1 0 0 1 9 9';
  for (const mode of ['words', 'wrong', 'exact'] as const) {
    let seen = 0;
    const r = await rig({
      contacts: true,
      behave: (text) => {
        if (!text.includes('callback number')) return 'exact';
        if (seen++ > 0) return 'exact';
        return mode === 'wrong' ? { say: text.replace('0 1 9 9', '0 1 9 8') } : mode;
      },
    });
    await consent(r);
    r.sim.say('Hi, my name is Sam Example and I have a burst pipe in the kitchen'); await r.sim.heard(3); await r.handler.idle();
    r.sim.say('The address is 42 Elm Street, you can reach me on 555 010 0199');
    await r.sim.waitFor(() => r.sim.sent.some((m) => m.type === 'response.create' && String(m.response.instructions).includes('callback number')));
    await r.sim.idle(); await r.handler.idle();
    const asked = SAYS(r.sim).filter((s) => s.includes('callback number'));
    assert.ok(asked[0].includes(`Your callback number: ${NUMBER}.`), 'the number is requested digit for digit: ' + mode);
    assert.equal(has(r, 'REPLY_NOT_PLAYED'), mode === 'wrong', mode);
    r.sim.drop({ cause: 'PEER', code: 1000 }); await r.handler.idle();
  }
});

test('read-back: a read-back that could not be sent is not confirmed by a yes; the same words are sent again and only a yes to what was sent confirms', async () => {
  let ok = true;
  const r = await rig({ accept: () => ok });
  await consent(r);
  r.sim.say('Hi, I have a burst pipe in the kitchen'); await r.sim.heard(3); await r.handler.idle();
  ok = false;
  r.sim.say('The address is 42 Elm Street');
  await r.sim.waitFor(() => has(r, 'READBACK_NOT_SENT'));
  ok = true; await r.sim.idle(); await r.handler.idle();
  assert.equal(r.sim.spoken.filter((s) => s === READBACK).length, 0, 'the caller heard nothing');
  r.sim.say('yes');   // a yes to words nobody heard
  await r.sim.heard(4); await r.handler.idle();
  assert.equal(r.sim.spoken[3], READBACK);
  assert.ok(has(r, 'READBACK_NOT_HEARD'));
  assert.equal(r.store.list(T).length, 0);
  r.sim.say('yes that is right'); await r.sim.heard(5); await ended(r);
  assert.equal(r.store.list(T)[0].confirmation, 'confirmed');
});

// ================================================================ masking boundaries
test('masking boundary: the raw transcript reaches the call logic only; nothing sent to the voice service holds a caller detail except the fixed words it is asked to speak', async () => {
  const r = await rig({ contacts: true });
  await consent(r);
  r.sim.say('Hi, my name is Sam Example and I have a burst pipe in the kitchen'); await r.sim.heard(3); await r.handler.idle();
  r.sim.say('The address is 42 Elm Street, you can reach me on 555 010 0199'); await r.sim.waitFor(() => SAYS(r.sim).some((s) => s.includes('callback number'))); await r.sim.idle(); await r.handler.idle();
  const everything = raw(r.sim.sent);
  for (const m of r.sim.sent) {
    if (m.type === 'response.create') continue;
    for (const s of SECRETS) assert.ok(!raw(m).includes(s), `${m.type} must not contain "${s}"`);
  }
  // The read-back is the one place the number is spoken, because the caller is read it back over the phone.
  assert.equal(SAYS(r.sim).filter((s) => s.includes('5 5 5 0 1 0 0 1 9 9')).length, 1);
  assert.ok(!everything.includes('Sam Example') && !everything.includes('Elm Street'), 'neither the name nor the address was spoken back yet');
  assert.ok(r.sim.sent.filter((m) => m.type === 'conversation.item.delete').length >= 3, 'every transcript item is deleted from the voice service');
  assert.ok(r.sim.sent.every((m) => m.type !== 'input_audio_buffer.append'), 'the adapter never sends audio');
  assert.ok(r.sim.sent.filter((m) => m.type === 'response.create').every((m) => m.response.conversation === 'none'));
  // What the Intake model and the dialogue model saw was masked.
  const modelSaw = r.intakeSeen.join('') + raw(r.words.turns);
  for (const s of ['Sam Example', 'Elm Street', '555 010 0199', 'Sam']) assert.ok(!modelSaw.includes(s), `a model saw "${s}"`);
  assert.ok(modelSaw.includes('[PERSON_1]') && modelSaw.includes('[ADDRESS_1]'));
  for (const s of SECRETS) assert.ok(!raw(r.logs).includes(s), `the logs must not contain "${s}"`);
  r.sim.drop({ cause: 'PEER', code: 1000 }); await r.handler.idle();
  const files = readdirSync(dir).filter((f) => f.startsWith(`calls${dbn}`)).map((f) => readFileSync(join(dir, f)).toString('latin1')).join('');
  for (const s of SECRETS) assert.ok(!files.includes(s), `the records must not contain "${s}"`);
});

test('masking boundary: an utterance that cannot be masked cleanly is refused; the call ends with the fixed apology and nothing raw is kept', async () => {
  const r = await rig();
  await consent(r);
  r.sim.say('my number is 3. 7. one. six. three. 4. 4. 1 street');
  await r.sim.heard(3); await ended(r);
  assert.ok(has(r, 'UTTERANCE_REFUSED'));
  assert.equal(r.sim.spoken[2], SAY.trouble);
  assert.ok(!raw(r.logs).includes('one. six') && !r.intakeSeen.join('').includes('one. six'));
  assert.equal(r.store.list(T).length, 0, 'no caller line was accepted, so nothing is saved');
});

// ================================================================ interruptions
test('interruption: a caller who talks over a question stops it; only the words actually spoken stay in the history, and the caller\'s words are taken as the next turn', async () => {
  const r = await rig({ mpc: 10 });
  await consent(r);
  r.sim.say('Hi, I have a burst pipe in the kitchen');
  await r.sim.waitFor(() => r.sim.playing());   // the question is playing
  r.sim.say('it is in the kitchen', { playedMs: 11 * 10 });   // 11 characters in: "Could you t"
  await r.sim.idle(); await r.handler.idle();
  assert.equal(r.sim.sent.filter((m) => m.type === 'response.cancel').length, 1);
  assert.equal(r.sim.sent.filter((m) => m.type === 'response.create').length, 4, 'the notice, the opening, the interrupted question, and the next question');
  assert.equal(r.sim.spoken.length, 3, 'the interrupted question was not heard to the end: the notice, the opening and the next question were');
  assert.equal(codes(r, 'REPLY_NOT_PLAYED').length, 0, 'an interruption is not a failure');
  const next = r.words.turns[r.words.turns.length - 1];
  const spokenPart = next.filter((t) => t.role === 'assistant').pop();
  assert.equal(spokenPart?.text, 'Could you', 'the history keeps only the words that were spoken, cut at a word');
  assert.ok(next.some((t) => t.role === 'user' && /kitchen/.test(t.text)));
  const closed = (r.sim.drop({ cause: 'PEER', code: 1000 }), await r.handler.idle(), codes(r, 'CALL_CLOSED')[0].detail as Record<string, number>);
  assert.equal(closed.interrupts, 1);
});

test('interruption: when the phone layer reports no played time the question counts as not heard, and nothing of it stays in the history', async () => {
  const r = await rig({ mpc: 10 });
  await consent(r);
  r.sim.say('Hi, I have a burst pipe in the kitchen');
  await r.sim.waitFor(() => r.sim.playing());
  r.sim.say('hello?', { playedMs: 0 });
  await r.sim.idle(); await r.handler.idle();
  const next = r.words.turns[r.words.turns.length - 1];
  assert.equal(next.filter((t) => t.role === 'assistant').pop()?.text, OPENING, 'the interrupted question is gone; only the opening remains');
  r.sim.drop({ cause: 'PEER', code: 1000 }); await r.handler.idle();
});

test('interruption: a question queued behind a reply that the caller talks over is dropped, so nothing is spoken over the caller', async () => {
  const sim = createRealtimeSim({ msPerChar: 10 });
  const events: TransportEvent[] = [];
  const t = createRealtimeTransport(sim.link, { notice: NOTICE, transcriptionModel: 'x', voice: 'y', msPerChar: 10 });
  t.onEvent = (e) => { events.push(e); };
  sim.start({ to: N1, callSid: SID(1) }); await sim.heard(1);
  assert.equal(t.speak('First long enough reply to be interrupted', true), true);
  assert.equal(t.speak('Second reply that waits its turn', true), true);
  await sim.waitFor(() => sim.playing());
  sim.say('stop', { playedMs: 8 * 10 });
  await sim.idle();
  assert.deepEqual(events.map((e) => e.kind), ['setup', 'interrupt', 'utterance']);
  assert.equal(sim.spoken.length, 1, 'neither the first reply nor the queued one was heard');
  assert.equal(SAYS(sim).length, 2, 'the second was never requested');
});

// ================================================================ silence
test('silence: a caller who goes quiet after the read-back gets the fixed goodbye and the request is saved unconfirmed', async () => {
  const r = await rig({ confirmWaitMs: 150 });
  await toReadback(r);
  await r.sim.heard(5); await ended(r);
  assert.equal(r.sim.spoken[4], SAY.silence);
  assert.ok(has(r, 'CONFIRM_TIMEOUT'));
  const [rec] = r.store.list(T);
  assert.deepEqual([rec.confirmation, rec.handed_off], ['unconfirmed', false]);
});

test('silence: a question that produces no sound, or fails, is not treated as asked; the next turn asks again and a plain yes is not an answer to it', async () => {
  for (const behave of ['silent', 'fail', 'incomplete'] as const) {
    let questions = 0;
    const r = await rig({ behave: (text) => (text.startsWith('Could you tell me') && questions++ === 0 ? behave : 'exact') });
    await consent(r);
    r.sim.say('Hi, I have a burst pipe in the kitchen');
    await r.sim.waitFor(() => has(r, 'REPLY_NOT_PLAYED')); await r.sim.idle(); await r.handler.idle();
    assert.equal(r.sim.spoken.filter((s) => s.startsWith('Could you tell me')).length, 0, behave);
    assert.equal(codes(r, 'REPLY_SENT').length, 2, 'the call logic counted the words as produced and sent');
    r.sim.say('hello?'); await r.sim.heard(3); await r.handler.idle();
    assert.ok(r.sim.spoken[2].startsWith('Could you tell me'), 'asked again: ' + behave);
    const closed = (r.sim.drop({ cause: 'PEER', code: 1000 }), await r.handler.idle(), codes(r, 'CALL_CLOSED')[0].detail as Record<string, number>);
    assert.equal(closed.failed_sends, 1, 'the unplayed reply is counted');
  }
});

test('silence: when the model produces no words, the existing recovery speaks the fixed question through the voice service', async () => {
  const words = wording((n) => n === 2 || n === 3);   // the first question comes up empty twice
  const r = await rig({ dialogue: words });
  await consent(r);
  r.sim.say('Hi, I have a burst pipe in the kitchen');
  await r.sim.heard(3); await r.handler.idle();
  assert.equal(r.sim.spoken[2], fallbackText({ kind: 'ask', field: 'Address' }));
  assert.deepEqual(['REPLY_EMPTY', 'REPLY_RETRY', 'REPLY_FALLBACK_SENT'].map((c) => codes(r, c).length), [2, 1, 1]);
  r.sim.drop({ cause: 'PEER', code: 1000 }); await r.handler.idle();
});

// ================================================================ failed sends
test('failed sends: a reply that cannot be sent is counted, the question is not marked asked, and the call recovers when sends work again', async () => {
  let ok = true;
  const r = await rig({ accept: () => ok });
  await consent(r);
  ok = false;
  r.sim.say('Hi, I have a burst pipe in the kitchen');
  await r.sim.waitFor(() => has(r, 'REPLY_SEND_FAILED'));
  ok = true; await r.sim.idle(); await r.handler.idle();
  assert.equal(r.sim.spoken.length, 2, 'the question never reached the caller');
  r.sim.say('hello?'); await r.sim.heard(3); await r.handler.idle();
  const closed = (r.sim.drop({ cause: 'PEER', code: 1000 }), await r.handler.idle(), codes(r, 'CALL_CLOSED')[0].detail as Record<string, number>);
  assert.equal(closed.failed_sends, 1);
});

test('failed sends: if even the fixed question cannot be sent, the request so far is saved unconfirmed and the call is hung up', async () => {
  let ok = true;
  const words = wording((n) => n >= 2);   // the model comes up empty from the second call on
  const r = await rig({ accept: () => ok, dialogue: words });
  await consent(r);
  ok = false;
  r.sim.say('Hi, I have a burst pipe in the kitchen');
  await r.sim.waitFor(() => has(r, 'REPLY_FALLBACK_FAILED'));
  await r.sim.waitFor(() => r.sim.hungUp); await r.handler.idle();
  const [rec] = r.store.list(T);
  assert.ok(rec, 'saved');
  assert.deepEqual([rec.confirmation, rec.handed_off, rec.status, rec.category], ['unconfirmed', false, 'needs-human', 'Emergency leak']);
  assert.equal(r.handler.active(), 0);
});

test('failed sends: a hang-up that cannot be made is reported, not hidden, and the connection is still closed', async () => {
  const r = await rig({ hangupWorks: () => false });
  r.sim.start({ to: N1, callSid: SID(1) }); await r.sim.heard(1);
  r.sim.say('no'); await r.sim.heard(2);
  await r.sim.waitFor(() => r.sim.closeCodes.length > 0 || codes(r, 'CALL_CLOSED').length > 0);
  await r.sim.idle(); await r.handler.idle();
  assert.equal(r.sim.hungUp, false);
  const closed = codes(r, 'CALL_CLOSED')[0]?.detail as Record<string, number> | undefined;
  assert.ok(closed === undefined || closed.failed_sends >= 1);
});

// ================================================================ existing call limits
test('limits: the turn cap ends the call with the fixed line and saves what was said, unconfirmed', async () => {
  const r = await rig({ limits: { maxTurns: 2 } });
  await consent(r);
  r.sim.say('Hi, I have a burst pipe in the kitchen'); await r.sim.heard(3); await r.handler.idle();
  r.sim.say('it is in the kitchen'); await r.sim.heard(4); await r.handler.idle();
  r.sim.say('and it is flooding'); await r.sim.heard(5); await ended(r);
  assert.equal(r.sim.spoken[4], SAY.limit);
  const [rec] = r.store.list(T);
  assert.deepEqual([rec.confirmation, rec.handed_off, rec.turns], ['unconfirmed', false, 2]);
});

test('limits: the time cap ends the call with the fixed line', async () => {
  const r = await rig({ limits: { maxMinutes: 1 } });
  await consent(r);
  r.sim.say('Hi, I have a burst pipe in the kitchen'); await r.sim.heard(3); await r.handler.idle();
  r.clock.offset = 61_000;
  r.sim.say('it is in the kitchen'); await r.sim.heard(4); await ended(r);
  assert.equal(r.sim.spoken[3], SAY.limit);
  assert.equal(r.store.list(T)[0].confirmation, 'unconfirmed');
});

test('limits: the kill switch ends the call with the fixed unavailable line and saves nothing', async () => {
  const r = await rig();
  await consent(r);
  r.killed.v = true;
  r.sim.say('Hi, I have a burst pipe in the kitchen'); await r.sim.heard(3); await ended(r);
  assert.equal(r.sim.spoken[2], SAY.unavailable);
  assert.equal(r.store.list(T).length, 0);
});

test('limits: an unknown number is turned away (after the notice has played, which is a cost of this carrier) and no session is made', async () => {
  const r = await rig();
  r.sim.start({ to: '+15555550999', callSid: SID(1) });
  await r.sim.heard(1);
  await ended(r);
  assert.ok(has(r, 'SETUP_REFUSED') && !has(r, 'CALL_STARTED'));
  assert.deepEqual([r.words.calls(), r.intakeSeen.length, r.store.list(T).length], [0, 0, 0]);
});

test('limits: only one call at a time, and a call id is never reused', async () => {
  const r = await rig();
  await consent(r);                                    // call 1 is active
  const second = r.newCall();
  second.start({ to: N1, callSid: SID(2) }); await second.heard(1);
  await ended(r, second);
  assert.ok(has(r, 'BUSY'), 'a second call while one is running is turned away');
  r.sim.drop({ cause: 'PEER', code: 1000 }); await r.handler.idle();
  const replay = r.newCall();
  replay.start({ to: N1, callSid: SID(1) }); await replay.heard(1);
  await ended(r, replay);
  assert.ok(has(r, 'REPLAY'), 'the same call id again is turned away');
  assert.equal(codes(r, 'CALL_STARTED').length, 1);
});

test('limits: the budget of calls is enforced', async () => {
  const r = await rig({ maxCalls: 1 });
  await consent(r);
  r.sim.drop({ cause: 'PEER', code: 1000 }); await r.handler.idle();
  const next = r.newCall();
  next.start({ to: N1, callSid: SID(2) }); await next.heard(1);
  await ended(r, next);
  assert.ok(has(r, 'CALL_BUDGET'));
  assert.equal(codes(r, 'CALL_STARTED').length, 1);
});

test('limits: a hang-up by the caller mid-call saves what was said, unconfirmed, and the close is logged once', async () => {
  const r = await rig();
  await consent(r);
  r.sim.say('Hi, I have a burst pipe in the kitchen'); await r.sim.heard(3); await r.handler.idle();
  r.sim.drop({ cause: 'PEER', code: 1000 }); await r.sim.idle(); await r.handler.idle();
  assert.equal(codes(r, 'CALL_CLOSED').length, 1);
  const [rec] = r.store.list(T);
  assert.deepEqual([rec.confirmation, rec.handed_off], ['unconfirmed', false]);
  assert.equal(r.handler.active(), 0);
});

// ================================================================ the adapter on its own
test('adapter: each voice-service event becomes one normalised event, and nothing is taken before the notice has played', async () => {
  const sim = createRealtimeSim({ msPerChar: MPC });
  const events: TransportEvent[] = [];
  const t = createRealtimeTransport(sim.link, { notice: NOTICE, transcriptionModel: 'x', voice: 'y', msPerChar: MPC });
  t.onEvent = (e) => { events.push(e); };
  sim.link.onMessage({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'early', transcript: 'before anything' });
  sim.link.onMessage({ type: 'carrier.start', to: N1, callSid: SID(1) });
  sim.link.onMessage({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'during', transcript: 'during the notice' });
  assert.deepEqual(events, [], 'no setup before the notice, and nothing said before it is taken');
  await sim.heard(1); await sim.idle();
  assert.deepEqual(events, [{ kind: 'setup', to: N1, callSid: SID(1) }]);
  sim.link.onMessage({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'a house with two bedrooms' });
  sim.link.onMessage({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'b', transcript: '   ' });
  sim.link.onMessage({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'c', delta: 'a' });
  sim.link.onMessage({ type: 'error', error: { message: 'CANARY-SERVICE-TEXT' } });
  sim.link.onMessage({ type: 'rate_limits.updated' }); sim.link.onMessage({ type: 'x.unknown.event' });
  sim.link.onMessage('nonsense'); sim.link.onMessage(null); sim.link.onMessage({ type: 5 });
  assert.deepEqual(events.slice(1), [{ kind: 'utterance', text: 'a house with two bedrooms' }, { kind: 'partial' }, { kind: 'partial' }, { kind: 'error' }, { kind: 'other' }, { kind: 'malformed' }, { kind: 'malformed' }, { kind: 'malformed' }]);
  assert.ok(!raw(events).includes('CANARY'), 'the service\'s own error text is never passed on');
  assert.equal(sim.sent.filter((m) => m.type === 'conversation.item.delete').length, 4, 'every transcript item is deleted, early ones included');
});

test('adapter: replies are spoken in order, one at a time, and a hang-up waits for the reply that is still playing, then closes', async () => {
  const sim = createRealtimeSim({ msPerChar: MPC });
  const t = createRealtimeTransport(sim.link, { notice: NOTICE, transcriptionModel: 'x', voice: 'y', msPerChar: MPC, endWaitMs: 2000 });
  t.onEvent = () => {};
  sim.start({ to: N1, callSid: SID(1) }); await sim.heard(1);
  assert.equal(t.speak('One. ', false), true); assert.equal(t.speak('Two.', true), true);
  assert.equal(t.speak('Three.', true), true);
  assert.equal(t.endCall(), true); t.close(1000);
  assert.equal(sim.hungUp, false, 'still speaking');
  await sim.waitFor(() => sim.hungUp);
  assert.deepEqual(sim.spoken.slice(1), ['One. Two.', 'Three.']);
  assert.deepEqual(sim.events.slice(-4), ['heard: One. Two.', 'heard: Three.', 'hangup', 'close']);
  assert.deepEqual(sim.closeCodes, [1000]);
  assert.equal(t.speak('after the end', true), false);
});

test('adapter: a hang-up does not wait forever for a reply that never finishes', async () => {
  const sim = createRealtimeSim({ msPerChar: 1000 });
  const t = createRealtimeTransport(sim.link, { notice: NOTICE, transcriptionModel: 'x', voice: 'y', msPerChar: 1000, endWaitMs: 80 });
  t.onEvent = () => {};
  sim.link.onMessage({ type: 'carrier.start', to: N1, callSid: SID(1) });
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(t.endCall(), true);
  await sim.waitFor(() => sim.hungUp, 1000);
});

test('adapter: sameSpeech ignores case, punctuation and spacing and accepts a digit said as a word, but nothing else', () => {
  assert.ok(sameSpeech('Your callback number: 5 5 5 0 1 0 0 1 9 9.', 'your callback number five five five oh one zero zero one nine nine'));
  assert.ok(sameSpeech('Is that correct? Please say yes or no.', 'is that correct please say yes or no'));
  assert.ok(!sameSpeech('Your callback number: 5 5 5 0 1 0 0 1 9 9.', 'Your callback number: 5 5 5 0 1 0 0 1 9 8.'));
  assert.ok(!sameSpeech('Job description: burst pipe.', 'Job description: leaking pipe.'));
  assert.ok(!sameSpeech('Is that correct?', ''), 'nothing said is never a match');
  assert.ok(!sameSpeech('', ''));
});

test('adapter: the options are validated, and there is no default model or voice', () => {
  const link = createRealtimeSim().link;
  for (const bad of [{}, { notice: '', transcriptionModel: 'x', voice: 'y' }, { notice: 'n', voice: 'y' }, { notice: 'n', transcriptionModel: 'x' }, { notice: 'n', transcriptionModel: 'x', voice: 'y', msPerChar: 0 }, { notice: 'n', transcriptionModel: 'x', voice: 'y', endWaitMs: 100000 }, null]) {
    assert.throws(() => createRealtimeTransport(link, bad as never), RangeError, raw(bad));
  }
});

// ================================================================ boundaries of the files themselves
test('boundary: the adapter imports only local files, holds no credential or network access, and nothing in src imports it yet; the call logic names no voice-service event', () => {
  const src = (n: string) => readFileSync(new URL(`../src/${n}.ts`, import.meta.url), 'utf8');
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const adapter = code(src('realtime-transport'));
  const imports = [...adapter.matchAll(/^import[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]);
  for (const spec of imports) assert.ok(spec.startsWith('./'), `unexpected import: ${spec}`);
  for (const banned of [/\bfetch\s*\(/, /process\./, /node:/, /console\./, /api[_-]?key/i, /authorization/i, /https?:\/\//, /wss?:\/\//, /from\s+'openai'/, /require\s*\(/, /\beval\s*\(/, /new Function/, /input_audio_buffer\.append/]) {
    assert.ok(!banned.test(adapter), `banned pattern in the adapter: ${banned}`);
  }
  for (const f of readdirSync(new URL('../src/', import.meta.url)).filter((n) => n.endsWith('.ts') && n !== 'realtime-transport.ts' && n !== 'realtime-bridge.ts')) {   // the bridge (offline, itself unused) is the one file that joins it to a phone and a voice socket
    assert.ok(!/realtime-transport/.test(code(readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'))), `${f} must not import the Realtime adapter yet`);
  }
  const handler = code(src('relay-handler'));
  for (const name of ['response.create', 'response.done', 'speech_started', 'session.update', 'conversation.item', 'carrier.start', 'x_played_ms']) assert.ok(!handler.includes(name), `relay-handler.ts must not name ${name}`);
});
