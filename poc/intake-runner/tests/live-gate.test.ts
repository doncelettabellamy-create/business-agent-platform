// Tests for the live-call safety gate, the cost estimator, and static guarantees about the live entry point.
// Nothing here calls any API. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_LIVE_MODEL, isAllowedInputPath, liveGateProblems, parseLiveArgs, syntheticProblems } from '../src/live-gate.ts';
import type { LiveArgs } from '../src/live-gate.ts';
import { PRICES_PER_MILLION, approxTokens, costFromUsage, estimateCall, estimateRun, formatUsd } from '../src/cost-estimate.ts';
import { buildClaudeParams } from '../src/claude-provider.ts';
import { buildClassifyRequest, buildExtractRequest } from '../src/model-gateway.ts';

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const example = (name: string) => JSON.parse(read(`examples/${name}`));
const liveArgs = (extra: Partial<LiveArgs> = {}): LiveArgs => ({ ...parseLiveArgs(['--live']).args, ...extra });

// ---------------------------------------------------------------- argument parsing
test('args: defaults are a dry run on the synthetic skill example with the default model and a small call limit', () => {
  const { args, problems } = parseLiveArgs([]);
  assert.deepEqual(problems, []);
  assert.deepEqual(args, { live: false, inputPath: 'examples/skill-input.json', model: DEFAULT_LIVE_MODEL, effort: 'low', maxOutputTokens: 2048, maxCalls: 2 });
});

test('args: known flags parse, including --max-output-tokens (regression: it must not be mistaken for a credential)', () => {
  const { args, problems } = parseLiveArgs(['--live', '--model', 'claude-haiku-5-5', '--effort', 'medium', '--max-output-tokens', '1500', '--max-calls', '4', '--input', 'examples/valid-input.json']);
  assert.deepEqual(problems, []);
  assert.equal(args.live, true);
  assert.equal(args.model, 'claude-haiku-5-5');
  assert.equal(args.maxOutputTokens, 1500);
  assert.equal(args.maxCalls, 4);
});

test('args: credentials are never accepted on the command line, as a flag or as a value', () => {
  // Key-shaped strings are assembled at run time so this source file never contains a key-like literal.
  const fakeKeyA = ['sk', 'fakefakefake1'].join('-');
  const fakeKeyB = ['sk', 'ant', 'fakefakefake2'].join('-');
  for (const argv of [['--api-key', fakeKeyA], ['--live', '--model', fakeKeyB], ['--input', 'api_key.json'], [fakeKeyA], ['--bearer', 'x'], ['--authorization', 'y']]) {
    assert.ok(parseLiveArgs(argv).problems.some((p) => p.includes('credentials must never be passed')), argv.join(' '));
  }
});

test('args: unknown flags, missing values, bad models, bad efforts, and out-of-range limits are rejected', () => {
  const bad: string[][] = [
    ['--unknown'], ['--model'], ['--input', '--live'], ['--model', 'gpt-5'], ['--model', 'claude-opus-5-5-20260401'],
    ['--effort', 'max'], ['--max-calls', '0'], ['--max-calls', '11'], ['--max-calls', '1.5'], ['--max-output-tokens', '0'], ['--max-output-tokens', '5000'], ['--max-output-tokens', 'many'],
  ];
  for (const argv of bad) assert.ok(parseLiveArgs(argv).problems.length > 0, argv.join(' '));
});

// ---------------------------------------------------------------- input path and synthetic checks
test('input path: only plain .json files directly under examples/ are allowed', () => {
  for (const good of ['examples/skill-input.json', 'examples/valid-input.json']) assert.equal(isAllowedInputPath(good), true, good);
  for (const bad of ['', '/etc/passwd', 'C:\\data\\real.json', 'C:/data/real.json', '../examples/skill-input.json', 'examples/../src/cli.ts', 'examples/sub/x.json',
    'examples\\skill-input.json', 'examples/skill-input.txt', 'src/skill-input.json', '.env', 'examples/.env.json'.replace('.env.json', 'a b.json')]) {
    assert.equal(isAllowedInputPath(bad), false, bad);
  }
});

