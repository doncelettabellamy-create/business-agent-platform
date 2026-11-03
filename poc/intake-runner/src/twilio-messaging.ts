// Twilio calls the fast Drew test call needs (proof of concept): who is calling (the caller ID, read from the call's own record), sending the two booking texts ONLY to founder-approved test numbers, and checking
// that each text was delivered. Every outside thing is HANDED IN: the fetch, the clock/sleep and the token getter, so this file reads no environment variable, holds no credential and is tested against a local
// stand-in. The auth token is asked for at the moment of each request, sent only in the Authorization header, and appears in no log, no error and no result. Phone numbers and message bodies are never logged:
// diagnostics are fixed codes, counts and Twilio's numeric error codes.
//
// Texts are sent from the Drew number (it must be SMS-capable and, for US business texting, registered: see `smsCapability`; neither is assumed). A text to any number that is not on the approved list is refused
// BEFORE a request is made.

export type Diag = (code: string, detail?: Record<string, number | string | boolean>) => void;
export type HttpFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;
export interface TwilioCtx {
  accountSid: string;
  /** The auth token, asked for at each request (the entry reads the environment; this file never does). */
  authToken: () => string | undefined;
  fetch: HttpFetch;
  diag: Diag;
  /** The only numbers a text may go to (E.164). */
  approved?: ReadonlySet<string>;
  timeoutMs?: number;
  origin?: string;
}
export const SID = /^AC[0-9a-f]{32}$/;
export const E164 = /^\+[1-9]\d{9,14}$/;
const BODY = /^[\x20-\x7e\n]{1,459}$/;   // plain ASCII, at most three segments (the submitted campaign samples are two): no emoji or curly quotes (those would make the text a costlier, shorter-segment message)
const ORIGIN = 'https://api.twilio.com';

export type SmsError = 'NO_TOKEN' | 'BAD_REQUEST' | 'NOT_APPROVED' | 'REFUSED' | 'RATE_LIMITED' | 'NETWORK' | 'BAD_RESPONSE';
export type SendResult = { ok: true; sid: string } | { ok: false; error: SmsError; twilioCode?: number };

const rec = (x: unknown): Record<string, unknown> => (typeof x === 'object' && x !== null ? x as Record<string, unknown> : {});
async function call(ctx: TwilioCtx, method: 'GET' | 'POST', path: string, form?: Record<string, string>, origin?: string): Promise<{ status: number; json: Record<string, unknown> } | 'NO_TOKEN' | 'NETWORK'> {
  const token = ctx.authToken(); if (typeof token !== 'string' || token.length < 8 || !SID.test(ctx.accountSid)) return 'NO_TOKEN';
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), ctx.timeoutMs ?? 10_000);
  try {
    const res = await ctx.fetch(`${origin ?? ctx.origin ?? ORIGIN}${path}`, { method, signal: ac.signal, headers: { Authorization: `Basic ${Buffer.from(`${ctx.accountSid}:${token}`).toString('base64')}`, Accept: 'application/json', ...(form === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) }, ...(form === undefined ? {} : { body: new URLSearchParams(form).toString() }) });
    let json: Record<string, unknown> = {}; try { json = rec(JSON.parse(await res.text())); } catch { /* not JSON */ }
    return { status: res.status, json };
  } catch { return 'NETWORK'; } finally { clearTimeout(timer); }
}
const base = (ctx: TwilioCtx): string => `/2010-04-01/Accounts/${ctx.accountSid}`;

/** The number that placed a call (its caller ID), read from the call's own record by its CallSid. Undefined when it cannot be read; the caller is then asked for a number. */
export async function callerOf(ctx: TwilioCtx, callSid: unknown): Promise<string | undefined> {
  if (typeof callSid !== 'string' || !/^CA[0-9a-f]{32}$/.test(callSid)) return undefined;
  const r = await call(ctx, 'GET', `${base(ctx)}/Calls/${callSid}.json`);
  if (typeof r === 'string' || r.status !== 200) { ctx.diag('TWILIO_CALLER_UNREADABLE', { status: typeof r === 'string' ? r : r.status }); return undefined; }
  const from = r.json.from; return typeof from === 'string' && E164.test(from) ? from : undefined;
}

/** Sends one text from `from` to `to`. Refused before any request unless `to` is on the approved list, the numbers are E.164 and the body is plain ASCII of at most 320 characters. */
export async function sendSms(ctx: TwilioCtx, m: { from: string; to: string; body: string }): Promise<SendResult> {
  if (!E164.test(m.from) || !E164.test(m.to) || typeof m.body !== 'string' || !BODY.test(m.body)) return { ok: false, error: 'BAD_REQUEST' };
  if (ctx.approved === undefined || !ctx.approved.has(m.to)) { ctx.diag('TWILIO_SMS_REFUSED', { reason: 'NOT_APPROVED' }); return { ok: false, error: 'NOT_APPROVED' }; }
  const r = await call(ctx, 'POST', `${base(ctx)}/Messages.json`, { To: m.to, From: m.from, Body: m.body });
  if (r === 'NO_TOKEN') return { ok: false, error: 'NO_TOKEN' };
  if (r === 'NETWORK') { ctx.diag('TWILIO_SMS_FAILED', { reason: 'NETWORK' }); return { ok: false, error: 'NETWORK' }; }
  if (r.status === 429) return { ok: false, error: 'RATE_LIMITED' };
  const sid = r.json.sid;
  if (r.status < 200 || r.status >= 300 || typeof sid !== 'string' || !/^SM[0-9a-f]{32}$/.test(sid)) { const code = typeof r.json.code === 'number' ? r.json.code : undefined; ctx.diag('TWILIO_SMS_FAILED', { status: r.status, ...(code === undefined ? {} : { twilioCode: code }) }); return { ok: false, error: 'REFUSED', ...(code === undefined ? {} : { twilioCode: code }) }; }
  ctx.diag('TWILIO_SMS_SENT'); return { ok: true, sid };
}

