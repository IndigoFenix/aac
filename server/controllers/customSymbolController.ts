import type { Request, Response } from "express";
import { customSymbolRepository } from "../repositories/customSymbolRepository";
import { customSymbolService } from "../services/symbol/custom-symbol-service";
import { generateSymbolImage } from "../services/symbol/symbol-generator";
import { symbolEvents } from "../services/symbol/auto-symbol-service";

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

  /** POST /api/custom-symbols/resolve-keys — batch resolve multiple imageKeys at once */
  async resolveKeys(req: Request, res: Response) {
    try {
      const { keys } = req.body;
      if (!Array.isArray(keys) || keys.length === 0) {
        return res.status(400).json({ message: "keys array required" });
      }
      // Cap at 100 keys per request
      const lookupKeys = keys.slice(0, 100) as string[];
      const resolved: Record<string, { id: string; symbolPath: string }> = {};
      for (const key of lookupKeys) {
        try {
          const symbol = await customSymbolRepository.getSymbolByKey(key);
          if (symbol) {
            resolved[key] = { id: symbol.id, symbolPath: `/api/custom-symbols/${symbol.id}/image` };
          }
        } catch { /* skip individual failures */ }
      }
      res.json(resolved);
    } catch (error: any) {
      console.error("[CustomSymbolController] resolveKeys error:", error);
      res.status(500).json({ message: "Failed to resolve keys" });
    }
  }

  /** GET /api/custom-symbols/watch?keys=key1,key2,key3 — SSE stream for symbol resolution */
  async watchSymbols(req: Request, res: Response) {
    try {
      // Parse keys from query
      const keysParam = req.query.keys as string | undefined;
      const watchedKeys = new Set(
        keysParam ? keysParam.split(",").filter(Boolean).slice(0, 100) : []
      );

      if (watchedKeys.size === 0) {
        return res.status(400).json({ message: "keys query parameter required" });
      }

      // Set up SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      const sendEvent = (event: string, data: Record<string, any>) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        if (typeof (res as any).flush === "function") (res as any).flush();
      };

      // Phase 1: Batch-resolve existing symbols immediately
      for (const key of watchedKeys) {
        try {
          const symbol = await customSymbolRepository.getSymbolByKey(key);
          if (symbol) {
            sendEvent("symbol_resolved", {
              imageKey: key,
              symbolPath: `/api/custom-symbols/${symbol.id}/image`,
            });
            watchedKeys.delete(key);
          } else {
            sendEvent("symbol_pending", { imageKey: key });
          }
        } catch { /* skip individual failures */ }
      }

      // If all resolved immediately, close
      if (watchedKeys.size === 0) {
        sendEvent("all_resolved", {});
        res.end();
        return;
      }

      // Phase 2: Subscribe to symbol events for remaining keys
      const onReady = (payload: { imageKey: string; symbolId: string; symbolPath: string }) => {
        if (!watchedKeys.has(payload.imageKey)) return;
        sendEvent("symbol_resolved", {
          imageKey: payload.imageKey,
          symbolPath: payload.symbolPath,
        });
        watchedKeys.delete(payload.imageKey);
        if (watchedKeys.size === 0) {
          sendEvent("all_resolved", {});
          cleanup();
          res.end();
        }
      };

      const onFailed = (payload: { imageKey: string; error: string; isQuota: boolean }) => {
        if (!watchedKeys.has(payload.imageKey)) return;
        sendEvent("symbol_failed", {
          imageKey: payload.imageKey,
          error: payload.error,
        });
        watchedKeys.delete(payload.imageKey);
        if (payload.isQuota) {
          // Mark all remaining as failed too (quota affects the whole queue)
          for (const key of watchedKeys) {
            sendEvent("symbol_failed", { imageKey: key, error: "Quota exhausted" });
          }
          watchedKeys.clear();
        }
        if (watchedKeys.size === 0) {
          sendEvent("all_resolved", {});
          cleanup();
          res.end();
        }
      };

      symbolEvents.on("symbol:ready", onReady);
      symbolEvents.on("symbol:failed", onFailed);

      // Keepalive every 30s
      const keepalive = setInterval(() => {
        res.write(": keepalive\n\n");
      }, 30000);

      const cleanup = () => {
        symbolEvents.off("symbol:ready", onReady);
        symbolEvents.off("symbol:failed", onFailed);
        clearInterval(keepalive);
      };

      req.on("close", cleanup);
    } catch (error: any) {
      console.error("[CustomSymbolController] watchSymbols error:", error);
      if (!res.headersSent) {
        res.status(500).json({ message: "Failed to watch symbols" });
      }
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
