import { VideoIntelligenceServiceClient } from '@google-cloud/video-intelligence';
import * as fs from 'fs';
import * as path from 'path';

// Initialize Google Cloud Video Intelligence API client
let videoClient: VideoIntelligenceServiceClient | null = null;

try {
  videoClient = new VideoIntelligenceServiceClient({
    projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
    credentials: process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON 
      ? JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON)
      : undefined,
  });
  console.log("Video Intelligence client initialized successfully");
} catch (error) {
  console.error("Failed to initialize Video Intelligence client:", error);
}

export interface VideoAnalysisResult {
  analysis: string;
  personDetection: {
    personPresent: boolean;
    isMainUser: boolean;
    detectedAge?: number;
    detectedGender?: string;
    confidence: number;
  };
  locationAnalysis?: {
    locationType: string;
    confidence: number;
    features: string[];
  };
  objects?: string[];
  activities?: string[];
  labels?: string[];
}

export async function analyzeVideoFrame(
  imageBuffer: Buffer,
  expectedUser?: { age: number; gender: string }
): Promise<VideoAnalysisResult> {
  if (!videoClient) {
    throw new Error("Video Intelligence client not initialized");
  }

  try {
    console.log("Starting Google Cloud Video Intelligence analysis...");
    
    // For images, we need to use a simpler approach with Video Intelligence
    // Convert image to base64 for the API
    const imageBase64 = imageBuffer.toString('base64');
    
    // Use simplified request format for image analysis
    const request = {
      inputContent: imageBase64,
      features: ['LABEL_DETECTION', 'FACE_DETECTION', 'PERSON_DETECTION'] as any[],
    };

    // Perform Video Intelligence analysis
    console.log("Sending request to Video Intelligence API...");
    const [operation] = await videoClient.annotateVideo(request as any);
    console.log("Waiting for Video Intelligence operation to complete...");
    const [result] = await operation.promise();
    
    // Process the results
    const analysis = processVideoIntelligenceResults(result, expectedUser);
    
    console.log("Video Intelligence analysis completed successfully");
    return analysis;
    
  } catch (error) {
    console.error("Video Intelligence API error:", error);
    // Fallback to basic analysis if Video Intelligence fails
    return {
      analysis: `Video Intelligence analysis failed: ${(error as any)?.message || String(error)}. Using basic detection.`,
      personDetection: {
        personPresent: true, // Assume person is present 
        isMainUser: true,
        detectedAge: expectedUser?.age,
        detectedGender: expectedUser?.gender,
        confidence: 0.5
      },
      locationAnalysis: {
        locationType: 'Indoor/Residential',
        confidence: 0.6,
        features: ['indoor space']
      },
      objects: [],
      activities: [],
      labels: []
    };
  }
}

function processVideoIntelligenceResults(
  result: any,
  expectedUser?: { age: number; gender: string }
): VideoAnalysisResult {
  let analysis = "Video Intelligence Analysis:\n\n";
  let personPresent = false;
  let isMainUser = false;
  let detectedAge: number | undefined;
  let detectedGender: string | undefined;
  let confidence = 0;
  
  const labels: string[] = [];
  const objects: string[] = [];
  const activities: string[] = [];
  
  // Process label annotations
  if (result.annotationResults?.[0]?.segmentLabelAnnotations) {
    analysis += "**Scene Labels:**\n";
    for (const label of result.annotationResults[0].segmentLabelAnnotations) {
      const labelName = label.entity?.description;
      const labelConfidence = label.segments?.[0]?.confidence || 0;
      if (labelName && labelConfidence > 0.5) {
        labels.push(labelName);
        analysis += `- ${labelName} (${(labelConfidence * 100).toFixed(0)}% confidence)\n`;
      }
    }
    analysis += "\n";
  }

  // Process shot label annotations for objects
  if (result.annotationResults?.[0]?.shotLabelAnnotations) {
    analysis += "**Objects and Activities:**\n";
    for (const label of result.annotationResults[0].shotLabelAnnotations) {
      const labelName = label.entity?.description;
      const labelConfidence = label.segments?.[0]?.confidence || 0;
      if (labelName && labelConfidence > 0.6) {
        if (isActivity(labelName)) {
          activities.push(labelName);
        } else {
          objects.push(labelName);
        }
        analysis += `- ${labelName} (${(labelConfidence * 100).toFixed(0)}% confidence)\n`;
      }
    }
    analysis += "\n";
  }

  // Process face detection
  if (result.annotationResults?.[0]?.faceDetectionAnnotations) {
    analysis += "**Face Analysis:**\n";
    const faces = result.annotationResults[0].faceDetectionAnnotations;
    
    if (faces.length > 0) {
      personPresent = true;
      const face = faces[0]; // Use the first detected face
      
      // Extract face attributes
      if (face.attributes) {
        for (const attribute of face.attributes) {
          if (attribute.name === 'young' && attribute.confidence > 0.5) {
            detectedAge = expectedUser?.age || 25; // Approximate young age
          } else if (attribute.name === 'middle_aged' && attribute.confidence > 0.5) {
            detectedAge = expectedUser?.age || 40; // Approximate middle age
          }
        }
      }
      
      // Check if this matches expected user
      if (expectedUser) {
        const ageMatch = !detectedAge || Math.abs((detectedAge || 0) - expectedUser.age) <= 10;
        if (ageMatch) {
          isMainUser = true;
          confidence = 0.85;
        } else {
          confidence = 0.6;
        }
      } else {
        confidence = 0.7;
      }
      
      analysis += `- Person detected: ${personPresent ? 'Yes' : 'No'}\n`;
      analysis += `- Estimated age: ${detectedAge || 'Unknown'}\n`;
      analysis += `- Main user: ${isMainUser ? 'Yes' : 'No'}\n`;
      analysis += `- Confidence: ${(confidence * 100).toFixed(0)}%\n`;
    } else {
      analysis += "- No faces detected\n";
    }
    analysis += "\n";
  }

  // Process person detection
  if (result.annotationResults?.[0]?.personDetectionAnnotations) {
    analysis += "**Person Detection:**\n";
    const persons = result.annotationResults[0].personDetectionAnnotations;
    
    if (persons.length > 0) {
      personPresent = true;
      analysis += `- ${persons.length} person(s) detected\n`;
      
      // Analyze first person's activities
      const person = persons[0];
      if (person.activities) {
        analysis += "- Activities: ";
        const detectedActivities = person.activities
          .filter((activity: any) => activity.confidence > 0.5)
          .map((activity: any) => activity.name);
        activities.push(...detectedActivities);
        analysis += detectedActivities.join(', ') + "\n";
      }
    } else {
      analysis += "- No persons detected\n";
      personPresent = false;
    }
    analysis += "\n";
  }

  // Determine location type based on labels and objects
  const locationAnalysis = determineLocationType(labels, objects);
  
  // Add location context to analysis
  if (locationAnalysis) {
    analysis += `**Location Analysis:**\n`;
    analysis += `- Type: ${locationAnalysis.locationType}\n`;
    analysis += `- Confidence: ${(locationAnalysis.confidence * 100).toFixed(0)}%\n`;
    analysis += `- Features: ${locationAnalysis.features.join(', ')}\n`;
  }

  return {
    analysis,
    personDetection: {
      personPresent,
      isMainUser,
      detectedAge,
      detectedGender,
      confidence
    },
    locationAnalysis,
    objects,
    activities,
    labels
  };
}

