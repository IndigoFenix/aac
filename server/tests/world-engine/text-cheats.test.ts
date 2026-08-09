// TEXT MODE step ⑪ — THE CHEAT CHANNEL (design law ⑦).
//
// "A different object, a different prefix and a different file." Four things
// must hold or the harness lies about its own results:
//
//   • OFF BY DEFAULT. Without `--cheats` the channel answers with a closed door
//     and reaches nothing.
//   • THE OUTPUT IS A DIFFERENT CHANNEL. A peek lands in `TextFrame.cheatLines`
//     and NEVER in `lines`, so a transcript keeps its shape.
//   • EXACTLY ONE MARKER joins the ordinary stream, so a reviewer knows the
//     tester peeked (using one invalidates a UX-gap result).
//   • `help` never mentions the channel. A driver that has not heard of it
//     cannot lean on it.

import { describe, it, expect } from "@jest/globals";
import {
  CHEAT_COMMANDS,
  createTextModeSession,
  runCheat,
  type TextSessionDeps,
  type TextViewProbe,
} from "@shared/world-engine/interaction/text/index.js";
import {
  addLocalAvatar,
  createWorldState,
  type WorldState,
} from "@shared/world-engine/engine.js";
import type { WorldSpec } from "@shared/world-engine/types.js";

const SPEC: WorldSpec = {
  engine: "world",
  engineVersion: 1,
  meta: { title: "t", locale: "en", theme: "t" },
  manifold: { kind: "flat", width: 60, height: 60 },
  terrain: { kind: "flat" },
  spawns: [{ id: "s", x: 0, y: 0, facing: 0 }],
  objects: [],
  npcs: [{ id: "npc_mara", x: 5, y: 0, name: "Mara", species: "human" }],
  multiplayer: { maxPlayers: 4, authority: "distributed" },
  content: { kind: "sandbox" },
};

function world(): WorldState {
  const s = createWorldState(SPEC, "me");
  s.avatars.me!.x = 0;
  s.avatars.me!.y = 0;
  addLocalAvatar(s, "npc_mara", 5, 0, 0);
  return s;
}

/** The omniscient surface — everything law ⑦ quarantines. */
const CHEAT_HOST = {
  conversationAudit: () => [
    { id: "c1", members: ["npc_mara"], rung: 2 },
    { id: "c2", members: [], rung: 0 },
  ],
  scopeTree: () => ({ id: "town", children: [{ id: "house-1", stock: { apple: 2 } }] }),
  stockAudit: () => ({ apple: 7, cookie: 1 }),
  carryOf: (cid: string) => ({ who: cid, apple: 1 }),
  debugProbe: () => "cutaway=1 mode=dollhouse pointer=none",
  // why-chains.md §4 — the degeneration instrument: the raw task chain behind
  // "why are you doing that?", which no player can see and so lives here.
  whyProbe: (cid: string) => [
    { kind: "activity", clause: { subject: "i_me", verb: "get", object: "apple" }, who: cid },
    { kind: "motive", clause: { subject: "i_me", verb: "hungry", key: "hungry" } },
    { kind: "end" },
  ],
};

function rig(opts: { cheats?: boolean; host?: typeof CHEAT_HOST | Record<string, never> } = {}) {
  const state = world();
  const frameDt = 1 / 60;
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
    },
    frameDt,
    addPresenterTap() {},
    locale: "en",
    nameOf: (id) => (id === "npc_mara" ? "Mara" : undefined),
    ...(opts.cheats ? { cheats: true } : {}),
    cheatHost: opts.host ?? CHEAT_HOST,
  };
  return { session: createTextModeSession(deps), state };
}

describe("cheats — the channel is closed until it is opened", () => {
  it("refuses every command by name, and reaches nothing", () => {
    let touched = 0;
    const r = rig({
      host: { ...CHEAT_HOST, stockAudit: () => (touched++, {}) } as unknown as typeof CHEAT_HOST,
    });
    for (const c of CHEAT_COMMANDS) {
      const out = r.session.command(`/${c} x`);
      expect(out.events).toEqual([{ tag: "ERR", text: "cheat channel disabled (--cheats)." }]);
      expect(out.cheatLines).toBeUndefined();
    }
    expect(touched).toBe(0);
  });

  it("`help` never mentions it", () => {
    const r = rig({ cheats: true });
    const text = r.session.command("help").lines.join("\n").toLowerCase();
    expect(text).not.toContain("cheat");
    for (const c of CHEAT_COMMANDS) expect(text).not.toContain(`/${c}`);
  });
});

