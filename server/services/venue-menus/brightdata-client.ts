// server/services/venue-menus/brightdata-client.ts
//
// The paid discovery/fetch tier (§4.1, §4.2b): Bright Data.
//
// Two products, one token:
//   - Google Maps Scraper API — richer place records than OSM, and crucially a
//     per-place `website`. That field is what makes the §3.1a binding check
//     enforceable at all; OSM can seed a nearby list but rarely binds a MENU.
//   - Web Unlocker — fetches the menu page itself.
//
// ─────────────────────────────────────────────────────────────────────────────
// UNVERIFIED AGAINST THE LIVE SERVICE
//
// No BRIGHTDATA_API_TOKEN exists in this environment yet, so the request and
// response shapes below are written from the published API and have NOT been
// exercised against the real thing. Everything shape-dependent is therefore
// isolated in small exported functions with their own tests, so when a token
// arrives the fix is a mapping change and not an archaeology exercise.
//
// Every entry point degrades to null/[] rather than throwing. A caretaker
// standing at a table gets "we could not find this restaurant's menu" and the
// camera path, which is the better path anyway.

import type { GeoPoint } from "@shared/location-matching";
import type { InsertVenue } from "@shared/schema";

const API_BASE = "https://api.brightdata.com";

/** Web Unlocker can sit behind a slow origin; a menu page is not worth more. */
const FETCH_TIMEOUT_MS = 20_000;

/** Dataset jobs are asynchronous: trigger, then poll. */
const SNAPSHOT_POLL_MS = 3_000;
const SNAPSHOT_MAX_WAITS = 10;

function token(): string | null {
  return process.env.BRIGHTDATA_API_TOKEN?.trim() || null;
}

/**
 * The Web Unlocker zone name, or null when it has not been configured.
 *
 * There is NO default. Bright Data zone names are chosen by whoever creates the
 * zone and cannot be changed afterwards, so a guessed name produces a 4xx that
 * reads exactly like an authentication failure — the most expensive kind of
 * error to debug, because it sends you looking at the token.
 */
function unlockerZone(): string | null {
  return process.env.BRIGHTDATA_UNLOCKER_ZONE?.trim() || null;
}

function mapsDatasetId(): string | null {
  return process.env.BRIGHTDATA_MAPS_DATASET_ID?.trim() || null;
}

/**
 * Is the paid tier usable? Callers check this and skip gracefully, mirroring
 * `locationService.geocodeAddress`'s free→paid→skip ladder.
 */
export function isBrightDataConfigured(): boolean {
  return !!token();
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" };
}

