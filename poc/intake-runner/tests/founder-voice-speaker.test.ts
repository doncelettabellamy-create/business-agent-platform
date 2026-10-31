// The switch between the two speakers (src/founder-voice-gate.ts `speaker` section, src/founder-voice-speaker.ts, and the glue in src/founder-voice-entry.ts). OFF by default: no `speaker` section, OpenAI speaks,
// the opener is returned unchanged. ON: the speaker adapter with the ElevenLabs client. Mocks and stand-ins only: a canary string stands in for a key, the "provider" is a fetch stand-in or a loopback server,
// the entry is run as a child process in DRY RUN and refused-serve mode only (it opens nothing). Nothing here reads a real key, contacts a service or changes a configuration.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { founderConfigDigest } from '../src/founder-call-gate.ts';
import { founderVoiceConfigProblems, founderVoiceDigest, founderVoiceGateProblems, speakerSettingsOf } from '../src/founder-voice-gate.ts';
import type { FounderCallConfig } from '../src/founder-call-gate.ts';
import type { FounderVoiceConfig } from '../src/founder-voice-gate.ts';
import { withSelectedSpeaker } from '../src/founder-voice-speaker.ts';
import { JACK_SPEAKER } from '../src/speaker-adapter.ts';
import type { SpeakerSocket } from '../src/speaker-adapter.ts';
import { SAY_PREFIX, SPEAK_ONLY } from '../src/realtime-transport.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = '2026-10-27T12:00:00Z';
const SECRET = 'q7Zr2KfX9mWc4TbV8nHs1LpD6yGe3AuJ5oRi0NxE';
const TOKEN = 'invented-twilio-token-0123456789';
const KEY = 'sk-test-not-a-real-key-0123456789';
const XI = 'xi-canary-not-a-real-key-0123456789';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 4000): Promise<void> { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await sleep(4); } }
const example = JSON.parse(readFileSync(new URL('../examples/founder-call.config.example.json', import.meta.url), 'utf8'));
const exampleVoice = JSON.parse(readFileSync(new URL('../examples/founder-voice.config.example.json', import.meta.url), 'utf8'));
const NAMES_ELEVENLABS = { business_name: 'Drew Cleaning', disclosure: 'This is a test line, so please use made-up details only. Our A I speech providers, OpenAI and ElevenLabs, process what is said. We save the details you give for testing' };
const callConfig = (over: Record<string, unknown> = {}): FounderCallConfig => ({ ...example, public_wss_url: `wss://tunnel.founder-demo.net/relay/${SECRET}`, numbers: ['+15125553377'], expires: '2026-11-20T00:00:00Z', ...over });
const SPEAKER = { provider: 'elevenlabs', voice_id: '7EzWGsX10sAS4c9m9cPf', model_id: 'eleven_flash_v2_5', speed: 0.95 };
const voiceConfig = (over: Record<string, unknown> = {}): FounderVoiceConfig => ({ ...exampleVoice, openai_model: 'gpt-test-model', realtime_model: 'realtime-test-model', transcription_model: 'gpt-live-transcribe', voice: 'test-voice', ...over });
const okEnv = (c: FounderCallConfig, v: FounderVoiceConfig) => ({ allowLive: 'yes', callApprovedDigest: founderConfigDigest(c), voiceApprovedDigest: founderVoiceDigest(c, v), twilioTokenPresent: true, openaiKeyPresent: true });
const gate = (c: FounderCallConfig, v: FounderVoiceConfig, env: Record<string, unknown> = {}) => founderVoiceGateProblems({ callConfig: c, voiceConfig: v, env: { ...okEnv(c, v), ...env } as never, nowIso: NOW });

// ================================================================ the config section: absent by default
test('default: no speaker section means OpenAI speaks - the config is valid as it was, its digest does not change, and no speaker settings are selected', () => {
  const v = voiceConfig();
  assert.deepEqual(founderVoiceConfigProblems(v), []);
  assert.equal(speakerSettingsOf(v), undefined);
  assert.deepEqual(gate(callConfig(), v), [], 'the gate is unchanged when the section is absent (no ElevenLabs key or notice wording is asked for)');
  assert.notEqual(founderVoiceDigest(callConfig(), voiceConfig({ speaker: SPEAKER })), founderVoiceDigest(callConfig(), v), 'adding the section changes the digest, so it needs a new approval');
});

