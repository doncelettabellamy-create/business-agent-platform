# Intake work-item prototype (visual only)

**Status: throwaway visual prototype. Not product code, not approved, not part of the architecture.**
It shows the Intake work-item **list** and **detail** screens from `docs/blueprint/UI_UX_DESIGN.md`, styled per `docs/blueprint/DESIGN_DIRECTION_2026.md` (a proposal; brand and library are TBD, D-10).

## Safety

- All data is **synthetic** (`data.js`). No real messages, people, or numbers.
- No network calls, no storage, no cookies, no analytics, no external fonts or images.
- No framework, build step, database, backend, or agent runtime. Plain HTML, CSS, and JavaScript.
- Nothing can be sent, edited, approved, or unmasked.

## Preview locally

1. Open `index.html` in a browser (double-click it, or open `file:///C:/dev/business-agent-platform/prototype/intake-work-items/index.html`).
2. Optional local server (no install needed if Python is present): run `python -m http.server 8080` in this folder, then open `http://localhost:8080/`. Stop it with Ctrl+C.

Resize the window to see the desktop (1024 px and up), tablet (640 to 1023 px), and phone (below 640 px) layouts.

## What to try

- Click a row, or use `/` (search), `J` / `K` (move), `Enter` (open), `Esc` (back from detail).
- Open the **Prototype controls** section at the bottom of any page and switch the screen state: Normal, Loading, Empty, Error, Permission denied, Offline, Kill switch on.
- Detail example with several flags: item `wi-0013`. Item with the detector offline: `wi-0014`.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page shell: navigation rail, mode banner, content region |
| `styles.css` | Design tokens and responsive layout |
| `data.js` | Synthetic masked data (14 items) |
| `app.js` | List, detail, pipeline strip, step trace, states, keyboard (no dependencies) |

## Known limits

- Light theme only; dark theme is not specified.
- Category and field names are generic placeholders (vertical is TBD, D-01).
- Only Intake is shown as working. Processing is a stub, and Quality Control and Reporting read "not active in the pilot".
- Not tested with a screen reader, only checked visually in headless Chrome at several widths.
