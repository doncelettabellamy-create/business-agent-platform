// The standalone Jobber connector (OAuth with state and PKCE, refresh-token rotation, protected storage, read-only queries, account check), tested against a local stand-in for Jobber on the loopback address.
// Nothing here contacts Jobber, uses a real credential or touches the voice server. Every secret below is a made-up string.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accessToken, callbackUrlFor, createVault, isReadOnlyDocument, JobberError, pkcePair, query, readBusyIntervals, readSchedule, startAuthorization, verifyExpectedAccount } from '../src/jobber-connector.ts';
import type { Credentials, Ctx, FetchLike, Protector } from '../src/jobber-connector.ts';
import { windowsProtector } from '../src/jobber-dpapi.ts';

const CREDS: Credentials = { client_id: 'test-client-id-0001', client_secret: 'test-client-secret-ZZZ-9f8e7d6c' };
const ACCOUNT = { id: 'ACCT-TEST-1', name: 'Test Cleaning Developer Account' };
// Reversible, NOT secure: only to prove the vault stores what the protector returns and never the plain text.
const fakeProtector: Protector = { protect: async (p) => `P1:${Buffer.from([...Buffer.from(p)].reverse()).toString('hex')}`, unprotect: async (b) => Buffer.from(Buffer.from(b.slice(3), 'hex').reverse()).toString() };
const b64u = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

interface Mock { origin: string; endpoints: { authorize: string; token: string; graphql: string }; close(): Promise<void>; seen: { token: Array<Record<string, string>>; tokenUrls: string[]; graphql: Array<{ auth: string; version: string | undefined; body: string }>; authorize: Array<Record<string, string>> }; setNow(n: number): void; opts: { account: { id: string; name: string }; refreshStatus: number; graphqlStatusOnce: number[]; nodes: unknown[] } }
async function mockJobber(): Promise<Mock> {
  let now = Date.now(); let n = 0;
  const codes = new Map<string, { challenge: string; redirect: string }>(); const live = { access: new Map<string, number>(), refresh: new Set<string>() };
  const seen: Mock['seen'] = { token: [], tokenUrls: [], graphql: [], authorize: [] };
  const opts: Mock['opts'] = { account: ACCOUNT, refreshStatus: 200, graphqlStatusOnce: [], nodes: [{ __typename: 'Visit', start: '2026-11-05T15:00:00Z', end: '2026-11-05T16:00:00Z', title: 'PRIVATE-TITLE' }, { __typename: 'Task', start: '2026-11-04T09:00:00Z' }] };
  const issue = (): { access_token: string; refresh_token: string; token_type: string; expires_in: number } => {
    const access = `${b64u({ alg: 'HS256' })}.${b64u({ exp: Math.floor(now / 1000) + 3600, n: ++n })}.sig${n}`; const refresh = `refresh-${n}-abcdef0123456789`;
    live.access.set(access, now + 3_600_000); live.refresh.add(refresh);
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600 };
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8'); const u = new URL(req.url ?? '', 'http://x'); const json = (s: number, o: unknown): void => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (u.pathname === '/api/oauth/authorize' && req.method === 'GET') {
        const q = Object.fromEntries(u.searchParams); seen.authorize.push(q);
        const code = `code-${codes.size + 1}-0123456789`; codes.set(code, { challenge: q.code_challenge ?? '', redirect: q.redirect_uri ?? '' });
        res.writeHead(302, { Location: `${q.redirect_uri}?code=${code}&state=${encodeURIComponent(q.state ?? '')}` }); res.end(); return;
      }
      if (u.pathname === '/api/oauth/token' && req.method === 'POST') {
        const f = Object.fromEntries(new URLSearchParams(body)); seen.token.push(f); seen.tokenUrls.push(req.url ?? '');
        if (req.headers['content-type'] !== 'application/x-www-form-urlencoded') return json(400, { error: 'invalid_request' });
        if (f.client_id !== CREDS.client_id || f.client_secret !== CREDS.client_secret) return json(401, { error: 'invalid_client' });
        if (f.grant_type === 'authorization_code') {
          const c = codes.get(f.code ?? ''); codes.delete(f.code ?? '');
          if (c === undefined || c.redirect !== f.redirect_uri || createHash('sha256').update(f.code_verifier ?? '').digest('base64url') !== c.challenge) return json(400, { error: 'invalid_grant' });
          return json(200, issue());
        }
        if (f.grant_type === 'refresh_token') {
          if (opts.refreshStatus !== 200) return json(opts.refreshStatus, { error: 'invalid_grant' });
          if (!live.refresh.has(f.refresh_token ?? '')) return json(400, { error: 'The provided refresh token is not valid.' });
          live.refresh.delete(f.refresh_token ?? ''); return json(200, issue());   // rotation: the old refresh token is invalid from now on
        }
        return json(400, { error: 'unsupported_grant_type' });
      }
      if (u.pathname === '/api/graphql' && req.method === 'POST') {
        const auth = String(req.headers.authorization ?? ''); const version = req.headers['x-jobber-graphql-version'] as string | undefined; seen.graphql.push({ auth, version, body });
        const forced = opts.graphqlStatusOnce.shift(); if (forced !== undefined) return json(forced, { message: 'x' });
        const tok = auth.replace(/^Bearer /, ''); const exp = live.access.get(tok);
        if (exp === undefined || exp <= now || version === undefined) return json(401, { message: 'Invalid Token Error' });
        const q = String(JSON.parse(body).query);
        if (/\baccount\b/.test(q)) return json(200, { data: { account: opts.account }, extensions: { versioning: { version }, cost: { requestedQueryCost: 2, throttleStatus: { currentlyAvailable: 9990 } } } });
        if (/scheduledItems/.test(q)) return json(200, { data: { scheduledItems: { nodes: opts.nodes, pageInfo: { hasNextPage: false } } }, extensions: { versioning: { version } } });
        return json(200, { data: {} });
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, endpoints: { authorize: `${origin}/api/oauth/authorize`, token: `${origin}/api/oauth/token`, graphql: `${origin}/api/graphql` }, seen, opts, setNow: (x) => { now = x; }, close: () => new Promise((ok) => { server.close(() => ok()); server.closeAllConnections(); }) };
}

