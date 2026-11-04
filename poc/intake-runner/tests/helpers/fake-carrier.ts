// A stand-in carrier for the fast call handler: it records every line the handler speaks, lets the test decide when (and how) each line finishes playing, and feeds in the caller's utterances.
import type { CallTransport, TransportEvent } from '../../src/call-transport.ts';

export type Verdict = 'played' | 'cut' | 'timeout';
export function fakeCarrier(opts: { measures?: boolean } = {}) {
  const spoken: string[] = []; const speakOpts: Array<{ interruptible?: boolean } | undefined> = []; const waiting: Array<(v: Verdict) => void> = []; let ended = 0; let closed = 0; let cursor = 0;
  const transport: CallTransport = {
    onEvent: () => undefined, onClose: () => undefined,
    speak(token: string, _last?: boolean, options?: { interruptible?: boolean }): boolean { spoken.push(token); speakOpts.push(options); return true; },
    ...(opts.measures === false ? {} : { playbackDone: (_max: number): Promise<Verdict> => new Promise((res) => { waiting.push(res); }) }),
    endCall(): boolean { ended++; return true; },
    close(): void { closed++; transport.onClose(); },
  };
  const until = async (cond: () => boolean, label = 'condition', ms = 3000): Promise<void> => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}; spoken so far: ${spoken.length}; playbacks pending: ${waiting.length}; last lines: ${JSON.stringify(spoken.slice(-3).map((l) => l.slice(0, 60)))}`); await new Promise((r) => setTimeout(r, 2)); } };
  const api = {
    transport, spoken, /** The options each spoken line was handed over with, in the same order as `spoken`. */ speakOpts, get ended() { return ended; }, get closed() { return closed; }, pending: (): number => waiting.length,
    emit(ev: TransportEvent): void { transport.onEvent(ev); },
    /** Every line handed over so far has now finished playing with this verdict. */
    finish(v: Verdict = 'played'): void { for (const r of waiting.splice(0)) r(v); },
    until,
    /** Waits for the handler to speak a line matching `re` (after the last one this helper matched), lets what is playing finish, then the caller answers. `early` answers BEFORE the line has finished. */
    async hears(re: RegExp, reply: string | undefined, o: { early?: boolean; verdict?: Verdict } = {}): Promise<string> {
      await until(() => spoken.slice(cursor).some((l) => re.test(l)), `a line matching ${re}`);
      const idx = spoken.findIndex((l, i) => i >= cursor && re.test(l)); cursor = idx + 1; const line = spoken[idx];
      await until(() => waiting.length > 0, 'the line to be playing');
      if (o.early && reply !== undefined) { api.emit({ kind: 'utterance', text: reply }); await new Promise((r) => setTimeout(r, 5)); api.finish(o.verdict ?? 'played'); }
      else { api.finish(o.verdict ?? 'played'); await new Promise((r) => setTimeout(r, 5)); if (reply !== undefined) api.emit({ kind: 'utterance', text: reply }); }
      return line;
    },
    /** Lets lines that need no answer finish playing, until `cond` holds. */
    async drain(cond: () => boolean, label = 'the call to finish'): Promise<void> { const t0 = Date.now(); while (!cond()) { api.finish('played'); if (Date.now() - t0 > 3000) throw new Error(`timed out waiting for ${label}`); await new Promise((r) => setTimeout(r, 3)); } },
    /** The call is set up (the greeting, which asks for the name, has been played by the carrier); the caller then says `first` (the answer to it), unless it is null. */
    setup(to: string, callSid = `CA${'ab'.repeat(16)}`, first: string | null = null): void { api.emit({ kind: 'setup', to, callSid }); if (first !== null) api.emit({ kind: 'utterance', text: first }); },
    hangUp(): void { transport.onClose(); },
    get lines(): string[] { return spoken.slice(); },
  };
  return api;
}
