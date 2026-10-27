// Runs the owner's contact lookup (see contact-lookup.ts). Local, interactive use only.
import { run } from './contact-lookup.ts';

process.exitCode = run(process.argv.slice(2), process.env, { out: (l) => console.log(l), err: (l) => console.error(l), isTty: process.stdout.isTTY === true });
