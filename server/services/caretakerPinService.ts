// server/services/caretakerPinService.ts
//
// The caretaker PIN gates the caretaker surfaces of the AAC device (switch
// student, manage devices, sign out) on a session that is, by design, signed
// in for a year. Per student — it is a decision about THAT child's device —
// and set by anyone with access to the student, normally from the clinician
// panel.
//
// Stored as a bcrypt hash in its own table (never on aac_settings, which is
// serialized to clients). The API never returns the hash or the PIN; the
// device only ever learns "is a PIN set" and "did this guess match", and the
// guess endpoint is rate-limited (middleware/security.ts caretakerPinRateLimiter).

import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { studentCaretakerPins } from "@shared/schema";
import { activityLogService } from "./activityLogService";

const SALT_ROUNDS = 12;
export const PIN_PATTERN = /^[0-9]{4,8}$/;

export class CaretakerPinError extends Error {
  constructor(public code: "INVALID_PIN") {
    super(code);
    this.name = "CaretakerPinError";
  }
}

export const caretakerPinService = {
  async isSet(studentId: string): Promise<boolean> {
    const [row] = await db
      .select({ studentId: studentCaretakerPins.studentId })
      .from(studentCaretakerPins)
      .where(eq(studentCaretakerPins.studentId, studentId))
      .limit(1);
    return !!row;
  },

  /** Set (or replace) the PIN. Validates the shape; hashes; audits. */
  async set(studentId: string, pin: string, byUserId: string | null): Promise<void> {
    if (!PIN_PATTERN.test(pin)) throw new CaretakerPinError("INVALID_PIN");
    const pinHash = await bcrypt.hash(pin, SALT_ROUNDS);
    await db
      .insert(studentCaretakerPins)
      .values({ studentId, pinHash, updatedByUserId: byUserId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: studentCaretakerPins.studentId,
        set: { pinHash, updatedByUserId: byUserId, updatedAt: new Date() },
      });
    activityLogService.log({
      userId: byUserId,
      eventType: "update",
      subjectType1: "student",
      subjectId1: studentId,
      details: { field: "caretakerPin", action: "set" },
    });
  },

  async clear(studentId: string, byUserId: string | null): Promise<void> {
    await db.delete(studentCaretakerPins).where(eq(studentCaretakerPins.studentId, studentId));
    activityLogService.log({
      userId: byUserId,
      eventType: "update",
      subjectType1: "student",
      subjectId1: studentId,
      details: { field: "caretakerPin", action: "cleared" },
    });
  },

  /**
   * True when `pin` matches the stored hash. A student with NO PIN set
   * verifies as true — the gate is opt-in, and a device that never had a PIN
   * must not lock its caretaker out.
   */
  async verify(studentId: string, pin: string): Promise<boolean> {
    const [row] = await db
      .select({ pinHash: studentCaretakerPins.pinHash })
      .from(studentCaretakerPins)
      .where(eq(studentCaretakerPins.studentId, studentId))
      .limit(1);
    if (!row) return true;
    if (typeof pin !== "string" || !PIN_PATTERN.test(pin)) return false;
    return bcrypt.compare(pin, row.pinHash);
  },
};
