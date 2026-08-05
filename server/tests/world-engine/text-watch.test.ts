// TEXT MODE step ⑩ — WATCHING (design §6 / D6).
//
// `watch <id>` upgrades ONE subject from crowd summary to per-event narration.
// The three claims this suite pins:
//
//   • the DELTA TABLE is complete and hysteretic — DOING, MOVED, HOLD, WEAR,
//     OPEN and the gated STOCK, each firing on its own change and on nothing
//     else (a body drifting 2° across a compass boundary has not "moved");
//   • a watch NEVER GRANTS VISIBILITY — leaving view is ONE `EXIT` with the
//     visible transit, then silence, and the watch survives to re-fire `ENTER`;
//   • the cap is 8, and the ninth is refused BY NAME.
//
// The delta table is tested against `createWatchBook` directly, over hand-built
// scenes: the point is the comparison, not the geometry (text-visibility covers
// that). The cap and the EXIT-then-silence rule are tested through a session,
// because that is where they actually bite.

import { describe, it, expect } from "@jest/globals";
import {
  createSceneIndex,
  createTextModeSession,
  createWatchBook,
  swing,
  type TextEvent,
  type TextSessionDeps,
  type TextViewProbe,
  type VisibleScene,
  type VisibleSubject,
} from "@shared/world-engine/interaction/text/index.js";
import type { QuestPresenter } from "@shared/world-engine/interaction/quest/quest-host.js";
import {
  addLocalAvatar,
  createWorldState,
  type WorldState,
} from "@shared/world-engine/engine.js";
import type { WorldSpec } from "@shared/world-engine/types.js";

const PLAIN = ["species:human", "garment:default", "color:default"];

function sub(id: string, over: Partial<VisibleSubject> = {}): VisibleSubject {
  return {
    id,
    kind: "creature",
    textId: id,
    head: "person",
    word: "person",
    band: "there",
    cardinal: "east",
    bearing: 0,
    distance: 20,
    space: null,
    floor: 0,
    appearance: PLAIN,
    holding: [],
    ...over,
  };
}

function scene(subjects: VisibleSubject[]): VisibleScene {
  return {
    me: { id: "me", x: 0, y: 0, floor: 0, space: null },
    subjects,
    places: [],
    revealed: new Set<string>(),
  };
}

function book() {
  return createWatchBook({
    label: (id) => id,
    activityPhrase: (a) => (a ? (a.object ? `${a.verb} ${a.object}` : a.verb) : undefined),
  });
}

/** Step the book twice: a silent baseline, then the frame under test. */
function deltas(before: VisibleSubject, after: VisibleSubject): TextEvent[] {
  const b = book();
  b.add(before.id);
  const tracked = new Set([before.id]);
  expect(b.step(scene([before]), { tracked })).toEqual([]); // baseline is silent
  return b.step(scene([after]), { tracked });
}

