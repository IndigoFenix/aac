// shared/world-engine/kernel/means-ends.ts
//
// ⚖️ MEANS-ENDS CHAINING — THE SCHEMA VOCABULARY AND ITS THREE VALIDATORS
// (planning-docs/games/world-engine/emergent-plans-round.md D1/D4;
// elemental-actions-emergent-plans.md §1 "one generative mechanism", §3.2 "a
// DATA table of action schemas", §5 "bounded + terminating").
//
// IMPORT-FREE ON PURPOSE, and with no imports of ANY kind — not even types.
// `kernel/town/pull-labor.ts` is import-free by law (`:1-20`) and
// `interaction/behavior/action-planner.ts` sits on the other side of the
// engine; both must be able to import this module without opening a cycle, so
// this module imports nothing at all and depends on nothing but TypeScript.
//
// ---------------------------------------------------------------------------
// WHAT IT IS, AND WHAT IT DELIBERATELY IS NOT
// ---------------------------------------------------------------------------
//
// An `Operator` row says ONE thing: *this elemental action makes THAT predicate
// kind true, and these predicate kinds must hold first.* That is the whole
// schema language. The functions below answer three questions ABOUT a schema
// (is it acyclic? how deep? what is unreachable?) and ONE question about a
// schema plus a state (what is the frontier?).
//
// It PLANS NOTHING and RESERVES NOTHING. There is no search, no RNG, no world:
// a caller hands in rows and a `holds` predicate and gets an answer back. The
// two grains of the engine instantiate it separately and keep their own
// runtimes (elemental-actions §8's own revision: "share the VOCABULARY and the
// compile discipline, keep the runtimes native to their level").
//
// 🚨 PRIMITIVES-ONLY. Every `K` this module ever sees is a PREDICATE KIND
// (`"holding"`, `"staged"`) — never a world kind id (`"apple"`, `"oak"`). A row
// that names a thing has already broken the law before it reaches here, and no
// validator can catch that for you; it is the caller's contract.
//
// ---------------------------------------------------------------------------
// THE DEPTH CAP — the first implementation of §5's "bounded" invariant
// ---------------------------------------------------------------------------
//
// Until now termination rested entirely on the operator graph being acyclic BY
// HAND (`action-planner.ts:16-17`, and Scout C's finding that no depth cap or
// max-steps constant exists anywhere under `shared/world-engine`). A traversal
// here THROWS past `MAX_MEANS_ENDS_DEPTH` rather than truncating: a schema that
// recurses is a BUG in the schema, and a silently shortened plan would hide it
// behind a body that simply never finishes its errand.

/**
 * ONE operator row: the elemental action `link` makes `achieves` true, once
 * every kind in `needs` already holds.
 *
 * `K` = the predicate-kind vocabulary of a grain (the planner's
 * `Predicate["kind"]`, the cascade's stock kinds). `L` = the link/action name
 * (a `GoalStep["kind"]`, a `ContributeLink`).
 *
 * Several rows MAY share an `achieves` — those are OR-alternatives, and their
 * SCHEMA ORDER is the tie-break every consumer here honours (FIRST-WINS).
 */
export interface Operator<K extends string, L extends string = string> {
  /** The elemental action / cascade link this row IS ("pick", "haul"). */
  readonly link: L;
  /** The predicate KIND its effect makes true. */
  readonly achieves: K;
  /** The predicate KINDS that must hold first, in regression order. */
  readonly needs: readonly K[];
}

/**
 * The traversal bound. Six is deliberately generous — the two shipped schemas
 * are 3 deep (T1 `in → holding → near`; T2 `build → haul → refine → fell`) and
 * Stage 3's shut-box edge takes T1 to 4 — so reaching it means a schema recurses
 * or a chain grew past anything a body could plausibly execute.
 *
 * 🚨 EXCEEDING IT THROWS. Never truncate: a truncated plan is a body that walks
 * off and quietly never arrives, which is exactly the class of bug the cap is
 * here to surface.
 */
export const MAX_MEANS_ENDS_DEPTH = 6;

