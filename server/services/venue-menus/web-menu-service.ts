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
import { resolveVenueMenuSettings, needsReview, isSourceEnabled } from "@shared/venue-menus";
import { getStudentAllergies } from "./student-allergies.js";
import { fetchWebMenu, type WebFetchFailure } from "./web-menu-fetcher.js";
import { cacheMenu, type CacheReviewReason, type MenuStatus } from "./menu-cache.js";
import type { RefinedMenuItem } from "./menu-refinement.js";
import type { VenueMenu } from "@shared/schema";
import type { DisclosureContext } from "../processorDisclosure";

export interface FetchWebMenuInput {
  venueId: string;
  /** Policy-resolved review requirement (§4.8). May only be raised from here. */
  requireReview: boolean;
  /**
   * May doubt (binding or extraction confidence) block going live? Callers
   * set false when the student's resolved policy is "never" — see
   * resolveCacheStatus. Default true.
   */
  gateDoubt?: boolean;
  /** Language to render item names in — normally the student's. */
  targetLanguage?: string;
  /** AKIM §18.5 — who this menu work is for; rides down to the vision /
   *  extraction / refinement calls that leave for a processor. */
  disclosure?: DisclosureContext;
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

/**
 * How long one warm ATTEMPT covers a venue — success or failure alike.
 *
 * A student can press a place button as often as they can look at it, and a
 * warm is a paid fetch plus an extraction LLM call. A menu that failed to
 * fetch ten minutes ago will fail the same way now; one that succeeded is in
 * the cache and never reaches the attempt gate again. Six hours matches the
 * visit window: within one outing, one try.
 */
export const WEB_WARM_ATTEMPT_TTL_MS = 6 * 60 * 60 * 1000;

/** Venues we already tried to warm, and when. Bounded by distinct venues
 *  asked about in the last TTL; pruned on every call. */
const warmAttempts = new Map<string, number>();

/** Warms currently EXECUTING. Distinct from `warmAttempts` (which answers
 *  "tried recently?") because an in-flight warm has a different meaning to a
 *  screen: "still getting it" is a spinner, "tried and failed" is a message. */
const warmInFlight = new Set<string>();

/** Test seam — a fresh process starts empty, but a suite does not. */
export function resetWebWarmAttempts(): void {
  warmAttempts.clear();
  warmInFlight.clear();
}

/** The student fields the warm path needs. Matches what the coordinator's
 *  session cache already holds — no re-fetch on a press path. */
export interface WarmStudent {
  id: string;
  birthDate?: string | Date | null;
  aacSettings?: { venueMenus?: unknown; languageLevel?: number | null } | null;
  primaryLanguage?: string | null;
}

/** What a screen may promise about this venue's menu, without marking anything. */
export type WarmGate =
  /** A warm would actually run — show "getting the menu…" and start one. */
  | "yes"
  /** One is running right now — show the same screen, start nothing. */
  | "in_flight"
  /** Nothing will fetch: source off, menu already exists, or tried recently. */
  | "no";

export type WarmOutcome =
  /** A fetch ran and the menu is APPROVED — it will be on the next open. */
  | { kind: "ready"; venueName: string; itemCount: number }
  /** A fetch ran and the menu is waiting on review. */
  | { kind: "pending_review" }
  /** Nothing fetched: gated off, already tried, already cached, or failed. */
  | { kind: "skipped"; reason: string };

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
      ...(input.disclosure ? { disclosure: input.disclosure } : {}),
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
      ...(input.gateDoubt !== undefined ? { gateDoubt: input.gateDoubt } : {}),
      ...(input.targetLanguage ? { targetLanguage: input.targetLanguage } : {}),
      ...(input.disclosure ? { disclosure: input.disclosure } : {}),
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

