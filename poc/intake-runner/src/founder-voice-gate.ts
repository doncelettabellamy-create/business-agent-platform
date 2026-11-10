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
import { speakerSettingsProblems } from './speaker-adapter.ts';
import type { SpeakerSettings } from './speaker-adapter.ts';
import { consentNoticeFor } from './opening.ts';
import { availabilityProblems } from './fast-availability.ts';
import type { AvailabilityConfig } from './fast-availability.ts';
import type { FastSettings } from './fast-call-handler.ts';

/** Who SPEAKS. The default (this section absent) is OpenAI. Present, the fixed lines are spoken by ElevenLabs (src/speaker-adapter.ts, src/elevenlabs-speech-source.ts) while OpenAI still listens. Only the approved candidate values are accepted. */
export interface SpeakerConfig { provider: 'elevenlabs'; voice_id: string; model_id: string; speed: number }

/**
 * The CONTROLLED fast test call (fast-call-handler.ts). Absent (the default): nothing changes. Present, the call is the short, deterministic test flow, and it is part of the approval digest, so adding or editing it needs a new approval.
 * It holds business facts the founder supplies (no default is invented): the Jobber test account's exact name and time zone, the open hours of the TEST and how long one cleaning takes, the one size and price that is booked, and the
 * founder's standing approval of test bookings. It holds NO number, key or token: the approved test numbers live in the private protected folder, and the gate below checks that they are there.
 */
