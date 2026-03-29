import type { Request, Response } from "express";
import { z } from "zod";
import { onMessageStreaming, onMessageMdStreaming, FeatureType } from "../services/sessionService";
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
  instituteId: z.string().optional(),
  sessionId: z.string().optional(),
  activeFeature: z.string().optional(),
  persona: z.string().optional(),
  featureContext: z.record(z.any()).optional(),
  vectorStoreId: z.string().optional(),
  images: z.array(z.string()).optional(),
  documents: z.array(z.object({ dataUrl: z.string(), filename: z.string(), extractedText: z.string().optional() })).optional(),
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
      let { studentId, instituteId, sessionId, activeFeature, persona, messages, featureContext, vectorStoreId, images, documents, replyType } =
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

      // Navigation callback - sends SSE events for immediate panel navigation
      const onNavigate = (feature: string) => {
        sendSSEEvent(res, "navigate", {
          feature,
          timestamp: Date.now(),
        });
      };

      // Student selection callback - sends SSE events for immediate student switching
      const onSelectStudent = (studentId: string) => {
        sendSSEEvent(res, "select_student", {
          studentId,
          timestamp: Date.now(),
        });
      };

      const messagesWithTimestamp =
        messages?.map((msg) => ({
          ...msg,
          timestamp: msg.timestamp || startTime,
        })) || [];

      if (replyType === "md") {
        // Markdown streaming mode — token-by-token text_delta events
        const abortController = new AbortController();

        // Abort when client disconnects (e.g. user clicks stop, navigates away)
        const onClose = () => abortController.abort();
        req.on("close", onClose);

        try {
          const stream = onMessageMdStreaming({
            userId,
            studentId,
            instituteId,
            sessionId,
            activeFeature: activeFeature as FeatureType,
            persona: persona as ChatPersona,
            messages: messagesWithTimestamp,
            featureContext,
            vectorStoreId,
            images: images && images.length > 0 ? images : undefined,
            documents: documents && documents.length > 0 ? documents : undefined,
            replyType: "md",
            onThinkingUpdate,
            onNavigate,
            onSelectStudent,
            signal: abortController.signal,
          });

          for await (const event of stream) {
            if (res.writableEnded) break;
            if (event.type === "complete") {
              // Strip memoryValues from the SSE payload — it's redundant with
              // contextData and can be very large (full board + student data),
              // causing chunk-boundary issues with proxies like CloudFront.
              const { memoryValues, ...slimEvent } = event as any;
              sendSSEEvent(res, event.type, slimEvent);
            } else {
              sendSSEEvent(res, event.type, event);
            }
          }

          if (!res.writableEnded) {
            sendSSEEvent(res, "close", {});
            res.end();
          }
        } finally {
          req.off("close", onClose);
        }
      } else {
        // Existing path: structured JSON response with thinking updates
        const response = await onMessageStreaming({
          userId,
          studentId,
          instituteId,
          sessionId,
          activeFeature: activeFeature as FeatureType,
          persona: persona as ChatPersona,
          messages: messagesWithTimestamp,
          featureContext,
          vectorStoreId,
          images,
          documents,
          replyType: replyType || "html",
          onThinkingUpdate,
          onNavigate,
          onSelectStudent,
        });

        // Send final response (strip memoryValues to reduce payload size)
        const { memoryValues, ...slimResponse } = response as any;
        sendSSEEvent(res, "complete", slimResponse);

        // Send close event and end connection
        sendSSEEvent(res, "close", {});
        res.end();
      }
    } catch (error: any) {
      console.error("ChatStreamController error:", error);

      // If headers already sent, send error as SSE event
      if (res.headersSent) {
        sendSSEEvent(res, "error", {
          error: "error:MESSAGE_FAILED",
        });
        res.end();
      } else {
        res.status(500).json({
          error: "error:MESSAGE_FAILED",
          details: error.message || String(error),
        });
      }
    }
  }
}

export const chatStreamController = new ChatStreamController();
