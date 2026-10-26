// Composition root and command line for the founder phone test (proof of concept). This and live-run.ts / pipeline.ts are the only files
// that mint an execution context.
//
//   node src/founder-call-entry.ts [--config founder-call.config.json]           DRY RUN (default): checks the config, prints its digest, the
//                                                                                cost ceiling, the exact provider settings, and what is still
//                                                                                missing. Opens no port, reads no credential, sends nothing.
//   node src/founder-call-entry.ts --serve [--config ...]                        needs the whole gate (founder-call-gate.ts). Then it opens the
//                                                                                phone endpoint and the dashboard, BOTH on 127.0.0.1 only.
//
// What leaves the machine only after the gate passes: Claude API calls (the SDK reads ANTHROPIC_API_KEY from the environment; this file never
// does). What this file never does: expose an endpoint (the founder's tunnel does that, deliberately), place or buy anything, read a credential
// other than the Twilio auth token (used only to check signatures, never printed), or log speech.
// The Intake agent here is the EXISTING createIntakeEntry with the Claude provider; the dialogue model only talks.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mintExecutionContext } from './execution-context.ts';
import { createIntakeEntry } from './intake-entry.ts';
import { createTenantRegistry } from './tenant-boundary.ts';
import { createClaudeProvider } from './claude-provider.ts';
import type { ClaudeClient, ClaudeMessage, ClaudeParams } from './claude-provider.ts';
import { createClaudeDialogueModel } from './dialogue-model.ts';
import type { DialogueClient, DialogueParams, StreamEvent } from './dialogue-model.ts';
import { createIntakeRecordStore } from './intake-record-store.ts';
import { createDashboardServer } from './dashboard-server.ts';
import { createRelayWsServer } from './ws-server.ts';
import { createRelayHandler, speechDelayMs } from './relay-handler.ts';
import { claudeCeilingUsd, founderConfigDigest, founderConfigProblems, founderGateProblems, relayPathFor, signedUrlCandidates } from './founder-call-gate.ts';
import { randomBytes } from 'node:crypto';
import type { FounderCallConfig } from './founder-call-gate.ts';
import { estimateCall } from './cost-estimate.ts';
import { buildClassifyRequest } from './model-gateway.ts';
import { buildClaudeParams } from './claude-provider.ts';
import { formatUsd, PRICES_AS_OF } from './cost-estimate.ts';

