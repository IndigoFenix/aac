import { GoogleGenAI } from '@google/genai';
import { OpenAI } from 'openai';

// Initialize AI clients
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

export interface ChoiceClassification {
  addressee: 'child' | 'other';
  confidence: number;
  intent: 'CHOICE_OFFER' | 'YES_NO_QUESTION' | 'NONE';
  domain?: string;
  context?: string;
  originalText: string;
  language: 'en' | 'he';
  suggestedOptions?: string[];
}

export class ChoiceClassifierService {
  private isGeminiAvailable = true;
  private isOpenAIAvailable = true;

  /**
   * Classify audio transcript to detect choice questions
   */
  async classifyChoice(transcript: string, language: 'en' | 'he' = 'en'): Promise<ChoiceClassification> {
    if (!transcript || transcript.trim().length === 0) {
      return {
        addressee: 'other',
        confidence: 0,
        intent: 'NONE',
        originalText: transcript,
        language
      };
    }

    try {
      // Try Gemini first (primary)
      if (this.isGeminiAvailable) {
        try {
          return await this.classifyWithGemini(transcript, language);
        } catch (error) {
          console.error('Gemini classification failed, falling back to OpenAI:', error);
          this.isGeminiAvailable = false;
        }
      }

      // Fallback to OpenAI
      if (this.isOpenAIAvailable) {
        try {
          return await this.classifyWithOpenAI(transcript, language);
        } catch (error) {
          console.error('OpenAI classification failed:', error);
          this.isOpenAIAvailable = false;
        }
      }

      // If both fail, return basic classification
      return this.basicClassification(transcript, language);

    } catch (error) {
      console.error('Choice classification error:', error);
      return {
        addressee: 'other',
        confidence: 0,
        intent: 'NONE',
        originalText: transcript,
        language
      };
    }
  }

