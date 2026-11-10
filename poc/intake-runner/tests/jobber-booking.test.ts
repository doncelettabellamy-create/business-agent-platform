// The test-account-only Jobber booking adapter, tested against a local stand-in for Jobber's GraphQL API. NOTHING here contacts Jobber, creates a real booking or sends a text. Every name, number and address is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { linkSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVault, JobberError, mutate, mutationFields, query, WRITE_ALLOWLIST } from '../src/jobber-connector.ts';
import type { Credentials, Ctx, FetchLike, Protector } from '../src/jobber-connector.ts';
import { bookTestVisit, clientInput, jobInput, markerFor, requestProblems } from '../src/jobber-booking.ts';
import type { BookingRequest, IdentityBookingRequest } from '../src/jobber-booking.ts';
import { bookingIdentity } from '../src/booking-identity.ts';
import { scanLedger } from '../src/jobber-ledger-scan.ts';
import type { IdentityParts } from '../src/booking-identity.ts';

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

interface Opts { account: { id: string; name: string }; searchBlind: boolean; jobUserErrors: boolean; clientUserErrors: boolean; shiftVisitMs: number; crashAfterJobCreate: boolean; failJobCreateStatus?: number; /** What the read-back returns for the property's state: a string, null (Jobber has none), or undefined (the property is returned as it was written). */ readProvince?: string | null; /** Set by the stand-in: whether the last read-back query asked for the property's state. */ askedProvince?: boolean }
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
      if (/ReadBackJob/.test(b.query)) {
        ops.push({ kind: 'query', field: 'job', variables: v }); opts.askedProvince = /[{ ]province[ }]/.test(b.query); const jb = jobs.get(String(v.id));
        if (jb !== undefined && opts.readProvince !== undefined) { const addr = { ...((jb.property as { address: Record<string, unknown> }).address) }; if (opts.readProvince === null) addr.province = null; else addr.province = opts.readProvince; return data({ job: { ...jb, property: { address: addr } } }); }
        return data({ job: jb ?? null });
      }
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
  const far = { ...REQ.when, date: '2027-10-04' }; assert.ok(requestProblems({ ...REQ, when: far }, NOW).includes('when'), 'a visit more than 30 days ahead is refused before any write');
  const bad = (o: Partial<BookingRequest> | Record<string, unknown>) => requestProblems({ ...REQ, ...o }, NOW);
  assert.ok(bad({ address: { ...REQ.address, street1: 'Woodland Hills Drive' } }).includes('address.street1'), 'a street without a house number is never written'); assert.ok(bad({ address: { ...REQ.address, street1: `${REQ.address.postalCode} Woodland Hills Drive` } }).includes('address.street1'), 'a house number equal to the ZIP is never written'); assert.ok(bad({ address: { ...REQ.address, province: undefined } }).includes('address.province'), 'no state, no write');
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
  assert.deepEqual(importers, ['booking-identity-setup-main.ts', 'fast-call-handler.ts', 'fast-test-setup-main.ts', 'founder-voice-entry.ts', 'founder-voice-fast.ts'], 'the call logic and the simulated booking checkpoint do not import any Jobber module');
  for (const never of ['simulated-booking.ts', 'relay-handler.ts', 'realtime-bridge.ts', 'realtime-transport.ts', 'call-transport.ts', 'founder-voice-service.ts']) assert.ok(!/from '\.\/jobber-/.test(readFileSync(join(src, never), 'utf8')), `${never} imports no Jobber module`);
  const text = readFileSync(join(src, 'jobber-booking.ts'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/node:(http|https|net|child_process|fs)'|contact-vault|process\.env|fetch\(/.test(text), 'no network, file, process, environment or contact-vault access of its own');
});

test('independent read-back of the STATE: the requested state matches as a code in any case or as the full name; a missing, unknown or different state is uncertain with the field name only, never a verified booking', async () => {
  const r = await rig();
  try {
    const ok = await bookTestVisit(r.ctx, CREDS, REQ);
    assert.deepEqual([ok.status, ok.mismatches], ['booked_verified', undefined], 'the state as written (CA) matches the request (ca)');
    const read = r.mock.ops.filter((o) => o.field === 'job' && o.kind === 'query').length; assert.ok(read >= 1, 'the job was read back by id');
    assert.equal(r.mock.opts.askedProvince, true, 'the read-back query asks Jobber for the property state');
    const n = { ca: 'ca', cap: 'CA', full: 'California', mixed: 'california', spaced: '  California ' };
    let i = 0;
    for (const [label, shown] of Object.entries(n)) {
      r.mock.opts.readProvince = shown; const k = { ...REQ, key: 'call-state' + String(++i).padStart(4, '0') + '00001111' };
      const res = await bookTestVisit(r.ctx, CREDS, k); assert.equal(res.status, 'booked_verified', label + ': ' + shown);
    }
    for (const [label, shown] of [['missing', null], ['empty', ''], ['unknown name', 'Ontario'], ['abbreviation that is no state', 'Calif.'], ['different state', 'TX'], ['different full name', 'Texas'], ['a sentence', 'the state of California']] as Array<[string, string | null]>) {
      r.mock.opts.readProvince = shown; const k = { ...REQ, key: 'call-state' + String(++i).padStart(4, '0') + '00002222' };
      const res = await bookTestVisit(r.ctx, CREDS, k);
      assert.deepEqual([res.status, res.reason, res.mismatches], ['uncertain', 'READBACK_MISMATCH', ['province']], label);
      assert.ok(!JSON.stringify(res).includes('Texas') && !JSON.stringify(res).includes('Ontario'), 'the field name only, never the value');
    }
  } finally { await r.done(); }
});

// ================================================================ lock ownership: a booking that has lost its lock stops before the next write
const lockOf = (r: Rig, req: BookingRequest): string => join(r.dir, 'booking-' + markerFor(req.key).toLowerCase() + '.lock');
const ledgerOf = async (r: Rig, req: BookingRequest = REQ): Promise<Record<string, { state: string; jobId?: string }>> => { const base = 'jobber-booking-ledger-' + markerFor(req.key).toLowerCase(); const gens = r.ctx.vault.generations(base); if (gens.length === 0) return {}; const t = await r.ctx.vault.loadBlob(`${base}.${gens[gens.length - 1]}`); return t === undefined ? {} : { [markerFor(req.key)]: (JSON.parse(t) as { entry: { state: string; jobId?: string } }).entry }; };
type FetchInit = { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal };
/** Runs `act` once, right after the first response to a request whose body matches `when` (the lock is taken away at exactly that moment). */
const afterResponse = (r: Rig, when: RegExp, act: () => void): void => { const real = r.ctx.fetch; let fired = false; r.ctx.fetch = (async (url: string, init: FetchInit) => { const res = await real(url, init); if (!fired && when.test(String(init.body ?? ''))) { fired = true; act(); } return res; }) as unknown as FetchLike; };

test('lock lost during a booking: after the client is created the lock disappears; the job is NOT created, the result is uncertain with LOCK_LOST, only one mutation was sent, and a later attempt is stopped as unresolved (no second client, no job)', async () => {
  const r = await rig();
  try {
    const real = r.ctx.fetch; afterResponse(r, /clientCreate/, () => rmSync(lockOf(r, REQ), { force: true }));
    const res = await bookTestVisit(r.ctx, CREDS, REQ);
    assert.deepEqual([res.status, res.reason, res.writes], ['uncertain', 'LOCK_LOST', 1]); assert.deepEqual(mutations(r.mock), ['clientCreate'], 'the job was never sent'); assert.equal(r.mock.jobs.size, 0);
    r.ctx.fetch = real; const again = await bookTestVisit(r.ctx, CREDS, REQ);
    assert.deepEqual([again.status, again.reason], ['uncertain', 'PENDING_UNRESOLVED']); assert.deepEqual(mutations(r.mock), ['clientCreate'], 'nothing more was sent'); assert.equal(r.mock.jobs.size, 0);
  } finally { await r.done(); }
});

test('lock lost before any write: nothing is sent, the result is not_booked with LOCK_LOST and writes 0; the lock of whoever took over is left alone', async () => {
  const r = await rig();
  try {
    afterResponse(r, /FindTestJobs/, () => writeFileSync(lockOf(r, REQ), 'another-holder'));
    const res = await bookTestVisit(r.ctx, CREDS, REQ);
    assert.deepEqual([res.status, res.reason, res.writes], ['not_booked', 'LOCK_LOST', 0]); assert.deepEqual(mutations(r.mock), []); assert.equal(readFileSync(lockOf(r, REQ), 'utf8'), 'another-holder', 'owner-only release');
  } finally { await r.done(); }
});

test('lock lost at the final ledger save (the job already exists in Jobber): uncertain with LOCK_LOST and 2 writes, the ledger is still pending; a retry that can see the job verifies that SAME job and sends nothing; a retry that cannot see it is stopped as PENDING_UNRESOLVED and sends nothing', async () => {
  for (const blind of [false, true]) {
    const r = await rig();
    try {
      const real = r.ctx.fetch; afterResponse(r, /jobCreate/, () => rmSync(lockOf(r, REQ), { force: true }));
      const res = await bookTestVisit(r.ctx, CREDS, REQ);
      assert.deepEqual([res.status, res.reason, res.writes], ['uncertain', 'LOCK_LOST', 2], 'blind=' + blind); assert.deepEqual(mutations(r.mock), ['clientCreate', 'jobCreate']); assert.equal(r.mock.jobs.size, 1, 'the job exists in Jobber');
      assert.equal((await ledgerOf(r))[markerFor(REQ.key)]?.state, 'pending', 'the ledger was not advanced after the loss');
      const jobId = [...r.mock.jobs.keys()][0];
      r.ctx.fetch = real; r.mock.opts.searchBlind = blind;
      const again = await bookTestVisit(r.ctx, CREDS, REQ);
      if (!blind) { assert.deepEqual([again.status, again.jobId, again.duplicate, again.writes], ['booked_verified', jobId, true, 0], 'the same job, found by its marker'); const fixed = (await ledgerOf(r))[markerFor(REQ.key)]; assert.deepEqual([fixed?.state, fixed?.jobId], ['created', jobId], 'the ledger is repaired'); }
      else { assert.deepEqual([again.status, again.reason, again.writes], ['uncertain', 'PENDING_UNRESOLVED', 0], 'a job nobody can see is not booked again'); }
      assert.deepEqual(mutations(r.mock), ['clientCreate', 'jobCreate'], 'the retry sent no write, blind=' + blind); assert.equal(r.mock.jobs.size, 1, 'still one job, blind=' + blind);
    } finally { await r.done(); }
  }
});

test('lock lost during the read-back (after the job exists and the ledger says created): the booking is still reported as verified, the ledger stays created, and nothing more is sent', async () => {
  const r = await rig();
  try {
    afterResponse(r, /ReadBackJob/, () => rmSync(lockOf(r, REQ), { force: true }));
    const res = await bookTestVisit(r.ctx, CREDS, REQ); const jobId = [...r.mock.jobs.keys()][0];
    assert.deepEqual([res.status, res.jobId, res.writes], ['booked_verified', jobId, 2]); assert.deepEqual(mutations(r.mock), ['clientCreate', 'jobCreate']);
    const entry = (await ledgerOf(r))[markerFor(REQ.key)]; assert.deepEqual([entry?.state, entry?.jobId], ['created', jobId]);
    const again = await bookTestVisit(r.ctx, CREDS, REQ); assert.deepEqual([again.status, again.duplicate, again.writes], ['booked_verified', true, 0]); assert.deepEqual(mutations(r.mock), ['clientCreate', 'jobCreate'], 'no second job'); assert.equal(r.mock.jobs.size, 1);
  } finally { await r.done(); }
});

test('lock ownership, at every check: losing the lock at the k-th check (before each ledger write and each Jobber write) never lets a write follow, never reports booked, and sends at most the writes made before the loss', async () => {
  let sent = new Set<string>();
  for (let k = 1; k <= 12; k++) {
    const r = await rig();
    try {
      const real = r.ctx.vault.withLock.bind(r.ctx.vault); let checks = 0; let seenChecks = 0;
      (r.ctx.vault as { withLock: unknown }).withLock = (name: string, fn: (l: { assertHeld(): void }) => Promise<unknown>, w?: number) => real(name, async (lock) => fn({ assertHeld: () => { seenChecks++; if (++checks >= k) throw new JobberError('LOCK_LOST'); lock.assertHeld(); } }), w);
      const res = await bookTestVisit(r.ctx, CREDS, REQ);
      if (res.reason === 'LOCK_LOST') { assert.notEqual(res.status, 'booked_verified', 'k=' + k); assert.ok(mutations(r.mock).length <= 2, 'k=' + k); assert.ok(res.writes === mutations(r.mock).length, 'writes counts only requests that were sent, k=' + k); sent.add(mutations(r.mock).join('+')); }
      else { assert.equal(res.status, 'booked_verified', 'k=' + k + ': the loss came after the last check'); assert.deepEqual(mutations(r.mock), ['clientCreate', 'jobCreate']); }
      assert.ok(seenChecks >= 1);
    } finally { await r.done(); }
  }
  assert.ok(sent.has('') && sent.has('clientCreate'), 'both "before any write" and "after the client" were exercised: ' + [...sent].join(' | '));
});

test('lock source: every Jobber write and every ledger write in the booking goes through a checked helper; no other call to mutate or the ledger save exists inside the lock', () => {
  const src = readFileSync(new URL('../src/jobber-booking.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal([...src.matchAll(/\bmutate\(/g)].length, 1, 'one call to mutate, inside write()'); assert.ok(/const write = \(query: string, variables: Record<string, unknown>\): ReturnType<typeof mutate> => \{ lock\.assertHeld\(\); writes\+\+; return mutate\(ctx, creds, query, variables\); \};/.test(src));
  assert.ok(/const save = async \(\): Promise<void> => \{/.test(src), 'every ledger write goes through save()');
  assert.ok(/code === 'LOCK_LOST' \|\| code === 'LEDGER_UNREADABLE'/.test(src), 'a lost lock has its own reason');
});

// ================================================================ the per-key generation ledger: layout, concurrency, migration from the older single file, corruption, crash windows
const ledgerName = (req: BookingRequest = REQ): string => 'jobber-booking-ledger-' + markerFor(req.key).toLowerCase();
const genPath = (r: Rig, n: number, req: BookingRequest = REQ): string => join(r.dir, `${ledgerName(req)}.${n}.enc`);
const legacyPath = (r: Rig): string => join(r.dir, 'jobber-booking-ledger.enc');
const ledgerFileBytes = (r: Rig): Record<string, string> => Object.fromEntries(readdirSync(r.dir).filter((f) => f.startsWith('jobber-booking-ledger')).sort().map((f) => [f, readFileSync(join(r.dir, f), 'utf8')]));
const chainOf = async (r: Rig, req: BookingRequest = REQ): Promise<Array<{ gen: number; state: string; clientId?: string; jobId?: string }>> => {
  const out: Array<{ gen: number; state: string; clientId?: string; jobId?: string }> = [];
  for (const n of r.ctx.vault.generations(ledgerName(req))) { const o = JSON.parse((await r.ctx.vault.loadBlob(`${ledgerName(req)}.${n}`)) as string) as { entry: { state: string; clientId?: string; jobId?: string } }; out.push({ gen: n, ...o.entry }); }
  return out;
};
const seedGen = async (r: Rig, n: number, entry: unknown, over: Record<string, unknown> = {}, req: BookingRequest = REQ): Promise<void> => { writeFileSync(genPath(r, n, req), await fakeProtector.protect(JSON.stringify({ version: 2, marker: markerFor(req.key), gen: n, entry, ...over }))); };
const seedLegacy = async (r: Rig, entries: unknown, version: unknown = 1): Promise<void> => { await r.ctx.vault.saveBlob('jobber-booking-ledger', JSON.stringify({ version, entries })); };
/** Turns the key's generation chain back into what the older code would have left: one legacy file with that entry, no generation files. */
const toLegacy = async (r: Rig, req: BookingRequest = REQ): Promise<{ state: string; clientId?: string; propertyId?: string; jobId?: string }> => {
  const gens = r.ctx.vault.generations(ledgerName(req)); const last = JSON.parse((await r.ctx.vault.loadBlob(`${ledgerName(req)}.${gens[gens.length - 1]}`)) as string) as { entry: { state: string; clientId?: string; propertyId?: string; jobId?: string } };
  for (const n of gens) rmSync(genPath(r, n, req)); await seedLegacy(r, { [markerFor(req.key)]: last.entry }); return last.entry;
};
const blockedClean = (res: { status: string; reason?: string; writes: number }, reason: string): void => { assert.deepEqual([res.status, res.reason, res.writes], ['uncertain', reason, 0]); };

test('ledger layout: each key has its own chain of generation files 1..n, each written before the step it guards (pending, client_created, pending, created), each published once; no single shared file is created; no temporary file is left', async () => {
  const r = await rig();
  try {
    const res = await bookTestVisit(r.ctx, CREDS, REQ); assert.equal(res.status, 'booked_verified');
    const chain = await chainOf(r); assert.deepEqual(chain.map((c) => [c.gen, c.state]), [[1, 'pending'], [2, 'client_created'], [3, 'pending'], [4, 'created']]);
    assert.equal(chain[3].jobId, res.jobId); assert.equal(chain[1].clientId, chain[2].clientId);
    assert.equal(readdirSync(r.dir).includes('jobber-booking-ledger.enc'), false, 'the single shared file is not created'); assert.deepEqual(readdirSync(r.dir).filter((f) => f.endsWith('.tmp')), []);
    for (const t of Object.values(ledgerFileBytes(r))) assert.ok(!/Invented|Testville|5550104242/.test(t), 'no personal detail');
  } finally { await r.done(); }
});

test('two different keys at once keep both chains (the old shared file lost one of them): both book, each chain is complete, and one key\'s files are never touched by the other', async () => {
  const r = await rig();
  try {
    const k2 = { ...REQ, key: 'call-fedcba9876543210' };
    const [a, b] = await Promise.all([bookTestVisit(r.ctx, CREDS, REQ), bookTestVisit(r.ctx, CREDS, k2)]);
    assert.deepEqual([a.status, b.status], ['booked_verified', 'booked_verified']);
    assert.equal((await chainOf(r, REQ)).at(-1)?.state, 'created'); assert.equal((await chainOf(r, k2)).at(-1)?.state, 'created'); assert.equal((await chainOf(r, REQ)).length, 4); assert.equal((await chainOf(r, k2)).length, 4);
    const before = ledgerFileBytes(r); const k3 = { ...REQ, key: 'call-0000111122223333' }; await bookTestVisit(r.ctx, CREDS, k3);
    const after = ledgerFileBytes(r); for (const [f, bytes] of Object.entries(before)) assert.equal(after[f], bytes, 'untouched: ' + f);
  } finally { await r.done(); }
});

test('an EXPIRED holder cannot publish: its lock is replaced while its protect step is still running, so when the step finishes the guard stops it - no generation file, no write, the other holder\'s lock is left alone', async () => {
  const r = await rig(); let release: () => void = () => undefined; const gate = new Promise<void>((ok) => { release = ok; }); let entered = false;
  try {
    const slow: Protector = { protect: async (p) => { entered = true; await gate; return fakeProtector.protect(p); }, unprotect: fakeProtector.unprotect };
    const ctx: Ctx = { ...r.ctx, vault: createVault(r.dir, slow) };
    const p = bookTestVisit(ctx, CREDS, REQ);
    while (!entered) await new Promise((ok) => setTimeout(ok, 2));
    writeFileSync(lockOf(r, REQ), 'another-holder'); release();
    const res = await p;
    assert.deepEqual([res.status, res.reason, res.writes], ['not_booked', 'LOCK_LOST', 0]); assert.deepEqual(mutations(r.mock), []);
    assert.deepEqual(r.ctx.vault.generations(ledgerName()), [], 'nothing was published'); assert.equal(readFileSync(lockOf(r, REQ), 'utf8'), 'another-holder'); assert.deepEqual(readdirSync(r.dir).filter((f) => f.endsWith('.tmp')), []);
  } finally { release(); await r.done(); }
});

test('a really expired holder (its heartbeat never ran, another call took the lock after the stale age) is refused when it wakes, and the valid holder - which took over - finishes: one job, a clean chain written only by the valid holder', async () => {
  const r = await rig(); let release: () => void = () => undefined; const gate = new Promise<void>((ok) => { release = ok; }); let entered = false;
  try {
    const slow: Protector = { protect: async (p) => { entered = true; await gate; return fakeProtector.protect(p); }, unprotect: fakeProtector.unprotect };
    const ctxA: Ctx = { ...r.ctx, vault: createVault(r.dir, slow, { heartbeatMs: 60_000, staleMs: 600 }) };
    const ctxB: Ctx = { ...r.ctx, vault: createVault(r.dir, fakeProtector, { heartbeatMs: 40, staleMs: 600 }) };
    const a = bookTestVisit(ctxA, CREDS, REQ);
    while (!entered) await new Promise((ok) => setTimeout(ok, 2));
    const b = await bookTestVisit(ctxB, CREDS, REQ);   // waits for the stale age, takes the lock over, and books
    assert.equal(b.status, 'booked_verified'); assert.equal(b.writes, 2);
    release(); const resA = await a;
    assert.deepEqual([resA.status, resA.reason, resA.writes], ['not_booked', 'LOCK_LOST', 0], 'the expired holder wrote nothing');
    assert.deepEqual(mutations(r.mock), ['clientCreate', 'jobCreate']); assert.equal(r.mock.jobs.size, 1);
    assert.deepEqual((await chainOf(r)).map((c) => [c.gen, c.state]), [[1, 'pending'], [2, 'client_created'], [3, 'pending'], [4, 'created']], 'the chain is the valid holder\'s alone');
    assert.deepEqual(readdirSync(r.dir).filter((f) => f.endsWith('.tmp')), []);
  } finally { release(); await r.done(); }
});

test('the backstop: if another writer takes the next generation in the instant after this holder loaded the chain, the publish is refused - LEDGER_CONFLICT, uncertain, nothing sent, the other file untouched - and the next attempt fails closed on it', async () => {
  const r = await rig();
  try {
    afterResponse(r, /FindTestJobs/, () => writeFileSync(genPath(r, 1), 'a foreign writer got here first'));
    const res = await bookTestVisit(r.ctx, CREDS, REQ); blockedClean(res, 'LEDGER_CONFLICT'); assert.deepEqual(mutations(r.mock), []);
    assert.equal(readFileSync(genPath(r, 1), 'utf8'), 'a foreign writer got here first', 'overwritten by nobody'); assert.deepEqual(readdirSync(r.dir).filter((f) => f.endsWith('.tmp')), []);
    blockedClean(await bookTestVisit(r.ctx, CREDS, REQ), 'LEDGER_UNREADABLE'); assert.deepEqual(mutations(r.mock), []);
  } finally { await r.done(); }
});

test('a link that fails: at the first save it is LEDGER_UNAVAILABLE and not_booked with nothing sent; after the client was created it is uncertain, no job is sent, and a retry is stopped as PENDING_UNRESOLVED (no second client)', async () => {
  for (const failAt of [1, 2]) {
    const r = await rig();
    try {
      let n = 0; const vault = createVault(r.dir, fakeProtector, { linkFile: (from, to) => { if (++n === failAt) throw Object.assign(new Error('x'), { code: 'EPERM' }); linkSync(from, to); } });
      const res = await bookTestVisit({ ...r.ctx, vault }, CREDS, REQ);
      if (failAt === 1) { assert.deepEqual([res.status, res.reason, res.writes], ['not_booked', 'LEDGER_UNAVAILABLE', 0]); assert.deepEqual(mutations(r.mock), []); assert.deepEqual(r.ctx.vault.generations(ledgerName()), []); }
      else {
        assert.deepEqual([res.status, res.reason, res.writes], ['uncertain', 'LEDGER_UNAVAILABLE', 1]); assert.deepEqual(mutations(r.mock), ['clientCreate'], 'the job was never sent'); assert.deepEqual((await chainOf(r)).map((c) => c.state), ['pending']);
        const again = await bookTestVisit(r.ctx, CREDS, REQ); assert.deepEqual([again.status, again.reason, again.writes], ['uncertain', 'PENDING_UNRESOLVED', 0]); assert.deepEqual(mutations(r.mock), ['clientCreate']);
      }
      assert.deepEqual(readdirSync(r.dir).filter((f) => f.endsWith('.tmp')), [], 'failAt=' + failAt);
    } finally { await r.done(); }
  }
});

test('the generation cap: a chain at 99 cannot grow (LEDGER_UNAVAILABLE, nothing sent); a chain beyond 99 is unreadable', async () => {
  const r = await rig();
  try {
    for (let n = 1; n <= 99; n++) await seedGen(r, n, { state: 'none' });
    const res = await bookTestVisit(r.ctx, CREDS, REQ); assert.deepEqual([res.status, res.reason, res.writes], ['not_booked', 'LEDGER_UNAVAILABLE', 0]); assert.deepEqual(mutations(r.mock), []); assert.equal(r.ctx.vault.generations(ledgerName()).length, 99);
    await seedGen(r, 100, { state: 'none' }); blockedClean(await bookTestVisit(r.ctx, CREDS, REQ), 'LEDGER_UNREADABLE'); assert.deepEqual(mutations(r.mock), []);
  } finally { await r.done(); }
});

test('a cleared key ("none" after a refused client) is no prior state: the next attempt books normally, and the chain keeps growing from where it was', async () => {
  const r = await rig();
  try {
    r.mock.opts.clientUserErrors = true; assert.equal((await bookTestVisit(r.ctx, CREDS, REQ)).reason, 'JOBBER_REFUSED'); assert.deepEqual((await chainOf(r)).map((c) => c.state), ['pending', 'none']);
    r.mock.opts.clientUserErrors = false; const ok = await bookTestVisit(r.ctx, CREDS, REQ); assert.equal(ok.status, 'booked_verified');
    assert.deepEqual((await chainOf(r)).map((c) => c.state), ['pending', 'none', 'pending', 'client_created', 'pending', 'created']);
  } finally { await r.done(); }
});

// ---- corruption: every unreadable or invalid chain fails closed (uncertain, 0 writes, nothing sent) and is left exactly as it was
const BAD_CHAINS: Array<[string, (r: Rig) => Promise<void>]> = [
  ['an empty highest file', async (r) => { writeFileSync(genPath(r, 1), ''); }],
  ['garbage that cannot be decoded', async (r) => { writeFileSync(genPath(r, 1), 'zzzz not a protected file'); }],
  ['valid protection around text that is not JSON', async (r) => { writeFileSync(genPath(r, 1), await fakeProtector.protect('not json')); }],
  ['another key\'s marker inside', async (r) => { await seedGen(r, 1, { state: 'pending' }, { marker: 'DREWTEST-000000000000' }); }],
  ['a different generation number inside', async (r) => { await seedGen(r, 1, { state: 'pending' }, { gen: 2 }); }],
  ['an extra field in the file', async (r) => { await seedGen(r, 1, { state: 'pending' }, { extra: 1 }); }],
  ['the older file version', async (r) => { await seedGen(r, 1, { state: 'pending' }, { version: 1 }); }],
  ['a "created" entry with no job id', async (r) => { await seedGen(r, 1, { state: 'created' }); }],
  ['a "client_created" entry with no ids', async (r) => { await seedGen(r, 1, { state: 'client_created' }); }],
  ['a "pending" entry with a job id', async (r) => { await seedGen(r, 1, { state: 'pending', jobId: 'JOB-12345' }); }],
  ['a "pending" entry with only one id', async (r) => { await seedGen(r, 1, { state: 'pending', clientId: 'CLIENT-1' }); }],
  ['a "none" entry with ids', async (r) => { await seedGen(r, 1, { state: 'none', jobId: 'JOB-12345' }); }],
  ['an unknown state', async (r) => { await seedGen(r, 1, { state: 'done', jobId: 'JOB-12345' }); }],
  ['an unknown entry field', async (r) => { await seedGen(r, 1, { state: 'pending', note: 'x' }); }],
  ['an id that is not text', async (r) => { await seedGen(r, 1, { state: 'created', jobId: 12345 }); }],
  ['an id with forbidden characters', async (r) => { await seedGen(r, 1, { state: 'created', jobId: 'JOB 12 345; drop' }); }],
  ['an entry that is not an object', async (r) => { await seedGen(r, 1, 'created'); }],
  ['a gap in the numbers (1 and 3)', async (r) => { await seedGen(r, 1, { state: 'pending' }); await seedGen(r, 3, { state: 'pending' }); }],
  ['a generation 0 file', async (r) => { await seedGen(r, 0, { state: 'pending' }); }],
  ['a valid older generation under an unreadable newer one (no fallback)', async (r) => { await seedGen(r, 1, { state: 'pending' }); writeFileSync(genPath(r, 2), 'garbage'); }],
];
test('corruption: every bad generation chain (' + BAD_CHAINS.length + ' kinds) fails closed - uncertain, LEDGER_UNREADABLE, 0 writes, nothing sent - and every file is left byte-for-byte as it was', async () => {
  for (const [name, make] of BAD_CHAINS) {
    const r = await rig();
    try {
      await make(r); const before = ledgerFileBytes(r);
      const res = await bookTestVisit(r.ctx, CREDS, REQ); try { blockedClean(res, 'LEDGER_UNREADABLE'); } catch (e) { throw new Error(name + ': ' + (e as Error).message); }
      assert.deepEqual(mutations(r.mock), [], name); assert.deepEqual(ledgerFileBytes(r), before, name + ': untouched'); assert.deepEqual(readdirSync(r.dir).filter((f) => f.endsWith('.tmp')), [], name);
    } finally { await r.done(); }
  }
});

test('stray files do not matter: temporary files, other keys\' chains and misnumbered names beside a valid chain are ignored', async () => {
  const r = await rig();
  try {
    const stem = ledgerName(); writeFileSync(join(r.dir, `${stem}.1.enc.0123abcd.tmp`), 'orphan'); writeFileSync(join(r.dir, `${stem}.01.enc`), 'x'); writeFileSync(join(r.dir, `${stem}.1000.enc`), 'x'); writeFileSync(join(r.dir, `${stem}.x.enc`), 'x');
    await seedGen(r, 1, { state: 'pending' }, {}, { ...REQ, key: 'call-aaaabbbbccccdddd' });
    const res = await bookTestVisit(r.ctx, CREDS, REQ); assert.equal(res.status, 'booked_verified'); assert.deepEqual((await chainOf(r)).map((c) => c.state), ['pending', 'client_created', 'pending', 'created']);
  } finally { await r.done(); }
});

// ---- migration: the older single-file ledger is read only, and a key's own chain always wins over it
test('migration: a legacy "created" entry is verified again with no write, no generation file and the legacy file unchanged', async () => {
  const r = await rig();
  try {
    const first = await bookTestVisit(r.ctx, CREDS, REQ); const legacy = await toLegacy(r); assert.equal(legacy.state, 'created'); const bytes = ledgerFileBytes(r); const sent = mutations(r.mock).length;
    r.mock.opts.searchBlind = true;   // the ledger alone must prevent the repeat
    const again = await bookTestVisit(r.ctx, CREDS, REQ);
    assert.deepEqual([again.status, again.duplicate, again.writes, again.jobId], ['booked_verified', true, 0, first.jobId]); assert.equal(mutations(r.mock).length, sent); assert.deepEqual(ledgerFileBytes(r), bytes, 'legacy untouched, no new file');
  } finally { await r.done(); }
});

test('migration: a legacy "pending" entry blocks the key (PENDING_UNRESOLVED, 0 writes) and is not rewritten; with the job visible in Jobber it is adopted, the chain starts at generation 1 with the ids kept, and the legacy file is still unchanged', async () => {
  const r = await rig();
  try {
    await seedLegacy(r, { [markerFor(REQ.key)]: { state: 'pending' } }); const bytes = ledgerFileBytes(r);
    blockedClean(await bookTestVisit(r.ctx, CREDS, REQ), 'PENDING_UNRESOLVED'); assert.deepEqual(mutations(r.mock), []); assert.deepEqual(ledgerFileBytes(r), bytes);
  } finally { await r.done(); }
  const r2 = await rig();
  try {
    r2.mock.opts.crashAfterJobCreate = true; assert.equal((await bookTestVisit(r2.ctx, CREDS, REQ)).status, 'uncertain'); r2.mock.opts.crashAfterJobCreate = false;
    const legacy = await toLegacy(r2); assert.equal(legacy.state, 'pending'); assert.ok(legacy.clientId !== undefined); const legacyBytes = readFileSync(legacyPath(r2), 'utf8'); const sent = mutations(r2.mock).length;
    const adopted = await bookTestVisit(r2.ctx, CREDS, REQ); assert.deepEqual([adopted.status, adopted.duplicate, adopted.writes], ['booked_verified', true, 0]); assert.equal(mutations(r2.mock).length, sent);
    const chain = await chainOf(r2); assert.deepEqual(chain.map((c) => [c.gen, c.state]), [[1, 'created']]); assert.equal(chain[0].clientId, legacy.clientId, 'the ids from the legacy entry were kept'); assert.equal(chain[0].jobId, adopted.jobId);
    assert.equal(readFileSync(legacyPath(r2), 'utf8'), legacyBytes, 'the legacy file is unchanged');
  } finally { await r2.done(); }
});

test('migration: a legacy "client_created" entry reuses its client (one job write only), the chain starts at generation 1 with the ids kept, and the legacy file is unchanged', async () => {
  const r = await rig();
  try {
    r.mock.opts.jobUserErrors = true; assert.equal((await bookTestVisit(r.ctx, CREDS, REQ)).reason, 'JOBBER_REFUSED'); r.mock.opts.jobUserErrors = false;
    const legacy = await toLegacy(r); assert.equal(legacy.state, 'client_created'); const legacyBytes = readFileSync(legacyPath(r), 'utf8');
    const res = await bookTestVisit(r.ctx, CREDS, REQ); assert.deepEqual([res.status, res.writes], ['booked_verified', 1]); assert.equal(r.mock.clients, 1, 'no second client');
    const chain = await chainOf(r); assert.deepEqual(chain.map((c) => [c.gen, c.state]), [[1, 'pending'], [2, 'created']]); assert.equal(chain[0].clientId, legacy.clientId); assert.equal(chain[1].jobId, res.jobId);
    assert.equal(readFileSync(legacyPath(r), 'utf8'), legacyBytes);
  } finally { await r.done(); }
});

test('migration precedence: once a key has its own chain, the legacy file is never consulted for it - not even a legacy "pending" or an unreadable legacy file', async () => {
  const r = await rig();
  try {
    const first = await bookTestVisit(r.ctx, CREDS, REQ); const sent = mutations(r.mock).length;
    await seedLegacy(r, { [markerFor(REQ.key)]: { state: 'pending' } });
    const a = await bookTestVisit(r.ctx, CREDS, REQ); assert.deepEqual([a.status, a.duplicate, a.writes, a.jobId], ['booked_verified', true, 0, first.jobId]);
    writeFileSync(legacyPath(r), 'garbage'); const b = await bookTestVisit(r.ctx, CREDS, REQ); assert.deepEqual([b.status, b.duplicate, b.writes], ['booked_verified', true, 0]); assert.equal(mutations(r.mock).length, sent);
  } finally { await r.done(); }
});

const BAD_LEGACY: Array<[string, (r: Rig) => Promise<void>]> = [
  ['garbage', async (r) => { writeFileSync(legacyPath(r), 'zzzz'); }],
  ['an empty file', async (r) => { writeFileSync(legacyPath(r), ''); }],
  ['not JSON', async (r) => { writeFileSync(legacyPath(r), await fakeProtector.protect('not json')); }],
  ['a JSON list', async (r) => { writeFileSync(legacyPath(r), await fakeProtector.protect('[]')); }],
  ['no entries', async (r) => { writeFileSync(legacyPath(r), await fakeProtector.protect(JSON.stringify({ version: 1 }))); }],
  ['entries that are a list', async (r) => { await seedLegacy(r, []); }],
  ['another file version', async (r) => { await seedLegacy(r, {}, 2); }],
  ['this key\'s entry: "created" with no job id', async (r) => { await seedLegacy(r, { [markerFor(REQ.key)]: { state: 'created' } }); }],
  ['this key\'s entry: the "none" state (never written by the older code)', async (r) => { await seedLegacy(r, { [markerFor(REQ.key)]: { state: 'none' } }); }],
  ['this key\'s entry: an unknown state', async (r) => { await seedLegacy(r, { [markerFor(REQ.key)]: { state: 'finished', jobId: 'JOB-12345' } }); }],
  ['this key\'s entry: an extra field', async (r) => { await seedLegacy(r, { [markerFor(REQ.key)]: { state: 'pending', x: 1 } }); }],
  ['this key\'s entry: not an object', async (r) => { await seedLegacy(r, { [markerFor(REQ.key)]: 'pending' }); }],
];
test('migration, malformed legacy file (' + BAD_LEGACY.length + ' kinds): a key with no chain fails closed - uncertain, LEDGER_UNREADABLE, 0 writes, nothing sent - and the legacy file is left byte-for-byte as it was; entries of OTHER keys never matter', async () => {
  for (const [name, make] of BAD_LEGACY) {
    const r = await rig();
    try {
      await make(r); const before = ledgerFileBytes(r);
      const res = await bookTestVisit(r.ctx, CREDS, REQ); try { blockedClean(res, 'LEDGER_UNREADABLE'); } catch (e) { throw new Error(name + ': ' + (e as Error).message); }
      assert.deepEqual(mutations(r.mock), [], name); assert.deepEqual(ledgerFileBytes(r), before, name + ': untouched');
    } finally { await r.done(); }
  }
  const r = await rig();
  try {
    await seedLegacy(r, { 'DREWTEST-AAAAAAAAAAAA': { state: 'created', jobId: 'JOB-OTHER' }, 'DREWTEST-BBBBBBBBBBBB': { state: 'bogus' } }); const bytes = readFileSync(legacyPath(r), 'utf8');
    assert.equal((await bookTestVisit(r.ctx, CREDS, REQ)).status, 'booked_verified', 'a legacy file that does not mention this key does not block it'); assert.equal(readFileSync(legacyPath(r), 'utf8'), bytes);
  } finally { await r.done(); }
});

test('ledger source: the booking publishes only through publishBlob with the lock guard, never writes or removes any ledger file itself, never touches the older single file, and has its own reasons and the 99 cap', () => {
  const src = readFileSync(new URL('../src/jobber-booking.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal([...src.matchAll(/publishBlob\(/g)].length, 1, 'one publish, inside save()'); assert.ok(/await ctx\.vault\.publishBlob\(`\$\{base\}\.\$\{next\}`, text, \(\) => lock\.assertHeld\(\)\) === 'exists'\) throw new JobberError\('LEDGER_CONFLICT'\)/.test(src));
  assert.ok(!/saveBlob\(|saveLedger|loadLedger|rmSync|unlinkSync|renameSync|writeFileSync|from 'node:fs'/.test(src), 'no other way to write, replace or remove a ledger file');
  assert.equal([...src.matchAll(/LEGACY_LEDGER/g)].length, 4, 'the older file name appears only in its definition, the chain file prefix, its existence check and its read'); assert.ok(/hasBlob\(LEGACY_LEDGER\)/.test(src) && /loadBlob\(LEGACY_LEDGER\)/.test(src));
  assert.ok(/const MAX_GENERATION = 99;/.test(src) && /generation >= MAX_GENERATION\) throw new JobberError\('LEDGER_UNAVAILABLE'\)/.test(src));
  assert.ok(/code === 'LOCK_LOST' \|\| code === 'LEDGER_UNREADABLE' \|\| code === 'LEDGER_CONFLICT' \|\| code === 'LEDGER_UNAVAILABLE' \? code : 'API_ERROR'/.test(src), 'each has its own reason');
  assert.ok(/const unsure = reason === 'LEDGER_UNREADABLE' \|\| reason === 'LEDGER_CONFLICT';/.test(src) && /done\(writes > 0 \|\| unsure \? 'uncertain' : 'not_booked'/.test(src), 'an untrustworthy ledger is uncertain, not "not booked"');
  assert.ok(/if \(gens\.length === 0\) return \{ gen: 0, entry: await legacyEntry\(ctx, marker\) \};/.test(src), 'the older file is read only when the key has no chain');
  assert.ok(/top > MAX_GENERATION \|\| gens\.length !== top \|\| gens\[0\] !== 1/.test(src), 'the numbers must run 1..n');
});
test('an undecodable file (the protector itself refuses it, as Windows does for another user\'s or a damaged blob) fails closed for the highest generation and for the older file, and is left as it was', async () => {
  const strict: Protector = { protect: fakeProtector.protect, unprotect: async (b) => { if (!b.startsWith('P1:')) throw new JobberError('BAD_CONFIG'); return fakeProtector.unprotect(b); } };
  for (const where of ['generation', 'legacy']) {
    const r = await rig();
    try {
      const ctx: Ctx = { ...r.ctx, vault: createVault(r.dir, strict) };
      writeFileSync(where === 'generation' ? genPath(r, 1) : legacyPath(r), 'zzzz'); const before = ledgerFileBytes(r);
      blockedClean(await bookTestVisit(ctx, CREDS, REQ), 'LEDGER_UNREADABLE'); assert.deepEqual(mutations(r.mock), [], where); assert.deepEqual(ledgerFileBytes(r), before, where);
    } finally { await r.done(); }
  }
});

// ================================================================ Step 3a, slice A: bookings by IDENTITY (global lock, keyring fence, retired-key checks). Offline only; the live handler does not use this path.
const SECRETS = [1, 2, 3, 4].map((n) => Buffer.alloc(32, n).toString('base64url'));   // made-up secrets of the test, nothing real
const STAMPED = '2026-11-01T00:00:00.000Z';
/** Generation n of the keyring: current k<n>, retired k<n-1> ... k1 (each following the one before, as a real rotation writes it). */
const keyringGen = (n: number): string => { const retired = []; for (let i = n - 1; i >= 1; i--) retired.push({ kid: `k${i}`, secret: SECRETS[i - 1], retired_at: STAMPED }); return JSON.stringify({ version: 1, gen: n, current: { kid: `k${n}`, secret: SECRETS[n - 1] }, retired }); };
const keyringFile = (r: Rig, n: number): string => join(r.dir, `booking-identity-keys.${n}.enc`);
const seedKeyring = async (r: Rig, upTo: number, from = 1): Promise<void> => { for (let n = from; n <= upTo; n++) writeFileSync(keyringFile(r, n), await fakeProtector.protect(keyringGen(n))); };
const IPARTS: IdentityParts = { phone: '(555) 010-4242', date: '2026-11-10', startTime: '09:00', street: '123 Invented Lane', zip: '90210' };
const { key: _noKey, ...REQ_WITHOUT_KEY } = REQ;
const IREQ: IdentityBookingRequest = { ...REQ_WITHOUT_KEY, identity: IPARTS };
const idKey = (n: number, parts: IdentityParts = IPARTS): string => bookingIdentity(SECRETS[n - 1], parts);
const idMarker = (n: number): string => markerFor(idKey(n));
const withKey = (n: number): BookingRequest => ({ ...REQ, key: idKey(n) });
const spyLocks = (r: Rig): string[] => { const names: string[] = []; const v = r.ctx.vault as unknown as { withLock: (name: string, fn: unknown, wait?: number) => unknown }; const real = v.withLock.bind(v); v.withLock = (name, fn, wait) => { names.push(name); return real(name, fn, wait); }; return names; };
const lockFiles = (r: Rig): string[] => readdirSync(r.dir).filter((f) => f.endsWith('.lock'));
const ledgerFiles = (r: Rig): string[] => readdirSync(r.dir).filter((f) => f.startsWith('jobber-booking-ledger'));
const jobList = (r: Rig): Array<Record<string, unknown>> => [...r.mock.jobs.values()];
const searches = (r: Rig): number => r.mock.ops.filter((o) => o.field === 'jobs').length;

test('IDENTITY booking: the global lock is taken first, then the key lock; both are held while Jobber is asked; the job carries the marker of the CURRENT key; nothing is left locked; no secret or personal detail reaches a log or result', async () => {
  const r = await rig();
  try {
    await seedKeyring(r, 1); const names = spyLocks(r); const held: string[][] = [];
    const real = r.ctx.fetch; r.ctx.fetch = (async (url: string, init: FetchInit) => { if (/FindTestJobs/.test(String(init.body ?? ''))) held.push(lockFiles(r)); return real(url, init); }) as unknown as FetchLike;
    const res = await bookTestVisit(r.ctx, CREDS, IREQ);
    assert.deepEqual([res.status, res.writes, res.duplicate], ['booked_verified', 2, undefined]);
    assert.deepEqual(names, ['booking-identity', 'booking-' + idMarker(1).toLowerCase()], 'the global lock first, then the key lock');
    assert.deepEqual(held[0]?.sort(), ['booking-' + idMarker(1).toLowerCase() + '.lock', 'booking-identity.lock'].sort(), 'both locks are held while Jobber is searched');
    assert.deepEqual(lockFiles(r), [], 'both released');
    const job = jobList(r)[0]; assert.ok(String(job.title).endsWith(`[${idMarker(1)}]`) && String(job.instructions).includes(idMarker(1)));
    assert.match(idKey(1), /^fast2-[0-9a-f]{24}$/); assert.deepEqual(Object.keys((await ledgerOf(r, withKey(1)))), [idMarker(1)]);
    const all = JSON.stringify([r.logs, res]); for (const s of [...SECRETS, 'Testa', 'Invented', '90210', '5550104242']) assert.ok(!all.includes(s), 'not in a log or result');
  } finally { await r.done(); }
});

test('IDENTITY booking: the same booking again - from another call, with the phone written another way - is a verified duplicate with no write; a different slot is a different booking', async () => {
  const r = await rig();
  try {
    await seedKeyring(r, 1);
    const first = await bookTestVisit(r.ctx, CREDS, IREQ); assert.equal(first.status, 'booked_verified');
    const again = await bookTestVisit(r.ctx, CREDS, { ...IREQ, client: { ...IREQ.client, phone: '+1 555 010 4242' }, identity: { ...IPARTS, phone: '5550104242' } });
    assert.deepEqual([again.status, again.duplicate, again.writes, again.jobId], ['booked_verified', true, 0, first.jobId]); assert.deepEqual(mutations(r.mock), ['clientCreate', 'jobCreate']);
    const other = await bookTestVisit(r.ctx, CREDS, { ...IREQ, when: { ...IREQ.when, startTime: '13:00', endTime: '15:00' }, identity: { ...IPARTS, startTime: '13:00' } });
    assert.deepEqual([other.status, other.duplicate], ['booked_verified', undefined]); assert.equal(r.mock.jobs.size, 2);
  } finally { await r.done(); }
});

test('IDENTITY booking: two identical bookings at once make ONE job (the global lock serializes them); two different ones both book', async () => {
  const r = await rig();
  try {
    await seedKeyring(r, 1);
    const [a, b] = await Promise.all([bookTestVisit(r.ctx, CREDS, IREQ), bookTestVisit(r.ctx, CREDS, IREQ)]);
    assert.deepEqual([a.status, b.status], ['booked_verified', 'booked_verified']); assert.equal([a, b].filter((x) => x.duplicate === true).length, 1); assert.equal(r.mock.jobs.size, 1); assert.deepEqual(mutations(r.mock), ['clientCreate', 'jobCreate']);
    const second = { ...IREQ, when: { ...IREQ.when, date: '2026-11-11' }, identity: { ...IPARTS, date: '2026-11-11' } };
    const [c, d] = await Promise.all([bookTestVisit(r.ctx, CREDS, second), bookTestVisit(r.ctx, CREDS, { ...second, when: { ...second.when, date: '2026-11-12' }, identity: { ...IPARTS, date: '2026-11-12' } })]);
    assert.deepEqual([c.status, d.status], ['booked_verified', 'booked_verified']); assert.equal(r.mock.jobs.size, 3); assert.deepEqual(lockFiles(r), []);
  } finally { await r.done(); }
});

test('IDENTITY booking while a rotation holds the global lock: the booking waits, then reads the NEW keyring and books under the new key; and while a booking runs, a rotation cannot take the lock', async () => {
  const r = await rig();
  try {
    await seedKeyring(r, 1); const gen2 = await fakeProtector.protect(keyringGen(2)); let entered!: () => void; const inside = new Promise<void>((ok) => { entered = ok; });
    const rotation = r.ctx.vault.withLock('booking-identity', async () => { entered(); await new Promise((ok) => setTimeout(ok, 400)); writeFileSync(keyringFile(r, 2), gen2); });
    await inside; const res = await bookTestVisit(r.ctx, CREDS, IREQ); await rotation;
    assert.equal(res.status, 'booked_verified'); assert.ok(String(jobList(r)[0].title).includes(idMarker(2)) && !String(jobList(r)[0].title).includes(idMarker(1)), 'booked under generation 2, the key the rotation published');
  } finally { await r.done(); }
  const r2 = await rig();
  try {
    await seedKeyring(r2, 1); let probe = 'not tried'; const real = r2.ctx.fetch;
    r2.ctx.fetch = (async (url: string, init: FetchInit) => { if (probe === 'not tried' && /FindTestJobs/.test(String(init.body ?? ''))) { probe = 'trying'; try { await r2.ctx.vault.withLock('booking-identity', async () => undefined, 150); probe = 'acquired'; } catch (e) { probe = (e as { code?: string }).code ?? 'error'; } } return real(url, init); }) as unknown as FetchLike;
    const res = await bookTestVisit(r2.ctx, CREDS, IREQ); assert.equal(res.status, 'booked_verified'); assert.equal(probe, 'TIMEOUT', 'a rotation cannot enter while the booking holds the global lock');
  } finally { await r2.done(); }
});

test('IDENTITY unavailable (no keyring, a gap, a malformed or out-of-order generation, an undecodable file): not_booked with IDENTITY_UNAVAILABLE, nothing sent to Jobber except the account check, no ledger file, no lock left, and NEVER a fall-back to the Call-SID key', async () => {
  const cases: Array<[string, string, (r: Rig) => Promise<void>]> = [
    ['MISSING', 'MISSING', async () => undefined],
    ['GAP', 'GAP', async (r) => seedKeyring(r, 2, 2)],
    ['MALFORMED', 'MALFORMED', async (r) => { await seedKeyring(r, 1); writeFileSync(keyringFile(r, 2), await fakeProtector.protect('not json')); }],
    ['SUCCESSION', 'SUCCESSION', async (r) => { await seedKeyring(r, 1); writeFileSync(keyringFile(r, 2), await fakeProtector.protect(JSON.stringify({ version: 1, gen: 2, current: { kid: 'k2', secret: SECRETS[2] }, retired: [] }))); }],
    ['MALFORMED (text)', 'MALFORMED', async (r) => { writeFileSync(keyringFile(r, 1), 'undecodable garbage'); }],
    ['UNREADABLE', 'UNREADABLE', async (r) => { await seedKeyring(r, 1); const v = r.ctx.vault; const real = v.loadBlob.bind(v); v.loadBlob = async (n: string) => (n.startsWith('booking-identity-keys') ? undefined : real(n)); }],
  ];
  for (const [label, problem, setup] of cases) {
    const r = await rig();
    try {
      await setup(r); const names = spyLocks(r); const res = await bookTestVisit(r.ctx, CREDS, IREQ);
      assert.deepEqual([res.status, res.reason, res.writes], ['not_booked', 'IDENTITY_UNAVAILABLE', 0], label); assert.deepEqual(mutations(r.mock), [], label); assert.equal(searches(r), 0, label + ': Jobber was not even searched'); assert.equal(r.mock.jobs.size, 0);
      assert.deepEqual(ledgerFiles(r), [], label + ': no ledger file for any key'); assert.deepEqual(lockFiles(r), [], label); assert.deepEqual(names, ['booking-identity'], label + ': only the global lock was taken');
      assert.ok(r.logs.some(([c, d]) => c === 'JOBBER_IDENTITY_FAILED' && (d as { problem?: string }).problem === problem), label + ': the fixed reason is logged');
    } finally { await r.done(); }
  }
});

test('IDENTITY request checks: an identity request has no key of its own (one that is given is refused), the identity must be the request\'s own phone, date, start time, house number and ZIP, and writes off still refuses before any lock or keyring read', async () => {
  const now = NOW;
  assert.deepEqual(requestProblems(IREQ, now), []); assert.deepEqual(requestProblems(REQ, now), []);
  assert.deepEqual(requestProblems({ ...IREQ, key: 'call-0123456789abcdef' }, now), ['key'], 'both a key and an identity');
  for (const [label, parts] of [['phone', { ...IPARTS, phone: '5550109999' }], ['date', { ...IPARTS, date: '2026-11-11' }], ['start', { ...IPARTS, startTime: '10:00' }], ['house', { ...IPARTS, street: '124 Invented Lane' }], ['zip', { ...IPARTS, zip: '90211' }], ['bad parts', { ...IPARTS, zip: 'abc' }]] as Array<[string, IdentityParts]>) assert.deepEqual(requestProblems({ ...IREQ, identity: parts }, now), ['identity'], label);
  assert.deepEqual(requestProblems({ ...IREQ, identity: { ...IPARTS, street: '123 Another Road' } }, now), [], 'the street NAME is not part of the identity (the read-back compares it)');
  const r = await rig(false);
  try { await seedKeyring(r, 1); const names = spyLocks(r); const res = await bookTestVisit(r.ctx, CREDS, IREQ); assert.deepEqual([res.status, res.reason, res.writes], ['refused', 'WRITES_OFF', 0]); assert.deepEqual(names, []); assert.deepEqual(r.mock.ops, []); } finally { await r.done(); }
  const r2 = await rig();
  try { await seedKeyring(r2, 1); const names = spyLocks(r2); const res = await bookTestVisit(r2.ctx, CREDS, { ...IREQ, identity: { ...IPARTS, zip: '90211' } }); assert.deepEqual([res.status, res.reason], ['refused', 'INVALID_REQUEST']); assert.deepEqual(names, []); assert.deepEqual(r2.mock.ops, []); } finally { await r2.done(); }
});

test('the LEGACY key path is unchanged by a keyring: a request with a key takes only its own key lock, never reads the keyring, and books under its own marker', async () => {
  const r = await rig();
  try {
    await seedKeyring(r, 3); const names = spyLocks(r); const reads: string[] = []; const v = r.ctx.vault; const realLoad = v.loadBlob.bind(v); v.loadBlob = async (n: string) => { reads.push(n); return realLoad(n); };
    const res = await bookTestVisit(r.ctx, CREDS, REQ);
    assert.deepEqual([res.status, res.writes], ['booked_verified', 2]); assert.deepEqual(names, ['booking-' + markerFor(REQ.key).toLowerCase()]); assert.ok(!reads.some((n) => n.startsWith('booking-identity-keys')), 'the keyring was not read'); assert.ok(String(jobList(r)[0].title).includes(markerFor(REQ.key)));
  } finally { await r.done(); }
});

test('FENCE: the keyring changes after it was read but before the first write - nothing is written (IDENTITY_STALE, not_booked); after the client was created - the job is NOT created (uncertain, 1 write), and the retry under the new key is stopped by the old key\'s unresolved ledger', async () => {
  const r = await rig();
  try {
    await seedKeyring(r, 1); const gen2 = await fakeProtector.protect(keyringGen(2)); afterResponse(r, /FindTestJobs/, () => writeFileSync(keyringFile(r, 2), gen2));
    const res = await bookTestVisit(r.ctx, CREDS, IREQ);
    assert.deepEqual([res.status, res.reason, res.writes], ['not_booked', 'IDENTITY_STALE', 0]); assert.deepEqual(mutations(r.mock), []); assert.deepEqual(ledgerFiles(r), []); assert.deepEqual(lockFiles(r), []);
  } finally { await r.done(); }
  const r2 = await rig();
  try {
    await seedKeyring(r2, 1); const gen2 = await fakeProtector.protect(keyringGen(2)); const real = r2.ctx.fetch; afterResponse(r2, /clientCreate/, () => writeFileSync(keyringFile(r2, 2), gen2));
    const res = await bookTestVisit(r2.ctx, CREDS, IREQ);
    assert.deepEqual([res.status, res.reason, res.writes], ['uncertain', 'IDENTITY_STALE', 1]); assert.deepEqual(mutations(r2.mock), ['clientCreate'], 'the job was never sent'); assert.equal(r2.mock.jobs.size, 0); assert.equal((await ledgerOf(r2, withKey(1)))[idMarker(1)].state, 'pending');
    r2.ctx.fetch = real; const retry = await bookTestVisit(r2.ctx, CREDS, IREQ);
    assert.deepEqual([retry.status, retry.reason, retry.writes], ['uncertain', 'PENDING_UNRESOLVED', 0], 'the old key started this booking and cannot say how it ended'); assert.deepEqual(mutations(r2.mock), ['clientCreate'], 'nothing more was sent');
  } finally { await r2.done(); }
});

test('FENCE after the retired-key check: a rotation that lands while the old key is being checked turns even a matching duplicate into IDENTITY_STALE (nothing written, nothing claimed from a keyring that is no longer current)', async () => {
  const r = await rig();
  try {
    await bookedThenRotated(r); const gen3 = await fakeProtector.protect(keyringGen(3)); afterResponse(r, /FindTestJobs/, () => writeFileSync(keyringFile(r, 3), gen3));
    const res = await bookTestVisit(r.ctx, CREDS, IREQ);
    assert.deepEqual([res.status, res.reason, res.writes, res.duplicate], ['not_booked', 'IDENTITY_STALE', 0, undefined]); assert.deepEqual(mutations(r.mock), ['clientCreate', 'jobCreate']);
    r.ctx.fetch = globalThis.fetch as unknown as FetchLike; const next = await bookTestVisit(r.ctx, CREDS, IREQ); assert.deepEqual([next.status, next.duplicate, next.writes], ['booked_verified', true, 0], 'the next call reads the new keyring and still finds the booking under the oldest key');
  } finally { await r.done(); }
});

test('GLOBAL LOCK lost: before any write - nothing is sent (not_booked, LOCK_LOST); after the client - the job is not created (uncertain, 1 write); the lock of whoever took over is left alone', async () => {
  const r = await rig();
  try {
    await seedKeyring(r, 1); afterResponse(r, /FindTestJobs/, () => writeFileSync(join(r.dir, 'booking-identity.lock'), 'another-holder'));
    const res = await bookTestVisit(r.ctx, CREDS, IREQ);
    assert.deepEqual([res.status, res.reason, res.writes], ['not_booked', 'LOCK_LOST', 0]); assert.deepEqual(mutations(r.mock), []); assert.equal(readFileSync(join(r.dir, 'booking-identity.lock'), 'utf8'), 'another-holder');
  } finally { await r.done(); }
  const r2 = await rig();
  try {
    await seedKeyring(r2, 1); afterResponse(r2, /clientCreate/, () => rmSync(join(r2.dir, 'booking-identity.lock'), { force: true }));
    const res = await bookTestVisit(r2.ctx, CREDS, IREQ);
    assert.deepEqual([res.status, res.reason, res.writes], ['uncertain', 'LOCK_LOST', 1]); assert.deepEqual(mutations(r2.mock), ['clientCreate']); assert.equal(r2.mock.jobs.size, 0);
  } finally { await r2.done(); }
});

/** A booking made under generation 1, then the keyring rotated to `upTo` (the old key is now retired). */
async function bookedThenRotated(r: Rig, upTo = 2): Promise<{ first: Awaited<ReturnType<typeof bookTestVisit>> }> { await seedKeyring(r, 1); const first = await bookTestVisit(r.ctx, CREDS, IREQ); assert.equal(first.status, 'booked_verified'); await seedKeyring(r, upTo, 2); return { first }; }

test('RETIRED KEY: after a rotation the same booking is found under the old key (ledger and Jobber) and is a verified duplicate - same job, no write, nothing filed under the new key, the old key\'s ledger untouched', async () => {
  const r = await rig();
  try {
    const { first } = await bookedThenRotated(r); const before = ledgerFiles(r).map((f) => [f, readFileSync(join(r.dir, f), 'utf8')]);
    const res = await bookTestVisit(r.ctx, CREDS, IREQ);
    assert.deepEqual([res.status, res.duplicate, res.writes, res.jobId], ['booked_verified', true, 0, first.jobId]); assert.deepEqual(mutations(r.mock), ['clientCreate', 'jobCreate']); assert.equal(r.mock.jobs.size, 1);
    assert.deepEqual(ledgerFiles(r).map((f) => [f, readFileSync(join(r.dir, f), 'utf8')]), before, 'no ledger file written or changed'); assert.deepEqual(Object.keys(await ledgerOf(r, withKey(2))), [], 'nothing under the new key');
    assert.ok(r.logs.some(([c, d]) => c === 'JOBBER_IDENTITY_ALIAS_HIT' && (d as { kid?: string }).kid === 'k1'), 'the retired key id is logged, never a secret'); assert.ok(!JSON.stringify(r.logs).includes(SECRETS[0]));
    const alsoBlind = (r.mock.opts.searchBlind = true, await bookTestVisit(r.ctx, CREDS, IREQ)); assert.deepEqual([alsoBlind.status, alsoBlind.duplicate, alsoBlind.writes], ['booked_verified', true, 0], 'the ledger alone is enough when Jobber\'s search cannot see the job');
    r.mock.opts.searchBlind = false; for (const f of ledgerFiles(r)) rmSync(join(r.dir, f)); const lost = await bookTestVisit(r.ctx, CREDS, IREQ); assert.deepEqual([lost.status, lost.duplicate, lost.writes, lost.jobId], ['booked_verified', true, 0, first.jobId], 'Jobber alone is enough when the ledger is lost');
  } finally { await r.done(); }
});

test('RETIRED KEY with two rotations: the booking made under the oldest key is still found (the newest generation lists both retired keys)', async () => {
  const r = await rig();
  try { const { first } = await bookedThenRotated(r, 3); const res = await bookTestVisit(r.ctx, CREDS, IREQ); assert.deepEqual([res.status, res.duplicate, res.writes, res.jobId], ['booked_verified', true, 0, first.jobId]); assert.equal(r.mock.jobs.size, 1); } finally { await r.done(); }
});

test('RETIRED KEY, details differ: a job under the old key is NOT a verified duplicate unless every field matches - another price, street, name, time or phone is uncertain (READBACK_MISMATCH, field names only), nothing is written, nothing is booked', async () => {
  const variants: Array<[string, Partial<BookingRequest>, string[], Partial<IdentityParts>]> = [
    ['price', { priceDollars: 250 }, ['price'], {}], ['street name', { address: { ...REQ.address, street1: '123 Other Road' } }, ['address'], { street: '123 Other Road' }],
    ['client name', { client: { ...REQ.client, lastName: 'Different' } }, ['client_name'], {}], ['end time', { when: { ...REQ.when, endTime: '12:00' } }, ['visit_time'], {}], ['title', { title: 'Deep cleaning' }, ['title'], {}],
  ];
  for (const [label, change, fields, parts] of variants) {
    const r = await rig();
    try {
      await bookedThenRotated(r); const res = await bookTestVisit(r.ctx, CREDS, { ...IREQ, ...change, identity: { ...IPARTS, ...parts } } as IdentityBookingRequest);
      assert.deepEqual([res.status, res.reason, res.writes], ['uncertain', 'READBACK_MISMATCH', 0], label); assert.deepEqual([...(res.mismatches ?? [])].sort(), fields.sort(), label); assert.notEqual(res.status, 'booked_verified'); assert.deepEqual(mutations(r.mock), ['clientCreate', 'jobCreate'], label); assert.equal(r.mock.jobs.size, 1, label);
    } finally { await r.done(); }
  }
  const r = await rig();
  try {
    await bookedThenRotated(r); r.mock.opts.shiftVisitMs = 0; const job = jobList(r)[0]; job.jobStatus = 'ARCHIVED';
    const res = await bookTestVisit(r.ctx, CREDS, IREQ); assert.deepEqual([res.status, res.reason, res.mismatches, res.writes], ['uncertain', 'READBACK_MISMATCH', ['job_status'], 0], 'an archived job is not a booking');
  } finally { await r.done(); }
});

test('RETIRED KEY, doubt: a job that cannot be read back (NOT_FOUND), two jobs under old keys, an old key\'s ledger left pending or client_created with no job, and an unreadable old ledger are each uncertain with nothing written', async () => {
  { const r = await rig(); try { await bookedThenRotated(r); r.mock.jobs.clear(); const res = await bookTestVisit(r.ctx, CREDS, IREQ); assert.deepEqual([res.status, res.reason, res.writes], ['uncertain', 'NOT_FOUND', 0], 'the ledger says created but Jobber has no such job'); assert.deepEqual(mutations(r.mock), ['clientCreate', 'jobCreate']); } finally { await r.done(); } }
  { const r = await rig(); try {
    await bookedThenRotated(r, 3); const a = jobList(r)[0]; const m1 = idMarker(1); const m2 = idMarker(2);
    r.mock.jobs.set('JOB-OTHER', { ...a, id: 'JOB-OTHER', title: String(a.title).replace(m1, m2), instructions: String(a.instructions).replace(m1, m2) });
    const res = await bookTestVisit(r.ctx, CREDS, IREQ); assert.deepEqual([res.status, res.reason, res.writes], ['uncertain', 'DUPLICATE_MARKERS', 0], 'jobs under two retired keys'); assert.deepEqual(mutations(r.mock), ['clientCreate', 'jobCreate']);
  } finally { await r.done(); } }
  for (const state of ['pending', 'client_created']) {
    const r = await rig();
    try {
      await seedKeyring(r, 2); await seedGen(r, 1, state === 'pending' ? { state: 'pending' } : { state: 'client_created', clientId: 'CLIENT-1', propertyId: 'PROP-1' }, {}, withKey(1));
      const res = await bookTestVisit(r.ctx, CREDS, IREQ); assert.deepEqual([res.status, res.reason, res.writes], ['uncertain', 'PENDING_UNRESOLVED', 0], state); assert.deepEqual(mutations(r.mock), [], state); assert.deepEqual(ledgerFiles(r), [ledgerName(withKey(1)) + '.1.enc'], state + ': only the seeded file');
    } finally { await r.done(); }
  }
  { const r = await rig(); try {
    await bookedThenRotated(r); const top = r.ctx.vault.generations(ledgerName(withKey(1))).at(-1) as number; const bad = genPath(r, top, withKey(1)); writeFileSync(bad, 'undecodable'); const res = await bookTestVisit(r.ctx, CREDS, IREQ);
    assert.deepEqual([res.status, res.reason, res.writes], ['uncertain', 'LEDGER_UNREADABLE', 0], 'an old ledger that cannot be read may hide a booking'); assert.equal(readFileSync(bad, 'utf8'), 'undecodable'); assert.deepEqual(mutations(r.mock), ['clientCreate', 'jobCreate']);
  } finally { await r.done(); } }
  { const r = await rig(); try {
    await seedKeyring(r, 2); await seedGen(r, 1, { state: 'pending' }, {}, withKey(1)); const job = { id: 'JOB-OLD', jobNumber: 1, title: 'Standard cleaning [' + idMarker(1) + ']', instructions: 'x ' + idMarker(1), jobStatus: 'UPCOMING', total: 199, client: { firstName: 'Testa', lastName: 'Invented', phones: [{ number: '5550104242' }] }, property: { address: { street1: '123 Invented Lane', city: 'Testville', postalCode: '90210', province: 'ca' } }, visits: { nodes: [{ startAt: '2026-11-10T15:00:00.000Z', endAt: '2026-11-10T17:00:00.000Z' }] } };
    r.mock.jobs.set('JOB-OLD', job); const res = await bookTestVisit(r.ctx, CREDS, IREQ); assert.deepEqual([res.status, res.duplicate, res.writes, res.jobId], ['booked_verified', true, 0, 'JOB-OLD'], 'a pending old ledger whose job IS in Jobber and matches in full');
  } finally { await r.done(); } }
});

test('IDENTITY source: global lock before key lock, one shared body for both paths, no environment, file, network or fall-back to the Call-SID key in the identity path, and the lock name is the one the rotation takes', async () => {
  const src = readFileSync(new URL('../src/jobber-booking.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(src.includes("const IDENTITY_LOCK = 'booking-identity';")); const setup = await import('../src/booking-identity-setup.ts'); assert.equal(setup.IDENTITY_LOCK, 'booking-identity');
  const identityPath = src.slice(src.indexOf('const byIdentity ='), src.indexOf('  try {\n    const tokens'));
  assert.ok(identityPath.indexOf('withLock(IDENTITY_LOCK') >= 0 && identityPath.indexOf('withLock(IDENTITY_LOCK') < identityPath.indexOf('withLock(`booking-${marker.toLowerCase()}`'), 'global first');
  assert.equal([...src.matchAll(/\blocked\(req, marker, /g)].length, 2, 'both paths run the same body'); assert.ok(/locked\(req, marker, both, aliasCheck\)/.test(src) && /locked\(req, marker, lock\)\)/.test(src));
  assert.ok(/outer\.assertHeld\(\); inner\.assertHeld\(\); unchanged\(\);/.test(identityPath), 'one handle checks both locks and the keyring at every write');
  assert.ok(!/drew-fast|createHash|callSid|CallSid/.test(identityPath), 'no Call-SID key in the identity path'); assert.ok(!/process\.env|writeFile|rmSync|saveBlob|publishBlob\(/.test(identityPath), 'the identity path writes nothing itself');
  assert.equal([...src.matchAll(/\bmutate\(/g)].length, 1, 'still one call to mutate'); assert.equal([...src.matchAll(/publishBlob\(/g)].length, 1, 'still one publish');
  assert.deepEqual([...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]), ['node:crypto', './jobber-connector.ts', './jobber-connector.ts', './booking-identity.ts', './booking-identity.ts', './us-state.ts']);
});

test('the ledger scan agrees with what the booking module really leaves behind: a finished booking is "none"; a booking stopped after the client was created (the lock lost) leaves one unresolved key, and the scan says so; a retry that is stopped as unresolved changes nothing', async () => {
  const r = await rig();
  try {
    assert.equal((await scanLedger(r.ctx.vault)).verdict, 'none', 'nothing booked yet');
    assert.equal((await bookTestVisit(r.ctx, CREDS, REQ)).status, 'booked_verified');
    assert.deepEqual(await scanLedger(r.ctx.vault), { chains: 1, created: 1, cleared: 0, pending: 0, clientCreated: 0, unreadable: 0, legacy: 'absent', verdict: 'none' });
    const other = { ...REQ, key: 'call-fedcba9876543210' };
    const real = r.ctx.fetch; afterResponse(r, /clientCreate/, () => rmSync(lockOf(r, other), { force: true }));
    const stopped = await bookTestVisit(r.ctx, CREDS, other); assert.deepEqual([stopped.status, stopped.reason], ['uncertain', 'LOCK_LOST']);
    const s = await scanLedger(r.ctx.vault); assert.deepEqual([s.verdict, s.pending, s.created, s.chains], ['some', 1, 1, 2], 'the half-finished booking is unresolved');
    r.ctx.fetch = real; assert.equal((await bookTestVisit(r.ctx, CREDS, other)).reason, 'PENDING_UNRESOLVED'); assert.deepEqual(await scanLedger(r.ctx.vault), s, 'still unresolved, and unchanged');
  } finally { await r.done(); }
});
