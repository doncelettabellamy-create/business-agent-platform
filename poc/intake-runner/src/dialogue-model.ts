// The spoken side of Agent 1 for the founder phone test: a streaming Claude reply. It only TALKS. It never writes the record: the record
// comes from the existing Intake agent (classify, extract, ground, validate) run over the masked caller lines.
//
// What the model is sent: a fixed instruction, the MASKED conversation so far (caller lines and the assistant's own earlier words), and
// ONE directive chosen by code (next-field.ts): a field name or category names from the configuration, never customer data. No tenant id, no phone number, no raw speech.
//
// Like claude-provider.ts this file imports no SDK, reads no environment and holds no credential: it is handed an already-built client
// (the official SDK's `client.messages.create(..., { stream: true })` shape) by the composition root (founder-call-entry.ts).
// Errors are recorded as a class name and HTTP status only. No provider message is ever kept or returned.

import type { DialogueTurn } from './call-session.ts';
import { dialogueStyle, isPersona } from './persona.ts';
import type { Persona } from './persona.ts';

export interface DialogueParams {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  stream: true;
  output_config: { effort: 'low' };
}
export interface StreamEvent { type: string; delta?: { type?: string; text?: string; stop_reason?: string }; content_block?: { type?: string }; usage?: { output_tokens?: number } }
export interface DialogueClient {
  messages: { create(params: DialogueParams, options?: { signal?: AbortSignal }): Promise<AsyncIterable<StreamEvent>> };
}
/**
 * What the assistant is told to do next. Chosen by code from a fresh Intake result (next-field.ts); the model never sees the list of missing
 * fields and never chooses the field. Field and category names come from the skill configuration.
 */
/** Which part of a service address is still needed after the other was heard: a fixed word, never part of the address itself. */
export type AddressPart = 'street name' | 'house number';
export type Directive =
  | { kind: 'open' }
  | { kind: 'ask'; field: string; again?: boolean; choices?: readonly string[]; part?: AddressPart; phone?: number | 'restate' }
  | { kind: 'clarify'; categories?: readonly string[] }
  | { kind: 'listen' };
/** Which items the server already holds and which it still needs, as field names only (never a value). Given to the voice so it does not ask for what the caller has already said. */
export interface CallStatus { captured: readonly string[]; missing: readonly string[] }
export interface DialogueInput {
  turns: readonly DialogueTurn[];
  directive: Directive;
  status?: CallStatus;
  signal?: AbortSignal;
}
/** How the newest model call ended, as a fixed word and numbers only: never any text the model produced. */
export interface DialogueLast { stop: string; output_tokens: number | null; other_blocks: number }
export interface DialogueStats { calls: number; errors: { name: string; status: number | null }[]; last?: DialogueLast }
export interface DialogueModel {
  reply(input: DialogueInput): AsyncIterable<string>;
  readonly stats: DialogueStats;
}

export const DIALOGUE_INSTRUCTION = [
  'You are the phone intake assistant for a service business. You are an AI, and the caller has already been told so.',
  'Speak in short, natural, friendly sentences: at most two per reply, and ask for only one thing at a time.',
  'The last line of this message starts with NEXT. Do exactly what it says and nothing else.',
  'NEXT OPEN: greet the caller briefly and ask how you can help.',
  'NEXT ASK <item>: ask one short, plain question about that item only. If it says it was asked before, ask it a different way, briefly. Never ask about any other item. Ask the open question and accept the caller\'s own words: never suggest options, examples, extras, services, specials or prices of your own, except the CHOICES a NEXT line lists: when it lists CHOICES, offer exactly those, in that order, as the business\'s options, and still accept any other answer in the caller\'s own words.',
  'NEXT CLARIFY with names: ask in plain words whether the caller is calling about one of those, offering only those names. NEXT CLARIFY with no names: ask the caller to say in a few words what they need.',
  'NEXT LISTEN: acknowledge briefly and invite the caller to go on. Do not ask for any specific item.',
  'A STATUS line may list the items already captured and the items still missing, by name only. Never ask about a captured item, and never ask about a missing item unless the NEXT line says to.',
  "Accept whatever words the caller uses. Never repeat the caller's answers, never read back personal details, and never say anything that appears in square brackets.",
  'Never say goodbye, never thank the caller for calling, and never say the request is recorded: only the system ends the call.',
  'Do not give prices, advice, diagnoses, availability or promises, and never say that anyone will call or follow up. Do not make up facts about the business.',
  'If the caller describes immediate danger, tell them to hang up and call the local emergency number.',
  'Plain spoken text only: no lists, no markdown, no emojis.',
].join(' ');

