// games/world-lab/src/flora-depletion.ts
//
// ⚖️ #49 STAGE 3 — THE RENDER BRIDGE: the countryside THINS where its record
// has been logged, and fills back in as the record regrows.
//
// THE DEFECT, in one sentence: Stage 1 gave the ground beyond the manifold a
// `wild:area:tile-<i>-<j>` record and Stage 2 made it durable, so a site can
// now log a neighbouring stand flat — and until this file, not one tree left
// the horizon. The same wood stood in the yard AND in the picture: exactly
// the double count the record tier exists to prevent, moved from the books
// to the eye.
//
// ── STRICTLY A RENDERER ────────────────────────────────────────────────────
// Reads `host.areaQuotes()` — the typed, serializable, deep-copied READ the
// host already exposes for exactly this (`farm-crops.ts` is the precedent and
// this file changes nothing about it) — and writes NOTHING. It creates no
// entity, debits no stock and never tells the sim what it drew. In multiplayer
// every peer runs this over the same replicated quotes and reaches the same
// answer, because the only two inputs are the record and the instance's own
// stable key (the LOD-per-camera law: a peer whose tiles decided what EXISTS
// would be playing a different world).
//
// ── ONE GRADIENT, NOT A SECOND ONE ─────────────────────────────────────────
// Every number here comes out of `wildThinField` (wild-area.ts), which is
// built literally on `wildKeepChance` — the density law that has declared
// since #41 that *"any scenery renderer that thins for depletion must thin by
// it too — a second gradient story must never exist"*. This file is its first
// consumer. There is deliberately no ratio, no falloff and no roll of its own
// in this module: it partitions instances by rect, hands the count over, and
// asks.
//
// ── WHAT THIS DOES NOT TOUCH ───────────────────────────────────────────────
// The near-stand suppression (`townStandHidden`), the wilderness twins and
// their felled marks, and the settlement holes all answer DIFFERENT questions
// and are untouched: they say "the sim stands the real thing here", "this tree
// is a stump" and "this is a street". This says "the books say a quarter of
// this wood is gone". They meet only as a UNION of hidden keys in
// `syncFloraTwins`, which is where the flora field's one per-instance mask has
// always been assembled.
//
// 🔒 AND THE TWIN RING CANNOT COLLIDE WITH A TILE RECORD, structurally. Twins
// stand within `WILD_TWIN_R` (80 m) of the player and require a WILDERNESS
// session, which the homestead premise never stands at all; and even if one
// ever coexists, 80 m is inside tile (0,0)'s ground — the site's own square,
// which `neighborTileOffsets` never mints (that ground is the near stand's,
// held as real features and folded to `home`). So no instance can be both a
// live twin and a thinned tile instance, and neither system has to know about
// the other.

import {
  wildThinField,
  wildThinHidden,
  type WildAreaQuote,
  type WildThinField,
  type WildThinInstance,
} from "@shared/world-engine/interaction/quest/wild-area";

/** A record's ground, in session coordinates. */
export interface SessionRect { x: number; y: number; w: number; h: number }

export interface FloraDepletion {
  /**
   * Feed the latest quotes (~1 Hz, the established quote cadence). Cheap
   * unless a record's thinning STAMP moved — see `wildThinField`.
   */
  update(quotes: readonly WildAreaQuote[]): void;
  /** The instance keys the records have thinned away. Declarative and stable:
   *  the same set object is returned until something actually changes. */
  hidden(): ReadonlySet<string>;
  /** Drop every cached partition (a new town anchor, a new planet, an
   *  unmount) — the session frame these instances were measured in is gone. */
  reset(): void;
}

/** One record's cached scenery partition — dealt ONCE per (key, rect), because
 *  the flora scatter is world-fixed and a record's rect never moves. */
interface Partition {
  /** `${key}@${x},${y},${w},${h}` — a re-keyed or re-laid record re-partitions. */
  id: string;
  instances: WildThinInstance[];
}

export function createFloraDepletion(opts: {
  /** The one species the field can mask per instance (`FLORA_TREE_SPECIES`). */
  species: string;
  /**
   * Every scenery instance of `species` standing inside `rect`, in the
   * RECORD's own (session) frame.
   *
   * ⚖️ THE CALLER OWNS THE FRAME, deliberately: world-lab already has exactly
   * one session↔world transform per mounted session (the town anchor), and a
   * second one living down here is how the two would drift.
   *
   * 🚨 `null` MEANS "ASK ME AGAIN", NOT "NOTHING THERE". A town mounts at
   * altitude and its records exist long before the flora field does, so the
   * first quote beats can arrive with no scatter to measure — and an empty
   * answer cached at that moment would freeze every tile at "no scenery" for
   * the whole visit, which reads exactly like the feature never shipped. An
   * EMPTY ARRAY is a real answer (open water, a desert cell) and is cached.
   */
  instancesIn(rect: SessionRect): WildThinInstance[] | null;
}): FloraDepletion {
  const parts = new Map<string, Partition>();
  let stamp = "";
  let hidden: ReadonlySet<string> = new Set<string>();

  const partitionOf = (key: string, rect: SessionRect): Partition | null => {
    const id = `${key}@${rect.x},${rect.y},${rect.w},${rect.h}`;
    const hit = parts.get(key);
    if (hit && hit.id === id) return hit;
    const instances = opts.instancesIn(rect);
    if (!instances) return null; // not measurable yet — never cache that
    const fresh: Partition = { id, instances };
    parts.set(key, fresh);
    return fresh;
  };

  return {
    update(quotes) {
      if (!quotes.length) {
        // 🚫 NO RECORDS, NO FEATURE. Nothing is enumerated, nothing is rolled
        // and the hidden set is empty — a dollhouse, a static city and any
        // never-founded ground are byte-identical to the shipped field.
        if (stamp !== "") {
          stamp = "";
          hidden = new Set<string>();
        }
        return;
      }
      // Quotes arrive sorted by key (the host's own guarantee), so the stamp
      // is a fact about the world and not about a Map's insertion history.
      const fields: Array<{ field: WildThinField; part: Partition }> = [];
      let next = "";
      for (const q of quotes) {
        const part = partitionOf(q.key, q.area);
        if (!part || !part.instances.length) continue; // nothing (yet) to thin
        const field = wildThinField(q, opts.species, part.instances.length);
        if (field.quantized >= 1) continue;   // nothing thinned here
        fields.push({ field, part });
        next += `${q.key}|${field.stamp};`;
      }
      if (next === stamp) return; // same bucket, same shape ⇒ same survivors
      stamp = next;
      const out = new Set<string>();
      for (const f of fields) wildThinHidden(f.field, f.part.instances, out);
      hidden = out;
    },
    hidden() {
      return hidden;
    },
    reset() {
      parts.clear();
      stamp = "";
      hidden = new Set<string>();
    },
  };
}
