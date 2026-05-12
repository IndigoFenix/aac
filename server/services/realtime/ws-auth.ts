import type { IncomingMessage } from "http";
import type { RequestHandler } from "express";
import { getUserSession } from "../../userAuth";
import { storage } from "../../storage";
import { adminUserRepository } from "../../repositories/adminUserRepository";
import { adaptAdminAsUser } from "../../services/adminAuthService";
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

export async function authenticateUpgrade(req: IncomingMessage): Promise<User | null> {
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
          const sourceUser = await storage.getUser(admin.id);
          return resolve(adaptAdminAsUser(admin, sourceUser ?? undefined));
        }

        const user = await storage.getUser(identity.id);
        resolve(user ?? null);
      } catch {
        resolve(null);
      }
    });
  });
}
