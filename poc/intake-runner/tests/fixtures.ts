// Synthetic test fixtures. All values are invented; nothing here is real.
import type { IntakeInput } from '../src/intake-runner.ts';

/** A fresh, valid, already-masked synthetic input. Each call returns an independent copy. */
export function validInput(): IntakeInput {
  return {
    workspace_id: 'ws-synthetic-a',
    correlation_id: 'corr-synthetic-0001',
    event_id: 'evt-synthetic-0001',
    received_at: '2026-10-24T09:12:00Z',
    channel_ref: 'channel-tbd',
    masking: { applied: true, source: 'synthetic-fixture' },
    masked_text: 'Hello, this is [PERSON_1]. Please contact me at [CONTACT_1]. SENTINEL-MASKED-TEXT-7731',
    pii_summary: [{ type: 'Person', count: 1 }, { type: 'Contact detail', count: 1 }],
    category_list: ['Category A', 'Category B', 'Category C'],
    required_fields: ['Field 1', 'Field 2'],
    candidate: {
      category: 'Category A',
      fields: [
        { name: 'Field 1', value: 'Follow-up', confidence: 0.95 },
        { name: 'Field 2', value: 'Earlier request', confidence: 0.88 },
      ],
    },
  };
}
