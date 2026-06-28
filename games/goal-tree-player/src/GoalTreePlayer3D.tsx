// games/goal-tree-player/src/GoalTreePlayer3D.tsx
//
// The Phase-0 merge spike: the goal-tree quest player rendered THROUGH the world
// engine's 3D view instead of its own 2D canvas. Same quest runtime, same HUD
// components, same bridge — only the space + renderer change:
//   • locomotion + camera + avatar  → shared/world-engine (World3DRenderer)
//   • quest furniture (rooms/items) → GoalTreeOverlay3D (a SceneOverlay)
//   • runtime ↔ space wiring        → shared/goal-tree/space3d (Space3D)
//
// Mounted via main.tsx when the URL carries ?render=3d; the 2D player remains the
// default. Locomotion here is continuous gaze steering (the world-engine "arrive"
// feel) — the walk/steer toggle and dwell-to-walk are a 2D-only affordance.

import { useEffect, useRef, useState } from "react";
import { onPlatformMessage, sendToParent } from "@shared/games-bridge";
import { GazeSmoother } from "@shared/gaze-kit";
import type { EntityDef, GoalNode, GoalTreeGame } from "@shared/goal-tree/types";
import { certifyGoalTreeGame } from "@shared/goal-tree/index";
import { buildLogicalWorld, type LogicalWorld } from "@shared/goal-tree/logical-world";
import { projectLayout2D } from "@shared/goal-tree/projector2d";
import {
  applyRuntimeInput,
  createRuntimeContext,
  createRuntimeState,
  type RuntimeContext,
  type RuntimeResult,
  type RuntimeState,
} from "@shared/goal-tree/runtime";
import type { NarrationKind, ObjectiveSummary, SpaceInput } from "@shared/goal-tree/space";
import type { Vec2 } from "@shared/goal-tree/layout2d";
import {
  applySpace3DCommand,
  createSpace3DState,
  embedLayoutInWorld,
  PLAYER_ID,
  tickSpace3D,
  type Space3DState,
  type WorldEmbedding,
} from "@shared/goal-tree/space3d";
import { World3DRenderer } from "@shared/world-engine/render3d";
import { GoalTreeOverlay3D } from "./goaltree-overlay-3d";
import {
  ChoicePanel,
  ObjectivesBar,
  Toast,
  WinOverlay,
  type ActiveChoice,
  type GazeSample,
} from "./components";
import { demoGame } from "./demo-content";

const GAME_ID = "goal-tree-player-3d";
const DEFAULT_DWELL_MS = 650;
const GAZE_FRESH_MS = 400;
const TOAST_MS = 3500;

interface Session {
  game: GoalTreeGame;
  world: LogicalWorld;
  ctx: RuntimeContext;
  embedding: WorldEmbedding;
  entities: Map<string, EntityDef>;
  rState: RuntimeState;
  sState: Space3DState;
}

function makeSession(game: GoalTreeGame): Session {
  const certified = certifyGoalTreeGame(game);
  if (!certified.ok) {
    console.error("goal-tree-player-3d: game failed certification", certified.errors);
  }
  const world = certified.ok ? certified.world : buildLogicalWorld(game);
  const layout = certified.ok ? certified.layout : projectLayout2D(game, world);
  const embedding = embedLayoutInWorld(layout);
  return {
    game,
    world,
    ctx: createRuntimeContext(game, world),
    embedding,
    entities: new Map(game.entities.map((e) => [e.id, e])),
    rState: createRuntimeState(),
    sState: createSpace3DState(embedding, world),
  };
}

