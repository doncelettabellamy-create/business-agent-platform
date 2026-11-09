// A child process for the generation-file race test (tests/jobber-connector.test.ts): after the start signal it tries to publish generation 1, 2, 3 ... of one name, and prints which ones it won.
// Exactly one process may win each generation. It touches no network and no real Jobber folder.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createVault } from '../../src/jobber-connector.ts';

const [dir, rounds] = process.argv.slice(2);
const vault = createVault(dir, { protect: async (p) => p, unprotect: async (b) => b });
while (!existsSync(join(dir, 'go.signal'))) await new Promise((r) => setTimeout(r, 2));
const wins: number[] = [];
for (let g = 1; g <= Number(rounds); g++) { if (await vault.publishBlob(`race.${g}`, String(process.pid), () => undefined) === 'published') wins.push(g); }
console.log(JSON.stringify({ pid: process.pid, wins }));
