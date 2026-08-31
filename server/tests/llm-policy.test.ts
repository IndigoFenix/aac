/**
 * Pins the LLM provider allowlist (shared/llm-policy.ts) — AKIM §14.
 *
 * The rule this encodes used to live in two source comments and one hard
 * `throw` in deepAnalysisService, which meant an admin (or a per-persona
 * override) could route a PHI-bearing use case to a provider we have never
 * disclosed as a recipient of student data. The matrix below is the whole
 * rule; if a row here changes, a legal document has to change with it.
 *
 * DB-free: the policy module is pure.
 */

import { describe, it, expect } from "@jest/globals";
import {
  PHI_PROCESSORS,
  NON_PHI_USE_CASES,
  ProviderNotAllowedError,
  allowedProvidersForUseCase,
  assertProviderAllowed,
  isPhiProcessor,
  isProviderAllowed,
  phiProcessorProviders,
  providerPolicyReason,
  useCaseCarriesPhi,
} from "../../shared/llm-policy.js";
import {
  USE_CASES,
  PROVIDER_LABELS,
  type LLMProviderKey,
  type UseCaseKey,
} from "../../shared/llm-options.js";

const ALL_PROVIDERS = Object.keys(PROVIDER_LABELS) as LLMProviderKey[];
const ALL_USE_CASES = Object.keys(USE_CASES) as UseCaseKey[];

describe("PHI_PROCESSORS", () => {
  it("covers exactly Google and Anthropic", () => {
    // The §5.3 disclosure names Google and Anthropic as processors of student
    // data. OpenAI is used for icon generation only.
    expect(PHI_PROCESSORS).toEqual({ claude: true, gemini: true, openai: false });
    expect(phiProcessorProviders().sort()).toEqual(["claude", "gemini"]);
    expect(isPhiProcessor("openai")).toBe(false);
  });

  it("has an entry for every provider in the catalog", () => {
    for (const p of ALL_PROVIDERS) {
      expect(typeof PHI_PROCESSORS[p]).toBe("boolean");
    }
  });
});

describe("useCaseCarriesPhi", () => {
  it("exempts only the anonymous landing-page chat", () => {
    expect(NON_PHI_USE_CASES).toEqual(["crm_chat"]);
    expect(useCaseCarriesPhi("crm_chat")).toBe(false);
    for (const uc of ALL_USE_CASES) {
      if (uc === "crm_chat") continue;
      expect(useCaseCarriesPhi(uc)).toBe(true);
    }
  });

  it("treats an unlisted use case as PHI-bearing (deny by default)", () => {
    // A use case added tomorrow is covered the day it is added, not the day
    // someone remembers to list it.
    expect(useCaseCarriesPhi("some_future_use_case" as UseCaseKey)).toBe(true);
  });
});

describe("isProviderAllowed — the matrix", () => {
  const PHI_CASES = ALL_USE_CASES.filter((uc) => uc !== "crm_chat");

  it.each(PHI_CASES)("%s accepts claude and gemini, refuses openai", (uc) => {
    expect(isProviderAllowed(uc, "claude")).toBe(true);
    expect(isProviderAllowed(uc, "gemini")).toBe(true);
    expect(isProviderAllowed(uc, "openai")).toBe(false);
  });

  it("crm_chat accepts every provider", () => {
    for (const p of ALL_PROVIDERS) {
      expect(isProviderAllowed("crm_chat", p)).toBe(true);
    }
  });

  it("allowedProvidersForUseCase reflects the same rule", () => {
    expect(allowedProvidersForUseCase("aac_moderator").sort()).toEqual(["claude", "gemini"]);
    expect(allowedProvidersForUseCase("crm_chat").sort()).toEqual(
      [...ALL_PROVIDERS].sort(),
    );
  });
});

describe("the shipped defaults satisfy the policy", () => {
  // A settings reset, or a fresh install with no system_settings rows, must
  // not itself violate the transfer rule.
  it.each(ALL_USE_CASES)("%s default provider is permitted", (uc) => {
    expect(isProviderAllowed(uc, USE_CASES[uc].defaultProvider)).toBe(true);
  });
});

describe("providerPolicyReason", () => {
  it("is null when the pairing is allowed", () => {
    expect(providerPolicyReason("aac_moderator", "claude")).toBeNull();
    expect(providerPolicyReason("crm_chat", "openai")).toBeNull();
  });

  it("names the use case, the provider and the covered set", () => {
    const reason = providerPolicyReason("aac_moderator", "openai")!;
    expect(reason).toContain(USE_CASES.aac_moderator.label);
    expect(reason).toContain(PROVIDER_LABELS.openai);
    expect(reason).toContain(PROVIDER_LABELS.claude);
    expect(reason).toContain(PROVIDER_LABELS.gemini);
  });
});

describe("assertProviderAllowed", () => {
  it("is silent for a permitted pairing", () => {
    expect(() => assertProviderAllowed("clinician", "claude")).not.toThrow();
    expect(() => assertProviderAllowed("crm_chat", "openai")).not.toThrow();
  });

  it("throws a typed error carrying the reason, code and pairing", () => {
    let caught: unknown;
    try {
      assertProviderAllowed("deep_analysis", "openai");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderNotAllowedError);
    const err = caught as ProviderNotAllowedError;
    expect(err.code).toBe("LLM_PROVIDER_NOT_PERMITTED");
    expect(err.useCase).toBe("deep_analysis");
    expect(err.provider).toBe("openai");
    expect(err.reason).toBe(err.message);
    expect(err.reason).toContain("OpenAI");
  });
});
