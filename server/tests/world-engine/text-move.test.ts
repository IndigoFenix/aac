// TEXT MODE step ⑨ — MOVEMENT (design §4/D3, law ⑥).
//
// "BYPASS THE PIXELS, NEVER THE SIM." There is no text-only walk: `go` and
// `approach` feed the POINTER at a world point (the text view's screen map is
// the identity), and the sim's own steering does the rest. So the thing under
// test is not "did the body move" — the fake view below moves it — but:
//
//   • the aim is STANDING: re-fed at the target's CURRENT position every frame,
//     which is the only way to reach something that is itself walking;
//   • `approach` aims at `approachAim`'s stop-short point, so the body halts at
//     conversation distance and the host's own dwell opens the talk;
//   • the settle runs TO ARRIVAL (capped), and closes with `arrived after Xs.`
//     or `still walking — Ym to go.` — exactly one TICK either way;
//   • a SPIRIT is told it has no feet, never silently ignored;
//   • comings and goings narrate as ENTER/EXIT, with the visible transit when
//     the exit was a doorway.

import { describe, it, expect } from "@jest/globals";
import {
  createTextModeSession,
  type TextEvent,
  type TextSessionDeps,
  type TextViewProbe,
} from "@shared/world-engine/interaction/text/index.js";
import { approachAim } from "@shared/world-engine/interact.js";
import type { QuestPresenter } from "@shared/world-engine/interaction/quest/quest-host.js";
import {
  addLocalAvatar,
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

/** A flat world with `me` at the origin, Mara 20 m east and Bram 10 m east. */
function world(buildings: BuildingSpec[] = []): WorldState {
  const spec = buildings.length ? expandWorldBuildings({ ...BASE, buildings }) : BASE;
  const s = createWorldState(spec, "me");
  s.avatars.me!.x = 0;
  s.avatars.me!.y = 0;
  addLocalAvatar(s, "npc_mara", 20, 0, 0);
  addLocalAvatar(s, "npc_bram", 10, 0, 0);
  return s;
}

interface Rig {
  session: ReturnType<typeof createTextModeSession>;
  state: WorldState;
  /** Every point the pointer was fed, in order — the standing aim's own record. */
  fed: { x: number; y: number }[];
  cleared: number;
  frames: () => number;
  tap: Partial<QuestPresenter>;
}

interface RigOpts {
  state?: WorldState;
  spirit?: boolean;
  /** Omit the pointer entirely — a build with nothing to walk with. */
  noLook?: boolean;
  travel?: { capS?: number; arriveR?: number };
  /** Metres per second the fake sim walks the driven body toward the pointer. */
  speed?: number;
  /** Script the world: runs after the body has been advanced, each frame. */
  onFrame?: (state: WorldState, frame: number) => void;
}

function rig(opts: RigOpts = {}): Rig {
  const state = opts.state ?? world();
  const fed: { x: number; y: number }[] = [];
  let cleared = 0;
  let pointer: { x: number; y: number } | null = null;
  let frame = 0;
  const frameDt = 1 / 60;
  const speed = opts.speed ?? 6;
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
      frame += 1;
      state.time += frameDt;
      // THE FAKE SIM: the driven body walks toward whatever the pointer says,
      // which is exactly the coupling the standing aim exists to exploit.
      const me = state.avatars.me!;
      if (pointer) {
        const dx = pointer.x - me.x;
        const dy = pointer.y - me.y;
        const d = Math.hypot(dx, dy);
        const step = speed * frameDt;
        if (d > step) {
          me.x += (dx / d) * step;
          me.y += (dy / d) * step;
        } else {
          me.x = pointer.x;
          me.y = pointer.y;
        }
      }
      opts.onFrame?.(state, frame);
    },
    frameDt,
    addPresenterTap(p) {
      tap = p;
    },
    locale: "en",
    nameOf: (id) => (id === "npc_mara" ? "Mara" : id === "npc_bram" ? "Bram" : undefined),
    ...(opts.noLook
      ? {}
      : {
          look: (x, y) => {
            pointer = { x, y };
            fed.push({ x, y });
          },
          clearLook: () => {
            pointer = null;
            cleared += 1;
          },
        }),
    ...(opts.spirit ? { spirit: true } : {}),
    ...(opts.travel ? { travel: opts.travel } : {}),
  };

  return { session: createTextModeSession(deps), state, fed, get cleared() { return cleared; }, frames: () => frame, tap };
}

