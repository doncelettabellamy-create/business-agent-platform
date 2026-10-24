# Intake runner proof of concept (synthetic only)

**This is NOT the production Intake agent. It has never called a real AI model.** It contains a Claude API adapter that has only been exercised against a fake client in tests. A gated, synthetic-only live test entry point exists, but it defaults to a dry run, and no credential, SDK, or network access is part of this repository. Register rows FND-26, FND-17, INT-12, and PRC-06 stay Founder-PENDING and NOT COMPLETE.

## One pipeline, two ways to get values

| Entry point | Values come from | Use |
|---|---|---|
| `runIntake(input, options)` (synchronous) | A supplied `candidate`, or the local deterministic skill (`skill_config`) | Default path; supplies reviewer suggestions after a model failure |
| `runIntakeWithModel(input, options)` (asynchronous) | A `ModelProvider` through the gateway, one call per skill (`classify-request`, `extract-fields`). Needs `skill_config`. | Model-ready path. Providers today: the local scripted mock, and the Claude adapter (tested with a fake client only) |

Both share the same gates and tail: tenant gate, structure check, masking declaration, contract support, `work_item.v1` build and validation, and a handoff envelope **only for `ready` items**. There is no second Intake engine.

### Model path rules (unchanged by the Claude adapter)

1. **Gates first.** Missing tenant, bad structure, undeclared masking, or an unsupported contract are refused before any provider call.
2. **Minimal data to the provider.** Only a fixed instruction, the masked text, category names, and field names. No tenant, event, correlation, channel, or personal-data summary.
3. **Permissions enforced.** The gateway refuses a call unless the skill's definition allows the `model-gateway` tool for that task (`src/skills.ts`).
4. **Strict answers.** Bare JSON in the expected shape; categories from the configured list; extracted values copied from the masked text (an invented or rewritten value rejects the whole answer); confidences from 0 to 1.
5. **Bounded.** Attempts (1 to 3, default 1), output tokens, time limit, and output size are capped. The numbers are placeholders, not decisions (D-04).
6. **Every model failure requires human review.** If ANY model answer fails, in either skill, the item gets reason `model_failed`, status `needs-human`, and **no handoff envelope**. No configuration changes this (the old `fallback` option is deprecated and ignored). Deterministic values are attached only as reviewer suggestions. A post-condition refuses any failed run that is not a review item without an envelope.
7. **No provider text is kept.** Failures are codes only; provider answers and error messages are never stored or returned.

## Claude adapter (`src/claude-provider.ts`)

Implements the existing `ModelProvider` interface and nothing else.

- **No SDK import, no environment access, no credentials, no network.** It is handed a client object with the official SDK's `client.messages.create(params, { signal })` shape. Tests pass a fake.
- **Request:** the fixed instruction as `system`; the masked data as one `user` message; answer shape enforced with structured outputs (`output_config.format = { type: "json_schema", schema }`, using only supported schema features) and `output_config.effort` (default `low`). It sends **none** of `temperature`, `top_p`, `top_k`, `thinking`, `tool_choice`, tools, or an assistant prefill (current models reject or manage these).
- **Refused or truncated answers** (`stop_reason` `refusal` or `max_tokens`) are returned as empty text so they can never be used; the gateway then fails them and the item goes to a person.
- **Provider errors** are reduced to a class name and HTTP status in `stats`, and replaced by a generic error with no cause attached.
- **Models:** exact ids only (for example `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`); date-suffixed ids are rejected. Current models think by default, and thinking tokens count toward `max_tokens` and are billed as output, so output budgets need headroom (the live entry defaults to 2048).

## Live test entry point (`src/live-entry.ts`): DRY RUN BY DEFAULT

`npm run live:dry-run` prints the exact request bodies and a cost estimate, and **sends nothing**. A real call needs all of the following, each checked in `src/live-gate.ts` (and covered by tests):

1. the `--live` flag,
2. the environment variable `INTAKE_ALLOW_LIVE_CALLS=yes`,
3. an input file directly under `examples/`,
4. a plainly synthetic record (`ws-synthetic-*`, `evt-synthetic-*`, `corr-synthetic-*`, masking source `synthetic-fixture`, with `skill_config`),
5. a call count within `--max-calls` (default 2, hard maximum 10), enforced by a counter around the client,
6. the official SDK installed locally (it is imported only after every check above, and is not a declared dependency).

Credentials are never accepted as arguments and never read by this repository's code: the SDK resolves them itself from the environment or a stored login profile. SDK retries are turned off (`maxRetries: 0`) so the gateway owns attempts and the call count is exact. No npm script contains `--live`.

## Setup before the first live call (founder steps; nothing here has been run)

