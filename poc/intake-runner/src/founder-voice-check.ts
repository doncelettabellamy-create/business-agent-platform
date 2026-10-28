// Command line for the OpenAI connection check (the smallest paid test; see voice-check.ts for what it does, what it proves and what it cannot).
//
//   node src/founder-voice-check.ts [--voice-config founder-voice.config.json] [--config founder-call.config.json]        PLAN (default): checks the voice config, prints the models, the settings, the exact notice that
//                                                                                                                       would be spoken (Drew's greeting including the "$25 off" special), what would
//                                                                                                                       be sent, and the spending ceiling. Reads no key, opens no connection, sends nothing.
//   node src/founder-voice-check.ts --spend --max-usd 0.15 [--key-from-env]                                              RUNS the check. Needs: a spending limit at or above the computed ceiling (and
//                                                                                                                       at most $1), an interactive terminal, the ceiling typed back to confirm, and the key.
//
// THE KEY: asked for at the terminal with nothing shown on screen (hidden-prompt.ts), held in memory for the run and dropped afterwards. It is never printed, logged, written, put in the command line or the
// environment. `--key-from-env` is the only alternative and must be named on purpose; it reads OPENAI_API_KEY and nothing else. A key cannot be piped in: the prompt needs a real terminal.
// THE CONTENT: invented only. No caller audio is sent; no phone, Twilio or live configuration is touched; the Drew call config is read only for its `opening` block, and only if --config is given.
// THE OUTPUT: pass or fail per check, fixed codes, numbers and the names of fields an error mentions; never the key, a header, a response body, or anything a caller said.

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createOpenAIHttpClient } from './openai-http-client.ts';
import { createOpenAiVoiceSocket } from './openai-voice-socket.ts';
import { looksLikeKey, normalizeKeyEntry, readSecret } from './hidden-prompt.ts';
import { CHECK_LIMITS, CHECK_PRICES_AS_OF, planCheck, runCheck } from './voice-check.ts';
import { DREW_TEST_OPENING } from './drew-test-opening.ts';
import type { FounderVoiceConfig } from './founder-voice-gate.ts';

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const arg = (name: string, fallback: string | undefined): string | undefined => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback; };
const voicePath = arg('--voice-config', 'founder-voice.config.json') as string;
const callPath = arg('--config', undefined);
const maxUsdRaw = arg('--max-usd', undefined);
const spend = flag('--spend');
const known = new Set(['--spend', '--key-from-env', '--voice-config', '--config', '--max-usd', voicePath, ...(callPath === undefined ? [] : [callPath]), ...(maxUsdRaw === undefined ? [] : [maxUsdRaw])]);
if (argv.some((a) => !known.has(a))) { console.error('argument problem: unknown argument'); process.exit(64); }
for (const p of [voicePath, ...(callPath === undefined ? [] : [callPath])]) {
  if (!/^[\w./\\-]{1,200}\.json$/.test(p) || p.includes('..')) { console.error('argument problem: config paths must be plain .json paths inside this folder'); process.exit(64); }
}
function readJson(path: string): unknown { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { console.error('Could not read a config file as JSON.'); process.exit(66); } }

const voice = readJson(voicePath) as FounderVoiceConfig;
// Only the opening block of the call config is used, so that the real greeting (and its special) is what is tested; nothing else in that file is read into the check.
const opening = callPath === undefined ? DREW_TEST_OPENING : (readJson(callPath) as { opening?: unknown }).opening;
if (opening === undefined) { console.error('The call config has no opening block.'); process.exit(65); }
const planned = planCheck(voice, opening);
if (!planned.ok) { for (const p of planned.problems) console.error(`check problem: ${p}`); process.exit(65); }
const plan = planned.plan;
const L = CHECK_LIMITS;

console.log(`Mode: ${spend ? 'SPEND REQUESTED (confirmations follow)' : 'PLAN ONLY (nothing is read, opened or sent)'}   [OpenAI connection check]`);
console.log(`Models: voice ${plan.models.realtime}; text ${plan.models.text}; transcription ${plan.models.transcription} (only checked for being accepted: no audio is sent); voice name ${plan.models.voice}`);
console.log(`Settings: voice reasoning ${plan.settings.realtimeReasoning}; text reasoning ${plan.settings.textReasoning}; transcription hints ${plan.settings.hints}`);
console.log(`Opening used: ${callPath === undefined ? 'the proposed Drew test opening (src/drew-test-opening.ts)' : 'the opening block of the call config'}`);
console.log(`The notice that would be spoken (${plan.noticeChars} characters, about ${plan.noticeSeconds} seconds):\n  ${plan.notice}`);
console.log(`Would send: ${L.maxTextRequests} text requests (invented text only) and one Realtime connection with at most ${L.maxSpeechRequests} spoken lines (the notice, one short line, one long line cancelled part-way), no caller audio, no phone, no Twilio. Wall-clock limit ${L.maxSeconds} seconds.`);
console.log(`Spending ceiling: $${plan.ceilingUsd.toFixed(2)} (audio ${(plan.breakdown.audioOut).toFixed(3)} + speech text ${(plan.breakdown.speechText).toFixed(3)} + text models ${(plan.breakdown.textModels).toFixed(3)}; list prices as of ${CHECK_PRICES_AS_OF}, verify before relying on them). Typical spend is far below it.`);
console.log('Can prove: the key and model names work; the session settings are accepted; the event names the adapter relies on; fixed text including the "$25" is read back closely enough; a cancel that names a reply stops it; the text settings work with a strict schema; roughly what a few seconds of speech cost.');
console.log('Cannot prove: anything about a phone call (Twilio signature form, real 8 kHz audio, the transcriber on real speech, live interruptions, latency over a line), the consent-before-audio gap, or anything about real customers.');
if (!spend) { console.log(`\nNothing was sent. To run it: node src/founder-voice-check.ts --spend --max-usd ${plan.ceilingUsd.toFixed(2)}`); process.exit(0); }

