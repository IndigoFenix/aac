import type { Request, Response } from "express";
import { voiceRecordService } from "../services/voiceRecordService";
import { insertVoiceSchema, updateVoiceSchema } from "@shared/schema";
import { elevenlabsTtsService } from "../services/voice/elevenlabs-tts-service";
import { googleTtsService } from "../services/voice/google-tts-service";
import { studentService } from "../services/studentService";
import { chargeCreditsToLedger } from "../services/credit-ledger";
import { creditsForTtsUsage } from "../services/chat/cost-helpers";

/**
 * Test lines for the Google/Gemini voice preview, keyed by base language.
 * Spoken in the language the voice will actually use with the student — the
 * clinician needs to judge the voice in THAT language, not their UI language.
 * Phrasing avoids gendered first-person forms (Hebrew, Arabic, French, ...)
 * since the same line previews both AI and student voices of either gender.
 */
const GOOGLE_PREVIEW_LINES: Record<string, string> = {
  en: "Hi! This is how my voice sounds. It's nice to talk with you.",
  he: "היי! כך נשמע הקול שלי. נעים לדבר איתך.",
  ar: "مرحباً! هكذا يبدو صوتي. من الجميل أن نتحدث معاً.",
  es: "¡Hola! Así suena mi voz. Es un gusto hablar contigo.",
  ru: "Привет! Вот как звучит мой голос. Приятно поговорить с тобой.",
  fr: "Salut ! Voici comment sonne ma voix. C'est agréable de parler avec toi.",
  de: "Hallo! So klingt meine Stimme. Schön, mit dir zu sprechen.",
  pt: "Olá! É assim que soa a minha voz. É bom falar com você.",
  zh: "你好！这是我的声音。很高兴和你聊天。",
  yue: "你好！呢個係我把聲。同你傾偈好開心。",
  ko: "안녕하세요! 제 목소리는 이렇게 들려요. 함께 이야기하게 되어 반가워요.",
};

/** The per-language preview line for a (possibly regional) language code. */
export function googlePreviewLineFor(language: string): string {
  const base = (language || "en").toLowerCase().split("-")[0];
  return GOOGLE_PREVIEW_LINES[base] || GOOGLE_PREVIEW_LINES.en;
}

export class VoiceRecordController {
  async getVoices(req: Request, res: Response): Promise<void> {
    try {
      const result = await voiceRecordService.getAllVoices();

      if (!result.success) {
        res.status(500).json({ success: false, message: result.error });
        return;
      }

      res.json({ success: true, voices: result.voices });
    } catch (error: any) {
      console.error("Error fetching voices:", error);
      res.status(500).json({ success: false, message: "Failed to fetch voices" });
    }
  }

  async getActiveVoices(req: Request, res: Response): Promise<void> {
    try {
      const result = await voiceRecordService.getActiveVoices();

      if (!result.success) {
        res.status(500).json({ success: false, message: result.error });
        return;
      }

      res.json({ success: true, voices: result.voices });
    } catch (error: any) {
      console.error("Error fetching active voices:", error);
      res.status(500).json({ success: false, message: "Failed to fetch active voices" });
    }
  }

