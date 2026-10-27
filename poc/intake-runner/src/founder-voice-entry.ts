// Composition root and command line for the founder VOICE test (OpenAI speech-to-speech over a Twilio Media Streams stream). Like founder-call-entry.ts it is one of the few files that mint an execution context.
// The existing Claude/ConversationRelay entry is untouched and remains the live path until the founder decides otherwise.
//
//   node src/founder-voice-entry.ts [--config founder-call.config.json] [--voice-config founder-voice.config.json]           DRY RUN (default): checks both configs, prints both digests, what the run is
//                                                                                                                             bounded by, the stream TwiML per number, and what is still missing.
//                                                                                                                             Opens no port, makes no connection, sends nothing; it checks only whether credentials are present.
//   node src/founder-voice-entry.ts --serve [...]                                                                             needs the whole gate (founder-voice-gate.ts). Then it opens the stream
//                                                                                                                             endpoint and the dashboard, BOTH on 127.0.0.1 only.
//
// What leaves the machine only after the gate passes: OpenAI text calls (Responses API) and one OpenAI Realtime connection per call, which carries the caller's RAW AUDIO (acceptable for founder tests with invented
// details only; real customers need a separate data-terms and disclosure decision first). The key is read from OPENAI_API_KEY only at the moment of each connection or request, by a function handed to the OpenAI
// modules; it is never printed, logged or stored. What this file never does: expose an endpoint (the founder's tunnel does that, deliberately), change Twilio, place or buy anything, or log speech.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mintExecutionContext } from './execution-context.ts';
import { createIntakeRecordStore } from './intake-record-store.ts';
import { createDashboardServer } from './dashboard-server.ts';
import { createRelayWsServer } from './ws-server.ts';
import { founderConfigDigest, founderConfigProblems, relayPathFor, signedUrlCandidates } from './founder-call-gate.ts';
import type { FounderCallConfig } from './founder-call-gate.ts';
import { effectiveVoiceSettings, founderVoiceConfigProblems, founderVoiceDigest, founderVoiceGateProblems, voiceBounds } from './founder-voice-gate.ts';
import type { FounderVoiceConfig } from './founder-voice-gate.ts';
import { contactsPathFor, createContactVault, keyFromEnv } from './contact-vault.ts';
import { createOpenAIHttpClient } from './openai-http-client.ts';
import { createOpenAiVoiceSocket } from './openai-voice-socket.ts';
import { createFounderVoiceService } from './founder-voice-service.ts';
import { streamTwimlFor } from './stream-twiml.ts';

const nowIso = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

const argv = process.argv.slice(2);
const serve = argv.includes('--serve');
const arg = (name: string, fallback: string): string => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback; };
const configPath = arg('--config', 'founder-call.config.json');
const voicePath = arg('--voice-config', 'founder-voice.config.json');
const known = new Set(['--serve', '--config', '--voice-config', configPath, voicePath]);
if (argv.some((a) => !known.has(a))) { console.error('argument problem: unknown argument'); process.exit(64); }
for (const p of [configPath, voicePath]) {
  if (!/^[\w./\\-]{1,200}\.json$/.test(p) || p.includes('..')) { console.error('argument problem: config paths must be plain .json paths inside this folder'); process.exit(64); }
}
function readJson(path: string): unknown { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { console.error('Could not read a config file as JSON. Copy the example files in examples/ and edit them.'); process.exit(66); } }
const config = readJson(configPath) as FounderCallConfig;
const voice = readJson(voicePath) as FounderVoiceConfig;
const problems = [...founderConfigProblems(config), ...founderVoiceConfigProblems(voice)];
if (problems.length > 0) { for (const p of problems) console.error(`config problem: ${p}`); process.exit(65); }

