// The need-template walker (needs.ts): needs as data over one generic, step-by-step
// decision — the founding hunger + provision templates and their emergent interplay
// (steal the pantry → buy at the market; gift a stack → it gets put away at home).
import { describe, expect, it } from "@jest/globals";
import {
  decideNeed,
  decideNeeds,
  energyTemplate,
  hungerTemplate,
  needFires,
  provisionTemplate,
  unloadTemplate,
  tidyTemplate,
  socialTemplate,
  type NeedCtx,
  type StockCandidate,
  type StationCandidate,
} from "@shared/world-engine/interaction/behavior/needs.js";
import { NEED_FILL_S } from "@shared/world-engine/scale.js";

const P = (id: string) => ({ kind: "named" as const, id });
const stock = (id: string, units: number, room?: number): StockCandidate =>
  room === undefined ? { id, place: P(id), units } : { id, place: P(id), units, room };
const table = (id: string, waiting = 0): StationCandidate => ({ id, place: P(id), kind: "table", waiting });

const hunger = hungerTemplate("food", 1 / NEED_FILL_S.hunger);
const provision = provisionTemplate("food", 5, 15);

const empty: NeedCtx = { meter: 0, carried: 0, containers: {}, sources: [], stations: [] };

describe("hunger — meter drive over the acquire branches", () => {
  it("below threshold → idle, whatever the world offers", () => {
    const ctx = { ...empty, meter: 0.5, containers: { home: stock("pantry", 9) } };
    expect(decideNeed(hunger, ctx)).toEqual({ kind: "idle" });
  });
  it("hungry, pantry stocked → take 1 from the home container (first branch)", () => {
    const ctx = { ...empty, meter: 1, containers: { home: stock("pantry", 3) }, sources: [stock("store", 8)] };
    expect(decideNeed(hunger, ctx)).toEqual({ kind: "take", from: stock("pantry", 3), units: 1 });
  });
  it("hungry, pantry EMPTY → falls through to buying 1 at the source", () => {
    const ctx = { ...empty, meter: 1, containers: { home: stock("pantry", 0) }, sources: [stock("store", 8)] };
    expect(decideNeed(hunger, ctx)).toEqual({ kind: "take", from: stock("store", 8), units: 1 });
  });
  it("hungry, nothing anywhere → blocked (surfaces, never crashes)", () => {
    expect(decideNeed(hunger, { ...empty, meter: 1 })).toEqual({ kind: "blocked" });
  });
});

describe("hunger — consuming", () => {
  it("carrying a unit → consume at the preferred station kind", () => {
    const other: StationCandidate = { id: "bench", place: P("bench"), kind: "bench", waiting: 0 };
    const ctx = { ...empty, meter: 1, carried: 1, stations: [other, table("table")] };
    expect(decideNeed(hunger, ctx)).toEqual({ kind: "consumeAt", station: table("table") });
  });
  it("carrying, no station at all → consume in place", () => {
    expect(decideNeed(hunger, { ...empty, meter: 1, carried: 1 })).toEqual({ kind: "consumeHere" });
  });
  it("a unit already WAITING at a station → acquire + consume combine (skip the fetch)", () => {
    const ctx = {
      ...empty,
      meter: 1,
      containers: { home: stock("pantry", 3) },
      stations: [table("table", 1)],
    };
    expect(decideNeed(hunger, ctx)).toEqual({ kind: "consumeAt", station: table("table", 1) });
  });
  it("disruption re-routes: the carried unit vanishes → the next call fetches again", () => {
    const base = { ...empty, meter: 1, containers: { home: stock("pantry", 2) }, stations: [table("t")] };
    expect(decideNeed(hunger, { ...base, carried: 1 })).toMatchObject({ kind: "consumeAt" });
    expect(decideNeed(hunger, { ...base, carried: 0 })).toEqual({ kind: "take", from: stock("pantry", 2), units: 1 });
  });
});

describe("provision — stock drive, deposit satisfy", () => {
  it("pantry below the buffer → buy the shortfall at the source, capped by its shelf", () => {
    const ctx = { ...empty, containers: { home: stock("pantry", 2) }, sources: [stock("store", 6)] };
    // shortfall = 15 − 2 = 13, shelf holds 6 → take 6.
    expect(decideNeed(provision, ctx)).toEqual({ kind: "take", from: stock("store", 6), units: 6 });
  });
  it("pantry at/above the buffer → idle (no trip)", () => {
    const ctx = { ...empty, containers: { home: stock("pantry", 5) }, sources: [stock("store", 6)] };
    expect(decideNeed(provision, ctx)).toEqual({ kind: "idle" });
  });
  it("CARRYING units (a gift) → deposit at home even though stock is fine", () => {
    const ctx = { ...empty, carried: 3, containers: { home: stock("pantry", 9, 6) } };
    expect(decideNeed(provision, ctx)).toEqual({ kind: "deposit", into: stock("pantry", 9, 6), units: 3 });
  });
  it("deposit is capped by the container's room", () => {
    const ctx = { ...empty, carried: 5, containers: { home: stock("pantry", 13, 2) } };
    expect(decideNeed(provision, ctx)).toEqual({ kind: "deposit", into: stock("pantry", 13, 2), units: 2 });
  });
  it("firing but no source can supply → blocked", () => {
    const ctx = { ...empty, containers: { home: stock("pantry", 0) }, sources: [stock("store", 0)] };
    expect(decideNeed(provision, ctx)).toEqual({ kind: "blocked" });
  });
  it("carrying units with the container FULL (room 0) → BLOCKED, not idle", () => {
    // A full pantry must be distinguishable from contentment (§4, DEBUG-
    // CREATURE-BEHAVIOR): the want surfaces (beg/adoption/diagnostics) instead
    // of the haul silently living in the hands forever.
    const ctx = { ...empty, carried: 3, containers: { home: stock("pantry", 15, 0) } };
    expect(decideNeed(provision, ctx)).toEqual({ kind: "blocked" });
  });
  it("units in hand count toward the stock drive (no over-buying mid-restock)", () => {
    // pantry 2 + carrying 4 ≥ buffer 5 → the drive itself no longer fires; what fires is
    // the put-it-away rule, so the intent is the deposit, not another buy.
    const ctx = { ...empty, carried: 4, containers: { home: stock("pantry", 2, 13) } };
    expect(needFires(provision, ctx)).toBe(true);
    expect(decideNeed(provision, ctx)).toEqual({ kind: "deposit", into: stock("pantry", 2, 13), units: 4 });
  });
});

describe("decideNeeds — priority across a creature's templates", () => {
  it("hunger (5) outranks provisioning (3) when both fire", () => {
    const ctxOf = (tpl: { key: string }): NeedCtx =>
      tpl.key.startsWith("hunger")
        ? { ...empty, meter: 1, containers: { home: stock("pantry", 1) } }
        : { ...empty, containers: { home: stock("pantry", 1) }, sources: [stock("store", 9)] };
    const chosen = decideNeeds([provision, hunger], ctxOf);
    expect(chosen?.tpl.key).toBe("hunger:food");
    expect(chosen?.intent).toEqual({ kind: "take", from: stock("pantry", 1), units: 1 });
  });
  it("hunger idle → provisioning acts; nothing firing → null", () => {
    const fed = (tpl: { key: string }): NeedCtx =>
      tpl.key.startsWith("hunger")
        ? { ...empty, meter: 0 }
        : { ...empty, containers: { home: stock("pantry", 2) }, sources: [stock("store", 9)] };
    expect(decideNeeds([hunger, provision], fed)?.tpl.key).toBe("provision:food");
    expect(decideNeeds([hunger, provision], () => ({ ...empty, containers: { home: stock("pantry", 9) } }))).toBeNull();
  });
});

