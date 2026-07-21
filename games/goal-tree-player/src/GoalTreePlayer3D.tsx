// games/goal-tree-player/src/GoalTreePlayer3D.tsx
//
// The goal-tree quest player rendered THROUGH the world engine in 3D. All the
// gameplay lives ENGINE-SIDE in the shared quest host (shared/symbol-game/
// quest-host — session assembly, creature conversations, NPC errands, the
// per-frame quest loop); this component is the AAC-facing chrome around it:
//   • the games-bridge wiring (init/gaze/load_game/pause/board presses),
//   • the EMBEDDED split — answered on the real AAC response board (iframe
//     parent) vs the in-app dwell ChoicePanel when standalone,
//   • the React HUD (objectives, satchel, toasts, win overlay).
//
// Mounted via main.tsx when the URL carries ?render=3d.

import { useEffect, useRef, useState } from "react";
import { onPlatformMessage, sendToParent } from "@shared/games-bridge";
import type { GoalNode } from "@shared/world-engine/solver/types";
import { certifyGoalTreeGame } from "@shared/world-engine/solver/index";
import type { NarrationKind, ObjectiveSummary } from "@shared/world-engine/solver/space";
import {
  createQuestHost3D,
  type QuestBoardView,
  type QuestHost3D,
  type QuestSession,
} from "@shared/world-engine/interaction/quest/quest-host";
import { buildTownPlay, isTownPlayPayload } from "@shared/world-engine/interaction/town/town-play";
import { playerImageResolver } from "./glyph-resolver";
import {
  ChoicePanel,
  ObjectivesBar,
  SatchelBar,
  Toast,
  WinOverlay,
  type ActiveChoice,
  type GazeSample,
} from "./components";
import { demoGame } from "./demo-content";

const GAME_ID = "goal-tree-player-3d";
const DEFAULT_DWELL_MS = 650;
const TOAST_MS = 3500;

// Embedded in the AAC (an iframe) → questions are answered on the REAL
// response board (teaches its use) and the board voices the student's press
// in the parent frame. Standalone (the free single-player path, incl. the
// Electron app) → the in-game dwell panel + the host voices the statement.
const EMBEDDED = typeof window !== "undefined" && window.self !== window.top;

