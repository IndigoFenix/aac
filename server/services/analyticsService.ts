import { storage } from "../storage";
import { InsertPromptEvent } from "@shared/schema";

export class AnalyticsService {
  // Track prompt events
  async trackEvent(eventType: string, userId: string, promptId: string, eventData?: any) {
    try {
      const event: InsertPromptEvent = {
        promptId,
        userId,
        eventType,
        eventData: eventData || {}
      };
      
      await storage.createPromptEvent(event);
    } catch (error) {
      console.error('Failed to track analytics event:', error);
    }
  }

  // Auto-detect topic from prompt text
  detectTopic(prompt: string): string {
    const topics = {
      'basic-needs': ['eat', 'drink', 'bathroom', 'help', 'want', 'need', 'hungry', 'thirsty', 'toilet'],
      'emotions': ['happy', 'sad', 'angry', 'scared', 'excited', 'nervous', 'feelings', 'emotion'],
      'family': ['mom', 'dad', 'mother', 'father', 'sister', 'brother', 'family', 'grandma', 'grandpa'],
      'activities': ['play', 'game', 'read', 'watch', 'music', 'draw', 'color', 'dance', 'sing'],
      'school': ['school', 'teacher', 'homework', 'learn', 'study', 'class', 'book', 'pencil', 'math'],
      'social': ['friend', 'please', 'thank', 'sorry', 'hello', 'goodbye', 'share', 'turn'],
      'medical': ['doctor', 'nurse', 'medicine', 'hurt', 'pain', 'sick', 'hospital', 'therapy'],
      'food': ['food', 'breakfast', 'lunch', 'dinner', 'snack', 'apple', 'bread', 'milk', 'pizza'],
      'animals': ['dog', 'cat', 'bird', 'fish', 'animal', 'pet', 'zoo', 'farm'],
      'transportation': ['car', 'bus', 'train', 'plane', 'bike', 'walk', 'drive', 'go'],
      'weather': ['rain', 'sun', 'snow', 'cold', 'hot', 'weather', 'cloudy', 'windy']
    };

    const lowerPrompt = prompt.toLowerCase();
    const topicScores: { [key: string]: number } = {};

    // Count matches for each topic
    Object.entries(topics).forEach(([topic, keywords]) => {
      topicScores[topic] = keywords.reduce((count, keyword) => {
        return count + (lowerPrompt.includes(keyword) ? 1 : 0);
      }, 0);
    });

    // Find topic with highest score
    const bestTopic = Object.entries(topicScores).reduce((best, [topic, score]) => {
      return score > best.score ? { topic, score } : best;
    }, { topic: 'general', score: 0 });

    return bestTopic.score > 0 ? bestTopic.topic : 'general';
  }

  // Simple language detection
  detectLanguage(prompt: string): string {
    // Very basic language detection - in production would use a proper library
    const spanishWords = ['el', 'la', 'de', 'que', 'y', 'a', 'en', 'un', 'es', 'se', 'no', 'te', 'lo', 'le', 'da', 'su', 'por', 'son'];
    const frenchWords = ['le', 'de', 'et', 'à', 'un', 'il', 'être', 'et', 'en', 'avoir', 'que', 'pour', 'dans', 'ce', 'son', 'une'];
    
    const words = prompt.toLowerCase().split(/\s+/);
    let spanishScore = 0;
    let frenchScore = 0;
    
    words.forEach(word => {
      if (spanishWords.includes(word)) spanishScore++;
      if (frenchWords.includes(word)) frenchScore++;
    });
    
    if (spanishScore > frenchScore && spanishScore > 2) return 'es';
    if (frenchScore > spanishScore && frenchScore > 2) return 'fr';
    return 'en';
  }

  // Categorize error types
  categorizeError(errorMessage: string): string {
    if (!errorMessage) return 'unknown';
    
    const error = errorMessage.toLowerCase();
    if (error.includes('timeout') || error.includes('timed out')) return 'timeout';
    if (error.includes('rate limit') || error.includes('quota')) return 'rate_limit';
    if (error.includes('api') || error.includes('service')) return 'api_error';
    if (error.includes('validation') || error.includes('invalid')) return 'validation';
    if (error.includes('network') || error.includes('connection')) return 'network';
    if (error.includes('auth') || error.includes('unauthorized')) return 'auth';
    
    return 'other';
  }

  // Create excerpt for privacy (first 100 characters)
  createExcerpt(prompt: string): string {
    return prompt.length > 100 ? prompt.substring(0, 100) + '...' : prompt;
  }
}

export const analyticsService = new AnalyticsService();