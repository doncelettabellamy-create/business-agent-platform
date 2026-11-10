// The private folder is decided in one place and fails closed (src/private-folder.ts). Everything here uses TEMPORARY folders and invented paths: no real private file is read or written, no key is made, no provider is called.
// The regression test reproduces the 2026-11-09 incident: a preload that deletes JOBBER_STORE_DIR (as an environment-scrubbing test guard did) used to make the setup program write an owner-consent record into the REAL folder.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FOLDER_NAME, realHomes, resolvePrivateFolder, underTest } from '../src/private-folder.ts';
import { isolation } from './helpers/isolated-env.ts';

const root = mkdtempSync(join(tmpdir(), 'private-folder-')); after(() => rmSync(root, { recursive: true, force: true }));
let n = 0; const fresh = (label: string): string => { const d = join(root, `${label}-${++n}`); mkdirSync(d, { recursive: true }); return d; };
const HOME = join(root, 'invented-home'); const REAL = join(HOME, FOLDER_NAME);
const SRC = join(import.meta.dirname, '..', 'src'); const NODE = process.execPath;

// ---------------------------------------------------------------- the decision, as a pure function
test('RESOLVER outside a test: unset gives the founder default under the home folder (unchanged); a value that is set must be a non-empty, absolute path without a NUL', () => {
  assert.deepEqual(resolvePrivateFolder({}, [HOME]), { ok: true, dir: REAL, source: 'default' });
  assert.deepEqual(resolvePrivateFolder({ JOBBER_STORE_DIR: join(root, 'x') }, [HOME]), { ok: true, dir: join(root, 'x'), source: 'env' });
  for (const [v, reason] of [['', 'EMPTY'], ['   ', 'EMPTY'], ['relative/dir', 'NOT_ABSOLUTE'], ['.', 'NOT_ABSOLUTE'], ['..', 'NOT_ABSOLUTE'], [`${join(root, 'a')}\0b`, 'NOT_ABSOLUTE']] as const) assert.deepEqual(resolvePrivateFolder({ JOBBER_STORE_DIR: v }, [HOME]), { ok: false, reason }, JSON.stringify(v));
  assert.deepEqual(resolvePrivateFolder({}, []), { ok: false, reason: 'NOT_SET_UNDER_TEST' }, 'no home folder at all: nothing is guessed');
});

test('RESOLVER under a test (the runner\'s NODE_TEST_CONTEXT, the tests\' own DREW_TEST_ISOLATION, or both): the default is NEVER used; unset, empty, relative, the real folder and anything inside it are refused; any other absolute folder is fine', () => {
  const signals: Array<Record<string, string>> = [{ NODE_TEST_CONTEXT: 'child-v8' }, { DREW_TEST_ISOLATION: '1' }, { NODE_TEST_CONTEXT: 'child-v8', DREW_TEST_ISOLATION: '1' }];
  for (const sig of signals) {
    assert.equal(underTest(sig), true, JSON.stringify(sig));
    assert.deepEqual(resolvePrivateFolder({ ...sig }, [HOME]), { ok: false, reason: 'NOT_SET_UNDER_TEST' }, 'unset: the default is not used');
    assert.deepEqual(resolvePrivateFolder({ ...sig, JOBBER_STORE_DIR: '' }, [HOME]), { ok: false, reason: 'EMPTY' }); assert.deepEqual(resolvePrivateFolder({ ...sig, JOBBER_STORE_DIR: 'store' }, [HOME]), { ok: false, reason: 'NOT_ABSOLUTE' });
    for (const bad of [REAL, join(REAL, 'sub'), join(REAL, 'sub', 'deeper'), `${REAL}${process.platform === 'win32' ? '\\' : '/'}`, join(REAL, '..', FOLDER_NAME), ...(process.platform === 'win32' ? [REAL.toUpperCase()] : [])]) assert.deepEqual(resolvePrivateFolder({ ...sig, JOBBER_STORE_DIR: bad }, [HOME]), { ok: false, reason: 'REAL_FOLDER_UNDER_TEST' }, bad);
    for (const good of [join(root, 'a-temp-store'), HOME, `${REAL}-copy`, join(HOME, 'other')]) assert.deepEqual(resolvePrivateFolder({ ...sig, JOBBER_STORE_DIR: good }, [HOME]), { ok: true, dir: good, source: 'env' }, good);
    assert.deepEqual(resolvePrivateFolder({ ...sig, JOBBER_STORE_DIR: join(root, 'x', FOLDER_NAME, 'y') }, [HOME]).ok, true, 'a folder merely named like it, elsewhere, is not the real one');
    const other = join(root, 'second-home'); assert.deepEqual(resolvePrivateFolder({ ...sig, JOBBER_STORE_DIR: join(other, FOLDER_NAME) }, [HOME, other]), { ok: false, reason: 'REAL_FOLDER_UNDER_TEST' }, 'every known home folder counts, not only the first');
  }
  for (const not of [{}, { NODE_TEST_CONTEXT: '' }, { DREW_TEST_ISOLATION: '0' }, { DREW_TEST_ISOLATION: 'yes' }]) assert.equal(underTest(not), false, JSON.stringify(not));
});

