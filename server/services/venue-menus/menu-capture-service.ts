// server/services/venue-menus/menu-capture-service.ts
//
// The CAMERA path, end to end:
//
//   frames -> extract (vision) -> merge pages -> cacheMenu()
//
// Everything after the merge belongs to `menu-cache.ts` — refinement, review
// escalation, and the write itself. This service's job is turning photographs
// into raw items and describing where they came from; it deliberately does not
// touch `venueRepository.createMenu`, because a second source (step 7's web
// fetch) must go through the same door and get the same treatment.
//
// See planning-docs/aac-restaurant-menus.md §4.2, §4.2a.

import { venueRepository } from "../../repositories/venueRepository";
import { extractMenuFromFrames, type CameraExtractionOptions } from "./camera-extraction.js";
import { cacheMenu, type CacheReviewReason, type MenuStatus } from "./menu-cache.js";
import type { RefinedMenuItem } from "./menu-refinement.js";
import type { VenueMenu } from "@shared/schema";
import type { DisclosureContext } from "../processorDisclosure";

export interface CaptureMenuInput {
  venueId: string;
  /** Base64 JPEGs, in the order the caretaker shot them. */
  frames: string[];
  /** Language to render item names in — normally the student's. */
  targetLanguage?: string;
  /** Hint for the vision pass about what the menu is written in. */
  expectedLanguage?: string;
  /**
   * Review policy already resolved for this student (§4.8). The capture can
   * only RAISE the bar from here — a menu we could not read needs a human
   * whatever the policy says.
   */
  requireReview: boolean;
  /** AKIM §18.5 — who this menu work is for; rides down to the vision /
   *  extraction / refinement calls that leave for a processor. */
  disclosure?: DisclosureContext;
}

export interface CaptureMenuResult {
  menu: VenueMenu;
  items: RefinedMenuItem[];
  status: MenuStatus;
  /** Why review was required, if it was — shown to the caretaker. */
  reviewReasons: CacheReviewReason[];
  /** Caretaker-facing capture stats. */
  framesRead: number;
  framesFailed: number;
  droppedDuplicates: number;
  lowConfidenceCount: number;
  /** Rows refinement removed, so the review UI can show what went missing. */
  droppedByRefinement: Array<{ index: number; name: string; reason: string }>;
  /** Non-empty means the refinement prompt is drifting — worth a log alert. */
  refinementRejections: number;
}

export class MenuCaptureService {
  /**
   * Capture a menu from camera frames and persist it.
   *
   * Throws only on a missing venue or an empty frame list — a partial or
   * unreadable capture still produces a row, marked `pending_review`, because a
   * caretaker looking at a half-read menu can fix it, and a caretaker looking at
   * an error message cannot.
   */
  async captureFromCamera(input: CaptureMenuInput): Promise<CaptureMenuResult> {
    const { venueId, frames } = input;

    if (!frames?.length) throw new Error("captureFromCamera: no frames supplied");

    const venue = await venueRepository.getById(venueId);
    if (!venue) throw new Error(`captureFromCamera: unknown venue ${venueId}`);

    const extractOptions: CameraExtractionOptions = {
      ...(input.expectedLanguage ? { expectedLanguage: input.expectedLanguage } : {}),
      ...(input.disclosure ? { disclosure: input.disclosure } : {}),
    };
    const extracted = await extractMenuFromFrames(frames, extractOptions);

    const cached = await cacheMenu({
      venueId,
      rawItems: extracted.items,
      ...(extracted.language ? { language: extracted.language } : {}),
      ...(extracted.currency ? { currency: extracted.currency } : {}),
      provenance: "camera",
      // The camera IS the binding: the menu was physically in front of the
      // student, so there is no URL to tie to a place and nothing to get wrong.
      // That is also why `bindingBranchMatch` is 'exact' — this is not a claim
      // about a brand, it is a photograph of one specific table.
      bindingBasis: "camera",
      ...(venue.countryCode ? { bindingCountry: venue.countryCode } : {}),
      bindingBranchMatch: "exact",
      requireReview: input.requireReview,
      extractionRequiresReview: extracted.requiresReview,
      ...(input.targetLanguage ? { targetLanguage: input.targetLanguage } : {}),
      ...(input.disclosure ? { disclosure: input.disclosure } : {}),
    });

    return {
      menu: cached.menu,
      items: cached.items,
      status: cached.status,
      reviewReasons: cached.reviewReasons,
      framesRead: extracted.framesRead,
      framesFailed: extracted.framesFailed,
      droppedDuplicates: extracted.droppedDuplicates,
      lowConfidenceCount: extracted.lowConfidenceCount,
      droppedByRefinement: cached.droppedByRefinement,
      refinementRejections: cached.refinementRejections,
    };
  }
}

export const menuCaptureService = new MenuCaptureService();
