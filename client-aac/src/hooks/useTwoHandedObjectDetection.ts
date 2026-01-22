import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchWithAuth } from '@/lib/queryClient';

export interface DetectedObject {
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

export interface TwoHandedDetectionResult {
  leftHandObject: DetectedObject | null;
  rightHandObject: DetectedObject | null;
  detectionConfidence: number;
  timestamp: number;
}

export function useTwoHandedObjectDetection(enabled: boolean = true) {
  const [isDetecting, setIsDetecting] = useState(false);
  const [lastDetection, setLastDetection] = useState<TwoHandedDetectionResult | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectionIntervalRef = useRef<NodeJS.Timeout | null>(null);

  console.log('🔧 useTwoHandedObjectDetection hook - enabled:', enabled, 'isDetecting:', isDetecting);

  // Initialize camera for object detection
  const initializeCamera = useCallback(async () => {
    try {
      console.log('🎥 Initializing camera for object detection...');
      
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'user'
        }
      });

      streamRef.current = stream;
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        console.log('✅ Camera initialized successfully for object detection');
        
        // Trigger re-sync of display video if it exists
        const event = new CustomEvent('videoStreamReady', { detail: { stream } });
        window.dispatchEvent(event);
      }

      return true;
    } catch (error) {
      console.error('❌ Failed to initialize camera for object detection:', error);
      return false;
    }
  }, []);

  // Capture frame and detect objects in both hands
  const detectObjectsInHands = useCallback(async (): Promise<TwoHandedDetectionResult | null> => {
    console.log('🔍 detectObjectsInHands called');
    console.log('📊 Video ref exists:', !!videoRef.current);
    console.log('📊 Canvas ref exists:', !!canvasRef.current);
    
    if (!videoRef.current || !canvasRef.current) {
      console.log('❌ Missing video or canvas ref');
      return null;
    }

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    console.log('📊 Video dimensions:', video.videoWidth, 'x', video.videoHeight);
    console.log('📊 Video ready state:', video.readyState);
    console.log('📊 Context exists:', !!ctx);

    if (!ctx || video.videoWidth === 0) {
      console.log('❌ No context or video not ready');
      return null;
    }

    // Set canvas size to match video
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    // Draw current frame
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Convert to blob
    return new Promise((resolve) => {
      canvas.toBlob(async (blob) => {
        if (!blob) {
          resolve(null);
          return;
        }

        try {
          const formData = new FormData();
          formData.append('image', blob, 'frame.jpg');
          formData.append('detectionType', 'two_handed_objects');

          console.log('📤 Sending image to object detection API...');
          console.log('📝 FormData contents:', {
            imageSize: blob.size,
            detectionType: 'two_handed_objects'
          });
          
          const response = await fetchWithAuth('/api/aac/detect-objects-in-hands', {
            method: 'POST',
            body: formData
          });
          
          console.log('🌐 API Response status:', response.status, response.statusText);

          if (response.ok) {
            const result: TwoHandedDetectionResult = await response.json();
            console.log('📥 API Response:', result);
            resolve(result);
          } else {
            console.error('❌ API Response error:', response.status, response.statusText);
            const errorText = await response.text();
            console.error('Error details:', errorText);
            resolve(null);
          }
        } catch (error) {
          console.error('❌ Object detection API error:', error);
          resolve(null);
        }
      }, 'image/jpeg', 0.8);
    });
  }, []);

  // Start continuous detection
  const startDetection = useCallback(async () => {
    if (isDetecting) {
      console.log('⚠️ Detection already running, skipping start');
      return;
    }

    console.log('🚀 Starting object detection...');
    
    const cameraReady = await initializeCamera();
    if (!cameraReady) {
      console.error('❌ Camera initialization failed, cannot start detection');
      return;
    }

    setIsDetecting(true);
    console.log('✅ Detection status set to active');

    // Start detection loop
    const intervalId = setInterval(async () => {
      console.log('🔍 Running object detection cycle...');
      const detection = await detectObjectsInHands();
      if (detection) {
        console.log('📦 Objects detected:', {
          left: detection.leftHandObject?.label || 'none',
          right: detection.rightHandObject?.label || 'none'
        });
        setLastDetection(detection);
      } else {
        console.log('❌ No objects detected in current cycle');
      }
    }, 3000); // Detect every 3 seconds
    
    detectionIntervalRef.current = intervalId;
    console.log('⏰ Detection interval started with ID:', intervalId);

  }, [isDetecting, initializeCamera, detectObjectsInHands]);

  // Stop detection
  const stopDetection = useCallback(() => {
    console.log('🛑 Stopping object detection...');
    setIsDetecting(false);
    
    if (detectionIntervalRef.current) {
      console.log('⏰ Clearing detection interval:', detectionIntervalRef.current);
      clearInterval(detectionIntervalRef.current);
      detectionIntervalRef.current = null;
    }

    if (streamRef.current) {
      console.log('📷 Stopping camera stream...');
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  }, []);

  // Keep refs to avoid stale closures without causing infinite loops
  const startDetectionRef = useRef(startDetection);
  const stopDetectionRef = useRef(stopDetection);
  
  useEffect(() => {
    startDetectionRef.current = startDetection;
    stopDetectionRef.current = stopDetection;
  });

  // Auto-start/stop based on enabled prop
  useEffect(() => {
    console.log('📢 Object detection enabled state changed:', enabled);
    if (enabled) {
      console.log('🟢 Starting object detection because enabled=true');
      startDetectionRef.current();
    } else {
      console.log('🔴 Stopping object detection because enabled=false');
      stopDetectionRef.current();
    }

    return () => {
      console.log('🧹 Cleanup effect triggered for enabled:', enabled);
      stopDetectionRef.current();
    };
  }, [enabled]); // Only depend on enabled to prevent infinite loops

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      console.log('🗑️ Component unmounting, cleaning up detection');
      stopDetection();
    };
  }, []); // Empty dependency array for unmount cleanup only

  return {
    isDetecting,
    lastDetection,
    startDetection,
    stopDetection,
    videoRef,
    canvasRef
  };
}