test('the section accepts only the approved candidate: Jack, Flash v2.5, a speed within bounds, scripted conversation, no extra keys', () => {
  assert.deepEqual(founderVoiceConfigProblems(voiceConfig({ speaker: SPEAKER })), []);
  assert.deepEqual({ ...speakerSettingsOf(voiceConfig({ speaker: SPEAKER })) }, { ...JACK_SPEAKER });
  for (const bad of [
    { ...SPEAKER, provider: 'openai' }, { ...SPEAKER, voice_id: 'short' }, { ...SPEAKER, model_id: 'eleven_v3' }, { ...SPEAKER, speed: 0.5 }, { ...SPEAKER, speed: 2 }, { ...SPEAKER, extra: 1 },
    { provider: 'elevenlabs', voice_id: SPEAKER.voice_id, model_id: SPEAKER.model_id }, 'elevenlabs', null, [],
  ]) assert.notDeepEqual(founderVoiceConfigProblems(voiceConfig({ speaker: bad })), [], JSON.stringify(bad));
  assert.notDeepEqual(founderVoiceConfigProblems(voiceConfig({ speaker: SPEAKER, conversation: 'native' })), [], 'native conversation is not supported with the speaker');
});

test('the gate: with the section present it asks for the ElevenLabs key and for a consent notice that names ElevenLabs; with both it asks for nothing more', () => {
  const v = voiceConfig({ speaker: SPEAKER });
  const plain = callConfig();                                    // the notice names no speech provider by that name
  const named = callConfig({ opening: NAMES_ELEVENLABS });
  const both = gate(named, v, { elevenlabsKeyPresent: true });
  assert.deepEqual(both, [], both.join('; '));
  const noKey = gate(named, v);
  assert.deepEqual(noKey, ['the ElevenLabs key is not set']);
  const noNotice = gate(plain, v, { elevenlabsKeyPresent: true });
  assert.deepEqual(noNotice, ['the consent notice does not name ElevenLabs as a speech provider']);
  assert.equal(gate(plain, v).length, 2);
  // An invalid section is a config problem before any of that.
  assert.ok(gate(named, voiceConfig({ speaker: { ...SPEAKER, speed: 5 } }), { elevenlabsKeyPresent: true }).some((m) => /speaker must be/.test(m)));
});

// ================================================================ the selection
function fakeOpen() {
  const sent: any[] = []; const opened: number[] = [];
  const socket: SpeakerSocket & { sent: any[] } = { sent, send(t: string) { sent.push(JSON.parse(t)); return true; }, close() {}, onOpen() {}, onMessage() {}, onClose() {} };
  const open = (): SpeakerSocket & { sent: any[] } => { opened.push(1); return socket; };
  return { open, socket, sent, opened };
}
const request = (text: string): string => JSON.stringify({ type: 'response.create', response: { conversation: 'none', instructions: `${SPEAK_ONLY} ${SAY_PREFIX}${text}`, metadata: { id: 'r1' } } });
function providerStandIn(): { fetch: typeof globalThis.fetch; calls: Array<{ url: string; headers: Record<string, string>; body: any }> } {
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const f = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(1600).fill(0xff)); c.enqueue(new Uint8Array(1600).fill(0xff)); c.close(); } }), { status: 200, headers: { 'content-type': 'audio/basic' } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: f, calls };
}

test('OFF: with no settings the opener is returned unchanged (the very same function), so OpenAI speaks exactly as before and the provider stand-in is never touched', async () => {
  const { open, sent } = fakeOpen(); const p = providerStandIn(); let keyAsked = 0;
  const chosen = withSelectedSpeaker(open, undefined, { getKey: () => { keyAsked++; return XI; }, fetch: p.fetch });
  assert.equal(chosen, open, 'identity: no wrapper of any kind');
  const socket = chosen(() => {});
  socket.send(request('Hello there.'));
  assert.deepEqual(sent.map((m) => m.type), ['response.create'], 'the request goes to the OpenAI voice socket');
  assert.deepEqual([keyAsked, p.calls.length], [0, 0]);
});

