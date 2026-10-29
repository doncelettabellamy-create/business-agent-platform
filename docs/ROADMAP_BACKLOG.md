# Approved requirements backlog (the founder's "Drift" requirements)

**Status: RECORDED, NOT AUTHORIZED.** These five requirements were approved by the founder as requirements on 2026-10-28. **Recording them here does not authorize implementing, testing against a live service, or activating any of them.** Each one still needs its own explicit founder approval before work begins (`docs/DEVELOPMENT_ROADMAP.md` section 1b: one task at a time; finishing a task never authorises the next), and researching or planning a requirement is not approval to build it (roadmap section 7). **The active milestone stays "Reliable Intake" (section 2).**

*On the name.* The founder calls these the "Drift requirements". Elsewhere in the project's records the word "drift" appears only in a technical sense (model or recall drift checks in `BUSINESS_BLUEPRINT.md`, `DEPLOYMENT_TESTING.md`, `OBSERVABILITY.md` and `ANALYTICS.md`) and means something else; those records are not part of this backlog. The stable IDs below are `DRF-01` to `DRF-05`. **IDs are never reused or renumbered**; a retired item is marked retired, not deleted.

## 1. How this file fits (no second plan)

- This file is the **single place** that lists these five requirements. It does not replace or reorder anything else: the cleaning-first dependency order (roadmap section 3), the SIMULATION-versus-LIVE rules (section 3a), the parallel tracks (section 4), the open decisions (section 6) and the register rows (`docs/MASTER_BUILD_REGISTER.md`) stay as they are. Where a requirement overlaps an existing row, this file **points to it instead of copying it**; where the two could disagree, the existing record wins and this file is corrected.
- Existing records checked on 2026-10-28 for overlap (none was a duplicate; each is cross-referenced below): roadmap sections 2, 3, 3a, 4, 6 and 7; `BUSINESS_BLUEPRINT.md` (customer onboarding flow 5.2, "to be decided" list); `MASTER_BUILD_REGISTER.md` (`PRC-04` tool adapters including calendar and payments, `FND-11` API keys for customer integrations, `FND-27`/`FND-28` authentication and tenant roles, `FND-29` conversation memory, `QC-01`/`QC-02`, `RPT-01` to `RPT-04`); `blueprint/ANALYTICS.md` (draft, every target TBD); `PRODUCT_CONTINUITY.md` (the four-agent vision and the production path); `DREW_CALL_TO_BOOKING_SPEC.html` (sections 7 to 9, 11 and 16).
- **Conflicts found and how they are handled:** (1) the pilot contact vault keeps contacts for at most 30 days and the roadmap says nothing should be built on it for memory (section 4): `DRF-03` therefore **cannot** start until a retention, consent and deletion decision exists. (2) The privacy contract keeps no transcripts and logs only fixed codes and counts: `DRF-05` is defined to work within that, and what content may ever be reviewed is a founder decision. (3) `DRF-02` extends roadmap steps 5 and 6 (availability, booking, first against a mock calendar); it is the **adapter to a customer's own software after** that mock path is verified, not a competing booking design. (4) `DRF-04` extends the Reporting agent and the owner dashboard, whose founder-locked rule (roadmap section 1a: never replace, rebuild or delete the dashboard) applies unchanged.

## 2. The current milestone: M1 "Reliable Intake" (ACTIVE)

**What it is.** The residential cleaning receptionist (Drew Cleaning test, the OpenAI voice route, scripted mode, invented details) completes a straightforward call every time: greeting and consent, the cleaning questions with no repeated or skipped question, name, callback number and address captured from the caller's own words, a read-back the caller can hear to the end and confirm, the address confirmed, and a saved record that is confirmed and equals what was read back, visible on the preserved dashboard.

**Status, with evidence (2026-10-28): NOT MET.** Offline: the behaviours that the live calls showed to be missing are fixed and covered by regression tests (roadmap sections 5a-7 to 5a-12; the suite also runs on GitHub on every push). Live: the 7:57 PM call (2026-10-28) completed a read-back, an address confirmation and a confirmed record **with friction** (roadmap 5a-14); the Oct 29, 10:28 AM call (`6250a1b`) is the **first verified clean pass** (roadmap 5a-16), so one of the three consecutive clean completions M1 needs (founder, 2026-10-29); two remain (an early-yes script and a correction script, defined in 5a-16). The early-yes hold has not been seen live (roadmap section 5c has the table).

