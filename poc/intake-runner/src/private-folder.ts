// WHERE THE PRIVATE FOLDER IS, decided in one place and fail-closed. The private folder (credentials, tokens, approved numbers, email settings, consent evidence, the booking ledger and the booking-identity keyring) is the founder's, on the founder's
// machine. Four command programs open it: fast-test-setup-main.ts, the keyring command file, jobber-connect-main.ts and founder-voice-entry.ts. Each used to write `JOBBER_STORE_DIR ?? ~/.drew-jobber` itself, so a program that was started
// without the variable (a test child whose environment was changed, a typo, an empty value) silently used the REAL folder. That is how two automated owner-consent records reached the real consent evidence on 2026-11-09.
//
//   - JOBBER_STORE_DIR, when it is set, must be a non-empty ABSOLUTE path (no NUL). Anything else is refused, not repaired.
//   - Unset, outside a test: the founder's default, `.drew-jobber` in the home folder (unchanged for founder-run use).
//   - UNDER A TEST (the Node test runner sets NODE_TEST_CONTEXT in its children, and the tests' own helper sets DREW_TEST_ISOLATION=1; either is enough): the default is NEVER used. An unset variable is refused, and so is a path that is, or is inside,
//     the real private folder of this user (checked against the home folder the program sees AND the home folder the operating system records for the user, so an overridden HOME or USERPROFILE does not hide it).
//   - A refusal prints one fixed sentence and a code, never a path, and exits 78 before anything is read or written.
// Reads the environment it is given; touches no file.

import { homedir, userInfo } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

export const FOLDER_NAME = '.drew-jobber';
export type FolderRefusal = 'EMPTY' | 'NOT_ABSOLUTE' | 'NOT_SET_UNDER_TEST' | 'REAL_FOLDER_UNDER_TEST';
export type FolderResult = { ok: true; dir: string; source: 'env' | 'default' } | { ok: false; reason: FolderRefusal };
type Env = Readonly<Record<string, string | undefined>>;

const WHY: Record<FolderRefusal, string> = {
  EMPTY: 'JOBBER_STORE_DIR is set but empty.',
  NOT_ABSOLUTE: 'JOBBER_STORE_DIR is not an absolute path.',
  NOT_SET_UNDER_TEST: 'this is a test run and JOBBER_STORE_DIR is not set, so the real private folder would have been used.',
  REAL_FOLDER_UNDER_TEST: 'this is a test run and JOBBER_STORE_DIR points at the real private folder.',
};

/** True when the process is running under the test runner or under the tests' own isolation marker. */
export const underTest = (env: Env): boolean => (typeof env.NODE_TEST_CONTEXT === 'string' && env.NODE_TEST_CONTEXT !== '') || env.DREW_TEST_ISOLATION === '1';

/** The home folders whose private folder must never be used under a test: what this process sees and what the operating system records for the user. */
export function realHomes(): string[] {
  const out: string[] = [];
  try { out.push(homedir()); } catch { /* none */ }
  try { out.push(userInfo().homedir); } catch { /* none */ }
  return out.filter((h) => typeof h === 'string' && h !== '');
}

const norm = (p: string): string => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
const inside = (dir: string, parent: string): boolean => { const r = relative(norm(parent), norm(dir)); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };

/** Pure: decides from the environment and the list of real home folders. `homes` is for tests; the default is the real ones. */
export function resolvePrivateFolder(env: Env, homes: readonly string[] = realHomes()): FolderResult {
  const test = underTest(env); const v = env.JOBBER_STORE_DIR;
  if (v !== undefined) {
    if (v.trim() === '') return { ok: false, reason: 'EMPTY' };
    if (v.includes('\0') || !isAbsolute(v)) return { ok: false, reason: 'NOT_ABSOLUTE' };
    if (test && homes.some((h) => inside(v, join(h, FOLDER_NAME)))) return { ok: false, reason: 'REAL_FOLDER_UNDER_TEST' };
    return { ok: true, dir: v, source: 'env' };
  }
  if (test) return { ok: false, reason: 'NOT_SET_UNDER_TEST' };
  const home = homes[0]; if (home === undefined) return { ok: false, reason: 'NOT_SET_UNDER_TEST' };
  return { ok: true, dir: join(home, FOLDER_NAME), source: 'default' };
}

/** For the four command programs: the folder, or one fixed sentence and exit 78 before anything is read or written. */
export function privateFolder(env: Env = process.env): string {
  const r = resolvePrivateFolder(env);
  if (r.ok) return r.dir;
  console.error(`refused: ${WHY[r.reason]} Nothing was read or written. (PRIVATE_FOLDER_${r.reason})`);
  process.exit(78);
}
