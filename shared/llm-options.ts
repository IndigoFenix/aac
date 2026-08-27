// shared/llm-options.ts
// Provider/model catalog and types for system-wide LLM configuration

// ──────────────────────────────────────────────────────────────────
// Core Types
// ──────────────────────────────────────────────────────────────────

export type LLMProviderKey = "openai" | "gemini" | "claude";
export type UseCaseKey =
  | "clinician"
  | "aac_chat"
  | "aac_moderator"
  | "deep_analysis"
  | "crm_chat"
  // Per-agent HTTP-mode model overrides for the AAC live agents. These only
  // take effect on the HTTP (generateContent) fallback path — the live /
  // native-audio path has no equivalent selectable model. Gemini-only.
  | "aac_observer_http"
  | "aac_speaker_http"
  | "aac_boardmanager_http";

export interface ModelOption {
  provider: LLMProviderKey;
  modelId: string;
  displayName: string;
  description: string;
  tier: "economy" | "standard" | "premium";
  inputCostPer1M: number;
  outputCostPer1M: number;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsStructuredOutput: boolean;
  /** Can be used as a Live/Realtime provider (WebSocket session) */
  supportsLive?: boolean;
  /**
   * Whether this model is available on Vertex AI. Defaults to true — set to
   * false for models (typically preview ones) that ship only on the public
   * Gemini API. Live-relay uses this to choose between Vertex auth and
   * API-key auth at session start.
   */
  availableOnVertex?: boolean;
  /**
   * Audio token rate (Live API models). When set, credit tracking uses this
   * for audio/image/video input tokens — Google bills all non-text input
   * modalities at the same rate on Live models. Falls back to
   * `inputCostPer1M` when unset.
   */
  audioInputCostPer1M?: number;
  /**
   * Audio output token rate (Live API models). When set, credit tracking
   * uses this for audio-modality response tokens (spoken replies). Falls
   * back to `outputCostPer1M` when unset.
   */
  audioOutputCostPer1M?: number;
}

export interface UseCaseInfo {
  label: string;
  description: string;
  defaultProvider: LLMProviderKey;
  defaultModel: string;
  requiresTools: boolean;
  requiresStreaming: boolean;
  requiresStructuredOutput: boolean;
  /** Use case requires a Live/Realtime-capable model (WebSocket session) */
  requiresLive?: boolean;
  /**
   * Use case runs on the HTTP (generateContent) path only — exclude
   * Live/native-audio models (they 404 on generateContent) from the picker.
   * Mutually exclusive with `requiresLive`.
   */
  requiresHttp?: boolean;
}

export interface LLMConfigValue {
  provider: LLMProviderKey;
  model: string;
}

// ──────────────────────────────────────────────────────────────────
// Use Cases
// ──────────────────────────────────────────────────────────────────

