import type { Span } from '../lexer/token.js';
import type { AscentType } from '../types/types.js';
import { RuntimeError } from '../errors/runtime-error.js';
import {
  coerce, formatFloat, graphemesOf, scalarToString, valuesEqual, isNumeric, asFloat,
  intVal, floatVal, strVal, boolVal, NONE,
  type RuntimeValue, type IntValue, type FloatValue, type BoolValue, type StringValue, type ListValue, type RangeValue,
} from './values.js';
import { checkIntOverflow } from './arithmetic.js';
import { valueToString } from '../parser/printer.js';
import { tryParseInt, tryParseFloat, tryParseBool } from '../scalar-input.js';

// ---- Built-in methods: data, not control flow -----------------------
//
// The runtime peer of check/signatures.ts's METHODS table. Keyed identically —
// receiver type kind, then method name — but holding the *implementation* of
// each builtin rather than its *signature*. "What a method does" is data that
// grows whenever a builtin is added; dispatch is the one lookup-and-apply rule
// below (evalMethodCall), not a switch per type.
//
// The checker has already guaranteed receiver type, method name, and arity
// before a call reaches here (synth's methodCall bails to Invalid otherwise,
// exactly as signatures.ts relies on), so every lookup is total by
// construction and the impls never re-validate. The two tables are kept from
// drifting by a parity meta-test (test/builtins-parity.test.ts): every METHODS
// key must have a METHOD_IMPLS entry and vice-versa.

// Everything an impl needs beyond its receiver and evaluated args: the call
// span (for the R#### crashes a few methods raise), the static types the
// List methods coerce their elements against when the result widens
// (design.md §7 — see coerce below), and applyFn — a callback-taking method
// (map/filter/reduce, stdlib/list.md) invokes a Fn value through this rather
// than importing applyFunction from ../interpreter.ts, which would be
// circular (interpreter.ts already imports evalMethodCall from this module).
export type MethodCtx = {
  span: Span;
  receiverType: AscentType;
  argTypes: AscentType[];
  resultType: AscentType;
  applyFn: (
    fn: Extract<RuntimeValue, { type: 'Function' }>, args: RuntimeValue[], argTypes: AscentType[],
  ) => Promise<RuntimeValue>;
};

// The receiver arrives narrowed to R: the dispatcher only ever calls an entry
// under the key that matches its receiver's runtime type. Most impls are
// plain synchronous data transforms and return a bare RuntimeValue; only the
// callback-taking List methods need to await ctx.applyFn, so they return a
// Promise instead — evalMethodCall below awaits either uniformly.
type MethodImpl<R extends RuntimeValue = RuntimeValue> =
  (recv: R, args: RuntimeValue[], ctx: MethodCtx) => RuntimeValue | Promise<RuntimeValue>;

const INT_IMPLS: Record<string, MethodImpl<IntValue>> = {
  // `r` is annotated here (and on Float.toString) only because the key
  // 'toString' collides with Object.prototype.toString's `() => string`, which
  // hijacks the contextual type; every other entry infers `r` from the group.
  toString: (r: IntValue) => strVal(String(r.value)),
  toFloat: r => floatVal(Number(r.value)),
  // abs(INT_MIN) has no representable Int result (its magnitude is one past
  // INT_MAX) — the classic two's-complement overflow case.
  abs: (r, _args, { span }) => intVal(checkIntOverflow(r.value < 0n ? -r.value : r.value, span)),
};

// stdlib/scalars.md: a Float has no bare '.toInt()' — losing the fractional
// part is a decision the caller must name, so each rounding rule is its own
// method rather than one hidden choice. All four always succeed (a finite
// Float always rounds), so only checkIntOverflow guards the Int result.
const roundHalfAwayFromZero = (n: number): number => Math.sign(n) * Math.round(Math.abs(n));

