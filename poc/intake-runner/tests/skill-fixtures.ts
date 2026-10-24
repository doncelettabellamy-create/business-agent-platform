// Synthetic fixtures for the classify-extract skill tests. All configuration is invented and generic:
// category and field names are placeholders, and the keywords and labels are made-up words, not industry rules.
import type { IntakeInput } from '../src/intake-runner.ts';
import type { SkillConfig } from '../src/classify-extract.ts';

export function skillConfig(): SkillConfig {
  return {
    categories: [
      { name: 'Category A', keywords: ['alpha', 'follow up', 'earlier request'] },
      { name: 'Category B', keywords: ['bravo', 'quote', 'option b'] },
      { name: 'Category C', keywords: ['charlie', 'call back'] },
    ],
    fields: [
      { name: 'Field 1', required: true, extractor: { kind: 'label', labels: ['topic', 'subject'] } },
      { name: 'Field 2', required: true, extractor: { kind: 'token', token_type: 'ID' } },
      { name: 'Field 3', required: false, extractor: { kind: 'label', labels: ['note'] } },
    ],
  };
}

/** A valid skill-mode input whose text clearly matches Category A and contains both required fields. */
export function skillInput(): IntakeInput {
  return {
    workspace_id: 'ws-synthetic-a',
    correlation_id: 'corr-synthetic-0100',
    event_id: 'evt-synthetic-0100',
    received_at: '2026-10-24T10:00:00Z',
    channel_ref: 'channel-tbd',
    masking: { applied: true, source: 'synthetic-fixture' },
    masked_text: 'Hello from [PERSON_1]. I want to follow up on my earlier request.\nTopic: Change of details\nReference: [ID_1]. SENTINEL-SKILL-TEXT-5512',
    pii_summary: [{ type: 'Person', count: 1 }, { type: 'Identifier', count: 1 }],
    skill_config: skillConfig(),
  };
}
