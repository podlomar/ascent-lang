import type { Span } from '../lexer/token.js';
import {
  AscentType, TypeKind, INT_TYPE, FLOAT_TYPE, BOOL_TYPE, STRING_TYPE, DONE_TYPE,
  listOfType, optionalOf, leastCommonType, typesEqual, typeToString, functionType, namedType, pairOf, INVALID_TYPE,
} from '../types/types.js';
import { Diagnostics, requireArity, typeMismatch } from './diagnostics.js';
import { Trait, satisfies } from './traits.js';

// ---- Built-in signatures: data, not control flow ----------------------
//
// "What methods/functions exist" is data that grows whenever a builtin is
// added; "how a call is checked against that data" is the one rule below
// (methodCallType). Most signatures are monomorphic — fixed arity, fixed
// result; the List methods whose result depends on the receiver's element
// type keep a small resolver instead.
//
// None of this table or its dispatch needs to know about Invalid: synth's
// 'call'/'methodCall' cases (in ./synth.ts) bail out to Invalid *before*
// ever reaching this code whenever a receiver or argument already failed,
// so nothing here ever actually sees one.

export interface MonoSig {
  params: readonly AscentType[];
  result: AscentType;
}

export interface ResolvedSig {
  arity: number;
  resolve: (recv: AscentType, args: AscentType[], diagnostics: Diagnostics, span: Span) => AscentType;
}

export type MethodSig = MonoSig | ResolvedSig;

// Arity, then each param checked against its argument in order — pushes
// T0014 / T0015 and stops at the first mismatch, same as the old
// hand-rolled dispatchers.
const checkParams = (
  params: readonly AscentType[], args: AscentType[], diagnostics: Diagnostics, span: Span,
): boolean => {
  if (!requireArity(params.length, args.length, diagnostics, span)) return false;
  for (let i = 0; i < params.length; i++) {
    if (!typesEqual(args[i]!, params[i]!)) {
      typeMismatch('T0015', diagnostics, span, params[i]!, args[i]!);
      return false;
    }
  }
  return true;
};

const applySig = (
  sig: MethodSig, recv: AscentType, args: AscentType[], diagnostics: Diagnostics, span: Span,
): AscentType => {
  if ('result' in sig) return checkParams(sig.params, args, diagnostics, span) ? sig.result : INVALID_TYPE;
  if (!requireArity(sig.arity, args.length, diagnostics, span)) return INVALID_TYPE;
  return sig.resolve(recv, args, diagnostics, span);
};

// append and prepend put the value on different ends at runtime, but share
// one type rule: widen to the join of the element and argument types (e.g.
// appending a Float to a List<Int> gives List<Float>).
const appendLike = (recv: AscentType, args: AscentType[], diagnostics: Diagnostics, span: Span): AscentType => {
  if (recv.kind !== 'List') return INVALID_TYPE;
  const ct = leastCommonType(recv.elem, args[0]!);
  return ct === null ? typeMismatch('T0015', diagnostics, span, recv.elem, args[0]!) : listOfType(ct);
};

// at/take/drop/slice's Int argument(s) are positions/counts, unrelated to the
// element type — an argument that isn't Int is an ordinary T0015, not an
// element-widening question the way append/concat's argument is.
const requireInts = (args: AscentType[], diagnostics: Diagnostics, span: Span): boolean => {
  for (const a of args) {
    if (!typesEqual(a, INT_TYPE)) {
      typeMismatch('T0015', diagnostics, span, INT_TYPE, a);
      return false;
    }
  }
  return true;
};

// A callback argument's shape check, shared by map/filter/reduce (and every
// later predicate-taking search method). `resultType` is the callback's
// required result when it's fixed (Bool, for a predicate) or null when it's
// free (map's U — the only source of it is the callback's own declared
// result, since nothing else in the call names it). Comparing the WHOLE
// arrow type — built with the callback's own result standing in for a free
// U — against the required param types catches a wrong arity, a wrong param
// type, AND an async callback (§8, sync callbacks only) in one T0015: arrow
// types are invariant (types.ts), so any of the three makes typesEqual fail
// and prints two comparable 'Fn(...) -> ...' shapes. A non-Function argument
// has no result to reuse for that comparison, so it gets its own code
// (T0065) instead of a fabricated 'expected' type. Returns the resolved
// result type on success, or null (having already reported) on failure.
const requireCallback = (
  paramTypes: AscentType[], resultType: AscentType | null, arg: AscentType, diagnostics: Diagnostics, span: Span,
): AscentType | null => {
  if (arg.kind !== 'Function') {
    diagnostics.error({ code: 'T0065', span, data: { actual: typeToString(arg) } });
    return null;
  }
  const expected = functionType(paramTypes, resultType ?? arg.result, false);
  if (!typesEqual(arg, expected)) {
    typeMismatch('T0015', diagnostics, span, expected, arg);
    return null;
  }
  return arg.result;
};

