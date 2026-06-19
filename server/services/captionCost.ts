// server/services/captionCost.ts
//
// Cost attribution for the Video Caption Studio. One charge lands in TWO places:
//   1. The caption PROJECT row (creditsUsed + per-category costBreakdown) — the
//      anchor for the admin "Caption Projects" cost view.
//   2. The standard credit ledger (chargeCreditsToLedger) — fans out to the
//      user, student, and session counters like every other AI cost.
//
// Associations: user + institute + student + session (if available) + project
// (keyed by videoHash). Best-effort: a failure is logged, never thrown.

import { chargeCreditsToLedger } from "./credit-ledger";
import { captionProjectRepository } from "../repositories/captionProjectRepository";
import { creditsForModelUsage, creditsForSttUsage } from "./chat/cost-helpers";
import type { LLMProviderKey } from "@shared/llm-options";

export interface CaptionCostContext {
  userId?: string | null;
  studentId?: string | null;
  instituteId?: string | null;
  sessionId?: string | null;
  /** The video content hash — keys the cost to its caption project. */
  videoHash?: string | null;
  videoName?: string | null;
  language?: string | null;
  /** cost_breakdown key; defaults to "video-caption". */
  category?: string;
  label: string;
}

async function record(ctx: CaptionCostContext, credits: number): Promise<void> {
  if (!(credits > 0)) return;
  const category = ctx.category ?? "video-caption";

  // 1. Project-level anchor (admin caption-projects view).
  if (ctx.userId && ctx.videoHash) {
    try {
      const project = await captionProjectRepository.ensureProject(ctx.userId, ctx.videoHash, {
        instituteId: ctx.instituteId,
        studentId: ctx.studentId,
        videoName: ctx.videoName,
        language: ctx.language,
      });
      await captionProjectRepository.chargeToProject(project.id, category, credits);
    } catch (err) {
      console.error("[captionCost] project charge failed:", err);
    }
  }

  // 2. Standard ledger fan-out (user / student / session).
  await chargeCreditsToLedger({
    sessionId: ctx.sessionId ?? null,
    studentId: ctx.studentId ?? null,
    userId: ctx.userId ?? null,
    credits,
    category,
    label: ctx.label,
  });
}

/** Charge an LLM completion's cost (tokens → credits) to a caption project + ledger. */
export async function chargeCaptionModelUsage(
  ctx: CaptionCostContext,
  usage: {
    provider: LLMProviderKey;
    model: string;
    promptTokens: number;
    completionTokens: number;
    cachedTokens?: number;
    cacheCreationTokens?: number;
  },
): Promise<void> {
  const credits = creditsForModelUsage(
    usage.provider,
    usage.model,
    usage.promptTokens,
    usage.completionTokens,
    usage.cachedTokens ?? 0,
    usage.cacheCreationTokens ?? 0,
  );
  await record(ctx, credits).catch((err) => console.error("[captionCost] charge failed:", err));
}

/** Charge a speech-to-text run's cost (by audio seconds) to a caption project + ledger. */
export async function chargeCaptionSttUsage(ctx: CaptionCostContext, seconds: number): Promise<void> {
  await record(ctx, creditsForSttUsage(seconds)).catch((err) => console.error("[captionCost] charge failed:", err));
}
