// games/goal-tree-player/src/GoalTreePlayer3D.tsx
//
// The goal-tree quest player rendered THROUGH the world engine in 3D. It drives
// the EXACT SAME per-frame loop as the social world — `runWorldHost` (shared/
// world-engine/world-host) — so physics, camera, gaze, and dialogue bubbles are
// one implementation whether a world is single-player or multiplayer. The quest
// is layered on via two host seams:
//   • a wall MoveConstraint (makeWallConstraint) the engine applies to movement,
//   • an onFrame hook that runs the quest's proximity detection (detectSpace3D)
//     and feeds the resulting SpaceInput to the goal-tree runtime.
// The quest furniture (rooms/figures/items/demonstrations) rides a SceneOverlay
// on the 3D view. To go multiplayer later, this same host takes an optional `net`.
//
// Mounted via main.tsx when the URL carries ?render=3d.

import { useEffect, useRef, useState } from "react";
import { onPlatformMessage, sendToParent } from "@shared/games-bridge";
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
import {
  applySpace3DCommand,
  buildTransportObjects,
  createSpace3DState,
  detectSpace3D,
  embedLayoutInWorld,
  makeWallConstraint,
  PLAYER_ID,
  type Space3DState,
  type TransportPlacement,
  type WorldEmbedding,
} from "@shared/goal-tree/space3d";
import { createWorld3DView } from "@shared/world-engine/render3d";
import { createGlyphImageSource } from "@shared/world-engine/glyph-images";
import { createDwellTracker, type DwellTracker } from "@shared/world-engine/dwell";
import { playerImageResolver } from "./glyph-resolver";
import { runWorldHost, type WorldHost } from "@shared/world-engine/world-host";
import { clearWorldBubble, dropObject, showWorldBubble } from "@shared/world-engine/engine";
import { createNpcVoice, type NpcVoice } from "@shared/world-engine/npc-voice";
import { resolveLine, SAMPLE_NPC_DIALOGUE } from "@shared/world-engine/npc-dialogue";
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
const TOAST_MS = 3500;
// Conversation (dwell-to-talk) tuning.
const CONVO_RADIUS = 7;       // approach distance that raises an NPC's greeting bubble
const CONVO_FIG_RADIUS = 2.2; // gaze within this of a poser counts as "on" them
const CONVO_START_MS = 700;   // dwell ON an NPC to begin a conversation
const CONVO_CANCEL_MS = 1000; // dwell on empty ground (away from the NPC) to leave
const DWELL_RING_R = 24;
const DWELL_RING_CIRC = 2 * Math.PI * DWELL_RING_R;

// Embedded in the AAC (an iframe) → the live AI companion narrates via the
// server TTS, so the game stays silent to avoid double audio. Standalone (the
// free single-player path, incl. the Electron app) → characters speak themselves
// via the browser's speechSynthesis (no server TTS cost).
const EMBEDDED = typeof window !== "undefined" && window.self !== window.top;

interface Session {
  game: GoalTreeGame;
  world: LogicalWorld;
  ctx: RuntimeContext;
  embedding: WorldEmbedding;
  entities: Map<string, EntityDef>;
  rState: RuntimeState;
  sState: Space3DState;
  /** "move A→B" puzzles: carry object + destination, watched for completion. */
  transports: TransportPlacement[];
}

function makeSession(game: GoalTreeGame): Session {
  const certified = certifyGoalTreeGame(game);
  if (!certified.ok) {
    console.error("goal-tree-player-3d: game failed certification", certified.errors);
  }
  const world = certified.ok ? certified.world : buildLogicalWorld(game);
  const layout = certified.ok ? certified.layout : projectLayout2D(game, world);
  const embedding = embedLayoutInWorld(layout);
  // Materialize any transport puzzles' carry object + container as real world
  // objects in the embedded spec, so the engine moves/renders them.
  const transport = buildTransportObjects(game, world, embedding.layout);
  embedding.spec.objects = transport.objects;
  return {
    game,
    world,
    ctx: createRuntimeContext(game, world),
    embedding,
    entities: new Map(game.entities.map((e) => [e.id, e])),
    rState: createRuntimeState(),
    sState: createSpace3DState(world),
    transports: transport.placements,
  };
}

