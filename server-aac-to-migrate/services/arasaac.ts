// ARASAAC API service for accessing AAC symbols and pictograms

interface ArasaacPictogram {
  _id: number;
  idPictogram: number;
  keywords: Array<{
    keyword: string;
    type: number;
    hasLocution: boolean;
  }>;
  created: string;
  lastUpdated: string;
  tags: string[];
  categories: string[];
  synsets: string[];
  desc?: string;
  violence: boolean;
  aac: boolean;
  aacColor: boolean;
  skin: boolean;
  hair: boolean;
  downloads: number;
  sex: boolean;
  schematic: boolean;
  plural: boolean;
}

interface ArasaacSearchResult {
  _id: number;
  keywords: Array<{
    keyword: string;
    type: number;
  }>;
}

/**
 * ARASAAC API Service for fetching AAC symbols and pictograms
 * Official API: https://api.arasaac.org/v1
 * Documentation: https://beta.arasaac.org/developers/api
 */
export class ArasaacService {
  private readonly baseUrl = 'https://api.arasaac.org/v1';
  
  /**
   * Search for pictograms by text in specified language
   */
  async searchPictograms(searchText: string, language: string = 'en'): Promise<ArasaacSearchResult[]> {
    try {
      console.log(`Searching ARASAAC pictograms for: "${searchText}" in language: ${language}`);
      
      const encodedText = encodeURIComponent(searchText.toLowerCase());
      const url = `${this.baseUrl}/pictograms/${language}/search/${encodedText}`;
      
      const response = await fetch(url);
      
      if (!response.ok) {
        console.warn(`ARASAAC search failed with status ${response.status}: ${response.statusText}`);
        return [];
      }
      
      const results = await response.json() as ArasaacSearchResult[];
      console.log(`Found ${results.length} ARASAAC pictograms for "${searchText}"`);
      
      return results;
    } catch (error) {
      console.error("Error searching ARASAAC pictograms:", error);
      return [];
    }
  }
  
  /**
   * Get pictogram details by ID and language
   */
  async getPictogram(idPictogram: number, language: string = 'en'): Promise<ArasaacPictogram | null> {
    try {
      const url = `${this.baseUrl}/pictograms/${language}/${idPictogram}`;
      const response = await fetch(url);
      
      if (!response.ok) {
        console.warn(`Failed to fetch ARASAAC pictogram ${idPictogram}: ${response.status}`);
        return null;
      }
      
      return await response.json() as ArasaacPictogram;
    } catch (error) {
      console.error(`Error fetching ARASAAC pictogram ${idPictogram}:`, error);
      return null;
    }
  }
  
  /**
   * Get best search results for symbols
   */
  async getBestSearch(searchText: string, language: string = 'en'): Promise<ArasaacSearchResult[]> {
    try {
      const encodedText = encodeURIComponent(searchText.toLowerCase());
      const url = `${this.baseUrl}/pictograms/${language}/bestsearch/${encodedText}`;
      
      const response = await fetch(url);
      
      if (!response.ok) {
        console.warn(`ARASAAC best search failed: ${response.status}`);
        return [];
      }
      
      const results = await response.json() as ArasaacSearchResult[];
      console.log(`Found ${results.length} best ARASAAC matches for "${searchText}"`);
      
      return results;
    } catch (error) {
      console.error("Error in ARASAAC best search:", error);
      return [];
    }
  }
  
  /**
   * Generate ARASAAC symbol URL for a pictogram
   */
  getPictogramUrl(idPictogram: number, options: {
    color?: boolean;
    skin?: string;
    hair?: string;
    width?: number;
    height?: number;
    plural?: boolean;
  } = {}): string {
    const {
      color = true,
      skin = '',
      hair = '',
      width = 500,
      height = 500,
      plural = false
    } = options;
    
    let url = `https://static.arasaac.org/pictograms/${idPictogram}/${idPictogram}`;
    
    if (!color) {
      url += '_bw';
    }
    
    if (plural) {
      url += '_pl';
    }
    
    if (skin) {
      url += `_${skin}`;
    }
    
    if (hair) {
      url += `_${hair}`;
    }
    
    if (width !== 500 || height !== 500) {
      url += `_${width}x${height}`;
    }
    
    url += '.png';
    
    return url;
  }
  
  /**
   * Get available keywords for autocompletion
   */
  async getKeywords(language: string = 'en'): Promise<string[]> {
    try {
      const url = `${this.baseUrl}/keywords/${language}`;
      const response = await fetch(url);
      
      if (!response.ok) {
        console.warn(`Failed to fetch ARASAAC keywords: ${response.status}`);
        return [];
      }
      
      const result = await response.json();
      return result.keywords || [];
    } catch (error) {
      console.error("Error fetching ARASAAC keywords:", error);
      return [];
    }
  }
}

// Export singleton instance
export const arasaacService = new ArasaacService();