const ticks = (events: readonly TextEvent[]): TextEvent[] => events.filter((e) => e.tag === "TICK");

describe("text move — the standing aim (§4: re-fed each step until arrival)", () => {
  it("walks to a STATIONARY target and closes with `arrived`", () => {
    const r = rig();
    const out = r.session.command("go mara");
    expect(out.lines[0]).toBe("OK     walking to mara.");
    expect(ticks(out.events)).toHaveLength(1);
    expect(ticks(out.events)[0]).toMatchObject({ reason: "arrived" });
    expect(out.lines[out.lines.length - 1]).toMatch(/^TICK {3}arrived after \d+\.\ds\.$/);
    expect(Math.hypot(r.state.avatars.me!.x - 20, r.state.avatars.me!.y)).toBeLessThanOrEqual(1.5);
    // The aim is the target itself for `go` — the pointer never stood short.
    expect(r.fed[0]).toEqual({ x: 20, y: 0 });
  });

  it("RE-FEEDS the aim at the target's current position — a walker is caught", () => {
    // Mara walks east at 3 m/s while the player closes at 6: an aim fed ONCE at
    // her starting spot would leave the body stranded at x=20 forever.
    const r = rig({
      onFrame: (state) => {
        state.avatars.npc_mara!.x += 3 / 60;
      },
    });
    const out = r.session.command("go mara");
    expect(ticks(out.events)[0]).toMatchObject({ reason: "arrived" });

    const mara = r.state.avatars.npc_mara!;
    expect(mara.x).toBeGreaterThan(30); // she really did keep walking
    // The body chased her far past x=20, where a ONE-SHOT aim would have parked
    // it forever, and stood within arm's length of the last point it was given.
    const last = r.fed[r.fed.length - 1]!;
    expect(last.x).toBeGreaterThan(30);
    expect(r.state.avatars.me!.x).toBeGreaterThan(30);
    expect(Math.abs(r.state.avatars.me!.x - last.x)).toBeLessThanOrEqual(1.5);
    expect(r.fed.length).toBeGreaterThan(100); // one feed per stepped frame
  });

  it("`approach` stops at approachAim's point, short of the body", () => {
    const r = rig();
    const out = r.session.command("approach mara");
    expect(out.lines[0]).toBe("OK     approaching mara.");
    expect(ticks(out.events)[0]).toMatchObject({ reason: "arrived" });

    // The FIRST fed point is exactly what `approachAim` computes — the same pure
    // function the GL gaze runs, so the dwell fires at the same distance.
    const want = approachAim({ x: 0, y: 0 }, { x: 20, y: 0 }, "avatar");
    expect(r.fed[0]!.x).toBeCloseTo(want.x, 6);
    expect(want.x).toBeCloseTo(18, 6);
    // The body stopped SHORT of her, at conversation distance…
    const me = r.state.avatars.me!;
    expect(me.x).toBeLessThan(20);
    expect(Math.hypot(me.x - 20, me.y)).toBeGreaterThan(1.5);
    // …and the pointer is deliberately left resting on her: that IS the dwell.
    expect(r.cleared).toBe(0);
  });

  it("reports the remaining distance when the travel cap runs out", () => {
    const r = rig({ travel: { capS: 0.5 }, speed: 1 });
    const out = r.session.command("go mara");
    const tick = ticks(out.events)[0]!;
    expect(tick).toMatchObject({ reason: "walking" });
    expect(out.lines[out.lines.length - 1]).toMatch(/^TICK {3}still walking — \d+ m to go\.$/);
    // …and the aim STANDS, so the next command keeps driving it (§5).
    const more = r.session.command("wait 1");
    expect(r.state.avatars.me!.x).toBeGreaterThan(1);
    expect(ticks(more.events)).toHaveLength(1);
  });

  it("`stop` clears the pointer and says what it stopped", () => {
    const r = rig({ travel: { capS: 0.2 }, speed: 1 });
    r.session.command("go mara");
    const out = r.session.command("stop");
    expect(out.lines[0]).toBe("OK     stopped walking to mara.");
    expect(r.cleared).toBe(1);
    // With no aim standing, nothing walks any more.
    const x = r.state.avatars.me!.x;
    r.session.command("wait 1");
    expect(r.state.avatars.me!.x).toBeCloseTo(x, 6);
    expect(r.session.command("stop").lines[0]).toBe("OK     not walking.");
  });
});

