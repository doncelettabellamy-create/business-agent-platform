// The developer composition root for the live test path (proof of concept). It is the ONLY place in src/ that mints an
// execution context. Everything that makes a live run possible is decided here, not by the input file or the command line:
//
//   input     only a reviewed synthetic fixture whose content matches its pinned digest (src/reviewed-fixtures.ts)
//   tenant    the tenant named inside that pinned fixture; no flag or argument can choose another
//   authority DEVELOPER authority, minted from fixed mock sources: actor `system`/`dev-live-entry`, the `intake` agent,
//             and exactly one scope, `intake:run`. This script has no real authentication; this is not a real identity.
//   path      createIntakeEntry (fixed provider, registry, channel, clock, limits), which goes through the tenant boundary.
//             Nothing here calls the raw runners.
//
// This file creates no provider and makes no network call: the caller passes in a ModelProvider (a real one only after
// live-entry.ts has passed every live-call gate). It imports no file or process APIs.

import { randomUUID } from 'node:crypto';
import { isRecord } from './contracts.ts';
import { mintExecutionContext } from './execution-context.ts';
import { createIntakeEntry } from './intake-entry.ts';
import type { EntryResult } from './intake-entry.ts';
import type { ModelProvider } from './model-gateway.ts';
import { reviewedFixtureProblems } from './reviewed-fixtures.ts';
import { createTenantRegistry } from './tenant-boundary.ts';

export type LiveRunErrorCode = 'FIXTURE_NOT_REVIEWED' | 'DEV_SETUP_FAILED';
export interface LiveRunRefusal { ok: false; error: { code: LiveRunErrorCode; message: string } }
export type LiveRunResult = EntryResult | LiveRunRefusal;

const DEV_CHANNEL = 'channel-dev-live';
const TEXT: Record<LiveRunErrorCode, string> = {
  FIXTURE_NOT_REVIEWED: 'The input is not a reviewed synthetic fixture; nothing was sent.',
  DEV_SETUP_FAILED: 'The developer entry could not be set up; nothing was sent.',
};
function refuse(code: LiveRunErrorCode): LiveRunRefusal { return { ok: false, error: { code, message: TEXT[code] } }; }

export interface LiveRunRequest {
  /** The path as given (checked against the reviewed list). */
  path: string;
  /** The parsed file content. */
  input: unknown;
  provider: ModelProvider;
  maxOutputTokens: number;
  timeoutMs: number;
  /** Test hook only; defaults to the system clock. */
  now?: () => string;
}

export async function runReviewedLive(req: LiveRunRequest): Promise<LiveRunResult> {
  try {
    if (reviewedFixtureProblems(req.path, req.input).length > 0 || !isRecord(req.input) || !isRecord(req.input.skill_config)) {
      return refuse('FIXTURE_NOT_REVIEWED');
    }
    const { skill_config: config, ...message } = req.input as Record<string, unknown> & { skill_config: Record<string, unknown> };
    const tenant = message.workspace_id;
    if (typeof tenant !== 'string') return refuse('FIXTURE_NOT_REVIEWED');

    const registry = createTenantRegistry({ [tenant]: config as never });
    const entry = createIntakeEntry({
      registry,
      provider: req.provider,
      limits: { maxOutputTokens: req.maxOutputTokens, timeoutMs: req.timeoutMs, maxAttempts: 1 },
      channelRef: DEV_CHANNEL,
      now: req.now ?? (() => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')),
    });
    const minted = await mintExecutionContext({ credential: 'dev-live-entry', agent: 'intake' }, {
      verify: () => ({ kind: 'system', id: 'dev-live-entry' }),
      selectTenant: () => tenant,
      grants: () => ['intake:run'],
      newCorrelationId: () => `corr-synthetic-live-${randomUUID()}`,
    });
    if (!minted.ok) return refuse('DEV_SETUP_FAILED');
    return await entry.run(minted.context, message);
  } catch {
    return refuse('DEV_SETUP_FAILED');
  }
}
