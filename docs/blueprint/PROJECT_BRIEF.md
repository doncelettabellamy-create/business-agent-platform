# Project Brief

> **Status: DRAFT design document. Not approved. Not implemented.** All implementation gates are on HOLD.
> Sources: `docs/BUSINESS_BLUEPRINT.md` (section 1), `docs/MASTER_BUILD_REGISTER.md`.
> Markers: **TBD** = unresolved founder decision, not approved. **FC-nn** = founder-fixed constraint. **D-nn** = open decision (register section 10; D-13 and D-14 are proposed in the blueprint and not yet in the register).
> Sibling documents: `PRD.md`, `AGENT_SPECS.md`, `ARCHITECTURE.md`, `SECURITY_PII.md`, `DEPLOYMENT_TESTING.md`.

## 1. One-paragraph summary

business-agent-platform is a multi-tenant SaaS in which exactly four coordinated agents (**Intake, Processing, Quality Control, Reporting**) take a request from first contact to a reported outcome. Personal data is masked before any model sees it, every action is recorded in a tamper-evident log, and a named person approves risky actions. **The business vertical, customers, pricing, and customer integrations are not yet decided (all TBD).** The first deliverable is a small, safe Intake pilot.

## 2. What is fixed vs. what is open

### 2.1 Fixed by the founder

| ID | Fixed item | Consequence |
|---|---|---|
| FC-01 | The agents are named Intake, Processing, Quality Control, Reporting | Names are never changed in code, docs, folders, or UI. |
| FC-02 | One folder per agent, each with `AGENT.md` and `skills/<skill-name>/SKILL.md` | Folder layout is a hard requirement (acceptance test AT-01). |
| FC-03 | Claude Code development skills are separate from customer-facing production agents | Production skills are never loaded from `.claude/`. |
| FC-04 | Research is never recorded as built or approved | Every document states its status. |

### 2.2 Open (TBD) and who decides

| Topic | Status | Decision |
|---|---|---|
| Business vertical: what is processed, for whom | **TBD** | D-01 |
| Target customer profile and size | **TBD** | D-01 |
| Customer integrations and inbound channels | **TBD** | D-02 |
| Whether cloud services may be used for personal-data checks | **TBD** | D-03 |
| Accuracy, recall, and retry targets | **TBD** | D-04 |
| Mastra engine vs. building our own pause/resume | **TBD** (not needed for the pilot) | D-05 |
| Block-or-recommend policy for Quality Control | **TBD** | D-06 |
| Skill contract sidecar format | **TBD** | D-07 |
| Who approves what; who sees unmasked values | **TBD** | D-08 |
| Reporting audit viewer: buy or build | **TBD** | D-09 |
| Customer app style (branded product vs. back-office) | **TBD** | D-10 |
| Languages, countries, regulated data types | **TBD** | D-11 |
| Pricing, plans, credits | **TBD** | D-12 |
| Pilot runs in shadow mode with synthetic data | **TBD, proposed** | D-13 |
| Stack: TypeScript service layer and Postgres | **TBD, proposed** | D-14 |
| Revenue targets, market size, competitors, go-to-market | **TBD, not researched** | not yet assigned |

## 3. Problem and value (to be completed by the founder)

These fields cannot be written without D-01. They are deliberately blank.

| Field | Value |
|---|---|
| Who has the problem | TBD |
| What it costs them today | TBD |
| Why four agents rather than one | TBD |
| What a successful month looks like | TBD |
| Why customers would pay | TBD |

## 4. Proposed positioning (not approved)

"Governed autonomy": agents do routine work; personal data is protected by design; every step is traceable; risky actions need a person. This comes from research on:

- Orchester (`lucasmailland/orchester`, Apache-2.0): tenant security and audit patterns.
- Mastra (`mastra-ai/mastra`): skill loading and pause/resume patterns.
- Portarium (`45ck/Portarium`, MIT): policy tiers and evidence trails (README only).

None of these positions is validated with customers.

## 5. Scope

### 5.1 First release: Intake pilot (proposed, depends on D-13)

