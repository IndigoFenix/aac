// server/services/dual-agent/live-provider.ts
// Provider-agnostic interface for live/realtime API sessions.
// Implementations: GeminiLiveProvider, OpenAILiveProvider

// ---------------------------------------------------------------------------
// Provider-agnostic types
// ---------------------------------------------------------------------------

/** Normalized tool call from any provider */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
}

/** Normalized tool response sent back to any provider */
export interface ToolResponse {
  id: string;
  name: string;
  response: Record<string, unknown>;
  scheduling?: "SILENT" | "WHEN_IDLE";  // Gemini native audio: absorb result without generating audio
}

// ---------------------------------------------------------------------------
// Callbacks — the relay wires these up
// ---------------------------------------------------------------------------

export interface LiveProviderCallbacks {
  /** Incremental text from the model (stray text or output transcriptions) */
  onText: (text: string) => void;
  /** Model finished its turn */
  onTurnComplete: () => void;
  /** Model was interrupted by new user input */
  onInterrupted: () => void;
  /** Model wants to call tools — normalized from provider-specific format */
  onToolCall?: (calls: ToolCall[]) => void;
  /** Model cancelled previously issued tool calls */
  onToolCallCancellation?: (ids: string[]) => void;
  /** Usage metadata from the model */
  onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void;
  /** Session is about to disconnect (provider-specific) — reconnect soon */
  onGoAway?: () => void;
  /** Session setup completed — ready to send data */
  onReady?: () => void;
  /** Connection error */
  onError: (error: Error) => void;
  /** Connection closed */
  onClose?: (code?: number, reason?: string) => void;
  /** Input transcription (user audio → text) */
  onInputTranscription?: (text: string) => void;
  /** Reconnection with session resumption failed — relay must reload history */
  onReconnectFailed?: () => Promise<void>;
  /** Reconnection is starting (before connect) */
  onReconnecting?: () => void;
  /** Model generated audio data (Gemini native-audio — discarded) */
  onAudioData?: (data: { mimeType: string; data: string }) => void;
  /** Output audio transcription (for logging/debug) */
  onOutputTranscription?: (text: string) => void;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface LiveProviderConfig {
  model: string;
  temperature?: number;
  /** Provider-specific tool declarations (Gemini Tool[] or OpenAI RealtimeFunctionTool[]) */
  tools?: any[];
  /** Token threshold that triggers context window compression (Gemini only) */
  compressionTriggerTokens?: number;
  /** Target token count after compression (Gemini only) */
  compressionTargetTokens?: number;
  /** Response modality override for Gemini: "TEXT" for prefix token mode, "AUDIO" for native audio.
   *  Defaults to "AUDIO" when tools are present, "TEXT" when no tools. */
  responseModality?: "TEXT" | "AUDIO";
}

// ---------------------------------------------------------------------------
// LiveProvider interface
// ---------------------------------------------------------------------------

export interface LiveProvider {
  /** Open a new session with the given system prompt and config */
  connect(systemPrompt: string, config: LiveProviderConfig): Promise<void>;
  /** Reconnect (session resumption if available, otherwise fresh + history replay) */
  reconnect(): Promise<void>;
  /** Close the session and clean up */
  close(): void;
  /** Whether the session is currently connected and ready */
  readonly isConnected: boolean;

  // --- Sending data ---

  /** Send a video frame (JPEG) — turnComplete=false means model won't respond */
  sendFrame(jpegBase64: string, turnComplete?: boolean): void;
  /** Send a frame grid with a text prompt to trigger model analysis */
  sendFrameWithPrompt(
    jpegBase64: string,
    prompt: string,
    extraImages?: Array<{ data: string; mimeType: string; label?: string }>,
  ): void;
  /** Send raw audio data */
  sendAudio(audioBase64: string, mimeType?: string): void;
  /** Send a text message as a conversation turn */
  sendMessage(text: string, role?: "user" | "model", turnComplete?: boolean): void;
  /** Inject context without triggering a model response */
  sendContextInjection(text: string): void;
  /** Send conversation history to prime the session (after reconnection) */
  sendConversationHistory(turns: Array<{ role: "user" | "model"; text: string }>): void;
  /** Send tool responses back to the model after processing function calls */
  sendToolResponse(responses: ToolResponse[]): void;

  // --- State inspection (for relay error handling) ---

  lastCloseCode: number | null;
  lastCloseWasRateLimit: boolean;
  lastCloseWasSafety: boolean;
}