export const USE_CASES: Record<UseCaseKey, UseCaseInfo> = {
  clinician: {
    label: "Clinician Chat",
    description: "Main clinician-facing assistant (structured output with tools)",
    // PHI-bearing role. The default must match the BAA-covered posture: this
    // is what production's system_settings row holds, and a settings reset
    // must not silently re-route clinician memory to a non-covered provider.
    defaultProvider: "claude",
    defaultModel: "claude-haiku",
    requiresTools: true,
    requiresStreaming: false,
    requiresStructuredOutput: true,
  },
  aac_chat: {
    label: "AAC Interactive Chat",
    description: "Real-time AAC conversation agent (live WebSocket session)",
    defaultProvider: "gemini",
    defaultModel: "gemini-live-2.5-flash-native-audio",
    requiresTools: true,
    requiresStreaming: true,
    requiresStructuredOutput: false,
    requiresLive: true,
  },
  aac_moderator: {
    label: "AAC Moderator",
    description: "Background AAC monitor agent (structured output with tools)",
    // Receives full AAC session transcripts + student name/age/diagnosis —
    // the densest PHI flow in the system. Same rule as `clinician`: the
    // default is the covered provider, never a consumer API.
    defaultProvider: "claude",
    defaultModel: "claude-haiku",
    requiresTools: true,
    requiresStreaming: false,
    requiresStructuredOutput: true,
  },
  deep_analysis: {
    label: "Deep Analysis",
    description: "Long-running chain-of-thought agent that produces student progress reports. Extended thinking + tool calling.",
    defaultProvider: "claude",
    defaultModel: "claude-opus",
    requiresTools: true,
    requiresStreaming: false,
    requiresStructuredOutput: false,
  },
  crm_chat: {
    label: "CRM Landing-Page Chat",
    description: "Anonymous landing-page assistant for potential customers. Cheap model recommended.",
    defaultProvider: "openai",
    defaultModel: "gpt-4o-mini",
    requiresTools: true,
    requiresStreaming: false,
    requiresStructuredOutput: true,
  },
  aac_observer_http: {
    label: "AAC Observer (HTTP mode)",
    description: "Model for the Observer's economy/HTTP backend — the cheap text path used when the live native-audio Observer is off. Gemini-only; ignored on the live path.",
    defaultProvider: "gemini",
    defaultModel: "gemini-2.5-flash",
    requiresTools: true,
    requiresStreaming: false,
    requiresStructuredOutput: false,
    requiresHttp: true,
  },
  aac_speaker_http: {
    label: "AAC Speaker (HTTP mode)",
    description: "Model for the Speaker's HTTP backend — text reply → server TTS, used when the live native-audio Speaker is off. Gemini-only; ignored on the live path.",
    defaultProvider: "gemini",
    defaultModel: "gemini-2.5-flash",
    requiresTools: false,
    requiresStreaming: true,
    requiresStructuredOutput: false,
    requiresHttp: true,
  },
  aac_boardmanager_http: {
    label: "AAC Board Manager (HTTP mode)",
    description: "Model for the Board Manager's HTTP text backend (the default board-build path). Gemini-only; the live Board Manager uses a fixed native-audio model instead.",
    defaultProvider: "gemini",
    defaultModel: "gemini-2.5-flash",
    requiresTools: true,
    requiresStreaming: false,
    requiresStructuredOutput: false,
    requiresHttp: true,
  },
};

// ──────────────────────────────────────────────────────────────────
// Model Catalog
// ──────────────────────────────────────────────────────────────────