const STOP_REASONS: ReadonlySet<string> = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal']);
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

const NAME = /^[^\r\n[\]<>]{1,80}$/;
/** Pure: the NEXT line. Names come from configuration but are checked anyway: one line, short, no brackets or angle brackets. */
export function renderDirective(d: Directive): string {
  const name = (s: unknown): string => { if (typeof s !== 'string' || !NAME.test(s)) throw new RangeError('a field or category name is not acceptable'); return s; };
  switch (d?.kind) {
    case 'open': return 'NEXT OPEN';
    case 'ask': {
      const again = d.again === true ? ' (asked before: ask it a different way)' : '';
      const choices = d.choices === undefined || d.choices.length === 0 ? '' : ` CHOICES: ${d.choices.slice(0, 10).map(name).join('; ')}`;
      const part = d.part === 'street name' || d.part === 'house number' ? ` (the ${d.part === 'street name' ? 'house number' : 'street name'} is already heard: ask only for the ${d.part})` : '';
      const phone = typeof d.phone === 'number' && Number.isInteger(d.phone) && d.phone >= 1 && d.phone <= 9 ? ` (part of the number is already heard: ask only for the remaining ${d.phone} digits)` : d.phone === 'restate' ? ' (the pieces heard did not fit together: ask for the whole number again, from the start, digit by digit)' : '';
      return `NEXT ASK ${name(d.field)}${again}${part}${phone}${choices}`;
    }
    case 'clarify': return d.categories === undefined || d.categories.length === 0 ? 'NEXT CLARIFY' : `NEXT CLARIFY: ${d.categories.slice(0, 10).map(name).join('; ')}`;
    case 'listen': return 'NEXT LISTEN';
    default: throw new RangeError('unknown directive');
  }
}

const STATUS_NAME = /^[^\r\n[\]<>]{1,80}$/;
/** Pure: the STATUS line (field names only), or an empty string when there is nothing to say. It comes BEFORE the NEXT line, which stays last. */
export function renderStatus(s: CallStatus | undefined): string {
  if (s === undefined || s === null) return '';
  const names = (a: readonly string[]): string => (Array.isArray(a) ? a : []).slice(0, 20).filter((n) => typeof n === 'string' && STATUS_NAME.test(n)).join('; ');
  const captured = names(s.captured); const missing = names(s.missing);
  if (captured === '' && missing === '') return '';
  return `STATUS captured: ${captured === '' ? 'none' : captured}. still missing: ${missing === '' ? 'none' : missing}.\n`;
}

/** "a, b, or c" (two: "a or b"). */
export function orList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;
}
/**
 * Pure: safe fixed wording for a turn on which the model produced no words, so the caller is never left in silence. It says only what the directive
 * already allows (the configured field, the configured choices or category names), uses no word of the caller's and no bracket, and never offers anything of its own.
 */
