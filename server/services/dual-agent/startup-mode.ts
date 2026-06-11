// server/services/dual-agent/startup-mode.ts
//
// Pure helpers for the AAC session STARTUP behavior. Kept out of
// agent-coordinator.ts so the decision logic is unit-testable without
// importing the (WebSocket-owning, repository-heavy) coordinator.
//
// Two startup modes:
//   - CONTEXTUAL (default): on the first frame the AI may greet a recognized
//     student in a way that fits the observed setting / activity.
//   - MENU: board-first, AI waits — used for shared / classroom devices where
//     we shouldn't assume who is at the device. The Observer still describes
//     the scene silently; the Speaker just doesn't greet.

export type StartupBehavior = "contextual" | "menu";

/**
 * Pick the startup behavior from session context. No clinician toggle — a
 * shared / classroom session gets MENU, a personal device gets CONTEXTUAL.
 * Single chokepoint so the heuristic is easy to extend (e.g. future
 * "public kiosk" or "multi-student" signals).
 */
export function resolveStartupMode(ctx: { classroomId: string | null }): StartupBehavior {
  if (ctx.classroomId) return "menu";
  return "contextual";
}

/**
 * Whether the bound student is the person actually at the device. Prefers a
 * positive biometric match; if faces are seen but none is the student, a
 * visitor is at the device (don't greet as the student); if no recognition is
 * available at all, assume the student on a personal device but never on a
 * shared / classroom one.
 */
export function resolveStudentIsActiveUser(args: {
  sawStudentFace: boolean;
  haveFreshFaces: boolean;
  isSharedDevice: boolean;
}): boolean {
  if (args.sawStudentFace) return true;
  if (args.haveFreshFaces) return false;
  return !args.isSharedDevice;
}

/**
 * The one-shot startup decision: should the Speaker greet, or should the AI
 * stay passive (home menu / board-first)? Greeting requires CONTEXTUAL mode,
 * the student being the active user, and no social-training peer (which owns
 * its own greeting lifecycle).
 */
export function decideStartupAction(args: {
  startupBehavior: StartupBehavior;
  studentIsActiveUser: boolean;
  socialPeerActive: boolean;
}): "greet" | "wait" {
  if (args.socialPeerActive) return "wait";
  if (args.startupBehavior !== "contextual") return "wait";
  return args.studentIsActiveUser ? "greet" : "wait";
}

/**
 * The `[SESSION START]` user-turn that prompts the Speaker to voice a
 * context-aware greeting. Sent via sendUserTurn (not a context injection) so
 * the Speaker actually produces a spoken reply; the scene description has
 * already been injected as context just before, so the greeting can fit what
 * is happening.
 */
export function buildStartupGreetingTurn(studentName: string): string {
  return `[SESSION START] You've just come online and ${studentName} is here with you. Greet them warmly in a way that fits what you can see is happening right now (the setting and current activity). Keep it to one or two short sentences — an opening, not a monologue. If they're in the middle of an activity, acknowledge it rather than pulling them away from it.`;
}
