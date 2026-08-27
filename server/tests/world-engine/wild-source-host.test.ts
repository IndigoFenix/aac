/**
 * ⚖️ HOST ROUND (fold-round.md H1–H3) — THE REGION SOURCE, FROM THE PLAYER'S SIDE.
 *
 * F5b made a folded stand a one-way trade partner and proved it from a cheat.
 * A conservation law you can only reach with `/wild draw` is a law no child
 * ever touches, so this file pins the SPOKEN route and the sweep that drives
 * it — the three gaps F5b recorded on its way out.
 *
 * The laws under test:
 *
 *  ① A FETCH FROM A FOLDED WILD IS A SHIPMENT, NOT AN ERRAND. "get wood from
 *    the forest" against a CONDENSED area posts the same ② scheduled row the
 *    cheat posts, priced by the ONE leg seat (`partnerLegSeconds`), with the
 *    terms said aloud. Nobody walks: the trees are not there to walk to.
 *
 *  ② A LIVE STAND IS UNTOUCHED. The same sentence with the trees standing is
 *    today's errand, byte for byte — and an order NEVER folds the world to
 *    serve itself. (Pinned as "no agreement, no fold"; the transcript pair
 *    h1-draw-before/after.txt holds the byte half.)
 *
 *  ③ NEITHER ⇒ REFUSED ALOUD. No stand and no record is "there is no forest
 *    here", never silence and never a task nobody can claim.
 *
 * ONE BOOT, FIVE PHASES (the sequence-execution.test.ts pattern): a frontier
 * boot with a live wilderness is the expensive part, and each phase wants the
 * world the previous one leaves. The first leg is bought with `warpDays` — days
 * of BOOKS, no frames — because 84 sim-seconds of frontier frames costs a
 * minute and a half of wall clock and proves nothing the sweep doesn't.
 *
 * DB-free / GL-free — `npm run test:engine -- wild-source`.
 */
import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";
import {
  wildAreaStock,
  wildSourcePartner,
  type WildAreaRecord,
} from "@shared/world-engine/interaction/quest/wild-area.js";
import { barterLegSeconds } from "@shared/world-engine/kernel/town/barter.js";
import { wildAreaId } from "@shared/world-engine/kernel/town/scope.js";
import { FOOD_DAY_SEC } from "@shared/world-engine/kernel/town/goods.js";
import { stackUnits, type TransferAgreement } from "@shared/world-engine/kernel/town/transfer.js";
import { wildFeatureContainerId } from "@shared/world-engine/interaction/quest/wilderness.js";

// The FRONTIER world: a town scope WITH wilderness (the dollhouse has none, so
// it can never grow a source). Same document `scripts/worlds/frontier.spec.json`
// the F5b transcripts were taken against.
const specPath = join(process.cwd(), "scripts", "worlds", "frontier.spec.json");
const doc = JSON.parse(readFileSync(specPath, "utf8")) as Record<string, unknown>;

/** Every toast the host pushed since the tap was armed — the adult-facing
 *  channel the draw's terms ride (the child-facing half is the bubble). */
function toastTap(run: TextQuestRun): { all: string[]; since: (n: number) => string } {
  const all: string[] = [];
  run.addPresenterTap({ toast: (text: string) => void all.push(text) });
  return { all, since: (n) => all.slice(n).join(" | ") };
}

/** The ② rows aimed at our yard FROM the region source — the only rows a draw
 *  may ever create. */
function drawRows(run: TextQuestRun, key = "home"): TransferAgreement[] {
  const sourceId = wildAreaId(key);
  return run.session.transfers.active().filter((a) => a.from === sourceId);
}

/** Every row a draw of any kind has ever posted, newest last — the reading H2
 *  needs, where WHICH source answered is the whole question. */
function allDrawRows(run: TextQuestRun): TransferAgreement[] {
  return run.session.transfers.active().filter((a) => a.from.startsWith("wild:area:"));
}

/**
 * A SECOND CONDENSED AREA, cloned off the first. v1 folds exactly one stand per
 * session (`HOME_WILD_AREA`), but `session.areaRecords` has always been a keyed
 * MAP and H2's law is about the map — so the map is what the pin populates,
 * rather than waiting for the world-size round to mint a real region. The clone
 * keeps the stock and moves the GROUND, which is the only input the leg price
 * reads.
 */
