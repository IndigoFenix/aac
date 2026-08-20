// shared/venue-matching.ts
//
// "Which restaurant is the student standing in?" (§4.3)
//
// A deliberate SIBLING of matchStudentLocation, not an extension of it. That
// function ranks INSTITUTE locations against CALENDAR EVENTS, and a family
// restaurant is neither — folding venues into it would entangle two domains
// that only happen to share a distance formula. So this file reuses
// `haversineMeters` and nothing else.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULE THIS FILE EXISTS TO ENFORCE: AMBIGUITY IS RESOLVED BY ASKING.
//
// GPS gets us to the right country and the right brand (§3.1a). What it cannot
// do is tell us which of the twenty restaurants in a mall food court the
// student walked into — indoors is exactly where GPS is least accurate, and no
// better geodata fixes it. So when more than one venue is in range this file
// does NOT rank harder and pick a winner. It reports ambiguity, and a caretaker
// taps which one. One tap they would want anyway, and the food-court case
// collapses completely.
//
// Refusing is always correct; guessing never is.
//
// Pure and dependency-free, so every rule here is unit-testable.

import { haversineMeters, type GeoPoint } from "./location-matching";

/** The minimum a venue row needs for matching. */
export interface VenueCandidate extends GeoPoint {
  id: string;
  name: string;
  brandKey?: string | null;
}

export interface RankedVenue<T extends VenueCandidate = VenueCandidate> {
  venue: T;
  distanceM: number;
}

/** Why a caretaker is being asked to choose (or why they are not). */
export type ConfirmationReason =
  | "none"
  | "setting"
  | "ambiguous"
  | "no_candidates";

export interface VenueResolution<T extends VenueCandidate = VenueCandidate> {
  /** Everything in range, nearest first. The picker's contents. */
  candidates: RankedVenue<T>[];
  /**
   * The venue to bind WITHOUT asking, or null when a human must choose.
   * Null whenever there is any doubt at all — including "the setting says ask".
   */
  resolved: RankedVenue<T> | null;
  needsConfirmation: boolean;
  reason: ConfirmationReason;
}

/**
 * Grid size for `locationSearch: 'coarse'`, in metres.
 *
 * Note what coarsening does and does not buy (§5): it does NOT make the request
 * private — privacy here rests on the request carrying no identifier — and it
 * actively destroys venue disambiguation, because restaurants sit metres apart.
 * It exists for caretakers who want it anyway, and `precise` is the default.
 */
export const COARSE_GRID_M = 100;

const METRES_PER_DEGREE_LAT = 111_320;

/**
 * Snap a point to a ~`gridM` grid.
 *
 * Longitude degrees shrink with latitude, so the longitude step is widened by
 * 1/cos(lat) — a fixed degree step would give a 100 m grid at the equator and a
 * 50 m one in Scandinavia.
 */
export function coarsenPoint(point: GeoPoint, gridM: number = COARSE_GRID_M): GeoPoint {
  const latStep = gridM / METRES_PER_DEGREE_LAT;
  const latitude = Math.round(point.latitude / latStep) * latStep;

  // The longitude step is derived from the SNAPPED latitude, not the raw one.
  // Deriving it from the raw value makes the grid depend continuously on the
  // input, so two points 5 m apart get two slightly different longitude grids
  // and land in different cells — which is not a grid at all, and leaks back
  // some of the precision coarsening was asked to remove.
  const cosLat = Math.max(0.01, Math.cos((latitude * Math.PI) / 180));
  const lonStep = latStep / cosLat;

  return {
    latitude,
    longitude: Math.round(point.longitude / lonStep) * lonStep,
  };
}

/** Venues within `radiusM` of a point, nearest first. */
export function matchNearbyVenues<T extends VenueCandidate>(
  gps: GeoPoint,
  venues: readonly T[],
  radiusM: number,
): RankedVenue<T>[] {
  return venues
    .map((venue) => ({ venue, distanceM: haversineMeters(gps, venue) }))
    .filter((entry) => entry.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM);
}

export interface ResolveVenueInput<T extends VenueCandidate> {
  gps: GeoPoint;
  venues: readonly T[];
  radiusM: number;
  /** `VenueMenuSettings.locationSearch`. 'off' resolves nothing at all. */
  locationSearch: "off" | "coarse" | "precise";
  /** `VenueMenuSettings.requireVenueConfirmation`. */
  requireVenueConfirmation: boolean;
}

/**
 * Decide which venue we are at, or that we must ask.
 *
 * Coarse mode widens the radius by one grid step before matching. Without that
 * a snapped point can fall up to ~70 m from the truth and a LONE roadside
 * restaurant — the one case where coarse mode could safely auto-resolve —
 * drops out of range for no reason. Widening keeps that case working; the dense
 * case still produces several candidates and still goes to the picker, which is
 * the outcome that matters.
 */
export function resolveVenue<T extends VenueCandidate>(
  input: ResolveVenueInput<T>,
): VenueResolution<T> {
  if (input.locationSearch === "off") {
    return { candidates: [], resolved: null, needsConfirmation: true, reason: "no_candidates" };
  }

  const coarse = input.locationSearch === "coarse";
  const point = coarse ? coarsenPoint(input.gps) : input.gps;
  const radiusM = coarse ? input.radiusM + COARSE_GRID_M : input.radiusM;

  const candidates = matchNearbyVenues(point, input.venues, radiusM);

  if (!candidates.length) {
    return { candidates, resolved: null, needsConfirmation: true, reason: "no_candidates" };
  }

  // More than one in range is the food court. Note there is deliberately no
  // tie-break on distance: 4 m closer inside a shopping centre is noise, and
  // acting on it would bind a menu to the wrong kitchen with full confidence.
  if (candidates.length > 1) {
    return { candidates, resolved: null, needsConfirmation: true, reason: "ambiguous" };
  }

  if (input.requireVenueConfirmation) {
    return { candidates, resolved: null, needsConfirmation: true, reason: "setting" };
  }

  return { candidates, resolved: candidates[0], needsConfirmation: false, reason: "none" };
}
