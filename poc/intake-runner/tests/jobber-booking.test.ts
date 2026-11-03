// The test-account-only Jobber booking adapter, tested against a local stand-in for Jobber's GraphQL API. NOTHING here contacts Jobber, creates a real booking or sends a text. Every name, number and address is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVault, JobberError, mutate, mutationFields, query, WRITE_ALLOWLIST } from '../src/jobber-connector.ts';
import type { Credentials, Ctx, FetchLike, Protector } from '../src/jobber-connector.ts';
import { bookTestVisit, clientInput, jobInput, markerFor, requestProblems } from '../src/jobber-booking.ts';
import type { BookingRequest } from '../src/jobber-booking.ts';

const CREDS: Credentials = { client_id: 'test-client-id-0001', client_secret: 'test-client-secret-ZZZ-9f8e7d6c' };
const ACCOUNT = { id: 'ACCT-TEST-1', name: 'Test Cleaning Developer Account' };
const fakeProtector: Protector = { protect: async (p) => `P1:${Buffer.from([...Buffer.from(p)].reverse()).toString('hex')}`, unprotect: async (b) => Buffer.from(Buffer.from(b.slice(3), 'hex').reverse()).toString() };
const NOW = Date.parse('2026-11-02T12:00:00Z');
const REQ: BookingRequest = {
  key: 'call-0123456789abcdef', gate: { eligibleRecord: true, approvedByPerson: true, callerAgreed: true },
  client: { firstName: 'Testa', lastName: 'Invented', phone: '(555) 010-4242' },
  address: { street1: '123 Invented Lane', city: 'Testville', postalCode: '90210', province: 'ca' },
  when: { date: '2026-11-10', startTime: '09:00', endTime: '11:00', utcOffset: '-06:00' },
  title: 'Standard cleaning', service: 'Standard cleaning 2 bed 2 bath', priceDollars: 199,
};

