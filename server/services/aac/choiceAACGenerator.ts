import { GoogleGenAI } from "@google/genai";
import type { ChoiceClassification } from "./choiceClassifier";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "" });

interface AACOption {
  label: string;
  emoji: string;
  confidence: number;
  category?: string;
}

interface GenerationContext {
  timeOfDay?: string;
  dayOfWeek?: string;
  location?: string;
  userAge?: number;
  userInterests?: string[];
}

export class ChoiceAACGenerator {
  /**
   * Generate AAC options for a choice classification
   * @param classification - The choice classification result
   * @param studentId - The student's ID (used for personalization)
   * @param language - The language for the AAC options
   * @param context - Additional context for generation
   */
  async generateAACOptions(
    classification: ChoiceClassification,
    studentId: string,
    language: 'en' | 'he' = 'en',
    context: GenerationContext = {}
  ): Promise<{ suggestions: AACOption[] }> {
    try {
      console.log('Generating AAC options for choice:', classification.originalText);

      const isHebrew = language === 'he';
      const systemPrompt = isHebrew
        ? this.buildHebrewSystemPrompt()
        : this.buildEnglishSystemPrompt();

      const userPrompt = this.buildUserPrompt(classification, context, isHebrew);

      let suggestions: AACOption[] = [];

      // Use Gemini for AAC generation
        try {
          const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            config: {
              systemInstruction: systemPrompt,
              responseMimeType: "application/json",
              responseSchema: {
                type: "object",
                properties: {
                  suggestions: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        label: { type: "string" },
                        emoji: { type: "string" },
                        confidence: { type: "number" },
                        category: { type: "string" }
                      },
                      required: ["label", "emoji", "confidence"]
                    }
                  }
                },
                required: ["suggestions"]
              }
            },
            contents: userPrompt
          });

          const responseText = response.text;
          if (responseText) {
            const parsed = JSON.parse(responseText);
            suggestions = parsed.suggestions || [];
            console.log('Gemini generated AAC options:', suggestions.length);
          }
        } catch (geminiError) {
          console.error('Gemini failed:', geminiError);
          return this.getFallbackOptions(classification, language);
        }

      // Filter and validate suggestions
      const validSuggestions = suggestions
        .filter(s => s.label && s.emoji && s.confidence >= 0.3)
        .slice(0, 6) // Max 6 options
        .map(s => ({
          ...s,
          confidence: Math.min(s.confidence, 1.0) // Cap at 1.0
        }));

      console.log('Final AAC suggestions:', validSuggestions);
      return { suggestions: validSuggestions };

    } catch (error) {
      console.error('AAC generation error:', error);
      return this.getFallbackOptions(classification, language);
    }
  }

  private buildEnglishSystemPrompt(): string {
    return `You are an AAC (Augmentative and Alternative Communication) assistant that generates relevant communication options for choice questions.

Your job is to analyze a choice question and provide appropriate AAC symbol options that allow someone to respond naturally.

Guidelines:
- Generate 2-6 clear, simple AAC options based on the detected choice
- Each option should have a clear label, appropriate emoji, and confidence score (0.0-1.0)
- For choice offers (like "pizza or pasta"), include the specific choices mentioned
- For yes/no questions, include "yes", "no", and potentially "maybe" options
- Include common social responses like "I don't know", "help me choose" when appropriate
- Use simple, clear language suitable for AAC users
- Confidence should reflect how likely the option is to be relevant
- Categories can be: food, activity, emotion, social, preference, other

Respond in JSON format with a "suggestions" array.`;
  }

  private buildHebrewSystemPrompt(): string {
    return `אתה עוזר AAC (תקשורת תומכת ומחליפה) שיוצר אפשרויות תקשורת רלוונטיות לשאלות בחירה.

התפקיד שלך הוא לנתח שאלת בחירה ולספק אפשרויות סמלי AAC מתאימות שמאפשרות למישהו להגיב באופן טבעי.

הנחיות:
- צור 2-6 אפשרויות AAC ברורות ופשוטות על בסיס הבחירה שזוהתה
- כל אפשרות צריכה להיות עם תווית ברורה, אימוג'י מתאים וציון ביטחון (0.0-1.0)
- עבור הצעות בחירה (כמו "פיצה או פסטה"), כלול את הבחירות הספציפיות שהוזכרו
- עבור שאלות כן/לא, כלול "כן", "לא" ואולי "אולי"
- כלול תגובות חברתיות נפוצות כמו "אני לא יודע/ת", "תעזור/י לי לבחור"
- השתמש בשפה פשוטה וברורה המתאימה למשתמשי AAC
- הביטחון צריך לשקף כמה סביר שהאפשרות תהיה רלוונטית

הגב בפורמט JSON עם מערך "suggestions".`;
  }

  private buildUserPrompt(
    classification: ChoiceClassification,
    context: GenerationContext,
    isHebrew: boolean
  ): string {
    const contextInfo = [
      context.timeOfDay && `Time: ${context.timeOfDay}`,
      context.dayOfWeek && `Day: ${context.dayOfWeek}`,
      context.location && `Location: ${context.location}`,
      context.userAge && `User age: ${context.userAge}`
    ].filter(Boolean).join(', ');

    if (isHebrew) {
      return `נתח את השאלה הזו וצור אפשרויות AAC מתאימות:

שאלה: "${classification.originalText}"
סוג: ${classification.intent}
נמען: ${classification.addressee}
רמת ביטחון: ${classification.confidence}
תחום: ${classification.domain || 'כללי'}
${contextInfo ? `הקשר: ${contextInfo}` : ''}

צור אפשרויות AAC שיעזרו לילד להגיב לשאלה הזו.`;
    }

    return `Analyze this question and generate appropriate AAC options:

Question: "${classification.originalText}"
Intent: ${classification.intent}
Addressee: ${classification.addressee}
Confidence: ${classification.confidence}
Domain: ${classification.domain || 'general'}
${contextInfo ? `Context: ${contextInfo}` : ''}

Generate AAC options that would help a child respond to this question.`;
  }

  private getFallbackOptions(
    classification: ChoiceClassification,
    language: 'en' | 'he'
  ): { suggestions: AACOption[] } {
    const isHebrew = language === 'he';

    // Basic fallback options based on intent
    let fallbackOptions: AACOption[] = [];

    if (classification.intent === 'YES_NO_QUESTION') {
      fallbackOptions = isHebrew ? [
        { label: 'כן', emoji: '✅', confidence: 0.9 },
        { label: 'לא', emoji: '❌', confidence: 0.9 },
        { label: 'אולי', emoji: '🤔', confidence: 0.7 },
        { label: 'אני לא יודע', emoji: '🤷', confidence: 0.6 }
      ] : [
        { label: 'Yes', emoji: '✅', confidence: 0.9 },
        { label: 'No', emoji: '❌', confidence: 0.9 },
        { label: 'Maybe', emoji: '🤔', confidence: 0.7 },
        { label: "I don't know", emoji: '🤷', confidence: 0.6 }
      ];
    } else if (classification.intent === 'CHOICE_OFFER') {
      // Try to extract choices from the original text
      const text = classification.originalText.toLowerCase();
      if (text.includes('pizza') || text.includes('pasta')) {
        fallbackOptions = [
          { label: 'Pizza', emoji: '🍕', confidence: 0.8 },
          { label: 'Pasta', emoji: '🍝', confidence: 0.8 },
          { label: 'Both', emoji: '🤤', confidence: 0.6 },
          { label: 'Neither', emoji: '🙅', confidence: 0.5 }
        ];
      } else {
        fallbackOptions = isHebrew ? [
          { label: 'הראשון', emoji: '1️⃣', confidence: 0.7 },
          { label: 'השני', emoji: '2️⃣', confidence: 0.7 },
          { label: 'תעזור לי לבחור', emoji: '🤝', confidence: 0.6 }
        ] : [
          { label: 'First one', emoji: '1️⃣', confidence: 0.7 },
          { label: 'Second one', emoji: '2️⃣', confidence: 0.7 },
          { label: 'Help me choose', emoji: '🤝', confidence: 0.6 }
        ];
      }
    }

    console.log('Using fallback AAC options:', fallbackOptions.length);
    return { suggestions: fallbackOptions };
  }
}

export const choiceAACGenerator = new ChoiceAACGenerator();
