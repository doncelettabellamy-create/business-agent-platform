// Test-account-only booking adapter for the standalone Jobber connector (proof of concept). NOT wired to the voice server, the call logic or the simulated booking checkpoint (simulated-booking.ts is untouched and does not
// import this); nothing imports this file except its tests. It is used ONLY against the founder's Jobber DEVELOPER TEST ACCOUNT, and only when writes are switched on in the connector context (they are off by default).
//
// One booking = one test client with one property (clientCreate), one job with one scheduled visit (jobCreate), then an INDEPENDENT read-back (a separate query path that reads the job by id and compares every field that
// matters). The field names and input types below were read from the live schema on 2026-11-01 (read-only introspection); what the schema cannot say is marked UNVERIFIED and is covered by the read-back, so a wrong guess
// ends as `uncertain`, never as a claimed booking.
//
// Gates (all must hold, and each is checked again here): writes switched on for exactly the expected test account (name and pinned id, re-checked before every write); `gate` has all three literal `true`s (a record that
// passed eligibleForProcessing, a person approved this booking, the caller agreed to this price and time); the request is valid (strict patterns); the booking key has not been used (duplicate prevention below).
//
// Duplicate prevention: (1) a ledger of this key's progress in the private folder (protected like the tokens, ids only, no personal detail) written BEFORE each write; (2) a marker in the job's title and instructions,
// searched in Jobber before any new job is created; (3) a lock per key so two callers cannot book at once. A retry after a finished booking changes nothing and only re-verifies it; a retry after a half-finished one
// reuses the client and property already created; a key left "pending" with no job to be found in Jobber is NOT retried (`uncertain`: a person decides).
//
// Privacy: the caller's name, phone and address are used only inside the request to Jobber. They are never logged, never put in an error, never in the ledger and never in a result. Diagnostics are fixed codes and counts.

import { createHash } from 'node:crypto';
import { JobberError, mutate, query, verifyExpectedAccount } from './jobber-connector.ts';
import type { Credentials, Ctx, LockHandle } from './jobber-connector.ts';
import { identitiesFor, keyringUnchanged, loadKeyring, normalizeParts } from './booking-identity.ts';
import type { IdentityParts } from './booking-identity.ts';
import { stateCodeOf } from './us-state.ts';

export interface BookingGate {
  /** The saved record passed eligibleForProcessing (the caller confirmed the read-back and the address). */ eligibleRecord: true;
  /** A person approved this booking step. */ approvedByPerson: true;
  /** The caller agreed to this price and this time. */ callerAgreed: true;
}
export interface BookingRequest {
  /** An opaque id for this booking (for example from the call reference); the same key can never book twice. */ key: string;
  gate: BookingGate;
  client: { firstName: string; lastName: string; /** A 10-digit US number, with or without punctuation. */ phone: string };
  address: { street1: string; city: string; postalCode: string; province?: string };
  /** The visit, in the Jobber account's local time: a date, two clock times, and the account's UTC offset (used to compare the read-back as instants). */
  when: { date: string; startTime: string; endTime: string; utcOffset: string };
  title: string; service: string; priceDollars: number;
}
/** A booking identified by WHAT was booked (booking-identity.ts) instead of a caller-chosen key: it carries `identity` and no `key`, and the identity must agree with the request's own phone, date, start time, house number and ZIP. */
export interface IdentityBookingRequest extends Omit<BookingRequest, 'key'> { key?: undefined; identity: IdentityParts }
export type BookingStatus = 'booked_verified' | 'not_booked' | 'uncertain' | 'refused';
export type BookingReason = 'INVALID_REQUEST' | 'NOT_AUTHORIZED' | 'WRITES_OFF' | 'ACCOUNT_MISMATCH' | 'JOBBER_REFUSED' | 'READBACK_MISMATCH' | 'PENDING_UNRESOLVED' | 'DUPLICATE_MARKERS' | 'NOT_FOUND' | 'API_ERROR' | 'RATE_LIMITED' | 'RECONNECT_REQUIRED' | 'LOCK_LOST' | 'LEDGER_UNREADABLE' | 'LEDGER_CONFLICT' | 'LEDGER_UNAVAILABLE' | 'IDENTITY_UNAVAILABLE' | 'IDENTITY_STALE';
export interface BookingResult {
  status: BookingStatus; reason?: BookingReason;
  /** True when this key had already been booked and nothing new was written. */ duplicate?: boolean;
  jobId?: string; jobNumber?: number;
  /** Only the NAMES of the fields that did not match the read-back. */ mismatches?: string[];
  /** How many mutations this call sent. */ writes: number;
}