| In scope | Out of scope |
|---|---|
| One tenant, one inbound channel (TBD, D-02), synthetic data | Customer replies or any outbound action |
| Verification, deduplication, tenant isolation | Approvals and pause/resume |
| Personal-data detection, masking, encrypted vault | Processing, Quality Control, and Reporting logic |
| Classification and extraction against a versioned contract | Billing, plans, quotas |
| Tamper-evident audit log | Non-English support |
| Read-only list of masked work items | Customer deletion and export |
| Hand-off to a Processing stub | Any customer integration beyond the one TBD channel |

### 5.2 Later phases (proposed order, no dates)

| Phase | Content | Exit gate |
|---|---|---|
| 0 | Founder decisions (S-01) | Decisions recorded |
| 1 | Minimal foundation (S-02 to S-16, reduced for pilot) | Foundation tests pass |
| 2 | Intake pilot (S-17 to S-24) | AT-01 to AT-22 pass with founder-set thresholds |
| 3 | Processing (S-29 to S-33) | Candidate results carry evidence |
| 4 | Quality Control (S-34, S-35) | No delivery without a verdict |
| 5 | Reporting (S-36 to S-39) | Figures reconcile with audit and ledger |

No dates or durations are set. Every phase needs founder approval before implementation.

## 6. Guiding principles

1. Safety before features: tenant isolation, personal-data protection, and audit come first.
2. Fail closed: when unsure, stop and ask a person.
3. Research is not approval; approval is not implementation.
4. Borrow patterns, not unreviewed code. Nothing from Orchester or Mastra has been copied or installed.
5. Keep customer-facing production agents separate from developer tooling.
6. Smallest runnable step first, with exact acceptance tests.

## 7. Stakeholders and roles (proposed; confirm under D-08)

| Role | Interest |
|---|---|
| Founder | Decides all TBD items; approves each register row |
| Customer admin | Configures a tenant; approves risky actions (Later) |
| Customer staff | Reads work items and reports |
| End contact | Sender of inbound messages; not a product user |
| Platform admin | Operates the platform; no raw personal-data access by default |

## 8. Success measures

| Level | Measure | Target |
|---|---|---|
| Pilot, technical | AT-01 to AT-22 pass | Thresholds TBD (D-04) |
| Pilot, safety | Zero cross-tenant reads; zero raw personal data in logs or model input | Absolute (no tolerance) |
| Pilot, quality | Classification and extraction accuracy; personal-data recall | TBD (D-04) |
| Business | Activation, retention, revenue, time saved | TBD (D-01, D-12) |

## 9. Key risks

| Risk | Impact | Mitigation | Owner |
|---|---|---|---|
| Vertical undecided | Cannot write categories, templates, or synthetic data | Founder decision D-01 | Founder |
| Missed personal data reaches a model provider | Privacy incident | Mask before any model call; measure recall; park uncertain items for a person | Platform |
| Cross-tenant data leak | Severe | Forced row-level security, CI guard, leak tests | Platform |
| Mastra enterprise-license ambiguity | Legal exposure | Pilot avoids Mastra engine and `ee/` code; written question to Mastra | Founder |
| Reliance on small, young projects (Orchester) | Maintenance risk | Borrow patterns, keep own code | Platform |
| Demo-quality references (AWS sample, `skills-ref`) | Weak controls | Use as design references only | Platform |
| Old GitHub token not confirmed revoked | Credential exposure | Founder revokes it on GitHub | Founder |

## 10. Source components considered (reference only; none adopted)

| Source | Role | Register rows |
|---|---|---|
| Orchester | Tenant wall, audit chain, idempotency, channel helpers | FND-02, FND-03, FND-04, INT-01, INT-02 |
| Mastra | Skill-loader pattern; later pause/resume | FND-14, FND-05 (Later) |
| Presidio | Personal-data detection and masking | INT-06, INT-07 |
| Instructor / Vercel AI SDK | Structured output ideas | INT-05, FND-17 |
| AWS sample | Labelling and fail-closed design only | INT-09 |
| Refine / react-admin | Candidate UI frameworks (PENDING) | UI-02, UI-03 |

## 11. Completeness of this document

| Part | Status |
|---|---|
| Fixed constraints, scope, phases, principles, risks | Complete for the current research |
| Problem, value, customers, pricing, market, targets | **Incomplete: waiting on founder (D-01, D-12)** |