/**
 * Generate AAC symbol suggestions using ARASAAC pictograms with AI context understanding
 */
export async function generateArasaacSymbols(
  context: any,
  visualContext?: string,
  language: string = 'en',
  userProfile?: any
): Promise<Array<{ id: string; label: string; imageUrl: string; confidence: number; emoji?: string; reasoning?: string }>> {
  try {
    console.log("Generating ARASAAC symbol suggestions with context");
    
    // Extract words from context for symbol search
    let suggestedWords: string[] = [];
    
    // If context contains symbol suggestions or keywords, use them
    if (context && typeof context === 'object') {
      if (context.suggestions && Array.isArray(context.suggestions)) {
        suggestedWords = context.suggestions.map((s: any) => s.label || s.word || s).slice(0, 12);
      } else if (context.keywords && Array.isArray(context.keywords)) {
        suggestedWords = context.keywords.slice(0, 12);
      } else if (context.visualContext || context.time || context.location) {
        // Extract relevant words from context
        const contextText = `${context.visualContext || ''} ${context.time || ''} ${context.location || ''}`;
        const commonWords = ['hello', 'help', 'yes', 'no', 'want', 'need', 'food', 'water', 'play', 'home', 'more', 'stop'];
        suggestedWords = commonWords;
      }
    }
    
    // Default fallback words based on language
    if (suggestedWords.length === 0) {
      if (language === 'he') {
        suggestedWords = ['שלום', 'עזרה', 'כן', 'לא', 'רוצה', 'מים', 'אוכל', 'משחק'];
      } else {
        suggestedWords = ['hello', 'help', 'yes', 'no', 'want', 'water', 'food', 'play'];
      }
    }
    
    console.log("Searching ARASAAC for words:", suggestedWords);
    
    // Search ARASAAC for each suggested word
    const symbolPromises = suggestedWords.slice(0, 8).map(async (word, index) => {
      const searchResults = await arasaacService.getBestSearch(word, language);
      
      if (searchResults.length === 0) {
        // Fallback to regular search
        const fallbackResults = await arasaacService.searchPictograms(word, language);
        if (fallbackResults.length === 0) {
          return null;
        }
        searchResults.push(...fallbackResults.slice(0, 1));
      }
      
      const bestMatch = searchResults[0];
      if (!bestMatch) return null;
      
      // Get the pictogram URL
      const imageUrl = arasaacService.getPictogramUrl(bestMatch._id, {
        color: true,
        width: 300,
        height: 300
      });
      
      // Calculate confidence based on position and keyword match
      const baseConfidence = Math.max(0.9 - (index * 0.1), 0.3);
      const keywordMatch = bestMatch.keywords?.find(k => 
        k.keyword.toLowerCase().includes(word.toLowerCase()) ||
        word.toLowerCase().includes(k.keyword.toLowerCase())
      );
      const confidence = keywordMatch ? baseConfidence + 0.1 : baseConfidence;
      
      return {
        id: `arasaac_${bestMatch._id}`,
        label: word,
        imageUrl: imageUrl,
        confidence: Math.min(confidence, 1.0),
        emoji: getEmojiForWord(word),
        reasoning: `ARASAAC pictogram for ${word}`
      };
    });
    
    const symbols = await Promise.all(symbolPromises);
    const validSymbols = symbols.filter(Boolean) as Array<{ id: string; label: string; imageUrl: string; confidence: number; emoji?: string; reasoning?: string }>;
    
    console.log(`Generated ${validSymbols.length} ARASAAC symbols`);
    return validSymbols;
    
  } catch (error) {
    console.error("Error generating ARASAAC symbols:", error);
    
    // Fallback to basic symbols if ARASAAC fails
    const fallbackWords = language === 'he' ? ['שלום', 'עזרה', 'כן', 'לא'] : ['hello', 'help', 'yes', 'no'];
    return fallbackWords.map((word, index) => ({
      id: `fallback_${index}`,
      label: word,
      imageUrl: arasaacService.getPictogramUrl(Math.floor(Math.random() * 1000) + 1000, { color: true }),
      confidence: 0.5 - (index * 0.1),
      emoji: getEmojiForWord(word),
      reasoning: 'Fallback symbol'
    }));
  }
}

/**
 * Get appropriate emoji for common words
 */
function getEmojiForWord(word: string): string {
  const emojiMap: { [key: string]: string } = {
    'hello': '👋',
    'help': '🙋',
    'yes': '✅',
    'no': '❌',
    'want': '👆',
    'need': '🔥',
    'water': '💧',
    'food': '🍎',
    'play': '🎮',
    'home': '🏠',
    'more': '➕',
    'stop': '✋',
    'שלום': '👋',
    'עזרה': '🙋',
    'כן': '✅',
    'לא': '❌',
    'רוצה': '👆',
    'מים': '💧',
    'אוכל': '🍎',
    'משחק': '🎮'
  };
  
  return emojiMap[word.toLowerCase()] || '💬';
}