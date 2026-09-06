import type { Request, Response } from "express";
import { paddleService } from "../services/paddleService";
import { paddleLog } from "../services/paddle-debug-log";
import {
  getPaddleFulfillmentService,
  type PaddleEventLike,
} from "../services/paddleFulfillmentService";
import { paddleEventRepository } from "../repositories/paddleEventRepository";
import { notifyPaddleFulfillmentProblem } from "../services/providerAlertService";

export class PaddleController {
  /** Public config for paddle-js (client token + environment). */
  async getConfig(req: Request, res: Response): Promise<void> {
    res.json({
      environment: paddleService.environment,
      clientToken: paddleService.clientToken ?? null,
    });
  }

  /**
   * POST /api/paddle/webhook — Paddle's notification endpoint.
   *
   * UNAUTHENTICATED by design: Paddle has no session and no bearer token to
   * offer, so the HMAC signature over the raw body IS the authentication. That
   * makes three things load-bearing:
   *
   *  • The raw body. `express.raw` is mounted for this exact path ahead of the
   *    global `express.json` (see middleware/paddle-webhook-raw.ts). If this
   *    handler ever sees a parsed object instead of a Buffer, that ordering has
   *    been broken and we must refuse rather than skip verification.
   *
   *  • Silence on rejection. A 400 says nothing about WHY — missing header,
   *    malformed header, wrong secret and stale timestamp are one response, so
   *    the endpoint cannot be used as an oracle for forging a signature.
   *
   *  • The status codes. 200 means "settled, never send this again"; that
   *    covers success AND anything we deliberately ignored, because Paddle
   *    retries a non-2xx and an unfulfillable event would be retried forever.
   *    Only a genuine fault returns 500, which is exactly when we DO want the
   *    retry.
   */
  async handleWebhook(req: Request, res: Response): Promise<void> {
    const signature = req.header("paddle-signature");
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString("utf8")
      : typeof req.body === "string"
        ? req.body
        : null;

    if (!signature || !rawBody) {
      paddleLog("webhook: rejected", {
        hasSignature: Boolean(signature),
        rawBody: rawBody === null ? "not-raw" : "present",
      });
      res.status(400).json({ message: "Invalid webhook request" });
      return;
    }

    let event: PaddleEventLike;
    try {
      event = (await paddleService.verifyWebhook(rawBody, signature)) as PaddleEventLike;
    } catch (error: any) {
      paddleLog("webhook: signature verification failed", { error: error?.message });
      res.status(400).json({ message: "Invalid webhook request" });
      return;
    }

    if (!event?.eventId || !event?.eventType) {
      paddleLog("webhook: verified body is not an event", { event });
      res.status(400).json({ message: "Invalid webhook request" });
      return;
    }

    const occurredAt = event.occurredAt ? new Date(event.occurredAt) : new Date();

    try {
      // The insert IS the idempotency claim — it happens before any credit is
      // granted, so a redelivery collides on the primary key rather than paying
      // out twice.
      const claim = await paddleEventRepository.claimEvent({
        id: event.eventId,
        eventType: event.eventType,
        occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
        payload: JSON.parse(rawBody),
      });

      if (!claim.claimed) {
        if (claim.row.status === "failed") {
          // A previous attempt threw. Paddle is retrying, which is what we
          // asked for by returning 500 — let it run again.
          paddleLog(`webhook: reprocessing previously failed event ${event.eventId}`);
          await paddleEventRepository.reopenFailed(event.eventId);
        } else {
          paddleLog(
            `webhook: duplicate event ${event.eventId} (status ${claim.row.status}) — no-op`,
          );
          res.status(200).json({ received: true, duplicate: true });
          return;
        }
      }

      const fulfillment = await getPaddleFulfillmentService();
      const outcome = await fulfillment.handleEvent(event);

      if (outcome.status === "ignored") {
        await paddleEventRepository.setStatus(event.eventId, "ignored", outcome.reason);
        paddleLog(`webhook: ignored ${event.eventId}`, { reason: outcome.reason });
        // Ignoring a COMPLETED transaction means money arrived and no license
        // moved — and Paddle won't retry a 200, so this is the only doorbell.
        if (event.eventType === "transaction.completed") {
          notifyPaddleFulfillmentProblem({
            kind: "unfulfilled",
            eventId: event.eventId,
            eventType: event.eventType,
            detail: outcome.reason,
          });
        }
      } else {
        await paddleEventRepository.setStatus(
          event.eventId,
          "processed",
          outcome.actions.join("; ") || null,
        );
        paddleLog(`webhook: processed ${event.eventId}`, { actions: outcome.actions });
      }

      res.status(200).json({ received: true });
    } catch (error: any) {
      paddleLog(`webhook: FAILED ${event.eventId}`, {
        error: error?.message,
        stack: error?.stack,
      });
      notifyPaddleFulfillmentProblem({
        kind: "failed",
        eventId: event.eventId,
        eventType: event.eventType,
        detail: String(error?.message ?? error),
      });
      try {
        await paddleEventRepository.setStatus(
          event.eventId,
          "failed",
          String(error?.message ?? error),
        );
      } catch (markError: any) {
        paddleLog("webhook: could not record failure", { error: markError?.message });
      }
      // 500 on purpose: Paddle will retry, and the `failed` row above is what
      // lets the retry run instead of being swallowed as a duplicate.
      res.status(500).json({ message: "Webhook processing failed" });
    }
  }
}

export const paddleController = new PaddleController();
