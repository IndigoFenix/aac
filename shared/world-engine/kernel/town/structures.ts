/**
 * structures.ts — the STRUCTURE CATALOG (city-expansion phase ①b): one
 * declarative row per BUILDABLE structure, UNIFYING the two half-catalogs
 * that already describe buildings:
 *
 *   economic half   economy.ts BuildingDef (produces/consumes, cap:{by,rate},
 *                   construction.costs, district) — referenced by KEY
 *                   (`economy`), never duplicated here;
 *   interior half   stations.ts BuildingProgram (interior wants) consumed by
 *                   rooms.ts buildingRoomPlan() — embedded per spec, so a
 *                   founded building never falls through workProgram()'s
 *                   silent `{store:true}` swallow.
 *
 * The catalog is WORLD CONTENT: the default set ships beside
 * TOWN_PLAY_ECONOMY (town-play.ts TOWN_PLAY_STRUCTURES) and a world doc
 * overrides it per config (`TownPlayConfig.structures`) — the same
 * swap-the-doc modding loop as the economy. This module owns only the TYPE
 * and the pure resolution/cost helpers.
 *
 * Unknown structure names resolve to NULL — the caller phrases a NAMED
 * conversational "can't"; there is no generic fallback by design.
 *
 * Kernel layering: pure data + arithmetic, imports types only.
 */

import type { BuildingProgram, StationKind } from "./stations.js";
import { headOf } from "../../variations.js";

/** One buildable structure — a registry row (StationDef/ClusterDef pattern). */
export interface StructureSpec {
  /** Registry key — a free string (no closed union; content defines the
   *  vocabulary). Also the TownWork.type a founded building materializes as. */
  type: string;
  /** Board + TTS symbol (shared game lang layer word, NOT client i18n). */
  glyph: string;
  /**
   * Optional CONTAINER FRAME for the rendered icon: the compositor nests
   * `glyph` inside the `building`/`room` shell (`building(farm)`), so every
   * structure reads as "a building that is a farm" at a glance — one shell,
   * one payload, the M3 motif. DISPLAY ONLY: `glyph` stays the spoken/TTS
   * word, because "build building farm" is not a sentence.
   */
  frame?: "building" | "room";
  /**
   * The INNER SYMBOL planted over the frame, when it differs from `glyph`.
   * A structure's name and its picture are separate jobs: the name is what a
   * resident says ("farm"), the symbol is what the lexicon can draw
   * (`grain`). Absent = the word doubles as the symbol, which is right
   * whenever the word IS drawable (`workshop`, `home`).
   */
  symbol?: string;
  /** Short display label (toasts, debug panels). */
  label: string;
  /** Dwelling vs staffed work building. Both raise through the work-interior
   *  path today (buildingRoomPlan on the program); `house` is the phase-③
   *  seam for residents moving in. */
  role: "house" | "work";
  /** Lot size request: frontage (along the street) × depth (off it), meters.
   *  The founding enumeration orients it to the slot's door side. */
  footprint: { w: number; d: number };
  /** Interior wants → rooms.ts buildingRoomPlan(). */
  program: BuildingProgram;
  /** Extra stations beyond what the program implies (phase-② seam — carried
   *  in the row, consumed once richer work stations exist). */
  stations?: StationKind[];
  /** Roster staff for the completed building (replaces the flat
   *  STAFF_PER_WORK for this building; 0 = unstaffed). */
  jobs: number;
  /** An EMPTY SHELL (pipeline ⑤b): completes as a bare doored box — no
   *  registry furniture, no interior program rooms; function arrives from
   *  what's built and placed inside (interior subdivision + placed
   *  pieces). "A building constructed with no role is just an empty box
   *  awaiting programs." */
  shell?: boolean;
  /** The economic half: a BuildingDef KEY in the world's compiled economy
   *  (produces/consumes/cap/district ride there). Absent = no aggregate row. */
  economy?: string;
  /** Build-material costs, drawn from the site/town stock: glyph → count. */
  costs: Record<string, number>;
  /** Street-days of visible construction (scaffold up → doors open). */
  buildDays: number;
  /** Wall color when raised. */
  color: string;
  /** Ships in the default catalog (vs unlocked by a world doc). */
  default: boolean;
}

