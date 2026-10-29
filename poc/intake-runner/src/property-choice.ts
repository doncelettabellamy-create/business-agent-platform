// Whether a caller's words for the PROPERTY TYPE are one of the business's configured choices (proof of concept, founder phone test; founder-approved 2026-10-29). PURE: no I/O, no model, no clock.
//
//   choice    exactly one configured choice appears as a whole word (or its plural) and no choice is negated: "house", "a nice house", "Houses."
//   negated   a choice appears after a negator in its clause: "not a house", "no house", "it isn't a house", "it is a house, not an apartment"
//   multi     two or more different choices appear: "house or apartment"
//   none      no configured choice appears: "Health", "residential", "bungalow", "duplex", "condominium"
//
// Nothing is guessed or normalised: "Health" is not "house", "residential" is not "house", "condominium" is not "condo", and the caller's words are never replaced by a choice. Only `choice` is an unambiguous supported answer.

export type PropertyAnswer = 'choice' | 'negated' | 'multi' | 'none';

const NEGATORS = new Set(['not', 'no', 'never', 'without', 'nor', 'neither', 'isnt', 'arent', 'wasnt', 'werent', 'dont', 'doesnt', 'didnt', 'cant', 'cannot', 'wont', 'hasnt', 'havent', 'shouldnt', 'wouldnt', 'couldnt', 'hardly']);
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Classifies the words against the configured choices. Empty or non-string input is `none`. */
export function classifyPropertyAnswer(value: unknown, choices: readonly string[] | undefined): PropertyAnswer {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200 || choices === undefined || choices.length === 0) return 'none';
  const wanted = choices.map((c) => String(c).trim().toLowerCase()).filter((c) => c.length > 0);
  const affirmed = new Set<string>(); const negated = new Set<string>();
  for (const clause of value.toLowerCase().replace(/[‘’]/g, "'").split(/[,.;!?:()"]+/)) {
    const words = clause.replace(/'/g, '').split(/\s+/).filter((w) => w.length > 0);
    const text = words.join(' ');
    for (const choice of wanted) {
      const re = new RegExp(`(?<![a-z0-9])${escape(choice)}(?:s|es)?(?![a-z0-9])`, 'g');
      for (const m of text.matchAll(re)) {
        const before = text.slice(0, m.index).split(' ').filter((w) => w.length > 0).slice(-3);
        if (before.some((w) => NEGATORS.has(w))) negated.add(choice); else affirmed.add(choice);
      }
    }
  }
  if (affirmed.size === 1 && negated.size === 0) return 'choice';
  if (affirmed.size > 1) return 'multi';
  if (negated.size > 0) return 'negated';
  return 'none';
}
