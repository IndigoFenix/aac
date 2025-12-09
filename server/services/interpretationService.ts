import * as fs from "fs";
import { GoogleGenAI } from "@google/genai";
import { storage } from "../storage";
import { apiTracker } from "./apiTracker";

// DON'T DELETE THIS COMMENT
// Follow these instructions when using this blueprint:
// - Note that the newest Gemini model series is "gemini-2.5-flash" or gemini-2.5-pro"
//   - do not change this unless explicitly requested by the user

// This API key is from Gemini Developer API Key, not vertex AI API Key
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

interface InterpretationResult {
  interpretedMeaning: string;
  analysis: string[];
  confidence: number;
  suggestedResponse: string;
  extractedText?: string;
}

export async function interpretAACText(input: string, language: 'en' | 'he' = 'he', context?: string, studentInfo?: any, userId?: string, sessionId?: string): Promise<InterpretationResult> {
  try {
    const isHebrew = language === 'he';
    
    // Get the dynamic system prompt from storage and apply template variables
    const systemPromptTemplate = await storage.getSystemPrompt();
    const languagePrompt = language === 'he' ? 'Hebrew (עברית)' : 'English';
    const contextInfo = context || 'No additional context provided';
    const userInfo = studentInfo ? `Name: ${studentInfo.alias || 'Unknown'}, Age: ${studentInfo.age || 'Unknown'}, Background: ${studentInfo.backgroundContext || 'No background info'}` : 'No user profile available';
    
    const systemPrompt = systemPromptTemplate
      .replace('{input}', input)
      .replace('{language}', languagePrompt)
      .replace('{context}', contextInfo)
      .replace('{studentInfo}', userInfo);

    const requestData = {
      model: "gemini-2.5-pro",
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            interpretedMeaning: { type: "string" },
            analysis: { 
              type: "array",
              items: { type: "string" }
            },
            confidence: { type: "number" },
            suggestedResponse: { type: "string" }
          },
          required: ["interpretedMeaning", "analysis", "confidence", "suggestedResponse"]
        }
      },
      contents: isHebrew ? `אנא פרש את התקשורת המסייעת הזו: "${input}"` : `Please interpret this AAC communication: "${input}"`
    };

    // Use API tracker to log the call
    const response = await apiTracker.trackGeminiCall(
      async () => await ai.models.generateContent(requestData),
      '/v1beta/models/gemini-2.5-pro:generateContent',
      'gemini-2.5-pro',
      undefined, // inputTokens - will be extracted from response
      undefined, // outputTokens - will be extracted from response
      input.length, // estimatedTokens based on input length
      userId,
      sessionId
    );

    const rawJson = response.text;
    
    if (rawJson) {
      const result: InterpretationResult = JSON.parse(rawJson);
      return {
        interpretedMeaning: result.interpretedMeaning || "Unable to interpret",
        analysis: result.analysis || ["No analysis available"],
        confidence: Math.max(0, Math.min(1, result.confidence || 0)),
        suggestedResponse: result.suggestedResponse || "No suggestion available"
      };
    } else {
      throw new Error("Empty response from Gemini model");
    }
  } catch (error) {
    console.error("Gemini API error:", error);
    
    // Check for model overloaded error (503)
    const errorMessage = (error as Error).message || '';
    if (errorMessage.includes('503') && errorMessage.includes('overloaded')) {
      // Provide user-friendly message for overloaded model
      throw new Error('MODEL_OVERLOADED');
    }
    
    throw new Error("Failed to interpret AAC communication: " + errorMessage);
  }
}