/** What `validateOperators` reports about a schema. */
export interface OperatorReport<K extends string> {
  /** No operator can (transitively) require its own effect. */
  readonly acyclic: boolean;
  /** The most rows any single regression chain passes through — 1 for a schema
   *  of pure leaves, 3 for `in → holding → near`. Counted in ROWS, not edges,
   *  so it reads as "how many actions deep can this world plan". When the graph
   *  is cyclic this is the longest SIMPLE (non-repeating) chain. */
  readonly longestPath: number;
  /** Predicate kinds some row NEEDS that NO row ACHIEVES — the schema's
   *  primitive facts (`seat`, `standing`) when they are meant to be, and a
   *  missing operator when they are not. Sorted, de-duplicated. */
  readonly unreachable: readonly K[];
}

/** Index rows by the kind they achieve, preserving schema order within a kind. */
function byAchieves<K extends string, L extends string>(
  ops: readonly Operator<K, L>[],
): Map<K, Operator<K, L>[]> {
  const m = new Map<K, Operator<K, L>[]>();
  for (const op of ops) {
    const list = m.get(op.achieves);
    if (list) list.push(op);
    else m.set(op.achieves, [op]);
  }
  return m;
}

/**
 * The three structural questions about a schema, answered in one pass.
 *
 * ⚖️ NEVER THROWS. This is the function a test or a boot asks "is my schema
 * sane?", so a cyclic schema must come back REPORTED, not exploded — the
 * throwing is `depthOf`/`frontier`'s job, where a cycle would otherwise run
 * forever.
 */
export function validateOperators<K extends string, L extends string>(
  ops: readonly Operator<K, L>[],
): OperatorReport<K> {
  const index = byAchieves(ops);
  let acyclic = true;
  let longestPath = 0;

  // Longest SIMPLE chain from each row, with the path itself as the visited set
  // (a kind may legitimately be needed by two different branches; only a repeat
  // ON THE CURRENT PATH is a cycle).
  const walk = (op: Operator<K, L>, onPath: Set<K>): number => {
    if (onPath.has(op.achieves)) {
      acyclic = false;
      return 0; // stop — the caller already counted this rung
    }
    onPath.add(op.achieves);
    let deepest = 0;
    for (const need of op.needs) {
      for (const producer of index.get(need) ?? []) {
        const d = walk(producer, onPath);
        if (d > deepest) deepest = d;
      }
    }
    onPath.delete(op.achieves);
    return deepest + 1;
  };

  for (const op of ops) {
    const d = walk(op, new Set<K>());
    if (d > longestPath) longestPath = d;
  }

  const unreachable = new Set<K>();
  for (const op of ops) for (const need of op.needs) if (!index.has(need)) unreachable.add(need);

  return { acyclic, longestPath, unreachable: [...unreachable].sort() };
}

/** Options shared by the two traversing entry points. */
export interface MeansEndsOpts {
  /** Traversal bound; exceeding it THROWS. Default `MAX_MEANS_ENDS_DEPTH`. */
  readonly maxDepth?: number;
}

/**
 * THE TOPOLOGICAL DISTANCE of every link from `root` — "how far downstream of
 * the goal does this action sit".
 *
 * The link(s) achieving `root` are depth 0; a link achieving something THOSE
 * rows need is depth 1; and so on. A kind reachable by several routes takes the
 * LONGEST one, because "most downstream" is what a cascade decider means by
 * depth: a link that can be needed three rungs below the goal IS three rungs
 * below it, whatever shorter route also exists.
 *
 * Links whose `achieves` is not reachable from `root` are ABSENT from the
 * record — they are not part of this goal's tree and a depth for them would be
 * a fiction. (`validateOperators().unreachable` reports the other direction:
 * kinds nobody produces.)
 *
 * 🚨 THROWS past `maxDepth` — which is also what catches a cyclic schema here,
 * since a cycle has no finite longest path.
 */
