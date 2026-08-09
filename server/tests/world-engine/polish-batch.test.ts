// THE POLISH BATCH — civic-labor-and-polish.md §4 (wording) + §5 (hover-resume)
//
// Three defects the /why instrument surfaced, and one the user reported by
// hand. Each is a place where the engine told the truth in the wrong words, or
// answered a gesture with nothing:
//
//  §4.1 "I will carry the door to the door." The `to` PlaceRef on a pooled
//       TRANSFER goal is WORDING ONLY (the haul runs off the agreement's
//       endpoint), and both call sites that filled it for a shell's furniture
//       delivery derived it from the CARGO. With a door in the goods the object
//       and the destination became the same word.
//  §4.2 "I rest… because I need toilet." The waste row satisfies with a rest
//       dwell at a toilet, and `goalActivity`'s rest arm answered "rest" — while
//       its twin `goalIntentLine` and the legacy `stepActivity`/`NEED_ACTIVITY`
//       path had always read the same row as a trip to the bathroom.
//  §5   Looking back at the person you are talking to did NOTHING. Every other
//       hover replaces the board; that cell is deliberately silent, so after a
//       glance at a chest the conversation board never came back.
//
// Pure logic — no DOM / GL / DB.

import { describe, it, expect } from "@jest/globals";
import {
  goalActivity,
  goalIntentLine,
  NEED_ACTIVITY,
  type IntentLineSyms,
} from "@shared/world-engine/interaction/dialogue/intent-lines.js";
import { stepActivity } from "@shared/world-engine/interaction/dialogue/going.js";
import { spokenWord } from "@shared/world-engine/interaction/content/makeable.js";
import { furnitureGlyph } from "@shared/world-engine/kernel/town/stations.js";
import {
  dwellInteraction,
  type DwellContext,
  type HoverTarget,
} from "@shared/world-engine/interaction/quest/dwell-interaction.js";
import { createConstructionDirector, type ConstructionDirectorCtx } from "@shared/world-engine/interaction/quest/construction-director.js";
import { buildTownPlay } from "@shared/world-engine/interaction/town/town-play.js";
import { workDeltaKey } from "@shared/world-engine/kernel/town/construction.js";
import type { QuestSession } from "@shared/world-engine/interaction/quest/quest-host.js";
import type { GoalSpec } from "@shared/world-engine/interaction/behavior/rules.js";

// ─────────────────────────────────────────────────────────────────────────
// A bare symbol resolver. The world names things; these tests are about what
// the SENTENCE does with the names, so a named place speaks its own id and an
// item its own glyph — exactly what the host's resolver yields for the ids
// these goals actually carry.
// ─────────────────────────────────────────────────────────────────────────
const syms: IntentLineSyms = {
  item: (ref) => ("id" in ref ? ref.id : (ref.match.kind ?? ref.match.category ?? "thing")),
  place: (p) => (p.kind === "named" ? p.id : p.kind === "home" ? "home" : "there"),
  creature: (id) => id,
};

// ═════════════════════════════════════════════════════════════════════════
// §4.1 — THE DESTINATION IS THE BUILDING, NEVER THE PIECE
// ═════════════════════════════════════════════════════════════════════════

describe("§4.1 the carry-announcement collision", () => {
  /** The haul the shell's door want posts: ONE `furn.door` into the shell. */
  const doorHaul = (dest: string): GoalSpec => ({
    kind: "transfer",
    agreementId: "agr_1",
    goods: { [furnitureGlyph("door")]: 1 },
    to: { kind: "named", id: dest },
  });

  it("REPRODUCES the collision: the piece named twice is 'carry the door to the door'", () => {
    // The exact shape `requestPiece` used to post — `to: {kind:"named", id: k}`
    // with `k` the StationKind. The object comes off the goods
    // (`spokenWord("furn.door")`), the destination off the same word, and the
    // sentence names the door twice.
    expect(spokenWord(furnitureGlyph("door"))).toBe("door");
    const line = goalIntentLine(doorHaul("door"), syms);
    expect(line).not.toBeNull();
    expect(line!.c).toBe("carry + door + to + door");
  });

  it("…and the fix separates them: the SITE word is the destination", () => {
    const line = goalIntentLine(doorHaul("workshop"), syms);
    expect(line!.c).toBe("carry + door + to + workshop");
    // The activity reading agrees — a hauler asked what it is doing says
    // "carrying a door", never "carrying a workshop".
    expect(goalActivity(doorHaul("workshop"), syms)).toEqual({ verb: "carry", object: "door" });
  });

  it("the destination word and the object word are never the same word", () => {
    // The invariant, stated once for every piece a shell can ask for: the
    // sentence has two slots and they must name two things.
    for (const kind of ["door", "bed", "chair", "table", "workbench"] as const) {
      const goal = doorHaul("workshop");
      const g: GoalSpec = { ...goal, goods: { [furnitureGlyph(kind)]: 1 } };
      const line = goalIntentLine(g, syms)!;
      const [obj, dest] = [spokenWord(furnitureGlyph(kind)), "workshop"];
      expect(obj).not.toBe(dest);
      expect(line.c).toBe(`carry + ${obj} + to + ${dest}`);
    }
  });
});

