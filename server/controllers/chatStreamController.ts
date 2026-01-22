import type { Request, Response } from "express";
import { z } from "zod";
import { onMessageStreaming, FeatureType } from "../services/sessionService";
import { ChatPersona } from "@shared/schema";

// Validation schema - same as chatController
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
  sessionId: z.string().optional(),
  activeFeature: z.string().optional(),
  persona: z.string().optional(),
  featureContext: z.record(z.any()).optional(),
  vectorStoreId: z.string().optional(), // For file search support
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant", "system"]),
        content: messageContentSchema,
        timestamp: z.number().optional(),
      })
    )
    .optional(),
  replyType: z.enum(["text", "html"]).optional(),
});

/**
 * Helper to send SSE events
 */
function sendSSEEvent(res: Response, event: string, data: any): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Chat Stream Controller
 *
 * Handles streaming chat responses with real-time "thinking" updates.
 * Uses Server-Sent Events (SSE) to push updates to the client.
 */
export class ChatStreamController {
  async onMessage(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();

    try {
      const userId = req.user!.id;
      let { studentId, sessionId, activeFeature, persona, messages, featureContext, vectorStoreId, replyType } =
        messageSchema.parse(req.body);

      if (!persona) {
        persona = "assistant";
      }

      // Set up SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
      res.flushHeaders();

      // Thinking update callback - sends SSE events
      const onThinkingUpdate = (thinkingText: string) => {
        sendSSEEvent(res, "thinking", {
          text: thinkingText,
          timestamp: Date.now(),
        });
      };

      const messagesWithTimestamp =
        messages?.map((msg) => ({
          ...msg,
          timestamp: msg.timestamp || startTime,
        })) || [];

      // Process the message with streaming callback
      const response = await onMessageStreaming({
        userId,
        studentId,
        sessionId,
        activeFeature: activeFeature as FeatureType,
        persona: persona as ChatPersona,
        messages: messagesWithTimestamp,
        featureContext,
        vectorStoreId,
        replyType: replyType || "html",
        onThinkingUpdate,
      });

      // Send final response
      sendSSEEvent(res, "complete", response);

      // Send close event and end connection
      sendSSEEvent(res, "close", {});
      res.end();
    } catch (error: any) {
      console.error("ChatStreamController error:", error);

      // If headers already sent, send error as SSE event
      if (res.headersSent) {
        sendSSEEvent(res, "error", {
          error: error.message || "Failed to process message.",
        });
        res.end();
      } else {
        res.status(500).json({
          error: "Failed to process message.",
          details: error.message || String(error),
        });
      }
    }
  }
}

export const chatStreamController = new ChatStreamController();
