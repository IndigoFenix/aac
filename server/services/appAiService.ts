// server/services/appAiService.ts
// Bounded AI helpers a cooperative embedded app can call through the trusted
// host (GameEmbed). The flagship is `selectFromOptions`: the app hands a finite
// list of options and the AI returns the single best `id`. This is deliberately
// NARROW — not an open-ended "ask the LLM anything" surface:
//   - structured output is constrained to the app-provided ids (the model can
//     only return a valid choice; we hard-guard the result anyway),
//   - the app supplies its own relevance signal (`instruction`) — no student PHI
//     leaves the platform,
//   - tiny prompt/response, metered to the credit ledger, rate-limited per caller.
// Because of that, it needs no license and no per-partner agreement to run.

import { GoogleGenAI } from "@google/genai";
import { apiTracker } from "./apiTracker";
import { chargeModelUsage } from "./credit-ledger";
import {
  normalizeSelectRequest,
  allowAppAiSelect,
  type AppAiSelectRequest,
  type AppAiSelectResult,
} from "./appAiSelect-validate";

// Re-export the pure validation + limiter so the route imports a single module.
export { normalizeSelectRequest, allowAppAiSelect };
export type { AppAiSelectOption, AppAiSelectRequest, AppAiSelectResult } from "./appAiSelect-validate";

// A cheap, fast model is right for a bounded pick (interpretation uses -pro).
const SELECT_MODEL = "gemini-2.5-flash";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

/**
 * Ask the model to pick the single best option. `selectedId` is guaranteed to be
 * one of the provided ids (schema enum + a hard fallback to the first option).
 */
export async function selectFromOptions(
  req: AppAiSelectRequest,
  userId?: string,
  sessionId?: string,
): Promise<AppAiSelectResult> {
  const ids = req.options.map((o) => o.id);

  const systemInstruction =
    "You help a non-verbal student who communicates with an AAC device. From the list of " +
    "options, choose the SINGLE best one for the student right now, guided by the app's " +
    "instruction and context. Favor the student's apparent interest and age-appropriateness. " +
    "Return the chosen option's id EXACTLY as given, plus a short, warm, child-friendly reason.";

  const payload = {
    instruction: req.instruction ?? null,
    context: req.context ?? null,
    options: req.options.map((o) => ({
      id: o.id,
      label: o.label,
      ...(o.description ? { description: o.description } : {}),
    })),
  };
  const contents = JSON.stringify(payload);

  const requestData = {
    model: SELECT_MODEL,
    config: {
      systemInstruction,
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: {
          selectedId: { type: "string", enum: ids },
          reason: { type: "string" },
        },
        required: ["selectedId"],
      },
    },
    contents,
  };

  const response = await apiTracker.trackGeminiCall(
    async () => await ai.models.generateContent(requestData),
    `/v1beta/models/${SELECT_MODEL}:generateContent`,
    SELECT_MODEL,
    undefined,
    undefined,
    contents.length / 4,
    userId,
    sessionId,
  );

  const usage = (response as { usageMetadata?: any })?.usageMetadata;
  if (usage) {
    chargeModelUsage({
      provider: "gemini",
      model: SELECT_MODEL,
      promptTokens: usage.promptTokenCount ?? 0,
      completionTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
      cachedTokens: usage.cachedContentTokenCount ?? 0,
      userId,
      sessionId,
      category: "app-ai-select",
      label: "app-ai-select",
    }).catch((err) => console.error("[appAiService] ledger charge failed:", err));
  }

  const raw = (response as { text?: string }).text;
  let parsed: { selectedId?: unknown; reason?: unknown } = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    /* fall through to guard */
  }

  let selectedId = typeof parsed.selectedId === "string" ? parsed.selectedId : "";
  // Hard guard: the model MUST return one of the provided ids. Fall back to the
  // first option so the app always gets a usable answer.
  if (!ids.includes(selectedId)) selectedId = ids[0];
  const reason = typeof parsed.reason === "string" ? parsed.reason : undefined;

  return { selectedId, reason };
}
