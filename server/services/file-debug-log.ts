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
//
// SECOND reason this matters, added 2026-08-30: the ECS task definition can now
// run with `readonlyRootFilesystem = true` (terraform/ecs.tf,
// var.ecs_readonly_root_fs). Under that flag every path in this list is on a
// read-only mount and an append throws EROFS. `/tmp` is the ONLY writable path
// in the container. So the gate is no longer just a privacy control — a leaked
// write is an exception on a request path. Everything here therefore goes
// through safeAppend/safeTruncate below, which cannot throw.

import fs from "fs";

/**
 * The predicate, as a function so it can be evaluated against a mutated
 * `process.env` (the source-pin test does exactly that). Production behaviour
 * is defined by the `fileDebugLoggingEnabled` const below, which is this
 * function sampled once at module load — module-load sampling is deliberate:
 * a per-call `process.env` read on every log line is measurable in the relay's
 * hot path, and nothing flips these variables at runtime.
 */
export function fileDebugLogEnabled(): boolean {
  if (process.env.DEBUG_FILE_LOGS === "true") return true;
  if (process.env.AWS_LAMBDA_EXEC_WRAPPER) return false;
  return process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test";
}

export const fileDebugLoggingEnabled: boolean = fileDebugLogEnabled();

/**
 * Paths that have already failed permanently. A read-only root filesystem does
 * not heal, so retrying is a failed syscall per log line forever; one strike
 * and the path is dead for the life of the process.
 */
const deadPaths = new Set<string>();

/** EROFS is the read-only-root case; the others are the same "will never
 *  succeed again" shape. Anything else (a transient EMFILE, say) is swallowed
 *  but left retryable. */
function isPermanent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EROFS" || code === "EACCES" || code === "EPERM" || code === "ENOSPC";
}

/**
 * Append to a debug log file. NEVER throws, whatever the filesystem does —
 * a debug log that can take down a chat turn, a relay or a request is worse
 * than no debug log. Callers must still check the gate first; this is the
 * belt to the gate's braces.
 */
export function safeAppend(file: string, text: string): void {
  if (deadPaths.has(file)) return;
  try {
    fs.appendFileSync(file, text);
  } catch (err) {
    if (isPermanent(err)) deadPaths.add(file);
  }
}

/** Truncate (or create) a debug log file. Same no-throw contract as safeAppend
 *  — used by the "fresh file per process" and size-cap paths. */
export function safeTruncate(file: string): void {
  if (deadPaths.has(file)) return;
  try {
    fs.writeFileSync(file, "");
  } catch (err) {
    if (isPermanent(err)) deadPaths.add(file);
  }
}

/** Test seam: forget the permanent-failure memo. Not used in production. */
export function resetDebugFileState(): void {
  deadPaths.clear();
}

/**
 * Whether live-session flow events may be persisted to the `session_debug_logs`
 * table (the admin session-debug view). Those rows hold untruncated system
 * prompts and transcripts with no retention policy, and the per-session
 * trigger is a CLIENT-supplied flag — so production requires an explicit
 * server-side opt-in on top of it.
 */
export const sessionDebugPersistenceEnabled: boolean =
  process.env.SESSION_DEBUG_LOGS === "true" || process.env.NODE_ENV !== "production";
