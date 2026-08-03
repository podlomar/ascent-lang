import type { TypeEnv } from './env.js';
import { type AscentType, INT_TYPE, isScalarType } from '../types/types.js';

// ---- Intrinsic traits (compiler-known capabilities) -------------------
//
// A trait names a capability a type may have. These are *intrinsic*: the
// compiler knows a fixed set and which built-in types satisfy each — there is
// no user-facing `trait`/`impl` syntax yet (whitepaper §15/§16). They give a
// name, and one place to check, to the "hard-coded bound" the language already
// leans on — so a bound can appear in a signature (`print<T: Display>`) instead
// of being re-open-coded at each call. No generics ride along: a bound only
// ever *constrains* an argument, it never escapes into a result, so `satisfies`
// is a plain predicate, not type inference.

// Display: "has a canonical text form" — the bound on an interpolation hole and
// on print's argument. Today exactly the built-in scalars satisfy it
// (Int/Float/Bool/String), the same set `isScalarType` picks out; when a real
// trait system lands this becomes ordinary dispatch instead of a fixed rule.
//
// Comparable: "can be ordered" — the bound on the stdlib 'math' module's min/max
// (whitepaper §10; 🔒 scalar-hardcoded until a real trait system lands, §15). The
// orderable scalars are exactly those '<'/'>' already accept (§5): Int, Float,
// and String — not Bool, which has no order.
//
// Iterable: "can be walked one element at a time" — the bound a 'for x in xs'
// loop puts on `xs` (whitepaper §5/§7; 🔒 hardcoded to List | Range until a real
// trait system, §16). It is the trait that *forces an associated type*: unlike
// Display/Comparable, satisfying it isn't a bare yes/no — the loop also needs the
// *element* type each pass yields (`xs`'s `Item`, in trait terms), which a plain
// predicate can't hand back. So Iterable's membership is *derived* from that
// projection (iterableElement below): a type is Iterable exactly when it has an
// Item.
//
// Hashable: "usable as a Dict key / Set element" — the bound Dict's key type and
// Set's element type carry (whitepaper §7; 🔒 hardcoded like the other three,
// until a real trait system lands). It is the odd one out twice over. First it is
// *structural*: the other three name a fixed list of implementor types, while
// Hashable is a predicate over a type's **shape** — the scalars hash (the base
// case) and every composite hashes exactly when its parts do, bottoming out at
// scalars. That is what makes a user record a valid key automatically, by being
// built of hashable parts, with no `implement` to write (v2's trait system adds
// *manual* implementation on top, never this structural default). Second, it is
// the one trait that needs the type registry: a Named type's fields live in
// TypeEnv rather than on the AscentType itself, so its predicate takes an `env`
// the other three have no use for — which is why it is `isHashable` below rather
// than a fourth case in `satisfies`.
export type Trait = 'Display' | 'Comparable' | 'Iterable' | 'Hashable';

// The traits whose membership is a plain, environment-free question — and so
// exactly the ones a builtin signature can carry as a bound (`print<T: Display>`,
// see signatures.ts's TraitBound). Hashable is excluded *by construction* rather
// than by convention: deciding it needs a TypeEnv, which a METHODS/FUNCTIONS
// resolver is never handed, so `{ bound: 'Hashable' }` must not typecheck.
export type BoundTrait = Exclude<Trait, 'Hashable'>;

// Iterable's associated type, `Item` — the type a 'for x in xs' loop binds each
// pass. `null` when `t` can't be iterated (the loop then reports T0021). This is
// the projection a real trait system would spell `<T as Iterable>::Item`; here
// its two implementors are hardcoded — a `List<T>` yields its element `T`, a
// `Range` yields `Int` — the same "hard-coded until traits land" state Display
// and Comparable are in, but carrying a *type out* rather than only a bound in
// (which is exactly what makes Iterable the harder of the three).
export const iterableElement = (t: AscentType): AscentType | null => {
  if (t.kind === 'List') return t.elem;
  if (t.kind === 'Range') return INT_TYPE;
  return null;
};