/**
 * Resolve a spoken structure name against the catalog — by type, label or
 * glyph, case-insensitive. NULL for an unknown name: the caller must phrase
 * a NAMED refusal (never a silent generic fallback — the workProgram()
 * lesson).
 */
export function resolveStructure(
  catalog: ReadonlyArray<StructureSpec>,
  name: string,
): StructureSpec | null {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  return (
    catalog.find((s) => s.type.toLowerCase() === n) ??
    catalog.find((s) => s.glyph.toLowerCase() === n) ??
    catalog.find((s) => s.label.toLowerCase() === n) ??
    null
  );
}

/** The costs a stock cannot cover: glyph → units MISSING (empty = affordable).
 *  Facted stack variants count toward their material head ("wood.wet" pays a
 *  "wood" cost — the founding.ts isSiteMaterial convention). */
export function missingCosts(
  spec: Pick<StructureSpec, "costs">,
  stock: Readonly<Record<string, number>>,
): Record<string, number> {
  const have = new Map<string, number>();
  for (const [glyph, n] of Object.entries(stock)) {
    const head = headOf(glyph);
    have.set(head, (have.get(head) ?? 0) + Math.max(0, n));
  }
  const missing: Record<string, number> = {};
  for (const [glyph, n] of Object.entries(spec.costs)) {
    const short = n - (have.get(glyph) ?? 0);
    if (short > 0) missing[glyph] = short;
  }
  return missing;
}

/** Can the stock cover the spec's costs right now? */
export function costsMet(
  spec: Pick<StructureSpec, "costs">,
  stock: Readonly<Record<string, number>>,
): boolean {
  return Object.keys(missingCosts(spec, stock)).length === 0;
}

/**
 * SPEND the spec's costs out of the stock (mutates it) — facted variants pay
 * toward their head, plain stacks first. Call only after `costsMet`; returns
 * false (and spends nothing) when the stock can't cover.
 */
export function spendCosts(
  spec: Pick<StructureSpec, "costs">,
  stock: Record<string, number>,
): boolean {
  if (!costsMet(spec, stock)) return false;
  for (const [glyph, cost] of Object.entries(spec.costs)) {
    let left = cost;
    // Plain stack first, then facted variants in stable key order.
    const keys = Object.keys(stock)
      .filter((k) => headOf(k) === glyph)
      .sort((a, b) => (a === glyph ? -1 : b === glyph ? 1 : a < b ? -1 : 1));
    for (const k of keys) {
      if (left <= 0) break;
      const take = Math.min(left, stock[k] ?? 0);
      if (take <= 0) continue;
      stock[k]! -= take;
      left -= take;
      if (stock[k]! <= 0) delete stock[k];
    }
  }
  return true;
}

/**
 * The DISPLAY glyph for a structure: its symbol nested in the container frame
 * its spec declares (`building(grain)`), or the bare symbol when it declares
 * none. Boards and option lists render this; TTS and the parser keep
 * `spec.glyph`, which is the actual word.
 *
 * The nested symbol is `spec.symbol` when the row declares one, else the word
 * itself. They diverge whenever a structure's NAME is not a drawable symbol —
 * "farm" is a word the lexicon has no picture for, while `grain` is a picture
 * with no ambition to be the name. Before the split, every such row rendered
 * its plate around a ❓.
 */
export function structureDisplayGlyph(spec: StructureSpec): string {
  const symbol = spec.symbol ?? spec.glyph;
  return spec.frame ? `${spec.frame}(${symbol})` : symbol;
}
