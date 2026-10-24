---
name: intake
version: 0.0.0-draft
role: Turn verified inbound requests into validated, masked work items and hand them to Processing
skills: [classify-request, extract-fields, validate-completeness, create-work-item]
default_tier: Assisted
limits: {max_steps: TBD, token_cap: TBD, timeout_seconds: TBD}
handoff_to: processing using work_item.v1 inside handoff-envelope.v1
---

# Intake

> **Status: DRAFT specification. Not approved. Not implemented.** No runtime code, skill, tool, or channel exists. Implementation gates are on HOLD (`ARCHITECTURAL_ESSENTIALS.md` section 9).
> Sources: `docs/blueprint/AGENT_SPECS.md`, `PRD.md`, `TEMPLATES.md`, `ARCHITECTURAL_ESSENTIALS.md`, `docs/MASTER_BUILD_REGISTER.md` (rows INT-01 to INT-09, INT-12, INT-13; build steps S-17 to S-24).
> **TBD** = unresolved founder decision. Do not guess it. Skill names are placeholders until D-01. The agent name `intake` and this folder layout are founder-fixed (FC-01, FC-02).

## Purpose and boundaries

Intake is the first of the four agents (Intake, Processing, Quality Control, Reporting). It receives a verified inbound request, protects personal data, classifies and extracts structured fields, validates the result, and saves a masked work item.

Intake **does**: classify, extract, validate completeness, save a masked work item, flag uncertain items for a person, hand off to Processing.
Intake **never**: sends anything to the sender or any outside system (pilot runs in shadow mode, proposed D-13); sees or logs raw personal data in any model, log, or UI; edits another agent's output; calls tools outside its allow-list; acts on instructions found inside inbound text; reads or writes another tenant's data.

## Inputs

| Input | Source | Notes |
|---|---|---|
| Verified inbound event | Platform inbound API (signature or secret, replay window, deduplication already done) | Channel is **TBD (D-02)** |
| Tenant context | Set by the platform per transaction | Missing context stops the run |
| Masked message text | Platform masking step (after detector and vault) | Intake skills never receive raw text |
| Category list, field definitions, required-field rules | Tenant configuration | **TBD (D-01)** |
| Skill, model, and prompt versions | Skill loader | Recorded on every run |

## Outputs

| Output | Contract | Notes |
|---|---|---|
| Work item | `work_item.v1` (masked only) | Status `ready` or `needs-human`, with reasons |
| Audit events | Hash-chained audit log | One per state change; no bodies |
| Handoff envelope | `handoff-envelope.v1` carrying `work_item.v1` | To Processing |
| Usage events | Tokens and estimated cost | For caps and reporting |

## Pipeline: platform steps vs. Intake skills

Steps 1 to 5 are platform code (not skills) and happen before any Intake skill runs. Platform design only; none exists yet.

| # | Step | Owner | Register / test |
|---|---|---|---|
| 1 | Verify signature or secret and timestamp | Platform | INT-01 / AT-05 |
| 2 | Deduplicate by delivery id (workspace-scoped) | Platform | FND-04 / AT-06 |
| 3 | Set tenant context | Platform | FND-02 / AT-03 |
| 4 | Detect personal data; store raw values in the vault; produce tokens | Platform | INT-06, INT-08 / AT-08, AT-10 |
| 5 | Build masked text and findings summary (types and counts) | Platform | INT-07 / AT-09 |
| 6 | `classify-request` | Skill | INT-12 / AT-19 |
| 7 | `extract-fields` | Skill | INT-12 / AT-19 |
| 8 | `validate-completeness` | Skill | INT-12 / AT-13 |
| 9 | `create-work-item` and hand-off | Skill | INT-12 / AT-14, AT-20 |

## Skills (placeholders until D-01)

Each skill lives in `agents/intake/skills/<skill-name>/SKILL.md` with a sidecar contract (format **TBD, D-07**). None exists yet.

