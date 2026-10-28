// The founder phone test's gate, its config, and the Intake entry's opt-in founder tier. No network, no credential, invented data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { claudeCeilingUsd, founderConfigDigest, founderConfigProblems, founderGateProblems, relayPathFor, signedUrlCandidates } from '../src/founder-call-gate.ts';
import { createIntakeEntry } from '../src/intake-entry.ts';
import { createTenantRegistry } from '../src/tenant-boundary.ts';
import { mintExecutionContext } from '../src/execution-context.ts';
import { classifyAnswer, createMockProvider, extractAnswer } from '../src/mock-provider.ts';

const example = () => JSON.parse(readFileSync(new URL('../examples/founder-call.config.example.json', import.meta.url), 'utf8'));
const NOW = '2026-10-26T12:00:00Z';
/** The example with the placeholders replaced by plausible real-looking values, as a founder would. */
const SECRET = 'k3Zr2KfX9mWc4TbV8nHs1LpD6yGe3AuJ5oRi0NxE';
const real = () => ({ ...example(), numbers: ['+12025551234'], public_wss_url: `wss://calls.mytunnel.dev/relay/${SECRET}` });
const env = (over: Record<string, unknown> = {}) => ({ allowLive: 'yes', approvedDigest: founderConfigDigest(real()), twilioTokenPresent: true, ...over }) as never;

// ---------------------------------------------------------------- config
test('config: the shipped example is valid and shows no real number, key or host', () => {
  const c = example();
  assert.deepEqual(founderConfigProblems(c), []);
  assert.deepEqual(c.numbers, ['+15555550100']);
  assert.ok(c.public_wss_url.includes('YOUR-TUNNEL-HOST') && c.public_wss_url.includes('REPLACE'));
  assert.ok(!/sk-|api[_-]?key|token/i.test(JSON.stringify(c)));
});

test('config: the public address must carry a long random secret path (Twilio\'s handshake signature is the same for every call)', () => {
  const bad = ['/relay', '/relay/', '/relay/short', `/relay/${'a'.repeat(31)}`, `/relay/${'a'.repeat(65)}`, `/relay/${SECRET}/`, `/relay/${SECRET}?x=1`, `/relay/${SECRET}/more`, `/other/${SECRET}`, `/relay/${'a'.repeat(20)} ${'b'.repeat(20)}`, `/relay/${'a'.repeat(20)}.${'b'.repeat(20)}`];
  for (const path of bad) {
    const c = real(); c.public_wss_url = `wss://calls.mytunnel.dev${path}`;
    assert.ok(founderConfigProblems(c).length > 0, path);
  }
  for (const ok of [SECRET, 'a'.repeat(32), 'A_b-C'.repeat(12) + 'abcd']) {
    const c = real(); c.public_wss_url = `wss://calls.mytunnel.dev:8443/relay/${ok}`;
    assert.deepEqual(founderConfigProblems(c), [], ok);
    assert.equal(relayPathFor(c.public_wss_url), `/relay/${ok}`);
  }
  assert.throws(() => relayPathFor('wss://calls.mytunnel.dev/relay'), RangeError);
  assert.throws(() => relayPathFor('https://calls.mytunnel.dev/relay/' + SECRET), RangeError);
});

test('config: max_calls bounds how many calls one serve run accepts', () => {
  for (const v of [0, 11, 1.5, '3', null, undefined]) { const c = real(); c.max_calls = v; assert.ok(founderConfigProblems(c).some((x) => x.includes('max_calls')), String(v)); }
  const c = real(); delete c.max_calls; assert.ok(founderConfigProblems(c).length > 0);
  assert.deepEqual(founderConfigProblems(real()), []);
});

test('gate: placeholder values from the example can never be approved, even with a matching digest', () => {
  const ex = example();
  const p = founderGateProblems({ config: ex, env: env({ approvedDigest: founderConfigDigest(ex) }), nowIso: NOW });
  assert.ok(p.some((x) => x.includes('placeholder')), JSON.stringify(p));
  for (const edit of [{ numbers: ['+15555550142'] }, { public_wss_url: `wss://YOUR-TUNNEL-HOST.mytunnel.dev/relay/${SECRET}` }, { public_wss_url: 'wss://calls.example.com/relay/' + SECRET }, { public_wss_url: `wss://calls.mytunnel.dev/relay/REPLACE_${SECRET}` }]) {
    const c = { ...real(), ...edit };
    assert.ok(founderGateProblems({ config: c, env: env({ approvedDigest: founderConfigDigest(c) }), nowIso: NOW }).some((x) => x.includes('placeholder')), JSON.stringify(edit));
  }
  assert.deepEqual(founderGateProblems({ config: real(), env: env(), nowIso: NOW }), []);
});

