// server/services/venue-menus/restaurant-app-open.ts
//
// WHAT `open_app("restaurant", …)` ACTUALLY OPENS.
//
// The restaurant system is an APP, and this is the server-side resolution that
// makes it behave like one. It mirrors the `photos` and `picture_search`
// branches of routeAppOpen exactly: the AI says what the student wants, the
// server decides what can be shown, and the Speaker is told what actually
// appeared so it cannot narrate a screen that never opened.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE MODE IS NOT THE MODEL'S TO CHOOSE
//
// Three modes, and only this side has the facts to pick between them:
//
//   menu      — a venue is bound and its menu passed review. Show the food.
//   floor     — a venue is bound but has no usable menu yet. Show the generic
//               eating-out words, which is what "the floor board always exists"
//               (§3 requirement 4) actually means: the student is SEATED, and
//               they need to say "hungry" and "this is too hot" long before
//               anyone has photographed anything.
//   search    — not at a venue. Show what kinds of food are nearby.
//   caretaker — nothing else is available. Show the adult's half.
//
// The AI knows the student said "pizza". It does not know whether a caretaker
// confirmed a venue an hour ago, whether that venue's menu is still inside its
// staleness window, whether a clinician enabled browsing, or what the child is
// allergic to. Letting it name the mode would let it open a menu that does not
// exist — which for a nonverbal student means a promise nobody can keep.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE MENU WINS WHEN THERE IS ONE
//
// If a venue is bound, `data` does NOT divert to search. A student sitting in a
// restaurant who says "pizza" wants the pizza on THIS menu, not a list of other
// restaurants they are not in. Wanting to go elsewhere is a caretaker action,
// and the caretaker lane is one press away.
//
// See planning-docs/aac-restaurant-menus.md §4.1a, §4.6.

import type { GeoPoint } from "@shared/location-matching";
import { resolveVenueMenuSettings } from "@shared/venue-menus";
import { matchCuisineCategory, type RestaurantAppPayload } from "@shared/venue-cuisine";
import {
  resolveBoundVenue,
  resolveStudentVenueBoard,
  describeVenueBoardStats,
  type VenueBoardStudent,
} from "./venue-board-service.js";
import { buildRestaurantFloorBoard } from "../dual-agent/restaurant-floor-board.js";
import { venueBrowseService } from "./venue-browse-service.js";

/** The app id in the registry. */
export const RESTAURANT_APP_ID = "restaurant";

export interface RestaurantOpenInput {
  student: VenueBoardStudent | null;
  /** Last known position, from the Monitor's `gps_update` stream. May be
   *  absent — iPad/Capacitor sessions do not send it, and the search grid is
   *  built to work without one. */
  gps?: GeoPoint | null;
  /** Whatever the AI passed as `data`: the food the student named. */
  data?: string | null;
  /**
   * Who asked. A STUDENT press is the child tapping the app themselves; "ai" is
   * the Speaker or Board Manager choosing to open it.
   *
   * It changes only ONE thing — where a student lands when they may not search
   * for venues (see the studentBrowse note below). Defaults to "ai", the
   * conservative side: an unmarked caller gets the old gated behaviour rather
   * than silently handing a screen to a child.
   */
  trigger?: "ai" | "student";
}

/**
 * Resolve one restaurant-app open.
 *
 * Never throws and never returns nothing: a student pressed a launch button, so
 * the screen must change. The worst case is the caretaker lane, which is a real
 * screen with real buttons rather than an error.
 */
