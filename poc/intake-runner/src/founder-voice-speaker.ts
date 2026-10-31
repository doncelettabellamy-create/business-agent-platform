// The switch between the two speakers for the founder voice test (proof of concept). PURE: no environment access, no network. founder-voice-entry.ts (the composition root) decides what to hand in.
//
//   settings undefined (the default, the voice config has no `speaker` section)  ->  the OpenAI voice socket opener is returned UNCHANGED (the very same function): OpenAI speaks, as before.
//   settings given (the voice config selects ElevenLabs)                           ->  each call's voice socket is wrapped by the speaker adapter with the ElevenLabs client: OpenAI still LISTENS,
//                                                                                     the fixed lines are spoken by ElevenLabs. The bridge, the transport and the call logic are not involved.
// The key getter and the HTTP client are handed in by the entry; this file reads no environment variable and opens no connection. It names no bridge or transport code (the inventory tests allow only the voice
// service and the connection check to do that), so the socket is described by its shape.

import { withSpeaker } from './speaker-adapter.ts';
import type { SpeakerSettings, SpeakerSocket } from './speaker-adapter.ts';
import { createElevenLabsSpeechSource } from './elevenlabs-speech-source.ts';

export type OpenVoice<S extends SpeakerSocket> = (diag: (code: never, detail?: Record<string, number | string | boolean>) => void) => S;
export interface SpeakerDeps { getKey: () => string | undefined; fetch: typeof globalThis.fetch }

export function withSelectedSpeaker<S extends SpeakerSocket>(open: OpenVoice<S>, settings: SpeakerSettings | undefined, deps: SpeakerDeps): OpenVoice<S> | OpenVoice<SpeakerSocket> {
  if (settings === undefined) return open;
  return (d) => {
    const diag = (code: string, detail?: Record<string, unknown>): void => { d(code as never, detail as never); };
    return withSpeaker(open(d), createElevenLabsSpeechSource({ getKey: deps.getKey, fetch: deps.fetch, diag }), settings, { diag });
  };
}
