// server/services/venue-menus/venue-board-service.ts
//
// THE CALL SITE FOR `buildVenueMenuBoard` (§4.1a, §4.6).
//
// Reached from ONE place: `restaurant-app-open.ts`, resolving menu mode for
// `open_app("restaurant")`. The menu is not a board key and is not raised by
// `set_board` — the restaurant system is an app, and its menu is what the app
// renders when a venue is bound. An earlier build registered it as a virtual
// board alongside the floor board; that made the LAUNCH path board-shaped for
// something every other surface reaches through the app registry, so it went.
//
// Steps 1-7 built every piece of the pipeline and left the last inch missing:
// a caretaker could photograph a menu, a clinician could approve it, and the
// student still could not order from it, because nothing ever asked the board
// builder for a board. This file is that ask.
//
// It answers one question — "what should the menu board show for THIS student,
// right now?" — and it answers it LATE, at the moment the board is opened,
// never at session start. That is deliberate. The interesting case for this
// feature is a caretaker photographing a menu at the table, mid-session: bind
// the contents early and the board a student opens is the one that existed
// before they sat down.
//
// ─────────────────────────────────────────────────────────────────────────────
// TWO ENTRY POINTS, AND WHY THEY ARE SEPARATE
//
//   `resolveBoundVenue`       — cheap. Which venue, and is there a menu? Used
//                               at prompt build, so the Board Manager can be
//                               told the board exists and what it is called.
//   `resolveStudentVenueBoard`— the whole board. Used on open.
//
// The split is not just cost. `resolveBoundVenue` deliberately does NOT read
// the student's allergies: the prompt-build path feeds a model, and allergies
// are PHI that must never reach one (§3.3). Keeping the PHI read inside the
// build path means there is no route by which an allergy could be prompted
// into an agent even by mistake.
//
// ─────────────────────────────────────────────────────────────────────────────
// NULL IS ALWAYS AN ANSWER, NEVER AN ERROR
//
// Every failure here — no venue, no approved menu, a stale menu, a DB outage,
// an allergen filter that removed everything — returns null, and the caller
// falls back to the floor board. Someone is standing at a table with a hungry
// child; an error screen is the one outcome that helps nobody.
//
// See planning-docs/aac-restaurant-menus.md §4.5, §4.6.

import type { ParsedBoardData } from "@shared/schema";
import { resolveVenueMenuSettings } from "@shared/venue-menus";
import { venueRepository } from "../../repositories/venueRepository.js";
import { getStudentAllergies } from "./student-allergies.js";
import {
  buildVenueMenuBoard,
  type VenueMenuBoardResult,
} from "./menu-board-builder.js";
import type { RefinedMenuItem } from "./menu-refinement.js";

/**
 * How long after a visit the venue still counts as "where we are".
 *
 * A binding is created when a caretaker picks the restaurant in the
 * RestaurantApp, and refreshed (`lastVisitedAt`) every time they pick it
 * again. Six hours covers a long meal and a session that began before anyone
 * opened the picker, while making sure last week's restaurant does not quietly
 * become today's board.
 *
 * This is a mechanism constant, not a clinical choice — nothing about a
 * particular child changes the right answer — so it is not an AAC setting. If
 * that ever stops being true it belongs in `VenueMenuSettings` like the rest.
 */
export const VISIT_WINDOW_MS = 6 * 60 * 60 * 1000;

/** The student fields this module needs. Passed in rather than fetched: both
 *  call sites already hold the row, and a re-fetch on the board-open path
 *  would add a query to a press. */
export interface VenueBoardStudent {
  id: string;
  birthDate?: string | Date | null;
  aacSettings?: { venueMenus?: unknown; languageLevel?: number | null } | null;
}

export interface BoundVenue {
  venueId: string;
  /** What to call it: the family's own label wins over the venue's name — a
   *  student knows "our pizza place", not "Pizza Hut Dizengoff". */
  venueName: string;
  menuId: string;
}

export interface ResolvedVenueBoard extends BoundVenue {
  board: ParsedBoardData;
  stats: VenueMenuBoardResult["stats"];
}

/**
 * The venue this student is currently at, if it has a menu they may see.
 *
 * "May see" is doing real work: `getActiveMenu` returns APPROVED menus only,
 * so a menu still waiting on caretaker review is invisible here — which is the
 * whole point of review. A stale menu is likewise no menu (`maxMenuAgeDays`):
 * restaurants change what they serve, and a board that offers a dish the
 * kitchen stopped making sets a child up to be told no.
 */