describe("Sims-mode motives — rest and social (dollhouse §3)", () => {
  const energy = energyTemplate(1 / NEED_FILL_S.energy);
  const social = socialTemplate(1 / NEED_FILL_S.social);
  const bed = (id: string): StationCandidate => ({ id, place: P(id), kind: "bed", waiting: 0 });
  const partner = (id: string): StationCandidate => ({ id, place: P(id), kind: "partner", waiting: 0 });

  it("tired with a bed -> restAt the bed (preferred kind); no bed -> doze in place", () => {
    const other: StationCandidate = { id: "chair", place: P("chair"), kind: "chair", waiting: 0 };
    expect(decideNeed(energy, { ...empty, meter: 1, stations: [other, bed("bed_0")] }))
      .toEqual({ kind: "restAt", station: bed("bed_0") });
    expect(decideNeed(energy, { ...empty, meter: 1 })).toEqual({ kind: "restHere" });
    expect(decideNeed(energy, { ...empty, meter: 0.4, stations: [bed("bed_0")] })).toEqual({ kind: "idle" });
  });

  it("lonely with housemates around -> socialize with the nearest; alone -> blocked", () => {
    expect(decideNeed(social, { ...empty, meter: 1, stations: [partner("resident_3_2"), partner("resident_3_4")] }))
      .toEqual({ kind: "socialize", station: partner("resident_3_2") });
    expect(decideNeed(social, { ...empty, meter: 1 })).toEqual({ kind: "blocked" });
  });

  it("priorities: hunger > energy > provision > social", () => {
    const hungerT = hungerTemplate("food", 1 / NEED_FILL_S.hunger);
    const provisionT = provisionTemplate("food", 5, 15);
    const fireAll = (tpl: { key: string }): NeedCtx =>
      tpl.key.startsWith("hunger")
        ? { ...empty, meter: 1, containers: { home: stock("pantry", 3) } }
        : tpl.key === "energy"
          ? { ...empty, meter: 1, stations: [bed("bed_0")] }
          : tpl.key === "social"
            ? { ...empty, meter: 1, stations: [partner("p")] }
            : { ...empty, containers: { home: stock("pantry", 1) }, sources: [stock("store", 9)] };
    const order: string[] = [];
    let pool = [social, provisionT, energy, hungerT];
    while (pool.length) {
      const chosen = decideNeeds(pool, fireAll)!;
      order.push(chosen.tpl.key);
      pool = pool.filter((t) => t !== chosen.tpl);
    }
    expect(order).toEqual(["hunger:food", "energy", "provision:food", "social"]);
  });
});

// ── Round 2 (creature-behavior-brainstorming.md V1): thirst / waste / hygiene /
// tidy templates, the capability-shaped pet rows, adoption-shaped supply rows,
// and the derived stress invariants (mood.ts).

import {
  funTemplate,
  hygieneTemplate,
  thirstTemplate,
  tidyTemplate,
  wasteTemplate,
  type NeedTemplate,
} from "@shared/world-engine/interaction/behavior/needs.js";
import { needPressure, stressStep } from "@shared/world-engine/interaction/behavior/mood.js";

describe("round-2 basic needs — thirst, waste, hygiene", () => {
  const thirst = thirstTemplate(1 / NEED_FILL_S.thirst);
  const waste = wasteTemplate(1 / NEED_FILL_S.waste);
  const hygiene = hygieneTemplate(1 / NEED_FILL_S.hygiene);
  const st = (id: string, kind: string): StationCandidate => ({ id, place: P(id), kind, waiting: 0 });

  it("thirst is hunger's shape over water: barrel first, then the well", () => {
    const ctx = { ...empty, meter: 1, containers: { home: stock("barrel", 3) }, sources: [stock("well", 99)] };
    expect(decideNeed(thirst, ctx)).toEqual({ kind: "take", from: stock("barrel", 3), units: 1 });
    const dry = { ...empty, meter: 1, containers: { home: stock("barrel", 0) }, sources: [stock("well", 99)] };
    expect(decideNeed(thirst, dry)).toEqual({ kind: "take", from: stock("well", 99), units: 1 });
  });

  it("waste/hygiene REQUIRE their station — no toilet/tub means blocked, never 'in place'", () => {
    expect(decideNeed(waste, { ...empty, meter: 1, stations: [st("toilet", "toilet")] }))
      .toEqual({ kind: "restAt", station: st("toilet", "toilet") });
    expect(decideNeed(waste, { ...empty, meter: 1 })).toEqual({ kind: "blocked" });
    expect(decideNeed(hygiene, { ...empty, meter: 1, stations: [st("bath", "bath")] }))
      .toEqual({ kind: "restAt", station: st("bath", "bath") });
    expect(decideNeed(hygiene, { ...empty, meter: 1 })).toEqual({ kind: "blocked" });
  });
});