describe("text move — the scope answers, never a silent no-op", () => {
  it("a SPIRIT is told it has no feet, and what to do instead", () => {
    const r = rig({ spirit: true });
    const out = r.session.command("go mara");
    expect(out.events[0]).toEqual({
      tag: "ERR",
      text: "you are a bodiless spirit here — act through a creature (family/send) or claim a body.",
    });
    expect(r.fed).toEqual([]);
    expect(r.frames()).toBe(0);
    expect(r.session.command("approach mara").events[0]!.tag).toBe("ERR");
  });

  it("a build with no pointer wired says so", () => {
    const r = rig({ noLook: true });
    expect(r.session.command("go mara").events[0]).toMatchObject({ tag: "ERR" });
  });

  it("`send` is parsed but NOT wired — no host command channel reaches sendTo", () => {
    const r = rig();
    const out = r.session.command("send mara to bram");
    expect(out.events[0]).toEqual({
      tag: "ERR",
      text: "not wired yet (needs a host command channel — step ⑨ TODO): send mara to bram.",
    });
    // It refused, so it moved no time.
    expect(r.frames()).toBe(0);
    expect(r.session.command("send mara").events[0]!.tag).toBe("ERR");
  });

  it("asks which one, with the §4 discriminator ladder", () => {
    const s = world();
    // Two bodies the index will latch under the same anonymous stem.
    addLocalAvatar(s, "npc_a", 5, 0, 0);
    addLocalAvatar(s, "npc_b", 0, 5, 0);
    const r = rig({ state: s });
    r.session.command("scene");
    const out = r.session.command("go person");
    const ask = out.events[0] as Extract<TextEvent, { tag: "ASK" }>;
    expect(ask.tag).toBe("ASK");
    expect(ask.question).toBe(`which "person"?`);
    // Band is the first rung and does not separate them; CARDINAL does.
    expect(ask.options).toEqual(["person-1 — east", "person-2 — south"]);
    expect(r.fed).toEqual([]);
  });
});

describe("text move — where / who / the steering note", () => {
  it("`where` answers in bands, cardinals and metres", () => {
    const r = rig();
    r.session.command("scene");
    const out = r.session.command("where mara");
    expect(out.lines[0]).toBe("WHERE  mara is there east, 20 m away.");
  });

  it("`who` reports the roster the view publishes, and says so when there is none", () => {
    const r = rig();
    expect(r.session.command("who").lines[0]).toBe("WHO    nobody is talking.");
  });

  it("the first targeted `look` in a walker scope notes that looking also STEERS", () => {
    const r = rig();
    r.session.command("scene");
    const first = r.session.command("look mara");
    const note = first.events.find((e) => e.tag === "NOTE") as Extract<TextEvent, { tag: "NOTE" }>;
    expect(note.text).toContain("STEERS");
    // Once, not once per look.
    expect(r.session.command("look bram").events.some((e) => e.tag === "NOTE")).toBe(false);
  });

  it("a SPIRIT never gets the steering note — nothing of its would steer", () => {
    const r = rig({ spirit: true });
    r.session.command("scene");
    expect(r.session.command("look mara").events.some((e) => e.tag === "NOTE")).toBe(false);
  });
});

