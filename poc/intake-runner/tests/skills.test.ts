// Tests for the executable Intake skill definitions and the SKILL.md files that mirror them.
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { INTAKE_SKILLS, INTAKE_SKILL_NAMES, parseSkillMd, validateSkillDefinition, validateSkillMd } from '../src/skills.ts';

const skillsDir = new URL('../../../agents/intake/skills/', import.meta.url);
const agentMd = readFileSync(new URL('../../../agents/intake/AGENT.md', import.meta.url), 'utf8');
const readSkill = (name: string) => readFileSync(new URL(`${name}/SKILL.md`, skillsDir), 'utf8');

test('definitions: the four Intake skills exist, are valid, and keep the founder-fixed names', () => {
  assert.deepEqual(Object.keys(INTAKE_SKILLS).sort(), [...INTAKE_SKILL_NAMES].sort());
  for (const [key, def] of Object.entries(INTAKE_SKILLS)) {
    assert.equal(def.name, key);
    assert.deepEqual(validateSkillDefinition(def, key), [], `definition ${key}`);
    assert.equal(def.agent, 'intake');
    assert.equal(def.permissions.personal_data, 'masked-only');
    assert.equal(def.side_effects, 'none');
  }
});

test('definitions: only the two model skills may call the model gateway, each for its own task', () => {
  const callers = Object.values(INTAKE_SKILLS).filter((d) => d.tools.includes('model-gateway')).map((d) => `${d.name}:${d.model_task}`);
  assert.deepEqual(callers.sort(), ['classify-request:classify_request', 'extract-fields:extract_fields']);
  for (const name of ['validate-completeness', 'create-work-item']) {
    assert.deepEqual(INTAKE_SKILLS[name].tools, []);
    assert.equal(INTAKE_SKILLS[name].model_task, null);
    assert.equal(INTAKE_SKILLS[name].permissions.network, 'none');
  }
});

test('definitions: the validator rejects inconsistent or unsafe definitions', () => {
  const clone = () => structuredClone(INTAKE_SKILLS['classify-request']) as unknown as Record<string, unknown>;
  const cases: Array<[string, (d: Record<string, unknown>) => void]> = [
    ['bad name', (d) => { d.name = 'Classify Request'; }],
    ['unknown tool', (d) => { d.tools = ['shell']; }],
    ['model tool without task', (d) => { d.model_task = null; }],
    ['task without model tool', (d) => { d.tools = []; }],
    ['personal data not masked-only', (d) => { (d.permissions as Record<string, unknown>).personal_data = 'raw'; }],
    ['network mismatch', (d) => { (d.permissions as Record<string, unknown>).network = 'none'; }],
    ['side effects', (d) => { d.side_effects = 'writes'; }],
    ['not idempotent', (d) => { d.idempotent = false; }],
    ['wrong agent', (d) => { d.agent = 'processing'; }],
    ['long description', (d) => { d.description = 'x'.repeat(1025); }],
  ];
  for (const [name, mutate] of cases) {
    const d = clone(); mutate(d);
    assert.ok(validateSkillDefinition(d).length > 0, `should reject: ${name}`);
  }
  assert.ok(validateSkillDefinition('text').length > 0);
});

test('files: every skill has a SKILL.md that is spec-clean and matches its definition', () => {
  const folders = readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.deepEqual(folders, [...INTAKE_SKILL_NAMES].sort(), 'skill folders are exactly the defined skills');
  for (const name of INTAKE_SKILL_NAMES) {
    assert.deepEqual(validateSkillMd(readSkill(name), INTAKE_SKILLS[name], name), [], `SKILL.md for ${name}`);
  }
});

test('files: AGENT.md lists exactly the defined skills', () => {
  const m = /^skills:\s*\[([^\]]*)\]/m.exec(agentMd);
  assert.ok(m, 'AGENT.md has a skills list');
  const listed = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(listed, [...INTAKE_SKILL_NAMES]);
  assert.ok(/^name: intake$/m.test(agentMd), 'founder-fixed agent name');
});

test('files: the SKILL.md validator rejects unsafe or mismatched files', () => {
  const good = readSkill('classify-request');
  const def = INTAKE_SKILLS['classify-request'];
  const bad: Array<[string, string]> = [
    ['unknown frontmatter key', good.replace('metadata:', 'allowed-tools: shell\nmetadata:')],
    ['name differs', good.replace('name: classify-request', 'name: classify')],
    ['description differs', good.replace('Chooses one', 'Picks one')],
    ['missing section', good.replace('## Do not', '## Avoid')],
    ['no frontmatter', good.replace(/^---\n/, '')],
    ['unclosed frontmatter', good.replace(/\n---\n/, '\n')],
    ['wrong agent', good.replace('agent: "intake"', 'agent: "processing"')],
  ];
  for (const [name, text] of bad) assert.ok(validateSkillMd(text, def, 'classify-request').length > 0, `should reject: ${name}`);
  assert.ok(validateSkillMd(good, def, 'other-folder').length > 0, 'folder name must match');
  assert.ok('error' in parseSkillMd('plain text'));
});
