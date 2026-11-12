// FOUNDER-RUN, SUPERVISED RESOLUTION of ONE unresolved booking (Stage 1; nothing in a call or a booking imports this file; the command is src/jobber-resolve-main.ts).
//
//   (no flag)            DRY RUN: reads the ledger entry and asks Jobber (READ ONLY) whether exactly one job carries this booking reference; says what --adopt would do. Writes nothing, takes no lock.
//   --adopt --confirm    records that ONE job in the ledger (a `created` generation, the very state the next booking attempt would reach on its own), and only when ALL of this holds, re-checked under the locks:
//                        the entry is `pending` or `client_created`; the connected Jobber account is the expected test account; exactly ONE job carries the reference in its title; that job, read back by id, carries the reference
//                        in its title AND its instructions and is not archived, cancelled or closed. Anything else (none, several, an unusable or failed answer, a mismatch, a lock that cannot be had, a generation that is taken) REFUSES and writes nothing.
//   --clear              DOES NOT EXIST. An entry is never cleared, reset, deleted, retried or rewritten here.
//
// WHAT IT NEVER DOES: send a Jobber mutation (the connector it uses has writes OFF: no `allowWrites`), create, change, cancel or delete anything in Jobber, delete or overwrite a ledger file (one new generation is PUBLISHED, and an existing name is never replaced),
// resend anything, or print an id, a name, an address, a number, a key or a path: its words hold the booking reference (DREWTEST- and 12 hex characters), a state, a step number, yes/no and counts.
// It takes the SAME two locks a booking takes, in the same order: the global `booking-identity` lock, then the booking's own `booking-<reference>` lock, so it cannot overlap a booking or a keyring rotation.

import { JobberError, query, verifyExpectedAccount } from './jobber-connector.ts';
import type { Credentials, Ctx, LockHandle } from './jobber-connector.ts';
import { parseLedgerGeneration } from './jobber-booking.ts';

export const REF = /^DREWTEST-[0-9A-F]{12}$/;
const JOB_ID = /^[A-Za-z0-9_=+/.-]{4,200}$/;
const MAX_GENERATION = 99;
const PAGE = 10;
const LEDGER_PREFIX = 'jobber-booking-ledger-';
/** The two document the lookup sends: queries only (the connector refuses anything else, and this file holds no other document). */
const FIND = 'query ResolveFindJobs($term: String!) { jobs(first: 10, searchTerm: $term) { nodes { id title } } }';
const READ = 'query ResolveReadJob($id: EncodedId!) { job(id: $id) { id title instructions jobStatus } }';
/** The booking identity's own lock names (a test keeps them equal to the booking code's). */
export const IDENTITY_LOCK = 'booking-identity';
export const keyLockOf = (ref: string): string => `booking-${ref.toLowerCase()}`;

export type ResolveReason = 'BAD_REF' | 'NO_ENTRY' | 'LEDGER_UNREADABLE' | 'NOT_UNRESOLVED' | 'ACCOUNT_UNVERIFIED' | 'LOOKUP_FAILED' | 'NO_JOB_FOUND' | 'AMBIGUOUS' | 'JOB_MISMATCH' | 'LOCKED' | 'LOCK_LOST' | 'LEDGER_FULL' | 'CONFLICT' | 'WRITE_FAILED' | 'VERIFY_FAILED';
export interface ResolveResult {
  ref: string; mode: 'dry-run' | 'adopt';
  outcome: 'eligible' | 'adopted' | 'already_created' | 'refused';
  reason?: ResolveReason;
  /** What the ledger showed (never an id). */
  state?: 'pending' | 'client_created' | 'created' | 'none'; step?: number; idsHeld?: boolean;
  /** How many jobs carry the reference (undefined: the lookup did not run or failed). */ jobsFound?: number;
  /** The one job was read back by id and carries the reference in its title and instructions and is not archived, cancelled or closed. */ verified?: boolean;
}
export interface ResolveDeps { ctx: Ctx; creds: Credentials; expectedAccountName: string; /** How long to wait for each lock (default 30000). */ lockWaitMs?: number }

type Top = { kind: 'none' } | { kind: 'unreadable' } | { kind: 'entry'; gen: number; entry: NonNullable<ReturnType<typeof parseLedgerGeneration>> };
const baseOf = (ref: string): string => `${LEDGER_PREFIX}${ref.toLowerCase()}`;
const rec = (x: unknown): Record<string, unknown> => (typeof x === 'object' && x !== null ? x as Record<string, unknown> : {});