test('config: every field is checked, and no value from the file is echoed back', () => {
  const CANARY = 'CANARY-FOUNDER-8841';
  const bad: Array<[string, (c: any) => void]> = [
    ['extra key', (c) => { c.extra = 1; }], ['missing key', (c) => { delete c.model; }],
    ['tenant not founder', (c) => { c.tenant = `ws-synthetic-${CANARY}`; }], ['tenant plain', (c) => { c.tenant = CANARY; }],
    ['no numbers', (c) => { c.numbers = []; }], ['too many numbers', (c) => { c.numbers = ['+15555550101', '+15555550102', '+15555550103', '+15555550104']; }],
    ['number not e164', (c) => { c.numbers = [`555-${CANARY}`]; }], ['model dated', (c) => { c.model = 'claude-haiku-5-5-20260101'; }], ['model junk', (c) => { c.model = CANARY; }],
    ['minutes high', (c) => { c.max_minutes = 11; }], ['turns high', (c) => { c.max_turns = 31; }], ['calls high', (c) => { c.max_claude_calls = 301; }],
    ['expires junk', (c) => { c.expires = CANARY; }], ['names junk', (c) => { c.persona_names = [3]; }], ['kill file', (c) => { c.kill_file = ''; }],
    ['url not wss', (c) => { c.public_wss_url = `https://${CANARY}.example/relay`; }], ['url wrong path', (c) => { c.public_wss_url = `wss://${CANARY}.example/other`; }],
    ['db path', (c) => { c.db_path = 7; }], ['no secret path', (c) => { c.public_wss_url = `wss://${CANARY}.example/relay`; }], ['max calls', (c) => { c.max_calls = 99; }], ['same ports', (c) => { c.dashboard_port = c.relay_port; }], ['low port', (c) => { c.relay_port = 80; }],
    ['after speech', (c) => { c.after_speech_ms = 60_000; }], ['skill config', (c) => { c.skill_config = { categories: [] }; }],
  ];
  for (const [name, mutate] of bad) {
    const c = example(); mutate(c);
    const p = founderConfigProblems(c);
    assert.ok(p.length > 0, name);
    assert.ok(!JSON.stringify(p).includes(CANARY), `${name}: no value echoed`);
  }
  for (const nonObject of [null, 3, 'x', []]) assert.ok(founderConfigProblems(nonObject).length > 0);
});

test('digest: any change to the config changes it, and key order does not', () => {
  const a = example(); const d = founderConfigDigest(a);
  assert.match(d, /^[0-9a-f]{64}$/);
  const reordered = Object.fromEntries(Object.entries(a).reverse());
  assert.equal(founderConfigDigest(reordered), d);
  for (const [k, v] of [['max_turns', 29], ['model', 'claude-sonnet-5-5'], ['numbers', ['+15555550199']], ['expires', '2026-11-21T00:00:00Z'], ['persona_names', ['Someone Else']]] as const) {
    assert.notEqual(founderConfigDigest({ ...a, [k]: v }), d, k);
  }
});

// ---------------------------------------------------------------- gate
test('gate: a call is allowed only with the switch, the token, the matching digest and an unexpired approval', () => {
  const c = real();
  assert.deepEqual(founderGateProblems({ config: c, env: env(), nowIso: NOW }), []);
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['switch off', { allowLive: undefined }, 'INTAKE_ALLOW_LIVE_CALLS'], ['switch wrong', { allowLive: 'true' }, 'INTAKE_ALLOW_LIVE_CALLS'],
    ['no token', { twilioTokenPresent: false }, 'Twilio'], ['no digest', { approvedDigest: undefined }, 'DIGEST'], ['wrong digest', { approvedDigest: 'a'.repeat(64) }, 'DIGEST'],
  ];
  for (const [name, over, word] of cases) {
    const p = founderGateProblems({ config: c, env: env(over), nowIso: NOW });
    assert.ok(p.some((x) => x.includes(word)), name);
  }
  assert.ok(founderGateProblems({ config: c, env: env(), nowIso: '2026-11-21T00:00:01Z' }).some((x) => x.includes('expired')));
  assert.ok(founderGateProblems({ config: c, env: env(), nowIso: '2026-09-01T00:00:00Z' }).some((x) => x.includes('days')), 'an approval may not be open-ended');
});

test('gate: an edited config is not approved until it is approved again', () => {
  const c = real(); c.max_turns = 29;
  assert.ok(founderGateProblems({ config: c, env: env(), nowIso: NOW }).some((x) => x.includes('DIGEST')));
  assert.deepEqual(founderGateProblems({ config: c, env: env({ approvedDigest: founderConfigDigest(c) }), nowIso: NOW }), []);
});

