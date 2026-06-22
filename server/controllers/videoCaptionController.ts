// server/controllers/videoCaptionController.ts
// Endpoints for the Video Caption Studio (clinician client). v1 exposes the
// text→glyph conversion; video upload/export happen client-side.

import type { Request, Response } from "express";
import { z } from "zod";
import { creditService } from "../services";
import { convertCaptionsToGlyphs } from "../services/captionGlyphService";
import { extractCaptionIdeas } from "../services/captionIdeaService";
import { resolveCaptionPalette } from "../services/captionPalette";
import { queueSymbolGeneration } from "../services/symbol/auto-symbol-service";
import { googleSttService } from "../services/voice/google-stt-service";
import { chargeCaptionSttUsage, type CaptionCostContext } from "../services/captionCost";

/** Approx audio seconds for a mono 16-bit LINEAR16 WAV (header is negligible). */
function wavSeconds(buffer: Buffer, sampleRate?: number): number {
  const rate = sampleRate && sampleRate > 0 ? sampleRate : 16000;
  return Math.max(0, (buffer.length - 44) / (rate * 2));
}

/** Build the caption cost-attribution context from a multipart request body. */
function captionCostCtxFromBody(
  req: Request,
  currentUser: any,
  label: string,
): CaptionCostContext {
  const str = (k: string) => (typeof req.body?.[k] === "string" && req.body[k] ? req.body[k] : null);
  return {
    userId: currentUser?.id ?? null,
    studentId: str("studentId"),
    instituteId: str("instituteId"),
    sessionId: str("sessionId"),
    videoHash: str("videoHash"),
    label,
    category: "video-caption",
  };
}

/** Pull bare `generate:<key>` keys out of glyph SENTENCE strings (deduped). */
function collectGenerateKeys(glyphs: string[]): string[] {
  const keys = new Set<string>();
  for (const g of glyphs) {
    const re = /generate:([A-Za-z0-9_]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(g)) !== null) keys.add(m[1].toLowerCase());
  }
  return Array.from(keys);
}
import { captionProjectRepository } from "../repositories/captionProjectRepository";

// SHA-256 hex — the video content hash used as the project key.
const videoHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

const projectSegmentSchema = z.object({
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  text: z.string(),
  glyph: z.string().optional(),
  fallback: z.string().optional(),
});

const saveProjectSchema = z.object({
  videoName: z.string().max(512).nullable().optional(),
  language: z.string().max(32).nullable().optional(),
  segments: z.array(projectSegmentSchema).max(5000),
});

// A caption segment as sent by the client (parsed from SRT/VTT there, or
// transcribed via STT — which also carries per-word timings).
const wordSchema = z.object({
  text: z.string(),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
});
const segmentSchema = z.object({
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  text: z.string(),
  // STT path only — lets the idea pass split on real word boundaries.
  words: z.array(wordSchema).max(200).optional(),
});

const convertRequestSchema = z.object({
  segments: z.array(segmentSchema).min(1).max(2000),
  language: z.string().max(32).optional(),
  customInstructions: z.string().max(4000).optional(),
  studentId: z.string().uuid().nullable().optional(),
  instituteId: z.string().uuid().nullable().optional(),
  videoHash: videoHashSchema.optional(),
  sessionId: z.string().uuid().nullable().optional(),
});