export default function GoalTreePlayer3D() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<Session | null>(null);
  if (!sessionRef.current) sessionRef.current = makeSession(demoGame());
  const rendererRef = useRef<World3DRenderer | null>(null);

  // HUD state (low-frequency; the GL canvas never re-renders React).
  const [objectives, setObjectives] = useState<ObjectiveSummary[]>([]);
  const [collectHud, setCollectHud] = useState<Record<string, { have: number; need: number }>>({});
  const [toast, setToastState] = useState<{ text: string; kind: NarrationKind } | null>(null);
  const [choice, setChoice] = useState<ActiveChoice | null>(null);
  const [won, setWon] = useState(false);

  // Loop-visible mirrors.
  const objectivesRef = useRef<ObjectiveSummary[]>([]);
  const choiceRef = useRef<ActiveChoice | null>(null);
  const wonRef = useRef(false);
  const pausedRef = useRef(false);
  const gazeRef = useRef<GazeSample | null>(null);
  const dwellMsRef = useRef(DEFAULT_DWELL_MS);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const smootherRef = useRef(new GazeSmoother({ timeConstantMs: 80, snapDistance: 220 }));

  function showToast(text: string, kind: NarrationKind) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToastState({ text, kind });
    toastTimer.current = setTimeout(() => setToastState(null), TOAST_MS);
  }

  function processResult(result: RuntimeResult) {
    const session = sessionRef.current!;
    session.rState = result.state;

    for (const command of result.commands) {
      switch (command.type) {
        case "unlock-passage":
        case "collect-item":
          applySpace3DCommand(session.sState, command);
          break;
        case "present-choice":
          choiceRef.current = command;
          setChoice(command);
          break;
        case "dismiss-choice":
          choiceRef.current = null;
          setChoice(null);
          break;
        case "clear-obstacle":
        case "celebrate":
          break;
      }
    }

    for (const event of result.events) {
      switch (event.type) {
        case "narrate":
          showToast(event.text, event.kind);
          break;
        case "objectives-changed":
          objectivesRef.current = event.objectives;
          setObjectives(event.objectives);
          break;
        case "item-collected":
          setCollectHud((prev) => ({
            ...prev,
            [event.nodeId]: { have: event.have, need: event.need },
          }));
          break;
        case "goal-completed":
          sendToParent({ type: "score", value: Object.keys(session.rState.completed).length });
          break;
        case "game-won":
          wonRef.current = true;
          setWon(true);
          sendToParent({ type: "player_action", action: "game_won" });
          break;
        case "distractor-picked": {
          const icon = session.entities.get(event.entityId)?.iconRef ?? "❔";
          showToast(`${icon} …`, "feedback");
          break;
        }
        case "wrong-choice":
          if (!event.feedback) showToast("❌", "feedback");
          break;
        case "zone-entered":
          if (event.hint) showToast(event.hint, "intro");
          break;
        case "obstacle-locked":
        case "guard-cleared":
          break;
      }
    }
  }

  function dispatchInput(input: SpaceInput) {
    const session = sessionRef.current!;
    processResult(applyRuntimeInput(session.ctx, session.rState, input));
  }

  function buildRenderer(session: Session) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    rendererRef.current?.dispose();
    const overlay = new GoalTreeOverlay3D({
      layout: session.embedding.layout,
      world: session.world,
      entities: session.entities,
      getView: () => ({
        removed: session.sState.removed,
        unlocked: session.sState.unlocked,
        completed: session.rState.completed,
      }),
    });
    const renderer = new World3DRenderer(canvas, session.embedding.spec, {
      localId: PLAYER_ID,
      overlay,
    });
    const dpr = window.devicePixelRatio || 1;
    renderer.resize(canvas.clientWidth, canvas.clientHeight, dpr);
    rendererRef.current = renderer;
  }

  function startSession(game: GoalTreeGame) {
    sessionRef.current = makeSession(game);
    wonRef.current = false;
    choiceRef.current = null;
    objectivesRef.current = [];
    setWon(false);
    setChoice(null);
    setCollectHud({});
    setObjectives([]);
    buildRenderer(sessionRef.current);
    dispatchInput({ type: "start" });
  }

  function replay() {
    startSession(sessionRef.current!.game);
  }

  // Bridge wiring (mirrors the 2D player; gaze + load/pause/close).
  useEffect(() => {
    const unsubscribe = onPlatformMessage((msg) => {
      switch (msg.type) {
        case "init":
          if (typeof msg.dwellMs === "number" && msg.dwellMs > 0) dwellMsRef.current = msg.dwellMs;
          break;
        case "gaze":
          if (msg.mode === "off") {
            gazeRef.current = null;
            smootherRef.current.reset();
          } else {
            const smoothed =
              msg.mode === "eyegaze"
                ? smootherRef.current.update({ x: msg.x, y: msg.y }, performance.now())
                : { x: msg.x, y: msg.y };
            gazeRef.current = { ...smoothed, at: performance.now(), mode: msg.mode };
          }
          break;
        case "load_game": {
          const certified = certifyGoalTreeGame(msg.game);
          if (certified.ok) startSession(certified.game);
          else console.error("goal-tree-player-3d: rejected load_game", certified.errors);
          break;
        }
        case "pause":
          pausedRef.current = true;
          break;
        case "resume":
          pausedRef.current = false;
          break;
        case "request_close":
          sendToParent({ type: "session_end", reason: wonRef.current ? "won" : "quit" });
          break;
        default:
          break;
      }
    });
    sendToParent({ type: "ready", gameId: GAME_ID, version: "0.1.0" });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pointer fallback (standalone dev / clinician mouse) — drives steering aim.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      gazeRef.current = { x: e.clientX, y: e.clientY, at: performance.now(), mode: "mouse" };
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  // Main loop.
  useEffect(() => {
    if (!canvasRef.current) return;
    buildRenderer(sessionRef.current!);
    dispatchInput({ type: "start" });

    let raf = 0;
    let last = performance.now();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;

      const canvas = canvasRef.current;
      const renderer = rendererRef.current;
      const session = sessionRef.current;
      if (!canvas || !renderer || !session) return;

      const dpr = window.devicePixelRatio || 1;
      renderer.resize(canvas.clientWidth, canvas.clientHeight, dpr);

      const gaze = gazeRef.current;
      const gazeFresh = gaze && now - gaze.at < GAZE_FRESH_MS ? gaze : null;
      const choiceOpen = choiceRef.current !== null;

      let aim: Vec2 | null = null;
      if (!pausedRef.current && !wonRef.current && gazeFresh && !choiceOpen) {
        const rect = canvas.getBoundingClientRect();
        aim = renderer.screenToWorld(gaze!.x - rect.left, gaze!.y - rect.top);
      }

      if (!pausedRef.current && !wonRef.current) {
        const result = tickSpace3D(session.embedding.layout, session.sState, { aim }, dt);
        for (const input of result.inputs) dispatchInput(input);
      }

      renderer.render(
        session.sState.world,
        dt,
        () => null, // faceFor — no photos in the quest avatar
        (id) => (id === PLAYER_ID ? "You" : ""),
      );
    };

    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const session = sessionRef.current!;
  const nodeById: Map<string, GoalNode> = session.ctx.nodeById;

  return (
    <div className="player-root">
      <canvas ref={canvasRef} className="world-canvas" />

      <ObjectivesBar
        objectives={objectives}
        nodeById={nodeById}
        entities={session.entities}
        collectHud={collectHud}
      />

      {toast && <Toast text={toast.text} kind={toast.kind} />}

      {choice && (
        <ChoicePanel
          choice={choice}
          entities={session.entities}
          gazeRef={gazeRef}
          dwellMs={dwellMsRef.current}
          onSelect={(entityId) =>
            dispatchInput({ type: "select-option", nodeId: choice.nodeId, entityId })
          }
          onClose={() => dispatchInput({ type: "cancel-choice", nodeId: choice.nodeId })}
        />
      )}

      {won && (
        <WinOverlay
          title={session.game.root.outro ?? session.game.meta.title}
          gazeRef={gazeRef}
          dwellMs={dwellMsRef.current}
          onReplay={replay}
        />
      )}
    </div>
  );
}
