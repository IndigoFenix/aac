// server/services/dual-agent/live-session.ts
// Manages a persistent Gemini Live API WebSocket session for real-time AAC interaction.
// Uses TEXT response modality to preserve the prefix token system and ElevenLabs TTS.

import { GoogleGenAI, Modality } from "@google/genai";
import type { Session, LiveServerMessage } from "@google/genai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LiveSessionConfig {
  model: string;                  // e.g. "gemini-2.0-flash-exp-image-generation"
  temperature?: number;           // default 0.7
  maxOutputTokens?: number;       // default 500
  /** Token threshold that triggers context window compression */
  compressionTriggerTokens?: number;  // default 100000
  /** Target token count after compression */
  compressionTargetTokens?: number;   // default 50000
}

export interface LiveSessionCallbacks {
  /** Incremental text from the model (prefix-token chunks) */
  onText: (text: string) => void;
  /** Model finished its turn */
  onTurnComplete: () => void;
  /** Model was interrupted by new user input */
  onInterrupted: () => void;
  /** Usage metadata from the model */
  onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void;
  /** Session is about to disconnect (goAway) — reconnect soon */
  onGoAway?: () => void;
  /** Session setup completed — ready to send data */
  onReady?: () => void;
  /** Connection error */
  onError: (error: Error) => void;
  /** Connection closed (code + reason from WebSocket close event) */
  onClose?: (code?: number, reason?: string) => void;
  /** Input transcription (if audio is sent and transcription is enabled) */
  onInputTranscription?: (text: string) => void;
  /** Called when resumption-handle reconnect fails and a fresh session was created.
   *  The relay should reload conversation history from DB and send it to the new session. */
  onReconnectFailed?: () => Promise<void>;
}

// Safety settings — all OFF, matching gemini-chat.ts
const SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT" as const, threshold: "OFF" as const },
  { category: "HARM_CATEGORY_HATE_SPEECH" as const, threshold: "OFF" as const },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT" as const, threshold: "OFF" as const },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT" as const, threshold: "OFF" as const },
];

// ---------------------------------------------------------------------------
// GeminiLiveSession
// ---------------------------------------------------------------------------

export class GeminiLiveSession {
  private client: GoogleGenAI;
  private session: Session | null = null;
  private resumptionHandle: string | null = null;
  private config: LiveSessionConfig;
  private callbacks: LiveSessionCallbacks;
  private systemPrompt: string = "";
  private connected = false;

  // Proactive reconnection timer (reconnect before the 2-min video limit)
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private static RECONNECT_INTERVAL_MS = 90_000; // 90s — well before 2-min limit

  // Set by close() so onclose handler knows not to auto-reconnect
  private closedIntentionally = false;

