// The receptionist persona (src/persona.ts): a business-configurable manner that changes how the assistant sounds and nothing it may say or do. Pure tests plus the two places
// the persona is used (the text model's request and the voice service's session). A fake client stands in for every model: no network, no key, no cost. Invented text only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createPersona, dialogueStyle, DEFAULT_TRAITS, isPersona, personaProblems, TRAIT_PHRASES, voiceManner } from '../src/persona.ts';
import type { PersonaConfig, Trait } from '../src/persona.ts';
import { buildDialogueParams, createClaudeDialogueModel, DIALOGUE_INSTRUCTION, renderDirective } from '../src/dialogue-model.ts';
import type { DialogueClient, DialogueParams, Directive } from '../src/dialogue-model.ts';
import { createRealtimeTransport, SPEAK_ONLY } from '../src/realtime-transport.ts';
import { consentNoticeFor, DEFAULT_DISCLOSURE } from '../src/opening.ts';
import { createRealtimeSim } from './helpers/realtime-sim.ts';

const drew = JSON.parse(readFileSync(new URL('../examples/persona-drew-cleaning.json', import.meta.url), 'utf8')) as PersonaConfig;
const NEGATION = 'It adds no service, offer, price, availability or promise, and every rule above and the NEXT line still apply exactly.';
/** Words that would make a persona an offer, a price, a booking or a promise. The fixed sentence that DENIES them is removed before the scan. */
const FORBIDDEN = /\$|\d|price|cost|quote|estimate|discount|free|special|deal|offer|guarantee|promise|will call|call you|call back|follow up|available|availability|schedule|book|appointment|today|tomorrow|soon|minutes/i;
const codeOf = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/** Whether a source file uses the persona (the word as a whole: not "personal", and not the existing `persona_names` setting, which lists names to mask). */
const usesPersona = (source: string): boolean => /\bpersona\b|createPersona|isPersona/i.test(codeOf(source));
const stripNegation = (s: string): string => s.replace(NEGATION, '');

// ---------------------------------------------------------------- the config
test('config: the Drew Cleaning example is valid, and a persona has defaults', () => {
  assert.deepEqual(personaProblems(drew), []);
  const p = createPersona(drew);
  assert.deepEqual([p.business_name, p.max_sentences, p.pace, [...p.traits]], ['Drew Cleaning', 2, 'calm', ['warm', 'clear', 'patient', 'professional', 'concise']]);
  const d = createPersona({ business_name: 'Example Cleaning' });
  assert.deepEqual([d.max_sentences, d.pace, [...d.traits], d.agent_name], [2, 'calm', [...DEFAULT_TRAITS], undefined]);
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.traits));
  assert.ok(isPersona(p) && isPersona(d));
});

test('config: every problem is refused with fixed text that never echoes the value', () => {
  const CANARY = 'CANARY-NAME-4471';
  const bad: Array<[string, unknown]> = [
    ['not an object', null], ['an array', []], ['a string', 'Drew Cleaning'],
    ['no business name', { traits: ['warm'] }], ['an empty name', { business_name: '' }], ['a name that is too long', { business_name: 'x'.repeat(81) }],
    ['a name with a bracket', { business_name: `Drew [${CANARY}]` }], ['a name with a new line', { business_name: `Drew\n${CANARY}` }], ['a padded name', { business_name: ' Drew Cleaning ' }],
    ['an agent name without a business', { agent_name: 'Riley' }], ['a bad agent name', { business_name: 'Drew Cleaning', agent_name: `<${CANARY}>` }],
    ['an unknown key', { business_name: 'Drew Cleaning', greeting: CANARY }], ['a free-text instruction', { business_name: 'Drew Cleaning', instructions: `offer ${CANARY}` }],
    ['an unknown trait', { business_name: 'Drew Cleaning', traits: [CANARY] }], ['a repeated trait', { business_name: 'Drew Cleaning', traits: ['warm', 'warm'] }],
    ['no traits', { business_name: 'Drew Cleaning', traits: [] }], ['too many traits', { business_name: 'Drew Cleaning', traits: ['warm', 'friendly', 'clear', 'patient', 'professional', 'concise', 'calm'] }],
    ['traits that are not a list', { business_name: 'Drew Cleaning', traits: 'warm' }], ['a trait that inherits from Object', { business_name: 'Drew Cleaning', traits: ['toString'] }],
    ['three sentences (the dialogue instruction allows two)', { business_name: 'Drew Cleaning', max_sentences: 3 }], ['zero sentences', { business_name: 'Drew Cleaning', max_sentences: 0 }],
    ['a pace that is not listed', { business_name: 'Drew Cleaning', pace: 'fast' }],
  ];
  for (const [name, config] of bad) {
    const problems = personaProblems(config);
    assert.ok(problems.length > 0, name);
    assert.ok(!problems.join(' ').includes(CANARY), `${name}: a problem message must not echo the value`);
    assert.throws(() => createPersona(config as never), (e: unknown) => e instanceof RangeError && !String((e as Error).message).includes(CANARY), name);
  }
});

