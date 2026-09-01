/**
 * Tests for the menu cache chokepoint (§4.2a, §4.8, §4.9).
 *
 * Two things are being defended here, and they are different:
 *
 *   1. `resolveCacheStatus` — the review escalation table. Four independent
 *      conditions can force a human to look at a menu, and every one of them
 *      may only RAISE the bar. The suite asserts there is no combination that
 *      lets a menu slip back to `approved`.
 *
 *   2. `cacheMenu` — that refinement is not something a caller remembers to do
 *      but something writing DOES, and that a hostile or absent refinement
 *      still cannot corrupt what lands in a cache every student reads from.
 *
 * The model call and the repository are injected, so this is DB-free and
 * LLM-free: belongs in `test:unit`.
 */

import { describe, it, expect, jest } from "@jest/globals";
import {
  cacheMenu,
  resolveCacheStatus,
  type CacheMenuDeps,
  type ResolveStatusInput,
} from "../services/venue-menus/menu-cache.js";
import type { RawMenuItem } from "../services/venue-menus/menu-refinement.js";

/** A clean camera capture under a permissive policy — the only approving case. */
const CLEAN: ResolveStatusInput = {
  requireReview: false,
  extractionRequiresReview: false,
  provenance: "camera",
  bindingBasis: "camera",
  bindingBranchMatch: "exact",
  existingApprovedProvenance: null,
};

describe("resolveCacheStatus — a clean capture may go live", () => {
  it("approves when nothing is in doubt", () => {
    expect(resolveCacheStatus(CLEAN)).toEqual({ status: "approved", reasons: [] });
  });

  it("approves a web menu that is exactly bound and read cleanly", () => {
    const result = resolveCacheStatus({
      ...CLEAN,
      provenance: "web",
      bindingBasis: "place_website",
      bindingBranchMatch: "exact",
    });
    expect(result.status).toBe("approved");
  });

  it("lets a fresh photograph supersede an older camera menu without review", () => {
    // Camera over camera is the caretaker re-shooting the same table. Sending
    // that back for review would make correcting a bad capture impossible.
    const result = resolveCacheStatus({ ...CLEAN, existingApprovedProvenance: "camera" });
    expect(result.status).toBe("approved");
  });
});

describe("resolveCacheStatus — each escalation, in isolation", () => {
  it("escalates on the student's policy", () => {
    const result = resolveCacheStatus({ ...CLEAN, requireReview: true });
    expect(result.status).toBe("pending_review");
    expect(result.reasons).toEqual(["policy"]);
  });

  it("escalates when the extraction says it read badly", () => {
    // §4.8's `web_only` exempts the camera from the wrong-restaurant defect,
    // never from a misread price. This must fire with requireReview false.
    const result = resolveCacheStatus({ ...CLEAN, extractionRequiresReview: true });
    expect(result.status).toBe("pending_review");
    expect(result.reasons).toEqual(["extraction_quality"]);
  });

  it("escalates a chain-level branch match — the טומי רול defect", () => {
    const result = resolveCacheStatus({
      ...CLEAN,
      provenance: "web",
      bindingBasis: "gps_place_match",
      bindingBranchMatch: "chain",
    });
    expect(result.status).toBe("pending_review");
    expect(result.reasons).toContain("chain_binding");
  });

  it("escalates a chain_fallback binding even when the branch claims exact", () => {
    // A source can assert a branch while the BASIS for believing it is only
    // "this brand has a menu somewhere". The weaker signal wins.
    const result = resolveCacheStatus({
      ...CLEAN,
      provenance: "web",
      bindingBasis: "chain_fallback",
      bindingBranchMatch: "exact",
    });
    expect(result.status).toBe("pending_review");
    expect(result.reasons).toContain("chain_binding");
  });

  it("escalates when there is no branch signal at all", () => {
    const result = resolveCacheStatus({
      ...CLEAN,
      provenance: "web",
      bindingBasis: "place_website",
      bindingBranchMatch: "unknown",
    });
    expect(result.status).toBe("pending_review");
    expect(result.reasons).toContain("unbound_branch");
  });

  it("does not call a camera capture unbound — the photograph IS the binding", () => {
    const result = resolveCacheStatus({
      ...CLEAN,
      bindingBasis: "camera",
      bindingBranchMatch: "unknown",
    });
    expect(result.reasons).not.toContain("unbound_branch");
  });

  it("escalates a scraped menu for a venue that already has a camera menu", () => {
    // Trust ordering (§4.2a): web for reach, camera for truth. The scrape may
    // be newer AND wrong — the franchise's national menu — so a human decides.
    const result = resolveCacheStatus({
      ...CLEAN,
      provenance: "web",
      bindingBasis: "place_website",
      existingApprovedProvenance: "camera",
    });
    expect(result.status).toBe("pending_review");
    expect(result.reasons).toContain("camera_menu_exists");
  });

  it("does not escalate a scrape over an existing WEB menu", () => {
    const result = resolveCacheStatus({
      ...CLEAN,
      provenance: "web",
      bindingBasis: "place_website",
      existingApprovedProvenance: "web",
    });
    expect(result.reasons).not.toContain("camera_menu_exists");
  });
});

