// Why does the Realtime connection fail? Node's built-in WebSocket cannot say: for a refused key, a model the key cannot use, a missing endpoint, a closed socket and an unreachable host it reports the same empty error
// event and close code 1006 (checked on 2026-10-27 against local listeners that answered 401, 404, nothing at all, and a refused port). This file asks the questions that CAN be answered, using only the HTTP status
// and a fixed error code, so the founder can see the cause without a key, a header or a response body ever being shown:
//
//   1. THE HANDSHAKE ITSELF, made by hand over node:https exactly as a WebSocket client makes it (an HTTP upgrade request to the Realtime address with the key in the Authorization header). The answer is either
//      101 (the service accepts the connection; the socket is closed straight away and nothing is sent or billed) or a status such as 401, 403, 404 or 429 with the error's `code` or `type`.
//   2. MODEL ACCESS: `GET /v1/models/<model>` (is the model visible to this key?) and `GET /v1/models` (which Realtime, live and transcription models ARE visible: ids only).
//   3. REALTIME PERMISSION: `POST /v1/realtime/client_secrets` with a 10-second life and the same model, which succeeds only for a key allowed to use the Realtime API with that model. The secret that comes back is
//      never read: the body of a success is thrown away unread.
//   None of these creates a response or sends audio, so none of them is billed to the best of the documentation (the pricing pages list no charge for them; unverified).
//
// THE KEY comes from `getKey()` for each request, must be plain header-safe characters, goes only into an Authorization header, and is never stored, logged, put in a URL or an error. The addresses are fixed in
// code (api.openai.com). What comes back is reduced to: a status number, a short code that matches a strict pattern (otherwise dropped), booleans, counts and model ids. This file reads no environment variable.

import { request as httpsRequest } from 'node:https';
import { randomBytes } from 'node:crypto';

const HOST = 'api.openai.com';
const KEY = /^[A-Za-z0-9_.-]{8,300}$/;
const MODEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const FAMILY = /realtime|live|transcribe|whisper|audio/i;

export interface HttpAnswer { status: number | 'none'; code?: string; why?: 'no_key' | 'network' | 'timeout' | 'bad_answer'; cause?: string }
export interface HandshakeAnswer { outcome: 'upgraded' | 'refused' | 'network' | 'timeout' | 'no_key'; status?: number; code?: string; cause?: string }
export interface Diagnosis {
  handshake: HandshakeAnswer;
  modelLookup: HttpAnswer;
  clientSecret: HttpAnswer;
  /** Visible model ids that look like voice, live or transcription models (at most 25), and whether the configured model is among all visible ids. Undefined when the list could not be read. */
  visible?: { ids: string[]; hasModel: boolean; total: number };
  listStatus: number | 'none';
  /** Fixed plain-language readings of the answers above: static text, never text from the service. */
  findings: string[];
}
export interface ProbeDeps {
  model: string;
  getKey: () => string | undefined;
  /** Defaults to the global fetch. A mock with this shape is used in tests. */
  fetch?: typeof fetch;
  /** Defaults to node:https `request`. A fake with this shape is used in tests. */
  request?: typeof httpsRequest;
  timeoutMs?: number;
}

const safeCode = (x: unknown): string | undefined => (typeof x === 'string' && SAFE_CODE.test(x) ? x : undefined);
const cleanKey = (getKey: () => string | undefined): string | undefined => { try { const k = getKey(); return typeof k === 'string' && KEY.test(k) ? k : undefined; } catch { return undefined; } };
const causeOf = (e: unknown): string | undefined => { const c = (e as { code?: unknown; cause?: { code?: unknown } } | null); return safeCode(c?.code) ?? safeCode(c?.cause?.code); };
/** The error code or type from an OpenAI error body, if it is one and matches the strict pattern. Anything else is dropped. */
function codeFromBody(text: string): string | undefined {
  try { const b = JSON.parse(text) as { error?: { code?: unknown; type?: unknown } }; return safeCode(b?.error?.code) ?? safeCode(b?.error?.type); } catch { return undefined; }
}

