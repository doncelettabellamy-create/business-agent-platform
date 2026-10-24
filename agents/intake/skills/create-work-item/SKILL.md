---
name: create-work-item
description: Builds a validated work_item.v1 and, for ready items only, a handoff envelope for Processing. Use as the last Intake step.
metadata:
  agent: "intake"
  status: "draft"
---

# create-work-item

> Draft skill definition. Not approved. In this proof of concept the work item exists in memory only; nothing is stored or sent. This skill never calls a model.

## When to use

As the final Intake step, after completeness has been judged.

## Procedure

1. Build the `work_item.v1` from the category, fields, missing fields, personal-data summary (types and counts only), status, reasons, and versions. The masked text itself is referenced (`msg:<event id>`), never copied.
2. Validate the work item against `work_item.v1`. If it fails, refuse and report the failing paths without values.
3. For `ready` items only, wrap it in a handoff envelope addressed to Processing and validate the envelope.
4. `needs-human` items get no envelope; they wait for review (review is out of scope for this proof of concept).

## Failure modes

- Contract validation failure: report `CONTRACT_INVALID` with field paths only.
- Unsupported contract version requested: refuse (`CONTRACT_UNSUPPORTED`).

## Do not

- Do not hand off items that need review.
- Do not include raw text, tenant secrets, provider text, or error messages in any output.
- Do not send anything outside the process.
