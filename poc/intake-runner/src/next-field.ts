// The next step of an intake call, chosen by code from a FRESH, VALIDATED Intake result only (proof of concept, founder phone test).
// PURE: no I/O, no clock, no model, no randomness, no counters. The same inputs always give the same answer.
//
// Why this exists: the dialogue model used to be handed the whole list of missing fields and chose what to ask. That list came from a background
// preview that was one caller turn behind, so the assistant could ask again for something the caller had just said. Now the relay handler runs one
// Intake pass over ALL the caller's lines for every turn, turns the result into a `Fresh` here, and this function says what happens next. The model
// is told ONE thing (a field name, or "clarify", or "listen"); it never sees the list and never chooses the field.
//
//   no fresh result (none, a failed one, or one that does not cover every caller line so far) -> `listen`: no field is chosen from old data;
//   the request is ready                                                                      -> `ready`: the server reads it back;
//   the category is not recognised                                                            -> `clarify` (first time with the category names, afterwards open);
//   a recognised category with nothing missing but not ready (an ambiguous or low-confidence field) -> `listen`;
//   otherwise                                                                                  -> `ask` the missing field asked LEAST recently
//                                                                                                (never asked first, ties in the skill's field order).
// There is no retry counter. A field that is still missing is asked again, in rotation when others are missing too, and the approved global limits
// (turns, minutes, the caller hanging up) are what end a call that never completes.

/** The facts about an Intake result that selection needs. Build it only with `freshFrom`. */
export interface Fresh {
  /** How many caller lines the Intake pass covered. */
  readonly covers: number;
  readonly category: string;
  /** The required fields still not found, in the skill's field order. */
  readonly missing: readonly string[];
  readonly ready: boolean;
}
export interface AskHistory {
  /** For each field already asked: the caller-line count when it was asked. */
  readonly lastAskedAt: ReadonlyMap<string, number>;
  /** Whether the category names have already been offered. */
  readonly clarified: boolean;
}
export type Next =
  | { readonly kind: 'ready' }
  | { readonly kind: 'ask'; readonly field: string; readonly again: boolean }
  | { readonly kind: 'clarify'; readonly first: boolean }
  | { readonly kind: 'listen' };

/** The part of a work item that matters here (structural, so this file imports nothing). */
export interface IntakeResultLike {
  readonly category: string;
  readonly missing_fields: readonly string[];
  readonly status: string;
  readonly reasons: readonly string[];
}

/**
 * A result the call may steer by. A result whose model answer failed (`model_failed`) fell back to a deterministic pass that cannot be
 * trusted to say what is missing, so it is not fresh. Anything malformed is not fresh either.
 */
export function freshFrom(item: IntakeResultLike | undefined, covers: number): Fresh | undefined {
  if (item === undefined || item === null || typeof item !== 'object') return undefined;
  if (!Number.isInteger(covers) || covers < 1) return undefined;
  if (typeof item.category !== 'string' || !Array.isArray(item.missing_fields) || !Array.isArray(item.reasons)) return undefined;
  if (item.missing_fields.some((m) => typeof m !== 'string')) return undefined;
  if (item.reasons.includes('model_failed')) return undefined;
  return { covers, category: item.category, missing: [...item.missing_fields], ready: item.status === 'ready' };
}

export function selectNext(fresh: Fresh | undefined, lines: number, history: AskHistory): Next {
  if (fresh === undefined || fresh.covers !== lines) return { kind: 'listen' };
  if (fresh.ready) return { kind: 'ready' };
  if (fresh.category === 'unknown') return { kind: 'clarify', first: !history.clarified };
  if (fresh.missing.length === 0) return { kind: 'listen' };
  let best = fresh.missing[0];
  let bestAt = history.lastAskedAt.get(best) ?? -1;
  for (const field of fresh.missing) {
    const at = history.lastAskedAt.get(field) ?? -1;
    if (at < bestAt) { best = field; bestAt = at; }   // strictly earlier only, so ties keep the skill's field order
  }
  return { kind: 'ask', field: best, again: bestAt >= 0 };
}
