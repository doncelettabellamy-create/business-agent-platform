// Private entry of a secret at the terminal (the OpenAI key for the connection check). The characters are read in raw mode and are NEVER echoed or written anywhere: not to the screen, a log, a file, the
// environment or the command line. The caller gets the value in memory only. Nothing is read unless the input is an interactive terminal, so a key cannot be piped in or left in a script by accident.
//
//   Enter ends the entry; Ctrl-C or Escape cancels; Backspace deletes; other control keys are ignored; at most 300 characters. A pasted value arrives in one piece and is handled the same way.
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
const MAX = 300;

/** Whether a string could be an API key by shape alone (plain header-safe characters, 8 to 300). Says nothing about whether it is valid. */
export const looksLikeKey = (s: unknown): s is string => typeof s === 'string' && KEY.test(s);

/**
 * Prompts for a secret. Resolves with the entered text, or undefined if the input is not an interactive terminal, the entry was cancelled, or it was empty.
 * The prompt text is written; the entry is not.
 */
export function readSecret(input: SecretInput, output: SecretOutput, prompt: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (input.isTTY !== true || typeof input.setRawMode !== 'function') { resolve(undefined); return; }
    let entry = '';
    let done = false;
    const finish = (value: string | undefined): void => {
      if (done) return;
      done = true;
      input.removeListener('data', onData);
      try { input.setRawMode?.(false); } catch { /* the terminal is gone */ }
      input.pause();
      output.write('\n');
      entry = '';
      resolve(value !== undefined && value.length > 0 ? value : undefined);
    };
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const ch of text) {
        if (done) return;
        if (ch === '\r' || ch === '\n') { finish(entry); return; }
        if (ch === '\u0003' || ch === '\u001b') { finish(undefined); return; }
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
