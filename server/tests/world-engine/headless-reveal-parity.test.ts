// REVEAL PARITY — `revealedInteriors` (render3d.ts) is the ONE owner of the
// "which interiors are on show" rule, shared by the GL renderer and the headless
// text view (text-mode.md ⓪/law ⑥). It is not chrome: the town streamer keys
// interior EMBODIMENT on it, so a view that computed it its own way would
// populate a DIFFERENT world from the same seed.
//
// These are hand-built WorldStates (the world-engine-visibility.test.ts pattern)
// driven through the text view, asserting the four rules the boot depends on:
// viewer flood-through, spirit accessibility, the dollhouse focus frame, and the
// reveal switch. Pure engine logic — no GL, no boot.

import { describe, it, expect } from "@jest/globals";
import {
  accessibleBuildings,
  createWorldState,
  expandWorldBuildings,
  visibleBuildings,
  type WorldState,
} from "@shared/world-engine/engine.js";
import { revealedInteriors } from "@shared/world-engine/render3d.js";
import { createTextWorldView } from "@shared/world-engine/headless/text-world-view.js";
import type { BuildingSpec, WorldSpec } from "@shared/world-engine/types.js";

const ME = "me";

/** A TWO-ROOM HOUSE on the street, plus a NEIGHBOUR across the road.
 *   • A (0..6)  — the entrance room: interior door east to B, exterior door west;
 *   • B (6..12) — the back room: only the interior door;
 *   • C (20..26) — the neighbour: its own exterior door, no wall shared with A/B.
 *  Nothing joins C to the house except the street itself. */
const TOWN: BuildingSpec[] = [
  {
    id: "A",
    footprint: { x: 0, y: 0, w: 6, h: 6 },
    floors: 1,
    wallThickness: 0.4,
    doorways: [
      { edge: "east", offset: 3, width: 2 }, // interior, shared with B (mid ≈ (6,3))
      { edge: "west", offset: 3, width: 2 }, // exterior, onto the street (mid ≈ (0,3))
    ],
  },
  {
    id: "B",
    footprint: { x: 6, y: 0, w: 6, h: 6 },
    floors: 1,
    wallThickness: 0.4,
    doorways: [{ edge: "west", offset: 3, width: 2 }], // interior, shared with A
  },
  {
    id: "C",
    footprint: { x: 20, y: 0, w: 6, h: 6 },
    floors: 1,
    wallThickness: 0.4,
    doorways: [{ edge: "west", offset: 3, width: 2 }], // exterior, onto the same street
  },
];

function spec(buildings: BuildingSpec[]): WorldSpec {
  return {
    engine: "world",
    engineVersion: 1,
    meta: { title: "t", locale: "en", theme: "t" },
    manifold: { kind: "flat", width: 40, height: 40 },
    terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 3, y: 3, facing: 0 }],
    objects: [],
    buildings,
    multiplayer: { maxPlayers: 4, authority: "distributed" },
    content: { kind: "sandbox" },
  };
}

/** A world with the local body standing at (x, y). */
function world(at: { x: number; y: number }): WorldState {
  const s = createWorldState(expandWorldBuildings(spec(TOWN)), ME);
  const me = s.avatars[ME]!;
  me.x = at.x;
  me.y = at.y;
  return s;
}

/** Set the swing/lock of every door whose midpoint x is near `atX`. */
function setDoors(s: WorldState, atX: number, open: number, locked = false): void {
  for (const st of s.spec.structures ?? []) {
    if (st.kind !== "door") continue;
    if (Math.abs((st.a.x + st.b.x) / 2 - atX) > 0.5) continue;
    s.doors[st.id]!.open = open;
    s.doors[st.id]!.locked = locked;
  }
}

/** The house's own frame — the dollhouse focus rect around rooms A+B. */
const HOUSE_FRAME = { x: 0, y: 0, w: 12, h: 6 };

describe("revealedInteriors — the viewer (walker) rule", () => {
  it("floods through an open near doorway but never leaks to the street", () => {
    const s = world({ x: 3, y: 3 }); // inside room A
    setDoors(s, 6, 1); // interior door swung open
    setDoors(s, 0, 1); // the house's street door open too
    setDoors(s, 20, 1); // …and the neighbour's

    const got = revealedInteriors(s, ME, { interiorReveal: true, spirit: false, spiritFrame: null });
    expect([...got].sort()).toEqual(["A", "B"]);
    // …and it IS visibleBuildings, not a lookalike.
    expect([...got].sort()).toEqual([...visibleBuildings(s, { x: 3, y: 3 })].sort());
    expect(got.has("C")).toBe(false); // the reveal never crosses the road
  });

  it("a SHUT interior door keeps the back room sealed", () => {
    const s = world({ x: 3, y: 3 });
    setDoors(s, 6, 0);
    const got = revealedInteriors(s, ME, { interiorReveal: true, spirit: false, spiritFrame: null });
    expect([...got]).toEqual(["A"]);
  });

  it("a walker ignores the spirit focus frame entirely", () => {
    const s = world({ x: 3, y: 3 });
    setDoors(s, 6, 1);
    // A frame that excludes BOTH rooms changes nothing for a viewer — the frame
    // is a SPIRIT narrowing (the dollhouse), never a walker's.
    const got = revealedInteriors(s, ME, {
      interiorReveal: true,
      spirit: false,
      spiritFrame: { x: 100, y: 100, w: 1, h: 1 },
    });
    expect([...got].sort()).toEqual(["A", "B"]);
  });
});