describe("text move — ENTER / EXIT stream on the way (law ⑤ governs the stream too)", () => {
  it("narrates a tracked body leaving and coming back", () => {
    let bramAway = false;
    const r = rig({
      onFrame: (state) => {
        state.avatars.npc_bram!.y = bramAway ? 200 : 0;
      },
    });
    // Frame one is the BASELINE: watching somebody already in front of you is
    // not an arrival, so nothing is narrated for it.
    expect(r.session.command("wait 1").events.some((e) => e.tag === "ENTER")).toBe(false);

    bramAway = true;
    const gone = r.session.command("wait 1");
    const exit = gone.events.find((e) => e.tag === "EXIT") as Extract<TextEvent, { tag: "EXIT" }>;
    expect(exit).toMatchObject({ tag: "EXIT", who: "bram" });
    // …and then SILENCE: one EXIT, not one per frame.
    expect(gone.events.filter((e) => e.tag === "EXIT")).toHaveLength(1);
    expect(r.session.command("wait 1").events.filter((e) => e.tag === "EXIT")).toHaveLength(0);

    bramAway = false;
    const back = r.session.command("wait 1");
    expect(back.events.filter((e) => e.tag === "ENTER")).toEqual([
      { tag: "ENTER", who: "bram", where: "there east" },
    ]);
  });

  it("names the VISIBLE TRANSIT when the exit was a doorway", () => {
    const s = world([
      {
        id: "b1",
        footprint: { x: 26, y: -4, w: 8, h: 8 },
        floors: 1,
        wallThickness: 0.4,
        color: "#2563EB",
        doorways: [],
      },
    ]);
    let inside = false;
    const r = rig({
      state: s,
      onFrame: (state) => {
        const bram = state.avatars.npc_bram!;
        if (inside) {
          bram.x = 30;
          bram.y = 0;
        }
      },
    });
    r.session.command("wait 1"); // baseline: bram outdoors, in view
    inside = true;
    const out = r.session.command("wait 1");
    const exit = out.events.find((e) => e.tag === "EXIT") as Extract<TextEvent, { tag: "EXIT" }>;
    expect(exit).toEqual({ tag: "EXIT", who: "bram", via: "into the blue house" });
    expect(out.lines).toContain("EXIT   bram went into the blue house.");
  });

  it("does NOT narrate anonymous crowd — law ⑤ governs the stream as well", () => {
    const s = world();
    addLocalAvatar(s, "npc_x", 12, 0, 0);
    let away = false;
    const r = rig({
      state: s,
      // No name for npc_x, never met, never asked about: crowd.
      onFrame: (state) => {
        state.avatars.npc_x!.y = away ? 200 : 0;
      },
    });
    r.session.command("wait 1");
    away = true;
    const out = r.session.command("wait 1");
    expect(out.events.filter((e) => e.tag === "EXIT" || e.tag === "ENTER")).toEqual([]);
  });

  it("…until the driver asks about them, which makes them somebody", () => {
    const s = world();
    addLocalAvatar(s, "npc_x", 12, 0, 0);
    let away = false;
    const r = rig({
      state: s,
      onFrame: (state) => {
        state.avatars.npc_x!.y = away ? 200 : 0;
      },
    });
    r.session.command("scene");
    r.session.command("look person 1"); // now tracked (index.markReferenced)
    r.session.command("wait 1"); // baseline
    away = true;
    const out = r.session.command("wait 1");
    expect(out.events.filter((e) => e.tag === "EXIT")).toHaveLength(1);
  });
});
