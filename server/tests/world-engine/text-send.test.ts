// TEXT MODE step ⑨ — `send <creature> to <target>` OVER THE LOCAL COMMAND
// CHANNEL (design §4, law ⑥).
//
// "BYPASS THE PIXELS, NEVER THE SIM." A pointer player gives this order by
// resting the gaze on somebody and then on a place; the host reads the pair as a
// `PlayerAction` and puts it through its gate. Text mode has no pointer to pair,
// so it issues THE SAME THREE ACTIONS through `QuestHost3D.perform` — the host's
// local command channel, which ends in the same executor. So what is under test
// here is the RESOLUTION and the ACTION, not the walking:
//
//   creature → attendCreature · object → attendObject at its point ·
//   place → sendTo at the building's footprint centre
//
// …plus the three refusals that must never become a guess: an ambiguous name is
// ASKED about, a chair cannot be an actor, and a boot with no channel says so
// instead of pretending to have acted.

import { describe, it, expect } from "@jest/globals";
import {
  createTextModeSession,
  type TextEvent,
  type TextSessionDeps,
  type TextViewProbe,
} from "@shared/world-engine/interaction/text/index.js";
import type { PlayerAction } from "@shared/world-engine/player-action.js";
import {
  addLocalAvatar,
  addWorldObject,
  createWorldState,
  expandWorldBuildings,
  type WorldState,
} from "@shared/world-engine/engine.js";
import type { BuildingSpec, WorldSpec } from "@shared/world-engine/types.js";

const BASE: WorldSpec = {
  engine: "world",
  engineVersion: 1,
  meta: { title: "t", locale: "en", theme: "t" },
  manifold: { kind: "flat", width: 400, height: 400 },
  terrain: { kind: "flat" },
  spawns: [{ id: "s", x: 0, y: 0, facing: 0 }],
  objects: [],
  multiplayer: { maxPlayers: 4, authority: "distributed" },
  content: { kind: "sandbox" },
};

/** A blue house east of the yard — footprint centre (30, 0). */
const HOUSE: BuildingSpec = {
  id: "b1",
  footprint: { x: 26, y: -4, w: 8, h: 8 },
  floors: 1,
  wallThickness: 0.4,
  color: "#2563EB",
  doorways: [{ edge: "west", offset: 4, width: 2 }],
};

/** `me` at the origin, Mara 20 m east, Bram 10 m east, a chair 5 m east, and a
 *  house whose centre is 30 m east. */
function world(): WorldState {
  const s = createWorldState(expandWorldBuildings({ ...BASE, buildings: [HOUSE] }), "me");
  s.avatars.me!.x = 0;
  s.avatars.me!.y = 0;
  addLocalAvatar(s, "npc_mara", 20, 0, 0);
  addLocalAvatar(s, "npc_bram", 10, 0, 0);
  addWorldObject(s, { id: "chair1", x: 5, y: 0, shape: "box", radius: 0.4, fixture: "chair", interactions: [] });
  return s;
}

interface Rig {
  session: ReturnType<typeof createTextModeSession>;
  state: WorldState;
  /** Every action the session put through the host's local channel, in order. */
  issued: PlayerAction[];
  frames: () => number;
}

interface RigOpts {
  state?: WorldState;
  spirit?: boolean;
  /** An OLDER BOOT: a host with no local command channel at all. */
  noChannel?: boolean;
}

function rig(opts: RigOpts = {}): Rig {
  const state = opts.state ?? world();
  const issued: PlayerAction[] = [];
  let frame = 0;
  const frameDt = 1 / 60;

  const probe = (): TextViewProbe => ({
    state,
    intent: { aim: null, sitting: false },
    dt: frameDt,
    worldToScreen: (p) => ({ x: p.x, y: p.y }),
  });

  const deps: TextSessionDeps = {
    host: {
      speak: () => {},
      select: () => {},
      // The channel is FEATURE-DETECTED, so a rig can genuinely lack it.
      ...(opts.noChannel ? {} : { perform: (a: PlayerAction) => void issued.push(a) }),
    },
    view: { probe },
    stepFrame() {
      frame += 1;
      state.time += frameDt;
    },
    frameDt,
    addPresenterTap() {},
    locale: "en",
    nameOf: (id) => (id === "npc_mara" ? "Mara" : id === "npc_bram" ? "Bram" : undefined),
    look: () => {},
    clearLook: () => {},
    ...(opts.spirit ? { spirit: true } : {}),
  };

  return { session: createTextModeSession(deps), state, issued, frames: () => frame };
}

const ticks = (events: readonly TextEvent[]): TextEvent[] => events.filter((e) => e.tag === "TICK");

