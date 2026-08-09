// shared/world-engine/interaction/quest/creature-inspect.ts
//
// THE READ-ONLY CREATURE READOUT — one creature, fully described, from probes
// that already exist (stocking-offload-and-carry.md §2).
//
// Why it lives here and not in the debug panel: the panel is a DOM surface in
// games/world-lab/src, which the root `tsc` never sees and no jest suite can
// import without a DOM. The QUESTION the panel asks — "where is this body, what
// is it doing, why, what is it holding, and is there even a body?" — is pure
// projection over a live `QuestSession` plus the host's existing probes, so it
// belongs beside the session it reads and is testable headless.
//
// ⚖️ ASKING MOVES NOTHING (the promise `sourceProbe` / `whyProbe` already make).
// Every read here is a `get`/`find` over live state. Nothing reserves, claims,
// parks, spawns or bubbles — a readout that changed what it measured would be
// worse than no readout. The pinned form of that promise: `needClaims.toJSON()
// .serial` is byte-identical across a full inspection pass.
//
// ⚖️ OFF-SCREEN AND ABSTRACTED BODIES ARE THE POINT. Clicking a creature is the
// only other detail view and it needs a body under the pointer, which is exactly
// what a shopper that vanished mid-trip does not have. So an ABSTRACTED resident
// is a first-class answer here: it reports its SCHEDULE PHASE (the shop errand /
// job shift the household roster puts it on) where an embodied one reports a
// position — never "missing", never blank.
//
// ⚖️ A CROWD IS SUMMARIZED, AN INDIVIDUAL IS NAMED (text-mode law ⑤).
// `inspectRoster` enumerates the family, the pets and everything the session has
// actually REGISTERED; the rest of the town is a COUNT. Listing four hundred
// ambient residents would bury the six that matter.

import type { QuestSession } from "./quest-host.js";
import type { GoingDest, ReasonLink } from "../dialogue/creature-dialogue.js";
import type { PhraseSpec } from "../dialogue/dialogue-gen.js";
import { roomAt, type GoingRoom } from "../dialogue/going.js";
import { ROOM_GLYPH } from "../town/structure-board.js";
import { houseRoomPlan } from "../../kernel/town/rooms.js";
import { containerDefOfGlyph } from "../../kernel/town/containers.js";
import { FOOD_DAY_SEC, houseDoorstep, workDoorstep } from "../../kernel/town/goods.js";
import {
  assignTownJobs,
  inShiftWindow,
  jobDutyOf,
  rosterOf,
  shopDutyOf,
  type JobAssignment,
} from "../../kernel/town/roster.js";

/** A minimal body, as a readout needs one. Structurally satisfied by the
 *  engine's `WorldState["avatars"]` entries — typed by SHAPE so this module
 *  never value-imports the engine. */
export interface InspectBody {
  x: number;
  y: number;
  vx?: number;
  vy?: number;
}

/** The live world, as a readout needs it: the bodies, and the OBJECT TABLE's
 *  one field that says whose hand a thing is in. Typed by SHAPE (the panel
 *  hands over `host.world.state` unchanged); `objects` is optional so a stub
 *  that only has bodies still reads. */
export interface InspectState {
  avatars: Record<string, InspectBody>;
  objects?: Record<string, { carriedBy?: string | null }>;
}

/**
 * THE PROBE BUNDLE — the host methods this readout is built from, every one of
 * them already shipped and already read-only (`QuestHost3D.activityOf`,
 * `.whyProbe`, `.carryOf`, `.nameOf`, `.world.state`, `.world.npcErrandPath`).
 *
 * All optional: a caller that can only hand over half still gets a readout with
 * the other half marked absent, which is what makes this stubbable in a test
 * without booting a world.
 */
