/**
 * File Extractor
 *
 * Extracts readable text from uploaded files so the LLM receives clean text
 * instead of raw base64 blobs it can't interpret.
 *
 * Supports:
 *  - ZIP archives (detected by magic bytes, not extension) — extracts text entries
 *  - Plain text formats (txt, md, json, csv, xml, html, css, js, ts, py, etc.)
 *  - PDFs are left as-is for Claude's native document support
 *  - Images are left as-is for multimodal support
 */

import JSZip from "jszip";

// ─── Magic-byte detection ────────────────────────────────────────────────────

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04

function isZipBuffer(buf: Buffer): boolean {
  return buf.length >= 4 && buf.subarray(0, 4).equals(ZIP_MAGIC);
}

// ─── MIME / extension helpers ────────────────────────────────────────────────

const TEXT_MIME_PREFIXES = ["text/", "application/json", "application/xml", "application/javascript"];
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "json", "csv", "xml", "html", "htm", "css",
  "js", "ts", "jsx", "tsx", "py", "java", "c", "cpp", "h", "hpp",
  "rb", "go", "rs", "swift", "kt", "sh", "bash", "yaml", "yml",
  "toml", "ini", "cfg", "conf", "log", "sql", "graphql", "svg",
]);

function isTextMime(mime: string): boolean {
  return TEXT_MIME_PREFIXES.some((p) => mime.startsWith(p));
}

function isTextExtension(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTENSIONS.has(ext);
}

function isPdfMime(mime: string): boolean {
  return mime === "application/pdf";
}

function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

// ─── Data-URL helpers ────────────────────────────────────────────────────────

function parseDataUrl(dataUrl: string): { mime: string; buffer: Buffer } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) {
    throw new Error("Invalid data URL format");
  }
  return { mime: match[1], buffer: Buffer.from(match[2], "base64") };
}

function textToDataUrl(text: string, filename: string): string {
  const base64 = Buffer.from(text, "utf-8").toString("base64");
  return `data:text/plain;base64,${base64}`;
}

// ─── ZIP extraction ──────────────────────────────────────────────────────────

/** Size limit for extracted text per zip entry (256 KB) */
const MAX_ENTRY_SIZE = 256 * 1024;
/** Total size limit for all extracted text from a zip (1 MB) */
const MAX_TOTAL_SIZE = 1024 * 1024;

async function extractZipText(buf: Buffer, archiveFilename: string): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const parts: string[] = [];
  let totalSize = 0;

  parts.push(`=== Contents of ${archiveFilename} ===\n`);

  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;

    // Only extract entries that look like text
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    if (!TEXT_EXTENSIONS.has(ext) && ext !== "xml") {
      // Still list non-text entries so the LLM knows they exist
      parts.push(`[binary file: ${path}]`);
      continue;
    }

    if (totalSize >= MAX_TOTAL_SIZE) {
      parts.push(`\n[... truncated — extracted text exceeded ${MAX_TOTAL_SIZE / 1024} KB limit]`);
      break;
    }

    try {
      let text = await entry.async("text");
      if (text.length > MAX_ENTRY_SIZE) {
        text = text.slice(0, MAX_ENTRY_SIZE) + `\n[... truncated at ${MAX_ENTRY_SIZE / 1024} KB]`;
      }
      parts.push(`\n--- ${path} ---\n${text}`);
      totalSize += text.length;
    } catch {
      parts.push(`[failed to read: ${path}]`);
    }
  }

  return parts.join("\n");
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface ExtractedDocument {
  /** The text content, or undefined if the file should be passed through as-is */
  text?: string;
  /** If set, replace the original dataUrl with this one */
  dataUrl?: string;
  /** Filename (may be unchanged) */
  filename: string;
  /** Whether extraction modified the document */
  extracted: boolean;
}

/**
 * Attempt to extract readable text from a document data URL.
 *
 * Returns `extracted: true` with the text content when extraction succeeds.
 * Returns `extracted: false` when the file should be passed through as-is
 * (images, PDFs for Claude, etc.).
 */
export async function extractDocument(
  dataUrl: string,
  filename: string
): Promise<ExtractedDocument> {
  let parsed: { mime: string; buffer: Buffer };
  try {
    parsed = parseDataUrl(dataUrl);
  } catch {
    return { filename, extracted: false };
  }

  const { mime, buffer } = parsed;

  // Images → pass through for multimodal
  if (isImageMime(mime)) {
    return { filename, extracted: false };
  }

  // Check for zip by magic bytes (covers .gridset, .docx, .xlsx, .pptx, renamed zips, etc.)
  if (isZipBuffer(buffer)) {
    const text = await extractZipText(buffer, filename);
    return {
      text,
      dataUrl: textToDataUrl(text, filename),
      filename,
      extracted: true,
    };
  }

  // PDFs → pass through for Claude's native document handling
  if (isPdfMime(mime)) {
    return { filename, extracted: false };
  }

  // Plain text formats → decode from base64
  if (isTextMime(mime) || isTextExtension(filename)) {
    let text = buffer.toString("utf-8");
    if (text.length > MAX_TOTAL_SIZE) {
      text = text.slice(0, MAX_TOTAL_SIZE) + `\n[... truncated at ${MAX_TOTAL_SIZE / 1024} KB]`;
    }
    return {
      text,
      dataUrl: textToDataUrl(text, filename),
      filename,
      extracted: true,
    };
  }

  // Unknown binary format — try zip detection one more time (MIME might be wrong)
  // Otherwise pass through as-is
  return { filename, extracted: false };
}