/** The highest generation of this booking's chain, read as strictly as the booking code reads it (no gap, starts at 1, at most 99, decodes, carries this reference and this number). */
async function readTop(ctx: Ctx, ref: string): Promise<Top> {
  const base = baseOf(ref);
  let gens: number[]; try { gens = ctx.vault.generations(base); } catch { return { kind: 'unreadable' }; }
  if (gens.length === 0) return { kind: 'none' };
  const top = gens[gens.length - 1];
  if (top > MAX_GENERATION || gens.length !== top || gens[0] !== 1) return { kind: 'unreadable' };
  let text: string | undefined; try { text = await ctx.vault.loadBlob(`${base}.${top}`); } catch { return { kind: 'unreadable' }; }
  const entry = parseLedgerGeneration(text, ref, top);
  return entry === undefined ? { kind: 'unreadable' } : { kind: 'entry', gen: top, entry };
}

type Found = { ok: true; jobId: string; jobs: 1 } | { ok: false; reason: 'ACCOUNT_UNVERIFIED' | 'LOOKUP_FAILED' | 'NO_JOB_FOUND' | 'AMBIGUOUS' | 'JOB_MISMATCH'; jobs?: number };
/** The READ-ONLY lookup. Only an exact, single, read-back-verified job is a success; every other answer, including an unusable or failed one, is a refusal that names why. */
async function lookup(d: ResolveDeps, ref: string): Promise<Found> {
  const { ctx, creds } = d;
  try { const tokens = await ctx.vault.loadTokens(); if (tokens === undefined) return { ok: false, reason: 'ACCOUNT_UNVERIFIED' }; await verifyExpectedAccount(ctx, creds, d.expectedAccountName, tokens.account_id); } catch { return { ok: false, reason: 'ACCOUNT_UNVERIFIED' }; }
  let nodes: unknown[];
  try { const n = rec((await query(ctx, creds, FIND, { term: ref })).data.jobs).nodes; if (!Array.isArray(n)) return { ok: false, reason: 'LOOKUP_FAILED' }; nodes = n; } catch { return { ok: false, reason: 'LOOKUP_FAILED' }; }
  const hits: string[] = [];
  for (const raw of nodes) {
    const n = rec(raw);
    if (typeof n.id !== 'string' || !JOB_ID.test(n.id) || typeof n.title !== 'string') return { ok: false, reason: 'LOOKUP_FAILED' };   // an answer that cannot be read is not "no job"
    if (n.title.includes(ref)) hits.push(n.id);
  }
  if (nodes.length >= PAGE) return { ok: false, reason: 'AMBIGUOUS', jobs: hits.length };   // a full page cannot prove that there is only one
  if (hits.length === 0) return { ok: false, reason: 'NO_JOB_FOUND', jobs: 0 };
  if (hits.length > 1) return { ok: false, reason: 'AMBIGUOUS', jobs: hits.length };
  let job: Record<string, unknown>;
  try { const j = (await query(ctx, creds, READ, { id: hits[0] })).data.job; if (typeof j !== 'object' || j === null) return { ok: false, reason: 'LOOKUP_FAILED', jobs: 1 }; job = rec(j); } catch { return { ok: false, reason: 'LOOKUP_FAILED', jobs: 1 }; }
  const status = typeof job.jobStatus === 'string' ? job.jobStatus : undefined;
  if (job.id !== hits[0] || typeof job.title !== 'string' || !job.title.includes(ref) || typeof job.instructions !== 'string' || !job.instructions.includes(ref) || status === undefined || /archiv|cancel|closed/i.test(status)) return { ok: false, reason: 'JOB_MISMATCH', jobs: 1 };
  return { ok: true, jobId: hits[0], jobs: 1 };
}

const view = (t: Extract<Top, { kind: 'entry' }>): Pick<ResolveResult, 'state' | 'step' | 'idsHeld'> => ({ state: t.entry.state, step: t.gen, idsHeld: t.entry.clientId !== undefined && t.entry.propertyId !== undefined });

