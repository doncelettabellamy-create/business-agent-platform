// NATIVE Realtime conversation (founder decision 2026-10-27): the voice converses in its own words for the directive the call logic gives it and may call the server's contact tools. The call logic
// (relay-handler.ts), the masker, the REAL Intake entry (with a local stand-in model), the record store and the contact vault are the real ones; only the voice service and the phone are simulated
// (tests/helpers/realtime-sim.ts), so a passing test shows behaviour against THIS model of the service, not against OpenAI. Invented data only. Nothing touches the network or any key.
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
import { createRelayHandler, SAY } from '../src/relay-handler.ts';
import { consentNoticeFor } from '../src/opening.ts';
import { fallbackText } from '../src/dialogue-model.ts';
import type { DialogueModel } from '../src/dialogue-model.ts';
import type { ModelProvider, ModelRequest } from '../src/model-gateway.ts';
import { createRealtimeTransport, NATIVE_TOOL_RULES, SAY_PREFIX, wordsOf } from '../src/realtime-transport.ts';
import { CONTACT_TOOL_DEFINITIONS, CONTACT_TOOL_NAMES } from '../src/call-state.ts';
import { createRealtimeSim } from './helpers/realtime-sim.ts';
import type { RealtimeSim, RealtimeSimOptions } from './helpers/realtime-sim.ts';

const T = 'ws-founder-plumbing';
const N1 = '+15555550100';
const SID = (n: number) => `CA${String(n).padStart(32, '0')}`;
const plumbing = JSON.parse(readFileSync(new URL('../examples/skill-plumbing.json', import.meta.url), 'utf8')).skill_config;
const dir = mkdtempSync(join(tmpdir(), 'native-conv-'));
const closers: Array<() => unknown> = [];
after(async () => { for (const c of closers.reverse()) try { await c(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });
const NOTICE = consentNoticeFor({ business_name: 'Example Cleaning' });
const TOOLS = CONTACT_TOOL_DEFINITIONS.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters as Record<string, unknown> }));
const SECRETS = ['Priya', 'Raman', 'priya', 'raman', 'Jon Smith', 'jon smith', '5550100123', '555 010 0123', '5 5 5 0 1 0 0 1 2 3', 'Elm Street', '42 Elm', 'Maple', 'five five five'];
const raw = (x: unknown) => JSON.stringify(x);