  /**
   * Classify using Gemini API
   */
  private async classifyWithGemini(transcript: string, language: 'en' | 'he'): Promise<ChoiceClassification> {
    const prompt = this.buildClassificationPrompt(transcript, language);

    const response = await genAI.models.generateContent({
      model: "gemini-2.5-flash",
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            addressee: {
              type: "string",
              enum: ["child", "other"]
            },
            confidence: {
              type: "number",
              minimum: 0,
              maximum: 1
            },
            intent: {
              type: "string",
              enum: ["CHOICE_OFFER", "YES_NO_QUESTION", "NONE"]
            },
            domain: { type: "string" },
            context: { type: "string" },
            suggestedOptions: {
              type: "array",
              items: { type: "string" }
            }
          },
          required: ["addressee", "confidence", "intent"]
        }
      },
      contents: prompt
    });

    const result = JSON.parse(response.text || "{}");

    return {
      ...result,
      originalText: transcript,
      language
    };
  }

  /**
   * Classify using OpenAI API
   */
  private async classifyWithOpenAI(transcript: string, language: 'en' | 'he'): Promise<ChoiceClassification> {
    const prompt = this.buildClassificationPrompt(transcript, language);

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are an expert in analyzing speech for AAC (Augmentative and Alternative Communication) applications. Return only valid JSON responses."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.3
    });

    const result = JSON.parse(response.choices[0].message.content || "{}");

    return {
      ...result,
      originalText: transcript,
      language
    };
  }

  /**
   * Build classification prompt for AI models
   */
  private buildClassificationPrompt(transcript: string, language: 'en' | 'he'): string {
    const examples = language === 'he' ? {
      choiceOffer: [
        'מה אתה רוצה לאכול?',
        'רוצה מים או מיץ?',
        'איפה נלך היום?',
        'תשחק או תקרא?'
      ],
      yesNoQuestion: [
        'רוצה עוד?',
        'אתה רעב?',
        'נלך החוצה?',
        'זה טעים?'
      ],
      notAddressed: [
        'איך היה לך היום?',
        'תביא לי מים',
        'תגיד לאבא שאני כאן',
        'מה השעה?'
      ]
    } : {
      choiceOffer: [
        'What do you want to eat?',
        'Would you like water or juice?',
        'Where should we go today?',
        'Do you want to play or read?'
      ],
      yesNoQuestion: [
        'Do you want more?',
        'Are you hungry?',
        'Should we go outside?',
        'Is it tasty?'
      ],
      notAddressed: [
        'How was your day?',
        'Bring me some water',
        'Tell dad I\'m here',
        'What time is it?'
      ]
    };

    return `Analyze this speech transcript to determine if it's a choice question addressed to a nonverbal child who uses AAC (Augmentative and Alternative Communication).

TRANSCRIPT: "${transcript}"
LANGUAGE: ${language}

Your task:
1. Determine if this is addressed to the CHILD (the AAC user) or to someone else
2. Classify the intent as one of:
   - CHOICE_OFFER: Offering multiple specific options to choose from
   - YES_NO_QUESTION: A simple yes/no question
   - NONE: Not a choice question or not addressed to child

3. If it's a choice question, identify:
   - domain: food, drink, activity, clothing, location, toy, etc.
   - context: breakfast, lunch, dinner, snack, playtime, bedtime, etc.
   - suggestedOptions: 4-6 specific options that would be appropriate

EXAMPLES:
${language === 'he' ? 'Hebrew' : 'English'} Choice Offers: ${examples.choiceOffer.join(', ')}
${language === 'he' ? 'Hebrew' : 'English'} Yes/No Questions: ${examples.yesNoQuestion.join(', ')}
${language === 'he' ? 'Hebrew' : 'English'} Not Addressed to Child: ${examples.notAddressed.join(', ')}

Consider:
- Tone and context clues
- Whether it's likely addressed to a child vs. adult
- Cultural context for ${language === 'he' ? 'Hebrew' : 'English'} speakers
- Time-sensitive appropriateness (meal times, activities)

Return JSON with this structure:
{
  "addressee": "child" | "other",
  "confidence": 0.0-1.0,
  "intent": "CHOICE_OFFER" | "YES_NO_QUESTION" | "NONE",
  "domain": "food|drink|activity|clothing|location|toy|other",
  "context": "breakfast|lunch|dinner|snack|playtime|bedtime|other",
  "suggestedOptions": ["option1", "option2", "option3", "option4", "option5", "option6"]
}`;
  }

  /**
   * Basic pattern-based classification fallback
   */
  private basicClassification(transcript: string, language: 'en' | 'he'): ChoiceClassification {
    const text = transcript.toLowerCase().trim();

    // Hebrew patterns
    if (language === 'he') {
      const hebrewChoicePatterns = [
        /מה (אתה|את) רוצ/,
        /איפה (נלך|תרצ)/,
        /(או|אם) (אתה|את)/,
        /רוצ.*או/,
        /תשחק או/,
        /נלך או/
      ];

      const hebrewYesNoPatterns = [
        /רוצה/,
        /(אתה|את) רעב/,
        /זה טעים/,
        /נלך/,
        /תשתה/
      ];

      for (const pattern of hebrewChoicePatterns) {
        if (pattern.test(text)) {
          return {
            addressee: 'child',
            confidence: 0.7,
            intent: 'CHOICE_OFFER',
            domain: this.detectDomain(text, language),
            originalText: transcript,
            language
          };
        }
      }

      for (const pattern of hebrewYesNoPatterns) {
        if (pattern.test(text)) {
          return {
            addressee: 'child',
            confidence: 0.6,
            intent: 'YES_NO_QUESTION',
            domain: this.detectDomain(text, language),
            originalText: transcript,
            language
          };
        }
      }
    } else {
      // English patterns
      const englishChoicePatterns = [
        /what do you want/,
        /would you like.*or/,
        /do you want.*or/,
        /where (should|do) (we|you)/,
        /which (one|do)/
      ];

      const englishYesNoPatterns = [
        /do you want/,
        /are you (hungry|thirsty|tired)/,
        /would you like/,
        /should we/,
        /is (it|this)/
      ];

      for (const pattern of englishChoicePatterns) {
        if (pattern.test(text)) {
          return {
            addressee: 'child',
            confidence: 0.7,
            intent: 'CHOICE_OFFER',
            domain: this.detectDomain(text, language),
            originalText: transcript,
            language
          };
        }
      }

      for (const pattern of englishYesNoPatterns) {
        if (pattern.test(text)) {
          return {
            addressee: 'child',
            confidence: 0.6,
            intent: 'YES_NO_QUESTION',
            domain: this.detectDomain(text, language),
            originalText: transcript,
            language
          };
        }
      }
    }

    return {
      addressee: 'other',
      confidence: 0.2,
      intent: 'NONE',
      originalText: transcript,
      language
    };
  }

  /**
   * Detect domain from text content
   */
  private detectDomain(text: string, language: 'en' | 'he'): string {
    const lowerText = text.toLowerCase();

    if (language === 'he') {
      if (/אכל|מאכל|לחם|אורז|פסטה|פיצה|עוגה/.test(lowerText)) return 'food';
      if (/שתי|מים|מיץ|חלב|קפה|תה/.test(lowerText)) return 'drink';
      if (/שחק|משחק|קרא|ספר|טלוויזיה|מחשב/.test(lowerText)) return 'activity';
      if (/לבש|בגד|חולצה|מכנס|נעל/.test(lowerText)) return 'clothing';
      if (/נלך|מקום|פארק|בית|חצר/.test(lowerText)) return 'location';
    } else {
      if (/eat|food|bread|rice|pasta|pizza|cake|meal/.test(lowerText)) return 'food';
      if (/drink|water|juice|milk|coffee|tea/.test(lowerText)) return 'drink';
      if (/play|game|read|book|tv|computer|watch/.test(lowerText)) return 'activity';
      if (/wear|clothes|shirt|pants|shoes/.test(lowerText)) return 'clothing';
      if (/go|place|park|home|outside|room/.test(lowerText)) return 'location';
    }

    return 'other';
  }
}

// Export singleton instance
export const choiceClassifier = new ChoiceClassifierService();
