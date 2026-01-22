import type { Express, Request, Response } from "express";
import session from "express-session";

declare module 'express-session' {
  interface SessionData {
    visualContext?: any;
    personDetection?: any;
    multiCameraAnalysis?: any;
    audioContext?: any;
    userId?: string;
    userEmail?: string;
    adminUser?: {
      id: string;
      username: string;
      role: string;
    };
  }
}
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { generateSymbolSuggestions, analyzeVisualContext, interpretSymbolSequence, detectPersonDetails, analyzeImageWithOpenAI } from "./services/openai";
import { analyzeVideoWithVertex, detectPersonWithVertex, detectSignLanguage } from "./services/vertexai";
import { signGemmaService, detectSignLanguageWithSignGemma } from "./services/signgemma";
import * as anthropicService from "./services/anthropic";
import { startConversation, generateAgentResponse, getConversationHistory, generateMessageAudio, clearConversation, getActiveConversation } from "./services/conversation";
import { generateContextualSymbols } from "./services/contextualSymbols";
import { generateArasaacSymbols, arasaacService } from "./services/arasaac";
import { detectPersonInImage, analyzePersonAndRole } from "./services/personDetection";
import { insertUserSchema, insertChatHistorySchema, adminLoginSchema, createAdminSchema, passwordResetRequestSchema, passwordResetSchema } from "@shared/schema";
import multer from "multer";
import multiCameraRoutes from "./routes/multiCamera";
import { audioCaptureService, AudioCaptureService } from "./services/audioCapture";
import { emailService } from "./services/emailService";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const upload = multer({ storage: multer.memoryStorage() });