const ideasRequestSchema = z.object({
  segments: z.array(segmentSchema).min(1).max(2000),
  language: z.string().max(32).optional(),
  customInstructions: z.string().max(4000).optional(),
  studentId: z.string().uuid().nullable().optional(),
  instituteId: z.string().uuid().nullable().optional(),
  videoHash: videoHashSchema.optional(),
  sessionId: z.string().uuid().nullable().optional(),
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
      const { segments, language, customInstructions, studentId, instituteId, videoHash, sessionId } = parsed.data;

      // Resolve the per-context glyph palette (custom symbols + known people) so
      // the AI can reference symbol:<id> / face:<id> like the board editor.
      const palette = await resolveCaptionPalette({ studentId, instituteId });

      // Index by array position so the client can zip the glyphs back onto its
      // ordered segment list regardless of which lines the model returns.
      const captions = segments.map((s, index) => ({ index, text: s.text }));

      const results = await convertCaptionsToGlyphs(captions, {
        language,
        customInstructions,
        customSymbols: palette.customSymbols,
        knownPeople: palette.knownPeople,
        studentId: studentId ?? null,
        userId: currentUser?.id ?? null,
        instituteId: instituteId ?? null,
        sessionId: sessionId ?? null,
        videoHash: videoHash ?? null,
      });

      const byIndex = new Map(results.map((r) => [r.index, r]));
      const out = segments.map((s, index) => {
        const r = byIndex.get(index);
        return {
          startMs: s.startMs,
          endMs: s.endMs,
          text: s.text,
          glyph: r?.glyph ?? "",
          fallback: r?.fallback ?? "",
        };
      });

      // Kick off background image generation for any `generate:<key>` the AI
      // emitted. queueSymbolGeneration is idempotent (reuses existing symbols)
      // and fire-and-forget; the client watches /api/custom-symbols/watch and
      // swaps each fallback for the real image as it lands.
      const generateKeys = collectGenerateKeys(out.map((o) => o.glyph));
      if (generateKeys.length > 0) {
        queueSymbolGeneration(generateKeys, undefined, {
          studentId: studentId ?? undefined,
          userId: currentUser?.id ?? undefined,
        });
      }

      res.json({ success: true, segments: out, generateKeys });
    } catch (error) {
      console.error("[VideoCaptionController] convertGlyphs error:", error);
      res.status(500).json({ success: false, message: "Failed to convert captions to glyphs" });
    }
  }

  /**
   * POST /api/video-caption/ideas
   * First pass: re-segment a timed transcript into caption-sized IDEA units
   * (meaning, not literal words), keyed to timestamps. Returns segments in the
   * same {startMs,endMs,text} shape, where text is the idea.
   */
  async extractIdeas(req: Request, res: Response): Promise<void> {
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

      const parsed = ideasRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid request", errors: parsed.error.flatten() });
        return;
      }
      const { segments, language, customInstructions, studentId, instituteId, videoHash, sessionId } = parsed.data;

      const ideas = await extractCaptionIdeas(segments, {
        language,
        customInstructions,
        studentId: studentId ?? null,
        userId: currentUser?.id ?? null,
        instituteId: instituteId ?? null,
        sessionId: sessionId ?? null,
        videoHash: videoHash ?? null,
      });

      // Fall back to the original lines if the model produced nothing usable,
      // so the pipeline never strands the user with an empty transcript.
      res.json({ success: true, segments: ideas.length > 0 ? ideas : segments });
    } catch (error) {
      console.error("[VideoCaptionController] extractIdeas error:", error);
      res.status(500).json({ success: false, message: "Failed to extract caption ideas" });
    }
  }

  /**
   * POST /api/video-caption/transcribe
   * Transcribe an uploaded audio track (LINEAR16 WAV, mono 16kHz — extracted
   * from the video on the client) into timestamped caption segments via Google
   * Cloud Speech-to-Text. Returns segments in the same shape as a parsed
   * caption file so the client can treat them identically.
   */
  async transcribe(req: Request & { file?: Express.Multer.File }, res: Response): Promise<void> {
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

      const file = req.file;
      if (!file?.buffer?.length) {
        res.status(400).json({ success: false, message: "No audio uploaded." });
        return;
      }

      const language = typeof req.body?.language === "string" ? req.body.language : undefined;
      const sampleRateHertz = Number(req.body?.sampleRate) || undefined;

      const { segments, language: detected } = await googleSttService.transcribeSegments(file.buffer, {
        languageHint: language,
        sampleRateHertz,
      });

      // Charge the STT cost (by audio duration) to the project + ledger.
      await chargeCaptionSttUsage(captionCostCtxFromBody(req, currentUser, "video-caption-stt"), wavSeconds(file.buffer, sampleRateHertz));

      res.json({ success: true, segments, language: detected });
    } catch (error) {
      console.error("[VideoCaptionController] transcribe error:", error);
      res.status(500).json({ success: false, message: "Failed to transcribe the video audio" });
    }
  }

  /**
   * POST /api/video-caption/detect-language
   * Detect the spoken language of a short audio sample (LINEAR16 WAV) via STT
   * auto-detect, seeded with the client's candidate codes. Cheap pre-flight.
   */
  async detectLanguage(req: Request & { file?: Express.Multer.File }, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      if (currentUser) {
        const { hasCredits } = await creditService.validateCredits(currentUser.id);
        if (!hasCredits) {
          res.status(402).json({ success: false, message: "Insufficient credits", errorType: "insufficient_credits" });
          return;
        }
      }
      const file = req.file;
      if (!file?.buffer?.length) {
        res.status(400).json({ success: false, message: "No audio uploaded." });
        return;
      }
      const candidates =
        typeof req.body?.candidates === "string"
          ? req.body.candidates.split(",").map((s: string) => s.trim()).filter(Boolean).slice(0, 4)
          : undefined;
      const sampleRateHertz = Number(req.body?.sampleRate) || undefined;

      const result = await googleSttService.detectLanguage(file.buffer, { candidates, sampleRateHertz });
      // The detection sample is short but still real STT usage — charge it.
      await chargeCaptionSttUsage(captionCostCtxFromBody(req, currentUser, "video-caption-stt"), wavSeconds(file.buffer, sampleRateHertz));
      res.json({ success: true, language: result.language, sampleText: result.sampleText });
    } catch (error) {
      console.error("[VideoCaptionController] detectLanguage error:", error);
      res.status(500).json({ success: false, message: "Failed to detect language" });
    }
  }

  /**
   * GET /api/admin/caption-projects
   * Admin: list caption projects with their accumulated cost + owner/student/
   * institute names. Mirrors the admin sessions list.
   */
  async listProjectsAdmin(req: Request, res: Response): Promise<void> {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 25, 1), 100);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
      const instituteId = (req.query.instituteId as string) || undefined;
      const startDate = (req.query.startDate as string) || undefined;
      const endDate = (req.query.endDate as string) || undefined;
      const opts = { instituteId, startDate, endDate, limit, offset };
      const [data, total] = await Promise.all([
        captionProjectRepository.getCaptionProjectsAdmin(opts),
        captionProjectRepository.getCaptionProjectsAdminCount(opts),
      ]);
      res.json({
        success: true,
        data,
        pagination: { total, limit, offset, hasMore: offset + limit < total },
      });
    } catch (error) {
      console.error("[VideoCaptionController] listProjectsAdmin error:", error);
      res.status(500).json({ success: false, message: "Failed to list caption projects" });
    }
  }

  /**
   * GET /api/caption-projects/:hash
   * Load the current user's saved caption project for a video content hash.
   * Returns `{ project: null }` when none exists (a fresh video).
   */
  async getProject(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Not authenticated" });
        return;
      }
      const hash = req.params.hash;
      if (!videoHashSchema.safeParse(hash).success) {
        res.status(400).json({ success: false, message: "Invalid video hash" });
        return;
      }
      const project = await captionProjectRepository.getByUserAndHash(userId, hash);
      res.json({ success: true, project: project ?? null });
    } catch (error) {
      console.error("[VideoCaptionController] getProject error:", error);
      res.status(500).json({ success: false, message: "Failed to load caption project" });
    }
  }

  /**
   * PUT /api/caption-projects/:hash
   * Create or update the current user's caption project for a video hash.
   */
  async saveProject(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Not authenticated" });
        return;
      }
      const hash = req.params.hash;
      if (!videoHashSchema.safeParse(hash).success) {
        res.status(400).json({ success: false, message: "Invalid video hash" });
        return;
      }
      const parsed = saveProjectSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid request", errors: parsed.error.flatten() });
        return;
      }
      const project = await captionProjectRepository.upsert(userId, hash, {
        videoName: parsed.data.videoName ?? null,
        language: parsed.data.language ?? null,
        segments: parsed.data.segments,
      });
      res.json({ success: true, project });
    } catch (error) {
      console.error("[VideoCaptionController] saveProject error:", error);
      res.status(500).json({ success: false, message: "Failed to save caption project" });
    }
  }
}

export const videoCaptionController = new VideoCaptionController();
