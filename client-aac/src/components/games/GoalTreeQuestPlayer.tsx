// client-aac/src/components/games/GoalTreeQuestPlayer.tsx
//
// Plays a goal-tree quest game in the AAC client. Thin wrapper over
// GameEmbed: hands the certified game to the player via `load_game`,
// forwards eyegaze, and narrates play events to the live AI session as
// [GAME] text (same channel CustomAppPlayer uses), with entity/goal ids
// resolved to their player-facing labels so the AI can talk about them.

import { useCallback, useEffect, useMemo, useRef, type Ref } from "react";
import type { BoardOption, GameMessage } from "@shared/games-bridge";
import type { GoalTreeGame } from "@shared/world-engine/solver/types";
import { walkGoalTree } from "@shared/world-engine/solver/walk";
import { buildTownPlay, isTownPlayPayload, type TownPlayPayload } from "@shared/world-engine/interaction/town/town-play";
import GameEmbed, { type GameEmbedHandle } from "./GameEmbed";

interface GoalTreeQuestPlayerProps {
  /** A certified quest game, OR a living-town config (town-play payload —
   *  the player rebuilds the identical deterministic session from it). */
  game: GoalTreeGame | TownPlayPayload;
  onClose: () => void;
  sendMessageToAi?: (msg: string) => void;
  /** "3d" loads the world-engine 3D player (symbol-learning); default 2d. */
  renderMode?: "2d" | "3d";
  /** Ref to the embed so the host can push `board_option_selected` to the game. */
  gameRef?: Ref<GameEmbedHandle>;
  /** Fired when the game locks/releases the response board (see GameEmbed). */
  onBoardOptions?: (options: BoardOption[] | null) => void;
}

/** Suppress identical [GAME] lines repeated within this window. */
const DEDUPE_MS = 5000;

export default function GoalTreeQuestPlayer({
  game,
  onClose,
  sendMessageToAi,
  renderMode = "2d",
  gameRef,
  onBoardOptions,
}: GoalTreeQuestPlayerProps) {
  const lastSentRef = useRef<{ text: string; at: number } | null>(null);

  // A town payload's quest game derives deterministically from its config —
  // build it here too, so the AI narration labels match what the player runs.
  const questGame = useMemo<GoalTreeGame>(
    () => (isTownPlayPayload(game) ? buildTownPlay(game).bundle.game : game),
    [game],
  );

  const labels = useMemo(() => {
    const entity = new Map(questGame.entities.map((e) => [e.id, e.label]));
    const entityLabel = (id: unknown) =>
      (typeof id === "string" && entity.get(id)) || String(id ?? "?");
    const node = new Map<string, string>();
    for (const { node: n } of walkGoalTree(questGame.root)) {
      switch (n.type) {
        case "reach":
          node.set(n.id, entityLabel(n.markerEntityId));
          break;
        case "collect":
          node.set(n.id, entityLabel(n.itemEntityIds[0]));
          break;
        case "choose":
          node.set(n.id, n.prompt);
          break;
        case "overcome":
          node.set(n.id, entityLabel(n.obstacleEntityId));
          break;
      }
    }
    const nodeLabel = (id: unknown) =>
      (typeof id === "string" && node.get(id)) || String(id ?? "?");
    return { entityLabel, nodeLabel };
  }, [questGame]);

  const sendGameUpdate = useCallback(
    (text: string) => {
      if (!sendMessageToAi) return;
      const now = Date.now();
      const last = lastSentRef.current;
      if (last && last.text === text && now - last.at < DEDUPE_MS) return;
      lastSentRef.current = { text, at: now };
      sendMessageToAi(`[GAME] ${text}`);
    },
    [sendMessageToAi],
  );

  // Intro on mount, hand-back on unmount — mirrors CustomAppPlayer.
  useEffect(() => {
    if (!sendMessageToAi) return;
    const companion = questGame.meta.aiCompanion;
    const intro = [
      `[GAME STARTED] The student opened the quest game "${questGame.meta.title}".`,
      questGame.meta.description ?? "",
      companion
        ? `For this game, speak as the companion "${companion.name}": ${companion.persona}`
        : "",
      "You will receive [GAME] updates as they play. Narrate warmly in the student's language, hint when they are stuck, celebrate wins. Keep it short.",
    ]
      .filter(Boolean)
      .join("\n");
    sendMessageToAi(intro);
    return () => {
      sendMessageToAi("[GAME] The student has closed the game. Return to normal conversation.");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questGame]);

  const handleMessage = useCallback(
    (msg: GameMessage) => {
      if (msg.type !== "player_action") return;
      const meta = (msg.meta ?? {}) as Record<string, unknown>;
      const { entityLabel, nodeLabel } = labels;
      switch (msg.action) {
        case "item_collected":
          sendGameUpdate(
            `Collected "${entityLabel(meta.entityId)}" (${meta.have}/${meta.need}).`,
          );
          break;
        case "distractor_picked":
          sendGameUpdate(
            `Picked up "${entityLabel(meta.entityId)}" — a distractor, not what's needed. Gently redirect.`,
          );
          break;
        case "wrong_choice":
          sendGameUpdate(
            `Answered "${entityLabel(meta.entityId)}" — not the right one. Encourage another try, maybe a small hint.`,
          );
          break;
        case "obstacle_locked":
          sendGameUpdate(
            `Bumped into the locked "${nodeLabel(meta.nodeId)}". Hint at what could open it.`,
          );
          break;
        case "guard_cleared":
          sendGameUpdate(`Cleared the "${nodeLabel(meta.nodeId)}"!`);
          break;
        case "goal_completed":
          sendGameUpdate(`Goal done: "${nodeLabel(meta.nodeId)}". Praise briefly.`);
          break;
        case "game_won":
          sendGameUpdate("The student WON the quest! Celebrate enthusiastically!");
          break;
        case "load_game_rejected":
          sendGameUpdate(
            "The game failed to load. Apologize briefly and call close_app().",
          );
          break;
        default:
          break;
      }
    },
    [labels, sendGameUpdate],
  );

  return (
    <GameEmbed
      ref={gameRef}
      gameId="goal-tree-player"
      src={renderMode === "3d" ? "/games/goal-tree-player/?render=3d" : "/games/goal-tree-player/"}
      forwardGaze
      gamePayload={game}
      onMessage={handleMessage}
      onBoardOptions={onBoardOptions}
      onClose={onClose}
    />
  );
}