describe("resolveCacheStatus — escalation only ever raises the bar", () => {
  it("accumulates every reason that applies", () => {
    const result = resolveCacheStatus({
      requireReview: true,
      extractionRequiresReview: true,
      provenance: "web",
      bindingBasis: "chain_fallback",
      bindingBranchMatch: "unknown",
      existingApprovedProvenance: "camera",
    });
    expect(result.status).toBe("pending_review");
    expect(result.reasons).toEqual([
      "policy",
      "extraction_quality",
      "chain_binding",
      "unbound_branch",
      "camera_menu_exists",
    ]);
  });

  it("never returns approved once any reason is present", () => {
    // Exhaustive over the escalating inputs: no combination may approve.
    // (With the default gate — the review-off exemption below is the ONE
    // deliberate exception, and it is opt-in per call.)
    const flags = [true, false];
    for (const requireReview of flags) {
      for (const extractionRequiresReview of flags) {
        for (const bindingBranchMatch of ["exact", "chain", "unknown"] as const) {
          for (const existing of ["camera", "web", null] as const) {
            const result = resolveCacheStatus({
              requireReview,
              extractionRequiresReview,
              provenance: "web",
              bindingBasis: "place_website",
              bindingBranchMatch,
              existingApprovedProvenance: existing,
            });
            if (result.reasons.length) expect(result.status).toBe("pending_review");
            else expect(result.status).toBe("approved");
          }
        }
      }
    }
  });
});

// ── cacheMenu ───────────────────────────────────────────────────────────────

const RAW: RawMenuItem[] = [
  { name: "רול אנטריקוט", price: 48, priceText: "₪48", category: "טורטיות" },
  { name: "‫לקוחות יקרים!", description: "תפריט מוצרי טומי רול...", category: "💙" },
  { name: "קוקה קולה פחית", price: 13, priceText: "₪13", category: "שתייה קלה" },
];

/** Records what reached the repository, and in what order things happened. */
function makeDeps(overrides: Partial<CacheMenuDeps> = {}) {
  const calls: string[] = [];
  const created: any[] = [];

  const deps: CacheMenuDeps = {
    requestRefinement: jest.fn(async () => {
      calls.push("refine");
      return [
        { index: 0, keep: true, kind: "food", imageKey: "beef_wrap", translatedName: "Beef roll" },
        { index: 1, keep: false, kind: "notice" },
        { index: 2, keep: true, kind: "drink", imageKey: "cola" },
      ];
    }) as CacheMenuDeps["requestRefinement"],
    repository: {
      getActiveMenu: jest.fn(async () => {
        calls.push("getActiveMenu");
        return undefined;
      }),
      createMenu: jest.fn(async (data: any) => {
        calls.push("createMenu");
        created.push(data);
        return { id: "menu-1", ...data };
      }),
    } as unknown as CacheMenuDeps["repository"],
    ...overrides,
  };

  return { deps, calls, created };
}

