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
  buildOrphanReprompt,
  SPEAKER_TOOL_ACK,
} from "./prompts/speaker";
import type { FunctionDeclaration } from "@google/genai";
import { SentenceStreamer } from "./sentence-streamer";
import { SpokenTurnGate } from "./spoken-turn-gate";
import { flowInput, flowTool, flowOutput, flowNote } from "./agent-flow-logger";
import type { LiveUsage } from "./live-provider";
import type { SpeakerCallbacks, SpeakerStartConfig, SpeakerOutputEvent } from "./speaker-agent";
// Shared thought-leak detection/stripping — the same guard the native-audio
// SpeakerAgent applies to its streaming transcript. Reused here so the HTTP
// path doesn't let a voiced `private_thought` reach the client / TTS.
import { isLeakedThought, stripThoughtLeakMarker } from "./speaker-agent";
import type { ISpeakerAgent } from "./speaker-interface";
import type {
  SpeechStartEvent,
  SpeechTextFinalizedEvent,
  SpeechEndEvent,
  EmoteChangeEvent,
  CallPersonEvent,
  AppOpenRequestedEvent,
  AppCloseRequestedEvent,
  WebsiteOpenRequestedEvent,
  MonitorCallRequestedEvent,
  PrivateNoteEvent,
  RemainSilentEvent,
  ThoughtLeakEvent,
  ContextLeakEvent,
} from "./agent-events";
import type { DisclosureContext } from "../processorDisclosure";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Cap on the number of non-system messages we retain in the in-memory
 *  history. Older turns are dropped from the front when we exceed this.
 *  The Coordinator periodically injects session summaries as system
 *  context, so dropping older turn-by-turn detail is safe. */
const HISTORY_TURN_CAP = 60;

/** When over cap, drop this many extra messages in one block. Sliding by
 *  exactly the overflow shifts the prompt prefix on EVERY call once the cap
 *  is reached, permanently busting Gemini implicit prefix caching for the
 *  rest of the session. Chunked trims keep the prefix byte-stable between
 *  trims. */
const HISTORY_TRIM_CHUNK = 20;

/** Max tokens per HTTP completion. Speaker replies are short (one or
 *  two sentences) so this is plenty, with margin for tool calls. */
const MAX_OUTPUT_TOKENS = 600;

/** How many times within a single user turn the Speaker is allowed to
 *  emit only private_note(s) (no text, no remain_silent) before the
 *  loop bails out. Each orphan-note turn we re-fire with the notes
 *  injected as system context and require the model to actually reply
 *  or call remain_silent. Without a cap the model can spin forever
 *  rationalizing about its own thoughts. */