test('synthetic check: the skill examples pass; anything that looks real fails', () => {
  assert.deepEqual(syntheticProblems(example('skill-input.json')), []);
  assert.deepEqual(syntheticProblems(example('skill-ambiguous-input.json')), []);
  const mutate = (fn: (r: Record<string, unknown>) => void) => { const r = example('skill-input.json'); fn(r); return syntheticProblems(r); };
  assert.ok(mutate((r) => { r.workspace_id = 'ws-acme-1'; }).length > 0);
  assert.ok(mutate((r) => { r.event_id = 'evt-1234'; }).length > 0);
  assert.ok(mutate((r) => { r.correlation_id = 'corr-1'; }).length > 0);
  assert.ok(mutate((r) => { (r.masking as Record<string, unknown>).source = 'detector-v1'; }).length > 0);
  assert.ok(mutate((r) => { (r.masking as Record<string, unknown>).applied = false; }).length > 0);
  assert.ok(mutate((r) => { delete r.skill_config; }).length > 0);
  assert.ok(syntheticProblems(null).length > 0);
  assert.ok(syntheticProblems(example('valid-input.json')).length > 0, 'candidate-mode example has no skill_config');
});

// ---------------------------------------------------------------- the gate
test('gate: a live call needs --live, the environment confirmation, an allowed path, and a synthetic record', () => {
  const input = example('skill-input.json');
  assert.deepEqual(liveGateProblems({ args: liveArgs(), allowEnv: 'yes', input }), []);
  assert.ok(liveGateProblems({ args: liveArgs({ live: false }), allowEnv: 'yes', input }).some((p) => p.includes('--live')));
  for (const env of [undefined, '', 'no', 'true', '1', 'YES', 'yes ']) {
    assert.ok(liveGateProblems({ args: liveArgs(), allowEnv: env, input }).some((p) => p.includes('INTAKE_ALLOW_LIVE_CALLS')), String(env));
  }
  assert.ok(liveGateProblems({ args: liveArgs({ inputPath: '../real.json' }), allowEnv: 'yes', input }).some((p) => p.includes('examples/')));
  const real = { ...input, workspace_id: 'ws-customer-77' };
  assert.ok(liveGateProblems({ args: liveArgs(), allowEnv: 'yes', input: real }).length > 0);
});

// ---------------------------------------------------------------- cost estimate
function plannedCalls(model: string, maxTokens: number) {
  const input = example('skill-input.json');
  return [
    buildClaudeParams(buildClassifyRequest(input.masked_text, input.skill_config.categories.map((c: { name: string }) => c.name), maxTokens), model, 'low'),
    buildClaudeParams(buildExtractRequest(input.masked_text, input.skill_config.fields.map((f: { name: string; required: boolean }) => ({ name: f.name, required: f.required })), maxTokens), model, 'low'),
  ];
}

test('cost: price table is the documented snapshot and unknown models are not priced', () => {
  assert.deepEqual(PRICES_PER_MILLION['claude-opus-5-5'], { input: 4, output: 20 });
  assert.deepEqual(PRICES_PER_MILLION['claude-sonnet-5-5'], { input: 2, output: 10 });
  assert.deepEqual(PRICES_PER_MILLION['claude-haiku-5-5'], { input: 0.1, output: 0.5 });
  const p = plannedCalls('claude-opus-5-5', 2048)[0];
  assert.equal(estimateCall({ ...p, model: 'claude-future-9' }), null);
  assert.equal(costFromUsage('claude-future-9', 1, 1), null);
});

test('cost: the ceiling is input cost plus the whole output budget, and the low estimate is below it', () => {
  const p = plannedCalls('claude-opus-5-5', 2048)[0];
  const e = estimateCall(p);
  assert.ok(e);
  assert.equal(e.outputMax, 2048);
  const expectedCeiling = (e.inputTokens * 4 + 2048 * 20) / 1_000_000;
  assert.ok(Math.abs(e.costCeiling - expectedCeiling) < 1e-12);
  assert.ok(e.costLow < e.costCeiling);
  assert.ok(e.inputTokens > 150 && e.inputTokens < 2000, 'input estimate is plausible for this small request');
  assert.equal(approxTokens('abc'), 1);
});

