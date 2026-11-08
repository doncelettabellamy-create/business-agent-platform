# Drew Product Roadmap: four stages

Written 2026-11-05. **Documentation only.** This file stages what comes next for Drew, the residential-cleaning AI phone agent. It adds no code, starts no work and approves nothing.

**Authority.** `docs/DEVELOPMENT_ROADMAP.md` section 0 (milestones CL-0 to CL-6, the status words in 0.2, the Definition of Done in 0.2, the approvals rules in 0.4 and 0.5) is the authoritative roadmap and **wins over this file wherever they differ**. This file uses its status words, its evidence rules and its one-time approval rule. Where a stage below depends on an existing milestone or requirement it says so by ID. Nothing here changes a founder decision recorded there (one residential-cleaning agent; texts OFF; Jobber writes only to the Developer Test Account; the pauses and approvals in 0.4).

**Status words** (from `DEVELOPMENT_ROADMAP.md` 0.2): PLANNED, BUILT, TESTED OFFLINE, VERIFIED LIVE, UNVERIFIED, PARTIAL / BLOCKED / PAUSED, DONE. **Only the founder, in writing, after being shown the evidence, can set DONE.** A report may say "evidence complete", never DONE.

## At a glance

| Stage | Name | Status | Starts only when |
|---|---|---|---|
| 1 | **Reliable Booking** | **IN PROGRESS** | (now) |
| 2 | Customer Management | PLANNED, not started | Stage 1 is verified complete **and** the founder approves in writing (see "The gate", below) |
| 3 | Revenue & Quality | PLANNED, not started | Stage 2 accepted and the founder approves in writing |
| 4 | Coordinated Agents: **one Drew agent** coordinating specialized workflows | PLANNED, not started; multiple independent agents are **not** part of this stage and need a separate founder approval (see Stage 4) | Stage 3 accepted and the founder approves in writing |

## The gate between stages (applies to every stage)

A stage is **complete** only when **all** of these hold, each with its evidence cited by file, commit, CI run or log (never asserted):
1. Every item in the stage has evidence at the level that item names. **Tests passing is never written as working live.**
2. Every defect found on the way has a regression test, and no protected test was changed to make a repair pass without being reported first.
3. CI is green on the pushed commit that contains the work.
4. The records (this file, `DEVELOPMENT_ROADMAP.md` 0.3, the handoff) are updated in the same change, and the status words match the evidence.
5. Protected work is unchanged, and a secret and private-data scan of what was committed is clean.
6. The stage's live acceptance has been met (for Stage 1: see the exit criteria).
7. **The founder accepts the stage in writing, after being shown the evidence.**

**No stage begins by inference.** Finishing Stage N does not approve Stage N+1: the founder's written approval names the next stage, and each task inside it still needs its own approval (an approved stage does not approve its tasks). Each approval names one action and ends when it is done.

---

## Stage 1: Reliable Booking — **IN PROGRESS**

**Goal.** A caller can book a residential cleaning by phone, and what Drew books is exactly what the caller said and confirmed, checked by Jobber's own read-back. It is the live test CL-1 ("one complete Drew test call with texts OFF: real Jobber booking, verified") made reliable. Maps to `CL-1`.

**Standing limits that stay in force through Stage 1.** Texts OFF unless `FAST_TEXTS` is exactly `on` (it is not). Jobber writes only to the Developer Test Account, pinned by name and id. Emails only to the two approved test recipients, only after a Jobber-verified booking, and only when the start script is given `-Emails`. No personal detail in any log. Every restart, call, commit and push is a separate founder approval.

