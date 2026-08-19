// server/services/picture-search/picture-search-cost.ts
//
// What one picture search actually costs us, in credits (== USD; see
// `ChargeToCredits` in chat/cost-helpers.ts, currently the identity).
//
// Picture search is the first AAC feature whose cost is NOT tokens. The
// provider call is free; what we spend is BANDWIDTH — every image the student
// sees is fetched by our server and re-served from our origin, because the
// alternative is letting a child's device talk to a third-party image host
// (see the proxy's header). That is the right call for privacy and the wrong
// one for the bill, so it has to be metered like anything else.
//
// Scale check, so nobody over-engineers this later: one app-open models out at
// roughly $0.0005 — about a twentieth of a single Speaker turn. The reason to
// meter it is not the amount, it is that the amount was previously INVISIBLE
// and unbounded: nothing in the cost reports would have shown a session that
// opened the app two hundred times. Visibility first, precision never.
//
// ⚠️ These are MODELED rates, not measured ones. They are good enough to rank
// picture search against the other lines in a cost report and to make a runaway
// obvious; they are not an invoice. If the provider ever moves off a free tier,
// `PROVIDER_USD_PER_QUERY` below is the one number to change.

/** AWS rates, il-central-1, 2026-08. Rounded UP — an over-estimate that shows
 *  a cost is safer than an under-estimate that hides one. */
const USD_PER_GB_EGRESS = 0.11;
const USD_PER_GATEWAY_REQUEST = 1.3 / 1_000_000;
const USD_PER_LAMBDA_GB_SECOND = 0.0000175;

/** `memory_size = 1024` in terraform/lambda.tf, so GB-seconds == seconds. */
const LAMBDA_GB = 1;

/** Wall-clock a proxy invocation holds the Lambda open. Almost entirely the
 *  upstream fetch — our own work is a content-type check and a copy. */
const PROXY_SECONDS_PER_IMAGE = 0.5;

const BYTES_PER_GB = 1024 ** 3;

/**
 * Pixabay's API is free (100 req/min, no per-call charge), so a search costs
 * nothing beyond the Lambda time to make it — which is already inside the
 * session's normal invocation. Kept as a named zero rather than omitted: the
 * next provider will not be free, and this is where that shows up.
 */
export const PROVIDER_USD_PER_QUERY = 0;

/** Typical Pixabay renditions. `webformatURL` is ≤640px, `largeImageURL`
 *  ≤1280px; these are the observed middles of those distributions, not caps. */
const TYPICAL_THUMBNAIL_BYTES = 90 * 1024;
const TYPICAL_FULL_BYTES = 300 * 1024;

/** How many pictures a student actually opens full-size per app-open. Two is
 *  the modeled middle: most opens are a glance at the grid, some are a browse.
 *  Wrong in both directions and cheap either way. */
const MODELED_FULL_VIEWS = 2;

/**
 * Credits for proxying ONE image of `bytes` bytes: the egress, the gateway
 * request, and the Lambda time spent waiting on the upstream host.
 *
 * Exported for the model below and for tests; the proxy route itself does NOT
 * call this. Charging per image would mean a ledger write per tile — ten DB
 * writes to record three hundredths of a cent, which costs more than it
 * measures, and the route has no session to attribute them to anyway.
 */
export function imageProxyCredits(bytes: number): number {
  if (!(bytes > 0)) return 0;
  return (
    (bytes / BYTES_PER_GB) * USD_PER_GB_EGRESS +
    USD_PER_GATEWAY_REQUEST +
    LAMBDA_GB * PROXY_SECONDS_PER_IMAGE * USD_PER_LAMBDA_GB_SECOND
  );
}

/**
 * Credits for one successful picture-search app-open: the provider query, a
 * thumbnail for every result the grid will draw, and a modeled couple of
 * full-size views.
 *
 * Charged ONCE, in the coordinator, at the moment the search returns — the one
 * place in this feature that knows the session, student and user. It is an
 * estimate made at open time rather than a tally made at fetch time, and the
 * ledger label says so.
 */
export function creditsForPictureSearchOpen(resultCount: number): number {
  const results = Math.max(0, Math.floor(resultCount));
  if (results === 0) return PROVIDER_USD_PER_QUERY;
  return (
    PROVIDER_USD_PER_QUERY +
    results * imageProxyCredits(TYPICAL_THUMBNAIL_BYTES) +
    Math.min(results, MODELED_FULL_VIEWS) * imageProxyCredits(TYPICAL_FULL_BYTES)
  );
}

/** The ledger's `category` for this spend — its own line in a session's
 *  cost_breakdown, so "pictures" can be read against "chat" and "tts". */
export const PICTURE_SEARCH_COST_CATEGORY = "pictures";
