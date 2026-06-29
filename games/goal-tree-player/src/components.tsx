// DOM-side UI for the goal-tree player: dwell-activatable buttons, the
// choice panel, objectives bar, narration toast, and the win overlay.
// Every interactive element is a DwellButton — usable by gaze, mouse, or
// touch with the same code path.

import {
  useEffect,
  useRef,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { DwellTracker } from "@shared/gaze-kit";
import type { EntityDef, GoalNode } from "@shared/goal-tree/types";
import type { NarrationKind, ObjectiveSummary } from "@shared/goal-tree/space";
import type { ChoiceOptionView } from "@shared/goal-tree/space";

export interface GazeSample {
  x: number;
  y: number;
  at: number;
  mode: "eyegaze" | "mouse";
}

export type GazeRef = MutableRefObject<GazeSample | null>;

const GAZE_FRESH_MS = 400;

// ---------------------------------------------------------------------------
// DwellButton
// ---------------------------------------------------------------------------

interface DwellButtonProps {
  onActivate: () => void;
  gazeRef: GazeRef;
  dwellMs: number;
  className?: string;
  ariaLabel?: string;
  children: ReactNode;
}

export function DwellButton({
  onActivate,
  gazeRef,
  dwellMs,
  className,
  ariaLabel,
  children,
}: DwellButtonProps) {
  const elRef = useRef<HTMLButtonElement>(null);
  const trackerRef = useRef<DwellTracker | null>(null);
  if (!trackerRef.current) trackerRef.current = new DwellTracker({ dwellMs });
  const activateRef = useRef(onActivate);
  activateRef.current = onActivate;

  useEffect(() => {
    trackerRef.current?.setDwellMs(dwellMs);
  }, [dwellMs]);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const el = elRef.current;
      const gaze = gazeRef.current;
      let onTarget = false;
      if (el && gaze && performance.now() - gaze.at < GAZE_FRESH_MS) {
        const r = el.getBoundingClientRect();
        onTarget =
          gaze.x >= r.left && gaze.x <= r.right && gaze.y >= r.top && gaze.y <= r.bottom;
      }
      const sample = trackerRef.current!.update(
        onTarget ? "self" : null,
        performance.now(),
      );
      el?.style.setProperty("--dwell", sample.progress.toFixed(3));
      if (sample.fired) activateRef.current();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <button
      ref={elRef}
      className={`dwell-btn ${className ?? ""}`}
      aria-label={ariaLabel}
      onClick={() => activateRef.current()}
    >
      {children}
      <span className="dwell-fill" aria-hidden="true" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Choice panel
// ---------------------------------------------------------------------------

export interface ActiveChoice {
  nodeId: string;
  posedByEntityId: string;
  prompt: string;
  options: ChoiceOptionView[];
}

interface ChoicePanelProps {
  choice: ActiveChoice;
  entities: Map<string, EntityDef>;
  gazeRef: GazeRef;
  dwellMs: number;
  onSelect: (entityId: string) => void;
  /** Close the panel without answering (walk away & retry later). */
  onClose: () => void;
}

export function ChoicePanel({
  choice,
  entities,
  gazeRef,
  dwellMs,
  onSelect,
  onClose,
}: ChoicePanelProps) {
  const poser = entities.get(choice.posedByEntityId);
  return (
    <div className="choice-overlay">
      <div className="choice-card">
        <DwellButton
          gazeRef={gazeRef}
          dwellMs={dwellMs}
          className="choice-close"
          ariaLabel="Close"
          onActivate={onClose}
        >
          ✕
        </DwellButton>
        <div className="choice-prompt">
          <span className="choice-poser">{poser?.iconRef ?? "🙂"}</span>
          {choice.prompt}
        </div>
        <div className="choice-options">
          {choice.options.map((option) => {
            const entity = entities.get(option.entityId);
            return (
              <DwellButton
                key={option.entityId}
                gazeRef={gazeRef}
                dwellMs={dwellMs}
                className="choice-option"
                ariaLabel={entity?.label ?? option.entityId}
                onActivate={() => onSelect(option.entityId)}
              >
                <span className="choice-emoji">{entity?.iconRef ?? "❔"}</span>
                <span className="choice-label">{entity?.label}</span>
              </DwellButton>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Objectives bar
// ---------------------------------------------------------------------------

interface ObjectivesBarProps {
  objectives: ObjectiveSummary[];
  nodeById: Map<string, GoalNode>;
  entities: Map<string, EntityDef>;
  collectHud: Record<string, { have: number; need: number }>;
}

export function ObjectivesBar({
  objectives,
  nodeById,
  entities,
  collectHud,
}: ObjectivesBarProps) {
  const icon = (id: string) => entities.get(id)?.iconRef ?? "❔";
  return (
    <div className="objectives-bar">
      {objectives.map((objective) => {
        const node = nodeById.get(objective.nodeId);
        if (!node) return null;
        let emoji = "❔";
        let detail: string | null = null;
        switch (node.type) {
          case "reach":
            emoji = icon(node.markerEntityId);
            break;
          case "collect": {
            emoji = icon(node.itemEntityIds[0]);
            const progress = collectHud[node.id];
            detail = `${progress?.have ?? 0}/${node.count}`;
            break;
          }
          case "choose":
            emoji = `${icon(node.posedByEntityId)}`;
            detail = "❓";
            break;
          case "overcome":
            emoji = icon(node.obstacleEntityId);
            break;
          case "observe":
            emoji = icon(node.stageEntityId);
            detail = "👁";
            break;
        }
        return (
          <span
            key={objective.nodeId}
            className={`objective-chip ${objective.locked ? "locked" : ""}`}
          >
            {emoji}
            {detail && <small>{detail}</small>}
            {objective.locked && <small>🔒</small>}
          </span>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Narration toast + win overlay
// ---------------------------------------------------------------------------

export function Toast({ text, kind }: { text: string; kind: NarrationKind }) {
  return <div className={`toast toast-${kind}`}>{text}</div>;
}

interface WinOverlayProps {
  title: string;
  gazeRef: GazeRef;
  dwellMs: number;
  onReplay: () => void;
}

export function WinOverlay({ title, gazeRef, dwellMs, onReplay }: WinOverlayProps) {
  return (
    <div className="win-overlay">
      <div className="win-burst">🎉</div>
      <div className="win-title">{title}</div>
      <DwellButton
        gazeRef={gazeRef}
        dwellMs={dwellMs}
        className="win-replay"
        ariaLabel="Play again"
        onActivate={onReplay}
      >
        🔁
      </DwellButton>
    </div>
  );
}