test('ON: with the settings each call\'s socket is wrapped - the line goes to the ElevenLabs client (mock), OpenAI is never asked to speak, listening messages still pass, and the key is asked for only when a line starts', async () => {
  const { open, sent, opened } = fakeOpen(); const p = providerStandIn(); let keyAsked = 0; const diag: Array<{ code: string; [k: string]: unknown }> = [];
  const chosen = withSelectedSpeaker(open, JACK_SPEAKER, { getKey: () => { keyAsked++; return XI; }, fetch: p.fetch });
  assert.notEqual(chosen, open);
  const socket = chosen(((code: string, detail?: Record<string, unknown>) => { diag.push({ code, ...detail }); }) as never);
  assert.equal(keyAsked, 0, 'nothing is asked at setup'); assert.equal(opened.length, 1, 'the OpenAI socket is opened once, for listening');
  const events: any[] = []; socket.onMessage = (t: string) => { events.push(JSON.parse(t)); };
  socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: 'AAAA' }));
  socket.send(request('Let me check what I have. Is that correct?'));
  await until(() => events.some((e) => e.type === 'response.done'));
  assert.equal(events.find((e) => e.type === 'response.done').response.status, 'completed');
  assert.deepEqual(sent.map((m) => m.type), ['input_audio_buffer.append'], 'only the listening message reached OpenAI');
  assert.equal(keyAsked, 1);
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].url, 'https://api.elevenlabs.io/v1/text-to-speech/7EzWGsX10sAS4c9m9cPf/stream?output_format=ulaw_8000');
  assert.equal(p.calls[0].headers['xi-api-key'], XI);
  assert.deepEqual([p.calls[0].body.text, p.calls[0].body.model_id, p.calls[0].body.voice_settings.speed], ['Let me check what I have. Is that correct?', 'eleven_flash_v2_5', 0.95]);
  assert.ok(diag.some((d) => d.code === 'ELEVENLABS_DONE') && diag.some((d) => d.code === 'SPEAKER_DONE'), 'both layers report through the call\'s diagnostics');
  assert.ok(!JSON.stringify(diag).includes(XI));
});

test('ON, no key: the line cannot start and fails honestly; OpenAI is not asked to speak in its place', async () => {
  const { open, sent } = fakeOpen(); const p = providerStandIn();
  const socket = withSelectedSpeaker(open, JACK_SPEAKER, { getKey: () => undefined, fetch: p.fetch })(() => {});
  const events: any[] = []; socket.onMessage = (t: string) => { events.push(JSON.parse(t)); };
  socket.send(request('Hello there.'));
  await until(() => events.some((e) => e.type === 'response.done'));
  assert.equal(events.find((e) => e.type === 'response.done').response.status, 'failed');
  assert.deepEqual([sent.length, p.calls.length], [0, 0], 'no silent fallback to OpenAI speaking, and no request');
});

