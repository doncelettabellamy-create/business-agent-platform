// Prepares the PRIVATE files for the Drew voice phone test from the founder's existing call config, without touching that config, Twilio, or any key.
//
//   node src/founder-voice-prepare.ts [--from founder-call.config.json] [--to founder-voice-call.config.json] [--voice-to founder-voice.config.json]
//
// It writes, never overwriting an existing file:
//   * a SEPARATE call config for the voice route (default founder-voice-call.config.json): a copy of the existing one with (a) its own approval id, (b) an opening that keeps the business's approved special exactly
//     as it is in the source and swaps the default disclosure for the one that names OpenAI (src/drew-test-opening.ts), and (c) a NEW random secret path on the same tunnel host and port, so the existing
//     Twilio Bin and the existing config keep working untouched and serve as the rollback. Numbers, caps, ports, the database, the kill file, the expiry and the skill are copied as they are.
//   * the voice settings file (default founder-voice.config.json) with the proposed settings, only if it does not exist yet (an existing one is left exactly as it is).
// WHAT IT PRINTS: file names, counts, the business's special, the expiry and fixed notes. It never prints the secret path, the tunnel host, a phone number or any key; the voice entry's dry run prints the stream
// TwiML (which holds the new address) in the terminal of whoever runs it, which is how the address reaches the Twilio Bin. It reads no key and no environment variable.
// The new files hold a secret address, so they must stay private: .gitignore lists both names.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { founderConfigProblems, MAX_APPROVAL_DAYS } from './founder-call-gate.ts';
import type { FounderCallConfig } from './founder-call-gate.ts';
import { founderVoiceConfigProblems } from './founder-voice-gate.ts';
import { DREW_TEST_OPENING, DREW_TEST_SPECIAL } from './drew-test-opening.ts';
import { openingProblems } from './opening.ts';
import type { Opening } from './opening.ts';

const PLAIN = /^[\w./\\-]{1,200}\.json$/;
const WSS = /^(wss:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?)\/relay\/[A-Za-z0-9_-]{32,64}$/;

/** The proposed voice settings (the ones the founder's connection check passed with). */
export const PROPOSED_VOICE_SETTINGS = Object.freeze({
  approval_id: 'founder-voice-001', openai_model: 'gpt-6-luna', realtime_model: 'gpt-realtime-2.1', transcription_model: 'gpt-transcribe', voice: 'marin', max_openai_calls: 100,
  realtime_reasoning: 'minimal', text_reasoning: 'none', transcription: { languages: ['en'], keywords: ['Drew Cleaning'] },
  persona: { business_name: 'Drew Cleaning', traits: ['warm', 'clear', 'patient', 'professional', 'concise'], max_sentences: 2, pace: 'calm' },
});

export interface PrepareResult { ok: true; callConfig: FounderCallConfig; special: string; specialMatchesProposal: boolean; secretChanged: boolean }
/** Pure: the voice-route call config derived from the existing one, or why it cannot be. `newSecret` is injected so tests are deterministic. */
export function deriveVoiceCallConfig(source: unknown, newSecret: string): PrepareResult | { ok: false; problems: string[] } {
  const bad = founderConfigProblems(source);
  if (bad.length > 0) return { ok: false, problems: ['the existing call config is not valid, so nothing can be derived from it'] };
  const src = source as FounderCallConfig;
  const m = WSS.exec(src.public_wss_url);
  if (m === null) return { ok: false, problems: ['the existing stream address is not in the expected form'] };
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(newSecret)) return { ok: false, problems: ['the new secret path is not acceptable'] };
  const special = typeof src.opening?.special === 'string' && src.opening.special.length > 0 ? src.opening.special : DREW_TEST_SPECIAL;
  const opening: Opening = { business_name: src.opening?.business_name ?? DREW_TEST_OPENING.business_name, ...(src.opening?.agent_name === undefined ? {} : { agent_name: src.opening.agent_name }), special, disclosure: DREW_TEST_OPENING.disclosure as string };
  if (openingProblems(opening).length > 0) return { ok: false, problems: ['the opening block would not be valid'] };
  const callConfig: FounderCallConfig = { ...src, approval_id: 'founder-voice-001', opening, public_wss_url: `${m[1]}/relay/${newSecret}` };
  const again = founderConfigProblems(callConfig);
  if (again.length > 0) return { ok: false, problems: ['the derived call config would not be valid'] };
  return { ok: true, callConfig, special, specialMatchesProposal: special === DREW_TEST_SPECIAL, secretChanged: callConfig.public_wss_url !== src.public_wss_url };
}

