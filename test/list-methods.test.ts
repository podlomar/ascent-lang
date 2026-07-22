import assert from 'node:assert/strict';
import { parse } from '../src/parser/index.js';
import { executeProgram } from '../src/interpreter.js';
import type { RuntimeValue } from '../src/interpreter.js';
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

function errorCodes(src: string): string[] {
  return parse(src, testCapabilities).diagnostics.map(d => d.code);
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
});
