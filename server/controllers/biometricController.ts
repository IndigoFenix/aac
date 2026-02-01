// server/controllers/biometricController.ts
// Controller for biometric enrollment (face and voice recognition)

import type { Request, Response } from "express";
import { z } from "zod";
import {
  storeFaceEmbeddingForUser,
  storeFaceEmbeddingForStudent,
  getFaceEmbeddingForUser,
  getFaceEmbeddingForStudent,
  removeFaceEmbeddingForUser,
  removeFaceEmbeddingForStudent,
  storeVoiceEmbeddingForUser,
  storeVoiceEmbeddingForStudent,
  getVoiceEmbeddingForUser,
  getVoiceEmbeddingForStudent,
  removeVoiceEmbeddingForUser,
  removeVoiceEmbeddingForStudent,
  findMatchingFace,
  findMatchingVoice,
  getKnownPeopleForStudent,
  type FaceEmbedding,
  type VoiceEmbedding,
} from "../services/biometric";
import { studentService } from "../services";

// Validation schemas
const faceEmbeddingSchema = z.object({
  embedding: z.array(z.number()).min(64).max(512),
});

const voiceEmbeddingSchema = z.object({
  embedding: z.array(z.number()).min(64).max(1024),
});

/**
 * Biometric Controller
 * Handles enrollment and matching for face and voice recognition
 */
export class BiometricController {
  // ============================================================================
  // FACE ENROLLMENT - USERS
  // ============================================================================

