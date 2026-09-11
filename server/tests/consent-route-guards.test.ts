/**
 * Pins the MIDDLEWARE on the consent routes — which of them are public, and
 * that every public one is rate-limited.
 *
 * Why source-level, and why not a timing test:
 *   - `authRateLimiter` (server/middleware/security.ts) carries
 *     `skip: () => process.env.NODE_ENV === "test"`, so under jest it is a
 *     no-op by construction. A behavioural test would either be asserting
 *     nothing or be a fragile 11-requests-in-a-second race.
 *   - Importing `registerRoutes` to walk the express router boots a server.
 *   The repo already answers this shape of question at the source level —
 *   `maintenance-crons-wiring.test.ts` does exactly this for the cron wiring,
 *   for the same reason: the thing that broke was the WIRING, not the unit.
 *
 * What broke (2026-09-10): `/api/consent/invitations/{request-otp,verify-otp,
 * verify-id}` shipped with no limiter at all, while `redeem` and `sign` beside
 * them and all six `withdraw/*` routes had one. Nothing failed; the gap was
 * only visible by reading three adjacent lines and noticing an absence.
 *
 * DB-free on purpose: it belongs to `test:unit`, not `test:integration`.
 */

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routesSrc = readFileSync(path.join(serverDir, "routes.ts"), "utf8");

/**
 * Every `app.<verb>("<path>", ...middleware, (req, res) => …)` registration,
 * mapped to the bare identifiers sitting between the path and the handler.
 */
function middlewareFor(routePath: string, verb: string): string[] | null {
  const re = new RegExp(
    `app\\.${verb}\\(\\s*"${routePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*,\\s*((?:[A-Za-z_$][\\w$]*\\s*,\\s*)*)\\(\\s*req\\s*,\\s*res\\s*\\)`,
  );
  const m = routesSrc.match(re);
  if (!m) return null;
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * PUBLIC BY DESIGN. The magic-link guardian has no user account, so the token
 * in the POST body is the credential. Every one of them must carry the
 * limiter: they are the only unauthenticated write surface on consent, and the
 * application-level caps below them (5 OTP sends per 10 min per invitation+
 * phone, 5 wrong-code attempts, 5 wrong child-ID attempts) are all keyed to a
 * RESOLVED invitation and therefore blind to a request bearing a junk code.
 */
const PUBLIC_CONSENT_ROUTES = [
  "/api/consent/invitations/redeem",
  "/api/consent/invitations/sign",
  "/api/consent/invitations/request-otp",
  "/api/consent/invitations/verify-otp",
  "/api/consent/invitations/verify-id",
  "/api/consent/withdraw/request-link",
  "/api/consent/withdraw/context",
  "/api/consent/withdraw/request-otp",
  "/api/consent/withdraw/verify-otp",
  "/api/consent/withdraw/verify-id",
  "/api/consent/withdraw/confirm",
];

/** Session-authed consent routes. `requireAuth`, and NOT public. */
const AUTHENTICATED_CONSENT_ROUTES: Array<[string, string]> = [
  ["/api/consent/notice", "get"],
  ["/api/consent/students/:studentId/wizard-context", "get"],
  ["/api/consent/students/:studentId/active", "get"],
  ["/api/consent/students/:studentId/history", "get"],
  ["/api/consent/students/:studentId/authority", "get"],
  ["/api/consent/students/:studentId/authority", "put"],
  ["/api/consent/students/:studentId/sign", "post"],
  ["/api/consent/students/:studentId/attest-in-person", "post"],
  ["/api/consent/students/:studentId/invitations", "get"],
  ["/api/consent/invitations", "post"],
  ["/api/consent/invitations/:id/revoke", "post"],
  ["/api/consent/:consentId/revoke", "post"],
  ["/api/consent/:consentId/withdrawal-link", "post"],
];

describe("consent route guards", () => {
  it.each(PUBLIC_CONSENT_ROUTES)("POST %s is rate-limited", (route) => {
    const mw = middlewareFor(route, "post");
    expect(mw).not.toBeNull();
    expect(mw).toContain("authRateLimiter");
  });

  it.each(PUBLIC_CONSENT_ROUTES)("POST %s is deliberately public", (route) => {
    // The inverse half: if one of these ever acquires `requireAuth`, the
    // guardian with no account loses the flow entirely and the failure is a
    // silent "the link doesn't work" in production, not an error here.
    expect(middlewareFor(route, "post")).not.toContain("requireAuth");
  });

  it.each(AUTHENTICATED_CONSENT_ROUTES)(
    "%s (%s) requires a session",
    (route, verb) => {
      const mw = middlewareFor(route, verb);
      expect(mw).not.toBeNull();
      expect(mw).toContain("requireAuth");
    },
  );

  it("has no consent route that is neither authenticated nor rate-limited", () => {
    const re =
      /app\.(get|post|put|patch|delete)\(\s*"(\/api\/consent\/[^"]*)"\s*,\s*((?:[A-Za-z_$][\w$]*\s*,\s*)*)\(\s*req\s*,\s*res\s*\)/g;
    const unguarded: string[] = [];
    for (const m of routesSrc.matchAll(re)) {
      const mw = m[3].split(",").map((s) => s.trim()).filter(Boolean);
      if (!mw.includes("requireAuth") && !mw.includes("authRateLimiter")) {
        unguarded.push(`${m[1].toUpperCase()} ${m[2]}`);
      }
    }
    expect(unguarded).toEqual([]);
  });
});
