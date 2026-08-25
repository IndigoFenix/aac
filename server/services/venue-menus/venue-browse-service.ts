// server/services/venue-menus/venue-browse-service.ts
//
// "WHAT DO YOU WANT TO EAT?" — the student's half of venue discovery.
//
// The original design made discovery a caretaker action and ordering the
// student's (§3, requirement 5). This is the deliberate widening of that: a
// student who is not at a restaurant can ask for a KIND of food and see the
// places nearby that serve it. Daniel's call, 2026-08-22.
//
// ─────────────────────────────────────────────────────────────────────────────
// BROWSING IS NOT BINDING, AND THIS FILE CANNOT BIND
//
// Nothing here writes `student_venues`, and nothing here touches a menu. A
// student pressing 🍕 and then "Pizza Roma" has said *I would like to go to
// Pizza Roma* — they have not sat down there. `linkStudent` stays where it
// was, behind the caretaker's confirmation step, because that tap is what
// attaches a menu to a kitchen and is the whole §3.1a fix.
//
// The practical reason this matters: `resolveBoundVenue` decides "we are here"
// from `lastVisitedAt`. If browsing wrote that column, wanting pizza would put
// a pizzeria's menu on the student's board while they sat in their own kitchen.
//
// ─────────────────────────────────────────────────────────────────────────────
// ONE OUTBOUND SEARCH PER PLACE PER WINDOW
//
// A caretaker pressed "search near me" once per meal. A student can dwell on a
// button as often as they can look at it, and the same press now reaches
// Overpass. That changes the exposure by orders of magnitude even though the
// per-search cost stays at roughly nothing.
//
// So: going outbound is rate-limited by COARSE POSITION, not by press. The
// first press near a place fetches; every press after it — a different food
// type, the same type again, a student exploring the grid — filters the
// venues already in our own cache. This is the cost guard and the privacy
// guard in one mechanism: repeated presses do not become repeated position
// reports, and Overpass (a shared community endpoint under fair use, which
// breaks for everyone when abused) sees one query where it would have seen
// forty.
//
// Browse deliberately never calls the PAID provider. Bright Data earns its
// keep by supplying the per-place `website` the binding check needs, and
// browse binds nothing — so there is nothing here for it to be better at.
//
// See planning-docs/aac-restaurant-menus.md §4.1, §5.

import type { GeoPoint } from "@shared/location-matching";
import { haversineMeters } from "@shared/location-matching";
import type { Venue } from "@shared/schema";
import type { ResolvedVenueMenuSettings } from "@shared/venue-menus";
import { coarsenPoint } from "@shared/venue-matching";
import {
  CUISINE_CATEGORIES,
  countByCategory,
  cuisineCategory,
  venueServes,
} from "@shared/venue-cuisine";
import { venueRepository } from "../../repositories/venueRepository.js";
import { searchNearbyVenues } from "./osm-venue-provider.js";

/**
 * How long one outbound search covers a place.
 *
 * Ten minutes is longer than a student takes to explore a twelve-button grid
 * and shorter than a family takes to move somewhere with different
 * restaurants around it. Restaurants do not open and close inside this window,
 * so nothing is lost by reusing.
 */
export const BROWSE_SEARCH_TTL_MS = 10 * 60 * 1000;

/** Cells we have already searched, and when. Pruned on every call, so it is
 *  bounded by the number of distinct places searched in the last TTL. */
const searchedCells = new Map<string, number>();

/** The reuse key: a ~100 m cell, not a student. Two students in the same food
 *  court share one search, which is the same reason the `venues` cache is
 *  global and non-PHI in the first place. No identifier is stored. */
function cellKey(gps: GeoPoint): string {
  const coarse = coarsenPoint(gps);
  return `${coarse.latitude.toFixed(4)},${coarse.longitude.toFixed(4)}`;
}

function pruneCells(now: number): void {
  for (const [key, at] of searchedCells) {
    if (now - at > BROWSE_SEARCH_TTL_MS) searchedCells.delete(key);
  }
}

/** Test seam — a fresh process starts empty, but a suite does not. */
export function resetBrowseSearchCache(): void {
  searchedCells.clear();
}

export interface BrowseInput {
  studentId: string;
  gps: GeoPoint;
  settings: ResolvedVenueMenuSettings;
  /** A food type from `CUISINE_CATEGORIES`, or null for "what is around?". */
  category?: string | null;
}

export interface BrowseCategoryView {
  key: string;
  emoji: string;
  /** Places nearby that serve it. Never zero — empty categories are dropped. */
  count: number;
}

