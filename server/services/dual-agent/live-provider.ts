// server/services/dual-agent/live-provider.ts
// Provider-agnostic interface for live/realtime API sessions.
// Implementations: GeminiLiveProvider

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

/**
 * One turn's usage stats from a live provider. Aggregates are always present;
 * `details` is populated when the provider reports a modality breakdown
 * (Gemini Live returns `promptTokensDetails` / `responseTokensDetails`).
 */
export interface LiveUsage {
  promptTokens: number;
  completionTokens: number;
  /** Prompt-cache read tokens (Anthropic cache_read_input_tokens), billed 0.1x. */
  cachedTokens?: number;
  /** Prompt-cache write tokens (Anthropic cache_creation_input_tokens), billed 1.25x. */
  cacheCreationTokens?: number;
  details?: {
    /** Text tokens in the prompt (system prompt, history, tool responses). */
    textInputTokens: number;
    /** Audio + image + video tokens in the prompt (Google bills as one rate). */
    nonTextInputTokens: number;
    /** Text tokens in the model's response (tool calls, transcriptions). */
    textOutputTokens: number;
    /** Audio tokens in the model's response (spoken replies). */
    audioOutputTokens: number;
    /** Prompt tokens served from context cache, if reported. */
    cachedInputTokens?: number;
  };
}

// ---------------------------------------------------------------------------
// Callbacks — the relay wires these up
// ---------------------------------------------------------------------------

export interface LiveProviderCallbacks {
  /** Incremental text from the model (stray text or output transcriptions) */
  onText: (text: string) => void;
  /** Model finished its turn. reason is set when the turn ended abnormally (e.g. "MALFORMED_FUNCTION_CALL") */
  onTurnComplete: (reason?: string) => void;
  /** Model was interrupted by new user input */
  onInterrupted: () => void;
  /** Model wants to call tools — normalized from provider-specific format */
  onToolCall?: (calls: ToolCall[]) => void;
  /** Model cancelled previously issued tool calls */
  onToolCallCancellation?: (ids: string[]) => void;
  /**
   * Usage metadata for one turn. `details` contains the provider-reported
   * modality breakdown when available (AUDIO/IMAGE/VIDEO/TEXT) — credit
   * tracking uses this to bill separately on models with separate rates.
   */
  onUsage?: (usage: LiveUsage) => void;
  /** Session is about to disconnect (provider-specific) — reconnect soon */
  onGoAway?: () => void;
  /** Session setup completed — ready to send data */
  onReady?: () => void;
  /** Connection error */
  onError: (error: Error) => void;
  /** Connection closed */
  onClose?: (code?: number, reason?: string) => void;
  /** Reconnection with session resumption failed — relay must reload history */
  onReconnectFailed?: () => Promise<void>;
  /** Reconnection is starting (before connect) */
  onReconnecting?: () => void;
  /** Model generated audio data (Gemini native-audio) */
  onAudioData?: (data: { mimeType: string; data: string }) => void;
  /** Transcription of the model's audio output */
  onOutputTranscription?: (text: string) => void;
  /** Fires when Gemini emits `outputTranscription.finished: true` — the
   *  text portion of the model's turn is complete (audio may still be
   *  streaming). Use this for downstream consumers that need the FULL
   *  transcript as early as possible. */
  onOutputTranscriptionFinished?: () => void;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface LiveProviderConfig {
  model: string;
  temperature?: number;
  /** Provider-specific tool declarations (Gemini Tool[]) */
  tools?: any[];
  /** Token threshold that triggers context window compression (Gemini only) */
  compressionTriggerTokens?: number;
  /** Target token count after compression (Gemini only) */
  compressionTargetTokens?: number;
  /** Response modality override for Gemini: "TEXT" for prefix token mode, "AUDIO" for native audio.
   *  Defaults to "AUDIO" when tools are present, "TEXT" when no tools. */
  responseModality?: "TEXT" | "AUDIO";
  /** Enable affective dialog — model detects emotions and adapts (Gemini native audio) */
  enableAffectiveDialog?: boolean;
  /** Enable proactive audio — model can stay silent when no response is needed (Gemini native audio) */
  proactiveAudio?: boolean;
  /** Gemini voice name for native audio output (e.g. "Puck", "Kore", "Charon") */
  voiceName?: string;
}

// ---------------------------------------------------------------------------
// LiveProvider interface
// ---------------------------------------------------------------------------

export interface LiveProvider {
  /** Open a new session with the given system prompt and config */
  connect(systemPrompt: string, config: LiveProviderConfig): Promise<void>;
  /** Reconnect (session resumption if available, otherwise fresh + history replay) */
  reconnect(): Promise<void>;
  /**
   * Reconnect with a NEW system prompt + tools + compression config, preserving
   * conversation history via session resumption. Used for sleep-state profile
   * switches (awake ↔ resting). Optional — providers that don't support it can
   * omit it; callers should feature-check.
   */
  reconnectWithConfig?(systemPrompt: string, config: LiveProviderConfig): Promise<void>;
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
  /** Send a brief silence to trigger audio VAD and kick the model into responding */
  sendAudioNudge(): void;
  /**
   * Send a text message as a conversation turn.
   *
   * `opts.interrupt` (default false): when true, force-route via
   * `sendClientContent` regardless of model. `sendClientContent` is documented
   * as the explicit interrupt mechanism on the Live API — sending one cancels
   * any in-flight model generation. Used for client-initiated interrupts (e.g.
   * a button press while the model is speaking). When false, in-conversation
   * text uses the model's preferred non-interrupting path (`sendRealtimeInput`
   * on 3.1, `sendClientContent` on 2.5).
   */
  sendMessage(
    text: string,
    role?: "user" | "model",
    turnComplete?: boolean,
    opts?: { interrupt?: boolean },
  ): void;
  /** Inject context without triggering a model response */
  sendContextInjection(text: string): void;
  /** Send conversation history to prime the session (after reconnection) */
  sendConversationHistory(turns: Array<{ role: "user" | "model"; text: string }>): void;
  /** Send tool responses back to the model after processing function calls */
  sendToolResponse(responses: ToolResponse[]): void;
  /**
   * Deliver tool responses as protocol-correct functionResponse parts via
   * sendClientContent (turnComplete=false). Resolves the open functionCall
   * without triggering a new turn — workaround for Vertex Live, where
   * sendToolResponse on BLOCKING tools always triggers generation.
   */
  sendToolResponseAsContent(responses: ToolResponse[]): void;

  // --- State inspection (for relay error handling) ---

  lastCloseCode: number | null;
  lastCloseWasRateLimit: boolean;
  lastCloseWasSafety: boolean;

  /**
   * Bind logger session context so provider-side events (server messages,
   * tool calls) get attributed to the right session_debug_logs row.
   * No-op when debugMode is false.
   *
   * `agentLabel` is an optional tag (Observer / Speaker) for the three-agent
   * path — when set, every log entry the provider emits inside its async
   * callbacks carries the tag so concurrent traces from two Live sessions
   * can be told apart.
   */
  setDebugSessionContext(sessionId: string, debugMode: boolean, agentLabel?: string): void;
}
