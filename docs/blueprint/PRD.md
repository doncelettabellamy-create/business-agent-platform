# Product Requirements Document (PRD)

> **Status: DRAFT design document. Not approved. Not implemented.** All implementation gates are on HOLD.
> Sources: `docs/BUSINESS_BLUEPRINT.md` (section 2), `docs/MASTER_BUILD_REGISTER.md`.
> **TBD** = unresolved founder decision. No vertical, customers, pricing, or integrations are assumed.

## 1. Purpose and scope

Defines what the platform must do, split into the first Intake pilot (MVP) and later releases. Requirement IDs (PRD-nn) are traced to register rows and build steps (S-nn). Behavior that depends on the vertical is written generically ("request", "category", "field") until D-01 is decided.

## 2. Users and roles (proposed; confirm under D-08)

| Role | Can do (MVP) | Can do (Later) |
|---|---|---|
| Customer admin | Sign in; view their tenant's masked work items | Configure categories and rules; approve actions; see usage and audit |
| Customer staff | View their tenant's masked work items | View reports; approve if permitted |
| End contact | Send a message through the one TBD channel (not a product user) | Receive replies after approval |
| Platform admin | Operate the platform; view operational metrics; no raw personal data by default | Support access under a logged, time-boxed procedure (TBD) |

## 3. Functional requirements

Phase: **MVP** = the smallest Intake pilot (see `DEPLOYMENT_TESTING.md` for tests). **Later** = after the pilot.

### 3.1 Platform and structure

| ID | Requirement | Acceptance criteria | Phase | Rows | Steps | Tests |
|---|---|---|---|---|---|---|
| PRD-01 | The platform has exactly four agents named Intake, Processing, Quality Control, Reporting, each with `AGENT.md` and `skills/<skill-name>/SKILL.md` folders | A structure check passes with exactly four agent folders; a fifth or misnamed folder fails | MVP | FND-26 | S-02 | AT-01 |
| PRD-02 | Skills are validated before they can run | Skills with unknown keys, mismatched names, oversize bodies, or missing sidecars are rejected; valid skills load | MVP | FND-14 | S-08 | AT-02 |
| PRD-03 | Every record belongs to one tenant, and no tenant can read another's data | Cross-tenant reads and writes return nothing; missing tenant context fails closed; the app refuses to start under a superuser database role | MVP | FND-02, FND-25 | S-03 | AT-03, AT-04 |

### 3.2 Intake

| ID | Requirement | Acceptance criteria | Phase | Rows | Steps | Tests |
|---|---|---|---|---|---|---|
| PRD-04 | Inbound messages are authenticated, deduplicated, and acknowledged quickly | Forged, unsigned, stale, or wrong-secret requests are rejected and audited without body; duplicate delivery yields one work item; acknowledgement within the provider's limit (TBD, D-02) | MVP | INT-01 or INT-02, INT-03, FND-04, FND-12 | S-06, S-21, S-22 | AT-05, AT-06, AT-07 |
| PRD-05 | Personal data is detected and masked before any model call; raw values live only in an encrypted vault | No synthetic raw value appears in any model request; vault has no plaintext at rest; detector recall meets target (TBD, D-04) | MVP | INT-06, INT-07, INT-08, INT-09 | S-17 to S-20 | AT-08, AT-09, AT-10 |
| PRD-06 | Intake classifies each request and extracts fields against a versioned contract | Every saved item validates against `work_item.v1`; accuracy meets target (TBD, D-04) | MVP | INT-05, INT-12, FND-17 | S-09, S-23 | AT-14, AT-19 |
| PRD-07 | Uncertain, invalid, or unparseable results are flagged for a person | Items with failed validation, low confidence, parse failure, or detector outage become `needs-human`; none are marked `ready` | MVP | INT-09, INT-12 | S-20, S-23 | AT-12, AT-13 |
| PRD-08 | Intake produces a validated hand-off to Processing | A valid envelope is accepted by the Processing stub; an unsupported contract version is rejected | MVP (stub receiver) | INT-12, PRC-06 | S-23 | AT-20 |

### 3.3 Cross-cutting

| ID | Requirement | Acceptance criteria | Phase | Rows | Steps | Tests |
|---|---|---|---|---|---|---|
| PRD-09 | Every state change is recorded in a tamper-evident audit log | An altered audit row is detected; concurrent appends do not fork the chain | MVP | FND-03 | S-05 | AT-15 |
| PRD-10 | Logs never contain message bodies or raw personal data | A search of all outputs after the suite finds no synthetic raw values and no bodies | MVP | FND-19 | S-07 | AT-11 |
| PRD-11 | Prompt-injection attempts in inbound text do not trigger tools or vault access | Injection fixtures cause no tool call and no vault access; item is flagged | MVP | INT-12, INT-09 | S-23 | AT-17 |
| PRD-12 | Each run has a token cap; a global kill switch stops all model calls | Run stops at the cap; with the switch on, no model call occurs | MVP | FND-17 | S-09 | AT-18 |
| PRD-13 | Pilot mode sends nothing outbound and writes to no outside system (shadow mode) | Egress monitoring shows only the model provider, detector, and database | MVP (if D-13 approved) | FND-26, INT-12 | S-23 | AT-16 |
| PRD-14 | Staff see a read-only list of their tenant's masked work items | Staff of tenants A and B see only their own items; no unmask control exists | MVP | UI-01 (reduced) | part of S-27 | AT-21 |
| PRD-15 | Work survives a restart without duplicates | Killing the process mid-run leads to completion once or retry without a duplicate item | MVP | FND-04, FND-08 | S-06, S-13 | AT-22 |