// ================================================================ the entry (child process: dry run and refused serve only)
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function workdir(over: { call?: Record<string, unknown>; voice?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(join(ROOT, '.voice-test-'));
  dirs.push(dir); mkdirSync(dir, { recursive: true });
  const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const c = callConfig({ expires: soon, kill_file: join(dir, 'stop'), db_path: join(dir, 'calls.sqlite').replace(/\\/g, '/'), ...over.call });
  const v = voiceConfig(over.voice);
  const cp = join(dir, 'call.json'); const vp = join(dir, 'voice.json');
  writeFileSync(cp, JSON.stringify(c)); writeFileSync(vp, JSON.stringify(v));
  return { dir, c, v, args: ['--config', relative(ROOT, cp).replace(/\\/g, '/'), '--voice-config', relative(ROOT, vp).replace(/\\/g, '/')] };
}
function run(args: string[], env: Record<string, string> = {}) {
  const base: Record<string, string> = { PATH: process.env.PATH ?? '' };
  if (process.env.SystemRoot) base.SystemRoot = process.env.SystemRoot;
  return spawnSync(process.execPath, ['src/founder-voice-entry.ts', ...args], { cwd: ROOT, env: { ...base, ...env }, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
}

test('entry, OFF: a dry run with no speaker section says OpenAI speaks and the ElevenLabs speaker is OFF; a fully approved gate does not ask for an ElevenLabs key', () => {
  const w = workdir();
  const r = run(w.args);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('Speaker: OpenAI speaks (the default; the ElevenLabs speaker is OFF)'));
  const env = { INTAKE_ALLOW_LIVE_CALLS: 'yes', TWILIO_AUTH_TOKEN: TOKEN, OPENAI_API_KEY: KEY, FOUNDER_CALL_APPROVED_DIGEST: founderConfigDigest(w.c), FOUNDER_VOICE_APPROVED_DIGEST: founderVoiceDigest(w.c, w.v) };
  const ok = run(w.args, env);
  assert.ok(ok.stdout.includes('[ok] all checks pass'), 'unchanged: no ElevenLabs key needed when the speaker is off');
});

test('entry, ON: the dry run says ElevenLabs is on and that the text of every spoken line goes to it; the gate stays closed until the key is set and the notice names ElevenLabs; a refused serve names the reasons and prints no key', () => {
  const w = workdir({ voice: { speaker: SPEAKER }, call: { opening: NAMES_ELEVENLABS } });
  const env = { INTAKE_ALLOW_LIVE_CALLS: 'yes', TWILIO_AUTH_TOKEN: TOKEN, OPENAI_API_KEY: KEY, FOUNDER_CALL_APPROVED_DIGEST: founderConfigDigest(w.c), FOUNDER_VOICE_APPROVED_DIGEST: founderVoiceDigest(w.c, w.v) };
  const r = run(w.args, env);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(/Speaker: ElevenLabs ON \(voice 7EzWGsX10sAS4c9m9cPf, model eleven_flash_v2_5, speed 0.95\)/.test(r.stdout) && /TEXT of every spoken line/.test(r.stdout));
  assert.ok(r.stdout.includes('the ElevenLabs key is not set') && !r.stdout.includes('[ok] all checks pass'), 'closed without the key');
  const open = run(w.args, { ...env, ELEVENLABS_API_KEY: XI });
  assert.ok(open.stdout.includes('[ok] all checks pass'), 'open with the key and the notice');
  const refused = run([...w.args, '--serve'], env);
  assert.equal(refused.status, 78);
  assert.ok(/serve refused: the ElevenLabs key is not set/.test(refused.stderr) && !refused.stdout.includes('Serving'));
  const noNotice = workdir({ voice: { speaker: SPEAKER } });
  const r2 = run(noNotice.args, { INTAKE_ALLOW_LIVE_CALLS: 'yes', TWILIO_AUTH_TOKEN: TOKEN, OPENAI_API_KEY: KEY, ELEVENLABS_API_KEY: XI, FOUNDER_CALL_APPROVED_DIGEST: founderConfigDigest(noNotice.c), FOUNDER_VOICE_APPROVED_DIGEST: founderVoiceDigest(noNotice.c, noNotice.v) });
  assert.ok(r2.stdout.includes('the consent notice does not name ElevenLabs'), 'a notice that does not name ElevenLabs keeps the gate closed');
  for (const secret of [KEY, TOKEN, XI]) for (const out of [r, open, refused, r2]) assert.ok(!out.stdout.includes(secret) && !out.stderr.includes(secret), 'no credential is printed');
});

test('entry, wiring: the entry reads the ElevenLabs key only in the getter it hands to the switch, and uses the switch only through the one selection call', () => {
  const src = readFileSync(new URL('../src/founder-voice-entry.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal((src.match(/ELEVENLABS_API_KEY/g) ?? []).length, 3, 'twice in the presence check for the gate and once in the getter handed to the switch');
  assert.equal((src.match(/withSelectedSpeaker\(/g) ?? []).length, 1);
  assert.ok(/getKey: \(\) => process\.env\.ELEVENLABS_API_KEY/.test(src));
});
