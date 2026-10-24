# Master Build Register

Project: business-agent-platform (four-agent SaaS: Intake, Processing, Quality Control, Reporting)
Register created: 2026-10-24. Revised 2026-10-24 after the A-F audit (see section 14).
Scope of this file: documentation only. It records research and proposals. It contains no application code.

## 0. How to read this register

**Hard rule: research is not approval, and approval is not implementation.** Each row carries three separate status fields, and they must be updated independently.

| Field | Allowed values | Meaning |
|---|---|---|
| Proposed | KEEP / ADAPT / BUILD / REJECT / PENDING | The researcher's recommendation only. See mapping below. PENDING also means "evidence is too thin to recommend". |
| Founder status | PENDING / APPROVED / REJECTED / DEFERRED | **Every component row is PENDING.** Only the founder may change this. |
| Build status | NOT STARTED / IN PROGRESS / IMPLEMENTED / VERIFIED | **Every row is NOT STARTED.** Nothing in this register has been built. |

Mapping from the research reports: REUSE = KEEP, MODIFY = ADAPT, BUILD OUR OWN = BUILD, DO NOT USE = REJECT, "evaluate / unreviewed" = PENDING.
KEEP means "adopt as-is after review". ADAPT means "take the code or design with changes". BUILD means "write our own; borrow the idea only".

**Verification levels** (how the evidence was obtained):

| Level | Meaning |
|---|---|
| V1 | Source file or test read directly (raw GitHub content). |
| V2 | Repository metadata, README, or docs page only. |
| V3 | Inferred from file names or directory listings; contents not read. |
| V4 | Not inspected. Included only because a gap was identified. |

All research was done by read-only web fetches on 2026-10-24, with a small model summarizing each page. Nothing was cloned, installed, copied, or run. Legal and security details must be re-confirmed against the raw files before any adoption. No legal review has been done.

### 0.1 Founder-fixed constraints (these are decisions, not research, and are not up for re-opening)

| ID | Constraint | Source |
|---|---|---|
| FC-01 | The four agents are named **Intake, Processing, Quality Control, Reporting**. They must not be renamed or replaced. | Founder correction |
| FC-02 | Each agent has its own folder containing `AGENT.md` and a `skills/<skill-name>/SKILL.md` per modular skill. Each skill documents its tools, permissions, inputs, outputs, tests, and handoffs. | Founder instruction |
| FC-03 | Claude Code development skills are kept separate from customer-facing production agents. Production skills are never loaded from `.claude/`. | Founder instruction |
| FC-04 | Research findings are never recorded as built or approved. | Founder instruction |

Layout implied by FC-01 and FC-02 (folder names other than the agent names are proposals, not yet approved):

```
agents/
  intake/            AGENT.md   skills/<skill-name>/SKILL.md
  processing/        AGENT.md   skills/<skill-name>/SKILL.md
  quality-control/   AGENT.md   skills/<skill-name>/SKILL.md
  reporting/         AGENT.md   skills/<skill-name>/SKILL.md
```

The founder also approved one non-component action: editing the global Claude Code permission file (see section 13). That approval does not extend to any component below.

## 1. Approval and implementation summary

| Item | Count |
|---|---|
| Original rows (before audit) | 56 |
| Rows merged or moved out (see section 15) | 6 |
| Rows added after the audit | 4 (FND-23 to FND-26) |
| **Active component rows** | **54** (FND 25, INT 14, PRC 5, QC 2, RPT 4, UI 4) |
| Rows founder-APPROVED | **0** |
| Rows IMPLEMENTED | **0** |
| Application code in repository | none |

## 2. Research sources (IDs used below)

| ID | Subject | Repos or sources | Date |
|---|---|---|---|
| R-001 | Structured extraction and classification | `567-labs/instructor` (formerly `instructor-ai/instructor`), `567-labs/instructor-js`, `vercel/ai`, `BoundaryML/baml` | 2026-10-24 |
| R-002 | Personal-data detection and redaction | `data-privacy-stack/presidio` (formerly `microsoft/presidio`), `aws-samples/sample-agentic-data-classification-and-redaction` | 2026-10-24 |
| R-003 | Skills format, agent runtime, approvals | `agentskills/agentskills`, `anthropics/skills`, `mastra-ai/mastra` (core, workflows, `stores/pg`) | 2026-10-24 |
| R-004 | Customer-facing UI frameworks | `refinedev/refine`, `marmelab/react-admin` | 2026-10-24 |
| ORC | Orchester audits (channels, worker, security migrations, tenancy) | `lucasmailland/orchester` (Apache-2.0). The similarly named `dieWehmut/Orchester` is a Rust coding agent and was judged unsuitable. | 2026-10-24 |
| PRE-1 | Initial landscape research (before R-IDs were assigned) | `langgenius/dify` (modified Apache license, LICENSE read), `45ck/Portarium` (MIT, README only) | 2026-10-24 |

Assumption: "Orchester" means `lucasmailland/orchester`. This is not confirmed by the founder (open decision D-01).

## 3. Shared foundation

Rows are numbered by area, not by build order. The build order is in section 8. Each cross-reference in the Dependencies column uses row IDs; "D-xx" means an open founder decision from section 10.

