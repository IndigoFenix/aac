// server/controllers/voiceController.ts
// Voice API controller for STT, TTS, and voice chat

import type { Request, Response } from "express";
import { z } from "zod";
import { whisperService } from "../services/voice/whisper-service";
import { openaiTtsService, VoiceType } from "../services/voice/openai-tts-service";
import { onMessage, FeatureType } from "../services/sessionService";
import { studentRepository } from "../repositories";
import { ChatPersona } from "@shared/schema";

// Validation schemas
const transcribeSchema = z.object({
  languageHint: z.string().optional(),
});

const speakSchema = z.object({
  text: z.string().min(1),
  studentId: z.string().optional(),
  language: z.string().optional(),
  voiceType: z.enum(["man", "woman", "boy", "girl"]).optional(),
});

const voiceChatSchema = z.object({
  studentId: z.string().optional(),
  sessionId: z.string().nullish(),
  featureContext: z.record(z.any()).optional(),
  languageHint: z.string().optional(),
  formSchema: z.any().optional(),
  formValues: z.any().optional(),
});

/**
 * Helper to send SSE events
 */
function sendSSEEvent(res: Response, event: string, data: any): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Voice Controller
 *
 * Handles voice-related API endpoints:
 * - POST /api/aac/voice/transcribe - Speech-to-text only
 * - POST /api/aac/voice/speak - Text-to-speech only (streaming)
 * - POST /api/aac/voice/chat - Full voice chat (audio in → text + audio out)
 */
export class VoiceController {
  /**
   * POST /api/aac/voice/transcribe
   * Convert audio to text using Whisper
   *
   * Input: Audio file (multipart/form-data), optional languageHint
   * Output: { text: string, language: string }
   */
  async transcribe(req: Request, res: Response): Promise<void> {
    try {
      const audioFile = (req as any).file as Express.Multer.File | undefined;
      if (!audioFile) {
        res.status(400).json({ error: "No audio file provided" });
        return;
      }

      // Parse body fields
      const { languageHint } = transcribeSchema.parse(req.body);

      console.log(
        `[VoiceController] Transcribing audio: ${audioFile.size} bytes, type: ${audioFile.mimetype}`
      );

      const result = await whisperService.transcribe(
        audioFile.buffer,
        audioFile.mimetype,
        { languageHint }
      );

      res.json({
        text: result.text,
        language: result.language,
        duration: result.duration,
      });
    } catch (error: any) {
      console.error("[VoiceController] Transcription error:", error);
      res.status(500).json({
        error: "Failed to transcribe audio",
        details: error.message || String(error),
      });
    }
  }

  /**
   * POST /api/aac/voice/synthesize
   * Convert text to speech using Google TTS (returns audio blob directly)
   *
   * Input: { text, studentId?, language?, voiceType? }
   * Output: audio/mpeg blob
   */
  async synthesize(req: Request, res: Response): Promise<void> {
    try {
      const { text, studentId, language, voiceType } = speakSchema.parse(req.body);

      // Get voice settings from student if provided
      let finalLanguage = language || "en";
      let finalVoiceType: VoiceType = (voiceType as VoiceType) || "woman";

      if (studentId) {
        const student = await studentRepository.getStudentById(studentId);
        if (student) {
          finalLanguage = language || student.primaryLanguage || "en";
          finalVoiceType = (voiceType || student.aacVoiceType || "woman") as VoiceType;
        }
      }

      console.log(
        `[VoiceController] Synthesizing: "${text.substring(0, 50)}..." (lang: ${finalLanguage}, voice: ${finalVoiceType})`
      );

      // Synthesize full audio (not streaming)
      const audioBuffer = await openaiTtsService.synthesize(
        text,
        finalLanguage,
        { voiceType: finalVoiceType }
      );

      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Length", audioBuffer.length.toString());
      res.send(audioBuffer);
    } catch (error: any) {
      console.error("[VoiceController] TTS error:", error);
      res.status(500).json({
        error: "Failed to synthesize speech",
        details: error.message || String(error),
      });
    }
  }

  /**
   * POST /api/aac/voice/speak
   * Convert text to speech using Google TTS (streaming)
   *
   * Input: { text, studentId?, language?, voiceType? }
   * Output: SSE stream of audio chunks
   */
  async speak(req: Request, res: Response): Promise<void> {
    try {
      const { text, studentId, language, voiceType } = speakSchema.parse(req.body);

      // Get voice settings from student if provided
      let finalLanguage = language || "en";
      let finalVoiceType: VoiceType = (voiceType as VoiceType) || "woman";

      if (studentId) {
        const student = await studentRepository.getStudentById(studentId);
        if (student) {
          finalLanguage = language || student.primaryLanguage || "en";
          finalVoiceType = (voiceType || student.aacVoiceType || "woman") as VoiceType;
        }
      }

      console.log(
        `[VoiceController] Speaking: "${text.substring(0, 50)}..." (lang: ${finalLanguage}, voice: ${finalVoiceType})`
      );

      // Set up SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      // Stream audio chunks
      for await (const audioChunk of openaiTtsService.synthesizeStream(
        text,
        finalLanguage,
        { voiceType: finalVoiceType }
      )) {
        sendSSEEvent(res, "audio", {
          chunk: audioChunk.toString("base64"),
          format: "mp3",
        });
      }

      sendSSEEvent(res, "complete", { success: true });
      res.end();
    } catch (error: any) {
      console.error("[VoiceController] TTS error:", error);

      if (res.headersSent) {
        sendSSEEvent(res, "error", {
          error: error.message || "Failed to synthesize speech",
        });
        res.end();
      } else {
        res.status(500).json({
          error: "Failed to synthesize speech",
          details: error.message || String(error),
        });
      }
    }
  }

