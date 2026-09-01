// Centralized security middleware: helmet headers, strict CORS, auth-route
// rate limiting, and a request logger that does NOT capture response bodies.
// All three entry points (`server/index.ts`, `server/index.prod.ts`,
// `server/app.lambda.ts`) call into here so we have one place to evolve.

import type { Express, Request, Response, NextFunction } from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

/**
 * The Electron desktop AAC client's origin. This is a fixed scheme/host that
 * only the packaged app can emit — a web page cannot forge an `app://` Origin
 * header — so it is ALWAYS safe to allow, in every environment, regardless of
 * `ALLOWED_ORIGINS`. Including it unconditionally avoids the footgun of the
 * desktop client silently failing CORS on a backend whose env wasn't configured.
 */
export const DESKTOP_APP_ORIGIN = "app://aac";

/**
 * The iPad (Capacitor) AAC client's origin. WKWebView serves the bundle under
 * the custom `capacitor://` scheme with a fixed `localhost` host — see
 * `ios.scheme` in capacitor.config.ts. Same reasoning as the desktop origin: a
 * web page cannot forge a non-http(s) scheme in an Origin header, so allowing
 * it unconditionally costs nothing and avoids the iPad client silently failing
 * CORS against a backend whose env wasn't updated.
 *
 * NOTE: this is the ORIGIN, not the bundle id — changing `ios.scheme` changes
 * this string, and the two must move together or every API call 403s.
 */
export const IPAD_APP_ORIGIN = "capacitor://localhost";

/**
 * Every packaged-native-client origin. These are always allowed; only browser
 * origins are governed by `ALLOWED_ORIGINS`.
 */
export const NATIVE_APP_ORIGINS = [DESKTOP_APP_ORIGIN, IPAD_APP_ORIGIN] as const;

/**
 * Header through which a packaged native client declares its own origin.
 *
 * A NATIVE http stack sends neither `Origin` nor `Referer`: the request is
 * issued from native code (CapacitorHttp on iPad → URLSession), not by the
 * WKWebView, so there is no browsing context to attribute it to. That makes
 * every state-changing call fail the CSRF guard with "missing Origin/Referer" —
 * exactly what broke iPad login once the API layer moved onto CapacitorHttp to
 * get around WKWebView's third-party-cookie rules (client-aac/src/lib/queryClient.ts).
 *
 * The client therefore states its origin here. It is honoured ONLY when
 * (a) no real Origin/Referer is present and (b) the value is one of the fixed
 * `NATIVE_APP_ORIGINS`. That leaves nothing for an attacker to use: those
 * origins are non-http(s) schemes no web page can occupy, and a browser cannot
 * attach a custom header to a cross-site request without a preflight that the
 * CORS policy above would have to allow first.
 */
export const NATIVE_ORIGIN_HEADER = "x-aivota-native-origin";

/**
 * Read `NATIVE_ORIGIN_HEADER` off a request, returning the declared origin only
 * if it is one of the blessed native origins, else null.
 */
export function resolveDeclaredNativeOrigin(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const raw = headers[NATIVE_ORIGIN_HEADER];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!value) return null;
  return (NATIVE_APP_ORIGINS as readonly string[]).includes(value) ? value : null;
}

/**
 * Resolve the CORS origin allowlist. Reads `ALLOWED_ORIGINS` (comma-separated)
 * if set; otherwise falls back to a development list. In production, NOT
 * setting `ALLOWED_ORIGINS` is a configuration mistake — the function still
 * works but logs a warning. The desktop app origin is always appended.
 */
