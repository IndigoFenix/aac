// server/controllers/videoCaptionController.ts
// Endpoints for the Video Caption Studio (clinician client). v1 exposes the
// text→glyph conversion; video upload/export happen client-side.

import type { Request, Response } from "express";
import { z } from "zod";
import { creditService } from "../services";
import { convertCaptionsToGlyphs } from "../services/captionGlyphService";

// A caption segment as sent by the client (parsed from SRT/VTT there).
const segmentSchema = z.object({
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  text: z.string(),
});

const convertRequestSchema = z.object({
  segments: z.array(segmentSchema).min(1).max(2000),
  language: z.string().max(32).optional(),
  studentId: z.string().uuid().nullable().optional(),
});

export class VideoCaptionController {
  /**
   * POST /api/video-caption/glyphs
   * Convert caption segments into glyph SENTENCEs, keyed back to each segment
   * by array position. Returns the segments echoed with a `glyph` field (empty
   * string where the model produced nothing usable).
   */
  async convertGlyphs(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      if (currentUser) {
        const { hasCredits, credits } = await creditService.validateCredits(currentUser.id);
        if (!hasCredits) {
          res.status(402).json({
            success: false,
            message: `You have ${credits} credits remaining. Please upgrade your plan to continue using the service.`,
            errorType: "insufficient_credits",
          });
          return;
        }
      }

      const parsed = convertRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid request", errors: parsed.error.flatten() });
        return;
      }
      const { segments, language, studentId } = parsed.data;

      // Index by array position so the client can zip the glyphs back onto its
      // ordered segment list regardless of which lines the model returns.
      const captions = segments.map((s, index) => ({ index, text: s.text }));

      const results = await convertCaptionsToGlyphs(captions, {
        language,
        studentId: studentId ?? null,
        userId: currentUser?.id ?? null,
      });

      const glyphByIndex = new Map(results.map((r) => [r.index, r.glyph]));
      const out = segments.map((s, index) => ({
        startMs: s.startMs,
        endMs: s.endMs,
        text: s.text,
        glyph: glyphByIndex.get(index) ?? "",
      }));

      res.json({ success: true, segments: out });
    } catch (error) {
      console.error("[VideoCaptionController] convertGlyphs error:", error);
      res.status(500).json({ success: false, message: "Failed to convert captions to glyphs" });
    }
  }
}

export const videoCaptionController = new VideoCaptionController();
