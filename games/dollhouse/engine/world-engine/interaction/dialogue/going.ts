// WHERE ARE YOU GOING — turning a live errand STEP into the destination a
// creature answers with. Pure: the host reduces its world (bodies, fixtures,
// the house's room plan) to the shapes below and phrases whatever comes back.
//
// Two rules live here, both learned from the answer reading as nonsense:
//
//  ① ARRIVED IS NOT GOING. A step lives on through the whole episode — the
//    walk, the crouch, the nap's dwell — so HAVING one says nothing about
//    traveling. A body standing at its spot (or pinned onto the fixture it is
//    using) is DOING the thing, and gets no destination at all: the ask then
//    disappears from the board, which is the honest state of affairs.
//
//  ② A BODY INSIDE ITS OWN HOUSE IS NEVER "GOING HOME". Households spend most
//    of their day moving between ROOMS. Such a walk answers with the room
//    ("I'm going to the bedroom"), or — where the room has no word worth
//    speaking, the living room's word being "home" itself — with what the
//    errand is FOR ("I will eat"). "Home" is reserved for the walk that ends
//    inside a house the body is not in yet.

import type { GoingDest } from "./creature-dialogue.js";
import { needActivity } from "./intent-lines.js";
import { headOf } from "../../variations.js";

export interface GoingRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A room of the speaker's OWN home. `word` = the glyph to speak as a
 *  destination; absent for rooms whose word is "home"/"room" (the living room,
 *  a hall) — a room that can't name itself defers to the activity. */
export interface GoingRoom {
  rect: GoingRect;
  word?: string;
}

/** A live need step, reduced to what naming its destination needs. */
export interface GoingStep {
  /** The step's move: take / deposit / drop / consume / rest / process / socialize. */
  kind: string;
  /** The need template driving it — the ACTIVITY word comes from its motive. */
  tplKey: string;
  /** The good in hand or being fetched (may be empty for affordance steps). */
  goodKey: string;
  /** Where the step ENDS (the fixture it uses, else the stand spot walked to). */
  at: { x: number; y: number };
}

/** The body doing it. `using` = pinned onto the fixture of this very step. */
export interface GoingBody {
  x: number;
  y: number;
  using?: boolean;
}

/** A resident's SCHEDULED business as the household roster knows it — the
 *  shopping trip off the goods clock, or a work shift. */
export type ScheduledTrip =
  | { kind: "shopping"; phase: "to_source" | "at_source" | "to_home"; good: string }
  | { kind: "shift" };

/**
 * THE SCHEDULE PROPOSES, THE BODY DECIDES — what a roster trip answers as a
 * destination.
 *
 * `walking` is the body's own truth, and `false` (we can SEE it standing still)
 * overrules the clock: a stopped body is shopping AT the stall and working AT
 * its bench, not travelling, so there is nothing to answer and the ask leaves
 * the board. Undefined = there is no body to ask (off-show), where the schedule
 * is all anyone has and is trusted as-is.
 */
export function tripDestination(trip: ScheduledTrip, walking: boolean | undefined): GoingDest | undefined {
  if (walking === false) return undefined;
  if (trip.kind === "shift") return { kind: "place", place: "work" };
  return trip.phase === "to_home" ? { kind: "home" } : { kind: "fetch", good: trip.good };
}

/** The ACTIVITY a step performs. The physical moves speak their own verb (a
 *  take is getting, a deposit is putting — the motive behind them is one remove
 *  away: a restocking trip is not "eating"); everything else speaks its
 *  motive's frame, because the step at the bed IS sleeping. */
export function stepActivity(step: Pick<GoingStep, "kind" | "tplKey" | "goodKey">):
  | { verb: string; object?: string }
  | undefined {
  const head = step.goodKey ? headOf(step.goodKey) : undefined;
  if (step.kind === "take") return { verb: "get", ...(head ? { object: head } : {}) };
  if (step.kind === "deposit" || step.kind === "drop") return { verb: "put", ...(head ? { object: head } : {}) };
  return needActivity(step.tplKey);
}

/** Is this point inside one of the home's rooms — and which? */
export function roomAt(rooms: readonly GoingRoom[], p: { x: number; y: number }): GoingRoom | undefined {
  return rooms.find(
    (r) => p.x >= r.rect.x && p.x <= r.rect.x + r.rect.w && p.y >= r.rect.y && p.y <= r.rect.y + r.rect.h,
  );
}

/**
 * The destination a creature on this step answers "where are you going?" with,
 * or undefined when it is not going anywhere (see rule ① above) — which also
 * takes the question off the board.
 *
 * `rooms` are the speaker's OWN home, in world coordinates; `arrive` is the
 * walker's arrival radius, so "there" here means exactly what the walker means.
 */
export function stepDestination(
  step: GoingStep,
  body: GoingBody,
  rooms: readonly GoingRoom[],
  arrive: number,
): GoingDest | undefined {
  if (body.using) return undefined; // at the fixture, using it
  if (Math.hypot(body.x - step.at.x, body.y - step.at.y) <= arrive) return undefined; // standing there
  // A take is a SHOPPING trip: the good it is after is the answer, wherever the
  // source happens to stand ("I'm going to get food").
  if (step.kind === "take") return { kind: "fetch", good: step.goodKey };
  const destRoom = roomAt(rooms, step.at);
  // Genuinely heading back: the walk ends in the house, the body isn't in it.
  if (destRoom && !roomAt(rooms, body)) return { kind: "home" };
  if (destRoom?.word) return { kind: "room", room: destRoom.word };
  const act = stepActivity(step);
  return act ? { kind: "activity", ...act } : undefined;
}
