// first-clean.ts: how a short answer to "is this your first cleaning with us?" is read, and which answers can stand without the question having been asked.
// Pure functions, invented phrasings only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isBareAnswer, parseFirstClean } from '../src/first-clean.ts';

test('parse: plain yes, first-time wording and polite or filler-led forms are true', () => {
  for (const v of ['yes', 'Yes.', 'yeah', 'yep', 'Yes, it is', 'yes please', 'Yes, thank you', 'my first cleaning', 'This is my first cleaning with you', "it's my first", 'first time', 'First cleaning with us',
    'Yes, my first cleaning', 'yes it is my first time with you', 'Sorry, yes', 'Actually, it is my first', 'well yes', 'our first cleaning with Drew Cleaning']) assert.equal(parseFirstClean(v), true, v);
});

test('parse: plain no, not-first wording and corrections are false', () => {
  for (const v of ['no', 'Nope.', 'No, it is not', 'no thanks', 'not my first', "It's not my first cleaning", 'No, not my first', 'Actually, it is not my first', 'sorry, no', 'second time', 'third cleaning',
    'we have used you before', 'a returning customer']) assert.equal(parseFirstClean(v), false, v);
});

test('parse: everything else is unknown, however plausible: hedges, mixed answers, questions, other yes/no answers, long text, wrong types', () => {
  for (const v of ['maybe', 'I think so', 'not sure', 'I am not really sure', 'I am not sure if it is my first', 'probably', 'I guess', 'it depends', 'yes but I used another company', 'yes and no', 'no wait yes',
    'yes it is empty', 'no extras', 'yes we have a dog', 'is it my first?', 'first and second', 'used you before', '', '   ', 'x'.repeat(81)]) assert.equal(parseFirstClean(v), null, JSON.stringify(v));
  for (const v of [undefined, null, 5, {}, ['yes'], true]) assert.equal(parseFirstClean(v as never), null);
});

test('bare: only a plain yes or no is bare; explicit first-time wording is not, so it can stand wherever it was said', () => {
  for (const v of ['yes', 'No.', 'yeah', 'nope', 'Yes, it is', 'yes please', 'Actually no', 'Sorry, yes']) assert.equal(isBareAnswer(v), true, v);
  for (const v of ['my first cleaning', 'not my first', 'Yes, my first cleaning', 'No, not my first', 'second time', 'first time', 'a returning customer', 'maybe', 'yes but', 'yes it is empty', '', 'x'.repeat(81)]) assert.equal(isBareAnswer(v), false, JSON.stringify(v));
  for (const v of [undefined, null, 7, {}]) assert.equal(isBareAnswer(v as never), false);
});

test('consistency: an answer is never both bare and explicit, and a bare answer is never read as anything but yes or no', () => {
  for (const v of ['yes', 'no', 'yeah please', 'nope', 'my first', 'not my first', 'first time', 'second time', 'maybe']) {
    const r = parseFirstClean(v);
    if (isBareAnswer(v)) assert.ok(r === true || r === false, v);
  }
});

test('purity: no imports, no clock, no randomness, no I/O', () => {
  const src = readFileSync(new URL('../src/first-clean.ts', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/^\s*import\s/m.test(code));
  for (const banned of ['fetch(', 'Date.now', 'Math.random', 'process.', 'readFileSync']) assert.ok(!code.includes(banned), banned);
});
