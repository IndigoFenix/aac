/**
 * Where the provider allowlist actually bites — AKIM §14.
 *
 * shared/llm-policy.ts states the rule (llm-policy.test.ts pins the matrix);
 * this file pins that the rule is ENFORCED at both places a routing decision
 * is made:
 *
 *   • WRITE — `adminController.updateLLMConfigs` refuses with 400 and the
 *     reason, and nothing in a refused batch is written.
 *   • RESOLUTION — `resolveStoredLLMConfig` serves the use-case default when
 *     the stored row violates the policy, so a setting saved BEFORE the check
 *     existed cannot keep routing student data to an undisclosed processor.
 *
 * Also pins the audit row on every write: changing where PHI goes is a
 * transfer-destination change and must be visible after the fact.
 *
 * DB-free: the resolver is pure, and the controller's refusal path returns
 * before any repository call. The repository singleton's write method is
 * swapped for a recorder so the accepted path never reaches Postgres either.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { makeReq, makeRes } from "./helpers/http.js";
import { adminController } from "../controllers/adminController.js";
import {
  resolveStoredLLMConfig,
  settingsRepository,
} from "../repositories/settingsRepository.js";
import { activityLogService } from "../services/activityLogService.js";
import { LLM_CONFIG_POLICY_FALLBACK } from "../../shared/llm-policy.js";
import { USE_CASES, type LLMConfigValue, type UseCaseKey } from "../../shared/llm-options.js";

// ──────────────────────────────────────────────────────────────────
// Resolution
// ──────────────────────────────────────────────────────────────────

describe("resolveStoredLLMConfig", () => {
  it("returns the stored row when it is permitted", () => {
    const raw = JSON.stringify({ provider: "gemini", model: "gemini-2.5-flash" });
    expect(resolveStoredLLMConfig("aac_moderator", raw)).toEqual({
      config: { provider: "gemini", model: "gemini-2.5-flash" },
      source: "stored",
    });
  });

  it("falls back to the use-case default when the row violates the policy", () => {
    // The scenario this exists for: a row written before the write-side check
    // existed. Honouring it would keep sending transcripts + diagnosis to an
    // undisclosed processor for as long as nobody re-saved the settings page.
    const raw = JSON.stringify({ provider: "openai", model: "gpt-4o" });
    const resolved = resolveStoredLLMConfig("aac_moderator", raw);
    expect(resolved.source).toBe("policy");
    expect(resolved.config).toEqual({
      provider: USE_CASES.aac_moderator.defaultProvider,
      model: USE_CASES.aac_moderator.defaultModel,
    });
    expect(resolved.rejected).toEqual({ provider: "openai", model: "gpt-4o" });
  });

  it("leaves crm_chat on OpenAI — it carries no student data", () => {
    const raw = JSON.stringify({ provider: "openai", model: "gpt-4o-mini" });
    expect(resolveStoredLLMConfig("crm_chat", raw).source).toBe("stored");
  });

  it("falls back on an absent row", () => {
    expect(resolveStoredLLMConfig("clinician", null).source).toBe("absent");
  });

  it("falls back on malformed JSON and on a shape that is not a config", () => {
    expect(resolveStoredLLMConfig("clinician", "{not json").source).toBe("invalid_json");
    expect(resolveStoredLLMConfig("clinician", "null").source).toBe("invalid_json");
    expect(resolveStoredLLMConfig("clinician", '{"provider":"claude"}').source).toBe("invalid_json");
  });

  it("every PHI use case rejects an openai row", () => {
    const raw = JSON.stringify({ provider: "openai", model: "gpt-4o" });
    for (const uc of Object.keys(USE_CASES) as UseCaseKey[]) {
      if (uc === "crm_chat") continue;
      expect(resolveStoredLLMConfig(uc, raw).source).toBe("policy");
    }
  });
});

describe("getLLMConfig warns once per use case with a stable marker", () => {
  let warn: ReturnType<typeof jest.spyOn>;
  const original = (settingsRepository as any).getSetting;

  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    (settingsRepository as any).getSetting = async () =>
      JSON.stringify({ provider: "openai", model: "gpt-4o" });
    // Fresh warn-once state per test.
    (settingsRepository as any).policyFallbackWarned = new Set();
  });

  afterEach(() => {
    warn.mockRestore();
    (settingsRepository as any).getSetting = original;
  });

  it("serves the default and emits LLM_CONFIG_POLICY_FALLBACK exactly once", async () => {
    const a = await settingsRepository.getLLMConfig("aac_moderator");
    const b = await settingsRepository.getLLMConfig("aac_moderator");
    expect(a).toEqual({
      provider: USE_CASES.aac_moderator.defaultProvider,
      model: USE_CASES.aac_moderator.defaultModel,
    });
    expect(b).toEqual(a);

    const marked = (warn.mock.calls as unknown[][]).filter((c) =>
      String(c[0]).includes(LLM_CONFIG_POLICY_FALLBACK),
    );
    // Session start resolves this on every connect; one row per process is
    // enough for a metric filter to fire, thousands are noise.
    expect(marked).toHaveLength(1);
    expect(String(marked[0][0])).toContain("useCase=aac_moderator");
    expect(String(marked[0][0])).toContain("stored=openai/gpt-4o");
  });
});

// ──────────────────────────────────────────────────────────────────
// Write path
// ──────────────────────────────────────────────────────────────────

describe("adminController.updateLLMConfigs — write-side enforcement", () => {
  let writes: Array<{ useCase: string; config: LLMConfigValue; actor?: string | null }>;
  const originalUpdate = settingsRepository.updateLLMConfig.bind(settingsRepository);
  const originalGetAll = settingsRepository.getAllLLMConfigs.bind(settingsRepository);

  beforeEach(() => {
    writes = [];
    (settingsRepository as any).updateLLMConfig = async (
      useCase: string,
      config: LLMConfigValue,
      actor?: string | null,
    ) => {
      writes.push({ useCase, config, actor });
    };
    (settingsRepository as any).getAllLLMConfigs = async () => ({});
  });

  afterEach(() => {
    (settingsRepository as any).updateLLMConfig = originalUpdate;
    (settingsRepository as any).getAllLLMConfigs = originalGetAll;
  });

  async function put(configs: Record<string, LLMConfigValue>, actor = "admin-1") {
    const req = makeReq({ user: { id: actor }, body: { configs } });
    const { res, capture } = makeRes();
    await adminController.updateLLMConfigs(req, res);
    return capture;
  }

  it("refuses an undisclosed provider on a PHI use case with 400 and a reason", async () => {
    const capture = await put({
      aac_moderator: { provider: "openai", model: "gpt-4o" },
    });
    expect(capture.statusCode).toBe(400);
    const body = capture.jsonBody as any;
    expect(body.success).toBe(false);
    expect(body.code).toBe("LLM_PROVIDER_NOT_PERMITTED");
    // The admin has to be told WHY, not just "invalid".
    expect(body.message).toContain(USE_CASES.aac_moderator.label);
    expect(body.message).toContain("OpenAI");
    expect(writes).toEqual([]);
  });

  it("writes nothing at all when one entry in a batch is refused", async () => {
    // Validation of the whole batch precedes every write, so a partially
    // applied save is not a state the system can be left in.
    const capture = await put({
      clinician: { provider: "claude", model: "claude-haiku" },
      deep_analysis: { provider: "openai", model: "o3" },
    });
    expect(capture.statusCode).toBe(400);
    expect(writes).toEqual([]);
  });

  it("accepts a covered provider and threads the acting admin through", async () => {
    const capture = await put(
      { clinician: { provider: "claude", model: "claude-sonnet" } },
      "admin-42",
    );
    expect(capture.statusCode).toBe(200);
    expect(writes).toEqual([
      {
        useCase: "clinician",
        config: { provider: "claude", model: "claude-sonnet" },
        actor: "admin-42",
      },
    ]);
  });

  it("still allows OpenAI for the anonymous landing-page chat", async () => {
    const capture = await put({ crm_chat: { provider: "openai", model: "gpt-4o-mini" } });
    expect(capture.statusCode).toBe(200);
    expect(writes).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────
// Audit
// ──────────────────────────────────────────────────────────────────

describe("updateLLMConfig writes an audit row", () => {
  const originalLog = activityLogService.log;
  const originalGet = (settingsRepository as any).getSetting;
  const originalSet = (settingsRepository as any).updateSetting;
  let rows: any[];

  beforeEach(() => {
    rows = [];
    (activityLogService as any).log = (entry: any) => { rows.push(entry); };
    (settingsRepository as any).getSetting = async () =>
      JSON.stringify({ provider: "claude", model: "claude-haiku" });
    (settingsRepository as any).updateSetting = async () => {};
    (settingsRepository as any).policyFallbackWarned = new Set();
  });

  afterEach(() => {
    (activityLogService as any).log = originalLog;
    (settingsRepository as any).getSetting = originalGet;
    (settingsRepository as any).updateSetting = originalSet;
  });

  it("records both sides of the routing change on subject llm_config", async () => {
    await settingsRepository.updateLLMConfig(
      "clinician",
      { provider: "claude", model: "claude-sonnet" },
      "admin-7",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: "admin-7",
      eventType: "update",
      subjectType1: "llm_config",
      subjectId1: "clinician",
      details: {
        from: { provider: "claude", model: "claude-haiku" },
        to: { provider: "claude", model: "claude-sonnet" },
      },
    });
  });

  it("refuses — and does not write or log — a policy violation reaching it directly", async () => {
    // Callers that skip the admin controller (a persona override, a script)
    // hit the same wall.
    await expect(
      settingsRepository.updateLLMConfig("clinician", { provider: "openai", model: "gpt-4o" }),
    ).rejects.toThrow(/OpenAI/);
    expect(rows).toEqual([]);
  });
});
