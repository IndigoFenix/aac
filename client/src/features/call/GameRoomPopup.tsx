// client/src/features/call/GameRoomPopup.tsx
//
// "Game room": the clinician's front door to the multiplayer worlds. Picks WHICH
// world to play (the same server-side option list the in-call game picker uses —
// the built-in field, the Dollhouse, plus the institute's multiplayer custom
// apps), then either:
//
//   - "Choose players" → the people picker, and the call starts with the game
//     already attached, so everyone lands in the world instead of a video call
//     someone then has to turn into a game, or
//   - "Open by myself" → the world alone, no call. Single-player, for setting up
//     or checking a world before a session.
//
// Starting a game here also makes THIS window the world's host (the clinician's
// machine runs the simulation — see CallGame.hostPersonId).

import { useEffect, useState } from "react";
import { Gamepad2, Loader2, UserPlus, User, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useInstitute } from "@/hooks/useInstitute";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";
import type { CallGame } from "@shared/realtime-events";
import { NPC_DEMO_GAME } from "@shared/social-world/default-game";
import { fetchSocialGameOptions } from "./api";

/** Identity of an option in this list. The built-in worlds share one appId
 *  ("social_world") and differ by world spec, so appId alone can't key them. */
function gameKey(g: CallGame): string {
  return `${g.appId}:${g.worldSpecKey ?? ""}`;
}

interface Props {
  /** Play with other people: the caller opens the people picker. */
  onPlayTogether: (game: CallGame) => void;
  /** Play alone, without a call. */
  onPlayAlone: (game: CallGame) => void;
  onClose: () => void;
}

export function GameRoomPopup({ onPlayTogether, onPlayAlone, onClose }: Props) {
  const { t } = useLanguage();
  const { currentInstitute, institutes } = useInstitute();
  const instituteId = currentInstitute?.id ?? institutes[0]?.id ?? null;

  const [games, setGames] = useState<CallGame[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<CallGame | null>(null);

  useEffect(() => {
    if (!instituteId) { setGames([]); setLoading(false); return; }
    let alive = true;
    setLoading(true);
    fetchSocialGameOptions(instituteId)
      .then((opts) => {
        if (!alive) return;
        // The NPC demo field is client-side only (it isn't an institute app and
        // the server list doesn't carry it) — it stays reachable here because
        // it's the surface for exercising the AI characters.
        const all = [...opts, NPC_DEMO_GAME];
        setGames(all);
        // Default to the Dollhouse (the world-engine game) when it's offered.
        setSelected(all.find((g) => g.appId === "dollhouse") ?? all[0] ?? null);
      })
      .catch((err) => {
        console.warn("[GameRoomPopup] failed to load games:", err);
        if (alive) setGames([]);
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [instituteId]);

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-md flex-col rounded-xl border border-border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border p-3">
          <span className="font-semibold">{t("socialWorld.gameRoom")}</span>
          <Button type="button" size="icon" variant="ghost" onClick={onClose} aria-label={t("common.close")}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="px-3 pt-3 text-sm text-muted-foreground">{t("socialWorld.gameRoomHint")}</div>

        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-1 p-3">
            {loading ? (
              <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> {t("common.loading")}
              </div>
            ) : (games ?? []).length === 0 ? (
              <div className="py-3 text-sm text-muted-foreground">{t("socialWorld.noGames")}</div>
            ) : (
              (games ?? []).map((g) => {
                const isSel = !!selected && gameKey(selected) === gameKey(g);
                return (
                  <button
                    key={gameKey(g)}
                    type="button"
                    onClick={() => setSelected(g)}
                    aria-pressed={isSel}
                    className={cn(
                      "flex items-center gap-3 rounded-lg border px-3 py-2 text-start hover:bg-muted",
                      isSel ? "border-primary bg-primary/10" : "border-border",
                    )}
                    data-testid={`game-room-option-${gameKey(g)}`}
                  >
                    <Gamepad2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {g.name ?? t("socialWorld.title")}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </ScrollArea>

        <div className="flex justify-end gap-2 border-t border-border p-3">
          <Button
            type="button"
            variant="secondary"
            disabled={!selected}
            onClick={() => { if (selected) { onPlayAlone(selected); onClose(); } }}
            data-testid="game-room-play-alone"
          >
            <User className="me-1.5 h-4 w-4" aria-hidden="true" />
            {t("socialWorld.playAlone")}
          </Button>
          <Button
            type="button"
            disabled={!selected}
            onClick={() => { if (selected) { onPlayTogether(selected); onClose(); } }}
            data-testid="game-room-play-together"
          >
            <UserPlus className="me-1.5 h-4 w-4" aria-hidden="true" />
            {t("socialWorld.playTogether")}
          </Button>
        </div>
      </div>
    </div>
  );
}
