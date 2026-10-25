// SYNTHETIC-ONLY live test entry point for the Claude adapter.
//
//   DEFAULT IS A DRY RUN: prints the exact request bodies and a cost estimate, and sends NOTHING.
//   A real call needs ALL of: --live, INTAKE_ALLOW_LIVE_CALLS=yes, an input file under examples/, a record that
//   is plainly synthetic (see live-gate.ts), AND a reviewed fixture whose content matches its pinned digest
//   (see reviewed-fixtures.ts), so real customer data can never be sent. The API credential is NEVER read or accepted by
//   this file: the official SDK resolves it from the environment or a stored login profile at construction time,
//   outside this repository.
//   The run itself goes through live-run.ts (developer authority, the controlled Intake entry, the tenant boundary and
//   the Intake permission). This file never calls the raw Intake runners.
//
// Run (dry run):   node src/live-entry.ts [--input examples/skill-input.json] [--model claude-haiku-5-5] [--effort low]
// Real call:       see README "Setup before the first live call". No npm script runs --live on purpose.
import { existsSync, readFileSync } from 'node:fs';
import { runReviewedLive } from './live-run.ts';
import { reviewedFixtureProblems } from './reviewed-fixtures.ts';
import { buildClassifyRequest, buildExtractRequest } from './model-gateway.ts';
import { buildClaudeParams, createClaudeProvider } from './claude-provider.ts';
import type { ClaudeClient, ClaudeParams, ClaudeMessage } from './claude-provider.ts';
import { PRICES_AS_OF, costFromUsage, estimateCall, estimateRun, formatUsd } from './cost-estimate.ts';
import { DEFAULT_LIVE_MODEL, LIVE_LIMITS, isAllowedInputPath, liveGateProblems, parseLiveArgs, syntheticProblems } from './live-gate.ts';
import type { IntakeInput } from './intake-runner.ts';

const { args, problems } = parseLiveArgs(process.argv.slice(2));
if (problems.length) {
  for (const p of problems) console.error(`argument problem: ${p}`);
  process.exit(64);
}

// Even a dry run reads only plain .json files directly under examples/.
if (!isAllowedInputPath(args.inputPath)) {
  console.error('argument problem: --input must be a .json file directly under examples/');
  process.exit(64);
}

let input: unknown;
try {
  input = JSON.parse(readFileSync(args.inputPath, 'utf8'));
} catch {
  console.error('Could not read the input file as JSON.');
  process.exit(66);
}

// The two calls the runner would make for this input (so the preview and estimate match what would be sent).
const typed = input as IntakeInput;
const cfg = typed.skill_config;
if (!cfg || typeof typed.masked_text !== 'string') {
  console.error('Input needs masked_text and skill_config (model mode).');
  process.exit(65);
}
const planned: ClaudeParams[] = [
  buildClaudeParams(buildClassifyRequest(typed.masked_text, cfg.categories.map((c) => c.name), args.maxOutputTokens), args.model, args.effort),
  buildClaudeParams(buildExtractRequest(typed.masked_text, cfg.fields.map((f) => ({ name: f.name, required: f.required })), args.maxOutputTokens), args.model, args.effort),
];

console.log(`Mode: ${args.live ? 'LIVE REQUESTED (gate checks follow)' : 'DRY RUN (nothing will be sent)'}`);
console.log(`Model: ${args.model}   effort: ${args.effort}   max output tokens per call: ${args.maxOutputTokens}   call limit: ${args.maxCalls}`);
console.log('\nRequest bodies that would be sent (no credentials are part of the body):');
for (const p of planned) console.log(JSON.stringify(p, null, 2));
const est = estimateRun(planned);
const first = estimateCall(planned[0]);
console.log(`\nEstimated cost for ${est.calls} calls (list prices as of ${PRICES_AS_OF}; verify before spending):`);
if (!est.priced || !first) console.log('  no price on file for this model; cannot estimate');
else console.log(`  low ${formatUsd(est.costLow)}   hard ceiling ${formatUsd(est.costCeiling)} (every call using its whole output budget)`);