const BASE = {
  venueId: "venue-1",
  rawItems: RAW,
  provenance: "camera" as const,
  bindingBasis: "camera" as const,
  bindingBranchMatch: "exact" as const,
  requireReview: false,
};

describe("resolveCacheStatus — the review-off exemption (gateDoubt: false)", () => {
  // ⚖️ The interim works-first call (2026-09-01): under the "never" policy a
  // menu goes live on the extractor's sanity check alone. The two
  // binding-doubt rules fire on nearly every honest web menu — a
  // single-location restaurant fetched from its OWN site has no branch names
  // anywhere, so its branch match is "unknown" — which made "review: never"
  // mean "review: always" in practice. The doubt is still RECORDED; it just
  // stops gating.

  it("an unbound-branch web menu goes live, with the doubt on the record", () => {
    const result = resolveCacheStatus({
      requireReview: false,
      extractionRequiresReview: false,
      provenance: "web",
      bindingBasis: "place_website",
      bindingBranchMatch: "unknown",
      existingApprovedProvenance: null,
      gateDoubt: false,
    });
    expect(result.status).toBe("approved");
    expect(result.reasons).toEqual(["unbound_branch"]);
  });

  it("a chain-level binding goes live too — recorded, not gating", () => {
    const result = resolveCacheStatus({
      requireReview: false,
      extractionRequiresReview: false,
      provenance: "web",
      bindingBasis: "chain_fallback",
      bindingBranchMatch: "chain",
      existingApprovedProvenance: null,
      gateDoubt: false,
    });
    expect(result.status).toBe("approved");
    expect(result.reasons).toEqual(["chain_binding"]);
  });

  it("shaky-row confidence goes live too under review-off — recorded, not gating", () => {
    // `extractionRequiresReview` fires when ONE row of many is below the
    // extractor's confidence bar (page-merge: lowConfidenceCount > 0). On
    // 2026-09-01 that parked a fully-extracted 40-row menu behind a review
    // nobody was staffing; Daniel's ruling: found and refined means shown.
    // (A page that was not a menu at all extracts zero items and is a
    // failure long before this table.)
    const result = resolveCacheStatus({
      requireReview: false,
      extractionRequiresReview: true,
      provenance: "web",
      bindingBasis: "place_website",
      bindingBranchMatch: "unknown",
      existingApprovedProvenance: null,
      gateDoubt: false,
    });
    expect(result.status).toBe("approved");
    expect(result.reasons).toContain("extraction_quality");
  });

  it("under the DEFAULT gate, the extractor's doubt still blocks", () => {
    const result = resolveCacheStatus({
      requireReview: false,
      extractionRequiresReview: true,
      provenance: "web",
      bindingBasis: "place_website",
      bindingBranchMatch: "exact",
      existingApprovedProvenance: null,
    });
    expect(result.status).toBe("pending_review");
  });

  it("an explicit policy still gates — the exemption is about binding doubt only", () => {
    const result = resolveCacheStatus({
      requireReview: true,
      extractionRequiresReview: false,
      provenance: "web",
      bindingBasis: "place_website",
      bindingBranchMatch: "unknown",
      existingApprovedProvenance: null,
      gateDoubt: false,
    });
    expect(result.status).toBe("pending_review");
  });

  it("an approved camera menu is still protected from a silent web replacement", () => {
    // Different promise than binding doubt: this rule protects a menu a human
    // already trusted, so review-off does not touch it.
    const result = resolveCacheStatus({
      requireReview: false,
      extractionRequiresReview: false,
      provenance: "web",
      bindingBasis: "place_website",
      bindingBranchMatch: "exact",
      existingApprovedProvenance: "camera",
      gateDoubt: false,
    });
    expect(result.status).toBe("pending_review");
    expect(result.reasons).toEqual(["camera_menu_exists"]);
  });
});

