// ISOLATED TRIAL of the Google Address Validation API. It is NOT part of Drew: nothing in src/ imports it, the call handler does not use it, and it changes no configuration.
//
//   node tools/google-validation-trial.ts           prints the plan and the rules. No key, no network.
//   node tools/google-validation-trial.ts --run     asks you to type RUN-9, then asks for the API key (hidden, never echoed, never stored, never logged), then sends the plan.
//   add  --out <file>  to also write the tokens-only result table as JSON.
//
// HARD LIMIT: the plan has 9 requests and the code refuses more than 10 in total (checked before the plan is accepted and again before every send). Nothing is retried: the first
// answer that is not HTTP 200 stops the run. The addresses are REAL, publicly published addresses, each copied from its owner's own page; none is altered (Google's service terms
// forbid artificially-created US addresses). The one formatting variant (R6) changes only case and abbreviates "Parkway" to "pkwy"; no value is changed.
//
// PRIVACY: the key travels only in the X-Goog-Api-Key header (never in a URL). The output holds ids, HTTP status, milliseconds, enumerations and booleans: never an address, a
// response body, an error message or the key. The response is read in memory and dropped.
import { createInterface } from 'node:readline/promises';
import { writeFileSync } from 'node:fs';
import { readSecret, normalizeKeyEntry } from '../src/hidden-prompt.ts';
import type { AddressVerdict } from '../src/fast-call-handler.ts';

export const MAX_REQUESTS = 10;
export const ENDPOINT = 'https://addressvalidation.googleapis.com/v1:validateAddress';

export interface TrialInput { street: string; city: string; state: string; zip: string }
export interface PlanItem { id: string; label: string; cass: boolean; input: TrialInput }

/** Where each address was read (2026-11-07), so it can be checked again: A1 Google's own Address Validation docs; A2 whitehouse.gov/contact; A3 news.microsoft.com/facts-about-microsoft; A4 supremecourt.gov/contact/contactus.aspx; A5 archives.gov/contact. */
const A1: TrialInput = { street: '1600 Amphitheatre Parkway', city: 'Mountain View', state: 'CA', zip: '94043' };
const A2: TrialInput = { street: '1600 Pennsylvania Avenue, N.W.', city: 'Washington', state: 'DC', zip: '20500' };
const A3: TrialInput = { street: 'One Microsoft Way', city: 'Redmond', state: 'WA', zip: '98052' };
const A4: TrialInput = { street: '1 First Street, NE', city: 'Washington', state: 'DC', zip: '20543' };
const A5: TrialInput = { street: '8601 Adelphi Road', city: 'College Park', state: 'MD', zip: '20740' };
export const PLAN: readonly PlanItem[] = Object.freeze([
  { id: 'R1', label: 'A1', cass: false, input: A1 }, { id: 'R2', label: 'A2', cass: false, input: A2 }, { id: 'R3', label: 'A3', cass: false, input: A3 },
  { id: 'R4', label: 'A4', cass: false, input: A4 }, { id: 'R5', label: 'A5', cass: false, input: A5 },
  { id: 'R6', label: 'A1 case/abbreviation only', cass: false, input: { street: '1600 amphitheatre pkwy', city: 'mountain view', state: 'ca', zip: '94043' } },
  { id: 'R7', label: 'A1 with USPS CASS', cass: true, input: A1 }, { id: 'R8', label: 'A4 with USPS CASS', cass: true, input: A4 },
  { id: 'R9', label: 'A1 again (repeat)', cass: false, input: A1 },
]);
if (PLAN.length > MAX_REQUESTS) throw new RangeError('the plan is longer than the hard limit');

