// shared/location-matching.ts
//
// Pure, framework-agnostic geo helpers shared by the server (AAC session
// startup + monitor re-checks) and reusable by any client that needs to reason
// about "is the student near a registered location, and is something scheduled
// there right now?".
//
// The flow at AAC startup:
//   1. The AAC client captures the student's GPS (navigator.geolocation).
//   2. The server loads the active `locations` belonging to the student's
//      institutes, plus the events scheduled around now (with their linked
//      locations).
//   3. matchStudentLocation() ranks the nearby locations and flags those that
//      have an event within EVENT_WINDOW_MS of now as a strong "at event"
//      signal — fed into the initial prompt.
//
// Tolerance is intentionally generous (NEAR_RADIUS_M) to absorb GPS drift and
// the fact that a student may be in a building, parking lot, or just arriving.

/** A latitude/longitude pair (decimal degrees). */
export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/** A GPS reading reported by a client device. */
export interface GpsReading extends GeoPoint {
  /** Reported horizontal accuracy in metres, if the device provided it. */
  accuracy?: number;
}

/** "Near a location" threshold, in metres. */
export const NEAR_RADIUS_M = 150;

/**
 * A fix coarser than this cannot place a student at all, and matching on it
 * would be guessing dressed up as a signal — every candidate inside half a
 * kilometre would "match". Such a reading is discarded outright.
 */
export const MAX_USABLE_ACCURACY_M = 500;

/**
 * A fix coarser than this may still put the student NEAR a location, but cannot
 * establish they are AT it — so it never earns 'at_event', which the prompt
 * turns into "the user is very likely attending it right now".
 *
 * Why this matters in practice: a phone outdoors reports ±5–20 m, but the
 * DESKTOP (Electron) build resolves location from WiFi via the Windows platform
 * provider and measured ±85–241 m. The upper half of that range is wider than
 * NEAR_RADIUS_M itself — i.e. the reading genuinely cannot tell one registered
 * place from its neighbour, and must not be allowed to assert one.
 */
export const PRECISE_FIX_ACCURACY_M = NEAR_RADIUS_M;

/**
 * The usable horizontal accuracy of a reading, or undefined when the device did
 * not report one. Junk values (non-finite, zero, negative) are treated as
 * "not reported" rather than as a perfect fix.
 */
function reportedAccuracy(gps: GpsReading | GeoPoint): number | undefined {
  const a = (gps as GpsReading).accuracy;
  if (typeof a !== "number" || !Number.isFinite(a) || a <= 0) return undefined;
  return a;
}

/** How far around "now" an event counts as happening, in milliseconds (±2h). */
export const EVENT_WINDOW_MS = 2 * 60 * 60 * 1000;

const EARTH_RADIUS_M = 6_371_000;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Great-circle distance between two points in metres (haversine formula).
 * Accurate to well within a metre at the scales we care about here.
 */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A registered location candidate to match against. */
export interface LocationCandidate extends GeoPoint {
  id: string;
  title: string;
  address?: string | null;
}

/** An event occurrence with a concrete start/end and its linked location ids. */
export interface EventOccurrence {
  id: string;
  title: string;
  description?: string | null;
  /** Concrete occurrence start (recurrence already expanded). */
  startTime: Date;
  endTime: Date;
  /** Ids of locations this event is assigned to. */
  locationIds: string[];
}

/** An event that lines up in time with a nearby location. */
export interface NearbyEvent {
  id: string;
  title: string;
  description?: string | null;
  startTime: Date;
  endTime: Date;
}

/** A single matched location, with any events that overlap the time window. */
export interface LocationMatch {
  location: LocationCandidate;
  distanceM: number;
  nearbyEvents: NearbyEvent[];
  /**
   * 'at_event' — within radius AND a linked event is happening around now AND
   *              the fix is precise enough to say so; the strongest signal.
   * 'near'     — within radius, but either nothing is scheduled there right now
   *              or the fix is too coarse to claim attendance. Check
   *              `nearbyEvents` to tell those two apart — a 'near' match with
   *              events is NOT "nothing is scheduled here".
   */
  confidence: "at_event" | "near";
  /** Reported horizontal accuracy of the fix behind this match, if the device
   *  gave one. Undefined means the device did not report it. */
  accuracyM?: number;
  /**
   * The fix was too coarse to distinguish this place from its surroundings, so
   * the match is PLAUSIBLE rather than established. Callers that put this in a
   * prompt must hedge accordingly — an over-confident location claim sends the
   * whole session's conversation somewhere the student is not.
   */
  coarse: boolean;
}