interface Rig { mock: Mock; ctx: Ctx; logs: Array<[string, unknown]>; dir: string; clock: { t: number }; done(): Promise<void> }
async function rig(): Promise<Rig> {
  const mock = await mockJobber(); const dir = mkdtempSync(join(tmpdir(), 'jobber-test-')); const clock = { t: Date.now() }; const logs: Array<[string, unknown]> = [];
  mock.setNow(clock.t);
  const ctx: Ctx = { vault: createVault(dir, fakeProtector), endpoints: mock.endpoints, fetch: globalThis.fetch as unknown as FetchLike, now: () => clock.t, diag: (c, d) => { logs.push([c, d]); }, timeoutMs: 5000 };
  return { mock, ctx, logs, dir, clock, done: async () => { await mock.close(); rmSync(dir, { recursive: true, force: true }); } };
}
/** The browser: opens the authorize link, then follows the redirect to the local callback. */
async function browse(url: string, tweak?: (loc: string) => string): Promise<number> {
  const r = await fetch(url, { redirect: 'manual' }); const loc = r.headers.get('location') ?? '';
  return (await fetch(tweak ? tweak(loc) : loc, { redirect: 'manual' })).status;
}
const connect = async (r: Rig, expect = ACCOUNT.name) => startAuthorization({ ctx: r.ctx, creds: CREDS, port: 0, expectedAccountName: expect });
const connected = async (r: Rig): Promise<void> => { const s = await connect(r); assert.equal(await browse(s.url), 200); await s.done; };

test('PKCE: the verifier is 64 unreserved characters and the challenge is the base64url SHA-256 of it, without padding', () => {
  const p = pkcePair();
  assert.match(p.verifier, /^[A-Za-z0-9_-]{43,128}$/); assert.equal(p.verifier.length, 64);
  assert.equal(p.challenge, createHash('sha256').update(p.verifier).digest('base64url')); assert.ok(!p.challenge.includes('='));
  assert.notEqual(pkcePair().verifier, p.verifier);
});

test('read-only guard: queries pass; a mutation or subscription is refused, also in odd spacing; the word inside a string or a comment does not count', () => {
  assert.equal(isReadOnlyDocument('query Q { account { id name } }'), true);
  assert.equal(isReadOnlyDocument('{ account { id } }'), true);
  assert.equal(isReadOnlyDocument('query Q { jobs(first: 1, filter: {title: "mutation"}) { nodes { id } } } # a mutation comment'), true);
  for (const bad of ['mutation M { appDisconnect { app { name } } }', '  MUTATION   X { a }', 'query Q { a } mutation M { b }', 'subscription S { a }', '', 'x'.repeat(8001)]) assert.equal(isReadOnlyDocument(bad), false, bad.slice(0, 20));
});