const callDigest = founderConfigDigest(config);
const voiceDigest = founderVoiceDigest(config, voice);
const bounds = voiceBounds(config, voice);
console.log(`Mode: ${serve ? 'SERVE REQUESTED (gate checks follow)' : 'DRY RUN (nothing is opened, read or sent)'}   [OpenAI voice route]`);
console.log(`Call config: ${configPath}   tenant: ${config.tenant}   numbers: ${config.numbers.length}   expires: ${config.expires}`);
console.log(`Voice config: ${voicePath}   text model: ${voice.openai_model}   voice model: ${voice.realtime_model}   transcription model: ${voice.transcription_model}   voice: ${voice.voice}`);
const eff = effectiveVoiceSettings(voice);
console.log(`Settings (defaults filled in): voice reasoning ${eff.realtimeReasoning}; text reasoning ${eff.textReasoning}; transcription hints: ${eff.transcription === undefined ? 'none' : `${eff.transcription.languages?.length ?? 0} language(s), ${eff.transcription.keywords?.length ?? 0} keyword(s)`}. UNVERIFIED until a live call: whether each model accepts these values.`);
console.log(`Bounds: at most ${bounds.calls} calls of ${bounds.minutesPerCall} minutes (${bounds.maxVoiceMinutes} voice minutes in all), ${config.max_turns} caller turns each, ${bounds.maxOpenaiCalls} OpenAI text calls for the whole run. No dollar ceiling is computed: OpenAI prices for these models are not on file and the voice cost per minute is unverified.`);
console.log(`Call config digest (FOUNDER_CALL_APPROVED_DIGEST, only when you approve it):\n  ${callDigest}`);
console.log(`Voice digest (FOUNDER_VOICE_APPROVED_DIGEST, only when you approve BOTH files):\n  ${voiceDigest}`);
const twilioToken = process.env.TWILIO_AUTH_TOKEN;
const gate = founderVoiceGateProblems({
  callConfig: config, voiceConfig: voice, nowIso: nowIso(),
  env: {
    allowLive: process.env.INTAKE_ALLOW_LIVE_CALLS, callApprovedDigest: process.env.FOUNDER_CALL_APPROVED_DIGEST, voiceApprovedDigest: process.env.FOUNDER_VOICE_APPROVED_DIGEST,
    twilioTokenPresent: typeof twilioToken === 'string' && twilioToken.length >= 8, openaiKeyPresent: typeof process.env.OPENAI_API_KEY === 'string' && process.env.OPENAI_API_KEY.length >= 8,
  },
});
console.log('\nGate (every line must be [ok] to serve):');
console.log(`  [${gate.length === 0 ? 'ok' : '--'}] ${gate.length === 0 ? 'all checks pass' : gate.join('; ')}`);
console.log('\nTwilio TwiML Bin for the OpenAI route (one per number; NOT applied by this program; the live Bin is untouched):\n');
for (const n of config.numbers) console.log(streamTwimlFor(config.public_wss_url, { number: n }));
console.log(`Local only: stream endpoint 127.0.0.1:${config.relay_port} (the tunnel forwards the public address to this port), owner dashboard http://127.0.0.1:${config.dashboard_port}/`);
if (!serve) { console.log('\nNo port was opened and nothing was sent. (Only whether each credential is present was checked; no value is ever printed.)'); process.exit(0); }
if (gate.length > 0) { for (const g of gate) console.error(`serve refused: ${g}`); process.exit(78); }

// ---- Only past this line can anything leave the machine. ----
const tenant = config.tenant;
const getKey = (): string | undefined => process.env.OPENAI_API_KEY;
const http = createOpenAIHttpClient({ getKey });
let textCalls = 0;
const textClient = { responses: { async create(params: object, options?: { signal?: AbortSignal }) { if (textCalls >= voice.max_openai_calls) throw new Error('call limit reached'); textCalls++; return http.responses.create(params, options); } } };
const diagLog = (code: string): void => { console.log(`[founder-voice] ${nowIso()} ${code}`); };

const rawContactKey = process.env.FOUNDER_CONTACT_KEY;
const contactKey = keyFromEnv(rawContactKey);
if (rawContactKey !== undefined && rawContactKey !== '' && contactKey === undefined) { console.error('serve refused: FOUNDER_CONTACT_KEY is set but is not a valid 32-byte base64 key. Nothing was started.'); process.exit(78); }
let contacts: ReturnType<typeof createContactVault> | undefined;
try { contacts = contactKey === undefined ? undefined : createContactVault({ path: contactsPathFor(config.db_path), key: contactKey, now: () => Date.now() }); }
catch { console.error('serve refused: the contact vault could not be opened (wrong key for the existing file?). Nothing was started.'); process.exit(78); }
console.log(`Contact capture (name, callback number, service address; encrypted, 30-day retention): ${contacts === undefined ? 'OFF (no FOUNDER_CONTACT_KEY)' : 'ON'}`);

const store = createIntakeRecordStore({ path: config.db_path });
const service = createFounderVoiceService({
  config, voice, textClient,
  openVoice: () => createOpenAiVoiceSocket({ model: voice.realtime_model, getKey, ...(voice.safety_identifier === undefined ? {} : { safetyIdentifier: voice.safety_identifier }), diag: diagLog }),
  store, ...(contacts === undefined ? {} : { contacts }),
  async intakeContext(t, ref) {
    if (t !== tenant) throw new Error('tenant');
    const r = await mintExecutionContext({ credential: 'founder-voice-entry', agent: 'intake' }, {
      verify: () => ({ kind: 'system', id: 'founder-voice-entry' }), selectTenant: () => t, grants: () => ['intake:run'], newCorrelationId: () => `corr-founder-${ref}`,
    });
    if (!r.ok) throw new Error('context');
    return r.context;
  },
  now: () => Date.now(), nowIso, killed: () => existsSync(config.kill_file),
  log: (code, detail) => console.log(`[founder-voice] ${nowIso()} ${code}${detail ? ' ' + JSON.stringify(detail) : ''}`),
});
const staticDir = fileURLToPath(new URL('../../../prototype/intake-work-items', import.meta.url));
const dashboard = createDashboardServer({ store, tenant, staticDir });
const relay = createRelayWsServer({ path: relayPathFor(config.public_wss_url), authToken: twilioToken as string, urls: signedUrlCandidates(config.public_wss_url), maxConnections: 2, onConnection: (c) => service.handleStream(c) });
await dashboard.listen(config.dashboard_port);
await relay.listen(config.relay_port);
console.log(`\nServing (OpenAI voice route). Owner dashboard: http://127.0.0.1:${config.dashboard_port}/   Stream endpoint (local): 127.0.0.1:${config.relay_port}${relayPathFor(config.public_wss_url).replace(/[A-Za-z0-9_-]{32,64}$/, '<secret>')}`);
console.log(`Kill switch: create the file "${config.kill_file}" to end calls. Stop everything with Ctrl+C.`);
process.on('SIGINT', () => { void (async () => { await relay.close(); await dashboard.close(); store.close(); contacts?.close(); process.exit(0); })(); });
