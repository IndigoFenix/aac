import { useState, useRef } from "react";
import { X, Video, VideoOff, Camera, Move, Monitor, Smartphone, Grid } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMultiCamera } from "@/hooks/useMultiCamera";
import { useCamera } from "@/hooks/useCamera";

interface MultiCameraDebugWindowProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function MultiCameraDebugWindow({ isOpen, onClose }: MultiCameraDebugWindowProps) {
  const [position, setPosition] = useState({ x: 20, y: 20 });
  const [isDragging, setIsDragging] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [selectedView, setSelectedView] = useState<'grid' | 'single'>('grid');
  const windowRef = useRef<HTMLDivElement>(null);
  
  const {
    availableDevices,
    cameras,
    isEnumerating,
    globalError,
    startCamera,
    stopCamera,
    getUserCamera,
    getEnvironmentCamera,
    isMultiCameraActive,
    userCameraActive,
    environmentCameraActive
  } = useMultiCamera();

  // Get main camera stream to display
  const { stream: mainCameraStream, devices: mainDevices, selectedDeviceId } = useCamera();

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

  const handleStartUserCamera = async () => {
    const userDevice = availableDevices.find(d => 
      d.label.toLowerCase().includes('front') || 
      d.label.toLowerCase().includes('user') ||
      d.label.toLowerCase().includes('facetime')
    );
    if (userDevice) {
      await startCamera(userDevice.deviceId, 'user');
    }
  };

  const handleStartEnvironmentCamera = async () => {
    const envDevice = availableDevices.find(d => 
      d.label.toLowerCase().includes('back') || 
      d.label.toLowerCase().includes('environment') ||
      d.label.toLowerCase().includes('hd webcam')
    );
    if (envDevice) {
      await startCamera(envDevice.deviceId, 'environment');
    }
  };

  if (!isOpen) return null;