describe("fun — get a toy out, SET IT OUT, and play at it (a temporary station)", () => {
  const fun = funTemplate(1 / NEED_FILL_S.fun);
  /** A play area: a toy set out on the floor that somebody is playing at. The
   *  host lists these as stations (kind "play") — see isPlayArea. */
  const area = (id: string): StationCandidate => ({ id, place: P(id), kind: "play", waiting: 0 });

  it("the template selects on the `play` AFFORDANCE, not a location", () => {
    // It must never name a station kind: play is a function objects carry, so
    // there is nothing to REQUIRE. The station a use row plays at is not a
    // fixture the house was built with — it is the toy itself, once set out.
    expect(fun.item).toEqual({ affords: "play" });
    expect(fun.satisfy).toEqual({ kind: "use" });
  });

  it("bored with a toy in hand → SET IT OUT here (the toy becomes the play area)", () => {
    // A toy is not used in the hands: it is put down in open ground and played
    // at, which is what lets a second body join the same one.
    expect(decideNeed(fun, { ...empty, meter: 1, carried: 1 })).toEqual({ kind: "setOutHere" });
  });

  it("a play area already standing → GO AND JOIN IT (station before acquisition)", () => {
    // THE SOCIAL RULE. Station-first is the whole of "several creatures may use
    // it at the same time": the second bored body walks to the game already in
    // progress instead of fetching a second ball of its own.
    const toy = { id: "small:ball", place: P("small:ball"), units: 1 };
    const box = stock("box", 2);
    const ctx = { ...empty, meter: 1, stations: [area("small:teddy")], loose: [toy], containers: { storage: box } };
    expect(decideNeed(fun, ctx)).toEqual({ kind: "restAt", station: area("small:teddy") });
  });

  it("…and joining beats setting out a second one, even with a toy in hand", () => {
    const ctx = { ...empty, meter: 1, carried: 1, stations: [area("small:teddy")] };
    expect(decideNeed(fun, ctx)).toEqual({ kind: "restAt", station: area("small:teddy") });
  });

  it("the NEAREST area wins (the ctx lists them nearest-first)", () => {
    const ctx = { ...empty, meter: 1, stations: [area("small:near"), area("small:far")] };
    expect(decideNeed(fun, ctx)).toEqual({ kind: "restAt", station: area("small:near") });
  });

  it("bored, empty-handed, a toy lying loose → fetch it first", () => {
    const toy = { id: "small:teddy", place: P("small:teddy"), units: 1 };
    expect(decideNeed(fun, { ...empty, meter: 1, loose: [toy] }))
      .toEqual({ kind: "take", from: toy, units: 1 });
  });

  it("bored, empty-handed, a toy in the box → open the box (storage acquire branch)", () => {
    const box = stock("box", 2);
    expect(decideNeed(fun, { ...empty, meter: 1, containers: { storage: box } }))
      .toEqual({ kind: "take", from: box, units: 1 });
  });

  it("bored but nothing to play with anywhere → blocked (surfaces, never a fidget at a fixture)", () => {
    expect(decideNeed(fun, { ...empty, meter: 1 })).toEqual({ kind: "blocked" });
  });

  it("below threshold → idle whatever's around (the lightest motive waits)", () => {
    const box = stock("box", 2);
    expect(decideNeed(fun, { ...empty, meter: 0.5, containers: { storage: box } }))
      .toEqual({ kind: "idle" });
  });

  it("a toy IN USE is not clutter — fun plays, tidy stays out of it", () => {
    // REGRESSION (the take-out/put-back loop): tidy outranks fun (1.2 > 1.0),
    // so if the toy in hand counted as clutter the chore banked it straight
    // back into the box every tick — the body flickered between "play" and
    // "errand" at the box forever. The host excludes an in-use item from
    // tidy's carried count (carriedClutter/inUseByLiveNeed); this is the
    // resolution that produces: the body plays instead of tidying.
    const tidy = tidyTemplate();
    const pick = decideNeeds([fun, tidy], (t) =>
      t.key === "fun"
        ? { ...empty, meter: 1, carried: 1 } // holding the toy → set it out
        : { ...empty, carried: 0 },          // in use ⇒ not clutter, nothing loose
    );
    expect(pick?.tpl.key).toBe("fun");
    expect(pick?.intent).toEqual({ kind: "setOutHere" });
  });

  it("THE TIDY EXEMPTION, one layer up: a toy SET OUT and in play is not clutter", () => {
    // The same rule as the carried case, applied to the floor. A live play area
    // is listed as a STATION and withheld from every loose list (the host's
    // `inPlay` guard), so the chore has nothing to sweep and the players keep
    // playing — the game is never tidied out from under them mid-play.
    const tidy = tidyTemplate();
    const pick = decideNeeds([fun, tidy], (t) =>
      t.key === "fun"
        ? { ...empty, meter: 1, stations: [area("small:teddy")] } // playing at it
        : { ...empty, loose: [] },                                // in play ⇒ nothing loose to sweep
    );
    expect(pick?.tpl.key).toBe("fun");
    expect(pick?.intent).toEqual({ kind: "restAt", station: area("small:teddy") });
  });

  it("when the last player stops, the toy IS clutter again — tidy files it away", () => {
    // THE RETIREMENT, from the chore's side: nobody is playing, so the host
    // lists no area and the prop reappears in tidy's loose sweep.
    const tidy = tidyTemplate();
    const toy = { id: "small:teddy", place: P("small:teddy"), units: 1 };
    const box = stock("box", 0, 99);
    const pick = decideNeeds([fun, tidy], (t) =>
      t.key === "fun"
        ? { ...empty, meter: 0 }                                        // satisfied — not firing
        : { ...empty, loose: [toy], containers: { storage: box } },     // no longer in use
    );
    expect(pick?.tpl.key).toBe("tidy");
    expect(pick?.intent).toEqual({ kind: "take", from: toy, units: 1 });
  });

  it("once fun is satisfied the toy DOES become clutter — tidy puts it away", () => {
    // The other half of the loop: play over (meter 0), the toy is no longer in
    // use, so it counts as clutter and the chore banks it in its container.
    const tidy = tidyTemplate();
    const box = stock("box", 0, 99);
    const pick = decideNeeds([fun, tidy], (t) =>
      t.key === "fun"
        ? { ...empty, meter: 0, carried: 1 } // satisfied — no longer firing
        : { ...empty, carried: 1, containers: { storage: box } },
    );
    expect(pick?.tpl.key).toBe("tidy");
    expect(pick?.intent).toEqual({ kind: "deposit", into: box, units: 1 });
  });
});

describe("tidy — the mess drive over loose clutter", () => {
  const tidy = tidyTemplate();
  const loose = (id: string): StockCandidate => ({ id, place: P(id), units: 1 });

  it("no clutter, nothing carried → idle", () => {
    expect(decideNeed(tidy, { ...empty, containers: { storage: stock("box", 0, 99) } }))
      .toEqual({ kind: "idle" });
  });
  it("clutter on the floor → pick the nearest loose unit up", () => {
    const ctx = { ...empty, containers: { storage: stock("box", 0, 99) }, loose: [loose("small:ball"), loose("small:teddy")] };
    expect(decideNeed(tidy, ctx)).toEqual({ kind: "take", from: loose("small:ball"), units: 1 });
  });
  it("carrying clutter → bank it in the storage container", () => {
    const ctx = { ...empty, carried: 1, containers: { storage: stock("box", 0, 99) } };
    expect(decideNeed(tidy, ctx)).toEqual({ kind: "deposit", into: stock("box", 0, 99), units: 1 });
  });
  it("clutter but no storage anywhere → blocked (surfaces, never crashes)", () => {
    expect(decideNeed(tidy, { ...empty, carried: 1 })).toEqual({ kind: "blocked" });
  });
});

describe("capability + adoption — the pet is fed with ZERO petcare code", () => {
  // The pet's OWN hunger row: same template, but its ctx resolution offered no
  // lidded containers and no purse (grasp: false) — only the bowl station.
  const petHunger = hungerTemplate("food", 1 / NEED_FILL_S.hunger, ["bowl"]);
  const bowlSt = (waiting: number): StationCandidate => ({ id: "bowl", place: P("bowl"), kind: "bowl", waiting });

  it("hungry pet, empty bowl, no reachable branches → the want BLOCKS (the beg)", () => {
    expect(decideNeed(petHunger, { ...empty, meter: 1, stations: [bowlSt(0)] })).toEqual({ kind: "blocked" });
  });

  it("a helper's adoption row: bowl empty → fetch from its own pantry → deposit ONE", () => {
    // The derived row a housemate runs for the blocked wanter (adoptionTemplates' shape).
    const adopt: NeedTemplate = {
      key: "adopt:pet_0_0|hunger:food",
      item: { category: "food" },
      drive: { kind: "stock", container: "recipient", below: 1 },
      satisfy: { kind: "deposit", container: "recipient", upTo: 1 },
      acquire: [{ kind: "container", role: "home" }, { kind: "source" }],
      priority: 3.5, // above provision (3) — the livelock invariant
    };
    const bowl = stock("bowl", 0, 2);
    // Not carrying → take 1 from the pantry (the shortfall is 1).
    expect(decideNeed(adopt, { ...empty, containers: { recipient: bowl, home: stock("pantry", 4) } }))
      .toEqual({ kind: "take", from: stock("pantry", 4), units: 1 });
    // Carrying → walk it to the bowl.
    expect(decideNeed(adopt, { ...empty, carried: 1, containers: { recipient: bowl } }))
      .toEqual({ kind: "deposit", into: bowl, units: 1 });
    // Bowl filled → the row stops firing (no double-feeding).
    expect(decideNeed(adopt, { ...empty, containers: { recipient: stock("bowl", 1, 1), home: stock("pantry", 4) } }))
      .toEqual({ kind: "idle" });
  });

  it("the fed pet's own walker eats what WAITS at the bowl", () => {
    expect(decideNeed(petHunger, { ...empty, meter: 1, stations: [bowlSt(1)] }))
      .toEqual({ kind: "consumeAt", station: bowlSt(1) });
  });
});