export function resolveAllowedOrigins(): string[] {
  const withNative = (origins: string[]): string[] => {
    const missing = NATIVE_APP_ORIGINS.filter((o) => !origins.includes(o));
    return missing.length ? [...origins, ...missing] : origins;
  };

  const env = process.env.ALLOWED_ORIGINS;
  if (env) return withNative(env.split(",").map((s) => s.trim()).filter(Boolean));
  if (process.env.NODE_ENV === "production") {
    console.warn(
      "[security] ALLOWED_ORIGINS not set in production — falling back to APP_URL only. " +
      "Set ALLOWED_ORIGINS as a comma-separated list of allowed origins.",
    );
    // Even with nothing configured, the packaged clients' fixed origins are allowed.
    return withNative(process.env.APP_URL ? [process.env.APP_URL] : []);
  }
  // Development defaults.
  return withNative([
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5000",
  ]);
}

/**
 * Origin policy for a WebSocket UPGRADE request.
 *
 * The `'upgrade'` event bypasses Express, so `validateCSRF` never runs on a
 * handshake — and with the session cookie at `SameSite=None`, any web page a
 * clinician visits could otherwise open `wss://…/ws/live` with their cookies
 * and stream a student's session (cross-site WebSocket hijacking).
 *
 * Rule: a browser ALWAYS sends `Origin` on a WebSocket handshake, so a present
 * Origin must be on the CORS allowlist (which includes the packaged clients'
 * `app://` / `capacitor://` origins). An ABSENT Origin means a non-browser
 * client (Node, curl, tests); it cannot carry a victim's ambient cookies
 * cross-site, so it is allowed through to the cookie/ticket check.
 */
export function isAllowedUpgradeOrigin(origin: string | string[] | undefined): boolean {
  const value = (Array.isArray(origin) ? origin[0] : origin)?.trim();
  if (!value) return true;
  return resolveAllowedOrigins().includes(value);
}

/**
 * Apply security headers via helmet. CSP is disabled by default — turning
 * it on requires per-page directive tuning (Vite dev HMR, Google AI domains,
 * S3 image origins, WebSocket targets) and is tracked separately. Other
 * helmet defaults are safe to enable now.
 */
export function applySecurityHeaders(app: Express): void {
  app.use(
    helmet({
      // Disabled until we have a measured CSP. Tracked: planning-docs/moe-status.md §A.3.
      contentSecurityPolicy: false,
      // The AAC client iframes /games/* on the same origin. SAMEORIGIN allows
      // that without permitting cross-origin framing.
      frameguard: { action: "sameorigin" },
      // The browser may load images we serve from S3 — same-origin would block
      // those. Use cross-origin for resources, same-origin for everything else.
      crossOriginResourcePolicy: { policy: "cross-origin" },
      // Embedder policy is too strict for our cross-origin media; leave off.
      crossOriginEmbedderPolicy: false,
      // HSTS: instruct browsers to use HTTPS for 6 months. Only effective when
      // served over HTTPS, no-op on HTTP.
      hsts: { maxAge: 60 * 60 * 24 * 180, includeSubDomains: true, preload: false },
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    }),
  );
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const h = new URL(origin).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
  } catch {
    return false;
  }
}

/**
 * Apply a strict CORS policy. The dev environment gets localhost + Electron;
 * prod reads from `ALLOWED_ORIGINS`. Reflecting `origin: true` (any origin)
 * is no longer permitted because we use credentialed cookies.
 *
 * Same-origin requests (Origin matches the request's own host) are always
 * allowed. CORS exists to protect against cross-origin reads, so a request
 * whose origin equals its destination host is not what the allowlist is
 * gating — and forcing operators to add every deployment hostname (Render
 * preview URLs, custom domains, local dev ports) to `ALLOWED_ORIGINS` is
 * a footgun.
 */
