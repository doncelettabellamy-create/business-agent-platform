// Pins who may import live-run.ts (the developer composition root) and exercises the ownership check directly.
// Local source scanning and pure functions only. No network, no key, synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { owned } from '../src/tenant-boundary.ts';
import type { RunResult } from '../src/intake-runner.ts';

const srcDir = new URL('../src/', import.meta.url);
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const srcFiles = readdirSync(srcDir).filter((n) => n.endsWith('.ts'));
const code = (f: string) => strip(readFileSync(new URL(f, srcDir), 'utf8'));
const mentions = (name: string) => srcFiles.filter((f) => f !== name && code(f).includes(name.replace('.ts', ''))).sort();

// ---------------------------------------------------------------- live-run.ts importers
test('live-run: only live-entry.ts references it, by any import form, in src or the package scripts', () => {
  // A static import, a dynamic import(), a require() and a re-export all name the module, so look for the module name itself.
  assert.deepEqual(srcFiles.filter((f) => f !== 'live-run.ts' && /live-run/.test(code(f))), ['live-entry.ts']);
  const pkg = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  assert.ok(!/live-run/.test(pkg), 'no npm script runs live-run directly');
  assert.ok(/node src\/live-entry\.ts/.test(pkg), 'the live script goes through live-entry');
});

test('live-run: live-entry.ts uses it through one static named import and one call, and no other src file re-exports it', () => {
  const entry = code('live-entry.ts');
  assert.equal((entry.match(/from\s+'\.\/live-run\.ts'/g) ?? []).length, 1);
  assert.ok(/import\s*\{\s*runReviewedLive\s*\}\s*from\s+'\.\/live-run\.ts'/.test(entry));
  assert.ok(!/import\s*\(\s*['"`]\.\/live-run/.test(entry), 'no dynamic import of live-run');
  assert.ok(!/export\s*(\*|\{[^}]*\})\s*from\s+'\.\/live-run/.test(entry), 'live-entry does not re-export it');
  for (const f of srcFiles) assert.ok(!/export\s*(\*|\{[^}]*\})\s*from\s+'\.\/live-run/.test(code(f)), `${f} must not re-export live-run`);
});

test('live-run: the files that can mint or reach raw authority are exactly the known ones', () => {
  assert.deepEqual(srcFiles.filter((f) => /\bmintExecutionContext\b/.test(code(f)) && f !== 'execution-context.ts'), ['founder-call-entry.ts', 'founder-voice-entry.ts', 'live-run.ts', 'pipeline.ts']);
  assert.deepEqual(mentions('live-run.ts'), ['live-entry.ts', 'observability.ts'].filter((f) => code(f).includes('live-run')).sort());
});

// ---------------------------------------------------------------- owned()
const T = 'ws-synthetic-plumbing';
const OTHER = 'ws-synthetic-dental';
function result(item: string, handoff: string | null | undefined, extra: Record<string, unknown> = {}): RunResult {
  const r: Record<string, unknown> = {
    ok: true, outcome: handoff === null ? 'needs-human' : 'handed-off',
    workItem: { item_id: 'wi-0123456789ab', workspace_id: item, category: 'CANARY-OWNED-CAT' },
    handoff: handoff === null || handoff === undefined ? null : { workspace_id: handoff, item_id: 'wi-0123456789ab' },
    ...extra,
  };
  return r as unknown as RunResult;
}
const code_ = (r: unknown) => (r as { error?: { code: string; message: string } }).error;

test('owned: a result that belongs to the tenant passes through unchanged (same object)', () => {
  const a = result(T, T);
  assert.equal(owned(T, a), a);
  const b = result(T, null);
  assert.equal(owned(T, b), b, 'needs-human has no handoff and is still owned');
});

test('owned: a work item naming another tenant is refused with CONTRACT_INVALID and no values echoed', () => {
  const r = owned(T, result(OTHER, T));
  assert.equal((r as { ok: boolean }).ok, false);
  assert.equal(code_(r)?.code, 'CONTRACT_INVALID');
  assert.ok(!JSON.stringify(r).includes('CANARY') && !JSON.stringify(r).includes(OTHER));
});

test('owned: a handoff naming another tenant is refused even when the work item is right', () => {
  const r = owned(T, result(T, OTHER));
  assert.equal(code_(r)?.code, 'CONTRACT_INVALID');
  assert.ok(!JSON.stringify(r).includes(OTHER));
});

test('owned: both parts wrong, and a needs-human item for another tenant, are refused', () => {
  assert.equal(code_(owned(T, result(OTHER, OTHER)))?.code, 'CONTRACT_INVALID');
  assert.equal(code_(owned(T, result(OTHER, null)))?.code, 'CONTRACT_INVALID');
});

test('owned: comparison is strict (case, whitespace, prefix) and an empty tenant matches nothing real', () => {
  for (const bad of [T.toUpperCase(), ` ${T}`, `${T} `, `${T}x`, T.slice(0, -1), '']) {
    assert.equal(code_(owned(T, result(bad, T)))?.code, 'CONTRACT_INVALID', `item ${JSON.stringify(bad)}`);
    assert.equal(code_(owned(T, result(T, bad)))?.code, 'CONTRACT_INVALID', `handoff ${JSON.stringify(bad)}`);
  }
});

test('owned: an error result passes through unchanged and is not re-labelled', () => {
  const e: RunResult = { ok: false, error: { code: 'INPUT_INVALID', message: 'fixed text' } };
  assert.equal(owned(T, e), e);
});

test('owned: it checks the tenant it is given, so a tenant captured earlier cannot be swapped by the result', () => {
  assert.equal(code_(owned(OTHER, result(T, T)))?.code, 'CONTRACT_INVALID');
});

test('owned: it is a pure check that adds no field and returns a fixed message', () => {
  const r = owned(T, result(OTHER, OTHER)) as { ok: false; error: { code: string; message: string } };
  assert.deepEqual(Object.keys(r).sort(), ['error', 'ok']);
  assert.deepEqual(Object.keys(r.error).sort(), ['code', 'message']);
  assert.equal(r.error.message, 'The result does not belong to the trusted tenant; refused.');
});

test('owned: no src file other than tenant-boundary.ts imports it', () => {
  assert.deepEqual(srcFiles.filter((f) => f !== 'tenant-boundary.ts' && /\bowned\b/.test(code(f).replace(/platform-owned|\bowned\s+by/gi, ''))
    && /import\s*(?:type\s*)?\{[^}]*\bowned\b[^}]*\}\s*from\s*'\.\/tenant-boundary\.ts'/.test(code(f))), []);
});
