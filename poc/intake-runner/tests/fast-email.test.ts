// The test-only booking-confirmation email (proof of concept), run against a FAKE mail server on 127.0.0.1: no real mail server, address, password or email exists here, and every address and login is invented.
// A pass shows behaviour against a stand-in; it does not show what Yahoo's or Gmail's real servers will accept, or whether a message reaches an inbox.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmailSender, EMAIL_BLOB, emailProblems, isTestEmails, normalizeTestEmails, PROVIDERS } from '../src/fast-email.ts';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { TestEmails } from '../src/fast-email.ts';
import { customerEmail, emailDay, ownerEmail } from '../src/fast-email-copy.ts';
import type { EmailFacts } from '../src/fast-email-copy.ts';
import { createVault } from '../src/jobber-connector.ts';
import type { Protector } from '../src/jobber-connector.ts';
import { buildFastDeps, emailStatus, loadTestEmails, NUMBERS_BLOB } from '../src/founder-voice-fast.ts';
import type { FounderCallConfig } from '../src/founder-call-gate.ts';
import type { FounderVoiceConfig } from '../src/founder-voice-gate.ts';
import { ACCOUNT } from './helpers/jobber-mock.ts';

const OK: TestEmails = { sender: 'owner.test@yahoo.com', app_password: 'abcdEFGH12345678', customer: 'cust.test@gmail.com', owner: 'owner.test@yahoo.com' };
const FACTS: EmailFacts = { businessName: 'Drew Cleaning', serviceLabel: 'Standard cleaning', bedrooms: 2, bathrooms: 2, priceDollars: 199, date: '2026-11-03', startText: '10:00 AM', endText: '12:00 PM', zoneLabel: 'Central', address: '123 Invented Lane, Testville, CA 90210', customerName: 'Testa Invented', jobNumber: 1001 };

