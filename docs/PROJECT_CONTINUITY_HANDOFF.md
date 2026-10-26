# Project Continuity Handoff

Written 2026-10-25. Purpose: let a new person or session continue without the chat history. This file summarises; the authority is `docs/blueprint/PLATFORM_MASTER_PLAN.md` (73-row checklist, section 11) and `docs/MASTER_BUILD_REGISTER.md` (test figure and change log). If this file and those disagree, they win. On the dashboard decision (keep and evolve the existing dashboard; never replace it without explicit founder authorization), `docs/PRODUCT_CONTINUITY.md` governs.

## 1. Standing rules

- Synthetic data and mocks for every automated test. Live calls (Twilio, Claude) happen only through the founder-test gate (a digest-pinned approval plus `INTAKE_ALLOW_LIVE_CALLS=yes`), never in tests, and only when the founder asks.
- No new dependencies. Only Node built-ins (`node:sqlite` for the dev stores).
- No commits or pushes without the founder asking.
- Every change: run the full mock suite from `poc/intake-runner` (`npm test`), update the register's "Test figure" and add a change-log row. New test files must be added to the `test` script in `package.json`.
- **The dashboard is kept.** Do not discard, replace or rebuild `prototype/intake-work-items/` (the existing test dashboard, which is to evolve into the production customer dashboard after testing and founder approval) without the founder's explicit written authorization. Read `docs/PRODUCT_CONTINUITY.md` first.

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

## 4. Baseline: 959 tests (committed locally, not pushed)

`npm test` in `poc/intake-runner`: **959 tests, 959 pass, 0 fail, 0 skipped** (a fresh full run on 2026-10-26, about 10 seconds). **All 959 are committed locally and none is pushed: 940 in b341fd6, and the 19 `skill-cleaning` tests (the unapplied cleaning skill example) in the next commit, "Preserve dashboard product decision and add cleaning skill tests".** The register's "Test figure: 959 passed" matches. The previous committed baseline was 874 (fc7d4bc). Mocks only: this says nothing about live behaviour.

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
9. **Backup risk:** the two local commits after fc7d4bc (section 9) exist only on this machine until they are pushed.

## 8. Memory roadmap

Memory (component 5, conversation memory) is tracked as register row FND-29, PENDING, with decision D-05 and retention (C14) open. It is not built. Suggested order, all subject to the founder's decisions:

1. Decide D-05 (what memory stores, for whom) and C14 (retention and deletion).
2. Keep the privacy rule: ids and digests, not customer text, in any durable store.
3. Choose the production database (D-14) and tenant isolation approach (FND-02) before any memory store, so memory does not inherit the dev-store limits.
4. Build memory behind an injected interface with a shared conformance suite, as was done for the approval store and ledger.
5. Add per-tenant log retention before any long-lived history.

LangGraph checkpointing and Temporal were compared (read-only) and not adopted: dependency policy, privacy, and no server. Our log plus `deriveStatuses(upToSeq)` plays the checkpoint/event-history role.

## 9. GitHub backup state (checked 2026-10-26)

Branch `main`, remote `origin` = `https://github.com/doncelettabellamy-create/business-agent-platform`. **HEAD is the commit "Preserve dashboard product decision and add cleaning skill tests", ahead of `origin/main` by two commits; neither is pushed.** The last pushed commit is fc7d4bc. (Earlier versions of this section said "ahead by 6 commits" and then "HEAD equals origin/main"; both are obsolete. A commit cannot contain its own hash; use `git log` for it.)

**Committed in b341fd6 (940 tests):** the read-back and confirmation flow, spaced-digit masking, the owner view, the redesigned dashboard in `prototype/intake-work-items/`, and the earlier documentation updates.

**Committed in the second commit (959 tests in all):** `docs/PRODUCT_CONTINUITY.md`; the documentation updates that point to it (the prototype `README.md`, `PRD.md`, `DESIGN_DIRECTION_2026.md`, this handoff, the plan, the register and the runbook); `poc/intake-runner/examples/skill-cleaning.json`; `poc/intake-runner/tests/skill-cleaning.test.ts` (19 tests); and the test-list line in `poc/intake-runner/package.json`.

**Not committed:** nothing was pending when the second commit was made; re-check with `git status`.
- Ignored and never to be committed: `node_modules/`, `founder-call.config.json` (holds the relay secret and the phone number), `founder-call.stop`, `*.sqlite*`.
- A secret scan was run on the staged files before the second commit; run one again before any push. Git warns that LF will become CRLF on some files; harmless but expect noisy diffs.

## 10. Governance

- The plan and register are the source of truth; every status change needs evidence in tests or documents, and no label is raised without it. The dashboard decision is governed by `docs/PRODUCT_CONTINUITY.md`.
- Founder decisions are listed in plan section 11.5 (item 25) and register section 9.
- Synthetic data for all automated tests. Live use goes through the founder-test gate only (approved by digest, with caps, an expiry and a kill switch); the `live-run.ts` gates are exercised only by tests with mocks. Real calls were placed on 2026-10-26 under that gate.
- Dependency policy: exactly one runtime dependency approach; adding anything needs approval.
- Nothing is pushed or committed without an explicit request.

## 11. Next steps

