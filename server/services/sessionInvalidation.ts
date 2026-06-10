// server/services/sessionInvalidation.ts
// Server-side eviction of a user's persisted login sessions.
//
// Passport 0.6+ regenerates the session on login (session-fixation defense), but
// that does nothing for OTHER live sessions a user already has. After a password
// reset or an MFA recovery we want every existing session for that user gone, so
// a compromised cookie can't survive the credential change.
//
// Sessions are stored by connect-pg-simple in the `sessions` table as JSON. The
// authenticated principal is serialized as sess.passport.user = { kind, id }
// (see serializeUser in userAuth.ts). Kept dependency-light (only `pool`) so it
// can be imported from auth services without pulling in passport/openid-client.

import { pool } from "../db";

/**
 * Delete all persisted sessions whose serialized passport user id matches
 * `userId`. Best-effort: a failure here must never block the password/MFA
 * change that triggered it, so errors are logged and swallowed.
 */
export async function deleteUserSessions(userId: string): Promise<number> {
  try {
    const result = await pool.query(
      `DELETE FROM sessions WHERE sess->'passport'->'user'->>'id' = $1`,
      [userId],
    );
    return result.rowCount ?? 0;
  } catch (err) {
    console.error("Failed to evict user sessions:", err);
    return 0;
  }
}