| ID | Foundation component | Source path(s) | Proposed | License | Dependencies | Verification | Notes and risks |
|---|---|---|---|---|---|---|---|
| FND-01 | Founder decisions on vertical, channels, languages, pricing, cloud region | n/a | PENDING | n/a | none | n/a | Blocks sizing of everything below. See section 10. Agent names are already fixed (FC-01). |
| FND-02 | Tenant isolation in the database: restricted DB role, workspace set per transaction, forced row-level security, boot-time role check | ORC: `apps/web/lib/tenant/context.ts`, `packages/db/migrations/0006_rls_helpers.sql`, `0007_postgres_roles.sql`, `0009_rls_force_critical.sql`, `apps/web/lib/db-role-check.ts` | ADAPT | Apache-2.0 | FND-01 | V1: context.ts, 0006, 0007, 0009. V3: db-role-check.ts. V4: migrations 0008 and 0010 (the actual policies). | Webhook and worker path has no user identity. Dev passwords hardcoded in 0007. `cron_admin` can edit audit tables. A superuser connection bypasses all of it. (Absorbs original INT-15.) |
| FND-03 | Tamper-evident audit trail (hash chain). Also holds QC verdict records. | ORC: `apps/web/lib/audit/chain.ts` (V1); `verify.ts`, `verify-job.ts` (V3); `log.ts` (V4) | ADAPT | Apache-2.0 | FND-02 | V1 (chain.ts only) | Appends must be serialized or the chain forks. Odd value types hash incorrectly. Chain head should be anchored outside the database. (Absorbs original QC-04.) |
| FND-04 | Request replay protection (idempotency keys scoped by workspace) | ORC: `packages/db/src/schema/idempotency.ts`, `packages/db/migrations/0015_idempotency_pk_scoped.sql` | ADAPT | Apache-2.0 | FND-02 | V1 | Schema file and migration disagree on the primary key (migration adds workspace). Replay logic not read. |
| FND-05 | Durable pause/resume engine: saved snapshots, atomic claim, lease, fence, idempotent steps. Also covers Mastra's agent-workflow engine (original PRC-02). | Mastra: `packages/core/src/agent/agent.ts` (partly read), `workflows/{execution-engine,default}.ts`, `storage/{workflow-snapshot,run-fencing,workflow-step-guard}.ts`, `agent/run-ownership.ts`, `workflows/run-ownership.ts`, `agent/durable/{leases.md,run-recovery.md}`, `stores/pg/src/storage/domains/workflows/index.ts` | PENDING (ADAPT or BUILD) | Apache-2.0 for these paths, inferred from the root `LICENSE.md`; `@mastra/core` package.json is Apache-2.0; the `stores/pg` package's own license was not read. `@mastra/core` version seen: `1.80.0-alpha.2`. | FND-02, FND-06, D-05 | V1: pg workflows store, run-fencing, workflow-step-guard, workflow-snapshot, run-recovery.md, and the test files read in R-003. V3: `agent/durable/leases.md`, `workflows/run-ownership.ts` (names only). V4: `requireAgentExecutionFGA`, `checkThreadFGA` body, `#claimSuspendedAgenticLoopRun`, `db/run-fencing`, contents of `step-start-guard.test.ts` helpers. | Mid-step crash re-runs model and tool calls (tools must be idempotent). Waiting approvals are not auto-recovered. Needs our own tenant column and RLS. A custom server must call the recovery sweep at boot. |
| FND-06 | Legal question: Mastra enterprise-licensed code (`ee/`, FGA) and hosted use of `@mastra/core` | Mastra: `ee/LICENSE` (V1), `LICENSE.md` (V1), `packages/core/package.json` (V1), `packages/core/src/memory/thread-fga.ts` (V1), `packages/core/src/auth/ee/*` (V3, re-exports), `packages/_internals/auth/src/ee` (V3) | PENDING (legal review; fall back to REJECT of all `ee/` code) | **Mastra Enterprise Edition License v2.0**: production needs a written agreement and a license key; bars offering Enterprise Features as a hosted or managed service. | none | V1 for license text and imports. V4 for the `@internal/auth/ee` implementation. | Core `agent.ts` and `thread-fga.ts` import `MastraFGAPermissions` and `ActorSignal` from `'../auth/ee'`. Whether that affects a hosted SaaS is **unresolved**. Written question to Mastra recommended. |
| FND-07 | Approver identity and approval record (who, role, time, decision, reason, expiry, evidence). Also covers QC human override (original QC-03). | None found that meets this. Orchester approval page (`apps/web/app/[locale]/approve/[token]/page.tsx`, `apps/web/app/api/approvals/[token]/route.ts`) is V3 only. | BUILD | n/a | FND-02, FND-03, FND-24, D-08 | n/a | Mastra stores only a decline reason; its identity check is the optional, enterprise-folder FGA and does nothing without a provider. |
| FND-08 | Background job runner on a Postgres queue | ORC: `apps/web/worker/index.ts` | BUILD (copy the job list) | Apache-2.0 | FND-02 | V1 | Imports from the web app, hardcoded concurrency and schedules, no in-flight drain on shutdown. |
| FND-09 | Spend caps, usage metering, plan quotas, payment webhooks | ORC: `apps/web/lib/billing/{plans,quotas,stripe,stripe-signature}.ts`, `apps/web/lib/cost-alerts.ts`, `apps/web/app/api/billing/*`; usage events table (schema file not identified) | PENDING (provisional ADAPT) | Apache-2.0 | FND-02, FND-17, D-12 | V3 for the billing files (names and tests). V1 for router behavior in `apps/web/lib/channels/router.ts`. | Contents of the billing files not read, so the verdict is provisional. Our credit ledger design is separate. |
| FND-10 | Secrets and key management (tenant keys, integration secrets, encrypted credentials) | ORC: `apps/web/lib/encryption` (exact file name not seen; imported as `@/lib/encryption`), `apps/web/__tests__/encryption.test.ts` | BUILD | n/a | FND-01 | V3 (test name). The AES-256-GCM claim comes from the Orchester README (V2). | No key-management design exists yet. |
| FND-11 | API keys with scopes for customer integrations | ORC: `apps/web/lib/api-auth/{key,scopes}.ts`, `apps/web/__tests__/api-key-scopes.test.ts` | ADAPT | Apache-2.0 | FND-02, FND-07 | V3 | Contents not read. |
| FND-12 | Rate limiting | ORC: `apps/web/lib/rate-limit/in-memory-bucket.ts` (the only file seen in that folder) | PENDING | Apache-2.0 | FND-02 | V3 (name only) | May not be safe across multiple servers (assumption, unconfirmed). `widget-guard.ts` depends on `@/lib/rate-limit`, never read. Read before deciding. |
| FND-13 | Customer data export and hard delete (GDPR) | ORC: `apps/web/lib/gdpr/*`, `apps/web/lib/tenant/hard-delete-job.ts`; `apps/web/lib/gdpr/redact.ts` (V1) | ADAPT | Apache-2.0 | FND-02, FND-08, INT-08 | `redact.ts` V1. Others V3. | `redact.ts` hides credentials only, never personal data: REJECT for personal data, possibly ADAPT for log scrubbing. Vector-data deletion not covered. |
| FND-14 | Skill file format (`SKILL.md`) and loader | Spec: `agentskills/agentskills` `docs/specification.mdx` (V1), `skills-ref/src/skills_ref/validator.py` (V1), `parser.py`, `prompt.py` (V3). Mastra: `packages/core/src/workspace/skills/{workspace-skills,schemas,tools}.ts` (V1), `skill-source.ts`, `local-skill-source.ts` (V3) | ADAPT | `skills-ref` and repo root: Apache-2.0. **Spec text in `docs/`: license unverified** (`docs/LICENSE`, 18,656 bytes, not read). Mastra skills code: Apache-2.0. | FND-26, D-07 | As listed in Source path | Spec has no version field and no `AGENT.md`. `allowed-tools` is experimental; Mastra's `schemas.ts` and `workspace-skills.ts` do not handle it. `skills-ref` is demo-only and rejects unknown frontmatter keys. Mastra drops unknown keys silently. Our contract fields go in a sidecar file (D-07). Mastra skill reads show no size cap. |
| FND-15 | Skill publishing: content-hashed bundles, signing, tenant version pinning, canary, rollback | Mastra: `workspace/skills/publish.ts` (V1); `versioned-skill-source.ts`, `composite-versioned-skill-source.ts`, `skill-versioning.test.ts` (V3, not read) | BUILD | Apache-2.0 (idea) | FND-14 | V1 for publish.ts. V3 for the rest. | `publish.ts` has file hashing only: no version number, signing, or rollback. Other files may add versioning; not read. |
| FND-16 | Tool gateway: allow-list enforcement, permission tiers, injected secrets | Mastra: `packages/core/src/tools/toolchecks.ts` (V1); `packages/core/src/agent/__tests__/active-tools-enforcement.test.ts` (V3, not read) | BUILD | n/a | FND-02, FND-14, FND-24 | V1 (toolchecks.ts). V3 for the test. | `toolchecks.ts` has no allow-list. Another active-tools mechanism may exist in code not read. `allowed-tools` is advisory only. |
| FND-17 | Model gateway: provider abstraction, metering, bounded retry, structured output | Vercel AI SDK docs page `ai-sdk.dev/docs/ai-sdk-core/generating-structured-data` (`Output.object`, `Output.choice`); repo `vercel/ai` | PENDING (provisional ADAPT) | Apache-2.0 (LICENSE file read; GitHub shows "other") | FND-02, FND-10, FND-19 | V2 (docs page) | Docs do not describe retry-on-validation-failure or repair. Provider coverage not verified. |
| FND-19 | Observability and diagnostic logging (correlation ID, traces, redacted structured logs) | ORC: `apps/web/lib/audit/*` (see FND-03). `lib/observability` is referenced by the router and a Sentry test (`apps/web/__tests__/observability-sentry.test.ts`) but was not seen in the file listing: path unverified. | BUILD | n/a | FND-02, FND-03 | V4 | Instructor's TS port logs full messages on error; the Python exception also carries messages. Redaction rules need the personal-data layer (INT-06..09). |
| FND-20 | Test baseline: cross-tenant leak tests, approval tests, webhook tests | ORC tests: `apps/web/__tests__/phase-f2-flow-engine-rls.test.ts`, `telegram-webhook-secret.test.ts`, `widget-public-limits.test.ts`, `stripe-webhook-signature.test.ts`, `agent-handoff.test.ts` (V3 names). Mastra tests: `packages/core/src/agent/__tests__/{concurrent-resume-claim,persisted-approval-run-id,agentic-loop-snapshot-lifecycle,agent-fga,agent-request-context-memory-resume}.test.ts` (V1) | ADAPT (as checklists) | Apache-2.0 | FND-02, FND-05, FND-07 | Mastra tests V1. ORC tests V3. | `agent-fga.test.ts` has no test that a second user is denied approval; other approval tests were not read. |
| FND-21 | Architecture decision records (practice) | ORC `docs/adr/0001-0020` | PENDING (practice) | Apache-2.0 | none | V3 | Contents not read. ADR 0010 file name guessed wrong (404). |
| FND-22 | Database migrations (reference only) | ORC `packages/db/migrations/` (~64 files) | BUILD (reference only) | Apache-2.0 | FND-02 | V3 (list). V1 for 0006, 0007, 0009, 0015. | Skip the memory-service migrations (0016-0048). |
| FND-23 | Run identity scopes: a run keeps its tenant and thread; conflicting scopes throw; resume can only narrow | Mastra: `packages/core/src/agent/scopes.ts` | BUILD (borrow idea) | Apache-2.0 | FND-02, FND-05 | V1 | Non-identity scopes such as `org:acme` are not enforced by core; enforcement is the application's job. |
| FND-24 | Per-tool approval flags and decline reasons | Mastra: `packages/core/src/tools/toolchecks.ts` (V1), `packages/core/src/tools/hitl.md` (V1), `packages/core/src/agent/tool-approval.ts` (V1, decline-reason portion only) | ADAPT | Apache-2.0 | FND-14 | V1 (partial) | Approval enforcement lives in `agent.ts` bodies that were not fully read. |
| FND-25 | CI guard that every query is workspace-scoped | Orchester README states CI checks structural invariants (V2). Exact CI file not identified (`.github/workflows` not read). | BUILD (borrow idea) | n/a | FND-02 | V2 | |
| FND-26 | Agent folder structure and contract skeleton per FC-01 and FC-02: `agents/<agent>/AGENT.md`, `agents/<agent>/skills/<skill-name>/SKILL.md`, shared `contracts/` | n/a (founder-fixed layout; contract names `work_item.v1`, `candidate_result.v1`, `qc_verdict.v1`, `report.v1` are proposals) | BUILD | n/a | FND-01 | n/a | Folder names other than the four agent names are proposals. |

