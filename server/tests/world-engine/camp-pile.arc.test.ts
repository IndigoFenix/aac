/**
 * 🪨 THE CAMP LARDER IS A PILE — the LIVE half, one boot of the frontier planet
 * (planning-docs/games/world-engine/piles-not-boxes-round.md).
 *
 * ⚖️ THE USER'S LAW (2026-09-10): *"items should be stored in piles that are
 * generated spontaneously when needed - boxes help with organization and fulfill
 * a need for tidiness but they shouldn't be required for the behavior of
 * collection."* And the GL complaint it answers: *"there doesn't seem to be any
 * behavior for collecting food and bringing it back."*
 *
 * Five things are pinned, and TWO of them are regression pins for ENGINE HOLES
 * this round exposed rather than created — each one measured, each one the kind
 * that would silently come back:
 *
 *  ① THE PILE IS MINTED ON TOUCH, and it is an ORDINARY CONTAINER: a world
 *    object with no fixture, registered `"in"` / `owner: null`, its stack
 *    ALIASED to `deltas.groundPiles` so a reload re-registers the same units.
 *  ② FOOD COMES HOME. The pile actually gains units — the behaviour the user
 *    said was missing.
 *  ③ 🚨 A SETTLER THAT EATS IS FED. The `eat` executor looked its need row up in
 *    `session.needMeters` ALONE — the RESIDENT accumulator — so a settler, whose
 *    rows live in `session.bodyNeeds` by the body-needs round's storage split,
 *    ate and was never credited. Measured before the fix: one body compiled the
 *    same eat-from-the-pile plan 182 times in three days, ate every time, and
 *    its hunger rose the whole while (rations/day 4.54 → 0.48, starvation
 *    body-days ≥1.5 14.6 → 43.7 — the camp starved beside a full larder).
 *  ④ 🚨 ITEM CONSERVATION ACROSS THAT SAME DOOR. A `stock:<box>|<glyph>` ref
 *    mirrors a real prop only on an `"on"` surface; drawn from an `"in"`
 *    container the arm had no prop to remove and simply skipped the draw-down,
 *    so the eater was fed from a stack that never emptied. Food out of nothing.
 *  ⑤ NOTHING ACCEPTS FOOD AT A CAMP ⇒ NO COLLECT TASK. The frontier before the
 *    house is the user's law working, not a case handled: the pile stands.
 *
 * DB-free / GL-free — `npm run test:engine:arcs -- camp-pile`.
 */
