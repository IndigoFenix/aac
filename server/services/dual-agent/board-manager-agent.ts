// server/services/dual-agent/board-manager-agent.ts
//
// Board Manager Agent for the three-agent AAC architecture.
// See planning-docs/aac-agent-responsibility-split.md.
//
// Board Manager is HTTP-completion-based (Gemini Flash / similar fast
// model) — not Live. It is stateless across invocations: the Coordinator
// passes whatever context it needs each time. The agent's only job is to
// turn (system prompt + invocation context + tools) into a list of
// typed events the Coordinator can dispatch.
//
// Invocation triggers (decided by Coordinator, not this file):
//   - ButtonPressed
//   - SentenceComposed
//   - Transcribed (from Observer, direction != "ambient")
//   - SpeechEnd / InterpretIntent (from Speaker)
//   - ContextUpdate (relevant subset)
//   - BuilderOpened / BuilderClosed / GuessingEntered / GuessingExited
//   - MuteToggled
//   - Monitor broadcast (re-render after memory update)

import type { FunctionDeclaration } from "@google/genai";
import type { LLMProviderKey } from "@shared/llm-options";
import { getChatProvider } from "../providers/provider-factory";
import type {
  ChatProvider,
  ChatTool,
  ChatMessage as ProviderChatMessage,
  ChatCompletionResult,
} from "../providers/streaming-provider";
import type {
  AgentEvent,
  BoardManagerEvent,
  MonitorCallRequestedEvent,
  PrivateNoteEvent,
  BoardButton,
  BoardRebuiltEvent,
  BoardButtonAddedEvent,
  ContextButtonAddedEvent,
  BinaryChoiceShownEvent,
  BuilderSuggestedEvent,
  BoardNoChangeEvent,
  InterpretIntentEvent,
  GuessingExitRequestedEvent,
} from "./agent-events";
import {
  buildBoardManagerToolDeclarations,
  type BoardManagerToolConfig,
} from "./tool-declarations-board-manager";
import { parseBoardButtons, parseStructuredBoardButton } from "./interactive-agent";
import { T } from "../memory-schema/canonical-terms";
import { flowInput, flowTool, flowNote } from "./agent-flow-logger";
import {
  buildFusionMap,
  applyFusionEntry,
  type FusionEntry,
} from "./tool-fusion-normalizer";

// ---------------------------------------------------------------------------
// Structured-button input shapes — what the AI returns inside a tool call's
// JSON args. Mirrors the rebuild_board / add_context_button / show_binary_choice
// schemas in tool-declarations-board-manager.ts.
// ---------------------------------------------------------------------------

/**
 * Special button kinds — the AI declares them via `button_type` on any
 * regular button in rebuild_board / add_board_button. The system renders
 * a FIXED appearance and the model's speech/sentence/label are discarded.
 *
 * Kept as a typed string list (not a union) so adding a new kind is one
 * line here + one line in the client renderer; no follow-on union edits.
 */
const SPECIAL_BUTTON_TYPES = ["wordfinder", "more"] as const;
type SpecialButtonType = (typeof SPECIAL_BUTTON_TYPES)[number];

function extractSpecialButtonType(input: unknown): SpecialButtonType | null {
  if (!input || typeof input !== "object") return null;
  const o = input as { buttonType?: unknown; button_type?: unknown };
  // Accept either spelling — Gemini's tool-arg keys are snake_case by
  // convention, but the model occasionally emits camelCase.
  const raw = o.button_type ?? o.buttonType;
  if (typeof raw !== "string") return null;
  return (SPECIAL_BUTTON_TYPES as readonly string[]).includes(raw)
    ? (raw as SpecialButtonType)
    : null;
}

/** Build the canonical shape for a special button. Server-side fields are
 *  placeholders the client overrides at render time using i18n + fixed
 *  styling; we still set them so logs / merge-dedupe / accessibility have
 *  meaningful values. */
function buildSpecialButton(kind: SpecialButtonType): ReturnType<typeof parseBoardButtons>[number] {
  if (kind === "wordfinder") {
    return {
      label: "Find word",
      sentence: "wordfinder",
      iconRef: "fas fa-magnifying-glass",
      glyphFallback: "🔍",
      buttonType: "wordfinder" as any,
    } as ReturnType<typeof parseBoardButtons>[number];
  }
  // kind === "more"
  return {
    label: "More",
    sentence: "more",
    iconRef: "fas fa-plus",
    glyphFallback: "➕",
    buttonType: "more" as any,
  } as ReturnType<typeof parseBoardButtons>[number];
}

