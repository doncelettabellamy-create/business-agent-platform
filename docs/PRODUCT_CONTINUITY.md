# Product continuity: the dashboard decision, the four-agent vision, and what is pending

Recorded 2026-10-26 at the founder's instruction. This is a continuity document: it exists so that a later session, a new contributor, or a model with no memory of this work cannot quietly undo a founder decision. It is a **record**, not a design. Status of the checklist rows stays in `docs/blueprint/PLATFORM_MASTER_PLAN.md` section 11 and `docs/MASTER_BUILD_REGISTER.md`; the working state is in `docs/PROJECT_CONTINUITY_HANDOFF.md`; the live-call steps are in `docs/FOUNDER_PHONE_TEST_RUNBOOK.md`. Where this file and an older document disagree about the dashboard, **this file wins** (section 6 records the older statements that were reconciled).

## 1. The founder's decision (permanent)

> **KEEP the existing test dashboard. Evolve it into the real production customer dashboard after testing and founder approval. Do not discard, replace, or rebuild it from scratch without explicit founder authorization.**

What that means in practice:

1. **The dashboard that exists today is the starting point of the product, not a throwaway.** It is the owner-facing list of intakes and the page for one intake, in `prototype/intake-work-items/`, served at `/` by `poc/intake-runner/src/dashboard-server.ts`, fed by the allow-listed owner view in `poc/intake-runner/src/owner-view.ts` through `GET /api/owner` and `/data.js`.
2. **It grows by small, tested steps.** Each step keeps the screens, the routes and the privacy contract working, adds tests, and is shown to the founder.
3. **Going live to real customers needs two things after testing:** the founder's approval, and the hardening in section 4. Neither is implied by this document.
4. **The privacy contract travels with it.** The owner view is a strict allow-list. Its rules (no confidence, codes, masks, steps, versions, ids or address values reach the page; nothing says or implies a booking) are part of what is being kept.

### What needs the founder's explicit authorization first
Authorization means a written instruction from the founder that names the action. A general request such as "improve the dashboard" or "clean this up" is **not** authorization for any of these:

- deleting, moving or archiving `prototype/intake-work-items/` or any file in it;
- rewriting `app.js`, `index.html` or `styles.css` from scratch, or replacing them with output from a different framework, template or generator;
- introducing a front-end framework, build step or component library in place of the current plain HTML, CSS and JavaScript;
- changing the owner view's key set or removing a privacy rule (adding a field to the allow-list is a contract change and needs its tests and the founder's say-so);
- replacing the routes `/`, `/data.js` and `/api/owner` with a different structure;
- standing up a second dashboard as the "real" one while the first is left to rot.

### What does not need extra authorization
Edits inside the decision: fixing defects, changing wording, adding a screen state, improving layout or accessibility, adding tests, and keeping the data feed in step with the owner view. The earlier retirement of the **duplicate** `/owner` page (2026-10-26) was a founder instruction about a duplicate; it did not retire this dashboard, and it is the model for how a removal is done: named, verified, tested, recorded.

## 2. The dashboard today (verified 2026-10-26)

| Item | State |
|---|---|
| Screens | Intake list (totals, "Needs follow-up" and "All intakes" tabs, cards, "Show more") and the page for one intake (what the caller needs, requested time, other details, address note, next steps). |
| Files | `prototype/intake-work-items/index.html`, `app.js`, `styles.css`, `data.js` (an invented sample for opening the folder alone; the server never serves it). |
| Server | `src/dashboard-server.ts`: 127.0.0.1 only, one fixed tenant, GET and HEAD only, exact paths, no query string, loopback Host check, one strict page policy (nothing inline, this server only), fixed error text. |
| Data | `src/owner-view.ts`: nine fields per intake and five counts. "Intakes received today" is counted in the owner's day. |
| Behaviour | Refreshes about every 15 seconds and rests while the tab is hidden; mobile first, light and dark themes, focus rings; text only, never HTML. |
| Tests | Run against a stand-in for the browser's DOM and against the real server's files. **It has not been looked at in a real browser.** |
| Not there | No login or tenant isolation (FND-02 / R01), no encryption at rest (FND-10), no retention policy (C14), no business name or branding, no callback number, no quote, calendar or booking. |

## 3. The four-agent vision

The product is four cooperating agents, each judged by evidence the previous one did not write.

| Agent | Job | State (see the plan for authority) |
|---|---|---|
| **1 Intake** | Take the customer's request (today: a phone call), mask personal data, classify and extract with a model, confirm by read-back, produce a validated work item. | Built and run live at least twice on 2026-10-26. Real: Twilio inbound, Claude, SQLite, tunnel, this dashboard. The read-back, the longer hang-up wait, and the owner screens are tested locally only. |
| **2 Processing** | Run a fixed plan of allow-listed tools on a trusted hand-off; human-approved tools pause for a named approver. | Built with **mock tools only**. Tools receive ids, never field values. No pricing, calendar or booking tool exists. |
| **3 Quality Control** | Judge the result by reading back evidence Processing did not write: pass, rework or escalate. | Built against the mock evidence reader only. |
| **4 Reporting** | Verify the chain, keep an append-only history, produce per-tenant reports. | Built (memory and SQLite ledger); reports are not yet shown on the dashboard. |

**Not connected yet:** the phone path keeps only a yes/no hand-off flag; nothing passes its sealed hand-off to Processing. `eligibleForProcessing` (confirmed, ready, handed off, no unverified address) is the single test a future bridge must use. Until the bridge exists, the dashboard shows Intake results only. The dashboard is the owner's window onto all four agents over time, which is why its privacy contract and its evolution matter.