test('RESOLVER knows the real home even when HOME and USERPROFILE are overridden: the operating system\'s record is included, so a test child with a temporary home still cannot name the real folder', () => {
  const temp = fresh('overridden-home'); const script = join(fresh('probe'), 'probe.mjs');
  writeFileSync(script, `import { realHomes } from ${JSON.stringify(pathToFileURL(join(SRC, 'private-folder.ts')).href)}; console.log(JSON.stringify(realHomes()));`);
  const r = spawnSync(NODE, [script], { env: { PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), HOME: temp, USERPROFILE: temp }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr); const homes = JSON.parse(r.stdout) as string[];
  assert.equal(homes[0], temp, 'the home folder the program sees follows the environment'); assert.ok(homes.some((h) => h !== temp), 'the operating system\'s own record of the user\'s home is also known');
  assert.deepEqual(realHomes().length > 0, true);
});

// ---------------------------------------------------------------- the source: one decision, four callers
test('SOURCE: only private-folder.ts names the default folder or falls back to the home folder; each of the four programs takes its folder from the resolver; the resolver touches no file', () => {
  const strip = (t: string): string => t.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const f of readdirSync(SRC).filter((x) => x.endsWith('.ts') && x !== 'private-folder.ts')) assert.ok(!/\.drew-jobber|homedir\(/.test(strip(readFileSync(join(SRC, f), 'utf8'))), `${f} does not decide the private folder itself`);
  for (const f of ['fast-test-setup-main.ts', 'booking-identity-setup-main.ts', 'jobber-connect-main.ts', 'founder-voice-entry.ts']) { const t = strip(readFileSync(join(SRC, f), 'utf8')); assert.ok(/import \{ privateFolder \} from '\.\/private-folder\.ts';/.test(t) && /privateFolder\(\)/.test(t), `${f} uses the resolver`); assert.ok(!/JOBBER_STORE_DIR/.test(t), `${f} does not read the variable itself`); }
  assert.ok(/const fastDir = fastCfg === undefined \? '' : privateFolder\(\);/.test(strip(readFileSync(join(SRC, 'founder-voice-entry.ts'), 'utf8'))), 'the entry resolves the folder only when the fast test call needs it');
  const own = strip(readFileSync(join(SRC, 'private-folder.ts'), 'utf8')); assert.ok(!/writeFile|appendFile|mkdir|rmSync|unlink|rename|copyFile|createWriteStream|fetch\(|spawn|readFileSync|readdirSync/.test(own), 'it reads and writes nothing');
  assert.ok(/process\.exit\(78\)/.test(own) && !/ \+ dir|\$\{dir\}|\$\{v\}/.test(own), 'a refusal exits 78 and prints no path');
});

// ---------------------------------------------------------------- the incident, replayed with temporary folders only
const baseEnv = (): Record<string, string> => ({ PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) });
/** NODE_OPTIONS for a stand-in preload that deletes environment variables by name, as the 2026-11-09 scratch guard did (`names` is the pattern). */
function preload(names: RegExp): string {
  const file = join(fresh('preload'), 'strip-env.mjs'); writeFileSync(file, `for (const k of Object.keys(process.env)) if (${names.toString()}.test(k)) delete process.env[k];\n`);
  return `--import=${pathToFileURL(file).href}`;
}
const OLD_GUARD = /KEY|TOKEN|SECRET|PASSWORD|JOBBER|OPENAI|ANTHROPIC|TWILIO|ELEVEN|GOOGLE|FAST_|AUTH|CREDENTIAL/i;   // what the scratch guard removed: it includes JOBBER_STORE_DIR
const ls = (d: string): string[] => readdirSync(d).sort();
const PROGRAMS: Array<[string, string[], string | undefined]> = [
  ['fast-test-setup-main.ts', ['status'], undefined], ['booking-identity-setup-main.ts', ['status'], undefined], ['jobber-connect-main.ts', ['status'], undefined],
];

