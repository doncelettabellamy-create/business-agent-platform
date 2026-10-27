// The PROPOSED opening for the Drew Cleaning founder voice test (invented details only): the business introduction, the approved test special, and a disclosure that names OpenAI. It is a proposal for the founder (and a
// lawyer) to approve; nothing reads it as configuration. The OpenAI connection check speaks exactly this notice so that the real wording, including the "$25" in the special, is what gets tested.
//
//   * The `special` is the approved Drew test greeting, word for word as it is in the live test configuration. It is spoken once, after the introduction and before the disclosure (opening.ts), and it states no
//     terms: it is not tied to any price rule and the pricing fixture is not connected to the phone.
//   * The `disclosure` replaces the default, which says "our phone provider turns your speech into text" and "personal details are masked before an A I model reads it": untrue for this route, where OpenAI's voice
//     model hears the raw audio. It says what is true: no recording by us, OpenAI hears and transcribes, OpenAI may keep it up to 30 days for safety checks (its documented abuse-monitoring period), and we save the
//     details given, for testing. It is for the approved invented-details test only; real customers need a separate wording and a data-terms decision. It needs a legal check before any real use.

import type { Opening } from './opening.ts';

export const DREW_TEST_SPECIAL = '$25 off a qualifying first standard cleaning';
export const DREW_TEST_OPENING: Opening = Object.freeze({
  business_name: 'Drew Cleaning',
  special: DREW_TEST_SPECIAL,
  disclosure: 'This is a test line, so please use made-up details only. We do not record the call, but our A I speech provider, OpenAI, hears and transcribes what you say, and may keep it for up to thirty days for safety checks. We save the details you give for testing',
});
