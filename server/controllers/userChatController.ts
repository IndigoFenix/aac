// server/controllers/userChatController.ts
// HTTP handlers for clinician-to-clinician chat.

import type { Request, Response } from "express";
import { userChatService, UserChatAuthorizationError } from "../services/userChat/userChatService";
import { userChatRepository } from "../repositories/userChatRepository";
import { pushNotifier } from "../services/userChat/pushNotifier";

export class UserChatController {
  /** GET /api/user-chat/contacts?instituteId=... */
  async getContacts(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const instituteId = typeof req.query.instituteId === "string" ? req.query.instituteId : undefined;
      const contacts = await userChatRepository.listContacts(user.id, instituteId);
      res.json({ success: true, contacts });
    } catch (err: any) {
      console.error("[userChat] getContacts:", err);
      res.status(500).json({ success: false, message: "Failed to load contacts" });
    }
  }

  /** GET /api/user-chat/rooms */
  async getRooms(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const rooms = await userChatRepository.listRoomsForUser(user.id);
      res.json({ success: true, rooms });
    } catch (err: any) {
      console.error("[userChat] getRooms:", err);
      res.status(500).json({ success: false, message: "Failed to load rooms" });
    }
  }

  /** POST /api/user-chat/rooms  body: { instituteId, participantIds, name? } */
  async createRoom(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const { instituteId, participantIds, name } = req.body ?? {};
      if (typeof instituteId !== "string" || !Array.isArray(participantIds)) {
        res.status(400).json({ success: false, message: "instituteId and participantIds required" });
        return;
      }
      const room = await userChatService.createRoom({
        requesterId: user.id,
        instituteId,
        participantIds,
        name: typeof name === "string" ? name : null,
      });
      res.json({ success: true, room });
    } catch (err: any) {
      if (err instanceof UserChatAuthorizationError) {
        res.status(403).json({ success: false, message: err.message });
        return;
      }
      console.error("[userChat] createRoom:", err);
      res.status(500).json({ success: false, message: "Failed to create room" });
    }
  }

  /** GET /api/user-chat/rooms/:id/messages?before=<iso>&limit=50 */
  async getMessages(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const roomId = req.params.id;
      const before = typeof req.query.before === "string" ? req.query.before : undefined;
      const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
      const messages = await userChatService.getMessages({
        requesterId: user.id,
        roomId,
        before,
        limit,
      });
      res.json({ success: true, messages });
    } catch (err: any) {
      if (err instanceof UserChatAuthorizationError) {
        res.status(403).json({ success: false, message: err.message });
        return;
      }
      console.error("[userChat] getMessages:", err);
      res.status(500).json({ success: false, message: "Failed to load messages" });
    }
  }

  /** POST /api/user-chat/rooms/:id/messages  body: { body } */
  async sendMessage(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const roomId = req.params.id;
      const { body } = req.body ?? {};
      if (typeof body !== "string" || !body.trim()) {
        res.status(400).json({ success: false, message: "Message body required" });
        return;
      }
      const message = await userChatService.sendMessage({ requesterId: user.id, roomId, body });
      res.json({ success: true, message });
    } catch (err: any) {
      if (err instanceof UserChatAuthorizationError) {
        res.status(403).json({ success: false, message: err.message });
        return;
      }
      console.error("[userChat] sendMessage:", err);
      res.status(500).json({ success: false, message: "Failed to send message" });
    }
  }

  /** POST /api/user-chat/rooms/:id/read */
  async markRead(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const roomId = req.params.id;
      await userChatService.markRead({ requesterId: user.id, roomId });
      res.json({ success: true });
    } catch (err: any) {
      if (err instanceof UserChatAuthorizationError) {
        res.status(403).json({ success: false, message: err.message });
        return;
      }
      console.error("[userChat] markRead:", err);
      res.status(500).json({ success: false, message: "Failed to mark read" });
    }
  }

  /** POST /api/user-chat/push-register  body: { token, platform } */
  async registerPush(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const { token, platform } = req.body ?? {};
      if (typeof token !== "string" || typeof platform !== "string") {
        res.status(400).json({ success: false, message: "token and platform required" });
        return;
      }
      await userChatService.registerPushToken(user.id, token, platform);
      res.json({ success: true });
    } catch (err: any) {
      console.error("[userChat] registerPush:", err);
      res.status(500).json({ success: false, message: "Failed to register push token" });
    }
  }
}

export const userChatController = new UserChatController();