test('INCIDENT REPLAY: the owner-consent command, started in a test child whose JOBBER_STORE_DIR a preload deletes, is REFUSED (exit 78, a fixed code, no path) before it reads or writes anything - the temporary store and the temporary home stay empty', () => {
  const store = fresh('store'); const home = fresh('home');
  const env = { ...baseEnv(), ...isolation(store), HOME: home, USERPROFILE: home, NODE_OPTIONS: preload(OLD_GUARD) };
  const r = spawnSync(NODE, [join(SRC, 'fast-test-setup-main.ts'), 'record-owner-consent'], { input: JSON.stringify({ answer: 'yes' }), env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 78, r.stderr); assert.match(r.stderr, /refused: this is a test run and JOBBER_STORE_DIR is not set, so the real private folder would have been used\. Nothing was read or written\. \(PRIVATE_FOLDER_NOT_SET_UNDER_TEST\)/);
  assert.equal(r.stdout, ''); assert.ok(!r.stderr.includes(store) && !r.stderr.includes(home), 'no path is printed'); assert.deepEqual(ls(store), []); assert.deepEqual(ls(home), []);
});

test('INCIDENT REPLAY for every program that opens the private folder: with the variable deleted in a test child, each one refuses and creates nothing; with it present, each one runs against the temporary folder only', () => {
  for (const [file, args] of PROGRAMS) {
    const store = fresh('store'); const home = fresh('home');
    const gone = spawnSync(NODE, [join(SRC, file), ...args], { env: { ...baseEnv(), ...isolation(store), HOME: home, USERPROFILE: home, NODE_OPTIONS: preload(OLD_GUARD) }, encoding: 'utf8', timeout: 30_000 });
    assert.equal(gone.status, 78, `${file}: ${gone.stderr}`); assert.match(gone.stderr, /PRIVATE_FOLDER_NOT_SET_UNDER_TEST/, file); assert.deepEqual([ls(store), ls(home)], [[], []], file);
    const there = spawnSync(NODE, [join(SRC, file), ...args], { env: { ...baseEnv(), ...isolation(store) }, encoding: 'utf8', timeout: 30_000 });
    assert.notEqual(there.status, 78, `${file}: with the variable present it is not refused (${there.stderr.slice(0, 120)})`); assert.ok(!/PRIVATE_FOLDER_/.test(there.stderr), file); assert.deepEqual(ls(home), [], file + ': the temporary home is untouched');
  }
});

test('REFUSED values: empty, relative, and the real private folder itself or a place inside it are each refused under a test, by every program, before anything is read or written', () => {
  const real = realHomes().map((h) => join(h, FOLDER_NAME));   // only the NAMES of the real folders are used: the programs refuse before they open anything
  for (const [file, args] of PROGRAMS) {
    for (const [value, code] of [['', 'EMPTY'], ['store-relative', 'NOT_ABSOLUTE'], ...real.flatMap((p) => [[p, 'REAL_FOLDER_UNDER_TEST'], [join(p, 'inner'), 'REAL_FOLDER_UNDER_TEST']])] as Array<[string, string]>) {
      const home = fresh('home');
      const r = spawnSync(NODE, [join(SRC, file), ...args], { env: { ...baseEnv(), ...isolation(home), JOBBER_STORE_DIR: value }, encoding: 'utf8', timeout: 30_000 });
      assert.equal(r.status, 78, `${file} ${code}: ${r.stderr}`); assert.match(r.stderr, new RegExp(`\\(PRIVATE_FOLDER_${code}\\)`), `${file} ${value === '' ? '(empty)' : ''}`); assert.ok(!r.stderr.includes(value) || value === '', 'no path is printed'); assert.deepEqual(ls(home), [], file);
    }
  }
});

test('LAYERED: even if a preload deletes JOBBER_STORE_DIR, DREW_TEST_ISOLATION and NODE_TEST_CONTEXT, the temporary HOME and USERPROFILE keep the default folder inside the temporary home - the program reads an empty folder and writes nothing (a read-only command is used)', () => {
  const home = fresh('home');
  const r = spawnSync(NODE, [join(SRC, 'fast-test-setup-main.ts'), 'status'], { env: { ...baseEnv(), ...isolation(home), NODE_OPTIONS: preload(/JOBBER|DREW_TEST|NODE_TEST/i) }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /approved test numbers saved: false/, 'it looked in the temporary home, which is empty'); assert.deepEqual(ls(home), [], 'and wrote nothing');
});

test('FOUNDER-RUN default is unchanged: with no test marker and no variable, the programs use .drew-jobber under the home folder they are given (here a temporary one)', () => {
  const home = fresh('founder-home');
  const env = { ...baseEnv(), HOME: home, USERPROFILE: home };   // no JOBBER_STORE_DIR, no NODE_TEST_CONTEXT, no marker
  const a = spawnSync(NODE, [join(SRC, 'fast-test-setup-main.ts'), 'status'], { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(a.status, 0, a.stderr); assert.match(a.stdout, /approved test numbers saved: false/);
  const b = spawnSync(NODE, [join(SRC, 'booking-identity-setup-main.ts'), 'status'], { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(b.status, 1, b.stderr); assert.match(b.stdout, /booking identity keyring: absent \(nothing has been created\)/);
  assert.deepEqual(ls(home), [], 'read-only commands: nothing was created');
  const custom = fresh('custom'); const c = spawnSync(NODE, [join(SRC, 'booking-identity-setup-main.ts'), 'status'], { env: { ...env, JOBBER_STORE_DIR: custom }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(c.status, 1, c.stderr); assert.match(c.stdout, /absent/, 'an absolute JOBBER_STORE_DIR outside a test is honoured');
});
