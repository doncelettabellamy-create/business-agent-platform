// The exact words of the controlled test's texts and consent scripts (they must match the SUBMITTED Twilio campaign), the protected minimal consent evidence, and the private owner-consent setup commands.
// Synthetic values only; the "protector" is a reversible stand-in, never the real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { customerConsentLine, customerText, MAX_TEXT_CHARS, ownerConsentText, ownerText, OWNER_SCRIPT_ID, SENDER_LABEL, zoneLabelOf } from '../src/fast-sms-copy.ts';
import { appendConsent, callRef, CONSENT_BLOB, ownerConsentOn, ownerRef, readConsent } from '../src/fast-consent.ts';
import { createVault } from '../src/jobber-connector.ts';
import type { Protector } from '../src/jobber-connector.ts';
import { fastStatus, NUMBERS_BLOB } from '../src/founder-voice-fast.ts';

const fakeProtector: Protector = { protect: async (p) => `P1:${Buffer.from([...Buffer.from(p)].reverse()).toString('hex')}`, unprotect: async (b) => Buffer.from(Buffer.from(b.slice(3), 'hex').reverse()).toString() };
const FACTS = { businessName: 'Drew Cleaning', serviceLabel: 'Standard cleaning', bedrooms: 2, bathrooms: 2, priceDollars: 199, dateText: 'Tue Nov 3', startText: '10:00 AM', endText: '12:00 PM', zoneLabel: 'Central', address: '123 Invented Lane, Testville, TX 90210', customerName: 'Testa Invented' };
const OWNER = '+15550100003'; const CUSTOMER = '+15550100002';

test('the texts and the customer consent line are the SUBMITTED campaign wording, word for word', () => {
  assert.equal(SENDER_LABEL, 'Donceletta Bellamy - Developer Testing');
  assert.equal(customerText(FACTS), 'Donceletta Bellamy - Developer Testing: Drew Cleaning DEMO booking confirmed for Tue Nov 3, 10:00 AM-12:00 PM Central, at 123 Invented Lane, Testville, TX 90210. Standard cleaning, 2 bedrooms/2 bathrooms, $199. Test only; no cleaning service will occur. Reply STOP to opt out or HELP for help.');
  assert.equal(ownerText(FACTS), 'Donceletta Bellamy - Developer Testing: New Drew Cleaning DEMO booking for Testa Invented, Tue Nov 3, 10:00 AM-12:00 PM Central, at 123 Invented Lane, Testville, TX 90210. Standard cleaning, 2 bedrooms/2 bathrooms, $199. Test only; no cleaning service will occur. Reply STOP to opt out or HELP for help.');
  assert.equal(customerConsentLine('Drew Cleaning'), "This is Donceletta Bellamy's developer test using the fictional Drew Cleaning business. May we send you one automated booking-details text per completed test booking? Message and data rates may apply. Reply STOP to unsubscribe or HELP for help. Texting is optional. Our privacy policy and SMS terms are available on our developer test website and will be provided before you consent. Do you agree?");
  for (const s of [customerText(FACTS), ownerText(FACTS)]) { assert.ok(s.length <= MAX_TEXT_CHARS && /^[\x20-\x7e]+$/.test(s), 'plain ASCII within the limit'); assert.match(s, /Test only; no cleaning service will occur\. Reply STOP to opt out or HELP for help\.$/); }
  assert.match(ownerConsentText('Drew Cleaning'), /May we send you one automated booking-details text per completed test booking, to the owner test number\? .*STOP.*HELP.*optional/);
  assert.match(ownerConsentText('Drew Cleaning'), /doncelettabellamy-create\.github\.io\/intake-developer-test-site\/privacy\.html/);
});

test('zone label: the first word of the zone name, summer or winter; an unknown zone gives an empty label, never a guess', () => {
  assert.equal(zoneLabelOf('America/Chicago', Date.parse('2026-11-03T16:00:00Z')), 'Central'); assert.equal(zoneLabelOf('America/Chicago', Date.parse('2026-07-03T16:00:00Z')), 'Central');
  assert.equal(zoneLabelOf('America/New_York', Date.parse('2026-11-03T16:00:00Z')), 'Eastern'); assert.equal(zoneLabelOf('Nowhere/Land', 0), '');
});

