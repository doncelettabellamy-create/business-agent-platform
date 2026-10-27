# Project Continuity Handoff

Written 2026-10-25. Purpose: let a new person or session continue without the chat history. This file summarises; the authority is `docs/blueprint/PLATFORM_MASTER_PLAN.md` (73-row checklist, section 11) and `docs/MASTER_BUILD_REGISTER.md` (test figure and change log). If this file and those disagree, they win. On the dashboard decision (keep and evolve the existing dashboard; never replace it without explicit founder authorization), `docs/PRODUCT_CONTINUITY.md` governs.

## 1. Standing rules

- Synthetic data and mocks for every automated test. Live calls (Twilio, Claude) happen only through the founder-test gate (a digest-pinned approval plus `INTAKE_ALLOW_LIVE_CALLS=yes`), never in tests, and only when the founder asks.
- No new dependencies. Only Node built-ins (`node:sqlite` for the dev stores).
- No commits or pushes without the founder asking.
- Every change: run the full mock suite from `poc/intake-runner` (`npm test`), update the register's "Test figure" and add a change-log row. New test files must be added to the `test` script in `package.json`.
- **The dashboard is kept.** Do not discard, replace or rebuild `prototype/intake-work-items/` (the existing test dashboard, which is to evolve into the production customer dashboard after testing and founder approval) without the founder's explicit written authorization. Read `docs/PRODUCT_CONTINUITY.md` first.

**Development order and approval: the industry order is Cleaning → Towing → Plumbing → HVAC, one at a time, and the founder approves each task before it begins (implementation → automated tests → live validation where applicable → founder review; finishing one task never authorises the next).** See `docs/DEVELOPMENT_ROADMAP.md` sections 1b and 2. The prototype dashboard is preserved and evolved, never replaced (`docs/PRODUCT_CONTINUITY.md` governs).

## 2. Architecture

A controlled pipeline of four agents, each behind an "entry" that takes a minted execution context (tenant, agent, scopes, correlation id) and refuses anything else.

```
credential -> mint context -> Intake -> Processing -> Quality Control -> Reporting
```

- Contracts between agents are versioned, validated objects (`handoff`, `candidate_result.v1`, `qc_verdict.v1`, `ReportV1`) tied together by correlation ids and content digests.
- `pipeline.ts` takes finished entries and imports no ledger, store or Reporting implementation. Durable parts are chosen where entries are built.
- Observability is an allow-list emitter (ids and fixed codes only; every error code is classified).
- Tenant boundary: a tenant registry selects the config; every entry rechecks the tenant.

## 3. The four agents

| Agent | File | Job |
|---|---|---|
| Intake | `src/intake-entry.ts` | Mask/validate a message, classify, extract fields, safety rules, hand off a sealed envelope or send to a human. |
| Processing | `src/processing-entry.ts` | Run a fixed plan of registered tools (mock note tool; human-approved tools use the approval store) and produce a candidate result. Uncertain outcomes are recorded, never retried blindly. |
| Quality Control | `src/qc-entry.ts`, `src/qc-verdict.ts` | Judge a candidate against the envelope by reading back evidence. Verdict: pass, rework, escalate. `reconcile` is the only operation that may settle an in-doubt approval claim. |
| Reporting | `src/reporting-entry.ts`, `src/report.ts`, `src/reporting-ledger.ts` | Verify the Intake-Processing-QC chain, record each attempt in an append-only hash-linked log, and produce a per-tenant report. |

Optional recovery in the pipeline (`recoverUncertain: true`): after an escalation caused by an uncertain human-approved step, QC reconciles once, and if something settled, one fresh verification is filed as a repeat attempt. The first outcome is never changed.

## 4. Baseline: 959 tests (940 introduced by commit b341fd6, 19 more by 2b720a5)

`npm test` in `poc/intake-runner`: **959 tests, 959 pass, 0 fail, 0 skipped** (a fresh full run on 2026-10-26, about 10 seconds). **All 959 are in commits: 940 were introduced by b341fd6, and the 19 `skill-cleaning` tests (the unapplied cleaning skill example) by 2b720a5. Push state is not kept here; see section 9.** The register's "Test figure: 959 passed" matches. The previous committed baseline was 874 (fc7d4bc). Mocks only: this says nothing about live behaviour.

