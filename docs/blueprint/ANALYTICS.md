# Analytics

> **Status: DRAFT design document. Not approved. Not implemented.** No events, tables, or dashboards exist. All implementation gates are on HOLD.
> Sources: `docs/BUSINESS_BLUEPRINT.md` (section 9), `docs/MASTER_BUILD_REGISTER.md` (RPT-01, RPT-02, FND-09, INT-13).
> Every target is **TBD**. Business metrics depend on the vertical (D-01) and pricing (D-12), neither of which is decided.

## 1. Purpose

Measure whether the pilot is safe and accurate, what it costs, and (later) whether customers get value. Analytics supports decisions; it is not a source of customer content.

## 2. Privacy rules (mandatory)

| Rule | Reason |
|---|---|
| Analytics never contains message bodies, masked text, or raw personal data | Privacy; logs and analytics are lower-trust stores |
| Personal-data metrics are counts by entity type only | No values, no offsets |
| Per-tenant data is aggregated within a tenant; cross-tenant comparison only on platform-level aggregates | Isolation |
| Dimensions use ids and enumerated values only | No free text |
| Analytics tables carry `workspace_id` and are row-level secured | Isolation |
| Test AT-11 extends to analytics outputs | Verification |

## 3. Metric catalog

"Source" names proposed tables from `DATABASE_DESIGN.md`. Targets are TBD.

### 3.1 Pipeline

| Metric | Definition | Source | Target |
|---|---|---|---|
| Items received | Count of verified inbound events | `inbound_events` | n/a |
| Rejection rate | Rejected / (received + rejected) | `inbound_events.verification_result` | Informational |
| Duplicate rate | Duplicate deliveries / deliveries | `inbound_events`, idempotency | Informational |
| Ready rate | Items `ready` / items processed | `work_items.status` | TBD |
| Needs-review rate | Items `needs-human` / items processed | `work_items.status` | TBD |
| Time to work item | Work item created minus event received (p50, p95) | `work_items`, `inbound_events` | TBD |
| Acknowledge time | Response time of the inbound API | API metrics | Within provider limit (TBD, D-02) |

### 3.2 Quality (evaluation set, not live traffic, in the pilot)

| Metric | Definition | Source | Target |
|---|---|---|---|
| Classification accuracy | Correct category / labelled items | Evaluation runs | TBD (D-04) |
| Extraction accuracy | Field-level exact or tolerant match (rule TBD) | Evaluation runs | TBD (D-04) |
| Confusion matrix | Predicted vs. labelled categories | Evaluation runs | n/a |
| Calibration | Confidence vs. correctness buckets | Evaluation runs | TBD |
| Retry rate | Model retries / model calls | `run_steps` | TBD |
| Schema-failure rate | Invalid outputs after retries / runs | `run_steps` | TBD |

### 3.3 Personal data

| Metric | Definition | Source | Target |
|---|---|---|---|
| Detector recall by type | Detected / labelled synthetic entities | Evaluation runs | TBD (D-04) |
| Detector precision by type | Correct detections / detections | Evaluation runs | TBD (D-04) |
| Findings by type | Count per entity type | `pii_findings` | n/a |
| Vault reads | Authorized and denied reads | Audit events | Denied reads investigated |
| Leak checks | Raw synthetic values found in model input or logs | AT-09, AT-11 | Zero |

### 3.4 Cost and reliability

| Metric | Definition | Source | Target |
|---|---|---|---|
| Tokens per run | Input + output tokens | `usage_events` | Cap TBD |
| Cost per item | Estimated model cost / items | `usage_events` | TBD (D-12) |
| Cost per tenant per period | Sum of estimates | `usage_events` | TBD |
| Cap hits | Runs stopped by the token cap | `run_steps` | Informational |
| Kill-switch uses | Activations and duration | Audit events | Informational |
| Restart recovery | Items completed once after a restart | AT-22 | 100% |

### 3.5 Business (Later; all TBD)

Activation, retention, revenue, time saved, customer satisfaction: **not defined** until D-01 and D-12.