describe("cheats — a peek is a different channel with a marker in the stream", () => {
  it("puts the audit in cheatLines and ONLY the marker in lines", () => {
    const r = rig({ cheats: true });
    const out = r.session.command("/convos");
    // The ordinary stream carries the MARKER and nothing else.
    expect(out.events).toEqual([{ tag: "CHEAT", text: "/convos" }]);
    expect(out.lines).toEqual(["CHEAT  /convos"]);
    // The peek itself is elsewhere.
    expect(out.cheatLines).toEqual([
      `{"id":"c1","members":["npc_mara"],"rung":2}`,
      `{"id":"c2","members":[],"rung":0}`,
    ]);
    // Reading can never move the sim: no TICK, because no time passed.
    expect(out.events.some((e) => e.tag === "TICK")).toBe(false);
  });

  it("serves every command in the set", () => {
    const r = rig({ cheats: true });
    expect(r.session.command("/scope").cheatLines?.[0]).toBe("{");
    expect(r.session.command("/stock").cheatLines).toEqual([`{`, `  "apple": 7,`, `  "cookie": 1`, `}`]);
    expect(r.session.command("/probe").cheatLines).toEqual(["cutaway=1 mode=dollhouse pointer=none"]);
  });

  it("`/carry` resolves a TEXT id to its sim id before asking", () => {
    const r = rig({ cheats: true });
    r.session.command("scene"); // latch `mara`
    const out = r.session.command("/carry mara");
    expect(out.events).toEqual([{ tag: "CHEAT", text: "/carry mara" }]);
    expect(out.cheatLines?.[0]).toBe("mara = npc_mara");
    expect(out.cheatLines?.join("\n")).toContain(`"who": "npc_mara"`);
  });

  it("⚖️ `/carry` says what is IN THE HANDS — the thing the merged view drops", () => {
    // `carryOf` is the merged stock view, which never lists the held bag ("the
    // shelf, not the goods"), so this dump alone reported a body walking home
    // with an EMPTY BASKET as carrying nothing at all. Same renderer as the
    // creature readout (`carryRowText`), so the two cannot drift.
    const empty = runCheat("carry", "npc_mara", {
      host: { carryOf: () => ({}), handsOf: () => ({ objId: "p1", glyph: "basket", bag: true }) },
      simIdOf: () => undefined,
      recordOf: () => null,
    });
    expect(empty.lines[1]).toBe("hands = basket (empty)");
    const full = runCheat("carry", "npc_mara", {
      host: { carryOf: () => ({ apple: 2 }), handsOf: () => ({ objId: "p1", glyph: "basket", bag: true }) },
      simIdOf: () => undefined,
      recordOf: () => null,
    });
    expect(full.lines[1]).toBe("hands = basket [apple×2]");
    // A build whose cheat host has no `handsOf` still answers — with the
    // merged view alone, exactly as before.
    const old = runCheat("carry", "npc_mara", {
      host: { carryOf: () => ({ apple: 2 }) },
      simIdOf: () => undefined,
      recordOf: () => null,
    });
    expect(old.lines[1]).toBe("hands = apple×2");
  });

  it("`/why` resolves a TEXT id too, and dumps the raw chain", () => {
    const r = rig({ cheats: true });
    r.session.command("scene"); // latch `mara`
    const out = r.session.command("/why mara");
    expect(out.events).toEqual([{ tag: "CHEAT", text: "/why mara" }]);
    expect(out.cheatLines?.[0]).toBe("mara = npc_mara");
    // One JSON row per LINK — the ladder, in order, terminator included.
    expect(out.cheatLines?.slice(1)).toEqual([
      `{"kind":"activity","clause":{"subject":"i_me","verb":"get","object":"apple"},"who":"npc_mara"}`,
      `{"kind":"motive","clause":{"subject":"i_me","verb":"hungry","key":"hungry"}}`,
      `{"kind":"end"}`,
    ]);
  });

  it("`/truth` needs no host at all — it is the projection's own confession", () => {
    const r = rig({ cheats: true, host: {} as unknown as typeof CHEAT_HOST });
    r.session.command("scene");
    const out = r.session.command("/truth mara");
    expect(out.events).toEqual([{ tag: "CHEAT", text: "/truth mara" }]);
    const text = out.cheatLines!.join("\n");
    expect(out.cheatLines![0]).toBe("mara = npc_mara");
    // The sim id AND the raw record the projection worded.
    expect(text).toContain(`"textId": "mara"`);
    expect(text).toContain(`"npcSpec"`);
    expect(text).toContain(`"name": "Mara"`);
  });

  it("says which method a build's cheat host is missing, rather than crashing", () => {
    const r = rig({ cheats: true, host: {} as unknown as typeof CHEAT_HOST });
    expect(r.session.command("/convos").events[0]).toEqual({
      tag: "ERR",
      text: "this build's cheat host has no conversationAudit().",
    });
    expect(r.session.command("/nonsense").events[0]).toMatchObject({ tag: "ERR" });
    expect(r.session.command("/truth nobody").events[0]).toEqual({
      tag: "ERR",
      text: `no text id "nobody" is latched.`,
    });
    expect(r.session.command("/carry").events[0]).toEqual({
      tag: "ERR",
      text: "/carry needs a creature id.",
    });
  });

  it("runCheat is pure over its ctx — nothing it does can move a world", () => {
    const seen: string[] = [];
    const r = runCheat("carry", "npc_x", {
      host: { carryOf: (cid) => (seen.push(cid), { apple: 1 }) },
      simIdOf: () => undefined,
      recordOf: () => null,
    });
    expect(r.ok).toBe(true);
    expect(r.marker).toBe("/carry npc_x");
    expect(seen).toEqual(["npc_x"]); // the raw id passed straight through
  });
});