// The director harness (civic-labor-locality.test.ts's, trimmed to what a pure
// plan lookup needs — no world, no avatars, no stock).
function directorHarness() {
  const play = buildTownPlay({ seed: 5, days: 30, questCount: 0, key: "smalltown", startPop: 20 });
  const session = { town: play } as unknown as QuestSession;
  const ctx = {
    presenter: { toast: () => {} },
    familyOf: () => null,
    buildingUnits: () => 0,
    npcChatBubble: () => {},
    spawnLooseProp: () => null,
    removeLooseProp: () => {},
    postPooledTask: () => {},
    stockEndpointOf: () => null,
    containerAnchor: () => null,
    houseContainerKeys: () => [],
    playerWorldPos: () => null,
    playerFocusArea: () => null,
    townShortage: () => 0,
    invalidateTownJobs: () => {},
    questViewOf: () => null,
    spiritFocusOf: () => null,
    convoNodeId: () => null,
  } as unknown as ConstructionDirectorCtx;
  return { play, session, director: createConstructionDirector(ctx) };
}

describe("shellHaulDestWord — a shell's delivery walks toward the BUILDING", () => {
  it("answers the work building's own spoken type, for every work in the plan", () => {
    const { play, session, director } = directorHarness();
    expect(play.plan.works.length).toBeGreaterThan(0);
    play.plan.works.forEach((wk, i) => {
      const word = director.shellHaulDestWord(session, workDeltaKey(wk, i));
      expect(word).toBe(wk.type);
      // …and it is never a piece word — the whole point. A `furn.<kind>` glyph
      // speaks the kind, and no structure type collides with one.
      expect(word).not.toBe(spokenWord(furnitureGlyph("door")));
      expect(word).not.toBe(spokenWord(furnitureGlyph("bed")));
    });
  });

  it("a key that names nothing standing falls back to a WORD, never to a piece", () => {
    const { session, director } = directorHarness();
    expect(director.shellHaulDestWord(session, "w_999")).toBe("building");
    expect(director.shellHaulDestWord(session, "f_999")).toBe("building");
    expect(director.shellHaulDestWord(session, "not-a-key")).toBe("building");
  });
});

// ═════════════════════════════════════════════════════════════════════════
// §4.2 — THE STATION SAYS WHAT THE DWELL IS
// ═════════════════════════════════════════════════════════════════════════

