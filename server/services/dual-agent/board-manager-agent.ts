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

import type { FunctionDeclaration, Tool } from "@google/genai";
import type { LLMProviderKey } from "@shared/llm-options";
import type { InterlocutorRegister } from "@shared/interlocutor-register";
import { getChatProvider } from "../providers/provider-factory";
import { GeminiChatProvider } from "../providers/gemini-chat";
import type {
  ChatProvider,
  ChatTool,
  ChatMessage as ProviderChatMessage,
  ChatCompletionResult,
  ChatRequest,
} from "../providers/streaming-provider";
import type {
  AgentEvent,
  BoardManagerEvent,
  MonitorCallRequestedEvent,
  PrivateNoteEvent,
  BoardButton,
  BoardButtonOpen,
  BoardRebuiltEvent,
  BoardButtonAddedEvent,
  ContextButtonAddedEvent,
  BinaryChoiceShownEvent,
  BuilderSuggestedEvent,
  BoardNoChangeEvent,
  BoardLoadRequestedEvent,
  InterpretIntentEvent,
  GuessingExitRequestedEvent,
  AppOpenRequestedEvent,
} from "./agent-events";
import {
  buildBoardManagerToolDeclarations,
  type BoardManagerToolConfig,
  invocationActionHint,
  renderEventLine,
  renderViolationMemoryBlock,
  updateAIResponseTarget,
  buildForceRebuildHint,
  GUESSING_HINT_AFTER_AI_SPEECH,
  GUESSING_HINT_COLD,
  BUILDER_HINT,
} from "./prompts/board-manager";
import { parseBoardButtons, parseStructuredBoardButton, parseStructuredButtonsExpanding, glyphStringToJson, serializeInputGlyphs } from "./interactive-agent";
import { T } from "../memory-schema/canonical-terms";
import { MORE_OPTIONS_ICON } from "@shared/button-color";
import { flowInput, flowTool, flowNote } from "./agent-flow-logger";
import {
  buildFusionMap,
  applyFusionEntry,
  mergeFusedToolCalls,
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
  const o = input as {
    buttonType?: unknown;
    button_type?: unknown;
    kind?: unknown;
    dimension?: unknown;
    value?: unknown;
    label?: unknown;
  };
  // Accept either spelling — Gemini's tool-arg keys are snake_case by
  // convention, but the model occasionally emits camelCase.
  const raw = o.button_type ?? o.buttonType;
  if (typeof raw !== "string") return null;
  if (!(SPECIAL_BUTTON_TYPES as readonly string[]).includes(raw)) return null;
  // A stray `button_type` on a button that ALSO carries real content — a
  // word-finder kind/dimension/value or a registry `suggestion:` key — is
  // model noise, not a meta button. Honoring it would discard the actual
  // button: in guessing mode Flash stamped button_type:"wordfinder" onto
  // every narrowing button, each collapsed to a bare magnifier, and the
  // coordinator (rightly) dropped them all → an empty word-finder board.
  // Ignore the marker and let the content parse normally.
  if (typeof o.kind === "string" && o.kind.trim()) return null;
  if (typeof o.dimension === "string" && o.dimension.trim()) return null;
  if (typeof o.value === "string" && o.value.trim()) return null;
  if (typeof o.label === "string" && o.label.trim().startsWith("suggestion:")) return null;
  return raw as SpecialButtonType;
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
  // kind === "more". The RELOAD arrows, not a plus: students read "+" as "one
  // more of this" and the reload as "show me the rest of the list", which is
  // what this button actually does. Kept in step with MORE_OPTIONS_ICON, which
  // both AAC surfaces and the clinician mirror render from.
  return {
    label: "More",
    sentence: "more",
    iconRef: "fas fa-arrows-rotate",
    glyphFallback: MORE_OPTIONS_ICON,
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

/** Read the AI's conversational role for a button ("reply"|"bid"); undefined
 *  (→ defaults to "reply" downstream) for anything else. */
function extractButtonRole(input: unknown): "reply" | "bid" | undefined {
  const r = (input as { role?: unknown } | null)?.role;
  return r === "bid" || r === "reply" ? r : undefined;
}

/** Read the AI's group-chat addressee for a button (a peer name, or "ROOM").
 *  Undefined for anything non-string. Resolved to a peer session on press. */
function extractButtonAddressee(input: unknown): string | undefined {
  const a = (input as { addressee?: unknown } | null)?.addressee;
  return typeof a === "string" && a.trim() ? a.trim() : undefined;
}

/** Read the AI's launch action for a button: `{ website }`, `{ app }`,
 *  `{ board }` or `{ home }` (a URL, an app id, a pre-built board key, or a
 *  home-action id). Undefined when none is a usable string. Each target is
 *  re-gated against the permitted lists in the coordinator before it reaches
 *  the client — this only extracts the shape. Precedence when several are set:
 *  website → app → board → home. */
function extractButtonOpen(input: unknown): BoardButtonOpen | undefined {
  const o = (input as { open?: unknown } | null)?.open;
  if (!o || typeof o !== "object") return undefined;
  const website = (o as { website?: unknown }).website;
  if (typeof website === "string" && website.trim()) return { website: website.trim() };
  const app = (o as { app?: unknown }).app;
  if (typeof app === "string" && app.trim()) {
    // The query rides along ONLY with an app target — it is meaningless on the
    // others, and accepting it there would let a stray field survive into the
    // client action.
    const query = (o as { appQuery?: unknown }).appQuery;
    return {
      app: app.trim(),
      ...(typeof query === "string" && query.trim() ? { appQuery: query.trim().slice(0, 120) } : {}),
    };
  }
  const board = (o as { board?: unknown }).board;
  // Same normalization set_board applies, so the coordinator's key resolution
  // sees one shape whether the board was loaded by the AI or offered as a button.
  if (typeof board === "string" && board.trim()) return { board: board.trim().toLowerCase().replace(/ /g, "_") };
  const home = (o as { home?: unknown }).home;
  // Home-action ids are clinician-authored slugs — matched verbatim by the gate.
  if (typeof home === "string" && home.trim()) return { home: home.trim() };
  return undefined;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Anything Board Manager can emit — its own events plus the cross-agent
 *  shared ones. The Coordinator dispatches each. */
export type BoardManagerOutputEvent =
  | BoardManagerEvent
  | MonitorCallRequestedEvent
  | PrivateNoteEvent
  | AppOpenRequestedEvent;

/** Snapshot the Coordinator hands Board Manager per invocation. Stateless
 *  agent ⇒ everything it needs flows in here. */
export interface BoardManagerInvocationInput {
  /** Pre-built system prompt (from buildBoardManagerPrompt). The
   *  Coordinator owns prompt lifecycle and re-builds when memory changes.
   *  Keep this the session-stable BASE — per-turn additions go in
   *  `systemPromptSuffix` so the base stays explicit-cacheable. */
  systemPrompt: string;

  /** Per-turn system-prompt additions (builder/guessing blocks). When present
   *  the agent inlines base+suffix and skips the prompt cache for that turn. */
  systemPromptSuffix?: string;

  /**
   * Validator feedback on the buttons this agent just got rejected, so the
   * retry can correct them.
   *
   * 🚨 Rendered into the per-turn USER message, NOT the system suffix, and that
   * placement is load-bearing. The prompt cache is keyed on the system prompt,
   * so anything appended there misses the cache and re-bills the WHOLE prefix
   * at full input rate — ~13.5k tokens instead of ~800, about 17x a normal
   * turn. Retries are exactly when that is least affordable: a validator
   * rejection is already a wasted call, and paying 17x for the correction is
   * what turned a handful of bad glyphs into enough throughput to draw Vertex
   * 429s. The turn message is uncached by nature (it differs every turn), so
   * the feedback rides along for free.
   */
  retryFeedback?: string;

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
   *  appropriate?" reasoning). Legacy fallback when `currentBoardButtons`
   *  isn't supplied. */
  currentBoardLabels: string[];

  /** Full current board buttons (visual glyph STRING + speech + label), shown
   *  to the model as JSON in the SAME shape it emits — so its view of the board
   *  matches its output format. The glyph string is converted to the structured
   *  form via `glyphStringToJson`. */
  currentBoardButtons?: Array<{
    label: string;
    speech?: string;
    glyph?: string;
    glyphFallback?: string;
    buttonType?: string;
  }>;

  /** Labels currently in the context sidebar. */
  contextSidebarLabels: string[];

  /** Session-accumulated validator violations (Coordinator-owned). Rendered
   *  as a <recent_mistakes> block in the invocation context so the stateless
   *  model stops repeating rejected-button mistakes. */
  violationMemory?: Array<{ rule: string; tokens: string[] }>;

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

  /** Sampling temperature override. Defaults to 0.2 (near-deterministic,
   *  the right setting for structured-precision turns). The Coordinator
   *  raises it on home-press topic switches so repeated presses on a
   *  fresh conversation — where the input is nearly identical each time —
   *  produce a VARIED set of conversation starters instead of the same
   *  board every press. */
  temperature?: number;

  /** Register of the person the user is currently talking to (peer vs helper),
   *  resolved by the Coordinator — biases the palette per <conversation_register>.
   *  Omit / "unknown" → balanced mix. */
  interlocutorRegister?: InterlocutorRegister;

  /** Mandatory-rebuild directive — set by the Coordinator when the user
   *  pressed a home-board navigation button (INTERACT / INTERESTS /
   *  FEELINGS / etc.). When present, the action hint becomes a
   *  REQUIRED `rebuild_board` with this palette text; the usual
   *  "no_change if existing board already covers it" escape is
   *  suppressed. Without this, the model frequently `no_change`s these
   *  presses because the home board's parent already includes labels
   *  like "interests" / "feelings" that look related — but a home press
   *  is a topic-switch the user expects to refresh the surface. */
  forceRebuildDirective?: string;
}

export interface BoardManagerInvocationResult {
  /** Parsed, typed events ready for Coordinator dispatch. */
  events: BoardManagerOutputEvent[];
  /** Raw tool calls for logging / debugging. */
  rawToolCalls: Array<{ name: string; arguments: string }>;
  usage?: { promptTokens: number; completionTokens: number; cachedTokens?: number; cacheCreationTokens?: number };
  /** Provider finish reason (STOP, MAX_TOKENS, etc.) for diagnostics. */
  finishReason?: string;
  /** Fused tool names the model emitted that we silently rewrote.
   *  Coordinator feeds these back via `retryFeedback` on the NEXT
   *  invocation so the model learns the correct tool name without
   *  us telling it we patched the previous call. Empty if none. */
  fusionFeedback?: Array<{ fusedName: string; toolName: string; paramName: string }>;
}

// ---------------------------------------------------------------------------
// Shared tooling builder — used by BOTH the HTTP path (BoardManagerAgent)
// and the Live path (LiveBoardManagerAgent), so the two surfaces declare the
// exact same tools and share one fusion map. The HTTP path converts the
// Gemini declarations to ChatTool via toChatTool(); the Live path passes the
// Gemini declarations straight through to the provider.
// ---------------------------------------------------------------------------

export interface BoardManagerTooling {
  /** Gemini-format declarations — what the Live provider consumes directly. */
  declarations: Tool[];
  /** Flattened FunctionDeclarations, for the fusion map + ChatTool conversion. */
  flatDecls: FunctionDeclaration[];
  /** Fusion map (built once per tool set) for mergeFusedToolCalls/parseToolCall. */
  fusionMap: ReturnType<typeof buildFusionMap>;
}

export function buildBoardManagerTooling(config: BoardManagerToolConfig): BoardManagerTooling {
  const declarations = buildBoardManagerToolDeclarations(config);
  const flatDecls = declarations.flatMap(t => t.functionDeclarations ?? []);
  const fusionMap = buildFusionMap(flatDecls);
  return { declarations, flatDecls, fusionMap };
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
 *  message that gives the model "what's happening right now." Exported so
 *  the Live Board Manager renders the SAME context message as the HTTP path. */
export function renderInvocationContext(input: BoardManagerInvocationInput): string {
  const lines: string[] = [];

  // Who the user is talking to → shapes the palette (see <conversation_register>).
  // Omitted when unknown so the model falls back to a balanced mix.
  if (input.interlocutorRegister === "peer" || input.interlocutorRegister === "helper") {
    lines.push(`[REGISTER] ${input.interlocutorRegister}`);
  }

  // Current surface state
  if (input.loadedBoardId) {
    // The KEY and NAME live here rather than in the set_board tool description,
    // where they used to invalidate the prompt cache on every board change.
    // See buildSetBoardTool.
    const loaded = input.toolConfig.loadedBoardKey
      ? ` key="${input.toolConfig.loadedBoardKey}"${input.toolConfig.loadedBoardName ? ` (name: "${input.toolConfig.loadedBoardName}")` : ""}`
      : "";
    lines.push(`<current_state>`);
    lines.push(`A custom board is currently LOADED${loaded} (id: ${input.loadedBoardId}) — do NOT re-select it. Navigate sub-pages with press_button, or call rebuild_board to unload it entirely.`);
  } else {
    lines.push(`<current_state>`);
    lines.push(`Dynamic board mode (no custom board loaded).`);
  }
  if (input.currentBoardButtons && input.currentBoardButtons.length > 0) {
    // Show the board in the SAME JSON shape the model emits, so its view of
    // what's on screen matches its output format (avoids format confusion).
    const jsonButtons = input.currentBoardButtons.map((b) => {
      const out: Record<string, unknown> = { label: b.label };
      if (b.speech) out.speech = b.speech;
      if (b.buttonType) { out.button_type = b.buttonType; return out; }
      const { glyph, op } = glyphStringToJson(b.glyph, b.glyphFallback);
      if (glyph.length) out.glyph = glyph;
      if (op) out.op = op;
      return out;
    });
    lines.push(`Current ${T.board} — the ${T.button}s on screen now, in the SAME shape you emit:`);
    lines.push(JSON.stringify(jsonButtons));
  } else if (input.currentBoardLabels.length > 0) {
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

  // Track who's most recently addressed the AI so that
  // `speech_text_finalized` renders as `[AI to <addressee>]`, accurately
  // distinguishing "AI talking to USER" (build replies) from "AI talking
  // to Mom" (ambient exchange). State flows across both event loops.
  let aiTarget = "USER";

  // Recent events (for conversation continuity)
  if (input.recentEvents.length > 0) {
    lines.push("");
    lines.push(`<recent_events>`);
    for (const event of input.recentEvents) {
      aiTarget = updateAIResponseTarget(aiTarget, event);
      const rendered = renderEventLine(event, aiTarget);
      if (rendered) lines.push(rendered);
    }
    lines.push(`</recent_events>`);
  }

  // Session violation memory — reminds the (stateless) model which validator
  // rules it already broke this session so error rates decline over time.
  // Rides the user message, NOT the system prompt (prompt-cache safety).
  if (input.violationMemory && input.violationMemory.length > 0) {
    const block = renderViolationMemoryBlock(input.violationMemory);
    if (block) {
      lines.push("");
      lines.push(block);
    }
  }

  // What just happened (the trigger) + an action hint that nudges the
  // model toward the right tool per trigger type.
  lines.push("");
  lines.push(`<this_invocation>`);
  lines.push(`Triggered by:`);
  for (const event of input.triggeringEvents) {
    aiTarget = updateAIResponseTarget(aiTarget, event);
    const rendered = renderEventLine(event, aiTarget);
    if (rendered) lines.push(`- ${rendered}`);
  }
  // Hint priority:
  //   1. forceRebuildDirective — home-press topic switch is mandatory rebuild.
  //   2. builder / guessing state — those modes constrain the tool surface.
  //   3. Per-trigger default.
  let hint = "";
  const hasComposed = input.triggeringEvents.some(
    (e) => e.type === "sentence_composed",
  );
  if (hasComposed) {
    // A composed SENTENCE is terminal: it must be voiced via interpret(),
    // regardless of any leftover builder/guessing state. The builder closes
    // the instant Play is pressed, so builderState is often already null by
    // the time this deferred invocation runs — without this branch the hint
    // falls through to BUILDER_HINT (suggest buttons) or the per-trigger
    // rebuild_board default, and interpret() never fires.
    hint = invocationActionHint(input.triggeringEvents);
  } else if (input.forceRebuildDirective) {
    // Home-press topic switch. MUST rebuild — no_change is not an option
    // here. The directive carries the palette description; the model
    // turns that into concrete buttons. Existing-board overlap is
    // IRRELEVANT because the user just asked for a fresh surface.
    hint = buildForceRebuildHint(input.forceRebuildDirective);
  } else if (input.guessingState) {
    // When Speaker just asked a question (speech_text_finalized is the
    // trigger), the answer options should match THAT question — not the
    // engine's default offered_keys, which may belong to a different
    // dimension than what Speaker chose to ask. Without this pivot the
    // model fights itself trying to use both, and frequently MALFORMEDs.
    const hasAISpeech = input.triggeringEvents.some(
      (e) => e.type === "speech_text_finalized",
    );
    hint = hasAISpeech ? GUESSING_HINT_AFTER_AI_SPEECH : GUESSING_HINT_COLD;
  } else if (input.builderState) {
    hint = BUILDER_HINT;
  } else {
    hint = invocationActionHint(input.triggeringEvents);
  }
  if (hint) lines.push("", hint);
  lines.push(`</this_invocation>`);

  // LAST, and outside <this_invocation>: a correction outranks the beat's
  // action hint, and the model attends most to the end of the turn message.
  if (input.retryFeedback?.trim()) {
    lines.push("", `<retry_feedback>`, input.retryFeedback.trim(), `</retry_feedback>`);
  }

  return lines.join("\n");
}

// `invocationActionHint` and `renderEventLine` moved to
// `./prompts/board-manager` — see the imports at the top of this file.
// They're imported by name so the existing call sites in
// renderInvocationContext / parseToolCall continue to compile unchanged.

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
      // Special meta buttons (wordfinder / more) short-circuit to a fixed shape;
      // a `[CONTRAST:<dim>] A | B` button expands into one `narrow` pole-button
      // each ("is it closer to A or B?"); everything else parses to a single
      // button. Hence flatMap.
      const parsed: ReturnType<typeof parseBoardButtons> = Array.isArray(arr)
        ? arr.flatMap(item => {
            const kind = extractSpecialButtonType(item);
            if (kind) return [buildSpecialButton(kind)];
            // Carry the AI's conversational role + group-chat addressee onto
            // each parsed button.
            const role = extractButtonRole(item);
            const addressee = extractButtonAddressee(item);
            const open = extractButtonOpen(item);
            return parseStructuredButtonsExpanding(item).map(b => Object.assign(b, { role, addressee, open }));
          }).filter((b): b is NonNullable<typeof b> => !!b)
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
        role: (b as { role?: "reply" | "bid" }).role,
        addressee: (b as { addressee?: string }).addressee,
        open: (b as { open?: BoardButtonOpen }).open,
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
      // Experiment (glyphInputTranslation): serialize the optional
      // `input_glyphs` (array of SENTENCES) into one glyph string per sentence
      // for the header strip. The schema only exposes this param when the
      // setting is on, so args carry it solely in that case.
      const inputGlyphs = serializeInputGlyphs(args.input_glyphs);
      const event: BoardRebuiltEvent = {
        type: "board_rebuilt",
        source: "board-manager",
        timestamp: now,
        buttons,
        target: typeof args.target === "string" ? args.target : undefined,
        ...(inputGlyphs.length ? { inputGlyphs } : {}),
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
        role: extractButtonRole(args.button),
        open: extractButtonOpen(args.button),
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
      // Normalize the key the same way state.availableBoards keys are built
      // (lowercased, spaces → underscores). Coordinator looks it up there,
      // fetches the IR data, and pushes the set_board WS message to the
      // client. Missing key → no event (the model called set_board with no
      // argument, which is a malformed call rather than a load request).
      const raw = typeof args.board_key === "string" ? args.board_key : undefined;
      if (!raw) return null;
      const boardKey = raw.toLowerCase().replace(/ /g, "_");
      const event: BoardLoadRequestedEvent = {
        type: "board_load_requested",
        source: "board-manager",
        timestamp: now,
        boardKey,
      };
      return event;
    }

    case "open_app": {
      // The direct half of <apps_context> — the BM opens the app itself when
      // the user already consented. Routed through the exact same coordinator
      // path as the Speaker's open_app; the coordinator re-gates the id.
      const appId = typeof args.app_id === "string" ? args.app_id.trim() : "";
      if (!appId) return null;
      const data = typeof args.data === "string" && args.data.trim() ? args.data.trim().slice(0, 120) : undefined;
      const event: AppOpenRequestedEvent = {
        type: "app_open_requested",
        source: "board-manager",
        timestamp: now,
        appId,
        ...(data ? { data } : {}),
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
      // `open` is read off the RAW arg, not the parsed button: parseStructuredButton
      // only understands the visual/speech fields, so a launch target would be
      // silently dropped here — which is exactly how a yes-option ended up
      // agreeing to open something and then opening nothing.
      const toEventButton = (
        b: NonNullable<ReturnType<typeof parseStructuredButton>>,
        raw: unknown,
      ) => {
        const open = extractButtonOpen(raw);
        return {
          label: b.label,
          speech: b.sentence,
          sentence: b.sentence,
          iconRef: b.iconRef,
          symbolPath: b.symbolPath,
          imageKey: b.imageKey,
          glyph: b.glyph,
          glyphFallback: b.glyphFallback,
          ...(open ? { open } : {}),
        };
      };
      // Experiment (glyphInputTranslation): serialize the optional
      // `input_glyphs` (array of SENTENCES) into one glyph string per sentence
      // for display above the two overlay buttons. Same handling as
      // rebuild_board — the schema only exposes this param when the setting is on.
      const inputGlyphs = serializeInputGlyphs(args.input_glyphs);
      const event: BinaryChoiceShownEvent = {
        type: "binary_choice_shown",
        source: "board-manager",
        timestamp: now,
        option1: toEventButton(o1, args.option1),
        option2: toEventButton(o2, args.option2),
        target: typeof args.target === "string" ? args.target : undefined,
        ...(inputGlyphs.length ? { inputGlyphs } : {}),
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

    case "private_thought":
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

// Default backend — hardcoded to a fast model for the MVP (move to a
// per-agent settings row in a follow-up). Lives here rather than in the
// Coordinator so prewarm's prompt-cache key uses the same model string
// the invocations bill against.
export const BOARD_MANAGER_DEFAULT_PROVIDER = "gemini" as const;
export const BOARD_MANAGER_DEFAULT_MODEL = "gemini-2.5-flash";

/**
 * A provider throw, classified.
 *
 * RATE_LIMITED is split out from ERROR because the caller's response to the two
 * must differ. An empty or malformed model response is worth retrying at once —
 * the model simply fumbled, and a second attempt usually lands. A 429 is not a
 * fumble: the API refused, and no amount of asking again changes that. The
 * retry we used to fire immediately just doubled the request rate against a
 * quota that was already gone (2026-08-20 — the AI Studio key's daily cap took
 * every board rebuild down; see providers/vertex-config.ts).
 *
 * The message also goes to the FLOW log. It used to reach only the server
 * console, so agent-flow-debug.log showed a bare "finish: ERROR" with no cause
 * and the actual reason was invisible to anyone reading the log afterwards.
 */
/**
 * Is this provider failure a refusal (rate limit / quota) or a fumble?
 *
 * Exported pure so the distinction is testable — getting it wrong in either
 * direction is costly: a missed rate limit resumes the retry storm, and a false
 * positive silently disables a retry that would have recovered the board.
 * `quota` is word-bounded so "bad quotation marks" is not a rate limit.
 */
export function classifyProviderFailure(message: string): "RATE_LIMITED" | "ERROR" {
  return /RESOURCE_EXHAUSTED|\b429\b|rate.?limit|\bquotas?\b/i.test(message)
    ? "RATE_LIMITED"
    : "ERROR";
}

/** How many times a rate-limited call is retried before giving up. */
export const RATE_LIMIT_RETRIES = 2;
/**
 * First backoff step. Doubles each attempt, with jitter on top.
 *
 * 🚨 Scale this against the CALL, not against intuition. At the original 400ms
 * the two retries waited an average of 200ms then 400ms — while each Vertex
 * round-trip to a tight pool was taking ~6s to come back 429. The backoff was
 * rounding error on the request it was supposed to be spacing out, so all three
 * attempts landed inside the same congestion window and the "retry with
 * backoff" was retry-without-backoff in everything but name.
 *
 * Kept modest even so, because a child is watching a loading bar for the whole
 * chain. The in-call retries are the CHEAP recovery; the real one is the
 * Coordinator's delayed background rebuild, which costs the child no wait at
 * all because the existing board stays up while it runs.
 */
export const RATE_LIMIT_BASE_DELAY_MS = 1_500;

/**
 * Backoff for attempt `n` (0-based): exponential, with FULL jitter.
 *
 * 🚨 We used not to retry a 429 at all, and that was right for the failure we
 * had then — the AI Studio key's DAILY cap (2026-08-20), where the quota was
 * gone for the rest of the day and an immediate retry only doubled the load
 * against it.
 *
 * Vertex is a different animal. Gemini there runs on dynamic shared quota:
 * there is no per-project ceiling to exhaust, and a 429 means the shared pool
 * was momentarily tight. Capacity changes second to second, so retry with
 * backoff is Google's own first recommendation. Same status code, opposite
 * correct response — which is why the DELAY carries the weight: an immediate
 * retry is the one thing that is wrong under both regimes.
 *
 * Full jitter (random across the whole window rather than a fixed delay plus
 * noise) because every session hitting a tight pool would otherwise retry in
 * lockstep and rebuild the spike it is backing off from.
 */
export function rateLimitBackoffMs(attempt: number, random: () => number = Math.random): number {
  return Math.round(random() * RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt));
}

function failureResult(err: Error, where?: string): BoardManagerInvocationResult {
  const msg = err.message ?? String(err);
  const rateLimited = classifyProviderFailure(msg) === "RATE_LIMITED";
  flowNote(
    "BOARD_MGR",
    `completion failed${where ? ` (${where})` : ""}${rateLimited ? " — RATE LIMITED, backing off" : ""}: ${msg}`,
  );
  return { events: [], rawToolCalls: [], finishReason: rateLimited ? "RATE_LIMITED" : "ERROR" };
}

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
  /** Model used for the prompt-cache prewarm key. Kept in sync with the
   *  model the Coordinator passes on each `invoke()` (input.model) so the
   *  warmed cache actually hits. Defaults to BOARD_MANAGER_DEFAULT_MODEL. */
  private readonly defaultModel: string;
  /** Tokens billed by prompt-cache CREATE calls (prewarm or in-invoke) not
   *  yet folded into a turn's usage. Added to the next invocation's
   *  promptTokens so the ledger bills cache writes at the normal input rate. */
  private pendingCacheCreateTokens = 0;

  /** The session's Vertex signal, kept so a per-invocation provider override
   *  authenticates the same way the constructor default does. */
  private readonly useVertex: boolean;

  /**
   * @param useVertex bill through the paid GCP project rather than the AI
   *   Studio key. THE SAME signal the live agents get (AgentCoordinator
   *   .useVertex). Before this existed the Board Manager was the one agent
   *   still on the free key, and its daily cap took board rebuilds down while
   *   the Speaker carried on — see providers/vertex-config.ts.
   */
  constructor(
    provider: LLMProviderKey,
    defaultModel: string = BOARD_MANAGER_DEFAULT_MODEL,
    useVertex = false,
  ) {
    this.useVertex = useVertex;
    this.defaultProvider = getChatProvider(provider, { useVertex });
    this.defaultModel = defaultModel;
  }

  /** Create the explicit prompt cache ahead of the first invocation so the
   *  first board build starts from a warm prefix. Fire-and-forget. */
  prewarm(systemPrompt: string, toolConfig: BoardManagerToolConfig): void {
    if (!(this.defaultProvider instanceof GeminiChatProvider)) return;
    const geminiProvider = this.defaultProvider;
    const { flatDecls } = buildBoardManagerTooling(toolConfig);
    const tools: ChatTool[] = flatDecls.map(toChatTool);
    void geminiProvider
      .ensurePromptCache({
        model: this.defaultModel,
        systemPrompt,
        tools,
        toolChoice: "required",
        displayName: "aac-board-manager",
      })
      .then((handle) => {
        if (handle) this.pendingCacheCreateTokens += handle.createdTokens;
      })
      .catch(() => { /* lazily retried on first invoke */ });
  }

  /**
   * Run a completion, retrying ONLY on a rate limit, with jittered backoff.
   *
   * Anything else rethrows immediately: a malformed response is the caller's to
   * handle (it retries with feedback, which a plain re-send would not fix), and
   * an abort must stay an abort.
   */
  private async completeWithRateLimitRetry(
    provider: ChatProvider,
    request: ChatRequest,
    signal?: AbortSignal,
  ): Promise<ChatCompletionResult> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt++) {
      try {
        return await provider.completeChat(request);
      } catch (err) {
        lastErr = err;
        const message = (err as Error).message;
        if (classifyProviderFailure(message) !== "RATE_LIMITED") throw err;
        if (signal?.aborted || attempt === RATE_LIMIT_RETRIES) throw err;
        const delay = rateLimitBackoffMs(attempt);
        flowNote("BOARD_MGR", `Rate limited — retrying in ${delay}ms (attempt ${attempt + 1}/${RATE_LIMIT_RETRIES}).`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        // The board is only worth building if anyone is still waiting for it.
        if (signal?.aborted) throw lastErr;
      }
    }
    throw lastErr;
  }

  async invoke(input: BoardManagerInvocationInput): Promise<BoardManagerInvocationResult> {
    const provider = input.provider !== undefined
      ? getChatProvider(input.provider, { useVertex: this.useVertex })
      : this.defaultProvider;

    // Build tool list from the per-invocation config.
    const { flatDecls, fusionMap } = buildBoardManagerTooling(input.toolConfig);
    const tools: ChatTool[] = flatDecls.map(toChatTool);

    // Render the user-role context message.
    const contextMessage = renderInvocationContext(input);

    // Explicit prompt cache: the session-stable base prompt + tools are
    // pinned server-side and re-billed at the cached-input rate (0.25x).
    // Suffix turns (builder/guessing/retry feedback) alter the system
    // prompt, so they inline the full prompt and skip the cache — identical
    // to pre-cache behavior.
    const suffix = input.systemPromptSuffix?.trim();
    const fullSystemPrompt = suffix
      ? `${input.systemPrompt}\n\n${suffix}`
      : input.systemPrompt;
    let cachedContent: string | undefined;
    if (!suffix && provider instanceof GeminiChatProvider) {
      const handle = await provider.ensurePromptCache({
        model: input.model,
        systemPrompt: input.systemPrompt,
        tools,
        toolChoice: "required",
        displayName: "aac-board-manager",
      });
      if (handle) {
        cachedContent = handle.name;
        this.pendingCacheCreateTokens += handle.createdTokens;
        // A CREATE is a whole prompt billed at the full input rate, so it is
        // the single biggest thing that moves a turn's token count. It used to
        // reach only the server console, which is why three cache re-creations
        // in one session looked like an unexplained "prompt spike" in
        // agent-flow-debug.log. If a session shows repeated creations, the tool
        // declarations are varying — see buildSetBoardTool.
        if (handle.createdTokens > 0) {
          flowNote("BOARD_MGR", `Prompt cache CREATED (${handle.createdTokens} tokens billed as input this turn).`);
        }
      }
    }

    const messages: ProviderChatMessage[] = cachedContent
      ? [{ role: "user", content: contextMessage }]
      : [
          { role: "system", content: fullSystemPrompt },
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

    const baseRequest: Omit<ChatRequest, "messages" | "tools" | "toolChoice" | "cachedContent"> = {
      model: input.model,
      // Board Manager output is structured tool calls — temperature 0.2
      // keeps it close to deterministic without making it brittle. The
      // Coordinator raises it for home-press topic switches so repeated
      // presses yield varied conversation starters (see `temperature` on
      // BoardManagerInvocationInput).
      temperature: input.temperature ?? 0.2,
      // A rebuild_board call carries 6–8 button strings joined into one
      // pipe-encoded `user_response_buttons` argument; each is ~80–120
      // tokens once speech / sentence / fallback / label are populated.
      // Truncating mid-arg surfaces as MALFORMED_FUNCTION_CALL with no
      // tool calls returned — and on Gemini 2.5 THINKING tokens count
      // against this cap too. Unbounded dynamic thinking was measured at
      // ~1.0-1.2k tokens per call, leaving the 2000 cap a coin flip
      // (~40% MALFORMED in session 4841ed41). Bound the thinking and
      // keep the cap generous so the call JSON always has room.
      maxTokens: 3500,
      thinkingBudget: 512,
      signal: input.signal,
    };
    // "required" → Gemini functionCallingConfig.mode = "ANY". Forces
    // the model to emit a tool call every turn. Without this, AUTO
    // mode lets the model elect plain text on ambiguous beats
    // (responding to AI speech, no-trigger retries, etc.) and the
    // result lands as "no tool calls / MALFORMED_FUNCTION_CALL".
    // BoardManager has NO_CHANGE as a universal fallback in its tool
    // list, so "required" never traps the model — there's always a
    // valid call. When a prompt cache is in play, tools + the forced-call
    // config live in the cache and MUST be omitted from the request.
    const cachedRequest: ChatRequest = { ...baseRequest, messages, cachedContent };
    const inlineRequest: ChatRequest = {
      ...baseRequest,
      messages: [
        { role: "system", content: fullSystemPrompt },
        { role: "user", content: contextMessage },
      ],
      tools,
      toolChoice: "required",
    };

    const request = cachedContent ? cachedRequest : inlineRequest;
    let result: ChatCompletionResult;
    try {
      result = await this.completeWithRateLimitRetry(provider, request, input.signal);
    } catch (err) {
      const message = (err as Error).message;
      // 🚨 A RATE LIMIT SAYS NOTHING ABOUT THE CACHE HANDLE.
      //
      // This used to drop the prompt cache on ANY failure, which turned a 429
      // into a self-feeding loop: the 429 deleted the cache, the next turn
      // re-created it at the full input rate for the whole prompt (~13.5k
      // tokens), and that extra throughput made the next 429 likelier. Only a
      // handle the API actually REJECTED — expired or deleted server-side — is
      // worth throwing away.
      const rateLimited = classifyProviderFailure(message) === "RATE_LIMITED";
      if (cachedContent && !rateLimited && !input.signal?.aborted && provider instanceof GeminiChatProvider) {
        console.warn("[BoardManagerAgent] cached completion failed — retrying inline:", message);
        provider.invalidatePromptCache(cachedContent);
        try {
          result = await this.completeWithRateLimitRetry(provider, inlineRequest, input.signal);
        } catch (retryErr) {
          console.error("[BoardManagerAgent] completion failed:", (retryErr as Error).message);
          return failureResult(retryErr as Error, "inline retry");
        }
      } else {
        console.error("[BoardManagerAgent] completion failed:", message);
        return failureResult(err as Error);
      }
    }

    const finalized = finalizeBoardManagerToolCalls(
      result.toolCalls,
      fusionMap,
      result.usage,
      result.finishReason,
    );
    // Fold prompt-cache CREATE tokens (billed by Google at the normal input
    // rate) into this turn's prompt tokens so the ledger charge is accurate.
    if (this.pendingCacheCreateTokens > 0 && finalized.usage) {
      finalized.usage.promptTokens += this.pendingCacheCreateTokens;
      this.pendingCacheCreateTokens = 0;
    }
    return finalized;
  }
}

// ---------------------------------------------------------------------------
// Shared tool-call → result finalizer
// ---------------------------------------------------------------------------

/**
 * Turn raw tool calls (from EITHER the HTTP completion or a Live turn) into a
 * fully-formed BoardManagerInvocationResult: fusion-merge, parse each call to
 * a typed event, queue fusion feedback, and supply the `board_no_change`
 * fallback when the model emitted nothing usable.
 *
 * Both the HTTP `BoardManagerAgent.invoke()` and the Live
 * `LiveBoardManagerAgent.invoke()` funnel through here, so the two paths
 * produce byte-identical events for the same tool calls. The only per-path
 * difference is how `usage` is shaped/billed — the Live path bills via the
 * provider's onUsage callback and passes `undefined` here so the Coordinator's
 * `result.usage` charge is skipped (no double billing).
 *
 * `rawToolCalls` carries the provider's `{ name, arguments: <json string> }`
 * shape — the Live agent stringifies its object args to match before calling.
 */
export function finalizeBoardManagerToolCalls(
  rawToolCalls: Array<{ name: string; arguments: string }>,
  fusionMap: Map<string, FusionEntry>,
  usage: BoardManagerInvocationResult["usage"] | undefined,
  finishReason: string | undefined,
): BoardManagerInvocationResult {
  // Pre-pass: collapse parallel fused calls that target the same
  // (tool, arrayParam). The model sometimes emits one fused call per
  // intended item (e.g. six `RebuildBoardButtons` calls for a single
  // intended 6-button rebuild); without merging, each gets rewritten
  // to a single-item rebuild_board and the per-call dispatch
  // downgrades them to add_board_button — replacing the intended bulk
  // rebuild with six sequential adds. See tool-fusion-normalizer.
  const mergedToolCalls = mergeFusedToolCalls(rawToolCalls, fusionMap);
  if (mergedToolCalls.length !== rawToolCalls.length) {
    flowNote(
      "BOARD_MGR",
      `Merged ${rawToolCalls.length} fused tool calls → ${mergedToolCalls.length} after array-param coalescing`,
    );
  }

  // Parse each tool call into a typed event. Collect any fusion
  // detections so the Coordinator can issue a corrective retry turn.
  const now = Date.now();
  const events: BoardManagerOutputEvent[] = [];
  const fusionFeedback: NonNullable<BoardManagerInvocationResult["fusionFeedback"]> = [];
  for (const call of mergedToolCalls) {
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
  if (events.length === 0 && rawToolCalls.length === 0) {
    const reason = finishReason ? `no tool calls (finish: ${finishReason})` : "no tool calls";
    console.warn(`[BoardManagerAgent] empty response — ${reason}. usage=${JSON.stringify(usage)}`);
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
    rawToolCalls,
    usage,
    finishReason,
    fusionFeedback: fusionFeedback.length > 0 ? fusionFeedback : undefined,
  };
}
