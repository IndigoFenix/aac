// server/services/chat/openai-file-service.ts
// Service for managing file uploads to OpenAI for use with file_search tool

import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env["OPENAI_API_KEY"],
});

// Track vector stores per session (in production, store in database/Redis)
const sessionVectorStores = new Map<string, string>();

// Track files per session for cleanup
const sessionFiles = new Map<string, string[]>();

export interface UploadedFileInfo {
  fileId: string;
  vectorStoreId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface FileUploadResult {
  success: boolean;
  file?: UploadedFileInfo;
  error?: string;
}

export class OpenAIFileService {
  /**
   * Get or create a vector store for a session
   */
  async getOrCreateVectorStore(sessionId: string): Promise<string> {
    // Check if we already have a vector store for this session
    const existingStoreId = sessionVectorStores.get(sessionId);
    if (existingStoreId) {
      // Verify it still exists
      try {
        await openai.vectorStores.retrieve(existingStoreId);
        return existingStoreId;
      } catch {
        // Store was deleted, create a new one
        sessionVectorStores.delete(sessionId);
      }
    }

    // Create a new vector store for this session
    const vectorStore = await openai.vectorStores.create({
      name: `chat-session-${sessionId}`,
      expires_after: {
        anchor: "last_active_at",
        days: 1, // Auto-delete after 1 day of inactivity
      },
    });

    sessionVectorStores.set(sessionId, vectorStore.id);
    sessionFiles.set(sessionId, []);

    console.log(`[OpenAIFileService] Created vector store ${vectorStore.id} for session ${sessionId}`);

    return vectorStore.id;
  }

  /**
   * Upload a file to OpenAI and add it to the session's vector store
   * Waits for file processing to complete before returning
   */
  async uploadFile(
    sessionId: string,
    fileBuffer: Buffer,
    filename: string,
    mimeType: string
  ): Promise<FileUploadResult> {
    try {
      // Get or create vector store for this session
      const vectorStoreId = await this.getOrCreateVectorStore(sessionId);

      // Create a File object from the buffer
      const file = new File([fileBuffer], filename, { type: mimeType });

      // Upload file to OpenAI
      const uploadedFile = await openai.files.create({
        file: file,
        purpose: "assistants", // Required for file_search
      });

      console.log(`[OpenAIFileService] Uploaded file ${uploadedFile.id} (${filename})`);

      // Add file to vector store
      const vectorStoreFile = await openai.vectorStores.files.create(vectorStoreId, {
        file_id: uploadedFile.id,
      });

      console.log(`[OpenAIFileService] Added file ${uploadedFile.id} to vector store ${vectorStoreId}, status: ${vectorStoreFile.status}`);

      // Wait for file processing to complete (poll until status is 'completed' or 'failed')
      const maxWaitMs = 60000; // 60 seconds max wait
      const pollIntervalMs = 1000; // Poll every second
      const startTime = Date.now();

      let currentStatus = vectorStoreFile.status;
      let lastFileStatus: any = vectorStoreFile;
      while (currentStatus === 'in_progress' && (Date.now() - startTime) < maxWaitMs) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

        // Retrieve file status from vector store (file_id first, then options with vector_store_id)
        lastFileStatus = await openai.vectorStores.files.retrieve(uploadedFile.id, {
          vector_store_id: vectorStoreId,
        } as any);
        currentStatus = lastFileStatus.status;
        console.log(`[OpenAIFileService] File ${uploadedFile.id} processing status: ${currentStatus}`);
      }

      if (currentStatus === 'failed') {
        const detail = lastFileStatus?.last_error?.message || "unknown reason";
        throw new Error(`File processing failed: ${detail} (${filename})`);
      }

      if (currentStatus === 'in_progress') {
        console.warn(`[OpenAIFileService] File ${uploadedFile.id} still processing after ${maxWaitMs}ms, proceeding anyway`);
      }

      if (currentStatus === 'completed') {
        console.log(`[OpenAIFileService] File ${uploadedFile.id} processing completed successfully`);
      }

      // Track file for cleanup
      const files = sessionFiles.get(sessionId) || [];
      files.push(uploadedFile.id);
      sessionFiles.set(sessionId, files);

      return {
        success: true,
        file: {
          fileId: uploadedFile.id,
          vectorStoreId,
          filename,
          mimeType,
          size: fileBuffer.length,
        },
      };
    } catch (error: any) {
      console.error("[OpenAIFileService] Upload failed:", error);
      return {
        success: false,
        error: error.message || "Failed to upload file",
      };
    }
  }

  /**
   * Get vector store ID for a session (if exists)
   */
  getVectorStoreId(sessionId: string): string | undefined {
    return sessionVectorStores.get(sessionId);
  }

  /**
   * Delete a specific file from OpenAI
   */
  async deleteFile(fileId: string): Promise<boolean> {
    try {
      await openai.files.delete(fileId);
      console.log(`[OpenAIFileService] Deleted file ${fileId}`);
      return true;
    } catch (error) {
      console.error(`[OpenAIFileService] Failed to delete file ${fileId}:`, error);
      return false;
    }
  }

  /**
   * Clean up all files and vector store for a session
   */
  async cleanupSession(sessionId: string): Promise<void> {
    const vectorStoreId = sessionVectorStores.get(sessionId);
    const fileIds = sessionFiles.get(sessionId) || [];

    // Delete all files
    for (const fileId of fileIds) {
      await this.deleteFile(fileId);
    }

    // Delete vector store
    if (vectorStoreId) {
      try {
        await openai.vectorStores.delete(vectorStoreId);
        console.log(`[OpenAIFileService] Deleted vector store ${vectorStoreId}`);
      } catch (error) {
        console.error(`[OpenAIFileService] Failed to delete vector store:`, error);
      }
    }

    // Clean up maps
    sessionVectorStores.delete(sessionId);
    sessionFiles.delete(sessionId);
  }

  /**
   * List all files in a session's vector store
   */
  async listSessionFiles(sessionId: string): Promise<string[]> {
    return sessionFiles.get(sessionId) || [];
  }
}

export const openAIFileService = new OpenAIFileService();