export async function resolveBoundVenue(
  student: VenueBoardStudent,
  now: Date = new Date(),
): Promise<BoundVenue | null> {
  try {
    const settings = resolveVenueMenuSettings(
      student.aacSettings?.venueMenus,
      {
        birthDate: student.birthDate,
        languageLevel: student.aacSettings?.languageLevel ?? null,
      },
      now,
    );
    if (!settings.enabled) return null;

    // Ordered by lastVisitedAt DESC, so the first row inside the window is the
    // most recent visit. A row with no lastVisitedAt at all has never been
    // visited — a saved favourite, not a place we are standing in.
    const links = await venueRepository.listForStudent(student.id);
    const link = links.find(
      (l) =>
        l.lastVisitedAt !== null &&
        now.getTime() - new Date(l.lastVisitedAt).getTime() <= VISIT_WINDOW_MS,
    );
    if (!link) return null;

    const menu = await venueRepository.getActiveMenu(link.venueId);
    if (!menu) return null;

    const ageDays = (now.getTime() - new Date(menu.extractedAt).getTime()) / 86_400_000;
    if (settings.maxMenuAgeDays > 0 && ageDays > settings.maxMenuAgeDays) return null;

    const venue = await venueRepository.getById(link.venueId);
    if (!venue) return null;

    return {
      venueId: venue.id,
      venueName: link.label?.trim() || venue.name,
      menuId: menu.id,
    };
  } catch (error) {
    console.error("[venue-board] bound-venue lookup failed:", (error as Error)?.message);
    return null;
  }
}

/**
 * The menu board for the student's current venue, built fresh.
 *
 * Returns null when there is nothing to show — including the case where the
 * menu exists but the allergen filter removed every item on it. That is not a
 * failure to report to the student; it is a menu with nothing on it they can
 * eat, and the floor board says more than an empty grid ever could.
 */
export async function resolveStudentVenueBoard(
  student: VenueBoardStudent,
  now: Date = new Date(),
): Promise<ResolvedVenueBoard | null> {
  const bound = await resolveBoundVenue(student, now);
  if (!bound) return null;

  try {
    const settings = resolveVenueMenuSettings(
      student.aacSettings?.venueMenus,
      {
        birthDate: student.birthDate,
        languageLevel: student.aacSettings?.languageLevel ?? null,
      },
      now,
    );

    const menu = await venueRepository.getMenuById(bound.menuId);
    if (!menu) return null;

    // The PHI read lives here and only here — see the header.
    const allergies = await getStudentAllergies(student.id);

    const result = buildVenueMenuBoard({
      venueName: bound.venueName,
      provenance: menu.provenance as "camera" | "web" | "manual",
      items: (Array.isArray(menu.items) ? menu.items : []) as RefinedMenuItem[],
      settings: {
        categoryPages: settings.categoryPages,
        showPrices: settings.showPrices,
        readingModeDefault: settings.readingModeDefault,
      },
      allergies,
    });

    if (!result.board) return null;
    return { ...bound, board: result.board, stats: result.stats };
  } catch (error) {
    console.error("[venue-board] board build failed:", (error as Error)?.message);
    return null;
  }
}

/**
 * A one-line summary of a board build, safe to write to a session log.
 *
 * Counts only. `stats.removedByAllergy` carries the TERM that matched, which
 * is the student's allergy restated — logging it would put PHI in a session
 * log to save nobody any time. How MANY items went is the useful part, and
 * `uninspectableCount` is the honest one: it says how many kept items the
 * filter had nothing but a bare dish name to read, so a caretaker can be told
 * "this menu carries no ingredient text" instead of being left to assume a
 * check happened.
 */
export function describeVenueBoardStats(stats: VenueMenuBoardResult["stats"]): string {
  return [
    `${stats.total} item(s)`,
    `${stats.notices} notice(s) dropped`,
    `${stats.removedByAllergy.length} removed by allergen filter`,
    `${stats.uninspectableCount} kept with name only`,
    `${stats.unreadableCount} unreadable`,
    `${stats.pageCount} page(s)`,
    stats.pricesSuppressed ? "prices suppressed (web source)" : "prices per settings",
  ].join(", ");
}
