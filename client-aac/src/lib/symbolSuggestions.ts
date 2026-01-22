import { apiRequest } from "./queryClient";

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
}

export async function getSymbolSuggestions(context: ContextData): Promise<SymbolSuggestion[]> {
  try {
    const response = await apiRequest("POST", "/api/aac/symbols/suggestions", { context });
    const data = await response.json();
    return data.suggestions || [];
  } catch (error) {
    console.error("Error fetching symbol suggestions:", error);
    return getDefaultSymbols();
  }
}

export async function interpretSymbolSequence(
  symbols: string[],
  context: ContextData
): Promise<string> {
  try {
    const response = await apiRequest("POST", "/api/aac/interpret", { symbols, context });
    const data = await response.json();
    return data.interpretation || symbols.join(" ");
  } catch (error) {
    console.error("Error interpreting symbols:", error);
    return symbols.join(" ");
  }
}

function getDefaultSymbols(): SymbolSuggestion[] {
  return [
    {
      id: "happy",
      label: "Happy",
      emoji: "😊",
      confidence: 0.8,
      reasoning: "Basic emotion symbol"
    },
    {
      id: "help",
      label: "Help",
      emoji: "🙋",
      confidence: 0.7,
      reasoning: "Common need"
    },
    {
      id: "more",
      label: "More",
      emoji: "➕",
      confidence: 0.6,
      reasoning: "Frequent request"
    },
    {
      id: "eat",
      label: "Eat",
      emoji: "🍽️",
      confidence: 0.5,
      reasoning: "Basic need"
    },
    {
      id: "play",
      label: "Play",
      emoji: "🎮",
      confidence: 0.4,
      reasoning: "Common activity"
    }
  ];
}
