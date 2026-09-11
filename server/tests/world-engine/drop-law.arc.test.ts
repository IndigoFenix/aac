// THE DROP LAW — an idle carry is a COST, and a safe drop is the default
// (stocking-offload-and-carry.md §3)
//
// User direction, verbatim (2026-08-07):
//   "Dropping items should be a lot more common… Continuing to hold an item
//    should be treated as a cost — dropping the item should be cheaper than
//    carrying it. If a creature is not doing anything with an item, and
//    dropping the item would not constitute losing it (consider a
//    scope-ambiguous way of expressing this concept), they should drop it by
//    default."
//   (Observed: a dirty shirt carried to the bathroom, through the toilet,
//    through sleep, washed only after waking; the household basket riding
//    along constantly.)
//
// The 2026-08-02 put-down row (`relieveTemplate`) already existed and
// demonstrably LOST: 0.8 × NEED_PRESSURE_S = 32 hand-seconds is outbid by every
// real motive, every decide. Two things land here, and neither is a new act
// family:
//
//   ① `dropKeepsItem` — ONE predicate, asked of the SCOPE TREE: the scope that
//      counts the thing today must still count it after the drop. Inside its own
//      house yes; the street counts for nobody; a stranger's house counts it for
//      THEM; a construction piece in flight is owned by its SITE.
//   ② THE FREED-HANDS TERM (`NeedPrice.freedHandsS`) — what emptying the hands
//      is worth, added to the put-down row's value by `rowValueS` when its act
//      actually empties them. Mechanism ① of §3.2: honest pricing of the row
//      that already exists, never a hands penalty charged to every other row.
//
// What this file pins:
//   A. the predicate, on the REAL dollhouse: own house / street / another house
//      / a construction token at its site and away from it.
//   B. the argmax, pure: idle + safe ⇒ the drop WINS over a live want; mid-play
//      and mid-haul never drop; an unsafe spot never drops; a portable
//      container goes to the FLOOR, never into a chest.
//   C. LIVE, on the real dollhouse: a basket leaves real hands through the real
//      `setDownFromHands` with the session's stock audit unchanged; the
//      dirty-shirt arc, from the wear cycle to the shirt on the floor and the
//      nap taken unburdened; and "stocking unharmed" — a basket that still
//      holds a HAUL is not put down.
//
// Pure logic + headless boots — no DOM / GL / DB.

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootTextQuest } from "@shared/world-engine/headless/text-quest.js";
import { carryObject } from "@shared/world-engine/engine.js";
import { itemObjectSpec } from "@shared/world-engine/interaction/content/item-prop.js";
import { RARE_IMPORT_KIND } from "@shared/world-engine/kernel/town/trade.js";
import {
  NEED_PRESSURE_S,
  decideNeed,
  decideNeeds,
  energyTemplate,
  laundryTemplate,
  provisionTemplate,
  relieveTemplate,
  rowValueS,
  stowTemplate,
  tidyTemplate,
  type NeedCtx,
  type NeedIntent,
  type NeedPrice,
  type NeedTemplate,
} from "@shared/world-engine/interaction/behavior/needs.js";
import {
  CLOTHING_KINDS,
  LAUNDRY_KINDS,
  carryKindsOf,
} from "@shared/world-engine/kernel/town/goods-kinds.js";
import { headOf } from "@shared/world-engine/variations.js";
import { NEED_FILL_S } from "@shared/world-engine/scale.js";
import { isLooseProp, setContainerStock } from "@shared/world-engine/kernel/town/containers.js";

const specPath = join(process.cwd(), "games", "dollhouse", "src", "game.spec.json");
const doc = JSON.parse(readFileSync(specPath, "utf8"));
const DT = 1 / 20;

// ═════════════════════════════════════════════════════════════════════════
// A. THE PREDICATE — asked of the scope tree, on the real dollhouse
// ═════════════════════════════════════════════════════════════════════════

