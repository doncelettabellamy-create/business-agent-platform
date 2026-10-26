// Local, read-only dashboard server for the founder phone test (proof of concept). `/` is THE business-owner dashboard: the list of
// intakes and the page for one intake (prototype/intake-work-items), fed with the saved records. There is no other page.
//
//   - binds to 127.0.0.1 only (the host is not a setting); the Host header must name loopback, which blocks DNS rebinding;
//   - ONE tenant, fixed when the server is created. No request can name another: any query string is refused;
//   - GET and HEAD only; an exact allow-list of paths; nothing is read from a path the caller chose;
//   - `/data.js` and `/api/owner` are generated from the record store as the business owner's view: the allow-listed projection of
//     owner-view.ts and nothing else (no confidence, codes, masks, steps, ids or addresses);
//   - one strict page policy for every response (nothing inline, this server only), no-store, nosniff, no referrer; fixed error text; no
//     record, id or store message is ever put in an error.
// It adds NO login, so anyone who can reach the loopback port sees that tenant's records. That is acceptable for a founder's own
// machine only (R01 / FND-02 not met). It is NOT exposed by the tunnel: only the phone endpoint is.
// Imports no network client and writes no files.

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import type { IntakeRecordStore } from './intake-record-store.ts';
import { toOwnerView } from './owner-view.ts';
import type { OwnerView } from './owner-view.ts';

/** Nothing inline at all, and a page may only talk to this server. One policy for every response. */
const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** The server machine's own calendar day around `nowMs`, as two ISO UTC instants (this is the founder's own machine, so it is the owner's day). */
export function localDayBounds(nowMs: number): { fromIso: string; toIso: string } {
  const n = new Date(nowMs);
  const from = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  const to = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1);
  return { fromIso: from.toISOString().replace(/\.\d{3}Z$/, 'Z'), toIso: to.toISOString().replace(/\.\d{3}Z$/, 'Z') };
}

const STATIC: Readonly<Record<string, { file: string; type: string }>> = Object.freeze({
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
});
const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': PAGE_CSP,
} as const;
/** Pure: the whole `/data.js` file, from the owner view. JSON is escaped so no record value can end the script or inject markup. */
export function dataScriptFor(view: OwnerView): string {
  const json = JSON.stringify(view).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `/* Live intakes from the phone assistant. Generated from the saved records; personal details are masked and never sent. */\nwindow.PROTO_DATA = ${json};\n`;
}

export interface DashboardConfig {
  store: IntakeRecordStore;
  /** The one tenant this dashboard shows. Fixed here; no request can change it. */
  tenant: string;
  /** Directory holding the owner dashboard's index.html, styles.css and app.js (`prototype/intake-work-items`). */
  staticDir: string;
  /** The clock, in milliseconds since the epoch (the owner's "today" comes from it). */
  now?: () => number;
}
export interface DashboardServer {
  listen(port: number): Promise<number>;
  close(): Promise<void>;
  readonly server: Server;
}

export function createDashboardServer(config: DashboardConfig): DashboardServer {
  const { store, tenant, staticDir } = config;
  const clock = config.now ?? Date.now;
  if (typeof tenant !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(tenant)) throw new RangeError('tenant must be an id-like string');
  if (typeof store?.list !== 'function') throw new RangeError('store must have list');
  if (typeof staticDir !== 'string' || staticDir.length === 0) throw new RangeError('staticDir must be a path');
  if (typeof clock !== 'function') throw new RangeError('now must be a function');
  let port = 0;

  const server = createServer((req, res) => {
    const send = (status: number, type: string, body: string): void => {
      res.writeHead(status, { 'Content-Type': type, ...HEADERS });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const fail = (status: number, code: string): void => send(status, 'application/json; charset=utf-8', JSON.stringify({ error: code }));
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'METHOD_NOT_ALLOWED');
      const host = String(req.headers.host ?? '');
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return fail(421, 'HOST_NOT_ALLOWED');
      const raw = req.url ?? '';
      if (raw.includes('?') || raw.includes('#') || raw.length > 64) return fail(400, 'QUERY_NOT_ALLOWED');
      if (Object.hasOwn(STATIC, raw)) {
        const s = STATIC[raw];
        return send(200, s.type, readFileSync(`${staticDir}/${s.file}`, 'utf8'));
      }
      if (raw === '/data.js') return send(200, 'text/javascript; charset=utf-8', dataScriptFor(toOwnerView(store.list(tenant), localDayBounds(clock()))));
      if (raw === '/api/owner') return send(200, 'application/json; charset=utf-8', JSON.stringify(toOwnerView(store.list(tenant), localDayBounds(clock()))));
      return fail(404, 'NOT_FOUND');
    } catch {
      try { fail(503, 'UNAVAILABLE'); } catch { /* connection already gone */ }
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.maxHeadersCount = 40;

  return Object.freeze({
    server,
    listen(p: number): Promise<number> {
      if (!Number.isInteger(p) || p < 0 || p > 65535) throw new RangeError('port must be an integer from 0 to 65535');
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(p, '127.0.0.1', () => {
          const a = server.address();
          port = typeof a === 'object' && a !== null ? a.port : p;
          resolve(port);
        });
      });
    },
    close(): Promise<void> { return new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }); },
  });
}
