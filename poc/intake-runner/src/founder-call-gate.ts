// The safety gate for the founder phone test (proof of concept). PURE: no I/O, no environment access, no network. The composition root
// (founder-call-entry.ts) reads the file and the environment and passes in what it read.
//
// A real call needs ALL of:
//   - the approved config file passes every check below (one named tenant, listed numbers, an exact model, small caps, a short expiry);
//   - INTAKE_ALLOW_LIVE_CALLS=yes in the environment (the same switch as the synthetic live path);
//   - FOUNDER_CALL_APPROVED_DIGEST equal to the digest of THAT config. The founder gets the digest from the dry run and sets it
//     deliberately; changing any value in the config changes the digest, so an edited config is not approved until it is approved again;
//   - the Twilio auth token present (needed to check the phone provider's signature);
//   - the approval has not expired (at most 30 days out).
// Nothing here relaxes the synthetic-only entry or the reviewed-fixture path; those stay as they are for everything else.

import { isRecord } from './contracts.ts';
import { validateSkillConfig } from './classify-extract.ts';
import { isClaudeModelId } from './claude-provider.ts';
import { fixtureDigest } from './reviewed-fixtures.ts';
import { PRICES_PER_MILLION } from './cost-estimate.ts';
import { openingProblems } from './opening.ts';
import type { Opening } from './opening.ts';

export const MAX_APPROVAL_DAYS = 30;
const E164 = /^\+[1-9][0-9]{6,14}$/;
/** The public address ends in /relay/ plus a long random secret. Twilio's handshake signature is the same for every call, so the secret path is the second factor. */
const WSS = /^wss:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(\/relay\/[A-Za-z0-9_-]{32,64})$/;
const PLACEHOLDER_VALUE = /YOUR-TUNNEL-HOST|REPLACE|example\.(?:com|test|org)|\.example(?:[:/]|$)/i;
const PLACEHOLDER_NUMBER = /^\+1\d{3}555(?:01\d{2})$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export interface FounderCallConfig {
  approval_id: string;
  tenant: string;
  numbers: string[];
  model: string;
  max_minutes: number;
  max_turns: number;
  max_claude_calls: number;
  /** How many calls may be accepted in one serve run; after that every setup is refused. Bounds what a leaked path and signature could do. */
  max_calls: number;
  expires: string;
  persona_names: string[];
  kill_file: string;
  public_wss_url: string;
  db_path: string;
  relay_port: number;
  dashboard_port: number;
  after_speech_ms: number;
  skill_config: unknown;
  /** Optional. How the call opens: the business and agent introduced, the disclosure, and a special only if the business approved one (opening.ts). Part of the approval digest. */
  opening?: Opening;
}
const KEYS = 'after_speech_ms,approval_id,dashboard_port,db_path,expires,kill_file,max_calls,max_claude_calls,max_minutes,max_turns,model,numbers,persona_names,public_wss_url,relay_port,skill_config,tenant';

const int = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const plainPath = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 260 && !v.includes('\0');

/** Problems with the config itself. Fixed text; no value from the file is echoed. */
export function founderConfigProblems(cfg: unknown): string[] {
  const p: string[] = [];
  if (!isRecord(cfg)) return ['config must be an object'];
  // The expected keys, plus the one optional key `opening`. Anything else is refused.
  const given = Object.keys(cfg).sort().join(',');
  if (given !== KEYS && given !== [...KEYS.split(','), 'opening'].sort().join(',')) p.push('config must have exactly the expected keys');
  if ('opening' in cfg) for (const m of openingProblems((cfg as Record<string, unknown>).opening)) p.push(m);
  const c = cfg as Record<string, unknown>;
  if (typeof c.approval_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(c.approval_id)) p.push('approval_id must be an id-like string');
  if (typeof c.tenant !== 'string' || !/^ws-founder-[A-Za-z0-9_.:-]{1,50}$/.test(c.tenant)) p.push('tenant must begin ws-founder-');
  if (!Array.isArray(c.numbers) || c.numbers.length < 1 || c.numbers.length > 3 || !c.numbers.every((n) => typeof n === 'string' && E164.test(n))) p.push('numbers must be 1 to 3 E.164 numbers');
  if (!isClaudeModelId(c.model)) p.push('model must be an exact Claude model id such as claude-haiku-5-5');
  if (!int(c.max_minutes, 1, 10)) p.push('max_minutes must be 1 to 10');
  if (!int(c.max_turns, 1, 30)) p.push('max_turns must be 1 to 30');
  if (!int(c.max_claude_calls, 1, 300)) p.push('max_claude_calls must be 1 to 300');
  if (typeof c.expires !== 'string' || !TIME.test(c.expires) || Number.isNaN(Date.parse(c.expires))) p.push('expires must be a UTC timestamp');
  if (!Array.isArray(c.persona_names) || c.persona_names.length > 20 || !c.persona_names.every((n) => typeof n === 'string' && n.trim().length >= 2 && n.length <= 60)) p.push('persona_names must be a list of up to 20 names');
  if (!plainPath(c.kill_file)) p.push('kill_file must be a path');
  if (typeof c.public_wss_url !== 'string' || !WSS.test(c.public_wss_url)) p.push('public_wss_url must be a wss:// address ending /relay/ and a random secret of 32 to 64 letters, digits, - or _');
  if (!int(c.max_calls, 1, 10)) p.push('max_calls must be 1 to 10');
  if (!plainPath(c.db_path)) p.push('db_path must be a path');
  if (!int(c.relay_port, 1024, 65535) || !int(c.dashboard_port, 1024, 65535) || c.relay_port === c.dashboard_port) p.push('relay_port and dashboard_port must be different ports from 1024 to 65535');
  if (!int(c.after_speech_ms, 0, 10_000)) p.push('after_speech_ms must be 0 to 10000');
  if (validateSkillConfig(c.skill_config).length > 0) p.push('skill_config is not a valid skill configuration');
  return p;
}

