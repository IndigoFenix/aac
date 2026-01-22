import { fetchWithAuth } from "@/lib/queryClient";

interface CameraFrame {
  deviceId: string;
  label: string;
  facing: 'user' | 'environment' | 'unknown';
  blob: Blob;
}

interface MultiCameraAnalysis {
  success: boolean;
  analysis: {
    overallScene: string;
    contextualSummary: string;
    recommendations: string[];
    confidence: number;
  };
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
  framesAnalyzed: number;
  timestamp: string;
}

class MultiCameraService {
  async analyzeMultipleFrames(frames: {[deviceId: string]: Blob}, cameraLabels: {[deviceId: string]: string}): Promise<MultiCameraAnalysis> {
    try {
      const formData = new FormData();
      
      // Prepare metadata
      const metadata = Object.keys(frames).map(deviceId => ({
        deviceId,
        label: cameraLabels[deviceId] || `Camera ${deviceId}`,
        facing: this.determineFacing(cameraLabels[deviceId] || '')
      }));
      
      // Add frames to form data
      Object.entries(frames).forEach(([deviceId, blob]) => {
        formData.append('frames', blob, `frame-${deviceId}.jpg`);
      });
      
      // Add metadata
      formData.append('metadata', JSON.stringify(metadata));
      
      console.log(`Sending ${Object.keys(frames).length} camera frames for analysis`);
      
      const response = await fetchWithAuth('/api/aac/multi-camera/analyze', {
        method: 'POST',
        body: formData
      });
      
      if (!response.ok) {
        throw new Error(`Multi-camera analysis failed: ${response.statusText}`);
      }
      
      const result = await response.json();
      
      console.log('Multi-camera analysis result:', {
        success: result.success,
        framesAnalyzed: result.framesAnalyzed,
        confidence: result.analysis?.confidence,
        hasUserCamera: !!result.userCamera,
        hasEnvironmentCamera: !!result.environmentCamera
      });
      
      return result;
      
    } catch (error) {
      console.error('Multi-camera analysis error:', error);
      throw error;
    }
  }
  
  async getCurrentAnalysis(): Promise<any> {
    try {
      const response = await fetchWithAuth('/api/aac/multi-camera/current-analysis');
      const result = await response.json();
      return result;
    } catch (error) {
      console.error('Failed to get current multi-camera analysis:', error);
      return { available: false };
    }
  }
  
  private determineFacing(label: string): 'user' | 'environment' | 'unknown' {
    const lowerLabel = label.toLowerCase();
    if (lowerLabel.includes('front') || lowerLabel.includes('user') || lowerLabel.includes('facetime')) {
      return 'user';
    } else if (lowerLabel.includes('back') || lowerLabel.includes('rear') || lowerLabel.includes('environment')) {
      return 'environment';
    }
    return 'unknown';
  }
  
  // Enhanced context analysis that combines multiple camera perspectives
  async getEnhancedEnvironmentalContext(): Promise<{
    multiCameraContext: any;
    recommendations: string[];
    confidence: number;
  }> {
    try {
      const analysis = await this.getCurrentAnalysis();
      
      if (!analysis.available) {
        return {
          multiCameraContext: null,
          recommendations: ['Enable multiple cameras for enhanced context'],
          confidence: 0
        };
      }
      
      return {
        multiCameraContext: analysis,
        recommendations: analysis.recommendations || [],
        confidence: analysis.confidence || 0.5
      };
      
    } catch (error) {
      console.error('Failed to get enhanced environmental context:', error);
      return {
        multiCameraContext: null,
        recommendations: ['Multi-camera analysis unavailable'],
        confidence: 0
      };
    }
  }
}

export const multiCameraService = new MultiCameraService();
export type { MultiCameraAnalysis, CameraFrame };