// sort/min/max need T: Comparable on the element itself; sortBy needs it on
// the callback's own key type (K) instead — the element itself never has to
// be orderable, since sortBy exists precisely for records that aren't
// (stdlib/list.md). Both report the same T0066 — present-but-unmet bound, not
// a missing method (T0012 is for that) — pointing at sortBy/sortWith.
const requireComparable = (type: AscentType, diagnostics: Diagnostics, span: Span): boolean => {
  if (satisfies('Comparable', type)) return true;
  diagnostics.error({ code: 'T0066', span, data: { type: typeToString(type) } });
  return false;
};

// zip's other list is List<U> for a totally unconstrained U — the only
// source of it is the argument's own element type (mirroring
// requireCallback's free result), so a non-List argument has nothing to reuse
// for an 'expected' type and gets its own message (T0067) instead of a
// fabricated 'List<???>'. Returns the argument's element type on success.
const requireList = (arg: AscentType, diagnostics: Diagnostics, span: Span): AscentType | null => {
  if (arg.kind !== 'List') {
    diagnostics.error({ code: 'T0067', span, data: { actual: typeToString(arg) } });
    return null;
  }
  return arg.elem;
};

// join (List<String> only) and sum (List<Int>/List<Float> only) are
// receiver-specific — meaningless for any other element type (stdlib/
// list.md's taxonomy) — so an unsupported element type is reported as an
// ordinary missing method (T0012), exactly as if this table had no entry for
// it at all, not a bound violation (that's T0066's job, for sort/min/max —
// there the operation IS meaningful, just unmet).
const requireElem = (
  recv: Extract<AscentType, { kind: 'List' }>, elemKind: AscentType['kind'], method: string,
  diagnostics: Diagnostics, span: Span,
): boolean => {
  if (recv.elem.kind === elemKind) return true;
  diagnostics.error({ code: 'T0012', span, data: { method, type: typeToString(recv) } });
  return false;
};