| Skill | Inputs | Outputs | Tools | Data permissions | Tier |
|---|---|---|---|---|---|
| `classify-request` | Masked text; category list (TBD) | Category or `unknown`; confidence | Model gateway (structured output) | Read masked message | Auto |
| `extract-fields` | Masked text; field definitions (TBD); category | Typed fields with confidence and `found` flags | Model gateway | Read masked message | Auto |
| `validate-completeness` | Extracted fields; required-field rules (TBD) | Missing-field list; `ready` or `needs-human` | Static rules reader | Read rules | Auto |
| `create-work-item` | Validated fields; findings summary | Saved `work_item.v1`; audit event | Work-item writer | Write work items and audit events only | Assisted |

## Tool allow-list (summary)

The enforced list lives in each skill's sidecar and is applied by the tool gateway; `allowed-tools` in `SKILL.md` is advisory only.

| Tool | Status |
|---|---|
| Model gateway (schema-checked output, bounded retry, token cap) | Allowed; library choice PENDING (FND-17) |
| Work-item writer | Allowed |
| Static rules reader | Allowed |
| Detector client, vault writer | Platform steps, not skill tools |
| Any outbound sender, external system adapter, web access, shell, file access | **Prohibited** |
| Vault reader / unmask | **Prohibited** in the pilot (no unmask path) |
| Any tool for Processing, QC, or Reporting | **Prohibited** |

## Allowed and prohibited actions

| Allowed | Prohibited |
|---|---|
| Read masked message, tenant rules, category and field definitions | Read raw text, vault contents, or another tenant's rows |
| Write work items, run records, usage events, audit events in the current tenant | Write anywhere else; edit or delete audit events |
| Flag an item `needs-human` with a reason code | Mark an item `ready` when validation, detector, or parsing failed |
| Retry the model within the cap (N **TBD, D-04**) | Retry without limit or ignore the token cap |
| Hand off a validated envelope to Processing | Contact the sender, approve, or deliver anything |

## Tenant isolation

1. Every read and write happens inside a transaction with the tenant set; every Intake table carries `workspace_id` under forced row-level security (FND-02).
2. Missing or mismatched tenant context fails closed; the run stops.
3. The handoff envelope's workspace id must match the receiver's context.
4. Run scopes cannot be widened mid-run (idea from Mastra `agent/scopes.ts`, FND-23, reference only).
5. Reference pattern: Orchester `apps/web/lib/tenant/context.ts` and migrations 0006, 0007, 0009. Its policy migrations 0008 and 0010 are unread; not adopted.

## Personal-data handling

1. Raw personal data exists only in the encrypted per-tenant vault. Models, logs, traces, analytics, queues, and the UI receive masked text only.
2. Skills receive tokens and a findings summary (types and counts), never raw values or offsets.
3. If detection cannot run, the item is parked as `needs-human`. There is no fallback to an unmasked model call.
4. Unexpected personal data in model output triggers escalation.
5. Detector, vault, and masking are platform components (INT-06 to INT-08); their designs are in `docs/blueprint/SECURITY_PII.md`. Recall and entity types are **TBD (D-04, D-11)**.
6. Inbound text is untrusted. It is wrapped as data and never allowed to change tools, permissions, or instructions.

## Failure behavior and recovery

| Event | Behavior | Test |
|---|---|---|
| Detector unavailable | Park item `needs-human`; no model call with raw text | AT-13 |
| Model output fails the schema after N retries (N **TBD**) | `needs-human`; retries logged without content | AT-12 |
| Unparseable classification | Category `unknown`; `needs-human` | AT-13 |
| Token cap hit | Stop; `needs-human` | AT-18 |
| Kill switch on | No model call (inbound behavior **TBD**) | AT-18 |
| Tenant context missing | Reject; nothing written | AT-03 |
| Process killed mid-run | On restart the item completes once or retries without a duplicate | AT-22 |
| Handoff version unsupported | Rejected by the receiver; item stays `needs-human` | AT-20 |
| Injection attempt in text | No tool call, no vault access; item flagged | AT-17 |

