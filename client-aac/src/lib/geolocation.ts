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
 * THE one place that decides whether this device may be asked where it is.
 *
 * Two independent reasons to say no, and both must live together — they were
 * previously written out at each call site, which is exactly why the venue
 * lanes never got the Capacitor guard and could hang forever:
 *
 *  - `enabled`: the student's `deviceLocationEnabled` (aac_settings). Off is
 *    the default. Off means we never call navigator.geolocation at all, so no
 *    OS permission prompt is raised in front of a child either.
 *  - `host`: the Capacitor (iPad) shell ships no location usage-description
 *    key, so a reading can never succeed there — and in that state iPadOS
 *    WKWebView invokes NEITHER callback. See docs/IPAD_BUILD.md. Drop this half
 *    only together with adding `NSLocationWhenInUseUsageDescription` in
 *    scripts/ios-configure.mjs.
 */
export function mayReadDeviceLocation(input: { enabled: boolean; host: string }): boolean {
  return input.enabled === true && input.host !== "capacitor";
}

/**
 * Get a single GPS reading. Resolves `null` (never rejects) and ALWAYS settles
 * — no geolocation support (e.g. a desktop build without GPS), denied
 * permission, or timeout.
 *
 * The `timeout` option below is honoured by the PLATFORM, which is not enough:
 * on iOS/iPadOS WKWebView, if Info.plist has no location usage-description key
 * the request never reaches the platform timer and NEITHER callback ever fires,
 * so the promise hangs forever. That stranded the whole AAC session — the
 * caller awaits this before sending `initialize`, so the socket opened and then
 * sat silent and the app stuck on "connecting". Hence our own watchdog: the
 * "always settles" contract has to be ours, not the platform's.
 */
export function getCurrentGps(timeoutMs = 8000): Promise<GpsReading | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const done = (value: GpsReading | null) => {
      if (settled) return;
      settled = true;
      if (watchdog !== undefined) clearTimeout(watchdog);
      resolve(value);
    };
    // Slack beyond the platform timeout so a working implementation still gets
    // to report its own timeout/error first; this only catches a total no-show.
    watchdog = setTimeout(() => done(null), timeoutMs + 2000);
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
