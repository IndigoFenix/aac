// server/services/dual-agent/http-speaker-agent.ts
//
// HTTP-completion-based Speaker. A drop-in for SpeakerAgent that uses
// Gemini's chat-completion streaming API instead of Live. Lower cost
// (no native-audio billing), more reliable tool calling, and supports
// the full Speaker tool surface without MALFORMED bursts.
//
// Latency strategy: sentence-level streaming. As text deltas land we
// flush each completed sentence to `onSpeakText`, which the Coordinator
// pipes into `ttsFacade.synthesizeStream`. First-audio latency is
// therefore time-to-first-sentence + TTS first-chunk, typically ~400ms
// for short replies, instead of the full completion latency.
//
// Context-injection semantics differ from Live: an HTTP completion
// fires every call, so `sendContextInjection` BUFFERS the line without
// triggering generation. The next `sendUserTurn` fires the completion
// that sees all queued context. This trades the Live path's "proactive
// comment on ambient observation" for zero cost on routine context.

import type { LLMProviderKey } from "@shared/llm-options";
import { getChatProvider } from "../providers/provider-factory";
import type {
  ChatProvider,
  ChatTool,
  ChatMessage as ProviderChatMessage,
  StreamChunk,
} from "../providers/streaming-provider";
import {
  buildSpeakerToolDeclarations,
  type SpeakerToolConfig,
} from "./tool-declarations-speaker";
import type { FunctionDeclaration } from "@google/genai";
import { SentenceStreamer } from "./sentence-streamer";
import { flowInput, flowTool, flowOutput, flowNote } from "./agent-flow-logger";
import type { LiveUsage } from "./live-provider";
import type { SpeakerCallbacks, SpeakerStartConfig, SpeakerOutputEvent } from "./speaker-agent";
import type { ISpeakerAgent } from "./speaker-interface";
import type {
  SpeechStartEvent,
  SpeechTextFinalizedEvent,
  SpeechEndEvent,
  EmoteChangeEvent,
  AppOpenRequestedEvent,
  AppCloseRequestedEvent,
  WebsiteOpenRequestedEvent,
  MonitorCallRequestedEvent,
  PrivateNoteEvent,
} from "./agent-events";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Cap on the number of non-system messages we retain in the in-memory
 *  history. Older turns are dropped from the front when we exceed this.
 *  The Coordinator periodically injects session summaries as system
 *  context, so dropping older turn-by-turn detail is safe. */
const HISTORY_TURN_CAP = 60;

/** Max tokens per HTTP completion. Speaker replies are short (one or
 *  two sentences) so this is plenty, with margin for tool calls. */
const MAX_OUTPUT_TOKENS = 600;

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

function fnDeclToChatTool(fd: FunctionDeclaration): ChatTool {
  return {
    type: "function",
    function: {
      name: fd.name ?? "unknown",
      description: fd.description,
      parameters: (fd.parametersJsonSchema as Record<string, any>) ?? { type: "object", properties: {} },
    },
  };
}

function buildToolList(toolConfig: SpeakerToolConfig): ChatTool[] {
  // Force useDirectAudio=true so the speak() tool is omitted — in HTTP
  // mode the assistant's text content IS the spoken reply. Set
  // httpMode=true so the Live-only "empty tool surface" diagnostic
  // doesn't fire (HTTP path needs real tools, especially private_note).
  const decls = buildSpeakerToolDeclarations({ ...toolConfig, useDirectAudio: true, httpMode: true });
  const flat = decls.flatMap(t => t.functionDeclarations ?? []);
  return flat.map(fnDeclToChatTool);
}

// ---------------------------------------------------------------------------
// HttpSpeakerAgent
// ---------------------------------------------------------------------------

export class HttpSpeakerAgent implements ISpeakerAgent {
  private readonly callbacks: SpeakerCallbacks;
  private readonly provider: ChatProvider;
  private readonly providerKey: LLMProviderKey;

