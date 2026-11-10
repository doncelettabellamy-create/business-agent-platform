// The environment every test must give a child process that is one of the four programs that open the founder's private folder (fast-test-setup-main, booking-identity-setup-main, jobber-connect-main, founder-voice-entry).
// Four layers, so that no single change to a child's environment can send it to the real folder (src/private-folder.ts is the fail-closed resolver):
//   1. JOBBER_STORE_DIR: an absolute temporary folder (when the test uses one);
//   2. DREW_TEST_ISOLATION=1: the program knows it is under a test even if NODE_TEST_CONTEXT is missing, and then refuses to use the default folder;
//   3. HOME and USERPROFILE: a temporary folder, so even a program that failed open would find its "home" inside the temporary folder, never the real one;
//   4. the resolver also refuses a JOBBER_STORE_DIR that is, or lies inside, the real private folder.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** For a test that passes its own store folder `dir`. */
export const isolation = (dir: string): Record<string, string> => ({ JOBBER_STORE_DIR: dir, HOME: dir, USERPROFILE: dir, DREW_TEST_ISOLATION: '1' });
/** For a test that passes no store folder: only the markers and a temporary home. */
export const isolationNoStore = (home: string): Record<string, string> => ({ HOME: home, USERPROFILE: home, DREW_TEST_ISOLATION: '1' });

let shared: string | undefined;
/** One temporary home folder per test process, removed when the process ends. */
export function isolatedHome(): string {
  if (shared === undefined) { const d = mkdtempSync(join(tmpdir(), 'drew-home-')); shared = d; process.on('exit', () => { try { rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }); }
  return shared;
}
