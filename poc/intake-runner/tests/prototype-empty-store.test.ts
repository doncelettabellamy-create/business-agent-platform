// The Work Items screens (prototype/intake-work-items), redesigned for the business owner: the list of intakes and the page for one intake.
// Their own script runs here against a stand-in DOM. They must show what the owner view sends and nothing else; carry no engineering word,
// confidence, step trace or prototype control; write text only; handle an empty store, bad data and failures; and work with the real
// server's files. (The file keeps its old name: it began as the empty-store regression test.) Invented data only.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createDashboardServer, dataScriptFor } from '../src/dashboard-server.ts';
import { callRefFor, createIntakeRecordStore } from '../src/intake-record-store.ts';
import type { IntakeRecord } from '../src/intake-record-store.ts';
import { OWNER_LABELS, OWNER_TEXT, ownerSummary, toOwnerView } from '../src/owner-view.ts';
import type { OwnerView } from '../src/owner-view.ts';
import { fakeBrowser } from './helpers/fake-dom.ts';
import type { FakeBrowser, FakeNode } from './helpers/fake-dom.ts';

const dir = new URL('../../../prototype/intake-work-items/', import.meta.url);
const APP = readFileSync(new URL('app.js', dir), 'utf8');
const HTML = readFileSync(new URL('index.html', dir), 'utf8');
const CSS = readFileSync(new URL('styles.css', dir), 'utf8');
const SAMPLE = readFileSync(new URL('data.js', dir), 'utf8');
const tmp = mkdtempSync(join(tmpdir(), 'work-items-'));
const closers: Array<() => unknown> = [];
after(async () => { for (const c of closers.reverse()) try { await c(); } catch { /* already closed */ } rmSync(tmp, { recursive: true, force: true }); });

const T = 'ws-founder-a';
const f = (name: string, value: string | null) => ({ name, value, confidence: value === null ? null : 0.9, found: value !== null });
function rec(id: string, over: Partial<IntakeRecord> = {}): IntakeRecord {
  return {
    item_id: id, workspace_id: T, call_ref: callRefFor(T, `call-${id}`), received_at: '2026-10-26T20:09:21Z', category: 'Emergency leak', status: 'ready', reasons: [], missing_fields: [],
    fields: [f('Address', '[ADDRESS_1]'), f('Job description', 'burst pipe'), f('Preferred date', 'tomorrow morning')], pii_summary: [{ type: 'Address', count: 1 }], confidence: 0.77,
    versions: { skill: 'skill-v9', model: 'model-m9', prompt: 'prompt-p9' }, handed_off: true, turns: 7, confirmation: 'confirmed', address_status: 'unverified', ...over,
  };
}
const NO_ADDRESS: Partial<IntakeRecord> = { fields: [f('Job description', 'replace a tap'), f('Number of rooms', 'four')], address_status: 'none' };
const UNCONFIRMED: Partial<IntakeRecord> = { confirmation: 'unconfirmed', status: 'needs-human', handed_off: false, reasons: ['not_confirmed'] };
const DAY = { fromIso: '2026-10-26T07:00:00Z', toIso: '2026-10-27T07:00:00Z' };
const view = (records: IntakeRecord[]): OwnerView => toOwnerView(records, DAY);
const THREE = [rec('wi-1', { ...UNCONFIRMED, received_at: '2026-10-26T20:09:21Z' }), rec('wi-2', { received_at: '2026-10-26T18:00:00Z' }), rec('wi-3', { ...NO_ADDRESS, received_at: '2026-10-26T12:00:00Z' })];

const ok = (data: unknown) => () => Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
const down = () => Promise.reject(new Error('down'));
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };

