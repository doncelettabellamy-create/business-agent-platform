// Private setup and read-only checks for the fast Drew test call (proof of concept). Nothing else imports this file.
//
//   node src/fast-test-setup-main.ts save-numbers      reads {"account_sid": "AC...", "customer": "+1...", "owner": "+1..."} from STANDARD INPUT (use fast-test-enter-numbers.ps1, which prompts privately) and stores it
//                                                      protected for this Windows user in the private folder (outside the repository). Prints no number.
//   node src/fast-test-setup-main.ts save-emails      reads {"sender": "x@gmail.com", "app_password": "...", "customer": "...", "owner": "..."} from STANDARD INPUT (use fast-test-enter-emails.ps1, which prompts privately) and stores it protected. Prints nothing private.
//   node src/fast-test-setup-main.ts email-check [--send]   without --send: only says whether the email settings are saved (no connection, nothing sent). With --send: sends ONE sample email (invented details) to the OWNER address only and prints a status word.
//   node src/fast-test-setup-main.ts status            yes/no only: are the approved numbers saved, is Jobber connected, are Jobber writes switched on.
//   node src/fast-test-setup-main.ts sms-check --sid AC... [--number +1...] [--config founder-voice-call.config.json]
//                                                      READ-ONLY questions to Twilio (needs TWILIO_AUTH_TOKEN in the environment): can the Drew number send texts, and what has been registered for US business
//                                                      texting. It sends nothing and changes nothing. Prints capability and status words only, never a number or a token.
//
// The private folder is JOBBER_STORE_DIR (absolute), or ".drew-jobber" in the user's home folder; a test run never uses the default (private-folder.ts).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateFolder } from './private-folder.ts';
import { createVault } from './jobber-connector.ts';
import { windowsProtector } from './jobber-dpapi.ts';
import { emailStatus, fastStatus, isTestNumbers, loadTestEmails, loadTestNumbers, NUMBERS_BLOB } from './founder-voice-fast.ts';
import { EMAIL_BLOB, emailCheck, emailProblems, isTestEmails, normalizeTestEmails } from './fast-email.ts';
import { appendConsent, ownerRef } from './fast-consent.ts';
import { OWNER_SCRIPT_ID, ownerConsentText } from './fast-sms-copy.ts';
import { E164, messagingSetup, SID, smsCapability } from './twilio-messaging.ts';
import type { HttpFetch } from './twilio-messaging.ts';

const argv = process.argv.slice(2); const cmd = argv[0];
const opt = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const say = (s: string): void => { console.log(s); };
const dir = privateFolder();   // fail-closed: a test run never gets the real folder (private-folder.ts)
const protector = windowsProtector();
const readStdin = (): Promise<string> => new Promise((ok) => { const b: Buffer[] = []; process.stdin.on('data', (x) => b.push(x)); process.stdin.on('end', () => ok(Buffer.concat(b).toString('utf8').replace(/^﻿/, ''))); });

