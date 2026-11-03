// Applies the controlled fast test setup to the two PRIVATE config files, with a backup of each first (proof of concept). Nothing else imports this file.
//
//   node src/fast-test-config-main.ts dry-run  --call founder-voice-call.config.json --voice founder-voice.config.json    reads the answers (JSON) from STANDARD INPUT, validates, prints the exact opening the caller would hear and what
//                                                                                                                             would change (by key name), and writes NOTHING.
//   node src/fast-test-config-main.ts apply    --call ... --voice ...                                                       the same, then: backs up both files (timestamped, never overwriting a backup, each copy checked identical),
//                                                                                                                             checks the new pair against the gate's own validators, and writes both files.
// The answers are JSON on standard input: either the finished answers, or {"raw": {account, timezone, days, open, close, duration, state, approval}} exactly as typed ("Mon-Fri", "9am", "2 hours", "Central" are understood).
// The answers are business facts the founder supplies (time zone, open hours, cleaning duration, the Jobber test account's name, the standing test approval). No secret is read or printed.

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { answersFromText, applyFastTest } from './fast-test-config.ts';
import type { FastTestAnswers, RawScheduleAnswers } from './fast-test-config.ts';

const argv = process.argv.slice(2); const cmd = argv[0];
const opt = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const say = (s: string): void => { console.log(s); };
const readStdin = (): Promise<string> => new Promise((ok) => { const b: Buffer[] = []; process.stdin.on('data', (x) => b.push(x)); process.stdin.on('end', () => ok(Buffer.concat(b).toString('utf8').replace(/^﻿/, ''))); });
const plain = (p: string | undefined): p is string => typeof p === 'string' && /^[\w./\\:-]{1,260}\.json$/.test(p) && !p.includes('..');

async function main(): Promise<number> {
  const callPath = opt('call'); const voicePath = opt('voice');
  if ((cmd !== 'dry-run' && cmd !== 'apply') || !plain(callPath) || !plain(voicePath)) { say('usage: dry-run|apply --call <call config>.json --voice <voice config>.json   (answers as JSON on standard input)'); return 2; }
  let answers: FastTestAnswers; let call: unknown; let voice: unknown;
  try {
    const parsed = JSON.parse(await readStdin()) as { raw?: RawScheduleAnswers } & FastTestAnswers;
    if (parsed.raw !== undefined) {   // the answers exactly as typed: read here (and tested), field by field, so a rejection says which answer
      const t = answersFromText(parsed.raw);
      if (!t.ok) { for (const p of t.problems) say(`problem: ${p}`); say('nothing was changed'); return 1; }
      answers = t.answers;
    } else answers = parsed;
  } catch { say('refused: the answers were not the expected JSON'); return 2; }
  try { call = JSON.parse(readFileSync(callPath, 'utf8')); voice = JSON.parse(readFileSync(voicePath, 'utf8')); } catch { say('refused: a config file could not be read as JSON'); return 2; }
  const r = applyFastTest(call, voice, answers);
  if (!r.ok) { for (const p of r.problems) say(`problem: ${p}`); say('nothing was changed'); return 1; }
  say(`The opening the caller would hear (exactly): ${r.opening}`);
  say('Jack is honest if asked: a caller who asks whether this is a person, a robot or an A I is told that Jack is an A I assistant, at any step.');
  say('Call config changes: opening (the long disclosure, the special and the request to say yes are removed; the opening is exactly the greeting above, which asks for the name).');
  say(`Voice config changes: fast_test added (price ${r.voice.fast_test?.price_dollars}, ${r.voice.fast_test?.bedrooms} bed / ${r.voice.fast_test?.bathrooms} bath, ${r.voice.fast_test?.duration_minutes} minutes, ${r.voice.fast_test?.timezone}, standing test approval ${r.voice.fast_test?.standing_approval}).`);
  say(r.voice.fast_test?.standing_approval === true ? 'STANDING APPROVAL: GIVEN - the call may book in the Jobber test account without asking again.' : 'STANDING APPROVAL: NOT GIVEN - the call will end before booking. Run this again and type YES to give it.');
  say('Both files are part of the approval digest: the start helper recomputes it from the new pair when you start the server.');
  if (cmd === 'dry-run') { say('DRY RUN: nothing was written.'); return 0; }
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const backups: Array<[string, string]> = [[callPath, `${callPath}.before-fast-test-${stamp}.bak.json`], [voicePath, `${voicePath}.before-fast-test-${stamp}.bak.json`]];
  for (const [src, bk] of backups) { if (existsSync(bk)) { say('refused: a backup with this name exists; nothing was changed'); return 1; } }
  for (const [src, bk] of backups) { copyFileSync(src, bk); if (readFileSync(src, 'utf8') !== readFileSync(bk, 'utf8')) { say('refused: a backup did not match its original; nothing was changed'); return 1; } }
  const out: Array<[string, unknown]> = [[callPath, r.call], [voicePath, r.voice]];
  for (const [p, obj] of out) { const tmp = `${p}.tmp-${process.pid}`; writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`); renameSync(tmp, p); }
  say(`APPLIED. Backups: ${backups.map(([, b]) => b).join(' | ')}`); say('Rollback: copy each backup over its original.');
  return 0;
}
main().then((c) => { process.exitCode = c; }, () => { console.error('failed: unexpected error'); process.exitCode = 1; });
