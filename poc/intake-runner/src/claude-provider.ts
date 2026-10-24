// Claude API adapter for the Intake proof of concept. It implements the EXISTING ModelProvider interface and
// nothing else: the gateway's rules (permissions, strict parsing, grounding, bounds, and "every model failure
// requires human review with no Processing handoff") are unchanged and still apply to everything this adapter returns.
//
// This file imports no SDK, reads no environment variables, holds no credentials, and makes no network call itself.
// It is handed an already-constructed client object (the official SDK's `client.messages.create` shape) by a
// composition root (src/live-entry.ts) and is tested here only with a fake client.
//
// Request design (checked against the Claude API docs, 2026-10-24):
//   - Only the fixed instruction (system) and the masked data (user message) are sent. No ids, no tenant data.
//   - The answer shape is enforced with structured outputs: output_config.format = { type: "json_schema", schema }.
//     Unsupported schema features (numeric ranges, string lengths) are NOT used; the gateway validates them anyway.
//   - No thinking, temperature, top_p, top_k, prefill, or forced tool_choice parameters are sent: current models
//     manage thinking themselves and reject the others. Depth is limited with output_config.effort (default "low").
//   - Refused or truncated answers (stop_reason "refusal" or "max_tokens") are returned as EMPTY text so they can never
//     be mistaken for a valid answer; the gateway then fails them as invalid output and the item goes to a person.
//   - Provider errors are recorded as a class name and HTTP status only, then replaced by a generic error so no
//     provider message (which might echo input) can travel further.

import type { ModelProvider, ModelRequest, ModelResponse } from './model-gateway.ts';

export type Effort = 'low' | 'medium' | 'high';

export interface ClaudeContentBlock { type: string; text?: string }
export interface ClaudeMessage {
  content?: ClaudeContentBlock[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}
export interface ClaudeParams {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: 'user'; content: string }[];
  output_config: { effort: Effort; format: { type: 'json_schema'; schema: Record<string, unknown> } };
}
/** The part of the official SDK client that the adapter needs. A fake with this shape is used in tests. */
export interface ClaudeClient {
  messages: { create(params: ClaudeParams, options?: { signal?: AbortSignal }): Promise<ClaudeMessage> };
}

export interface ClaudeStats {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  stop_reasons: Record<string, number>;
  /** Error class names and HTTP statuses only. Never messages. */
  errors: { name: string; status: number | null }[];
}

export interface ClaudeProvider extends ModelProvider {
  readonly model: string;
  readonly stats: ClaudeStats;
}

const MODEL_ID = /^claude-[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE_SUFFIX = /-\d{8}$/;
const EFFORTS: readonly string[] = ['low', 'medium', 'high'];

/** Exact model strings only (for example claude-haiku-5-5); date-suffixed ids are not accepted. */
export function isClaudeModelId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= 64 && MODEL_ID.test(id) && !DATE_SUFFIX.test(id);
}

const NUMBER_OR_NULL = { anyOf: [{ type: 'number' }, { type: 'null' }] };

/** JSON Schema for the task's answer. Uses only features the structured-outputs feature supports. */
export function answerSchema(request: ModelRequest): Record<string, unknown> {
  if (request.task === 'classify_request') {
    const categories = request.data.categories ?? [];
    return {
      type: 'object',
      properties: {
        category: { anyOf: [{ type: 'string', enum: [...categories] }, { type: 'null' }] },
        confidence: NUMBER_OR_NULL,
      },
      required: ['category', 'confidence'],
      additionalProperties: false,
    };
  }
  const names = (request.data.fields ?? []).map((f) => f.name);
  return {
    type: 'object',
    properties: {
      fields: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', enum: names },
            value: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            confidence: NUMBER_OR_NULL,
          },
          required: ['name', 'value', 'confidence'],
          additionalProperties: false,
        },
      },
    },
    required: ['fields'],
    additionalProperties: false,
  };
}

/** Pure: the exact request body that would be sent. Used by the adapter, the dry run, and the cost estimate. */
export function buildClaudeParams(request: ModelRequest, model: string, effort: Effort = 'low'): ClaudeParams {
  if (!isClaudeModelId(model)) throw new RangeError('model must be an exact Claude model id such as claude-haiku-5-5');
  if (!EFFORTS.includes(effort)) throw new RangeError('effort must be low, medium, or high');
  if (!Number.isInteger(request.max_output_tokens) || request.max_output_tokens < 1) throw new RangeError('max_output_tokens must be a positive integer');
  return {
    model,
    max_tokens: request.max_output_tokens,
    system: request.instruction,
    messages: [{ role: 'user', content: JSON.stringify({ task: request.task, data: request.data }) }],
    output_config: { effort, format: { type: 'json_schema', schema: answerSchema(request) } },
  };
}

function textOf(message: ClaudeMessage): string {
  const blocks = Array.isArray(message.content) ? message.content : [];
  return blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('');
}

export function createClaudeProvider(client: ClaudeClient, options: { model: string; effort?: Effort }): ClaudeProvider {
  const model = options.model;
  const effort = options.effort ?? 'low';
  buildClaudeParams({ task: 'classify_request', instruction: 'x', data: { masked_text: 'x', categories: [] }, output_format: 'json', max_output_tokens: 1 }, model, effort); // validate config up front
  const stats: ClaudeStats = { calls: 0, input_tokens: 0, output_tokens: 0, stop_reasons: {}, errors: [] };

  return {
    id: `claude:${model}`,
    model,
    stats,
    async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
      const params = buildClaudeParams(request, model, effort);
      stats.calls++;
      let message: ClaudeMessage;
      try {
        message = await client.messages.create(params, { signal });
      } catch (e) {
        const err = e as { constructor?: { name?: unknown }; status?: unknown };
        const name = typeof err?.constructor?.name === 'string' ? err.constructor.name.slice(0, 40) : 'Error';
        stats.errors.push({ name, status: typeof err?.status === 'number' ? err.status : null });
        throw new Error('claude request failed');           // provider message deliberately discarded
      }
      const usage = { input_tokens: message.usage?.input_tokens ?? 0, output_tokens: message.usage?.output_tokens ?? 0 };
      stats.input_tokens += usage.input_tokens;
      stats.output_tokens += usage.output_tokens;
      const reason = typeof message.stop_reason === 'string' ? message.stop_reason.slice(0, 40) : 'none';
      stats.stop_reasons[reason] = (stats.stop_reasons[reason] ?? 0) + 1;
      if (reason === 'refusal' || reason === 'max_tokens') return { text: '', usage };
      return { text: textOf(message), usage };
    },
  };
}
