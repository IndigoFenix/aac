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

// ─── XLSX → CSV ──────────────────────────────────────────────────────────────
//
// A roster arrives as a spreadsheet more often than anything else, and the zip
// branch above hands the model raw OOXML: thousands of tokens of `<c r="A1"
// t="s"><v>0</v></c>` in which every cell value is an INDEX into a second file.
// The model cannot read that, so a school roster was effectively unreadable.
//
// This is a minimal reader — no dependency beyond the JSZip already in use —
// that resolves the two indirections OOXML puts between a file and its values:
//   sharedStrings.xml  a string cell's <v> is an offset into this table
//   styles.xml         a DATE is a plain number; only the cell's number FORMAT
//                      says so, and the format is itself an index (cellXfs →
//                      numFmtId). Without this every birth date reads "44197".
// Everything else (formulas, merges, colours) is dropped on purpose: the
// consumer is a language model reading a table, not a spreadsheet engine.

/** Cells read per sheet. A roster is hundreds of rows; a workbook can be millions. */
const MAX_SHEET_CELLS = 5000;

/** Excel's serial epoch. Day 1 is 1900-01-01, and day 60 is the 1900 leap-year bug. */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

/** Built-in numFmtIds that mean "this number is a date or a time". */
function isBuiltinDateFormat(id: number): boolean {
  return (id >= 14 && id <= 22) || (id >= 45 && id <= 47);
}

/** A custom format is a date format when it uses day / month / year tokens. */
function isCustomDateFormat(code: string): boolean {
  // Strip quoted literals and colour/condition blocks first, or `"May"` or
  // `[Red]` would make a plain currency format look like a date.
  const bare = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "");
  return /[dmy]/i.test(bare) && !/^[^dmy]*$/i.test(bare);
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&");
}

/** All `<t>` text under one element, concatenated (rich text is split across runs). */
function joinTextNodes(xml: string): string {
  const parts: string[] = [];
  const re = /<t[^>]*>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) parts.push(decodeXmlEntities(m[1]));
  return parts.join("");
}

/** sharedStrings.xml → the string table, in index order. */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(joinTextNodes(m[1]));
  return out;
}

/**
 * styles.xml → for each cell format (the `s` attribute's index), whether it is
 * a date format. cellXfs is the list the `s` attribute indexes into; numFmtId
 * on each entry points either at a built-in id or at a custom `<numFmt>`.
 */
function parseDateStyles(xml: string): boolean[] {
  const custom = new Map<number, string>();
  const fmtRe = /<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"[^>]*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = fmtRe.exec(xml)) !== null) {
    custom.set(parseInt(m[1], 10), decodeXmlEntities(m[2]));
  }

  const block = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (!block) return [];

  const out: boolean[] = [];
  const xfRe = /<xf\b([^>]*)\/?>/g;
  let xf: RegExpExecArray | null;
  while ((xf = xfRe.exec(block[1])) !== null) {
    const idMatch = xf[1].match(/numFmtId="(\d+)"/);
    const id = idMatch ? parseInt(idMatch[1], 10) : 0;
    const code = custom.get(id);
    out.push(code !== undefined ? isCustomDateFormat(code) : isBuiltinDateFormat(id));
  }
  return out;
}

/** An Excel date serial → `YYYY-MM-DD`, or null when it is not a plausible date. */
export function excelSerialToIsoDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
  // Serial 60 is Excel's phantom 1900-02-29; anything at or below it predates
  // the bug's effect, so the offset only applies above it.
  const days = Math.floor(serial) + (serial < 60 ? 1 : 0);
  const ms = EXCEL_EPOCH_UTC + days * 86400000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** A1 → 0, B1 → 1, AA1 → 26. Used to keep empty cells as empty CSV columns. */
function columnIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? "";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** workbook.xml → sheet names in tab order (the sheetN.xml files are not ordered). */
function parseSheetNames(xml: string): string[] {
  const out: string[] = [];
  const re = /<sheet\b[^>]*name="([^"]*)"[^>]*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(decodeXmlEntities(m[1]));
  return out;
}

