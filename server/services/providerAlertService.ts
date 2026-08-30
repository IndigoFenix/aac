// server/services/providerAlertService.ts
//
// Operational alerts about our LLM PROVIDER accounts (Google / Anthropic /
// OpenAI) running low or out of credit. Two independent triggers:
//
//   1. Depletion (event-driven). When a live request is rejected by a provider
//      for a billing / insufficient-credit reason, we email support the first
//      time it happens (then throttle per provider). This is the reliable
//      "we've run out" signal — provider APIs don't expose a live balance, so
//      the rejection itself is the earliest trustworthy indication.
//
//   2. Spend threshold (cron-driven). A daily sweep sums this calendar month's
//      provider cost (from the same chat_sessions cost data the admin Cost &
//      Usage dashboard uses) and emails support if any provider has passed a
//      configured share of its monthly cap — an EARLY warning before depletion.
//      Opt-in: a provider with no configured cap is never threshold-alerted.
//
// Alerts go to a single support inbox. Emails are best-effort and must never
// break the calling flow (all sends are fire-and-forget / caught).
//
// Config (all optional):
//   PROVIDER_ALERT_EMAIL              recipient (default: cs@aivota.ai)
//   PROVIDER_ALERT_COOLDOWN_MIN       per-provider depletion cooldown (default 360)
//   LLM_MONTHLY_CAP_GOOGLE_USD        monthly cap, USD (unset = no threshold alert)
//   LLM_MONTHLY_CAP_ANTHROPIC_USD     monthly cap, USD
//   LLM_MONTHLY_CAP_OPENAI_USD        monthly cap, USD
//   LLM_SPEND_ALERT_THRESHOLD_PCT     alert at this % of cap (default 80)

import { emailService } from "./emailService";
import { chatRepository } from "../repositories/chatRepository";
import { sendOperationalAlert } from "./operationalAlert";

// The three provider "accounts" we bill against. Labels match the admin Cost &
// Usage dashboard so figures line up with what an operator sees there.
export type ProviderAccount = "Google" | "Anthropic (Claude)" | "OpenAI";
const ALL_PROVIDERS: ProviderAccount[] = ["Google", "Anthropic (Claude)", "OpenAI"];

const RECIPIENT = process.env.PROVIDER_ALERT_EMAIL || "cs@aivota.ai";

// Credits are stored 1:1 with USD (cost-helpers' ChargeToCredits is identity),
// so month-to-date credit sums and the USD caps are directly comparable.
const CAP_ENV: Record<ProviderAccount, string> = {
  "Google": "LLM_MONTHLY_CAP_GOOGLE_USD",
  "Anthropic (Claude)": "LLM_MONTHLY_CAP_ANTHROPIC_USD",
  "OpenAI": "LLM_MONTHLY_CAP_OPENAI_USD",
};

// ─── Depletion detection ─────────────────────────────────────────────────────

/**
 * True when `error` is a provider rejecting a request for lack of credit /
 * billing — i.e. the account has run dry. Deliberately does NOT match bare
 * "quota"/"rate limit" (those are transient per-minute limits, not depletion).
 * Superset of sessionService's local billing check, spanning all three vendors:
 *   Anthropic → "credit balance is too low"
 *   OpenAI    → "insufficient_quota" / "exceeded your current quota"
 *   Google    → billing-account errors ("billing")
 */
export function isProviderCreditError(error: any): boolean {
  const msg = (error?.message || error?.error?.message || "").toLowerCase();
  return (
    msg.includes("credit balance is too low") ||
    msg.includes("insufficient_quota") ||
    msg.includes("exceeded your current quota") ||
    msg.includes("billing")
  );
}

/** Best-effort provider attribution from the error text. */
export function providerFromError(error: any): ProviderAccount | "Unknown" {
  const msg = (error?.message || error?.error?.message || "").toLowerCase();
  if (msg.includes("anthropic") || msg.includes("credit balance")) return "Anthropic (Claude)";
  if (msg.includes("insufficient_quota") || msg.includes("current quota") || msg.includes("openai")) return "OpenAI";
  if (msg.includes("google") || msg.includes("gemini") || msg.includes("vertex") || msg.includes("generativelanguage")) return "Google";
  return "Unknown";
}

