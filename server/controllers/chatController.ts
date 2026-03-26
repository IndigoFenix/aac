import type { Request, Response } from "express";
import { z } from "zod";
import { FeatureType, onMessage, type CurrentImage } from "../services/sessionService";
import { ChatPersona } from "@shared/schema";

// Validation schemas
// Message content can be a string or an object with text, formSchema, formValues
const messageContentSchema = z.union([
  z.string(),
  z.object({
    text: z.string(),
    formSchema: z.any().optional(),
    formValues: z.any().optional(),
  }),
]);

const messageSchema = z.object({
  studentId: z.string().optional(),
  sessionId: z.string().nullish(),  // Allow null, undefined, or string
  activeFeature: z.string().optional(),
  persona: z.string().optional(),
  featureContext: z.record(z.any()).optional(),
  vectorStoreId: z.string().optional(),
  images: z.array(z.string()).optional(),
  documents: z.array(z.object({ dataUrl: z.string(), filename: z.string() })).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant", "system"]),
        content: messageContentSchema,
        timestamp: z.number().optional(),
        metadata: z.record(z.any()).optional(),
      })
    )
    .optional(),
  replyType: z.enum(["text", "html", "md"]).optional(),
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

      // Handle multipart form data - parse JSON fields if they're strings
      let body = req.body;
      if (typeof body.messages === 'string') {
        body.messages = JSON.parse(body.messages);
      }
      if (typeof body.featureContext === 'string') {
        body.featureContext = JSON.parse(body.featureContext);
      }

      let { studentId, sessionId, activeFeature, persona, messages, featureContext, vectorStoreId, images, documents, replyType } = messageSchema.parse(body);
      if (!persona) {
        persona = "assistant";
      }

      // Handle uploaded image via multer (single image from legacy path)
      const imageFile = (req as any).file as Express.Multer.File | undefined;
      let currentImage: CurrentImage | undefined;
      if (imageFile) {
        currentImage = {
          data: imageFile.buffer,
          mimeType: imageFile.mimetype || 'image/jpeg',
        };
      }

      const messagesWithTimestamp = messages?.map((msg) => ({
        ...msg,
        timestamp: msg.timestamp || startTime,
      })) || [];
      const response = await onMessage({
        userId,
        studentId,
        sessionId: sessionId || undefined,
        activeFeature: activeFeature as FeatureType,
        persona: persona as ChatPersona,
        messages: messagesWithTimestamp,
        featureContext,
        vectorStoreId,
        images: images && images.length > 0 ? images : undefined,
        documents: documents && documents.length > 0 ? documents : undefined,
        replyType: replyType || "html",
        currentImage,
      })
      res.json(response);
    } catch (error: any) {
      console.error("[ChatController] Error:", error);
      res.status(500).json({
        error: "error:MESSAGE_FAILED",
        details: error.message || String(error),
      });
    }
  }
}

export const chatController = new ChatController();