export const MODEL_OPTIONS: ModelOption[] = [
  // OpenAI
  {
    provider: "openai",
    modelId: "gpt-4o-mini",
    displayName: "GPT-4o Mini",
    description: "Fast and affordable. Good for real-time interactions.",
    tier: "economy",
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.60,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutput: true,
  },
  {
    provider: "openai",
    modelId: "gpt-4o",
    displayName: "GPT-4o",
    description: "Best balance of speed and quality. Recommended default.",
    tier: "standard",
    inputCostPer1M: 2.50,
    outputCostPer1M: 10.00,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutput: true,
  },
  {
    provider: "openai",
    modelId: "o3",
    displayName: "o3",
    description: "Most capable reasoning model. Slower, higher cost.",
    tier: "premium",
    inputCostPer1M: 10.00,
    outputCostPer1M: 40.00,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutput: true,
  },
  // Gemini
  {
    provider: "gemini",
    modelId: "gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash",
    description: "Google's fastest model. Great for real-time use.",
    tier: "economy",
    // Published paid-tier rates (ai.google.dev/gemini-api/docs/pricing,
    // verified 2026-08-27). These sat at the 2.0 Flash rates ($0.15/$0.60)
    // until then, under-billing every Board Manager / economy-Observer turn
    // by 2x on input and 4x on output.
    inputCostPer1M: 0.30,
    outputCostPer1M: 2.50,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutput: true,
  },
  {
    provider: "gemini",
    modelId: "gemini-3.5-flash-lite",
    displayName: "Gemini 3.5 Flash-Lite",
    description: "Fastest model in the 3.5 line (~350 tok/s). Higher per-token cost than 2.5 Flash but strong throughput. HTTP only — no live/native-audio variant. On Vertex AI.",
    tier: "economy",
    inputCostPer1M: 0.30,
    outputCostPer1M: 2.50,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutput: true,
    availableOnVertex: true,
  },
  {
    provider: "gemini",
    modelId: "gemini-3.6-flash",
    displayName: "Gemini 3.6 Flash",
    description: "Agentic-optimized flash tier: stronger reasoning/tool-use, ~17% fewer output tokens than 3.5 Flash (up to 65% on long chains). ~10x the per-token cost of 2.5 Flash. HTTP only — no live/native-audio variant. On Vertex AI.",
    tier: "standard",
    inputCostPer1M: 1.50,
    outputCostPer1M: 7.50,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutput: true,
    availableOnVertex: true,
  },
  {
    provider: "gemini",
    modelId: "gemini-live-2.5-flash-native-audio",
    displayName: "Gemini 2.5 Flash Live (GA)",
    description: "GA native-audio live model. Stable, supports function calling. AUDIO output only — rejects TEXT modality on Vertex (1007). Runs on Vertex AI.",
    tier: "economy",
    inputCostPer1M: 0.50,       // text input
    outputCostPer1M: 2.00,      // text output
    audioInputCostPer1M: 3.00,  // audio/image/video input
    audioOutputCostPer1M: 12.00, // audio output
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutput: false,
    supportsLive: true,
    availableOnVertex: true,
  },
  {
    provider: "gemini",
    modelId: "gemini-3.1-flash-live-preview",
    displayName: "Gemini 3.1 Flash Live (Preview)",
    description: "Latest native-audio live model. Sharper function calling, better instruction following. Runs on the public Gemini API (not yet on Vertex AI) — requires GEMINI_API_KEY.",
    tier: "economy",
    inputCostPer1M: 0.75,       // text input (higher than 2.5)
    outputCostPer1M: 4.50,      // text output (higher than 2.5)
    audioInputCostPer1M: 3.00,  // audio/image/video input (same as 2.5)
    audioOutputCostPer1M: 12.00, // audio output (same as 2.5)
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutput: false,
    supportsLive: true,
    availableOnVertex: false,
  },
  {
    provider: "gemini",
    modelId: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    description: "Google's most capable model. Strong reasoning.",
    tier: "standard",
    inputCostPer1M: 1.25,
    outputCostPer1M: 10.00,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutput: true,
  },
  // Claude
  // Prices are the Anthropic list prices (identical on Vertex global
  // endpoints; regional endpoints add 10%). These feed credit accounting
  // (cost-helpers.ts) — keep them honest when the alias moves generation.
  {
    provider: "claude",
    modelId: "claude-haiku",
    displayName: "Claude Haiku 4.5",
    description: "Anthropic's fastest model. Good for real-time AAC. 200K context.",
    tier: "economy",
    inputCostPer1M: 1.00,
    outputCostPer1M: 5.00,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutput: false,
  },
  {
    provider: "claude",
    modelId: "claude-sonnet",
    displayName: "Claude Sonnet 5",
    description: "Anthropic's balanced model. Strong at structured tasks. 1M context.",
    tier: "standard",
    inputCostPer1M: 2.00,
    outputCostPer1M: 10.00,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutput: false,
  },
  {
    provider: "claude",
    modelId: "claude-opus",
    displayName: "Claude Opus 4.8",
    description: "Anthropic's large-context frontier model (1M tokens). Used for deep analysis reports.",
    tier: "premium",
    inputCostPer1M: 5.00,
    outputCostPer1M: 25.00,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutput: false,
  },
];

// ──────────────────────────────────────────────────────────────────
// DB Setting Keys
// ──────────────────────────────────────────────────────────────────

