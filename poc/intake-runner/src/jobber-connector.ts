// Standalone Jobber connector (proof of concept; the founder's Jobber DEVELOPER TEST ACCOUNT only). READ-ONLY. NOT connected to the voice server, the call logic, the booking checkpoint (simulated-booking.ts)
// or any tool: nothing imports this file except its own entry point (jobber-connect-main.ts) and its tests.
//
// What it does (Jobber's documented OAuth 2.0 authorization-code flow, checked against developer.getjobber.com on 2026-11-01):
//   * builds the authorize link with a random STATE and a PKCE S256 challenge, listens for the redirect on this machine only, checks the state (constant time, single use, 10 minutes),
//   * exchanges the code (form-encoded, from this process, never from a browser), and stores the tokens PROTECTED (see the Protector: Windows DPAPI in production) in a private folder outside the repository,
//   * refreshes the access token (60 minutes) and handles refresh-token ROTATION: the new refresh token is saved BEFORE the new access token is used, a lock stops two refreshes at once,
//   * sends GraphQL QUERIES only (a document that contains `mutation` or `subscription` is refused before anything is sent),
//   * checks WHICH account it is connected to (name, and the id once pinned) before any other data is read.
// Secrets (client secret, authorization code, access token, refresh token, PKCE verifier, state) are never logged, never put in an error message and never printed. Diagnostics are fixed codes and numbers.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const JOBBER_ENDPOINTS = Object.freeze({ authorize: 'https://api.getjobber.com/api/oauth/authorize', token: 'https://api.getjobber.com/api/oauth/token', graphql: 'https://api.getjobber.com/api/graphql' });
/** An active version from Jobber's changelog (2026-09-25 is the newest listed on 2026-11-01); the response's own version information is reported so a downgrade or upgrade is visible. */
export const GRAPHQL_VERSION = '2026-09-25';
export const DEFAULT_CALLBACK_PORT = 8765;
export const CALLBACK_PATH = '/jobber/callback';
/** The exact OAuth Callback URL to enter in the Jobber Developer Center for this connector. */
export const callbackUrlFor = (port: number): string => `http://localhost:${port}${CALLBACK_PATH}`;

export type ConnectorCode = 'NO_CREDENTIALS' | 'NOT_CONNECTED' | 'RECONNECT_REQUIRED' | 'DENIED' | 'EXCHANGE_FAILED' | 'ACCOUNT_MISMATCH' | 'ACCOUNT_UNREADABLE' | 'RATE_LIMITED' | 'API_ERROR' | 'NOT_READ_ONLY' | 'TIMEOUT' | 'BAD_CONFIG' | 'BAD_RESPONSE';
/** An error whose message is a fixed code word only: it can never carry a secret. */
export class JobberError extends Error { readonly code: ConnectorCode; /** Only for ACCOUNT_MISMATCH: the NAME of the account that answered (a business name, not a secret), so the founder can see which account it was. */ readonly foundAccountName?: string; constructor(code: ConnectorCode, foundAccountName?: string) { super(code); this.code = code; this.name = 'JobberError'; if (foundAccountName !== undefined) this.foundAccountName = foundAccountName; } }

export type Diag = (code: string, detail?: Record<string, number | string | boolean>) => void;
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;
/** Protects a string for storage on this machine and reverses it. Production: Windows DPAPI for the current user (jobber-dpapi.ts). */
export interface Protector { protect(plain: string): Promise<string>; unprotect(blob: string): Promise<string> }
export interface Endpoints { authorize: string; token: string; graphql: string }
export interface Credentials { client_id: string; client_secret: string }
export interface StoredTokens { access_token: string; refresh_token: string; /** epoch milliseconds */ expires_at: number; account_id: string; account_name: string }

