# Ascent Stdlib — `list`

### Methods on `List<T>`

> `List<T>` is a **homogeneous, immutable** sequence (§4). Every method returns a **new** value — a list, or a single result — never mutating the receiver; "changing" a list is rebinding a `mut` slot (§3). The method set is **curated, not exhaustive**: it is the answer to "what would a beginner otherwise write as a fragile hand-rolled loop?", and every method either **names such a pattern** or **returns the honest type** (`find → T?`, not a sentinel). The cuts are as deliberate as the inclusions — see the end.
>
> Neighbours: `min` / `max` here return `T?` (over a *collection*); the two-value `math.min(a, b)` is in `scalars.md`. Building strings from a list is `join`, which lives here (the receiver is the list). Callbacks are **synchronous** — a sync method rejects an `async Fn` (§8); async-over-collection waits for the concurrency chapter.

---

## The inclusion test

A method earns its place if it **names a pattern a beginner would otherwise write as a buggy loop**, *and* returns the honest type. `filter` earns it (the hand-rolled version is a `mut`, a loop, an `if`, an `append` — four lines, easy to botch). A method that just wraps one operator does not. And a search returns `T?` / `Bool`, never a value-with-a-sentinel — because the return type is where the lesson is.

---

## Access

```
xs[i]                              # language syntax — T, crashes out of bounds (R0005)
(List<T>).at(index: Int): T?       # safe — None if index is out of range
(List<T>).first(): T?              # None if empty
(List<T>).last():  T?              # None if empty
```

