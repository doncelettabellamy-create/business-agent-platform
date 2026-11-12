// The founder-run RESOLVE command (src/jobber-resolve.ts, src/jobber-resolve-main.ts): a read-only dry run and `--adopt --confirm` for exactly one verified matching Jobber job. There is no --clear.
// A local stand-in for Jobber on loopback, a temporary ledger per test (the test protector, reversible, NOT secure) and the REAL booking code to make the stuck entries: NOTHING here contacts Jobber, the real private folder or a provider. Every name and id is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVault, JobberError } from '../src/jobber-connector.ts';
import type { Credentials, Ctx, FetchLike, Protector } from '../src/jobber-connector.ts';
import { bookTestVisit, markerFor } from '../src/jobber-booking.ts';
import type { BookingRequest } from '../src/jobber-booking.ts';
import { ledgerUnresolved, pendingReport, scanLedger } from '../src/jobber-ledger-scan.ts';
import { IDENTITY_LOCK, keyLockOf, REF, resolveBooking, resolveLines, runResolve } from '../src/jobber-resolve.ts';
import { IDENTITY_LOCK as SETUP_IDENTITY_LOCK } from '../src/booking-identity-setup.ts';

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
const reqWith = (key: string): BookingRequest => ({ ...REQ, key });

interface Opts {
  account: { id: string; name: string }; searchBlind: boolean; jobUserErrors: boolean; clientUserErrors: boolean; clientAnswer?: () => unknown; jobAnswer?: () => unknown;
  findStatus?: number; findErrors?: boolean; findNull?: boolean; findMalformed?: boolean; extraNodes?: Array<{ id: string; title: string }>; readNull?: boolean; readPatch?: Record<string, unknown>;
}
interface Op { kind: 'query' | 'mutation'; field: string }
interface Mock { endpoints: { authorize: string; token: string; graphql: string }; ops: Op[]; opts: Opts; jobs: Map<string, Record<string, unknown>>; close(): Promise<void> }
async function mockJobber(): Promise<Mock> {
  const ops: Op[] = []; const jobs = new Map<string, Record<string, unknown>>(); let n = 0; let clients = 0;
  const opts: Opts = { account: ACCOUNT, searchBlind: false, jobUserErrors: false, clientUserErrors: false };
  const props = new Map<string, { client: Record<string, unknown>; address: Record<string, unknown> }>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
      const send = (s: number, o: unknown): void => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.method !== 'POST' || req.url !== '/api/graphql') return send(404, {});
      if (!/^Bearer tok-valid/.test(String(req.headers.authorization ?? ''))) return send(401, {});
      const b = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { query: string; variables?: Record<string, unknown> }; const v = b.variables ?? {};
      const data = (d: unknown) => send(200, { data: d, extensions: { versioning: { version: '2026-09-25' } } });
      if (/\baccount\b/.test(b.query) && !/mutation/.test(b.query)) { ops.push({ kind: 'query', field: 'account' }); return data({ account: opts.account }); }
      if (/clientCreate/.test(b.query)) {
        ops.push({ kind: 'mutation', field: 'clientCreate' });
        if (opts.clientUserErrors) return data({ clientCreate: { client: null, userErrors: [{ message: 'bad', path: ['x'] }] } });
        const input = (v.input ?? {}) as Record<string, unknown>; clients++; const pid = `PROP-${++n}`;
        props.set(pid, { client: { firstName: input.firstName, lastName: input.lastName, phones: ((input.phones ?? []) as Array<{ number: string }>).map((p) => ({ number: p.number })) }, address: (((input.properties ?? []) as Array<{ address: Record<string, unknown> }>)[0] ?? { address: {} }).address });
        if (opts.clientAnswer !== undefined) return data({ clientCreate: opts.clientAnswer() });
        return data({ clientCreate: { client: { id: `CLIENT-${clients}`, clientProperties: { nodes: [{ id: pid }] } }, userErrors: [] } });
      }
      if (/jobCreate/.test(b.query)) {
        ops.push({ kind: 'mutation', field: 'jobCreate' });
        if (opts.jobUserErrors) return data({ jobCreate: { job: null, userErrors: [{ message: 'bad', path: ['y'] }] } });
        const input = (v.input ?? {}) as { propertyId: string; title: string; instructions: string; timeframe: { startAt: string }; scheduling: { startTime: string; endTime: string }; lineItems: Array<{ unitPrice: number; quantity: number }> };
        const p = props.get(input.propertyId); const id = `JOB-${++n}`; const off = '-06:00';
        const s = Date.parse(`${input.timeframe.startAt}T${input.scheduling.startTime}${off}`); const e = Date.parse(`${input.timeframe.startAt}T${input.scheduling.endTime}${off}`);
        jobs.set(id, { id, jobNumber: 1000 + n, title: input.title, instructions: input.instructions, jobStatus: 'UPCOMING', total: input.lineItems.reduce((a, l) => a + l.unitPrice * l.quantity, 0), client: p?.client, property: { address: p?.address }, visits: { nodes: [{ startAt: new Date(s).toISOString(), endAt: new Date(e).toISOString() }] } });
        if (opts.jobAnswer !== undefined) return data({ jobCreate: opts.jobAnswer() });
        return data({ jobCreate: { job: { id, jobNumber: 1000 + n }, userErrors: [] } });
      }
      if (/ResolveFindJobs|FindTestJobs/.test(b.query)) {
        ops.push({ kind: 'query', field: 'jobs' });
        if (opts.findStatus !== undefined) return send(opts.findStatus, {});
        if (opts.findErrors) return send(200, { errors: [{ message: 'x', extensions: { code: 'INTERNAL' } }] });
        if (opts.findNull) return data({ jobs: null });
        if (opts.findMalformed) return data({ jobs: { nodes: [{ title: 'a title and no id' }] } });
        const found = opts.searchBlind ? [] : [...jobs.values()].filter((j) => String(j.title).includes(String(v.term))).map((j) => ({ id: j.id, title: j.title }));
        return data({ jobs: { nodes: [...found, ...(opts.extraNodes ?? [])] } });
      }
      if (/ResolveReadJob/.test(b.query)) {
        ops.push({ kind: 'query', field: 'job' }); const jb = jobs.get(String(v.id));
        if (opts.readNull || jb === undefined) return data({ job: null });
        return data({ job: { id: jb.id, title: jb.title, instructions: jb.instructions, jobStatus: jb.jobStatus, ...(opts.readPatch ?? {}) } });
      }
      if (/ReadBackJob/.test(b.query)) { ops.push({ kind: 'query', field: 'readback' }); return data({ job: jobs.get(String(v.id)) ?? null }); }
      return data({});
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { endpoints: { authorize: `${origin}/a`, token: `${origin}/t`, graphql: `${origin}/api/graphql` }, ops, opts, jobs, close: () => new Promise((ok) => { server.close(() => ok()); server.closeAllConnections(); }) };
}
interface Rig { mock: Mock; dir: string; vault: ReturnType<typeof createVault>; ctx: Ctx; writeCtx: Ctx; done(): Promise<void> }
async function rig(withTokens = true): Promise<Rig> {
  const mock = await mockJobber(); const dir = mkdtempSync(join(tmpdir(), 'jobber-resolve-')); const vault = createVault(dir, fakeProtector);
  if (withTokens) await vault.saveTokens({ access_token: 'tok-valid-0123456789', refresh_token: 'refresh-0123456789', expires_at: NOW + 3_000_000, account_id: ACCOUNT.id, account_name: ACCOUNT.name });
  const base = { vault, endpoints: mock.endpoints, fetch: globalThis.fetch as unknown as FetchLike, now: () => NOW, diag: () => undefined, timeoutMs: 5000 };
  return { mock, dir, vault, ctx: base, writeCtx: { ...base, allowWrites: { expectedAccountName: ACCOUNT.name } }, done: async () => { await mock.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const bytes = (dir: string): Record<string, string> => Object.fromEntries(readdirSync(dir).sort().map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
const mutations = (m: Mock): number => m.ops.filter((o) => o.kind === 'mutation').length;
const deps = (r: Rig, over: Record<string, unknown> = {}) => ({ ctx: r.ctx, creds: CREDS, expectedAccountName: ACCOUNT.name, lockWaitMs: 400, ...over });
/** The real booking code, with the stand-in answering the way that leaves each stuck state. Returns the booking's reference. */
async function stuckPending(r: Rig, key = REQ.key): Promise<string> { r.mock.opts.jobAnswer = () => ({ job: null, userErrors: [] }); const res = await bookTestVisit(r.writeCtx, CREDS, reqWith(key)); assert.deepEqual([res.status, res.reason], ['uncertain', 'JOB_RESPONSE_UNUSABLE']); r.mock.opts.jobAnswer = undefined; return markerFor(key); }
async function stuckClientCreated(r: Rig, key = 'call-cccccccccccccccc'): Promise<string> { r.mock.opts.jobUserErrors = true; const res = await bookTestVisit(r.writeCtx, CREDS, reqWith(key)); assert.deepEqual([res.status, res.reason], ['not_booked', 'JOBBER_REFUSED']); r.mock.opts.jobUserErrors = false; return markerFor(key); }
async function stuckPendingNoIds(r: Rig, key = 'call-dddddddddddddddd'): Promise<string> { r.mock.opts.clientAnswer = () => ({ client: null, userErrors: [] }); const res = await bookTestVisit(r.writeCtx, CREDS, reqWith(key)); assert.deepEqual([res.status, res.reason], ['uncertain', 'CLIENT_RESPONSE_UNUSABLE']); r.mock.opts.clientAnswer = undefined; return markerFor(key); }
const addJob = (m: Mock, id: string, ref: string, over: Record<string, unknown> = {}): void => { m.jobs.set(id, { id, jobNumber: 9000, title: `Standard cleaning [${ref}]`, instructions: `Standard cleaning ${ref}`, jobStatus: 'UPCOMING', ...over }); };
const topFile = (dir: string, ref: string): string => readdirSync(dir).filter((f) => f.startsWith(`jobber-booking-ledger-${ref.toLowerCase()}.`)).sort((a, b) => Number(a.split('.')[1]) - Number(b.split('.')[1])).at(-1)!;
const topEntry = async (r: Rig, ref: string): Promise<{ gen: number; entry: Record<string, unknown> }> => JSON.parse(await fakeProtector.unprotect(readFileSync(join(r.dir, topFile(r.dir, ref)), 'utf8').trim()));

test('DRY RUN reads only: it says a stuck pending booking is eligible, changes no file, takes no lock, sends no Jobber write and prints no id', async () => {
  const r = await rig();
  try {
    const ref = await stuckPending(r); assert.match(ref, REF); assert.equal(r.mock.jobs.size, 1, 'the stand-in made the job the booking never heard about');
    const before = bytes(r.dir); const muts = mutations(r.mock); const opsBefore = r.mock.ops.length;
    const locks: string[] = []; const spy = Object.create(r.vault); spy.withLock = (name: string, fn: never, w: never) => { locks.push(name); return r.vault.withLock(name, fn, w); };
    const res = await resolveBooking(deps(r, { ctx: { ...r.ctx, vault: spy } }), ref, 'dry-run');
    assert.deepEqual([res.outcome, res.state, res.step, res.idsHeld, res.jobsFound, res.verified], ['eligible', 'pending', 3, true, 1, true]);
    assert.deepEqual(bytes(r.dir), before, 'not one ledger byte changed'); assert.equal(mutations(r.mock), muts, 'no Jobber write'); assert.deepEqual(locks, [], 'a dry run takes no lock, so it can never hold up a booking');
    assert.deepEqual(r.mock.ops.slice(opsBefore).map((o) => `${o.kind}:${o.field}`), ['query:account', 'query:jobs', 'query:job'], 'queries only: the account, the search, the one job read back');
    const text = resolveLines(res).join('\n'); assert.match(text, /result: ELIGIBLE/); assert.ok(!/JOB-|CLIENT-|PROP-|Testa|Invented|555|tok-valid|\.enc/.test(text), 'no id, name, number or file name');
  } finally { await r.done(); }
});

test('ADOPT records the one verified job as `created` with exactly one new generation, keeps the booking\'s own ids, writes nothing to Jobber, and a retry of the booking then writes nothing and verifies', async () => {
  const r = await rig();
  try {
    const ref = await stuckPending(r); const before = bytes(r.dir); const muts = mutations(r.mock);
    assert.equal((await ledgerUnresolved(r.vault)), 'some'); assert.equal((await pendingReport(r.vault)).items.length, 1);
    const locks: string[] = []; const spy = Object.create(r.vault); spy.withLock = (name: string, fn: never, w: never) => { locks.push(name); return r.vault.withLock(name, fn, w); };
    const res = await resolveBooking(deps(r, { ctx: { ...r.ctx, vault: spy } }), ref, 'adopt');
    assert.deepEqual([res.outcome, res.state, res.step, res.jobsFound, res.verified], ['adopted', 'pending', 3, 1, true]);
    assert.deepEqual(locks, [IDENTITY_LOCK, keyLockOf(ref)], 'the global booking-identity lock first, then the booking\'s own lock: the same two a booking takes, in the same order');
    const after = bytes(r.dir); const added = Object.keys(after).filter((f) => !(f in before)); assert.equal(added.length, 1, 'exactly one new file'); assert.match(added[0], new RegExp(`^jobber-booking-ledger-${ref.toLowerCase()}\\.4\\.enc$`));
    for (const f of Object.keys(before)) assert.equal(after[f], before[f], `${f} is untouched`);
    const top = await topEntry(r, ref); const e = top.entry as Record<string, unknown>;
    assert.equal(top.gen, 4); assert.equal(e.state, 'created'); assert.equal(e.jobId, [...r.mock.jobs.keys()][0], 'the one job the stand-in holds'); assert.ok(typeof e.clientId === 'string' && typeof e.propertyId === 'string', 'the booking\'s own client and property ids are kept');
    assert.equal(mutations(r.mock), muts, 'nothing was sent to Jobber');
    assert.equal(await ledgerUnresolved(r.vault), 'none'); assert.deepEqual((await pendingReport(r.vault)).items, []); assert.equal((await scanLedger(r.vault)).created, 1);
    const retry = await bookTestVisit(r.writeCtx, CREDS, REQ);
    assert.deepEqual([retry.status, retry.duplicate, retry.writes], ['booked_verified', true, 0], 'the booking code accepts the adopted entry: verified again, no write');
    assert.equal(mutations(r.mock), muts, 'still no second client or job'); assert.equal(r.mock.jobs.size, 1);
  } finally { await r.done(); }
});

test('ADOPT is idempotent: asked again it says already created, looks nothing up, writes nothing, and exits 0', async () => {
  const r = await rig();
  try {
    const ref = await stuckPending(r); await resolveBooking(deps(r), ref, 'adopt');
    const before = bytes(r.dir); const ops = r.mock.ops.length;
    for (const mode of ['adopt', 'dry-run'] as const) {
      const again = await resolveBooking(deps(r), ref, mode);
      assert.deepEqual([again.outcome, again.state], ['already_created', 'created'], mode);
    }
    assert.deepEqual(bytes(r.dir), before, 'no new generation'); assert.equal(r.mock.ops.length, ops, 'no request at all');
    assert.match(resolveLines(await resolveBooking(deps(r), ref, 'adopt')).join('\n'), /ALREADY CREATED/);
  } finally { await r.done(); }
});

test('client_created: with no job in Jobber it refuses (nothing to adopt); once exactly one matching job exists it adopts and keeps the stored ids', async () => {
  const r = await rig();
  try {
    const ref = await stuckClientCreated(r); const before = bytes(r.dir);
    for (const mode of ['dry-run', 'adopt'] as const) { const res = await resolveBooking(deps(r), ref, mode); assert.deepEqual([res.outcome, res.reason, res.state, res.jobsFound], ['refused', 'NO_JOB_FOUND', 'client_created', 0], mode); }
    assert.deepEqual(bytes(r.dir), before, 'refusals change nothing');
    addJob(r.mock, 'JOB-ELSEWHERE-1', ref);
    const dry = await resolveBooking(deps(r), ref, 'dry-run'); assert.deepEqual([dry.outcome, dry.state], ['eligible', 'client_created']);
    const done = await resolveBooking(deps(r), ref, 'adopt'); assert.equal(done.outcome, 'adopted');
    const e = (await topEntry(r, ref)).entry; assert.deepEqual([e.state, e.jobId, typeof e.clientId, typeof e.propertyId], ['created', 'JOB-ELSEWHERE-1', 'string', 'string']);
    assert.equal(await ledgerUnresolved(r.vault), 'none');
  } finally { await r.done(); }
});

test('pending with no ids (the client answer was lost): no job means refusal in both modes; it never guesses at a client', async () => {
  const r = await rig();
  try {
    const ref = await stuckPendingNoIds(r); const before = bytes(r.dir); const muts = mutations(r.mock);
    for (const mode of ['dry-run', 'adopt'] as const) { const res = await resolveBooking(deps(r), ref, mode); assert.deepEqual([res.outcome, res.reason, res.state, res.idsHeld, res.jobsFound], ['refused', 'NO_JOB_FOUND', 'pending', false, 0], mode); }
    assert.deepEqual(bytes(r.dir), before); assert.equal(mutations(r.mock), muts);
    addJob(r.mock, 'JOB-LATE-1', ref); assert.equal((await resolveBooking(deps(r), ref, 'adopt')).outcome, 'adopted', 'a matching job that does exist is adopted even though no ids were held');
    assert.equal((await topEntry(r, ref)).entry.clientId, undefined, 'and no id is invented');
  } finally { await r.done(); }
});

test('REFUSALS: none, several, a full search page, a failed or unreadable lookup, a mismatched or archived job and a wrong account all refuse in both modes, change no ledger byte and send no write', async () => {
  const cases: Array<[string, (r: Rig, ref: string) => void, string, number | undefined, string?]> = [
    ['no job found', (r) => { r.mock.opts.searchBlind = true; }, 'NO_JOB_FOUND', 0],
    ['two jobs carry the reference', (r, ref) => { addJob(r.mock, 'JOB-TWIN-1', ref); }, 'AMBIGUOUS', 2],
    ['a full search page cannot prove one', (r) => { r.mock.opts.extraNodes = Array.from({ length: 9 }, (_, i) => ({ id: `JOB-OTHER-${i}`, title: `Another job ${i}` })); }, 'AMBIGUOUS', 1],
    ['the search answers HTTP 500', (r) => { r.mock.opts.findStatus = 500; }, 'LOOKUP_FAILED', undefined],
    ['the search answers GraphQL errors', (r) => { r.mock.opts.findErrors = true; }, 'LOOKUP_FAILED', undefined],
    ['the search returns no list', (r) => { r.mock.opts.findNull = true; }, 'LOOKUP_FAILED', undefined],
    ['the search returns a node with no id', (r) => { r.mock.opts.findMalformed = true; }, 'LOOKUP_FAILED', undefined],
    ['the job cannot be read back', (r) => { r.mock.opts.readNull = true; }, 'LOOKUP_FAILED', 1],
    ['the job\'s instructions do not carry the reference', (r) => { r.mock.opts.readPatch = { instructions: 'Standard cleaning, no reference here' }; }, 'JOB_MISMATCH', 1],
    ['the job\'s title no longer carries the reference', (r) => { r.mock.opts.readPatch = { title: 'Renamed job' }; }, 'JOB_MISMATCH', 1],
    ['the job is archived', (r) => { r.mock.opts.readPatch = { jobStatus: 'ARCHIVED' }; }, 'JOB_MISMATCH', 1],
    ['the job is cancelled', (r) => { r.mock.opts.readPatch = { jobStatus: 'cancelled' }; }, 'JOB_MISMATCH', 1],
    ['the read-back is for a different job id', (r) => { r.mock.opts.readPatch = { id: 'JOB-SOMEONE-ELSE' }; }, 'JOB_MISMATCH', 1],
    ['the status is missing', (r) => { r.mock.opts.readPatch = { jobStatus: null }; }, 'JOB_MISMATCH', 1],
    ['the connected account is not the expected one', (r) => { r.mock.opts.account = { id: 'ACCT-TEST-1', name: 'Some Other Account' }; }, 'ACCOUNT_UNVERIFIED', undefined],
  ];
  for (const [name, arrange, reason, jobs] of cases) {
    const r = await rig();
    try {
      const ref = await stuckPending(r); arrange(r, ref); const before = bytes(r.dir); const muts = mutations(r.mock);
      for (const mode of ['dry-run', 'adopt'] as const) {
        const res = await resolveBooking(deps(r), ref, mode);
        assert.deepEqual([res.outcome, res.reason, res.jobsFound], ['refused', reason, jobs], `${name} (${mode})`);
        assert.equal(res.verified, undefined, `${name}: nothing is called verified`); assert.equal(res.state, 'pending', name);
        assert.match(resolveLines(res).join('\n'), new RegExp(`REFUSED \\(${reason}\\)`));
      }
      assert.deepEqual(bytes(r.dir), before, `${name}: not one ledger byte changed`); assert.equal(mutations(r.mock), muts, `${name}: no Jobber write`);
      assert.equal(await ledgerUnresolved(r.vault), 'some', `${name}: it stays unresolved`);
    } finally { await r.done(); }
  }
  const r = await rig(false);   // no stored tokens at all
  try { const ref = markerFor('call-eeeeeeeeeeeeeeee'); writeFileSync(join(r.dir, `jobber-booking-ledger-${ref.toLowerCase()}.1.enc`), await fakeProtector.protect(JSON.stringify({ version: 2, marker: ref, gen: 1, entry: { state: 'pending' } })));
    const res = await resolveBooking(deps(r), ref, 'adopt'); assert.deepEqual([res.outcome, res.reason], ['refused', 'ACCOUNT_UNVERIFIED']); assert.equal(r.mock.ops.length, 0, 'without tokens nothing was asked of Jobber'); }
  finally { await r.done(); }
});

test('LEDGER REFUSALS: a bad reference, no entry, a gap or damage, a cleared entry; and a finished entry is reported without a lookup', async () => {
  const r = await rig();
  try {
    for (const bad of ['', 'drewtest-0123456789ab', 'DREWTEST-0123456789A', 'DREWTEST-0123456789ABC', 'DREWTEST-0123456789AG', 'DREWTEST-0123456789AB/../x', ' DREWTEST-0123456789AB', 'fast2-000000000000000000000001']) { const res = await resolveBooking(deps(r), bad, 'adopt'); assert.deepEqual([res.outcome, res.reason], ['refused', 'BAD_REF'], JSON.stringify(bad)); }
    assert.equal(r.mock.ops.length, 0, 'a bad reference sends nothing');
    assert.equal((await resolveBooking(deps(r), 'DREWTEST-0123456789AB', 'dry-run')).reason, 'NO_ENTRY');
    const ref = markerFor('call-ffffffffffffffff'); const put = async (gen: number, entry: unknown, over: Record<string, unknown> = {}) => writeFileSync(join(r.dir, `jobber-booking-ledger-${ref.toLowerCase()}.${gen}.enc`), await fakeProtector.protect(JSON.stringify({ version: 2, marker: ref, gen, entry, ...over })));
    await put(1, { state: 'pending' }); await put(3, { state: 'pending' });
    assert.equal((await resolveBooking(deps(r), ref, 'adopt')).reason, 'LEDGER_UNREADABLE', 'a gap in the generation numbers');
    rmSync(join(r.dir, `jobber-booking-ledger-${ref.toLowerCase()}.3.enc`)); writeFileSync(join(r.dir, `jobber-booking-ledger-${ref.toLowerCase()}.2.enc`), 'garbage');
    assert.equal((await resolveBooking(deps(r), ref, 'adopt')).reason, 'LEDGER_UNREADABLE', 'a file that does not decode');
    await put(2, { state: 'pending' }, { marker: markerFor('call-gggggggggggggggg') }); assert.equal((await resolveBooking(deps(r), ref, 'adopt')).reason, 'LEDGER_UNREADABLE', 'another booking\'s reference inside');
    await put(2, { state: 'none' }); const none = await resolveBooking(deps(r), ref, 'adopt'); assert.deepEqual([none.reason, none.state], ['NOT_UNRESOLVED', 'none'], 'a cleared entry is not waiting for a person');
    assert.equal(r.mock.ops.length, 0, 'no ledger problem ever reaches Jobber');
    const done = await stuckPending(r, 'call-1111111111111111'); await resolveBooking(deps(r), done, 'adopt'); const ops = r.mock.ops.length;
    assert.equal((await resolveBooking(deps(r), done, 'dry-run')).outcome, 'already_created'); assert.equal(r.mock.ops.length, ops, 'a finished entry is not looked up');
  } finally { await r.done(); }
});

test('LOCKS AND GENERATIONS: a held lock, a taken generation, a lost lock or a failed write each refuse, leave every file as it was and send no write', async () => {
  const r = await rig();
  try {
    const ref = await stuckPending(r); const before = bytes(r.dir); const muts = mutations(r.mock);
    const held = (name: string) => r.vault.withLock(name, async () => { const ops = r.mock.ops.length; const res = await resolveBooking(deps(r, { lockWaitMs: 150 }), ref, 'adopt'); assert.equal(r.mock.ops.length, ops, `${name}: nothing was asked of Jobber while the lock was held`); return res; }, 1000);
    for (const name of [IDENTITY_LOCK, keyLockOf(ref)]) { const res = await held(name); assert.deepEqual([res.outcome, res.reason], ['refused', 'LOCKED'], name); assert.deepEqual(bytes(r.dir), before, name); }
    const wrap = (publish: (...a: never[]) => Promise<unknown>) => { const w = Object.create(r.vault); w.publishBlob = publish; return { ...r.ctx, vault: w } as Ctx; };
    const taken = await resolveBooking(deps(r, { ctx: wrap(async () => 'exists') }), ref, 'adopt'); assert.deepEqual([taken.outcome, taken.reason], ['refused', 'CONFLICT']);
    const lost = await resolveBooking(deps(r, { ctx: wrap(async () => { throw new JobberError('LOCK_LOST'); }) }), ref, 'adopt'); assert.deepEqual([lost.outcome, lost.reason], ['refused', 'LOCK_LOST']);
    const failed = await resolveBooking(deps(r, { ctx: wrap(async () => { throw new Error('disk SECRET'); }) }), ref, 'adopt'); assert.deepEqual([failed.outcome, failed.reason], ['refused', 'WRITE_FAILED']); assert.ok(!resolveLines(failed).join('\n').includes('SECRET'), 'an error\'s own text is never shown');
    const phantom = await resolveBooking(deps(r, { ctx: wrap(async () => 'published') }), ref, 'adopt');   // a write that claims success but left nothing readable: reported, never hidden
    assert.deepEqual([phantom.outcome, phantom.reason], ['refused', 'VERIFY_FAILED']); assert.match(resolveLines(phantom).join('\n'), /could not be read back as expected/);
    assert.deepEqual(bytes(r.dir), before, 'not one ledger byte changed by any of them'); assert.equal(mutations(r.mock), muts);
    const w = Object.create(r.vault); const real = r.vault.publishBlob.bind(r.vault); let written = ''; w.publishBlob = async (name: string, text: string, guard: () => void) => { written = name; return real(name, text, guard); };
    assert.equal((await resolveBooking(deps(r, { ctx: { ...r.ctx, vault: w } }), ref, 'adopt')).outcome, 'adopted'); assert.equal(written, `jobber-booking-ledger-${ref.toLowerCase()}.4`, 'the one name published is the next generation of this booking');
    assert.equal(r.vault.generations(`jobber-booking-ledger-${ref.toLowerCase()}`).length, 4);
  } finally { await r.done(); }
});

test('COMMAND: --clear does not exist; --adopt needs --confirm; nothing is read before usage is right; exit codes; and no line ever shows an id, a name, a number or a path', async () => {
  const r = await rig();
  try {
    const ref = await stuckPending(r); const lines: string[] = []; const say = (s: string): void => { lines.push(s); };
    const run = (argv: string[]) => runResolve(argv, { ctx: r.ctx, creds: CREDS, say, lockWaitMs: 400 });
    const base = ['--ref', ref, '--expect-name', ACCOUNT.name]; const ops = r.mock.ops.length; const before = bytes(r.dir);
    assert.equal(await run([]), 2); assert.equal(await run(['--ref', ref]), 2); assert.equal(await run(['--expect-name', ACCOUNT.name]), 2);
    assert.equal(await run([...base, '--clear']), 2); assert.match(lines.at(-1)!, /--clear does not exist/); assert.equal(await run([...base, '--adopt', '--clear', '--confirm']), 2);
    assert.equal(await run([...base, '--adopt']), 2); assert.match(lines.at(-1)!, /needs --confirm/); assert.equal(await run([...base, '--confirm']), 2);
    assert.equal(await run([...base, '--force']), 2); assert.equal(await run(['--ref', 'DREWTEST-0123456789ZZ', '--expect-name', ACCOUNT.name]), 2); assert.equal(await run(['--ref', ref, '--expect-name', '   ']), 2);
    assert.equal(r.mock.ops.length, ops, 'bad usage reads nothing from Jobber'); assert.deepEqual(bytes(r.dir), before, 'and changes nothing');
    assert.equal(await run(base), 0); assert.match(lines.at(-1)!, /ELIGIBLE/);
    assert.equal(await run([...base, '--adopt', '--confirm']), 0); assert.match(lines.join('\n'), /ADOPTED/);
    assert.equal(await run([...base, '--adopt', '--confirm']), 0); assert.match(lines.at(-1)!, /ALREADY CREATED/);
    const other = await stuckPendingNoIds(r); assert.equal(await run(['--ref', other, '--expect-name', ACCOUNT.name]), 1); assert.match(lines.at(-1)!, /REFUSED \(NO_JOB_FOUND\)/);
    const all = lines.join('\n'); assert.ok(!/JOB-|CLIENT-|PROP-|Testa|Invented|Lane|90210|555|010-4242|tok-valid|refresh-|test-client|Users|\.enc|fast2-|call-0123/.test(all), 'no id, name, address, number, token, key or file name');
    for (const m of all.matchAll(/DREWTEST-[0-9A-Za-z]+/g)) assert.ok(REF.test(m[0]) || ['DREWTEST-0123456789ZZ', 'DREWTEST-XXXXXXXXXXXX'].includes(m[0]), `${m[0]}: only a real-shaped reference, the rejected test value, or the usage line's placeholder`);
  } finally { await r.done(); }
});

test('SOURCE: the resolve module can only read Jobber and publish one ledger generation; it holds no mutation, delete, clear or environment access; it takes the same two locks as a booking; the command file is a thin read-only wrapper', () => {
  const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  const mod = strip(readFileSync(new URL('../src/jobber-resolve.ts', import.meta.url), 'utf8'));
  assert.deepEqual([...mod.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]), ['./jobber-connector.ts', './jobber-connector.ts', './jobber-booking.ts']);
  assert.deepEqual([...mod.matchAll(/import (?:type )?\{ ([^}]*) \} from '\.\/jobber-connector\.ts'/g)].flatMap((m) => m[1].split(', ')).sort(), ['Credentials', 'Ctx', 'JobberError', 'LockHandle', 'query', 'verifyExpectedAccount']);
  for (const word of ['mutation', 'mutate(', 'allowWrites', 'WRITE_ALLOWLIST', 'process.', 'console.', 'node:', 'unlink', 'rmSync', 'rename', 'writeFile', 'appendFile', 'saveBlob', 'saveTokens', 'saveCredentials', 'clearTokens', 'withRefreshLock', 'setTimeout', 'fetch(']) assert.ok(!mod.includes(word), word);
  assert.equal([...mod.matchAll(/publishBlob\(/g)].length, 1, 'one write, and it publishes a new name');
  assert.deepEqual([...mod.matchAll(/query\(ctx, creds, (\w+)/g)].map((m) => m[1]), ['FIND', 'READ']); assert.ok(!/--clear|clearEntry|resetEntry/.test(mod.replace(/--clear does not exist[^']*/, '').replace(/argv\.includes\('--clear'\)/, '').replace(/\(there is no --clear\)/, '')), 'there is no clear mode: --clear appears only in its own refusal');
  const booking = readFileSync(new URL('../src/jobber-booking.ts', import.meta.url), 'utf8');
  assert.equal(IDENTITY_LOCK, SETUP_IDENTITY_LOCK, 'the same global lock the keyring rotation takes'); assert.ok(booking.includes("const IDENTITY_LOCK = 'booking-identity';") && booking.includes('`booking-${marker.toLowerCase()}`'), 'the booking takes these two locks');
  assert.equal(keyLockOf('DREWTEST-0123456789AB'), 'booking-drewtest-0123456789ab'); assert.ok(booking.includes("const LEGACY_LEDGER = 'jobber-booking-ledger';") && mod.includes("'jobber-booking-ledger-'"), 'the same ledger names');
  const main = strip(readFileSync(new URL('../src/jobber-resolve-main.ts', import.meta.url), 'utf8'));
  assert.ok(/import \{ privateFolder \} from '\.\/private-folder\.ts';/.test(main) && /createVault\(privateFolder\(\), windowsProtector\(\)\)/.test(main), 'the private folder comes from the fail-closed resolver');
  for (const word of ['allowWrites', 'process.env', 'JOBBER_STORE_DIR', 'writeFile', 'mutate', 'unlink', 'rmSync']) assert.ok(!main.includes(word), `main: ${word}`);
  assert.ok(/diag: \(\) => undefined/.test(main), 'diagnostics are dropped: the printed words are the whole output');
});
