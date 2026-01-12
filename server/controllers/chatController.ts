import type { Request, Response } from "express";
import { z } from "zod";
import { FeatureType, onMessage } from "../services/sessionService";
import { ChatPersona } from "@shared/schema";

// Validation schemas
const messageSchema = z.object({
  studentId: z.string().optional(),
  sessionId: z.string().optional(),
  activeFeature: z.string().optional(),
  persona: z.string().optional(),
  featureContext: z.record(z.any()).optional(),
  vectorStoreId: z.string().optional(), // For file search support
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
      let { studentId, sessionId, activeFeature, persona, messages, featureContext, vectorStoreId } = messageSchema.parse(req.body);
      if (!persona) {
        persona = "assistant";
      }
      const messagesWithTimestamp = messages?.map((msg) => ({
        ...msg,
        timestamp: msg.timestamp || startTime,
      })) || [];
      const response = await onMessage({
        userId,
        studentId,
        sessionId,
        activeFeature: activeFeature as FeatureType,
        persona: persona as ChatPersona,
        messages: messagesWithTimestamp,
        featureContext,
        vectorStoreId,
        replyType: "html"
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
