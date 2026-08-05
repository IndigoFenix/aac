// TEXT MODE §2 — the line grammar, as goldens.
//
// `render.ts` is a PURE formatter between the `TextEvent[]` contract and the
// transcript. Two things must hold or the harness is worthless:
//   • the grammar is rigid (TAG padded to 6 + one space; continuations start
//     with two spaces; no blank lines), so transcript diffs align; and
//   • rendering is deterministic — the same events render byte-identically
//     every time, which is what makes "fixed (build, seed, commands) ⇒
//     byte-identical transcript" checkable at all.
//
// Also covers the bubble diff (laws ②/③: a line is COPIED, and a thought bubble
// is a SILENT event) and the board printer (law ④: exactly the page the
// presenter was handed, numbered including chrome).

import { describe, it, expect } from "@jest/globals";
import {
  boardEvents,
  createTextModeSession,
  diffBubbles,
  EMPTY_BUBBLES,
  renderComment,
  renderEcho,
  renderEvents,
  renderFrame,
  textBoardOptions,
  type TextEvent,
  type TextSessionDeps,
  type TextViewProbe,
} from "@shared/world-engine/interaction/text/index.js";
import type { QuestPresenter } from "@shared/world-engine/interaction/quest/quest-host.js";
import {
  BOARD_BACK_ID,
  BOARD_MORE_ID,
  boardChrome,
} from "@shared/world-engine/interaction/quest/board-chrome.js";
import {
  addLocalAvatar,
  createWorldState,
  expandWorldBuildings,
  setAvatarSpeech,
  showWorldBubble,
  type WorldState,
} from "@shared/world-engine/engine.js";
import type { QuestBoardOption, QuestBoardView } from "@shared/world-engine/interaction/quest/quest-host.js";
import type { BuildingSpec, WorldSpec } from "@shared/world-engine/types.js";

const SPEC: WorldSpec = {
  engine: "world",
  engineVersion: 1,
  meta: { title: "t", locale: "en", theme: "t" },
  manifold: { kind: "flat", width: 60, height: 60 },
  terrain: { kind: "flat" },
  spawns: [{ id: "s", x: 10, y: 10, facing: 0 }],
  objects: [],
  multiplayer: { maxPlayers: 4, authority: "distributed" },
  content: { kind: "sandbox" },
};

function world(): WorldState {
  const s = createWorldState(SPEC, "me");
  addLocalAvatar(s, "npc_mara", 12, 10, 0);
  addLocalAvatar(s, "npc_bram", 13, 10, 0);
  return s;
}

describe("text render — the §2 line grammar", () => {
  it("pads the tag to 6 and puts the payload at column 7", () => {
    const lines = renderEvents([
      { tag: "SAY", who: "you", text: "I don't have one." },
      { tag: "SILENT", who: "mara" },
      { tag: "TICK", reason: "quiet", seconds: 1.4 },
    ]);
    expect(lines).toEqual([
      `SAY    you: "I don't have one."`,
      "SILENT mara: …",
      "TICK   quiet after 1.4s.",
    ]);
    for (const line of lines) expect(line[6]).toBe(" ");
  });

  it("starts continuation lines with exactly two spaces and never emits a blank line", () => {
    const lines = renderEvents([
      { tag: "SELF", where: "you are outdoors.", facts: ["holding nothing.", "looking at mara."] },
    ]);
    expect(lines).toEqual([
      "SELF   you are outdoors.",
      "  holding nothing.",
      "  looking at mara.",
    ]);
    expect(lines.some((l) => !l.trim())).toBe(false);
  });

  it("echoes and comments use their own column-0 markers", () => {
    expect(renderEcho("press 3")).toBe("> press 3");
    expect(renderComment("seed=7")).toBe("# seed=7");
  });

  it("renders the design's worked conversation excerpt", () => {
    const out = renderFrame(
      [
        { tag: "SAY", who: "you", text: "I don't have one.", glyph: "have.not + apple" },
        { tag: "SILENT", who: "Mara" },
        { tag: "TURN", who: "Bram", away: true },
        { tag: "TICK", reason: "quiet", seconds: 1.4 },
      ],
      "press 3",
    );
    expect(out.split("\n")).toEqual([
      "> press 3",
      `SAY    you: "I don't have one."  [have.not + apple]`,
      "SILENT Mara: …",
      "TURN   Bram turned away from you.",
      "TICK   quiet after 1.4s.",
    ]);
  });
});

