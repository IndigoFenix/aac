// server/services/chat/tools/image-generator.ts
// Generate or edit images using Gemini 2.0 Flash's native image generation

import { GoogleGenAI } from "@google/genai";
import { creditsForModelUsage } from "../cost-helpers";
import { storeFile } from "./media-file-cache";

const IMAGE_MODEL = "gemini-2.5-flash-image";

let genaiClient: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (!genaiClient) {
    genaiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
  }
  return genaiClient;
}

// Cast to any to avoid strict enum typing issues with the Gemini SDK.
// Previously OFF across the board — see gemini-media-analyzer.ts for why
// that's the wrong posture on a children's clinical platform.
const SAFETY_SETTINGS: any[] = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
];

export interface ImageGenerationInput {
  /** Instructions for what image to generate or how to modify the reference image */
  instruction: string;
  /** Optional base64 data URL of a reference image (e.g. a video frame to annotate) */
  referenceImage?: string;
}

export interface ImageGenerationResult {
  text: string;
  /** File IDs of generated images (stored in server cache) */
  generatedImageFileIds?: string[];
  credits?: number;
}

/**
 * Generate an image using Gemini 2.0 Flash, optionally based on a reference image.
 */
export async function generateImage(input: ImageGenerationInput): Promise<ImageGenerationResult> {
  const client = getClient();

  const parts: any[] = [
    { text: input.instruction },
  ];

  if (input.referenceImage) {
    const match = input.referenceImage.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    }
  }

  const response = await client.models.generateContent({
    model: IMAGE_MODEL,
    config: {
      temperature: 0.4,
      responseModalities: ["TEXT", "IMAGE"],
      safetySettings: SAFETY_SETTINGS,
    },
    contents: [{ role: "user", parts }],
  });

  const resultText: string[] = [];
  const generatedImageFileIds: string[] = [];

  const candidates = (response as any)?.candidates || [];
  for (const candidate of candidates) {
    for (const part of candidate.content?.parts || []) {
      if (part.text) {
        resultText.push(part.text);
      }
      if (part.inlineData) {
        // Store in cache instead of returning base64 in the conversation
        const buf = Buffer.from(part.inlineData.data, "base64");
        const fileId = storeFile(buf, part.inlineData.mimeType, `generated_${Date.now()}.png`);
        generatedImageFileIds.push(fileId);
      }
    }
  }

  if (resultText.length === 0 && (response as any)?.text) {
    resultText.push((response as any).text);
  }

  const usage = (response as any)?.usageMetadata;
  const credits = usage
    ? creditsForModelUsage(
        "gemini",
        IMAGE_MODEL,
        usage.promptTokenCount || 0,
        usage.candidatesTokenCount || 0,
        usage.cachedContentTokenCount || 0,
      )
    : 0;

  return {
    text: resultText.join("\n") || (generatedImageFileIds.length > 0 ? "Image generated." : "No output."),
    generatedImageFileIds: generatedImageFileIds.length > 0 ? generatedImageFileIds : undefined,
    credits,
  };
}
