// The HTTP client for OpenAI's Responses API (founder voice test; OFFLINE until a founder-approved serve run). It is the `client.responses.create` that openai-provider.ts and openai-dialogue-model.ts are handed, built
// on Node's global `fetch`, so no package is needed. It holds the key only for the instant it builds one request's headers.
//
//   * THE ADDRESS is fixed in code (`https://api.openai.com/v1/responses`), so configuration cannot send the key elsewhere. Redirects are refused, so a redirect cannot carry it away either.
//   * THE KEY comes from `getKey()` on every request, must be plain header-safe characters, goes only into the Authorization header, and is never stored, logged, put in an address or an error. No usable key means no request.
//   * ERRORS carry a class name and, for an HTTP refusal, its status number, and nothing else: the response body (which may echo the input) is never read into an error, and no provider message travels further.
//   * BOUNDS: a timeout per request (and the caller's own signal), and a limit on the size of the answer that is read.
// It reads no environment variable, logs nothing, and has never talked to the real service. Request and answer shapes follow the Responses API as documented (unverified live).

import type { OpenAIResponse } from './openai-provider.ts';

export const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const KEY = /^[A-Za-z0-9_.-]{8,300}$/;

/** An HTTP or transport failure. Only its class name and status are ever recorded. */
export class OpenAIHttpError extends Error {
  status: number | undefined;
  constructor(status?: number) { super('openai http request failed'); this.name = 'OpenAIHttpError'; this.status = status; }
}

export interface OpenAIHttpOptions {
  /** Returns the key at the moment of each request. The file never reads the environment itself. */
  getKey: () => string | undefined;
  /** Defaults to the global fetch. A mock with this shape is used in tests. */
  fetch?: typeof fetch;
  /** Default 30000. */
  timeoutMs?: number;
  /** The longest answer read, in characters. Default 1000000. */
  maxResponseChars?: number;
}
export interface OpenAIHttpClient {
  responses: { create(params: object, options?: { signal?: AbortSignal }): Promise<OpenAIResponse> };
}

export function createOpenAIHttpClient(options: OpenAIHttpOptions): OpenAIHttpClient {
  if (typeof options !== 'object' || options === null || typeof options.getKey !== 'function' || (options.fetch !== undefined && typeof options.fetch !== 'function')
    || [options.timeoutMs, options.maxResponseChars].some((n) => n !== undefined && (!Number.isInteger(n) || n < 1 || n > 100_000_000))) {
    throw new RangeError('the OpenAI client options are not acceptable');
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxChars = options.maxResponseChars ?? 1_000_000;
  return {
    responses: {
      async create(params: object, opts?: { signal?: AbortSignal }): Promise<OpenAIResponse> {
        let key: string | undefined;
        try { key = options.getKey(); } catch { key = undefined; }
        if (typeof key !== 'string' || !KEY.test(key)) throw new OpenAIHttpError();   // no key: no request
        const doFetch = options.fetch ?? globalThis.fetch;
        const signals = [AbortSignal.timeout(timeoutMs), ...(opts?.signal === undefined ? [] : [opts.signal])];
        let res: Response;
        try {
          res = await doFetch(RESPONSES_URL, {
            method: 'POST', redirect: 'error', signal: AbortSignal.any(signals),
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(params),
          });
        } catch { throw new OpenAIHttpError(); }
        key = undefined;
        if (!res.ok) { try { await res.body?.cancel(); } catch { /* nothing to read */ } throw new OpenAIHttpError(typeof res.status === 'number' ? res.status : undefined); }
        let text: string;
        try { text = await res.text(); } catch { throw new OpenAIHttpError(); }
        if (text.length > maxChars) throw new OpenAIHttpError();
        let body: unknown;
        try { body = JSON.parse(text); } catch { throw new OpenAIHttpError(); }
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new OpenAIHttpError();
        return body as OpenAIResponse;
      },
    },
  };
}
