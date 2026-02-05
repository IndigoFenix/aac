import type { Request, Response } from "express";
import { voiceRecordService } from "../services/voiceRecordService";
import { insertVoiceSchema, updateVoiceSchema } from "@shared/schema";

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
