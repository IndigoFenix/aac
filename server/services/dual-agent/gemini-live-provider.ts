// server/services/dual-agent/gemini-live-provider.ts
// Gemini Live API provider — wraps the @google/genai SDK's Live session.
// Uses native-audio model with function calling. Audio output is discarded (ElevenLabs TTS used).

import { GoogleGenAI, Modality, FunctionResponse, FunctionResponseScheduling, ActivityHandling } from "@google/genai";
import type { Session, LiveServerMessage, FunctionCall, Tool } from "@google/genai";
import type {
  LiveProvider,
  LiveProviderCallbacks,
  LiveProviderConfig,
  ToolCall,
  ToolResponse,
} from "./live-provider";
import { logLiveSession } from "./dual-agent-logger";

// ---------------------------------------------------------------------------
// GeminiLiveProvider
// ---------------------------------------------------------------------------

export class GeminiLiveProvider implements LiveProvider {
  private client: GoogleGenAI;
  private session: Session | null = null;
  private resumptionHandle: string | null = null;
  private config: LiveProviderConfig = { model: "gemini-2.5-flash-native-audio-preview-12-2025" };
  private callbacks: LiveProviderCallbacks;
  private systemPrompt = "";
  private connected = false;

  lastCloseCode: number | null = null;
  lastCloseWasRateLimit = false;
  lastCloseWasSafety = false;

  // Proactive reconnection timer (reconnect before the 10-min session limit)
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Gemini Live sessions disconnect with 1011 after ~10 min.
  // A GoAway message arrives at ~9 min. Proactively reconnect at 8.5 min.
  private static RECONNECT_INTERVAL_MS = 510_000;

  // Set by close() so onclose handler knows not to auto-reconnect
  private closedIntentionally = false;

  // Vertex AI does not support the `behavior` parameter on tool declarations
  private useVertexAI = false;

