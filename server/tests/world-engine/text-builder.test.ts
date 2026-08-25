// TEXT MODE step ⑧ — BUILDER DRIVING (design §7, law ④).
//
// "A screen is a list, and its COST is part of the output." Two things are under
// test and they are the same thing twice:
//   • every screen comes from `builderSurfaceFor` at the REAL grid budget, so a
//     word that did not rank is reachable only through a tab or a group chip —
//     and that extra tap shows up as an extra screen; and
//   • the press/screen accounting arithmetic is exact, because "reached in N
//     presses across M screens" IS the measurement this harness exists to take.
//
// The goldens run against the REAL surfacer with the REAL default noun library:
// pinning a stub would pin this suite's own opinion instead of the engine's.

import { describe, it, expect } from "@jest/globals";
import {
  createTextBuilder,
  createTextModeSession,
  renderEvents,
  type TextEvent,
  type TextSessionDeps,
  type TextViewProbe,
} from "@shared/world-engine/interaction/text/index.js";
import {
  builderSurfaceFor,
  defaultBuilderNouns,
} from "@shared/world-engine/interaction/intent/builder-surface.js";
import type { BuilderPager } from "@shared/world-engine/interaction/text/builder.js";
import {
  BUILDER_GRID_CELLS,
  BUILDER_ITEMS_WITH_MORE,
  pageBuilderGrid,
} from "@shared/aac-builder-paging.js";
import type { QuestPresenter } from "@shared/world-engine/interaction/quest/quest-host.js";
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
  spawns: [{ id: "s", x: 10, y: 10, facing: 0 }],
  objects: [],
  multiplayer: { maxPlayers: 4, authority: "distributed" },
  content: { kind: "sandbox" },
};

function world(): WorldState {
  const s = createWorldState(SPEC, "me");
  addLocalAvatar(s, "npc_mara", 12, 10, 0);
  return s;
}

const NOUNS = defaultBuilderNouns();

function builder(grid = 8) {
  return createTextBuilder({ locale: "en", grid, nouns: NOUNS });
}

/** The BUILDER block for the current view, as printed. */
function screen(b: ReturnType<typeof builder>): string[] {
  return renderEvents([b.block()]);
}

describe("text builder — the screen is the engine's own surface (law ④)", () => {
  it("prints the ranked grid at the grid budget, with its group chips and tabs", () => {
    const b = builder(8);
    const lines = screen(b);
    expect(lines[0]).toBe("BUILDER so far: (nothing)");
    // EXACTLY the grid budget of words — the ranked view is a BUDGET, and this
    // harness must never widen it to be helpful.
    const words = lines.filter((l) => /^ {2}\d+\. /.test(l));
    expect(words).toHaveLength(8);
    expect(words[0]).toBe("  1. want");
    // The chips carry their exemplar counts (what a tap on one is worth)…
    expect(lines.some((l) => l.startsWith("  groups: "))).toBe(true);
    // …and the tab ladder is printed, because a tab is the other way in.
    expect(lines.some((l) => l === "  tabs: things, person, verb, attribute, quantity, relation, question, connective, social")).toBe(true);
  });

  it("carries the composition, its TRANSLATED preview and the completeness flag", () => {
    const b = builder();
    expect(b.tap("want").ok).toBe(true);
    expect(screen(b)[0]).toBe(`BUILDER so far: want  "I want."`);
    // A bare desire offers categories, not the pantry — the apple lives behind
    // its chip (2026-08-24).
    expect(b.setGroup("food").ok).toBe(true);
    expect(b.tap("apple").ok).toBe(true);
    // The preview is translateGlyph with firstPerson — never a re-composition.
    expect(screen(b)[0]).toBe(`BUILDER so far: want + apple  "I want an apple."  (complete)`);
    expect(b.partial()).toBe("want + apple");
  });

  it("speaks the locale it was given", () => {
    const he = createTextBuilder({ locale: "he", grid: 8, nouns: NOUNS });
    he.tap("want");
    he.setGroup("food");
    he.tap("apple");
    const ev = he.block() as Extract<TextEvent, { tag: "BUILDER" }>;
    expect(ev.partial).toBe("want + apple");
    expect(ev.preview).toBe("אני רוצה תפוח.");
  });

  it("prints [glyph] only where the DRAWN face differs from the pressed key", () => {
    const b = builder();
    b.setTab("things");
    b.setGroup("building");
    const lines = screen(b);
    // A place is ONE word that draws as a composed shell+symbol icon — and a
    // DWELLING is drawn by who lives in it, not by a plate around a house icon.
    expect(lines).toContain("  1. house  [building(family)]");
    // …while a plain lexicon word draws as itself and prints no bracket.
    const b2 = builder();
    expect(screen(b2)).toContain("  1. want");
  });
});

