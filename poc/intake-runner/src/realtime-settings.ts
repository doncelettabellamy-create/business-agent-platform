// The OpenAI Realtime settings the founder voice test chooses besides the models: how hard the voice model reasons, and what hints the live transcriber is given. PURE: no I/O. Shared by the Realtime adapter
// (which sends them), the voice gate (which validates them) and the tests (whose stand-ins refuse anything the documented schema would refuse).
//
// What the official reference says (client events, read 2026-10-27; summarised by a fetch tool, never tested live):
//   * `reasoning.effort` exists on `session.update` (session type realtime) and on `response.create`, with the values minimal, low, medium, high, xhigh. OpenAI's prompting guide recommends `low` for most
//     production agents and `minimal` for simple latency-critical tasks. This agent only speaks words it is handed, so the default is `minimal`. Whether a given model accepts every value is NOT stated.
//   * `audio.input.transcription` takes `model`, and `languages` (an array of ISO-639-1 codes) and `keywords` (hint words and phrases) ONLY for `gpt-transcribe` and `gpt-live-transcribe`. `language` (singular) is the
//     older field; the transcription guide says not to send both. `prompt` is not documented for either model, so it is not sent. `delay` is documented for `gpt-realtime-whisper` only (the guide says
//     `gpt-live-transcribe`), so it is not sent. Keywords are hints, one line each, with no `<`, `>`, carriage return or line feed (the guide says the session update is rejected otherwise).
//   * The limits on the number and length of languages and keywords are not stated; the bounds below are this project's own and are deliberately small.

export const REALTIME_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type RealtimeEffort = typeof REALTIME_EFFORTS[number];
export const DEFAULT_REALTIME_EFFORT: RealtimeEffort = 'minimal';
/** The transcription models documented to accept `languages` and `keywords`. */
export const HINT_TRANSCRIBERS: readonly string[] = ['gpt-transcribe', 'gpt-live-transcribe'];

export interface RealtimeTranscription {
  /** ISO-639-1 codes, such as "en". */
  languages?: readonly string[];
  /** Hint words or phrases, such as the business name. Never personal data. */
  keywords?: readonly string[];
}
const LANGUAGE = /^[a-z]{2}$/;
const KEYWORD = /^[^\u0000-\u001f\u007f<>\r\n]{1,64}$/;
const MAX_LANGUAGES = 5;
const MAX_KEYWORDS = 20;

export const isRealtimeEffort = (x: unknown): x is RealtimeEffort => typeof x === 'string' && (REALTIME_EFFORTS as readonly string[]).includes(x);

/** Why the transcription hints are not acceptable, as fixed text (never a value). Empty when they are. Pure. */
export function transcriptionHintProblems(t: unknown): string[] {
  if (typeof t !== 'object' || t === null || Array.isArray(t)) return ['transcription must be an object'];
  const p: string[] = [];
  const x = t as Record<string, unknown>;
  for (const k of Object.keys(x)) if (k !== 'languages' && k !== 'keywords') p.push('transcription has an unexpected key');
  if ('languages' in x && (!Array.isArray(x.languages) || x.languages.length < 1 || x.languages.length > MAX_LANGUAGES || !x.languages.every((l) => typeof l === 'string' && LANGUAGE.test(l)))) {
    p.push(`transcription.languages must be 1 to ${MAX_LANGUAGES} two-letter language codes`);
  }
  if ('keywords' in x && (!Array.isArray(x.keywords) || x.keywords.length < 1 || x.keywords.length > MAX_KEYWORDS || !x.keywords.every((k) => typeof k === 'string' && KEYWORD.test(k) && k === k.trim()))) {
    p.push(`transcription.keywords must be 1 to ${MAX_KEYWORDS} single-line hints of 1 to 64 characters with no angle brackets`);
  }
  return p;
}
