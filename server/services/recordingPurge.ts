// server/services/recordingPurge.ts
//
// Erasure that reaches the DEVICE'S DISK.
//
// The optional session-recording feature (shared/aac/session-recording.ts)
// writes video of a child to the Videos folder of the tablet she uses. Those
// files have no server-side representation at all — no route reads them, no
// column names them — so every deletion path the platform has walks straight
// past them. Tombstoning a student, hard-deleting her rows, revoking the
// tablet's registration slot: all of it leaves the footage exactly where it
// was. This module is the thin server half of closing that gap.
//
// ── The shape of the promise ──
// This is BEST-EFFORT, and deliberately so rather than accidentally so. Three
// separate reasons it cannot be a guarantee:
//
//  1. The device must be listening. `live-session-registry` is an in-memory
//     map of live AAC sessions on THIS process; a device that is switched off,
//     asleep, on another ECS task, or on the legacy relay (which never
//     registers) hears nothing. That is why the AAC client also purges on its
//     own when the student's profile comes back definitively unauthorised —
//     see client-aac/src/pages/home.tsx. The device that most needs purging is
//     usually the one that was off when the erasure happened.
//  2. A clip can be unattributable. Selection is by the manifest's
//     `studentId`, and a clip whose manifest was rebuilt after a crash has
//     none. See `planStudentPurge`.
//  3. Nothing stops a human copying a file out first. The folder was CHOSEN so
//     that a caretaker could; that is the feature.
//
// So the honest claim is: every live device is asked, every device asks itself
// on its next definitive rejection, and what actually went is written to the
// activity log. Not "the footage is gone."

import type { RecordingPurgeReason } from "@shared/aac/session-recording.js";
import { activityLogService, type ActivityLogEntry } from "./activityLogService";
import { getLiveSession, type LiveSessionHandle } from "./dual-agent/live-session-registry";

/**
 * Seams for tests. The live-session registry is process-global mutable state
 * and the activity log writes to Postgres; injecting both keeps this module's
 * suite DB-free and lets it assert what was SENT rather than what survived.
 */
export interface RecordingPurgeDeps {
  getSession?: (studentId: string) => LiveSessionHandle | null;
  log?: (entry: ActivityLogEntry) => void;
}

function sessionLookup(deps: RecordingPurgeDeps): (studentId: string) => LiveSessionHandle | null {
  return deps.getSession ?? getLiveSession;
}

function logger(deps: RecordingPurgeDeps): (entry: ActivityLogEntry) => void {
  return deps.log ?? ((entry) => activityLogService.log(entry));
}

/**
 * Ask every live session for this student to purge its local recordings.
 *
 * Returns how many sockets were actually notified — 0 is the common case (no
 * one is using the device right now) and is not an error. Never throws: this
 * runs inside erasure and device-revocation, and neither may fail because a
 * WebSocket was mid-close.
 */
export function requestRecordingPurge(
  studentId: string,
  reason: RecordingPurgeReason,
  deps: RecordingPurgeDeps = {},
): number {
  const id = typeof studentId === "string" ? studentId.trim() : "";
  if (!id) return 0;

  let notified = 0;
  try {
    const session = sessionLookup(deps)(id);
    // An older coordinator build has no such method; treat that exactly like
    // "nobody was listening" rather than crashing the erasure that called us.
    if (session?.requestRecordingPurge) {
      session.requestRecordingPurge(reason);
      notified = 1;
    }
  } catch (err) {
    console.error("[recordingPurge] could not reach the live session:", err);
  }
  return notified;
}

/**
 * Record a device's answer.
 *
 * Written as an `delete` event against the student, because that is what it
 * is: media of this child was destroyed, on a machine, at a time. The
 * `bestEffort` flag is on every row on purpose — a reader who finds one of
 * these must not read it as proof the device holds nothing, for the three
 * reasons in the module header.
 */
export function recordRecordingsPurged(
  input: {
    studentId: string;
    clipIds: readonly string[];
    /** The AAC device, when the caller knows it. The relay ack does not carry
     *  one: the WebSocket authenticates as a user, and `sess.aacDeviceId` is
     *  not threaded onto the coordinator. */
    deviceId?: string | null;
    userId?: string | null;
    instituteId?: string | null;
  },
  deps: RecordingPurgeDeps = {},
): void {
  const clipIds = Array.isArray(input.clipIds) ? input.clipIds.filter((c) => typeof c === "string") : [];
  logger(deps)({
    instituteId: input.instituteId ?? undefined,
    userId: input.userId ?? undefined,
    eventType: "delete",
    subjectType1: "student",
    subjectId1: input.studentId,
    details: {
      route: "device.recordings_purged",
      clipCount: clipIds.length,
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      // Not decoration. An erasure certificate that cited this row as evidence
      // of destruction would be overclaiming — see the module header.
      bestEffort: true,
    },
  });
}