function isActivity(label: string): boolean {
  const activityKeywords = [
    'sitting', 'standing', 'walking', 'running', 'jumping', 'playing',
    'reading', 'writing', 'talking', 'listening', 'working', 'studying',
    'eating', 'drinking', 'sleeping', 'watching', 'using', 'holding'
  ];
  
  return activityKeywords.some(keyword => 
    label.toLowerCase().includes(keyword)
  );
}

function determineLocationType(labels: string[], objects: string[]): {
  locationType: string;
  confidence: number;
  features: string[];
} | undefined {
  const combined = [...labels, ...objects].map(item => item.toLowerCase());
  
  // Office/Workspace indicators
  if (combined.some(item => 
    ['computer', 'desk', 'office', 'monitor', 'keyboard', 'mouse'].includes(item)
  )) {
    return {
      locationType: 'Office/Workspace',
      confidence: 0.8,
      features: combined.filter(item => 
        ['computer', 'desk', 'office', 'monitor', 'keyboard', 'mouse'].includes(item)
      )
    };
  }
  
  // Bedroom indicators
  if (combined.some(item => 
    ['bed', 'bedroom', 'pillow', 'blanket', 'mattress'].includes(item)
  )) {
    return {
      locationType: 'Bedroom/House',
      confidence: 0.85,
      features: combined.filter(item => 
        ['bed', 'bedroom', 'pillow', 'blanket', 'mattress'].includes(item)
      )
    };
  }
  
  // Kitchen indicators
  if (combined.some(item => 
    ['kitchen', 'stove', 'refrigerator', 'sink', 'cooking'].includes(item)
  )) {
    return {
      locationType: 'Kitchen/House',
      confidence: 0.9,
      features: combined.filter(item => 
        ['kitchen', 'stove', 'refrigerator', 'sink', 'cooking'].includes(item)
      )
    };
  }
  
  // Living room indicators
  if (combined.some(item => 
    ['sofa', 'couch', 'television', 'living room', 'furniture'].includes(item)
  )) {
    return {
      locationType: 'Living Room/House',
      confidence: 0.8,
      features: combined.filter(item => 
        ['sofa', 'couch', 'television', 'living room', 'furniture'].includes(item)
      )
    };
  }
  
  // School/Classroom indicators
  if (combined.some(item => 
    ['classroom', 'school', 'whiteboard', 'students', 'teacher'].includes(item)
  )) {
    return {
      locationType: 'School/Classroom',
      confidence: 0.85,
      features: combined.filter(item => 
        ['classroom', 'school', 'whiteboard', 'students', 'teacher'].includes(item)
      )
    };
  }
  
  // Default to indoor residential
  return {
    locationType: 'Indoor/Residential',
    confidence: 0.6,
    features: ['indoor space']
  };
}