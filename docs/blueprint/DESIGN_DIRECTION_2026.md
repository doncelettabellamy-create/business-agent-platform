# Design Direction 2026: Premium Light UI

> **Status: DRAFT design direction. Not approved. Not implemented.** No screen, token, or component exists. All implementation gates are on HOLD.
> Sources read: `docs/blueprint/PRD.md`, `UI_UX_DESIGN.md`, `TEMPLATES.md`, `ARCHITECTURAL_ESSENTIALS.md`. This document adds visual and interaction direction only. It does **not** change architecture, requirements, contracts, or runtime code.
> Brand, component library, and app style are **TBD (D-10)**. Everything below is a **proposal for the founder**, not a decision. Product name is shown as `<Product>`.
> Labels used: **MVP** = part of the proposed Intake pilot (read-only list and detail). **FUTURE, NOT MVP** = outline for later phases; do not build against it.

## 1. Design intent

Three qualities, each tied to concrete rules. The named products are **inspiration for a quality, not templates**: they were not inspected for this document, nothing is copied from them, and "Atlas" is read here as an editorial, text-led style (an assumption; correct me if you meant a specific product).

| Quality | Meaning for us | Concrete rules |
|---|---|---|
| **Linear-like simplicity** | Calm, fast, dense-where-useful, keyboard-friendly, almost no decoration | One accent color; borders instead of shadows; few navigation items; no modal-heavy flows; consistent row anatomy; fast perceived loading |
| **Atlas-like editorial hierarchy** | Pages read like a well-set document: clear title, short lede, strong typographic ranking, generous whitespace | A serif display face for page titles only; a single reading column for message text; labels small and quiet; at most three type ranks visible in one view |
| **CrewAI-like operational visibility** | You can see what each agent did, in what order, and what is waiting | A "pipeline strip" showing the four agents and their state on every item; a step trace on the detail view; plain-language reasons for every flag |

Principles inherited from `UI_UX_DESIGN.md` still apply: masked by default, no unmask control in the MVP, uncertain items impossible to miss, server enforces permissions, visible shadow-mode banner, status never color-only.

What this direction refuses to do: invent features, imply that Processing, Quality Control, or Reporting are running in the pilot, show raw personal data, or reproduce any other product's brand assets.

## 2. Color tokens (light theme only)

Contrast ratios were computed against WCAG 2.x relative luminance. Targets: text 4.5:1 or better, essential UI boundaries and icons 3:1 or better. Hex values are proposals pending brand (D-10).

### 2.1 Neutrals and accent

| Token | Hex | Use | Contrast check |
|---|---|---|---|
| `bg` | `#FAFAF8` | App canvas | n/a |
| `surface` | `#FFFFFF` | Cards, table body, panels | n/a |
| `surface-sunken` | `#F3F3F0` | Table header, inactive blocks | n/a |
| `border-subtle` | `#E4E4DF` | Decorative dividers only | 1.22:1 on `bg`; **never used to identify a control** |
| `border-control` | `#8C8C94` | Inputs, buttons, focusable boundaries | 3.34:1 on `surface` |
| `text-primary` | `#15151A` | Titles, body | 17.41:1 on `bg`, 18.2:1 on `surface` |
| `text-secondary` | `#4A4A52` | Supporting text | 8.4:1 on `bg` |
| `text-tertiary` | `#6B6B73` | Meta, captions | 5.05:1 on `bg`, 4.75:1 on `surface-sunken` |
| `accent` | `#3A47C9` | Links, primary action, focus ring | 7.18:1 on `surface`; 6.87:1 on `bg` |
| `accent-subtle` | `#ECEEFD` | Selected row, active nav background | `accent` text on it: 6.23:1 |

### 2.2 Status tokens (always paired with an icon and a word)

| Status | Text/icon | Background | Contrast | Icon |
|---|---|---|---|---|
| Ready | `#17703F` | `#E8F5EE` | 5.47:1 | check circle |
| Needs review | `#7A4F00` | `#FFF4DB` | 6.52:1 | flag |
| Error / rejected | `#B0261E` | `#FCEAE9` | 5.76:1 | alert triangle |
| Neutral / not active | `#6B6B73` | `#F3F3F0` | 4.75:1 | dashed circle |

### 2.3 Agent identity (decorative aid; the name and glyph always accompany the color)

| Agent | Color | Contrast on `surface` | Glyph (proposal) |
|---|---|---|---|
| Intake | `#0E6B6B` | 6.3:1 | inbox |
| Processing | `#5B3FBF` | 7.22:1 | gear |
| Quality Control | `#9A4700` | 6.41:1 | shield-check |
| Reporting | `#2F5D8C` | 6.85:1 | bar chart |