export const PROVIDER_LABELS: Record<LLMProviderKey, string> = {
  openai: "OpenAI",
  gemini: "Google Gemini",
  claude: "Anthropic Claude",
};

export const SETTING_KEYS: Record<UseCaseKey, string> = {
  clinician: "llm_clinician",
  aac_chat: "llm_aac_chat",
  aac_moderator: "llm_aac_moderator",
  deep_analysis: "llm_deep_analysis",
  crm_chat: "llm_crm_chat",
  aac_observer_http: "llm_aac_observer_http",
  aac_speaker_http: "llm_aac_speaker_http",
  aac_boardmanager_http: "llm_aac_boardmanager_http",
};

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

export function getModelsForProvider(provider: LLMProviderKey, requiresLive?: boolean): ModelOption[] {
  return MODEL_OPTIONS.filter((m) => m.provider === provider && (!requiresLive || m.supportsLive));
}

/**
 * Whether a model is selectable for a use case, honoring both the live
 * requirement (must support live) and the http requirement (must NOT be a
 * live/native-audio model, which 404s on generateContent).
 */
export function modelAllowedForUseCase(
  m: ModelOption,
  info: Pick<UseCaseInfo, "requiresLive" | "requiresHttp">,
): boolean {
  if (info.requiresLive && !m.supportsLive) return false;
  if (info.requiresHttp && m.supportsLive) return false;
  return true;
}

export function getModelOption(provider: LLMProviderKey, modelId: string): ModelOption | undefined {
  return MODEL_OPTIONS.find((m) => m.provider === provider && m.modelId === modelId);
}

/** Get providers that have at least one model matching the given constraint */
export function getProvidersWithModels(requiresLive?: boolean): LLMProviderKey[] {
  const providers = new Set<LLMProviderKey>();
  for (const m of MODEL_OPTIONS) {
    if (!requiresLive || m.supportsLive) {
      providers.add(m.provider);
    }
  }
  return Array.from(providers);
}

export function getDefaultConfig(useCase: UseCaseKey): LLMConfigValue {
  const info = USE_CASES[useCase];
  return { provider: info.defaultProvider, model: info.defaultModel };
}

/**
 * Resolve a model ID alias to the actual API model string.
 *
 * Claude naming differs between backends: the direct Anthropic API separates
 * the date with `-`, Vertex uses `@`. Selected via ANTHROPIC_USE_VERTEX env.
 * (Server-only; the client bundle never reads this var, so the mapping falls
 * back to the direct-API format in the browser — safe because the client
 * never calls Anthropic directly.)
 */
export function resolveModelId(provider: LLMProviderKey, modelId: string): string {
  if (provider === "claude") {
    const useVertex =
      typeof process !== "undefined" &&
      (process.env?.ANTHROPIC_USE_VERTEX === "1" ||
        process.env?.ANTHROPIC_USE_VERTEX === "true");
    const sep = useVertex ? "@" : "-";
    // Haiku 4.5 still carries a dated snapshot (and Vertex spells the date
    // with `@`). From the 4.6 generation on, Anthropic model IDs are dateless
    // and IDENTICAL on the direct API and on Vertex, so no separator swap.
    // Opus 4 / Sonnet 4 (May 2025) are deprecated on Vertex and are not
    // offered as Model Garden options any more — Model Garden lists each
    // point release separately, so the IDs here must match what was enabled
    // there ("Claude Opus 4.8", "Claude Haiku 4.5"). Keep in sync with
    // server/scripts/vertex-preflight.ts.
    const CLAUDE_MODEL_MAP: Record<string, string> = {
      "claude-haiku":  `claude-haiku-4-5${sep}20251001`,
      "claude-sonnet": "claude-sonnet-5",
      "claude-opus":   "claude-opus-4-8",
    };
    return CLAUDE_MODEL_MAP[modelId] || modelId;
  }
  return modelId;
}