export async function resolveBooking(d: ResolveDeps, ref: string, mode: 'dry-run' | 'adopt'): Promise<ResolveResult> {
  const base: ResolveResult = { ref, mode, outcome: 'refused' };
  const refuse = (reason: ResolveReason, more: Partial<ResolveResult> = {}): ResolveResult => ({ ...base, ...more, outcome: 'refused', reason });
  if (typeof ref !== 'string' || !REF.test(ref)) return refuse('BAD_REF');
  const { ctx } = d;
  /** What is decided once the chain has been read: the same steps for the dry run (no lock) and for the adoption (under both locks). */
  const decide = async (held: LockHandle | undefined): Promise<ResolveResult> => {
    const top = await readTop(ctx, ref);
    if (top.kind === 'none') return refuse('NO_ENTRY');
    if (top.kind === 'unreadable') return refuse('LEDGER_UNREADABLE');
    const shown = view(top);
    if (top.entry.state === 'created') return { ...base, ...shown, outcome: 'already_created' };   // finished (perhaps by an earlier --adopt): nothing to do, nothing is looked up
    if (top.entry.state !== 'pending' && top.entry.state !== 'client_created') return refuse('NOT_UNRESOLVED', shown);
    const f = await lookup(d, ref);
    if (!f.ok) return refuse(f.reason, { ...shown, ...(f.jobs === undefined ? {} : { jobsFound: f.jobs }) });
    if (mode === 'dry-run' || held === undefined) return { ...base, ...shown, outcome: 'eligible', jobsFound: 1, verified: true };
    // ---- adoption: one new generation, published (never replacing a name), after both locks are checked
    const next = top.gen + 1; if (next > MAX_GENERATION) return refuse('LEDGER_FULL', { ...shown, jobsFound: 1, verified: true });
    const entry = { state: 'created', ...(top.entry.clientId === undefined ? {} : { clientId: top.entry.clientId }), ...(top.entry.propertyId === undefined ? {} : { propertyId: top.entry.propertyId }), jobId: f.jobId };
    const text = JSON.stringify({ version: 2, marker: ref, gen: next, entry });
    const check = parseLedgerGeneration(text, ref, next); if (check === undefined || check.state !== 'created' || check.jobId !== f.jobId) return refuse('WRITE_FAILED', { ...shown, jobsFound: 1, verified: true });   // what is about to be written must be readable by the booking code
    held.assertHeld();
    let outcome: 'published' | 'exists'; try { outcome = await ctx.vault.publishBlob(`${baseOf(ref)}.${next}`, text, () => held.assertHeld()); } catch (e) { return refuse(e instanceof JobberError && e.code === 'LOCK_LOST' ? 'LOCK_LOST' : 'WRITE_FAILED', { ...shown, jobsFound: 1, verified: true }); }
    if (outcome === 'exists') return refuse('CONFLICT', { ...shown, jobsFound: 1, verified: true });   // another writer got there first: its file is untouched
    const back = await readTop(ctx, ref);
    if (back.kind !== 'entry' || back.gen !== next || back.entry.state !== 'created' || back.entry.jobId !== f.jobId) return refuse('VERIFY_FAILED', { ...shown, jobsFound: 1, verified: true });
    return { ...base, ...shown, outcome: 'adopted', jobsFound: 1, verified: true };
  };
  try {
    if (mode === 'dry-run') return await decide(undefined);
    const wait = d.lockWaitMs ?? 30_000;
    return await ctx.vault.withLock(IDENTITY_LOCK, (outer) => ctx.vault.withLock(keyLockOf(ref), (inner) => decide({ assertHeld(): void { outer.assertHeld(); inner.assertHeld(); } }), wait), wait);
  } catch (e) {
    const code = e instanceof JobberError ? e.code : undefined;   // only the fixed code of an error is looked at, never its message
    return refuse(code === 'TIMEOUT' ? 'LOCKED' : code === 'LOCK_LOST' ? 'LOCK_LOST' : code === 'LEDGER_UNREADABLE' ? 'LEDGER_UNREADABLE' : 'WRITE_FAILED');
  }
}