/** The WebSocket handshake by hand. Resolves with the status of the service's answer; never throws, never carries a header or a body. */
export function probeHandshake(d: ProbeDeps): Promise<HandshakeAnswer> {
  return new Promise((resolve) => {
    if (!MODEL.test(d.model)) { resolve({ outcome: 'network', cause: 'BAD_MODEL_ID' }); return; }
    const key = cleanKey(d.getKey);
    if (key === undefined) { resolve({ outcome: 'no_key' }); return; }
    const timeoutMs = d.timeoutMs ?? 10_000;
    let settled = false;
    const finish = (a: HandshakeAnswer): void => { if (settled) return; settled = true; clearTimeout(timer); try { req.destroy(); } catch { /* already gone */ } resolve(a); };
    const req = (d.request ?? httpsRequest)({
      host: HOST, port: 443, method: 'GET', path: `/v1/realtime?model=${d.model}`,
      headers: { Authorization: `Bearer ${key}`, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64') },
    });
    const timer = setTimeout(() => finish({ outcome: 'timeout' }), timeoutMs); timer.unref?.();
    req.on('upgrade', (res, socket) => { try { socket.destroy(); } catch { /* already gone */ } finish({ outcome: 'upgraded', status: res.statusCode ?? 101 }); });
    req.on('response', (res) => {
      const status = res.statusCode ?? 0;
      let body = '';
      res.setEncoding?.('utf8');
      res.on('data', (c: string) => { if (body.length < 4096) body += c; });
      res.on('end', () => finish({ outcome: 'refused', status, ...(codeFromBody(body) === undefined ? {} : { code: codeFromBody(body) }) }));
      res.on('error', () => finish({ outcome: 'refused', status }));
    });
    req.on('error', (e) => finish({ outcome: 'network', ...(causeOf(e) === undefined ? {} : { cause: causeOf(e) }) }));
    req.end();
  });
}

async function call(d: ProbeDeps, method: 'GET' | 'POST', path: string, body?: object, readSuccess = false): Promise<{ answer: HttpAnswer; text?: string }> {
  const key = cleanKey(d.getKey);
  if (key === undefined) return { answer: { status: 'none', why: 'no_key' } };
  try {
    const res = await (d.fetch ?? globalThis.fetch)(`https://${HOST}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(d.timeoutMs ?? 10_000),
      headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.ok) {
      if (!readSuccess) { try { await res.body?.cancel(); } catch { /* nothing to read */ } return { answer: { status: res.status } }; }
      const text = (await res.text()).slice(0, 2_000_000);
      return { answer: { status: res.status }, text };
    }
    let code: string | undefined;
    try { code = codeFromBody((await res.text()).slice(0, 4096)); } catch { code = undefined; }
    return { answer: { status: res.status, ...(code === undefined ? {} : { code }) } };
  } catch (e) {
    const isTimeout = (e as { name?: unknown })?.name === 'TimeoutError';
    const cause = causeOf(e);
    return { answer: { status: 'none', why: isTimeout ? 'timeout' : 'network', ...(cause === undefined ? {} : { cause }) } };
  }
}

/** Pure: the plain-language readings of the answers, as fixed text. */
export function findingsFor(h: HandshakeAnswer, lookup: HttpAnswer, secret: HttpAnswer, visible: Diagnosis['visible'], listStatus: number | 'none'): string[] {
  const f: string[] = [];
  const st = (s: number | 'none' | undefined): string => (s === undefined ? 'no status' : String(s));
  if (h.outcome === 'upgraded') f.push('HANDSHAKE_OK: the service accepted the Realtime connection (status 101) and it was closed again. So the key, the model and the address are fine, and the earlier failure was in the WebSocket client or on the network path. Run the check again.');
  else if (h.outcome === 'no_key') f.push('NO_KEY: no usable key was available for the handshake.');
  else if (h.outcome === 'timeout') f.push('HANDSHAKE_TIMEOUT: the service did not answer the connection request in time. Suspect a firewall, a proxy or a network that blocks WebSocket upgrades.');
  else if (h.outcome === 'network') f.push(`NETWORK_PROBLEM: the connection could not be made (${h.cause ?? 'no code'}). Suspect DNS, a firewall, a proxy or TLS inspection on this network.`);
  else if (h.status === 401) f.push('KEY_REJECTED_FOR_REALTIME: the Realtime endpoint answered 401. The key is not accepted there (a text request with the same key worked, so suspect a key restricted to certain endpoints, or the wrong project).');
  else if (h.status === 403) f.push('KEY_NOT_ALLOWED_FOR_REALTIME: the Realtime endpoint answered 403. The key or project is not permitted to use the Realtime API or this model (check the key\'s permissions and the project\'s model access).');
  else if (h.status === 404) f.push('MODEL_OR_ENDPOINT_NOT_FOUND: the Realtime endpoint answered 404. Suspect a model id this key cannot see.');
  else if (h.status === 400) f.push('REQUEST_REJECTED: the Realtime endpoint answered 400. Suspect a model id that is not valid for Realtime.');
  else if (h.status === 429) f.push('QUOTA_OR_RATE_LIMIT: the Realtime endpoint answered 429. Suspect a billing or usage limit on this project.');
  else if (typeof h.status === 'number' && h.status >= 500) f.push(`SERVICE_ERROR: the Realtime endpoint answered ${h.status}. Try again later.`);
  else f.push(`HANDSHAKE_REFUSED: the Realtime endpoint answered ${st(h.status)}.`);
  if (typeof lookup.status === 'number') f.push(lookup.status === 200 ? 'MODEL_VISIBLE: this key can see the configured model.' : lookup.status === 404 ? 'MODEL_NOT_VISIBLE: this key cannot see the configured model id (see the visible voice and transcription models below).' : `MODEL_LOOKUP_${lookup.status}: the model lookup answered ${lookup.status}.`);
  if (typeof secret.status === 'number') f.push(secret.status === 200 ? 'REALTIME_PERMISSION_OK: a Realtime session could be created for this model with this key.' : `REALTIME_PERMISSION_${secret.status}: creating a Realtime session answered ${secret.status}.`);
  if (visible !== undefined && !visible.hasModel) f.push('MODEL_NOT_LISTED: the configured model id is not in the list this key can see.');
  if (listStatus !== 200 && listStatus !== 'none') f.push(`MODEL_LIST_${listStatus}: the model list answered ${listStatus} (a restricted key may not be allowed to list models).`);
  return f;
}

/** The whole diagnosis. Three kinds of request, all free as far as the documentation says; the answers reduced as described at the top. */
export async function diagnoseRealtime(d: ProbeDeps): Promise<Diagnosis> {
  const handshake = await probeHandshake(d);
  const lookup = (await call(d, 'GET', `/v1/models/${MODEL.test(d.model) ? d.model : 'invalid'}`)).answer;
  const secret = (await call(d, 'POST', '/v1/realtime/client_secrets', { expires_after: { anchor: 'created_at', seconds: 10 }, session: { type: 'realtime', model: d.model } })).answer;
  const list = await call(d, 'GET', '/v1/models', undefined, true);
  let visible: Diagnosis['visible'];
  if (list.text !== undefined) {
    try {
      const data = (JSON.parse(list.text) as { data?: Array<{ id?: unknown }> }).data;
      if (Array.isArray(data)) {
        const all = data.map((m) => m?.id).filter((id): id is string => typeof id === 'string' && SAFE_CODE.test(id));
        visible = { ids: all.filter((id) => FAMILY.test(id)).sort().slice(0, 25), hasModel: all.includes(d.model), total: all.length };
      }
    } catch { visible = undefined; }
  }
  return { handshake, modelLookup: lookup, clientSecret: secret, ...(visible === undefined ? {} : { visible }), listStatus: list.answer.status, findings: findingsFor(handshake, lookup, secret, visible, list.answer.status) };
}