test('consent evidence: minimal, protected, capped; no number, name or word is stored; a bad record is refused; the owner record is tied to the owner number and the latest one counts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'consent-')); try {
    const vault = createVault(dir, fakeProtector);
    assert.deepEqual(await readConsent(vault), []); assert.equal(await ownerConsentOn(vault, OWNER), false);
    const owner = { v: 1 as const, role: 'owner' as const, at: '2026-11-02T20:00:00.000Z', method: 'private_setup' as const, script: OWNER_SCRIPT_ID, result: 'yes' as const, ref: ownerRef(OWNER) };
    assert.equal(await appendConsent(vault, owner), true); assert.equal(await ownerConsentOn(vault, OWNER), true);
    assert.equal(await ownerConsentOn(vault, '+15550100077'), false, 'a different owner number is not covered');
    assert.equal(await ownerConsentOn(vault, OWNER), true);
    for (const bad of [{ ...owner, result: 'maybe' }, { ...owner, ref: 'not-a-ref' }, { ...owner, extra: 1 }, { ...owner, at: 'yesterday' }, { ...owner, role: 'admin' }, { ...owner, script: 'Has Spaces' }]) assert.equal(await appendConsent(vault, bad as never), false, JSON.stringify(bad).slice(0, 40));
    assert.equal((await readConsent(vault)).length, 1);
    assert.equal(await appendConsent(vault, { ...owner, result: 'no', at: '2026-11-02T21:00:00.000Z' }), true); assert.equal(await ownerConsentOn(vault, OWNER), false, 'a later no cancels the earlier yes');
    assert.equal(await appendConsent(vault, { ...owner, script: 'fast-consent-v0-owner', at: '2026-11-02T22:00:00.000Z' }), true); assert.equal(await ownerConsentOn(vault, OWNER), false, 'only the current script counts');
    // the file is protected (not readable text) and holds no number or name
    const file = readdirSync(dir).find((n) => n.startsWith(CONSENT_BLOB))!; const raw = readFileSync(join(dir, file), 'utf8'); assert.ok(!raw.includes('owner') && !raw.includes('yes'), 'the stored file is not plain text');
    const text = (await vault.loadBlob(CONSENT_BLOB))!; assert.ok(!/555|\+1|Testa|Lane/.test(text));
    // capped
    for (let i = 0; i < 520; i += 1) await appendConsent(vault, { v: 1, role: 'customer', at: '2026-11-03T00:00:00.000Z', method: 'call_verbal', script: 'fast-consent-v1-customer', result: 'yes', ref: callRef(`CA${i}`) });
    assert.equal((await readConsent(vault)).length, 500);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('setup commands: the owner consent text is shown, a yes or no is recorded only after the numbers are saved, and status reports it; nothing personal is printed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'consent-cli-')); try {
    const vault = createVault(dir, fakeProtector);
    // the real command line uses the Windows protector; this test uses the same module with a stand-in by running the library functions the command uses, and the command itself for the refusal paths
    const run = (cmd: string, input: string) => spawnSync('node', [join(import.meta.dirname, '..', 'src', 'fast-test-setup-main.ts'), cmd], { input, encoding: 'utf8', env: { ...process.env, JOBBER_STORE_DIR: dir } });
    const shown = run('owner-consent-text', ''); assert.equal(shown.status, 0); assert.match(shown.stdout, /May we send you one automated booking-details text per completed test booking, to the owner test number\?/);
    assert.ok(!/\+1\d{10}/.test(shown.stdout));
    assert.equal(run('record-owner-consent', 'not json').status, 2); assert.equal(run('record-owner-consent', JSON.stringify({ answer: 'YES' })).status, 2, 'only yes or no');
    const early = run('record-owner-consent', JSON.stringify({ answer: 'yes' })); assert.equal(early.status, 2); assert.match(early.stdout, /save the approved test numbers first/);
    assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith(CONSENT_BLOB)), [], 'nothing is recorded before the numbers exist');
    await vault.saveBlob(NUMBERS_BLOB, JSON.stringify({ account_sid: `AC${'a'.repeat(32)}`, customer: CUSTOMER, owner: OWNER }));
    assert.equal((await fastStatus({ vaultDir: dir, protector: fakeProtector, env: {} })).ownerConsent, false, 'numbers alone are not consent');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