export function founderConfigDigest(cfg: unknown): string { return fixtureDigest(cfg); }

export interface GateInput {
  config: unknown;
  /** What the composition root read from the environment. */
  env: { allowLive: string | undefined; approvedDigest: string | undefined; twilioTokenPresent: boolean };
  nowIso: string;
}
/** Empty means a live call may start. */
export function founderGateProblems(input: GateInput): string[] {
  const p = founderConfigProblems(input.config);
  if (p.length > 0) return p;
  const c = input.config as FounderCallConfig;
  if (PLACEHOLDER_VALUE.test(c.public_wss_url) || c.numbers.some((n) => PLACEHOLDER_NUMBER.test(n))) p.push('the config still has placeholder values (number, address or secret path)');
  if (input.env.allowLive !== 'yes') p.push('INTAKE_ALLOW_LIVE_CALLS=yes is not set');
  if (!input.env.twilioTokenPresent) p.push('the Twilio auth token is not set');
  if (input.env.approvedDigest !== founderConfigDigest(c)) p.push('FOUNDER_CALL_APPROVED_DIGEST does not match this config');
  const now = Date.parse(input.nowIso); const exp = Date.parse(c.expires);
  if (!(exp > now)) p.push('the approval has expired');
  else if (exp - now > MAX_APPROVAL_DAYS * 86_400_000) p.push(`the approval may not run more than ${MAX_APPROVAL_DAYS} days`);
  return p;
}

/** Hard upper bound on Claude spend for the whole approval, in USD: every allowed call using a large input and its whole output budget. */
export function claudeCeilingUsd(model: string, maxCalls: number): number | null {
  const price = PRICES_PER_MILLION[model];
  if (price === undefined) return null;
  return maxCalls * ((3000 * price.input + 4096 * price.output) / 1_000_000);
}

/** The secret request path the WebSocket server answers on (the part of the public address after the host). Call only with a valid config. */
export function relayPathFor(publicWssUrl: string): string {
  const m = WSS.exec(publicWssUrl);
  if (m === null) throw new RangeError('public_wss_url is not valid');
  return m[1];
}

/**
 * The URL forms Twilio may have signed for the WebSocket handshake (see ws-server.ts). Twilio's pages do not say which scheme the handshake
 * signature covers, and note that a failed WebSocket validation may be fixed by appending a trailing "/". So the candidates are the address as
 * configured and its https form, each with and without a trailing slash; when the address names a port, the same four without it (Twilio drops
 * the port when signing voice requests over HTTPS). They all derive from the one configured address, so they add no new path or host.
 * The server still answers only on the exact secret path.
 */
export function signedUrlCandidates(publicWssUrl: string): string[] {
  const bases = [publicWssUrl];
  const noPort = publicWssUrl.replace(/^(wss:\/\/[^/:]+):\d+(?=\/)/, '$1');
  if (noPort !== publicWssUrl) bases.push(noPort);
  const out: string[] = [];
  for (const base of bases) {
    const https = base.replace(/^wss:/, 'https:');
    for (const form of [base, https, `${base}/`, `${https}/`]) if (!out.includes(form)) out.push(form);
  }
  return out;
}