describe("text builder — modifier composition (the SpeakMenu rule)", () => {
  it("numbers modifiers after the words and composes them onto the head with a '.'", () => {
    const b = builder();
    b.tap("want");
    b.setTab("things");
    b.setGroup("clothing"); // `shirt` did not rank into the grid — that IS the cost
    expect(b.tap("shirt").ok).toBe(true);

    const lines = screen(b);
    // The rail is numbered CONTINUOUSLY after the grid, and marked as a rail.
    expect(lines).toContain("  9. dirty  (modifier)");

    const applied = b.tap(".dirty");
    expect(applied).toMatchObject({ ok: true, applied: "dirty", modifier: true });
    expect(b.partial()).toBe("want + shirt.dirty");
    expect(screen(b)[0]).toBe(`BUILDER so far: want + shirt.dirty  "I want a dirty shirt."  (complete)`);
  });

  it("a leading dot NEVER falls through to a grid word of the same name", () => {
    const b = builder();
    b.tap("want");
    // `more` is on the ranked grid AND on nothing's rail here, so the dotted
    // form must refuse rather than quietly pressing the word.
    const r = b.tap(".more");
    expect(r.ok).toBe(false);
    expect(b.partial()).toBe("want");
  });

  it("refuses a modifier with no head to describe", () => {
    const b = builder();
    const r = b.tap(".hot");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("this head has no modifiers");
  });

  it("a number reaches into the rail as well as the grid", () => {
    const b = builder();
    b.tap("want");
    b.setGroup("food");
    b.tap("apple");
    const ev = b.block() as Extract<TextEvent, { tag: "BUILDER" }>;
    const firstMod = ev.options.find((o) => o.modifier);
    expect(firstMod).toBeDefined();
    expect(b.tap(String(firstMod!.n))).toMatchObject({ ok: true, modifier: true });
    expect(b.partial()).toBe(`want + apple.${firstMod!.id}`);
  });
});