1. **Decide the model and accept the data terms.** The entry defaults to **`claude-haiku-5-5`** (Claude Haiku 5.5). Anthropic's models overview, checked on 2026-10-24, lists this exact API id as an active current model, described as suited to classification and extraction, with retirement not sooner than 2027-10-07, a 1M-token context window, and adaptive thinking (default effort `medium`; the adapter sends `low`). Pass `--model claude-sonnet-5-5` or `--model claude-opus-5-5` only if you deliberately want a more capable and costlier model. Only synthetic data may be used. Decide D-03 (cloud model calls) and review the provider's data-retention terms first.
2. **Create a dedicated API key for this test only**, outside GitHub: in the Anthropic Console, preferably in its own workspace with a small spend limit if the Console offers one. Do not reuse a production key.
3. **Install the SDK locally** (this repository does not declare it, and as of the last check it is NOT installed): `cd poc/intake-runner` then `npm install --save-exact --ignore-scripts @anthropic-ai/sdk`. `--ignore-scripts` stops any package from running install-time code. This records an exact version in `package.json` and `package-lock.json`; review that diff and the package's license before committing it. `node_modules/` is git-ignored. Installing contacts the npm registry (it is not an API call and needs no key).
4. **Put the key in this terminal window only, without displaying or saving it.** Use Windows PowerShell or PowerShell 7 in the folder `poc/intake-runner`. (The `ant auth login` profile option needs the `ant` CLI, which is not installed on this machine.) Paste these lines one block at a time; when `Read-Host` asks, paste the key (nothing is shown as you type or paste):
   ```
   $secure = Read-Host "Anthropic API key (hidden)" -AsSecureString
   $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
   try { $env:ANTHROPIC_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
   finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr); $secure.Dispose(); Remove-Variable secure, bstr }
   if ($env:ANTHROPIC_API_KEY) { "Key is set in this window only." }
   ```
   Why this is safe: the key is typed into a hidden prompt, so it never appears on screen and is not part of any command line; PowerShell's history stores commands, not prompt answers; the temporary variables are wiped; the only copy is this window's environment variable, which the SDK reads itself. Do **not** run `Get-ChildItem Env:` or `$env:ANTHROPIC_API_KEY` alone (they would print it), do not echo it, do not save it in a `.env` file or script, and do not paste it into a chat. Any program started from this window can read it while it is set, so use a window you control, and end the session with: `Remove-Item Env:ANTHROPIC_API_KEY`.
5. **Run the dry run and read it:** `npm run live:dry-run`. It sends nothing. Check: the model line says `claude-haiku-5-5`; both request bodies contain only the synthetic masked text; the call limit is 2 with 2 calls planned; and the readiness checklist shows `[ok]` for model, input, and call limits. The three `[--]` items (SDK installed, confirmation variable, `--live` flag) are the only things left, and they are meant to be switched on only at go time.
6. **Only when you decide to spend** (about $0.0002 expected, a hard ceiling of about $0.0021 for the two calls, at list prices dated 2026-10-06): in the same window with the key set, run
   ```
   $env:INTAKE_ALLOW_LIVE_CALLS = 'yes'
   node src/live-entry.ts --live --max-calls 2
   ```
   It makes at most 2 calls (one item: classify, then extract) with `claude-haiku-5-5`, then prints a result summary, token usage, and an approximate actual cost. It shows no prompts or provider text and never prints the key. If anything fails, the item ends as `needs-human` with no handoff.
7. **Afterwards:** `Remove-Item Env:ANTHROPIC_API_KEY` and `Remove-Item Env:INTAKE_ALLOW_LIVE_CALLS`, close the window, and delete or rotate the test key in the Console.

## Estimated test cost (one item = 2 calls)

List prices (USD per million tokens) from the Claude API skill's cached table dated 2026-10-06; check the pricing page before spending. The estimator assumes about 3 characters per token (conservative) and cannot know how many thinking tokens a model will use, so it gives a low estimate (about 150 output tokens per call) and a **hard ceiling** (every call uses its entire output budget).

| Model | Input / output per MTok | One item, low estimate | One item, ceiling at 2048 output tokens per call | Ceiling at 1024 |
|---|---|---|---|---|
| **`claude-haiku-5-5` (default)** | $0.10 / $0.50 (prompts up to 100K tokens) | about $0.0002 | about $0.0021 | about $0.0011 |
| `claude-sonnet-5-5` | $2 / $10 | about $0.005 | about $0.043 | about $0.022 |
| `claude-opus-5-5` | $4 / $20 | about $0.010 | about $0.086 | about $0.045 |

Input is about 980 tokens for the two requests combined. The ceiling cannot be exceeded: output per call is capped by `max_tokens`, and calls by `--max-calls`. Running both skill examples is double these figures. These are estimates, not quotes.

