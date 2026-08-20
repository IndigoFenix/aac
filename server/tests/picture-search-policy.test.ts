/**
 * The picture-search gate: what the AAC is allowed to look for on the web, and
 * what a search that fails is allowed to tell the assistant.
 *
 * Everything here is pure — no network, no database, no LLM. That is deliberate:
 * these are the rules that decide what appears on a child's screen, so they must
 * be cheap enough to run on every commit.
 */

import { describe, test, expect } from "@jest/globals";
import {
  BASELINE_BLOCKED_TERMS,
  blockedTagFor,
  blockedTermFor,
  DEFAULT_MAX_RESULTS,
  MAX_QUERY_CHARS,
  MAX_RESULTS_CEILING,
  normalizePictureSearchConfig,
  normalizeSearchQuery,
  pictureSearchConfigFrom,
  PICTURE_SEARCH_APP_ID,
} from "../../shared/picture-search.js";
import { hitIsUsable, mapPixabayHit, type RawImageHit } from "../services/picture-search/picture-search-provider.js";
import { pictureSearchFailureNote, sourceDomainOf } from "../services/picture-search/picture-search-service.js";
import { APP_REGISTRY } from "../services/dual-agent/app-registry.js";

// ── Settings ────────────────────────────────────────────────────────────────

describe("normalizePictureSearchConfig", () => {
  test("defaults to OFF — the feature is never inherited", () => {
    expect(normalizePictureSearchConfig(undefined).enabled).toBe(false);
    expect(normalizePictureSearchConfig({}).enabled).toBe(false);
    // Only a literal `true` counts. A truthy string must not enable web imagery.
    expect(normalizePictureSearchConfig({ enabled: "yes" }).enabled).toBe(false);
    expect(normalizePictureSearchConfig({ enabled: 1 }).enabled).toBe(false);
    expect(normalizePictureSearchConfig({ enabled: true }).enabled).toBe(true);
  });

  test("survives a hand-mangled appConfig blob", () => {
    // app_config is client-writable jsonb; garbage must degrade, never throw.
    for (const junk of [null, "string", 42, [], { blockedTerms: "cat" }]) {
      const cfg = normalizePictureSearchConfig(junk);
      expect(cfg.enabled).toBe(false);
      expect(cfg.blockedTerms).toEqual([]);
      expect(cfg.maxResults).toBe(DEFAULT_MAX_RESULTS);
    }
  });

  test("blocked terms are trimmed, lowercased and de-junked", () => {
    const cfg = normalizePictureSearchConfig({
      blockedTerms: ["  Spiders ", "", "   ", 7, null, "BALLOONS"],
    });
    expect(cfg.blockedTerms).toEqual(["spiders", "balloons"]);
  });

  test("maxResults is clamped into the shared range", () => {
    expect(normalizePictureSearchConfig({ maxResults: 0 }).maxResults).toBe(1);
    expect(normalizePictureSearchConfig({ maxResults: -5 }).maxResults).toBe(1);
    expect(normalizePictureSearchConfig({ maxResults: 999 }).maxResults).toBe(MAX_RESULTS_CEILING);
    expect(normalizePictureSearchConfig({ maxResults: "12" }).maxResults).toBe(DEFAULT_MAX_RESULTS);
    expect(normalizePictureSearchConfig({ maxResults: 6 }).maxResults).toBe(6);
  });

  test("reads the entry out of a whole appConfig by registry id", () => {
    const cfg = pictureSearchConfigFrom({
      drawing: { enabled: true },
      [PICTURE_SEARCH_APP_ID]: { enabled: true, maxResults: 4 },
    });
    expect(cfg).toEqual({ enabled: true, blockedTerms: [], maxResults: 4 });
  });
});

// ── Query normalization ─────────────────────────────────────────────────────