describe("text render — SCENE rows (law ⑤ phrasing)", () => {
  it("a bucket of ONE reads as a thing in a room, not an inventory row", () => {
    const lines = renderEvents([
      {
        tag: "SCENE",
        place: "outdoors",
        count: 1,
        places: 0,
        entries: [
          { kind: "group", count: 1, word: "chair", article: "a", band: "here", cardinal: "east" },
        ],
      },
    ]);
    expect(lines[1]).toBe("  a chair, here east.");
    expect(lines[1]).not.toContain("1 chair");
  });

  it("a bucket with no article in its ruleset reads bare (Hebrew has none)", () => {
    const lines = renderEvents([
      {
        tag: "SCENE",
        place: "outdoors",
        count: 1,
        places: 0,
        entries: [{ kind: "group", count: 1, word: "כיסא", band: "here", cardinal: "east" }],
      },
    ]);
    expect(lines[1]).toBe("  כיסא, here east.");
  });

  it("counts things and places separately — the header never claims the flood", () => {
    const lines = renderEvents([
      {
        tag: "SCENE",
        place: "outdoors",
        count: 13,
        places: 82,
        entries: [
          { kind: "place-group", count: 81, word: "houses", band: "there", cardinal: "north",
            collapsed: true, detail: ["all shut"] },
          { kind: "place", textId: "house-1", word: "house", band: "here", cardinal: "north",
            detail: ["blue", "door open", "you can see inside"] },
        ],
      },
    ]);
    expect(lines).toEqual([
      "SCENE  outdoors — 13 thing(s) in view, 82 place(s) around you.",
      "  81 more houses, ring the town, all shut.",
      "  house-1 (house), here north, blue, door open, you can see inside.",
    ]);
  });

  it("an ordinary place bucket keeps its direction", () => {
    const lines = renderEvents([
      {
        tag: "SCENE",
        place: "outdoors",
        count: 0,
        places: 12,
        entries: [
          { kind: "place-group", count: 12, word: "houses", band: "there", cardinal: "north",
            detail: ["all shut"] },
        ],
      },
    ]);
    expect(lines).toEqual([
      "SCENE  outdoors — nothing in view, 12 place(s) around you.",
      "  12 houses, there north, all shut.",
    ]);
  });
});

describe("text render — determinism", () => {
  it("renders the same events byte-identically twice (transcripts are diffable)", () => {
    const events: TextEvent[] = [
      { tag: "SCENE", place: "outdoors", count: 2, places: 0, entries: [
        { kind: "subject", textId: "mara", word: "person", band: "here", cardinal: "east", activity: "eat apple" },
        { kind: "group", count: 3, word: "person", band: "there", cardinal: "north" },
      ] },
      { tag: "BOARD", nodeId: "n1", board: "acts", posedBy: "mara", promptText: "What do you want?", prompt: "want.q", options: [
        { n: 1, id: "apple", label: "apple", glyph: "apple" },
      ] },
      { tag: "TICK", reason: "capped", seconds: 8 },
    ];
    const a = renderEvents(events);
    const b = renderEvents(events);
    expect(a).toEqual(b);
    expect(a.join("\n")).toBe(b.join("\n"));
  });

  it("TICK always carries one decimal, in every reason", () => {
    expect(renderEvents([{ tag: "TICK", reason: "waited", seconds: 5 }])).toEqual(["TICK   waited 5.0s."]);
    expect(renderEvents([{ tag: "TICK", reason: "capped", seconds: 8 }])).toEqual([
      "TICK   still busy after 8.0s.",
    ]);
  });
});

