// property-choice.ts: whether a caller's words for the property type are one of the configured choices. Pure; invented words only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPropertyAnswer, propertyMentions, propertyChoiceOf } from '../src/property-choice.ts';

const CHOICES = ['house', 'apartment', 'condo', 'townhouse'];
const kind = (v: string) => classifyPropertyAnswer(v, CHOICES);

test('a single supported choice, in the caller\'s words, is a choice (case, plural and extra words do not matter)', () => {
  for (const v of ['house', 'House.', 'a nice house', 'Houses', 'my townhouse', 'townhouse', 'an apartment building', 'a different apartment', 'no pets, a house', 'It is a condo']) assert.equal(kind(v), 'choice', v);
});

test('a value that is not a configured choice is none: nothing is guessed (Health is not house, residential is not house, condominium is not condo)', () => {
  for (const v of ['Health.', 'residential', 'bungalow', 'condominium', 'duplex', 'a studio', 'office', '', '   ']) assert.equal(kind(v), 'none', JSON.stringify(v));
  assert.equal(classifyPropertyAnswer('house', undefined), 'none', 'no configured choices means nothing is a choice');
  assert.equal(classifyPropertyAnswer(42 as never, CHOICES), 'none');
});

test('a negated choice is never accepted', () => {
  for (const v of ['not a house', 'no house', "it isn't a house", "it isn’t a house", 'it is not really a house', 'never a house', 'without a house', 'it is a house, not an apartment', 'not an apartment but a condo']) assert.equal(kind(v), 'negated', v);
});

test('two different choices are not an unambiguous answer', () => {
  for (const v of ['house or apartment', 'a condo or a townhouse', 'house, apartment']) assert.equal(kind(v), 'multi', v);
});

test('a choice inside another word is not a match ("townhouse" is the townhouse choice, not the house choice)', () => {
  assert.equal(classifyPropertyAnswer('townhouse', ['house']), 'none');
  assert.equal(classifyPropertyAnswer('a lighthouse', ['house']), 'none');
  assert.equal(classifyPropertyAnswer('house', ['house', 'townhouse']), 'choice');
});

test('propertyMentions: which configured choices a line affirms and which it negates; an unrelated, un-negated mention affirms its own choice only', () => {
  assert.deepEqual(propertyMentions('this is not a house', CHOICES), { affirmed: [], negated: ['house'] });
  assert.deepEqual(propertyMentions('no pets, and it is not a house', CHOICES), { affirmed: [], negated: ['house'] });
  assert.deepEqual(propertyMentions('it is not a house, it is an apartment', CHOICES), { affirmed: ['apartment'], negated: ['house'] });
  assert.deepEqual(propertyMentions('my sister has an apartment', CHOICES), { affirmed: ['apartment'], negated: [] });
  assert.deepEqual(propertyMentions('Health.', CHOICES), { affirmed: [], negated: [] });
  assert.deepEqual(propertyMentions('', CHOICES), { affirmed: [], negated: [] });
});

test('propertyChoiceOf: the one affirmed choice, only for an unambiguous answer', () => {
  assert.equal(propertyChoiceOf('it is an apartment', CHOICES), 'apartment');
  assert.equal(propertyChoiceOf('Houses', CHOICES), 'house');
  for (const v of ['not a house', 'house or apartment', 'Health.', 'my sister has an apartment but we have a house']) assert.equal(propertyChoiceOf(v, CHOICES), undefined, v);
});