const FLOAT_IMPLS: Record<string, MethodImpl<FloatValue>> = {
  toString: (r: FloatValue) => strVal(formatFloat(r.value)),
  trunc: (r, _args, { span }) => intVal(checkIntOverflow(BigInt(Math.trunc(r.value)), span)),
  round: (r, _args, { span }) => intVal(checkIntOverflow(BigInt(roundHalfAwayFromZero(r.value)), span)),
  floor: (r, _args, { span }) => intVal(checkIntOverflow(BigInt(Math.floor(r.value)), span)),
  ceil: (r, _args, { span }) => intVal(checkIntOverflow(BigInt(Math.ceil(r.value)), span)),
  abs: r => floatVal(Math.abs(r.value)),
};

// toString is the same canonical Display form '${}'/print use (scalarToString),
// shared here rather than reimplemented — 'True'/'False', matching the literal
// spelling (design.md §4).
const BOOL_IMPLS: Record<string, MethodImpl<BoolValue>> = {
  toString: (r: BoolValue) => strVal(scalarToString(r)),
};

// stdlib/string.md §4/§9: no integer indexing on String — first/last/slice
// work in graphemes and crash (bug tier, like list '[ ]') rather than lie
// about what they return, exactly the reasoning that already governs List
// indexing.
const STRING_IMPLS: Record<string, MethodImpl<StringValue>> = {
  length: r => intVal(BigInt(graphemesOf(r.value).length)),
  isEmpty: r => boolVal(r.value.length === 0),
  first: r => {
    // stdlib/string.md: returns String? — None on an empty String, never a
    // crash, since an empty receiver is an expected case here, not a bug.
    const chars = graphemesOf(r.value);
    return chars.length === 0 ? NONE : strVal(chars[0]!);
  },
  last: r => {
    const chars = graphemesOf(r.value);
    return chars.length === 0 ? NONE : strVal(chars[chars.length - 1]!);
  },
  chars: r => ({ type: 'List', elements: graphemesOf(r.value).map((c): RuntimeValue => strVal(c)) }),
  slice: (r, args, { span }) => {
    // stdlib/string.md: slice takes two grapheme indices, 'from' and 'to'
    // (half-open) — not a Range, kept off this one call for a concept a
    // beginner would otherwise meet nowhere else.
    const chars = graphemesOf(r.value);
    const start = Number((args[0] as IntValue).value);
    const end = Number((args[1] as IntValue).value);
    if (start < 0 || end > chars.length || start > end) {
      throw new RuntimeError({
        code: 'R0006', span,
        data: { start: String(start), end: String(end), length: String(chars.length) },
      });
    }
    return strVal(chars.slice(start, end).join(''));
  },
  // stdlib/string.md: drop/take cover the open ends — "the rest, from n" and
  // "the first n" — and saturate rather than crash (n past the end is
  // clamped, negative n clamps to 0), since both describe "up to n", not an
  // assertion about length.
  drop: (r, args) => {
    const chars = graphemesOf(r.value);
    const n = Math.min(Math.max(Number((args[0] as IntValue).value), 0), chars.length);
    return strVal(chars.slice(n).join(''));
  },
  take: (r, args) => {
    const chars = graphemesOf(r.value);
    const n = Math.min(Math.max(Number((args[0] as IntValue).value), 0), chars.length);
    return strVal(chars.slice(0, n).join(''));
  },
  contains: (r, args) => boolVal(r.value.includes((args[0] as StringValue).value)),
  startsWith: (r, args) => boolVal(r.value.startsWith((args[0] as StringValue).value)),
  endsWith: (r, args) => boolVal(r.value.endsWith((args[0] as StringValue).value)),
  toUpper: r => strVal(r.value.toUpperCase()),
  toLower: r => strVal(r.value.toLowerCase()),
  // stdlib/string.md: words are whitespace-delimited runs; the split point
  // (not the case-folding) is where the grapheme unit matters, so only the
  // first grapheme is pulled out before upper/lowercasing each half.
  toTitle: r => strVal(r.value.replace(/\S+/g, word => {
    const chars = graphemesOf(word);
    return chars.length === 0 ? word : chars[0]!.toUpperCase() + chars.slice(1).join('').toLowerCase();
  })),
  trim: r => strVal(r.value.trim()),
  trimStart: r => strVal(r.value.trimStart()),
  trimEnd: r => strVal(r.value.trimEnd()),
  repeat: (r, args, { span }) => {
    const count = (args[0] as IntValue).value;
    if (count < 0n) {
      throw new RuntimeError({ code: 'R0007', span, data: { count: String(count) } });
    }
    return strVal(r.value.repeat(Number(count)));
  },
  padLeft: (r, args) => {
    const target = Number((args[0] as IntValue).value);
    const padCount = Math.max(0, target - graphemesOf(r.value).length);
    return strVal(' '.repeat(padCount) + r.value);
  },
  padRight: (r, args) => {
    const target = Number((args[0] as IntValue).value);
    const padCount = Math.max(0, target - graphemesOf(r.value).length);
    return strVal(r.value + ' '.repeat(padCount));
  },
  split: (r, args) => ({
    type: 'List',
    elements: r.value.split((args[0] as StringValue).value).map((s): RuntimeValue => strVal(s)),
  }),
  // stdlib/string.md: the common file-processing split — on '\n', '\r\n', or
  // a lone '\r', so it handles both Unix and Windows line endings.
  lines: r => ({
    type: 'List',
    elements: r.value.split(/\r\n|\r|\n/).map((s): RuntimeValue => strVal(s)),
  }),
  // stdlib/string.md: the escape hatch below graphemes. Array.from a string
  // iterates by Unicode code point (surrogate pairs combined), unlike a plain
  // index walk — codePointAt(0) then reads each one's scalar value.
  codePoints: r => ({
    type: 'List',
    elements: Array.from(r.value, (c): RuntimeValue => intVal(BigInt(c.codePointAt(0)!))),
  }),
  bytes: r => ({
    type: 'List',
    elements: Array.from(Buffer.from(r.value, 'utf8'), (b): RuntimeValue => intVal(BigInt(b))),
  }),
  // stdlib/scalars.md: parsing a String can fail, so each returns T? (None on
  // a bad parse) rather than crashing. Reuses scalar-input.ts's tryParse*,
  // the same validation the prompt family's ask*/CLI '--flag' parsing already
  // apply — one rule for "does this String name a value", not three.
  toInt: r => {
    const parsed = tryParseInt(r.value);
    return parsed === null ? NONE : intVal(parsed);
  },
  toFloat: r => {
    const parsed = tryParseFloat(r.value);
    return parsed === null ? NONE : floatVal(parsed);
  },
  toBool: r => {
    const parsed = tryParseBool(r.value);
    return parsed === null ? NONE : boolVal(parsed);
  },
};

