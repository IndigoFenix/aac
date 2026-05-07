import { useState, useRef } from "react";
import { X, Video, VideoOff, Camera, Move, Monitor, Smartphone, Grid, Eye, Hand } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useMultiCamera } from "@/hooks/useMultiCamera";
import { useCamera } from "@/hooks/useCamera";
import type { TrackedFace, FaceEvent } from "@/lib/faceTrackingTypes";
import { getEventColorCategory, EVENT_COLOR_MAP } from "@/lib/faceTrackingTypes";
import type { TrackedHand, HandGestureEvent } from "@/lib/handGestureTypes";
import { getHandEventColorCategory, HAND_EVENT_COLOR_MAP } from "@/lib/handGestureTypes";

interface MultiCameraDebugWindowProps {
  isOpen: boolean;
  onClose: () => void;
  // Face tracking props
  faceTrackingEnabled?: boolean;
  onFaceTrackingToggle?: (enabled: boolean) => void;
  trackedFaces?: TrackedFace[];
  faceTrackingFps?: number;
  faceTrackingReady?: boolean;
  faceTrackingError?: string | null;
  // Hand tracking props
  handGestureEnabled?: boolean;
  onHandGestureToggle?: (enabled: boolean) => void;
  trackedHands?: TrackedHand[];
  handGestureFps?: number;
  handGestureReady?: boolean;
  handGestureError?: string | null;
}

// =============================================================================
// Face Tracking Sub-Components
// =============================================================================

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 1) return 'now';
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}

const EXPRESSION_COLORS: Record<string, string> = {
  smile: 'bg-green-200 text-green-800 dark:bg-green-800 dark:text-green-200',
  frown: 'bg-red-200 text-red-800 dark:bg-red-800 dark:text-red-200',
  surprise: 'bg-yellow-200 text-yellow-800 dark:bg-yellow-800 dark:text-yellow-200',
  mouth_open: 'bg-purple-200 text-purple-800 dark:bg-purple-800 dark:text-purple-200',
  brow_raise: 'bg-teal-200 text-teal-800 dark:bg-teal-800 dark:text-teal-200',
  brow_furrow: 'bg-orange-200 text-orange-800 dark:bg-orange-800 dark:text-orange-200',
};

