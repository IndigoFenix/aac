// server/services/venue-menus/venue-resolution-service.ts
//
// "Which restaurant is this?" end to end (§4.3, step 6).
//
// Three tiers, cheapest and most trustworthy first:
//
//   1. The student's OWN saved venues. Free, instant, and the strongest signal
//      there is — a place this child has eaten at before, confirmed by a
//      caretaker at the time.
//   2. The shared `venues` cache. Free. A second student at the same mall costs
//      nothing, which is the whole reason the cache is global and non-PHI.
//   3. An outbound OSM search. The ONLY tier that leaves the building, and it
//      runs only when a caretaker explicitly asks (§3, requirement 5:
//      discovery is a caretaker action; ordering is the student's).
//
// Ambiguity is never resolved here. `resolveVenue` reports it and a caretaker
// taps which venue — see shared/venue-matching.ts for why ranking harder would
// be the wrong answer.

import type { GeoPoint } from "@shared/location-matching";
import type { Venue } from "@shared/schema";
import type { ResolvedVenueMenuSettings } from "@shared/venue-menus";
import { resolveVenue, type ConfirmationReason } from "@shared/venue-matching";
import { venueRepository } from "../../repositories/venueRepository";
import { searchNearbyVenues } from "./osm-venue-provider.js";

/** Which tier produced the candidate list. Shown to the caretaker as context. */
export type ResolutionTier = "saved" | "cache" | "osm" | "none";

export interface VenueCandidateView {
  venue: Venue;
  distanceM: number;
  /** This student has been here before — the picker should show it first. */
  visitedBefore: boolean;
  /** An APPROVED menu already exists, so choosing this opens a board at once. */
  hasMenu: boolean;
}

export interface ResolveNearbyInput {
  studentId: string;
  gps: GeoPoint;
  settings: ResolvedVenueMenuSettings;
  /** A caretaker pressed "search for restaurants near me". */
  allowOutboundSearch: boolean;
}

export interface ResolveNearbyResult {
  candidates: VenueCandidateView[];
  /** The venue to use without asking, or null when a human must choose. */
  resolved: VenueCandidateView | null;
  needsConfirmation: boolean;
  reason: ConfirmationReason;
  tier: ResolutionTier;
}

export class VenueResolutionService {
  /**
   * Find the venues the student could be at.
   *
   * Never throws on a discovery failure: an Overpass outage degrades to "no
   * venues found", which the caller already handles by offering the camera.
   */
  async resolveNearby(input: ResolveNearbyInput): Promise<ResolveNearbyResult> {
    const { settings } = input;

    const empty: ResolveNearbyResult = {
      candidates: [],
      resolved: null,
      needsConfirmation: true,
      reason: "no_candidates",
      tier: "none",
    };

    if (!settings.enabled || settings.locationSearch === "off") return empty;

    // ── Tier 1: the student's own venues ──
    const links = await venueRepository.listForStudent(input.studentId);
    const savedIds = new Set(links.map((link) => link.venueId));

    const saved = (
      await Promise.all([...savedIds].map((id) => venueRepository.getById(id)))
    ).filter((venue): venue is Venue => !!venue);

    let tier: ResolutionTier = "saved";
    let pool: Venue[] = saved;

    let resolution = this.rank(pool, input);

    // ── Tier 2: the shared cache ──
    if (!resolution.candidates.length) {
      tier = "cache";
      pool = (await venueRepository.findNearby(input.gps, settings.searchRadiusM)).map(
        (row) => row.venue,
      );
      resolution = this.rank(pool, input);
    }

    // ── Tier 3: outbound, and only on request ──
    if (!resolution.candidates.length && input.allowOutboundSearch && settings.providers.osm) {
      tier = "osm";
      const found = await searchNearbyVenues(input.gps, settings.searchRadiusM);
      // Upserting on (source, sourceId) means two students near one restaurant
      // converge on ONE row rather than fragmenting the cache.
      pool = await Promise.all(found.map((venue) => venueRepository.upsert(venue)));
      resolution = this.rank(pool, input);
    }

    if (!resolution.candidates.length) return { ...empty, tier };

    const withMenus = await this.decorate(resolution.candidates, savedIds);
    const resolvedId = resolution.resolved?.venue.id;

    return {
      candidates: withMenus,
      resolved: withMenus.find((c) => c.venue.id === resolvedId) ?? null,
      needsConfirmation: resolution.needsConfirmation,
      reason: resolution.reason,
      tier,
    };
  }

  /**
   * Link a student to the venue a caretaker chose.
   *
   * The tap IS the binding (`caretaker_confirmed` in §3.1a terms) — it is what
   * collapses the food-court case, and it is recorded so a later visit skips
   * straight to tier 1.
   */
  async confirmVenue(studentId: string, venueId: string, label?: string) {
    return venueRepository.linkStudent({
      studentId,
      venueId,
      ...(label ? { label } : {}),
    });
  }

  private rank(pool: readonly Venue[], input: ResolveNearbyInput) {
    return resolveVenue({
      gps: input.gps,
      venues: pool,
      radiusM: input.settings.searchRadiusM,
      locationSearch: input.settings.locationSearch,
      requireVenueConfirmation: input.settings.requireVenueConfirmation,
    });
  }

  /** Add "been here" and "has a menu" — the two facts a picker needs. */
  private async decorate(
    ranked: ReadonlyArray<{ venue: Venue; distanceM: number }>,
    savedIds: ReadonlySet<string>,
  ): Promise<VenueCandidateView[]> {
    const menus = await Promise.all(
      ranked.map((entry) => venueRepository.getActiveMenu(entry.venue.id)),
    );

    return ranked.map((entry, i) => ({
      venue: entry.venue,
      distanceM: Math.round(entry.distanceM),
      visitedBefore: savedIds.has(entry.venue.id),
      hasMenu: !!menus[i],
    }));
  }
}

export const venueResolutionService = new VenueResolutionService();
