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
import { createPersona } from './persona.ts';
import { startRealtimeCall } from './realtime-bridge.ts';
import type { VoiceSocket } from './realtime-bridge.ts';
import type { FounderCallConfig } from './founder-call-gate.ts';
import { effectiveVoiceSettings } from './founder-voice-gate.ts';
import type { FounderVoiceConfig } from './founder-voice-gate.ts';
import type { RelayConnection } from './ws-server.ts';
import type { IntakeRecordStore } from './intake-record-store.ts';
import type { ContactVault } from './contact-vault.ts';

export interface VoiceServiceDeps {
  config: FounderCallConfig;
  voice: FounderVoiceConfig;
  /** The OpenAI text client (already limited to the approved number of calls by the caller). */
  textClient: OpenAITextClient;
  /** Opens the connection to the voice service for ONE call. Called once per stream. */
  openVoice(): VoiceSocket;
  store: IntakeRecordStore;
  contacts?: ContactVault;
  /** Mints the Intake context for a call (the composition root mints it; this file never does). */
  intakeContext(tenant: string, callRef: string): Promise<unknown>;
  now(): number;
  nowIso(): string;
  killed(): boolean;
  /** Fixed codes and counts only. */
  log(code: string, detail?: Record<string, string | number>): void;
}
export interface VoiceService {
  handler: RelayHandler;
  /** Runs one call over a Twilio Media Streams connection. */
  handleStream(conn: RelayConnection): void;
  /** The consent notice that is spoken first on every call, word for word. */
  notice: string;
}

export function createFounderVoiceService(deps: VoiceServiceDeps): VoiceService {
  const { config, voice } = deps;
  const tenant = config.tenant;
  const skill = config.skill_config as { categories: { name: string; requires?: string[] }[]; fields: { name: string; choices?: string[]; role?: string }[] };
  const firstCleanField = skill.fields.find((f) => f.role === 'first_clean')?.name;
  const persona = createPersona(voice.persona);
  const settings = effectiveVoiceSettings(voice);
  const notice = consentNoticeFor(config.opening);
  const intake = createIntakeEntry({
    registry: createTenantRegistry({ [tenant]: config.skill_config as never }), provider: createOpenAIProvider(deps.textClient, { model: voice.openai_model, effort: settings.textReasoning }),
    limits: { maxOutputTokens: 1024, timeoutMs: 30_000, maxAttempts: 1 }, channelRef: 'channel-founder-phone', now: deps.nowIso, founderTest: { tenant },
  });
  const dialogue = createOpenAIDialogueModel(deps.textClient, { model: voice.openai_model, persona, effort: settings.textReasoning });
  const handler = createRelayHandler({
    numbers: new Map(config.numbers.map((n) => [n, tenant])),
    categoryNames: () => skill.categories.map((c) => c.name),
    choicesFor: (_t, field) => skill.fields.find((f) => f.name === field)?.choices,
    ...(firstCleanField === undefined ? {} : { firstClean: { field: firstCleanField, required: (_t: string, category: string) => skill.categories.find((c) => c.name === category)?.requires?.includes(firstCleanField) === true } }),
    intake,
    intakeContext: deps.intakeContext,
    dialogue, store: deps.store, limits: { maxTurns: config.max_turns, maxMinutes: config.max_minutes, maxChars: 4000 }, names: config.persona_names, maxCalls: config.max_calls,
    now: deps.now, nowIso: deps.nowIso, killed: deps.killed, afterSpeechMs: config.after_speech_ms,
    // The voice transport itself waits for a reply to finish playing before it hangs up, so no extra time per line is added here.
    speechMs: () => 0, confirmWaitMs: 20_000, previewBudgetMs: 8000, ...(deps.contacts === undefined ? {} : { contacts: deps.contacts }),
    log: deps.log,
  });
  return {
    handler, notice,
    handleStream(conn: RelayConnection): void {
      startRealtimeCall(conn, deps.openVoice(), (t) => handler.serve(t), {
        notice, transcriptionModel: voice.transcription_model, voice: voice.voice, persona, reasoningEffort: settings.realtimeReasoning,
        ...(settings.transcription === undefined ? {} : { transcription: settings.transcription }),
      }, { maxCallMs: config.max_minutes * 60_000 + 30_000 });
    },
  };
}
