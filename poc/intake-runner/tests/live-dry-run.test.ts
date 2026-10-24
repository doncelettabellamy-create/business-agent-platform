// End-to-end tests of the live entry point's SAFE paths (dry run and refusals), run as a child process.
//
// SAFETY: every child process gets a sanitized environment with INTAKE_ALLOW_LIVE_CALLS and every ANTHROPIC_* variable
// removed, so these tests can never make a live call even if the person running them has set those variables.
// No test passes INTAKE_ALLOW_LIVE_CALLS=yes together with --live; the path that would reach the SDK is not exercised here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

function safeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k === 'INTAKE_ALLOW_LIVE_CALLS' || k.startsWith('ANTHROPIC_')) delete env[k];
  return env;
}
function runEntry(args: string[]) {
  const env = safeEnv();
  assert.equal(env.INTAKE_ALLOW_LIVE_CALLS, undefined, 'the test environment must not allow live calls');
  assert.ok(!Object.keys(env).some((k) => k.startsWith('ANTHROPIC_')), 'the test environment must hold no credentials');
  const r = spawnSync(process.execPath, ['src/live-entry.ts', ...args], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

test('dry run: default is claude-haiku-5-5, two synthetic calls, a call limit of two, nothing sent', () => {
  const r = runEntry([]);
  assert.equal(r.status, 0);
  assert.ok(r.out.includes('DRY RUN (nothing will be sent)'));
  assert.ok(r.out.includes('Model: claude-haiku-5-5'));
  assert.ok(r.out.includes('call limit: 2'));
  assert.equal((r.out.match(/"model": "claude-haiku-5-5"/g) ?? []).length, 2, 'exactly two request bodies, both Haiku');
  assert.ok(!/claude-opus|claude-sonnet/.test(r.out), 'no other model appears');
  assert.ok(r.out.includes('[PERSON_1]') && r.out.includes('[ID_1]'), 'the text is the masked synthetic example');
  assert.ok(r.out.includes('No call was made.'));
  assert.ok(!r.out.includes('Result (no prompts'), 'no result section, because nothing ran');
});

test('dry run: readiness checklist shows what is ready now and what is only needed at go time', () => {
  const r = runEntry([]);
  const line = (needle: string) => r.out.split('\n').find((l) => l.includes(needle)) ?? '';
  assert.ok(line('model is the default claude-haiku-5-5').includes('[ok]'));
  assert.ok(line('input is a synthetic example under examples/').includes('[ok]'));
  assert.ok(line('planned calls 2, call limit 2').includes('[ok]'));
  assert.ok(line('call limit covers the planned calls').includes('[ok]'));
  assert.ok(line('INTAKE_ALLOW_LIVE_CALLS=yes is set').includes('[--]'), 'the confirmation is not set');
  assert.ok(line('--live flag given').includes('[--]'), 'the live flag is not given');
  assert.ok(line('official SDK is installed locally').length > 0);
  assert.ok(r.out.includes('Estimated cost for 2 calls'));
});

test('dry run: a second example is also synthetic; a lower call limit or another model is flagged, not hidden', () => {
  const lower = runEntry(['--max-calls', '1']);
  assert.equal(lower.status, 0);
  assert.ok(lower.out.split('\n').find((l) => l.includes('planned calls 2, call limit 1'))?.includes('[--]'));
  assert.ok(lower.out.split('\n').find((l) => l.includes('call limit covers the planned calls'))?.includes('[--]'));
  const other = runEntry(['--model', 'claude-sonnet-5-5']);
  assert.ok(other.out.split('\n').find((l) => l.includes('model is the default'))?.includes('[--]'));
  const amb = runEntry(['--input', 'examples/skill-ambiguous-input.json']);
  assert.equal(amb.status, 0);
  assert.ok(amb.out.split('\n').find((l) => l.includes('input is a synthetic example'))?.includes('[ok]'));
});

test('refusals: --live without the environment confirmation sends nothing and exits 78', () => {
  const r = runEntry(['--live']);
  assert.equal(r.status, 78);
  assert.ok(r.err.includes('INTAKE_ALLOW_LIVE_CALLS is not set to yes'));
  assert.ok(!r.out.includes('Result (no prompts'));
  assert.ok(!r.out.includes('No call was made.'), 'it refused at the gate rather than finishing a dry run');
});

test('refusals: credentials as arguments, paths outside examples/, and non-synthetic or non-model-mode inputs are all refused', () => {
  const fakeKey = ['sk', 'fakefakefake4'].join('-');
  const a = runEntry(['--api-key', fakeKey]);
  assert.equal(a.status, 64);
  assert.ok(a.err.includes('credentials must never be passed as arguments'));
  assert.ok(!a.out.includes(fakeKey) && !a.err.includes(fakeKey), 'a rejected credential is never echoed');

  assert.equal(runEntry(['--input', '../../docs/BUSINESS_BLUEPRINT.md']).status, 64);
  assert.equal(runEntry(['--input', 'examples/missing.json']).status, 66);
  assert.equal(runEntry(['--input', 'examples/valid-input.json']).status, 65, 'candidate-mode example has no skill_config');
  assert.equal(runEntry(['--model', 'gpt-5']).status, 64);
  assert.equal(runEntry(['--max-calls', '99']).status, 64);
});
