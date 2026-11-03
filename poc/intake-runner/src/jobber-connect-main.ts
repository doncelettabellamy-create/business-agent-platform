// Entry point for the standalone Jobber connector (proof of concept; the founder's Jobber DEVELOPER TEST ACCOUNT; READ-ONLY). Nothing else imports this file.
//
//   node src/jobber-connect-main.ts save-credentials            reads {"client_id": "...", "client_secret": "..."} from STANDARD INPUT (use jobber-enter-credentials.ps1: it prompts privately) and stores them protected
//   node src/jobber-connect-main.ts callback-url [--port N]     prints the exact OAuth Callback URL to enter in the Jobber Developer Center
//   node src/jobber-connect-main.ts authorize --expect-name "<account name>" [--port N]
//                                                               opens the Jobber approval page in the browser, waits for the redirect on this machine, checks the account name BEFORE storing anything
//   node src/jobber-connect-main.ts check --expect-name "<account name>"
//                                                               reads the account, refuses on any mismatch, then reads the schedule (counts only)
//   node src/jobber-connect-main.ts schema [--type NAME]        read-only schema discovery (field and argument NAMES only)
//   node src/jobber-connect-main.ts status                      whether tokens are stored and when the access token expires (no token is shown)
//   node src/jobber-connect-main.ts forget                      deletes the stored TOKENS on this machine (it does not tell Jobber; disconnect the app in Jobber to revoke it there)
//
// The private folder is JOBBER_STORE_DIR, or ".drew-jobber" in the user's home folder (outside the repository). Secrets are never printed.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { callbackUrlFor, createVault, DEFAULT_CALLBACK_PORT, GRAPHQL_VERSION, JOBBER_ENDPOINTS, JobberError, query, readAccount, readSchedule, startAuthorization, verifyExpectedAccount } from './jobber-connector.ts';
import type { Ctx, Credentials, FetchLike } from './jobber-connector.ts';
import { copyToClipboard, openInEdge } from './jobber-browser.ts';
import { windowsProtector } from './jobber-dpapi.ts';

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const port = opt('port') === undefined ? DEFAULT_CALLBACK_PORT : Number(opt('port'));
const say = (s: string): void => { console.log(s); };

const vault = createVault(process.env.JOBBER_STORE_DIR ?? join(homedir(), '.drew-jobber'), windowsProtector());
const ctx: Ctx = { vault, endpoints: JOBBER_ENDPOINTS, fetch: globalThis.fetch as unknown as FetchLike, now: () => Date.now(), diag: (code, detail) => { if (process.env.JOBBER_DIAG === '1') console.error(code, detail ?? ''); }, version: process.env.JOBBER_GRAPHQL_VERSION ?? GRAPHQL_VERSION };

const readStdin = (): Promise<string> => new Promise((ok) => { const b: Buffer[] = []; process.stdin.on('data', (x) => b.push(x)); process.stdin.on('end', () => ok(Buffer.concat(b).toString('utf8').replace(/^﻿/, ''))); });   // PowerShell may prefix a byte-order mark
const needCreds = async (): Promise<Credentials> => { const c = await vault.loadCredentials(); if (c === undefined) throw new JobberError('NO_CREDENTIALS'); return c; };
/** Opens the approval page in Microsoft Edge; if that fails the reason is printed (a fixed code) and the link goes to the clipboard, never to the screen. */
const openBrowser = async (url: string): Promise<void> => {
  const r = await openInEdge(url);
  if (r.launched) { say('Microsoft Edge was asked to open the Jobber approval page in a new tab.'); return; }
  say(`could not open Microsoft Edge (${r.reason}).`);
  say((await copyToClipboard(url)) ? 'The approval link was copied to your clipboard (not shown). Paste it into Edge within 10 minutes.' : 'The link could not be copied either; stop this attempt and tell Claude.');
};

