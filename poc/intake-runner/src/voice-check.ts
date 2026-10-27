// The OpenAI connection check for the Drew founder voice test (the SMALLEST PAID TEST). This file is the logic; founder-voice-check.ts is the command line that reads the files, asks for the key privately and spends.
// Everything outside is HANDED IN (the text client, the voice socket, the clock), so the check is tested with mocks. Nothing here reads an environment variable, holds a credential or opens a connection.
//
// What it does, with INVENTED content only (no real person, number or address; the only caller-like text is one made-up sentence with a placeholder in place of the name):
//   1. two OpenAI text requests, built by the SAME code the phone service uses: an Intake classification with a strict JSON schema, and one spoken-wording reply with the Drew persona;
//   2. one Realtime connection, through the SAME socket, bridge and adapter the phone service uses, with a fake phone that plays nothing and sends no caller audio: it sends the session settings the service would,
//      has the voice speak Drew's actual test greeting (including the "$25 off" special) and one short line, then asks for a longer line and cancels it by its id.
// What bounds the spending: a wall-clock limit for the whole run, at most 3 speech requests and 2 text requests (anything more is refused here, before it is sent), no caller audio at all, and a ceiling computed
// BEFORE the run from the price table below (dated; verify before relying on it) that the person running it must meet or exceed with an explicit limit. An unknown model has no price on file, so there is no ceiling and no run.
//
// WHAT IT CAN PROVE: the key and the model names work; the session settings are accepted (or which one is rejected); the event names the adapter relies on are the real ones; the voice reads fixed text, including a "$25",
// closely enough to pass the adapter's check; a cancel that names a reply stops an out-of-band reply; the text model accepts the reasoning setting together with a strict schema; roughly what a few seconds of speech cost.
// WHAT IT CANNOT PROVE: anything about a phone call: Twilio's signature form, 8 kHz mu-law audio from a real caller, the transcriber on real speech (no audio is sent, so the transcription model is only checked for
// being accepted), interruptions by a live caller, latency over a real line, the consent-before-audio gap, or how the call logic behaves; and anything about real customers.

import { buildClassifyRequest } from './model-gateway.ts';
import { createOpenAIProvider } from './openai-provider.ts';
import { createOpenAIDialogueModel } from './openai-dialogue-model.ts';
import type { OpenAITextClient } from './openai-dialogue-model.ts';
import { createRealtimeBridge } from './realtime-bridge.ts';
import type { VoiceSocket } from './realtime-bridge.ts';
import { createRealtimeTransport, sameSpeech, wordsOf } from './realtime-transport.ts';
import { effectiveVoiceSettings, founderVoiceConfigProblems } from './founder-voice-gate.ts';
import type { FounderVoiceConfig } from './founder-voice-gate.ts';
import { consentNoticeFor, openingProblems } from './opening.ts';
import type { Opening } from './opening.ts';
import { createPersona } from './persona.ts';
import type { TransportEvent } from './call-transport.ts';
import type { RelayConnection } from './ws-server.ts';

export const CHECK_PRICES_AS_OF = '2026-10-27';
/** USD per million tokens, from OpenAI's pricing page on the date above. Verify before relying on it. */
const REALTIME_PRICES: Readonly<Record<string, { audioOut: number; textIn: number; textOut: number }>> = {
  'gpt-realtime-2.1': { audioOut: 64, textIn: 4, textOut: 24 }, 'gpt-realtime-2': { audioOut: 64, textIn: 4, textOut: 24 },
  'gpt-realtime-2.1-mini': { audioOut: 20, textIn: 0.6, textOut: 2.4 },
};
const TEXT_PRICES: Readonly<Record<string, { in: number; out: number }>> = {
  'gpt-6-luna': { in: 0.10, out: 0.50 }, 'gpt-6.1-terra': { in: 1, out: 5 }, 'gpt-5.6-luna': { in: 0.20, out: 1.20 }, 'gpt-5-mini': { in: 0.25, out: 2 }, 'gpt-5.4-mini': { in: 0.75, out: 4.5 },
};
/** The fixed bounds of one run. Audio is metered at 20 tokens per second of assistant speech (OpenAI's cost page). */
export const CHECK_LIMITS = Object.freeze({ maxSeconds: 75, maxSpeechRequests: 3, maxTextRequests: 2, textMaxOutputTokens: 256, textInputAllowance: 2000, speechInputAllowance: 600, speechTextOutputAllowance: 500, audioTokensPerSecond: 20 });

