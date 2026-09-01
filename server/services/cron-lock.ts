// Cluster-wide mutual exclusion for the maintenance crons.
//
// Under the ECS `hipaa` profile the API runs as 2–10 identical tasks, and a
// `setInterval` in the process fires once PER TASK. Left alone, the daily
// sweeps would run N times concurrently: harmless-but-noisy for the idempotent
// prunes, but the erasure sweep would race itself (two tasks hard-deleting the
// same student, one of them logging a spurious failure) and the threshold
// checks could double-notify.
//
// A Postgres session-level advisory lock gives exactly one winner per run. It
// must be taken and released on the SAME connection, so this checks out a
// dedicated client rather than using the pool's round-robin `query`. A crashed
// task releases its locks when the session dies, so a lock can't be stranded.
//
// POOL BUDGET — the client is held for the WHOLE of `fn`, and `fn`'s own
// queries need a second slot. With `max: 3` (db.ts), three locked crons in
// flight at once leave nothing for their bodies and the pool deadlocks: that
// took production down on 2026-09-01 when every daily cron's 24h tick landed
// in the same millisecond. Callers must therefore never run two of these
// concurrently in one process — maintenanceCrons.ts serialises them through
// one queue, so at most one slot is ever held here.

import { pool } from "../db";

export interface CronLockResult<T> {
  /** false when another task held the lock and this run was skipped. */
  ran: boolean;
  result?: T;
}

/** Stable 64-bit key from a name; hashtext() gives a 32-bit int, which is fine. */
async function runLocked<T>(name: string, fn: () => Promise<T>): Promise<CronLockResult<T>> {
  const client = await pool.connect();
  let held = false;
  try {
    const { rows } = await client.query<{ pg_try_advisory_lock: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1))",
      [`aivota:cron:${name}`],
    );
    held = rows[0]?.pg_try_advisory_lock === true;
    if (!held) return { ran: false };
    return { ran: true, result: await fn() };
  } finally {
    if (held) {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [`aivota:cron:${name}`]);
      } catch (err) {
        console.error(`[cron-lock] unlock failed for ${name}:`, err);
      }
    }
    client.release();
  }
}

/**
 * Run `fn` only if no other process is currently running the cron `name`.
 * Skips (rather than waits) when the lock is held — the next tick will get it.
 */
export function withCronLock<T>(name: string, fn: () => Promise<T>): Promise<CronLockResult<T>> {
  return runLocked(name, fn);
}