## Local deterministic skill (skill_config mode)

No vocabulary of its own and no industry rules. Classification counts distinct configured keywords found as whole words or phrases (a tie becomes `ambiguous_category`, no match `unknown_category`); the `label` extractor reads `<label>: value` lines, the `token` extractor finds masked tokens such as `[ID_1]`; conflicting values are not extracted and are flagged `ambiguous_field`. It does not score confidence.

## Not included (limitations)

| Not included | Consequence |
|---|---|
| **No live call has ever been made** | The adapter is verified only against a fake client. Real API behavior (schema acceptance, latency, refusals, thinking-token use, actual cost) is unverified. |
| No personal-data detector | The runner **trusts** `masking.applied`. Real customer text must never reach a provider until detection, masking, and the vault exist (INT-06 to INT-09). |
| No SDK dependency declared | Installing it is a founder step (see setup). Type-checking has not been run. |
| Draft prompts and schemas | The two instruction texts and answer schemas are unapproved and untested against a real model. |
| No metering, caps, or kill switch in the product | Only the entry point's call counter and the token limits exist. No usage events, per-tenant caps, or alerts (FND-09). |
| No backoff or rate-limit handling | Attempts are plain and bounded. |
| No database, queue, vault, audit chain, authentication, or row-level security | Nothing is stored; the tenant check is code-level only. |
| No Processing receiver | Only the envelope is produced (AT-20 not covered). |
| Contracts are proposals | Reason codes `ambiguous_category`, `ambiguous_field`, and `model_failed` were added to the draft `work_item.v1`; the envelope has no version field. |
| No accuracy measurement | No labelled evaluation set (INT-13); correctness is tested only on invented examples. |

## What remains before a real Claude connection to real data

1. Founder decisions: D-03, provider and model choice, data terms and retention (D-11, legal review), D-04 limits and thresholds, D-12 spend caps, D-14 stack.
2. Real masking before any real text: detector (INT-06), stable-token masking (INT-07), encrypted vault (INT-08), fail-closed policy (INT-09), measured recall (AT-08).
3. A first synthetic live run to verify the adapter against the real API, then review of any differences it reveals.
4. Production key handling in a secrets service (FND-10) and a composition root that is not this test entry.
5. Metering, per-tenant caps, kill switch, and spend alerts (FND-09, AT-18).
6. Tenant wall, audit, and duplicate protection around every model call (FND-02 to FND-04).
7. Safe logging with a correlation id and no content (FND-19).
8. Evaluation: labelled set, accuracy gate, injection tests against the real model, prompt review (INT-13, AT-17, AT-19).
9. Engineering hygiene: type-checking, pinned and license-checked dependencies, CI secret scan.
10. Founder approval of the register rows (FND-17, INT-12, FND-26) and of the draft contract changes.

## Run the tests and demo (no network, no key)

Requires Node 24 or later (built-in TypeScript type stripping). No installation is needed.

```
cd poc/intake-runner
npm test                  # 134 tests
npm run demo              # 7 scenarios with the local scripted mock
npm run live:dry-run      # request bodies and cost estimate; sends nothing
node src/cli.ts examples/skill-input.json
```

## Tests (134)

`intake-runner` (18) and `classify-extract` (24): contract, gates, deterministic skill. `model-runner` (37): gateway behavior and the human-review regression matrix. `skills` (6): definitions versus `SKILL.md` and `AGENT.md`. `claude-provider` (28): request shape, structured-output schema, good answers, 13 failure kinds under three fallback settings, error-text discarding, refusal and truncation blanking, timeouts, bounded retries, injection text, gates before any call. `live-dry-run` (5): the entry point run as a child process in a sanitized environment (no confirmation variable, no credentials), checking the dry run (Haiku default, two synthetic request bodies, call limit 2, readiness checklist, nothing sent) and every refusal path. `live-gate` (15): argument parsing and credential refusal, path and synthetic checks, the gate, cost arithmetic, and static guarantees (dry run first, SDK imported only after the gate and only once, no credential reads, no live-capable npm script, no declared dependency).

## Mapping to the register

| Row | Covered here | Remains |
|---|---|---|
| FND-17 | Provider-independent gateway; Claude adapter shape; gated test entry | A real, verified call; metering; library decision; approval |
| FND-26 | Executable `work_item.v1` and envelope validators; Intake skill folders | Other agents, remaining contracts |
| INT-12 | Four Intake skills as definitions plus `SKILL.md` drafts; deterministic, mock, and (untested live) Claude execution | Real model verification, sidecar format (D-07), vertical content (D-01) |
| PRC-06 | The envelope Processing would receive | A receiver, version negotiation, audit event per handoff |

No acceptance test AT-01 to AT-22 is claimed as passed.