// Readiness report: what a --live run would check, shown without making any call or reading any credential.
// (Whether a credential exists is deliberately NOT checked here: this file never looks at credentials.)
const sdkPresent = existsSync(['node_modules', '@anthropic-ai', 'sdk', 'package.json'].join('/'));
const syntheticIssues = syntheticProblems(input);
const readiness: [boolean, string][] = [
  [args.model === DEFAULT_LIVE_MODEL, `model is the default ${DEFAULT_LIVE_MODEL} (this run: ${args.model})`],
  [reviewedFixtureProblems(args.inputPath, input).length === 0, 'input is a reviewed fixture (path listed and content matches its pinned digest)'],
  [isAllowedInputPath(args.inputPath) && syntheticIssues.length === 0, `input is a synthetic example under examples/ (${args.inputPath})${syntheticIssues.length ? ': ' + syntheticIssues.join('; ') : ''}`],
  [planned.length === LIVE_LIMITS.defaultMaxCalls && args.maxCalls === LIVE_LIMITS.defaultMaxCalls, `planned calls ${planned.length}, call limit ${args.maxCalls} (default limit ${LIVE_LIMITS.defaultMaxCalls})`],
  [args.maxCalls >= planned.length, 'call limit covers the planned calls'],
  [sdkPresent, 'official SDK is installed locally (needed only for a live call)'],
  [process.env.INTAKE_ALLOW_LIVE_CALLS === 'yes', 'INTAKE_ALLOW_LIVE_CALLS=yes is set (set it only at go time)'],
  [args.live, '--live flag given (add it only at go time)'],
];
console.log('\nReadiness for a live call (nothing is sent in a dry run):');
for (const [ok, text] of readiness) console.log(`  [${ok ? 'ok' : '--'}] ${text}`);

if (!args.live) {
  console.log('\nNo call was made.');
  process.exit(0);
}

const gate = liveGateProblems({ args, allowEnv: process.env.INTAKE_ALLOW_LIVE_CALLS, input });
gate.push(...reviewedFixtureProblems(args.inputPath, input));
if (gate.length) {
  for (const g of gate) console.error(`live call refused: ${g}`);
  process.exit(78);
}
if (est.calls > args.maxCalls) {
  console.error('live call refused: planned calls exceed --max-calls');
  process.exit(78);
}

// ---- Only past this line can anything leave the machine. ----
let Anthropic: new (options: Record<string, unknown>) => ClaudeClient;
try {
  const sdk = (await import('@anthropic-ai/sdk')) as unknown as { default: typeof Anthropic };
  Anthropic = sdk.default;
} catch {
  console.error('The official SDK is not installed. Run the setup steps in README.md first. Nothing was sent.');
  process.exit(69);
}

// maxRetries 0: the gateway owns attempts, so there are no hidden retries and the call count is exact.
const sdkClient = new Anthropic({ maxRetries: 0, timeout: 60_000 });
let sent = 0;
const limited: ClaudeClient = {
  messages: {
    async create(params: ClaudeParams, options?: { signal?: AbortSignal }): Promise<ClaudeMessage> {
      if (sent >= args.maxCalls) throw new Error('call limit reached');
      sent++;
      return sdkClient.messages.create(params, options);
    },
  },
};
const provider = createClaudeProvider(limited, { model: args.model, effort: args.effort });
const result = await runReviewedLive({ path: args.inputPath, input, provider, maxOutputTokens: args.maxOutputTokens, timeoutMs: 60_000 });

console.log('\nResult (no prompts or provider text are shown):');
if (!result.ok) console.log(`  refused: ${result.error.code}`);
else {
  console.log(`  outcome: ${result.outcome}   status: ${result.workItem.status}   category: ${result.workItem.category}   reasons: [${result.workItem.reasons.join(', ')}]`);
  for (const t of result.trace ?? []) console.log(`  ${t.skill}: ${t.source}${t.failure ? ` (${t.failure})` : ''}`);
}
const s = provider.stats;
const actual = costFromUsage(args.model, s.input_tokens, s.output_tokens);
console.log(`  calls: ${s.calls}   input tokens: ${s.input_tokens}   output tokens: ${s.output_tokens}   stop reasons: ${JSON.stringify(s.stop_reasons)}`);
if (s.errors.length) console.log(`  errors (class and status only): ${JSON.stringify(s.errors)}`);
if (actual !== null) console.log(`  approximate actual cost: ${formatUsd(actual)}`);
process.exit(result.ok ? 0 : 2);
