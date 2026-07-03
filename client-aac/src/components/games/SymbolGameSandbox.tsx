// client-aac/src/components/games/SymbolGameSandbox.tsx
//
// Dev/test harness for the symbol-learning game, reachable at /symbol-game with
// NO auth, NO student selection, and NO live AI session. The symbol-learning
// game runs entirely client-side (the goal-tree player judges correctness
// itself); the AI is only ever a narration companion, so the game is fully
// playable without it.
//
// Two modes:
//   • WORLD — the quest-world generator (world-gen.ts): a village of NPC
//     quests driven by the `converse` dialogue trees, parameterized by the
//     puzzle-types.md dimensions (quest count · syntax level · complexity).
//   • BEATS — the original single-exchange lessons (catalog A), one compiled
//     observe/choose beat at a time.
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
  buildCreatureQuestWorld,
  certifyCreatureQuestWorld,
  compileExchange,
  POOLS,
  randomMemberPicker,
  type QuestComplexity,
  type SyntaxLevel,
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
          spokenText: o.spokenText ?? o.label,
          glyph: o.glyph,
          action: { type: "speak" as const, text: o.spokenText ?? o.label },
        })),
      },
    ],
  };
}

const selectCls = "bg-zinc-700 text-white rounded px-1 py-0.5";