describe("derived stress (mood.ts) — the behavior-model invariants", () => {
  // A meter rises at `rate`; a SERVED need clears within `serveS` seconds of
  // firing; an UNSERVED one never clears. Stress must stay ~flat in the first
  // world and CLIMB in the second — if the equipped house frays, the model is
  // broken somewhere.
  function simulate(rate: number, serveS: number | null, seconds: number): number {
    const dt = 1;
    let meter = 0;
    let firedFor = 0;
    let stress = 0;
    for (let t = 0; t < seconds; t += dt) {
      meter += rate * dt;
      if (meter >= 1) {
        firedFor += dt;
        if (serveS !== null && firedFor >= serveS) {
          meter = 0;
          firedFor = 0;
        }
      }
      stress = stressStep(stress, needPressure([meter]), dt);
    }
    return stress;
  }

  it("a fully-equipped household holds stress ~flat", () => {
    // Needs served within ~30 s of firing (a walk to the table), all day.
    expect(simulate(1 / NEED_FILL_S.hunger, 30, 3600)).toBeLessThan(0.1);
  });

  it("a stripped household CLIMBS toward visible distress", () => {
    // The same day with the need never serviceable.
    expect(simulate(1 / NEED_FILL_S.hunger, null, 3600)).toBeGreaterThan(0.5);
  });

  it("pressure reads only PAST-threshold need levels", () => {
    expect(needPressure([0.2, 0.9])).toBe(0);
    expect(needPressure([0.2, 1.5])).toBeCloseTo(0.5, 9);
  });
});

describe("the LIVELOCK INVARIANT — acquiring rows outrank deposit rows for their type", () => {
  // The observed field bug: an adoption row took food from the chest; the
  // moment it was CARRIED, provision's put-it-away rule fired — and at its old
  // lower priority, adoption lost, so provision banked the unit back into the
  // SAME chest. Take ⇄ deposit, forever (until thirst outranked them both).
  const provision = provisionTemplate("food", 5, 15);
  const adopt: NeedTemplate = {
    key: "adopt:pet_0_0|hunger:food",
    item: { category: "food" },
    drive: { kind: "stock", container: "recipient", below: 1 },
    satisfy: { kind: "deposit", container: "recipient", upTo: 1 },
    acquire: [{ kind: "container", role: "home" }, { kind: "source" }],
    priority: 3.5, // MUST sit above provision's 3 (see needFires' invariant note)
  };
  // The house state that produced the spin: pantry stocked ABOVE the surplus
  // buffer (provision's own drive idle), the pet's bowl empty.
  const ctxFor = (carried: number) => (tpl: NeedTemplate): NeedCtx => ({
    ...empty,
    carried,
    containers: {
      home: stock("furn_149_chest_food", 9, 6),
      ...(tpl.key.startsWith("adopt:") ? { recipient: stock("bowl", 0, 2) } : {}),
    },
    sources: [stock("store:food", 8)],
  });

  it("empty-handed: only the adoption row fires (provision's stock is fine)", () => {
    const d = decideNeeds([provision, adopt], ctxFor(0));
    expect(d?.tpl.key).toBe(adopt.key);
    expect(d?.intent).toEqual({ kind: "take", from: stock("furn_149_chest_food", 9, 6), units: 1 });
  });

  it("carrying the taken unit: adoption KEEPS it — the bowl gets fed, not the chest", () => {
    const d = decideNeeds([provision, adopt], ctxFor(1));
    expect(d?.tpl.key).toBe(adopt.key);
    expect(d?.intent).toEqual({ kind: "deposit", into: stock("bowl", 0, 2), units: 1 });
  });

  it("the OLD priority (2.5) reproduces the spin — provision hijacks the carried unit", () => {
    const old = { ...adopt, priority: 2.5 };
    const d = decideNeeds([provision, old], ctxFor(1));
    expect(d?.tpl.key).toBe("provision:food"); // banks it right back — the bug
    expect(d?.intent).toEqual({ kind: "deposit", into: stock("furn_149_chest_food", 9, 6), units: 1 });
  });

  it("bowl filled: the adoption row goes idle — no refill churn", () => {
    const filled = (tpl: NeedTemplate): NeedCtx => ({
      ...empty,
      containers: {
        home: stock("furn_149_chest_food", 8, 7),
        ...(tpl.key.startsWith("adopt:") ? { recipient: stock("bowl", 1, 1) } : {}),
      },
      sources: [stock("store:food", 8)],
    });
    expect(decideNeeds([provision, adopt], filled)).toBeNull();
  });
});

// ── Round 3 (creature-behavior-brainstorming.md V1 "wearing clothes"): garments
// as items over the `equip` + `transform` elemental shapes — the dress / laundry /
// stow chain, and its own livelock-invariant check.

import {
  dressTemplate,
  laundryTemplate,
  stowTemplate,
} from "@shared/world-engine/interaction/behavior/needs.js";

