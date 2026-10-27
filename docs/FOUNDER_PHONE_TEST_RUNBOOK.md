# Founder phone test: runbook and blockers

Status 2026-10-26: **the code is built and tested locally (1130 mock tests, a dated snapshot of 2026-10-26, not maintained), and real calls HAVE been placed.** At least two live calls reached the server and each saved a record (evidence: the two records in the local SQLite file, which carry the live Claude model label; the founder's own report of the calls). The founder upgraded the Twilio account first, because ConversationRelay is blocked on trial accounts. The later call was handled by code that already had the confirmation gate, and ended unconfirmed because the request fitted no configured category, so **no read-back and no "yes" has been seen on a live call**. Those calls found problems, and the fixes made since are **tested locally only and have not been tried on a live call**: the read-back flow, the longer wait before hanging up, standalone spaced-digit masking, the owner screens. The server was not logging to a file, so there is no log of those calls here. A cleaning skill example (`examples/skill-cleaning.json`) is tested but not applied to the live configuration. The dashboard is the founder's permanent decision: it is kept and evolved into the production customer dashboard and is never replaced without explicit founder authorization (`docs/PRODUCT_CONTINUITY.md`). The authority for status is `docs/blueprint/PLATFORM_MASTER_PLAN.md` section 11.5 item 24.

All commands below are **PowerShell** and are run from the working folder:

```powershell
cd C:\dev\business-agent-platform\poc\intake-runner
```

The config file, the kill file and the SQLite file are all resolved **relative to this folder**, so every command must be run from it. (`--config` accepts only a relative `.json` path: no drive letter, no `..`.)

## What it is

Dial a Twilio number, talk naturally to an AI assistant, confirm what it read back, and see the intake appear on the owner screens of the local dashboard (the list, and a page for each intake).

```
phone -> Twilio ConversationRelay (speech to text and back) -> wss tunnel -> src/ws-server.ts (secret path + signature)
      -> src/relay-handler.ts: consent -> src/pii-screen.ts (mask) -> existing Intake agent (live Claude: classify, extract, ground, validate)
                                      -> src/dialogue-model.ts (live Claude speaks, masked text only)
                                      -> read-back (the server's own fixed words) -> caller says yes or no -> confirmed or unconfirmed record
      -> src/intake-record-store.ts (SQLite) -> src/owner-view.ts (strict allow-list) -> src/dashboard-server.ts (127.0.0.1)
      -> prototype/intake-work-items (the owner's list and one-intake screens)
```

The Intake agent is the existing one, unchanged except for an opt-in founder tier in `src/intake-entry.ts` (one named `ws-founder-` tenant, masking source `founder-test-call`, event ids `evt-founder-`). The synthetic-only gate and the reviewed-fixture live path are untouched for everything else.

## Fixed facts

| Item | Value |
|---|---|
| Phone endpoint (local) | `127.0.0.1:8788`, WebSocket on `/relay/<your secret>`. The tunnel forwards the public address here. |
| Owner screens | `http://127.0.0.1:8787/` (also `localhost:8787`): the list of intakes and the page for one intake. Their data is `GET /api/owner` (and `/data.js` for the first paint). There is no other page: the earlier second owner page at `/owner` was retired, so `/` is the only dashboard. Never tunnelled. Nothing else is served: the old engineering route `/api/items` no longer exists. |
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

## How a call ends: read-back, confirmation, and what is saved

**Tested locally (invented data, a stand-in for Twilio, a local fake of the Claude client); not yet tried on a live call.**

1. While the assistant is still collecting details it asks one thing at a time. If Intake lists nothing missing but is not ready (for example the request fits no configured category), the assistant is asked for more about the request. It is never told to say "recorded, goodbye" in that state.
2. When Intake says the request is ready, the server runs one fresh Intake pass over everything heard so far, then **reads back, in fixed words of its own,** the non-address fields only, for example "Let me check what I have. Job description: burst pipe. Is that correct? Please say yes or no." **The address is never spoken in any form, and a mask placeholder is never spoken.** The caller may answer over the read-back.
3. A short plain **yes** confirms exactly the item that was read back. The assistant says "Thank you. Your request is recorded and a person will follow up. Goodbye." (this line cannot be talked over), the record is saved with no further model call, and the call ends after the line has had time to play (about 1.5 seconds plus 70 milliseconds per character, at most 15 seconds, and never less than `after_speech_ms`).
4. A **no** (or any refusal or doubt: "no", "wrong", "yes but...") asks "What should I change?", listens, and reads back again. At most two read-backs. An answer that is neither yes nor no is asked for once more; a second one ends the call unconfirmed. **20 seconds of silence** after a read-back ends the call unconfirmed.
5. Every other ending (the caller hangs up, a turn or time limit, a model failure, a second no) saves a record that is **unconfirmed**: held for a person, not handed off, with the reason `not_confirmed`. (The kill switch is different: it ends the call and saves nothing.)
6. Only a confirmed record may be handed off. The store refuses any record that breaks that rule. Nothing connects the phone path to Processing today, and `eligibleForProcessing` (confirmed, ready, handed off, **and either no address or one the caller confirmed, checked against the encrypted contact**) is the one test a future bridge must use. A record that has an address is never eligible, because the address is never read back or checked.

Not covered, and said plainly: the caller's phone number is never read or stored, so the owner cannot call anyone back from this system; "requested time" is what the caller asked for, and nothing here books or schedules anything.

## Costs: totals versus model estimates

**Total costs (what the providers bill; published prices read from Twilio's pages, not yet seen on a bill):**

| Item | Price |
|---|---|
| Twilio local number | $1.15 per month |
| Inbound call | $0.0085 per minute |
| ConversationRelay | $0.07 per minute (Twilio's page does not say what it includes) |
| Text-to-speech | basic voices free; premium tiers $0.0008 to $0.013 per 100 characters. Whether the default voice (ElevenLabs) is billed this way is **unconfirmed** |
| Tunnel | free tier or paid; the founder's choice |

So an 8-minute call (the cap) is about 8 x ($0.0085 + $0.07) = **$0.63 before any voice surcharge**, and a 3 to 5 minute call about $0.24 to $0.39, plus the $1.15 monthly for the number. Twilio's documentation says **ConversationRelay is blocked on trial accounts**, so a paid (upgraded) account is required; the founder upgraded on 2026-10-26 and the calls that followed connected. Twilio's FAQ states a $15 trial credit, but that credit does not apply to this test now. Whether any usage was billed to a credit balance has not been checked.

**Model estimates (not billing; a guess from list prices, to be checked against the Anthropic console afterwards):**

- Claude Haiku 5.5 list price in the repo is $0.10 per million input tokens and $0.50 per million output tokens (`src/cost-estimate.ts`, snapshot dated 2026-10-06, **not re-checked**).
- The dry run prints a **ceiling** of $0.352 for the whole approval (150 Claude calls, each assumed to use 3000 input and 4096 output tokens). That is a hard upper bound on what the code will allow, not a prediction.
- The dry run also prints "a typical short Intake call is about $0.0001". That is the **low estimate for one classification request only**, not a call total. A real call makes roughly 2 Intake requests per caller turn plus 1 dialogue request per turn.
- The acceptance targets (at most $0.05 Claude and $1.00 Twilio for the test call) are budgets to check after the call, not forecasts. The suggested spend cap is $10 across Twilio and Anthropic, including the number's first month.

## Confirmed versus unverified

**Confirmed locally (code and the 1130 mock tests, a dated snapshot; no network):** consent gating; masking behaviour, including digits read out one at a time or in groups ("1 5 9 5 1"); secret-path, signature, lockout, call-budget and replay checks; tenant selection by dialed number; the Intake agent producing and validating the record; the read-back, the yes/no gate, the silence timer, and the confirmed and unconfirmed records described above; the store refusing a record that breaks the confirmation or address rules; the assistant never being told to wrap up while Intake is not ready; the SQLite store; the dashboard server (loopback only, one tenant, GET and HEAD only, exact paths, no query string, loopback Host only, one strict page policy with nothing inline) and its isolation; the owner view (a strict allow-list: no confidence, codes, masks, steps, versions, ids or address values ever reach the page; nothing says or implies a booking); the owner screens run against a stand-in for the browser's DOM (list, one intake, empty store, failures, bad data, text-only output); the kill file, caps and failure handling; that persona details do not appear in any Claude request, reply to the phone provider, log, database file, `/api/owner` or `/data.js`. These ran against a local fake of the Claude SDK client and a stand-in for Twilio.

**Observed in the first live calls (2026-10-26), from the saved records and the founder's report, not from a server log:** Twilio connected and the handshake was accepted; the live Claude Intake path produced and saved records (the model label in the records is `claude:claude-haiku-5-5`); calls lasted 6 and 10 caller turns, so the streaming dialogue replies kept a conversation going; the dashboard showed a record; the later record carries the confirmation fields, so the confirmation gate ran live once, on an unconfirmed ending. Problems they exposed, each now fixed in code and tested locally only: the assistant ended a call before confirming; digits read out one at a time were stored unmasked; a request outside the configured categories (a cleaning job in a plumbing configuration) became `unknown_category`; the old dashboard showed engineering labels and a misleading "data did not load" message when the store was empty.

**Read in Twilio's published documentation, never fully exercised:** the TwiML attributes used (`url`, `language`, `welcomeGreeting`, `welcomeGreetingInterruptible="none"`); the WebSocket messages (`setup` with `callSid`/`to`, `prompt` with `voicePrompt` and `last`, `interrupt` with `utteranceUntilInterrupt`, and our `text` (with `last` and `interruptible`) and `end` replies); the need to accept the AI addendum; prices. Twilio's pages do not say whether `end` cuts speech that is still queued.

**Unverified (a real call is the only proof):**
1. **The read-back flow on a live call**, including whether Twilio's speech-to-text turns "yes" and "no" into text the classifier reads correctly, and how long the fresh Intake pass adds before the read-back (about 1 to 3 seconds of silence is expected).
2. **The longer hang-up wait.** The wait is an estimate (length based); whether `end` cuts queued speech is undocumented. If the goodbye is still clipped, the next step is Twilio's playback events.
3. **Which URL form Twilio signs** for the handshake. Calls connected, so one of the accepted forms matched, but nothing recorded which. The accepted forms are the configured address and its `https://` form, each with and without a trailing slash, and the same four without the port.
4. **Consent timing.** The code treats the caller's first completed utterance after the greeting as the consent answer. Calls proceeded; how Twilio treats speech during a non-interruptible greeting is not known.
5. **Voice defaults.** Text-to-speech provider (ElevenLabs by default), speech-to-text provider (Deepgram), interruption and profanity filter use Twilio's defaults and are not set by us.
6. **Tunnel behaviour.** A quick tunnel carried the calls. It was stopped once (low memory) and a restarted quick tunnel gets a **new host**, which means a new config, secret, digest and TwiML Bin.
7. **Missing `ANTHROPIC_API_KEY`.** What the official SDK does with no key is untested; it happens before any port opens.
8. **The owner screens in a real browser.** Only their scripts have been run (against a stand-in DOM); layout, dark mode, phone width and the time shown in the viewer's zone have not been looked at.
9. **How natural the replies feel, and latency.**

## Option A and optional contact capture (added 2026-10-26; tested locally, not yet tried live)

- **What changed in the call.** Each caller turn waits (up to 8000 ms) for one fresh Intake pass over everything said; code, not the model, then picks one thing: read back, ask for one named field, clarify, or just listen. A slow, failed or stale pass makes the assistant listen; it never asks from old data. Closing lines no longer promise a follow-up; the confirmed line is "Thank you. Your request is recorded. Goodbye."
- **Log lines to expect** (fixed words and numbers only): `TIMING` (milliseconds of the Intake pass), `ASK`, `LISTEN`, `CLARIFY`, `PREVIEW_BUDGET_EXCEEDED`, `PREVIEW_UNUSABLE`, `FALLBACK_RECORD`, then `READBACK` and `CONFIRMED` or `UNCONFIRMED`.
- **Cleaning skill.** The live configuration is the cleaning skill (approval digest `2959c7c5…c41`). The digest it replaced was `79e6dcbd…ab78a15`: to roll back, restore the backed-up config and set that digest. Keep backups outside the repository; the config holds the relay secret.
- **Restart.** Stop the server with Ctrl+C in the terminal that runs it (its credentials stay in that terminal). Set `FOUNDER_CALL_APPROVED_DIGEST` to the digest you approve, then run `node src/founder-call-entry.ts --serve --config founder-call.config.json`. To keep a log, pipe it through `Tee-Object`; PowerShell 5.1 writes UTF-16, so remove the null bytes before searching. The log is gitignored.
- **Contact capture (optional, off unless a key is set).** With `FOUNDER_CONTACT_KEY` (32 bytes, base64; `npm run contact:lookup -- --new-key` prints one on an interactive terminal) the assistant must collect a name, a usable callback number and a service address before a request is ready; the number (only) is read back; a yes stores the contact encrypted in its own file for 30 days. Lose the key and the contacts cannot be read. The owner reads one with `npm run contact:lookup -- --list` and `-- --show <call_ref>` on this machine, on an interactive terminal only. The dashboard never shows it. Known limits: the name is a rule-based guess and is not read back; the service address is read back to the caller (see the address section below). The running server was started before this code existed and has it off.

## Opening, services skill, handoff preservation and diagnostics (added 2026-10-26; tested locally, not yet tried live)

- **State.** The opening, services skill, handoff preservation and diagnostics are in commit `62da32c` (pushed); the later work in the address section below is local only. The running server (started 9:52 PM) has the code and contact capture ON but still uses the original one-category cleaning config with no `opening` block, so a live call today hears the original notice. **No call has been made since that restart.**
- **To use the opening or the services skill.** Add the `opening` block (business name, agent name, optional disclosure wording, optional special) and/or the services `skill_config` to the config, read the new approval digest from the dry run, paste the new TwiML (it carries the opening) into the Twilio TwiML Bin, set the digest, and restart. Each of those is its own request to the founder. The disclosure wording needs the business's legal check; a special is spoken only if you put it in the config, exactly as written.
- **Log lines to read after a call** (fixed words and numbers only): per reply, `REPLY_SENT` (words produced and written), `REPLY_EMPTY` (the model produced nothing), `REPLY_INTERRUPTED` (the caller talked over it), `REPLY_CUT` (the call ended mid-reply), `REPLY_SEND_FAILED` (a write was refused); per connection, `CALL_CLOSED` with who closed it (PEER, HANDLER, IDLE or PROTOCOL), the close code, milliseconds since the last caller words and the last reply, and counts of refused writes, partial results, interruptions and other frames.
- **What they can and cannot show.** They show whether words were produced and written to the socket, how long the first word took, and who ended the connection. They cannot show that the phone provider spoke the words, what the caller said, or why a peer hung up; the Twilio console's call log is the source for the call's end status.
- **Open.** The silent response (two cleaning calls ended shortly after the assistant's question; cause unknown) needs one founder-placed call on this build, invented details only. The Processing handoff is not wired: a saved record is where a call ends.

## Address confirmation, the vault witness and rollback (added 2026-10-26; tested locally, not yet tried live)

- **What the caller hears and what it means.** With contact capture on, after the callback number the assistant reads the captured service address back and the caller says yes or corrects it (up to three tries; a refusal or no answer ends it unconfirmed). A yes means only that the caller agreed with what was heard. It is **not** postal or address-database validation: nothing checks that the address exists or is deliverable.
- **What is saved.** `address_status` is `none` (no address held), `unverified` (held but not confirmed: never read back, refused, unanswered, cut off, or the contact failed to store) or `caller_confirmed` (read back, confirmed, and the encrypted contact for this call says confirmed). The address text is whatever the speech recognition and masker captured.
- **The vault witness.** The eligibility test for a future Processing bridge asks the contact vault for a state (confirmed, unconfirmed or refused; never the address) for the same tenant and call. No witness, a missing or expired contact, another tenant, a tampered row, the wrong key or any error means not eligible; `unverified` never qualifies.
- **Owner view.** A `caller_confirmed` call reads "Confirmed by the caller on the phone. Not checked against any address data." and no longer asks the owner to verify the address. **Dashboard wording conflict (unresolved):** the protected page script `prototype/intake-work-items/app.js` (about line 181) still shows "A person needs to check it with the caller." for every call with an address given, so a confirmed call shows both. It is unchanged until the founder authorizes a fix in writing.
- **Rollback risk.** The previous commit's code refuses a records database that holds any `caller_confirmed` record (the owner page and API fail for the tenant). Before activating the new code, back up `founder-call.sqlite` outside the repository; before any rollback, export and remove those rows or restore the backup. If a record write fails after the vault write, an orphan contact row stays until its 30-day expiry.
- **Still open.** The silent response (two cleaning calls ended shortly after the question, before the diagnostics existed; a later call was closed from the peer side before consent; cause not established). The Processing handoff is unwired. The name is not read back, and the main read-back yes is not delivery-checked.

## Development order and approval (added 2026-10-26)

Development order and approval: the industry order is Cleaning → Towing → Plumbing → HVAC, one at a time, and the founder approves each task before it begins (implementation → automated tests → live validation where applicable → founder review; finishing one task never authorises the next). See `docs/DEVELOPMENT_ROADMAP.md` sections 1b and 2. The prototype dashboard is preserved and evolved, never replaced (`docs/PRODUCT_CONTINUITY.md` governs).

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
1. A **paid (upgraded) Twilio account**: ConversationRelay is blocked on trial accounts (Twilio's documentation). The founder upgraded on 2026-10-26. A number ($1.15 per month) on that account, and a TwiML Bin pointing at the tunnel.
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

Note the public host the tool prints. Free addresses change when the tunnel restarts (a quick tunnel always gets a new host): if it does, repeat steps 3 to 5 (new secret, new config, new digest, new TwiML Bin).

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
**First delete the database from any earlier version.** The record store is now schema 2 and refuses a schema 1 file, so the server will not start until `founder-call.sqlite`, `founder-call.sqlite-wal` and `founder-call.sqlite-shm` are gone (see section 10 for the copy-then-remove commands). A file that holds a record today's privacy checks refuse (for example digits that were stored unmasked) is also unusable: the dashboard returns 503 and every call is hung up on. Back it up first, then remove it. The live database was backed up and replaced this way on 2026-10-26.

```powershell
node src/founder-call-entry.ts --serve --config founder-call.config.json
```

It prints `Serving.` with the local addresses (the owner screens at `http://127.0.0.1:8787/`). Server log lines carry fixed codes and counts only, for example `CALL_STARTED`, `CONSENT_GRANTED`, `READBACK`, `CONFIRMED`, `UNCONFIRMED`, `CONFIRM_TIMEOUT`, `RECORD_NEW`, and on trouble `SETUP_REFUSED`, `REPLAY`, `BUSY`, `CALL_BUDGET`, `KILLED`, `DIALOGUE_FAILED`, `FINAL_INTAKE_FAILED`, `UTTERANCE_REFUSED`, `RECORD_REFUSED`. They go to the console only, so copy them from the terminal if you want a record of a call.

### 8. The call
From the verified phone, call the Twilio number. Listen to the notice, say "yes", then describe a job that fits the configured categories as the invented persona (for the plumbing configuration, a burst pipe in the kitchen, with an invented address), and answer the assistant's questions. When it has enough it **reads back the job (never the address) and asks for a yes or no**; say yes. It then says the closing line and ends the call.

### 9. Check the result
Open `http://127.0.0.1:8787/`. The page refreshes itself about every 15 seconds, so no reload should be needed (this is tested, not yet seen in a browser). Press F5 if it does not. Open the intake to see its page. For the raw data the page uses:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/owner | ConvertTo-Json -Depth 8
```

Then work through the acceptance checks below. Read the real costs in the Twilio console usage page and the Anthropic console usage page.


### 10. Stop and clean up
Order matters: **cut the route first**, so nothing can reach this machine while you clean up. Nothing here is automatic, and the steps marked *optional* are the founder's decision.

**A. Disable the test routing (do this first)**
1. In the Twilio console, change the number's "A call comes in" setting **away from the TwiML Bin** (to its previous setting, or to a harmless static response). Do not delete anything yet. From this point a call to the number can no longer reach the tunnel.
2. Stop the tunnel (Ctrl+C in its terminal). Without it, the public address no longer reaches this machine even if something is still configured.

**B. Stop the local test**
3. Press Ctrl+C in the serving terminal (the immediate stop). If a call is in progress and you would rather let it end, create the kill file first: `New-Item founder-call.stop -ItemType File`.
4. Remove the kill file if you made one, and decide about the test records (they are masked, test-only, and the file must be deleted anyway before the next serve if the code changed the record layout). To keep it for the record, copy `founder-call.sqlite` somewhere private first. To remove it:
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
| 2 | Conversation | The assistant asks one short question at a time and never says the request is recorded before the read-back. |
| 3 | Read-back | After the details are in, the assistant reads back the job (not the address) and asks for yes or no. The log shows `READBACK`. |
| 4 | Confirmed ending | After a yes, the closing line is heard **in full**, then the call ends. The log shows `CONFIRMED`. If the line is clipped, that is the finding. |
| 5 | Unconfirmed ending | After a no twice, two unclear answers, 20 seconds of silence, or hanging up during the read-back, the log shows `UNCONFIRMED` and the intake reads "Not confirmed by the caller" with "Follow up" as its first next step. |
| 6 | Owner screens | The list shows the intake (it opens on "Needs follow-up" when there is any); the intake page shows what the caller needs, "Requested time (not booked)", other details, an address note when an address was given, and next steps. No confidence, code, mask, step trace or booking wording. |
| 7 | Privacy | The persona's name, address and any number or e-mail spoken (including digits said one at a time) appear nowhere in the owner screens, `/api/owner`, the SQLite file or the server console. The address is not heard in the read-back. |
| 8 | Cost | Anthropic cost for the call at most $0.05 and Twilio cost at most $1.00, read from the two consoles afterwards. |
| 9 | Kill switch | With the kill file present, the next call or the next thing the caller says ends the call and saves nothing. |
| 10 | Clean up | Section 10 parts A and B completed, with routing disabled first; part C decided one item at a time. |

## What is NOT included

Processing, Quality Control and Reporting (nothing connects the phone path to Processing; `eligibleForProcessing` is the future bridge's single test); recording; outbound calls; SMS; more than one tenant live; **a callback number unless contact capture is on** (off by default; with it on the number is stored encrypted and the dashboard never shows it); **any booking or schedule** (a requested time is only what the caller asked for); any address validation (with contact capture on, the caller's own yes to an address read-back is recorded as `caller_confirmed`; the address is never checked against any address data, and an address that is not confirmed stays `unverified` for a person); login or tenant isolation on the dashboard (it is loopback-only, FND-02 / R01 not met); encryption at rest (FND-10); a retention policy (C14); a freshness check on Twilio's signature (the secret path, `max_calls`, the expiry and the kill switch bound a leak). The masker is a rule-based stand-in, not INT-07, and still cannot recognise a lower-case name or place that nothing introduces. Place names such as a city are masked as if they were names, so the owner screens do not show a city.
