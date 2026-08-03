import assert from 'node:assert/strict';
import { Lexer } from '../src/lexer/index.js';
import { parseTokens } from '../src/parser/index.js';
import { typecheck, TypeEnv } from '../src/check/index.js';
import { isHashable, satisfies } from '../src/check/traits.js';
import { testCapabilities } from './support/test-host.js';
import {
  INT_TYPE, FLOAT_TYPE, BOOL_TYPE, STRING_TYPE, DONE_TYPE, NEVER_TYPE, INVALID_TYPE,
  RANGE_TYPE, NONE_TYPE, listOfType, optionalOf, resultOf, pairOf, entryOf,
  namedType, functionType, taskOf,
} from '../src/types/types.js';

// A TypeEnv carrying whatever `type` declarations `src` makes — the real
// registry the checker itself builds, not a hand-assembled stand-in, so a
// 'Named' type's fields here are exactly the ones the checker would resolve.
// typecheck() promotes a run's declarations into the parent env it's given
// (its REPL path), which is what makes this possible.
function envWith(src: string): TypeEnv {
  const env = new TypeEnv(testCapabilities);
  const { tokens, errorMarkers } = new Lexer(src).tokenize();
  assert.deepEqual(errorMarkers, [], 'unexpected lexical errors');
  const { program, errorMarkers: parseErrors } = parseTokens(tokens);
  assert.deepEqual(parseErrors, [], 'unexpected parse errors');
  assert.ok(program !== null);
  const { diagnostics } = typecheck(program, src, testCapabilities, env);
  assert.deepEqual(diagnostics, [], `unexpected errors: ${diagnostics.map(d => d.code).join(', ')}`);
  return env;
}

