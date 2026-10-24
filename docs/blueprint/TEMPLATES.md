# Templates

> **Status: DRAFT design document. Not approved. Not implemented.** All implementation gates are on HOLD.
> Sources: `docs/BUSINESS_BLUEPRINT.md` (section 4), `docs/MASTER_BUILD_REGISTER.md` (FND-14, FND-15, FND-26).
> These are documentation templates with placeholders in angle brackets. They contain no vertical-specific content (TBD, D-01) and no application code.

## 1. Format rules

| Rule | Source |
|---|---|
| `SKILL.md` follows the Agent Skills specification (`agentskills/agentskills` `docs/specification.mdx`) | Register FND-14 |
| Our contract details live in a **sidecar file**, so `SKILL.md` stays spec-clean | Proposed, D-07 |
| `AGENT.md` is our own convention; the specification has none | Register FND-14 |
| Our validator **rejects** unknown frontmatter keys (the demo `skills-ref` also rejects them; Mastra silently drops them) | Register FND-14 |
| The sidecar file format (YAML, JSON, or other) is **TBD** | D-07 |
| The license of the specification text in `docs/` was not read | Register section 11 |

## 2. Folder template

```
agents/
  <agent-name>/                      one of: intake, processing, quality-control, reporting
    AGENT.md
    skills/
      <skill-name>/                  lowercase letters, digits, hyphens; must equal the name field
        SKILL.md
        skill.contract.<ext>         sidecar; extension TBD (D-07)
        references/                  optional
        evals/                       optional pointer to evaluation set
contracts/
  handoff-envelope.<version>
  work-item.<version>
  candidate-result.<version>
  qc-verdict.<version>
  report.<version>
```

## 3. `AGENT.md` template

```markdown
---
name: <intake | processing | quality-control | reporting>
version: <semantic version>
role: <one sentence>
skills: [<skill-name>, ...]
default_tier: <Auto | Assisted | Human-approve | Manual-only>
limits: {max_steps: <TBD>, token_cap: <TBD>, timeout_seconds: <TBD>}
handoff_to: <agent name> using <contract name and version>
---

# <Agent name>

## Purpose and boundaries
<What it does. What it must never do.>

## Inputs
<Contract names and versions.>

## Outputs
<Contract names and versions.>

## Tool allow-list (summary; enforced list is in each skill's sidecar)
<Tool names.>

## Handoffs
<Target agent, contract, receiver validation.>

## Escalation
<Conditions and destination.>

## Failure behavior
<Timeout, schema failure, tool denial, kill switch.>

## Tests
<Pointer to the acceptance tests.>
```

## 4. `SKILL.md` template (spec-clean)

```markdown
---
name: <skill-name>
description: <What it does and when to use it. 1 to 1024 characters.>
license: <optional>
compatibility: <optional, up to 500 characters>
metadata:
  agent: "<agent-name>"
---

# <Skill title>

## When to use
<Conditions.>

## Procedure
1. <Step>
2. <Step>

## Examples
<Synthetic examples only. No real customer data.>

## Failure modes
<Known failure cases and the required response.>

## Do not
<Hard rules.>
```

| Field | Rule |
|---|---|
| `name` | Required; 1 to 64 characters; lowercase letters, digits, hyphens; no leading, trailing, or doubled hyphens; equals the folder name |
| `description` | Required; 1 to 1024 characters |
| `license`, `compatibility`, `metadata` | Optional; `metadata` values are strings |
| `allowed-tools` | Not used by us as a control; advisory only (experimental in the specification) |
| Body | Under 500 lines |
| Any other key | Rejected by our validator |

## 5. Skill sidecar template (format TBD, D-07)

| Field | Required | Description |
|---|---|---|
| `skill_version` | Yes | Semantic version of this skill |
| `agent` | Yes | Owner agent name (must match the folder) |
| `input_contract` | Yes | Contract name and version |
| `output_contract` | Yes | Contract name and version |
| `tools` | Yes | Enforced allow-list, by tool name |
| `data_permissions` | Yes | Data classes readable and tables writable |
| `network` | Yes | `none` unless specified |
| `personal_data_access` | Yes | `none`, `masked-only`, or `vault-read` (the last needs approval) |
| `tier` | Yes | Per side effect |
| `limits` | Yes | Timeout seconds, token cap (values TBD) |
| `tests` | Yes | Unit-test path; evaluation-set path; minimum pass rate (TBD, D-04) |
| `side_effects` | Yes | `none` or a declared list |
| `idempotent` | Yes | Boolean; required `true` for any side effect |

## 6. Contract templates

All contracts carry a name and version. A change that removes or renames a field is a major version.

### 6.1 Handoff envelope (`handoff-envelope.v1`)

| Field | Type | Notes |
|---|---|---|
| `contract` | string | Payload contract name and version |
| `workspace_id` | id | Must match the receiver's tenant context |
| `correlation_id` | id | One id for the whole item |
| `item_id` | id | |
| `payload` | object | Validated against `contract` |
| `evidence_refs` | list of references | Never raw text |
| `confidence` | number 0 to 1 | |
| `produced_by` | string | Skill and version |
| `created_at` | timestamp | |

### 6.2 Work item (`work_item.v1`)

| Field | Type | Notes |
|---|---|---|
| `item_id`, `workspace_id` | id | |
| `source` | object | Channel reference and inbound event id (no body) |
| `category` | string | From a configured list (TBD, D-01) or `unknown` |
| `fields` | list | Each: name, value (masked), confidence, `found` flag |
| `missing_fields` | list of names | |
| `message_ref` | reference | To the masked message |
| `pii_summary` | list | Types and counts only |
| `status` | enum | `ready` or `needs-human` |
| `reasons` | list | Why `needs-human`, if so |
| `versions` | object | Skill, model, and prompt versions |

### 6.3 Candidate result (`candidate_result.v1`), Later

Fields: item id, workspace id, result payload (TBD per vertical), evidence references per claim, steps taken, side-effect requests (none executed), versions.

### 6.4 QC verdict (`qc_verdict.v1`), Later

Fields: verdict (`pass`, `rework`, `escalate`), reasons, rule results, claims checked, evidence checked, reviewer skill and version.

### 6.5 Approval record, Later

Fields: approver id and role, decision, reason, decided at, expires at, evidence reference, action reference.

### 6.6 Report (`report.v1`), Later

Fields: period, metric values, anomalies, recipients, delivery receipt. No personal data.

## 7. Operational templates

| Template | Required content |
|---|---|
| Runbook | Trigger, impact, first checks, safe actions, escalation, evidence to capture, closure criteria |
| Incident record | Time, severity, tenants affected, data affected (classes only), actions, root cause, follow-ups |
| Skill release note | Skill, old and new version, contract changes, evaluation results, rollback plan |
| Decision record (ADR) | Context, decision, alternatives, consequences, status |
| Register row | Component, source paths, proposed verdict, license, dependencies, verification level, notes |
| Synthetic test case | Id, input (synthetic), expected category, expected fields, expected personal-data findings |

## 8. Vertical-specific templates

Category lists, field definitions, business rules, reply snippets, and report layouts are **TBD (D-01)**.

## 9. Completeness of this document

| Part | Status |
|---|---|
| Folder, `AGENT.md`, `SKILL.md`, sidecar field list, contract field lists for Intake | Complete for the proposed MVP |
| Processing, QC, and Reporting contract field detail | **Incomplete: outline only; depends on D-01** |
| Sidecar file format | **Incomplete: TBD (D-07)** |
| Vertical-specific templates | **Not started (D-01)** |
