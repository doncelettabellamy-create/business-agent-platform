# Development roadmap: the four-agent B2B platform, cleaning first

Written 2026-10-26. Documentation only. This file orders the work and records what is verified; it decides nothing. The authority for platform rules stays with `docs/PRODUCT_CONTINUITY.md` (including the permanent dashboard decision), `docs/MASTER_BUILD_REGISTER.md` and `docs/FOUNDER_PHONE_TEST_RUNBOOK.md`. Where this file and those disagree, those win and this file is the one to fix.

## 1. The product in one paragraph

A B2B platform for service businesses, built from four cooperating agents, each judged by evidence the previous one did not write: **1 Intake** (take the customer's request, today by phone; mask personal data; classify and extract; confirm by read-back; produce a validated work item), **2 Processing** (run a fixed plan of allow-listed tools; human-approved tools pause for a named approver), **3 Quality Control** (judge the result from evidence Processing did not write: pass, rework or escalate), **4 Reporting** (verify the chain, keep an append-only history, produce per-tenant reports). The owner's window onto all four is the dashboard. Standing rules for every step below: synthetic or invented data in tests, no live or paid calls and no public endpoints without the founder's say-so, no commits or pushes without being asked, secrets never displayed, safety limits and gates preserved.

## 1a. Founder-locked constraint: the owner dashboard is preserved and evolved

**Status: LOCKED by the founder. It outranks every step, track and estimate in this file.** It restates the permanent decision in `docs/PRODUCT_CONTINUITY.md` section 1; if the wording differs, that file governs.

- **Preserve** the existing prototype owner dashboard: its layout, its components, its records and everything it does today (the files under `prototype/intake-work-items` and the strict owner view that feeds it).
- **Enhance incrementally.** Add to it as customer intake, pricing, booking, QC and reporting become functional, one small, reviewable addition at a time, each keeping what was there working.
- **Never** replace it, rebuild it, redesign it from scratch, or delete existing dashboard functionality. This includes "temporary" replacements, a parallel new dashboard that is meant to take over, and removing a screen or record type because a newer one exists.
- **Only the founder can lift it, in writing, explicitly.** An instruction to "improve", "clean up", "modernise" or "build the dashboard for step N" is not that authorisation. If a step seems to need a replacement, stop and ask; do not decide.

What this means in practice for the order in section 3:

- Each of steps 2-7 ends with **a small addition to the existing dashboard** (a new detail on a call, a new status, a new section), not a new application. Step 8 is the sum of those additions plus whatever the founder separately approves; it is not a rewrite step.
- Every addition keeps the existing allow-list discipline: the dashboard shows only what the strict owner view lets through, has no login yet, and must never show personal contact data (the vault is reached only through the restricted lookup unless the founder decides otherwise).
- Existing records stay readable and shown, including the earlier plumbing-era test records; a new field must not make an old record fail to display.
- A pull request or session that touches the dashboard should say in its first line which existing behaviour it leaves unchanged.

## 1b. Working rule: one task at a time, each approved by the founder before it begins

**Status: required.** It applies to every step in section 3, every track in section 4, every mode switch in section 3a, and every small piece of work inside them. It adds to, and does not weaken, section 1a (the dashboard) and the standing rules in section 1.

1. **Approval first.** No development task begins until the founder has explicitly approved *that task*. The approval names the task (what it will change and what it will not). An earlier approval, a roadmap entry, a dependency order, or "the next step" is not approval.
2. **The cycle for each task, in this order, never skipped or reordered:**
   1. **Implementation**: the smallest change that does the approved task, in the files the task names.
   2. **Automated tests**: focused tests for the new behaviour, then the full suite. Failures are reported, not hidden; the task does not advance on a red or unrun suite.
   3. **Live validation, when applicable**: only for a task that has a live aspect (a real call, a real service, a real calendar), only with the founder's separate go-ahead for that live step, and only within the standing limits (no live or paid calls, public endpoints or restarts unless asked). Tasks with no live aspect state "not applicable" rather than skipping silently.
   4. **Founder review**: the founder is given what changed, the test results, the live-validation result if any, and the known limits, and decides whether the task is accepted.
3. **Completing one task never authorises the next.** After founder review the work stops. The next task, including the one that "obviously" follows, starts only after its own explicit approval under rule 1. A finished step in section 3 does not unlock the following row; it only makes that row eligible to be proposed.
4. **Rejection or rework** returns the task to implementation. It does not become a new task and does not start another.
5. **Commits, pushes, restarts, deployments, configuration or digest changes, and anything that touches live services** are each their own explicit request, never a side effect of finishing a task.
6. **Scope stays small.** If a task turns out to need more than was approved (another file area, another agent, a dashboard change), stop and ask; do not widen it.
7. **The dashboard constraint is part of every review.** A task that touches the dashboard states what existing behaviour it leaves unchanged (section 1a); the founder's review confirms it.

## 2. Delivery strategy

- **Cleaning first.** The first business type taken end to end is a cleaning service. It was chosen because a request is simple (rooms, date, time window), the harm of a mistake is low, and it exercises every stage (price, approval, availability, booking) without an emergency dimension.
- **Industry order is fixed by the founder: Cleaning → Towing → Plumbing → HVAC, one at a time.** Each later business is a new skill configuration plus whatever its own policy needs. None is started while the one before it is unfinished, and none is built in parallel with cleaning: the shared stages (contact, pricing, approval, availability, booking, QC) must be proven on one business type first. Starting each one is its own founder-approved task (section 1b); finishing one does not authorise the next.
  - **Towing** (second) is the hardest of the three: the caller is often roadside and stressed, location is the key field (and the most sensitive), time to arrival matters more than a date, and a wrong promise has an immediate cost. Its location and time-to-arrival handling must be designed and approved before its task begins; it stays in SIMULATION until then.
  - **Plumbing** (third) has an existing sample skill and the earlier live test used it. It adds emergency triage (a burst pipe is not a quote request) and a safety line the assistant must not cross.
  - **HVAC** (fourth) adds seasonal peaks, equipment and model details, and diagnosis the assistant must not give.
- A business type is "done" only when the same eight stages in section 3 are working for it, not when its intake works.
- **Cleaning is complete when, and only when, this whole chain works end to end in the order shown, each link verified before the next is relied on:**
  **verified contact → service → simulated quote → approval → availability → booking → QC → the existing dashboard.**
  - *Verified contact*: name, confirmed callback number and service address captured and held as in step 1.
  - *Service*: the caller's request is resolved to one of the business's configured services (step 2), or clarified, never guessed.
  - *Simulated quote*: a price or range from the mock approved-rate fixtures, using the quote-versus-estimate policy (section 3a). "Simulated" is deliberate: cleaning is not complete in LIVE terms until the business approves its real rules.
  - *Approval*: the customer's explicit yes, and the named human approver where the business requires one (step 4).
  - *Availability*: a slot read from the mock calendar (step 5).
  - *Booking*: written once and verified by reading it back (step 6).
  - *QC*: judged from evidence the booking agent did not write (step 7).
  - *The existing dashboard*: the result is visible to the owner as additions to the preserved prototype dashboard (section 1a), not a new one.
  Each link is its own approved task with its own implementation, automated tests, live validation where applicable, and founder review (section 1b). Cleaning moving to LIVE is a separate founder decision (section 3a).

## 2a. Founder requirement: how every call opens (implemented in code and tests; NOT live)

**Founder requirement (stated 2026-10-26; implemented in code and tests the same day; NOT live).** Every call opens by (1) introducing the **configured business** and the **agent** by name, (2) giving the **disclosure** (that the caller is speaking with an AI assistant, and the recording notice the business needs), and (3) mentioning a **special or promotion only if that business has approved one**, as exact approved text. The business name, agent name, disclosure wording and any special are per-business configuration, never invented or reworded by the model, and a special never carries a price or a commitment. In code all three are now configurable through an optional `opening` block (`src/opening.ts`); the live config has no such block, so live calls still use the original notice (`docs/PRODUCT_CONTINUITY.md` section 4, stage 2).

**What exists (uncommitted, tested locally, not live):** the optional `opening` block (business name, agent name, optional disclosure wording, optional special) is validated by the config gate and is part of the approval digest; the opening is fixed text built by code and spoken from the Twilio TwiML before the consent question, never generated by the model; a special is spoken only if the config carries one, exactly as written, and the code never adds one; the existing consent step is unchanged. **Still open (not approved):** applying it to the live config needs a new digest, new TwiML in the Twilio bin and a restart (each its own request, section 1b); the disclosure wording needs the business's legal check; no live call has heard it.

This is recorded as a requirement, not a built feature. It applies to every business in the order of section 2, cleaning first, and it does not change the preserved dashboard (section 1a).

## 3. Dependency order (cleaning-first critical path)

Each step needs the one before it. Do not start a step on the assumption that an earlier one will "probably" work. Being next in this table does not authorise a step: each task still needs the founder's explicit approval first (section 1b).

| # | Step | Depends on | What "done" means |
|---|---|---|---|
| 1 | **Secure contact** | Intake, masker | A confirmed caller's name, callback number and service address are held encrypted, by tenant and call, for at most 30 days; never in a prompt, log or unauthenticated view; the owner can retrieve one contact through a restricted path. Contact is required before a request is actionable. |
| 2 | **Cleaning categories** | 1 | The cleaning skill is live with the categories the business actually sells (for example standard, deep, move-out), each with its own required fields. Unknown requests are clarified, not guessed. Needs the founder's category list; the sample has one category. |
| 3 | **Pricing** | 2 | A deterministic price or range from the category and the rooms/size, from a rule table the owner approves. The assistant never invents or quotes a price the table does not give. Built first in SIMULATION against mock approved-rate fixtures (section 3a); LIVE needs the business's approved rules (none exist). |
| 4 | **Approval** | 3 | Anything with money or a commitment pauses for a named human approver (the Processing agent already has the pause mechanism, with mock tools). |
| 5 | **Availability** | 4 | A calendar the owner controls (slots, crews, travel). Offering a slot reads from it. Built first against a mock calendar (section 3a); LIVE needs real availability. No calendar tool exists yet. |
| 6 | **Booking** | 5 | A confirmed slot is written once, with a confirmation the customer receives. Double booking is impossible by construction, and the booking is verified by reading it back (section 3a). No booking tool exists yet. |
| 7 | **QC** | 6 | The QC agent judges the booking from evidence Processing did not write (the calendar entry, the quote, the contact on file). Today it runs against a mock evidence reader only. |
| 8 | **Owner dashboard** | 1-7 | The owner sees, per call, what was asked, what was decided, what needs a human, and what was booked (the founder's two-minute requirement is in section 3b, proposed and not yet implemented). **Founder-locked (section 1a):** the existing dashboard is preserved and enhanced incrementally by the additions made in steps 2-7; it is never replaced, rebuilt, redesigned from scratch or reduced. |

The bridge between Intake and Processing is a prerequisite of steps 3-7: the phone path now keeps the sealed hand-off in memory and offers it to an optional seam that the server does not pass, so nothing passes it onward and nothing consumes it. `eligibleForProcessing` (confirmed, ready, handed off, no unverified address) is the single test the bridge must use.

## 3a. Simulation and live business modes (pricing and booking)

Pricing (step 3) and booking (steps 5-6) have two explicit modes. A business is in exactly one at a time, the mode is a named setting in that business's configuration (never inferred), and the mode is visible to the owner on the dashboard as an addition to the existing one (section 1a). Nothing is promoted from one to the other by default.

| | **SIMULATION** | **LIVE** |
|---|---|---|
| Purpose | Build and test the whole chain safely. This is the only mode used for cleaning development. | Serve real customers of a real business. |
| Rates | **Mock approved-rate fixtures**: invented rate tables, clearly labelled as fixtures, checked in as test data. | **Business-approved rules only**: a rate table the business owner has approved, recorded with who approved it and when. |
| Calendar | **Mock calendar**: an in-memory or fixture calendar with invented slots and crews. | **Real availability** read from the business's actual calendar; no slot is offered that the calendar does not show as free. |
| Customer-facing words | Every price, slot and confirmation is marked as a simulation in the owner's view, and the assistant says it plainly if a simulated call is ever spoken to a real person. No real customer is committed to anything. | Prices, slots and confirmations are real commitments, so every one passes the approval and verification rules below. |
| Data | Synthetic or invented personas only (standing rule). | Real customer data under the contact rules in step 1. |
| Switching | Cannot be turned into LIVE by editing the fixtures. | LIVE requires the founder's explicit written approval **and** the business's approved rules **and** real availability connected, checked before the first call. If any is missing the business stays in SIMULATION. |

Rules that apply to both modes (they are tested in simulation so they are known to work before live):

- **Per-business configurable services.** Each business defines its own services, the fields each needs, and its own rates. Cleaning's categories are one configuration, not code. No service, price or policy is hard-wired for one business.
- **Quote versus estimate policy, per business.** The business chooses, per service, whether the assistant may give a **quote** (a firm price the business will honour) or only an **estimate** (a range that a person confirms), or neither (a person always prices it). The assistant uses the exact word the policy allows and never upgrades an estimate into a quote. If no policy is set, the answer is "a person will price this", with no figure.
- **Customer approval.** A price or a booking is not final until the customer has heard it in fixed words and said an explicit yes. The business's own approval step (step 4) is separate and comes first for anything the business wants a human to see.
- **Verified booking.** A booking is complete only when the slot was read from the calendar, written once, and then read back from the calendar by something other than the writer (the QC agent's evidence rule) and found to match. A booking that cannot be verified is not reported as booked.
- **Safe human fallback.** At any point (no rule matches, availability unreadable, a tool fails, the customer is unsure or upset, a price is outside the approved table, the call hits a limit), the assistant stops quoting and booking, says nothing it cannot back, and hands the request to a person as an unconfirmed item with the reason recorded. The customer is never told a person will call back unless the business has a callback process and a stored callback number (this is why contact capture comes first).

Cleaning development in SIMULATION proves these rules; towing, plumbing and HVAC (in that order, section 2) each repeat the same switch to LIVE only after their own rates and availability exist. Towing in particular should not leave SIMULATION until its location and time-to-arrival handling are designed.

## 3b. Founder requirement: the two-minute owner dashboard (PROPOSED; not yet implemented or validated)

**Status: a requirement recorded from the founder, not a design, not built, and not tested with an owner.** It is delivered only as incremental additions to the existing dashboard under section 1a (preserve it, evolve it, never replace or redesign it from scratch); it restates no part of that decision and weakens none of it. It is built only after the dependencies below, one separately approved task at a time (section 1b), and it follows `docs/PRODUCT_CONTINUITY.md` (which governs the dashboard) on the owner view's strict allow-list.

**The requirement.** A business owner, with no training, can open the existing dashboard and within **two minutes**, for any call, answer these five questions:

1. **Who called, and how do I securely get their contact details?** The open page identifies a call in a privacy-safe way (time, kind, and whether a contact is on file). Name, callback number and service address are **never** on the open page. They are retrieved through a separate, authenticated and audited reveal action. Until real owner authentication exists, retrieval stays the restricted command-line lookup.
2. **What service did they ask for?** The service type and its key details (for cleaning: standard, deep, or move-in/move-out, and the answers collected, such as rooms, date and time window).
3. **What was quoted, and did the customer approve it?** The quote or estimate (or "a person will price this"), and whether the customer gave an explicit yes.
4. **Is there a verified appointment?** Booked and verified, pending, failed, or not booked. "Verified" means the booking was read back from the calendar by something other than the writer (section 3a).
5. **What should I do next?** One clear next action for the owner, extending the existing next-steps list.

**Simulated outcomes are clearly labelled.** Any quote, slot, approval or booking produced in SIMULATION (section 3a) is marked as a simulation wherever it appears, is never styled or counted like a real outcome, and never implies a real customer was committed to anything.

**Acceptance (proposed, not yet run):** the founder, looking at the existing dashboard in a real browser (never yet done), can answer the five questions for a sample call in two minutes, in light and dark themes and at phone width.

**Placement: each increment comes after the step it depends on, and nothing is shown before the thing it shows exists.**

| Dashboard increment (an addition to the existing dashboard) | Needs first |
|---|---|
| "Contact on file" marker and the service requested with its answers | Steps 1 and 2 (secure contact, cleaning categories) |
| Authenticated contact reveal (replacing the command-line lookup) | Step 1, plus real owner authentication (FND-02 / R01, continuity §4 stage 5) and the founder's decision on audit and retention |
| Simulated quote label and the customer's approval status | Steps 3 and 4 (pricing, approval) |
| Appointment status, verified or not, labelled simulated or real | Steps 5 and 6 (availability, booking) and the section 3a verified-booking rule |
| QC result in plain words | Step 7 (QC) |
| Owner summary and history from Reporting | The Reporting entry shown on the dashboard (continuity §3: not yet) |
| The single next action covering all of the above | All of the above |

**Constraints that stay in force.** Every addition keeps the strict owner-view allow-list, its tests, the routes `/`, `/data.js` and `/api/owner`, and old records displaying. Adding a field to the allow-list is a contract change that needs its tests and the founder's say-so. The current rule that nothing on the dashboard says or implies a booking stays until a verified booking exists; relaxing it is its own approved contract change, and simulated bookings stay labelled. The dashboard has no login today, so nothing personal may be added before authentication exists.

## 4. Tracks that run beside the critical path

These are real work, but they do not block (and must not be allowed to quietly change) the order above. Each needs its own decision before it starts.

- **Speech-to-speech.** Replacing the current speech-to-text, text model, text-to-speech path with a voice-native model. Potential gains: latency and naturalness. Costs and risks: the masker works on text, so personal data must be handled before it can reach a voice model, which is a different design problem; the read-back is built from text; cost and logging differ. Evaluate on synthetic calls only; do not adopt until masking can be proven equivalent.
- **Memory.** Remembering a returning customer across calls. This is personal data kept beyond one call and beyond the 30-day pilot window, so it needs the founder's retention, consent and deletion policy first. Nothing here should be built on the pilot vault.
- **UI work.** Dashboard evolution, owner screens, contact lookup beyond the command line, report pages. Governed by the founder-locked constraint in section 1a: preserve the existing dashboard, enhance it incrementally, never replace, rebuild, redesign from scratch or delete functionality without the founder's explicit written authorization. The read-back, hang-up and owner screens have been tested locally only.

## 5. Verified status (2026-10-26)

Verified by running, not assumed:

- **1130 tests pass, 0 fail** (full suite, `poc/intake-runner`). Snapshot 2026-10-26 (a dated figure, not maintained): the last full run of `npm test` in `poc/intake-runner` was **1130 passing, 0 failing**, taken after the last code change. Mock and stand-in tests only: it says nothing about live behaviour. Re-run the suite for the current figure.
- **Git state, 2026-10-26.** Commit `62da32c` (Option A, contact vault, opening, services skill, handoff preservation, diagnostics) is on `main` and on GitHub. A further set of changes is **local and uncommitted** (24 modified and 5 new files, all under `poc/intake-runner/`): skill choices, the commercial human-review route, first-cleaning capture and attribution, the SIMULATION pricing fixture, address read-back and confirmation, and the durable `caller_confirmed` status. Read `git status --short` for the current list.
- **Option A is implemented**: one fresh validated Intake run per caller turn, the next field chosen by code (`src/next-field.ts`), the dialogue model given one `NEXT` line of names only, an 8000 ms preview budget, a late or failed result chooses nothing, and an incomplete request is kept unconfirmed with no follow-up promise. The confirmed closing line is "Thank you. Your request is recorded. Goodbye."
- **The server on this machine** was restarted with contact capture ON and the code of commit `62da32c`; its config is still the original one-category cleaning skill (digest `2959c7c5…c41`) with no `opening` block. **The later uncommitted code is not loaded by it, and the Drew Cleaning test configuration (private file outside the repository) is prepared but not activated.** Backups of the earlier config and database are outside the repository.
- **Contact capture** (name, callback number, service address) is implemented with focused privacy tests and is covered by the 1130 above. It is opt-in (`FOUNDER_CONTACT_KEY` at start). Contact values live only in the AES-256-GCM contact vault (30-day retention, restricted command-line lookup); the dashboard cannot reach it.
  - *Name.* Found by a rule-based heuristic (the first one or two names the masker recognises). A lower-case name that nothing introduces is not captured, so the assistant would keep asking. **The name is not read back**; the main read-back yes is not delivery-checked.
  - *Address: caller confirmation, never postal validation.* The assistant reads the captured address back and the caller says yes or corrects it (up to three tries; a refusal or no answer leaves it unconfirmed). A yes means only that the caller agreed with what was heard. **It never means the address exists, is deliverable, or was checked against any address data.** The record's `address_status` is `'none'` (no address held), `'unverified'` (found or held but not confirmed: never read back, refused, unanswered, cut off, or the contact failed to store) or `'caller_confirmed'` (read back and confirmed, and the vault holds it as confirmed). `caller_confirmed` is written only when the confirmed contact was stored for that call and the record itself is confirmed. The text of the address is whatever the speech and masker captured.
  - *The vault witness.* `eligibleForProcessing(record, witness)` passes a `caller_confirmed` record only if the encrypted contact for the same tenant and call answers `'confirmed'` through the vault's `addressState()`, which returns a state and never the address. No witness, a missing or expired contact, the wrong tenant, a tampered row, the wrong key or any error means not eligible. `unverified` never qualifies, whatever a witness says. If the record write fails after the vault write, an orphan contact row remains until its 30-day expiry.
  - *Dashboard wording conflict (unresolved, needs the founder's written authorization).* The owner view (`src/owner-view.ts`) already shows a `caller_confirmed` call as "Confirmed by the caller on the phone. Not checked against any address data." and no longer asks the owner to verify it. But the protected prototype page script `prototype/intake-work-items/app.js` (about line 181) still prints "An address was given. It is not shown here. A person needs to check it with the caller." for every call with `addressGiven`, including `caller_confirmed`, so one card contradicts itself. The prototype dashboard is unchanged and stays locked (section 1a). The proposed minimal fix, awaiting authorization, is to show that sentence only for `unverified`.
  - *Rollback risk.* The record file format (schema version 2) is unchanged, but the previous commit's code refuses a records database that holds any `caller_confirmed` record, so the owner page and API would fail for that tenant. Before activating the new code, back up `founder-call.sqlite`; do not roll back without first exporting and removing any `caller_confirmed` rows, or restoring the backup. (Verified by running the old code against a copy.)
  - *Dashboard and contact.* A confirmed call whose contact failed to store is shown as "did not confirm the details", which is safe but imprecise.
- **Also implemented in code and tests (none of it exercised on a live call):**
  - **The opening** (section 2a): configurable business and agent introduction, disclosure and an optional approved special.
  - **The services cleaning skill** (`poc/intake-runner/examples/skill-cleaning-services.json`): Standard, Deep and Move-in or move-out cleaning, each asking only its own missing details (property type, bedrooms, bathrooms, pets, extras), with business-configured `choices` offered when clarification helps, a first-cleaning question, and a commercial route that sends the request to a person (`human_review`) instead of continuing. Date and time window stay separate fields. A move-out property is never assumed empty or pet-free.
  - **First-cleaning answers** count only when they answer the active question: a bare yes or no needs a cleanly delivered question, explicit wording counts anywhere, the newest answer wins, and unattributed values are dropped. Delivery cannot be proved (Twilio sends no playback acknowledgement; a successful send is not the same as played).
  - **SIMULATION pricing fixture** (`examples/pricing-fixture-drew-cleaning.json`, `src/pricing-fixture.ts`): cents-based, labelled SIMULATION, human-pricing reason codes; not connected to any call. Pricing and booking remain simulation-only until the business approves live rules. Whether Drew's "$25 cleaning special" is the same as the first-clean discount, and its terms, is undecided.
  - **Handoff preservation**: `call-intake.ts` returns the original sealed handoff and the phone handler keeps it in memory (never logged, stored or sent), offering it to an optional `confirmedHandoff` seam after a confirmed, saved, handed-off record.
  - **Diagnostics** (numbers and fixed words only): `REPLY_SENT`, `REPLY_EMPTY`, `REPLY_INTERRUPTED`, `REPLY_CUT`, `REPLY_SEND_FAILED` and `CALL_CLOSED` (who closed, close code, time since the last words and reply, counts of refused writes and ignored frames). They show whether words were produced and written to the socket; they cannot show that the phone provider spoke them, what the caller said, or why a peer closed.
- **Unwired: the Processing handoff.** The phone path still ends at a saved record. The preserved handoff is offered only to an optional seam that `founder-call-entry.ts` does not pass; `pipeline.ts` has no entry for an existing handoff; `eligibleForProcessing` (and its vault witness) has no consumer in `src`; and the seal is in-process only. No quote, calendar, booking or Processing run is connected to a real call.
- **Open blocker: the silent response (unresolved).** Two cleaning calls (about 8:40 PM and 8:57 PM) ended shortly after the assistant's question, with no caller speech reaching the server, both before the diagnostics existed. A later call was closed from the peer side before consent. Whether the question had words, was written to the socket or was played, whether the caller spoke, and who closed the connection are not established. It stays an open blocker until a call run with the diagnostics explains it; nothing here counts as validated on a live call until then. See `docs/research/CLEANING_INTAKE_RESEARCH.md` section 0.
- **Not verified:** the read-back (including the address read-back), hang-up and owner screens on a real call; speech recognition of digits, names and addresses in the field; the Twilio caller-ID attestation signal (not read anywhere in the code).

## 5a. Next goal: one complete simulated cleaning quote-to-booking test

**Proposed, not yet approved as a task.** The next milestone is a single end-to-end run in SIMULATION (section 3a) of the chain in section 2: verified contact → service → simulated quote → approval → availability → booking → QC → the existing dashboard, using mock approved-rate fixtures and a mock calendar and invented personas only. It is built as a sequence of separately approved tasks (section 1b), in the order of section 3, and every dashboard addition follows section 1a. It does not make cleaning LIVE and does not quote or book anyone real. Two earlier code blockers for that test are fixed in code and tests (local, not seen live): a captured address no longer leaves `address_status` as `none`, and an address the caller confirms on the phone is recorded as `caller_confirmed` (confirmation by the caller, never postal validation) with the vault witness required by the eligibility gate. Business gaps are separate and need the founder: the live cleaning skill still has one category; a services skill (standard, deep, move-in/move-out, with choices, a first-cleaning question and a commercial human-review route) and a SIMULATION pricing fixture exist as examples and have not been applied or approved for live use, so a quote cannot yet tell the cleans apart on a real call. Prerequisites still open: diagnosing the silent response (section 5), the Intake-to-Processing bridge (section 3), the founder's cleaning categories and fixture rates (section 6), and the decision to commit the current work (section 6, item 7).

## 5b. Reconciliation with the project records (2026-10-26)

This file was reconciled with `docs/PRODUCT_CONTINUITY.md` (which governs the dashboard and wins any conflict), `docs/PROJECT_CONTINUITY_HANDOFF.md`, `docs/MASTER_BUILD_REGISTER.md` (change log), `docs/blueprint/PLATFORM_MASTER_PLAN.md` (section 11.5 item 24a) and `docs/FOUNDER_PHONE_TEST_RUNBOOK.md`. Documentation only. No row status in the plan or register was raised: the new work has local test evidence only. The figures in this file are dated snapshots.

## 6. Open founder decisions that gate the order

1. Cleaning categories and their required fields (step 2). Proposed inputs, not approved, are in `docs/research/CLEANING_INTAKE_RESEARCH.md`.
2. Pricing rules and who approves them (steps 3-4), per business, including the quote-versus-estimate policy for each service (section 3a). Moving any business from SIMULATION to LIVE is its own explicit decision.
3. Contact retention beyond the 30-day pilot, who may read contacts, and whether the number may be read back in full (step 1 hardening).
4. Whether the callback number may be suggested from caller ID, with the caller's confirmation.
5. **Decided by the founder (2026-10-26):** the preview budget is 8000 ms. Still engineering values, not decisions: the read-back caps (`MAX_READBACKS = 2`, second unclear answer, 20 s wait).
6. **Decided by the founder (2026-10-26):** the confirmed closing line is "Thank you. Your request is recorded. Goodbye." with no follow-up promise. Open: whether it may ever promise a follow-up (not while no callback process exists).
7. Whether and when to commit and push the Option A and contact-capture work.

8. For the two-minute dashboard (section 3b): whether the owner list may show a caller's name after owner login, how the contact reveal is audited and retained, and when the "nothing implies a booking" rule may be relaxed.

9. Whether and when to apply the `opening` block and the services skill to the live config (a new digest, new TwiML in the Twilio bin and a restart), the disclosure wording and its legal check, and whether the business wants a special.

(The dashboard constraint in section 1a and the one-task-at-a-time rule in section 1b are **not** open decisions.)

## 7. Rules for whoever continues this

- Read `docs/PRODUCT_CONTINUITY.md` first, then section 1a above. The dashboard rule is permanent and founder-locked.
- Keep the order in section 3. If a step is skipped, say so in the register.
- Follow section 1b: one task at a time, explicit founder approval before each begins, and the cycle implementation, automated tests, live validation when applicable, founder review. Finishing a task never authorises the next.
- A number in this file ("1130 tests") is a dated snapshot. Re-run the suite and read `git status --short` and `git log origin/main..HEAD --oneline` for the current state.
- Do not put personal data, secrets, the relay path or keys in any document.
