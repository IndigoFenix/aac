import type { Request, Response } from "express";
import { studentService } from "../services";
import { studentDeviceService } from "../services/studentDeviceService";

// The client-generated installation id. UUID-sized, but we accept any opaque
// token in that size range so older/newer clients can change the format.
const DEVICE_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;
const MAX_DEVICE_NAME_LENGTH = 200;

function sanitizeDeviceName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_DEVICE_NAME_LENGTH);
}

export class StudentDeviceController {
  /**
   * POST /api/students/:id/devices/register  { deviceId, deviceName? }
   * Called by the AAC client whenever a student is selected AND on every app
   * startup with a restored student — the startup call is what re-checks the
   * limit after the student left an institute. Idempotent.
   */
  async registerDevice(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;
      const deviceId = req.body?.deviceId;

      if (typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId)) {
        res.status(400).json({ success: false, message: "Invalid deviceId" });
        return;
      }

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this student" });
        return;
      }

      const result = await studentDeviceService.registerDevice({
        studentId,
        deviceId,
        deviceName: sanitizeDeviceName(req.body?.deviceName),
        userId: currentUser.id,
      });

      res.json({ success: true, ...result });
    } catch (error: any) {
      console.error("Error registering student device:", error);
      res.status(500).json({ success: false, message: "Failed to register device" });
    }
  }

  /** GET /api/students/:id/devices — registered devices + effective limit. */
  async listDevices(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this student" });
        return;
      }

      const { devices, limit } = await studentDeviceService.listDevices(studentId);
      res.json({ success: true, devices, limit });
    } catch (error: any) {
      console.error("Error listing student devices:", error);
      res.status(500).json({ success: false, message: "Failed to list devices" });
    }
  }

  /** DELETE /api/students/:id/devices/:recordId — de-register from a management UI. */
  async deregisterDevice(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;
      const recordId = req.params.recordId;

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this student" });
        return;
      }

      const removed = await studentDeviceService.deregisterByRecordId(studentId, recordId, currentUser.id);
      if (!removed) {
        res.status(404).json({ success: false, message: "Device not found" });
        return;
      }
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error deregistering student device:", error);
      res.status(500).json({ success: false, message: "Failed to deregister device" });
    }
  }

  /**
   * POST /api/students/:id/devices/deregister  { deviceId }
   * The AAC device de-registering ITSELF on logout / student switch.
   * Succeeds (200) even when no registration existed — logout must not fail.
   */
  async deregisterSelf(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;
      const deviceId = req.body?.deviceId;

      if (typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId)) {
        res.status(400).json({ success: false, message: "Invalid deviceId" });
        return;
      }

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this student" });
        return;
      }

      const removed = await studentDeviceService.deregisterByDeviceId(studentId, deviceId, currentUser.id);
      res.json({ success: true, removed });
    } catch (error: any) {
      console.error("Error deregistering own device:", error);
      res.status(500).json({ success: false, message: "Failed to deregister device" });
    }
  }
}

export const studentDeviceController = new StudentDeviceController();
