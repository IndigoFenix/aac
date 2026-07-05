// server/services/dual-agent/live-board-manager-agent.ts
//
// Live Board Manager — an experimental backend for the Board Manager that
// runs on a Gemini Live session (TEXT modality + function calling) instead of
// stateless HTTP completions. Selected per-student via the
// `boardManagerLiveModel` AAC setting (see board-manager-interface.ts).
//
// WHY: a warm Live session keeps the ~3.8k-token Board Manager system prompt
// processed across turns, so each board rebuild only pays for the small
// per-turn context message instead of reprocessing the whole prompt — the
// latency the experiment is testing.
//
// CONTRACT: implements the SAME `invoke(input) → BoardManagerInvocationResult`
// as the HTTP `BoardManagerAgent`, so the Coordinator's orchestration (retry
// chains, fusion feedback, abort, force-rebuild directives, usage gating) is
// unchanged. Tool-call parsing is shared via `finalizeBoardManagerToolCalls`,
// so the two paths emit byte-identical events for the same calls.
//
// BEHAVIORAL NOTES (differences from HTTP, kept intentional + documented):
//   - No `toolChoice: "required"`. The Live API has no forced-tool-call mode.
//     The Board Manager prompt already mandates a tool every turn and has a
//     `no_change` fallback, and `finalizeBoardManagerToolCalls` maps an empty
//     turn to `board_no_change` — so this degrades gracefully.
//   - Reconnect-on-change: the session is re-established whenever the system
//     prompt OR the declared tool set OR the temperature changes (builder /
//     guessing mode transitions, retry-feedback turns, home-press variety).
//     Steady-state conversation turns reuse the warm session.
//   - Cost is billed via the provider's `onUsage` callback at the LIVE model's
//     catalog rates (modality-split). `invoke()` returns `usage: undefined` so
//     the Coordinator's own `result.usage` charge is skipped — no double bill.

import type { LLMProviderKey } from "@shared/llm-options";
import type { Tool } from "@google/genai";
import { GeminiLiveProvider } from "./gemini-live-provider";
import type {
  LiveProviderCallbacks,
  LiveProviderConfig,
  LiveUsage,
  ToolCall,
} from "./live-provider";
import type { FusionEntry } from "./tool-fusion-normalizer";
import {
  buildBoardManagerTooling,
  finalizeBoardManagerToolCalls,
  renderInvocationContext,
  type BoardManagerInvocationInput,
  type BoardManagerInvocationResult,
} from "./board-manager-agent";
import type { BoardManagerToolConfig } from "./prompts/board-manager";
import type { IBoardManagerAgent } from "./board-manager-interface";
import { flowInput, flowNote } from "./agent-flow-logger";

// Hard ceiling on a single Board Manager turn. We resolve a turn on its tool
// call (no_change included), so this only fires when the model produces NO
// tool call at all (rare — the prompt forces one). Kept tight so a wedged
// turn doesn't freeze the board / block the in-flight guard for long; the
// Coordinator treats the fallback as no_change and moves on. Real turns are
// ~1.3s, so a slow-but-valid turn is well under this.
const BM_LIVE_TURN_TIMEOUT_MS = 10_000;
// Text-only turns are small; keep the context window tight so accumulated
// per-turn history doesn't bloat (and slow) the session over a long chat.
const BM_LIVE_COMPRESSION_TRIGGER = 30_000;
const BM_LIVE_COMPRESSION_TARGET = 15_000;

// Minimal acknowledgement that resolves the model's open functionCall so the
// NEXT turn's sendMessage isn't rejected with a malformed-protocol error.
// Delivered via sendToolResponseAsContent (turnComplete:false) so it does NOT
// trigger a fresh generation (see duplication_root_cause.md). Payload mirrors
// the Observer's ack ({ output: "ok" }).
const BOARD_MANAGER_TOOL_ACK = { output: "ok" } as const;

