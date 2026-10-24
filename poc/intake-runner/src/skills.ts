// Executable definitions of the four Intake skills (proof of concept).
//
// These definitions are what the runtime ENFORCES: the model gateway refuses any call from a skill whose tools
// do not include "model-gateway" or whose model_task differs from the request. The SKILL.md files under
// agents/intake/skills/ are the human-readable, spec-clean counterpart; tests check that the two agree.
//
// The sidecar file format is still undecided (D-07), so these TypeScript definitions are the provisional sidecar.
// Skill names are placeholders until the vertical is decided (D-01). Nothing here is approved.

import type { ModelTask } from './model-gateway.ts';
import { isNonEmptyString, isRecord } from './contracts.ts';

export interface SkillDefinition {
  name: string;
  version: string;
  description: string;
  agent: 'intake';
  input_contract: string;
  output_contract: string;
  /** Enforced allow-list. "model-gateway" is the only tool any Intake skill may use in this PoC. */
  tools: string[];
  /** The one model task this skill may request; null means the skill never calls a model. */
  model_task: ModelTask | null;
  permissions: {
    reads: string[];
    writes: string[];
    personal_data: 'masked-only';
    network: 'none' | 'model-gateway-only';
  };
  tier: 'Auto' | 'Assisted';
  side_effects: 'none';
  idempotent: true;
}

export const INTAKE_SKILLS: Record<string, SkillDefinition> = {
  'classify-request': {
    name: 'classify-request',
    version: '0.1.0-draft',
    description: 'Chooses one configured category for an already-masked request, or reports that none fits or the choice is unclear. Use when a masked inbound request needs a category before extraction.',
    agent: 'intake',
    input_contract: 'intake-input.poc',
    output_contract: 'classify-output.poc',
    tools: ['model-gateway'],
    model_task: 'classify_request',
    permissions: { reads: ['masked_text', 'category_names'], writes: [], personal_data: 'masked-only', network: 'model-gateway-only' },
    tier: 'Auto',
    side_effects: 'none',
    idempotent: true,
  },
  'extract-fields': {
    name: 'extract-fields',
    version: '0.1.0-draft',
    description: 'Copies the values of configured fields out of an already-masked request, or reports them as not found. Use after a category is known and structured fields are needed.',
    agent: 'intake',
    input_contract: 'intake-input.poc',
    output_contract: 'extract-output.poc',
    tools: ['model-gateway'],
    model_task: 'extract_fields',
    permissions: { reads: ['masked_text', 'field_names'], writes: [], personal_data: 'masked-only', network: 'model-gateway-only' },
    tier: 'Auto',
    side_effects: 'none',
    idempotent: true,
  },
  'validate-completeness': {
    name: 'validate-completeness',
    version: '0.1.0-draft',
    description: 'Checks required fields, category, and confidence against the configured rules and decides whether an item is ready or needs a person. Use after classification and extraction.',
    agent: 'intake',
    input_contract: 'classify-output.poc+extract-output.poc',
    output_contract: 'work_item.v1',
    tools: [],
    model_task: null,
    permissions: { reads: ['category', 'fields', 'required_fields'], writes: [], personal_data: 'masked-only', network: 'none' },
    tier: 'Auto',
    side_effects: 'none',
    idempotent: true,
  },
  'create-work-item': {
    name: 'create-work-item',
    version: '0.1.0-draft',
    description: 'Builds a validated work_item.v1 and, for ready items only, a handoff envelope for Processing. Use as the last Intake step.',
    agent: 'intake',
    input_contract: 'work_item.v1',
    output_contract: 'handoff-envelope.v1',
    tools: [],
    model_task: null,
    permissions: { reads: ['work_item'], writes: ['work_item (in memory only in this PoC)'], personal_data: 'masked-only', network: 'none' },
    tier: 'Assisted',
    side_effects: 'none',
    idempotent: true,
  },
};

export const INTAKE_SKILL_NAMES = ['classify-request', 'extract-fields', 'validate-completeness', 'create-work-item'] as const;

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const KNOWN_TOOLS = ['model-gateway'];

