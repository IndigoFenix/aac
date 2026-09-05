// ⚖️ A TREE IS A THING YOU SELECT — AND A PRESS ALWAYS ANSWERS.
//
// User report, 2026-09-03, verbatim: *"selecting trees doesn't seem to work.
// The spark hovers over it, but nothing happens. Selecting rocks DOES work, but
// it just treats them like containers, I think, and selecting the 'stone' that
// is inside the 'rock' doesn't do anything."*
//
// Two defects, one report, and they are two different silences:
//
//   ① THE HOVER LANE. A rooted plant and a walking product animal are AVATARS
//      (`spawnWildFeature`/`seedWilderness` stand them with `addNpc`), so the
//      screen pick answers `kind:"avatar"` and the hover resolver classified
//      them as CREATURES — a lane whose dwell cell is `talk` and whose talk
//      targeter finds no mind on either of them. Zero effect, zero feedback,
//      forever. A rock is an ObjectSpec, never a body, which is the whole
//      reason "selecting rocks DOES work" and selecting a tree never did.
//      🚨 THE INVERSION THAT NAMES THE BUG: a DOWNED tree keeps its container
//      key and becomes an ordinary object — so the same oak that ignored every
//      look while standing selects perfectly once felled.
//   ② THE SILENT PRESS. A spirit has no hands, so a `take:` on a stack is an
//      INSTRUCTION to somebody else (`attendTo`) — and when nobody is within
//      `ATTEND_REACH_M` that gate returned without a word.
//
// WHAT THIS FILE IS. The first test anywhere to press `cut:`/`take:` — the
// diagnosis found none. It drives the REAL host over the shipped frontier
// world through the gaze (`run.look` — the identity screen map makes a world
// point the client pixel, and the text view answers `pickScreen`, so the hover
// that reaches `hoverTargetOf` is the SAME SHAPE GL produces) and then presses
// the board the dwell opened.
//
// ⚠️ WHAT IT CANNOT SEE: the spark's own placement (GL chrome — the flora
// reach cap in render3d has no headless surface) and the EMBODIED take, since
// this world's player is a spirit by document (`avatar: "spirit"`) and
// possession is a conversation away. The wood's takeability after the cut is
// pinned where the board decides it — the option's appearance IS
// `wildGlyphTakeable` saying yes — and at the pure gate in feature-removal.
//
// Run:  npm run test:engine -- wild-body-press

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isNaturalSourceBodyId,
  wildAnimalBodyId,
  wildFeatureContainerId,
  type WildernessFeature,
} from "@shared/world-engine/interaction/quest/wilderness.js";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";

// ── ① THE VOCABULARY OF THE LANE SPLIT (pure) ──────────────────────────────

describe("`isNaturalSourceBodyId` — which bodies are THINGS", () => {
  it("names both natural-source body spellings, and nothing else", () => {
    // The two ids the source layer itself mints, built through its OWN
    // constructors so a change of convention breaks this rather than drifting.
    const oak: WildernessFeature = { id: "wild:oak_3", species: "oak", x: 0, y: 0, stock: { wood: 8 } };
    expect(wildFeatureContainerId(oak)).toBe("flora:oak:wild:oak_3"); // embodied ⇒ the BODY key
    expect(isNaturalSourceBodyId(wildFeatureContainerId(oak))).toBe(true);
    // (`icon` is DISPLAY ONLY and empty for a product animal — its body comes
    // from `species`; the row is built through the real type so a convention
    // change breaks this rather than drifting.)
    expect(
      isNaturalSourceBodyId(wildAnimalBodyId({ id: "c1", icon: "", species: "sheep", x: 0, y: 0 })),
    ).toBe(true);
    // …and everything a session can hover that is a PERSON stays out of it.
    for (const id of [
      "npc_settler_0",
      "resident_3_0",
      "pet_3_0",
      "npc_avatar_p1",
      "wild:rock_1", // an outcrop is a BOX, never a body — it never took this path
      "furn_3_box_0",
      "site:stock",
    ]) {
      expect(isNaturalSourceBodyId(id)).toBe(false);
    }
  });
});

// ── ②–④ THE LIVE SESSION ───────────────────────────────────────────────────