/** A tiny SMTP server that records what it is given. `silent` never answers; `rejectAuth` refuses every login. */
async function fakeSmtp(o: { silent?: boolean; rejectAuth?: boolean } = {}) {
  const messages: Array<{ from: string; to: string[]; data: string }> = []; const logins: Array<{ user: string; pass: string }> = []; let connections = 0; const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    connections++; sockets.add(sock); sock.on('close', () => sockets.delete(sock)); sock.on('error', () => undefined);
    if (o.silent) return;
    let buf = ''; let data = ''; let mode: 'cmd' | 'data' | 'plain' | 'user' | 'pass' = 'cmd'; let cur = { from: '', to: [] as string[] }; let user = '';
    const w = (s: string): void => { sock.write(`${s}\r\n`); };
    const login = (u: string, p: string): void => { logins.push({ user: u, pass: p }); w(o.rejectAuth === true ? '535 5.7.8 rejected' : '235 ok'); };
    w('220 fake.test ESMTP');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        if (mode === 'data') {
          data += buf; buf = ''; const end = data.indexOf('\r\n.\r\n'); if (end < 0) return;
          messages.push({ from: cur.from, to: cur.to, data: data.slice(0, end) }); data = ''; mode = 'cmd'; w('250 queued'); continue;
        }
        const i = buf.indexOf('\r\n'); if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2); let m: RegExpExecArray | null;
        if (mode === 'plain') { const [, u, p] = Buffer.from(line, 'base64').toString('utf8').split('\u0000'); mode = 'cmd'; login(u ?? '', p ?? ''); continue; }
        if (mode === 'user') { user = Buffer.from(line, 'base64').toString('utf8'); mode = 'pass'; w('334 UGFzc3dvcmQ6'); continue; }
        if (mode === 'pass') { mode = 'cmd'; login(user, Buffer.from(line, 'base64').toString('utf8')); continue; }
        if (/^(EHLO|HELO)/i.test(line)) { w('250-fake.test'); w('250-AUTH PLAIN LOGIN'); w('250 8BITMIME'); }
        else if ((m = /^AUTH PLAIN\s+(\S+)/i.exec(line)) !== null) { const [, u, p] = Buffer.from(m[1], 'base64').toString('utf8').split('\u0000'); login(u ?? '', p ?? ''); }
        else if (/^AUTH PLAIN$/i.test(line)) { mode = 'plain'; w('334 '); }
        else if (/^AUTH LOGIN/i.test(line)) { mode = 'user'; w('334 VXNlcm5hbWU6'); }
        else if ((m = /^MAIL FROM:\s*<([^>]*)>/i.exec(line)) !== null) { cur = { from: m[1], to: [] }; w('250 ok'); }
        else if ((m = /^RCPT TO:\s*<([^>]*)>/i.exec(line)) !== null) { cur.to.push(m[1]); w('250 ok'); }
        else if (/^DATA/i.test(line)) { mode = 'data'; w('354 go'); }
        else if (/^QUIT/i.test(line)) { w('221 bye'); sock.end(); }
        else w('250 ok');
      }
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as net.AddressInfo).port;
  return { port, messages, logins, connections: () => connections, close: async () => { for (const s of sockets) s.destroy(); await new Promise<void>((ok) => server.close(() => ok())); } };
}
const servers: Array<{ close: () => Promise<void> }> = []; after(async () => { for (const s of servers) await s.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const dirs: string[] = [];
const secrets = ['abcdEFGH12345678', 'cust.test', 'owner.test', '@gmail.com', '@yahoo.com'];
const noSecrets = (x: unknown): void => { const all = JSON.stringify(x); for (const s of secrets) assert.ok(!all.includes(s), `no ${s} in the output`); };

test('settings: a Yahoo or Gmail sender with a 16-character app password and two different plain recipient addresses are accepted; anything else is refused, line breaks and extra recipients included', () => {
  assert.equal(isTestEmails(OK), true, 'a Yahoo sender who is also the owner recipient');
  assert.equal(isTestEmails({ ...OK, sender: 'a.b@gmail.com' }), true); assert.equal(isTestEmails({ ...OK, sender: 'a.b@googlemail.com' }), true);
  assert.deepEqual(Object.keys(PROVIDERS).sort(), ['gmail.com', 'googlemail.com', 'yahoo.com']);
  for (const bad of [{ sender: 'a@outlook.com' }, { sender: 'a@yahoo.com.evil.test' }, { app_password: 'short' }, { app_password: 'abcd efgh 1234 5678' }, { app_password: 'abcdEFGH1234567!' }, { customer: OK.owner }, { owner: OK.customer },
    { customer: 'a b@gmail.com' }, { customer: 'a@gmail.com\r\nBcc: x@y.com' }, { customer: '<a@gmail.com>' }, { customer: 'a@gmail.com,b@gmail.com' }, { customer: '"a"@gmail.com' }, { customer: 'Name <a@gmail.com>' }, { owner: '' }, { sender: undefined }]) {
    assert.equal(isTestEmails({ ...OK, ...bad }), false, JSON.stringify(Object.keys(bad)));
  }
  assert.equal(isTestEmails(null), false); assert.equal(isTestEmails('x'), false);
  assert.equal(isTestEmails(normalizeTestEmails({ sender: ' Owner.Test@Yahoo.com ', app_password: 'abcd EFGH 1234 5678', customer: ' Cust.Test@Gmail.com', owner: 'OWNER.TEST@YAHOO.COM ' })), true, 'the setup tidies case, spaces and the password groups');
  assert.throws(() => createEmailSender({ settings: { ...OK, sender: 'a@outlook.com' } }), RangeError);
});

test('sending: one fixed test email goes to each approved address (and only that address), signed in with the app password, with no copy or blind copy and the exact subject and text', async () => {
  const smtp = await fakeSmtp(); servers.push(smtp); const logs: Array<[string, unknown]> = [];
  const send = createEmailSender({ settings: OK, testOnlyLocalPort: smtp.port, log: (c, d) => { logs.push([c, d]); } });
  const c = customerEmail(FACTS); const w = ownerEmail(FACTS);
  assert.deepEqual(await send('customer', c.subject, c.text), { ok: true }); assert.deepEqual(await send('owner', w.subject, w.text), { ok: true });
  assert.equal(smtp.messages.length, 2);
  assert.deepEqual(smtp.messages.map((m) => m.to), [[OK.customer], [OK.owner]], 'exactly one recipient each');
  assert.ok(smtp.messages.every((m) => m.from === OK.sender)); assert.ok(smtp.logins.every((l) => l.user === OK.sender && l.pass === OK.app_password), 'the sender logs in with the saved login');
  for (const [m, want] of [[smtp.messages[0], c], [smtp.messages[1], w]] as const) {
    assert.ok(!/^(cc|bcc):/im.test(m.data), 'no copy or blind copy'); assert.match(m.data, /^From: .*Drew Cleaning \(test\)/m); assert.ok(m.data.includes(`Subject: ${want.subject}`));
    const body = m.data.replace(/=\r\n/g, ''); assert.ok(body.includes('Booking reference: Jobber job #1001') && body.includes('Tuesday, November 3, 2026, 10:00 AM - 12:00 PM Central'), 'the body arrives with the booking reference and the full date');
  }
  assert.deepEqual(logs.map(([code]) => code), ['FAST_EMAIL_ACCEPTED', 'FAST_EMAIL_ACCEPTED']); noSecrets(logs);
});

test('sending: nothing can be sent to any other address or with a header or line-break trick; a refused request opens no connection at all', async () => {
  const smtp = await fakeSmtp(); servers.push(smtp); const logs: unknown[] = [];
  const send = createEmailSender({ settings: OK, testOnlyLocalPort: smtp.port, log: (c, d) => { logs.push([c, d]); } });
  assert.deepEqual(await send('attacker' as never, 'Subject', 'Body'), { ok: false, reason: 'NOT_ALLOWED' });
  assert.deepEqual(await send('cust.test@gmail.com' as never, 'Subject', 'Body'), { ok: false, reason: 'NOT_ALLOWED' }, 'an address is not a role');
  assert.deepEqual(await send('customer', 'Hi\r\nBcc: evil@example.com', 'Body'), { ok: false, reason: 'INVALID' });
  assert.deepEqual(await send('customer', 'Hi\nBcc: evil@example.com', 'Body'), { ok: false, reason: 'INVALID' });
  assert.deepEqual(await send('customer', '', 'Body'), { ok: false, reason: 'INVALID' }); assert.deepEqual(await send('customer', 'Hi', ''), { ok: false, reason: 'INVALID' });
  assert.deepEqual(await send('customer', 'Hi', 'a\u0000b'), { ok: false, reason: 'INVALID' }); assert.deepEqual(await send('customer', 'x'.repeat(201), 'Body'), { ok: false, reason: 'INVALID' });
  assert.equal(smtp.connections(), 0, 'no connection was opened for any of them'); assert.equal(smtp.messages.length, 0); noSecrets(logs);
});

test('sending: a login the server refuses, or a server that never answers, ends as a fixed reason; no address, password or server text appears in the result or the log, and nothing is sent', async () => {
  const bad = await fakeSmtp({ rejectAuth: true }); servers.push(bad); const logs: unknown[] = [];
  const r = await createEmailSender({ settings: OK, testOnlyLocalPort: bad.port, log: (c, d) => { logs.push([c, d]); } })('customer', 'Subject', 'Body');
  assert.deepEqual(r, { ok: false, reason: 'AUTH' }); assert.equal(bad.messages.length, 0); noSecrets([r, logs]);
  const quiet = await fakeSmtp({ silent: true }); servers.push(quiet); const logs2: unknown[] = [];
  const t0 = Date.now(); const r2 = await createEmailSender({ settings: OK, testOnlyLocalPort: quiet.port, timeoutMs: 300, log: (c, d) => { logs2.push([c, d]); } })('owner', 'Subject', 'Body');
  assert.equal(r2.ok, false); assert.ok(r2.reason === 'TIMEOUT', `timed out, got ${r2.reason}`); assert.ok(Date.now() - t0 < 3000, 'it gave up on time'); noSecrets([r2, logs2]);
  const down = createEmailSender({ settings: OK, transport: { sendMail: async () => { throw Object.assign(new Error(`login ${OK.app_password} for ${OK.customer} failed`), { code: 'EAUTH' }); } } });
  const r3 = await down('customer', 'Subject', 'Body'); assert.deepEqual(r3, { ok: false, reason: 'AUTH' }); noSecrets(r3);
  const half = createEmailSender({ settings: OK, transport: { sendMail: async () => ({ accepted: [OK.owner], rejected: [] }) } });
  assert.deepEqual(await half('customer', 'Subject', 'Body'), { ok: false, reason: 'REFUSED' }, 'accepted for a different address is not accepted');
});

test('the words: both emails carry the verified name, service, address, full date with the year, time, price and the Jobber job number; a test-only notice; no phone number; line breaks in a value cannot add a line or a header', () => {
  assert.equal(emailDay('2026-11-03'), 'Tuesday, November 3, 2026');
  const c = customerEmail(FACTS); const w = ownerEmail(FACTS);
  assert.equal(c.subject, 'Drew Cleaning DEMO booking confirmed: Tuesday, November 3, 2026'); assert.equal(w.subject, 'Drew Cleaning DEMO: new booking, Tuesday, November 3, 2026');
  for (const m of [c, w]) for (const line of ['Name: Testa Invented', 'Service: Standard cleaning, 2 bedrooms / 2 bathrooms', 'When: Tuesday, November 3, 2026, 10:00 AM - 12:00 PM Central', 'Where: 123 Invented Lane, Testville, CA 90210', 'Price: $199', 'Booking reference: Jobber job #1001']) assert.ok(m.text.split('\n').includes(line), line);
  assert.ok(c.text.startsWith('Hello Testa,\n\nThis is a test confirmation from Drew Cleaning (a fictional business).\n')); assert.ok(w.text.startsWith('New Drew Cleaning DEMO booking for Testa Invented.\n'));
  for (const m of [c, w]) { assert.match(m.text, /Test only: no cleaning service will occur and nothing was charged\./); assert.match(m.text, /Sent by Donceletta Bellamy - Developer Testing\. This address was approved for this test only\./); assert.ok(!/\d{10}|\+1/.test(m.text), 'no phone number'); }
  const none = customerEmail({ ...FACTS, jobNumber: undefined }); assert.ok(!/Booking reference/.test(none.text), 'no reference when Jobber gave none');
  for (const jn of [0, -1, 1.5, NaN]) assert.ok(!/Booking reference/.test(ownerEmail({ ...FACTS, jobNumber: jn }).text), `a job number of ${jn} is not shown`);
  const evil = customerEmail({ ...FACTS, customerName: 'Testa\r\nBcc: evil@example.com', address: '1 Lane\nInjected: yes', businessName: 'Drew\r\nCleaning' });
  assert.ok(!/[\r]/.test(evil.subject + evil.text) && !/\n(Bcc|Injected):/.test(evil.text) && !/[\r\n]/.test(evil.subject), 'values are one line each');
});

// ---------------------------------------------------------------- the composition: off by default, and fail-closed
const fakeProtector: Protector = { protect: async (p) => `P1:${Buffer.from([...Buffer.from(p)].reverse()).toString('hex')}`, unprotect: async (b) => Buffer.from(Buffer.from(b.slice(3), 'hex').reverse()).toString() };
const NOW = Date.parse('2026-11-02T15:00:00Z'); const HOURS = { 1: [['09:00', '17:00']] } as Record<string, Array<[string, string]>>;
async function composition(o: { emailsSaved?: boolean; env?: Record<string, string>; port?: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'fast-email-')); dirs.push(dir);
  const vault = createVault(dir, fakeProtector);
  await vault.saveCredentials({ client_id: 'test-client-id-0001', client_secret: 'test-client-secret-ZZZ-9f8e7d6c' });
  await vault.saveTokens({ access_token: 'tok-valid-0123456789', refresh_token: 'refresh-0123456789', expires_at: NOW + 3_000_000, account_id: ACCOUNT.id, account_name: ACCOUNT.name });
  await vault.saveBlob(NUMBERS_BLOB, JSON.stringify({ account_sid: `AC${'a'.repeat(32)}`, customer: '+15550100002', owner: '+15550100003' }));
  if (o.emailsSaved !== false) await vault.saveBlob(EMAIL_BLOB, JSON.stringify(OK));
  const config = { approval_id: 'fast-test', tenant: 'ws-founder-fasttest', numbers: ['+15550100001'], max_calls: 5, opening: { business_name: 'Drew Cleaning', greeting: 'x' } } as unknown as FounderCallConfig;
  const voice = { fast_test: { jobber_account_name: ACCOUNT.name, timezone: 'America/Chicago', hours: HOURS, duration_minutes: 120, price_dollars: 199, bedrooms: 2, bathrooms: 2, service_label: 'Standard cleaning', standing_approval: true, state: 'CA', lead_minutes: 60 } } as unknown as FounderVoiceConfig;
  const env = o.env ?? {}; const logs: unknown[] = [];
  const build = () => buildFastDeps({ config, voice, vaultDir: dir, protector: fakeProtector, env, fetch: globalThis.fetch, now: () => NOW, log: (c, d) => { logs.push([c, d]); }, textFrom: '+15550100001', ...(o.port === undefined ? {} : { emailTestPort: o.port }) });
  return { dir, env, build, logs };
}

test('composition: emails are OFF unless FAST_EMAILS is exactly "on", even with the addresses saved; the status says so', async () => {
  for (const env of [{}, { FAST_EMAILS: 'ON' }, { FAST_EMAILS: 'yes' }, { FAST_EMAILS: 'true' }, { FAST_EMAILS: '1' }, { FAST_EMAILS: ' on' }, { FAST_EMAILS: '' }]) {
    const r = await composition({ env }); const deps = await r.build();
    assert.equal(deps.emailsEnabled, false, JSON.stringify(env)); assert.equal(deps.sendEmail, undefined, 'no sender is even built');
    assert.deepEqual(await emailStatus({ vaultDir: r.dir, protector: fakeProtector, env }), { emailsSaved: true, emailsOn: false });
  }
  const saved = await composition({}); assert.deepEqual(await loadTestEmails(createVault(saved.dir, fakeProtector)), OK);
});

test('composition: FAST_EMAILS=on without the approved addresses saved stops the start (it never falls back to anything else); with them, a real sender is built and sends only to the two approved addresses', async () => {
  const none = await composition({ emailsSaved: false, env: { FAST_EMAILS: 'on' } });
  await assert.rejects(none.build(), /FAST_EMAILS is on but the approved test email addresses are not saved/);
  assert.deepEqual(await emailStatus({ vaultDir: none.dir, protector: fakeProtector, env: none.env }), { emailsSaved: false, emailsOn: true });
  const smtp = await fakeSmtp(); servers.push(smtp);
  const on = await composition({ env: { FAST_EMAILS: 'on' }, port: smtp.port }); const deps = await on.build();
  assert.equal(deps.emailsEnabled, true); assert.equal(typeof deps.sendEmail, 'function');
  assert.deepEqual(await deps.sendEmail!('customer', 'Subject', 'Body'), { ok: true }); assert.deepEqual(await deps.sendEmail!('owner', 'Subject', 'Body'), { ok: true });
  assert.deepEqual(smtp.messages.map((m) => m.to), [[OK.customer], [OK.owner]]); noSecrets(on.logs);
});

test('validation names WHICH field is not acceptable and never a value; a Yahoo sender is not refused for being Yahoo', () => {
  assert.deepEqual(emailProblems(OK), []);
  assert.deepEqual(emailProblems({ ...OK, sender: 'a@outlook.com' }), ['sender provider (must be yahoo.com or gmail.com)']);
  assert.deepEqual(emailProblems({ ...OK, sender: 'a b@yahoo.com' }), ['sender address']);
  assert.deepEqual(emailProblems({ ...OK, app_password: 'tooShort' }), ['app password']);
  assert.deepEqual(emailProblems({ ...OK, app_password: 'abcdEFGH1234567\u200b' }), ['app password'], 'an invisible character is caught as the password, not accepted');
  assert.deepEqual(emailProblems({ ...OK, customer: 'x@@gmail.com' }), ['customer address']); assert.deepEqual(emailProblems({ ...OK, owner: 'no-at-sign' }), ['owner address']);
  assert.deepEqual(emailProblems({ ...OK, customer: OK.owner }), ['customer and owner are the same']);
  assert.deepEqual(emailProblems({ sender: 1, app_password: 2, customer: 3, owner: 4 }), ['sender address', 'app password', 'customer address', 'owner address']);
  assert.deepEqual(emailProblems(null), ['input']);
  for (const bad of [{ ...OK, app_password: 'abcdEFGH1234567!' }, { ...OK, customer: 'who@gmail.com\r\nBcc: x@y.com' }]) noSecrets(emailProblems(bad));
});

test('the setup program: a refused save names the field, never echoes a value, and writes nothing; the old Gmail-only wording is gone and a Yahoo sender is accepted by the checks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fast-email-setup-')); dirs.push(dir);
  const run = (j: unknown) => spawnSync('node', ['src/fast-test-setup-main.ts', 'save-emails'], { input: JSON.stringify(j), encoding: 'utf8', env: { ...process.env, JOBBER_STORE_DIR: dir }, cwd: new URL('..', import.meta.url) });
  const bad = run({ ...OK, app_password: 'abcdEFGH12345678!!', customer: OK.owner });
  assert.equal(bad.status, 2); assert.match(bad.stdout, /^refused: nothing was saved; not acceptable: app password, customer and owner are the same /);
  assert.ok(!/Gmail sender/.test(bad.stdout), 'the outdated Gmail-only wording is gone'); assert.match(bad.stdout, /yahoo\.com or gmail\.com/); noSecrets([bad.stdout, bad.stderr]);
  assert.ok(!existsSync(join(dir, `${EMAIL_BLOB}.enc`)), 'nothing was written');
  const provider = run({ ...OK, sender: 'x@outlook.com' }); assert.match(provider.stdout, /not acceptable: sender provider \(must be yahoo\.com or gmail\.com\)/);
  const notJson = spawnSync('node', ['src/fast-test-setup-main.ts', 'save-emails'], { input: 'not json', encoding: 'utf8', env: { ...process.env, JOBBER_STORE_DIR: dir }, cwd: new URL('..', import.meta.url) }); assert.match(notJson.stdout, /^refused: the input was not the expected JSON/);
});
