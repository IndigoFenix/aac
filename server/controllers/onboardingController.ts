import type { Request, Response } from "express";
import { userRepository, studentRepository } from "../repositories";
import { inviteCodeService, studentService } from "../services";
import { insertStudentScheduleSchema } from "@shared/schema";

export class OnboardingController {
  /**
   * GET /api/onboarding/status
   * Get current onboarding status
   */
  async getStatus(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as { id: string };
      const user = await userRepository.getUser(currentUser.id);

      if (!user) {
        res.status(404).json({
          success: false,
          message: "User not found",
        });
        return;
      }

      res.json({
        success: true,
        onboardingStep: user.onboardingStep,
      });
    } catch (error: any) {
      console.error("Error fetching onboarding status:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch onboarding status",
      });
    }
  }

  /**
   * POST /api/onboarding/complete-step-1
   * Complete Step 1: Create AAC User Profile
   * 
   */
  async completeStep1(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as { id: string };

      if (!req.body.name) {
        console.error("Onboarding Step 1 - Validation failed: missing name");
        res.status(400).json({
          success: false,
          message: "Name is required",
        });
        return;
      }

      // Create AAC user profile with link to the current user
      console.log("Onboarding Step 1 - Creating AAC user...");
      const { student, link } = await studentService.createStudentWithLink(
        { ...req.body },
        currentUser.id,
        "owner" // The creating user is the owner
      );
      
      console.log(
        "Onboarding Step 1 - AAC user created successfully:",
        student.id
      );

      // Update user's onboarding step to 1
      await userRepository.updateUserOnboardingStep(currentUser.id, 1);
      console.log("Onboarding Step 1 - Onboarding step updated to 1");

      // Include calculated age in response for backwards compatibility
      const age = studentService.calculateAge(student.birthDate);

      res.json({
        success: true,
        message: "AAC user profile created successfully",
        student: {
          ...student,
          age, // Calculated from birthDate for backwards compatibility
        },
        link,
        onboardingStep: 1,
      });
    } catch (error: any) {
      console.error("Error completing step 1:", {
        message: error.message,
        code: error.code,
        detail: error.detail,
        constraint: error.constraint,
        stack: error.stack,
      });
      res.status(500).json({
        success: false,
        message: "Failed to create AAC user profile",
      });
    }
  }

  /**
   * POST /api/onboarding/complete-step-2
   * Complete Step 2: Create Schedule Entry
   */
  async completeStep2(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as { id: string };
      const scheduleData = req.body;

      // Validate schedule data
      const validatedData = insertStudentScheduleSchema.parse(scheduleData);

      // Verify the user has access to this AAC user
      const { hasAccess } = await studentService.verifyStudentAccess(
        validatedData.studentId,
        currentUser.id
      );

      if (!hasAccess) {
        res.status(403).json({
          success: false,
          message: "Access denied to this AAC user",
        });
        return;
      }

      // Create schedule entry
      const schedule = await studentService.createScheduleEntry(validatedData);

      // Update user's onboarding step to 3 (complete)
      await userRepository.updateUserOnboardingStep(currentUser.id, 3);

      res.json({
        success: true,
        message: "Schedule entry created successfully",
        schedule,
        onboardingStep: 3,
      });
    } catch (error: any) {
      console.error("Error completing step 2:", error);
      if (error.name === "ZodError") {
        res.status(400).json({
          success: false,
          message: "Invalid schedule data",
          errors: error.errors,
        });
        return;
      }
      res.status(500).json({
        success: false,
        message: "Failed to create schedule entry",
      });
    }
  }

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
        link: result.link,
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

  /**
   * POST /api/onboarding/skip
   * Skip onboarding (mark as complete without creating AAC user)
   */
  async skipOnboarding(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as { id: string };

      // Update user's onboarding step to 3 (complete)
      await userRepository.updateUserOnboardingStep(currentUser.id, 3);

      res.json({
        success: true,
        message: "Onboarding skipped",
        onboardingStep: 3,
      });
    } catch (error: any) {
      console.error("Error skipping onboarding:", error);
      res.status(500).json({
        success: false,
        message: "Failed to skip onboarding",
      });
    }
  }
}

export const onboardingController = new OnboardingController();