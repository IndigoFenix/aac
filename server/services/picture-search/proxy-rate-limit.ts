// server/services/picture-search/proxy-rate-limit.ts
//
// The bound on the image proxy. Its cost model (picture-search-cost.ts) prices
// a NORMAL open at fractions of a cent; this is what keeps an abnormal one from
// being the exception. The proxy is deliberately unauthenticated (the AAC is a
// kiosk that does not reliably carry a session — see proxyImage's auth note),
// so a signed token is the only thing standing between a caller and our egress
// bill, and a token is good for an hour and is NOT single-use.
//
// What that adds up to: anyone holding one minted URL can replay it as fast as
// they can loop, and every replay is a fresh upstream fetch plus fresh egress.
// Nothing else in the feature notices, because the per-open ledger charge is
// written at SEARCH time and a replay does not search.
//
// So: a sliding window per caller. Same shape as `allowAppAiSelect` — an
// in-memory window is per-Lambda-instance and therefore leaky under scale-out,
// which is fine. This is a ceiling on absurdity, not a quota.

/** One app-open fetches a thumbnail per result (≤18) plus the full-size views
 *  the student opens, and a student may open the app several times a minute.
 *  120/min leaves that comfortable and still bounds a loop to a rounding error.
 */
const MAX_PER_WINDOW = 120;
const WINDOW_MS = 60_000;

/** Stop the map itself from becoming the leak on a long-lived instance. */
const MAX_TRACKED_KEYS = 5_000;

const hits = new Map<string, number[]>();

/**
 * Whether `key` (the caller's IP — `trust proxy` is set, so `req.ip` is the
 * real client) may fetch another image right now. Records the hit when it may.
 */
export function allowImageProxyFetch(key: string, now: number = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);

  // Evict wholesale rather than tracking LRU: the map holds a minute of
  // history, so dropping everything stale is both correct and O(n) once in a
  // long while. Callers mid-window get a fresh allowance, which is the
  // forgiving direction to be wrong in.
  if (hits.size > MAX_TRACKED_KEYS) {
    for (const [k, times] of hits) {
      if (!times.some((t) => now - t < WINDOW_MS)) hits.delete(k);
    }
  }
  return true;
}

/** Test seam — drops all recorded history. */
export function resetImageProxyRateLimit(): void {
  hits.clear();
}