export const METHODS: Partial<Record<TypeKind, Record<string, MethodSig>>> = {
  Int: {
    toString: { params: [], result: STRING_TYPE },
    toFloat: { params: [], result: FLOAT_TYPE },
    abs: { params: [], result: INT_TYPE },
  },
  // stdlib/scalars.md: a Float has no bare '.toInt()' — converting drops the
  // fractional part, and *how* is the caller's call, so the four named
  // roundings replace it (never a T0012-worthy bare toInt).
  Float: {
    toString: { params: [], result: STRING_TYPE },
    trunc: { params: [], result: INT_TYPE },
    round: { params: [], result: INT_TYPE },
    floor: { params: [], result: INT_TYPE },
    ceil: { params: [], result: INT_TYPE },
    abs: { params: [], result: FLOAT_TYPE },
  },
  Bool: {
    toString: { params: [], result: STRING_TYPE },
  },
  // stdlib/string.md: no integer indexing on String — these named,
  // grapheme-aware methods replace it. length/first/last/chars/slice/drop/take
  // all count and cut on characters (Unicode graphemes), never bytes or code
  // units. first/last return String? (None on an empty String) rather than
  // crashing — the "expected maybe-absent" tier, now that Optional exists.
  String: {
    length: { params: [], result: INT_TYPE },
    isEmpty: { params: [], result: BOOL_TYPE },
    first: { params: [], result: optionalOf(STRING_TYPE) },
    last: { params: [], result: optionalOf(STRING_TYPE) },
    chars: { params: [], result: listOfType(STRING_TYPE) },
    // stdlib/string.md: slice takes two grapheme indices, 'from' and 'to'
    // (half-open) — not a Range, which is reserved for iteration (§5) and
    // would teach a concept for this one use.
    slice: { params: [INT_TYPE, INT_TYPE], result: STRING_TYPE },
    drop: { params: [INT_TYPE], result: STRING_TYPE },
    take: { params: [INT_TYPE], result: STRING_TYPE },
    contains: { params: [STRING_TYPE], result: BOOL_TYPE },
    startsWith: { params: [STRING_TYPE], result: BOOL_TYPE },
    endsWith: { params: [STRING_TYPE], result: BOOL_TYPE },
    toUpper: { params: [], result: STRING_TYPE },
    toLower: { params: [], result: STRING_TYPE },
    toTitle: { params: [], result: STRING_TYPE },
    trim: { params: [], result: STRING_TYPE },
    trimStart: { params: [], result: STRING_TYPE },
    trimEnd: { params: [], result: STRING_TYPE },
    repeat: { params: [INT_TYPE], result: STRING_TYPE },
    padLeft: { params: [INT_TYPE], result: STRING_TYPE },
    padRight: { params: [INT_TYPE], result: STRING_TYPE },
    split: { params: [STRING_TYPE], result: listOfType(STRING_TYPE) },
    lines: { params: [], result: listOfType(STRING_TYPE) },
    codePoints: { params: [], result: listOfType(INT_TYPE) },
    bytes: { params: [], result: listOfType(INT_TYPE) },
    // stdlib/scalars.md: parsing can fail — a String might not name a
    // number/Bool — so each returns T?, never a bare T, forcing the miss to
    // be handled (?? / match / try) instead of hidden.
    toInt: { params: [], result: optionalOf(INT_TYPE) },
    toFloat: { params: [], result: optionalOf(FLOAT_TYPE) },
    toBool: { params: [], result: optionalOf(BOOL_TYPE) },
  },
  // stdlib/list.md: 'at' is the honest lookup (T?, None out of range — negative
  // indices included, since there is no Python-style from-the-end); 'first' /
  // 'last' are None only on an empty receiver. All three mirror String's
  // first/last (§9) — absence is a value here, not the R0005 crash 'xs[i]' is.
  List: {
    length: { params: [], result: INT_TYPE },
    isEmpty: { params: [], result: BOOL_TYPE },
    at: {
      arity: 1,
      resolve: (recv, args, diagnostics, span) => {
        if (recv.kind !== 'List') return INVALID_TYPE;
        if (!requireInts(args, diagnostics, span)) return INVALID_TYPE;
        return optionalOf(recv.elem);
      },
    },
    first: { arity: 0, resolve: recv => recv.kind === 'List' ? optionalOf(recv.elem) : INVALID_TYPE },
    last: { arity: 0, resolve: recv => recv.kind === 'List' ? optionalOf(recv.elem) : INVALID_TYPE },
    reverse: { arity: 0, resolve: recv => recv.kind === 'List' ? listOfType(recv.elem) : INVALID_TYPE },
    // stdlib/list.md: take/drop saturate rather than crash — 'up to n', not an
    // assertion about length — so, unlike 'at', their Int arg needs no runtime
    // range check at all, only the type check every List method here does.
    take: {
      arity: 1,
      resolve: (recv, args, diagnostics, span) => {
        if (recv.kind !== 'List') return INVALID_TYPE;
        if (!requireInts(args, diagnostics, span)) return INVALID_TYPE;
        return listOfType(recv.elem);
      },
    },
    drop: {
      arity: 1,
      resolve: (recv, args, diagnostics, span) => {
        if (recv.kind !== 'List') return INVALID_TYPE;
        if (!requireInts(args, diagnostics, span)) return INVALID_TYPE;
        return listOfType(recv.elem);
      },
    },
    // stdlib/list.md: two Int indices (not a Range, which stays reserved for
    // iteration) — a bad bound crashes at runtime (R0017), same tier as
    // String.slice's R0006, since a bound violation can depend on a value the
    // checker can't see ahead of time.
    slice: {
      arity: 2,
      resolve: (recv, args, diagnostics, span) => {
        if (recv.kind !== 'List') return INVALID_TYPE;
        if (!requireInts(args, diagnostics, span)) return INVALID_TYPE;
        return listOfType(recv.elem);
      },
    },
    // stdlib/list.md's core three. map/filter place no bound on T (the
    // element type); U (map's result element) is resolved from the
    // callback's own declared return type, since nothing else names it.
    map: {
      arity: 1,
      resolve: (recv, args, diagnostics, span) => {
        if (recv.kind !== 'List') return INVALID_TYPE;
        const u = requireCallback([recv.elem], null, args[0]!, diagnostics, span);
        return u === null ? INVALID_TYPE : listOfType(u);
      },
    },
    filter: {
      arity: 1,
      resolve: (recv, args, diagnostics, span) => {
        if (recv.kind !== 'List') return INVALID_TYPE;
        const kept = requireCallback([recv.elem], BOOL_TYPE, args[0]!, diagnostics, span);
        return kept === null ? INVALID_TYPE : listOfType(recv.elem);
      },
    },
    // 'reduce' always takes an explicit 'init' — no seedless overload that
    // traps on an empty list — so its result type (U) comes from init, not
    // from the step function; step's own declared result must match it.
    reduce: {
      arity: 2,
      resolve: (recv, args, diagnostics, span) => {
        if (recv.kind !== 'List') return INVALID_TYPE;
        const initType = args[0]!;
        const result = requireCallback([initType, recv.elem], initType, args[1]!, diagnostics, span);
        return result === null ? INVALID_TYPE : result;
      },
    },
    // stdlib/list.md's search square — value or position, by predicate or
    // equality. find/findIndex/some/every/count share one predicate shape
    // (Fn(T) -> Bool, same check as filter's); contains/indexOf compare by
    // structural '==' instead (leastCommonType, like appendLike — a real
    // widening question, e.g. List<Float>.contains(1)), and separately carry
    // '=='s own function carve-out, checked in synth.ts (methodCallType has
    // no 'env' to resolve a Named type's fields).
    find: {
      arity: 1,
      resolve: (recv, args, diagnostics, span) => {
        if (recv.kind !== 'List') return INVALID_TYPE;
        const ok = requireCallback([recv.elem], BOOL_TYPE, args[0]!, diagnostics, span);
        return ok === null ? INVALID_TYPE : optionalOf(recv.elem);
      },
    },
    findIndex: {
      arity: 1,
      resolve: (recv, args, diagnostics, span) => {
        if (recv.kind !== 'List') return INVALID_TYPE;
        const ok = requireCallback([recv.elem], BOOL_TYPE, args[0]!, diagnostics, span);
        return ok === null ? INVALID_TYPE : optionalOf(INT_TYPE);
      },
    },
    some: {
      arity: 1,
      resolve: (recv, args, diagnostics, span) => {
        if (recv.kind !== 'List') return INVALID_TYPE;
        const ok = requireCallback([recv.elem], BOOL_TYPE, args[0]!, diagnostics, span);
        return ok === null ? INVALID_TYPE : BOOL_TYPE;
      },
    },
    every: {
      arity: 1,
      resolve: (recv, args, diagnostics, span) => {
        if (recv.kind !== 'List') return INVALID_TYPE;
        const ok = requireCallback([recv.elem], BOOL_TYPE, args[0]!, diagnostics, span);
        return ok === null ? INVALID_TYPE : BOOL_TYPE;
      },
    },
    count: {
      arity: 1,
      resolve: (recv, args, diagnostics, span) => {
        if (recv.kind !== 'List') return INVALID_TYPE;
        const ok = requireCallback([recv.elem], BOOL_TYPE, args[0]!, diagnostics, span);
        return ok === null ? INVALID_TYPE : INT_TYPE;
      },
    },
    contains: {
      arity: 1,
      resolve: (recv, args, diagnostics, span) => {
        if (recv.kind !== 'List') return INVALID_TYPE;
        const ct = leastCommonType(recv.elem, args[0]!);
        return ct === null ? typeMismatch('T0015', diagnostics, span, recv.elem, args[0]!) : BOOL_TYPE;
      },
    },
    indexOf: {
      arity: 1,
      resolve: (recv, args, diagnostics, span) => {
        if (recv.kind !== 'List') return INVALID_TYPE;
        const ct = leastCommonType(recv.elem, args[0]!);
        return ct === null ? typeMismatch('T0015', diagnostics, span, recv.elem, args[0]!) : optionalOf(INT_TYPE);
      },
    },
    // stdlib/list.md's Ordering section. sort/min/max need T: Comparable on
    // the element itself (🔒 scalars only, until traits land); sortBy needs it
    // on the key K instead, so it works for records that aren't Comparable
    // themselves. sortWith's comparator has a fixed, non-free result
    // (Ordering), so it reuses requireCallback exactly like filter's Bool.
    sort: {
      arity: 0,
      resolve: (recv, _args, diagnostics, span) => {
        if (recv.kind !== 'List') return INVALID_TYPE;
        return requireComparable(recv.elem, diagnostics, span) ? listOfType(recv.elem) : INVALID_TYPE;
      },
    },
    sortBy: {
      arity: 1,
      resolve: (recv, args, diagnostics, span) => {
        if (recv.kind !== 'List') return INVALID_TYPE;
        const key = requireCallback([recv.elem], null, args[0]!, diagnostics, span);
        if (key === null) return INVALID_TYPE;
        return requireComparable(key, diagnostics, span) ? listOfType(recv.elem) : INVALID_TYPE;
      },
    },
    sortWith: {
      arity: 1,
      resolve: (recv, args, diagnostics, span) => {
        if (recv.kind !== 'List') return INVALID_TYPE;
        const cmp = requireCallback([recv.elem, recv.elem], namedType('Ordering'), args[0]!, diagnostics, span);
        return cmp === null ? INVALID_TYPE : listOfType(recv.elem);
      },
    },
    min: {
      arity: 0,
      resolve: (recv, _args, diagnostics, span) => {
        if (recv.kind !== 'List') return INVALID_TYPE;
        return requireComparable(recv.elem, diagnostics, span) ? optionalOf(recv.elem) : INVALID_TYPE;
      },
    },
    max: {
      arity: 0,
      resolve: (recv, _args, diagnostics, span) => {
        if (recv.kind !== 'List') return INVALID_TYPE;
        return requireComparable(recv.elem, diagnostics, span) ? optionalOf(recv.elem) : INVALID_TYPE;
      },
    },
    append: { arity: 1, resolve: appendLike },
    prepend: { arity: 1, resolve: appendLike },
    concat: {
      arity: 1,
      resolve: (recv, args, diagnostics, span) => {
        if (recv.kind !== 'List') return INVALID_TYPE;
        const arg = args[0]!;
        if (arg.kind !== 'List') return typeMismatch('T0015', diagnostics, span, listOfType(recv.elem), arg);
        const ct = leastCommonType(recv.elem, arg.elem);
        return ct === null ? typeMismatch('T0015', diagnostics, span, listOfType(recv.elem), arg) : listOfType(ct);
      },
    },
    // stdlib/list.md's "Combine & build". zip pairs T with a totally
    // unconstrained U — no relation to T required, unlike concat's
    // leastCommonType — so it takes whatever the other list's element type
    // is. enumerate is 'zip' against a fixed 0..length Int sequence.
    zip: {
      arity: 1,
      resolve: (recv, args, diagnostics, span) => {
        if (recv.kind !== 'List') return INVALID_TYPE;
        const u = requireList(args[0]!, diagnostics, span);
        return u === null ? INVALID_TYPE : listOfType(pairOf(recv.elem, u));
      },
    },
    enumerate: {
      arity: 0,
      resolve: recv => recv.kind === 'List' ? listOfType(pairOf(INT_TYPE, recv.elem)) : INVALID_TYPE,
    },
    // join is receiver-specific to List<String> (the inverse of
    // String.split) — meaningless for any other element type, so it's a
    // missing method (T0012) there, not a bound violation.
    join: {
      arity: 1,
      resolve: (recv, args, diagnostics, span) => {
        if (recv.kind !== 'List') return INVALID_TYPE;
        if (!requireElem(recv, 'String', 'join', diagnostics, span)) return INVALID_TYPE;
        if (!typesEqual(args[0]!, STRING_TYPE)) return typeMismatch('T0015', diagnostics, span, STRING_TYPE, args[0]!);
        return STRING_TYPE;
      },
    },
  },
  // design.md §4: a Range is Int-only, so its methods are all monomorphic —
  // length is how many items it yields, toList materializes them, contains
  // tests membership. It "pairs cleanly with lengths" (the whitepaper), so
  // length reads exactly like a List's.
  Range: {
    length: { params: [], result: INT_TYPE },
    toList: { params: [], result: listOfType(INT_TYPE) },
    contains: { params: [INT_TYPE], result: BOOL_TYPE },
  },
};

