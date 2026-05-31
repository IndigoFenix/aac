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
  ContextButtonAddedEvent,
  BinaryChoiceShownEvent,
  BuilderSuggestedEvent,
  BoardNoChangeEvent,
} from "./agent-events";
import {
  buildBoardManagerToolDeclarations,
  type BoardManagerToolConfig,
} from "./tool-declarations-board-manager";
import { parseBoardButtons } from "./interactive-agent";
import { T } from "../memory-schema/canonical-terms";

// ---------------------------------------------------------------------------
// Structured-button input shapes — what the AI returns inside a tool call's
// JSON args. Mirrors the rebuild_board / add_context_button / show_binary_choice
// schemas in tool-declarations-board-manager.ts.
// ---------------------------------------------------------------------------

interface StructuredButtonInput {
  speech?: unknown;
  sentence?: unknown;
  fallback?: unknown;
  label?: unknown;
  rowSpan?: unknown;
  colSpan?: unknown;
  buttonType?: unknown;
}

/**
 * Re-encode a structured-button object back into the pipe-encoded
 * `speech|sentence|fallback|label[|rowSpan|colSpan]` string parseBoardButtons
 * already knows how to parse. The pipe parser does the iconRef / symbolPath
 * / imageKey derivation and the [GUESS] prefix handling, so re-using it
 * lets the structured path share that logic without duplication.
 */
function structuredToPipeButton(input: StructuredButtonInput): string | null {
  const speech = typeof input.speech === "string" ? input.speech : "";
  const sentence = typeof input.sentence === "string" ? input.sentence : "";
  const fallback = typeof input.fallback === "string" ? input.fallback : "";
  const label = typeof input.label === "string" ? input.label : "";
  if (!label) return null; // a button without a label is unusable
  const rowSpan = typeof input.rowSpan === "number" && input.rowSpan >= 2
    ? String(input.rowSpan) : "";
  const colSpan = typeof input.colSpan === "number" && input.colSpan >= 2
    ? String(input.colSpan) : "";
  // Always emit four core pipe fields; trailing rowSpan/colSpan only when
  // present.
  let pipe = `${speech}|${sentence}|${fallback}|${label}`;
  if (rowSpan || colSpan) pipe += `|${rowSpan}|${colSpan}`;
  return pipe;
}

/** Convert an array of structured-button inputs to a comma-joined pipe
 *  string, suitable for parseBoardButtons. Filters out invalid entries. */
function structuredArrayToPipeString(inputs: unknown): string {
  if (!Array.isArray(inputs)) return "";
  return inputs
    .map(item => (item && typeof item === "object") ? structuredToPipeButton(item as StructuredButtonInput) : null)
    .filter((s): s is string => !!s)
    .join(",");
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

  // Builder / guessing mode (mutually exclusive)
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
  } else if (input.guessingState) {
    lines.push("");
    lines.push(`<guessing_state>`);
    lines.push(`dimension: ${input.guessingState.dimension}`);
    lines.push(`offered_keys: [${input.guessingState.offeredKeys.join(", ")}]`);
    lines.push(`question_hint: ${input.guessingState.questionHint}`);
    lines.push(`</guessing_state>`);
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

  // What just happened (the trigger)
  lines.push("");
  lines.push(`<this_invocation>`);
  lines.push(`Triggered by:`);
  for (const event of input.triggeringEvents) {
    const rendered = renderEventLine(event);
    if (rendered) lines.push(`- ${rendered}`);
  }
  lines.push(`Choose one or more board actions, or call no_change(reason) if the current ${T.board} is still appropriate.`);
  lines.push(`</this_invocation>`);

  return lines.join("\n");
}

/** One-line summary of an event for the recent-events listing. Returns
 *  empty string for events that don't need to surface to Board Manager. */
