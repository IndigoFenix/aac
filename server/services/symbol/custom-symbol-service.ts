import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";
import { s3Service } from "../storage/s3-service";
import { customSymbolRepository, type ResolvedSymbol } from "../../repositories/customSymbolRepository";
import type { CustomSymbol } from "@shared/schema";

export interface CreateSymbolOptions {
  key?: string;
  description?: string;
  isPublic?: boolean;
  isApproved?: boolean;
  /** Depicts an identifiable person (e.g. a staff portrait). Barred from public
   *  packages and access-gated when the image is served. See aac-packages-plan.md §3. */
  personImage?: boolean;
  createdByUserId?: string;
}

export const customSymbolService = {
  /**
   * Create a symbol from an image buffer. Resizes to 256x256 PNG and uploads to S3.
   */
  async createSymbol(imageBuffer: Buffer, options: CreateSymbolOptions): Promise<CustomSymbol> {
    // Resize and compress to 256x256 PNG
    const processed = await sharp(imageBuffer)
      .resize(256, 256, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 } })
      .png()
      .toBuffer();

    const id = uuidv4();
    const s3Key = `symbols/${id}.png`;

    await s3Service.upload(s3Key, processed, "image/png");

    return customSymbolRepository.createSymbol({
      s3Key,
      key: options.key || null,
      description: options.description || null,
      isPublic: options.isPublic || false,
      isApproved: options.isApproved ?? true,
      personImage: options.personImage || false,
      createdByUserId: options.createdByUserId || null,
      width: 256,
      height: 256,
    });
  },

  /**
   * Get a symbol's image buffer from S3.
   */
  async getSymbolImage(symbolId: string): Promise<Buffer | null> {
    const symbol = await customSymbolRepository.getSymbol(symbolId);
    if (!symbol) return null;
    return s3Service.download(symbol.s3Key);
  },

  /**
   * Replace the image bytes of an existing symbol. Resizes to 256x256 PNG
   * and overwrites the object at the existing s3Key, then bumps updatedAt.
   * Returns the updated symbol row, or undefined if the symbol is missing.
   *
   * The s3Key is intentionally reused so cached references on associations
   * stay valid; cache invalidation is the caller's job (clients should
   * append ?v=<updatedAt> when fetching the image).
   */
  async replaceSymbolImage(symbolId: string, imageBuffer: Buffer): Promise<CustomSymbol | undefined> {
    const symbol = await customSymbolRepository.getSymbol(symbolId);
    if (!symbol) return undefined;

    const processed = await sharp(imageBuffer)
      .resize(256, 256, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 } })
      .png()
      .toBuffer();

    await s3Service.upload(symbol.s3Key, processed, "image/png");

    return customSymbolRepository.updateSymbol(symbolId, {
      width: 256,
      height: 256,
    });
  },

  /**
   * Delete a symbol if it has no associations remaining and is not public.
   */
  async deleteSymbolIfOrphaned(symbolId: string): Promise<boolean> {
    const symbol = await customSymbolRepository.getSymbol(symbolId);
    if (!symbol) return false;
    if (symbol.isPublic) return false;

    const count = await customSymbolRepository.countAllAssociationsForSymbol(symbolId);
    if (count > 0) return false;

    // Delete from S3 and DB
    try { await s3Service.delete(symbol.s3Key); } catch { /* ignore S3 errors */ }
    return customSymbolRepository.deleteSymbol(symbolId);
  },

  /**
   * Get resolved symbols available to a student (for AAC prompt).
   */
  async getSymbolsForStudentPrompt(studentId: string): Promise<ResolvedSymbol[]> {
    return customSymbolRepository.getAvailableSymbolsForStudent(studentId);
  },
};
