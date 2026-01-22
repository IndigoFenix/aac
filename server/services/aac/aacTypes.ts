/**
 * AAC Types - Shared types for AAC services
 */

export interface ContextData {
  time: string;
  location?: string;
  visualContext?: string;
  userProfile?: {
    name: string;
    age?: number;
    preferences?: string;
  };
  recentHistory?: Array<{
    symbols: string[];
    timestamp: string;
  }>;
}

export interface SymbolSuggestion {
  id: string;
  label: string;
  emoji: string;
  confidence: number;
  reasoning: string;
  category?: string;
  priority?: number;
}
