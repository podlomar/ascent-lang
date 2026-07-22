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