// A builtin parameter's declared type: either a concrete type, or a
// trait-bounded type variable — the `T: Display` in `print<T: Display>(value:
// T)`. A bound accepts any argument type satisfying the trait; the variable
// never escapes into the result (print returns Done), so this needs no
// generics, only the predicate in traits.ts.
export type TraitBound = { readonly bound: Trait };
export type ParamType = AscentType | TraitBound;
export const isTraitBound = (p: ParamType): p is TraitBound => 'bound' in p;

// Whether an argument of `argType` is accepted by a parameter: a concrete
// parameter must match exactly, a bounded one must satisfy its trait.
export const paramAccepts = (param: ParamType, argType: AscentType): boolean =>
  isTraitBound(param) ? satisfies(param.bound, argType) : typesEqual(argType, param);

export interface FunctionSig {
  params: readonly ParamType[];
  result: AscentType;
}

// Ascent's built-in free functions, folded in as ordinary signatures instead
// of special cases in synth's 'call' branch. `print<T: Display>(value: T)`
// takes anything with a canonical text form — the same Display bound an
// interpolation hole carries — and yields Done, the unit value of a
// side-effecting call (whitepaper §7). So a scalar prints directly; a value
// with no text form is shown by interpolating a scalar field (`print("${x.n}")`)
// or converting it (`print(x.toString())`). `printInline` is print's no-newline
// twin (docs/version-0.1/stdlib/prelude.md) — same bound, same result.
export const FUNCTIONS: Record<string, FunctionSig> = {
  print: { params: [{ bound: 'Display' }], result: DONE_TYPE },
  printInline: { params: [{ bound: 'Display' }], result: DONE_TYPE },
};

