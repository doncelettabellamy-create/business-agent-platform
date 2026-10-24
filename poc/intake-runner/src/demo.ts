// Synthetic demonstration of the model-ready Intake runner using ONLY the local scripted mock provider.
// No API key, no network, no real model, no customer data. Run: node src/demo.ts
import { runIntake, runIntakeWithModel } from './intake-runner.ts';
import type { IntakeInput, RunResult } from './intake-runner.ts';
import { classifyAnswer, createMockProvider, extractAnswer, hangs } from './mock-provider.ts';

function input(): IntakeInput {
  return {
    workspace_id: 'ws-synthetic-a',
    correlation_id: 'corr-demo-0001',
    event_id: 'evt-demo-0001',
    received_at: '2026-10-24T11:00:00Z',
    channel_ref: 'channel-tbd',
    masking: { applied: true, source: 'synthetic-fixture' },
    masked_text: 'Hello from [PERSON_1]. We would like a quote for option B.\nTopic: Quote request\nReference: [ID_1]',
    pii_summary: [{ type: 'Person', count: 1 }, { type: 'Identifier', count: 1 }],
    skill_config: {
      categories: [
        { name: 'Category A', keywords: ['alpha', 'follow up'] },
        { name: 'Category B', keywords: ['bravo', 'quote', 'option b'] },
      ],
      fields: [
        { name: 'Field 1', required: true, extractor: { kind: 'label', labels: ['topic'] } },
        { name: 'Field 2', required: true, extractor: { kind: 'token', token_type: 'ID' } },
      ],
    },
  };
}

function show(title: string, r: RunResult): void {
  console.log(`\n== ${title}`);
  if (!r.ok) { console.log(`   refused: ${r.error.code}`); return; }
  const w = r.workItem;
  console.log(`   outcome : ${r.outcome}${r.handoff ? ' (handoff envelope created for Processing)' : ' (no envelope; waits for a person)'}`);
  console.log(`   category: ${w.category}   status: ${w.status}   reasons: [${w.reasons.join(', ')}]`);
  console.log(`   fields  : ${w.fields.map((f) => `${f.name}=${f.found ? f.value : 'not found'}`).join('; ')}`);
  console.log(`   model   : ${w.versions.model}`);
  if (r.trace) for (const t of r.trace) console.log(`   trace   : ${t.skill} -> ${t.source}${t.failure ? ` (${t.failure})` : ''}`);
}

const good = () => createMockProvider({
  classify_request: () => classifyAnswer('Category B', 0.9),
  extract_fields: () => extractAnswer([
    { name: 'Field 1', value: 'Quote request', confidence: 0.92 },
    { name: 'Field 2', value: '[ID_1]', confidence: 0.97 },
  ]),
});

console.log('Synthetic Intake demonstration. Local mock provider only: no key, no network, no real model.');

show('1. Deterministic runner only (the fallback path, no model involved)', runIntake(input()));
show('2. Model path, mock answers well', await runIntakeWithModel(input(), { provider: good() }));
show('3. Model path, mock invents a value that is not in the text -> rejected, sent to a person',
  await runIntakeWithModel(input(), { provider: createMockProvider({
    classify_request: () => classifyAnswer('Category B', 0.9),
    extract_fields: () => extractAnswer([{ name: 'Field 1', value: 'Totally invented answer', confidence: 0.99 }]),
  }) }));
show('4. Model path, mock returns text that is not JSON -> rejected, sent to a person',
  await runIntakeWithModel(input(), { provider: createMockProvider({
    classify_request: () => 'Sure! The category is B.',
    extract_fields: () => extractAnswer([{ name: 'Field 1', value: 'Quote request', confidence: 0.9 }, { name: 'Field 2', value: '[ID_1]', confidence: 0.9 }]),
  }) }));
show('5. Model path, mock never answers (timeout 50 ms) -> deterministic suggestions only, sent to a person',
  await runIntakeWithModel(input(), { provider: createMockProvider({ classify_request: hangs, extract_fields: hangs }), timeoutMs: 50 }));
show('6. Same failure with the old fallback "deterministic" setting -> setting is ignored, still sent to a person',
  await runIntakeWithModel(input(), { provider: createMockProvider({ classify_request: hangs, extract_fields: hangs }), timeoutMs: 50, fallback: 'deterministic' }));
const missing = input() as unknown as Record<string, unknown>; delete missing.workspace_id;
show('7. Missing tenant -> refused before any model is called', await runIntakeWithModel(missing, { provider: good() }));