describe("text builder — tabs, groups and paging (§7: the tab pages at the grid)", () => {
  it("pages a tab listing at exactly the grid size", () => {
    const b = builder(8);
    expect(b.setTab("things").ok).toBe(true);
    const p1 = b.block() as Extract<TextEvent, { tag: "BUILDER" }>;
    expect(p1.page).toBe(1);
    expect(p1.pages).toBeGreaterThan(1);
    expect(p1.options.filter((o) => !o.modifier)).toHaveLength(8);
    expect(renderEvents([p1]).some((l) => l.startsWith(`  page 1/${p1.pages} — more / back`))).toBe(true);

    expect(b.page("more").ok).toBe(true);
    const p2 = b.block() as Extract<TextEvent, { tag: "BUILDER" }>;
    expect(p2.page).toBe(2);
    // A different page of words — the same list, further in.
    expect(p2.options[0]!.label).not.toBe(p1.options[0]!.label);

    expect(b.page("back").ok).toBe(true);
    expect((b.block() as Extract<TextEvent, { tag: "BUILDER" }>).page).toBe(1);
    expect(b.page("back")).toMatchObject({ ok: false });
  });

  it("a group chip opens a real subset of the active view", () => {
    const b = builder();
    expect(b.setGroup("food").ok).toBe(true);
    const ev = b.block() as Extract<TextEvent, { tag: "BUILDER" }>;
    expect(ev.group).toBe("food");
    // The foods the spec knows — treats and staples together, since the library
    // is derived from the registries now rather than curated.
    expect(ev.options.map((o) => o.id)).toEqual(
      expect.arrayContaining(["apple", "banana", "cookie", "grape", "bread", "cheese"]),
    );
  });

  it("names the tabs and the chips it does have when asked for one it does not", () => {
    const b = builder();
    expect(b.setTab("dragons")).toMatchObject({ ok: false });
    expect(b.setTab("dragons").error).toContain("things");
    expect(b.setGroup("dragons")).toMatchObject({ ok: false });
  });

  it("a word tap resets the view — a new head re-ranks everything", () => {
    const b = builder();
    b.setTab("things");
    b.setGroup("clothing");
    b.tap("shirt");
    const ev = b.block() as Extract<TextEvent, { tag: "BUILDER" }>;
    expect(ev.tab).toBeUndefined();
    expect(ev.page).toBe(1);
  });

  it("undo drops the whole last token, and clear empties the composition", () => {
    const b = builder();
    b.tap("want");
    b.setTab("things");
    b.setGroup("clothing");
    b.tap("shirt");
    b.tap(".dirty");
    expect(b.partial()).toBe("want + shirt.dirty");
    expect(b.undo()).toMatchObject({ ok: true, applied: "shirt.dirty" });
    expect(b.partial()).toBe("want");
    b.clear();
    expect(b.empty()).toBe(true);
    expect(b.undo()).toMatchObject({ ok: false });
    expect(b.play()).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The session — where the ACCOUNTING lives (law ④'s metric).
// ───────────────────────────────────────────────────────────────────────────

interface Rig {
  session: ReturnType<typeof createTextModeSession>;
  spoke: string[];
  tap: Partial<QuestPresenter>;
}

function rig(): Rig {
  const state = world();
  const spoke: string[] = [];
  let tap: Partial<QuestPresenter> = {};
  const frameDt = 1 / 60;
  const probe = (): TextViewProbe => ({
    state,
    intent: { aim: null, sitting: false },
    dt: frameDt,
    worldToScreen: (p) => ({ x: p.x, y: p.y }),
  });
  const deps: TextSessionDeps = {
    host: {
      speak: (s) => spoke.push(s),
      select: () => {},
    },
    view: { probe },
    stepFrame() {
      state.time += frameDt;
    },
    frameDt,
    addPresenterTap(p) {
      tap = p;
    },
    locale: "en",
    grid: 8,
    nouns: NOUNS,
  };
  return { session: createTextModeSession(deps), spoke, tap };
}

describe("text session — press/screen accounting (law ④'s metric)", () => {
  it("counts every tap and every screen from the composition's start", () => {
    const r = rig();
    expect(r.session.sessionStats()).toEqual({ commands: 0, presses: 0, screens: 0 });

    r.session.command("builder"); //          screen 1, press 0 (a reprint is not a tap)
    expect(r.session.sessionStats()).toEqual({ commands: 1, presses: 0, screens: 1 });

    r.session.command("build want"); //       press 1, screen 2
    r.session.command("build tab things"); // press 2, screen 3
    r.session.command("build group clothing"); // press 3, screen 4  (the chip narrows)
    r.session.command("build shirt"); //      press 4, screen 5
    expect(r.session.sessionStats()).toEqual({ commands: 5, presses: 4, screens: 5 });

    const played = r.session.command("build play"); // press 5
    expect(r.spoke).toEqual(["want + shirt"]);
    expect(played.lines).toContain("OK     said: want + shirt");
    // THE MEASUREMENT: five taps, five screens, for one two-word sentence.
    expect(played.lines).toContain("NOTE   reached in 5 presses across 5 screens.");
    expect(r.session.sessionStats()).toEqual({ commands: 6, presses: 5, screens: 5 });
  });

  it("restarts the count at the next composition — each utterance is measured alone", () => {
    const r = rig();
    r.session.command("build want");
    r.session.command("build group food");
    r.session.command("build apple");
    const first = r.session.command("build play");
    // Four presses now: the desire board offers categories, so the apple costs
    // its chip (2026-08-24) — which is exactly the kind of cost this metric is
    // here to make visible.
    expect(first.lines).toContain("NOTE   reached in 4 presses across 3 screens.");

    r.session.command("build want");
    const second = r.session.command("build play");
    expect(second.lines).toContain("NOTE   reached in 2 presses across 1 screens.");
  });

  it("`build play` on nothing is an error, never a silent empty utterance", () => {
    const r = rig();
    const out = r.session.command("build play");
    expect(out.events[0]).toMatchObject({ tag: "ERR" });
    expect(r.spoke).toEqual([]);
  });

  it("a board press counts as a press too — the cost is the same cost", () => {
    const r = rig();
    r.tap.board?.({
      kind: "acts",
      nodeId: "n1",
      posedByEntityId: "npc_mara",
      prompt: "q",
      promptText: "What do you want?",
      options: [{ id: "apple", label: "apple", glyph: "apple" }],
    });
    r.session.command("board");
    r.session.command("press 1");
    const s = r.session.sessionStats();
    expect(s.presses).toBe(1);
    // The push itself printed one screen, and the reprint another.
    expect(s.screens).toBe(2);
  });

  it("a real board takes the paging back from the builder", () => {
    const r = rig();
    r.session.command("build tab things"); // the builder is the open surface
    r.tap.board?.({
      kind: "choice",
      nodeId: "n1",
      posedByEntityId: "npc_mara",
      prompt: "q",
      promptText: "Which?",
      options: [{ id: "a", label: "a" }],
    });
    r.session.command("board"); // drains the push, which closed the builder
    const out = r.session.command("more");
    expect(out.events[0]).toEqual({ tag: "ERR", text: `this board has no "more" button.` });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE MODIFIER RAIL IS AXIS-EXCLUSIVE
//
// A thing cannot be hot AND cold, or one AND three. The rail already hides a
// word once it is applied, so only the SAME-AXIS case ever got through — and it
// did: `apple.hot.cold` composed happily and the lang layer read it out as "a
// hot cold apple", a sentence the student never meant and could not undo in one
// press. The same hole exists on the AAC's own rail (`handleModifierPress` uses
// a plain `addModifier`; only the colour/emotion/gauge pickers go through
// `applyExclusiveModifier`) — same builder, same bug.
// ───────────────────────────────────────────────────────────────────────────
describe("the modifier rail keeps a descriptor axis exclusive", () => {
  /** Compose a head that takes a descriptor rail.
   *
   *  The [food] chip is part of the path now (2026-08-24): a bare desire offers
   *  the CATEGORIES and the child's own habits, never the whole pantry, so the
   *  apple is one chip press in. That extra press is the design, and text mode
   *  showing it is text mode doing its job. */
  function withHead() {
    const b = builder();
    for (const w of ["i_me", "want"]) b.tap(w);
    b.setGroup("food");
    b.tap("apple");
    return b;
  }

  it("REPLACES the applied member of the same axis rather than stacking", () => {
    const b = withHead();
    expect(b.tap(".hot").ok).toBe(true);
    expect(b.partial()).toBe("i_me + want + apple.hot");
    expect(b.tap(".cold").ok).toBe(true);
    expect(b.partial()).toBe("i_me + want + apple.cold");
  });

  it("does the same for counts — one then three is three, not both", () => {
    const b = withHead();
    b.tap(".one");
    b.tap(".three");
    expect(b.partial()).toBe("i_me + want + apple.three");
  });

  it("keeps modifiers from DIFFERENT axes side by side", () => {
    const b = withHead();
    b.tap(".hot");
    b.tap(".three"); // quantity, not temperature
    const [, , head] = b.partial().split(" + ");
    expect(head.split(".").slice(1).sort()).toEqual(["hot", "three"]);
  });

  it("offers the replaced word again — the axis is a choice, not a one-shot", () => {
    const b = withHead();
    b.tap(".hot");
    b.tap(".cold");
    const rail = (b.block() as { options: { id: string; modifier?: boolean }[] }).options
      .filter((o) => o.modifier)
      .map((o) => o.id);
    expect(rail).toContain("hot");
    expect(rail).not.toContain("cold"); // the applied one stays hidden
  });

  it("tags each rail word with its axis, so a client can do the same", () => {
    const s = builderSurfaceFor("i_me + want + apple", { nouns: NOUNS });
    const hot = s.modifiers?.find((m) => m.key === "hot");
    const three = s.modifiers?.find((m) => m.key === "three");
    expect(hot?.axis).toBe("temperature");
    expect(three?.axis).toBe("quantity");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AN INJECTED PAGER — so a driver can page the way a REAL board pages
// ───────────────────────────────────────────────────────────────────────────
describe("the pager is injectable", () => {
  /** The AAC's own rule: 18 cells, 17 when More takes one, wrapping forever. */
  const aacPager: BuilderPager = (words, page) => {
    const p = pageBuilderGrid(words, page);
    return { items: p.items, pages: null, page };
  };

  it("defaults to the clean slice, unchanged", () => {
    const b = builder(8);
    const blk = b.block() as { pages?: number; page: number };
    expect(blk.page).toBe(1);
    expect(typeof blk.pages).toBe("number");
  });

  it("drives the REAL surfacer at the AAC's grid and paging", () => {
    const b = createTextBuilder({ locale: "en", grid: 54, nouns: NOUNS, pager: aacPager });
    const blk = b.block() as { options: unknown[]; pages?: number };
    // Words only (the empty board has no modifier rail), capped at the AAC's
    // grid — 18 when they exactly fit it, 17 once a More button takes a cell.
    expect(blk.options.length).toBeLessThanOrEqual(BUILDER_GRID_CELLS);
    expect(blk.options.length).toBeGreaterThanOrEqual(BUILDER_ITEMS_WITH_MORE);
    // A cycling pager has no total to report, so the field is omitted entirely
    // rather than inventing one.
    expect(blk.pages).toBeUndefined();
  });

  it("never refuses More when the pager cycles — the control cannot go dead", () => {
    const b = createTextBuilder({ locale: "en", grid: 54, nouns: NOUNS, pager: aacPager });
    for (let i = 0; i < 12; i++) {
      expect(b.page("more").ok).toBe(true);
    }
  });

  it("still refuses More at the end under the default slice pager", () => {
    const b = builder(54); // one screen holds everything the surfacer ranked
    expect(b.page("more")).toEqual({ ok: false, error: "this is the last page of the list." });
  });
});
