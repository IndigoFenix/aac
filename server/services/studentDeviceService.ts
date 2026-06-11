// server/services/studentDeviceService.ts
// AAC device registration: each student may have at most N devices registered,
// where N is the sum of maxDevicesPerStudent across the licenses of all
// institutes the student actively belongs to. The AAC client re-runs
// registerDevice on every startup, so a limit that shrank (student removed
// from an institute) blocks even previously-registered devices until enough
// slots are freed.

import type { StudentDevice } from "@shared/schema";
import { instituteRepository } from "../repositories";
import { studentDeviceRepository } from "../repositories/studentDeviceRepository";
import { licenseService } from "./licenseService";
import { activityLogService } from "./activityLogService";
import { evaluateDeviceRegistration, sumDeviceLimits } from "./student-device-logic";

export interface DeviceRegistrationResult {
  allowed: boolean;
  /** Whether THIS device holds a registration slot (it keeps it even when blocked by a shrunken limit). */
  isRegistered: boolean;
  limit: number;
  devices: StudentDevice[];
}

export class StudentDeviceService {
  /** Sum of license device limits across the student's active institutes (-1 = unlimited). */
  async getEffectiveDeviceLimit(studentId: string): Promise<number> {
    const enrollments = await instituteRepository.getInstitutesByStudentId(studentId);
    const permsList = await Promise.all(
      enrollments.map(({ institute }) => licenseService.getInstitutePermissions(institute.id)),
    );
    return sumDeviceLimits(permsList);
  }

  async listDevices(studentId: string): Promise<{ devices: StudentDevice[]; limit: number }> {
    const [devices, limit] = await Promise.all([
      studentDeviceRepository.getDevicesForStudent(studentId),
      this.getEffectiveDeviceLimit(studentId),
    ]);
    return { devices, limit };
  }

  /**
   * Register (or re-validate) a device for a student. Idempotent: an already
   * registered device just gets its lastSeenAt refreshed. Returns allowed=false
   * without registering when no slots are left, and also when the device IS
   * registered but the whole set no longer fits the limit.
   */
  async registerDevice(opts: {
    studentId: string;
    deviceId: string;
    deviceName?: string | null;
    userId?: string | null;
  }): Promise<DeviceRegistrationResult> {
    const { studentId, deviceId, deviceName, userId } = opts;
    const [limit, devices] = await Promise.all([
      this.getEffectiveDeviceLimit(studentId),
      studentDeviceRepository.getDevicesForStudent(studentId),
    ]);

    const verdict = evaluateDeviceRegistration({
      limit,
      registeredDeviceIds: devices.map((d) => d.deviceId),
      deviceId,
    });

    if (verdict.isRegistered) {
      await studentDeviceRepository.touchDevice(studentId, deviceId, deviceName);
      return { allowed: verdict.allowed, isRegistered: true, limit, devices };
    }

    if (!verdict.allowed) {
      return { allowed: false, isRegistered: false, limit, devices };
    }

    await studentDeviceRepository.addDevice({
      studentId,
      deviceId,
      deviceName,
      registeredByUserId: userId,
    });
    activityLogService.log({
      userId,
      eventType: "device_registered",
      subjectType1: "student",
      subjectId1: studentId,
      subjectType2: "user",
      subjectId2: userId,
      details: { deviceId, deviceName: deviceName ?? null },
    });

    const updated = await studentDeviceRepository.getDevicesForStudent(studentId);
    return { allowed: true, isRegistered: true, limit, devices: updated };
  }

  /** De-register by row id (clinician client / AAC device manager). */
  async deregisterByRecordId(studentId: string, recordId: string, userId?: string | null): Promise<boolean> {
    const removed = await studentDeviceRepository.deleteDeviceByRecordId(studentId, recordId);
    if (removed) this.logDeregistration(studentId, removed, userId);
    return !!removed;
  }

  /** De-register the calling device itself (AAC logout / student switch). */
  async deregisterByDeviceId(studentId: string, deviceId: string, userId?: string | null): Promise<boolean> {
    const removed = await studentDeviceRepository.deleteDeviceByDeviceId(studentId, deviceId);
    if (removed) this.logDeregistration(studentId, removed, userId);
    return !!removed;
  }

  private logDeregistration(studentId: string, device: StudentDevice, userId?: string | null): void {
    activityLogService.log({
      userId,
      eventType: "device_deregistered",
      subjectType1: "student",
      subjectId1: studentId,
      subjectType2: "user",
      subjectId2: userId,
      details: { deviceId: device.deviceId, deviceName: device.deviceName },
    });
  }
}

export const studentDeviceService = new StudentDeviceService();