  /**
   * POST /api/biometric/users/:userId/face
   * Enroll or update face embedding for a user
   */
  async enrollUserFace(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = req.params;
      const currentUser = req.user as any;

      // Only allow users to enroll their own face, or admins to enroll any
      if (userId !== currentUser.id && !currentUser.isAdmin && !currentUser.isSystemAdmin) {
        res.status(403).json({ success: false, message: "Not authorized to enroll this user's face" });
        return;
      }

      const { embedding } = faceEmbeddingSchema.parse(req.body);
      await storeFaceEmbeddingForUser(userId, embedding);

      res.json({ success: true, message: "Face embedding enrolled successfully" });
    } catch (error: any) {
      console.error("[BiometricController] enrollUserFace error:", error);
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid embedding format", errors: error.errors });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to enroll face embedding" });
    }
  }

  /**
   * GET /api/biometric/users/:userId/face
   * Check if user has face embedding enrolled
   */
  async getUserFaceStatus(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = req.params;
      const currentUser = req.user as any;

      // Only allow users to check their own status, or admins
      if (userId !== currentUser.id && !currentUser.isAdmin && !currentUser.isSystemAdmin) {
        res.status(403).json({ success: false, message: "Not authorized" });
        return;
      }

      const embedding = await getFaceEmbeddingForUser(userId);
      res.json({ success: true, enrolled: !!embedding });
    } catch (error: any) {
      console.error("[BiometricController] getUserFaceStatus error:", error);
      res.status(500).json({ success: false, message: "Failed to get face status" });
    }
  }

  /**
   * DELETE /api/biometric/users/:userId/face
   * Remove face embedding for a user
   */
  async removeUserFace(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = req.params;
      const currentUser = req.user as any;

      if (userId !== currentUser.id && !currentUser.isAdmin && !currentUser.isSystemAdmin) {
        res.status(403).json({ success: false, message: "Not authorized" });
        return;
      }

      await removeFaceEmbeddingForUser(userId);
      res.json({ success: true, message: "Face embedding removed" });
    } catch (error: any) {
      console.error("[BiometricController] removeUserFace error:", error);
      res.status(500).json({ success: false, message: "Failed to remove face embedding" });
    }
  }

  // ============================================================================
  // FACE ENROLLMENT - STUDENTS
  // ============================================================================

  /**
   * POST /api/biometric/students/:studentId/face
   * Enroll or update face embedding for a student
   */
  async enrollStudentFace(req: Request, res: Response): Promise<void> {
    try {
      const { studentId } = req.params;
      const currentUser = req.user as any;

      // Verify user has access to this student
      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess && !currentUser.isAdmin && !currentUser.isSystemAdmin) {
        res.status(403).json({ success: false, message: "Not authorized to enroll this student's face" });
        return;
      }

      const { embedding } = faceEmbeddingSchema.parse(req.body);
      await storeFaceEmbeddingForStudent(studentId, embedding);

      res.json({ success: true, message: "Face embedding enrolled successfully" });
    } catch (error: any) {
      console.error("[BiometricController] enrollStudentFace error:", error);
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid embedding format", errors: error.errors });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to enroll face embedding" });
    }
  }

  /**
   * GET /api/biometric/students/:studentId/face
   * Check if student has face embedding enrolled
   */
  async getStudentFaceStatus(req: Request, res: Response): Promise<void> {
    try {
      const { studentId } = req.params;
      const currentUser = req.user as any;

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess && !currentUser.isAdmin && !currentUser.isSystemAdmin) {
        res.status(403).json({ success: false, message: "Not authorized" });
        return;
      }

      const embedding = await getFaceEmbeddingForStudent(studentId);
      res.json({ success: true, enrolled: !!embedding });
    } catch (error: any) {
      console.error("[BiometricController] getStudentFaceStatus error:", error);
      res.status(500).json({ success: false, message: "Failed to get face status" });
    }
  }

  /**
   * DELETE /api/biometric/students/:studentId/face
   * Remove face embedding for a student
   */
  async removeStudentFace(req: Request, res: Response): Promise<void> {
    try {
      const { studentId } = req.params;
      const currentUser = req.user as any;

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess && !currentUser.isAdmin && !currentUser.isSystemAdmin) {
        res.status(403).json({ success: false, message: "Not authorized" });
        return;
      }

      await removeFaceEmbeddingForStudent(studentId);
      res.json({ success: true, message: "Face embedding removed" });
    } catch (error: any) {
      console.error("[BiometricController] removeStudentFace error:", error);
      res.status(500).json({ success: false, message: "Failed to remove face embedding" });
    }
  }

  // ============================================================================
  // VOICE ENROLLMENT - USERS
  // ============================================================================

  /**
   * POST /api/biometric/users/:userId/voice
   * Enroll or update voice embedding for a user
   */
  async enrollUserVoice(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = req.params;
      const currentUser = req.user as any;

      if (userId !== currentUser.id && !currentUser.isAdmin && !currentUser.isSystemAdmin) {
        res.status(403).json({ success: false, message: "Not authorized to enroll this user's voice" });
        return;
      }

      const { embedding } = voiceEmbeddingSchema.parse(req.body);
      await storeVoiceEmbeddingForUser(userId, embedding);

      res.json({ success: true, message: "Voice embedding enrolled successfully" });
    } catch (error: any) {
      console.error("[BiometricController] enrollUserVoice error:", error);
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid embedding format", errors: error.errors });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to enroll voice embedding" });
    }
  }

  /**
   * GET /api/biometric/users/:userId/voice
   * Check if user has voice embedding enrolled
   */
  async getUserVoiceStatus(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = req.params;
      const currentUser = req.user as any;

      if (userId !== currentUser.id && !currentUser.isAdmin && !currentUser.isSystemAdmin) {
        res.status(403).json({ success: false, message: "Not authorized" });
        return;
      }

      const embedding = await getVoiceEmbeddingForUser(userId);
      res.json({ success: true, enrolled: !!embedding });
    } catch (error: any) {
      console.error("[BiometricController] getUserVoiceStatus error:", error);
      res.status(500).json({ success: false, message: "Failed to get voice status" });
    }
  }

  /**
   * DELETE /api/biometric/users/:userId/voice
   * Remove voice embedding for a user
   */
  async removeUserVoice(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = req.params;
      const currentUser = req.user as any;

      if (userId !== currentUser.id && !currentUser.isAdmin && !currentUser.isSystemAdmin) {
        res.status(403).json({ success: false, message: "Not authorized" });
        return;
      }

      await removeVoiceEmbeddingForUser(userId);
      res.json({ success: true, message: "Voice embedding removed" });
    } catch (error: any) {
      console.error("[BiometricController] removeUserVoice error:", error);
      res.status(500).json({ success: false, message: "Failed to remove voice embedding" });
    }
  }

  // ============================================================================
  // VOICE ENROLLMENT - STUDENTS
  // ============================================================================

  /**
   * POST /api/biometric/students/:studentId/voice
   * Enroll or update voice embedding for a student
   */
  async enrollStudentVoice(req: Request, res: Response): Promise<void> {
    try {
      const { studentId } = req.params;
      const currentUser = req.user as any;

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess && !currentUser.isAdmin && !currentUser.isSystemAdmin) {
        res.status(403).json({ success: false, message: "Not authorized to enroll this student's voice" });
        return;
      }

      const { embedding } = voiceEmbeddingSchema.parse(req.body);
      await storeVoiceEmbeddingForStudent(studentId, embedding);

      res.json({ success: true, message: "Voice embedding enrolled successfully" });
    } catch (error: any) {
      console.error("[BiometricController] enrollStudentVoice error:", error);
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid embedding format", errors: error.errors });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to enroll voice embedding" });
    }
  }

  /**
   * GET /api/biometric/students/:studentId/voice
   * Check if student has voice embedding enrolled
   */
  async getStudentVoiceStatus(req: Request, res: Response): Promise<void> {
    try {
      const { studentId } = req.params;
      const currentUser = req.user as any;

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess && !currentUser.isAdmin && !currentUser.isSystemAdmin) {
        res.status(403).json({ success: false, message: "Not authorized" });
        return;
      }

      const embedding = await getVoiceEmbeddingForStudent(studentId);
      res.json({ success: true, enrolled: !!embedding });
    } catch (error: any) {
      console.error("[BiometricController] getStudentVoiceStatus error:", error);
      res.status(500).json({ success: false, message: "Failed to get voice status" });
    }
  }

  /**
   * DELETE /api/biometric/students/:studentId/voice
   * Remove voice embedding for a student
   */
  async removeStudentVoice(req: Request, res: Response): Promise<void> {
    try {
      const { studentId } = req.params;
      const currentUser = req.user as any;

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess && !currentUser.isAdmin && !currentUser.isSystemAdmin) {
        res.status(403).json({ success: false, message: "Not authorized" });
        return;
      }

      await removeVoiceEmbeddingForStudent(studentId);
      res.json({ success: true, message: "Voice embedding removed" });
    } catch (error: any) {
      console.error("[BiometricController] removeStudentVoice error:", error);
      res.status(500).json({ success: false, message: "Failed to remove voice embedding" });
    }
  }

  // ============================================================================
  // MATCHING / IDENTIFICATION
  // ============================================================================

  /**
   * POST /api/biometric/match/face
   * Find a matching face from the database
   */
  async matchFace(req: Request, res: Response): Promise<void> {
    try {
      const { embedding, studentId } = req.body;

      if (!embedding || !Array.isArray(embedding)) {
        res.status(400).json({ success: false, message: "Embedding array is required" });
        return;
      }

      const match = await findMatchingFace(embedding as FaceEmbedding, studentId);

      if (match) {
        res.json({
          success: true,
          matched: true,
          result: {
            entityType: match.entityType,
            entityId: match.entityId,
            name: match.name,
            confidence: match.confidence,
          },
        });
      } else {
        res.json({ success: true, matched: false });
      }
    } catch (error: any) {
      console.error("[BiometricController] matchFace error:", error);
      res.status(500).json({ success: false, message: "Failed to match face" });
    }
  }

  /**
   * POST /api/biometric/match/voice
   * Find a matching voice from the database
   */
  async matchVoice(req: Request, res: Response): Promise<void> {
    try {
      const { embedding, studentId } = req.body;

      if (!embedding || !Array.isArray(embedding)) {
        res.status(400).json({ success: false, message: "Embedding array is required" });
        return;
      }

      const match = await findMatchingVoice(embedding as VoiceEmbedding, studentId);

      if (match) {
        res.json({
          success: true,
          matched: true,
          result: {
            entityType: match.entityType,
            entityId: match.entityId,
            name: match.name,
            confidence: match.confidence,
          },
        });
      } else {
        res.json({ success: true, matched: false });
      }
    } catch (error: any) {
      console.error("[BiometricController] matchVoice error:", error);
      res.status(500).json({ success: false, message: "Failed to match voice" });
    }
  }

  // ============================================================================
  // KNOWN PEOPLE (for frontend identification)
  // ============================================================================

  /**
   * GET /api/aac/students/:studentId/known-people
   * Get all known people (student + connected users) with biometric embeddings
   * Used by frontend for local identification
   */
  async getKnownPeople(req: Request, res: Response): Promise<void> {
    try {
      const { studentId } = req.params;
      const currentUser = req.user as any;

      // Verify user has access to this student (if authenticated)
      if (currentUser?.id) {
        const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
        if (!hasAccess && !currentUser.isAdmin && !currentUser.isSystemAdmin) {
          res.status(403).json({ success: false, message: "Not authorized to access this student's data" });
          return;
        }
      }

      const people = await getKnownPeopleForStudent(studentId);

      res.json({
        success: true,
        people,
        count: people.length,
      });
    } catch (error: any) {
      console.error("[BiometricController] getKnownPeople error:", error);
      res.status(500).json({ success: false, message: "Failed to get known people" });
    }
  }
}

export const biometricController = new BiometricController();
