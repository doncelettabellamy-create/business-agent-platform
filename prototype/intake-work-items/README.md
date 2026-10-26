# Intake dashboard (the business owner's list and one-intake page)

**Status: the existing test dashboard. It is KEPT and will be evolved into the production customer dashboard after testing and founder approval.** Founder decision, recorded 2026-10-26 in `docs/PRODUCT_CONTINUITY.md`: **do not discard, replace or rebuild this folder from scratch without the founder's explicit written authorization.** Read that file before changing anything here. It is not yet approved for production use (see "Known limits").

An earlier version of this README called the folder a throwaway visual prototype. That description is withdrawn; the sections below describe what the folder is now.

## What it shows

- **The list:** four totals (Intakes received today, Need follow-up, With a requested time, Confirmed by the caller), the total count, two tabs ("Needs follow-up" and "All intakes"), and a card per intake with its request type, time, what the caller needs, "Requested time (not booked)", status and first next step. "Show more" appears after 25.
- **One intake** (`#/call/<time>-<n>`): the request type, the full local date and time, the status, what the caller needs, the requested time, other details, a note when an address was given (the address itself is never shown), and next steps.
- **States:** an empty store ("No phone intakes yet…"), a failed load, and a refusal of bad data. The page refreshes itself about every 15 seconds and rests while the tab is hidden.

## Where the data comes from

- **Live:** the local server `poc/intake-runner/src/dashboard-server.ts` serves this folder at `http://127.0.0.1:8787/` and generates `/data.js` and `/api/owner` from the saved records through `src/owner-view.ts`. That projection is a **strict allow-list**: nine fields per intake and five counts, and no confidence, codes, masks, steps, versions, ids or address values ever reach the page. Nothing in it says or implies a booking.
- **Standalone:** opening `index.html` (or serving the folder with any static server) shows `data.js`, which is **invented sample data** (four sample intakes) under a notice that they are not real calls. The live server never serves that file.

## Files

| File | Purpose |
|---|---|
| `index.html` | The page shell: header with "Updated" and Refresh, a message area, the content region. No inline script or style. |
| `app.js` | The list, the page for one intake, routing by `#/`, refresh, empty and error states. Plain JavaScript, no dependencies, writes text only (never HTML). |
| `styles.css` | Design tokens, mobile-first layout, light and dark themes, focus rings. Nothing is loaded from outside. |
| `data.js` | The invented sample, in the owner view's shape. |

## Safety

- The only network call is `GET /api/owner`. No storage, cookies, analytics, external fonts or images.
- The server answers `GET` and `HEAD` only, for exact paths, on 127.0.0.1, with one strict page policy. Nothing can be sent, edited, approved or unmasked from this page.

## Tests

From `poc/intake-runner`, `npm test`. The page logic is covered by `tests/prototype-empty-store.test.ts` (it runs `app.js` against a stand-in for the browser's DOM and against the real server's files), the owner view by `tests/owner-view.test.ts`, and the server by `tests/owner-dashboard.test.ts` and `tests/founder-dashboard.test.ts`. Keep them green when you change this folder, and add tests for anything new.

## Known limits (be honest about them)

- **It has not been looked at in a real browser,** and has not been tested with a screen reader. The tests use a stand-in DOM.
- No login or tenant isolation (FND-02 / R01), no encryption at rest (FND-10), no retention policy (C14). The server is loopback only, for the founder's own machine.
- No business name or branding yet; no callback number; no quote, calendar or booking. Only Intake feeds it today; the other three agents are not connected to the phone path.
- The category and field names come from the skill configuration in use (today the plumbing sample; a cleaning example exists, `poc/intake-runner/examples/skill-cleaning.json`, and is not applied).

## Related documents

`docs/PRODUCT_CONTINUITY.md` (the decision, the vision and the pending work), `docs/PROJECT_CONTINUITY_HANDOFF.md`, `docs/FOUNDER_PHONE_TEST_RUNBOOK.md`, `docs/blueprint/PLATFORM_MASTER_PLAN.md`, `docs/blueprint/UI_UX_DESIGN.md` and `docs/blueprint/DESIGN_DIRECTION_2026.md` (the earlier staff-oriented design proposals, now partly superseded; see the update at the top of the latter).
