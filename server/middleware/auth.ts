import type { Request, Response, NextFunction, RequestHandler } from "express";
import { userRepository, studentRepository, instituteRepository } from "../repositories";
import type { LicensePermissions } from "@shared/license-permissions";
import { runWithSupportContext } from "../services/customerSupportService";
import { activityLogService } from "../services/activityLogService";
import { resolveAllowedOrigins, resolveDeclaredNativeOrigin } from "./security";
import { hasAdminSection, type AdminSection } from "@shared/admin-sections";
import { isAdminIdentity } from "../services/adminAuthService";

/**
 * Middleware that requires user to be authenticated
 */
export const requireAuth: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (!req.isAuthenticated() || !req.user) {
    res.status(401).json({
      success: false,
      message: "Authentication required",
    });
    return;
  }
  next();
};

/**
 * Middleware that propagates customer support context via AsyncLocalStorage.
 * If the user has an active support session, all downstream calls (including
 * repository methods) can check getActiveSupportInstituteId() without needing req.
 * Must be applied AFTER requireAuth.
 */
export const supportContext: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const support = (req.session as any)?.support as { instituteId?: string; startedAt?: string } | undefined;
  const supportInstituteId = support?.instituteId;
  if (!supportInstituteId) {
    next();
    return;
  }

  // A support session is break-glass access into an institute's PHI. It
  // used to live as long as the admin's cookie (up to 30 days); now it lapses
  // on its own, and the lapse is an audit event like the entry and the exit.
  const startedAt = Date.parse(support?.startedAt ?? "");
  if (!Number.isFinite(startedAt) || Date.now() - startedAt > SUPPORT_SESSION_MAX_MS) {
    delete (req.session as any).support;
    activityLogService.log({
      userId: (req.user as any)?.id ?? null,
      instituteId: supportInstituteId,
      eventType: "support_session_ended",
      subjectType1: "institute",
      subjectId1: supportInstituteId,
      details: { reason: "expired", durationMs: Number.isFinite(startedAt) ? Date.now() - startedAt : null },
    });
    next();
    return;
  }

  runWithSupportContext(supportInstituteId, () => next());
};

/** How long a customer-support (impersonation) session may last before it lapses. */
export const SUPPORT_SESSION_MAX_MS = 60 * 60 * 1000;

// `optionalAuth` was removed 2026-08-25. It was a pure pass-through, and every
// handler behind it gated on `if (currentUser?.id) { verifyStudentAccess }` —
// so a request with NO session was trusted more than one with the wrong
// session, and a bare studentId unlocked face embeddings, family photos and
// session transcripts. Routes are either `requireAuth` or, when genuinely
// public (`/auth/user`, the consent magic-link endpoints), carry no auth
// middleware at all and say so at the route.

// `requireAdmin` was REMOVED on 2026-09-10 (authorization structural pass,
// phase 0a). It gated 20 route registrations over `/api/admin/users`,
// `/prompt`, `/settings/:key`, `/subscription-plans`, `/interpretations`,
// `/api-providers` and `/credit-packages` — none of which had a client call
// site, because the backoffice (`client/src/components/admin/`) drives the
// `requireAdminSection` routes exclusively and has no "users" section at all.
//
// It was also the blast radius of audit finding C1: until 2026-09-10 the gate
// admitted `userType === "admin"`, a value `registerSchema` accepted from the
// unauthenticated `POST /auth/register` body, so anyone on the internet could
// self-issue every route behind it — including `GET /api/admin/users`, which
// answered with every account's bcrypt hash and encrypted TOTP seed. That
// clause was removed when C1 was fixed; deleting the tier removes what it
// reached. Production was verified unexploited.
//
// The three account/billing writes that had to survive (the access-review off
// switch, MFA enforcement, credit-package authoring) moved onto
// `requireAdminSection` — see the notes at their registrations in routes.ts.
// Anything new under `/api/admin/*` names a section; there is no general
// "is an admin" door any more. See docs/SECURITY_ARCHITECTURE.md §5.8.

/**
 * Middleware that requires system admin privileges.
 *
 * Tests `users.is_system_admin` only. It never trusted `userType`, so it did
 * NOT share the C1 weakness — a self-registered account has
 * `is_system_admin = false` (the column defaults false and no request body can
 * set it) and is refused. Its own separate weakness is unrelated and still
 * open: `adminAuthService.adaptAdminAsUser` stamps `isSystemAdmin: true` on
 * EVERY `admin_users` row regardless of that row's `permissions`, so a
 * section-scoped backoffice admin passes this gate (audit finding F1, its own
 * round).
 */
