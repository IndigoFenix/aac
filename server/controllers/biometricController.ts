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
  getPeopleDirectoryForStudent,
  getPersonFaceImageUrlForStudent,
  createContact,
  getContact,
  getContactsByStudent,
  updateContact,
  deleteContact,
  enrollContactFace,
  getLinkableEntitiesForStudent,
  uploadBiometricPhoto,
  NoFaceDetectedError,
  PhotoAnalysisUnavailableError,
  getBiometricData,
  updateBiometricData,
  getEntitiesForBiometricData,
  type FaceEmbedding,
  type VoiceEmbedding,
  type EntityType,
} from "../services/biometric";
import { s3Service } from "../services/storage/s3-service";
import { sendNotModified } from "../lib/blob-cache";
import { updateBiometricDataSchema } from "@shared/schema";
import { insertStudentContactSchema, updateStudentContactSchema } from "@shared/schema";
import { studentService } from "../services";
import { studentRepository } from "../repositories/studentRepository";
import { toE164 } from "@shared/phone";

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
      if (!studentId || typeof studentId !== "string") {
        res.status(400).json({ success: false, message: "studentId is required" });
        return;
      }

      // Matching is scoped to this student's known people; the caller must be
      // authorized for the student (prevents a cross-tenant identification oracle).
      const currentUser = req.user as any;
      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess && !currentUser.isAdmin && !currentUser.isSystemAdmin) {
        res.status(403).json({ success: false, message: "Not authorized to access this student's data" });
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
      if (!studentId || typeof studentId !== "string") {
        res.status(400).json({ success: false, message: "studentId is required" });
        return;
      }

      const currentUser = req.user as any;
      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess && !currentUser.isAdmin && !currentUser.isSystemAdmin) {
        res.status(403).json({ success: false, message: "Not authorized to access this student's data" });
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

      // Voice matching is server-authoritative (the client sends a voice
      // embedding, the server matches it), so the voice gallery is purely
      // server-internal — strip it so a 512-dim × N payload doesn't ride along
      // to the kiosk, which only reads `faceEmbedding`.
      const slim = people.map(({ voiceGallery, ...rest }) => rest);

      res.json({
        success: true,
        people: slim,
        count: slim.length,
      });
    } catch (error: any) {
      console.error("[BiometricController] getKnownPeople error:", error);
      res.status(500).json({ success: false, message: "Failed to get known people" });
    }
  }

  /**
   * GET /api/aac/students/:studentId/people-directory
   * Full selectable-people directory for the AAC sentence builder — every
   * active contact, linked user, and the student. Unlike known-people this
   * is NOT gated on having a face embedding, and carries no embeddings; it
   * just tells the client who can be picked and whether a stored photo
   * exists. `optionalAuth` so the student kiosk (often unauthenticated) can
   * read it; the access check only applies when a real user is on the request.
   */
  async getPeopleDirectory(req: Request, res: Response): Promise<void> {
    try {
      const { studentId } = req.params;
      const currentUser = req.user as any;

      if (currentUser?.id) {
        const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
        if (!hasAccess && !currentUser.isAdmin && !currentUser.isSystemAdmin) {
          res.status(403).json({ success: false, message: "Not authorized to access this student's data" });
          return;
        }
      }

      const people = await getPeopleDirectoryForStudent(studentId);
      res.json({ success: true, people, count: people.length });
    } catch (error: any) {
      console.error("[BiometricController] getPeopleDirectory error:", error);
      res.status(500).json({ success: false, message: "Failed to get people directory" });
    }
  }

  /**
   * GET /api/aac/students/:studentId/people/:personId/photo
   * Stream a stored face photo for a person who belongs to this student.
   * The (studentId, personId) pairing is enforced in the service so this
   * can't be used to fetch an arbitrary biometric photo by id. `optionalAuth`
   * mirrors the directory/known-people endpoints (student kiosk access).
   */
  async getPersonPhoto(req: Request, res: Response): Promise<void> {
    try {
      const { studentId, personId } = req.params;
      const currentUser = req.user as any;

      if (currentUser?.id) {
        const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
        if (!hasAccess && !currentUser.isAdmin && !currentUser.isSystemAdmin) {
          res.status(403).json({ success: false, message: "Not authorized to access this student's data" });
          return;
        }
      }

      const faceImageUrl = await getPersonFaceImageUrlForStudent(studentId, personId);
      if (!faceImageUrl) {
        res.status(404).json({ success: false, message: "No photo stored for this person" });
        return;
      }
      if (sendNotModified(req, res, faceImageUrl)) return;
      const buffer = await s3Service.download(faceImageUrl);
      res.setHeader("Content-Type", "image/jpeg");
      res.send(buffer);
    } catch (error: any) {
      console.error("[BiometricController] getPersonPhoto error:", error);
      res.status(500).json({ success: false, message: "Failed to retrieve photo" });
    }
  }
  // ============================================================================
  // STUDENT CONTACTS CRUD
  // ============================================================================

  /**
   * Normalize the `contactPhone` field on the request body to E.164 using
   * the student's country as the disambiguation hint. Throws when the phone
   * value is non-empty but cannot be normalized — surfaces as a 400 to the
   * client. Leaves the field alone when absent or empty.
   */
  private async normalizeContactPhoneInBody(
    body: any,
    studentId: string,
  ): Promise<any> {
    if (!body || typeof body !== "object") return body;
    const raw = (body as any).contactPhone;
    if (raw === undefined || raw === null || raw === "") return body;

    const student = await studentRepository.getStudentById(studentId);
    const country = student?.country ?? "IL";
    const normalized = toE164(String(raw), country);
    if (!normalized) {
      // Throwing a ZodError-shaped object lets the existing handler return 400.
      const err: any = new Error(
        `Phone "${raw}" cannot be normalized to E.164 (country=${country}). ` +
          `Use a country dropdown or enter the number in international format.`,
      );
      err.name = "ZodError";
      err.errors = [{ path: ["contactPhone"], message: err.message }];
      throw err;
    }
    return { ...body, contactPhone: normalized };
  }

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

      const body = await this.normalizeContactPhoneInBody(req.body, studentId);
      const data = insertStudentContactSchema.parse({ ...body, studentId });
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

      const body = await this.normalizeContactPhoneInBody(req.body, studentId);
      const data = updateStudentContactSchema.parse(body);
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

    try {
      const userId = (req.user as any)?.id;
      const result = await uploadBiometricPhoto(target, file.buffer, { embedding, quality, userId });
      res.json({ success: true, ...result });
    } catch (err) {
      if (err instanceof NoFaceDetectedError) {
        res.status(400).json({
          success: false,
          code: "NO_FACE",
          message: err.message,
        });
        return;
      }
      // Our analyzer fell over — nothing is wrong with the photo, so say so and
      // let the clinician retry instead of returning a bare 500.
      if (err instanceof PhotoAnalysisUnavailableError) {
        console.error("[BiometricController] photo analysis unavailable:", err.message);
        res.status(503).json({
          success: false,
          code: "ANALYSIS_UNAVAILABLE",
          message: err.message,
        });
        return;
      }
      throw err;
    }
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
   * Authorize direct biometric-data-by-id access: the caller must be an admin,
   * the user the record belongs to, or have access to a student that owns the
   * record (directly or via one of the student's contacts). Prevents IDOR where
   * any authenticated user could read/modify another tenant's biometric record
   * by supplying its id.
   */
  private async canAccessBiometricData(id: string, currentUser: any): Promise<boolean> {
    if (currentUser?.isAdmin || currentUser?.isSystemAdmin) return true;
    if (!currentUser?.id) return false;
    const { userIds, studentIds } = await getEntitiesForBiometricData(id);
    if (userIds.includes(currentUser.id)) return true;
    for (const studentId of studentIds) {
      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (hasAccess) return true;
    }
    return false;
  }

  /**
   * GET /api/biometric-data/:id/photo
   * Stream the stored JPEG from S3, after verifying the caller is authorized for
   * an entity that owns this biometric_data row.
   */
  async getBiometricPhoto(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      if (!(await this.canAccessBiometricData(id, req.user as any))) {
        res.status(403).json({ success: false, message: "Not authorized to access this record" });
        return;
      }
      const row = await getBiometricData(id);
      if (!row?.faceImageUrl) {
        res.status(404).json({ success: false, message: "No photo stored" });
        return;
      }
      if (sendNotModified(req, res, row.faceImageUrl)) return;
      const buffer = await s3Service.download(row.faceImageUrl);
      res.setHeader("Content-Type", "image/jpeg");
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
      if (!(await this.canAccessBiometricData(id, req.user as any))) {
        res.status(403).json({ success: false, message: "Not authorized to modify this record" });
        return;
      }
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
