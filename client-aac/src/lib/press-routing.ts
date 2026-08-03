// Which wire a STUDENT UTTERANCE press goes out on.
//
// The AAC has two of them, and the difference is whether the AI answers:
//
//   button_press — the conversational turn. The server voices it, then routes
//     it to the agents: the Speaker may reply out loud and the Board Manager
//     rebuilds the surface (agent-coordinator → routeClientEvent).
//
//   game_press  — a press made while PLAYING. Still a real utterance: voiced in
//     the student's own voice, logged, published to the conversation room, and
//     left with the Observer as a passive note. But it wakes NO agent — no
//     Speaker turn, no board rebuild (dual-agent/game-options.ts → runGamePress).
//
// The rule: while a world-engine game (the Dollhouse and its kin) owns the
// screen, EVERY button on it is a game press. Not just the options the game
// locked onto the board — the AI's own board buttons and the quick Yes / No
// too. Otherwise the child presses "yes" at something in their world and the
// assistant answers over the top of it, which is exactly the interruption the
// game_press path was built to avoid.
//
// Deliberately NOT covered here, because they aren't utterances:
//   • [MORE] — a direct request TO the Board Manager for more buttons. It
//     produces no speech; suppressing it would just make the button dead.
//   • Word-finder / guessing suggestions — the student has explicitly asked the
//     AI for help finding a word, so the AI is meant to be working.
//   • Home / Back / Exit navigation, and the binary-choice overlay, which is an
//     answer to a question the AI itself just asked.

export type PressWire = "button_press" | "game_press";

export interface PressContext {
  /** A world-engine game (dollhouse & co.) is the active app right now. */
  worldEngineGameActive: boolean;
}

export function pressWireFor(ctx: PressContext): PressWire {
  return ctx.worldEngineGameActive ? "game_press" : "button_press";
}