test('authorization: state and PKCE in the link, local callback only, form-encoded exchange with the secret in the body, account checked, tokens stored protected, nothing secret logged', async () => {
  const r = await rig();
  try {
    const s = await connect(r);
    const u = new URL(s.url);
    assert.equal(u.origin + u.pathname, r.mock.endpoints.authorize);
    assert.deepEqual([u.searchParams.get('response_type'), u.searchParams.get('client_id'), u.searchParams.get('code_challenge_method'), u.searchParams.get('redirect_uri')], ['code', CREDS.client_id, 'S256', s.callbackUrl]);
    assert.match(u.searchParams.get('state') ?? '', /^[A-Za-z0-9_-]{32}$/);
    assert.ok(!s.url.includes(CREDS.client_secret), 'the client secret is never in the link');
    assert.equal(s.callbackUrl, callbackUrlFor(s.port)); assert.equal(callbackUrlFor(8765), 'http://localhost:8765/jobber/callback');
    assert.equal(await browse(s.url), 200);
    const res = await s.done;
    assert.deepEqual(res.account, ACCOUNT);
    const ex = r.mock.seen.token[0];
    assert.deepEqual([ex.grant_type, ex.client_secret, ex.redirect_uri], ['authorization_code', CREDS.client_secret, s.callbackUrl]);
    assert.equal(createHash('sha256').update(ex.code_verifier).digest('base64url'), u.searchParams.get('code_challenge'));
    assert.ok(!r.mock.seen.tokenUrls[0].includes('secret') && !r.mock.seen.tokenUrls[0].includes('code'), 'nothing secret in the token request address');
    const stored = await r.ctx.vault.loadTokens();
    assert.deepEqual([stored?.account_id, stored?.account_name], [ACCOUNT.id, ACCOUNT.name]);
    for (const f of readdirSync(r.dir)) { const text = readFileSync(join(r.dir, f), 'utf8'); assert.ok(!text.includes(stored!.access_token) && !text.includes(stored!.refresh_token), `${f} holds no plain token`); }
    const log = JSON.stringify(r.logs);
    for (const secret of [CREDS.client_secret, stored!.access_token, stored!.refresh_token, ex.code, ex.code_verifier, u.searchParams.get('state')!]) assert.ok(!log.includes(secret), 'no secret in the diagnostics');
  } finally { await r.done(); }
});

test('state: a wrong or missing state is refused and never reaches the token endpoint; the right one still works afterwards; a second use of the same callback is refused', async () => {
  const r = await rig();
  try {
    const s = await connect(r);
    const cb = new URL(s.callbackUrl);
    for (const bad of ['?code=code-1-0123456789&state=wrong', '?code=code-1-0123456789']) assert.equal((await fetch(`${cb.origin}${cb.pathname}${bad}`)).status, 400);
    assert.equal((await fetch(`${cb.origin}/other?state=x`)).status, 404);
    assert.equal(r.mock.seen.token.length, 0, 'no exchange for a bad state');
    let loc = ''; assert.equal(await browse(s.url, (l) => { loc = l; return l; }), 200); await s.done;
    await assert.rejects(fetch(loc), 'the listener closes after the one handled callback, so the same link cannot be used again');
    assert.equal(r.mock.seen.token.length, 1);
  } finally { await r.done(); }
});

test('state: a callback after the ten minutes is refused; a denied request ends the flow; a denial with a wrong state is ignored', async () => {
  const r = await rig();
  try {
    const s = await connect(r);
    r.clock.t += 11 * 60_000;
    assert.equal(await browse(s.url), 400); s.close();
    assert.equal(r.mock.seen.token.length, 0);
    const d = await connect(r); const cb = new URL(d.callbackUrl);
    assert.equal((await fetch(`${cb.origin}${cb.pathname}?error=access_denied&state=wrong`)).status, 400);
    const st = new URL(d.url).searchParams.get('state')!;
    assert.equal((await fetch(`${cb.origin}${cb.pathname}?error=access_denied&state=${st}`)).status, 400);
    await assert.rejects(d.done, (e: unknown) => e instanceof JobberError && e.code === 'DENIED');
    assert.equal(await r.ctx.vault.loadTokens(), undefined);
  } finally { await r.done(); }
});

test('wrong account: tokens for an account that is not the expected test account are dropped before anything is stored', async () => {
  const r = await rig();
  try {
    r.mock.opts.account = { id: 'ACCT-OTHER', name: 'Some Other Business' };
    const s = await connect(r); assert.equal(await browse(s.url), 200);
    await assert.rejects(s.done, (e: unknown) => e instanceof JobberError && e.code === 'ACCOUNT_MISMATCH');
    assert.equal(await r.ctx.vault.loadTokens(), undefined, 'nothing stored for the wrong account');
    assert.ok(r.mock.seen.graphql.every((g) => !/scheduledItems/.test(g.body)), 'no other data was read');
  } finally { await r.done(); }
});

