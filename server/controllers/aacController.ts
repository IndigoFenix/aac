/**
 * AAC Controller
 *
 * Handles HTTP requests for AAC (Augmentative and Alternative Communication) features.
 * Supports symbol generation, visual analysis, conversation, audio processing, and more.
 */

import type { Request, Response } from "express";
import { studentService } from "../services/studentService";
import { aacSessionService } from "../services/aac/aacSessionService";
import { generateContextualSymbols } from "../services/aac/contextualSymbols";
import { arasaacService, generateArasaacSymbols } from "../services/aac/arasaac";
import {
  startConversation,
  generateAgentResponse,
  generateChatResponse,
  getConversationHistory,
  generateMessageAudio,
  clearConversation,
} from "../services/aac/aacConversation";
import { analyzeVideoWithVertex, detectPersonWithVertex, detectSignLanguage } from "../services/aac/vertexai";
import { detectMainUserFromUserCamera, determineCameraType } from "../services/aac/userCameraDetection";
import { analyzePersonAndRole } from "../services/aac/personDetection";
import { signGemmaService, detectSignLanguageWithSignGemma } from "../services/aac/signgemma";
import { audioCaptureService } from "../services/aac/audioCapture";
import { analyzeMultipleCameras } from "../services/aac/multiCameraAnalysis";
import { choiceClassifier } from "../services/aac/choiceClassifier";
import { choiceAACGenerator } from "../services/aac/choiceAACGenerator";
import type { AACSessionContext } from "@shared/schema";

export class AACController {
  // ============================================================================
  // SESSION MANAGEMENT
  // ============================================================================

