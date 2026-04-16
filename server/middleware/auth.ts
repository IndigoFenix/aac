import type { Request, Response, NextFunction, RequestHandler } from "express";
import { userRepository, studentRepository } from "../repositories";
import type { LicensePermissions } from "@shared/license-permissions";
import { runWithSupportContext } from "../services/customerSupportService";

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
 * CSRF protection middleware for admin routes
 */
export const validateCSRF: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // Skip CSRF for GET requests (they should be safe)
  if (req.method === "GET") {
    next();
    return;
  }

  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const host = req.headers.host;
  const protocol = req.secure ? "https:" : "http:";
  const expectedOrigin = `${protocol}//${host}`;

  // Check Origin header (preferred)
  if (origin) {
    if (origin !== expectedOrigin) {
      res.status(403).json({
        success: false,
        message: "CSRF protection: Invalid origin",
      });
      return;
    }
    next();
    return;
  }

  // Fallback to Referer header
  if (referer) {
    try {
      const refererUrl = new URL(referer);
      const refererOrigin = `${refererUrl.protocol}//${refererUrl.host}`;
      if (refererOrigin !== expectedOrigin) {
        res.status(403).json({
          success: false,
          message: "CSRF protection: Invalid referer",
        });
        return;
      }
      next();
      return;
    } catch (error: any) {
      res.status(403).json({
        success: false,
        message: "CSRF protection: Invalid referer format",
      });
      return;
    }
  }

  // Reject if neither Origin nor Referer present
  res.status(403).json({
    success: false,
    message: "CSRF protection: Missing origin/referer headers",
  });
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
