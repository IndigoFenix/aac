import { Router } from 'express';
import multer from 'multer';
import { analyzeMultipleCameras } from '../services/multiCameraAnalysis';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// Endpoint to analyze multiple camera frames
router.post('/analyze-multiple', upload.array('frames'), async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[];
    
    if (!files || files.length === 0) {
      return res.status(400).json({ message: 'No camera frames provided' });
    }

    // Parse frame metadata from request body
    const frameMetadata = JSON.parse(req.body.metadata || '[]');
    
    // Combine file data with metadata
    const frames = files.map((file, index) => {
      const metadata = frameMetadata[index] || {};
      return {
        deviceId: metadata.deviceId || `unknown-${index}`,
        label: metadata.label || `Camera ${index}`,
        facing: metadata.facing || 'unknown',
        imageData: file.buffer
      };
    });

    console.log(`Analyzing ${frames.length} camera frames from multiple sources`);
    
    // Perform multi-camera analysis
    const analysis = await analyzeMultipleCameras(frames);
    
    // Store analysis in session for context
    if (req.session) {
      req.session.multiCameraAnalysis = {
        timestamp: analysis.timestamp,
        userCamera: analysis.userCamera,
        environmentCamera: analysis.environmentCamera,
        combinedSummary: analysis.combinedAnalysis.contextualSummary,
        confidence: analysis.combinedAnalysis.confidence
      };
    }

    res.json({
      success: true,
      analysis: analysis.combinedAnalysis,
      userCamera: analysis.userCamera,
      environmentCamera: analysis.environmentCamera,
      framesAnalyzed: frames.length,
      timestamp: analysis.timestamp
    });

  } catch (error) {
    console.error('Multi-camera analysis error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Multi-camera analysis failed',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Get current multi-camera analysis from session
router.get('/current-analysis', (req, res) => {
  try {
    const analysis = req.session?.multiCameraAnalysis;
    
    if (!analysis) {
      return res.json({
        available: false,
        message: 'No multi-camera analysis available'
      });
    }

    res.json({
      available: true,
      ...analysis
    });

  } catch (error) {
    console.error('Error retrieving multi-camera analysis:', error);
    res.status(500).json({ 
      success: false,
      message: 'Failed to retrieve analysis'
    });
  }
});

export default router;