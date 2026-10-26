# Founder phone test: runbook and blockers

Status 2026-10-26: **the local code is built and tested (867 mock tests); no real call has been placed.** Nothing has been installed, purchased, exposed or called. The authority for status is `docs/blueprint/PLATFORM_MASTER_PLAN.md` section 11.5 item 24.

All commands below are **PowerShell** and are run from the working folder:

```powershell
cd C:\dev\business-agent-platform\poc\intake-runner
```

The config file, the kill file and the SQLite file are all resolved **relative to this folder**, so every command must be run from it. (`--config` accepts only a relative `.json` path: no drive letter, no `..`.)

## What it is

Dial a Twilio number, talk naturally to an AI assistant, and see a validated Intake record appear on the existing dashboard prototype.

```
phone -> Twilio ConversationRelay (speech to text and back) -> wss tunnel -> src/ws-server.ts (secret path + signature)
      -> src/relay-handler.ts: consent -> src/pii-screen.ts (mask) -> existing Intake agent (live Claude: classify, extract, ground, validate)
                                      -> src/dialogue-model.ts (live Claude speaks, masked text only)
      -> src/intake-record-store.ts (SQLite) -> src/dashboard-server.ts (127.0.0.1) -> prototype/intake-work-items
```

The Intake agent is the existing one, unchanged except for an opt-in founder tier in `src/intake-entry.ts` (one named `ws-founder-` tenant, masking source `founder-test-call`, event ids `evt-founder-`). The synthetic-only gate and the reviewed-fixture live path are untouched for everything else.

## Fixed facts

| Item | Value |
|---|---|
| Phone endpoint (local) | `127.0.0.1:8788`, WebSocket on `/relay/<your secret>`. The tunnel forwards the public address here. |
| Dashboard | `http://127.0.0.1:8787/` (also `localhost:8787`). Never tunnelled. |
| Dry run (opens nothing) | `npm run founder:check -- --config founder-call.config.json` |
| Serve (needs the whole gate) | `node src/founder-call-entry.ts --serve --config founder-call.config.json` |
| Exit codes | 64 bad arguments, 65 config problem, 66 config unreadable, 69 official SDK missing, 78 gate refused |
| Node | 24.15 or newer (built-in SQLite). This machine has 24.21. |

`config.numbers` is the **Twilio number that will be dialed** (E.164), not the founder's own phone. The founder's phone is only ever the caller; its number is never read, stored or sent to a model.

## Rules for the test call

- Speak an **invented persona** and invented details only. The masker cannot recognise a lower-case name or place that nothing introduces, and rule-based masking is not the platform masking stage (INT-07 is not started). Every name the caller will say should be in `persona_names`.
- Treat the secret path like a password: do not paste it into chat, tickets or screenshots. If it leaks, make a new one, update the config, and approve the new digest.
- One call at a time, and no more than `max_calls` calls, `max_minutes`, `max_turns` and `max_claude_calls` from the approved config.
- **Kill switch:** create the file named by `kill_file` (default `founder-call.stop`). It is checked when a call starts and each time the caller finishes speaking, so it is not instant: a silent caller keeps the call open until the idle timeout. **Ctrl+C in the serving terminal is the immediate stop.**

## Costs: totals versus model estimates