1. Look at the dashboard in a real browser and make a live call to try the read-back flow, the hang-up wait and the owner screens (runbook sections 7 to 10 and its acceptance checks). The server was restarted on 2026-10-26 onto the committed code with a fresh schema-2 database (the old one was backed up first), so no database cleanup is needed.
2. Push the two local commits (section 9) only on the founder's request, after a final secret scan.
3. Decide the test business's configuration: the live call was a cleaning request against the plumbing configuration, so it matched no category and had no fields for rooms or a time window. A cleaning skill is ready as `poc/intake-runner/examples/skill-cleaning.json` (tested, not applied; applying it changes the approval digest).
4. Decide whether to store a callback number (consent, retention, masking), so the owner can follow up; today the number is never read or stored.
5. Plan tie fix B (causal `follows` link) together with D-14. Option A is done and committed.
6. Composition root that builds entries from configuration.
7. Decide D-14 (production database) and FND-02 (tenant isolation).
8. Decide D-05 and C14, then start the memory work.
9. Recovery scheduler, only after the above.

## 12. Founder phone test (run live at least twice; later fixes tested locally only)

A real phone-to-dashboard test: dial a Twilio number, talk to an AI assistant, confirm what it reads back, and see the intake on the owner screens of the local dashboard. Steps, blockers and acceptance checks are in `docs/FOUNDER_PHONE_TEST_RUNBOOK.md`; the status record is plan section 11.5 item 24. The dashboard decision (keep and evolve it into the production customer dashboard; never replace it without explicit founder authorization) is recorded in `docs/PRODUCT_CONTINUITY.md`.

**What has happened (2026-10-26).** The Twilio account was upgraded, because ConversationRelay is blocked on trial accounts. At least two real calls reached the server and each saved a record (evidence: the two records in the local SQLite file, which carry the live Claude model label, and the founder's report; no server log was kept). The calls found problems: the assistant ended a call before confirming; digits read out one at a time were stored unmasked; a request outside the configured categories became `unknown_category` (a cleaning job against a plumbing configuration, with nothing listed as missing); and the old dashboard showed engineering labels and a misleading "data did not load" message on an empty store.

**What was built in response (committed in b341fd6, not pushed; tested locally with invented data and stand-ins; not yet tried on a live call or looked at in a browser).**
- *Read-back and confirmation* (`relay-handler.ts`, `call-session.ts`): when Intake is ready the server runs a fresh Intake pass and reads back the non-address fields in fixed words (never the address, never a placeholder). A short plain yes confirms exactly that item; a no or doubt asks what to change (at most two read-backs); an unclear answer is asked again once; 20 seconds of silence ends the call unconfirmed. The assistant is never told to wrap up while Intake is not ready.
- *Confirmed versus unconfirmed records* (`intake-record-store.ts`, schema version 2): only a confirmed, ready record may be handed off. Every other ending is saved `needs-human`, not handed off, with the reason `not_confirmed`. `address_status` is `unverified` whenever an address was found, since it is never read back or checked. `eligibleForProcessing` (confirmed, ready, handed off, no unverified address) is the one test a future bridge to Processing must use. Nothing connects the phone path to Processing today.
- *Hang-up*: waits for the closing line (a pad plus 70 ms per character, at most 15 s, never less than `after_speech_ms`); closing lines cannot be talked over. Whether Twilio's `end` cuts queued speech is undocumented.
- *Masker*: digits read out one at a time or in groups are masked and refused as residual.
- *Owner view* (`owner-view.ts`): a pure strict allow-list (nine fields per call and five counts; no confidence, codes, masks, steps, versions, ids or address value; no wording that implies a booking; "Intakes received today" in the owner's day). `dashboard-server.ts` serves it as `/data.js` and `/api/owner` under one strict page policy; the old `/api/items`, the invented `rejectedToday`, placeholder versions and fabricated step trace are gone.
- *Owner screens* (`prototype/intake-work-items`): the Work Items list and the page for one intake were rewritten for the business owner (totals, a follow-up tab, "Requested time (not booked)", next steps, auto-refresh every 15 s, no engineering labels, no prototype controls). Its `data.js` is now an invented sample for opening the folder alone. There is no other owner page: the earlier duplicate at `/owner` was retired, so `/` is the only dashboard and the startup message prints that one address.

**Earlier code** (`poc/intake-runner/src/`): `pii-screen.ts` (rule-based masker, fails closed), `call-session.ts`, `dialogue-model.ts` (streaming Claude reply, masked text only; it never writes the record), `call-intake.ts` and the existing Intake agent, `ws-server.ts` (minimal WebSocket server, signature and secret path, 127.0.0.1), `relay-handler.ts`, `intake-record-store.ts` (SQLite), `dashboard-server.ts`, `founder-call-gate.ts`, `founder-call-entry.ts` (composition root; `npm run founder:check` is the dry run).

**Gate (unchanged):** an opt-in founder tier in `intake-entry.ts` (one `ws-founder-` tenant); a digest-pinned approval (`FOUNDER_CALL_APPROVED_DIGEST`) plus `INTAKE_ALLOW_LIVE_CALLS=yes`; 30-day expiry; call and Claude-call caps; kill-switch file; one call at a time; call-id replay refusal; the secret path plus Twilio's signature. The synthetic-only gate and the reviewed-fixture path are unchanged. The approval digest is unchanged by the work above.

**Unverified until a live call:** the read-back flow and how well Twilio's speech-to-text hears yes and no; the hang-up wait; the owner screens in a real browser; which URL form Twilio signs; voice billing; latency and naturalness.

**Risks:** a lower-case name or place that nothing introduces is still not masked (use an invented persona); place names are masked as if they were names; the store and dashboard have no login, tenant isolation, encryption or retention (FND-02 / R01, FND-10, C14); no callback number is stored; Twilio keeps its own logs (up to 30 days); a quick tunnel gets a new host each time it restarts, which means a new config, secret, digest and TwiML Bin.