test('gate: an invalid config is reported before the environment is looked at', () => {
  const c = real(); c.tenant = 'ws-synthetic-x';
  const p = founderGateProblems({ config: c, env: env(), nowIso: NOW });
  assert.ok(p.length > 0 && !p.some((x) => x.includes('INTAKE_ALLOW_LIVE_CALLS')));
});

test('cost: the Claude ceiling is a small, finite number and unknown models have none; signed URL forms are both offered', () => {
  const c = claudeCeilingUsd('claude-haiku-5-5', 150) as number;
  assert.ok(c > 0 && c < 1, String(c));
  assert.equal(claudeCeilingUsd('claude-unknown-9', 10), null);
});

// ---------------------------------------------------------------- the URL forms a handshake signature may cover
test('signed URL candidates: the address and its https form, each with and without a trailing slash, in a fixed order', () => {
  const u = `wss://h.example.test/relay/${SECRET}`;
  assert.deepEqual(signedUrlCandidates(u), [u, `https://h.example.test/relay/${SECRET}`, `${u}/`, `https://h.example.test/relay/${SECRET}/`]);
});

test('signed URL candidates: an address that names a port also gets the four forms without it (Twilio drops the port when it signs over HTTPS)', () => {
  const u = `wss://h.example.test:8443/relay/${SECRET}`;
  const c = signedUrlCandidates(u);
  assert.equal(c.length, 8);
  assert.deepEqual(c.slice(0, 4), [u, `https://h.example.test:8443/relay/${SECRET}`, `${u}/`, `https://h.example.test:8443/relay/${SECRET}/`]);
  assert.deepEqual(c.slice(4), [`wss://h.example.test/relay/${SECRET}`, `https://h.example.test/relay/${SECRET}`, `wss://h.example.test/relay/${SECRET}/`, `https://h.example.test/relay/${SECRET}/`]);
});

test('signed URL candidates: no duplicates, and every one names the same host and the same secret path (nothing new is ever allowed)', () => {
  for (const u of [`wss://h.example.test/relay/${SECRET}`, `wss://h.example.test:443/relay/${SECRET}`, `wss://a-b.c.example.test:8443/relay/${SECRET}`]) {
    const c = signedUrlCandidates(u);
    assert.equal(new Set(c).size, c.length, u);
    const want = new URL(u.replace(/^wss:/, 'https:'));
    for (const form of c) {
      const got = new URL(form.replace(/^wss:/, 'https:'));
      assert.equal(got.hostname, want.hostname, form);
      assert.equal(got.pathname.replace(/\/$/, ''), want.pathname, form);
      assert.equal(got.search + got.hash, '', form);
      assert.ok(/^(wss|https):\/\//.test(form), form);
    }
  }
});

test('signed URL candidates: the composition root hands exactly these candidates to the WebSocket server', () => {
  const entry = readFileSync(new URL('../src/founder-call-entry.ts', import.meta.url), 'utf8');
  assert.ok(entry.includes('urls: signedUrlCandidates(config.public_wss_url)'));
  assert.ok(entry.includes('path: relayPathFor(config.public_wss_url)'), 'the request path is still the exact secret path, with no trailing-slash form');
});

// ---------------------------------------------------------------- the Intake entry's founder tier
const plumbing = JSON.parse(readFileSync(new URL('../examples/skill-plumbing.json', import.meta.url), 'utf8')).skill_config;
const FT = 'ws-founder-plumbing';
async function ctxFor(tenant: string) {
  const r = await mintExecutionContext({ credential: 'c', agent: 'intake' }, { verify: () => ({ kind: 'user', id: 'user-1' }), selectTenant: () => tenant, grants: () => ['intake:run'], newCorrelationId: () => 'corr-ft-1' });
  assert.equal(r.ok, true); return (r as any).context;
}
const provider = () => createMockProvider({
  classify_request: () => classifyAnswer('Emergency leak', 0.9),
  extract_fields: () => extractAnswer([{ name: 'Address', value: '[ADDRESS_1]', confidence: 0.9 }, { name: 'Job description', value: 'burst pipe', confidence: 0.9 }, { name: 'Preferred date', value: null, confidence: null }]),
});
const entryFor = (tenants: string[], founder?: { tenant: string }) => createIntakeEntry({
  registry: createTenantRegistry(Object.fromEntries(tenants.map((t) => [t, plumbing]))), provider: provider(), channelRef: 'channel-ft', now: () => NOW,
  ...(founder === undefined ? {} : { founderTest: founder }),
});
const msg = (tenant: string, over: Record<string, unknown> = {}) => ({
  workspace_id: tenant, event_id: 'evt-founder-CA0123456789abcdef-final', masked_text: 'Caller: there is a burst pipe at [ADDRESS_1]', masking: { applied: true, source: 'founder-test-call' }, ...over,
});

test('founder tier: off by default, so a founder-style record is refused as before', async () => {
  const r: any = await entryFor([FT]).run(await ctxFor(FT), msg(FT));
  assert.deepEqual([r.ok, r.error.code], [false, 'SYNTHETIC_ONLY']);
});

test('founder tier: on, the named tenant is accepted and goes through the same Intake path (category, fields, validation, hand-off)', async () => {
  const r: any = await entryFor([FT], { tenant: FT }).run(await ctxFor(FT), msg(FT));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual([r.outcome, r.workItem.status, r.workItem.category, r.workItem.missing_fields], ['handed-off', 'ready', 'Emergency leak', []]);
  assert.equal(r.workItem.workspace_id, FT);
  assert.equal(r.handoff.workspace_id, FT);
});

test('founder tier: still refuses another tenant, another masking source, a wrong event prefix and an unmasked declaration', async () => {
  const OTHER = 'ws-founder-other';
  const e = entryFor([FT, OTHER, 'ws-synthetic-x'], { tenant: FT });
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['other founder tenant', OTHER, {}], ['synthetic tenant', 'ws-synthetic-x', {}],
    ['wrong source', FT, { masking: { applied: true, source: 'something-else' } }], ['not applied', FT, { masking: { applied: false, source: 'founder-test-call' } }],
    ['synthetic event prefix', FT, { event_id: 'evt-synthetic-1' }], ['plain event prefix', FT, { event_id: 'evt-real-1' }], ['no masking', FT, { masking: undefined }],
  ];
  for (const [name, tenant, over] of cases) {
    const r: any = await e.run(await ctxFor(tenant), msg(tenant, over));
    assert.deepEqual([name, r.ok, r.error?.code], [name, false, 'SYNTHETIC_ONLY']);
  }
});