export default function SymbolGameSandbox() {
  const { language, direction } = useLanguage();
  const gameRef = useRef<GameEmbedHandle>(null);
  const [lockedBoard, setLockedBoard] = useState<ParsedBoardData | null>(null);

  const [mode, setMode] = useState<"world" | "beats">("world");

  // -- WORLD mode: the quest-world generator's dimension knobs.
  const [questCount, setQuestCount] = useState(2);
  const [syntax, setSyntax] = useState<SyntaxLevel>("b");
  const [complexity, setComplexity] = useState<QuestComplexity | "mixed">("simple");
  const [clues, setClues] = useState<"direct" | "askAround">("direct");
  const [needCount, setNeedCount] = useState(1);
  const [task, setTask] = useState<"fetch" | "place" | "deliver">("fetch");
  const [descriptors, setDescriptors] = useState(false);
  const [transformations, setTransformations] = useState(false);
  const [request, setRequest] = useState<"before" | "after" | "never">("before");
  const [thought, setThought] = useState(true);

  // The world SEED: one number reproduces the whole village (quest draws,
  // layout, buildings, house colors). Regenerate rolls a fresh one; typing a
  // known seed back in rebuilds that exact village.
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1_000_000));

  // -- BEATS mode: cycle the catalog (family A); `reroll` re-rolls pool fills.
  const [idx, setIdx] = useState(0);
  const [reroll, setReroll] = useState(0);
  const exchange = REQUESTING_EXCHANGES[idx]!;

  const built = useMemo(() => {
    try {
      if (mode === "world") {
        // Need-based creature quests (creature-needs.md). The simulation
        // certifier is the playability proof; surface its failure loudly.
        // The clinician's UI language IS the game locale — spoken lines come
        // out of the matching translation ruleset (en fallback).
        const game = buildCreatureQuestWorld({ questCount, locale: language, syntax, complexity, clueRouting: clues, needCount, task, descriptors, transformations, giverAnnounce: request, thoughtScaffold: thought, seed });
        const cert = certifyCreatureQuestWorld(game);
        if (!cert.ok) throw new Error(`${cert.stage}: ${cert.errors.join("; ")}`);
        return { game, error: null as string | null };
      }
      const bound = bindExchange(exchange, POOLS, randomMemberPicker);
      return { game: compileExchange(bound, { pools: POOLS }), error: null as string | null };
    } catch (e) {
      return { game: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [mode, questCount, language, syntax, complexity, clues, needCount, task, descriptors, transformations, request, thought, seed, exchange, reroll]);

  const step = (d: number) => {
    setLockedBoard(null);
    setIdx((i) => (i + d + REQUESTING_EXCHANGES.length) % REQUESTING_EXCHANGES.length);
  };
  const regenerate = () => {
    setLockedBoard(null);
    setSeed(Math.floor(Math.random() * 1_000_000));
    setReroll((n) => n + 1);
  };

  // Game locks/releases the response board (set_board_options/clear_board_options).
  const handleBoardOptions = useCallback((options: BoardOption[] | null) => {
    setLockedBoard(options && options.length ? lockedBoardFrom(options) : null);
  }, []);

  // A side-board press is the student answering the game's puzzle on the real
  // button board — route it to the game, which judges it. (No AI press flow
  // exists in the sandbox.) AppMiniBoard already voiced the pick locally.
  const handleBoardButtonClick = useCallback((button: { id: string }) => {
    gameRef.current?.send({ type: "board_option_selected", id: button.id });
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col bg-black" dir={direction}>
      <div className="flex items-center justify-between gap-3 px-3 py-1 text-xs text-white/70 bg-zinc-900 flex-shrink-0">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => { setLockedBoard(null); setMode(mode === "world" ? "beats" : "world"); }}
            className="px-2 py-0.5 rounded bg-indigo-700 hover:bg-indigo-600 text-white"
          >
            {mode === "world" ? "🌍 world" : "🎯 beats"}
          </button>
          {mode === "world" ? (
            <>
              <label className="flex items-center gap-1">
                quests
                <select className={selectCls} value={questCount} onChange={(e) => { setLockedBoard(null); setQuestCount(Number(e.target.value)); }}>
                  {/* Up to 4 puzzles share one village (clamped by NPC supply —
                      request/exchange quests use 2 creatures each). */}
                  {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-1">
                syntax
                <select className={selectCls} value={syntax} onChange={(e) => { setLockedBoard(null); setSyntax(e.target.value as SyntaxLevel); }}>
                  <option value="a">a — single glyph</option>
                  <option value="b">b — two glyphs</option>
                  <option value="c">c — sentence</option>
                </select>
              </label>
              <label className="flex items-center gap-1">
                quests type
                <select className={selectCls} value={complexity} onChange={(e) => { setLockedBoard(null); setComplexity(e.target.value as QuestComplexity | "mixed"); }}>
                  <option value="simple">simple (item nearby)</option>
                  <option value="request">request (ask the vendor)</option>
                  <option value="exchange">exchange (trade for it)</option>
                  <option value="lend">lend (give it back first)</option>
                  <option value="mixed">mixed</option>
                </select>
              </label>
              <label className="flex items-center gap-1">
                clues
                <select className={selectCls} value={clues} onChange={(e) => { setLockedBoard(null); setClues(e.target.value as "direct" | "askAround"); }}>
                  <option value="direct">direct (the wanter knows)</option>
                  <option value="askAround">ask around (someone else knows)</option>
                </select>
              </label>
              <label className="flex items-center gap-1">
                items
                <select className={selectCls} value={needCount} onChange={(e) => { setLockedBoard(null); setNeedCount(Number(e.target.value)); }}>
                  {[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-1">
                task
                <select className={selectCls} value={task} onChange={(e) => { setLockedBoard(null); setTask(e.target.value as "fetch" | "place" | "deliver"); }}>
                  <option value="fetch">fetch (bring it to me)</option>
                  <option value="place">place (put it in the box)</option>
                  <option value="deliver">deliver (give it to a friend)</option>
                </select>
              </label>
              <label className="flex items-center gap-1">
                descriptors
                <select className={selectCls} value={descriptors ? "on" : "off"} onChange={(e) => { setLockedBoard(null); setDescriptors(e.target.value === "on"); }}>
                  <option value="off">off (plain items)</option>
                  <option value="on">on (big/small, colors)</option>
                </select>
              </label>
              <label className="flex items-center gap-1">
                transform
                <select className={selectCls} value={transformations ? "on" : "off"} onChange={(e) => { setLockedBoard(null); setTransformations(e.target.value === "on"); }}>
                  <option value="off">off (items as-is)</option>
                  <option value="on">on (fire/water stations)</option>
                </select>
              </label>
              <label className="flex items-center gap-1">
                request
                <select className={selectCls} value={request} onChange={(e) => { setLockedBoard(null); setRequest(e.target.value as "before" | "after" | "never"); }}>
                  <option value="before">stated (says the want)</option>
                  <option value="after">asked (reveal via small talk)</option>
                  <option value="never">inferred (sad + evidence)</option>
                </select>
              </label>
              {request === "never" && (
                <label className="flex items-center gap-1">
                  thought
                  <select className={selectCls} value={thought ? "on" : "off"} onChange={(e) => { setLockedBoard(null); setThought(e.target.value === "on"); }}>
                    <option value="on">bubble on (scaffold)</option>
                    <option value="off">bubble off (evidence only)</option>
                  </select>
                </label>
              )}
              <label className="flex items-center gap-1">
                seed
                <input
                  type="number"
                  className={`${selectCls} w-20`}
                  value={seed}
                  onChange={(e) => { setLockedBoard(null); setSeed(Math.max(0, Math.floor(Number(e.target.value) || 0))); }}
                />
              </label>
              <button onClick={regenerate} className="px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-white">⟳ regenerate</button>
            </>
          ) : (
            <>
              <button onClick={() => step(-1)} className="px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-white">◀</button>
              <span className="font-mono text-white/90 min-w-[12rem]">
                {idx + 1}/{REQUESTING_EXCHANGES.length} · {exchange.id} · <span className="text-amber-300">{exchange.concept}</span>
              </span>
              <button onClick={() => step(1)} className="px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-white">▶</button>
              <button onClick={regenerate} className="px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-white">⟳ reroll</button>
              <span className="text-white/40 font-mono">{exchange.prompt.glyph}</span>
            </>
          )}
        </div>
        <a href="/aac" className="underline hover:text-white">Exit</a>
      </div>
      <div className="flex-1 min-h-0 flex flex-row">
        {/* Locked-board options on the side, exactly as in-app (2 cols). Always
            MOUNTED — its container keeps its fixed width when empty, so the
            game viewport never stretches/shrinks as conversations open/close. */}
        <AppMiniBoard
          board={lockedBoard}
          columns={2}
          onButtonClick={handleBoardButtonClick}
          language={language}
          voiceType="boy"
          suppressLocalSpeech={false}
        />
        <div className="flex-1 min-w-0 h-full">
          {built.error ? (
            <div className="h-full flex items-center justify-center text-red-400 font-mono text-sm p-6 text-center">
              build error: {built.error}
            </div>
          ) : (
            <GoalTreeQuestPlayer
              // Remount on any knob change so the iframe reloads the new game.
              key={`${mode}-${questCount}-${language}-${syntax}-${complexity}-${clues}-${needCount}-${task}-${descriptors}-${transformations}-${request}-${thought}-${seed}-${idx}-${reroll}`}
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