/** Command line. Returns the process exit code; writes only through the injected functions so it is testable. */
export function runPrepare(argv: string[], io: { read(p: string): string; exists(p: string): boolean; writeNew(p: string, text: string): void; log(s: string): void; err(s: string): void; now(): number; secret(): string }): number {
  const arg = (name: string, fallback: string): string => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback; };
  const from = arg('--from', 'founder-call.config.json'); const to = arg('--to', 'founder-voice-call.config.json'); const voiceTo = arg('--voice-to', 'founder-voice.config.json');
  const known = new Set(['--from', '--to', '--voice-to', from, to, voiceTo]);
  if (argv.some((a) => !known.has(a))) { io.err('argument problem: unknown argument'); return 64; }
  for (const p of [from, to, voiceTo]) if (!PLAIN.test(p) || p.includes('..')) { io.err('argument problem: file names must be plain .json paths inside this folder'); return 64; }
  if (new Set([from, to, voiceTo]).size !== 3) { io.err('argument problem: the three file names must differ'); return 64; }
  let source: unknown;
  try { source = JSON.parse(io.read(from)); } catch { io.err('Could not read the existing call config as JSON.'); return 66; }
  const derived = deriveVoiceCallConfig(source, io.secret());
  if (!derived.ok) { for (const p of derived.problems) io.err(`prepare problem: ${p}`); return 65; }
  if (io.exists(to)) { io.err('refused: the voice call config already exists and will not be overwritten. Move it aside if you want a fresh one.'); return 73; }
  const wroteVoice = !io.exists(voiceTo);
  if (wroteVoice && founderVoiceConfigProblems(PROPOSED_VOICE_SETTINGS).length > 0) { io.err('prepare problem: the proposed voice settings are not valid'); return 65; }
  io.writeNew(to, JSON.stringify(derived.callConfig, null, 2) + '\n');
  if (wroteVoice) io.writeNew(voiceTo, JSON.stringify(PROPOSED_VOICE_SETTINGS, null, 2) + '\n');
  const c = derived.callConfig;
  const days = Math.floor((Date.parse(c.expires) - io.now()) / 86_400_000);
  io.log(`Wrote the voice call config: ${to} (a copy of ${from}; ${from} was not touched).`);
  io.log(`  approval id: ${c.approval_id}; tenant: ${c.tenant}; ${c.numbers.length} number(s); up to ${c.max_calls} calls of ${c.max_minutes} minutes; ${c.max_turns} turns each.`);
  io.log(`  opening: ${c.opening?.business_name}; special kept as in ${from}: "${derived.special}"${derived.specialMatchesProposal ? '' : ' (this differs from the proposed Drew special in src/drew-test-opening.ts)'}; the disclosure now names OpenAI and says this is a test line.`);
  io.log(`  stream address: a NEW random secret path on the same host and port as ${from} (not shown here; the dry run prints it where you run it).`);
  io.log(wroteVoice ? `Wrote the voice settings: ${voiceTo} (the proposed ones the connection check passed with).` : `Left ${voiceTo} exactly as it was.`);
  if (days < 0) io.log(`  NOTE: the approval has EXPIRED (${c.expires}); edit expires in ${to} before approving, to at most ${MAX_APPROVAL_DAYS} days from now.`);
  else if (days > MAX_APPROVAL_DAYS) io.log(`  NOTE: the expiry is more than ${MAX_APPROVAL_DAYS} days away; the gate will refuse it. Edit expires in ${to}.`);
  else io.log(`  The approval expires ${c.expires} (${days} days from now).`);
  io.log('Both new files hold a secret address and are git-ignored. Nothing was sent anywhere, no key was read, and Twilio was not touched.');
  return 0;
}

if (process.argv[1] !== undefined && /founder-voice-prepare\.ts$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const code = runPrepare(process.argv.slice(2), {
    read: (p) => readFileSync(p, 'utf8'), exists: (p) => existsSync(p), writeNew: (p, text) => writeFileSync(p, text, { encoding: 'utf8', flag: 'wx' }),
    log: (s) => console.log(s), err: (s) => console.error(s), now: () => Date.now(), secret: () => randomBytes(32).toString('base64url'),
  });
  process.exit(code);
}
