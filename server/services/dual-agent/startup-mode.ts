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
 * The one-shot startup decision: should the Speaker greet, or should the AI
 * stay passive (home menu / board-first)? Greeting requires CONTEXTUAL mode,
 * the active user being POSITIVELY IDENTIFIED (a real face match / Observer
 * confirmation — never a mere "probably the student on a personal device"
 * assumption), and no social-training peer (which owns its own greeting
 * lifecycle). We never greet someone the AI hasn't actually seen.
 */
export function decideStartupAction(args: {
  startupBehavior: StartupBehavior;
  activeUserIdentified: boolean;
  socialPeerActive: boolean;
}): "greet" | "wait" {
  if (args.socialPeerActive) return "wait";
  if (args.startupBehavior !== "contextual") return "wait";
  return args.activeUserIdentified ? "greet" : "wait";
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

/**
 * The one-shot palette directive for the FIRST auto-generated board of a
 * session — delivered to the Board Manager as its `forceRebuildDirective`
 * (see `HOME_INTENTS` in agent-coordinator.ts for the same channel used by
 * home-board presses).
 *
 * On top of the usual opening palette it REQUIRES one HERE-AND-NOW button:
 * a button naming where the user is or what is happening around them, taken
 * from the Observer's `[CONTEXT]` scene lines. It is the only button on the
 * board the user hasn't had to think of themselves — pressing it opens the
 * vocabulary of that place / activity (the `<here_and_now>` block in the Board
 * Manager's system prompt owns what happens on the press, because by then this
 * one-shot directive is long gone).
 *
 * The first sentence is the SITUATION: `buildForceRebuildHint` is
 * situation-neutral, so every directive states its own occasion.
 */
export function buildStartupBoardDirective(): string {
  return `The session has just started. This is the FIRST board the user sees and they have not said anything yet.

Palette: a varied opening set — greetings, things the user might want to say or ask right now, and topics from their known interests.

REQUIRED: exactly ONE of the buttons is a HERE-AND-NOW button. It names WHERE the user is or WHAT is happening around them, read off the [CONTEXT] observations in recent events — the setting, the activity underway, what is in front of them, who is with them.
  - Write it as something the user would SAY: "I'm at school", "we're eating lunch", "I'm in the garden".
  - Draw the GLYPH of that place or activity itself.
  - Ground it in what was actually observed. Nothing about the setting? Use the nearest thing the observations DO report.
  - Nothing at all? Leave the button out rather than inventing a place the user isn't in.
  - Pressing it means "let's talk about this place / this activity" — see <here_and_now>.`;
}
