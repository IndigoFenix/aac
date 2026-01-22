import { VertexAI, HarmCategory, HarmBlockThreshold } from '@google-cloud/vertexai';

// Initialize Vertex AI with service account authentication
let vertex_ai: VertexAI;
let isVertexAiConfigured = false;

try {
  // Parse the service account JSON from environment variable
  const serviceAccountKey = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  console.log('Vertex AI credentials available:', !!serviceAccountKey);
  
  if (serviceAccountKey) {
    console.log('Raw credentials length:', serviceAccountKey.length);
    console.log('Raw credentials preview:', serviceAccountKey.substring(0, 100));
    
    try {
      // Clean the JSON string - remove any extra quotes or whitespace
      const cleanKey = serviceAccountKey.trim().replace(/^"/, '').replace(/"$/, '');
      
      // Check if it looks like valid JSON
      if (!cleanKey.startsWith('{')) {
        throw new Error('Credentials do not appear to be valid JSON - missing opening brace');
      }
      
      const credentials = JSON.parse(cleanKey);
      
      if (!credentials.project_id || !credentials.private_key || !credentials.client_email) {
        throw new Error('Invalid service account JSON - missing required fields');
      }
      
      console.log('Vertex AI project ID:', credentials.project_id);
      
      vertex_ai = new VertexAI({
        project: credentials.project_id,
        location: 'us-central1',
        googleAuthOptions: {
          credentials: credentials,
        }
      });
      isVertexAiConfigured = true;
      console.log('Vertex AI configured successfully with service account');
      
    } catch (parseError) {
      throw new Error(`Failed to parse service account JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
    }
  } else {
    console.log('No Vertex AI credentials found, will use fallback services');
    throw new Error('No service account credentials available');
  }
} catch (error) {
  console.error('Error initializing Vertex AI:', error);
  isVertexAiConfigured = false;
  // Create a dummy vertex_ai to prevent undefined errors
  vertex_ai = {
    preview: {
      getGenerativeModel: () => {
        throw new Error('Vertex AI not configured');
      }
    }
  } as any;
}

const model = 'gemini-2.5-flash';

// Function to get the generative model (only when vertex_ai is configured)
function getGenerativeModel() {
  if (!isVertexAiConfigured || !vertex_ai) {
    throw new Error('Vertex AI not configured');
  }
  
  return vertex_ai.preview.getGenerativeModel({
    model: model,
    generationConfig: {
      maxOutputTokens: 8192,
      temperature: 1,
      topP: 0.95,
    },
    safetySettings: [
      {
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE
      },
      {
        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE
      },
      {
        category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE
      },
      {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE
      }
    ],
  });
}

export async function analyzeVideoWithVertex(imageBuffer: Buffer): Promise<string> {
  if (!isVertexAiConfigured) {
    throw new Error('Vertex AI not properly configured - missing service account credentials');
  }
  
  try {
    console.log('Starting Vertex AI video analysis...');
    
    const imagePart = {
      inlineData: {
        mimeType: 'image/jpeg',
        data: imageBuffer.toString('base64')
      }
    };

    const textPart = {
      text: `Analyze this video frame in detail. Describe:
      1. What people are doing and their approximate age/gender, including facial expressions and emotional state
      2. The environment and setting (indoor/outdoor, room type, objects)
      3. Activities happening in the scene
      4. Time of day indicators (lighting, shadows)
      5. Any notable objects or interactions
      6. Facial expressions visible: happy, sad, excited, calm, focused, surprised, worried, tired, neutral, frustrated, etc.
      
      Provide a comprehensive but concise description suitable for contextual understanding of the scene, including the emotional context from facial expressions.`
    };

    const request = {
      contents: [{ role: 'user', parts: [textPart, imagePart] }],
    };

    const generativeModel = getGenerativeModel();
    const result = await generativeModel.generateContent(request);
    const response = await result.response;
    
    if (response.candidates && response.candidates[0]?.content?.parts?.[0]?.text) {
      const analysis = response.candidates[0].content.parts[0].text;
      console.log('Vertex AI analysis completed successfully');
      return analysis;
    } else {
      console.log('No analysis content returned from Vertex AI');
      return 'Video analysis completed but no content returned';
    }
    
  } catch (error) {
    console.error('Error with Vertex AI video analysis:', error);
    throw error;
  }
}

export async function analyzeObjectsInHandsWithVertex(imageBuffer: Buffer): Promise<string> {
  if (!isVertexAiConfigured) {
    throw new Error('Vertex AI not properly configured - missing service account credentials');
  }
  
  try {
    console.log('Starting Vertex AI object detection...');
    
    const imagePart = {
      inlineData: {
        mimeType: 'image/jpeg',
        data: imageBuffer.toString('base64')
      }
    };

    const textPart = {
      text: `Analyze this image to detect objects being held in each hand. 

IMPORTANT: Look specifically for objects being held in the person's hands. Be very precise about left vs right hand positioning from the person's perspective (not camera perspective).

For playing cards:
* Use specific card values: "Ace", "King", "Queen", "Jack", "2", "3", "4", "5", "6", "7", "8", "9", "10"
* Include suit when visible: "hearts", "spades", "diamonds", "clubs"
* Examples: "Ace of hearts", "King of spades", "Queen", "Jack"

For letters or alphabet cards:
* Use the letter itself as the label: "A", "B", "Z", "a", "b", "z"
* For Hebrew letters, use the Hebrew character: "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י", "כ", "ל", "מ", "נ", "ס", "ע", "פ", "צ", "ק", "ר", "ש", "ת"

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

RESPOND ONLY WITH JSON - NO OTHER TEXT.`
    };

    const request = {
      contents: [{ role: 'user', parts: [textPart, imagePart] }],
    };

    const generativeModel = getGenerativeModel();
    const result = await generativeModel.generateContent(request);
    const response = await result.response;
    
    if (response.candidates && response.candidates[0]?.content?.parts?.[0]?.text) {
      const analysis = response.candidates[0].content.parts[0].text;
      console.log('Vertex AI object detection completed successfully');
      return analysis;
    } else {
      console.log('No object detection content returned from Vertex AI');
      return '{"leftHandObject": null, "rightHandObject": null, "detectionConfidence": 0, "timestamp": ' + Date.now() + '}';
    }
    
  } catch (error) {
    console.error('Error with Vertex AI object detection:', error);
    throw error;
  }
}

export async function detectPersonWithVertex(
  imageBuffer: Buffer, 
  expectedAge?: number, 
  expectedGender?: string
): Promise<{
  personPresent: boolean;
  isMainUser: boolean;
  detectedAge?: number;
  detectedGender?: string;
  facialExpression?: string;
  emotionalState?: string;
  confidence: number;
}> {
  if (!isVertexAiConfigured) {
    throw new Error('Vertex AI not properly configured - missing service account credentials');
  }
  
  try {
    console.log('Starting Vertex AI person detection...');
    
    const imagePart = {
      inlineData: {
        mimeType: 'image/jpeg',
        data: imageBuffer.toString('base64')
      }
    };

    const textPart = {
      text: `Analyze this image for person detection and facial expressions. Respond in JSON format only with:
      {
        "personPresent": boolean,
        "detectedAge": number (approximate age if person present),
        "detectedGender": "male" | "female" | "unknown",
        "facialExpression": "happy" | "sad" | "excited" | "calm" | "focused" | "surprised" | "worried" | "tired" | "neutral" | "frustrated" | "unknown",
        "emotionalState": string (brief description of overall emotional state),
        "confidence": number (0-1)
      }
      
      Expected person profile: Age ${expectedAge || 'unknown'}, Gender ${expectedGender || 'unknown'}
      
      Analyze facial expressions carefully - look for:
      - Mouth position: upturned corners (happy/excited), downturned corners (sad/worried), neutral line (calm/focused)
      - Eye expression: bright and crinkled (happy), droopy or teary (sad), wide open (surprised), tired/heavy (tired), focused/intent (focused)
      - Eyebrow position: raised (surprised/excited), furrowed/lowered (frustrated/worried/focused), relaxed (calm/neutral)
      - Overall facial tension: relaxed (happy/calm), tense (frustrated/worried), slumped (sad/tired)
      
      Key indicators:
      - HAPPY: Genuine smile (mouth corners up, eye crinkles), bright eyes, relaxed forehead
      - SAD: Mouth corners down, droopy eyes, possible frown lines, overall deflated appearance
      - EXCITED: Wide smile, bright wide eyes, raised eyebrows, animated expression
      - CALM: Relaxed features, soft eyes, neutral mouth, no tension
      - FOCUSED: Intent gaze, slight frown of concentration, mouth neutral or slightly open
      
      Determine if the detected person matches the expected profile (within reasonable age range ±5 years).`
    };

    const request = {
      contents: [{ role: 'user', parts: [textPart, imagePart] }],
    };

    const generativeModel = getGenerativeModel();
    const result = await generativeModel.generateContent(request);
    const response = await result.response;
    
    if (response.candidates && response.candidates[0]?.content?.parts?.[0]?.text) {
      const responseText = response.candidates[0].content.parts[0].text;
      
      try {
        // Clean up response text - remove markdown code blocks if present
        let cleanText = responseText.replace(/```json\s*/, '').replace(/```\s*$/, '').trim();
        const parsed = JSON.parse(cleanText);
        
        // Determine if this is the main user based on age/gender matching
        let isMainUser = false;
        if (parsed.personPresent && expectedAge && expectedGender) {
          const ageMatch = Math.abs(parsed.detectedAge - expectedAge) <= 5;
          const genderMatch = parsed.detectedGender.toLowerCase() === expectedGender.toLowerCase();
          isMainUser = ageMatch && genderMatch;
        }
        
        return {
          personPresent: parsed.personPresent,
          isMainUser,
          detectedAge: parsed.detectedAge,
          detectedGender: parsed.detectedGender,
          facialExpression: parsed.facialExpression,
          emotionalState: parsed.emotionalState,
          confidence: parsed.confidence
        };
        
      } catch (parseError) {
        console.error('Error parsing Vertex AI person detection response:', parseError);
        return {
          personPresent: false,
          isMainUser: false,
          confidence: 0
        };
      }
    } else {
      console.log('No person detection content returned from Vertex AI');
      return {
        personPresent: false,
        isMainUser: false,
        confidence: 0
      };
    }
    
  } catch (error) {
    console.error('Error with Vertex AI person detection:', error);
    throw error;
  }
}

// Function to detect and interpret sign language in video frame
// Now uses SignGemma as primary, Vertex AI as fallback
export async function detectSignLanguage(videoData: Buffer): Promise<{
  signLanguageDetected: boolean;
  interpretation?: string;
  confidence: number;
}> {
  if (!isVertexAiConfigured) {
    throw new Error('Vertex AI not configured for sign language detection');
  }

  try {
    console.log('Starting Vertex AI sign language detection...');
    
    const imagePart = {
      inlineData: {
        data: videoData.toString('base64'),
        mimeType: 'image/jpeg',
      },
    };

    const textPart = {
      text: `Analyze this image for sign language gestures. Look carefully for:

1. Hand positions and gestures
2. Finger configurations 
3. Hand movements or positions that could be sign language
4. Facial expressions that accompany sign language
5. Body positioning typical of sign language communication

Respond in JSON format only with:
{
  "signLanguageDetected": boolean,
  "interpretation": string (if signs detected, provide the meaning/translation),
  "confidence": number (0-1, confidence in detection and interpretation)
}

If no clear sign language is detected, set signLanguageDetected to false.
If sign language is detected, provide the most likely interpretation of the signs being made.
Consider common sign language gestures including:
- Letters (fingerspelling)
- Common words (hello, thank you, yes, no, etc.)
- Basic phrases
- Emotional expressions

Be conservative - only indicate sign language detection if you're reasonably confident signs are being made.`
    };

    const request = {
      contents: [{ role: 'user', parts: [textPart, imagePart] }],
    };

    const generativeModel = getGenerativeModel();
    const result = await generativeModel.generateContent(request);
    const response = await result.response;
    
    if (response.candidates && response.candidates[0]?.content?.parts?.[0]?.text) {
      const responseText = response.candidates[0].content.parts[0].text;
      
      try {
        // Clean up response text - remove markdown code blocks if present
        let cleanText = responseText.replace(/```json\s*/, '').replace(/```\s*$/, '').trim();
        const parsed = JSON.parse(cleanText);
        
        return {
          signLanguageDetected: parsed.signLanguageDetected || false,
          interpretation: parsed.interpretation || undefined,
          confidence: parsed.confidence || 0
        };
        
      } catch (parseError) {
        console.error('Error parsing Vertex AI sign language detection response:', parseError);
        return {
          signLanguageDetected: false,
          confidence: 0
        };
      }
    } else {
      console.log('No sign language detection content returned from Vertex AI');
      return {
        signLanguageDetected: false,
        confidence: 0
      };
    }
    
  } catch (error) {
    console.error('Error with Vertex AI sign language detection:', error);
    throw error;
  }
}