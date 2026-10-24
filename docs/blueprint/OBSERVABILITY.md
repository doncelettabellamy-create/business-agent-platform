# Observability and Monitoring

> **Status: DRAFT design document. Not approved. Not implemented.** No monitoring exists. All implementation gates are on HOLD.
> Sources: `docs/BUSINESS_BLUEPRINT.md` (sections 10, 12), `docs/MASTER_BUILD_REGISTER.md` (FND-03, FND-19, FND-08).
> Thresholds, targets, tooling, and on-call arrangements are **TBD**.

## 1. Goals

1. Detect safety failures immediately (cross-tenant access, raw data in outputs, audit tampering).
2. Detect reliability and cost problems before customers do.
3. Make any single item traceable end to end with one correlation id.
4. Never leak content through telemetry (see `DIAGNOSTIC_LOGGING.md`).

## 2. Three pillars

| Pillar | Content | Proposed tooling |
|---|---|---|
| Metrics | Counters, gauges, histograms | TBD (open standard such as OpenTelemetry proposed) |
| Traces | One trace per item across inbound, detector, model, database | TBD |
| Logs | Structured, redacted | See `DIAGNOSTIC_LOGGING.md` |

## 3. Trace model

```mermaid
flowchart LR
  A[inbound.request] --> B[verify + dedupe]
  B --> C[enqueue]
  C --> D[run.start]
  D --> E[detector.call]
  E --> F[vault.write]
  F --> G[model.call xN]
  G --> H[validate]
  H --> I[db.write + audit]
  I --> J[handoff]
```

| Rule | Detail |
|---|---|
| Correlation id | Created at inbound; carried through the queue, runs, tool calls, model calls, and database writes |
| Span attributes | Ids, enumerations, counts, durations, versions. **No bodies, no masked text, no raw values.** |
| Sampling | Full capture during the pilot (volume is small); policy later TBD |
| Exceptions | Wrapped so that messages and request arguments are not attached (Instructor logging caveat, R-001) |

## 4. Signal catalog

| Area | Signal | Type | Alert condition |
|---|---|---|---|
| Availability | Inbound endpoint success rate | SLI | Below SLO (TBD) |
| Availability | Worker liveness / queue consumption | Gauge | No consumption for TBD minutes |
| Latency | Acknowledge time | Histogram | Above provider limit (D-02) |
| Latency | Time to work item | Histogram | p95 above TBD |
| Errors | Verification failures (forged, stale) | Counter | Spike above baseline (TBD) |
| Errors | Schema failures after retries | Counter | Rate above TBD |
| Errors | Model provider errors | Counter | Rate above TBD |
| Safety | **Cross-tenant test failure** | Event | **Any occurrence** |
| Safety | **Raw synthetic value found in outputs** (canary check) | Event | **Any occurrence** |
| Safety | **Audit-chain verification failure** | Event | **Any occurrence** |
| Safety | Denied vault reads | Counter | Any unexplained occurrence |
| Detector | Service health, latency | Gauge/histogram | Down or above TBD |
| Detector | Recall on standing canary set | Gauge | Below target (D-04) |
| Cost | Tokens per run, spend per tenant | Gauge | Above cap or sudden rise |
| Cost | Kill-switch state | Gauge | Changes are notified |
| Skills | Per-version pass rate, rework rate | Gauge | Regression after release |
| Database | Connections, slow queries, replication (if any) | Gauge | TBD |
| Queue | Depth and oldest item age | Gauge | Above TBD |
| Security | Superuser or bypass role connection attempts | Event | Any occurrence (boot check) |

## 5. Service-level objectives (all TBD)

| SLI | SLO | Window |
|---|---|---|
| Inbound endpoint availability | TBD | TBD |
| Acknowledge within provider limit | TBD | TBD |
| Items processed within target time | TBD | TBD |
| Detector availability | TBD | TBD |

SLO values need the vertical, volumes, and provider limits (D-01, D-02).