## 4. Path from test dashboard to production dashboard (proposed; none of it is decided)

Each stage is shown to the founder before the next, and each keeps the dashboard working.

1. **Prove it in use.** Look at it in a real browser; run the live call with the read-back; fix what real use shows. *(Current stage.)*
2. **Make it the owner's: identity.** A business name on the page and in the assistant and consent wording (this changes the approval digest and the TwiML).
3. **Follow-up that works.** A callback number held encrypted in its own store and shown only after an authenticated action; this needs the founder's decisions on consent and retention.
4. **Bring in Agents 2 to 4.** The bridge, then quote, calendar check and booking behind explicit policy limits, then Reporting on screen. Each is designed and approved separately.
5. **Production hardening.** Real authentication for owners, tenant isolation, encryption at rest, a retention policy, hosting off the founder's machine, monitoring, backups, a privacy and legal review, and a real-browser and assistive-technology pass.
6. **Founder approval to go live with customers.** Only then.

## 5. Verified state at the time of writing

- **Tests:** **959 passing, 0 failing, 0 skipped** (a fresh full run of `npm test` in `poc/intake-runner` on 2026-10-26). Mocks and stand-ins only: this says nothing about live behaviour.
- **Commits:** `b341fd6` ("Add read-back confirmation, owner dashboard and spaced-digit masking") holds 940 of the tests. The next commit, "Preserve dashboard product decision and add cleaning skill tests", adds this file, the documentation updates that point to it, and the 19 `skill-cleaning` tests (959 in all). Both are on local `main`, **ahead of `origin/main` by two commits, not pushed**. (A commit cannot contain its own hash; use `git log` for it.)
- **Uncommitted:** nothing was pending when the second commit was made; re-check with `git status`.
- **Live evidence (2026-10-26):** at least two real calls reached the server and each saved a record. The first showed digits stored unmasked and an early hang-up; the second, a cleaning request against the plumbing configuration, was `unknown_category`, so no read-back ran and it was saved unconfirmed. Both were found, and the fixes are in code and tested locally.
- **Running server:** a graceful restart onto the committed code was done on 2026-10-26 with a fresh schema-2 database; the plumbing skill is still the live configuration.
- **Checklist roll-up (plan section 11):** 73 rows: 11 BUILT, 23 PARTIAL, 21 NOT STARTED, 18 BLOCKED. Of 17 requirements: 0 BUILT.

## 6. Pending work

**Next, small, and mostly ready**
- Look at the dashboard in a real browser (layout, dark mode, phone width, local time).
- Switch the live configuration to the cleaning skill (`examples/skill-cleaning.json`): a new approval digest, a restart, then a live call that checks rooms, date, time window, read-back, "yes", and the owner screen.
- Fix `address_status` so an address that was spoken but not extracted is still marked unverified (code, with tests).
- Optionally record why a call ended (a fixed word on the record).
- Push the two local commits (on the founder's word, after a final secret scan).

**Needs founder decisions**
- Business name and services; the consent wording; whether a callback number is stored (consent, retention, a short legal check).
- Whether a call that fits no category is read back anyway or ended politely.
- Quote rates, working hours, slot length, booking limits, and whether a digest-approved policy may stand in for per-job approval on a **simulated** calendar (the smallest autonomous test); a real calendar needs a human-signed policy grant and new contracts.
- How an address becomes "verified" so such records can be processed.

**Build, after the above**
- The bridge from a confirmed call to Agents 2 to 4; the pricing, calendar and booking tools; QC checks for them; Reporting on the dashboard.
- Owner approval and callback-reveal routes (these need real authentication first).

**Production readiness (section 4, stage 5)**
- FND-02 / R01 authentication and tenant isolation; FND-10 encryption; C14 retention; hosting, monitoring and backups; accessibility and browser testing; legal review; the production database decision (D-14).

**Documents reconciled with this decision (2026-10-26, documentation only)**
- `prototype/intake-work-items/README.md` was rewritten: it had called the folder a "throwaway visual prototype. Not product code, not approved". It now points here.
- `docs/blueprint/PRD.md`: a header note, section 7 ("dashboards" now reads "beyond the existing owner dashboard"), PRD-14 (staff and the business owner; a page for one item) and PRD-23 now point here. The PRD stays an unapproved draft; the approval inbox and audit viewer remain R4.
- `docs/blueprint/DESIGN_DIRECTION_2026.md`: an update note under the status line, and notes on the counts strip, the Confidence column and section 12 item 1. The rest is kept as the historical staff-oriented proposal.
- `docs/PROJECT_CONTINUITY_HANDOFF.md`, `docs/blueprint/PLATFORM_MASTER_PLAN.md`, `docs/MASTER_BUILD_REGISTER.md` and `docs/FOUNDER_PHONE_TEST_RUNBOOK.md` now link here, carry the 959 local / 940 committed distinction, and (in the handoff) say that live calls are allowed under the founder gate and give the dashboard its own standing rule.
- Historical rows (older register change-log rows, the plan's dated item text) were left as written; they describe their own date.

## 7. Rules for any future session

1. Read this file before touching `prototype/intake-work-items/`, `dashboard-server.ts` or `owner-view.ts`.
2. Do not delete, replace or rebuild the dashboard without the founder's explicit written authorization naming that action.
3. Change it in small steps with tests; run the full suite; keep the privacy contract and its tests green.
4. Record the change in the plan and the register in the same change, with the real test figure.
5. Keep what is **tested locally** separate from what is **seen live**; never write that something works live because its tests pass.
6. Never commit or push without being asked; never put a secret, a real phone number, a relay secret or a tunnel host in the repository.
