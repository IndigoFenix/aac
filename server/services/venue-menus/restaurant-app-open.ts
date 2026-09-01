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
//   caretaker — nothing else is available. Show the companion's half.
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
import {
  CUISINE_CATEGORIES,
  matchCuisineCategory,
  venueServes,
  type RestaurantAppPayload,
} from "@shared/venue-cuisine";
import {
  resolveBoundVenue,
  resolveStudentVenueBoard,
  resolveVenueBoardById,
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
    // it yet, it is in review, it aged out, or it refined down to nothing.
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
    // It used to return the caretaker lane here, so anyone who reached the app
    // with browsing off got a companion's text screen: a paragraph they cannot read,
    // a button that starts a camera, and nothing they can say. That was the
    // DEFAULT, because `studentBrowse` ships false.
    //
    // `canSearch: false` means the grid is purely a vocabulary board: every
    // button still speaks, nothing goes out to the network.
    //
    // ⚖️ THIS DOES NOT DEPEND ON WHO ASKED. It briefly did — student presses got
    // the grid, AI opens still got the caretaker lane and were refused by
    // routeAppOpen's gate. Observed 2026-08-27, that was wrong in the case it
    // most needed to be right: the student composed "I want to go to a
    // restaurant" in the sentence builder, picked a hamburger off the board the
    // AI offered, and got nothing three times running — because an utterance
    // reaches the app through the Speaker's open_app, which is an "ai" trigger.
    // A child asking to go to a restaurant is the clearest possible case FOR
    // opening it.
    //
    // Whether the AI should be opening this app at all is `aiOpenPolicy`'s
    // question, asked by a dedicated model that had already said yes. A second,
    // blunter gate keyed on an unrelated setting was overruling it.
    if (!settings.studentBrowse) {
      return {
        mode: "search",
        canSearch: false,
        positionKnown: false,
        categories: [],
        places: [],
        food: matchCuisineCategory(input.data)?.key ?? null,
      };
    }

    // ── a NAMED place ──
    //
    // `data` may name a VENUE rather than a food: the student pressed
    // "לה פיצליה" on the places grid (client token `venue:<id>`), or told the
    // AI they want to go there and the Speaker passed the name. Before this
    // existed the name fell through the cuisine matcher, matched nothing, and
    // the app RE-OPENED ON THE FOOD GRID — observed live 2026-09-01: the
    // student chose a restaurant, the AI said "we'll open it for you", and the
    // screen reset to "what do you want to eat?".
    //
    // A known venue with an approved menu opens that menu as a PREVIEW —
    // looked at, not bound. Same gates as the at-the-table path (approved
    // only, staleness window, allergen filter — see resolveVenueBoardById);
    // no floor board, because "this is too hot" is a sentence for a table
    // they are not at.
    //
    // Checked BEFORE the cuisine matcher, and the name matcher is
    // exact-match-only, so a plain "פיצה" still reaches the pizza grid rather
    // than whichever pizzeria happens to contain the word.
    const requested = await venueBrowseService.resolveNamedVenue(
      student.id,
      input.data,
      input.gps ?? null,
      settings.browseRadiusM,
    );
    let requestedVenueName: string | undefined;
    if (requested) {
      const preview = await resolveVenueBoardById(student, requested.id, now);
      if (preview) {
        return {
          mode: "menu",
          preview: true,
          venueName: preview.venueName,
          menuBoard: preview.board,
        };
      }
      // We know the place; there is just no menu a student may see. Do NOT
      // fall back to the bare grid as if they had never asked — keep their
      // context: open on that venue's kind of food so the place they named is
      // on the screen, and carry the name so the Speaker says what happened.
      requestedVenueName = requested.name;
    }
    const requestedVenueId = requested?.id;

    // A word the AI passed, turned into a category — or null, which opens the
    // full grid rather than a guess. When a menu-less venue was named, its own
    // cuisine wins: "opened on pizza places, including the one you asked for".
    const category =
      (requested ? CUISINE_CATEGORIES.find((c) => venueServes(requested, c)) : null) ??
      matchCuisineCategory(input.data);

    if (!input.gps) {
      // No position: the grid is still a vocabulary board and every press still
      // speaks. Categories are left empty so the client shows all of them —
      // filtering to "nearby" is meaningless when we do not know where we are.
      //
      // `positionKnown: false` is what stops the empty result being REPORTED as
      // a fact. Without it this branch and a real search that came back empty
      // are indistinguishable downstream, and both said "nothing nearby serves
      // pizza" — a claim about the world made from a lookup that never ran.
      return {
        mode: "search",
        canSearch: true,
        positionKnown: false,
        categories: [],
        places: [],
        food: category?.key ?? null,
        ...(requestedVenueName ? { requestedVenueName, requestedVenueId } : {}),
      };
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
      positionKnown: true,
      categories: result.categories,
      places: result.places,
      food: category?.key ?? null,
      ...(requestedVenueName ? { requestedVenueName, requestedVenueId } : {}),
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
 * It also never mentions allergies — PHI never reaches a model's context
 * (§3.3), and since 2026-09-01 no allergen filtering runs on the board at all.
 */
export function restaurantOpenNote(payload: RestaurantAppPayload): string {
  if (payload.mode === "menu") {
    // A PREVIEW is a different sentence from a table. The student picked a
    // place they WANT; nothing narrated may imply they are there or that
    // anything is arranged.
    if (payload.preview) {
      return (
        `[RESTAURANT] The student chose ${payload.venueName ?? "a restaurant"} and its menu is ` +
        `now on screen for them to LOOK at. They are NOT there — nothing is booked and nobody ` +
        `has taken them anywhere. Talk about what they might like to eat there. Do NOT name ` +
        `specific dishes — you cannot see which ones are on their board, and naming one that ` +
        `is not there asks a child to press a button that does not exist.`
      );
    }
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

    // A fetch for the named venue's menu is RUNNING. The student is looking
    // at a "getting the menu…" screen; the Speaker narrates the wait honestly
    // — it may take up to a minute, and the result may be nothing.
    if (payload.fetchingMenu) {
      return (
        `[RESTAURANT] The student chose ${payload.fetchingMenu.venueName} and its menu is being ` +
        `FETCHED right now — the screen says so. This can take up to a minute and may fail. ` +
        `Tell the user you are getting the menu. Do NOT describe any dishes, and do not promise ` +
        `it will arrive; you will be told when it does or does not.`
      );
    }

    // A fetch for the named venue's menu just FAILED (or the menu is waiting
    // on review). Say it plainly — the screen shows it too.
    if (payload.menuFetchFailed) {
      return (
        `[RESTAURANT] The menu for ${payload.menuFetchFailed} could not be shown — it was not ` +
        `found, could not be read, or is waiting for a caretaker's check. Say that plainly and ` +
        `warmly. Do NOT describe its dishes or offer to try again.`
      );
    }

    // The student named a PLACE we know, and it has no menu they may see —
    // never captured, waiting on review, or stale. Say that plainly. The alternative is the Speaker narrating the
    // grid as if the student had never asked for anywhere, which reads to the
    // child as being ignored.
    if (payload.requestedVenueName) {
      return (
        `[RESTAURANT] The student asked about ${payload.requestedVenueName}. That place has no ` +
        `menu loaded for them yet, so the screen shows nearby food choices instead` +
        `${payload.food ? ` (opened on ${payload.food})` : ""}. Say plainly that its menu is not ` +
        `here yet — a companion can add it at the restaurant. Do NOT describe its dishes, and do ` +
        `not promise to fetch the menu.`
      );
    }

    // 🚨 WE NEVER LOOKED. `positionKnown: false` means the device location
    // setting is off, the reading failed, or nothing has reported a position —
    // so `places` is empty because no search ran, not because the street is
    // empty. Observed 2026-09-01: the note below said "Nothing nearby serves
    // pizza", the Speaker duly told a child there was no pizza place near him,
    // and the lookup had never happened. Checked before the food branches for
    // exactly that reason.
    if (payload.positionKnown === false) {
      return (
        `[RESTAURANT] Showing the food grid so the student can say what they feel like eating` +
        `${payload.food ? ` (it opened on ${payload.food})` : ""}. ` +
        `We do NOT know where the student is, so no search for nearby places has run. ` +
        `Talk about the FOOD. If they ask where they could go, say you do not know where they ` +
        `are right now — do NOT say there is nothing nearby, and do not name a place.`
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
    `[RESTAURANT] Opened on the companion's screen — finding the restaurant and photographing ` +
    `its menu is the companion's job. There is no menu for the student yet, so do not offer to ` +
    `read one.`
  );
}