Dark theme: **not specified (TBD)**. The PRD is silent. Do not add one without a decision.

## 3. Typography

Font families are **proposals**. Their licenses have not been checked; choose open-licensed or licensed families under D-10 and keep system fallbacks.

| Role | Family (proposal) | Fallback |
|---|---|---|
| UI and body | A neutral grotesque sans | system UI stack |
| Editorial display (page titles only) | A restrained serif | Georgia-class system serif |
| Identifiers, versions, hashes | A monospace | system monospace |

| Style | Size / line height | Weight | Use |
|---|---|---|---|
| Display | 32 / 40 | 600 serif | Page title (one per page) |
| Title | 22 / 28 | 600 serif | Section title on detail |
| Heading | 16 / 24 | 600 sans | Card and table-group headings |
| Body | 15 / 24 | 400 sans | Message text, descriptions |
| UI | 14 / 20 | 400 / 500 sans | Table cells, buttons, inputs |
| Meta | 13 / 18 | 400 sans | Timestamps, ids (never below 13 px) |
| Overline | 12 / 16 | 600 sans, uppercase, 0.04em tracking | Field labels, only where contrast ≥ 4.5:1 |

Rules: at most three ranks per view; sentence case everywhere; no all-caps beyond overlines; line length 60 to 75 characters for message text; text scales with user settings up to 200% without loss.

## 4. Spacing, layout, shape, motion

| Item | Value |
|---|---|
| Base unit | 4 px |
| Spacing scale | 4, 8, 12, 16, 24, 32, 48, 64 |
| Page max width | 1200 px content; message column 680 px |
| Grid | 12 columns, 24 px gutters (desktop); 4 columns, 16 px gutters (phone) |
| Radius | 6 (controls), 10 (cards), 999 (chips) |
| Elevation | None by default; borders carry structure. One soft shadow only for menus and popovers |
| Row height | 48 px default; 40 px compact (optional) |
| Touch target | 44 × 44 px minimum |
| Motion | 120 to 180 ms ease-out for state changes; no animated page transitions; respect reduced-motion |

## 5. Navigation

```
+-----------+------------------------------------------------------------+
| <Product> | [Shadow mode: nothing is sent]                  <User> v    |
|           +------------------------------------------------------------+
| Work items|                                                            |
|           |   (page content)                                           |
| ......... |                                                            |
| Later:    |                                                            |
|  (hidden) |                                                            |
+-----------+------------------------------------------------------------+
```

| Element | MVP | Notes |
|---|---|---|
| Left rail with one item, **Work items** | Yes | Collapsible; becomes a top bar on phone widths |
| Top bar: mode banner, user menu | Yes | Banner always visible (PRD-13 if D-13 approved) |
| Breadcrumb "Work items / Item `<id>`" on detail | Yes | |
| Rail items for approvals, agents, usage, audit, settings | **FUTURE, NOT MVP** | Not rendered in the pilot; no disabled placeholders |
| Command palette (Ctrl or Cmd + K) | **FUTURE, NOT MVP** | Linear-style quick navigation |
| Keyboard: `/` focus search, `J`/`K` move through rows, `Enter` open, `Esc` back | Proposed MVP extra | Not in the PRD; needs approval (see section 12) |

## 6. Work-item list (MVP, read-only)

```
+------------------------------------------------------------------------------+
| Work items                                              (serif, Display)     |
| Requests received through the connected channel, with personal data hidden.  |
|                                                          (lede, text-secondary)
| [ 24 Ready ]  [ 6 Needs review ]  [ 0 Rejected today ]    <- counts only     |
+------------------------------------------------------------------------------+
| Status [All v]  Category [All v]  Search [/ ______________]        [Clear]   |
+------------------------------------------------------------------------------+
| Status          Category      Received        Confidence   Reason / flags    |
|--------------------------------------------------------------------------------
| (check) Ready   <category>    <date, time>    <value>                        |
| (flag) Review   <category>    <date, time>    <value>      Missing 2 fields  |
| (flag) Review   Unknown       <date, time>    --           Detector offline  |
|                                                                              |
| 1 to 25 of <n>                                      [ Previous ]  [ Next ]   |
+------------------------------------------------------------------------------+
```