### 3.4 Later releases

| ID | Requirement | Rows | Steps |
|---|---|---|---|
| PRD-16 | Processing plans work, retrieves tenant knowledge, and assembles candidate results with evidence | PRC-01, PRC-03, PRC-04, PRC-05 | S-29 to S-33 |
| PRD-17 | No external delivery without a Quality Control verdict | QC-01, QC-02 | S-34, S-35 |
| PRD-18 | Risky actions need a named, authorized approver; the approval is recorded with reason and expiry | FND-07, FND-23, FND-24 | S-10, S-11 |
| PRD-19 | Work can pause for approval and resume once after a restart | FND-05 | S-12 |
| PRD-20 | Reporting builds status reports and alerts from aggregated data with no personal data | RPT-01, RPT-02 | S-36, S-37 |
| PRD-21 | Per-tenant spend caps, quotas, and metering | FND-09 | S-15 |
| PRD-22 | Customer data export and deletion, including vault entries | FND-13 | S-26 |
| PRD-23 | Customer-facing screens: approval inbox, dashboards, audit viewer | UI-01 to UI-03, RPT-03, RPT-04 | S-27, S-38 to S-40 |
| PRD-24 | Non-English support | INT-14 | S-25 |
| PRD-25 | Customer API keys with scopes | FND-11 | S-41 |

## 4. Non-functional requirements

All numeric targets are **TBD** until the founder sets them.

| ID | Area | Requirement | Target |
|---|---|---|---|
| NFR-01 | Isolation | Fail closed when tenant context is missing | Mandatory |
| NFR-02 | Privacy | No raw personal data in model input, logs, analytics, or audit | Mandatory |
| NFR-03 | Availability | Inbound endpoint uptime | TBD |
| NFR-04 | Latency | Acknowledge within the provider limit; end-to-end processing time | TBD (D-02) |
| NFR-05 | Accuracy | Classification, extraction, personal-data recall | TBD (D-04) |
| NFR-06 | Cost | Per-run token cap; per-tenant spend cap | TBD (D-12) |
| NFR-07 | Retention | Messages, vault, audit, logs | TBD (D-11, legal review) |
| NFR-08 | Auditability | Every state change traceable by correlation id | Mandatory |
| NFR-09 | Accessibility | Standard to meet | TBD |
| NFR-10 | Localization | Languages supported | English only for the pilot; others TBD (D-11) |

## 5. User stories (generic, vertical-neutral)

| ID | Story | Maps to |
|---|---|---|
| US-01 | As a customer admin, I want incoming requests turned into structured items so that staff do not retype them. | PRD-06 |
| US-02 | As a customer admin, I want personal details hidden from everyone who does not need them so that we reduce exposure. | PRD-05 |
| US-03 | As customer staff, I want uncertain items clearly marked so that I know what needs my attention. | PRD-07 |
| US-04 | As a platform admin, I want every action traceable so that I can investigate problems. | PRD-09 |
| US-05 | As the founder, I want nothing sent to customers during the pilot so that mistakes cannot reach them. | PRD-13 |
| US-06 | As a customer admin (Later), I want risky actions to wait for my approval so that I stay in control. | PRD-18 |

## 6. Release plan (no dates)

| Release | Content | Exit |
|---|---|---|
| R0 Decisions | D-01 to D-14 resolved or deferred in writing | Decisions recorded |
| R1 Intake pilot | PRD-01 to PRD-15 | AT-01 to AT-22 pass with founder-set thresholds |
| R2 Processing + QC | PRD-16 to PRD-19 | Acceptance tests to be written |
| R3 Reporting + billing + deletion | PRD-20 to PRD-22 | Acceptance tests to be written |
| R4 Scale | PRD-23 to PRD-25 | TBD |

## 7. Out of scope (MVP)

Customer replies and outbound actions, approvals, pause/resume, Processing/QC/Reporting logic, billing, plans, non-English, deletion and export, dashboards, any integration beyond the single TBD channel.

## 8. Assumptions (all unapproved)

1. Shadow-mode pilot with synthetic data (D-13).
2. TypeScript service layer and Postgres (D-14).
3. One channel, one tenant for the pilot (D-02).
4. Skill names are placeholders (D-01).

## 9. Completeness of this document

| Part | Status |
|---|---|
| MVP requirements PRD-01 to PRD-15 with criteria and tests | Complete for the proposed MVP |
| Later requirements PRD-16 to PRD-25 | **Incomplete: no acceptance criteria; depend on D-01, D-05, D-06, D-08, D-12** |
| Numeric NFR targets | **Incomplete: TBD** |
| Vertical-specific requirements | **Not started (D-01)** |