const KEY = /^[A-Za-z0-9_-]{16,64}$/;
const NAME = /^[\p{L}][\p{L} '.-]{0,59}$/u;
const STREET = /^\d[\d-]*[A-Za-z]?\s+[\p{L}\p{N} .,'#/-]{2,80}$/u;   // a street address starts with a house number (a ZIP or a street name alone is never written)
const CITY = /^[\p{L} .'-]{2,60}$/u;
const TEXT = /^[A-Za-z0-9 .,'&()-]{3,80}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/; const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/; const OFFSET = /^[+-](0\d|1[0-4]):[0-5]\d$/;
const JOB_ID = /^[A-Za-z0-9_=+/.-]{4,200}$/;

const digitsOf = (s: string): string => s.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
export const markerFor = (key: string): string => `DREWTEST-${createHash('sha256').update(`drew-booking:${key}`).digest('hex').slice(0, 12).toUpperCase()}`;
const instant = (date: string, clock: string, offset: string): number => Date.parse(`${date}T${clock}:00${offset}`);

/** The identity parts must be the request's own phone, date, start time, house number and ZIP (in their normal spelling): a booking can never be filed under the identity of another one. */
function identityAgrees(x: IdentityBookingRequest): boolean {
  try {
    const a = normalizeParts(x.identity); const b = normalizeParts({ phone: x.client.phone, date: x.when.date, startTime: x.when.startTime, street: x.address.street1, zip: x.address.postalCode });
    return a.phone === b.phone && a.date === b.date && a.start === b.start && a.house === b.house && a.zip === b.zip;
  } catch { return false; }
}

/** What is wrong with a request, as field names only (never a value). */
export function requestProblems(r: unknown, now: number): string[] {
  const p: string[] = []; const x = r as BookingRequest;
  if (typeof x !== 'object' || x === null) return ['request'];
  const givenIdentity = (x as { identity?: unknown }).identity !== undefined;
  if (givenIdentity ? x.key !== undefined : (typeof x.key !== 'string' || !KEY.test(x.key))) p.push('key');   // an identity request has no key of its own: it is derived, so one that is given is refused, never ignored
  if (givenIdentity && !identityAgrees(x as unknown as IdentityBookingRequest)) p.push('identity');
  if (!(x.gate?.eligibleRecord === true && x.gate?.approvedByPerson === true && x.gate?.callerAgreed === true)) p.push('gate');
  if (!NAME.test(String(x.client?.firstName ?? ''))) p.push('client.firstName');
  if (!NAME.test(String(x.client?.lastName ?? ''))) p.push('client.lastName');
  if (!/^[\d\s().+-]{10,20}$/.test(String(x.client?.phone ?? '')) || !/^\d{10}$/.test(digitsOf(String(x.client?.phone ?? '')))) p.push('client.phone');
  if (!STREET.test(String(x.address?.street1 ?? ''))) p.push('address.street1');
  if (!CITY.test(String(x.address?.city ?? ''))) p.push('address.city');
  if (!/^\d{5}$/.test(String(x.address?.postalCode ?? ''))) p.push('address.postalCode');
  if (!/^[A-Za-z]{2}$/.test(String(x.address?.province ?? ''))) p.push('address.province');   // required: no write without the caller's state
  if (String(x.address?.street1 ?? '').split(' ')[0] === String(x.address?.postalCode ?? '') && String(x.address?.postalCode ?? '') !== '') p.push('address.street1');   // the house number is the ZIP: a ZIP said as a number
  const w = x.when;
  if (!DATE.test(String(w?.date ?? '')) || !CLOCK.test(String(w?.startTime ?? '')) || !CLOCK.test(String(w?.endTime ?? '')) || !OFFSET.test(String(w?.utcOffset ?? ''))) p.push('when');
  else {
    const s = instant(w.date, w.startTime, w.utcOffset); const e = instant(w.date, w.endTime, w.utcOffset);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s || e - s > 8 * 3_600_000 || s <= now || s > now + 30 * 86_400_000) p.push('when');   // not in the past, and not more than 30 days ahead
  }
  if (!TEXT.test(String(x.title ?? ''))) p.push('title');
  if (!TEXT.test(String(x.service ?? ''))) p.push('service');
  if (typeof x.priceDollars !== 'number' || !Number.isFinite(x.priceDollars) || x.priceDollars < 1 || x.priceDollars > 100_000 || Math.abs(x.priceDollars * 100 - Math.round(x.priceDollars * 100)) > 1e-6) p.push('priceDollars');
  return p;
}

// ---------------------------------------------------------------- the ledger (ids only; protected; written before each write)
// One set of generation files per key (`jobber-booking-ledger-<marker>.<n>.enc`, n = 1, 2, 3 ...). Each generation is published once and never replaced (`publishBlob`), and the highest one is the key's state.
// Anything unreadable or invalid is LEDGER_UNREADABLE (uncertain, nothing written), never "empty", and an older generation is never used instead of an unreadable newer one. The older single-file ledger
// (`jobber-booking-ledger.enc`) is READ-ONLY: it is consulted only for a key that has no generation file yet, and it is never written or removed.
type EntryState = 'none' | 'pending' | 'client_created' | 'created';
interface Entry { state: EntryState; clientId?: string; propertyId?: string; jobId?: string }
const LEGACY_LEDGER = 'jobber-booking-ledger';
const MAX_GENERATION = 99;
const ledgerBase = (marker: string): string => `${LEGACY_LEDGER}-${marker.toLowerCase()}`;
const unreadable = (): JobberError => new JobberError('LEDGER_UNREADABLE');
/** A stored entry is accepted only if it has exactly one of the shapes this code writes; anything else is undefined (the caller fails closed). */
function validEntry(x: unknown, allowNone: boolean): Entry | undefined {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return undefined;
  const o = x as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== 'state' && k !== 'clientId' && k !== 'propertyId' && k !== 'jobId')) return undefined;
  const idOk = (v: unknown): boolean => v === undefined || (typeof v === 'string' && JOB_ID.test(v));
  if (!idOk(o.clientId) || !idOk(o.propertyId) || !idOk(o.jobId)) return undefined;
  const pair = (o.clientId === undefined) === (o.propertyId === undefined);
  const ids = { ...(o.clientId === undefined ? {} : { clientId: o.clientId as string }), ...(o.propertyId === undefined ? {} : { propertyId: o.propertyId as string }) };
  if (o.state === 'none') return allowNone && o.clientId === undefined && o.propertyId === undefined && o.jobId === undefined ? { state: 'none' } : undefined;
  if (o.state === 'pending') return pair && o.jobId === undefined ? { state: 'pending', ...ids } : undefined;
  if (o.state === 'client_created') return o.clientId !== undefined && o.propertyId !== undefined && o.jobId === undefined ? { state: 'client_created', ...ids } : undefined;
  if (o.state === 'created') return o.jobId !== undefined ? { state: 'created', ...ids, jobId: o.jobId as string } : undefined;
  return undefined;
}
function parseGeneration(text: string | undefined, marker: string, gen: number): Entry | undefined {
  if (text === undefined) return undefined;
  let j: unknown; try { j = JSON.parse(text); } catch { return undefined; }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return undefined;
  const o = j as Record<string, unknown>;
  if (Object.keys(o).length !== 4 || o.version !== 2 || o.marker !== marker || o.gen !== gen) return undefined;
  return validEntry(o.entry, true);
}
/** The older single-file ledger, read only. Absent: no prior state. Present but unreadable or malformed: LEDGER_UNREADABLE (it may hold this key's state). */
async function legacyEntry(ctx: Ctx, marker: string): Promise<Entry | undefined> {
  if (!ctx.vault.hasBlob(LEGACY_LEDGER)) return undefined;
  const text = await ctx.vault.loadBlob(LEGACY_LEDGER); if (text === undefined) throw unreadable();
  let j: unknown; try { j = JSON.parse(text); } catch { throw unreadable(); }
  const o = typeof j === 'object' && j !== null && !Array.isArray(j) ? j as Record<string, unknown> : {};
  const entries = o.entries;
  if (o.version !== 1 || typeof entries !== 'object' || entries === null || Array.isArray(entries)) throw unreadable();
  if (!Object.hasOwn(entries, marker)) return undefined;
  const e = validEntry((entries as Record<string, unknown>)[marker], false); if (e === undefined) throw unreadable();
  return e;
}
/** This key's state: the highest generation (the numbers must run 1..n without a gap, n at most 99, and the file must be valid for this marker and number); with no generation file, the older ledger's entry. */
async function loadEntry(ctx: Ctx, marker: string): Promise<{ gen: number; entry: Entry | undefined }> {
  const base = ledgerBase(marker); const gens = ctx.vault.generations(base);
  if (gens.length === 0) return { gen: 0, entry: await legacyEntry(ctx, marker) };
  const top = gens[gens.length - 1];
  if (top > MAX_GENERATION || gens.length !== top || gens[0] !== 1) throw unreadable();
  const entry = parseGeneration(await ctx.vault.loadBlob(`${base}.${top}`), marker, top); if (entry === undefined) throw unreadable();
  return { gen: top, entry: entry.state === 'none' ? undefined : entry };
}

// ---------------------------------------------------------------- the documents (names and types from the live schema, 2026-11-01)
const CREATE_CLIENT = 'mutation CreateTestClient($input: ClientCreateInput!) { clientCreate(input: $input) { client { id clientProperties(first: 5) { nodes { id } } } userErrors { message path } } }';
const CREATE_JOB = 'mutation CreateTestJob($input: JobCreateAttributes!) { jobCreate(input: $input) { job { id jobNumber } userErrors { message path } } }';
const FIND_JOBS = 'query FindTestJobs($term: String!) { jobs(first: 10, searchTerm: $term) { nodes { id title } } }';
const READ_BACK = 'query ReadBackJob($id: EncodedId!) { job(id: $id) { id jobNumber title instructions jobStatus total client { firstName lastName phones { number } } property { address { street1 city postalCode province } } visits(first: 5) { nodes { startAt endAt } } } }';

const rec = (x: unknown): Record<string, unknown> => (typeof x === 'object' && x !== null ? x as Record<string, unknown> : {});
const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const norm = (s: unknown): string => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

export function clientInput(r: BookingRequest): Record<string, unknown> {
  return {
    firstName: r.client.firstName, lastName: r.client.lastName,
    // Jobber must not message the test client by itself: all reminders and follow-ups are off and the number is not SMS-enabled (the texts of this project are sent by Twilio, later, on their own gate).
    receivesReminders: false, receivesFollowUps: false, receivesQuoteFollowUps: false, receivesInvoiceFollowUps: false, receivesReviewRequests: false,
    phones: [{ number: digitsOf(r.client.phone), description: 'MOBILE', smsAllowed: false, primary: true }],
    properties: [{ address: { street1: r.address.street1, city: r.address.city, postalCode: r.address.postalCode, ...(r.address.province === undefined ? {} : { province: r.address.province.toUpperCase() }) } }],
  };
}
export function jobInput(r: BookingRequest, propertyId: string, marker: string): Record<string, unknown> {
  return {
    propertyId, title: `${r.title} [${marker}]`, instructions: `${r.service} ${marker}`, allowReviewRequest: false,
    invoicing: { invoicingType: 'FIXED_PRICE', invoicingSchedule: 'ON_COMPLETION' },
    // `startTime` and `endTime` are ISO 8601 clock times of the visit and `timeframe.startAt` the date (descriptions read from the schema); that they are read in the account's own time zone is UNVERIFIED until the first approved test write, and the read-back compares instants, so a different reading cannot pass as a booking.
    timeframe: { startAt: r.when.date, durationUnits: 'DAYS', durationValue: 1 },
    scheduling: { createVisits: true, notifyTeam: false, startTime: `${r.when.startTime}:00`, endTime: `${r.when.endTime}:00` },
    lineItems: [{ name: r.service, unitPrice: r.priceDollars, quantity: 1, saveToProductsAndServices: false }],
  };
}

/** The independent read-back: a separate query path (a read by job id) that compares what Jobber now holds with what was confirmed. Returns the NAMES of the fields that differ (none = verified). */
export async function readBackJob(ctx: Ctx, creds: Credentials, jobId: string, r: BookingRequest, marker: string): Promise<{ found: boolean; mismatches: string[]; jobNumber?: number }> {
  if (!JOB_ID.test(jobId)) return { found: false, mismatches: ['jobId'] };
  const j = rec((await query(ctx, creds, READ_BACK, { id: jobId })).data.job);
  if (typeof j.id !== 'string') return { found: false, mismatches: [] };
  const bad: string[] = [];
  if (j.id !== jobId) bad.push('jobId');
  if (!String(j.title ?? '').includes(marker) || !String(j.instructions ?? '').includes(marker)) bad.push('marker');
  if (String(j.title ?? '') !== `${r.title} [${marker}]`) bad.push('title');
  const c = rec(j.client);
  if (norm(c.firstName) !== norm(r.client.firstName) || norm(c.lastName) !== norm(r.client.lastName)) bad.push('client_name');
  if (!list(c.phones).some((p) => digitsOf(String(rec(p).number ?? '')) === digitsOf(r.client.phone))) bad.push('client_phone');
  const a = rec(rec(j.property).address);
  if (norm(a.street1) !== norm(r.address.street1) || norm(a.city) !== norm(r.address.city) || String(a.postalCode ?? '').trim().slice(0, 5) !== r.address.postalCode) bad.push('address');
  // The STATE (Jobber's PropertyAddress.province, a nullable String, read from the live schema on 2026-11-07): the two-letter code or the full name, in any case. Missing, unknown or different from the requested state is NOT verified (the booking is uncertain, never claimed).
  { const want = stateCodeOf(r.address.province); const got = stateCodeOf(a.province); if (want === undefined || got === undefined || want !== got) bad.push('province'); }
  const visits = list(rec(j.visits).nodes).map(rec);
  if (visits.length !== 1) bad.push('visit_count');
  else if (Date.parse(String(visits[0].startAt)) !== instant(r.when.date, r.when.startTime, r.when.utcOffset) || Date.parse(String(visits[0].endAt)) !== instant(r.when.date, r.when.endTime, r.when.utcOffset)) bad.push('visit_time');
  if (Math.abs(Number(j.total) - r.priceDollars) > 0.005) bad.push('price');
  if (/archiv|cancel|closed/i.test(String(j.jobStatus ?? ''))) bad.push('job_status');
  return { found: true, mismatches: bad, ...(typeof j.jobNumber === 'number' ? { jobNumber: j.jobNumber } : {}) };
}

async function findByMarker(ctx: Ctx, creds: Credentials, marker: string): Promise<string[]> {
  const nodes = list(rec((await query(ctx, creds, FIND_JOBS, { term: marker })).data.jobs).nodes).map(rec);
  return nodes.filter((n) => String(n.title ?? '').includes(marker) && typeof n.id === 'string').map((n) => n.id as string);
}
const userErrorCount = (x: unknown): number => list(x).length;

/** The global lock of the booking identity: the same name the founder-run rotation takes (the rotation script's IDENTITY_LOCK; a test keeps the two equal). */
const IDENTITY_LOCK = 'booking-identity';
/** The identity could not be established, or changed under a running booking. Only a fixed code; it is never a fall-back to another key. */
class IdentityFailure extends Error { readonly code: 'IDENTITY_UNAVAILABLE' | 'IDENTITY_STALE'; constructor(code: 'IDENTITY_UNAVAILABLE' | 'IDENTITY_STALE') { super(code); this.name = 'IdentityFailure'; this.code = code; } }
const hasIdentity = (r: BookingRequest | IdentityBookingRequest): r is IdentityBookingRequest => (r as { identity?: unknown }).identity !== undefined;

/** Books one TEST visit in the Jobber Developer Test Account, then verifies it independently. Never throws for an expected failure: the status says what happened.
 *  A request with a `key` is booked exactly as before. A request with `identity` (and no key) is booked under the HMAC identity of what was booked: the global `booking-identity` lock first, then the per-key lock, the keyring checked again before every write,
 *  and a booking already made under a RETIRED key is found (ledger and Jobber) and accepted as a duplicate only after the same full read-back; any doubt is uncertain, never a fall-back to the Call-SID key or to a new booking. */
export async function bookTestVisit(ctx: Ctx, creds: Credentials, input: BookingRequest | IdentityBookingRequest): Promise<BookingResult> {
  let writes = 0;
  const done = (status: BookingStatus, extra: Partial<BookingResult> = {}): BookingResult => ({ status, writes, ...extra });
  const problems = requestProblems(input, ctx.now());
  if (problems.length > 0) { ctx.diag('JOBBER_BOOKING_REFUSED', { reason: problems.includes('gate') ? 'NOT_AUTHORIZED' : 'INVALID_REQUEST', fields: problems.join(',') }); return done('refused', { reason: problems.includes('gate') ? 'NOT_AUTHORIZED' : 'INVALID_REQUEST' }); }
  if (ctx.allowWrites === undefined) { ctx.diag('JOBBER_BOOKING_REFUSED', { reason: 'WRITES_OFF' }); return done('refused', { reason: 'WRITES_OFF' }); }
  /** What happens once the key lock is held. `aliasCheck`, when given (identity bookings only), looks for the same booking under retired keys after the key's own state is known and before anything is written. */
  const locked = async (req: BookingRequest, marker: string, lock: LockHandle, aliasCheck?: (verify: (jobId: string, duplicate: boolean, under?: string) => Promise<BookingResult>) => Promise<BookingResult | undefined>): Promise<BookingResult> => {
      const base = ledgerBase(marker); const loaded = await loadEntry(ctx, marker); let generation = loaded.gen;
      const ledger: Record<string, Entry> = loaded.entry === undefined ? {} : { [marker]: loaded.entry }; const prior = ledger[marker];
      // Every ledger write and every Jobber write first checks that this call still owns the lock; a call that lost it stops here, before the next write (LOCK_LOST).
      const save = async (): Promise<void> => {
        if (generation >= MAX_GENERATION) throw new JobberError('LEDGER_UNAVAILABLE');
        const next = generation + 1; const text = JSON.stringify({ version: 2, marker, gen: next, entry: ledger[marker] ?? { state: 'none' } });
        // The lock is checked inside publishBlob, after the protect step and immediately before the file is linked into place; a name that is already taken means another writer got there first.
        if (await ctx.vault.publishBlob(`${base}.${next}`, text, () => lock.assertHeld()) === 'exists') throw new JobberError('LEDGER_CONFLICT');
        generation = next;
      };
      const write = (query: string, variables: Record<string, unknown>): ReturnType<typeof mutate> => { lock.assertHeld(); writes++; return mutate(ctx, creds, query, variables); };
      const verify = async (jobId: string, duplicate: boolean, under: string = marker): Promise<BookingResult> => {
        const rb = await readBackJob(ctx, creds, jobId, req, under);
        if (!rb.found) return done('uncertain', { reason: 'NOT_FOUND', jobId, ...(duplicate ? { duplicate } : {}) });
        if (rb.mismatches.length > 0) { ctx.diag('JOBBER_READBACK_MISMATCH', { fields: rb.mismatches.join(',') }); return done('uncertain', { reason: 'READBACK_MISMATCH', jobId, mismatches: rb.mismatches, ...(duplicate ? { duplicate } : {}) }); }
        return done('booked_verified', { jobId, ...(rb.jobNumber === undefined ? {} : { jobNumber: rb.jobNumber }), ...(duplicate ? { duplicate } : {}) });
      };
      // 1. a finished booking is never repeated: it is only verified again
      if (prior?.state === 'created' && prior.jobId !== undefined) return verify(prior.jobId, true);
      // 2. Jobber itself is asked whether this key already has a job (a lost ledger, or a crash after the job was created)
      const existing = await findByMarker(ctx, creds, marker);
      if (existing.length > 1) return done('uncertain', { reason: 'DUPLICATE_MARKERS' });
      if (existing.length === 1) { ledger[marker] = { ...(prior ?? { state: 'created' }), state: 'created', jobId: existing[0] }; await save(); return verify(existing[0], true); }
      // 3. a key left pending with no job in Jobber is not retried blindly
      if (prior?.state === 'pending') return done('uncertain', { reason: 'PENDING_UNRESOLVED' });
      // 4. (identity bookings only) the same booking under a retired key: found, and then verified in full, or uncertain. The locks and the keyring are checked once more before the answer is used.
      if (aliasCheck !== undefined) { const found = await aliasCheck(verify); lock.assertHeld(); if (found !== undefined) return found; }
      let clientId = prior?.clientId; let propertyId = prior?.propertyId;
      if (prior?.state !== 'client_created' || propertyId === undefined) {
        ledger[marker] = { state: 'pending' }; await save();   // written BEFORE the write
        const c = rec(rec((await write(CREATE_CLIENT, { input: clientInput(req) })).data.clientCreate));
        const props = list(rec(rec(c.client).clientProperties).nodes).map(rec);
        if (userErrorCount(c.userErrors) > 0 || typeof rec(c.client).id !== 'string' || props.length !== 1 || typeof props[0].id !== 'string') { ctx.diag('JOBBER_BOOKING_REFUSED', { reason: 'JOBBER_REFUSED', userErrors: userErrorCount(c.userErrors) }); delete ledger[marker]; await save(); return done('not_booked', { reason: 'JOBBER_REFUSED' }); }
        clientId = rec(c.client).id as string; propertyId = props[0].id as string;
        ledger[marker] = { state: 'client_created', clientId, propertyId }; await save();
      }
      ledger[marker] = { state: 'pending', clientId, propertyId }; await save();   // written BEFORE the job is created
      // An unknown outcome (an error after the request was sent) leaves the key "pending": the next call asks Jobber before doing anything.
      const jc = rec(rec((await write(CREATE_JOB, { input: jobInput(req, propertyId as string, marker) })).data.jobCreate));
      if (userErrorCount(jc.userErrors) > 0 || typeof rec(jc.job).id !== 'string') { ctx.diag('JOBBER_BOOKING_REFUSED', { reason: 'JOBBER_REFUSED', userErrors: userErrorCount(jc.userErrors) }); ledger[marker] = { state: 'client_created', clientId, propertyId }; await save(); return done('not_booked', { reason: 'JOBBER_REFUSED' }); }
      const jobId = rec(jc.job).id as string;
      ledger[marker] = { state: 'created', clientId, propertyId, jobId }; await save();
      ctx.diag('JOBBER_BOOKING_CREATED', { writes });
      return verify(jobId, false);
  };
  /** The identity path: global lock, keyring, key and marker from the keyring's current secret, key lock, and one handle that checks BOTH locks and the keyring generation at every write. */
  const byIdentity = (input: IdentityBookingRequest): Promise<BookingResult> => ctx.vault.withLock(IDENTITY_LOCK, async (outer) => {
    const keyring = await loadKeyring(ctx.vault);
    if (!keyring.ok) { ctx.diag('JOBBER_IDENTITY_FAILED', { problem: keyring.problem, ...(keyring.gen === undefined ? {} : { gen: keyring.gen }) }); throw new IdentityFailure('IDENTITY_UNAVAILABLE'); }
    let ids: { key: string; aliases: string[] }; try { ids = identitiesFor(keyring.keyring, input.identity); } catch { ctx.diag('JOBBER_IDENTITY_FAILED', { problem: 'PARTS' }); throw new IdentityFailure('IDENTITY_UNAVAILABLE'); }
    const unchanged = (): void => { if (!keyringUnchanged(ctx.vault, keyring.generations)) { ctx.diag('JOBBER_IDENTITY_FAILED', { problem: 'STALE' }); throw new IdentityFailure('IDENTITY_STALE'); } };
    const req: BookingRequest = { ...input, key: ids.key }; const marker = markerFor(req.key);
    const aliasCheck = async (verify: (jobId: string, duplicate: boolean, under?: string) => Promise<BookingResult>): Promise<BookingResult | undefined> => {
      const hits = new Map<string, { marker: string; kid: string }>(); let unresolved = false;
      for (let i = 0; i < ids.aliases.length; i++) {
        const am = markerFor(ids.aliases[i]); const { entry } = await loadEntry(ctx, am);   // an unreadable chain throws LEDGER_UNREADABLE: uncertain, nothing written
        const found = new Set<string>(); if (entry?.state === 'created' && entry.jobId !== undefined) found.add(entry.jobId);
        for (const id of await findByMarker(ctx, creds, am)) found.add(id);
        if (entry !== undefined && entry.state !== 'created' && found.size === 0) unresolved = true;   // started under that key, no job to be seen: not known to be unbooked
        for (const id of found) hits.set(id, { marker: am, kid: keyring.keyring.retired[i].kid });
      }
      if (hits.size > 1) return done('uncertain', { reason: 'DUPLICATE_MARKERS' });
      if (unresolved) return done('uncertain', { reason: 'PENDING_UNRESOLVED' });
      if (hits.size === 0) return undefined;
      const [jobId, at] = [...hits][0]; ctx.diag('JOBBER_IDENTITY_ALIAS_HIT', { kid: at.kid });
      return verify(jobId, true, at.marker);   // the SAME read-back as any booking, against that key's marker: a duplicate only when every field matches
    };
    return ctx.vault.withLock(`booking-${marker.toLowerCase()}`, (inner) => {
      const both: LockHandle = { assertHeld(): void { outer.assertHeld(); inner.assertHeld(); unchanged(); } };
      return locked(req, marker, both, aliasCheck);
    });
  });
  try {
    const tokens = await ctx.vault.loadTokens(); if (tokens === undefined) throw new JobberError('NOT_CONNECTED');
    await verifyExpectedAccount(ctx, creds, ctx.allowWrites.expectedAccountName, tokens.account_id);   // the test account, before anything else
    if (hasIdentity(input)) return await byIdentity(input);
    const req = input; const marker = markerFor(req.key);
    return await ctx.vault.withLock(`booking-${marker.toLowerCase()}`, (lock) => locked(req, marker, lock));
  } catch (e) {
    const identity = e instanceof IdentityFailure ? e.code : undefined;
    const code = e instanceof JobberError ? e.code : 'API_ERROR';
    const reason: BookingReason = identity ?? (code === 'ACCOUNT_MISMATCH' ? 'ACCOUNT_MISMATCH' : code === 'RATE_LIMITED' ? 'RATE_LIMITED' : code === 'RECONNECT_REQUIRED' || code === 'NOT_CONNECTED' ? 'RECONNECT_REQUIRED' : code === 'NOT_READ_ONLY' ? 'WRITES_OFF' : code === 'LOCK_LOST' || code === 'LEDGER_UNREADABLE' || code === 'LEDGER_CONFLICT' || code === 'LEDGER_UNAVAILABLE' ? code : 'API_ERROR');
    ctx.diag('JOBBER_BOOKING_FAILED', { reason });
    // Before any write an error is simply "not booked"; after a write was sent its outcome is unknown, so the status says so.
    const unsure = reason === 'LEDGER_UNREADABLE' || reason === 'LEDGER_CONFLICT';   // a ledger that cannot be trusted may be hiding a booking
    return done(writes > 0 || unsure ? 'uncertain' : 'not_booked', { reason });
  }
}
export { parseGeneration as parseLedgerGeneration, validEntry as validLedgerEntry };   // read-only use by jobber-ledger-scan.ts
