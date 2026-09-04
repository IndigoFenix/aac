/**
 * Prepares a camera frame for AI vision by:
 * 1. Horizontally flipping the image into the SUBJECT's anatomical frame
 * 2. Drawing "L" and "R" direction labels as spatial anchors
 *
 * Only used for AI-bound frames — does not affect camera preview or tracking.
 *
 * ⚠️ WHY THE FLIP (the old comment here said "cameras produce mirrored images",
 * which is wrong and contradicts seizureMotionSource.ts). The source stream is
 * UNMIRRORED — verified 2026-09-02 against a live camera via
 * client-aac/public/mirror-check.html (MediaPipe handedness, blendshape
 * sidedness and yaw sign all read subject-relative). So the subject's left
 * arrives on the image's RIGHT, and flipping moves it to the image's LEFT.
 * That is the point: after the flip, image-left IS the subject's left, so the
 * "L"/"R" labels below mark the subject's own sides and the AI's visual frame
 * agrees with the [SCENE] text convention (+yaw = subject's right, ARKit
 * ...Left = subject's left).
 *
 * Do NOT remove the flip to "stop mirroring the child" — that would put the L
 * label on their right and silently invert every sided observation the
 * Observer makes, including the seizure markers it adjudicates.
 */
export async function prepareFrameForAI(blob: Blob): Promise<Blob> {
  const image = await createImageBitmap(blob);
  const { width, height } = image;

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;

  // Flip horizontally to match real-world orientation
  ctx.translate(width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(image, 0, 0);

  // Reset transform for labels
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // Draw direction labels
  const fontSize = Math.max(12, Math.round(height * 0.055));
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textBaseline = "top";

  const padding = Math.round(fontSize * 0.4);
  const margin = 12;

  for (const { letter, x } of [
    { letter: "L", x: margin },
    { letter: "R", x: width - margin - ctx.measureText("R").width - padding * 2 },
  ] as const) {
    const textWidth = ctx.measureText(letter).width;
    const pillW = textWidth + padding * 2;
    const pillH = fontSize + padding * 2;

    // Dark semi-transparent background pill
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.beginPath();
    ctx.roundRect(x, margin, pillW, pillH, 4);
    ctx.fill();

    // White text with dark outline
    const tx = x + padding;
    const ty = margin + padding;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
    ctx.lineWidth = 2;
    ctx.strokeText(letter, tx, ty);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(letter, tx, ty);
  }

  image.close();

  const result = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 });
  return result;
}
