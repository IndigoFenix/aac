import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import bcrypt from "bcryptjs";
import session from "express-session";
import connectPg from "connect-pg-simple";
import type { Express, RequestHandler } from "express";
import { User as SelectUser } from "@shared/schema";
import { storage } from "./storage";
import { pool } from "./db";
import createMemoryStore from "memorystore";
import { identityProviderRepository } from "./repositories/identityProviderRepository";
import { adminUserRepository } from "./repositories/adminUserRepository";
import { identityService } from "./services/identityService";
import { adaptAdminAsUser, ensureAdminShellUser, resolveLoginIdentity, type SessionIdentity } from "./services/adminAuthService";
import { refreshAacSession, enforceClinicianIdleTimeout } from "./session-lifetime";
import { activityLogService } from "./services/activityLogService";

const MemoryStore = createMemoryStore(session);

declare global {
  namespace Express {
    interface User extends SelectUser {}
  }
}

/**
 * Whether an account is allowed to authenticate.
 *
 * ONE owner for the rule, because it has to hold at every door:
 * password login, Google-by-external-identity, Google-by-email, and session
 * deserialization. Before this existed `users.is_active` was written but never
 * read — neither passport strategy consulted it and the Google strategy
 * resolved an account by email alone, so "deactivating" a user blocked
 * nothing. See docs/AKIM_REMEDIATION_PLAN.md item 2.
 *
 * Covers `admin_users` too (migration 0170 added its `is_active` column):
 * backoffice accounts hold the widest access in the system and previously had
 * no off switch at all.
 */
export function canAuthenticate(user: { isActive?: boolean | null } | null | undefined): boolean {
  if (!user) return false;
  // Absent flag means active: the column is NOT NULL with default true, and a
  // caller passing a partial row must not be locked out by omission.
  return user.isActive !== false;
}

export function getUserSession() {
  const sessionTtl = 7 * 24 * 60 * 60 * 1000; // 1 week
  const pgStore = connectPg(session);
  const sessionStore = new pgStore({
    pool,
    createTableIfMissing: false,
    ttl: sessionTtl / 1000,   // connect-pg-simple expects seconds, see note below
    tableName: "sessions",
  });
  return session({
    secret: process.env.SESSION_SECRET || 'fallback-secret-key-for-dev',
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      // 'none' is required for cross-origin requests from Electron (app:// → https://)
      // CORS credentials policy still restricts which origins can use cookies
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: sessionTtl,
    },
  });
}