describe("normalizeSearchQuery", () => {
  test("keeps ordinary words and collapses whitespace", () => {
    expect(normalizeSearchQuery("  a big   red  fire truck ")).toBe("a big red fire truck");
  });

  test("strips search operators the model could smuggle in", () => {
    // The point is that NO operator survives, not that each is special-cased.
    expect(normalizeSearchQuery('cats site:example.com')).toBe("cats site example com");
    expect(normalizeSearchQuery('"exact phrase" -kittens')).toBe("exact phrase -kittens");
    expect(normalizeSearchQuery("dogs&safe=off")).toBe("dogs safe off");
    expect(normalizeSearchQuery("cats\nfiletype:pdf")).toBe("cats filetype pdf");
  });

  test("leaves non-Latin scripts completely intact", () => {
    // A blacklist of ASCII punctuation would have mangled every locale we ship.
    expect(normalizeSearchQuery("ג'ירפה")).toBe("ג'ירפה");
    expect(normalizeSearchQuery("长颈鹿")).toBe("长颈鹿");
    expect(normalizeSearchQuery("زرافة")).toBe("زرافة");
    expect(normalizeSearchQuery("기린")).toBe("기린");
  });

  test("rejects what is not worth searching", () => {
    expect(normalizeSearchQuery(undefined)).toBeNull();
    expect(normalizeSearchQuery(null)).toBeNull();
    expect(normalizeSearchQuery("")).toBeNull();
    expect(normalizeSearchQuery("   ")).toBeNull();
    expect(normalizeSearchQuery("!!!")).toBeNull();
    expect(normalizeSearchQuery("a")).toBeNull();
  });

  test("caps length without leaving a trailing space", () => {
    const long = normalizeSearchQuery("giraffe ".repeat(40));
    expect(long!.length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
    expect(long).toBe(long!.trim());
  });
});

// ── Blocking ────────────────────────────────────────────────────────────────

describe("blockedTermFor", () => {
  test("every baseline term blocks itself", () => {
    for (const term of BASELINE_BLOCKED_TERMS) {
      expect(blockedTermFor(term)).toBe(term);
    }
  });

  test("baseline applies with no clinician configuration at all", () => {
    expect(blockedTermFor("a picture of a gun")).toBe("gun");
    expect(blockedTermFor("SUICIDE")).toBe("suicide");
  });

  test("single ASCII words respect word boundaries", () => {
    // The classic over-block. "gun" must not take "penguin" with it.
    expect(blockedTermFor("penguin")).toBeNull();
    expect(blockedTermFor("a penguin on ice")).toBeNull();
    expect(blockedTermFor("drugstore")).toBeNull();
    expect(blockedTermFor("a gun")).toBe("gun");
  });

  test("clinician terms stack on top of the baseline", () => {
    expect(blockedTermFor("a big spider", ["spider"])).toBe("spider");
    expect(blockedTermFor("a big spider")).toBeNull();
  });

  test("phrases and non-Latin terms match by containment", () => {
    expect(blockedTermFor("someone with a dead body")).toBe("dead body");
    expect(blockedTermFor("עכביש גדול", ["עכביש"])).toBe("עכביש");
    expect(blockedTermFor("大蜘蛛", ["蜘蛛"])).toBe("蜘蛛");
  });

  test("clears an ordinary request", () => {
    expect(blockedTermFor("a giraffe eating leaves", ["spiders"])).toBeNull();
  });
});

// ── Result filtering ────────────────────────────────────────────────────────

function hit(over: Partial<RawImageHit> = {}): RawImageHit {
  return {
    title: "A giraffe",
    link: "https://example.com/giraffe.jpg",
    thumbnailLink: "https://tn.example.com/g.jpg",
    contextLink: "https://www.example.com/animals",
    mime: "image/jpeg",
    width: 800,
    height: 600,
    ...over,
  };
}

describe("blockedTagFor — screening what the picture DEPICTS", () => {
  // Pixabay's safesearch means "suitable for all ages" in the ADULT-content
  // sense, so a cocktail bar sails through it. Reported 2026-08-20: searching
  // "drink" returned bars.

  test("drops the bar photos that a search for 'drink' actually returned", () => {
    expect(blockedTagFor("cocktail, drink, alcohol, glass")).toBe("cocktail");
    expect(blockedTagFor("bar, restaurant, interior, counter")).toBe("bar");
    expect(blockedTagFor("beer bottle, table")).toBe("beer bottle");
  });

  test("passes the picture a child asking for a drink actually wants", () => {
    expect(blockedTagFor("water, glass, drink, fresh")).toBeNull();
    expect(blockedTagFor("juice, orange, breakfast")).toBeNull();
    expect(blockedTagFor("milk, cup, kitchen")).toBeNull();
  });

  test("an ambiguous word is blocked only as a WHOLE tag", () => {
    // The reason the list is split in two. Over-blocking is invisible to a
    // student — they just get an empty grid and cannot ask why.
    expect(blockedTagFor("bar")).toBe("bar");
    expect(blockedTagFor("chocolate bar, sweet, snack")).toBeNull();
    expect(blockedTagFor("monkey bars, playground")).toBeNull();
    expect(blockedTagFor("grave")).toBe("grave");
    expect(blockedTagFor("gravel, path, stones")).toBeNull();
  });

  test("an unambiguous word is blocked anywhere inside a tag", () => {
    expect(blockedTagFor("alcoholic drink, party")).toBe("alcoholic drink");
    expect(blockedTagFor("cigarette smoke")).toBe("cigarette smoke");
    expect(blockedTagFor("hunting rifle, forest")).toBe("hunting rifle");
  });

  test("leaves the words that earn their place on a child's screen", () => {
    // Each of these was considered for the list and deliberately left off.
    for (const tags of [
      "sword, knight, castle",
      "knife, fork, spoon, cutlery",
      "birthday party, cake, candles",
      "weed, garden, dandelion",
      "needle, thread, sewing",
      "campfire, smoke, forest",
      "soldier, history, memorial",
    ]) {
      expect(blockedTagFor(tags)).toBeNull();
    }
  });

  test("a clinician's own blocked terms screen results, not just queries", () => {
    // They said they did not want to see it. A search for something else that
    // happens to return it is the same outcome for the student.
    expect(blockedTagFor("dog, puppy, pet", ["dog"])).toBe("dog");
    expect(blockedTagFor("cat, kitten", ["dog"])).toBeNull();
    // Word-boundary, same rule queries get: "dog" must not fire on "dogwood".
    expect(blockedTagFor("dogwood, tree, blossom", ["dog"])).toBeNull();
  });

  test("survives junk: empty tags, stray commas, odd spacing", () => {
    expect(blockedTagFor("")).toBeNull();
    expect(blockedTagFor(",,,")).toBeNull();
    expect(blockedTagFor("  BEER  ,  glass ")).toBe("beer");
  });

  test("is case-insensitive, because Pixabay's tags are not normalized", () => {
    expect(blockedTagFor("Cocktail, Bar")).toBe("cocktail");
  });
});

describe("hitIsUsable", () => {
  test("accepts an ordinary https photo", () => {
    expect(hitIsUsable(hit())).toBe(true);
  });

  test("rejects plaintext http — no mixed content, no plaintext leak", () => {
    expect(hitIsUsable(hit({ link: "http://example.com/g.jpg" }))).toBe(false);
    expect(hitIsUsable(hit({ link: "" }))).toBe(false);
    expect(hitIsUsable(hit({ link: "data:image/png;base64,AAAA" }))).toBe(false);
  });

  test("rejects SVG — it is a script-capable document, not a picture", () => {
    expect(hitIsUsable(hit({ mime: "image/svg+xml" }))).toBe(false);
    expect(hitIsUsable(hit({ mime: null, link: "https://example.com/a.svg" }))).toBe(false);
    expect(hitIsUsable(hit({ mime: null, link: "https://example.com/a.svgz?v=2" }))).toBe(false);
  });

  test("rejects non-image mime types outright", () => {
    expect(hitIsUsable(hit({ mime: "text/html" }))).toBe(false);
    expect(hitIsUsable(hit({ mime: "application/pdf" }))).toBe(false);
  });

  test("rejects tiles too small to look at", () => {
    expect(hitIsUsable(hit({ width: 16, height: 16 }))).toBe(false);
    expect(hitIsUsable(hit({ height: 40 }))).toBe(false);
  });

  test("accepts when the provider omitted dimensions", () => {
    // Unknown is not the same as too small — dropping these would throw away
    // usable results for a field the provider simply did not populate.
    expect(hitIsUsable(hit({ width: null, height: null }))).toBe(true);
  });
});

describe("mapPixabayHit", () => {
  const ITEM = {
    tags: "owl, bird, wildlife",
    pageURL: "https://pixabay.com/photos/owl-123/",
    previewURL: "https://cdn.pixabay.com/photo/owl_150.jpg",
    webformatURL: "https://pixabay.com/get/owl_640.jpg",
    largeImageURL: "https://pixabay.com/get/owl_1280.jpg",
    imageWidth: 4000,
    imageHeight: 3000,
  };

  test("viewer gets the 1280 rendition, the grid gets the 640", () => {
    // previewURL (150px) is deliberately unused — too small for dwell tiles.
    const hit = mapPixabayHit(ITEM);
    expect(hit.link).toBe(ITEM.largeImageURL);
    expect(hit.thumbnailLink).toBe(ITEM.webformatURL);
    expect(hit.contextLink).toBe(ITEM.pageURL);
    expect(hit.title).toBe("owl, bird, wildlife");
    expect(hit.width).toBe(4000);
    expect(hit.height).toBe(3000);
  });

  test("a mapped hit passes the usability filter", () => {
    expect(hitIsUsable(mapPixabayHit(ITEM))).toBe(true);
  });

  test("degrades to the webformat rendition when large is missing", () => {
    const hit = mapPixabayHit({ ...ITEM, largeImageURL: undefined });
    expect(hit.link).toBe(ITEM.webformatURL);
  });

  test("a junk item maps to an unusable hit rather than throwing", () => {
    const hit = mapPixabayHit({});
    expect(hit.link).toBe("");
    expect(hitIsUsable(hit)).toBe(false);
  });
});

describe("sourceDomainOf", () => {
  test("prefers the page the picture was found on, minus www.", () => {
    expect(sourceDomainOf(hit())).toBe("example.com");
  });

  test("falls back to the image host, then to empty", () => {
    expect(sourceDomainOf(hit({ contextLink: null }))).toBe("example.com");
    expect(sourceDomainOf(hit({ contextLink: "not a url", link: "also not a url" }))).toBe("");
  });
});

// ── What the assistant is told ──────────────────────────────────────────────

describe("pictureSearchFailureNote", () => {
  test("never names the blocked term back to the assistant", () => {
    // Naming it invites the model to repeat it — "I can't show you guns" — which
    // is the exact phrase a clinician blocked the word to avoid.
    const note = pictureSearchFailureNote({ kind: "blocked", term: "gun" });
    expect(note).not.toContain("gun");
    expect(note.toLowerCase()).toContain("do not explain why");
  });

  test("a fruitless search tells the model to say so, not to describe one", () => {
    const note = pictureSearchFailureNote({ kind: "no_results", query: "a giraffe" });
    expect(note).toContain("a giraffe");
    expect(note).toContain("do NOT describe one");
  });

  test("an empty query turns into a question, not a failure", () => {
    // A student tapping the tile from the Apps page lands here.
    const note = pictureSearchFailureNote({ kind: "bad_query" });
    expect(note).toContain("ask the user what they would like to see");
    expect(note).toContain(PICTURE_SEARCH_APP_ID);
  });

  test("every non-ok outcome produces a note the Speaker can act on", () => {
    const outcomes = [
      { kind: "disabled" },
      { kind: "unavailable" },
      { kind: "blocked", term: "x" },
      { kind: "bad_query" },
      { kind: "no_results", query: "q" },
    ] as const;
    for (const outcome of outcomes) {
      const note = pictureSearchFailureNote(outcome);
      expect(note.length).toBeGreaterThan(20);
      expect(note.startsWith("[")).toBe(true);
    }
  });
});

// ── Registry contract ───────────────────────────────────────────────────────

describe("picture_search registry entry", () => {
  const app = APP_REGISTRY.find((a) => a.id === PICTURE_SEARCH_APP_ID);

  test("is registered and OFF by default", () => {
    expect(app).toBeDefined();
    expect(app!.enabledByDefault).toBe(false);
  });

  test("tells the model this is the web, not the family album", () => {
    // The two apps are one word apart in a student's request and worlds apart in
    // what they contain; the description is the only thing keeping them separate.
    expect(app!.description).toContain("photos");
    expect(app!.description.toLowerCase()).toContain("web");
  });
});
