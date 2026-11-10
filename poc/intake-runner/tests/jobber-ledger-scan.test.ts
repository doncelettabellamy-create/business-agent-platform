// The read-only ledger scan the keyring rotation relies on (Step 3a, slice C; offline). A temporary folder per test, the test protector (reversible, NOT secure), made-up keys: nothing touches the real private folder.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVault } from '../src/jobber-connector.ts';
import type { Protector } from '../src/jobber-connector.ts';
import { markerFor } from '../src/jobber-booking.ts';
import { ledgerUnresolved, scanLedger } from '../src/jobber-ledger-scan.ts';

const fakeProtector: Protector = { protect: async (p) => `P1:${Buffer.from([...Buffer.from(p)].reverse()).toString('hex')}`, unprotect: async (b) => Buffer.from(Buffer.from(b.slice(3), 'hex').reverse()).toString() };
const root = mkdtempSync(join(tmpdir(), 'ledger-scan-')); after(() => rmSync(root, { recursive: true, force: true }));
const fresh = (): string => mkdtempSync(join(root, 'p-'));
const keyOf = (n: number): string => `fast2-${String(n).padStart(24, '0')}`;
const markerOf = (n: number): string => markerFor(keyOf(n));
const baseOf = (n: number): string => `jobber-booking-ledger-${markerOf(n).toLowerCase()}`;
type Entry = { state: string; clientId?: string; propertyId?: string; jobId?: string };
const CREATED: Entry = { state: 'created', clientId: 'CLIENT-1', propertyId: 'PROP-1', jobId: 'JOB-1' };
const PENDING: Entry = { state: 'pending' };
const CLIENT: Entry = { state: 'client_created', clientId: 'CLIENT-1', propertyId: 'PROP-1' };
const NONE: Entry = { state: 'none' };
/** Writes generation `gen` of key `n` the way the booking code does (protected, version 2). */
async function put(dir: string, n: number, gen: number, entry: Entry, over: Record<string, unknown> = {}): Promise<void> { writeFileSync(join(dir, `${baseOf(n)}.${gen}.enc`), await fakeProtector.protect(JSON.stringify({ version: 2, marker: markerOf(n), gen, entry, ...over }))); }
const chain = async (dir: string, n: number, entries: Entry[]): Promise<void> => { for (let g = 0; g < entries.length; g++) await put(dir, n, g + 1, entries[g]); };
const scan = (dir: string) => scanLedger(createVault(dir, fakeProtector));
const bytes = (dir: string): Record<string, string> => Object.fromEntries(readdirSync(dir).sort().map((f) => [f, readFileSync(join(dir, f), 'utf8')]));

test('SCAN an empty folder is "none"; finished keys (created, cleared) are "none"; only the highest generation of a key counts', async () => {
  const d = fresh(); assert.deepEqual(await scan(d), { chains: 0, created: 0, cleared: 0, pending: 0, clientCreated: 0, unreadable: 0, legacy: 'absent', verdict: 'none' });
  await chain(d, 1, [PENDING, { ...CLIENT }, { state: 'pending', clientId: 'CLIENT-1', propertyId: 'PROP-1' }, CREATED]); await chain(d, 2, [PENDING, NONE]); await chain(d, 3, [CREATED]);
  assert.deepEqual(await scan(d), { chains: 3, created: 2, cleared: 1, pending: 0, clientCreated: 0, unreadable: 0, legacy: 'absent', verdict: 'none' });
});

test('SCAN unresolved bookings are "some": a key left pending, and a key left with a client but no job, each block on their own', async () => {
  for (const [name, entry, counts] of [['pending', PENDING, { pending: 1, clientCreated: 0 }], ['client_created', CLIENT, { pending: 0, clientCreated: 1 }]] as const) {
    const d = fresh(); await chain(d, 1, [CREATED]); await chain(d, 2, [entry]); const s = await scan(d);
    assert.deepEqual([s.verdict, s.pending, s.clientCreated, s.created, s.chains], ['some', counts.pending, counts.clientCreated, 1, 2], name);
  }
});

