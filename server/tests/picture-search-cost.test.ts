// Cost model + proxy bound for picture search.
//
// Both are pure, so they are cheap to pin — and both are the kind of thing that
// gets "simplified" by someone who does not know a credit is a dollar. The
// magnitude assertions below are deliberately loose ranges: they exist to catch
// an error of a THOUSAND, not to freeze a rate.

import {
  imageProxyCredits,
  creditsForPictureSearchOpen,
  PROVIDER_USD_PER_QUERY,
  PICTURE_SEARCH_COST_CATEGORY,
} from "../services/picture-search/picture-search-cost";
import {
  allowImageProxyFetch,
  resetImageProxyRateLimit,
} from "../services/picture-search/proxy-rate-limit";

describe("imageProxyCredits", () => {
  it("charges nothing for a zero-byte or nonsense size", () => {
    expect(imageProxyCredits(0)).toBe(0);
    expect(imageProxyCredits(-1)).toBe(0);
    expect(imageProxyCredits(NaN)).toBe(0);
  });

  it("grows with the payload", () => {
    expect(imageProxyCredits(500 * 1024)).toBeGreaterThan(imageProxyCredits(50 * 1024));
  });

  it("charges the per-request floor even for a tiny image", () => {
    // Gateway request + Lambda time are paid whatever the size. A model that
    // returned ~0 for a 1KB image would make a loop of tiny fetches look free.
    expect(imageProxyCredits(1024)).toBeGreaterThan(0);
  });

  it("prices a typical image in the tens of microdollars", () => {
    const typical = imageProxyCredits(300 * 1024);
    expect(typical).toBeGreaterThan(0.000001);
    expect(typical).toBeLessThan(0.001);
  });
});

describe("creditsForPictureSearchOpen", () => {
  it("falls back to the bare provider charge when nothing came back", () => {
    // Reached only if a caller charges a zero-result search; the coordinator
    // charges on `ok` outcomes, which always carry results.
    expect(creditsForPictureSearchOpen(0)).toBe(PROVIDER_USD_PER_QUERY);
  });

  it("grows with the number of pictures shown", () => {
    expect(creditsForPictureSearchOpen(9)).toBeGreaterThan(creditsForPictureSearchOpen(3));
  });

  it("treats a fractional or negative count as its floor", () => {
    expect(creditsForPictureSearchOpen(-4)).toBe(creditsForPictureSearchOpen(0));
    expect(creditsForPictureSearchOpen(3.9)).toBe(creditsForPictureSearchOpen(3));
  });

  it("costs far less than a single LLM turn", () => {
    // The point of the whole model: picture search must not read as a major
    // line item, or it will get optimized instead of the things that matter.
    // A Speaker turn is ~$0.01+; a full 9-result open should be well under a
    // tenth of that.
    expect(creditsForPictureSearchOpen(9)).toBeLessThan(0.001);
  });

  it("still costs something, so 200 opens are visible in a report", () => {
    expect(creditsForPictureSearchOpen(9) * 200).toBeGreaterThan(0.01);
  });

  it("names a ledger category", () => {
    expect(PICTURE_SEARCH_COST_CATEGORY).toBe("pictures");
  });
});

describe("allowImageProxyFetch", () => {
  beforeEach(() => resetImageProxyRateLimit());

  it("allows an ordinary burst — a full grid plus a few full views", () => {
    for (let i = 0; i < 30; i++) {
      expect(allowImageProxyFetch("1.2.3.4", 1_000)).toBe(true);
    }
  });

  it("stops a replay loop inside one window", () => {
    let allowed = 0;
    for (let i = 0; i < 500; i++) {
      if (allowImageProxyFetch("1.2.3.4", 1_000)) allowed++;
    }
    expect(allowed).toBeLessThan(500);
    expect(allowImageProxyFetch("1.2.3.4", 1_000)).toBe(false);
  });

  it("does not let one caller starve another", () => {
    for (let i = 0; i < 500; i++) allowImageProxyFetch("1.2.3.4", 1_000);
    expect(allowImageProxyFetch("5.6.7.8", 1_000)).toBe(true);
  });

  it("forgives once the window has passed", () => {
    for (let i = 0; i < 500; i++) allowImageProxyFetch("1.2.3.4", 1_000);
    expect(allowImageProxyFetch("1.2.3.4", 1_000)).toBe(false);
    expect(allowImageProxyFetch("1.2.3.4", 1_000 + 61_000)).toBe(true);
  });
});