  async getVoice(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const result = await voiceRecordService.getVoiceById(id);

      if (!result.success) {
        res.status(404).json({ success: false, message: result.error });
        return;
      }

      res.json({ success: true, voice: result.voice });
    } catch (error: any) {
      console.error("Error fetching voice:", error);
      res.status(500).json({ success: false, message: "Failed to fetch voice" });
    }
  }

  async createVoice(req: Request, res: Response): Promise<void> {
    try {
      const parseResult = insertVoiceSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          success: false,
          message: "Invalid voice data",
          errors: parseResult.error.errors,
        });
        return;
      }

      const result = await voiceRecordService.createVoice(parseResult.data);

      if (!result.success) {
        res.status(400).json({ success: false, message: result.error });
        return;
      }

      res.json({ success: true, message: "Voice created successfully", voice: result.voice });
    } catch (error: any) {
      console.error("Error creating voice:", error);
      res.status(500).json({ success: false, message: "Failed to create voice" });
    }
  }

  async updateVoice(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const parseResult = updateVoiceSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          success: false,
          message: "Invalid voice data",
          errors: parseResult.error.errors,
        });
        return;
      }

      const result = await voiceRecordService.updateVoice(id, parseResult.data);

      if (!result.success) {
        res.status(result.error === "Voice not found" ? 404 : 400).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({ success: true, message: "Voice updated successfully", voice: result.voice });
    } catch (error: any) {
      console.error("Error updating voice:", error);
      res.status(500).json({ success: false, message: "Failed to update voice" });
    }
  }

  async listElevenlabsVoices(req: Request, res: Response): Promise<void> {
    try {
      const { apiKey } = req.body;
      if (!apiKey || typeof apiKey !== "string") {
        res.status(400).json({ success: false, message: "apiKey is required" });
        return;
      }

      const response = await fetch("https://api.elevenlabs.io/v1/voices", {
        headers: { "xi-api-key": apiKey },
      });

      if (!response.ok) {
        const status = response.status;
        // Note: an upstream 401 means the ElevenLabs *API key* is bad, NOT that
        // the user's own session expired. Relaying a raw 401 here makes the
        // client's global auth handler bounce the user to the login page. Map
        // it to 400 (bad input) so it surfaces as an "invalid key" message.
        res.status(status === 401 ? 400 : 502).json({
          success: false,
          message: status === 401 ? "Invalid ElevenLabs API key" : "Failed to fetch voices from ElevenLabs",
        });
        return;
      }

      const data = await response.json();
      const voices = (data.voices || []).map((v: any) => ({
        voice_id: v.voice_id,
        name: v.name,
        category: v.category,
        labels: v.labels || {},
      }));

      res.json({ success: true, voices });
    } catch (error: any) {
      console.error("Error fetching ElevenLabs voices:", error);
      res.status(500).json({ success: false, message: "Failed to fetch ElevenLabs voices" });
    }
  }

  async previewVoice(req: Request, res: Response): Promise<void> {
    try {
      const { voiceId, text, apiKey } = req.body;
      if (!voiceId || typeof voiceId !== "string") {
        res.status(400).json({ success: false, message: "voiceId is required" });
        return;
      }
      if (!text || typeof text !== "string") {
        res.status(400).json({ success: false, message: "text is required" });
        return;
      }

      const audioBuffer = await elevenlabsTtsService.synthesize(text, {
        voiceId,
        apiKeyOverride: apiKey || undefined,
      });

      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Length", audioBuffer.length);
      res.send(audioBuffer);
    } catch (error: any) {
      console.error("Error previewing voice:", error);
      // A 401 from ElevenLabs means the API key is bad — not a session-auth
      // failure. Map it to 400 so the client's global 401 handler doesn't bounce
      // the user to the login page (see listElevenlabsVoices for context).
      const status = error.message?.includes("401") ? 400 : 500;
      res.status(status).json({ success: false, message: error.message || "Failed to preview voice" });
    }
  }

  /**
   * Preview a Google/Gemini (Chirp 3 HD) voice with a canned per-language
   * test line. Unlike the ElevenLabs preview, the TEXT is chosen server-side
   * from the student's language — the caller sends only the voice + student.
   *
   * The synthesis is billed to the SELECTED STUDENT's credit ledger (same
   * per-character TTS rate as a session), so previews draw on the same budget
   * the session would. Pitch is NOT applied here: Chirp 3 HD rejects the API
   * pitch parameter (and would silently fall back to a different voice) — the
   * client applies the pitch slider with the same shared pitch shifter the
   * AAC uses for live playback.
   */
  async previewGoogleVoice(req: Request, res: Response): Promise<void> {
    try {
      const { voiceName, language, studentId } = req.body;
      if (!voiceName || typeof voiceName !== "string") {
        res.status(400).json({ success: false, message: "voiceName is required" });
        return;
      }
      if (language !== undefined && typeof language !== "string") {
        res.status(400).json({ success: false, message: "language must be a string" });
        return;
      }
      if (!studentId || typeof studentId !== "string") {
        res.status(400).json({ success: false, message: "studentId is required" });
        return;
      }

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, req.user!.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "No access to this student" });
        return;
      }

      const lang = language || "en";
      const line = googlePreviewLineFor(lang);
      const audioBuffer = await googleTtsService.synthesize(line, lang, {
        voiceName,
      });

      await chargeCreditsToLedger({
        studentId,
        userId: req.user!.id,
        credits: creditsForTtsUsage("google", line.length),
        category: "tts",
        label: `tts provider=google chars=${line.length} [voice-preview]`,
      });

      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Length", audioBuffer.length);
      res.send(audioBuffer);
    } catch (error: any) {
      console.error("Error previewing Google voice:", error);
      res.status(500).json({ success: false, message: error.message || "Failed to preview voice" });
    }
  }

  async deleteVoice(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const result = await voiceRecordService.deleteVoice(id);

      if (!result.success) {
        res.status(result.error === "Voice not found" ? 404 : 400).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({ success: true, message: "Voice deleted successfully" });
    } catch (error: any) {
      console.error("Error deleting voice:", error);
      res.status(500).json({ success: false, message: "Failed to delete voice" });
    }
  }
}

export const voiceRecordController = new VoiceRecordController();
