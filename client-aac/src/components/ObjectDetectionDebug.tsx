import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Hand, Eye, EyeOff, X, Minimize2, Maximize2 } from 'lucide-react';

interface DetectedObject {
  id: string;
  label: string;
  emoji: string;
  confidence: number;
  hand: 'left' | 'right';
}

interface ObjectDetectionDebugProps {
  isVisible: boolean;
  onToggle: (visible: boolean) => void;
  detectedObjects: {left: DetectedObject | null, right: DetectedObject | null};
  isDetectionActive: boolean;
  lastDetectionTime?: number;
}

export function ObjectDetectionDebug({ 
  isVisible, 
  onToggle, 
  detectedObjects, 
  isDetectionActive, 
  lastDetectionTime 
}: ObjectDetectionDebugProps) {
  const [isMinimized, setIsMinimized] = useState(false);
  const [position, setPosition] = useState({ x: 20, y: 300 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    setDragOffset({
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    });
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (isDragging) {
      setPosition({
        x: e.clientX - dragOffset.x,
        y: e.clientY - dragOffset.y,
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  React.useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, dragOffset]);

  if (!isVisible) return null;

  const formatTimestamp = (timestamp?: number) => {
    if (!timestamp) return 'Never';
    const age = Math.floor((Date.now() - timestamp) / 1000);
    return `${age}s ago`;
  };

  return (
    <div
      className="fixed z-50 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg"
      style={{
        left: position.x,
        top: position.y,
        width: isMinimized ? '250px' : '350px',
        minHeight: isMinimized ? '50px' : '200px',
        maxHeight: '60vh',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        className="bg-green-600 text-white p-2 cursor-move flex items-center justify-between"
        onMouseDown={handleMouseDown}
      >
        <div className="flex items-center gap-2">
          <Hand className="h-4 w-4" />
          <span className="text-sm font-medium">Object Detection Debug</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 text-white hover:bg-green-700"
            onClick={() => setIsMinimized(!isMinimized)}
          >
            {isMinimized ? <Maximize2 className="h-3 w-3" /> : <Minimize2 className="h-3 w-3" />}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 text-white hover:bg-green-700"
            onClick={() => onToggle(false)}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Content */}
      {!isMinimized && (
        <div className="p-3 max-h-[50vh] overflow-y-auto space-y-3">
          {/* Detection Status */}
          <Card className="p-2">
            <div className="text-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-medium">Detection Status:</span>
                <span className={`px-2 py-1 rounded text-xs ${
                  isDetectionActive 
                    ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' 
                    : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
                }`}>
                  {isDetectionActive ? 'Active' : 'Inactive'}
                </span>
              </div>
              <div>
                <strong>Last Detection:</strong> {formatTimestamp(lastDetectionTime)}
              </div>
            </div>
          </Card>

          {/* Left Hand Detection */}
          <Card className="p-2">
            <div className="flex items-center gap-2 mb-2">
              <Hand className="h-4 w-4 text-blue-600 rotate-90" />
              <span className="text-sm font-medium">Left Hand</span>
            </div>
            <div className="text-xs space-y-1">
              {detectedObjects.left ? (
                <>
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{detectedObjects.left.emoji}</span>
                    <div>
                      <div><strong>Object:</strong> {detectedObjects.left.label}</div>
                      <div><strong>ID:</strong> {detectedObjects.left.id}</div>
                      <div><strong>Confidence:</strong> {Math.round(detectedObjects.left.confidence * 100)}%</div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="text-gray-500 dark:text-gray-400 italic">
                  No object detected
                </div>
              )}
            </div>
          </Card>

          {/* Right Hand Detection */}
          <Card className="p-2">
            <div className="flex items-center gap-2 mb-2">
              <Hand className="h-4 w-4 text-blue-600 -rotate-90" />
              <span className="text-sm font-medium">Right Hand</span>
            </div>
            <div className="text-xs space-y-1">
              {detectedObjects.right ? (
                <>
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{detectedObjects.right.emoji}</span>
                    <div>
                      <div><strong>Object:</strong> {detectedObjects.right.label}</div>
                      <div><strong>ID:</strong> {detectedObjects.right.id}</div>
                      <div><strong>Confidence:</strong> {Math.round(detectedObjects.right.confidence * 100)}%</div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="text-gray-500 dark:text-gray-400 italic">
                  No object detected
                </div>
              )}
            </div>
          </Card>

          {/* Detection Summary */}
          <Card className="p-2 bg-gray-50 dark:bg-gray-700">
            <div className="text-xs space-y-1">
              <div className="font-medium text-gray-700 dark:text-gray-300">
                Detection Summary
              </div>
              <div>
                <strong>Objects Found:</strong> {
                  (detectedObjects.left ? 1 : 0) + (detectedObjects.right ? 1 : 0)
                } / 2
              </div>
              <div>
                <strong>Both Hands:</strong> {
                  detectedObjects.left && detectedObjects.right ? 'Yes' : 'No'
                }
              </div>
              {(detectedObjects.left || detectedObjects.right) && (
                <div>
                  <strong>Available as Symbols:</strong> Yes
                </div>
              )}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}