  /**
   * GET /api/aac/session/:studentId
   * Get or create an AAC session for a student
   */
  async getSession(req: Request, res: Response): Promise<void> {
    try {
      const { studentId } = req.params;
      const currentUser = req.user as any;

      // Verify the user has access to this student
      const hasAccess = await this.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({
          success: false,
          message: "You do not have access to this student",
        });
        return;
      }

      const session = await aacSessionService.getSession(studentId, currentUser.id);

      res.json({
        success: true,
        session,
      });
    } catch (error: any) {
      console.error("Error getting AAC session:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to get AAC session",
      });
    }
  }

  /**
   * POST /api/aac/session/:studentId/context
   * Update session context
   */
  async updateSessionContext(req: Request, res: Response): Promise<void> {
    try {
      const { studentId } = req.params;
      const currentUser = req.user as any;
      const contextUpdates = req.body as Partial<AACSessionContext>;

      const hasAccess = await this.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({
          success: false,
          message: "You do not have access to this student",
        });
        return;
      }

      await aacSessionService.updateContext(studentId, contextUpdates);

      res.json({
        success: true,
        message: "Session context updated",
      });
    } catch (error: any) {
      console.error("Error updating session context:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to update session context",
      });
    }
  }

  /**
   * POST /api/aac/session/:studentId/end
   * End an AAC session
   */
  async endSession(req: Request, res: Response): Promise<void> {
    try {
      const { studentId } = req.params;
      const currentUser = req.user as any;

      const hasAccess = await this.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({
          success: false,
          message: "You do not have access to this student",
        });
        return;
      }

      const session = await aacSessionService.endSession(studentId);

      res.json({
        success: true,
        message: "Session ended",
        session,
      });
    } catch (error: any) {
      console.error("Error ending AAC session:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to end AAC session",
      });
    }
  }

  // ============================================================================
  // SYMBOL GENERATION
  // ============================================================================

  /**
   * POST /api/aac/symbols/contextual
   * Generate contextual symbol suggestions based on conversation and environment
   */
  async getContextualSymbols(req: Request, res: Response): Promise<void> {
    try {
      const { studentId, context, language = "en" } = req.body;
      const currentUser = req.user as any;

      if (!studentId) {
        res.status(400).json({
          success: false,
          message: "Student ID is required",
        });
        return;
      }

      const hasAccess = await this.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({
          success: false,
          message: "You do not have access to this student",
        });
        return;
      }

      // Get student settings
      const student = await studentService.getStudentById(studentId);
      const usePcsSymbols = student?.aacUsePcsSymbols || false;

      // Get recent conversation for context
      const recentMessages = await aacSessionService.getRecentMessages(studentId, 3);
      const conversationContext = recentMessages.length > 0
        ? {
            lastAgentMessage: recentMessages[recentMessages.length - 1]?.content,
            conversationTopic: undefined,
            studentId,
          }
        : undefined;

      // Try ARASAAC first for authentic AAC pictograms
      try {
        const arasaacSymbols = await generateArasaacSymbols(context, context?.visualContext, language);
        res.json({
          success: true,
          suggestions: arasaacSymbols,
          source: "arasaac",
        });
        return;
      } catch (arasaacError) {
        console.log("ARASAAC failed, falling back to contextual system:", arasaacError);
      }

      // Fallback to contextual symbol generation
      const suggestions = await generateContextualSymbols(
        context,
        conversationContext,
        language,
        usePcsSymbols
      );

      res.json({
        success: true,
        suggestions,
        source: "contextual",
      });
    } catch (error: any) {
      console.error("Error generating contextual symbols:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to generate contextual symbols",
      });
    }
  }

  /**
   * GET /api/aac/arasaac/search/:language/:searchText
   * Search ARASAAC symbols
   */
  async searchArasaacSymbols(req: Request, res: Response): Promise<void> {
    try {
      const { language, searchText } = req.params;

      const searchResults = await arasaacService.getBestSearch(searchText, language);
      const symbols = searchResults.map((result) => ({
        id: result._id,
        label: searchText,
        imageUrl: arasaacService.getPictogramUrl(result._id, { color: true, width: 300, height: 300 }),
        keywords: result.keywords,
      }));

      res.json({
        success: true,
        symbols,
        count: symbols.length,
      });
    } catch (error: any) {
      console.error("ARASAAC search error:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to search ARASAAC symbols",
      });
    }
  }

  /**
   * GET /api/aac/arasaac/keywords/:language
   * Get ARASAAC keywords for autocompletion
   */
  async getArasaacKeywords(req: Request, res: Response): Promise<void> {
    try {
      const { language } = req.params;
      const keywords = await arasaacService.getKeywords(language);

      res.json({
        success: true,
        keywords: keywords.slice(0, 100),
      });
    } catch (error: any) {
      console.error("ARASAAC keywords error:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch ARASAAC keywords",
      });
    }
  }

  /**
   * POST /api/aac/choice/classify
   * Classify audio transcript for choice questions
   */
  async classifyChoice(req: Request, res: Response): Promise<void> {
    try {
      const { transcript, language = "en" } = req.body;

      if (!transcript) {
        res.status(400).json({
          success: false,
          message: "Transcript is required",
        });
        return;
      }

      const classification = await choiceClassifier.classifyChoice(transcript, language);

      res.json({
        success: true,
        classification,
      });
    } catch (error: any) {
      console.error("Choice classification error:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to classify choice",
      });
    }
  }

  /**
   * POST /api/aac/choice/generate
   * Generate AAC options for a choice classification
   */
  async generateChoiceOptions(req: Request, res: Response): Promise<void> {
    try {
      const { classification, studentId, language = "en", context } = req.body;

      if (!classification || !studentId) {
        res.status(400).json({
          success: false,
          message: "Classification and studentId are required",
        });
        return;
      }

      const options = await choiceAACGenerator.generateAACOptions(
        classification,
        studentId,
        language,
        context
      );

      res.json({
        success: true,
        ...options,
      });
    } catch (error: any) {
      console.error("Choice option generation error:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to generate choice options",
      });
    }
  }

  // ============================================================================
  // VISUAL ANALYSIS
  // ============================================================================

  /**
   * POST /api/aac/analyze-image
   * Analyze image for visual context
   */
  async analyzeImage(req: Request & { file?: Express.Multer.File }, res: Response): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({
          success: false,
          message: "No image provided",
        });
        return;
      }

      const { studentId, cameraType, deviceLabel } = req.body;

      // Analyze with Vertex AI
      const analysis = await analyzeVideoWithVertex(req.file.buffer);

      // Update session context if studentId provided
      if (studentId) {
        try {
          await aacSessionService.updateContext(studentId, {
            visualContext: {
              sceneDescription: analysis,
              timestamp: new Date().toISOString(),
            },
          });
        } catch (sessionError) {
          console.log("Could not update session context:", sessionError);
        }
      }

      res.json({
        success: true,
        analysis,
        source: "Vertex AI",
        cameraType: cameraType || "unknown",
        deviceLabel: deviceLabel || "Unknown Device",
      });
    } catch (error: any) {
      console.error("Error analyzing image:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to analyze image",
      });
    }
  }

  /**
   * POST /api/aac/detect-person
   * Person detection with profile verification
   */
  async detectPerson(req: Request & { file?: Express.Multer.File }, res: Response): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({
          success: false,
          message: "No image provided",
        });
        return;
      }

      const { studentId, expectedAge, expectedGender, cameraType, deviceLabel } = req.body;

      // Determine camera type if not provided
      let actualCameraType = cameraType;
      if (!actualCameraType && deviceLabel) {
        actualCameraType = determineCameraType(deviceLabel);
      }

      // Detect person with camera-aware detection
      const detection = await detectMainUserFromUserCamera(
        req.file.buffer,
        expectedAge ? parseInt(expectedAge) : undefined,
        expectedGender,
        actualCameraType
      );

      // Update session context if studentId provided
      if (studentId) {
        try {
          await aacSessionService.updateContext(studentId, {
            personDetection: {
              personPresent: detection.personPresent,
              isMainUser: detection.isMainUser,
              age: detection.detectedAge || undefined,
              gender: detection.detectedGender,
              facialExpression: detection.facialExpression,
              emotionalState: detection.emotionalState,
              confidence: detection.confidence,
            },
          });
        } catch (sessionError) {
          console.log("Could not update session context:", sessionError);
        }
      }

      res.json({
        success: true,
        ...detection,
      });
    } catch (error: any) {
      console.error("Error detecting person:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to detect person",
      });
    }
  }

  /**
   * POST /api/aac/analyze-person-role
   * Analyze person and their role relative to the AAC user
   */
  async analyzePersonRole(req: Request & { file?: Express.Multer.File }, res: Response): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({
          success: false,
          message: "No image provided",
        });
        return;
      }

      const { studentId } = req.body;
      if (!studentId) {
        res.status(400).json({
          success: false,
          message: "Student ID is required",
        });
        return;
      }

      const base64Image = req.file.buffer.toString("base64");
      const analysis = await analyzePersonAndRole(base64Image, studentId);

      res.json({
        success: true,
        ...analysis,
      });
    } catch (error: any) {
      console.error("Error analyzing person role:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to analyze person role",
      });
    }
  }

  /**
   * POST /api/aac/detect-sign-language
   * Detect sign language in image
   */
  async detectSignLanguage(req: Request & { file?: Express.Multer.File }, res: Response): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({
          success: false,
          message: "No image provided",
        });
        return;
      }

      const { studentId } = req.body;

      // Check if student has sign language reading enabled
      if (studentId) {
        const student = await studentService.getStudentById(studentId);
        if (!student?.aacSignLanguageReading) {
          res.status(400).json({
            success: false,
            message: "Sign language reading not enabled for this student",
          });
          return;
        }
      }

      // Try SignGemma first
      if (signGemmaService.isAvailable()) {
        try {
          const detection = await detectSignLanguageWithSignGemma(req.file.buffer);
          res.json({
            success: true,
            ...detection,
            model: "SignGemma",
          });
          return;
        } catch (signGemmaError) {
          console.log("SignGemma failed, trying Vertex AI:", signGemmaError);
        }
      }

      // Fallback to Vertex AI
      const detection = await detectSignLanguage(req.file.buffer);
      res.json({
        success: true,
        ...detection,
        model: "Vertex AI",
      });
    } catch (error: any) {
      console.error("Error detecting sign language:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to detect sign language",
      });
    }
  }

  /**
   * POST /api/aac/multi-camera/analyze
   * Analyze multiple camera frames
   */
  async analyzeMultipleCameras(req: Request, res: Response): Promise<void> {
    try {
      const files = req.files as Express.Multer.File[];

      if (!files || files.length === 0) {
        res.status(400).json({
          success: false,
          message: "No camera frames provided",
        });
        return;
      }

      const { studentId, metadata } = req.body;
      const frameMetadata = metadata ? JSON.parse(metadata) : [];

      // Combine file data with metadata
      const frames = files.map((file, index) => {
        const meta = frameMetadata[index] || {};
        return {
          deviceId: meta.deviceId || `unknown-${index}`,
          label: meta.label || `Camera ${index}`,
          facing: meta.facing || "unknown",
          imageData: file.buffer,
        };
      });

      const analysis = await analyzeMultipleCameras(frames);

      // Update session context if studentId provided
      if (studentId) {
        try {
          await aacSessionService.updateContext(studentId, {
            visualContext: {
              sceneDescription: analysis.combinedAnalysis.contextualSummary,
              timestamp: analysis.timestamp.toISOString(),
            },
          });
        } catch (sessionError) {
          console.log("Could not update session context:", sessionError);
        }
      }

      res.json({
        success: true,
        analysis: analysis.combinedAnalysis,
        userCamera: analysis.userCamera,
        environmentCamera: analysis.environmentCamera,
        framesAnalyzed: frames.length,
        timestamp: analysis.timestamp,
      });
    } catch (error: any) {
      console.error("Multi-camera analysis error:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Multi-camera analysis failed",
      });
    }
  }

  // ============================================================================
  // CONVERSATION
  // ============================================================================

  /**
   * POST /api/aac/conversation/start
   * Start a new conversation
   */
  async startConversation(req: Request, res: Response): Promise<void> {
    try {
      const { studentId, userProfile, visualContext, language = "en", emotionalContext, audioContext } = req.body;
      const currentUser = req.user as any;

      if (!studentId) {
        res.status(400).json({
          success: false,
          message: "Student ID is required",
        });
        return;
      }

      const hasAccess = await this.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({
          success: false,
          message: "You do not have access to this student",
        });
        return;
      }

      // Ensure session exists
      await aacSessionService.getSession(studentId, currentUser.id);

      // Get session context for enhanced visual context
      const sessionContext = await aacSessionService.getContext(studentId);
      const enhancedVisualContext =
        sessionContext?.visualContext?.sceneDescription || visualContext || "Basic indoor environment";

      const message = await startConversation(
        studentId,
        userProfile,
        enhancedVisualContext,
        language,
        emotionalContext,
        audioContext
      );

      res.json({
        success: true,
        message,
      });
    } catch (error: any) {
      console.error("Error starting conversation:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to start conversation",
      });
    }
  }

  /**
   * POST /api/aac/conversation/respond
   * Generate agent response to user symbols
   */
  async generateResponse(req: Request, res: Response): Promise<void> {
    try {
      const { studentId, symbols, context, language = "en" } = req.body;
      const currentUser = req.user as any;

      if (!studentId || !symbols) {
        res.status(400).json({
          success: false,
          message: "Student ID and symbols are required",
        });
        return;
      }

      const hasAccess = await this.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({
          success: false,
          message: "You do not have access to this student",
        });
        return;
      }

      // Get session context for enhanced context
      const sessionContext = await aacSessionService.getContext(studentId);
      const enhancedContext = {
        ...context,
        visualContext: sessionContext?.visualContext?.sceneDescription || context?.visualContext,
        emotionalContext: sessionContext?.personDetection?.emotionalState
          ? `The user appears ${sessionContext.personDetection.facialExpression} and ${sessionContext.personDetection.emotionalState}`
          : context?.emotionalContext,
        audioContext: sessionContext?.audioContext,
      };

      const message = await generateAgentResponse(studentId, symbols, enhancedContext, language);

      // Track credits
      await aacSessionService.addCredits(studentId, 0.01, currentUser.id); // Estimate for conversation

      res.json({
        success: true,
        message,
      });
    } catch (error: any) {
      console.error("Error generating response:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to generate response",
      });
    }
  }

  /**
   * POST /api/aac/chat
   * Simplified chat endpoint - send symbols and optional image, get AI response
   * The AI can see the camera frame directly in its context
   */
  async chat(req: Request, res: Response): Promise<void> {
    try {
      const { studentId, symbols, language = "en" } = req.body;
      const currentUser = req.user as any;
      const imageFile = req.file; // Optional image from multer

      if (!studentId || !symbols) {
        res.status(400).json({
          success: false,
          message: "Student ID and symbols are required",
        });
        return;
      }

      // Parse symbols if it's a string
      const symbolArray = typeof symbols === 'string' ? JSON.parse(symbols) : symbols;

      const hasAccess = await this.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({
          success: false,
          message: "You do not have access to this student",
        });
        return;
      }

      // Get image buffer if provided
      const imageBuffer = imageFile?.buffer;

      console.log(`AAC Chat: studentId=${studentId}, symbols=${symbolArray.length}, hasImage=${!!imageBuffer}`);

      // Generate response with optional image
      const message = await generateChatResponse(studentId, symbolArray, imageBuffer, language);

      // Track credits
      await aacSessionService.addCredits(studentId, imageBuffer ? 0.02 : 0.01, currentUser.id);

      res.json({
        success: true,
        message,
      });
    } catch (error: any) {
      console.error("Error in AAC chat:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to process chat",
      });
    }
  }

  /**
   * GET /api/aac/conversation/history/:studentId
   * Get conversation history
   */
  async getHistory(req: Request, res: Response): Promise<void> {
    try {
      const { studentId } = req.params;
      const currentUser = req.user as any;

      const hasAccess = await this.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({
          success: false,
          message: "You do not have access to this student",
        });
        return;
      }

      const history = await getConversationHistory(studentId);

      res.json({
        success: true,
        history,
      });
    } catch (error: any) {
      console.error("Error getting conversation history:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to get conversation history",
      });
    }
  }

  /**
   * POST /api/aac/conversation/audio
   * Generate audio for a message
   */
  async generateAudio(req: Request, res: Response): Promise<void> {
    try {
      const { messageId, text, language = "en", studentId, isUserMessage = false, userProfile } = req.body;

      if (!messageId || !text) {
        res.status(400).json({
          success: false,
          message: "Message ID and text are required",
        });
        return;
      }

      // Get student profile for voice matching
      let profile = userProfile;
      if (!profile && studentId) {
        const student = await studentService.getStudentById(studentId);
        if (student) {
          // Calculate age from birthDate if available
          let age: number | undefined;
          if (student.birthDate) {
            const birthDate = new Date(student.birthDate);
            const today = new Date();
            age = today.getFullYear() - birthDate.getFullYear();
            const monthDiff = today.getMonth() - birthDate.getMonth();
            if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
              age--;
            }
          }
          profile = {
            age,
            gender: student.gender || undefined,
          };
        }
      }

      const audioBuffer = await generateMessageAudio(messageId, text, language, profile, isUserMessage);

      res.set({
        "Content-Type": "audio/mpeg",
        "Content-Length": audioBuffer.length.toString(),
      });
      res.send(audioBuffer);
    } catch (error: any) {
      console.error("Error generating audio:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to generate audio",
      });
    }
  }

  /**
   * DELETE /api/aac/conversation/:studentId
   * Clear conversation
   */
  async clearConversation(req: Request, res: Response): Promise<void> {
    try {
      const { studentId } = req.params;
      const currentUser = req.user as any;

      const hasAccess = await this.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({
          success: false,
          message: "You do not have access to this student",
        });
        return;
      }

      await clearConversation(studentId);

      res.json({
        success: true,
        message: "Conversation cleared",
      });
    } catch (error: any) {
      console.error("Error clearing conversation:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to clear conversation",
      });
    }
  }

  // ============================================================================
  // AUDIO PROCESSING
  // ============================================================================

  /**
   * POST /api/aac/audio/process
   * Process audio file for transcription and analysis
   */
  async processAudio(req: Request & { file?: Express.Multer.File }, res: Response): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({
          success: false,
          message: "No audio file provided",
        });
        return;
      }

      const { studentId } = req.body;

      const audioContext = await audioCaptureService.processAudioBuffer(
        req.file.buffer,
        req.file.originalname || "audio.wav"
      );

      // Update session context if studentId provided
      if (studentId) {
        try {
          await aacSessionService.updateContext(studentId, {
            audioContext: {
              transcript: audioContext.transcript,
              ambientSounds: audioContext.ambientSounds,
              speechPresent: audioContext.speechPresent,
            },
          });
        } catch (sessionError) {
          console.log("Could not update session context:", sessionError);
        }
      }

      res.json({
        success: true,
        transcript: audioContext.transcript,
        detectedLanguage: audioContext.detectedLanguage,
        confidence: audioContext.confidence,
        ambientSounds: audioContext.ambientSounds,
        speechPresent: audioContext.speechPresent,
        timestamp: audioContext.timestamp,
      });
    } catch (error: any) {
      console.error("Audio processing error:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to process audio",
      });
    }
  }

  /**
   * GET /api/aac/audio/context/:studentId
   * Get audio context from session
   */
  async getAudioContext(req: Request, res: Response): Promise<void> {
    try {
      const { studentId } = req.params;
      const currentUser = req.user as any;

      const hasAccess = await this.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({
          success: false,
          message: "You do not have access to this student",
        });
        return;
      }

      const context = await aacSessionService.getContext(studentId);
      const audioContext = context?.audioContext;

      if (!audioContext) {
        res.json({
          success: true,
          hasAudioContext: false,
          message: "No audio context available",
        });
        return;
      }

      res.json({
        success: true,
        hasAudioContext: true,
        audioContext,
      });
    } catch (error: any) {
      console.error("Error getting audio context:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to get audio context",
      });
    }
  }

  // ============================================================================
  // CONTEXT & MISC ENDPOINTS
  // ============================================================================

  /**
   * GET /api/aac/context
   * Get current environmental context (time, date)
   */
  async getContext(req: Request, res: Response): Promise<void> {
    try {
      const now = new Date();
      const time = now.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });

      res.json({
        time,
        date: now.toDateString(),
        timestamp: now.toISOString(),
      });
    } catch (error: any) {
      console.error("Error getting context:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to get context",
      });
    }
  }

  /**
   * POST /api/aac/symbols/suggestions
   * Get non-contextual symbol suggestions
   */
  async getSymbolSuggestions(req: Request, res: Response): Promise<void> {
    try {
      const { context, language = "en" } = req.body;

      // Use ARASAAC for authentic AAC pictograms
      try {
        console.log("Using ARASAAC for symbol suggestions");
        const arasaacSymbols = await generateArasaacSymbols(context, undefined, language);
        res.json({ suggestions: arasaacSymbols });
      } catch (arasaacError) {
        console.log("ARASAAC failed, using fallback:", arasaacError);
        // Return basic fallback symbols
        const fallbackSymbols = [
          { id: "yes", label: language === "he" ? "כן" : "Yes", emoji: "✅", confidence: 0.9, reasoning: "Basic response" },
          { id: "no", label: language === "he" ? "לא" : "No", emoji: "❌", confidence: 0.9, reasoning: "Basic response" },
          { id: "help", label: language === "he" ? "עזרה" : "Help", emoji: "🆘", confidence: 0.8, reasoning: "Support symbol" },
          { id: "more", label: language === "he" ? "עוד" : "More", emoji: "➕", confidence: 0.8, reasoning: "Request symbol" },
          { id: "want", label: language === "he" ? "רוצה" : "Want", emoji: "👋", confidence: 0.8, reasoning: "Desire expression" },
          { id: "happy", label: language === "he" ? "שמח" : "Happy", emoji: "😊", confidence: 0.7, reasoning: "Emotion" },
          { id: "sad", label: language === "he" ? "עצוב" : "Sad", emoji: "😢", confidence: 0.7, reasoning: "Emotion" },
          { id: "play", label: language === "he" ? "לשחק" : "Play", emoji: "🎮", confidence: 0.7, reasoning: "Activity" },
        ];
        res.json({ suggestions: fallbackSymbols });
      }
    } catch (error: any) {
      console.error("Error generating symbol suggestions:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to generate suggestions",
      });
    }
  }

  /**
   * POST /api/aac/interpret
   * Interpret a symbol sequence into natural language
   */
  async interpretSymbols(req: Request, res: Response): Promise<void> {
    try {
      const { symbols, context } = req.body;

      if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
        res.status(400).json({
          success: false,
          message: "Symbols array is required",
        });
        return;
      }

      // Use Gemini to interpret the symbol sequence
      const { GoogleGenAI } = await import("@google/genai");
      const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

      const prompt = `You are helping interpret a sequence of AAC symbols into natural speech.

Symbol sequence: ${symbols.join(" → ")}
Context: Time: ${context?.time || "unknown"}, Visual: ${context?.visualContext || "None"}

Convert this symbol sequence into natural, conversational speech that represents the user's likely intent. Consider:
- The user's communication level
- The current context and situation
- Natural flow and grammar
- Emotional tone if applicable

Respond with just the interpreted speech, no extra formatting.`;

      const response = await genAI.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
      });

      const interpretation = response.text || symbols.join(" ");

      res.json({
        success: true,
        interpretation,
      });
    } catch (error: any) {
      console.error("Error interpreting symbols:", error);
      // Fallback to simple concatenation
      const { symbols } = req.body;
      res.json({
        success: true,
        interpretation: Array.isArray(symbols) ? symbols.join(" ") : String(symbols),
      });
    }
  }

  /**
   * POST /api/aac/detect-objects-in-hands
   * Detect objects being held in hands
   */
  async detectObjectsInHands(req: Request & { file?: Express.Multer.File }, res: Response): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({
          success: false,
          message: "No image provided",
        });
        return;
      }

      console.log("Two-handed object detection request received");
      const imageBuffer = req.file.buffer;
      const base64Image = imageBuffer.toString("base64");

      // Use Gemini to analyze the image for hand-held objects
      const { GoogleGenAI } = await import("@google/genai");
      const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

      const prompt = `Analyze this image and detect objects being held in a person's hands.

Look for:
- Objects clearly being held or grasped in left hand
- Objects clearly being held or grasped in right hand
- Common objects like: cup, phone, book, pen, toy, remote, keys, etc.

For cards or letters, identify what's ON them (the number, letter, character) rather than just "card" or "letter".

Respond with JSON only:
{
  "leftHand": { "object": "object name or null", "emoji": "relevant emoji", "confidence": 0.0-1.0 },
  "rightHand": { "object": "object name or null", "emoji": "relevant emoji", "confidence": 0.0-1.0 },
  "handsVisible": boolean,
  "description": "brief description of what's detected"
}`;

      const response = await genAI.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          {
            inlineData: {
              data: base64Image,
              mimeType: "image/jpeg",
            },
          },
          prompt,
        ],
      });

      let responseText = response.text || "{}";
      // Clean up response
      responseText = responseText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

      const result = JSON.parse(responseText);

      res.json({
        success: true,
        ...result,
      });
    } catch (error: any) {
      console.error("Error detecting objects in hands:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to detect objects in hands",
      });
    }
  }

  /**
   * GET /api/aac/multi-camera/current-analysis
   * Get the current multi-camera analysis from session
   */
  async getCurrentMultiCameraAnalysis(req: Request, res: Response): Promise<void> {
    try {
      const studentId = req.query.studentId as string;

      if (!studentId) {
        res.json({
          success: true,
          available: false,
          message: "No student ID provided",
        });
        return;
      }

      const context = await aacSessionService.getContext(studentId);

      if (!context || !context.cameraVisualContexts) {
        res.json({
          success: true,
          available: false,
          message: "No multi-camera analysis available",
        });
        return;
      }

      res.json({
        success: true,
        available: true,
        analysis: context.cameraVisualContexts,
        personDetection: context.personDetection,
        emotionalContext: context.emotionalContext,
      });
    } catch (error: any) {
      console.error("Error getting current multi-camera analysis:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to get multi-camera analysis",
      });
    }
  }

  // ============================================================================
  // HELPER METHODS
  // ============================================================================

  /**
   * Verify that a user has access to a student
   */
  private async verifyStudentAccess(studentId: string, userId: string): Promise<boolean> {
    try {
      // Check if user is linked to this student
      const userStudents = await studentService.getStudentsByUserId(userId);
      return userStudents.some((s) => s.id === studentId);
    } catch (error) {
      console.error("Error verifying student access:", error);
      return false;
    }
  }
}

export const aacController = new AACController();
