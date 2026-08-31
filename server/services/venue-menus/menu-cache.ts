// server/services/venue-menus/menu-cache.ts
//
// THE ONLY DOOR INTO THE MENU CACHE.
//
// Step 4 of planning-docs/aac-restaurant-menus.md §6, implementing §4.2a's
// standing requirement: refinement "runs before every cache write, whatever the
// source."
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A CHOKEPOINT AND NOT A CONVENTION
//
// The camera path already refined before writing. The problem is what happens
// next: step 7 adds a Bright Data web path, step 8 a manual one, and each is a
// fresh opportunity for someone to call `venueRepository.createMenu` directly
// and land raw extraction in a GLOBAL cache that every student reads from.
// "Remember to refine first" is not a safety property.
//
// So the refinement pass is not something a caller does before writing — it is
// something WRITING DOES. `cacheMenu()` takes RAW items and there is no
// parameter through which pre-refined items can be supplied. A caller that
// wants to skip refinement has to go around this module entirely, which is a
// visible change to a file whose header says not to.
//
// The second job here is REVIEW ESCALATION. Four independent conditions can
// force a human to look at a menu, they arrive from four different places
// (student policy, extraction quality, binding strength, cache history), and
// every one of them may only RAISE the bar. Deciding that in each caller means
// getting it right repeatedly; deciding it here means getting it right once.
//
// See §4.2a (refinement), §4.8 (review policy), §4.9 (chain disclaimer).

import { venueRepository } from "../../repositories/venueRepository";
import { requestMenuRefinement } from "./refinement-agent.js";
import { applyMenuRefinement, type RawMenuItem, type RefinedMenuItem } from "./menu-refinement.js";
import type { VenueMenu } from "@shared/schema";
import type { DisclosureContext } from "../processorDisclosure";

/** How the menu text was obtained. */
export type MenuProvenance = "camera" | "web" | "manual";

/** Why we believe this menu belongs to this venue (§3.1a). */
export type MenuBindingBasis =
  | "gps_place_match"
  | "place_website"
  | "caretaker_confirmed"
  | "camera"
  | "chain_fallback";

export type MenuBranchMatch = "exact" | "chain" | "unknown";

export type MenuStatus = "approved" | "pending_review";

/**
 * Why a menu was sent for review. Surfaced to the caretaker (so the review
 * screen can say what to look at) and logged (so a rising `extraction_quality`
 * rate is visible before it becomes normal).
 */
export type CacheReviewReason =
  | "policy"
  | "extraction_quality"
  | "chain_binding"
  | "unbound_branch"
  | "camera_menu_exists";

export interface ResolveStatusInput {
  /** The student's resolved review policy (§4.8), already decided by the caller. */
  requireReview: boolean;
  /** The extraction is telling us it read badly. */
  extractionRequiresReview: boolean;
  provenance: MenuProvenance;
  bindingBasis: MenuBindingBasis;
  bindingBranchMatch: MenuBranchMatch;
  /**
   * Provenance of the venue's current approved menu, if it has one. Null when
   * this is the first menu for the venue.
   */
  existingApprovedProvenance?: MenuProvenance | null;
}

export interface ResolvedStatus {
  status: MenuStatus;
  reasons: CacheReviewReason[];
}

/**
 * Decide whether a menu may go live unattended.
 *
 * Pure, so the whole escalation table is unit-testable without a database or a
 * model. Every rule below can only push TOWARD review — there is deliberately
 * no branch that turns `pending_review` back into `approved`, because each
 * condition is independent evidence and one clean signal does not cancel
 * another's doubt.
 */
export function resolveCacheStatus(input: ResolveStatusInput): ResolvedStatus {
  const reasons: CacheReviewReason[] = [];

  // 1. The student's policy (§4.8). Age, language level, caretaker setting.
  if (input.requireReview) reasons.push("policy");

  // 2. Could we read it? Independent of policy — `web_only` exempts the camera
  //    from the wrong-restaurant defect, never from a misread price.
  if (input.extractionRequiresReview) reasons.push("extraction_quality");

  // 3. The טומי רול defect (§2f, §4.9): right brand, wrong branch. A chain-level
  //    binding is a GUESS about which kitchen this is, and a guess must never
  //    reach a student unattended — the branch that does not serve the dish is
  //    exactly where a nonverbal child gets stuck.
  if (input.bindingBranchMatch === "chain" || input.bindingBasis === "chain_fallback") {
    reasons.push("chain_binding");
  }

  // 4. No branch signal at all is weaker still than a chain match.
  if (input.bindingBranchMatch === "unknown" && input.bindingBasis !== "camera") {
    reasons.push("unbound_branch");
  }

  // 5. Trust ordering (§4.2a): web for reach, camera for truth. Once a venue has
  //    an approved camera menu, a scraped one is a SUGGESTION — it may well be
  //    newer and fuller, but it may also be the franchise's national menu, and
  //    only a human can say which. Camera over camera is fine: a fresh photo of
  //    the same table supersedes an older one without ceremony.
  if (input.existingApprovedProvenance === "camera" && input.provenance !== "camera") {
    reasons.push("camera_menu_exists");
  }

  return { status: reasons.length ? "pending_review" : "approved", reasons };
}