describe("text board — law ④, exactly the page the presenter was handed", () => {
  const options: QuestBoardOption[] = Array.from({ length: 10 }, (_, i) => ({
    id: `opt${i + 1}`,
    label: `word ${i + 1}`,
    glyph: `w${i + 1}`,
  }));

  function view(page: number): QuestBoardView {
    const chrome = boardChrome({ options, page, back: true, moreText: "more", backText: "back" });
    return {
      kind: "choice",
      nodeId: "n1",
      posedByEntityId: "mara",
      prompt: "want.q",
      promptText: "What do you want?",
      options: chrome.options,
    };
  }

  it("numbers the chrome IN — a 'more' is press 9, not invisible", () => {
    const printed = textBoardOptions(view(0).options);
    expect(printed).toHaveLength(10); // 8 content + more + back
    expect(printed[7]).toMatchObject({ n: 8, id: "opt8" });
    expect(printed[8]).toMatchObject({ n: 9, id: BOARD_MORE_ID, chrome: "more" });
    expect(printed[9]).toMatchObject({ n: 10, id: BOARD_BACK_ID, chrome: "back" });
  });

  it("prints the block plus the cost NOTE, and quotes spokenText only when it differs", () => {
    const v: QuestBoardView = {
      kind: "acts",
      nodeId: "n2",
      posedByEntityId: "mara",
      prompt: "want.q",
      promptText: "What do you want?",
      options: [
        { id: "apple", label: "apple", glyph: "apple", spokenText: "apple" },
        { id: "give", label: "give", glyph: "give + apple", spokenText: "I want an apple." },
      ],
    };
    const lines = renderEvents(boardEvents(v));
    expect(lines).toEqual([
      "BOARD  mara: What do you want?  [want.q]",
      "  1. apple  [apple]",
      `  2. give  [give + apple]  "I want an apple."`,
      "NOTE   2 choice(s), the whole list.",
    ]);
  });

  it("the NOTE reports the paging chrome the page carries", () => {
    const lines = renderEvents(boardEvents(view(0)));
    expect(lines[lines.length - 1]).toBe("NOTE   8 choice(s) on this page, plus more + back.");
  });
});

