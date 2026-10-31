// INACTIVE ElevenLabs streaming client (proof of concept): a SpeechSource (src/speaker-adapter.ts) that asks the ElevenLabs text-to-speech streaming endpoint for one line of mu-law 8 kHz audio and
// hands the bytes to the adapter as they arrive. NOTHING USES IT: no service, entry point or configuration imports this file, it reads no environment variable and holds no key, and every test of it
// runs against a mock server on the loopback address. Activating it is a separate, approved step (the composition root would supply the key and the network).
//
// What the provider's documentation says (read 2026-10-31, never run against the real service):
//   POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream   header xi-api-key, content-type application/json
//   query output_format (ulaw_8000 is listed); body { text, model_id, voice_settings: { stability, similarity_boost, style, use_speaker_boost, speed } }
//   200: the audio as a streamed body, raw bytes; 422: a JSON body with a `detail` list; the other error statuses are not documented on that page.
// UNVERIFIED (assumed, to be checked on the first approved live use): the content type of the audio, the exact chunk framing, that a request cut short stops the provider's work, the 401 / 429 /
// 5xx behaviour, that every voice_settings field may be sent together, and the latency.
//
// Behaviour kept simple on purpose:
//   * ONE request per line, NO retry: a failed line is reported as failed (the adapter and the call logic handle it); a retry could speak a line twice.
//   * The key is asked for when a line starts (never at setup), is sent only in the xi-api-key header, and appears in no URL, body, log, diagnostic or error text.
//   * The provider's error body is never read into a log or an error: only the status class is recorded.
//   * CANCEL aborts the request and cancels the reader; after a cancel (or a failure) nothing more is handed to the sink, whatever the provider or the stream still delivers.
//   * Only the approved candidate settings are accepted (the voice id's shape, the approved model, the speed bounds, mu-law 8 kHz); anything else throws before any request is made.

import { APPROVED_SPEAKER_MODELS, SPEED_MAX, SPEED_MIN } from './speaker-adapter.ts';
import type { SpeechHandle, SpeechRequest, SpeechSink, SpeechSource } from './speaker-adapter.ts';
import { noDiag } from './call-diag.ts';
import type { DiagSink } from './call-diag.ts';

/** The one origin the client talks to unless a test turns on `testOnlyAllowLocalHttp`. */
export const ELEVENLABS_ORIGIN = 'https://api.elevenlabs.io';
/** The voice settings sent with every line besides the speed: the provider's documented defaults, which the founder's audition used. */
export const VOICE_SETTINGS_DEFAULTS = Object.freeze({ stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true });

export interface ElevenLabsConfig {
  /** Asked for when a line starts. The composition root reads the key from its secret store; this file never does. `undefined` or an empty string means no key. */
  getKey: () => string | undefined;
  /** The HTTP client (the platform's `fetch` in production, a loopback one in tests). Injected, so this file opens no connection of its own. */
  fetch: typeof globalThis.fetch;
  /** Default ELEVENLABS_ORIGIN. */
  origin?: string;
  /** TEST ONLY: allows an `http://127.0.0.1:<port>` or `http://localhost:<port>` origin (a mock server). */
  testOnlyAllowLocalHttp?: boolean;
  /** How long to wait for the response headers before giving up on the line. Default 4000. */
  headersTimeoutMs?: number;
  /** The most audio one line may carry, in bytes. Default 4194304. */
  maxBytes?: number;
  diag?: DiagSink;
}

type Why = 'NO_KEY' | 'TIMEOUT_HEADERS' | 'HTTP_ERROR' | 'BAD_TYPE' | 'READ_ERROR' | 'REQUEST_ERROR' | 'TOO_BIG';
const VOICE_ID = /^[A-Za-z0-9]{20}$/;
const AUDIO_TYPE = /^(?:audio\/[A-Za-z0-9.+-]+|application\/octet-stream)(?:\s*;.*)?$/i;
const within = (n: unknown, lo: number, hi: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi;

/** Why a request is not acceptable, as fixed text. Empty when it is. Pure. */
export function speechRequestProblems(r: unknown): string[] {
  if (typeof r !== 'object' || r === null) return ['request must be an object'];
  const q = r as Record<string, unknown>;
  const p: string[] = [];
  if (typeof q.text !== 'string' || q.text.length === 0 || q.text.length > 20_000) p.push('text must be 1 to 20000 characters');
  if (typeof q.voiceId !== 'string' || !VOICE_ID.test(q.voiceId)) p.push('voiceId must be a 20-character provider id');
  if (typeof q.modelId !== 'string' || !APPROVED_SPEAKER_MODELS.includes(q.modelId)) p.push('modelId is not an approved model');
  if (typeof q.speed !== 'number' || !Number.isFinite(q.speed) || q.speed < SPEED_MIN || q.speed > SPEED_MAX) p.push('speed is outside the allowed range');
  if (q.outputFormat !== 'ulaw_8000') p.push('outputFormat must be ulaw_8000');
  return p;
}

function checkedOrigin(config: ElevenLabsConfig): string {
  const origin = config.origin ?? ELEVENLABS_ORIGIN;
  if (origin === ELEVENLABS_ORIGIN) return origin;
  if (config.testOnlyAllowLocalHttp === true && /^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}$/.test(origin)) return origin;
  throw new RangeError('the ElevenLabs origin is not allowed');
}

