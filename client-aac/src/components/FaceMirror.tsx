// client-aac/src/components/FaceMirror.tsx
// Canvas-based face mirror widget — shows stylized face mirroring user expressions,
// hands as colored skeletons, and secondary faces in blue.

import { useRef, useEffect, useCallback } from "react";
import type { RawTrackedFace } from "@/lib/faceTrackingTypes";
import type { RawTrackedHand } from "@/lib/handGestureTypes";
import type { RawTrackedPose, PoseLandmark } from "@/lib/poseTrackingTypes";
import { poseHeadNearFace } from "@shared/aac/pose-classify";

interface FaceMirrorProps {
  faces: RawTrackedFace[];
  hands: RawTrackedHand[];
  poses?: RawTrackedPose[];
  size?: number;
}

// Blendshape helper — safely read a value from the Map
function bs(blendshapes: Map<string, number>, name: string): number {
  return blendshapes.get(name) ?? 0;
}

// Hand landmark indices for finger chains
const FINGER_CHAINS: number[][] = [
  [0, 1, 2, 3, 4],     // thumb
  [0, 5, 6, 7, 8],     // index
  [0, 9, 10, 11, 12],  // middle
  [0, 13, 14, 15, 16], // ring
  [0, 17, 18, 19, 20], // pinky
];

// Palm polygon landmark indices
const PALM_INDICES = [0, 1, 5, 9, 13, 17];

export function FaceMirror({ faces, hands, poses = [], size = 80 }: FaceMirrorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const facesRef = useRef<RawTrackedFace[]>(faces);
  const handsRef = useRef<RawTrackedHand[]>(hands);
  const posesRef = useRef<RawTrackedPose[]>(poses);
  const rafRef = useRef<number>(0);

  // Update refs without causing re-renders
  facesRef.current = faces;
  handsRef.current = hands;
  posesRef.current = poses;

  const draw = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const currentFaces = facesRef.current;
    const currentHands = handsRef.current;
    const currentPoses = posesRef.current;

    ctx.clearRect(0, 0, w, h);

    // Sort faces: largest bounding box first (primary face)
    const sorted = [...currentFaces].sort((a, b) => {
      const areaA = a.boundingBox ? a.boundingBox.width * a.boundingBox.height : 0;
      const areaB = b.boundingBox ? b.boundingBox.width * b.boundingBox.height : 0;
      return areaB - areaA;
    });

    // Pose comes from a SEPARATE model than the face, so it can latch onto a
    // different person (or a spurious body). Only keep a pose when its head lands
    // on the primary face — otherwise the skeleton would float, disconnected from
    // the head, so we drop it here (and it no longer counts toward "has content").
    const primaryFace = sorted[0];
    const linkedPoses = currentPoses.filter((p) => isPoseLinkedToFace(p, primaryFace));

    if (sorted.length === 0 && currentHands.length === 0 && linkedPoses.length === 0) {
      // Empty state — faint dashed circle
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, w * 0.3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }

    // Draw the body skeleton first (behind faces/hands) so the cartoon face and
    // hand skeletons stay prominent on top.
    for (const pose of linkedPoses) {
      drawPose(ctx, pose, w, h);
    }

    // Draw secondary faces first (behind primary)
    for (let i = sorted.length - 1; i >= 1; i--) {
      drawSecondaryFace(ctx, sorted[i], w, h);
    }

    // Draw primary face
    if (sorted.length > 0) {
      drawPrimaryFace(ctx, sorted[0], w, h);
    }

    // Draw hands
    for (const hand of currentHands) {
      drawHand(ctx, hand, w, h);
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const loop = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(ctx, size, size);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => cancelAnimationFrame(rafRef.current);
  }, [size, draw]);

  return (
    <canvas
      ref={canvasRef}
      className="shrink-0 self-center rounded-lg"
      style={{ width: size, height: size }}
    />
  );
}

// ─── Primary face ───────────────────────────────────────────────────────────