describe("text speech — laws ② and ③", () => {
  it("copies the line byte-for-byte and reports a thought bubble as SILENT", () => {
    const s = world();
    const inView = new Set(["me", "npc_mara", "npc_bram"]);
    const textIdOf = (id: string): string | undefined =>
      id === "npc_mara" ? "mara" : id === "npc_bram" ? "bram" : undefined;

    // A creature line lands on the bubble channel exactly as the host wrote it —
    // including the garble a defect would produce.
    setAvatarSpeech(s, "npc_mara", { text: "i wants  the APPLE", glyph: "i_me + want + apple" });
    // …and a visible silence: "…" over a creature that answered nothing.
    showWorldBubble(s, "char:bram", {
      anchor: { kind: "avatar", id: "npc_bram" },
      text: "…",
      ttl: 2,
      style: "thought",
    });

    const first = diffBubbles(EMPTY_BUBBLES, s, { inView, textIdOf });
    expect(first.events).toEqual([
      { tag: "SILENT", who: "bram", text: "…" },
      { tag: "SAY", who: "mara", text: "i wants  the APPLE", glyph: "i_me + want + apple" },
    ]);
    expect(renderEvents(first.events)).toEqual([
      "SILENT bram: …",
      `SAY    mara: "i wants  the APPLE"  [i_me + want + apple]`,
    ]);

    // An UNCHANGED bubble is not a new utterance — the same line must not
    // re-narrate every frame.
    expect(diffBubbles(first.next, s, { inView, textIdOf }).events).toEqual([]);

    // A REPLACEMENT under the same key IS a new line (the host re-uses the key).
    s.time = 9;
    setAvatarSpeech(s, "npc_mara", { text: "here", glyph: "here" });
    const second = diffBubbles(first.next, s, { inView, textIdOf });
    expect(second.events).toEqual([{ tag: "SAY", who: "mara", text: "here", glyph: "here" }]);
  });

  it("a line from a body the §3 filter excludes is NOT narrated (the recorded GL divergence)", () => {
    const s = world();
    setAvatarSpeech(s, "npc_mara", { text: "psst", glyph: "hello" });
    const out = diffBubbles(EMPTY_BUBBLES, s, {
      inView: new Set(["me"]), // mara is sealed away / out of range
      textIdOf: () => undefined,
    });
    expect(out.events).toEqual([]);
    // …but the snapshot still advanced, so she isn't re-narrated on re-entry.
    expect(out.next.get("speech:npc_mara")?.text).toBe("psst");
  });

  it("attributes a POINT-anchored line to the body standing under it", () => {
    const s = world();
    // `sayNpcLine` hangs most creature lines at the poser POINT, not the avatar.
    showWorldBubble(s, "char:someEntity", {
      anchor: { kind: "point", x: 12, y: 10 },
      text: "hello",
      glyph: "hello",
    });
    const out = diffBubbles(EMPTY_BUBBLES, s, {
      inView: new Set(["npc_mara"]),
      textIdOf: (id) => (id === "npc_mara" ? "mara" : undefined),
    });
    expect(out.events).toEqual([{ tag: "SAY", who: "mara", text: "hello", glyph: "hello" }]);
  });

  it("drops a line it cannot attribute rather than guessing a speaker", () => {
    const s = world();
    showWorldBubble(s, "demo:caption", { anchor: { kind: "point", x: 50, y: 50 }, text: "a caption" });
    expect(diffBubbles(EMPTY_BUBBLES, s, { inView: new Set(), textIdOf: () => undefined }).events).toEqual([]);
    // …unless the driver asks for unattributed captions explicitly.
    const kept = diffBubbles(EMPTY_BUBBLES, s, {
      inView: new Set(),
      textIdOf: () => undefined,
      includeUnattributed: true,
    });
    expect(kept.events).toEqual([{ tag: "SAY", who: null, text: "a caption" }]);
    expect(renderEvents(kept.events)).toEqual([`SAY    "a caption"`]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The session — the seam shared/world-engine/headless/ boots against.
//
// A fake view + a fake host (exactly the structural shapes `TextSessionDeps`
// declares) drive the whole projection: presenter tap → settle → one TICK. Law
// ⑥ is what these assert — an act reaches the world ONLY through `speak` /
// `select`, and the narration comes back off the state a renderer sees.
// ───────────────────────────────────────────────────────────────────────────

interface Rig {
  session: ReturnType<typeof createTextModeSession>;
  state: WorldState;
  spoke: string[];
  selected: string[];
  tap: Partial<QuestPresenter>;
  frames: () => number;
}

function rig(
  opts: { onFrame?: (state: WorldState, frame: number) => void; state?: WorldState } = {},
): Rig {
  const state = opts.state ?? world();
  if (!opts.state) {
    state.avatars.me!.x = 10;
    state.avatars.me!.y = 10;
  }
  const spoke: string[] = [];
  const selected: string[] = [];
  let tap: Partial<QuestPresenter> = {};
  let frame = 0;
  const frameDt = 1 / 60;

  const probe = (): TextViewProbe => ({
    state,
    intent: { aim: null, sitting: false, cursor: { point: null, hoverId: "npc_mara" } },
    dt: frameDt,
    worldToScreen: (p) => ({ x: p.x, y: p.y }),
  });

  const deps: TextSessionDeps = {
    host: {
      speak(sentence) {
        spoke.push(sentence);
        // The host's own path writes the player's line to the caption channel.
        setAvatarSpeech(state, "me", { text: sentence, glyph: sentence });
      },
      select(id) {
        selected.push(id);
      },
    },
    view: { probe },
    stepFrame() {
      frame += 1;
      state.time += frameDt;
      opts.onFrame?.(state, frame);
    },
    frameDt,
    addPresenterTap(p) {
      tap = p;
    },
    locale: "en",
    nameOf: (id) => (id === "npc_mara" ? "Mara" : undefined),
  };

  const session = createTextModeSession(deps);
  return { session, state, spoke, selected, tap, frames: () => frame };
}

/** Every successful command closes with EXACTLY ONE TICK (§5). */
function ticks(events: readonly TextEvent[]): TextEvent[] {
  return events.filter((e) => e.tag === "TICK");
}

describe("text session — §5, every command settles and closes with one TICK", () => {
  it("answers a query, then settles quiet", () => {
    const r = rig();
    const out = r.session.command("self");
    expect(out.events[0]!.tag).toBe("SELF");
    expect(ticks(out.events)).toHaveLength(1);
    expect(ticks(out.events)[0]).toMatchObject({ reason: "quiet" });
    expect(out.lines[0]).toBe("SELF   you are outdoors.");
    // §3: `self` reports the renderer's OWN cursor pick as what you look at.
    expect(out.lines).toContain("  looking at mara.");
  });

  it("`wait n` steps exactly n sim-seconds", () => {
    const r = rig();
    r.session.command("wait 2");
    expect(r.frames()).toBe(120);
    const out = r.session.command("wait 1");
    expect(r.frames()).toBe(180);
    expect(ticks(out.events)).toHaveLength(1);
    expect(ticks(out.events)[0]).toMatchObject({ reason: "waited" });
    expect(out.lines[out.lines.length - 1]).toBe("TICK   waited 1.0s.");
  });

  it("a rejected line executes nothing, so it settles nothing and ticks not at all", () => {
    const r = rig();
    const out = r.session.command("frobnicate the cat");
    expect(out.events[0]!.tag).toBe("ERR");
    expect(ticks(out.events)).toHaveLength(0);
    expect(r.frames()).toBe(0);
  });

  it("caps a world that never goes quiet", () => {
    // A bubble rewritten every frame is a world with no quiet moment in it.
    const r = rig({
      onFrame: (state, frame) => setAvatarSpeech(state, "npc_mara", { text: `line ${frame}` }),
    });
    const capped = r.session.command("scene");
    expect(ticks(capped.events)).toHaveLength(1);
    expect(ticks(capped.events)[0]).toMatchObject({ reason: "capped" });
    expect(capped.events.filter((e) => e.tag === "SAY").length).toBeGreaterThan(100);
  });
});

describe("text session — law ⑥, acts reach the world through the host and nothing else", () => {
  it("`say` joins the words with + and hands them to host.speak; the LINE comes back off the bubble", () => {
    const r = rig();
    const out = r.session.command("say i_me want apple");
    expect(r.spoke).toEqual(["i_me + want + apple"]);
    expect(out.events.find((e) => e.tag === "SAY")).toEqual({
      tag: "SAY",
      who: "me",
      text: "i_me + want + apple",
      glyph: "i_me + want + apple",
    });
    expect(ticks(out.events)).toHaveLength(1);
  });

  it("`press` selects the option id on the page AS PRINTED, chrome included", () => {
    const r = rig();
    r.session.command("scene"); // latch the text ids so the poser has a name
    r.tap.board?.({
      kind: "acts",
      nodeId: "n1",
      posedByEntityId: "npc_mara",
      prompt: "want.q",
      promptText: "What do you want?",
      options: [
        { id: "apple", label: "apple", glyph: "apple" },
        { id: BOARD_MORE_ID, label: "more", glyph: "more" },
      ],
    });

    const shown = r.session.command("board");
    expect(shown.lines.slice(0, 3)).toEqual([
      "BOARD  mara: What do you want?  [want.q]",
      "  1. apple  [apple]",
      "  2. more  [more]",
    ]);

    const pressed = r.session.command("press 1");
    expect(r.selected).toEqual(["apple"]);
    expect(pressed.lines[0]).toBe("OK     pressed 1. apple");

    // `more` presses the chrome the page carries — by name, not by counting.
    r.session.command("more");
    expect(r.selected).toEqual(["apple", BOARD_MORE_ID]);

    // …and `back` is refused when the page has no such button.
    const refused = r.session.command("back");
    expect(refused.events[0]).toEqual({ tag: "ERR", text: `this board has no "back" button.` });
    expect(ticks(refused.events)).toHaveLength(0);
  });

  it("presses nothing when no board is open", () => {
    const r = rig();
    expect(r.session.command("press 1").events[0]).toEqual({ tag: "ERR", text: "no board is open." });
    expect(r.selected).toEqual([]);
  });

  it("clearBoard closes the block, and the reprint says there is none", () => {
    const r = rig();
    r.tap.board?.({
      kind: "choice",
      nodeId: "n1",
      posedByEntityId: "npc_mara",
      prompt: "q",
      promptText: "Which?",
      options: [{ id: "a", label: "a" }],
    });
    r.tap.clearBoard?.();
    const out = r.session.command("board");
    expect(out.events[0]).toEqual({ tag: "NOTE", text: "no board is open." });
    expect(out.events.some((e) => e.tag === "CLOSE")).toBe(true);
  });
});

describe("text session — scene and look answer from the probe", () => {
  it("prints the scene with latched text ids", () => {
    const r = rig();
    const out = r.session.command("scene");
    expect(out.events.find((e) => e.tag === "SCENE")).toMatchObject({
      place: "outdoors",
      count: 2,
      places: 0,
    });
    expect(out.lines[0]).toBe("SCENE  outdoors — 2 thing(s) in view.");
    expect(out.lines).toContain("  mara (person), here east.");
  });

  it("never lists YOU as a bystander — neither the spark's body nor the one it drives", () => {
    const r = rig();
    // The spark claims Mara's body: `drivenId` now points at her.
    r.state.drivenId = "npc_mara";
    const out = r.session.command("scene");
    const scene = out.events.find((e) => e.tag === "SCENE");
    expect(scene).toMatchObject({ count: 1 }); // bram only — mara is now you
    expect(out.lines.join("\n")).not.toContain("mara (");
  });

  it("looks at one body, and errs on a name the world does not have", () => {
    const r = rig();
    r.session.command("scene"); // latch the ids
    const out = r.session.command("look mara");
    expect(out.events[0]).toMatchObject({ tag: "LOOK", textId: "mara", word: "Mara" });
    expect(out.lines[0]).toBe("LOOK   mara — Mara.");
    expect(r.session.command("look dragon").events[0]).toEqual({
      tag: "ERR",
      text: `nothing here called "dragon".`,
    });
  });

  it("`look person 1` shorthand and bare `look` both parse (§4)", () => {
    const r = rig();
    r.session.command("scene");
    expect(r.session.command("look person 1").events[0]!.tag).toBe("LOOK");
    expect(r.session.command("look").events[0]!.tag).toBe("SCENE");
  });

  it("help lists the command set and never mentions the cheat channel", () => {
    const r = rig();
    const out = r.session.command("help");
    const text = out.lines.join("\n");
    expect(out.events[0]!.tag).toBe("HELP");
    for (const word of ["look", "scene", "self", "board", "say", "press", "more", "back", "wait"]) {
      expect(text).toContain(word);
    }
    expect(text.toLowerCase()).not.toContain("cheat");
  });

  it("refuses the cheat prefix by default — the channel is opt-in (law ⑦)", () => {
    const r = rig();
    const out = r.session.command("/scope");
    expect(out.events[0]).toEqual({ tag: "ERR", text: "cheat channel disabled (--cheats)." });
    // …and nothing leaked into the transcript's own channel.
    expect(out.cheatLines).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE REGRESSION THIS SECTION EXISTS FOR.
//
// The first integration transcript off the real dollhouse world printed all 82
// town houses as their own SCENE lines — "house-8 (house), there west, orange,
// shut to you." x82 — under a header that claimed "13 in view". Law 5 applies
// to the skyline exactly as it applies to a crowd.
// ───────────────────────────────────────────────────────────────────────────

/** A town of `n` houses ringing an outdoor player, none of them notable. */
function townState(n: number): WorldState {
  const rows = [70, 55, 40, 145, 160, 175];
  const buildings: BuildingSpec[] = [];
  for (let i = 0; i < n; i++) {
    const row = rows[i % rows.length]!;
    const col = Math.floor(i / rows.length);
    buildings.push({
      id: `b${i}`,
      footprint: { x: 10 + col * 12, y: row, w: 8, h: 8 },
      floors: 1,
      wallThickness: 0.4,
      color: i % 3 ? "#EA580C" : "#2563EB",
      doorways: [],
    });
  }
  const spec = expandWorldBuildings({
    ...SPEC,
    manifold: { kind: "flat", width: 400, height: 400 },
    spawns: [{ id: "s", x: 100, y: 100, facing: 0 }],
    buildings,
  });
  const s = createWorldState(spec, "me");
  addLocalAvatar(s, "npc_mara", 102, 100, 0);
  addLocalAvatar(s, "npc_bram", 103, 100, 0);
  return s;
}

describe("text session — a town is a skyline, not a roll-call", () => {
  it("summarizes 82 houses into a handful of lines under an honest header", () => {
    const r = rig({ state: townState(82) });
    const out = r.session.command("scene");
    const scene = out.events.find((e) => e.tag === "SCENE");

    // The header counts THINGS and PLACES separately, and both numbers are true.
    expect(scene).toMatchObject({ place: "outdoors", count: 2, places: 82 });
    expect(out.lines[0]).toBe("SCENE  outdoors — 2 thing(s) in view, 82 place(s) around you.");

    const placeLines = out.lines.filter((l) => l.includes("house"));
    expect(placeLines.length).toBeLessThanOrEqual(8);
    // …and no single house got a line of its own, since none is notable.
    expect(out.lines.join("\n")).not.toMatch(/house-\d+ \(house\)/);
    // Every house is still accounted for in the counts.
    const counted = placeLines
      .map((l) => Number(/ {2}(\d+)/.exec(l)?.[1] ?? 0))
      .reduce((a, b) => a + b, 0);
    expect(counted).toBe(82);
  });

  it("mirrors the CITY HUD in one trailing line, and enumerates no cohort", () => {
    const r = rig();
    // The HUD has not shown: a village under the cap says nothing about itself.
    expect(r.session.command("scene").lines.join("\n")).not.toContain("live in this city");

    r.tap.city?.([
      { district: 0, glyph: "🌾", label: "farm", population: 40, tracked: 4, pooled: 36, wellbeing: 0.6, emoji: "😊", stocks: [] },
      { district: 1, glyph: "🏘️", label: "town", population: 80, tracked: 6, pooled: 74, wellbeing: 0.5, emoji: "😐", stocks: [] },
      { district: "city", glyph: "🏙️", label: "city", population: 120, tracked: 10, pooled: 110, wellbeing: 0.55, emoji: "😐", stocks: [] },
    ]);

    const out = r.session.command("scene");
    // ONE line, right after the block, and nothing else changed: cohorts are
    // statistics, so the header still counts only the bodies actually in view.
    expect(out.events[0]).toMatchObject({ tag: "SCENE", count: 2 });
    expect(out.events[1]).toEqual({
      tag: "NOTE",
      text: "about 120 more people live in this city (2 districts).",
    });
    expect(out.lines.filter((l) => l.includes("live in this city"))).toHaveLength(1);
  });

  it("a house the driver LOOKED at keeps its own line afterwards", () => {
    const r = rig({ state: townState(82) });
    r.session.command("scene"); // latch the ids
    const target = r.session.simIdOf("house-1");
    expect(target).toBeTruthy();

    const before = r.session.command("scene");
    expect(before.lines.join("\n")).not.toContain("house-1 (house)");

    r.session.command("look house 1");
    const after = r.session.command("scene");
    expect(after.lines.join("\n")).toContain("house-1 (house)");
    // …and the skyline shrank by exactly the one that was promoted.
    expect(after.lines.filter((l) => l.includes("house")).length).toBeLessThanOrEqual(8);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// STEP ⑦ — "PREVIOUSLY MET" (law ⑤ rank ②) through the live session.
//
// The session is where acquaintance is RECORDED: the world never gave these
// bodies names, so the only reason to name one in a crowd is that the player
// has already dealt with it.
// ───────────────────────────────────────────────────────────────────────────

/** `n` interchangeable townspeople, all "there east", all dressed alike. */
function crowdState(n: number): WorldState {
  const s = createWorldState(
    { ...SPEC, manifold: { kind: "flat", width: 200, height: 200 } },
    "me",
  );
  s.avatars.me!.x = 10;
  s.avatars.me!.y = 10;
  for (let i = 0; i < n; i++) addLocalAvatar(s, `npc_c${i}`, 25 + i, 10, 0);
  return s;
}

describe("text session — a crowd of strangers becomes people you have MET", () => {
  it("buckets identical strangers, then names the one whose board opened", () => {
    const r = rig({ state: crowdState(5) });
    const before = r.session.command("scene");
    // Five identical bodies, no names, no activities: one crowd line.
    expect(before.lines.join("\n")).not.toMatch(/person-\d+ \(person\)/);
    expect(before.lines.some((l) => l.includes("5 people"))).toBe(true);

    // A BOARD OPENING IS AN INTRODUCTION. `posedByEntityId` is the quest ENTITY
    // id; the body wears the host's `npc_` spelling, and both must resolve.
    r.tap.board?.({
      kind: "acts",
      nodeId: "n1",
      posedByEntityId: "c2",
      prompt: "want.q",
      promptText: "What do you want?",
      options: [{ id: "apple", label: "apple", glyph: "apple" }],
    });

    const after = r.session.command("scene");
    expect(after.lines.join("\n")).toContain("person-3 (person)");
    expect(after.lines.some((l) => l.includes("4 people"))).toBe(true);
  });

  it("hearing somebody speak in front of you is meeting them", () => {
    let due = false;
    const r = rig({
      state: crowdState(5),
      onFrame: (state) => {
        if (!due) return;
        due = false;
        setAvatarSpeech(state, "npc_c4", { text: "good morning" });
      },
    });
    r.session.command("scene");
    due = true;
    const heard = r.session.command("wait 1");
    expect(heard.events.some((e) => e.tag === "SAY")).toBe(true);
    expect(r.session.command("scene").lines.join("\n")).toContain("person-5 (person)");
  });

  it("a line the §3 filter never let you hear is NOT an introduction", () => {
    const state = crowdState(5);
    // Push one body out of range: its line is never narrated, so it stays a
    // stranger — the acquaintance memory can only record what was heard.
    state.avatars.npc_c4!.x = 300;
    let due = false;
    const r = rig({
      state,
      onFrame: (s) => {
        if (!due) return;
        due = false;
        setAvatarSpeech(s, "npc_c4", { text: "psst" });
      },
    });
    r.session.command("scene");
    due = true;
    const out = r.session.command("wait 1");
    expect(out.events.some((e) => e.tag === "SAY")).toBe(false);
    expect(r.session.command("scene").lines.join("\n")).not.toMatch(/person-\d+ \(person\)/);
  });
});