## 6. Alert routing

| Severity | Examples | Route |
|---|---|---|
| Critical | Cross-tenant failure; raw data in output; audit tamper; forged-request flood | Page on-call (arrangement TBD) |
| High | Detector down; model provider down; queue stalled | Notify on-call |
| Medium | Cost rise; schema-failure rate rise | Next business day |
| Low | Informational drift | Weekly review |

## 7. Health checks

| Check | Meaning |
|---|---|
| Liveness | Process is running |
| Readiness | Database reachable with restricted role; secrets reachable; detector reachable |
| Safety self-test | The service refuses to start if the database role has bypass privileges (AT-03) |
| Canary item | A synthetic item runs periodically through the pipeline end to end (frequency TBD) |

## 8. Dashboards (outline)

```
+---------------------------------------------------------------+
| Platform status             [All systems normal | <n> alerts]   |
+--------------------+------------------+-----------------------+
| Inbound ok <pct>   | Queue depth <n>  | Oldest item <age>     |
+--------------------+------------------+-----------------------+
| Detector up/down   | Model errors <n> | Kill switch: off      |
+--------------------+------------------+-----------------------+
| SAFETY: cross-tenant failures 0 | leak canaries 0 | chain ok    |
+---------------------------------------------------------------+
```

A second dashboard per tenant (Later) shows usage against caps.

## 9. Runbooks (to be written; headings only now)

| Runbook | Trigger | Key actions |
|---|---|---|
| RB-01 Detector outage | Detector down | Confirm parking behavior; restore; reprocess parked items |
| RB-02 Model provider outage | Errors above threshold | Confirm bounded retries; consider kill switch |
| RB-03 Queue backlog | Depth or age high | Check worker; scale; check poison items |
| RB-04 Suspected cross-tenant leak | Safety alert | Kill switch; preserve evidence; investigate; notify per rules (TBD) |
| RB-05 Audit-chain failure | Verification mismatch | Preserve; investigate; compare to anchored head |
| RB-06 Secret rotation | Scheduled or incident | Rotate; verify; revoke old |
| RB-07 Cost spike | Cost alert | Check caps; pause tenant if needed |

## 10. Component ownership

| Need | Owner | Reference | Row |
|---|---|---|---|
| Correlation id and redacted logging | Our logger and middleware | none found; Instructor caveat | FND-19 |
| Audit verification job | Worker job | Orchester `audit/verify-job.ts` (V3), `worker/index.ts` schedule `JOB_AUDIT_VERIFY_ALL` (V1) | FND-03, FND-08 |
| Stuck-run cleanup | Worker job | Orchester `JOB_FLOW_REAP` (V1) | FND-08 |
| Crash recovery notes (Later) | Pause/resume engine | Mastra `agent/durable/run-recovery.md` (V1) | FND-05 |
| Error reporting | Orchester has a Sentry test (`observability-sentry.test.ts`, V3); tooling TBD | n/a | FND-19 |
| Evaluation canary | Our own | n/a | INT-13 |

## 11. Observability acceptance tests

| Test | Check |
|---|---|
| AT-11 | No bodies or raw synthetic values in logs, traces, or error output |
| AT-15 | Audit chain tamper detected |
| AT-03 | Startup refuses a bypass-capable database role |
| OB-T1 (new) | One correlation id appears in every span and log line of an item |
| OB-T2 (new) | Safety alerts fire when a test deliberately triggers each condition |
| OB-T3 (new) | Canary item completes within the target time |

OB-T1 to OB-T3 are proposals not yet in `DEPLOYMENT_TESTING.md`'s numbered list.

## 12. Completeness of this document

| Part | Status |
|---|---|
| Signal catalog, trace model, routing, health checks, dashboard outline | Complete as a proposal |
| SLO values, thresholds, tooling, on-call | **Incomplete: TBD** |
| Runbooks | **Headings only** |
| Orchester audit-verification job contents | **Not read (V3)** |
