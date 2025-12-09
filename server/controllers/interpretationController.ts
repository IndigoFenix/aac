import type { Request, Response } from "express";
import { interpretationRepository, studentRepository, userRepository } from "../repositories";
import { creditService } from "../services";
import { interpretRequestSchema } from "@shared/schema";
import { interpretAACText, interpretAACImage } from "../services/interpretationService";

export class InterpretationController {
  /**
   * POST /api/interpret
   * Main interpretation endpoint for AAC communication
   */
  async interpret(
    req: Request & { file?: Express.Multer.File },
    res: Response
  ): Promise<void> {
    try {
      const currentUser = req.user as any;

      // Check credits if user is logged in
      if (currentUser) {
        const { hasCredits, credits } = await creditService.validateCredits(currentUser.id);
        if (!hasCredits) {
          res.status(402).json({
            success: false,
            message: `You have ${credits} credits remaining. Please upgrade your plan to continue using the service.`,
            errorType: "insufficient_credits",
          });
          return;
        }
      }

      let requestData;
      let imageBase64 = null;

      if (req.file) {
        // Handle image upload
        imageBase64 = req.file.buffer.toString("base64");
        requestData = {
          input: req.body.input || "Image uploaded",
          inputType: "image",
          imageData: imageBase64,
        };
      } else {
        // Handle text input
        requestData = {
          input: req.body.input,
          inputType: "text",
        };
      }

      const validatedData = interpretRequestSchema.parse(requestData);
      const language = (req.body.language as "en" | "he") || "he";
      const context = req.body.context || null;
      const studentId = req.body.studentId || null;
      const studentName = req.body.studentName || null;

      let interpretationResult;
      let finalInput = validatedData.input;

      // Add context to input if provided
      if (context && validatedData.inputType === "text") {
        const contextHeader =
          language === "he"
            ? "\n\nהקשר נוסף:\n\n"
            : "\n\nAdditional context:\n";
        finalInput = validatedData.input + contextHeader + context;
      }

      // Get AAC user info if studentId is provided
      let studentInfo = null;
      let scheduleContext = "";
      if (studentId) {
        studentInfo = await studentRepository.getStudentById(studentId);

        // Fetch current schedule context for time-based context enrichment
        const scheduleData = await studentRepository.getCurrentScheduleContext(
          studentId,
          new Date()
        );
        if (scheduleData.activityName) {
          const topicTags =
            scheduleData.topicTags && scheduleData.topicTags.length > 0
              ? ` (Topics: ${scheduleData.topicTags.join(", ")})`
              : "";
          scheduleContext =
            language === "he"
              ? `\n\nפעילות נוכחית: ${scheduleData.activityName}${topicTags}`
              : `\n\nCurrent activity: ${scheduleData.activityName}${topicTags}`;
        }
      }

      // Combine manual context with schedule context
      const enrichedContext = context
        ? `${context}${scheduleContext}`
        : scheduleContext || undefined;

      if (validatedData.inputType === "image" && validatedData.imageData) {
        interpretationResult = await interpretAACImage(
          validatedData.imageData,
          language,
          enrichedContext,
          studentInfo,
          currentUser?.id,
          req.sessionID
        );
      } else {
        interpretationResult = await interpretAACText(
          finalInput,
          language,
          enrichedContext,
          studentInfo,
          currentUser?.id,
          req.sessionID
        );
      }

      // For images, use extracted text as the original input for display
      const displayInput =
        interpretationResult.extractedText || validatedData.input;

      // Save interpretation to storage
      const savedInterpretation = await interpretationRepository.createInterpretation({
        userId: currentUser?.id || null,
        originalInput: displayInput,
        interpretedMeaning: interpretationResult.interpretedMeaning,
        analysis: interpretationResult.analysis,
        confidence: interpretationResult.confidence,
        suggestedResponse: interpretationResult.suggestedResponse,
        inputType: validatedData.inputType,
        language,
        context,
        imageData: imageBase64,
        studentId,
        studentName,
      });

      // Deduct credit if user is logged in
      if (currentUser) {
        const creditDeducted = await creditService.deductCredit(
          currentUser.id,
          "AAC Interpretation"
        );
        if (!creditDeducted) {
          console.warn(`Failed to deduct credit for user ${currentUser.id}`);
        }
      }

      // Get updated user credits
      const updatedCredits = currentUser
        ? (await userRepository.getUser(currentUser.id))?.credits
        : null;

      res.json({
        success: true,
        interpretation: savedInterpretation,
        userCredits: updatedCredits,
        ...interpretationResult,
      });
    } catch (error: any) {
      console.error("Interpretation error:", error);

      // Handle model overloaded error with user-friendly message
      if (error instanceof Error && error.message === "MODEL_OVERLOADED") {
        res.status(503).json({
          success: false,
          message: "MODEL_OVERLOADED",
        });
        return;
      }

      res.status(500).json({
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Failed to interpret communication",
      });
    }
  }

