// shared/llm-options.ts
// Provider/model catalog and types for system-wide LLM configuration

// ──────────────────────────────────────────────────────────────────
// Core Types
// ──────────────────────────────────────────────────────────────────

export type LLMProviderKey = "openai" | "gemini" | "claude";
export type UseCaseKey = "clinician" | "aac_chat" | "aac_moderator";

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
  // OpenAI Realtime (GA models — support images + function calling)
  {
    provider: "openai",
    modelId: "gpt-realtime-mini",
    displayName: "GPT Realtime Mini",
    description: "OpenAI's fast realtime model. Low-latency live interactions with vision support.",
    tier: "economy",
    inputCostPer1M: 0.60,
    outputCostPer1M: 2.40,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutput: false,
    supportsLive: true,
  },
  {
    provider: "openai",
    modelId: "gpt-realtime",
    displayName: "GPT Realtime",
    description: "OpenAI's most capable realtime model. Higher quality with vision support.",
    tier: "standard",
    inputCostPer1M: 4.00,
    outputCostPer1M: 16.00,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutput: false,
    supportsLive: true,
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
    description: "GA native-audio live model. Stable, supports function calling + TEXT modality.",
    tier: "economy",
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.60,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutput: false,
    supportsLive: true,
  },
  {
    provider: "gemini",
    modelId: "gemini-2.5-flash-native-audio-preview-12-2025",
    displayName: "Gemini 2.5 Flash Live (Preview)",
    description: "Preview native-audio live model. Unstable — prefer the GA model.",
    tier: "economy",
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.60,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutput: false,
    supportsLive: true,
  },
  {
    provider: "gemini",
    modelId: "gemini-2.0-flash-exp-image-generation",
    displayName: "Gemini 2.0 Flash Live (Text)",
    description: "Gemini text-mode live model. Uses prefix tokens (stable, deprecated model).",
    tier: "economy",
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.60,
    supportsTools: false,
    supportsStreaming: true,
    supportsStructuredOutput: false,
    supportsLive: true,
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
 * Claude model IDs are short aliases; this maps them to the real API identifiers.
 */
export function resolveModelId(provider: LLMProviderKey, modelId: string): string {
  if (provider === "claude") {
    const CLAUDE_MODEL_MAP: Record<string, string> = {
      "claude-haiku": "claude-haiku-4-5-20251001",
      "claude-sonnet": "claude-sonnet-4-20250514",
      "claude-opus": "claude-opus-4-20250514",
    };
    return CLAUDE_MODEL_MAP[modelId] || modelId;
  }
  return modelId;
}
