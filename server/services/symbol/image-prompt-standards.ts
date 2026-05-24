/**
 * Image Prompt Standards
 *
 * Contains the detailed rules prompt for AAC symbol image generation.
 * This prompt is sent to a small LLM (Gemini Flash) along with the image key
 * to produce a narrowed-down, detailed image prompt for the actual image generator.
 *
 * The standards prompt is cached using Gemini's context caching API so that
 * repeated calls (which differ only by the appended image key) benefit from
 * reduced latency and cost.
 */

import { GoogleGenAI, type CachedContent } from "@google/genai";

// ---------------------------------------------------------------------------
// Standards prompt — placeholder for detailed rules
// ---------------------------------------------------------------------------

/**
 * This prompt describes the rules for how the image generator should depict
 * people, objects, motion, actions, etc. It is intentionally large and detailed
 * so that the refinement model can produce highly specific prompts.
 *
 * TODO: Replace this placeholder with the full set of image generation rules.
 */
export const IMAGE_GENERATION_STANDARDS_PROMPT = `You are an expert AAC (Augmentative and Alternative Communication) symbol prompt writer.

Your job is to take a short image key (like "person_running" or "drinking_water") and produce a detailed, precise prompt for an image generation model that will create a clean AAC symbol icon.

Follow these rules strictly when writing the prompt:

## General Style Rules
- The image must be a simple, bold illustration suitable for AAC communication boards.
- The image will be rendered on a TRANSPARENT background — do NOT describe any background. Only describe the subject itself.
- Bold black outlines around all shapes.
- Flat, solid colors — no gradients, shadows, highlights, or 3D effects.
- The icon must be instantly recognizable at small sizes (256x256 pixels).
- No text, letters, numbers, or written words in the image.
- No watermarks, logos, or branding.
- Keep detail minimal — focus on the essential elements only.

## Depicting People
- Use simple, generic human figures — no specific ethnicity, gender markers, or detailed facial features unless the concept requires it.
- Faces should have minimal features: simple dots for eyes, a small curve for the mouth.
- Non-gender-specific people should have no hair.
- Specifically male hair should be short and simple.
- Specifically female hair should be longer and simple.
- Clothing should be minimal and context-appropriate (e.g., a chef hat for cooking).
- Body proportions should be slightly stylized (larger head relative to body) for clarity.

## Depicting Objects
- Show objects from the most recognizable angle.
- Use iconic/canonical views (e.g., a cup shown from the side, a clock shown from the front).
- Remove unnecessary details — show only what is needed to identify the object.
- Use standard, universally recognized representations.

## Depicting Actions and Motion
- Use simple motion lines or arrows to indicate movement.
- Show the key moment of the action (e.g., mid-stride for running, arm raised for waving).
- The figure should clearly be performing the action, not just standing near related objects.

## Depicting Emotions and Abstract Concepts
- Use facial expressions and body language to convey emotions.
- For abstract concepts, use widely understood visual metaphors.
- Keep the emotional expression clear and exaggerated for readability.

## Copyrighted Characters and Branded Products
When the image key names a copyrighted character (Pikachu, Mario, Elsa, Spider-Man, etc.) or a branded product (Lego, Coca-Cola can, iPhone, Millennium Falcon, etc.), produce a prompt for a **legally-distinct visual analogue** — capture the silhouette, colors, and instantly-recognizable visual cues, but describe a GENERIC version that the image generator will actually produce. Do NOT name the original character or brand in the output prompt. Do NOT refuse the request.

Examples of the transformation:
- "pikachu" → "a small chubby yellow rodent creature with red circular cheeks, pointed black-tipped ears, and a lightning-bolt-shaped tail, in flat AAC icon style"
- "mario" → "a short cheerful plumber with a red cap, blue overalls, white gloves, brown shoes, and a thick black mustache, in flat AAC icon style"
- "elsa" → "a fair-skinned princess in a sparkling pale blue gown with a long braid of platinum hair, in flat AAC icon style"
- "lego_brick" → "a single bright red interlocking plastic building block with four cylindrical studs on top, in flat AAC icon style"
- "millennium_falcon" → "a flat round-bodied science-fiction spaceship with a forward-pointing cockpit on the right side, white and gray hull plating, in flat AAC icon style"

The student gets a visually equivalent icon they'll recognize; we sidestep the image generator's copyright/trademark guardrails.

## Composition
- Center the main subject in the frame.
- Leave some padding around the edges.
- Use the full square canvas effectively.
- For single objects, fill about 70-80% of the canvas.
- For scenes with people, the figure should be prominent.

## Color Usage
- Use a limited palette of 3-5 bold, distinct colors per icon.
- Colors should be saturated and easily distinguishable.
- Use color meaningfully (e.g., red for hot, blue for cold/water).
- Avoid pastel or muted tones — they don't read well at small sizes.

---

Given the image key below, write a single detailed prompt paragraph (2-4 sentences) for the image generator.
Focus on exactly what should appear in the image, using the rules above.
Do NOT include any meta-instructions like "generate an image" — just describe what the image should look like.
Output ONLY the image generation prompt, nothing else.

Image key: `;

// ---------------------------------------------------------------------------
// Gemini cache management for the standards prompt
// ---------------------------------------------------------------------------

const CACHE_MODEL = "gemini-2.5-flash";
const CACHE_DISPLAY_NAME = "aac-image-prompt-standards";
const CACHE_TTL = "3600s"; // 1 hour

let cachedContentName: string | null = null;
let cacheExpiry: number = 0;

/**
 * Get or create a Gemini context cache containing the standards prompt.
 * Returns the cache resource name to be used in generateContent calls.
 */
export async function getOrCreatePromptCache(client: GoogleGenAI): Promise<string | null> {
  const now = Date.now();

  // Return existing cache if still valid (with 5-minute buffer)
  if (cachedContentName && now < cacheExpiry - 5 * 60 * 1000) {
    return cachedContentName;
  }

  try {
    // Try to find an existing cache by listing
    const caches = await client.caches.list({ config: { pageSize: 50 } });
    for await (const cache of caches) {
      if (cache.displayName === CACHE_DISPLAY_NAME && cache.expireTime) {
        const expiry = new Date(cache.expireTime).getTime();
        if (expiry > now + 5 * 60 * 1000) {
          cachedContentName = cache.name!;
          cacheExpiry = expiry;
          return cachedContentName;
        }
      }
    }

    // Create a new cache
    const created: CachedContent = await client.caches.create({
      model: CACHE_MODEL,
      config: {
        contents: [
          {
            role: "user",
            parts: [{ text: IMAGE_GENERATION_STANDARDS_PROMPT }],
          },
        ],
        displayName: CACHE_DISPLAY_NAME,
        ttl: CACHE_TTL,
      },
    });

    cachedContentName = created.name!;
    cacheExpiry = created.expireTime
      ? new Date(created.expireTime).getTime()
      : now + 3600 * 1000;

    return cachedContentName;
  } catch (err: any) {
    console.warn("[ImagePromptStandards] Cache creation failed, will use inline prompt:", err?.message);
    cachedContentName = null;
    cacheExpiry = 0;
    return null;
  }
}
