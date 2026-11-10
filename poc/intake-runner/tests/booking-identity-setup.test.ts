// Founder-run creation of the booking-identity keyring (Step 3a; offline). A temporary folder per test, the test protector (reversible, NOT secure), made-up randomness: no real secret is created, and nothing touches the real private folder.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, KEYRING_BASE, loadKeyring } from '../src/booking-identity.ts';
import { createKeyring, runSetup } from '../src/booking-identity-setup.ts';
import type { SetupVault } from '../src/booking-identity-setup.ts';
import { createVault } from '../src/jobber-connector.ts';
import type { Protector } from '../src/jobber-connector.ts';

const fakeProtector: Protector = { protect: async (p) => `P1:${Buffer.from([...Buffer.from(p)].reverse()).toString('hex')}`, unprotect: async (b) => Buffer.from(Buffer.from(b.slice(3), 'hex').reverse()).toString() };
const root = mkdtempSync(join(tmpdir(), 'booking-identity-setup-')); after(() => rmSync(root, { recursive: true, force: true }));
const fresh = (): string => mkdtempSync(join(root, 'p-'));
const RAND = createHash('sha256').update('made-up randomness for the setup test').digest();   // 32 bytes with variety: a stand-in for the system's random
const SECRET = RAND.toString('base64url');
const rand = (): Buffer => Buffer.from(RAND);
const files = (dir: string): string[] => readdirSync(dir).sort();
const keyFiles = (dir: string): string[] => files(dir).filter((f) => f.startsWith(KEYRING_BASE));
const gen = (n: number, current: { kid: string; secret: string }, retired: unknown[] = []): string => JSON.stringify({ version: 1, gen: n, current, retired });

test('CREATE the first run makes generation 1 only: one file, key k1, nothing retired, protected on disk, and the result shows the key id and a fingerprint but never the secret', async () => {
  const dir = fresh(); const vault = createVault(dir, fakeProtector);
  const r = await createKeyring(vault, { random: rand });
  assert.equal(r.ok, true); assert.ok(r.ok);
  assert.equal(r.kid, 'k1'); assert.match(r.fingerprint, /^[0-9a-f]{4}$/);
  assert.deepEqual(keyFiles(dir), [`${KEYRING_BASE}.1.enc`], 'exactly one generation file, and no temporary file is left');
  assert.deepEqual(files(dir), [`${KEYRING_BASE}.1.enc`], 'nothing else was written to the folder');
  const loaded = await loadKeyring(vault); assert.ok(loaded.ok); assert.deepEqual(loaded.generations, [1]);
  assert.deepEqual(loaded.keyring, { gen: 1, current: { kid: 'k1', secret: SECRET }, retired: [] });
  assert.equal(r.fingerprint, describe(loaded.keyring).fingerprint);
  assert.ok(!readFileSync(join(dir, `${KEYRING_BASE}.1.enc`), 'utf8').includes(SECRET), 'the file holds the protector\'s output, not the plain secret');
  assert.ok(!JSON.stringify(r).includes(SECRET) && !JSON.stringify(r).includes(SECRET.slice(0, 8)), 'the result holds no secret');
});