export interface CacheMenuInput {
  venueId: string;
  /**
   * Items EXACTLY as the source produced them. Raw on purpose: there is no way
   * to hand this function pre-refined items, so refinement cannot be skipped.
   */
  rawItems: readonly RawMenuItem[];
  /** The language the items are written in. */
  language?: string;
  currency?: string;
  provenance: MenuProvenance;
  sourceUrl?: string;
  bindingBasis: MenuBindingBasis;
  bindingCountry?: string;
  bindingBranchMatch: MenuBranchMatch;
  requireReview: boolean;
  extractionRequiresReview?: boolean;
  /** Language to render item names into — normally the student's. */
  targetLanguage?: string;
  /** AKIM §18.5 — who this menu work is for; rides down to the vision /
   *  extraction / refinement calls that leave for a processor. */
  disclosure?: DisclosureContext;
}

export interface CacheMenuResult {
  menu: VenueMenu;
  items: RefinedMenuItem[];
  status: MenuStatus;
  reviewReasons: CacheReviewReason[];
  /** Rows refinement removed, so the review screen can show what went missing. */
  droppedByRefinement: Array<{ index: number; name: string; reason: string }>;
  /** Non-zero means the refinement prompt is drifting — worth an alert. */
  refinementRejections: number;
}

/**
 * Test seam. Substituting the refinement CALL is allowed; skipping the
 * enforcement that follows it is not, which is why only the model call and the
 * repository are injectable and `applyMenuRefinement` is not.
 *
 * @internal
 */
export interface CacheMenuDeps {
  requestRefinement: typeof requestMenuRefinement;
  repository: Pick<typeof venueRepository, "createMenu" | "getActiveMenu">;
}

const defaultDeps: CacheMenuDeps = {
  requestRefinement: requestMenuRefinement,
  repository: venueRepository,
};

/**
 * Refine, validate, and persist a menu. The only supported way to write a
 * `venue_menus` row.
 *
 * A refinement failure is not a write failure: `requestMenuRefinement` returns
 * `[]` on error and annotation fails OPEN, so the menu still lands with every
 * row kept and `kind: 'unknown'`. That is a poorer board, never a wrong one,
 * and losing a caretaker's four photographs because a classification call timed
 * out would be the worse outcome by a distance.
 */
export async function cacheMenu(
  input: CacheMenuInput,
  deps: CacheMenuDeps = defaultDeps,
): Promise<CacheMenuResult> {
  const { venueId, rawItems } = input;

  // ── Refine (§4.2a). Annotations only; facts are re-read from rawItems. ──
  const entries = await deps.requestRefinement(rawItems, {
    ...(input.targetLanguage ? { targetLanguage: input.targetLanguage } : {}),
    ...(input.disclosure ? { disclosure: input.disclosure } : {}),
  });
  const refined = applyMenuRefinement(rawItems, entries);

  if (refined.rejected.length) {
    console.warn(
      `[menu-cache] venue=${venueId} refused ${refined.rejected.length} annotation(s):`,
      refined.rejected.slice(0, 5),
    );
  }

  // ── Escalate (§4.8, §4.9) ──
  const existing = await deps.repository.getActiveMenu(venueId);
  const { status, reasons } = resolveCacheStatus({
    requireReview: input.requireReview,
    extractionRequiresReview: input.extractionRequiresReview ?? false,
    provenance: input.provenance,
    bindingBasis: input.bindingBasis,
    bindingBranchMatch: input.bindingBranchMatch,
    existingApprovedProvenance: (existing?.provenance as MenuProvenance | undefined) ?? null,
  });

  if (reasons.length) {
    // Ops signal. A rising `extraction_quality` rate means the vision prompt or
    // the capture UX is degrading; a rising `chain_binding` rate means venue
    // resolution is guessing more often than it should.
    console.info(
      `[menu-cache] venue=${venueId} provenance=${input.provenance} -> review (${reasons.join(", ")})`,
    );
  }

  // ── Write ──
  const menu = await deps.repository.createMenu({
    venueId,
    language: input.language ?? input.targetLanguage ?? "en",
    ...(input.currency ? { currency: input.currency } : {}),
    items: refined.items,
    provenance: input.provenance,
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    bindingBasis: input.bindingBasis,
    ...(input.bindingCountry ? { bindingCountry: input.bindingCountry } : {}),
    bindingBranchMatch: input.bindingBranchMatch,
    status,
  });

  return {
    menu,
    items: refined.items,
    status,
    reviewReasons: reasons,
    droppedByRefinement: refined.dropped,
    refinementRejections: refined.rejected.length,
  };
}