const WHY: Record<ResolveReason, string> = {
  BAD_REF: 'the reference is not in the form DREWTEST- and 12 capital hex characters', NO_ENTRY: 'the ledger has no entry for this reference', LEDGER_UNREADABLE: 'the ledger entry could not be read as exactly what the booking code writes',
  NOT_UNRESOLVED: 'the entry is not waiting for a person (it was cleared)', ACCOUNT_UNVERIFIED: 'the connected Jobber account could not be confirmed as the expected test account', LOOKUP_FAILED: 'Jobber did not give a readable answer',
  NO_JOB_FOUND: 'no job in Jobber carries this reference', AMBIGUOUS: 'more than one job could carry this reference (or the search page was full), so one cannot be chosen', JOB_MISMATCH: 'the one job found does not carry the reference in its title and instructions, or it is archived, cancelled or closed',
  LOCKED: 'a booking or a keyring change holds the lock', LOCK_LOST: 'a lock was lost before the write', LEDGER_FULL: 'the ledger chain is at its last generation', CONFLICT: 'another writer published that generation first', WRITE_FAILED: 'the ledger could not be written', VERIFY_FAILED: 'the new generation could not be read back as expected',
};
/** The result as words and numbers only. Pure. */
export function resolveLines(r: ResolveResult): string[] {
  const out = [r.mode === 'dry-run' ? 'resolve: DRY RUN (nothing is changed in the ledger or in Jobber)' : 'resolve --adopt (one ledger generation at most; nothing is changed in Jobber)', `reference: ${r.ref}`];
  if (r.state !== undefined) out.push(`ledger: state ${r.state}${r.step === undefined ? '' : `, step ${r.step}`}${r.idsHeld === undefined ? '' : `, client and property ids held: ${r.idsHeld ? 'yes' : 'no'}`}`);
  if (r.jobsFound !== undefined) out.push(`Jobber (read only): jobs carrying this reference: ${r.jobsFound}${r.verified === true ? '; read back by id: the reference is in its title and instructions, and it is not archived, cancelled or closed' : ''}`);
  if (r.outcome === 'eligible') out.push('result: ELIGIBLE. Running again with --adopt --confirm would record this one job in the ledger. It would send nothing to Jobber.');
  else if (r.outcome === 'adopted') out.push('result: ADOPTED. The ledger now shows this booking as created. Nothing was sent to Jobber. Check the job in Jobber yourself: this tool did not compare it with what the caller said.');
  else if (r.outcome === 'already_created') out.push('result: ALREADY CREATED. Nothing to do; nothing was looked up or written.');
  else out.push(`result: REFUSED (${r.reason}): ${WHY[r.reason as ResolveReason]}. Nothing was changed.`);
  return out;
}

const USAGE = 'usage: --ref DREWTEST-XXXXXXXXXXXX --expect-name "<the Jobber test account name>" [--adopt --confirm]   (there is no --clear)';
/** The command line, as a function (the command file only passes the real vault and the real console in). Returns the exit code: 0 eligible, adopted or already created; 1 refused; 2 bad usage (nothing read, looked up or written). */
export async function runResolve(argv: string[], deps: { ctx: Ctx; creds: Credentials; say: (s: string) => void; lockWaitMs?: number }): Promise<number> {
  const { say } = deps; const flags = new Set(argv.filter((a, i) => a.startsWith('--') && !(i > 0 && (argv[i - 1] === '--ref' || argv[i - 1] === '--expect-name'))));
  if (argv.includes('--clear')) { say('refused: --clear does not exist. An entry is never cleared, reset or deleted by this tool. ' + USAGE); return 2; }
  for (const f of flags) if (!['--ref', '--expect-name', '--adopt', '--confirm'].includes(f)) { say(`refused: unknown option ${f.slice(0, 20)}. ${USAGE}`); return 2; }
  const val = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined; };
  const ref = val('--ref'); const name = val('--expect-name'); const adopt = argv.includes('--adopt'); const confirm = argv.includes('--confirm');
  if (ref === undefined || name === undefined || name.trim() === '') { say(`refused: --ref and --expect-name are both required. ${USAGE}`); return 2; }
  if (confirm && !adopt) { say(`refused: --confirm only goes with --adopt. ${USAGE}`); return 2; }
  if (adopt && !confirm) { say('refused: --adopt changes the ledger and needs --confirm as well. Nothing was read or changed. Run without --adopt first to see what it would do.'); return 2; }
  const r = await resolveBooking({ ctx: deps.ctx, creds: deps.creds, expectedAccountName: name, ...(deps.lockWaitMs === undefined ? {} : { lockWaitMs: deps.lockWaitMs }) }, ref, adopt ? 'adopt' : 'dry-run');
  for (const l of resolveLines(r)) say(l);
  return r.outcome === 'refused' ? (r.reason === 'BAD_REF' ? 2 : 1) : 0;
}
