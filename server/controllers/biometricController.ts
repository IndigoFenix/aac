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
  createContact,
  getContact,
  getContactsByStudent,
  updateContact,
  deleteContact,
  enrollContactFace,
  getLinkableEntitiesForStudent,
  uploadBiometricPhoto,
  getBiometricData,
  updateBiometricData,
  type FaceEmbedding,
  type VoiceEmbedding,
  type EntityType,
} from "../services/biometric";
import { s3Service } from "../services/storage/s3-service";
import { updateBiometricDataSchema } from "@shared/schema";
import { insertStudentContactSchema, updateStudentContactSchema } from "@shared/schema";
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
  // ============================================================================
  // STUDENT CONTACTS CRUD
  // ============================================================================

  /**
   * POST /api/biometric/students/:studentId/contacts
   * Create a new contact for a student
   */
  async createStudentContact(req: Request, res: Response): Promise<void> {
    try {
      const { studentId } = req.params;
      const currentUser = req.user as any;

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess && !currentUser.isAdmin && !currentUser.isSystemAdmin) {
        res.status(403).json({ success: false, message: "Not authorized" });
        return;
      }

      const data = insertStudentContactSchema.parse({ ...req.body, studentId });
      const contact = await createContact(data);
      res.status(201).json({ success: true, contact });
    } catch (error: any) {
      console.error("[BiometricController] createStudentContact error:", error);
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid data", errors: error.errors });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to create contact" });
    }
  }

  /**
   * GET /api/biometric/students/:studentId/contacts
   * List all active contacts for a student
   */
  async listStudentContacts(req: Request, res: Response): Promise<void> {
    try {
      const { studentId } = req.params;
      const currentUser = req.user as any;

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess && !currentUser.isAdmin && !currentUser.isSystemAdmin) {
        res.status(403).json({ success: false, message: "Not authorized" });
        return;
      }

      const contacts = await getContactsByStudent(studentId);
      res.json({ success: true, contacts, count: contacts.length });
    } catch (error: any) {
      console.error("[BiometricController] listStudentContacts error:", error);
      res.status(500).json({ success: false, message: "Failed to list contacts" });
    }
  }

  /**
   * GET /api/biometric/students/:studentId/contacts/:id
   * Get a specific contact
   */
  async getStudentContact(req: Request, res: Response): Promise<void> {
    try {
      const { studentId, id } = req.params;
      const currentUser = req.user as any;

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess && !currentUser.isAdmin && !currentUser.isSystemAdmin) {
        res.status(403).json({ success: false, message: "Not authorized" });
        return;
      }

      const contact = await getContact(id);
      if (!contact || contact.studentId !== studentId) {
        res.status(404).json({ success: false, message: "Contact not found" });
        return;
      }
      res.json({ success: true, contact });
    } catch (error: any) {
      console.error("[BiometricController] getStudentContact error:", error);
      res.status(500).json({ success: false, message: "Failed to get contact" });
    }
  }

  /**
   * PATCH /api/biometric/students/:studentId/contacts/:id
   * Update a contact
   */
  async updateStudentContact(req: Request, res: Response): Promise<void> {
    try {
      const { studentId, id } = req.params;
      const currentUser = req.user as any;

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess && !currentUser.isAdmin && !currentUser.isSystemAdmin) {
        res.status(403).json({ success: false, message: "Not authorized" });
        return;
      }

      const existing = await getContact(id);
      if (!existing || existing.studentId !== studentId) {
        res.status(404).json({ success: false, message: "Contact not found" });
        return;
      }

      const data = updateStudentContactSchema.parse(req.body);
      const contact = await updateContact(id, data);
      res.json({ success: true, contact });
    } catch (error: any) {
      console.error("[BiometricController] updateStudentContact error:", error);
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid data", errors: error.errors });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to update contact" });
    }
  }

  /**
   * DELETE /api/biometric/students/:studentId/contacts/:id
   * Soft-delete a contact
   */
  async deleteStudentContact(req: Request, res: Response): Promise<void> {
    try {
      const { studentId, id } = req.params;
      const currentUser = req.user as any;

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess && !currentUser.isAdmin && !currentUser.isSystemAdmin) {
        res.status(403).json({ success: false, message: "Not authorized" });
        return;
      }

      const existing = await getContact(id);
      if (!existing || existing.studentId !== studentId) {
        res.status(404).json({ success: false, message: "Contact not found" });
        return;
      }

      await deleteContact(id);
      res.json({ success: true, message: "Contact deleted" });
    } catch (error: any) {
      console.error("[BiometricController] deleteStudentContact error:", error);
      res.status(500).json({ success: false, message: "Failed to delete contact" });
    }
  }

  /**
   * GET /api/biometric/students/:studentId/linkable-entities
   * Return users + other students that share an institute with this student,
   * for populating the linkedUserId / linkedStudentId picker.
   */
  async getLinkableEntities(req: Request, res: Response): Promise<void> {
    try {
      const { studentId } = req.params;
      const currentUser = req.user as any;
      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess && !currentUser.isAdmin && !currentUser.isSystemAdmin) {
        res.status(403).json({ success: false, message: "Not authorized" });
        return;
      }
      const entities = await getLinkableEntitiesForStudent(studentId);
      res.json({ success: true, entities });
    } catch (error: any) {
      console.error("[BiometricController] getLinkableEntities error:", error);
      res.status(500).json({ success: false, message: "Failed to load linkable entities" });
    }
  }

  /**
   * POST /api/biometric/students/:studentId/contacts/:id/face
   * Enroll face embedding for a contact
   */
  async enrollContactFace(req: Request, res: Response): Promise<void> {
    try {
      const { studentId, id } = req.params;
      const currentUser = req.user as any;

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess && !currentUser.isAdmin && !currentUser.isSystemAdmin) {
        res.status(403).json({ success: false, message: "Not authorized" });
        return;
      }

      const existing = await getContact(id);
      if (!existing || existing.studentId !== studentId) {
        res.status(404).json({ success: false, message: "Contact not found" });
        return;
      }

      const { embedding } = faceEmbeddingSchema.parse(req.body);
      await enrollContactFace(id, embedding);
      res.json({ success: true, message: "Contact face embedding enrolled" });
    } catch (error: any) {
      console.error("[BiometricController] enrollContactFace error:", error);
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid embedding format", errors: error.errors });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to enroll contact face" });
    }
  }

  // ============================================================================
  // PHOTO UPLOAD (shared for users/students/contacts)
  // ============================================================================
  // Multipart endpoint: image file + optional embedding (JSON-stringified in a
  // form field). Resizes + uploads to S3, updates biometric_data.

  private async handlePhotoUpload(
    req: Request,
    res: Response,
    target: { type: EntityType; id: string },
  ): Promise<void> {
    const file = (req as any).file as { buffer: Buffer; mimetype?: string } | undefined;
    if (!file?.buffer) {
      res.status(400).json({ success: false, message: "No image file uploaded" });
      return;
    }
    if (file.mimetype && !file.mimetype.startsWith("image/")) {
      res.status(400).json({ success: false, message: "File must be an image" });
      return;
    }

    let embedding: FaceEmbedding | undefined;
    if (req.body.embedding) {
      try {
        const raw = typeof req.body.embedding === "string"
          ? JSON.parse(req.body.embedding)
          : req.body.embedding;
        const parsed = z.array(z.number()).min(64).max(512).parse(raw);
        embedding = parsed;
      } catch (err) {
        res.status(400).json({ success: false, message: "Invalid embedding format" });
        return;
      }
    }
    const quality = req.body.quality ? parseFloat(req.body.quality) : undefined;

    const result = await uploadBiometricPhoto(target, file.buffer, { embedding, quality });
    res.json({ success: true, ...result });
  }

  async uploadUserPhoto(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = req.params;
      const currentUser = req.user as any;
      if (userId !== currentUser.id && !currentUser.isAdmin && !currentUser.isSystemAdmin) {
        res.status(403).json({ success: false, message: "Not authorized" });
        return;
      }
      await this.handlePhotoUpload(req, res, { type: "user", id: userId });
    } catch (error: any) {
      console.error("[BiometricController] uploadUserPhoto error:", error);
      res.status(500).json({ success: false, message: "Failed to upload photo" });
    }
  }

  async uploadStudentPhoto(req: Request, res: Response): Promise<void> {
    try {
      const { studentId } = req.params;
      const currentUser = req.user as any;
      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess && !currentUser.isAdmin && !currentUser.isSystemAdmin) {
        res.status(403).json({ success: false, message: "Not authorized" });
        return;
      }
      await this.handlePhotoUpload(req, res, { type: "student", id: studentId });
    } catch (error: any) {
      console.error("[BiometricController] uploadStudentPhoto error:", error);
      res.status(500).json({ success: false, message: "Failed to upload photo" });
    }
  }

  async uploadContactPhoto(req: Request, res: Response): Promise<void> {
    try {
      const { studentId, id } = req.params;
      const currentUser = req.user as any;
      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess && !currentUser.isAdmin && !currentUser.isSystemAdmin) {
        res.status(403).json({ success: false, message: "Not authorized" });
        return;
      }
      const existing = await getContact(id);
      if (!existing || existing.studentId !== studentId) {
        res.status(404).json({ success: false, message: "Contact not found" });
        return;
      }
      await this.handlePhotoUpload(req, res, { type: "contact", id });
    } catch (error: any) {
      console.error("[BiometricController] uploadContactPhoto error:", error);
      res.status(500).json({ success: false, message: "Failed to upload photo" });
    }
  }

  // ============================================================================
  // BIOMETRIC DATA direct access (physical features, retrieval)
  // ============================================================================

  /**
   * GET /api/biometric-data/:id/photo
   * Stream the stored JPEG from S3. Access control happens implicitly — the
   * client must already have access to a user/student/contact that points at
   * this biometric_data row for the URL to have been returned to them.
   * (TODO: tighten with a signed-URL approach once Terraform settles.)
   */
  async getBiometricPhoto(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const row = await getBiometricData(id);
      if (!row?.faceImageUrl) {
        res.status(404).json({ success: false, message: "No photo stored" });
        return;
      }
      const buffer = await s3Service.download(row.faceImageUrl);
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "private, max-age=300");
      res.send(buffer);
    } catch (error: any) {
      console.error("[BiometricController] getBiometricPhoto error:", error);
      res.status(500).json({ success: false, message: "Failed to retrieve photo" });
    }
  }

  /**
   * PATCH /api/biometric-data/:id
   * Update physical/identifying features (hairColor, eyeColor, etc.).
   * Embeddings and image URL are not editable through this endpoint.
   */
  async updateBiometricDataPhysical(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      // Strip fields that must go through dedicated endpoints
      const data = updateBiometricDataSchema
        .omit({ faceEmbedding: true, voiceEmbedding: true, faceImageUrl: true, faceImageQuality: true })
        .parse(req.body);
      const row = await updateBiometricData(id, data);
      if (!row) {
        res.status(404).json({ success: false, message: "Biometric data not found" });
        return;
      }
      res.json({ success: true, biometricData: row });
    } catch (error: any) {
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid data", errors: error.errors });
        return;
      }
      console.error("[BiometricController] updateBiometricDataPhysical error:", error);
      res.status(500).json({ success: false, message: "Failed to update biometric data" });
    }
  }
}

export const biometricController = new BiometricController();
