// The call transport seam: the ConversationRelay adapter turns the carrier's frames into normalised events and writes the carrier's frames, nothing else.
// Local only: a fake connection, no network, invented text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationRelayTransport } from '../src/call-transport.ts';
import type { TransportEvent } from '../src/call-transport.ts';
import type { CloseInfo, RelayConnection } from '../src/ws-server.ts';

function fake(accept = true) {
  const sent: unknown[] = []; const closed: Array<number | undefined> = [];
  const conn: RelayConnection = { send: (m) => { if (!accept) return false; sent.push(m); return true; }, close: (c) => { closed.push(c); }, onMessage: () => {}, onClose: () => {} };
  const transport = createConversationRelayTransport(conn);
  const events: TransportEvent[] = []; const closes: Array<CloseInfo | undefined> = [];
  transport.onEvent = (e) => { events.push(e); };
  transport.onClose = (i) => { closes.push(i); };
  return { conn, transport, sent, closed, events, closes, feed: (m: unknown) => conn.onMessage(typeof m === 'string' ? m : JSON.stringify(m)) };
}

test('inbound: each carrier frame becomes exactly one normalised event', () => {
  const f = fake();
  f.feed({ type: 'setup', callSid: 'CA1234567890', to: '+15555550100', from: '+15555550123', customParameters: {} });
  f.feed({ type: 'prompt', voicePrompt: 'a house with two bedrooms', lang: 'en-US', last: true });
  f.feed({ type: 'prompt', voicePrompt: 'a house', last: false });
  f.feed({ type: 'prompt', last: true });
  f.feed({ type: 'prompt', voicePrompt: 7, last: true });
  f.feed({ type: 'interrupt', utteranceUntilInterrupt: 'Is this your', durationUntilInterruptMs: 300 });
  f.feed({ type: 'interrupt' });
  f.feed({ type: 'error', description: 'CANARY-CARRIER-TEXT' });
  f.feed({ type: 'dtmf', digit: '1' });
  f.feed({ type: 'something-new' });
  assert.deepEqual(f.events, [
    { kind: 'setup', to: '+15555550100', callSid: 'CA1234567890' },
    { kind: 'utterance', text: 'a house with two bedrooms' },
    { kind: 'partial' }, { kind: 'partial' }, { kind: 'partial' },
    { kind: 'interrupt', spoken: 'Is this your' },
    { kind: 'interrupt', spoken: '' },
    { kind: 'error' }, { kind: 'other' }, { kind: 'other' },
  ]);
  assert.ok(!JSON.stringify(f.events).includes('CANARY'), 'the carrier\'s own error text is never passed on');
});

test('inbound: unreadable frames are malformed; setup fields are passed through unchecked for the call logic to validate', () => {
  const f = fake();
  f.feed('not json'); f.feed('[1,2]'); f.feed('null'); f.feed({ no: 'type' }); f.feed({ type: 5 });
  assert.deepEqual(f.events, [{ kind: 'malformed' }, { kind: 'malformed' }, { kind: 'malformed' }, { kind: 'malformed' }, { kind: 'malformed' }]);
  const g = fake();
  g.feed({ type: 'setup', to: 12, callSid: null });
  assert.deepEqual(g.events, [{ kind: 'setup', to: 12, callSid: null }]);
});

test('inbound: what the carrier says was spoken before an interruption is cut to 600 characters', () => {
  const f = fake();
  f.feed({ type: 'interrupt', utteranceUntilInterrupt: 'x'.repeat(2000) });
  f.feed({ type: 'interrupt', utteranceUntilInterrupt: 42 });
  assert.deepEqual(f.events, [{ kind: 'interrupt', spoken: 'x'.repeat(600) }, { kind: 'interrupt', spoken: '' }]);
});

test('outbound: speak, end and close write the carrier\'s frames and report whether a write was accepted', () => {
  const f = fake();
  assert.equal(f.transport.speak('Hello ', false), true);
  assert.equal(f.transport.speak('', true), true);
  assert.equal(f.transport.speak('Thank you. Goodbye.', true, { interruptible: false }), true);
  assert.equal(f.transport.speak('Okay.', true, { interruptible: true }), true);
  assert.equal(f.transport.endCall(), true);
  f.transport.close(1008); f.transport.close();
  assert.deepEqual(f.sent, [
    { type: 'text', token: 'Hello ', last: false },
    { type: 'text', token: '', last: true },
    { type: 'text', token: 'Thank you. Goodbye.', last: true, interruptible: false },
    { type: 'text', token: 'Okay.', last: true },
    { type: 'end' },
  ]);
  assert.deepEqual(f.closed, [1008, undefined]);
  const refusing = fake(false);
  assert.deepEqual([refusing.transport.speak('x', false), refusing.transport.endCall()], [false, false]);
});

test('close: the connection ending is passed on once with who closed it and the code', () => {
  const f = fake();
  f.conn.onClose({ cause: 'PEER', code: 1000 });
  f.conn.onClose();
  assert.deepEqual(f.closes, [{ cause: 'PEER', code: 1000 }, undefined]);
});

test('the wire format lives only in the transport: the call logic names no carrier frame', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/relay-handler.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const frame of ["type: 'text'", "type: 'end'", 'voicePrompt', 'utteranceUntilInterrupt', 'JSON.parse', 'conn.send', 'conn.onMessage']) assert.ok(!src.includes(frame), `relay-handler.ts must not contain ${frame}`);
});