// The element type of a List type, or null when it isn't a List
// (length/isEmpty return Int/Bool). `widen` coerces one element from its own
// static type to the result's; a null on either side means "no widening", so
// the element passes straight through. A List-returning method widens every
// element to the result element type (design.md §7) — the receiver's own, and
// any coming from an argument, each by its own static edge (e.g.
// List<Float>.concat(List<Int>) widens the argument, not the receiver).
const elemTypeOf = (t: AscentType): AscentType | null => (t.kind === 'List' ? t.elem : null);
const widen = (v: RuntimeValue, from: AscentType | null, to: AscentType | null): RuntimeValue =>
  from !== null && to !== null ? coerce(v, from, to) : v;
const widenAll = (vs: RuntimeValue[], from: AscentType | null, to: AscentType | null): RuntimeValue[] =>
  vs.map(v => widen(v, from, to));

// find/findIndex/some (stdlib/list.md's search square) all want "the position
// of the first element the predicate accepts, or -1" — they differ only in
// what they do with that position, so this is the one loop all three share.
const findMatchIndex = async (
  elements: RuntimeValue[], fn: Extract<RuntimeValue, { type: 'Function' }>, elemType: AscentType, applyFn: MethodCtx['applyFn'],
): Promise<number> => {
  for (let i = 0; i < elements.length; i++) {
    const keep = await applyFn(fn, [elements[i]!], [elemType]) as BoolValue;
    if (keep.value) return i;
  }
  return -1;
};

