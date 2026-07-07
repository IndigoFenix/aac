/**
 * Provider credit/spend alerting. Covers the depletion detector (which provider
 * errors count as "out of credit" vs a transient rate limit), provider
 * attribution, and the monthly spend-threshold sweep (off when no caps set;
 * fires per provider when month-to-date cost crosses the configured share).
 */

import { describe, it, expect, jest, afterEach } from "@jest/globals";
import {
  isProviderCreditError,
  providerFromError,
  runSpendThresholdCheck,
} from "../services/providerAlertService";
import { chatRepository } from "../repositories/chatRepository";
import { emailService } from "../services/emailService";

const CAP_KEYS = [
  "LLM_MONTHLY_CAP_GOOGLE_USD",
  "LLM_MONTHLY_CAP_ANTHROPIC_USD",
  "LLM_MONTHLY_CAP_OPENAI_USD",
  "LLM_SPEND_ALERT_THRESHOLD_PCT",
];

afterEach(() => {
  for (const k of CAP_KEYS) delete process.env[k];
  jest.restoreAllMocks();
});

describe("isProviderCreditError", () => {
  it("matches Anthropic credit exhaustion", () => {
    expect(isProviderCreditError({ message: "Your credit balance is too low to access the API." })).toBe(true);
  });
  it("matches OpenAI insufficient quota", () => {
    expect(isProviderCreditError({ error: { message: "You exceeded your current quota, insufficient_quota" } })).toBe(true);
  });
  it("matches a generic billing error (Google)", () => {
    expect(isProviderCreditError({ message: "Billing account for project is disabled" })).toBe(true);
  });
  it("does NOT match a transient rate limit", () => {
    expect(isProviderCreditError({ message: "429 rate_limit_exceeded, please retry", status: 429 })).toBe(false);
  });
});

describe("providerFromError", () => {
  it("attributes Anthropic", () => {
    expect(providerFromError({ message: "credit balance is too low" })).toBe("Anthropic (Claude)");
  });
  it("attributes OpenAI", () => {
    expect(providerFromError({ message: "insufficient_quota" })).toBe("OpenAI");
  });
  it("attributes Google", () => {
    expect(providerFromError({ message: "generativelanguage.googleapis.com billing" })).toBe("Google");
  });
  it("returns Unknown when unclear", () => {
    expect(providerFromError({ message: "something broke" })).toBe("Unknown");
  });
});

describe("runSpendThresholdCheck", () => {
  it("is a no-op when no caps are configured", async () => {
    const spy = jest.spyOn(chatRepository, "getCostUsageAnalytics");
    const res = await runSpendThresholdCheck();
    expect(res.ran).toBe(false);
    expect(res.breached).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled(); // must not even hit the DB
  });

  it("alerts a provider once its month-to-date spend crosses the threshold", async () => {
    process.env.LLM_MONTHLY_CAP_ANTHROPIC_USD = "10";
    // Clinician chat cost is attributed to Anthropic; $9 of a $10 cap = 90% ≥ 80%.
    jest.spyOn(chatRepository, "getCostUsageAnalytics").mockResolvedValue({
      points: [],
      kpis: {} as any,
      categoryBreakdown: { aac: { observer: 2 }, chat: { chat: 9 } },
      truncated: false,
    } as any);
    jest.spyOn(emailService, "isReady").mockReturnValue(true);
    const send = jest.spyOn(emailService, "sendEmail").mockResolvedValue({ success: true } as any);

    const res = await runSpendThresholdCheck();

    expect(res.ran).toBe(true);
    expect(res.spend["Anthropic (Claude)"]).toBeCloseTo(9);
    expect(res.breached.map((b) => b.provider)).toContain("Anthropic (Claude)");
    expect(res.alerted).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const arg = send.mock.calls[0][0] as { to: string; subject: string };
    expect(arg.to).toBe("cs@aivota.ai");
    expect(arg.subject).toContain("Anthropic");
  });

  it("does not alert when spend is below the threshold", async () => {
    process.env.LLM_MONTHLY_CAP_ANTHROPIC_USD = "100"; // $9 of $100 = 9% < 80%
    jest.spyOn(chatRepository, "getCostUsageAnalytics").mockResolvedValue({
      points: [], kpis: {} as any,
      categoryBreakdown: { aac: {}, chat: { chat: 9 } },
      truncated: false,
    } as any);
    const send = jest.spyOn(emailService, "sendEmail").mockResolvedValue({ success: true } as any);

    const res = await runSpendThresholdCheck();

    expect(res.ran).toBe(true);
    expect(res.breached).toHaveLength(0);
    expect(res.alerted).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