| Aspect | Specification |
|---|---|
| Hierarchy | Serif title, one-line lede, then a quiet counts strip, then controls, then the table |
| Counts strip | Counts by status from `work_items` only; **not** a dashboard; optional (see section 12) |
| Columns | Status (icon + word), Category, Received, Confidence (number), Reason/flags. No message text in the list |
| Order | `Needs review` first, then newest first |
| Row | 48 px; whole row is the link; hover `surface-sunken`; selected `accent-subtle`; focus ring 2 px `accent` with 2 px offset |
| Confidence | Numeric value only. Qualitative bands are **TBD (D-04)** |
| Search | Matches item id, category, field names; **never** searches raw personal data |
| Unknown category | Shown as "Unknown" with the Needs-review chip |
| Permissions | The server returns only the user's tenant (AT-21) |

States: see section 10.

## 7. Work-item detail (MVP, read-only)

```
+------------------------------------------------------------------------------+
| Work items / Item <id>                                                       |
|                                                                              |
| <Category or "Unknown">                                  (flag) Needs review |
| Received <date, time> through <channel> . Item <id>   (Title serif; meta row)|
+--------------------------------------------+---------------------------------+
| MESSAGE (MASKED)                           | HOW THIS WAS HANDLED            |
| +----------------------------------------+ |  [Intake] done                  |
| | <text with tokens, e.g. [PERSON_1]>    | |  [Processing] not active        |
| +----------------------------------------+ |  [Quality Control] not active   |
| Personal data hidden: <type> x <n>, ...    |  [Reporting] not active         |
|                                            |                                 |
| EXTRACTED FIELDS                           |  Step trace                     |
| Field        Value (masked)  Conf.  Found  |  1 Verified            <ms>     |
| <field>      <value>         <v>    Yes    |  2 Deduplicated        <ms>     |
| <field>      --              --     No     |  3 Personal data found <ms>     |
|                                            |  4 Masked + stored     <ms>     |
| WHY THIS NEEDS REVIEW                      |  5 Classified          <ms>     |
| - <reason in plain words>                  |  6 Extracted           <ms>     |
|                                            |  7 Validated           <ms>     |
|                                            |  8 Saved + handed off  <ms>     |
|                                            |  Versions: skill, model, prompt |
+--------------------------------------------+---------------------------------+
```

| Aspect | Specification |
|---|---|
| Hierarchy | Title (category) → status → meta → left column (reading) → right rail (provenance) |
| Message block | 680 px column, Body style, `surface` with `border-subtle`; tokens shown as quiet chips; a note explains "Hidden to protect personal data" |
| Fields table | Value always masked; "Not found" is explicit text, never an empty cell |
| Reasons | One sentence per reason, from a fixed vocabulary (no free text from the model) |
| Step trace | Built from run steps by reference: names, status, duration only. **No bodies.** Shows retries as "Retried n times" |
| Pipeline strip | Section 8 |
| Excluded in the MVP | Edit, approve, send, unmask, copy-raw, delete, "View audit" (FUTURE) |
| Back | Returns to the list with filters and scroll position preserved |

## 8. Four-agent workflow concept (the "pipeline strip")

Purpose: make the four-agent structure visible without implying work that is not happening. The same component appears in the item detail and (FUTURE) on the Agents screen.

```
 [Intake]  --->  [Processing]  --->  [Quality Control]  --->  [Reporting]
  done           not active          not active              not active
```

| Agent state | Visual | Wording | When |
|---|---|---|---|
| Done | Solid agent-color glyph, check, text | "done" | Step finished for this item |
| Running | Animated ring (static ring if reduced motion), text | "working" | In progress (FUTURE for all but Intake) |
| Waiting | Hollow ring | "waiting for `<reason>`" | FUTURE: approval, rework |
| Flagged | Flag icon, Needs-review colors | "needs review" | Item flagged |
| Not active | Dashed gray circle, `text-tertiary` | "not active in the pilot" | **Processing, Quality Control, Reporting in the MVP** |
| Stub | Dashed circle with "stub" label | "receives hand-off only" | Processing in the pilot, if the stub exists |

Rules: the labels "not active" and "stub" are mandatory in the pilot so the UI never claims capabilities that are not built. Agent names are exactly Intake, Processing, Quality Control, Reporting (FC-01). Connectors are decorative; the state is in text.

**FUTURE, NOT MVP:** a run view showing each agent's skills, the hand-off envelope version, the QC verdict, and approval waits. Not designed beyond this paragraph.

## 9. Future screens (all FUTURE, NOT MVP; outline only)

