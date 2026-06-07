import type { Request, Response } from "express";
import { paddleService } from "../services/paddleService";

export class PaddleController {
  /** Public config for paddle-js (client token + environment). */
  async getConfig(req: Request, res: Response): Promise<void> {
    res.json({
      environment: paddleService.environment,
      clientToken: paddleService.clientToken ?? null,
    });
  }

  /** List catalog prices so the test page can render a checkout button each. */
  async listPrices(req: Request, res: Response): Promise<void> {
    try {
      if (!paddleService.isConfigured()) {
        res.status(503).json({ message: "Paddle API key not configured" });
        return;
      }
      const prices = await paddleService.listPrices();
      res.json({
        prices: prices.map((p) => ({
          id: p.id,
          description: p.description,
          amount: p.unitPrice?.amount ?? null,
          currencyCode: p.unitPrice?.currencyCode ?? null,
          status: p.status,
        })),
      });
    } catch (error: any) {
      console.error("Error listing Paddle prices:", error);
      res
        .status(500)
        .json({ message: "Error listing prices: " + error.message });
    }
  }

  /**
   * Create a throwaway one-time test product + price so the checkout page works
   * on a fresh sandbox. Returns the new priceId. Sandbox/test convenience only.
   */
  async createTestPrice(req: Request, res: Response): Promise<void> {
    try {
      if (!paddleService.isConfigured()) {
        res.status(503).json({ message: "Paddle API key not configured" });
        return;
      }
      const product = await paddleService.createProduct({
        name: "Aivota Test Item",
        taxCategory: "standard",
      });
      const price = await paddleService.createPrice({
        description: "Aivota Test — one-time $9.99",
        productId: product.id,
        unitPrice: { amount: "999", currencyCode: "USD" },
        taxMode: "account_setting",
        quantity: { minimum: 1, maximum: 1 },
      });
      res.json({
        price: {
          id: price.id,
          description: price.description,
          amount: price.unitPrice?.amount ?? null,
          currencyCode: price.unitPrice?.currencyCode ?? null,
        },
      });
    } catch (error: any) {
      console.error("Error creating Paddle test price:", error);
      res
        .status(500)
        .json({ message: "Error creating test price: " + error.message });
    }
  }
}

export const paddleController = new PaddleController();
