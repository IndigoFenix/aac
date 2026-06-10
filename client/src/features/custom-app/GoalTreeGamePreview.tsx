// src/features/custom-app/GoalTreeGamePreview.tsx
//
// Plays a generated goal-tree quest game inside the clinician panel by
// embedding the goal-tree-player iframe (served from /games/, same build the
// AAC uses). Handshake: wait for the game's `ready`, then send `init`
// (locale + dwell) and `load_game` with the content pack. When the AI edits
// the open game (Context_QuestGame), the new content pack is re-sent live —
// the preview hot-reloads. The player re-certifies every payload; a
// rejection surfaces as an error banner.
//
// Mouse input works out of the box — the player treats pointer movement as
// gaze and clicks as instant activation, so "test = play".

import { useEffect, useRef, useState } from "react";
import { onGameMessage, sendToGame } from "@shared/games-bridge";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiUrl } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

// Resolve against the backend origin (VITE_API_URL) — in standalone vite dev
// (`npm run client:dev`) the page origin is the vite port, which doesn't
// serve /games/*; the Express server does.
const PLAYER_URL = apiUrl("/games/goal-tree-player/");
const PREVIEW_DWELL_MS = 650;

interface GoalTreeGamePreviewProps {
  /** The GoalTreeGame JSON (definition.contentPack of a goal_tree_game app). */
  contentPack: unknown;
  language?: string | null;
  isDark: boolean;
}

export function GoalTreeGamePreview({
  contentPack,
  language,
  isDark,
}: GoalTreeGamePreviewProps) {
  const { t } = useLanguage();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);

  // Subscribe once per iframe: track readiness + load rejections.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const unsubscribe = onGameMessage(iframe, (msg) => {
      if (msg.type === "ready") {
        setReady(true);
        sendToGame(iframe, {
          type: "init",
          locale: language ?? undefined,
          dwellMs: PREVIEW_DWELL_MS,
        });
      } else if (msg.type === "player_action" && msg.action === "game_loaded") {
        setRejected(null);
      } else if (
        msg.type === "player_action" &&
        msg.action === "load_game_rejected"
      ) {
        const errors = (msg.meta?.errors as string[] | undefined) ?? [];
        setRejected(errors.join(" · ") || "unknown error");
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // (Re)send the content pack whenever it changes and the player is ready —
  // initial load and AI-edit hot reload share this path.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !ready || !contentPack) return;
    sendToGame(iframe, { type: "load_game", game: contentPack });
  }, [ready, contentPack]);

  if (!contentPack) {
    return (
      <div
        className={cn(
          "h-full flex items-center justify-center p-8 text-sm",
          isDark ? "text-slate-400" : "text-gray-600",
        )}
      >
        {t("customApps.questMissingContent")}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div
        className={cn(
          "px-4 py-1.5 text-xs shrink-0 border-b",
          isDark
            ? "bg-slate-900 border-slate-800 text-slate-400"
            : "bg-white border-gray-200 text-gray-600",
        )}
      >
        {t("customApps.questPreviewHint")}
      </div>
      {rejected && (
        <div
          className={cn(
            "px-4 py-2 text-xs shrink-0 border-b",
            isDark
              ? "bg-red-950 border-red-900 text-red-200"
              : "bg-red-50 border-red-200 text-red-800",
          )}
        >
          <strong>{t("customApps.loadError")}:</strong> {rejected}
        </div>
      )}
      <iframe
        ref={iframeRef}
        src={PLAYER_URL}
        title={t("customApps.questPreviewHint")}
        className="flex-1 w-full border-0"
        sandbox="allow-scripts allow-same-origin allow-pointer-lock"
      />
    </div>
  );
}