/** Checks a definition for internal consistency. Returns problems; an empty list means valid. */
export function validateSkillDefinition(d: unknown, path = 'skill'): string[] {
  const errors: string[] = [];
  if (!isRecord(d)) return [`${path}: expected object`];
  if (typeof d.name !== 'string' || !NAME.test(d.name) || d.name.length > 64) errors.push(`${path}.name: expected lowercase hyphenated name up to 64 characters`);
  if (!isNonEmptyString(d.version)) errors.push(`${path}.version: expected non-empty string`);
  if (!isNonEmptyString(d.description) || d.description.length > 1024) errors.push(`${path}.description: expected 1 to 1024 characters`);
  if (d.agent !== 'intake') errors.push(`${path}.agent: expected intake`);
  if (!isNonEmptyString(d.input_contract)) errors.push(`${path}.input_contract: expected non-empty string`);
  if (!isNonEmptyString(d.output_contract)) errors.push(`${path}.output_contract: expected non-empty string`);
  if (!Array.isArray(d.tools) || d.tools.some((t: unknown) => typeof t !== 'string' || !KNOWN_TOOLS.includes(t))) errors.push(`${path}.tools: only known tools are allowed`);
  const usesModel = Array.isArray(d.tools) && d.tools.includes('model-gateway');
  if (usesModel && d.model_task === null) errors.push(`${path}.model_task: required when the model-gateway tool is allowed`);
  if (!usesModel && d.model_task !== null) errors.push(`${path}.model_task: must be null without the model-gateway tool`);
  if (isRecord(d.permissions)) {
    if (d.permissions.personal_data !== 'masked-only') errors.push(`${path}.permissions.personal_data: must be masked-only`);
    const wantsNetwork = d.permissions.network === 'model-gateway-only';
    if (wantsNetwork !== usesModel) errors.push(`${path}.permissions.network: must match the model-gateway tool`);
    if (!Array.isArray(d.permissions.reads) || !Array.isArray(d.permissions.writes)) errors.push(`${path}.permissions: reads and writes must be arrays`);
  } else errors.push(`${path}.permissions: expected object`);
  if (d.tier !== 'Auto' && d.tier !== 'Assisted') errors.push(`${path}.tier: expected Auto or Assisted`);
  if (d.side_effects !== 'none') errors.push(`${path}.side_effects: this PoC allows none`);
  if (d.idempotent !== true) errors.push(`${path}.idempotent: must be true`);
  return errors;
}

// ---------------------------------------------------------------- SKILL.md (Agent Skills format, spec-clean)
export interface SkillMdParts { frontmatter: Record<string, unknown>; body: string }

/** Minimal frontmatter reader for the subset we use: top-level "key: value" plus one nested string map. */
export function parseSkillMd(text: string): SkillMdParts | { error: string } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '---') return { error: 'frontmatter must start with ---' };
  const end = lines.indexOf('---', 1);
  if (end === -1) return { error: 'frontmatter is not closed' };
  const fm: Record<string, unknown> = {};
  let nested: Record<string, string> | null = null;
  for (const line of lines.slice(1, end)) {
    if (line.trim() === '') continue;
    const top = /^([A-Za-z][A-Za-z0-9_-]*):[ ]*(.*)$/.exec(line);
    const sub = /^[ ]{2}([A-Za-z][A-Za-z0-9_-]*):[ ]*(.*)$/.exec(line);
    if (top) {
      if (top[2] === '') { nested = {}; fm[top[1]] = nested; }
      else { nested = null; fm[top[1]] = unquote(top[2]); }
    } else if (sub && nested) {
      nested[sub[1]] = unquote(sub[2]);
    } else return { error: 'unsupported frontmatter line' };
  }
  return { frontmatter: fm, body: lines.slice(end + 1).join('\n') };
}
function unquote(v: string): string {
  const t = v.trim();
  return t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) ? t.slice(1, -1) : t;
}

const ALLOWED_FRONTMATTER = ['name', 'description', 'license', 'compatibility', 'metadata'];
const REQUIRED_SECTIONS = ['## When to use', '## Procedure', '## Failure modes', '## Do not'];

/** Checks one SKILL.md against the Agent Skills rules we adopted and against its executable definition. */
export function validateSkillMd(text: string, def: SkillDefinition, folderName: string): string[] {
  const errors: string[] = [];
  const parsed = parseSkillMd(text);
  if ('error' in parsed) return [`SKILL.md: ${parsed.error}`];
  const fm = parsed.frontmatter;
  for (const k of Object.keys(fm)) if (!ALLOWED_FRONTMATTER.includes(k)) errors.push('SKILL.md: unexpected frontmatter key');
  if (fm.name !== def.name) errors.push('SKILL.md: name must equal the definition name');
  if (fm.name !== folderName) errors.push('SKILL.md: name must equal the folder name');
  if (fm.description !== def.description) errors.push('SKILL.md: description must equal the definition description');
  if (typeof fm.description === 'string' && fm.description.length > 1024) errors.push('SKILL.md: description too long');
  const meta = fm.metadata;
  if (!isRecord(meta) || meta.agent !== 'intake') errors.push('SKILL.md: metadata.agent must be intake');
  const bodyLines = parsed.body.split('\n').length;
  if (bodyLines > 500) errors.push('SKILL.md: body longer than 500 lines');
  for (const s of REQUIRED_SECTIONS) if (!parsed.body.includes(s)) errors.push(`SKILL.md: missing section ${s}`);
  return errors;
}