  /**
   * POST /api/aac/voice/chat
   * Full voice chat: audio in → transcription + AI response + audio out
   *
   * Input: Audio file (multipart), studentId, sessionId
   * Output: SSE stream with transcription, text chunks, audio chunks, board data
   */
  async voiceChat(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();

    try {
      const userId = req.user!.id;
      const audioFile = (req as any).file as Express.Multer.File | undefined;

      if (!audioFile) {
        res.status(400).json({ error: "No audio file provided" });
        return;
      }

      // Parse body fields - handle multipart form data
      let body = req.body;
      if (typeof body.featureContext === "string") {
        body.featureContext = JSON.parse(body.featureContext);
      }
      if (typeof body.formSchema === "string") {
        body.formSchema = JSON.parse(body.formSchema);
      }
      if (typeof body.formValues === "string") {
        body.formValues = JSON.parse(body.formValues);
      }

      const { studentId, sessionId, featureContext, languageHint, formSchema, formValues } =
        voiceChatSchema.parse(body);

      console.log(
        `[VoiceController] Voice chat: ${audioFile.size} bytes, student: ${studentId}`
      );

      // Set up SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      // 1. Transcribe audio
      const transcription = await whisperService.transcribe(
        audioFile.buffer,
        audioFile.mimetype,
        { languageHint }
      );

      sendSSEEvent(res, "transcription", {
        text: transcription.text,
        language: transcription.language,
      });

      if (!transcription.text.trim()) {
        sendSSEEvent(res, "error", { error: "No speech detected" });
        sendSSEEvent(res, "complete", { sessionId: null });
        res.end();
        return;
      }

      // 2. Build message content with form schema/values (like regular chat)
      const messageContent = formSchema || formValues
        ? {
            text: transcription.text,
            formSchema,
            formValues,
          }
        : transcription.text;

      // 3. Get AI response using existing chat system
      const chatResponse = await onMessage({
        userId,
        studentId,
        sessionId: sessionId || undefined,
        activeFeature: "aac" as FeatureType,
        persona: "aac-assistant" as ChatPersona,
        messages: [
          {
            role: "user",
            content: messageContent,
            timestamp: startTime,
          },
        ],
        featureContext,
        replyType: "text",
      });

      // Extract response text (can be string, {text}, or {html})
      const responseContent = chatResponse.message?.content;
      let responseText = "";
      let setValues: any = undefined;

      if (typeof responseContent === "string") {
        responseText = responseContent;
      } else if (responseContent) {
        responseText = responseContent.html || responseContent.text || "";
        setValues = responseContent.setValues;
      }

      // Send text response
      sendSSEEvent(res, "text", { chunk: responseText });

      // Send setValues for board updates if present
      // Note: We don't send a "board" event - contextData.board is the ORIGINAL board,
      // and setValues is the mechanism for updates. The frontend applies setValues via applySetValuesToBoard.
      if (setValues) {
        sendSSEEvent(res, "setValues", { setValues });
      }

      // 3. Get voice settings from student
      let language = transcription.language || "en";
      let voiceType: VoiceType = "woman";

      if (studentId) {
        const student = await studentRepository.getStudentById(studentId);
        if (student) {
          language = student.primaryLanguage || language;
          voiceType = (student.aacVoiceType as VoiceType) || "woman";
        }
      }

      // 4. Stream audio response (wrapped in try-catch so TTS failure doesn't break the flow)
      if (responseText.trim()) {
        try {
          for await (const audioChunk of openaiTtsService.synthesizeStream(
            responseText,
            language,
            { voiceType }
          )) {
            sendSSEEvent(res, "audio", {
              chunk: audioChunk.toString("base64"),
              format: "mp3",
            });
          }
        } catch (ttsError: any) {
          console.error("[VoiceController] TTS error (non-fatal):", ttsError.message);
          sendSSEEvent(res, "ttsError", {
            error: ttsError.message || "Text-to-speech failed",
          });
          // Continue - we still want to send complete with the text
        }
      }

      // 5. Send completion (always, even if TTS failed)
      sendSSEEvent(res, "complete", {
        sessionId: chatResponse.sessionId,
        fullText: responseText,
      });

      res.end();
    } catch (error: any) {
      console.error("[VoiceController] Voice chat error:", error);

      if (res.headersSent) {
        sendSSEEvent(res, "error", {
          error: error.message || "Failed to process voice chat",
        });
        // Still try to send complete so frontend can show what we have
        sendSSEEvent(res, "complete", { sessionId: null, fullText: "" });
        res.end();
      } else {
        res.status(500).json({
          error: "Failed to process voice chat",
          details: error.message || String(error),
        });
      }
    }
  }
}

export const voiceController = new VoiceController();