describe("round-3 clothing — dress (equip), laundry (transform), stow", () => {
  const dress = dressTemplate(1 / NEED_FILL_S.dirt);
  const laundry = laundryTemplate();
  const stow = stowTemplate("clothing", 8);
  const tub: StationCandidate = { id: "furn_7_bath", place: P("furn_7_bath"), kind: "bath", waiting: 0 };
  const looseUnit = (id: string, units = 1): StockCandidate => ({ id, place: P(id), units });

  it("worn clothes fresh → idle, whatever the wardrobe holds", () => {
    expect(decideNeed(dress, { ...empty, meter: 0.4, containers: { home: stock("wardrobe", 4) } }))
      .toEqual({ kind: "idle" });
  });
  it("dirt at threshold → take a clean garment from the wardrobe (else buy one)", () => {
    const ctx = { ...empty, meter: 1, containers: { home: stock("wardrobe", 4) }, sources: [stock("store:clothing", 6)] };
    expect(decideNeed(dress, ctx)).toEqual({ kind: "take", from: stock("wardrobe", 4), units: 1 });
    const bare = { ...empty, meter: 1, containers: { home: stock("wardrobe", 0) }, sources: [stock("store:clothing", 6)] };
    expect(decideNeed(dress, bare)).toEqual({ kind: "take", from: stock("store:clothing", 6), units: 1 });
  });
  it("clean garment in hand → EQUIP where you stand (the change of clothes)", () => {
    expect(decideNeed(dress, { ...empty, meter: 1, carried: 1 })).toEqual({ kind: "equipHere" });
  });
  it("nothing clean anywhere → blocked (the want surfaces — never 'wear nothing')", () => {
    expect(decideNeed(dress, { ...empty, meter: 1 })).toEqual({ kind: "blocked" });
  });

  it("laundry fires on a CARRIED dirty garment (the just-doffed one) → to the tub", () => {
    expect(decideNeed(laundry, { ...empty, carried: 1, stations: [tub] }))
      .toEqual({ kind: "processAt", station: tub });
  });
  it("the tub is REQUIRED: carrying dirty clothes with no bath → blocked", () => {
    expect(decideNeed(laundry, { ...empty, carried: 1 })).toEqual({ kind: "blocked" });
  });
  it("dirty garments lying/banked (listed loose) → fetch one first", () => {
    const ctx = { ...empty, stations: [tub], loose: [looseUnit("small:shirt.dirty")] };
    expect(decideNeed(laundry, ctx)).toEqual({ kind: "take", from: looseUnit("small:shirt.dirty"), units: 1 });
  });
  it("no dirty clothes anywhere → idle", () => {
    expect(decideNeed(laundry, { ...empty, stations: [tub] })).toEqual({ kind: "idle" });
  });

  it("stow banks a carried clean garment in the wardrobe (the washed one, a gift)", () => {
    expect(decideNeed(stow, { ...empty, carried: 1, containers: { home: stock("wardrobe", 3, 5) } }))
      .toEqual({ kind: "deposit", into: stock("wardrobe", 3, 5), units: 1 });
  });
  it("stow also sweeps a clean garment off the floor (tidy skips clothing heads)", () => {
    const ctx = { ...empty, containers: { home: stock("wardrobe", 3, 5) }, loose: [looseUnit("small:shirt")] };
    expect(decideNeed(stow, ctx)).toEqual({ kind: "take", from: looseUnit("small:shirt"), units: 1 });
  });

  it("THE CHAIN, walker-side: dress equips → laundry tubs the doffed unit → stow banks the washed one", () => {
    const tpls = [dress, laundry, stow];
    // 1. Dirt fired; a clean shirt waits in the wardrobe: dress (3.2) outranks
    //    the deposit-shaped rows — the LIVELOCK INVARIANT for clothing.
    const fetch = decideNeeds(tpls, (tpl) =>
      tpl.key === "dress"
        ? { ...empty, meter: 1, containers: { home: stock("wardrobe", 2, 6) } }
        : { ...empty, containers: { home: stock("wardrobe", 2, 6) } });
    expect(fetch?.tpl.key).toBe("dress");
    // 2. Clean shirt now in hand (dress still fired): equip, not stow's deposit.
    const change = decideNeeds(tpls, (tpl) =>
      tpl.key === "dress"
        ? { ...empty, meter: 1, carried: 1 }
        : tpl.key === "stow:clothing"
          ? { ...empty, carried: 1, containers: { home: stock("wardrobe", 1, 7) } }
          : { ...empty, stations: [tub] });
    expect(change?.tpl.key).toBe("dress");
    expect(change?.intent).toEqual({ kind: "equipHere" });
    // 3. After the equip the hand holds the DOFFED DIRTY garment — a laundry-typed
    //    unit, so only the laundry row fires: to the tub.
    const wash = decideNeeds(tpls, (tpl) =>
      tpl.key === "laundry" ? { ...empty, carried: 1, stations: [tub] } : { ...empty });
    expect(wash?.tpl.key).toBe("laundry");
    expect(wash?.intent).toEqual({ kind: "processAt", station: tub });
    // 4. The wash's TYPE CHANGE hands off: the clean unit fires stow, which
    //    banks it in the wardrobe. No row ever fights another for the unit.
    const bank = decideNeeds(tpls, (tpl) =>
      tpl.key === "stow:clothing"
        ? { ...empty, carried: 1, containers: { home: stock("wardrobe", 1, 7) } }
        : { ...empty });
    expect(bank?.tpl.key).toBe("stow:clothing");
    expect(bank?.intent).toEqual({ kind: "deposit", into: stock("wardrobe", 1, 7), units: 1 });
  });

  it("LIVELOCK INVARIANT: dress (3.2) outranks stow (2.8) and provision:clothing (3)", () => {
    const provisionClothing = provisionTemplate("clothing", 3, 8);
    expect(dress.priority).toBeGreaterThan(stow.priority);
    expect(dress.priority).toBeGreaterThan(provisionClothing.priority);
    // And the walker-level proof: carrying a clean garment with dirt fired —
    // the equip wins over both deposit rows.
    const d = decideNeeds([stow, provisionClothing, dress], (tpl) =>
      tpl.key === "dress"
        ? { ...empty, meter: 1, carried: 1 }
        : { ...empty, carried: 1, containers: { home: stock("wardrobe", 1, 7) } });
    expect(d?.tpl.key).toBe("dress");
    expect(d?.intent).toEqual({ kind: "equipHere" });
  });
});

// ── The MEAL CHAIN, now RITUAL-paced (cook = a transform at the stove; prep =
// the put-away row that lays the place; hunger eats what waits). The laundry
// chain's mirror, so the same seams are tested: the type change as handoff, the
// station-required block, and the LIVELOCK INVARIANT.
//
// ⚠️ The BILL replaces the old table cap. `below`/`upTo` here is one portion
// per head coming to a declared ritual, not a shelf the household must keep
// topped up forever — so a `ritual` container with no live event resolves to
// nothing and neither row fires at all. Two heads = a bill of 2.
import { cookTemplate, ritualPrepTemplate } from "@shared/world-engine/interaction/behavior/needs.js";

