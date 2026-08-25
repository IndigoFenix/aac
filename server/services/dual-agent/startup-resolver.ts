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

import type {
  AppStartupSpec,
  StartupParams,
  AiOpenPolicy,
  AiOpenDecision,
} from "@shared/app-startup";
import { validateAndMergeParams, AI_OPEN_DECISION_SCHEMA } from "@shared/app-startup";
import { GPT, type GPTInputItem } from "../chat/gpt";
import { vertexConfigured } from "../providers/vertex-config";

/**
 * Can we reach Gemini at all?
 *
 * NOT "is there an API key". The structured provider prefers Vertex, so a
 * deployment with a GCP project configured and no `GEMINI_API_KEY` is fully
 * working — and checking only the key would silently disable both resolvers
 * there, which is the exact class of quiet downgrade `vertex-config` exists to
 * stop.
 */
function geminiReachable(): boolean {
  return vertexConfigured() || !!process.env.GEMINI_API_KEY;
}

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

// Takes the context WITHOUT the spec: it reads only student/session material
// and the trigger, so the open decision (which has no spec) reuses it as-is.
function buildUserMessage(ctx: Omit<StartupResolveContext, "spec">): string {
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

/**
 * Run a model call under a deadline. `ms <= 0` means the resolver is switched
 * off and the call is declined outright.
 *
 * 🚨 TAKES A THUNK, NOT A PROMISE, AND MUST KEEP DOING SO. This used to accept
 * the promise — `withTimeout(gpt.getStructuredResponse(...), resolverTimeoutMs())`
 * — and a guard inside a function cannot stop a call that was passed to it as
 * an argument, because arguments are evaluated before the callee runs. So the
 * "off" switch dutifully declined to AWAIT a request it had already SENT:
 * `AAC_STARTUP_RESOLVER_TIMEOUT_MS=0` billed a full Gemini call on every app
 * open and every AI-open decision, then dropped the answer on the floor.
 * Turning the feature off cost exactly what leaving it on cost. It also
 * orphaned the request — nothing awaited it — which is how the unit suite
 * ended up with a live Vertex call outliving its worker and crashing it with
 * ERR_VM_MODULE_NOT_MODULE after the tests had already reported PASS.
 *
 * Note what this does NOT do: when a real timeout fires the request is still
 * in flight and still billed, it is merely no longer waited on. Cancelling it
 * needs an AbortController threaded through GPT, which nothing does yet.
 */
function withTimeout<T>(start: () => Promise<T>, ms: number): Promise<T> {
  if (!ms || ms <= 0) return Promise.reject(new Error("resolver-disabled"));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("resolver-timeout")), ms);
    const settle = (fn: (v: any) => void) => (v: any) => {
      clearTimeout(timer);
      fn(v);
    };
    try {
      start().then(settle(resolve), settle(reject));
    } catch (err) {
      // A synchronous throw out of `start` would otherwise leave the timer
      // armed and the promise pending until it fired.
      clearTimeout(timer);
      reject(err);
    }
  });
}

/** Context for the open decision — the same session material the params
 *  resolver gets, minus the spec, plus which app is being asked about. */
export interface AiOpenDecisionContext extends Omit<StartupResolveContext, "spec"> {
  appId: string;
  appName: string;
  policy: AiOpenPolicy;
}

function buildDecisionInstructions(ctx: AiOpenDecisionContext): string {
  return [
    "An AI assistant talking with a child who uses an AAC (assistive",
    "communication) device has just decided to open an app on the child's",
    "screen. Your only job is to say whether that is what the child actually",
    "wants right now.",
    "",
    `App: ${ctx.appName} (${ctx.appId})`,
    "When this app is the right thing to open, and when it is not:",
    ctx.policy.guidance.trim(),
    "",
    "The assistant reaches for whichever app matches a word it just heard, so",
    "the common mistake is opening on a NOUN rather than on a request. Read",
    "what the child actually asked for.",
    "",
    "Say open=false when the app is not what they meant, and put what they DID",
    "mean in `reason` so the assistant can answer that instead. Say open=true",
    "when they asked for it, agreed to it, or it plainly fits what is",
    "happening. If it is genuinely a close call, allow it: a wrong app costs",
    "one press to leave, and a child who asked for something and got nothing",
    "cannot ask again a different way.",
  ].join("\n");
}

/**
 * Should this AI-initiated app open happen?
 *
 * FAILS OPEN, always. No key, a timeout, a malformed answer, an exception —
 * every one of them returns `open: true`, because a resolver outage that
 * silently stopped apps from opening would be a worse and much less legible
 * failure than the mis-opens this exists to catch.
 *
 * Never called for a student press. Pressing the tile, or a launch button the
 * Board Manager offered, IS the ask.
 */
export async function decideAiOpen(ctx: AiOpenDecisionContext): Promise<AiOpenDecision> {
  const allow: AiOpenDecision = { open: true, failedOpen: true };
  if (!geminiReachable()) return allow;

  try {
    const gpt = new GPT({ provider: "gemini", model: resolverModel() });
    const response = await withTimeout(
      () => gpt.getStructuredResponse(
        [{ type: "message", role: "user", content: buildUserMessage(ctx) }],
        `${ctx.appId}_open_decision`,
        AI_OPEN_DECISION_SCHEMA,
        [],
        128,
        1,
        { temperature: 0 },
        false,
        1,
        buildDecisionInstructions(ctx),
      ),
      resolverTimeoutMs(),
    );

    if (response.promptTokens || response.completionTokens) {
      ctx.trackUsage?.(
        response.promptTokens,
        response.completionTokens,
        response.cachedTokens ?? 0,
        resolverModel(),
      );
    }

    let raw: unknown;
    try {
      raw = typeof response.content === "string" ? JSON.parse(response.content) : response.content;
    } catch {
      return allow;
    }

    const parsed = raw as { open?: unknown; reason?: unknown } | undefined;
    // Only an explicit `false` blocks. Anything else — missing, null, a string,
    // a model that answered the wrong question — is not a refusal.
    if (parsed && parsed.open === false) {
      return {
        open: false,
        reason: typeof parsed.reason === "string" ? parsed.reason.trim() : undefined,
      };
    }
    return { open: true };
  } catch (err) {
    console.warn(`[startup-resolver] ${ctx.appId}: open decision failed open (${String(err)})`);
    return allow;
  }
}

/**
 * Resolve startup params for an app. Always resolves; never rejects.
 */
export async function resolveAppStartupParams(
  ctx: StartupResolveContext,
): Promise<StartupResolveResult> {
  const { spec } = ctx;
  const defaults: StartupParams = { ...spec.defaults };

  // No way to reach Gemini → don't even try.
  if (!geminiReachable()) {
    return { params: defaults, usedDefaults: true };
  }

  try {
    const gpt = new GPT({ provider: "gemini", model: resolverModel() });
    const input: GPTInputItem[] = [
      { type: "message", role: "user", content: buildUserMessage(ctx) },
    ];

    const response = await withTimeout(
      () => gpt.getStructuredResponse(
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