- **`xs[i]` is an assertion** that `i` is valid — it returns `T`, and a bad index is the loud bug-tier crash `R0005` (you claimed it was in range and it wasn't). It is *language syntax*, not a method.
- **`at(i)` is the honest lookup** — `T?`, `None` when `i` is out of range. Indices are **non-negative positions from the front only**: `at(-1)` is `None` (a negative index is simply not a valid position — there is no Python-style from-the-end, which would turn an out-of-range bug into a silent wrong element). "The last one" is `last()`, which says what it means.
- **`first` / `last` return `T?`** because an empty list genuinely has neither — absence is a value, not a crash (§9). The crashing forms are `xs[0]` / `xs[xs.length() - 1]`.

## Length & emptiness

```
(List<T>).length():  Int
(List<T>).isEmpty(): Bool
```

Methods, not properties — built-ins expose only methods, the only bare `.name` being a record field (§6). `isEmpty()` reads better than `length() == 0` at a glance.

---

## Transform — the core three

```
(List<T>).map(f: Fn(T) -> U):            List<U>
(List<T>).filter(keep: Fn(T) -> Bool):   List<T>
(List<T>).reduce(init: U, step: Fn(U, T) -> U): U
```

The set that reshapes how a beginner thinks about loops — "do this to each," "keep the ones where," "fold into one value" — and transfers to every language.

- **`reduce` requires an explicit `init`.** There is deliberately **no seedless overload** (the "first element is the seed" form that returns `T?` and traps on empty). One total signature: `[].reduce(0, add)` is `0`, always — no empty-list surprise. (`reduce`, not `fold` — one word for one operation, §1.)
- `map` / `filter` place **no bound on `T`** — the core transformers are unconstrained.

```ascent
fix names  = users.map(fn(u: User): String => u.name);
fix adults = users.filter(fn(u: User): Bool => u.age >= 18);
fix total  = prices.reduce(0.0, fn(sum: Float, p: Float): Float => sum + p);
```

## Search — honest returns

```
(List<T>).find(pred: Fn(T) -> Bool):      T?      # first match, or None
(List<T>).findIndex(pred: Fn(T) -> Bool): Int?    # position of first match, or None
(List<T>).contains(value: T):             Bool
(List<T>).indexOf(value: T):              Int?    # position of first equal value, or None
(List<T>).some(pred: Fn(T) -> Bool):      Bool    # at least one matches
(List<T>).every(pred: Fn(T) -> Bool):     Bool    # all of them match
(List<T>).count(pred: Fn(T) -> Bool):     Int
```

The four searches form a complete square — **value or position**, by **predicate or equality**:

| | returns the **value** | returns the **position** |
|---|---|---|
| by **predicate** | `find(pred): T?` | `findIndex(pred): Int?` |
| by **equality** | `contains(value): Bool` | `indexOf(value): Int?` |

- **`find → T?`** is "the first one where, or `None`" — the honest version of a `break`-on-found loop (and why `break`'s most common use is already covered). Terminate with `??` or `match`.
- **The position forms return `Int?`, never `-1`.** Every language that encodes "not found" as `-1` (JS, Java, C#) is using a sentinel — a real `Int` that flows silently into arithmetic and indexing, so `xs[xs.indexOf(missing)]` becomes `xs[-1]` and crashes far from the actual mistake. `None` forces the miss to be handled, consistent with `find` / `first` / `last` / `at`.
- **`contains` / `indexOf` need no bound** — they use universal structural `==` (§5), so they work on any list of data (a function-containing element type is the `==` carve-out).
- **`some` / `every`** read like English and replace a flag-and-loop. Named for JavaScript/TypeScript's `.some()` / `.every()` — the primary graduation target — rather than Python/Rust's `any` / `all`. `[].some(p)` is `False`, `[].every(p)` is `True` (the empty-list identities, no surprise).
- **`count(pred)`** is `filter(pred).length()`, named because it is common and clearer.

---

## Ends & slices

```
(List<T>).take(n: Int):               List<T>   # first n (saturating)
(List<T>).drop(n: Int):               List<T>   # all but the first n (saturating)
(List<T>).slice(from: Int, to: Int):  List<T>   # half-open [from, to)  (R0006 on a bad bound)
(List<T>).reverse():                  List<T>
```

- `take` / `drop` **saturate** rather than crash — `take(n)` past the end yields the whole list, `drop(n)` past the end yields `[]` (they describe "up to n," not an assertion about length). Same rule as the `String` versions.
- `slice` takes **two indices** (not a `Range`) — matching `String.slice`, and keeping `Range` for its real job, iteration (`for x in 0..n`). `xs[i]` stays **single-index only**; bracket *slicing* (`xs[2..5]`) is deliberately not added, so `[]` means the same thing (one index) on every type.

---

## Two kinds of restriction — absent method vs. unmet bound

Some methods do not apply to every `List<T>`, and they fail in **two different ways** that deserve two different errors. The rule:

> **If the operation is *meaningless* for the element type, the method does not exist there** (missing method, `T0012`).
> **If the operation is *meaningful* but needs a capability the type lacks, the method exists and reports the missing capability** (unmet bound, `T0061`).

| | receiver-specific — **absent** | bounded — **present, bound unmet** |
|---|---|---|
| **Methods** | `sum` (`List<Int>` / `List<Float>` only), `join` (`List<String>` only) | `sort`, `min`, `max` (`T: Comparable`) |
| **`List<String>.sum()`** | **no such method** — `T0012` | — |
| **`List<Player>.sort()`** | — | method exists, `Player` is not `Comparable` — `T0061` |
| **Message shape** | "`List<String>` has no `sum`" (+ *sum works on lists of numbers*) | "`Player` can't be ordered — sort by a key with `sortBy`, or supply a comparator with `sortWith`" |

So **“what is the type of `xs.sum()` when `xs: List<String>`?” has no answer** — the question is malformed, exactly as `True.trim()` has no return type. Dispatch (§10) looks up `sum` on `List<String>`, finds nothing, and reports a missing method. `sum` is simply **two entries in the method table** keyed by concrete receiver (`List<Int> → Int`, `List<Float> → Float`); there is no `List<String>.sum` to have a type. *Summing strings is meaningless*, so the method is absent.

`sort` is the opposite case: it is on **every** `List<T>` — sorting is meaningful for any orderable element — but requires `T: Comparable` (🔒, §7). `List<Player>.sort()` is not a typo or a misuse of dispatch; you called an existing method whose bound the element type does not satisfy. *Sorting players is meaningful but unspecified*, so the method is present and the error names the missing **capability** and points at the two ways to supply it. That better error is the payoff for modelling it as a bound rather than as receiver-specific dispatch.

Both generalise the same way: when a `Numeric` trait exists, `sum` becomes `List<T: Numeric>`; when users can `implement Comparable`, `sort` starts working on their types — in each case **with no change to what any existing program means** (the 🔒-weld guarantee, §7).

## Ordering

```
(List<T>).sort():                          List<T>   # T: Comparable  (T0061 otherwise)
(List<T>).sortBy(key: Fn(T) -> K):         List<T>   # K: Comparable
(List<T>).sortWith(cmp: Fn(T, T) -> Ordering): List<T>
(List<T>).min(): T?                                  # T: Comparable, None if empty
(List<T>).max(): T?                                  # T: Comparable, None if empty
```

- **`sort()`** needs `T: Comparable` (🔒 scalars today, §7) — so it sorts `List<Int>` / `List<Float>` / `List<String>` directly. On any other element type the method still *exists*; the bound is unmet, and `T0061` names the missing capability and redirects to `sortBy` / `sortWith` (see the taxonomy above).
- **`sortBy(key)`** is the one for **records**: `players.sortBy(fn(p: Player): Int => p.score)` sorts by a `Comparable` *key* without `Player` itself being `Comparable` — the common case for user types, which are pure data (no `Comparable` until traits, v2).
- **`sortWith(cmp)`** takes a full comparator returning **`Ordering`** (`Less | Equal | Greater`, prelude) — exhaustive and `match`-able, not the `-1|0|1` magic-number mess. This is where `Ordering` earns its keep (tie-breaking, multi-key sorts).
- **`min` / `max` return `T?`** — an empty list has neither, honestly. Bounded `T: Comparable`, so they fail like `sort` (`T0061`, present-but-unmet) on user records. (Distinct from `math.min(a, b)`, which is two values, in `scalars.md`.)

---

## Combine & build

```
(List<T>).append(value: T):     List<T>            # add at the end
(List<T>).prepend(value: T):    List<T>            # add at the front
(List<T>).concat(other: List<T>): List<T>          # join two lists
(List<T>).zip(other: List<U>):  List<Pair<T, U>>   # pair up, truncating to the shorter
(List<T>).enumerate():          List<Pair<Int, T>> # index-value pairs
(List<String>).join(sep: String): String           # List<String> only
```

- `append` / `prepend` / `concat` are the growth/joining operations — each returns a new list (growth is a rebind of a `mut` slot, §3).
- **`zip`** pairs two lists element-wise into `List<Pair<A, B>>`, truncating to the shorter (no partial pairs). Now that `Pair` exists (prelude), `zip` returns a *named* pair, not a positional tuple.
- **`enumerate`** gives `List<Pair<Int, T>>` — the honest "loop with an index": `for pair in xs.enumerate() { … pair.first … pair.second … }`.
- **`join`** is **receiver-specific** to `List<String>`, turning a list into one string with a separator — the inverse of `String.split`. `List<Int>.join(", ")` is a *missing method* (`T0012`), whose message points at `xs.map(fn(n: Int): String => n.toStr()).join(", ")` — rendering ints is your choice to state, not the library's to guess. It lives here because the receiver is the list.

## Aggregate

```
(List<Int>).sum():   Int
(List<Float>).sum(): Float
```

`sum` is **receiver-specific**: it exists on `List<Int>` and `List<Float>` and *nowhere else* — `List<String>.sum()` is a **missing method** (`T0012`), not a bound violation, because summing strings is meaningless (see the taxonomy above). A hard-coded restriction today, since there is no `Numeric` trait yet. `[].sum()` is `0` / `0.0` (the identity, no empty surprise).

---

## Deliberately cut (and why)

- **`forEach`** — use `for x in xs { … }`. A `forEach` method is a redundant second spelling that also tempts side-effects-in-a-callback and fights the "loops are statements" model (§5). The language already has the loop.
- **`fold`** — a synonym for `reduce`; ship one word (§1).
- **seedless `reduce`** — the overload that returns `T?` and traps on empty; `reduce` always takes an explicit `init`, so it is total.
- **`flatMap` / `flatten`** — nested lists are an advanced shape; deferred until a real lesson needs them (and they are where the monad peeks through, which stays hidden).
- **`distinct` / `unique`** — possible now (universal `==`), but O(n²) without a `Hashable` fast path and rare for beginners; deferred to the `Hashable`-aware growth.
- **`groupBy` / `partition`, `chunk`, `windows`, `scan`, `takeWhile` / `dropWhile`** — the power-user tier; `groupBy` also needs `Dict`. Add when a concrete lesson calls for them, not day one.

---

## Shipped in v0.1

Live today: **`length()`, `isEmpty()`, `reverse`, `append`, `prepend`, `concat`, `at`, `first`, `last`, `take`, `drop`, `slice`, `map`, `filter`, `reduce`, `find`, `findIndex`, `contains`, `indexOf`, `some`, `every`, `count`**, and indexing `xs[i]` (`R0005`).

Planned catalog growth (table entries, no language change): **`sort`, `sortBy`, `sortWith`, `min`, `max`, `zip`, `enumerate`, `join`, `sum`.**

---

## Settled decisions

- **Curated, not exhaustive** — every method names a buggy-loop pattern and returns the honest type; `forEach` / `indexOf` / `fold` / seedless-`reduce` / `flatMap` / `distinct` are cut or deferred with reasons above.
- **Honest returns everywhere** — `find` / `first` / `last` / `min` / `max` → `T?`; `at` → `T?`; **`findIndex` / `indexOf` → `Int?`, never `-1`** (a sentinel index flows silently into arithmetic and indexing; `None` forces the miss to be handled). Only `xs[i]` returns bare `T` (and crashes on a bad index, the assertion form).
- **Searches form a complete square** — value or position, by predicate or equality: `find` / `findIndex` / `contains` / `indexOf`. *(`String` still has no `indexOf` — there the objection is different and still stands: a string index would have to commit to a grapheme-vs-codepoint-vs-byte unit. A list index is unambiguously an element position, so lists get it and strings do not.)*
- **Two kinds of restriction, two errors** — *meaningless* for the element type → the method is **absent** (`sum` on `List<String>`, `join` on `List<Int>`; `T0012`); *meaningful but uncapable* → the method is **present with an unmet bound** (`sort` / `min` / `max` on a non-`Comparable`; `T0061`, redirecting to `sortBy` / `sortWith`).
- **Non-negative indices from the front** — `at(-1)` is `None`, `xs[-1]` crashes; "from the end" is `last()`. No Python from-the-end.
- **`sort` needs `Comparable`; `sortBy` needs it on the key; `sortWith` uses `Ordering`.** User records sort via `sortBy` (a key) or `sortWith` (a comparator), since they are not `Comparable` until v2.
- **`slice(from, to)`, two indices; `[]` stays single-index.** No bracket slicing, so `[]` means one index on every type; `Range` stays the iteration tool.
- **Sync callbacks** — a sync method rejects an `async Fn` (§8); async-over-collection is the deferred concurrency chapter, served later by named async combinators, never a color-polymorphic `map`.
- **Immutable — every method returns a new value.** Growth is a `mut` rebind (§3).