test('SCAN anything it cannot read as exactly what the booking code writes is "unknown", never "none": a gap in the numbers, a file that does not decode, the wrong marker or number inside, a bad entry, an extra field, a chain beyond 99, and a name it does not recognise', async () => {
  const cases: Array<[string, (d: string) => Promise<void>]> = [
    ['a gap', async (d) => { await put(d, 1, 1, CREATED); await put(d, 1, 3, CREATED); }],
    ['a chain that does not start at 1', async (d) => { await put(d, 1, 2, CREATED); }],
    ['an undecodable top generation', async (d) => { await chain(d, 1, [CREATED]); writeFileSync(join(d, `${baseOf(1)}.2.enc`), 'garbage'); }],
    ['not JSON', async (d) => { writeFileSync(join(d, `${baseOf(1)}.1.enc`), await fakeProtector.protect('not json')); }],
    ['another key\'s marker inside', async (d) => { await put(d, 1, 1, CREATED, { marker: markerOf(2) }); }],
    ['another generation number inside', async (d) => { await put(d, 1, 1, CREATED, { gen: 2 }); }],
    ['an unknown entry state', async (d) => { await put(d, 1, 1, { state: 'finished' }); }],
    ['an extra field in the entry', async (d) => { await put(d, 1, 1, { ...CREATED, note: 'x' } as Entry); }],
    ['created with no job', async (d) => { await put(d, 1, 1, { state: 'created', clientId: 'C-1', propertyId: 'P-1' }); }],
    ['version 1 in a chain file', async (d) => { await put(d, 1, 1, CREATED, { version: 1 }); }],
    ['a chain of 100', async (d) => { await put(d, 1, 100, CREATED); }],
    ['a name it does not recognise', async (d) => { writeFileSync(join(d, 'jobber-booking-ledger-whatever.enc'), 'x'); }],
    ['a marker of the wrong shape', async (d) => { writeFileSync(join(d, 'jobber-booking-ledger-drewtest-ZZZ.1.enc'), 'x'); }],
  ];
  for (const [name, setup] of cases) { const d = fresh(); await setup(d); const s = await scan(d); assert.equal(s.verdict, 'unknown', name); assert.ok(s.unreadable >= 1, name); assert.equal(await ledgerUnresolved(createVault(d, fakeProtector)), 'unknown', name); }
});

test('SCAN "some" is not hidden by something unreadable, and unrelated files, unfinished temporary files and other keyring files are ignored', async () => {
  const d = fresh(); await chain(d, 1, [PENDING]); writeFileSync(join(d, `${baseOf(2)}.1.enc`), 'garbage');
  const s = await scan(d); assert.deepEqual([s.verdict, s.pending, s.unreadable], ['some', 1, 1]);
  const e = fresh(); await chain(e, 1, [CREATED]); writeFileSync(join(e, `${baseOf(2)}.1.enc.0123456789abcdef.tmp`), 'half a write'); writeFileSync(join(e, 'booking-identity-keys.1.enc'), 'x'); writeFileSync(join(e, 'tokens.enc'), 'x'); writeFileSync(join(e, 'booking-identity.lock'), 'x');
  assert.equal((await scan(e)).verdict, 'none');
});

