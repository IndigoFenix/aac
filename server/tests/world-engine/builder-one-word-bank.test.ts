// ⚖️ ONE WORD BANK — the sentence builder's vocabulary does NOT move with the
// session.
//
// THE USER'S LAW (2026-09-06, after the frontier board lost its furniture):
// *"the word bank in the sentence builder should always be the same with a
// default world-spec lexicon, even outside the game — the context is
// irrelevant. The only exception is the individual people list."*
//
// THE BUG IT CAME FROM. `quest-host.ts pushKnownNouns` pushed a scene's
// vocabulary and gated each block on a scope: the furniture block on
// `session.dollhouse !== null`, the catalog/materials block on
// `session.town || session.foundedSite`. A founding settlement is not a
// dollhouse, so the frontier board offered `box` and `bin` — pool members,
// pushed on a different line — and no bed, table, chair or workbench. The ORDER
// path had always accepted all four houseless (`orderCraft`'s
// `COMMUNITY_CRAFT_HI` arm: "making a bed — by hand, no workbench"); only the
// buttons were missing.
//
// NOTHING COULD SEE IT. Text mode and the AAC's builder both call
// `builderSurfaceFor`, which MERGES `defaultBuilderNouns()`, so both were immune
// to whatever the host failed to push; the world-lab / dollhouse / nature-hike
// board mapped the raw push straight into `surfaceNext` and was the only surface
// on it. `scripts/worlds/frontier.spec.json` has `initial_focus: { type:
// "house" }`, so the headless "frontier" boots as a DOLLHOUSE and could not
// reproduce the GL frontier at all. `builder-coverage.ts` exempted host-pushed
// nouns, so `validate-builder-lexicon` was blind. And no test pinned the push.
//
// SO THIS SUITE PINS THE RULE, not the fix: the bank is IDENTICAL across
//   (a) a DOLLHOUSE session      — `scripts/worlds/frontier.spec.json` (focus: house)
//   (b) a FOUNDING session, NO house — `scripts/worlds/frontier-planet.spec.json`
//       (the headless analogue of the GL `frontier-planet` preset: scope town,
//       days 0, population 5, wilderness, no `initial_focus`)
//   (c) NO SESSION AT ALL        — `builderSurfaceFor` with no host nouns
// modulo the INDIVIDUAL PEOPLE, which is the law's one exception.
//
// THIN BY CONSTRUCTION: this file value-imports quest-host (a heavy per-worker
// transform tax, CLAUDE.md), so it boots each world exactly ONCE in `beforeAll`
// and every other assertion is over the pure surfacer.
//
//   npm run test:engine -- one-word-bank

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";
import {
  BUILDER_CATEGORIES,
  builderSurfaceFor,
  defaultBuilderNouns,
  type BuilderNounEntry,
} from "@shared/world-engine/interaction/intent/builder-surface.js";
import { headOf } from "@shared/world-engine/variations.js";

const WORLDS = join(process.cwd(), "scripts", "worlds");
const loadSpec = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(WORLDS, name), "utf8")) as Record<string, unknown>;

/** Boot one world headless and return the host's LAST noun push. 40 frames is
 *  well past the first push (it is diff-gated, so it fires on frame 1). */
function bootAndCapture(spec: string): { run: TextQuestRun; nouns: BuilderNounEntry[] } {
  const run = bootTextQuest({ world: loadSpec(spec), seed: 11, dt: 0.5 });
  let pushed: BuilderNounEntry[] = [];
  run.addPresenterTap({ nouns: (list) => { pushed = list as BuilderNounEntry[]; } });
  run.advance(40);
  return { run, nouns: pushed };
}

/**
 * THE BANK, as heads. The "things" tab is the FULL noun listing (the surfacer's
 * ranking never withholds there), so this is the whole noun vocabulary a child
 * can reach — which is exactly what the law is about.
 */
const bankOf = (nouns?: BuilderNounEntry[]): string[] =>
  builderSurfaceFor("", { category: "things", ...(nouns ? { nouns } : {}) })
    .buttons.map((b) => headOf(b.key))
    .sort();

