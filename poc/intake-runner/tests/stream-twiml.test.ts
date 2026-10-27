// The Twilio Media Streams instructions for the OpenAI voice connection (src/stream-twiml.ts), and how the stream connection is authenticated, checked offline: the text of the TwiML, its fit with the
// bridge, and the existing WebSocket server (secret path plus X-Twilio-Signature) carrying a Media Streams style conversation over 127.0.0.1. Nothing here touches the network beyond loopback, and a
// passing test shows behaviour against a stand-in for Twilio, not against Twilio. Invented data only. Run: npm test
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRelayWsServer } from '../src/ws-server.ts';
import { signedUrlCandidates } from '../src/founder-call-gate.ts';
import { createRealtimeBridge } from '../src/realtime-bridge.ts';
import { createRealtimeTransport } from '../src/realtime-transport.ts';
import { STREAM_TO_PARAMETER, streamTwimlFor, streamTwimlProblems } from '../src/stream-twiml.ts';
import { twimlFor } from '../src/opening.ts';
import type { TransportEvent } from '../src/call-transport.ts';
import { connectRelay } from './helpers/twilio-sim.ts';
import { createWirePhone, createWireVoice } from './helpers/realtime-wire-sim.ts';
import type { WireVoice } from './helpers/realtime-wire-sim.ts';

const SECRET = 'q7Zr2KfX9mWc4TbV8nHs1LpD6yGe3AuJ5oRi0NxE';
const URL_WSS = `wss://tunnel.example.test/relay/${SECRET}`;
const PATH = `/relay/${SECRET}`;
const N1 = '+15555550100';
const TOKEN = 'test-auth-token-0123456789';
const NOTICE = 'Hello. This is an automated A I assistant for Drew Cleaning. Please say yes to continue, or hang up now.';
const servers: Array<{ close(): Promise<void> }> = [];
after(async () => { for (const s of servers) await s.close(); });
async function until(fn: () => boolean, ms = 3000): Promise<void> { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise<void>((r) => setTimeout(r, 4)); } }

// ================================================================ the text
test('twiml: a stream with the dialed number as a parameter and a hang-up after it, and nothing else', () => {
  const x = streamTwimlFor(URL_WSS, { number: N1 });
  assert.equal(x, `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Connect>\n    <Stream url="${URL_WSS}">\n      <Parameter name="to" value="${N1}" />\n    </Stream>\n  </Connect>\n  <Hangup />\n</Response>\n`);
  const verbs = [...x.matchAll(/<(\/?)(\w+)/g)].filter((m) => m[1] === '').map((m) => m[2]);
  assert.deepEqual(verbs, ['Response', 'Connect', 'Stream', 'Parameter', 'Hangup'], 'the hang-up comes after the connection, which Twilio runs only once the server closes the socket');
  assert.ok(x.indexOf('</Connect>') < x.indexOf('<Hangup'));
  assert.ok(!/<Say|ConversationRelay|welcomeGreeting|<Pause|<Dial|<Record/.test(x), 'the voice service speaks the notice; the TwiML says and records nothing');
  assert.ok(!/\?/.test(x.replace('<?xml version="1.0" encoding="UTF-8"?>', '')), 'no query string anywhere');
  assert.ok(!x.includes('track=') && !x.includes('statusCallback'));
  assert.equal(STREAM_TO_PARAMETER, 'to');
});

test('twiml: the template form writes the variable, and is labelled unverified in the source', () => {
  const x = streamTwimlFor(URL_WSS, { template: true });
  assert.ok(x.includes('<Parameter name="to" value="{{To}}" />'));
  const src = readFileSync(new URL('../src/stream-twiml.ts', import.meta.url), 'utf8');
  assert.ok(/UNVERIFIED/.test(src), 'the template form is marked as unverified');
});