function FaceCard({ face, index }: { face: TrackedFace; index: number }) {
  const displayName = face.personName || `Unknown Person ${index + 1}`;

  // Top 5 active blendshapes by score
  const topBlendshapes = Array.from(face.currentBlendshapes.entries())
    .filter(([name]) => !name.startsWith('_'))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  // Recent events, newest first, max 8
  const recentEvents = [...face.events]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 8);

  return (
    <div className="p-2 bg-gray-50 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 space-y-1.5">
      {/* Name + expression badge */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-gray-900 dark:text-white truncate">
          {displayName}
        </span>
        {face.currentExpression && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
            EXPRESSION_COLORS[face.currentExpression] || 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
          }`}>
            {face.currentExpression.replace('_', ' ')}
          </span>
        )}
      </div>

      {/* Top blendshape bars */}
      {topBlendshapes.length > 0 && (
        <div className="space-y-0.5">
          {topBlendshapes.map(([name, score]) => (
            <div key={name} className="flex items-center gap-1 text-[10px]">
              <span className="w-20 truncate text-gray-500 dark:text-gray-400">{name}</span>
              <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 dark:bg-blue-400 rounded-full transition-all duration-200"
                  style={{ width: `${Math.round(score * 100)}%` }}
                />
              </div>
              <span className="w-8 text-right text-gray-500 dark:text-gray-400">{(score * 100).toFixed(0)}%</span>
            </div>
          ))}
        </div>
      )}

      {/* Recent events as pills */}
      {recentEvents.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {recentEvents.map((event, i) => {
            const colorCat = getEventColorCategory(event.type);
            const colors = EVENT_COLOR_MAP[colorCat];
            return (
              <span
                key={`${event.type}_${event.timestamp}_${i}`}
                className={`inline-flex items-center gap-0.5 text-[9px] px-1 py-0.5 rounded ${colors}`}
                title={`${event.type} (${(event.confidence * 100).toFixed(1)}%) at ${new Date(event.timestamp).toLocaleTimeString()}`}
              >
                {event.type.replace('_', ' ')}
                <span className="opacity-70">{(event.confidence * 100).toFixed(0)}%</span>
                <span className="opacity-50">{formatRelativeTime(event.timestamp)}</span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Hand Tracking Sub-Components
// =============================================================================

const GESTURE_COLORS: Record<string, string> = {
  open_palm: 'bg-indigo-200 text-indigo-800 dark:bg-indigo-800 dark:text-indigo-200',
  closed_fist: 'bg-indigo-200 text-indigo-800 dark:bg-indigo-800 dark:text-indigo-200',
  pointing_up: 'bg-indigo-200 text-indigo-800 dark:bg-indigo-800 dark:text-indigo-200',
  thumb_up: 'bg-green-200 text-green-800 dark:bg-green-800 dark:text-green-200',
  thumb_down: 'bg-red-200 text-red-800 dark:bg-red-800 dark:text-red-200',
  victory: 'bg-indigo-200 text-indigo-800 dark:bg-indigo-800 dark:text-indigo-200',
  i_love_you: 'bg-pink-200 text-pink-800 dark:bg-pink-800 dark:text-pink-200',
  wave: 'bg-amber-200 text-amber-800 dark:bg-amber-800 dark:text-amber-200',
  hand_raise: 'bg-amber-200 text-amber-800 dark:bg-amber-800 dark:text-amber-200',
  pointing_left: 'bg-amber-200 text-amber-800 dark:bg-amber-800 dark:text-amber-200',
  pointing_right: 'bg-amber-200 text-amber-800 dark:bg-amber-800 dark:text-amber-200',
  pinch: 'bg-amber-200 text-amber-800 dark:bg-amber-800 dark:text-amber-200',
  sign_language: 'bg-rose-200 text-rose-800 dark:bg-rose-800 dark:text-rose-200',
};

function HandCard({ hand, index }: { hand: TrackedHand; index: number }) {
  const displayName = `${hand.handedness} Hand`;

  // Key landmark positions
  const keyLandmarks = hand.landmarks.length >= 21 ? [
    { name: 'Wrist', lm: hand.landmarks[0] },
    { name: 'Index Tip', lm: hand.landmarks[8] },
    { name: 'Thumb Tip', lm: hand.landmarks[4] },
    { name: 'Middle Tip', lm: hand.landmarks[12] },
  ] : [];

  // Recent events, newest first, max 8
  const recentEvents = [...hand.events]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 8);

  return (
    <div className="p-2 bg-gray-50 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 space-y-1.5">
      {/* Hand label + gesture badge */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-gray-900 dark:text-white truncate">
          {displayName}
        </span>
        {hand.currentGesture && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
            GESTURE_COLORS[hand.currentGesture] || 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
          }`}>
            {hand.currentGesture.replace(/_/g, ' ')} {(hand.currentGestureConfidence * 100).toFixed(0)}%
          </span>
        )}
      </div>

      {/* Key landmark positions */}
      {keyLandmarks.length > 0 && (
        <div className="space-y-0.5">
          {keyLandmarks.map(({ name, lm }) => (
            <div key={name} className="flex items-center gap-1 text-[10px]">
              <span className="w-16 truncate text-gray-500 dark:text-gray-400">{name}</span>
              <span className="text-gray-600 dark:text-gray-300 font-mono">
                ({lm.x.toFixed(2)}, {lm.y.toFixed(2)})
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Recent events as pills */}
      {recentEvents.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {recentEvents.map((event, i) => {
            const colorCat = getHandEventColorCategory(event.type);
            const colors = HAND_EVENT_COLOR_MAP[colorCat];
            const label = event.type === 'sign_language' && event.signLabel
              ? event.signLabel
              : event.type.replace(/_/g, ' ');
            return (
              <span
                key={`${event.type}_${event.timestamp}_${i}`}
                className={`inline-flex items-center gap-0.5 text-[9px] px-1 py-0.5 rounded ${colors}`}
                title={`${event.type}${event.signLabel ? ` (${event.signLabel})` : ''} (${(event.confidence * 100).toFixed(1)}%) at ${new Date(event.timestamp).toLocaleTimeString()}`}
              >
                {label}
                <span className="opacity-70">{(event.confidence * 100).toFixed(0)}%</span>
                <span className="opacity-50">{formatRelativeTime(event.timestamp)}</span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Main Component
// =============================================================================

export default function MultiCameraDebugWindow({
  isOpen,
  onClose,
  faceTrackingEnabled = false,
  onFaceTrackingToggle,
  trackedFaces = [],
  faceTrackingFps = 0,
  faceTrackingReady = false,
  faceTrackingError = null,
  handGestureEnabled = false,
  onHandGestureToggle,
  trackedHands = [],
  handGestureFps = 0,
  handGestureReady = false,
  handGestureError = null,
}: MultiCameraDebugWindowProps) {
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
      {/* Header — pointer-only drag handle for a debug-only floating window. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
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
            aria-label="Close"
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

          {/* Face Tracking */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium text-gray-900 dark:text-white flex items-center gap-1">
                <Eye className="h-3.5 w-3.5" />
                Face Tracking
              </h4>
              {onFaceTrackingToggle && (
                <Switch
                  checked={faceTrackingEnabled}
                  onCheckedChange={onFaceTrackingToggle}
                />
              )}
            </div>

            {faceTrackingEnabled && (
              <div className="space-y-2">
                {/* Status line */}
                <div className="flex items-center gap-2 text-xs">
                  <span className={`inline-block h-2 w-2 rounded-full ${
                    faceTrackingError ? 'bg-red-500' :
                    faceTrackingReady ? 'bg-green-500' : 'bg-yellow-500 animate-pulse'
                  }`} />
                  <span className="text-gray-600 dark:text-gray-400">
                    {faceTrackingError ? `Error: ${faceTrackingError}` :
                     faceTrackingReady ? `Ready - ${faceTrackingFps} FPS` : 'Loading model...'}
                  </span>
                  {trackedFaces.length > 0 && (
                    <span className="ml-auto text-gray-500">
                      {trackedFaces.length} face{trackedFaces.length !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>

                {/* Per-face cards */}
                {trackedFaces.map((face, idx) => (
                  <FaceCard key={face.personId || `face_${idx}`} face={face} index={idx} />
                ))}
              </div>
            )}
          </div>

          {/* Hand Tracking */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium text-gray-900 dark:text-white flex items-center gap-1">
                <Hand className="h-3.5 w-3.5" />
                Hand Tracking
              </h4>
              {onHandGestureToggle && (
                <Switch
                  checked={handGestureEnabled}
                  onCheckedChange={onHandGestureToggle}
                />
              )}
            </div>

            {handGestureEnabled && (
              <div className="space-y-2">
                {/* Status line */}
                <div className="flex items-center gap-2 text-xs">
                  <span className={`inline-block h-2 w-2 rounded-full ${
                    handGestureError ? 'bg-red-500' :
                    handGestureReady ? 'bg-green-500' : 'bg-yellow-500 animate-pulse'
                  }`} />
                  <span className="text-gray-600 dark:text-gray-400">
                    {handGestureError ? `Error: ${handGestureError}` :
                     handGestureReady ? `Ready - ${handGestureFps} FPS` : 'Loading model...'}
                  </span>
                  {trackedHands.length > 0 && (
                    <span className="ml-auto text-gray-500">
                      {trackedHands.length} hand{trackedHands.length !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>

                {/* Per-hand cards */}
                {trackedHands.map((hand, idx) => (
                  <HandCard key={`hand_${hand.handedness}_${idx}`} hand={hand} index={idx} />
                ))}
              </div>
            )}
          </div>

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