// The founder VOICE service (OpenAI speech-to-speech): the one place that joins the pieces built offline over the last steps into a service that takes a Twilio Media Streams connection and runs the EXISTING cleaning
// phone workflow on it:
//
//   Twilio stream (RelayConnection) -> realtime-bridge.ts -> openai-voice-socket.ts (the voice service)         the audio
//                                          |-> realtime-transport.ts + the Drew persona                          what is said, word for word
//                                                 |-> relay-handler.ts (consent, masking, next-question rules, exact read-backs, records, limits)
//                                                        |-> the Intake agent (createIntakeEntry) on OpenAI's text model, and the spoken wording from OpenAI's text model
//
// Nothing in the call logic, the masker, the consent notice, the records or the dashboard is changed or bypassed: the handler is built here exactly as founder-call-entry.ts builds it for the Claude route, with the
// OpenAI text model in place of the Claude one and the voice transport in place of ConversationRelay. Everything that touches the outside world is HANDED IN (the text client, the voice socket maker, the store, the clock,
// the context minter), so this file reads no environment variable, holds no credential, opens no connection, and is tested with mocks. Only founder-voice-entry.ts supplies the real ones, after the whole gate passes.

import { createIntakeEntry } from './intake-entry.ts';
import { createTenantRegistry } from './tenant-boundary.ts';
import { createOpenAIProvider } from './openai-provider.ts';
import { createOpenAIDialogueModel } from './openai-dialogue-model.ts';
import type { OpenAITextClient } from './openai-dialogue-model.ts';
import { createRelayHandler } from './relay-handler.ts';
import type { RelayHandler } from './relay-handler.ts';
import { consentNoticeFor } from './opening.ts';
import { requiredFieldsOf } from './cleaning-state.ts';
import { scriptedQuestion, scriptedClarify } from './scripted-questions.ts';
import { createPersona } from './persona.ts';
import { startRealtimeCall } from './realtime-bridge.ts';
import { CONTACT_TOOL_DEFINITIONS } from './call-state.ts';
import type { VoiceSocket } from './realtime-bridge.ts';
import type { FounderCallConfig } from './founder-call-gate.ts';
import { effectiveVoiceSettings } from './founder-voice-gate.ts';
import type { FounderVoiceConfig } from './founder-voice-gate.ts';
import type { RelayConnection } from './ws-server.ts';
import { noDiag, scopedDiag } from './call-diag.ts';
import type { DiagSink } from './call-diag.ts';
import type { IntakeRecordStore } from './intake-record-store.ts';
import type { ContactVault } from './contact-vault.ts';

export interface VoiceServiceDeps {
  config: FounderCallConfig;
  voice: FounderVoiceConfig;
  /** The OpenAI text client (already limited to the approved number of calls by the caller). */
  textClient: OpenAITextClient;
  /** Opens the connection to the voice service for ONE call. Called once per stream, with that call's diagnostics (the voice socket reports its connection codes through it). */
  openVoice(diag: (code: never, detail?: Record<string, number | string | boolean>) => void): VoiceSocket;
  store: IntakeRecordStore;
  contacts?: ContactVault;
  /** Mints the Intake context for a call (the composition root mints it; this file never does). */
  intakeContext(tenant: string, callRef: string): Promise<unknown>;
  now(): number;
  nowIso(): string;
  killed(): boolean;
  /** Fixed codes and counts only. */
  log(code: string, detail?: Record<string, string | number>): void;
  /** Durable fixed-code diagnostics for every call (call-diag.ts): the entry writes them to a git-ignored file. Default: none. */
  diag?: DiagSink;
}
export interface VoiceService {
  handler: RelayHandler;
  /** Runs one call over a Twilio Media Streams connection. */
  handleStream(conn: RelayConnection): void;
  /** The consent notice that is spoken first on every call, word for word. */
  notice: string;
}

/**
 * Residential-only routing from the skill: every category routed to a person (commercial cleaning) is declined, never offered, and a request that lands in one is asked the fixed question first.
 * Undefined when the skill has no such category. The question is the founder's exact wording; the decline line promises nothing.
 */
export function residentialRouting(categories: readonly { name: string; route?: string; keywords?: readonly string[] }[], businessName: string): { declined: string[]; keywords: string[]; question: string; declineLine: string } | undefined {
  const declined = categories.filter((c) => c.route === 'human');
  if (declined.length === 0) return undefined;
  return {
    declined: declined.map((c) => c.name),
    keywords: declined.flatMap((c) => [...(c.keywords ?? [])]),
    question: 'Is this cleaning for a home?',
    declineLine: `Thank you. ${businessName} only cleans residential properties, so I can't help with this request. Goodbye.`,
  };
}

/** The quiet that ends a fragment of a number or an address (milliseconds), and the longest one such wait may last: speech cannot hold the call open longer than this. */
export const VOICE_CONTACT_SETTLE_MS = 1500;
export const VOICE_CONTACT_COLLECT_MAX_MS = 8000;
/** Questions spoken in exactly these words (founder-approved 2026-10-28). They offer no weekday, no availability and no confirmation. */
export const FIXED_QUESTIONS: Readonly<Record<string, string>> = Object.freeze({ 'Preferred date': 'What date works best for you?', 'Time window': 'What time of day works best?' });
/** The first-cleaning question, in the exact approved words (2026-10-28). Yes means first cleaning; no means returning customer. */
export const firstCleanQuestion = (business: string): string => `Is this your first cleaning with ${business}?`;