// Per-provider cooldown so a burst of failed requests yields ONE email, not one
// per request. In-memory: on a cold start (Lambda) the map resets and at most
// one extra email may go out — acceptable for a rare, clustered event.
const lastDepletionAlert = new Map<string, number>();

function cooldownMs(): number {
  const min = Number(process.env.PROVIDER_ALERT_COOLDOWN_MIN);
  return (Number.isFinite(min) && min > 0 ? min : 360) * 60_000;
}

/**
 * Report a provider billing/credit rejection. Throttled per provider; sends an
 * alert email to support. Fire-and-forget — never throws, never blocks.
 */
export function notifyProviderCreditFailure(opts: {
  error: any;
  /** Where it happened, e.g. "clinician-chat", "aac-session". */
  source: string;
  /** Override the inferred provider when the caller already knows it. */
  providerHint?: ProviderAccount;
}): void {
  void (async () => {
    try {
      const provider = opts.providerHint ?? providerFromError(opts.error);
      const key = String(provider);
      const now = Date.now();
      const last = lastDepletionAlert.get(key) ?? 0;
      if (now - last < cooldownMs()) return; // within cooldown — already alerted
      lastDepletionAlert.set(key, now);

      const rawMsg = opts.error?.message || opts.error?.error?.message || String(opts.error);
      const detail = String(rawMsg).slice(0, 500);
      const subject = `⚠️ LLM credit alert: ${provider} request rejected (billing)`;
      const lines = [
        `A request to ${provider} was rejected for a billing / insufficient-credit reason.`,
        `This usually means the provider account has run out of credit and needs topping up.`,
        ``,
        `Provider:   ${provider}`,
        `Source:     ${opts.source}`,
        `Time (UTC): ${new Date(now).toISOString()}`,
        `Error:      ${detail}`,
      ];
      await sendAlertEmail(subject, lines);
      console.warn(`[providerAlert] Sent depletion alert for ${provider} (source=${opts.source})`);
    } catch (err) {
      console.error("[providerAlert] Failed to send depletion alert:", err);
    }
  })();
}

// ─── Spend-threshold sweep (cron) ────────────────────────────────────────────

/** Local YYYY-MM-DD, matching getCostUsageAnalytics' date-string filter. */
function localIsoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Map a cost_breakdown category to a provider account. Mirrors the admin
 * dashboard's `categoryProvider` so operator-facing figures agree: image work
 * is OpenAI; clinician chat + the AAC Monitor are Claude; everything else
 * (AAC live agents, TTS, STT) is Google.
 */
function categoryProvider(source: "aac" | "chat", category: string): ProviderAccount {
  const c = category.toLowerCase();
  if (c.includes("image")) return "OpenAI";
  if (source === "chat") return "Anthropic (Claude)";
  if (c.includes("monitor")) return "Anthropic (Claude)";
  return "Google";
}

export interface SpendThresholdResult {
  ran: boolean;                 // false when no caps configured (feature off)
  monthStart: string;
  thresholdPct: number;
  spend: Record<string, number>; // provider -> month-to-date USD
  breached: Array<{ provider: string; spend: number; cap: number; pct: number }>;
  alerted: boolean;
}

/**
 * Sum this calendar month's provider spend and email support if any provider is
 * at/over its configured share of cap. One digest email per run (≤1/day via the
 * cron), so being over budget yields a daily nudge rather than a flood.
 */