async function main(): Promise<number> {
  if (cmd === 'callback-url') { say(callbackUrlFor(port)); return 0; }
  if (cmd === 'save-credentials') {
    let j: unknown; try { j = JSON.parse(await readStdin()); } catch { say('refused: the input was not the expected JSON'); return 2; }
    const c = j as Credentials;
    await vault.saveCredentials({ client_id: String(c?.client_id ?? '').trim(), client_secret: String(c?.client_secret ?? '').trim() });
    say('saved: the Jobber credentials are stored protected for this Windows user (nothing was printed)'); return 0;
  }
  if (cmd === 'status') {
    const t = await vault.loadTokens(); const c = await vault.loadCredentials();
    say(`credentials stored: ${c !== undefined}`); say(`tokens stored: ${t !== undefined}`);
    if (t !== undefined) { say(`connected account: ${t.account_name}`); say(`access token valid for about ${Math.max(0, Math.round((t.expires_at - Date.now()) / 60000))} minutes (it is refreshed automatically)`); }
    return 0;
  }
  if (cmd === 'forget') { vault.clearTokens(); say('the stored tokens on this machine were deleted (disconnect the app in Jobber to revoke it there too)'); return 0; }
  const creds = await needCreds();
  if (cmd === 'authorize') {
    const expected = opt('expect-name'); if (expected === undefined) { say('refused: --expect-name "<account name>" is required, so tokens for the wrong account are never stored'); return 2; }
    const s = await startAuthorization({ ctx, creds, port, expectedAccountName: expected });
    say(`Listening on this machine only. Callback URL in use: ${s.callbackUrl}`);
    say('Sign in as the test account admin and click Allow Access.');
    await openBrowser(s.url);
    const r = await s.done;
    say(`CONNECTED to the expected account: ${r.account.name}`); say(`access token expires in about ${Math.round((r.expiresAt - Date.now()) / 60000)} minutes and is refreshed automatically`); return 0;
  }
  if (cmd === 'schema') {
    const type = opt('type') ?? 'Query';
    const r = await query(ctx, creds, `query Schema { __type(name: "${type.replace(/[^A-Za-z0-9_]/g, '')}") { kind name fields { name args { name type { kind name ofType { kind name ofType { kind name } } } } type { kind name ofType { kind name ofType { kind name } } } } inputFields { name type { kind name ofType { kind name ofType { kind name } } } } possibleTypes { name } enumValues { name } } }`);
    const t = (r.data.__type ?? null) as null | { kind: string; name: string; fields?: Array<{ name: string; args?: Array<{ name: string; type: unknown }>; type: unknown }>; inputFields?: Array<{ name: string; type: unknown }>; possibleTypes?: Array<{ name: string }>; enumValues?: Array<{ name: string }> | null };
    if (t === null) { say('no such type'); return 1; }
    const show = (ty: unknown): string => { const x = ty as { kind?: string; name?: string | null; ofType?: unknown } | null; if (x === null || x === undefined) return '?'; return x.name ?? `${x.kind}<${show(x.ofType)}>`; };
    say(`${t.kind} ${t.name}`);
    const only = opt('match') === undefined ? undefined : new RegExp(opt('match') as string, 'i');
    for (const f of t.fields ?? []) if (only === undefined || only.test(f.name)) say(`  ${f.name}${f.args !== undefined && f.args.length > 0 ? `(${f.args.map((a) => `${a.name}: ${show(a.type)}`).join(', ')})` : ''}: ${show(f.type)}`);
    for (const f of t.inputFields ?? []) say(`  ${f.name}: ${show(f.type)}`);
    if (Array.isArray(t.enumValues)) say(`  values: ${t.enumValues.map((v) => v.name).join(', ')}`);
    if (Array.isArray(t.possibleTypes)) say(`  possible: ${t.possibleTypes.map((p) => p.name).join(', ')}`);
    return 0;
  }
  if (cmd === 'check') {
    const expected = opt('expect-name'); if (expected === undefined) { say('refused: --expect-name "<account name>" is required'); return 2; }
    const tokens = await vault.loadTokens(); if (tokens === undefined) throw new JobberError('NOT_CONNECTED');
    say('1. verifying the connected account before reading anything else ...');
    const acct = await verifyExpectedAccount(ctx, creds, expected, tokens.account_id);
    say(`   OK: connected to the expected account "${acct.name}" (id matches the one pinned at authorization)`);
    const from = new Date(); const to = new Date(from.getTime() + 14 * 86_400_000);
    const doc = process.env.JOBBER_SCHEDULE_QUERY ?? 'query Schedule($first: Int!, $filter: ScheduledItemsFilterAttributes!) { scheduledItems(first: $first, filter: $filter) { nodes { __typename startAt endAt } pageInfo { hasNextPage } } }';
    say('2. reading scheduled items for the next 14 days (read-only; counts only) ...');
    const s = await readSchedule(ctx, creds, doc, { first: 50, filter: { occursWithin: { startAt: from.toISOString(), endAt: to.toISOString() } } });
    say(`   scheduled items: ${s.count}${s.hasMore ? ' (more exist)' : ''}`); say(`   kinds: ${JSON.stringify(s.kinds)}`);
    say(`   earliest start: ${s.earliest ?? 'none'}`); say(`   latest start: ${s.latest ?? 'none'}`);
    say(`   API version that answered: ${s.version ?? 'not reported'}; query cost: ${s.cost.requested ?? 'n/a'}, available: ${s.cost.available ?? 'n/a'}`);
    return 0;
  }
  if (cmd === 'whoami') { const a = await readAccount(ctx, creds); say(`account: ${a.name}`); return 0; }
  say('usage: callback-url | save-credentials | authorize --expect-name "..." | check --expect-name "..." | schema [--type NAME] | status | forget'); return 2;
}

main().then((c) => { process.exitCode = c; }, (e) => { console.error(e instanceof JobberError ? `failed: ${e.code}${e.foundAccountName !== undefined ? ` (the account that answered is named "${e.foundAccountName}"; nothing was stored or read)` : ''}` : 'failed: unexpected error'); process.exitCode = 1; });
