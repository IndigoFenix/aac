import { storage } from '../storage';
import type { ApiProvider, InsertApiCall } from '@shared/schema';
import { pricingJsonSchema } from '@shared/schema';
import { Decimal } from 'decimal.js';
import { costCalculator, ApiUsageData } from "./costCalculatorService";

// Usage stats. Calculated based on stored API call data
export interface ApiUsageStats {
  totalCostToday: number;
  totalCostWeek: number;
  totalCostMonth: number;
  totalCallsToday: number;
  totalCallsWeek: number;
  totalCallsMonth: number;
  averageCostPerCall: number;
  topProviderBySpend: { name: string; cost: number } | null;
}

export interface TimeAndRecordOptions<T> extends Omit<RecordApiCallParams,
  "durationMs" | "responseTimeMs" | "startedAtMs" | "success" | "errorMessage" | "usage"> {
  /** If you already know usage, pass it. Otherwise we’ll try usageFromResponse. */
  usage?: UsageMetrics;
  /** Optional extractor for usage from the raw response. */
  usageFromResponse?: (response: T) => UsageMetrics | undefined;
  /** Optional extra metadata to derive from response (e.g., lengths/flags). */
  responseMetaFromResponse?: (response: T) => Record<string, unknown> | undefined;
}

export type ApiType =
  | "llm" | "tts" | "stt" | "embedding" | "image" | "vector" | "moderation" | "tool" | "other";

export interface UsageMetrics {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  characters?: number;
  seconds?: number;
  requests?: number; // default 1
  unitsUsed?: number; // for unit-based providers if you use them
}

export interface RecordApiCallParams {
  // Identity
  providerId?: string;            // DB fk (preferred if you have it)
  providerKey?: string;           // e.g., "gemini" (used by costCalculator)
  providerNameHint?: string;      // e.g., "Google Gemini" (fallback for lookup)
  apiType?: ApiType;              // defaults to "llm"

  // Request/Response
  endpoint: string;               // e.g., "generateContent"
  model?: string;                 // e.g., "gemini-2.5-pro"
  requestData?: unknown;          // will be sanitized before storing
  responseMetadata?: Record<string, unknown>;

  // Usage + costs
  usage?: UsageMetrics;           // tokens, chars, seconds, requests, etc.

  // UX + ownership
  userId?: string;
  sessionId?: string;
  promptId?: string;

  // Timing
  startedAtMs?: number;           // Date.now() right before the call
  durationMs?: number;            // if not given, computed from startedAtMs
  responseTimeMs?: number;        // kept for back-compat; will mirror durationMs

  // Outcome
  success?: boolean;              // default true
  errorMessage?: string;
}

// Used to extract data from API responses
export interface ApiUsageMetrics {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  characters?: number;
  seconds?: number;
  requests?: number;
}

// These two data structures for api calls should probably be merged
export interface ApiCallParams {
  providerId: string;
  endpoint: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number; // Fallback if input/output not available
  unitsUsed?: number;
  responseTimeMs?: number;
  userId?: string;
  sessionId?: string;
}

export interface ApiCallTrackingData {
  userId: string;
  promptId?: string;
  provider: string;
  endpoint: string;
  model?: string;
  requestData?: any;
  responseMetadata?: any;
  durationMs?: number;
  success?: boolean;
  errorMessage?: string;
}

export class ApiTracker {
  private providers: Map<string, ApiProvider> = new Map();

  async initialize() {
    // Load providers into memory for fast lookup
    const allProviders = await storage.getApiProviders();
    for (const provider of allProviders) {
      this.providers.set(provider.id, provider);
    }
  }

