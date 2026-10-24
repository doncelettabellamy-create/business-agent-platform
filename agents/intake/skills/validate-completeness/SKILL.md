---
name: validate-completeness
description: Checks required fields, category, and confidence against the configured rules and decides whether an item is ready or needs a person. Use after classification and extraction.
metadata:
  agent: "intake"
  status: "draft"
---

# validate-completeness

> Draft skill definition. Not approved. Required fields and any confidence threshold come from configuration and founder decisions (D-01, D-04). This skill never calls a model.

## When to use

After the category and field values are known, whether they came from the model path or the deterministic path.

## Procedure

1. List required fields that were not found (`missing_fields`).
2. Check the category: unknown (nothing matched), ambiguous (a tie), or known.
3. If a minimum confidence is configured, compare the lowest confidence found. There is no default threshold.
4. Add `model_failed` when a model answer was rejected and the configured fallback is human review.
5. Status is `ready` only when there are no reasons; otherwise `needs-human`.

## Failure modes

- No confidence data while a threshold is set: flag `low_confidence` (unscored values count as not confident).
- Any inconsistency between status and reasons is caught by the `work_item.v1` validator and refused.

## Do not

- Do not mark an item ready when anything is missing, unknown, ambiguous, or unscored under a threshold.
- Do not change values; only judge them.
- Do not call a model or any external service.
