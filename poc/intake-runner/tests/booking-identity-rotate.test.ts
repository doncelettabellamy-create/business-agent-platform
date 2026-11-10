// Founder-run rotation of the booking-identity keyring (Step 3a; offline). A temporary folder per test, the test protector (reversible, NOT secure), made-up randomness: no real rotation happens, no real secret is made, and nothing touches the real private folder.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bookingIdentity, identitiesFor, KEYRING_BASE, loadKeyring } from '../src/booking-identity.ts';
import type { IdentityParts } from '../src/booking-identity.ts';
import { createKeyring, IDENTITY_LOCK, rotateKeyring, runSetup } from '../src/booking-identity-setup.ts';
import type { RotateOptions, RotateVault } from '../src/booking-identity-setup.ts';
import { createVault } from '../src/jobber-connector.ts';
import type { Protector } from '../src/jobber-connector.ts';

const fakeProtector: Protector = { protect: async (p) => `P1:${Buffer.from([...Buffer.from(p)].reverse()).toString('hex')}`, unprotect: async (b) => Buffer.from(Buffer.from(b.slice(3), 'hex').reverse()).toString() };
const root = mkdtempSync(join(tmpdir(), 'booking-identity-rotate-')); after(() => rmSync(root, { recursive: true, force: true }));
const fresh = (): string => mkdtempSync(join(root, 'p-'));
const bytes = (label: string): Buffer => createHash('sha256').update(`made-up randomness: ${label}`).digest();
const secretOf = (label: string): string => bytes(label).toString('base64url');
const rnd = (label: string) => (): Buffer => Buffer.from(bytes(label));
const NOW = Date.parse('2026-11-10T03:00:00.000Z'); const now = (): number => NOW;
const files = (dir: string): string[] => readdirSync(dir).sort();
const keyFiles = (dir: string): string[] => files(dir).filter((f) => f.startsWith(KEYRING_BASE));
const snapshot = (dir: string): Record<string, string> => Object.fromEntries(files(dir).filter((f) => f.endsWith('.enc')).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
const PARTS: IdentityParts = { phone: '5550100002', date: '2026-11-12', startTime: '10:00', street: '123 Invented Lane', zip: '90210' };
const opts = (label: string, expectGeneration: number, more: Partial<RotateOptions> = {}): RotateOptions => ({ expectGeneration, random: rnd(label), now, lockWaitMs: 2000, ...more });
/** A folder with generation 1 made by the real create command (secret "s1"). */
async function made(): Promise<{ dir: string; vault: ReturnType<typeof createVault> }> { const dir = fresh(); const vault = createVault(dir, fakeProtector); assert.ok((await createKeyring(vault, { random: rnd('s1') })).ok); return { dir, vault }; }
const unchanged = (dir: string, before: Record<string, string>, what: string): void => { assert.deepEqual(snapshot(dir), before, `${what}: no file added, changed or removed`); assert.deepEqual(files(dir).filter((f) => !f.endsWith('.enc') && !f.endsWith('.lock')), [], `${what}: no temporary file left`); };
const noSecret = (x: unknown, labels: string[]): void => { const all = typeof x === 'string' ? x : JSON.stringify(x); for (const l of labels) { const s = secretOf(l); assert.ok(!all.includes(s) && !all.includes(s.slice(0, 10)) && !all.includes(s.slice(-10)), `no secret "${l}" shown`); } };

test('ROTATE publishes generation n+1: a new current key, the old current key becomes the first retired key unchanged, nothing else moves, and the old key still finds what was booked under it', async () => {
  const { dir, vault } = await made(); const before = snapshot(dir); const oldKey = bookingIdentity(secretOf('s1'), PARTS);
  const r = await rotateKeyring(vault, opts('s2', 1)); assert.ok(r.ok);
  assert.deepEqual([r.gen, r.kid, r.retiredKid, r.retired], [2, 'k2', 'k1', 1]); assert.match(r.fingerprint, /^[0-9a-f]{4}$/);
  assert.deepEqual(keyFiles(dir), [`${KEYRING_BASE}.1.enc`, `${KEYRING_BASE}.2.enc`]);
  assert.equal(readFileSync(join(dir, `${KEYRING_BASE}.1.enc`), 'utf8'), before[`${KEYRING_BASE}.1.enc`], 'generation 1 is byte for byte the same');
  const loaded = await loadKeyring(vault); assert.ok(loaded.ok); assert.deepEqual(loaded.generations, [1, 2]);
  assert.deepEqual(loaded.keyring, { gen: 2, current: { kid: 'k2', secret: secretOf('s2') }, retired: [{ kid: 'k1', secret: secretOf('s1'), retired_at: '2026-11-10T03:00:00.000Z' }] });
  const ids = identitiesFor(loaded.keyring, PARTS); assert.equal(ids.aliases[0], oldKey, 'what was booked under the old key is found as the first alias'); assert.notEqual(ids.key, oldKey);
  noSecret(r, ['s1', 's2']); assert.deepEqual(files(dir).filter((f) => f.endsWith('.tmp')), []);
  assert.ok(!readFileSync(join(dir, `${KEYRING_BASE}.2.enc`), 'utf8').includes(secretOf('s2')), 'protected on disk');
});

test('ROTATE keeps every retired key, in order and with its own retirement time, and refuses to drop one: the sixth rotation (a fifth retired key already held) writes nothing', async () => {
  const { dir, vault } = await made(); let t = NOW;
  for (let n = 1; n <= 5; n++) { const r = await rotateKeyring(vault, opts(`s${n + 1}`, n, { now: () => (t += 60_000) })); assert.ok(r.ok, `rotation ${n}`); assert.equal(r.retired, n); }
  const loaded = await loadKeyring(vault); assert.ok(loaded.ok);
  assert.deepEqual(loaded.keyring.retired.map((x) => x.kid), ['k5', 'k4', 'k3', 'k2', 'k1']); assert.equal(loaded.keyring.current.kid, 'k6');
  assert.deepEqual(loaded.keyring.retired.map((x) => x.retired_at), [NOW + 5 * 60_000, NOW + 4 * 60_000, NOW + 3 * 60_000, NOW + 2 * 60_000, NOW + 60_000].map((x) => new Date(x).toISOString()), 'each key keeps the time it was retired');
  assert.deepEqual(loaded.keyring.retired.map((x) => x.secret), ['s5', 's4', 's3', 's2', 's1'].map(secretOf));
  const before = snapshot(dir); const r = await rotateKeyring(vault, opts('s7', 6));
  assert.deepEqual(r, { ok: false, reason: 'RETENTION_LIMIT' }); unchanged(dir, before, 'at the retention limit');
});

test('ROTATE needs the generation the founder named: any other number, or none, refuses, so two operators cannot rotate twice by mistake', async () => {
  const { dir, vault } = await made(); const before = snapshot(dir);
  for (const g of [2, 0, -1, 1.5, Number.NaN, 99]) assert.deepEqual(await rotateKeyring(vault, opts('s2', g)), { ok: false, reason: 'STALE_EXPECTATION' }, String(g));
  unchanged(dir, before, 'wrong expectation');
  assert.ok((await rotateKeyring(vault, opts('s2', 1))).ok);
  const after2 = snapshot(dir); assert.deepEqual(await rotateKeyring(vault, opts('s3', 1)), { ok: false, reason: 'STALE_EXPECTATION' }, 'the same command run again is refused'); unchanged(dir, after2, 'repeat');
});

test('ROTATE refuses over a keyring that is missing or invalid and writes nothing: no keyring, malformed, gapped, a generation that does not follow, the last generation', async () => {
  { const dir = fresh(); assert.deepEqual(await rotateKeyring(createVault(dir, fakeProtector), opts('s2', 1)), { ok: false, reason: 'NO_KEYRING' }); assert.deepEqual(files(dir), []); }
  const gen = (n: number, current: { kid: string; secret: string }, retired: unknown[] = []): string => JSON.stringify({ version: 1, gen: n, current, retired });
  const cases: Array<[string, string, (v: ReturnType<typeof createVault>) => Promise<void>]> = [
    ['malformed', 'MALFORMED', async (v) => { await v.publishBlob(`${KEYRING_BASE}.1`, 'garbage', () => undefined); }],
    ['gap', 'GAP', async (v) => { await v.publishBlob(`${KEYRING_BASE}.1`, gen(1, { kid: 'k1', secret: secretOf('s1') }), () => undefined); await v.publishBlob(`${KEYRING_BASE}.3`, gen(3, { kid: 'k3', secret: secretOf('s3') }), () => undefined); }],
    ['does not follow', 'SUCCESSION', async (v) => { await v.publishBlob(`${KEYRING_BASE}.1`, gen(1, { kid: 'k1', secret: secretOf('s1') }), () => undefined); await v.publishBlob(`${KEYRING_BASE}.2`, gen(2, { kid: 'k2', secret: secretOf('s2') }), () => undefined); }],
  ];
  for (const [name, problem, setup] of cases) {
    const dir = fresh(); const v = createVault(dir, fakeProtector); await setup(v); const before = snapshot(dir);
    assert.deepEqual(await rotateKeyring(v, opts('s9', 1)), { ok: false, reason: 'CHAIN_INVALID', problem }, name); unchanged(dir, before, name);
  }
  // the last generation (99), as a chain held in memory: refused before any write is tried
  const chain: Record<number, string> = {}; for (let n = 1; n <= 99; n++) chain[n] = gen(n, { kid: `k${n}`, secret: secretOf(`chain${n}`) }, n === 1 ? [] : [{ kid: `k${n - 1}`, secret: secretOf(`chain${n - 1}`), retired_at: '2026-11-09T12:00:00.000Z' }]);
  let publishes = 0; const mem: RotateVault = { generations: () => Array.from({ length: 99 }, (_, i) => i + 1), loadBlob: async (name) => chain[Number(name.slice(KEYRING_BASE.length + 1))], publishBlob: async () => { publishes++; return 'published'; }, withLock: async (_n, fn) => fn({ assertHeld() {} }) };
  assert.deepEqual(await rotateKeyring(mem, opts('s100', 99)), { ok: false, reason: 'GENERATION_LIMIT' }); assert.equal(publishes, 0);
});

test('ROTATE refuses unless nothing unresolved is reported: "some", "unknown" and a failing check all refuse and write nothing; "none" (or no check, when the founder has confirmed) goes ahead', async () => {
  const { dir, vault } = await made(); const before = snapshot(dir);
  for (const [name, check] of [['some', async () => 'some' as const], ['unknown', async () => 'unknown' as const], ['throws', async () => { throw new Error('cannot tell'); }], ['junk', async () => 'maybe' as unknown as 'none']] as const) {
    assert.deepEqual(await rotateKeyring(vault, opts('s2', 1, { unresolved: check })), { ok: false, reason: 'UNRESOLVED' }, name); unchanged(dir, before, name);
  }
  assert.ok((await rotateKeyring(vault, opts('s2', 1, { unresolved: async () => 'none' }))).ok);
});

test('ROTATE waits for the booking-identity lock and refuses if a booking or another rotation holds it: LOCKED, nothing written; it goes ahead once the lock is free; a lock lost before the link writes nothing', async () => {
  const { dir, vault } = await made(); const before = snapshot(dir);
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  const holder = createVault(dir, fakeProtector).withLock(IDENTITY_LOCK, async () => { await gate; });
  for (let i = 0; i < 400 && !existsSync(join(dir, `${IDENTITY_LOCK}.lock`)); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(existsSync(join(dir, `${IDENTITY_LOCK}.lock`)), 'the other holder has the lock');
  assert.deepEqual(await rotateKeyring(vault, opts('s2', 1, { lockWaitMs: 150 })), { ok: false, reason: 'LOCKED' }); unchanged(dir, before, 'locked');
  release(); await holder; assert.ok((await rotateKeyring(vault, opts('s2', 1))).ok, 'free again: it rotates');
  const { dir: d2, vault: v2 } = await made(); const b2 = snapshot(d2);
  const losing: RotateVault = { generations: v2.generations, loadBlob: v2.loadBlob, publishBlob: v2.publishBlob, withLock: (n, fn, w) => v2.withLock(n, (lock) => fn({ assertHeld() { throw Object.assign(new Error('lost'), { code: 'LOCK_LOST' }); } }), w) };
  assert.deepEqual(await rotateKeyring(losing, opts('s2', 1)), { ok: false, reason: 'LOCK_LOST' }); unchanged(d2, b2, 'lock lost');
});

test('ROTATE two attempts at once: with the lock, one rotates and the other is refused as stale; with the lock bypassed (a file-level race), exactly one file wins, the other is a CONFLICT, and the chain stays valid', async () => {
  { const { dir, vault } = await made(); const other = createVault(dir, fakeProtector);
    const [a, b] = await Promise.all([rotateKeyring(vault, opts('sA', 1)), rotateKeyring(other, opts('sB', 1))]);
    assert.equal([a, b].filter((x) => x.ok).length, 1, 'exactly one rotation'); const loser = [a, b].find((x) => !x.ok)!; assert.deepEqual(loser, { ok: false, reason: 'STALE_EXPECTATION' });
    const loaded = await loadKeyring(vault); assert.ok(loaded.ok); assert.deepEqual(loaded.generations, [1, 2]); }
  { const { dir } = await made(); let waiting = 0; let open!: () => void; const gate = new Promise<void>((r) => { open = r; });
    const racer = (label: string): RotateVault => { const real = createVault(dir, fakeProtector); return { generations: real.generations, loadBlob: real.loadBlob, withLock: async (_n, fn) => fn({ assertHeld() {} }),
      publishBlob: async (name, text, guard) => { if (++waiting >= 2) open(); await gate; return real.publishBlob(name, text, guard); } }; };   // both have read generation 1 and both reach the publish before either goes on
    const [a, b] = await Promise.all([rotateKeyring(racer('sA'), opts('sA', 1)), rotateKeyring(racer('sB'), opts('sB', 1))]);
    assert.deepEqual([a.ok, b.ok].sort(), [false, true]); assert.deepEqual([a, b].find((x) => !x.ok), { ok: false, reason: 'CONFLICT' });
    const loaded = await loadKeyring(createVault(dir, fakeProtector)); assert.ok(loaded.ok); assert.deepEqual(loaded.generations, [1, 2]);
    const winner = a.ok ? 'sA' : 'sB'; assert.equal(loaded.keyring.current.secret, secretOf(winner), 'the winner\'s file is the one on disk'); assert.equal(loaded.keyring.retired[0].secret, secretOf('s1'));
    assert.deepEqual(files(dir).filter((f) => f.endsWith('.tmp')), []); }
});

test('ROTATE a failure writes nothing and leaves nothing half-made: the protector fails, the hard link fails, the random source fails or is degenerate; and a later clean run still works', async () => {
  const { dir, vault } = await made(); const before = snapshot(dir);
  const broken: Protector = { protect: async () => { throw new Error('protector down'); }, unprotect: fakeProtector.unprotect };
  assert.deepEqual(await rotateKeyring(createVault(dir, broken), opts('s2', 1)), { ok: false, reason: 'WRITE_FAILED' }); unchanged(dir, before, 'protector');
  const nolink = createVault(dir, fakeProtector, { linkFile: () => { throw Object.assign(new Error('no hard links here'), { code: 'EPERM' }); } });
  assert.deepEqual(await rotateKeyring(nolink, opts('s2', 1)), { ok: false, reason: 'WRITE_FAILED' }); unchanged(dir, before, 'hard link');
  for (const [name, random] of [['too short', () => Buffer.from(bytes('x').subarray(0, 31))], ['too long', () => Buffer.concat([bytes('x'), Buffer.from([1])])], ['all zero', () => Buffer.alloc(32)], ['one byte repeated', () => Buffer.alloc(32, 5)], ['not a buffer', () => 'y'.repeat(32) as unknown as Buffer], ['throws', () => { throw new Error('no entropy'); }]] as Array<[string, () => Buffer]>) {
    assert.deepEqual(await rotateKeyring(vault, opts('s2', 1, { random })), { ok: false, reason: 'BAD_RANDOM' }, name); unchanged(dir, before, name);
  }
  assert.ok((await rotateKeyring(vault, opts('s2', 1))).ok, 'after every failure above a clean run works');
});

test('ROTATE never reuses an earlier key: a new secret equal to the current or to a retired one is refused before anything is written', async () => {
  const { dir, vault } = await made(); assert.ok((await rotateKeyring(vault, opts('s2', 1))).ok); const before = snapshot(dir);
  for (const label of ['s2', 's1']) assert.deepEqual(await rotateKeyring(vault, opts('s3', 2, { random: rnd(label) })), { ok: false, reason: 'REUSED_KEY' }, label);
  unchanged(dir, before, 'reused secret');
  // a secret that was DROPPED from the keyring earlier (by a later, checked retention step) may not come back either: found by the dry run of the whole chain
  const d2 = fresh(); const v2 = createVault(d2, fakeProtector); const gen = (n: number, current: unknown, retired: unknown[]): string => JSON.stringify({ version: 1, gen: n, current, retired });
  await v2.publishBlob(`${KEYRING_BASE}.1`, gen(1, { kid: 'k1', secret: secretOf('s1') }, []), () => undefined);
  await v2.publishBlob(`${KEYRING_BASE}.2`, gen(2, { kid: 'k2', secret: secretOf('s2') }, [{ kid: 'k1', secret: secretOf('s1'), retired_at: '2026-11-09T12:00:00.000Z' }]), () => undefined);
  await v2.publishBlob(`${KEYRING_BASE}.3`, gen(3, { kid: 'k3', secret: secretOf('s3') }, [{ kid: 'k2', secret: secretOf('s2'), retired_at: '2026-11-09T13:00:00.000Z' }]), () => undefined);   // k1 was dropped here
  const b2 = snapshot(d2); assert.deepEqual(await rotateKeyring(v2, opts('s1', 3)), { ok: false, reason: 'REUSED_KEY', problem: 'SUCCESSION' }); unchanged(d2, b2, 'a dropped secret returning');
  assert.ok((await rotateKeyring(v2, opts('s4', 3))).ok, 'control: a new secret rotates the same chain');
});

test('ROTATE a file that is written but cannot be read back is reported and never hidden; the older generations stay as they were', async () => {
  const { dir, vault } = await made(); const before = snapshot(dir);
  const tampered: RotateVault = { generations: vault.generations, publishBlob: vault.publishBlob, withLock: vault.withLock, loadBlob: async (n) => { const t = await vault.loadBlob(n); return n.endsWith('.2') && t !== undefined ? t.replace('"k2"', '"k9"') : t; } };
  assert.deepEqual(await rotateKeyring(tampered, opts('s2', 1)), { ok: false, reason: 'VERIFY_FAILED' });
  assert.deepEqual(keyFiles(dir), [`${KEYRING_BASE}.1.enc`, `${KEYRING_BASE}.2.enc`], 'the file exists, so nothing pretends it does not'); assert.equal(readFileSync(join(dir, `${KEYRING_BASE}.1.enc`), 'utf8'), before[`${KEYRING_BASE}.1.enc`]);
  assert.deepEqual(await rotateKeyring(vault, opts('s3', 1)), { ok: false, reason: 'STALE_EXPECTATION' }, 'a repeat does not rotate again over it');
  // the new file reads back as garbage (a different fault from a changed key id): reported the same way
  const { dir: d2, vault: v2 } = await made();
  const garbled: RotateVault = { generations: v2.generations, publishBlob: v2.publishBlob, withLock: v2.withLock, loadBlob: async (n) => (n.endsWith('.2') ? 'garbage' : v2.loadBlob(n)) };
  assert.deepEqual(await rotateKeyring(garbled, opts('s2', 1)), { ok: false, reason: 'VERIFY_FAILED' }); assert.deepEqual(keyFiles(d2), [`${KEYRING_BASE}.1.enc`, `${KEYRING_BASE}.2.enc`]);
});

test('COMMAND rotate needs every confirmation (--confirm, --no-unresolved-bookings, --server-stopped, --expect-generation N); with all of them it rotates once; every line it prints is free of any secret', async () => {
  const { dir, vault } = await made(); const out: string[] = []; const before = snapshot(dir);
  const run = (...argv: string[]): Promise<number> => runSetup(argv, { vault, say: (s) => out.push(s), random: rnd('s2'), now, lockWaitMs: 2000 });
  const ALL = ['--confirm', '--no-unresolved-bookings', '--server-stopped', '--expect-generation', '1'];
  assert.equal(await run('rotate'), 2); assert.match(out.at(-1)!, /Missing: --confirm --no-unresolved-bookings --server-stopped --expect-generation N/);
  for (const flag of ['--confirm', '--no-unresolved-bookings', '--server-stopped']) { assert.equal(await run('rotate', ...ALL.filter((x) => x !== flag)), 2, flag); assert.ok(out.at(-1)!.includes(`Missing: ${flag}`), flag); }
  for (const bad of ['0', 'x', '1000', '-1', '1.5', '']) assert.equal(await run('rotate', '--confirm', '--no-unresolved-bookings', '--server-stopped', '--expect-generation', bad), 2, `expect ${bad}`);
  assert.equal(await run('rotate', '--confirm', '--no-unresolved-bookings', '--server-stopped'), 2); unchanged(dir, before, 'incomplete commands');
  assert.equal(await run('rotate', ...ALL), 0); assert.match(out.at(-1)!, /^rotated: generation 2, new current key k2 \(fingerprint [0-9a-f]{4}\); k1 is retired and kept \(1 retired in all\)\./); assert.match(out.at(-1)!, /Restart the Drew server/);
  assert.equal(await run('status'), 0); assert.match(out.at(-1)!, /present \(generation 2, current key k2, fingerprint [0-9a-f]{4}, 1 retired\)/);
  assert.equal(await run('rotate', ...ALL), 1); assert.match(out.at(-1)!, /not at the generation you named .*\(STALE_EXPECTATION\)/);
  assert.equal(await run('rotate', ...ALL.slice(0, 4), '2', ...[]), 1, 'generation 2 now: it would rotate again, but the random source gives the current secret'); assert.match(out.at(-1)!, /reuse an earlier key.*\(REUSED_KEY\)/);
  for (const line of out) noSecret(line, ['s1', 's2']);
  const d2 = fresh(); const lines: string[] = []; assert.equal(await runSetup(['rotate', ...ALL], { vault: createVault(d2, fakeProtector), say: (s) => lines.push(s) }), 1); assert.match(lines[0], /there is no keyring yet \(use create\)/); assert.deepEqual(files(d2), []);
  const out3: string[] = []; assert.equal(await runSetup(['rotate', ...ALL.slice(0, 4), '2'], { vault, say: (s) => out3.push(s), unresolved: async () => 'some' }), 1); assert.match(out3[0], /unresolved bookings are not ruled out; nothing was changed \(UNRESOLVED\)/);
  assert.equal(await runSetup([], { vault, say: (s) => out3.push(s) }), 2); assert.match(out3.at(-1)!, /usage: .*rotate --confirm --no-unresolved-bookings --server-stopped --expect-generation N/);
});

test('SOURCE rotation is only by explicit command and only through the booking-identity lock: it holds no other lock, deletes and overwrites nothing, never logs or reads the environment, and never drops a retired key', () => {
  const src = readFileSync(new URL('../src/booking-identity-setup.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  for (const word of ['process.env', 'console.', 'rmSync', 'unlinkSync', 'writeFileSync', 'renameSync', 'saveBlob', 'fetch(', 'jobber-connector', 'jobber-booking']) assert.ok(!src.includes(word), word);
  assert.deepEqual([...src.matchAll(/\.withLock\(([^,]+),/g)].map((m) => m[1]), ['IDENTITY_LOCK'], 'the only lock taken is the booking-identity lock');
  assert.ok(/prev\.retired\.length >= MAX_RETIRED_KEYS\) return \{ ok: false, reason: 'RETENTION_LIMIT' \}/.test(src), 'a full retired list refuses');
  assert.ok(/retired: \[\{ kid: prev\.current\.kid, secret: prev\.current\.secret, retired_at: [^}]+\}, \.\.\.prev\.retired\]/.test(src), 'the new generation keeps every retired key after the old current key');
  assert.ok(!/prev\.retired\.(slice|filter|pop|splice|shift)\(/.test(src.slice(src.indexOf('async function rotateLocked'), src.indexOf('/** The command line'))), 'rotation takes nothing out of the retired list');
  assert.ok(/publishBlob\(`\$\{KEYRING_BASE\}\.\$\{n\}`, text, \(\) => lock\.assertHeld\(\)\)/.test(src), 'the lock is checked inside the publish, right before the link');
});
