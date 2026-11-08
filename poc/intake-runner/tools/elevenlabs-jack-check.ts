// ISOLATED one-request diagnostic of Drew's ElevenLabs path (Stage 3). It is NOT part of Drew: nothing in src/ imports it, the call handler does not use it, and it changes no configuration.
//
//   node tools/elevenlabs-jack-check.ts           prints exactly what would be sent. No key is read and nothing is sent.
//   node tools/elevenlabs-jack-check.ts --run      asks you to type RUN-1, then sends ONE text-to-speech request and prints a fixed-code result.
//
// WHAT IT SENDS: the same request Drew sends, through the same client (src/elevenlabs-speech-source.ts): Jack's voice, the approved model and speed, ulaw_8000, and one fixed 10-character line.
// ONE request, no retry, the key only in the xi-api-key header. The audio that comes back is counted and dropped; it is never written, played or kept.
//
// THE KEY: it is read from ELEVENLABS_API_KEY in the window this program is started from, the very variable Drew reads, so the result is about the key Drew would use. It is never printed, logged,
// written or put in a URL. Run it in the window that holds the keys (after set-voice-keys.ps1).
//
// WHAT IT SHOWS: fixed words and numbers only: the result, a code, the HTTP status, the provider's reason as one of a fixed list (never its words), the audio byte count, the milliseconds and the
// character count. Never the key, a response body, a message, a voice id (only its last four characters in the plan) or any customer data.
import { createInterface } from 'node:readline/promises';
import { createElevenLabsSpeechSource, ERROR_SHAPES, PROVIDER_CODES } from '../src/elevenlabs-speech-source.ts';
import { JACK_SPEAKER } from '../src/speaker-adapter.ts';
import { looksLikeKey } from '../src/hidden-prompt.ts';

export const CHECK_TEXT = 'Drew test.';
export const MAX_REQUESTS = 1;
export const CONFIRM = 'RUN-1';
const MAX_AUDIO_BYTES = 200_000;
const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}$/;

export type CheckCode = 'AUDIO_RECEIVED' | 'NO_KEY' | 'BAD_KEY_SHAPE' | 'HTTP_ERROR' | 'TIMEOUT_HEADERS' | 'REQUEST_ERROR' | 'BAD_TYPE' | 'READ_ERROR' | 'TOO_BIG' | 'EMPTY_AUDIO' | 'TIMEOUT_TOTAL' | 'START_FAILED';
export interface CheckResult { result: 'PASS' | 'FAIL'; code: CheckCode; status?: number; reason?: string; shape?: string; providerCodes?: string[]; audioBytes: number; ms: number; chars: number; requests: number }
export interface CheckDeps {
  key: string | undefined;
  fetch: typeof globalThis.fetch;
  clock?: () => number;
  /** TEST ONLY: a loopback origin (a mock server). */
  origin?: string;
  headersTimeoutMs?: number; totalMs?: number; maxBytes?: number;
}
const FAIL_CODES: readonly string[] = ['TIMEOUT_HEADERS', 'HTTP_ERROR', 'BAD_TYPE', 'READ_ERROR', 'REQUEST_ERROR', 'TOO_BIG'];
const REASONS: readonly string[] = ['VOICE_NOT_FOUND', 'QUOTA_EXCEEDED', 'INVALID_API_KEY', 'RATE_LIMIT', 'CONCURRENT_LIMIT', 'CHAR_LIMIT', 'OTHER', 'UNPARSED'];