## 4. Intake

Intake turns raw inbound requests into validated work items (classify, extract, validate completeness, create work item). Agent folder: `agents/intake/`.

| ID | Component | Source path(s) | Proposed | License | Dependencies | Verification | Notes and risks |
|---|---|---|---|---|---|---|---|
| INT-01 | Signed webhook verification and replay window | ORC `apps/web/lib/channels/slack.ts` (V1), `telegram.ts` (V1) | ADAPT | Apache-2.0 | FND-02, FND-04 | V1. Depends on `@/lib/encryption` and `@/lib/http-util` (V4). | Slack: timing-safe compare, 5-minute window, needs raw body, no retry or 429 handling, bot-loop filter is elsewhere. Telegram: bot token sits in the request URL. |
| INT-02 | Public chat widget guard and sender allowlist | ORC `apps/web/lib/channels/widget-guard.ts` (V1), `allowlist.ts` (V1), `apps/web/app/api/widget/[channelId]/*` (V3) | ADAPT | Apache-2.0 | FND-12, FND-02 | V1. Depends on `@/lib/rate-limit` (V4). | CORS `*`, no origin check, no raw-body cap, forgeable address header. Allowlist is deny-by-default (good). |
| INT-03 | Inbound webhook routes | ORC `apps/web/app/api/channels/telegram/webhook/[secret]/route.ts` (V1); slack and discord routes (V3) | BUILD (borrow ideas) | Apache-2.0 | INT-01, INT-04, FND-04 | V1 | No duplicate-message protection, holds the connection for the whole agent run, raw error messages returned, per-channel inline logic. |
| INT-04 | Inbound router ideas (quota check, untrusted-data wrapper, handoff limit, metering) | ORC `apps/web/lib/channels/router.ts` | BUILD (borrow ideas) | Apache-2.0 | FND-09, FND-17 | V1 | `@ts-nocheck`, duplicated paths, mixed languages. Max two handoffs, quota before any model call, failed turns metered separately. |
| INT-05 | Structured extraction and classification contract (schema-first, bounded retry with errors fed back, token budget) | Instructor Python: `instructor/v2/core/retry.py` (V1), `examples/classification/simple_prediction.py` (V1). TS port: `src/instructor.ts` (V1), `examples/classification/simple_prediction/index.ts` (V1). `src/dsl/maybe.ts` (**V3: not read; the "not found" option is unverified**). | BUILD (borrow ideas) | MIT | FND-17, INT-12 | As listed | Python is maintained; TS port last code change 2025-01-27 with deprecated modes. TS port logs full messages. No classification accuracy tests in Instructor. Gateway library choice lives in FND-17; this row is the Intake-specific contract. |
| INT-06 | Personal-data detector service | Presidio: `presidio-analyzer/presidio_analyzer/{analyzer_engine,pattern_recognizer}.py` and `predefined_recognizers/` (V3, listings); docs `docs/supported_entities.md`, `docs/installation.md`, `docs/faq.md` (V1) | PENDING (provisional KEEP as a separate service behind our auth, after a measured recall spike) | MIT | FND-02, FND-10, D-03, D-11 | V1 for docs; V3 for analyzer source | No built-in API auth. English only by default. No guarantee of finding everything. Project moved organizations and registry (`ghcr.io/data-privacy-stack/...`); verify legitimacy and pin digests. |
| INT-07 | Masking operators and stable placeholders | Presidio `presidio-anonymizer/presidio_anonymizer/operators/` (V3); `docs/anonymizer/index.md` (V1) | ADAPT | MIT | INT-06, INT-08 | V1 (docs) | `replace` gives `<PERSON>` for everyone; only `encrypt` is reversible. We need stable tokens. |
| INT-08 | Token vault, encrypted per-tenant store of raw values (owner of all raw-value storage) | None found | BUILD | n/a | FND-02, FND-10 | n/a | Core of our personal-data design. FND-13 (deletion) and FND-19 (log scrubbing) depend on it. |
| INT-09 | Classification labels + per-user redaction at read time + fail-closed defaults | AWS sample `lambdas/classification/handler.py`, `lambdas/data-retrieval-tool/handler.py` | ADAPT (design only) | MIT-0 | INT-07, INT-08, FND-07 | V1 | Sample sends raw text to the model, stores unredacted text, relies on the model's own `pii_detected` flag, passes user identity through the prompt, has no tests, and is single-tenant. (Absorbs original FND-18's design intent.) |
| INT-10 | Optional cloud guardrail masking (Bedrock Guardrails `ApplyGuardrail`) | AWS sample `infra/template.yaml`, `lambdas/data-retrieval-tool/handler.py` | PENDING (optional second layer) | MIT-0 (sample); AWS service terms for the service | INT-09, D-03 | V1 | Demo-stack cost from the README only (about $6-8/day plus about $0.10 per document); Guardrails pricing and costs at our scale not stated. |
| INT-11 | AWS sample infrastructure, agent runtime, front end | AWS sample `infra/*`, `agent/agent.py`, `frontend/*` | REJECT | MIT-0 | none | V1 | Demo only, no authorizer on the API, CORS all origins, public search network. |
| INT-12 | Intake skills (`classify-request`, `extract-fields`, `validate-completeness`, `create-work-item`) and contract `work_item.v1` | n/a | BUILD | n/a | FND-14, FND-17, FND-26, INT-05, INT-07, INT-09 | n/a | Names are placeholders until the vertical is known (D-01). |
| INT-13 | Intake evaluation set (labelled messages, recall target for personal data, extraction accuracy) | Ideas only: `BoundaryML/baml` eval framework (V2) | BUILD | n/a | INT-06, INT-12, D-04 | n/a | Nothing in Instructor measures accuracy. |
| INT-14 | Non-English support | Presidio `docs/analyzer/languages.md` | BUILD | n/a | INT-06, INT-13, D-11 | V1 (docs) | Context words must be translated; no accuracy figures published. |