**Total costs (what the providers bill; published prices read from Twilio's pages, not yet seen on a bill):**

| Item | Price |
|---|---|
| Twilio local number | $1.15 per month |
| Inbound call | $0.0085 per minute |
| ConversationRelay | $0.07 per minute (Twilio's page does not say what it includes) |
| Text-to-speech | basic voices free; premium tiers $0.0008 to $0.013 per 100 characters. Whether the default voice (ElevenLabs) is billed this way is **unconfirmed** |
| Tunnel | free tier or paid; the founder's choice |

So an 8-minute call (the cap) is about 8 x ($0.0085 + $0.07) = **$0.63 before any voice surcharge**, and a 3 to 5 minute call about $0.24 to $0.39, plus the $1.15 monthly for the number. Twilio's FAQ states a $15 trial credit; whether it can pay for ConversationRelay is **unconfirmed**. A trial is expected to call only verified numbers and to play a trial notice (not checked here).

**Model estimates (not billing; a guess from list prices, to be checked against the Anthropic console afterwards):**

- Claude Haiku 5.5 list price in the repo is $0.10 per million input tokens and $0.50 per million output tokens (`src/cost-estimate.ts`, snapshot dated 2026-10-06, **not re-checked**).
- The dry run prints a **ceiling** of $0.352 for the whole approval (150 Claude calls, each assumed to use 3000 input and 4096 output tokens). That is a hard upper bound on what the code will allow, not a prediction.
- The dry run also prints "a typical short Intake call is about $0.0001". That is the **low estimate for one classification request only**, not a call total. A real call makes roughly 2 Intake requests per caller turn plus 1 dialogue request per turn.
- The acceptance targets (at most $0.05 Claude and $1.00 Twilio for the test call) are budgets to check after the call, not forecasts. The suggested spend cap is $10 across Twilio and Anthropic, including the number's first month.

## Confirmed versus unverified

**Confirmed locally (code and the 867 mock tests; no network):** consent gating; masking behaviour; secret-path, signature, lockout, call-budget and replay checks; tenant selection by dialed number; the Intake agent producing and validating the record; the SQLite store; the loopback dashboard and its isolation; the kill file, caps and failure handling; that persona details do not appear in any Claude request, reply to the phone provider, log, database file or dashboard output. These ran against a local fake of the Claude SDK client and a stand-in for Twilio.

**Read in Twilio's published documentation, never exercised:** the TwiML attributes used (`url`, `language`, `welcomeGreeting`, `welcomeGreetingInterruptible="none"`); the WebSocket messages (`setup` with `callSid`/`to`, `prompt` with `voicePrompt` and `last`, `interrupt` with `utteranceUntilInterrupt`, and our `text`/`end` replies); the need to accept the AI addendum; prices.

**Unverified (a real call, or a small live check, is the only proof):**
1. **Claude requests.** The streaming dialogue request (`stream: true` with `output_config: { effort: "low" }`) and the SDK's streaming event shape have never been sent. If the API rejects them the call fails right after consent with a spoken apology. This is the most likely first failure. The existing structured Intake requests have not been sent live either.
2. **Which URL form Twilio signs** for the handshake (`wss://` or `https://`). The server accepts both and the signed URL includes the secret path. If every handshake is refused with 403, suspect this first.
3. **Consent timing.** The code treats the caller's first completed utterance after the greeting as the consent answer. How Twilio treats speech during a non-interruptible greeting is unknown.
4. **Trial limits.** Whether ConversationRelay works on a trial, how the trial notice interacts with the greeting, and whether the one auto-assigned number can be used.
5. **Voice defaults.** Text-to-speech provider (ElevenLabs by default), speech-to-text provider (Deepgram), interruption and profanity filter use Twilio's defaults and are not set by us.
6. **Tunnel behaviour.** That the chosen tunnel carries WebSockets, and that the free address stays stable.
7. **Missing `ANTHROPIC_API_KEY`.** What the official SDK does with no key is untested; it happens before any port opens.
8. **End-of-call cut-off, latency and how natural the replies feel.** `after_speech_ms` (4000) is a guess.

## Approvals and payments the founder must make (nothing below can start without them)

**Decisions**
1. The founder-test gate tier beside the synthetic-only gate.
2. Live Claude calls on non-fixture, masked text.
3. The invented-persona rule.
4. The consent notice wording (`CONSENT_NOTICE` in `src/founder-call-entry.ts`; the dry run prints it into the TwiML).
5. Twilio's retention of call data (one provider label says TwiML logs, including `<Say>` logs, can be reviewed for up to 30 days; whether speech text appears in Twilio's debugger is unchecked). Retention decision C14.
6. A short legal check on call-consent and AI-disclosure law (sources so far are vendor blogs, not statutes).
7. The Anthropic API data terms for the key used.
8. A spend cap.
9. Accepting Twilio's "Predictive and Generative AI or ML Features Addendum" in the Twilio console.

**Accounts, installs and money**
1. A Twilio account; on a trial, verify the founder's own mobile; upgrade or buy the number ($1.15 per month) if a trial cannot be used.
2. An Anthropic API key with a monthly spend limit set in the Anthropic console.
3. A tunnel tool and account (a **new install**), for example ngrok or Cloudflare Tunnel. Opening it exposes the secret-path WebSocket to the internet; the dashboard stays local.

None of these credentials goes into the repository. `founder-call.config.json`, `founder-call.stop` and `*.sqlite*` are git-ignored.

## First-call sequence

### 1. Approvals and accounts
Complete the lists above. Create the Twilio account, the Anthropic key (with its spend limit) and the tunnel account. Accept the Twilio addendum.

### 2. Start the tunnel first
The config needs the tunnel's public host, so the tunnel must exist before the config is written. Forward the public address to `127.0.0.1:8788` **only**. Typical commands (check the tool's own documentation; neither was run here):

