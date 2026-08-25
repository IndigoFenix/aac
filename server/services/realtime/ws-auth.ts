import type { IncomingMessage } from "http";
import type { RequestHandler } from "express";
import { getUserSession } from "../../userAuth";
import { storage } from "../../storage";
import { adminUserRepository } from "../../repositories/adminUserRepository";
import { adaptAdminAsUser } from "../../services/adminAuthService";
import { redeemWsTicket } from "./ws-ticket";
import { isAllowedUpgradeOrigin } from "../../middleware/security";
import type { User } from "@shared/schema";

// Reuse the same express-session middleware used by HTTP routes. Running it
// against the upgrade request populates `req.session`. Passport stores the
// serialized identity under `req.session.passport.user` — either the new
// tagged `{ kind, id }` object or, for sessions that predate the tagged-
// identity rollout, a bare user-id string.
let sessionMiddleware: RequestHandler | null = null;

function getMiddleware(): RequestHandler {
  if (!sessionMiddleware) sessionMiddleware = getUserSession();
  return sessionMiddleware;
}

/**
 * Resolve a user from a `?ticket=` query param, if one is present.
 *
 * This is the iPad path: on Capacitor the session cookie lives in the native
 * (CapacitorHttp/URLSession) cookie store, which the WKWebView-issued upgrade
 * request cannot reach, so the handshake carries no cookie at all. The client
 * mints a ticket over authenticated HTTP first and presents it here. See
 * ws-ticket.ts for why this is safe to carry in a URL.
 *
 * Returns null when there is no ticket, so the caller falls through to the
 * normal cookie path — every other host is unaffected.
 */
async function authenticateTicket(req: IncomingMessage): Promise<User | null> {
  let ticket: string | null = null;
  try {
    ticket = new URL(req.url || "", `http://${req.headers.host}`).searchParams.get("ticket");
  } catch {
    return null;
  }
  if (!ticket) return null;

  // The replay set is shared across ECS tasks (Postgres) in production; the
  // in-process default is for tests and single-task dev. Without the shared
  // store, "single use" only held per task — a leaked ticket could be
  // redeemed once on every task behind the ALB.
  const userId = await redeemWsTicket(ticket, Date.now(), ticketNonceStore());
  if (!userId) return null;

  try {
    // Mirror the cookie path: a ticket names an identity, it does not bypass
    // the lookup, so a deleted/disabled account still fails to connect.
    const admin = await adminUserRepository.getById(userId);
    if (admin) return adaptAdminAsUser(admin);
    return (await storage.getUser(userId)) ?? null;
  } catch {
    return null;
  }
}

function ticketNonceStore() {
  return process.env.NODE_ENV === "test" ? memoryNonceStore : pgNonceStore;
}

export async function authenticateUpgrade(req: IncomingMessage): Promise<User | null> {
  // Origin first, before any credential is even looked at. The upgrade event
  // bypasses Express, so this is the ONLY place the CSRF-equivalent check for
  // WebSockets can live. A browser page from a foreign origin carrying a
  // clinician's SameSite=None cookie is refused here, whatever it presents.
  if (!isAllowedUpgradeOrigin(req.headers.origin)) {
    console.warn(`[ws-auth] upgrade refused: origin not allowed (${String(req.headers.origin).slice(0, 120)})`);
    return null;
  }

  const viaTicket = await authenticateTicket(req);
  if (viaTicket) return viaTicket;

  return new Promise((resolve) => {
    const middleware = getMiddleware();
    // express-session expects (req, res, next); we pass a stub res.
    const res: any = { getHeader: () => undefined, setHeader: () => undefined, end: () => undefined };
    middleware(req as any, res, async () => {
      const session = (req as any).session;
      const raw = session?.passport?.user;
      if (!raw) return resolve(null);
      try {
        const identity =
          typeof raw === "string" ? { kind: "user" as const, id: raw } : raw;

        if (identity?.kind === "admin") {
          const admin = await adminUserRepository.getById(identity.id);
          if (!admin) return resolve(null);
          return resolve(adaptAdminAsUser(admin));
        }

        const user = await storage.getUser(identity.id);
        resolve(user ?? null);
      } catch {
        resolve(null);
      }
    });
  });
}