describe("ONE WORD BANK — the builder's vocabulary is session-blind", () => {
  let doll: { run: TextQuestRun; nouns: BuilderNounEntry[] };
  let founding: { run: TextQuestRun; nouns: BuilderNounEntry[] };

  beforeAll(() => {
    doll = bootAndCapture("frontier.spec.json");
    founding = bootAndCapture("frontier-planet.spec.json");
  });
  afterAll(() => {
    doll?.run.dispose();
    founding?.run.dispose();
  });

  it("boots the two session KINDS the law has to span", () => {
    // The premise of every assertion below: (a) really is a dollhouse and (b)
    // really is a houseless founding town. If a spec ever drifts, this fails
    // first and says so, rather than silently pinning one session twice.
    expect((doll.run.session as { dollhouse: number | null }).dollhouse).not.toBeNull();
    expect((founding.run.session as { dollhouse: number | null }).dollhouse).toBeNull();
    expect(!!(founding.run.session as { town?: unknown }).town).toBe(true);
  });

  it("the host pushes INDIVIDUAL PEOPLE and nothing else", () => {
    // The law's one exception, stated as a type: every entry is a named body,
    // flagged so the builder files it on the [contacts] chip.
    for (const n of [...doll.nouns, ...founding.nouns]) {
      expect(n.kind).toBe("creature");
      expect(n.individual).toBe(true);
    }
    // …and a name is never a word the spec already owns — pushing one would be
    // the host adding vocabulary through the back door.
    const defaults = new Set(defaultBuilderNouns().map((n) => headOf(n.symbol)));
    for (const n of [...doll.nouns, ...founding.nouns]) {
      expect(defaults.has(headOf(n.symbol))).toBe(false);
    }
    // The dollhouse world declares its household by name; the founding party
    // has no family record, so it pushes nothing at all.
    expect(doll.nouns.map((n) => n.symbol).sort()).toEqual(["mara", "orrin"]);
    expect(founding.nouns).toEqual([]);
  });

  it("the bank is IDENTICAL in all three, modulo the people list", () => {
    const noSession = bankOf();
    const withDoll = bankOf(doll.nouns);
    const withFounding = bankOf(founding.nouns);
    const names = doll.nouns.map((n) => headOf(n.symbol));

    // (b) a founding session with no house adds NOTHING and hides NOTHING.
    expect(withFounding).toEqual(noSession);
    // (a) a dollhouse adds exactly its household's names.
    expect(withDoll.filter((h) => !names.includes(h))).toEqual(noSession);
    expect(withDoll.filter((h) => names.includes(h)).sort()).toEqual([...names].sort());
    // The sizes, spelled out so a regression reads as a number rather than a
    // diff: the bank is the spec walk, plus 0 or 2 names.
    expect(noSession.length).toBe(defaultBuilderNouns().length);
    expect(withFounding.length).toBe(noSession.length);
    expect(withDoll.length).toBe(noSession.length + names.length);
  });

  it("the TAB LADDER and the MODIFIER RAIL are session-blind too", () => {
    // The bank is not only the nouns (the law: "the default world-spec lexicon"
    // = `defaultBuilderNouns()` + the category tabs + the modifier rail).
    const tabs = (nouns?: BuilderNounEntry[]) =>
      builderSurfaceFor("", { ...(nouns ? { nouns } : {}) }).categories;
    expect(tabs(doll.nouns)).toEqual([...BUILDER_CATEGORIES]);
    expect(tabs(founding.nouns)).toEqual([...BUILDER_CATEGORIES]);
    expect(tabs()).toEqual([...BUILDER_CATEGORIES]);

    const rail = (nouns?: BuilderNounEntry[]) =>
      (builderSurfaceFor("bed", { ...(nouns ? { nouns } : {}) }).modifiers ?? []).map((m) => m.key);
    expect(rail()).not.toEqual([]);
    expect(rail(doll.nouns)).toEqual(rail());
    expect(rail(founding.nouns)).toEqual(rail());
  });

  it("the user's report: a houseless frontier can make the furniture", () => {
    // *"most furniture is missing from the word list - can't make workbenches,
    // beds, tables, chairs, or anything really except for boxes and bins."*
    //
    // Read the way a child reaches it: after `make`, the ranked grid leads with
    // mobile items and the rest sit one press away on their cluster chip — so
    // the [furniture] chip IS the make list, and `box`/`bin` surviving alone in
    // it was the exact shape of the bug (they are pool members, pushed by a
    // different line than the furniture block the scope gate wrapped).
    const opts = { nouns: founding.nouns, capacity: 64 };
    const chips = (builderSurfaceFor("make", opts).groups ?? []).map((g) => g.id);
    expect(chips).toContain("furniture");
    const furniture = builderSurfaceFor("make", { ...opts, group: "furniture" })
      .buttons.map((b) => headOf(b.key));
    for (const head of ["bed", "table", "chair", "workbench", "box", "bin"]) {
      expect(furniture).toContain(head);
    }
    // And the whole band, unpaged, is the same list a dollhouse gets — the
    // ranking may differ with what the child has said, the VOCABULARY may not.
    const band = (nouns?: BuilderNounEntry[]) =>
      builderSurfaceFor("make", { capacity: 400, ...(nouns ? { nouns } : {}) })
        .buttons.map((b) => headOf(b.key))
        .sort();
    expect(band(founding.nouns)).toEqual(band());
  });

  it("every head the host used to push is still sayable", () => {
    // THE MIGRATION, pinned. Each of these reached a board ONLY through a
    // scope-gated host push before the ruling; each now lives in the default
    // lexicon spec-side (PLACE_STUBS / ITEM_STUBS / CORE_BOARD_NOUNS / the
    // species walk). Losing one would be the ruling costing a child a word.
    const bank = bankOf();
    for (const head of [
      // catalog structures with no `StructureProgramDef` row
      "farm", "market", "storehouse", "building",
      // the frame places and the garment umbrella
      "yard", "town", "clothing",
      // build materials + the wardrobe garment no pool row carries
      "wood", "stone", "block", "dress",
      // the food bodies that are `fruit` species outside every pool
      "carrot", "berry", "nut", "onion",
    ]) {
      expect(bank).toContain(head);
    }
    // The two the host pushed that were ALREADY reachable, and are therefore
    // deliberately NOT in the noun bank: `house` is the dwelling the house
    // program speaks as `home` (one referent, one button — no synonyms), and
    // `area` is a LEXICON word on the Actions tab.
    expect(bank).toContain("home");
    expect(bank).not.toContain("house");
    const actions = builderSurfaceFor("", { category: "verb" }).buttons.map((b) => b.key);
    expect(actions).toContain("area");
  });
});
