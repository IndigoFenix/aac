// server/services/dual-agent/openai-live-provider.ts
// OpenAI Realtime API provider — text-only output mode with function calling.
// Uses OpenAI's WebSocket-based Realtime API for low-latency live interactions.

import OpenAI from "openai";
import { OpenAIRealtimeWS } from "openai/realtime/ws";
import type {
  LiveProvider,
  LiveProviderCallbacks,
  LiveProviderConfig,
  ToolCall,
  ToolResponse,
} from "./live-provider";

// ---------------------------------------------------------------------------
// OpenAILiveProvider
// ---------------------------------------------------------------------------

export class OpenAILiveProvider implements LiveProvider {
  private client: OpenAI;
  private ws: OpenAIRealtimeWS | null = null;
  private config: LiveProviderConfig = { model: "gpt-realtime-mini" };
  private callbacks: LiveProviderCallbacks;
  private systemPrompt = "";
  private connected = false;

  lastCloseCode: number | null = null;
  lastCloseWasRateLimit = false;
  lastCloseWasSafety = false;

  // OpenAI has no session resumption — track conversation history for reconnection
  private conversationHistory: Array<{ role: "user" | "model"; text: string }> = [];

  // Proactive reconnection timer (before 60-min session limit)
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private static RECONNECT_INTERVAL_MS = 55 * 60_000; // 55 minutes

  // Set by close() so event handlers know not to auto-reconnect
  private closedIntentionally = false;

  // Accumulate function call arguments from streaming events
  private pendingFunctionCalls: Map<string, { name: string; args: string }> = new Map();