export async function interpretAACImage(base64Image: string, language: 'en' | 'he' = 'he', context?: string, studentInfo?: any, userId?: string, sessionId?: string): Promise<InterpretationResult> {
  try {
    const isHebrew = language === 'he';
    const systemPrompt = isHebrew ?
      `פעל כמטפל בדיבור ברמת דוקטורט, בלשן ברמת דוקטורט, ופותר חידות מומחה. תקבל תמונה ממסך מכשיר תקשורת מסייעת (תת"ח - תקשורת תוספת וחלופית) המשמש ילדה בת 6 לא מילולית עם תסמונת רט. קודם כל, חלץ את הטקסט/סמלים מהתמונה, ואז פרש מה הילדה מנסה לתקשר.

אנא נתח את התמונה וספק:
1. הטקסט/סמלים המדויקים שזוהו בתמונה
2. המשמעות המפורשת בשפה טבעית
3. נקודות ניתוח על דפוסי התקשורת
4. רמת ביטחון (0-1)
5. הצעת תגובה למטפלים

השב בפורמט JSON עם המבנה הבא:
{
  "extractedText": "הטקסט/סמלים המדויקים שזוהו בתמונה",
  "interpretedMeaning": "פרשנות ברורה של מה שהילדה מנסה לתקשר",
  "analysis": ["נקודת ניתוח 1", "נקודת ניתוח 2", "נקודת ניתוח 3"],
  "confidence": 0.85,
  "suggestedResponse": "הצעת תגובה למטפלים"
}` :
      `Act as a PhD speech therapist, a PhD linguist, and a master riddle solver. You will receive an image from an AAC device screen used by a non-verbal 6-year-old girl with Rett syndrome. First, extract the text/symbols from the image, then interpret what the child is trying to communicate.

Please analyze the image and provide:
1. The exact text/symbols identified in the image
2. The interpreted meaning in natural language
3. Analysis points about the communication patterns
4. Confidence level (0-1)
5. A suggested response for caregivers

Respond in JSON format with the following structure:
{
  "extractedText": "Exact text/symbols identified in the image",
  "interpretedMeaning": "Clear interpretation of what the child is trying to communicate",
  "analysis": ["Analysis point 1", "Analysis point 2", "Analysis point 3"],
  "confidence": 0.85,
  "suggestedResponse": "Suggested response for caregivers"
}`;

    const imageBytes = Buffer.from(base64Image, 'base64');

    const contents = [
      {
        inlineData: {
          data: base64Image,
          mimeType: "image/jpeg",
        },
      },
      isHebrew ? 
        `אנא חלץ את הטקסט/סמלים ממסך מכשיר התקשורת המסייעת הזה ופרש את התקשורת:${context ? `\n\nהקשר נוסף: ${context}` : ''}` : 
        `Please extract the text/symbols from this AAC device screen and interpret the communication:${context ? `\n\nAdditional context: ${context}` : ''}`
    ];

    const requestData = {
      model: "gemini-2.5-pro",
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            extractedText: { type: "string" },
            interpretedMeaning: { type: "string" },
            analysis: { 
              type: "array",
              items: { type: "string" }
            },
            confidence: { type: "number" },
            suggestedResponse: { type: "string" }
          },
          required: ["extractedText", "interpretedMeaning", "analysis", "confidence", "suggestedResponse"]
        }
      },
      contents: contents
    };

    // Use API tracker to log the call
    const response = await apiTracker.trackGeminiCall(
      async () => await ai.models.generateContent(requestData),
      '/v1beta/models/gemini-2.5-pro:generateContent',
      'gemini-2.5-pro',
      undefined, // inputTokens - will be extracted from response
      undefined, // outputTokens - will be extracted from response
      base64Image.length / 4, // estimatedTokens based on image size
      userId,
      sessionId
    );

    const rawJson = response.text;
    
    if (rawJson) {
      const result: InterpretationResult = JSON.parse(rawJson);
      return {
        extractedText: result.extractedText || "No text extracted",
        interpretedMeaning: result.interpretedMeaning || "Unable to interpret image",
        analysis: result.analysis || ["No analysis available"],
        confidence: Math.max(0, Math.min(1, result.confidence || 0)),
        suggestedResponse: result.suggestedResponse || "No suggestion available"
      };
    } else {
      throw new Error("Empty response from Gemini model");
    }
  } catch (error) {
    console.error("Gemini Vision API error:", error);
    
    // Check for model overloaded error (503)
    const errorMessage = (error as Error).message || '';
    if (errorMessage.includes('503') && errorMessage.includes('overloaded')) {
      // Provide user-friendly message for overloaded model
      throw new Error('MODEL_OVERLOADED');
    }
    
    throw new Error("Failed to interpret AAC image: " + errorMessage);
  }
}