// stdlib/list.md's Ordering section: the checker has already proved the
// element type is Comparable (T0066 otherwise), so it's always Int, Float, or
// String (🔒 scalars today) — the only three cases here. Two Ints compare
// exactly as BigInts, matching valuesEqual's own reasoning for avoiding a
// huge Int's float-precision loss; any Int/Float mix promotes the same way.
const naturalCompare = (a: RuntimeValue, b: RuntimeValue): number => {
  if (isNumeric(a) && isNumeric(b)) {
    if (a.type === 'Int' && b.type === 'Int') return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
    const av = asFloat(a), bv = asFloat(b);
    return av < bv ? -1 : av > bv ? 1 : 0;
  }
  const as = (a as StringValue).value, bs = (b as StringValue).value;
  return as < bs ? -1 : as > bs ? 1 : 0;
};

// sortWith's comparator is user code, so — unlike sort/sortBy, which can hand
// every key to the JS engine's own (synchronous) '.sort()' — it needs a sort
// that awaits between comparisons. A plain merge sort is the standard way to
// get that, and it's stable for free (the '<= 0' tie-break below always takes
// from 'left', the earlier run, first) — matching Array.prototype.sort's own
// stability, which sort/sortBy already inherit from the JS engine.
const asyncMergeSort = async (
  items: RuntimeValue[], cmp: (a: RuntimeValue, b: RuntimeValue) => Promise<number>,
): Promise<RuntimeValue[]> => {
  if (items.length <= 1) return items;
  const mid = items.length >> 1;
  const left = await asyncMergeSort(items.slice(0, mid), cmp);
  const right = await asyncMergeSort(items.slice(mid), cmp);
  const merged: RuntimeValue[] = [];
  let i = 0, j = 0;
  while (i < left.length && j < right.length) {
    if ((await cmp(left[i]!, right[j]!)) <= 0) merged.push(left[i++]!);
    else merged.push(right[j++]!);
  }
  while (i < left.length) merged.push(left[i++]!);
  while (j < right.length) merged.push(right[j++]!);
  return merged;
};

