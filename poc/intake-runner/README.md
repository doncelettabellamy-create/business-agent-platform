# Intake runner proof of concept (synthetic only)

**This is NOT the production Intake agent, and it cannot call a real AI model.** It is a small proof of concept that exercises the `work_item.v1` contract, a local deterministic classify-extract skill, a **provider-independent model gateway with a local scripted mock**, executable skill definitions, and a Processing handoff envelope, all on invented, already-masked data. Register rows FND-26, FND-17, INT-12, and PRC-06 stay Founder-PENDING and NOT COMPLETE.

## One pipeline, two ways to get values

| Entry point | Values come from | Use |
|---|---|---|
| `runIntake(input, options)` (synchronous) | A supplied `candidate`, or the local deterministic skill (`skill_config`) | Default path and the **fallback** |
| `runIntakeWithModel(input, options)` (asynchronous) | A `ModelProvider` through the gateway, one call per skill (`classify-request`, `extract-fields`). Needs `skill_config`. | Model-ready path; today only the local mock exists |

Both share the same gates and tail: tenant gate, structure check, masking declaration, contract support, `work_item.v1` build and validation, and a handoff envelope **only for `ready` items**. There is no second Intake engine.

### Model path behavior

1. **Gates first.** Missing tenant, bad structure, undeclared masking, or an unsupported contract are refused before any provider call.
2. **Minimal data to the provider.** A provider receives only a fixed instruction, the masked text, category names, and field names. No tenant, event, correlation, channel, or personal-data summary.
3. **Permissions enforced.** The gateway refuses a call unless the calling skill's definition allows the `model-gateway` tool and names that task (`src/skills.ts`).
4. **Strict answers.** Only strict JSON in the expected shape is accepted. Categories must be from the configured list. Extracted values must be copied from the masked text (an invented or rewritten value rejects the whole answer). Confidences must be from 0 to 1.
5. **Bounded.** Attempts (1 to 3, default 1), output tokens, time limit, and output size are capped. These numbers are placeholders, not decisions (D-04).
6. **Failure always means a person.** If ANY model answer fails (error, timeout, oversize, invalid, ungrounded), in either skill, the item gets reason `model_failed`, status `needs-human`, and **no handoff envelope**. No configuration changes this. The deterministic skill still runs, but only to give the reviewer suggested values; those suggestions can never make a failed run `ready`. The per-skill trace records the failure code, and a post-condition in the runner refuses any failed run that is not a review item without an envelope.
7. **No provider text is kept.** Failures are reported as codes only; provider answers and error messages are never stored or returned.

## Skill definitions

`src/skills.ts` holds executable definitions for `classify-request`, `extract-fields`, `validate-completeness`, and `create-work-item` (tools, permissions, tier, contracts, model task). The sidecar file format is undecided (D-07), so this TypeScript file is the provisional sidecar. The matching spec-clean `agents/intake/skills/<name>/SKILL.md` files exist, and tests check that they agree with the definitions and with `AGENT.md`. Names are placeholders until the vertical is decided (D-01).

## Local deterministic skill (skill_config mode)

No vocabulary of its own and no industry rules: with a different configuration the same text gets a different result.

| Aspect | Behavior |
|---|---|
| Configuration | `skill_config.categories[]` (`name`, `keywords[]`) and `skill_config.fields[]` (`name`, `required`, `extractor`). `unknown` is reserved. |
| Classification | One point per distinct configured keyword found as a whole word or phrase, case-insensitive. Highest score wins. No hit: `unknown_category`. Tie: `ambiguous_category` (never guessed). |
| `label` extractor | `<label>: value` or `<label>= value`; value ends at a line break or `;`. An empty value never borrows the next line. |
| `token` extractor | Masked tokens of one configured type, for example `[ID_1]`. |
| Ambiguity | Same value repeated: accepted. Different values: not extracted, flagged `ambiguous_field`. |
| Confidence | Not scored (`null`). With `minConfidence` set, every deterministic item is flagged `low_confidence`. |

## Run it

Requires Node 24 or later (built-in TypeScript type stripping). No installation is needed; there are no dependencies.

```
cd poc/intake-runner
npm test                                              # 85 tests
npm run demo                                          # model path with the local mock: 7 scenarios
node src/cli.ts examples/skill-input.json             # deterministic runner
node src/cli.ts examples/skill-ambiguous-input.json   # needs-human, no envelope
```

The demo shows: deterministic run; a mock model that answers well; a mock that invents a value; a mock that returns non-JSON; a mock that never answers (timeout), both without and with the old `fallback: 'deterministic'` setting (which is now ignored: either way the item goes to a person); and a missing tenant refused before any model call. It uses `src/mock-provider.ts`, which returns exactly what it is scripted to return and understands no text.

## Not included (limitations)

