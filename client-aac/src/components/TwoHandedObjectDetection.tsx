import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Camera, Hand, X, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTwoHandedObjectDetection, DetectedObject } from '@/hooks/useTwoHandedObjectDetection';

interface TwoHandedObjectDetectionProps {
  isEnabled: boolean;
  showWindow?: boolean;
  onObjectsDetected: (leftObject: DetectedObject | null, rightObject: DetectedObject | null) => void;
  onToggle: (enabled: boolean) => void;
}

export default function TwoHandedObjectDetection({ 
  isEnabled, 
  showWindow = false,
  onObjectsDetected, 
  onToggle 
}: TwoHandedObjectDetectionProps) {
  console.log('🎮 TwoHandedObjectDetection render - isEnabled:', isEnabled);
  
  const {
    isDetecting,
    lastDetection,
    videoRef,
    canvasRef
  } = useTwoHandedObjectDetection(isEnabled);
  
  const displayVideoRef = useRef<HTMLVideoElement>(null);
  
  console.log('🎯 Hook state - isDetecting:', isDetecting, 'lastDetection:', lastDetection);

  // Notify parent component when objects are detected
  useEffect(() => {
    if (lastDetection) {
      console.log('🎯 Detected objects changed, calling onObjectsDetected:', {
        left: lastDetection.leftHandObject?.label || 'none',
        right: lastDetection.rightHandObject?.label || 'none'
      });
      onObjectsDetected(lastDetection.leftHandObject, lastDetection.rightHandObject);
    }
  }, [lastDetection, onObjectsDetected]);

  // Sync display video with detection video stream
  useEffect(() => {
    const syncVideo = () => {
      if (displayVideoRef.current && videoRef.current?.srcObject && showWindow) {
        console.log('🎥 Syncing display video with detection stream');
        console.log('📹 Detection video stream:', !!videoRef.current.srcObject);
        console.log('📺 Display video element:', !!displayVideoRef.current);
        
        displayVideoRef.current.srcObject = videoRef.current.srcObject;
        displayVideoRef.current.play().catch((error) => {
          console.error('❌ Failed to play display video:', error);
        });
      } else {
        console.log('🎥 Sync conditions not met:', {
          displayVideo: !!displayVideoRef.current,
          detectionStream: !!videoRef.current?.srcObject,
          showWindow
        });
      }
    };

    // Try syncing immediately
    syncVideo();

    // Also try syncing after a short delay in case the stream is still initializing
    const timeout = setTimeout(syncVideo, 500);
    
    return () => clearTimeout(timeout);
  }, [showWindow, isDetecting]);

  return (
    <>
      {/* Hidden video and canvas for background detection - always rendered when enabled */}
      {isEnabled && (
        <div className="hidden">
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="w-1 h-1"
          />
          <canvas ref={canvasRef} className="w-1 h-1" />
        </div>
      )}

      {/* Visible window - only shown when showWindow is true */}
      <AnimatePresence>
        {isEnabled && showWindow && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="fixed top-20 right-4 z-40 bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 p-4 max-w-sm"
          >
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Hand className="w-5 h-5 text-blue-600" />
                <span className="font-semibold text-sm">Object Detection</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onToggle(false)}
                className="w-6 h-6 p-0"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>

            {/* Camera Preview - shows the same stream as detection video */}
            <div className="relative mb-4">
              <video
                ref={displayVideoRef}
                className="w-full h-32 rounded-lg bg-gray-100 dark:bg-gray-700 object-cover"
                autoPlay
                muted
                playsInline
              />
            
            {/* Detection Status Overlay */}
            <div className="absolute top-2 left-2 flex items-center gap-1 bg-black/50 text-white px-2 py-1 rounded-md text-xs">
              <Camera className="w-3 h-3" />
              {isDetecting ? (
                <span className="text-green-300">Detecting...</span>
              ) : (
                <span className="text-red-300">Inactive</span>
              )}
            </div>
          </div>

          {/* Detection Results */}
          <div className="space-y-3">
            <div className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">
              Hold objects in both hands to create symbols
            </div>
            
            {/* Left Hand */}
            <div className="flex items-center gap-3 p-2 bg-gray-50 dark:bg-gray-700 rounded-lg">
              <div className="text-xs text-gray-500 w-12">Left:</div>
              {lastDetection?.leftHandObject ? (
                <div className="flex items-center gap-2">
                  <span className="text-lg">{lastDetection.leftHandObject.emoji}</span>
                  <span className="text-sm font-medium">{lastDetection.leftHandObject.label}</span>
                  <Check className="w-3 h-3 text-green-500" />
                </div>
              ) : (
                <span className="text-xs text-gray-400">No object detected</span>
              )}
            </div>

            {/* Right Hand */}
            <div className="flex items-center gap-3 p-2 bg-gray-50 dark:bg-gray-700 rounded-lg">
              <div className="text-xs text-gray-500 w-12">Right:</div>
              {lastDetection?.rightHandObject ? (
                <div className="flex items-center gap-2">
                  <span className="text-lg">{lastDetection.rightHandObject.emoji}</span>
                  <span className="text-sm font-medium">{lastDetection.rightHandObject.label}</span>
                  <Check className="w-3 h-3 text-green-500" />
                </div>
              ) : (
                <span className="text-xs text-gray-400">No object detected</span>
              )}
            </div>

            {/* Detection Confidence */}
            {lastDetection && (
              <div className="text-xs text-gray-500 text-center">
                Confidence: {Math.round((lastDetection.detectionConfidence || 0) * 100)}%
              </div>
            )}
          </div>

          {/* Instructions */}
          <div className="mt-4 p-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
            <div className="text-xs text-blue-800 dark:text-blue-200">
              💡 Hold objects clearly in both hands. Detected objects will appear as symbol cards on the main screen.
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
    </>
  );
}