export function fallbackText(d: Directive): string {
  const good = (s: unknown): s is string => typeof s === 'string' && NAME.test(s) && s.trim().length > 0;
  switch (d?.kind) {
    case 'open': return 'Thanks for calling. How can I help you today?';
    case 'ask': {
      const choices = (d.choices ?? []).slice(0, 10).filter(good).map((c) => c.trim());
      const offer = choices.length > 0 ? ` You can say ${orList(choices)}, or tell me in your own words.` : '';
      if (d.part === 'street name' || d.part === 'house number') return `Sorry about the pause. What is the ${d.part}?`;
      if (typeof d.phone === 'number' && Number.isInteger(d.phone) && d.phone >= 1 && d.phone <= 9) return `Sorry about the pause. What are the remaining ${d.phone} digits?`;
      if (d.phone === 'restate') return 'Sorry about the pause. Could you say the whole number again, from the start?';
      return good(d.field) ? `Sorry about the pause. Can you tell me about ${d.field.trim().toLowerCase()}?${offer}` : 'Sorry about the pause. Could you say that again?';
    }
    case 'clarify': {
      const names = (d.categories ?? []).slice(0, 10).filter(good).map((c) => c.trim());
      return names.length > 0 ? `Sorry about the pause. Are you calling about ${orList(names)}?` : 'Sorry about the pause. Could you say in a few words what you need?';
    }
    default: return 'Sorry about the pause. Please go on, I am listening.';
  }
}

/** Pure: the exact request body. Used by the model adapter and by the dry run's cost ceiling. */
export function buildDialogueParams(input: DialogueInput, model: string, maxTokens: number, persona?: Persona): DialogueParams {
  if (typeof model !== 'string' || !MODEL_ID.test(model)) throw new RangeError('model must be an exact Claude model id such as claude-haiku-5-5');
  if (!Number.isInteger(maxTokens) || maxTokens < 16 || maxTokens > 400) throw new RangeError('maxTokens must be an integer from 16 to 400');
  // A persona (persona.ts) adds one line of manner AFTER every rule above and BEFORE the NEXT line, which stays the last line. Only a persona made there is accepted, never text.
  if (persona !== undefined && !isPersona(persona)) throw new RangeError('persona must be made by createPersona');
  const style = persona === undefined ? '' : `${dialogueStyle(persona)}\n`;
  return {
    model, max_tokens: maxTokens, system: `${DIALOGUE_INSTRUCTION}\n${style}${renderStatus(input.status)}${renderDirective(input.directive)}`,
    messages: toMessages(input.turns), stream: true, output_config: { effort: 'low' },
  };
}

export function createClaudeDialogueModel(client: DialogueClient, options: { model: string; maxTokens?: number; persona?: Persona }): DialogueModel {
  if (typeof client?.messages?.create !== 'function') throw new RangeError('client must have messages.create');
  const maxTokens = options.maxTokens ?? 160;
  buildDialogueParams({ turns: [], directive: { kind: 'open' } }, options.model, maxTokens, options.persona);   // validates the options now, not mid-call
  const stats: DialogueStats = { calls: 0, errors: [] };
  const recordError = (e: unknown): void => {
    const o = (typeof e === 'object' && e !== null ? e : {}) as { constructor?: { name?: string }; status?: unknown };
    stats.errors.push({ name: typeof o.constructor?.name === 'string' ? o.constructor.name.slice(0, 40) : 'Error', status: typeof o.status === 'number' ? o.status : null });
    if (stats.errors.length > 50) stats.errors.shift();
  };
  return {
    stats,
    async *reply(input: DialogueInput): AsyncIterable<string> {
      const params = buildDialogueParams(input, options.model, maxTokens, options.persona);
      stats.calls++;
      const last: DialogueLast = { stop: 'NONE', output_tokens: null, other_blocks: 0 };
      stats.last = last;
      let sent = 0;
      try {
        const stream = await client.messages.create(params, input.signal === undefined ? undefined : { signal: input.signal });
        for await (const ev of stream) {
          // Diagnostics only: why the stream ended, how many tokens it used, and whether it opened any block that is not plain text (for example a thinking block).
          if (ev && ev.type === 'content_block_start' && ev.content_block && ev.content_block.type !== 'text') last.other_blocks++;
          if (ev && ev.type === 'message_delta') {
            if (typeof ev.delta?.stop_reason === 'string') last.stop = STOP_REASONS.has(ev.delta.stop_reason) ? ev.delta.stop_reason.toUpperCase() : 'OTHER';
            if (typeof ev.usage?.output_tokens === 'number' && Number.isFinite(ev.usage.output_tokens)) last.output_tokens = Math.max(0, Math.trunc(ev.usage.output_tokens));
          }
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