  constructor(callbacks: LiveSessionCallbacks) {
    this.client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
    this.callbacks = callbacks;
    this.config = { model: "gemini-2.0-flash-exp-image-generation" };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Open a new Gemini Live session with the given system prompt and config.
   */
  async connect(systemPrompt: string, config: LiveSessionConfig): Promise<void> {
    this.closedIntentionally = false;
    this.systemPrompt = systemPrompt;
    this.config = config;

    const triggerTokens = config.compressionTriggerTokens ?? 100_000;
    const targetTokens = config.compressionTargetTokens ?? 50_000;

    try {
      this.session = await this.client.live.connect({
        model: config.model,
        config: {
          responseModalities: [Modality.TEXT],
          systemInstruction: { parts: [{ text: systemPrompt }] },
          temperature: config.temperature ?? 0.7,
          // Safety settings not typed on LiveConnectConfig, but accepted by the API
          ...(({ safetySettings: SAFETY_SETTINGS }) as any),
          sessionResumption: {
            // First connect — no handle yet
            ...(this.resumptionHandle ? { handle: this.resumptionHandle } : {}),
          },
          // Enable built-in audio transcription (Gemini returns inputTranscription events)
          inputAudioTranscription: {},
          contextWindowCompression: {
            triggerTokens: String(triggerTokens),
            slidingWindow: {
              targetTokens: String(targetTokens),
            },
          },
        },
        callbacks: {
          onopen: () => {
            this.connected = true;
            console.log("[LiveSession] Connected to Gemini Live API");
          },
          onmessage: (msg: LiveServerMessage) => this.handleServerMessage(msg),
          onerror: (e: ErrorEvent) => {
            console.error("[LiveSession] WebSocket error:", e.message);
            this.callbacks.onError(new Error(e.message || "WebSocket error"));
          },
          onclose: (e: CloseEvent) => {
            this.connected = false;
            console.log(`[LiveSession] Connection closed: code=${e.code} reason=${e.reason}`);
            this.clearReconnectTimer();
            this.callbacks.onClose?.(e.code, e.reason);

            // Auto-reconnect on unexpected closes (not from intentional close())
            if (!this.closedIntentionally && e.code !== 1000) {
              const delay = e.code === 1007 ? 2000 : 1000; // longer delay for safety rejections
              console.log(`[LiveSession] Unexpected close, reconnecting in ${delay}ms...`);
              this.scheduleReconnect(delay);
            }
          },
        },
      });

      this.startReconnectTimer();
      console.log(`[LiveSession] Session established, model=${config.model}`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[LiveSession] Failed to connect:", error.message);
      this.callbacks.onError(error);
      throw error;
    }
  }

  /**
   * Reconnect using the stored resumption handle.
   * Preserves conversation history and context.
   * If resumption fails, falls back to a fresh connection and calls onReconnectFailed
   * so the relay can reload history from DB.
   */
  async reconnect(): Promise<void> {
    // Close old session gracefully
    if (this.session) {
      try { this.session.close(); } catch { /* ignore */ }
      this.session = null;
    }
    this.connected = false;
    this.clearReconnectTimer();

    if (!this.resumptionHandle) {
      console.warn("[LiveSession] No resumption handle — full reconnect");
      await this.connect(this.systemPrompt, this.config);
      await this.callbacks.onReconnectFailed?.();
      return;
    }

    console.log("[LiveSession] Reconnecting with resumption handle...");

    try {
      await this.connect(this.systemPrompt, this.config);
    } catch (err) {
      // Resumption handle may be stale — try fresh connection
      console.warn("[LiveSession] Resumption failed, trying fresh connect:", err);
      this.resumptionHandle = null;
      await this.connect(this.systemPrompt, this.config);
      // Notify relay to reload history from DB
      await this.callbacks.onReconnectFailed?.();
    }
  }

  /**
   * Close the session and clean up.
   */
  close(): void {
    this.closedIntentionally = true;
    this.clearReconnectTimer();
    if (this.session) {
      try { this.session.close(); } catch { /* ignore */ }
      this.session = null;
    }
    this.connected = false;
    this.resumptionHandle = null;
    console.log("[LiveSession] Session closed");
  }

  get isConnected(): boolean {
    return this.connected && this.session !== null;
  }

  // -------------------------------------------------------------------------
  // Sending data
  // -------------------------------------------------------------------------

  /**
   * Send a video frame (JPEG) via sendClientContent with inlineData.
   * Images must go through sendClientContent (sendRealtimeInput doesn't work for images
   * on this model). Uses turnComplete=false so the model doesn't respond to every frame.
   */
  sendFrame(jpegBase64: string, turnComplete = false): void {
    if (!this.session || !this.connected) return;
    try {
      this.session.sendClientContent({
        turns: [{
          role: "user",
          parts: [{ inlineData: { data: jpegBase64, mimeType: "image/jpeg" } }],
        }],
        turnComplete,
      });
    } catch (err) {
      console.error("[LiveSession] Failed to send frame:", err);
    }
  }

  /**
   * Send a frame grid with a text prompt to trigger model analysis.
   * Sets turnComplete=true so the model responds with observations.
   */
  sendFrameWithPrompt(jpegBase64: string, prompt: string): void {
    if (!this.session || !this.connected) return;
    try {
      this.session.sendClientContent({
        turns: [{
          role: "user",
          parts: [
            { inlineData: { data: jpegBase64, mimeType: "image/jpeg" } },
            { text: prompt },
          ],
        }],
        turnComplete: true,
      });
    } catch (err) {
      console.error("[LiveSession] Failed to send frame with prompt:", err);
    }
  }

  /**
   * Send raw PCM audio via realtime input.
   * NOTE: The Live API only accepts raw PCM audio (audio/pcm;rate=16000).
   * Encoded formats (webm, wav, mp3) must be transcribed first.
   * @param audioBase64 Base64-encoded raw PCM audio data
   * @param mimeType Audio MIME type (default: "audio/pcm;rate=16000")
   */
  sendAudio(audioBase64: string, mimeType = "audio/pcm;rate=16000"): void {
    if (!this.session || !this.connected) return;
    try {
      this.session.sendRealtimeInput({
        audio: {
          data: audioBase64,
          mimeType,
        },
      });
    } catch (err) {
      console.error("[LiveSession] Failed to send audio:", err);
    }
  }

  /**
   * Send a text message as a conversation turn.
   * Ordered — added to context sequentially.
   * @param text The message text
   * @param role "user" or "model" (default: "user")
   * @param turnComplete Whether to signal the model to respond (default: true)
   */
  sendMessage(text: string, role: "user" | "model" = "user", turnComplete = true): void {
    if (!this.session || !this.connected) return;
    try {
      this.session.sendClientContent({
        turns: [{ role, parts: [{ text }] }],
        turnComplete,
      });
    } catch (err) {
      console.error("[LiveSession] Failed to send message:", err);
    }
  }

  /**
   * Inject context without triggering a model response.
   * Used for monitor agent context injections, person identification updates, etc.
   */
  sendContextInjection(text: string): void {
    if (!this.session || !this.connected) return;
    try {
      // Send as user turn without completing — model won't respond
      this.session.sendClientContent({
        turns: [{ role: "user", parts: [{ text: `[SYSTEM CONTEXT UPDATE]\n${text}` }] }],
        turnComplete: false,
      });
    } catch (err) {
      console.error("[LiveSession] Failed to send context injection:", err);
    }
  }

  /**
   * Send conversation history to prime the session.
   * Used after reconnection to restore context.
   */
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
      console.error("[LiveSession] Failed to send conversation history:", err);
    }
  }

