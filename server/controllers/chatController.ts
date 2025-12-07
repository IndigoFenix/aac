import type { Request, Response } from "express";
import { z } from "zod";
import { onMessage } from "../services/sessionService";

// Validation schemas
const messageSchema = z.object({
  aacUserId: z.string().optional(),
  sessionId: z.string().optional(),
  mode: z.enum(["none", "board", "interpret"]).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant", "system"]),
        content: z.string(),
        timestamp: z.number().optional(),
      })
    )
    .optional(),
  replyType: z.enum(["text", "html"]).optional(),
});

/*
export interface ChatMessageContent {
  text?: string;
  html?: string;
  setValues?: { [key: string]: any }[];
  formSchema?: any;
  formValues?: any;
  attachments?: any[];
}

export interface ChatMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  timestamp: number;
  content?: string | ChatMessageContent;
  toolCalls?: any[];
  toolCallId?: string;
  credits?: number;
  userId?: string;
  turnId?: string;
  metadata?: { [key: string]: any };
  error?: string;
}
*/

export class ChatController {
  async onMessage(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    try {
      const userId = req.user!.id;
      const { aacUserId, sessionId, mode, messages } = messageSchema.parse(req.body);
      const messagesWithTimestamp = messages?.map((msg) => ({
        ...msg,
        timestamp: msg.timestamp || startTime,
      })) || [];
      const response = await onMessage({
        userId,
        aacUserId,
        sessionId,
        mode,
        messages: messagesWithTimestamp,
        replyType: "text"
      })
      res.json(response);
    } catch (error: any) {
      res.status(500).json({
        error: "Failed to process message.",
        details: error.message || String(error),
      });
    }
  }
}

export const chatController = new ChatController();