describe("watch — the delta table (§6), one kind at a time", () => {
  it("DOING on an activity change, keyed on (verb, object)", () => {
    expect(deltas(sub("m", { activity: { verb: "eat" } }), sub("m", { activity: { verb: "sit" } }))).toEqual([
      { tag: "DOING", who: "m", activity: "sit" },
    ]);
    // The OBJECT is part of the key: same verb, different thing, still news.
    expect(
      deltas(
        sub("m", { activity: { verb: "eat", object: "apple" } }),
        sub("m", { activity: { verb: "eat", object: "cookie" } }),
      ),
    ).toEqual([{ tag: "DOING", who: "m", activity: "eat cookie" }]);
    // …and standing still is not a change.
    expect(deltas(sub("m", { activity: { verb: "eat" } }), sub("m", { activity: { verb: "eat" } }))).toEqual([]);
  });

  it("MOVED on a band change", () => {
    expect(deltas(sub("m"), sub("m", { band: "here", distance: 2 }))).toEqual([
      { tag: "MOVED", who: "m", band: "here", cardinal: "east" },
    ]);
  });

  it("MOVED on a space change — walking indoors is moving", () => {
    expect(deltas(sub("m"), sub("m", { space: "b1" }))).toEqual([
      { tag: "MOVED", who: "m", band: "there", cardinal: "east" },
    ]);
  });

  it("MOVED on a bearing swing of 90° — and NOT on a 2° drift across a boundary", () => {
    expect(deltas(sub("m", { bearing: 0 }), sub("m", { bearing: 90, cardinal: "south" }))).toEqual([
      { tag: "MOVED", who: "m", band: "there", cardinal: "south" },
    ]);
    // 44°→46° crosses the east/south boundary: the WORD changes, the body did
    // not move. This is exactly what the hysteresis exists to suppress.
    expect(
      deltas(sub("m", { bearing: 44, cardinal: "east" }), sub("m", { bearing: 46, cardinal: "south" })),
    ).toEqual([]);
    expect(swing(-170, 170)).toBe(20); // and the wrap is the SHORT way round
  });

  it("HOLD on a hands change, both ways", () => {
    expect(deltas(sub("m"), sub("m", { holding: ["apple"] }))).toEqual([
      { tag: "HOLD", who: "m", what: "apple" },
    ]);
    expect(deltas(sub("m", { holding: ["apple"] }), sub("m"))).toEqual([
      { tag: "HOLD", who: "m", what: null },
    ]);
  });

  it("WEAR on a renderer-visible dress change", () => {
    expect(
      deltas(
        sub("m", { appearance: ["species:human", "garment:shirt", "color:color_blue"], dress: "blue" }),
        sub("m", { appearance: ["species:human", "garment:shirt", "color:color_red"], dress: "red" }),
      ),
    ).toEqual([{ tag: "WEAR", who: "m", what: "red" }]);
  });

  it("OPEN on a lid flip", () => {
    const shut = sub("box", { kind: "object", word: "box", open: 0 });
    const open = sub("box", { kind: "object", word: "box", open: 1 });
    expect(deltas(shut, open)).toEqual([{ tag: "OPEN", what: "box", open: true }]);
    expect(deltas(open, shut)).toEqual([{ tag: "OPEN", what: "box", open: false }]);
  });

  it("STOCK only while the container is OPEN — a shut lid is not an empty box", () => {
    const openFull = sub("box", { kind: "object", word: "box", open: 1, contains: ["apple"] });
    const openMore = sub("box", { kind: "object", word: "box", open: 1, contains: ["apple", "cookie"] });
    expect(deltas(openFull, openMore)).toEqual([
      { tag: "STOCK", what: "box", items: ["apple", "cookie"] },
    ]);
    // Shutting it reports the LID, never a phantom emptying.
    const shut = sub("box", { kind: "object", word: "box", open: 0 });
    expect(deltas(openFull, shut)).toEqual([{ tag: "OPEN", what: "box", open: false }]);
  });

  it("fires several deltas in one frame, in the table's order", () => {
    const before = sub("m", { activity: { verb: "walk" }, bearing: 0 });
    const after = sub("m", {
      activity: { verb: "eat", object: "apple" },
      band: "here",
      distance: 2,
      bearing: 0,
      holding: ["apple"],
      appearance: ["species:human", "garment:shirt", "color:color_red"],
      dress: "red",
    });
    expect(deltas(before, after).map((e) => e.tag)).toEqual(["DOING", "MOVED", "HOLD", "WEAR"]);
  });

  it("narrates NOTHING for a subject that is tracked but not watched", () => {
    const b = book();
    const tracked = new Set(["m"]);
    b.step(scene([sub("m", { activity: { verb: "walk" } })]), { tracked });
    // Presence still diffs (that is what tracked means) — the DELTAS do not.
    expect(b.step(scene([sub("m", { activity: { verb: "eat" } })]), { tracked })).toEqual([]);
  });
});