interface PendingTurn {
  rawCalls: ToolCall[];
  fusionMap: Map<string, FusionEntry>;
  resolved: boolean;
  finish: (finishReason: string) => void;
  hardTimer: ReturnType<typeof setTimeout>;
}

export interface LiveBoardManagerOptions {
  providerKey: LLMProviderKey;
  /** Live model id (e.g. "gemini-live-2.5-flash-native-audio"). */
  model: string;
  /** Vertex AI vs public Gemini API — matches the Observer/Speaker setting. */
  useVertex: boolean;
  /** Response modality for the Live session. Half-cascade models support
   *  "TEXT" (the ideal — text in, tool calls out, no audio). Native-audio
   *  models REJECT TEXT output (Vertex closes with 1007 "Text output is not
   *  supported for native audio output model"), so they must run "AUDIO";
   *  the Board Manager just ignores any audio and consumes the tool calls.
   *  Defaults to "AUDIO" for native-audio models, "TEXT" otherwise. */
  responseModality?: "TEXT" | "AUDIO";
  /** Native-audio voice name. The Board Manager never plays audio, but the
   *  native-audio model wants a voice configured in AUDIO modality — leaving
   *  it undefined can cause subtle config-validation issues (mirrors Observer). */
  voiceName?: string;
  /** Per-turn usage for cost tracking. The Coordinator routes this to
   *  trackLiveUsage("board-manager", …, model) so cost lands under the
   *  Board Manager bucket at the live model's rates. */
  onUsage?: (usage: LiveUsage) => void;
}

export class LiveBoardManagerAgent implements IBoardManagerAgent {
  private provider: GeminiLiveProvider | null = null;
  private readonly providerKey: LLMProviderKey;
  private readonly model: string;
  private readonly useVertex: boolean;
  private readonly responseModality: "TEXT" | "AUDIO";
  private readonly voiceName?: string;
  /** 3.1 preview needs the protocol-correct functionResponse ack channel. */
  private readonly isPreview31: boolean;
  private readonly onUsage?: (usage: LiveUsage) => void;

  /** Fingerprint of the currently-connected (systemPrompt + tools + temp).
   *  A mismatch on the next invoke forces a reconnect. */
  private connectedKey: string | null = null;
  /** In-flight (re)connect — invoke() awaits it so prewarm + first invoke
   *  don't open two sessions. */
  private connecting: Promise<void> | null = null;
  /** The active turn awaiting tool calls + turnComplete. At most one — the
   *  Coordinator serializes Board Manager invocations. */
  private pending: PendingTurn | null = null;

  private debugCtx: { sessionId: string; debugMode: boolean; agentLabel?: string } | null = null;

  constructor(opts: LiveBoardManagerOptions) {
    this.providerKey = opts.providerKey;
    this.model = opts.model;
    this.useVertex = opts.useVertex;
    // Native-audio models can't emit TEXT — default them to AUDIO (audio is
    // discarded; only tool calls are consumed). Half-cascade models default
    // to TEXT. An explicit option always wins.
    this.responseModality = opts.responseModality
      ?? (isNativeAudioModel(opts.model) ? "AUDIO" : "TEXT");
    this.voiceName = opts.voiceName;
    this.isPreview31 = /flash-live-preview/i.test(opts.model);
    this.onUsage = opts.onUsage;
    if (this.providerKey !== "gemini") {
      throw new Error(`[LiveBoardManagerAgent] Unsupported provider for Live: ${this.providerKey}`);
    }
  }

  // -------------------------------------------------------------------------
  // IBoardManagerAgent
  // -------------------------------------------------------------------------

