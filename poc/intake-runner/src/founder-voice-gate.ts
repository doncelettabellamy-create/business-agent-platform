// The safety gate for the founder VOICE test (OpenAI speech-to-speech over a Twilio Media Streams stream). PURE: no I/O, no environment access, no network. founder-voice-entry.ts reads the files and the
// environment and passes in what it read.
//
// The voice test keeps EVERY gate of the existing founder phone test (founder-call-gate.ts: the approved call config with its digest, INTAKE_ALLOW_LIVE_CALLS, the Twilio auth token, the 30-day expiry, one named
// tenant, listed numbers, small caps) and adds its own, so an edited voice config is not approved until it is approved again:
//   - the voice config passes the checks below (exact models chosen by the founder, no defaults; the Drew persona as a closed configuration; a bound on the text-model calls);
//   - FOUNDER_VOICE_APPROVED_DIGEST equals the digest of {the call config's digest, the voice config}: changing EITHER file changes it;
//   - an OpenAI key is present (presence only; the key itself is never read here).
// What the bounds are: at most `max_calls` calls of at most `max_minutes` each (from the call config) and at most `max_openai_calls` text-model calls for the whole run. A dollar ceiling is NOT computed: OpenAI prices
// for these models are not on file and the voice cost per minute is unverified, so the dry run says so instead of guessing.
// The call config's own `model` field must still be a Claude id (the existing validator); in voice mode it is ignored.

import { isRecord } from './contracts.ts';
import { founderConfigDigest, founderConfigProblems, founderGateProblems } from './founder-call-gate.ts';
import type { FounderCallConfig } from './founder-call-gate.ts';
import { isOpenAIModelId, OPENAI_EFFORTS } from './openai-provider.ts';
import type { OpenAIEffort } from './openai-provider.ts';
import { DEFAULT_REALTIME_EFFORT, HINT_TRANSCRIBERS, isRealtimeEffort, transcriptionHintProblems } from './realtime-settings.ts';
import type { RealtimeEffort, RealtimeTranscription } from './realtime-settings.ts';
import { personaProblems } from './persona.ts';
import type { PersonaConfig } from './persona.ts';
import { fixtureDigest } from './reviewed-fixtures.ts';

export interface FounderVoiceConfig {
  approval_id: string;
  /** The OpenAI text model for the spoken wording and the Intake extraction (for example a gpt-5 family id). Chosen by the founder; no default. */
  openai_model: string;
  /** The Realtime voice model id. Chosen by the founder; no default. */
  realtime_model: string;
  /** The caller-speech transcription model id. Chosen by the founder; no default. */
  transcription_model: string;
  voice: string;
  /** How many OpenAI text-model calls the whole run may make; after that every further call fails and the item goes to a person. */
  max_openai_calls: number;
  /** The receptionist persona (persona.ts): a closed configuration, never free text. */
  persona: PersonaConfig;
  /** Optional stable, privacy-preserving identifier sent as OpenAI-Safety-Identifier. Never a phone number or a name. */
  safety_identifier?: string;
  /** Optional. How hard the voice model reasons: minimal, low, medium, high or xhigh. Default minimal (it only speaks words it is handed). */
  realtime_reasoning?: RealtimeEffort;
  /** Optional. The text model's reasoning effort (none, minimal, low, medium, high, xhigh, max). Default none, which gpt-6-luna documents; not every model accepts every value. */
  text_reasoning?: OpenAIEffort;
  /** Optional. Hints for the live transcriber: languages (two-letter codes) and keywords. Only for gpt-transcribe and gpt-live-transcribe. Default: English, for those two. */
  transcription?: RealtimeTranscription;
}
const KEYS = 'approval_id,max_openai_calls,openai_model,persona,realtime_model,transcription_model,voice'.split(',');
const OPTIONAL = ['safety_identifier', 'realtime_reasoning', 'text_reasoning', 'transcription'];
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VOICE = /^[a-z][a-z0-9_-]{0,31}$/;
const SAFETY = /^[A-Za-z0-9_.-]{1,64}$/;

