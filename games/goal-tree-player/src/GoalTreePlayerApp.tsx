// The goal-tree quest player. A thin shell over the shared engine:
//   shared/goal-tree/runtime.ts  — game logic (pure reducer)
//   shared/goal-tree/space2d.ts  — movement/collision/proximity sim
// This file only renders, collects input (gaze/mouse/touch), and forwards
// runtime events over the games bridge.
//
// Locomotion is a player setting (🚶 walk = dwell-to-walk, 🛸 steer =
// continuous gaze steering), never a game property.

import { useEffect, useRef, useState } from "react";
import { onPlatformMessage, sendToParent } from "@shared/games-bridge";
import { GazeSmoother } from "@shared/gaze-kit";
import { DwellTracker } from "@shared/gaze-kit";
import type { EntityDef, GoalNode, GoalTreeGame } from "@shared/world-engine/solver/types";
import { certifyGoalTreeGame } from "@shared/world-engine/solver/index";
import type { LogicalWorld } from "@shared/world-engine/solver/logical-world";
import { buildLogicalWorld } from "@shared/world-engine/solver/logical-world";
import { projectGameLayout } from "@shared/world-engine/solver/projector2d";
import {
  applyRuntimeInput,
  createRuntimeContext,
  createRuntimeState,
  type RuntimeContext,
  type RuntimeResult,
  type RuntimeState,
} from "@shared/world-engine/solver/runtime";
import type {
  NarrationKind,
  ObjectiveSummary,
  SpaceInput,
} from "@shared/world-engine/solver/space";
import type { Layout2D, Vec2 } from "@shared/world-engine/solver/layout2d";
import { dist, rectCenter, rectContains } from "@shared/world-engine/solver/layout2d";
import {
  applySpace2DCommand,
  createSpace2DState,
  setWalkTarget,
  tickSpace2D,
  type Space2DState,
  type WalkIntent,
} from "@shared/world-engine/solver/space2d";
import { computeCamera, screenToWorld, type Camera } from "./camera";
import { drawFrame } from "./render";
import {
  ChoicePanel,
  DwellButton,
  ObjectivesBar,
  Toast,
  WinOverlay,
  type ActiveChoice,
  type GazeSample,
} from "./components";
import { demoGame } from "./demo-content";

const GAME_ID = "goal-tree-player";
const DEFAULT_DWELL_MS = 650;
const GAZE_FRESH_MS = 400;
const TOAST_MS = 3500;

type LocomotionMode = "walk" | "steer";

interface Session {
  game: GoalTreeGame;
  world: LogicalWorld;
  ctx: RuntimeContext;
  layout: Layout2D;
  entities: Map<string, EntityDef>;
  rState: RuntimeState;
  sState: Space2DState;
}

function makeSession(game: GoalTreeGame): Session {
  const certified = certifyGoalTreeGame(game);
  if (!certified.ok) {
    // Callers should certify payloads before handing them over; this guards
    // the built-in demo (checked in CI) and any slipped-through payloads.
    console.error("goal-tree-player: game failed certification", certified.errors);
  }
  const world = certified.ok ? certified.world : buildLogicalWorld(game);
  const ctx = createRuntimeContext(game, world);
  const layout = certified.ok ? certified.layout : projectGameLayout(game, world);
  return {
    game,
    world,
    ctx,
    layout,
    entities: new Map(game.entities.map((e) => [e.id, e])),
    rState: createRuntimeState(),
    sState: createSpace2DState(layout, world),
  };
}

interface HoverTarget {
  key: string;
  point: Vec2;
  intent: WalkIntent;
}

function resolveHover(session: Session, wp: Vec2): HoverTarget | null {
  for (const figure of session.layout.figures) {
    if (dist(wp, figure.pos) <= 1.2) {
      return {
        key: `fig:${figure.nodeId}`,
        point: figure.pos,
        intent: { kind: "figure", nodeId: figure.nodeId },
      };
    }
  }
  for (const item of session.layout.items) {
    if (session.sState.removed[item.instanceId]) continue;
    if (dist(wp, item.pos) <= 1.0) {
      return {
        key: `item:${item.instanceId}`,
        point: item.pos,
        intent: { kind: "item", instanceId: item.instanceId },
      };
    }
  }
  for (const door of session.layout.doors) {
    if (session.sState.unlocked[door.passageId]) continue;
    const inflated = {
      x: door.rect.x - 0.4,
      y: door.rect.y - 0.4,
      w: door.rect.w + 0.8,
      h: door.rect.h + 0.8,
    };
    if (rectContains(inflated, wp)) {
      return {
        key: `door:${door.passageId}`,
        point: rectCenter(door.rect),
        intent: { kind: "door", passageId: door.passageId },
      };
    }
  }
  if (session.layout.zones.some((z) => rectContains(z.rect, wp))) {
    // Floor: dwell on a ~1-unit cell to walk there.
    return {
      key: `cell:${Math.round(wp.x)}:${Math.round(wp.y)}`,
      point: wp,
      intent: { kind: "point" },
    };
  }
  return null;
}