// The prelude's ambient async input functions (docs/version-0.1/stdlib/
// prelude.md) — each shows its message and blocks for a line, so all four are
// async by nature and must be prepared with '!' and run through 'await', just
// like a user-defined 'async fn'; only the checker signature and the runtime
// behaviour behind it are built in rather than written in Ascent. Kept as its
// own table (not folded into FUNCTIONS) since synth's 'call' judgment must
// reject a *bare* call of one (T0053, the same mistake as calling a
// user-defined async fn without '!'), while 'asyncCall' is the only judgment
// that may actually resolve one.
export const ASYNC_FUNCTIONS: Record<string, MonoSig> = {
  prompt: { params: [STRING_TYPE], result: STRING_TYPE },
  promptInt: { params: [STRING_TYPE], result: INT_TYPE },
  promptFloat: { params: [STRING_TYPE], result: FLOAT_TYPE },
  promptBool: { params: [STRING_TYPE], result: BOOL_TYPE },
};

// '.orAbort(msg?)' unwraps a Result/Optional's good case or diverges through the
// bug-tier crash on its bad one (whitepaper §9). Its result is the unwrapped good
// type — a Result's ok side, an Optional's element. Unlike the table methods it is
// polymorphic over the two fallible boxes and dispatched on their *static* type
// (their runtime value carries no distinguishing type), so it lives here, not in
// METHODS. The optional message augments the crash, never replaces it, so it must
// be a String when present; a bad message poisons only itself, not the unwrapped
// result (which is known regardless), so it's still returned.
const orAbortType = (
  recv: Extract<AscentType, { kind: 'Result' | 'Optional' }>,
  args: AscentType[], diagnostics: Diagnostics, span: Span,
): AscentType => {
  if (args.length > 1) {
    diagnostics.error({ code: 'T0014', span, data: { expected: 'no input, or one String message', got: String(args.length) } });
  } else if (args.length === 1 && !typesEqual(args[0]!, STRING_TYPE)) {
    typeMismatch('T0015', diagnostics, span, STRING_TYPE, args[0]!);
  }
  return recv.kind === 'Result' ? recv.ok : recv.elem;
};