test('founder tier: synthetic fixtures still work on the same entry, and the sender cannot name the founder tenant for another context', async () => {
  const e = entryFor([FT, 'ws-synthetic-x'], { tenant: FT });
  const ok: any = await e.run(await ctxFor('ws-synthetic-x'), { workspace_id: 'ws-synthetic-x', event_id: 'evt-synthetic-9', masked_text: 'burst pipe at [ADDRESS_1]', masking: { applied: true, source: 'synthetic-fixture' } });
  assert.equal(ok.ok, true);
  const cross: any = await e.run(await ctxFor('ws-synthetic-x'), msg(FT));
  assert.equal(cross.ok, false);   // the message names a tenant that is not the context's
});

test('founder tier: setup is validated', () => {
  for (const bad of [{ tenant: 'ws-synthetic-x' }, { tenant: '' }, { tenant: 3 }, null, 'x']) assert.throws(() => entryFor([FT], bad as never), RangeError);
});

// ---------------------------------------------------------------- inventory
test('inventory: only the composition root mints a context, only the record store and the other two stores open SQLite, and the pipeline knows none of this', () => {
  const dir = new URL('../src/', import.meta.url);
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  const code = (f: string) => strip(readFileSync(new URL(f, dir), 'utf8'));
  assert.deepEqual(files.filter((f) => /\bmintExecutionContext\b/.test(code(f)) && f !== 'execution-context.ts'), ['founder-call-entry.ts', 'founder-voice-entry.ts', 'live-run.ts', 'pipeline.ts']);
  assert.deepEqual(files.filter((f) => /node:sqlite/.test(code(f))), ['approval-store-sqlite.ts', 'contact-vault.ts', 'intake-record-store.ts', 'reporting-ledger-sqlite.ts']);
  assert.deepEqual(files.filter((f) => /from 'node:(http|net|https|tls|dgram)'/.test(code(f))).sort(), ['dashboard-server.ts', 'realtime-probe.ts', 'ws-server.ts']);
  assert.deepEqual(files.filter((f) => /@anthropic-ai\/sdk/.test(code(f))).sort(), ['founder-call-entry.ts', 'live-entry.ts']);
  for (const f of ['pipeline.ts', 'intake-runner.ts', 'tenant-boundary.ts', 'model-gateway.ts']) assert.ok(!/founder|relay-handler|ws-server|dashboard-server/.test(code(f)), `${f} is unaware of the founder test`);
  for (const f of ['pii-screen.ts', 'call-session.ts', 'call-intake.ts', 'dialogue-model.ts', 'founder-call-gate.ts', 'relay-handler.ts']) {
    assert.ok(!/from 'node:(fs|http|net|https|child_process|sqlite)'|process\.env|process\.argv/.test(code(f)), `${f} does no I/O and reads no environment`);
  }
});