  /**
   * CACHE-ONCE-ON-FIRST-ASK — the background half of the student's menu path.
   *
   * The design was always that a menu is fetched once and cached for everyone
   * after (§4.2b: "the path that makes a first visit instant") — but nothing
   * ever ran the fetch except the companion's button, which itself only
   * renders when a clinician enabled the web source. So in practice no menu
   * existed unless an adult had already done the work, and a student naming a
   * restaurant hit "no menu yet" forever (2026-09-01).
   *
   * This is the missing trigger: a student (or the AI on their behalf) asked
   * about ONE specific venue and it had no usable menu, so try to fetch it in
   * the background. Every rail the button path has, this has, plus a throttle
   * it needs and the button does not:
   *
   *   - `sources.web` still rules — a clinician who left the web source off
   *     has said scraped menus are not for this child, and a background path
   *     does not get to overrule a settings screen.
   *   - The §3.1a binding check runs BEFORE the fetch, inside fetchForVenue.
   *   - Review policy is identical (`needsReview`, allergies included) — a
   *     menu that needs eyes lands `pending_review`, and `getActiveMenu`
   *     serves approved menus only, so nothing unreviewed can reach a board.
   *   - ONE ATTEMPT PER VENUE PER WINDOW, marked before the await so
   *     concurrent presses collapse to one fetch — this is the browse
   *     service's own outbound rule, applied to a much more expensive call.
   *   - Any existing menu row — even one in review, even one that aged out —
   *     means no fetch: re-fetching cannot approve anything, and a stale menu
   *     is a caretaker decision, not a loop.
   *
   * Never throws; the caller is a fire-and-forget on an app-open path.
   */
  /**
   * Would `warmForVenue` do anything for this venue right now?
   *
   * A PEEK: marks nothing and fetches nothing. It exists so the app-open
   * payload can honestly promise a screen — "getting the menu…" may only be
   * shown when a fetch will actually run (or already is), because a spinner
   * over a fetch that was gated off is a promise nobody will keep.
   */
  async canWarmForVenue(student: WarmStudent, venueId: string, now: Date = new Date()): Promise<WarmGate> {
    try {
      if (warmInFlight.has(venueId)) return "in_flight";
      const last = warmAttempts.get(venueId);
      if (last !== undefined && now.getTime() - last <= WEB_WARM_ATTEMPT_TTL_MS) return "no";
      const settings = resolveVenueMenuSettings(
        student.aacSettings?.venueMenus,
        {
          birthDate: student.birthDate,
          languageLevel: student.aacSettings?.languageLevel ?? null,
        },
        now,
      );
      if (!isSourceEnabled(settings, "web")) return "no";
      if (await venueRepository.getActiveMenu(venueId)) return "no";
      // A pending-only venue may re-warm when review is off — the re-fetch
      // will now APPROVE (see warmForVenue). Under a review policy it may
      // not: each warm would just mint another pending row for the queue.
      if (
        settings.requireReview !== "never" &&
        (await venueRepository.listMenus(venueId)).length > 0
      ) {
        return "no";
      }
      return "yes";
    } catch {
      return "no";
    }
  }

  async warmForVenue(
    student: WarmStudent,
    venueId: string,
    disclosure: DisclosureContext,
    now: Date = new Date(),
  ): Promise<WarmOutcome> {
    // Only the call that ADDED the in-flight marker may remove it — a
    // concurrent call bouncing off the throttle must not strip the marker
    // out from under the one actually fetching.
    let marked = false;
    try {
      const t = now.getTime();
      for (const [key, at] of warmAttempts) {
        if (t - at > WEB_WARM_ATTEMPT_TTL_MS) warmAttempts.delete(key);
      }
      const last = warmAttempts.get(venueId);
      if (last !== undefined && t - last <= WEB_WARM_ATTEMPT_TTL_MS) {
        return { kind: "skipped", reason: "recently_attempted" };
      }
      warmAttempts.set(venueId, t);
      warmInFlight.add(venueId);
      marked = true;

      const settings = resolveVenueMenuSettings(
        student.aacSettings?.venueMenus,
        {
          birthDate: student.birthDate,
          languageLevel: student.aacSettings?.languageLevel ?? null,
        },
        now,
      );
      if (!isSourceEnabled(settings, "web")) return { kind: "skipped", reason: "web_source_off" };

      // An APPROVED menu means there is nothing to add. A pending-only venue
      // may re-warm when review is off — the earlier fetch landed pending
      // under a stricter gate (observed 2026-09-01: one shaky row parked a
      // whole menu), and the re-fetch will now approve. Under a review
      // policy it may not: each warm would just mint another pending row.
      if (await venueRepository.getActiveMenu(venueId)) {
        return { kind: "skipped", reason: "menu_exists" };
      }
      if (
        settings.requireReview !== "never" &&
        (await venueRepository.listMenus(venueId)).length > 0
      ) {
        return { kind: "skipped", reason: "menu_exists" };
      }

      const allergies = await getStudentAllergies(student.id);
      const result = await this.fetchForVenue({
        venueId,
        disclosure,
        requireReview: needsReview(settings.requireReview, "web", {
          hasAllergies: allergies.length > 0,
          requireReviewWithAllergies: settings.requireReviewWithAllergies,
        }),
        // "never" means the clinician (or the interim default) accepts menus
        // going live once extraction produced dishes — binding doubt and
        // shaky-row confidence are recorded, not gating. Any other policy
        // keeps the full table.
        gateDoubt: settings.requireReview !== "never",
        ...(student.primaryLanguage ? { targetLanguage: student.primaryLanguage } : {}),
      });

      if (!result.ok) return { kind: "skipped", reason: result.reason };
      if (result.status !== "approved") return { kind: "pending_review" };
      const venue = await venueRepository.getById(venueId);
      return { kind: "ready", venueName: venue?.name ?? "the restaurant", itemCount: result.items.length };
    } catch (error) {
      console.error("[web-menu] warm failed:", (error as Error)?.message);
      return { kind: "skipped", reason: "error" };
    } finally {
      if (marked) warmInFlight.delete(venueId);
    }
  }
}

export const webMenuService = new WebMenuService();
