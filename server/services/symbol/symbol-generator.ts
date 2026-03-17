import { GoogleGenAI } from "@google/genai";

const GENERATION_MODEL = "gemini-2.5-flash-image";

const SYMBOL_PROMPT_PREFIX = `Generate a clean AAC (Augmentative and Alternative Communication) symbol icon.
Requirements:
- Simple, bold line art style suitable for communication boards
- Bold black outlines on a white/transparent background
- 256x256 pixels
- No text or letters in the image
- Minimal detail — the icon must be instantly recognizable at small sizes
- Flat colors or simple fills (no gradients, shadows, or 3D effects)

Symbol description: `;

/**
 * Generate an AAC symbol image using Gemini's image generation.
 * Returns a raw PNG buffer (not saved — caller confirms before persisting).
 */
export async function generateSymbolImage(
  description: string,
  options?: { styleGuideBase64?: string }
): Promise<Buffer> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const client = new GoogleGenAI({ apiKey });

  const contents: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];

  // Include style guide reference image if available
  if (options?.styleGuideBase64) {
    contents.push({
      inlineData: { mimeType: "image/png", data: options.styleGuideBase64 },
    });
    contents.push({
      text: "Use the style of the above reference image. " + SYMBOL_PROMPT_PREFIX + description,
    });
  } else {
    contents.push({
      text: SYMBOL_PROMPT_PREFIX + description,
    });
  }

  const response = await client.models.generateContent({
    model: GENERATION_MODEL,
    contents: [{ role: "user", parts: contents }],
    config: {
      responseModalities: ["IMAGE", "TEXT"],
    },
  });

  // Extract image from response
  const parts = response.candidates?.[0]?.content?.parts;
  if (!parts) {
    throw new Error("No response parts from image generation model");
  }

  for (const part of parts) {
    if (part.inlineData?.data) {
      return Buffer.from(part.inlineData.data, "base64");
    }
  }

  throw new Error("No image data in generation response");
}