/** One worksheet's XML → CSV rows. */
function sheetToCsv(xml: string, shared: string[], dateStyles: boolean[]): string {
  const lines: string[] = [];
  let cells = 0;

  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let row: RegExpExecArray | null;
  while ((row = rowRe.exec(xml)) !== null) {
    if (cells >= MAX_SHEET_CELLS) {
      lines.push("# [truncated — sheet exceeds the cell limit]");
      break;
    }
    const values: string[] = [];
    const cellRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cell: RegExpExecArray | null;
    while ((cell = cellRe.exec(row[1])) !== null) {
      const attrs = cell[1];
      const body = cell[2] ?? "";
      const ref = attrs.match(/r="([A-Z]+\d+)"/)?.[1];
      const type = attrs.match(/t="([^"]*)"/)?.[1] ?? "n";
      const style = attrs.match(/s="(\d+)"/)?.[1];

      let text = "";
      if (type === "s") {
        const idx = parseInt(joinValueNode(body), 10);
        text = Number.isFinite(idx) ? (shared[idx] ?? "") : "";
      } else if (type === "inlineStr") {
        text = joinTextNodes(body);
      } else if (type === "str" || type === "e") {
        text = decodeXmlEntities(joinValueNode(body));
      } else if (type === "b") {
        text = joinValueNode(body) === "1" ? "TRUE" : "FALSE";
      } else {
        const raw = joinValueNode(body);
        const isDate = style !== undefined && dateStyles[parseInt(style, 10)] === true;
        text = isDate ? (excelSerialToIsoDate(parseFloat(raw)) ?? raw) : raw;
      }

      if (ref) {
        const col = columnIndex(ref);
        while (values.length < col) values.push("");
        values[col] = text;
      } else {
        values.push(text);
      }
      cells++;
      if (cells >= MAX_SHEET_CELLS) break;
    }
    // A row of nothing but empty cells carries no information for a reader.
    if (values.some((v) => v !== "")) lines.push(values.map(csvEscape).join(","));
  }

  return lines.join("\n");
}

/** The `<v>` payload of a cell, decoded. */
function joinValueNode(body: string): string {
  const m = body.match(/<v[^>]*>([\s\S]*?)<\/v>/);
  return m ? decodeXmlEntities(m[1]) : "";
}

/** True when this zip is an OOXML spreadsheet (a .xlsx is a zip). */
function looksLikeXlsx(zip: JSZip): boolean {
  return !!zip.file("xl/workbook.xml");
}

/**
 * Render every sheet of a workbook as a CSV block. Returns null when the zip is
 * not a workbook, so the caller falls back to the raw-zip listing.
 */
async function extractXlsxCsv(zip: JSZip, filename: string): Promise<string | null> {
  if (!looksLikeXlsx(zip)) return null;

  const workbookXml = await zip.file("xl/workbook.xml")!.async("text");
  const names = parseSheetNames(workbookXml);

  const sharedFile = zip.file("xl/sharedStrings.xml");
  const shared = sharedFile ? parseSharedStrings(await sharedFile.async("text")) : [];
  const stylesFile = zip.file("xl/styles.xml");
  const dateStyles = stylesFile ? parseDateStyles(await stylesFile.async("text")) : [];

  // sheetN.xml is written in tab order in every producer we have seen, but the
  // zip's own entry order is not guaranteed — sort numerically so sheet10 does
  // not land between sheet1 and sheet2.
  const sheetPaths = Object.keys(zip.files)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort((a, b) => {
      const n = (p: string) => parseInt(p.match(/sheet(\d+)\.xml$/)![1], 10);
      return n(a) - n(b);
    });
  if (sheetPaths.length === 0) return null;

  const parts: string[] = [`=== Contents of ${filename} (converted to CSV) ===`];
  let total = 0;
  for (let i = 0; i < sheetPaths.length; i++) {
    if (total >= MAX_TOTAL_SIZE) {
      parts.push(`\n[... truncated — output exceeded ${MAX_TOTAL_SIZE / 1024} KB limit]`);
      break;
    }
    const csv = sheetToCsv(await zip.file(sheetPaths[i])!.async("text"), shared, dateStyles);
    const name = names[i] ?? `sheet${i + 1}`;
    parts.push(`\n# sheet: ${name}`);
    parts.push(csv);
    total += csv.length;
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
    const zip = await JSZip.loadAsync(buffer);
    // A workbook becomes CSV; every other zip keeps the raw listing behaviour.
    let text: string;
    try {
      text = (await extractXlsxCsv(zip, filename)) ?? (await extractZipText(buffer, filename));
    } catch (err) {
      console.warn("[file-extractor] xlsx conversion failed, falling back to raw zip:", err);
      text = await extractZipText(buffer, filename);
    }
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
