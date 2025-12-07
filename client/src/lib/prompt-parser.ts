export interface ParsedPrompt {
  gridSize: { rows: number; cols: number };
  buttons: Array<{
    label: string;
    spokenText?: string;
    color?: string;
    icon?: string;
    position?: { row: number; col: number };
  }>;
  theme?: string;
}

const commonAACWords = [
  { word: "eat", icon: "fas fa-utensils", color: "#3B82F6", category: "needs" },
  { word: "drink", icon: "fas fa-glass-water", color: "#06B6D4", category: "needs" },
  { word: "bathroom", icon: "fas fa-restroom", color: "#8B5CF6", category: "needs" },
  { word: "toilet", icon: "fas fa-restroom", color: "#8B5CF6", category: "needs" },
  { word: "more", icon: "fas fa-plus", color: "#10B981", category: "requests" },
  { word: "finished", icon: "fas fa-check", color: "#EF4444", category: "requests" },
  { word: "done", icon: "fas fa-check", color: "#EF4444", category: "requests" },
  { word: "yes", icon: "fas fa-thumbs-up", color: "#059669", category: "responses" },
  { word: "no", icon: "fas fa-thumbs-down", color: "#F59E0B", category: "responses" },
  { word: "help", icon: "fas fa-question", color: "#EAB308", category: "requests" },
  { word: "please", icon: "fas fa-hand", color: "#EC4899", category: "requests" },
  { word: "thank you", icon: "fas fa-heart", color: "#EC4899", category: "responses" },
  
  // Emotions
  { word: "happy", icon: "fas fa-smile", color: "#F59E0B", category: "emotions" },
  { word: "sad", icon: "fas fa-frown", color: "#3B82F6", category: "emotions" },
  { word: "angry", icon: "fas fa-angry", color: "#EF4444", category: "emotions" },
  { word: "scared", icon: "fas fa-frown-open", color: "#6B7280", category: "emotions" },
  { word: "excited", icon: "fas fa-grin-stars", color: "#F59E0B", category: "emotions" },
  
  // Family
  { word: "mom", icon: "fas fa-female", color: "#EC4899", category: "people" },
  { word: "mother", icon: "fas fa-female", color: "#EC4899", category: "people" },
  { word: "dad", icon: "fas fa-male", color: "#3B82F6", category: "people" },
  { word: "father", icon: "fas fa-male", color: "#3B82F6", category: "people" },
  { word: "sister", icon: "fas fa-child", color: "#EC4899", category: "people" },
  { word: "brother", icon: "fas fa-child", color: "#3B82F6", category: "people" },
  { word: "family", icon: "fas fa-home", color: "#10B981", category: "people" },
  
  // Activities
  { word: "play", icon: "fas fa-gamepad", color: "#F59E0B", category: "activities" },
  { word: "read", icon: "fas fa-book", color: "#3B82F6", category: "activities" },
  { word: "music", icon: "fas fa-music", color: "#8B5CF6", category: "activities" },
  { word: "tv", icon: "fas fa-tv", color: "#6B7280", category: "activities" },
  { word: "watch", icon: "fas fa-eye", color: "#6B7280", category: "activities" },
  { word: "listen", icon: "fas fa-headphones", color: "#8B5CF6", category: "activities" },
  { word: "sleep", icon: "fas fa-bed", color: "#6B7280", category: "activities" },
  
  // Common objects
  { word: "book", icon: "fas fa-book", color: "#3B82F6", category: "objects" },
  { word: "toy", icon: "fas fa-cube", color: "#F59E0B", category: "objects" },
  { word: "phone", icon: "fas fa-phone", color: "#6B7280", category: "objects" },
  { word: "car", icon: "fas fa-car", color: "#EF4444", category: "objects" },
  { word: "home", icon: "fas fa-home", color: "#10B981", category: "places" },
  { word: "school", icon: "fas fa-school", color: "#3B82F6", category: "places" }
];

export function parsePrompt(prompt: string): ParsedPrompt {
  const lowerPrompt = prompt.toLowerCase();
  
  // Extract grid size
  const gridSize = extractGridSize(lowerPrompt);
  
  // Find matching words
  const foundWords = commonAACWords.filter(word => 
    lowerPrompt.includes(word.word.toLowerCase())
  );
  
  // Create buttons from found words
  const buttons = foundWords.map(word => ({
    label: capitalizeFirst(word.word),
    spokenText: `I ${word.word}`,
    color: word.color,
    icon: word.icon
  }));
  
  // Fill remaining slots with common words if needed
  const maxButtons = gridSize.rows * gridSize.cols;
  if (buttons.length < maxButtons) {
    const remainingWords = commonAACWords
      .filter(word => !foundWords.includes(word))
      .slice(0, maxButtons - buttons.length);
    
    remainingWords.forEach(word => {
      buttons.push({
        label: capitalizeFirst(word.word),
        spokenText: `I ${word.word}`,
        color: word.color,
        icon: word.icon
      });
    });
  }
  
  return {
    gridSize,
    buttons: buttons.slice(0, maxButtons)
  };
}

function extractGridSize(prompt: string): { rows: number; cols: number } {
  // Look for patterns like "3x3", "4x4", "3 by 3", etc.
  const gridPatterns = [
    /(\d+)\s*[x×]\s*(\d+)/i,
    /(\d+)\s*by\s*(\d+)/i,
    /(\d+)\s*grid/i
  ];
  
  for (const pattern of gridPatterns) {
    const match = prompt.match(pattern);
    if (match) {
      const rows = parseInt(match[1]);
      const cols = match[2] ? parseInt(match[2]) : rows;
      
      if (rows >= 1 && rows <= 10 && cols >= 1 && cols <= 10) {
        return { rows, cols };
      }
    }
  }
  
  // Default grid size
  return { rows: 3, cols: 3 };
}

function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
