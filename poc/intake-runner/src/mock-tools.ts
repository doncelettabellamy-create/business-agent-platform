// Mock tool for the Processing proof of concept. In memory only: no network, no file, no process, no real side effect.
// Idempotent on the step id: a repeated step returns the same evidence and records no second write.
//
// The store of writes is PRIVATE to the closure. Two facets reach it:
//   - the tool (`scope`, `run`): what Processing is given, through the tool registry; it can write and read nothing back.
//   - the evidence reader (`reader`): what QC is given; read-only, and it needs a minted context that holds the reader's own
//     scope. It answers only for the context's tenant: another tenant's record is indistinguishable from "not found".
// `writes` and `calls` are test hooks on the composition object; the tool registry copies only `scope` and `run`, so neither
// Processing nor QC can reach them.

import { can, isTrusted } from './execution-context.ts';

export const MOCK_NOTE_SCOPE = 'tool:mock-note:write';
export const MOCK_NOTE_READ_SCOPE = 'tool:mock-note:read';

export interface EvidenceRecord { readonly evidence_ref: string; readonly step_id: string; readonly item_id: string; readonly workspace_id: string }
export interface EvidenceReader {
  /** The scope a context must hold to use this reader. */
  readonly scope: string;
  /** The record for this evidence ref in the context's tenant, or undefined. Rejects for an untrusted context or a missing scope. */
  read(ctx: unknown, evidenceRef: string): Promise<EvidenceRecord | undefined>;
  /** Every record for this item in the context's tenant (including writes no candidate mentions). */
  list(ctx: unknown, itemId: string): Promise<readonly EvidenceRecord[]>;
}
export interface MockNoteTool {
  readonly scope: string;
  run(args: Readonly<{ step_id: string; item_id: string; workspace_id: string }>, signal: AbortSignal): Promise<{ evidence_ref: string }>;
  readonly reader: EvidenceReader;
  /** Test hooks. */
  readonly writes: ReadonlyArray<EvidenceRecord>;
  readonly calls: () => number;
}

export function createMockNoteTool(scope: string = MOCK_NOTE_SCOPE, readScope: string = MOCK_NOTE_READ_SCOPE): MockNoteTool {
  const store: EvidenceRecord[] = [];
  const byStep = new Map<string, string>();
  let calls = 0;

  function allowed(ctx: unknown): string {
    if (!isTrusted(ctx) || !can(ctx, readScope)) throw new Error('reader not permitted');
    return ctx.workspace_id;
  }
  const reader: EvidenceReader = Object.freeze({
    scope: readScope,
    async read(ctx: unknown, evidenceRef: string) {
      const tenant = allowed(ctx);
      return store.find((r) => r.workspace_id === tenant && r.evidence_ref === evidenceRef);
    },
    async list(ctx: unknown, itemId: string) {
      const tenant = allowed(ctx);
      return store.filter((r) => r.workspace_id === tenant && r.item_id === itemId);
    },
  });

  return {
    scope,
    reader,
    get writes() { return store.slice(); },
    calls: () => calls,
    async run(args) {
      calls++;
      const key = `${args.workspace_id}\n${args.step_id}`;
      const seen = byStep.get(key);
      if (seen !== undefined) return { evidence_ref: seen };
      const ref = `mock-note:${args.step_id}`;
      store.push(Object.freeze({ evidence_ref: ref, step_id: args.step_id, item_id: args.item_id, workspace_id: args.workspace_id }));
      byStep.set(key, ref);
      return { evidence_ref: ref };
    },
  };
}

// ---------------------------------------------------------------- a tool whose answers the test controls
export interface DelayedNoteTool {
  readonly scope: string;
  run(args: Readonly<{ step_id: string; item_id: string; workspace_id: string }>, signal: AbortSignal): Promise<unknown>;
  /** Calls received. */
  readonly calls: () => number;
  /** Writes that actually landed. */
  readonly writes: ReadonlyArray<EvidenceRecord>;
  /** The abort signals of the calls received so far. */
  readonly signals: () => readonly AbortSignal[];
  /** A read-only view of the writes that actually landed, for Quality Control (tenant-scoped like the other mock reader). */
  readonly reader: EvidenceReader;
  /** Every pending call finishes now: the write lands and the call answers with evidence (a LATE write if its caller gave up). */
  land(): void;
  /** Every pending call answers, definitively, that it did not perform the action. */
  decline(): void;
  /** Every pending call fails with an error. */
  crash(): void;
}
/** Each call stays pending until the test lands, declines or crashes it, so a test can make a write arrive after a timeout. */
export function createDelayedNoteTool(scope: string = MOCK_NOTE_SCOPE): DelayedNoteTool {
  type Pending = { args: { step_id: string; item_id: string; workspace_id: string }; resolve: (v: unknown) => void; reject: (e: unknown) => void };
  const pending: Pending[] = [];
  const written: EvidenceRecord[] = [];
  const seen: AbortSignal[] = [];
  let calls = 0;
  const readScope = MOCK_NOTE_READ_SCOPE;
  const allowed = (ctx: unknown): string => { if (!isTrusted(ctx) || !can(ctx, readScope)) throw new Error('reader not permitted'); return ctx.workspace_id; };
  const reader: EvidenceReader = Object.freeze({
    scope: readScope,
    async read(ctx: unknown, evidenceRef: string) { const tenant = allowed(ctx); return written.find((r) => r.workspace_id === tenant && r.evidence_ref === evidenceRef); },
    async list(ctx: unknown, itemId: string) { const tenant = allowed(ctx); return written.filter((r) => r.workspace_id === tenant && r.item_id === itemId); },
  });
  return {
    scope,
    reader,
    run(args, signal) {
      calls++; seen.push(signal);
      return new Promise((resolve, reject) => { pending.push({ args: { ...args }, resolve, reject }); });
    },
    calls: () => calls,
    get writes() { return written.slice(); },
    signals: () => seen.slice(),
    land() {
      for (const p of pending.splice(0)) {
        const ref = `mock-note:${p.args.step_id}`;
        written.push(Object.freeze({ evidence_ref: ref, step_id: p.args.step_id, item_id: p.args.item_id, workspace_id: p.args.workspace_id }));
        p.resolve({ evidence_ref: ref });
      }
    },
    decline() { for (const p of pending.splice(0)) p.resolve({ not_performed: true }); },
    crash() { for (const p of pending.splice(0)) p.reject(new Error('late failure')); },
  };
}
