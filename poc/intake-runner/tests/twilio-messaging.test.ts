// The Twilio helpers of the fast Drew test call, against a local stand-in for Twilio's REST API. No real request, number or token is used; every value is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { callerOf, sendSms, smsCapability, verifyDelivery } from '../src/twilio-messaging.ts';
import type { HttpFetch, TwilioCtx } from '../src/twilio-messaging.ts';

const SID = `AC${'a1'.repeat(16)}`; const TOKEN = 'invented-auth-token-0123456789abcdef'; const CALL = `CA${'b2'.repeat(16)}`; const MSG = `SM${'c3'.repeat(16)}`;
const DREW = '+15550100001'; const CUSTOMER = '+15550100002'; const OWNER = '+15550100003'; const STRANGER = '+15550100099';

async function mock() {
  const seen: Array<{ method: string; url: string; auth: string; body: string }> = []; const statuses: string[] = ['queued', 'sent', 'delivered']; let postStatus = 201;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8'); seen.push({ method: req.method ?? '', url: req.url ?? '', auth: String(req.headers.authorization ?? ''), body });
      const j = (s: number, o: unknown): void => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === `/2010-04-01/Accounts/${SID}/Calls/${CALL}.json`) return j(200, { from: CUSTOMER, to: DREW });
      if (req.url === `/2010-04-01/Accounts/${SID}/Messages.json` && req.method === 'POST') return postStatus === 201 ? j(201, { sid: MSG, status: 'queued' }) : j(postStatus, { code: 21608, message: 'secret-looking text' });
      if (req.url === `/2010-04-01/Accounts/${SID}/Messages/${MSG}.json`) { const s = statuses.length > 1 ? statuses.shift()! : statuses[0]; return j(200, { status: s, error_code: s === 'undelivered' ? 30003 : null }); }
      if (req.url?.startsWith(`/2010-04-01/Accounts/${SID}/IncomingPhoneNumbers.json`)) return j(200, { incoming_phone_numbers: req.url.includes(encodeURIComponent(DREW)) ? [{ capabilities: { voice: true, sms: true, mms: false } }] : [] });
      j(404, {});
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const logs: Array<[string, unknown]> = [];
  const ctx: TwilioCtx = { accountSid: SID, authToken: () => TOKEN, fetch: globalThis.fetch as unknown as HttpFetch, diag: (c, d) => { logs.push([c, d]); }, approved: new Set([CUSTOMER, OWNER]), origin };
  return { ctx, seen, logs, statuses, setPostStatus: (n: number) => { postStatus = n; }, close: () => new Promise<void>((ok) => { server.close(() => ok()); server.closeAllConnections(); }) };
}

test('caller ID: read from the call\'s own record by its CallSid; a malformed sid or an unreadable record gives undefined (the caller is asked for a number); the token only goes in the Authorization header', async () => {
  const m = await mock();
  try {
    assert.equal(await callerOf(m.ctx, CALL), CUSTOMER);
    assert.equal(await callerOf(m.ctx, 'CA123'), undefined); assert.equal(await callerOf(m.ctx, undefined), undefined); assert.equal(await callerOf(m.ctx, `CA${'f'.repeat(32)}`), undefined);
    assert.equal(m.seen[0].auth, `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`);
    assert.ok(!m.seen[0].url.includes(TOKEN) && !m.seen[0].body.includes(TOKEN));
    assert.equal(await callerOf({ ...m.ctx, authToken: () => undefined }, CALL), undefined, 'no token: unreadable, nothing sent');
    assert.ok(!JSON.stringify(m.logs).includes(TOKEN) && !JSON.stringify(m.logs).includes('555'));
  } finally { await m.close(); }
});

