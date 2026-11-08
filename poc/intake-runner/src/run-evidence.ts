// Two small pieces of EVIDENCE for the call log, so a call can be tied to the code that ran it and its confirmation steps can be read in order afterwards.
//
//   headCommit(read, gitDir)  the first 12 hex characters of the commit the repository's HEAD pointed at, read from the .git files (HEAD, the one ref file, packed-refs).
//                             No process is started, no environment variable is read, no other file is touched (never .git/config), and nothing is guessed: anything unreadable,
//                             malformed or oversize gives `undefined`. The hash is public (the repository is public). It says which commit was HEAD when the server started; it does
//                             NOT say the working tree was clean (an uncommitted edit would not show).
//   stepEvents(steps)         the call's step tokens, in order, as `{ n, s }`, each `s` a fixed code (`^[A-Z][A-Z_]{2,47}$`). Anything else is dropped, so nothing a caller said can reach the log.
//   logSteps(log, steps)      writes one FAST_STEP line per step. It NEVER throws: it is called while a call is ending, and logging must not interrupt the teardown.
//
// This file imports nothing and reads nothing itself: the caller hands it a reader for text files, so it is tested without a disk.

/** Reads a text file; returns undefined when it cannot. May throw (the code here copes). */
export type ReadText = (path: string) => string | undefined;

const HEX40 = /^[0-9a-f]{40}$/;
const REF = /^refs\/[A-Za-z0-9_.\/-]{1,200}$/;
const MAX_SMALL = 4096;
const MAX_PACKED = 2_000_000;
function readSafe(read: ReadText, path: string, max: number): string | undefined {
  try { const t = read(path); return typeof t === 'string' && t.length <= max ? t : undefined; } catch { return undefined; }
}

export function headCommit(read: ReadText, gitDir: string): string | undefined {
  try {
    if (typeof gitDir !== 'string' || gitDir === '' || typeof read !== 'function') return undefined;
    const head = readSafe(read, `${gitDir}/HEAD`, MAX_SMALL)?.trim();
    if (head === undefined) return undefined;
    if (HEX40.test(head)) return head.slice(0, 12);   // a detached HEAD holds the hash itself
    const m = /^ref: (\S+)$/.exec(head);
    if (m === null || !REF.test(m[1]) || m[1].includes('..') || m[1].includes('//')) return undefined;
    const loose = readSafe(read, `${gitDir}/${m[1]}`, MAX_SMALL)?.trim();
    if (loose !== undefined && HEX40.test(loose)) return loose.slice(0, 12);
    const packed = readSafe(read, `${gitDir}/packed-refs`, MAX_PACKED);
    if (packed === undefined) return undefined;
    for (const line of packed.split(/\r?\n/)) {
      const p = /^([0-9a-f]{40}) (\S+)$/.exec(line);
      if (p !== null && p[2] === m[1]) return p[1].slice(0, 12);
    }
    return undefined;
  } catch { return undefined; }
}

export interface StepEvent { n: number; s: string }
const STEP = /^[A-Z][A-Z_]{2,47}$/;
export const MAX_STEPS = 40;
/** The step tokens in their original order. `n` is the 1-based position in the original list, so a dropped entry leaves a visible gap. */
export function stepEvents(steps: unknown): StepEvent[] {
  try {
    if (!Array.isArray(steps)) return [];
    const out: StepEvent[] = [];
    for (let i = 0; i < steps.length && i < MAX_STEPS; i++) { const s: unknown = steps[i]; if (typeof s === 'string' && STEP.test(s)) out.push({ n: i + 1, s }); }
    return out;
  } catch { return []; }
}

/** One FAST_STEP line per step. Never throws, whatever the sink or the steps do. */
export function logSteps(log: (code: string, detail: Record<string, string | number | boolean>) => void, steps: unknown): void {
  try { for (const e of stepEvents(steps)) { try { log('FAST_STEP', { n: e.n, s: e.s }); } catch { /* one lost line must not stop the rest */ } } } catch { /* never interrupt a call's teardown */ }
}