interface Opts { account: { id: string; name: string }; searchBlind: boolean; jobUserErrors: boolean; clientUserErrors: boolean; shiftVisitMs: number; crashAfterJobCreate: boolean; failJobCreateStatus?: number }
interface Mock { endpoints: { authorize: string; token: string; graphql: string }; ops: Array<{ kind: 'query' | 'mutation'; field: string; variables: Record<string, unknown> }>; opts: Opts; jobs: Map<string, Record<string, unknown>>; clients: number; close(): Promise<void> }
async function mockJobber(): Promise<Mock> {
  const ops: Mock['ops'] = []; const jobs = new Map<string, Record<string, unknown>>(); let clients = 0; let n = 0;
  const opts: Opts = { account: ACCOUNT, searchBlind: false, jobUserErrors: false, clientUserErrors: false, shiftVisitMs: 0, crashAfterJobCreate: false };
  const props = new Map<string, { client: Record<string, unknown>; address: Record<string, unknown> }>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
      const send = (s: number, o: unknown): void => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.method !== 'POST' || req.url !== '/api/graphql') return send(404, {});
      if (!/^Bearer tok-valid/.test(String(req.headers.authorization ?? ''))) return send(401, {});
      const b = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { query: string; variables?: Record<string, unknown> }; const v = b.variables ?? {};
      const data = (d: unknown) => send(200, { data: d, extensions: { versioning: { version: '2026-09-25' } } });
      if (/\baccount\b/.test(b.query) && !/mutation/.test(b.query)) { ops.push({ kind: 'query', field: 'account', variables: v }); return data({ account: opts.account }); }
      if (/clientCreate/.test(b.query)) {
        ops.push({ kind: 'mutation', field: 'clientCreate', variables: v });
        if (opts.clientUserErrors) return data({ clientCreate: { client: null, userErrors: [{ message: 'bad', path: ['x'] }] } });
        const input = (v.input ?? {}) as Record<string, unknown>; clients++; const pid = `PROP-${++n}`;
        props.set(pid, { client: { firstName: input.firstName, lastName: input.lastName, phones: ((input.phones ?? []) as Array<{ number: string }>).map((p) => ({ number: p.number })) }, address: (((input.properties ?? []) as Array<{ address: Record<string, unknown> }>)[0] ?? { address: {} }).address });
        return data({ clientCreate: { client: { id: `CLIENT-${clients}`, clientProperties: { nodes: [{ id: pid }] } }, userErrors: [] } });
      }
      if (/jobCreate/.test(b.query)) {
        ops.push({ kind: 'mutation', field: 'jobCreate', variables: v });
        if (opts.failJobCreateStatus !== undefined) return send(opts.failJobCreateStatus, {});
        if (opts.jobUserErrors) return data({ jobCreate: { job: null, userErrors: [{ message: 'bad', path: ['y'] }] } });
        const input = (v.input ?? {}) as { propertyId: string; title: string; instructions: string; timeframe: { startAt: string }; scheduling: { startTime: string; endTime: string }; lineItems: Array<{ unitPrice: number; quantity: number }> };
        const p = props.get(input.propertyId); const id = `JOB-${++n}`; const off = '-06:00';
        const s = Date.parse(`${input.timeframe.startAt}T${input.scheduling.startTime}${off}`) + opts.shiftVisitMs; const e = Date.parse(`${input.timeframe.startAt}T${input.scheduling.endTime}${off}`) + opts.shiftVisitMs;
        jobs.set(id, { id, jobNumber: 1000 + n, title: input.title, instructions: input.instructions, jobStatus: 'UPCOMING', total: input.lineItems.reduce((a, l) => a + l.unitPrice * l.quantity, 0), client: p?.client, property: { address: p?.address }, visits: { nodes: [{ startAt: new Date(s).toISOString(), endAt: new Date(e).toISOString() }] } });
        if (opts.crashAfterJobCreate) return send(500, {});
        return data({ jobCreate: { job: { id, jobNumber: 1000 + n }, userErrors: [] } });
      }
      if (/FindTestJobs/.test(b.query)) { ops.push({ kind: 'query', field: 'jobs', variables: v }); return data({ jobs: { nodes: opts.searchBlind ? [] : [...jobs.values()].filter((j) => String(j.title).includes(String(v.term))).map((j) => ({ id: j.id, title: j.title })) } }); }
      if (/ReadBackJob/.test(b.query)) { ops.push({ kind: 'query', field: 'job', variables: v }); return data({ job: jobs.get(String(v.id)) ?? null }); }
      return data({});
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { endpoints: { authorize: `${origin}/a`, token: `${origin}/t`, graphql: `${origin}/api/graphql` }, ops, opts, jobs, get clients() { return clients; }, close: () => new Promise((ok) => { server.close(() => ok()); server.closeAllConnections(); }) } as Mock;
}
interface Rig { mock: Mock; ctx: Ctx; logs: Array<[string, unknown]>; dir: string; done(): Promise<void> }
async function rig(writes = true): Promise<Rig> {
  const mock = await mockJobber(); const dir = mkdtempSync(join(tmpdir(), 'jobber-booking-')); const logs: Array<[string, unknown]> = [];
  const vault = createVault(dir, fakeProtector);
  await vault.saveTokens({ access_token: 'tok-valid-0123456789', refresh_token: 'refresh-0123456789', expires_at: NOW + 3_000_000, account_id: ACCOUNT.id, account_name: ACCOUNT.name });
  const ctx: Ctx = { vault, endpoints: mock.endpoints, fetch: globalThis.fetch as unknown as FetchLike, now: () => NOW, diag: (c, d) => { logs.push([c, d]); }, timeoutMs: 5000, ...(writes ? { allowWrites: { expectedAccountName: ACCOUNT.name } } : {}) };
  return { mock, ctx, logs, dir, done: async () => { await mock.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const mutations = (m: Mock): string[] => m.ops.filter((o) => o.kind === 'mutation').map((o) => o.field);

test('the connector stays read-only by default: with writes off no mutation can be sent, and with them on only the two allowed fields can, with no alias, directive or second operation', async () => {
  const r = await rig(false);
  try {
    await assert.rejects(mutate(r.ctx, CREDS, 'mutation M($input: ClientCreateInput!) { clientCreate(input: $input) { client { id } } }', {}), (e: unknown) => e instanceof JobberError && e.code === 'NOT_READ_ONLY');
    assert.equal(r.mock.ops.length, 0, 'nothing was sent');
    assert.deepEqual([...WRITE_ALLOWLIST], ['clientCreate', 'jobCreate']);
    const ok = 'mutation A($i: JobCreateAttributes!) { jobCreate(input: $i) { job { id } userErrors { message } } }';
    assert.deepEqual(mutationFields(ok), ['jobCreate']);
    assert.deepEqual(mutationFields('mutation A($a: X!, $b: Y!) { clientCreate(input: $a) { client { id } } jobCreate(input: $b) { job { id } } }'), ['clientCreate', 'jobCreate']);
    for (const bad of ['mutation D { appDisconnect { app { name } } }', 'mutation D { jobClose(jobId: "x", input: {}) { job { id } } }', 'mutation D { visitDelete(visitIds: []) { x } }', 'mutation D { x: appDisconnect { app { name } } }', 'mutation D { jobCreate(input: {}) @include(if: true) { job { id } } }', 'mutation D { jobCreate(input: {}) { job { id } } } mutation E { appDisconnect { x } }', 'query Q { account { id } }', 'mutation D { jobCreate(input: {}) { job { id } } } query Q { account { id } }', '']) assert.equal(mutationFields(bad) === undefined || mutationFields(bad)!.some((f) => !WRITE_ALLOWLIST.includes(f)), true, bad.slice(0, 30));
    const on = await rig(true);
    try {
      for (const bad of ['mutation D { appDisconnect { app { name } } }', 'mutation D { visitDelete(visitIds: []) { x } }', 'mutation D { x: clientCreate(input: {}) { client { id } } }']) await assert.rejects(mutate(on.ctx, CREDS, bad, {}), (e: unknown) => e instanceof JobberError && e.code === 'NOT_READ_ONLY', bad.slice(0, 30));
      assert.equal(on.mock.ops.length, 0, 'a refused document is never sent, and the account was not even asked');
      await assert.rejects(query(on.ctx, CREDS, 'mutation M { clientCreate(input: {}) { client { id } } }'), (e: unknown) => e instanceof JobberError && e.code === 'NOT_READ_ONLY');
    } finally { await on.done(); }
  } finally { await r.done(); }
});

test('the write path re-checks the account itself (not only the booking code): a valid allowed mutation to the wrong account, or to the right name with another id, is refused before it is sent', async () => {
  const r = await rig();
  try {
    const doc = 'mutation M($input: ClientCreateInput!) { clientCreate(input: $input) { client { id } userErrors { message } } }';
    r.mock.opts.account = { id: 'ACCT-OTHER', name: 'Some Real Business' };
    await assert.rejects(mutate(r.ctx, CREDS, doc, { input: {} }), (e: unknown) => e instanceof JobberError && e.code === 'ACCOUNT_MISMATCH');
    r.mock.opts.account = { id: 'ACCT-TEST-9', name: ACCOUNT.name };
    await assert.rejects(mutate(r.ctx, CREDS, doc, { input: {} }), (e: unknown) => e instanceof JobberError && e.code === 'ACCOUNT_MISMATCH');
    assert.deepEqual(mutations(r.mock), []);
    r.mock.opts.account = ACCOUNT;
    await mutate(r.ctx, CREDS, doc, { input: { firstName: 'Testa', lastName: 'Invented' } });
    assert.deepEqual(mutations(r.mock), ['clientCreate']);
  } finally { await r.done(); }
});

test('request gate: the three literal approvals, strict patterns and a future, same-day, at-most-eight-hour visit; only field NAMES are reported', () => {
  assert.deepEqual(requestProblems(REQ, NOW), []);
  const bad = (o: Partial<BookingRequest> | Record<string, unknown>) => requestProblems({ ...REQ, ...o }, NOW);
  assert.ok(bad({ gate: { ...REQ.gate, approvedByPerson: false } }).includes('gate'));
  assert.ok(bad({ gate: {} }).includes('gate')); assert.ok(bad({ gate: undefined }).includes('gate'));
  assert.ok(bad({ key: 'short' }).includes('key'));
  assert.ok(bad({ client: { ...REQ.client, phone: '12345' } }).includes('client.phone'));
  assert.ok(bad({ client: { ...REQ.client, firstName: 'X<script>' } }).includes('client.firstName'));
  assert.ok(bad({ address: { ...REQ.address, postalCode: '9021' } }).includes('address.postalCode'));
  assert.ok(bad({ when: { ...REQ.when, date: '2026-11-01' } }).includes('when'), 'in the past');
  assert.ok(bad({ when: { ...REQ.when, endTime: '08:00' } }).includes('when'));
  assert.ok(bad({ when: { ...REQ.when, startTime: '08:00', endTime: '17:00' } }).includes('when'), 'longer than eight hours');
  assert.ok(bad({ when: { ...REQ.when, utcOffset: 'CST' } }).includes('when'));
  for (const p of [0, -5, 199.999, NaN, 1e9]) assert.ok(bad({ priceDollars: p }).includes('priceDollars'), String(p));
  assert.deepEqual(bad({ priceDollars: 199.5 }), []);
  assert.ok(!JSON.stringify(bad({ client: { ...REQ.client, phone: '12345' } })).includes('12345'), 'no value in the report');
});

test('one booking: the account is checked first, a test client with ONE property and a job are created with the schema-verified input, notifications are off, and the independent read-back verifies every field', async () => {
  const r = await rig();
  try {
    const res = await bookTestVisit(r.ctx, CREDS, REQ);
    assert.deepEqual([res.status, res.writes, res.duplicate], ['booked_verified', 2, undefined]);
    assert.match(res.jobId ?? '', /^JOB-/);
    assert.deepEqual(mutations(r.mock), ['clientCreate', 'jobCreate']);
    assert.equal(r.mock.ops[0].field, 'account', 'the test account is verified before anything else');
    const ci = r.mock.ops.find((o) => o.field === 'clientCreate')!.variables.input as Record<string, unknown>;
    assert.deepEqual([ci.receivesReminders, ci.receivesFollowUps, ci.receivesQuoteFollowUps, ci.receivesInvoiceFollowUps, ci.receivesReviewRequests], [false, false, false, false, false]);
    assert.deepEqual(ci.phones, [{ number: '5550104242', description: 'MOBILE', smsAllowed: false, primary: true }]);
    assert.equal((ci.properties as unknown[]).length, 1);
    const ji = r.mock.ops.find((o) => o.field === 'jobCreate')!.variables.input as ReturnType<typeof jobInput> & { scheduling: Record<string, unknown>; invoicing: Record<string, unknown>; lineItems: Array<Record<string, unknown>> };
    assert.deepEqual([ji.scheduling.createVisits, ji.scheduling.notifyTeam, ji.scheduling.startTime, ji.scheduling.endTime], [true, false, '09:00:00', '11:00:00']);
    assert.deepEqual(ji.invoicing, { invoicingType: 'FIXED_PRICE', invoicingSchedule: 'ON_COMPLETION' });
    assert.deepEqual([ji.lineItems[0].unitPrice, ji.lineItems[0].quantity, ji.lineItems[0].saveToProductsAndServices], [199, 1, false]);
    assert.ok(String(ji.title).endsWith(`[${markerFor(REQ.key)}]`) && String(ji.instructions).includes(markerFor(REQ.key)));
    assert.equal(r.mock.ops.at(-1)!.field, 'job', 'the last step is the read-back by id');
    assert.deepEqual(clientInput(REQ).properties, [{ address: { street1: '123 Invented Lane', city: 'Testville', postalCode: '90210', province: 'CA' } }]);
  } finally { await r.done(); }
});

test('duplicate prevention: the same key again writes NOTHING and only re-verifies; two simultaneous calls make one booking; a lost ledger is rebuilt from the marker in Jobber', async () => {
  const r = await rig();
  try {
    const first = await bookTestVisit(r.ctx, CREDS, REQ);
    const writesBefore = mutations(r.mock).length;
    const again = await bookTestVisit(r.ctx, CREDS, REQ);
    assert.deepEqual([again.status, again.duplicate, again.writes, again.jobId], ['booked_verified', true, 0, first.jobId]);
    assert.equal(mutations(r.mock).length, writesBefore, 'no second client or job');
    for (const f of readdirSync(r.dir).filter((x) => x.startsWith('jobber-booking-ledger'))) assert.ok(!/Invented|Testville|5550104242/.test(readFileSync(join(r.dir, f), 'utf8')), 'the ledger holds no personal detail');
    // a lost ledger
    for (const f of readdirSync(r.dir).filter((x) => x.startsWith('jobber-booking-ledger'))) rmSync(join(r.dir, f));
    const rebuilt = await bookTestVisit(r.ctx, CREDS, REQ);
    assert.deepEqual([rebuilt.status, rebuilt.duplicate, rebuilt.writes], ['booked_verified', true, 0]);
    assert.equal(mutations(r.mock).length, writesBefore);
    // two at once, a new key
    const k2 = { ...REQ, key: 'call-fedcba9876543210' };
    const [a, b] = await Promise.all([bookTestVisit(r.ctx, CREDS, k2), bookTestVisit(r.ctx, CREDS, k2)]);
    assert.deepEqual([a.status, b.status], ['booked_verified', 'booked_verified']);
    assert.equal(mutations(r.mock).filter((m) => m === 'jobCreate').length, 2, 'one job for each of the two keys, not three');
    assert.equal([...r.mock.jobs.values()].filter((j) => String(j.title).includes(markerFor(k2.key))).length, 1);
  } finally { await r.done(); }
});

test('the ledger alone prevents a repeat even when the search in Jobber cannot find the job: a finished key is never booked again', async () => {
  const r = await rig();
  try {
    const first = await bookTestVisit(r.ctx, CREDS, REQ);
    r.mock.opts.searchBlind = true; const before = mutations(r.mock).length;
    const again = await bookTestVisit(r.ctx, CREDS, REQ);
    assert.deepEqual([again.status, again.duplicate, again.writes, again.jobId], ['booked_verified', true, 0, first.jobId]);
    assert.equal(mutations(r.mock).length, before);
  } finally { await r.done(); }
});

test('partial failures: a refused job keeps the client and a retry reuses it; a refused client leaves nothing; an unknown outcome is never retried blindly but is adopted when Jobber has the job', async () => {
  const r = await rig();
  try {
    r.mock.opts.jobUserErrors = true;
    const a = await bookTestVisit(r.ctx, CREDS, REQ);
    assert.deepEqual([a.status, a.reason, a.writes], ['not_booked', 'JOBBER_REFUSED', 2]); assert.equal(r.mock.jobs.size, 0);
    r.mock.opts.jobUserErrors = false;
    const b = await bookTestVisit(r.ctx, CREDS, REQ);
    assert.deepEqual([b.status, b.writes], ['booked_verified', 1]); assert.equal(r.mock.clients, 1, 'the client from the first try was reused');
    // refused client
    const k = { ...REQ, key: 'call-1111222233334444' }; r.mock.opts.clientUserErrors = true;
    assert.deepEqual((await bookTestVisit(r.ctx, CREDS, k)).reason, 'JOBBER_REFUSED'); r.mock.opts.clientUserErrors = false;
    assert.equal((await bookTestVisit(r.ctx, CREDS, k)).status, 'booked_verified', 'nothing was left half-done');
    // the job was created but the answer was lost
    const u = { ...REQ, key: 'call-5555666677778888' }; r.mock.opts.crashAfterJobCreate = true;
    const lost = await bookTestVisit(r.ctx, CREDS, u);
    assert.deepEqual([lost.status, lost.reason], ['uncertain', 'API_ERROR']);
    r.mock.opts.crashAfterJobCreate = false; const jobsBefore = r.mock.jobs.size; const writesBefore = mutations(r.mock).length;
    const adopted = await bookTestVisit(r.ctx, CREDS, u);
    assert.deepEqual([adopted.status, adopted.duplicate, adopted.writes], ['booked_verified', true, 0]);
    assert.equal(r.mock.jobs.size, jobsBefore); assert.equal(mutations(r.mock).length, writesBefore, 'no second job');
    // an unknown outcome where Jobber has NO job: not retried
    const w = { ...REQ, key: 'call-9999000011112222' }; r.mock.opts.failJobCreateStatus = 500;
    assert.equal((await bookTestVisit(r.ctx, CREDS, w)).status, 'uncertain'); r.mock.opts.failJobCreateStatus = undefined;
    const retry = await bookTestVisit(r.ctx, CREDS, w); const sent = mutations(r.mock).length;
    assert.deepEqual([retry.status, retry.reason, retry.writes], ['uncertain', 'PENDING_UNRESOLVED', 0]); assert.equal(mutations(r.mock).length, sent);
  } finally { await r.done(); }
});

test('independent read-back: a visit that is an hour off is NOT a booking (uncertain, with the field name only); nothing is claimed that the read-back did not verify', async () => {
  const r = await rig();
  try {
    r.mock.opts.shiftVisitMs = 3_600_000;
    const res = await bookTestVisit(r.ctx, CREDS, REQ);
    assert.deepEqual([res.status, res.reason, res.mismatches], ['uncertain', 'READBACK_MISMATCH', ['visit_time']]);
    assert.ok(!JSON.stringify(res).includes('Invented'));
    const again = await bookTestVisit(r.ctx, CREDS, REQ);
    assert.deepEqual([again.status, again.duplicate, again.writes], ['uncertain', true, 0], 'a retry does not create a second job to "fix" it');
  } finally { await r.done(); }
});

test('test account only: writes off, the wrong account, a wrong request or a missing approval each stop before any write; the account is re-checked on every booking', async () => {
  const off = await rig(false);
  try {
    assert.deepEqual([(await bookTestVisit(off.ctx, CREDS, REQ)).reason, off.mock.ops.length], ['WRITES_OFF', 0]);
  } finally { await off.done(); }
  const r = await rig();
  try {
    r.mock.opts.account = { id: 'ACCT-OTHER', name: 'Some Real Business' };
    const res = await bookTestVisit(r.ctx, CREDS, REQ);
    assert.deepEqual([res.status, res.reason, res.writes], ['not_booked', 'ACCOUNT_MISMATCH', 0]); assert.deepEqual(mutations(r.mock), []);
    r.mock.opts.account = { id: 'ACCT-TEST-9', name: ACCOUNT.name };
    assert.equal((await bookTestVisit(r.ctx, CREDS, REQ)).reason, 'ACCOUNT_MISMATCH', 'same name, different id');
    r.mock.opts.account = ACCOUNT;
    const sentBefore = r.mock.ops.length;
    assert.deepEqual([(await bookTestVisit(r.ctx, CREDS, { ...REQ, gate: { ...REQ.gate, callerAgreed: false } as never })).reason, (await bookTestVisit(r.ctx, CREDS, { ...REQ, client: { ...REQ.client, phone: '1' } })).reason], ['NOT_AUTHORIZED', 'INVALID_REQUEST']);
    assert.equal(r.mock.ops.length, sentBefore, 'invalid or unapproved requests never reach Jobber');
  } finally { await r.done(); }
});

test('privacy and isolation: no name, phone, address or token in any diagnostic or result; nothing else imports the adapter or the simulated booking path; the booking module imports no network or contact code', async () => {
  const r = await rig();
  try {
    r.mock.opts.shiftVisitMs = 3_600_000; r.mock.opts.jobUserErrors = false;
    const res = await bookTestVisit(r.ctx, CREDS, REQ);
    const all = JSON.stringify([r.logs, res]);
    for (const secret of ['Testa', 'Invented', 'Testville', '90210', '5550104242', '555) 010', 'tok-valid', 'refresh-0123']) assert.ok(!all.includes(secret), `no ${secret} in logs or results`);
  } finally { await r.done(); }
  const src = join(import.meta.dirname, '..', 'src');
  const importers = readdirSync(src).filter((f) => f.endsWith('.ts') && !/^jobber-/.test(f)).filter((f) => /from '\.\/jobber-(booking|connector|dpapi|browser|connect-main)\.ts'/.test(readFileSync(join(src, f), 'utf8')));
  // Only the fast test call's own modules and the entry points may use the Jobber modules. The call logic, the bridge, the transports and the SIMULATED booking checkpoint never do.
  assert.deepEqual(importers, ['fast-call-handler.ts', 'fast-test-setup-main.ts', 'founder-voice-entry.ts', 'founder-voice-fast.ts'], 'the call logic and the simulated booking checkpoint do not import any Jobber module');
  for (const never of ['simulated-booking.ts', 'relay-handler.ts', 'realtime-bridge.ts', 'realtime-transport.ts', 'call-transport.ts', 'founder-voice-service.ts']) assert.ok(!/from '\.\/jobber-/.test(readFileSync(join(src, never), 'utf8')), `${never} imports no Jobber module`);
  const text = readFileSync(join(src, 'jobber-booking.ts'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/node:(http|https|net|child_process|fs)'|contact-vault|process\.env|fetch\(/.test(text), 'no network, file, process, environment or contact-vault access of its own');
});