  // Conversation state
  private systemPrompt = "";
  private model = "";
  private tools: ChatTool[] = [];
  private history: ProviderChatMessage[] = [];

  // Generation state
  private inFlight: AbortController | null = null;
  private currentTurnSentenceCount = 0;

  // Debug context
  private debugSessionId: string | null = null;
  private debugMode = false;

  // One-shot target the model can set via set_speech_target() before
  // speaking. Defaults to "USER" — applied to the next SpeechEnd event
  // and reset afterwards.
  private pendingSpeechTarget: string | undefined;

  private opened = false;

  constructor(providerKey: LLMProviderKey, callbacks: SpeakerCallbacks) {
    this.providerKey = providerKey;
    this.callbacks = callbacks;
    if (providerKey !== "gemini") {
      throw new Error(`[HttpSpeakerAgent] Unsupported provider: ${providerKey}`);
    }
    this.provider = getChatProvider(providerKey);
  }

  get isConnected(): boolean {
    return this.opened;
  }

  async start(config: SpeakerStartConfig): Promise<void> {
    this.systemPrompt = config.systemPrompt;
    this.model = config.model;
    this.tools = buildToolList(config.toolConfig);
    this.history = [];
    this.opened = true;
    this.pendingSpeechTarget = undefined;
    flowNote("SPEAKER", `HTTP path started (model=${config.model}, tools=${this.tools.length})`);
  }

  async reconnectWithConfig(config: SpeakerStartConfig): Promise<void> {
    // HTTP path has no live socket — "reconnect" is just rebuilding the
    // prompt + tool list. History is preserved so the new profile sees
    // recent turns.
    this.abortInFlight();
    this.systemPrompt = config.systemPrompt;
    this.model = config.model;
    this.tools = buildToolList(config.toolConfig);
    flowNote("SPEAKER", `HTTP path reconfigured (model=${config.model})`);
  }

  close(): void {
    this.abortInFlight();
    this.opened = false;
    this.history = [];
  }

  setDebugSessionContext(sessionId: string, debugMode: boolean, _agentLabel = "SPEAKER"): void {
    this.debugSessionId = sessionId;
    this.debugMode = debugMode;
  }

  // -------------------------------------------------------------------------
  // Input handlers
  // -------------------------------------------------------------------------

  sendUserTurn(text: string): void {
    if (!this.opened) return;
    flowInput("SPEAKER", "user_turn", text);
    this.history.push({ role: "user", content: text });
    this.trimHistory();
    // Fire a new completion. If an earlier one is still streaming, abort
    // it — newer turn supersedes older context.
    void this.fireCompletion();
  }

  sendContextInjection(text: string): void {
    if (!this.opened) return;
    flowInput("SPEAKER", "context", text);
    // Buffer as a system-tagged user message so the next completion sees
    // the context. Gemini's chat treats user-role content as the turn
    // input; tagging with [CONTEXT] keeps it visible without provoking a
    // separate reply.
    this.history.push({ role: "user", content: text });
    this.trimHistory();
    // Intentionally no completion fire here. Unlike Live's
    // proactiveAudio path, HTTP completions are not free — buffer until
    // a real user turn arrives.
  }

  sendConversationHistory(turns: Array<{ role: "user" | "model"; text: string }>): void {
    // Replay path — reseed history wholesale.
    this.history = turns.map(t => ({
      role: t.role === "model" ? ("assistant" as const) : ("user" as const),
      content: t.text,
    }));
    this.trimHistory();
  }

  // -------------------------------------------------------------------------
  // Completion firing + streaming
  // -------------------------------------------------------------------------

  private abortInFlight(): void {
    if (this.inFlight) {
      try { this.inFlight.abort(); } catch {}
      this.inFlight = null;
    }
  }