/** Sends at most ONE request and returns a fixed-code result. Never throws; never returns anything but fixed words and numbers. */
export async function runCheck(d: CheckDeps): Promise<CheckResult> {
  const now = d.clock ?? ((): number => Date.now()); const began = now();
  let sent = 0; let bytes = 0; let failed: { why: string; status?: number; reason?: string } | undefined; let detail: { shape: string; codes: string[] } | undefined;
  const result = (r: 'PASS' | 'FAIL', code: CheckCode, extra: { status?: number; reason?: string } = {}): CheckResult => ({ result: r, code, ...extra, ...(detail === undefined ? {} : { shape: detail.shape, providerCodes: detail.codes }), audioBytes: bytes, ms: Math.max(0, now() - began), chars: CHECK_TEXT.length, requests: sent });
  try {
    if (typeof d.key !== 'string' || d.key.length === 0) return result('FAIL', 'NO_KEY');
    if (!looksLikeKey(d.key)) return result('FAIL', 'BAD_KEY_SHAPE');
    const key = d.key;
    const diag = (code: string, detail?: Record<string, unknown>): void => {
      if (code === 'ELEVENLABS_REQUEST') sent++;
      if (code === 'ELEVENLABS_FAILED') {
        const why = typeof detail?.why === 'string' && FAIL_CODES.includes(detail.why) ? detail.why : 'REQUEST_ERROR';
        failed = { why, ...(typeof detail?.status === 'number' ? { status: detail.status } : {}), ...(typeof detail?.reason === 'string' && REASONS.includes(detail.reason) ? { reason: detail.reason } : {}) };
      }
    };
    const source = createElevenLabsSpeechSource({
      getKey: () => key, fetch: d.fetch, diag, maxBytes: d.maxBytes ?? MAX_AUDIO_BYTES,
      // only a fixed shape word and EXACT allowlisted identifiers are kept (re-checked here); the client never hands over the body
      onErrorDetail: (e) => { detail = { shape: ERROR_SHAPES.includes(e.shape) ? e.shape : 'UNPARSED', codes: e.codes.filter((c) => PROVIDER_CODES.includes(c)).slice(0, 3) }; },
      ...(d.headersTimeoutMs === undefined ? {} : { headersTimeoutMs: d.headersTimeoutMs }),
      ...(d.origin === undefined ? {} : { origin: d.origin, testOnlyAllowLocalHttp: true }),
    });
    return await new Promise<CheckResult>((resolve) => {
      let settled = false; let timer: ReturnType<typeof setTimeout> | undefined; let handle: { cancel(): void } | undefined;
      const done = (r: CheckResult): void => { if (settled) return; settled = true; if (timer !== undefined) clearTimeout(timer); resolve(r); };
      const sink = {
        chunk: (u: Uint8Array): void => { bytes += u.length; },
        end: (): void => done(bytes > 0 ? result('PASS', 'AUDIO_RECEIVED') : result('FAIL', 'EMPTY_AUDIO')),
        fail: (): void => done(failed === undefined ? result('FAIL', 'REQUEST_ERROR') : result('FAIL', failed.why as CheckCode, { ...(failed.status === undefined ? {} : { status: failed.status }), ...(failed.reason === undefined ? {} : { reason: failed.reason }) })),
      };
      timer = setTimeout(() => { try { handle?.cancel(); } catch { /* already over */ } done(result('FAIL', 'TIMEOUT_TOTAL')); }, d.totalMs ?? 15_000);
      timer.unref?.();
      try { handle = source.start({ text: CHECK_TEXT, voiceId: JACK_SPEAKER.voiceId, modelId: JACK_SPEAKER.modelId, speed: JACK_SPEAKER.speed, outputFormat: JACK_SPEAKER.outputFormat }, sink); } catch { done(result('FAIL', 'START_FAILED')); }
    });
  } catch { return result('FAIL', 'START_FAILED'); }
}