async function main(): Promise<number> {
  if (cmd === 'save-numbers') {
    let j: unknown; try { j = JSON.parse(await readStdin()); } catch { say('refused: the input was not the expected JSON'); return 2; }
    if (!isTestNumbers(j)) { say('refused: need a Twilio account id (AC and 32 hex characters), a customer test number and a DIFFERENT owner test number, each in +1XXXXXXXXXX form'); return 2; }
    const { account_sid, customer, owner } = j;
    await createVault(dir, protector).saveBlob(NUMBERS_BLOB, JSON.stringify({ account_sid, customer, owner }));
    say('saved: the approved test numbers and the Twilio account id are stored protected for this Windows user (nothing was printed)'); return 0;
  }
  if (cmd === 'save-emails') {
    let j: unknown; try { j = normalizeTestEmails(JSON.parse(await readStdin())); } catch { say('refused: the input was not the expected JSON'); return 2; }
    const problems = emailProblems(j);
    if (problems.length > 0) { say(`refused: nothing was saved; not acceptable: ${problems.join(', ')} (a sender address at yahoo.com or gmail.com, its 16-character app password, and two DIFFERENT plain recipient addresses)`); return 2; }
    if (!isTestEmails(j)) return 2;
    await createVault(dir, protector).saveBlob(EMAIL_BLOB, JSON.stringify({ sender: j.sender, app_password: j.app_password, customer: j.customer, owner: j.owner }));
    say('saved: the test email sender and the two approved recipient addresses are stored protected for this Windows user (nothing was printed; emails stay OFF until FAST_EMAILS=on)'); return 0;
  }
  if (cmd === 'email-check') { const r = await emailCheck({ settings: await loadTestEmails(createVault(dir, protector)), send: argv.includes('--send') }); for (const l of r.lines) say(l); return r.ok ? 0 : 1; }
  if (cmd === 'owner-consent-text' || cmd === 'record-owner-consent') {
    let business = 'Drew Cleaning'; try { const c = JSON.parse(readFileSync(opt('config') ?? 'founder-voice-call.config.json', 'utf8')) as { opening?: { business_name?: unknown } }; if (typeof c.opening?.business_name === 'string') business = c.opening.business_name; } catch { /* the demo name stays */ }
    if (cmd === 'owner-consent-text') { say(ownerConsentText(business)); return 0; }
    let j: unknown; try { j = JSON.parse(await readStdin()); } catch { say('refused: the input was not the expected JSON'); return 2; }
    const answer = (j as { answer?: unknown }).answer; if (answer !== 'yes' && answer !== 'no') { say('refused: the answer must be yes or no'); return 2; }
    const vault = createVault(dir, protector); const nums = await loadTestNumbers(vault);
    if (nums === undefined) { say('refused: save the approved test numbers first'); return 2; }
    const ok = await appendConsent(vault, { v: 1, role: 'owner', at: new Date().toISOString(), method: 'private_setup', script: OWNER_SCRIPT_ID, result: answer, ref: ownerRef(nums.owner) });
    if (!ok) { say('failed: the consent record could not be written'); return 1; }
    say(answer === 'yes' ? 'recorded: owner text consent GIVEN (protected evidence: time, script, answer; no number or name)' : 'recorded: owner text consent DECLINED (no owner text will be sent)'); return 0;
  }
  if (cmd === 'status') { const s = await fastStatus({ vaultDir: dir, protector, env: process.env }); say(`approved test numbers saved: ${s.numbersPresent}`); say(`texts enabled (FAST_TEXTS=on): ${s.textsOn}   (off is the default: no real text can be sent)`); say(`owner text consent recorded: ${s.ownerConsent}`); say(`Jobber connected: ${s.jobberConnected}`); say(`Jobber writes switched on (JOBBER_ALLOW_WRITES=test-account): ${s.jobberWritesOn}`); const em = await emailStatus({ vaultDir: dir, protector, env: process.env }); say(`approved test emails saved: ${em.emailsSaved}`); say(`emails enabled (FAST_EMAILS=on): ${em.emailsOn}   (off is the default: no email can be sent)`); return 0; }
  if (cmd === 'sms-check') {
    const sid = opt('sid'); if (sid === undefined || !SID.test(sid)) { say('refused: --sid AC... is required'); return 2; }
    let number = opt('number');
    if (number === undefined) { try { const c = JSON.parse(readFileSync(opt('config') ?? 'founder-voice-call.config.json', 'utf8')) as { numbers?: unknown }; if (Array.isArray(c.numbers) && typeof c.numbers[0] === 'string') number = c.numbers[0]; } catch { /* below */ } }
    if (number === undefined || !E164.test(number)) { say('refused: the Drew number could not be read (pass --number or --config)'); return 2; }
    if (typeof process.env.TWILIO_AUTH_TOKEN !== 'string' || process.env.TWILIO_AUTH_TOKEN.length < 8) { say('refused: TWILIO_AUTH_TOKEN is not set in this environment'); return 2; }
    const ctx = { accountSid: sid, authToken: () => process.env.TWILIO_AUTH_TOKEN, fetch: globalThis.fetch as unknown as HttpFetch, diag: () => undefined };
    const cap = await smsCapability(ctx, number);
    say(`Drew number found on the account: ${cap.status === 'found'}${cap.status === 'unreadable' ? ' (the account could not be read: check the account id and token)' : ''}`);
    if (cap.status === 'found') say(`  can send and receive texts (SMS): ${cap.sms}   picture messages: ${cap.mms}   voice: ${cap.voice}`);
    const m = await messagingSetup(ctx, number);
    const words = (a: string[] | undefined): string => (a === undefined ? 'could not be read' : a.length === 0 ? 'none' : [...new Set(a)].join(', '));
    say(`US business texting registration (A2P 10DLC): brand registrations: ${words(m.brands)}`);
    if (m.services === undefined) say('  messaging services: could not be read'); else if (m.services.length === 0) say('  messaging services: none (the number is not attached to a registered campaign)');
    else m.services.forEach((s, i) => say(`  messaging service ${i + 1}: campaign registrations: ${words(s.campaigns)}; the Drew number is attached: ${s.hasNumber ?? 'could not be read'}`));
    say(`  toll-free verifications: ${words(m.tollFree)}`);
    return 0;
  }
  say('usage: save-numbers | owner-consent-text | record-owner-consent | status | sms-check --sid AC... [--number +1...] [--config file]'); return 2;
}
main().then((c) => { process.exitCode = c; }, () => { console.error('failed: unexpected error'); process.exitCode = 1; });