test('CREATE with the real random source makes a valid, different secret every time (two folders, two secrets; both load as a strict keyring)', async () => {
  const a = fresh(); const b = fresh(); const va = createVault(a, fakeProtector); const vb = createVault(b, fakeProtector);
  assert.ok((await createKeyring(va)).ok); assert.ok((await createKeyring(vb)).ok);
  const la = await loadKeyring(va); const lb = await loadKeyring(vb); assert.ok(la.ok && lb.ok);
  assert.match(la.keyring.current.secret, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(la.keyring.current.secret, lb.keyring.current.secret);
});

test('CREATE a second invocation refuses and changes nothing: the file is byte for byte the same, no second generation appears', async () => {
  const dir = fresh(); const vault = createVault(dir, fakeProtector);
  assert.ok((await createKeyring(vault, { random: rand })).ok);
  const file = join(dir, `${KEYRING_BASE}.1.enc`); const before = readFileSync(file, 'utf8');
  const again = await createKeyring(vault, { random: () => Buffer.from(createHash('sha256').update('a different secret').digest()) });
  assert.deepEqual(again, { ok: false, reason: 'EXISTS' });
  assert.equal(readFileSync(file, 'utf8'), before); assert.deepEqual(keyFiles(dir), [`${KEYRING_BASE}.1.enc`]);
  const loaded = await loadKeyring(vault); assert.ok(loaded.ok); assert.equal(loaded.keyring.current.secret, SECRET, 'the first secret is still the one in use');
});

test('CREATE refuses over ANY existing keyring state, valid or not, and never repairs it: malformed, gapped, a longer chain, an unreadable file', async () => {
  const cases: Array<[string, (v: ReturnType<typeof createVault>) => Promise<void>]> = [
    ['malformed generation 1', async (v) => { await v.publishBlob(`${KEYRING_BASE}.1`, 'not json', () => undefined); }],
    ['wrong shape', async (v) => { await v.publishBlob(`${KEYRING_BASE}.1`, gen(1, { kid: 'k1', secret: 'short' }), () => undefined); }],
    ['only generation 2 (a gap before it)', async (v) => { await v.publishBlob(`${KEYRING_BASE}.2`, gen(2, { kid: 'k2', secret: SECRET }), () => undefined); }],
    ['a rotated chain', async (v) => { const s2 = createHash('sha256').update('second').digest('base64url'); await v.publishBlob(`${KEYRING_BASE}.1`, gen(1, { kid: 'k1', secret: SECRET }), () => undefined); await v.publishBlob(`${KEYRING_BASE}.2`, gen(2, { kid: 'k2', secret: s2 }, [{ kid: 'k1', secret: SECRET, retired_at: '2026-11-09T12:00:00Z' }]), () => undefined); }],
  ];
  for (const [name, setup] of cases) {
    const dir = fresh(); const vault = createVault(dir, fakeProtector); await setup(vault); const before = files(dir); const bytes = before.map((f) => readFileSync(join(dir, f), 'utf8'));
    assert.deepEqual(await createKeyring(vault, { random: rand }), { ok: false, reason: 'EXISTS' }, name);
    assert.deepEqual(files(dir), before, name); assert.deepEqual(before.map((f) => readFileSync(join(dir, f), 'utf8')), bytes, `${name}: no file changed`);
  }
  const dir = fresh(); const v = createVault(dir, fakeProtector); await v.publishBlob(`${KEYRING_BASE}.1`, gen(1, { kid: 'k1', secret: SECRET }), () => undefined);
  const strict: Protector = { protect: fakeProtector.protect, unprotect: async () => { throw new Error('cannot decode'); } };
  assert.deepEqual(await createKeyring(createVault(dir, strict), { random: rand }), { ok: false, reason: 'EXISTS' }, 'a file the protector cannot decode still counts as a keyring that exists');
});

test('CREATE a failure writes nothing and leaves no half-made file: the protector fails, the hard link fails, the random source fails or is degenerate, the folder cannot be listed', async () => {
  const empty = (dir: string): void => { assert.deepEqual(files(dir), [], 'the folder is empty: no keyring file and no temporary file'); };
  { const dir = fresh(); const broken: Protector = { protect: async () => { throw new Error('protector down'); }, unprotect: fakeProtector.unprotect };
    assert.deepEqual(await createKeyring(createVault(dir, broken), { random: rand }), { ok: false, reason: 'WRITE_FAILED' }); empty(dir); }
  { const dir = fresh(); const v = createVault(dir, fakeProtector, { linkFile: () => { throw Object.assign(new Error('no hard links here'), { code: 'EPERM' }); } });
    assert.deepEqual(await createKeyring(v, { random: rand }), { ok: false, reason: 'WRITE_FAILED' }); empty(dir); }
  for (const [name, random] of [['too short', () => Buffer.from(RAND.subarray(0, 31))], ['too long', () => Buffer.concat([RAND, RAND.subarray(0, 1)])], ['all zero', () => Buffer.alloc(32)], ['one repeated byte', () => Buffer.alloc(32, 9)], ['not a buffer', () => 'x'.repeat(32) as unknown as Buffer], ['throws', () => { throw new Error('no entropy'); }]] as Array<[string, () => Buffer]>) {
    const dir = fresh(); assert.deepEqual(await createKeyring(createVault(dir, fakeProtector), { random }), { ok: false, reason: 'BAD_RANDOM' }, name); empty(dir);
  }
  { const dir = fresh(); const real = createVault(dir, fakeProtector); const v: SetupVault = { generations: () => { throw new Error('cannot list'); }, loadBlob: real.loadBlob, publishBlob: real.publishBlob };
    assert.deepEqual(await createKeyring(v, { random: rand }), { ok: false, reason: 'UNREADABLE_STATE' }); empty(dir); }
  { const dir = fresh(); const v = createVault(dir, fakeProtector); assert.ok((await createKeyring(v, { random: rand })).ok, 'after every failure above a clean run still works'); }
});

test('CREATE a lost race keeps the other writer\'s file; a file that cannot be read back is reported, never hidden', async () => {
  { const dir = fresh(); const real = createVault(dir, fakeProtector);
    const racing: SetupVault = { generations: () => [], loadBlob: real.loadBlob, publishBlob: async (name, text, guard) => { await real.publishBlob(name, gen(1, { kid: 'k1', secret: createHash('sha256').update('the other writer').digest('base64url') }), () => undefined); return real.publishBlob(name, text, guard); } };
    assert.deepEqual(await createKeyring(racing, { random: rand }), { ok: false, reason: 'EXISTS' });
    const loaded = await loadKeyring(real); assert.ok(loaded.ok); assert.notEqual(loaded.keyring.current.secret, SECRET, 'the other writer\'s secret is the one on disk'); assert.deepEqual(keyFiles(dir), [`${KEYRING_BASE}.1.enc`]); }
  { const dir = fresh(); const real = createVault(dir, fakeProtector);
    const tampered: SetupVault = { generations: real.generations, loadBlob: async (n) => { const t = await real.loadBlob(n); return t === undefined ? t : t.replace('"k1"', '"k9"'); }, publishBlob: real.publishBlob };
    assert.deepEqual(await createKeyring(tampered, { random: rand }), { ok: false, reason: 'VERIFY_FAILED' });
    assert.deepEqual(await createKeyring(real, { random: rand }), { ok: false, reason: 'EXISTS' }, 'the file exists, so a second create refuses rather than overwrite it'); }
});

test('COMMAND status is read-only and create needs --confirm: without it nothing is made; with it one keyring is made once; every line it prints is free of the secret', async () => {
  const dir = fresh(); const vault = createVault(dir, fakeProtector); const out: string[] = [];
  const run = async (...argv: string[]): Promise<number> => runSetup(argv, { vault, say: (s) => out.push(s), random: rand });
  assert.equal(await run('status'), 1); assert.match(out.at(-1)!, /absent/); assert.deepEqual(files(dir), []);
  assert.equal(await run('create'), 2); assert.match(out.at(-1)!, /--confirm/); assert.deepEqual(files(dir), [], 'no --confirm: nothing created');
  assert.equal(await run('create', '--yes'), 2); assert.deepEqual(files(dir), []);
  assert.equal(await run('create', '--confirm'), 0); assert.match(out.at(-1)!, /created: .*generation 1, key k1, fingerprint [0-9a-f]{4}\./); assert.deepEqual(keyFiles(dir), [`${KEYRING_BASE}.1.enc`]);
  assert.equal(await run('status'), 0); assert.match(out.at(-1)!, /present \(generation 1, current key k1, fingerprint [0-9a-f]{4}, 0 retired\)/);
  const before = readFileSync(join(dir, `${KEYRING_BASE}.1.enc`), 'utf8');
  assert.equal(await run('create', '--confirm'), 1); assert.match(out.at(-1)!, /already exists/); assert.equal(readFileSync(join(dir, `${KEYRING_BASE}.1.enc`), 'utf8'), before);
  assert.equal(await run('rotate'), 2); assert.equal(await run(), 2); assert.match(out.at(-1)!, /usage/);
  for (const line of out) assert.ok(!line.includes(SECRET) && !line.includes(SECRET.slice(0, 8)) && !line.includes(SECRET.slice(-8)), `no secret in: ${line.slice(0, 40)}`);
  // a damaged keyring is reported by status, with the generation, and nothing is changed
  const d2 = fresh(); const v2 = createVault(d2, fakeProtector); await v2.publishBlob(`${KEYRING_BASE}.1`, 'garbage', () => undefined); const lines: string[] = [];
  assert.equal(await runSetup(['status'], { vault: v2, say: (s) => lines.push(s) }), 1); assert.match(lines[0], /PROBLEM MALFORMED at generation 1 \(nothing was changed\)/);
  assert.equal(await runSetup(['create', '--confirm'], { vault: v2, say: (s) => lines.push(s) }), 1); assert.match(lines[1], /already exists/);
});

test('COMMAND failures are named without a secret, and a write failure leaves the folder empty', async () => {
  const dir = fresh(); const out: string[] = []; const broken: Protector = { protect: async () => { throw new Error(`protector down ${SECRET}`); }, unprotect: fakeProtector.unprotect };
  assert.equal(await runSetup(['create', '--confirm'], { vault: createVault(dir, broken), say: (s) => out.push(s), random: rand }), 1);
  assert.match(out[0], /could not be written.*\(WRITE_FAILED\)/); assert.ok(!out.join('\n').includes(SECRET), 'an error from the protector is never printed'); assert.deepEqual(files(dir), []);
  const out2: string[] = []; assert.equal(await runSetup(['create', '--confirm'], { vault: createVault(fresh(), fakeProtector), say: (s) => out2.push(s), random: () => Buffer.alloc(32) }), 1); assert.match(out2[0], /\(BAD_RANDOM\)/);
});

test('SOURCE creation is only by explicit command: the setup module and the command file are imported by nothing else, never log or read the environment in the module, never delete or overwrite, and the command file is a thin wrapper', () => {
  const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const mod = read('../src/booking-identity-setup.ts'); const main = read('../src/booking-identity-setup-main.ts');
  for (const word of ['process.env', 'console.', 'rmSync', 'unlinkSync', 'writeFileSync', 'renameSync', 'saveBlob', 'fetch(']) assert.ok(!mod.includes(word), `module: ${word}`);
  assert.deepEqual([...mod.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]).sort(), ['./booking-identity.ts', './booking-identity.ts', 'node:crypto']);
  assert.ok(!/throw new Error\(/.test(mod));
  assert.deepEqual([...main.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]), ['node:os', 'node:path', './jobber-connector.ts', './jobber-dpapi.ts', './booking-identity-setup.ts']);
  assert.ok(!main.includes('createKeyring') && main.includes('runSetup(process.argv.slice(2)'), 'the command file only passes the real folder and the real console to runSetup');
  const importers = readdirSync(new URL('../src/', import.meta.url)).filter((f) => f.endsWith('.ts') && f !== 'booking-identity-setup.ts' && f !== 'booking-identity-setup-main.ts' && /booking-identity-setup/.test(read(`../src/${f}`)));
  assert.deepEqual(importers, [], 'no other source file imports the setup');
  assert.ok(!/booking-identity-setup/.test(read('../src/booking-identity.ts')));
  assert.equal(existsSync(new URL('../src/booking-identity-setup-main.ts', import.meta.url)), true);
});