describe("the meal chain — cook (transform at the stove), prep (lay the place)", () => {
  const cook = cookTemplate("food", "meal", 2);
  const prep = ritualPrepTemplate("meal", 2);
  const stove: StationCandidate = { id: "oven", place: P("oven"), kind: "oven", waiting: 0 };

  it("a bill nothing has filled fires the cook: take ONE raw unit from the pantry first", () => {
    const ctx = {
      ...empty,
      containers: { ritual: stock("table", 0, 2), home: stock("pantry", 4) },
      stations: [stove],
    };
    expect(decideNeed(cook, ctx)).toEqual({ kind: "take", from: stock("pantry", 4), units: 1 });
  });
  it("pantry dry → the cook BUYS raw at the market (the acquire fall-through)", () => {
    const ctx = {
      ...empty,
      containers: { ritual: stock("table", 0, 2), home: stock("pantry", 0) },
      sources: [stock("store", 5)],
      stations: [stove],
    };
    expect(decideNeed(cook, ctx)).toEqual({ kind: "take", from: stock("store", 5), units: 1 });
  });
  it("carrying raw → process it at the stove", () => {
    const ctx = { ...empty, carried: 1, containers: { ritual: stock("table", 0, 2) }, stations: [stove] };
    expect(decideNeed(cook, ctx)).toEqual({ kind: "processAt", station: stove });
  });
  it("NO STOVE: blocked with EMPTY hands — never fetch what can't be processed", () => {
    // (The transform checks its station BEFORE acquiring — a stove-less house's
    // cook doesn't stand holding an apple.)
    const ctx = { ...empty, containers: { ritual: stock("table", 0, 2), home: stock("pantry", 4) } };
    expect(decideNeed(cook, ctx)).toEqual({ kind: "blocked" });
  });
  it("NO RITUAL: the role resolves to nothing, so the cook row never fires at all", () => {
    // The whole point of the change: with no declared event there is no bill,
    // so nobody cooks "to keep the table stocked". A missing container reads as
    // empty ⇒ the drive fires ⇒ but acquisition has nowhere to deliver, and the
    // row blocks instead of running a standing larder errand.
    const ctx = { ...empty, containers: { home: stock("pantry", 4) }, stations: [stove] };
    expect(decideNeed(cook, ctx)).toEqual({ kind: "take", from: stock("pantry", 4), units: 1 });
    // …and the prep row, with nowhere to lay a place, blocks rather than banking.
    expect(decideNeed(prep, { ...empty, carried: 1 })).toEqual({ kind: "blocked" });
  });
  it("THE BRAKE: the just-cooked meal in hand counts toward the drive (carriedOf)", () => {
    // Bill 2, place 0 + 1 meal in hand + 1 more needed → still fires…
    const oneShy = {
      ...empty, carriedOf: 1, containers: { ritual: stock("table", 0, 2), home: stock("pantry", 4) },
      stations: [stove],
    };
    expect(needFires(cook, oneShy)).toBe(true);
    // …but 1 laid + 1 in hand = the bill → the drive stops; prep's turn.
    const enough = {
      ...empty, carriedOf: 1, containers: { ritual: stock("table", 1, 1), home: stock("pantry", 4) },
      stations: [stove],
    };
    expect(decideNeed(cook, enough)).toEqual({ kind: "idle" });
  });
  it("prep lays the carried meal (and a gift, and a floor meal via loose)", () => {
    expect(decideNeed(prep, { ...empty, carried: 1, containers: { ritual: stock("table", 0, 2) } }))
      .toEqual({ kind: "deposit", into: stock("table", 0, 2), units: 1 });
    const floor = { ...empty, loose: [stock("small:apple.hot", 1)], containers: { ritual: stock("table", 0, 2) } };
    expect(decideNeed(prep, floor)).toEqual({ kind: "take", from: stock("small:apple.hot", 1), units: 1 });
  });
  it("a FILLED bill BLOCKS the prep row (no room) — the meal stays in hand and the want surfaces", () => {
    // A deposit with nowhere to go is a surfaced want, not contentment. The
    // meal stays in hand (a blocked row banks nothing), where the next hunger
    // firing eats it.
    expect(decideNeed(prep, { ...empty, carried: 1, containers: { ritual: stock("table", 2, 0) } }))
      .toEqual({ kind: "blocked" });
  });

  it("LIVELOCK INVARIANT: cook (3.3) outranks provision:food (3), sits under adoption (3.5)", () => {
    const provisionFood = provisionTemplate("food", 5, 15);
    expect(cook.priority).toBeGreaterThan(provisionFood.priority);
    expect(cook.priority).toBeLessThan(3.5);
    // Walker-level proof: the cook carrying its raw apple beats the deposit
    // row — the unit reaches the stove, never banks back into the pantry.
    const d = decideNeeds([provisionFood, cook], (tpl) =>
      tpl.key === "cook:food"
        ? { ...empty, carried: 1, containers: { ritual: stock("table", 0, 2) }, stations: [stove] }
        : { ...empty, carried: 1, containers: { home: stock("pantry", 9, 6) } });
    expect(d?.tpl.key).toBe("cook:food");
    expect(d?.intent).toEqual({ kind: "processAt", station: stove });
  });

  it("THE CHAIN, walker-side: cook takes raw → stove → the TYPE CHANGE hands to prep → the place", () => {
    const tpls = [cook, prep];
    // 1. Bill unfilled: cook fetches raw.
    const fetch = decideNeeds(tpls, (tpl) =>
      tpl.key === "cook:food"
        ? { ...empty, containers: { ritual: stock("table", 0, 2), home: stock("pantry", 3) }, stations: [stove] }
        : { ...empty, containers: { ritual: stock("table", 0, 2) } });
    expect(fetch?.tpl.key).toBe("cook:food");
    expect(fetch?.intent).toEqual({ kind: "take", from: stock("pantry", 3), units: 1 });
    // 2. Raw in hand: to the stove (cook still outranks prep — prep sees no meal).
    const toStove = decideNeeds(tpls, (tpl) =>
      tpl.key === "cook:food"
        ? { ...empty, carried: 1, containers: { ritual: stock("table", 0, 2) }, stations: [stove] }
        : { ...empty, containers: { ritual: stock("table", 0, 2) } });
    expect(toStove?.intent).toEqual({ kind: "processAt", station: stove });
    // 3. Cooked: the unit is a MEAL now — cook's carried (raw) is 0 but its
    //    carriedOf (meal) brakes the drive when the bill is met; prep's
    //    carried (meal) is 1 → the deposit walks it to the place.
    const toTable = decideNeeds(tpls, (tpl) =>
      tpl.key === "cook:food"
        ? { ...empty, carriedOf: 1, containers: { ritual: stock("table", 1, 1), home: stock("pantry", 3) }, stations: [stove] }
        : { ...empty, carried: 1, containers: { ritual: stock("table", 1, 1) } });
    expect(toTable?.tpl.key).toBe("prep:meal");
    expect(toTable?.intent).toEqual({ kind: "deposit", into: stock("table", 1, 1), units: 1 });
    // 4. Bill met: both rows idle — equilibrium, no spin, and no standing
    //    obligation to cook more once the heads are fed.
    expect(decideNeeds(tpls, () => ({ ...empty, containers: { ritual: stock("table", 2, 0) }, stations: [stove] })))
      .toBeNull();
  });
});

// ── A BLOCKED ROW MUST NOT SHADOW A SERVABLE ONE ───────────────────────────
//
// The reported field bug: "creatures get stuck with the debugger showing
// BLOCKED / can't be served here, and they just stand there doing nothing —
// even when the need could be served anywhere, like playing."
//
// `blocked` is a FIRING intent, so ranking it against the actionable rows let
// ONE unservable row silence everything beneath it. Orrin holding a meal with
// a full (or missing) place blocked the prep row at 2.8 — which outranks fun (1)
// and tidy (1.2), so he never played, never tidied, and never re-decided into
// anything else. Nothing about standing still un-blocks a block, so it lasted
// the rest of the session.
describe("blocked rows surface WITHOUT freezing the body", () => {
  const prep = ritualPrepTemplate("meal", 2);
  const fun = funTemplate(1 / NEED_FILL_S.fun);

  it("a blocked HIGH row lets a servable LOW row act — and still reports the want", () => {
    const pick = decideNeeds([prep, fun], (t) =>
      t.key === "fun"
        ? { ...empty, meter: 1, carried: 1 }                                   // toy in hand → playable
        : { ...empty, carried: 1, containers: { ritual: stock("table", 2, 0) } }); // bill FULL → blocked
    // It PLAYS…
    expect(pick?.tpl.key).toBe("fun");
    expect(pick?.intent).toEqual({ kind: "setOutHere" });
    // …and the unmet want is still surfaced for adoption / the beg bubble.
    expect(pick?.blocked?.tpl.key).toBe("prep:meal");
    expect(pick?.blocked?.intent).toEqual({ kind: "blocked" });
  });

  it("nothing servable → the blocked row IS the decision (the genuinely stuck body)", () => {
    const pick = decideNeeds([prep, fun], (t) =>
      t.key === "fun"
        ? { ...empty, meter: 0 }                                               // not firing
        : { ...empty, carried: 1, containers: { ritual: stock("table", 2, 0) } });
    expect(pick?.tpl.key).toBe("prep:meal");
    expect(pick?.intent).toEqual({ kind: "blocked" });
    expect(pick?.blocked?.tpl.key).toBe("prep:meal");
  });

  it("the surfaced want is the TOP blocked row, not merely the last one seen", () => {
    // Lonely with nobody home (social, 2) and a meal with nowhere to go
    // (prep, 2.8): the housemates' adoption rows must read the higher want.
    const social = socialTemplate(1 / NEED_FILL_S.social);
    const pick = decideNeeds([social, prep], (t) =>
      t.key === "social"
        ? { ...empty, meter: 1 }                                               // alone → blocked
        : { ...empty, carried: 1, containers: { ritual: stock("table", 2, 0) } });
    expect(pick?.blocked?.tpl.key).toBe("prep:meal");
    expect(prep.priority).toBeGreaterThan(social.priority);
  });

  it("no blocked row at all → no `blocked` field (the ordinary case stays clean)", () => {
    const pick = decideNeeds([prep, fun], (t) =>
      t.key === "fun"
        ? { ...empty, meter: 1, carried: 1 }
        : { ...empty, carried: 1, containers: { ritual: stock("table", 0, 2) } });
    expect(pick?.tpl.key).toBe("prep:meal"); // 2.8 > 1 — an ACTIONABLE row still wins on priority
    expect(pick?.blocked).toBeUndefined();
  });
});

