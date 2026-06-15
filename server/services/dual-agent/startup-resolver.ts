// server/services/dual-agent/startup-resolver.ts
//
// Resolves "startup parameters" for an app/game at open time. Given an
// AppStartupSpec plus the same student context the live agents see and the
// recent conversation, it compiles a SEPARATE prompt (this keeps per-app option
// lists out of the core live prompt) and asks a fast Gemini model to fill the
// spec's paramsSchema. The result is validated/clamped against the schema and
// merged over the spec's defaults.
//
// Design contract: this NEVER throws and ALWAYS returns a usable, complete
// parameter set. On any failure (no API key, timeout, malformed output) it
// falls back to `spec.defaults`. The defaults path is unbilled — only a real
// model call is charged to the credit ledger.

import type { AppStartupSpec, StartupParams } from "@shared/app-startup";
import { validateAndMergeParams } from "@shared/app-startup";
import { GPT, type GPTInputItem } from "../chat/gpt";

const MAX_SECTION_CHARS = 1500;

// Read at call time (not module load) so tests and ops can flip them per-run.
const resolverModel = () => process.env.AAC_STARTUP_RESOLVER_MODEL || "gemini-2.5-flash";
const resolverTimeoutMs = () => Number(process.env.AAC_STARTUP_RESOLVER_TIMEOUT_MS ?? 3500);

/** A single conversation turn passed to the resolver. */
export interface ResolverTurn {
  role: "user" | "assistant" | "system";
  content: string;
}

/** Everything the resolver needs. Assembled by the coordinator from already-
 *  computed session context — see `buildStartupResolveContext`. */
export interface StartupResolveContext {
  spec: AppStartupSpec;
  /** Who/what is opening the app. */
  trigger: { source: "ai" | "student"; data?: string };

  // ── Student context (same material the live agents receive) ──
  studentDisplayName?: string;
  languageName?: string;
  persona?: string;
  sessionGoals?: string;
  memoryContext?: string;
  sessionSummary?: string;

  // ── Conversation ──
  recentTurns?: ResolverTurn[];
  pendingTurns?: ResolverTurn[];

  /**
   * Billing sink, pre-bound by the caller to the session's identifiers and the
   * "startup-resolver" label. Invoked once per real model call (never on the
   * defaults fast-path) with the tokens spent and the model used. Omitted in
   * unit tests.
   */
  trackUsage?: (
    promptTokens: number,
    completionTokens: number,
    cachedTokens: number,
    model: string,
  ) => void;
}

export interface StartupResolveResult {
  params: StartupParams;
  /** True when the model wasn't consulted or its output was unusable. */
  usedDefaults: boolean;
  /** Short human-readable summary of the chosen params, for the AI's context. */
  resolverNote?: string;
}

function clip(s: string | undefined, max = MAX_SECTION_CHARS): string {
  if (!s) return "";
  const t = s.trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function section(label: string, body: string | undefined): string {
  const b = clip(body);
  return b ? `[${label}]\n${b}` : "";
}

function turnsToText(turns: ResolverTurn[] | undefined, max = 8): string {
  if (!turns?.length) return "";
  return turns
    .slice(-max)
    .map((t) => `${t.role}: ${clip(t.content, 400)}`)
    .join("\n");
}

function buildInstructions(spec: AppStartupSpec): string {
  return [
    "You configure the STARTUP PARAMETERS for an app or game that is about to open",
    "for a child with special needs using an AAC (assistive communication) device.",
    "Choose parameters that best fit this particular student and the current",
    "conversation. When you are unsure, prefer the gentler / easier option — never",
    "overshoot a child's ability. Output ONLY a JSON object matching the schema.",
    "",
    `App: ${spec.appId}`,
    "Guidance:",
    spec.guidance.trim(),
  ].join("\n");
}

function buildUserMessage(ctx: StartupResolveContext): string {
  const parts = [
    section(
      "STUDENT",
      [
        ctx.studentDisplayName ? `Name: ${ctx.studentDisplayName}` : "",
        ctx.languageName ? `Language: ${ctx.languageName}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    section("PERSONA", ctx.persona),
    section("SESSION GOALS", ctx.sessionGoals),
    section("MEMORY", ctx.memoryContext),
    section("SESSION SUMMARY", ctx.sessionSummary),
    section("RECENT", turnsToText(ctx.recentTurns)),
    section("PENDING", turnsToText(ctx.pendingTurns, 4)),
    section(
      "TRIGGER",
      ctx.trigger.source === "ai"
        ? `The AI assistant chose to open this app.${ctx.trigger.data ? ` Hint from the AI: ${ctx.trigger.data}` : ""}`
        : "The student pressed the app themselves.",
    ),
  ].filter(Boolean);

  return parts.join("\n\n") || "No additional context. Choose sensible defaults.";
}

/** Best-effort one-line summary of the chosen params for the live AI's context. */
function summarizeParams(params: StartupParams): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!entries.length) return "";
  return entries
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("/") : String(v)}`)
    .join(", ");
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!ms || ms <= 0) return Promise.reject(new Error("resolver-disabled"));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("resolver-timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Resolve startup params for an app. Always resolves; never rejects.
 */
export async function resolveAppStartupParams(
  ctx: StartupResolveContext,
): Promise<StartupResolveResult> {
  const { spec } = ctx;
  const defaults: StartupParams = { ...spec.defaults };

  // No API key → don't even try.
  if (!process.env.GEMINI_API_KEY) {
    return { params: defaults, usedDefaults: true };
  }

  try {
    const gpt = new GPT({ provider: "gemini", model: resolverModel() });
    const input: GPTInputItem[] = [
      { type: "message", role: "user", content: buildUserMessage(ctx) },
    ];

    const response = await withTimeout(
      gpt.getStructuredResponse(
        input,
        `${spec.appId}_startup`,
        spec.paramsSchema,
        [],
        spec.maxTokens ?? 256,
        1,
        { temperature: 0.3 },
        false,
        1,
        buildInstructions(spec),
      ),
      resolverTimeoutMs(),
    );

    // Bill the real call (tokens were spent regardless of parse success).
    if (response.promptTokens || response.completionTokens) {
      ctx.trackUsage?.(response.promptTokens, response.completionTokens, response.cachedTokens ?? 0, resolverModel());
    }

    let raw: unknown;
    try {
      raw = typeof response.content === "string" ? JSON.parse(response.content) : response.content;
    } catch {
      raw = undefined;
    }

    const params = validateAndMergeParams(spec.paramsSchema, raw, defaults);
    const note = summarizeParams(params);
    return {
      params,
      usedDefaults: raw === undefined,
      resolverNote: note || undefined,
    };
  } catch (err) {
    console.warn(`[startup-resolver] ${spec.appId}: falling back to defaults (${String(err)})`);
    return { params: defaults, usedDefaults: true };
  }
}