const CONSENT_NOTICE = 'Hello. This is an automated A I assistant, part of a test of a business phone line. We do not record the audio. Our phone provider turns your speech into text, and personal details are masked before an A I model reads it. Please say yes to continue, or hang up now.';
const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nowIso = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The TwiML to paste into a Twilio TwiML Bin (so the phone provider hosts it and this machine exposes no HTTP endpoint for it). */
export function twimlFor(publicWssUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Connect>\n    <ConversationRelay url="${xml(publicWssUrl)}" language="en-US" welcomeGreeting="${xml(CONSENT_NOTICE)}" welcomeGreetingInterruptible="none" />\n  </Connect>\n</Response>\n`;
}

const argv = process.argv.slice(2);
const serve = argv.includes('--serve');
const ci = argv.indexOf('--config');
const configPath = ci >= 0 && argv[ci + 1] !== undefined ? argv[ci + 1] : 'founder-call.config.json';
if (argv.some((a, i) => a !== '--serve' && a !== '--config' && !(i > 0 && argv[i - 1] === '--config'))) {
  console.error('argument problem: unknown argument');
  process.exit(64);
}
if (!/^[\w./\\-]{1,200}\.json$/.test(configPath) || configPath.includes('..')) { console.error('argument problem: --config must be a plain .json path inside this folder'); process.exit(64); }

let config: FounderCallConfig;
try { config = JSON.parse(readFileSync(configPath, 'utf8')) as FounderCallConfig; }
catch { console.error('Could not read the config file as JSON. Copy examples/founder-call.config.example.json to founder-call.config.json and edit it.'); process.exit(66); }
const problems = founderConfigProblems(config);
if (problems.length > 0) { for (const p of problems) console.error(`config problem: ${p}`); process.exit(65); }

const digest = founderConfigDigest(config);
const calls = config.max_claude_calls;
const ceiling = claudeCeilingUsd(config.model, calls);
const sample = buildClaudeParams(buildClassifyRequest('Caller: sample', ['a'], 1024), config.model, 'low');
const one = estimateCall(sample);
console.log(`Mode: ${serve ? 'SERVE REQUESTED (gate checks follow)' : 'DRY RUN (nothing is opened, read or sent)'}`);
console.log(`Config: ${configPath}   tenant: ${config.tenant}   numbers: ${config.numbers.length}   model: ${config.model}`);
console.log(`Caps per call: ${config.max_minutes} minutes, ${config.max_turns} caller turns.   Claude calls for the whole approval: ${calls}   expires: ${config.expires}`);
console.log(`Config digest (set this as FOUNDER_CALL_APPROVED_DIGEST ONLY when you approve this exact config):\n  ${digest}`);
console.log(ceiling === null ? 'Claude cost ceiling: no price on file for this model.' : `Claude cost ceiling for ${calls} calls: ${formatUsd(ceiling)} (list prices as of ${PRICES_AS_OF}; verify before spending)${one ? `; a typical short Intake call is about ${formatUsd(one.costLow)}` : ''}.`);
const twilioToken = process.env.TWILIO_AUTH_TOKEN;
const gate = founderGateProblems({
  config, nowIso: nowIso(),
  env: { allowLive: process.env.INTAKE_ALLOW_LIVE_CALLS, approvedDigest: process.env.FOUNDER_CALL_APPROVED_DIGEST, twilioTokenPresent: typeof twilioToken === 'string' && twilioToken.length >= 8 },
});
console.log('\nGate (every line must be [ok] to serve):');
console.log(`  [${gate.length === 0 ? 'ok' : '--'}] ${gate.length === 0 ? 'all checks pass' : gate.join('; ')}`);
console.log('\nTwilio TwiML Bin (paste into a TwiML Bin, then point the number\'s voice webhook at it):\n');
console.log(twimlFor(config.public_wss_url));
console.log(`A fresh random secret for the address, if you need one (generate your own each time; never reuse): ${randomBytes(24).toString('base64url')}`);
console.log(`Local only: phone endpoint 127.0.0.1:${config.relay_port} (the tunnel forwards the public address to this port), owner dashboard http://127.0.0.1:${config.dashboard_port}/`);
if (!serve) { console.log('\nNo port was opened and nothing was sent.'); process.exit(0); }
if (gate.length > 0) { for (const g of gate) console.error(`serve refused: ${g}`); process.exit(78); }

// ---- Only past this line can anything leave the machine. ----
const tenant = config.tenant;
let Anthropic: new (options: Record<string, unknown>) => { messages: { create(params: unknown, options?: unknown): Promise<unknown> } };
try {
  const sdk = (await import('@anthropic-ai/sdk')) as unknown as { default: typeof Anthropic };
  Anthropic = sdk.default;
} catch { console.error('The official SDK is not installed. Nothing was started.'); process.exit(69); }
const sdkClient = new Anthropic({ maxRetries: 0, timeout: 60_000 });
let sent = 0;
function count(): void { if (sent >= calls) throw new Error('call limit reached'); sent++; }
const intakeClient: ClaudeClient = { messages: { async create(params: ClaudeParams, options?: { signal?: AbortSignal }): Promise<ClaudeMessage> { count(); return (await sdkClient.messages.create(params, options)) as ClaudeMessage; } } };
const dialogueClient: DialogueClient = { messages: { async create(params: DialogueParams, options?: { signal?: AbortSignal }): Promise<AsyncIterable<StreamEvent>> { count(); return (await sdkClient.messages.create(params, options)) as AsyncIterable<StreamEvent>; } } };

const registry = createTenantRegistry({ [tenant]: config.skill_config as never });
const intake = createIntakeEntry({
  registry, provider: createClaudeProvider(intakeClient, { model: config.model, effort: 'low' }),
  limits: { maxOutputTokens: 1024, timeoutMs: 30_000, maxAttempts: 1 }, channelRef: 'channel-founder-phone', now: nowIso, founderTest: { tenant },
});
const dialogue = createClaudeDialogueModel(dialogueClient, { model: config.model });
const store = createIntakeRecordStore({ path: config.db_path });
const skill = config.skill_config as { fields: { name: string }[] };

const handler = createRelayHandler({
  numbers: new Map(config.numbers.map((n) => [n, tenant])),
  fieldNames: () => skill.fields.map((f) => f.name),
  intake,
  async intakeContext(t, ref) {
    if (t !== tenant) throw new Error('tenant');
    const r = await mintExecutionContext({ credential: 'founder-call-entry', agent: 'intake' }, {
      verify: () => ({ kind: 'system', id: 'founder-call-entry' }), selectTenant: () => t, grants: () => ['intake:run'], newCorrelationId: () => `corr-founder-${ref}`,
    });
    if (!r.ok) throw new Error('context');
    return r.context;
  },
  dialogue, store, limits: { maxTurns: config.max_turns, maxMinutes: config.max_minutes, maxChars: 4000 }, names: config.persona_names, maxCalls: config.max_calls,
  now: () => Date.now(), nowIso, killed: () => existsSync(config.kill_file), afterSpeechMs: config.after_speech_ms,
  speechMs: (text) => speechDelayMs(text), confirmWaitMs: 20_000,
  log: (code, detail) => console.log(`[founder-call] ${nowIso()} ${code}${detail ? ' ' + JSON.stringify(detail) : ''}`),
});
const staticDir = fileURLToPath(new URL('../../../prototype/intake-work-items', import.meta.url));
const dashboard = createDashboardServer({ store, tenant, staticDir });
const relay = createRelayWsServer({ path: relayPathFor(config.public_wss_url), authToken: twilioToken as string, urls: signedUrlCandidates(config.public_wss_url), maxConnections: 2, onConnection: (c) => handler.handle(c) });
await dashboard.listen(config.dashboard_port);
await relay.listen(config.relay_port);
console.log(`\nServing. Owner dashboard: http://127.0.0.1:${config.dashboard_port}/   Phone endpoint (local): 127.0.0.1:${config.relay_port}/relay`);
console.log(`Kill switch: create the file "${config.kill_file}" to end calls. Stop everything with Ctrl+C.`);
process.on('SIGINT', () => { void (async () => { await relay.close(); await dashboard.close(); store.close(); process.exit(0); })(); });