  /**
   * Calculate cost based on provider pricing rules using precise decimal arithmetic
   */
  private calculateCost(
    provider: ApiProvider, 
    inputTokens?: number, 
    outputTokens?: number,
    totalTokens?: number, 
    unitsUsed?: number
  ): {
    inputCostUsd: string;
    outputCostUsd: string;
    totalCostUsd: string;
  } {
    try {
      // Validate pricing JSON structure
      const validationResult = pricingJsonSchema.safeParse(provider.pricingJson);
      if (!validationResult.success) {
        console.warn(`Invalid pricing JSON for provider ${provider.name}:`, validationResult.error);
        return {
          inputCostUsd: '0.000000',
          outputCostUsd: '0.000000',
          totalCostUsd: '0.000000'
        };
      }

      const pricing = validationResult.data;

      if (pricing.cost_calculation === 'token_based') {
        const inputCostPer1k = new Decimal(pricing.input_cost_per_1k_tokens);
        const outputCostPer1k = new Decimal(pricing.output_cost_per_1k_tokens);
        
        let actualInputTokens = 0;
        let actualOutputTokens = 0;
        
        if (inputTokens !== undefined && outputTokens !== undefined) {
          // Use precise token counts when available
          actualInputTokens = inputTokens;
          actualOutputTokens = outputTokens;
        } else if (totalTokens) {
          // Fallback to 80/20 split only when precise counts unavailable
          actualInputTokens = Math.floor(totalTokens * 0.8);
          actualOutputTokens = Math.floor(totalTokens * 0.2);
        }
        
        const inputCost = new Decimal(actualInputTokens).div(1000).mul(inputCostPer1k);
        const outputCost = new Decimal(actualOutputTokens).div(1000).mul(outputCostPer1k);
        
        //return inputCost.add(outputCost).toFixed(6);
        return {
          inputCostUsd: inputCost.toFixed(6),
          outputCostUsd: outputCost.toFixed(6),
          totalCostUsd: inputCost.add(outputCost).toFixed(6)
        };
      } else if (pricing.cost_calculation === 'unit_based' && unitsUsed) {
        // For unit-based pricing
        const costPerUnit = new Decimal(pricing.cost_per_unit);
        //return new Decimal(unitsUsed).mul(costPerUnit).toFixed(6);
        return {
          inputCostUsd: '0.000000',
          outputCostUsd: '0.000000',
          totalCostUsd: new Decimal(unitsUsed).mul(costPerUnit).toFixed(6)
        }
      } else if (pricing.cost_calculation === 'fixed_cost') {
        // For fixed cost per call
        //return new Decimal(pricing.fixed_cost).toFixed(6);
        return {
          inputCostUsd: '0.000000',
          outputCostUsd: '0.000000',
          totalCostUsd: new Decimal(pricing.fixed_cost).toFixed(6)
        }
      }

      return {
        inputCostUsd: '0.000000',
        outputCostUsd: '0.000000',
        totalCostUsd: '0.000000'
      };
    } catch (error) {
      console.error(`Error calculating cost for provider ${provider.name}:`, error);
      return {
        inputCostUsd: '0.000000',
        outputCostUsd: '0.000000',
        totalCostUsd: '0.000000'
      };
    }
  }

  private resolveProviderId = (hint?: { id?: string, key?: string, name?: string } | string): string | null => {
    if (!hint) return null;
    // this.providers: Map<string, ApiProvider>
    // Try direct id hit
    if (typeof hint === "string") {
      if (this.providers?.has?.(hint)) return hint;
      const lower = hint.toLowerCase();
      const byNameOrKey = Array.from(this.providers?.values?.() ?? []).find(p =>
        p.id === hint ||
        p.name?.toLowerCase() === lower ||
        (p.key && p.key.toLowerCase() === lower)
      );
      return byNameOrKey?.id ?? null;
    }
    const { id, key, name } = hint;
    if (id && this.providers?.has?.(id)) return id;
    const lowerKey = key?.toLowerCase();
    const lowerName = name?.toLowerCase();
    const m = Array.from(this.providers?.values?.() ?? []).find(p =>
      (lowerKey && p.key?.toLowerCase() === lowerKey) ||
      (lowerName && p.name?.toLowerCase() === lowerName)
    );
    return m?.id ?? null;
  };
  
  private toFixed6 = (v: string | number | undefined) =>
    (v == null ? "0.000000" : Number(v).toFixed(6));
  
