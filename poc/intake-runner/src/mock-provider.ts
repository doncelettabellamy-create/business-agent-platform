// Local mock model provider for tests and the demonstration. It is scripted: it returns exactly what the caller
// tells it to. It is NOT a model, makes no network calls, needs no key, and understands no text.
//
// It records every request it receives so tests can check what a provider would be sent.

import type { ModelProvider, ModelRequest, ModelResponse, ModelTask } from './model-gateway.ts';

export type MockHandler = (request: ModelRequest, signal: AbortSignal, call: number) => string | Promise<string>;

export interface MockProvider extends ModelProvider {
  /** Every request received, in order. */
  readonly calls: ModelRequest[];
}

export function createMockProvider(handlers: Partial<Record<ModelTask, MockHandler>>, id = 'mock-local'): MockProvider {
  const calls: ModelRequest[] = [];
  const counts: Record<string, number> = {};
  return {
    id,
    calls,
    async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
      calls.push(structuredClone(request));
      counts[request.task] = (counts[request.task] ?? 0) + 1;
      const handler = handlers[request.task];
      if (!handler) throw new Error('mock has no handler for this task');
      return { text: await handler(request, signal, counts[request.task]) };
    },
  };
}

/** A handler that never answers until the gateway aborts it (used to test timeouts). */
export const hangs: MockHandler = (_request, signal) =>
  new Promise<string>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  });

/** Builds the JSON text a well-behaved classifier would return. */
export function classifyAnswer(category: string | null, confidence: number | null): string {
  return JSON.stringify({ category, confidence });
}
/** Builds the JSON text a well-behaved extractor would return. */
export function extractAnswer(fields: { name: string; value: string | null; confidence: number | null }[]): string {
  return JSON.stringify({ fields });
}