export interface MatchInput {
  /** The device reading. `accuracy`, when present, widens the search and gates
   *  the 'at_event' claim — see matchStudentLocation. */
  gps: GpsReading;
  candidateLocations: LocationCandidate[];
  events: EventOccurrence[];
  now: Date;
  /** Override the "near" radius (metres). Defaults to NEAR_RADIUS_M. */
  radiusM?: number;
  /** Override the event window (ms). Defaults to EVENT_WINDOW_MS. */
  eventWindowMs?: number;
}

/**
 * Does the event occurrence overlap the window [now - w, now + w]? We treat the
 * event as "around now" if any part of [start, end] falls inside the window, OR
 * if the event start is within the window (covers zero-length / all-day cases).
 */
function eventOverlapsWindow(ev: EventOccurrence, now: Date, windowMs: number): boolean {
  const winStart = now.getTime() - windowMs;
  const winEnd = now.getTime() + windowMs;
  const evStart = ev.startTime.getTime();
  const evEnd = ev.endTime.getTime();
  return evStart <= winEnd && evEnd >= winStart;
}

/**
 * Rank the student's nearby registered locations and flag those with a
 * concurrent event. Returns matches sorted by confidence ('at_event' first),
 * then by ascending distance. Locations outside the radius are omitted.
 *
 * ── The reading's ACCURACY is part of the answer, not decoration ──
 *
 * A coordinate without its error bars is a claim the device never made. Three
 * things follow from the reported `accuracy`:
 *
 *   1. Too coarse to mean anything (> MAX_USABLE_ACCURACY_M) → NO matches. A
 *      half-kilometre error circle "matches" every place in a neighbourhood.
 *   2. Otherwise the search radius widens by the accuracy: a place 200 m away
 *      is genuinely reachable inside a ±100 m fix, and the old flat radius
 *      dropped it. Distances reported back stay the raw centre-to-centre value.
 *   3. A fix coarser than PRECISE_FIX_ACCURACY_M can suggest but never assert:
 *      such matches come back `coarse: true` and never 'at_event', because the
 *      prompt turns that into "very likely attending it right now".
 *
 * A reading with NO accuracy behaves exactly as before (flat radius, 'at_event'
 * available) — most callers report one, and inventing a penalty for those that
 * do not would silently disable the feature for them.
 */
export function matchStudentLocation(input: MatchInput): LocationMatch[] {
  const baseRadiusM = input.radiusM ?? NEAR_RADIUS_M;
  const windowMs = input.eventWindowMs ?? EVENT_WINDOW_MS;

  const accuracyM = reportedAccuracy(input.gps);
  // A reading this vague is not evidence of anything. Better to say nothing
  // than to place a child somewhere they are not.
  if (accuracyM !== undefined && accuracyM > MAX_USABLE_ACCURACY_M) return [];

  const coarse = accuracyM !== undefined && accuracyM > PRECISE_FIX_ACCURACY_M;
  const radiusM = baseRadiusM + (accuracyM ?? 0);

  // Pre-group the in-window events by location id so each candidate is O(1).
  const eventsByLocation = new Map<string, NearbyEvent[]>();
  for (const ev of input.events) {
    if (!eventOverlapsWindow(ev, input.now, windowMs)) continue;
    for (const locId of ev.locationIds) {
      const list = eventsByLocation.get(locId) ?? [];
      list.push({
        id: ev.id,
        title: ev.title,
        description: ev.description,
        startTime: ev.startTime,
        endTime: ev.endTime,
      });
      eventsByLocation.set(locId, list);
    }
  }

  const matches: LocationMatch[] = [];
  for (const loc of input.candidateLocations) {
    const distanceM = haversineMeters(input.gps, loc);
    if (distanceM > radiusM) continue;

    const nearbyEvents = (eventsByLocation.get(loc.id) ?? []).sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime(),
    );
    matches.push({
      location: loc,
      distanceM,
      nearbyEvents,
      // A coarse fix keeps the events (they are real and the caller should say
      // so) but loses the right to call this attendance.
      confidence: nearbyEvents.length > 0 && !coarse ? "at_event" : "near",
      accuracyM,
      coarse,
    });
  }

  return matches.sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === "at_event" ? -1 : 1;
    return a.distanceM - b.distanceM;
  });
}
