// server/services/areaLookupService.ts
//
// "Where in the world is this device?" — coordinates → city / region / country.
//
// The registered-location matcher (@shared/location-matching) answers a much
// narrower question: is the student within ~150 m of a place a clinician
// entered? When the answer is no — a holiday, a hospital in another city, a
// grandparent's house — it returns [] and the session prompt says NOTHING about
// location at all. An empty match list means "not at a registered place", never
// "nowhere". This service supplies the coarse answer that still exists in that
// case, so the AI can tell "the usual Tuesday" from "somewhere new".
//
// ─────────────────────────────────────────────────────────────────────────────
// PRIVACY
//
// Same property as osm-venue-provider.ts: the outbound request carries a
// coordinate and NOTHING ELSE — no student id, no session id, no name, no
// identifying header. What makes it safe is that the request is unattributable,
// not that the point is blurred. The point IS blurred anyway (AREA_GRID_M),
// because a city name needs kilometres of precision, not metres, so sending the
// sharper fix would buy nothing.
//
// It only ever runs when the student's `deviceLocationEnabled` is on — that is
// the gate that produces a GPS reading in the first place. `AREA_LOOKUP=off`
// kills the outbound call entirely without touching the rest of the pipeline.

import type { GeoPoint } from "@shared/location-matching";
import { coarsenPoint } from "@shared/venue-matching";

/** A named area, as fine as a city and as coarse as a country. */
export interface AreaFix {
  /** City / town / village / municipality, when the provider names one. */
  city?: string;
  /** State / province / district — the level above `city`. */
  region?: string;
  country?: string;
  /** ISO 3166-1 alpha-2, lowercase, when reported. */
  countryCode?: string;
  provider: "nominatim" | "google";
}

/**
 * Grid the point is snapped to before it leaves the process, and the cache key.
 * 2 km: far finer than a city, far coarser than a street — moving around town
 * re-uses one cached answer instead of re-asking OSM on every `gps_update`.
 */
export const AREA_GRID_M = 2000;

/** A named area does not change. Hold it for a day and re-ask lazily. */
const HIT_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * A failure is not an answer (an outage would otherwise pin "unknown area" onto
 * a cell for a whole day), so it expires fast — but not instantly, or every
 * `gps_update` during an outage re-queues a doomed request.
 */
const MISS_TTL_MS = 10 * 60 * 1000;

/** Nominatim's usage policy is one request per second, absolute. */
const NOMINATIM_MIN_INTERVAL_MS = 1100;

/**
 * How long a lookup may sit in that one-per-second queue before it gives up on
 * Nominatim. Session startup awaits this, so an unbounded queue would turn a
 * burst of sessions in different cities into a growing startup delay — the
 * tenth child to open the app should not wait eleven seconds for a city name.
 * Giving up falls through to the Google fallback (or to "we do not know"), and
 * is deliberately NOT cached: the answer was never asked for, let alone missing.
 */
const MAX_QUEUE_WAIT_MS = 3000;

/** A lookup that never actually ran. Distinct from a lookup that found nothing. */
const UNAVAILABLE = Symbol("area-lookup-unavailable");

/** A slow lookup must never hold up session startup. */
const TIMEOUT_MS = 4000;

const USER_AGENT = "Aivota-CliniAACian/1.0 (area lookup)";

interface CacheEntry {
  value: AreaFix | null;
  expiresAt: number;
}

function cellKey(point: GeoPoint): string {
  const c = coarsenPoint(point, AREA_GRID_M);
  return `${c.latitude.toFixed(4)},${c.longitude.toFixed(4)}`;
}

/** "Eilat, Israel" / "Israel" / "" — whatever the provider actually gave us. */
export function formatArea(area: AreaFix | null | undefined): string {
  if (!area) return "";
  const parts = [area.city, area.region, area.country]
    .map((p) => p?.trim())
    .filter((p): p is string => !!p);
  // Drop a level that just repeats another (city-states, single-city districts).
  const deduped = parts.filter(
    (p, i) => parts.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i,
  );
  // Two levels read as a place; three read as a postal address.
  return (deduped.length > 2 ? [deduped[0], deduped[deduped.length - 1]] : deduped).join(", ");
}

class AreaLookupService {
  private cache = new Map<string, CacheEntry>();
  /** In-flight lookups, so N concurrent sessions in one cell make ONE request. */
  private inFlight = new Map<string, Promise<AreaFix | null>>();
  /** Epoch ms at which the next Nominatim request may be sent. */
  private nextNominatimSlotAt = 0;

  private enabled(): boolean {
    return (process.env.AREA_LOOKUP ?? "on").toLowerCase() !== "off";
  }

  /**
   * The named area containing `point`, or null when nothing can be resolved
   * (lookup off, provider down, mid-ocean, unparseable answer). Null means "we
   * do not know" — callers must then say nothing rather than guess.
   */
  async lookup(point: GeoPoint | null | undefined): Promise<AreaFix | null> {
    if (!point || !this.enabled()) return null;
    if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) return null;