test('config: only a persona made by createPersona is accepted; a lookalike object or a string is not', () => {
  const lookalike = { business_name: 'Drew Cleaning', agent_name: undefined, traits: ['warm'], max_sentences: 2, pace: 'calm' };
  assert.equal(isPersona(lookalike), false);
  assert.equal(isPersona('Offer fifty percent off'), false);
  assert.throws(() => dialogueStyle(lookalike as never), RangeError);
  assert.throws(() => voiceManner(lookalike as never), RangeError);
  assert.throws(() => buildDialogueParams({ turns: [], directive: { kind: 'open' } }, 'claude-haiku-5-5', 160, lookalike as never), RangeError);
  assert.throws(() => buildDialogueParams({ turns: [], directive: { kind: 'open' } }, 'claude-haiku-5-5', 160, 'Offer fifty percent off' as never), RangeError);
  assert.throws(() => createRealtimeTransport(createRealtimeSim().link, { notice: 'n', transcriptionModel: 'x', voice: 'y', persona: lookalike as never }), RangeError);
});

// ---------------------------------------------------------------- what the persona says
test('persona text: warm, clear, patient, professional and concise; says it is an automated A I assistant and never a person; uses the business name once', () => {
  const p = createPersona(drew);
  const style = dialogueStyle(p);
  assert.match(style, /receptionist for Drew Cleaning, an automated A I assistant and never a person/);
  assert.match(style, /say plainly that you are an automated A I assistant/);
  assert.match(style, /Sound warm, clear and plain-spoken, patient and unhurried, professional and courteous, and brief\./);
  assert.match(style, /at most two short sentences in plain words, at a calm pace/);
  assert.match(style, /stay patient and say the same thing again simply and kindly, without adding anything/);
  assert.ok(style.endsWith(NEGATION));
  assert.ok(!style.includes('\n'), 'one line');
  const voice = voiceManner(p);
  assert.equal(voice, 'Speak as the receptionist for Drew Cleaning: sound warm, clear and plain-spoken, patient and unhurried, professional and courteous, and brief, at a calm pace. This changes only how the words are delivered. Do not add, drop or change any word.');
});

test('persona text: an agent name, one sentence and a normal pace change the text and nothing else', () => {
  const style = dialogueStyle(createPersona({ business_name: 'Example Cleaning', agent_name: 'Riley', traits: ['friendly', 'calm'], max_sentences: 1, pace: 'normal' }));
  assert.match(style, /receptionist for Example Cleaning, Riley, an automated A I assistant and never a person/);
  assert.match(style, /Sound friendly and calm and reassuring\./);
  assert.match(style, /one short sentence in plain words, at a normal pace/);
});