export const requireSystemAdmin: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (!req.isAuthenticated() || !req.user) {
    res.status(401).json({
      success: false,
      message: "Authentication required",
    });
    return;
  }

  const user = req.user as any;
  if (!user.isSystemAdmin) {
    res.status(403).json({
      success: false,
      message: "System admin privileges required",
    });
    return;
  }

  next();
};

/**
 * Middleware factory that requires the current admin to have access to a
 * specific admin section. Used on routes belonging to a single section
 * (e.g. the Admins-management endpoints below). Sessions that aren't an
 * admin identity at all (regular users) are rejected as 403, since these
 * routes live under `/api/admin/*` and are not for regular users.
 *
 * NOTE: existing admin routes still use `requireSystemAdmin`. Migrating
 * each section to its own `requireAdminSection(key)` gate is a follow-up;
 * for now only the new Admins-management routes carry it.
 */
export function requireAdminSection(section: AdminSection): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.isAuthenticated() || !req.user) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }
    const user = req.user as any;
    if (!isAdminIdentity(user)) {
      res.status(403).json({ success: false, message: "Admin privileges required" });
      return;
    }
    if (!hasAdminSection(user.adminPermissions, section)) {
      res.status(403).json({
        success: false,
        message: `You do not have access to the "${section}" section`,
        code: "ADMIN_SECTION_FORBIDDEN",
      });
      return;
    }
    next();
  };
}

/**
 * Middleware that requires SLP subscription plan
 */
export const requireSLPPlan: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (!req.isAuthenticated() || !req.user) {
    res.status(401).json({
      success: false,
      message: "Authentication required",
    });
    return;
  }

  const user = req.user as any;
  if (user.userType !== "SLP" && !user.isAdmin) {
    res.status(403).json({
      success: false,
      message: "SLP subscription required for this feature",
    });
    return;
  }

  next();
};

/**
 * Middleware that checks if onboarding is complete
 */
export const requireOnboardingComplete = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) {
      next();
      return;
    }

    const user = await userRepository.getUser((req.user as any).id);
    if (!user) {
      res.status(404).json({
        success: false,
        message: "User not found",
      });
      return;
    }

    // Check if user has completed onboarding
    if (user.onboardingStep < 3) {
      // Allow users who have AAC users to proceed even if onboarding not marked complete
      const students = await studentRepository.getStudentsByUserId(
        (req.user as any).id
      );
      if (!students || students.length === 0) {
        res.status(412).json({
          success: false,
          message: "Please complete onboarding first",
          errorType: "onboarding_incomplete",
          onboardingStep: user.onboardingStep,
        });
        return;
      }
    }

    next();
  } catch (error: any) {
    console.error("Onboarding check error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * CSRF protection middleware. Verifies that state-changing requests come
 * from an allowed origin. The allowlist is the same one used by CORS
 * (resolved via `resolveAllowedOrigins`).
 *
 * Origin header is preferred; we fall back to Referer for browsers that
 * don't send Origin on same-origin POSTs (rare). Same-origin requests
 * (Origin host equals our own host) are always allowed.
 *
 * Skipped for GET/HEAD/OPTIONS — these should be side-effect-free.
 */
export const validateCSRF: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }
  // Skip in tests — supertest doesn't send Origin and we don't want to block
  // every integration test on a CSRF check.
  if (process.env.NODE_ENV === "test") {
    next();
    return;
  }

  const allowed = resolveAllowedOrigins();

  const host = req.headers.host;
  const protocol = req.secure ? "https:" : "http:";
  const sameOrigin = host ? `${protocol}//${host}` : null;

  const origin = (req.headers.origin as string | undefined) || null;
  const referer = (req.headers.referer as string | undefined) || null;

  let candidate: string | null = origin;
  if (!candidate && referer) {
    try {
      const u = new URL(referer);
      candidate = `${u.protocol}//${u.host}`;
    } catch {
      // fall through to rejection
    }
  }

  // Packaged native clients (iPad CapacitorHttp) send neither header — their
  // requests come from native code, not a browsing context — so they declare
  // their origin instead. Only the fixed native origins are accepted here, and
  // only when nothing more trustworthy was supplied. See NATIVE_ORIGIN_HEADER.
  if (!candidate) {
    candidate = resolveDeclaredNativeOrigin(
      req.headers as Record<string, string | string[] | undefined>,
    );
  }

  if (!candidate) {
    res.status(403).json({ success: false, message: "CSRF: missing Origin/Referer" });
    return;
  }

  if (sameOrigin && candidate === sameOrigin) {
    next();
    return;
  }
  if (allowed.includes(candidate)) {
    next();
    return;
  }
  // Wildcard subdomain support, mirroring the CORS check.
  for (const a of allowed) {
    if (a.startsWith("https://*.") && candidate.startsWith("https://")) {
      const suffix = a.slice("https://*.".length);
      if (candidate.endsWith("." + suffix) || candidate === "https://" + suffix) {
        next();
        return;
      }
    }
  }
  // Dev convenience: allow any loopback origin in non-prod, mirroring CORS.
  if (process.env.NODE_ENV !== "production") {
    try {
      const h = new URL(candidate).hostname;
      if (h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1") {
        next();
        return;
      }
    } catch {
      // fall through to rejection
    }
  }

  res.status(403).json({ success: false, message: "CSRF: origin not allowed" });
};