test('SCAN the older single-file ledger: absent, all finished, a key left pending or half done, and every damaged form', async () => {
  const withLegacy = async (text: string | undefined): Promise<ReturnType<typeof scan>> => { const d = fresh(); if (text !== undefined) await createVault(d, fakeProtector).saveBlob('jobber-booking-ledger', text); return scan(d); };
  const legacy = (entries: unknown, version: unknown = 1): string => JSON.stringify({ version, entries });
  assert.deepEqual((await withLegacy(undefined)).legacy, 'absent');
  const ok = await withLegacy(legacy({ [markerOf(1)]: CREATED, [markerOf(2)]: CREATED })); assert.deepEqual([ok.legacy, ok.verdict], ['resolved', 'none']);
  for (const e of [PENDING, CLIENT]) { const s = await withLegacy(legacy({ [markerOf(1)]: CREATED, [markerOf(2)]: e })); assert.deepEqual([s.legacy, s.verdict], ['unresolved', 'some'], e.state); }
  for (const [name, text] of [['not JSON', 'not json'], ['version 2', legacy({}, 2)], ['entries missing', JSON.stringify({ version: 1 })], ['entries an array', legacy([])], ['a bad entry', legacy({ [markerOf(1)]: { state: 'created' } })], ['the none state (never written by the old code)', legacy({ [markerOf(1)]: NONE })]] as const) {
    const s = await withLegacy(text); assert.deepEqual([s.legacy, s.verdict], ['unreadable', 'unknown'], name);
  }
  const d = fresh(); writeFileSync(join(d, 'jobber-booking-ledger.enc'), 'undecodable'); const u = await scan(d); assert.deepEqual([u.legacy, u.verdict], ['unreadable', 'unknown'], 'a file the protector cannot decode');
  const both = fresh(); await chain(both, 1, [PENDING]); writeFileSync(join(both, 'jobber-booking-ledger.enc'), 'undecodable'); assert.equal((await scan(both)).verdict, 'some');
});

test('SCAN a folder that cannot be listed, a vault that throws, and a vault that lies about its generations are "unknown", never "none", and the scan never throws', async () => {
  assert.equal((await scanLedger(createVault(join(root, 'does-not-exist'), fakeProtector))).verdict, 'unknown'); assert.equal(await ledgerUnresolved(createVault(join(root, 'does-not-exist'), fakeProtector)), 'unknown');
  const d = fresh(); await chain(d, 1, [CREATED]); const v = createVault(d, fakeProtector);
  assert.equal(await ledgerUnresolved({ dir: d, hasBlob: () => false, loadBlob: async () => { throw new Error('boom'); }, generations: v.generations }), 'unknown');
  assert.equal(await ledgerUnresolved({ dir: d, hasBlob: () => { throw new Error('boom'); }, loadBlob: v.loadBlob, generations: v.generations }), 'unknown');
  assert.equal(await ledgerUnresolved({ dir: d, hasBlob: v.hasBlob, loadBlob: v.loadBlob, generations: () => { throw new Error('boom'); } }), 'unknown');
  assert.equal(await ledgerUnresolved({ dir: d, hasBlob: v.hasBlob, loadBlob: v.loadBlob, generations: () => [1, 1] }), 'unknown');
});

test('SCAN changes nothing and reveals nothing: every file is byte for byte as it was, and the result holds only counts and words (no marker, job id, client id or name)', async () => {
  const d = fresh(); await chain(d, 1, [PENDING, CREATED]); await chain(d, 2, [PENDING]); await createVault(d, fakeProtector).saveBlob('jobber-booking-ledger', JSON.stringify({ version: 1, entries: { [markerOf(3)]: CREATED } }));
  const before = bytes(d); const s = await scan(d); assert.deepEqual(bytes(d), before); assert.equal(s.verdict, 'some');
  const all = JSON.stringify(s); for (const secret of [markerOf(1), markerOf(2), markerOf(3), 'JOB-1', 'CLIENT-1', 'PROP-1', 'DREWTEST']) assert.ok(!all.includes(secret), secret);
  assert.deepEqual(Object.keys(s).sort(), ['chains', 'cleared', 'clientCreated', 'created', 'legacy', 'pending', 'unreadable', 'verdict']);
});

test('SCAN source: it only reads (one directory listing, no write, no delete, no network, no environment, no log), and its only imports are the file system and the ledger readers of the booking module', () => {
  const src = readFileSync(new URL('../src/jobber-ledger-scan.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.deepEqual([...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]), ['node:fs', './jobber-booking.ts']); assert.ok(/^import \{ readdirSync \} from 'node:fs';/m.test(src));
  for (const word of ['writeFile', 'appendFile', 'rmSync', 'unlink', 'rename', 'mkdir', 'copyFile', 'publishBlob', 'saveBlob', 'withLock', 'process.env', 'console.', 'fetch(', 'diag(', 'setTimeout', 'createWriteStream', 'linkSync']) assert.ok(!src.includes(word), word);
  assert.equal([...src.matchAll(/readdirSync\(/g)].length, 1);
});