    const key = cellKey(point);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const run = this.resolve(point)
      .then((outcome) => {
        if (outcome === UNAVAILABLE) return null;
        this.cache.set(key, {
          value: outcome,
          expiresAt: Date.now() + (outcome ? HIT_TTL_MS : MISS_TTL_MS),
        });
        return outcome;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, run);
    return run;
  }

  /** Testing seam: drop everything remembered so far. */
  clearCache(): void {
    this.cache.clear();
    this.inFlight.clear();
  }

  private async resolve(point: GeoPoint): Promise<AreaFix | null | typeof UNAVAILABLE> {
    const coarse = coarsenPoint(point, AREA_GRID_M);
    let skipped = false;
    try {
      const viaNominatim = await this.reverseNominatim(coarse);
      if (viaNominatim === UNAVAILABLE) skipped = true;
      else if (viaNominatim) return viaNominatim;
    } catch (err) {
      console.warn("[areaLookup] Nominatim reverse geocode failed, trying Google fallback:", err);
    }

    try {
      const viaGoogle = await this.reverseGoogle(coarse);
      if (viaGoogle) return viaGoogle;
    } catch (err) {
      console.warn("[areaLookup] Google reverse geocode failed:", err);
    }

    // A provider that ANSWERED "no idea" (or failed outright) is a miss, and
    // caching it briefly is the point of MISS_TTL_MS. A request we never sent
    // because the queue was long is not a miss — remember nothing, so the next
    // gps_update in this cell asks properly instead of inheriting a silence.
    return skipped ? UNAVAILABLE : null;
  }

  /**
   * Claim the next free slot on the shared 1-req/s Nominatim queue. Resolves
   * true once the slot is ours, or false immediately when the queue is already
   * longer than a caller should be made to wait for.
   */
  private async waitForNominatimSlot(): Promise<boolean> {
    const now = Date.now();
    const slotAt = Math.max(now, this.nextNominatimSlotAt);
    if (slotAt - now > MAX_QUEUE_WAIT_MS) return false;

    this.nextNominatimSlotAt = slotAt + NOMINATIM_MIN_INTERVAL_MS;
    const delay = slotAt - now;
    if (delay > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        // A pending rate-limit timer must not keep a worker process alive.
        (timer as unknown as { unref?: () => void }).unref?.();
      });
    }
    return true;
  }

  private async reverseNominatim(point: GeoPoint): Promise<AreaFix | null | typeof UNAVAILABLE> {
    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("lat", point.latitude.toFixed(4));
    url.searchParams.set("lon", point.longitude.toFixed(4));
    url.searchParams.set("format", "jsonv2");
    // zoom 10 is "city" — asking for more detail would return a street we
    // neither need nor want to hold.
    url.searchParams.set("zoom", "10");
    url.searchParams.set("addressdetails", "1");

    if (!(await this.waitForNominatimSlot())) return UNAVAILABLE;

    const res = await fetch(url, {
      headers: {
        // OSM usage policy requires an identifying User-Agent.
        "User-Agent": USER_AGENT,
        "Accept-Language": "en",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Nominatim reverse returned ${res.status}`);

    const data = (await res.json()) as {
      address?: Record<string, string>;
      error?: string;
    };
    if (!data || data.error || !data.address) return null;
    const a = data.address;

    const city = a.city ?? a.town ?? a.village ?? a.municipality ?? a.suburb ?? a.county;
    const region = a.state ?? a.region ?? a.state_district;
    const fix: AreaFix = {
      city: city || undefined,
      region: region || undefined,
      country: a.country || undefined,
      countryCode: a.country_code?.toLowerCase() || undefined,
      provider: "nominatim",
    };
    // A fix that names nothing is not a fix.
    return fix.city || fix.region || fix.country ? fix : null;
  }

  private async reverseGoogle(point: GeoPoint): Promise<AreaFix | null> {
    const key = process.env.GOOGLE_GEOCODING_API_KEY;
    if (!key) return null; // gracefully skip the fallback when unconfigured

    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("latlng", `${point.latitude.toFixed(4)},${point.longitude.toFixed(4)}`);
    url.searchParams.set("result_type", "locality|administrative_area_level_1|country");
    url.searchParams.set("language", "en");
    url.searchParams.set("key", key);

    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Google reverse geocode returned ${res.status}`);

    const data = (await res.json()) as {
      status: string;
      results?: Array<{
        address_components?: Array<{ long_name: string; short_name: string; types: string[] }>;
      }>;
    };
    if (data.status !== "OK" || !data.results?.length) return null;

    const components = data.results.flatMap((r) => r.address_components ?? []);
    const pick = (type: string) => components.find((c) => c.types.includes(type));
    const country = pick("country");
    const fix: AreaFix = {
      city: (pick("locality") ?? pick("postal_town") ?? pick("administrative_area_level_2"))?.long_name,
      region: pick("administrative_area_level_1")?.long_name,
      country: country?.long_name,
      countryCode: country?.short_name?.toLowerCase(),
      provider: "google",
    };
    return fix.city || fix.region || fix.country ? fix : null;
  }
}

export const areaLookupService = new AreaLookupService();
