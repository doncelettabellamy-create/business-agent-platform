// Test-only booking-confirmation EMAIL for the controlled fast Drew test call (proof of concept). Nothing else imports the mail library.
//
// What it can do: send ONE fixed test email (fast-email-copy.ts) to the founder-approved CUSTOMER address or the founder-approved OWNER address, through the sender's own mail server (Yahoo or Gmail SMTP, chosen by the
// sender address) with an app password, and say whether the server accepted it. What it cannot do: send to any other address. The two addresses and the sender login live only in the protected file `test-emails` (written by the private setup, never in the repository, the
// config, a log or a command line) and are read here; the call logic names a ROLE ('customer' or 'owner'), never an address, so there is no parameter through which another address could be passed.
//
// "Accepted" means the sender's mail server took the message. It does not mean the message reached an inbox: that is not measurable from here and is never claimed.
// Failure text is fixed: a server's reply (which can echo an address or a login) is never logged, returned or thrown on.

import nodemailer from 'nodemailer';
import { sampleEmail } from './fast-email-copy.ts';

export const EMAIL_BLOB = 'test-emails';
/** The private, protected record: the sender (a Yahoo or Gmail account), its app password, and the two approved recipients. The sender may also be one of the two recipients. */
export interface TestEmails { sender: string; app_password: string; customer: string; owner: string }
export type EmailRole = 'customer' | 'owner';
export type EmailReason = 'INVALID' | 'NOT_ALLOWED' | 'AUTH' | 'TIMEOUT' | 'REFUSED' | 'ERROR';
export interface EmailResult { ok: boolean; reason?: EmailReason }

/** A plain address only: no display name, quotes, angle brackets, commas, spaces or line breaks (so nothing can add a second recipient or a header). */
const ADDRESS = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,3}$/;
/** An app password is sixteen letters or digits (Google shows it in groups of four; the spaces are not part of it). Its exact alphabet at Yahoo is UNVERIFIED, so the check is only this loose shape. */
const APP_PASSWORD = /^[A-Za-z0-9]{16}$/;
/** The mail servers the sender may log in to, by the sender's own domain. Both take a TLS connection from the first byte (port 465) and an app password. */
export const PROVIDERS: Readonly<Record<string, { host: string; port: number }>> = Object.freeze({
  'yahoo.com': { host: 'smtp.mail.yahoo.com', port: 465 },
  'gmail.com': { host: 'smtp.gmail.com', port: 465 },
  'googlemail.com': { host: 'smtp.gmail.com', port: 465 },
});
const providerOf = (sender: string): { host: string; port: number } | undefined => PROVIDERS[sender.slice(sender.lastIndexOf('@') + 1)];
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Which FIELDS of the settings are not acceptable, as fixed names only (never a value, and for the app password never even its length). Empty when all are. */
export function emailProblems(x: unknown): string[] {
  if (typeof x !== 'object' || x === null) return ['input'];
  const e = x as Record<string, unknown>; const p: string[] = [];
  if (typeof e.sender !== 'string' || !ADDRESS.test(e.sender)) p.push('sender address'); else if (providerOf(e.sender) === undefined) p.push('sender provider (must be yahoo.com or gmail.com)');
  if (typeof e.app_password !== 'string' || !APP_PASSWORD.test(e.app_password)) p.push('app password');
  if (typeof e.customer !== 'string' || !ADDRESS.test(e.customer)) p.push('customer address');
  if (typeof e.owner !== 'string' || !ADDRESS.test(e.owner)) p.push('owner address');
  if (typeof e.customer === 'string' && e.customer === e.owner) p.push('customer and owner are the same');
  return p;
}
export const isTestEmails = (x: unknown): x is TestEmails => emailProblems(x).length === 0;
/** The setup's tidy-up before the check: trimmed, addresses lower-cased, the app password without its spaces. */
export function normalizeTestEmails(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const r = raw as Record<string, unknown>; const s = (v: unknown): unknown => (typeof v === 'string' ? v.trim() : v);
  const a = (v: unknown): unknown => (typeof v === 'string' ? v.trim().toLowerCase() : v);
  return { sender: a(r.sender), app_password: typeof r.app_password === 'string' ? r.app_password.replace(/\s+/g, '') : s(r.app_password), customer: a(r.customer), owner: a(r.owner) };
}

/** The part of nodemailer's transport this file uses (so tests can stand in for it). */
export interface MailTransport { sendMail(message: Record<string, unknown>): Promise<{ accepted?: unknown; rejected?: unknown }>; close?(): void }
export interface EmailSenderOptions {
  settings: TestEmails;
  log?: (code: string, detail?: Record<string, string | number | boolean>) => void;
  /** Bound on one send, milliseconds. Default 8000. */
  timeoutMs?: number;
  /** TEST ONLY: a stand-in transport. */
  transport?: MailTransport;
  /** TEST ONLY: a local fake SMTP server on 127.0.0.1 (no TLS) in place of Gmail. */
  testOnlyLocalPort?: number;
}

