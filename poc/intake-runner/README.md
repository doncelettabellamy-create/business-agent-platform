# Intake runner proof of concept (synthetic only)

**This is NOT the production Intake agent.** It is a small, deterministic proof of concept that exercises the `work_item.v1` contract and a Processing handoff envelope using already-masked, invented data. Register rows FND-26, INT-12, and PRC-06 stay Founder-PENDING and NOT COMPLETE.

## What it does

`runIntake(input, options)` takes one already-masked synthetic record and:

1. Refuses it if no tenant (`workspace_id`) is present (fail closed, checked first).
2. Validates the record's structure (strict: unknown keys are rejected; error text never echoes input values).
3. Refuses input that is not declared as masked.
4. Refuses any contract other than `work_item.v1`.
5. Builds a `work_item.v1` deterministically from the candidate values in the record (category in the configured list, extracted fields, missing required fields, optional low-confidence flag).
6. Validates the work item, and for status `ready` wraps it in a handoff envelope (`contract: work_item.v1`) addressed to Processing.
7. Items that need review (`needs-human`) are returned **without** an envelope.

Same input gives the same output. The masked text is validated but never copied into the output (only a `msg:<event id>` reference).

## What it does not do (limitations)

| Not included | Consequence |
|---|---|
| No model | Classification and extraction are not performed. The candidate category and field values come from the input record; the runner only checks and packages them. |
| No personal-data detector | The runner **trusts** the `masking.applied` declaration. It cannot tell whether text is really masked, so it is not a privacy control. |
| No database, queue, vault, or audit chain | Nothing is stored. No duplicate protection beyond a deterministic item id. No tamper-evident log. |
| No tenant isolation beyond input checks | "Missing tenant" is checked in code only. There is no row-level security, no session, no authentication. |
| No network or outbound actions | Nothing is sent anywhere. The CLI only reads one local file. |
| No Processing receiver | Only the envelope is produced; there is no stub that accepts or rejects it (register AT-20 is not covered). |
| No confidence threshold decision | The threshold is a founder decision (D-04). `minConfidence` is an optional parameter with no default; test values are not product decisions. |
| Contracts are proposals | Field lists follow `docs/blueprint/TEMPLATES.md`, which is unapproved. That template has no envelope-version field, so the envelope cannot identify its own version. |
| No type checking was run | Written in TypeScript (D-14 is unapproved) using only syntax that Node 24 can strip. The TypeScript compiler was not installed or run. |
| Not wired to skills | The `agents/intake/skills/*` folders and `SKILL.md` files do not exist. |
| Placeholder names | Categories and fields are generic (vertical TBD, D-01). |

## Mapping to the register

| Row | What this PoC covers | What remains |
|---|---|---|
| FND-26 | Executable `work_item.v1` and handoff-envelope validators | Agent folders for the other three agents, contract files for the rest |
| INT-12 | A deterministic stand-in for classify, extract, validate, create-work-item | Real skills with sidecars, model gateway, detector, vault |
| PRC-06 | The envelope that Processing would receive | A receiver, version negotiation, audit event per handoff |

Related acceptance tests (`docs/blueprint/DEPLOYMENT_TESTING.md`), partially and only at the code level: AT-13 (fail closed), AT-14 (contract), AT-20 (unsupported version refused), AT-03 (missing tenant, no database). None of AT-01 to AT-22 is claimed as passed.

## Run it

Requires Node 24 or later (built-in TypeScript type stripping). No installation is needed; there are no dependencies.

```
cd poc/intake-runner
npm test                       # or: node --test tests/intake-runner.test.ts
node src/cli.ts examples/valid-input.json
node src/cli.ts examples/needs-human-input.json
```

The CLI prints JSON and exits 0 for a result (including `needs-human`) and 2 for a refusal.

## Tests (18)

Valid input (handoff, determinism, tenant-specific ids, example files); missing tenant (several shapes, checked first, malformed id); invalid contract (unsupported versions, work-item validator cases, envelope validator cases, structural errors without value echo, masking not declared); needs-human fallback (missing fields, unknown category, optional low confidence, combined reasons, empty fields); and a static guard that the runner and contracts import only `node:crypto` and local files and use no network or process APIs.
