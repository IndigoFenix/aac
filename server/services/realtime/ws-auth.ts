import type { IncomingMessage } from "http";
import type { RequestHandler } from "express";
import { getUserSession } from "../../userAuth";
import { storage } from "../../storage";
import { adminUserRepository } from "../../repositories/adminUserRepository";
import { adaptAdminAsUser } from "../../services/adminAuthService";
import { redeemWsTicket } from "./ws-ticket";
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

  const userId = redeemWsTicket(ticket);
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

export async function authenticateUpgrade(req: IncomingMessage): Promise<User | null> {
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
