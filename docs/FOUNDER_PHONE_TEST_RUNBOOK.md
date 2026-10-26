# Founder phone test: runbook and blockers

Status 2026-10-26: **the local code is built and tested; no real call has been placed.** Nothing has been installed, purchased, exposed or called. This file lists exactly what is still needed before the first real call. The authority for status is `docs/blueprint/PLATFORM_MASTER_PLAN.md` section 11.5 item 24.

## What it is

Dial a Twilio number, talk naturally to an AI assistant, and see a validated Intake record appear on the existing dashboard prototype.

```
phone -> Twilio ConversationRelay (speech to text and back) -> wss tunnel -> src/ws-server.ts (signature check)
      -> src/relay-handler.ts: consent -> src/pii-screen.ts (mask) -> existing Intake agent (live Claude: classify, extract, ground, validate)
                                      -> src/dialogue-model.ts (live Claude speaks, masked text only)
      -> src/intake-record-store.ts (SQLite) -> src/dashboard-server.ts (127.0.0.1) -> prototype/intake-work-items
```

The Intake agent is the existing one, unchanged except for an opt-in founder tier in `src/intake-entry.ts` (one named `ws-founder-` tenant, masking source `founder-test-call`, event ids `evt-founder-`). The synthetic-only gate and the reviewed-fixture live path are untouched for everything else.

## Rules for the test call

- Speak an **invented persona** and invented details only. The masker cannot recognise an unfamiliar spoken name, and rule-based masking is not the platform masking stage (INT-07 is not started).
- The caller's number is never read, stored or sent to a model.
- Treat the secret path like a password: do not paste it into chat, tickets or screenshots. If it leaks, make a new one and approve the new config.
- One call at a time; at most the minutes, turns and Claude calls in the approved config.
- Create the file named by `kill_file` (default `founder-call.stop`) to end any call within one turn. Ctrl+C stops everything.

## Blockers before the first real call (in order)

### A. Founder decisions and approvals (nothing below can start without them)
1. The founder-test gate tier beside the synthetic-only gate (already coded; approving means using it).
2. Live Claude calls on non-fixture, masked text.
3. The invented-persona rule for the test call.
4. The consent notice wording (`CONSENT_NOTICE` in `src/founder-call-entry.ts`; it is also what the dry run prints into the TwiML).
5. Twilio's own retention of call data. Twilio logs TwiML and `<Say>` text for up to 30 days; speech text may appear in its debugger (retention decision C14).
6. A short legal check on call-consent and AI-disclosure law. Sources read so far are vendor blogs, not statutes.
7. The Anthropic API data terms for the key that will be used.
8. A spend cap (suggested $10 across Twilio and Anthropic).
9. Accepting Twilio's "Predictive and Generative AI or ML Features Addendum" in the Twilio console (a legal acceptance only the founder can make).

### B. Accounts and credentials (the founder creates them; none goes into the repository)
1. Twilio account; verify the founder's own mobile number if on a trial (trial calls only reach verified numbers, and play a trial notice).
2. A Twilio local number (about $1.15 a month). Whether ConversationRelay works on a trial account is not documented in the pages read; confirm.
3. `ANTHROPIC_API_KEY` in the environment (the official SDK reads it; this code never does), with a monthly spend limit set in the Anthropic console.
4. `TWILIO_AUTH_TOKEN` in the environment (used only to check the handshake signature; never printed).
5. A tunnel account and tool (for example ngrok or Cloudflare Tunnel): **a new install**, needed because Twilio must reach a `wss://` address. Forward the public address to `127.0.0.1:8788` only, never the dashboard port.

### C. Provider setup (exact steps)
1. Copy `examples/founder-call.config.example.json` to `founder-call.config.json` (git-ignored) and set: the real number, the tunnel's address as `wss://<tunnel host>/relay/<your own random secret of 32 to 64 letters, digits, - or _>` (the dry run prints a fresh random value you can use; the secret is a second factor, because Twilio's handshake signature is the same for every call), the invented persona names, `max_calls` (how many calls one run will accept, 1 to 10), caps, and an `expires` date no more than 30 days away. The example's placeholder number, host and secret can never be approved.
2. Run `npm run founder:check -- --config founder-call.config.json`. It prints the config digest, the cost ceiling, the gate result and the TwiML. It opens nothing.
3. In Twilio: create a **TwiML Bin** with the printed XML; set the number's "A call comes in" to that TwiML Bin. (A TwiML Bin means this machine exposes no HTTP webhook, only the WebSocket.)
4. Approve the exact config by setting `FOUNDER_CALL_APPROVED_DIGEST` to the printed digest, plus `INTAKE_ALLOW_LIVE_CALLS=yes`. Any edit to the config changes the digest and un-approves it.
5. Start the tunnel, then `node src/founder-call-entry.ts --serve --config founder-call.config.json`. Open `http://127.0.0.1:8787/`.
6. Call the number from the verified phone and follow the acceptance checks below.

### D. Things the local tests cannot prove (check on the first call; fix in code if they differ)
1. **Which URL form Twilio signs** (it includes the secret path) for the WebSocket handshake (`wss://` or `https://`). The server accepts both; if every handshake is refused (log code in the Twilio debugger, HTTP 403), this is the first suspect.
2. The Claude request shapes as the live API sees them: `output_config: { effort: "low" }` on the streaming dialogue request, and the SDK's streaming event shape (`content_block_delta` / `text_delta`). They follow the SDK and the existing structured-output request but have not been sent.
3. ConversationRelay's message fields and TwiML attributes (`welcomeGreeting`, `welcomeGreetingInterruptible="none"`) were taken from Twilio's documentation, not exercised.
4. The default text-to-speech provider (ElevenLabs) may be billed differently from basic voices; confirm in the Twilio console before the call. Whether the $0.07 per minute includes speech-to-text and text-to-speech is not stated on Twilio's pricing page.
5. Whether Twilio ends the call before the last words finish: `after_speech_ms` (default 4000) delays the hang-up; tune it.
6. Real latency and whether Haiku 5.5's replies feel natural. Not measured.

## Acceptance checks for the first call

| # | Check | Pass |
|---|---|---|
| 1 | Consent | Saying anything but a plain yes ends the call; no Claude call is made (see the Anthropic usage page) and no record appears. |
| 2 | Conversation | The assistant asks one short question at a time and the call ends by itself once the request is recorded. |
| 3 | Record | The dashboard shows one item for the call within 5 seconds of hang-up: category, status Ready (or Needs review with a reason), masked fields, personal-data counts. |
| 4 | Privacy | The persona's name, address and any number spoken appear nowhere in the dashboard, the SQLite file or the server console. Only placeholders such as `[ADDRESS_1]`. |
| 5 | Cost | Anthropic cost for the call is at most $0.05; Twilio cost at most $1.00. |
| 6 | Kill switch | Creating the kill file mid-call ends the call at the next turn and saves nothing. |
| 7 | Clean up | `store.purge` (or deleting the SQLite file) removes the test record. |

## What is NOT included

Processing, Quality Control and Reporting; recording; outbound calls; SMS; more than one tenant live; login or tenant isolation on the dashboard (it is loopback-only, FND-02 / R01 not met); encryption at rest (FND-10); a retention policy (C14). The masker is a stand-in, not INT-07.