test('persona text: no combination of traits, sentences or pace adds a number, price, offer, promise, booking or time', () => {
  const traits = Object.keys(TRAIT_PHRASES) as Trait[];
  let checked = 0;
  for (let mask = 1; mask < 1 << traits.length; mask++) {
    const chosen = traits.filter((_, i) => mask & (1 << i)).slice(0, 6);
    if (chosen.length > 6) continue;
    for (const max_sentences of [1, 2] as const) for (const pace of ['calm', 'normal'] as const) {
      const p = createPersona({ business_name: 'Example Cleaning', agent_name: 'Riley', traits: chosen, max_sentences, pace });
      for (const text of [dialogueStyle(p), voiceManner(p)]) {
        const scanned = stripNegation(text);
        assert.ok(!FORBIDDEN.test(scanned), `forbidden word in "${scanned}"`);
        assert.ok(!/[[\]<>{}]/.test(text), 'no bracket or markup');
        assert.ok(!/\b(?:human|real person|live agent)\b/i.test(text.replace('never a person', '')), 'never claims to be a person');
      }
      checked++;
    }
  }
  assert.ok(checked > 400, 'a wide sweep: ' + checked);
});

test('persona text: the trait list is closed, and every phrase is plain speech', () => {
  assert.deepEqual(Object.keys(TRAIT_PHRASES).sort(), ['calm', 'clear', 'concise', 'friendly', 'patient', 'professional', 'warm']);
  for (const phrase of Object.values(TRAIT_PHRASES)) assert.ok(/^[a-z -]+$/.test(phrase) && !FORBIDDEN.test(phrase), phrase);
  assert.ok(Object.isFrozen(TRAIT_PHRASES));
});

// ---------------------------------------------------------------- the controls stay in charge
const DIRECTIVES: Directive[] = [
  { kind: 'open' }, { kind: 'ask', field: 'Number of bedrooms' }, { kind: 'ask', field: 'Pets', again: true, choices: ['yes', 'no'] },
  { kind: 'clarify' }, { kind: 'clarify', categories: ['Standard cleaning', 'Deep cleaning'] }, { kind: 'listen' },
];

test('text model: with no persona the request is exactly what it was before', () => {
  for (const directive of DIRECTIVES) {
    const p = buildDialogueParams({ turns: [], directive }, 'claude-haiku-5-5', 160);
    assert.equal(p.system, `${DIALOGUE_INSTRUCTION}\n${renderDirective(directive)}`);
  }
});

