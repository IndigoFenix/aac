/**
 * Symbol Generator — Two-Step Pipeline
 *
 * Step 1: Send the image generation standards prompt + image key to Gemini Flash
 *         (with context caching for cost savings) to produce a detailed image prompt.
 * Step 2: Send the detailed prompt to OpenAI's gpt-image-1 to generate the actual image.
 *
 * Returns the image buffer along with a cost breakdown for both steps.
 */

import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import {
  IMAGE_GENERATION_STANDARDS_PROMPT,
  getOrCreatePromptCache,
} from "./image-prompt-standards";

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

const PROMPT_REFINEMENT_MODEL = "gemini-2.5-flash";
const IMAGE_GENERATION_MODEL: OpenAI.ImageModel = "gpt-image-1";

// ---------------------------------------------------------------------------
// Cost breakdown
// ---------------------------------------------------------------------------

export interface SymbolGenerationCost {
  /** Step 1: Prompt refinement via Gemini */
  promptRefinement: {
    provider: "gemini";
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
  };
  /** Step 2: Image generation via OpenAI */
  imageGeneration: {
    provider: "openai";
    model: string;
    inputTokens: number;
    outputTokens: number;
  };
}

export interface SymbolGenerationResult {
  imageBuffer: Buffer;
  cost: SymbolGenerationCost;
  /** The refined prompt that was sent to the image generator */
  refinedPrompt: string;
}

// ---------------------------------------------------------------------------
// Step 1: Prompt refinement via Gemini Flash (with caching)
// ---------------------------------------------------------------------------

async function refinePrompt(
  imageKey: string,
  options?: { styleGuideBase64?: string },
): Promise<{ prompt: string; inputTokens: number; outputTokens: number; cachedTokens: number }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const client = new GoogleGenAI({ apiKey });

  // Try to use the cached standards prompt
  const cacheName = await getOrCreatePromptCache(client);

  const description = imageKey.replace(/_/g, " ");
  const userMessage = cacheName
    ? description // Cache already contains the standards prompt; just send the key
    : IMAGE_GENERATION_STANDARDS_PROMPT + description;

  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];

  if (options?.styleGuideBase64) {
    parts.push({
      inlineData: { mimeType: "image/png", data: options.styleGuideBase64 },
    });
    parts.push({
      text: "Use the style of the above reference image. " + userMessage,
    });
  } else {
    parts.push({ text: userMessage });
  }

  const response = await client.models.generateContent({
    model: PROMPT_REFINEMENT_MODEL,
    contents: [{ role: "user", parts }],
    config: {
      ...(cacheName ? { cachedContent: cacheName } : {}),
      temperature: 0.3,
      maxOutputTokens: 1000,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const refinedPrompt = response.candidates?.[0]?.content?.parts
    ?.map((p) => p.text)
    .filter(Boolean)
    .join(" ")
    .trim();

  if (!refinedPrompt) {
    throw new Error("Prompt refinement returned no text");
  }

  const usage = response.usageMetadata;
  return {
    prompt: refinedPrompt,
    inputTokens: usage?.promptTokenCount ?? 0,
    outputTokens: usage?.candidatesTokenCount ?? 0,
    cachedTokens: usage?.cachedContentTokenCount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Step 2: Image generation via OpenAI gpt-image-1
// ---------------------------------------------------------------------------

async function generateImage(
  prompt: string,
): Promise<{ imageBuffer: Buffer; inputTokens: number; outputTokens: number }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const openai = new OpenAI({ apiKey });

  const response = await openai.images.generate({
    model: IMAGE_GENERATION_MODEL,
    prompt,
    n: 1,
    size: "1024x1024",
    quality: "low",
    background: "transparent",
    output_format: "png",
  });

  const b64Data = response.data?.[0]?.b64_json;
  if (!b64Data) {
    throw new Error("No image data in OpenAI response");
  }

  const imageBuffer = Buffer.from(b64Data, "base64");

  return {
    imageBuffer,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate an AAC symbol image using the two-step pipeline:
 * 1. Gemini Flash refines the image key into a detailed prompt (with caching)
 * 2. OpenAI gpt-image-1 generates the actual image
 *
 * Returns the image buffer, cost breakdown, and the refined prompt used.
 */
export async function generateSymbolImage(
  description: string,
  options?: { styleGuideBase64?: string },
): Promise<SymbolGenerationResult> {
  // Step 1: Refine prompt
  const refinement = await refinePrompt(description, options);

  // Step 2: Generate image
  const imageResult = await generateImage(refinement.prompt);

  return {
    imageBuffer: imageResult.imageBuffer,
    refinedPrompt: refinement.prompt,
    cost: {
      promptRefinement: {
        provider: "gemini",
        model: PROMPT_REFINEMENT_MODEL,
        inputTokens: refinement.inputTokens,
        outputTokens: refinement.outputTokens,
        cachedTokens: refinement.cachedTokens,
      },
      imageGeneration: {
        provider: "openai",
        model: IMAGE_GENERATION_MODEL,
        inputTokens: imageResult.inputTokens,
        outputTokens: imageResult.outputTokens,
      },
    },
  };
}