  constructor(callbacks: LiveProviderCallbacks, useVertexAI = false) {
    if (useVertexAI) {
      const project = process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || "";
      const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
      console.log(`[GeminiLiveProvider] Using Vertex AI (project=${project}, location=${location})`);
      this.useVertexAI = true;

      // Parse inline service account credentials if available
      const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
      const googleAuthOptions = credentialsJson
        ? { credentials: JSON.parse(credentialsJson) }
        : undefined; // Falls back to ADC (GOOGLE_APPLICATION_CREDENTIALS file or gcloud auth)

      this.client = new GoogleGenAI({
        vertexai: true,
        project,
        location,
        ...(googleAuthOptions ? { googleAuthOptions } : {}),
      });
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
    this.systemPrompt = systemPrompt;
    this.config = config;

    const triggerTokens = config.compressionTriggerTokens ?? 100_000;
    const targetTokens = config.compressionTargetTokens ?? 50_000;

    try {
      this.session = await this.client.live.connect({
        model: config.model,
        config: {
          // TEXT modality for prefix token mode (no tools), AUDIO for function calling mode (with tools)
          responseModalities: [config.responseModality === "TEXT" ? Modality.TEXT
            : config.responseModality === "AUDIO" ? Modality.AUDIO
            : config.tools ? Modality.AUDIO : Modality.TEXT],
          systemInstruction: { parts: [{ text: systemPrompt }] },
          temperature: config.temperature ?? 0.7,
          // Tool declarations for function calling
          // Vertex AI does not support the `behavior` parameter — strip it
          ...(config.tools ? (() => {
            const adaptedTools = (this.useVertexAI ? this.stripBehavior(config.tools as Tool[]) : config.tools) as Tool[];
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
          contextWindowCompression: {
            triggerTokens: String(triggerTokens),
            slidingWindow: {
              targetTokens: String(targetTokens),
            },
          },
          // Realtime input config: prevent audio VAD from interrupting tool call turns.
          // Without this, background noise or TTS echo triggers VAD mid-turn, causing
          // the model to start new turns and repeat the same tool calls.
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
              silenceDurationMs: 2000,   // Wait 2s of silence before end-of-speech
              prefixPaddingMs: 500,      // 500ms of speech required before start-of-speech
            },
            activityHandling: ActivityHandling.NO_INTERRUPTION,
          },
          // Native audio features (from config)
          ...(config.enableAffectiveDialog ? { enableAffectiveDialog: true } : {}),
          ...(config.proactiveAudio !== undefined ? { proactivity: { proactiveAudio: config.proactiveAudio } } : {}),
          // Voice selection for native audio output
          ...(config.voiceName ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voiceName } } } } : {}),
        },
        callbacks: {
          onopen: () => {
            this.connected = true;
            console.log("[GeminiLiveProvider] Connected to Gemini Live API");
          },
          onmessage: (msg: LiveServerMessage) => {
            // Debug: log raw message keys to understand what the server is sending
            const keys = Object.keys(msg).filter(k => (msg as any)[k] != null);
            if (keys.length > 0 && !keys.every(k => k === "serverContent")) {
              console.log(`[GeminiLiveProvider] Server message keys: ${keys.join(", ")}`);
            }
            this.handleServerMessage(msg);
          },
          onerror: (e: ErrorEvent) => {
            const msg = e.message || "WebSocket error";
            console.error("[GeminiLiveProvider] WebSocket error:", msg);
            if (/resource.exhausted|rate.limit|quota|too many requests|overloaded/i.test(msg)) {
              this.lastCloseWasRateLimit = true;
            }
            this.callbacks.onError(new Error(msg));
          },
          onclose: (e: CloseEvent) => {
            this.connected = false;
            this.lastCloseCode = e.code;
            const reason = e.reason || "";
            console.log(`[GeminiLiveProvider] Connection closed: code=${e.code} reason=${reason}`);
            this.clearReconnectTimer();

            const isRateLimit = /resource.exhausted|rate.limit|quota|too many requests|overloaded/i.test(reason);
            this.lastCloseWasRateLimit = isRateLimit;

            const isConfigError = e.code === 1007 && /Invalid JSON payload|Unknown name|Cannot find field/i.test(reason);
            if (isConfigError) {
              console.error(`[GeminiLiveProvider] CONFIG ERROR (not safety): ${reason}`);
            }

            const isSafety = !isRateLimit && !isConfigError && /policy.violation|unsafe|blocked|safety/i.test(reason);
            this.lastCloseWasSafety = isSafety;

            this.callbacks.onClose?.(e.code, reason);

            if (isRateLimit) {
              console.warn(`[GeminiLiveProvider] Rate limited — NOT auto-reconnecting. Reason: ${reason}`);
              return;
            }

            // Auto-reconnect on unexpected closes
            if (!this.closedIntentionally && e.code !== 1000) {
              const delay = e.code === 1011 ? 1000 : e.code === 1007 ? 2000 : 1000;
              console.log(`[GeminiLiveProvider] Unexpected close (code=${e.code}), reconnecting in ${delay}ms...`);
              this.callbacks.onReconnecting?.();
              this.scheduleReconnect(delay);
            }
          },
        },
      });

