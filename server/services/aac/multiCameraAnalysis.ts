import { analyzeVideoWithVertex } from './vertexai';

interface CameraFrame {
  deviceId: string;
  label: string;
  facing: 'user' | 'environment' | 'unknown';
  imageData: Buffer;
}

interface MultiCameraAnalysis {
  userCamera?: {
    deviceId: string;
    analysis: string;
    personDetection: any;
    facialExpression: string;
    emotionalState: string;
  };
  environmentCamera?: {
    deviceId: string;
    analysis: string;
    sceneDescription: string;
    objects: string[];
    lighting: string;
    location: string;
  };
  combinedAnalysis: {
    overallScene: string;
    contextualSummary: string;
    recommendations: string[];
    confidence: number;
  };
  timestamp: Date;
}

export async function analyzeMultipleCameras(frames: CameraFrame[]): Promise<MultiCameraAnalysis> {
  const analysis: MultiCameraAnalysis = {
    combinedAnalysis: {
      overallScene: '',
      contextualSummary: '',
      recommendations: [],
      confidence: 0
    },
    timestamp: new Date()
  };

  try {
    // Analyze each camera separately
    const analysisPromises = frames.map(async (frame) => {
      try {
        let result;

        if (frame.facing === 'user') {
          // Focus on person detection and facial analysis for user-facing camera
          result = await analyzeVideoWithVertex(frame.imageData);

          analysis.userCamera = {
            deviceId: frame.deviceId,
            analysis: result,
            personDetection: extractPersonData(result),
            facialExpression: extractFacialExpression(result),
            emotionalState: extractEmotionalState(result)
          };

        } else if (frame.facing === 'environment') {
          // Focus on scene and environmental analysis for rear-facing camera
          result = await analyzeVideoWithVertex(frame.imageData);

          analysis.environmentCamera = {
            deviceId: frame.deviceId,
            analysis: result,
            sceneDescription: extractSceneDescription(result),
            objects: extractObjects(result),
            lighting: extractLighting(result),
            location: extractLocation(result)
          };
        }

        return { frame, analysis: result };
      } catch (error) {
        console.error(`Failed to analyze frame from ${frame.label}:`, error);
        return { frame, analysis: `Analysis failed: ${error}` };
      }
    });

    const results = await Promise.all(analysisPromises);

    // Combine analyses for comprehensive understanding
    const combinedPrompt = `
      Based on multiple camera inputs, provide a comprehensive scene analysis:

      ${analysis.userCamera ? `User Camera Analysis: ${analysis.userCamera.analysis}` : ''}
      ${analysis.environmentCamera ? `Environment Camera Analysis: ${analysis.environmentCamera.analysis}` : ''}

      Please provide:
      1. Overall scene summary combining both perspectives
      2. Contextual understanding for AAC communication
      3. Recommended communication symbols or phrases
      4. User engagement and environmental context
      5. Confidence level (0-1) in the analysis
    `;

    const combinedAnalysisResult = await analyzeVideoWithVertex(
      frames[0]?.imageData || Buffer.alloc(0)
    );

    analysis.combinedAnalysis = {
      overallScene: extractOverallScene(combinedAnalysisResult),
      contextualSummary: combinedAnalysisResult,
      recommendations: extractRecommendations(combinedAnalysisResult),
      confidence: extractConfidence(combinedAnalysisResult)
    };

    console.log('Multi-camera analysis completed:', {
      cameras: frames.length,
      userCameraActive: !!analysis.userCamera,
      environmentCameraActive: !!analysis.environmentCamera,
      confidence: analysis.combinedAnalysis.confidence
    });

    return analysis;

  } catch (error) {
    console.error('Multi-camera analysis failed:', error);

    // Return fallback analysis
    return {
      ...analysis,
      combinedAnalysis: {
        overallScene: 'Multi-camera analysis unavailable',
        contextualSummary: `Analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        recommendations: ['Check camera connections', 'Verify camera permissions'],
        confidence: 0
      }
    };
  }
}

// Helper functions to extract specific information
function extractPersonData(analysis: string): any {
  // Extract person detection data from analysis
  const ageMatch = analysis.match(/age[:\s]*(\d+)/i);
  const genderMatch = analysis.match(/gender[:\s]*(male|female|non-binary)/i);
  const presentMatch = analysis.match(/person[:\s]*(present|detected|visible)/i);

  return {
    personPresent: !!presentMatch,
    detectedAge: ageMatch ? parseInt(ageMatch[1]) : null,
    detectedGender: genderMatch ? genderMatch[1].toLowerCase() : 'unknown',
    confidence: 0.8 // Default confidence
  };
}

function extractFacialExpression(analysis: string): string {
  const expressions = ['happy', 'sad', 'focused', 'surprised', 'calm', 'tired', 'worried', 'excited'];
  const found = expressions.find(expr =>
    analysis.toLowerCase().includes(expr) ||
    analysis.toLowerCase().includes(expr.substring(0, 4))
  );
  return found || 'neutral';
}

function extractEmotionalState(analysis: string): string {
  // Extract emotional state description from analysis
  const emotionMatch = analysis.match(/emotional?\s*state[:\s]*([^.]+)/i);
  if (emotionMatch) {
    return emotionMatch[1].trim();
  }

  const moodMatch = analysis.match(/mood[:\s]*([^.]+)/i);
  if (moodMatch) {
    return moodMatch[1].trim();
  }

  return 'Neutral emotional state';
}

function extractSceneDescription(analysis: string): string {
  const sceneMatch = analysis.match(/scene[:\s]*([^.]+)/i);
  return sceneMatch ? sceneMatch[1].trim() : 'Scene description unavailable';
}

function extractObjects(analysis: string): string[] {
  const objectMatch = analysis.match(/objects?[:\s]*([^.]+)/i);
  if (objectMatch) {
    return objectMatch[1].split(/[,;]/).map(obj => obj.trim());
  }
  return [];
}

function extractLighting(analysis: string): string {
  const lightingMatch = analysis.match(/lighting[:\s]*([^.]+)/i);
  return lightingMatch ? lightingMatch[1].trim() : 'Lighting conditions unknown';
}

function extractLocation(analysis: string): string {
  const locationMatch = analysis.match(/location[:\s]*([^.]+)/i);
  return locationMatch ? locationMatch[1].trim() : 'Location unknown';
}

function extractOverallScene(analysis: string): string {
  const sceneMatch = analysis.match(/overall[:\s]*([^.]+)/i);
  return sceneMatch ? sceneMatch[1].trim() : analysis.substring(0, 200);
}

function extractRecommendations(analysis: string): string[] {
  const recMatch = analysis.match(/recommend[ed]*[:\s]*([^.]+)/i);
  if (recMatch) {
    return recMatch[1].split(/[,;]/).map(rec => rec.trim());
  }
  return [];
}

function extractConfidence(analysis: string): number {
  const confMatch = analysis.match(/confidence[:\s]*([0-9.]+)/i);
  if (confMatch) {
    const conf = parseFloat(confMatch[1]);
    return Math.min(1, Math.max(0, conf > 1 ? conf / 100 : conf));
  }
  return 0.7; // Default confidence
}
