// A local stand-in for Twilio's REST API, shared by the joined fast-call test: a call's caller ID, sending a text, and a message's delivery status. Nothing here contacts Twilio. Every value is invented.
import { createServer } from 'node:http';

export const SID = `AC${'a1'.repeat(16)}`; export const TOKEN = 'invented-auth-token-0123456789abcdef'; export const CALL = `CA${'b2'.repeat(16)}`;
export interface TwilioMock { origin: string; messages: Array<{ sid: string; to: string; from: string; body: string }>; opts: { callerFrom: string | undefined; finalStatus: string; failSendTo?: string }; close(): Promise<void> }
export async function mockTwilio(): Promise<TwilioMock> {
  const messages: TwilioMock['messages'] = []; const opts: TwilioMock['opts'] = { callerFrom: '+15550100002', finalStatus: 'delivered' }; let n = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
      const j = (s: number, o: unknown): void => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      const expected = `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`; if (req.headers.authorization !== expected) return j(401, { code: 20003 });
      const url = req.url ?? ''; const base = `/2010-04-01/Accounts/${SID}`;
      if (url === `${base}/Calls/${CALL}.json`) return opts.callerFrom === undefined ? j(404, {}) : j(200, { from: opts.callerFrom });
      if (url === `${base}/Messages.json` && req.method === 'POST') {
        const f = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
        if (opts.failSendTo !== undefined && f.To === opts.failSendTo) return j(400, { code: 21608 });
        const sid = `SM${String(++n).padStart(32, '0')}`; messages.push({ sid, to: f.To, from: f.From, body: f.Body }); return j(201, { sid, status: 'queued' });
      }
      const m = /\/Messages\/(SM[0-9a-f]{32})\.json$/.exec(url); if (m !== null) return j(200, { status: opts.finalStatus });
      j(404, {});
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, messages, opts, close: () => new Promise<void>((ok) => { server.close(() => ok()); server.closeAllConnections(); }) };
}
