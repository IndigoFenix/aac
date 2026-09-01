// server/scripts/probe-web-menu.ts
//
// LIVE end-to-end probe of the web-menu pipeline for one named venue:
//
//   discovery (search) -> binding check -> Unlocker fetch -> LLM extraction
//
// Usage:  npx tsx server/scripts/probe-web-menu.ts "<venue name>" "<locality>" [countryCode]
// e.g.:   npx tsx server/scripts/probe-web-menu.ts "טריולה" "רמת גן"
//
// This SPENDS MONEY deliberately: one search fetch (possibly through the paid
// Unlocker), up to a handful of Unlocker page fetches, and LLM extraction
// calls — the exact spend one student ask costs in production. Run it when the
// pipeline "should work and doesn't": it prints which rung stopped everything
// (no candidates / binding refused / nothing extracted), which the app-side
// flow log only summarizes. No DB, no student, no PHI — the venue is a row
// built from the arguments.
//
// Kept (like test-live-toolcall-blocking.ts) rather than deleted: the Bright
// Data client was written from published docs long before a token existed, and
// this is the tool that proves the live shapes still match.

import "dotenv/config";
import { discoverMenuUrls, discoveryQuery } from "../services/venue-menus/website-discovery.js";
import { fetchWebMenu } from "../services/venue-menus/web-menu-fetcher.js";
import type { Venue } from "@shared/schema";

const [name, locality, countryCode = "IL"] = process.argv.slice(2);
if (!name) {
  console.error('usage: npx tsx server/scripts/probe-web-menu.ts "<venue name>" "<locality>" [countryCode]');
  process.exit(1);
}

const venue = {
  id: "probe",
  name,
  address: locality ?? null,
  countryCode,
  websiteUri: null,
  latitude: 0,
  longitude: 0,
} as unknown as Venue;

console.log(`query: ${discoveryQuery(venue)}`);
const urls = await discoverMenuUrls(venue);
console.log(`discovered ${urls.length} candidate(s):`);
for (const url of urls) console.log(`  - ${url}`);

// ── Per-candidate trace: which rung stops each URL ──
const { checkMenuBinding } = await import("@shared/venue-binding");
const { fetchPageHtml } = await import("../services/venue-menus/brightdata-client.js");
const { htmlToText } = await import("../services/venue-menus/web-menu-fetcher.js");
for (const sourceUrl of urls) {
  const binding = checkMenuBinding(
    { name: venue.name, countryCode: venue.countryCode, websiteUri: venue.websiteUri, address: venue.address },
    { sourceUrl },
  );
  if (!binding.ok) {
    console.log(`  ✗ ${sourceUrl} — binding refused: ${binding.detail}`);
    continue;
  }
  const html = await fetchPageHtml(sourceUrl);
  if (!html) {
    console.log(`  ✗ ${sourceUrl} — fetch returned nothing`);
    continue;
  }
  const text = htmlToText(html);
  console.log(`  · ${sourceUrl} — html=${html.length}b text=${text.length}ch first120="${text.slice(0, 120).replace(/\n/g, " ")}"`);
}

const result = await fetchWebMenu(venue, { expectedLanguage: countryCode === "IL" ? "he" : "en" });
if (!result.ok) {
  console.log(`FAILED: ${result.reason}${result.detail ? ` — ${result.detail}` : ""}`);
  process.exit(0);
}
console.log(`OK: ${result.items.length} item(s) from ${result.sourceUrl}`);
console.log(`binding: basis=${result.binding.bindingBasis} branch=${result.binding.bindingBranchMatch}`);
console.log(`requiresReview(extraction): ${result.requiresReview}`);
// Item NAMES only, first ten — enough to eyeball that these are real dishes.
for (const item of result.items.slice(0, 10)) console.log(`  · ${item.name}`);