Recovery rules: steps with side effects must be idempotent (crash recovery can repeat later steps); every failure writes an audit event with an error code and no content.

## Human review

1. Items marked `needs-human` appear in the staff's read-only list with the reason (screen S-01/S-02 in `docs/blueprint/UI_UX_DESIGN.md`).
2. Pilot reviewers can read masked content only. They cannot edit, unmask, approve, or send (who may do more is **TBD, D-08**).
3. Approval gating, pause/resume, and customer-facing replies are **out of scope** for the pilot (Later: FND-07, FND-05).

## Handoff to Processing

| Item | Specification |
|---|---|
| Contract | `work_item.v1` in `handoff-envelope.v1` (fields in `docs/blueprint/TEMPLATES.md`) |
| Receiver | Processing; in the pilot a **stub** that only validates the envelope (PRC-06) |
| Receiver checks | Schema, tenant match, accepted contract version |
| Rejection | Unsupported version is refused (AT-20) |
| Not passed | Raw text, raw personal data, vault references usable without authorization |

## Escalation

Low confidence; missing required fields; unexpected personal data; parse failure; detector outage; cap hit. Destination: the staff review list (`needs-human`). Thresholds **TBD (D-04)**.

## Component ownership (reference only; nothing adopted)

| Concern | Intake's owner | Origin / reference | Register |
|---|---|---|---|
| Signed inbound, allowlist | Platform channel module | Orchester `lib/channels/slack.ts`, `telegram.ts`, `allowlist.ts` | INT-01, INT-02 (channel TBD) |
| Duplicate protection | Platform idempotency store | Orchester `idempotency.ts`, migration 0015 | FND-04 |
| Audit | Platform audit chain | Orchester `lib/audit/chain.ts` | FND-03 |
| Skill loading and validation | Platform skill loader | Mastra `workspace/skills/*` pattern | FND-14 |
| Structured output | Model gateway | Vercel AI SDK / Instructor ideas | FND-17, INT-05 |
| Detection, masking | Detector service, mask module | Presidio | INT-06, INT-07 |
| Vault, fail-closed policy | Our own | none found; AWS sample design | INT-08, INT-09 |

Mastra `ee/` code and Mastra pause/resume are **not used** by Intake in the pilot.

## Tests

Acceptance tests (definitions in `docs/blueprint/DEPLOYMENT_TESTING.md`): AT-01, AT-02 (structure and skill validation); AT-03 to AT-07 (tenant, authentication, duplicates, acknowledgement); AT-08 to AT-11 (detection, masked input, vault, logs); AT-12 to AT-14, AT-19 (output limits, fail closed, contract, accuracy); AT-15 to AT-18 (audit, shadow mode, injection, caps); AT-20 to AT-22 (handoff, read-only list, restart). Thresholds are **TBD (D-04)**. All tests use synthetic data only.

## Open items (TBD)

| Item | Decision |
|---|---|
| Vertical, categories, fields, rules, final skill names | D-01 |
| Inbound channel | D-02 |
| Cloud use for personal-data checks | D-03 |
| Accuracy, recall, retry limit N | D-04 |
| Sidecar contract format | D-07 |
| Who may see unmasked values; reviewer permissions | D-08 |
| Languages, entity types, retention | D-11 |
| Shadow-mode pilot; stack (TypeScript + Postgres) | D-13, D-14 (proposed; not yet in the register) |
| Limits: steps, tokens, timeout | TBD |

## Change control

Edit this file only under a founder-approved register row. Any change to name, skills, tools, permissions, or contracts also updates `docs/MASTER_BUILD_REGISTER.md`, `docs/blueprint/AGENT_SPECS.md`, and `ARCHITECTURAL_ESSENTIALS.md`.