### 3.6 Reporting-agent metrics (Later)

Per-agent acceptance rate, QC pass and rework rates, cycle time, credits used, errors. Definitions follow the Reporting agent's skills (`AGENT_SPECS.md`).

## 4. Event model (proposed)

Events carry only ids, enumerations, counts, and timings.

| Event | Fields | Emitted by |
|---|---|---|
| `inbound.received` | workspace, channel, delivery id, result | Inbound API |
| `inbound.duplicate` | workspace, delivery id | Inbound API |
| `pii.detected` | workspace, event id, type counts, detector version | Intake |
| `model.call` | workspace, run id, model, tokens, retries | Model gateway |
| `workitem.created` | workspace, item id, status, category, confidence band | Intake |
| `workitem.flagged` | workspace, item id, reason code | Intake |
| `handoff.sent` | workspace, item id, contract version | Intake |
| `killswitch.changed` | scope, state, actor | Platform |

## 5. Dashboards (outline layouts)

### 5.1 Pilot health (platform admin)

```
+----------------------------------------------------------------+
| Pilot health                           Period: [<range> v]     |
+----------------------+-----------------------+-----------------+
| Items received  <n>  | Ready rate     <pct>  | Needs review <pct>|
+----------------------+-----------------------+-----------------+
| Time to item p50/p95 | Cap hits       <n>    | Cost / item <val> |
+----------------------+-----------------------+-----------------+
| Leak checks: <0 expected>   Cross-tenant test failures: <0 expected>|
+----------------------------------------------------------------+
| Category distribution (counts)       | Flag reasons (counts)    |
+----------------------------------------------------------------+
```

### 5.2 Evaluation report (founder)

Accuracy and recall tables against founder-set targets, confusion matrix, and pass or fail per acceptance test (AT-08, AT-19).

### 5.3 Customer dashboards (Later)

Defined by RPT-03 once the vertical is known.

## 6. Data pipeline

1. Events are written to the database in the same transaction as the state change where possible.
2. Metrics are computed from tables or aggregated views; the Reporting agent reads aggregated views only.
3. Aggregation jobs run on the worker (Orchester's `JOB_USAGE_AGGREGATE` is a placeholder in its worker, V1: do not assume a working design).
4. No third-party analytics SDK in the customer UI during the pilot (decision TBD).

## 7. Experimentation and evaluation

| Item | Rule |
|---|---|
| Evaluation sets | Synthetic, labelled, versioned; contents TBD (D-01) |
| Regression gate | A skill or model change must not lower accuracy or recall below targets |
| Drift check | Standing canary set run on a schedule (frequency TBD) |
| Annotation | Staff corrections (Later) feed new labelled data under privacy rules |

## 8. Component ownership

| Need | Owner | Reference | Row |
|---|---|---|---|
| Usage metering | Model gateway + `usage_events` | Orchester `usage_events` (README V2), `lib/cost-alerts.ts` (V3) | FND-09 |
| Activity queries | Reporting skills | Orchester `lib/activity/*` (V3) | RPT-01 |
| Evaluation harness | Our own | BAML eval framework (V2, idea) | INT-13 |
| Audit-based counts | Audit table | Orchester `audit/chain.ts` (V1) | FND-03 |

## 9. Analytics acceptance tests

| Test | Check |
|---|---|
| AT-08, AT-19 | Recall and accuracy computed and compared with founder targets |
| AT-11 (extended) | No bodies or raw values in analytics outputs |
| AN-T1 (new) | Metric values reconcile with row counts in source tables |
| AN-T2 (new) | A user of tenant A cannot see tenant B's metrics |

AN-T1 and AN-T2 are proposals not yet in `DEPLOYMENT_TESTING.md`'s numbered list.

## 10. Completeness of this document

| Part | Status |
|---|---|
| Pilot metrics, privacy rules, events, dashboard layouts | Complete as a proposal |
| Targets and thresholds | **Incomplete: TBD (D-04, D-12)** |
| Business and customer metrics | **Not started (D-01, D-12)** |
| Reporting-agent metrics | **Outline only** |