  // -------------------------------------------------------------------------
  // Server message handling
  // -------------------------------------------------------------------------

  private handleServerMessage(msg: LiveServerMessage): void {
    // Setup complete — session is ready
    if (msg.setupComplete) {
      console.log("[LiveSession] Setup complete — ready to send data");
      this.callbacks.onReady?.();
      return;
    }

    // Session resumption update — store handle for reconnection
    if (msg.sessionResumptionUpdate) {
      const update = msg.sessionResumptionUpdate;
      if (update.newHandle) {
        this.resumptionHandle = update.newHandle;
      }
      return;
    }

    // Go away — server requesting disconnect soon
    if (msg.goAway) {
      console.log("[LiveSession] Received goAway — scheduling reconnect");
      this.callbacks.onGoAway?.();
      // Trigger immediate reconnect
      this.scheduleReconnect(0);
      return;
    }

    // Usage metadata
    if (msg.usageMetadata) {
      const usage = msg.usageMetadata;
      this.callbacks.onUsage?.({
        promptTokens: (usage as any).promptTokenCount || 0,
        completionTokens: (usage as any).candidatesTokenCount || 0,
      });
    }

    // Server content — text responses, turn completion, interruption
    if (msg.serverContent) {
      const content = msg.serverContent;

      // Model text output
      if (content.modelTurn?.parts) {
        for (const part of content.modelTurn.parts) {
          if (part.text) {
            this.callbacks.onText(part.text);
          }
        }
      }

      // Input transcription
      if (content.inputTranscription?.text) {
        this.callbacks.onInputTranscription?.(content.inputTranscription.text);
      }

      // Turn complete
      if (content.turnComplete) {
        this.callbacks.onTurnComplete();
      }

      // Interrupted
      if (content.interrupted) {
        this.callbacks.onInterrupted();
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
        console.log("[LiveSession] Proactive reconnect (approaching session limit)");
        this.reconnect().catch(err => {
          console.error("[LiveSession] Proactive reconnect failed:", err);
        });
      }
    }, GeminiLiveSession.RECONNECT_INTERVAL_MS);
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
        console.error("[LiveSession] Scheduled reconnect failed:", err);
      });
    }, delayMs);
  }
}