function cloneSource(
  run: TextQuestRun,
  key: string,
  area: { x: number; y: number; w: number; h: number },
): void {
  const src = run.session.areaRecords.get("home");
  if (!src) throw new Error("cloneSource: nothing folded to clone");
  const copy = structuredClone(src) as WildAreaRecord;
  copy.key = key;
  copy.area = area;
  run.session.areaRecords.set(key, copy);
}

/** What the source still owns, standing or cut: record stock + boundary shelf.
 *  The conservation reading — a draw moves units between these two and the
 *  yard, and creates none. */
function sourceHolds(run: TextQuestRun, glyph: string): number {
  const rec = run.session.areaRecords.get("home");
  const standing = rec ? wildAreaStock(rec)[glyph] ?? 0 : 0;
  return standing + stackUnits(run.session.partnerStock[wildAreaId("home")] ?? {}, glyph);
}

describe("H1/H2 — the spoken region draw and which source answers it", () => {
  it("routes a folded wild to the ledger, ships it, picks the cheapest source, and refuses aloud when it cannot serve", () => {
    const run = bootTextQuest({ world: doc, seed: 12, dt: 1 / 10 });
    try {
      run.advance(20);
      const s = run.session;
      const toasts = toastTap(run);

      // ── ② A LIVE STAND: the trees are standing, so this is an ERRAND ──────
      // (E-round evolution: the town's own FARM record legitimately lives in
      // `areaRecords` from the first sweep — the "nothing folded" premise reads
      // the FOREST records only.)
      const foldedForests = () =>
        [...s.areaRecords.keys()].filter((k) => !k.startsWith("farm-")).length;
      expect(s.wilderness?.features.length ?? 0).toBeGreaterThan(0);
      expect(foldedForests()).toBe(0);
      const mark0 = toasts.all.length;
      run.speak("get + wood + from + forest");
      // No shipment: not one row against the source exists, and the wild was not
      // folded to make one possible. That second half is the load-bearing one —
      // a sentence that could fold the world would pop the stand the player is
      // looking at straight out of existence.
      expect(drawRows(run)).toHaveLength(0);
      expect(foldedForests()).toBe(0);
      expect(s.wilderness?.features.length ?? 0).toBeGreaterThan(0);
      // …and the ordinary pooled-errand answer still lands (never silence).
      expect(toasts.since(mark0)).toContain("get + wood + from + forest");

      // ── ① A FOLDED STAND: the same sentence is a SHIPMENT ─────────────────
      run.host.wildProbe("fold");
      const rec = s.areaRecords.get("home");
      expect(rec).toBeDefined();
      const held0 = sourceHolds(run, "wood");
      expect(held0).toBeGreaterThan(0);

      const t0 = s.taskClock;
      const mark1 = toasts.all.length;
      run.speak("get + wood + from + forest");
      const rows = drawRows(run);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.mode).toBe("scheduled");
      expect(row.goods).toEqual({ wood: 1 });
      expect(row.to).toBe("town:yard"); // our end is the yard, where town stock lives

      // THE PRICE IS THE ONE SEAT. Recomputed here from the record's own
      // geometry through `barterLegSeconds`, so a second pricing path for
      // "but it's a forest" would fail this line the day it is written.
      const origin = s.town?.stage.center ?? s.foundedSite?.at ?? null;
      const source = wildSourcePartner(rec!, origin);
      const legS = barterLegSeconds(s.scale, source.distanceM);
      expect(legS).toBeGreaterThan(0);
      expect(row.nextDueAt).toBeCloseTo(t0 + legS, 6);

      // ⚖️ EVERY SPOKEN DRAW IS STANDING — the recorded H1 gap. A one-shot
      // NON-barter row is not representable (`runDueTransfers` re-arms a row
      // with no `every` at now+0), so a bare "get wood" is a daily load and
      // the quantity word scales it, tribute-style. This line IS the gap.
      expect(row.every).toBe(FOOD_DAY_SEC);

      // THE TERMS ARE SAID: the road and the leg it buys, on the banner.
      const said = toasts.since(mark1);
      expect(said).toContain("draw:");
      expect(said).toContain("1 wood each day");
      expect(said).toContain(wildAreaId("home"));
      expect(said).toContain(`${Math.round(legS)}s`);

      // ── THE FIRST LEG SHIPS, AND CONSERVES ────────────────────────────────
      const yard0 = stackUnits(s.town?.deltas.stock ?? {}, "wood");
      const warp = run.warpDays(1); // days of BOOKS — the sweep, not the frames
      expect(warp.ok).toBe(true);
      const yard1 = stackUnits(s.town?.deltas.stock ?? {}, "wood");
      const held1 = sourceHolds(run, "wood");
      expect(yard1).toBeGreaterThan(yard0);
      // Nothing was minted: the source's own books gave at least what the yard
      // gained. (A kill draw fells a whole tree, so the shelf may hold the
      // remainder — hence `sourceHolds` counts standing AND cut.)
      expect(held0 - held1).toBeGreaterThanOrEqual(yard1 - yard0);

      // ── QUANTITY SCALES THE DAILY LOAD (the tribute rule, 1–3) ────────────
      run.speak("get + three + wood + from + forest");
      const three = drawRows(run).find((a) => (a.goods.wood ?? 0) === 3);
      expect(three).toBeDefined();
      expect(three!.every).toBe(FOOD_DAY_SEC);

      // "all" is the plain STANDING one — it does not become an unbounded
      // haul, because the standing row already IS the "keep it coming" shape.
      const ones = drawRows(run).filter((a) => (a.goods.wood ?? 0) === 1).length;
      run.speak("get + all + wood + from + forest");
      expect(drawRows(run).filter((a) => (a.goods.wood ?? 0) === 1)).toHaveLength(ones + 1);

      // ══ H2 — MULTI-SOURCE SELECTION ═════════════════════════════════════
      //
      // The home area sits AT the town centre (distance 0), so every injected
      // rival is farther or exactly level — which is precisely the two cases
      // the law distinguishes.
      const homeArea = s.areaRecords.get("home")!.area;

      // ── CHEAPEST ROAD BEATS KEY ORDER ─────────────────────────────────────
      // `aaa-far` sorts FIRST alphabetically and is a kilometre out. If the
      // picker read the map (or the key) instead of the leg, it would answer
      // from there.
      cloneSource(run, "aaa-far", { ...homeArea, x: homeArea.x + 4000, y: homeArea.y + 4000 });
      const mark3 = allDrawRows(run).length;
      run.speak("get + wood + from + forest");
      const picked = allDrawRows(run).slice(mark3);
      expect(picked).toHaveLength(1);
      expect(picked[0]!.from).toBe(wildAreaId("home"));

      // ── A TIE BREAKS ON THE KEY, NEVER ON MAP ORDER ───────────────────────
      // Same ground ⇒ same road ⇒ same price. `aaa-tie` was inserted LAST and
      // sorts FIRST; the key is what decides, so the answer is stable across
      // any fold history that produced the same two areas.
      cloneSource(run, "aaa-tie", { ...homeArea });
      const mark4 = allDrawRows(run).length;
      run.speak("get + wood + from + forest");
      const tied = allDrawRows(run).slice(mark4);
      expect(tied).toHaveLength(1);
      expect(tied[0]!.from).toBe(wildAreaId("aaa-tie"));

      // ── THE CHEAT KEEPS ITS OWN HOME BEHAVIOUR ────────────────────────────
      // `/wild draw` probes ONE NAMED area deliberately — a cheat is an
      // instrument, not a player, and the tie-winner above must not capture it.
      const mark5 = allDrawRows(run).length;
      run.host.wildProbe("draw wood");
      const cheated = allDrawRows(run).slice(mark5);
      expect(cheated).toHaveLength(1);
      expect(cheated[0]!.from).toBe(wildAreaId("home"));

      // ── DRAW SHORTFALL IS HONEST ──────────────────────────────────────────
      // A stand of oaks has no meat. The refusal is the partner vocabulary's
      // own ("they + give.not + meat") and NOT A ROW: a posted row would ship
      // nothing, every day, forever — the exact silent failure a source's
      // one-way ledger makes so easy to write.
      for (const source of [...s.areaRecords.values()]) {
        expect(wildAreaStock(source).meat ?? 0).toBe(0);
      }
      const mark6 = allDrawRows(run).length;
      const toastMark = toasts.all.length;
      run.speak("get + meat + from + forest");
      expect(allDrawRows(run)).toHaveLength(mark6); // nothing posted
      const refused = toasts.since(toastMark);
      // 🚨 AND NOT POOLED EITHER. Falling through to the errand pool would also
      // post no row and would also mention meat — this line is what keeps the
      // pin from passing on the very behaviour it exists to replace.
      expect(refused).not.toContain("anyone nearby may take it");
      // Answered, and answered about MEAT — never a generic "can't do that".
      const spoke = Object.values(run.state.bubbles).some((b) => (b.text ?? "").includes("meat"));
      expect(refused.includes("the forest has no meat") || spoke).toBe(true);

      s.areaRecords.delete("aaa-far");
      s.areaRecords.delete("aaa-tie");

      // ── ③ NEITHER STAND NOR RECORD ⇒ REFUSED ALOUD ────────────────────────
      // The wild is gone entirely (an area is loaded or condensed — here it is
      // neither, which is the honest "there is no forest here").
      s.areaRecords.clear();
      s.wilderness!.features.length = 0;
      const rowsBefore = drawRows(run).length;
      const mark2 = toasts.all.length;
      const bubbles0 = JSON.stringify(run.state.bubbles);
      run.speak("get + wood + from + forest");
      expect(drawRows(run)).toHaveLength(rowsBefore); // nothing posted
      // Not pooled — REFUSED (same guard as the shortfall pin above).
      expect(toasts.since(mark2)).not.toContain("anyone nearby may take it");
      // Answered SOMEWHERE — `saySystem` speaks it through a creature when one
      // is in earshot and banners it when none is. Never nothing.
      const bubbles1 = JSON.stringify(run.state.bubbles);
      expect(toasts.since(mark2).length > 0 || bubbles1 !== bubbles0).toBe(true);
    } finally {
      run.dispose();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// H3 — THE UNWATCHED-STAND SWEEP (the LOD driver)
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚖️ A STAND MAY CHANGE FORM ONLY WHERE IT CANNOT BE SEEN. Everything below is
// that one law: the band decides, the timer only decides when to ask, and the
// fold goes through the commitments guard on its way out.
//
// The frontier spirit starts INSIDE the wild rect (the town sits at its
// centre — which is why both shipped worlds are inert, pinned by transcript),
// so every phase here moves the anchor and lets the sweep run.

/**
 * MOVE THE CAMERA, THE WAY THE HARNESS MOVES IT.
 *
 * 🚨 Writing `session.spiritPos` DOES NOT WORK and the first cut of this file
 * did exactly that, silently: `applyCamera` (text-quest.ts:386) re-asserts
 * `host.setSpiritPosition(cameraPoint())` before EVERY frame, and a
 * `dollhouse`/`town` camera's point is the stage centre — a fixed spot inside
 * the wild rect. The park was overwritten within one frame, the band never
 * moved, and the "stand stays live" phases passed for the wrong reason.
 *
 * So the run boots with a FOLLOW camera pointed at the spirit's own PLAYER_ID
 * body, which is the one `cameraPoint` reads back out of world state — moving
 * that body moves the camera, the spirit position, and therefore the anchor,
 * through the harness's real path rather than around it.
 */
const PLAYER_BODY = "player"; // solver/space3d.ts PLAYER_ID

function moveCamera(run: TextQuestRun, x: number, y: number): void {
  const p = run.state.avatars[PLAYER_BODY];
  if (!p) throw new Error("moveCamera: no player body to move");
  p.x = x;
  p.y = y;
  p.vx = 0;
  p.vy = 0;
}

const isFolded = (run: TextQuestRun): boolean => run.session.areaRecords.has("home");
const isLive = (run: TextQuestRun): boolean => (run.session.wilderness?.features.length ?? 0) > 0;

/** Distance from a point to a rect, 0 inside — the driver's own measure,
 *  recomputed here so each phase can state where it stands relative to the
 *  band instead of hoping. */
const rectDist = (
  r: { x: number; y: number; w: number; h: number },
  p: { x: number; y: number },
): number =>
  Math.hypot(
    Math.max(r.x - p.x, 0, p.x - (r.x + r.w)),
    Math.max(r.y - p.y, 0, p.y - (r.y + r.h)),
  );

describe("H3 — a stand folds only where nobody can see it", () => {
  it("folds when unwatched, unfolds on return, never flaps, obeys the guard, and ignores warps and other people's folds", () => {
    const run = bootTextQuest({
      world: doc,
      seed: 12,
      // ⏩ THE WIDE TICK, deliberately: this phase buys ~90 sim-seconds of
      // driver sweeps and nothing here reads body motion, so the coarse frame
      // is honest and costs a fifth of the wall clock (wide-tick-round.md).
      dt: 0.5,
      camera: { kind: "follow", creatureId: PLAYER_BODY },
    });
    try {
      run.advance(20);
      const s = run.session;
      expect(isLive(run)).toBe(true);
      expect(isFolded(run)).toBe(false);

      // ⚖️ THE STAND NEEDS A SUB-WORLD GROUND, AND THAT IS THE FINDING.
      //
      // `wildAreaGround` reports the WHOLE WORLD SQUARE, and the avatar
      // manifold clamps every anchor inside that same square — so on shipped
      // geometry the rect distance is ALWAYS 0 and the fold arm can never fire.
      // (Measured: parking the camera at 10× the side landed it on the world
      // corner.) The driver only has work to do once a wild area's ground is a
      // PART of the world, which is precisely the region layer's shape — so the
      // pin gives one stand a sub-world ground, exactly as `cloneSource` above
      // gives H2 a second area. Everything below is the region layer's geometry
      // arriving early; the shipped-today verdict is INERT, and that is what the
      // h3-doll / h3-frontier transcript pairs pin.
      const worldSide = s.wilderness!.side;
      const STAND_SIDE = 60;
      s.wilderness!.side = STAND_SIDE;
      const standRect = { x: 0, y: 0, w: STAND_SIDE, h: STAND_SIDE };
      const visibleR = Math.max(240, (s.town?.plan.radius ?? 0) * 2 + 80); // the SPIRIT reading
      const foldOut = visibleR + 42; // + VIEW_RADIUS, the no-snap radius

      const standing0 = (s.wilderness?.features ?? []).reduce(
        (n, f) => n + Object.values(f.stock).reduce((a, b) => a + b, 0),
        0,
      );
      expect(standing0).toBeGreaterThan(0);

      /** Park the camera at the world's far corner — outside the stand's
       *  ground by more than FOLD_OUT, and ASSERTED to be, because the version
       *  of this helper that silently was not cost a whole run. */
      const parkAway = (): void => {
        moveCamera(run, worldSide, worldSide);
        run.advance(2);
        expect(rectDist(standRect, s.spiritPos!)).toBeGreaterThan(foldOut);
      };

      // MID-BAND, DIAGONALLY — because the band is wider than the world is
      // long: this town's `visibleR` reads 486 m (radius × 2 + 80 beats the
      // 240 m floor) while the manifold clamps the camera to a ~487 m square,
      // so no axis-aligned point is even FOLD_IN away from the stand. The
      // corner reaches √2 further, which is why `parkAway` works at all.
      const midBand = visibleR + 21; // half a no-snap radius into the band
      const midLeg = midBand / Math.SQRT2;
      expect(STAND_SIDE + midLeg).toBeLessThanOrEqual(worldSide);
      const toMidBand = (): void => {
        moveCamera(run, STAND_SIDE + midLeg, STAND_SIDE + midLeg);
        run.advance(2);
        const d = rectDist(standRect, s.spiritPos!);
        expect(d).toBeGreaterThan(visibleR); // > FOLD_IN
        expect(d).toBeLessThan(foldOut); //     < FOLD_OUT
      };

      // ── PHASE C① — HYSTERESIS, THE LIVE HALF ──────────────────────────────
      // Inside the band, a LIVE stand must not fold, however long the sweep
      // runs. A single threshold at FOLD_IN would fold it here.
      toMidBand();
      for (let i = 0; i < 2; i++) {
        run.advanceS(8);
        expect(isLive(run)).toBe(true);
        expect(isFolded(run)).toBe(false);
      }

      parkAway();

      // ── PHASE E (still live) — A WARP NEVER FOLDS ─────────────────────────
      // Books-only, no camera, no band: an LOD decision has no business in one.
      // Parked out of band, the ONLY thing keeping this stand live is that
      // `warpDays` does not run the driver.
      expect(run.warpDays(1).ok).toBe(true);
      expect(isLive(run)).toBe(true);
      expect(isFolded(run)).toBe(false);

      // ── PHASE D — THE COMMITMENTS GUARD REFUSES ───────────────────────────
      // A leg booked FROM a STANDING FEATURE is exactly the endpoint that would
      // stop existing at this fold, and the wild codec's `services` predicate
      // does not cover it — so `condense` refuses and the driver obeys.
      // ⚖️ Commitments of goods refuse; projections of walks fold.
      const feature = s.wilderness!.features[0]!;
      const blocker = s.transfers.post({
        from: wildFeatureContainerId(feature),
        to: "town:yard",
        goods: { wood: 1 },
        issuer: "player",
        mode: "haul",
        now: s.taskClock,
      });
      run.advanceS(16); // well past sweep period × debounce
      // STAY LIVE — pinned via STATE, never a toast: the driver is deliberately
      // silent (it fires on a timer; a banner would nag once a period forever).
      expect(isLive(run)).toBe(true);
      expect(isFolded(run)).toBe(false);

      // ── PHASE A — RETIRE THE BLOCKER AND IT FOLDS ON THE RETRY ────────────
      // "Refusal ⇒ stay live, retry next sweep" is the half that makes the
      // guard honest rather than fatal.
      s.transfers.complete(blocker.id);
      run.advanceS(16);
      expect(isFolded(run)).toBe(true);
      expect(isLive(run)).toBe(false);
      // ⚖️ F-① — NOTHING EVAPORATES AT A FOLD. Every standing unit is in the
      // record (no draw has run, so the boundary shelf is untouched).
      const inRecord = Object.values(wildAreaStock(s.areaRecords.get("home")!)).reduce(
        (a, b) => a + b,
        0,
      );
      expect(inRecord).toBe(standing0);

      // ── PHASE C② — HYSTERESIS, THE FOLDED HALF ────────────────────────────
      // Walk back only as far as the band and hold: a FOLDED stand must not
      // unfold there. A single threshold at FOLD_OUT would unfold it here, and
      // together with C① that is the whole proof that there are two lines.
      toMidBand();
      for (let i = 0; i < 2; i++) {
        run.advanceS(8);
        expect(isFolded(run)).toBe(true);
        expect(isLive(run)).toBe(false);
      }

      // ── PHASE F — THE DRIVER REVERSES ONLY ITS OWN HOUSEKEEPING ───────────
      // A record the driver did not fold is somebody's DECISION — a `/wild
      // fold`, a session handover, a regional source — and an LOD sweep may not
      // overrule it. Measured before this rule existed: `/wild fold` was undone
      // within one sweep, turning F5b's own live proofs from `folded
      // wild:area:home` into `loaded: oak×8 …`.
      const homeArea = s.areaRecords.get("home")!.area;
      cloneSource(run, "zzz-remote", { ...homeArea, x: homeArea.x + 4000 });

      // ── PHASE B — THE BAND COMES BACK, THE STAND STANDS ───────────────────
      moveCamera(run, STAND_SIDE / 2, STAND_SIDE / 2);
      run.advanceS(16);
      expect(isLive(run)).toBe(true);
      expect(isFolded(run)).toBe(false); // the driver's own record retired
      expect(s.areaRecords.has("zzz-remote")).toBe(true); // …and nobody else's did
      s.areaRecords.delete("zzz-remote");
    } finally {
      run.dispose();
    }
  });
});

