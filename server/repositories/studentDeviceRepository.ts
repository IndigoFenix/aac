// server/repositories/studentDeviceRepository.ts
// Repository for AAC device registrations (student_devices)

import { studentDevices, type StudentDevice } from "@shared/schema";
import { db } from "../db";
import { and, asc, eq } from "drizzle-orm";

export class StudentDeviceRepository {
  async getDevicesForStudent(studentId: string): Promise<StudentDevice[]> {
    return db
      .select()
      .from(studentDevices)
      .where(eq(studentDevices.studentId, studentId))
      .orderBy(asc(studentDevices.createdAt));
  }

  /**
   * Register a device for a student. Upsert on (studentId, deviceId) so a
   * concurrent double-register from the same device can't violate the unique
   * index — the second call just refreshes lastSeenAt.
   */
  async addDevice(data: {
    studentId: string;
    deviceId: string;
    deviceName?: string | null;
    registeredByUserId?: string | null;
  }): Promise<StudentDevice> {
    const [row] = await db
      .insert(studentDevices)
      .values({
        studentId: data.studentId,
        deviceId: data.deviceId,
        deviceName: data.deviceName ?? null,
        registeredByUserId: data.registeredByUserId ?? null,
      })
      .onConflictDoUpdate({
        target: [studentDevices.studentId, studentDevices.deviceId],
        set: {
          lastSeenAt: new Date(),
          ...(data.deviceName ? { deviceName: data.deviceName } : {}),
        },
      })
      .returning();
    return row;
  }

  /** Refresh lastSeenAt (and name, when provided) for an existing registration. */
  async touchDevice(studentId: string, deviceId: string, deviceName?: string | null): Promise<void> {
    await db
      .update(studentDevices)
      .set({
        lastSeenAt: new Date(),
        ...(deviceName ? { deviceName } : {}),
      })
      .where(and(eq(studentDevices.studentId, studentId), eq(studentDevices.deviceId, deviceId)));
  }

  /** De-register by row id (management UIs). Returns the removed row, if any. */
  async deleteDeviceByRecordId(studentId: string, recordId: string): Promise<StudentDevice | undefined> {
    const [row] = await db
      .delete(studentDevices)
      .where(and(eq(studentDevices.studentId, studentId), eq(studentDevices.id, recordId)))
      .returning();
    return row || undefined;
  }

  /** De-register by installation id (the device itself, on logout). */
  async deleteDeviceByDeviceId(studentId: string, deviceId: string): Promise<StudentDevice | undefined> {
    const [row] = await db
      .delete(studentDevices)
      .where(and(eq(studentDevices.studentId, studentId), eq(studentDevices.deviceId, deviceId)))
      .returning();
    return row || undefined;
  }
}

export const studentDeviceRepository = new StudentDeviceRepository();
