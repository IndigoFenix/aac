/**
 * Tests for venue resolution (§4.3, §7).
 *
 * The required cases from §7 are the food court and the coarse-mode pair, and
 * both assert the same property from different directions: **ambiguity must
 * produce the picker, never an auto-pick.** Note that the food-court test
 * deliberately does NOT assert which venue wins — asserting a winner would bake
 * in the behaviour we are trying to forbid.
 *
 * DB-free, pure: belongs in `test:unit`.
 */

import { describe, it, expect } from "@jest/globals";
import {
  resolveVenue,
  matchNearbyVenues,
  coarsenPoint,
  COARSE_GRID_M,
  type VenueCandidate,
} from "@shared/venue-matching";

/** Dizengoff, Tel Aviv. */
const HERE = { latitude: 32.0785, longitude: 34.7741 };

/** Move a point north by `metres`. */
function north(from: typeof HERE, metres: number) {
  return { latitude: from.latitude + metres / 111_320, longitude: from.longitude };
}

function venue(id: string, point: { latitude: number; longitude: number }): VenueCandidate {
  return { id, name: id, ...point };
}

const BASE = {
  radiusM: 150,
  locationSearch: "precise" as const,
  requireVenueConfirmation: false,
};

describe("matchNearbyVenues", () => {
  it("returns venues in range, nearest first", () => {
    const venues = [venue("far", north(HERE, 120)), venue("near", north(HERE, 20))];
    const ranked = matchNearbyVenues(HERE, venues, 150);

    expect(ranked.map((r) => r.venue.id)).toEqual(["near", "far"]);
    expect(ranked[0].distanceM).toBeLessThan(30);
  });

  it("drops venues outside the radius", () => {
    const ranked = matchNearbyVenues(HERE, [venue("away", north(HERE, 400))], 150);
    expect(ranked).toEqual([]);
  });
});

describe("resolveVenue — the food court", () => {
  it("asks rather than picking when several venues are in range", () => {
    // Twenty restaurants inside the radius, indoors, where GPS is least
    // accurate. There is no ranking that answers this; only the caretaker knows.
    const venues = Array.from({ length: 20 }, (_, i) => venue(`stall-${i}`, north(HERE, 5 + i)));
    const result = resolveVenue({ ...BASE, gps: HERE, venues });

    expect(result.needsConfirmation).toBe(true);
    expect(result.reason).toBe("ambiguous");
    expect(result.resolved).toBeNull(); // the assertion that matters
    expect(result.candidates).toHaveLength(20); // all offered to the picker
  });

  it("does not tie-break on distance, however small the gap", () => {
    // 4 m closer inside a shopping centre is noise, and acting on it would bind
    // a menu to the wrong kitchen with full confidence.
    const venues = [venue("a", north(HERE, 10)), venue("b", north(HERE, 14))];
    const result = resolveVenue({ ...BASE, gps: HERE, venues });
    expect(result.resolved).toBeNull();
  });
});

describe("resolveVenue — a lone restaurant", () => {
  it("resolves without asking when confirmation is off", () => {
    const result = resolveVenue({ ...BASE, gps: HERE, venues: [venue("solo", north(HERE, 30))] });

    expect(result.needsConfirmation).toBe(false);
    expect(result.reason).toBe("none");
    expect(result.resolved?.venue.id).toBe("solo");
  });

  it("still asks when requireVenueConfirmation is on — the default", () => {
    const result = resolveVenue({
      ...BASE,
      gps: HERE,
      venues: [venue("solo", north(HERE, 30))],
      requireVenueConfirmation: true,
    });

    expect(result.needsConfirmation).toBe(true);
    expect(result.reason).toBe("setting");
    expect(result.resolved).toBeNull();
    expect(result.candidates).toHaveLength(1); // offered, not chosen
  });

  it("reports no candidates rather than resolving nothing silently", () => {
    const result = resolveVenue({ ...BASE, gps: HERE, venues: [venue("away", north(HERE, 900))] });
    expect(result.reason).toBe("no_candidates");
    expect(result.needsConfirmation).toBe(true);
  });
});

describe("resolveVenue — coarse mode", () => {
  it("still resolves a lone roadside restaurant", () => {
    // The §7 case. Snapping can move the point by up to ~70 m, so the radius is
    // widened by one grid step — otherwise coarse mode would lose the one case
    // where it could safely auto-resolve.
    const result = resolveVenue({
      ...BASE,
      gps: HERE,
      venues: [venue("roadside", north(HERE, 120))],
      locationSearch: "coarse",
    });

    expect(result.resolved?.venue.id).toBe("roadside");
  });

  it("degrades to the picker in the dense case rather than binding the wrong venue", () => {
    const venues = Array.from({ length: 6 }, (_, i) => venue(`stall-${i}`, north(HERE, 10 + i * 5)));
    const result = resolveVenue({ ...BASE, gps: HERE, venues, locationSearch: "coarse" });

    expect(result.resolved).toBeNull();
    expect(result.reason).toBe("ambiguous");
  });

  it("resolves nothing at all when location search is off", () => {
    const result = resolveVenue({
      ...BASE,
      gps: HERE,
      venues: [venue("solo", north(HERE, 10))],
      locationSearch: "off",
    });

    expect(result.candidates).toEqual([]);
    expect(result.resolved).toBeNull();
  });
});

describe("coarsenPoint", () => {
  it("snaps to a grid, and two nearby points land together", () => {
    const a = coarsenPoint(HERE);
    const b = coarsenPoint(north(HERE, 5));
    expect(a).toEqual(b);
  });

  it("never moves a point by more than about one grid step", () => {
    const snapped = coarsenPoint(HERE);
    const latShiftM = Math.abs(snapped.latitude - HERE.latitude) * 111_320;
    expect(latShiftM).toBeLessThanOrEqual(COARSE_GRID_M);
  });

  it("keeps the grid metric as latitude rises", () => {
    // A fixed degree step would give a 100 m grid at the equator and half that
    // in Scandinavia; the longitude step is widened by 1/cos(lat).
    const oslo = { latitude: 59.91, longitude: 10.75 };
    const snapped = coarsenPoint(oslo);
    const lonShiftM =
      Math.abs(snapped.longitude - oslo.longitude) *
      111_320 *
      Math.cos((oslo.latitude * Math.PI) / 180);
    expect(lonShiftM).toBeLessThanOrEqual(COARSE_GRID_M);
  });
});