interface Page { b: FakeBrowser; calls: string[]; content(): string; banner(): FakeNode; cards(): FakeNode[]; links(): string[]; }
/** Runs the page: the data scripts first (as the page's script tags do), then the app. `answers` are what GET /api/owner returns, in turn. */
async function boot(dataScripts: string[], answers: Array<() => Promise<unknown>>): Promise<Page> {
  const calls: string[] = []; let n = 0;
  const fetch = (url: string) => { calls.push(url); return answers[Math.min(n++, answers.length - 1)](); };
  const b = fakeBrowser({ fetch });
  const ctx = { window: b.window, document: b.document };
  for (const s of dataScripts) runInNewContext(s, ctx);
  runInNewContext(APP, ctx);
  await flush();
  const content = () => b.node('content').textContent;
  const cards = () => b.node('content').descendants().filter((x) => x.className.split(' ').includes('card'));
  const links = () => b.node('content').descendants().filter((x) => x.tag === 'a' && (x.getAttribute('href') ?? '').startsWith('#/call/')).map((x) => x.getAttribute('href') as string);
  return { b, calls, content, banner: () => b.node('banner'), cards, links };
}
const live = (records: IntakeRecord[]) => boot([dataScriptFor(view(records))], [ok(view(records))]);
const FORBIDDEN = [/confidence/i, /needs-human/i, /[[\]]/, /PERSON_|ADDRESS_|CONTACT_|ID_\d/, /unknown_category|not_confirmed|low_confidence|missing_fields|model_failed/,
  /\bmask/i, /\btoken/i, /appointment|schedul/i, /\bundefined\b|\bnull\b|\bNaN\b/, /prototype|synthetic|shadow mode|staff user|<product>/i,
  /\b(?:skill|prompt)\b.*\b(?:model)\b/i, /processing|quality control|reporting|\bagent/i, /\bstep trace\b|how this was handled/i];
const noTechnicalWords = (what: string, text: string) => {
  for (const bad of FORBIDDEN) assert.ok(!bad.test(text), `${what} must not match ${bad}: ${text.slice(0, 160)}`);
  assert.ok(!/booked/i.test(text.replaceAll(OWNER_LABELS.requestedTime, '')), `${what}: "booked" only ever appears in "not booked"`);
};

// ---------------------------------------------------------------- the list
test('list: an empty store says there are no phone intakes yet, not that data did not load', async () => {
  const p = await live([]);
  const text = p.content();
  assert.ok(text.includes('Phone intakes') && text.includes('No phone intakes yet. This page updates by itself after a call.'), text);
  assert.ok(!/did not load|sample/i.test(text), text);
  assert.deepEqual(p.b.node('content').descendants().filter((x) => x.className === 'tile-n').map((x) => x.textContent), ['0', '0', '0', '0']);
  assert.equal(p.cards().length, 0);
  assert.equal(p.banner().hidden, true);
});

test('list: totals, tabs and cards show the intakes in plain words, newest first, opening on what needs follow-up', async () => {
  const p = await live(THREE);
  const text = p.content();
  for (const l of [OWNER_LABELS.intakesToday, OWNER_LABELS.needFollowUp, OWNER_LABELS.withRequestedTime, OWNER_LABELS.confirmedByCaller]) assert.ok(text.includes(l), l);
  assert.ok(text.includes(`${OWNER_LABELS.intakesTotal}: 3`));
  assert.deepEqual(p.b.node('content').descendants().filter((x) => x.className.startsWith('tile-n')).map((x) => x.textContent), ['3', '2', '2', '2']);
  const tabs = p.b.node('content').descendants().filter((x) => x.className === 'seg-btn');
  assert.deepEqual(tabs.map((t) => [t.textContent, t.getAttribute('aria-pressed')]), [['Needs follow-up (2)', 'true'], ['All intakes (3)', 'false']]);
  assert.equal(p.cards().length, 2);
  const first = p.cards()[0].textContent;
  for (const s of ['Emergency leak', OWNER_TEXT.notConfirmed, 'burst pipe', `${OWNER_LABELS.requestedTime}: tomorrow morning`, OWNER_TEXT.followUpUnconfirmed, 'View details']) assert.ok(first.includes(s), s);
  tabs[1].click();
  assert.equal(p.cards().length, 3);
  const times = p.b.node('content').descendants().filter((x) => x.tag === 'time').map((x) => x.getAttribute('datetime'));
  assert.deepEqual(times, ['2026-10-26T20:09:21Z', '2026-10-26T18:00:00Z', '2026-10-26T12:00:00Z']);
  assert.equal(p.b.node('live').textContent, 'Showing all intakes');
});