import { describe, it, expect, beforeAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";
import { GROUND_PILE_PREFIX, groundPileId } from "@shared/world-engine/kernel/town/ground-piles.js";

const doc = JSON.parse(
  readFileSync(join(process.cwd(), "scripts", "worlds", "frontier-planet.spec.json"), "utf8"),
) as Record<string, unknown>;

const PILE = groundPileId("food");

describe("THE CAMP LARDER IS A PILE — one frontier-planet boot", () => {
  let run: TextQuestRun;
  const sess = () =>
    run.session as unknown as {
      townClock: number;
      bodyNeeds: Map<string, Map<string, { level: number; at: number }>>;
      needMeters: Map<string, number>;
      containerRecords: Map<
        string,
        { relation?: string; owner?: string | null; stock?: Record<string, number> }
      >;
      town?: { deltas: { groundPiles: Map<string, Record<string, number>> } } | null;
      foundedSite?: { deltas: { groundPiles: Map<string, Record<string, number>> } } | null;
    };

  /** Units in the camp's food pile right now. */
  const pileUnits = (): number => {
    const stock = sess().containerRecords.get(PILE)?.stock ?? {};
    let n = 0;
    for (const q of Object.values(stock)) n += Math.max(0, q);
    return n;
  };
  /** The highest the pile ever stood, and the highest it ever fell FROM. */
  let peak = 0;
  let everFell = false;
  /** Hunger, per settler, sampled at the window's start and end. */
  const hungerStart: Record<string, number> = {};
  const hungerEnd: Record<string, number> = {};
  /** Was the pile ever debited in the same frame a body's hunger was credited? */
  let mintedAtS = -1;
  /** 🎨 THE VISIBLE HEAP (main's ruling 2026-09-10) — was a world OBJECT ever
   *  standing for the pile, and was the object ever ABSENT while the stack was
   *  empty? The pair is the whole lifecycle claim. */
  let sawObjectWhileStocked = false;
  let sawObjectWhileEmpty = false;
  let objectFace = "";

  beforeAll(() => {
    run = bootTextQuest({ world: doc, seed: 11, dt: 0.5 });
    run.advance(20); // 10 s — the first decide, which is what mints the pile
    const s = sess();
    for (const [cid, rows] of s.bodyNeeds) hungerStart[cid] = rows.get("hunger:food")!.level;

    // ── THE WINDOW ───────────────────────────────────────────────────────────
    // 1 800 s at dt 0.5 — hunger fills in 240 s at this scale, so every body
    // crosses several times and the provision row has room to run a few trips.
    // Watched FRAME BY FRAME because the pile's peak and its fall are the whole
    // measurement and a final-frame read would miss both.
    let prev = pileUnits();
    for (let i = 0; i < 3600; i++) {
      run.stepFrame();
      const now = pileUnits();
      if (mintedAtS < 0 && sess().containerRecords.has(PILE)) mintedAtS = sess().townClock;
      // 🚨 THE AUTHORED FACE LIVES ON THE SPEC, not on the live object row
      // (`addWorldObject`: the spec keeps the authored fields, `state.objects`
      // keeps the dynamic ones) — which is where `renderYardCrate`'s own glyph
      // lives too.
      const obj = run.state.objects[PILE];
      if (obj && now > 0) {
        sawObjectWhileStocked = true;
        objectFace = run.state.spec.objects.find((o) => o.id === PILE)?.glyph ?? "";
      }
      if (obj && now === 0) sawObjectWhileEmpty = true;
      if (now > peak) peak = now;
      if (now < prev) everFell = true;
      prev = now;
    }
    for (const [cid, rows] of sess().bodyNeeds) hungerEnd[cid] = rows.get("hunger:food")!.level;
  });

  it("① MINTS THE PILE ON TOUCH, as an ordinary container aliased to the deltas", () => {
    const s = sess();
    const rec = s.containerRecords.get(PILE);
    expect(rec).toBeDefined();
    expect(PILE.startsWith(GROUND_PILE_PREFIX)).toBe(true);
    expect(mintedAtS).toBeGreaterThanOrEqual(0);
    // 🚨 `"in"`, NOT `"on"` — the yard crate's own registration. `"on"` mints a
    // visible mirror prop per unit, and those props are food items standing a
    // metre from a hungry body, which hunger's `consume` goal then resolves and
    // can never pick up (they are `containedIn` the pile). That is the loop
    // that starved the camp; this line is what stops it coming back.
    expect(rec!.relation).toBe("in");
    // COMMUNAL: a camp's larder belongs to nobody, so nobody is refused it.
    expect(rec!.owner ?? null).toBeNull();
    // ONE LEDGER: the container's stack IS the deltas' map, never a copy — a
    // reload re-registers the same units instead of opening a second book.
    const book = s.town?.deltas ?? s.foundedSite?.deltas;
    expect(book).toBeDefined();
    expect(book!.groundPiles.get("food")).toBe(rec!.stock);
  });

  it("①b THE HEAP IS VISIBLE WHILE IT IS STOCKED, AND GONE AT ZERO", () => {
    // MAIN'S RULING (2026-09-10): *"the pile must be visible in GL — the user
    // plays the frontier in the GL and asked to SEE food collected and brought
    // back."* One object, borrowing the crate's `chest` mesh at a smaller
    // radius (there is no heap archetype and inventing one would be a new object
    // family for one consumer), walk-through, wearing the pile's own HEAD glyph
    // as its face — place art is ONE symbol and nothing here names a good.
    expect(sawObjectWhileStocked).toBe(true);
    // 🚨 …AND THE FACE IS DATA, NOT A KIND ID. The heap wears the head it is a
    // heap of, so a timber pile would wear timber with no change here.
    expect(objectFace).toBe("food");
    const spec = run.state.spec.objects.find((o) => o.id === PILE);
    if (spec) {
      expect(spec.solid).toBe(false); // a heap is walked over, never bumped into
      expect(spec.radius).toBeLessThan(0.7); // smaller than the yard crate it borrows from
      expect(spec.fixture).toBe("chest"); // the crate's mesh, borrowed — no new archetype
    }
    // 🚨 NEVER A HEAP OF NOTHING. The mint moved OFF ctx resolution precisely so
    // that "empty" is terminal: a resolving row that minted would leave an empty
    // heap standing wherever a body merely WONDERED where the food goes, and the
    // zero-sweep could never win against it.
    expect(sawObjectWhileEmpty).toBe(false);
  });

  it("② FOOD COMES HOME — the behaviour the user said was missing", () => {
    // The GL complaint verbatim: "there doesn't seem to be any behavior for
    // collecting food and bringing it back."
    expect(peak).toBeGreaterThan(0);
  });

  it("③ A SETTLER THAT EATS IS FED — the `eat` executor reaches the BODY store", () => {
    const cids = Object.keys(hungerEnd);
    expect(cids.length).toBeGreaterThanOrEqual(3);
    // 🚨 THE REGRESSION PIN. Before the fix every body's hunger rose without
    // bound over this window while it ate from the pile every tick. Hunger is
    // in THRESHOLD units (1 = firing); a fed camp hovers around 1, a camp whose
    // credit door is broken climbs past 5 in 1 800 s at this scale.
    for (const cid of cids) {
      expect(hungerEnd[cid]!).toBeLessThan(5);
    }
    // …and the settler's rows must still live in `bodyNeeds` ALONE (the
    // body-needs storage split): the fix reads the second store, it must not
    // start writing the first.
    for (const cid of cids) {
      expect(sess().needMeters.has(`${cid}|hunger:food`)).toBe(false);
    }
  });

  it("④ EATING FROM THE PILE DEBITS IT — item conservation across the stock ref", () => {
    // 🚨 THE SECOND REGRESSION PIN. A `stock:` ref drawn from an `"in"` container
    // has no prop to remove, and the arm used to skip the draw-down entirely —
    // the body was fed and the stack never emptied. If the pile only ever rises,
    // food is coming out of nothing.
    expect(everFell).toBe(true);
  });

  it("⑤ NOTHING ACCEPTS FOOD AT A CAMP, so the pile simply STANDS", () => {
    // A site crate is a builder's yard and not a pantry (`isSiteMaterial`), and
    // there is no house chest on this world — so ruling 4 posts no collect row
    // and the larder is left where it is. The user's law working rather than a
    // case handled.
    const s = sess();
    let acceptsFood = false;
    for (const [id, rec] of s.containerRecords) {
      if (/^furn_\d+_chest_food$/.test(id) && rec.relation !== undefined) acceptsFood = true;
    }
    expect(acceptsFood).toBe(false);
    expect(pileUnits()).toBeGreaterThan(0);
  });
});