| Screen | Intent | Design notes | Requirement |
|---|---|---|---|
| Approval inbox | One-tap decisions on a phone | Card per request: action, reason, evidence link, expiry, Decline and Approve; "Someone already decided" state; server checks approver identity | PRD-18 |
| Today queue | What needs attention now | Needs-review items and pending approvals, editorial grouping by urgency | UI-01 |
| Agents | Operational visibility across the four agents | Pipeline strip, per-agent status, pause control, pause all | UI-01 |
| Item run view | Full trace per item | Extends the step trace and pipeline strip | PRD-16, PRD-17 |
| Audit trail | Verified history | Search, chain verified badge | RPT-04, D-09 |
| Usage | Spend against the cap | Plain meter plus table | PRD-21, D-12 |
| Reports | Output of Reporting | Layout depends on the vertical | PRD-20, D-01 |
| Settings | Categories, rules, tiers, channel | Depends on D-01, D-02, D-08 | n/a |
| Platform-admin console | Tenants, health, support | Internal tool; framework candidates PENDING (react-admin, UI-03) | UI-03 |

Every future screen must carry its own acceptance tests before it is built.

## 10. Responsive behavior and states

### 10.1 Breakpoints

| Name | Width | Layout |
|---|---|---|
| Phone | below 640 px | Top bar replaces rail; list rows become cards; detail stacks (message, fields, reasons, then provenance) |
| Tablet | 640 to 1023 px | Rail collapsed to icons; detail right rail moves below content |
| Desktop | 1024 px and up | Rail expanded; detail two columns |
| Wide | above 1440 px | Content stays at 1200 px max; extra space is margin |

### 10.2 Row-to-card transform (phone)

```
+--------------------------------+
| (flag) Needs review            |
| <category>                     |
| <date, time>   Conf. <value>   |
| Missing 2 fields               |
+--------------------------------+
```

### 10.3 Global states

| State | Behavior |
|---|---|
| Loading | Skeleton rows or blocks; no spinners over content; announce "Loading" to assistive tech |
| Empty list | "No items yet. Messages sent to the connected channel appear here." |
| Empty filter result | "No items match these filters." with Clear action |
| Error | "We couldn't load items. Try again." plus reference id (the correlation id) and a Retry button |
| Permission denied | "You don't have access to this workspace." No details about other tenants |
| Item not found | Same wording as permission denied for other-tenant ids (avoids leaking existence) |
| Offline | Banner "You're offline. Showing the last loaded data." (stale timestamp shown) |
| Kill switch on | Banner "Processing is paused." in `Needs review` colors |
| Shadow mode | Persistent banner "Shadow mode: nothing is sent." |

## 11. Accessibility

Target (proposal, standard **TBD** in the UI document): **WCAG 2.2 level AA**. Needs founder approval.

| Area | Requirement |
|---|---|
| Contrast | Text 4.5:1 or better; large text and UI boundaries 3:1; values in section 2 |
| Color | Status and agent state always use icon plus text; color is never the only signal |
| Keyboard | Every action reachable by keyboard; visible focus ring (2 px `accent`, 2 px offset); logical order; no keyboard traps |
| Targets | 44 × 44 px minimum on touch |
| Structure | One `h1` per page; landmarks (navigation, main); tables use real header cells; row links have accessible names including status and category |
| Announcements | Loading, errors, and filter changes announced politely |
| Motion | Reduced-motion removes animation; nothing flashes |
| Zoom/reflow | Works at 200% text size and 320 px width without horizontal scrolling |
| Forms | Labels tied to inputs; errors tied to fields |
| Language | `lang` set; localization TBD (D-11) |
| Sensitive data | Masked tokens are announced as "hidden personal data", not read as raw tokens |

## 12. Conflicts and gaps with the PRD and related documents

