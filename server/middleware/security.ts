// Centralized security middleware: helmet headers, strict CORS, auth-route
// rate limiting, and a request logger that does NOT capture response bodies.
// All three entry points (`server/index.ts`, `server/index.prod.ts`,
// `server/app.lambda.ts`) call into here so we have one place to evolve.

import type { Express, Request, Response, NextFunction } from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";

/**
 * Resolve the CORS origin allowlist. Reads `ALLOWED_ORIGINS` (comma-separated)
 * if set; otherwise falls back to a development list. In production, NOT
 * setting `ALLOWED_ORIGINS` is a configuration mistake — the function still
 * works but logs a warning.
 */
export function resolveAllowedOrigins(): string[] {
  const env = process.env.ALLOWED_ORIGINS;
  if (env) return env.split(",").map((s) => s.trim()).filter(Boolean);
  if (process.env.NODE_ENV === "production") {
    console.warn(
      "[security] ALLOWED_ORIGINS not set in production — falling back to APP_URL only. " +
      "Set ALLOWED_ORIGINS as a comma-separated list of allowed origins.",
    );
    if (process.env.APP_URL) return [process.env.APP_URL];
    // Last-resort: deny all credentialed cross-origin in prod when nothing is configured.
    return [];
  }
  // Development defaults. Electron AAC client uses `app://aac` origin.
  return [
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5000",
    "app://aac",
  ];
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

      cb(new Error(`CORS: origin ${origin} not allowed`));
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