export function createFounderVoiceService(deps: VoiceServiceDeps): VoiceService {
  const { config, voice } = deps;
  const tenant = config.tenant;
  const skill = config.skill_config as { categories: { name: string; requires?: string[]; route?: string; keywords?: string[] }[]; fields: { name: string; choices?: string[]; role?: string; required?: boolean }[] };
  const firstCleanField = skill.fields.find((f) => f.role === 'first_clean')?.name;
  const persona = createPersona(voice.persona);
  const settings = effectiveVoiceSettings(voice);
  const notice = consentNoticeFor(config.opening);
  const intake = createIntakeEntry({
    registry: createTenantRegistry({ [tenant]: config.skill_config as never }), provider: createOpenAIProvider(deps.textClient, { model: voice.openai_model, effort: settings.textReasoning }),
    limits: { maxOutputTokens: 1024, timeoutMs: 30_000, maxAttempts: 1 }, channelRef: 'channel-founder-phone', now: deps.nowIso, founderTest: { tenant },
  });
  const dialogue = createOpenAIDialogueModel(deps.textClient, { model: voice.openai_model, persona, effort: settings.textReasoning });
  // RESIDENTIAL-ONLY (Drew Cleaning): a category the skill routes to a person (commercial cleaning) is not a service Drew offers. It is never named to a caller; a request that lands in it is asked the fixed
  // residential question and, unless the caller confirms a residential property, is declined (relay-handler.ts `residential`).
  const residential = residentialRouting(skill.categories, voice.persona.business_name);
  const setupTimeoutMs = Math.min(300_000, Math.max(5000, Math.ceil(notice.length * 70) + 30_000));
  const handler = createRelayHandler({
    numbers: new Map(config.numbers.map((n) => [n, tenant])),
    categoryNames: () => skill.categories.filter((c) => c.route !== 'human').map((c) => c.name),
    ...(residential === undefined ? {} : { residential }),
    choicesFor: (_t, field) => skill.fields.find((f) => f.name === field)?.choices,
    ...(firstCleanField === undefined ? {} : { firstClean: { field: firstCleanField, required: (_t: string, category: string) => skill.categories.find((c) => c.name === category)?.requires?.includes(firstCleanField) === true, question: firstCleanQuestion(voice.persona.business_name) } }),
    requiredFields: (_t: string, category: string) => requiredFieldsOf(skill, category),
    // Contact collection: wait for the caller to finish a number or an address (1.5 s of quiet, at most 8 s per wait) instead of answering each fragment and talking over them.
    contactSettleMs: VOICE_CONTACT_SETTLE_MS, contactCollectMaxMs: VOICE_CONTACT_COLLECT_MAX_MS,
    // Fixed questions (founder-approved, 2026-10-28): the date and the time of day are asked in exactly these words, never worded by the model, and only for skills that have those fields.
    fixedQuestions: Object.fromEntries(Object.entries(FIXED_QUESTIONS).filter(([field]) => skill.fields.some((f) => f.name === field))),
    // Scripted question table (founder-approved 2026-10-29): every other question for a required item, and the category question, is a fixed sentence chosen by the selected field (scripted-questions.ts), never the text model's wording. Native conversation (opt-in, inactive) keeps its own voice.
    scripted: { ask: scriptedQuestion, clarify: scriptedClarify },
    // The service address needs a city and a five-digit ZIP code too (founder-approved 2026-10-30): only the missing parts are asked for, and the whole address is read back for confirmation.
    addressCityZip: true,
    intake,
    intakeContext: deps.intakeContext,
    dialogue, store: deps.store, limits: { maxTurns: config.max_turns, maxMinutes: config.max_minutes, maxChars: 4000 }, names: config.persona_names, maxCalls: config.max_calls,
    now: deps.now, nowIso: deps.nowIso, killed: deps.killed, afterSpeechMs: config.after_speech_ms,
    // The voice transport itself waits for a reply to finish playing before it hangs up, so no extra time per line is added here.
    speechMs: () => 0, confirmWaitMs: 20_000, previewBudgetMs: 8000,
    // The notice is spoken BEFORE the carrier reports `setup`, so the call logic must wait for it to be heard, not for 5 seconds (that wait hung up on the first founder call, after "Hello"). The bridge has its own, tighter
    // protections for a notice that does not play (the voice must open within its wait, and the audio must be confirmed played within its length plus a grace).
    setupTimeoutMs, ...(deps.contacts === undefined ? {} : { contacts: deps.contacts }),
    log: deps.log,
  });
  const sink = deps.diag ?? noDiag;
  let calls = 0;
  return {
    handler, notice,
    handleStream(conn: RelayConnection): void {
      const d = scopedDiag(sink, ++calls);
      d('CALL_STREAM_ACCEPTED', { noticeChars: notice.length, setupWaitMs: setupTimeoutMs });
      startRealtimeCall(conn, deps.openVoice(d as never), (t) => handler.serve(t), {
        notice, transcriptionModel: voice.transcription_model, voice: voice.voice, persona, reasoningEffort: settings.realtimeReasoning, diag: d,
        ...(settings.transcription === undefined ? {} : { transcription: settings.transcription }),
        // Native conversation (voice config `conversation: "native"`): the voice converses in its own words and may call the server's contact tools, and only those.
        ...(settings.conversation === 'native' ? { native: { tools: CONTACT_TOOL_DEFINITIONS.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters as Record<string, unknown> })) } } : {}),
      }, { maxCallMs: config.max_minutes * 60_000 + 30_000, diag: d });
    },
  };
}