const INVENTED_TEXT = '[PERSON_1] would like a standard cleaning for a two bedroom apartment';
const INVENTED_CATEGORIES = ['Standard cleaning', 'Deep cleaning', 'Move-out cleaning'];
export const LINE_SHORT = 'Could you tell me the address of the job?';
export const LINE_LONG = 'This is a longer test line that the check will cancel part of the way through, so that we can see whether a cancel which names the reply really stops it from being spoken to the end.';
const TEST_NUMBER = '+15555550100';
const TEST_CALL_SID = 'CA00000000000000000000000000000001';

export interface CheckPlan {
  notice: string;
  noticeChars: number;
  /** About how long the notice takes to say, at the call logic's 70 ms per character. */
  noticeSeconds: number;
  ceilingUsd: number;
  breakdown: { audioOut: number; speechText: number; textModels: number };
  models: { text: string; realtime: string; transcription: string; voice: string };
  settings: { realtimeReasoning: string; textReasoning: string; hints: string };
}
/** Pure: what the run would do and the most it could cost, or why it cannot be planned. */
export function planCheck(voice: unknown, opening: unknown): { ok: true; plan: CheckPlan } | { ok: false; problems: string[] } {
  const problems = [...founderVoiceConfigProblems(voice), ...openingProblems(opening)];
  if (problems.length > 0) return { ok: false, problems };
  const v = voice as FounderVoiceConfig;
  const rt = REALTIME_PRICES[v.realtime_model]; const tx = TEXT_PRICES[v.openai_model];
  if (rt === undefined) problems.push('no price is on file for the Realtime model, so no spending ceiling can be computed and the check will not run');
  if (tx === undefined) problems.push('no price is on file for the text model, so no spending ceiling can be computed and the check will not run');
  if (rt === undefined || tx === undefined) return { ok: false, problems };
  const L = CHECK_LIMITS;
  const audioOut = (L.maxSeconds * L.audioTokensPerSecond * rt.audioOut) / 1e6;
  const speechText = (L.maxSpeechRequests * (L.speechInputAllowance * rt.textIn + L.speechTextOutputAllowance * rt.textOut)) / 1e6;
  const textModels = (L.maxTextRequests * (L.textInputAllowance * tx.in + L.textMaxOutputTokens * tx.out)) / 1e6;
  const notice = consentNoticeFor(opening as Opening);
  const s = effectiveVoiceSettings(v);
  return {
    ok: true,
    plan: {
      notice, noticeChars: notice.length, noticeSeconds: Math.round((notice.length * 70) / 1000),
      ceilingUsd: Math.ceil((audioOut + speechText + textModels) * 100) / 100,
      breakdown: { audioOut, speechText, textModels },
      models: { text: v.openai_model, realtime: v.realtime_model, transcription: v.transcription_model, voice: v.voice },
      settings: { realtimeReasoning: s.realtimeReasoning, textReasoning: s.textReasoning, hints: s.transcription === undefined ? 'none' : `${s.transcription.languages?.length ?? 0} language(s), ${s.transcription.keywords?.length ?? 0} keyword(s)` },
    },
  };
}

export interface CheckResult { name: string; ok: boolean; code: string; detail?: Record<string, string | number | boolean> }
export interface CheckReport {
  checks: CheckResult[];
  allPassed: boolean;
  elapsedMs: number;
  estimatedUsd: number;
  ceilingUsd: number;
  withinCeiling: boolean;
  counts: { speechRequests: number; textRequests: number; blockedSends: number; audioFrames: number; audioMs: number };
}
export interface CheckDeps {
  plan: CheckPlan;
  voice: FounderVoiceConfig;
  textClient: OpenAITextClient;
  /** The connection to the voice service (the real OpenAI socket in the command line, a mock in tests). */
  voiceSocket: VoiceSocket;
  now(): number;
  /** Test hook: a shorter wall-clock limit than the plan's. */
  maxMs?: number;
}

const clean = (s: unknown, re: RegExp): string => (typeof s === 'string' && re.test(s) ? s : 'other');
const num = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0);
const sleep = (ms: number): Promise<void> => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