test('list: with nothing to follow up it opens on all intakes, and the follow-up tab says so', async () => {
  const p = await live([rec('wi-3', NO_ADDRESS)]);
  const tabs = p.b.node('content').descendants().filter((x) => x.className === 'seg-btn');
  assert.deepEqual(tabs.map((t) => t.getAttribute('aria-pressed')), ['false', 'true']);
  assert.equal(p.cards().length, 1);
  tabs[0].click();
  assert.ok(p.content().includes('Nothing needs follow-up.'));
});

test('list: it is a list of owner words only: no engineering label, code, mask, confidence, step trace, prototype control or booking wording', async () => {
  const records = [...THREE, rec('wi-4', { category: 'unknown', ...UNCONFIRMED, missing_fields: ['Preferred date'], fields: [f('Job description', 'leak near [ADDRESS_2] again')] })];
  const p = await live(records);
  p.b.node('content').descendants().filter((x) => x.className === 'seg-btn')[1].click();
  noTechnicalWords('the list', p.content() + ' ' + p.b.node('live').textContent + ' ' + p.b.node('banner').textContent);
  assert.ok(p.content().includes('Not recognised yet') && p.content().includes('leak near (withheld) again'));
  const controls = p.b.node('content').descendants().filter((x) => ['select', 'input', 'details', 'summary', 'option'].includes(x.tag));
  assert.equal(controls.length, 0, 'no filter dropdowns, search box or prototype controls');
});

test('list: more than a page of intakes shows a page and a "Show more" button', async () => {
  const many = Array.from({ length: 30 }, (_, i) => rec(`wi-${i}`, { ...NO_ADDRESS, received_at: `2026-10-26T10:${String(i).padStart(2, '0')}:00Z` }));
  const p = await live(many);
  assert.equal(p.cards().length, 25);
  const more = p.b.node('content').descendants().find((x) => x.tag === 'button' && x.textContent.startsWith('Show more'));
  assert.equal(more?.textContent, 'Show more (5 more)');
  more?.click();
  assert.equal(p.cards().length, 30);
  assert.ok(!p.content().includes('Show more'));
});