const ID = /^[A-Za-z0-9_.:\-]{8,200}$/;
const TOKEN = /^[A-Za-z0-9_.\-+/=]{8,4096}$/;
const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sameText = (a: string, b: string): boolean => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** A PKCE pair: a random verifier of 64 unreserved characters and its S256 challenge (base64url of the SHA-256, no padding). */
export function pkcePair(random: (n: number) => Buffer = randomBytes): { verifier: string; challenge: string } {
  const verifier = b64url(random(48));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

// ---------------------------------------------------------------- protected storage
/** The private folder: credentials and tokens, each protected by the Protector, written atomically. Never inside the repository (the entry point defaults to the user's home folder). */
export function createVault(dir: string, protector: Protector) {
  const credFile = join(dir, 'credentials.enc'); const tokFile = join(dir, 'tokens.enc');
  const NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
  const ensure = (): void => { mkdirSync(dir, { recursive: true }); };
  const atomic = (file: string, text: string): void => { ensure(); const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, text, { mode: 0o600 }); renameSync(tmp, file); };
  const readJson = async <T>(file: string, ok: (x: unknown) => x is T): Promise<T | undefined> => {
    if (!existsSync(file)) return undefined;
    try { const x = JSON.parse(await protector.unprotect(readFileSync(file, 'utf8').trim())); return ok(x) ? x : undefined; } catch { return undefined; }
  };
  const isCreds = (x: unknown): x is Credentials => typeof x === 'object' && x !== null && ID.test((x as Credentials).client_id) && typeof (x as Credentials).client_secret === 'string' && (x as Credentials).client_secret.length >= 8;
  const isTokens = (x: unknown): x is StoredTokens => { const t = x as StoredTokens; return typeof t === 'object' && t !== null && TOKEN.test(t.access_token) && TOKEN.test(t.refresh_token) && Number.isFinite(t.expires_at) && typeof t.account_id === 'string' && typeof t.account_name === 'string'; };
  return {
    dir,
    async saveCredentials(c: Credentials): Promise<void> { if (!isCreds(c)) throw new JobberError('BAD_CONFIG'); atomic(credFile, await protector.protect(JSON.stringify({ client_id: c.client_id, client_secret: c.client_secret }))); },
    loadCredentials: (): Promise<Credentials | undefined> => readJson(credFile, isCreds),
    async saveTokens(t: StoredTokens): Promise<void> { if (!isTokens(t)) throw new JobberError('BAD_RESPONSE'); atomic(tokFile, await protector.protect(JSON.stringify(t))); },
    loadTokens: (): Promise<StoredTokens | undefined> => readJson(tokFile, isTokens),
    clearTokens(): void { rmSync(tokFile, { force: true }); },
    /** A named protected text file in the private folder (the booking ledger). */
    async saveBlob(name: string, text: string): Promise<void> { if (!NAME.test(name)) throw new JobberError('BAD_CONFIG'); atomic(join(dir, `${name}.enc`), await protector.protect(text)); },
    async loadBlob(name: string): Promise<string | undefined> { if (!NAME.test(name)) throw new JobberError('BAD_CONFIG'); const p = join(dir, `${name}.enc`); if (!existsSync(p)) return undefined; try { return await protector.unprotect(readFileSync(p, 'utf8').trim()); } catch { return undefined; } },
    withRefreshLock<T>(fn: () => Promise<T>, waitMs = 8000): Promise<T> { return this.withLock('refresh', fn, waitMs); },
    /** Runs `fn` while holding the named lock (one holder at a time, even across processes); a lock older than 30 s is treated as abandoned. */
    async withLock<T>(name: string, fn: () => Promise<T>, waitMs = 8000): Promise<T> {
      if (!NAME.test(name)) throw new JobberError('BAD_CONFIG');
      const lockFile = join(dir, `${name}.lock`);
      ensure(); const until = Date.now() + waitMs;
      for (;;) {
        try { closeSync(openSync(lockFile, 'wx')); break; } catch {
          try { if (Date.now() - statSync(lockFile).mtimeMs > 30_000) rmSync(lockFile, { force: true }); } catch { /* raced */ }
          if (Date.now() > until) throw new JobberError('TIMEOUT');
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      try { return await fn(); } finally { rmSync(lockFile, { force: true }); }
    },
  };
}
export type Vault = ReturnType<typeof createVault>;

// ---------------------------------------------------------------- HTTP
export interface Ctx { vault: Vault; endpoints: Endpoints; fetch: FetchLike; now: () => number; diag: Diag; version?: string; timeoutMs?: number; /** A provisional access token (during authorization, before anything is stored): used as is, never refreshed. */ bearer?: string;
  /** WRITES ARE OFF unless this is set (the entry point never sets it). When set, `mutate` still refuses every call unless the connected account is exactly this test account (and the id pinned at authorization). */ allowWrites?: { expectedAccountName: string } }
async function send(ctx: Ctx, url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; json: unknown }> {
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), ctx.timeoutMs ?? 15_000);
  try {
    const res = await ctx.fetch(url, { ...init, signal: ac.signal });
    let json: unknown; try { json = JSON.parse(await res.text()); } catch { json = undefined; }
    return { status: res.status, json };
  } catch { throw new JobberError('TIMEOUT'); } finally { clearTimeout(timer); }
}
const form = (o: Record<string, string>): string => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
const rec = (x: unknown): Record<string, unknown> => (typeof x === 'object' && x !== null ? x as Record<string, unknown> : {});

