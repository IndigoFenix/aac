// shared/world-engine/kernel/town/containers.ts
//
// WHAT HOLDS THINGS (scope-unification.md step ②).
//
// User law (2026-08-02): "creatures can carry or be equipped with containers
// (baskets being the prototype for a carried container, satchels for an
// equipped one) and those containers can contain items, which the creature can
// access… Just as a house has a box, a creature may carry a satchel."
//
// A container is a SCOPE, and the only thing that distinguishes a barrel in a
// kitchen from a basket on somebody's arm is where the scope hangs. So this
// module answers one question for both — *is this a container, how much does it
// hold, and how is it held* — and nothing else knows the answer.
//
// ── TWO CAPACITIES, DELIBERATELY ─────────────────────────────────────────
// They are different quantities and conflating them is a real bug waiting:
//   • UNITS      — the stack ledger's cap (`StockEndpoint.capacity`): how much
//                  wheat fits in the barrel. This module's `capacity`.
//   • INSTANCES  — how many whole OBJECTS sit visibly in/on it
//                  (`ObjectSpec.contains[].capacity`): the props a table shows.
// A basket holding eight units of grain still only shows a couple of props.
// `INSTANCE_SLOTS` is the convention every container in the game already uses.

import { furnitureKindOfGlyph, STATION_PROPERTIES, type StationKind } from "./stations.js";

/** How a body holds a portable container. */
export type HoldMode =
  /** In the hands — it occupies them, so a carried basket is a real cost. */
  | "carry"
  /** On the body — the hands stay free. The satchel's whole point. */
  | "wear";

export interface ContainerDef {
  /** UNITS it holds (the stack cap). */
  capacity: number;
  /** `in` = hidden behind a lid, `on` = shown on a surface. */
  relation: "in" | "on";
  /** Present ⇒ PORTABLE: a body can hold it. Absent ⇒ furniture, it stands. */
  hold?: HoldMode;
}

/** Whole objects a container shows in/on itself — the town-stage convention,
 *  unchanged. Not the unit cap; see the header. */
export const INSTANCE_SLOTS = 2;

/**
 * THE PORTABLE CONTAINERS — a creature's own storage, and the reason a body
 * will ever be able to haul more than it can hold in two hands.
 *
 * The two differ in exactly one field, and that field is the whole point: you
 * hold a basket, so it costs you a hand; you WEAR a satchel, so it does not.
 * When carry becomes bounded (step ③) that is the difference between being able
 * to fetch something while already carrying something, and not.
 *
 * A satchel holds less than a basket for the same reason — it is on your body,
 * not swinging from your arm.
 */
export const PORTABLE_CONTAINERS: Readonly<Record<string, ContainerDef>> = {
  basket: { capacity: 8, relation: "in", hold: "carry" },
  satchel: { capacity: 5, relation: "in", hold: "wear" },
};

/** Portable containers a body WEARS — they leave the hands free, so a body may
 *  hold something else at the same time. (`carry` mode occupies a hand.) */
export function isWornContainer(glyph: string): boolean {
  return containerDefOfGlyph(glyph)?.hold === "wear";
}

/** Furniture container kinds hold this many units when nothing else says
 *  otherwise. A goods box overrides it from the good's own `boxCap` — the
 *  economy sizes a pantry, not this table. */
export const FURNITURE_CONTAINER_CAP = 12;

/** Is this station kind a container at all? The spec-side authority
 *  (STATION_PROPERTIES) answers, so the board and the sim cannot disagree. */
export function isContainerKind(kind: StationKind): boolean {
  return STATION_PROPERTIES[kind]?.includes("container") ?? false;
}

/**
 * The container a glyph names, or null for anything that holds nothing.
 *
 * Covers both rungs: a furniture stack (`furn.barrel`) and a portable item
 * (`basket`). A LOOSE barrel is as much a container as a standing one — the
 * water does not pour out because somebody tipped it over — which is the whole
 * point of the shape.
 */
export function containerDefOfGlyph(glyph: string): ContainerDef | null {
  const kind = furnitureKindOfGlyph(glyph);
  if (kind) {
    if (!isContainerKind(kind)) return null;
    // A shelf and a table SHOW their contents; a lidded piece hides them. The
    // openable flag is the mechanic's own answer (properties.ts derives the
    // board's word from the same place).
    const shown = kind === "shelf" || kind === "table" || kind === "bowl";
    return { capacity: FURNITURE_CONTAINER_CAP, relation: shown ? "on" : "in" };
  }
  const head = glyph.split(".")[0] ?? glyph;
  return PORTABLE_CONTAINERS[head] ?? null;
}

/** Does this glyph name something a body can pick up AND put things inside? */
export function isPortableContainer(glyph: string): boolean {
  return !!containerDefOfGlyph(glyph)?.hold;
}

/**
 * 🚨 MAY THIS BECOME A COUNTABLE UNIT?
 *
 * A scope cannot be a number. Putting a barrel into a chest used to dissolve it
 * into one `furn.barrel` tally in the chest's stack — and the barrel's own
 * stock, keyed by the object id that just stopped existing, was orphaned. That
 * is the reported bug: water visible in a deconstructed barrel, gone once the
 * barrel had been put in a box and stood up again. The refrigerator kept its
 * food only because nobody ever boxed it.
 *
 * So: an EMPTY container stacks like any other item (a flat-packed barrel is
 * just a barrel), and a FULL one stays a whole object wherever it goes.
 */
export function mayDissolveToStack(
  glyph: string,
  contents: Readonly<Record<string, number>> | undefined,
): boolean {
  if (!containerDefOfGlyph(glyph)) return true; // not a container: always a unit
  if (!contents) return true;
  return Object.values(contents).every((n) => (n ?? 0) <= 0);
}