// Whether a type satisfies one of the environment-free traits. One `switch` case
// per trait keeps each trait's membership in a single spot; adding a trait adds a
// case here. Iterable's case defers to its associated-type projection — having an
// `Item` *is* being iterable — so the two can never disagree. Hashable is not
// here (and `BoundTrait` makes asking for it a type error): it needs a TypeEnv,
// so it is `isHashable` below.
export const satisfies = (trait: BoundTrait, t: AscentType): boolean => {
  switch (trait) {
    case 'Display': return isScalarType(t);
    case 'Comparable': return t.kind === 'Int' || t.kind === 'Float' || t.kind === 'String';
    case 'Iterable': return iterableElement(t) !== null;
  }
};

// Whether `ty` can be a Dict key / Set element — the structural, recursive
// predicate described above. `seen` guards a self-referential declaration
// ('type Tree = { kids: List<Tree> }') from looping: a name already being decided
// answers yes, so the verdict rests on the rest of the shape (the same fixpoint
// synth.ts's typeContainsFunction takes, and the reason both walks live beside
// the registry rather than in types.ts with containsNever/containsBareNone).
//
// The switch is deliberately exhaustive, with no `default`: Dict and Set are
// precisely the two kinds that must NOT be hashable (unordered, so no stable
// structural hash — they cannot be keys), and when they land as AscentType kinds
// a missing case makes this stop compiling rather than silently admitting them.
export const isHashable = (ty: AscentType, env: TypeEnv, seen: Set<string> = new Set()): boolean => {
  switch (ty.kind) {
    // The base case: every scalar hashes. Float included — NaN and Infinity are
    // runtime errors rather than values (whitepaper §4), so every Float is a real
    // number and hashing it agrees with '==' on it.
    case 'Int': case 'Float': case 'Bool': case 'String': return true;
    // A Range is a pair of Int bounds compared structurally (valuesEqual), so it
    // hashes exactly like the two scalars it is made of.
    case 'Range': return true;
    // Done is a singleton — one value, equal to itself — so it hashes trivially.
    // A 'Dict<Done, V>' is degenerate, not unsound, and carving it out would be a
    // rule nothing in the language states.
    case 'Done': return true;
    // Never is uninhabited, so "every value of it hashes" holds vacuously — and
    // it widens into any T, so refusing it here would reject a perfectly hashable
    // type that merely arrived through '[]'/'None' for no gain.
    case 'Never': return true;
    // Invalid absorbs in both directions (types.ts): a sub-expression that
    // already reported its own failure answers yes, so a key check never piles a
    // second, cascaded diagnostic on top of the one already given.
    case 'Invalid': return true;
    // Composites hash exactly when their components do: a List in element order
    // (whitepaper §7); an Optional through its present type, since None is only
    // the absent case and there is no Some(...) wrapper to hash around it; and
    // Result/Pair/Entry through both of their sides.
    case 'List': return isHashable(ty.elem, env, seen);
    case 'Optional': return isHashable(ty.elem, env, seen);
    case 'Result': return isHashable(ty.ok, env, seen) && isHashable(ty.err, env, seen);
    case 'Pair': return isHashable(ty.first, env, seen) && isHashable(ty.second, env, seen);
    case 'Entry': return isHashable(ty.key, env, seen) && isHashable(ty.value, env, seen);
    // A record or union hashes iff every field of every variant does — the rule
    // that makes a user type a valid key by construction. A fieldless variant has
    // nothing to refuse, so a braceless enum (prelude.md's ambient 'Ordering') is
    // hashable. An unregistered name can only be one the checker already reported
    // as unknown, so it answers like Invalid: yes, no second diagnostic.
    case 'Named': {
      if (seen.has(ty.name)) return true;
      seen.add(ty.name);
      const info = env.getType(ty.name);
      return info === null || info.variants.every(v => v.fields.every(f => isHashable(f.type, env, seen)));
    }
    // The two carve-outs. A function has no equality, so it has no hash — the
    // same rule '==' enforces (T0064, whitepaper §5), and just as true buried in
    // a record field as it is bare. A Task is inert running work with no
    // structural sense either (valuesEqual reports two as never equal), so keying
    // on one would build a Dict whose entries could never be found again.
    case 'Function': return false;
    case 'Task': return false;
  }
};
