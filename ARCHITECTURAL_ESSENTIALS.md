# Architectural Essentials (quick reference)

Read this before touching the repo. It is a summary. If it disagrees with `docs/MASTER_BUILD_REGISTER.md`, **the register wins**.
Sources: `docs/MASTER_BUILD_REGISTER.md`, `docs/blueprint/{ARCHITECTURE,PRD,AGENT_SPECS}.md`. Last updated 2026-10-24.

## 1. Current status (read first)

- **Nothing is built.** No application code, schema, tests, or deployment exist. The repo holds documents only.
- **No component is founder-approved.** Every register row is Founder-PENDING and Build-NOT STARTED.
- **All implementation gates are on HOLD.** Do not start a row until the founder sets it APPROVED in the register.
- Research is not approval, and approval is not implementation. Never record research as built or approved.
- Nothing from Orchester, Mastra, Presidio, or any sample has been copied, installed, or run. They are references.
- Stack is only proposed: TypeScript service layer + Postgres (D-14, unapproved).

## 2. Founder-fixed rules (not negotiable)

1. Exactly four agents: **Intake, Processing, Quality Control, Reporting**. Never rename, add, or replace one.
2. Per-agent folder with `AGENT.md` and `skills/<skill-name>/SKILL.md` per skill. Proposed folders: `agents/intake`, `agents/processing`, `agents/quality-control`, `agents/reporting`; shared `contracts/`.
3. Claude Code development skills (`.claude/`) are never loaded as production skills.
4. No vertical, customers, pricing, or integrations may be invented. Unknowns stay **TBD**.

## 3. Agent structure

| Agent | Job | Output contract | MVP |
|---|---|---|---|
| Intake | Verify, mask, classify, extract inbound requests | `work_item.v1` | Yes (shadow mode, proposed) |
| Processing | Plan and do the work; build candidate with evidence | `candidate_result.v1` | Stub receiver only |
| Quality Control | Check candidate; pass, rework, or escalate; cannot edit it | `qc_verdict.v1` | No |
| Reporting | Reports from aggregated data; no personal data | `report.v1` | No |

Handoffs use a versioned, validated envelope; agents never read each other's raw conversations. Skill names are placeholders until D-01.

## 4. Single owner per layer (no duplicates)

| Layer | One owner (register row) | Origin / reference | Status |
|---|---|---|---|
| Tenant isolation | Postgres forced row-level security + restricted role (FND-02) | Orchester `apps/web/lib/tenant/context.ts`, migrations 0006, 0007, 0009 | ADAPT, PENDING |
| Audit trail | Hash-chained `audit_events` (FND-03) | Orchester `apps/web/lib/audit/chain.ts` | ADAPT |
| Duplicate protection | Workspace-scoped idempotency (FND-04) | Orchester `idempotency.ts`, migration 0015 | ADAPT |
| Skill loading and validation | One loader/validator (FND-14) | Mastra `packages/core/src/workspace/skills/*` pattern; Agent Skills spec | ADAPT |
| Model access (the "brain" gateway) | One model gateway (FND-17) | Vercel AI SDK / Instructor ideas | PENDING |
| Personal-data detection | One detector service (INT-06) | Presidio | PENDING |
| Raw-value storage | One vault (INT-08) | None found | BUILD |
| Tool permissions | One tool gateway (FND-16, FND-24) | Mastra `tools/toolchecks.ts` (flags only) | BUILD / ADAPT |
| Approver identity | One approval record (FND-07) | None adequate | BUILD |
| Pause/resume | One engine (FND-05) | Mastra core + `stores/pg`, or our own | PENDING (D-05) |
| Job runner | One worker (FND-08) | Orchester `apps/web/worker/index.ts` job list | BUILD |
| Customer UI shell | One shell (UI-01) | Custom; Refine/react-admin PENDING | BUILD |

## 5. Rules against duplicate implementations

1. **One of each layer.** Before adding a brain (model/agent loop), backend service, frontend shell, or database access path, find its owner row above. If one exists, extend it; do not create a second.
2. **One database, one tenant mechanism.** No second tenant-filtering scheme, no application-only isolation, no second audit or idempotency store.
3. **One brain.** All model calls go through the model gateway. No agent calls a provider SDK directly. No second agent framework alongside the chosen one.
4. **One frontend shell.** Do not mix Orchester pages, Refine, and react-admin in the customer app. Client-side permission checks are never security.
5. **One skill system.** All production skills use the folder rules above. No second skill format or loader.
6. **One workflow/pause-resume engine.** Decide PRC-01 and D-05 once; do not run Orchester flows and Mastra workflows together.
7. **Merged rows stay merged:** FND-18, INT-15, PRC-02, QC-03, QC-04, UI-04 no longer exist (see register section 15).
8. A new component needs a new register row, a verification level, and founder approval first.

## 6. Security rules (apply to every change)

