import { voiceRecordRepository } from "../repositories/voiceRecordRepository";
import {
  type Voice,
  type InsertVoice,
  type UpdateVoice,
} from "@shared/schema";

export class VoiceRecordService {
  async createVoice(
    data: InsertVoice
  ): Promise<{ success: boolean; voice?: Voice; error?: string }> {
    try {
      const voice = await voiceRecordRepository.createVoice(data);
      return { success: true, voice };
    } catch (error: any) {
      console.error("Error creating voice:", error);
      return { success: false, error: "Failed to create voice" };
    }
  }

  async getVoiceById(
    id: string
  ): Promise<{ success: boolean; voice?: Voice; error?: string }> {
    const voice = await voiceRecordRepository.getVoiceById(id);
    if (!voice) {
      return { success: false, error: "Voice not found" };
    }
    return { success: true, voice };
  }

  async getAllVoices(): Promise<{ success: boolean; voices?: Voice[]; error?: string }> {
    try {
      const voices = await voiceRecordRepository.getAllVoices();
      return { success: true, voices };
    } catch (error: any) {
      console.error("Error getting voices:", error);
      return { success: false, error: "Failed to get voices" };
    }
  }

  async getActiveVoices(): Promise<{ success: boolean; voices?: Voice[]; error?: string }> {
    try {
      const voices = await voiceRecordRepository.getActiveVoices();
      return { success: true, voices };
    } catch (error: any) {
      console.error("Error getting active voices:", error);
      return { success: false, error: "Failed to get active voices" };
    }
  }

  async updateVoice(
    id: string,
    updates: UpdateVoice
  ): Promise<{ success: boolean; voice?: Voice; error?: string }> {
    const existing = await voiceRecordRepository.getVoiceById(id);
    if (!existing) {
      return { success: false, error: "Voice not found" };
    }

    try {
      const voice = await voiceRecordRepository.updateVoice(id, updates);
      return { success: true, voice };
    } catch (error: any) {
      console.error("Error updating voice:", error);
      return { success: false, error: "Failed to update voice" };
    }
  }

  async deleteVoice(
    id: string
  ): Promise<{ success: boolean; error?: string }> {
    const existing = await voiceRecordRepository.getVoiceById(id);
    if (!existing) {
      return { success: false, error: "Voice not found" };
    }

    try {
      const deleted = await voiceRecordRepository.deleteVoice(id);
      return { success: deleted, error: deleted ? undefined : "Failed to delete voice" };
    } catch (error: any) {
      console.error("Error deleting voice:", error);
      return { success: false, error: "Failed to delete voice" };
    }
  }
}

export const voiceRecordService = new VoiceRecordService();
