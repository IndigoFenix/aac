import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useCamera } from "@/hooks/useCamera";
import { useMultiCamera } from "@/hooks/useMultiCamera";
import { useObjectDetectionSymbols } from "@/hooks/useObjectDetectionSymbols";
import { useEyegazeSelection } from "@/hooks/useEyegazeSelection";
import { EyegazeCursor } from "@/components/EyegazeCursor";
import { 
  organizeSymbolsByPartOfSpeech, 
  getPartOfSpeechColor, 
  getPartOfSpeechLabel,
  detectPartOfSpeech,
  type PartOfSpeech 
} from "@/utils/partsOfSpeech";

interface Symbol {
  id: string;
  label: string;
  emoji: string;
  confidence: number;
  reasoning: string;
}

interface DetectedObject {
  id: string;
  label: string;
  emoji: string;
  confidence: number;
  hand: 'left' | 'right';
}

interface SymbolBoardProps {
  studentId: string | null;
  onSymbolSelect: (symbol: { label: string; emoji: string }) => void;
  conversationActive?: boolean;
  language?: string;
  detectedObjects?: {left: DetectedObject | null, right: DetectedObject | null};
  debugMode?: boolean;
}

export default function SymbolBoard({ studentId, onSymbolSelect, conversationActive = false, language: propLanguage, detectedObjects, debugMode = false }: SymbolBoardProps) {
  const [contextData, setContextData] = useState<any>(null);
  const [selectedSymbols, setSelectedSymbols] = useState<Array<{ label: string; emoji: string }>>([]);
  const [timeoutId, setTimeoutId] = useState<NodeJS.Timeout | null>(null);
  const [countdown, setCountdown] = useState<number>(0);
  const countdownRef = useRef<NodeJS.Timeout | null>(null);
  const { captureFrame } = useCamera();
  const { cameras, getUserCamera, getEnvironmentCamera } = useMultiCamera();
  const queryClient = useQueryClient();

  // Local time context (no server call needed)
  const [envContext, setEnvContext] = useState<{ time: string } | null>(null);
  useEffect(() => {
    const update = () => setEnvContext({ time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
    update();
    const id = setInterval(update, 60000);
    return () => clearInterval(id);
  }, []);

  // Get student profile if available
  const { data: userProfile } = useQuery({
    queryKey: ["/api/students", studentId],
    enabled: !!studentId,
  });

  // Use language from student profile, fallback to prop language, then default to "en"
  const language = (userProfile as any)?.primaryLanguage || (userProfile as any)?.language || propLanguage || "en";

  // Debug language detection
  useEffect(() => {
    console.log("Language detection debug:", {
      studentProfileLanguage: (userProfile as any)?.primaryLanguage,
      propLanguage,
      finalLanguage: language,
      studentId
    });
  }, [(userProfile as any)?.primaryLanguage, propLanguage, language, studentId]);

  // Get symbol suggestions (contextual if conversation active) - optimized with controlled timing
  const { data: suggestions, refetch: refetchSuggestions, isLoading: suggestionsLoading, error: suggestionsError } = useQuery({
    queryKey: [conversationActive ? "/api/aac/symbols/contextual" : "/api/aac/symbols/suggestions", contextData, studentId, language],
    queryFn: async () => {
      if (!contextData) {
        console.log("No context data available for symbols");
        return { suggestions: [] };
      }

      const endpoint = conversationActive ? "/api/aac/symbols/contextual" : "/api/aac/symbols/suggestions";
      const payload = conversationActive
        ? { context: contextData, studentId, language }
        : { context: contextData, language };

      console.log("Fetching symbols from", endpoint, "with payload:", payload);
      const response = await apiRequest("POST", endpoint, payload);
      const result = await response.json();
      console.log("Symbol response received:", result);
      return result;
    },
    enabled: !!contextData,
    refetchInterval: false, // Disable automatic refetch
    staleTime: 30000, // Consider data fresh for 30 seconds (reduced)
    gcTime: 300000, // Keep cached for 5 minutes
    retry: 2, // Retry failed requests twice
  });

  // Object detection integration for smart symbol replacement
  const { isDetecting } = useObjectDetectionSymbols({
    isEnabled: (userProfile as any)?.objectDetectionEnabled || (userProfile as any)?.object_detection_enabled || false,
    contextualSymbols: suggestions?.suggestions || [],
    studentId,
    language
  });
  
  const hasDetectedObjects = detectedObjects && (detectedObjects.left || detectedObjects.right);

  // Convert detected objects to symbol format - deduplicate identical objects
  const getDetectedObjectSymbols = () => {
    if (!hasDetectedObjects) return [];
    
    const symbols = [];
    
    // Check if both hands have the same object
    const leftObject = detectedObjects.left;
    const rightObject = detectedObjects.right;
    
    if (leftObject && rightObject && leftObject.label === rightObject.label) {
      // Both hands have the same object - show only one card
      symbols.push({
        id: `detected_both_${leftObject.id}`,
        label: leftObject.label,
        emoji: leftObject.emoji,
        confidence: Math.max(leftObject.confidence, rightObject.confidence), // Use higher confidence
        reasoning: `Detected in both hands with ${Math.round(Math.max(leftObject.confidence, rightObject.confidence) * 100)}% confidence`
      });
    } else {
      // Different objects or only one hand has an object
      if (leftObject) {
        symbols.push({
          id: `detected_left_${leftObject.id}`,
          label: leftObject.label,
          emoji: leftObject.emoji,
          confidence: leftObject.confidence,
          reasoning: `Detected in left hand with ${Math.round(leftObject.confidence * 100)}% confidence`
        });
      }
      
      if (rightObject) {
        symbols.push({
          id: `detected_right_${rightObject.id}`,
          label: rightObject.label,
          emoji: rightObject.emoji,
          confidence: rightObject.confidence,
          reasoning: `Detected in right hand with ${Math.round(rightObject.confidence * 100)}% confidence`
        });
      }
    }
    
    return symbols;
  };

  const detectedObjectSymbols = getDetectedObjectSymbols();
  
  // Determine which symbols to display
  // If both hands have objects, show only detected objects (deduplicated)
  // If one hand has object, add it to regular suggestions
  // If no objects, show regular suggestions
  const finalSymbols = (() => {
    const regularSymbols = suggestions?.suggestions || [];
    
    if (detectedObjects?.left && detectedObjects?.right) {
      // Both hands have objects - show only detected objects (automatically deduplicated)
      return detectedObjectSymbols;
    } else if (detectedObjectSymbols.length > 0) {
      // One hand has object - add to beginning of regular suggestions
      return [...detectedObjectSymbols, ...regularSymbols];
    } else {
      // No objects detected - show regular suggestions
      return regularSymbols;
    }
  })();

  // Manual symbol refresh with 60-second cooldown
  const [lastSymbolRefresh, setLastSymbolRefresh] = useState<number>(0);
  
  const refreshSymbolsIfNeeded = () => {
    const now = Date.now();
    if (now - lastSymbolRefresh >= 60000) { // 60 second minimum delay
      setLastSymbolRefresh(now);
      refetchSuggestions();
      console.log("Refreshing symbols after 60-second delay");
    }
  };

  // Force refresh when language changes
  useEffect(() => {
    if (contextData) {
      console.log(`Language changed to: ${language}, refreshing symbols`);
      refetchSuggestions();
    }
  }, [language, refetchSuggestions]);

  // Visual analysis mutation
  // Helper function to capture frame from any camera stream
  const captureFromStream = async (stream: MediaStream): Promise<Blob | null> => {
    try {
      const video = document.createElement('video');
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      if (!ctx) return null;

      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;

      return new Promise((resolve) => {
        const cleanup = () => {
          video.pause();
          video.srcObject = null;
          video.remove();
          canvas.remove();
        };

        video.addEventListener('loadedmetadata', () => {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          
          video.addEventListener('canplay', () => {
            try {
              ctx.drawImage(video, 0, 0);
              canvas.toBlob((blob) => {
                cleanup();
                resolve(blob);
              }, 'image/jpeg', 0.8);
            } catch (drawError) {
              console.error("Error drawing video frame:", drawError);
              cleanup();
              resolve(null);
            }
          }, { once: true });
        }, { once: true });

        video.addEventListener('error', (err) => {
          console.error("Video element error:", err);
          cleanup();
          resolve(null);
        });

        video.play().catch(err => {
          console.error("Video play error:", err);
          cleanup();
          resolve(null);
        });
      });
    } catch (err) {
      console.error("Frame capture error:", err);
      return null;
    }
  };

  const visualAnalysisMutation = useMutation({
    mutationFn: async ({ frame, camera }: { frame: Blob; camera: any }) => {
      const formData = new FormData();
      formData.append('image', frame);
      formData.append('cameraType', camera.facing);
      formData.append('deviceLabel', camera.label);
      return apiRequest("POST", "/api/analyze-image", formData);
    },
    onSuccess: async (response) => {
      const { analysis } = await response.json();
      updateContext(analysis);
    },
  });

  // Multi-camera person detection - try ALL cameras for user detection
  const multiCameraPersonDetection = useMutation({
    mutationFn: async () => {
      const userProfile = queryClient.getQueryData(["/api/students", studentId]) as any;
      const expectedAge = userProfile?.age || 46;
      const expectedGender = userProfile?.gender || 'male';
      
      console.log('Starting multi-camera person detection on ALL cameras...');
      
      // Try all active cameras for person detection
      const detectionPromises = cameras
        .filter(camera => camera.isActive && camera.stream)
        .map(async camera => {
          try {
            console.log(`🎥 Attempting capture from camera: ${camera.label} (${camera.facing})`);
            const frame = await captureFromStream(camera.stream!);
            if (!frame) {
              console.log(`❌ No frame captured from ${camera.label}`);
              return null;
            }
            
            console.log(`✅ Frame captured from ${camera.label}: ${frame.size} bytes`);
            
            const formData = new FormData();
            formData.append('image', frame);
            formData.append('expectedAge', expectedAge.toString());
            formData.append('expectedGender', expectedGender);
            formData.append('cameraType', camera.facing);
            formData.append('deviceLabel', camera.label);
            
            console.log(`📤 Sending person detection request from ${camera.facing} camera: ${camera.label}`);
            const response = await apiRequest("POST", "/api/detect-person", formData);
            console.log(`📥 Response received from ${camera.label}`);
            return response;
          } catch (error) {
            console.error(`❌ Person detection failed for camera ${camera.label}:`, error);
            return null;
          }
        });
      
      const results = await Promise.all(detectionPromises);
      return results.filter(result => result !== null);
    },
    onSuccess: async (responses) => {
      console.log(`📊 Processing ${responses.length} camera responses`);
      
      // Process all responses and log results
      for (let i = 0; i < responses.length; i++) {
        const response = responses[i];
        if (response) {
          const detection = await response.json();
          console.log(`📋 Camera ${i + 1} detection result:`, {
            cameraLabel: detection.deviceLabel || 'Unknown',
            cameraType: detection.cameraType,
            personPresent: detection.personPresent,
            isMainUser: detection.isMainUser,
            confidence: detection.confidence
          });
          
          // If we found the main user, highlight it
          if (detection.isMainUser) {
            console.log('🎯 MAIN USER DETECTED!', {
              camera: detection.deviceLabel || detection.cameraType,
              age: detection.detectedAge,
              gender: detection.detectedGender,
              expression: detection.facialExpression,
              confidence: detection.confidence
            });
          } else if (detection.personPresent) {
            console.log('👤 Person detected but not main user on:', detection.deviceLabel || detection.cameraType);
          } else {
            console.log('🚫 No person detected on:', detection.deviceLabel || detection.cameraType);
          }
        }
      }
    },
  });

  // Update context and refresh suggestions with controlled timing
  const updateContext = (visualContext?: string) => {
    const newContext = {
      time: (envContext as any)?.time || "Loading...",
      location: "Home", // Could be enhanced with geolocation
      visualContext: visualContext || "Indoor environment", // Provide fallback
      userProfile: userProfile ? {
        name: (userProfile as any).name,
        age: (userProfile as any).age,
        preferences: (userProfile as any).preferences,
      } : undefined,
    };
    
    console.log("Updating context data:", newContext);
    setContextData(newContext);
    
    // Only refresh symbols if enough time has passed
    if (visualContext) {
      refreshSymbolsIfNeeded();
    }
  };

  // Initialize context immediately and then analyze visual context periodically
  useEffect(() => {
    if (!envContext) {
      console.log("Waiting for environment context...");
      return;
    }

    return;
    
    // Initialize with basic context immediately to trigger symbol loading
    console.log("Initializing context for symbol loading...");
    updateContext("Basic indoor environment");
    
    const analyzeVisualContext = async () => {
      try {
        // First, try multi-camera person detection if we have multiple cameras
        if (cameras.length > 0) {
          console.log(`🚀 Starting analysis with ${cameras.length} available cameras:`, 
            cameras.map(c => `${c.label} (${c.facing}) - Active: ${c.isActive}`));
          multiCameraPersonDetection.mutate();
          
          // Also analyze scene from all cameras for context
          const activeCameras = cameras.filter(camera => camera.isActive && camera.stream);
          if (activeCameras.length > 0) {
            console.log(`Analyzing scene from ${activeCameras.length} active cameras`);
            
            // Use the first available camera for scene analysis (could be enhanced to combine multiple)
            const primaryCamera = activeCameras[0];
            const frame = await captureFromStream(primaryCamera.stream!);
            if (frame && frame.size > 0) {
              console.log(`Captured frame from ${primaryCamera.label} for scene analysis, size:`, frame.size);
              visualAnalysisMutation.mutate({ frame, camera: primaryCamera });
            }
          }
        } else {
          // Fallback to single camera approach
          const frame = await captureFrame();
          if (frame && frame.size > 0) {
            console.log("Captured frame for analysis, size:", frame.size);
            // Create a fallback camera object for single camera mode
            const fallbackCamera = { facing: 'unknown', label: 'Default Camera' };
            visualAnalysisMutation.mutate({ frame, camera: fallbackCamera });
          } else {
            console.log("No valid frame captured, keeping existing context");
          }
        }
      } catch (error) {
        console.error("Error in multi-camera analysis:", error);
        // Fallback to single camera on error
        try {
          const frame = await captureFrame();
          if (frame && frame.size > 0) {
            const fallbackCamera = { facing: 'unknown', label: 'Default Camera' };
            visualAnalysisMutation.mutate({ frame, camera: fallbackCamera });
          }
        } catch (fallbackError) {
          console.error("Fallback analysis also failed:", fallbackError);
        }
      }
    };

    // Wait a bit for camera to initialize, then start analysis
    const initTimeout = setTimeout(() => {
      analyzeVisualContext();
    }, 3000);

    // Update visual context every 45 seconds (but symbols only refresh every 60 seconds due to cooldown)
    const interval = setInterval(analyzeVisualContext, 45000);

    return () => {
      clearTimeout(initTimeout);
      clearInterval(interval);
    };
  }, [envContext, userProfile]);

  // Clear all timers when component unmounts
  useEffect(() => {
    return () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [timeoutId]);

  const processSymbolPhrase = async (symbolsToProcess?: Array<{ label: string; emoji: string }>) => {
    const symbolsArray = symbolsToProcess || selectedSymbols;
    
    console.log("Processing symbol phrase:", symbolsArray.map(s => s.label));
    
    if (symbolsArray.length === 0) return;
    
    // If we have multiple symbols, use the interpretSymbolSequence endpoint
    if (symbolsArray.length > 1) {
      try {
        const symbols = symbolsArray.map(s => s.label);
        const response = await apiRequest("POST", "/api/interpret", {
          symbols,
          context: contextData,
        });
        const { interpretation } = await response.json();
        
        console.log("Symbol interpretation result:", interpretation);
        
        // Send the interpreted phrase
        onSymbolSelect({
          label: interpretation,
          emoji: symbolsArray.map(s => s.emoji).join(' '),
        });
      } catch (error) {
        console.error("Failed to interpret symbol sequence:", error);
        // Fallback: send symbols joined together
        onSymbolSelect({
          label: symbolsArray.map(s => s.label).join(' '),
          emoji: symbolsArray.map(s => s.emoji).join(' '),
        });
      }
    } else {
      // Single symbol, send directly
      onSymbolSelect(symbolsArray[0]);
    }
    
    // Clear selected symbols
    setSelectedSymbols([]);
    setCountdown(0);
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  };

  const handleSymbolClick = (symbol: Symbol) => {
    // Add symbol to phrase (max 3 symbols)
    const newSymbols = [...selectedSymbols, { label: symbol.label, emoji: symbol.emoji }];
    
    console.log("Symbol clicked:", symbol.label, "Total symbols now:", newSymbols.length);
    
    if (newSymbols.length > 3) {
      console.log("Maximum symbols reached, ignoring click");
      return; // Don't add more than 3 symbols
    }
    
    setSelectedSymbols(newSymbols);
    
    // Clear existing timeout
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
    }
    
    // If we have 3 symbols, process immediately with the new symbols array
    if (newSymbols.length === 3) {
      console.log("3 symbols reached, processing immediately:", newSymbols.map(s => s.label));
      processSymbolPhrase(newSymbols);
      return;
    }
    
    // Get user's timeout setting (default 20 seconds)
    const userTimeout = (userProfile as any)?.symbolPhraseTimeout || 20;
    setCountdown(userTimeout);
    
    // Start countdown
    countdownRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          if (countdownRef.current) {
            clearInterval(countdownRef.current);
            countdownRef.current = null;
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    
    // Set timeout to process symbols (using closure to capture current symbols)
    const newTimeoutId = setTimeout(() => {
      console.log("Timeout reached, processing symbols:", newSymbols.map(s => s.label));
      processSymbolPhrase(newSymbols);
    }, userTimeout * 1000);
    
    setTimeoutId(newTimeoutId);
  };

  // Get finalSymbols from the existing object detection hook (defined earlier in component)

  // Eyegaze selection functionality
  const handleEyegazeSelect = (elementId: string) => {
    // Extract symbol data from elementId (format: "symbol-{id}")
    if (elementId.startsWith('symbol-')) {
      const symbolId = elementId.replace('symbol-', '');
      const symbol = finalSymbols.find((s: any) => s.id === symbolId);
      if (symbol) {
        console.log('👀 Eyegaze selected symbol:', symbol.label);
        handleSymbolClick(symbol);
      }
    }
  };

  const { state: eyegazeState, handleMouseEnter, handleMouseLeave } = useEyegazeSelection(
    {
      enabled: (userProfile as any)?.eyegazeEnabled || false,
      timeout: (userProfile as any)?.eyegazeTimeout || 3000,
    },
    handleEyegazeSelect
  );

  const displaySymbols = finalSymbols || [];

  return (
    <>
      {/* Eyegaze cursor indicator */}
      <EyegazeCursor 
        eyegazeState={eyegazeState} 
        timeout={(userProfile as any)?.eyegazeTimeout || 3000} 
      />
      
      <div className="flex flex-col items-center justify-center p-6 h-full">
      {/* Detected Objects from Two-Handed Detection - only show in debug mode */}
      {debugMode && detectedObjects && (detectedObjects.left || detectedObjects.right) && (
        <motion.div 
          className="mb-6 p-4 bg-green-50 dark:bg-green-900/20 rounded-xl border-2 border-green-200 dark:border-green-700"
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <div className="text-center text-sm font-semibold text-green-800 dark:text-green-200 mb-3">
            🤲 Objects Detected in Your Hands
          </div>
          <div className="flex justify-center items-center space-x-8">
            {/* Left Hand */}
            <div className="flex flex-col items-center">
              <div className="text-xs text-gray-600 dark:text-gray-400 mb-2">Left Hand</div>
              {detectedObjects.left ? (
                <motion.button
                  onClick={() => onSymbolSelect({ 
                    label: detectedObjects.left!.label, 
                    emoji: detectedObjects.left!.emoji 
                  })}
                  className="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-md border-2 border-green-300 hover:border-green-400 transition-colors cursor-pointer"
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                >
                  <div className="text-3xl">{detectedObjects.left.emoji}</div>
                  <div className="text-sm font-medium mt-1">{detectedObjects.left.label}</div>
                  <div className="text-xs text-gray-500">{Math.round(detectedObjects.left.confidence * 100)}%</div>
                </motion.button>
              ) : (
                <div className="w-20 h-20 bg-gray-100 dark:bg-gray-700 rounded-xl flex items-center justify-center text-gray-400">
                  <span className="text-xs">Empty</span>
                </div>
              )}
            </div>
            
            {/* Right Hand */}
            <div className="flex flex-col items-center">
              <div className="text-xs text-gray-600 dark:text-gray-400 mb-2">Right Hand</div>
              {detectedObjects.right ? (
                <motion.button
                  onClick={() => onSymbolSelect({ 
                    label: detectedObjects.right!.label, 
                    emoji: detectedObjects.right!.emoji 
                  })}
                  className="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-md border-2 border-green-300 hover:border-green-400 transition-colors cursor-pointer"
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                >
                  <div className="text-3xl">{detectedObjects.right.emoji}</div>
                  <div className="text-sm font-medium mt-1">{detectedObjects.right.label}</div>
                  <div className="text-xs text-gray-500">{Math.round(detectedObjects.right.confidence * 100)}%</div>
                </motion.button>
              ) : (
                <div className="w-20 h-20 bg-gray-100 dark:bg-gray-700 rounded-xl flex items-center justify-center text-gray-400">
                  <span className="text-xs">Empty</span>
                </div>
              )}
            </div>
          </div>
          <div className="text-center text-xs text-green-600 dark:text-green-300 mt-3">
            Click detected objects to select them as symbols
          </div>
        </motion.div>
      )}

      {/* Symbol phrase builder indicator - only show in debug mode */}
      {debugMode && selectedSymbols.length > 0 && (
        <motion.div 
          className="mb-6 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-xl border-2 border-blue-200 dark:border-blue-700"
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <div className="flex items-center justify-center space-x-2 mb-2">
            {selectedSymbols.map((symbol, index) => (
              <div key={index} className="flex items-center">
                <span className="text-2xl">{symbol.emoji}</span>
                <span className="ml-1 font-semibold">{symbol.label}</span>
                {index < selectedSymbols.length - 1 && (
                  <span className="mx-2 text-gray-400">→</span>
                )}
              </div>
            ))}
          </div>
          <div className="text-center text-sm text-gray-600 dark:text-gray-300">
            {countdown > 0 ? (
              <>Processing in {countdown}s... (Select {3 - selectedSymbols.length} more or wait)</>
            ) : (
              <>Building phrase... ({selectedSymbols.length}/3)</>
            )}
          </div>
        </motion.div>
      )}
      
      {/* Check if user has parts of speech coloring enabled */}
      {userProfile && (userProfile as any).partsOfSpeechColors ? (
        /* Parts of Speech organized columns */
        <div className="w-full max-w-7xl">
          {(() => {
            const organizedSymbols = organizeSymbolsByPartOfSpeech(
              displaySymbols, 
              (userProfile as any).partsOfSpeechOrdering || 'english'
            );
            
            return (
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 w-full justify-items-center">
                {organizedSymbols.flatMap(({ partOfSpeech, symbols }) => 
                  symbols.map((symbol: any, index: number) => {
                    const partOfSpeechType = detectPartOfSpeech(symbol.label);
                    const borderColor = getPartOfSpeechColor(partOfSpeechType, false);
                    
                    return (
                      <motion.div
                        key={symbol.id}
                        className="symbol-item bg-symbol-bg rounded-3xl shadow-lg p-3 flex flex-col items-center justify-center cursor-pointer aspect-square w-full max-w-[140px] touch-manipulation relative"
                          style={{ 
                            borderWidth: '3px',
                            borderStyle: 'solid',
                            borderColor: borderColor
                          }}
                          initial={{ opacity: 0, scale: 0.8 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ delay: index * 0.1 }}
                          whileHover={{ 
                            scale: 1.05, 
                            boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1)",
                            borderColor: getPartOfSpeechColor(partOfSpeechType, true)
                          }}
                          whileTap={{ scale: 0.98 }}
                          onClick={() => handleSymbolClick(symbol)}
                          onMouseEnter={() => handleMouseEnter(`symbol-${symbol.id}`)}
                          onMouseLeave={handleMouseLeave}
                        >
                          {/* Eyegaze progress indicator */}
                          {eyegazeState.hoveredElement === `symbol-${symbol.id}` && eyegazeState.isSelecting && (
                            <div className="absolute inset-0 rounded-3xl overflow-hidden">
                              <div 
                                className="absolute top-0 left-0 h-full bg-blue-500/30 transition-all duration-75 ease-linear"
                                style={{ width: `${eyegazeState.progress}%` }}
                              />
                              <div className="absolute inset-0 border-4 border-blue-500 rounded-3xl" />
                              <div className="absolute top-2 right-2 bg-blue-500 text-white text-xs px-2 py-1 rounded-full">
                                {Math.round((100 - eyegazeState.progress) / 100 * ((userProfile as any)?.eyegazeTimeout || 3000) / 1000 * 10) / 10}s
                              </div>
                            </div>
                          )}
                          <div className="text-4xl mb-1">{symbol.emoji}</div>
                          <span className="text-sm font-semibold text-text-primary text-center leading-tight">
                            {symbol.label}
                          </span>
                        </motion.div>
                      );
                    })
                )}
              </div>
            );
          })()}
        </div>
      ) : (
        /* Traditional grid layout */
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 w-full justify-items-center">
          {displaySymbols.map((symbol: Symbol, index: number) => (
            <motion.div
              key={symbol.id}
              className="symbol-item bg-symbol-bg rounded-3xl shadow-lg border-2 border-gray-100 p-3 flex flex-col items-center justify-center cursor-pointer aspect-square w-full max-w-[140px] touch-manipulation relative"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: index * 0.1 }}
              whileHover={{ scale: 1.05, boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1)" }}
              whileTap={{ scale: 0.98 }}
              onClick={() => handleSymbolClick(symbol)}
              onMouseEnter={() => handleMouseEnter(`symbol-${symbol.id}`)}
              onMouseLeave={handleMouseLeave}
            >
              {/* Eyegaze progress indicator */}
              {eyegazeState.hoveredElement === `symbol-${symbol.id}` && eyegazeState.isSelecting && (
                <div className="absolute inset-0 rounded-3xl overflow-hidden">
                  <div 
                    className="absolute top-0 left-0 h-full bg-blue-500/30 transition-all duration-75 ease-linear"
                    style={{ width: `${eyegazeState.progress}%` }}
                  />
                  <div className="absolute inset-0 border-4 border-blue-500 rounded-3xl" />
                  <div className="absolute top-2 right-2 bg-blue-500 text-white text-xs px-2 py-1 rounded-full">
                    {Math.round((100 - eyegazeState.progress) / 100 * ((userProfile as any)?.eyegazeTimeout || 3000) / 1000 * 10) / 10}s
                  </div>
                </div>
              )}
              <div className="text-4xl mb-1">{symbol.emoji}</div>
              <span className="text-sm font-semibold text-text-primary text-center leading-tight">
                {symbol.label}
              </span>
            </motion.div>
          ))}
        </div>
      )}
      
      {/* Show loading state if no symbols or symbols are refreshing */}
      {(displaySymbols.length === 0) && (
        <div className="flex items-center justify-center py-20 w-full">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4" />
            <p className="text-text-secondary">
              {suggestionsLoading 
                ? "Loading communication symbols..." 
                : suggestionsError 
                ? "Error loading symbols - retrying..."
                : !contextData
                ? "Preparing symbol context..."
                : "Loading communication symbols..."
              }
            </p>
            {suggestionsError && (
              <p className="text-red-500 text-xs mt-2">
                {(suggestionsError as Error).message}
              </p>
            )}
          </div>
        </div>
      )}
      
      {/* Object Detection Status - only show in debug mode */}
      {debugMode && isDetecting && (
        <motion.div 
          className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-700"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <div className="flex items-center justify-center space-x-2">
            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
            <span className="text-sm text-blue-700 dark:text-blue-300">Detecting objects in hands...</span>
          </div>
        </motion.div>
      )}

      {/* Show source of symbols - only show in debug mode */}
      {debugMode && hasDetectedObjects && (
        <motion.div 
          className="mb-4 p-2 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-700"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <div className="text-center text-xs text-green-700 dark:text-green-300">
            🤲 Showing detected objects as symbols
          </div>
        </motion.div>
      )}

      {/* Show refresh indicator when symbols are being refreshed but we have existing ones */}
      {suggestionsLoading && displaySymbols.length > 0 && (
        <div className="flex items-center justify-center py-4 w-full">
          <div className="bg-primary/10 rounded-full px-4 py-2 flex items-center space-x-2">
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary" />
            <span className="text-primary text-sm">Refreshing symbols...</span>
          </div>
        </div>
      )}
      
      {/* Context hint */}
      {contextData && (
        <motion.div 
          className="absolute bottom-6 left-1/2 transform -translate-x-1/2 text-text-secondary text-sm opacity-60"
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.6 }}
        >
          <span>{new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })} • {contextData.location}</span>
        </motion.div>
      )}
      </div>
    </>
  );
}