export async function setupUserAuth(app: Express) {
  app.use(getUserSession());
  app.use(passport.initialize());
  app.use(passport.session());

  // AAC devices stay signed in indefinitely: slide their cookie's expiry
  // forward (throttled to once a day). No-op for every other session.
  app.use(refreshAacSession);

  // Every OTHER session lapses after CLINICIAN_IDLE_TIMEOUT_MS of silence
  // (automatic logoff). The lapse is audited as a logout.
  app.use(
    enforceClinicianIdleTimeout((userId) => {
      if (!userId) return;
      activityLogService.log({
        userId,
        eventType: "auth_logout",
        subjectType1: "user",
        subjectId1: userId,
        details: { reason: "idle_timeout" },
      });
    }),
  );

  // Propagate customer support context via AsyncLocalStorage
  const { supportContext } = await import("./middleware/auth");
  app.use(supportContext);

  // Local Strategy for email/password login.
  // admin_users is checked first: admin auth is fully self-contained on that
  // table (password, MFA, authProvider). A matching admin short-circuits the
  // regular `users` lookup entirely — there is no `users` row to fall back on.
  passport.use(new LocalStrategy(
    {
      usernameField: 'email',
      passwordField: 'password'
    },
    async (email, password, done) => {
      try {
        const admin = await adminUserRepository.getByEmail(email);
        if (admin) {
          if (admin.authProvider === 'google') {
            return done(null, false, { message: 'Please sign in with Google for this account' });
          }
          if (!admin.password) {
            return done(null, false, { message: 'Invalid login credentials' });
          }
          const isValidAdminPassword = await bcrypt.compare(password, admin.password);
          if (!isValidAdminPassword) {
            return done(null, false, { message: 'Invalid login credentials' });
          }
          if (!canAuthenticate(admin)) {
            return done(null, false, { message: 'Invalid login credentials' });
          }
          await adminUserRepository.update(admin.id, { lastActiveAt: new Date() } as any);
          // Make sure the admin has a users shell row for FK anchors / support mode.
          await ensureAdminShellUser(admin);
          return done(null, adaptAdminAsUser(admin));
        }

        const user = await storage.getUserByEmail(email);
        if (!user) {
          return done(null, false, { message: 'No account found with this email address' });
        }

        // Deactivated accounts cannot sign in. Checked here AND in the Google
        // strategy AND in deserializeUser — the flag is only a revocation
        // control if EVERY door honours it. Deliberately reported as the
        // generic credential failure so the response does not disclose that
        // the address exists but is disabled.
        if (!canAuthenticate(user)) {
          return done(null, false, { message: 'Invalid login credentials' });
        }

        if (user.authProvider === 'google') {
          return done(null, false, { message: 'Please sign in with Google for this account' });
        }

        if (!user.password) {
          return done(null, false, { message: 'Invalid login credentials' });
        }

        const isValidPassword = await bcrypt.compare(password, user.password);
        if (!isValidPassword) {
          return done(null, false, { message: 'Invalid login credentials' });
        }

        // Update last active time
        await storage.updateUser(user.id, { lastActiveAt: new Date() });

        return done(null, user);
      } catch (error) {
        return done(error);
      }
    }
  ));

  // Google OAuth Strategy (only set up if credentials are provided)
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    const callbackURL = process.env.GOOGLE_OAUTH_CALLBACK_URL ||
                        "https://aivota.ai/auth/google/callback";
    console.log('Setting up Google OAuth strategy with callback URL:', callbackURL);
    passport.use(new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: callbackURL
      },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value;

        // Find or create the Google identity provider row
        let googleProvider = await identityProviderRepository.getByInstituteIdType("__google__");
        if (!googleProvider) {
          // Auto-create the Google provider entry (no discovery needed since we use passport-google-oauth20)
          const { encrypt } = await import("./services/encryption");
          googleProvider = await identityProviderRepository.create({
            name: "Google",
            protocol: "oauth2",
            clientId: process.env.GOOGLE_CLIENT_ID!,
            clientSecret: await encrypt(process.env.GOOGLE_CLIENT_SECRET!),
            scopes: "openid email profile",
            instituteIdType: "__google__", // sentinel value — not a real institute ID type
            isActive: true,
          });
        }

        // Check if user exists by external identity
        const existingIdentity = await identityService.findUserByExternalId(
          googleProvider.id,
          profile.id,
        );

        if (existingIdentity) {
          const user = await storage.getUser(existingIdentity.userId);
          if (user) {
            if (!canAuthenticate(user)) return done(null, false, { message: 'Account disabled' });
            await storage.updateUser(user.id, { lastActiveAt: new Date() });
            return done(null, user);
          }
        }

        // Check if user exists by email
        if (email) {
          // Admin-first: a Google-verified email matching an admin_users row
          // logs in under the admin identity. admin_users holds its own
          // authProvider/googleId/MFA state — no users-row fallback needed.
          const adminMatch = await adminUserRepository.getByEmail(email);
          if (adminMatch && !canAuthenticate(adminMatch)) {
            return done(null, false, { message: 'Account disabled' });
          }
          if (adminMatch) {
            await adminUserRepository.update(adminMatch.id, { lastActiveAt: new Date() } as any);
            await ensureAdminShellUser(adminMatch);
            return done(null, adaptAdminAsUser(adminMatch));
          }

          let user = await storage.getUserByEmail(email);

          if (user && !canAuthenticate(user)) {
            return done(null, false, { message: 'Account disabled' });
          }

          if (user) {
            // Link Google identity to existing user
            const profileImageUrl = profile.photos?.[0]?.value;
            const validImageUrl = profileImageUrl && (profileImageUrl.startsWith('http://') || profileImageUrl.startsWith('https://')) ? profileImageUrl : null;

            await storage.updateUser(user.id, {
              profileImageUrl: validImageUrl,
              lastActiveAt: new Date()
            });
            await identityService.linkIdentity(
              user.id,
              googleProvider.id,
              profile.id,
              email,
              { name: profile.displayName },
            );
            return done(null, user);
          }

          // Create new user + link identity
          const profileImageUrl = profile.photos?.[0]?.value;
          const validImageUrl = profileImageUrl && (profileImageUrl.startsWith('http://') || profileImageUrl.startsWith('https://')) ? profileImageUrl : undefined;

          user = await storage.createUser({
            email,
            firstName: profile.name?.givenName,
            lastName: profile.name?.familyName,
            profileImageUrl: validImageUrl,
            authProvider: "google",
          });
          await identityService.linkIdentity(
            user.id,
            googleProvider.id,
            profile.id,
            email,
            { name: profile.displayName },
          );
          return done(null, user);
        }

        return done(new Error('No email provided by Google'));
      } catch (error) {
        return done(error);
      }
    }
    ));
  }

  // Sessions store a tagged identity: { kind: 'admin' | 'user', id }. An
  // existing session that predates this change holds a bare user-id string —
  // we treat that as { kind: 'user', id } so logged-in users don't get kicked
  // out by the rollout.
  passport.serializeUser((user: any, done) => {
    const identity: SessionIdentity =
      user?._identityKind === "admin"
        ? { kind: "admin", id: user.id }
        : { kind: "user", id: user.id };
    done(null, identity);
  });

  passport.deserializeUser(async (raw: any, done) => {
    try {
      const identity: SessionIdentity =
        typeof raw === "string" ? { kind: "user", id: raw } : raw;

      if (identity.kind === "admin") {
        const admin = await adminUserRepository.getById(identity.id);
        if (!admin || !canAuthenticate(admin)) {
          return done(null, false);
        }
        return done(null, adaptAdminAsUser(admin));
      }

      const user = await storage.getUser(identity.id);
      // An account deactivated mid-session stops working on the next request
      // rather than at cookie expiry. This is what makes revocation
      // "immediate and effective" rather than eventual.
      if (user && !canAuthenticate(user)) {
        return done(null, false);
      }
      done(null, user);
    } catch (error) {
      done(error);
    }
  });
}

