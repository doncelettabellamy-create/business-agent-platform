// Runs the owner's follow-up tool (see followup.ts). Local, interactive use only.
import { run } from './followup.ts';

process.exitCode = run(process.argv.slice(2), process.env, { out: (l) => console.log(l), err: (l) => console.error(l), isTty: process.stdout.isTTY === true && process.stdin.isTTY === true });
