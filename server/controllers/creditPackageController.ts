import type { Request, Response } from "express";
import { creditService } from "../services";

export class CreditPackageController {
  async getCreditPackages(req: Request, res: Response): Promise<void> {
    try {
      const packages = await creditService.getAllCreditPackages();
      res.json({ packages });
    } catch (error: any) {
      console.error("Error fetching credit packages:", error);
      res.status(500).json({ message: "Failed to fetch credit packages" });
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
