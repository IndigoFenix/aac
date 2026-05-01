import type { Request, Response } from "express";
import {
  getCrmChatConfig,
  identifyAndPrepare,
  onCrmMessage,
  onCrmMessageStreaming,
  CrmChatBlockedError,
  CrmChatBudgetExceededError,
  CrmChatDisabledError,
} from "../services/crmChat/crmChatService";
import { hashIp, getClientIp } from "../services/crmChat/identify";
import {
  messageLimiter,
  identifyLimiter,
  configLimiter,
  globalMessageLimiter,
} from "../services/crmChat/rateLimiter";

/**
 * Decide whether the request is allowed under both the per-IP limiter and
 * (if `applyGlobal`) the per-process flood cap. Returns the 429 retry-after
 * (worst-case across the limiters) when blocked.
 */
function checkRateLimits(
  ipHash: string,
  perIp: typeof messageLimiter,
  applyGlobal: boolean,
): { ok: true } | { ok: false; retryAfterMs: number } {
  const ipDecision = perIp.check(ipHash);
  if (!ipDecision.ok) {
    return { ok: false, retryAfterMs: ipDecision.retryAfterMs ?? 60_000 };
  }
  if (applyGlobal) {
    const globalDecision = globalMessageLimiter.check();
    if (!globalDecision.ok) {
      return { ok: false, retryAfterMs: globalDecision.retryAfterMs ?? 60_000 };
    }
  }
  return { ok: true };
}

export class CrmChatController {
  // GET /api/crm-chat/config — public, no auth. Tells the widget whether to render.
  async getConfig(req: Request, res: Response): Promise<void> {
    const ipHash = hashIp(getClientIp(req));
    const limited = configLimiter.check(ipHash);
    if (!limited.ok) {
      // For config polling we 429 silently (no error body) — the widget
      // hides itself until a future poll succeeds.
      res
        .status(429)
        .json({ enabled: false, retryAfterMs: limited.retryAfterMs ?? 60_000 });
      return;
    }
    try {
      const config = await getCrmChatConfig();
      res.json(config);
    } catch (error: any) {
      console.error("[crmChatController] getConfig failed:", error);
      res.status(500).json({ enabled: false });
    }
  }

  // POST /api/crm-chat/identify — public. Creates/finds the visitor record;
  // returns prior session history if a resumable one exists.
  async identify(req: Request, res: Response): Promise<void> {
    const ipHash = hashIp(getClientIp(req));
    const limited = identifyLimiter.check(ipHash);
    if (!limited.ok) {
      res
        .status(429)
        .json({ error: "rate_limited", retryAfterMs: limited.retryAfterMs ?? 60_000 });
      return;
    }
    try {
      const result = await identifyAndPrepare(req);
      res.json({
        potentialCustomerId: result.potentialCustomerId,
        sessionId: result.sessionId,
        history: result.history,
        isReturning: result.isReturning,
      });
    } catch (error) {
      if (error instanceof CrmChatDisabledError) {
        res.status(404).json({ error: "crm_chat_disabled" });
        return;
      }
      if (error instanceof CrmChatBlockedError) {
        res.status(403).json({ error: "blocked" });
        return;
      }
      console.error("[crmChatController] identify failed:", error);
      res.status(500).json({ error: "internal_error" });
    }
  }

  // POST /api/crm-chat/message — public. One conversational turn.
  async sendMessage(req: Request, res: Response): Promise<void> {
    const ip = getClientIp(req);
    const ipHash = hashIp(ip);

    const limited = checkRateLimits(ipHash, messageLimiter, /* applyGlobal */ true);
    if (!limited.ok) {
      res.status(429).json({ error: "rate_limited", retryAfterMs: limited.retryAfterMs });
      return;
    }

    const { potentialCustomerId, sessionId, text } = req.body ?? {};

    if (typeof text !== "string" || text.trim().length === 0) {
      res.status(400).json({ error: "text_required" });
      return;
    }
    if (text.length > 4000) {
      res.status(400).json({ error: "text_too_long" });
      return;
    }

    try {
      const result = await onCrmMessage({
        req,
        potentialCustomerId:
          typeof potentialCustomerId === "string" ? potentialCustomerId : undefined,
        sessionId: typeof sessionId === "string" ? sessionId : undefined,
        text,
      });
      res.json({
        potentialCustomerId: result.potentialCustomerId,
        sessionId: result.sessionId,
        message: result.message,
      });
    } catch (error) {
      if (error instanceof CrmChatDisabledError) {
        res.status(404).json({ error: "crm_chat_disabled" });
        return;
      }
      if (error instanceof CrmChatBlockedError) {
        res.status(403).json({ error: "blocked" });
        return;
      }
      if (error instanceof CrmChatBudgetExceededError) {
        res.status(429).json({ error: "daily_budget_exceeded" });
        return;
      }
      console.error("[crmChatController] sendMessage failed:", error);
      res.status(500).json({ error: "internal_error" });
    }
  }

  // POST /api/crm-chat/message-stream — public. SSE stream of one turn.
  // Mirrors the internal /api/chat/stream md path: token-by-token text_delta
  // events, then a final `complete` event with the full assistant message.
  async sendMessageStream(req: Request, res: Response): Promise<void> {
    const ip = getClientIp(req);
    const ipHash = hashIp(ip);

    const limited = checkRateLimits(ipHash, messageLimiter, /* applyGlobal */ true);
    if (!limited.ok) {
      res.status(429).json({ error: "rate_limited", retryAfterMs: limited.retryAfterMs });
      return;
    }

    const { potentialCustomerId, sessionId, text } = req.body ?? {};

    if (typeof text !== "string" || text.trim().length === 0) {
      res.status(400).json({ error: "text_required" });
      return;
    }
    if (text.length > 4000) {
      res.status(400).json({ error: "text_too_long" });
      return;
    }

    // SSE headers — match the internal chat stream so the same proxy/CDN
    // configs (no buffering, keepalive) apply.
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(": keepalive\n\n");
    }, 30_000);

    const send = (event: string, data: unknown) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const abort = new AbortController();
    const onClose = () => abort.abort();
    req.on("close", onClose);

    try {
      const stream = onCrmMessageStreaming({
        req,
        potentialCustomerId:
          typeof potentialCustomerId === "string" ? potentialCustomerId : undefined,
        sessionId: typeof sessionId === "string" ? sessionId : undefined,
        text,
        signal: abort.signal,
      });

      for await (const event of stream) {
        if (res.writableEnded) break;
        send(event.type, event);
      }

      send("close", {});
    } catch (error) {
      if (error instanceof CrmChatDisabledError) {
        send("error", { error: "crm_chat_disabled" });
      } else if (error instanceof CrmChatBlockedError) {
        send("error", { error: "blocked" });
      } else if (error instanceof CrmChatBudgetExceededError) {
        send("error", { error: "daily_budget_exceeded" });
      } else {
        console.error("[crmChatController] sendMessageStream failed:", error);
        send("error", { error: "internal_error" });
      }
    } finally {
      clearInterval(keepalive);
      req.off("close", onClose);
      if (!res.writableEnded) res.end();
    }
  }
}

export const crmChatController = new CrmChatController();