export async function runCheck(d: CheckDeps): Promise<CheckReport> {
  const L = CHECK_LIMITS;
  const started = d.now();
  const deadline = started + (d.maxMs ?? L.maxSeconds * 1000);
  const checks: CheckResult[] = [];
  const add = (name: string, ok: boolean, code: string, detail?: CheckResult['detail']): void => { checks.push({ name, ok, code, ...(detail === undefined ? {} : { detail }) }); };
  const left = (): number => Math.max(0, deadline - d.now());
  const until = async (fn: () => boolean, ms: number = left()): Promise<boolean> => { const end = Math.min(deadline, d.now() + ms); while (!fn()) { if (d.now() >= end) return false; await sleep(5); } return true; };
  const eff = effectiveVoiceSettings(d.voice);
  const persona = createPersona(d.voice.persona);
  const textPrice = TEXT_PRICES[d.voice.openai_model];
  const rtPrice = REALTIME_PRICES[d.voice.realtime_model];

  // ---------------------------------------------------------------- 1. the two text requests (the same code the phone service uses)
  let textRequests = 0; let textUsd = 0;
  const textClient: OpenAITextClient = {
    responses: {
      async create(params, options) {
        if (textRequests >= L.maxTextRequests) throw new Error('text request limit reached');
        textRequests++;
        const r = await d.textClient.responses.create(params, options);
        textUsd += (num(r?.usage?.input_tokens) * textPrice.in + num(r?.usage?.output_tokens) * textPrice.out) / 1e6;
        return r;
      },
    },
  };
  try {
    const provider = createOpenAIProvider(textClient, { model: d.voice.openai_model, effort: eff.textReasoning });
    const res = await provider.complete(buildClassifyRequest(INVENTED_TEXT, INVENTED_CATEGORIES, L.textMaxOutputTokens), AbortSignal.timeout(Math.max(1000, Math.min(20_000, left()))));
    let parsed: { category?: unknown; confidence?: unknown } | undefined;
    try { parsed = JSON.parse(res.text); } catch { parsed = undefined; }
    const shapeOk = parsed !== undefined && parsed !== null && typeof parsed === 'object' && 'category' in parsed && typeof parsed.confidence === 'number';
    const ends = Object.keys(provider.stats.stop_reasons).join(',').slice(0, 60) || 'none';
    add('text_structured', shapeOk, shapeOk ? 'TEXT_STRICT_SCHEMA_OK' : res.text === '' ? 'TEXT_EMPTY_ANSWER' : 'TEXT_SHAPE_WRONG', { ended: ends, outputTokens: num(res.usage?.output_tokens) });
  } catch {
    add('text_structured', false, 'TEXT_REQUEST_FAILED', { requests: textRequests });
  }
  try {
    const model = createOpenAIDialogueModel(textClient, { model: d.voice.openai_model, persona, effort: eff.textReasoning });
    let said = '';
    for await (const piece of model.reply({ turns: [], directive: { kind: 'open' } })) said += piece;
    const stop = model.stats.last?.stop ?? 'NONE';
    const ok = said.trim().length > 0 && said.length <= 600 && stop === 'END_TURN';
    add('text_wording', ok, ok ? 'TEXT_WORDING_OK' : said.trim().length === 0 ? 'TEXT_WORDING_EMPTY' : 'TEXT_WORDING_ODD', { chars: said.length, stop });
  } catch {
    add('text_wording', false, 'TEXT_REQUEST_FAILED', { requests: textRequests });
  }

  // ---------------------------------------------------------------- 2. one Realtime connection through the real socket, bridge and adapter
  const requestedWords = new Map<string, string>();   // the adapter's request id -> the exact words it asked for
  const obs = {
    sessionUpdated: false, errors: [] as Array<{ type: string; code: string; param: string }>, created: [] as Array<{ id: string; words: string }>,
    done: new Map<string, { status: string; input: number; audio: number; text: number }>(), transcripts: new Map<string, { exact: boolean; spoken: boolean; chars: number }>(), opened: false, closed: false,
  };
  let speechRequests = 0; let blocked = 0;
  const observe = (raw: string): void => {
    let m: any; try { m = JSON.parse(raw); } catch { return; }
    if (typeof m?.type !== 'string') return;
    if (m.type === 'session.updated') obs.sessionUpdated = true;
    else if (m.type === 'error') obs.errors.push({ type: clean(m.error?.type, /^[a-z_]{1,64}$/), code: clean(m.error?.code, /^[a-z0-9_]{1,64}$/), param: clean(m.error?.param, /^[A-Za-z0-9_.[\]]{1,80}$/) });
    else if (m.type === 'response.created' && typeof m.response?.id === 'string') obs.created.push({ id: m.response.id, words: requestedWords.get(String(m.response.metadata?.id)) ?? '' });
    else if (m.type === 'response.output_audio_transcript.done' && typeof m.response_id === 'string' && typeof m.transcript === 'string') {
      const words = obs.created.find((c) => c.id === m.response_id)?.words ?? '';
      obs.transcripts.set(m.response_id, { exact: m.transcript.trim() === words.trim(), spoken: sameSpeech(m.transcript, words), chars: m.transcript.length });
    } else if (m.type === 'response.done' && typeof m.response?.id === 'string') {
      const u = m.response.usage ?? {}; const det = u.output_token_details ?? {};
      const out = num(u.output_tokens); const audio = det.audio_tokens === undefined ? out : num(det.audio_tokens);
      obs.done.set(m.response.id, { status: clean(m.response.status, /^[a-z_]{1,32}$/), input: num(u.input_tokens), audio, text: Math.max(0, out - audio) });
    }
  };
  // The tap sits between the bridge and the voice socket: it sees every message, and it refuses anything beyond the bounds BEFORE it is sent.
  const tap: VoiceSocket = {
    send(text: string): boolean {
      let m: any; try { m = JSON.parse(text); } catch { blocked++; return false; }
      if (m?.type === 'input_audio_buffer.append') { blocked++; return false; }   // this check sends no caller audio, ever
      if (m?.type === 'response.create') {
        if (speechRequests >= L.maxSpeechRequests) { blocked++; return false; }
        speechRequests++;
        requestedWords.set(String(m.response?.metadata?.id), wordsOf(String(m.response?.instructions ?? '')));
      }
      return d.voiceSocket.send(text);
    },
    close: (code?: number) => { obs.closed = true; d.voiceSocket.close(code); },
    get onOpen() { return () => {}; }, set onOpen(fn: () => void) { d.voiceSocket.onOpen = () => { obs.opened = true; fn(); }; },
    get onMessage() { return () => {}; }, set onMessage(fn: (t: string) => void) { d.voiceSocket.onMessage = (t: string) => { observe(t); fn(t); }; },
    get onClose() { return () => {}; }, set onClose(fn: () => void) { d.voiceSocket.onClose = () => { obs.closed = true; fn(); }; },
  };
  const media = { frames: 0, bytes: 0, clears: 0, closed: false };
  const phone: RelayConnection = {
    send(m: unknown): boolean {
      const x = m as { event?: string; media?: { payload?: string }; mark?: { name?: string }; streamSid?: string };
      if (x.event === 'media') { media.frames++; media.bytes += Buffer.from(String(x.media?.payload ?? ''), 'base64').length; }
      else if (x.event === 'mark') queueMicrotask(() => phone.onMessage(JSON.stringify({ event: 'mark', streamSid: x.streamSid, mark: { name: x.mark?.name } })));   // played at once: no phone is listening
      else if (x.event === 'clear') media.clears++;
      return true;
    },
    close(): void { media.closed = true; },
    onMessage: () => {},
    onClose: () => {},
  };
  const events: TransportEvent[] = [];
  const kinds = (): string[] => events.map((e) => e.kind);
  const bridge = createRealtimeBridge(phone, tap, { maxCallMs: Math.max(1000, left()), openWaitMs: Math.min(10_000, Math.max(1000, left())) });
  const transport = createRealtimeTransport(bridge.link, {
    notice: d.plan.notice, transcriptionModel: d.voice.transcription_model, voice: d.voice.voice, persona, reasoningEffort: eff.realtimeReasoning,
    ...(eff.transcription === undefined ? {} : { transcription: eff.transcription }),
  });
  transport.onEvent = (e) => { events.push(e); };
  phone.onMessage(JSON.stringify({ event: 'start', start: { streamSid: 'MZ00000000000000000000000000000001', callSid: TEST_CALL_SID, customParameters: { to: TEST_NUMBER }, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } } }));

  const started1 = await until(() => kinds().includes('setup') || obs.closed || obs.errors.length > 0, left());
  const noticeOk = kinds().includes('setup');
  const firstError = obs.errors[0];
  add('session_accepted', obs.sessionUpdated && obs.errors.length === 0, obs.sessionUpdated && obs.errors.length === 0 ? 'SESSION_ACCEPTED' : firstError !== undefined ? 'SESSION_REJECTED' : obs.opened ? 'SESSION_NOT_CONFIRMED' : 'CONNECTION_FAILED',
    firstError === undefined ? { opened: obs.opened } : { errorType: firstError.type, errorCode: firstError.code, errorParam: firstError.param });
  const noticeId = obs.created[0]?.id; const noticeT = noticeId === undefined ? undefined : obs.transcripts.get(noticeId);
  add('notice_verified', noticeOk, noticeOk ? 'NOTICE_SPOKEN_AND_MATCHED' : started1 ? 'NOTICE_NOT_PLAYED' : 'NOTICE_TIMED_OUT', { transcriptMatchesExactly: noticeT?.exact ?? false, transcriptMatchesSpokenForm: noticeT?.spoken ?? false, specialIncluded: d.plan.notice.includes('$') });

  let shortOk = false; let cancelOk = false;
  if (noticeOk) {
    transport.speak(LINE_SHORT, true);
    shortOk = await until(() => obs.created.length >= 2 && obs.done.get(obs.created[1].id)?.status === 'completed', left()) && !kinds().includes('reply_failed');
    add('speech_verified', shortOk, shortOk ? 'SPEECH_SPOKEN_AND_MATCHED' : 'SPEECH_FAILED', { transcriptMatchesSpokenForm: obs.transcripts.get(obs.created[1]?.id ?? '')?.spoken ?? false });
    if (shortOk) {
      const framesBefore = media.frames;
      transport.speak(LINE_LONG, true);
      const gotThird = await until(() => obs.created.length >= 3 && media.frames > framesBefore, Math.min(left(), 15_000));
      if (gotThird) {
        const id = obs.created[2].id;
        tap.send(JSON.stringify({ type: 'response.cancel', response_id: id, event_id: 'check-cancel-1' }));
        cancelOk = (await until(() => obs.done.has(id), Math.min(left(), 6000))) && obs.done.get(id)?.status === 'cancelled';
        add('cancel_by_id', cancelOk, cancelOk ? 'CANCEL_STOPPED_REPLY' : obs.done.has(id) ? 'CANCEL_IGNORED' : 'CANCEL_NO_ANSWER', { status: obs.done.get(id)?.status ?? 'none' });
      } else add('cancel_by_id', false, 'CANCEL_NOT_TRIED', {});
    } else add('cancel_by_id', false, 'CANCEL_NOT_TRIED', {});
  } else {
    add('speech_verified', false, 'NOT_RUN', {});
    add('cancel_by_id', false, 'NOT_RUN', {});
  }
  const audioMs = Math.round(media.bytes / 8);
  add('audio_flowed', media.frames > 0 && audioMs > 0, media.frames > 0 ? 'AUDIO_RECEIVED' : 'NO_AUDIO', { frames: media.frames, audioMs, noticeAudioSecondsExpected: d.plan.noticeSeconds });
  transport.close(1000);
  await sleep(20);
  add('cleanup', media.closed && obs.closed, media.closed && obs.closed ? 'CLEANED_UP' : 'NOT_CLEANED_UP', { phoneClosed: media.closed, voiceClosed: obs.closed });

  let realtimeUsd = 0;
  for (const r of obs.done.values()) realtimeUsd += (r.input * rtPrice.textIn + r.audio * rtPrice.audioOut + r.text * rtPrice.textOut) / 1e6;
  const estimatedUsd = Math.round((realtimeUsd + textUsd) * 1e6) / 1e6;
  return {
    checks, allPassed: checks.every((c) => c.ok), elapsedMs: d.now() - started, estimatedUsd, ceilingUsd: d.plan.ceilingUsd, withinCeiling: estimatedUsd <= d.plan.ceilingUsd,
    counts: { speechRequests, textRequests, blockedSends: blocked, audioFrames: media.frames, audioMs },
  };
}