const LIST_IMPLS: Record<string, MethodImpl<ListValue>> = {
  length: r => intVal(BigInt(r.elements.length)),
  isEmpty: r => boolVal(r.elements.length === 0),
  // stdlib/list.md: non-negative positions from the front only — a negative
  // index is simply not a valid position (no Python-style from-the-end), so it
  // is None exactly like an index past the end, never a crash.
  at: (r, args) => {
    const i = (args[0] as IntValue).value;
    return i < 0n || i >= BigInt(r.elements.length) ? NONE : r.elements[Number(i)]!;
  },
  first: r => r.elements.length === 0 ? NONE : r.elements[0]!,
  last: r => r.elements.length === 0 ? NONE : r.elements[r.elements.length - 1]!,
  // stdlib/list.md: take/drop describe "up to n," not an assertion about
  // length, so both saturate rather than crash — a negative n clamps to 0,
  // an n past the end clamps to the whole list. Same rule as String's.
  take: (r, args) => {
    const n = Math.min(Math.max(Number((args[0] as IntValue).value), 0), r.elements.length);
    return { type: 'List', elements: r.elements.slice(0, n) };
  },
  drop: (r, args) => {
    const n = Math.min(Math.max(Number((args[0] as IntValue).value), 0), r.elements.length);
    return { type: 'List', elements: r.elements.slice(n) };
  },
  slice: (r, args, { span }) => {
    const start = Number((args[0] as IntValue).value);
    const end = Number((args[1] as IntValue).value);
    if (start < 0 || end > r.elements.length || start > end) {
      throw new RuntimeError({
        code: 'R0017', span,
        data: { start: String(start), end: String(end), length: String(r.elements.length) },
      });
    }
    return { type: 'List', elements: r.elements.slice(start, end) };
  },
  reverse: (r, _args, ctx) => ({
    type: 'List',
    elements: widenAll([...r.elements].reverse(), elemTypeOf(ctx.receiverType), elemTypeOf(ctx.resultType)),
  }),
  // stdlib/list.md's core three — the callback runs once per element through
  // ctx.applyFn (see MethodCtx), the one way a builtin reaches a Fn value
  // without importing applyFunction from ../interpreter.ts (circular). The
  // checker has already proved the callback's param type equals the
  // receiver's element type exactly (Function types are invariant, §7), so
  // the element passes straight through with no widening of its own — map's
  // result element (U) is simply whatever the callback returns.
  map: async (r, args, ctx) => {
    const fn = args[0] as Extract<RuntimeValue, { type: 'Function' }>;
    const elemType = elemTypeOf(ctx.receiverType)!;
    const elements: RuntimeValue[] = [];
    for (const el of r.elements) {
      elements.push(await ctx.applyFn(fn, [el], [elemType]));
    }
    return { type: 'List', elements };
  },
  filter: async (r, args, ctx) => {
    const fn = args[0] as Extract<RuntimeValue, { type: 'Function' }>;
    const elemType = elemTypeOf(ctx.receiverType)!;
    const kept: RuntimeValue[] = [];
    for (const el of r.elements) {
      const keep = await ctx.applyFn(fn, [el], [elemType]) as BoolValue;
      if (keep.value) kept.push(el);
    }
    return { type: 'List', elements: kept };
  },
  // 'reduce' always takes an explicit init — no seedless overload that traps
  // on an empty list (stdlib/list.md) — so an empty receiver just returns
  // init untouched, the loop below never running.
  reduce: async (r, args, ctx) => {
    const fn = args[1] as Extract<RuntimeValue, { type: 'Function' }>;
    const elemType = elemTypeOf(ctx.receiverType)!;
    const accType = ctx.argTypes[0]!;
    let acc = args[0]!;
    for (const el of r.elements) {
      acc = await ctx.applyFn(fn, [acc, el], [accType, elemType]);
    }
    return acc;
  },
  find: async (r, args, ctx) => {
    const fn = args[0] as Extract<RuntimeValue, { type: 'Function' }>;
    const i = await findMatchIndex(r.elements, fn, elemTypeOf(ctx.receiverType)!, ctx.applyFn);
    return i === -1 ? NONE : r.elements[i]!;
  },
  findIndex: async (r, args, ctx) => {
    const fn = args[0] as Extract<RuntimeValue, { type: 'Function' }>;
    const i = await findMatchIndex(r.elements, fn, elemTypeOf(ctx.receiverType)!, ctx.applyFn);
    return i === -1 ? NONE : intVal(BigInt(i));
  },
  some: async (r, args, ctx) => {
    const fn = args[0] as Extract<RuntimeValue, { type: 'Function' }>;
    const i = await findMatchIndex(r.elements, fn, elemTypeOf(ctx.receiverType)!, ctx.applyFn);
    return boolVal(i !== -1);
  },
  // 'every' short-circuits on the first mismatch — the empty-list identity
  // (True, stdlib/list.md) falls out for free since the loop never runs.
  every: async (r, args, ctx) => {
    const fn = args[0] as Extract<RuntimeValue, { type: 'Function' }>;
    const elemType = elemTypeOf(ctx.receiverType)!;
    for (const el of r.elements) {
      const keep = await ctx.applyFn(fn, [el], [elemType]) as BoolValue;
      if (!keep.value) return boolVal(false);
    }
    return boolVal(true);
  },
  count: async (r, args, ctx) => {
    const fn = args[0] as Extract<RuntimeValue, { type: 'Function' }>;
    const elemType = elemTypeOf(ctx.receiverType)!;
    let n = 0n;
    for (const el of r.elements) {
      const keep = await ctx.applyFn(fn, [el], [elemType]) as BoolValue;
      if (keep.value) n++;
    }
    return intVal(n);
  },
  // contains/indexOf compare with universal structural '==' (valuesEqual) —
  // the checker has already ruled out a function-containing element type
  // (T0064, in synth.ts), so every element here does have an honest equality.
  contains: (r, args) => boolVal(r.elements.some(el => valuesEqual(el, args[0]!))),
  indexOf: (r, args) => {
    const i = r.elements.findIndex(el => valuesEqual(el, args[0]!));
    return i === -1 ? NONE : intVal(BigInt(i));
  },
  // The checker has already proved the element is Comparable (T0066
  // otherwise), so the JS engine's own (synchronous, stable) sort suffices —
  // no need for sortWith's async merge sort.
  sort: r => ({ type: 'List', elements: [...r.elements].sort(naturalCompare) }),
  // Decorate-sort-undecorate: each key is computed once (sequentially, like
  // every other callback-taking method here — not Promise.all, so a key
  // function's evaluation order matches a beginner's "runs once per element"
  // model) rather than recomputed on every comparison during the sort.
  sortBy: async (r, args, ctx) => {
    const fn = args[0] as Extract<RuntimeValue, { type: 'Function' }>;
    const elemType = elemTypeOf(ctx.receiverType)!;
    const decorated: { el: RuntimeValue; key: RuntimeValue }[] = [];
    for (const el of r.elements) {
      decorated.push({ el, key: await ctx.applyFn(fn, [el], [elemType]) });
    }
    decorated.sort((a, b) => naturalCompare(a.key, b.key));
    return { type: 'List', elements: decorated.map(d => d.el) };
  },
  sortWith: async (r, args, ctx) => {
    const fn = args[0] as Extract<RuntimeValue, { type: 'Function' }>;
    const elemType = elemTypeOf(ctx.receiverType)!;
    const cmp = async (a: RuntimeValue, b: RuntimeValue): Promise<number> => {
      const ordering = await ctx.applyFn(fn, [a, b], [elemType, elemType]) as Extract<RuntimeValue, { type: 'Record' }>;
      return ordering.name === 'Less' ? -1 : ordering.name === 'Greater' ? 1 : 0;
    };
    return { type: 'List', elements: await asyncMergeSort(r.elements, cmp) };
  },
  min: r => r.elements.length === 0 ? NONE : r.elements.reduce((a, b) => naturalCompare(a, b) <= 0 ? a : b),
  max: r => r.elements.length === 0 ? NONE : r.elements.reduce((a, b) => naturalCompare(a, b) >= 0 ? a : b),
  append: (r, args, ctx) => {
    const toElem = elemTypeOf(ctx.resultType);
    return {
      type: 'List',
      elements: [...widenAll(r.elements, elemTypeOf(ctx.receiverType), toElem), widen(args[0]!, ctx.argTypes[0]!, toElem)],
    };
  },
  prepend: (r, args, ctx) => {
    const toElem = elemTypeOf(ctx.resultType);
    return {
      type: 'List',
      elements: [widen(args[0]!, ctx.argTypes[0]!, toElem), ...widenAll(r.elements, elemTypeOf(ctx.receiverType), toElem)],
    };
  },
  concat: (r, args, ctx) => {
    const toElem = elemTypeOf(ctx.resultType);
    const other = args[0] as ListValue;
    return {
      type: 'List',
      elements: [
        ...widenAll(r.elements, elemTypeOf(ctx.receiverType), toElem),
        ...widenAll(other.elements, elemTypeOf(ctx.argTypes[0]!), toElem),
      ],
    };
  },
};