  return (
    <div
      ref={windowRef}
      className={`fixed z-50 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg shadow-xl ${
        isDragging ? 'cursor-grabbing' : 'cursor-default'
      } ${isMinimized ? 'w-80' : 'w-96'}`}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        maxHeight: isMinimized ? 'auto' : '80vh'
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
          <Grid className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          <h3 className="font-medium text-gray-900 dark:text-white text-sm">Multi-Camera Debug</h3>
          <div className="flex gap-1">
            {cameras.map(camera => (
              <div
                key={camera.id}
                className={`h-2 w-2 rounded-full ${camera.isActive ? 'bg-green-500' : 'bg-red-500'}`}
                title={camera.label}
              />
            ))}
          </div>
        </div>
        <div className="flex gap-1">
          <Button 
            variant="ghost" 
            size="sm" 
            onClick={() => setSelectedView(selectedView === 'grid' ? 'single' : 'grid')}
            className="h-6 w-6 p-0 hover:bg-gray-100 dark:hover:bg-gray-700"
            title="Toggle view mode"
          >
            <Grid className="h-3 w-3" />
          </Button>
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
          {/* Status */}
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-gray-900 dark:text-white">Status</h4>
            <div className="space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-gray-600 dark:text-gray-400">Available Devices:</span>
                <span className="font-medium">{availableDevices.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600 dark:text-gray-400">Active Cameras:</span>
                <span className="font-medium">{cameras.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600 dark:text-gray-400">Multi-Camera Mode:</span>
                <span className={`font-medium ${isMultiCameraActive ? 'text-green-600 dark:text-green-400' : 'text-gray-500'}`}>
                  {isMultiCameraActive ? 'Active' : 'Inactive'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600 dark:text-gray-400">User Camera:</span>
                <span className={`font-medium ${userCameraActive ? 'text-green-600 dark:text-green-400' : 'text-gray-500'}`}>
                  {userCameraActive ? getUserCamera()?.label || 'Active' : 'None'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600 dark:text-gray-400">Environment Camera:</span>
                <span className={`font-medium ${environmentCameraActive ? 'text-green-600 dark:text-green-400' : 'text-gray-500'}`}>
                  {environmentCameraActive ? getEnvironmentCamera()?.label || 'Active' : 'None'}
                </span>
              </div>
            </div>
          </div>

          {/* Available Devices */}
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-gray-900 dark:text-white">Available Devices</h4>
            <div className="space-y-1">
              {availableDevices.map((device, index) => (
                <div key={device.deviceId} className="flex items-center justify-between text-xs p-2 bg-gray-50 dark:bg-gray-800 rounded">
                  <div className="flex items-center gap-2">
                    <Camera className="h-3 w-3 text-gray-500" />
                    <span className="font-medium">{device.label || `Camera ${index + 1}`}</span>
                    <span className="text-gray-500">({device.deviceId.slice(0, 8)}...)</span>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => startCamera(device.deviceId, 'user')}
                      className="h-5 px-2 text-xs hover:bg-blue-100 dark:hover:bg-blue-900"
                    >
                      User
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => startCamera(device.deviceId, 'environment')}
                      className="h-5 px-2 text-xs hover:bg-green-100 dark:hover:bg-green-900"
                    >
                      Env
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Active Cameras */}
          {cameras.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-gray-900 dark:text-white">Active Cameras</h4>
              <div className="grid gap-2">
                {cameras.map(camera => (
                  <div key={camera.id} className="space-y-1">
                    <div className="text-xs text-gray-600 dark:text-gray-400 truncate flex items-center gap-1">
                      {camera.facing === 'user' ? '👤' : camera.facing === 'environment' ? '🌍' : '📷'} 
                      <span className="font-medium">{camera.label}</span>
                      <span className={`ml-auto px-1.5 py-0.5 rounded text-xs ${
                        camera.isActive ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' : 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'
                      }`}>
                        {camera.isActive ? 'Live' : 'Off'}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => stopCamera(camera.deviceId)}
                        className="h-4 w-4 p-0 ml-1 hover:bg-red-100 dark:hover:bg-red-900"
                      >
                        <X className="h-2 w-2" />
                      </Button>
                    </div>
                    <div className="relative bg-black rounded overflow-hidden aspect-video">
                      {camera.stream && camera.isActive ? (
                        <div className="relative w-full h-full">
                          <video
                            autoPlay
                            playsInline
                            muted
                            className="w-full h-full object-cover"
                            style={{ transform: camera.facing === 'user' ? 'scaleX(-1)' : 'none' }}
                            ref={(video) => {
                              if (video && camera.stream && video.srcObject !== camera.stream) {
                                console.log(`Setting video source for camera: ${camera.label}`);
                                video.srcObject = camera.stream;
                                video.play()
                                  .then(() => console.log(`Video playing: ${camera.label}`))
                                  .catch(err => console.log('Video play error:', camera.label, err));
                              }
                            }}
                          />
                          <div className="absolute top-1 left-1 bg-black bg-opacity-50 text-white text-xs px-1 rounded">
                            {camera.facing === 'user' ? '👤' : '🌍'} {camera.label}
                          </div>
                          {camera.error && (
                            <div className="absolute bottom-1 left-1 bg-red-500 text-white text-xs px-1 rounded">
                              Error: {camera.error}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center h-full text-gray-400">
                          <VideoOff className="h-6 w-6 mb-1" />
                          <span className="text-xs">{camera.error || 'Camera Off'}</span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Controls */}
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-gray-900 dark:text-white">Quick Controls</h4>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleStartUserCamera}
                className="flex-1 text-xs"
                disabled={isEnumerating}
              >
                <Smartphone className="h-3 w-3 mr-1" />
                User Cam
              </Button>
              <Button
                variant="outline"
                size="sm" 
                onClick={handleStartEnvironmentCamera}
                className="flex-1 text-xs"
                disabled={isEnumerating}
              >
                <Monitor className="h-3 w-3 mr-1" />
                Env Cam
              </Button>
            </div>
          </div>

          {/* Error Display */}
          {globalError && (
            <div className="p-2 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded text-xs text-red-700 dark:text-red-300">
              {globalError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}