const MAX_NOTE_REPROMPTS = 3;

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
  /** AKIM §18.5 — who this agent's LLM traffic is about. Rides on each
   *  request DTO (see ChatRequest.disclosure) rather than AsyncLocalStorage,
   *  because turns are queued and streamed across async boundaries. */
  private disclosureCtx: DisclosureContext | null = null;
  setDisclosureContext(ctx: DisclosureContext | null): void {
    this.disclosureCtx = ctx;
  }

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

  // Per-turn private_note rollover state. Reset at the start of each
  // sendUserTurn. Notes from orphan turns (no text / no remain_silent)
  // accumulate here so they can be injected into the next re-prompt and
  // the model can see what it was thinking — but they're NEVER persisted
  // into `this.history` long-term (we don't want the model treating its
  // own past notes as the canonical record of its reasoning).
  private notesBufferThisTurn: string[] = [];
  private noteRepromptCount = 0;
  // Fake history items appended to the messages array during the orphan
  // loop so the model sees a coherent self-record of its own notes +
  // re-prompts WITHOUT those entries entering `this.history` long-term.
  // Cleared at every sendUserTurn. Holds: fake assistant tool_call
  // entries (one per note), their synthetic tool acks, and the user-role
  // re-prompts the orphan loop generated. Without this, each re-fire
  // saw the same input as the first pass and produced byte-identical
  // private_note output, then hit the cap silently.
  private orphanLoopMessages: ProviderChatMessage[] = [];

  // Debug context
  private debugSessionId: string | null = null;
  private debugMode = false;

  // One-shot target the model can set via set_speech_target() before
  // speaking. Defaults to "USER" — applied to the next SpeechEnd event
  // and reset afterwards.
  private pendingSpeechTarget: string | undefined;

  private opened = false;

  /**
   * @param useVertex bill through the paid GCP project — the SAME signal the
   *   live Speaker gets. The fallback path must not quietly drop onto the free
   *   AI Studio key. See providers/vertex-config.ts.
   */
  constructor(providerKey: LLMProviderKey, callbacks: SpeakerCallbacks, useVertex = false) {
    this.providerKey = providerKey;
    this.callbacks = callbacks;
    if (providerKey !== "gemini") {
      throw new Error(`[HttpSpeakerAgent] Unsupported provider: ${providerKey}`);
    }
    this.provider = getChatProvider(providerKey, { useVertex });
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
    // New turn → reset the orphan-note rollover state.
    this.notesBufferThisTurn = [];
    this.noteRepromptCount = 0;
    this.orphanLoopMessages = [];
    // Fire a new completion. If an earlier one is still streaming, abort
    // it — newer turn supersedes older context.
    void this.fireCompletion();
  }

  /** Barge-in: the student pressed a different button over this answer, so
   *  abandon it. Aborting the stream stops the sentence-streamer mid-reply, so
   *  nothing further reaches TTS. No replacement completion is fired — the
   *  press that caused this supplies the next turn (possibly after a chain
   *  hold), and firing one here would race it. */
  cancelTurn(reason: string): void {
    if (!this.inFlight) return;
    flowNote("SPEAKER", `Turn cancelled (${reason}) — in-flight completion aborted.`);
    this.abortInFlight();
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
      const drop = this.history.length - HISTORY_TURN_CAP + HISTORY_TRIM_CHUNK;
      this.history.splice(0, drop);
      // Never leave an orphaned tool ack at the front — its assistant
      // tool-call message must survive with it or the turn is malformed.
      while (this.history.length > 0 && this.history[0].role === "tool") {
        this.history.shift();
      }
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
      // Fake assistant tool_calls + tool acks + re-prompt user messages
      // accumulated during the orphan loop. Empty outside the loop.
      ...this.orphanLoopMessages,
    ];

    const splitter = new SentenceStreamer();
    // Strips a leaked leading meta-tag ("[USER to YOU] …") off the front of
    // the reply BEFORE it reaches the sentence splitter (so TTS never voices
    // it), the client subtitle, or the persisted transcript.
    const turnGate = new SpokenTurnGate();
    let speechStartEmitted = false;
    let fullText = "";
    // Set once the streamed text reveals the model voicing its private
    // reasoning ("private_thought …") instead of calling the tool. While
    // true we stop forwarding text to the client subtitle + TTS, and the
    // turn resolves to a ThoughtLeakEvent instead of speech.
    let leakedThought = false;
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
        disclosure: this.disclosureCtx ?? undefined,
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
          case "text_delta": {
            // Run the delta through THE gate first (spoken-turn-gate.ts).
            // It withholds text while a bracket / paren group is still open,
            // removes machine wire format wherever it appears, and flips
            // `severe` when the turn stops being a reply and becomes the
            // model reciting its own input.
            const cleaned = turnGate.push(chunk.text);
            if (turnGate.severe) break; // disqualified — forward nothing
            if (!cleaned) break;
            fullText += cleaned;
            // Thought-leak guard (mirrors SpeakerAgent.handleOutputTranscription).
            // The model sometimes VOICES its private_thought reasoning as
            // text instead of calling the tool. Detect on the accumulated
            // text and stop forwarding to BOTH the client subtitle and TTS.
            // The marker leads the utterance and the sentence splitter only
            // flushes on a sentence boundary, so we catch it before any
            // audio is synthesized. Keep accumulating `fullText` (above) so
            // the captured reasoning is complete for the supervisor log.
            if (!leakedThought && isLeakedThought(fullText)) {
              leakedThought = true;
              flowOutput("SPEAKER", "thought_leak_detected", fullText.trim());
            }
            if (leakedThought) break; // swallow the leaked reasoning
            // Forward to the client as a streaming text delta — same
            // path the Live native-audio outputTranscription uses. The
            // subtitle / avatar mouth track this so the user sees text
            // appear as it's generated, not only after TTS completes.
            this.callbacks.onTranscriptionDelta?.(cleaned);
            for (const sentence of splitter.push(cleaned)) {
              onSentenceReady(sentence);
            }
            break;
          }
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

      // ----- Leaked thought: terminal, no speech -----------------------
      // The model voiced its private reasoning as text. Emit a ThoughtLeakEvent
      // (marker stripped) INSTEAD of speech — nothing was forwarded to the
      // client / TTS, nothing is persisted as a reply, and we deliberately
      // skip the orphan re-prompt loop below (which would otherwise fire on
      // the empty reply). The Coordinator records the note on supervisor
      // channels, resets the client text accumulator, and injects a corrective.
      // ----- Recited context: terminal, no speech ----------------------
      // The model echoed its own input ("[CONTEXT] …", a leading stage
      // direction) instead of replying. Nothing was forwarded to the client
      // or TTS; emit a ContextLeakEvent so the Coordinator suppresses the
      // turn and injects a corrective, exactly as for a thought leak. Placed
      // BEFORE the thought-leak branch only in the sense that both are
      // terminal — a turn can trip either, and thought-leak wins since the
      // reasoning is the more useful supervisor record.
      if (!leakedThought && turnGate.severe) {
        const gated = turnGate.result();
        flowOutput("SPEAKER", "context_leak", gated.leaked);
        const ev: ContextLeakEvent = {
          type: "context_leak",
          source: "speaker",
          timestamp: Date.now(),
          recited: gated.leaked,
          speech: gated.speech,
        };
        this.callbacks.onEvent(ev);
        return;
      }

      if (leakedThought) {
        // Fold in any text the gate withheld (unclosed bracket) so the
        // captured note is complete — but never forward it.
        const note = stripThoughtLeakMarker((fullText + turnGate.flush()).trim());
        flowOutput("SPEAKER", "thought_leak", note);
        const ev: ThoughtLeakEvent = {
          type: "thought_leak",
          source: "speaker",
          timestamp: Date.now(),
          note,
        };
        this.callbacks.onEvent(ev);
        return;
      }

      // Flush the gate first — if it withheld an unclosed "[" run
      // (degenerate utterance), release it as ordinary text now.
      const heldLead = turnGate.flush();
      if (heldLead) {
        fullText += heldLead;
        this.callbacks.onTranscriptionDelta?.(heldLead);
        for (const sentence of splitter.push(heldLead)) onSentenceReady(sentence);
      }
      // Flush any partial trailing fragment as the final sentence so it
      // also gets voiced.
      const tail = splitter.flush();
      if (tail) onSentenceReady(tail);

      const transcript = fullText.trim();
      const gatedTurn = turnGate.result();
      if (gatedTurn.verdict === "mild") {
        flowOutput("SPEAKER", "leading_tag_stripped", gatedTurn.leaked);
      }

      // ----- Partition tool calls --------------------------------------
      // private_thought and remain_silent are handled specially here. Other
      // tool calls (emote, open_app, ...) are emitted as events and
      // persisted to history normally. (`private_note` kept as an alias for
      // stale model calls — the tool was renamed to `private_thought`.)
      const isThoughtCall = (name?: string) =>
        name === "private_thought" || name === "private_note";
      const noteCalls = toolCalls.filter(c => isThoughtCall(c.name));
      const silentCalls = toolCalls.filter(c => c.name === "remain_silent");
      const otherCalls = toolCalls.filter(
        c => !isThoughtCall(c.name) && c.name !== "remain_silent",
      );

      // Buffer notes from THIS firing for potential re-prompt. Also emit
      // PrivateNoteEvent so the log / monitor sees them.
      for (const call of noteCalls) {
        let args: any = {};
        try { args = JSON.parse(call.arguments || "{}"); } catch {}
        const note = typeof args.note === "string" ? args.note : "";
        if (note) this.notesBufferThisTurn.push(note);
        flowTool("SPEAKER", "private_thought", JSON.stringify(args));
        const ev: PrivateNoteEvent = {
          type: "private_note",
          source: "speaker",
          timestamp: Date.now(),
          note,
        };
        this.callbacks.onEvent(ev);
      }

      // Surface remain_silent for the log too.
      for (const call of silentCalls) {
        let args: any = {};
        try { args = JSON.parse(call.arguments || "{}"); } catch {}
        const reason = typeof args.reason === "string" ? args.reason : "(no reason)";
        flowTool("SPEAKER", "remain_silent", JSON.stringify(args));
        const ev: RemainSilentEvent = {
          type: "remain_silent",
          source: "speaker",
          timestamp: Date.now(),
          reason,
        };
        this.callbacks.onEvent(ev);
      }

      // ----- Other tool events ------------------------------------------
      // Fire side-action tools (emote, open_app, etc.) immediately so
      // their effects (avatar emote change, app opens) apply right away.
      // We re-prompt for missing speech below, but the side actions are
      // committed — the user has already SEEN the emote / app / etc.
      for (const call of otherCalls) {
        let args: any = {};
        try { args = JSON.parse(call.arguments || "{}"); } catch {}
        flowTool("SPEAKER", call.name, JSON.stringify(args));
        for (const ev of this.parseToolCall({ name: call.name, args }, Date.now())) {
          this.callbacks.onEvent(ev);
        }
      }

      const hasReply = transcript.length > 0;
      const hasRemainSilent = silentCalls.length > 0;
      // An "orphan" turn is one that ended with NO spoken text AND NO
      // explicit remain_silent — meaning the only output was side
      // actions (notes, emotes, app opens, etc.). Every observed
      // failure mode where the user gets no reply boils down to this:
      // the model issued an emote / private_note / set_speech_target
      // and treated that as the whole turn. Re-prompt to force either
      // real speech or an explicit silence acknowledgment.
      const hasSideActions = noteCalls.length > 0 || otherCalls.length > 0;
      const isOrphanTurn =
        !hasReply && !hasRemainSilent && hasSideActions;

      // ----- Re-prompt path --------------------------------------------
      // Orphan turn: persist side-action tool calls to REAL history (those
      // actually fired), append FAKE history items for the model's own
      // private_note calls + re-prompt onto `orphanLoopMessages` so the
      // model sees a coherent self-record without those entries entering
      // the long-term history.
      if (isOrphanTurn && this.noteRepromptCount < MAX_NOTE_REPROMPTS) {
        this.noteRepromptCount++;
        if (otherCalls.length > 0) {
          // Persist side-action calls to real history (they actually
          // fired). Gemini needs the synthetic tool ack to keep the
          // turn well-formed.
          this.history.push({
            role: "assistant",
            content: null,
            toolCalls: otherCalls.map((c, idx) => ({
              id: `call_${Date.now()}_${idx}`,
              name: c.name,
              arguments: c.arguments,
            })),
          });
          for (const c of otherCalls) {
            this.history.push({
              role: "tool",
              toolCallId: c.name,
              content: JSON.stringify(SPEAKER_TOOL_ACK),
            });
          }
        }
        if (noteCalls.length > 0) {
          // Fake history for the model's note tool calls — appended only
          // to orphanLoopMessages so it disappears at next sendUserTurn.
          // Without this the model sees no record of having noted and
          // re-derives the same note from the user turn deterministically.
          const ids = noteCalls.map((_, idx) => `note_${Date.now()}_${idx}`);
          this.orphanLoopMessages.push({
            role: "assistant",
            content: null,
            toolCalls: noteCalls.map((c, idx) => ({
              id: ids[idx],
              name: c.name,
              arguments: c.arguments,
            })),
          });
          for (let i = 0; i < noteCalls.length; i++) {
            this.orphanLoopMessages.push({
              role: "tool",
              toolCallId: ids[i],
              content: JSON.stringify(SPEAKER_TOOL_ACK),
            });
          }
        }
        const repromptText = buildOrphanReprompt({
          otherCalls,
          noteCalls,
          bufferedNotes: this.notesBufferThisTurn,
        });
        this.orphanLoopMessages.push({ role: "user", content: repromptText });
        this.trimHistory();
        flowNote(
          "SPEAKER",
          `orphan turn (#${this.noteRepromptCount}/${MAX_NOTE_REPROMPTS}); side-actions=[${otherCalls.map(c => c.name).join(",") || "none"}] notes=${this.notesBufferThisTurn.length}; re-prompting`,
        );
        // Defer recursive call until the current finally has cleared
        // inFlight; otherwise abortInFlight in the next firing would
        // cancel us mid-cleanup.
        queueMicrotask(() => void this.fireCompletion());
        return;
      }

      // ----- speech_text_finalized -------------------------------------
      // BoardManager kicks on this so it sees the FULL transcript while
      // TTS continues to stream.
      if (hasReply) {
        flowOutput("SPEAKER", "text_finalized", transcript);
        const tf: SpeechTextFinalizedEvent = {
          type: "speech_text_finalized",
          source: "speaker",
          timestamp: Date.now(),
          transcript,
        };
        this.callbacks.onEvent(tf);
      }

      // ----- Persist to history ----------------------------------------
      // Persist ONLY the reply text + non-note/non-silent tool calls.
      // private_note and remain_silent are intentionally dropped from
      // long-term history: the model should not see its own past notes
      // or silence-decisions, which encourages "I am a thinking model"
      // self-imitation and (in the note case) literal `[PRIVATE NOTE]`
      // prefixes in replies. Notes from the orphan-loop are also
      // discarded at this point — the only durable record is the event
      // log + Monitor's view.
      if (hasReply || otherCalls.length > 0) {
        this.history.push({
          role: "assistant",
          content: hasReply ? transcript : null,
          toolCalls: otherCalls.length > 0
            ? otherCalls.map((c, idx) => ({
                id: `call_${Date.now()}_${idx}`,
                name: c.name,
                arguments: c.arguments,
              }))
            : undefined,
        });
        for (const c of otherCalls) {
          this.history.push({
            role: "tool",
            toolCallId: c.name,
            content: JSON.stringify(SPEAKER_TOOL_ACK),
          });
        }
      }
      this.trimHistory();

      // ----- speech_end ------------------------------------------------
      if (hasReply) {
        flowOutput("SPEAKER", "speech", transcript);
        const se: SpeechEndEvent = {
          type: "speech_end",
          source: "speaker",
          timestamp: Date.now(),
          transcript,
          target: this.pendingSpeechTarget ?? "USER",
          strippedLeadingTag: gatedTurn.verdict === "mild" ? gatedTurn.leaked : undefined,
        };
        this.callbacks.onEvent(se);
      } else if (!hasRemainSilent && noteCalls.length > 0) {
        // Hit the re-prompt cap without producing speech or silence.
        // Log it loudly — it's an indicator that the prompt is steering
        // the model toward chronic note-only turns.
        flowNote(
          "SPEAKER",
          `note-rollover cap hit (${MAX_NOTE_REPROMPTS}); dropping turn silently`,
        );
      }

      // Per-turn rollover state is reset on the NEXT sendUserTurn, not
      // here — we want the counter to persist across re-fires within
      // the same user turn but reset cleanly when a fresh turn lands.
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

      case "call_person": {
        const contactId = asString(args.contactId);
        if (!contactId) return [];
        const ev: CallPersonEvent = {
          type: "call_person",
          source: "speaker",
          timestamp: now,
          contactId,
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

      case "private_thought":
      case "private_note":
      case "remain_silent":
        // Handled inline in fireCompletion (note buffering / orphan
        // re-prompt loop / silence acknowledgment). parseToolCall is
        // only called for "other" tools after partitioning, so reaching
        // here is unexpected — return [] defensively.
        return [];

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