describe("revealedInteriors — the spirit (dollhouse) rule", () => {
  it("with NO frame, the whole ACCESSIBLE suite is on show — swing and distance ignored", () => {
    const s = world({ x: 3, y: 3 }); // the spirit's parked stand-in, inside A
    // Every door SHUT: a formless viewer doesn't swing doors, so this must not
    // matter (it would seal everything for a walker).
    setDoors(s, 6, 0);
    setDoors(s, 0, 0);
    setDoors(s, 20, 0);

    const got = revealedInteriors(s, ME, { interiorReveal: true, spirit: true, spiritFrame: null });
    expect([...got].sort()).toEqual(["A", "B", "C"]); // out the front door and across
    expect([...got].sort()).toEqual([...accessibleBuildings(s, { x: 3, y: 3 })].sort());
    // The walker rule over the SAME state sees only the room it stands in.
    expect([...visibleBuildings(s, { x: 3, y: 3 })]).toEqual(["A"]);
  });

  it("a LOCKED door walls its room off even for the spirit", () => {
    const s = world({ x: 3, y: 3 });
    setDoors(s, 0, 1, true); // the street door locked: no way out of the house
    const got = revealedInteriors(s, ME, { interiorReveal: true, spirit: true, spiritFrame: null });
    expect([...got].sort()).toEqual(["A", "B"]);
  });

  it("a FOCUS FRAME drops the out-of-frame neighbour (the Sims dollhouse)", () => {
    const s = world({ x: 3, y: 3 });
    const got = revealedInteriors(s, ME, {
      interiorReveal: true,
      spirit: true,
      spiritFrame: HOUSE_FRAME,
    });
    expect([...got].sort()).toEqual(["A", "B"]);
    // The neighbour is ACCESSIBLE — it is the frame, not reachability, that
    // sealed it (so a town around the focused house keeps its walls).
    expect(accessibleBuildings(s, { x: 3, y: 3 }).has("C")).toBe(true);
  });

  it("interiorReveal OFF is the empty set, spirit or not", () => {
    const s = world({ x: 3, y: 3 });
    setDoors(s, 6, 1);
    for (const spirit of [false, true]) {
      const got = revealedInteriors(s, ME, { interiorReveal: false, spirit, spiritFrame: null });
      expect(got.size).toBe(0);
    }
  });
});

describe("TextWorldView.revealedBuildings — the one-frame lag", () => {
  const intent = { aim: null, sitting: false };

  it("is EMPTY before the first render, then answers with the LAST rendered frame", () => {
    const s = world({ x: 3, y: 3 });
    setDoors(s, 6, 1);
    const view = createTextWorldView({ localId: ME, spirit: true, spiritFrame: HOUSE_FRAME });

    // Frame 0: the host's sim asks BEFORE anything has rendered (world-host runs
    // its frame, then calls view.render) — so nothing is revealed yet.
    expect(view.revealedBuildings().size).toBe(0);

    view.render(s, 1 / 60, intent);
    expect([...view.revealedBuildings()].sort()).toEqual(["A", "B"]);

    // A camera write lands on the NEXT render, never retroactively — the lag is
    // the whole point (GL behaves identically, so streaming matches).
    view.setSpiritFocus(null);
    expect([...view.revealedBuildings()].sort()).toEqual(["A", "B"]);
    view.render(s, 1 / 60, intent);
    expect([...view.revealedBuildings()].sort()).toEqual(["A", "B", "C"]);

    view.setInteriorReveal(false);
    view.render(s, 1 / 60, intent);
    expect(view.revealedBuildings().size).toBe(0);
  });

  it("matches revealedInteriors over the same state, every frame", () => {
    const s = world({ x: 3, y: 3 });
    setDoors(s, 6, 1);
    const view = createTextWorldView({ localId: ME, spirit: false, interiorReveal: true });
    view.render(s, 1 / 60, intent);
    expect([...view.revealedBuildings()].sort()).toEqual(
      [...revealedInteriors(s, ME, { interiorReveal: true, spirit: false, spiritFrame: null })].sort(),
    );
  });

  it("screenToWorld is the identity, and worldToScreen inverts it", () => {
    const view = createTextWorldView({ localId: ME, spirit: true });
    expect(view.screenToWorld(12.5, -3)).toEqual({ x: 12.5, y: -3 });
    expect(view.probe().worldToScreen({ x: 12.5, y: -3 })).toEqual({ x: 12.5, y: -3 });
  });

  it("pickScreen resolves the entity AT the world point (and honours includeLocal)", () => {
    const s = world({ x: 3, y: 3 });
    s.avatars.other = { ...s.avatars[ME]!, id: "other", x: 9, y: 3 };
    const view = createTextWorldView({ localId: ME, spirit: true });
    view.render(s, 1 / 60, intent);

    expect(view.pickScreen?.(9, 3)).toEqual({ kind: "avatar", id: "other" });
    expect(view.pickScreen?.(3, 3)).toBeNull(); // the local body is passed through…
    expect(view.pickScreen?.(3, 3, { includeLocal: true })).toEqual({ kind: "avatar", id: ME });
    expect(view.pickScreen?.(30, 30)).toBeNull(); // empty ground
  });

  it("probe() reports exactly what the last frame was handed", () => {
    const s = world({ x: 3, y: 3 });
    const view = createTextWorldView({ localId: ME, spirit: true });
    expect(view.probe().state).toBeNull();
    const seen: number[] = [];
    const view2 = createTextWorldView({
      localId: ME,
      spirit: true,
      onRender: (_s, dt) => seen.push(dt),
    });
    view2.render(s, 0.25, { aim: { x: 1, y: 2 }, sitting: true });
    expect(seen).toEqual([0.25]);
    expect(view2.probe().state).toBe(s);
    expect(view2.probe().dt).toBe(0.25);
    expect(view2.probe().intent).toEqual({ aim: { x: 1, y: 2 }, sitting: true });
  });
});