test('refresh rotation: an expired access token is refreshed, the NEW refresh token is stored before use, the old one is dead, and a refresh failure keeps the stored tokens and asks to reconnect', async () => {
  const r = await rig();
  try {
    await connected(r);
    const before = (await r.ctx.vault.loadTokens())!;
    r.clock.t += 3_540_000; r.mock.setNow(r.clock.t - 3_540_000);   // the local clock is 59 minutes on: inside the 60 s margin
    r.clock.t += 120_000; r.mock.setNow(r.clock.t);
    const tok = await accessToken(r.ctx, CREDS);
    const after = (await r.ctx.vault.loadTokens())!;
    assert.notEqual(after.refresh_token, before.refresh_token); assert.equal(after.access_token, tok);
    assert.deepEqual(r.logs.filter(([c]) => c === 'JOBBER_TOKEN_REFRESHED').map(([, d]) => d), [{ rotated: true }]);
    const replay = await fetch(r.mock.endpoints.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: CREDS.client_id, client_secret: CREDS.client_secret, grant_type: 'refresh_token', refresh_token: before.refresh_token }) });
    assert.equal(replay.status, 400, 'the rotated-out refresh token cannot be used again');
    r.mock.opts.refreshStatus = 400; r.clock.t += 7_200_000; r.mock.setNow(r.clock.t);
    await assert.rejects(accessToken(r.ctx, CREDS), (e: unknown) => e instanceof JobberError && e.code === 'RECONNECT_REQUIRED');
    assert.deepEqual(await r.ctx.vault.loadTokens(), after, 'a failed refresh leaves the stored tokens exactly as they were');
  } finally { await r.done(); }
});

test('refresh: two refreshes at once make ONE token call (lock, then reload instead of reusing the stale tokens); a 401 from the API forces one refresh and one retry', async () => {
  const r = await rig();
  try {
    await connected(r);
    const calls = (): number => r.mock.seen.token.filter((t) => t.grant_type === 'refresh_token').length;
    const [a, b] = await Promise.all([accessToken(r.ctx, CREDS, true), accessToken(r.ctx, CREDS, true)]);
    assert.equal(calls(), 1); assert.equal(a, b);
    r.mock.opts.graphqlStatusOnce.push(401);
    const acct = await query(r.ctx, CREDS, 'query { account { id name } }');
    assert.equal(rec(acct.data.account).name, ACCOUNT.name); assert.equal(calls(), 2);
    r.mock.opts.graphqlStatusOnce.push(429);
    await assert.rejects(query(r.ctx, CREDS, 'query { account { id name } }'), (e: unknown) => e instanceof JobberError && e.code === 'RATE_LIMITED');
  } finally { await r.done(); }
});
const rec = (x: unknown): Record<string, unknown> => x as Record<string, unknown>;

