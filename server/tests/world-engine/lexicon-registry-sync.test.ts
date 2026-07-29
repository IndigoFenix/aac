// The TWO-VOCABULARY conformance gate (language-expansion.md): the parse
// LEXICON (parse-intent.ts) and the render vocabulary (glyph-registry.ts) are
// separate lists extended in parallel — this test turns silent drift into a
// failure. Every LEXICON symbol must either resolve in the glyph registry or
// sit on the EXPLICIT game-only allowlist below (a symbol with no board art
// yet — the §6.5 worklist). Shrink the list as art ships; never grow it
// without meaning to.

import { describe, it, expect } from "@jest/globals";
import { LEXICON } from "@shared/world-engine/interaction/intent/parse-intent.js";
import { getVocabularyItem } from "@shared/glyph-registry.js";
import { buildConcepts } from "@shared/world-engine/interaction/content/concepts.js";
import { POOLS } from "@shared/world-engine/interaction/content/pools.js";

/** LEXICON symbols knowingly absent from the glyph registry (game-only words
 *  or queued art). Additions here should be deliberate. Snapshot 2026-07-17 —
 *  the §6.5 art worklist; shrink as symbols ship. */
const GAME_ONLY = new Set<string>([
  // people / deixis
  "us",
  // verbs
  // `drop`/`carry` left: they now ship as physical-carry verbs with body art.
  // `come`/`follow` left: bundled body art shipped, and both are directional —
  // the pair with `go` is only distinguishable BY the artwork.
  // `get` left: it ships on `take`'s hand art — one act, two words, and `get`
  // is the one the surfacer actually offers (its family's canonical head).
  "stay", "turn", "bring",
  // `clean` left: it now resolves as the cleanliness STATE adjective.
  // `zone` left: the charter verb is spoken as `area`, which has registry art.
  // `break` left: it shipped with the actions/hands art beside `build`.
  "fix", "dig", "plant", "cut",
  // `heat` left: it now borrows the `hot` descriptor art — the act and the state
  // it produces are deliberately the same picture.
  "cook", "fill", "empty", "show", "teach", "fight", "feel", "rest",
  // connectives
  "then", "so", "therefore", "in_order_to", "until",
  // relations — `behind` left: it shipped with the places/relational art. The
  // board words are `behind`/`in_front_of`; `front` stays the ENGINE name for
  // the relation and `above` a spoken alias of `over` — neither is a button.
  "front", "above",
  // social
  "bye", "okay", "thanks", "mine", "dont_understand",
  // quantity
  "three", "less",
  // attributes (`dirty` left — it now ships as a state adjective)
  "broken", "new", "old", "warm", "full",
]);

describe("LEXICON ↔ glyph-registry conformance", () => {
  it("every parseable symbol has registry artwork or an explicit exemption", () => {
    const missing = Object.keys(LEXICON)
      .filter((k) => !getVocabularyItem(k))
      .filter((k) => !GAME_ONLY.has(k));
    expect(missing).toEqual([]);
  });

  it("the exemption list carries no stale entries (art shipped → remove)", () => {
    const stale = [...GAME_ONLY].filter((k) => getVocabularyItem(k));
    expect(stale).toEqual([]);
  });
});

describe("ConceptDef bridge — the joined noun library", () => {
  it("covers every pool member, one concept per symbol, deterministically", () => {
    const concepts = buildConcepts();
    for (const pool of Object.values(POOLS)) {
      for (const m of pool.members) {
        const c = concepts.get(m.symbol);
        expect(c).toBeDefined();
        expect(c!.pools.some((p) => p.id === pool.id)).toBe(true);
      }
    }
    expect([...buildConcepts().keys()]).toEqual([...concepts.keys()]);
  });

  it("derives affordance verbs from pool/category/species data", () => {
    const concepts = buildConcepts();
    const apple = concepts.get("apple")!;
    expect(apple.category).toBe("food");
    expect(apple.affords).toContain("eat");
    expect(apple.affords).toContain("give");
    const bear = concepts.get("bear")!;
    expect(bear.affords).toContain("talk");
    expect(bear.affords).toContain("hug");
    const shirt = concepts.get("shirt")!;
    expect(shirt.category).toBe("clothing");
    expect(shirt.affords).toContain("wear");
    expect(shirt.affords).toContain("wash");
    // Every concept affords SOMETHING — a noun with no verbs can't surface.
    for (const c of concepts.values()) expect(c.affords.length).toBeGreaterThan(0);
  });

  it("TOYS afford `play` — the selector the fun need binds to", () => {
    // The fun need is affordance-driven (`item: { affords: "play" }`), so a
    // creature can only ever play if real toys report `play` here. Both the
    // loose-prop scan and the take-from-container draw match on this list —
    // if it empties, creatures silently stop being able to play.
    //
    // Asserted over the LIVE pool rather than a hard-coded trio (it used to name
    // teddy/ball/blocks): the pool is down to the ball while the toy system is
    // rebuilt, and the invariant that matters is "whatever is in the pool can be
    // played with, and the pool is never empty" — which survives the membership
    // changing under it.
    const concepts = buildConcepts();
    const toys = POOLS.toy!.members;
    expect(toys.length).toBeGreaterThan(0);
    for (const toy of toys) {
      expect(concepts.get(toy.symbol)?.affords ?? []).toContain("play");
    }
  });

  it("host extensions join without overriding the static core", () => {
    const concepts = buildConcepts([
      { symbol: "wood", label: "wood", pools: [], affords: ["get", "give"] },
      { symbol: "apple", label: "OVERRIDE", pools: [], affords: [] },
    ]);
    expect(concepts.get("wood")?.affords).toEqual(["get", "give"]);
    expect(concepts.get("apple")?.label).toBe("apple"); // core wins
  });
});
