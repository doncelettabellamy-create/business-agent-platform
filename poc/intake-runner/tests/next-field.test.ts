// next-field.ts: the pure choice of what happens next on a call. Synthetic data only; no I/O, no clock, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshFrom, selectNext } from '../src/next-field.ts';
import type { AskHistory, Fresh, IntakeResultLike } from '../src/next-field.ts';
import { renderDirective } from '../src/dialogue-model.ts';

const item = (o: Partial<IntakeResultLike> = {}): IntakeResultLike => ({ category: 'Cleaning request', missing_fields: [], status: 'ready', reasons: [], ...o });
const history = (asked: Array<[string, number]> = [], clarified = false): AskHistory => ({ lastAskedAt: new Map(asked), clarified });
const fresh = (o: Partial<Fresh> = {}): Fresh => ({ covers: 3, category: 'Cleaning request', missing: [], ready: false, ...o });

test('freshFrom: only a validated, well-formed result that covers at least one line is fresh', () => {
  assert.deepEqual(freshFrom(item({ missing_fields: ['Rooms'], status: 'needs-human' }), 2), { covers: 2, category: 'Cleaning request', missing: ['Rooms'], ready: false });
  assert.deepEqual(freshFrom(item(), 1), { covers: 1, category: 'Cleaning request', missing: [], ready: true });
  assert.equal(freshFrom(item({ reasons: ['low_confidence', 'model_failed'] }), 2), undefined, 'a result whose model answer failed is not trusted');
  assert.equal(freshFrom(undefined, 2), undefined);
  assert.equal(freshFrom(null as never, 2), undefined);
  assert.equal(freshFrom(item(), 0), undefined);
  assert.equal(freshFrom(item(), 1.5), undefined);
  assert.equal(freshFrom(item({ category: 7 as never }), 1), undefined);
  assert.equal(freshFrom(item({ missing_fields: [1 as never] }), 1), undefined);
  assert.equal(freshFrom(item({ reasons: 'x' as never }), 1), undefined);
});

test('freshFrom: the result is copied, so later changes to the source cannot change the choice', () => {
  const src = item({ missing_fields: ['Rooms'], status: 'needs-human' });
  const f = freshFrom(src, 2) as Fresh;
  (src.missing_fields as string[]).push('Date');
  assert.deepEqual(f.missing, ['Rooms']);
});

test('selectNext: no result, or a result that does not cover every caller line so far, chooses no field', () => {
  assert.deepEqual(selectNext(undefined, 3, history()), { kind: 'listen' });
  assert.deepEqual(selectNext(fresh({ covers: 2, missing: ['Rooms'] }), 3, history()), { kind: 'listen' }, 'stale: one turn behind');
  assert.deepEqual(selectNext(fresh({ covers: 4, missing: ['Rooms'] }), 3, history()), { kind: 'listen' }, 'from the future is as wrong as from the past');
  assert.deepEqual(selectNext(fresh({ covers: 2, ready: true }), 3, history()), { kind: 'listen' }, 'a stale ready is never read back');
});

test('selectNext: ready is ready; an unknown category is clarified (names first, then open words); a recognised category with nothing missing listens', () => {
  assert.deepEqual(selectNext(fresh({ ready: true }), 3, history()), { kind: 'ready' });
  assert.deepEqual(selectNext(fresh({ category: 'unknown' }), 3, history()), { kind: 'clarify', first: true });
  assert.deepEqual(selectNext(fresh({ category: 'unknown' }), 3, history([], true)), { kind: 'clarify', first: false });
  assert.deepEqual(selectNext(fresh({ missing: [] }), 3, history()), { kind: 'listen' });
});

test('selectNext: the least recently asked missing field is asked; never-asked fields come first, ties go in the skill order', () => {
  const missing = ['Rooms', 'Date', 'Window'];
  assert.deepEqual(selectNext(fresh({ missing }), 3, history()), { kind: 'ask', field: 'Rooms', again: false });
  assert.deepEqual(selectNext(fresh({ missing }), 3, history([['Rooms', 2]])), { kind: 'ask', field: 'Date', again: false });
  assert.deepEqual(selectNext(fresh({ missing }), 3, history([['Rooms', 2], ['Date', 3]])), { kind: 'ask', field: 'Window', again: false });
  assert.deepEqual(selectNext(fresh({ covers: 4, missing }), 4, history([['Rooms', 1], ['Date', 2], ['Window', 3]])), { kind: 'ask', field: 'Rooms', again: true });
  assert.deepEqual(selectNext(fresh({ missing: ['Date'] }), 3, history([['Rooms', 1], ['Date', 2]])), { kind: 'ask', field: 'Date', again: true }, 'a lone missing field is asked again, with no counter and no limit');
  assert.deepEqual(selectNext(fresh({ missing: ['Date', 'Window'] }), 3, history([['Date', 2], ['Window', 2]])), { kind: 'ask', field: 'Date', again: true }, 'equal ages keep the skill order');
});