export default function GoalTreePlayerApp() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<Session | null>(null);
  if (!sessionRef.current) sessionRef.current = makeSession(demoGame());

  // HUD state (low-frequency; the canvas never re-renders React).
  const [objectives, setObjectives] = useState<ObjectiveSummary[]>([]);
  const [collectHud, setCollectHud] = useState<
    Record<string, { have: number; need: number }>
  >({});
  const [toast, setToastState] = useState<{ text: string; kind: NarrationKind } | null>(
    null,
  );
  const [choice, setChoice] = useState<ActiveChoice | null>(null);
  const [won, setWon] = useState(false);
  const [mode, setMode] = useState<LocomotionMode>("walk");

  // Loop-visible mirrors.
  const objectivesRef = useRef<ObjectiveSummary[]>([]);
  const choiceRef = useRef<ActiveChoice | null>(null);
  const wonRef = useRef(false);
  const modeRef = useRef<LocomotionMode>("walk");
  const pausedRef = useRef(false);
  const gazeRef = useRef<GazeSample | null>(null);
  const camRef = useRef<Camera | null>(null);
  const dwellMsRef = useRef(DEFAULT_DWELL_MS);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const smootherRef = useRef(new GazeSmoother({ timeConstantMs: 80, snapDistance: 220 }));
  const worldDwellRef = useRef(
    new DwellTracker({ dwellMs: DEFAULT_DWELL_MS, graceMs: 180 }),
  );

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
          session.sState = applySpace2DCommand(session.sState, command);
          break;
        case "present-choice":
          choiceRef.current = command;
          setChoice(command);
          break;
        case "dismiss-choice":
          choiceRef.current = null;
          setChoice(null);
          break;
        case "demonstrate":
          // Phase-0: announce the taught glyph. The cue runner (animating
          // scale/move/spawn in-world) is the next rendering step.
          showToast(`👁 ${command.targetGlyph}`, "intro");
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
          sendToParent({
            type: "player_action",
            action: "item_collected",
            meta: {
              nodeId: event.nodeId,
              entityId: event.entityId,
              have: event.have,
              need: event.need,
            },
          });
          break;
        case "goal-completed":
          sendToParent({
            type: "player_action",
            action: "goal_completed",
            meta: { nodeId: event.nodeId, nodeType: event.nodeType },
          });
          sendToParent({
            type: "score",
            value: Object.keys(session.rState.completed).length,
          });
          break;
        case "game-won":
          wonRef.current = true;
          setWon(true);
          sendToParent({ type: "player_action", action: "game_won" });
          break;
        case "distractor-picked": {
          const icon = session.entities.get(event.entityId)?.iconRef ?? "❔";
          showToast(`${icon} …`, "feedback");
          sendToParent({
            type: "player_action",
            action: "distractor_picked",
            meta: { entityId: event.entityId },
          });
          break;
        }
        // Authored feedback (if any) already shows via its own "narrate" event.
        // When the author gave no feedback, still show a language-neutral "wrong"
        // cue so a pick never feels like it did nothing.
        case "wrong-choice":
          if (!event.feedback) showToast("❌", "feedback");
          sendToParent({
            type: "player_action",
            action: "wrong_choice",
            meta: { nodeId: event.nodeId, entityId: event.entityId },
          });
          break;
        case "obstacle-locked":
          sendToParent({
            type: "player_action",
            action: "obstacle_locked",
            meta: { nodeId: event.nodeId },
          });
          break;
        case "guard-cleared":
          sendToParent({
            type: "player_action",
            action: "guard_cleared",
            meta: { nodeId: event.nodeId },
          });
          break;
        case "zone-entered":
          if (event.hint) showToast(event.hint, "intro");
          break;
        case "demonstration-shown":
          sendToParent({
            type: "player_action",
            action: "demonstration_shown",
            meta: { nodeId: event.nodeId, targetGlyph: event.targetGlyph },
          });
          break;
      }
    }
  }

  function dispatchInput(input: SpaceInput) {
    const session = sessionRef.current!;
    processResult(applyRuntimeInput(session.ctx, session.rState, input));
  }

  /** (Re)start play with the given game — used by replay and load_game. */
  function startSession(game: GoalTreeGame) {
    sessionRef.current = makeSession(game);
    wonRef.current = false;
    choiceRef.current = null;
    objectivesRef.current = [];
    setWon(false);
    setChoice(null);
    setCollectHud({});
    setObjectives([]);
    dispatchInput({ type: "start" });
  }

  function replay() {
    startSession(sessionRef.current!.game);
  }

  // Bridge wiring.
  useEffect(() => {
    const unsubscribe = onPlatformMessage((msg) => {
      switch (msg.type) {
        case "init":
          if (typeof msg.dwellMs === "number" && msg.dwellMs > 0) {
            dwellMsRef.current = msg.dwellMs;
            worldDwellRef.current.setDwellMs(msg.dwellMs);
          }
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
            gazeRef.current = {
              ...smoothed,
              at: performance.now(),
              mode: msg.mode,
            };
          }
          break;
        case "load_game": {
          const certified = certifyGoalTreeGame(msg.game);
          if (certified.ok) {
            startSession(certified.game);
            sendToParent({
              type: "player_action",
              action: "game_loaded",
              meta: { title: certified.game.meta.title },
            });
          } else {
            console.error("goal-tree-player: rejected load_game payload", certified.errors);
            sendToParent({
              type: "player_action",
              action: "load_game_rejected",
              meta: { errors: certified.errors.slice(0, 5) },
            });
          }
          break;
        }
        case "pause":
          pausedRef.current = true;
          break;
        case "resume":
          pausedRef.current = false;
          break;
        case "request_close":
          sendToParent({
            type: "session_end",
            reason: wonRef.current ? "won" : "quit",
          });
          break;
        default:
          break;
      }
    });
    sendToParent({ type: "ready", gameId: GAME_ID, version: "0.1.0" });
    dispatchInput({ type: "start" });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Local pointer fallback (standalone dev, touch devices, clinician mouse).
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      gazeRef.current = {
        x: e.clientX,
        y: e.clientY,
        at: performance.now(),
        mode: "mouse",
      };
    };
    const onDown = (e: PointerEvent) => {
      if (e.target !== canvasRef.current) return;
      if (wonRef.current || pausedRef.current || choiceRef.current) return;
      if (modeRef.current !== "walk") return;
      const cam = camRef.current;
      const session = sessionRef.current;
      if (!cam || !session) return;
      const hover = resolveHover(session, screenToWorld(cam, { x: e.clientX, y: e.clientY }));
      if (hover) {
        session.sState = setWalkTarget(
          session.layout,
          session.world,
          session.sState,
          hover.point,
          hover.intent,
        );
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown);
    };
  }, []);

  // Main loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let last = performance.now();

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;

      const session = sessionRef.current!;
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
        canvas.width = cssW * dpr;
        canvas.height = cssH * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const cam = computeCamera(cssW, cssH, session.layout, session.sState.pos);
      camRef.current = cam;

      const gazeSample = gazeRef.current;
      const gazeFresh =
        gazeSample && now - gazeSample.at < GAZE_FRESH_MS ? gazeSample : null;

      let dwellProgress = 0;
      if (!pausedRef.current && !wonRef.current) {
        const choiceOpen = choiceRef.current !== null;
        let steer: Vec2 | null = null;
        if (modeRef.current === "steer" && gazeFresh && !choiceOpen) {
          steer = screenToWorld(cam, gazeFresh);
        }
        const result = tickSpace2D(session.layout, session.sState, { steer }, dt);
        session.sState = result.state;
        for (const input of result.inputs) dispatchInput(input);

        if (modeRef.current === "walk" && gazeFresh && !choiceOpen) {
          const hover = resolveHover(session, screenToWorld(cam, gazeFresh));
          const sample = worldDwellRef.current.update(hover?.key ?? null, now);
          dwellProgress = sample.progress;
          if (sample.fired && hover) {
            session.sState = setWalkTarget(
              session.layout,
              session.world,
              session.sState,
              hover.point,
              hover.intent,
            );
          }
        }
      }

      drawFrame(ctx, cssW, cssH, cam, {
        game: session.game,
        world: session.world,
        layout: session.layout,
        sState: session.sState,
        completed: session.rState.completed,
        objectives: objectivesRef.current,
        gaze: gazeFresh ? { x: gazeFresh.x, y: gazeFresh.y } : null,
        dwellProgress,
        timeMs: now,
        won: wonRef.current,
      });
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const session = sessionRef.current;
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

      <div className="controls">
        <DwellButton
          gazeRef={gazeRef}
          dwellMs={dwellMsRef.current}
          className={`mode-btn ${mode === "walk" ? "active" : ""}`}
          ariaLabel="Walk mode (dwell to walk)"
          onActivate={() => {
            modeRef.current = "walk";
            setMode("walk");
          }}
        >
          🚶
        </DwellButton>
        <DwellButton
          gazeRef={gazeRef}
          dwellMs={dwellMsRef.current}
          className={`mode-btn ${mode === "steer" ? "active" : ""}`}
          ariaLabel="Steer mode (follow my gaze)"
          onActivate={() => {
            modeRef.current = "steer";
            setMode("steer");
          }}
        >
          🛸
        </DwellButton>
      </div>

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
