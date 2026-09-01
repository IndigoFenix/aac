/**
 * Tests for the web menu source (§4.2b, step 7).
 *
 * The live Bright Data endpoints cannot be exercised here — no token exists in
 * this environment — so everything shape-dependent is isolated into pure
 * functions and those are what this suite pins:
 *
 *   - WHICH URLs we are willing to fetch at all (the Aroma defect lives here)
 *   - the HTML reduction, where Hebrew entity handling is easy to get wrong
 *   - the provider row → venue mapping, where a bad row must be dropped
 *   - the price rule the טומי רול teardown forced
 *
 * DB-free, no network: belongs in `test:unit`.
 */

import { describe, it, expect } from "@jest/globals";
import { htmlToText, menuUrlCandidates } from "../services/venue-menus/web-menu-fetcher.js";
import {
  discoveryQuery,
  localityOf,
  parseSearchResults,
  woltQuery,
} from "../services/venue-menus/website-discovery.js";
import { toVenue, parseSnapshot } from "../services/venue-menus/brightdata-client.js";
import { toVenue as osmToVenue } from "../services/venue-menus/osm-venue-provider.js";
import { parseWebExtraction } from "../services/venue-menus/web-menu-extraction.js";
import { buildVenueMenuBoard } from "../services/venue-menus/menu-board-builder.js";
import type { RefinedMenuItem } from "../services/venue-menus/menu-refinement.js";

describe("menuUrlCandidates — what we are willing to fetch", () => {
  it("derives every candidate from the place's OWN site", () => {
    // §4.2b. When the record HAS a site, there is no search step: a brand-name
    // search is how a Canadian franchise once won an Israeli query. Discovery
    // (below) runs only for a record with no site at all, and its results
    // still bind-first.
    const candidates = menuUrlCandidates({ websiteUri: "https://aroma.co.il" });

    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates.every((url) => url.includes("aroma.co.il"))).toBe(true);
    expect(candidates[0]).toBe("https://aroma.co.il/menu");
  });

  it("stops at a stored URL that already points at a menu", () => {
    expect(menuUrlCandidates({ websiteUri: "https://aroma.co.il/our-menu/lunch" })).toEqual([
      "https://aroma.co.il/our-menu/lunch",
    ]);
  });

  it("recognises a Hebrew menu path", () => {
    const candidates = menuUrlCandidates({ websiteUri: "https://tommyroll.co.il/תפריט" });
    expect(candidates).toHaveLength(1);
  });

  it("returns nothing when the place has no site — nothing to bind to", () => {
    expect(menuUrlCandidates({ websiteUri: null })).toEqual([]);
    expect(menuUrlCandidates({ websiteUri: "  " })).toEqual([]);
    expect(menuUrlCandidates({ websiteUri: "not a url" })).toEqual([]);
  });

  it("tolerates a stored site with no scheme", () => {
    const candidates = menuUrlCandidates({ websiteUri: "aroma.co.il" });
    expect(candidates[0]).toBe("https://aroma.co.il/menu");
  });
});