  constructor(callbacks: LiveProviderCallbacks) {
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });
    this.callbacks = callbacks;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async connect(systemPrompt: string, config: LiveProviderConfig): Promise<void> {
    this.closedIntentionally = false;
    this.lastCloseWasSafety = false;
    this.lastCloseWasRateLimit = false;
    this.systemPrompt = systemPrompt;
    this.config = config;

    try {
      this.ws = await OpenAIRealtimeWS.create(this.client, {
        model: config.model,
      });

      // Wait for the underlying WebSocket to reach OPEN state
      // (OpenAIRealtimeWS.create() can resolve before the socket is fully open)
      if (this.ws.socket.readyState !== 1) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("WebSocket open timed out (10s)")), 10_000);
          this.ws!.socket.once("open", () => { clearTimeout(timeout); resolve(); });
          this.ws!.socket.once("error", (err: Error) => { clearTimeout(timeout); reject(err); });
        });
      }

      // Now the socket is OPEN — set up event handlers and configure session
      const readyPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("session.updated timed out (10s)"));
        }, 10_000);

        this.setupEventHandlers(() => {
          clearTimeout(timeout);
          resolve();
        });
      });

      // Configure session (post-connection)
      this.ws.send({
        type: "session.update",
        session: {
          type: "realtime",
          instructions: systemPrompt,
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription: { model: "gpt-4o-mini-transcribe" },
            },
          },
          tools: config.tools || [],
          tool_choice: "auto",
          output_modalities: ["text"], // text-only — no audio generation cost
          max_output_tokens: 4096,
        },
      });

      await readyPromise;

      this.startReconnectTimer();
      console.log(`[OpenAILiveProvider] Session established, model=${config.model}`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[OpenAILiveProvider] Failed to connect:", error.message);
      this.callbacks.onError(error);
      throw error;
    }
  }

  async reconnect(): Promise<void> {
    this.callbacks.onReconnecting?.();

    // Close old session
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.connected = false;
    this.clearReconnectTimer();

    console.log("[OpenAILiveProvider] Reconnecting (no session resumption — will replay history)...");

    try {
      await this.connect(this.systemPrompt, this.config);

      // Replay conversation history (OpenAI has no session resumption)
      if (this.conversationHistory.length > 0) {
        this.sendConversationHistory(this.conversationHistory);
        console.log(`[OpenAILiveProvider] Replayed ${this.conversationHistory.length} history turns`);
      }
    } catch (err) {
      console.warn("[OpenAILiveProvider] Reconnect failed:", err);
      // Notify relay to reload history from DB
      await this.callbacks.onReconnectFailed?.();
    }
  }

  close(): void {
    this.closedIntentionally = true;
    this.clearReconnectTimer();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.connected = false;
    this.conversationHistory = [];
    this.pendingFunctionCalls.clear();
    console.log("[OpenAILiveProvider] Session closed");
  }

  get isConnected(): boolean {
    return this.connected && this.ws !== null;
  }

  // -------------------------------------------------------------------------
  // Sending data
  // -------------------------------------------------------------------------

  sendFrame(jpegBase64: string, turnComplete = false): void {
    if (!this.ws || !this.connected || !this.isSocketOpen()) return;
    try {
      this.ws.send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{
            type: "input_image",
            image_url: `data:image/jpeg;base64,${jpegBase64}`,
          }],
        },
      });
      if (turnComplete) {
        this.ws.send({ type: "response.create" });
      }
    } catch (err) {
      console.error("[OpenAILiveProvider] Failed to send frame:", err);
    }
  }

  sendFrameWithPrompt(
    jpegBase64: string,
    prompt: string,
    extraImages?: Array<{ data: string; mimeType: string; label?: string }>,
  ): void {
    if (!this.ws || !this.connected || !this.isSocketOpen()) return;
    try {
      const content: Array<any> = [
        { type: "input_image", image_url: `data:image/jpeg;base64,${jpegBase64}` },
      ];
      if (extraImages) {
        for (const img of extraImages) {
          if (img.label) {
            content.push({ type: "input_text", text: img.label });
          }
          content.push({
            type: "input_image",
            image_url: `data:${img.mimeType};base64,${img.data}`,
          });
        }
      }
      content.push({ type: "input_text", text: prompt });

      this.ws.send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content,
        },
      });
      this.ws.send({ type: "response.create" });
    } catch (err) {
      console.error("[OpenAILiveProvider] Failed to send frame with prompt:", err);
    }
  }

  sendAudio(audioBase64: string, _mimeType?: string): void {
    if (!this.ws || !this.connected || !this.isSocketOpen()) return;
    try {
      this.ws.send({
        type: "input_audio_buffer.append",
        audio: audioBase64,
      });
    } catch (err) {
      console.error("[OpenAILiveProvider] Failed to send audio:", err);
    }
  }

  sendMessage(text: string, role: "user" | "model" = "user", turnComplete = true): void {
    if (!this.ws || !this.connected || !this.isSocketOpen()) return;
    try {
      if (role === "model") {
        // Assistant messages use output_text content type
        this.ws.send({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
          },
        });
      } else {
        // User messages use input_text content type
        this.ws.send({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }],
          },
        });
      }
      if (turnComplete) {
        this.ws.send({ type: "response.create" });
      }

      // Track for reconnection history
      this.conversationHistory.push({ role, text });
      if (this.conversationHistory.length > 50) {
        this.conversationHistory = this.conversationHistory.slice(-50);
      }
    } catch (err) {
      console.error("[OpenAILiveProvider] Failed to send message:", err);
    }
  }

  sendContextInjection(text: string): void {
    if (!this.ws || !this.connected || !this.isSocketOpen()) return;
    try {
      // Add as user message without triggering response
      this.ws.send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `[SYSTEM CONTEXT UPDATE]\n${text}` }],
        },
      });
      // Do NOT call response.create — no response wanted
    } catch (err) {
      console.error("[OpenAILiveProvider] Failed to send context injection:", err);
    }
  }

  sendConversationHistory(turns: Array<{ role: "user" | "model"; text: string }>): void {
    if (!this.ws || !this.connected || !this.isSocketOpen()) return;
    try {
      for (const turn of turns) {
        if (turn.role === "model") {
          this.ws.send({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: turn.text }],
            },
          });
        } else {
          this.ws.send({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: turn.text }],
            },
          });
        }
      }
    } catch (err) {
      console.error("[OpenAILiveProvider] Failed to send conversation history:", err);
    }
  }

  sendToolResponse(responses: ToolResponse[]): void {
    if (!this.ws || !this.connected || !this.isSocketOpen()) return;
    try {
      for (const resp of responses) {
        this.ws.send({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: resp.id,
            output: JSON.stringify(resp.response),
          },
        });
      }
      // Trigger the model to continue after processing tool results
      this.ws.send({ type: "response.create" });
    } catch (err) {
      console.error("[OpenAILiveProvider] Failed to send tool response:", err);
    }
  }

  // -------------------------------------------------------------------------
  // Event handling
  // -------------------------------------------------------------------------

  private setupEventHandlers(onSessionReady?: () => void): void {
    if (!this.ws) return;

    // Session created — WebSocket is live
    this.ws.on("session.created", (event) => {
      console.log("[OpenAILiveProvider] Session created, id:", (event as any)?.session?.id || "unknown");
    });

    // Session updated — configuration confirmed, safe to send data
    this.ws.on("session.updated", (event) => {
      this.connected = true;
      const session = (event as any)?.session;
      console.log("[OpenAILiveProvider] Session updated — ready. modalities:", session?.output_modalities, "tools:", session?.tools?.length || 0);
      onSessionReady?.();
      this.callbacks.onReady?.();
    });

    // Text delta — streaming text output
    this.ws.on("response.output_text.delta", (event) => {
      if (event.delta) {
        this.callbacks.onText(event.delta);
      }
    });

    // Function call arguments done — a complete tool call is ready
    this.ws.on("response.function_call_arguments.done", (event) => {
      const call: ToolCall = {
        id: event.call_id,
        name: this.pendingFunctionCalls.get(event.item_id)?.name || "",
        args: this.safeParse(event.arguments),
      };
      this.pendingFunctionCalls.delete(event.item_id);
      this.callbacks.onToolCall?.([call]);
    });

    // Output item added — track function call names
    this.ws.on("response.output_item.added", (event) => {
      const item = event.item;
      if (item.type === "function_call" && item.name) {
        this.pendingFunctionCalls.set(item.id || "", { name: item.name, args: "" });
      }
    });

    // Response done — turn is complete
    this.ws.on("response.done", (event) => {
      const response = event.response;

      // Extract usage if available
      if ((response as any)?.usage) {
        const usage = (response as any).usage;
        this.callbacks.onUsage?.({
          promptTokens: usage.input_tokens || 0,
          completionTokens: usage.output_tokens || 0,
        });
      }

      // Check response status
      const status = (response as any)?.status;
      if (status === "cancelled" || status === "failed" || status === "incomplete") {
        console.warn(`[OpenAILiveProvider] Response ended with status: ${status}`);
        const details = (response as any)?.status_details;
        if (details) {
          console.warn(`[OpenAILiveProvider] Status details:`, JSON.stringify(details));
        }
      }

      // Signal turn complete — but only if the response produced output items
      // (function_call_output triggers a new response.create, so we get another response.done)
      const outputItems = (response as any)?.output || [];
      const hasFunctionCall = outputItems.some((item: any) => item.type === "function_call");
      if (!hasFunctionCall) {
        // No more tool calls pending — this turn is truly done
        Promise.resolve(this.callbacks.onTurnComplete()).catch(err => {
          console.error("[OpenAILiveProvider] onTurnComplete callback error:", (err as Error).message);
        });
      }
    });

    // Input audio transcription completed
    this.ws.on("conversation.item.input_audio_transcription.completed", (event) => {
      if (event.transcript?.trim()) {
        this.callbacks.onInputTranscription?.(event.transcript.trim());
      }
    });

    // Error events
    this.ws.on("error", (error) => {
      const msg = error.message || "OpenAI Realtime error";
      const cause = (error as any).cause;
      console.error("[OpenAILiveProvider] Error:", msg);
      if (cause) {
        console.error("[OpenAILiveProvider] Error cause:", cause.message || cause);
      }
      console.error("[OpenAILiveProvider] WS readyState:", this.ws?.socket?.readyState, "connected:", this.connected);

      // Classify errors
      if (/rate.limit|quota|too many requests/i.test(msg)) {
        this.lastCloseWasRateLimit = true;
      } else if (/policy|unsafe|blocked|safety|content/i.test(msg)) {
        this.lastCloseWasSafety = true;
      }

      this.callbacks.onError(new Error(msg));
    });

    // WebSocket close handling
    this.ws.socket.on("close", (code: number, reason: Buffer) => {
      this.connected = false;
      this.lastCloseCode = code;
      const reasonStr = reason?.toString() || "";
      console.log(`[OpenAILiveProvider] Connection closed: code=${code} reason=${reasonStr}`);
      this.clearReconnectTimer();

      const isRateLimit = /rate.limit|quota|too many requests/i.test(reasonStr);
      this.lastCloseWasRateLimit = isRateLimit;

      const isSafety = !isRateLimit && /policy|unsafe|blocked|safety/i.test(reasonStr);
      this.lastCloseWasSafety = isSafety;

      this.callbacks.onClose?.(code, reasonStr);

      if (isRateLimit) {
        console.warn("[OpenAILiveProvider] Rate limited — NOT auto-reconnecting");
        return;
      }

      // Auto-reconnect on unexpected closes
      if (!this.closedIntentionally && code !== 1000) {
        const delay = 2000;
        console.log(`[OpenAILiveProvider] Unexpected close (code=${code}), reconnecting in ${delay}ms...`);
        this.callbacks.onReconnecting?.();
        this.scheduleReconnect(delay);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Reconnection management
  // -------------------------------------------------------------------------

  private startReconnectTimer(): void {
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      if (this.connected) {
        console.log("[OpenAILiveProvider] Proactive reconnect (approaching 60-min session limit)");
        this.reconnect().catch(err => {
          console.error("[OpenAILiveProvider] Proactive reconnect failed:", err);
        });
      }
    }, OpenAILiveProvider.RECONNECT_INTERVAL_MS);
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
        console.error("[OpenAILiveProvider] Scheduled reconnect failed:", err);
      });
    }, delayMs);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Check WebSocket is truly open (prevents SDK "could not send data" errors) */
  private isSocketOpen(): boolean {
    // readyState: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
    const state = this.ws?.socket?.readyState;
    if (state !== 1) {
      console.warn(`[OpenAILiveProvider] Cannot send — WS readyState=${state} (expected 1/OPEN)`);
      return false;
    }
    return true;
  }

  private safeParse(json: string): Record<string, any> {
    try {
      return JSON.parse(json);
    } catch {
      return {};
    }
  }
}