describe("dropKeepsItem — the scope that owns the thing must still count it", () => {
  it("says YES inside its own house, NO in the street and NO in a stranger's", () => {
    const run = bootTextQuest({ world: doc, dt: DT });
    try {
      run.advance(6);
      const houseIndex = run.session.dollhouse!;
      expect(houseIndex).not.toBeNull();
      const cid = `resident_${houseIndex}_0`;
      const body = run.state.avatars[cid]!;
      expect(body).toBeDefined();

      const buildings = run.state.spec.buildings ?? [];
      const mine = buildings.find((b) => b.id === `h_${houseIndex}`)!;
      const theirs = buildings.find((b) => /^h_\d+$/.test(b.id) && b.id !== `h_${houseIndex}`)!;
      expect(mine).toBeDefined();
      expect(theirs).toBeDefined();
      const centreOf = (b: typeof mine) => ({
        x: b.footprint.x + b.footprint.w / 2,
        y: b.footprint.y + b.footprint.h / 2,
      });

      // ITS OWN HOUSE — the loose census buckets a floor prop under the house
      // it stands in, so the household ledger still counts it. Safe.
      expect(run.host.dropKeepsItem(cid, "ball", centreOf(mine))).toBe(true);

      // THE STREET — a prop out there hangs off no scope at all (the census
      // skips a parentless prop), which is exactly what losing it means.
      const away = { x: mine.footprint.x - 500, y: mine.footprint.y - 500 };
      expect(run.host.dropKeepsItem(cid, "ball", away)).toBe(false);

      // A STRANGER'S HOUSE — counted, but by THEM. The same loss from the
      // other side, and the reason the test is descendant-of-owner and not
      // "is it indoors".
      expect(run.host.dropKeepsItem(cid, "ball", centreOf(theirs))).toBe(false);
    } finally {
      run.dispose();
    }
  });

  it("owns a construction piece in flight to its SITE, not to the carrier's house", () => {
    const run = bootTextQuest({ world: doc, dt: DT });
    try {
      run.advance(6);
      const houseIndex = run.session.dollhouse!;
      const cid = `resident_${houseIndex}_0`;
      const body = run.state.avatars[cid]!;
      const buildings = run.state.spec.buildings ?? [];
      const mine = buildings.find((b) => b.id === `h_${houseIndex}`)!;
      const site = buildings.find((b) => /^[hw]_\d+$/.test(b.id) && b.id !== `h_${houseIndex}`)!;
      const centreOf = (b: typeof mine) => ({
        x: b.footprint.x + b.footprint.w / 2,
        y: b.footprint.y + b.footprint.h / 2,
      });

      // THE DIRECTOR'S SHADOW TOKEN — `carry:<buildingKey>:<pieceId>`
      // (construction-director.ts `liftPieceIntoHands`). The id NAMES its
      // building, and a building key IS a scope id, so the piece's owner is
      // read off the vocabulary rather than guessed at.
      const token = `carry:${site.id}:piece_1`;
      expect(run.host.world!.addObject(itemObjectSpec("chair", token, { x: body.x, y: body.y }))).toBe(true);
      expect(carryObject(run.state, token, cid)).toBe(true);

      expect(run.host.dropKeepsItem(cid, "chair", centreOf(site))).toBe(true);
      // …and NOT at the carrier's own hearth: the piece belongs to the site's
      // ledger while it is in flight, so a hallway drop at home loses it.
      expect(run.host.dropKeepsItem(cid, "chair", centreOf(mine))).toBe(false);
    } finally {
      run.dispose();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// B. THE ARGMAX — pure, over the real templates and the real walker
// ═════════════════════════════════════════════════════════════════════════

const price = (over: Partial<NeedPrice> = {}): NeedPrice => ({
  walkMps: 1.6,
  fillS: NEED_FILL_S.hunger,
  unitValueS: relieveTemplate().priority * NEED_PRESSURE_S, // nothing CONSUMES an untyped row's good
  shortage: 1,
  handsS: { container: 1.1, source: 18, loose: 1.1, satisfy: 1.1 },
  ...over,
});

/** The put-down row's ctx as `residentNeedCtx` resolves it: the ONE idle held
 *  object, the storage role only when the thing does not live on the floor,
 *  the drop-law answer, and the freed-hands term on the price board. */
function putDownCtx(opts: {
  held?: boolean;
  box?: boolean;
  safe?: boolean;
  freedHandsS?: number;
}): NeedCtx {
  const held = opts.held ?? true;
  return {
    carried: held ? 1 : 0,
    containers: opts.box
      ? { storage: { id: "furn_9_chest", place: { kind: "named", id: "furn_9_chest" }, units: 0, d: 4 } }
      : {},
    sources: [],
    stations: [],
    ...(held && opts.safe !== undefined ? { dropKeepsItem: opts.safe } : {}),
    price: price(opts.freedHandsS ? { freedHandsS: opts.freedHandsS } : {}),
  };
}

const OPTS = { costSelection: true } as const;

describe("the freed-hands term — what the put-down row is really worth", () => {
  const relieve = relieveTemplate();
  const dropHere: NeedIntent = { kind: "dropHere", units: 1 };

  it("is the shipped 32 hand-seconds when nothing is pressing", () => {
    expect(rowValueS(relieve, putDownCtx({ safe: true }), dropHere)).toBeCloseTo(32, 6);
  });

  it("adds what the hands are worth FREE, and only to an act that empties them", () => {
    const ctx = putDownCtx({ safe: true, freedHandsS: 4 * NEED_PRESSURE_S }); // a live energy want
    expect(rowValueS(relieve, ctx, dropHere)).toBeCloseTo(32 + 160, 6);
    // A walk frees nothing and must not be paid for it.
    expect(rowValueS(relieve, ctx, { kind: "restHere" })).toBeCloseTo(0, 6);
  });

  it("is absent on an unpriced ctx — the headless probe decides as it always did", () => {
    const bare: NeedCtx = { carried: 1, containers: {}, sources: [], stations: [] };
    expect(rowValueS(relieve, bare, dropHere)).toBe(0);
  });
});

describe("idle + safe ⇒ the DROP wins the argmax", () => {
  // The dirty-shirt arc in one comparison: a tired body holding something no
  // row is using. Before the freed-hands term the sleep won every decide and
  // the thing rode the hands to the bed; now the hands come back first.
  const relieve = relieveTemplate();
  const energy = energyTemplate(1 / NEED_FILL_S.energy);

  const ctxOf = (freedHandsS: number) => (tpl: NeedTemplate): NeedCtx => {
    if (tpl.key === relieve.key) return putDownCtx({ safe: true, freedHandsS });
    return {
      meter: 1, // tired, at the threshold
      carried: 0,
      containers: {},
      sources: [],
      stations: [{ id: "bed", place: { kind: "named", id: "bed" }, kind: "bed", waiting: 0, d: 3 }],
      price: price({ fillS: NEED_FILL_S.energy, handsS: { container: 1.1, source: 18, loose: 1.1, satisfy: 12 } }),
    };
  };

  it("puts the thing down FIRST and sleeps unburdened", () => {
    const decided = decideNeeds([energy, relieve], ctxOf(energy.priority * NEED_PRESSURE_S), OPTS);
    expect(decided).toMatchObject({ tpl: { key: "relieve" }, intent: { kind: "dropHere", units: 1 } });
  });

  it("…and with NOTHING pressing the sleep still wins — the rung is untouched", () => {
    // freedHandsS 0 = no live want, so the row is worth its own 32 s again and
    // a real motive outbids it exactly as the 2026-08-02 law says it should.
    const decided = decideNeeds([energy, relieve], ctxOf(0), OPTS);
    expect(decided?.tpl.key).toBe(energy.key);
  });
});

describe("the guards — what must NEVER be dropped", () => {
  const relieve = relieveTemplate();

  it("an UNSAFE spot never drops: no box ⇒ the want surfaces, it does not scatter", () => {
    // The market walk keeps the basket. `orDrop`'s old promise ("there is
    // always an answer") may not be allowed to mean "put it in the street".
    expect(decideNeed(relieve, putDownCtx({ safe: false }), OPTS)).toEqual({ kind: "blocked" });
  });

  it("an UNSAFE spot with a box still WALKS it home", () => {
    expect(decideNeed(relieve, putDownCtx({ safe: false, box: true }), OPTS)).toMatchObject({
      kind: "deposit",
      units: 1,
    });
  });

  it("nothing in the hands ⇒ the row is idle (the caller's `heldIdleObject` is the gate)", () => {
    // mid-play and mid-haul both arrive here: `heldIdleObject` refuses the toy a
    // live `use` row wants and the haul a banking row claims, so the row's
    // `carried` is 0 and it never fires at all — whatever the hands are worth.
    expect(decideNeed(relieve, putDownCtx({ held: false, safe: true, freedHandsS: 200 }), OPTS)).toEqual({
      kind: "idle",
    });
  });

  it("a row that can PICK THINGS UP never prefers the floor (the livelock invariant)", () => {
    // tidy acquires `loose`, so a drop-here preference on it would sweep a
    // thing up and put it straight back down. The gate is structural
    // (`acquire.length === 0`), not a name test.
    const tidy = tidyTemplate();
    expect(tidy.acquire.length).toBeGreaterThan(0);
    const ctx: NeedCtx = { ...putDownCtx({ safe: true, box: true, freedHandsS: 200 }) };
    expect(decideNeed(tidy, { ...ctx, containers: { storage: ctx.containers.storage! } }, OPTS)).toMatchObject({
      kind: "deposit",
    });
  });

  it("A HAUL STILL BANKS — a provision row can't drop at all, safe spot or not", () => {
    // The banking rows carry no `orDrop`, so the drop law cannot reach them by
    // any path: a body standing in its own kitchen holding the week's food
    // walks it to the shelf, exactly as before. (Belt: the caller never asks
    // the question for them either — `dropKeepsItem` is resolved only for the
    // row whose subject is the idle held object.)
    const provision = provisionTemplate("food", 6, 12);
    expect(provision.satisfy.kind === "deposit" && provision.satisfy.orDrop).toBeUndefined();
    const ctx: NeedCtx = {
      carried: 5,
      containers: {
        home: { id: "furn_9_chest_food", place: { kind: "named", id: "furn_9_chest_food" }, units: 1, room: 11, d: 4 },
      },
      sources: [],
      stations: [],
      dropKeepsItem: true, // …even if it were asked
      price: price({ unitValueS: 5 * NEED_PRESSURE_S }),
    };
    expect(decideNeed(provision, ctx, OPTS)).toMatchObject({ kind: "deposit", units: 5 });
  });
});

describe("the dirty shirt — the item the banking rows do NOT claim", () => {
  it("is invisible to stow's carry projection, so nothing was ever walking it home", () => {
    // THE REPORTED ARC, in one assertion. `provisionedHeads` is HEAD-matched,
    // and `headOf("shirt.color_red.dirty")` is `"shirt"` — so the put-down row
    // was told "clothing is provisioned, leave it alone" about a garment that
    // `stow:clothing` cannot see and no other deposit row exists for. Asking
    // the rows through their own carry projection is what tells them apart.
    const stow = stowTemplate("clothing", 8);
    const dirty = LAUNDRY_KINDS[0]!;
    expect(headOf(dirty)).toBe(headOf(CLOTHING_KINDS[0]!)); // the head-match trap
    expect(carryKindsOf(stow.item.category!)).not.toContain(dirty); // …and the honest answer
    expect(carryKindsOf("laundry")).toContain(dirty);
  });

  it("belongs to a row that fires forever, has no meter, and picks it off the FLOOR", () => {
    // So "the laundry row exists" can never mean "keep hold of the shirt" —
    // and once the shirt is down, the wash's own `loose` branch finds it.
    const laundry = laundryTemplate();
    expect(laundry.satisfy.kind).toBe("transform");
    expect(laundry.drive.kind).toBe("mess"); // no meter to raise ⇒ `wantedByLiveRow` reads it unfired
    expect(laundry.acquire).toEqual([{ kind: "loose" }]);
  });
});

describe("a portable container goes to the FLOOR, never into a chest", () => {
  it("has no storage role at all, so `orDrop` is the only answer (container-home rung 0)", () => {
    // quest-host resolves the row's storage role through `livesOnTheFloor`
    // FIRST, so a basket is offered no box; the row's own answer is the ground.
    expect(decideNeed(relieveTemplate(), putDownCtx({ safe: true, box: false }), OPTS)).toEqual({
      kind: "dropHere",
      units: 1,
    });
  });

  it("…and even WITH a box offered, a safe drop here beats the deposit walk", () => {
    expect(decideNeed(relieveTemplate(), putDownCtx({ safe: true, box: true }), OPTS)).toEqual({
      kind: "dropHere",
      units: 1,
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// C. LIVE — conservation through the real doors, and the haul left alone
// ═════════════════════════════════════════════════════════════════════════

describe("the drop, live on the dollhouse", () => {
  it("sets an idle basket on the floor through the real machinery, conserving every unit", () => {
    const run = bootTextQuest({ world: doc, dt: DT });
    try {
      run.advance(6);
      const session = run.session;
      const houseIndex = session.dollhouse!;
      const cid = `resident_${houseIndex}_0`;

      const bagId = run.host.giveBag(cid, "basket");
      expect(bagId).not.toBeNull();
      // PAST THE COMMAND GRACE: `TIDY_GRACE_S` is what makes an order the
      // player just gave visibly land, and this basket was not ordered.
      session.containerRecords.get(bagId!)!.at = session.townClock - 1000;
      // …and a nap is due, so the freed-hands term is live: this is the case
      // the ride-along was made of — a body with something else to do, holding
      // a bag it has no use for.
      session.needMeters.set(`${cid}|energy`, 1.0);
      const before = run.host.stockAudit();

      // An EMPTY basket has no contents with anywhere to be, so nothing on the
      // body speaks for it: the drop law's own case.
      let down = false;
      for (let i = 0; i < 60 && !down; i++) {
        run.advance(1); // ONE FRAME — the drop lands within a second of sim
        down = !run.state.objects[bagId!]?.carriedBy;
      }
      expect(down).toBe(true);

      // ITEM CONSERVATION: the audit walks every stack in the session, and a
      // set-down basket is still one basket in the household's ledger.
      expect(run.host.stockAudit()).toEqual(before);
      expect(run.host.dropKeepsItem(cid, "basket")).toBe(true);
    } finally {
      run.dispose();
    }
  });

  it("THE DIRTY-SHIRT ARC: doffed, PUT DOWN at home, and the nap taken unburdened", () => {
    const run = bootTextQuest({ world: doc, dt: DT });
    try {
      run.advanceS(2);
      const session = run.session;
      const houseIndex = session.dollhouse!;
      const cid = `resident_${houseIndex}_1`;
      const wardrobe = `furn_${houseIndex}_chest_clothing`;
      const clean = () => Object.values(session.containerRecords.get(wardrobe)?.stock ?? {}).reduce((a, b) => a + b, 0);

      // THE WEAR CYCLE, driven from its own meter: the garment is worn out, so
      // the dress row fetches a clean one and the equip effect hands the doffed
      // one back as a `.dirty` unit — the whole laundry chain's only trigger.
      session.needMeters.set(`${cid}|dress`, 1.4);

      let dirtyId: string | null = null;
      for (let i = 0; i < 40 && !dirtyId; i++) {
        run.advanceS(0.5);
        const held = Object.values(run.state.objects).find((o) => o.carriedBy === cid);
        if (held && session.containerRecords.get(held.id)?.glyph?.endsWith(".dirty")) dirtyId = held.id;
      }
      expect(dirtyId).not.toBeNull();
      // Counted AFTER the change of clothes: the clean one the dress row drew
      // is now being WORN, so this is the shelf the wash has to return to.
      const cleanAfterChange = clean();

      // …and now it has RIDDEN a while (past `TIDY_GRACE_S`, which exists so a
      // player's order visibly lands and is not the drop law's business) and a
      // nap comes due. Before this pass the shirt went to bed with the body.
      session.containerRecords.get(dirtyId!)!.at = session.townClock - 200;
      session.needMeters.set(`${cid}|energy`, 1.0);

      let down = false;
      for (let i = 0; i < 20 && !down; i++) {
        run.advanceS(0.5);
        down = !run.state.objects[dirtyId!]?.carriedBy;
      }
      // ① DROPPED — and the loose census keeps it findable, which is the whole
      // point of asking the scope tree rather than dropping it anywhere.
      expect(down).toBe(true);
      expect(isLooseProp(session, dirtyId!)).toBe(true);

      // ② …AND STILL THE HOUSEHOLD'S, lying in its own house: which is what
      // makes the wash able to find it (`laundryTemplate().acquire` is `loose`
      // and nothing else). The wash TAIL itself is a long play arc and belongs
      // in text mode, not here — CLAUDE.md's own rule about jest and
      // quest-host. It is quoted in the §3 ledger: a housemate picks the shirt
      // up, scrubs it at `furn_<h>_bath`, and banks the clean garment.
      expect(run.host.dropKeepsItem(cid, session.containerRecords.get(dirtyId!)!.glyph!)).toBe(true);
      expect(clean()).toBe(cleanAfterChange); // nothing banked yet — it is on the floor
    } finally {
      run.dispose();
    }
  });

  it("STOCKING UNHARMED: a basket that still holds a haul is not put down", () => {
    const run = bootTextQuest({ world: doc, dt: DT });
    try {
      run.advance(6);
      const session = run.session;
      const houseIndex = session.dollhouse!;
      const cid = `resident_${houseIndex}_1`;

      const bagId = run.host.giveBag(cid, "basket");
      expect(bagId).not.toBeNull();
      session.containerRecords.get(bagId!)!.at = session.townClock - 1000;
      // Treats ARE food (they bank into the food chest) but are never dealt
      // into a pantry mix, so nothing else in the house can eat them behind
      // the assertion — the same lever `trip-span.test.ts` uses.
      setContainerStock(session, bagId!, { [RARE_IMPORT_KIND]: 3 });

      run.advanceS(3); // the empty basket above went down inside 0.6 s

      // Either still in hand, or banked into the household's own box — never
      // tipped onto the floor and abandoned. The units are what matter.
      const inHand = run.host.carryOf(cid)[RARE_IMPORT_KIND] ?? 0;
      const chest = session.containerRecords.get(`furn_${houseIndex}_chest_food`)?.stock ?? {};
      expect(inHand + (chest[RARE_IMPORT_KIND] ?? 0)).toBe(3);
    } finally {
      run.dispose();
    }
  });
});
