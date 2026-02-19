import type { Request, Response } from "express";
import { voiceRecordService } from "../services/voiceRecordService";
import { insertVoiceSchema, updateVoiceSchema } from "@shared/schema";
import { elevenlabsTtsService } from "../services/voice/elevenlabs-tts-service";

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
        res.status(status === 401 ? 401 : 502).json({
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
      const status = error.message?.includes("401") ? 401 : 500;
      res.status(status).json({ success: false, message: error.message || "Failed to preview voice" });
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
