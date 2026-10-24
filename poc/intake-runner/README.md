# Intake runner proof of concept (synthetic only)

**This is NOT the production Intake agent.** It is a small, deterministic proof of concept that exercises the `work_item.v1` contract, a local classification-and-extraction skill, and a Processing handoff envelope using already-masked, invented data. Register rows FND-26, INT-12, and PRC-06 stay Founder-PENDING and NOT COMPLETE.

## What it does

`runIntake(input, options)` takes one already-masked synthetic record and:

1. Refuses it if no tenant (`workspace_id`) is present (fail closed, checked first).
2. Validates the record's structure (strict: unknown keys are rejected; error text never echoes input values).
3. Refuses input that is not declared as masked.
4. Refuses any contract other than `work_item.v1`.
5. Takes categories and field values from **exactly one** source:
   - **`candidate` mode:** values supplied in the record (the original PoC mode), or
   - **`skill_config` mode:** the local deterministic skill (`src/classify-extract.ts`) classifies the masked text and extracts fields using categories and fields that the caller configured explicitly.
6. Builds and validates a `work_item.v1`, and for status `ready` wraps it in a handoff envelope (`contract: work_item.v1`) addressed to Processing.
7. Items that need review (`needs-human`) are returned **without** an envelope.

Same input gives the same output. The masked text is validated but never copied into the output (only a `msg:<event id>` reference; extracted field values are short snippets of the masked text).

## The local classify-extract skill (skill_config mode)

It has **no vocabulary of its own** and no industry rules: with a different configuration the same text gets a different result.

| Aspect | Behavior |
|---|---|
| Configuration | `skill_config.categories[]` (`name`, `keywords[]`) and `skill_config.fields[]` (`name`, `required`, `extractor`). Category names and keywords are caller-supplied; `unknown` is reserved. |
| Classification | One point per distinct configured keyword found as a whole word or phrase, case-insensitive. Highest score wins. No hit: `unknown` with reason `unknown_category`. Tie for highest: `unknown` with reason `ambiguous_category` (never guessed). There is no margin or confidence threshold. |
| `label` extractor | Finds `<label>: value` or `<label>= value` (case-insensitive, whole-word label). The value ends at a line break or `;`; trailing `.` and `,` are dropped. An empty value does not match and never borrows the next line. |
| `token` extractor | Finds masked tokens of one configured type, for example `[ID_1]`. |
| Ambiguity | The same value repeated is accepted. Different values for one field: not extracted and flagged `ambiguous_field` (even for an optional field). |
| Missing | Required fields not found go into `missing_fields` (reason `missing_fields`). Values longer than 200 characters count as not found. |
| Confidence | **Not scored.** Extracted values carry confidence `null`, so the envelope confidence is `null`. If `minConfidence` is set, every skill-mode item is flagged `low_confidence`. |
| Limits | 50 categories, 20 keywords each, 50 fields, 10 labels each, 20,000 characters of text. Configuration values are matched literally (regular-expression characters are escaped). |

## What it does not do (limitations)

| Not included | Consequence |
|---|---|
| No model | Classification is keyword counting and extraction is pattern matching. It cannot understand meaning, synonyms, negation ("not a quote"), languages other than the configured words, or context. |
| No personal-data detector | The runner **trusts** the `masking.applied` declaration. It cannot tell whether text is really masked, so it is not a privacy control. Extracted values are copied from the text, so unmasked text would put raw data into the output. |
| No database, queue, vault, or audit chain | Nothing is stored. No duplicate protection beyond a deterministic item id. No tamper-evident log. |
| No tenant isolation beyond input checks | "Missing tenant" is checked in code only. There is no row-level security, session, or authentication. |
| No network or outbound actions | Nothing is sent anywhere. The CLI only reads one local file. |
| No Processing receiver | Only the envelope is produced; nothing accepts or rejects it (register AT-20 is not covered). |
| No confidence scoring or thresholds | Thresholds are a founder decision (D-04). `minConfidence` is optional with no default. |
| Configuration is not governed | Where categories, keywords, and fields come from (tenant settings, versions, approval) is undecided (D-01, D-07). The examples use invented placeholder words. |
| Contracts are proposals | Field lists follow `docs/blueprint/TEMPLATES.md`, which is unapproved. This PoC added two reason codes (`ambiguous_category`, `ambiguous_field`) to `work_item.v1`; they are not in the template. The envelope has no version field. |
| No type checking was run | Written in TypeScript (D-14 is unapproved) using only syntax that Node 24 can strip. The TypeScript compiler was not installed or run. |
| Not wired to skill files | The `agents/intake/skills/*` folders and `SKILL.md` files do not exist. |
| No accuracy measurement | There is no labelled evaluation set (INT-13); correctness is only tested on invented examples. |

## Mapping to the register

| Row | What this PoC covers | What remains |
|---|---|---|
| FND-26 | Executable `work_item.v1` and handoff-envelope validators | Agent folders for the other three agents, contract files for the rest |
| INT-12 | A deterministic local stand-in for classify-request and extract-fields, plus validate and create-work-item | Real skills with sidecars, model gateway, detector, vault |
| PRC-06 | The envelope that Processing would receive | A receiver, version negotiation, audit event per handoff |

Related acceptance tests (`docs/blueprint/DEPLOYMENT_TESTING.md`), partially and only at the code level: AT-13 (fail closed), AT-14 (contract), AT-17 (only in that the skill never executes text), AT-20 (unsupported version refused), AT-03 (missing tenant, no database). None of AT-01 to AT-22 is claimed as passed.

## Run it

Requires Node 24 or later (built-in TypeScript type stripping). No installation is needed; there are no dependencies.

```
cd poc/intake-runner
npm test
node src/cli.ts examples/skill-input.json             # clear match: handed off to Processing
node src/cli.ts examples/skill-ambiguous-input.json   # tie and conflicts: needs-human, no envelope
node src/cli.ts examples/valid-input.json             # candidate mode
node src/cli.ts examples/needs-human-input.json       # candidate mode
```

`npm run example:skill` and `npm run example:skill-ambiguous` do the same. The CLI prints JSON and exits 0 for a result (including `needs-human`) and 2 for a refusal.

## Tests (42)

- `tests/intake-runner.test.ts` (18): valid input, missing tenant, invalid contract, needs-human fallback, static no-network guard.
- `tests/classify-extract.test.ts` (24): classification (whole words, case, distinct hits), extraction (label, token, separators, repeated and conflicting values, length limit), ambiguity (category tie, field conflict, combined reasons), unknown categories (no match, reserved name, configuration-driven), safe fallback (invalid configuration without echo, single source rule, gates still apply, literal regular-expression characters, hostile text speed, oversized or empty text, threshold behavior), wiring (determinism, no text copied, examples), and a static guard for the skill module.