/** Problems with the voice config itself. Fixed text; no value from the file is echoed. */
export function founderVoiceConfigProblems(cfg: unknown): string[] {
  if (!isRecord(cfg)) return ['the voice config must be an object'];
  const p: string[] = [];
  const given = Object.keys(cfg);
  if (!KEYS.every((k) => given.includes(k)) || !given.every((k) => KEYS.includes(k) || OPTIONAL.includes(k))) p.push('the voice config must have the expected keys and no others');
  const c = cfg as Record<string, unknown>;
  if (typeof c.approval_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(c.approval_id)) p.push('approval_id must be an id-like string');
  if (!isOpenAIModelId(c.openai_model)) p.push('openai_model must be an exact OpenAI model id');
  if (typeof c.realtime_model !== 'string' || !ID.test(c.realtime_model)) p.push('realtime_model must be an exact model id');
  if (typeof c.transcription_model !== 'string' || !ID.test(c.transcription_model)) p.push('transcription_model must be an exact model id');
  if (typeof c.voice !== 'string' || !VOICE.test(c.voice)) p.push('voice must be a plain voice name');
  if (!Number.isInteger(c.max_openai_calls) || (c.max_openai_calls as number) < 1 || (c.max_openai_calls as number) > 600) p.push('max_openai_calls must be 1 to 600');
  if ('safety_identifier' in c && (typeof c.safety_identifier !== 'string' || !SAFETY.test(c.safety_identifier))) p.push('safety_identifier must be a plain identifier');
  if (!isRecord(c.persona) || personaProblems(c.persona).length > 0) p.push('persona is not a valid persona configuration');
  if ('realtime_reasoning' in c && !isRealtimeEffort(c.realtime_reasoning)) p.push('realtime_reasoning must be minimal, low, medium, high or xhigh');
  if ('text_reasoning' in c && !(typeof c.text_reasoning === 'string' && (OPENAI_EFFORTS as readonly string[]).includes(c.text_reasoning))) p.push('text_reasoning must be none, minimal, low, medium, high, xhigh or max');
  if ('transcription' in c) {
    for (const m of transcriptionHintProblems(c.transcription)) p.push(m);
    if (typeof c.transcription_model === 'string' && !HINT_TRANSCRIBERS.includes(c.transcription_model)) p.push('transcription hints are documented only for gpt-transcribe and gpt-live-transcribe');
  }
  return p;
}

/** The settings the run will actually use, with the documented defaults filled in (the voice config must be valid). The dry run prints these, so a default is never a surprise. */
export function effectiveVoiceSettings(voice: FounderVoiceConfig): { realtimeReasoning: RealtimeEffort; textReasoning: OpenAIEffort; transcription: RealtimeTranscription | undefined } {
  return {
    realtimeReasoning: voice.realtime_reasoning ?? DEFAULT_REALTIME_EFFORT,
    textReasoning: voice.text_reasoning ?? 'none',
    transcription: voice.transcription ?? (HINT_TRANSCRIBERS.includes(voice.transcription_model) ? { languages: ['en'] } : undefined),
  };
}

/** The digest the founder approves for the voice test: it binds the voice config to the exact call config it runs with. */
export function founderVoiceDigest(callConfig: unknown, voiceConfig: unknown): string {
  return fixtureDigest({ call: founderConfigDigest(callConfig), voice: voiceConfig });
}

export interface VoiceGateInput {
  callConfig: unknown;
  voiceConfig: unknown;
  /** What the entry read from the environment: presence and equality only, never a secret's value. */
  env: { allowLive: string | undefined; callApprovedDigest: string | undefined; voiceApprovedDigest: string | undefined; twilioTokenPresent: boolean; openaiKeyPresent: boolean };
  nowIso: string;
}
/** Empty means a live voice call may start. */
export function founderVoiceGateProblems(input: VoiceGateInput): string[] {
  const p = founderGateProblems({ config: input.callConfig, env: { allowLive: input.env.allowLive, approvedDigest: input.env.callApprovedDigest, twilioTokenPresent: input.env.twilioTokenPresent }, nowIso: input.nowIso });
  const v = founderVoiceConfigProblems(input.voiceConfig);
  if (v.length > 0) return [...p, ...v];
  if (founderConfigProblems(input.callConfig).length === 0 && input.env.voiceApprovedDigest !== founderVoiceDigest(input.callConfig, input.voiceConfig)) p.push('FOUNDER_VOICE_APPROVED_DIGEST does not match this voice config and call config');
  if (!input.env.openaiKeyPresent) p.push('the OpenAI key is not set');
  return p;
}

/** What the run is bounded by, in plain numbers (the call config must be valid). */
export function voiceBounds(callConfig: FounderCallConfig, voice: FounderVoiceConfig): { calls: number; minutesPerCall: number; maxVoiceMinutes: number; maxOpenaiCalls: number } {
  return { calls: callConfig.max_calls, minutesPerCall: callConfig.max_minutes, maxVoiceMinutes: callConfig.max_calls * callConfig.max_minutes, maxOpenaiCalls: voice.max_openai_calls };
}
