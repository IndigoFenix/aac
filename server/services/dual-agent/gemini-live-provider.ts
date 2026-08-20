// server/services/dual-agent/gemini-live-provider.ts
// Gemini Live API provider — wraps the @google/genai SDK's Live session.
// Uses native-audio model with function calling. Audio output is discarded (ElevenLabs TTS used).

import { GoogleGenAI, Modality, FunctionResponse, FunctionResponseScheduling, HarmCategory, HarmBlockThreshold } from "@google/genai";
import { vertexClientOptions } from "../providers/vertex-config";
import type { Session, LiveServerMessage, FunctionCall, Tool } from "@google/genai";
import type {
  LiveProvider,
  LiveProviderCallbacks,
  LiveProviderConfig,
  ToolCall,
  ToolResponse,
} from "./live-provider";
import { logLiveSession, runInSessionContext } from "./dual-agent-logger";
import type { LiveUsage } from "./live-provider";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse Gemini's `usageMetadata.promptTokensDetails` /
 * `responseTokensDetails` arrays into our normalized modality breakdown.
 * Returns null when the arrays are missing or empty.
 */
function extractModalityBreakdown(usage: any): LiveUsage["details"] | null {
  const prompt: Array<{ modality?: string; tokenCount?: number }> =
    usage.promptTokensDetails || [];
  const response: Array<{ modality?: string; tokenCount?: number }> =
    usage.responseTokensDetails || [];
  if (prompt.length === 0 && response.length === 0) return null;

  const sumByModality = (
    arr: Array<{ modality?: string; tokenCount?: number }>,
    textOut: { text: number; other: number },
  ) => {
    for (const entry of arr) {
      const count = entry.tokenCount || 0;
      if (entry.modality === "TEXT") textOut.text += count;
      else textOut.other += count;
    }
  };

  const p = { text: 0, other: 0 };
  sumByModality(prompt, p);
  // Response buckets separate TEXT vs AUDIO (images aren't emitted).
  let textOut = 0;
  let audioOut = 0;
  for (const entry of response) {
    const count = entry.tokenCount || 0;
    if (entry.modality === "AUDIO") audioOut += count;
    else textOut += count;
  }

  const cached = usage.cachedContentTokenCount || 0;
  // Thinking tokens bill as output but are reported separately from the
  // response modality buckets — fold them into the text-output bucket.
  const thoughts = usage.thoughtsTokenCount || 0;
  return {
    textInputTokens: p.text,
    nonTextInputTokens: p.other,
    textOutputTokens: textOut + thoughts,
    audioOutputTokens: audioOut,
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
  };
}

// ---------------------------------------------------------------------------
// GeminiLiveProvider
// ---------------------------------------------------------------------------

export class GeminiLiveProvider implements LiveProvider {
  private client: GoogleGenAI;
  private session: Session | null = null;
  private resumptionHandle: string | null = null;
  private config: LiveProviderConfig = { model: "gemini-live-2.5-flash-native-audio" };
  private callbacks: LiveProviderCallbacks;
  private systemPrompt = "";
  private connected = false;

  lastCloseCode: number | null = null;
  lastCloseWasRateLimit = false;
  lastCloseWasSafety = false;
  // Handshake was rejected for auth/permission reasons (HTTP 401/403). Fatal —
  // reconnecting with the same credentials just re-fails, so we give up and
  // surface it instead of spinning the reconnect loop forever.
  lastCloseWasFatalAuth = false;

  // The SDK's live.connect() awaits the WebSocket `onopen` event before
  // resolving (see @google/genai dist .../index.mjs: `await onopenPromise`).
  // On a failed handshake (e.g. Vertex 403) `onopen` NEVER fires, so that
  // await — and therefore our connect() — would hang forever. We guard the
  // connect with a timeout + an onerror-triggered early rejection so a failed
  // handshake rejects connect() promptly instead of leaving the caller stuck.
  private static CONNECT_TIMEOUT_MS = 20_000;
  private onopenFired = false;
  private connectGuardReject: ((e: Error) => void) | null = null;

  // Proactive reconnection timer (reconnect before the 10-min session limit)
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Gemini Live sessions disconnect with 1011 after ~10 min.
  // A GoAway message arrives at ~9 min. Proactively reconnect at 8.5 min.
  private static RECONNECT_INTERVAL_MS = 510_000;

  // Set by close() so onclose handler knows not to auto-reconnect
  private closedIntentionally = false;

  // Track consecutive auto-reconnect attempts so a config-error close
  // (or persistent server-side rejection) can't burn rate-limit cycles
  // forever. Reset on successful setupComplete.
  private consecutiveReconnects = 0;
  private static MAX_CONSECUTIVE_RECONNECTS = 5;

  // Vertex AI does not support the `behavior` parameter on tool declarations
  private useVertexAI = false;

  // Session context for DB-attributed debug logs. Set by the relay after
  // initialize resolves the sessionId — used to re-enter the logger's als
  // context inside the SDK's onmessage callback (which otherwise fires
  // outside our async chain and loses context).
  private debugSessionId: string | null = null;
  private debugMode = false;
  /** Optional agent tag for the three-agent path (Observer / Speaker).
   *  Threaded through runInSessionContext so every server-message and
   *  tool-call log entry the SDK callback emits carries the agent name. */
  private debugAgentLabel: string | undefined;

  /** Bind this provider's onmessage callbacks to a session for DB log capture. */
  setDebugSessionContext(sessionId: string, debugMode: boolean, agentLabel?: string): void {
    this.debugSessionId = sessionId;
    this.debugMode = debugMode;
    this.debugAgentLabel = agentLabel;
  }