export const requireAuth: RequestHandler = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ message: "Authentication required" });
};

export const requireSLPPlan: RequestHandler = (req, res, next) => {
  if (!req.isAuthenticated() || !req.user) {
    return res.status(401).json({ 
      message: "Authentication required",
      error: "not_authenticated" 
    });
  }

  const user = req.user as any;
  
  // Check if user is admin, has SLP/Premium/Enterprise subscription, or is SLP user type
  const hasAccess = 
    user.isAdmin ||
    user.userType === 'SLP' ||
    user.userType === 'Admin' ||
    user.subscriptionType === 'premium' ||
    user.subscriptionType === 'enterprise';

  if (!hasAccess) {
    return res.status(403).json({ 
      message: "Clinical data access requires SLP or Premium subscription",
      error: "subscription_required",
      requiredPlan: "SLP/Premium/Enterprise"
    });
  }

  next();
};

export async function validateCredits(userId: string): Promise<{ hasCredits: boolean; credits: number }> {
  const user = await storage.getUser(userId);
  if (!user) {
    return { hasCredits: false, credits: 0 };
  }
  return { hasCredits: user.credits > 0, credits: user.credits };
}

export async function deductCredit(userId: string, description: string = 'Interpretation usage'): Promise<boolean> {
  try {
    const user = await storage.getUser(userId);
    if (!user || user.credits <= 0) {
      return false;
    }

    await storage.updateUserCredits(userId, -1, 'usage', description);
    return true;
  } catch (error) {
    console.error('Error deducting credit:', error);
    return false;
  }
}