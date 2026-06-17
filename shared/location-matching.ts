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
   * 'at_event' — within radius AND a linked event is happening around now;
   *              the strongest signal the student is at that event.
   * 'near'     — within radius, but nothing scheduled there right now.
   */
  confidence: "at_event" | "near";
}

export interface MatchInput {
  gps: GeoPoint;
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
 */
export function matchStudentLocation(input: MatchInput): LocationMatch[] {
  const radiusM = input.radiusM ?? NEAR_RADIUS_M;
  const windowMs = input.eventWindowMs ?? EVENT_WINDOW_MS;

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
      confidence: nearbyEvents.length > 0 ? "at_event" : "near",
    });
  }

  return matches.sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === "at_event" ? -1 : 1;
    return a.distanceM - b.distanceM;
  });
}