export interface FastTestConfig {
  jobber_account_name: string; timezone: string; hours: Record<string, Array<[string, string]>>; duration_minutes: number;
  price_dollars: number; bedrooms: number; bathrooms: number; service_label: string; standing_approval: boolean;
  state?: string; lead_minutes?: number; step_minutes?: number; buffer_minutes?: number; horizon_days?: number;
  /** Optional, default false: the owner's statement that someone works the follow-up list. Only then (and only with a stored lead and number) may a failure ending say that a person will follow up. */
  follow_up_process?: boolean;
}
const FAST_KEYS = 'bathrooms,bedrooms,duration_minutes,hours,jobber_account_name,price_dollars,service_label,standing_approval,timezone'.split(',');
const FAST_OPTIONAL = ['state', 'lead_minutes', 'step_minutes', 'buffer_minutes', 'horizon_days', 'follow_up_process'];
export function fastTestProblems(x: unknown): string[] {
  if (!isRecord(x)) return ['fast_test must be an object'];
  const p: string[] = []; const k = Object.keys(x);
  if (!FAST_KEYS.every((n) => k.includes(n)) || !k.every((n) => FAST_KEYS.includes(n) || FAST_OPTIONAL.includes(n))) p.push('fast_test must have the expected keys and no others');
  if (typeof x.jobber_account_name !== 'string' || x.jobber_account_name.trim() === '' || x.jobber_account_name.length > 80 || /[\u0000-\u001f<>]/.test(x.jobber_account_name)) p.push('fast_test.jobber_account_name must be the exact Jobber test account name');
  if (!Number.isInteger(x.price_dollars) || (x.price_dollars as number) < 1 || (x.price_dollars as number) > 5000) p.push('fast_test.price_dollars must be a whole number of dollars, 1 to 5000');
  if (!Number.isInteger(x.bedrooms) || (x.bedrooms as number) < 0 || (x.bedrooms as number) > 12 || !Number.isInteger(x.bathrooms) || (x.bathrooms as number) < 1 || (x.bathrooms as number) > 12) p.push('fast_test.bedrooms and bathrooms must be whole numbers');
  if (typeof x.service_label !== 'string' || !/^[A-Za-z0-9 .,'&()-]{3,60}$/.test(x.service_label)) p.push('fast_test.service_label must be plain text');
  if (typeof x.standing_approval !== 'boolean') p.push('fast_test.standing_approval must be true or false (true is the standing approval of test bookings)');
  if ('state' in x && !(typeof x.state === 'string' && /^[A-Za-z]{2}$/.test(x.state))) p.push('fast_test.state must be two letters');
  if ('follow_up_process' in x && typeof x.follow_up_process !== 'boolean') p.push('fast_test.follow_up_process must be true or false (true is the owner\'s statement that someone works the follow-up list)');
  if (availabilityProblems({ timezone: x.timezone, hours: x.hours, durationMinutes: x.duration_minutes, stepMinutes: x.step_minutes, leadMinutes: x.lead_minutes, bufferMinutes: x.buffer_minutes, horizonDays: x.horizon_days }).length > 0) p.push('fast_test needs a valid time zone, open hours (weekday 0 to 6, "HH:MM" pairs) and a cleaning duration of 30 to 480 minutes');
  return p;
}
/** The settings the fast handler runs with, from a VALID voice config. */
export function fastSettingsOf(voice: FounderVoiceConfig, businessName: string): FastSettings | undefined {
  const f = voice.fast_test; if (f === undefined) return undefined;
  const availability: AvailabilityConfig = { timezone: f.timezone, hours: f.hours, durationMinutes: f.duration_minutes, ...(f.step_minutes === undefined ? {} : { stepMinutes: f.step_minutes }), ...(f.lead_minutes === undefined ? {} : { leadMinutes: f.lead_minutes }), ...(f.buffer_minutes === undefined ? {} : { bufferMinutes: f.buffer_minutes }), ...(f.horizon_days === undefined ? {} : { horizonDays: f.horizon_days }) };
  return { businessName, serviceLabel: f.service_label, availability, bedrooms: f.bedrooms, bathrooms: f.bathrooms, priceDollars: f.price_dollars, standingApproval: f.standing_approval, ...(f.follow_up_process === true ? { followUpProcess: true } : {}), ...(f.state === undefined ? {} : { state: f.state.toUpperCase() }) };
}

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
  /** Optional. 'scripted' (default): the voice only speaks words the server hands it. 'native': the voice converses in its own words and may call the server's validated contact tools; the voice service keeps the call's turns for the call. */
  conversation?: 'scripted' | 'native';
  /** Optional. Absent (the default): OpenAI speaks, exactly as before. Present: ElevenLabs speaks. Part of the approval digest, so adding it needs a new approval; it also needs the ElevenLabs key and a consent notice that names ElevenLabs. */
  speaker?: SpeakerConfig;
  /** Optional. Absent (the default): the long cleaning flow, exactly as before. Present: the controlled fast test call (see FastTestConfig). Part of the approval digest. */
  fast_test?: FastTestConfig;
}
const KEYS = 'approval_id,max_openai_calls,openai_model,persona,realtime_model,transcription_model,voice'.split(',');
const OPTIONAL = ['safety_identifier', 'realtime_reasoning', 'text_reasoning', 'transcription', 'conversation', 'speaker', 'fast_test'];
const SPEAKER_KEYS = 'model_id,provider,speed,voice_id';
const asSettings = (s: Record<string, unknown>): unknown => ({ provider: s.provider, voiceId: s.voice_id, modelId: s.model_id, speed: s.speed, outputFormat: 'ulaw_8000' });
/** The speaker settings the config selects, or undefined (the default: OpenAI speaks). The voice config must be valid. */
export function speakerSettingsOf(voice: FounderVoiceConfig): SpeakerSettings | undefined {
  const s = voice.speaker;
  return s === undefined ? undefined : asSettings(s as unknown as Record<string, unknown>) as SpeakerSettings;
}
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
  if ('conversation' in c && c.conversation !== 'scripted' && c.conversation !== 'native') p.push('conversation must be scripted or native');
  if ('speaker' in c) {
    const s = c.speaker;
    if (!isRecord(s) || Object.keys(s).sort().join(',') !== SPEAKER_KEYS || speakerSettingsProblems(asSettings(s as Record<string, unknown>)).length > 0) p.push('speaker must be { provider elevenlabs, voice_id, model_id, speed } with the approved candidate values');
    else if (c.conversation === 'native') p.push('the speaker works with scripted conversation only');
  }
  if ('fast_test' in c) {
    for (const m of fastTestProblems(c.fast_test)) p.push(m);
    // THE JACK GUARD: the fast test is the pilot's call flow, and it must never be spoken by OpenAI. Without a `speaker` section nothing wraps the voice socket, so OpenAI would speak every line. Fail closed at load.
    if (!('speaker' in c)) p.push('the fast test needs the ElevenLabs speaker section (without it OpenAI would speak the calls)');
    if (c.conversation === 'native') p.push('the fast test works with scripted conversation only');
  }
  if ('transcription' in c) {
    for (const m of transcriptionHintProblems(c.transcription)) p.push(m);
    if (typeof c.transcription_model === 'string' && !HINT_TRANSCRIBERS.includes(c.transcription_model)) p.push('transcription hints are documented only for gpt-transcribe and gpt-live-transcribe');
  }
  return p;
}

