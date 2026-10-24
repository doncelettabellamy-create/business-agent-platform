// Rough cost estimator for planned Claude calls. Pure arithmetic: no network, no I/O.
//
// PRICES ARE A SNAPSHOT, NOT A GUARANTEE. They come from the Claude API skill's cached model table dated
// 2026-10-06 (list prices, USD per million tokens, first-party API). Check the pricing page before spending.
// Haiku 5.5's listed price applies to prompts up to 100K tokens, far above anything here.
//
// The estimate cannot know how many "thinking" tokens a model will use (current models think by default and
// those tokens are billed as output and count toward max_tokens). So it reports a LOW estimate (short answer)
// and a CEILING (every call uses its entire max_tokens budget). The ceiling is a hard cap on spend per call.

import type { ClaudeParams } from './claude-provider.ts';

export const PRICES_AS_OF = '2026-10-06';
export const PRICES_PER_MILLION: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 4.0, output: 20.0 },
  'claude-sonnet-5-5': { input: 2.0, output: 10.0 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};

/** Conservative token estimate (about 3 characters per token; real English text is nearer 4). */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export interface CallEstimate {
  inputTokens: number;
  outputLow: number;
  outputMax: number;
  costLow: number;
  costCeiling: number;
}

/** Fixed allowance for message framing and the compiled-schema overhead (a guess; kept deliberately generous). */
const FRAMING_TOKENS = 150;
/** A short JSON answer, with a small allowance for thinking. Not a promise. */
const LOW_OUTPUT_TOKENS = 150;

export function estimateCall(params: ClaudeParams): CallEstimate | null {
  const price = PRICES_PER_MILLION[params.model];
  if (!price) return null;
  const inputTokens = approxTokens(params.system) + approxTokens(JSON.stringify(params.messages)) + approxTokens(JSON.stringify(params.output_config.format.schema)) + FRAMING_TOKENS;
  const outputLow = Math.min(LOW_OUTPUT_TOKENS, params.max_tokens);
  const outputMax = params.max_tokens;
  const inCost = (inputTokens * price.input) / 1_000_000;
  return {
    inputTokens,
    outputLow,
    outputMax,
    costLow: inCost + (outputLow * price.output) / 1_000_000,
    costCeiling: inCost + (outputMax * price.output) / 1_000_000,
  };
}

export interface RunEstimate { calls: number; costLow: number; costCeiling: number; priced: boolean }

export function estimateRun(calls: ClaudeParams[]): RunEstimate {
  let low = 0, ceiling = 0, priced = true;
  for (const c of calls) {
    const e = estimateCall(c);
    if (!e) { priced = false; continue; }
    low += e.costLow;
    ceiling += e.costCeiling;
  }
  return { calls: calls.length, costLow: low, costCeiling: ceiling, priced };
}

/** Actual cost from reported usage (same price table). */
export function costFromUsage(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = PRICES_PER_MILLION[model];
  if (!price) return null;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

export function formatUsd(x: number): string {
  return x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(3)}`;
}
