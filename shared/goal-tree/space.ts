// shared/goal-tree/space.ts
//
// The boundary between the space-agnostic quest runtime and any space
// implementation (Space2D now, Space3D on the planetary model later).
// A space implementation:
//   - feeds SpaceInput to the runtime (what the player did, spatially),
//   - applies SpaceCommand from the runtime (what the world should show),
// and never decides game logic itself. RuntimeEvent is the observer stream —
// narration, progress, AI-companion notes — consumed by the client HUD and
// forwarded over the games bridge to the live AI.
//
// Everything here is JSON-serializable so the runtime can live on either
// side of a transport without change.

import type { DemoCue, GoalNodeType } from "./types.js";

// ---------------------------------------------------------------------------
// Space → runtime
// ---------------------------------------------------------------------------

export type SpaceInput =
  /** Begin the session: emits the root intro narration + objectives. */
  | { type: "start" }
  /** Player touched/approached a placed figure (marker, poser, obstacle). */
  | { type: "touch-figure"; nodeId: string }
  /** Player bumped or activated a passage door. */
  | { type: "touch-door"; passageId: string }
  /** Player picked up an item instance (target or distractor). */
  | { type: "pick-item"; instanceId: string; entityId: string }
  /** Player selected an option in the presented choice panel. */
  | { type: "select-option"; nodeId: string; entityId: string }
  /** Player closed the choice panel without answering (walk away & retry). */
  | { type: "cancel-choice"; nodeId: string }
  /** Player crossed into a zone (flavor/AI context only). */
  | { type: "enter-zone"; zoneId: string };

// ---------------------------------------------------------------------------
// Runtime → space
// ---------------------------------------------------------------------------

export interface ChoiceOptionView {
  entityId: string;
  // No `correct` flag here on purpose: the presenting UI must not be able
  // to leak or highlight the answer.
}

export type SpaceCommand =
  /** Show the choice panel for a choose node (dwell-select UI). */
  | {
      type: "present-choice";
      nodeId: string;
      posedByEntityId: string;
      prompt: string;
      options: ChoiceOptionView[];
    }
  /** Close the choice panel (the choose goal resolved). */
  | { type: "dismiss-choice"; nodeId: string }
  /** All guards on this passage are cleared — open it visually. */
  | { type: "unlock-passage"; passageId: string }
  /** An obstacle cleared — play its removal/transformation. */
  | { type: "clear-obstacle"; nodeId: string }
  /** Remove a collected item instance from the world (fly-to-inventory). */
  | { type: "collect-item"; instanceId: string }
  /** Play an observe beat's demonstration and label it with the glyph. The space
   *  animates the cues (scale/move/spawn/…) and shows the glyph; the cue runner
   *  is renderer-side. */
  | {
      type: "demonstrate";
      nodeId: string;
      targetGlyph: string;
      contrastGlyph?: string;
      cues: DemoCue[];
    }
  /** Big win moment. */
  | { type: "celebrate"; scope: "game" };

// ---------------------------------------------------------------------------
// Runtime → observers (HUD, games bridge, live AI)
// ---------------------------------------------------------------------------

export type NarrationKind = "intro" | "outro" | "prompt" | "feedback";

export interface ObjectiveSummary {
  nodeId: string;
  type: GoalNodeType;
  /** Where the objective is performed. */
  zoneId: string;
  /** True for an overcome whose key is not yet complete. */
  locked: boolean;
}

export type RuntimeEvent =
  | { type: "narrate"; kind: NarrationKind; text: string; nodeId?: string }
  | { type: "goal-completed"; nodeId: string; nodeType: GoalNodeType }
  | { type: "item-collected"; nodeId: string; entityId: string; have: number; need: number }
  /** A distractor was picked — gentle feedback, never failure. */
  | { type: "distractor-picked"; entityId: string }
  | { type: "wrong-choice"; nodeId: string; entityId: string; feedback?: string }
  /** Player engaged an obstacle whose key is incomplete. */
  | { type: "obstacle-locked"; nodeId: string; prompt?: string }
  | { type: "guard-cleared"; nodeId: string }
  | { type: "zone-entered"; zoneId: string; hint?: string }
  /** An observe beat's demonstration was shown — the AI companion can narrate
   *  it ("look — the ball got big!") and a report can log the taught glyph. */
  | { type: "demonstration-shown"; nodeId: string; targetGlyph: string }
  | { type: "objectives-changed"; objectives: ObjectiveSummary[] }
  | { type: "game-won" };