  private trimHistory(): void {
    if (this.history.length > HISTORY_TURN_CAP) {
      const drop = this.history.length - HISTORY_TURN_CAP;
      this.history.splice(0, drop);
    }
  }

  private async fireCompletion(): Promise<void> {
    this.abortInFlight();
    const controller = new AbortController();
    this.inFlight = controller;
    this.currentTurnSentenceCount = 0;
    this.pendingSpeechTarget = undefined;

    const messages: ProviderChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      ...this.history,
    ];

    const splitter = new SentenceStreamer();
    let speechStartEmitted = false;
    let fullText = "";
    const toolCalls: Array<{ name: string; arguments: string }> = [];

    const onSentenceReady = (sentence: string) => {
      if (!sentence) return;
      this.currentTurnSentenceCount++;
      if (!speechStartEmitted) {
        speechStartEmitted = true;
        const ev: SpeechStartEvent = {
          type: "speech_start",
          source: "speaker",
          timestamp: Date.now(),
          transcript: sentence,
        };
        this.callbacks.onEvent(ev);
      }
      this.callbacks.onSpeakText?.(sentence);
    };

    try {
      const stream = this.provider.streamChat({
        model: this.model,
        messages,
        tools: this.tools.length > 0 ? this.tools : undefined,
        toolChoice: this.tools.length > 0 ? "auto" : undefined,
        temperature: 0.7,
        maxTokens: MAX_OUTPUT_TOKENS,
        signal: controller.signal,
      });

      for await (const chunk of stream) {
        if (controller.signal.aborted) break;
        switch (chunk.type) {
          case "text_delta":
            fullText += chunk.text;
            // Forward to the client as a streaming text delta — same
            // path the Live native-audio outputTranscription uses. The
            // subtitle / avatar mouth track this so the user sees text
            // appear as it's generated, not only after TTS completes.
            if (chunk.text) this.callbacks.onTranscriptionDelta?.(chunk.text);
            for (const sentence of splitter.push(chunk.text)) {
              onSentenceReady(sentence);
            }
            break;
          case "tool_call_delta":
            // Gemini emits complete tool calls (not partial args). Just
            // collect each as it arrives.
            if (chunk.name) {
              toolCalls.push({
                name: chunk.name,
                arguments: chunk.arguments ?? "{}",
              });
            }
            break;
          case "done":
            if (chunk.usage) {
              const usage: LiveUsage = {
                promptTokens: chunk.usage.promptTokens,
                completionTokens: chunk.usage.completionTokens,
                cachedTokens: chunk.usage.cachedTokens,
              };
              this.callbacks.onUsage?.(usage);
            }
            break;
        }
      }

      if (controller.signal.aborted) {
        flowNote("SPEAKER", "HTTP completion aborted (superseded turn)");
        return;
      }

      // Flush any partial trailing fragment as the final sentence so it
      // also gets voiced.
      const tail = splitter.flush();
      if (tail) onSentenceReady(tail);

      const transcript = fullText.trim();
      // SpeechTextFinalized — full transcript is ready. Coordinator uses
      // this to kick BoardManager while TTS continues playing out.
      if (transcript) {
        flowOutput("SPEAKER", "text_finalized", transcript);
        const tf: SpeechTextFinalizedEvent = {
          type: "speech_text_finalized",
          source: "speaker",
          timestamp: Date.now(),
          transcript,
        };
        this.callbacks.onEvent(tf);
      }

      // Tool events.
      for (const call of toolCalls) {
        let args: any = {};
        try { args = JSON.parse(call.arguments || "{}"); } catch {}
        flowTool("SPEAKER", call.name, JSON.stringify(args));
        for (const ev of this.parseToolCall({ name: call.name, args }, Date.now())) {
          this.callbacks.onEvent(ev);
        }
      }

      // Persist assistant turn to history so future turns see it.
      this.history.push({
        role: "assistant",
        content: transcript || null,
        toolCalls: toolCalls.length > 0
          ? toolCalls.map((c, idx) => ({
              id: `call_${Date.now()}_${idx}`,
              name: c.name,
              arguments: c.arguments,
            }))
          : undefined,
      });

      // For each tool call, append a synthetic "ok" tool response so
      // Gemini's history stays well-formed for the next turn.
      for (const c of toolCalls) {
        this.history.push({
          role: "tool",
          toolCallId: c.name,
          content: JSON.stringify({ output: "ok" }),
        });
      }

      this.trimHistory();

      // SpeechEnd — model finished generating. Emit only when there was
      // actual speech this turn; tool-only turns (e.g. silent open_app)
      // don't fire SpeechEnd.
      if (transcript) {
        flowOutput("SPEAKER", "speech", transcript);
        const se: SpeechEndEvent = {
          type: "speech_end",
          source: "speaker",
          timestamp: Date.now(),
          transcript,
          target: this.pendingSpeechTarget ?? "USER",
        };
        this.callbacks.onEvent(se);
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      const msg = (err as Error)?.message || String(err);
      console.error("[HttpSpeakerAgent] streamChat failed:", msg);
      this.callbacks.onError(err instanceof Error ? err : new Error(msg));
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
  }

  // -------------------------------------------------------------------------
  // Tool dispatch — mirrors SpeakerAgent.parseToolCall (minus the `speak`
  // tool which isn't declared here).
  // -------------------------------------------------------------------------

  private parseToolCall(call: { name: string; args: Record<string, unknown> }, now: number): SpeakerOutputEvent[] {
    const asString = (v: unknown): string | undefined =>
      typeof v === "string" ? v : undefined;
    const args = call.args || {};

    switch (call.name) {
      case "emote": {
        const emotion = asString(args.emotion) as EmoteChangeEvent["emote"] | undefined;
        if (!emotion) return [];
        const ev: EmoteChangeEvent = {
          type: "emote_change",
          source: "speaker",
          timestamp: now,
          emote: emotion,
        };
        return [ev];
      }

      case "set_speech_target": {
        const target = asString(args.target);
        if (target) this.pendingSpeechTarget = target;
        return [];
      }

      case "open_app": {
        const appId = asString(args.app_id);
        if (!appId) return [];
        const ev: AppOpenRequestedEvent = {
          type: "app_open_requested",
          source: "speaker",
          timestamp: now,
          appId,
          data: asString(args.data),
        };
        return [ev];
      }

      case "close_app": {
        const ev: AppCloseRequestedEvent = {
          type: "app_close_requested",
          source: "speaker",
          timestamp: now,
        };
        return [ev];
      }

      case "open_website": {
        const url = asString(args.url);
        if (!url) return [];
        const ev: WebsiteOpenRequestedEvent = {
          type: "website_open_requested",
          source: "speaker",
          timestamp: now,
          url,
          label: asString(args.label),
        };
        return [ev];
      }

      case "call_monitor": {
        const ev: MonitorCallRequestedEvent = {
          type: "monitor_call_requested",
          source: "speaker",
          timestamp: now,
          reason: asString(args.reason) ?? "(no reason provided)",
        };
        return [ev];
      }

      case "private_note": {
        const ev: PrivateNoteEvent = {
          type: "private_note",
          source: "speaker",
          timestamp: now,
          note: asString(args.note) ?? "",
        };
        return [ev];
      }

      case "debug_message":
        return [];

      // Stale tools the model may hallucinate from training.
      case "speak":
      case "rebuild_board":
      case "add_context_button":
      case "show_binary_choice":
      case "no_change":
      case "press_button":
      case "set_board":
      case "suggest_construction_buttons":
      case "set_construction_memory_chips":
      case "interpret":
      case "set_interaction_mode":
        return [];

      default:
        console.warn(`[HttpSpeakerAgent] Unknown tool call: ${call.name}`);
        return [];
    }
  }
}

