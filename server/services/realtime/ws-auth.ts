import type { IncomingMessage } from "http";
import type { RequestHandler } from "express";
import { getUserSession } from "../../userAuth";
import { storage } from "../../storage";
import type { User } from "@shared/schema";

// Reuse the same express-session middleware used by HTTP routes. Running it
// against the upgrade request populates `req.session`; Passport stores the
// user id under `req.session.passport.user`.
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
      const userId: string | undefined = session?.passport?.user;
      if (!userId) return resolve(null);
      try {
        const user = await storage.getUser(userId);
        resolve(user ?? null);
      } catch {
        resolve(null);
      }
    });
  });
}
