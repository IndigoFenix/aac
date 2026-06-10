// server/services/dual-agent/goal-tree-app.ts
//
// Opens a stored goal-tree quest game for the AAC live session: re-certifies
// the stored content pack (nothing uncertified reaches the student, even if
// the row was tampered with or predates an engine change) and produces the
// `app_open` payload plus the tool-response note that teaches the live AI
// how to behave during this game (companion persona, [GAME] updates).

import type { CustomApp } from "@shared/schema";
import { certifyGoalTreeGame, type GoalTreeGame } from "@shared/goal-tree/index";
import { GOAL_TREE_APP_TYPE } from "@shared/goal-tree/types";

export { GOAL_TREE_APP_TYPE };

export interface GoalTreeAppOpen {
  ok: true;
  payload: {
    appId: "goal_tree_game";
    appData: { id: string; name: string; game: GoalTreeGame };
  };
  /** Tool-response text for the live AI. */
  aiNote: string;
}

export interface GoalTreeAppOpenError {
  ok: false;
  error: string;
}

export function isGoalTreeApp(app: Pick<CustomApp, "type">): boolean {
  return app.type === GOAL_TREE_APP_TYPE;
}

export function prepareGoalTreeAppOpen(
  app: CustomApp,
): GoalTreeAppOpen | GoalTreeAppOpenError {
  const definition = app.definition as { contentPack?: unknown } | null;
  const certified = certifyGoalTreeGame(definition?.contentPack);
  if (!certified.ok) {
    return {
      ok: false,
      error:
        `quest game "${app.name}" failed certification (${certified.stage}): ` +
        certified.errors.slice(0, 2).join("; "),
    };
  }

  const game = certified.game;
  const companion = game.meta.aiCompanion;
  const noteParts = [
    `ok. The quest game "${game.meta.title}" is now on screen.`,
    game.meta.description ? `About: ${game.meta.description}` : "",
    companion
      ? `For the duration of this game, speak as the companion "${companion.name}": ${companion.persona}`
      : "",
    "The student plays on a 2D map (eyegaze): reaching places, collecting items, " +
      "answering questions, and unlocking obstacles. You will receive [GAME] updates " +
      "as they play — narrate warmly, hint when they are stuck, celebrate wins. Keep it short.",
    "Call rebuild_board() with buttons relevant to this game, and close_app() when the student is done.",
  ];

  return {
    ok: true,
    payload: {
      appId: "goal_tree_game",
      appData: { id: app.id, name: app.name, game },
    },
    aiNote: noteParts.filter(Boolean).join(" "),
  };
}