describe("cacheMenu — refinement is what writing DOES", () => {
  it("refines before it writes", () => {
    const { deps, calls } = makeDeps();
    return cacheMenu(BASE, deps).then(() => {
      expect(calls.indexOf("refine")).toBeLessThan(calls.indexOf("createMenu"));
    });
  });

  it("persists the refined items, with the notice row dropped", async () => {
    const { deps, created } = makeDeps();
    const result = await cacheMenu(BASE, deps);

    expect(result.items).toHaveLength(2);
    expect(created[0].items).toHaveLength(2);
    expect(created[0].items.map((i: any) => i.kind)).toEqual(["food", "drink"]);
    expect(result.droppedByRefinement).toEqual([
      { index: 1, name: "‫לקוחות יקרים!", reason: "not_kept" },
    ]);
  });

  it("writes the annotations but re-reads every fact from the raw item", async () => {
    const { deps, created } = makeDeps();
    await cacheMenu(BASE, deps);

    const first = created[0].items[0];
    expect(first.name).toBe("רול אנטריקוט"); // untouched
    expect(first.price).toBe(48);
    expect(first.priceText).toBe("₪48");
    expect(first.translatedName).toBe("Beef roll"); // annotation, additive
    expect(first.imageKey).toBe("beef_wrap");
  });

  it("cannot be handed an invented dish — there is no field for one", async () => {
    const { deps, created } = makeDeps({
      requestRefinement: (async () => [
        { index: 0, keep: true, kind: "food", name: "Wagyu Steak", price: 400 },
        { index: 9, keep: true, kind: "food" }, // a row that does not exist
      ]) as CacheMenuDeps["requestRefinement"],
    });

    const result = await cacheMenu(BASE, deps);

    const names = created[0].items.map((i: any) => i.name);
    expect(names).not.toContain("Wagyu Steak");
    expect(created[0].items[0].name).toBe("רול אנטריקוט");
    expect(created[0].items[0].price).toBe(48);
    expect(result.refinementRejections).toBe(1); // the out-of-range index
  });

  it("still writes the menu when refinement fails entirely", async () => {
    // Annotation fails OPEN. Losing a caretaker's photographs because a
    // classification call timed out is the worse outcome by a distance.
    const { deps, created } = makeDeps({
      requestRefinement: (async () => []) as CacheMenuDeps["requestRefinement"],
    });

    const result = await cacheMenu(BASE, deps);

    expect(created[0].items).toHaveLength(RAW.length);
    expect(created[0].items.every((i: any) => i.kind === "unknown")).toBe(true);
    expect(result.status).toBe("approved");
  });
});

describe("cacheMenu — escalation reaches the row", () => {
  it("writes the status resolveCacheStatus decided", async () => {
    const { deps, created } = makeDeps();
    const result = await cacheMenu({ ...BASE, requireReview: true }, deps);

    expect(created[0].status).toBe("pending_review");
    expect(result.status).toBe("pending_review");
    expect(result.reviewReasons).toEqual(["policy"]);
  });

  it("escalates a scrape when the venue already has an approved camera menu", async () => {
    const { deps, created } = makeDeps({
      repository: {
        getActiveMenu: async () => ({ provenance: "camera" }) as any,
        createMenu: (async (data: any) => ({ id: "menu-2", ...data })) as any,
      } as unknown as CacheMenuDeps["repository"],
    });

    const result = await cacheMenu(
      {
        ...BASE,
        provenance: "web",
        bindingBasis: "place_website",
        sourceUrl: "https://example.co.il/menu",
      },
      deps,
    );

    expect(result.status).toBe("pending_review");
    expect(result.reviewReasons).toContain("camera_menu_exists");
    void created;
  });

  it("records the binding on the row — a menu cannot exist without its justification", async () => {
    const { deps, created } = makeDeps();
    await cacheMenu({ ...BASE, bindingCountry: "IL" }, deps);

    expect(created[0].bindingBasis).toBe("camera");
    expect(created[0].bindingBranchMatch).toBe("exact");
    expect(created[0].bindingCountry).toBe("IL");
  });

  it("defaults the language rather than writing a null", async () => {
    const { deps, created } = makeDeps();
    await cacheMenu({ ...BASE, targetLanguage: "he" }, deps);
    expect(created[0].language).toBe("he");
  });
});
