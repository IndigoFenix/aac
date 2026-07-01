// client-aac/src/components/games/SymbolGameSandbox.tsx
//
// Dev/test harness for the symbol-learning game, reachable at /symbol-game with
// NO auth, NO student selection, and NO live AI session. The symbol-learning
// game runs entirely client-side (the goal-tree player judges correctness
// itself); the AI is only ever a narration companion, so the game is fully
// playable without it.
//
// This mirrors the in-app wiring from pages/home.tsx — GoalTreeQuestPlayer (3D)
// in the main area, the game's locked options shown on the side AppMiniBoard,
// and a board press routed back to the game as `board_option_selected` — but
// omits `sendMessageToAi`, so nothing here opens a WebSocket or talks to the AI.

import { useCallback, useMemo, useRef, useState } from "react";
import type { BoardOption } from "@shared/games-bridge";
import type { ParsedBoardData } from "@shared/schema";
import {
  REQUESTING_EXCHANGES,
  bindExchange,
  compileExchange,
  POOLS,
  randomMemberPicker,
} from "@shared/symbol-game";
import { useLanguage } from "@/contexts/LanguageContext";
import GoalTreeQuestPlayer from "@/components/games/GoalTreeQuestPlayer";
import type { GameEmbedHandle } from "@/components/games/GameEmbed";
import AppMiniBoard from "@/components/AppMiniBoard";

/** Build a one-page response board from the game's locked options, laid out 2×4
 *  so 2–4 choices read large. Each option's id is preserved as the button id so
 *  a press maps straight back to `board_option_selected`. Mirrors
 *  `lockedBoardFrom` in pages/home.tsx. */
function lockedBoardFrom(options: BoardOption[]): ParsedBoardData {
  return {
    name: "Choose",
    grid: { rows: 4, cols: 2 },
    pages: [
      {
        id: "game-locked",
        name: "Choose",
        buttons: options.slice(0, 8).map((o, i) => ({
          id: o.id,
          row: Math.floor(i / 2),
          col: i % 2,
          label: o.label,
          spokenText: o.label,
          glyph: o.glyph,
          action: { type: "speak" as const, text: o.label },
        })),
      },
    ],
  };
}

export default function SymbolGameSandbox() {
  const { language, direction } = useLanguage();
  const gameRef = useRef<GameEmbedHandle>(null);
  const [lockedBoard, setLockedBoard] = useState<ParsedBoardData | null>(null);

  // Cycle through the catalog (family A) — each exchange is compiled fresh from
  // the new symbol-game content layer (compileExchange), with a random binding.
  // `reroll` re-rolls the pool fills for the same exchange.
  const [idx, setIdx] = useState(0);
  const [reroll, setReroll] = useState(0);
  const exchange = REQUESTING_EXCHANGES[idx]!;

  const built = useMemo(() => {
    try {
      const bound = bindExchange(exchange, POOLS, randomMemberPicker);
      return { game: compileExchange(bound, { pools: POOLS }), error: null as string | null };
    } catch (e) {
      return { game: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [exchange, reroll]);

  const step = (d: number) => {
    setLockedBoard(null);
    setIdx((i) => (i + d + REQUESTING_EXCHANGES.length) % REQUESTING_EXCHANGES.length);
  };

  // Game locks/releases the response board (set_board_options/clear_board_options).
  const handleBoardOptions = useCallback((options: BoardOption[] | null) => {
    setLockedBoard(options && options.length ? lockedBoardFrom(options) : null);
  }, []);

  // A side-board press is the student answering the game's puzzle on the real
  // button board — route it to the game, which judges correctness. (No AI press
  // flow exists in the sandbox.) AppMiniBoard already voiced the pick locally.
  const handleBoardButtonClick = useCallback((button: { id: string }) => {
    gameRef.current?.send({ type: "board_option_selected", id: button.id });
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col bg-black" dir={direction}>
      <div className="flex items-center justify-between gap-3 px-3 py-1 text-xs text-white/70 bg-zinc-900 flex-shrink-0">
        <div className="flex items-center gap-2">
          <button onClick={() => step(-1)} className="px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-white">◀</button>
          <span className="font-mono text-white/90 min-w-[12rem]">
            {idx + 1}/{REQUESTING_EXCHANGES.length} · {exchange.id} · <span className="text-amber-300">{exchange.concept}</span>
          </span>
          <button onClick={() => step(1)} className="px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-white">▶</button>
          <button onClick={() => { setLockedBoard(null); setReroll((n) => n + 1); }} className="px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-white">⟳ reroll</button>
          <span className="text-white/40 font-mono">{exchange.prompt.glyph}</span>
        </div>
        <a href="/aac" className="underline hover:text-white">Exit</a>
      </div>
      <div className="flex-1 min-h-0 flex flex-row">
        {/* Locked-board options on the side, exactly as in-app (2 cols). */}
        {lockedBoard && (
          <AppMiniBoard
            board={lockedBoard}
            columns={2}
            onButtonClick={handleBoardButtonClick}
            language={language}
            voiceType="boy"
            suppressLocalSpeech={false}
          />
        )}
        <div className="flex-1 min-w-0 h-full">
          {built.error ? (
            <div className="h-full flex items-center justify-center text-red-400 font-mono text-sm p-6 text-center">
              compile error: {built.error}
            </div>
          ) : (
            <GoalTreeQuestPlayer
              // Remount on exchange/reroll so the iframe reloads the new game.
              key={`${idx}-${reroll}`}
              game={built.game!}
              renderMode="3d"
              // No sendMessageToAi — the AI companion is intentionally absent.
              gameRef={gameRef}
              onBoardOptions={handleBoardOptions}
              onClose={() => { window.location.href = "/aac"; }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
