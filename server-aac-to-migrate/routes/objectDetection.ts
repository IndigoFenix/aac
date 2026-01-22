import { Router } from 'express';
import multer from 'multer';
import { analyzeVideoWithVertex } from '../services/vertexai';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

interface DetectedObject {
  id: string;
  label: string;
  emoji: string;
  confidence: number;
  hand: 'left' | 'right';
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

interface TwoHandedDetectionResult {
  leftHandObject: DetectedObject | null;
  rightHandObject: DetectedObject | null;
  detectionConfidence: number;
  timestamp: number;
}

// Detect objects being held in both hands
router.post('/detect-objects-in-hands', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image provided' });
    }

    console.log('Two-handed object detection request received');
    
    const imageBuffer = req.file.buffer;

    // Use Vertex AI to analyze the image for hand-held objects
    const prompt = `Analyze this image and detect if a person is holding objects in both hands. 
    
    Look specifically for:
    1. A person's hands (left and right)
    2. Objects being held or grasped in each hand
    3. Identify what the objects are (e.g., cup, phone, book, toy, etc.)
    
    Return a JSON response with this exact structure:
    {
      "leftHandObject": {
        "id": "unique_id",
        "label": "object_name", 
        "emoji": "appropriate_emoji",
        "confidence": 0.0-1.0,
        "hand": "left"
      } or null if no object detected,
      "rightHandObject": {
        "id": "unique_id", 
        "label": "object_name",
        "emoji": "appropriate_emoji", 
        "confidence": 0.0-1.0,
        "hand": "right"
      } or null if no object detected,
      "detectionConfidence": 0.0-1.0,
      "timestamp": current_timestamp_ms
    }
    
    Only detect clear, recognizable objects that are actively being held. If hands are empty or objects are unclear, return null for that hand.`;

    const analysisResult = await analyzeVideoWithVertex(imageBuffer, prompt);
    
    if (!analysisResult) {
      return res.status(500).json({ error: 'Failed to analyze image' });
    }

    try {
      // Parse the AI response as JSON
      const cleanedResponse = analysisResult.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const detection: TwoHandedDetectionResult = JSON.parse(cleanedResponse);
      
      // Add timestamp if not provided
      if (!detection.timestamp) {
        detection.timestamp = Date.now();
      }

      console.log('Two-handed object detection result:', {
        leftObject: detection.leftHandObject?.label || 'none',
        rightObject: detection.rightHandObject?.label || 'none',
        confidence: detection.detectionConfidence
      });

      res.json(detection);
    } catch (parseError) {
      console.error('Failed to parse AI response as JSON:', parseError);
      console.log('Raw AI response:', analysisResult);
      
      // Fallback: try to extract objects from natural language response
      const fallbackResult: TwoHandedDetectionResult = {
        leftHandObject: null,
        rightHandObject: null,
        detectionConfidence: 0,
        timestamp: Date.now()
      };

      res.json(fallbackResult);
    }

  } catch (error) {
    console.error('Two-handed object detection error:', error);
    res.status(500).json({ error: 'Internal server error during object detection' });
  }
});

export { router as objectDetectionRoutes };