  private withSession<T>(fn: () => T): T {
    if (this.debugSessionId) {
      return runInSessionContext(this.debugSessionId, this.debugMode, fn, this.debugAgentLabel);
    }
    return fn();
  }

  /**
   * On gemini-3.1-flash-live-preview, `sendClientContent` is restricted to
   * seeding INITIAL conversation history. Any text update during the live
   * conversation must use `sendRealtimeInput({text})` instead — otherwise
   * the server eventually closes with 1008 ("Operation is not implemented,
   * or supported, or enabled"). This flag flips the wire-level path for
   * sendMessage/sendContextInjection/sendFrameWithPrompt.
   * Source: ai.google.dev/gemini-api/docs/live-api/capabilities and the
   * 3.1 model-specific docs.
   */
  private get isPreview31(): boolean {
    return this.config.model === "gemini-3.1-flash-live-preview";
  }

  constructor(callbacks: LiveProviderCallbacks, useVertexAI = false) {
    // The Vertex decision lives in providers/vertex-config.ts so the HTTP chat
    // provider cannot drift onto a different billing path — which is exactly
    // what happened while this branch existed here and nowhere else.
    const vertex = useVertexAI ? vertexClientOptions() : null;
    if (vertex) {
      console.log(`[GeminiLiveProvider] Using Vertex AI (project=${vertex.project}, location=${vertex.location})`);
      this.useVertexAI = true;
      this.client = new GoogleGenAI(vertex);
    } else {
      this.client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
    }
    this.callbacks = callbacks;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async connect(systemPrompt: string, config: LiveProviderConfig): Promise<void> {
    this.closedIntentionally = false;
    this.lastCloseWasSafety = false;
    this.lastCloseWasFatalAuth = false;
    this.onopenFired = false;
    this.systemPrompt = systemPrompt;
    this.config = config;

    const triggerTokens = config.compressionTriggerTokens ?? 100_000;
    const targetTokens = config.compressionTargetTokens ?? 50_000;

    const isPreview31 = config.model === "gemini-3.1-flash-live-preview";
    logLiveSession(
      "CONNECT_CONFIG",
      `model=${config.model} vertexAI=${this.useVertexAI} responseModality=${config.responseModality} hasTools=${!!config.tools} hasResumptionHandle=${!!this.resumptionHandle} textVia=${isPreview31 ? "sendRealtimeInput" : "sendClientContent"}`,
    );

    // Connect guard: reject if the handshake never completes (no onopen) so a
    // 403/timeout fails fast instead of hanging the caller forever.
    let guardReject: ((e: Error) => void) | null = null;
    const guardPromise = new Promise<never>((_, reject) => { guardReject = reject; });
    this.connectGuardReject = guardReject;
    const guardTimer = setTimeout(() => {
      this.connectGuardReject?.(
        new Error(`Live connect timed out after ${GeminiLiveProvider.CONNECT_TIMEOUT_MS}ms — handshake never completed (no onopen)`),
      );
    }, GeminiLiveProvider.CONNECT_TIMEOUT_MS);
    const clearGuard = () => {
      clearTimeout(guardTimer);
      this.connectGuardReject = null;
    };

    try {
      this.session = await Promise.race([
      this.client.live.connect({
        model: config.model,
        config: {
          // TEXT modality for prefix token mode (no tools), AUDIO for function calling mode (with tools)
          responseModalities: [config.responseModality === "TEXT" ? Modality.TEXT
            : config.responseModality === "AUDIO" ? Modality.AUDIO
            : config.tools && config.tools.length > 0 ? Modality.AUDIO : Modality.TEXT],
          systemInstruction: { parts: [{ text: systemPrompt }] },
          temperature: config.temperature ?? 0.7,
          // Tool declarations for function calling
          // Strip `behavior` from tool declarations — the SDK handles it internally
          // and passing it raw can cause tools to be ignored by some API endpoints.
          ...(config.tools && config.tools.length > 0 ? (() => {
            // Note: toolConfig (with VALIDATED mode) is NOT a valid field on
            // LiveConnectConfig — it's silently dropped by the SDK. VALIDATED
            // mode is only available on the regular generateContent API.
            const adaptedTools = this.adaptToolsForVertex(config.tools as Tool[]);
            if (adaptedTools[0]?.functionDeclarations) {
              const decls = adaptedTools[0].functionDeclarations;
              const sample = decls[0] as any;
              logLiveSession("ADAPTED TOOLS (sent to API)", [
                `Tool count: ${decls.length}, vertexAI: ${this.useVertexAI}`,
                `Tool[0] schema fields: hasParameters=${!!sample.parameters}, hasParametersJsonSchema=${!!sample.parametersJsonSchema}, hasBehavior=${!!sample.behavior}`,
                `Tool[0] full: ${JSON.stringify(decls[0]).substring(0, 800)}`,
              ].join("\n"));
            }
            return { tools: adaptedTools };
          })() : {}),
          sessionResumption: {
            ...(this.resumptionHandle ? { handle: this.resumptionHandle } : {}),
          },
          // Enable output audio transcription so we get text of what the model says
          outputAudioTranscription: {},
          // Enable input audio transcription so we can see what Gemini "hears"
          // from the user (including any echo/noise that might be triggering
          // spontaneous extra turns)
          inputAudioTranscription: {},
          contextWindowCompression: {
            triggerTokens: String(triggerTokens),
            slidingWindow: {
              targetTokens: String(targetTokens),
            },
          },
          // proactiveAudio: lets the model decide not to respond to
          // background chatter, echoes, or input not directed at it.
          // Default ON for Observer-style models that need to stay quiet
          // most of the time. Speaker has it OFF — without a strong
          // positive "respond aloud" bias in the prompt, proactiveAudio
          // makes the model emit empty turns that Vertex flags as
          // MALFORMED_FUNCTION_CALL.
          // 3.1 Preview rejects the `proactivity` field with 1007 — omit there.
          ...(config.model === "gemini-3.1-flash-live-preview"
            ? {}
            : config.proactiveAudio === false
              ? {}
              : { proactivity: { proactiveAudio: true } }),
          // Safety filters disabled — Gemini was rejecting innocuous greetings
          // with RESPONSE_REJECTED. Using BLOCK_NONE rather than OFF: both are
          // "do not block", but BLOCK_NONE is more universally accepted across
          // endpoints. If OFF is rejected as an invalid enum on this endpoint,
          // the API may silently fall back to default thresholds.
          // (cast: SDK's LiveConnectConfig type doesn't expose safetySettings,
          // but the wire protocol accepts it.)
          ...({
            safetySettings: [
              { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
              { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
              { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
              { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
              { category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY, threshold: HarmBlockThreshold.BLOCK_NONE },
            ],
          } as any),
          // Voice selection for native audio output
          ...(config.voiceName ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voiceName } } } } : {}),
        },
        callbacks: {
          onopen: () => {
            this.connected = true;
            this.onopenFired = true;
            console.log("[GeminiLiveProvider] Connected to Gemini Live API");
          },
          onmessage: (msg: LiveServerMessage) => {
            this.withSession(() => {
              // Debug: log raw message keys to understand what the server is sending
              const keys = Object.keys(msg).filter(k => (msg as any)[k] != null);
              if (keys.length > 0 && !keys.every(k => k === "serverContent")) {
                console.log(`[GeminiLiveProvider] Server message keys: ${keys.join(", ")}`);
              }
              // DIAGNOSTIC: Log raw server messages
              if (keys.length > 0) {
                const sc = msg.serverContent;
                const hasParts = !!(sc as any)?.modelTurn?.parts?.length;
                const hasAudio = hasParts && (sc as any).modelTurn.parts.some((p: any) => p.inlineData);
                const hasText = hasParts && (sc as any).modelTurn.parts.some((p: any) => p.text);
                const hasFC = hasParts && (sc as any).modelTurn.parts.some((p: any) => p.functionCall);
                logLiveSession("RAW_MSG", `keys=[${keys.join(",")}] hasParts=${hasParts} hasAudio=${hasAudio} hasText=${hasText} hasFC=${hasFC} toolCall=${!!msg.toolCall} setupComplete=${!!msg.setupComplete}`);
                // Log full message when MALFORMED or when it contains non-standard content
                if ((sc as any)?.turnComplete && (sc as any)?.turnCompleteReason) {
                  logLiveSession("RAW_MSG FULL (abnormal turn)", JSON.stringify(msg, null, 2).substring(0, 2000));
                }
              }
              this.handleServerMessage(msg);
            });
          },
          onerror: (e: ErrorEvent) => {
            const msg = e.message || "WebSocket error";
            console.error("[GeminiLiveProvider] WebSocket error:", msg);
            if (/resource.exhausted|rate.limit|quota|too many requests|overloaded/i.test(msg)) {
              this.lastCloseWasRateLimit = true;
            }
            // HTTP 401/403 on the upgrade ("Unexpected server response: 403") =
            // auth/permission rejection. Fatal — flag it so onclose doesn't loop.
            if (/Unexpected server response: 40[13]\b|\b40[13]\b|forbidden|permission denied|unauthor/i.test(msg)) {
              this.lastCloseWasFatalAuth = true;
            }
            // If the handshake failed before onopen, the SDK's `await onopenPromise`
            // would hang forever — break out of it by rejecting the connect guard.
            if (!this.onopenFired && this.connectGuardReject) {
              this.connectGuardReject(new Error(msg));
            }
            this.callbacks.onError(new Error(msg));
          },
          onclose: (e: CloseEvent) => {
            this.connected = false;
            this.lastCloseCode = e.code;
            const reason = e.reason || "";
            console.log(`[GeminiLiveProvider] Connection closed: code=${e.code} reason=${reason}`);
            logLiveSession("CONNECTION_CLOSED", `code=${e.code} reason="${reason}" intentional=${this.closedIntentionally}`);
            this.clearReconnectTimer();

            const isRateLimit = /resource.exhausted|rate.limit|quota|too many requests|overloaded/i.test(reason);
            this.lastCloseWasRateLimit = isRateLimit;

            // Detect config errors — closes where the server rejected our
            // request shape. Auto-reconnecting on these burns rate-limit
            // cycles forever because the next attempt has the same config.
            // Widened from the original (Invalid JSON / Unknown name) to
            // catch modality / model / parameter mismatches the server
            // surfaces as 1007.
            const isConfigError = e.code === 1007 && /Invalid JSON payload|Unknown name|Cannot find field|not supported|invalid|unsupported/i.test(reason);
            if (isConfigError) {
              console.error(`[GeminiLiveProvider] CONFIG ERROR (not safety): ${reason}`);
              logLiveSession("CONFIG_ERROR", `code=${e.code} reason="${reason}"`);
            }

            const isSafety = !isRateLimit && !isConfigError && /policy.violation|unsafe|blocked|safety/i.test(reason);
            this.lastCloseWasSafety = isSafety;

            this.callbacks.onClose?.(e.code, reason);

            if (isRateLimit) {
              console.warn(`[GeminiLiveProvider] Rate limited — NOT auto-reconnecting. Reason: ${reason}`);
              logLiveSession("RECONNECT_SKIPPED", `rate limited: ${reason}`);
              return;
            }

            // Auth/permission handshake rejection (HTTP 401/403, flagged in
            // onerror). Reconnecting re-fails identically — surface and stop.
            if (this.lastCloseWasFatalAuth) {
              console.warn(`[GeminiLiveProvider] Auth/permission error (handshake rejected) — NOT auto-reconnecting.`);
              logLiveSession("RECONNECT_SKIPPED", `auth error: code=${e.code}`);
              this.callbacks.onError(new Error(`Live API auth/permission error (handshake rejected, code=${e.code})`));
              return;
            }

            // Config errors are non-recoverable without a code change. Don't
            // try to reconnect — surface as a fatal error so the caller can
            // tear down cleanly instead of looping.
            if (isConfigError) {
              console.warn(`[GeminiLiveProvider] Config error — NOT auto-reconnecting (would re-fail with same config).`);
              logLiveSession("RECONNECT_SKIPPED", `config error: ${reason}`);
              this.callbacks.onError(new Error(`Config error from server: ${reason}`));
              return;
            }

            // Max-retry guard — if we've already burned the budget on this
            // run of consecutive failures, give up and surface a fatal error.
            if (this.consecutiveReconnects >= GeminiLiveProvider.MAX_CONSECUTIVE_RECONNECTS) {
              console.warn(`[GeminiLiveProvider] Reconnect budget exhausted (${this.consecutiveReconnects} consecutive failures) — giving up.`);
              logLiveSession("RECONNECT_BUDGET_EXHAUSTED", `attempts=${this.consecutiveReconnects} lastCode=${e.code} lastReason="${reason}"`);
              this.callbacks.onError(new Error(`Reconnect budget exhausted after ${this.consecutiveReconnects} attempts (last close: ${e.code} ${reason})`));
              return;
            }

            // Auto-reconnect on unexpected closes
            if (!this.closedIntentionally && e.code !== 1000) {
              this.consecutiveReconnects += 1;
              const delay = e.code === 1011 ? 1000 : e.code === 1007 ? 2000 : 1000;
              console.log(`[GeminiLiveProvider] Unexpected close (code=${e.code}), reconnecting in ${delay}ms (attempt ${this.consecutiveReconnects}/${GeminiLiveProvider.MAX_CONSECUTIVE_RECONNECTS})...`);
              logLiveSession("RECONNECT_SCHEDULED", `code=${e.code} delayMs=${delay} attempt=${this.consecutiveReconnects}/${GeminiLiveProvider.MAX_CONSECUTIVE_RECONNECTS}`);
              this.callbacks.onReconnecting?.();
              this.scheduleReconnect(delay);
            }
          },
        },
      }),
        guardPromise,
      ]);
      clearGuard();

      this.startReconnectTimer();
      console.log(`[GeminiLiveProvider] Session established, model=${config.model}, vertexAI=${this.useVertexAI}`);
    } catch (err) {
      clearGuard();
      // The handshake never produced a live session. Suppress the onclose
      // auto-reconnect path for the half-open socket — the caller decides what
      // to do with the rejection (the coordinator tears down + notifies the client).
      this.closedIntentionally = true;
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[GeminiLiveProvider] Failed to connect:", error.message);
      this.callbacks.onError(error);
      throw error;
    }
  }

  async reconnect(): Promise<void> {
    this.callbacks.onReconnecting?.();
    logLiveSession("RECONNECT_START", `hasResumption=${!!this.resumptionHandle} attempt=${this.consecutiveReconnects}`);

    if (this.session) {
      try { this.session.close(); } catch { /* ignore */ }
      this.session = null;
    }
    this.connected = false;
    this.clearReconnectTimer();

    if (!this.resumptionHandle) {
      console.warn("[GeminiLiveProvider] No resumption handle — full reconnect");
      logLiveSession("RECONNECT_NO_HANDLE", "starting full reconnect");
      try {
        await this.connect(this.systemPrompt, this.config);
      } catch (err) {
        logLiveSession("RECONNECT_FAILED", `${(err as Error).message}`);
        throw err;
      }
      await this.callbacks.onReconnectFailed?.();
      return;
    }

    console.log("[GeminiLiveProvider] Reconnecting with resumption handle...");
    logLiveSession("RECONNECT_WITH_HANDLE", "attempting session resumption");

    try {
      await this.connect(this.systemPrompt, this.config);
    } catch (err) {
      console.warn("[GeminiLiveProvider] Resumption failed, trying fresh connect:", err);
      logLiveSession("RECONNECT_RESUMPTION_FAILED", `${(err as Error).message} — falling back to fresh connect`);
      this.resumptionHandle = null;
      await this.connect(this.systemPrompt, this.config);
      await this.callbacks.onReconnectFailed?.();
    }
  }

  /**
   * Switch the live session to a NEW system prompt + tool set + compression
   * config WITHOUT losing conversation history. Closes the current session
   * and reconnects using the saved sessionResumption handle, so Vertex
   * resumes the conversation but applies the new config to subsequent turns.
   *
   * Used by the sleep-state profile switch (awake ↔ resting): resting mode
   * swaps in a ~1.5k-token prompt, a 4-tool subset, and a tight compression
   * window; awake mode swaps the full prompt/tools back in.
   *
   * Distinct from reconnect() (same config, just re-establishes the socket)
   * and close() (nulls the handle, ends the conversation).
   */
  async reconnectWithConfig(systemPrompt: string, config: LiveProviderConfig): Promise<void> {
    this.callbacks.onReconnecting?.();
    // Suppress the onclose auto-reconnect path — we're deliberately tearing
    // down to rebuild with new config. connect() flips this back to false.
    this.closedIntentionally = true;
    if (this.session) {
      try { this.session.close(); } catch { /* ignore */ }
      this.session = null;
    }
    this.connected = false;
    this.clearReconnectTimer();
    // Deliberately PRESERVE this.resumptionHandle so the conversation history
    // carries across the profile switch.
    try {
      await this.connect(systemPrompt, config);
    } catch (err) {
      console.warn("[GeminiLiveProvider] Profile-switch resumption failed, trying fresh connect:", err);
      this.resumptionHandle = null;
      await this.connect(systemPrompt, config);
    }
  }

  close(): void {
    this.closedIntentionally = true;
    this.clearReconnectTimer();
    if (this.session) {
      try { this.session.close(); } catch { /* ignore */ }
      this.session = null;
    }
    this.connected = false;
    this.resumptionHandle = null;
    console.log("[GeminiLiveProvider] Session closed");
  }

  get isConnected(): boolean {
    return this.connected && this.session !== null;
  }

  // -------------------------------------------------------------------------
  // Sending data
  // -------------------------------------------------------------------------

  sendFrame(jpegBase64: string, _turnComplete = false): void {
    if (!this.session || !this.connected) return;
    try {
      logLiveSession("CLIENT → sendFrame", `via sendRealtimeInput (video)`);
      // Use sendRealtimeInput for video frames instead of sendClientContent.
      // sendClientContent adds frames to conversation history, which accumulates
      // and breaks function calling (causes MALFORMED_FUNCTION_CALL after context
      // grows). sendRealtimeInput is the correct path: it streams frames without
      // polluting history and is processed incrementally by the model.
      this.session.sendRealtimeInput({
        video: { data: jpegBase64, mimeType: "image/jpeg" } as any,
      });
    } catch (err) {
      console.error("[GeminiLiveProvider] Failed to send frame:", err);
    }
  }

  sendFrameWithPrompt(
    jpegBase64: string,
    prompt: string,
    extraImages?: Array<{ data: string; mimeType: string; label?: string }>,
  ): void {
    if (!this.session || !this.connected) return;
    try {
      if (this.isPreview31) {
        // 3.1: split into individual realtime inputs. Order: frames first,
        // then prompt last (text triggers the turn).
        logLiveSession(
          "CLIENT → sendRealtimeInput(video+text)",
          `prompt="${prompt.substring(0, 80)}" extraImages=${extraImages?.length ?? 0}`,
        );
        this.session.sendRealtimeInput({
          video: { data: jpegBase64, mimeType: "image/jpeg" } as any,
        });
        if (extraImages) {
          for (const img of extraImages) {
            if (img.label) {
              this.session.sendRealtimeInput({ text: img.label });
            }
            this.session.sendRealtimeInput({
              video: { data: img.data, mimeType: img.mimeType } as any,
            });
          }
        }
        this.session.sendRealtimeInput({ text: prompt });
        return;
      }

      const parts: any[] = [
        { inlineData: { data: jpegBase64, mimeType: "image/jpeg" } },
      ];
      if (extraImages) {
        for (const img of extraImages) {
          if (img.label) parts.push({ text: img.label });
          parts.push({ inlineData: { data: img.data, mimeType: img.mimeType } });
        }
      }
      parts.push({ text: prompt });
      logLiveSession("CLIENT → sendFrameWithPrompt", `prompt="${prompt.substring(0, 80)}" extraImages=${extraImages?.length ?? 0} turnComplete=true`);
      this.session.sendClientContent({
        turns: [{ role: "user", parts }],
        turnComplete: true,
      });
    } catch (err) {
      console.error("[GeminiLiveProvider] Failed to send frame with prompt:", err);
    }
  }

  sendAudioWithPrompt(audioBase64: string, mimeType: string, prompt: string): void {
    if (!this.session || !this.connected) return;
    try {
      if (this.isPreview31) {
        // 3.1: audio as realtime input, then the prompt text (triggers the turn).
        logLiveSession("CLIENT → sendRealtimeInput(audio+text)", `prompt="${prompt.substring(0, 80)}"`);
        this.session.sendRealtimeInput({ audio: { data: audioBase64, mimeType } });
        this.session.sendRealtimeInput({ text: prompt });
        return;
      }
      logLiveSession("CLIENT → sendAudioWithPrompt", `mime=${mimeType} prompt="${prompt.substring(0, 80)}" turnComplete=true`);
      this.session.sendClientContent({
        turns: [{ role: "user", parts: [{ inlineData: { data: audioBase64, mimeType } }, { text: prompt }] }],
        turnComplete: true,
      });
    } catch (err) {
      console.error("[GeminiLiveProvider] Failed to send audio with prompt:", err);
    }
  }

  sendAudio(audioBase64: string, mimeType = "audio/pcm;rate=16000"): void {
    if (!this.session || !this.connected) return;
    try {
      this.session.sendRealtimeInput({
        audio: { data: audioBase64, mimeType },
      });
    } catch (err) {
      console.error("[GeminiLiveProvider] Failed to send audio:", err);
    }
  }

  /**
   * Signal end-of-activity to the model via sendRealtimeInput.
   * Native audio models with automaticActivityDetection use VAD to determine
   * when the user is done speaking. When input is text-only (via sendClientContent),
   * the VAD never fires. Sending activityEnd explicitly tells the model
   * "the user is done, respond now."
   */
  sendAudioNudge(): void {
    if (!this.session || !this.connected) return;
    try {
      this.session.sendRealtimeInput({ activityEnd: {} });
      logLiveSession("ACTIVITY_END", `Sent activityEnd to trigger model response after text input`);
    } catch (err) {
      console.error("[GeminiLiveProvider] Failed to send activityEnd:", err);
    }
  }

  sendMessage(
    text: string,
    role: "user" | "model" = "user",
    turnComplete = true,
    opts: { interrupt?: boolean } = {},
  ): void {
    if (!this.session || !this.connected) return;
    const interrupt = !!opts.interrupt;
    try {
      if (this.isPreview31) {
        // 3.1: ALL in-conversation text goes via sendRealtimeInput, regardless
        // of whether we're trying to interrupt. The 3.1 docs explicitly
        // restrict sendClientContent to "seeding initial context history" and
        // empirically reject in-conversation sendClientContent with 1008
        // ("Operation is not implemented, or supported, or enabled") — even
        // when used as an interrupt. There is no clean text-interrupt path on
        // 3.1; the new text input gets delivered and the model handles
        // sequencing on its end. This means the user may hear the model
        // finish its current sentence before responding to the new press.
        if (role !== "user") {
          // sendRealtimeInput has no role concept; model-role text isn't
          // supported on 3.1's realtime text path.
          return;
        }
        logLiveSession("CLIENT → sendRealtimeInput(text)", text.substring(0, 200));
        this.session.sendRealtimeInput({ text });
        return;
      }

      // 2.5 and other models: sendClientContent works for everything,
      // including in-conversation text and interrupts.
      const payload = { turns: [{ role, parts: [{ text }] }], turnComplete };
      logLiveSession(
        interrupt ? "CLIENT → sendClientContent (interrupt)" : "CLIENT → sendMessage",
        JSON.stringify(payload, null, 2),
      );
      this.session.sendClientContent(payload);
    } catch (err) {
      console.error("[GeminiLiveProvider] Failed to send message:", err);
    }
  }

  sendContextInjection(text: string): void {
    if (!this.session || !this.connected) return;
    // No structural prefix on the wire. The native-audio Speaker was
    // voicing the literal "[SYSTEM CONTEXT UPDATE]" tag aloud — same
    // failure mode as the earlier [GUESSING STATE] echo. Callers already
    // supply their own framing tag ([CONTEXT], [MODE], [BUTTON PRESS to
    // YOU], etc.), and `turnComplete: false` is what tells the model
    // "this is context, not a turn to reply to." The wrap was redundant.
    try {
      if (this.isPreview31) {
        // 3.1: route text through sendRealtimeInput. There's no
        // turnComplete=false equivalent — every text input triggers a turn.
        logLiveSession("CLIENT → sendRealtimeInput(text) [context]", text.substring(0, 200));
        this.session.sendRealtimeInput({ text });
      } else {
        logLiveSession("CLIENT → sendContextInjection", `turnComplete=false text="${text.substring(0, 120)}"`);
        this.session.sendClientContent({
          turns: [{ role: "user", parts: [{ text }] }],
          turnComplete: false,
        });
      }
    } catch (err) {
      console.error("[GeminiLiveProvider] Failed to send context injection:", err);
    }
  }

  sendConversationHistory(turns: Array<{ role: "user" | "model"; text: string }>): void {
    if (!this.session || !this.connected) return;
    try {
      const contents = turns.map(t => ({
        role: t.role,
        parts: [{ text: t.text }],
      }));
      // sendClientContent with turnComplete=false IS the correct path for
      // seeding initial history on 3.1 (this is exactly what the docs say
      // sendClientContent is restricted to).
      logLiveSession("CLIENT → sendConversationHistory", `turns=${turns.length}`);
      this.session.sendClientContent({
        turns: contents,
        turnComplete: false,
      });
    } catch (err) {
      console.error("[GeminiLiveProvider] Failed to send conversation history:", err);
    }
  }

  sendToolResponse(responses: ToolResponse[]): void {
    if (!this.session || !this.connected) return;
    try {
      // Convert from provider-agnostic ToolResponse to Gemini FunctionResponse
      // scheduling is a top-level field on FunctionResponse, serialized via JSON.stringify
      const fnResponses: FunctionResponse[] = responses.map(r => {
        const fr = Object.assign(new FunctionResponse(), {
          id: r.id,
          name: r.name,
          response: r.response,
        });
        if (r.scheduling === "SILENT") {
          (fr as any).scheduling = FunctionResponseScheduling.SILENT;
        } else if (r.scheduling === "WHEN_IDLE") {
          (fr as any).scheduling = FunctionResponseScheduling.WHEN_IDLE;
        }
        return fr;
      });
      logLiveSession("CLIENT → sendToolResponse", JSON.stringify(fnResponses, null, 2));
      this.session.sendToolResponse({ functionResponses: fnResponses });
    } catch (err) {
      console.error("[GeminiLiveProvider] Failed to send tool response:", err);
    }
  }

  /**
   * Deliver tool responses as protocol-correct functionResponse parts wrapped
   * in a Content with role="user", via sendClientContent(turnComplete=false).
   *
   * Why this exists:
   *   - sendToolResponse() is the "correct" path, but on Vertex Live the SDK
   *     forbids `behavior: NON_BLOCKING` on tool declarations, so all tools
   *     are BLOCKING. For BLOCKING tools `scheduling: SILENT` is silently
   *     ignored, so every sendToolResponse triggers a new turn — that's the
   *     duplication bug we hit earlier (see duplication_root_cause.md).
   *   - sendContextInjection() avoids the new turn, but it sends free text
   *     that does NOT resolve the open functionCall in the model's state →
   *     RESPONSE_REJECTED on the next generation because the protocol is
   *     malformed.
   *   - sendClientContent with proper functionResponse parts and
   *     turnComplete=false closes the loop: the model gets a structured
   *     response that resolves its functionCall, AND no new turn is
   *     generated (turnComplete:false suppresses generation).
   *
   * The SDK's tLiveClientContent serializer accepts arbitrary parts inside
   * `turns`, including functionResponse parts — verified in
   * @google/genai/dist/node/index.mjs.
   */
  sendToolResponseAsContent(responses: ToolResponse[]): void {
    if (!this.session || !this.connected) return;
    if (responses.length === 0) return;
    try {
      const parts = responses.map(r => ({
        functionResponse: {
          id: r.id,
          name: r.name,
          response: r.response,
        },
      }));
      logLiveSession(
        "CLIENT → sendToolResponseAsContent",
        `count=${responses.length} names=[${responses.map(r => r.name).join(", ")}] turnComplete=false`,
      );
      this.session.sendClientContent({
        turns: [{ role: "user", parts }],
        turnComplete: false,
      });
    } catch (err) {
      console.error("[GeminiLiveProvider] Failed to send tool response as content:", err);
    }
  }

  // -------------------------------------------------------------------------
  // Server message handling
  // -------------------------------------------------------------------------

  private handleServerMessage(msg: LiveServerMessage): void {
    if (msg.setupComplete) {
      console.log("[GeminiLiveProvider] Setup complete — ready to send data");
      logLiveSession("SETUP_COMPLETE", `connected=${this.connected} timestamp=${Date.now()}`);
      // A fully-set-up session resets the reconnect-retry counter so a
      // brief network blip later doesn't count toward the cap.
      this.consecutiveReconnects = 0;
      this.callbacks.onReady?.();
      return;
    }

    if (msg.sessionResumptionUpdate) {
      const update = msg.sessionResumptionUpdate;
      if (update.newHandle) {
        this.resumptionHandle = update.newHandle;
      }
      return;
    }

    if (msg.goAway) {
      console.log("[GeminiLiveProvider] Received goAway — scheduling reconnect");
      this.callbacks.onGoAway?.();
      this.scheduleReconnect(0);
      return;
    }

    if (msg.usageMetadata) {
      const usage = msg.usageMetadata as any;
      const promptTokens =
        usage.promptTokenCount ?? usage.inputTokens ?? 0;
      const completionTokens =
        // Gemini Live reports response tokens as `responseTokenCount`; the
        // historical field name on non-Live Gemini is `candidatesTokenCount`.
        // Thinking tokens bill as output and are reported separately.
        (usage.responseTokenCount ?? usage.candidatesTokenCount ?? 0)
        + (usage.thoughtsTokenCount ?? 0);

      // Modality breakdown is optional — older sessions may not include it.
      const details = extractModalityBreakdown(usage);

      this.callbacks.onUsage?.({
        promptTokens,
        completionTokens,
        ...(details ? { details } : {}),
      });
    }

    // Tool call — normalize FunctionCall[] to ToolCall[]
    if (msg.toolCall?.functionCalls) {
      // Log the full raw toolCall object so malformed calls are visible
      logLiveSession(`SERVER → toolCall (raw)`, JSON.stringify(msg.toolCall, null, 2));
      const normalized: ToolCall[] = msg.toolCall.functionCalls.map((fc: FunctionCall) => ({
        id: fc.id || "",
        name: fc.name || "unknown",
        args: (fc.args || {}) as Record<string, any>,
      }));
      this.callbacks.onToolCall?.(normalized);
    }

    if (msg.toolCallCancellation?.ids) {
      logLiveSession(`SERVER → toolCallCancellation`, `ids=[${msg.toolCallCancellation.ids.join(", ")}]`);
      this.callbacks.onToolCallCancellation?.(msg.toolCallCancellation.ids);
    }

    if (msg.serverContent) {
      const content = msg.serverContent;

      // Compact event logging for the session log
      const events: string[] = [];
      if (content.modelTurn?.parts) {
        const partSummary = content.modelTurn.parts.map((p: any) => {
          if (p.text) return `text(${p.text.length}ch)`;
          if (p.inlineData) return `audio(${p.inlineData.mimeType})`;
          if (p.functionCall) return `fc(${p.functionCall.name})`;
          return `?(${Object.keys(p).join(",")})`;
        }).join(", ");
        events.push(`parts=[${partSummary}]`);
      }
      if (content.turnComplete) events.push("TURN_COMPLETE");
      if (content.interrupted) events.push("INTERRUPTED");
      if ((content as any).outputTranscription) {
        const txText = (content as any).outputTranscription.text || "(empty)";
        events.push(`outputTranscription("${txText.substring(0, 100)}")`);
      }
      if ((content as any).inputTranscription) {
        const txText = (content as any).inputTranscription.text || "(empty)";
        events.push(`inputTranscription("${txText.substring(0, 100)}")`);
        logLiveSession("GEMINI ← inputTranscription", `Gemini heard from user: "${txText}"`);
        // High-signal flow log: tag with the agent label so we know
        // which Live session "heard" this audio. Observer is the only
        // mic-receiving agent in the three-agent path, but tagging
        // future-proofs against changes.
        if (this.debugAgentLabel) {
          // Dynamic import to avoid a circular load (agent-flow-logger
          // currently has no deps on this provider, but staying defensive).
          import("./agent-flow-logger").then(m => {
            m.flowInput(
              this.debugAgentLabel as any,
              "gemini_input_transcript",
              txText,
            );
          }).catch(() => { /* ignore */ });
        }
      }
      if ((content as any).generationComplete) events.push("generationComplete");
      if (events.length > 0) {
        logLiveSession(`SERVER → serverContent`, events.join(" | "));
        // Log raw content but strip large audio data to avoid filling the log
        const stripped = JSON.stringify(content, (key, val) =>
          key === "data" && typeof val === "string" && val.length > 200 ? `[${val.length} chars]` : val
        );
        logLiveSession(`SERVER → RAW serverContent`, stripped);
      }

      if (content.modelTurn?.parts) {
        // Log any function call parts (including potentially malformed ones)
        for (const part of content.modelTurn.parts) {
          if ((part as any).functionCall) {
            logLiveSession("SERVER → functionCall in modelTurn", JSON.stringify((part as any).functionCall, null, 2));
          }
        }
        for (const part of content.modelTurn.parts) {
          if (part.text) {
            this.callbacks.onText(part.text);
          }
          if (part.inlineData?.data && part.inlineData.mimeType?.startsWith("audio/")) {
            this.callbacks.onAudioData?.({
              mimeType: part.inlineData.mimeType,
              data: part.inlineData.data,
            });
          }
        }
      } else if (content.modelTurn) {
        logLiveSession("SERVER → modelTurn", "modelTurn present but no parts");
      }

      // Output transcription — text of what the model said (for logging/display).
      // On gemini-3.1-flash-live-preview, a phantom outputTranscription arrives
      // after function calls, echoing the tool's string argument with no audio
      // and no audioOutputTokens. On 3.1, real speech transcriptions arrive
      // alongside an audio part in the same serverContent — so we can gate on
      // that. On 2.5, transcriptions arrive in their OWN serverContent messages
      // (no audio part in the same message), so the gate would suppress all
      // text. Apply the gate for 3.1 only.
      if ((content as any).outputTranscription?.text) {
        const transcriptText = (content as any).outputTranscription.text;
        if (this.isPreview31) {
          const hasAudioPart = !!content.modelTurn?.parts?.some(
            (p: any) => p.inlineData?.mimeType?.startsWith("audio/"),
          );
          if (hasAudioPart) {
            this.callbacks.onOutputTranscription?.(transcriptText);
          } else {
            logLiveSession(
              "SERVER → outputTranscription (3.1 phantom, no audio)",
              transcriptText,
            );
          }
        } else {
          this.callbacks.onOutputTranscription?.(transcriptText);
        }
      }
      // `outputTranscription.finished: true` marks the end of the text
      // portion of the model's turn. Audio chunks may still follow, but
      // the transcript is now complete. Downstream consumers (BoardManager)
      // use this as the "full transcript available" signal — much earlier
      // than turnComplete (which waits for all audio to deliver).
      if ((content as any).outputTranscription?.finished === true) {
        this.callbacks.onOutputTranscriptionFinished?.();
      }

      if (content.turnComplete) {
        const turnReason = (content as any).turnCompleteReason as string | undefined;
        logLiveSession("SERVER → TURN_COMPLETE", `reason=${turnReason || "normal"}`);
        if (turnReason && turnReason !== "STOP" && turnReason !== "RESPONSE_REJECTED") {
          // Abnormal turn end (e.g. MALFORMED_FUNCTION_CALL) — log full message for debugging
          logLiveSession("ABNORMAL TURN_COMPLETE (full msg)", JSON.stringify(msg, null, 2).substring(0, 4000));
        }
        Promise.resolve(this.callbacks.onTurnComplete(turnReason)).catch(err => {
          console.error("[GeminiLiveProvider] onTurnComplete callback error:", (err as Error).message);
          this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
        });
      }

      if (content.interrupted) {
        logLiveSession("SERVER → INTERRUPTED", "(dispatching to relay)");
        Promise.resolve(this.callbacks.onInterrupted()).catch(err => {
          console.error("[GeminiLiveProvider] onInterrupted callback error:", (err as Error).message);
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Reconnection management
  // -------------------------------------------------------------------------

  private startReconnectTimer(): void {
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      if (this.connected) {
        console.log("[GeminiLiveProvider] Proactive reconnect (approaching session limit)");
        this.reconnect().catch(err => {
          console.error("[GeminiLiveProvider] Proactive reconnect failed:", err);
        });
      }
    }, GeminiLiveProvider.RECONNECT_INTERVAL_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(delayMs: number): void {
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnect().catch(err => {
        console.error("[GeminiLiveProvider] Scheduled reconnect failed:", err);
      });
    }, delayMs);
  }

  /**
   * Adapt tool declarations for Vertex AI Live API:
   * - Strip `behavior` (Google AI Studio only, throws on Vertex AI)
   * - Keep `parametersJsonSchema` as-is (the SDK README example uses this format
   *   with lowercase JSON Schema types, and the SDK passes it through unchanged
   *   to the live WebSocket).
   */
  private adaptToolsForVertex(tools: Tool[]): Tool[] {
    return tools.map(tool => {
      if (!tool.functionDeclarations) return tool;
      return {
        ...tool,
        functionDeclarations: tool.functionDeclarations.map(fd => {
          const { behavior, ...rest } = fd as any;
          return rest;
        }),
      };
    });
  }
}
