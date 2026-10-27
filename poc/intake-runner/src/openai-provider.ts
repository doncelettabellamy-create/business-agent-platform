// OpenAI text adapter for the Intake proof of concept (step 2 of the OpenAI plan). It implements the EXISTING ModelProvider interface and nothing else:
// the gateway's rules (permissions, strict parsing, grounding, bounds, and "every model failure requires human review with no Processing handoff")
// are unchanged and still apply to everything this adapter returns. Extraction, grounding and the masking rules live in the gateway and the masker, not here.
//
// Like claude-provider.ts this file imports no SDK, reads no environment variables, holds no credential, and makes no network call itself. It is handed
// an already-constructed client (the shape of the official SDK's `client.responses.create`) by a composition root that does not exist yet, and it is tested
// here only with a fake client. NOTHING in this file has been run against the real service.
//
// Request design (the Responses API shape as documented; NOT yet checked against the live service or the current reference, see the report):
//   - Only the fixed instruction and the masked data are sent. No ids, no tenant data, no personal-data summary.
//   - The answer shape is enforced with structured outputs: text.format = { type: "json_schema", strict: true, schema }. The gateway still validates everything.
//   - store: false, so the exchange is not kept for later retrieval. (This is not a zero-retention guarantee: the provider's own abuse-monitoring retention is a separate matter.)
//   - No tools, no temperature or other sampling parameters, no streaming. A reasoning effort is sent only when one is configured, because only some models accept it.
//   - Refused, filtered, truncated or otherwise incomplete answers come back as EMPTY text so they can never be mistaken for a valid answer; the gateway then fails them
//     as invalid output and the item goes to a person.
//   - Provider errors are recorded as a class name and HTTP status only, then replaced by a generic error so no provider message (which might echo input) travels further.

import type { ModelProvider, ModelRequest, ModelResponse } from './model-gateway.ts';
import { answerSchema } from './claude-provider.ts';   // provider-neutral; move it into model-gateway.ts when the Claude adapter is retired

export type OpenAIEffort = 'minimal' | 'low' | 'medium' | 'high';

export interface OpenAIContentPart { type: string; text?: string; refusal?: string }
export interface OpenAIOutputItem { type: string; content?: OpenAIContentPart[] }
export interface OpenAIResponse {
  status?: string | null;
  incomplete_details?: { reason?: string | null } | null;
  output?: OpenAIOutputItem[];
  output_text?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}
export interface OpenAIParams {
  model: string;
  instructions: string;
  input: string;
  max_output_tokens: number;
  store: false;
  text: { format: { type: 'json_schema'; name: string; strict: true; schema: Record<string, unknown> } };
  reasoning?: { effort: OpenAIEffort };
}
/** The part of the official SDK client that the adapter needs. A fake with this shape is used in tests. */
export interface OpenAIClient {
  responses: { create(params: OpenAIParams, options?: { signal?: AbortSignal }): Promise<OpenAIResponse> };
}

export interface OpenAIStats {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  /** How each answer ended, as fixed words: completed, refusal, incomplete_<reason>, status_<status>, none. Never model text. */
  stop_reasons: Record<string, number>;
  /** Error class names and HTTP statuses only. Never messages. */
  errors: { name: string; status: number | null }[];
}
export interface OpenAIProvider extends ModelProvider {
  readonly model: string;
  readonly stats: OpenAIStats;
}

const MODEL_ID = /^(?:gpt|chatgpt|o[0-9])[a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const EFFORTS: readonly string[] = ['minimal', 'low', 'medium', 'high'];
const WORD = /^[a-z][a-z_]{0,39}$/;

/** A plausible OpenAI model id (for example gpt-5-mini). There is deliberately no default: the model is a decision, not a guess. */
export function isOpenAIModelId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= 64 && MODEL_ID.test(id);
}

/** Pure: the exact request body that would be sent. Used by the adapter and, later, a dry run and a cost estimate. */
export function buildOpenAIParams(request: ModelRequest, model: string, effort?: OpenAIEffort): OpenAIParams {
  if (!isOpenAIModelId(model)) throw new RangeError('model must be an exact OpenAI model id such as gpt-5-mini');
  if (effort !== undefined && !EFFORTS.includes(effort)) throw new RangeError('effort must be minimal, low, medium, or high');
  if (!Number.isInteger(request.max_output_tokens) || request.max_output_tokens < 1) throw new RangeError('max_output_tokens must be a positive integer');
  return {
    model,
    instructions: request.instruction,
    input: JSON.stringify({ task: request.task, data: request.data }),
    max_output_tokens: request.max_output_tokens,
    store: false,
    text: { format: { type: 'json_schema', name: request.task === 'classify_request' ? 'intake_category' : 'intake_fields', strict: true, schema: answerSchema(request) } },
    ...(effort === undefined ? {} : { reasoning: { effort } }),
  };
}

/** How the answer ended, as a fixed word: completed, refusal, incomplete_<reason>, status_<status>, or status_none. Only completed is usable. */
function endWord(r: OpenAIResponse): string {
  const status = typeof r.status === 'string' && WORD.test(r.status) ? r.status : (r.status === undefined || r.status === null ? 'none' : 'other');
  const blocks = Array.isArray(r.output) ? r.output : [];
  const refused = blocks.some((b) => b && Array.isArray(b.content) && b.content.some((c) => c && c.type === 'refusal'));
  if (refused) return 'refusal';
  if (status === 'incomplete') {
    const why = r.incomplete_details?.reason;
    return typeof why === 'string' && WORD.test(why) ? `incomplete_${why}` : 'incomplete_other';
  }
  return status === 'completed' ? 'completed' : `status_${status}`;
}

function textOf(r: OpenAIResponse): string {
  const items = Array.isArray(r.output) ? r.output : [];
  const parts: string[] = [];
  for (const item of items) {
    if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const c of item.content) if (c && c.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
  }
  if (parts.length > 0) return parts.join('');
  return items.length === 0 && typeof r.output_text === 'string' ? r.output_text : '';
}

export function createOpenAIProvider(client: OpenAIClient, options: { model: string; effort?: OpenAIEffort }): OpenAIProvider {
  const model = options.model;
  const effort = options.effort;
  buildOpenAIParams({ task: 'classify_request', instruction: 'x', data: { masked_text: 'x', categories: [] }, output_format: 'json', max_output_tokens: 1 }, model, effort); // validate config up front
  const stats: OpenAIStats = { calls: 0, input_tokens: 0, output_tokens: 0, stop_reasons: {}, errors: [] };

  return {
    id: `openai:${model}`,
    model,
    stats,
    async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
      const params = buildOpenAIParams(request, model, effort);
      stats.calls++;
      let response: OpenAIResponse;
      try {
        response = await client.responses.create(params, { signal });
      } catch (e) {
        const err = e as { constructor?: { name?: unknown }; status?: unknown };
        const name = typeof err?.constructor?.name === 'string' ? err.constructor.name.slice(0, 40) : 'Error';
        stats.errors.push({ name, status: typeof err?.status === 'number' ? err.status : null });
        throw new Error('openai request failed');           // provider message deliberately discarded
      }
      const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0);
      const usage = { input_tokens: num(response?.usage?.input_tokens), output_tokens: num(response?.usage?.output_tokens) };
      stats.input_tokens += usage.input_tokens;
      stats.output_tokens += usage.output_tokens;
      const end = response && typeof response === 'object' ? endWord(response) : 'none';
      stats.stop_reasons[end] = (stats.stop_reasons[end] ?? 0) + 1;
      if (end !== 'completed') return { text: '', usage };
      return { text: textOf(response), usage };
    },
  };
}