export interface InspectProbes {
  /** `host.world?.state` — the live bodies, and the object table the HANDS are
   *  read from. Absent ⇒ everything reads ABSTRACTED. */
  state?: InspectState | null;
  /** `host.activityOf` (quest-host `creatureActivity`). */
  activityOf?: (cid: string) => { verb: string; object?: string } | undefined;
  /** `host.whyProbe` (quest-host `reasonChainOf`) — the why-chain, walked. */
  whyProbe?: (cid: string) => ReasonLink[] | undefined;
  /** `host.carryOf` — the MERGED STOCK of the containers the body holds or
   *  wears (plus a non-bag hands instance as one unit). The held bag object is
   *  NOT in it by design ("the shelf, not the goods"), which is why the hands
   *  are read separately from `state.objects` — see `handsObjectOf`. */
  carryOf?: (cid: string) => Record<string, number>;
  /** `host.nameOf` — the word this body is addressed by. */
  nameOf?: (cid: string) => string | undefined;
  /** `host.world?.npcErrandPath` — a DWELLED waypoint is a body standing still. */
  errandPath?: (avatarId: string) => { dwelling?: boolean } | null | undefined;
}

/** One labelled line of the detail block. */
export interface InspectRow {
  label: string;
  value: string;
}

export interface CreatureInspection {
  cid: string;
  /** The word this body is addressed by, when anything can name it. */
  name?: string;
  /** The COLLAPSED row's one-liner — id, name, condition, wants, duty. */
  summary: string;
  /** Is there a body in the world right now? False = ABSTRACTED (the schedule
   *  is all anyone has, and `rows` says so instead of giving a position). */
  embodied: boolean;
  /** The expanded detail block, in reading order. Empty answers are dropped —
   *  a row that says nothing is noise in a list this long. */
  rows: InspectRow[];
  /** The why-chain as its CLAUSE LIST, one rung per line (`reasonChainOf`
   *  rendered, never re-derived). Empty when the host has no chain to give. */
  why: string[];
}

/** Who the panel LISTS. Named individuals plus the size of the crowd it
 *  deliberately does not name. */