  async invoke(input: BoardManagerInvocationInput): Promise<BoardManagerInvocationResult> {
    // Already cancelled before we started — bail without opening a turn. The
    // Coordinator discards aborted results, so the shape doesn't matter.
    if (input.signal?.aborted) {
      return { events: [], rawToolCalls: [], finishReason: "ABORTED" };
    }

    const { declarations, flatDecls, fusionMap } = buildBoardManagerTooling(input.toolConfig);
    const temperature = input.temperature ?? 0.2;
    // The Coordinator sends the stable base + per-turn suffix separately (for
    // the HTTP path's prompt cache); the Live path composes them here — a
    // suffix change flips the key and reconnects, same as when the suffix was
    // baked into systemPrompt upstream.
    const suffix = input.systemPromptSuffix?.trim();
    const systemPrompt = suffix ? `${input.systemPrompt}\n\n${suffix}` : input.systemPrompt;
    const key = this.computeKey(systemPrompt, flatDecls, temperature);

    try {
      await this.ensureConnected(systemPrompt, declarations, temperature, key);
    } catch (err) {
      console.error("[LiveBoardManagerAgent] connect failed:", (err as Error).message);
      flowNote("BOARD_MGR", `Live connect failed: ${(err as Error).message}`);
      return { events: [], rawToolCalls: [], finishReason: "ERROR" };
    }

    if (!this.provider?.isConnected) {
      flowNote("BOARD_MGR", "Live session not connected after ensureConnected — no_change.");
      return finalizeBoardManagerToolCalls([], fusionMap, undefined, "ERROR");
    }

    const contextMessage = renderInvocationContext(input);
    return this.runTurn(contextMessage, fusionMap, input.signal);
  }

  close(): void {
    this.settlePending("CLOSED");
    this.teardownProvider();
    this.connectedKey = null;
  }

  setDebugSessionContext(sessionId: string, debugMode: boolean, agentLabel = "BOARD_MGR"): void {
    this.debugCtx = { sessionId, debugMode, agentLabel };
    this.provider?.setDebugSessionContext(sessionId, debugMode, agentLabel);
  }

  /** Open the session ahead of the first invoke (fire-and-forget) so the
   *  first board build doesn't pay connect latency. Uses the base prompt +
   *  tool config; if the first real invoke differs, ensureConnected reconnects. */
  prewarm(systemPrompt: string, toolConfig: BoardManagerToolConfig): void {
    const { declarations, flatDecls } = buildBoardManagerTooling(toolConfig);
    const temperature = 0.2;
    const key = this.computeKey(systemPrompt, flatDecls, temperature);
    this.ensureConnected(systemPrompt, declarations, temperature, key).catch(err => {
      console.warn("[LiveBoardManagerAgent] prewarm failed (will connect lazily):", (err as Error).message);
    });
  }

  // -------------------------------------------------------------------------
  // Connection management
  // -------------------------------------------------------------------------

  private computeKey(systemPrompt: string, flatDecls: { name?: string | null }[], temperature: number): string {
    const toolNames = flatDecls.map(d => d.name ?? "").join(",");
    // The prompt can be large; its length + a cheap rolling hash is enough to
    // detect content changes without storing the whole string twice.
    return `t=${temperature}|tools=${toolNames}|plen=${systemPrompt.length}|ph=${cheapHash(systemPrompt)}`;
  }

