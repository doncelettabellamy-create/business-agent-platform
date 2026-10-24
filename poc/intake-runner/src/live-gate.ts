// Safety gate for the optional live test entry point. Pure functions: no I/O, no environment access, no network.
// The entry point (live-entry.ts) passes in what it read; nothing here can call an API.
//
// A live call needs ALL of: the --live flag, INTAKE_ALLOW_LIVE_CALLS=yes in the environment, an input file under
// examples/, and a record that is plainly synthetic. Anything else is a dry run that sends nothing.
// Credentials are never accepted on the command line and never read here.

import { isClaudeModelId } from './claude-provider.ts';
import type { Effort } from './claude-provider.ts';
import { isRecord } from './contracts.ts';

// Default for the synthetic live test: Claude Haiku 5.5. Anthropic's models overview (checked 2026-10-24) lists it as an
// active current model with API id claude-haiku-5-5, aimed at classification and extraction, and the cheapest current model.
export const DEFAULT_LIVE_MODEL = 'claude-haiku-5-5';
export const LIVE_LIMITS = { maxCalls: 10, maxOutputTokens: 4096, defaultOutputTokens: 2048, defaultMaxCalls: 2 } as const;

export interface LiveArgs {
  live: boolean;
  inputPath: string;
  model: string;
  effort: Effort;
  maxOutputTokens: number;
  maxCalls: number;
}

const KEY_LIKE = /sk-[A-Za-z0-9_-]{8,}|api[_-]?key|bearer|authorization|secret/i;
const VALUE_FLAGS = ['--input', '--model', '--effort', '--max-output-tokens', '--max-calls'];

/** Parses command-line words. Returns problems instead of throwing. */
export function parseLiveArgs(argv: string[]): { args: LiveArgs; problems: string[] } {
  const problems: string[] = [];
  const args: LiveArgs = {
    live: false, inputPath: 'examples/skill-input.json', model: DEFAULT_LIVE_MODEL, effort: 'low',
    maxOutputTokens: LIVE_LIMITS.defaultOutputTokens, maxCalls: LIVE_LIMITS.defaultMaxCalls,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (KEY_LIKE.test(a)) { problems.push('credentials must never be passed as arguments'); continue; }
    if (a === '--live') { args.live = true; continue; }
    if (!VALUE_FLAGS.includes(a)) { problems.push('unknown argument'); continue; }
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) { problems.push(`${a} needs a value`); continue; }
    if (KEY_LIKE.test(v)) { problems.push('credentials must never be passed as arguments'); continue; }
    if (a === '--input') args.inputPath = v;
    else if (a === '--model') args.model = v;
    else if (a === '--effort') { if (v === 'low' || v === 'medium' || v === 'high') args.effort = v; else problems.push('--effort must be low, medium, or high'); }
    else if (a === '--max-output-tokens') args.maxOutputTokens = Number(v);
    else if (a === '--max-calls') args.maxCalls = Number(v);
  }
  if (!isClaudeModelId(args.model)) problems.push('--model must be an exact Claude model id such as claude-haiku-5-5');
  if (!Number.isInteger(args.maxOutputTokens) || args.maxOutputTokens < 1 || args.maxOutputTokens > LIVE_LIMITS.maxOutputTokens) {
    problems.push(`--max-output-tokens must be an integer from 1 to ${LIVE_LIMITS.maxOutputTokens}`);
  }
  if (!Number.isInteger(args.maxCalls) || args.maxCalls < 1 || args.maxCalls > LIVE_LIMITS.maxCalls) {
    problems.push(`--max-calls must be an integer from 1 to ${LIVE_LIMITS.maxCalls}`);
  }
  return { args, problems };
}

/** The input file must be a plain relative path under examples/ ending in .json (no parent segments, no absolute paths). */
export function isAllowedInputPath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.length > 120) return false;
  if (/^[A-Za-z]:|^[\\/]|\.\.|\\|\0/.test(p)) return false;
  return /^examples\/[A-Za-z0-9._-]+\.json$/.test(p);
}

/** The record must be unmistakably synthetic. */
export function syntheticProblems(input: unknown): string[] {
  if (!isRecord(input)) return ['input is not an object'];
  const problems: string[] = [];
  if (typeof input.workspace_id !== 'string' || !input.workspace_id.startsWith('ws-synthetic-')) problems.push('workspace_id must start with ws-synthetic-');
  if (typeof input.event_id !== 'string' || !input.event_id.startsWith('evt-synthetic-')) problems.push('event_id must start with evt-synthetic-');
  if (typeof input.correlation_id !== 'string' || !input.correlation_id.startsWith('corr-synthetic-')) problems.push('correlation_id must start with corr-synthetic-');
  if (!isRecord(input.masking) || input.masking.source !== 'synthetic-fixture' || input.masking.applied !== true) problems.push('masking must be applied with source synthetic-fixture');
  if (!isRecord(input.skill_config)) problems.push('skill_config is required for model mode');
  return problems;
}

/** All conditions for a real call. An empty list means the call is permitted. */
export function liveGateProblems(opts: { args: LiveArgs; allowEnv: string | undefined; input: unknown }): string[] {
  const problems: string[] = [];
  if (!opts.args.live) problems.push('--live was not given');
  if (opts.allowEnv !== 'yes') problems.push('INTAKE_ALLOW_LIVE_CALLS is not set to yes');
  if (!isAllowedInputPath(opts.args.inputPath)) problems.push('input must be a .json file directly under examples/');
  problems.push(...syntheticProblems(opts.input));
  return problems;
}