/**
 * Parse one structured button object from the AI's tool args.
 *
 *  - When `button_type` is set to a known special kind (wordfinder / more),
 *    short-circuit and emit the canonical fixed shape — the AI's speech /
 *    sentence / label are discarded for these meta buttons.
 *  - Otherwise route to `parseStructuredBoardButton` which reads the
 *    structured fields directly (no pipe round-trip, no comma-fragmentation
 *    risk).
 */
function parseStructuredButton(input: unknown): ReturnType<typeof parseBoardButtons>[number] | null {
  const kind = extractSpecialButtonType(input);
  if (kind) return buildSpecialButton(kind);
  return parseStructuredBoardButton(input);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Anything Board Manager can emit — its own events plus the cross-agent
 *  shared ones. The Coordinator dispatches each. */
export type BoardManagerOutputEvent =
  | BoardManagerEvent
  | MonitorCallRequestedEvent
  | PrivateNoteEvent;

/** Snapshot the Coordinator hands Board Manager per invocation. Stateless
 *  agent ⇒ everything it needs flows in here. */
export interface BoardManagerInvocationInput {
  /** Pre-built system prompt (from buildBoardManagerPrompt). The
   *  Coordinator owns prompt lifecycle and re-builds when memory changes. */
  systemPrompt: string;

  /** Tool config — drives which tools are declared (set_board only
   *  appears when availableBoards is non-empty, etc.). */
  toolConfig: BoardManagerToolConfig;

  /** The event(s) that triggered this invocation. Usually one, but
   *  debounced bursts may carry multiple ContextUpdates. */
  triggeringEvents: AgentEvent[];

  /** Recent bus events for conversation continuity. The Coordinator
   *  caps this to a sensible window (e.g. last 10–20 events). */
  recentEvents: AgentEvent[];

  /** Current button labels on the main board (for de-dup / "still
   *  appropriate?" reasoning). */
  currentBoardLabels: string[];

  /** Labels currently in the context sidebar. */
  contextSidebarLabels: string[];

  /** Identifier of a loaded custom board, if any. */
  loadedBoardId?: string | null;

  /** Optional builder state — present when a BuilderOpened was the
   *  trigger or the user is still composing. */
  builderState?: {
    category: "who" | "do" | "what" | "where" | "when";
    partialSentence: string;
    targetSlot: number;
    excludeKeys: string[];
    modeChip?: string;
    currentBoard?: string[];
    payloadTarget?: { slotIndex: number; host: string };
  };

  /** Optional guessing-mode state — present when in guessing mode. */
  guessingState?: {
    dimension: string;
    offeredKeys: string[];
    questionHint: string;
    /** AI-proposed narrowing steps the user has confirmed (parallel track). */
    customFacts: Array<{ dimension: string; value: string; sourceText?: string; addedAt: number }>;
    /** Facts the user explicitly rejected — model must not re-propose them. */
    rejectedFacts: Array<{ dimension: string; value: string; sourceText?: string; addedAt: number }>;
  };

  /** Model selection for the HTTP call. */
  provider: LLMProviderKey;
  model: string;

  /** Abort signal so the Coordinator can cancel in-flight invocations
   *  (e.g. when a newer event supersedes this one). */
  signal?: AbortSignal;
}

export interface BoardManagerInvocationResult {
  /** Parsed, typed events ready for Coordinator dispatch. */
  events: BoardManagerOutputEvent[];
  /** Raw tool calls for logging / debugging. */
  rawToolCalls: Array<{ name: string; arguments: string }>;
  usage?: { promptTokens: number; completionTokens: number };
  /** Provider finish reason (STOP, MAX_TOKENS, etc.) for diagnostics. */
  finishReason?: string;
  /** Fused tool names the model emitted that we silently rewrote.
   *  Coordinator turns these into a `<retry_feedback>` block on the
   *  NEXT invocation so the model learns the correct tool name without
   *  us telling it we patched the previous call. Empty if none. */
  fusionFeedback?: Array<{ fusedName: string; toolName: string; paramName: string }>;
}

// ---------------------------------------------------------------------------
// FunctionDeclaration → ChatTool adapter
// ---------------------------------------------------------------------------

/** Convert one Gemini-format FunctionDeclaration into the provider-agnostic
 *  ChatTool shape used by the HTTP chat providers. */
function toChatTool(decl: FunctionDeclaration): ChatTool {
  return {
    type: "function",
    function: {
      name: decl.name!,
      description: decl.description,
      parameters: (decl.parametersJsonSchema as Record<string, any>) ?? { type: "object", properties: {} },
    },
  };
}

// ---------------------------------------------------------------------------
// Invocation-context renderer
// ---------------------------------------------------------------------------

/** Render the recent events + state snapshot as a single user-role
 *  message that gives the model "what's happening right now." */
function renderInvocationContext(input: BoardManagerInvocationInput): string {
  const lines: string[] = [];

  // Current surface state
  if (input.loadedBoardId) {
    lines.push(`<current_state>`);
    lines.push(`A custom board is currently LOADED (id: ${input.loadedBoardId}). Navigate sub-pages with press_button, or call rebuild_board to unload it entirely.`);
  } else {
    lines.push(`<current_state>`);
    lines.push(`Dynamic board mode (no custom board loaded).`);
  }
  if (input.currentBoardLabels.length > 0) {
    lines.push(`Current ${T.board} buttons: [${input.currentBoardLabels.join(", ")}]`);
  } else {
    lines.push(`The ${T.board} is currently empty.`);
  }
  if (input.contextSidebarLabels.length > 0) {
    lines.push(`Context sidebar: [${input.contextSidebarLabels.join(", ")}]`);
  }
  lines.push(`</current_state>`);

  // Builder + guessing state. Guessing mode is a sub-mode of the
  // builder — when the user opens word-finder from inside the builder,
  // BOTH states are set, and the offered suggestion keys are the
  // actionable info the model needs. Render guessing_state FIRST when
  // present (it overrides builder behavior); fall through to
  // builder_state otherwise.
  if (input.guessingState) {
    lines.push("");
    lines.push(`<guessing_state>`);
    if (input.guessingState.dimension) lines.push(`dimension: ${input.guessingState.dimension}`);
    lines.push(`offered_keys: [${input.guessingState.offeredKeys.join(", ")}]`);
    lines.push(`question_hint: ${input.guessingState.questionHint}`);
    const renderFact = (f: { dimension: string; value: string; sourceText?: string }) =>
      f.sourceText ? `${f.dimension}=${f.value} ("${f.sourceText}")` : `${f.dimension}=${f.value}`;
    if (input.guessingState.customFacts.length) {
      lines.push(`custom_facts: [${input.guessingState.customFacts.map(renderFact).join(", ")}]`);
    }
    if (input.guessingState.rejectedFacts.length) {
      lines.push(`rejected_facts (NEVER re-propose): [${input.guessingState.rejectedFacts.map(renderFact).join(", ")}]`);
    }
    lines.push(`</guessing_state>`);
  }
  if (input.builderState) {
    lines.push("");
    lines.push(`<${T.tagBuilderState.replace(/[\[\]]/g, "").toLowerCase().replace(/\s+/g, "_")}>`);
    lines.push(`category: ${input.builderState.category}`);
    lines.push(`partial_sentence: ${input.builderState.partialSentence || "(empty)"}`);
    lines.push(`target_slot: ${input.builderState.targetSlot}`);
    if (input.builderState.modeChip) lines.push(`mode_chip: ${input.builderState.modeChip}`);
    if (input.builderState.payloadTarget) {
      lines.push(`payload_target: slotIndex=${input.builderState.payloadTarget.slotIndex} host=${input.builderState.payloadTarget.host}`);
    }
    if (input.builderState.currentBoard?.length) {
      lines.push(`current_board: [${input.builderState.currentBoard.join(", ")}]`);
    }
    if (input.builderState.excludeKeys.length > 0) {
      lines.push(`exclude_keys: [${input.builderState.excludeKeys.join(", ")}]`);
    }
    lines.push(`</builder_state>`);
  }

  // Recent events (for conversation continuity)
  if (input.recentEvents.length > 0) {
    lines.push("");
    lines.push(`<recent_events>`);
    for (const event of input.recentEvents) {
      const rendered = renderEventLine(event);
      if (rendered) lines.push(rendered);
    }
    lines.push(`</recent_events>`);
  }

  // What just happened (the trigger) + an action hint that nudges the
  // model toward the right tool per trigger type.
  lines.push("");
  lines.push(`<this_invocation>`);
  lines.push(`Triggered by:`);
  for (const event of input.triggeringEvents) {
    const rendered = renderEventLine(event);
    if (rendered) lines.push(`- ${rendered}`);
  }
  // Hint priority: mode-state (builder/guessing) overrides per-trigger
  // hints, because those modes constrain which tool is appropriate.
  let hint = "";
  if (input.guessingState) {
    hint = `Action: rebuild_board using the \`suggestion:dim:value\` keys from the latest [GUESSING STATE] as the ${T.button}s' \`sentence\` fields. Don't invent new suggestion keys.`;
  } else if (input.builderState) {
    hint = `Action: suggest_construction_buttons (up to 4 head_candidates; up to 4 modifier_candidates when a HEAD SYMBOL is placed). Don't touch the main ${T.board} while the ${T.builder} is open.`;
  } else {
    hint = invocationActionHint(input.triggeringEvents);
  }
  if (hint) lines.push("", hint);
  lines.push(`</this_invocation>`);

  return lines.join("\n");
}

/**
 * Per-trigger guidance for which tool the Board Manager should typically
 * reach for. Keeps the framing aligned with the legacy system's
 * board-vs-context-sidebar split (rebuild_board for conversational
 * response surfaces; add_context_button for ambient observations).
 *
 * Returns "" when the trigger mix doesn't suggest a clear default —
 * model picks from the full tool list as usual.
 */
function invocationActionHint(events: AgentEvent[]): string {
  // Categorize what the batch contains.
  let hasUserInput = false;
  let hasAiSpoke = false;
  let hasContextUpdate = false;
  let hasInterpret = false;
  for (const e of events) {
    if (e.type === "button_pressed" || e.type === "sentence_composed") hasUserInput = true;
    // speech_text_finalized is the canonical "AI spoke" trigger (full
    // transcript available, audio possibly still playing). speech_end
    // is also valid as a fallback for code paths that didn't surface
    // text_finalized.
    if (e.type === "speech_text_finalized" || e.type === "speech_end") hasAiSpoke = true;
    if (e.type === "context_update") hasContextUpdate = true;
    if (e.type === "interpret_intent") hasInterpret = true;
  }

  if (hasUserInput) {
    return `Action: rebuild_board. The USER just acted — build FOLLOW-UPS that continue or clarify their statement. Think "what might they want to say NEXT after this?" (not "how would the AI reply"). Include options to elaborate the topic, switch direction, or correct themselves.`;
  }
  if (hasInterpret) {
    return `Action: rebuild_board. The USER played a composed SENTENCE — build FOLLOW-UPS that continue or clarify the thought they just voiced.`;
  }
  if (hasAiSpoke) {
    return `Action: rebuild_board. The AI just spoke TO the user — build REPLIES the user might say back. Think "what would they say in response to this question/statement?" (not "what might they say next on their own"). If the AI asked a question, the buttons are the user's plausible answers.`;
  }
  if (hasContextUpdate) {
    return `Action: no_change. Observations don't change what the USER wants to say next — the ${T.board} stays. If the observation is genuinely worth surfacing for the user (a person they know walking in, an object they might want to react to), use add_context_button to add ONE sidebar item. Do NOT call rebuild_board.`;
  }
  return "";
}

/** One-line summary of an event for the recent-events listing. Returns
 *  empty string for events that don't need to surface to Board Manager. */
function renderEventLine(event: AgentEvent): string {
  switch (event.type) {
    case "button_pressed": {
      // A press is functionally a USER statement; render the same shape
      // as a transcript so BoardManager has one consistent mental model
      // for "who said what to whom". Default target is the device.
      const tgt = event.target ?? "AI";
      const label = tgt === "DEVICE" ? "AI" : tgt;
      return `[USER to ${label}] "${event.sentence}"`;
    }
    case "sentence_composed":
      return `[USER (composed) to AI] "${event.sentence}"`;
    case "mute_toggled":
      return `[MUTE TOGGLED] now ${event.state}`;
    case "builder_opened":
      return `[BUILDER OPENED]`;
    case "builder_closed":
      return `[BUILDER CLOSED]`;
    case "guessing_entered":
      return `[GUESSING ENTERED]`;
    case "guessing_exited":
      return `[GUESSING EXITED]`;
    case "transcribed": {
      const tgt = event.target ?? "AI";
      const label = tgt === "DEVICE" ? "AI" : tgt;
      return `[${event.speaker} to ${label}] "${event.text}"`;
    }
    case "context_update":
      return `[CONTEXT] ${event.updateType}: ${event.key} — ${event.description}${event.relevance ? ` (relevance: ${event.relevance})` : ""}`;
    case "engagement_change":
      return `[ENGAGEMENT] ${event.state}${event.reason ? ` — ${event.reason}` : ""}`;
    case "speech_text_finalized":
      // BoardManager fires on speech_text_finalized — the moment the
      // FULL transcript is available (audio may still be playing).
      return `[AI] "${event.transcript}"`;
    case "speech_start":
    case "speech_end":
      // Both are no-ops for BoardManager — speech_text_finalized is
      // the canonical trigger for AI-utterance rebuilds.
      return "";
    case "interpret_intent":
      return `[INTERPRET] (student voice) "${event.sentence}"`;
    case "mode_change":
      return `[MODE] ${event.mode}${event.reason ? ` — ${event.reason}` : ""}`;
    case "monitor_broadcast":
      return `[MONITOR CONTEXT] ${event.contextInjection}`;
    // BoardManager's OWN prior tool calls. Surfacing them in
    // <recent_events> gives the model a self-history — it sees the
    // CANONICAL tool name (rebuild_board, add_board_button, etc.) even
    // when its previous turn emitted a fused PascalCase variant
    // (RebuildBoardButtons), because parseToolCall rewrites the fused
    // call before this event is recorded. Net effect: the model's view
    // of its own past actions always uses the right tool name, which
    // anchors its next turn toward emitting the same correct name.
    case "board_rebuilt": {
      const labels = event.buttons.map((b: any) => `"${b.label}"`).join(", ");
      return `[YOU] rebuild_board(${event.buttons.length} buttons: ${labels})`;
    }
    case "board_button_added":
      return `[YOU] add_board_button("${event.button.label}")`;
    case "binary_choice_shown":
      return `[YOU] show_binary_choice("${event.option1.label}" / "${event.option2.label}")`;
    case "context_button_added":
      return `[YOU] add_context_button("${event.button.label}")`;
    case "board_no_change":
      return `[YOU] no_change${event.reason ? `(${event.reason})` : "()"}`;
    case "guessing_exit_requested":
      return `[YOU] exit_guessing(${event.reason})`;
    case "builder_suggested": {
      const heads = (event.headCandidates ?? []).length;
      const mods = (event.modifierCandidates ?? []).length;
      return `[YOU] suggest_construction_buttons(slot ${event.slotIndex}, ${heads} heads, ${mods} modifiers)`;
    }
    // The following don't help Board Manager decide:
    case "emote_change":
    case "focus_request":
    case "alarm_raised":
    case "monitor_call_requested":
    case "private_note":
      return "";
    // App / website opens — context that buttons may need to reflect
    // (an open app may want app-specific response buttons).
    case "app_open_requested":
      return `[APP OPEN] ${event.appId}${event.data ? ` (${event.data})` : ""}`;
    case "app_close_requested":
      return `[APP CLOSE]`;
    case "website_open_requested":
      return `[WEBSITE OPEN] ${event.url}${event.label ? ` (${event.label})` : ""}`;
    default: {
      const exhaustive: never = event;
      void exhaustive;
      return "";
    }
  }
}

// ---------------------------------------------------------------------------
// Tool-call → typed-event parser
// ---------------------------------------------------------------------------

/**
 * Convert a single raw tool call into the typed event the Coordinator
 * dispatches. Returns null when arguments don't parse — the caller
 * logs the failure and moves on rather than crashing the invocation.
 */
function parseToolCall(
  call: { name: string; arguments: string },
  now: number,
  fusionMap?: ReadonlyMap<string, FusionEntry>,
): BoardManagerOutputEvent | null {
  let args: Record<string, any>;
  try {
    args = call.arguments ? JSON.parse(call.arguments) : {};
  } catch (err) {
    console.warn(`[BoardManagerAgent] Failed to parse tool args for ${call.name}:`, (err as Error).message);
    return null;
  }

  // Generic fusion normalization. The model occasionally fuses a tool
  // name with one of its param names into a single PascalCase identifier
  // (rebuild_board + buttons → "RebuildBoardButtons"). The fusion map,
  // built once from the declared tool schemas, identifies these and
  // rewrites them to the real tool name with args wrapped under the
  // matched param. See buildFusionMap.
  if (fusionMap && call.name) {
    const entry = fusionMap.get(call.name);
    if (entry) {
      const rewritten = applyFusionEntry(entry, args);
      flowNote("BOARD_MGR", `Fused tool name "${call.name}" rewritten → ${entry.toolName}(${entry.paramName}=…)`);
      call = { name: entry.toolName, arguments: JSON.stringify(rewritten) };
      args = rewritten;
    }
  }

  switch (call.name) {
    case "rebuild_board": {
      // The tool schema declares this as a structured array. Parse each
      // entry through parseStructuredButton so any per-button
      // `button_type` (wordfinder / more) short-circuits to its canonical
      // shape and the rest go through the pipe parser (which handles
      // iconRef / symbolPath / imageKey derivation). Going button-by-
      // button (instead of bulk pipe-flatten) also avoids the comma-inside-
      // speech fragmentation bug.
      // Schema declares `buttons`; older models occasionally emit the
      // legacy `user_response_buttons` name — accept both.
      const arr = args.buttons ?? args.user_response_buttons ?? args[T.paramUserResponseButtons];
      const parsed: ReturnType<typeof parseBoardButtons> = Array.isArray(arr)
        ? arr.map(item => parseStructuredButton(item)).filter((b): b is NonNullable<typeof b> => !!b)
        : [];
      const buttons: BoardButton[] = parsed.map(b => ({
        label: b.label,
        sentence: b.sentence,
        speech: b.sentence,
        iconRef: b.iconRef,
        symbolPath: b.symbolPath,
        imageKey: b.imageKey,
        glyph: b.glyph,
        glyphFallback: b.glyphFallback,
        rowSpan: b.rowSpan,
        colSpan: b.colSpan,
        buttonType: b.buttonType,
        narrowDimension: b.narrowDimension,
        narrowValue: b.narrowValue,
      }));
      // Charitable downgrade — a single-button rebuild is almost certainly
      // a mistake (often the RebuildBoardButtons fusion the model keeps
      // emitting, one button at a time). Wiping the whole board to show
      // one option is rarely intended. Route to add_board_button instead
      // so the existing board is preserved and the new button slots in
      // via smartMergeButtons. Coordinator's queueBoardMgrFeedback may
      // also nudge the model toward the right tool on the next turn.
      if (buttons.length === 1) {
        flowNote("BOARD_MGR", `rebuild_board with 1 button → downgraded to add_board_button("${buttons[0].label}")`);
        const event: BoardButtonAddedEvent = {
          type: "board_button_added",
          source: "board-manager",
          timestamp: now,
          button: buttons[0],
          target: typeof args.target === "string" ? args.target : undefined,
        };
        return event;
      }
      const event: BoardRebuiltEvent = {
        type: "board_rebuilt",
        source: "board-manager",
        timestamp: now,
        buttons,
        target: typeof args.target === "string" ? args.target : undefined,
      };
      return event;
    }

    case "add_context_button": {
      // Structured object input — parse directly (no comma round-trip;
      // see parseStructuredButton for why).
      const b = parseStructuredButton(args.button);
      if (!b) return null;
      const button: BoardButton = {
        label: b.label,
        sentence: b.sentence,
        speech: b.sentence,
        iconRef: b.iconRef,
        symbolPath: b.symbolPath,
        imageKey: b.imageKey,
        glyph: b.glyph,
        glyphFallback: b.glyphFallback,
        buttonType: b.buttonType,
        narrowDimension: b.narrowDimension,
        narrowValue: b.narrowValue,
      };
      const event: ContextButtonAddedEvent = {
        type: "context_button_added",
        source: "board-manager",
        timestamp: now,
        button,
      };
      return event;
    }

    case "add_board_button": {
      // Single-button additive on the MAIN board. Coordinator runs
      // smartMergeButtons to slot it into the current board, displacing
      // similar/oldest if the board is at capacity.
      const b = parseStructuredButton(args.button);
      if (!b) return null;
      const button: BoardButton = {
        label: b.label,
        sentence: b.sentence,
        speech: b.sentence,
        iconRef: b.iconRef,
        symbolPath: b.symbolPath,
        imageKey: b.imageKey,
        glyph: b.glyph,
        glyphFallback: b.glyphFallback,
        buttonType: b.buttonType,
        narrowDimension: b.narrowDimension,
        narrowValue: b.narrowValue,
      };
      const event: BoardButtonAddedEvent = {
        type: "board_button_added",
        source: "board-manager",
        timestamp: now,
        button,
        target: typeof args.target === "string" ? args.target : undefined,
      };
      return event;
    }

    case "set_board": {
      // Board-key choice is treated as a no-change + Coordinator side
      // effect; not part of the typed event union currently. Emit a
      // BoardNoChange with the reason so the Coordinator can act on it
      // via the raw-tool-call list. (When set_board is wired end-to-end
      // we'll promote this to its own event type.)
      const reason = args.board_key ? `set_board(${args.board_key})` : "set_board";
      const event: BoardNoChangeEvent = {
        type: "board_no_change",
        source: "board-manager",
        timestamp: now,
        reason,
      };
      return event;
    }

    case "press_button": {
      const reason = args.label ? `press_button(${args.label})` : "press_button";
      const event: BoardNoChangeEvent = {
        type: "board_no_change",
        source: "board-manager",
        timestamp: now,
        reason,
      };
      return event;
    }

    case "show_binary_choice": {
      // Single-button parse for each option — avoid the comma round-trip
      // (a comma inside a speech field like "כן, אני רוצה" would
      // otherwise fragment the button and drop its glyph, leaving the
      // overlay with the default fontawesome bubble).
      const o1 = parseStructuredButton(args.option1);
      const o2 = parseStructuredButton(args.option2);
      if (!o1 || !o2) return null;
      const toEventButton = (b: NonNullable<ReturnType<typeof parseStructuredButton>>) => ({
        label: b.label,
        speech: b.sentence,
        sentence: b.sentence,
        iconRef: b.iconRef,
        symbolPath: b.symbolPath,
        imageKey: b.imageKey,
        glyph: b.glyph,
        glyphFallback: b.glyphFallback,
      });
      const event: BinaryChoiceShownEvent = {
        type: "binary_choice_shown",
        source: "board-manager",
        timestamp: now,
        option1: toEventButton(o1),
        option2: toEventButton(o2),
        target: typeof args.target === "string" ? args.target : undefined,
      };
      return event;
    }

    case "suggest_construction_buttons": {
      // `category` isn't in the tool schema and isn't used by the
      // Coordinator's applyBuilderSuggested — the client uses the
      // builder's own state for that. Default it to "what" so the event
      // type stays satisfied without dropping legitimate calls.
      const category = (args.category as BuilderSuggestedEvent["category"] | undefined) ?? "what";
      const slotIndex = typeof args.slot_index === "number" ? args.slot_index : 0;
      // SUGGESTIONs arrive as { symbol, fallback?, label } objects;
      // convert to `|symbol|fallback|label` pipe strings so the downstream
      // applyBuilderSuggested (which parseBoardButtons-parses each) keeps
      // working unchanged.
      const toSuggestionPipe = (item: unknown): string | null => {
        if (!item || typeof item !== "object") return null;
        const o = item as { symbol?: unknown; fallback?: unknown; label?: unknown };
        const symbol = typeof o.symbol === "string" ? o.symbol : "";
        const fallback = typeof o.fallback === "string" ? o.fallback : "";
        const label = typeof o.label === "string" ? o.label : "";
        if (!symbol || !label) return null;
        return `|${symbol}|${fallback}|${label}`;
      };
      const heads = Array.isArray(args.head_candidates)
        ? args.head_candidates.map(toSuggestionPipe).filter((s): s is string => !!s)
        : undefined;
      const mods = Array.isArray(args.modifier_candidates)
        ? args.modifier_candidates.map(toSuggestionPipe).filter((s): s is string => !!s)
        : undefined;
      const event: BuilderSuggestedEvent = {
        type: "builder_suggested",
        source: "board-manager",
        timestamp: now,
        category,
        slotIndex,
        headCandidates: heads,
        modifierCandidates: mods,
      };
      return event;
    }

    case "set_construction_memory_chips": {
      // No dedicated typed event yet; pass-through via BoardNoChange with
      // reason so Coordinator can mutate session state from the raw call.
      const cat = args.category ?? "?";
      const event: BoardNoChangeEvent = {
        type: "board_no_change",
        source: "board-manager",
        timestamp: now,
        reason: `set_construction_memory_chips(${cat})`,
      };
      return event;
    }

    case "no_change": {
      const event: BoardNoChangeEvent = {
        type: "board_no_change",
        source: "board-manager",
        timestamp: now,
        reason: typeof args.reason === "string" ? args.reason : undefined,
      };
      return event;
    }

    case "exit_guessing": {
      const event: GuessingExitRequestedEvent = {
        type: "guessing_exit_requested",
        source: "board-manager",
        timestamp: now,
        reason: typeof args.reason === "string" ? args.reason : "(no reason provided)",
      };
      return event;
    }

    case "interpret": {
      const sentence = typeof args.sentence === "string" ? args.sentence : "";
      if (!sentence) return null;
      const event: InterpretIntentEvent = {
        type: "interpret_intent",
        source: "board-manager",
        timestamp: now,
        sentence,
      };
      return event;
    }

    case "call_monitor": {
      const event: MonitorCallRequestedEvent = {
        type: "monitor_call_requested",
        source: "board-manager",
        timestamp: now,
        reason: typeof args.reason === "string" ? args.reason : "(no reason provided)",
      };
      return event;
    }

    case "private_note": {
      const event: PrivateNoteEvent = {
        type: "private_note",
        source: "board-manager",
        timestamp: now,
        note: typeof args.note === "string" ? args.note : "",
      };
      return event;
    }

    default:
      // Unknown tool call — log so it's visible, drop it.
      console.warn(`[BoardManagerAgent] Unknown tool call: ${call.name}`);
      return null;
  }
}

// ---------------------------------------------------------------------------
// BoardManagerAgent
// ---------------------------------------------------------------------------

/**
 * Per-session Board Manager handle. Holds the ChatProvider reference but
 * carries no per-invocation state — every `invoke()` call is independent.
 *
 * The provider lookup is done at construction so we don't pay the
 * provider-factory lookup cost per invocation. The provider/model in the
 * invocation input override the constructor defaults when present
 * (typically they won't — but the optionality keeps tests easy).
 */
export class BoardManagerAgent {
  private readonly defaultProvider: ChatProvider;

  constructor(provider: LLMProviderKey) {
    this.defaultProvider = getChatProvider(provider);
  }

  async invoke(input: BoardManagerInvocationInput): Promise<BoardManagerInvocationResult> {
    const provider = input.provider !== undefined
      ? getChatProvider(input.provider)
      : this.defaultProvider;

    // Build tool list from the per-invocation config.
    const declarations = buildBoardManagerToolDeclarations(input.toolConfig);
    const flatDecls = declarations.flatMap(t => t.functionDeclarations ?? []);
    const tools: ChatTool[] = flatDecls.map(toChatTool);
    // Pre-compute the fusion map once. Cheap (a few entries per tool) and
    // saves rebuilding per tool call below.
    const fusionMap = buildFusionMap(flatDecls);

    // Render the user-role context message.
    const contextMessage = renderInvocationContext(input);

    const messages: ProviderChatMessage[] = [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: contextMessage },
    ];

    // Flow log: what BoardManager is being asked to act on.
    const triggerSummary = input.triggeringEvents.length === 0
      ? input.builderState
        ? "builder_state_change"
        : input.guessingState
          ? "guessing_state_change"
          : "(no triggers)"
      : input.triggeringEvents.map(e => renderEventLine(e) || e.type).filter(Boolean).join(" | ");
    flowInput("BOARD_MGR", "trigger", triggerSummary);

    let result: ChatCompletionResult;
    try {
      result = await provider.completeChat({
        model: input.model,
        messages,
        tools,
        toolChoice: "auto",
        // Board Manager output is structured tool calls — temperature 0.2
        // keeps it close to deterministic without making it brittle.
        temperature: 0.2,
        // A rebuild_board call carries 6–8 button strings joined into one
        // pipe-encoded `user_response_buttons` argument; each is ~80–120
        // tokens once speech / sentence / fallback / label are populated.
        // The provider default (500) truncates mid-arg and surfaces as
        // MALFORMED_FUNCTION_CALL with no tool calls returned. 2000 leaves
        // room for the largest plausible rebuild + suggestion combo.
        maxTokens: 2000,
        signal: input.signal,
      });
    } catch (err) {
      console.error("[BoardManagerAgent] completion failed:", (err as Error).message);
      return {
        events: [],
        rawToolCalls: [],
        finishReason: "ERROR",
      };
    }

    // Parse each tool call into a typed event. Collect any fusion
    // detections so the Coordinator can issue a corrective retry turn.
    const now = Date.now();
    const events: BoardManagerOutputEvent[] = [];
    const fusionFeedback: NonNullable<BoardManagerInvocationResult["fusionFeedback"]> = [];
    for (const call of result.toolCalls) {
      flowTool("BOARD_MGR", call.name || "?", call.arguments);
      // Detect fusion BEFORE parseToolCall mutates `call.name`, so the
      // Coordinator can queue a corrective retry telling the model the
      // right tool name.
      const fusedEntry = call.name ? fusionMap.get(call.name) : undefined;
      if (fusedEntry) {
        fusionFeedback.push({
          fusedName: call.name,
          toolName: fusedEntry.toolName,
          paramName: fusedEntry.paramName,
        });
        // Fall through — DON'T suppress the call. parseToolCall handles
        // the fusion rewrite (RebuildBoardButtons → rebuild_board) and
        // the single-button downgrade (rebuild_board with one button →
        // add_board_button so the existing board isn't wiped). The
        // user's intent ("add a button" — the model emits these
        // one-per-call) gets honored AND the fusion feedback queued so
        // the model is told its tool name was wrong. Earlier suppression
        // here meant we dropped the model's intent entirely and waited
        // for a retry that never adopted the corrected name — net
        // effect: the board never updated.
      }
      const event = parseToolCall(call, now, fusionMap);
      if (event) events.push(event);
    }

    // Defensive default: if the model produced no tool calls (e.g.
    // safety block, empty response, MALFORMED_FUNCTION_CALL), treat as
    // no_change rather than leaving the surface in an ambiguous state.
    if (events.length === 0 && result.toolCalls.length === 0) {
      const reason = result.finishReason ? `no tool calls (finish: ${result.finishReason})` : "no tool calls";
      console.warn(`[BoardManagerAgent] empty response — ${reason}. usage=${JSON.stringify(result.usage)}`);
      // Surface in the flow log so silent failures are visible. Without
      // this, the Coordinator simply does nothing and the board on the
      // client stays stale — the user-visible "first home press doesn't
      // work" symptom.
      flowNote("BOARD_MGR", `Empty response: ${reason}`);
      events.push({
        type: "board_no_change",
        source: "board-manager",
        timestamp: now,
        reason,
      });
    }

    return {
      events,
      rawToolCalls: result.toolCalls,
      usage: result.usage,
      finishReason: result.finishReason,
      fusionFeedback: fusionFeedback.length > 0 ? fusionFeedback : undefined,
    };
  }
}
