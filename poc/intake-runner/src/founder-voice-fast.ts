// Composition glue for the controlled FAST test call (voice config `fast_test`). It joins the pieces that already exist (the Jobber connector and its test-account booking adapter, the Twilio helpers, the fast call handler)
// and names no call logic. Like founder-voice-speaker.ts it is built only by the composition root, only after the whole gate passed, and it reads nothing but what is handed in: the private folder (credentials, tokens
// and the approved test numbers, all protected for this Windows user), the environment object, and fetch.
//
// The approved test numbers and the Twilio account id are PRIVATE: they live only in the protected file `test-numbers` (written by the founder through the private setup, never in the repository or the config). A call from
// any other number gets one line and nothing is collected; a text goes to no other number; the Jobber test account is pinned by name and id before every write.

import { createVault, JOBBER_ENDPOINTS, GRAPHQL_VERSION, readBusyIntervals } from './jobber-connector.ts';
import type { Protector, FetchLike, Ctx as JobberCtx } from './jobber-connector.ts';
import { bookTestVisit } from './jobber-booking.ts';
import { callerOf, E164, sendSms, SID, verifyDelivery } from './twilio-messaging.ts';
import type { HttpFetch, TwilioCtx } from './twilio-messaging.ts';
import type { FastDeps } from './fast-call-handler.ts';
import { appendConsent, ownerConsentOn } from './fast-consent.ts';
import { fastSettingsOf } from './founder-voice-gate.ts';
import type { FounderVoiceConfig } from './founder-voice-gate.ts';
import type { FounderCallConfig } from './founder-call-gate.ts';

/** The private, protected record of the approved test numbers and the Twilio account id. */
export interface TestNumbers { account_sid: string; customer: string; owner: string }
export const NUMBERS_BLOB = 'test-numbers';
export const isTestNumbers = (x: unknown): x is TestNumbers => typeof x === 'object' && x !== null && SID.test(String((x as TestNumbers).account_sid)) && E164.test(String((x as TestNumbers).customer)) && E164.test(String((x as TestNumbers).owner)) && (x as TestNumbers).customer !== (x as TestNumbers).owner;

export interface FastComposition {
  config: FounderCallConfig; voice: FounderVoiceConfig;
  vaultDir: string; protector: Protector;
  /** Read for TWILIO_AUTH_TOKEN (at each request) and JOBBER_ALLOW_WRITES. Pass process.env. */
  env: Record<string, string | undefined>;
  fetch: typeof globalThis.fetch;
  now(): number;
  log(code: string, detail?: Record<string, string | number | boolean>): void;
  onOutcome?: FastDeps['onOutcome'];
  /** Test hooks: other addresses for the two services. */
  jobberEndpoints?: typeof JOBBER_ENDPOINTS; twilioOrigin?: string;
  textFrom?: string;
}

export async function loadTestNumbers(vault: ReturnType<typeof createVault>): Promise<TestNumbers | undefined> {
  const t = await vault.loadBlob(NUMBERS_BLOB); if (t === undefined) return undefined;
  try { const j = JSON.parse(t) as unknown; return isTestNumbers(j) ? j : undefined; } catch { return undefined; }
}
/** Presence only, for the gate and the dry run: are the private pieces in place? Nothing is printed and nothing leaves the machine. */
export async function fastStatus(c: Pick<FastComposition, 'vaultDir' | 'protector' | 'env'>): Promise<{ numbersPresent: boolean; textsOn: boolean; ownerConsent: boolean; jobberConnected: boolean; jobberWritesOn: boolean }> {
  const vault = createVault(c.vaultDir, c.protector); const nums = await loadTestNumbers(vault);
  const textsOn = c.env.FAST_TEXTS === 'on';   // texts are OFF unless this exact word is set
  return { numbersPresent: nums !== undefined, textsOn, ownerConsent: nums !== undefined && (await ownerConsentOn(vault, nums.owner)), jobberConnected: (await vault.loadTokens()) !== undefined && (await vault.loadCredentials()) !== undefined, jobberWritesOn: c.env.JOBBER_ALLOW_WRITES === 'test-account' };
}

/** The fast call handler's dependencies, wired to Jobber and Twilio. Throws when a private piece is missing (the gate has already checked, so this is a second line). */
export async function buildFastDeps(c: FastComposition): Promise<FastDeps> {
  const f = c.voice.fast_test; const settings = c.config.opening?.business_name === undefined ? undefined : fastSettingsOf(c.voice, c.config.opening.business_name);
  if (f === undefined || settings === undefined) throw new RangeError('the voice config has no fast_test section, or the call config has no opening with a business name');
  const vault = createVault(c.vaultDir, c.protector);
  const numbers = await loadTestNumbers(vault); const creds = await vault.loadCredentials();
  if (numbers === undefined || creds === undefined || (await vault.loadTokens()) === undefined) throw new RangeError('the approved test numbers or the Jobber connection are missing');
  const from = c.textFrom ?? c.config.numbers[0]; const textsEnabled = c.env.FAST_TEXTS === 'on';
  const jobber: JobberCtx = { vault, endpoints: c.jobberEndpoints ?? JOBBER_ENDPOINTS, fetch: c.fetch as unknown as FetchLike, now: c.now, diag: (code, detail) => c.log(code, detail), version: c.env.JOBBER_GRAPHQL_VERSION ?? GRAPHQL_VERSION,
    ...(c.env.JOBBER_ALLOW_WRITES === 'test-account' ? { allowWrites: { expectedAccountName: f.jobber_account_name } } : {}) };
  const twilio: TwilioCtx = { accountSid: numbers.account_sid, authToken: () => c.env.TWILIO_AUTH_TOKEN, fetch: c.fetch as unknown as HttpFetch, diag: (code, detail) => c.log(code, detail), approved: new Set([numbers.customer, numbers.owner]), ...(c.twilioOrigin === undefined ? {} : { origin: c.twilioOrigin }) };
  return {
    settings, numbers: new Set(c.config.numbers), approvedCallers: new Set([numbers.customer]), approvedCustomerNumbers: new Set([numbers.customer]), ownerNumber: numbers.owner, maxCalls: c.config.max_calls,
    now: c.now, log: c.log, ...(c.onOutcome === undefined ? {} : { onOutcome: c.onOutcome }),
    callerOf: (sid) => callerOf(twilio, sid),
    busy: (fromIso, toIso) => readBusyIntervals(jobber, creds, fromIso, toIso),
    book: (req) => bookTestVisit(jobber, creds, req),
    textsEnabled,
    // With texts off nothing is wired to Twilio's message endpoint at all: a send is refused here, before any request.
    sendText: textsEnabled ? (to, body) => sendSms(twilio, { from, to, body }) : async () => ({ ok: false, error: 'REFUSED' as const }),
    ownerConsent: textsEnabled && (await ownerConsentOn(vault, numbers.owner)),
    recordConsent: !textsEnabled ? async () => false : (e) => appendConsent(vault, { v: 1, role: 'customer', at: new Date(c.now()).toISOString(), method: 'call_verbal', script: e.script, result: e.result, ref: e.ref }),
    verifyText: (sid) => verifyDelivery(twilio, sid),
  };
}
