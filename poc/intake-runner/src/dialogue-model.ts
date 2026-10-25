// The spoken side of Agent 1 for the founder phone test: a streaming Claude reply. It only TALKS. It never writes the record: the record
// comes from the existing Intake agent (classify, extract, ground, validate) run over the masked caller lines.
//
// What the model is sent: a fixed instruction, the MASKED conversation so far (caller lines and the assistant's own earlier words), and
// the names of the fields Intake still lacks (configuration, not customer data). No tenant id, no phone number, no raw speech.
//
// Like claude-provider.ts this file imports no SDK, reads no environment and holds no credential: it is handed an already-built client
// (the official SDK's `client.messages.create(..., { stream: true })` shape) by the composition root (founder-call-entry.ts).
// Errors are recorded as a class name and HTTP status only. No provider message is ever kept or returned.

import type { DialogueTurn } from './call-session.ts';

export interface DialogueParams {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  stream: true;
  output_config: { effort: 'low' };
}
export interface StreamEvent { type: string; delta?: { type?: string; text?: string } }
export interface DialogueClient {
  messages: { create(params: DialogueParams, options?: { signal?: AbortSignal }): Promise<AsyncIterable<StreamEvent>> };
}
export interface DialogueInput {
  turns: readonly DialogueTurn[];
  /** Field names Intake still lacks. Empty means: wrap up. */
  missing: readonly string[];
  signal?: AbortSignal;
}
export interface DialogueStats { calls: number; errors: { name: string; status: number | null }[] }
export interface DialogueModel {
  reply(input: DialogueInput): AsyncIterable<string>;
  readonly stats: DialogueStats;
}

export const DIALOGUE_INSTRUCTION = [
  'You are the phone intake assistant for a service business. You are an AI, and the caller has already been told so.',
  'Speak in short, natural, friendly sentences: at most two per reply, and ask for only one thing at a time.',
  'Your job is to understand what the caller needs and to collect the items listed after MISSING.',
  'Never read back or repeat personal details, and never say anything that appears in square brackets.',
  'Do not give prices, advice, diagnoses or promises. Do not make up facts about the business.',
  'If the caller describes immediate danger, tell them to hang up and call the local emergency number.',
  'If MISSING is empty, thank the caller, say the request has been recorded and a person will follow up, and say goodbye.',
  'Plain spoken text only: no lists, no markdown, no emojis.',
].join(' ');

const MODEL_ID = /^claude-[a-z0-9]+(-[a-z0-9]+)*$/;
export const OPENING_PROMPT = 'The caller has agreed to continue. Greet them briefly and ask how you can help.';
const MAX_REPLY_CHARS = 600;

/** Alternating roles starting with a user message, as the API requires. Pure. */
export function toMessages(turns: readonly DialogueTurn[]): { role: 'user' | 'assistant'; content: string }[] {
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last !== undefined && last.role === t.role) last.content += ` ${t.text}`;
    else out.push({ role: t.role, content: t.text });
  }
  if (out.length === 0 || out[0].role !== 'user') out.unshift({ role: 'user', content: OPENING_PROMPT });
  if (out[out.length - 1].role !== 'user') out.push({ role: 'user', content: '(The caller is waiting.)' });
  return out;
}

/** Pure: the exact request body. Used by the model adapter and by the dry run's cost ceiling. */
export function buildDialogueParams(input: DialogueInput, model: string, maxTokens: number): DialogueParams {
  if (typeof model !== 'string' || !MODEL_ID.test(model)) throw new RangeError('model must be an exact Claude model id such as claude-haiku-5-5');
  if (!Number.isInteger(maxTokens) || maxTokens < 16 || maxTokens > 400) throw new RangeError('maxTokens must be an integer from 16 to 400');
  const missing = input.missing.length === 0 ? 'none' : input.missing.join('; ');
  return {
    model, max_tokens: maxTokens, system: `${DIALOGUE_INSTRUCTION}\nMISSING: ${missing}`,
    messages: toMessages(input.turns), stream: true, output_config: { effort: 'low' },
  };
}

export function createClaudeDialogueModel(client: DialogueClient, options: { model: string; maxTokens?: number }): DialogueModel {
  if (typeof client?.messages?.create !== 'function') throw new RangeError('client must have messages.create');
  const maxTokens = options.maxTokens ?? 160;
  buildDialogueParams({ turns: [], missing: [] }, options.model, maxTokens);   // validates the options now, not mid-call
  const stats: DialogueStats = { calls: 0, errors: [] };
  const recordError = (e: unknown): void => {
    const o = (typeof e === 'object' && e !== null ? e : {}) as { constructor?: { name?: string }; status?: unknown };
    stats.errors.push({ name: typeof o.constructor?.name === 'string' ? o.constructor.name.slice(0, 40) : 'Error', status: typeof o.status === 'number' ? o.status : null });
    if (stats.errors.length > 50) stats.errors.shift();
  };
  return {
    stats,
    async *reply(input: DialogueInput): AsyncIterable<string> {
      const params = buildDialogueParams(input, options.model, maxTokens);
      stats.calls++;
      let sent = 0;
      try {
        const stream = await client.messages.create(params, input.signal === undefined ? undefined : { signal: input.signal });
        for await (const ev of stream) {
          if (ev && ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string') {
            const piece = ev.delta.text.slice(0, MAX_REPLY_CHARS - sent);
            if (piece.length === 0) break;
            sent += piece.length;
            yield piece;
          }
        }
      } catch (e) {
        recordError(e);
        throw new Error('dialogue model failed');
      }
    },
  };
}
