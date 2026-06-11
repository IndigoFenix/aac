// server/services/biometric/photo-analyzer.ts
// Pass an uploaded face photo through Gemini to (a) confirm it's a face and
// (b) extract structured physical descriptors for biometric_data.
//
// Cost of each call is recorded in the credit ledger (charged to the
// uploading user); apiTracker only logs timing.

import { GoogleGenAI, Type } from "@google/genai";
import { apiTracker } from "../apiTracker";
import { chargeModelUsage } from "../credit-ledger";

const ANALYSIS_MODEL = "gemini-2.5-flash";

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (!client) {
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
  }
  return client;
}

// ============================================================================
// Prompt
// ============================================================================

const ANALYSIS_PROMPT = `
You are analyzing a photo that a clinician has uploaded to identify a person
in a child's AAC (augmentative & alternative communication) system. The
purpose is to let the student's AAC device recognize people around them.

Return strict JSON matching the provided schema.

Rules:
- Set isFace=true ONLY if the image clearly shows exactly one human face
  suitable for facial recognition (front-facing, well-lit, minimal obstruction).
- If the image is not a face, is too obscured, contains multiple people,
  or is otherwise unsuitable: isFace=false, and set noFaceReason to a short
  explanation. Leave the descriptor fields null.
- When isFace=true, fill out ALL descriptor fields that you can observe with
  reasonable confidence. Prefer concise, clinical-tone text.
- hairColor: short phrase (e.g. "dark brown", "blonde", "grey", "bald").
- eyeColor: short phrase when visible (e.g. "brown", "blue"); null if not visible.
- estimatedAge: a label such as "child", "teen", "20s", "30s", "40s", "adult", "senior".
- estimatedSex: "male", "female", or "unknown" — use "unknown" when uncertain.
- identifyingFeatures: distinctive marks like "glasses", "beard", "scar on left cheek",
  "hearing aid". Null if nothing notable.
- physicalDescription: 1-2 sentence natural description a clinician might
  write — combines the above into a useful narrative.

Never speculate about ethnicity, nationality, or disability. Never comment on
attractiveness. Only physical facts directly observable in the image.
`.trim();

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  required: ["isFace"],
  properties: {
    isFace: { type: Type.BOOLEAN },
    noFaceReason: { type: Type.STRING, nullable: true },
    hairColor: { type: Type.STRING, nullable: true },
    eyeColor: { type: Type.STRING, nullable: true },
    estimatedAge: { type: Type.STRING, nullable: true },
    estimatedSex: { type: Type.STRING, nullable: true, enum: ["male", "female", "unknown"] },
    identifyingFeatures: { type: Type.STRING, nullable: true },
    physicalDescription: { type: Type.STRING, nullable: true },
  },
} as const;

// ============================================================================
// Public interface
// ============================================================================

export interface PhotoAnalysisResult {
  isFace: boolean;
  noFaceReason?: string;
  hairColor?: string;
  eyeColor?: string;
  estimatedAge?: string;
  estimatedSex?: string;
  identifyingFeatures?: string;
  physicalDescription?: string;
}

export class NoFaceDetectedError extends Error {
  readonly code = "NO_FACE" as const;
  constructor(reason?: string) {
    super(reason ? `No face detected: ${reason}` : "No face detected");
    this.name = "NoFaceDetectedError";
  }
}

/**
 * Send the image to Gemini, get back structured descriptors.
 * Throws NoFaceDetectedError when the model reports isFace=false.
 */
export async function analyzeFacePhoto(
  imageBuffer: Buffer,
  mimeType: string = "image/jpeg",
  opts: { userId?: string; sessionId?: string } = {},
): Promise<PhotoAnalysisResult> {
  const c = getClient();
  const base64 = imageBuffer.toString("base64");

  const response = await apiTracker.trackGeminiCall(
    () =>
      c.models.generateContent({
        model: ANALYSIS_MODEL,
        config: {
          temperature: 0.2,
          maxOutputTokens: 512,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
        contents: [
          {
            role: "user",
            parts: [
              { text: ANALYSIS_PROMPT },
              { inlineData: { mimeType, data: base64 } },
            ],
          },
        ],
      }),
    "analyzeFacePhoto",
    ANALYSIS_MODEL,
    undefined,
    undefined,
    undefined,
    opts.userId,
    opts.sessionId,
  );

  const usage = (response as any)?.usageMetadata;
  if (usage) {
    chargeModelUsage({
      provider: "gemini",
      model: ANALYSIS_MODEL,
      promptTokens: usage.promptTokenCount ?? 0,
      // Thinking tokens bill as output on Gemini 2.5
      completionTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
      cachedTokens: usage.cachedContentTokenCount ?? 0,
      userId: opts.userId,
      category: "photo-analysis",
      label: "face-photo-analysis",
    }).catch(err => console.error("[PhotoAnalyzer] cost ledger charge failed:", err));
  }

  const text = (response as any)?.text
    ?? (response as any)?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Photo analyzer returned no text");
  }

  let parsed: PhotoAnalysisResult;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Photo analyzer returned non-JSON response: ${text.slice(0, 200)}`);
  }

  if (!parsed.isFace) {
    throw new NoFaceDetectedError(parsed.noFaceReason);
  }

  // Normalize empty strings to undefined so we don't overwrite existing data.
  const clean = <T>(v: T | null | undefined | ""): T | undefined =>
    v == null || v === "" ? undefined : (v as T);

  return {
    isFace: true,
    hairColor: clean(parsed.hairColor),
    eyeColor: clean(parsed.eyeColor),
    estimatedAge: clean(parsed.estimatedAge),
    estimatedSex: clean(parsed.estimatedSex),
    identifyingFeatures: clean(parsed.identifyingFeatures),
    physicalDescription: clean(parsed.physicalDescription),
  };
}