// design.md §4: a Range is Int-only and half-open. length/toList/contains
// read its stored bounds directly — an empty range (lo >= hi) has length 0,
// an empty toList, and contains nothing.
const RANGE_IMPLS: Record<string, MethodImpl<RangeValue>> = {
  length: r => intVal(r.hi > r.lo ? r.hi - r.lo : 0n),
  toList: r => {
    const elements: RuntimeValue[] = [];
    for (let i = r.lo; i < r.hi; i++) elements.push(intVal(i));
    return { type: 'List', elements };
  },
  contains: (r, args) => {
    const x = (args[0] as IntValue).value;
    return boolVal(r.lo <= x && x < r.hi);
  },
};

// Each group is written with its receiver narrowed (IntValue, ListValue, …);
// the cast to the erased MethodImpl is sound because evalMethodCall only
// invokes METHOD_IMPLS[receiver.type], so the receiver always matches the key.
export const METHOD_IMPLS: Partial<Record<RuntimeValue['type'], Record<string, MethodImpl>>> = {
  Int: INT_IMPLS as Record<string, MethodImpl>,
  Float: FLOAT_IMPLS as Record<string, MethodImpl>,
  Bool: BOOL_IMPLS as Record<string, MethodImpl>,
  String: STRING_IMPLS as Record<string, MethodImpl>,
  List: LIST_IMPLS as Record<string, MethodImpl>,
  Range: RANGE_IMPLS as Record<string, MethodImpl>,
};