- Every tenant table carries `workspace_id` with forced row-level security; the runtime role has no bypass; the service refuses to start under a bypass-capable role; missing tenant context fails closed.
- **Raw personal data exists only in the encrypted vault.** Models, logs, traces, analytics, queues, and UI receive masked text only.
- No message body or raw value in any log, trace, metric, or error output. Wrap third-party exceptions (Instructor logs full messages).
- Inbound requests are authenticated (signature/secret + replay window), deduplicated, rate-limited, and acknowledged fast; work runs on a queue.
- Inbound text is untrusted: it never widens tools or permissions. Tools are allow-listed by a gateway; `allowed-tools` in `SKILL.md` is advisory only.
- Fail closed: detector outage, parse failure, schema failure, or cap hit means `needs-human`, never an unmasked model call.
- Anyone holding a run id must **not** be able to approve; our API checks approver identity, role, workspace, and action first.
- No secrets in code, logs, or the database. Detector and database are on private networks (Presidio ships no auth).
- The exposed GitHub token is treated as compromised until the founder confirms revocation. Never print credentials.

## 7. Dependencies and licenses

| Item | Rule |
|---|---|
| Orchester (`lucasmailland/orchester`, Apache-2.0) | Patterns and selected files after review; young, small project; assumed to be the intended "Orchester" (unconfirmed) |
| Mastra (`mastra-ai/mastra`) | Apache-2.0 outside `ee/`. **`ee/` code is enterprise-licensed and barred from hosted use without an agreement: do not use.** `@mastra/core` imports from an `ee` path (FND-06, legal question open). Version seen: `1.80.0-alpha.2` |
| Presidio (`data-privacy-stack/presidio`, MIT) | Moved from `microsoft/presidio`; pin versions and image digests; Python service; English by default |
| Agent Skills spec / `skills-ref` (Apache-2.0) | Spec text license under `docs/` not read; `skills-ref` is demo-only |
| AWS sample (MIT-0) | Design reference only; its code and infrastructure are rejected |
| `anthropics/skills` document skills | Proprietary; do not use |
| Dify | Modified license bars hosted multi-tenant use; do not use as a base |
| Instructor TypeScript port | Stale; do not depend on it |

## 8. Pre-code checklist (mandatory; stop if any answer is "no")

- [ ] The work maps to a register row, and that row's Founder status is **APPROVED**.
- [ ] Its dependencies (register Dependencies column and section 16 steps) are done or approved.
- [ ] Every decision it depends on (D-nn) is recorded; no TBD is being guessed.
- [ ] No other component already owns this layer (section 4); no duplicate is being created.
- [ ] License of any source is checked; no `ee/` or proprietary code is involved.
- [ ] Source files to be adapted were actually read (verification level V1), or the gap is recorded.
- [ ] Tenant isolation, masking, and logging rules (section 6) are respected, with tests named.
- [ ] Acceptance tests (AT-nn) are identified before code is written.
- [ ] Only the approved files are touched; no installs, commits, pushes, or deploys without explicit founder instruction.
- [ ] The register and this file are updated if status or design changed.

## 9. Approval gates

| Gate | Rule |
|---|---|
| G1 | A TBD item cannot be built against until the founder records a decision |
| G2 | Each register row needs Founder status APPROVED before implementation |
| G3 | Each phase passes its acceptance tests before the next starts |
| G4 | No real customer data until export/delete and the personal-data recall gate pass |
| G5 | Production deployment needs explicit founder approval (not authorized) |

## 10. Unresolved decisions (all TBD, none approved)

| ID | Decision |
|---|---|
| D-01 | Vertical, customer, final skill names; confirm "Orchester" = `lucasmailland/orchester` |
| D-02 | The one inbound channel for the pilot |
| D-03 | May any personal-data check use a cloud service |
| D-04 | Accuracy, recall, and retry targets |
| D-05 | Mastra pause/resume vs. building our own (not needed for the pilot) |
| D-06 | QC blocks or only recommends; rework limit |
| D-07 | Skill contract sidecar format |
| D-08 | Who approves what; who sees unmasked values |
| D-09 | Buy or build the audit viewer |
| D-10 | Customer app style and UI approach |
| D-11 | Languages, countries, personal-data types, retention, compliance |
| D-12 | Pricing and credits |
| D-13 | Pilot is shadow mode with synthetic data (proposed; not yet in the register) |
| D-14 | TypeScript + Postgres (proposed; not yet in the register) |

## 11. First build steps (proposal only; all on HOLD)

S-01 decisions → S-02 agent folders → S-03 tenant wall → S-04 secrets → S-05 audit → S-06 idempotency → S-07 safe logging → S-08 skill loader → S-09 model gateway → Intake S-17 to S-24 (vault, detector, masking, policy, one channel, route, skills, evaluation gate). The Intake MVP's exit is acceptance tests **AT-01 to AT-22** (`docs/blueprint/DEPLOYMENT_TESTING.md`).

## 12. Where things live

`docs/MASTER_BUILD_REGISTER.md` (source of truth, section 16 = build order) · `docs/BUSINESS_BLUEPRINT.md` (index) · `docs/blueprint/` (14 design documents) · this file.
