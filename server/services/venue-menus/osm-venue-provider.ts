// server/services/venue-menus/osm-venue-provider.ts
//
// The free venue-discovery tier (§4.1): Overpass/OSM.
//
// Cheapest first, mirroring `locationService.geocodeAddress` — try free, fall
// back to paid (Bright Data, step 7), skip gracefully when unconfigured.
//
// What OSM is good for: seeding the nearby LIST. It knows a restaurant is here
// and often what it is called. What it is NOT reliably good for is the
// `website` field, which is what a MENU actually needs to bind (§3.1a) — so a
// venue discovered here will usually bind via the camera or via a caretaker
// confirmation rather than via a URL.
//
// ─────────────────────────────────────────────────────────────────────────────
// PRIVACY (§5)
//
// This is the only outbound request in the feature that carries the student's
// position, and it carries NOTHING ELSE — no student id, no session id, no
// name, no header that identifies anyone. The privacy property is that the
// request is unattributable, not that the coordinates are fuzzy; `coarse` mode
// blurs the point as well, but blurring is not what makes this safe.

import type { GeoPoint } from "@shared/location-matching";
import type { InsertVenue } from "@shared/schema";

const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";

/** OSM usage policy requires an identifying User-Agent. */
const USER_AGENT = "Aivota-CliniAACian/1.0 (venue discovery)";

/** Overpass is a shared free service; a slow answer must not hang a request. */
const TIMEOUT_MS = 8000;

/** Amenities that serve food to a seated or walk-up customer. */
const AMENITIES = ["restaurant", "cafe", "fast_food"] as const;

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/**
 * Restaurants, cafés, and fast food within `radiusM` of a point.
 *
 * Returns rows shaped for `venues`, ready to upsert. Returns [] on any failure
 * — a discovery outage degrades to "no venues found", which the caller already
 * handles by falling through to the camera. It must never throw a caretaker
 * standing at a table into an error screen.
 */
export async function searchNearbyVenues(
  point: GeoPoint,
  radiusM: number,
): Promise<InsertVenue[]> {
  const clauses = AMENITIES.map(
    (amenity) =>
      `node["amenity"="${amenity}"](around:${radiusM},${point.latitude},${point.longitude});` +
      `way["amenity"="${amenity}"](around:${radiusM},${point.latitude},${point.longitude});`,
  ).join("");

  const query = `[out:json][timeout:8];(${clauses});out center tags;`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(OVERPASS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`[osm-venue-provider] Overpass returned ${response.status}`);
      return [];
    }

    const payload = (await response.json()) as { elements?: OverpassElement[] };
    return (payload.elements ?? []).map(toVenue).filter((v): v is InsertVenue => v !== null);
  } catch (error) {
    console.warn("[osm-venue-provider] search failed:", (error as Error)?.message);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One Overpass element → a venue row, or null when it is unusable.
 *
 * Exported for tests: this parses third-party data whose shape we do not
 * control, and a nameless or coordinate-less element must be dropped rather
 * than becoming a blank button in a caretaker's venue picker.
 */
export function toVenue(element: OverpassElement): InsertVenue | null {
  const tags = element.tags ?? {};
  const name = (tags.name ?? "").trim();
  if (!name) return null;

  const latitude = element.lat ?? element.center?.lat;
  const longitude = element.lon ?? element.center?.lon;
  if (typeof latitude !== "number" || typeof longitude !== "number") return null;

  // OSM address tags are per-part; assemble only what is present.
  const address = [tags["addr:street"], tags["addr:housenumber"], tags["addr:city"]]
    .filter(Boolean)
    .join(" ")
    .trim();

  return {
    source: "osm",
    // Type prefix matters: a node and a way can share an id number.
    sourceId: `${element.type}/${element.id}`,
    name,
    latitude,
    longitude,
    ...(address ? { address } : {}),
    ...(tags.amenity ? { venueType: tags.amenity } : {}),
    ...(tags.cuisine ? { cuisine: tags.cuisine } : {}),
    ...(tags.website || tags["contact:website"]
      ? { websiteUri: tags.website ?? tags["contact:website"] }
      : {}),
    // `brand:wikidata` is a stable chain identity where OSM has it — far better
    // than matching brand names as strings, which is how a Canadian franchise
    // won an Israeli search in the first place.
    ...(tags["brand:wikidata"] || tags.brand
      ? { brandKey: tags["brand:wikidata"] ?? tags.brand }
      : {}),
    ...(tags["addr:country"] ? { countryCode: tags["addr:country"] } : {}),
  } as InsertVenue;
}
