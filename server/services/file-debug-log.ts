// The ONE predicate every file-based debug logger must consult.
//
// These loggers write prompts, transcripts, memory values and clinical
// summaries — PHI — to the container's filesystem. That is fine on a
// developer's machine and must never happen in production. Several of them
// gated only on `AWS_LAMBDA_EXEC_WRAPPER` ("no-op on Lambda"), which is not
// set on ECS Fargate: the Lambda→ECS cutover silently turned them all on in
// production. dual-agent-logger.ts had the correct predicate and a comment
// predicting exactly this; it was never propagated. Now it lives here.
//
// Opt back in explicitly with DEBUG_FILE_LOGS=true — local debugging only.

const isLambda = !!process.env.AWS_LAMBDA_EXEC_WRAPPER;

export const fileDebugLoggingEnabled: boolean =
  process.env.DEBUG_FILE_LOGS === "true" ||
  (!isLambda && process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test");

/**
 * Whether live-session flow events may be persisted to the `session_debug_logs`
 * table (the admin session-debug view). Those rows hold untruncated system
 * prompts and transcripts with no retention policy, and the per-session
 * trigger is a CLIENT-supplied flag — so production requires an explicit
 * server-side opt-in on top of it.
 */
export const sessionDebugPersistenceEnabled: boolean =
  process.env.SESSION_DEBUG_LOGS === "true" || process.env.NODE_ENV !== "production";
