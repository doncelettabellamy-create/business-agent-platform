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
