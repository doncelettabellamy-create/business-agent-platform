// Local, read-only dashboard server for the founder phone test (proof of concept). It shows the EXISTING prototype
// (prototype/intake-work-items) with live records instead of its invented ones.
//
//   - binds to 127.0.0.1 only (the host is not a setting); the Host header must name loopback, which blocks DNS rebinding;
//   - ONE tenant, fixed when the server is created. No request can name another: any query string is refused;
//   - GET and HEAD only; an exact allow-list of paths; nothing is read from a path the caller chose;
//   - `/data.js` is generated from the record store in the prototype's own shape, so the prototype's app.js is unchanged;
//   - fixed headers (CSP, no-store, nosniff, no referrer); fixed error text; no record, id or store message is ever put in an error.
// It adds NO login, so anyone who can reach the loopback port sees that tenant's records. That is acceptable for a founder's own
// machine only (R01 / FND-02 not met). It is NOT exposed by the tunnel: only the phone endpoint is.
// Imports no network client and writes no files.

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { REASON_CODES } from './contracts.ts';
import type { IntakeRecord, IntakeRecordStore } from './intake-record-store.ts';

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
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
} as const;
const STEP_NAMES = ['Verified request', 'Checked for duplicates', 'Found personal data', 'Hid personal data and stored it safely', 'Classified', 'Extracted fields', 'Validated', 'Saved and handed off'];
const REASON_TEXT: Record<string, string> = {
  missing_fields: 'Some required fields were not found in the message.',
  unknown_category: 'The request did not match any configured category.',
  ambiguous_category: 'The request matched more than one category, so a person should decide.',
  ambiguous_field: 'A field had more than one possible value, so a person should decide.',
  low_confidence: 'The system was not confident enough in the result.',
  model_failed: 'The model did not give a usable answer, so a person should review this item.',
};

interface DashboardItem {
  id: string; status: string; category: string | null; received: string; confidence: number | null; reasons: string[];
  message: null; messageHidden: string; pii: { type: string; count: number }[];
  fields: { name: string; value: string | null; conf: number | null; found: boolean }[];
  steps: { name: string; status: string; ms: null; note: string }[]; handedOff: boolean;
}

/** Pure: one stored record in the prototype's item shape. The message text is never shown (it is not stored). */
export function toDashboardItem(r: IntakeRecord): DashboardItem {
  const handed = r.handed_off;
  return {
    id: r.item_id, status: r.status, category: r.category === 'unknown' ? null : r.category,
    received: `${r.received_at.slice(0, 10)} ${r.received_at.slice(11, 16)}`, confidence: r.confidence, reasons: [...r.reasons],
    message: null, messageHidden: 'The message text is not stored in this test. Personal details were replaced before anything was saved.',
    pii: r.pii_summary.map((p) => ({ type: p.type, count: p.count })),
    fields: r.fields.map((f) => ({ name: f.name, value: f.value, conf: f.confidence, found: f.found })),
    steps: STEP_NAMES.map((name, i) => ({ name, status: i === STEP_NAMES.length - 1 && !handed ? 'skipped' : 'done', ms: null, note: '' })),
    handedOff: handed,
  };
}
/** Pure: the whole `/data.js` file. JSON is escaped so no record value can end the script or inject markup. */
export function dataScriptFor(records: readonly IntakeRecord[]): string {
  const data = {
    items: records.map(toDashboardItem),
    reasons: Object.fromEntries(REASON_CODES.map((c) => [c, REASON_TEXT[c] ?? 'This item needs review.'])),
    versions: { skill: 'live', model: 'see item', prompt: 'see item' },
    channelLabel: 'Phone (founder test)',
    rejectedToday: 0,
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `/* Live records from the founder phone test. Generated; personal data is masked. */\nwindow.PROTO_DATA = ${json};\n`;
}

export interface DashboardConfig {
  store: IntakeRecordStore;
  /** The one tenant this dashboard shows. Fixed here; no request can change it. */
  tenant: string;
  /** Directory holding the prototype's index.html, styles.css and app.js. */
  staticDir: string;
}
export interface DashboardServer {
  listen(port: number): Promise<number>;
  close(): Promise<void>;
  readonly server: Server;
}

export function createDashboardServer(config: DashboardConfig): DashboardServer {
  const { store, tenant, staticDir } = config;
  if (typeof tenant !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(tenant)) throw new RangeError('tenant must be an id-like string');
  if (typeof store?.list !== 'function') throw new RangeError('store must have list');
  if (typeof staticDir !== 'string' || staticDir.length === 0) throw new RangeError('staticDir must be a path');
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
      if (raw === '/data.js') return send(200, 'text/javascript; charset=utf-8', dataScriptFor(store.list(tenant)));
      if (raw === '/api/items') return send(200, 'application/json; charset=utf-8', JSON.stringify({ items: store.list(tenant).map(toDashboardItem) }));
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
