import type { Request, Response } from "express";
import Stripe from "stripe";
import { creditService, userService } from "../services";

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2024-12-18.acacia",
});

export class CreditPackageController {
  async getStripeConfig(req: Request, res: Response): Promise<void> {
    res.json({
      publicKey: process.env.VITE_STRIPE_PUBLIC_KEY,
    });
  }

  async getCreditPackages(req: Request, res: Response): Promise<void> {
    try {
      const packages = await creditService.getAllCreditPackages();
      res.json({ packages });
    } catch (error: any) {
      console.error("Error fetching credit packages:", error);
      res.status(500).json({ message: "Failed to fetch credit packages" });
    }
  }

  async createPaymentIntent(req: Request, res: Response): Promise<void> {
    try {
      const { packageId } = req.body;
      const user = req.user as any;

      if (!packageId) {
        res.status(400).json({ message: "Package ID is required" });
        return;
      }

      const creditPackage = await creditService.getCreditPackage(packageId);
      if (!creditPackage) {
        res.status(404).json({ message: "Credit package not found" });
        return;
      }

      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(creditPackage.price * 100), // Convert to cents
        currency: "usd",
        metadata: {
          userId: user.id.toString(),
          packageId: packageId.toString(),
          credits: creditPackage.credits.toString(),
          bonusCredits: creditPackage.bonusCredits.toString(),
        },
      });

      res.json({ clientSecret: paymentIntent.client_secret });
    } catch (error: any) {
      console.error("Error creating payment intent:", error);
      res
        .status(500)
        .json({ message: "Error creating payment intent: " + error.message });
    }
  }

  async confirmPayment(req: Request, res: Response): Promise<void> {
    try {
      const { paymentIntentId } = req.body;
      const user = req.user as any;

      if (!paymentIntentId) {
        res.status(400).json({ message: "Payment intent ID is required" });
        return;
      }

      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

      if (paymentIntent.status !== "succeeded") {
        res.status(400).json({ message: "Payment not completed" });
        return;
      }

      if (paymentIntent.metadata.userId !== user.id.toString()) {
        res
          .status(403)
          .json({ message: "Payment intent does not belong to current user" });
        return;
      }

      const credits = parseInt(paymentIntent.metadata.credits);
      const bonusCredits = parseInt(paymentIntent.metadata.bonusCredits);
      const totalCredits = credits + bonusCredits;
      const packageId = parseInt(paymentIntent.metadata.packageId);

      await creditService.addCredits(
        user.id,
        totalCredits,
        "purchase",
        `Credit purchase: ${credits} credits${bonusCredits > 0 ? ` + ${bonusCredits} bonus credits` : ""} (Package ID: ${packageId})`,
        paymentIntentId
      );

      const updatedUser = await userService.getUser(user.id);

      res.json({
        success: true,
        message: "Credits added successfully",
        credits: updatedUser?.credits,
        creditsAdded: totalCredits,
      });
    } catch (error: any) {
      console.error("Error confirming payment:", error);
      res
        .status(500)
        .json({ message: "Error confirming payment: " + error.message });
    }
  }

  // Admin routes
  async createCreditPackage(req: Request, res: Response): Promise<void> {
    try {
      const packageData = req.body;
      const creditPackage = await creditService.createCreditPackage(packageData);
      res.json({ success: true, creditPackage });
    } catch (error: any) {
      console.error("Error creating credit package:", error);
      res.status(500).json({ message: "Failed to create credit package" });
    }
  }

  async updateCreditPackage(req: Request, res: Response): Promise<void> {
    try {
      const packageId = req.params.id;
      const updates = req.body;

      const updatedPackage = await creditService.updateCreditPackage(
        packageId,
        updates
      );

      if (!updatedPackage) {
        res.status(404).json({ message: "Credit package not found" });
        return;
      }

      res.json({ success: true, creditPackage: updatedPackage });
    } catch (error: any) {
      console.error("Error updating credit package:", error);
      res.status(500).json({ message: "Failed to update credit package" });
    }
  }

  async deleteCreditPackage(req: Request, res: Response): Promise<void> {
    try {
      const packageId = req.params.id;
      const success = await creditService.deleteCreditPackage(packageId);

      if (!success) {
        res.status(404).json({ message: "Credit package not found" });
        return;
      }

      res.json({
        success: true,
        message: "Credit package deleted successfully",
      });
    } catch (error: any) {
      console.error("Error deleting credit package:", error);
      res.status(500).json({ message: "Failed to delete credit package" });
    }
  }
}

export const creditPackageController = new CreditPackageController();
