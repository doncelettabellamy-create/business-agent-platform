// A child process for the lock race test (tests/jobber-connector.test.ts): it takes the named lock `rounds` times and, inside it, does a read-modify-write on a shared counter file with a pause between the read
// and the write. If two processes were ever inside at once, an increment would be lost, or the "inside" marker could not be created (exit 2). It touches no network and no real Jobber folder.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createVault } from '../../src/jobber-connector.ts';

const [dir, rounds, holdMs, heartbeatMs, staleMs] = process.argv.slice(2);
const vault = createVault(dir, { protect: async (p) => p, unprotect: async (b) => b }, { heartbeatMs: Number(heartbeatMs), staleMs: Number(staleMs) });
const counter = join(dir, 'counter.txt'); const inside = join(dir, 'inside.marker');
let overlaps = 0;
for (let i = 0; i < Number(rounds); i++) {
  await vault.withLock('race', async (lock) => {
    try { writeFileSync(inside, String(process.pid), { flag: 'wx' }); } catch { overlaps++; }
    lock.assertHeld();
    const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
    await new Promise((r) => setTimeout(r, Number(holdMs)));
    lock.assertHeld();
    writeFileSync(counter, String(n + 1));
    rmSync(inside, { force: true });
  }, 30_000);
}
process.exit(overlaps > 0 ? 2 : 0);