// '.orAbort(msg?)' unwraps a Result/Optional's good case or crashes on its bad
// one (whitepaper §9). It dispatches on the *static* box type in ctx, not the
// receiver's runtime type: a Result is a Success/Failure Record, and a present
// Optional is just its bare value, so neither has a METHOD_IMPLS key — and an
// 'Optional<T orfail E>' whose present value is itself a Failure must not be
// mistaken for a failed Result, which is exactly why the static kind decides.
// The optional message augments the crash (parenthesized), never replaces it.
const evalOrAbort = (receiver: RuntimeValue, args: RuntimeValue[], ctx: MethodCtx): RuntimeValue => {
  const message = args.length === 1 ? (args[0] as StringValue).value : null;
  const context = message === null ? '' : ` (${message})`;

  if (ctx.receiverType.kind === 'Optional') {
    // A present Optional is already the bare value (no wrapper, §4); only None
    // has nothing to unwrap, so it aborts (R0010).
    if (receiver.type === 'None') {
      throw new RuntimeError({ code: 'R0010', span: ctx.span, data: { context } });
    }
    return receiver;
  }
  // Result: a Success unwraps to its 'value'; a Failure aborts, reporting the
  // carried error — the most informative thing there is (R0009).
  const rec = receiver as Extract<RuntimeValue, { type: 'Record' }>;
  if (rec.name === 'Failure') {
    throw new RuntimeError({
      code: 'R0009', span: ctx.span,
      data: { error: valueToString(rec.fields.get('error')!), context },
    });
  }
  return rec.fields.get('value')!;
};

// The one lookup-and-apply rule. Both lookups are total by construction (the
// checker proved the receiver has this method), so a miss is an internal
// invariant violation, not a user error.
export const evalMethodCall = async (
  receiver: RuntimeValue, method: string, args: RuntimeValue[], ctx: MethodCtx,
): Promise<RuntimeValue> => {
  // orAbort is the one method not in METHOD_IMPLS — it's polymorphic over
  // Result/Optional, whose runtime values carry no distinguishing type, so it
  // dispatches on the static receiver type instead (see evalOrAbort).
  if (method === 'orAbort' && (ctx.receiverType.kind === 'Result' || ctx.receiverType.kind === 'Optional')) {
    return evalOrAbort(receiver, args, ctx);
  }
  const impls = METHOD_IMPLS[receiver.type];
  if (impls === undefined) throw new Error(`internal: ${receiver.type} has no methods`);
  const impl = impls[method];
  if (impl === undefined) throw new Error(`internal: ${receiver.type} has no method '${method}'`);
  return await impl(receiver, args, ctx);
};