// ---------------------------------------------------------------- reading a response (pure)
export interface Evaluation { verdict: AddressVerdict; reasons: string[]; flags: Record<string, string | boolean | number> }
const rec = (x: unknown): Record<string, unknown> => (typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
const GRAN = new Set(['PREMISE', 'SUB_PREMISE', 'PREMISE_PROXIMITY', 'BLOCK', 'ROUTE', 'OTHER']);
const token = (x: unknown): string => (typeof x === 'string' && /^[A-Za-z_]{1,40}$/.test(x) ? x.toLowerCase() : 'other');
const firstFive = (x: unknown): string | undefined => (typeof x === 'string' && /^\d{5}/.test(x) ? x.slice(0, 5) : undefined);
/**
 * The working rule for "this address is valid" (proposed; this trial exists to test it against real addresses). It maps a Google response to Drew's verdict and FAILS CLOSED:
 * anything that is not a clean, complete, premise-level, USPS-confirmed address whose state and ZIP are the ones asked about is not `valid`.
 * It reads only enumerations and booleans and returns tokens: it never returns or logs an address or any text of the response.
 */
export function evaluate(input: TrialInput, body: unknown): Evaluation {
  const r = rec(rec(body).result); const v = rec(r.verdict); const a = rec(r.address); const usps = rec(r.uspsData); const std = rec(usps.standardizedAddress); const post = rec(a.postalAddress);
  const comps = Array.isArray(a.addressComponents) ? a.addressComponents.map(rec) : [];
  const gran = GRAN.has(String(v.validationGranularity)) ? String(v.validationGranularity) : v.validationGranularity === undefined ? 'none' : 'other';
  const dpvRaw = usps.dpvConfirmation; const dpv = typeof dpvRaw === 'string' && /^[YNSD]$/.test(dpvRaw) ? dpvRaw : dpvRaw === undefined ? 'none' : '?';
  const flags: Evaluation['flags'] = { granularity: gran, complete: v.addressComplete === true, inferred: v.hasInferredComponents === true, replaced: v.hasReplacedComponents === true, spellCorrected: v.hasSpellCorrectedComponents === true, unconfirmed: v.hasUnconfirmedComponents === true, dpv, missing: Array.isArray(a.missingComponentTypes) ? a.missingComponentTypes.length : 0 };
  const out = (verdict: AddressVerdict, ...reasons: string[]): Evaluation => ({ verdict, reasons, flags });
  if (Object.keys(v).length === 0) return out({ status: 'unknown' }, 'no_verdict');
  if (gran !== 'PREMISE' && gran !== 'SUB_PREMISE') return out(gran === 'OTHER' ? { status: 'mismatch', field: 'street' } : gran === 'none' || gran === 'other' ? { status: 'unknown' } : { status: 'mismatch', field: 'house_number' }, 'granularity_' + gran.toLowerCase());
  if (Array.isArray(a.missingComponentTypes) && a.missingComponentTypes.length > 0) return out({ status: 'unknown' }, 'missing_component');
  const state = typeof std.state === 'string' ? std.state : typeof post.administrativeArea === 'string' ? post.administrativeArea : undefined; const zip = firstFive(std.zipCode) ?? firstFive(post.postalCode);
  if (state === undefined || zip === undefined) return out({ status: 'unknown' }, 'no_returned_location');
  if (state.toUpperCase() !== input.state.toUpperCase()) return out({ status: 'mismatch', field: 'zip_state' }, 'state_differs');
  if (zip !== input.zip) return out({ status: 'mismatch', field: 'zip_city' }, 'zip_differs');
  const replaced = comps.filter((c) => c.replaced === true).map((c) => token(c.componentType));
  if (v.hasReplacedComponents === true || replaced.length > 0) {
    if (replaced.includes('administrative_area_level_1')) return out({ status: 'mismatch', field: 'zip_state' }, 'replaced_state');
    if (replaced.includes('postal_code') || replaced.includes('locality')) return out({ status: 'mismatch', field: 'zip_city' }, 'replaced_' + (replaced.includes('postal_code') ? 'postal_code' : 'locality'));
    return out({ status: 'corrected' }, 'replaced');
  }
  if (v.hasSpellCorrectedComponents === true || comps.some((c) => c.spellCorrected === true)) return out({ status: 'corrected' }, 'spell_corrected');
  if (v.hasUnconfirmedComponents === true || comps.some((c) => c.unexpected === true)) return out({ status: 'unknown' }, 'unconfirmed');
  const inferred = comps.filter((c) => c.inferred === true).map((c) => token(c.componentType));
  const harmless = new Set(['postal_code_suffix', 'country']);
  if (inferred.some((t) => !harmless.has(t)) || (v.hasInferredComponents === true && comps.length === 0)) return out({ status: 'corrected' }, 'inferred');
  if (v.addressComplete !== true) return out({ status: 'unknown' }, 'incomplete');
  if (dpv === 'N') return out({ status: 'mismatch', field: 'house_number' }, 'dpv_n');
  if (dpv !== 'Y') return out({ status: 'unknown' }, 'dpv_' + (dpv === 'none' ? 'missing' : dpv.toLowerCase()));
  return out({ status: 'valid' }, 'clean');
}

// ---------------------------------------------------------------- the run
export interface TrialRow { id: string; label: string; cass: boolean; http: number; ms: number; outcome: string; field?: string; reasons: string[]; flags: Evaluation['flags']; apiError?: string }
export interface TrialDeps { key: string; fetch(url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<{ status: number; text(): Promise<string> }>; clock(): number; timeoutMs?: number; plan?: readonly PlanItem[] }
export function bodyFor(p: PlanItem): string {
  return JSON.stringify({ address: { regionCode: 'US', locality: p.input.city, administrativeArea: p.input.state, postalCode: p.input.zip, addressLines: [p.input.street] }, ...(p.cass ? { enableUspsCass: true } : {}) });
}
/** Sends the plan, one request after the other, never more than MAX_REQUESTS in all, never retrying. Stops at the first answer that is not HTTP 200. Returns tokens only. */
export async function runTrial(d: TrialDeps): Promise<TrialRow[]> {
  const plan = d.plan ?? PLAN;
  if (plan.length > MAX_REQUESTS) throw new RangeError('the plan is longer than the hard limit; nothing was sent');
  const rows: TrialRow[] = []; let sent = 0;
  for (const p of plan) {
    if (sent >= MAX_REQUESTS) throw new RangeError('hard limit reached');
    sent++;
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), d.timeoutMs ?? 10_000); timer.unref?.();
    const t0 = d.clock(); let http = 0; let text = '';
    try { const res = await d.fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': d.key }, body: bodyFor(p), signal: ac.signal }); http = res.status; text = await res.text(); }
    catch { http = -1; } finally { clearTimeout(timer); }
    const ms = Math.round(d.clock() - t0);
    let parsed: unknown; try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    if (http !== 200) { const st = rec(rec(parsed).error).status; rows.push({ id: p.id, label: p.label, cass: p.cass, http, ms, outcome: 'not_run', reasons: [http === -1 ? 'network_or_timeout' : 'http_error'], flags: {}, ...(typeof st === 'string' && /^[A-Z_]{3,40}$/.test(st) ? { apiError: st } : {}) }); break; }
    const ev = evaluate(p.input, parsed);
    rows.push({ id: p.id, label: p.label, cass: p.cass, http, ms, outcome: ev.verdict.status, ...(ev.verdict.status === 'mismatch' ? { field: ev.verdict.field } : {}), reasons: ev.reasons, flags: ev.flags });
  }
  return rows;
}
export interface Summary { requests: number; falseRejects: number; median: number; max: number; repeatable: boolean; allHttp200: boolean; pass: boolean }
export function summarize(rows: readonly TrialRow[]): Summary {
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b); const mid = ms.length === 0 ? 0 : ms.length % 2 === 1 ? ms[(ms.length - 1) / 2] : Math.round((ms[ms.length / 2 - 1] + ms[ms.length / 2]) / 2);
  const falseRejects = rows.filter((r) => r.outcome !== 'valid').length; const allHttp200 = rows.length > 0 && rows.every((r) => r.http === 200);
  const r1 = rows.find((r) => r.id === 'R1'); const r9 = rows.find((r) => r.id === 'R9');
  const repeatable = r1 !== undefined && r9 !== undefined && r1.outcome === r9.outcome && JSON.stringify(r1.flags) === JSON.stringify(r9.flags);
  const max = ms.length === 0 ? 0 : ms[ms.length - 1];
  // Proposed targets, arbitrary until measured: median under 1500 ms and maximum under 3000 ms, against Drew's 4000 ms timeout.
  return { requests: rows.length, falseRejects, median: mid, max, repeatable, allHttp200, pass: allHttp200 && falseRejects === 0 && repeatable && mid <= 1500 && max <= 3000 };
}

