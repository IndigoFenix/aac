// Civ — HINTERLAND JOBS and the village cap (settlement-emergence.md §5
// Gate C: the fractal job-description law lifted one rung).
//
// A city is not a big village: it holds a JOB FOR ITS HINTERLAND, and
//
//   LAW: a settlement with no hinterland job caps at village. Size is
//   licensed by FUNCTION, never by an authored tier.
//
// This is resources-and-trade §④'s min-of-constraints ceiling generalized:
// that chapter caps a city by its worst RESOURCE; this one caps it by its
// REASON TO EXIST. Both must pass — the two anchors meet in one min()
// (tri.ts folds the license into the same `pop_ceiling` scalar the vitals
// capacity already reads).
//
// The historical job list is short, and every source shipped earlier in
// the arc derives one of its entries:
//
//   exchange node   — the terrain says cargo must pause here: the §② node
//                     taxonomy (mouth, anchorage, chokepoint, junction,
//                     extraction). `surplus` is deliberately NOT a job — a
//                     caloric battery is a fat village, not a city.
//   exchange        — R&T ⑤: the terrain's "must pause" made ACTUAL. A
//                     standing barter relationship (money.ts
//                     `activeTradePairs`) is a settlement doing the swap its
//                     partners cannot do without it, whatever the ground says.
//   refinery        — §③'s license: a hinterland whose raw good dies on
//                     the road NEEDS this town to concentrate it.
//   store of last   — the road graph: a settlement that is the hub of
//   resort            enough spokes holds its neighbours' grain (variance
//                     reduction — the temple granary). v1 reads DEGREE;
//                     harvest-correlation analysis can refine it later.
//   cult focus      — the one non-economic driver; still an open question
//                     (§11) with no derivation. When culture.ts grows one,
//                     it lands as another HinterlandJob source, not a new
//                     shape.
//
// A city that LOSES its job is not desettled — it shrinks back toward the
// village line under the same births-taper that grew it (Bruges silted up
// and became a town again, it did not burn). Famine desettlement (Gate D)
// stays the only violent exit.

import { NODE_SENTENCES, type NodeReading, type NodeType } from "../cells/node-typing";

/** One reason this settlement may be more than a village — kind + the
 *  printed derivation (the fractal law's test). */
export interface HinterlandJob {
  kind: string;
  sentence: string;
}

/** The §② taxa that ARE hinterland jobs — the terrain forcing traffic
 *  through this point. `surplus` feeds itself; `shadow` alone is only the
 *  LICENSE to refine (the refinery job is the license exercised). */
export const NODE_JOB_TYPES: readonly NodeType[] = [
  "mouth", "anchorage", "chokepoint", "junction", "extraction",
];

export interface JobSources {
  /** The settlement's node reading (§②), when its tier classified one. */
  node?: NodeReading | null;
  /** Living road neighbours (the settlement graph's degree). */
  roadDegree?: number;
  /** Degree at/over which the settlement is a HUB — the store of last
   *  resort for its spokes (default 3: variance needs neighbours). */
  hubDegree?: number;
  /** ⚖️ R&T ⑤ (T4) — DISTINCT ACTIVE TRADE RELATIONSHIPS standing at this
   *  settlement (`activeTradePairs`, kernel/town/money.ts: one per
   *  partner × give-good × take-good row still alive). ≥1 is the EXCHANGE
   *  job — the settlement-emergence source this list was recorded missing.
   *  Absent ⇒ nobody counted, and the list is exactly what it was. */
  tradePairs?: number;
  /** The compiled refineries with each one's CURRENT license verdict at
   *  this settlement (§③ — honest only where `refineLicensing` runs;
   *  without it every license reads its initial 1). */
  refineries?: Array<{ building: string; from: string; into: string; licensed: boolean }>;
}

/** Every job this settlement holds, in a stable order (terrain first,
 *  then the graph, then the standing lanes, then the licensed
 *  refineries). */
export function hinterlandJobs(src: JobSources): HinterlandJob[] {
  const out: HinterlandJob[] = [];
  for (const t of src.node?.types ?? []) {
    if (NODE_JOB_TYPES.includes(t)) out.push({ kind: t, sentence: NODE_SENTENCES[t] });
  }
  const hubAt = src.hubDegree ?? 3;
  if ((src.roadDegree ?? 0) >= hubAt) {
    out.push({
      kind: "hub",
      sentence:
        `exists because ${src.roadDegree} roads meet at its granary — ` +
        `the store of last resort when a neighbour's harvest fails`,
    });
  }
  // ⚖️ R&T ⑤ (T4) — THE EXCHANGE. The node taxonomy says where cargo MUST
  // pause; a standing trade pair says where cargo actually DOES. One live
  // relationship is enough: a settlement that is somebody's counterparty is
  // doing a job no village does for itself, whatever its terrain reads.
  const pairs = src.tradePairs ?? 0;
  if (pairs >= 1) {
    out.push({
      kind: "exchange",
      sentence:
        `exists because ${pairs} standing trade ${pairs === 1 ? "lane runs" : "lanes run"} ` +
        `through its yard — the swap its partners cannot make without it`,
    });
  }
  for (const r of src.refineries ?? []) {
    if (!r.licensed) continue;
    out.push({
      kind: "refinery",
      sentence: `exists because its hinterland's ${r.from} cannot reach a market raw — the ${r.building} concentrates it into ${r.into}`,
    });
  }
  return out;
}

export interface CityLicense {
  /** May this settlement grow past the village line? */
  licensed: boolean;
  /** The functional cap: Infinity when licensed, `villageHeads` when not. */
  cap: number;
  jobs: HinterlandJob[];
  sentence: string;
}

/**
 * THE VILLAGE CAP: no job ⇒ the settlement's ceiling is `villageHeads`,
 * whatever its land could feed. The caller derives villageHeads from its
 * own declared tier vocabulary (tri.ts: the town line — a ratio of
 * declared quantities, never a new number).
 */
export function cityLicense(jobs: HinterlandJob[], villageHeads: number): CityLicense {
  if (jobs.length > 0) {
    const more = jobs.length > 1 ? ` (and ${jobs.length - 1} more)` : "";
    return {
      licensed: true,
      cap: Infinity,
      jobs,
      sentence: `holds a job for its hinterland — ${jobs[0].sentence}${more}`,
    };
  }
  return {
    licensed: false,
    cap: villageHeads,
    jobs,
    sentence:
      `has no job for its hinterland — a village (cap ${villageHeads} souls), ` +
      `whatever its land could feed`,
  };
}
