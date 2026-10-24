// Command-line wrapper for the synthetic Intake runner PoC.
// Reads ONE local JSON file, prints the result as JSON. Reads only; writes nothing; no network.
// Usage: node src/cli.ts <input.json> [--min-confidence <0..1>]
import { readFileSync } from 'node:fs';
import { runIntake } from './intake-runner.ts';

const args = process.argv.slice(2);
const file = args[0];
if (!file) {
  console.error('Usage: node src/cli.ts <input.json> [--min-confidence <0..1>]');
  process.exit(64);
}

let minConfidence: number | undefined;
const flag = args.indexOf('--min-confidence');
if (flag !== -1) {
  minConfidence = Number(args[flag + 1]);
  if (!Number.isFinite(minConfidence)) {
    console.error('--min-confidence needs a number from 0 to 1');
    process.exit(64);
  }
}

let parsed: unknown;
try {
  parsed = JSON.parse(readFileSync(file, 'utf8'));
} catch {
  console.error('Could not read the file as JSON.');
  process.exit(66);
}

const result = runIntake(parsed, minConfidence === undefined ? {} : { minConfidence });
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 2);