export function depthOf<K extends string, L extends string>(
  ops: readonly Operator<K, L>[],
  root: K,
  opts?: MeansEndsOpts,
): Record<L, number> {
  const kindDepth = kindDepths(ops, root, opts);
  // Two rows MAY share one link (the same cascade link reached by two
  // provenances). A link's depth is then the DEEPEST of its rows, so a rank
  // read off this record still means "most downstream".
  const out = {} as Record<L, number>;
  for (const op of ops) {
    const d = kindDepth.get(op.achieves);
    if (d === undefined) continue;
    const had = out[op.link];
    out[op.link] = had === undefined || d > had ? d : had;
  }
  return out;
}

/** The shared traversal behind `depthOf` and `frontier`: how far downstream of
 *  `root` each PREDICATE KIND sits. Kinds absent from the map are not in the
 *  root's tree at all. Kept internal because the KIND is the honest unit — a
 *  link may be shared by two rows, a predicate never is. */
function kindDepths<K extends string, L extends string>(
  ops: readonly Operator<K, L>[],
  root: K,
  opts?: MeansEndsOpts,
): Map<K, number> {
  const max = opts?.maxDepth ?? MAX_MEANS_ENDS_DEPTH;
  const index = byAchieves(ops);
  const kindDepth = new Map<K, number>();

  // DEEPEST-WINS relaxation from the root down: a kind is re-expanded only when
  // a LONGER route to it is found, so a diamond costs one extra pass and a
  // genuine cycle keeps deepening until the cap fires — which is precisely how
  // a recursive schema is caught here without a separate cycle check.
  const visit = (kind: K, depth: number, onPath: readonly K[]): void => {
    if (depth > max) {
      throw new Error(
        `means-ends: schema exceeds maxDepth ${max} at "${kind}" (path ${[...onPath, kind].join(" → ")})` +
          ` — a recursive schema is a bug, never a silently truncated plan`,
      );
    }
    const seen = kindDepth.get(kind);
    if (seen !== undefined && seen >= depth) return; // already recorded at least this deep
    kindDepth.set(kind, depth);
    const next = [...onPath, kind];
    for (const op of index.get(kind) ?? []) {
      for (const need of op.needs) visit(need, depth + 1, next);
    }
  };
  visit(root, 0, []);
  return kindDepth;
}

/**
 * THE MEANS-ENDS FRONTIER: the links whose OWN needs all hold but whose effect
 * does not — the actions that can be taken RIGHT NOW toward `root`.
 *
 * That is the doc's §1 rule in one line, and it is exactly what the contribute
 * cascade means by "the most downstream link whose input is available": a link
 * only surfaces when the thing it produces is missing and the thing it consumes
 * is there.
 *
 * ORDER IS THE CONTRACT — root-nearest first (ascending `depthOf`), ties broken
 * by SCHEMA ORDER, first-wins. A decider that reads `[0]` gets the same choice
 * the hand-written rank table gave it.
 *
 * Only links reachable from `root` are considered; `holds` is called at most
 * once per distinct kind, so an expensive world read costs one lookup.
 */
export function frontier<K extends string, L extends string>(
  ops: readonly Operator<K, L>[],
  root: K,
  holds: (kind: K) => boolean,
  opts?: MeansEndsOpts,
): L[] {
  // Keyed by PREDICATE KIND, not by link: `moveTo` achieves both `at` and
  // `near`, and only one of them may be in this goal's tree.
  const depth = kindDepths(ops, root, opts);
  const memo = new Map<K, boolean>();
  const truth = (kind: K): boolean => {
    const hit = memo.get(kind);
    if (hit !== undefined) return hit;
    const v = holds(kind);
    memo.set(kind, v);
    return v;
  };
  const ranked: { link: L; depth: number; order: number }[] = [];
  ops.forEach((op, order) => {
    const d = depth.get(op.achieves);
    if (d === undefined) return; // not in this goal's tree
    if (truth(op.achieves)) return; // already true — nothing to do
    for (const need of op.needs) if (!truth(need)) return; // a precondition is missing
    ranked.push({ link: op.link, depth: d, order });
  });
  ranked.sort((a, b) => (a.depth !== b.depth ? a.depth - b.depth : a.order - b.order));
  return ranked.map((r) => r.link);
}
