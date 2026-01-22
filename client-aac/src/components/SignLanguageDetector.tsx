import React, { useState, useRef, useCallback } from 'react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Camera, Hand, FileX } from "lucide-react";
import { apiRequest, fetchWithAuth } from "@/lib/queryClient";

interface SignLanguageDetectorProps {
  studentId?: string;
  enabled?: boolean;
  language?: string;
}

interface SignLanguageResult {
  signLanguageDetected: boolean;
  interpretation?: string;
  confidence: number;
}

export function SignLanguageDetector({ studentId, enabled = false, language = "en" }: SignLanguageDetectorProps) {
  const [isDetecting, setIsDetecting] = useState(false);
  const [lastResult, setLastResult] = useState<SignLanguageResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const captureFrameAndDetect = useCallback(async () => {
    if (!enabled) {
      setError(language === "he" ? "קריאת שפת סימנים לא מופעלת" : "Sign language reading not enabled");
      return;
    }

    if (!videoRef.current || !canvasRef.current) {
      setError(language === "he" ? "שגיאה בגישה למצלמה" : "Camera access error");
      return;
    }

    setIsDetecting(true);
    setError(null);

    try {
      // Capture frame from video
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas context not available');
      
      canvas.width = videoRef.current.videoWidth;
      canvas.height = videoRef.current.videoHeight;
      context.drawImage(videoRef.current, 0, 0);
      
      // Convert to blob
      const blob = await new Promise<Blob>((resolve) => {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
        }, 'image/jpeg', 0.8);
      });

      // Create form data
      const formData = new FormData();
      formData.append('image', blob, 'frame.jpg');
      if (studentId) {
        formData.append('studentId', studentId);
      }

      // Send to API
      const response = await fetchWithAuth('/api/aac/detect-sign-language', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Detection failed');
      }

      const result: SignLanguageResult = await response.json();
      setLastResult(result);

      console.log('Sign language detection result:', result);

    } catch (err: any) {
      console.error('Sign language detection error:', err);
      setError(err.message || 'Detection failed');
    } finally {
      setIsDetecting(false);
    }
  }, [enabled, studentId, language]);

  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { width: 640, height: 480 } 
      });
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
    } catch (err) {
      console.error('Camera access error:', err);
      setError(language === "he" ? "לא ניתן לגשת למצלמה" : "Cannot access camera");
    }
  }, [language]);

  React.useEffect(() => {
    if (enabled) {
      startCamera();
    }

    return () => {
      // Cleanup camera stream
      if (videoRef.current?.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach(track => track.stop());
      }
    };
  }, [enabled, startCamera]);

  if (!enabled) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Hand className="h-5 w-5" />
            {language === "he" ? "קריאת שפת סימנים" : "Sign Language Reading"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center text-gray-500">
            <FileX className="h-12 w-12 mx-auto mb-2" />
            <p className="text-sm">
              {language === "he" 
                ? "יש להפעיל קריאת שפת סימנים בהגדרות"
                : "Enable sign language reading in settings"
              }
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Hand className="h-5 w-5" />
          {language === "he" ? "זיהוי שפת סימנים" : "Sign Language Detection"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Camera Feed */}
        <div className="relative">
          <video
            ref={videoRef}
            className="w-full h-48 bg-gray-100 rounded-lg object-cover"
            muted
            playsInline
          />
          <canvas
            ref={canvasRef}
            className="hidden"
          />
          
          {/* Detection Button */}
          <div className="absolute bottom-2 left-1/2 transform -translate-x-1/2">
            <Button
              onClick={captureFrameAndDetect}
              disabled={isDetecting}
              className="bg-blue-600 hover:bg-blue-700"
            >
              <Camera className="h-4 w-4 mr-2" />
              {isDetecting 
                ? (language === "he" ? "מזהה..." : "Detecting...") 
                : (language === "he" ? "זהה סימנים" : "Detect Signs")
              }
            </Button>
          </div>
        </div>

        {/* Error Display */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-red-700 text-sm">{error}</p>
          </div>
        )}

        {/* Results Display */}
        {lastResult && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">
                {language === "he" ? "תוצאה:" : "Result:"}
              </span>
              <Badge variant={lastResult.signLanguageDetected ? "default" : "secondary"}>
                {lastResult.signLanguageDetected 
                  ? (language === "he" ? "זוהה" : "Detected") 
                  : (language === "he" ? "לא זוהה" : "Not Detected")
                }
              </Badge>
            </div>
            
            {lastResult.interpretation && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-3">
                <p className="text-green-800 font-medium">
                  {language === "he" ? "פרשנות:" : "Interpretation:"}
                </p>
                <p className="text-green-700">{lastResult.interpretation}</p>
              </div>
            )}
            
            <div className="flex items-center justify-between text-sm text-gray-500">
              <span>{language === "he" ? "רמת ביטחון:" : "Confidence:"}</span>
              <span>{Math.round(lastResult.confidence * 100)}%</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}