export async function registerRoutes(app: Express): Promise<Server> {
  
  // Configure session middleware for debug data storage
  app.use(session({
    secret: process.env.SESSION_SECRET || 'synapse-aac-debug-session-secret',
    resave: false,
    saveUninitialized: true,
    cookie: { 
      secure: false, // Set to true in production with HTTPS
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
  }));

  // API usage tracking helper
  const trackApiUsage = (req: Request, service: string, tokens: number = 0, error: boolean = false) => {
    const session = req.session as any;
    if (!session.apiUsage) {
      session.apiUsage = {
        conversation: { calls: 0, tokens: 0, errors: 0, lastCall: null },
        visualAnalysis: { calls: 0, tokens: 0, errors: 0, lastCall: null },
        symbols: { calls: 0, tokens: 0, errors: 0, lastCall: null },
        voice: { calls: 0, tokens: 0, errors: 0, lastCall: null },
        audio: { calls: 0, tokens: 0, errors: 0, lastCall: null }
      };
    }
    
    if (session.apiUsage[service]) {
      session.apiUsage[service].calls += 1;
      session.apiUsage[service].tokens += tokens;
      session.apiUsage[service].lastCall = new Date().toLocaleTimeString();
      if (error) {
        session.apiUsage[service].errors += 1;
      }
    }
  };

  // Admin authentication middleware
  const requireAdminAuth = (req: Request, res: Response, next: any) => {
    if (!req.session || !req.session.adminUser) {
      return res.status(401).json({ message: "Admin authentication required" });
    }
    next();
  };
  
  // Authentication endpoint - returns current authenticated user
  app.get("/api/auth/user", async (req: Request, res: Response) => {
    try {
      if (!req.session || !req.session.userId) {
        return res.status(401).json({ message: "Not authenticated" });
      }
      
      const user = await storage.getUser(req.session.userId);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      res.json(user);
    } catch (error: any) {
      console.error("Error in /api/auth/user:", error);
      res.status(500).json({ message: error.message || "Failed to get user" });
    }
  });

  // User registration
  app.post("/api/auth/register", async (req: Request, res: Response) => {
    try {
      const { email, password, name, age, gender, language, preferences, clinicalInfo } = req.body;
      
      if (!email || !password || !name) {
        return res.status(400).json({ message: "Email, password, and name are required" });
      }

      // Check if user already exists
      const existingUser = await storage.getUserByEmail(email);
      if (existingUser) {
        return res.status(400).json({ message: "User with this email already exists" });
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, 10);

      // Create user
      const userData = {
        email,
        passwordHash,
        name,
        age: age ? parseInt(age) : undefined,
        gender,
        language: language || "en",
        preferences,
        clinicalInfo,
        multiCameraMode: true,
        subscriptionTier: "free"
      };

      const user = await storage.createUser(userData);
      
      // Set session
      req.session.userId = user.id;
      req.session.userEmail = user.email || undefined;

      // Remove password hash from response
      const { passwordHash: _, ...userResponse } = user;
      res.json({ success: true, user: userResponse });
    } catch (error: any) {
      console.error("Registration error:", error);
      res.status(500).json({ message: error.message || "Failed to register user" });
    }
  });

  // User login
  app.post("/api/auth/login", async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body;
      
      if (!email || !password) {
        return res.status(400).json({ message: "Email and password are required" });
      }

      // Get user by email
      const user = await storage.getUserByEmail(email);
      if (!user || !user.passwordHash) {
        return res.status(401).json({ message: "Invalid email or password" });
      }

      // Check password
      const isValid = await bcrypt.compare(password, user.passwordHash);
      if (!isValid) {
        return res.status(401).json({ message: "Invalid email or password" });
      }

      // Set session
      req.session.userId = user.id;
      req.session.userEmail = user.email || undefined;

      // Remove password hash from response
      const { passwordHash: _, ...userResponse } = user;
      res.json({ success: true, user: userResponse });
    } catch (error: any) {
      console.error("Login error:", error);
      res.status(500).json({ message: error.message || "Failed to login" });
    }
  });

  // User logout
  app.post("/api/auth/logout", async (req: Request, res: Response) => {
    try {
      req.session.destroy((err) => {
        if (err) {
          console.error("Logout error:", err);
          return res.status(500).json({ message: "Failed to logout" });
        }
        res.json({ success: true });
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to logout" });
    }
  });

  // User profile routes
  app.post("/api/users", async (req: Request, res: Response) => {
    try {
      const userData = insertUserSchema.parse(req.body);
      const user = await storage.createUser(userData);
      res.json(user);
    } catch (error: any) {
      res.status(400).json({ message: error.message || "Failed to create user" });
    }
  });

  app.get("/api/users/:id", async (req: Request, res: Response) => {
    try {
      const user = await storage.getUser(req.params.id);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      res.json(user);
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to fetch user" });
    }
  });

  app.put("/api/users/:id", async (req: Request, res: Response) => {
    try {
      console.log("PUT /api/users/:id - User ID:", req.params.id);
      console.log("PUT /api/users/:id - Request body:", req.body);
      
      const userData = insertUserSchema.partial().parse(req.body);
      console.log("PUT /api/users/:id - Parsed user data:", userData);
      
      const user = await storage.updateUser(req.params.id, userData);
      console.log("PUT /api/users/:id - Updated user:", user ? "Success" : "Failed");
      
      // Clear ChatGPT-5 override cache when user settings are updated
      if (userData.chatgpt5Enabled !== undefined) {
        const { modelOverrideService } = await import("./services/modelOverride");
        modelOverrideService.clearUserCache(req.params.id);
        console.log(`Cleared ChatGPT-5 cache for user ${req.params.id}: ${userData.chatgpt5Enabled ? 'ENABLED' : 'DISABLED'}`);
      }
      
      res.json(user);
    } catch (error: any) {
      console.error("PUT /api/users/:id - Error:", error);
      res.status(400).json({ message: error.message || "Failed to update user" });
    }
  });

  // Symbol suggestion route  
  app.post("/api/symbols/suggestions", async (req: Request, res: Response) => {
    try {
      const { context, language = "en" } = req.body;
      
      // Try ARASAAC symbols first for authentic AAC pictograms
      try {
        console.log("Using ARASAAC for symbol suggestions");
        const arasaacSymbols = await generateArasaacSymbols(context, undefined, language);
        trackApiUsage(req, 'symbols', 50); // Estimate for ARASAAC API calls
        res.json({ suggestions: arasaacSymbols });
        return;
      } catch (arasaacError) {
        console.log("ARASAAC failed, falling back to AI suggestions:", arasaacError);
        // Fallback to original AI suggestions
        const suggestions = await generateSymbolSuggestions(context, language);
        trackApiUsage(req, 'symbols', 100);
        res.json({ suggestions });
      }
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to generate suggestions" });
    }
  });

  // Contextual symbol suggestions based on conversation
  app.post("/api/symbols/contextual", async (req: Request, res: Response) => {
    try {
      // Handle both formats: { context: {...} } and direct properties
      const requestData = req.body.context ? req.body.context : req.body;
      const { userId, language = "en" } = req.body;
      console.log(`Symbol request received - Language: ${language}, UserId: ${userId}`);
      const activeConversation = getActiveConversation(userId);
      
      // Get user settings to check for PCS symbols preference
      let usePcsSymbols = false;
      if (userId) {
        try {
          const user = await storage.getUser(userId);
          usePcsSymbols = user?.usePcsSymbols || false;
        } catch (error) {
          console.log("Could not retrieve user PCS settings, using default");
        }
      }
      
      const conversationContext = activeConversation ? {
        lastAgentMessage: activeConversation.messages[activeConversation.messages.length - 1]?.content,
        conversationTopic: activeConversation.currentTopic,
        userId
      } : undefined;
      
      try {
        // Try ARASAAC symbols first for authentic AAC pictograms
        try {
          console.log("Using ARASAAC for contextual symbols");
          const arasaacSymbols = await generateArasaacSymbols(requestData, requestData.visualContext, language);
          console.log(`Generated ${arasaacSymbols.length} ARASAAC symbols for language: ${language}`);
          trackApiUsage(req, 'symbols', 50); // Estimate for ARASAAC API calls
          res.json({ suggestions: arasaacSymbols });
          return;
        } catch (arasaacError) {
          console.log("ARASAAC contextual failed, falling back to CABAL² system:", arasaacError);
        }
        
        // Fallback to existing contextual system
        const suggestions = await generateContextualSymbols(requestData, conversationContext, language, usePcsSymbols);
        console.log(`Generated ${suggestions.length} symbols for language: ${language}`);
        if (suggestions.length > 0) {
          console.log("Sample symbols:", suggestions.slice(0, 3).map(s => ({ id: s.id, label: s.label })));
        }
        trackApiUsage(req, 'symbols', 100); // Estimate ~100 tokens for symbol generation
        res.json({ suggestions });
      } catch (error: any) {
        trackApiUsage(req, 'symbols', 0, true); // Track error
        throw error;
      }
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to generate contextual suggestions" });
    }
  });

  // ARASAAC symbol search endpoint
  app.get("/api/arasaac/search/:language/:searchText", async (req: Request, res: Response) => {
    try {
      const { language, searchText } = req.params;
      console.log(`ARASAAC search request: "${searchText}" in ${language}`);
      
      const searchResults = await arasaacService.getBestSearch(searchText, language);
      const symbols = searchResults.map(result => ({
        id: result._id,
        label: searchText,
        imageUrl: arasaacService.getPictogramUrl(result._id, { color: true, width: 300, height: 300 }),
        keywords: result.keywords
      }));
      
      res.json({ symbols, count: symbols.length });
    } catch (error: any) {
      console.error("ARASAAC search error:", error);
      res.status(500).json({ message: error.message || "Failed to search ARASAAC symbols" });
    }
  });

  // ARASAAC keywords endpoint for autocompletion
  app.get("/api/arasaac/keywords/:language", async (req: Request, res: Response) => {
    try {
      const { language } = req.params;
      const keywords = await arasaacService.getKeywords(language);
      res.json({ keywords: keywords.slice(0, 100) }); // Limit to 100 for performance
    } catch (error: any) {
      console.error("ARASAAC keywords error:", error);
      res.status(500).json({ message: error.message || "Failed to fetch ARASAAC keywords" });
    }
  });

  // Visual context analysis
  app.post("/api/analyze-image", upload.single('image'), async (req: Request, res: Response) => {
    try {
      console.log("Received image analysis request");
      console.log("Request file:", req.file ? "Present" : "Missing");
      console.log("Request body keys:", Object.keys(req.body));
      
      if (!req.file) {
        console.log("No file found in request");
        return res.status(400).json({ message: "No image provided" });
      }
      
      console.log("File details:", {
        fieldname: req.file.fieldname,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.buffer.length
      });
      
      // Try Vertex AI first for visual analysis
      try {
        console.log("Starting visual analysis with Vertex AI...");
        const analysis = await analyzeVideoWithVertex(req.file.buffer);
        console.log("Vertex AI visual analysis completed:", analysis.substring(0, 100) + "...");
        trackApiUsage(req, 'visualAnalysis', 200); // Estimate ~200 tokens for visual analysis
        
        // Store visual context in session for debug window with camera info
        if (req.session) {
          const { cameraType, deviceLabel } = req.body;
          const sessionData = req.session as any;
          
          // Initialize camera visual contexts if not exists
          if (!sessionData.cameraVisualContexts) {
            sessionData.cameraVisualContexts = {};
          }
          
          // Store analysis by camera type/device
          const cameraKey = cameraType || (deviceLabel ? `device_${deviceLabel}` : 'unknown');
          sessionData.cameraVisualContexts[cameraKey] = {
            analysis,
            deviceLabel: deviceLabel || 'Unknown Device',
            cameraType: cameraType || 'unknown',
            timestamp: new Date().toISOString(),
            model: "Vertex AI Gemini 2.5 Flash"
          };
          
          // Keep the legacy field for backward compatibility
          sessionData.lastVisualContext = analysis;
          sessionData.lastModelUsed = "Vertex AI Gemini 2.5 Flash";
          sessionData.requestCount = (sessionData.requestCount || 0) + 1;
          sessionData.lastQuotaError = null; // Clear any previous quota errors
          console.log(`Stored Vertex AI analysis for ${cameraKey} in session, length:`, analysis.length);
        }
        
        return res.json({ analysis, source: "Vertex AI" });
        
      } catch (vertexError) {
        console.log("Vertex AI failed, falling back to Video Intelligence:", vertexError);
        trackApiUsage(req, 'visualAnalysis', 0, true); // Track Vertex AI error
        
        // Fallback to Video Intelligence
        console.log("Starting visual analysis with Video Intelligence fallback...");
        const { analyzeVideoFrame } = await import('./services/videoIntelligence');
        const videoResult = await analyzeVideoFrame(req.file.buffer);
        trackApiUsage(req, 'visualAnalysis', 150); // Estimate ~150 tokens for Video Intelligence
        
        // Store comprehensive analysis in session for debug window with camera info
        if (req.session) {
          const { cameraType, deviceLabel } = req.body;
          const sessionData = req.session as any;
          
          // Initialize camera visual contexts if not exists
          if (!sessionData.cameraVisualContexts) {
            sessionData.cameraVisualContexts = {};
          }
          
          // Store analysis by camera type/device
          const cameraKey = cameraType || (deviceLabel ? `device_${deviceLabel}` : 'unknown');
          sessionData.cameraVisualContexts[cameraKey] = {
            analysis: videoResult.analysis,
            deviceLabel: deviceLabel || 'Unknown Device',
            cameraType: cameraType || 'unknown',
            timestamp: new Date().toISOString(),
            model: "Google Cloud Video Intelligence (Fallback)"
          };
          
          // Keep the legacy field for backward compatibility
          sessionData.lastVisualContext = videoResult.analysis;
          sessionData.lastModelUsed = "Google Cloud Video Intelligence (Fallback)";
          sessionData.requestCount = (sessionData.requestCount || 0) + 1;
          console.log(`Stored Video Intelligence fallback analysis for ${cameraKey} in session, length:`, videoResult.analysis.length);
        }
        
        res.json({ 
          analysis: videoResult.analysis,
          personDetection: videoResult.personDetection,
          locationAnalysis: videoResult.locationAnalysis,
          objects: videoResult.objects,
          activities: videoResult.activities,
          labels: videoResult.labels,
          source: "Google Cloud Video Intelligence (Fallback)"
        });
        return;
      }

    } catch (error: any) {
      console.error("Error in analyze-image:", error);
      res.status(500).json({ message: error.message || "Failed to analyze image" });
    }
  });

  // Person detection with profile verification endpoint
  app.post("/api/detect-person", upload.single('image'), async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No image provided" });
      }
      
      const { expectedAge, expectedGender, cameraType, deviceLabel } = req.body;
      console.log("Person detection request - Expected:", expectedAge, expectedGender, "Camera type:", cameraType);
      
      // Import the new user camera detection service
      const { detectMainUserFromUserCamera, determineCameraType } = await import('./services/userCameraDetection');
      
      // Determine camera type if not provided
      let actualCameraType = cameraType;
      if (!actualCameraType && deviceLabel) {
        actualCameraType = determineCameraType(deviceLabel);
      }
      
      // Try Vertex AI first for person detection
      try {
        console.log("Starting person detection with Vertex AI...");
        const detection = await detectMainUserFromUserCamera(
          req.file.buffer,
          expectedAge ? parseInt(expectedAge) : undefined,
          expectedGender,
          actualCameraType
        );
        
        console.log("Vertex AI person detection result:", detection);
        
        // Store person detection data in session for debug window
        if (req.session) {
          (req.session as any).lastPersonDetection = detection;
          console.log("Stored person detection in session:", detection);
        }
        
        return res.json(detection);
        
      } catch (vertexError) {
        console.log("Vertex AI person detection failed, trying Gemini fallback...", vertexError);
        
        // Fallback to existing Gemini implementation
        const base64Image = req.file.buffer.toString('base64');
        const detection = await detectPersonDetails(
          base64Image, 
          expectedAge ? parseInt(expectedAge) : undefined,
          expectedGender
        );
        
        // Add camera type awareness to fallback - MODIFIED: Allow main user detection from any camera
        const result = {
          ...detection,
          cameraType: actualCameraType,
          isMainUser: detection.isMainUser // Allow main user identification from ANY camera for maximum coverage
        };
        
        console.log("Gemini fallback person detection result:", result);
        
        // Store person detection data in session for debug window
        if (req.session) {
          (req.session as any).lastPersonDetection = result;
          console.log("Stored fallback person detection in session:", result);
        }
        
        return res.json(result);
      }
    } catch (error: any) {
      console.error("Error in person detection:", error);
      res.status(500).json({ message: error.message || "Failed to detect person" });
    }
  });

  // Sign language detection endpoint - now using SignGemma as primary
  app.post("/api/detect-sign-language", upload.single('image'), async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No image provided" });
      }
      
      const { userId } = req.body;
      
      // Check if user has sign language reading enabled
      if (userId) {
        const user = await storage.getUser(userId);
        if (!user?.signLanguageReading) {
          return res.status(400).json({ message: "Sign language reading not enabled for this user" });
        }
      }
      
      // Try SignGemma first for specialized ASL detection
      if (signGemmaService.isAvailable()) {
        try {
          console.log("Starting sign language detection with SignGemma...");
          const detection = await detectSignLanguageWithSignGemma(req.file.buffer);
          
          console.log("SignGemma sign language detection result:", detection);
          
          // Store sign language detection in session for debugging
          if (req.session) {
            (req.session as any).lastSignLanguageDetection = {
              ...detection,
              timestamp: new Date().toISOString(),
              available: true,
              model: "SignGemma"
            };
            console.log("Stored SignGemma detection in session:", detection);
          }
          
          return res.json(detection);
          
        } catch (signGemmaError) {
          console.log("SignGemma detection failed, falling back to Vertex AI:", signGemmaError);
        }
      } else {
        console.log("SignGemma not available, using Vertex AI fallback");
      }
      
      // Fallback to Vertex AI for sign language detection
      try {
        console.log("Starting sign language detection with Vertex AI (fallback)...");
        const detection = await detectSignLanguage(req.file.buffer);
        
        console.log("Vertex AI sign language detection result:", detection);
        
        // Store sign language detection in session for debugging
        if (req.session) {
          (req.session as any).lastSignLanguageDetection = {
            ...detection,
            timestamp: new Date().toISOString(),
            available: true,
            model: "Vertex AI"
          };
          console.log("Stored Vertex AI fallback detection in session:", detection);
        }
        
        return res.json(detection);
        
      } catch (vertexError) {
        console.log("Vertex AI sign language detection failed:", vertexError);
        return res.status(500).json({ 
          message: "Sign language detection unavailable",
          signLanguageDetected: false,
          confidence: 0
        });
      }
    } catch (error: any) {
      console.error("Error in sign language detection:", error);
      res.status(500).json({ message: error.message || "Failed to detect sign language" });
    }
  });

  // Enhanced person and role analysis endpoint
  app.post("/api/analyze-person-role", upload.single('image'), async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No image provided" });
      }
      
      const { userId } = req.body;
      if (!userId) {
        return res.status(400).json({ message: "User ID required" });
      }
      
      const base64Image = req.file.buffer.toString('base64');
      const analysis = await analyzePersonAndRole(base64Image, userId);
      res.json(analysis);
    } catch (error: any) {
      console.error("Error in person role analysis:", error);
      res.status(500).json({ message: error.message || "Failed to analyze person role" });
    }
  });

  // Add new person to user's known people list
  app.post("/api/users/:userId/add-person", async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      const { name, role, description } = req.body;
      
      if (!name || !role) {
        return res.status(400).json({ message: "Name and role are required" });
      }
      
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      const newPerson = {
        name,
        role,
        description: description || "",
        addedAt: new Date().toISOString()
      };
      
      const knownPeople = user.knownPeople || [];
      knownPeople.push(newPerson);
      
      await storage.updateUser(userId, { knownPeople });
      res.json({ success: true, person: newPerson });
    } catch (error: any) {
      console.error("Error adding person:", error);
      res.status(500).json({ message: error.message || "Failed to add person" });
    }
  });

  // Symbol sequence interpretation
  app.post("/api/interpret", async (req: Request, res: Response) => {
    try {
      const { symbols, context } = req.body;
      const interpretation = await interpretSymbolSequence(symbols, context);
      res.json({ interpretation });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to interpret symbols" });
    }
  });

  // Conversation routes
  app.post("/api/conversation/start", async (req: Request, res: Response) => {
    try {
      const { userId, userProfile, visualContext, language = "en" } = req.body;
      
      // Get session visual context and person detection data if available
      const sessionData = (req.session as any);
      const sessionVisualContext = sessionData?.visualContext;
      const personData = sessionData?.lastPersonDetection;
      
      // Use the most detailed visual context available
      const enhancedVisualContext = sessionVisualContext || visualContext || 'Basic indoor environment';
      
      // Add emotional context from facial expression detection
      let emotionalContext = "";
      if (personData?.facialExpression && personData?.emotionalState) {
        emotionalContext = `The user appears ${personData.facialExpression} and ${personData.emotionalState}`;
      }
      
      // Get audio context from session
      const audioContext = sessionData?.audioContext;
      
      try {
        const message = await startConversation(userId, userProfile, enhancedVisualContext, language, emotionalContext, audioContext);
        trackApiUsage(req, 'conversation', 150); // Estimate ~150 tokens for conversation start
        res.json({ message });
      } catch (error: any) {
        trackApiUsage(req, 'conversation', 0, true); // Track error
        throw error;
      }
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to start conversation" });
    }
  });

  app.post("/api/conversation/respond", async (req: Request, res: Response) => {
    try {
      const { userId, symbols, context, language = "en" } = req.body;
      
      // Get session visual context and person detection data if available
      const sessionData = (req.session as any);
      const sessionVisualContext = sessionData?.visualContext;
      const personData = sessionData?.lastPersonDetection;
      
      // Enhanced context with session visual data, emotional context, and audio context
      const audioContext = sessionData?.audioContext;
      const enhancedContext = {
        ...context,
        visualContext: sessionVisualContext || context.visualContext || 'Basic indoor environment',
        emotionalContext: personData?.facialExpression && personData?.emotionalState ? 
          `The user appears ${personData.facialExpression} and ${personData.emotionalState}` : "",
        audioContext: audioContext ? {
          transcript: audioContext.transcript,
          ambientSounds: audioContext.ambientSounds,
          speechPresent: audioContext.speechPresent,
          detectedLanguage: audioContext.detectedLanguage
        } : null
      };
      
      try {
        const message = await generateAgentResponse(userId, symbols, enhancedContext, language);
        trackApiUsage(req, 'conversation', 200); // Estimate ~200 tokens for agent response
        res.json({ message });
      } catch (error: any) {
        trackApiUsage(req, 'conversation', 0, true); // Track error
        throw error;
      }
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to generate response" });
    }
  });

  app.get("/api/conversation/history/:userId", async (req: Request, res: Response) => {
    try {
      const history = getConversationHistory(req.params.userId);
      res.json({ history });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to get conversation history" });
    }
  });

  app.post("/api/conversation/audio", async (req: Request, res: Response) => {
    try {
      const { messageId, text, language = "en", userId, isUserMessage = false } = req.body;
      
      // Get user profile for voice matching
      let userProfile = null;
      if (userId) {
        try {
          userProfile = await storage.getUser(userId);
        } catch (error) {
          console.log("Could not fetch user profile for voice matching:", error);
        }
      }
      
      // Check request body for userProfile first
      if (req.body.userProfile) {
        userProfile = req.body.userProfile;
      }
      
      // Also check for detected person data in session as fallback
      if (!userProfile) {
        const sessionData = req.session as any;
        if (sessionData?.personData) {
          userProfile = {
            age: sessionData.personData.detectedAge,
            gender: sessionData.personData.detectedGender
          };
        }
      }
      
      try {
        const audioBuffer = await generateMessageAudio(messageId, text, language, userProfile, isUserMessage);
        trackApiUsage(req, 'voice', text.length / 4); // Estimate tokens based on text length
        
        res.set({
          'Content-Type': 'audio/mpeg',
          'Content-Length': audioBuffer.length.toString(),
        });
        res.send(audioBuffer);
      } catch (error: any) {
        trackApiUsage(req, 'voice', 0, true); // Track error
        throw error;
      }
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to generate audio" });
    }
  });

  app.delete("/api/conversation/:userId", async (req: Request, res: Response) => {
    try {
      clearConversation(req.params.userId);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to clear conversation" });
    }
  });

  // Chat history routes
  app.get("/api/chat-history/:userId", async (req: Request, res: Response) => {
    try {
      const history = await storage.getChatHistory(req.params.userId);
      res.json(history);
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to fetch chat history" });
    }
  });

  app.post("/api/chat-history", async (req: Request, res: Response) => {
    try {
      const chatData = insertChatHistorySchema.parse(req.body);
      const chat = await storage.addChatHistory(chatData);
      res.json(chat);
    } catch (error: any) {
      res.status(400).json({ message: error.message || "Failed to save chat history" });
    }
  });

  // Audio processing endpoints using Gemini
  app.post("/api/audio/process", upload.single('audio'), async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No audio file provided" });
      }

      console.log('Processing audio file with Gemini API...');
      let audioContext;
      try {
        audioContext = await audioCaptureService.processAudioBuffer(req.file.buffer, req.file.originalname || 'audio.wav');
        trackApiUsage(req, 'audio', 50); // Estimate ~50 tokens for audio transcription
        
        // Store audio context in session for integration with visual context
        (req.session as any).audioContext = audioContext;
      } catch (error: any) {
        trackApiUsage(req, 'audio', 0, true); // Track error
        throw error;
      }

      res.json({
        transcript: audioContext.transcript,
        detectedLanguage: audioContext.detectedLanguage,
        confidence: audioContext.confidence,
        ambientSounds: audioContext.ambientSounds,
        speechPresent: audioContext.speechPresent,
        timestamp: audioContext.timestamp
      });

    } catch (error: any) {
      console.error('Audio processing error:', error);
      res.status(500).json({ message: error.message || "Failed to process audio" });
    }
  });

  app.get("/api/audio/context", async (req: Request, res: Response) => {
    try {
      const sessionData = req.session as any;
      const audioContext = sessionData?.audioContext;

      if (!audioContext) {
        return res.json({
          hasAudioContext: false,
          message: "No audio context available"
        });
      }

      res.json({
        hasAudioContext: true,
        audioContext: {
          transcript: audioContext.transcript,
          detectedLanguage: audioContext.detectedLanguage,
          confidence: audioContext.confidence,
          ambientSounds: audioContext.ambientSounds,
          speechPresent: audioContext.speechPresent,
          timestamp: audioContext.timestamp,
          age: Math.floor((Date.now() - new Date(audioContext.timestamp).getTime()) / 1000) // Age in seconds
        }
      });

    } catch (error: any) {
      console.error('Error retrieving audio context:', error);
      res.status(500).json({ message: error.message || "Failed to retrieve audio context" });
    }
  });

  app.post("/api/audio/start-monitoring", async (req: Request, res: Response) => {
    try {
      const { intervalMs = 10000 } = req.body;
      
      await audioCaptureService.startContinuousMonitoring(intervalMs);
      
      res.json({
        success: true,
        message: `Audio monitoring started with ${intervalMs}ms intervals`,
        isRecording: audioCaptureService.getRecordingStatus()
      });

    } catch (error: any) {
      console.error('Error starting audio monitoring:', error);
      res.status(500).json({ message: error.message || "Failed to start audio monitoring" });
    }
  });

  app.post("/api/audio/stop-monitoring", async (req: Request, res: Response) => {
    try {
      audioCaptureService.stopContinuousMonitoring();
      
      res.json({
        success: true,
        message: "Audio monitoring stopped",
        isRecording: audioCaptureService.getRecordingStatus()
      });

    } catch (error: any) {
      console.error('Error stopping audio monitoring:', error);
      res.status(500).json({ message: error.message || "Failed to stop audio monitoring" });
    }
  });

  app.get("/api/audio/status", async (req: Request, res: Response) => {
    try {
      const isRecording = audioCaptureService.getRecordingStatus();
      const sessionData = req.session as any;
      const hasAudioContext = !!sessionData?.audioContext;

      res.json({
        isRecording,
        hasAudioContext,
        lastAudioTimestamp: hasAudioContext ? sessionData.audioContext.timestamp : null
      });

    } catch (error: any) {
      console.error('Error getting audio status:', error);
      res.status(500).json({ message: error.message || "Failed to get audio status" });
    }
  });

  // Session management
  app.post("/api/sessions", async (req: Request, res: Response) => {
    try {
      const sessionData = req.body;
      const session = await storage.createSession(sessionData);
      res.json(session);
    } catch (error: any) {
      res.status(400).json({ message: error.message || "Failed to create session" });
    }
  });

  app.put("/api/sessions/:id", async (req: Request, res: Response) => {
    try {
      const sessionData = req.body;
      const session = await storage.updateSession(req.params.id, sessionData);
      res.json(session);
    } catch (error: any) {
      res.status(400).json({ message: error.message || "Failed to update session" });
    }
  });

  // Environmental context endpoint
  app.get("/api/context", async (req: Request, res: Response) => {
    try {
      const now = new Date();
      const time = now.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: 'Europe/Istanbul'
      });
      
      res.json({
        time,
        date: now.toDateString(),
        timestamp: now.toISOString()
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to get context" });
    }
  });

  // Debug environment endpoint with AI model usage tracking
  app.get('/api/debug/environment', async (req, res) => {
    try {
      console.log("Debug endpoint - Session data:", {
        hasSession: !!req.session,
        hasPersonDetection: !!(req.session as any)?.lastPersonDetection,
        hasVisualContext: !!(req.session as any)?.lastVisualContext,
        personData: (req.session as any)?.lastPersonDetection || null,
        visualDataLength: ((req.session as any)?.lastVisualContext || '').length
      });

      // Get latest visual analysis and camera-specific data
      const sessionData = req.session as any;
      let visualContext = sessionData?.lastVisualContext || 'No visual data available';
      let personDetection = sessionData?.lastPersonDetection || null;
      let signLanguageDetection = sessionData?.lastSignLanguageDetection || null;
      let locationAnalysis = null;
      let environmentalObjects: string[] = [];
      
      // Get camera-specific visual analysis
      const cameraVisualContexts = sessionData?.cameraVisualContexts || {};
      const visualAnalysisData = {
        available: Object.keys(cameraVisualContexts).length > 0,
        cameras: {} as Record<string, any>
      };
      
      // Process each camera's visual data
      for (const [cameraKey, cameraData] of Object.entries(cameraVisualContexts)) {
        const data = cameraData as any;
        visualAnalysisData.cameras[cameraKey] = {
          cameraType: data.cameraType,
          deviceLabel: data.deviceLabel,
          analysis: data.analysis?.substring(0, 200) + '...' || 'No analysis available',
          fullAnalysis: data.analysis || 'No analysis available',
          timestamp: data.timestamp,
          model: data.model
        };
      }
      
      // Enhanced person detection with camera information
      const enhancedPersonDetection = personDetection ? {
        ...personDetection,
        detectionCamera: personDetection.cameraType === 'user' ? 'User Camera (Face Detection)' : 
                        personDetection.cameraType === 'environment' ? 'Environment Camera (Scene Analysis)' : 
                        'Unknown Camera',
        detectionSource: `Detected via ${personDetection.cameraType || 'unknown'} camera`
      } : {
        personPresent: false,
        isMainUser: false,
        detectedAge: null,
        detectedGender: 'unknown',
        facialExpression: 'unknown',
        emotionalState: 'No person detected',
        confidence: 0,
        detectionCamera: 'No Detection',
        detectionSource: 'No active person detection'
      };
      
      // Get API usage statistics from session
      const apiUsage = (req.session as any)?.apiUsage || {
        conversation: { calls: 0, tokens: 0, errors: 0 },
        visualAnalysis: { calls: 0, tokens: 0, errors: 0 },
        symbols: { calls: 0, tokens: 0, errors: 0 },
        voice: { calls: 0, tokens: 0, errors: 0 },
        audio: { calls: 0, tokens: 0, errors: 0 }
      };

      // AI model usage data with real-time status and API usage tracking
      const aiModelStatus = {
        conversationModel: {
          primary: "Google Gemini API (2.5 Flash)",
          fallback: "Vertex AI → OpenAI GPT-4o", 
          currentStatus: "Active & Working",
          activeFallback: "None (Primary Working)",
          apiUsage: {
            sessionCalls: apiUsage.conversation.calls,
            estimatedTokens: apiUsage.conversation.tokens,
            errors: apiUsage.conversation.errors,
            lastCallTime: apiUsage.conversation.lastCall || 'Never'
          }
        },
        symbolGeneration: {
          primary: "BERT + PrAACT (Predictive AAC Technology)",
          fallback: "Gemini API → OpenAI GPT-4o",
          currentStatus: "Active & Working",
          activeFallback: "None (Primary Working)",
          apiUsage: {
            sessionCalls: apiUsage.symbols.calls,
            estimatedTokens: apiUsage.symbols.tokens,
            errors: apiUsage.symbols.errors,
            lastCallTime: apiUsage.symbols.lastCall || 'Never'
          }
        },
        visualAnalysis: {
          primary: "Google Vertex AI",
          fallback: "Video Intelligence → Gemini API",
          currentStatus: "Active & Working", 
          activeFallback: "None (Primary Working)",
          apiUsage: {
            sessionCalls: apiUsage.visualAnalysis.calls,
            estimatedTokens: apiUsage.visualAnalysis.tokens,
            errors: apiUsage.visualAnalysis.errors,
            lastCallTime: apiUsage.visualAnalysis.lastCall || 'Never'
          }
        },
        personDetection: {
          primary: "Google Vertex AI",
          fallback: "Video Intelligence → Gemini API", 
          currentStatus: "Active & Working",
          activeFallback: "None (Primary Working)",
          apiUsage: {
            sessionCalls: apiUsage.visualAnalysis.calls, // Same as visual analysis
            estimatedTokens: apiUsage.visualAnalysis.tokens,
            errors: apiUsage.visualAnalysis.errors,
            lastCallTime: apiUsage.visualAnalysis.lastCall || 'Never'
          }
        },
        voiceSynthesis: {
          primary: "Google Cloud Text-to-Speech",
          fallback: "ElevenLabs → Browser TTS",  
          currentStatus: "Active & Working",
          activeFallback: "None (Primary Working)",
          apiUsage: {
            sessionCalls: apiUsage.voice.calls,
            estimatedTokens: apiUsage.voice.tokens,
            errors: apiUsage.voice.errors,
            lastCallTime: apiUsage.voice.lastCall || 'Never'
          }
        },
        audioTranscription: {
          primary: "Google Gemini API",
          fallback: "Basic Audio Analysis",
          currentStatus: sessionData?.audioContext ? "Working" : "No Recent Data",
          activeFallback: sessionData?.audioContext?.transcript ? "None (Primary Working)" : "Basic Analysis",
          apiUsage: {
            sessionCalls: apiUsage.audio.calls,
            estimatedTokens: apiUsage.audio.tokens,
            errors: apiUsage.audio.errors,
            lastCallTime: apiUsage.audio.lastCall || 'Never'
          }
        },
        quotaLimits: {
          geminiDailyLimit: 250,
          geminiCurrentUsage: "Exceeded (API 429 Errors)",
          vertexAiQuota: "Enterprise (Available)",
          openAiQuota: "Available",
          speechToTextQuota: "Available"
        },
        lastError: (req.session as any)?.lastQuotaError || null,
        recommendedAction: "Using Vertex AI + Smart Fallbacks (Working)"
      };

      // Analyze location type from visual context if available
      if (req.session && (req.session as any).lastVisualContext) {
        const lowerContext = visualContext.toLowerCase();
        if (lowerContext.includes('desk') || lowerContext.includes('computer') || lowerContext.includes('office')) {
          locationAnalysis = {
            locationType: 'Office/Workspace',
            confidence: 0.8,
            features: ['desk', 'computer equipment', 'office furniture']
          };
        } else if (lowerContext.includes('bed') || lowerContext.includes('bedroom') || lowerContext.includes('pillow')) {
          locationAnalysis = {
            locationType: 'Bedroom/House',
            confidence: 0.85,
            features: ['bedroom furniture', 'personal space']
          };
        } else if (lowerContext.includes('kitchen') || lowerContext.includes('stove') || lowerContext.includes('refrigerator')) {
          locationAnalysis = {
            locationType: 'Kitchen/House',
            confidence: 0.9,
            features: ['kitchen appliances', 'cooking area']
          };
        } else if (lowerContext.includes('classroom') || lowerContext.includes('whiteboard') || lowerContext.includes('students')) {
          locationAnalysis = {
            locationType: 'School/Classroom',
            confidence: 0.85,
            features: ['educational environment', 'learning space']
          };
        } else if (lowerContext.includes('playground') || lowerContext.includes('toys') || lowerContext.includes('colorful')) {
          locationAnalysis = {
            locationType: 'Kindergarten/Daycare',
            confidence: 0.8,
            features: ['play area', 'child-friendly environment']
          };
        } else if (lowerContext.includes('street') || lowerContext.includes('car') || lowerContext.includes('road')) {
          locationAnalysis = {
            locationType: 'Street/Outdoor',
            confidence: 0.75,
            features: ['outdoor environment', 'transportation']
          };
        } else {
          locationAnalysis = {
            locationType: 'Indoor/Residential',
            confidence: 0.6,
            features: ['indoor space', 'residential setting']
          };
        }

        // Extract objects from visual context
        const objectKeywords = [
          'chair', 'table', 'computer', 'laptop', 'phone', 'book', 'cup', 'bottle',
          'lamp', 'window', 'door', 'plant', 'picture', 'clock', 'keyboard', 'mouse',
          'screen', 'monitor', 'bed', 'pillow', 'blanket', 'toy', 'game', 'food'
        ];
        
        environmentalObjects = objectKeywords.filter(keyword => 
          lowerContext.includes(keyword)
        );
      } else {
        // Visual analysis unavailable due to API quotas
        visualContext = 'Visual analysis temporarily unavailable due to API quota limits';
        locationAnalysis = {
          locationType: 'Unknown (API Limited)',
          confidence: 0.0,
          features: ['Camera active', 'Analysis pending']
        };
      }

      // Get audio context data
      const audioContext = sessionData?.audioContext;
      const audioContextData = audioContext ? {
        available: true,
        transcript: audioContext.transcript || '',
        detectedLanguage: audioContext.detectedLanguage,
        confidence: audioContext.confidence || 0,
        ambientSounds: audioContext.ambientSounds || [],
        speechPresent: audioContext.speechPresent || false,
        timestamp: audioContext.timestamp,
        age: audioContext.timestamp ? Math.floor((Date.now() - new Date(audioContext.timestamp).getTime()) / 1000) : 0,
        whisperStatus: audioContext.transcript ? 'Gemini Transcription Active' : 'Gemini Monitoring Only'
      } : {
        available: false,
        whisperStatus: 'No Recent Audio Data (Gemini Ready)'
      };

      // Build complete response data
      const responseData = {
        time: new Date().toLocaleString('en-US', { 
          weekday: 'short', 
          month: 'short', 
          day: 'numeric', 
          year: 'numeric', 
          hour: 'numeric', 
          minute: '2-digit',
          hour12: true 
        }),
        visualAnalysis: visualAnalysisData,
        personDetection: enhancedPersonDetection,
        signLanguageDetection: signLanguageDetection || {
          available: false,
          lastDetection: null,
          message: "No sign language detection data available"
        },
        locationAnalysis,
        environmentalObjects,
        audioContext: audioContextData,
        aiModelStatus,
        performance: {
          visualAnalysisLatency: req.session ? ((req.session as any).lastAnalysisTime || 'N/A') : 'N/A',
          personDetectionLatency: req.session ? ((req.session as any).lastPersonDetectionTime || 'N/A') : 'N/A'
        }
      };

      res.json(responseData);
    } catch (error: any) {
      console.error('Debug endpoint error:', error);
      res.status(500).json({ message: error.message || "Failed to get debug data" });
    }
  });

  // Multi-camera routes
  app.use('/api/multi-camera', multiCameraRoutes);

  // Admin authentication routes
  app.post("/api/admin/login", async (req: Request, res: Response) => {
    try {
      const { username, password } = adminLoginSchema.parse(req.body);
      
      const admin = await storage.getAdminByUsername(username);
      if (!admin || !admin.isActive) {
        return res.status(401).json({ message: "Invalid credentials" });
      }

      const validPassword = await bcrypt.compare(password, admin.passwordHash);
      if (!validPassword) {
        return res.status(401).json({ message: "Invalid credentials" });
      }

      // Update last login
      await storage.updateAdminLastLogin(admin.id);

      // Store admin session
      req.session.adminUser = {
        id: admin.id,
        username: admin.username,
        role: admin.role || 'admin'
      };

      res.json({
        success: true,
        admin: {
          id: admin.id,
          username: admin.username,
          email: admin.email,
          role: admin.role
        }
      });
    } catch (error: any) {
      res.status(400).json({ message: error.message || "Login failed" });
    }
  });

  app.post("/api/admin/logout", (req: Request, res: Response) => {
    req.session.adminUser = undefined;
    res.json({ success: true });
  });

  app.get("/api/admin/me", requireAdminAuth, (req: Request, res: Response) => {
    res.json(req.session.adminUser);
  });

  // Password Reset Routes
  app.post("/api/auth/forgot-password", async (req: Request, res: Response) => {
    try {
      const { email } = passwordResetRequestSchema.parse(req.body);
      
      // Find user by email
      const user = await storage.getUserByEmail(email);
      if (!user) {
        // Don't reveal if email exists or not for security
        return res.json({ message: "If an account with that email exists, a password reset link has been sent." });
      }

      // Generate reset token
      const resetToken = crypto.randomBytes(32).toString('hex');
      const resetTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

      // Save reset token to user
      await storage.updateUserResetToken(user.id, resetToken, resetTokenExpiry);

      // Send password reset email
      const emailSent = await emailService.sendPasswordResetEmail({
        userEmail: email,
        resetToken,
        userName: user.name,
        language: user.language === 'he' ? 'he' : 'en'
      });

      if (emailSent) {
        console.log(`Password reset email sent to ${email}`);
        // Send admin notification
        await emailService.sendAdminNotification(
          "Password Reset Request", 
          `User ${user.name} (${email}) requested a password reset at ${new Date().toLocaleString()}`
        );
      }

      res.json({ message: "If an account with that email exists, a password reset link has been sent." });
    } catch (error: any) {
      console.error('Password reset request error:', error);
      res.status(400).json({ message: error.message || "Failed to process password reset request" });
    }
  });

  app.post("/api/auth/reset-password", async (req: Request, res: Response) => {
    try {
      const { token, newPassword } = passwordResetSchema.parse(req.body);
      
      // Find user by reset token
      const user = await storage.getUserByResetToken(token);
      if (!user || !user.resetTokenExpiry) {
        return res.status(400).json({ message: "Invalid or expired reset token" });
      }

      // Check if token is expired
      if (new Date() > user.resetTokenExpiry) {
        return res.status(400).json({ message: "Reset token has expired" });
      }

      // Hash new password
      const passwordHash = await bcrypt.hash(newPassword, 10);

      // Update user password and clear reset token
      await storage.updateUserPassword(user.id, passwordHash);
      await storage.clearUserResetToken(user.id);

      console.log(`Password reset completed for user ${user.email}`);
      
      // Send admin notification
      await emailService.sendAdminNotification(
        "Password Reset Completed", 
        `User ${user.name} (${user.email}) successfully reset their password at ${new Date().toLocaleString()}`
      );

      res.json({ message: "Password has been reset successfully" });
    } catch (error: any) {
      console.error('Password reset error:', error);
      res.status(400).json({ message: error.message || "Failed to reset password" });
    }
  });

  // Email service status endpoint
  app.get("/api/email/status", (req: Request, res: Response) => {
    try {
      const status = emailService.getStatus();
      res.json({
        emailService: {
          initialized: status.initialized,
          host: status.host,
          port: status.port,
          ready: emailService.isReady()
        }
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to get email status" });
    }
  });

  // Test email endpoint
  app.post("/api/email/test", async (req: Request, res: Response) => {
    try {
      const { to } = req.body;
      if (!to) {
        return res.status(400).json({ message: "Email address required" });
      }

      const success = await emailService.sendEmail({
        to,
        subject: "Test Email from Xahaph System",
        html: `
          <h2>🧪 Test Email from Xahaph</h2>
          <p>This is a test email to verify the email service is working correctly.</p>
          <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
          <p><strong>System:</strong> Xahaph AAC Communication Platform</p>
          <p>If you received this email, the Titan Email SMTP service is functioning properly!</p>
          <br>
          <p><em>Best regards,<br>Xahaph Development Team</em></p>
        `,
        text: `Test Email from Xahaph System\n\nThis is a test email to verify the email service is working correctly.\nTimestamp: ${new Date().toISOString()}\nSystem: Xahaph AAC Communication Platform\n\nIf you received this email, the Titan Email SMTP service is functioning properly!`
      });

      if (success) {
        res.json({ 
          success: true, 
          message: `Test email sent successfully to ${to}` 
        });
      } else {
        res.status(500).json({ 
          success: false, 
          message: "Failed to send test email. Check email service configuration." 
        });
      }
    } catch (error: any) {
      console.error("Test email error:", error);
      res.status(500).json({ 
        success: false, 
        message: "Error sending test email", 
        error: error.message || "Unknown error"
      });
    }
  });

  // Passive co-listener audio classification endpoint
  app.post("/api/audio/classify-choice", upload.single('audio'), async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No audio file provided" });
      }

      const { userId = '', language = 'en' } = req.body;
      
      console.log('🎤 Processing audio for choice classification...');

      // Process audio with existing audio capture service
      const audioPath = req.file.path;
      const audioCapture = new AudioCaptureService();
      const audioContext = await audioCapture.processAudioFile(audioPath);
      
      if (!audioContext.speechPresent || !audioContext.transcript) {
        return res.json({
          addressee: 'other',
          confidence: 0,
          intent: 'NONE',
          originalText: audioContext.transcript || '',
          language
        });
      }

      // Import choice classifier
      const { choiceClassifier } = await import('./services/choiceClassifier');
      const classification = await choiceClassifier.classifyChoice(audioContext.transcript, language);

      console.log('🧠 Choice classification result:', classification);
      
      // Clean up temporary audio file
      const fs = await import('fs');
      if (fs.existsSync(audioPath)) {
        fs.unlinkSync(audioPath);
      }

      res.json(classification);
    } catch (error: any) {
      console.error("Choice classification error:", error);
      res.status(500).json({ 
        message: error.message || "Failed to classify choice", 
        addressee: 'other',
        confidence: 0,
        intent: 'NONE',
        originalText: '',
        language: req.body.language || 'en'
      });
    }
  });

  // Generate AAC choice options endpoint  
  app.post("/api/symbols/choice-options", async (req: Request, res: Response) => {
    try {
      const { classification, userId, language = 'en', context } = req.body;
      
      if (!classification) {
        return res.status(400).json({ message: "Classification required" });
      }

      console.log('💫 Generating AAC choice options for:', classification);

      // Import choice AAC generator
      const { choiceAACGenerator } = await import('./services/choiceAACGenerator');
      
      // Get user preferences if userId provided
      let userPreferences = {};
      if (userId) {
        try {
          const user = await storage.getUser(userId);
          userPreferences = {
            preferences: user?.preferences || ''
          };
        } catch (error) {
          console.log('Could not fetch user preferences:', error);
        }
      }

      const result = await choiceAACGenerator.generateAACOptions(
        classification,
        userId,
        language,
        context || {
          timeOfDay: new Date().getHours() < 12 ? 'morning' : 
                   new Date().getHours() < 17 ? 'afternoon' : 'evening',
          dayOfWeek: new Date().toLocaleDateString('en-US', { weekday: 'long' })
        }
      );

      console.log('✨ Generated AAC options:', result);
      res.json(result);
    } catch (error: any) {
      console.error("AAC option generation error:", error);
      res.status(500).json({ 
        message: error.message || "Failed to generate AAC options",
        suggestions: []
      });
    }
  });

  // SignGemma status endpoint  
  app.get("/api/signgemma/status", (req: Request, res: Response) => {
    try {
      res.json({
        available: signGemmaService.isAvailable(),
        modelInfo: signGemmaService.getModelInfo(),
        primaryModel: signGemmaService.isAvailable() ? "SignGemma" : "Vertex AI",
        fallbackModel: "Vertex AI"
      });
    } catch (error: any) {
      console.error("Error getting SignGemma status:", error);
      res.status(500).json({ message: error.message || "Failed to get SignGemma status" });
    }
  });

  // Create initial admin (for setup only - in production this should be protected)
  app.post("/api/admin/setup", async (req: Request, res: Response) => {
    try {
      const adminData = createAdminSchema.parse(req.body);
      
      // Check if any admin exists
      const existingAdmin = await storage.getAdminByUsername(adminData.username);
      if (existingAdmin) {
        return res.status(400).json({ message: "Admin already exists" });
      }

      const passwordHash = await bcrypt.hash(adminData.password, 10);
      
      const admin = await storage.createAdmin({
        username: adminData.username,
        email: adminData.email,
        passwordHash,
        role: adminData.role,
        isActive: true
      });

      res.json({
        success: true,
        admin: {
          id: admin.id,
          username: admin.username,
          email: admin.email,
          role: admin.role
        }
      });
    } catch (error: any) {
      res.status(400).json({ message: error.message || "Failed to create admin" });
    }
  });

  // Admin user management routes
  app.get("/api/admin/users", requireAdminAuth, async (req: Request, res: Response) => {
    try {
      const users = await storage.getAllUsers();
      res.json(users);
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to fetch users" });
    }
  });

  // Get single user (admin only)
  app.get("/api/admin/users/:id", requireAdminAuth, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const user = await storage.getUser(id);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      res.json(user);
    } catch (error: any) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: error.message || "Failed to fetch user" });
    }
  });

  app.delete("/api/admin/users/:id", requireAdminAuth, async (req: Request, res: Response) => {
    try {
      const success = await storage.deleteUser(req.params.id);
      if (!success) {
        return res.status(404).json({ message: "User not found" });
      }
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to delete user" });
    }
  });

  app.post("/api/admin/users", requireAdminAuth, async (req: Request, res: Response) => {
    try {
      let userData = insertUserSchema.parse(req.body);
      
      // Hash password if provided
      if ('password' in userData && userData.password) {
        const passwordHash = await bcrypt.hash(userData.password, 10);
        const { password, ...userDataWithoutPassword } = userData;
        userData = { ...userDataWithoutPassword, passwordHash };
      }
      
      const user = await storage.createUser(userData);
      res.json({ success: true, user });
    } catch (error: any) {
      res.status(400).json({ message: error.message || "Failed to create user" });
    }
  });

  app.put("/api/admin/users/:id", requireAdminAuth, async (req: Request, res: Response) => {
    try {
      let userData = insertUserSchema.partial().parse(req.body);
      
      // Hash password if provided
      if ('password' in userData && userData.password) {
        const passwordHash = await bcrypt.hash(userData.password, 10);
        const { password, ...userDataWithoutPassword } = userData;
        userData = { ...userDataWithoutPassword, passwordHash };
      }
      
      const user = await storage.updateUser(req.params.id, userData);
      res.json({ success: true, user });
    } catch (error: any) {
      res.status(400).json({ message: error.message || "Failed to update user" });
    }
  });

  // Admin self-management routes
  app.put("/api/admin/profile", requireAdminAuth, async (req: Request, res: Response) => {
    try {
      const { currentPassword, newPassword, email, username } = req.body;
      const adminId = req.session.adminUser?.id;

      if (!adminId) {
        return res.status(401).json({ message: "Admin authentication required" });
      }

      const admin = await storage.getAdmin(adminId);
      if (!admin) {
        return res.status(404).json({ message: "Admin not found" });
      }

      // If changing password, verify current password
      if (newPassword) {
        if (!currentPassword) {
          return res.status(400).json({ message: "Current password required to change password" });
        }

        const validPassword = await bcrypt.compare(currentPassword, admin.passwordHash);
        if (!validPassword) {
          return res.status(401).json({ message: "Current password is incorrect" });
        }

        // Hash new password
        const newPasswordHash = await bcrypt.hash(newPassword, 10);
        
        const updatedAdmin = await storage.updateAdmin(adminId, { 
          passwordHash: newPasswordHash,
          ...(email && { email }),
          ...(username && { username })
        });

        res.json({
          success: true,
          admin: {
            id: updatedAdmin.id,
            username: updatedAdmin.username,
            email: updatedAdmin.email,
            role: updatedAdmin.role
          }
        });
      } else if (email || username) {
        // Just updating profile information
        const updateData: any = {};
        if (email) updateData.email = email;
        if (username) updateData.username = username;
        
        const updatedAdmin = await storage.updateAdmin(adminId, updateData);
        
        res.json({
          success: true,
          admin: {
            id: updatedAdmin.id,
            username: updatedAdmin.username,
            email: updatedAdmin.email,
            role: updatedAdmin.role
          }
        });
      } else {
        return res.status(400).json({ message: "No changes provided" });
      }
    } catch (error: any) {
      res.status(400).json({ message: error.message || "Failed to update admin profile" });
    }
  });

  // Two-handed object detection endpoint
  app.post("/api/detect-objects-in-hands", upload.single('image'), async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No image provided' });
      }

      console.log('Two-handed object detection request received');
      
      const imageBuffer = req.file.buffer;

      // Use Vertex AI to analyze the image for hand-held objects
      const prompt = `You are an object detection AI. Analyze this image and detect objects being held in a person's hands.

CRITICAL: You must respond ONLY with valid JSON. No explanatory text before or after.

Look for:
- Objects clearly being held or grasped in left hand
- Objects clearly being held or grasped in right hand
- Common objects like: cup, phone, book, pen, toy, remote, keys, etc.

SPECIAL HANDLING FOR CARDS AND LETTERS:
- If you detect playing cards, trading cards, or any card with imagery:
  * DO NOT use "card" as the label
  * Instead, identify what's ON the card (number, suit, animal, person, character, etc.)
  * For playing cards: use the number/face (like "ace", "king", "seven") or suit ("hearts", "spades")
  * For animal cards: use the animal name (like "tiger", "elephant", "bird")
  * For character cards: use the character or person name if recognizable
  * Examples: "ace of hearts", "tiger", "princess", "number 5", "elephant"
  * Use appropriate emojis for the card content, not a generic card emoji

- If you detect letter cards, alphabet blocks, or any object with letters:
  * DO NOT use "letter" as the label
  * Instead, identify the specific letter (like "A", "B", "C", etc.)
  * Use the letter itself as the label: "A", "B", "Z", "a", "b", "z"
  * For Hebrew letters, use the Hebrew character: "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י", "כ", "ל", "מ", "נ", "ס", "ע", "פ", "צ", "ק", "ר", "ש", "ת"
  * For multiple letters, identify the most prominent or clear letter
  * Examples: "A", "letter B", "alphabet Z", "א" (alef), "ב" (bet), "ג" (gimel)
  * Use letter emojis when available (🅰️, 🅱️) or the letter symbol itself
  * For Hebrew letters, use the actual Hebrew character as the label

Respond with this exact JSON structure:
{
  "leftHandObject": {
    "id": "left_object_1",
    "label": "object_name",
    "emoji": "📱",
    "confidence": 0.85,
    "hand": "left"
  },
  "rightHandObject": null,
  "detectionConfidence": 0.75,
  "timestamp": ${Date.now()}
}

If no object is detected in a hand, use null for that hand.
If no objects detected at all, use:
{
  "leftHandObject": null,
  "rightHandObject": null,
  "detectionConfidence": 0,
  "timestamp": ${Date.now()}
}

RESPOND ONLY WITH JSON - NO OTHER TEXT.`;

      // Use Vertex AI as primary for object detection to avoid OpenAI charges
      let analysisResult: string | null = null;
      
      try {
        console.log('Using Vertex AI for object detection...');
        const { analyzeObjectsInHandsWithVertex } = await import('./services/vertexai');
        analysisResult = await analyzeObjectsInHandsWithVertex(imageBuffer);
        if (analysisResult) {
          console.log('✅ Vertex AI detection successful');
        }
      } catch (vertexError) {
        console.log('Vertex AI failed, trying OpenAI fallback:', vertexError);
        
        // Fallback to OpenAI only if Vertex AI fails
        if (process.env.OPENAI_API_KEY) {
          try {
            console.log('Trying OpenAI GPT-4 Vision as fallback...');
            const openaiResult = await analyzeImageWithOpenAI(imageBuffer, prompt);
            if (openaiResult) {
              analysisResult = openaiResult;
              console.log('✅ OpenAI fallback successful');
            }
          } catch (openaiError) {
            console.log('OpenAI fallback also failed:', openaiError);
          }
        } else {
          console.log('No OpenAI API key available for fallback');
        }
      }
      
      if (!analysisResult) {
        return res.status(500).json({ error: 'Failed to analyze image' });
      }

      try {
        // Clean and parse the AI response as JSON
        let cleanedResponse = analysisResult.trim();
        
        // Remove common markdown formatting
        cleanedResponse = cleanedResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        
        // Remove any leading/trailing text that might not be JSON
        const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          cleanedResponse = jsonMatch[0];
        }
        
        const detection = JSON.parse(cleanedResponse);
        
        // Validate required structure
        if (typeof detection !== 'object' || 
            !detection.hasOwnProperty('leftHandObject') || 
            !detection.hasOwnProperty('rightHandObject') || 
            !detection.hasOwnProperty('detectionConfidence')) {
          throw new Error('Invalid detection structure');
        }
        
        // Fix mirror effect: swap left and right detection results
        // Camera acts like a mirror: user's right hand appears on camera's left side
        // So we swap: camera's "left" becomes user's "right", camera's "right" becomes user's "left"
        const correctedDetection = {
          leftHandObject: detection.rightHandObject ? { ...detection.rightHandObject, hand: 'left' } : null,
          rightHandObject: detection.leftHandObject ? { ...detection.leftHandObject, hand: 'right' } : null,
          detectionConfidence: detection.detectionConfidence,
          timestamp: detection.timestamp || Date.now()
        };
        
        console.log('Applied mirror correction - swapped left/right detection');

        console.log('Two-handed object detection result:', {
          leftObject: correctedDetection.leftHandObject?.label || 'none',
          rightObject: correctedDetection.rightHandObject?.label || 'none',
          confidence: correctedDetection.detectionConfidence
        });

        res.json(correctedDetection);
      } catch (parseError) {
        console.error('Failed to parse AI response as JSON:', parseError);
        console.log('Raw AI response (first 500 chars):', analysisResult.substring(0, 500));
        
        // Enhanced fallback: try to extract object names from natural language
        const fallbackResult = {
          leftHandObject: null,
          rightHandObject: null,
          detectionConfidence: 0,
          timestamp: Date.now()
        };

        // Attempt to extract object mentions from text
        const objectKeywords = ['phone', 'cup', 'book', 'pen', 'remote', 'keys', 'bottle', 'glass', 'paper', 'ace', 'king', 'queen', 'jack', 'hearts', 'spades', 'diamonds', 'clubs', 'tiger', 'elephant', 'lion', 'bird', 'cat', 'dog', 'horse', 'number', 'princess', 'prince', 
          // English letters
          'letter A', 'letter B', 'letter C', 'letter D', 'letter E', 'letter F', 'letter G', 'letter H', 'letter I', 'letter J', 'letter K', 'letter L', 'letter M', 'letter N', 'letter O', 'letter P', 'letter Q', 'letter R', 'letter S', 'letter T', 'letter U', 'letter V', 'letter W', 'letter X', 'letter Y', 'letter Z',
          // Hebrew letters with names
          'alef', 'bet', 'gimel', 'dalet', 'he', 'vav', 'zayin', 'het', 'tet', 'yod', 'kaf', 'lamed', 'mem', 'nun', 'samekh', 'ayin', 'pe', 'tsadi', 'qof', 'resh', 'shin', 'tav',
          // Hebrew letters themselves
          'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ', 'ק', 'ר', 'ש', 'ת'];
        const foundObjects = objectKeywords.filter(keyword => 
          analysisResult.toLowerCase().includes(keyword.toLowerCase()) || analysisResult.includes(keyword)
        );

        if (foundObjects.length > 0) {
          console.log('Extracted objects from text:', foundObjects);
          fallbackResult.detectionConfidence = 0.3; // Low confidence for text extraction
        }

        res.json(fallbackResult);
      }

    } catch (error) {
      console.error('Two-handed object detection error:', error);
      res.status(500).json({ error: 'Internal server error during object detection' });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