describe("website discovery — the search step for venues with no site on record", () => {
  // Most OSM rows carry no `website` tag and the paid Maps dataset is not
  // configured, so before this existed the web source answered `no_source_url`
  // for essentially every venue a student asked about (2026-09-01). The
  // original no-search lesson survives as two properties, both pinned here:
  // the query is spatially anchored, and (in the fetcher) every discovered
  // URL still passes checkMenuBinding before a byte is fetched.

  describe("localityOf", () => {
    it("takes the last lettered segment of a street-first address", () => {
      expect(localityOf("דיזנגוף 99, תל אביב")).toBe("תל אביב");
      expect(localityOf("99 Main St, Springfield")).toBe("Springfield");
    });

    it("steps over a trailing country name — the TLD check owns countries", () => {
      expect(localityOf("דיזנגוף 99, תל אביב, ישראל")).toBe("תל אביב");
    });

    it("null address is a weaker query, not a failure", () => {
      expect(localityOf(null)).toBeNull();
      expect(localityOf("  ")).toBeNull();
    });
  });

  describe("discoveryQuery — the spatial anchor", () => {
    it("quotes the name and anchors with locality + Hebrew menu word for IL", () => {
      expect(
        discoveryQuery({ name: "טריולה", address: "אבא הלל 5, רמת גן", countryCode: "IL" }),
      ).toBe('"טריולה" רמת גן תפריט');
    });

    it("the Wolt pass targets the one host the probes showed server-rendering menus", () => {
      expect(woltQuery({ name: "טריולה" })).toBe('site:wolt.com "טריולה"');
    });

    it("falls back to 'menu' outside Israel or with no country", () => {
      expect(discoveryQuery({ name: "Trattoria Roma", address: null, countryCode: null })).toBe(
        '"Trattoria Roma" menu',
      );
    });
  });

  describe("parseSearchResults", () => {
    const redirect = (target: string) =>
      `<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=abc">x</a>`;

    it("decodes the redirect form and keeps page order", () => {
      const html = redirect("https://triola.co.il/") + redirect("https://wolt.com/he/isr/ramat-gan/restaurant/triola");
      expect(parseSearchResults(html)).toEqual([
        "https://triola.co.il/",
        "https://wolt.com/he/isr/ramat-gan/restaurant/triola",
      ]);
    });

    it("keeps one URL per host — the second hit on a site is the same site", () => {
      const html = redirect("https://triola.co.il/menu") + redirect("https://www.triola.co.il/about");
      expect(parseSearchResults(html)).toHaveLength(1);
    });

    it("drops binary documents the text pass cannot read", () => {
      // A PDF is often the REAL menu (the live probe found טריולה's own as a
      // top result) — but there is no PDF pipeline, so fetching one only buys
      // an Unlocker call that extracts nothing.
      const html =
        redirect("https://triola.co.il/wp-content/uploads/menu.pdf") +
        redirect("https://triola.co.il/");
      expect(parseSearchResults(html)).toEqual(["https://triola.co.il/"]);
    });

    it("drops search engines and JavaScript-walled gardens", () => {
      const html =
        redirect("https://www.facebook.com/triola") +
        redirect("https://www.instagram.com/triola") +
        redirect("https://duckduckgo.com/settings") +
        redirect("https://triola.co.il/");
      expect(parseSearchResults(html)).toEqual(["https://triola.co.il/"]);
    });

    it("keeps aggregators — an aggregator page is a fine place to READ a menu", () => {
      // The branch check downstream is what keeps it the right branch's.
      const html = redirect("https://wolt.com/he/isr/tel-aviv/restaurant/triola");
      expect(parseSearchResults(html)).toHaveLength(1);
    });

    it("caps the candidate list — deeper results are not menus", () => {
      const html = Array.from({ length: 10 }, (_, i) => redirect(`https://site${i}.co.il/`)).join("");
      expect(parseSearchResults(html)).toHaveLength(5);
    });

    it("falls back to direct hrefs when the page carries no redirects", () => {
      const html = `<a href="https://triola.co.il/menu">menu</a><a href="/internal">x</a>`;
      expect(parseSearchResults(html)).toEqual(["https://triola.co.il/menu"]);
    });

    it("an unparseable page yields nothing, quietly", () => {
      expect(parseSearchResults("")).toEqual([]);
      expect(parseSearchResults("<html>no links</html>")).toEqual([]);
    });
  });
});

describe("htmlToText", () => {
  it("drops scripts, styles, and page furniture", () => {
    const html = `
      <nav>Home About</nav>
      <script>var x = "Fake Dish";</script>
      <style>.a{color:red}</style>
      <div>רול אנטריקוט 48₪</div>
      <footer>Follow us</footer>`;
    const text = htmlToText(html);

    expect(text).toContain("רול אנטריקוט");
    expect(text).not.toContain("Fake Dish");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("Follow us");
  });

  it("keeps rows apart rather than gluing dish names together", () => {
    // A stray &nbsp; between two <li>s is how "סלט יווני" and "פסטה" become one
    // dish that no restaurant serves.
    const text = htmlToText("<li>סלט יווני</li>&nbsp;<li>פסטה</li>");
    expect(text).toMatch(/סלט יווני\s*\n?\s*פסטה/);
    expect(text).not.toContain("סלט יווניפסטה");
  });

  it("decodes the entities a menu page actually uses", () => {
    expect(htmlToText("<p>Fish &amp; Chips</p>")).toBe("Fish & Chips");
    expect(htmlToText("<p>&quot;Chef&#39;s&quot; salad</p>")).toBe('"Chef\'s" salad');
  });

  it("collapses whitespace without collapsing paragraphs", () => {
    expect(htmlToText("<p>A</p>\n\n\n\n<p>B</p>")).toBe("A\n\nB");
  });
});

