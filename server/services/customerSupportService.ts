/**
 * Customer Support Service
 *
 * Provides customer support impersonation capabilities for system admins.
 * A system admin can "log in" to a specific institute's context to provide support,
 * gaining admin-level access to that institute while respecting its license restrictions.
 *
 * Uses AsyncLocalStorage to propagate the support institute ID through the call stack
 * without threading it through every function signature.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Check if a user has customer support privileges.
 * Currently returns true for system admins. This function exists as a separate
 * check so it can be refined later (e.g., dedicated support role).
 */
export function isCustomerSupport(user: { isSystemAdmin?: boolean | null }): boolean {
  return !!user?.isSystemAdmin;
}

/**
 * Session-level support state. Stored in `req.session.support`.
 */
export interface SupportSession {
  /** The institute ID the support agent is logged into */
  instituteId: string;
  /** When the support session started */
  startedAt: string;
}

// Extend express-session to include our support field
declare module "express-session" {
  interface SessionData {
    support?: SupportSession;
  }
}

/**
 * Get the active support session from the request, if any.
 */
export function getSupportSession(req: { session?: { support?: SupportSession } }): SupportSession | undefined {
  return req.session?.support;
}

/**
 * Check if a request is in customer support mode.
 */
export function isInSupportMode(req: { session?: { support?: SupportSession } }): boolean {
  return !!req.session?.support?.instituteId;
}

// ---------------------------------------------------------------------------
// AsyncLocalStorage for propagating support context through the call stack
// ---------------------------------------------------------------------------

const supportStorage = new AsyncLocalStorage<string>();

/**
 * Run a function within a support context. All calls to `getActiveSupportInstituteId()`
 * within the callback (including nested async calls) will return the support institute ID.
 */
export function runWithSupportContext<T>(supportInstituteId: string, fn: () => T): T {
  return supportStorage.run(supportInstituteId, fn);
}

/**
 * Get the active support institute ID from the current async context.
 * Returns undefined if not in support mode.
 * Can be called from anywhere in the call stack (repositories, services, etc.)
 * without needing access to `req`.
 */
export function getActiveSupportInstituteId(): string | undefined {
  return supportStorage.getStore();
}