function renderEventLine(event: AgentEvent): string {
  switch (event.type) {
    case "button_pressed":
      return `[${T.tagPress}] (user pressed) "${event.sentence}"`;
    case "sentence_composed":
      return `[${T.tagComposed}] (user played from builder) "${event.sentence}"`;
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
    case "transcribed":
      return `[TRANSCRIPT] ${event.speaker} → ${event.direction}: "${event.text}"`;
    case "context_update":
      return `[CONTEXT] ${event.updateType}: ${event.key} — ${event.description}${event.relevance ? ` (relevance: ${event.relevance})` : ""}`;
    case "engagement_change":
      return `[ENGAGEMENT] ${event.state}${event.reason ? ` — ${event.reason}` : ""}`;
    case "speech_end":
      return `[SPEAKER] "${event.transcript}"`;
    case "interpret_intent":
      return `[INTERPRET] (student voice) "${event.sentence}"`;
    case "mode_change":
      return `[MODE] ${event.mode}${event.reason ? ` — ${event.reason}` : ""}`;
    case "monitor_broadcast":
      return `[MONITOR CONTEXT] ${event.contextInjection}`;
    // The following don't help Board Manager decide:
    case "speech_start":
    case "emote_change":
    case "focus_request":
    case "board_rebuilt":
    case "context_button_added":
    case "binary_choice_shown":
    case "builder_suggested":
    case "board_no_change":
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
): BoardManagerOutputEvent | null {
  let args: Record<string, any>;
  try {
    args = call.arguments ? JSON.parse(call.arguments) : {};
  } catch (err) {
    console.warn(`[BoardManagerAgent] Failed to parse tool args for ${call.name}:`, (err as Error).message);
    return null;
  }

  switch (call.name) {
    case "rebuild_board": {
      // The tool schema declares this as a structured array; re-encode
      // each item as a pipe string so parseBoardButtons handles the
      // iconRef / symbolPath / imageKey derivation the same way it
      // always has.
      const arr = args[T.paramUserResponseButtons] ?? args.user_response_buttons ?? args.buttons;
      const pipeStr = structuredArrayToPipeString(arr);
      const parsed = parseBoardButtons(pipeStr);
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
      }));
      const event: BoardRebuiltEvent = {
        type: "board_rebuilt",
        source: "board-manager",
        timestamp: now,
        buttons,
      };
      return event;
    }

    case "add_context_button": {
      // Structured object input — wrap in an array, re-encode, parse.
      const obj = args.button;
      if (!obj || typeof obj !== "object") return null;
      const pipeStr = structuredArrayToPipeString([obj]);
      const parsed = parseBoardButtons(pipeStr);
      if (parsed.length === 0) return null;
      const b = parsed[0];
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
      };
      const event: ContextButtonAddedEvent = {
        type: "context_button_added",
        source: "board-manager",
        timestamp: now,
        button,
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
      const opt1Raw = args.option1;
      const opt2Raw = args.option2;
      if (!opt1Raw || typeof opt1Raw !== "object") return null;
      if (!opt2Raw || typeof opt2Raw !== "object") return null;
      const p1 = parseBoardButtons(structuredArrayToPipeString([opt1Raw]));
      const p2 = parseBoardButtons(structuredArrayToPipeString([opt2Raw]));
      if (p1.length === 0 || p2.length === 0) return null;
      const toEventButton = (b: typeof p1[0]) => ({
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
        option1: toEventButton(p1[0]),
        option2: toEventButton(p2[0]),
      };
      return event;
    }

    case "suggest_construction_buttons": {
      const category = args.category as BuilderSuggestedEvent["category"] | undefined;
      if (!category) return null;
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
    const tools: ChatTool[] = declarations
      .flatMap(t => t.functionDeclarations ?? [])
      .map(toChatTool);

    // Render the user-role context message.
    const contextMessage = renderInvocationContext(input);

    const messages: ProviderChatMessage[] = [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: contextMessage },
    ];

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

    // Parse each tool call into a typed event.
    const now = Date.now();
    const events: BoardManagerOutputEvent[] = [];
    for (const call of result.toolCalls) {
      const event = parseToolCall(call, now);
      if (event) events.push(event);
    }

    // Defensive default: if the model produced no tool calls (e.g.
    // safety block, empty response, MALFORMED_FUNCTION_CALL), treat as
    // no_change rather than leaving the surface in an ambiguous state.
    if (events.length === 0 && result.toolCalls.length === 0) {
      const reason = result.finishReason ? `no tool calls (finish: ${result.finishReason})` : "no tool calls";
      console.warn(`[BoardManagerAgent] empty response — ${reason}. usage=${JSON.stringify(result.usage)}`);
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
    };
  }
}