| Not included | Consequence |
|---|---|
| **No real provider, no API key, no network** | `ModelProvider` has one implementation: the local scripted mock. The runner imports no SDK and reads no environment variables. It cannot call Claude or any real model. |
| No personal-data detector | The runner **trusts** `masking.applied`. It cannot tell whether text is really masked. Sending real text to a real provider would be unsafe until detection, masking, and the vault exist. |
| Mock is not a model | It proves the plumbing (validation, grounding, bounds, fallback), not model quality. There is no accuracy measurement and no evaluation set (INT-13). |
| Prompts are drafts | The two instruction texts are untested against any real model and unapproved. |
| JSON must be bare | Answers wrapped in text or code fences are rejected; a real adapter must guarantee bare JSON (for example via structured output). |
| Plain retries | No backoff, rate-limit handling, or provider-specific error mapping. |
| No metering | `usage` from a provider is ignored; no cost counters, caps, or kill switch. |
| No database, queue, vault, audit chain, authentication, or row-level security | Nothing is stored; the tenant check is code-level only. |
| No Processing receiver | Only the envelope is produced (AT-20 not covered). |
| Contracts are proposals | `work_item.v1` fields follow the unapproved `docs/blueprint/TEMPLATES.md`. This PoC added reason codes `ambiguous_category`, `ambiguous_field`, and `model_failed`; the envelope has no version field. |
| No type checking was run | TypeScript (D-14 unapproved) run by Node's type stripping; the compiler was not installed or run. |

## What remains before a real Claude connection

1. **Founder decisions:** D-03 (cloud model calls allowed at all), provider and model choice, provider data terms and retention (D-11, legal review), D-04 (retry, token, time limits, confidence thresholds, accuracy targets), D-12 (spend caps), D-14 (stack).
2. **Real masking first (blocking):** personal-data detector service (INT-06), masking with stable tokens (INT-07), encrypted vault (INT-08), fail-closed policy (INT-09), and a measured recall (AT-08). Today masking is only a declaration.
3. **A provider adapter** that implements `ModelProvider` for Claude, guarantees bare structured JSON, honors the abort signal, and maps provider errors to codes without leaking messages. The library or plain-HTTPS choice is open (FND-17, PENDING).
4. **Secret handling:** the API key in a secrets service (FND-10), injected by a composition root; never in the repo, logs, or the runner (a test bans environment access in the core modules).
5. **Metering and limits:** record token usage, per-run and per-tenant caps, kill switch, and spend alerts (FND-09, AT-18).
6. **Tenant wall, audit, and duplicate protection** around every model call (FND-02 to FND-04), so a retry cannot double-process or double-bill.
7. **Safe logging and tracing** with a correlation id and no content (FND-19, AT-11).
8. **Evaluation:** a labelled synthetic set, accuracy gate, and injection fixtures run against the real model (INT-13, AT-17, AT-19), plus prompt review and versioning.
9. **Engineering hygiene:** type-checking, pinned and license-checked dependencies, CI secret scan.
10. **Approvals:** founder approval of the register rows (FND-17, INT-12, FND-26) and of the draft contract changes.

## Mapping to the register

| Row | Covered here | Remains |
|---|---|---|
| FND-17 | The shape of a provider-independent gateway: interface, limits, strict parsing, permissions | Real provider, metering, library choice, approval |
| FND-26 | Executable `work_item.v1` and envelope validators; Intake skill folders | Other agents' folders, remaining contracts |
| INT-12 | The four Intake skills as definitions plus `SKILL.md` drafts; deterministic and mock-model execution | Real model, sidecar format (D-07), vertical content (D-01) |
| PRC-06 | The envelope Processing would receive | A receiver, version negotiation, audit event per handoff |

No acceptance test AT-01 to AT-22 is claimed as passed.

## Tests (85)

`tests/intake-runner.test.ts` (18, core contract and fallbacks), `tests/classify-extract.test.ts` (24, deterministic skill), `tests/model-runner.test.ts` (37: good answers, provider data minimization, invalid classify and extract outputs, ungrounded values, errors, timeouts, bounded retries, limits, **human-review regression tests** (6 failure kinds x 3 skill combinations x 4 fallback settings = 72 runs, all must need review with no envelope; perfect deterministic suggestions still not ready; success unaffected; contracts refuse promotion; the option is never read), gates before any call, skill permissions, injection text, static guard), and `tests/skills.test.ts` (6: definitions, tool allow-lists, `SKILL.md` and `AGENT.md` agreement).

## Compatibility changes

- **Model failures now always require human review** (previous commit `ad177ed` let `fallback: 'deterministic'` treat deterministic values as normal and hand off).
- `ModelRunOptions.fallback` is **deprecated and ignored**. It is still accepted so existing callers compile and run, but `'deterministic'`, `'needs-human'`, absent, or any other value now behave identically. Callers that relied on `'deterministic'` to get an envelope after a model failure will now receive `needs-human` with no envelope.
- Unchanged: `runIntake` (the synchronous deterministic runner), the `work_item.v1` reason code `model_failed`, trace `source` values (`deterministic-fallback` now means "deterministic suggestions for review"), and the `versions.model` labels.
- New in the runner: a post-condition that refuses (`CONTRACT_INVALID`) any failed model run that is not a `needs-human` item without an envelope. It should be unreachable and exists as defense in depth.
