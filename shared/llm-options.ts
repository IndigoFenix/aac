// shared/llm-options.ts
// Provider/model catalog and types for system-wide LLM configuration

// ──────────────────────────────────────────────────────────────────
// Core Types
// ──────────────────────────────────────────────────────────────────

export type LLMProviderKey = "openai" | "gemini" | "claude";
export type UseCaseKey = "clinician" | "aac_chat" | "aac_moderator" | "deep_analysis" | "crm_chat";

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
    defaultProvider: "openai",
    defaultModel: "gpt-4o",
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
    defaultProvider: "openai",
    defaultModel: "gpt-4o",
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
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.60,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutput: true,
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
  {
    provider: "claude",
    modelId: "claude-haiku",
    displayName: "Claude Haiku",
    description: "Anthropic's fastest model. Good for real-time AAC.",
    tier: "economy",
    inputCostPer1M: 0.80,
    outputCostPer1M: 4.00,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutput: false,
  },
  {
    provider: "claude",
    modelId: "claude-sonnet",
    displayName: "Claude Sonnet",
    description: "Anthropic's balanced model. Strong at structured tasks.",
    tier: "standard",
    inputCostPer1M: 3.00,
    outputCostPer1M: 15.00,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutput: false,
  },
  {
    provider: "claude",
    modelId: "claude-opus",
    displayName: "Claude Opus",
    description: "Anthropic's most capable model. Best quality.",
    tier: "premium",
    inputCostPer1M: 15.00,
    outputCostPer1M: 75.00,
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
};

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

export function getModelsForProvider(provider: LLMProviderKey, requiresLive?: boolean): ModelOption[] {
  return MODEL_OPTIONS.filter((m) => m.provider === provider && (!requiresLive || m.supportsLive));
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
    const CLAUDE_MODEL_MAP: Record<string, string> = {
      "claude-haiku":  `claude-haiku-4-5${sep}20251001`,
      "claude-sonnet": `claude-sonnet-4${sep}20250514`,
      "claude-opus":   `claude-opus-4${sep}20250514`,
    };
    return CLAUDE_MODEL_MAP[modelId] || modelId;
  }
  return modelId;
}