// ---------------------------------------------------------------- the command line
const show = (rows: readonly TrialRow[], s: Summary): string => [
  'id  http    ms  cass  outcome   field         reasons                 flags',
  ...rows.map((r) => `${r.id.padEnd(3)} ${String(r.http).padStart(4)} ${String(r.ms).padStart(5)}  ${r.cass ? 'on  ' : 'off '} ${r.outcome.padEnd(9)} ${(r.field ?? '-').padEnd(13)} ${r.reasons.join(',').padEnd(23)} ${JSON.stringify(r.flags)}${r.apiError === undefined ? '' : ' apiError=' + r.apiError}`),
  `requests=${s.requests} falseRejects=${s.falseRejects} medianMs=${s.median} maxMs=${s.max} repeatable=${s.repeatable} allHttp200=${s.allHttp200} => ${s.pass ? 'PASS' : 'FINDINGS (read the table; a finding is evidence, not a defect in the run)'}`,
  'Billing SKU is NOT visible here: read it in the Cloud console (API metrics now; Billing > Reports by SKU after up to 48 hours).',
].join('\n');

async function main(): Promise<void> {
  const args = process.argv.slice(2); const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined;
  console.log(`Plan: ${PLAN.length} requests (hard limit ${MAX_REQUESTS}), real published addresses only, key in a header only, tokens-only output.`);
  for (const p of PLAN) console.log(`  ${p.id}  ${p.label}${p.cass ? '  [enableUspsCass]' : ''}`);
  if (!args.includes('--run')) { console.log('Dry run: nothing was sent and no key was asked for. Add --run to send.'); return; }
  const rl = createInterface({ input: process.stdin, output: process.stdout }); const typed = (await rl.question(`Type RUN-${PLAN.length} to send ${PLAN.length} requests to Google: `)).trim(); rl.close();
  if (typed !== `RUN-${PLAN.length}`) { console.log('Not confirmed. Nothing was sent.'); return; }
  const raw = await readSecret(process.stdin, process.stdout, 'Paste the Google API key (it will not be shown): '); process.stdout.write('\n');
  const k = normalizeKeyEntry(raw);
  if (k.key === undefined) { console.log(`No usable key (${k.problem ?? 'cancelled'}). Nothing was sent.`); return; }
  const rows = await runTrial({ key: k.key, fetch: (u, i) => fetch(u, i), clock: () => performance.now() });
  const s = summarize(rows); console.log(show(rows, s));
  if (out !== undefined) { writeFileSync(out, JSON.stringify({ rows, summary: s }, null, 2)); console.log('Wrote the tokens-only table to the file you named.'); }
}
if (process.argv[1] !== undefined && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) await main();