export function createEmailSender(o: EmailSenderOptions): (role: EmailRole, subject: string, text: string) => Promise<EmailResult> {
  if (!isTestEmails(o?.settings)) throw new RangeError('the email settings are not acceptable');
  const s = o.settings; const timeoutMs = o.timeoutMs ?? 8000; const log = o.log ?? ((): void => undefined);
  return async (role, subject, text) => {
    const to = role === 'customer' ? s.customer : role === 'owner' ? s.owner : undefined;   // the ONLY two addresses there are
    if (to === undefined) { log('FAST_EMAIL_FAILED', { reason: 'NOT_ALLOWED' }); return { ok: false, reason: 'NOT_ALLOWED' }; }
    if (typeof subject !== 'string' || subject.length < 1 || subject.length > 200 || CONTROL.test(subject) || typeof text !== 'string' || text.length < 1 || text.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      log('FAST_EMAIL_FAILED', { role, reason: 'INVALID' }); return { ok: false, reason: 'INVALID' };
    }
    const transport: MailTransport = o.transport ?? nodemailer.createTransport(o.testOnlyLocalPort !== undefined
      ? { host: '127.0.0.1', port: o.testOnlyLocalPort, secure: false, ignoreTLS: true, auth: { user: s.sender, pass: s.app_password }, connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs, disableFileAccess: true, disableUrlAccess: true }
      : { host: providerOf(s.sender)!.host, port: providerOf(s.sender)!.port, secure: true, auth: { user: s.sender, pass: s.app_password }, tls: { minVersion: 'TLSv1.2' }, connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs, disableFileAccess: true, disableUrlAccess: true }) as unknown as MailTransport;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const sending = transport.sendMail({ from: { name: 'Drew Cleaning (test)', address: s.sender }, to, envelope: { from: s.sender, to: [to] }, subject, text, disableFileAccess: true, disableUrlAccess: true });
      const info = await Promise.race([sending, new Promise<never>((_, bad) => { timer = setTimeout(() => bad(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), timeoutMs); timer.unref?.(); })]);
      const accepted = Array.isArray(info.accepted) ? info.accepted.map((x) => String(typeof x === 'object' && x !== null ? (x as { address?: unknown }).address : x).toLowerCase()) : [];
      const rejected = Array.isArray(info.rejected) ? info.rejected.length : 0;
      const ok = accepted.length === 1 && accepted[0] === to && rejected === 0;
      log(ok ? 'FAST_EMAIL_ACCEPTED' : 'FAST_EMAIL_FAILED', ok ? { role } : { role, reason: 'REFUSED' });
      return ok ? { ok: true } : { ok: false, reason: 'REFUSED' };
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      const reason: EmailReason = code === 'EAUTH' ? 'AUTH' : code === 'TIMEOUT' || code === 'ETIMEDOUT' ? 'TIMEOUT' : code === 'EENVELOPE' || code === 'EMESSAGE' ? 'REFUSED' : 'ERROR';
      log('FAST_EMAIL_FAILED', { role, reason }); return { ok: false, reason };   // the error's own text is never used
    } finally { if (timer !== undefined) clearTimeout(timer); try { transport.close?.(); } catch { /* closed */ } }
  };
}

/**
 * The setup's EMAIL CHECK. Without `send` it sends nothing and opens no connection: it only says whether the saved settings are in place. With `send` it sends ONE sample email (invented details, clearly marked) to the OWNER address
 * only, through the same allowlisted sender, and prints status words: never an address, a login or a server's text. "Accepted" means the mail server took it, not that it reached an inbox.
 */
export async function emailCheck(o: { settings: TestEmails | undefined; send: boolean; senderOptions?: Partial<EmailSenderOptions> }): Promise<{ ok: boolean; lines: string[] }> {
  if (o.settings === undefined) return { ok: false, lines: ['not ready: the test email sender and addresses are not saved; run fast-test-enter-emails.ps1 first. Nothing was sent.'] };
  if (!o.send) return { ok: true, lines: ['ready: the settings are saved. This would send ONE sample email to the OWNER address only, with invented details. Add --send to send it. Nothing was sent.'] };
  const m = sampleEmail(); const r = await createEmailSender({ ...(o.senderOptions ?? {}), settings: o.settings })('owner', m.subject, m.text);
  if (r.ok) return { ok: true, lines: ['accepted: the mail server took ONE sample email for the OWNER address. That is not delivery: look in the inbox AND the spam folder.'] };
  const hint: Record<string, string> = { AUTH: 'the mail server refused the sender login: create a new app password and run fast-test-enter-emails.ps1 again', TIMEOUT: 'the mail server did not answer in time', REFUSED: 'the mail server did not accept the message', INVALID: 'the message was not acceptable', NOT_ALLOWED: 'the recipient is not allowed', ERROR: 'the connection or the server failed' };
  return { ok: false, lines: [`failed (${r.reason ?? 'ERROR'}): ${hint[r.reason ?? 'ERROR'] ?? hint.ERROR}. Nothing else was sent.`] };
}