async function tokenCall(ctx: Ctx, body: Record<string, string>): Promise<{ access_token: string; refresh_token: string | undefined; expires_in: number }> {
  const r = await send(ctx, ctx.endpoints.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form(body) });
  const j = rec(r.json);
  if (typeof j.warning === 'string') ctx.diag('JOBBER_TOKEN_WARNING');   // the text is not logged
  if (r.status === 429) throw new JobberError('RATE_LIMITED');
  if (r.status < 200 || r.status >= 300 || typeof j.access_token !== 'string' || !TOKEN.test(j.access_token)) { ctx.diag('JOBBER_TOKEN_REFUSED', { status: r.status }); throw new JobberError(body.grant_type === 'refresh_token' ? 'RECONNECT_REQUIRED' : 'EXCHANGE_FAILED'); }
  const refresh = typeof j.refresh_token === 'string' && TOKEN.test(j.refresh_token) ? j.refresh_token : undefined;
  const expiresIn = typeof j.expires_in === 'number' && j.expires_in > 0 && j.expires_in <= 86_400 ? j.expires_in : 3600;
  return { access_token: j.access_token, refresh_token: refresh, expires_in: expiresIn };
}
/** The access token's own expiry (JWT `exp`), when readable; the earlier of it and expires_in wins. */
function jwtExpiryMs(token: string): number | undefined {
  try { const exp = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')).exp; return typeof exp === 'number' ? exp * 1000 : undefined; } catch { return undefined; }
}
const expiryOf = (ctx: Ctx, access: string, expiresIn: number): number => Math.min(ctx.now() + expiresIn * 1000, jwtExpiryMs(access) ?? Infinity);

/** A usable access token. Refreshes (with rotation) when it is within 60 s of expiry, or when `force` is set. The new refresh token is saved BEFORE the new access token is returned. */
export async function accessToken(ctx: Ctx, creds: Credentials, force = false, staleToken?: string): Promise<string> {
  const first = await ctx.vault.loadTokens();
  if (first === undefined) throw new JobberError('NOT_CONNECTED');
  if (!force && first.expires_at - ctx.now() > 60_000) return first.access_token;
  return ctx.vault.withRefreshLock(async () => {
    const cur = await ctx.vault.loadTokens();   // another process may have refreshed while this one waited: reload, never reuse a stale variable
    if (cur === undefined) throw new JobberError('NOT_CONNECTED');
    if (cur.access_token !== first.access_token || (staleToken !== undefined && cur.access_token !== staleToken)) { if (cur.expires_at - ctx.now() > 60_000) return cur.access_token; }
    const t = await tokenCall(ctx, { client_id: creds.client_id, client_secret: creds.client_secret, grant_type: 'refresh_token', refresh_token: cur.refresh_token });
    await ctx.vault.saveTokens({ ...cur, access_token: t.access_token, refresh_token: t.refresh_token ?? cur.refresh_token, expires_at: expiryOf(ctx, t.access_token, t.expires_in) });   // saved first
    ctx.diag('JOBBER_TOKEN_REFRESHED', { rotated: t.refresh_token !== undefined && t.refresh_token !== cur.refresh_token });
    return t.access_token;
  });
}

// ---------------------------------------------------------------- GraphQL (queries only)
/** True when the document is a query: comments and string literals are removed first, then `mutation` and `subscription` are refused anywhere. */
export function isReadOnlyDocument(doc: string): boolean {
  if (typeof doc !== 'string' || doc.length === 0 || doc.length > 8000) return false;
  const bare = doc.replace(/#[^\n]*/g, ' ').replace(/"""[\s\S]*?"""/g, ' ').replace(/"(?:[^"\\]|\\.)*"/g, ' ');
  return !/\b(?:mutation|subscription)\b/i.test(bare);
}
export interface GqlResult { data: Record<string, unknown>; version: string | undefined; cost: { requested: number | undefined; available: number | undefined } }
export async function query(ctx: Ctx, creds: Credentials, doc: string, variables?: Record<string, unknown>): Promise<GqlResult> {
  if (!isReadOnlyDocument(doc)) throw new JobberError('NOT_READ_ONLY');
  return run(ctx, creds, doc, variables);
}
async function run(ctx: Ctx, creds: Credentials, doc: string, variables?: Record<string, unknown>): Promise<GqlResult> {
  let token = ctx.bearer ?? await accessToken(ctx, creds);
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await send(ctx, ctx.endpoints.graphql, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-JOBBER-GRAPHQL-VERSION': ctx.version ?? GRAPHQL_VERSION, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: doc, ...(variables === undefined ? {} : { variables }) }) });
    if (r.status === 401 && attempt === 0 && ctx.bearer === undefined) { token = await accessToken(ctx, creds, true, token); continue; }
    if (r.status === 401) throw new JobberError('RECONNECT_REQUIRED');
    if (r.status === 429) throw new JobberError('RATE_LIMITED');
    const j = rec(r.json);
    if (r.status < 200 || r.status >= 300) { ctx.diag('JOBBER_API_REFUSED', { status: r.status }); throw new JobberError('API_ERROR'); }
    const errs = Array.isArray(j.errors) ? j.errors : [];
    if (errs.length > 0) {
      const codes = errs.map((e) => String(rec(rec(e).extensions).code ?? 'ERROR')).filter((c) => /^[A-Z_]{1,40}$/.test(c)).slice(0, 5).join(',');
      ctx.diag('JOBBER_API_ERRORS', { count: errs.length, codes });
      throw new JobberError(codes.includes('THROTTLED') ? 'RATE_LIMITED' : 'API_ERROR');
    }
    const ext = rec(j.extensions); const cost = rec(ext.cost); const th = rec(cost.throttleStatus);
    const v = rec(ext.versioning).version;
    return { data: rec(j.data), version: typeof v === 'string' ? v : undefined, cost: { requested: typeof cost.requestedQueryCost === 'number' ? cost.requestedQueryCost : undefined, available: typeof th.currentlyAvailable === 'number' ? th.currentlyAvailable : undefined } };
  }
  throw new JobberError('RECONNECT_REQUIRED');
}

// ---------------------------------------------------------------- the few allowed writes (test account only)
/** The only mutations this connector can ever send: a test client with its property, and a test job. Nothing that deletes, archives, closes or disconnects is on the list. */
export const WRITE_ALLOWLIST: readonly string[] = Object.freeze(['clientCreate', 'jobCreate']);
/** The top-level fields of a mutation document (comments and strings removed). An alias, a second operation or anything that is not a plain field makes it undefined. */
export function mutationFields(doc: string): string[] | undefined {
  if (typeof doc !== 'string' || doc.length === 0 || doc.length > 12_000) return undefined;
  const bare = doc.replace(/#[^\n]*/g, ' ').replace(/"""[\s\S]*?"""/g, ' ').replace(/"(?:[^"\\]|\\.)*"/g, ' ');
  const head = /^\s*mutation\b\s*[A-Za-z_]\w*\s*(\([^)]*\))?\s*\{/.exec(bare);
  if (head === null || /\b(?:query|subscription|fragment)\b/.test(bare)) return undefined;
  const fields: string[] = []; let depth = 1; let i = head[0].length; let expectField = true;
  while (i < bare.length && depth > 0) {
    const c = bare[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') { depth--; if (depth === 1) expectField = true; }
    else if (depth === 1 && /\s/.test(c)) { /* between tokens */ }
    else if (depth === 1) {
      const m = /^([A-Za-z_]\w*)\s*([({:@])/.exec(bare.slice(i));
      if (m === null || !expectField || m[2] === ':' || m[2] === '@') return undefined;   // an alias or a directive is refused
      fields.push(m[1]); expectField = false; i += m[1].length; continue;
    }
    i++;
  }
  return depth === 0 && fields.length > 0 && bare.slice(i).trim() === '' ? fields : undefined;
}
/** Sends one allowed mutation. Refused unless writes were switched on in `ctx`, every top-level field is on the allowlist, and the connected account is exactly the expected test account (name and pinned id), checked again before EVERY write. */
export async function mutate(ctx: Ctx, creds: Credentials, doc: string, variables: Record<string, unknown>): Promise<GqlResult> {
  if (ctx.allowWrites === undefined) throw new JobberError('NOT_READ_ONLY');
  const fields = mutationFields(doc);
  if (fields === undefined || fields.some((x) => !WRITE_ALLOWLIST.includes(x))) { ctx.diag('JOBBER_WRITE_REFUSED', { reason: 'NOT_ALLOWED' }); throw new JobberError('NOT_READ_ONLY'); }
  const tokens = await ctx.vault.loadTokens(); if (tokens === undefined) throw new JobberError('NOT_CONNECTED');
  await verifyExpectedAccount(ctx, creds, ctx.allowWrites.expectedAccountName, tokens.account_id);
  ctx.diag('JOBBER_WRITE_SENT', { fields: fields.join(',') });
  return run(ctx, creds, doc, variables);
}

// ---------------------------------------------------------------- which account, then data
export interface AccountInfo { id: string; name: string }
export async function readAccount(ctx: Ctx, creds: Credentials): Promise<AccountInfo> {
  const { data } = await query(ctx, creds, 'query GetAccount { account { id name } }');
  const a = rec(data.account);
  if (typeof a.id !== 'string' || typeof a.name !== 'string' || a.id.length === 0) throw new JobberError('ACCOUNT_UNREADABLE');
  return { id: a.id, name: a.name };
}
/** The expected test account, by exact name and (once known) by the id saved when it was first verified. Throws ACCOUNT_MISMATCH before anything else is read. */
export async function verifyExpectedAccount(ctx: Ctx, creds: Credentials, expectedName: string, pinnedId?: string): Promise<AccountInfo> {
  if (typeof expectedName !== 'string' || expectedName.trim().length === 0) throw new JobberError('BAD_CONFIG');
  const a = await readAccount(ctx, creds);
  if (a.name.trim() !== expectedName.trim() || (pinnedId !== undefined && a.id !== pinnedId)) { ctx.diag('JOBBER_ACCOUNT_MISMATCH', { nameMatches: a.name.trim() === expectedName.trim(), idMatches: pinnedId === undefined ? true : a.id === pinnedId }); throw new JobberError('ACCOUNT_MISMATCH', a.name.slice(0, 80)); }
  return a;
}

/** A read-only look at the schedule: only COUNTS, kinds and the earliest and latest start, never a title, client or address. `doc` is the scheduled-items query (found from the live schema; see the entry point). */
/** The busy time in a window: the start and end of every scheduled item Jobber returns (no title, client or address is requested or kept). `complete` is false when Jobber says there are more items than were returned: the caller must then treat the calendar as UNREADABLE, never as empty. An all-day item with no usable end blocks its whole day. */
export async function readBusyIntervals(ctx: Ctx, creds: Credentials, fromIso: string, toIso: string): Promise<{ busy: Array<{ start: number; end: number }>; complete: boolean }> {
  const r = await query(ctx, creds, 'query Busy($first: Int!, $filter: ScheduledItemsFilterAttributes!) { scheduledItems(first: $first, filter: $filter) { nodes { startAt endAt allDay } pageInfo { hasNextPage } } }', { first: 100, filter: { occursWithin: { startAt: fromIso, endAt: toIso }, includeUnassigned: true } });   // Drew's own bookings have no assigned person, and Jobber leaves unassigned visits out unless asked: without this flag the calendar looked empty and Drew could double-book itself
  const si = rec(r.data.scheduledItems); const busy: Array<{ start: number; end: number }> = [];
  for (const n of Array.isArray(si.nodes) ? si.nodes : []) {
    const o = rec(n); const s = Date.parse(String(o.startAt ?? '')); if (!Number.isFinite(s)) continue;
    let e = Date.parse(String(o.endAt ?? '')); if (!Number.isFinite(e) || e <= s) e = s + 24 * 3_600_000;
    busy.push({ start: s, end: e });
  }
  return { busy, complete: rec(si.pageInfo).hasNextPage !== true };
}

export interface ScheduleSummary { count: number; hasMore: boolean; kinds: Record<string, number>; earliest: string | undefined; latest: string | undefined }
export async function readSchedule(ctx: Ctx, creds: Credentials, doc: string, variables: Record<string, unknown>): Promise<ScheduleSummary & { version: string | undefined; cost: GqlResult['cost'] }> {
  const r = await query(ctx, creds, doc, variables);
  const si = rec(r.data.scheduledItems); const nodes = Array.isArray(si.nodes) ? si.nodes : [];
  const kinds: Record<string, number> = {}; const starts: string[] = [];
  for (const n of nodes) { const o = rec(n); const k = typeof o.__typename === 'string' && /^[A-Za-z]{1,40}$/.test(o.__typename) ? o.__typename : 'Unknown'; kinds[k] = (kinds[k] ?? 0) + 1; if (typeof o.start === 'string') starts.push(o.start); else if (typeof o.startAt === 'string') starts.push(o.startAt); }
  starts.sort();
  return { count: nodes.length, hasMore: rec(si.pageInfo).hasNextPage === true, kinds, earliest: starts[0], latest: starts[starts.length - 1], version: r.version, cost: r.cost };
}
// ---------------------------------------------------------------- authorization (state, PKCE, local callback)
export interface ConnectResult { account: AccountInfo; expiresAt: number }
export interface AuthSession { /** The link the founder opens in a browser. Holds the client id, the state and the PKCE challenge only. */ url: string; callbackUrl: string; port: number; done: Promise<ConnectResult>; close(): void }

export async function startAuthorization(o: {
  ctx: Ctx; creds: Credentials; port: number; expectedAccountName: string; random?: (n: number) => Buffer; timeoutMs?: number;
}): Promise<AuthSession> {
  const { ctx, creds } = o; const random = o.random ?? randomBytes;
  if (!ID.test(creds.client_id) || typeof o.expectedAccountName !== 'string' || o.expectedAccountName.trim() === '' || !Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new JobberError('BAD_CONFIG');
  const state = b64url(random(24)); const pkce = pkcePair(random);
  const startedAt = ctx.now(); const ttl = o.timeoutMs ?? 600_000;
  let consumed = false; let settle!: { ok(r: ConnectResult): void; fail(e: unknown): void };
  const done = new Promise<ConnectResult>((ok, fail) => { settle = { ok, fail }; });
  done.catch(() => undefined);
  const servers: Server[] = [];
  const closeAll = (): void => { for (const s of servers) { try { s.close(); s.closeAllConnections?.(); } catch { /* closed */ } } };
  let callbackUrl = '';

  const page = (res: ServerResponse, status: number, text: string): void => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' }); res.end(`<!doctype html><meta charset="utf-8"><title>Jobber connection</title><p>${text}</p>`); };
  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    let u: URL; try { u = new URL(String(req.url ?? ''), 'http://localhost'); } catch { res.writeHead(400).end(); return; }
    if (req.method !== 'GET' || u.pathname !== CALLBACK_PATH) { res.writeHead(404, { Connection: 'close' }).end(); return; }
    const got = u.searchParams.get('state') ?? '';
    if (consumed || ctx.now() - startedAt > ttl || !sameText(got, state)) { ctx.diag('JOBBER_CALLBACK_REJECTED', { reason: consumed ? 'USED' : ctx.now() - startedAt > ttl ? 'EXPIRED' : 'STATE' }); page(res, 400, 'This link is not valid. Close this tab and start again.'); return; }
    consumed = true;   // single use: the first callback with the right state is the only one ever handled
    if (u.searchParams.get('error') !== null) { page(res, 400, 'Access was not allowed. You can close this tab.'); settle.fail(new JobberError('DENIED')); closeAll(); return; }
    const code = u.searchParams.get('code') ?? '';
    if (!TOKEN.test(code)) { page(res, 400, 'No usable code arrived. Close this tab and start again.'); settle.fail(new JobberError('EXCHANGE_FAILED')); closeAll(); return; }
    page(res, 200, 'Received. You can close this tab and return to the terminal.');
    void (async () => {
      try {
        const t = await tokenCall(ctx, { client_id: creds.client_id, client_secret: creds.client_secret, grant_type: 'authorization_code', code, redirect_uri: callbackUrl, code_verifier: pkce.verifier });
        if (t.refresh_token === undefined) throw new JobberError('EXCHANGE_FAILED');
        const expiresAt = expiryOf(ctx, t.access_token, t.expires_in);
        // The account is checked BEFORE anything is stored: tokens for the wrong account are dropped here and never written.
        const account = await verifyExpectedAccount({ ...ctx, bearer: t.access_token }, creds, o.expectedAccountName);
        await ctx.vault.saveTokens({ access_token: t.access_token, refresh_token: t.refresh_token, expires_at: expiresAt, account_id: account.id, account_name: account.name });
        ctx.diag('JOBBER_CONNECTED');
        settle.ok({ account, expiresAt });
      } catch (e) { settle.fail(e); } finally { closeAll(); }
    })();
  };

  // Loopback only: 127.0.0.1, and ::1 as well when available (a browser may resolve "localhost" to either).
  const first = createServer(onRequest); servers.push(first);
  await new Promise<void>((ok, fail) => { first.once('error', fail); first.listen(o.port, '127.0.0.1', () => ok()); });
  const port = (first.address() as { port: number }).port;
  const second = createServer(onRequest);
  await new Promise<void>((ok) => { second.once('error', () => ok()); second.listen(port, '::1', () => { servers.push(second); ok(); }); });
  callbackUrl = callbackUrlFor(port);
  const timer = setTimeout(() => { settle.fail(new JobberError('TIMEOUT')); closeAll(); }, ttl); timer.unref?.();
  done.finally(() => clearTimeout(timer)).catch(() => undefined);
  const url = `${ctx.endpoints.authorize}?${form({ response_type: 'code', client_id: creds.client_id, redirect_uri: callbackUrl, state, code_challenge: pkce.challenge, code_challenge_method: 'S256' })}`;
  return { url, callbackUrl, port, done, close: closeAll };
}