export interface BrowsePlaceView {
  venueId: string;
  name: string;
  distanceM: number;
  /** This student has eaten here before — worth showing first. */
  visitedBefore: boolean;
  /** An approved menu already exists, so a caretaker confirm opens a board. */
  hasMenu: boolean;
}

export interface BrowseResult {
  /** The food types actually available nearby, in registry order. */
  categories: BrowseCategoryView[];
  /** Places serving `category`. Empty when no category was asked for. */
  places: BrowsePlaceView[];
  /** True when this call went outbound. False means it reused the cache. */
  searched: boolean;
}

const EMPTY: BrowseResult = { categories: [], places: [], searched: false };

export class VenueBrowseService {
  /**
   * What food is nearby, and where.
   *
   * Never throws. A discovery outage degrades to an empty grid — the student
   * has said nothing wrong, and a child who pressed a button deserves a quiet
   * "nothing here" rather than an error a caretaker has to interpret.
   */
  async browse(input: BrowseInput, now: Date = new Date()): Promise<BrowseResult> {
    const { settings } = input;
    if (!settings.enabled || !settings.studentBrowse) return EMPTY;
    if (settings.locationSearch === "off") return EMPTY;

    try {
      const radiusM = settings.browseRadiusM;
      let pool = await this.cachedPool(input.gps, radiusM);
      let searched = false;

      // Outbound only when this place has not been searched recently. Note the
      // check is on the PLACE, not on whether the cache came back empty: a cell
      // that genuinely has no restaurants must not re-query Overpass on every
      // press just because it keeps returning nothing.
      if (settings.providers.osm && this.shouldSearch(input.gps, now)) {
        searched = true;
        this.markSearched(input.gps, now);
        const found = await searchNearbyVenues(input.gps, radiusM);
        if (found.length) {
          // Upsert on (source, sourceId) so browse feeds the same shared cache
          // the caretaker path reads — a student looking for pizza warms the
          // venue list their caretaker will confirm from a minute later.
          await Promise.all(found.map((venue) => venueRepository.upsert(venue)));
          pool = await this.cachedPool(input.gps, radiusM);
        }
      }

      const counts = countByCategory(pool.map((p) => p.venue));
      const categories: BrowseCategoryView[] = CUISINE_CATEGORIES.filter((c) =>
        counts.has(c.key),
      ).map((c) => ({ key: c.key, emoji: c.emoji, count: counts.get(c.key)! }));

      const places = input.category
        ? await this.placesFor(input.studentId, pool, input.category)
        : [];

      return { categories, places, searched };
    } catch (error) {
      console.error("[venue-browse] browse failed:", (error as Error)?.message);
      return EMPTY;
    }
  }

  /** Venues we already know about near this point, with true distances. */
  private async cachedPool(
    gps: GeoPoint,
    radiusM: number,
  ): Promise<Array<{ venue: Venue; distanceM: number }>> {
    const rows = await venueRepository.findNearby(gps, radiusM);
    return rows.map((row) => ({
      venue: row.venue,
      distanceM: Math.round(haversineMeters(gps, row.venue)),
    }));
  }

  private async placesFor(
    studentId: string,
    pool: ReadonlyArray<{ venue: Venue; distanceM: number }>,
    categoryKey: string,
  ): Promise<BrowsePlaceView[]> {
    const category = cuisineCategory(categoryKey);
    if (!category) return [];

    const matching = pool
      .filter((entry) => venueServes(entry.venue, category))
      .sort((a, b) => a.distanceM - b.distanceM);
    if (!matching.length) return [];

    const links = await venueRepository.listForStudent(studentId);
    const visited = new Set(links.map((link) => link.venueId));

    const menus = await Promise.all(
      matching.map((entry) => venueRepository.getActiveMenu(entry.venue.id)),
    );

    return matching.map((entry, i) => ({
      venueId: entry.venue.id,
      name: entry.venue.name,
      distanceM: entry.distanceM,
      visitedBefore: visited.has(entry.venue.id),
      hasMenu: !!menus[i],
    }));
  }

  private shouldSearch(gps: GeoPoint, now: Date): boolean {
    const t = now.getTime();
    pruneCells(t);
    const last = searchedCells.get(cellKey(gps));
    return last === undefined || t - last > BROWSE_SEARCH_TTL_MS;
  }

  private markSearched(gps: GeoPoint, now: Date): void {
    searchedCells.set(cellKey(gps), now.getTime());
  }
}

export const venueBrowseService = new VenueBrowseService();
