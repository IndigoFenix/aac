import { storage } from "../storage";
import { ApiProviderPricing, InsertApiProviderPricing } from "@shared/schema";

export interface ApiUsageData {
  provider: string;
  model?: string;
  endpoint: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  characters?: number;
  seconds?: number;
  requests?: number;
}

export interface CostCalculationResult {
  inputCostUsd: string;
  outputCostUsd: string;
  totalCostUsd: string;
  pricingModel: ApiProviderPricing;
}

export class CostCalculatorService {
  private static instance: CostCalculatorService;
  private pricingCache: Map<string, ApiProviderPricing[]> = new Map();
  private cacheExpiry: Map<string, number> = new Map();
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

  public static getInstance(): CostCalculatorService {
    if (!CostCalculatorService.instance) {
      CostCalculatorService.instance = new CostCalculatorService();
    }
    return CostCalculatorService.instance;
  }

  /**
   * Initialize default pricing models for supported providers
   */
  async initializeDefaultPricing(): Promise<void> {
    try {
      // Gemini pricing (as of 2024)
      const geminiPricing: InsertApiProviderPricing[] = [
        {
          provider: "gemini",
          model: "gemini-2.5-flash",
          endpoint: "generateContent",
          pricingType: "per_token",
          inputPricePerUnit: "0.000000075", // $0.075 per 1M tokens
          outputPricePerUnit: "0.0000003", // $0.30 per 1M tokens
          currency: "USD",
          effectiveFrom: new Date("2024-01-01"),
          isActive: true,
          notes: "Gemini 2.5 Flash - Input: $0.075/1M tokens, Output: $0.30/1M tokens"
        },
        {
          provider: "gemini",
          model: "gemini-2.5-pro",
          endpoint: "generateContent",
          pricingType: "per_token",
          inputPricePerUnit: "0.00000125", // $1.25 per 1M tokens
          outputPricePerUnit: "0.000005", // $5.00 per 1M tokens
          currency: "USD",
          effectiveFrom: new Date("2024-01-01"),
          isActive: true,
          notes: "Gemini 2.5 Pro - Input: $1.25/1M tokens, Output: $5.00/1M tokens"
        },
        {
          provider: "gemini",
          model: "gemini-2.0-flash-preview-image-generation",
          endpoint: "generateContent",
          pricingType: "per_request",
          inputPricePerUnit: "0.0025", // $0.0025 per image
          outputPricePerUnit: "0", 
          currency: "USD",
          effectiveFrom: new Date("2024-12-01"),
          isActive: true,
          notes: "Gemini 2.0 Flash Image Generation - $0.0025 per image"
        }
      ];

      // Check if pricing already exists, if not, create it
      for (const pricing of geminiPricing) {
        const existing = await storage.getApiProviderPricing(pricing.provider, pricing.model || "", pricing.endpoint || undefined);
        if (!existing) {
          await storage.createApiProviderPricing(pricing);
          console.log(`Created pricing for ${pricing.provider} ${pricing.model} ${pricing.endpoint}`);
        }
      }

      // Clear cache after initialization
      this.clearCache();

    } catch (error) {
      console.error("Failed to initialize default pricing:", error);
    }
  }

  /**
   * Calculate cost for API usage
   */
  async calculateCost(usageData: ApiUsageData): Promise<CostCalculationResult> {
    try {
      const pricingModel = await this.getPricingModel(
        usageData.provider,
        usageData.model || "",
        usageData.endpoint
      );

      if (!pricingModel) {
        throw new Error(`No pricing model found for ${usageData.provider} ${usageData.model} ${usageData.endpoint}`);
      }

      let inputCost = 0;
      let outputCost = 0;

      switch (pricingModel.pricingType) {
        case "per_token":
          inputCost = this.calculateTokenCost(
            usageData.inputTokens || 0,
            parseFloat(pricingModel.inputPricePerUnit || "0")
          );
          outputCost = this.calculateTokenCost(
            usageData.outputTokens || 0,
            parseFloat(pricingModel.outputPricePerUnit || "0")
          );
          break;

        case "per_character":
          inputCost = this.calculateCharacterCost(
            usageData.characters || 0,
            parseFloat(pricingModel.inputPricePerUnit || "0")
          );
          break;

        case "per_second":
          inputCost = this.calculateSecondCost(
            usageData.seconds || 0,
            parseFloat(pricingModel.inputPricePerUnit || "0")
          );
          break;

        case "per_request":
          inputCost = this.calculateRequestCost(
            usageData.requests || 1,
            parseFloat(pricingModel.inputPricePerUnit || "0")
          );
          break;

        default:
          throw new Error(`Unsupported pricing type: ${pricingModel.pricingType}`);
      }

      const totalCost = inputCost + outputCost;

      return {
        inputCostUsd: inputCost.toFixed(8),
        outputCostUsd: outputCost.toFixed(8),
        totalCostUsd: totalCost.toFixed(8),
        pricingModel
      };

    } catch (error) {
      console.error("Cost calculation failed:", error);
      throw error;
    }
  }