test('twiml: addresses and numbers that are not acceptable are refused with fixed text that echoes nothing', () => {
  const CANARY = 'canary-value-7731';
  const badUrls = ['ws://tunnel.example.test/relay/' + SECRET, 'https://tunnel.example.test/relay/' + SECRET, `${URL_WSS}?token=${CANARY}`, 'wss://tunnel.example.test/relay/short', `wss://tunnel.example.test/other/${SECRET}`, `wss://tunnel.example.test/relay/${SECRET}/extra`, `wss://user:${CANARY}@tunnel.example.test/relay/${SECRET}`, `wss://tunnel.example.test/relay/${SECRET}"><Say>x</Say>`, '', 12, null];
  for (const u of badUrls) {
    assert.ok(streamTwimlProblems(u, { number: N1 }).length > 0, String(u));
    assert.throws(() => streamTwimlFor(u as never, { number: N1 }), (e: unknown) => e instanceof RangeError && !String((e as Error).message).includes(CANARY));
  }
  const badDialed: unknown[] = [{ number: '5555550100' }, { number: '+0123456789' }, { number: `+1555555${CANARY}` }, { number: '+1555"/><Say>x</Say>' }, { number: 5555550100 }, { number: N1, template: true }, {}, { template: false }, { template: 'yes' }, null, 'to', undefined];
  for (const d of badDialed) {
    assert.ok(streamTwimlProblems(URL_WSS, d).length > 0, JSON.stringify(d));
    assert.throws(() => streamTwimlFor(URL_WSS, d as never), (e: unknown) => e instanceof RangeError && !String((e as Error).message).includes(CANARY));
  }
  assert.ok(streamTwimlProblems(URL_WSS, { number: N1 }).length === 0 && streamTwimlProblems(URL_WSS, { template: true }).length === 0);
  for (const p of streamTwimlProblems(`${URL_WSS}?x=${CANARY}`, { number: `+1${CANARY}` })) assert.ok(!p.includes(CANARY), p);
});

test('twiml: the live ConversationRelay TwiML is unchanged, and only the voice entry uses the stream TwiML, never the live Claude entry', () => {
  assert.ok(twimlFor(URL_WSS).includes('<ConversationRelay '));
  assert.ok(!twimlFor(URL_WSS).includes('<Stream'));
  const code = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const f of readdirSync(new URL('../src/', import.meta.url)).filter((n) => n.endsWith('.ts') && n !== 'stream-twiml.ts')) assert.equal(/stream-twiml/.test(code(f)), f === 'founder-voice-entry.ts', `${f}: only the voice entry (not the live Claude entry) may use the stream TwiML`);
  const own = code('stream-twiml.ts');
  assert.ok(!/^import\s/m.test(own) && !/process\.|fetch\s*\(|node:|console\./.test(own), 'it imports nothing, reads nothing and sends nothing');
});

// ================================================================ fit with the bridge
test('fit: the parameter the TwiML writes is the one the bridge reads, and the number reaches the call logic', async () => {
  const x = streamTwimlFor(URL_WSS, { number: N1 });
  const name = /<Parameter name="([^"]+)" value="([^"]+)"/.exec(x);
  assert.ok(name);
  const phone = createWirePhone(); const voice = createWireVoice({ msPerChar: 1 });
  const bridge = createRealtimeBridge(phone, voice);
  const t = createRealtimeTransport(bridge.link, { notice: NOTICE, transcriptionModel: 'sim-transcriber', voice: 'sim-voice', msPerChar: 1 });
  const events: TransportEvent[] = []; t.onEvent = (e) => { events.push(e); };
  // The start message Twilio would send for that TwiML: the parameters set in it arrive under customParameters.
  phone.raw(JSON.stringify({ event: 'start', sequenceNumber: '1', start: { accountSid: 'AC' + '0'.repeat(32), streamSid: 'MZ1', callSid: 'CA' + '0'.repeat(31) + '1', tracks: ['inbound'], customParameters: { [name[1]]: name[2] }, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } }, streamSid: 'MZ1' }));
  await until(() => events.some((e) => e.kind === 'setup'));
  assert.equal((events.find((e) => e.kind === 'setup') as { to: unknown }).to, N1);
  // A stream whose TwiML set no such parameter reaches the call logic with no number, which the call logic refuses.
  const p2 = createWirePhone(); const v2 = createWireVoice({ msPerChar: 1 });
  const b2 = createRealtimeBridge(p2, v2); const t2 = createRealtimeTransport(b2.link, { notice: NOTICE, transcriptionModel: 'x', voice: 'y', msPerChar: 1 });
  const e2: TransportEvent[] = []; t2.onEvent = (e) => { e2.push(e); };
  p2.raw(JSON.stringify({ event: 'start', start: { streamSid: 'MZ1', callSid: 'CA' + '0'.repeat(31) + '1', customParameters: {}, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } } }));
  await until(() => e2.some((e) => e.kind === 'setup'));
  assert.equal((e2.find((e) => e.kind === 'setup') as { to: unknown }).to, undefined);
});