export function createElevenLabsSpeechSource(config: ElevenLabsConfig): SpeechSource {
  if (typeof config !== 'object' || config === null || typeof config.getKey !== 'function' || typeof config.fetch !== 'function') throw new RangeError('the ElevenLabs client needs getKey and fetch');
  const origin = checkedOrigin(config);
  const headersMs = config.headersTimeoutMs ?? 4000;
  const maxBytes = config.maxBytes ?? 4_194_304;
  if (!within(headersMs, 1, 600_000) || !within(maxBytes, 1, 67_108_864)) throw new RangeError('the ElevenLabs client options are not acceptable');
  const diag = config.diag ?? noDiag;
  const doFetch = config.fetch;

  return {
    start(request: SpeechRequest, sink: SpeechSink): SpeechHandle {
      if (speechRequestProblems(request).length > 0) throw new RangeError('the speech request is not acceptable');
      const key = config.getKey();
      if (typeof key !== 'string' || key.length === 0) { diag('ELEVENLABS_FAILED', { why: 'NO_KEY' }); throw new Error('no key'); }   // fixed text: nothing about the key
      const url = `${origin}/v1/text-to-speech/${request.voiceId}/stream?output_format=${request.outputFormat}`;
      const controller = new AbortController();
      const began = Date.now();
      let stopped = false;                       // cancelled, failed or finished: nothing more reaches the sink
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let headersTimer: ReturnType<typeof setTimeout> | undefined;
      let bytes = 0;
      const stop = (): void => { stopped = true; if (headersTimer !== undefined) { clearTimeout(headersTimer); headersTimer = undefined; } };
      const abort = (): void => { try { controller.abort(); } catch { /* already aborted */ } try { void reader?.cancel().catch(() => {}); } catch { /* nothing to cancel */ } };
      const fail = (why: Why, status?: number): void => {
        if (stopped) return;
        stop(); abort();
        diag('ELEVENLABS_FAILED', { why, ...(status === undefined ? {} : { status }), ms: Date.now() - began });
        sink.fail();
      };

      diag('ELEVENLABS_REQUEST', { chars: request.text.length });
      headersTimer = setTimeout(() => fail('TIMEOUT_HEADERS'), headersMs);
      headersTimer.unref?.();
      const body = JSON.stringify({ text: request.text, model_id: request.modelId, voice_settings: { ...VOICE_SETTINGS_DEFAULTS, speed: request.speed } });
      void (async (): Promise<void> => {
        let res: Response;
        try {
          res = await doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'xi-api-key': key }, body, signal: controller.signal });
        } catch { if (!stopped) fail('REQUEST_ERROR'); return; }
        if (stopped) { try { void res.body?.cancel().catch(() => {}); } catch { /* nothing to cancel */ } return; }
        if (headersTimer !== undefined) { clearTimeout(headersTimer); headersTimer = undefined; }
        diag('ELEVENLABS_HEADERS', { status: res.status, ms: Date.now() - began });
        if (!res.ok) { try { void res.body?.cancel().catch(() => {}); } catch { /* nothing to cancel */ } fail('HTTP_ERROR', res.status); return; }   // the error body is never read
        if (!AUDIO_TYPE.test(res.headers.get('content-type') ?? '') || res.body === null) { try { void res.body?.cancel().catch(() => {}); } catch { /* nothing to cancel */ } fail('BAD_TYPE', res.status); return; }
        reader = res.body.getReader();
        let first = true;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (stopped) return;   // cancelled or failed while the read was pending: whatever it returned is dropped
            if (done) { stop(); diag('ELEVENLABS_DONE', { bytes, ms: Date.now() - began }); sink.end(); return; }
            if (!(value instanceof Uint8Array) || value.length === 0) continue;
            bytes += value.length;
            if (bytes > maxBytes) { fail('TOO_BIG'); return; }
            if (first) { first = false; diag('ELEVENLABS_FIRST_BYTES', { ms: Date.now() - began }); }
            sink.chunk(value);
          }
        } catch { if (!stopped) fail('READ_ERROR'); }
      })();
      return {
        cancel(): void {
          if (stopped) return;
          stop(); abort();
          diag('ELEVENLABS_CANCELLED', { bytes, ms: Date.now() - began });
        },
      };
    },
  };
}
