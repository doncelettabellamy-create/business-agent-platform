// The founder's read-only PENDING-BOOKING REPORT (offline). A temporary folder per test, the test protector (reversible, NOT secure), made-up ids: nothing touches the real private folder and nothing calls a provider.
// It lists each unresolved booking (reference, state, step, whether Jobber ids are held) and nothing else; it changes, retries, resolves and clears nothing.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVault } from '../src/jobber-connector.ts';
import type { Protector } from '../src/jobber-connector.ts';
import { markerFor } from '../src/jobber-booking.ts';
import { ledgerUnresolved, pendingReport, scanLedger } from '../src/jobber-ledger-scan.ts';
import { pendingLines, runSetup } from '../src/booking-identity-setup.ts';

const fakeProtector: Protector = { protect: async (p) => `P1:${Buffer.from([...Buffer.from(p)].reverse()).toString('hex')}`, unprotect: async (b) => Buffer.from(Buffer.from(b.slice(3), 'hex').reverse()).toString() };
const root = mkdtempSync(join(tmpdir(), 'pending-report-')); after(() => rmSync(root, { recursive: true, force: true }));
const fresh = (): string => mkdtempSync(join(root, 'p-'));
const keyOf = (n: number): string => `fast2-${String(n).padStart(24, '0')}`;
const markerOf = (n: number): string => markerFor(keyOf(n));
const baseOf = (n: number): string => `jobber-booking-ledger-${markerOf(n).toLowerCase()}`;
type Entry = { state: string; clientId?: string; propertyId?: string; jobId?: string };
const CREATED: Entry = { state: 'created', clientId: 'CLIENT-SECRETID-1', propertyId: 'PROP-SECRETID-1', jobId: 'JOB-SECRETID-1' };
const PENDING: Entry = { state: 'pending' };
const PENDING_IDS: Entry = { state: 'pending', clientId: 'CLIENT-SECRETID-2', propertyId: 'PROP-SECRETID-2' };
const CLIENT: Entry = { state: 'client_created', clientId: 'CLIENT-SECRETID-3', propertyId: 'PROP-SECRETID-3' };
const NONE: Entry = { state: 'none' };
async function put(dir: string, n: number, gen: number, entry: Entry, over: Record<string, unknown> = {}): Promise<void> { writeFileSync(join(dir, `${baseOf(n)}.${gen}.enc`), await fakeProtector.protect(JSON.stringify({ version: 2, marker: markerOf(n), gen, entry, ...over }))); }
const chain = async (dir: string, n: number, entries: Entry[]): Promise<void> => { for (let g = 0; g < entries.length; g++) await put(dir, n, g + 1, entries[g]); };
const vaultOf = (dir: string) => createVault(dir, fakeProtector);
const bytes = (dir: string): Record<string, string> => Object.fromEntries(readdirSync(dir).sort().map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
async function report(dir: string): Promise<{ code: number; out: string[] }> {
  const out: string[] = []; const v = vaultOf(dir);
  const code = await runSetup(['pending'], { vault: v, say: (s) => out.push(s), pending: () => pendingReport(v) });
  return { code, out };
}

test('PENDING REPORT an empty folder, and a ledger of only finished bookings, say none and exit 0 with nothing listed', async () => {
  const empty = fresh(); const a = await report(empty);
  assert.equal(a.code, 0); assert.ok(a.out.some((l) => l.includes('ledger verdict: none unresolved')) && a.out.some((l) => l.includes('unresolved bookings listed: 0')));
  const d = fresh(); await chain(d, 1, [PENDING, CREATED]); await chain(d, 2, [PENDING, NONE]);
  const b = await report(d); assert.equal(b.code, 0);
  assert.ok(b.out.some((l) => l.includes('1 created, 1 cleared')), 'finished keys are counted');
  assert.ok(!b.out.some((l) => l.includes('DREWTEST-')), 'a finished booking is never listed');
});

test('PENDING REPORT each unresolved booking is listed with its reference, state, step and whether ids are held; sorted; exit 1; a finished one beside them is not listed', async () => {
  const d = fresh();
  await chain(d, 1, [CREATED]); await chain(d, 5, [PENDING]); await chain(d, 3, [PENDING, CLIENT, PENDING_IDS]); await chain(d, 4, [PENDING, CLIENT]);
  const { code, out } = await report(d);
  assert.equal(code, 1); assert.ok(out.some((l) => l.includes('ledger verdict: SOME UNRESOLVED')) && out.some((l) => l.includes('unresolved bookings listed: 3')));
  const rows = out.filter((l) => /^\s+\d+\. DREWTEST-/.test(l));
  assert.equal(rows.length, 3);
  const refs = rows.map((l) => /(DREWTEST-[0-9A-F]{12})/.exec(l)![1]); assert.deepEqual(refs, [...refs].sort(), 'sorted by reference');
  const row = (n: number): string => rows.find((l) => l.includes(markerOf(n)))!;
  assert.match(row(5), /state: pending {3}ledger step: 1 {3}client and property ids held: no {3}job id held: no/, 'pending, no ids');
  assert.match(row(3), /state: pending {3}ledger step: 3 {3}client and property ids held: yes {3}job id held: no/, 'pending again after the client: the ids are held, the job is not known');
  assert.match(row(4), /state: client_created {3}ledger step: 2 {3}client and property ids held: yes {3}job id held: no/, 'client created, no job');
  assert.ok(!rows.some((l) => l.includes(markerOf(1))), 'the finished booking is not listed');
  assert.ok(out.some((l) => /search for the reference in the Jobber test account/.test(l)));
});

test('PENDING REPORT it shows words only: no Jobber id, no key, no name, address or number, and no sentence that says what happened to a booking', async () => {
  const d = fresh(); await chain(d, 1, [PENDING, CLIENT, PENDING_IDS]); await chain(d, 2, [CREATED]);
  const { out } = await report(d); const all = out.join('\n');
  assert.ok(!/SECRETID|CLIENT-|PROP-|JOB-/.test(all), 'no Jobber id');
  assert.ok(!all.includes(keyOf(1)) && !/fast2-/.test(all), 'no booking key');
  assert.ok(!/[0-9]{3}[-. ]?[0-9]{3}[-. ]?[0-9]{4}/.test(all.replace(/DREWTEST-[0-9A-F]{12}/g, '')), 'no phone-like number');
  assert.ok(!/@/.test(all), 'no email address');
  assert.ok(!/(was|is|has been|were) (booked|not booked|created|lost|duplicated|retried|resolved|cleared)|no job exists|job exists in jobber|has a job/i.test(all), 'it never says what happened');
  assert.ok(/does not say whether a job exists/.test(all), 'and it says plainly that it does not know');
  assert.ok(out.every((l) => !/--confirm|retry now|clear it|resolve it/i.test(l)), 'it offers no action');
  const lines = pendingLines(await pendingReport(vaultOf(d))); assert.ok(lines.every((l) => typeof l === 'string'));
});

test('PENDING REPORT it is read-only: the folder is byte-for-byte the same after a report, and the scan the keyring commands use is unchanged in shape and answer', async () => {
  const d = fresh(); await chain(d, 1, [PENDING, CLIENT]); await chain(d, 2, [CREATED]); await chain(d, 3, [PENDING, NONE]);
  const before = bytes(d);
  await report(d); await report(d); await pendingReport(vaultOf(d));
  assert.deepEqual(bytes(d), before, 'nothing written, removed or changed');
  const s = await scanLedger(vaultOf(d));
  assert.deepEqual(s, { chains: 3, created: 1, cleared: 1, pending: 0, clientCreated: 1, unreadable: 0, legacy: 'absent', verdict: 'some' }, 'the scan result has exactly its old shape');
  assert.equal(await ledgerUnresolved(vaultOf(d)), 'some');
  assert.deepEqual((await pendingReport(vaultOf(d))).scan, s, 'the report is the same scan');
});

test('PENDING REPORT what cannot be read is UNKNOWN and exit 1: it is not listed, not assumed finished, and a readable unresolved booking beside it is still listed', async () => {
  const d = fresh(); await chain(d, 1, [CREATED]); writeFileSync(join(d, `${baseOf(2)}.1.enc`), 'garbage'); await chain(d, 3, [PENDING]);
  const { code, out } = await report(d);
  assert.equal(code, 1); assert.ok(out.some((l) => l.includes('ledger verdict: SOME UNRESOLVED')), 'an unresolved booking outranks unknown');
  assert.ok(out.some((l) => l.includes(markerOf(3))) && !out.some((l) => /^\s+\d+\. /.test(l) && l.includes(markerOf(2))), 'the unreadable chain is not listed as a booking');
  assert.ok(out.some((l) => l.includes('unreadable ledger entries: 1')));
  const e = fresh(); writeFileSync(join(e, `${baseOf(1)}.1.enc`), 'garbage');
  const u = await report(e); assert.equal(u.code, 1); assert.ok(u.out.some((l) => l.includes('UNKNOWN')) && u.out.some((l) => /NOT assumed finished/.test(l)));
  assert.ok(!u.out.some((l) => /DREWTEST-/.test(l)), 'nothing is invented for an unreadable entry');
  const gone = await report(join(root, 'does-not-exist')); assert.equal(gone.code, 1, 'a folder that cannot be listed is unknown, never empty'); assert.ok(gone.out.some((l) => l.includes('UNKNOWN')));
});

test('PENDING REPORT a scan that fails part-way is UNKNOWN with nothing listed (never "none"), and the command exits 1 without the error text', async () => {
  const d = fresh(); await chain(d, 1, [PENDING]);
  const broken = { dir: d, hasBlob: (): boolean => { throw new Error('boom SECRET'); }, loadBlob: async (): Promise<string | undefined> => undefined, generations: (): number[] => [1] };
  const r = await pendingReport(broken); assert.equal(r.scan.verdict, 'unknown'); assert.deepEqual(r.items, []); assert.ok(r.scan.unreadable >= 1);
  const out: string[] = []; const code = await runSetup(['pending'], { vault: vaultOf(d), say: (s) => out.push(s), pending: () => pendingReport(broken) });
  assert.equal(code, 1); assert.ok(out.some((l) => l.includes('UNKNOWN')) && !out.join('\n').includes('SECRET') && !out.some((l) => /DREWTEST-/.test(l)));
});

test('PENDING REPORT the older single-file ledger with an unresolved entry is reported as such, without listing it', async () => {
  const d = fresh(); writeFileSync(join(d, 'jobber-booking-ledger.enc'), await fakeProtector.protect(JSON.stringify({ version: 1, entries: { 'fast2-aaaaaaaaaaaaaaaaaaaaaaaa': { state: 'pending' } } })));
  const { code, out } = await report(d);
  assert.equal(code, 1); assert.ok(out.some((l) => l.includes('older single-file ledger: unresolved')) && out.some((l) => /cannot be listed here/.test(l)));
  assert.ok(!out.join('\n').includes('fast2-'), 'the old ledger key is not shown');
});

test('PENDING REPORT the command refuses without a ledger reader, survives a scan that throws, and the usage line names it', async () => {
  const out: string[] = []; const v = vaultOf(fresh());
  assert.equal(await runSetup(['pending'], { vault: v, say: (s) => out.push(s) }), 2); assert.match(out.at(-1)!, /no way to read the booking ledger/);
  const o2: string[] = []; assert.equal(await runSetup(['pending'], { vault: v, say: (s) => o2.push(s), pending: async () => { throw new Error('boom SECRET'); } }), 1);
  assert.deepEqual(o2, ['failed: the ledger could not be scanned (nothing was changed)'], 'a fixed sentence, never the error text');
  const o3: string[] = []; assert.equal(await runSetup([], { vault: v, say: (s) => o3.push(s) }), 2); assert.match(o3.at(-1)!, /usage: status \| pending \| create --confirm/);
});

test('PENDING REPORT source: the report code can only read (no write, remove, rename, lock, publish or Jobber call), and the other commands keep their behavior', () => {
  const scan = readFileSync(new URL('../src/jobber-ledger-scan.ts', import.meta.url), 'utf8');
  assert.ok(!/writeFile|appendFile|saveBlob|publishBlob|unlink|rmSync|renameSync|withLock|fetch\(|https?:/.test(scan.replace(/\/\/.*$/gm, '').replace(/\/\*\*[\s\S]*?\*\//g, '')), 'the scan module has no way to write, lock or call out');
  const setup = readFileSync(new URL('../src/booking-identity-setup.ts', import.meta.url), 'utf8');
  const branch = /if \(cmd === 'pending'\) \{[\s\S]*?\n  \}\n/.exec(setup)![0];
  assert.ok(!/publishBlob|saveBlob|withLock|createKeyring|rotateKeyring|unlink|fetch\(/.test(branch), 'the pending command calls only the reader');
  const main = readFileSync(new URL('../src/booking-identity-setup-main.ts', import.meta.url), 'utf8');
  assert.ok(/pending: \(\) => pendingReport\(vault\)/.test(main) && /unresolved: \(\) => ledgerUnresolved\(vault\)/.test(main));
  assert.ok(!/from '\.\/jobber-booking-run|bookTestVisit|from '\.\/fast-/.test(main), 'the command file does not reach the booking or call code');
});