test('selectNext: exhaustively over small cases the field asked is always missing, is never the previous one when another is missing, and the answer is repeatable', () => {
  const names = ['A', 'B', 'C'];
  const subsets: string[][] = [];
  for (let m = 1; m < 8; m++) subsets.push(names.filter((_, i) => (m >> i) & 1));
  let cases = 0;
  for (const missing of subsets) {
    for (let a = -1; a < 4; a++) for (let b = -1; b < 4; b++) for (let c = -1; c < 4; c++) {
      const asked = new Map<string, number>(); [['A', a], ['B', b], ['C', c]].forEach(([k, v]) => { if ((v as number) >= 0) asked.set(k as string, v as number); });
      const before = JSON.stringify([...asked]);
      const h: AskHistory = { lastAskedAt: asked, clarified: false };
      const f = fresh({ missing, covers: 5 });
      const n = selectNext(f, 5, h);
      assert.equal(n.kind, 'ask');
      if (n.kind !== 'ask') continue;
      assert.ok(missing.includes(n.field));
      assert.equal(n.again, asked.has(n.field));
      assert.deepEqual(selectNext(f, 5, h), n);
      assert.equal(JSON.stringify([...asked]), before, 'the history is not changed by choosing');
      assert.deepEqual(f.missing, missing, 'the result is not changed by choosing');
      // The field just asked is at the newest turn; the next choice, with another field missing, must be a different one.
      if (missing.length > 1) {
        const after = new Map(asked); after.set(n.field, 5);
        const m2 = selectNext(fresh({ missing, covers: 6 }), 6, { lastAskedAt: after, clarified: false });
        assert.ok(m2.kind === 'ask' && m2.field !== n.field, `${missing} ${[...asked]}`);
      }
      cases++;
    }
  }
  assert.ok(cases > 400);
});

test('selectNext: with several fields missing and the caller never supplying them, every one of them is asked in turn', () => {
  const missing = ['A', 'B', 'C'];
  const asked = new Map<string, number>(); const order: string[] = [];
  for (let line = 1; line <= 9; line++) {
    const n = selectNext(fresh({ covers: line, missing }), line, { lastAskedAt: asked, clarified: false });
    assert.equal(n.kind, 'ask');
    if (n.kind === 'ask') { asked.set(n.field, line); order.push(n.field); }
  }
  assert.deepEqual(order, ['A', 'B', 'C', 'A', 'B', 'C', 'A', 'B', 'C']);
});

test('renderDirective: one NEXT line from configuration names; a name that could carry instructions is refused', () => {
  assert.equal(renderDirective({ kind: 'open' }), 'NEXT OPEN');
  assert.equal(renderDirective({ kind: 'listen' }), 'NEXT LISTEN');
  assert.equal(renderDirective({ kind: 'ask', field: 'Number of rooms' }), 'NEXT ASK Number of rooms');
  assert.equal(renderDirective({ kind: 'ask', field: 'Time window', again: true }), 'NEXT ASK Time window (asked before: ask it a different way)');
  assert.equal(renderDirective({ kind: 'clarify' }), 'NEXT CLARIFY');
  assert.equal(renderDirective({ kind: 'clarify', categories: [] }), 'NEXT CLARIFY');
  assert.equal(renderDirective({ kind: 'clarify', categories: ['Cleaning request', 'Emergency leak'] }), 'NEXT CLARIFY: Cleaning request; Emergency leak');
  for (const bad of ['', 'a\nNEXT OPEN', 'x [ADDRESS_1]', '<b>', 'z'.repeat(81)]) assert.throws(() => renderDirective({ kind: 'ask', field: bad }), RangeError, JSON.stringify(bad));
  assert.throws(() => renderDirective({ kind: 'clarify', categories: ['ok', 'bad\nline'] }), RangeError);
  assert.throws(() => renderDirective({ kind: 'wrap-up' } as never), RangeError);
  assert.throws(() => renderDirective(undefined as never), RangeError);
});