// ── THE BANKING PRIORITY (the famine-trap fix) ─────────────────────────────
//
// Observed: a body drew a restock-sized water haul at the well, drank one, and
// the leftover rode its bag for sim-minutes — every decide, a rest-family
// motive (energy's 384 s sleep) outranked provision's 3, so the barrel never
// filled and the household kept trekking to the well one throat at a time.
// A deposit fired by the PUT-IT-AWAY rule (units already in hand) now banks at
// BANK_PRIORITY, floored under any same-category acquirer on the member (the
// livelock invariant, enforced structurally instead of by hand-tuned numbers).
import { BANK_PRIORITY, energyTemplate as energyTpl } from "@shared/world-engine/interaction/behavior/needs.js";

describe("banking a carried haul outranks comfort, never the acquirers", () => {
  const provisionWater: NeedTemplate = {
    key: "provision:water",
    item: { category: "water" },
    drive: { kind: "stock", container: "home", below: 6 },
    satisfy: { kind: "deposit", container: "home", upTo: 12 },
    acquire: [{ kind: "source" }],
    priority: 3,
    exclusive: true,
  };
  const energyRow = energyTpl(1 / NEED_FILL_S.energy);
  const bed: StationCandidate = { id: "bed_0", place: P("bed_0"), kind: "bed", waiting: 0 };

  it("the well haul banks BEFORE the nap (the barrel finally fills)", () => {
    const pick = decideNeeds([energyRow, provisionWater], (t) =>
      t.key === "energy"
        ? { ...empty, meter: 1, stations: [bed] }              // dog-tired — the old winner
        : { ...empty, carried: 4, containers: { home: stock("barrel", 0, 12) } });
    expect(pick?.tpl.key).toBe("provision:water");
    expect(pick?.intent).toEqual({ kind: "deposit", into: stock("barrel", 0, 12), units: 4 });
  });

  it("the TRIP keeps its low priority — comfort still beats a shopping chore", () => {
    const pick = decideNeeds([energyRow, provisionWater], (t) =>
      t.key === "energy"
        ? { ...empty, meter: 1, stations: [bed] }
        : { ...empty, containers: { home: stock("barrel", 0, 12) }, sources: [stock("well", 99)] });
    expect(pick?.tpl.key).toBe("energy"); // empty-handed: no boost, 4 > 3
  });

  it("hunger/thirst still outrank the bank — a starving hauler serves itself first", () => {
    expect(BANK_PRIORITY).toBeLessThan(hunger.priority);
    expect(BANK_PRIORITY).toBeLessThan(4.8); // thirst
    expect(BANK_PRIORITY).toBeLessThan(4.5); // waste — the toilet doesn't wait
    expect(BANK_PRIORITY).toBeGreaterThan(energyRow.priority);
  });

  it("LIVELOCK INVARIANT survives the boost: adoption's carried unit is never hijacked", () => {
    // The adoption row ACQUIRES food (3.5); provision:food's bank must floor
    // UNDER it, or the boost re-opens the take⇄deposit spin the invariant
    // section pins above. Same house state as that suite's ctxFor(1).
    const provisionFood = provisionTemplate("food", 5, 15);
    const adopt: NeedTemplate = {
      key: "adopt:pet_0_0|hunger:food",
      item: { category: "food" },
      drive: { kind: "stock", container: "recipient", below: 1 },
      satisfy: { kind: "deposit", container: "recipient", upTo: 1 },
      acquire: [{ kind: "container", role: "home" }, { kind: "source" }],
      priority: 3.5,
    };
    const d = decideNeeds([provisionFood, adopt], (tpl) => ({
      ...empty,
      carried: 1,
      containers: {
        home: stock("furn_149_chest_food", 9, 6),
        ...(tpl.key.startsWith("adopt:") ? { recipient: stock("bowl", 0, 2) } : {}),
      },
      sources: [stock("store:food", 8)],
    }));
    expect(d?.tpl.key).toBe(adopt.key); // the bowl gets fed, not the chest
  });
});

// ── Outstanding-bugs round (family mode): THE STOCKPILE RULE, the CARRY BOUND
// and the HOUSEHOLD CLAIM. The reported bug: "when food or water is gone, they
// will travel to get them one at a time, returning to eat them at the table.
// This takes up almost all of their time."
describe("the STOCKPILE rule — a trip to a source fills up, the pantry does not", () => {
  it("hungry, pantry empty, market reachable → buy the whole RESTOCK target, not one bite", () => {
    const ctx: NeedCtx = {
      ...empty,
      meter: 1,
      containers: { home: stock("pantry", 0, 12) },
      sources: [stock("store", 8)],
      restock: 6,
      room: 6,
    };
    // The old behaviour was `units: 1` — one apple per round trip, forever.
    expect(decideNeed(hunger, ctx)).toEqual({ kind: "take", from: stock("store", 8), units: 6 });
  });
  it("taking from your OWN pantry stays at one — it is already home", () => {
    const ctx: NeedCtx = {
      ...empty,
      meter: 1,
      containers: { home: stock("pantry", 9, 6) },
      sources: [stock("store", 8)],
      restock: 6,
      room: 6,
    };
    expect(decideNeed(hunger, ctx)).toEqual({ kind: "take", from: stock("pantry", 9, 6), units: 1 });
  });
  it("the shelf bounds the haul — you cannot buy more than the market has", () => {
    const ctx: NeedCtx = {
      ...empty, meter: 1, containers: {}, sources: [stock("store", 2)], restock: 6, room: 6,
    };
    expect(decideNeed(hunger, ctx)).toEqual({ kind: "take", from: stock("store", 2), units: 2 });
  });
  it("the BAG bounds the haul — a bounded inventory is a bounded shopping trip", () => {
    const ctx: NeedCtx = {
      ...empty, meter: 1, containers: {}, sources: [stock("store", 9)], restock: 6, room: 2,
    };
    expect(decideNeed(hunger, ctx)).toEqual({ kind: "take", from: stock("store", 9), units: 2 });
  });
  it("a FULL bag: flag OFF still takes the one unit it came for (the anti-spin floor)", () => {
    // THE SHIPPED FLOOR, kept as the kill-switch's behaviour: `takeUnits`
    // never rounds down to 0, because a 0-unit take would fire → move nothing
    // → fire again. Step ④ replaces the floor rather than deleting it — see
    // the flag-ON twin in the "COSTS IN THE PLANNER" block below.
    const ctx: NeedCtx = {
      ...empty, meter: 1, containers: {}, sources: [stock("store", 9)], restock: 6, room: 0,
    };
    expect(decideNeed(hunger, ctx, { costSelection: false }))
      .toEqual({ kind: "take", from: stock("store", 9), units: 1 });
  });
  it("no restock target (a headless caller that models no household) → the old single unit", () => {
    const ctx: NeedCtx = { ...empty, meter: 1, containers: {}, sources: [stock("store", 9)] };
    expect(decideNeed(hunger, ctx)).toEqual({ kind: "take", from: stock("store", 9), units: 1 });
  });
  it("the restock row is capped by the bag too — the rest fires again next trip", () => {
    const ctx: NeedCtx = {
      ...empty, carried: 0, containers: { home: stock("pantry", 0, 15) }, sources: [stock("store", 20)], room: 4,
    };
    expect(decideNeed(provision, ctx)).toEqual({ kind: "take", from: stock("store", 20), units: 4 });
  });
});