### 1.1 Address validation — **PLANNED** (not built)
- **Today (BUILT, TESTED OFFLINE):** the street, city and a five-digit ZIP (not all zero) are captured, in pieces if need be; the caller's state is captured or asked once (`src/us-state.ts`, `src/call-state.ts`). **There is no check that the ZIP, city and state belong together;** the address is confirmed only by the caller's yes to the read-back (by design so far: "never a postal check").
- **Needed:** a validation that catches a ZIP that does not fit the city or state, and a house number or street that cannot exist, **without guessing** and without booking an address the caller did not confirm.
- **Decision the founder must make before any build:** the source of truth. Options to be researched, none chosen: an offline table from a published government dataset; or an external address service (which sends the caller's address to a third party: a privacy, cost and consent decision). **UNVERIFIED:** which source is accurate, licensed and affordable.
- **Evidence for done:** tests for each wrong-combination case; a live call where a wrong ZIP or city is caught and corrected before the read-back; no address in any log.

### 1.2 Six reliability capabilities (founder-approved) — statuses below
**These are the six reliability capabilities of Stage 1, named and approved by the founder on 2026-11-05.** The statuses in the table are the founder's, **checked here against the evidence.** They use the founder's words with the project's status words (`DEVELOPMENT_ROADMAP.md` 0.2): **"built / testing"** means BUILT and TESTED OFFLINE (the code exists and its automated tests pass; **not** VERIFIED LIVE); **"passing"** means the automated suite passes in CI; **"partial"** means some parts are met and a gap is named; **"not started"** means nothing is designed or built. **Approving the list is not verifying it.**

| # | Capability | Status | What it is | Evidence, and what is not yet proven |
|---|---|---|---|---|
| 1 | **Transaction Guard** | **BUILT / TESTING** | Nothing is booked, emailed or texted unless the booking request carries **exactly what the caller confirmed** in the read-back (name, date, both times, street, city, ZIP, state, price). Any difference, or no confirmation, ends the call with nothing sent to Jobber and no booking claimed. A booking also needs the caller's own yes to the name and a state that the caller gave | `f072906` (the guard), `4bce63f` (the name yes), `1ddcecd` (the state). TESTED OFFLINE; the mismatch path is tested on the comparison itself, not forced through a live call. **Not VERIFIED LIVE:** the running server predates `f072906` |
| 2 | **Confirmation Engine** | **BUILT / TESTING** | The measured spoken confirmations: the **name said and spelled letter by letter**, corrected by saying it again and then by spelling; an offer that **says plainly** when the time, part of day or day asked for is not the one offered; the callback number; the read-back. A yes before a line has finished playing confirms nothing; answers that arrive in pieces are put together; nothing is guessed | `4bce63f`, `f072906`, with the earlier confirmation units. TESTED OFFLINE. **Not VERIFIED LIVE:** the spelled name and the alternate-time wording have not been heard on a call; how the voice pronounces the spelled letters is untested |
| 3 | **Jobber Post-Write Verification** | **PARTIAL** | After the write, an independent read-back by job id checks the client's name and phone, the street, city and ZIP, the visit's start and end, the price and the job status; a result that names any differing field is not a booking (nothing emailed or texted, no booking claimed) | **VERIFIED LIVE** as `booked_verified` in Tests #6 and #7 for the fields it compares. **Gap (UNVERIFIED):** the state/province is **not** compared. Detail and the way forward are in 1.3 |
| 4 | **Decision Tracing & Error Tracking** | **BUILT / TESTING** | Privacy-safe records of what Drew decided and why it ended, as codes, flags and counts only: never a name, a letter, an address, a day, a time or a word. `ADAPTER_TRANSCRIPT`, `FAST_SIZE`, `FAST_ADDRESS` (with `state` and `zipDigits`), `FAST_STATE`, `FAST_NAME`, `FAST_WHEN`, `FAST_OFFER`, `FAST_BOOKING_GUARD`, `FAST_BOOKING`, and a fixed reason on every call outcome (`FAST_OUTCOME`) | TESTED OFFLINE (each line is checked to survive the log sink and to leak nothing). **Seen live in the Test #7 log:** `FAST_NAME`, `FAST_STATE`, `FAST_ADDRESS`, `FAST_SIZE`, `ADAPTER_TRANSCRIPT`. **Not yet seen live:** `FAST_WHEN`, `FAST_OFFER`, `FAST_BOOKING_GUARD`. **Gaps:** no single error report or store, and the log cannot hold the words by design, so a said-versus-booked comparison still needs the founder's own check (Test #8) |
| 5 | **Automated Regression Tests** | **PASSING** | Every defect found on the way gets a regression test, and the whole suite runs in CI on every push | CI #63 (run 42113630804, commit `f072906`): **success**, 1936 tests, 1933 pass, 0 fail, 1 skipped (CI only), 2 todo. **Not done:** mutation checks of the safety rules (a test that fails when the rule is broken); one known timing-sensitive test (`tests/fast-call-joined.test.ts:129`) passed on this run but failed once in CI #59 and its cause is unproven |
| 6 | **Reliability Scorecard** | **NOT STARTED** | A per-call and over-time measure of reliability, drawn from the privacy-safe records, so that "clean live completions" can be shown from evidence | Nothing designed or built. **Open:** the founder defines what counts as a clean completion and which measures count (for example whether the booking was verified, whether any name or time was corrected, how many questions were repeated, how the call ended) |

- **Running server:** it was started on the code of `4bce63f` and does **not** have the `f072906` fixes. A guided restart is needed before Test #8 (1.4).
- **What these six do not change:** the Stage 1 exit criteria (1.5) and the gate between stages stand as written; address validation (1.1) is separate and is not one of the six.

### 1.3 Jobber verification — **PARTIAL**
- **Today (BUILT, TESTED OFFLINE; VERIFIED LIVE in Tests #6 and #7 as `booked_verified`):** after the write, an independent read-back by job id compares the title and marker, the client's first and last name, phone, street, city, ZIP, the visit's start and end instants, the price and the job status. A mismatch is not a booking.
- **Known gap (UNVERIFIED):** the read-back does **not** compare the **state/province**. The query was not changed because the field name on Jobber's read type could not be confirmed without a live schema read, and a wrong field would fail every booking. Needs the founder's approval for a deliberate, read-only schema check.
- **Needed for done:** province compared in the read-back (after the schema check), with a regression test; the existing duplicate prevention and the "unassigned visit blocks its own double booking" fix stay.

### 1.4 Test #8 — **PLANNED** (not run)
- **What it is:** the next controlled live call, on a server restarted on `f072906` (guided restart; tunnel checked first; the three startup banner lines seen).
- **What it must show:** the name spelled in the confirmation and corrected by "no" if needed; the state said or asked once; a requested time either given or the substitution said plainly; a time said in a second piece kept; the diagnostics above present and privacy-safe; a Jobber booking `booked_verified`; both test emails accepted for approved recipients only; texts skipped. After the call, a read-only audit of the sanitized log, **plus the founder's own comparison of what was said against the read-back, the email and the Jobber job** (the log cannot hold the words).
- **Not a stage exit by itself:** one clean call is one data point.

### 1.5 Stage 1 exit criteria (all required)
1. **Three consecutive verified clean live completions** (the CL-1 standard; the founder may set another number in writing), each meeting 1.1 to 1.4, with the evidence for each cited. **None is recorded yet.**
2. 1.1 (address validation) and the 1.3 province comparison built, tested and live-verified.
3. The six capabilities in 1.2 confirmed by the founder as the intended list, each live-verified.
4. The gate above met, including **the founder's written acceptance**.

**Open items that can block Stage 1** (from the existing records): no verified backup of the private files (`CL-0`); the free quick tunnel has died twice (a stable hostname needs a domain on Cloudflare and the founder's one-time login); the founder's decision to lift the pause on live calls applies to each call; test jobs from earlier live tests remain in the Developer Test Account for the founder to cancel.

### 1.6 Reliability checklist of 2026-11-07, and Live Tests #9 to #12 — **documentation only; supersedes the statuses in 1.2 and the "Running server" line under it where they differ**
Written 2026-11-07. It changes no decision above. **Status words are the project's; nothing below is VERIFIED LIVE unless it says so.** Evidence is a commit, a test file or the sanitized log (`founder-voice.log`: codes, flags and counts only; it cannot hold the words, so what was said versus what was booked still needs the founder's own comparison with the Jobber job, the read-back and the emails).

**Where the code is (as written 2026-11-07; SUPERSEDED 2026-11-08: `main` is now `c12a144`, 13 commits ahead, see the update below; the text is kept as the record of that date).** `main` is at `605610b`, **8 commits ahead of `origin/main` (`59d87be`), none pushed, CI not run on any of them:** `82270c1` (docs, CL-0), `1803546` (confirm and correct street addresses), `d2874e2` (comma-formatted house numbers), `7eb8895` (block unverified service addresses before booking), `8a67671` (privacy-safe shape of a rejected address answer in `FAST_ADDRESS`), `6d99b8d` (early "no" over a confirmation line; recovery from a noise cut), `c04de00` (OpenAI turn detection switched from `server_vad` to `semantic_vad`), `605610b` (harden address capture and Jobber state verification; next paragraph). Local suite at `605610b` (run just before the commit): 1968 tests, 1966 pass, 0 fail, 0 cancelled, 2 todo (the two documented known-gap todos in `tests/openai-provider.test.ts`; the runner lists them under "failing tests", but they are not failures) (TESTED OFFLINE; not CI). **The running server is PID 47792, started 2026-11-07 14:25 Central on `c04de00`** (as last verified read-only), so it does **NOT** contain `605610b`: a restart on `605610b` (the founder's, in the keyed window) is needed before Test #13 [2026-11-08: the restart target is now `c12a144`]. It runs behind the **named Cloudflare tunnel** `voice.drewagenttest.com` (cloudflared PID 8016, run by hand in the founder's window: no Windows service, so it ends if that window closes or the machine restarts). The saved Twilio Stream URL fingerprint is `72e949e7`. **Emails:** the running server sent them in Test #12 (`FAST_EMAILS_SENT`, both accepted), so emails were ON in practice (VERIFIED from the log); the startup preflight lines (texts OFF, Jobber writes, EMAILS ON) for this start have **not been seen by Claude** (UNVERIFIED), and "accepted" means the mail server took the message, not that it reached an inbox. This replaces the free quick tunnel named in the open items above (that process is still running; see "Still open"); the stream path secret was shown once on screen and **has not been rotated** (UNRESOLVED).

**UPDATE 2026-11-08 (documentation only; verified commits through `c12a144`; it supersedes "Where the code is" above and the table rows below where they differ; the fuller record is `docs/DEVELOPMENT_ROADMAP.md` section 5a-56).** `main` is at `c12a144` (VERIFIED, `git rev-parse`), **13 commits ahead of `origin/main` (`59d87be`), none pushed, CI not run on any.** Four commits after `605610b`, plus `f9d7078` (docs): `fcf2323` (an **optional** `validateAddress` step in the fast call handler: verdicts valid, mismatch, corrected, unknown; run before the read-back with a 4000 ms timeout; a street or house-number mismatch or a correction asks for the street once and re-checks it; anything else, a throw or a timeout ends as `ADDRESS_UNVERIFIED` with nothing booked; `book()` re-checks the validated address; log row `FAST_ADDRESS_VALIDATE` holds tokens only), `aebdc26` (an isolated, founder-run 9-request Google Address Validation trial script, real public addresses only), `9945ac3` (the reliability scorecard: 12 checks, PASS/FAIL/BLOCKED, exits 0 only on a full PASS, missing evidence is BLOCKED) and `c12a144` (`SERVER_START` carries the 12-character HEAD commit; each call's step tokens are logged in order as `FAST_STEP {n, s}`; logging cannot throw into a call's end). **All four are BUILT and TESTED OFFLINE; none is VERIFIED LIVE and none has run on any call.** Last full `npm test` (after `c12a144`): 1975 tests, 1973 pass, 0 fail, 0 cancelled, 2 todo (the two known gaps in `tests/openai-provider.test.ts`; TESTED OFFLINE, not CI). The scorecard, run-evidence and Google-trial tests are **not listed in `package.json`'s `npm test`**; they were run separately and pass. **Server (VERIFIED read-only, 2026-11-08 about 09:47 Central):** PID 47792 is still running, started 2026-11-07 14:25 on the `c04de00` code (six source files changed after its start), listening on loopback 8787 and 8788; **it contains none of `605610b`, `fcf2323`, `aebdc26`, `9945ac3` or `c12a144`; no call has run since Test #12.** The working tree has no uncommitted code. **Tunnel (VERIFIED from cloudflared's own log):** the named tunnel (cloudflared PID 8016, started 2026-11-06 18:36, run by hand: no service) routes the voice hostname to `localhost:8788`, which matches `relay_port` 8788 in the call config; all four of its connections timed out and re-registered at about 09:06 Central on 2026-11-08 (no later error in the log). **UNVERIFIED:** a request reaching 8788 through the public hostname now, and the saved Twilio URL fingerprint `72e949e7`. The old quick tunnel (PID 19096) is still running. **Exact next restart gate (founder-run; each step its own approval):** (1) in a SECOND PowerShell window with the keys and live switch entered (`set-voice-keys.ps1`, `set-twilio-token.ps1`), run `fast-test-start.ps1 -Emails` with no `-Serve` (CHECK ONLY: opens no port, starts nothing, sends nothing) and require every line True, EMAILS ON and the gate passing; (2) in the window of PID 25084 press Ctrl+C to stop the server, leaving the cloudflared window open; (3) there run `fast-test-start.ps1 -Serve -Emails`, check every line, type START; (4) read-only check that `SERVER_START` in `founder-voice.log` carries `commit` `c12a144` (the first `FAST_STEP` lines appear only after a call on that server); (5) only then Test #13. **Stage 1 exit gates (1.5) are unchanged: three consecutive verified clean live completions, address validation and the province comparison live-verified, the six capabilities confirmed and live-verified, and the founder's written acceptance. None is met.**

**What `605610b` adds (BUILT, TESTED OFFLINE; NOT VERIFIED LIVE: no call has run on it).** (1) A house number said one digit at a time ("1-5-9-5-1", "1 5 9 5 1") is one number (`src/call-state.ts`). (2) A house number said as three or more digit words ("one five nine five one", "double five one two") becomes digits; "fifteen", "forty two" and fewer than three digit words are left alone and fail closed at the read-back (`ADDRESS_INVALID`, nothing booked); an early re-ask for them is not built. (3) A held street name is no longer overwritten by a city said before the house number; a new street with a road word replaces it and the reason says so. (4) A street made from a house number plus a name with no road word (it may be a city) must be confirmed spelled out before the read-back, and nothing is booked until it is; a right roadless street ("Broadway") is kept at the cost of one extra confirmation (`FAST_ADDRESS_CHECK`, reason `ROADLESS`). (5) The Jobber read-back now asks for the property's `province` (confirmed by a read-only schema introspection: `PropertyAddress.province`, a nullable String) and compares it, as a two-letter code or a full state name in any case (`stateCodeOf`, `src/us-state.ts`), with the requested state; a missing, unknown or different state makes the booking `uncertain` (`READBACK_MISMATCH`, field name only, never the value), and it is not claimed, emailed or texted. **Not proven:** the format Jobber really returns for `province` (if it is neither a code nor a full state name, correct bookings come back `uncertain` on the first live call: it fails safe, but would look like a failure); the cause of Test #12 is still unexplained, so `605610b` fixes the defects found by tracing, not a confirmed cause.

**The six reliability capabilities of 1.2, rechecked against `605610b`.**
| # | Capability | Status now | Evidence and what is not proven |
|---|---|---|---|
| 1 | Transaction Guard | **BUILT, TESTED OFFLINE** | `confirmedMismatches` and the book-time check; since `7eb8895` also `addressIssues` before the read-back and before the booking (a leading house number that is not the ZIP, a city, a two-letter state, a five-digit ZIP) and a stricter `requestProblems` in `src/jobber-booking.ts`. **Not VERIFIED LIVE for the new address guards:** the call that reached a booking after `7eb8895` (Test #12) did not exercise a refusal. |
| 2 | Confirmation Engine | **BUILT, TESTED OFFLINE** | Spelled street and digit-by-digit house number in the read-back, the field question and the street correction (`1803546`, `7eb8895`), early "no" and noise-cut recovery (`6d99b8d`). **UNVERIFIED live:** the correction flow was never reached on a call; early "no" and noise recovery never occurred on a call. |
| 3 | Jobber Post-Write Verification | **BUILT for the state, TESTED OFFLINE; PARTIAL overall (not live-proven)** | Independent read-back compares name, phone, street, city, the first five ZIP digits, the visit, price and status; `booked_verified` in Tests #6, #7, #8, #10 and #12 (Jobber's own read-back matched what Drew sent; in Test #10 what Drew sent was the wrong street, so this proves Jobber matched Drew, not that Drew matched the caller). The state/province is **now compared** (`605610b`: requested versus read-back, normalized, fail-closed; TESTED OFFLINE, mutation-checked by hand). **UNVERIFIED live:** the format Jobber returns for `province`. |
| 4 | Decision Tracing & Error Tracking | **BUILT, TESTED OFFLINE; seen live** | `FAST_ADDRESS` now also carries `shape` (a digit as 9, a letter as a, punctuation by position; never a value) for a rejected answer only; `FAST_ADDRESS_GUARD`, `CONFIRM_EARLY_NO`, `CONFIRM_FALSE_CUT` exist. `shape` **was seen live in Test #12.** Gap: no error store and no record of which turn-detection type is active. |
| 5 | Automated Regression Tests | **PARTIAL** | [2026-11-08: 1973 of 1975 pass at `c12a144`, 0 fail, 2 known todos; the scorecard, run-evidence and Google-trial tests are not in `npm test`, and CI is UNKNOWN for all 13 unpushed commits.] 1966 of 1968 tests pass locally (0 fail, 2 known todos); regression tests exist for each defect of Tests #8 to #12 found by tracing; mutation checks were run by hand on the new rules. **CI is UNKNOWN for these 7 commits (nothing pushed).** The known timing-sensitive test is unchanged. |
| 6 | Reliability Scorecard | **BUILT, TESTED OFFLINE (`9945ac3`, 2026-11-08 update above); NOT live-proven; cannot yet PASS a call from the current log** | `tools/reliability-scorecard.ts` scores the sanitized log (and a private founder attestation file) as PASS, FAIL or BLOCKED and exits 0 only on a full PASS; Test #12's shape and missing evidence are tested not to return success. **Gaps:** it does not yet read `FAST_STEP` (so caller, name and street confirmation are inferred), it needs the founder's attestation, it has no address-validation row, and it scores the 2026-11-05 call as a false FAIL (older event names). The founder has not yet approved its definition. [Was MISSING before 2026-11-08.] |

**Address pipeline, by stage (BUILT / PARTIAL / MISSING / UNVERIFIED).**
- Capture in pieces, thousands-comma numbers ("15,951"), spaced groups ("12, 345" as the whole line): **BUILT, TESTED OFFLINE** (`src/call-state.ts`, `tests/address-city-zip.test.ts`).
- A ZIP said where the house number was wanted: **BUILT, TESTED OFFLINE** (`7eb8895`): a house number equal to the ZIP is refused and the number is asked again. **A ZIP that differs from the real ZIP, said as the number, is not detected by this rule** (only the digit-by-digit read-back and the caller's yes catch it): **PARTIAL.**
- A house number said with dashes or spaces between the digits ("1-5-9-5-1"), or as three or more digit words: **BUILT, TESTED OFFLINE** (`605610b`); **UNVERIFIED live.** An ambiguous word number ("forty two") ends the call at the read-back with nothing booked; an early re-ask is **MISSING.**
- A city said before the street, a held street kept, and a roadless street name confirmed before the read-back: **BUILT, TESTED OFFLINE** (`605610b`); the known limit that a city said before the street is taken for a street name (`docs/DEVELOPMENT_ROADMAP.md`) remains partly covered by the extra confirmation only; **UNVERIFIED live.**
- Spoken confirmation of the street and the house number: **BUILT, TESTED OFFLINE**; **UNVERIFIED live.**
- Fail-closed gates before any Jobber write: **BUILT, TESTED OFFLINE**; refusal path **UNVERIFIED live.**
- Jobber read-back of the address: **BUILT, TESTED OFFLINE** including the state (`605610b`); **UNVERIFIED live** (the returned `province` format). Email address consistency: the emails carry the held address, not a value re-read from Jobber; **no separate check: PARTIAL by design.**
- **External address validation (ZIP/city/state fit, street exists): the interface is BUILT and TESTED OFFLINE (`fcf2323`, optional, fail-closed); NO source is connected, so as a working check it is still MISSING; not live.** HUD-USPS (ZIP to one city and state, no street check; storage terms UNVERIFIED, permission request drafted and not sent) and Google Address Validation (street-level; trial script built, never run) are compared in writing only; the choice is the founder's. Before 2026-11-08 this read: No geocoder, no postal table, no service anywhere in `src/` (1.1 stands: PLANNED, the source of truth is the founder's decision).

**Live tests since 1.4 (only the sanitized log and the founder's reports; no content).**
| Test | Date | What happened | Status |
|---|---|---|---|
| #8 | **Date not recorded in any record; INFERENCE only:** the last `BOOKED` outcome in the log before Test #9 is 2026-11-06 about 16:18 UTC, which is probably this call | A street name was misheard (the sanitized log cannot hold the words); a booking was made and emails were sent. | Led to `1803546` (spell the street, field question, correction). |
| #9 | evening of 2026-11-06 Central (log 2026-11-07 01:06 UTC) | A house number said as "15,951" was split on the comma and the call kept asking for the number; the caller hung up (`CALLER_HUNG_UP`, not booked). | Root cause found; fixed in `d2874e2` (TESTED OFFLINE). |
| #10 | 2026-11-07 (about 17:50 UTC) | **FAILED (founder-reported).** The call booked **Jobber job #8** (`booked_verified`, both emails accepted), but, as the founder reported, a ZIP (77346) became part of the street text and the booking went ahead without the real house number (15951). Cause (traced from the code and a synthetic probe; the log holds no words): a five-digit answer to the house-number question was joined to the held street name, and the read-back was confirmed. | Fixed offline in `7eb8895`. |
| #11 | 2026-11-07 | Not booked; the caller hung up after repeated prompts and a noise cut. Two house-number answers were rejected. | Led to `8a67671`, `6d99b8d`, `c04de00`. |
| #12 | 2026-11-07 (about 20:27 to 20:30 UTC) | **Founder reports a failure; the details are NOT recorded here until the founder states them.** The sanitized log shows a call that reached `BOOKED`: `FAST_BOOKING booked_verified`, two Jobber writes (client, job), both emails accepted, texts skipped, **no address-guard refusal**, no `ADAPTER_VOICE_ERROR_EVENT` (so no sign that `semantic_vad` was rejected; the active type is not logged). The first house-number answer was rejected with shape `9-9-9-9-9.` (digits separated by dashes), then the number was taken as a plain six-character answer. The offer substituted a different day and time (a day offset of two, 13:00 against 10:00 asked) and was accepted. **Jobber job #9 is the founder's reference for this call; its content has not been read or compared by Claude.** | **FAIL (founder-reported); cause UNVERIFIED.** |

**Ordered release gates (proposed order, derived by Claude from 1.1 to 1.5 and the open items; the founder has NOT set this order in writing).** Each gate needs the evidence named, and the stage gate and exit criteria above still apply.
1. **Explain and fix the Test #12 failure.** The founder compares what was said with Jobber job #9, the read-back and the two emails and states the defect; then a regression test, and a founder-run retest.
2. **Dashed-digit house numbers** ("1-5-9-5-1") accepted by the parser (the shape from Test #12), with regression tests: **DONE OFFLINE in `605610b`; needs the live proof of gate 3.**
3. **Live proof of the address safeguards:** a call that reaches the read-back with the street and the house number spelled, and one where a wrong street or ZIP is caught before the booking.
4. **Province/state compared in the Jobber read-back** and a regression test (1.3): **DONE OFFLINE in `605610b`** (schema checked read-only, field `PropertyAddress.province`); **the live return format is still to be seen on a call.**
5. **Address validation source decided and built** (1.1: the founder's choice of source, privacy and consent first).
6. **Push the unpushed commits (8 when written; 13 at `c12a144`) and get green CI** on the pushed commit; keep the known timing-sensitive test in view.
7. **Infrastructure and records:** the named tunnel kept up (service or alternative), stream path secret rotated, CL-0 backups complete, backup and continuity documents current.
8. **Reliability Scorecard** defined by the founder and built. [2026-11-08: built and tested offline in `9945ac3`; the founder has not yet defined or accepted it; it needs `FAST_STEP` evidence, an attestation and an address-validation row.]
9. **Three consecutive verified clean live completions** (1.5.1), then the founder's written acceptance. Only the founder can set DONE.

**Remaining release blockers (written after `605610b`; read with the 2026-11-08 update above, which makes the restart target `c12a144`, makes the push cover 13 commits, and records the validation interface and the scorecard as BUILT but not live or complete, so "MISSING" below now means "no working source" and "not accepted"; none of those is closed):** restart the server on `605610b` [2026-11-08: now `c12a144`] (founder); a founder-run Test #13 that reaches the read-back and a verified booking, with the founder's comparison against Jobber (the Test #12 failure and Jobber job #9 still unexplained); the live `province` format; push and green CI for all 8 commits [13 at `c12a144`]; external address validation (interface BUILT in `fcf2323`, no source connected: still no working check); the Reliability Scorecard (BUILT offline in `9945ac3`, not accepted, not able to PASS a call yet); the stream secret rotation, the named tunnel as a service and the old quick tunnel (PID 19096); stale backup documents; the unlogged active turn-detection type; the intermittent timing-sensitive test in `tests/founder-voice-service.test.ts` (one unreproduced failure in a full run; cause unproven); and the founder's three consecutive clean completions and written acceptance.

**Still open, carried forward:** the old test jobs #1 to #9 in the Developer Test Account (the founder cancels them); Twilio account and campaign status UNKNOWN; the old quick-tunnel process (cloudflared PID 19096, started 2026-11-06 09:22) was **found still RUNNING on 2026-11-07 (VERIFIED, process check)**; it is not the live path, and that its tunnel is dead rests on earlier evidence that was not rechecked; the street-names-with-digits spelling gap is **confirmed in the source** (`spellStreet` in `src/fast-call-handler.ts` leaves digits unspelled; tested at `tests/fast-call-handler.test.ts:885`) and unfixed. The Test #8 review also reported "the read-back is spoken twice after a correction": **UNVERIFIED, not reproduced** (in `src/fast-call-handler.ts`, `confirmStreet` leads to one read-back, and the correction test at `tests/fast-call-handler.test.ts:889` expects one); the correction flow has **never run on a live call** (the whole log holds 0 `FAST_ADDRESS_FIX` and 0 `STREET_CONFIRM` lines), so neither a live occurrence nor a live absence is shown.

**Live history that shaped Stage 1.** Test #3 booked the right date and price; Test #4 showed clipped replies and a repeated ZIP question; Test #5 failed at the size step; Test #6 booked correctly but with fragmented answers and an unread bathroom answer; Test #7 booked correctly but with the first name misrecognized ("Done" for "Don") and a requested 9 AM offered as 11 AM without saying so. The Test #7 time cause is **probable but unproven**: a busy 9 AM with a silent substitution, and possibly a time said in a second piece that was lost (now fixed and logged).

---

## Stage 2: Customer Management — **PLANNED**, not started

**Goal.** Drew recognizes a returning caller and manages their existing bookings: **recognition, retrieval, rescheduling, cancellation.**

**Does not start until** Stage 1 is verified complete and the founder approves Stage 2 in writing.

| Capability | Meaning | Depends on / open questions |
|---|---|---|
| **Recognition** | Know a returning caller (for example from the verified caller ID) and greet them correctly without asking again what is already known | Durable, protected customer records (`CL-3`, today only a log line records a booking); a consent and retention decision; never recognizing the wrong person: a wrong match must fail to "ask", not to "assume" |
| **Retrieval** | Read back the caller's own upcoming booking | Saved bookings and an identity check strong enough to avoid telling one customer another's details |
| **Rescheduling** | Move a booking to a new time Drew has checked against the calendar | **New Jobber write scope** (today only create, test account only); the same "confirmed facts equal the request" and independent read-back rules; no double booking |
| **Cancellation** | Cancel a booking the caller owns | **New Jobber write scope**; explicit confirmation; read-back that the job is cancelled; owner notified |

**Constraints that carry over:** privacy-safe logs only; Jobber changes only in the Developer Test Account until the founder approves otherwise; every new Jobber action is its own approval; texts stay OFF unless `CL-2` is separately done.

**Exit (to be confirmed at stage entry):** each capability BUILT, TESTED OFFLINE and VERIFIED LIVE on the test account with an independent read-back; the gate above met; the founder's written acceptance.

---

## Stage 3: Revenue & Quality — **PLANNED**, not started

**Goal.** Recover lost revenue and measure and improve call quality: **estimate recovery, follow-ups, conversion, call QA.**

**Does not start until** Stage 2 is accepted and the founder approves Stage 3 in writing.

| Capability | Meaning | Depends on / open questions |
|---|---|---|
| **Estimate recovery** | Reach back to a caller who got a price and did not book | `DRF-03` (recovery workflows) is **inactive** by the founder's decision and must be activated in writing; a contact channel the caller consented to |
| **Follow-ups** | Confirmations, thank-yous and reminders of what happened | Texts need `CL-2` (Twilio campaign approved, STOP/START/HELP verified, consents); emails are limited to approved test recipients today |
| **Conversion** | Measure how many calls become bookings, and why not | Privacy-safe metrics defined first; durable records (`CL-3`) |
| **Call QA** | Ongoing review of each live call against what was said and booked | `DRF-05`; call recording or transcript retention needs the legal review in `CL-5` (AI disclosure, recording, SMS) |

**Constraints:** consent before any outreach; the legal review before any recording or retention; no personal detail in logs; the owner sets the limits.

**Exit (to be confirmed at stage entry):** each capability measured with evidence, the owner's reports reconciled with the records, the gate above met, and the founder's written acceptance.

---

## Stage 4: Coordinated Agents — **PLANNED**, not started

**What "Coordinated Agents" means here (founder clarification, 2026-11-05).** Stage 4 is **ONE Drew agent coordinating specialized workflows**: inbound calls, outbound contact, reminders and other narrow, owner-approved flows, all run by the single residential-cleaning agent. This **is consistent with** the founder's decision of 2026-11-02 (ONE residential-cleaning AI agent; the four-agent direction, Intake, Processing, Quality Control and Reporting, **retired and historical**, `DEVELOPMENT_ROADMAP.md` 0.1). **This stage does not reinstate that direction.**

**Multiple independent agents are not part of Stage 4.** Any design with more than one independent agent (each with its own role, permissions or decisions) **needs a separate founder approval, in writing, naming it,** and is not scheduled or built by anything in this file.

**Goal.** One Drew agent that coordinates its workflows: **inbound, outbound, reminders, specialized workflows.**

**Does not start until** Stage 3 is accepted and the founder approves Stage 4 in writing; each workflow inside it is then its own approval.

| Workflow | Meaning | Depends on / open questions |
|---|---|---|
| **Inbound** | The current call flow, hardened by Stages 1 to 3 | Stages 1 to 3 accepted |
| **Outbound** | Calls or messages Drew starts | **Consent and telecom rules for outbound contact (a legal review);** SMS approval (`CL-2`); a per-contact opt-out that is honored everywhere |
| **Reminders** | Appointment reminders | Same consent rules; durable records; no reminder for a cancelled booking |
| **Specialized workflows** | Narrow, owner-approved flows for particular jobs | Each workflow named, scoped and approved on its own; adjacent services (carpet, window, pressure washing) stay **research candidates only** unless the founder approves them by name |

**Constraints:** every workflow has a written scope, a permission set and a kill switch; the agent can never act outside the approvals of the workflow it is running; the verified-action rule (independent read-back) applies to every external write; the production foundation (`CL-5`: tenant isolation, hosting off the founder's machine, monitoring, tested backups) comes first.

**Exit (to be confirmed at stage entry):** each workflow VERIFIED LIVE under the gate above, the coordination between workflows tested (no workflow can start another outside its approvals), and the founder's written acceptance.

---

## How this file is kept

- **Updated in the same change** as the work it describes, with the status words matching the evidence.
- **Status changes of a stage** (for example Stage 1 to "evidence complete") are reported to the founder with the evidence; **only the founder's written acceptance sets DONE.**
- **Corrections:** where this file is found to disagree with `DEVELOPMENT_ROADMAP.md` section 0, that section is right and this file is the one to fix.