// ---------------------------------------------------------------- one intake
test('detail: opening an intake shows the full picture in plain words, with a way back', async () => {
  const p = await live(THREE);
  const href = p.links()[0];
  assert.match(href, /^#\/call\/2026-10-26T20:09:21Z-0$/);
  p.b.navigate(href);
  const text = p.content();
  for (const s of ['All intakes', 'Emergency leak', OWNER_TEXT.notConfirmed, 'What the caller needs', 'burst pipe', OWNER_LABELS.requestedTime, 'tomorrow morning', 'Address',
    'An address was given but it is not confirmed. It is not shown here. A person needs to check it with the caller.', 'Next steps', OWNER_TEXT.followUpUnconfirmed, OWNER_TEXT.verifyAddress]) assert.ok(text.includes(s), s);
  noTechnicalWords('the detail page', text);
  const time = p.b.node('content').descendants().find((x) => x.tag === 'time');
  assert.equal(time?.getAttribute('datetime'), '2026-10-26T20:09:21Z');
  assert.equal((p.b.document.title as string), 'Emergency leak - Phone assistant');
  const back = p.b.node('content').descendants().find((x) => x.tag === 'a' && x.getAttribute('href') === '#/');
  assert.equal(back?.textContent, '← All intakes');
  p.b.navigate('#/');
  assert.ok(p.content().includes('Customer requests') && p.cards().length === 2);
  assert.equal(p.b.document.title, 'Phone intakes - Phone assistant');
});

test('detail: other details are listed, the address section appears only when an address was given, and an empty request is said plainly', async () => {
  const p = await live([rec('wi-3', { ...NO_ADDRESS, received_at: '2026-10-26T12:00:00Z' }), rec('wi-5', { fields: [f('Address', '[ADDRESS_1]')], received_at: '2026-10-26T11:00:00Z' })]);
  p.b.node('content').descendants().filter((x) => x.className === 'seg-btn')[1].click();
  const [noAddressHref, addressOnlyHref] = [...new Set(p.links())];
  p.b.navigate(noAddressHref);
  let text = p.content();
  assert.ok(text.includes('Other details') && text.includes('Number of rooms four') && text.includes('replace a tap') && text.includes(`${OWNER_LABELS.requestedTime} None given`));
  assert.ok(!text.includes('An address was given') && !text.includes('Address '), 'no address section when none was given');
  assert.ok(text.includes(OWNER_TEXT.ready));
  p.b.navigate('#/');
  p.b.navigate(addressOnlyHref);
  text = p.content();
  assert.ok(text.includes('No request details were captured.') && text.includes('An address was given'));
  assert.ok(!text.includes('Other details'));
});

test('detail: intakes saved in the same second get their own addresses, and each opens its own page', async () => {
  const same = [rec('wi-a', { ...NO_ADDRESS, fields: [f('Job description', 'first job')], received_at: '2026-10-26T12:00:00Z' }),
    rec('wi-b', { ...NO_ADDRESS, fields: [f('Job description', 'second job')], received_at: '2026-10-26T12:00:00Z' })];
  const p = await live(same);
  const hrefs = [...new Set(p.links())];
  assert.equal(hrefs.length, 2, hrefs.join(' '));
  const seen: string[] = [];
  for (const h of hrefs) { p.b.navigate(h); seen.push(/first job|second job/.exec(p.content())?.[0] ?? '?'); p.b.navigate('#/'); }
  assert.deepEqual(seen.sort(), ['first job', 'second job']);
});

test('detail: an address that does not match any intake says so and offers the way back, and the page stays up to date', async () => {
  const p = await boot([dataScriptFor(view(THREE))], [ok(view(THREE)), ok(view([THREE[1]]))]);
  p.b.navigate('#/call/1999-01-01T00:00:00Z-0');
  assert.ok(p.content().includes('Intake not found') && p.content().includes("This intake isn't available any more.") && p.content().includes('All intakes'));
  p.b.navigate('#/call/not-a-real-key');
  assert.ok(p.content().includes('Phone intakes'), 'an unreadable address shows the list');
  p.b.navigate(p.links()[0]);
  const here = p.b.window.location as { hash: string };
  assert.ok(p.content().includes('Emergency leak'));
  p.b.timers[p.b.timers.length - 1].fn(); await flush();   // the next answer no longer has this intake
  assert.match(here.hash, /^#\/call\//);
  assert.ok(p.content().includes('Intake not found') || p.content().includes('Emergency leak'));
});

// ---------------------------------------------------------------- data and failures
test('data: a missing or malformed data file and a failing server never draw half a page', async () => {
  for (const scripts of [[], ['window.PROTO_DATA = null;'], ['window.PROTO_DATA = {};'], ['window.PROTO_DATA = { calls: "x", summary: {} };'], ['window.PROTO_DATA = { calls: [], summary: { intakesReceivedToday: "1" } };'], ['window.PROTO_DATA = { calls: [] };']]) {
    const p = await boot(scripts, [down]);
    assert.ok(p.content().includes('Loading your phone intakes.'), scripts.join());
    assert.equal(p.banner().hidden, false);
    assert.match(p.banner().textContent, /^Can't load your phone intakes yet/);
    assert.equal(p.cards().length, 0);
  }
});

test('data: a good answer clears the message; a later failure keeps the last information and says so', async () => {
  const p = await boot([], [down, ok(view(THREE)), () => Promise.resolve({ ok: false, json: ok({}) })]);
  assert.equal(p.banner().hidden, false);
  p.b.timers[p.b.timers.length - 1].fn(); await flush();
  assert.equal(p.banner().hidden, true);
  assert.equal(p.cards().length, 2);
  p.b.timers[p.b.timers.length - 1].fn(); await flush();
  assert.match(p.banner().textContent, /Showing the last information/);
  assert.equal(p.cards().length, 2);
});

test('data: it asks only for GET /api/owner, one at a time, every 15 seconds, and rests while hidden', async () => {
  const p = await live(THREE);
  assert.deepEqual(p.calls, ['/api/owner']);
  assert.equal(p.b.timers[p.b.timers.length - 1].ms, 15000);
  p.b.setHidden(true);
  p.b.timers[p.b.timers.length - 1].fn(); await flush();
  assert.equal(p.calls.length, 1);
  p.b.setHidden(false);
  for (const fn of p.b.docListeners.get('visibilitychange') ?? []) fn({}); await flush();
  assert.equal(p.calls.length, 2);
  p.b.node('refresh').click(); p.b.node('refresh').click(); await flush();
  assert.equal(p.calls.length, 3);
  assert.ok(p.calls.every((u) => u === '/api/owner'));
});

test('text only: whatever a value holds, it is written as text and never as markup', async () => {
  const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const data = { calls: [{ at: '2026-10-26T20:09:21Z', request: hostile, summary: hostile, requestedTime: hostile, details: [{ label: hostile, value: hostile }], statusText: hostile, needsFollowUp: true, nextActions: [hostile], addressGiven: false }],
    summary: { intakesReceivedToday: 1, intakesReceivedTotal: 1, needFollowUp: 1, withRequestedTime: 1, confirmedByCaller: 0 } };
  const p = await boot([`window.PROTO_DATA = ${JSON.stringify(data).replace(/</g, '\\u003c')};`], [ok(data)]);
  assert.ok(p.content().includes(hostile));
  p.b.navigate(p.links()[0]);
  assert.ok(p.content().includes(hostile));
  for (const tag of p.b.created) assert.ok(!['img', 'script', 'iframe', 'svg', 'style', 'link', 'object', 'embed', 'form', 'input', 'select'].includes(tag), tag);
});

// ---------------------------------------------------------------- the sample, and the real server
test('sample: the file opened on its own shows invented intakes under a clear notice, uses only the owner view\'s fields, and fails quietly', async () => {
  const p = await boot([SAMPLE], [down]);
  assert.equal(p.banner().hidden, false);
  assert.equal(p.banner().textContent, 'These are sample intakes, not real calls.');
  assert.equal(p.cards().length, 3, 'three of the four sample intakes need follow-up');
  const data = (() => { const w: Record<string, any> = {}; runInNewContext(SAMPLE, { window: w }); return w; })();
  assert.equal(data.PROTO_SAMPLE, true);
  assert.deepEqual(Object.keys(data.PROTO_DATA).sort(), ['calls', 'summary']);
  for (const c of data.PROTO_DATA.calls) assert.deepEqual(Object.keys(c).sort(), ['addressGiven', 'at', 'details', 'needsFollowUp', 'nextActions', 'request', 'requestedTime', 'statusText', 'summary']);
  const plain = JSON.parse(JSON.stringify(data.PROTO_DATA));
  assert.deepEqual(plain.summary, ownerSummary(plain.calls, DAY), 'the sample\'s counts are the true counts of the sample');
  const leaves = (x: unknown): string[] => (typeof x === 'string' ? [x] : x !== null && typeof x === 'object' ? Object.values(x).flatMap(leaves) : []);
  noTechnicalWords('the sample', leaves(plain).join(' '));
  p.b.navigate(p.links()[0]);
  assert.ok(p.content().includes('Next steps'));
});

test('live data is never marked as a sample, and the generated file holds the owner view and nothing else', () => {
  const js = dataScriptFor(view(THREE));
  assert.ok(!js.includes('PROTO_SAMPLE'));
  const w: Record<string, any> = {}; runInNewContext(js, { window: w });
  assert.deepEqual(Object.keys(w.PROTO_DATA).sort(), ['calls', 'summary']);
});

test('real server: the page, script, styles and data it serves work together and show a saved intake', async () => {
  const store = createIntakeRecordStore({ path: join(tmp, 'live.sqlite') }); closers.push(() => store.close());
  store.put(T, rec('wi-live', { ...UNCONFIRMED }));
  const d = createDashboardServer({ store, tenant: T, staticDir: new URL(dir).pathname.replace(/^\/([A-Za-z]:)/, '$1'), now: () => Date.parse('2026-10-26T20:30:00Z') });
  const port = await d.listen(0); closers.push(() => d.close());
  const get = async (p: string) => (await fetch(`http://127.0.0.1:${port}${p}`)).text();
  const [html, js, css, data] = await Promise.all([get('/'), get('/app.js'), get('/styles.css'), get('/data.js')]);
  assert.equal(html, HTML); assert.equal(js, APP); assert.equal(css, CSS);
  const b = fakeBrowser({ fetch: async (u: string) => ({ ok: true, json: async () => JSON.parse(await get(u)) }) });
  const ctx = { window: b.window, document: b.document };
  runInNewContext(data, ctx); runInNewContext(js, ctx); await flush();
  const text = b.node('content').textContent;
  assert.ok(text.includes('Emergency leak') && text.includes(OWNER_TEXT.notConfirmed) && text.includes('burst pipe'), text);
  noTechnicalWords('the page served by the real server', text);
  assert.equal(b.node('banner').hidden, true);
});

// ---------------------------------------------------------------- the files
test('files: nothing of the old engineering screens is left in the page, its script or its styles', () => {
  const code = APP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const visible = HTML.replace(/<!--[\s\S]*?-->/g, '') + code;
  for (const bad of [/confidence/i, /needs-human/, /\bprototype\b/i, /synthetic/i, /shadow mode/i, /staff user/i, /<Product>|&lt;Product&gt;/, /Work items/, /Extracted fields/, /Found/, /How this was handled/,
    /\bSteps\b/, /Skill |Model |Prompt /, /pipeline|Processing|Quality Control|Reporting/, /proto-state|protoControls|view:/, /f-status|f-category|f-search|<select|<input|<details/, /renderTokens|token/i,
    /rejectedToday|channelLabel|versions|reasons\b/, /localStorage|sessionStorage/]) {
    assert.ok(!bad.test(visible), `${bad} must not be in the owner screens`);
  }
});

test('files: the script writes only text, loads nothing from elsewhere, asks only for /api/owner, and uses every id the page has', () => {
  const code = APP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const banned of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /\beval\b/, /new Function/, /\bFunction\(/, /document\.write/, /indexedDB/, /XMLHttpRequest/, /WebSocket/, /sendBeacon/, /https?:\/\//, /\bimport\s*\(/, /\.src\s*=/, /setAttribute\('on/]) {
    assert.ok(!banned.test(code), String(banned));
  }
  assert.deepEqual([...code.matchAll(/fetch\(\s*'([^']+)'/g)].map((m) => m[1]), ['/api/owner']);
  const used = [...APP.matchAll(/\bel\('([a-z-]+)'\)/g)].map((m) => m[1]);
  assert.ok(used.length >= 5);
  for (const id of used) assert.ok(HTML.includes(`id="${id}"`), `index.html is missing id "${id}"`);
  assert.match(HTML, /<html lang="en">/); assert.match(HTML, /<title>Phone intakes<\/title>/); assert.match(HTML, /name="viewport" content="width=device-width, initial-scale=1"/);
  assert.deepEqual([...HTML.matchAll(/<script[^>]*>/g)].map((m) => m[0]), ['<script src="data.js">', '<script src="app.js">']);
  assert.ok(!/<style|style=|\son[a-z]+=|https?:\/\//i.test(HTML));
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/@import|url\(|\/\/[a-z]/i.test(css));
  assert.ok(/prefers-color-scheme: dark/.test(css) && /min-width: 720px/.test(css) && /focus-visible/.test(css) && /prefers-reduced-motion/.test(css));
  assert.ok(!/style=|\.style\b|cssText/.test(code), 'no inline styles, which the page policy forbids');
});

test('detail: a caller-confirmed address is described as confirmed by the caller and not checked, never as something a person must check; an unconfirmed one is the reverse', async () => {
  const confirmedText = 'An address was given and the caller confirmed it on the phone. It is not shown here. It was not checked against any address data.';
  const unconfirmedText = 'An address was given but it is not confirmed. It is not shown here. A person needs to check it with the caller.';
  const records = [
    rec('wi-c', { address_status: 'caller_confirmed', received_at: '2026-10-26T20:00:00Z' }),
    rec('wi-u', { address_status: 'unverified', received_at: '2026-10-26T19:00:00Z' }),
    rec('wi-n', { ...NO_ADDRESS, received_at: '2026-10-26T18:00:00Z' }),
  ];
  const p = await live(records);
  const [cLink, uLink, nLink] = ['2026-10-26T20:00:00Z', '2026-10-26T19:00:00Z', '2026-10-26T18:00:00Z'].map((at) => `#/call/${at}-0`);

  p.b.navigate(cLink);
  const confirmed = p.content();
  assert.ok(confirmed.includes(confirmedText));
  assert.ok(confirmed.includes(OWNER_TEXT.addressConfirmedValue), 'the owner view\'s own detail line is still shown');
  assert.ok(!confirmed.includes('A person needs to check it with the caller'), 'no contradiction on a confirmed call');
  assert.ok(!confirmed.includes(OWNER_TEXT.verifyAddress), 'no instruction to verify it');
  assert.ok(!/ADDRESS_|\[|valid|verified by|usps|postal/i.test(confirmed.replace('checked against any address data', '')), 'never claims validation, never shows a value');
  noTechnicalWords('the confirmed-address detail page', confirmed);

  p.b.navigate('#/');
  p.b.navigate(uLink);
  const unconfirmed = p.content();
  assert.ok(unconfirmed.includes(unconfirmedText));
  assert.ok(unconfirmed.includes(OWNER_TEXT.verifyAddress));
  assert.ok(!unconfirmed.includes('the caller confirmed it') && !unconfirmed.includes(OWNER_TEXT.addressConfirmedValue));
  noTechnicalWords('the unconfirmed-address detail page', unconfirmed);

  p.b.navigate('#/');
  p.b.navigate(nLink);
  assert.ok(!p.content().includes('An address was given'), 'no address, no address section');
});

test('files: the words the screens show are the owner view\'s own, and nothing in them says or implies a booking', () => {
  for (const s of [OWNER_LABELS.requestedTime, OWNER_LABELS.intakesToday, OWNER_LABELS.intakesTotal, OWNER_LABELS.needFollowUp, OWNER_LABELS.withRequestedTime, OWNER_LABELS.confirmedByCaller, OWNER_TEXT.confirmed]) {
    assert.ok(APP.includes(`'${s}'`), `app.js should use "${s}"`);
  }
  const words = APP.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/appointment|schedul/i.test(words + HTML));
  assert.ok(!/booked/i.test((words + HTML).replaceAll(OWNER_LABELS.requestedTime, '')));
});