describe("watch — a watch never grants visibility (§6)", () => {
  it("emits ONE exit with the transit, then silence, and re-enters on return", () => {
    const b = book();
    b.add("m");
    const tracked = new Set(["m"]);
    const here = sub("m", { activity: { verb: "walk" } });
    b.step(scene([here]), { tracked }); // baseline

    const gone = b.step(scene([]), {
      tracked,
      transitOf: () => "into the blue house",
    });
    expect(gone).toEqual([{ tag: "EXIT", who: "m", via: "into the blue house" }]);
    // SILENCE while out of view — the watch is still on, and says nothing.
    expect(b.step(scene([]), { tracked })).toEqual([]);
    expect(b.step(scene([]), { tracked })).toEqual([]);
    expect(b.has("m")).toBe(true);

    // …and the moment it is visible again, the watch picks it up.
    expect(b.step(scene([here]), { tracked })).toEqual([
      { tag: "ENTER", who: "m", where: "there east" },
    ]);
  });

  it("falls back to the band and cardinal when the exit was not a doorway", () => {
    const b = book();
    b.add("m");
    const tracked = new Set(["m"]);
    b.step(scene([sub("m")]), { tracked });
    expect(b.step(scene([]), { tracked })).toEqual([
      { tag: "EXIT", who: "m", where: "there east" },
    ]);
  });

  it("unwatching forgets the baseline, so re-watching starts silent again", () => {
    const b = book();
    b.add("m");
    const tracked = new Set(["m"]);
    b.step(scene([sub("m")]), { tracked });
    expect(b.remove("m")).toBe(true);
    b.add("m");
    expect(b.step(scene([sub("m", { band: "here", distance: 1 })]), { tracked })).toEqual([]);
  });

  it("caps at 8 and reports the cap", () => {
    const b = book();
    for (let i = 0; i < 8; i++) expect(b.add(`m${i}`)).toBe("added");
    expect(b.add("m8")).toBe("full");
    expect(b.add("m0")).toBe("already");
    expect(b.ids()).toHaveLength(8);
    expect(b.clear()).toBe(8);
    expect(b.ids()).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Through a session — where the commands and the cap message live.
// ───────────────────────────────────────────────────────────────────────────

const SPEC: WorldSpec = {
  engine: "world",
  engineVersion: 1,
  meta: { title: "t", locale: "en", theme: "t" },
  manifold: { kind: "flat", width: 200, height: 200 },
  terrain: { kind: "flat" },
  spawns: [{ id: "s", x: 0, y: 0, facing: 0 }],
  objects: [],
  multiplayer: { maxPlayers: 4, authority: "distributed" },
  content: { kind: "sandbox" },
};

function world(n: number): WorldState {
  const s = createWorldState(SPEC, "me");
  s.avatars.me!.x = 0;
  s.avatars.me!.y = 0;
  for (let i = 0; i < n; i++) addLocalAvatar(s, `npc_${i}`, 5 + i, 0, 0);
  return s;
}

function rig(state: WorldState, onFrame?: (s: WorldState) => void) {
  const frameDt = 1 / 60;
  let tap: Partial<QuestPresenter> = {};
  const probe = (): TextViewProbe => ({
    state,
    intent: { aim: null, sitting: false },
    dt: frameDt,
    worldToScreen: (p) => ({ x: p.x, y: p.y }),
  });
  const deps: TextSessionDeps = {
    host: { speak: () => {}, select: () => {} },
    view: { probe },
    stepFrame() {
      state.time += frameDt;
      onFrame?.(state);
    },
    frameDt,
    addPresenterTap(p) {
      tap = p;
    },
    locale: "en",
    activityOf: (cid) => (cid === "npc_0" ? { verb: "walk" } : undefined),
  };
  return { session: createTextModeSession(deps), tap };
}

describe("text session — the watch commands", () => {
  it("watches, lists and unwatches by text id", () => {
    const r = rig(world(3));
    r.session.command("scene");
    expect(r.session.command("watch person 1").lines[0]).toBe("WATCH  watching person-1.");
    expect(r.session.command("watch person 2").lines[0]).toBe("WATCH  watching person-2.");
    expect(r.session.watching()).toEqual(["person-1", "person-2"]);
    expect(r.session.command("watching").lines[0]).toBe("WATCH  watching person-1, person-2.");

    expect(r.session.command("unwatch person 1").lines[0]).toBe("WATCH  no longer watching person-1.");
    expect(r.session.command("unwatch person 1").events[0]).toEqual({
      tag: "ERR",
      text: `not watching "person-1".`,
    });
    expect(r.session.command("unwatch all").lines[0]).toBe("OK     stopped watching 1 thing(s).");
    expect(r.session.command("watching").lines[0]).toBe("WATCH  watching nobody.");
  });

  it("refuses the ninth watch, naming the cap", () => {
    const r = rig(world(9));
    r.session.command("scene");
    for (let i = 1; i <= 8; i++) expect(r.session.command(`watch person ${i}`).lines[0]).toContain("watching");
    const out = r.session.command("watch person 9");
    expect(out.events[0]).toEqual({
      tag: "ERR",
      text: "already watching 8 things — the cap is 8. Unwatch one first.",
    });
    expect(r.session.watching()).toHaveLength(8);
  });

  it("narrates a watched body's deltas, and only the watched one's", () => {
    const state = world(2);
    let moved = false;
    const r = rig(state, (s) => {
      if (moved) {
        s.avatars.npc_0!.x = 1;
        s.avatars.npc_1!.x = 1;
      }
    });
    r.session.command("scene");
    r.session.command("watch person 1"); // npc_0 — the nearer of the two
    r.session.command("wait 1"); // baseline
    moved = true;
    const out = r.session.command("wait 1");
    const movedEvents = out.events.filter((e) => e.tag === "MOVED");
    expect(movedEvents).toHaveLength(1);
    expect(movedEvents[0]).toMatchObject({ who: "person-1", band: "here" });
  });

  it("a watched body is NAMED in the scene even when the crowd would bucket it", () => {
    // Six identical anonymous bodies: without a watch they are one crowd line.
    const state = world(6);
    const r = rig(state);
    r.session.command("scene");
    const before = r.session.command("scene");
    expect(before.lines.join("\n")).not.toContain("person-4 (person)");
    r.session.command("watch person 4");
    const after = r.session.command("scene");
    expect(after.lines.join("\n")).toContain("person-4 (person)");
  });
});

describe("text scene index — resolution is unaffected by watching", () => {
  it("keeps the latched ordinal across a watch and an unwatch", () => {
    const index = createSceneIndex();
    const list = [sub("a", { distance: 1 }), sub("b", { distance: 2 })];
    index.assign(list);
    expect(list.map((s) => s.textId)).toEqual(["person-1", "person-2"]);
  });
});