  private async ensureConnected(
    systemPrompt: string,
    declarations: Tool[],
    temperature: number,
    key: string,
  ): Promise<void> {
    // A connect is already in progress (e.g. prewarm) — wait for it, then
    // re-evaluate against the desired key below.
    if (this.connecting) {
      try { await this.connecting; } catch { /* fall through to (re)connect */ }
    }
    if (this.provider?.isConnected && this.connectedKey === key) return;

    this.connecting = this.connect(systemPrompt, declarations, temperature, key)
      .finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async connect(
    systemPrompt: string,
    declarations: Tool[],
    temperature: number,
    key: string,
  ): Promise<void> {
    // New config supersedes any in-flight turn on the old session.
    this.settlePending("RECONNECT");
    this.teardownProvider();

    const provider: GeminiLiveProvider = new GeminiLiveProvider(this.buildCallbacks(() => provider), this.useVertex);
    this.provider = provider;
    if (this.debugCtx) {
      provider.setDebugSessionContext(this.debugCtx.sessionId, this.debugCtx.debugMode, this.debugCtx.agentLabel);
    }

    // Mirror the Observer's proven Vertex config — the other live agent that
    // produces ONLY function calls (no client audio). Native-audio models
    // reject responseModality:TEXT (close=1007), so run AUDIO and discard any
    // audio (no onAudioData handler); proactiveAudio + a voiceName match
    // Observer, which avoids the subtle AUDIO-modality config-validation
    // issues we'd otherwise hit. An empty/silent turn degrades to no_change
    // (handled by finalizeBoardManagerToolCalls) and the Coordinator retries.
    const config: LiveProviderConfig = {
      model: this.model,
      temperature,
      tools: declarations,
      responseModality: this.responseModality,
      proactiveAudio: true,
      voiceName: this.voiceName,
      compressionTriggerTokens: BM_LIVE_COMPRESSION_TRIGGER,
      compressionTargetTokens: BM_LIVE_COMPRESSION_TARGET,
    };

    flowNote("BOARD_MGR", `Live (re)connect — model=${this.model} tools=${declarations[0]?.functionDeclarations?.length ?? 0} temp=${temperature}`);
    await provider.connect(systemPrompt, config);
    this.connectedKey = key;
  }

  private teardownProvider(): void {
    if (this.provider) {
      try { this.provider.close(); } catch { /* ignore */ }
      this.provider = null;
    }
  }

  // -------------------------------------------------------------------------
  // Turn lifecycle
  // -------------------------------------------------------------------------

  private runTurn(
    contextMessage: string,
    fusionMap: Map<string, FusionEntry>,
    signal?: AbortSignal,
  ): Promise<BoardManagerInvocationResult> {
    return new Promise<BoardManagerInvocationResult>((resolve) => {
      const finish = (finishReason: string) => {
        if (pending.resolved) return;
        pending.resolved = true;
        clearTimeout(pending.hardTimer);
        signal?.removeEventListener("abort", onAbort);
        if (this.pending === pending) this.pending = null;
        // Map Live ToolCall (object args) → the provider chat shape the
        // shared finalizer expects (string args). usage is omitted — the
        // Live path bills via the onUsage callback (see class header).
        const rawToolCalls = pending.rawCalls.map(c => ({
          name: c.name || "",
          arguments: JSON.stringify(c.args ?? {}),
        }));
        resolve(finalizeBoardManagerToolCalls(rawToolCalls, fusionMap, undefined, finishReason));
      };

      const onAbort = () => finish("ABORTED");

      const pending: PendingTurn = {
        rawCalls: [],
        fusionMap,
        resolved: false,
        finish,
        hardTimer: setTimeout(() => {
          flowNote("BOARD_MGR", `Live turn timed out (${BM_LIVE_TURN_TIMEOUT_MS}ms) — resolving no_change.`);
          finish("TIMEOUT");
        }, BM_LIVE_TURN_TIMEOUT_MS),
      };
      this.pending = pending;

      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      flowInput("BOARD_MGR", "live_turn", contextMessage);
      this.provider?.sendMessage(contextMessage, "user", true);
    });
  }

  private settlePending(finishReason: string): void {
    this.pending?.finish(finishReason);
  }

  // -------------------------------------------------------------------------
  // Provider callbacks
  // -------------------------------------------------------------------------

  /** `currentProvider` lets each callback ignore events from a provider we've
   *  since torn down (a reconnect races with a late message from the old
   *  socket). */
  private buildCallbacks(currentProvider: () => GeminiLiveProvider): LiveProviderCallbacks {
    const isStale = () => this.provider !== currentProvider();
    return {
      // TEXT parts are not used — the Board Manager speaks only in tool calls.
      onText: () => { /* ignore */ },
      onToolCall: (calls: ToolCall[]) => {
        if (isStale()) return;
        // ALWAYS resolve the open functionCall(s) — even if this turn was
        // already settled or aborted. Skipping the ack leaves a dangling
        // function call in the session that gets the NEXT turn rejected.
        try {
          const acks = calls.map(c => ({
            id: c.id,
            name: c.name || "unknown",
            response: BOARD_MANAGER_TOOL_ACK,
          }));
          if (this.isPreview31) {
            // 3.1 restricts sendClientContent to seeding initial history and
            // closes with 1007 "Precondition check failed" if a tool response
            // arrives that way mid-conversation. Use the protocol-correct
            // functionResponse channel. SILENT keeps it from provoking a new
            // generation turn (no Vertex BLOCKING-tool quirk on the public API).
            this.provider?.sendToolResponse(acks.map(a => ({ ...a, scheduling: "SILENT" as const })));
          } else {
            // Native-audio on Vertex: sendToolResponse triggers a duplicate
            // generation (SILENT ignored for BLOCKING tools), so deliver as a
            // turnComplete:false content part instead (see duplication_root_cause.md).
            this.provider?.sendToolResponseAsContent(acks);
          }
        } catch (err) {
          console.warn("[LiveBoardManagerAgent] tool ack failed:", (err as Error).message);
        }
        const pending = this.pending;
        if (!pending || pending.resolved) return;
        pending.rawCalls.push(...calls);
        // For this discrete request/reply use, the tool call IS the complete
        // output — resolve now. We deliberately do NOT wait for turnComplete:
        // native-audio models (3.1) don't send it after a SILENT-acked tool
        // call (the turn just goes idle), so waiting would always hit the hard
        // timeout. Parallel calls for one turn arrive together in this single
        // onToolCall, so resolving here doesn't truncate them.
        pending.finish("STOP");
      },
      onTurnComplete: () => {
        // IGNORE — same reason as onInterrupted. A native-audio turn's
        // turnComplete fires when its (unused) audio finishes generating,
        // which lands AFTER we've already resolved the turn on its tool call
        // and the NEXT turn has started — resolving on it produces a spurious
        // empty no_change for the fresh turn (the alternating-empty bug). The
        // board result always arrives via onToolCall (no_change included); the
        // hard timeout covers a turn that produces no tool call at all.
      },
      onInterrupted: () => {
        // IGNORE. On native-audio models the server emits `interrupted` when a
        // new turn's input arrives while the PRIOR turn's (unused) audio is
        // still generating. That interrupt belongs to audio we don't consume,
        // and resolving the current pending on it misattributes the prior
        // turn's interrupt to the fresh one — the alternating empty-turn bug.
        // The real result arrives via onToolCall; the hard timeout covers a
        // genuinely dead turn.
      },
      onUsage: (usage: LiveUsage) => {
        // Bill even for stale providers — those tokens were really spent.
        this.onUsage?.(usage);
      },
      onError: (err: Error) => {
        console.error("[LiveBoardManagerAgent] provider error:", err.message);
        if (isStale()) return;
        this.pending?.finish("ERROR");
      },
      onClose: (code?: number, reason?: string) => {
        if (isStale()) return;
        flowNote("BOARD_MGR", `Live session closed (code=${code ?? "?"} reason="${reason ?? ""}")`);
        // A close invalidates the warm session; force a fresh connect next invoke.
        this.connectedKey = null;
        this.pending?.finish("CLOSED");
      },
    };
  }
}

/** Native-audio Live models (Vertex `gemini-live-2.5-flash-native-audio`,
 *  `gemini-3.1-flash-live-preview`, the 2.5 native-audio previews) only emit
 *  AUDIO output and reject responseModality:TEXT. Half-cascade models support
 *  TEXT. Detected by the "native-audio" marker in the id. */
function isNativeAudioModel(model: string): boolean {
  return /native-audio|flash-live-preview/i.test(model);
}

/** Cheap, deterministic 32-bit string hash (djb2). Only used to detect
 *  system-prompt content changes for the reconnect key — not security. */
function cheapHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}