**Exit criteria (plain English).** (a) A straightforward invented-details call completes the whole path above on the live route, and the record, the read-back and the dashboard agree. (b) That repeats for **three consecutive verified clean completions** (founder, 2026-10-29), the Oct 29, 10:28 AM call being the first; "verified clean", the two remaining scripts and the difference between expected safe clarification and unintended repetition are defined in roadmap 5a-16. (c) Each defect any call found has a regression test. (c2) **Name-collection robustness (roadmap 5a-17) is an open acceptance item:** it must be resolved by a bounded offline review of natural name replies and corrections and any change the founder approves, or explicitly waived by the founder in writing; it is not a closed defect and the review has not started. (d) The roadmap's status board records the live results separately from the offline ones. M1 exits only when the founder accepts it.

**While M1 is active:** no backlog item below is started or activated. The only backlog work that may be *proposed* during M1 is the first slice of `DRF-05`, because it is itself how Intake's reliability is reviewed. Nothing is authorized until the founder says so.

## 3. The backlog

Status words, always tied to evidence: **NOT STARTED** (nothing exists beyond written rules), **FOUNDATION ONLY** (parts that this requirement would build on exist, but the requirement itself does not), **IN PROGRESS**, **DONE (verified)**. None is IN PROGRESS or DONE today.

### DRF-01: Company-specific profiles

**Requirement.** Each company that uses the receptionist has its own profile, so the same product speaks and behaves as that company: its name and voice words, greeting and disclosure, services and the questions each needs, areas it serves or refuses, hours, approval rules and which booking software it uses.

**Status: FOUNDATION ONLY.** *Evidence:* one company (Drew Cleaning) is configured by hand-edited private JSON files (the approved call configuration, the voice settings and the skill file with its categories, required fields and routing); the tenant registry keeps one tenant's skill apart from another's (`tenant-boundary.ts`, tests); the opening, persona and residential-only routing are read from configuration, not code; roadmap section 3a already requires "per-business configurable services". *Missing:* any profile store, validation, versioning or approval step beyond the existing digest; a way to set up a second company; hours, service area and software choice as profile data; the onboarding flow (`BUSINESS_BLUEPRINT.md` 5.2 is "Later, content TBD").

**Depends on:** M1 exit; roadmap 3a (per-business services) and step 2 (categories); `FND-27`/`FND-28` (who may change a profile, for production); the founder's decision on what a profile contains.

**Done means (plain English).** A new company can be set up from one reviewed profile without changing code; the profile is checked for completeness and mistakes before use; any change is versioned and must be approved before calls use it; one company's profile can never affect another's (tested); and the receptionist runs a straightforward call for a **second, invented company** as reliably as for the first.

### DRF-02: Booking into customers' existing software

**Requirement.** When a caller agrees to a time, the booking is made in the software the company already uses (its own calendar or booking system), not in a separate system the company has to copy from.

**Status: NOT STARTED (rules written only).** *Evidence:* roadmap step 5 and 6 say no calendar tool and no booking tool exist; the written rules (calendar rules, customer approval, verified booking: read the slot, write once, read it back by something other than the writer) are in roadmap 3a and the spec (sections 8 and 9); the Processing and QC agents run against mock tools only; the hand-off from Intake to Processing is not wired in the voice service; `PRC-04` (tool adapters) is not built.

**Depends on:** M1 exit; DRF-01 (the profile says which software); roadmap steps 3 to 6 working first in SIMULATION against a mock calendar (pricing, approval, availability, booking, verified read-back); `PRC-04`, `FND-11` (credentials for customer integrations, never held by an agent), `FND-27`/`FND-28`; the founder's choice of the first supported software and the decision that moves any business from SIMULATION to LIVE (section 3a).

**Done means.** For one named software the founder approves, a booking agreed on a call appears in the company's own system exactly once; the slot was read from that system, written once and read back to confirm it matches; double booking is impossible by construction; the customer hears the confirmation; if the software cannot be reached or the read-back does not match, nothing is reported as booked and a person is told; it is proven first against a mock, then in a founder-approved trial with invented customers; no credential is ever seen by an agent or written in a log.

### DRF-03: Recovery workflows for unbooked quotes and eligible past customers

**Requirement.** The business can win back revenue it would otherwise lose: customers who were quoted but did not book, and past customers who are eligible to be contacted again, with steps each company approves.

**Status: NOT STARTED.** *Evidence:* nothing exists. Quotes exist only in the simulation fixture; there is no record of "quoted but not booked"; the contact vault holds a caller's details for at most 30 days and must not be used for memory (roadmap section 4); remembering customers across calls is an undecided track (`FND-29` pending); there is no outbound channel and no consent, opt-out or quiet-hours rule.