function drawPrimaryFace(
  ctx: CanvasRenderingContext2D,
  face: RawTrackedFace,
  w: number,
  h: number,
) {
  const b = face.blendshapes;

  // Anchor the head to its REAL position + size (mirrored, to match the hand &
  // pose skeletons), so it sits where the body is rather than fixed at center.
  // Falls back to centered if no bounding box yet.
  const bb = face.boundingBox;
  let cx = w / 2, cy = h * 0.42, r = w * 0.3;
  if (bb) {
    cx = (1 - (bb.x + bb.width / 2)) * w; // mirrored x
    cy = (bb.y + bb.height / 2) * h;
    r = Math.max(bb.width * w, bb.height * h) / 2;
    r = Math.max(w * 0.1, Math.min(r, w * 0.45)); // clamp so far/near faces stay sane
  }

  // Horizontal head cues are negated so the avatar reads as a true mirror.
  const yaw = -(face.headPose?.yaw ?? 0);
  const pitch = face.headPose?.pitch ?? 0;
  const roll = -(face.headPose?.roll ?? 0);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(roll); // head tilt (roll) from face-edge landmark angle

  // Head circle — warm skin tone (drawn centered, unaffected by yaw)
  ctx.fillStyle = "#FFD9A0";
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();

  // Yaw + pitch offset — shift inner features when head turns/tilts
  ctx.translate(yaw * r * 0.3, pitch * r * 0.3);

  // Cheek blush on smile
  const smileAmount = Math.max(bs(b, "mouthSmileLeft"), bs(b, "mouthSmileRight"));
  if (smileAmount > 0.2) {
    const blushAlpha = Math.min((smileAmount - 0.2) * 1.5, 0.4);
    ctx.fillStyle = `rgba(255,150,150,${blushAlpha})`;
    ctx.beginPath();
    ctx.ellipse(-r * 0.55, r * 0.15, r * 0.2, r * 0.15, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(r * 0.55, r * 0.15, r * 0.2, r * 0.15, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── Eyes ──
  const eyeY = -r * 0.15 + pitch * r * 0.15;
  const eyeSpacing = r * 0.35;

  const blinkL = bs(b, "eyeBlinkLeft");
  const blinkR = bs(b, "eyeBlinkRight");
  const gazeX = -(bs(b, "eyeLookOutLeft") - bs(b, "eyeLookInLeft")) * 0.5; // mirrored
  const gazeY = (bs(b, "eyeLookDownLeft") - bs(b, "eyeLookUpLeft")) * 0.5;

  for (const [side, blink] of [[-1, blinkL], [1, blinkR]] as [number, number][]) {
    const ex = side * eyeSpacing;
    const ey = eyeY;
    const eyeW = r * 0.2;
    const eyeH = r * 0.22 * (1 - blink * 0.85);

    if (blink < 0.8) {
      // White of eye (hidden when mostly closed)
      ctx.fillStyle = "#FFFFFF";
      ctx.beginPath();
      ctx.ellipse(ex, ey, eyeW, eyeH, 0, 0, Math.PI * 2);
      ctx.fill();

      // Pupil (only if eye is somewhat open)
      if (blink < 0.7) {
        const pupilR = r * 0.09;
        const px = ex + gazeX * eyeW * 0.5;
        const py = ey + gazeY * eyeH * 0.4;
        ctx.fillStyle = "#3A2F28";
        ctx.beginPath();
        ctx.arc(px, py, pupilR, 0, Math.PI * 2);
        ctx.fill();

        // Pupil highlight
        ctx.fillStyle = "#FFFFFF";
        ctx.beginPath();
        ctx.arc(px - pupilR * 0.3, py - pupilR * 0.3, pupilR * 0.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Eyelid line when closed
    if (blink > 0.5) {
      ctx.strokeStyle = "#C4A882";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(ex - eyeW, ey);
      ctx.lineTo(ex + eyeW, ey);
      ctx.stroke();
    }
  }

  // ── Eyebrows ──
  const browRaise = Math.max(bs(b, "browOuterUpLeft"), bs(b, "browOuterUpRight"), bs(b, "browInnerUp"));
  const browFurrow = bs(b, "browDownLeft") + bs(b, "browDownRight");
  const browOffset = -r * 0.4 + pitch * r * 0.1 - browRaise * r * 0.12 + browFurrow * r * 0.06;

  ctx.strokeStyle = "#8B6914";
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";

  for (const side of [-1, 1]) {
    const bx = side * eyeSpacing;
    ctx.beginPath();
    ctx.moveTo(bx - r * 0.18, browOffset + (browFurrow > 0.3 ? side * r * 0.04 : 0));
    ctx.quadraticCurveTo(bx, browOffset - r * 0.06, bx + r * 0.18, browOffset);
    ctx.stroke();
  }

  // ── Mouth ──
  const jawOpen = bs(b, "jawOpen");
  const mouthY = r * 0.4 + pitch * r * 0.1;
  const mouthW = r * 0.35;
  const frownL = bs(b, "mouthFrownLeft");
  const frownR = bs(b, "mouthFrownRight");
  const frownAmount = (frownL + frownR) / 2;

  if (jawOpen > 0.15) {
    // Open mouth — ellipse
    const mouthH = r * 0.12 + jawOpen * r * 0.25;
    ctx.fillStyle = "#D4625B";
    ctx.beginPath();
    ctx.ellipse(0, mouthY, mouthW, mouthH, 0, 0, Math.PI * 2);
    ctx.fill();
    // Inner dark
    ctx.fillStyle = "#7A2A2A";
    ctx.beginPath();
    ctx.ellipse(0, mouthY, mouthW * 0.7, mouthH * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Closed mouth — curved line
    const curvature = smileAmount * r * 0.12 - frownAmount * r * 0.1;
    ctx.strokeStyle = "#C4625B";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-mouthW, mouthY);
    ctx.quadraticCurveTo(0, mouthY + curvature, mouthW, mouthY);
    ctx.stroke();
  }

  // ── Nose (tiny) ──
  ctx.fillStyle = "#E8C090";
  ctx.beginPath();
  ctx.arc(0, r * 0.12 + pitch * r * 0.08, r * 0.06, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

// ─── Secondary faces ────────────────────────────────────────────────────────

function drawSecondaryFace(
  ctx: CanvasRenderingContext2D,
  face: RawTrackedFace,
  w: number,
  h: number,
) {
  // Position + size from the bounding box (mirrored, like the primary face and
  // skeletons) — fall back to an offset corner.
  let cx: number, cy: number, r: number;
  const bb = face.boundingBox;
  if (bb) {
    cx = (1 - (bb.x + bb.width / 2)) * w; // mirrored x
    cy = (bb.y + bb.height / 2) * h;
    r = Math.max(w * 0.07, Math.min(Math.max(bb.width * w, bb.height * h) / 2, w * 0.3));
  } else {
    cx = w * 0.8;
    cy = h * 0.25;
    r = w * 0.14;
  }

  // Blue-tinted circle
  ctx.fillStyle = "rgba(100,160,255,0.7)";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  // Dot eyes
  ctx.fillStyle = "#FFFFFF";
  ctx.beginPath();
  ctx.arc(cx - r * 0.3, cy - r * 0.15, r * 0.12, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + r * 0.3, cy - r * 0.15, r * 0.12, 0, Math.PI * 2);
  ctx.fill();

  // Simple mouth
  const jawOpen = bs(face.blendshapes, "jawOpen");
  if (jawOpen > 0.2) {
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.beginPath();
    ctx.ellipse(cx, cy + r * 0.3, r * 0.2, r * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.2, cy + r * 0.3);
    ctx.lineTo(cx + r * 0.2, cy + r * 0.3);
    ctx.stroke();
  }
}

// ─── Body pose ────────────────────────────────────────────────────────────────

// MediaPipe Pose landmark indices + the bones we connect.
const POSE_BONES: Array<[number, number]> = [
  [11, 12],            // shoulders
  [11, 13], [13, 15],  // left arm
  [12, 14], [14, 16],  // right arm
  [11, 23], [12, 24],  // torso sides
  [23, 24],            // hips
  [23, 25], [25, 27],  // left leg
  [24, 26], [26, 28],  // right leg
];
const POSE_VIS_MIN = 0.5;

/**
 * True when `pose`'s head lands on `face` (same person). Pose and face come from
 * independent models (pose runs single-body), so on multi-person / spurious
 * frames the body can belong to someone other than the mirrored face. Delegates
 * the geometry to the shared, unit-tested `poseHeadNearFace`; converts the face's
 * bounding box to the shared `{x,y,w,h}` shape. No face → nothing to link to, so
 * the body is hidden rather than left floating.
 */
function isPoseLinkedToFace(
  pose: RawTrackedPose,
  face: RawTrackedFace | undefined,
): boolean {
  const bb = face?.boundingBox;
  if (!bb) return false;
  return poseHeadNearFace(pose.landmarks, { x: bb.x, y: bb.y, w: bb.width, h: bb.height });
}

function drawPose(
  ctx: CanvasRenderingContext2D,
  pose: RawTrackedPose,
  w: number,
  h: number,
) {
  const lm = pose.landmarks;
  if (!lm || lm.length < 29) return;

  // Mirror horizontally so the widget acts as a mirror, matching drawHand.
  const toX = (x: number) => (1 - x) * w;
  const toY = (y: number) => y * h;
  const vis = (p?: PoseLandmark) => (p ? p.visibility ?? 1 : 0);

  ctx.strokeStyle = "rgba(120,230,180,0.55)";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  for (const [a, b] of POSE_BONES) {
    const p = lm[a], q = lm[b];
    if (!p || !q || vis(p) < POSE_VIS_MIN || vis(q) < POSE_VIS_MIN) continue;
    ctx.beginPath();
    ctx.moveTo(toX(p.x), toY(p.y));
    ctx.lineTo(toX(q.x), toY(q.y));
    ctx.stroke();
  }

  // Joint dots
  ctx.fillStyle = "rgba(150,240,200,0.8)";
  for (const i of [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
    const p = lm[i];
    if (!p || vis(p) < POSE_VIS_MIN) continue;
    ctx.beginPath();
    ctx.arc(toX(p.x), toY(p.y), 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ─── Hands ──────────────────────────────────────────────────────────────────

function drawHand(
  ctx: CanvasRenderingContext2D,
  hand: RawTrackedHand,
  w: number,
  h: number,
) {
  const lm = hand.landmarks;
  if (!lm || lm.length < 21) return;

  // Mirror horizontally so the widget acts as a mirror
  const toX = (x: number) => (1 - x) * w;
  const toY = (y: number) => y * h;

  const color = hand.handedness === "Left" ? "rgba(80,160,255,0.7)" : "rgba(80,200,120,0.7)";
  const dotColor = hand.handedness === "Left" ? "rgba(120,190,255,0.9)" : "rgba(120,230,160,0.9)";

  // Palm polygon
  ctx.fillStyle = color.replace("0.7", "0.2");
  ctx.beginPath();
  for (let i = 0; i < PALM_INDICES.length; i++) {
    const p = lm[PALM_INDICES[i]];
    if (i === 0) ctx.moveTo(toX(p.x), toY(p.y));
    else ctx.lineTo(toX(p.x), toY(p.y));
  }
  ctx.closePath();
  ctx.fill();

  // Finger chains
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";

  for (const chain of FINGER_CHAINS) {
    ctx.beginPath();
    for (let i = 0; i < chain.length; i++) {
      const p = lm[chain[i]];
      if (i === 0) ctx.moveTo(toX(p.x), toY(p.y));
      else ctx.lineTo(toX(p.x), toY(p.y));
    }
    ctx.stroke();
  }

  // Fingertip dots (indices 4, 8, 12, 16, 20)
  ctx.fillStyle = dotColor;
  for (const ti of [4, 8, 12, 16, 20]) {
    const p = lm[ti];
    ctx.beginPath();
    ctx.arc(toX(p.x), toY(p.y), 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

export default FaceMirror;
