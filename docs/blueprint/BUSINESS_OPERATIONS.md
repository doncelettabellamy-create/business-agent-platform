# Business Operations

> **Status: DRAFT design document. Not approved. Not implemented.** No team, process, or tool described here exists yet. All implementation gates are on HOLD.
> Sources: `docs/BUSINESS_BLUEPRINT.md` (section 13), `docs/MASTER_BUILD_REGISTER.md`.
> **No customers, pricing, contracts, staffing, or integrations are assumed.** Anything commercial is **TBD**.

## 1. Purpose

Describes how the business and platform would be run day to day once built, and which approval gates control the work. It covers decision governance, delivery control, security hygiene, support, incidents, change management, vendor and license management, and customer lifecycle placeholders.

## 2. Operating model

### 2.1 Roles (proposed; staffing TBD)

| Role | Responsibility | Status |
|---|---|---|
| Founder | Owns all TBD decisions; approves each register row; owns legal and commercial matters | Exists |
| Engineering | Builds approved rows only | TBD (who) |
| Security/privacy owner | Reviews controls, incidents, vendors | TBD (who) |
| Support | Handles customer questions | TBD |
| On-call responder | Responds to critical alerts | TBD |
| Platform admin | Operates the platform; no raw personal-data access by default | TBD |

### 2.2 Governance gates

| Gate | Rule |
|---|---|
| G1 Decision gate | A TBD item cannot be built against until the founder records a decision |
| G2 Row approval | Each register row needs Founder status APPROVED before implementation starts |
| G3 Phase gate | Each build phase passes its acceptance tests before the next starts |
| G4 Data gate | Real customer data is not used until deletion/export (PRD-22) and the personal-data recall gate pass |
| G5 Release gate | Production deployment needs explicit founder approval |

Status today: every row is Founder-PENDING and Build-NOT STARTED; all gates are on HOLD.

## 3. Immediate actions (not engineering)