  /** Single source of truth for writing api_calls and computing cost */
  public async recordApiCall(params: RecordApiCallParams): Promise<void> {
    try {
      const {
        providerId: givenProviderId,
        providerKey,
        providerNameHint,
        apiType = "llm",
        endpoint,
        model,
        requestData,
        responseMetadata,
        usage = {},
        userId,
        sessionId,
        promptId,
        startedAtMs,
        durationMs: givenDuration,
        responseTimeMs: givenResponseTime,
        success = true,
        errorMessage
      } = params;
  
      // Resolve provider id if needed
      let providerId = givenProviderId
        ?? this.resolveProviderId(
             providerKey
               ?? (providerNameHint ? providerNameHint : undefined)
           );
      if (!providerId) {
        console.warn(`[recordApiCall] Could not resolve providerId for key/name:`, providerKey || providerNameHint);
        return; // bail safely
      }
  
      // Compute duration if needed
      const now = Date.now();
      const durationMs = givenDuration ?? (startedAtMs ? (now - startedAtMs) : undefined);
      const responseTimeMs = givenResponseTime ?? durationMs;
  
      // Normalize usage + defaults
      const normalizedUsage: UsageMetrics = {
        requests: usage.requests ?? 1,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        characters: usage.characters,
        seconds: usage.seconds,
        unitsUsed: usage.unitsUsed,
      };
  
      // Cost via ONE engine (costCalculatorService.ts)
      let inputCostUsd = "0.000000";
      let outputCostUsd = "0.000000";
      let totalCostUsd = "0.000000";
      try {
        const cost = await costCalculator.calculateCost({
          provider: providerKey || (providerNameHint ? providerNameHint.toLowerCase() : ""), // pricing catalog key
          model,
          endpoint,
          inputTokens: normalizedUsage.inputTokens,
          outputTokens: normalizedUsage.outputTokens,
          totalTokens: normalizedUsage.totalTokens,
          characters: normalizedUsage.characters,
          seconds: normalizedUsage.seconds,
          requests: normalizedUsage.requests,
        });
        // Persist with 6 decimals (your NUMERIC(20,6))
        inputCostUsd  = this.toFixed6(cost.inputCostUsd);
        outputCostUsd = this.toFixed6(cost.outputCostUsd);
        totalCostUsd  = this.toFixed6(cost.totalCostUsd);
      } catch (e) {
        console.warn(`[recordApiCall] cost calculation failed for ${providerKey}/${model}/${endpoint}:`, e);
      }
  
      // Build insert payload
      const apiCallData: InsertApiCall = {
        providerId,
        apiType,
        endpoint,
        model,
  
        inputTokens: normalizedUsage.inputTokens ?? null,
        outputTokens: normalizedUsage.outputTokens ?? null,
        totalTokens: normalizedUsage.totalTokens ?? null,
        characters: normalizedUsage.characters ?? null,
        seconds: normalizedUsage.seconds ?? null,
        unitsUsed: normalizedUsage.unitsUsed ?? null,
        requests: normalizedUsage.requests ?? 1,
  
        inputCostUsd,
        outputCostUsd,
        totalCostUsd,
  
        requestData: this.sanitizeRequestData(requestData),
        responseMetadata: responseMetadata ?? null,
  
        durationMs: durationMs ?? null,
        responseTimeMs: responseTimeMs ?? null,
  
        success,
        errorMessage: errorMessage ? errorMessage.slice(0, 500) : null,
  
        userId: userId ?? null,
        sessionId: sessionId ?? null,
        promptId: promptId ?? null,
      };
  
      await storage.createApiCall(apiCallData);
    } catch (e) {
      // Absolute last-ditch guard: do not disrupt main flow
      console.error("[recordApiCall] unexpected failure:", e);
    }
  }
  
  /**
   * Extract usage metrics from Gemini response
   */
  extractGeminiUsageMetrics(response: any): ApiUsageMetrics {
    try {
      // Gemini API returns usage metadata in the response
      const usageMetadata = response.usageMetadata || response.usage || {};
      
      return {
        inputTokens: usageMetadata.promptTokenCount || usageMetadata.inputTokens || 0,
        outputTokens: usageMetadata.candidatesTokenCount || usageMetadata.outputTokens || 0,
        totalTokens: usageMetadata.totalTokenCount || usageMetadata.totalTokens || 
                    (usageMetadata.promptTokenCount || 0) + (usageMetadata.candidatesTokenCount || 0),
        requests: 1
      };
    } catch (error) {
      console.warn("Failed to extract Gemini usage metrics:", error);
      return { requests: 1 };
    }
  }
  
  /**
   * Wrapper for Gemini API calls with tracking
   */
  async trackGeminiCall<T>(
    callFunction: () => Promise<T>,
    endpoint: string,
    model: string = "gemini-2.5-pro",
    inputTokens?: number,
    outputTokens?: number,
    estimatedTokens?: number,
    userId?: string,
    sessionId?: string
  ): Promise<T> {
    return this.timeAndRecord<T>(callFunction, {
      providerKey: "gemini",
      providerNameHint: "Google Gemini", // helps resolve providerId
      apiType: "llm",
      endpoint,
      model,
      userId,
      sessionId,
      // If tokens were passed in, use them as a fallback:
      usage: (inputTokens != null || outputTokens != null || estimatedTokens != null)
        ? { inputTokens, outputTokens, totalTokens: estimatedTokens, requests: 1 }
        : undefined,
      // Otherwise, try to get usage from the response:
      usageFromResponse: (response: any) => this.extractGeminiUsageMetrics(response),
    });
  }

