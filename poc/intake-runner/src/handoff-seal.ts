// In-process handoff seal (proof of concept). The Intake entry seals each handoff envelope it issues; Processing accepts
// only an envelope that is the very object the Intake entry issued AND whose content still matches the digest taken at
// issue time. A hand-built, copied, parsed-from-JSON, proxied or later-edited envelope is not sealed.
//
// The same mechanism seals candidate_result.v1 (Processing entry only) and qc_verdict.v1 (QC entry only).
// This is NOT a signature: it holds only inside one process and gives no protection across a queue or store. That needs a
// real authenticity decision (open). Whoever can import sealHandoff can forge a seal, so a test pins its importers.
// This file imports no network, file, or process APIs (it uses a hash only).

import { createHash } from 'node:crypto';

const sealed = new WeakMap<object, string>();
const sealedCandidates = new WeakMap<object, string>();
const sealedVerdicts = new WeakMap<object, string>();

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}
/** Digest of a plain-data value, independent of key order. */
export function contentDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

/** Called only by the Intake entry, on an envelope it has just produced. */
export function sealHandoff(envelope: object): void {
  try { sealed.set(envelope, contentDigest(structuredClone(envelope))); } catch { /* an unsealable envelope simply stays unsealed */ }
}

/**
 * True only when `original` is an object that was sealed and `copy` (a one-time structuredClone of it, taken by the caller)
 * still has the sealed content. Checking the copy means a getter cannot show one value here and another later.
 */
export function isSealedHandoff(original: unknown, copy: unknown): boolean {
  try {
    if (original === null || typeof original !== 'object') return false;
    const digest = sealed.get(original);
    return digest !== undefined && digest === contentDigest(copy);
  } catch { return false; }
}

/** Called only by the Processing entry, on a candidate_result.v1 it has just produced. */
export function sealCandidate(candidate: object): void {
  try { sealedCandidates.set(candidate, contentDigest(structuredClone(candidate))); } catch { /* stays unsealed */ }
}

/** Same rule as isSealedHandoff, for candidates: the very object Processing issued, with the content it had when issued. */
export function isSealedCandidate(original: unknown, copy: unknown): boolean {
  try {
    if (original === null || typeof original !== 'object') return false;
    const digest = sealedCandidates.get(original);
    return digest !== undefined && digest === contentDigest(copy);
  } catch { return false; }
}

/** Called only by the QC entry, on a qc_verdict.v1 it has just produced. */
export function sealVerdict(verdict: object): void {
  try { sealedVerdicts.set(verdict, contentDigest(structuredClone(verdict))); } catch { /* stays unsealed */ }
}

/** Same rule as isSealedHandoff, for QC verdicts. */
export function isSealedVerdict(original: unknown, copy: unknown): boolean {
  try {
    if (original === null || typeof original !== 'object') return false;
    const digest = sealedVerdicts.get(original);
    return digest !== undefined && digest === contentDigest(copy);
  } catch { return false; }
}

/** Builds a seal/check pair with its own private registry (used by the approval contracts). */
function makeSeal(): [(o: object) => void, (original: unknown, copy: unknown) => boolean] {
  const registry = new WeakMap<object, string>();
  return [
    (o) => { try { registry.set(o, contentDigest(structuredClone(o))); } catch { /* stays unsealed */ } },
    (original, copy) => {
      try {
        if (original === null || typeof original !== 'object') return false;
        const digest = registry.get(original);
        return digest !== undefined && digest === contentDigest(copy);
      } catch { return false; }
    },
  ];
}
/** Called only by approval.ts, on an approval proposal or decision it has just produced. */
export const [sealApprovalProposal, isSealedApprovalProposal] = makeSeal();
export const [sealApprovalDecision, isSealedApprovalDecision] = makeSeal();
