// The TwiML for the OpenAI voice connection (step 5 of the OpenAI plan; OFFLINE ONLY): a Twilio Media Streams bidirectional stream, in place of ConversationRelay (opening.ts `twimlFor`, which is
// unchanged and still the live one). It is text for a Twilio TwiML Bin; nothing here is sent anywhere, reads configuration, or touches the phone number's setup.
//
//   <Connect><Stream url="wss://.../relay/SECRET"><Parameter name="to" value="+1..."/></Stream></Connect>
//   <Hangup/>
//
// * NO <Say>: the consent notice is spoken by the voice service (realtime-transport.ts), word for word, and a Say after the stream would speak after the goodbye.
// * THE DIALED NUMBER: a Media Streams `start` message carries no dialed number, so it is passed as a stream parameter named `to`, which realtime-bridge.ts reads from the `start` message and hands to
//   the call logic (which checks it against its own table). Two ways to set it: `{ number }`, a literal E.164 number, one TwiML Bin per number (the safe way: it does not depend on templating), or
//   `{ template: true }`, which writes Twilio's `{{To}}` variable. UNVERIFIED: Twilio's TwiML Bin page documents variables only in element text (`{{From}}`, `{{Body}}`); it does not say that `{{To}}`
//   works, or that a variable is substituted inside an attribute value. Use `{ number }` until a test shows otherwise.
// * HANG-UP: Twilio runs the verbs after <Connect><Stream> only once the server closes the WebSocket, so <Hangup/> ends the call when the bridge closes the stream (after the goodbye has played). If the
//   stream never connects (the tunnel is down, the handshake is refused) the same <Hangup/> runs at once and the caller hears silence, then the line drops: no notice is possible without the voice service.
// * The stream URL: wss only, no query string (Twilio does not support one), and the same long secret path as the current relay address (see founder-call-gate.ts).

const WSS = /^wss:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?\/relay\/[A-Za-z0-9_-]{32,64}$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;
export const STREAM_TO_PARAMETER = 'to';

export type DialedNumber = { number: string } | { template: true };

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Why the inputs are not acceptable, as fixed text (never the value). Empty when they are. Pure. */
export function streamTwimlProblems(publicWssUrl: unknown, dialed: unknown): string[] {
  const out: string[] = [];
  if (typeof publicWssUrl !== 'string' || !WSS.test(publicWssUrl)) out.push('the stream address must be wss://host/relay/ followed by a long random secret, with no query string');
  const d = dialed as { number?: unknown; template?: unknown } | null;
  const hasNumber = typeof d === 'object' && d !== null && 'number' in d;
  const hasTemplate = typeof d === 'object' && d !== null && 'template' in d;
  if (hasNumber === hasTemplate) out.push('give the dialed number either as a literal number or as the template, not both and not neither');
  else if (hasNumber && (typeof d?.number !== 'string' || !E164.test(d.number))) out.push('the dialed number must be an E.164 number such as +15555550100');
  else if (hasTemplate && d?.template !== true) out.push('the template option must be true');
  return out;
}

/** The TwiML to paste into a TwiML Bin for one phone number. Throws a RangeError with fixed text when the inputs are not acceptable. Pure. */
export function streamTwimlFor(publicWssUrl: string, dialed: DialedNumber): string {
  if (streamTwimlProblems(publicWssUrl, dialed).length > 0) throw new RangeError('the stream TwiML inputs are not acceptable');
  const value = 'number' in dialed ? dialed.number : '{{To}}';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Connect>\n    <Stream url="${xml(publicWssUrl)}">\n      <Parameter name="${STREAM_TO_PARAMETER}" value="${xml(value)}" />\n    </Stream>\n  </Connect>\n  <Hangup />\n</Response>\n`;
}
