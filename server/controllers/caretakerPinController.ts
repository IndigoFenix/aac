// server/controllers/caretakerPinController.ts
// Caretaker PIN for the AAC device — see services/caretakerPinService.ts.
//
//   PUT  /api/students/:id/caretaker-pin            { pin } | { pin: null }   (clinician panel)
//   GET  /api/aac/students/:id/caretaker-pin        → { set }                 (device: is there a gate?)
//   POST /api/aac/students/:id/caretaker-pin/verify { pin } → { ok }          (device; rate-limited)
//
// Every route needs a session AND verified access to the student. The hash
// never leaves the server.

import type { Request, Response } from "express";
import { studentService } from "../services";
import { caretakerPinService, CaretakerPinError } from "../services/caretakerPinService";

async function requireStudentAccess(req: Request, res: Response): Promise<string | undefined> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: "error:AUTH_REQUIRED" });
    return undefined;
  }
  const { hasAccess } = await studentService.verifyStudentAccess(req.params.id, userId);
  if (!hasAccess) {
    res.status(403).json({ success: false, error: "error:STUDENT_ACCESS_DENIED" });
    return undefined;
  }
  return userId;
}

export class CaretakerPinController {
  async set(req: Request, res: Response): Promise<void> {
    try {
      const userId = await requireStudentAccess(req, res);
      if (!userId) return;
      const pin = req.body?.pin;
      if (pin === null || pin === "") {
        await caretakerPinService.clear(req.params.id, userId);
        res.json({ success: true, set: false });
        return;
      }
      if (typeof pin !== "string") {
        res.status(400).json({ success: false, error: "error:INVALID_PIN" });
        return;
      }
      await caretakerPinService.set(req.params.id, pin, userId);
      res.json({ success: true, set: true });
    } catch (err) {
      if (err instanceof CaretakerPinError) {
        res.status(400).json({ success: false, error: `error:${err.code}` });
        return;
      }
      console.error("[caretakerPin] set failed:", err);
      res.status(500).json({ success: false, error: "error:PIN_SET_FAILED" });
    }
  }

  async status(req: Request, res: Response): Promise<void> {
    try {
      if (!(await requireStudentAccess(req, res))) return;
      res.json({ success: true, set: await caretakerPinService.isSet(req.params.id) });
    } catch (err) {
      console.error("[caretakerPin] status failed:", err);
      res.status(500).json({ success: false, error: "error:PIN_STATUS_FAILED" });
    }
  }

  async verify(req: Request, res: Response): Promise<void> {
    try {
      if (!(await requireStudentAccess(req, res))) return;
      const ok = await caretakerPinService.verify(req.params.id, String(req.body?.pin ?? ""));
      if (!ok) {
        res.status(403).json({ success: false, ok: false, error: "error:PIN_WRONG" });
        return;
      }
      res.json({ success: true, ok: true });
    } catch (err) {
      console.error("[caretakerPin] verify failed:", err);
      res.status(500).json({ success: false, error: "error:PIN_VERIFY_FAILED" });
    }
  }
}

export const caretakerPinController = new CaretakerPinController();