**Update 2026-10-26 (uncommitted work):** Snapshot 2026-10-27 (a dated automated-test figure, not maintained): the last full run of `npm test` in `poc/intake-runner` was **1131 passing, 0 failing** (superseding the 1043 of the earlier update; see the checkpoint update below). Mock and stand-in tests only: it says nothing about live behaviour. Re-run the suite for the current figure. The 84 new tests are in new `next-field`, `contact-capture`, `contact-vault`, `opening` and `skill-cleaning-services` test files and additions to `founder-call`, `ws-server` and `founder-dashboard`, plus three SQLite-inventory expectations that now list `contact-vault.ts`; most of them are in commit `62da32c`; the later ones are local only (see the checkpoint update below). The per-file counts below are the earlier committed figures.

Newest files and their current counts (each file run on 2026-10-26): `skill-cleaning` (19), `founder-call` (40), `founder-dashboard` (21), `pii-screen` (26), `owner-view` (13), `owner-dashboard` (11), `prototype-empty-store` (19; the owner screens run against a stand-in DOM), `founder-call-gate` (20), `ws-server` (16), `pipeline-recovery` (30), `pipeline-ledger` (10), `reporting-ledger-sqlite` (53), `reporting-history` (29). Helpers are in `tests/helpers/` (ledger and store conformance, multi-process workers, real chains, a Twilio stand-in, a stand-in browser DOM).

Checklist roll-up (plan section 11): 73 rows - 11 BUILT, 23 PARTIAL, 21 NOT STARTED, 18 BLOCKED. Of 17 requirements: 0 BUILT, 10 PARTIAL, 1 NOT STARTED, 6 BLOCKED.

## 5. SQLite (development only)

Three stores on built-in `node:sqlite`, each in its own file with a kind marker so one cannot open the other's file:

- `src/intake-record-store.ts` (the founder phone test's masked records; schema version 2, which refuses an older file; records carry `confirmation` and `address_status`; see section 12).

- `src/approval-store-sqlite.ts`: human-approval claims and decisions (durable claim, in-doubt state).
- `src/reporting-ledger-sqlite.ts`: the Reporting observation log. Each `record` is one `BEGIN IMMEDIATE` transaction (WAL, synchronous FULL); unique keys back duplicate and attempt rules; triggers forbid UPDATE/DELETE on observations; snapshot is one read transaction. Digests are identical to the in-memory ledger.

Injection point: `createReportingEntry({ ledger })`. Omit it for the in-memory default (history is lost on restart). `maxAttempts` together with `ledger` is a RangeError.

Limits: no database-level tenant isolation (FND-02 / R03), single host and file, synchronous calls, no encryption at rest (FND-10), no retention (C14), tamper-evident only. Production database is undecided (D-14). Neither store is the production store.

## 6. Completed work (high level)

- Intake: classification/extraction, per-category required fields, safety rules, multi-business configs, model-ambiguity review.
- Minted execution contexts, tenant boundary, handoff seals (in-process only).
- Processing with tool registry, uncertain-outcome rules, human-approved tools and approval store (in-memory and SQLite).
- QC with read-back evidence, human-approval checks, reconcile.
- Reporting: report contract, observation history, duplicate protection, verified current-status derivation, atomic ledger `record`, injectable and untrusted-checked ledger, SQLite ledger.
- Pipeline with optional recovery that requires a strictly later fresh verdict (Option A), end-to-end tests over SQLite with restarts, startup and runtime failures.
- Observability allow-list with error-class coverage (77 codes).
- Founder phone test: a Twilio ConversationRelay call into the existing Intake agent, with consent, masking, a read-back and yes/no confirmation, confirmed and unconfirmed records, and owner screens fed by a strict allow-list (section 12). Run live at least twice on 2026-10-26; the fixes made after those calls are tested locally only.

## 7. Risks and open findings

1. **Same-second tie (Option A built, B proposed).** Verdict times have one-second resolution and an equal time never promotes. Recovery now waits once (injected `sleep`, 1 s) and has QC judge the same candidate again when the fresh verdict is not strictly later; if it still is not (frozen or backward clock, replayed verdict), it stops with `FRESH_NOT_LATER`, files nothing and leaves the escalation. Never repeats the action. Residual: depends on QC's clock moving forward; adds up to about 1 s to a recovery. Option B (an attested `follows` link in the QC verdict, compare-and-set at ties) is for the D-14 schema work.
2. No composition root: only tests build entries.
3. Seals do not persist, so a request after restart is a new attempt, not a replay.
4. No database-level tenant isolation, no encryption, no retention; production database undecided.
5. No recovery scheduler or timers.
6. A ledger failure mid-batch can leave earlier triples recorded; re-sending is safe (repeats are duplicates).
7. QC verdict time comes from QC's own clock.
8. D-06 loop rule still open.
9. **Backup risk:** any commit not yet pushed (`git log origin/main..HEAD`; section 9) exists only on this machine.

## 8. Memory roadmap

Memory (component 5, conversation memory) is tracked as register row FND-29, PENDING, with decision D-05 and retention (C14) open. It is not built. Suggested order, all subject to the founder's decisions:

1. Decide D-05 (what memory stores, for whom) and C14 (retention and deletion).
2. Keep the privacy rule: ids and digests, not customer text, in any durable store.
3. Choose the production database (D-14) and tenant isolation approach (FND-02) before any memory store, so memory does not inherit the dev-store limits.
4. Build memory behind an injected interface with a shared conformance suite, as was done for the approval store and ledger.
5. Add per-tenant log retention before any long-lived history.

LangGraph checkpointing and Temporal were compared (read-only) and not adopted: dependency policy, privacy, and no server. Our log plus `deriveStatuses(upToSeq)` plays the checkpoint/event-history role.

## 9. GitHub backup state (checked 2026-10-26)

Branch `main`, remote `origin` = `https://github.com/doncelettabellamy-create/business-agent-platform`. **Push state is not kept as a count or a hash in this file.** Run `git log origin/main..HEAD --oneline` for the commits that exist only on this machine, and `git status --short` for uncommitted files. *Snapshot, 2026-10-26 (dated, not maintained):* `origin/main` was fc7d4bc; the unpushed local commits were b341fd6, 2b720a5 and e1f1e54, plus the commit that made this wording change; nothing was uncommitted. (Earlier versions of this section said "ahead by 6 commits" and then "HEAD equals origin/main"; both are obsolete. A commit cannot contain its own hash, so this snapshot names earlier commits only.)

**Committed in b341fd6 (940 tests):** the read-back and confirmation flow, spaced-digit masking, the owner view, the redesigned dashboard in `prototype/intake-work-items/`, and the earlier documentation updates.

**Introduced by commit 2b720a5 (959 tests in all):** `docs/PRODUCT_CONTINUITY.md`; the documentation updates that point to it (the prototype `README.md`, `PRD.md`, `DESIGN_DIRECTION_2026.md`, this handoff, the plan, the register and the runbook); `poc/intake-runner/examples/skill-cleaning.json`; `poc/intake-runner/tests/skill-cleaning.test.ts` (19 tests); and the test-list line in `poc/intake-runner/package.json`.

**Not committed:** run `git status --short`. Nothing was pending at the last commit when this was written.
- Ignored and never to be committed: `node_modules/`, `founder-call.config.json` (holds the relay secret and the phone number), `founder-call.stop`, `*.sqlite*`.
- A secret scan was run on the staged files before commit 2b720a5; run one again before any push. Git warns that LF will become CRLF on some files; harmless but expect noisy diffs.

## 10. Governance

- The plan and register are the source of truth; every status change needs evidence in tests or documents, and no label is raised without it. The dashboard decision is governed by `docs/PRODUCT_CONTINUITY.md`.
- Founder decisions are listed in plan section 11.5 (item 25) and register section 9.
- Synthetic data for all automated tests. Live use goes through the founder-test gate only (approved by digest, with caps, an expiry and a kill switch); the `live-run.ts` gates are exercised only by tests with mocks. Real calls were placed on 2026-10-26 under that gate.
- Dependency policy: exactly one runtime dependency approach; adding anything needs approval.
- Nothing is pushed or committed without an explicit request.

## 11. Next steps

1. Look at the dashboard in a real browser and make a live call to try the read-back flow, the hang-up wait and the owner screens (runbook sections 7 to 10 and its acceptance checks). The server was restarted on 2026-10-26 onto the committed code with a fresh schema-2 database (the old one was backed up first), so no database cleanup is needed.
2. Push the local commits that `git log origin/main..HEAD` lists (section 9) only on the founder's request, after a final secret scan.
3. **Done 2026-10-26:** the live configuration is now the cleaning skill (digest `2959c7c5…c41`, applied at the 6:42 PM restart, with backups outside the repository). Next: a live call to check rooms, date, time window, the read-back and the owner screen. The roadmap's next goal is one complete simulated cleaning quote-to-booking test.
4. A callback number can now be captured, encrypted, in uncommitted code (opt-in, `FOUNDER_CONTACT_KEY`; ON in the running server since 9:52 PM, not yet exercised on a live call). Decide its retention beyond the 30-day pilot, who may read it, and whether the number may be read back in full; see the roadmap, section 6.
5. Plan tie fix B (causal `follows` link) together with D-14. Option A is done and committed.
6. Composition root that builds entries from configuration.
7. Decide D-14 (production database) and FND-02 (tenant isolation).
8. Decide D-05 and C14, then start the memory work.
9. Recovery scheduler, only after the above.

## 12. Founder phone test (run live at least twice; later fixes tested locally only)

A real phone-to-dashboard test: dial a Twilio number, talk to an AI assistant, confirm what it reads back, and see the intake on the owner screens of the local dashboard. Steps, blockers and acceptance checks are in `docs/FOUNDER_PHONE_TEST_RUNBOOK.md`; the status record is plan section 11.5 item 24. The dashboard decision (keep and evolve it into the production customer dashboard; never replace it without explicit founder authorization) is recorded in `docs/PRODUCT_CONTINUITY.md`.

**What has happened (2026-10-26).** The Twilio account was upgraded, because ConversationRelay is blocked on trial accounts. At least two real calls reached the server and each saved a record (evidence: the two records in the local SQLite file, which carry the live Claude model label, and the founder's report; no server log was kept). The calls found problems: the assistant ended a call before confirming; digits read out one at a time were stored unmasked; a request outside the configured categories became `unknown_category` (a cleaning job against a plumbing configuration, with nothing listed as missing); and the old dashboard showed engineering labels and a misleading "data did not load" message on an empty store.

**What was built in response (committed in b341fd6; tested locally with invented data and stand-ins; not yet tried on a live call or looked at in a browser).**
- *Read-back and confirmation* (`relay-handler.ts`, `call-session.ts`): when Intake is ready the server runs a fresh Intake pass and reads back the non-address fields in fixed words (never the address, never a placeholder). A short plain yes confirms exactly that item; a no or doubt asks what to change (at most two read-backs); an unclear answer is asked again once; 20 seconds of silence ends the call unconfirmed. The assistant is never told to wrap up while Intake is not ready.
- *Confirmed versus unconfirmed records* (`intake-record-store.ts`, schema version 2): only a confirmed, ready record may be handed off. Every other ending is saved `needs-human`, not handed off, with the reason `not_confirmed`. `address_status` is `unverified` whenever an address was found, since it is never read back or checked. `eligibleForProcessing` (confirmed, ready, handed off, no unverified address) is the one test a future bridge to Processing must use. Nothing connects the phone path to Processing today.
- *Hang-up*: waits for the closing line (a pad plus 70 ms per character, at most 15 s, never less than `after_speech_ms`); closing lines cannot be talked over. Whether Twilio's `end` cuts queued speech is undocumented.
- *Masker*: digits read out one at a time or in groups are masked and refused as residual.
- *Owner view* (`owner-view.ts`): a pure strict allow-list (nine fields per call and five counts; no confidence, codes, masks, steps, versions, ids or address value; no wording that implies a booking; "Intakes received today" in the owner's day). `dashboard-server.ts` serves it as `/data.js` and `/api/owner` under one strict page policy; the old `/api/items`, the invented `rejectedToday`, placeholder versions and fabricated step trace are gone.
- *Owner screens* (`prototype/intake-work-items`): the Work Items list and the page for one intake were rewritten for the business owner (totals, a follow-up tab, "Requested time (not booked)", next steps, auto-refresh every 15 s, no engineering labels, no prototype controls). Its `data.js` is now an invented sample for opening the folder alone. There is no other owner page: the earlier duplicate at `/owner` was retired, so `/` is the only dashboard and the startup message prints that one address.

**Earlier code** (`poc/intake-runner/src/`): `pii-screen.ts` (rule-based masker, fails closed), `call-session.ts`, `dialogue-model.ts` (streaming Claude reply, masked text only; it never writes the record), `call-intake.ts` and the existing Intake agent, `ws-server.ts` (minimal WebSocket server, signature and secret path, 127.0.0.1), `relay-handler.ts`, `intake-record-store.ts` (SQLite), `dashboard-server.ts`, `founder-call-gate.ts`, `founder-call-entry.ts` (composition root; `npm run founder:check` is the dry run).

**Update 2026-10-26 (after the later calls; uncommitted).** Implemented in code and tested locally, **uncommitted, and not yet exercised on a live call**: (a) Option A (one fresh validated Intake run per caller turn; the next field chosen by code in `src/next-field.ts`; the dialogue model given one `NEXT` line of names only; an 8000 ms preview budget; a late, failed or stale result chooses nothing; an incomplete request is kept unconfirmed with no follow-up promise; the confirmed closing line is "Thank you. Your request is recorded. Goodbye."); (b) contact capture (name, callback number, service address: required before a request is actionable, the number read back to the caller only, an encrypted vault in its own file with 30-day retention, a restricted command-line lookup; opt-in by `FOUNDER_CONTACT_KEY`) and the address rule (a stored contact address makes the record's `address_status` `unverified`, so `eligibleForProcessing` is false until the address is verified; the cleaning skill has no Address field); (c) the configurable opening (`src/opening.ts` and an optional `opening` block in the approved config: business name, agent name, optional disclosure wording, and a special only if the business put one there; the default notice is unchanged; it is part of the approval digest; it is spoken from the Twilio TwiML, so using it needs a new config, a new digest, new TwiML in the Twilio bin and a restart); (d) the services cleaning skill (`examples/skill-cleaning-services.json`: standard, deep and move-in/move-out, each asking only its own missing details, with pets and add-ons optional); (e) the sealed Intake handoff kept in memory through `call-intake.ts` and the phone handler, with an optional `confirmedHandoff` seam; (f) numeric-only diagnostics (`REPLY_SENT`, `REPLY_EMPTY`, `REPLY_INTERRUPTED`, `REPLY_CUT`, `REPLY_SEND_FAILED`, and a `CALL_CLOSED` line saying who closed the connection, with timings and counts). The other closing lines (trouble, limit, silence, unconfirmed) were reworded so they promise no follow-up. New log codes (fixed words and numbers only): `TIMING`, `ASK`, `LISTEN`, `CLARIFY`, `PREVIEW_BUDGET_EXCEEDED`, `PREVIEW_UNUSABLE`, `FALLBACK_RECORD`, `CONTACT_STORED`, `CONTACT_STORE_FAILED`, `CONTACT_MISSING`, `HANDOFF_SEAM_FAILED` and the diagnostics above. Restart notes: stop the server with Ctrl+C in its own terminal, which keeps its environment; a log can be kept with `Add-Content -Encoding utf8` (`Tee-Object` writes UTF-16 on PowerShell 5.1, so strip the null bytes before searching). Live state and limits: the running server (PID 5736, started 9:52 PM) has this code loaded (by file time) with contact capture ON, but **no call has been made since that restart**, so the diagnostics are unproven at runtime and the contact vault has 0 rows. Its config is still the original one-category cleaning skill (digest `2959c7c5…c41`) with **no `opening` block**; the opening, the services skill and the address rule have never run on a live call. **Unresolved: the silent response.** Two cleaning calls (about 8:40 PM and 8:57 PM) ended shortly after the assistant's question, with no caller speech reaching the server (about 30 seconds and about 3 seconds later), both before the diagnostics existed. Whether the question had words, was written to the socket or was played, whether the caller spoke, and who closed the connection are all unknown. It stays an open blocker until one call runs with the diagnostics; nothing here counts as validated on a live call until then. **Unwired: the Processing handoff.** The phone path still ends at a saved record. The preserved handoff is offered only to an optional seam that `founder-call-entry.ts` does not pass; `pipeline.ts` has no entry for an existing handoff; `eligibleForProcessing` has no consumer in `src`; and the seal is in-process only. No quote, calendar, booking or Processing run is connected to a real call. **Next:** one founder-placed call on the restarted server (invented details only) to read the diagnostics and exercise contact capture. The dashboard decision (`docs/PRODUCT_CONTINUITY.md` section 1) and the founder's approval rules (roadmap sections 1a and 1b) are unchanged; no dashboard file was touched.

**Update 2026-10-26 (checkpoint, after commit `62da32c`).** Snapshot 2026-10-27 (a dated automated-test figure, not maintained): the last full run of `npm test` in `poc/intake-runner` was **1131 passing, 0 failing**, mock and stand-in tests only; it says nothing about live behaviour. Commit `62da32c` (Option A, contact vault, opening, services skill, handoff preservation, diagnostics) is on `main` and on GitHub. Local, uncommitted and not tried on a live call: skill `choices`, the commercial human-review route (`human_review`), first-cleaning capture with answer attribution (a bare yes or no counts only for a cleanly delivered question; delivery cannot be proved), the SIMULATION pricing fixture (not connected to any call), the caller read-back of the service address, and the durable `address_status: 'caller_confirmed'`. **Address confirmation is the caller's own yes to what was read back. It is never postal or address-database validation, and the owner view says so ("Not checked against any address data").** `eligibleForProcessing(record, witness)` passes a `caller_confirmed` record only if the encrypted contact for the same tenant and call answers `'confirmed'` (the vault's `addressState()` returns a state, never the address); no witness, no contact, an expired contact, another tenant, a tampered row, the wrong key or any error is not eligible, and `unverified` never qualifies. **Dashboard wording conflict: fixed locally (uncommitted), under the founder's written authorization.** `prototype/intake-work-items/app.js` now says "An address was given and the caller confirmed it on the phone. It is not shown here. It was not checked against any address data." for a `caller_confirmed` call, and "An address was given but it is not confirmed. It is not shown here. A person needs to check it with the caller." for every other call with an address. It tells them apart by the owner view's own `Address` detail, so the owner view, the `/api/owner` shape, the routes, the layout and the stored records are unchanged and no address value is shown. **Duplicate address line (left as is):** a confirmed call's "Other details" list still shows the owner view's own line "Address: Confirmed by the caller on the phone. Not checked against any address data." as well as the new panel, so the same fact appears twice; the two agree. **Rollback risk:** the previous commit's code refuses a records database that holds any `caller_confirmed` record (the owner page and API would fail for that tenant); back up `founder-call.sqlite` before activation and export or remove those rows before any rollback; if the record write fails after the vault write, an orphan contact row remains until its 30-day expiry. **Still open:** the silent response (two cleaning calls ended shortly after the assistant's question before the diagnostics existed, and a later call was closed from the peer side before consent; the cause is not established); the Processing handoff is unwired (nothing consumes `eligibleForProcessing` or the `confirmedHandoff` seam); the name is not read back. The running server loads the code of `62da32c` with the original one-category config; the Drew Cleaning test configuration is prepared privately and not activated. **Approved Drew test greeting (not activated, not yet spoken on any call):** "$25 off a qualifying first standard cleaning", spoken after the business introduction and before the unchanged disclosure and the yes-to-continue consent. **Existing SIMULATION fixture terms it must stay aligned with:** one rule, Standard cleaning for a house or apartment with up to 2 bedrooms and 2 bathrooms, a $199.99 base less a $25.00 first-clean discount, priced only when the caller confirmed the details and that this is their first cleaning with the business; Deep, move-in/move-out and commercial requests go to a person for pricing. The greeting does not state those terms (property size, first-clean confirmation, expiry, stacking) and they are not otherwise configured. **The fixture is not connected to the phone and is not approved for quotes to real customers;** the offer is not tied to any live price rule, and the disclosure wording still needs the business's legal check.

**Gate (unchanged):** an opt-in founder tier in `intake-entry.ts` (one `ws-founder-` tenant); a digest-pinned approval (`FOUNDER_CALL_APPROVED_DIGEST`) plus `INTAKE_ALLOW_LIVE_CALLS=yes`; 30-day expiry; call and Claude-call caps; kill-switch file; one call at a time; call-id replay refusal; the secret path plus Twilio's signature. The synthetic-only gate and the reviewed-fixture path are unchanged. The approval digest is unchanged by the work above.

**Unverified until a live call:** the read-back flow and how well Twilio's speech-to-text hears yes and no; the hang-up wait; the owner screens in a real browser; which URL form Twilio signs; voice billing; latency and naturalness.

**Risks:** a lower-case name or place that nothing introduces is still not masked (use an invented persona); place names are masked as if they were names; the store and dashboard have no login, tenant isolation, encryption or retention (FND-02 / R01, FND-10, C14); no callback number is stored; Twilio keeps its own logs (up to 30 days); a quick tunnel gets a new host each time it restarts, which means a new config, secret, digest and TwiML Bin.
