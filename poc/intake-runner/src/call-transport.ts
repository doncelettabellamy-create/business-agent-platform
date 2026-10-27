// The seam between one phone call's logic (relay-handler.ts) and the service that carries the call's audio (proof of concept, founder test).
//
// relay-handler.ts used to read Twilio ConversationRelay's JSON frames and write its own, inline. That made the call logic impossible to run over any
// other carrier without copying it. This file holds the whole of that wire format in one place, behind a small interface:
//
//   inbound   a normalised event: the call is set up, the caller finished an utterance, the caller talked over the assistant, and a few
//             bookkeeping kinds (a half-finished result, an error frame, anything else, an unreadable frame);
//   outbound  speak a piece of text (the last piece of a reply carries `last`), end the call, close the connection.
//
// Nothing here decides anything. It adds no limits, makes no judgement, and logs nothing. A later carrier (for example a speech-to-speech
// service whose server stays in charge of what is said) implements the same interface and the call logic does not change.
//
// `createConversationRelayTransport` is the only implementation today. Its behaviour is exactly what relay-handler.ts did before this seam
// existed, frame for frame: same fields, same order, same treatment of malformed input.

import { isRecord } from './contracts.ts';
import type { CloseInfo, RelayConnection } from './ws-server.ts';

export type TransportEvent =
  /** A frame that could not be read as a message with a string `type`. */
  | { kind: 'malformed' }
  /** The call has been set up. `to` and `callSid` are passed through unchecked (the call logic validates them). */
  | { kind: 'setup'; to: unknown; callSid: unknown }
  /** The caller finished an utterance. RAW speech: the receiver must mask it before keeping or sending it anywhere. */
  | { kind: 'utterance'; text: string }
  /** A partial or unusable speech result. It is counted, never acted on. */
  | { kind: 'partial' }
  /** The caller talked over the assistant. `spoken` is what the carrier says was actually spoken, cut to 600 characters ('' when it does not say). */
  | { kind: 'interrupt'; spoken: string }
  /** The carrier reported an error. Its text is never passed on. */
  | { kind: 'error' }
  /** Any other frame (keypad digits and so on). Not used. */
  | { kind: 'other' }
  /**
   * A reply the call logic sent was NOT played as sent: the carrier reports that it failed, produced no sound, or said different words. The carrier in use today
   * (ConversationRelay) never reports this; a carrier that speaks for itself must, because the call logic otherwise takes a spoken question to have been heard.
   */
  | { kind: 'reply_failed' };

export interface CallTransport {
  /** Set by the call logic. Called once per inbound event, in order. */
  onEvent: (event: TransportEvent) => void;
  /** Set by the call logic. Called once when the connection ends for any reason. */
  onClose: (info?: CloseInfo) => void;
  /**
   * Speaks one piece of text. `last` marks the end of the reply (an empty `token` with `last` closes words already sent). `interruptible: false` means the caller
   * cannot talk over it. False when the connection is gone or too slow to take it.
   */
  speak(token: string, last: boolean, options?: { interruptible?: boolean }): boolean;
  /** Tells the carrier to end the call. False when it could not be sent. */
  endCall(): boolean;
  close(code?: number): void;
}

/** Twilio ConversationRelay over the existing WebSocket connection (ws-server.ts). */
export function createConversationRelayTransport(conn: RelayConnection): CallTransport {
  const transport: CallTransport = {
    onEvent: () => {},
    onClose: () => {},
    speak(token: string, last: boolean, options?: { interruptible?: boolean }): boolean {
      return conn.send(options?.interruptible === false ? { type: 'text', token, last, interruptible: false } : { type: 'text', token, last });
    },
    endCall(): boolean { return conn.send({ type: 'end' }); },
    close(code?: number): void { conn.close(code); },
  };
  conn.onMessage = (text: string): void => {
    let m: unknown;
    try { m = JSON.parse(text); } catch { transport.onEvent({ kind: 'malformed' }); return; }
    if (!isRecord(m) || typeof m.type !== 'string') { transport.onEvent({ kind: 'malformed' }); return; }
    const msg = m as Record<string, unknown>;
    if (msg.type === 'interrupt') { transport.onEvent({ kind: 'interrupt', spoken: typeof msg.utteranceUntilInterrupt === 'string' ? msg.utteranceUntilInterrupt.slice(0, 600) : '' }); return; }
    if (msg.type === 'setup') { transport.onEvent({ kind: 'setup', to: msg.to, callSid: msg.callSid }); return; }
    if (msg.type === 'prompt') {
      if (msg.last !== true || typeof msg.voicePrompt !== 'string') transport.onEvent({ kind: 'partial' });
      else transport.onEvent({ kind: 'utterance', text: msg.voicePrompt });
      return;
    }
    transport.onEvent(msg.type === 'error' ? { kind: 'error' } : { kind: 'other' });
  };
  conn.onClose = (info?: CloseInfo): void => { transport.onClose(info); };
  return transport;
}
