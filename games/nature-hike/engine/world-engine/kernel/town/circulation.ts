/**
 * circulation.ts — CIRCULATION AS SEARCH (§9 slice 4 of
 * household-duties-and-sims-mode.md): how you REACH a private cell stops
 * being an authored topology and becomes a SOLUTION the solver finds.
 * Round 5's ladder (hub-1 · enfilade · Jack-and-Jill · spine) was the
 * hand-solved closed form of exactly this search; its feasibility gates
 * are the solver's CONSTRAINT SET (each is cited below), so everywhere
 * the ladder had an answer the search finds one at least as good — and
 * where the ladder's four shapes ran out (a deep band wanting three
 * cells with no room for a hall), the search composes shapes the ladder
 * never had (a third bedroom CHAINED through the second).
 *
 * THE SEARCH SPACE — a BAND LAYOUT behind the living room:
 *   mode FLAT    cells split the band across u; each cell's ACCESS is a
 *                door on the living partition, or THROUGH an adjacent
 *                cell (via — the enfilade move; two hosts = the
 *                Jack-and-Jill pair).
 *   mode SPINE   a hall strip claims band depth; every cell doors onto
 *                it, free of the partition's chest-clearance bound.
 *
 * SCORING (lexicographic, deterministic — beds are the program, the
 * rest is the cost of reaching them):
 *   1. sleep cells REALIZED (the demand is why the house exists)
 *   2. KITCHEN realized, when the program wants one (round 7 — worth a
 *      hall, never worth a bed: the demand loop above outranks it)
 *   3. circulation AREA (a hall must earn its floor — more beds, a
 *      kitchen — or take the house's hash COIN, the ladder's useSpine
 *      variety draw: with the coin, the spine wins its ties outright)
 *   4. THROUGH-TRAFFIC (Σ door-graph hops beyond the first — crossing a
 *      bedroom to reach another room costs its occupant privacy). Round
 *      7 moved this ABOVE affinity: household rooms door from the public
 *      side whenever the partition allows (the bath-from-a-bedroom
 *      playtest fix); authored cluster affinity now only breaks
 *      same-traffic ties.
 *   5. AFFINITY satisfied (CLUSTERS[*].affinity — unauthored by default
 *      since round 7; the per-town en-suite culture knob)
 *   6. PRIVACY FIT (Σ min(hops, cluster privacy rank) — an enfilade's
 *      far bedroom sits honestly deep)
 *   7. enumeration order (stable first-wins tie-break)
 *
 * GUARDRAILS (§9 design law): SUBDIVISION never packing (cells are floor
 * widths + evenly spread leftover — they tile by construction);
 * feasibility inside the candidate test, not post-hoc repair;
 * deterministic everywhere (fixed hash draws in, first-best out); the
 * microsecond budget (the hot loop allocates nothing per assignment);
 * and the ladder stays available (`ladderBand`) as the fallback and as
 * the benchmark the sweep test measures the search against. Pure and
 * import-light — the metrics arrive as a PARAMETER, so the solver is
 * reusable for non-house programs (the inn multiplies demand; a smithy
 * band has no sleep).
 */

import { CLUSTERS } from "./stations";

/** The passability/clearance quantities the solver constrains against —
 *  rooms.ts passes its HOUSE_METRICS subset. */
export interface BandMetrics {
  doorClear: number;
  /** Optional HIGH-u bound on partition doors, replacing L − doorClear —
   *  a FRONT KITCHEN (round 7, rooms.ts) shrinks the living room from
   *  its high-u end, so the goods chests' corners (what doorClear
   *  protects) move inward with it. */
  doorClearHi?: number;
  doorJamb: number;
  roomDoorW: number;
  bathDoorW: number;
  hallDoorW: number;
  hallW: number;
  bathW: number;
  bedMinW: number;
  bedMinD: number;
}

export type CellAccess =
  /** A door on the living partition (chest-clearance bound applies). */
  | { kind: "partition" }
  /** Door(s) on the shared wall with each host cell (index into cells) —
   *  one host = en-suite/enfilade, two = the Jack-and-Jill pair. */
  | { kind: "via"; hosts: number[] }
  /** A door onto the spine hall. */
  | { kind: "hall" };

