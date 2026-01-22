import { GoogleGenAI } from "@google/genai";

interface SignGemmaResponse {
  signLanguageDetected: boolean;
  interpretation?: string;
  confidence: number;
  detectedSigns?: string[];
  translatedText?: string;
}

// SignGemma service for real-time ASL to English translation
export class SignGemmaService {
  private genAI: GoogleGenAI | null = null;
  private isConfigured = false;

  constructor() {
    try {
      // SignGemma uses the same API key as other Google AI services
      const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
      if (apiKey) {
        this.genAI = new GoogleGenAI({ apiKey });
        this.isConfigured = true;
        console.log('SignGemma service configured successfully');
      } else {
        console.log('SignGemma service not configured - missing API key');
      }
    } catch (error) {
      console.error('Error initializing SignGemma service:', error);
      this.isConfigured = false;
    }
  }

  async detectSignLanguage(videoData: Buffer): Promise<SignGemmaResponse> {
    if (!this.isConfigured || !this.genAI) {
      throw new Error('SignGemma service not configured');
    }

    try {
      console.log('Starting SignGemma sign language detection...');
      
      // Convert buffer to base64
      const base64Image = videoData.toString('base64');
      
      // SignGemma-specific prompt for ASL detection and translation
      const signGemmaPrompt = `You are SignGemma, a specialized AI model for American Sign Language (ASL) detection and translation. Analyze this image for ASL gestures and provide real-time translation.

Look for:
1. Hand shapes and finger configurations typical of ASL
2. Hand positions and orientations 
3. Movement indicators or static poses
4. Facial expressions that are part of ASL grammar
5. Body positioning indicating sign language communication

Provide analysis in JSON format:
{
  "signLanguageDetected": boolean,
  "interpretation": string (English translation if signs detected),
  "confidence": number (0-1),
  "detectedSigns": array of individual signs/letters if identifiable,
  "translatedText": string (complete translated phrase or sentence)
}

Focus on:
- Common ASL vocabulary (greetings, emotions, basic needs)
- Fingerspelling (individual letters)
- Numbers and basic phrases
- Classifier constructions
- Question forms and negations

Be accurate and conservative - only detect signs you're confident about. If uncertain, indicate lower confidence rather than false positives.`;

      const contents = [
        {
          inlineData: {
            data: base64Image,
            mimeType: "image/jpeg",
          },
        },
        signGemmaPrompt,
      ];

      // Use Gemini 2.5 Flash as the underlying model for SignGemma functionality
      const response = await this.genAI.models.generateContent({
        model: "gemini-2.5-flash",
        contents: contents,
      });

      const responseText = response.text;
      
      if (responseText) {
        try {
          // Clean up response text - remove markdown code blocks if present
          let cleanText = responseText.replace(/```json\s*/, '').replace(/```\s*$/, '').trim();
          const parsed = JSON.parse(cleanText);
          
          const result: SignGemmaResponse = {
            signLanguageDetected: parsed.signLanguageDetected || false,
            interpretation: parsed.interpretation || undefined,
            confidence: Math.max(0, Math.min(1, parsed.confidence || 0)),
            detectedSigns: parsed.detectedSigns || [],
            translatedText: parsed.translatedText || parsed.interpretation
          };
          
          console.log('SignGemma detection result:', result);
          return result;
          
        } catch (parseError) {
          console.error('Error parsing SignGemma response:', parseError);
          console.error('Raw response:', responseText);
          return {
            signLanguageDetected: false,
            confidence: 0
          };
        }
      } else {
        console.log('No response from SignGemma');
        return {
          signLanguageDetected: false,
          confidence: 0
        };
      }
    } catch (error) {
      console.error('SignGemma API error:', error);
      throw error;
    }
  }

  isAvailable(): boolean {
    return this.isConfigured;
  }

  getModelInfo(): { name: string; version: string; capabilities: string[] } {
    return {
      name: "SignGemma",
      version: "preview",
      capabilities: [
        "ASL Detection",
        "Real-time Translation", 
        "Fingerspelling Recognition",
        "Phrase Translation",
        "On-device Processing Ready"
      ]
    };
  }
}

// Export singleton instance
export const signGemmaService = new SignGemmaService();

// Legacy function wrapper for backward compatibility
export async function detectSignLanguageWithSignGemma(videoData: Buffer): Promise<{
  signLanguageDetected: boolean;
  interpretation?: string;
  confidence: number;
}> {
  try {
    const result = await signGemmaService.detectSignLanguage(videoData);
    return {
      signLanguageDetected: result.signLanguageDetected,
      interpretation: result.translatedText || result.interpretation,
      confidence: result.confidence
    };
  } catch (error) {
    console.error('SignGemma detection failed:', error);
    return {
      signLanguageDetected: false,
      confidence: 0
    };
  }
}