      this.startReconnectTimer();
      console.log(`[GeminiLiveProvider] Session established, model=${config.model}`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[GeminiLiveProvider] Failed to connect:", error.message);
      this.callbacks.onError(error);
      throw error;
    }
  }

  async reconnect(): Promise<void> {
    this.callbacks.onReconnecting?.();

    if (this.session) {
      try { this.session.close(); } catch { /* ignore */ }
      this.session = null;
    }
    this.connected = false;
    this.clearReconnectTimer();

    if (!this.resumptionHandle) {
      console.warn("[GeminiLiveProvider] No resumption handle — full reconnect");
      await this.connect(this.systemPrompt, this.config);
      await this.callbacks.onReconnectFailed?.();
      return;
    }

    console.log("[GeminiLiveProvider] Reconnecting with resumption handle...");

    try {
      await this.connect(this.systemPrompt, this.config);
    } catch (err) {
      console.warn("[GeminiLiveProvider] Resumption failed, trying fresh connect:", err);
      this.resumptionHandle = null;
      await this.connect(this.systemPrompt, this.config);
      await this.callbacks.onReconnectFailed?.();
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

  sendFrame(jpegBase64: string, turnComplete = false): void {
    if (!this.session || !this.connected) return;
    try {
      logLiveSession("CLIENT → sendFrame", `turnComplete=${turnComplete}`);
      this.session.sendClientContent({
        turns: [{
          role: "user",
          parts: [{ inlineData: { data: jpegBase64, mimeType: "image/jpeg" } }],
        }],
        turnComplete,
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

  sendMessage(text: string, role: "user" | "model" = "user", turnComplete = true): void {
    if (!this.session || !this.connected) return;
    try {
      logLiveSession("CLIENT → sendMessage", `role=${role} turnComplete=${turnComplete} text="${text.substring(0, 120)}"`);
      this.session.sendClientContent({
        turns: [{ role, parts: [{ text }] }],
        turnComplete,
      });
    } catch (err) {
      console.error("[GeminiLiveProvider] Failed to send message:", err);
    }
  }

  sendContextInjection(text: string): void {
    if (!this.session || !this.connected) return;
    try {
      logLiveSession("CLIENT → sendContextInjection", `turnComplete=false text="${text.substring(0, 120)}"`);
      this.session.sendClientContent({
        turns: [{ role: "user", parts: [{ text: `[SYSTEM CONTEXT UPDATE]\n${text}` }] }],
        turnComplete: false,
      });
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
      const summary = responses.map(r => `${r.name}(${r.scheduling || "default"}): ${JSON.stringify(r.response).substring(0, 80)}`).join(" | ");
      logLiveSession("CLIENT → sendToolResponse", summary);
      this.session.sendToolResponse({ functionResponses: fnResponses });
    } catch (err) {
      console.error("[GeminiLiveProvider] Failed to send tool response:", err);
    }
  }

  // -------------------------------------------------------------------------
  // Server message handling
  // -------------------------------------------------------------------------

  private handleServerMessage(msg: LiveServerMessage): void {
    if (msg.setupComplete) {
      console.log("[GeminiLiveProvider] Setup complete — ready to send data");
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
      const usage = msg.usageMetadata;
      this.callbacks.onUsage?.({
        promptTokens: (usage as any).promptTokenCount || 0,
        completionTokens: (usage as any).candidatesTokenCount || 0,
      });
    }

    // Tool call — normalize FunctionCall[] to ToolCall[]
    if (msg.toolCall?.functionCalls) {
      const names = msg.toolCall.functionCalls.map(fc => fc.name).join(", ");
      logLiveSession(`SERVER → toolCall`, `functions=[${names}] ids=[${msg.toolCall.functionCalls.map(fc => fc.id).join(", ")}]`);
      for (const fc of msg.toolCall.functionCalls) {
        logLiveSession(`RAW FUNCTION CALL: ${fc.name}`, JSON.stringify(fc.args, null, 2));
      }
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
      if ((content as any).generationComplete) events.push("generationComplete");
      if (events.length > 0) {
        logLiveSession(`SERVER → serverContent`, events.join(" | "));
      }

      if (content.modelTurn?.parts) {
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

      // Output transcription — text of what the model said (for logging/display)
      if ((content as any).outputTranscription?.text) {
        this.callbacks.onOutputTranscription?.((content as any).outputTranscription.text);
      }

      if (content.turnComplete) {
        logLiveSession("SERVER → TURN_COMPLETE", "(dispatching to relay)");
        Promise.resolve(this.callbacks.onTurnComplete()).catch(err => {
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
   * Adapt tool declarations for Vertex AI:
   * - Strip `behavior` (Google AI Studio only, not supported on Vertex AI)
   * Keep `parametersJsonSchema` as-is — the SDK handles serialization for Vertex AI.
   * Without `behavior`, all function calls default to blocking (sequential execution).
   */
  private stripBehavior(tools: Tool[]): Tool[] {
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