  /**
   * GET /api/interpretations
   * Get interpretation history for current user
   */
  async getInterpretations(req: Request, res: Response): Promise<void> {
    console.log("Fetching interpretation history for user:", req.user);
    try {
      const currentUser = req.user as { id: string };
      const limit = req.query.limit
        ? parseInt(req.query.limit as string)
        : undefined;
      const interpretations = await interpretationRepository.getInterpretationsByUser(
        currentUser.id,
        limit
      );
      res.json({ success: true, interpretations });
    } catch (error: any) {
      console.error("History fetch error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch interpretation history",
      });
    }
  }

  /**
   * GET /api/interpretations/:id
   * Get specific interpretation
   */
  async getInterpretation(req: Request, res: Response): Promise<void> {
    try {
      const id = req.params.id;
      const interpretation = await interpretationRepository.getInterpretation(id);

      if (!interpretation) {
        res.status(404).json({
          success: false,
          message: "Interpretation not found",
        });
        return;
      }

      res.json({ success: true, interpretation });
    } catch (error: any) {
      console.error("Interpretation fetch error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch interpretation",
      });
    }
  }

  /**
   * DELETE /api/interpretations/:id
   * Delete interpretation (owner or admin only)
   */
  async deleteInterpretation(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as { id: string; isAdmin?: boolean };
      const id = req.params.id;

      // First verify the interpretation exists and get ownership info
      const interpretation = await interpretationRepository.getInterpretation(id);
      if (!interpretation) {
        res.status(404).json({
          success: false,
          message: "Interpretation not found",
        });
        return;
      }

      // Check ownership - only owner or admin can delete
      if (interpretation.userId !== currentUser.id && !currentUser.isAdmin) {
        res.status(403).json({
          success: false,
          message: "Access denied - not authorized to delete this interpretation",
        });
        return;
      }

      const success = await interpretationRepository.deleteInterpretation(id);

      if (!success) {
        res.status(500).json({
          success: false,
          message: "Failed to delete interpretation",
        });
        return;
      }

      res.json({
        success: true,
        message: "Interpretation deleted successfully",
      });
    } catch (error: any) {
      console.error("Interpretation deletion error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to delete interpretation",
      });
    }
  }

  /**
   * POST /api/historical-suggestions
   * Get historical suggestions for AAC user based on patterns
   */
  async getHistoricalSuggestions(req: Request, res: Response): Promise<void> {
    try {
      const { studentId, currentInput } = req.body;

      if (!studentId || !currentInput) {
        res.status(400).json({
          success: false,
          message: "AAC user ID and current input are required",
        });
        return;
      }

      // Verify the AAC user belongs to the current user or is shared with them
      const student = await studentRepository.getStudentByStudentId(studentId);
      if (!student) {
        res.status(404).json({
          success: false,
          message: "AAC user not found",
        });
        return;
      }

      const currentUser = req.user as any;

      // Check if user owns this AAC user
      const userStudents = await studentRepository.getStudentsByUserId(currentUser.id);
      const hasAccess = userStudents.some((u) => u.id === studentId);

      if (!hasAccess) {
        res.status(403).json({
          success: false,
          message: "Access denied - you don't have access to this AAC user",
        });
        return;
      }

      // Get historical suggestions
      const historicalAnalysis = await interpretationRepository.analyzeHistoricalPatterns(
        studentId,
        currentInput
      );

      res.json({
        success: true,
        suggestions: historicalAnalysis.suggestions,
        totalPatterns: historicalAnalysis.totalPatterns,
        studentName: student.name,
      });
    } catch (error: any) {
      console.error("Historical suggestions error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to analyze historical patterns",
      });
    }
  }
}

export const interpretationController = new InterpretationController();
