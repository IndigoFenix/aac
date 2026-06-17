// client-aac/src/lib/geolocation.ts
//
// Thin wrapper around the browser Geolocation API for AAC session context.
// The server matches the reading against registered institute locations to
// guess where the student is. Everything here degrades gracefully: if the API
// is unavailable, permission is denied, or it times out, we resolve `null` and
// the session simply runs without location context.

export interface GpsReading {
  latitude: number;
  longitude: number;
  accuracy?: number;
}

/**
 * Get a single GPS reading. Resolves `null` (never rejects) on any failure —
 * no geolocation support (e.g. a desktop build without GPS), denied
 * permission, or timeout.
 */
export function getCurrentGps(timeoutMs = 8000): Promise<GpsReading | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: GpsReading | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          done({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: typeof pos.coords.accuracy === "number" ? pos.coords.accuracy : undefined,
          }),
        () => done(null),
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
      );
    } catch {
      done(null);
    }
  });
}

/** Approximate metres between two readings (haversine). Used to throttle updates. */
export function metersBetween(a: GpsReading, b: GpsReading): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