export async function runSpendThresholdCheck(): Promise<SpendThresholdResult> {
  const thresholdPct = (() => {
    const p = Number(process.env.LLM_SPEND_ALERT_THRESHOLD_PCT);
    return Number.isFinite(p) && p > 0 && p <= 100 ? p : 80;
  })();

  const caps: Partial<Record<ProviderAccount, number>> = {};
  for (const provider of ALL_PROVIDERS) {
    const raw = process.env[CAP_ENV[provider]];
    const cap = raw != null ? Number(raw) : NaN;
    if (Number.isFinite(cap) && cap > 0) caps[provider] = cap;
  }

  const now = new Date();
  const monthStart = localIsoDay(new Date(now.getFullYear(), now.getMonth(), 1));

  // No caps configured → feature is off; do nothing (and don't query the DB).
  if (Object.keys(caps).length === 0) {
    return { ran: false, monthStart, thresholdPct, spend: {}, breached: [], alerted: false };
  }

  const analytics = await chatRepository.getCostUsageAnalytics({
    startDate: monthStart,
    endDate: localIsoDay(now),
  });

  const spend: Record<ProviderAccount, number> = { "Google": 0, "Anthropic (Claude)": 0, "OpenAI": 0 };
  for (const source of ["aac", "chat"] as const) {
    const breakdown = analytics.categoryBreakdown[source] ?? {};
    for (const [category, amount] of Object.entries(breakdown)) {
      if (!(amount > 0)) continue;
      spend[categoryProvider(source, category)] += amount;
    }
  }

  const breached: SpendThresholdResult["breached"] = [];
  for (const provider of ALL_PROVIDERS) {
    const cap = caps[provider];
    if (cap == null) continue;
    const used = spend[provider];
    const pct = (used / cap) * 100;
    if (pct >= thresholdPct) {
      breached.push({ provider, spend: used, cap, pct });
    }
  }

  let alerted = false;
  if (breached.length > 0) {
    const subject = `⚠️ LLM monthly spend alert: ${breached.map((b) => b.provider).join(", ")}`;
    const lines = [
      `One or more provider accounts have passed ${thresholdPct}% of their configured monthly cap`,
      `for ${monthStart.slice(0, 7)} (month-to-date, provider cost in USD):`,
      ``,
      ...breached.map(
        (b) => `  • ${b.provider}: $${b.spend.toFixed(2)} of $${b.cap.toFixed(2)} cap (${b.pct.toFixed(0)}%)`,
      ),
      ``,
      `Top up or raise the cap before requests start getting rejected.`,
    ];
    try {
      await sendAlertEmail(subject, lines);
      alerted = true;
      console.warn(`[providerAlert] Sent spend-threshold alert: ${breached.map((b) => b.provider).join(", ")}`);
    } catch (err) {
      console.error("[providerAlert] Failed to send spend-threshold alert:", err);
    }
  }

  return { ran: true, monthStart, thresholdPct, spend, breached, alerted };
}

let scheduledTimer: NodeJS.Timeout | null = null;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Idempotent daily scheduler for the spend-threshold sweep. No-op in tests and
 * a no-op on Lambda where setInterval never fires — there the /internal/run-crons
 * endpoint drives runSpendThresholdCheck instead. Deferred 120s after boot to
 * stagger from the other daily crons.
 */
export function scheduleSpendThresholdCheck(): void {
  if (scheduledTimer) return;
  if (process.env.NODE_ENV === "test") return;

  setTimeout(() => {
    runSpendThresholdCheck()
      .then((r) => {
        if (r.ran) {
          console.log(`[providerAlert] Initial spend check: ${r.breached.length} provider(s) over ${r.thresholdPct}%.`);
        }
      })
      .catch((err) => console.error("[providerAlert] Initial spend check failed:", err));
  }, 120_000);

  scheduledTimer = setInterval(() => {
    runSpendThresholdCheck().catch((err) => console.error("[providerAlert] Scheduled spend check failed:", err));
  }, ONE_DAY_MS);
}

// ─── Email plumbing ──────────────────────────────────────────────────────────

// The shell (recipient handling, HTML wrapper, never-throw) lives in
// operationalAlert.ts so the security-incident sweep uses the same one.
// RECIPIENT stays honoured here: PROVIDER_ALERT_EMAIL is an existing knob and
// provider alerts may want a different mailbox from incident alerts.
async function sendAlertEmail(subject: string, lines: string[]): Promise<void> {
  await sendOperationalAlert(subject, lines, {
    recipient: RECIPIENT,
    logPrefix: "[providerAlert]",
  });
}