describe("the HOUSEHOLD CLAIM — an empty pantry sends ONE shopper, not the family", () => {
  const shared = { ...provision, exclusive: true } as const;
  it("unclaimed / held by SELF → the trip goes ahead", () => {
    const ctx: NeedCtx = { ...empty, containers: { home: stock("pantry", 0, 15) }, sources: [stock("store", 9)] };
    expect(decideNeed(shared, ctx).kind).toBe("take");
    expect(decideNeed(shared, { ...ctx, claimed: "self" }).kind).toBe("take");
  });
  it("claimed by a HOUSEMATE → this body stands down (no second shopper)", () => {
    const ctx: NeedCtx = {
      ...empty, containers: { home: stock("pantry", 0, 15) }, sources: [stock("store", 9)], claimed: "other",
    };
    expect(decideNeed(shared, ctx)).toEqual({ kind: "idle" });
  });
  it("⚠️ the claim gates the TRIP ONLY — a body already CARRYING always banks its load", () => {
    // Otherwise an unclaimed hauler stands holding the groceries forever
    // (the §4 "carries it around forever" bug through the back door).
    const ctx: NeedCtx = {
      ...empty, carried: 3, containers: { home: stock("pantry", 2, 13) }, claimed: "other",
    };
    expect(decideNeed(shared, ctx)).toEqual({ kind: "deposit", into: stock("pantry", 2, 13), units: 3 });
  });
  it("a NON-exclusive row ignores the claim entirely", () => {
    const ctx: NeedCtx = {
      ...empty, containers: { home: stock("pantry", 0, 15) }, sources: [stock("store", 9)], claimed: "other",
    };
    expect(decideNeed(provision, ctx).kind).toBe("take");
  });
});

describe("UNLOAD — a high priority to empty your hands, without a livelock", () => {
  const unload = unloadTemplate();
  it("holding an orphan unit → put it away (the deposit-while-carrying rule)", () => {
    const ctx: NeedCtx = { ...empty, carried: 1, containers: { storage: stock("box", 0, 9) } };
    expect(decideNeed(unload, ctx)).toEqual({ kind: "deposit", into: stock("box", 0, 9), units: 1 });
  });
  it("empty-handed → idle: it is not a chore, it is a hands rule", () => {
    expect(decideNeed(unload, { ...empty, containers: { storage: stock("box", 0, 9) } }))
      .toEqual({ kind: "idle" });
  });
  it("nowhere to put it → PUT IT DOWN, never a silent forever-carry", () => {
    // Superseded the original "blocked" here: blocking means the body keeps
    // holding the thing, which is the bug. Setting it down is always available.
    expect(decideNeed(unload, { ...empty, carried: 1 })).toEqual({ kind: "dropHere", units: 1 });
  });
  it("⚠️ STRUCTURALLY livelock-free: no acquire branch, so it can never take", () => {
    expect(unload.acquire).toEqual([]);
    // Even firing with a source and a container in reach, it has nothing to take with.
    const ctx: NeedCtx = { ...empty, carried: 0, containers: { storage: stock("box", 5, 9) }, sources: [stock("store", 9)] };
    expect(decideNeed(unload, ctx)).toEqual({ kind: "idle" });
  });
  it("outranks the motives it should beat, and hunger still beats IT", () => {
    // Hunger (5) > unload (4.6): you eat the apple in your hand rather than
    // filing it. But unload > energy (4): you put the thing down before bed.
    expect(unload.priority).toBeLessThan(hunger.priority);
    expect(unload.priority).toBeGreaterThan(energyTemplate(1).priority);
  });
});

// A body must ALWAYS be able to end a carry (playtest: "objects created in the
// world spec never get dropped or put away - someone picks them up and just
// carries them forever"; the dog takes the apple and never puts it down).
// Putting a thing DOWN is the second honest answer to "get rid of it", and the
// only one available to a body that cannot open a container.
describe("the DROP fallback - a graspless body can still end a carry", () => {
  const unload = unloadTemplate();
  it("no container at all -> put it down where you stand, NOT blocked", () => {
    const ctx: NeedCtx = { ...empty, carried: 1 };
    expect(decideNeed(unload, ctx)).toEqual({ kind: "dropHere", units: 1 });
  });
  it("a FULL container -> put it down rather than hold it forever", () => {
    const ctx: NeedCtx = { ...empty, carried: 2, containers: { storage: stock("box", 9, 0) } };
    expect(decideNeed(unload, ctx)).toEqual({ kind: "dropHere", units: 2 });
  });
  it("a container with room still wins - storing beats dropping", () => {
    const ctx: NeedCtx = { ...empty, carried: 2, containers: { storage: stock("box", 0, 9) } };
    expect(decideNeed(unload, ctx)).toEqual({ kind: "deposit", into: stock("box", 0, 9), units: 2 });
  });
  it("a row WITHOUT orDrop still blocks (the drop is opt-in, not universal)", () => {
    const noDrop = { ...unload, satisfy: { kind: "deposit" as const, container: "storage", upTo: 99 } };
    expect(decideNeed(noDrop, { ...empty, carried: 1 })).toEqual({ kind: "blocked" });
  });
});

describe("never pick up what you have nowhere to put - the loop guard", () => {
  it("empty-handed with NO destination -> blocked, never a pointless pickup", () => {
    // Without this, a tidier lifts the clutter, fails to deposit, a drop-capable
    // row sets it down, and the pair loop over the same object forever.
    const tidy = tidyTemplate();
    const ctx: NeedCtx = { ...empty, carried: 0, loose: [stock("ball", 1)] };
    expect(decideNeed(tidy, ctx)).toEqual({ kind: "blocked" });
  });
  it("with a destination it picks up as before", () => {
    const tidy = tidyTemplate();
    const ctx: NeedCtx = { ...empty, carried: 0, loose: [stock("ball", 1)], containers: { storage: stock("box", 0, 9) } };
    expect(decideNeed(tidy, ctx)).toEqual({ kind: "take", from: stock("ball", 1), units: 1 });
  });
});