async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } catch (error) {
    console.warn("[brightdata] request failed:", (error as Error)?.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Web Unlocker
// ---------------------------------------------------------------------------

/**
 * Fetch a page as a browser would see it.
 *
 * The URL is ALWAYS one the binding check has already accepted — see
 * web-menu-fetcher.ts. Fetching first and checking afterwards would mean
 * spending money on pages we then refuse, and worse, would put an unbound URL
 * one code change away from a student's board.
 */
export async function fetchPageHtml(url: string): Promise<string | null> {
  if (!isBrightDataConfigured()) return null;

  const zone = unlockerZone();
  if (!zone) {
    console.warn(
      "[brightdata] BRIGHTDATA_UNLOCKER_ZONE is not set — the web menu source is unavailable. " +
        "Create a Web Unlocker zone in the control panel and set this to its exact name.",
    );
    return null;
  }

  return withTimeout(async (signal) => {
    const response = await fetch(`${API_BASE}/request`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ zone, url, format: "raw" }),
      signal,
    });

    if (!response.ok) {
      console.warn(`[brightdata] unlocker returned ${response.status} for ${url}`);
      return null;
    }
    return response.text();
  }, FETCH_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Google Maps places
// ---------------------------------------------------------------------------

/** One row as the Maps dataset returns it. Loosely typed on purpose. */
export interface BrightDataPlace {
  place_id?: string;
  name?: string;
  latitude?: number;
  longitude?: number;
  lat?: number;
  lon?: number;
  address?: string;
  full_address?: string;
  country?: string;
  country_code?: string;
  website?: string;
  category?: string;
  categories?: string[];
  [key: string]: unknown;
}

/**
 * A dataset row → a venue row, or null when it is unusable.
 *
 * Exported and tested because it is the one place a shape change hurts: a row
 * missing a name or coordinates must be dropped, not turned into a blank button
 * in a caretaker's venue picker.
 */
export function toVenue(place: BrightDataPlace): InsertVenue | null {
  const name = (place.name ?? "").trim();
  if (!name) return null;

  const latitude = typeof place.latitude === "number" ? place.latitude : place.lat;
  const longitude = typeof place.longitude === "number" ? place.longitude : place.lon;
  if (typeof latitude !== "number" || typeof longitude !== "number") return null;

  const sourceId = (place.place_id ?? "").trim();
  if (!sourceId) return null; // Without a stable id the cache cannot converge.

  const address = (place.full_address ?? place.address ?? "").trim();
  const country = (place.country_code ?? place.country ?? "").trim().toUpperCase();

  return {
    source: "brightdata",
    sourceId,
    name,
    latitude,
    longitude,
    ...(address ? { address } : {}),
    ...(place.category ? { venueType: place.category } : {}),
    ...(place.categories?.length ? { cuisine: place.categories.join(", ") } : {}),
    // The field the whole binding check rests on: this place's OWN site, not a
    // brand-name guess. A GPS-resolved Israeli Aroma points at the Israeli site.
    ...(place.website ? { websiteUri: place.website } : {}),
    // Only accept a 2-letter code. "Israel" is not a country code, and writing
    // it into the column would make the binding comparison silently never match.
    ...(country.length === 2 ? { countryCode: country } : {}),
  } as InsertVenue;
}

/** Rows out of whatever envelope the snapshot endpoint used. */
export function parseSnapshot(payload: unknown): BrightDataPlace[] {
  if (Array.isArray(payload)) return payload as BrightDataPlace[];
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["data", "results", "items"]) {
      if (Array.isArray(record[key])) return record[key] as BrightDataPlace[];
    }
  }
  return [];
}

/**
 * Nearby restaurants from the Google Maps dataset.
 *
 * Asynchronous by design on Bright Data's side: trigger a job, poll for the
 * snapshot. Bounded by SNAPSHOT_MAX_WAITS so a stuck job cannot hold a request
 * open — the caller falls back to OSM or to the camera.
 */
export async function searchNearbyPlaces(
  point: GeoPoint,
  radiusM: number,
): Promise<InsertVenue[]> {
  const dataset = mapsDatasetId();
  if (!isBrightDataConfigured() || !dataset) return [];

  const triggered = await withTimeout(async (signal) => {
    const response = await fetch(
      `${API_BASE}/datasets/v3/trigger?dataset_id=${encodeURIComponent(dataset)}&include_errors=true`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify([
          {
            lat: point.latitude,
            lon: point.longitude,
            radius: radiusM,
            keyword: "restaurant",
          },
        ]),
        signal,
      },
    );
    if (!response.ok) return null;
    return (await response.json()) as { snapshot_id?: string };
  }, FETCH_TIMEOUT_MS);

  const snapshotId = triggered?.snapshot_id;
  if (!snapshotId) return [];

  for (let attempt = 0; attempt < SNAPSHOT_MAX_WAITS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_POLL_MS));

    const snapshot = await withTimeout(async (signal) => {
      const response = await fetch(
        `${API_BASE}/datasets/v3/snapshot/${encodeURIComponent(snapshotId)}?format=json`,
        { headers: authHeaders(), signal },
      );
      // 202 = still running. Anything else non-OK is a real failure.
      if (response.status === 202) return "pending" as const;
      if (!response.ok) return null;
      return (await response.json()) as unknown;
    }, FETCH_TIMEOUT_MS);

    if (snapshot === "pending") continue;
    if (!snapshot) return [];

    return parseSnapshot(snapshot)
      .map(toVenue)
      .filter((venue): venue is InsertVenue => venue !== null);
  }

  console.warn("[brightdata] maps snapshot did not complete in time");
  return [];
}
