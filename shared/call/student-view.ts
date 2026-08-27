// shared/call/student-view.ts
//
// HOW MUCH OF THE CLINICIAN'S SCREEN THE STUDENT'S FACE GETS.
//
// A clinician watching a session needs two things at once: the grid, which says
// what the student pressed, and the camera, which says whether they meant it.
// Before this, `viewBoard` was a boolean — one OR the other — so reading intent
// meant toggling back and forth and losing whichever half you weren't on.
//
// The right split is not one number, because the two halves are not equally
// informative on every surface. A communication board is the conversation, so
// it shares the screen evenly with the face. A world-engine game is a wide
// scene with its own HUD and a narrow 2×4 mini-board, and the student's face
// competes with far more detail — so the camera shrinks (user, 2026-08-27).
//
// Kept here, pure and away from the component, so the table is a fact the tests
// can assert rather than a magic number buried in a style attribute.

/** What the clinician's main area is showing. */
export const STUDENT_VIEW_MODES = ["video", "split", "board"] as const;
export type StudentViewMode = (typeof STUDENT_VIEW_MODES)[number];

/** The AAC surface the student is actually looking at, as reported by the
 *  board mirror. `screen` is not an AAC surface but a real screen capture, and
 *  it splits like one. */
export type StudentSurface = "board" | "builder" | "app" | "game" | "screen";

/**
 * The camera pane's share of the split, 0..1, per surface.
 *
 * Board and builder are 50/50 — the ask was literally "half the student's
 * camera, and half the grid". Game and screen-share hand most of the room to
 * the surface: both are dense, and neither is a single grid the clinician can
 * take in at a glance.
 */
const CAMERA_SHARE: Record<StudentSurface, number> = {
  board: 0.5,
  builder: 0.5,
  app: 0.5,
  game: 0.28,
  screen: 0.35,
};

/** How far the divider may be dragged, so neither pane can be closed by
 *  accident — a pane dragged to zero looks like a broken feed. */
export const MIN_CAMERA_SHARE = 0.15;
export const MAX_CAMERA_SHARE = 0.85;

/** The camera pane's default share for a surface (unknown surfaces read as a
 *  plain board — the even split is the safe guess). */
export function defaultCameraShare(surface: StudentSurface | undefined): number {
  return CAMERA_SHARE[surface ?? "board"] ?? CAMERA_SHARE.board;
}

/** Clamp a dragged share into the legible range. */
export function clampCameraShare(share: number): number {
  if (!Number.isFinite(share)) return CAMERA_SHARE.board;
  return Math.min(MAX_CAMERA_SHARE, Math.max(MIN_CAMERA_SHARE, share));
}
