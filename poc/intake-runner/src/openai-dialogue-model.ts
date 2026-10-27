// The spoken side of Agent 1 on OpenAI (founder voice test): the same DialogueModel the call logic already uses, answered by OpenAI's text model instead of Claude's. It only TALKS: the record still comes from
// the Intake agent over the masked caller lines. What the model is sent is exactly what the Claude version sends: the fixed instruction, the Drew persona line (when a persona is given, after every rule and before
// the NEXT line, which stays last), the MASKED conversation so far, and ONE directive chosen by code. No tenant id, no phone number, no raw speech.
//
// The reply is NOT streamed: the Realtime voice speaks a reply only after its full text exists (realtime-transport.ts), so streaming would add nothing, and one whole answer is one piece for the call logic. The
// silence recovery (an empty reply is retried once, then the fixed wording; a refusal ends the call and saves unconfirmed) is the call logic's and is unchanged. This file maps how the answer ended onto the same fixed
// words the Claude model reports: END_TURN, MAX_TOKENS, REFUSAL, OTHER (never any model text).
// Like openai-provider.ts it imports no SDK, reads no environment and holds no credential: it is handed a client with `responses.create`. Errors are recorded as a class name and HTTP status only.

import { DIALOGUE_INSTRUCTION, renderDirective, toMessages } from './dialogue-model.ts';
import type { DialogueInput, DialogueModel, DialogueStats } from './dialogue-model.ts';
import { dialogueStyle, isPersona } from './persona.ts';
import type { Persona } from './persona.ts';
import { endWord, isOpenAIModelId, textOf } from './openai-provider.ts';
import type { OpenAIEffort, OpenAIResponse } from './openai-provider.ts';

export interface OpenAITextClient {
  responses: { create(params: object, options?: { signal?: AbortSignal }): Promise<OpenAIResponse> };
}
export interface OpenAIDialogueParams {
  model: string;
  instructions: string;
  input: { role: 'user' | 'assistant'; content: string }[];
  max_output_tokens: number;
  store: false;
  reasoning?: { effort: OpenAIEffort };
}
const MAX_REPLY_CHARS = 600;
const EFFORTS: readonly string[] = ['minimal', 'low', 'medium', 'high'];

/** Pure: the exact request body. */
export function buildOpenAIDialogueParams(input: DialogueInput, model: string, maxTokens: number, persona?: Persona, effort?: OpenAIEffort): OpenAIDialogueParams {
  if (!isOpenAIModelId(model)) throw new RangeError('model must be an exact OpenAI model id such as gpt-5-mini');
  if (!Number.isInteger(maxTokens) || maxTokens < 16 || maxTokens > 400) throw new RangeError('maxTokens must be an integer from 16 to 400');
  if (persona !== undefined && !isPersona(persona)) throw new RangeError('persona must be made by createPersona');
  if (effort !== undefined && !EFFORTS.includes(effort)) throw new RangeError('effort must be minimal, low, medium, or high');
  const style = persona === undefined ? '' : `${dialogueStyle(persona)}\n`;
  return {
    model, instructions: `${DIALOGUE_INSTRUCTION}\n${style}${renderDirective(input.directive)}`, input: toMessages(input.turns),
    max_output_tokens: maxTokens, store: false, ...(effort === undefined ? {} : { reasoning: { effort } }),
  };
}

export function createOpenAIDialogueModel(client: OpenAITextClient, options: { model: string; maxTokens?: number; persona?: Persona; effort?: OpenAIEffort }): DialogueModel {
  if (typeof client?.responses?.create !== 'function') throw new RangeError('client must have responses.create');
  const maxTokens = options.maxTokens ?? 160;
  buildOpenAIDialogueParams({ turns: [], directive: { kind: 'open' } }, options.model, maxTokens, options.persona, options.effort);   // validates the options now, not mid-call
  const stats: DialogueStats = { calls: 0, errors: [] };
  const recordError = (e: unknown): void => {
    const o = (typeof e === 'object' && e !== null ? e : {}) as { constructor?: { name?: string }; status?: unknown };
    stats.errors.push({ name: typeof o.constructor?.name === 'string' ? o.constructor.name.slice(0, 40) : 'Error', status: typeof o.status === 'number' ? o.status : null });
    if (stats.errors.length > 50) stats.errors.shift();
  };
  return {
    stats,
    async *reply(input: DialogueInput): AsyncIterable<string> {
      const params = buildOpenAIDialogueParams(input, options.model, maxTokens, options.persona, options.effort);
      stats.calls++;
      let response: OpenAIResponse;
      try {
        response = await client.responses.create(params, input.signal === undefined ? undefined : { signal: input.signal });
      } catch (e) {
        recordError(e);
        throw new Error('dialogue model failed');
      }
      const end = response && typeof response === 'object' ? endWord(response) : 'none';
      const blocks = response && Array.isArray(response.output) ? response.output.filter((b) => b && b.type !== 'message').length : 0;
      const tokens = response?.usage?.output_tokens;
      stats.last = {
        stop: end === 'completed' ? 'END_TURN' : end === 'refusal' ? 'REFUSAL' : end === 'incomplete_max_output_tokens' ? 'MAX_TOKENS' : 'OTHER',
        output_tokens: typeof tokens === 'number' && Number.isFinite(tokens) ? Math.max(0, Math.trunc(tokens)) : null,
        other_blocks: blocks,
      };
      if (end !== 'completed' && end !== 'incomplete_max_output_tokens') return;   // a refusal, a filtered or failed answer says nothing; the call logic handles silence and refusal
      const text = textOf(response).slice(0, MAX_REPLY_CHARS);
      if (text.trim().length > 0) yield text;
    },
  };
}
