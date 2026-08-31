// shared/llm-policy.ts
// Which LLM providers may receive PHI, per use case.
//
// AKIM §14 (cross-border transfer) / §5.3 (sub-processor disclosure). Until
// this file existed the "covered provider" rule was a pair of comments in
// llm-options.ts and one hard `throw` in deepAnalysisService: nothing stopped
// an admin — or a per-persona override — from pointing `aac_moderator`, which
// carries full session transcripts plus name/age/diagnosis, at a provider we
// have never disclosed as a recipient of student data.
//
// The rule has two halves and both are data here, not prose:
//
//   1. PHI_PROCESSORS — the providers disclosed (and contracted) as recipients
//      of personal/health data. Google and Anthropic are; OpenAI is not — it
//      is used for icon/image generation on non-PHI prompts only. Adding a
//      provider here is a LEGAL act (DPA + transfer assessment + an updated
//      §5.3 disclosure), never a convenience edit.
//   2. useCaseCarriesPhi — which routes carry student data at all. Every use
//      case does except `crm_chat`, the anonymous landing-page assistant that
//      talks to prospects and never sees a student.
//
// The module is PURE (no I/O, no imports beyond the option catalog types) so
// it can be enforced everywhere the routing decision is made: the admin write
// path, config resolution, the per-persona override and deep analysis.

import type { LLMProviderKey, UseCaseKey } from "./llm-options";
import { PROVIDER_LABELS, USE_CASES } from "./llm-options";

/**
 * Providers that may receive PHI.
 *
 * ⚠️ Flipping a `false` to `true` requires a signed DPA/BAA, a transfer
 * assessment, and the provider's appearance in the §5.3 sub-processor
 * disclosure — not a code review alone.
 */
export const PHI_PROCESSORS: Record<LLMProviderKey, boolean> = {
  claude: true,   // Anthropic — disclosed sub-processor
  gemini: true,   // Google — disclosed sub-processor
  openai: false,  // icon/image generation only; never PHI
};

/**
 * Use cases that do NOT carry student data. Everything not listed here is
 * treated as PHI-bearing — the safe default, so a new use case is covered the
 * day it is added rather than the day someone remembers to list it.
 */
export const NON_PHI_USE_CASES: readonly UseCaseKey[] = ["crm_chat"];

/** Stable log marker for a stored config rejected at resolution time. */
export const LLM_CONFIG_POLICY_FALLBACK = "LLM_CONFIG_POLICY_FALLBACK";

/** Whether the traffic on this use case can contain student/health data. */
export function useCaseCarriesPhi(useCase: UseCaseKey): boolean {
  return !NON_PHI_USE_CASES.includes(useCase);
}

/** Whether a provider is a disclosed processor of PHI. */
export function isPhiProcessor(provider: LLMProviderKey): boolean {
  return PHI_PROCESSORS[provider] === true;
}

/** The providers that may receive PHI, in catalog order. */
export function phiProcessorProviders(): LLMProviderKey[] {
  return (Object.keys(PHI_PROCESSORS) as LLMProviderKey[]).filter(isPhiProcessor);
}

/** May this provider serve this use case? */
export function isProviderAllowed(useCase: UseCaseKey, provider: LLMProviderKey): boolean {
  if (!useCaseCarriesPhi(useCase)) return true;
  return isPhiProcessor(provider);
}

/**
 * The providers selectable for a use case. A non-PHI use case may use any
 * provider in the catalog; a PHI-bearing one is limited to the covered set.
 * (Capability filtering — live/http/tools — stays in llm-options.)
 */
export function allowedProvidersForUseCase(useCase: UseCaseKey): LLMProviderKey[] {
  const all = Object.keys(PHI_PROCESSORS) as LLMProviderKey[];
  return useCaseCarriesPhi(useCase) ? all.filter(isPhiProcessor) : all;
}

/**
 * A human-readable refusal, or null when the pairing is allowed. The string is
 * shown to the admin verbatim, so it names the use case and says WHY.
 */
export function providerPolicyReason(
  useCase: UseCaseKey,
  provider: LLMProviderKey,
): string | null {
  if (isProviderAllowed(useCase, provider)) return null;
  const label = USE_CASES[useCase]?.label ?? useCase;
  const providerLabel = PROVIDER_LABELS[provider] ?? provider;
  const covered = phiProcessorProviders()
    .map((p) => PROVIDER_LABELS[p] ?? p)
    .join(" and ");
  return (
    `${label} processes student personal and health data. ${providerLabel} is not ` +
    `a disclosed processor for that data (only ${covered} are), so it cannot be ` +
    `selected here.`
  );
}

/** Thrown by assertProviderAllowed. Carries a displayable reason and a code. */
export class ProviderNotAllowedError extends Error {
  /** Stable code for client-side mapping / log filters. */
  readonly code = "LLM_PROVIDER_NOT_PERMITTED" as const;
  readonly useCase: UseCaseKey;
  readonly provider: LLMProviderKey;
  /** Same text as `message` — named so call sites read clearly. */
  readonly reason: string;

  constructor(useCase: UseCaseKey, provider: LLMProviderKey, reason: string) {
    super(reason);
    this.name = "ProviderNotAllowedError";
    this.useCase = useCase;
    this.provider = provider;
    this.reason = reason;
  }
}

/** Throws ProviderNotAllowedError unless the pairing is permitted. */
export function assertProviderAllowed(
  useCase: UseCaseKey,
  provider: LLMProviderKey,
): void {
  const reason = providerPolicyReason(useCase, provider);
  if (reason) throw new ProviderNotAllowedError(useCase, provider, reason);
}