| # | Action | Owner | Source |
|---|---|---|---|
| 1 | Revoke the exposed GitHub token on GitHub; check local history copies | Founder | Register section 13 |
| 2 | Decide D-01, D-02, D-03, D-04, D-11, D-13, D-14 (pilot scope) | Founder | Register section 10, blueprint 17 |
| 3 | Send the written question to Mastra on hosted use of `@mastra/core` (only if Mastra's engine is considered later) | Founder | FND-06 |
| 4 | Confirm that "Orchester" means `lucasmailland/orchester` | Founder | D-01 |
| 5 | Obtain legal advice on personal-data obligations before real data | Founder | D-11 |

## 4. Runbooks (to be written)

Each runbook uses the template in `TEMPLATES.md` (trigger, impact, first checks, safe actions, escalation, evidence, closure).

| ID | Runbook | Trigger |
|---|---|---|
| RB-01 | Detector outage | Detector down |
| RB-02 | Model provider outage | Provider errors |
| RB-03 | Queue backlog | Depth or age alert |
| RB-04 | Suspected cross-tenant leak | Safety alert |
| RB-05 | Audit-chain failure | Verification mismatch |
| RB-06 | Secret rotation | Schedule or incident |
| RB-07 | Cost spike | Cost alert |
| RB-08 | Customer deletion/export | Request received (Later) |
| RB-09 | Skill rollback | Regression after release |
| RB-10 | Kill switch use | Safety or cost event |

## 5. Incident management

| Severity | Definition (proposed) | Response |
|---|---|---|
| Sev 1 | Cross-tenant exposure, raw personal data exposed, audit tampering | Immediate: kill switch, preserve evidence, founder informed |
| Sev 2 | Pipeline down; detector or provider outage with parked items | Respond promptly; communicate status |
| Sev 3 | Degraded quality or cost anomaly | Next business day |
| Sev 4 | Minor | Backlog |

Response times, notification duties to customers or regulators, and communication templates are **TBD (D-11)**.

Process: detect → classify → contain → preserve evidence → investigate → fix → notify as required → record and follow up. Records carry classes of data affected, never values.

## 6. Change management

| Change type | Controls |
|---|---|
| Code | Review; CI gates (`DEPLOYMENT_TESTING.md`); only approved rows |
| Database migration | Forward-only; rollback plan; reviewed for row-level security and audit protection |
| Skill or prompt change | Versioned; evaluation gate must not regress accuracy or recall; release note; rollback path |
| Contract change | Version bump; receivers advertise accepted versions |
| Model or provider change | Re-run the evaluation sets; check data-use terms (D-03) |
| Configuration and secrets | Via the secrets service; audited |
| Third-party component adoption | Requires register row approval, license review, version pin |

## 7. Skill release process

| Phase | Steps |
|---|---|
| MVP | Skills are repository files; CI validates structure and contracts |
| Later | Signed, content-hashed bundles; staging evaluation; shadow mode; canary tenants; general release; rollback by repinning (FND-15) |

Development skills under `.claude/` are never packaged or released to tenants (FC-03).

## 8. Support model (TBD)

| Item | Status |
|---|---|
| Channels, hours, tiers | TBD |
| Access to customer data for support | Proposed: none to raw personal data; masked views only; time-boxed and logged |
| Escalation path to engineering | TBD |
| Knowledge base | Not started |

## 9. Customer lifecycle (placeholders)

| Stage | Content | Status |
|---|---|---|
| Acquisition | Marketing, sales | **TBD, not researched** |
| Onboarding | See `USER_FLOWS.md` F-05 | **TBD (D-01, D-02)** |
| Operation | Usage, support, reporting | TBD |
| Billing | Plans, invoicing, dunning | **TBD (D-12)** |
| Offboarding | Export and deletion (F-08) | Design outline |

## 10. Commercial operations (all TBD)

Pricing, plans, credits, invoicing, taxes, contracts, terms of service, privacy policy, data processing agreements, customer agreements, partner agreements: **not started**. Do not publish or state any figure until D-12 is decided.

## 11. Vendor, license, and dependency management

| Item | Rule |
|---|---|
| Register | `docs/MASTER_BUILD_REGISTER.md` is the source of truth for components, licenses, and verification levels |
| Licenses | Apache-2.0, MIT, and MIT-0 sources noted per row. Mastra `ee/` code is enterprise-licensed and not used. `anthropics/skills` document skills are proprietary and not used. Dify's modified license bars hosted multi-tenant use without authorization |
| Reviews | Legal review of licenses before adoption (none done) |
| Pinning | Pin versions and image digests; verify ownership for moved projects (Presidio) |
| Model and cloud vendors | Data-use terms, regions, retention reviewed under D-03 and D-11 |
| Maintenance risk | Orchester and Mastra pieces are young; borrow patterns, own the code |

## 12. Business continuity

| Topic | Status |
|---|---|
| Backups and tested restore (database, vault, keys) | TBD |
| Disaster recovery targets | TBD |
| Key custody and recovery | TBD (FND-10) |
| Provider outage plan | Fail closed and park items (design); detailed plan TBD |

## 13. Metrics for operations review

Uptime vs. SLO (TBD), incident count by severity, time to detect and resolve, cost per item, skill regressions, leak canary results, open decisions count, rows approved vs. implemented.

## 14. Component ownership

| Operational capability | Owner | Reference | Row |
|---|---|---|---|
| Job scheduling (verify audit, cleanup, retention, deletion) | Worker | Orchester `apps/web/worker/index.ts` job list (V1) | FND-08 |
| Export and deletion | `src/gdpr/*` | Orchester `lib/gdpr/*`, `tenant/hard-delete-job.ts` (V3) | FND-13 |
| Skill release | CI and loader | Mastra `publish.ts` (V1), versioning files (V3) | FND-14, FND-15 |
| Decision records | `docs/` ADRs | Orchester ADR practice (V3) | FND-21 |
| Spend control | Model gateway, billing | Orchester `lib/billing/*` (V3) | FND-09 |

## 15. Operations acceptance checks

| Check | Method |
|---|---|
| Kill switch works within the target time (TBD) | AT-18 plus a drill |
| Runbooks exist for each safety alert | Review before any customer data |
| Deletion removes all raw values | PRD-22 test (Later) |
| Skill rollback restores a prior version | Test in staging (Later) |
| Token revocation confirmed | Founder attests |

## 16. Completeness of this document

| Part | Status |
|---|---|
| Governance gates, immediate actions, incident and change processes | Complete as a proposal |
| Runbooks | **Headings only** |
| Staffing, support, on-call | **Incomplete: TBD** |
| Commercial operations, pricing, legal documents, go-to-market | **Not started (D-01, D-12)** |
| Business continuity | **Incomplete: TBD** |