**Depends on:** M1 exit; DRF-01 (each company's rules and templates); DRF-02 (to know what was and was not booked) and roadmap step 3 (quotes) and 4 (approval); the founder's **retention, consent and deletion policy** (roadmap section 6 item 3 and section 4, Memory); legal review of contacting people (consent, opt-out, time-of-day, sender identity); a decision on the channel; DRF-04 (to measure it).

**Done means.** For a company, "unbooked quote" and "eligible past customer" are defined in its profile; only people who meet the definition and the consent rule are ever selected; each follow-up is worded from a template the company approved, respects opt-outs and stop rules, and is logged without personal data in the log; a human approves what goes out until the founder says otherwise; nothing is sent in SIMULATION; results (who rebooked) are recorded for DRF-04; and no real outreach happens until the founder separately activates it.

### DRF-04: Verified booking and paid-recovery reporting

**Requirement.** The owner can see, in plain numbers, what the receptionist actually delivered: bookings that were verified in the booking software, and revenue recovered from the recovery workflows only when it was actually paid.

**Status: FOUNDATION ONLY.** *Evidence:* the Reporting agent and its ledger exist offline against mock data (tests such as `reporting-entry`, `reporting-history`, `reporting-ledger-sqlite`, `pipeline-ledger`); the owner dashboard shows Intake requests only, with the strict owner view; "verified booking" is defined (roadmap 3a); `blueprint/ANALYTICS.md` is a draft with every target TBD; `RPT-01` to `RPT-04` are pending. *Missing:* a verified-booking source (DRF-02), recovery events (DRF-03), any payment source, and a definition of "paid recovery".

**Depends on:** DRF-02 and DRF-03; the Reporting agent and `RPT-01` to `RPT-03`; the owner dashboard's founder-locked rule (extend it in small steps; never replace it); the founder's definition of "paid recovery" (what counts, the attribution window, whose payment record is the source).

**Done means.** For any period the owner sees (a) bookings that were verified by read-back, (b) bookings that came from a recovery workflow, and (c) recovered revenue **only once payment was received and matched to that booking**; unverified or unpaid items are listed separately and never counted as results; every number can be traced to its source records and reconciles; the reports hold no personal data; and the definitions are the ones the founder approved.

### DRF-05: Ongoing call-quality review

**Requirement.** Call quality is reviewed continuously, so problems are found by a routine, not by chance, and every problem found becomes a test.

**Status: FOUNDATION ONLY (an informal process).** *Evidence:* every live call writes fixed-code diagnostics (what was asked, how each answer was judged, how the call ended) and a saved record; the founder reviews each test call, and the findings, fixes and live-versus-offline results are recorded in roadmap sections 5a-7 to 5c; each defect found so far got a regression test and the suite runs on GitHub on every push. *Missing:* a written checklist, a per-call review record, a defined sample for production, thresholds, trend reporting, and a decision on what call content (if any) may ever be reviewed; the QC agent judges bookings, not calls.

**Depends on:** the diagnostics and privacy contract (no transcripts kept; only fixed codes and counts); the founder's decision on reviewable content; for production, DRF-01 (per company) and DRF-04 (to show trends).

**Done means.** Slice A (can be proposed during M1): every live call gets a short review record (passed or needs a fix, with the diagnostic reason codes), kept without personal data, against a written checklist, with each defect linked to its regression test. Full: a defined production sample reviewed on a schedule; thresholds that trigger a fix or pause; a monthly summary of defect trends; and the founder's rule on what content may be reviewed written down and followed.

## 4. Eligibility and order

An item is **eligible to be proposed** only when all its dependencies are met **and** the active milestone allows it. Order of consideration (each still needs the founder's approval): `DRF-05` slice A (supports M1) → *after M1 exits* → `DRF-01` → `DRF-02` → `DRF-03` → `DRF-04` → `DRF-05` full. **Today the next eligible item is `DRF-05` slice A; every other item is blocked by M1.** Eligible does not mean approved: the founder approves one task at a time.

## 5. The handoff rule (required in every task handoff)

**Every task handoff (the report at the end of a task and any continuity note a session leaves) must state, before anything else:** (1) the **current milestone** and its status with evidence (today: `M1 Reliable Intake, active, not met`); (2) the **next eligible backlog item**, by ID, with what blocks the others (today: `DRF-05 slice A; DRF-01 to DRF-04 blocked by M1`); and (3) that recording an item is not authorization. If the milestone or the eligible item changes, the handoff says why. A handoff that omits these is incomplete.

## 6. How future sessions find this

Linked from: `docs/PROJECT_CONTINUITY_HANDOFF.md` (standing rules and section 13), `docs/DEVELOPMENT_ROADMAP.md` (section 5d and the rules in section 7) and `docs/PRODUCT_CONTINUITY.md` (rule 9). The file name `docs/ROADMAP_BACKLOG.md` and the IDs are stable.

## 7. Change log

| Date | Change |
|---|---|
| 2026-10-28 | Created: `DRF-01` to `DRF-05`, milestone M1, the eligibility order and the handoff rule. Documentation only; nothing implemented, activated or authorized. |
