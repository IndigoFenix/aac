import type { Request, Response } from "express";
import { userRepository } from "../repositories";
import { inviteCodeService, studentService } from "../services";

export class OnboardingController {
  /**
   * POST /api/onboarding/redeem-code
   * Redeem invite code during onboarding
   *
   * When a code is redeemed, it links the current user to the AAC user
   * associated with the invite code.
   */
  async redeemCode(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as { id: string };
      const { code } = req.body;

      console.log("Onboarding - Redeem code request:", {
        userId: currentUser.id,
        codeLength: code?.length,
      });

      if (!code || typeof code !== "string") {
        res.status(400).json({
          success: false,
          message: "Invite code is required",
          errorType: "validation_error",
        });
        return;
      }

      // Use existing redemption logic
      const result = await inviteCodeService.redeemInviteCode(
        code.trim().toUpperCase(),
        currentUser.id
      );

      if (!result.success) {
        console.log("Onboarding - Code redemption failed:", result.error);
        res.status(400).json({
          success: false,
          message: result.error || "Failed to redeem invite code",
          errorType: "redemption_failed",
        });
        return;
      }

      // Update user's onboarding step to 3 (complete) - bypass remaining steps
      await userRepository.updateUserOnboardingStep(currentUser.id, 3);
      console.log("Onboarding - Code redeemed successfully, onboarding completed");

      // Include calculated age for backwards compatibility
      const studentWithAge = result.student ? {
        ...result.student,
        age: studentService.calculateAge(result.student.birthDate),
      } : undefined;

      res.json({
        success: true,
        message: "Invite code redeemed successfully. Onboarding complete!",
        student: studentWithAge,
        link: result.student ? `/aac/${result.student.id}` : undefined,
        onboardingStep: 3,
      });
    } catch (error: any) {
      console.error("Error redeeming code during onboarding:", {
        message: error.message,
        stack: error.stack,
      });
      res.status(500).json({
        success: false,
        message: "Failed to redeem invite code",
        errorType: "server_error",
      });
    }
  }
}

export const onboardingController = new OnboardingController();
