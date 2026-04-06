// server/services/chat/tools/video-frame-extractor.ts
// Extract a single frame from a video buffer at a given timestamp using ffmpeg

import { execFile } from "child_process";
import { writeFile, readFile, unlink, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import { createRequire } from "module";
const require = createRequire(import.meta.url);

/**
 * Get the ffmpeg binary path. Uses ffmpeg-static in dev,
 * falls back to system ffmpeg (e.g. Lambda layer).
 */
function getFfmpegPath(): string {
  try {
    return require("ffmpeg-static") as string;
  } catch {
    return "ffmpeg"; // system PATH fallback
  }
}

/**
 * Extract a single frame from a video at the given timestamp.
 * @param videoBuffer Raw video file bytes
 * @param mimeType Video MIME type (e.g. "video/mp4")
 * @param timestampSeconds Timestamp in seconds (e.g. 5.0)
 * @returns PNG image buffer of the extracted frame
 */
export async function extractFrame(
  videoBuffer: Buffer,
  mimeType: string,
  timestampSeconds: number = 0,
): Promise<Buffer> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "frame-"));
  const ext = mimeType.split("/")[1] || "mp4";
  const inputPath = path.join(tmpDir, `input.${ext}`);
  const outputPath = path.join(tmpDir, "frame.png");

  try {
    await writeFile(inputPath, videoBuffer);

    const ffmpeg = getFfmpegPath();
    await new Promise<void>((resolve, reject) => {
      execFile(
        ffmpeg,
        [
          "-ss", timestampSeconds.toString(),
          "-i", inputPath,
          "-frames:v", "1",
          "-q:v", "2",
          outputPath,
        ],
        { timeout: 30000 },
        (err) => {
          if (err) reject(err);
          else resolve();
        },
      );
    });

    return await readFile(outputPath);
  } finally {
    // Clean up temp files
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
    // rmdir the temp directory (will fail silently if not empty)
    const { rmdir } = await import("fs/promises");
    await rmdir(tmpDir).catch(() => {});
  }
}