// ================================================================ how the stream is authenticated
async function startServer() {
  let voice: WireVoice | undefined; let endCall: (() => boolean) | undefined; const events: TransportEvent[] = []; let connections = 0;
  const server = createRelayWsServer({
    path: PATH, authToken: TOKEN, urls: signedUrlCandidates(URL_WSS), maxConnections: 2,
    onConnection: (conn) => {
      connections++;
      voice = createWireVoice({ msPerChar: 1 });
      const bridge = createRealtimeBridge(conn, voice);
      const t = createRealtimeTransport(bridge.link, { notice: NOTICE, transcriptionModel: 'sim-transcriber', voice: 'sim-voice', msPerChar: 1, endWaitMs: 500 });
      t.onEvent = (e) => { events.push(e); };
      endCall = () => t.endCall();
    },
  } as never);
  const port = await server.listen(0);
  servers.push(server);
  return { port, events, voice: () => voice, endCall: () => endCall?.(), connections: () => connections };
}
/** The phone side of the conversation: plays what it is sent and echoes every marker back, as Twilio does when the audio has played. */
function echoMarks(sim: Awaited<ReturnType<typeof connectRelay>>): void {
  let seen = 0;
  const timer = setInterval(() => {
    for (; seen < sim.messages.length; seen++) { const m = sim.messages[seen]; if (m.event === 'mark') sim.send({ event: 'mark', streamSid: m.streamSid, mark: { name: m.mark.name } }); }
  }, 5);
  timer.unref?.();
  void sim.closed.then(() => clearInterval(timer));
}
const startFrame = { event: 'start', sequenceNumber: '1', start: { streamSid: 'MZ1', callSid: 'CA' + '0'.repeat(31) + '1', tracks: ['inbound'], customParameters: { to: N1 }, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } }, streamSid: 'MZ1' };

test('auth: a Media Streams style conversation runs over the existing server when the handshake carries the secret path and a valid signature of the stream address', async () => {
  const s = await startServer();
  const sim = await connectRelay({ port: s.port, token: TOKEN, url: URL_WSS, path: PATH });
  assert.equal(sim.status, 101);
  sim.send({ event: 'connected', protocol: 'Call', version: '1.0.0' });
  sim.send(startFrame);
  const media = await sim.next((m) => m.event === 'media');
  assert.equal(media.streamSid, 'MZ1');
  assert.ok(typeof media.media.payload === 'string' && media.media.payload.length > 0);
  const mark = await sim.next((m) => m.event === 'mark');
  assert.equal(mark.streamSid, 'MZ1');
  // The notice is counted as heard, and the call logic told the call has started, only when the phone has echoed every marker.
  assert.ok(!s.events.some((e) => e.kind === 'setup'));
  echoMarks(sim);
  await until(() => s.events.some((e) => e.kind === 'setup'));
  assert.equal((s.events.find((e) => e.kind === 'setup') as { to: unknown }).to, N1);
  assert.equal(s.voice()?.spoken[0], NOTICE);
  // Hanging up closes the stream, which is what lets Twilio run the TwiML's hang-up.
  assert.equal(s.endCall(), true);
  await sim.closed;
  assert.equal(sim.closeCode(), 1000);
});

test('auth: a handshake with no signature, a wrong signature, a signature of another address, or the wrong path never reaches the bridge', async () => {
  const s = await startServer();
  const bad = [
    await connectRelay({ port: s.port, token: TOKEN, url: URL_WSS, path: PATH, signature: null }),
    await connectRelay({ port: s.port, token: TOKEN, url: URL_WSS, path: PATH, signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=' }),
    await connectRelay({ port: s.port, token: TOKEN, url: 'wss://other.example.test/relay/' + SECRET, path: PATH }),
    await connectRelay({ port: s.port, token: 'another-auth-token-xyz', url: URL_WSS, path: PATH }),
    await connectRelay({ port: s.port, token: TOKEN, url: URL_WSS, path: '/relay/wrongwrongwrongwrongwrongwrongwrongwrong' }),
  ];
  assert.ok(bad.every((b) => b.status !== 101), bad.map((b) => b.status).join());
  assert.equal(s.connections(), 0);
});

test('auth: the signature covers the stream address only; the parameters of the TwiML arrive after the handshake and are not signed, so the call logic still checks the dialed number itself', async () => {
  const s = await startServer();
  const sim = await connectRelay({ port: s.port, token: TOKEN, url: URL_WSS, path: PATH });
  assert.equal(sim.status, 101);
  sim.send({ ...startFrame, start: { ...startFrame.start, customParameters: { to: '+15555550177' } } });   // anyone past the handshake can name any number
  await sim.next((m) => m.event === 'mark');
  echoMarks(sim);
  await until(() => s.events.some((e) => e.kind === 'setup'));
  assert.equal((s.events.find((e) => e.kind === 'setup') as { to: unknown }).to, '+15555550177', 'passed on as given: the table in the call logic decides whether the number is one of ours');
  sim.end();
});