| # | Item | PRD / document says | This direction | Proposed resolution (needs founder decision) |
|---|---|---|---|---|
| 1 | Counts strip on the list | PRD §7 puts dashboards out of MVP; PRD-14 says "read-only list" | Adds a counts-by-status strip | Treat as optional; counts only, no charts; remove if you want a strictly minimal list |
| 2 | Step trace and pipeline strip on detail | PRD-14 describes the list only; `UI_UX_DESIGN.md` S-02 detail lists fields, reasons, and "Produced by" but no trace or strip | Adds both | Add to the MVP detail only if approved; data comes from existing run steps (no new bodies) |
| 3 | Detail screen in the PRD | PRD has no detail requirement; it exists only in `UI_UX_DESIGN.md` | Keeps S-02 | Add a PRD line for the read-only detail |
| 4 | Showing Processing, QC, Reporting | PRD: Processing is a stub in the MVP; QC and Reporting not built | Shows all four with "not active" or "stub" | Required wording keeps FC-04 intact; remove the strip if you prefer not to show them |
| 5 | Keyboard shortcuts | Not in the PRD | Proposes `/`, `J`, `K`, `Enter`, `Esc` | Optional; accessibility-neutral; approve or drop |
| 6 | Status vocabulary | `UI_UX_DESIGN.md` §6 lists "Ready, Needs review, Rejected" | Uses Ready and Needs review for work items; Rejected only for inbound events (not in the MVP list) | `work_item.v1` has only `ready` and `needs-human`; clarify in `UI_UX_DESIGN.md` later |
| 7 | Confidence bands | `UI_UX_DESIGN.md`: value plus qualitative label; thresholds TBD (D-04) | Numeric only | Keep numeric until D-04 sets thresholds |
| 8 | Accessibility standard | UI document: standard TBD | Proposes WCAG 2.2 AA | Needs approval |
| 9 | Visual tokens and fonts | D-10 (brand, library, style) is open | Proposes colors, type, spacing | Treat as a proposal; font licenses unchecked |
| 10 | Light theme only | PRD silent on themes | Light only | Dark theme TBD |
| 11 | Search | UI document: search box | Search limited to ids, category, field names; never raw data | Consistent with masking rules; record in the UI document |
| 12 | Item "not found" wording | Not specified | Same message for missing and other-tenant items | Supports tenant isolation (AT-03, AT-21); record in the UI document |
| 13 | Quoted product styles | Not in any document | Linear, Atlas, CrewAI used as inspiration only; not inspected | No assets or code taken; confirm the "Atlas" interpretation |
| 14 | Framework choice | Refine and react-admin are PENDING (UI-02, UI-03) | Tokens are framework-neutral | Keep one UI shell (ARCHITECTURAL_ESSENTIALS rule 4); no second shell |

No conflict was found with the architecture, tenant, personal-data, or logging rules. The direction adds no data, tables, or contracts.

## 13. Component inventory (proposed; one owner each)

| Component | Phase | Owner | Notes |
|---|---|---|---|
| App shell: rail, top bar, mode banner | MVP | Custom (UI-01) | |
| Status chip | MVP | Custom | Icon + word |
| Work-item table / card list | MVP | Custom | Row-to-card transform |
| Filter bar | MVP | Custom | Status, category, search |
| Masked message block | MVP | Custom | Token chips |
| Fields table | MVP | Custom | |
| Reason list | MVP | Custom | Fixed vocabulary |
| Pipeline strip | MVP (detail) | Custom | Section 8 |
| Step trace | MVP optional (see conflict 2) | Custom | |
| Skeleton, empty, error, banner | MVP | Custom | |
| Command palette, approval card, run view, charts | FUTURE, NOT MVP | Custom | |

## 14. Acceptance checks (proposed; not yet in `DEPLOYMENT_TESTING.md`)

| ID | Check |
|---|---|
| DD-T1 | Every text/background pair in section 2 meets its stated ratio (automated contrast test) |
| DD-T2 | Status chips and pipeline states are understandable in grayscale |
| DD-T3 | List and detail work at 320, 640, 1024, and 1440 px without horizontal scroll |
| DD-T4 | Keyboard-only pass: filter, open an item, return with filters preserved |
| DD-T5 | Screen-reader pass: landmarks, table headers, status announcements, hidden-data wording |
| DD-T6 | Processing, QC, and Reporting always show "not active" or "stub" in the pilot |
| DD-T7 | Page source and network responses contain no raw synthetic values (same as UI-T4) |
| DD-T8 | Reduced-motion removes all animation |

These complement AT-21 and UI-T1 to UI-T4.

## 15. Open decisions

| ID | Decision |
|---|---|
| D-10 | App style, brand, component library, fonts (licenses) |
| New | Approve the conflict resolutions in section 12 (items 1, 2, 3, 4, 5, 8) |
| New | Dark theme: yes or no |
| D-04 | Confidence bands |
| D-11 | Languages and localization |
| D-01 | Category names and field labels |

## 16. Completeness

| Part | Status |
|---|---|
| Tokens, type, spacing, navigation, list, detail, pipeline strip, responsive states, accessibility | Complete as a proposal for the MVP |
| Future screens | **Outline only** |
| Brand, logo, imagery, iconography set, fonts | **Not started (D-10)** |
| Dark theme, localization | **Not specified** |
| Usability testing with real staff | **Not planned** |