describe("text send — the order, resolved (§4)", () => {
  it("creature → PLACE issues `sendTo` at the building's footprint centre", () => {
    const r = rig();
    r.session.command("scene");
    const before = r.frames();
    const out = r.session.command("send mara to house-1");
    expect(out.lines[0]).toBe("OK     told mara to go to house-1.");
    expect(r.issued).toEqual([{ kind: "sendTo", cid: "npc_mara", x: 30, y: 0 }]);
    // Issued, then SETTLED like any other act — exactly one TICK closes it.
    expect(ticks(out.events)).toHaveLength(1);
    expect(r.frames()).toBeGreaterThan(before);
  });

  it("creature → OBJECT issues `attendObject` at the object's own point", () => {
    const r = rig();
    r.session.command("scene");
    r.session.command("send mara to chair-1");
    expect(r.issued).toEqual([{ kind: "attendObject", cid: "npc_mara", id: "chair1", x: 5, y: 0 }]);
  });

  it("creature → CREATURE issues `attendCreature`, and carries no point at all", () => {
    const r = rig();
    const out = r.session.command("send mara to bram");
    expect(out.lines[0]).toBe("OK     told mara to go to bram.");
    expect(r.issued).toEqual([{ kind: "attendCreature", cid: "npc_mara", id: "npc_bram" }]);
  });

  it("a SPIRIT may send — that is the whole point of the command", () => {
    // `go` refuses in a spirit scope (no feet); `send` must not, because
    // directing residents is exactly what a dollhouse spirit does.
    const r = rig({ spirit: true });
    expect(r.session.command("go mara").events[0]!.tag).toBe("ERR");
    const out = r.session.command("send mara to bram");
    expect(out.events[0]).toEqual({ tag: "OK", text: "told mara to go to bram." });
    expect(r.issued).toHaveLength(1);
  });

  it("never gates on WILLINGNESS — refusing is the creature's job, not the parser's", () => {
    // The command reports what it TOLD somebody, never what they will do: the
    // answer is the bubble diff after the settle (law ②/③).
    const r = rig();
    const out = r.session.command("send bram to mara");
    expect(out.events[0]).toMatchObject({ tag: "OK" });
    expect(out.events.some((e) => e.tag === "SAY" || e.tag === "SILENT")).toBe(false);
    expect(r.issued[0]).toMatchObject({ kind: "attendCreature", cid: "npc_bram" });
  });
});

describe("text send — the refusals (never a guess, never a throw)", () => {
  it("ASKS which one when the actor's name is ambiguous, and issues nothing", () => {
    const s = world();
    addLocalAvatar(s, "npc_a", 5, 2, 0);
    addLocalAvatar(s, "npc_b", 0, 5, 0);
    const r = rig({ state: s });
    r.session.command("scene");
    const before = r.frames();
    const out = r.session.command("send person to bram");
    const ask = out.events[0] as Extract<TextEvent, { tag: "ASK" }>;
    expect(ask.tag).toBe("ASK");
    expect(ask.question).toBe(`which "person"?`);
    expect(r.issued).toEqual([]);
    expect(r.frames()).toBe(before); // it refused, so it moved no time
  });

  it("ASKS about an ambiguous TARGET too", () => {
    const s = world();
    addWorldObject(s, { id: "chair2", x: 6, y: 1, shape: "box", radius: 0.4, fixture: "chair", interactions: [] });
    const r = rig({ state: s });
    r.session.command("scene");
    const out = r.session.command("send mara to chair");
    expect(out.events[0]!.tag).toBe("ASK");
    expect(r.issued).toEqual([]);
  });

  it("refuses an OBJECT as the actor — only somebody with legs can be sent", () => {
    const r = rig();
    r.session.command("scene");
    const before = r.frames();
    const out = r.session.command("send chair-1 to bram");
    expect(out.events[0]).toEqual({
      tag: "ERR",
      text: "chair-1 is a chair — only somebody with legs can be sent.",
    });
    expect(r.issued).toEqual([]);
    expect(r.frames()).toBe(before);
  });

  it("refuses a PLACE as the actor as well", () => {
    const r = rig();
    r.session.command("scene");
    const out = r.session.command("send house-1 to bram");
    expect(out.events[0]).toMatchObject({ tag: "ERR" });
    expect(r.issued).toEqual([]);
  });

  it("says so when nothing here answers to the name", () => {
    const r = rig();
    expect(r.session.command("send nobody to bram").events[0]).toEqual({
      tag: "ERR",
      text: `nothing here called "nobody".`,
    });
    expect(r.issued).toEqual([]);
  });

  it("keeps the TODO answer on a boot with NO command channel (feature-detected)", () => {
    const r = rig({ noChannel: true });
    const out = r.session.command("send mara to bram");
    expect(out.events[0]).toEqual({
      tag: "ERR",
      text: "not wired yet (needs a host command channel — step ⑨ TODO): send mara to bram.",
    });
    expect(r.frames()).toBe(0);
    // …and a malformed `send` still fails at the PARSER, before any of this.
    expect(r.session.command("send mara").events[0]!.tag).toBe("ERR");
  });
});
