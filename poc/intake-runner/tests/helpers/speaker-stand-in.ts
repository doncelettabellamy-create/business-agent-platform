// A TEST STAND-IN for the speech source behind the speaker adapter (src/speaker-adapter.ts). It makes silence-like mu-law bytes of a length that follows the text, with behaviours a real provider can show
// (fast delivery, a failed start, nothing at all, a stall, an error part-way, a bad or oversized piece, pieces that keep arriving after a cancel). No network, no key, no provider: a passing test shows
// behaviour against THIS model only. Nothing here knows how ElevenLabs sounds or behaves.
import type { SpeechHandle, SpeechRequest, SpeechSink, SpeechSource } from '../../src/speaker-adapter.ts';

export type StandInBehaviour =
  | 'ok' | 'fail-start' | 'never' | 'empty' | 'bad-audio' | 'huge' | 'burst'
  | { failAfter: number } | { stallAfter: number };
export interface StandIn extends SpeechSource {
  /** Every request received, in order (test-only: a real adapter keeps no text). */
  readonly requests: SpeechRequest[];
  started(): number;
  cancelled(): number;
  /** Pieces the stand-in handed to the sink AFTER it was cancelled (a provider whose socket keeps delivering). */
  lateEmitted(): number;
  /** Pieces handed to the sink before any cancel. */
  emitted(): number;
}
export interface StandInOptions {
  /** Audio length per character of text, in ms. Default 10. */
  msPerChar?: number;
  /** Length of each piece, in ms. Default 100. */
  pieceMs?: number;
  /** Delay between pieces, in ms. Default 1 (a source faster than real time). */
  gapMs?: number;
  behave?: (request: SpeechRequest, n: number) => StandInBehaviour;
  /** After a cancel, keep handing pieces to the sink until the line is done. */
  keepEmittingAfterCancel?: boolean;
}

export function createStandInSource(o: StandInOptions = {}): StandIn {
  const msPerChar = o.msPerChar ?? 10; const pieceBytes = Math.max(8, Math.floor((o.pieceMs ?? 100) * 8)); const gap = o.gapMs ?? 1;
  const requests: SpeechRequest[] = [];
  let started = 0; let cancelled = 0; let late = 0; let emitted = 0;
  return {
    requests,
    started: () => started, cancelled: () => cancelled, lateEmitted: () => late, emitted: () => emitted,
    start(request: SpeechRequest, sink: SpeechSink): SpeechHandle {
      const n = ++started;
      requests.push(request);
      const b = o.behave?.(request, n) ?? 'ok';
      let isCancelled = false;
      const handle: SpeechHandle = { cancel() { if (!isCancelled) { isCancelled = true; cancelled++; } } };
      if (b === 'fail-start') throw new Error('stand-in failed to start');
      const total = Math.max(1, request.text.length * msPerChar * 8);
      const piece = (): Uint8Array => new Uint8Array(pieceBytes).fill(0xff);
      const send = (u: Uint8Array): void => { if (isCancelled) late++; else emitted++; sink.chunk(u); };
      if (b === 'never') return handle;
      if (b === 'empty') { setTimeout(() => sink.end(), gap).unref?.(); return handle; }
      if (b === 'bad-audio') { setTimeout(() => sink.chunk('not bytes' as unknown as Uint8Array), gap).unref?.(); return handle; }
      if (b === 'huge') { setTimeout(() => sink.chunk(new Uint8Array(70_000)), gap).unref?.(); return handle; }
      if (b === 'burst') {   // everything at once, before `start` returns: all of it is queued when a cancel comes straight after
        for (let sent = 0; sent < total; sent += pieceBytes) send(piece());   // no end: the line is still active, with its audio queued
        return handle;
      }
      let sent = 0; let pieces = 0;
      const step = (): void => {
        if (isCancelled && o.keepEmittingAfterCancel !== true) return;
        if (typeof b === 'object' && 'stallAfter' in b && pieces >= b.stallAfter) return;                       // goes quiet: no more pieces, no end
        if (typeof b === 'object' && 'failAfter' in b && pieces >= b.failAfter) { sink.fail(); return; }       // an error part-way
        if (sent < total) { send(piece()); sent += pieceBytes; pieces++; setTimeout(step, gap).unref?.(); return; }
        sink.end();
      };
      setTimeout(step, gap).unref?.();
      return handle;
    },
  };
}