export default function GoalTreePlayer3D() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<Session | null>(null);
  if (!sessionRef.current) sessionRef.current = makeSession(demoGame());
  const hostRef = useRef<WorldHost | null>(null);
  const overlayRef = useRef<GoalTreeOverlay3D | null>(null);
  // Free client-side TTS for in-game characters (standalone only — see EMBEDDED).
  const voiceRef = useRef<NpcVoice | null>(null);

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
  const dwellMsRef = useRef(DEFAULT_DWELL_MS);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pointer: the last client px (persistent — a still pointer keeps steering),
  // mirrored into the host (canvas-relative) and into gazeRef (client px, for the
  // dwell-driven HUD). The host owns the gaze-intent interpreter + camera.
  const lastClientRef = useRef<{ x: number; y: number } | null>(null);
  const pointerModeRef = useRef<"mouse" | "eyegaze">("mouse");
  const gazeRef = useRef<GazeSample | null>(null);
  // Lenient dwell trackers for the NPC conversation (start on the NPC / leave on
  // empty ground). Same eyegaze-tolerant timer as carry.
  const talkDwell = useRef<DwellTracker>(createDwellTracker({ dwellMs: CONVO_START_MS, tolerance: CONVO_FIG_RADIUS, graceMs: 450 }));
  const leaveDwell = useRef<DwellTracker>(createDwellTracker({ dwellMs: CONVO_CANCEL_MS, tolerance: 2.0, graceMs: 450 }));
  // Dwell-timer indicator (a ring at the cursor that fills as a dwell accumulates).
  const dwellRingRef = useRef<SVGSVGElement>(null);
  const dwellArcRef = useRef<SVGCircleElement>(null);
  const convoProgressRef = useRef(0);

  const steering = () => !pausedRef.current && !wonRef.current && choiceRef.current === null;
  // The pointer/gaze stays LIVE during a choice (so dwell-to-cancel works); the
  // avatar is frozen separately by the host (carry / setConversation → aim null).
  const pointerLive = () => !pausedRef.current && !wonRef.current;

  /** Push the current pointer into the host (or clear it when paused/won). */
  function feedPointer() {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const p = lastClientRef.current;
    if (p && pointerLive()) {
      const r = canvas.getBoundingClientRect();
      host.setPointer(p.x - r.left, p.y - r.top);
    } else {
      host.clearPointer();
    }
  }

  function showToast(text: string, kind: NarrationKind) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToastState({ text, kind });
    toastTimer.current = setTimeout(() => setToastState(null), TOAST_MS);
  }

  /** Speak a character's line aloud (free TTS) in the game's language — silent
   *  when embedded (the AAC AI narrates) or when no system voice is available. */
  function speakNpc(text: string) {
    if (EMBEDDED || !text) return;
    voiceRef.current?.speak(text, { lang: sessionRef.current?.game.meta.locale });
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
        case "present-choice": {
          choiceRef.current = command;
          // The avatar is frozen + the camera faces the poser via setConversation
          // (set by the dwell-to-talk trigger in onFrame); the pointer stays live.
          // The poser asks its question aloud, in a bubble over the character.
          const host = hostRef.current;
          const fig = session.embedding.layout.figures.find((f) => f.nodeId === command.nodeId);
          if (host && fig) {
            showWorldBubble(host.state, `char:${command.posedByEntityId}`, {
              anchor: { kind: "point", x: fig.pos.x, y: fig.pos.y },
              text: command.prompt,
              glyph: command.prompt, // render the composed glyph image (not just text)
              ttl: 6,
            });
          }
          speakNpc(command.prompt);
          // Embedded → answer on the REAL response board (teaches its use): lock
          // its side buttons to the options. Standalone → the in-game panel.
          if (EMBEDDED) {
            sendToParent({
              type: "set_board_options",
              prompt: command.prompt,
              options: command.options.map((o) => {
                const e = session.entities.get(o.entityId);
                // Send the entity's COMPOSED glyph so the board button renders the
                // real symbol the student is learning (fall back to the emoji).
                return { id: o.entityId, label: e?.label ?? o.entityId, glyph: e?.glyph ?? e?.iconRef };
              }),
            });
          } else {
            setChoice(command);
          }
          break;
        }
        case "dismiss-choice":
          choiceRef.current = null;
          setChoice(null);
          if (EMBEDDED) sendToParent({ type: "clear_board_options" });
          // Leave the conversation: release the camera + resume steering.
          hostRef.current?.setConversation(null);
          talkDwell.current.reset();
          leaveDwell.current.reset();
          feedPointer();
          break;
        case "demonstrate": {
          // Animate the cue props in-world (overlay), and caption the moment with
          // the taught glyph as a real world speech bubble over the stage — the
          // SAME bubble path a character or a remote player would use.
          overlayRef.current?.playDemonstration(command);
          const host = hostRef.current;
          const stage = session.embedding.layout.figures.find((f) => f.nodeId === command.nodeId);
          if (host && stage) {
            const caption = command.contrastGlyph
              ? `${command.targetGlyph}  ↔  ${command.contrastGlyph}`
              : command.targetGlyph;
            showWorldBubble(host.state, "demo:caption", {
              anchor: { kind: "point", x: stage.pos.x, y: stage.pos.y },
              text: caption,
              glyph: command.targetGlyph,
              ttl: 5,
            });
          }
          // Say the taught word aloud — reinforces glyph ↔ word ↔ what was shown.
          speakNpc(command.targetGlyph);
          break;
        }
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
        case "game-won": {
          wonRef.current = true;
          setWon(true);
          feedPointer();
          sendToParent({ type: "player_action", action: "game_won" });
          // The companion celebrates with a canned, language-keyed line over the
          // player — the same bubble + voice path a character uses.
          const host = hostRef.current;
          const line = resolveLine(SAMPLE_NPC_DIALOGUE, "celebrate", session.game.meta.locale);
          if (host && line) {
            showWorldBubble(host.state, "companion", {
              anchor: { kind: "avatar", id: PLAYER_ID },
              text: line.text,
              glyph: line.glyph,
              ttl: 5,
            });
            speakNpc(line.text);
          }
          break;
        }
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
        case "demonstration-shown":
          sendToParent({
            type: "player_action",
            action: "demonstration_shown",
            meta: { nodeId: event.nodeId, targetGlyph: event.targetGlyph },
          });
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

  /** (Re)build the world host for a session: 3D view + quest overlay + the wall
   *  constraint + the per-frame quest detection. Same loop as the social world. */
  function buildHost(session: Session) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    hostRef.current?.stop(); // also disposes the previous view
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
    overlayRef.current = overlay;
    // Render composed glyphs in in-world speech bubbles EXACTLY as the response
    // board renders them — same GlyphCompositor + same bundled-icon resolver.
    const glyphSource = createGlyphImageSource({ resolveImage: playerImageResolver });
    const view = createWorld3DView(
      {
        canvas,
        localId: PLAYER_ID,
        faceFor: () => null,
        labelFor: (id) => (id === PLAYER_ID ? "You" : ""),
        glyphFor: glyphSource.glyphFor,
      },
      session.embedding.spec,
      { overlay },
    );
    const host = runWorldHost({
      view,
      spec: session.embedding.spec,
      localId: PLAYER_ID,
      spawnIndex: 0,
      constraint: makeWallConstraint(session.embedding.layout, session.sState),
      // Carry the "move A→B" puzzle objects: dwell to pick up; dwell on a spot to
      // put them down (onto the destination container). No-op when no carryables.
      carry: {},
      onFrame: (state, dt) => {
        // Keep the dwell-driven HUD buttons live on a still pointer.
        const p = lastClientRef.current;
        if (p) gazeRef.current = { x: p.x, y: p.y, at: performance.now(), mode: pointerModeRef.current };
        // Transport puzzles complete when the TARGET lands on its destination.
        // A wrong carryable (selection beat) is gently DECLINED — ejected so it
        // can be carried again — never a fail state.
        for (const t of session.transports) {
          if (session.rState.completed[t.nodeId]) continue;
          // A selection beat: the recipient "asks" for the wanted item via a glyph
          // bubble over it (so it never has to wear the item's icon).
          if (t.wantGlyph) {
            const dn = state.objects[t.destId];
            if (dn) {
              showWorldBubble(state, `want:${t.nodeId}`, {
                anchor: { kind: "point", x: dn.x, y: dn.y },
                text: "",
                glyph: t.wantGlyph,
                ttl: 1.5,
              });
            }
          }
          const held = state.objects[t.objectId]?.containedIn;
          if (held?.objectId === t.destId && (!t.relation || held.relation === t.relation)) {
            dispatchInput({ type: "place-object", nodeId: t.nodeId });
            continue;
          }
          for (const did of t.distractorObjectIds) {
            if (state.objects[did]?.containedIn?.objectId === t.destId) {
              const dest = state.objects[t.destId];
              if (dest) dropObject(state, did, dest.x + 1.8, dest.y - 1.4);
              showToast("Not that one — bring the matching one!", "feedback");
            }
          }
        }
        // ── NPC conversation: approach bubble → dwell-to-talk → camera-face → cancel.
        const cvHost = hostRef.current;
        const meAv = state.avatars[PLAYER_ID];
        let convoProgress = 0;
        if (cvHost && meAv) {
          const gz = cvHost.getGaze();
          const fix = gz.committedWorld;
          const onFig = (px: number, py: number, r: number) =>
            !!fix && Math.hypot(fix.x - px, fix.y - py) <= r;
          const active = choiceRef.current;
          if (active) {
            // Talking: hold the camera on the poser; dwell on empty ground to leave.
            talkDwell.current.reset();
            const fig = session.embedding.layout.figures.find((f) => f.nodeId === active.nodeId);
            if (fig) {
              cvHost.setConversation({ x: fig.pos.x, y: fig.pos.y });
              // The leave target is the fixation when it's NOT resting on the poser.
              const g = fix && !onFig(fig.pos.x, fig.pos.y, CONVO_FIG_RADIUS) ? { x: fix.x, y: fix.y } : null;
              const res = leaveDwell.current.step(g, dt * 1000);
              convoProgress = res.progress;
              if (res.fired) dispatchInput({ type: "cancel-choice", nodeId: active.nodeId });
            }
          } else {
            // Find the nearest incomplete choose poser within conversation range.
            let nearFig: { nodeId: string; pos: { x: number; y: number } } | null = null;
            let nearD = Infinity;
            for (const f of session.embedding.layout.figures) {
              if (session.ctx.nodeById.get(f.nodeId)?.type !== "choose" || session.rState.completed[f.nodeId]) continue;
              const d = Math.hypot(meAv.x - f.pos.x, meAv.y - f.pos.y);
              if (d <= CONVO_RADIUS && d < nearD) { nearD = d; nearFig = f; }
            }
            if (nearFig) {
              const node = session.ctx.nodeById.get(nearFig.nodeId);
              // Approach bubble (refreshed while in range).
              showWorldBubble(cvHost.state, `npc-greet:${nearFig.nodeId}`, {
                anchor: { kind: "point", x: nearFig.pos.x, y: nearFig.pos.y },
                text: node?.type === "choose" ? node.prompt : "",
                glyph: node?.type === "choose" ? node.prompt : undefined,
                ttl: 1.5,
              });
              // Dwell ON the poser → present the choice + face the camera.
              leaveDwell.current.reset();
              const onN = onFig(nearFig.pos.x, nearFig.pos.y, CONVO_FIG_RADIUS);
              const res = talkDwell.current.step(onN ? { x: nearFig.pos.x, y: nearFig.pos.y } : null, dt * 1000);
              convoProgress = res.progress;
              if (res.fired) {
                clearWorldBubble(cvHost.state, `npc-greet:${nearFig.nodeId}`);
                cvHost.setConversation({ x: nearFig.pos.x, y: nearFig.pos.y });
                dispatchInput({ type: "touch-figure", nodeId: nearFig.nodeId });
              }
            } else {
              talkDwell.current.reset();
              leaveDwell.current.reset();
            }
          }
        }
        convoProgressRef.current = convoProgress;

        // ── Dwell-timer indicator: a ring at the cursor that fills as ANY dwell
        // (carry pick/place, or conversation start/cancel) accumulates.
        const ring = dwellRingRef.current;
        const arc = dwellArcRef.current;
        if (ring && arc && canvasRef.current) {
          const progress = Math.max(hostRef.current?.getGaze().dwellProgress ?? 0, convoProgressRef.current);
          const p = lastClientRef.current;
          if (progress > 0.02 && p) {
            const r = canvasRef.current.getBoundingClientRect();
            ring.style.opacity = "1";
            ring.style.transform = `translate(${p.x - r.left - 28}px, ${p.y - r.top - 28}px)`;
            arc.style.strokeDashoffset = String(DWELL_RING_CIRC * (1 - progress));
          } else {
            ring.style.opacity = "0";
          }
        }

        if (!steering()) return;
        const me = state.avatars[PLAYER_ID];
        if (!me) return;
        for (const input of detectSpace3D(session.embedding.layout, session.sState, { x: me.x, y: me.y }, dt)) {
          // Choose nodes begin by DWELLING on the poser (conversation), not by
          // walking into them — skip the proximity auto-trigger for them.
          if (input.type === "touch-figure" && session.ctx.nodeById.get(input.nodeId)?.type === "choose") continue;
          dispatchInput(input);
        }
      },
      scheduleFrame: (cb) => {
        const id = requestAnimationFrame(cb);
        return () => cancelAnimationFrame(id);
      },
      now: () => performance.now(),
    });
    host.resize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1);
    host.start();
    hostRef.current = host;
    dispatchInput({ type: "start" });
    feedPointer();
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
    buildHost(sessionRef.current);
  }

  function replay() {
    startSession(sessionRef.current!.game);
  }

  // Bridge wiring (gaze + load/pause/close).
  useEffect(() => {
    const unsubscribe = onPlatformMessage((msg) => {
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
              hostRef.current?.clearPointer();
            }
          } else {
            lastClientRef.current = { x: msg.x, y: msg.y };
            pointerModeRef.current = msg.mode === "eyegaze" ? "eyegaze" : "mouse";
            feedPointer();
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
          feedPointer();
          break;
        case "resume":
          pausedRef.current = false;
          feedPointer();
          break;
        case "board_option_selected":
          // The student answered the locked choose on the real AAC board.
          if (choiceRef.current) {
            dispatchInput({ type: "select-option", nodeId: choiceRef.current.nodeId, entityId: msg.id });
          }
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

  // Mouse fallback (standalone dev / clinician mouse). The pointer PERSISTS at its
  // last position — a still mouse keeps steering. Cleared only when it leaves the
  // document or the window blurs.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      lastClientRef.current = { x: e.clientX, y: e.clientY };
      pointerModeRef.current = "mouse";
      feedPointer();
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

  // Mount the host + keep it sized to the canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!EMBEDDED) voiceRef.current = createNpcVoice();
    buildHost(sessionRef.current!);
    const ro = new ResizeObserver(() => {
      hostRef.current?.resize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1);
    });
    ro.observe(canvas);
    return () => {
      ro.disconnect();
      hostRef.current?.stop();
      hostRef.current = null;
      voiceRef.current?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const session = sessionRef.current!;
  const nodeById: Map<string, GoalNode> = session.ctx.nodeById;

  return (
    <div className="player-root">
      <canvas ref={canvasRef} className="world-canvas" />

      {/* Dwell-timer ring — positioned + filled imperatively in onFrame. */}
      <svg
        ref={dwellRingRef}
        width={(DWELL_RING_R + 4) * 2}
        height={(DWELL_RING_R + 4) * 2}
        viewBox={`0 0 ${(DWELL_RING_R + 4) * 2} ${(DWELL_RING_R + 4) * 2}`}
        style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", opacity: 0, transition: "opacity 120ms linear" }}
      >
        <circle cx={DWELL_RING_R + 4} cy={DWELL_RING_R + 4} r={DWELL_RING_R} fill="none" stroke="rgba(0,0,0,0.35)" strokeWidth={5} />
        <circle
          ref={dwellArcRef}
          cx={DWELL_RING_R + 4}
          cy={DWELL_RING_R + 4}
          r={DWELL_RING_R}
          fill="none"
          stroke="#38bdf8"
          strokeWidth={5}
          strokeLinecap="round"
          strokeDasharray={DWELL_RING_CIRC}
          strokeDashoffset={DWELL_RING_CIRC}
          transform={`rotate(-90 ${DWELL_RING_R + 4} ${DWELL_RING_R + 4})`}
        />
      </svg>

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
