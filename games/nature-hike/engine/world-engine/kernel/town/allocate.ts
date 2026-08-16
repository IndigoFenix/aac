// shared/world-engine/kernel/town/allocate.ts
//
// ONE CONSERVING PROPORTIONAL ALLOCATOR shared by three siblings that already
// documented each other before this pass:
//  · city-districts.ts `allocateDistrictFill` — continuous FILL RATIOS across
//    a city's districts (a fixed floor fraction of the site's fair share,
//    remainder poured nearest-producer-first, capped).
//  · scope-shape.ts `allocateHands` — continuous absolute UNITS across a
//    scope's claims on its own hands (an even floor, remainder poured in the
//    caller's own claim order, capped at each claim).
//  · trade.ts `allotmentSplit` — INTEGER units across a cargo's kinds,
//    classic largest-remainder apportionment.
//
// All three share ONE shape: floor every claimant, then POUR the leftover
// supply in some order until either the supply or the claimants' room runs
// out — Σ output === the supply consumed, exactly, by construction. This
// file writes the pour ONCE (`pourOrdered`) and each sibling's floor policy
// as a named branch of `allocate()`; each original function (still defined,
// under its original name, in its original file) becomes a thin,
// parameterized call back into it — with its EXACT original numeric
// behavior, float sequencing included, so results stay bit-for-bit
// identical, not just equal in aggregate.
//
// Kernel layering: pure arithmetic, no imports.

/**
 * Visit `order` in sequence, giving candidate `i` up to `roomOf(i)` out of
 * whatever supply remains, until either the order or the supply runs out.
 * The ONE loop shape all three allocators repeat (nearest-supply-first,
 * caller-index-first, largest-fractional-remainder-first) — `give` performs
 * the caller's own bookkeeping (a ratio increment, an absolute add, a
 * largest-remainder +1) so each policy's exact arithmetic sequencing
 * survives untouched. Returns what's left of `remaining` afterward (0 when
 * the pour exhausted the supply before the order did).
 */
function pourOrdered(
  order: readonly number[],
  roomOf: (i: number) => number,
  remaining: number,
  give: (i: number, amount: number) => void,
): number {
  let left = remaining;
  for (const i of order) {
    if (left <= 1e-12) break;
    const room = roomOf(i);
    const take = Math.min(room, left);
    if (take > 0) {
      give(i, take);
      left -= take;
    }
  }
  return left;
}

export type AllocatePolicy =
  | {
      /** city-districts.ts `allocateDistrictFill` — continuous per-claimant
       *  FILL RATIO in [0,1]. Every claimant is floored at `floorFrac × fair`
       *  (a share of `fair` proportional to its own `needs[i]`, since fill is
       *  a RATIO); the remainder pours by `supplyDist` ascending (ties by
       *  index) into headroom capped at `min(1, fair + spread)`, then a
       *  second pass spreads whatever cap headroom is left (only bites when
       *  `fair` is ≈ 1) up to a ratio of 1 — the allocator stays Σ-exact
       *  even there. */
      mode: "fair-floor";
      needs: readonly number[];
      supplyDist: readonly number[];
      fair: number;
      floorFrac: number;
      spread: number;
    }
  | {
      /** scope-shape.ts `allocateHands` — continuous absolute UNITS. An EVEN
       *  floor (`supply / n`, capped per claimant) guarantees no claim is
       *  starved for being late in the order; the remainder pours in the
       *  caller's OWN order (index 0..n-1) up to each claimant's cap. */
      mode: "even-floor";
      caps: readonly number[];
      supply: number;
    }
  | {
      /** trade.ts `allotmentSplit` — INTEGER units, classic
       *  largest-remainder apportionment: floor each weighted share, then
       *  deal the leftover units one at a time to the largest fractional
       *  remainders (ties toward the lower index). */
      mode: "largest-remainder";
      weights: readonly number[];
      total: number;
    };

/** THE core: one conserving proportional split, three parameterizations —
 *  see {@link AllocatePolicy} for which existing function each mode is. */
export function allocate(policy: AllocatePolicy): number[] {
  switch (policy.mode) {
    case "fair-floor":
      return allocateFairFloor(policy);
    case "even-floor":
      return allocateEvenFloor(policy);
    case "largest-remainder":
      return allocateLargestRemainder(policy);
  }
}

function allocateFairFloor(p: {
  needs: readonly number[];
  supplyDist: readonly number[];
  fair: number;
  floorFrac: number;
  spread: number;
}): number[] {
  const { needs, supplyDist, fair, floorFrac, spread } = p;
  const n = needs.length;
  if (n === 0) return [];
  const totalNeed = needs.reduce((a, b) => a + b, 0);
  if (!(totalNeed > 0)) return needs.map(() => fair);
  const got = fair * totalNeed;

  const floor = fair * floorFrac;
  const cap = Math.min(1, fair + spread);
  const fill = needs.map(() => floor);
  const remaining0 = got - floor * totalNeed;

  const order = needs.map((_, i) => i).sort((a, b) => supplyDist[a] - supplyDist[b] || a - b);
  const remaining1 = pourOrdered(
    order,
    (i) => needs[i] * (cap - fill[i]),
    remaining0,
    (i, take) => { fill[i] += take / needs[i]; },
  );
  // Cap headroom left rations undealt (only when fair ≈ 1): deal them
  // round-robin up to 1 so the allocator stays exact.
  pourOrdered(
    order,
    (i) => needs[i] * (1 - fill[i]),
    remaining1,
    (i, take) => { fill[i] += take / needs[i]; },
  );
  return fill;
}

function allocateEvenFloor(p: { caps: readonly number[]; supply: number }): number[] {
  const { caps, supply: free } = p;
  const n = caps.length;
  if (n === 0) return [];
  const want = caps.map((c) => Math.max(0, c));
  const supply = Math.max(0, free);
  const demand = want.reduce((a, b) => a + b, 0);
  if (supply >= demand) return want;
  const even = supply / n;
  const out = want.map((c) => Math.min(c, even));
  const order = out.map((_, i) => i);
  const remaining = supply - out.reduce((a, b) => a + b, 0);
  pourOrdered(order, (i) => want[i] - out[i], remaining, (i, take) => { out[i] += take; });
  return out;
}

function allocateLargestRemainder(p: { weights: readonly number[]; total: number }): number[] {
  const { weights, total } = p;
  const n = weights.length;
  if (n === 0) return [];
  const units = Math.max(0, Math.floor(total));
  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  let sum = w.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) {
    w.fill(1);
    sum = n;
  }
  const exact = w.map((x) => (units * x) / sum);
  const out = exact.map((x) => Math.floor(x));
  const left = units - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
    .map((o) => o.i);
  pourOrdered(order, () => 1, left, (i, take) => { out[i] += take; });
  return out;
}