describe("§4.2 the waste row is a trip to the bathroom, not a nap", () => {
  /** What `needPursuitGoals`' `restAt` arm builds for a station row: a rest at
   *  the fixture, carrying NO pose (the pose is only derivable for a dwell in
   *  the open). That absence is why this arm used to answer "rest". */
  const restAt = (station: string): GoalSpec => ({
    kind: "rest",
    place: { kind: "named", id: station },
    dwellS: 20,
  });

  it("the TOILET reads as the bathroom trip — the row's own existing word", () => {
    expect(goalActivity(restAt("toilet"), syms)).toEqual({ verb: "go", object: "bathroom" });
    // …which is `NEED_ACTIVITY.waste` itself, not a second spelling of it
    // (law ④ — no new lexicon anywhere in the chain).
    expect(goalActivity(restAt("toilet"), syms)).toEqual(NEED_ACTIVITY.waste);
    expect(goalActivity(restAt("bathroom"), syms)).toEqual(NEED_ACTIVITY.waste);
  });

  it("agrees with the LEGACY walker's reading of the same row", () => {
    // `wasteTemplate`'s key is `waste`; the legacy step path words it through
    // `NEED_ACTIVITY`. The two engines are the same row seen at two moments and
    // must never explain themselves differently.
    expect(stepActivity({ kind: "rest", tplKey: "waste", goodKey: "" })).toEqual(
      goalActivity(restAt("toilet"), syms),
    );
  });

  it("agrees with the ANNOUNCEMENT of the same goal — one fact, read twice", () => {
    // `goalIntentLine` has always made this fork; only the activity arm was
    // words apart from it. Same station, same verb, in both channels.
    const said = goalIntentLine(restAt("toilet"), syms)!;
    expect(said.c).toBe("i_me + go + to + bathroom");
    expect(goalActivity(restAt("toilet"), syms)!.verb).toBe("go");
  });

  it("the BATH is a wash and the BED is a sleep — the same fork, same words", () => {
    // hygiene → `NEED_ACTIVITY.hygiene`, energy → `NEED_ACTIVITY.energy`: both
    // rows reached this arm with no pose and both read "rest" before.
    expect(goalActivity(restAt("bath"), syms)).toEqual(NEED_ACTIVITY.hygiene);
    expect(goalActivity(restAt("bed"), syms)).toEqual(NEED_ACTIVITY.energy);
  });

  it("anything else is STILL a rest — the fork adds cells, it replaces nothing", () => {
    expect(goalActivity(restAt("chair"), syms)).toEqual({ verb: "rest" });
    expect(goalActivity({ kind: "rest", place: { kind: "point", x: 1, y: 2 } }, syms)).toEqual({
      verb: "rest",
    });
    // An explicit sleep pose still wins wherever the body lies down.
    expect(
      goalActivity({ kind: "rest", place: { kind: "point", x: 1, y: 2 }, pose: "sleep" }, syms),
    ).toEqual({ verb: "sleep" });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// §5 — HOVER-RESUME: THE LOOK BACK IS THE WAY BACK
// ═════════════════════════════════════════════════════════════════════════

const creature = (id: string): HoverTarget => ({ kind: "creature", id, x: 0, y: 0 });
const object = (id: string): HoverTarget => ({ kind: "object", id, x: 0, y: 0 });

describe("§5 re-hovering the partner re-presents the open conversation", () => {
  const talking: DwellContext = { conversingWith: "mara" };
  const boardTaken: DwellContext = { conversingWith: "mara", boardElsewhere: true };

  it("the gesture that STRANDED the child: a glance at a chest takes the board", () => {
    // Both acts fire — the menu opens AND the partner is pointed at the thing —
    // and the menu is what is on screen afterwards.
    expect(dwellInteraction(object("chest_1"), "short", talking)).toEqual([
      { act: "menu", id: "chest_1" },
      { act: "attendObject", cid: "mara", id: "chest_1" },
    ]);
  });

  it("…and looking back at the partner now asks for the conversation back", () => {
    expect(dwellInteraction(creature("mara"), "short", boardTaken)).toEqual([
      { act: "present", id: "mara" },
    ]);
    // Both phases: a re-present is idempotent, and a player whose short rest
    // was spent elsewhere still gets their board back.
    expect(dwellInteraction(creature("mara"), "long", boardTaken)).toEqual([
      { act: "present", id: "mara" },
    ]);
  });

  it("it is NOT an opening — `talk`/`switch` are the acts that greet afresh", () => {
    // The host dispatches on `act`, and `present` must never reach the branch
    // that calls `openCreatureConvo` (which cancels the voice, mints a new
    // convoView — dropping the why-chain depth and any open list menu — and
    // clears convoSyncSeen).
    for (const phase of ["short", "long"] as const) {
      for (const a of dwellInteraction(creature("mara"), phase, boardTaken)) {
        expect(a.act).toBe("present");
        expect(a.act).not.toBe("talk");
        expect(a.act).not.toBe("switch");
      }
    }
    // …and it carries no `join` discriminant: there is nothing to join, this
    // conversation is already ours.
    expect(dwellInteraction(creature("mara"), "short", { ...boardTaken, targetInConversation: true })).toEqual([
      { act: "present", id: "mara" },
    ]);
  });

  it("with the conversation's OWN board up it is silent again — attention, not an instruction", () => {
    expect(dwellInteraction(creature("mara"), "short", talking)).toEqual([]);
    expect(dwellInteraction(creature("mara"), "long", talking)).toEqual([]);
    // Which is also why the cell cannot loop: the host's re-present puts the
    // board back, `boardElsewhere` goes away, and the next dwell says nothing.
  });

  it("the FELLOW MEMBER I am already addressing gets the same way back", () => {
    const circle: DwellContext = {
      conversingWith: "mara",
      members: ["player", "mara", "bram"],
      currentAddressee: "bram",
    };
    expect(dwellInteraction(creature("bram"), "short", circle)).toEqual([]);
    expect(dwellInteraction(creature("bram"), "short", { ...circle, boardElsewhere: true })).toEqual([
      { act: "present", id: "bram" },
    ]);
  });

  it("ABSENCE IS THE OLD TABLE — no other cell changes when the board is elsewhere", () => {
    // The flag narrows exactly one silent cell. Everything else answers as it
    // did, flag or no flag.
    const cells: [HoverTarget, "short" | "long", DwellContext][] = [
      [creature("bram"), "short", { conversingWith: "mara" }],
      [creature("bram"), "long", { conversingWith: "mara" }],
      [creature("bram"), "long", { conversingWith: null }],
      [object("chest_1"), "short", { conversingWith: "mara" }],
      [object("chest_1"), "long", { conversingWith: null }],
      [creature("bram"), "short", { conversingWith: "mara", members: ["player", "mara", "bram"] }],
    ];
    for (const [t, phase, ctx] of cells) {
      expect(dwellInteraction(t, phase, { ...ctx, boardElsewhere: true })).toStrictEqual(
        dwellInteraction(t, phase, ctx),
      );
    }
  });

  it("a hover with NO conversation running is untouched — there is nothing to restore", () => {
    // The host only ever sets the flag when a partner exists, but the table
    // must be honest on its own: with no partner, the silent cell is not
    // reachable and every answer is the old one.
    const none: DwellContext = { conversingWith: null, boardElsewhere: true };
    expect(dwellInteraction(creature("mara"), "short", none)).toEqual([]);
    expect(dwellInteraction(creature("mara"), "long", none)).toEqual([{ act: "talk", id: "mara" }]);
  });
});