test('cost: cheaper models cost less for identical requests, and run estimates add up', () => {
  const opus = estimateRun(plannedCalls('claude-opus-5-5', 2048));
  const sonnet = estimateRun(plannedCalls('claude-sonnet-5-5', 2048));
  const haiku = estimateRun(plannedCalls('claude-haiku-5-5', 2048));
  assert.ok(opus.priced && sonnet.priced && haiku.priced);
  assert.ok(opus.costCeiling > sonnet.costCeiling && sonnet.costCeiling > haiku.costCeiling);
  const calls = plannedCalls('claude-opus-5-5', 2048);
  const sum = estimateCall(calls[0])!.costCeiling + estimateCall(calls[1])!.costCeiling;
  assert.ok(Math.abs(opus.costCeiling - sum) < 1e-12);
  assert.equal(opus.calls, 2);
  assert.equal(estimateRun([{ ...calls[0], model: 'claude-future-9' }]).priced, false);
  assert.equal(formatUsd(0.00123), '$0.0012');
  assert.equal(formatUsd(0.1234), '$0.123');
});

test('cost: actual cost from usage uses the same table', () => {
  assert.ok(Math.abs(costFromUsage('claude-opus-5-5', 1_000_000, 1_000_000)! - 24) < 1e-9);
  assert.ok(Math.abs(costFromUsage('claude-haiku-5-5', 1_000_000, 1_000_000)! - 0.6) < 1e-9);
});

// ---------------------------------------------------------------- live entry point: static guarantees
test('live entry: dry run is the default, and the SDK is imported only after the gate and only once', () => {
  const src = read('src/live-entry.ts');
  const dryRunExit = src.indexOf('if (!args.live)');
  const gateCall = src.indexOf('liveGateProblems(');
  const sdkImport = src.indexOf("import('@anthropic-ai/sdk')");
  assert.ok(dryRunExit > 0 && gateCall > dryRunExit && sdkImport > gateCall, 'order: dry-run exit, then gate, then SDK import');
  assert.equal(src.split('@anthropic-ai/sdk').length - 1, 1, 'the SDK is named exactly once: in the dynamic import');
  assert.ok(!/^import[^;]*@anthropic-ai/m.test(src), 'no static import of the SDK');
  assert.ok(/maxRetries:\s*0/.test(src), 'no hidden SDK retries');
  assert.ok(/process\.env\.INTAKE_ALLOW_LIVE_CALLS/.test(src));
  assert.ok(src.indexOf('isAllowedInputPath(args.inputPath)') > 0 && src.indexOf('isAllowedInputPath(args.inputPath)') < src.indexOf('readFileSync(args.inputPath'), 'the path is checked before any file is read, even in a dry run');
});

test('live entry: it never reads or prints credentials, files other than the input, or writes anything', () => {
  const src = read('src/live-entry.ts');
  for (const banned of [/ANTHROPIC_API_KEY/, /ANTHROPIC_AUTH_TOKEN/, /apiKey/, /x-api-key/i, /dotenv|['"`]\.env/, /writeFile|appendFile|createWriteStream/, /child_process|spawn|exec\(/, /fetch\s*\(/, /process\.env(?!\.INTAKE_ALLOW_LIVE_CALLS)/]) {
    assert.ok(!banned.test(src), `banned pattern in live-entry: ${banned}`);
  }
  assert.ok(/call limit/.test(src) && /sent\s*>=\s*args\.maxCalls/.test(src), 'a hard per-run call limit wraps the client');
});

test('package scripts: no npm script can trigger a live call, and no SDK or other dependency is declared', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: unknown; devDependencies?: unknown; optionalDependencies?: unknown };
  for (const [name, cmd] of Object.entries(pkg.scripts)) assert.ok(!cmd.includes('--live'), `script ${name} must not contain --live`);
  assert.ok(!('dependencies' in pkg) && !('devDependencies' in pkg) && !('optionalDependencies' in pkg));
});

test('static guard: live-gate imports only local files and has no network, process, or I/O access', () => {
  const src = read('src/live-gate.ts');
  const imports = [...src.matchAll(/^import[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]);
  for (const spec of imports) assert.ok(spec.startsWith('./'), spec);
  for (const banned of [/\bfetch\s*\(/, /process\./, /node:/, /console\./, /https?:\/\//, /readFile/]) assert.ok(!banned.test(src), `banned: ${banned}`);
});