export type Delivery = 'delivered' | 'undelivered' | 'failed' | 'unconfirmed';
/** Reads one message's status until it is final: `delivered`; `undelivered` or `failed` (with Twilio's error code in the diagnostics); or `unconfirmed` when it has not become final within `maxMs` (a text that was only `sent` is NOT called delivered). */
export async function verifyDelivery(ctx: TwilioCtx, sid: string, o: { maxMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<Delivery> {
  if (!/^SM[0-9a-f]{32}$/.test(sid)) return 'unconfirmed';
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))); const maxMs = o.maxMs ?? 20_000; const interval = o.intervalMs ?? 1500;
  let waited = 0;
  for (;;) {
    const r = await call(ctx, 'GET', `${base(ctx)}/Messages/${sid}.json`);
    if (typeof r !== 'string' && r.status === 200) {
      const s = String(r.json.status ?? '');
      if (s === 'delivered') { ctx.diag('TWILIO_SMS_DELIVERED'); return 'delivered'; }
      if (s === 'undelivered' || s === 'failed' || s === 'canceled') { ctx.diag('TWILIO_SMS_NOT_DELIVERED', { status: s, ...(typeof r.json.error_code === 'number' ? { twilioCode: r.json.error_code } : {}) }); return s === 'failed' ? 'failed' : 'undelivered'; }
    }
    if (waited >= maxMs) { ctx.diag('TWILIO_SMS_UNCONFIRMED'); return 'unconfirmed'; }
    await sleep(interval); waited += interval;
  }
}

/**
 * Where US business texting stands for this account, READ ONLY and by status words only: the brand registrations, each messaging service with its campaign (A2P 10DLC) registrations and whether the number is attached to it,
 * and any toll-free verifications. It cannot say whether a text WILL be delivered (carriers decide), only what has been registered. `undefined` fields mean the answer could not be read (not "none").
 */
export interface MessagingSetup { brands?: string[]; services?: Array<{ campaigns?: string[]; hasNumber?: boolean }>; tollFree?: string[] }
export async function messagingSetup(ctx: TwilioCtx, number: string, messagingOrigin = 'https://messaging.twilio.com'): Promise<MessagingSetup> {
  const out: MessagingSetup = {};
  const list = async (path: string, key: string): Promise<Array<Record<string, unknown>> | undefined> => { const r = await call(ctx, 'GET', path, undefined, messagingOrigin); if (typeof r === 'string' || r.status !== 200) return undefined; const a = r.json[key]; return Array.isArray(a) ? a.map(rec) : undefined; };
  const status = (x: Record<string, unknown>): string => (typeof x.status === 'string' && /^[A-Za-z_ -]{1,40}$/.test(x.status) ? x.status : 'unknown');
  const brands = await list('/v1/a2p/BrandRegistrations', 'data'); if (brands !== undefined) out.brands = brands.map(status);
  const services = await list('/v1/Services', 'services');
  if (services !== undefined) {
    out.services = [];
    for (const s of services.slice(0, 10)) {
      const sid = typeof s.sid === 'string' && /^MG[0-9a-f]{32}$/.test(s.sid) ? s.sid : undefined; if (sid === undefined) continue;
      const camps = await list(`/v1/Services/${sid}/Compliance/Usa2p`, 'compliance'); const nums = await list(`/v1/Services/${sid}/PhoneNumbers`, 'phone_numbers');
      out.services.push({ ...(camps === undefined ? {} : { campaigns: camps.map((c) => (typeof c.campaign_status === 'string' && /^[A-Za-z_ -]{1,40}$/.test(c.campaign_status) ? c.campaign_status : status(c))) }), ...(nums === undefined ? {} : { hasNumber: nums.some((n) => n.phone_number === number) }) });
    }
  }
  const tf = await list('/v1/Tollfree/Verifications', 'verifications'); if (tf !== undefined) out.tollFree = tf.map(status);
  return out;
}

/** Whether a number on the account can send texts, from the account's own record of the number. Capabilities only; registration for US business texting is a separate question this does not answer. */
export async function smsCapability(ctx: TwilioCtx, number: string): Promise<{ status: 'found' | 'not_found' | 'unreadable'; sms?: boolean; mms?: boolean; voice?: boolean }> {
  if (!E164.test(number)) return { status: 'unreadable' };
  const r = await call(ctx, 'GET', `${base(ctx)}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`);
  if (typeof r === 'string' || r.status !== 200) return { status: 'unreadable' };
  const list = Array.isArray(r.json.incoming_phone_numbers) ? r.json.incoming_phone_numbers : [];
  if (list.length === 0) return { status: 'not_found' };
  const cap = rec(rec(list[0]).capabilities);
  return { status: 'found', sms: cap.sms === true, mms: cap.mms === true, voice: cap.voice === true };
}