## 5. Processing

Processing plans and executes work, enriches from the knowledge base, and assembles a candidate result with evidence. Agent folder: `agents/processing/`.

Research coverage for Processing is thin. Nothing here is verified beyond names and listings, except where marked V1.

| ID | Component | Source path(s) | Proposed | License | Dependencies | Verification | Notes and risks |
|---|---|---|---|---|---|---|---|
| PRC-01 | Step-by-step workflow engine with retries, sub-flows, dry run (engine choice also covers Mastra's engine; see FND-05) | ORC `apps/web/lib/flows/*` (41 files), `apps/web/__tests__/flow-engine-*.test.ts` | PENDING | Apache-2.0 | FND-05, D-05 | V1: `extract.ts`, `field-types.ts`, `action-guard.ts`. V3: the rest. | Large and unreviewed. `extract.ts` is an editor refactor tool, not data extraction. `field-types.ts` and `action-guard.ts` are editor-tied. |
| PRC-03 | Knowledge base retrieval | ORC `apps/web/lib/chunking.ts`, `packages/db/src/schema/knowledge.ts`, knowledge pages `apps/web/app/[locale]/[workspaceSlug]/(shell)/knowledge/*` | PENDING | Apache-2.0 | FND-02, INT-07 | V3 | Not read. |
| PRC-04 | Tool adapters (email, calendar, payments, external writes) | None | BUILD | n/a | FND-04, FND-16 | n/a | Must be idempotent because crash recovery repeats steps. Agents never hold raw credentials. |
| PRC-05 | Processing skills and `candidate_result.v1` contract | n/a | BUILD | n/a | FND-14, FND-26, PRC-01, PRC-03, PRC-04, PRC-06 | n/a | Placeholders until D-01. |
| PRC-06 | Delegation between agents with an audit event per handoff | Mastra `packages/core/src/agent/subagent.ts`, `delegation-refs.ts` (V3). Orchester handoff test `apps/web/__tests__/agent-handoff.test.ts` (V3). The Orchester router file is owned by INT-04. | BUILD (borrow ideas) | Apache-2.0 | FND-03, FND-23, INT-12 | V3 | Max two handoffs rule comes from INT-04's source. |

## 6. Quality Control

QC checks candidate results against rules, facts, and personal-data policy, then passes, requests rework, or escalates. QC cannot edit the candidate. Agent folder: `agents/quality-control/`.

No source repository was researched specifically for QC. Everything here is a design item. QC verdicts are recorded through FND-03; QC human override uses FND-07.

| ID | Component | Source path(s) | Proposed | License | Dependencies | Verification | Notes and risks |
|---|---|---|---|---|---|---|---|
| QC-01 | Rule check, fact check, personal-data scan, score-and-decide skills; contract `qc_verdict.v1` | n/a (personal-data scan reuses INT-06) | BUILD | n/a | FND-03, FND-07, FND-14, FND-26, INT-06, PRC-05 | n/a | Needs a seeded-defect test set. Preferably a different model or prompt lineage than Processing. |
| QC-02 | Block-or-recommend policy and rework-loop limit | n/a | PENDING | n/a | QC-01, D-06 | n/a | Founder decision. |

## 7. Reporting

Reporting builds status reports and anomaly alerts from aggregated data, without raw customer content. Agent folder: `agents/reporting/`.

Little research. The UI items come from R-004.

| ID | Component | Source path(s) | Proposed | License | Dependencies | Verification | Notes and risks |
|---|---|---|---|---|---|---|---|
| RPT-01 | Metrics and activity queries | ORC `apps/web/lib/activity/*`, `apps/web/app/api/billing/usage/route.ts`, `apps/web/app/[locale]/[workspaceSlug]/(shell)/usage/page.tsx` | PENDING | Apache-2.0 | FND-03, FND-09 | V3 | Not read. |
| RPT-02 | Report build, anomaly detection, delivery skills; contract `report.v1` | n/a | BUILD | n/a | FND-14, FND-19, FND-26, RPT-01 | n/a | Reads aggregated views only. |
| RPT-03 | Dashboards (customer-facing) | R-004: neither Refine nor react-admin provides dashboard components | BUILD | n/a | RPT-01, UI-01 | V2 | |
| RPT-04 | Audit trail viewer | react-admin Enterprise `ra-audit-log` vs our own over the audit table (FND-03) | PENDING | react-admin Enterprise Edition is paid; terms not reviewed | FND-03, D-09 | V2. The features page "does not label every item explicitly" as Enterprise, so the paid status of each module is a caveat. | Founder decision D-09. |

## 8. Customer-facing UI (applies to all agents)

| ID | Component | Source path(s) | Proposed | License | Dependencies | Verification | Notes and risks |
|---|---|---|---|---|---|---|---|
| UI-01 | Customer app shell (Approval Inbox, Today queue, Conversations, Agents, Usage, Audit) | n/a | BUILD | n/a | FND-07, D-10 | n/a | These screens are not CRUD pages. Neither framework fits as the whole shell. |
| UI-02 | CRUD screens (customers, work items, knowledge, policies) | `refinedev/refine` (monorepo). Docs: `refine.dev/docs/guides-concepts/multi-tenancy/`, `refine.dev/docs/authorization/access-control-provider/`. Releases: `@refinedev/core` 5.0.12 (2026-04-02), `@refinedev/mui` 8.0.2 (2026-03-23). | PENDING (provisional ADAPT) | MIT | UI-01, D-10 | V2 | Headless, brand freedom. Release cadence looks slower since April 2026; README ties it to the vendor's own AI agent (inference). Multitenancy package scopes in the browser, not a security boundary. Code not inspected. |
| UI-03 | Internal platform-admin console | `marmelab/react-admin` (default branch `master`, v5.15.5 released 2026-10-19). Docs in repo: `docs/Features.md`, `docs/Permissions.md`, `docs/Authentication.md`. | PENDING (provisional KEEP for internal use) | MIT; Enterprise Edition modules (roles, audit log, history, realtime, soft delete) are paid, with the caveat noted at RPT-04 | UI-01, D-10 | V2 | Code not inspected. `canAccess` defaults to allow-all when not implemented. Client-side checks are not security. |
| UI-05 | Orchester UI pages (brain, flows, teams, org) | ORC `apps/web/app/[locale]/[workspaceSlug]/(shell)/*` | REJECT | Apache-2.0 | none | V3 | Tied to a different product model. |

## 9. Rejected, paused, and non-component items

| Item | Reason | Source |
|---|---|---|
| Client-side permission checks as a security control (was UI-04) | Both Refine and react-admin run these in the browser; the server must enforce. Hooks may mirror server decisions for display only. | R-004 docs (V2) |
| Dify as a SaaS base | Modified Apache license: multi-tenant hosting needs written authorization; frontend logo must stay. Feature reference only. | `langgenius/dify` LICENSE (V1) |
| `dieWehmut/Orchester` | Rust coding agent, not a SaaS platform. | V2 |
| Portarium (`45ck/Portarium`) | MIT, early stage, 6 stars, no releases. Policy-tier and evidence ideas only. Code not read. | V2 |
| Instructor TypeScript port as a dependency | Last code change 2025-01-27; deprecated mode in its own example; full-message logging. | V1 |
| Instructor Python as a service | Second language and service for a small layer. | V1 |
| `anthropics/skills` document skills (docx, pdf, pptx, xlsx) | Proprietary Anthropic terms: no copying, derivatives, or redistribution (`skills/pdf/LICENSE.txt` read). Repo has no repo-wide license. | V1 |
| Mastra `ee/` code | Enterprise license; see FND-06. | V1 |
| Orchester memory service (Mnemosyne), brain UI | Extra external service required; out of scope. | V2/V3 |
| LLM-only personal-data detection | Misses silently; sends raw data to a provider. | V1 |
| Orchester `redact.ts` for personal data | Detects credentials only. | V1 |
| AWS sample deployment code | See INT-11. | V1 |

## 10. Open founder decisions

Agent names and the folder structure are NOT open (see FC-01 to FC-04).

| ID | Decision | Blocks |
|---|---|---|
| D-01 | Business vertical, what is processed and for whom, and the final names of individual skills (not the agents); confirm "Orchester" means `lucasmailland/orchester` | FND-01, INT-12, PRC-05, QC-01, RPT-02 |
| D-02 | Intake channels for the MVP (email, web chat, form, Slack, others) | INT-01, INT-02, INT-03 |
| D-03 | May any personal-data check use a cloud service, or must everything stay in our infrastructure? | INT-06, INT-10 |
| D-04 | Acceptable personal-data miss rate and extraction accuracy before autonomy | INT-06, INT-13 |
| D-05 | Adopt Mastra's pause/resume engine (Apache parts, Postgres store) or build our own; ask Mastra in writing about hosted use of `@mastra/core` | FND-05, FND-06, PRC-01 |
| D-06 | Should QC block delivery by itself or only recommend; rework-loop limit | QC-02 |
| D-07 | Keep `SKILL.md` spec-clean with contracts in a sidecar file (recommended) | FND-14 |
| D-08 | Who may approve what at launch (owner only or role-based); who sees unmasked values | FND-07, INT-09 |
| D-09 | Pay for react-admin Enterprise audit modules or build our own | RPT-04 |
| D-10 | Customer app: branded product (custom UI) or back-office style | UI-01, UI-02, UI-03 |
| D-11 | Languages and countries to support at launch | INT-06, INT-14 |
| D-12 | Pricing and credit definition | FND-09 |

## 11. Launch-blocking risks (carried from research)

| Risk | Related rows | Status |
|---|---|---|
| Anyone holding a run ID can approve unless our API checks identity first | FND-05, FND-07 | Open. Not built. |
| License uncertainty: Mastra core imports from an `ee/` path; hosted use of enterprise features is barred | FND-05, FND-06 | Open. Legal check not done. |
| Snapshot and run tables are keyed by workflow name and run ID, with a plain `resourceId` column; no tenant wall by default | FND-02, FND-05 | Open. |
| Mid-step crash repeats model and tool calls | FND-05, PRC-04 | Open. Tools must be idempotent. |
| Personal data missed by detection reaches a model provider or logs | INT-06 to INT-09 | Open. Needs a second layer and measured recall. |
| No approval expiry in Mastra | FND-05, FND-07 | Open. |
| Mastra `@mastra/core` is an alpha release (`1.80.0-alpha.2`) | FND-05 | Open. |
| Presidio and the AWS sample have unauthenticated or weakly authenticated endpoints in their default form | INT-06, INT-11 | Open. Put behind our gateway. |
| Orchester: webhook and worker paths use a cross-tenant bypass | FND-02, FND-08, INT-03 | Open. |
| Spec text license (`agentskills` `docs/LICENSE`) not read | FND-14 | Open. |

## 12. Corrections to earlier research statements (kept for traceability)

- Earlier summary said Orchester isolation was application-level only. Source shows forced row-level security with a restricted role (`apps/web/lib/tenant/context.ts`, migrations 0006-0009). Corrected.
- Earlier summary said Orchester had no billing plans. Source contains `lib/billing/*` and `app/api/billing/*`. Corrected.
- Earlier I expected Orchester's `flows/extract.ts` to extract data fields. It refactors the flow editor. Corrected.
- `instructor-ai/instructor` and `microsoft/presidio` have moved to `567-labs/instructor` and `data-privacy-stack/presidio`.
- Orchester idempotency: migration 0015 scopes the key by workspace; the TypeScript schema file read earlier still shows the old key. Not reconciled.

## 13. Security hygiene note (not a build item)

The global Claude Code permission file was edited on 2026-10-24 (founder-approved) to remove broad git/node permissions and a command that contained a GitHub token. The token itself has **not been confirmed revoked**; revocation on GitHub and a scrub of local history copies remain founder actions. No credential values appear in this register.

## 14. Change log

| Date | Change | By |
|---|---|---|
| 2026-10-24 | Register created from R-001 to R-004 and the Orchester and Mastra audits. | Claude Code (documentation only) |
| 2026-10-24 | Revised after the A-F audit. Added section 0.1 founder-fixed constraints (A1). Replaced "NOT REVIEWED" with "PENDING" for founder status. Changed FND-06, INT-06, FND-12, FND-21, FND-09, FND-17, UI-02, UI-03 to PENDING (A2-A6, E). Merged FND-18, QC-03, QC-04, PRC-02, INT-15 and moved UI-04 (C1-C9). Fixed cross-references and dependencies (B). Added source paths, new rows FND-23 to FND-26, and PRE-1 source row (D). Weakened unsupported claims for INT-05, FND-14, FND-15, FND-16, FND-20, PRC-01, RPT-04, UI-03 (E). Replaced the vague row count (F). Added sections 15 and 16. | Claude Code (documentation only) |

## 15. Original row-ID mapping (all 56 original IDs preserved)

"Kept" means the row exists under the same ID (possibly corrected). "Merged" and "Moved" rows no longer appear in the tables above.

| Original ID | Status now | Where |
|---|---|---|
| FND-01 to FND-17 | Kept (corrected) | section 3 |
| FND-18 | **Merged** into INT-06, INT-07, INT-08, INT-09 | section 4 |
| FND-19 to FND-22 | Kept (corrected) | section 3 |
| INT-01 to INT-14 | Kept (corrected) | section 4 |
| INT-15 | **Merged** into FND-02 | section 3 |
| PRC-01 | Kept | section 5 |
| PRC-02 | **Merged** into FND-05 (engine choice also noted in PRC-01) | sections 3, 5 |
| PRC-03 to PRC-06 | Kept (corrected) | section 5 |
| QC-01, QC-02 | Kept (corrected) | section 6 |
| QC-03 | **Merged** into FND-07 | section 3 |
| QC-04 | **Merged** into FND-03 | section 3 |
| RPT-01 to RPT-04 | Kept (corrected) | section 7 |
| UI-01 to UI-03 | Kept (corrected) | section 8 |
| UI-04 | **Moved** out of the components list into section 9 (not a component) | section 9 |
| UI-05 | Kept | section 8 |

New IDs added after the audit: FND-23, FND-24, FND-25, FND-26. Total: 56 original IDs, 50 kept, 6 merged or moved. Active rows: 54.

## 16. Dependency-aware build sequence (proposal, unapproved)

This is a proposed order, not a plan the founder has approved. "S-nn" are sequence steps. Every dependency points to an earlier step. REJECT rows (INT-11, UI-05) are excluded. "Gate" means a founder decision or check that must be passed before the step can start.

### Minimal foundation

| Step | Rows | Depends on | Gate | Exit check |
|---|---|---|---|---|
| S-01 | FND-01, FND-06 (legal question, runs in parallel), FND-21 (practice) | none | D-01, D-05, D-07, D-08, D-10 answered or deferred in writing | Decisions recorded. Legal question sent. |
| S-02 | FND-26 (agent folders and contract skeleton) | S-01 | FC-01, FC-02 | Four agent folders each have `AGENT.md` and an empty `skills/` folder. |
| S-03 | FND-02 (tenant wall), FND-25 (query-scoping CI guard), FND-22 (migration reference) | S-01 | none | Cross-tenant read and write attempts fail in tests. |
| S-04 | FND-10 (secrets and keys) | S-01 | none | No secret in code or logs. |
| S-05 | FND-03 (audit chain) | S-03 | none | Tamper test detects an edited entry. |
| S-06 | FND-04 (idempotency) | S-03 | none | Replayed request does not repeat its action. |
| S-07 | FND-19 (logging with redaction rules) | S-03 | none | Sample logs contain no raw personal data. |
| S-08 | FND-14 (skill format, loader, validator) | S-02 | D-07; spec text license read | Invalid and oversized skills are rejected. |
| S-09 | FND-17 (model gateway: structured output, bounded retry, metering hooks) | S-03, S-04, S-07 | none | Schema-violating output is retried at most N times, then escalated. |
| S-10 | FND-16, FND-24 (tool gateway and approval flags) | S-03, S-08 | none | A tool not in a skill's declared list cannot run. |
| S-11 | FND-07, FND-23 (approver identity, record, run scopes) | S-03, S-05, S-10 | D-08 | A non-authorized user cannot approve. Approval is logged. |
| S-12 | FND-05 (pause/resume) | S-03, S-06, S-11 | D-05; FND-06 answered | Paused item survives a restart and resumes once. Double approval runs the tool once. |
| S-13 | FND-08 (job runner) | S-03, S-12 | none | Graceful shutdown drains jobs. |
| S-14 | FND-15 (skill publishing and tenant pinning) | S-08 | none | Rollback restores a prior version. |
| S-15 | FND-09 (spend caps, quotas, metering) | S-09, S-03 | D-12 | A tenant at its cap is stopped before the model call. |
| S-16 | FND-20 (test baseline) | S-03 to S-12 | none | Cross-tenant, approval, and webhook suites run in CI. **Foundation gate.** |

### Intake

| Step | Rows | Depends on | Gate | Exit check |
|---|---|---|---|---|
| S-17 | INT-08 (token vault) | S-03, S-04 | none | Raw values retrievable only through an authorized call. |
| S-18 | INT-06 (detector service behind our gateway) | S-04, S-16 | D-03, D-11 | Service rejects unauthenticated calls. |
| S-19 | INT-07 (masking and stable tokens) | S-17, S-18 | none | Two people with the same name get distinct tokens. |
| S-20 | INT-09 (labels, per-user redaction, fail-closed) | S-19, S-11 | D-08 | Unlabelled or unknown content is denied. |
| S-21 | FND-12, INT-01, INT-02 (rate limit, signed webhooks, widget guard) | S-03, S-06 | D-02 | Forged and replayed webhooks are rejected. |
| S-22 | INT-04, INT-03 (router ideas, inbound routes) | S-21, S-09, S-15, S-13 | D-02 | Duplicate delivery processes once. Reply is acknowledged quickly, work runs on the queue. |
| S-23 | INT-05, INT-12 (Intake contract and skills) | S-08, S-09, S-19, S-20 | D-01 | `work_item.v1` validates. Model sees masked text only. |
| S-24 | INT-13 (evaluation set and recall gate) | S-23, S-18 | D-04 | Recall and extraction targets met on labelled data. **Intake gate.** |
| S-25 | INT-14 (non-English) | S-24 | D-11 | Per-language targets met. |
| S-26 | FND-13 (export and hard delete, including vault) | S-13, S-17 | none | Customer deletion leaves no raw value in any store. |
| S-27 | UI-01 (Approval Inbox and Today queue only) | S-11, S-12 | D-10 | Approver completes an approval in a few taps on a phone. |
| S-28 | INT-10 (optional cloud second layer) | S-20 | D-03 | Only if approved. |

### Processing

| Step | Rows | Depends on | Gate | Exit check |
|---|---|---|---|---|
| S-29 | PRC-01 (engine decision: Orchester-style flows vs. FND-05 engine) | S-12, S-23 | D-05 | Decision recorded with a short spike result. |
| S-30 | PRC-03 (knowledge retrieval) | S-03, S-19 | none | Retrieval never crosses tenants. |
| S-31 | PRC-04 (tool adapters) | S-06, S-10 | none | Retried step does not duplicate an external effect. |
| S-32 | PRC-06 (delegation contract and audit event per handoff) | S-05, S-11, S-23 | none | Handoff envelope validates; loop limit enforced. |
| S-33 | PRC-05 (Processing skills, `candidate_result.v1`) | S-08, S-29, S-30, S-31, S-32 | D-01 | Candidate carries evidence for each claim. **Processing gate.** |

### Quality Control

| Step | Rows | Depends on | Gate | Exit check |
|---|---|---|---|---|
| S-34 | QC-01 (QC skills, `qc_verdict.v1`; records via FND-03, overrides via FND-07) | S-05, S-11, S-18, S-33 | none | Seeded-defect set is caught; QC cannot edit the candidate. |
| S-35 | QC-02 (block-or-recommend, rework limit) | S-34 | D-06 | No external delivery without a QC verdict. **QC gate.** |

### Reporting

| Step | Rows | Depends on | Gate | Exit check |
|---|---|---|---|---|
| S-36 | RPT-01 (metrics queries) | S-05, S-15 | none | Figures reconcile with the ledger and audit log. |
| S-37 | RPT-02 (report skills, `report.v1`) | S-07, S-08, S-36 | none | Reports contain no personal data. |
| S-38 | RPT-03 (dashboards) | S-27, S-36 | D-10 | |
| S-39 | RPT-04 (audit viewer) | S-05 | D-09 | **Reporting gate.** |

### Later, outside the MVP path

| Step | Rows | Depends on | Gate |
|---|---|---|---|
| S-40 | UI-02, UI-03 (CRUD screens, internal admin console) | S-27 | D-10 |
| S-41 | FND-11 (API keys for customer integrations) | S-11 | none |

Rows not placed in the sequence: INT-11 and UI-05 (REJECT).