const doc = JSON.parse(readFileSync(join(process.cwd(), "scripts", "worlds", "frontier.spec.json"), "utf8"));

describe("frontier — the gaze reaches a standing tree, and a press always answers", () => {
  let run: TextQuestRun;
  /** Every board the host has pushed, in order (the log keeps only the last). */
  const boards: { kind: string; nodeId?: string; options: string[] }[] = [];
  const toasts: string[] = [];

  beforeAll(() => {
    run = bootTextQuest({ world: doc, seed: 11, dt: 0.5 });
    run.addPresenterTap({
      board: (v) => boards.push({ kind: v.kind, ...(v.nodeId ? { nodeId: v.nodeId } : {}), options: v.options.map((o) => o.id) }),
      toast: (t) => toasts.push(t),
    });
    run.advance(20); // let the streamer stand the residents up
  }, 600_000);

  afterAll(() => run?.dispose());

  /** Every glyph a `char:` bubble is showing — what was SAID (feature-removal's
   *  reader, verbatim: text mode reads speech by diffing the bubbles). */
  const said = (): (string | undefined)[] =>
    Object.entries((run.state as { bubbles?: Record<string, { glyph?: string }> }).bubbles ?? {})
      .filter(([k]) => k.startsWith("char:"))
      .map(([, v]) => v.glyph);

  /** Rest the gaze on a world point until the host's own cursor reports that it
   *  is on `wantId`, then hold long enough for the SHORT dwell (300 ms) to fire.
   *  Returns the board that opened, or null. Throws on a hover that never
   *  lands — a fixture failure, never a finding. */
  const hoverAndOpen = (at: { x: number; y: number }, wantId: string): { kind: string; nodeId?: string; options: string[] } | null => {
    run.clearLook();
    run.advance(2);
    boards.length = 0;
    run.look(at.x, at.y);
    let landed = false;
    for (let i = 0; i < 24 && !landed; i++) {
      run.stepFrame();
      landed = run.view.probe().intent?.cursor?.hoverId === wantId;
    }
    if (!landed) {
      throw new Error(`the gaze never landed on ${wantId} — fixture broken, not a finding`);
    }
    run.advance(4); // the short dwell, plus slack
    return boards.findLast((b) => b.kind === "acts" && b.nodeId === wantId) ?? null;
  };

  // ── ② THE HOVER LANE ─────────────────────────────────────────────────────

  it("🌳 A STANDING OAK IS SELECTABLE — the hover names the THING, not a creature", () => {
    // A probe oak on empty ground, well clear of the settlement: nothing else
    // is within the pick radii, so what the gaze lands on is unambiguous.
    const c = run.session.town!.stage.center;
    const oak: WildernessFeature = {
      id: "probe:hover_oak", species: "oak", x: c.x + 150, y: c.y - 130, stock: { wood: 8 },
    };
    if (!run.host.addWildFeature(oak)) throw new Error("the probe oak would not spawn — fixture broken, not a finding");
    const ep = wildFeatureContainerId(oak);

    // ① IT STANDS AS A BODY — the premise of the whole defect. (An avatar, and
    //    NOT an object: that is what put it in the creature lane.)
    expect(run.state.avatars[ep]).toBeDefined();
    expect(run.state.objects[ep]).toBeUndefined();
    expect(isNaturalSourceBodyId(ep)).toBe(true);

    // ② THE GAZE RESTS ON IT AS AN AVATAR — the GL-shaped hover, reproduced.
    //    This is the input that used to dead-end.
    const board = hoverAndOpen(oak, ep);
    expect(run.view.probe().intent?.cursor?.hoverKind).toBe("avatar");

    // ③ …AND THE BOARD OPENED ANYWAY. The whole fix in one assertion.
    expect(board).not.toBeNull();

    // ④ WHAT IT OFFERS IS THE CUT, AND NOT THE TIMBER (the fell-first ruling —
    //    the wood is real, it is on the far side of this press).
    expect(board!.options).toContain(`cut:${ep}`);
    expect(board!.options).not.toContain("take:wood");
    expect(board!.options).toContain(`attend:${ep}`);
  }, 600_000);

  it("🐑 a PRODUCT ANIMAL opens the same way — livestock is takeable, not talkable", () => {
    // 🚨 DELIBERATELY BOTH PREFIXES. `seedWilderness` says it outright at the
    // spawn — *"No mind: livestock is takeable, not talkable (dialogue would
    // race the container board on the same dwell)"* — so a `fauna:` body was
    // stranded in the creature lane by exactly the same rule, with exactly as
    // little to do there. Its board (wool, milk, the `tame:` claim) reaches the
    // screen through the path the tree's does.
    const beast = run.session.wilderness!.creatures.find((c) => c.species);
    if (!beast) throw new Error("no product animal in the frontier world — fixture broken, not a finding");
    const ep = wildAnimalBodyId(beast);
    const body = run.state.avatars[ep];
    if (!body) throw new Error(`${ep} has no body — fixture broken, not a finding`);
    const board = hoverAndOpen({ x: body.x, y: body.y }, ep);
    expect(board).not.toBeNull();
    // The claim is on it (wild, unowned) — the option that proves this is the
    // ANIMAL's own board and not some neighbouring box's.
    expect(board!.options).toContain(`tame:${ep}`);
  }, 600_000);

  it("🧍 a MINDED body is untouched — the split is stock, not shape", () => {
    // The other half of the predicate, checked where it actually decides: a
    // person has a MIND and no container row; a tree has a container row and no
    // mind. Nothing about "is it an avatar" separates them, which is why the
    // old rule could not.
    const minded = [...(run.session.creatures?.nodeByCreature.keys() ?? [])].filter(
      (cid) => !!run.state.avatars[cid] || !!run.state.avatars[`npc_${cid}`],
    );
    expect(minded.length).toBeGreaterThan(0); // fixture: somebody lives here
    for (const cid of minded) {
      const bodyId = run.state.avatars[cid] ? cid : `npc_${cid}`;
      expect(isNaturalSourceBodyId(bodyId)).toBe(false);
      expect(run.session.containerRecords.get(bodyId)?.relation).toBeUndefined();
    }
    // …and the converse, over every wild body standing in the session: a
    // container row, and no mind anywhere.
    const bodies = Object.keys(run.state.avatars).filter(isNaturalSourceBodyId);
    expect(bodies.length).toBeGreaterThan(0);
    for (const id of bodies) {
      expect(run.session.creatures?.nodeByCreature.has(id) ?? false).toBe(false);
    }
  }, 600_000);

  // ── ③ THE CUT, PRESSED ───────────────────────────────────────────────────

  // ⚖️ RE-SHAPED FOR task #51 item 1d (user ruling 2026-09-04): *"the 'cut
  // command' for trees isn't supposed to destroy the tree when the button is
  // pressed. It should issue a COMMAND to cut that tree. Or, alternatively,
  // DESIGNATE the tree to be cut when available as a task."* This world is the
  // frontier (a town WITH a wilderness scatter), so `pullLaborOn` is TRUE and
  // the press is a designation — the instant fell is pinned where it still
  // lives, off the capability, in feature-removal.test.ts.
  it("🪓 pressing `cut` with nobody near MARKS the tree — it is still standing", () => {
    const oak = run.session.wilderness!.features.find((f) => f.id === "probe:hover_oak");
    if (!oak) throw new Error("the probe oak is gone — fixture broken, not a finding");
    const ep = wildFeatureContainerId(oak);
    const woodBefore = run.session.containerRecords.get(ep)?.stock?.["wood"] ?? 0;
    expect(woodBefore).toBeGreaterThan(0);
    expect(oak.downed).not.toBe(true);
    // FIXTURE CONTROL: the addressee resolver prefers an ENGAGED body, then any
    // idle one within `ATTEND_REACH_M` (16 m). This probe stands 150 m out on
    // empty ground, and the room is emptied of old attention — so there is
    // genuinely nobody to ask, which is the branch this case is about.
    run.session.sparkAttention.clear();
    run.session.sparkEngageHold.clear();
    run.session.lastConvoCid = null;
    const book = run.session.town!.deltas;
    expect(book.fellOrders()).toEqual([]);

    const standing = hoverAndOpen(oak, ep);
    expect(standing!.options).toContain(`cut:${ep}`);
    boards.length = 0;
    run.select(`cut:${ep}`);
    run.advance(2);

    // ① THE TREE IS STILL STANDING — the whole of the ruling in one assertion.
    expect(run.session.wilderness!.features.find((f) => f.id === "probe:hover_oak")!.downed).not.toBe(true);
    // ② …AND THE MARK IS IN THE BOOKS, naming the thing (never the species id)
    //    and carrying a word a ruleset can actually say.
    const mark = book.fellOrders().find((r) => r.featureId === "probe:hover_oak");
    expect(mark).toBeDefined();
    // `wildSourceWord`: an oak has timber to give, so it is a `tree` — the word
    // with lexemes and a picture — never "oak" (and no longer the kind chip
    // `plants`, which is what a bush or an onion patch still gets).
    expect(mark!.word).toBe("tree");
    expect(mark!.spoken).toBe(true); // a child asked for it
    // ③ ⚖️ NO SILENT PRESS — the designation SPEAKS ("ok", the reserved
    //    confirmation of an accepted order).
    expect(said()).toContain("ok");
    // ④ NOTHING MOVED. A mark is not a deed: no unit, no prop, no reservation.
    expect(run.session.containerRecords.get(ep)?.stock?.["wood"] ?? 0).toBe(woodBefore);
    // ⑤ …and the board came back, because the option it offered has flipped.
    expect(boards.findLast((b) => b.kind === "acts" && b.nodeId === ep)).toBeDefined();
  }, 600_000);

  it("🪓 …and pressing it AGAIN takes the mark off (and says so)", () => {
    // A child who marked a tree by mistake must be able to undo it with the
    // same button — a mark is a toggle, and both halves speak.
    const oak = run.session.wilderness!.features.find((f) => f.id === "probe:hover_oak");
    if (!oak) throw new Error("the probe oak is gone — fixture broken, not a finding");
    const ep = wildFeatureContainerId(oak);
    const book = run.session.town!.deltas;
    expect(book.fellOrders().some((r) => r.featureId === "probe:hover_oak")).toBe(true);
    run.session.sparkAttention.clear();
    run.session.sparkEngageHold.clear();
    run.session.lastConvoCid = null;
    hoverAndOpen(oak, ep);
    run.select(`cut:${ep}`);
    run.advance(2);
    expect(book.fellOrders().some((r) => r.featureId === "probe:hover_oak")).toBe(false);
    expect(run.session.wilderness!.features.find((f) => f.id === "probe:hover_oak")!.downed).not.toBe(true);
    expect(said()).toContain("ok");
  }, 600_000);

  // ── ④ THE PRESS THAT USED TO SAY NOTHING ─────────────────────────────────

  it("🔇 a spirit's `take:` with NOBODY in reach SPEAKS a refusal", () => {
    // The spirit has no hands (standing law), so the press is an instruction —
    // and out here there is nobody to take it. Silence was the bug.
    const c = run.session.town!.stage.center;
    const rock: WildernessFeature = {
      id: "probe:lonely_rock", species: "rock", x: c.x - 170, y: c.y + 140, stock: { stone: 5 },
    };
    if (!run.host.addWildFeature(rock)) throw new Error("the probe outcrop would not spawn — fixture broken, not a finding");
    const ep = wildFeatureContainerId(rock); // a BOX — an outcrop has no body
    expect(run.state.objects[ep]).toBeDefined();
    // FIXTURE CONTROL, said out loud: `attentionAddressee` prefers an ENGAGED
    // creature over a near one and asks no distance question of it, so a body
    // engaged by an earlier test would answer a press taken 170 m away. This
    // test's premise is "nobody", so the room is emptied of prior attention
    // rather than hoped to be empty.
    run.session.sparkAttention.clear();
    run.session.sparkEngageHold.clear();
    run.session.lastConvoCid = null;

    const board = hoverAndOpen(rock, ep);
    expect(board).not.toBeNull();
    expect(board!.options).toContain("take:stone"); // an outcrop DEPLETES — standing stone is takeable

    const toastsBefore = toasts.length;
    run.select("take:stone");
    run.advance(2);

    // ⚖️ THE VERDICT IS SPOKEN, in the leveled-glyph channel every sibling
    // refusal takes — the SHAPE, not a bare English string. `place + good.not`
    // is `CANT_HERE` at this world's syntax level (`b`), the same line the
    // "nobody can come" refusal already speaks.
    const spoke = said().includes("place + good.not");
    // …and where a world has nobody at all to say it, the banner is the floor
    // (`saySystem`'s own fallback). Either way the press is answered.
    const banner = toasts.slice(toastsBefore).some((t) => t.includes("nobody is near enough"));
    expect(spoke || banner).toBe(true);
    // Nothing was taken and nobody was engaged — a refusal, not a quiet success.
    expect(run.session.containerRecords.get(ep)?.stock?.["stone"] ?? 0).toBe(5);
    expect(run.session.sparkAttention.get("player")).toBeUndefined();
  }, 600_000);

  it("🙋 the same press with an idle body in reach installs the errand instead", () => {
    // The other side of the gate: a resident standing next to the stack takes
    // the instruction, which is what makes the refusal above a REFUSAL and not
    // a permanent state.
    const busy = (cid: string): boolean =>
      run.session.pursuits.has(cid) ||
      run.session.walk.has(cid) ||
      run.session.needStep.has(cid) ||
      run.session.liveNeedBodies.has(cid) ||
      run.session.party.has(cid) ||
      (run.session.npcTasks.get(cid)?.length ?? 0) > 0;
    // `idleForDirect`'s membership clause in the test's own words: a household
    // resident or a pet — and, since #50 ⑥, a SETTLER too (the founding
    // group's own bodies; this world is 4 days old so it has residents and no
    // settlers, and the settler half is pinned over a founding-age town in the
    // describe below). This one addresses a resident, deliberately.
    const helper = Object.keys(run.state.avatars).find(
      (id) => /^(resident_\d+_\d+|pet_\d+_\d+)$/.test(id) && !busy(id),
    );
    if (!helper) throw new Error("no idle resident to address — fixture broken, not a finding");
    const at = run.state.avatars[helper]!;

    const rock: WildernessFeature = {
      id: "probe:near_rock", species: "rock", x: at.x + 1.8, y: at.y + 1.8, stock: { stone: 4 },
    };
    if (!run.host.addWildFeature(rock)) throw new Error("the probe outcrop would not spawn — fixture broken, not a finding");
    const ep = wildFeatureContainerId(rock);
    const board = hoverAndOpen(rock, ep);
    expect(board).not.toBeNull();
    expect(board!.options).toContain("take:stone");

    run.select("take:stone");
    run.advance(2);

    // SOMEBODY TOOK IT. `attendGlyph` engages the addressee before it does
    // anything else, so this is the gate's answer with nothing else in the way.
    const engaged = run.session.sparkAttention.get("player");
    expect(engaged?.cid).toBeDefined();
    expect(busy(engaged!.cid)).toBe(true); // …and is now on the errand
  }, 600_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// #50 ⑥ — A SETTLER IS A BODY YOU CAN ASK
//
// 🔴 THE ROOT CAUSE Builder ① found and handed on: `idleForDirect` admitted
// pets, `resident_<h>_<n>` bodies and attached avatars — and a FOUNDING town
// has none of those. Its people are `settler_<i>` (`settlersOf`), so on the
// one world the player is asked to build, EVERY press, spoken noun and
// hover-direct was unaddressable: the fix above made that silence honest
// ("nobody is near enough"), and this makes the command WORK.
//
// The world is the shipped frontier document aged to the FOUNDING day — the
// one knob that decides it (`townPlan`: a town ≤ FOUNDING_AGE_DAYS lays no
// houses "whatever its population", so its souls are the founding group
// rather than householders). Nothing else about the document changes.
// ═══════════════════════════════════════════════════════════════════════════

describe("#50 ⑥ a founding settler takes the press", () => {
  let run: TextQuestRun;

  beforeAll(() => {
    // …and the two HOUSE-DEPENDENT knobs go with the houses: `initial_focus`
    // (a founding camp has none to focus) and the `objects` entity block
    // (town object definitions land in the focused house). The schema says
    // both out loud rather than quietly picking a house that isn't there —
    // and the frontier document's object list is EMPTY, so nothing is lost.
    const world = { ...doc.game.world, days: 1 };
    const game = { ...doc.game, world, entities: { creatures: doc.game.entities.creatures } };
    delete (game as { initial_focus?: unknown }).initial_focus;
    run = bootTextQuest({ world: { ...doc, game }, seed: 11, dt: 0.5 });
    run.advance(20);
  }, 600_000);

  afterAll(() => run?.dispose());

  /** The founding group's CREATURE ids. A settler's body rides under
   *  `npc_<cid>` (`avatarIdOf` — only residents and pets are their own body
   *  id), which is the id space every gate below speaks in. */
  const settlers = (): string[] =>
    Object.keys(run.state.avatars)
      .filter((id) => /^npc_settler_\d+$/.test(id))
      .map((id) => id.slice("npc_".length));

  it("the founding premise: settlers stand here, and NOBODY else could ever have been asked", () => {
    // The fixture's own truth, stated rather than assumed — this is what makes
    // the gate's old whitelist a total blackout rather than an edge case.
    expect(run.session.town!.plan.houses.length).toBe(0);
    expect(settlers().length).toBeGreaterThan(0);
    expect(Object.keys(run.state.avatars).filter((id) => /^resident_\d+_\d+$/.test(id))).toEqual([]);
  }, 600_000);

  it("🧑‍🌾 a press with an idle SETTLER in reach installs the errand on it", () => {
    const busy = (cid: string): boolean =>
      run.session.pursuits.has(cid) ||
      run.session.walk.has(cid) ||
      run.session.needStep.has(cid) ||
      run.session.liveNeedBodies.has(cid) ||
      (run.session.npcTasks.get(cid)?.length ?? 0) > 0;
    const cid = settlers().find((id) => !busy(id));
    if (!cid) throw new Error("no idle settler to address — fixture broken, not a finding");
    const at = run.state.avatars[`npc_${cid}`]!;
    // Same fixture control as the refusal test: the addressee resolver prefers
    // an ENGAGED body over a near one, so the room is emptied of old attention.
    run.session.sparkAttention.clear();
    run.session.sparkEngageHold.clear();
    run.session.lastConvoCid = null;

    const rock: WildernessFeature = {
      id: "probe:settler_rock", species: "rock", x: at.x + 1.8, y: at.y + 1.8, stock: { stone: 4 },
    };
    if (!run.host.addWildFeature(rock)) throw new Error("the probe outcrop would not spawn — fixture broken, not a finding");
    const ep = wildFeatureContainerId(rock);
    run.clearLook();
    run.advance(2);
    run.look(rock.x, rock.y);
    for (let i = 0; i < 24; i++) {
      run.stepFrame();
      if (run.view.probe().intent?.cursor?.hoverId === ep) break;
    }
    run.advance(4); // the short dwell opens the board

    run.select("take:stone");
    run.advance(2);

    // 🚨 THE PRESS LANDED ON A SETTLER — before #50 ⑥ this was the silent
    // refusal, because no settler could ever be the addressee.
    const engaged = run.session.sparkAttention.get("player");
    expect(engaged?.cid).toBeDefined();
    expect(/^settler_\d+$/.test(engaged!.cid)).toBe(true);
    // …and the instruction is a real errand on that body, not an engagement
    // with nothing behind it.
    expect(run.session.pursuits.get(engaged!.cid)?.source).toBe("command");
    expect(busy(engaged!.cid)).toBe(true);

    // ⚖️ AND IT LETS GO. `installAttentionPursuit` marks a commanded body LIVE
    // so the pursuit driver owns it; the need loop clears that flag again for
    // a resident but walks straight past a settler — so without #50 ⑥'s
    // release a settler that obeyed ONE order would be un-directable and
    // unclaimable forever, a worse idle than the one this fixes.
    let ran = 0;
    for (; ran < 40 && run.session.pursuits.has(engaged!.cid); ran++) run.advanceS(5);
    expect(run.session.pursuits.has(engaged!.cid)).toBe(false); // the errand really finished
    expect(run.session.liveNeedBodies.has(engaged!.cid)).toBe(false);
  }, 600_000);

  // ⚖️ task #51 item 1d — THE OTHER HALF OF THE CUT RULING: *"It should issue a
  // COMMAND to cut that tree."* With somebody attending, the press is that
  // command; with nobody, it is the mark (pinned above, on the resident world).
  it("🪓 a `cut` press with a SETTLER attending is a COMMAND to that settler", () => {
    const busy = (cid: string): boolean =>
      run.session.pursuits.has(cid) ||
      run.session.walk.has(cid) ||
      run.session.needStep.has(cid) ||
      run.session.liveNeedBodies.has(cid) ||
      (run.session.npcTasks.get(cid)?.length ?? 0) > 0;
    const cid = settlers().find((id) => !busy(id));
    if (!cid) throw new Error("no idle settler to address — fixture broken, not a finding");
    const at = run.state.avatars[`npc_${cid}`]!;
    run.session.sparkAttention.clear();
    run.session.sparkEngageHold.clear();
    run.session.lastConvoCid = null;

    // A tree the settler is standing beside — so the addressee resolver's
    // nearest-idle rung really does have somebody to find.
    const oak: WildernessFeature = {
      id: "probe:settler_oak", species: "oak", x: at.x + 2.2, y: at.y + 2.2, stock: { wood: 6 },
    };
    if (!run.host.addWildFeature(oak)) throw new Error("the probe oak would not spawn — fixture broken, not a finding");
    const ep = wildFeatureContainerId(oak);
    const book = run.session.town!.deltas;
    const marksBefore = book.fellOrders().length;
    run.clearLook();
    run.advance(2);
    run.look(oak.x, oak.y);
    for (let i = 0; i < 24; i++) {
      run.stepFrame();
      if (run.view.probe().intent?.cursor?.hoverId === ep) break;
    }
    run.advance(4); // the short dwell opens the board
    run.select(`cut:${ep}`);
    run.advance(2);

    // ① IT IS A COMMAND, ON A BODY — not a mark anybody may take.
    //
    // ⚠️ THE ENGAGED ROW IS THE TREE, not the taker: a standing plant is an
    // AVATAR, so hovering it engages IT (the hover-lane split this file exists
    // for). `attentionAddressee` then asks `idleForDirect` about that tree,
    // gets no for a thing with no mind, and falls through to the nearest idle
    // body — which is the settler. So the taker is read off the pursuit.
    const who = [...run.session.pursuits.keys()].find(
      (k) => run.session.pursuits.get(k)?.bill?.objId === ep,
    );
    expect(who).toBeDefined();
    expect(/^settler_\d+$/.test(who!)).toBe(true);
    const p = run.session.pursuits.get(who!);
    expect(p?.source).toBe("command");
    expect(p?.bill?.link).toBe("fell");
    expect(p?.bill?.objId).toBe(ep);
    // `wildSourceWord`: the oak is spoken of as a `tree` (timber to give) — the
    // command line reads "I will cut the tree", never the species id.
    expect(p?.goal).toEqual({ kind: "clearFeature", feature: "tree" });
    expect(book.fellOrders().length).toBe(marksBefore); // no mark was posted
    // ② AND THE TREE IS STILL STANDING at the moment of the press: the body has
    //    to walk there and spend the chop first.
    expect(run.session.wilderness!.features.find((f) => f.id === "probe:settler_oak")!.downed).not.toBe(true);

    // ③ …AND IT REALLY FELLS IT. Walk + `CHOP_DWELL_S` + the one kill draw.
    let ran = 0;
    for (; ran < 40 && !run.session.wilderness!.features.find((f) => f.id === "probe:settler_oak")?.downed; ran++) {
      run.advanceS(5);
    }
    const fallen = run.session.wilderness!.features.find((f) => f.id === "probe:settler_oak");
    expect(fallen?.downed).toBe(true);
    // ④ CONSERVATION, the felling's strongest form: nothing moved at all.
    expect(run.session.containerRecords.get(ep)?.stock?.["wood"] ?? 0).toBe(6);
    // ⑤ …and the body let go (a settler that stayed live would be
    //    un-directable forever — #50 ⑥'s own law).
    expect(run.session.pursuits.has(who!)).toBe(false);
    expect(run.session.liveNeedBodies.has(who!)).toBe(false);
  }, 600_000);
});
