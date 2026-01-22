import { useState, useRef, useEffect } from "react";
import { X, Video, VideoOff, Camera, Move, Monitor, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useMultiCamera } from "@/hooks/useMultiCamera";

interface CameraDebugWindowProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function CameraDebugWindow({ isOpen, onClose }: CameraDebugWindowProps) {
  const [position, setPosition] = useState({ x: 20, y: 20 });
  const [isDragging, setIsDragging] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [selectedCameraId, setSelectedCameraId] = useState<string>('');
  const [isMultiCameraMode, setIsMultiCameraMode] = useState(false);
  const windowRef = useRef<HTMLDivElement>(null);
  
  const {
    availableDevices,
    cameras,
    activeCameras,
    userCamera,
    environmentCamera,
    isEnumerating,
    globalError,
    startCamera,
    stopCamera,
    captureFrame,
    captureAllFrames
  } = useMultiCamera();

  useEffect(() => {
    if (isOpen && !stream) {
      startCamera();
    }

    return () => {
      if (stream) {
        stopCamera();
      }
    };
  }, [isOpen]);

  const startCamera = async () => {
    try {
      setError(null);
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: 'user'
        }
      });
      
      setStream(mediaStream);
      setIsStreaming(true);
      
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }
    } catch (err) {
      setError(`Camera access failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      setIsStreaming(false);
    }
  };

  const stopCamera = () => {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
      setIsStreaming(false);
    }
  };

  const captureFrame = () => {
    if (!videoRef.current || !canvasRef.current) return;
    
    const canvas = canvasRef.current;
    const video = videoRef.current;
    const ctx = canvas.getContext('2d');
    
    if (!ctx) return;
    
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);
    
    // Convert to blob and trigger download for debugging
    canvas.toBlob((blob) => {
      if (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `camera-debug-${Date.now()}.jpg`;
        a.click();
        URL.revokeObjectURL(url);
      }
    }, 'image/jpeg', 0.8);
  };

  // Handle dragging
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!windowRef.current) return;
    setIsDragging(true);
    const rect = windowRef.current.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;

    const handleMouseMove = (e: MouseEvent) => {
      setPosition({
        x: e.clientX - offsetX,
        y: e.clientY - offsetY
      });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  if (!isOpen) return null;

  return (
    <div
      ref={windowRef}
      className={`fixed z-50 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg shadow-xl ${
        isDragging ? 'cursor-grabbing' : 'cursor-default'
      } ${isMinimized ? 'w-64' : 'w-80'}`}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        maxHeight: isMinimized ? 'auto' : '70vh'
      }}
    >
      {/* Header */}
      <div 
        className={`flex items-center justify-between p-3 border-b border-gray-200 dark:border-gray-700 cursor-grab active:cursor-grabbing ${
          isDragging ? 'cursor-grabbing' : 'cursor-grab'
        }`}
        onMouseDown={handleMouseDown}
      >
        <div className="flex items-center gap-2">
          <Move className="h-4 w-4 text-gray-400" />
          <Camera className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          <h3 className="font-medium text-gray-900 dark:text-white text-sm">Camera Debug</h3>
          <div className={`h-2 w-2 rounded-full ${isStreaming ? 'bg-green-500' : 'bg-red-500'}`} />
        </div>
        <div className="flex gap-1">
          <Button 
            variant="ghost" 
            size="sm" 
            onClick={() => setIsMinimized(!isMinimized)}
            className="h-6 w-6 p-0 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <span className="text-xs">{isMinimized ? '□' : '_'}</span>
          </Button>
          <Button 
            variant="ghost" 
            size="sm" 
            onClick={onClose}
            className="h-6 w-6 p-0 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Content */}
      {!isMinimized && (
        <div className="p-3 space-y-3 max-h-96 overflow-y-auto">
          {/* Controls */}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={isStreaming ? stopCamera : startCamera}
              disabled={!!error}
              className="flex-1 text-xs"
            >
              {isStreaming ? (
                <>
                  <VideoOff className="h-3 w-3 mr-1" />
                  Stop
                </>
              ) : (
                <>
                  <Video className="h-3 w-3 mr-1" />
                  Start
                </>
              )}
            </Button>
            {isStreaming && (
              <Button size="sm" variant="outline" onClick={captureFrame} className="text-xs">
                <Camera className="h-3 w-3" />
              </Button>
            )}
          </div>

          {/* Error Display */}
          {error && (
            <div className="p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-xs text-red-600 dark:text-red-400">
              {error}
            </div>
          )}

          {/* Video Feed */}
          <div className="relative bg-black rounded overflow-hidden aspect-video">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
              style={{ transform: 'scaleX(-1)' }}
            />
            {!isStreaming && !error && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-100 dark:bg-gray-800">
                <div className="text-center">
                  <Camera className="h-8 w-8 mx-auto mb-1 text-gray-400" />
                  <p className="text-xs text-gray-600 dark:text-gray-400">Camera off</p>
                </div>
              </div>
            )}
          </div>

          {/* Compact Info */}
          {isStreaming && videoRef.current && (
            <div className="text-xs text-gray-600 dark:text-gray-400 space-y-1">
              <div>📐 {videoRef.current.videoWidth}×{videoRef.current.videoHeight}</div>
              <div>🔗 {stream?.getTracks().length || 0} tracks</div>
            </div>
          )}
        </div>
      )}

      {/* Hidden canvas for frame capture */}
      <canvas ref={canvasRef} style={{ display: 'none' }} />
    </div>
  );
}