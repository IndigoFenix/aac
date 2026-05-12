import type { Request, Response, NextFunction, RequestHandler } from "express";
import { userRepository, studentRepository } from "../repositories";
import type { LicensePermissions } from "@shared/license-permissions";
import { runWithSupportContext } from "../services/customerSupportService";
import { resolveAllowedOrigins } from "./security";
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
  const supportInstituteId = (req.session as any)?.support?.instituteId;
  if (supportInstituteId) {
    runWithSupportContext(supportInstituteId, () => next());
  } else {
    next();
  }
};

/**
 * Middleware that allows optional authentication
 */
export const optionalAuth: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // Just pass through - authentication state is checked in handler
  next();
};

/**
 * Middleware that requires admin privileges
 */
export const requireAdmin: RequestHandler = (
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
  if (!user.isAdmin && !user.isSystemAdmin && user.userType !== "admin") {
    res.status(403).json({
      success: false,
      message: "Admin privileges required",
    });
    return;
  }

  next();
};

/**
 * Middleware that requires system admin privileges
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
