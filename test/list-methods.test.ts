import assert from 'node:assert/strict';
import { parse } from '../src/parser/index.js';
import { executeProgram } from '../src/interpreter.js';
import type { RuntimeValue } from '../src/interpreter.js';
import { typeToString } from '../src/types/types.js';
import { testHost, testCapabilities } from './support/test-host.js';

// Runs a program expected to typecheck and evaluate cleanly, returning its
// last statement's RuntimeValue. Output is streamed to a sink we discard here —
// these tests assert on the structured value executeProgram returns, not its text.
async function evalOk(src: string): Promise<RuntimeValue> {
  const { program, diagnostics } = parse(src, testCapabilities);
  assert.deepEqual(diagnostics, [], `unexpected errors: ${diagnostics.map(d => d.code).join(', ')}`);
  assert.ok(program !== null, 'expected the program to typecheck');
  const result = await executeProgram(program, testHost());
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') throw new Error('unreachable');
  return result.value;
}

// Runs a program expected to typecheck but crash at runtime, returning the
// RuntimeError's code. Output is discarded — only the crash matters here.
async function evalCrash(src: string): Promise<string> {
  const { program, diagnostics } = parse(src, testCapabilities);
  assert.deepEqual(diagnostics, [], `unexpected errors: ${diagnostics.map(d => d.code).join(', ')}`);
  assert.ok(program !== null, 'expected the program to typecheck');
  const result = await executeProgram(program, testHost());
  assert.equal(result.kind, 'error');
  if (result.kind !== 'error') throw new Error('unreachable');
  return result.error.marker.code;
}

function errorCodes(src: string): string[] {
  return parse(src, testCapabilities).diagnostics.map(d => d.code);
}

function typeOfLast(src: string): string {
  const { program, diagnostics } = parse(src, testCapabilities);
  assert.deepEqual(diagnostics, [], `unexpected errors: ${diagnostics.map(d => d.code).join(', ')}`);
  assert.ok(program !== null, 'expected the program to typecheck');
  const last = program.stmts[program.stmts.length - 1]!;
  assert.equal(last.kind, 'expr');
  if (last.kind !== 'expr') throw new Error('unreachable');
  return typeToString(last.expr.type);
}

