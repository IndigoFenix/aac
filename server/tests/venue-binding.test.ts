/**
 * Tests for the binding check (§3.1a).
 *
 * The two required regression fixtures from §7 lead the suite, both taken from
 * live MenuSpark output rather than invented:
 *
 *   1. An Israeli place record + a `.ca` franchise URL must be REJECTED.
 *   2. `currency: "CAD"` against an Israeli place must be REJECTED
 *      INDEPENDENTLY — either signal alone has to be enough, because a source
 *      can agree on one and lie about the other.
 *
 * Plus the טומי רול case: country, currency, and brand all agree and it is
 * still the wrong restaurant.
 *
 * DB-free, pure: belongs in `test:unit`.
 */

import { describe, it, expect } from "@jest/globals";
import {
  checkMenuBinding,
  countryFromHost,
  hostOf,
  placeIn,
} from "@shared/venue-binding";

/** The Israeli Aroma the search actually resolved. */
const AROMA_IL = {
  name: "ארומה אספרסו בר",
  countryCode: "IL",
  address: "דיזנגוף, תל אביב",
};

describe("the MenuSpark bug, as a regression fixture", () => {
  it("REJECTS a .ca franchise URL against an Israeli place", () => {
    const result = checkMenuBinding(AROMA_IL, {
      sourceUrl: "https://aromaespressobar.ca/menu",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejections).toContain("country_mismatch");
  });

  it("REJECTS currency CAD against an Israeli place, on its own", () => {
    // Note the URL here is unobjectionable — a .com says nothing about country.
    // The currency must carry the rejection by itself.
    const result = checkMenuBinding(AROMA_IL, {
      sourceUrl: "https://aroma.com/menu",
      currency: "CAD",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejections).toEqual(["currency_mismatch"]);
      expect(result.rejections).not.toContain("country_mismatch");
    }
  });

  it("reports BOTH when both are wrong", () => {
    const result = checkMenuBinding(AROMA_IL, {
      sourceUrl: "https://aromaespressobar.ca/menu",
      currency: "CAD",
    });
    if (!result.ok) {
      expect(result.rejections).toEqual(["country_mismatch", "currency_mismatch"]);
    }
  });
});

describe("the טומי רול case — everything agrees and it is still wrong", () => {
  const TOMMY_RG = {
    name: "טומי רול בר סניף רמת גן",
    countryCode: "IL",
    address: "ביאליק, רמת גן",
  };

  it("REJECTS a Givatayim branch URL for the Ramat Gan venue", () => {
    // Country, currency, and brand all match. Only the branch differs, and the
    // two halves are written in different scripts — which is exactly why the
    // transliteration bridge exists.
    const result = checkMenuBinding(TOMMY_RG, {
      sourceUrl: "https://wolt.com/he/isr/tel-aviv/restaurant/tommy-roll-givatayim",
      currency: "ILS",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejections).toEqual(["branch_mismatch"]);
  });

  it("accepts the matching branch as an EXACT match", () => {
    const result = checkMenuBinding(TOMMY_RG, {
      sourceUrl: "https://wolt.com/he/isr/restaurant/tommy-roll-ramat-gan",
      currency: "ILS",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bindingBranchMatch).toBe("exact");
      expect(result.bindingBasis).toBe("gps_place_match");
      expect(result.bindingCountry).toBe("IL");
    }
  });

  it("reads the CITY from Wolt's fixed path position — the wrong city refuses", () => {
    // `/he/isr/{CITY}/restaurant/{slug}`. Before this, the city sat in the
    // excluded early segments and the final slug rarely names one, so a Wolt
    // page for the WRONG city carried no branch evidence at all and sailed
    // through as an unrefusable "chain" guess (found live 2026-09-01,
    // טריולה: a Ramat Gan ask nearly bound the Petah Tikva branch's menu).
    const result = checkMenuBinding(TOMMY_RG, {
      // Slug names no city; only the fixed city segment says Givatayim.
      sourceUrl: "https://wolt.com/he/isr/givatayim/restaurant/tommy-roll",
      currency: "ILS",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejections).toEqual(["branch_mismatch"]);
  });

  it("and the RIGHT city in that position binds exact", () => {
    const result = checkMenuBinding(TOMMY_RG, {
      sourceUrl: "https://wolt.com/he/isr/ramat-gan/restaurant/tommy-roll",
      currency: "ILS",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bindingBranchMatch).toBe("exact");
  });

  it("the fixed-position read is WOLT-scoped — other hosts keep the last-segment rule", () => {
    // The whole-path mistake the branchTextOf note warns about: an arbitrary
    // aggregator's region segment is a guess, not a contract.
    const result = checkMenuBinding(TOMMY_RG, {
      sourceUrl: "https://someaggregator.co.il/he/isr/givatayim/restaurant/tommy-roll-ramat-gan",
      currency: "ILS",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bindingBranchMatch).toBe("exact");
  });

  it("falls back to chain when the source names no branch at all", () => {
    // Not a rejection — chain-level is a real, usable basis. It just never goes
    // live unattended: resolveCacheStatus sends it to a caretaker.
    const result = checkMenuBinding(TOMMY_RG, {
      sourceUrl: "https://tommyroll.co.il/menu",
      currency: "ILS",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bindingBranchMatch).toBe("chain");
      expect(result.bindingBasis).toBe("chain_fallback");
    }
  });
});

describe("checkMenuBinding — the place's own website", () => {
  const PLACE = {
    name: "Café Aroma",
    countryCode: "IL",
    websiteUri: "https://aroma.co.il",
  };

  it("binds a menu on the place's OWN site as place_website", () => {
    const result = checkMenuBinding(PLACE, { sourceUrl: "https://aroma.co.il/menu" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bindingBasis).toBe("place_website");
  });

  it("accepts a subdomain of the place's own site", () => {
    const result = checkMenuBinding(PLACE, { sourceUrl: "https://menu.aroma.co.il/" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bindingBasis).toBe("place_website");
  });

  it("calls the branch unknown when the site names none", () => {
    // Weaker than chain in one sense and the same in practice: both force a
    // caretaker to look, which is the point.
    const result = checkMenuBinding(PLACE, { sourceUrl: "https://aroma.co.il/menu" });
    if (result.ok) expect(result.bindingBranchMatch).toBe("unknown");
  });
});

describe("checkMenuBinding — what must NOT cause a rejection", () => {
  it("lets a generic TLD through — .com implies no country", () => {
    const result = checkMenuBinding(AROMA_IL, { sourceUrl: "https://aroma.com/menu" });
    expect(result.ok).toBe(true);
  });

  it("does not reject when the place record has no country", () => {
    // A missing country is missing evidence, not evidence of a problem. The
    // weak binding it produces is what forces review.
    const result = checkMenuBinding(
      { name: "Somewhere" },
      { sourceUrl: "https://example.ca/menu", currency: "CAD" },
    );
    expect(result.ok).toBe(true);
  });

  it("does not reject when the source states no currency", () => {
    const result = checkMenuBinding(AROMA_IL, { sourceUrl: "https://aroma.co.il/menu" });
    expect(result.ok).toBe(true);
  });

  it("refuses a URL it cannot even parse", () => {
    const result = checkMenuBinding(AROMA_IL, { sourceUrl: "not a url" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejections).toEqual(["unusable_url"]);
  });

  it("treats EUR as correct for any euro-zone place", () => {
    const result = checkMenuBinding(
      { name: "Café", countryCode: "DE" },
      { sourceUrl: "https://cafe.de/menu", currency: "EUR" },
    );
    expect(result.ok).toBe(true);
  });
});

describe("host and country helpers", () => {
  it("strips www and lowercases", () => {
    expect(hostOf("https://WWW.Aroma.CO.IL/menu")).toBe("aroma.co.il");
    expect(hostOf("nonsense")).toBeNull();
  });

  it("prefers the longest matching TLD suffix", () => {
    expect(countryFromHost("aroma.co.il")).toBe("IL");
    expect(countryFromHost("shop.co.uk")).toBe("GB");
    expect(countryFromHost("aromaespressobar.ca")).toBe("CA");
    expect(countryFromHost("aroma.com")).toBeNull();
  });

  it("recognises a place name in either script", () => {
    expect(placeIn("tommy-roll-givatayim")).toBe("givatayim");
    expect(placeIn("סניף גבעתיים")).toBe("givatayim");
    expect(placeIn("סניף רמת גן")).toBe("ramat-gan");
    expect(placeIn("tommy-roll-ramat-gan")).toBe("ramat-gan");
    expect(placeIn("some-unknown-town")).toBeNull();
    expect(placeIn(null)).toBeNull();
  });
});
