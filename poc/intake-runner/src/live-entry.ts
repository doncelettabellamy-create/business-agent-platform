// SYNTHETIC-ONLY live test entry point for the Claude adapter.
//
//   DEFAULT IS A DRY RUN: prints the exact request bodies and a cost estimate, and sends NOTHING.
//   A real call needs ALL of: --live, INTAKE_ALLOW_LIVE_CALLS=yes, an input file under examples/, and a record that
//   is plainly synthetic (see live-gate.ts). The API credential is NEVER read or accepted by this file: the official
//   SDK resolves it from the environment or a stored login profile at construction time, outside this repository.
//
// Run (dry run):   node src/live-entry.ts [--input examples/skill-input.json] [--model claude-haiku-5-5] [--effort low]
// Real call:       see README "Setup before the first live call". No npm script runs --live on purpose.
import { readFileSync } from 'node:fs';
import { runIntakeWithModel } from './intake-runner.ts';
import { buildClassifyRequest, buildExtractRequest } from './model-gateway.ts';
import { buildClaudeParams, createClaudeProvider } from './claude-provider.ts';
import type { ClaudeClient, ClaudeParams, ClaudeMessage } from './claude-provider.ts';
import { PRICES_AS_OF, costFromUsage, estimateCall, estimateRun, formatUsd } from './cost-estimate.ts';
import { isAllowedInputPath, liveGateProblems, parseLiveArgs } from './live-gate.ts';
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

if (!args.live) {
  console.log('\nNo call was made.');
  process.exit(0);
}

const gate = liveGateProblems({ args, allowEnv: process.env.INTAKE_ALLOW_LIVE_CALLS, input });
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
const result = await runIntakeWithModel(input, { provider, maxOutputTokens: args.maxOutputTokens, timeoutMs: 60_000, maxAttempts: 1 });

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