  /**
   * Get usage statistics for admin dashboard
   */
  async getUsageStats(): Promise<ApiUsageStats> {
    const stats = await storage.getApiUsageStats();
    return stats;
  }

  /**
   * Refresh provider cache
   */
  async refreshProviders(): Promise<void> {
    await this.initialize();
  }


  /**
   * Sanitize request data to remove sensitive information
   */
  private sanitizeRequestData(requestData: any): any {
    if (!requestData) return null;

    try {
      // Create a deep copy and remove sensitive fields
      const sanitized = JSON.parse(JSON.stringify(requestData));
      
      // Remove common sensitive fields
      const sensitiveFields = ['apiKey', 'token', 'password', 'secret', 'key', 'authorization'];
      
      const removeSensitiveFields = (obj: any): void => {
        if (typeof obj === 'object' && obj !== null) {
          for (const key of Object.keys(obj)) {
            if (sensitiveFields.some(field => key.toLowerCase().includes(field))) {
              obj[key] = '[REDACTED]';
            } else if (typeof obj[key] === 'object') {
              removeSensitiveFields(obj[key]);
            }
          }
        }
      };

      removeSensitiveFields(sanitized);
      return sanitized;

    } catch (error) {
      console.warn("Failed to sanitize request data:", error);
      return { error: "Failed to sanitize request data" };
    }
  }

  /** Wrap an API call, then write one row no matter what (success/failure). */
  async timeAndRecord<T>(
    callFn: () => Promise<T>,
    opts: TimeAndRecordOptions<T>
  ): Promise<T> {
    const startedAtMs = Date.now();
    try {
      const res = await callFn();

      const usage = opts.usage ?? opts.usageFromResponse?.(res) ?? { requests: 1 };

      await this.recordApiCall({
        ...opts,
        startedAtMs,
        durationMs: Date.now() - startedAtMs,
        responseMetadata: {
          ...(opts.responseMetadata ?? {}),
          ...(opts.responseMetaFromResponse?.(res) ?? {}),
        },
        usage,
        success: true,
      });

      return res;
    } catch (err) {
      await this.recordApiCall({
        ...opts,
        startedAtMs,
        durationMs: Date.now() - startedAtMs,
        usage: { requests: 1 }, // we still count the failed request
        success: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err; // preserve behavior
    }
  }


  /**
   * Get API cost summary for a user
   */
  async getUserCostSummary(userId: string, days: number = 30): Promise<{
    totalCostUsd: number;
    callCount: number;
    averageCostPerCall: number;
    providerBreakdown: { [provider: string]: { cost: number; calls: number } };
  }> {
    try {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      
      const { calls } = await storage.getUserApiCalls(userId, 1000);
      const recentCalls = calls.filter(call => 
        call.createdAt && new Date(call.createdAt) >= startDate
      );

      let totalCostUsd = 0;
      const providerBreakdown: { [provider: string]: { cost: number; calls: number } } = {};

      for (const call of recentCalls) {
        const cost = parseFloat(call.totalCostUsd || "0");
        totalCostUsd += cost;

        if (!providerBreakdown[call.providerId]) {
          providerBreakdown[call.providerId] = { cost: 0, calls: 0 };
        }
        providerBreakdown[call.providerId].cost += cost;
        providerBreakdown[call.providerId].calls += 1;
      }

      return {
        totalCostUsd,
        callCount: recentCalls.length,
        averageCostPerCall: recentCalls.length > 0 ? totalCostUsd / recentCalls.length : 0,
        providerBreakdown
      };

    } catch (error) {
      console.error("Failed to get user cost summary:", error);
      return {
        totalCostUsd: 0,
        callCount: 0,
        averageCostPerCall: 0,
        providerBreakdown: {}
      };
    }
  }
}

// Singleton instance
export const apiTracker = new ApiTracker();

// Initialize the tracker when the module is loaded
apiTracker.initialize().catch(console.error);