const MEANING: Readonly<Record<string, string>> = Object.freeze({
  AUDIO_RECEIVED: "ElevenLabs accepted this key and made audio in Jack's voice.",
  NO_KEY: 'ELEVENLABS_API_KEY is not set in this window. Nothing was sent.',
  BAD_KEY_SHAPE: 'The value in ELEVENLABS_API_KEY is not shaped like a key. Nothing was sent.',
  TIMEOUT_HEADERS: 'ElevenLabs did not answer in time.',
  REQUEST_ERROR: 'The request could not be sent (a network problem).',
  BAD_TYPE: 'ElevenLabs answered with something that is not audio.',
  READ_ERROR: 'The audio stream broke part-way.',
  TOO_BIG: 'The audio was longer than expected and was stopped.',
  EMPTY_AUDIO: 'ElevenLabs answered with no audio.',
  TIMEOUT_TOTAL: 'The whole check took too long and was stopped.',
  START_FAILED: 'The request could not be started.',
  'HTTP_ERROR:VOICE_NOT_FOUND': "This key's account cannot use Jack's voice.",
  'HTTP_ERROR:QUOTA_EXCEEDED': 'The account is out of credits.',
  'HTTP_ERROR:INVALID_API_KEY': 'The key is not accepted (wrong, disabled or from another account).',
  'HTTP_ERROR:RATE_LIMIT': 'The account is rate limited.',
  'HTTP_ERROR:CONCURRENT_LIMIT': 'The account is at its concurrent-request limit.',
  'HTTP_ERROR:CHAR_LIMIT': 'The text was too long for the plan.',
  'HTTP_ERROR:OTHER': 'ElevenLabs refused the request for a reason not on the short list. See ERROR_SHAPE and PROVIDER_CODE, and compare the status with the account Request Log.',
  'HTTP_ERROR:UNPARSED': 'ElevenLabs refused the request and its reason could not be read. Compare the status with the account Request Log.',
});
/** The result as lines of fixed words and numbers. Pure. */
export function show(r: CheckResult): string {
  const meaning = MEANING[r.code === 'HTTP_ERROR' ? `HTTP_ERROR:${r.reason ?? 'UNPARSED'}` : r.code] ?? '';
  return [
    `RESULT: ${r.result}`, `CODE: ${r.code}`, `HTTP_STATUS: ${r.status === undefined ? 'none' : r.status}`, `PROVIDER_REASON: ${r.reason ?? 'none'}`,
    `ERROR_SHAPE: ${r.shape ?? 'none'}`, `PROVIDER_CODE: ${r.providerCodes === undefined || r.providerCodes.length === 0 ? 'none' : r.providerCodes.join(',')}`,
    `AUDIO_BYTES: ${r.audioBytes}`, `LATENCY_MS: ${Math.round(r.ms)}`, `TEXT_CHARACTERS_SENT: ${r.requests === 0 ? 0 : r.chars}`, `REQUESTS_SENT: ${r.requests}`,
    `MEANING: ${meaning}`, 'Nothing else was sent. No key, response text or customer data is shown.',
  ].join('\n');
}

function plan(origin: string | undefined, keyPresent: boolean): string {
  return [
    `Plan: ${MAX_REQUESTS} text-to-speech request (hard limit ${MAX_REQUESTS}, no retry), through the same client Drew uses.`,
    `  Destination: ${origin === undefined ? 'api.elevenlabs.io (the real service)' : 'a loopback test server'}`,
    `  Voice: Jack (voice id ends ${JACK_SPEAKER.voiceId.slice(-4)}), model ${JACK_SPEAKER.modelId}, speed ${JACK_SPEAKER.speed}, format ${JACK_SPEAKER.outputFormat}`,
    `  Text: one fixed line of ${CHECK_TEXT.length} characters (not shown; no customer data)`,
    `  Key: read from ELEVENLABS_API_KEY in this window, the variable Drew reads. Present here: ${keyPresent ? 'yes' : 'no'}. Never shown.`,
    `  Credits: ${CHECK_TEXT.length} characters of text. At most ${CHECK_TEXT.length} credits if ElevenLabs bills one credit per character (it may bill less for this model, and may not bill a refused request). UNVERIFIED: check the account's usage after.`,
  ].join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const origin = args.includes('--origin') ? args[args.indexOf('--origin') + 1] : undefined;
  if (origin !== undefined && !LOOPBACK.test(origin)) { console.log('--origin accepts only a loopback address (a test server). Nothing was sent.'); process.exitCode = 2; return; }
  const key = process.env.ELEVENLABS_API_KEY;
  const keyPresent = typeof key === 'string' && key.length > 0;
  console.log(plan(origin, keyPresent));
  if (!args.includes('--run')) { console.log('Dry run: no key was read into the request and nothing was sent. Add --run to send.'); return; }
  const rl = createInterface({ input: process.stdin, output: process.stdout }); const closed = new Promise<string>((r) => rl.once('close', () => r('')));   // input that ends before an answer counts as no answer
  const typed = (await Promise.race([rl.question(`Type ${CONFIRM} to send ${MAX_REQUESTS} request to ElevenLabs: `), closed])).trim(); rl.close();
  if (typed !== CONFIRM) { console.log('Not confirmed. Nothing was sent.'); process.exitCode = 2; return; }
  const r = await runCheck({ key, fetch: (u, i) => fetch(u, i), ...(origin === undefined ? {} : { origin }) });
  console.log(show(r)); process.exitCode = r.result === 'PASS' ? 0 : 1;
}
if (process.argv[1] !== undefined && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) await main();
