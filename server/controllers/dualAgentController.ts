// server/controllers/dualAgentController.ts
// Controller for the dual-agent AAC system

import type { Request, Response } from "express";
import { z } from "zod";
import { dualAgentService } from "../services/dual-agent";
import type { DualAgentInput } from "../services/dual-agent";

// Validation schemas
const initializeSchema = z.object({
  studentId: z.string(),
  sessionId: z.string().optional(),
  interactionMode: z.enum(['interact', 'silent']).optional(),
  imageData: z.string().optional(), // base64 data URL from camera
  gestureContext: z.string().optional(), // serialized face/hand gesture events
});

const identifiedPersonSchema = z.object({
  id: z.string(),
  type: z.enum(["student", "user"]),
  name: z.string(),
  relationship: z.string().optional(),
  confidence: z.number(),
  method: z.enum(["face", "voice", "both"]),
}).optional();

const messageSchema = z.object({
  studentId: z.string(),
  sessionId: z.string().optional(),
  message: z.string().optional(),
  language: z.string().optional(),
  board: z.any().optional(),
  visualContext: z.string().optional(),
  audioContext: z.string().optional(),
  gestureContext: z.string().optional(), // serialized face/hand gesture events
  imageData: z.string().optional(), // base64 data URL for camera input
  identifiedPerson: identifiedPersonSchema, // Person identified via biometrics
  interactionMode: z.enum(['interact', 'silent']).optional(),
});

const detectSchema = z.object({
  studentId: z.string(),
  sessionId: z.string().optional(),
  board: z.any().optional(),
  audioContext: z.string().optional(),
  gestureContext: z.string().optional(),
  interactionMode: z.enum(['interact', 'silent']).optional(),
});

const interpretSchema = z.object({
  studentId: z.string(),
  sessionId: z.string().optional(),
  recentButtons: z.array(z.string()).min(1),
  board: z.any().optional(),
});

/**
 * Helper to send SSE events
 */
function sendSSEEvent(res: Response, event: string, data: any): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Dual Agent Controller
 *
 * Handles API endpoints for the dual-agent AAC system:
 * - POST /api/aac/dual/initialize - Initialize a new session
 * - POST /api/aac/dual/message - Send a text message (SSE streaming)
 * - POST /api/aac/dual/voice - Send voice input (SSE streaming)
 */