test('sending: only to approved numbers, as a form with To, From and Body, plain ASCII of at most 459 characters; anything else is refused BEFORE a request; failures carry a fixed code and Twilio\'s number, never its text', async () => {
  const m = await mock();
  try {
    const ok = await sendSms(m.ctx, { from: DREW, to: CUSTOMER, body: 'Drew Cleaning: your cleaning is booked.' });
    assert.deepEqual(ok, { ok: true, sid: MSG });
    const post = m.seen.find((s) => s.method === 'POST')!; const f = Object.fromEntries(new URLSearchParams(post.body));
    assert.deepEqual([f.To, f.From, f.Body], [CUSTOMER, DREW, 'Drew Cleaning: your cleaning is booked.']);
    const before = m.seen.length;
    assert.deepEqual(await sendSms(m.ctx, { from: DREW, to: STRANGER, body: 'hi' }), { ok: false, error: 'NOT_APPROVED' });
    assert.deepEqual(await sendSms({ ...m.ctx, approved: undefined }, { from: DREW, to: CUSTOMER, body: 'hi' }), { ok: false, error: 'NOT_APPROVED' });
    for (const bad of [{ to: '5550100002' }, { from: '123' }, { body: '' }, { body: 'x'.repeat(460) }, { body: 'smart “quotes”' }, { body: 'emoji \u{1F600}' }]) assert.deepEqual(await sendSms(m.ctx, { from: DREW, to: CUSTOMER, body: 'ok', ...bad }), { ok: false, error: 'BAD_REQUEST' }, JSON.stringify(bad).slice(0, 30));
    assert.equal(m.seen.length, before, 'nothing was requested for a refused text');
    assert.deepEqual(await sendSms({ ...m.ctx, authToken: () => undefined }, { from: DREW, to: CUSTOMER, body: 'hi' }), { ok: false, error: 'NO_TOKEN' });
    m.setPostStatus(400);
    assert.deepEqual(await sendSms(m.ctx, { from: DREW, to: OWNER, body: 'hi' }), { ok: false, error: 'REFUSED', twilioCode: 21608 });
    m.setPostStatus(429); assert.deepEqual(await sendSms(m.ctx, { from: DREW, to: OWNER, body: 'hi' }), { ok: false, error: 'RATE_LIMITED' });
    const all = JSON.stringify(m.logs); for (const s of [TOKEN, CUSTOMER, OWNER, DREW, 'secret-looking', 'booked']) assert.ok(!all.includes(s), `no ${s} in the diagnostics`);
  } finally { await m.close(); }
});

test('delivery: polled until final; delivered is the only success; a text that stayed "sent" is unconfirmed, never delivered; undelivered and failed are reported with Twilio\'s code', async () => {
  const m = await mock(); const sleep = async (): Promise<void> => undefined;
  try {
    assert.equal(await verifyDelivery(m.ctx, MSG, { sleep }), 'delivered');
    m.statuses.splice(0, m.statuses.length, 'queued', 'sent');
    assert.equal(await verifyDelivery(m.ctx, MSG, { sleep, maxMs: 4500, intervalMs: 1500 }), 'unconfirmed');
    m.statuses.splice(0, m.statuses.length, 'sent', 'undelivered');
    assert.equal(await verifyDelivery(m.ctx, MSG, { sleep }), 'undelivered');
    assert.ok(m.logs.some(([c, d]) => c === 'TWILIO_SMS_NOT_DELIVERED' && (d as { twilioCode?: number }).twilioCode === 30003));
    m.statuses.splice(0, m.statuses.length, 'failed');
    assert.equal(await verifyDelivery(m.ctx, MSG, { sleep }), 'failed');
    assert.equal(await verifyDelivery(m.ctx, 'SM123', { sleep }), 'unconfirmed');
  } finally { await m.close(); }
});

test('capability: the number\'s own record says whether it can send texts; an unknown number and an unreadable answer are different results', async () => {
  const m = await mock();
  try {
    assert.deepEqual(await smsCapability(m.ctx, DREW), { status: 'found', sms: true, mms: false, voice: true });
    assert.deepEqual(await smsCapability(m.ctx, STRANGER), { status: 'not_found' });
    assert.deepEqual(await smsCapability(m.ctx, 'nope'), { status: 'unreadable' });
    assert.deepEqual(await smsCapability({ ...m.ctx, authToken: () => undefined }, DREW), { status: 'unreadable' });
  } finally { await m.close(); }
});