describe('List methods (end-to-end)', () => {
  describe('.at(index)', () => {
    it('returns the element at a valid index', async () => {
      assert.deepEqual(await evalOk('[10, 20, 30].at(1);'), { type: 'Int', value: 20n });
    });

    it('returns None for an index past the end', async () => {
      assert.deepEqual(await evalOk('[10, 20, 30].at(3);'), { type: 'None' });
    });

    it('returns None for a negative index — no from-the-end lookup', async () => {
      assert.deepEqual(await evalOk('[10, 20, 30].at(-1);'), { type: 'None' });
    });

    it('returns None for any index into an empty list', async () => {
      assert.deepEqual(await evalOk('fix xs: List<Int> = []; xs.at(0);'), { type: 'None' });
    });

    it('type-checks as T? — assignable to a T? slot and comparable to None', async () => {
      assert.deepEqual(await evalOk('fix x: Int? = [1, 2].at(0); x;'), { type: 'Int', value: 1n });
      assert.deepEqual(await evalOk('[1, 2].at(5) == None;'), { type: 'Bool', value: true });
    });

    it('reports T0015 when the index is not an Int', async () => {
      assert.deepEqual(errorCodes('[1, 2].at("0");'), ['T0015']);
    });
  });

  describe('.first() / .last()', () => {
    it('returns the first and last element', async () => {
      assert.deepEqual(await evalOk('[10, 20, 30].first();'), { type: 'Int', value: 10n });
      assert.deepEqual(await evalOk('[10, 20, 30].last();'), { type: 'Int', value: 30n });
    });

    it('returns the same element from a single-element receiver', async () => {
      assert.deepEqual(await evalOk('[7].first();'), { type: 'Int', value: 7n });
      assert.deepEqual(await evalOk('[7].last();'), { type: 'Int', value: 7n });
    });

    it('returns None instead of crashing on an empty list', async () => {
      assert.deepEqual(await evalOk('fix xs: List<Int> = []; xs.first();'), { type: 'None' });
      assert.deepEqual(await evalOk('fix xs: List<Int> = []; xs.last();'), { type: 'None' });
    });

    it('type-checks as T? — assignable to a T? slot and comparable to None', async () => {
      assert.deepEqual(await evalOk('fix x: Int? = [1, 2].first(); x;'), { type: 'Int', value: 1n });
      assert.deepEqual(await evalOk('fix xs: List<Int> = []; xs.first() == None;'), { type: 'Bool', value: true });
    });
  });

  describe('.take(n) / .drop(n)', () => {
    it('take returns the first n elements', async () => {
      assert.deepEqual(await evalOk('[1, 2, 3, 4].take(2);'), {
        type: 'List', elements: [{ type: 'Int', value: 1n }, { type: 'Int', value: 2n }],
      });
    });

    it('drop returns all but the first n elements', async () => {
      assert.deepEqual(await evalOk('[1, 2, 3, 4].drop(2);'), {
        type: 'List', elements: [{ type: 'Int', value: 3n }, { type: 'Int', value: 4n }],
      });
    });

    it('take saturates to the whole list past the end', async () => {
      assert.deepEqual(await evalOk('[1, 2].take(10);'), {
        type: 'List', elements: [{ type: 'Int', value: 1n }, { type: 'Int', value: 2n }],
      });
    });

    it('drop saturates to [] past the end', async () => {
      assert.deepEqual(await evalOk('[1, 2].drop(10);'), { type: 'List', elements: [] });
    });

    it('take/drop clamp a negative n to 0', async () => {
      assert.deepEqual(await evalOk('[1, 2].take(-1);'), { type: 'List', elements: [] });
      assert.deepEqual(await evalOk('[1, 2].drop(-1);'), {
        type: 'List', elements: [{ type: 'Int', value: 1n }, { type: 'Int', value: 2n }],
      });
    });

    it('reports T0015 when n is not an Int', async () => {
      assert.deepEqual(errorCodes('[1, 2].take("1");'), ['T0015']);
      assert.deepEqual(errorCodes('[1, 2].drop("1");'), ['T0015']);
    });
  });

  describe('.slice(from, to)', () => {
    it('takes a half-open sub-list', async () => {
      assert.deepEqual(await evalOk('[10, 20, 30, 40].slice(1, 3);'), {
        type: 'List', elements: [{ type: 'Int', value: 20n }, { type: 'Int', value: 30n }],
      });
    });

    it('returns the whole list when the bounds span it', async () => {
      assert.deepEqual(await evalOk('[1, 2, 3].slice(0, 3);'), {
        type: 'List', elements: [{ type: 'Int', value: 1n }, { type: 'Int', value: 2n }, { type: 'Int', value: 3n }],
      });
    });

    it('returns an empty list when from equals to', async () => {
      assert.deepEqual(await evalOk('[1, 2, 3].slice(1, 1);'), { type: 'List', elements: [] });
    });

    it('crashes with R0017 when to exceeds the length', async () => {
      assert.equal(await evalCrash('[1, 2, 3].slice(0, 4);'), 'R0017');
    });

    it('crashes with R0017 when from is negative', async () => {
      assert.equal(await evalCrash('[1, 2, 3].slice(-1, 2);'), 'R0017');
    });

    it('crashes with R0017 when from exceeds to', async () => {
      assert.equal(await evalCrash('[1, 2, 3].slice(2, 1);'), 'R0017');
    });

    it('reports T0015 when a bound is not an Int', async () => {
      assert.deepEqual(errorCodes('[1, 2].slice("0", 1);'), ['T0015']);
    });
  });

  describe('.map(f)', () => {
    it('applies f to each element', async () => {
      assert.deepEqual(await evalOk('[1, 2, 3].map(fn(x: Int): Int => x * 2);'), {
        type: 'List', elements: [{ type: 'Int', value: 2n }, { type: 'Int', value: 4n }, { type: 'Int', value: 6n }],
      });
    });

    it('can change the element type (U resolved from the callback\'s own result)', async () => {
      assert.deepEqual(await evalOk('[1, 2].map(fn(x: Int): String => x.toString());'), {
        type: 'List', elements: [{ type: 'String', value: '1' }, { type: 'String', value: '2' }],
      });
      assert.equal(typeOfLast('[1, 2].map(fn(x: Int): String => x.toString());'), 'List<String>');
    });

    it('is [] for an empty receiver', async () => {
      assert.deepEqual(await evalOk('fix xs: List<Int> = []; xs.map(fn(x: Int): Int => x);'), { type: 'List', elements: [] });
    });

    it('reports T0015 when the callback\'s param type does not match the element type', () => {
      assert.deepEqual(errorCodes('[1, 2].map(fn(x: String): Int => 1);'), ['T0015']);
    });

    it('reports T0015 for an async callback — sync callbacks only', () => {
      assert.deepEqual(errorCodes('[1, 2].map(async fn(x: Int): Int => { x });'), ['T0015']);
    });

    it('reports T0065 when the argument is not a function at all', () => {
      assert.deepEqual(errorCodes('[1, 2].map(1);'), ['T0065']);
    });
  });

  describe('.filter(keep)', () => {
    it('keeps only the elements where keep is True', async () => {
      assert.deepEqual(await evalOk('[1, 2, 3, 4].filter(fn(x: Int): Bool => x > 2);'), {
        type: 'List', elements: [{ type: 'Int', value: 3n }, { type: 'Int', value: 4n }],
      });
    });

    it('is [] when nothing matches, including on an empty receiver', async () => {
      assert.deepEqual(await evalOk('[1, 2].filter(fn(x: Int): Bool => False);'), { type: 'List', elements: [] });
      assert.deepEqual(await evalOk('fix xs: List<Int> = []; xs.filter(fn(x: Int): Bool => True);'), { type: 'List', elements: [] });
    });

    it('reports T0015 when the callback does not return Bool', () => {
      assert.deepEqual(errorCodes('[1, 2].filter(fn(x: Int): Int => x);'), ['T0015']);
    });

    it('reports T0065 when the argument is not a function at all', () => {
      assert.deepEqual(errorCodes('[1, 2].filter(1);'), ['T0065']);
    });
  });

  describe('.reduce(init, step)', () => {
    it('folds the list into one value, with an explicit init', async () => {
      assert.deepEqual(await evalOk('[1, 2, 3].reduce(0, fn(acc: Int, x: Int): Int => acc + x);'), { type: 'Int', value: 6n });
    });

    it('returns init untouched for an empty receiver — no seedless-reduce empty-list trap', async () => {
      assert.deepEqual(await evalOk('fix xs: List<Int> = []; xs.reduce(0, fn(acc: Int, x: Int): Int => acc + x);'), { type: 'Int', value: 0n });
    });

    it('can fold into a type different from the element type (U resolved from init)', async () => {
      assert.deepEqual(
        await evalOk('[1, 2, 3].reduce("", fn(acc: String, x: Int): String => "${acc}${x}");'),
        { type: 'String', value: '123' },
      );
    });

    it('reports T0015 when the step function\'s shape does not match (acc, elem) -> acc', () => {
      assert.deepEqual(errorCodes('[1, 2].reduce(0, fn(acc: Int, x: String): Int => acc);'), ['T0015']);
    });

    it('reports T0065 when the step argument is not a function at all', () => {
      assert.deepEqual(errorCodes('[1, 2].reduce(0, 5);'), ['T0065']);
    });
  });

  describe('.find(pred) / .findIndex(pred)', () => {
    it('find returns the first matching element, or None', async () => {
      assert.deepEqual(await evalOk('[1, 2, 3, 4].find(fn(x: Int): Bool => x > 2);'), { type: 'Int', value: 3n });
      assert.deepEqual(await evalOk('[1, 2].find(fn(x: Int): Bool => x > 10);'), { type: 'None' });
    });

    it('findIndex returns the position of the first match, or None — never -1', async () => {
      assert.deepEqual(await evalOk('[10, 20, 30].findIndex(fn(x: Int): Bool => x == 30);'), { type: 'Int', value: 2n });
      assert.deepEqual(await evalOk('[10, 20].findIndex(fn(x: Int): Bool => x == 99);'), { type: 'None' });
    });

    it('type-check as T? / Int? — assignable to a slot and comparable to None', async () => {
      assert.equal(typeOfLast('[1, 2].find(fn(x: Int): Bool => x > 0);'), 'Int?');
      assert.equal(typeOfLast('[1, 2].findIndex(fn(x: Int): Bool => x > 0);'), 'Int?');
    });

    it('reports T0065 when the argument is not a function at all', () => {
      assert.deepEqual(errorCodes('[1, 2].find(1);'), ['T0065']);
      assert.deepEqual(errorCodes('[1, 2].findIndex(1);'), ['T0065']);
    });
  });

  describe('.some(pred) / .every(pred)', () => {
    it('some is True when at least one element matches', async () => {
      assert.deepEqual(await evalOk('[1, 2, 3].some(fn(x: Int): Bool => x > 2);'), { type: 'Bool', value: true });
      assert.deepEqual(await evalOk('[1, 2, 3].some(fn(x: Int): Bool => x > 10);'), { type: 'Bool', value: false });
    });

    it('every is True only when all elements match', async () => {
      assert.deepEqual(await evalOk('[1, 2, 3].every(fn(x: Int): Bool => x > 0);'), { type: 'Bool', value: true });
      assert.deepEqual(await evalOk('[1, 2, 3].every(fn(x: Int): Bool => x > 1);'), { type: 'Bool', value: false });
    });

    it('empty-list identities: some is False, every is True', async () => {
      assert.deepEqual(await evalOk('fix xs: List<Int> = []; xs.some(fn(x: Int): Bool => True);'), { type: 'Bool', value: false });
      assert.deepEqual(await evalOk('fix xs: List<Int> = []; xs.every(fn(x: Int): Bool => False);'), { type: 'Bool', value: true });
    });
  });

  describe('.count(pred)', () => {
    it('counts the elements where pred matches', async () => {
      assert.deepEqual(await evalOk('[1, 2, 3, 4, 5].count(fn(x: Int): Bool => x mod 2 == 0);'), { type: 'Int', value: 2n });
    });

    it('is 0 when nothing matches, including on an empty receiver', async () => {
      assert.deepEqual(await evalOk('[1, 3].count(fn(x: Int): Bool => x mod 2 == 0);'), { type: 'Int', value: 0n });
      assert.deepEqual(await evalOk('fix xs: List<Int> = []; xs.count(fn(x: Int): Bool => True);'), { type: 'Int', value: 0n });
    });
  });

  describe('.contains(value) / .indexOf(value)', () => {
    it('contains is True exactly when an equal element is present', async () => {
      assert.deepEqual(await evalOk('[1, 2, 3].contains(2);'), { type: 'Bool', value: true });
      assert.deepEqual(await evalOk('[1, 2, 3].contains(9);'), { type: 'Bool', value: false });
    });

    it('indexOf returns the position of the first equal value, or None — never -1', async () => {
      assert.deepEqual(await evalOk('[10, 20, 30, 20].indexOf(20);'), { type: 'Int', value: 1n });
      assert.deepEqual(await evalOk('[10, 20].indexOf(99);'), { type: 'None' });
    });

    it('widens across Int/Float like == itself (leastCommonType, not exact match)', async () => {
      assert.deepEqual(await evalOk('[1, 2, 3].contains(2.0);'), { type: 'Bool', value: true });
    });

    it('reports T0015 when the value has an unrelated type', () => {
      assert.deepEqual(errorCodes('[1, 2].contains("2");'), ['T0015']);
      assert.deepEqual(errorCodes('[1, 2].indexOf("2");'), ['T0015']);
    });

    it('reports T0064 for a function-containing element type, same carve-out as ==', () => {
      assert.deepEqual(
        errorCodes('type H = { run: Fn(Int) -> Int }; fix f = fn(x: Int): Int => x; fix a = H{ run: f }; [a].contains(a);'),
        ['T0064'],
      );
      assert.deepEqual(
        errorCodes('type H = { run: Fn(Int) -> Int }; fix f = fn(x: Int): Int => x; fix a = H{ run: f }; [a].indexOf(a);'),
        ['T0064'],
      );
    });
  });

  describe('.sort()', () => {
    it('sorts Ints ascending', async () => {
      assert.deepEqual(await evalOk('[3, 1, 2].sort();'), {
        type: 'List', elements: [{ type: 'Int', value: 1n }, { type: 'Int', value: 2n }, { type: 'Int', value: 3n }],
      });
    });

    it('sorts Floats ascending', async () => {
      assert.deepEqual(await evalOk('[3.0, 1.0, 2.0].sort();'), {
        type: 'List', elements: [{ type: 'Float', value: 1 }, { type: 'Float', value: 2 }, { type: 'Float', value: 3 }],
      });
    });

    it('sorts Strings lexicographically', async () => {
      assert.deepEqual(await evalOk('["banana", "apple", "cherry"].sort();'), {
        type: 'List',
        elements: [{ type: 'String', value: 'apple' }, { type: 'String', value: 'banana' }, { type: 'String', value: 'cherry' }],
      });
    });

    it('is [] for an empty receiver', async () => {
      assert.deepEqual(await evalOk('fix xs: List<Int> = []; xs.sort();'), { type: 'List', elements: [] });
    });

    it('reports T0066 for a non-Comparable element type (records)', () => {
      assert.deepEqual(
        errorCodes('type Player = { name: String, score: Int }; fix ps: List<Player> = []; ps.sort();'),
        ['T0066'],
      );
    });
  });

  describe('.sortBy(key)', () => {
    it('sorts records by a Comparable key', async () => {
      const src = [
        'type Player = { name: String, score: Int };',
        'fix ps = [Player{ name: "a", score: 3 }, Player{ name: "b", score: 1 }, Player{ name: "c", score: 2 }];',
        'ps.sortBy(fn(p: Player): Int => p.score).map(fn(p: Player): Int => p.score);',
      ].join('\n');
      assert.deepEqual(await evalOk(src), {
        type: 'List', elements: [{ type: 'Int', value: 1n }, { type: 'Int', value: 2n }, { type: 'Int', value: 3n }],
      });
    });

    it('is a stable sort — equal keys keep their relative order', async () => {
      const src = [
        'type Player = { name: String, score: Int };',
        'fix ps = [Player{ name: "a", score: 1 }, Player{ name: "b", score: 1 }, Player{ name: "c", score: 0 }];',
        'ps.sortBy(fn(p: Player): Int => p.score).map(fn(p: Player): String => p.name);',
      ].join('\n');
      assert.deepEqual(await evalOk(src), {
        type: 'List', elements: [{ type: 'String', value: 'c' }, { type: 'String', value: 'a' }, { type: 'String', value: 'b' }],
      });
    });

    it('reports T0066 when the key type is not Comparable', () => {
      assert.deepEqual(
        errorCodes('type Player = { name: String, score: Int }; fix ps: List<Player> = []; ps.sortBy(fn(p: Player): Player => p);'),
        ['T0066'],
      );
    });

    it('reports T0065 when the argument is not a function at all', () => {
      assert.deepEqual(errorCodes('[1, 2].sortBy(1);'), ['T0065']);
    });
  });

  describe('.sortWith(cmp)', () => {
    it('sorts using a custom comparator returning Ordering', async () => {
      const cmp = 'fn(a: Int, b: Int): Ordering => if (a > b) { Less } else { if (a < b) { Greater } else { Equal } }';
      assert.deepEqual(await evalOk(`[1, 3, 2].sortWith(${cmp});`), {
        type: 'List', elements: [{ type: 'Int', value: 3n }, { type: 'Int', value: 2n }, { type: 'Int', value: 1n }],
      });
    });

    it('is [] for an empty receiver', async () => {
      const cmp = 'fn(a: Int, b: Int): Ordering => Equal';
      assert.deepEqual(await evalOk(`fix xs: List<Int> = []; xs.sortWith(${cmp});`), { type: 'List', elements: [] });
    });

    it('reports T0015 when the callback does not return Ordering', () => {
      assert.deepEqual(errorCodes('[1, 2].sortWith(fn(a: Int, b: Int): Bool => a < b);'), ['T0015']);
    });

    it('reports T0065 when the argument is not a function at all', () => {
      assert.deepEqual(errorCodes('[1, 2].sortWith(1);'), ['T0065']);
    });
  });

  describe('.min() / .max()', () => {
    it('returns the smallest and largest element', async () => {
      assert.deepEqual(await evalOk('[3, 1, 2].min();'), { type: 'Int', value: 1n });
      assert.deepEqual(await evalOk('[3, 1, 2].max();'), { type: 'Int', value: 3n });
    });

    it('returns None for an empty receiver, honestly, instead of crashing', async () => {
      assert.deepEqual(await evalOk('fix xs: List<Int> = []; xs.min();'), { type: 'None' });
      assert.deepEqual(await evalOk('fix xs: List<Int> = []; xs.max();'), { type: 'None' });
    });

    it('works on Strings and Floats too', async () => {
      assert.deepEqual(await evalOk('["banana", "apple"].min();'), { type: 'String', value: 'apple' });
      assert.deepEqual(await evalOk('[1.5, 2.5].max();'), { type: 'Float', value: 2.5 });
    });

    it('reports T0066 for a non-Comparable element type (records)', () => {
      assert.deepEqual(
        errorCodes('type Player = { name: String, score: Int }; fix ps: List<Player> = []; ps.min();'),
        ['T0066'],
      );
      assert.deepEqual(
        errorCodes('type Player = { name: String, score: Int }; fix ps: List<Player> = []; ps.max();'),
        ['T0066'],
      );
    });
  });

  describe('map/filter/reduce composed together', () => {
    it('chains map -> filter -> reduce in one expression', async () => {
      assert.deepEqual(
        await evalOk('[1, 2, 3, 4, 5].map(fn(x: Int): Int => x * 2).filter(fn(x: Int): Bool => x > 4).reduce(0, fn(acc: Int, x: Int): Int => acc + x);'),
        { type: 'Int', value: 24n },
      );
    });

    it('a callback can itself call a List method on a nested list (nested callback invocation)', async () => {
      assert.deepEqual(
        await evalOk('[[1, 2], [3, 4, 5]].map(fn(xs: List<Int>): Int => xs.reduce(0, fn(acc: Int, x: Int): Int => acc + x));'),
        { type: 'List', elements: [{ type: 'Int', value: 3n }, { type: 'Int', value: 12n }] },
      );
    });

    it('a callback can close over an outer slot', async () => {
      assert.deepEqual(
        await evalOk('fix factor = 10; [1, 2, 3].map(fn(x: Int): Int => x * factor);'),
        { type: 'List', elements: [{ type: 'Int', value: 10n }, { type: 'Int', value: 20n }, { type: 'Int', value: 30n }] },
      );
    });
  });
});
