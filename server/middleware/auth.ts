import type { Request, Response, NextFunction, RequestHandler } from "express";
import { userRepository, studentRepository } from "../repositories";

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
  if (!user.isAdmin && user.userType !== "admin") {
    res.status(403).json({
      success: false,
      message: "Admin privileges required",
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