export interface InspectRoster {
  /** Family first, then pets, then everything else the session registered. */
  named: string[];
  /** Hosted bodies NOT in `named` — the ambient cohort, as a statistic. */
  ambient: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Household plumbing (moved here from the panel so there is one owner)
// ───────────────────────────────────────────────────────────────────────────

/** `resident_<house>_<m>` / `pet_<house>_<n>` → the house index, else NaN. */
export function houseIndexOfCid(cid: string): number {
  const parts = cid.split("_");
  return parts.length >= 2 ? Number(parts[1]) : NaN;
}

/**
 * 🚨 THE HOUSE WITH THAT LOT ID — never `plan.houses[idx]`.
 *
 * `TownHouse.index` is the LOT id, not the array position: stall conversions
 * are filtered out of `plan.houses`, so the array HAS GAPS. Indexing it
 * positionally resolved a NEIGHBOURING household for every lot past a
 * conversion — which is how this readout came to report "138.4 m from home"
 * for a body standing in its own kitchen, and to print another household's
 * schedule phase beside it. quest-host's `residentTownCtx` documents and fixes
 * the same class of bug; this is the same lookup, at the readout's three seats
 * (`schedulePhaseOf`, `houseRoomsOf`, `homePointOf`).
 */
function houseByIndex(session: QuestSession, idx: number) {
  if (!Number.isFinite(idx)) return undefined;
  return session.town?.plan.houses.find((h) => h.index === idx);
}

/** THE BODY BEHIND A CREATURE ID, if one is standing. Residents and pets ARE
 *  their avatar id; everything else rides `npc_<cid>` (quest-host `avatarIdOf`).
 *  Asking for both is deliberate: a readout that guessed the convention wrong
 *  would report a live body as abstracted, which is the one lie that matters. */
export function bodyOf(
  state: InspectState | null | undefined,
  cid: string,
): { id: string; body: InspectBody } | undefined {
  if (!state) return undefined;
  const own = state.avatars[cid];
  if (own) return { id: cid, body: own };
  const npc = state.avatars[`npc_${cid}`];
  return npc ? { id: `npc_${cid}`, body: npc } : undefined;
}

/** Town job assignments, memoized per TownPlay (`assignTownJobs` is pure but a
 *  city-sized sort — don't rerun it on every readout refresh). */
const jobsMemo = new WeakMap<object, Map<number, JobAssignment[]>>();
function townJobsOf(session: QuestSession): Map<number, JobAssignment[]> | null {
  const town = session.town;
  if (!town) return null;
  let jobs = jobsMemo.get(town);
  if (!jobs) {
    jobs = assignTownJobs(
      town.plan.houses.map((h) => ({ index: h.index, door: houseDoorstep(town.stage.center, h) })),
      town.plan.works.map((wk) => ({ door: workDoorstep(town.stage.center, wk) })),
      town.stage.goods.length,
      town.config.seed,
    );
    jobsMemo.set(town, jobs);
  }
  return jobs;
}

/**
 * A resident's SCHEDULE PHASE — its shop errand's phase and/or its job shift
 * state, off the household roster (the one allocator). "" for pure homebodies.
 *
 * This is what an ABSTRACTED body answers with instead of a position: the goods
 * clock is time-pure, so it says where a body WOULD be with no body to ask.
 */
export function schedulePhaseOf(session: QuestSession, cid: string): string {
  try {
    if (!cid.startsWith("resident_") || !session.town) return "";
    const house = houseByIndex(session, houseIndexOfCid(cid));
    const m = Number(cid.split("_")[2]);
    if (!house) return "";
    const roster = rosterOf(
      session.town.stage.goods.map((g, i) => ({ key: g.good.key, slot: g.good.slot ?? i })),
      undefined,
      townJobsOf(session)?.get(house.index),
    );
    let out = "";
    const duty = shopDutyOf(roster[m]);
    const good = duty ? session.town.stage.goods.find((g) => g.good.key === duty.good) : undefined;
    if (good) out += ` · ${good.good.key}:${good.errand(house, session.townClock).phase}`;
    const jd = jobDutyOf(roster[m]);
    if (jd) out += ` · job:${jd.work}${inShiftWindow(jd.window, session.townClock, FOOD_DAY_SEC) ? " ON-SHIFT" : ""}`;
    return out;
  } catch {
    return "";
  }
}

/** The rooms of a house as DESTINATIONS, each carrying the word it answers with
 *  — the living room and halls carry none (quest-host `houseRoomDestsOf`). */
function houseRoomsOf(session: QuestSession, houseIndex: number): GoingRoom[] {
  const town = session.town;
  const house = houseByIndex(session, houseIndex);
  if (!town || !house) return [];
  try {
    const plan = houseRoomPlan(town.stage.center, house, town.deltas.get(`h_${house.index}`));
    return plan.rooms.map((r) => ({
      rect: r.rect,
      ...(r.kind === "living" || r.kind === "hall" ? {} : { word: ROOM_GLYPH[r.kind] }),
    }));
  } catch {
    // A READOUT MUST NEVER TAKE THE PANEL DOWN. An un-plannable lot costs the
    // reader a room word; a thrown exception would cost them every other row.
    return [];
  }
}

/**
 * THE WORD FOR A POINT, for a readout: the room of the body's OWN house first
 * (the rooms it has a word for without qualification), then ANY building
 * containing it — its room word where the plan gives one, else the building.
 * Undefined for open ground, which really has no name.
 *
 * Deliberately WITHOUT quest-host's nearest-fixture arm: a debug row wants the
 * PLACE ("kitchen", "market"), not the nearest chair, and the fixture arm is a
 * speaking concern that needs the whole object-word book.
 */
export function placeWordAt(
  session: QuestSession,
  cid: string,
  p: { x: number; y: number },
): string | undefined {
  const town = session.town;
  if (!town) return undefined;
  const own = houseIndexOfCid(cid);
  if (Number.isFinite(own)) {
    const word = roomAt(houseRoomsOf(session, own), p)?.word;
    if (word) return word;
  }
  const c = town.stage.center;
  const covers = (r: { dx: number; dy: number; w: number; h: number }): boolean =>
    p.x >= c.x + r.dx && p.x <= c.x + r.dx + r.w && p.y >= c.y + r.dy && p.y <= c.y + r.dy + r.h;
  for (const h of town.plan.houses) {
    if (!covers(h)) continue;
    const word = roomAt(houseRoomsOf(session, h.index), p)?.word;
    return word ?? (h.index === own ? "home" : `house ${h.index}`);
  }
  for (const w of town.plan.works) {
    if (!w.vacated && covers(w)) return w.type;
  }
  return undefined;
}

/** A resident's own doorstep — the anchor "distance from home" is measured to.
 *  Undefined for anyone with no household (a wilderness local, the player). */
export function homePointOf(session: QuestSession, cid: string): { x: number; y: number } | undefined {
  const town = session.town;
  const house = houseByIndex(session, houseIndexOfCid(cid));
  return town && house ? houseDoorstep(town.stage.center, house) : undefined;
}

// ───────────────────────────────────────────────────────────────────────────
// Rendering the existing probe answers as text
// ───────────────────────────────────────────────────────────────────────────

/** A `GoingDest` as one line. Same five kinds the dialogue layer speaks. */
export function goingText(d: GoingDest | undefined): string {
  if (!d) return "";
  switch (d.kind) {
    case "fetch":
      return `get ${d.good}`;
    case "home":
      return "home";
    case "place":
      return d.place;
    case "room":
      return d.room;
    case "activity":
      return d.object ? `${d.verb} ${d.object}` : d.verb;
  }
}

const clauseText = (c: PhraseSpec | undefined): string =>
  c ? [c.subject, c.verb, c.object, c.tail?.join, c.tail?.symbol].filter(Boolean).join(" ") : "";

/**
 * THE WHY-CHAIN AS ITS CLAUSE LIST — `reasonChainOf`'s rungs, rendered in the
 * order it walked them, each prefixed by the rung KIND so a reader can see the
 * ladder's shape (activity → because → authority/motive → end). Never
 * re-derived and never re-worded: this only prints what the probe returned.
 */
export function whyLines(chain: ReasonLink[] | undefined): string[] {
  if (!chain?.length) return [];
  return chain.map((link) =>
    link.kind === "end" ? "end" : `${link.kind}: ${clauseText(link.clause)}`,
  );
}

/** A carry view (`carryOf`) as "bread×2, basket×1", or "" when empty-handed. */
export function carryText(carry: Record<string, number> | undefined): string {
  const parts = Object.entries(carry ?? {})
    .filter(([, n]) => n > 0)
    .map(([g, n]) => `${g}×${n}`);
  return parts.join(", ");
}

/** THE THING IN THE HANDS, as the readout needs it. */
export interface HandsObject {
  /** The world object id — the same id `carriedBy` is stamped against. */
  objId: string;
  glyph: string;
  /** A portable container (basket, satchel): what it holds IS the merged view,
   *  and the bag itself never appears there. */
  bag: boolean;
}

/**
 * ⚖️ HANDS COME FROM `carriedBy`, NEVER `carryOf()` (text-mode watch.ts states
 * the rule; this readout used to break it).
 *
 * `carryOf` is `bodyCarryView`, which DELIBERATELY drops the held bag object —
 * "the shelf, not the goods". Correct for deciding (the haul loop prices what a
 * body can eat and deposit, not what it swings from its arm) and a LIE in a
 * readout: an empty basket in the hands read "(nothing)", and a full one named
 * only its contents, so the one object that explains a stalled errand was the
 * one object the panel never showed.
 *
 * The scan is `bodyCarryOf`'s own: the registered loose props (`smallProps`),
 * matched on `carriedBy`, with a PORTABLE CONTAINER WINNING the slot when a
 * body is somehow holding more than one thing. Read-only — a `get`/`find` pass
 * over live state, like everything else here.
 */
export function handsObjectOf(
  session: QuestSession,
  state: InspectState | null | undefined,
  cid: string,
): HandsObject | undefined {
  const bodyId = bodyOf(state, cid)?.id;
  const objects = state?.objects;
  if (!bodyId || !objects) return undefined;
  let first: HandsObject | undefined;
  for (const [objId, rec] of session.smallProps) {
    if (objects[objId]?.carriedBy !== bodyId) continue;
    const bag = !!containerDefOfGlyph(rec.glyph)?.hold;
    if (bag) return { objId, glyph: rec.glyph, bag };
    first ??= { objId, glyph: rec.glyph, bag };
  }
  return first;
}

/**
 * THE CARRY ROW: the object in the hands FIRST, then what the body's containers
 * hold (`carryOf`'s merged view).
 *
 *   basket (empty)              — the whole story of a failed errand
 *   basket [apple×1, water×1]   — the bag, and what is in it
 *   apple                       — a loose thing in the hand, counted once
 *   apple · bread×2             — …and a worn satchel behind it
 *   (nothing)                   — genuinely empty-handed
 *
 * A NON-BAG hands instance is ALREADY one unit of the merged view, so it is
 * subtracted before the remainder is printed — saying "apple" twice would read
 * as two apples.
 */
export function carryRowText(
  hands: HandsObject | undefined,
  carry: Record<string, number> | undefined,
): string {
  const stock = carryText(carry);
  if (!hands) return stock || "(nothing)";
  if (hands.bag) return stock ? `${hands.glyph} [${stock}]` : `${hands.glyph} (empty)`;
  const rest = carryText({ ...(carry ?? {}), [hands.glyph]: (carry?.[hands.glyph] ?? 0) - 1 });
  return rest ? `${hands.glyph} · ${rest}` : hands.glyph;
}

// ───────────────────────────────────────────────────────────────────────────
// The readout
// ───────────────────────────────────────────────────────────────────────────

/** WHAT IS DRIVING THIS BODY, in the loop's own priority order — the same
 *  first-match ladder `reasonChainOf` walks, collapsed to one line. */
function taskLineOf(session: QuestSession, cid: string): string {
  const hold = session.actionHold.get(cid);
  if (hold) {
    return `ACTING ${hold.label} ${Math.round((hold.t / hold.dur) * 100)}%${hold.applied ? " (effect landed)" : ""}`;
  }
  const claimed = session.taskPool?.claimedBy(cid);
  if (claimed) return `pooled task "${claimed.sourceGlyph ?? claimed.goal.kind}" from ${claimed.issuer}`;
  const pursuit = session.pursuits.get(cid);
  if (pursuit) {
    return `${pursuit.source} pursuit "${pursuit.glyph}" (${pursuit.goal.kind}, acts ${pursuit.acts ?? 0})`;
  }
  const step = session.needStep.get(cid);
  if (step) {
    return `need step ${step.kind} ${step.goodKey || step.affords || ""}×${step.units} @ ${step.objId ?? "in place"} [${step.tplKey}]`;
  }
  const blocked = session.blockedNeeds.get(cid);
  if (blocked) return `BLOCKED want ${blocked.goodKey} (${blocked.tplKey}) — can't be served here`;
  const help = session.helpOrders.get(cid);
  if (help) return `helping ${help}`;
  return "";
}

/** EVERY CLAIM THIS BODY HOLDS: the household errand claim (one job the home
 *  wants done once) and its unit reservations (`need:<cid>` in the ledger). */
function claimLineOf(session: QuestSession, cid: string): string {
  const parts: string[] = [];
  for (const [key, holder] of session.errandClaims) {
    if (holder === cid) parts.push(`errand ${key}`);
  }
  for (const row of session.needClaims.holderRows(`need:${cid}`)) {
    parts.push(`${row.glyph}×${row.qty} @ ${row.endpoint}`);
  }
  return parts.join(", ");
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Speed below which a body is braking or jitter, not traveling — the same
 *  reading quest-host's `bodyWalking` takes (its `GOING_SPEED_MIN`). */
const WALKING_SPEED_MIN = 0.15;

/** Does this avatar id name a CREATURE body? Residents and pets are their own
 *  cid; everything else rides `npc_<cid>` (quest-host `avatarIdOf`). The
 *  player's own body and any formless spark avatar are neither. */
const isCreatureAvatarId = (id: string): boolean =>
  id.startsWith("resident_") || id.startsWith("pet_") || id.startsWith("npc_");

/** The unfulfilled wants the creature world holds for this body, as words. */
function wantsOf(session: QuestSession, cid: string): string[] {
  return (session.creatures?.world.creatures[cid]?.needs ?? [])
    .filter((n) => !n.fulfilled)
    .map((n) => n.target?.category ?? n.target?.kind ?? n.itemId)
    .filter((w): w is string => !!w);
}

/**
 * THE COLLAPSED ROW'S ONE-LINER — id, name, condition, wants, whether there is
 * a body at all, and the schedule phase.
 *
 * Split out from `inspectCreature` on purpose: a list re-renders several times a
 * second and every row needs this, while only the OPEN row needs the detail. So
 * this asks NONE of the expensive probes — no why-chain walk, no place-word
 * lookup — and a hundred collapsed rows cost what the old flat list cost.
 */
export function summarizeCreature(
  session: QuestSession,
  cid: string,
  probes: InspectProbes = {},
): string {
  const name = probes.nameOf?.(cid);
  const condition = session.creatures?.world.creatures[cid]?.condition;
  const wants = wantsOf(session, cid).join(",");
  const schedule = schedulePhaseOf(session, cid).replace(/^\s*·\s*/, "").trim();
  return (
    `${cid}${name ? ` “${name}”` : ""}` +
    `${condition ? ` [${condition}]` : ""}` +
    `${wants ? ` want:${wants}` : ""}` +
    `${bodyOf(probes.state, cid) ? "" : " ⏸ abstracted"}` +
    `${schedule ? ` · ${schedule}` : ""}`
  );
}

/**
 * ONE CREATURE, DESCRIBED. Read-only over `session` + `probes`.
 *
 * The two shapes of answer, and why they differ:
 *   • EMBODIED — position, the place word covering it, and how far it is from
 *     its own doorstep. The question a stuck shopper is really asking.
 *   • ABSTRACTED — no body, so no position to give: the SCHEDULE PHASE stands
 *     in (the goods clock is time-pure and answers with no body at all), and
 *     the row says ABSTRACTED outright rather than leaving a blank.
 */
export function inspectCreature(
  session: QuestSession,
  cid: string,
  probes: InspectProbes = {},
): CreatureInspection {
  const found = bodyOf(probes.state, cid);
  const creature = session.creatures?.world.creatures[cid];
  const name = probes.nameOf?.(cid);
  const schedule = schedulePhaseOf(session, cid).replace(/^\s*·\s*/, "").trim();
  const rows: InspectRow[] = [];
  const add = (label: string, value: string) => {
    if (value) rows.push({ label, value });
  };

  add("body", found ? `embodied (${found.id})` : "ABSTRACTED — no body in the world");
  if (found) {
    const p = found.body;
    const place = placeWordAt(session, cid, p);
    const home = homePointOf(session, cid);
    add(
      "position",
      `${round1(p.x)}, ${round1(p.y)}` +
        (place ? ` · ${place}` : "") +
        (home ? ` · ${round1(Math.hypot(p.x - home.x, p.y - home.y))} m from home` : ""),
    );
    const path = probes.errandPath?.(found.id);
    const speed = Math.hypot(p.vx ?? 0, p.vy ?? 0);
    add(
      "motion",
      path?.dwelling
        ? "dwelling (standing at a waypoint)"
        : speed > WALKING_SPEED_MIN
          ? `walking (${round1(speed)} m/s)`
          : "still",
    );
  }
  // The schedule ALWAYS shows for a resident — it is the only answer an
  // abstracted body has, and beside an embodied one it is the clock the body
  // is (or is not) keeping up with.
  add("schedule", schedule || (cid.startsWith("resident_") ? "homebody (no duty)" : ""));

  const act = probes.activityOf?.(cid);
  add("activity", act ? (act.object ? `${act.verb} ${act.object}` : act.verb) : "");
  add("going", goingText(session.npcGoing.get(cid)));
  // ⚖️ THE HANDS FIRST, from `carriedBy` — see `handsObjectOf`. The merged view
  // alone reported an empty basket as "(nothing)".
  add("carrying", carryRowText(handsObjectOf(session, probes.state, cid), probes.carryOf?.(cid)));
  add("task", taskLineOf(session, cid));
  add("claims", claimLineOf(session, cid));

  add("condition", creature?.condition ?? "");
  add("wants", wantsOf(session, cid).join(", "));
  add(
    "meters",
    [...session.needMeters]
      .filter(([k]) => k.startsWith(`${cid}|`))
      .map(([k, v]) => `${k.slice(cid.length + 1)} ${Math.round(v * 100) / 100}`)
      .join(", "),
  );
  add(
    "flags",
    [
      session.party.has(cid) ? "party" : "",
      session.escorting.has(cid) ? "escorting" : "",
      session.bondedCreatures.has(cid) ? "bonded" : "",
      session.addressedFamily === cid ? "addressed" : "",
      session.liveNeedBodies.has(cid) ? "liveNeedBody" : "",
      session.wornBags.has(cid) ? `wearing ${session.wornBags.get(cid)!.glyph}` : "",
    ]
      .filter(Boolean)
      .join(", "),
  );

  return {
    cid,
    ...(name ? { name } : {}),
    summary: summarizeCreature(session, cid, probes),
    embodied: !!found,
    rows,
    why: whyLines(probes.whyProbe?.(cid)),
  };
}

/**
 * WHO THE PANEL LISTS. The family and its pets by name (they exist whether or
 * not anything registered them yet — an abstracted member that was never spoken
 * to still has a schedule), plus every creature the session HAS registered and
 * every body the live needs loop is driving. The remaining hosted bodies are
 * counted, never enumerated (law ⑤).
 */
export function inspectRoster(session: QuestSession, probes: InspectProbes = {}): InspectRoster {
  const named: string[] = [];
  const seen = new Set<string>();
  const push = (cid: string) => {
    if (!seen.has(cid)) {
      seen.add(cid);
      named.push(cid);
    }
  };
  const fam = session.town?.config.family;
  const house = session.town?.familyHouse ?? null;
  if (fam && house !== null) {
    fam.members.forEach((_m, i) => push(`resident_${house}_${i}`));
    (fam.pets ?? []).forEach((_p, i) => push(`pet_${house}_${i}`));
  }
  for (const cid of Object.keys(session.creatures?.world.creatures ?? {})) push(cid);
  for (const cid of session.liveNeedBodies) push(cid);

  let ambient = 0;
  for (const id of Object.keys(probes.state?.avatars ?? {})) {
    if (!isCreatureAvatarId(id)) continue; // the player's own body is not a cohort
    const cid = id.startsWith("npc_") ? id.slice(4) : id;
    if (!seen.has(cid)) ambient++;
  }
  return { named, ambient };
}