export function applyCorsPolicy(app: Express): void {
  const allowed = resolveAllowedOrigins();

  const isDev = process.env.NODE_ENV !== "production";

  app.use(
    cors((req, cb) => {
      const r = req as { headers: Record<string, string | string[] | undefined>; socket?: { encrypted?: boolean } };
      const origin = r.headers.origin as string | undefined;
      const credentials = true;

      // No origin header (server-to-server, curl, same-origin GETs without
      // CORS preflight): allow.
      if (!origin) return cb(null, { origin: true, credentials });

      // Same-origin: Origin header matches the host this request hit.
      // `x-forwarded-proto` is honored when behind a TLS-terminating proxy
      // (Render, ALB, CloudFront).
      const host = r.headers.host as string | undefined;
      const xfProto = r.headers["x-forwarded-proto"];
      const xfp = Array.isArray(xfProto) ? xfProto[0] : xfProto;
      const proto =
        (typeof xfp === "string" ? xfp.split(",")[0].trim() : undefined) ||
        (r.socket?.encrypted ? "https" : "http");
      if (host && origin === `${proto}://${host}`) {
        return cb(null, { origin: true, credentials });
      }

      // Dev convenience: allow any loopback origin on any port. Vite binds
      // to `127.0.0.1` by default on some setups while the dev defaults list
      // `localhost`; both are loopback and equally safe to allow locally.
      if (isDev && isLoopbackOrigin(origin)) {
        return cb(null, { origin: true, credentials });
      }

      if (allowed.includes(origin)) return cb(null, { origin: true, credentials });

      // Wildcard subdomains (rare; opt-in via ALLOWED_ORIGINS entry like "https://*.example.com").
      for (const a of allowed) {
        if (a.startsWith("https://*.") && origin.startsWith("https://")) {
          const suffix = a.slice("https://*.".length);
          if (origin.endsWith("." + suffix) || origin === "https://" + suffix) {
            return cb(null, { origin: true, credentials });
          }
        }
      }

      // A disallowed origin is a CLIENT error, not a server fault. With no
      // explicit status the error handlers default to 500, so every internet
      // scanner that hits the load balancer by its raw IP (whose Origin can
      // never match the allowlist) counted toward the `aivota-prod-alb-5xx`
      // CloudWatch alarm — 4.3k scanner requests tripped it on 2026-09-01,
      // and every 5xx on the service that week was this line. 403 rejects
      // just as hard while leaving 5xx to mean "we broke".
      const err = new Error(`CORS: origin ${origin} not allowed`) as Error & { status: number };
      err.status = 403;
      cb(err);
    }),
  );
}

/**
 * Rate limiter for authentication-adjacent routes. Per-IP, fixed window.
 * Skipped under NODE_ENV=test so integration tests don't get throttled.
 */
export const authRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,             // 10 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === "test",
  message: { success: false, message: "Too many requests, please try again shortly." },
});

/**
 * Looser limiter for password-reset and OTP request flows where the legitimate
 * user often retries. Still tight enough to deter automation.
 */
export const passwordResetRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === "test",
  message: { success: false, message: "Too many reset requests, please try again later." },
});

/**
 * Caretaker-PIN verification on the AAC device. A PIN is 4–8 digits, so the
 * only thing standing between a child at the keyboard and the caretaker
 * surfaces is this limiter: 5 tries per 15 minutes per (client, student).
 */
export const caretakerPinRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === "test",
  // `ipKeyGenerator` normalises IPv6 to its /64 subnet; keying on the raw
  // `req.ip` would let an IPv6 client rotate addresses inside its own prefix
  // and get unlimited PIN attempts (express-rate-limit ERR_ERL_KEY_GEN_IPV6).
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? "")}|${req.params?.id ?? ""}`,
  message: { success: false, error: "error:PIN_LOCKED" },
});

/**
 * Apply the request logger. Logs `method path status duration` for /api/*
 * paths only. **Does not capture response bodies** — those can contain PHI
 * and would be retained for the lifetime of CloudWatch logs (planning-docs/
 * moe-status.md §A.6).
 */
export function applyRequestLogger(app: Express, source: string = "express"): void {
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith("/api")) {
      next();
      return;
    }
    const start = Date.now();
    res.on("finish", () => {
      const duration = Date.now() - start;
      const time = new Date().toLocaleTimeString("en-US", {
        hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
      });
      console.log(`${time} [${source}] ${req.method} ${req.path} ${res.statusCode} in ${duration}ms`);
    });
    next();
  });
}
