// server/services/chat/tools/media-file-cache.ts
// Temporary server-side cache for large media files (videos)
// Files are stored in memory with a TTL and referenced by ID in chat messages

import crypto from "crypto";

interface CachedFile {
  id: string;
  buffer: Buffer;
  mimeType: string;
  filename: string;
  createdAt: number;
}

const FILE_TTL_MS = 10 * 60 * 1000; // 10 minutes (client can re-send if expired)
const EXPIRY_WARNING_MS = 2 * 60 * 1000; // warn when <2 minutes remaining
const cache = new Map<string, CachedFile>();

// Periodic cleanup every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, file] of cache) {
    if (now - file.createdAt > FILE_TTL_MS) {
      cache.delete(id);
    }
  }
}, 5 * 60 * 1000);

/**
 * Store a file in the cache and return its ID.
 */
export function storeFile(buffer: Buffer, mimeType: string, filename: string): string {
  const id = crypto.randomUUID();
  cache.set(id, { id, buffer, mimeType, filename, createdAt: Date.now() });
  return id;
}

/**
 * Re-store a file with the same ID (used when client re-sends an expired file).
 */
export function restoreFile(id: string, buffer: Buffer, mimeType: string, filename: string): void {
  cache.set(id, { id, buffer, mimeType, filename, createdAt: Date.now() });
}

/**
 * Retrieve a cached file by ID. Returns undefined if expired or not found.
 */
export function getFile(id: string): CachedFile | undefined {
  const file = cache.get(id);
  if (!file) return undefined;
  if (Date.now() - file.createdAt > FILE_TTL_MS) {
    cache.delete(id);
    return undefined;
  }
  return file;
}

/**
 * Check if a file is expired or about to expire.
 */
export function getFileStatus(id: string): "valid" | "expiring" | "expired" {
  const file = cache.get(id);
  if (!file) return "expired";
  const age = Date.now() - file.createdAt;
  if (age > FILE_TTL_MS) {
    cache.delete(id);
    return "expired";
  }
  if (age > FILE_TTL_MS - EXPIRY_WARNING_MS) {
    return "expiring";
  }
  return "valid";
}

/**
 * Refresh the TTL of a cached file (call when it's accessed).
 */
export function refreshFile(id: string): boolean {
  const file = cache.get(id);
  if (!file) return false;
  file.createdAt = Date.now();
  return true;
}

/**
 * Get metadata for a file without the buffer (for status checks).
 */
export function getFileMeta(id: string): { filename: string; mimeType: string } | undefined {
  const file = cache.get(id);
  if (!file) return undefined;
  return { filename: file.filename, mimeType: file.mimeType };
}

/**
 * Delete a cached file.
 */
export function deleteFile(id: string): boolean {
  return cache.delete(id);
}

/**
 * Convert a cached file to a base64 data URL (for small files passed inline to Gemini).
 */
export function fileToDataUrl(file: CachedFile): string {
  return `data:${file.mimeType};base64,${file.buffer.toString("base64")}`;
}
