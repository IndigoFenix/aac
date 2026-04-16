/**
 * Plays a custom app (game) inside the AAC client.
 *
 * Wraps the shared GameRuntime, bridges AI instructions and salient engine
 * events into text messages sent to the live Gemini session so the AI can
 * speak about what's happening.
 *
 * Activated when `activeApp.appId === "custom_app"` and `activeApp.appData.definition`
 * contains a valid GameDefinition.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import type {
  GameDefinition,
  RoomDef,
} from "@shared/custom-app-types";
import { GameRuntime } from "@client-shared/game-runtime";
import type { EngineEvent } from "@client-shared/game-runtime";

interface CustomAppPlayerProps {
  definition: GameDefinition;
  onClose: () => void;
  /** Sends text to the live AI session. No-op if AI is not connected. */
  sendMessageToAi?: (msg: string) => void;
}

export function CustomAppPlayer({
  definition,
  onClose,
  sendMessageToAi,
}: CustomAppPlayerProps) {
  const startedAtRef = useRef(false);

  // --- On mount: seed the AI with game rules + starting room context.
  useEffect(() => {
    if (startedAtRef.current) return;
    startedAtRef.current = true;
    if (!sendMessageToAi) return;
    const startRoom = definition.rooms.find((r) => r.id === definition.startRoom);
    const intro = buildIntroMessage(definition, startRoom);
    sendMessageToAi(intro);
    return () => {
      sendMessageToAi("[GAME] The student has closed the game. Return to normal conversation.");
    };
  }, [definition, sendMessageToAi]);

  const onEvents = useCallback(
    (events: EngineEvent[]) => {
      if (!sendMessageToAi) return;
      const summary = summarizeEvents(events);
      if (summary) sendMessageToAi(`[GAME] ${summary}`);
    },
    [sendMessageToAi],
  );

  const onAiInstructions = useCallback(
    (messages: string[]) => {
      if (!sendMessageToAi) return;
      for (const m of messages) sendMessageToAi(`[GAME INSTRUCTION] ${m}`);
    },
    [sendMessageToAi],
  );

  const resolveImage = useMemo(
    () => (_ref: string) => undefined as string | undefined,
    [],
  );

  return (
    <div className="w-full h-full flex flex-col bg-slate-950 text-slate-100 overflow-auto">
      <GameRuntime
        def={definition}
        onEvents={onEvents}
        onAiInstructions={onAiInstructions}
        onExit={onClose}
        resolveImage={resolveImage}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

function buildIntroMessage(def: GameDefinition, startRoom: RoomDef | undefined): string {
  const lines: string[] = [];
  lines.push(`[GAME STARTED] The student has opened a game called "${def.label}".`);
  if (def.description) lines.push(`Description: ${def.description}`);
  if (def.aiInstructions) lines.push(`How you should behave during this game: ${def.aiInstructions}`);
  if (startRoom) {
    lines.push(`Starting room: ${startRoom.label ?? startRoom.id}.`);
    if (startRoom.aiInstructions) {
      lines.push(`Room-specific guidance: ${startRoom.aiInstructions}`);
    }
  }
  lines.push(
    "You will receive short [GAME] updates as the student plays (moves, clicks, state changes). Narrate, encourage, or guide as appropriate.",
  );
  return lines.join("\n");
}

function summarizeEvents(events: EngineEvent[]): string | null {
  const parts: string[] = [];
  for (const e of events) {
    switch (e.type) {
      case "entityMoved":
        parts.push(`moved ${e.uid} to (${e.to[0]},${e.to[1]})`);
        break;
      case "entityDestroyed":
        parts.push(`${e.classId} was removed`);
        break;
      case "entityCreated":
        parts.push(`new ${e.classId} at (${e.position[0]},${e.position[1]})`);
        break;
      case "entityTransformed":
        parts.push(`${e.fromClass} became ${e.toClass}`);
        break;
      case "stateChanged":
        parts.push(`${e.uid} state → ${e.to}`);
        break;
      case "counterChanged":
        parts.push(`${e.counter}: ${e.from} → ${e.to}`);
        break;
      case "signalEmitted":
        parts.push(`signal "${e.id}"`);
        break;
      case "roomChanged":
        parts.push(`entered room "${e.to}"`);
        break;
      case "turnChanged":
        parts.push(`turn: ${e.to}`);
        break;
      case "aiInstruction":
      case "error":
      case "cascadeAborted":
        // Handled separately or silenced.
        break;
    }
  }
  if (parts.length === 0) return null;
  return parts.join("; ");
}
