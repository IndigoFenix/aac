// client/src/lib/videoHash.ts
// Content hash of an uploaded video, used as the key for a saved caption
// project. We never upload/store the video itself — this hash is how a
// re-uploaded file reloads its saved transcript + glyphs.

/** SHA-256 of the file bytes as a lowercase hex string. */
export async function sha256Hex(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