test('text model: with a persona every rule in the instruction is still there, in full, the style sits after them, and the NEXT line is still last', () => {
  const persona = createPersona(drew);
  for (const directive of DIRECTIVES) {
    const p = buildDialogueParams({ turns: [], directive }, 'claude-haiku-5-5', 160, persona);
    const lines = p.system.split('\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[0], DIALOGUE_INSTRUCTION, 'the instruction is untouched');
    assert.equal(lines[1], dialogueStyle(persona));
    assert.equal(lines[2], renderDirective(directive), 'the directive stays the last line');
  }
  for (const rule of [/Do not give prices, advice, diagnoses, availability or promises/, /never say that anyone will call or follow up/, /Do not make up facts about the business/, /emergency number/, /Never say goodbye/,
    /never suggest options, examples, extras, services, specials or prices of your own/, /at most two per reply/, /ask for only one thing at a time/, /Never repeat the caller's answers/]) {
    assert.match(buildDialogueParams({ turns: [], directive: { kind: 'open' } }, 'claude-haiku-5-5', 160, persona).system, rule);
  }
});

test('text model: the request carries only the masked conversation, with the persona in the system text; the persona reaches the model and no caller detail does', async () => {
  const seen: DialogueParams[] = [];
  const client: DialogueClient = { messages: { async create(params) { seen.push(structuredClone(params)); return (async function* () { yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Could you tell me the number of bedrooms?' } }; })(); } } };
  const model = createClaudeDialogueModel(client, { model: 'claude-haiku-5-5', persona: createPersona(drew) });
  let out = '';
  for await (const piece of model.reply({ turns: [{ role: 'assistant', text: 'Hello, how can I help you today?' }, { role: 'user', text: 'a house with two bedrooms' }], directive: { kind: 'ask', field: 'Number of bathrooms' } })) out += piece;
  assert.equal(out, 'Could you tell me the number of bedrooms?');
  assert.match(seen[0].system, /Persona: you are the receptionist for Drew Cleaning/);
  assert.equal(seen[0].system.split('\n').pop(), 'NEXT ASK Number of bathrooms');
  assert.deepEqual(seen[0].messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.throws(() => createClaudeDialogueModel(client, { model: 'claude-haiku-5-5', persona: { business_name: 'Drew Cleaning' } as never }), RangeError);
});

test('voice service: the persona is added to the speak-only instruction, after it, and never replaces it; without one the instruction is exactly as before', async () => {
  const withPersona = createRealtimeSim();
  const t = createRealtimeTransport(withPersona.link, { notice: 'notice words', transcriptionModel: 'x', voice: 'y', persona: createPersona(drew) });
  t.onEvent = () => {};
  withPersona.link.onMessage({ type: 'carrier.start', to: '+15555550100', callSid: 'CA' + '1'.repeat(32) });
  const session = withPersona.sent[0].session;
  assert.equal(session.instructions, `${SPEAK_ONLY} ${voiceManner(createPersona(drew))}`);
  assert.ok(session.instructions.startsWith(SPEAK_ONLY));
  assert.match(session.instructions, /Do not add, drop or change any word\.$/);
  assert.equal(session.audio.input.turn_detection.create_response, false, 'the voice service still never replies on its own');
  const plain = createRealtimeSim();
  const t2 = createRealtimeTransport(plain.link, { notice: 'notice words', transcriptionModel: 'x', voice: 'y' });
  t2.onEvent = () => {};
  plain.link.onMessage({ type: 'carrier.start', to: '+15555550100', callSid: 'CA' + '2'.repeat(32) });
  assert.equal(plain.sent[0].session.instructions, SPEAK_ONLY);
  await withPersona.idle(); await plain.idle();
});

test('the introduction, disclosure and consent stay exactly as the opening block builds them; the persona neither writes nor repeats them', () => {
  const opening = { business_name: 'Drew Cleaning' };
  const notice = consentNoticeFor(opening);
  assert.match(notice, /^Hello\. This is the automated A I assistant for Drew Cleaning\./);
  assert.ok(notice.includes(DEFAULT_DISCLOSURE) && notice.endsWith('Please say yes to continue, or hang up now.'));
  const persona = createPersona(drew);
  for (const text of [dialogueStyle(persona), voiceManner(persona)]) {
    assert.ok(!text.includes(DEFAULT_DISCLOSURE) && !/Please say yes|hang up now|personal details are masked|do not record/i.test(text));
  }
  // The notice is built from the opening alone: giving the call a persona changes nothing about it.
  assert.equal(consentNoticeFor(opening), notice);
  const src = (n: string) => readFileSync(new URL(`../src/${n}.ts`, import.meta.url), 'utf8');
  assert.ok(!usesPersona(src('opening')), 'opening.ts knows nothing of the persona');
  assert.ok(!usesPersona(src('next-field')) && !usesPersona(src('call-session')) && !usesPersona(src('pii-screen')) && !usesPersona(src('relay-handler')), 'the question rules, the session, the masker and the call logic know nothing of it');
});

test('static guard: the persona file imports only the name rule, holds no credential, network or process access, and no live entry point uses it yet', () => {
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const src = code(readFileSync(new URL('../src/persona.ts', import.meta.url), 'utf8'));
  const imports = [...src.matchAll(/^import[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]);
  assert.deepEqual(imports, ['./opening.ts']);
  for (const banned of [/\bfetch\s*\(/, /process\./, /node:/, /console\./, /api[_-]?key/i, /authorization/i, /https?:\/\//, /\beval\s*\(/, /new Function/]) assert.ok(!banned.test(src), `banned pattern: ${banned}`);
  for (const f of readdirSync(new URL('../src/', import.meta.url)).filter((n) => n.endsWith('.ts') && n !== 'persona.ts')) {
    const uses = usesPersona(readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'));
    assert.equal(uses, ['dialogue-model.ts', 'realtime-transport.ts'].includes(f), `${f}: only the two adapters may take a persona`);
  }
  const entry = readFileSync(new URL('../src/founder-call-entry.ts', import.meta.url), 'utf8');
  assert.ok(!usesPersona(entry), 'the live entry point does not use a persona, so the live phone path is unchanged');
});