// ---- Only past this line can anything leave the machine. ----
const maxUsd = Number(maxUsdRaw);
if (maxUsdRaw === undefined || !Number.isFinite(maxUsd) || maxUsd <= 0) { console.error('spend refused: give a spending limit, for example --max-usd 0.15'); process.exit(78); }
if (maxUsd > 1) { console.error('spend refused: the limit may not exceed $1.00 for this check'); process.exit(78); }
if (maxUsd + 1e-9 < plan.ceilingUsd) { console.error(`spend refused: the limit is below the computed ceiling of $${plan.ceilingUsd.toFixed(2)}`); process.exit(78); }
if (process.stdin.isTTY !== true) { console.error('spend refused: this needs an interactive terminal (the key is typed privately and cannot be piped in)'); process.exit(78); }

const rl = createInterface({ input: process.stdin, output: process.stdout });
const typed: string = await new Promise((resolve) => rl.question(`Type ${plan.ceilingUsd.toFixed(2)} to confirm spending up to $${plan.ceilingUsd.toFixed(2)}: `, resolve));
rl.close();
if (typed.trim() !== plan.ceilingUsd.toFixed(2)) { console.error('spend refused: the amount was not confirmed. Nothing was sent.'); process.exit(78); }

const WHY: Record<string, string> = { empty: 'nothing was received', too_short: 'it is too short to be a key', too_long: 'it is too long to be a key', bad_characters: 'it holds characters a key does not have (for example a space inside it)' };
let key: string | undefined;
for (let attempt = 1; attempt <= 3 && key === undefined; attempt++) {
  const raw = flag('--key-from-env') ? process.env.OPENAI_API_KEY : await readSecret(process.stdin, process.stdout, 'Enter the OpenAI key (nothing will be shown; paste with a right-click, then press Enter; Esc cancels): ');
  if (raw === undefined && !flag('--key-from-env')) { console.error('spend refused: the key entry was cancelled. Nothing was sent.'); process.exit(78); }
  const entry = normalizeKeyEntry(raw);   // cleans a paste (spaces, quotes, line ends); on a problem it says the kind and the length, never a character
  if (entry.key !== undefined) key = entry.key;
  else {
    console.error(`That entry (${entry.length} characters) is not usable: ${WHY[entry.problem ?? 'empty']}.${attempt < 3 && !flag('--key-from-env') ? ' Try again.' : ''}`);
    if (flag('--key-from-env')) break;
  }
}
if (!looksLikeKey(key)) { console.error('spend refused: no usable key was entered. Nothing was sent.'); process.exit(78); }
const getKey = (): string | undefined => key;
console.log('Running the check...');
const report = await runCheck({
  plan, voice, now: () => Date.now(),
  textClient: createOpenAIHttpClient({ getKey, timeoutMs: 20_000 }),
  voiceSocket: createOpenAiVoiceSocket({ model: voice.realtime_model, getKey, ...(voice.safety_identifier === undefined ? {} : { safetyIdentifier: voice.safety_identifier }), connectTimeoutMs: 8000 }),
});
key = undefined;

console.log('');
for (const c of report.checks) console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name}: ${c.code}${c.detail === undefined ? '' : ' ' + JSON.stringify(c.detail)}`);
console.log(`\nRequests: ${report.counts.textRequests} text, ${report.counts.speechRequests} spoken lines, ${report.counts.blockedSends} sends refused by the limits, ${report.counts.audioFrames} audio frames received (${report.counts.audioMs} ms).`);
console.log(`Estimated spend from the usage OpenAI reported: about $${report.estimatedUsd.toFixed(4)} (ceiling $${report.ceilingUsd.toFixed(2)}${report.withinCeiling ? '' : '; OVER THE CEILING'}). The real charge is on your OpenAI account.`);
console.log(`Elapsed ${Math.round(report.elapsedMs / 1000)} s. ${report.allPassed ? 'Every check passed.' : 'At least one check failed: see the codes above; nothing else was changed.'}`);
process.exit(report.allPassed && report.withinCeiling ? 0 : 1);