```powershell
ngrok http 8788
# or
cloudflared tunnel --url http://127.0.0.1:8788
```

Note the public host the tool prints. Free addresses usually change when the tunnel restarts: if it does, repeat steps 3 to 6 (new config, new digest, new TwiML Bin).

### 3. Write the config and run the first dry run

```powershell
Copy-Item examples\founder-call.config.example.json founder-call.config.json
notepad founder-call.config.json
```

Set:
- `numbers`: the Twilio number to be dialed, in E.164 (for example `+12025551234`).
- `public_wss_url`: `wss://<tunnel host>/relay/<your own random secret of 32 to 64 letters, digits, - or _>`. The dry run prints a fresh random value you can use. The secret is a second factor, because Twilio's handshake signature is the same for every call.
- `persona_names`: every name the caller will say.
- `max_calls` (1 to 10), `max_minutes`, `max_turns`, `max_claude_calls`.
- `expires`: no more than 30 days ahead.

The example's placeholder number, host and secret can never be approved, even with a matching digest.

```powershell
npm run founder:check -- --config founder-call.config.json
```

At this point the gate line will list missing environment variables and a digest mismatch. That is expected. Copy the printed **config digest** and the **TwiML**. Any later edit to the config changes the digest and un-approves it.

### 4. Twilio console
Create a **TwiML Bin** with the printed XML. Set the number's "A call comes in" to that TwiML Bin. (This machine then exposes no HTTP webhook, only the WebSocket.)

### 5. Set the environment and run the second gate check
Use `Read-Host` so the values are not stored in the PowerShell history (it does echo what you type on screen, so do this where no one can see it). Set them in **the same terminal** that will serve. Prefer an Anthropic key created for this test, so it can be deleted later without affecting other work.

```powershell
$env:TWILIO_AUTH_TOKEN = Read-Host "Twilio auth token"
$env:ANTHROPIC_API_KEY = Read-Host "Anthropic API key"
$env:FOUNDER_CALL_APPROVED_DIGEST = "<the digest printed in step 3>"
$env:INTAKE_ALLOW_LIVE_CALLS = "yes"
npm run founder:check -- --config founder-call.config.json
```

The gate line must now read `[ok] all checks pass`. If it does not, fix what it names before going on.

### 6. Recommended, not built: a live check of the Claude requests
Unverified item 1 is the likeliest first failure. A small approved script that sends one real streaming dialogue request and one real structured Intake request through the same code would cost an estimated tenth of a cent and show a request-shape error before any phone call. It does not exist yet; adding it needs the founder's approval for the API call.

### 7. Serve

```powershell
node src/founder-call-entry.ts --serve --config founder-call.config.json
```

It prints `Serving.` with the two local addresses. Server log lines carry fixed codes and counts only, for example `CALL_STARTED`, `CONSENT_GRANTED`, `RECORD_NEW`, and on trouble `SETUP_REFUSED`, `REPLAY`, `BUSY`, `CALL_BUDGET`, `KILLED`, `DIALOGUE_FAILED`, `FINAL_INTAKE_FAILED`, `UTTERANCE_REFUSED`, `RECORD_REFUSED`.

### 8. The call
From the verified phone, call the Twilio number. Listen to the notice, say "yes", then describe a plumbing problem as the invented persona (for example a burst pipe in the kitchen, with an invented address), and answer the assistant's questions. The assistant closes the call itself once the request is recorded.

