# Project Continuity Handoff

Written 2026-10-25. Purpose: let a new person or session continue without the chat history. This file summarises; the authority is `docs/blueprint/PLATFORM_MASTER_PLAN.md` (73-row checklist, section 11) and `docs/MASTER_BUILD_REGISTER.md` (test figure and change log). If this file and those disagree, they win.

## 1. Standing rules

- Synthetic data only. Mock provider, mock tools, mock clients. No live API calls.
- No new dependencies. Only Node built-ins (`node:sqlite` for the dev stores).
- No commits or pushes without the founder asking.
- Every change: run the full mock suite from `poc/intake-runner` (`npm test`), update the register's "Test figure" and add a change-log row. New test files must be added to the `test` script in `package.json`.

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

## 4. Baseline: 764 tests

`npm test` in `poc/intake-runner` on 2026-10-25: **764 tests, 764 pass, 0 fail** (about 8 seconds). The register's "Test figure: 764 passed" matches. About 605 of the 764 are in test files that are not yet committed.

Newest files: `pipeline-ledger` (10), `reporting-ledger-sqlite` (53), `reporting-history` (29). Helpers are in `tests/helpers/` (ledger and store conformance, multi-process workers, real chains).

Checklist roll-up (plan section 11): 73 rows - 11 BUILT, 23 PARTIAL, 21 NOT STARTED, 18 BLOCKED. Of 17 requirements: 0 BUILT, 10 PARTIAL, 1 NOT STARTED, 6 BLOCKED.

## 5. SQLite (development only)

Two stores on built-in `node:sqlite`, each in its own file with a kind marker so one cannot open the other's file:

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
- Pipeline with optional recovery, end-to-end tests over SQLite with restarts, startup and runtime failures.
- Observability allow-list with error-class coverage (77 codes).

## 7. Risks and open findings

1. **Same-second tie.** Verdict times have one-second resolution and an equal time never promotes, so a recovery's fresh pass in the same second leaves current status at `escalate` (fail-safe, first outcome and counts unaffected). Proposed fix: A (pipeline waits for a strictly later verdict, bounded retry, new stop reason) now; B (an attested `follows` link in the QC verdict, compare-and-set at ties) with the D-14 schema work. Not implemented.
2. No composition root: only tests build entries.
3. Seals do not persist, so a request after restart is a new attempt, not a replay.
4. No database-level tenant isolation, no encryption, no retention; production database undecided.
5. No recovery scheduler or timers.
6. A ledger failure mid-batch can leave earlier triples recorded; re-sending is safe (repeats are duplicates).
7. QC verdict time comes from QC's own clock.
8. D-06 loop rule still open.
9. **Backup risk:** most of this work exists only on this machine (section 9).

## 8. Memory roadmap

Memory (component 5, conversation memory) is tracked as register row FND-29, PENDING, with decision D-05 and retention (C14) open. It is not built. Suggested order, all subject to the founder's decisions:

1. Decide D-05 (what memory stores, for whom) and C14 (retention and deletion).
2. Keep the privacy rule: ids and digests, not customer text, in any durable store.
3. Choose the production database (D-14) and tenant isolation approach (FND-02) before any memory store, so memory does not inherit the dev-store limits.
4. Build memory behind an injected interface with a shared conformance suite, as was done for the approval store and ledger.
5. Add per-tenant log retention before any long-lived history.

LangGraph checkpointing and Temporal were compared (read-only) and not adopted: dependency policy, privacy, and no server. Our log plus `deriveStatuses(upToSeq)` plays the checkpoint/event-history role.

## 9. GitHub backup state

Branch `main`, remote `origin` = `https://github.com/doncelettabellamy-create/business-agent-platform`, **ahead of `origin/main` by 6 commits** (all intake work). Nothing from the Processing/QC/Reporting/pipeline/SQLite work is committed.

- 7 tracked files modified (`ARCHITECTURAL_ESSENTIALS.md`, `docs/MASTER_BUILD_REGISTER.md`, `docs/blueprint/AGENT_SPECS.md`, `DEPLOYMENT_TESTING.md`, `PRD.md`, `poc/intake-runner/package.json`, `src/live-entry.ts`), plus this file.
- 50 untracked files before this file: the plan, 21 `src` modules, 27 test and helper files (listed in the report that accompanied this handoff).
- Ignored: only `poc/intake-runner/node_modules/`.
- Secret scan of untracked and changed files (Anthropic, AWS, GitHub, Slack keys, private-key blocks, `.env`, `.pem`, `.key`, `.sqlite`, `.db`): nothing found. `.gitignore` also blocks `.env*`, `*.pem`, `*.key`, `credentials*.json`, `*secret*`. Note `*secret*` would silently ignore any file with that word in its name.
- Line endings: Git warns LF will become CRLF on six files; harmless but expect noisy diffs.

## 10. Governance

- The plan and register are the source of truth; every status change needs evidence in tests or documents, and no label is raised without it.
- Founder decisions are listed in plan section 11.5 (item 23) and register section 9.
- Synthetic-only data until live use is separately approved; live gates exist in `live-run.ts` and are exercised only by tests with mocks.
- Dependency policy: exactly one runtime dependency approach; adding anything needs approval.
- Nothing is pushed or committed without an explicit request.

## 11. Next steps

1. Back up to GitHub (founder's call): commit and push the work in section 9.
2. Implement tie fix A, then plan B with D-14.
3. Composition root that builds entries from configuration.
4. Decide D-14 (production database) and FND-02 (tenant isolation).
5. Decide D-05 and C14, then start the memory work.
6. Recovery scheduler, only after the above.
