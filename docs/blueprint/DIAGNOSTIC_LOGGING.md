# Diagnostic Logging

> **Status: DRAFT design document. Not approved. Not implemented.** No logger exists. All implementation gates are on HOLD.
> Sources: `docs/BUSINESS_BLUEPRINT.md` (section 12), `docs/MASTER_BUILD_REGISTER.md` (FND-03, FND-19, R-001, R-002).
> Retention periods, log storage, access roles, and tooling are **TBD (D-11)**. Nothing here assumes a vendor.

## 1. Goals

1. Make any failure explainable from logs, traces, and the audit record.
2. Make it impossible for logs to become a second copy of customer content.
3. Support time-boxed deeper diagnostics without exposing raw data.

## 2. The one rule

**No log, trace, metric, analytics event, or error report may contain a message body, masked text, or a raw personal-data value.** They carry ids, enumerations, counts, durations, versions, and error codes. This is tested by AT-11.

## 3. Log types

| Type | Purpose | Contains | Never contains | Retention |
|---|---|---|---|---|
| Application | Operations and debugging | Event name, level, correlation id, workspace id, item id, durations, error code | Bodies, masked text, raw values, secrets | TBD |
| Audit (hash-chained) | Accountability | Actor, action, target, masked metadata, time, chain hashes | Raw values | TBD; kept longest |
| Security | Detection | Rejected requests, denials, boot-check failures (no bodies) | Request bodies, secrets | TBD |
| Usage | Cost | Model, tokens, estimated cost | Content | TBD |
| Diagnostic (time-boxed) | Deep troubleshooting for one tenant | Replay record by reference: prompt version, tool calls and results by reference, policy decisions | Raw values; bodies unless explicitly consented and masked | Short, TBD |

## 4. Standard fields (proposed)

| Field | Required | Notes |
|---|---|---|
| `timestamp` | Yes | UTC |
| `level` | Yes | debug, info, warn, error |
| `event` | Yes | From a fixed vocabulary (below) |
| `correlation_id` | Yes | Created at inbound; carried everywhere |
| `workspace_id` | Yes (except platform events) | |
| `item_id`, `run_id`, `step_seq` | When applicable | |
| `agent`, `skill`, `skill_version` | When applicable | |
| `model`, `prompt_version` | When applicable | |
| `duration_ms` | When applicable | |
| `error_code` | On error | Stable code, not free text |
| `detector_version` | When applicable | |

Free-text fields are prohibited except fixed, developer-written messages with no interpolated customer data.

## 5. Event vocabulary (initial)

| Area | Events |
|---|---|
| Inbound | `inbound.received`, `inbound.rejected`, `inbound.duplicate`, `inbound.enqueued` |
| Tenancy | `tenant.context_set`, `tenant.context_missing`, `boot.role_check_failed` |
| Detector | `detector.called`, `detector.failed`, `detector.findings_counts` |
| Vault | `vault.write`, `vault.read_allowed`, `vault.read_denied` |
| Model | `model.called`, `model.retry`, `model.schema_failed`, `model.cap_hit` |
| Intake | `workitem.created`, `workitem.flagged`, `handoff.sent`, `handoff.rejected` |
| Platform | `killswitch.changed`, `skill.loaded`, `skill.rejected` |
| Audit | `audit.append`, `audit.verify_ok`, `audit.verify_failed` |

## 6. Redaction rules

| Rule | Detail |
|---|---|
| Allow-list, not deny-list | Loggers accept only declared fields; unknown fields are dropped |
| Wrapped exceptions | Errors from the model gateway, detector client, and database are converted to error codes before logging; the original message and request arguments are not attached |
| No request/response dumps | HTTP and model clients run with body logging off |
| Scrubber as a backstop | A scrubber runs on outgoing log lines using the detector's patterns (after S-19 in the build sequence); it does not replace the allow-list |
| Third-party libraries | Verify defaults. Known caveats: Instructor's TypeScript port logs full messages on error; the Python version's exception and arguments hook carry the conversation |
| Secrets | Secret values are never loaded into logging context; CI secret scan |

## 7. Diagnostic mode (time-boxed)

| Aspect | Rule |
|---|---|
| Trigger | A platform admin enables it for one workspace for a limited period (limit TBD) |
| Consent | Tenant consent recorded (process TBD) |
| Content | References to stored artifacts, not copies; still no raw values |
| Audit | Enabling and disabling write audit events |
| Expiry | Automatic |
| Access | Restricted role; reads are logged |

## 8. Correlation and replay

1. The correlation id is created by the inbound API and stored on the event, queue message, run, steps, usage, and audit rows.
2. A replay record for a run lists: skill and version, model and prompt version, tool calls by name with input and output references, policy decisions, retries, and outcome. It lets staff reproduce the sequence without copying content.
3. Crash recovery re-runs later steps (Mastra design note); replay records mark re-runs so they are not mistaken for duplicates.

## 9. Audit log specifics (FND-03)

| Aspect | Design |
|---|---|
| Chain | `chain_hash = hash(previous_chain_hash, payload_hash, seq)`; payload hash over canonical action, actor, target, metadata, time |
| Reference | Orchester `apps/web/lib/audit/chain.ts` (V1) |
| Known gaps to fix | Appends must be serialized; handle undefined, nested dates, and big integers consistently; anchor the latest hash outside the database |
| Verification | A scheduled job and an on-demand check; failure is a critical alert |
| Protection | Append-only for the runtime role; future audit tables must repeat the protection |

## 10. Access and retention

| Log type | Who may read | Retention |
|---|---|---|
| Application | Engineers on call | TBD |
| Audit | Platform admin (masked); customer admin for their tenant (Later) | TBD |
| Security | Security responder | TBD |
| Diagnostic | Named platform admin during the window | Short, TBD |

## 11. Logging acceptance tests

| Test | Check |
|---|---|
| AT-11 | After the whole suite, including forced failures, no raw synthetic values or bodies in logs, traces, error output, audit metadata |
| AT-15 | Audit chain tamper and concurrency |
| LOG-T1 (new) | Every log line from one item carries the same correlation id |
| LOG-T2 (new) | A forced detector failure, model failure, and database failure each log an error code and no content |
| LOG-T3 (new) | Third-party library logging defaults are checked and overridden (inventory test) |
| LOG-T4 (new) | Diagnostic mode expires automatically and is audited |

LOG-T1 to LOG-T4 are proposals not yet in `DEPLOYMENT_TESTING.md`'s numbered list.

## 12. Component ownership

| Need | Owner | Reference | Row |
|---|---|---|---|
| Allow-list logger, correlation middleware | Our own | none | FND-19 |
| Audit chain | `src/audit/*` | Orchester `audit/chain.ts` (V1), `verify-job.ts` (V3) | FND-03 |
| Audit verification schedule | Worker | Orchester worker `JOB_AUDIT_VERIFY_ALL` (V1) | FND-08 |
| Scrubber patterns | Detector client | Presidio (INT-06) | INT-06 |
| Credential scrubber (not personal data) | Optional | Orchester `lib/gdpr/redact.ts` (V1: secrets only, misses some key names and JWTs) | FND-13 (ADAPT for log scrubbing only) |

## 13. Completeness of this document

| Part | Status |
|---|---|
| Rules, types, fields, events, redaction, diagnostic mode, tests | Complete as a proposal |
| Retention, storage, tooling, access roles | **Incomplete: TBD (D-11)** |
| Orchester audit verification and logging internals | **Not read (V3/V4)** |
| Tenant consent process for diagnostic mode | **Not designed** |