### 9. Check the result
Open `http://127.0.0.1:8787/` and **press F5**. The prototype loads its data once when the page opens and does not refresh itself, so a record made after the page was opened appears only after a reload. For the raw view:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/items | ConvertTo-Json -Depth 8
```

Then work through the acceptance checks below. Read the real costs in the Twilio console usage page and the Anthropic console usage page.

### 10. Stop and clean up
Order matters: **cut the route first**, so nothing can reach this machine while you clean up. Nothing here is automatic, and the steps marked *optional* are the founder's decision.

**A. Disable the test routing (do this first)**
1. In the Twilio console, change the number's "A call comes in" setting **away from the TwiML Bin** (to its previous setting, or to a harmless static response). Do not delete anything yet. From this point a call to the number can no longer reach the tunnel.
2. Stop the tunnel (Ctrl+C in its terminal). Without it, the public address no longer reaches this machine even if something is still configured.

**B. Stop the local test**
3. Press Ctrl+C in the serving terminal (the immediate stop). If a call is in progress and you would rather let it end, create the kill file first: `New-Item founder-call.stop -ItemType File`.
4. Remove the kill file if you made one, and decide about the test record. To keep it for the record, copy `founder-call.sqlite` somewhere private first. To remove it:
   ```powershell
   Remove-Item founder-call.stop -ErrorAction SilentlyContinue
   Remove-Item founder-call.sqlite, founder-call.sqlite-wal, founder-call.sqlite-shm -ErrorAction SilentlyContinue
   ```
5. Remove the config (it holds the secret path and the number). The secret path is now retired; never reuse it.
   ```powershell
   Remove-Item founder-call.config.json
   ```
6. Clear the environment variables in this terminal (they also vanish when it closes):
   ```powershell
   Remove-Item Env:TWILIO_AUTH_TOKEN, Env:ANTHROPIC_API_KEY, Env:FOUNDER_CALL_APPROVED_DIGEST, Env:INTAKE_ALLOW_LIVE_CALLS -ErrorAction SilentlyContinue
   ```
7. Confirm the repository is clean: `git status --short` should list nothing from this test (the config, kill file and database are git-ignored).

**C. Optional follow-ups, each a separate decision by the founder (none is done for you)**
- **Delete the TwiML Bin** once you are sure the number no longer points at it. Keep it if you plan another run (the digest and the Bin must be redone if the tunnel address changes).
- **Release the Twilio number.** This stops the $1.15 monthly charge but **cannot be undone** (you may not get the same number back). Leave it if you will call again soon.
- **Twilio auth token.** Rotating it affects every other application that uses the same account token, so check what else uses it first. Rotate it only if it was exposed, or the account is dedicated to this test.
- **Anthropic API key.** If you created a key just for this test, deleting it is safe. If the key is shared with other work, do **not** delete or rotate it for this reason alone; rely on the monthly spend limit instead, and rotate only if it was exposed.
- **Tunnel account.** Delete its token if you will not reuse it.
- **Twilio call logs.** They may be kept by Twilio for a period (see the retention decision above). Deleting them early is a console action not checked here.

## Acceptance checks for the first call

| # | Check | Pass |
|---|---|---|
| 1 | Consent | Saying anything but a plain yes ends the call, the log shows no `RECORD_NEW`, and the Anthropic console shows no request for that call. |
| 2 | Conversation | The assistant asks one short question at a time and the call ends by itself once the request is recorded. |
| 3 | Record | After F5, the dashboard shows one item for the call: category, status Ready (or Needs review with a reason), masked fields, personal-data counts. |
| 4 | Privacy | The persona's name, address and any number or e-mail spoken appear nowhere in the dashboard, the SQLite file or the server console. Only placeholders such as `[ADDRESS_1]`. |
| 5 | Cost | Anthropic cost for the call at most $0.05 and Twilio cost at most $1.00, read from the two consoles afterwards. |
| 6 | Kill switch | With the kill file present, the next call or the next thing the caller says ends the call and saves nothing. |
| 7 | Clean up | Section 10 parts A and B completed, with routing disabled first; part C decided one item at a time. |

## What is NOT included

Processing, Quality Control and Reporting; recording; outbound calls; SMS; more than one tenant live; login or tenant isolation on the dashboard (it is loopback-only, FND-02 / R01 not met); encryption at rest (FND-10); a retention policy (C14); a freshness check on Twilio's signature (the secret path, `max_calls`, the expiry and the kill switch bound a leak). The masker is a stand-in, not INT-07.