/** The settings the run will actually use, with the documented defaults filled in (the voice config must be valid). The dry run prints these, so a default is never a surprise. */
export function effectiveVoiceSettings(voice: FounderVoiceConfig): { realtimeReasoning: RealtimeEffort; textReasoning: OpenAIEffort; transcription: RealtimeTranscription | undefined; conversation: 'scripted' | 'native' } {
  return {
    conversation: voice.conversation ?? 'scripted',
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
  env: { allowLive: string | undefined; callApprovedDigest: string | undefined; voiceApprovedDigest: string | undefined; twilioTokenPresent: boolean; openaiKeyPresent: boolean; /** Only asked when the voice config selects the ElevenLabs speaker. */ elevenlabsKeyPresent?: boolean };
  /** Only asked when the voice config has a `fast_test` section: whether the private pieces it needs are in place (presence only). */
  fastTest?: { numbersPresent: boolean; /** FAST_TEXTS=on. Off (the default) is the no-texts test mode: no text can be sent and no owner consent is needed. */ textsOn: boolean; ownerConsent: boolean; jobberConnected: boolean; jobberWritesOn: boolean; /** The booking identity keyring is present and valid. */ keyringReady: boolean; /** Only when it is not ready: the fixed reason. */ keyringProblem?: string };
  nowIso: string;
}
/** Empty means a live voice call may start. */
export function founderVoiceGateProblems(input: VoiceGateInput): string[] {
  const p = founderGateProblems({ config: input.callConfig, env: { allowLive: input.env.allowLive, approvedDigest: input.env.callApprovedDigest, twilioTokenPresent: input.env.twilioTokenPresent }, nowIso: input.nowIso });
  const v = founderVoiceConfigProblems(input.voiceConfig);
  if (v.length > 0) return [...p, ...v];
  if (founderConfigProblems(input.callConfig).length === 0 && input.env.voiceApprovedDigest !== founderVoiceDigest(input.callConfig, input.voiceConfig)) p.push('FOUNDER_VOICE_APPROVED_DIGEST does not match this voice config and call config');
  if (!input.env.openaiKeyPresent) p.push('the OpenAI key is not set');
  // The ElevenLabs speaker (off by default): its key must be present, and the consent notice must tell the caller who the speech provider is (the text of every spoken line goes to it).
  if ((input.voiceConfig as FounderVoiceConfig).speaker !== undefined) {
    if (input.env.elevenlabsKeyPresent !== true) p.push('the ElevenLabs key is not set');
    let notice = '';
    try { if (founderConfigProblems(input.callConfig).length === 0) notice = consentNoticeFor((input.callConfig as FounderCallConfig).opening); } catch { notice = ''; }
    // The long notice must name the speech provider. The CONTROLLED fast test (founder's request) may use a short test notice instead, because that flow only proceeds for an approved test caller, with invented details.
    if (!/eleven\s?labs/i.test(notice) && (input.voiceConfig as FounderVoiceConfig).fast_test === undefined) p.push('the consent notice does not name ElevenLabs as a speech provider');
  }
  // A greeting opening has no request to say yes: only the controlled fast test (which asks its first question in the greeting and takes no yes) may use it.
  if ((input.callConfig as FounderCallConfig).opening?.greeting !== undefined && (input.voiceConfig as FounderVoiceConfig).fast_test === undefined) p.push('the opening greeting is only for the controlled fast test (the voice config has no fast_test section)');
  if ((input.voiceConfig as FounderVoiceConfig).fast_test !== undefined) {
    if (input.env.fastTest?.numbersPresent !== true) p.push('the approved test numbers are not saved (run the private number setup)');
    if (input.env.fastTest?.textsOn === true && input.env.fastTest?.ownerConsent !== true) p.push('the owner text consent is not recorded (run the private owner-consent step)');
    if (input.env.fastTest?.jobberConnected !== true) p.push('Jobber is not connected (authorize the connector first)');
    if (input.env.fastTest?.jobberWritesOn !== true) p.push('JOBBER_ALLOW_WRITES is not set to test-account (the test booking would be refused)');
    if (input.env.fastTest?.keyringReady !== true) p.push(`the booking identity keyring is not ready (${/^[A-Z_]{3,20}$/.test(String(input.env.fastTest?.keyringProblem)) ? input.env.fastTest?.keyringProblem : 'UNKNOWN'}): every booking would fail closed (run the private keyring setup: status, then create)`);
  }
  return p;
}

/** What the run is bounded by, in plain numbers (the call config must be valid). */
export function voiceBounds(callConfig: FounderCallConfig, voice: FounderVoiceConfig): { calls: number; minutesPerCall: number; maxVoiceMinutes: number; maxOpenaiCalls: number } {
  return { calls: callConfig.max_calls, minutesPerCall: callConfig.max_minutes, maxVoiceMinutes: callConfig.max_calls * callConfig.max_minutes, maxOpenaiCalls: voice.max_openai_calls };
}