  /**
   * Get pricing model for a specific provider/model/endpoint
   */
  private async getPricingModel(
    provider: string,
    model: string,
    endpoint: string
  ): Promise<ApiProviderPricing | null> {
    try {
      const cacheKey = `${provider}-${model}-${endpoint}`;
      const now = Date.now();

      // Check cache first
      if (this.pricingCache.has(cacheKey)) {
        const expiry = this.cacheExpiry.get(cacheKey) || 0;
        if (now < expiry) {
          const cached = this.pricingCache.get(cacheKey);
          return cached?.[0] || null;
        }
      }

      // Fetch from storage
      const pricing = await storage.getApiProviderPricing(provider, model, endpoint || undefined);
      
      if (pricing) {
        // Cache the result
        this.pricingCache.set(cacheKey, [pricing]);
        this.cacheExpiry.set(cacheKey, now + this.CACHE_DURATION);
      }

      return pricing;

    } catch (error) {
      console.error("Failed to get pricing model:", error);
      return null;
    }
  }

  /**
   * Calculate cost for token-based pricing
   */
  private calculateTokenCost(tokens: number, pricePerToken: number): number {
    return tokens * pricePerToken;
  }

  /**
   * Calculate cost for character-based pricing
   */
  private calculateCharacterCost(characters: number, pricePerCharacter: number): number {
    return characters * pricePerCharacter;
  }

  /**
   * Calculate cost for second-based pricing (audio services)
   */
  private calculateSecondCost(seconds: number, pricePerSecond: number): number {
    return seconds * pricePerSecond;
  }

  /**
   * Calculate cost for request-based pricing
   */
  private calculateRequestCost(requests: number, pricePerRequest: number): number {
    return requests * pricePerRequest;
  }

  /**
   * Update pricing model
   */
  async updatePricing(pricingData: InsertApiProviderPricing): Promise<ApiProviderPricing> {
    try {
      // Deactivate existing pricing for the same provider/model/endpoint
      await storage.deactivateApiProviderPricing(
        pricingData.provider,
        pricingData.model,
        pricingData.endpoint || undefined
      );

      // Create new pricing
      const newPricing = await storage.createApiProviderPricing(pricingData);

      // Clear cache
      this.clearCache();

      return newPricing;

    } catch (error) {
      console.error("Failed to update pricing:", error);
      throw error;
    }
  }

  /**
   * Get all active pricing models
   */
  async getAllActivePricing(): Promise<ApiProviderPricing[]> {
    try {
      return await storage.getAllActiveApiProviderPricing();
    } catch (error) {
      console.error("Failed to get all active pricing:", error);
      return [];
    }
  }

  /**
   * Clear pricing cache
   */
  private clearCache(): void {
    this.pricingCache.clear();
    this.cacheExpiry.clear();
  }

  /**
   * Estimate monthly cost based on usage patterns
   */
  async estimateMonthlyCost(
    provider: string,
    model: string,
    endpoint: string,
    estimatedMonthlyUsage: Partial<ApiUsageData>
  ): Promise<number> {
    try {
      const usageData: ApiUsageData = {
        provider,
        model,
        endpoint,
        inputTokens: estimatedMonthlyUsage.inputTokens || 0,
        outputTokens: estimatedMonthlyUsage.outputTokens || 0,
        characters: estimatedMonthlyUsage.characters || 0,
        seconds: estimatedMonthlyUsage.seconds || 0,
        requests: estimatedMonthlyUsage.requests || 0
      };

      const cost = await this.calculateCost(usageData);
      return parseFloat(cost.totalCostUsd);

    } catch (error) {
      console.error("Failed to estimate monthly cost:", error);
      return 0;
    }
  }
}

// Export singleton instance
export const costCalculator = CostCalculatorService.getInstance();