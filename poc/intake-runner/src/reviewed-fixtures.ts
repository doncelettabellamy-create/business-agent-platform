// The only inputs the live developer path will accept: synthetic example files whose CONTENT is pinned by a digest.
//
// A file under examples/ is not enough. Anyone could edit skill-input.json (or add a new file) and put real customer text
// in it; the live path would then send it to a provider. Here a file is accepted only if its path is listed AND the
// canonical digest of its parsed content equals the pinned value. Changing a fixture therefore needs a deliberate edit
// of this table, which is the review step. Real customer data can never match a pinned digest.
//
// The digest is over the parsed JSON with sorted keys, so line endings and key order do not matter.
// This file reads no files and uses no network; the caller passes in the parsed content.

import { createHash } from 'node:crypto';

/** Path (as given on the command line) to the sha256 of the canonical JSON content. */
export const REVIEWED_FIXTURES: Readonly<Record<string, string>> = Object.freeze({
  'examples/skill-input.json': 'c149ffdbea88412f9645a33f9c06fb1bfae63b32e2a37b2df6688479aad34835',
  'examples/skill-ambiguous-input.json': '554f9a67403e564ef2f91d140d27fcf657af7b3247214766e563f12e80f0763e',
  'examples/skill-plumbing.json': '62178b95b692951cacac333e19148c6ceb7437570bf21877e355d3539bbd2fd6',
  'examples/skill-dental.json': '7f3224c1f1414671ebeafcf500a5c57afd73f1b916c5e6bdf5397de7af926c16',
});

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
}

export function fixtureDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** Empty list means the input is a reviewed synthetic fixture. Messages are fixed text; no content is echoed. */
export function reviewedFixtureProblems(path: unknown, input: unknown): string[] {
  if (typeof path !== 'string' || !Object.hasOwn(REVIEWED_FIXTURES, path)) return ['input is not one of the reviewed synthetic fixtures'];
  let digest: string;
  try { digest = fixtureDigest(input); } catch { return ['input could not be checked against its reviewed digest']; }
  return digest === REVIEWED_FIXTURES[path] ? [] : ['input content differs from the reviewed synthetic fixture'];
}