export class DualAgentController {
  /**
   * POST /api/aac/dual/initialize
   * Initialize or resume a dual-agent session with greeting and initial board
   * Returns SSE stream with greeting text, board buttons, and audio
   */
  async initialize(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;

      // Parse JSON string fields from multipart form body
      const body = { ...req.body };
      if (typeof body.board === "string") {
        try { body.board = JSON.parse(body.board); } catch { /* leave as-is */ }
      }

      // Convert multer file buffer to base64 data URL
      const file = (req as any).file as Express.Multer.File | undefined;
      if (file) {
        const base64 = file.buffer.toString("base64");
        body.imageData = `data:${file.mimetype};base64,${base64}`;
      }

      const { studentId, sessionId, interactionMode, imageData, gestureContext } = initializeSchema.parse(body);

      console.log(
        `[DualAgentController] Initializing session for student: ${studentId} mode: ${interactionMode || 'interact'}${imageData ? " (with image)" : ""}${gestureContext ? " (with gestures)" : ""}`
      );

      // Set up SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      // Initialize with greeting and stream the response
      for await (const chunk of dualAgentService.initializeWithGreeting(
        studentId,
        userId,
        sessionId,
        undefined,
        interactionMode || 'interact',
        imageData,
        gestureContext
      )) {
        switch (chunk.type) {
          case "text":
            sendSSEEvent(res, "text", { chunk: chunk.data });
            break;
          case "board":
            sendSSEEvent(res, "board", { board: chunk.data });
            break;
          case "audio":
            sendSSEEvent(res, "audio", { chunk: chunk.data, format: "mp3" });
            break;
          case "interpretation":
            sendSSEEvent(res, "interpretation", { text: chunk.data });
            break;
          case "interpretation_audio":
            sendSSEEvent(res, "interpretation_audio", { chunk: chunk.data, format: "mp3" });
            break;
          case "debug":
            sendSSEEvent(res, "debug", { text: chunk.data });
            break;
          case "transcript":
            sendSSEEvent(res, "transcript", { text: chunk.data, speaker: chunk.speaker });
            break;
          case "context":
            sendSSEEvent(res, "context", { text: chunk.data });
            break;
          case "complete":
            sendSSEEvent(res, "complete", chunk.data);
            break;
        }
      }

      res.end();
    } catch (error: any) {
      console.error("[DualAgentController] Initialize error:", error);

      if (res.headersSent) {
        sendSSEEvent(res, "error", {
          error: error.message || "Failed to initialize session",
        });
        res.end();
      } else {
        res.status(500).json({
          error: "Failed to initialize session",
          details: error.message || String(error),
        });
      }
    }
  }

  /**
   * POST /api/aac/dual/message
   * Send a text message and receive streaming response
   */
  async message(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;

      // Parse JSON string fields from multipart form body
      const body = { ...req.body };
      if (typeof body.board === "string") {
        try { body.board = JSON.parse(body.board); } catch { /* leave as-is */ }
      }
      if (typeof body.identifiedPerson === "string") {
        try { body.identifiedPerson = JSON.parse(body.identifiedPerson); } catch { /* leave as-is */ }
      }

      // Convert multer file buffer to base64 data URL
      const file = (req as any).file as Express.Multer.File | undefined;
      if (file) {
        const base64 = file.buffer.toString("base64");
        body.imageData = `data:${file.mimetype};base64,${base64}`;
      }

      const {
        studentId,
        sessionId,
        message,
        language,
        board,
        visualContext,
        audioContext,
        gestureContext,
        imageData,
        identifiedPerson,
        interactionMode,
      } = messageSchema.parse(body);

      if (!message?.trim()) {
        res.status(400).json({ error: "Message is required" });
        return;
      }

      console.log(
        `[DualAgentController] Message from student ${studentId}: "${message.substring(0, 50)}..."${interactionMode === 'silent' ? " [SILENT]" : ""}${imageData ? " (with image)" : ""}${identifiedPerson ? ` (person: ${identifiedPerson.name})` : ""}${gestureContext ? " (with gestures)" : ""}`
      );

      // Set up SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      const input: DualAgentInput = {
        sessionId,
        studentId,
        userId,
        message,
        language,
        board,
        visualContext,
        audioContext,
        gestureContext,
        imageData,
        identifiedPerson,
        interactionMode,
      };

      // Process and stream response
      for await (const chunk of dualAgentService.processInput(input)) {
        switch (chunk.type) {
          case "text":
            sendSSEEvent(res, "text", { chunk: chunk.data });
            break;
          case "board":
            sendSSEEvent(res, "board", { board: chunk.data });
            break;
          case "audio":
            sendSSEEvent(res, "audio", { chunk: chunk.data, format: "mp3" });
            break;
          case "transcription":
            sendSSEEvent(res, "transcription", chunk.data);
            break;
          case "interpretation":
            sendSSEEvent(res, "interpretation", { text: chunk.data });
            break;
          case "interpretation_audio":
            sendSSEEvent(res, "interpretation_audio", { chunk: chunk.data, format: "mp3" });
            break;
          case "debug":
            sendSSEEvent(res, "debug", { text: chunk.data });
            break;
          case "transcript":
            sendSSEEvent(res, "transcript", { text: chunk.data, speaker: chunk.speaker });
            break;
          case "context":
            sendSSEEvent(res, "context", { text: chunk.data });
            break;
          case "complete":
            sendSSEEvent(res, "complete", chunk.data);
            break;
        }
      }

      res.end();
    } catch (error: any) {
      console.error("[DualAgentController] Message error:", error);

      if (res.headersSent) {
        sendSSEEvent(res, "error", {
          error: error.message || "Failed to process message",
        });
        res.end();
      } else {
        res.status(500).json({
          error: "Failed to process message",
          details: error.message || String(error),
        });
      }
    }
  }

  /**
   * POST /api/aac/dual/voice
   * Send voice input and receive streaming response
   */
  async voice(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      const audioFile = (req as any).file as Express.Multer.File | undefined;

      if (!audioFile) {
        res.status(400).json({ error: "No audio file provided" });
        return;
      }

      // Parse body fields (handle multipart form data)
      let body = req.body;
      if (typeof body.board === "string") {
        try {
          body.board = JSON.parse(body.board);
        } catch {
          body.board = undefined;
        }
      }
      if (typeof body.identifiedPerson === "string") {
        try {
          body.identifiedPerson = JSON.parse(body.identifiedPerson);
        } catch {
          body.identifiedPerson = undefined;
        }
      }

      const { studentId, sessionId, language, board, visualContext, audioContext, gestureContext, imageData, identifiedPerson, interactionMode } =
        messageSchema.parse(body);

      console.log(
        `[DualAgentController] Voice input: ${audioFile.size} bytes, student: ${studentId}${imageData ? " (with image)" : ""}${identifiedPerson ? ` (person: ${identifiedPerson.name})` : ""}${gestureContext ? " (with gestures)" : ""}`
      );

      // Set up SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      const input: DualAgentInput = {
        sessionId,
        studentId,
        userId,
        audioBlob: audioFile.buffer,
        language,
        board,
        visualContext,
        audioContext,
        gestureContext,
        imageData,
        identifiedPerson,
        interactionMode,
      };

      // Process and stream response
      for await (const chunk of dualAgentService.processInput(input)) {
        switch (chunk.type) {
          case "text":
            sendSSEEvent(res, "text", { chunk: chunk.data });
            break;
          case "board":
            sendSSEEvent(res, "board", { board: chunk.data });
            break;
          case "audio":
            sendSSEEvent(res, "audio", { chunk: chunk.data, format: "mp3" });
            break;
          case "transcription":
            sendSSEEvent(res, "transcription", chunk.data);
            break;
          case "interpretation":
            sendSSEEvent(res, "interpretation", { text: chunk.data });
            break;
          case "interpretation_audio":
            sendSSEEvent(res, "interpretation_audio", { chunk: chunk.data, format: "mp3" });
            break;
          case "debug":
            sendSSEEvent(res, "debug", { text: chunk.data });
            break;
          case "transcript":
            sendSSEEvent(res, "transcript", { text: chunk.data, speaker: chunk.speaker });
            break;
          case "context":
            sendSSEEvent(res, "context", { text: chunk.data });
            break;
          case "complete":
            sendSSEEvent(res, "complete", chunk.data);
            break;
        }
      }

      res.end();
    } catch (error: any) {
      console.error("[DualAgentController] Voice error:", error);

      if (res.headersSent) {
        sendSSEEvent(res, "error", {
          error: error.message || "Failed to process voice input",
        });
        res.end();
      } else {
        res.status(500).json({
          error: "Failed to process voice input",
          details: error.message || String(error),
        });
      }
    }
  }

  /**
   * GET /api/aac/dual/session/:sessionId
   * Get current session state
   */
  async getSession(req: Request, res: Response): Promise<void> {
    try {
      const { sessionId } = req.params;
      const { studentId } = req.query;

      if (!studentId || typeof studentId !== "string") {
        res.status(400).json({ error: "studentId is required" });
        return;
      }

      const state = await dualAgentService.initializeSession(
        studentId,
        req.user?.id,
        sessionId
      );

      res.json({
        sessionId: state.sessionId,
        thinkingMode: state.thinkingMode,
        monitorBusy: state.monitorBusy,
        messageCount: state.messages.length,
        pendingCount: state.pendingMessages.length,
      });
    } catch (error: any) {
      console.error("[DualAgentController] GetSession error:", error);
      res.status(500).json({
        error: "Failed to get session",
        details: error.message || String(error),
      });
    }
  }
  /**
   * POST /api/aac/dual/interpret
   * Synthesize recent button presses into a spoken sentence
   * Returns SSE stream with text + audio
   */
  async interpret(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      const { studentId, sessionId, recentButtons, board } = interpretSchema.parse(req.body);

      console.log(
        `[DualAgentController] Interpret ${recentButtons.length} buttons for student ${studentId}`
      );

      // Set up SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      for await (const chunk of dualAgentService.interpretButtonPresses(
        sessionId,
        studentId,
        userId,
        recentButtons,
        board
      )) {
        switch (chunk.type) {
          case "text":
            sendSSEEvent(res, "text", { chunk: chunk.data });
            break;
          case "audio":
            sendSSEEvent(res, "audio", { chunk: chunk.data, format: "mp3" });
            break;
          case "complete":
            sendSSEEvent(res, "complete", chunk.data);
            break;
        }
      }

      res.end();
    } catch (error: any) {
      console.error("[DualAgentController] Interpret error:", error);

      if (res.headersSent) {
        sendSSEEvent(res, "error", {
          error: error.message || "Failed to interpret buttons",
        });
        res.end();
      } else {
        res.status(500).json({
          error: "Failed to interpret buttons",
          details: error.message || String(error),
        });
      }
    }
  }
  /**
   * POST /api/aac/dual/detect
   * Continuous detection — send camera frame, get updated board if environment changed.
   * Returns SSE stream for unified handling with message/voice endpoints.
   */
  async detect(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;

      // Parse JSON string fields from multipart form body
      const body = { ...req.body };
      if (typeof body.board === "string") {
        try { body.board = JSON.parse(body.board); } catch { /* leave as-is */ }
      }

      // Extract files from multer.fields()
      const files = (req as any).files as { [fieldname: string]: Express.Multer.File[] } | undefined;
      const imageFile = files?.image?.[0];
      const audioFile = files?.audio?.[0];

      // Convert image to base64 data URL
      let imageData: string | undefined;
      if (imageFile) {
        const base64 = imageFile.buffer.toString("base64");
        imageData = `data:${imageFile.mimetype};base64,${base64}`;
      }

      // Extract raw audio buffer + mimetype
      let audioBuffer: Buffer | undefined;
      let audioMimeType: string | undefined;
      if (audioFile) {
        audioBuffer = audioFile.buffer;
        audioMimeType = audioFile.mimetype;
      }

      const { studentId, sessionId, board, audioContext, gestureContext, interactionMode } = detectSchema.parse(body);

      console.log(
        `[DualAgentController] Detect for student ${studentId}${imageData ? " (with image)" : ""}${audioBuffer ? " (with audio)" : ""}${gestureContext ? " (with gestures)" : ""} mode: ${interactionMode || "interact"}`
      );

      // Set up SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      // Process and stream response
      for await (const chunk of dualAgentService.processDetectionStream({
        sessionId,
        studentId,
        userId,
        imageData,
        audioContext,
        audioBuffer,
        audioMimeType,
        gestureContext,
        board,
        interactionMode,
      })) {
        switch (chunk.type) {
          case "text":
            sendSSEEvent(res, "text", { chunk: chunk.data });
            break;
          case "board_patch":
            sendSSEEvent(res, "board_patch", chunk.data);
            break;
          case "audio":
            sendSSEEvent(res, "audio", { chunk: chunk.data, format: "mp3" });
            break;
          case "interpretation":
            sendSSEEvent(res, "interpretation", { text: chunk.data });
            break;
          case "interpretation_audio":
            sendSSEEvent(res, "interpretation_audio", { chunk: chunk.data, format: "mp3" });
            break;
          case "debug":
            sendSSEEvent(res, "debug", { text: chunk.data });
            break;
          case "transcript":
            sendSSEEvent(res, "transcript", { text: chunk.data, speaker: chunk.speaker });
            break;
          case "context":
            sendSSEEvent(res, "context", { text: chunk.data });
            break;
          case "complete":
            sendSSEEvent(res, "complete", chunk.data);
            break;
        }
      }

      res.end();
    } catch (error: any) {
      console.error("[DualAgentController] Detect error:", error);

      if (res.headersSent) {
        sendSSEEvent(res, "error", {
          error: error.message || "Failed to process detection",
        });
        res.end();
      } else {
        res.status(500).json({
          error: "Failed to process detection",
          details: error.message || String(error),
        });
      }
    }
  }
}

export const dualAgentController = new DualAgentController();