export default function GoalTreePlayer3D() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<QuestHost3D | null>(null);

  // HUD state (low-frequency; the GL canvas never re-renders React).
  const [session, setSession] = useState<QuestSession | null>(null);
  const [objectives, setObjectives] = useState<ObjectiveSummary[]>([]);
  const [collectHud, setCollectHud] = useState<Record<string, { have: number; need: number }>>({});
  const [satchel, setSatchel] = useState<Record<string, number>>({});
  const [toast, setToastState] = useState<{ text: string; kind: NarrationKind } | null>(null);
  const [choice, setChoice] = useState<ActiveChoice | null>(null);
  const [won, setWon] = useState(false);

  const dwellMsRef = useRef(DEFAULT_DWELL_MS);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pointer: the last client px, mirrored into the host (which owns the
  // gaze-intent interpreter + camera) and into gazeRef (client px, for the
  // dwell-driven HUD buttons).
  const lastClientRef = useRef<{ x: number; y: number } | null>(null);
  const pointerModeRef = useRef<"mouse" | "eyegaze">("mouse");
  const gazeRef = useRef<GazeSample | null>(null);

  function showToast(text: string, kind: NarrationKind) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToastState({ text, kind });
    toastTimer.current = setTimeout(() => setToastState(null), TOAST_MS);
  }

  /** Everything the quest host wants shown, mapped onto the AAC bridge (when
   *  embedded) and the React HUD. */
  function makePresenter() {
    return {
      sessionStarted(s: QuestSession) {
        setSession(s);
        setWon(false);
        setChoice(null);
        setCollectHud({});
        setSatchel({});
        setObjectives([]);
      },
      board(view: QuestBoardView) {
        if (EMBEDDED) {
          // Answer on the REAL response board: lock its side buttons to the
          // options. label + spokenText carry the translated statement; the
          // composed `glyph` renders the real symbol the student is learning.
          sendToParent({
            type: "set_board_options",
            prompt: view.prompt,
            options: view.options.map((o) => ({
              id: o.id,
              label: o.label,
              glyph: o.glyph,
              spokenText: o.spokenText,
            })),
          });
        } else if (view.kind === "choice") {
          // Standalone: the in-game dwell panel (entity options). Creature
          // conversations stay board-side only — no standalone acts UI (yet).
          setChoice({
            nodeId: view.nodeId,
            posedByEntityId: view.posedByEntityId,
            prompt: view.prompt,
            options: view.options.map((o) => ({ entityId: o.id })),
          });
        }
      },
      clearBoard() {
        setChoice(null);
        if (EMBEDDED) sendToParent({ type: "clear_board_options" });
      },
      toast: showToast,
      objectives: setObjectives,
      collect(nodeId: string, have: number, need: number) {
        setCollectHud((prev) => ({ ...prev, [nodeId]: { have, need } }));
      },
      satchel: setSatchel,
      won() {
        setWon(true);
      },
      score(value: number) {
        sendToParent({ type: "score", value });
      },
      action(action: string, meta?: Record<string, unknown>) {
        sendToParent({ type: "player_action", action, ...(meta ? { meta } : {}) });
      },
    };
  }

  // Bridge wiring (gaze + load/pause/close + board presses).
  useEffect(() => {
    const unsubscribe = onPlatformMessage((msg) => {
      const host = hostRef.current;
      switch (msg.type) {
        case "init":
          if (typeof msg.dwellMs === "number" && msg.dwellMs > 0) dwellMsRef.current = msg.dwellMs;
          break;
        case "gaze":
          // Raw pointer only — the host's gaze-intent does the smoothing/fixation.
          if (msg.mode === "off") {
            // The parent streams "off" ~30Hz whenever there is no gaze sample —
            // including when NO dwell provider is mounted at all (e.g. the
            // /symbol-game sandbox). Don't let that heartbeat clobber a live
            // MOUSE pointer: only honor "off" when gaze was actually driving.
            // Otherwise a still mouse (no pointermove) gets cleared 30×/sec and
            // the avatar coasts to a stop.
            if (pointerModeRef.current !== "mouse") {
              lastClientRef.current = null;
              gazeRef.current = null;
              host?.clearPointer();
            }
          } else {
            lastClientRef.current = { x: msg.x, y: msg.y };
            pointerModeRef.current = msg.mode === "eyegaze" ? "eyegaze" : "mouse";
            host?.setPointer(msg.x, msg.y);
          }
          break;
        case "load_game": {
          // A LIVING-TOWN payload rides the same channel, discriminated by
          // its engine field — the host rebuilds the whole deterministic
          // session (town, quests, stage) from the serializable config.
          if (isTownPlayPayload(msg.game)) {
            try {
              const play = buildTownPlay(msg.game);
              host?.start(play.bundle.game, play);
            } catch (e) {
              console.error("goal-tree-player-3d: rejected town-play payload", e);
            }
            break;
          }
          const certified = certifyGoalTreeGame(msg.game);
          if (certified.ok) host?.start(certified.game);
          else console.error("goal-tree-player-3d: rejected load_game", certified.errors);
          break;
        }
        case "pause":
          host?.setPaused(true);
          break;
        case "resume":
          host?.setPaused(false);
          break;
        case "board_option_selected":
          // The student answered on the real AAC board: the board voices their
          // statement in the parent frame — the host holds its response back
          // until that's done (spokenExternally).
          host?.select(msg.id, { spokenExternally: true });
          break;
        case "request_close":
          sendToParent({ type: "session_end", reason: hostRef.current?.won ? "won" : "quit" });
          break;
        default:
          break;
      }
    });
    sendToParent({ type: "ready", gameId: GAME_ID, version: "0.1.0" });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mouse fallback (standalone dev / clinician mouse). The pointer PERSISTS at its
  // last position — a still mouse keeps steering. Cleared only when it leaves the
  // document or the window blurs.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      lastClientRef.current = { x: e.clientX, y: e.clientY };
      pointerModeRef.current = "mouse";
      hostRef.current?.setPointer(e.clientX, e.clientY);
    };
    const clear = () => {
      if (pointerModeRef.current === "mouse") {
        lastClientRef.current = null;
        hostRef.current?.clearPointer();
      }
    };
    window.addEventListener("pointermove", onMove);
    document.addEventListener("pointerleave", clear);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", clear);
      window.removeEventListener("blur", clear);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mount the quest host + keep it sized to the canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Voice inventory, once — answers "why does everyone sound the same?"
    // (distinct speakers need the OS to offer >1 voice for the language.)
    const logVoices = () => {
      const vs = window.speechSynthesis?.getVoices() ?? [];
      if (vs.length) {
        console.log(
          `[voice] ${vs.length} system voices:`,
          vs.map((v) => `${v.lang} ${v.name}`).join(" · "),
        );
      }
    };
    logVoices();
    try {
      window.speechSynthesis?.addEventListener("voiceschanged", logVoices, { once: true });
    } catch { /* older engines */ }
    const host = createQuestHost3D({
      canvas,
      presenter: makePresenter(),
      resolveImage: playerImageResolver,
      // Keep the dwell-driven HUD buttons live on a still pointer.
      onFrame: () => {
        const p = lastClientRef.current;
        if (p) gazeRef.current = { x: p.x, y: p.y, at: performance.now(), mode: pointerModeRef.current };
      },
    });
    hostRef.current = host;
    host.start(demoGame());
    const ro = new ResizeObserver(() => {
      host.resize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1);
    });
    ro.observe(canvas);
    return () => {
      ro.disconnect();
      host.stop();
      hostRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nodeById: Map<string, GoalNode> = session?.ctx.nodeById ?? new Map();
  const entities = session?.entities ?? new Map();

  return (
    <div className="player-root">
      <canvas ref={canvasRef} className="world-canvas" />

      <ObjectivesBar
        objectives={objectives}
        nodeById={nodeById}
        entities={entities}
        collectHud={collectHud}
      />

      <SatchelBar satchel={satchel} entities={entities} />

      {toast && <Toast text={toast.text} kind={toast.kind} />}

      {choice && (
        <ChoicePanel
          choice={choice}
          entities={entities}
          gazeRef={gazeRef}
          dwellMs={dwellMsRef.current}
          onSelect={(entityId) => hostRef.current?.select(entityId)}
          onClose={() => hostRef.current?.cancelChoice()}
        />
      )}

      {won && session && (
        <WinOverlay
          title={session.game.root.outro ?? session.game.meta.title}
          gazeRef={gazeRef}
          dwellMs={dwellMsRef.current}
          onReplay={() => hostRef.current?.replay()}
        />
      )}
    </div>
  );
}
