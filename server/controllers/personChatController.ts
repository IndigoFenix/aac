// server/controllers/personChatController.ts
// HTTP handlers for person-to-person chat. The authenticated user is resolved to
// its OWN person (getOrCreateForUser) — acting as a student is deferred to the
// call/AAC client. Push tokens stay keyed on the device-owning user.

import type { Request, Response } from "express";
import { personChatService, PersonChatAuthorizationError } from "../services/personChat/personChatService";
import { personChatRepository } from "../repositories/personChatRepository";
import { personRepository } from "../repositories/personRepository";

export class PersonChatController {
  /** GET /api/person-chat/contacts?instituteId=... */
  async getContacts(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const person = await personRepository.getOrCreateForUser(user.id);
      const instituteId = typeof req.query.instituteId === "string" ? req.query.instituteId : undefined;
      const contacts = await personChatRepository.listContacts(person.id, instituteId);
      res.json({ success: true, contacts });
    } catch (err: any) {
      console.error("[personChat] getContacts:", err);
      res.status(500).json({ success: false, message: "Failed to load contacts" });
    }
  }

  /** GET /api/person-chat/rooms */
  async getRooms(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const person = await personRepository.getOrCreateForUser(user.id);
      const rooms = await personChatRepository.listRoomsForPerson(person.id);
      res.json({ success: true, rooms, selfPersonId: person.id });
    } catch (err: any) {
      console.error("[personChat] getRooms:", err);
      res.status(500).json({ success: false, message: "Failed to load rooms" });
    }
  }

  /** POST /api/person-chat/rooms  body: { instituteId, participantIds, name? } */
  async createRoom(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const person = await personRepository.getOrCreateForUser(user.id);
      const { instituteId, participantIds, name } = req.body ?? {};
      if (typeof instituteId !== "string" || !Array.isArray(participantIds)) {
        res.status(400).json({ success: false, message: "instituteId and participantIds required" });
        return;
      }
      const room = await personChatService.createRoom({
        requesterPersonId: person.id,
        instituteId,
        participantPersonIds: participantIds,
        name: typeof name === "string" ? name : null,
      });
      res.json({ success: true, room });
    } catch (err: any) {
      if (err instanceof PersonChatAuthorizationError) {
        res.status(403).json({ success: false, message: err.message });
        return;
      }
      console.error("[personChat] createRoom:", err);
      res.status(500).json({ success: false, message: "Failed to create room" });
    }
  }

  /** GET /api/person-chat/rooms/:id/messages?before=<iso>&limit=50 */
  async getMessages(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const person = await personRepository.getOrCreateForUser(user.id);
      const roomId = req.params.id;
      const before = typeof req.query.before === "string" ? req.query.before : undefined;
      const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
      const messages = await personChatService.getMessages({
        requesterPersonId: person.id,
        roomId,
        before,
        limit,
      });
      res.json({ success: true, messages });
    } catch (err: any) {
      if (err instanceof PersonChatAuthorizationError) {
        res.status(403).json({ success: false, message: err.message });
        return;
      }
      console.error("[personChat] getMessages:", err);
      res.status(500).json({ success: false, message: "Failed to load messages" });
    }
  }

  /** POST /api/person-chat/rooms/:id/messages  body: { body } */
  async sendMessage(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const person = await personRepository.getOrCreateForUser(user.id);
      const roomId = req.params.id;
      const { body, clientId } = req.body ?? {};
      if (typeof body !== "string" || !body.trim()) {
        res.status(400).json({ success: false, message: "Message body required" });
        return;
      }
      const message = await personChatService.sendMessage({
        requesterPersonId: person.id,
        roomId,
        body,
        clientId: typeof clientId === "string" ? clientId : undefined,
      });
      res.json({ success: true, message });
    } catch (err: any) {
      if (err instanceof PersonChatAuthorizationError) {
        res.status(403).json({ success: false, message: err.message });
        return;
      }
      console.error("[personChat] sendMessage:", err);
      res.status(500).json({ success: false, message: "Failed to send message" });
    }
  }

  /** POST /api/person-chat/rooms/:id/read */
  async markRead(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const person = await personRepository.getOrCreateForUser(user.id);
      const roomId = req.params.id;
      await personChatService.markRead({ requesterPersonId: person.id, roomId });
      res.json({ success: true });
    } catch (err: any) {
      if (err instanceof PersonChatAuthorizationError) {
        res.status(403).json({ success: false, message: err.message });
        return;
      }
      console.error("[personChat] markRead:", err);
      res.status(500).json({ success: false, message: "Failed to mark read" });
    }
  }

  /** POST /api/person-chat/push-register  body: { token, platform } */
  async registerPush(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const { token, platform } = req.body ?? {};
      if (typeof token !== "string" || typeof platform !== "string") {
        res.status(400).json({ success: false, message: "token and platform required" });
        return;
      }
      await personChatService.registerPushToken(user.id, token, platform);
      res.json({ success: true });
    } catch (err: any) {
      console.error("[personChat] registerPush:", err);
      res.status(500).json({ success: false, message: "Failed to register push token" });
    }
  }
}

export const personChatController = new PersonChatController();
