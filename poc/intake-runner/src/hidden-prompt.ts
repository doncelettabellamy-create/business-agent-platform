// Private entry of a secret at the terminal (the OpenAI key for the connection check). The characters are read in raw mode and are NEVER echoed or written anywhere: not to the screen, a log, a file, the
// environment or the command line. The caller gets the value in memory only. Nothing is read unless the input is an interactive terminal, so a key cannot be piped in or left in a script by accident.
//
// What it copes with, because real Windows terminals do all of these (found when a pasted key was repeatedly rejected):
//   * a stray Enter left over from the previous prompt (the confirmation typed just before it): an Enter with nothing entered yet is ignored, never taken as an empty answer;
//   * a paste, which arrives as one chunk (or one character at a time), possibly wrapped in the bracketed-paste markers ESC[200~ and ESC[201~, which are skipped even when split across chunks, and followed by CR, LF or CRLF;
//   * Ctrl+V, which in a raw console arrives as a control character and pastes nothing: a fixed hint is written (it contains no secret) and the entry carries on;
//   * cursor and function keys (escape sequences), which are skipped, while a lone Escape cancels;
//   * Ctrl-C cancels; Backspace deletes; other control keys are ignored; at most 1000 characters are kept so that a too-long paste is reported as too long rather than silently cut.
// The value that comes back is the raw text typed or pasted, minus control characters. Cleaning and checking it is `normalizeKeyEntry`, which reports the KIND of problem and the length, never a character.
// The stream is taken from the caller (process.stdin in the entry, a fake in tests), so this file reads no environment variable and imports nothing.

export interface SecretInput {
  isTTY?: boolean;
  setRawMode?(on: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  removeListener(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}
export interface SecretOutput { write(text: string): unknown }

const KEY = /^[A-Za-z0-9_.-]{8,300}$/;
const MAX = 1000;
export const PASTE_HINT = '(nothing received yet: paste with a right-click, then press Enter. Ctrl+V does not paste here. Esc cancels.)\n';

/** Whether a string could be an API key by shape alone (plain header-safe characters, 8 to 300). Says nothing about whether it is valid. */
export const looksLikeKey = (s: unknown): s is string => typeof s === 'string' && KEY.test(s);

export type KeyProblem = 'empty' | 'too_short' | 'too_long' | 'bad_characters';
/**
 * Cleans what was typed or pasted and says whether it could be a key. It removes control, zero-width and byte-order-mark characters, surrounding whitespace and one pair of surrounding quotes (a copy from a page
 * often brings them). On a problem it reports the kind and the LENGTH only: never a character of the entry. Pure.
 */
export function normalizeKeyEntry(raw: unknown): { key?: string; problem?: KeyProblem; length: number } {
  if (typeof raw !== 'string') return { problem: 'empty', length: 0 };
  let s = raw.replace(/[\u0000-\u001f\u007f​-‍⁠﻿]/g, '').trim();
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) s = s.slice(1, -1).trim();
  if (s.length === 0) return { problem: 'empty', length: 0 };
  if (!/^[A-Za-z0-9_.-]+$/.test(s)) return { problem: 'bad_characters', length: s.length };
  if (s.length < 8) return { problem: 'too_short', length: s.length };
  if (s.length > 300) return { problem: 'too_long', length: s.length };
  return { key: s, length: s.length };
}

/**
 * Prompts for a secret. Resolves with the entered text (raw: see normalizeKeyEntry), or undefined if the input is not an interactive terminal or the entry was cancelled.
 * The prompt text is written; the entry is not.
 */
export function readSecret(input: SecretInput, output: SecretOutput, prompt: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (input.isTTY !== true || typeof input.setRawMode !== 'function') { resolve(undefined); return; }
    let entry = '';
    let done = false;
    let hinted = false;
    let skipping: 'none' | 'csi' | 'ss3' = 'none';   // inside a control sequence: it can arrive split across chunks, so this outlives one chunk
    const finish = (value: string | undefined): void => {
      if (done) return;
      done = true;
      input.removeListener('data', onData);
      try { input.setRawMode?.(false); } catch { /* the terminal is gone */ }
      input.pause();
      output.write('\n');
      entry = '';
      resolve(value);
    };
    const hint = (): void => { if (!hinted) { hinted = true; output.write(PASTE_HINT); } };
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const chars = [...text];
      for (let i = 0; i < chars.length; i++) {
        if (done) return;
        const ch = chars[i];
        if (skipping === 'csi') { if (ch >= '@' && ch <= '~') skipping = 'none'; continue; }   // parameters, then one final byte
        if (skipping === 'ss3') { skipping = 'none'; continue; }
        if (ch === '\r' || ch === '\n') {
          if (entry.length === 0) { hint(); continue; }   // a leftover Enter from the previous prompt, or Enter pressed too soon: not an answer
          finish(entry); return;
        }
        if (ch === '\u0003') { finish(undefined); return; }
        if (ch === '\u001b') {
          const next = chars[i + 1];
          if (next === '[') { skipping = 'csi'; i++; continue; }   // arrow keys, bracketed-paste markers and the like: skipped whole
          if (next === 'O') { skipping = 'ss3'; i++; continue; }   // an application-mode function key
          finish(undefined); return;   // a lone Escape
        }
        if (ch === '\u0016') { if (entry.length === 0) hint(); continue; }   // Ctrl+V arrives as a key, not a paste
        if (ch === '\u007f' || ch === '\b') { entry = entry.slice(0, -1); continue; }
        if (ch < ' ') continue;
        if (entry.length < MAX) entry += ch;
      }
    };
    output.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}