// The fourth intrinsic trait (whitepaper §7), and the odd one out: Display /
// Comparable / Iterable each name a fixed list of implementor types, while
// Hashable is a *predicate over a type's shape* — scalars hash, and a composite
// hashes exactly when its parts do. That is what will make a user record a valid
// Dict key automatically, by being built of hashable parts, with no 'implement'
// to write.
describe('Hashable trait — the structural Dict-key predicate', () => {
  // No 'type' declarations needed for the built-in shapes; a fresh root still
  // carries the ambient types (Ordering), which the union tests below use.
  const env = new TypeEnv(testCapabilities);

  describe('the base case: scalars hash', () => {
    it('Int, Float, Bool and String are all Hashable', () => {
      for (const t of [INT_TYPE, FLOAT_TYPE, BOOL_TYPE, STRING_TYPE]) {
        assert.equal(isHashable(t, env), true);
      }
    });

    it('Float is included — NaN/Infinity are runtime errors, not values', () => {
      assert.equal(isHashable(FLOAT_TYPE, env), true);
    });
  });

  describe('composites hash exactly when their components do', () => {
    it('a List hashes through its element type', () => {
      assert.equal(isHashable(listOfType(INT_TYPE), env), true);
      assert.equal(isHashable(listOfType(listOfType(STRING_TYPE)), env), true);
      assert.equal(isHashable(listOfType(functionType([INT_TYPE], INT_TYPE)), env), false);
    });

    it('an Optional hashes through its present type (None is just the absent case)', () => {
      assert.equal(isHashable(optionalOf(STRING_TYPE), env), true);
      assert.equal(isHashable(NONE_TYPE, env), true);
      assert.equal(isHashable(optionalOf(functionType([], DONE_TYPE)), env), false);
    });

    it('a Result hashes through both of its sides', () => {
      assert.equal(isHashable(resultOf(INT_TYPE, STRING_TYPE), env), true);
      assert.equal(isHashable(resultOf(INT_TYPE, functionType([], INT_TYPE)), env), false);
      assert.equal(isHashable(resultOf(functionType([], INT_TYPE), STRING_TYPE), env), false);
    });

    // prelude.md: 'Pair<A, B>' and 'Entry<K, V>' are Hashable when their
    // components are — so a Pair of scalars is a valid Dict key.
    it('a Pair/Entry hashes through both of its components', () => {
      assert.equal(isHashable(pairOf(INT_TYPE, STRING_TYPE), env), true);
      assert.equal(isHashable(entryOf(STRING_TYPE, listOfType(INT_TYPE)), env), true);
      assert.equal(isHashable(pairOf(INT_TYPE, taskOf(INT_TYPE)), env), false);
      assert.equal(isHashable(entryOf(functionType([], INT_TYPE), INT_TYPE), env), false);
    });

    it('a Range hashes — it is a pair of Int bounds compared structurally', () => {
      assert.equal(isHashable(RANGE_TYPE, env), true);
    });
  });

  describe('the carve-outs: no equality means no hash', () => {
    it('a function is never Hashable, bare or nested', () => {
      assert.equal(isHashable(functionType([INT_TYPE], STRING_TYPE), env), false);
      assert.equal(isHashable(listOfType(optionalOf(functionType([], DONE_TYPE))), env), false);
    });

    it('a Task is never Hashable either — two are never equal', () => {
      assert.equal(isHashable(taskOf(INT_TYPE), env), false);
      assert.equal(isHashable(listOfType(taskOf(STRING_TYPE)), env), false);
    });
  });

  describe('the machinery types answer permissively (no cascaded complaint)', () => {
    it('Never is vacuously Hashable — it is uninhabited and widens into any T', () => {
      assert.equal(isHashable(NEVER_TYPE, env), true);
      assert.equal(isHashable(listOfType(NEVER_TYPE), env), true);
    });

    it('Invalid absorbs, so an already-reported failure is not re-reported', () => {
      assert.equal(isHashable(INVALID_TYPE, env), true);
    });

    it('Done is a singleton, so it hashes trivially', () => {
      assert.equal(isHashable(DONE_TYPE, env), true);
    });
  });

  describe('a user type is a valid key by being built of hashable parts', () => {
    it('a record of scalars is Hashable, with nothing to declare', () => {
      const e = envWith('type Point = { x: Int, y: Int };');
      assert.equal(isHashable(namedType('Point'), e), true);
    });

    it('a record with a function field is not', () => {
      const e = envWith('type Handler = { name: String, run: Fn(Int) -> Int };');
      assert.equal(isHashable(namedType('Handler'), e), false);
    });

    it('the rule is transitive — a record holding a non-hashable record is not hashable', () => {
      const e = envWith(`
        type Handler = { run: Fn(Int) -> Int };
        type Point = { x: Int, y: Int };
        type Good = { at: Point };
        type Bad = { on: Handler };
      `);
      assert.equal(isHashable(namedType('Good'), e), true);
      assert.equal(isHashable(namedType('Bad'), e), false);
    });

    it('a union is Hashable iff every field of every variant is', () => {
      const e = envWith(`
        type Shape = Circle { r: Float } | Square { side: Float };
        type Widget = Plain | Custom { draw: Fn() -> String };
      `);
      assert.equal(isHashable(namedType('Shape'), e), true);
      assert.equal(isHashable(namedType('Widget'), e), false);
    });

    // A fieldless variant has nothing to refuse, so a braceless enum bottoms out
    // immediately — which is why prelude.md's ambient 'Ordering' is Hashable.
    it('a braceless enum is Hashable, and so is the ambient Ordering', () => {
      const e = envWith('type Color = Red | Green | Blue;');
      assert.equal(isHashable(namedType('Color'), e), true);
      assert.equal(isHashable(namedType('Ordering'), env), true);
    });

    it('a self-referential type terminates, and still answers on the rest of its shape', () => {
      const e = envWith(`
        type Tree = { label: String, kids: List<Tree> };
        type Node = { onClick: Fn() -> Done, kids: List<Node> };
      `);
      assert.equal(isHashable(namedType('Tree'), e), true);
      assert.equal(isHashable(namedType('Node'), e), false);
    });

    // An unknown name is one the checker already reported (N-code), so it answers
    // like Invalid rather than adding a second complaint about the same mistake.
    it('an unregistered name answers permissively', () => {
      assert.equal(isHashable(namedType('NeverDeclared'), env), true);
    });
  });

  // Sanity that the four intrinsic traits stay distinct, and that Hashable is
  // the broad one: a String is Display + Comparable + Hashable but not Iterable;
  // a List<Int> is Iterable + Hashable and neither of the other two.
  describe('the four intrinsic traits are distinct', () => {
    it('String: Display + Comparable + Hashable, not Iterable', () => {
      assert.equal(satisfies('Display', STRING_TYPE), true);
      assert.equal(satisfies('Comparable', STRING_TYPE), true);
      assert.equal(satisfies('Iterable', STRING_TYPE), false);
      assert.equal(isHashable(STRING_TYPE, env), true);
    });

    it('List<Int>: Iterable + Hashable only', () => {
      const t = listOfType(INT_TYPE);
      assert.equal(satisfies('Display', t), false);
      assert.equal(satisfies('Comparable', t), false);
      assert.equal(satisfies('Iterable', t), true);
      assert.equal(isHashable(t, env), true);
    });

    it('Bool: Display + Hashable, but not Comparable (no order) and not Iterable', () => {
      assert.equal(satisfies('Display', BOOL_TYPE), true);
      assert.equal(satisfies('Comparable', BOOL_TYPE), false);
      assert.equal(satisfies('Iterable', BOOL_TYPE), false);
      assert.equal(isHashable(BOOL_TYPE, env), true);
    });
  });
});