describe("Bright Data place → venue", () => {
  const PLACE = {
    place_id: "ChIJ123",
    name: "ארומה אספרסו בר",
    latitude: 32.0785,
    longitude: 34.7741,
    full_address: "דיזנגוף 100, תל אביב",
    country_code: "il",
    website: "https://aroma.co.il",
    category: "Cafe",
  };

  it("maps a full record, including the website the binding check needs", () => {
    const venue = toVenue(PLACE)!;
    expect(venue.source).toBe("brightdata");
    expect(venue.sourceId).toBe("ChIJ123");
    expect(venue.websiteUri).toBe("https://aroma.co.il");
    expect(venue.countryCode).toBe("IL"); // upper-cased for comparison
  });

  it("drops a row with no name, no coordinates, or no stable id", () => {
    // Without an id the cache cannot converge; the rest would be a blank button.
    expect(toVenue({ ...PLACE, name: "" })).toBeNull();
    expect(toVenue({ ...PLACE, latitude: undefined })).toBeNull();
    expect(toVenue({ ...PLACE, place_id: "" })).toBeNull();
  });

  it("refuses a country NAME where a code belongs", () => {
    // "Israel" in countryCode would make every binding comparison silently
    // fail to match, which reads as "no country recorded" rather than as a bug.
    const venue = toVenue({ ...PLACE, country_code: undefined, country: "Israel" })!;
    expect(venue.countryCode).toBeUndefined();
  });

  it("accepts lat/lon under either field name", () => {
    const venue = toVenue({ ...PLACE, latitude: undefined, longitude: undefined, lat: 1, lon: 2 })!;
    expect(venue.latitude).toBe(1);
  });

  it("finds the rows in whichever envelope the snapshot used", () => {
    expect(parseSnapshot([{ name: "a" }])).toHaveLength(1);
    expect(parseSnapshot({ data: [{ name: "a" }] })).toHaveLength(1);
    expect(parseSnapshot({ results: [{ name: "a" }] })).toHaveLength(1);
    expect(parseSnapshot({ nope: 1 })).toEqual([]);
    expect(parseSnapshot(null)).toEqual([]);
  });
});

describe("OSM element → venue", () => {
  it("prefixes the id with the element type", () => {
    // A node and a way can share an id number; without the prefix they collide
    // in the cache's unique (source, sourceId).
    const venue = osmToVenue({
      type: "way",
      id: 42,
      center: { lat: 32, lon: 34 },
      tags: { name: "Cafe", amenity: "cafe" },
    })!;
    expect(venue.sourceId).toBe("way/42");
  });

  it("drops nameless elements", () => {
    expect(osmToVenue({ type: "node", id: 1, lat: 32, lon: 34, tags: {} })).toBeNull();
  });
});

describe("parseWebExtraction", () => {
  it("reads a real Claude-shaped response", () => {
    const page = parseWebExtraction({
      content: JSON.stringify({
        language: "he",
        currency: "ILS",
        items: [{ name: "רול אנטריקוט", price: 48, priceText: "₪48", confidence: 0.9 }],
      }),
      toolCalls: [],
    })!;

    expect(page.items).toHaveLength(1);
    expect(page.currency).toBe("ILS");
  });

  it("drops nameless rows and returns null when there is no items array", () => {
    const page = parseWebExtraction({ content: JSON.stringify({ items: [{ name: "  " }] }) })!;
    expect(page.items).toEqual([]);
    expect(parseWebExtraction({ content: JSON.stringify({ language: "he" }) })).toBeNull();
  });
});

describe("web prices are not dine-in prices", () => {
  const items: RefinedMenuItem[] = [
    { name: "רול אנטריקוט", price: 48, priceText: "₪48", kind: "food" },
  ];
  const settings = { categoryPages: false, showPrices: true };

  it("suppresses prices from a WEB menu even when showPrices is on", () => {
    // The טומי רול page carried the restaurant's OWN notice that delivery
    // prices differ from in-restaurant ones — on a page where all 59 rows were
    // priced. A student at a table would be reading the wrong number.
    const { board, stats } = buildVenueMenuBoard({
      venueName: "T",
      items,
      settings,
      provenance: "web",
    });

    expect(board!.pages[0].buttons[0].label).not.toContain("₪48");
    expect(stats.pricesSuppressed).toBe(true);
  });

  it("keeps prices from the camera — a photograph IS the dine-in menu", () => {
    const { board, stats } = buildVenueMenuBoard({
      venueName: "T",
      items,
      settings,
      provenance: "camera",
    });

    expect(board!.pages[0].buttons[0].label).toContain("₪48");
    expect(stats.pricesSuppressed).toBe(false);
  });

  it("treats a manual menu like the camera — a caretaker typed what they saw", () => {
    const { board } = buildVenueMenuBoard({
      venueName: "T",
      items,
      settings,
      provenance: "manual",
    });
    expect(board!.pages[0].buttons[0].label).toContain("₪48");
  });

  it("does not claim suppression when prices were off anyway", () => {
    const { stats } = buildVenueMenuBoard({
      venueName: "T",
      items,
      settings: { ...settings, showPrices: false },
      provenance: "web",
    });
    expect(stats.pricesSuppressed).toBe(false);
  });
});