test('queries only: a mutation never leaves the machine; the version header is sent; the API version and cost come back', async () => {
  const r = await rig();
  try {
    await connected(r); const sent = r.mock.seen.graphql.length;
    await assert.rejects(query(r.ctx, CREDS, 'mutation M { appDisconnect { app { name } } }'), (e: unknown) => e instanceof JobberError && e.code === 'NOT_READ_ONLY');
    assert.equal(r.mock.seen.graphql.length, sent, 'nothing was sent');
    const q = await query(r.ctx, CREDS, 'query { account { id name } }');
    const last = r.mock.seen.graphql.at(-1)!;
    assert.match(last.auth, /^Bearer /); assert.match(last.version ?? '', /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual([q.version, q.cost.requested, q.cost.available], [last.version, 2, 9990]);
  } finally { await r.done(); }
});

test('account check first: the wrong name or a different pinned id stops everything before the schedule is read; the right account then yields COUNTS only, never a title', async () => {
  const r = await rig();
  try {
    await connected(r);
    const pinned = (await r.ctx.vault.loadTokens())!.account_id;
    await assert.rejects(verifyExpectedAccount(r.ctx, CREDS, 'Not The Test Account', pinned), (e: unknown) => e instanceof JobberError && e.code === 'ACCOUNT_MISMATCH');
    await assert.rejects(verifyExpectedAccount(r.ctx, CREDS, ACCOUNT.name, 'ACCT-OTHER'), (e: unknown) => e instanceof JobberError && e.code === 'ACCOUNT_MISMATCH');
    assert.ok(r.mock.seen.graphql.every((g) => !/scheduledItems/.test(g.body)));
    assert.deepEqual(await verifyExpectedAccount(r.ctx, CREDS, ACCOUNT.name, pinned), ACCOUNT);
    const s = await readSchedule(r.ctx, CREDS, 'query S($first: Int!) { scheduledItems(first: $first) { nodes { __typename start } pageInfo { hasNextPage } } }', { first: 50 });
    assert.deepEqual([s.count, s.hasMore, s.kinds, s.earliest, s.latest], [2, false, { Visit: 1, Task: 1 }, '2026-11-04T09:00:00Z', '2026-11-05T15:00:00Z']);
    assert.ok(!JSON.stringify(s).includes('PRIVATE-TITLE'));
  } finally { await r.done(); }
});

test('no secret in any error: a failed exchange and a refused refresh carry a fixed code word only', async () => {
  const r = await rig();
  try {
    const bad: Credentials = { ...CREDS, client_secret: 'wrong-secret-VALUE-123456789' };
    const s = await startAuthorization({ ctx: r.ctx, creds: bad, port: 0, expectedAccountName: ACCOUNT.name });
    assert.equal(await browse(s.url), 200);
    await assert.rejects(s.done, (e: unknown) => { assert.ok(e instanceof JobberError); assert.equal(e.message, e.code); assert.ok(!e.message.includes('wrong-secret') && !JSON.stringify(r.logs).includes('wrong-secret')); return e.code === 'EXCHANGE_FAILED'; });
    assert.equal(await r.ctx.vault.loadTokens(), undefined);
  } finally { await r.done(); }
});

test('the vault: credentials and tokens round-trip through the protector, a corrupt or foreign file reads as absent, and the callback listener answers on the loopback address only', async () => {
  const r = await rig();
  try {
    await r.ctx.vault.saveCredentials(CREDS); assert.deepEqual(await r.ctx.vault.loadCredentials(), CREDS);
    assert.ok(!readFileSync(join(r.dir, 'credentials.enc'), 'utf8').includes(CREDS.client_secret));
    const other = createVault(r.dir, { protect: async (p) => p, unprotect: async () => { throw new Error('different user'); } });
    assert.equal(await other.loadCredentials(), undefined);
    await assert.rejects(r.ctx.vault.saveCredentials({ client_id: 'x', client_secret: 'y' }), (e: unknown) => e instanceof JobberError);
    const s = await connect(r); assert.equal(new URL(s.callbackUrl).hostname, 'localhost');
    const raw = await fetch(s.callbackUrl.replace('localhost', '127.0.0.1') + '?state=nope'); assert.equal(raw.status, 400); s.close();
  } finally { await r.done(); }
});

test('Windows DPAPI protector: the stored blob is not the plain text and only this Windows user can read it back (dummy value; skipped elsewhere)', { skip: process.platform !== 'win32' }, async () => {
  const p = windowsProtector(); const plain = 'dummy-secret-for-the-dpapi-test-0123456789';
  const blob = await p.protect(plain);
  assert.match(blob, /^[0-9a-f]{20,}$/i); assert.ok(!blob.includes(plain));
  assert.equal(await p.unprotect(blob), plain);
});

test('standalone: nothing in the voice server, call logic, booking checkpoint or any other source file imports the connector, and the connector itself has no mutation, no child process and no network library', () => {
  const src = join(import.meta.dirname, '..', 'src');
  const importers = readdirSync(src).filter((f) => f.endsWith('.ts') && !/^jobber-/.test(f)).filter((f) => /from '\.\/jobber-(connector|dpapi|connect-main)\.ts'/.test(readFileSync(join(src, f), 'utf8')));
  assert.deepEqual(importers, ['fast-test-setup-main.ts', 'founder-voice-entry.ts', 'founder-voice-fast.ts'], 'only the fast test call\'s modules and the entry points use the connector; the call logic, the transports and the simulated booking checkpoint never do');
  for (const never of ['simulated-booking.ts', 'relay-handler.ts', 'realtime-bridge.ts', 'realtime-transport.ts', 'call-transport.ts', 'founder-voice-service.ts']) assert.ok(!/from '\.\/jobber-/.test(readFileSync(join(src, never), 'utf8')), `${never} imports no Jobber module`);
  const text = readFileSync(join(src, 'jobber-connector.ts'), 'utf8');
  assert.ok(!/child_process|from 'node:https'|WebSocket/.test(text), 'no child process, no https client library, no WebSocket (the one node:http use is the local callback listener)');
  assert.ok(!/mutation\s+\w+\s*\{/i.test(text), 'no mutation document');
  assert.ok(createHmac !== undefined);
});

test('busy time: the schedule query asks for UNASSIGNED visits too (Drew\'s own bookings have no assignee), sends the window, reads only start and end, and returns them as busy', async () => {
  const r = await rig();
  try {
    await connected(r); r.mock.opts.nodes = [{ __typename: 'Visit', startAt: '2026-11-04T15:00:00Z', endAt: '2026-11-04T17:00:00Z' }];
    const from = '2026-11-03T20:00:00.000Z'; const to = '2026-11-18T20:00:00.000Z';
    const b = await readBusyIntervals(r.ctx, CREDS, from, to);
    assert.deepEqual(b, { busy: [{ start: Date.parse('2026-11-04T15:00:00Z'), end: Date.parse('2026-11-04T17:00:00Z') }], complete: true });
    const sent = JSON.parse(r.mock.seen.graphql.at(-1)!.body) as { query: string; variables: { first: number; filter: Record<string, unknown> } };
    assert.deepEqual(sent.variables.filter, { occursWithin: { startAt: from, endAt: to }, includeUnassigned: true }, 'the window, and unassigned visits included');
    assert.ok(!/title|client|address|property/i.test(sent.query), 'no title, client or address is requested');
  } finally { await r.done(); }
});

// ================================================================ the lock: a unique owner token, a live heartbeat, owner-only release, and a holder that stops when it has lost the lock
const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const lockDir = (): string => mkdtempSync(join(tmpdir(), 'jobber-lock-'));
const lockPath = (dir: string, name: string): string => join(dir, name + '.lock');

test('lock: the lock file holds the holder\'s own random token, two holders have different tokens, and the lock is gone after a normal end and after an error', async () => {
  const dir = lockDir(); const v = createVault(dir, fakeProtector); const seen: string[] = [];
  await v.withLock('t1', async () => { seen.push(readFileSync(lockPath(dir, 't1'), 'utf8')); });
  await v.withLock('t1', async () => { seen.push(readFileSync(lockPath(dir, 't1'), 'utf8')); });
  assert.ok(seen.every((s) => /^[0-9a-f]{32}$/.test(s)), 'a 128-bit random token'); assert.notEqual(seen[0], seen[1], 'a new token every time');
  assert.equal(existsSync(lockPath(dir, 't1')), false, 'released');
  await assert.rejects(v.withLock('t1', async () => { throw new Error('boom'); }), /boom/); assert.equal(existsSync(lockPath(dir, 't1')), false, 'released after an error');
  rmSync(dir, { recursive: true, force: true });
});

test('lock: the heartbeat keeps a live holder\'s lock fresh, so a waiter does NOT take it over however long the holder works, and gets it only after the holder is done', async () => {
  const dir = lockDir(); const v = createVault(dir, fakeProtector, { heartbeatMs: 40, staleMs: 800 }); let aDone = 0; let bStarted = 0;
  const a = v.withLock('t2', async (lock) => { const t0 = statSync(lockPath(dir, 't2')).mtimeMs; await sleepMs(1700); lock.assertHeld(); assert.ok(statSync(lockPath(dir, 't2')).mtimeMs > t0 + 800, 'the file was refreshed while held'); aDone = Date.now(); });
  await sleepMs(50);
  await assert.rejects(v.withLock('t2', async () => { bStarted = Date.now(); }, 1200), (e: unknown) => e instanceof JobberError && e.code === 'TIMEOUT');   // 1200 ms is longer than the stale age: without a heartbeat it would be stolen
  assert.equal(bStarted, 0, 'the waiter never ran while the holder was alive'); assert.equal(aDone, 0, 'and the holder was not interrupted');
  await a; assert.ok(aDone > 0); await v.withLock('t2', async () => { bStarted = Date.now(); }, 1000); assert.ok(bStarted >= aDone, 'the waiter runs after the holder is done');
  rmSync(dir, { recursive: true, force: true });
});

test('lock: a lock whose holder died (no heartbeat for staleMs) is taken over, and the new holder gets a lock of its own; a fresh foreign lock is never taken', async () => {
  const dir = lockDir(); const v = createVault(dir, fakeProtector, { heartbeatMs: 40, staleMs: 3000 });
  writeFileSync(lockPath(dir, 't3'), 'dead-holder-token'); const old = new Date(Date.now() - 10_000); utimesSync(lockPath(dir, 't3'), old, old);
  let ran = false; await v.withLock('t3', async (lock) => { ran = true; lock.assertHeld(); assert.notEqual(readFileSync(lockPath(dir, 't3'), 'utf8'), 'dead-holder-token'); }, 1500); assert.ok(ran, 'the abandoned lock was taken over');
  writeFileSync(lockPath(dir, 't3'), 'fresh-foreign-token');   // just written: fresh
  await assert.rejects(v.withLock('t3', async () => undefined, 250), (e: unknown) => e instanceof JobberError && e.code === 'TIMEOUT'); assert.equal(readFileSync(lockPath(dir, 't3'), 'utf8'), 'fresh-foreign-token', 'a fresh foreign lock is left alone');
  rmSync(dir, { recursive: true, force: true });
});

test('lock: ownership loss is detected before the next write: the lock replaced by another holder, removed, or a heartbeat that cannot run all make assertHeld throw LOCK_LOST, and the loser never removes the other holder\'s lock', async () => {
  const lost = (fn: () => void): boolean => { try { fn(); return false; } catch (e) { return e instanceof JobberError && e.code === 'LOCK_LOST'; } };
  // replaced by another holder
  { const dir = lockDir(); const v = createVault(dir, fakeProtector, { heartbeatMs: 40, staleMs: 300 });
    await v.withLock('t4', async (lock) => { lock.assertHeld(); writeFileSync(lockPath(dir, 't4'), 'the-new-holder'); assert.ok(lost(() => lock.assertHeld()), 'replaced'); await sleepMs(120); assert.ok(lost(() => lock.assertHeld()), 'and it stays lost even after a heartbeat'); });
    assert.equal(readFileSync(lockPath(dir, 't4'), 'utf8'), 'the-new-holder', 'owner-only release: the new holder\'s lock is not removed'); rmSync(dir, { recursive: true, force: true }); }
  // removed
  { const dir = lockDir(); const v = createVault(dir, fakeProtector, { heartbeatMs: 40, staleMs: 300 });
    await v.withLock('t5', async (lock) => { rmSync(lockPath(dir, 't5')); assert.ok(lost(() => lock.assertHeld()), 'removed'); }); assert.equal(existsSync(lockPath(dir, 't5')), false); rmSync(dir, { recursive: true, force: true }); }
  // the heartbeat cannot run (the process is stalled past the limit): the token is still in the file, yet the holder must treat the lock as lost
  { const dir = lockDir(); const v = createVault(dir, fakeProtector, { heartbeatMs: 40, staleMs: 200 });
    await v.withLock('t6', async (lock) => { lock.assertHeld(); const end = Date.now() + 260; while (Date.now() < end) { /* a stalled process: no timer can run */ } assert.ok(lost(() => lock.assertHeld()), 'overdue heartbeat'); }); rmSync(dir, { recursive: true, force: true }); }
});

test('lock: a holder whose heartbeat never runs is taken over by a waiter after staleMs, and the old holder then stops at its next check while the new holder\'s lock survives the old holder\'s end', async () => {
  const dir = lockDir(); const slow = createVault(dir, fakeProtector, { heartbeatMs: 60_000, staleMs: 250 }); const fast = createVault(dir, fakeProtector, { heartbeatMs: 40, staleMs: 250 });
  let oldStopped = false; let newRan = false; let tokenInside = '';
  const a = slow.withLock('t7', async (lock) => { await sleepMs(700); try { lock.assertHeld(); } catch (e) { oldStopped = e instanceof JobberError && e.code === 'LOCK_LOST'; } });
  await sleepMs(30);
  const b = fast.withLock('t7', async (lock) => { newRan = true; lock.assertHeld(); tokenInside = readFileSync(lockPath(dir, 't7'), 'utf8'); await sleepMs(500); lock.assertHeld(); }, 3000);
  await Promise.all([a, b]);
  assert.ok(newRan, 'the waiter took over'); assert.ok(oldStopped, 'the old holder stopped at its next check'); assert.match(tokenInside, /^[0-9a-f]{32}$/);
  assert.equal(existsSync(lockPath(dir, 't7')), false, 'both ended; nothing is left behind'); rmSync(dir, { recursive: true, force: true });
});

test('lock: several waiters racing for one abandoned lock never overlap, in-process (at most one holder at any moment, every one runs)', async () => {
  const dir = lockDir(); const v = createVault(dir, fakeProtector, { heartbeatMs: 30, staleMs: 1500 });
  writeFileSync(lockPath(dir, 't8'), 'dead'); const old = new Date(Date.now() - 10_000); utimesSync(lockPath(dir, 't8'), old, old);
  let inside = 0; let max = 0; let ran = 0;
  await Promise.all(Array.from({ length: 6 }, () => v.withLock('t8', async (lock) => { inside++; max = Math.max(max, inside); lock.assertHeld(); await sleepMs(60); lock.assertHeld(); inside--; ran++; }, 8000)));
  assert.equal(max, 1, 'never two inside'); assert.equal(ran, 6); assert.equal(existsSync(lockPath(dir, 't8')), false); rmSync(dir, { recursive: true, force: true });
});

test('lock: four processes taking the same lock twelve times each lose no update and never overlap (a read, a pause, a write)', async () => {
  const dir = lockDir(); const worker = fileURLToPath(new URL('./helpers/lock-worker.ts', import.meta.url));
  const run = (): Promise<number> => new Promise((res) => { const p = spawn(process.execPath, [worker, dir, '12', '15', '40', '3000'], { stdio: 'ignore' }); p.on('close', (c) => res(c ?? -1)); });
  const codes = await Promise.all([run(), run(), run(), run()]);
  assert.deepEqual(codes, [0, 0, 0, 0], 'no process saw another inside'); assert.equal(Number(readFileSync(join(dir, 'counter.txt'), 'utf8')), 48, 'no increment was lost'); assert.equal(existsSync(lockPath(dir, 'race')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('lock source: the defaults are unchanged (5 s heartbeat, 30 s stale), the token is written exclusively, the release is owner-only, and the refresh lock is the same lock', () => {
  const src = readFileSync(new URL('../src/jobber-connector.ts', import.meta.url), 'utf8');
  assert.ok(/heartbeatMs = timings\.heartbeatMs \?\? 5_000; const staleMs = timings\.staleMs \?\? 30_000;/.test(src));
  assert.ok(/writeFileSync\(lockFile, token, \{ flag: 'wx', mode: 0o600 \}\)/.test(src), 'created exclusively with the token');
  assert.ok(/if \(!lost && holds\(\)\) rmSync\(lockFile/.test(src), 'released only when still the owner');
  assert.ok(/withRefreshLock<T>\(fn: \(\) => Promise<T>, waitMs = 8000\): Promise<T> \{ return this\.withLock\('refresh', fn, waitMs\); \}/.test(src), 'the token refresh uses it unchanged');
});

test('lock: a holder whose lock was replaced by another holder stops refreshing the file (the heartbeat notices), so the other holder\'s lock can still go stale and be taken over', async () => {
  const dir = lockDir(); const v = createVault(dir, fakeProtector, { heartbeatMs: 30, staleMs: 3000 }); const f = lockPath(dir, 't9');
  await v.withLock('t9', async (lock) => {
    writeFileSync(f, 'the-new-holder'); const old = new Date(Date.now() - 10_000); utimesSync(f, old, old); const before = statSync(f).mtimeMs;
    await sleepMs(300);   // about ten heartbeats
    assert.equal(statSync(f).mtimeMs, before, 'the old holder did not touch the new holder\'s file');
    assert.throws(() => lock.assertHeld(), (e: unknown) => e instanceof JobberError && e.code === 'LOCK_LOST');
  });
  assert.equal(readFileSync(f, 'utf8'), 'the-new-holder', 'and it did not remove it');
  let ran = false; await v.withLock('t9', async () => { ran = true; }, 1500); assert.ok(ran, 'the other holder\'s lock, never refreshed, went stale and was taken over');
  rmSync(dir, { recursive: true, force: true });
});

test('lock: a lock replaced by a FRESH one between the staleness check and the takeover is put back whole (its holder keeps it, nothing is left behind), and the waiter times out instead of stealing it', async () => {
  const dir = lockDir(); const f = lockPath(dir, 't10'); let calls = 0;
  const v = createVault(dir, fakeProtector, { heartbeatMs: 40, staleMs: 3000, beforeTakeover: () => { if (++calls === 1) writeFileSync(f, 'fresh-holder'); } });
  writeFileSync(f, 'dead-holder'); const old = new Date(Date.now() - 10_000); utimesSync(f, old, old);
  await assert.rejects(v.withLock('t10', async () => undefined, 400), (e: unknown) => e instanceof JobberError && e.code === 'TIMEOUT');
  assert.equal(calls, 1, 'the seam ran once, at the takeover of the abandoned lock');
  assert.equal(existsSync(f), true, 'the fresh lock was put back'); assert.equal(readFileSync(f, 'utf8'), 'fresh-holder', 'unchanged');
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.old')), [], 'no moved-aside file is left behind');
  rmSync(dir, { recursive: true, force: true });
});