// The one place a method call's result type is looked up: T0011 when the
// receiver's type has no methods at all, T0012 when it has methods but not
// this one, otherwise dispatch to the signature.
export const methodCallType = (
  recv: AscentType, method: string, args: AscentType[], diagnostics: Diagnostics, span: Span,
): AscentType => {
  // Result/Optional aren't in METHODS (their sole method, orAbort, is polymorphic
  // over both and dispatched on the static box type — see orAbortType). Intercept
  // before the table lookup so 'r.orAbort()' resolves and 'r.foo()' is T0012 (a
  // real method exists, just not that one) rather than T0011 ("no methods").
  if (recv.kind === 'Result' || recv.kind === 'Optional') {
    if (method === 'orAbort') return orAbortType(recv, args, diagnostics, span);
    diagnostics.error({ code: 'T0012', span, data: { method, type: typeToString(recv) } });
    return INVALID_TYPE;
  }

  const table = METHODS[recv.kind];
  if (table === undefined) {
    diagnostics.error({ code: 'T0011', span, data: { type: typeToString(recv) } });
    return INVALID_TYPE;
  }
  const sig = table[method];
  if (sig === undefined) {
    diagnostics.error({ code: 'T0012', span, data: { method, type: typeToString(recv) } });
    return INVALID_TYPE;
  }
  return applySig(sig, recv, args, diagnostics, span);
};