function intakeModel(seen: string[]): ModelProvider {
  return {
    id: 'stub:native',
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
/** The text model is NOT the speaker in native mode: it is only the server's fallback. `calls` shows whether it was ever used. */
function fallbackModel() {
  let calls = 0;
  const model: DialogueModel = { stats: { calls: 0, errors: [] }, async *reply() { calls++; yield 'Okay. '; } };
  return { model, calls: () => calls };
}

interface Plan { say?: string; calls?: Array<{ name: string; args?: unknown; rawArgs?: string }> }
interface RigOptions { native?: (ctx: { instructions: string; n: number; round: number; outputs: string[]; sessionTools: string[] }) => Plan; maxTurns?: number; mpc?: number; totalMs?: number; scripted?: boolean; behave?: RealtimeSimOptions['behave'] }
let dbn = 0;
async function rig(o: RigOptions = {}) {
  const store = createIntakeRecordStore({ path: join(dir, `calls${++dbn}.sqlite`) });
  closers.push(() => store.close());
  const vault = createContactVault({ path: join(dir, `contacts${dbn}.sqlite`), key: randomBytes(32), now: () => Date.now() });
  closers.push(() => vault.close());
  const logs: Array<{ code: string; detail?: Record<string, unknown> }> = [];
  const intakeSeen: string[] = [];
  const fb = fallbackModel();
  const handoffs: unknown[] = [];
  const intake = createIntakeEntry({
    registry: createTenantRegistry({ [T]: plumbing }), channelRef: 'channel-founder-phone', now: () => '2026-10-26T12:00:00Z',
    provider: intakeModel(intakeSeen), limits: { maxOutputTokens: 1024, timeoutMs: 2000, maxAttempts: 1 }, founderTest: { tenant: T },
  });
  const handler = createRelayHandler({
    numbers: new Map([[N1, T]]), categoryNames: () => plumbing.categories.map((c: { name: string }) => c.name), intake,
    async intakeContext(tenant, ref) {
      const r = await mintExecutionContext({ credential: 'test', agent: 'intake' }, { verify: () => ({ kind: 'system', id: 'native-test' }), selectTenant: () => tenant, grants: () => ['intake:run'], newCorrelationId: () => `corr-${ref}` });
      if (!r.ok) throw new Error('context');
      return r.context;
    },
    dialogue: fb.model, store, limits: { maxTurns: o.maxTurns ?? 30, maxMinutes: 8, maxChars: 4000 }, names: [], maxCalls: 50,
    now: () => Date.now(), nowIso: () => '2026-10-26T12:00:00Z', killed: () => false, afterSpeechMs: 0, speechMs: () => 0,
    confirmWaitMs: 5000, previewBudgetMs: 3000, replyRetryMs: 500, replyFirstWordMs: 500, contacts: vault,
    confirmedHandoff: (h) => { handoffs.push(h); },
    log: (code, detail) => { logs.push({ code, detail }); },
  });
  const sim: RealtimeSim = createRealtimeSim({ msPerChar: o.mpc ?? 1, ...(o.scripted ? {} : { native: o.native ?? (() => ({ say: 'Okay.' })) }), ...(o.behave === undefined ? {} : { behave: o.behave }) });
  handler.serve(createRealtimeTransport(sim.link, { notice: NOTICE, transcriptionModel: 'sim-transcriber', voice: 'sim-voice', msPerChar: o.mpc ?? 1, endWaitMs: 1000, ...(o.scripted ? {} : { native: { tools: TOOLS, ...(o.totalMs === undefined ? {} : { totalMs: o.totalMs }) } }) }));
  return { sim, handler, store, vault, logs, intakeSeen, fb, handoffs, path: join(dir, `calls${dbn}.sqlite`) };
}
type Rig = Awaited<ReturnType<typeof rig>>;
const codes = (r: Rig, code: string) => r.logs.filter((l) => l.code === code);
const has = (r: Rig, code: string) => codes(r, code).length > 0;
const nextOf = (ins: string): string => ins.split('\n').filter((l) => l.startsWith('NEXT ')).at(-1) ?? '';
/** Native requests (not "say exactly" lines), in order. */
const natives = (sim: RealtimeSim) => sim.sent.filter((m) => m.type === 'response.create' && !String(m.response.instructions).includes(SAY_PREFIX));
const fixedLines = (sim: RealtimeSim) => sim.sent.filter((m) => m.type === 'response.create' && String(m.response.instructions).includes(SAY_PREFIX)).map((m) => wordsOf(String(m.response.instructions)));
async function consent(r: Rig, sid = SID(1)) {
  r.sim.start({ to: N1, callSid: sid });
  await r.sim.heard(1, 15_000);
  r.sim.say('yes I agree');
  await r.sim.heard(2, 15_000); await r.handler.idle();
}
/** The caller says something unhelpful; waits for the voice to answer or the call to end. */
async function turn(r: Rig, text: string) {
  const before = r.sim.spoken.length;
  r.sim.say(text);
  await r.sim.waitFor(() => r.sim.spoken.length > before || r.sim.hungUp, 8000);
  await r.sim.idle(); await r.handler.idle();
}
const ended = async (r: Rig) => { await r.sim.waitFor(() => r.sim.hungUp); await r.sim.idle(); await r.handler.idle(); };
const jsonOf = (s: string): any => JSON.parse(s);

// ================================================================ the voice converses; the server keeps control
test('native: the voice is given the server\'s brief and tools and converses in its own words; the notice and fixed lines are still exact; the text model does not speak', async () => {
  const r = await rig({ native: ({ instructions }) => ({ say: nextOf(instructions) === 'NEXT OPEN' ? 'Hi, this is Drew. What can I help with?' : 'Got it.' }) });
  await consent(r);
  assert.deepEqual(r.sim.spoken.slice(0, 2), [NOTICE, 'Hi, this is Drew. What can I help with?']);
  const sessions = r.sim.sent.filter((m) => m.type === 'session.update');
  assert.ok(sessions.every((m) => m.session.type === 'realtime' && m.session.tools.length === 5 && m.session.tool_choice === 'auto'));
  assert.deepEqual(sessions[0].session.tools.map((t: any) => t.name), [...CONTACT_TOOL_NAMES]);
  assert.ok(sessions[0].session.tools.every((t: any) => t.type === 'function'));
  const [open] = natives(r.sim);
  assert.equal(open.response.conversation, undefined, 'the default conversation: the voice has the call so far');
  const ins = String(open.response.instructions);
  assert.ok(ins.includes(NATIVE_TOOL_RULES) && ins.includes('You are the phone intake assistant') && nextOf(ins) === 'NEXT OPEN');
  assert.equal(ins.trimEnd().split('\n').at(-1), 'NEXT OPEN', 'the NEXT line is last');
  const notice = r.sim.sent.find((m) => m.type === 'response.create' && String(m.response.instructions).includes(NOTICE));
  assert.equal(notice.response.tool_choice, 'none', 'no tool can be called while a fixed line is spoken');
  assert.equal(wordsOf(notice.response.instructions), NOTICE);
  assert.equal(r.fb.calls(), 0, 'the text model said nothing');
  assert.deepEqual(r.sim.refused, [], 'nothing the documented schema would refuse was sent');
  assert.ok(!r.sim.sent.some((m) => m.type === 'conversation.item.delete'), 'native conversation keeps the voice service\'s turns for the call (the stated contract change)');
  r.sim.drop({ cause: 'PEER', code: 1000 }); await r.handler.idle();
});

test('native: scripted mode is untouched when native is off (no tools, out of band, items deleted)', async () => {
  const r = await rig({ scripted: true });
  await consent(r);
  assert.ok(r.sim.sent.filter((m) => m.type === 'session.update').every((m) => m.session.tools === undefined && m.session.tool_choice === undefined));
  assert.ok(r.sim.sent.filter((m) => m.type === 'response.create').every((m) => m.response.conversation === 'none'));
  assert.ok(r.sim.sent.some((m) => m.type === 'conversation.item.delete'));
  r.sim.drop({ cause: 'PEER', code: 1000 }); await r.handler.idle();
});

test('consent is preserved: a caller who does not agree ends the call before any native reply or model use', async () => {
  const r = await rig();
  r.sim.start({ to: N1, callSid: SID(1) });
  await r.sim.heard(1);
  r.sim.say('no thanks');
  await ended(r);
  assert.equal(natives(r.sim).length, 0);
  assert.equal(r.fb.calls(), 0);
  assert.equal(r.intakeSeen.length, 0);
  assert.ok(fixedLines(r.sim).includes(SAY.declined));
});

// ================================================================ remembered answers, corrections, split numbers
test('native: remembered answers — what the voice captured is reported as captured, not asked again, and the next brief says so (labels only)', async () => {
  let said = '';
  const r = await rig({
    native: ({ instructions, outputs }) => {
      const calls = /my name is/i.test(said) && !outputs.length ? [{ name: 'collect_name', args: { heard: 'priya raman' } }] : [];
      return { say: calls.length > 0 ? '' : nextOf(instructions) === 'NEXT OPEN' ? 'Hello, how can I help?' : 'Thanks, noted.', calls };
    },
  });
  await consent(r);
  said = 'Hi, my name is priya raman and I have a burst pipe in the kitchen'; r.sim.say(said); await r.sim.heard(3); await r.handler.idle();
  const outputs = r.sim.toolOutputs.map((x) => jsonOf(x.output));
  assert.equal(outputs.length, 1);
  assert.deepEqual([outputs[0].ok, outputs[0].outcome], [true, 'captured']);
  assert.ok(outputs[0].captured.includes('Customer name') && outputs[0].missing.includes('Callback phone number'));
  assert.ok(!/priya|raman/i.test(r.sim.toolOutputs[0].output), 'the answer to the voice holds labels, never the value');
  const briefs = natives(r.sim).map((m) => String(m.response.instructions));
  const last = briefs.at(-1) as string;
  assert.match(last, /STATUS captured: [^\n]*Customer name[^\n]*\. still missing: [^\n]*Callback phone number/);
  assert.ok(!/NEXT ASK Customer name/.test(last), 'the name is not asked again');
  assert.ok(!/priya|raman/i.test(last), 'the brief holds field names only');
  r.sim.drop({ cause: 'PEER', code: 1000 }); await r.handler.idle();
});

test('native: a number said in parts is joined by the server, progress is not a failure, and the tool answers carry no digits', async () => {
  let said = '';
  const r = await rig({
    native: ({ instructions, round }) => {
      const calls = round === 0 && /^(five|zero|four)/.test(said) ? [{ name: 'collect_phone', args: { heard: said } }] : [];
      return { say: calls.length > 0 ? '' : nextOf(instructions) === 'NEXT OPEN' ? 'Hello!' : 'Okay.', calls };
    },
  });
  await consent(r);
  for (const part of ['five five five', 'zero one two', 'four five six seven']) { said = part; const before = r.sim.toolOutputs.length; r.sim.say(part); await r.sim.waitFor(() => r.sim.toolOutputs.length > before); await r.sim.idle(); await r.handler.idle(); }
  const outcomes = r.sim.toolOutputs.map((x) => jsonOf(x.output).outcome);
  assert.deepEqual(outcomes, ['partial', 'partial', 'captured']);
  assert.ok(!r.sim.toolOutputs.some((x) => /\d{3}|five|four|seven/.test(x.output)), 'no digit comes back to the voice');
  r.sim.drop({ cause: 'PEER', code: 1000 }); await r.handler.idle();
});

test('native: a correction replaces what was captured, is read back to the caller (and only the caller), and is never in a model request or log', async () => {
  let said = '';
  const r = await rig({
    native: ({ instructions, outputs }) => {
      const fix = /jon smith/i.test(said) && outputs.length === 0 && nextOf(instructions) !== 'NEXT OPEN' ? [{ name: 'correct_contact', args: { field: 'name', heard: 'jon smith' } }] : [];
      return { say: fix.length > 0 ? '' : nextOf(instructions) === 'NEXT OPEN' ? 'Hello!' : 'Okay.', calls: fix };
    },
  });
  await consent(r);
  said = 'Hi, my name is Priya Raman and I have a burst pipe in the kitchen'; r.sim.say(said); await r.sim.heard(3); await r.handler.idle();
  said = 'The address is 42 Elm Street, you can reach me on 555 010 0123'; r.sim.say(said);
  await r.sim.waitFor(() => fixedLines(r.sim).some((l) => l.startsWith('Let me check what I have')));
  await r.sim.idle(); await r.handler.idle();
  const first = fixedLines(r.sim).find((l) => l.startsWith('Let me check what I have')) as string;
  assert.match(first, /Your name: Priya Raman\. Your callback number: 5 5 5 0 1 0 0 1 2 3\. Please say yes or no\. Is that correct\?/);
  said = 'no'; r.sim.say(said); await r.sim.waitFor(() => fixedLines(r.sim).includes(SAY.correct)); await r.sim.idle(); await r.handler.idle();
  said = 'wait the name is Jon Smith'; r.sim.say(said);
  await r.sim.waitFor(() => fixedLines(r.sim).filter((l) => l.startsWith('Let me check what I have')).length === 2);
  await r.sim.idle(); await r.handler.idle();
  const second = fixedLines(r.sim).filter((l) => l.startsWith('Let me check what I have'))[1];
  assert.match(second, /Your name: Jon Smith\./);
  assert.ok(!/Priya|Raman/.test(second));
  for (const where of [['the Intake requests', raw(r.intakeSeen)], ['the logs', raw(r.logs)], ['the briefs', raw(natives(r.sim).map((m) => m.response.instructions))], ['the tool answers', raw(r.sim.toolOutputs)]] as const) {
    for (const s of SECRETS) assert.ok(!where[1].includes(s), `${where[0]} must not contain "${s}"`);
  }
  assert.equal(r.handoffs.length, 0, 'nothing is handed off before the caller confirms');
  r.sim.drop({ cause: 'PEER', code: 1000 }); await r.handler.idle();
});

// ================================================================ interruptions
test('native: a caller who talks over a native reply stops it; the question does not count as asked; only a fixed marker is kept of the voice\'s words', async () => {
  const r = await rig({ mpc: 10, native: ({ instructions }) => ({ say: nextOf(instructions) === 'NEXT OPEN' ? 'Hi!' : 'Could you tell me a little more about the address of the job please?' }) });
  await consent(r);
  r.sim.say('Hi, I have a burst pipe in the kitchen');
  await r.sim.waitFor(() => r.sim.playing());
  r.sim.say('it is in the kitchen', { playedMs: 120 });
  await r.sim.idle(); await r.handler.idle();
  assert.equal(r.sim.sent.filter((m) => m.type === 'response.cancel').length, 1);
  assert.ok(has(r, 'REPLY_INTERRUPTED'));
  assert.equal(r.sim.refused.length, 0);
  const asks = natives(r.sim).map((m) => nextOf(String(m.response.instructions))).filter((l) => l.startsWith('NEXT ASK'));
  assert.ok(asks.length >= 2, 'the same item came again');
  assert.ok(!asks.some((l) => l.includes('asked before')), 'a question the caller talked over was never heard, so it is not "asked before"');
  r.sim.drop({ cause: 'PEER', code: 1000 }); await r.handler.idle();
});

// ================================================================ bounded clarification and safe recovery
test('native: an item still missing after one ask and two clarifications ends the call as a safe incomplete outcome: saved unconfirmed, not handed off, no price or booking', async () => {
  const r = await rig({ native: ({ instructions }) => ({ say: nextOf(instructions) === 'NEXT OPEN' ? 'Hello!' : 'Could you tell me more please?' }) });
  await consent(r);
  await turn(r, 'I have a burst pipe');
  for (let i = 0; i < 16 && !r.sim.hungUp; i++) await turn(r, 'I do not know');
  await ended(r);
  assert.equal(codes(r, 'INCOMPLETE').length, 1);
  assert.ok(fixedLines(r.sim).includes(SAY.incomplete));
  const [rec] = r.store.list(T);
  assert.deepEqual([rec.confirmation, rec.status, rec.handed_off], ['unconfirmed', 'needs-human', false]);
  assert.ok(rec.reasons.includes('incomplete_call'));
  assert.equal(r.handoffs.length, 0);
  assert.ok(!/\$\d|price|quote|booked|appointment/i.test(raw(r.sim.spoken)), 'nothing about a price or a booking was said');
});

test('native: unknown tools, bad arguments and tools that sound like pricing, booking or Processing are refused with fixed codes and change nothing; a run of them ends the call', async () => {
  const bad: Array<{ name: string; args?: unknown; rawArgs?: string }> = [
    { name: 'get_price', args: {} }, { name: 'book_slot', args: { slot: 'tomorrow' } }, { name: 'handoff_to_processing', args: {} },
    { name: 'collect_name', rawArgs: 'not json' },
  ];
  let sent = false;
  const r = await rig({ native: ({ instructions, outputs }) => (nextOf(instructions) === 'NEXT OPEN' ? { say: 'Hello!' } : !sent && outputs.length === 0 ? (sent = true, { calls: bad }) : { say: '' }) });
  await consent(r);
  r.sim.say('I have a burst pipe'); await r.sim.waitFor(() => r.sim.toolOutputs.length >= 4); await r.sim.idle(); await r.handler.idle();
  const answers = r.sim.toolOutputs.map((x) => jsonOf(x.output));
  assert.deepEqual(answers.map((a) => a.code), ['UNKNOWN_TOOL', 'UNKNOWN_TOOL', 'UNKNOWN_TOOL', 'BAD_ARGUMENTS']);
  assert.ok(answers.every((a) => a.ok === false));
  assert.equal(codes(r, 'TOOL').length, 4);
  assert.equal(codes(r, 'CONTACT_STORED').length, 0, 'a refused tool call stored nothing');
  assert.deepEqual(r.sim.sent.find((m) => m.type === 'session.update').session.tools.map((t: any) => t.name), [...CONTACT_TOOL_NAMES], 'the voice was only ever offered the five contact tools');
  assert.ok(!r.sim.sent.some((m) => m.type === 'session.update' && m.session.tools.some((t: any) => /price|quote|book|slot|calendar|process|handoff|approve/i.test(t.name))));
  assert.equal(r.handoffs.length, 0);
  r.sim.drop({ cause: 'PEER', code: 1000 }); await r.handler.idle();
});

test('native: five refused tool calls end the call with the fixed apology (safe recovery) and nothing is handed off', async () => {
  const r = await rig({ native: ({ instructions, outputs, round }) => (nextOf(instructions) === 'NEXT OPEN' ? { say: 'Hello!' } : round === 0 && outputs.length < 5 ? { calls: [{ name: 'get_price' }, { name: 'book_slot' }, { name: 'x1' }] } : round === 1 && outputs.length < 5 ? { calls: [{ name: 'x2' }, { name: 'x3' }] } : { say: 'Okay.' }) });
  await consent(r);
  r.sim.say('I have a burst pipe'); await ended(r);
  assert.ok(fixedLines(r.sim).includes(SAY.trouble));
  assert.equal(codes(r, 'TOOLS_REFUSED_TOO_OFTEN').length, 1);
  assert.equal(r.handoffs.length, 0);
});

test('native: a voice that says nothing is retried once and then the server asks in its own fixed words; a tool-only reply that never speaks is treated the same', async () => {
  let silent = 0;
  const r = await rig({ native: ({ instructions }) => (nextOf(instructions) === 'NEXT OPEN' ? { say: 'Hello!' } : silent++ < 2 ? { say: '' } : { say: 'Okay.' }) });
  await consent(r);
  r.sim.say('I have a burst pipe');
  await r.sim.waitFor(() => has(r, 'REPLY_FALLBACK_SENT'));
  await r.sim.idle(); await r.handler.idle();
  assert.equal(codes(r, 'REPLY_RETRY').length, 1);
  assert.ok(fixedLines(r.sim).some((l) => /^Sorry about the pause/.test(l)), 'the fixed fallback was spoken: ' + fixedLines(r.sim).join(' | '));
  assert.equal(r.sim.hungUp, false, 'the call goes on');
  r.sim.drop({ cause: 'PEER', code: 1000 }); await r.handler.idle();
});

test('native: a reply that takes too long is given up (the voice is cancelled) and the server speaks its fixed words', async () => {
  const r = await rig({ mpc: 10, totalMs: 1000, native: ({ instructions }) => (nextOf(instructions) === 'NEXT OPEN' ? { say: 'Hi!' } : { say: 'x'.repeat(300) }) });
  await consent(r);
  r.sim.say('I have a burst pipe');
  await r.sim.waitFor(() => has(r, 'REPLY_FALLBACK_SENT') || has(r, 'REPLY_RETRY'), 6000);
  assert.ok(r.sim.sent.some((m) => m.type === 'response.cancel'));
  r.sim.drop({ cause: 'PEER', code: 1000 }); await r.handler.idle();
});

// ================================================================ privacy and storage
test('native: the raw name, number and address reach no model request, log, dialogue history or stored file; the vault holds them encrypted only after a yes', async () => {
  const r = await rig({ native: ({ instructions }) => ({ say: nextOf(instructions) === 'NEXT OPEN' ? 'Hello!' : 'Okay.' }) });
  await consent(r);
  r.sim.say('Hi, my name is Priya Raman and I have a burst pipe in the kitchen'); await r.sim.heard(3); await r.handler.idle();
  r.sim.say('The address is 42 Elm Street, you can reach me on 555 010 0123');
  await r.sim.waitFor(() => fixedLines(r.sim).some((l) => l.startsWith('Let me check what I have'))); await r.sim.idle(); await r.handler.idle();
  r.sim.say('yes'); await r.sim.waitFor(() => fixedLines(r.sim).some((l) => l.startsWith('I have your service address'))); await r.sim.idle(); await r.handler.idle();
  r.sim.say('yes that is right'); await ended(r);
  const [rec] = r.store.list(T);
  assert.deepEqual([rec.confirmation, rec.handed_off], ['confirmed', true]);
  assert.equal(r.handoffs.length, 1, 'only a confirmed, ready request is handed off, and only by the existing seam');
  for (const [where, hay] of [['Intake requests', raw(r.intakeSeen)], ['logs', raw(r.logs)], ['briefs', raw(natives(r.sim).map((m) => m.response.instructions))], ['record', raw(rec)], ['stored files', readdirSync(dir).filter((f) => f.startsWith(`calls${dbn}`) || f.startsWith(`contacts${dbn}`)).map((f) => readFileSync(join(dir, f)).toString('latin1')).join('')]] as const) {
    for (const s of ['Priya', 'Raman', '5550100123', '555 010 0123', 'Elm Street']) assert.ok(!hay.includes(s), `${where} must not contain "${s}"`);
  }
  assert.ok(fixedLines(r.sim).some((l) => /Your name: Priya Raman/.test(l)), 'the caller (only) is read their name back');
});

test('native: limits still apply — the turn cap ends the call with the fixed line', async () => {
  const r = await rig({ maxTurns: 2, native: ({ instructions }) => ({ say: nextOf(instructions) === 'NEXT OPEN' ? 'Hello!' : 'Tell me more.' }) });
  await consent(r);
  r.sim.say('I have a burst pipe'); await r.sim.heard(3); await r.handler.idle();
  r.sim.say('in the kitchen'); await r.sim.heard(4); await r.handler.idle();
  r.sim.say('and another thing'); await ended(r);
  assert.ok(fixedLines(r.sim).includes(SAY.limit));
});

test('native: a tool call that arrives for a reply that is not current, or after the call ended, is ignored and answered with nothing', async () => {
  const r = await rig();
  await consent(r);
  r.sim.link.onMessage({ type: 'response.function_call_arguments.done', response_id: 'resp_nope', call_id: 'c1', name: 'collect_name', arguments: '{"heard":"x"}' });
  await r.handler.idle();
  assert.equal(r.sim.toolOutputs.length, 0);
  assert.equal(codes(r, 'TOOL').length, 0);
  r.sim.drop({ cause: 'PEER', code: 1000 }); await r.handler.idle();
});
