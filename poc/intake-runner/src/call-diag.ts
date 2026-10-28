// Durable, privacy-safe diagnostics for a phone call: FIXED CODES and numbers only. Nothing here can carry what anyone said, an address, a key, a header, a phone number or a name: a detail value is kept only if
// it is a finite number, a boolean, or a short string made of letters, digits and `_ . : -`; anything else is dropped (not truncated, dropped). A code must look like CODE_NAME. Lines are written to a file by
// the command line (founder-voice-entry.ts), so a call can be reconstructed afterwards without depending on what a console shows or hides.
//
//   scopedDiag(sink, call, now)   one call's view of the sink: every line gets the call's number and the milliseconds since the call began, so the order and the gaps (a 5-second timer, a 28-second notice) read straight
//                                 off the log;
//   fileDiagSink(...)             turns (code, detail) into one line: `2026-10-27T20:53:01Z CODE {"call":2,"ms":4012,"status":"completed"}`.
// This file imports nothing and reads no environment variable.

export type DiagDetail = Record<string, string | number | boolean>;
export type DiagSink = (code: string, detail?: Record<string, unknown>) => void;
export const noDiag: DiagSink = () => {};

const CODE = /^[A-Z][A-Z0-9_]{2,47}$/;
const KEY = /^[a-z][A-Za-z0-9_]{0,24}$/;
const VALUE = /^[A-Za-z0-9_.:-]{1,48}$/;
const MAX_FIELDS = 16;

/** Keeps only what is safe: numbers, booleans and short plain tokens. Never throws. Pure. */
export function cleanDetail(detail: unknown): DiagDetail {
  const out: DiagDetail = {};
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
    if (n >= MAX_FIELDS) break;
    if (!KEY.test(k)) continue;
    if (typeof v === 'number') { if (Number.isFinite(v)) { out[k] = Math.trunc(v * 10) / 10; n++; } }
    else if (typeof v === 'boolean') { out[k] = v; n++; }
    else if (typeof v === 'string' && VALUE.test(v)) { out[k] = v; n++; }
  }
  return out;
}

/** One call's view of a sink: adds the call's number and the milliseconds since this call began. A bad code is dropped. */
export function scopedDiag(sink: DiagSink, call: number, now: () => number = Date.now): DiagSink {
  const began = now();
  return (code, detail) => {
    if (typeof code !== 'string' || !CODE.test(code)) return;
    try { sink(code, { ...cleanDetail(detail), call, ms: Math.max(0, now() - began) }); } catch { /* diagnostics never throw into a call */ }
  };
}

/** The sink that writes lines: `<time> <CODE> <json>`. `append` is the only way out (a file in the command line, a list in tests). */
export function fileDiagSink(io: { append(line: string): void; nowIso(): string; echo?(line: string): void }): DiagSink {
  return (code, detail) => {
    if (typeof code !== 'string' || !CODE.test(code)) return;
    const line = `${io.nowIso()} ${code} ${JSON.stringify(cleanDetail(detail))}`;
    try { io.append(line + '\n'); } catch { /* a full disk must not end a call */ }
    try { io.echo?.(line); } catch { /* nor must a closed console */ }
  };
}