export interface CellLayout {
  cluster: "wet" | "sleep" | "kitchen";
  /** Frame-u span (canonical, pre-mirror). */
  u0: number;
  u1: number;
  access: CellAccess;
}

export interface BandLayout {
  mode: "flat" | "spine";
  /** Living-room depth (the spine shrinks it to buy the hall). */
  vSplit: number;
  cells: CellLayout[];
}

export interface BandInput {
  L: number;
  D: number;
  vSplitHub: number;
  /** Sleep cells the program wants (granularity-clamped upstream). */
  demand: number;
  metrics: BandMetrics;
  /** The house's fixed hash draw — the spine variety coin. */
  spineCoin: boolean;
  /** The program wants a KITCHEN cell (round 7). The solver realizes it
   *  only when it costs no sleep cell — worth a hall, never a bed; the
   *  caller may retry at demand−1 for the culture trade (rooms.ts). */
  kitchen?: boolean;
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

// Access encoding inside the hot loop (no object allocation per
// assignment): P = partition, VL/VR = via the left/right neighbor,
// VB = via both (Jack-and-Jill, wet between sleeps only).
const P = 0, VL = 1, VR = 2, VB = 3;

/**
 * The spine variant for `n` sleep cells (+ an optional kitchen cell) —
 * feasible or null. The living floor (4.2), the hall's depth theft and
 * the remaining-cell minimum are the ladder's spine gates verbatim
 * (rooms.ts round 5). The kitchen doors off the hall like any cell (the
 * rear kitchen — the corridor is what makes an extra room doorable).
 */
function spineCandidate(
  n: number,
  L: number,
  D: number,
  vSplitHub: number,
  M: BandMetrics,
  kitchen: boolean,
): BandLayout | null {
  const kitW = kitchen ? CLUSTERS.kitchen?.minW ?? M.bathW : 0;
  const vSplit = clamp(D - M.hallW - 3.4, 4.2, vSplitHub);
  if (D - vSplit - M.hallW < M.bedMinD - 1e-9) return null;
  const bedSpan = L - M.bathW - kitW;
  if (bedSpan / n < M.bedMinW - 1e-9) return null;
  const cells: CellLayout[] = [{ cluster: "wet", u0: 0, u1: M.bathW, access: { kind: "hall" } }];
  if (kitchen) cells.push({ cluster: "kitchen", u0: M.bathW, u1: M.bathW + kitW, access: { kind: "hall" } });
  for (let i = 0; i < n; i++) {
    cells.push({
      cluster: "sleep",
      u0: M.bathW + kitW + (bedSpan / n) * i,
      u1: M.bathW + kitW + (bedSpan / n) * (i + 1),
      access: { kind: "hall" },
    });
  }
  return { mode: "spine", vSplit, cells };
}

/**
 * THE SOLVER: best band layout for a full-form house. Null only when not
 * even one sleep cell fits — the caller falls back to the ladder (the
 * §9 guardrail).
 */
export function solveBand(input: BandInput): BandLayout | null {
  const { L, D, vSplitHub, metrics: M, spineCoin } = input;
  const wetAff = CLUSTERS.wet?.affinity ?? [];
  const wetLikesSleep = wetAff.includes("sleep") ? 1 : 0;
  const wantKit = !!input.kitchen;
  const kitW = CLUSTERS.kitchen?.minW ?? M.bathW;
  const backD = D - vSplitHub;
  // Round-5 gate: a shallow band's through-cell carries its via-door
  // swing corridors clear across, so the bed must fit BETWEEN them —
  // width 4.2 instead of the bare minimum (enfBed0MinW).
  const hostFloor = backD >= 4.4 ? M.bedMinW : 4.2;
  // Cell-cluster codes in the flat buffers (no strings in the hot loop).
  const SLEEP = 0, WET = 1, KIT = 2;

  // Width caps the cell count; the FLAT family additionally caps at 3
  // sleep cells (below): more than that can't clear the partition's
  // chest bound anyway, and the spine — the corridor — is HOW a building
  // doors an arbitrary row of cells (the inn's multiplied sleep cluster
  // rides this: demand 6 → a hall with six doors, no new machinery).
  const nMax = Math.min(input.demand, Math.floor((L - M.bathW) / M.bedMinW));
  for (let n = Math.max(1, nMax); n >= 1; n--) {
    // Score tuple of the best candidate at this n (smaller wins):
    // [kitchenMiss, circAreaEff, traffic, -affinity, -privacyFit] — beds
    // are equal within an n (the outer loop), a wanted kitchen is worth
    // a hall but never a bed, traffic sits ABOVE affinity (round 7), and
    // enumeration order breaks exact ties.
    let best: BandLayout | null = null;
    let bestScore: readonly number[] | null = null;
    const consider = (layout: BandLayout, score: readonly number[]): void => {
      if (bestScore) {
        for (let i = 0; i < score.length; i++) {
          if (score[i]! < bestScore[i]!) break;
          if (score[i]! > bestScore[i]!) return;
          if (i === score.length - 1) return; // exact tie — first wins
        }
      }
      best = layout;
      bestScore = score;
    };

    // ── FLAT candidates: cluster positions × access assignment. The hot
    // loop works on primitive buffers; a BandLayout is built only for a
    // candidate that survives feasibility. Flat caps at 3 sleep cells —
    // the partition/chain arithmetic was derived to there, and past it
    // the corridor is the honest answer.
    const flatN = n <= 3 ? n : 0;
    const cap = n + 2; // buffers sized for the with-kitchen variant
    const clus: number[] = new Array(cap);
    const assign: number[] = new Array(cap);
    const hops: number[] = new Array(cap);
    const floors: number[] = new Array(cap);
    const widths: number[] = new Array(cap);
    const hostedBuf: boolean[] = new Array(cap);

    for (const withKit of wantKit ? ([true, false] as const) : ([false] as const)) {
      if (flatN === 0) break;
      // Width pre-gate: the with-kitchen flat family is dead on arrival
      // when the fixed floors alone overrun the frontage (they always do
      // inside TOWN_DIMS at n = 3) — skip the whole enumeration.
      if (withKit && M.bathW + kitW + n * M.bedMinW > L + 1e-9) continue;
      const len = n + 1 + (withKit ? 1 : 0);
      const kitMiss = wantKit && !withKit ? 1 : 0;

      const emit = (): void => {
        // hops: door-graph distance from the living room; via chains
        // relax over ≤ len passes; unresolved (circular) chains stay
        // infinite → infeasible.
        for (let i = 0; i < len; i++) hops[i] = assign[i] === P ? 1 : Number.POSITIVE_INFINITY;
        for (let pass = 0; pass < len; pass++) {
          for (let i = 0; i < len; i++) {
            const a = assign[i]!;
            if (a === P) continue;
            let h = Number.POSITIVE_INFINITY;
            if ((a === VL || a === VB) && hops[i - 1]! + 1 < h) h = hops[i - 1]! + 1;
            if ((a === VR || a === VB) && hops[i + 1]! + 1 < h) h = hops[i + 1]! + 1;
            if (h < hops[i]!) hops[i] = h;
          }
        }
        for (let i = 0; i < len; i++) if (!Number.isFinite(hops[i]!)) return;

        // Width floors: wet/kitchen are exactly their cluster floor
        // (their stations are sized to it); a sleep cell HOSTING
        // via-doors takes the through floor.
        for (let i = 0; i < len; i++) hostedBuf[i] = false;
        for (let i = 0; i < len; i++) {
          const a = assign[i]!;
          if (a === VL || a === VB) hostedBuf[i - 1] = true;
          if (a === VR || a === VB) hostedBuf[i + 1] = true;
        }
        let total = 0;
        for (let i = 0; i < len; i++) {
          floors[i] =
            clus[i] === WET ? M.bathW
            : clus[i] === KIT ? kitW
            : hostedBuf[i] ? hostFloor : M.bedMinW;
          total += floors[i]!;
        }
        if (total > L + 1e-9) return;
        // Leftover spreads evenly over the SLEEP cells (subdivision,
        // never packing — the widths tile the band by construction).
        const extra = (L - total) / n;
        for (let i = 0; i < len; i++) widths[i] = clus[i] === SLEEP ? floors[i]! + extra : floors[i]!;

        // Door feasibility, the ladder's gates.
        let u = 0;
        for (let i = 0; i < len; i++) {
          const u0 = u;
          const u1 = u + widths[i]!;
          u = u1;
          const a = assign[i]!;
          if (a === P) {
            // Chest clearance at BOTH partition ends + jamb-clamp in the
            // cell's span (DOOR_CLEAR — the round-4/5 partition bound).
            const w = clus[i] === WET ? M.bathDoorW : M.roomDoorW;
            const lo = Math.max(M.doorClear, u0 + M.doorJamb + w / 2);
            const hi = Math.min(M.doorClearHi ?? L - M.doorClear, u1 - M.doorJamb - w / 2);
            if (lo > hi + 1e-9) return;
          } else if (a === VB) {
            // The J&J door pair's swing corridors must leave tub room
            // (round 4: the hub-2 depth gate).
            if (backD < 4.3 - 1e-9) return;
          }
        }

        // Score: through-traffic, affinity (wet doors into sleep hosts),
        // privacy fit.
        let affinity = 0;
        let traffic = 0;
        let privacyFit = 0;
        for (let i = 0; i < len; i++) {
          const a = assign[i]!;
          if (clus[i] === WET && a !== P) affinity += (a === VB ? 2 : 1) * wetLikesSleep;
          traffic += hops[i]! - 1;
          privacyFit += Math.min(
            hops[i]!,
            (clus[i] === WET ? CLUSTERS.wet?.privacy
              : clus[i] === KIT ? CLUSTERS.kitchen?.privacy
              : CLUSTERS.sleep?.privacy) ?? 0,
          );
        }
        const cells: CellLayout[] = [];
        let uu = 0;
        for (let i = 0; i < len; i++) {
          const a = assign[i]!;
          const hosts = a === P ? [] : a === VL ? [i - 1] : a === VR ? [i + 1] : [i - 1, i + 1];
          cells.push({
            cluster: clus[i] === WET ? "wet" : clus[i] === KIT ? "kitchen" : "sleep",
            u0: uu,
            u1: uu + widths[i]!,
            access: a === P ? { kind: "partition" } : { kind: "via", hosts },
          });
          uu += widths[i]!;
        }
        consider({ mode: "flat", vSplit: vSplitHub, cells }, [kitMiss, 0, traffic, -affinity, -privacyFit]);
      };

      const tryAssign = (i: number): void => {
        if (i === len) {
          emit();
          return;
        }
        assign[i] = P;
        tryAssign(i + 1);
        // The KITCHEN doors from the living partition ONLY — a kitchen
        // reached through a bedroom is nobody's culture, and the
        // through-cell corridor arithmetic (hostFloor) was derived for
        // sleeping cells (round 5's enfilade), so only SLEEP cells may
        // host via-traffic.
        if (clus[i] === KIT) return;
        if (i > 0 && clus[i - 1] === SLEEP) {
          assign[i] = VL;
          tryAssign(i + 1);
        }
        if (i < len - 1 && clus[i + 1] === SLEEP) {
          assign[i] = VR;
          tryAssign(i + 1);
        }
        if (clus[i] === WET && i > 0 && i < len - 1 && clus[i - 1] === SLEEP && clus[i + 1] === SLEEP) {
          assign[i] = VB;
          tryAssign(i + 1);
        }
      };

      for (let wetPos = 0; wetPos < len; wetPos++) {
        // A kitchen at the band's EDGE can never clear DOOR_CLEAR for
        // its partition-only door (the cell's own span caps the
        // interval below the chest bound) — interior positions only.
        for (let kitPos = withKit ? 1 : -1; withKit ? kitPos < len - 1 : kitPos === -1; kitPos++) {
          if (kitPos === wetPos) continue;
          for (let i = 0; i < len; i++) clus[i] = i === wetPos ? WET : i === kitPos ? KIT : SLEEP;
          tryAssign(0);
        }
      }
    }

    // ── SPINE candidates: pure circulation — zero traffic, zero
    // affinity; a spine pays its hall AREA unless the variety coin (then
    // it wins its ties outright, the ladder's useSpine draw). With a
    // kitchen wanted, the corridor is also how the extra cell gets
    // doored — a with-kitchen spine outranks every kitchen-less flat.
    for (const withKit of wantKit ? ([true, false] as const) : ([false] as const)) {
      const spine = spineCandidate(n, L, D, vSplitHub, M, withKit);
      if (!spine) continue;
      const kitMiss = wantKit && !withKit ? 1 : 0;
      let privacyFit = 0;
      for (const c of spine.cells) privacyFit += Math.min(1, CLUSTERS[c.cluster]?.privacy ?? 0);
      consider(spine, [kitMiss, spineCoin ? -1 : L * M.hallW, 0, 0, -privacyFit]);
    }

    if (best) return best;
  }
  return null;
}

/**
 * THE LADDER, as a band layout — round 5's hand-solved topologies with
 * their original selection logic, kept as the solver's FALLBACK and as
 * the benchmark the sweep test measures the search against (§9: the
 * ladder stays until the search beats it on the full sweep).
 */
export function ladderBand(input: BandInput): BandLayout {
  const { L, D, vSplitHub, demand: nWant, metrics: M, spineCoin } = input;
  const backD = D - vSplitHub;
  const hub2A = (L - M.bathW) / 2;
  const hub2Ok =
    hub2A >= Math.max(M.bedMinW, M.doorClear + M.doorJamb + M.roomDoorW / 2) && backD >= 4.3;
  const enfDoorLo = Math.max(M.doorClear, M.bathW + M.doorJamb + M.roomDoorW / 2);
  const enfBed0MinW = backD >= 4.4 ? M.bedMinW : 4.2;
  const enfSMin = Math.max(M.bathW + enfBed0MinW, enfDoorLo + M.doorJamb + M.roomDoorW / 2);
  const enfOk = L - M.bedMinW >= enfSMin && enfDoorLo <= L - M.doorClear;
  const spineCap =
    D - 4.2 - M.hallW >= M.bedMinD ? clamp(Math.floor((L - M.bathW) / M.bedMinW), 0, 3) : 0;
  const spineBeds = Math.min(nWant, spineCap);
  const flatBest = Math.max(1, hub2Ok || enfOk ? Math.min(nWant, 2) : 1);
  const useSpine = spineCap > 0 && (spineBeds > flatBest || (spineBeds === flatBest && spineCoin));
  if (useSpine) return spineCandidate(spineBeds, L, D, vSplitHub, M, false)!;
  if (flatBest === 2 && hub2Ok) {
    return {
      mode: "flat",
      vSplit: vSplitHub,
      cells: [
        { cluster: "sleep", u0: 0, u1: hub2A, access: { kind: "partition" } },
        { cluster: "wet", u0: hub2A, u1: hub2A + M.bathW, access: { kind: "via", hosts: [0, 2] } },
        { cluster: "sleep", u0: hub2A + M.bathW, u1: L, access: { kind: "partition" } },
      ],
    };
  }
  if (flatBest === 2 && enfOk) {
    const s = clamp((M.bathW + L) / 2, enfSMin, L - M.bedMinW);
    return {
      mode: "flat",
      vSplit: vSplitHub,
      cells: [
        { cluster: "wet", u0: 0, u1: M.bathW, access: { kind: "via", hosts: [1] } },
        { cluster: "sleep", u0: M.bathW, u1: s, access: { kind: "partition" } },
        { cluster: "sleep", u0: s, u1: L, access: { kind: "via", hosts: [1] } },
      ],
    };
  }
  return {
    mode: "flat",
    vSplit: vSplitHub,
    cells: [
      { cluster: "wet", u0: 0, u1: M.bathW, access: { kind: "via", hosts: [1] } },
      { cluster: "sleep", u0: M.bathW, u1: L, access: { kind: "partition" } },
    ],
  };
}
