// server/services/venue-menus/web-menu-service.ts
//
// The `web` source, end to end (§4.2b, step 7):
//
//   venue -> bind -> fetch -> extract -> cacheMenu()
//
// Like the camera service, this stops at the cache door. Refinement, review
// escalation, and the write itself belong to menu-cache.ts — which is why a
// scraped menu automatically inherits the rules a photographed one already
// obeys: chain-level bindings never go live unattended, and a scrape landing
// over an approved camera menu becomes a suggestion rather than a replacement.
//
// This is the path that makes a first visit instant. It is also the path with
// every defect the teardowns found, so it is the one carrying the most gates.

import type { Venue } from "@shared/schema";
import { venueRepository } from "../../repositories/venueRepository";
import { fetchWebMenu, type WebFetchFailure } from "./web-menu-fetcher.js";
import { cacheMenu, type CacheReviewReason, type MenuStatus } from "./menu-cache.js";
import type { RefinedMenuItem } from "./menu-refinement.js";
import type { VenueMenu } from "@shared/schema";

export interface FetchWebMenuInput {
  venueId: string;
  /** Policy-resolved review requirement (§4.8). May only be raised from here. */
  requireReview: boolean;
  /** Language to render item names in — normally the student's. */
  targetLanguage?: string;
}

export interface WebMenuServiceResult {
  ok: true;
  menu: VenueMenu;
  items: RefinedMenuItem[];
  status: MenuStatus;
  reviewReasons: CacheReviewReason[];
  sourceUrl: string;
  droppedByRefinement: Array<{ index: number; name: string; reason: string }>;
}

export interface WebMenuServiceFailure {
  ok: false;
  reason: WebFetchFailure | "unknown_venue";
  detail?: string;
}

export class WebMenuService {
  /**
   * Fetch, read, and cache this venue's web menu.
   *
   * A failure here is ordinary and is reported, not thrown: every reason means
   * the same thing to a caretaker — we could not find this restaurant's menu,
   * please photograph it. The camera is the better path anyway (§4.2a: web for
   * reach, camera for truth).
   */
  async fetchForVenue(
    input: FetchWebMenuInput,
  ): Promise<WebMenuServiceResult | WebMenuServiceFailure> {
    const venue: Venue | undefined = await venueRepository.getById(input.venueId);
    if (!venue) return { ok: false, reason: "unknown_venue" };

    const fetched = await fetchWebMenu(venue, {
      ...(input.targetLanguage ? { expectedLanguage: input.targetLanguage } : {}),
    });

    if (!fetched.ok) {
      // A binding refusal is the system working, not failing — log it as such
      // so a rising rate is visible without looking like an outage.
      if (fetched.reason === "binding_refused") {
        console.info(`[web-menu] refused for venue=${venue.id}: ${fetched.detail}`);
      }
      return fetched;
    }

    const cached = await cacheMenu({
      venueId: venue.id,
      rawItems: fetched.items,
      ...(fetched.language ? { language: fetched.language } : {}),
      ...(fetched.currency ? { currency: fetched.currency } : {}),
      provenance: "web",
      sourceUrl: fetched.sourceUrl,
      bindingBasis: fetched.binding.bindingBasis,
      ...(fetched.binding.bindingCountry ? { bindingCountry: fetched.binding.bindingCountry } : {}),
      bindingBranchMatch: fetched.binding.bindingBranchMatch,
      requireReview: input.requireReview,
      extractionRequiresReview: fetched.requiresReview,
      ...(input.targetLanguage ? { targetLanguage: input.targetLanguage } : {}),
    });

    return {
      ok: true,
      menu: cached.menu,
      items: cached.items,
      status: cached.status,
      reviewReasons: cached.reviewReasons,
      sourceUrl: fetched.sourceUrl,
      droppedByRefinement: cached.droppedByRefinement,
    };
  }
}

export const webMenuService = new WebMenuService();