export async function resolveRestaurantOpen(
  input: RestaurantOpenInput,
  now: Date = new Date(),
): Promise<RestaurantAppPayload> {
  const { student } = input;
  if (!student) return { mode: "caretaker", reason: "no_menu" };

  try {
    // ── menu mode ──
    // The floor board rides along: a menu can say "chicken soup" and cannot say
    // "this is too hot", so the words a seated child needs most are one press
    // away rather than in a different app.
    const resolved = await resolveStudentVenueBoard(student, now);
    if (resolved) {
      return {
        mode: "menu",
        venueName: resolved.venueName,
        menuBoard: resolved.board,
        floorBoard: buildRestaurantFloorBoard(),
      };
    }

    const settings = resolveVenueMenuSettings(
      student.aacSettings?.venueMenus,
      {
        birthDate: student.birthDate,
        languageLevel: student.aacSettings?.languageLevel ?? null,
      },
      now,
    );
    if (!settings.enabled) return { mode: "caretaker", reason: "no_menu" };

    // ── floor mode ──
    // A venue is bound but no approved menu came back — nobody has photographed
    // it yet, it is in review, it aged out, or the allergen filter emptied it.
    // The student is still sitting at the table. Eight words they already know
    // beats a search for somewhere they are not.
    const bound = await resolveBoundVenue(student, now);
    if (bound) {
      return {
        mode: "floor",
        venueName: bound.venueName,
        floorBoard: buildRestaurantFloorBoard(),
      };
    }

    // ── search mode ──
    //
    // 🚨 `studentBrowse` GATES THE SEARCH, NOT THE VOCABULARY. Its own label to
    // clinicians is "Student can look for somewhere to eat" — it is about
    // spending an outbound venue lookup and revealing where the child is, not
    // about whether they are allowed to say "I want pizza".
    //
    // It used to return the caretaker lane here, so a child who pressed the app
    // tile with browsing off got an adult text screen: a paragraph they cannot
    // read, a button that starts a camera, and nothing they can say. That is
    // the worst outcome an AAC surface can produce — a dead press for someone
    // who cannot ask what went wrong — and it was the DEFAULT, because
    // `studentBrowse` ships false.
    //
    // So a student press always gets the grid. `canSearch: false` means it is
    // purely a vocabulary board: every button still speaks, nothing goes out to
    // the network. An AI-initiated open still lands on the caretaker lane and
    // is refused by routeAppOpen's gate — the AI wanting a restaurant on the
    // child's behalf is exactly the case that gate exists for, and the child
    // pressing the tile is exactly the case it must not touch.
    if (!settings.studentBrowse) {
      if (input.trigger !== "student") {
        return { mode: "caretaker", reason: "browse_off" };
      }
      return {
        mode: "search",
        canSearch: false,
        categories: [],
        places: [],
        food: matchCuisineCategory(input.data)?.key ?? null,
      };
    }

    // A word the AI passed, turned into a category — or null, which opens the
    // full grid rather than a guess.
    const category = matchCuisineCategory(input.data);

    if (!input.gps) {
      // No position: the grid is still a vocabulary board and every press still
      // speaks. Categories are left empty so the client shows all of them —
      // filtering to "nearby" is meaningless when we do not know where we are.
      return { mode: "search", canSearch: true, categories: [], places: [], food: category?.key ?? null };
    }

    const result = await venueBrowseService.browse(
      {
        studentId: student.id,
        gps: input.gps,
        settings,
        category: category?.key ?? null,
      },
      now,
    );

    return {
      mode: "search",
      canSearch: true,
      categories: result.categories,
      places: result.places,
      food: category?.key ?? null,
    };
  } catch (error) {
    console.error("[restaurant-app] open failed:", (error as Error)?.message);
    return { mode: "caretaker", reason: "no_menu" };
  }
}

/**
 * What the Speaker is told after the app opens.
 *
 * Same contract as the picture-search note: describe what is ON THE SCREEN, so
 * the Speaker talks about the thing that actually appeared. It deliberately
 * does NOT list dish names — a menu can be sixty rows, the Speaker does not
 * need them to talk about lunch, and every one of them would be tokens on
 * every subsequent turn.
 *
 * It also never mentions allergies. The filter already removed what it removed;
 * naming it here would put PHI into a model's context to no purpose.
 */
export function restaurantOpenNote(payload: RestaurantAppPayload): string {
  if (payload.mode === "menu") {
    return (
      `[RESTAURANT] The menu for ${payload.venueName ?? "this restaurant"} is now on screen and ` +
      `the student can order from it. Talk about choosing food. Do NOT name specific dishes — ` +
      `you cannot see which ones are on their board, and naming one that is not there asks a ` +
      `child to press a button that does not exist.`
    );
  }

  if (payload.mode === "floor") {
    return (
      `[RESTAURANT] ${payload.venueName ?? "This restaurant"} has no menu the student can use ` +
      `yet, so they have the basic eating-out words — hungry, thirsty, more, finished, too hot, ` +
      `yuck, bathroom, help. Talk about the meal. Do NOT offer to read them a menu, and do not ` +
      `describe dishes: nobody has photographed one.`
    );
  }

  if (payload.mode === "search") {
    const count = payload.places?.length ?? 0;
    const kinds = payload.categories?.length ?? 0;

    // Searching is switched off for this student, so the grid is vocabulary and
    // nothing else. The Speaker has to be told, or it offers to find them a
    // pizza place — a promise the screen cannot keep and the child cannot
    // question. Checked FIRST: the food/place branches below all assume a
    // search either happened or could.
    if (payload.canSearch === false) {
      return (
        `[RESTAURANT] Showing the food grid so the student can say what they feel like eating` +
        `${payload.food ? ` (it opened on ${payload.food})` : ""}. ` +
        `Looking up nearby places is turned OFF for this student, so there are no restaurants ` +
        `on screen. Talk about the FOOD. Do NOT offer to find, name, or suggest anywhere to go.`
      );
    }

    if (payload.food && count > 0) {
      return (
        `[RESTAURANT] Showing ${count} place${count === 1 ? "" : "s"} nearby serving ` +
        `${payload.food}. The student is choosing where they would LIKE to go — nothing is ` +
        `booked and no menu is open. Nobody has taken them anywhere yet.`
      );
    }
    if (payload.food) {
      return (
        `[RESTAURANT] Nothing nearby serves ${payload.food}. The student can still say what ` +
        `they want. Say plainly that you could not find one close by, and do not invent a place.`
      );
    }
    return (
      `[RESTAURANT] Showing a grid of ${kinds || "the"} kinds of food, for the student to pick ` +
      `what they feel like. Nothing is booked and no menu is open.`
    );
  }

  return (
    `[RESTAURANT] Opened on the grown-up's screen — finding the restaurant and photographing ` +
    `its menu is the caretaker's job. There is no menu for the student yet, so do not offer to ` +
    `read one.`
  );
}