/**
 * Middleware factory that checks a specific license permission.
 * System admins bypass all checks.
 * Usage: requireLicensePermission('aacEnabled')
 */
/**
 * Gate a route on the caller's role in the institute named by a PATH PARAM.
 *
 * Replaces ~24 hand-rolled copies of the same three steps — re-read the param,
 * call one of the membership predicates, map a boolean to a status — written
 * out again in every institute-scoped handler. Two of those copies decided the
 * status by STRING-MATCHING the service's error message:
 *
 *     res.status(result.error === "Only admins can update institute details" ? 403 : 404)
 *     res.status(result.error?.includes("admin") ? 403 : 404)
 *
 * The second turns any future error message containing the word "admin" into a
 * 403; the first breaks the moment somebody rewords a string. Deciding
 * permission BEFORE the handler runs removes the mapping problem entirely.
 *
 * It also makes "which routes are admin-only" greppable in `routes.ts` rather
 * than archaeological — what the 2026-09-10 authorization audit needed and
 * could not do.
 *
 * ENUMERATION: an unpermitted caller gets 403 whether or not the institute
 * exists. That is the platform standard (§2.4, 403-before-404) and a deliberate
 * change from the handlers' old 404-for-missing, which let anyone with a session
 * probe which institute ids are real.
 *
 * Support sessions pass through `isUserMemberOfInstitute` / `isUserAdminOfInstitute`
 * exactly as everywhere else; both refuse a nullish institute or user outright,
 * so a missing param cannot become an accidental match.
 *
 * Usage: app.patch("/api/institutes/:id", requireAuth, requireInstituteRole("id", "admin"), handler)
 */
export function requireInstituteRole(
  param: string,
  role: "member" | "admin",
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = (req.user as { id?: string } | undefined)?.id;
    if (!userId) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const instituteId = req.params[param];
    if (!instituteId) {
      res.status(400).json({ success: false, message: "Institute id is required" });
      return;
    }

    try {
      const permitted =
        role === "admin"
          ? await instituteRepository.isUserAdminOfInstitute(instituteId, userId)
          : await instituteRepository.isUserMemberOfInstitute(instituteId, userId);

      if (!permitted) {
        res.status(403).json({
          success: false,
          message:
            role === "admin"
              ? "Institute admin privileges required"
              : "You do not have access to this institute",
        });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireLicensePermission(
  permKey: keyof LicensePermissions,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.isAuthenticated() || !req.user) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const user = req.user as any;

    // System admins bypass license checks
    if (user.isSystemAdmin) {
      next();
      return;
    }

    try {
      // Lazy import to avoid circular deps
      const { licenseService } = await import("../services/licenseService");
      // Check across ALL the user's institute licenses — allow if ANY grants the permission.
      // Prior behavior picked only the "first non-none" license, which could deny even
      // when another of the user's institutes granted the feature.
      const granted = await licenseService.userHasPermission(
        user.id,
        permKey,
        user.isSystemAdmin,
      );

      if (!granted) {
        res.status(403).json({
          success: false,
          message: `License does not include this feature`,
          code: "LICENSE_REQUIRED",
        });
        return;
      }

      next();
    } catch (error: any) {
      console.error("License permission check error:", error);
      res.status(500).json({ success: false, message: "Server error" });
    }
  };
}
