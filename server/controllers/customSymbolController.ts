import type { Request, Response } from "express";
import { customSymbolRepository } from "../repositories/customSymbolRepository";
import { customSymbolService } from "../services/symbol/custom-symbol-service";
import { generateSymbolImage } from "../services/symbol/symbol-generator";

class CustomSymbolController {
  // ==================== Symbol CRUD ====================

  /** POST /api/custom-symbols — create symbol from uploaded image */
  async createSymbol(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });

      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) return res.status(400).json({ message: "Image file required" });

      const { key, description, isPublic } = req.body;
      const symbol = await customSymbolService.createSymbol(file.buffer, {
        key: key || undefined,
        description: description || undefined,
        isPublic: isPublic === "true" || isPublic === true,
        createdByUserId: userId,
      });

      res.status(201).json(symbol);
    } catch (error: any) {
      console.error("[CustomSymbolController] createSymbol error:", error);
      res.status(500).json({ message: error.message || "Failed to create symbol" });
    }
  }

  /** POST /api/custom-symbols/generate — AI-generate a symbol preview */
  async generateSymbol(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });

      const { description } = req.body;
      if (!description) return res.status(400).json({ message: "Description required" });

      const imageBuffer = await generateSymbolImage(description);
      const base64 = imageBuffer.toString("base64");

      res.json({ image: `data:image/png;base64,${base64}`, description });
    } catch (error: any) {
      console.error("[CustomSymbolController] generateSymbol error:", error);
      res.status(500).json({ message: error.message || "Failed to generate symbol" });
    }
  }

  /** GET /api/custom-symbols/search?q=... */
  async searchSymbols(req: Request, res: Response) {
    try {
      const query = req.query.q as string;
      if (!query) return res.status(400).json({ message: "Query parameter 'q' required" });

      const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
      const symbols = await customSymbolRepository.searchSymbols(query, limit);
      res.json(symbols);
    } catch (error: any) {
      console.error("[CustomSymbolController] searchSymbols error:", error);
      res.status(500).json({ message: "Failed to search symbols" });
    }
  }

  /** GET /api/custom-symbols/my — user's symbols */
  async getMySymbols(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });

      const symbols = await customSymbolRepository.getSymbolsByUser(userId);
      res.json(symbols);
    } catch (error: any) {
      console.error("[CustomSymbolController] getMySymbols error:", error);
      res.status(500).json({ message: "Failed to get symbols" });
    }
  }

  /** GET /api/custom-symbols/student/:studentId */
  async getStudentSymbols(req: Request, res: Response) {
    try {
      const { studentId } = req.params;
      const symbols = await customSymbolRepository.getSymbolsByStudent(studentId);
      res.json(symbols);
    } catch (error: any) {
      console.error("[CustomSymbolController] getStudentSymbols error:", error);
      res.status(500).json({ message: "Failed to get student symbols" });
    }
  }

  /** GET /api/custom-symbols/institute/:instituteId */
  async getInstituteSymbols(req: Request, res: Response) {
    try {
      const { instituteId } = req.params;
      const symbols = await customSymbolRepository.getSymbolsByInstitute(instituteId);
      res.json(symbols);
    } catch (error: any) {
      console.error("[CustomSymbolController] getInstituteSymbols error:", error);
      res.status(500).json({ message: "Failed to get institute symbols" });
    }
  }

  /** GET /api/custom-symbols/public */
  async getPublicSymbols(req: Request, res: Response) {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      const offset = parseInt(req.query.offset as string) || 0;
      const symbols = await customSymbolRepository.getPublicSymbols(limit, offset);
      res.json(symbols);
    } catch (error: any) {
      console.error("[CustomSymbolController] getPublicSymbols error:", error);
      res.status(500).json({ message: "Failed to get public symbols" });
    }
  }

  /** GET /api/custom-symbols/by-key/:key — look up a symbol by its imageKey */
  async getSymbolByKey(req: Request, res: Response) {
    try {
      const { key } = req.params;
      const symbol = await customSymbolRepository.getSymbolByKey(key);
      if (!symbol) return res.status(404).json({ message: "Symbol not found" });
      res.json(symbol);
    } catch (error: any) {
      console.error("[CustomSymbolController] getSymbolByKey error:", error);
      res.status(500).json({ message: "Failed to get symbol by key" });
    }
  }

  /** GET /api/custom-symbols/unapproved — list unapproved auto-generated symbols (admin review) */
  async getUnapprovedSymbols(req: Request, res: Response) {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      const offset = parseInt(req.query.offset as string) || 0;
      const symbols = await customSymbolRepository.getUnapprovedSymbols(limit, offset);
      res.json(symbols);
    } catch (error: any) {
      console.error("[CustomSymbolController] getUnapprovedSymbols error:", error);
      res.status(500).json({ message: "Failed to get unapproved symbols" });
    }
  }

  /** GET /api/custom-symbols/available/:studentId — resolved symbols for student */
  async getAvailableSymbols(req: Request, res: Response) {
    try {
      const { studentId } = req.params;
      const symbols = await customSymbolRepository.getAvailableSymbolsForStudent(studentId);
      res.json(symbols);
    } catch (error: any) {
      console.error("[CustomSymbolController] getAvailableSymbols error:", error);
      res.status(500).json({ message: "Failed to get available symbols" });
    }
  }

  /** GET /api/custom-symbols/:id — symbol metadata */
  async getSymbol(req: Request, res: Response) {
    try {
      const symbol = await customSymbolRepository.getSymbol(req.params.id);
      if (!symbol) return res.status(404).json({ message: "Symbol not found" });
      res.json(symbol);
    } catch (error: any) {
      console.error("[CustomSymbolController] getSymbol error:", error);
      res.status(500).json({ message: "Failed to get symbol" });
    }
  }

  /** GET /api/custom-symbols/:id/image — stream image from S3 */
  async getSymbolImage(req: Request, res: Response) {
    try {
      const buffer = await customSymbolService.getSymbolImage(req.params.id);
      if (!buffer) return res.status(404).json({ message: "Symbol not found" });

      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.send(buffer);
    } catch (error: any) {
      console.error("[CustomSymbolController] getSymbolImage error:", error);
      res.status(500).json({ message: "Failed to get symbol image" });
    }
  }

  /** PATCH /api/custom-symbols/:id */
  async updateSymbol(req: Request, res: Response) {
    try {
      const { key, description, isPublic, isApproved } = req.body;
      const updated = await customSymbolRepository.updateSymbol(req.params.id, {
        ...(key !== undefined && { key }),
        ...(description !== undefined && { description }),
        ...(isPublic !== undefined && { isPublic }),
        ...(isApproved !== undefined && { isApproved }),
      });
      if (!updated) return res.status(404).json({ message: "Symbol not found" });
      res.json(updated);
    } catch (error: any) {
      console.error("[CustomSymbolController] updateSymbol error:", error);
      res.status(500).json({ message: "Failed to update symbol" });
    }
  }

  /** DELETE /api/custom-symbols/:id */
  async deleteSymbol(req: Request, res: Response) {
    try {
      const symbol = await customSymbolRepository.getSymbol(req.params.id);
      if (!symbol) return res.status(404).json({ message: "Symbol not found" });

      // Delete S3 object
      try {
        const { s3Service } = await import("../services/storage/s3-service");
        await s3Service.delete(symbol.s3Key);
      } catch { /* ignore S3 errors */ }

      await customSymbolRepository.deleteSymbol(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      console.error("[CustomSymbolController] deleteSymbol error:", error);
      res.status(500).json({ message: "Failed to delete symbol" });
    }
  }

  // ==================== User Associations ====================

  /** POST /api/custom-symbols/:id/user-associate */
  async createUserAssociation(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });

      const { key, description } = req.body;
      const assoc = await customSymbolRepository.createUserAssociation({
        symbolId: req.params.id,
        userId,
        key: key || null,
        description: description || null,
      });
      res.status(201).json(assoc);
    } catch (error: any) {
      if (error.code === "23505") return res.status(409).json({ message: "Association already exists" });
      console.error("[CustomSymbolController] createUserAssociation error:", error);
      res.status(500).json({ message: "Failed to create association" });
    }
  }

  /** POST /api/custom-symbols/:id/student-associate */
  async createStudentAssociation(req: Request, res: Response) {
    try {
      const { studentId, key, description } = req.body;
      if (!studentId) return res.status(400).json({ message: "studentId required" });

      const assoc = await customSymbolRepository.createStudentAssociation({
        symbolId: req.params.id,
        studentId,
        key: key || null,
        description: description || null,
      });
      res.status(201).json(assoc);
    } catch (error: any) {
      if (error.code === "23505") return res.status(409).json({ message: "Association already exists" });
      console.error("[CustomSymbolController] createStudentAssociation error:", error);
      res.status(500).json({ message: "Failed to create association" });
    }
  }

  /** POST /api/custom-symbols/:id/institute-associate */
  async createInstituteAssociation(req: Request, res: Response) {
    try {
      const { instituteId, key, description } = req.body;
      if (!instituteId) return res.status(400).json({ message: "instituteId required" });

      const assoc = await customSymbolRepository.createInstituteAssociation({
        symbolId: req.params.id,
        instituteId,
        key: key || null,
        description: description || null,
      });
      res.status(201).json(assoc);
    } catch (error: any) {
      if (error.code === "23505") return res.status(409).json({ message: "Association already exists" });
      console.error("[CustomSymbolController] createInstituteAssociation error:", error);
      res.status(500).json({ message: "Failed to create association" });
    }
  }

  // ==================== Association Updates ====================

  /** PATCH /api/custom-symbols/user-associations/:assocId */
  async updateUserAssociation(req: Request, res: Response) {
    try {
      const { key, description, isApproved } = req.body;
      const updated = await customSymbolRepository.updateUserAssociation(req.params.assocId, {
        ...(key !== undefined && { key }),
        ...(description !== undefined && { description }),
        ...(isApproved !== undefined && { isApproved }),
      });
      if (!updated) return res.status(404).json({ message: "Association not found" });
      res.json(updated);
    } catch (error: any) {
      console.error("[CustomSymbolController] updateUserAssociation error:", error);
      res.status(500).json({ message: "Failed to update association" });
    }
  }

  /** PATCH /api/custom-symbols/student-associations/:assocId */
  async updateStudentAssociation(req: Request, res: Response) {
    try {
      const { key, description, isApproved } = req.body;
      const updated = await customSymbolRepository.updateStudentAssociation(req.params.assocId, {
        ...(key !== undefined && { key }),
        ...(description !== undefined && { description }),
        ...(isApproved !== undefined && { isApproved }),
      });
      if (!updated) return res.status(404).json({ message: "Association not found" });
      res.json(updated);
    } catch (error: any) {
      console.error("[CustomSymbolController] updateStudentAssociation error:", error);
      res.status(500).json({ message: "Failed to update association" });
    }
  }

  /** PATCH /api/custom-symbols/institute-associations/:assocId */
  async updateInstituteAssociation(req: Request, res: Response) {
    try {
      const { key, description, isApproved } = req.body;
      const updated = await customSymbolRepository.updateInstituteAssociation(req.params.assocId, {
        ...(key !== undefined && { key }),
        ...(description !== undefined && { description }),
        ...(isApproved !== undefined && { isApproved }),
      });
      if (!updated) return res.status(404).json({ message: "Association not found" });
      res.json(updated);
    } catch (error: any) {
      console.error("[CustomSymbolController] updateInstituteAssociation error:", error);
      res.status(500).json({ message: "Failed to update association" });
    }
  }

  // ==================== Association Deletes ====================

  /** DELETE /api/custom-symbols/user-associations/:assocId */
  async deleteUserAssociation(req: Request, res: Response) {
    try {
      const assoc = await customSymbolRepository.getUserAssociation(req.params.assocId);
      if (!assoc) return res.status(404).json({ message: "Association not found" });

      await customSymbolRepository.deleteUserAssociation(req.params.assocId);
      // Orphan cleanup
      await customSymbolService.deleteSymbolIfOrphaned(assoc.symbolId);
      res.json({ success: true });
    } catch (error: any) {
      console.error("[CustomSymbolController] deleteUserAssociation error:", error);
      res.status(500).json({ message: "Failed to delete association" });
    }
  }

  /** DELETE /api/custom-symbols/student-associations/:assocId */
  async deleteStudentAssociation(req: Request, res: Response) {
    try {
      const assoc = await customSymbolRepository.getStudentAssociation(req.params.assocId);
      if (!assoc) return res.status(404).json({ message: "Association not found" });

      await customSymbolRepository.deleteStudentAssociation(req.params.assocId);
      await customSymbolService.deleteSymbolIfOrphaned(assoc.symbolId);
      res.json({ success: true });
    } catch (error: any) {
      console.error("[CustomSymbolController] deleteStudentAssociation error:", error);
      res.status(500).json({ message: "Failed to delete association" });
    }
  }

  /** DELETE /api/custom-symbols/institute-associations/:assocId */
  async deleteInstituteAssociation(req: Request, res: Response) {
    try {
      const assoc = await customSymbolRepository.getInstituteAssociation(req.params.assocId);
      if (!assoc) return res.status(404).json({ message: "Association not found" });

      await customSymbolRepository.deleteInstituteAssociation(req.params.assocId);
      await customSymbolService.deleteSymbolIfOrphaned(assoc.symbolId);
      res.json({ success: true });
    } catch (error: any) {
      console.error("[CustomSymbolController] deleteInstituteAssociation error:", error);
      res.status(500).json({ message: "Failed to delete association" });
    }
  }
}

export const customSymbolController = new CustomSymbolController();
