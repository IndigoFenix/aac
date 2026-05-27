/**
 * CameraAttentivenessDebug.tsx
 *
 * Debug component to visualize the camera attentiveness state.
 * Shows sleep/wake status, motion level, and allows manual control.
 */

import { motion, AnimatePresence } from 'framer-motion';
import { Eye, EyeOff, Activity, Camera, Moon, Sun, Zap, Image } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCameraAttentivenessOptional } from '@/contexts/CameraAttentivenessContext';
import { useMultiCamera } from '@/hooks/useMultiCamera';
import type { CaptureFrequency, CaptureResolution } from '@/lib/cameraAttentivenessTypes';

interface CameraAttentivenessDebugProps {
  isVisible: boolean;
  onToggle: (visible: boolean) => void;
}

const frequencyLabels: Record<CaptureFrequency, string> = {
  sleep: '5s (Sleep)',
  low: '2s (Low)',
  medium: '1s (Med)',
  high: '250ms (High)',
};

const resolutionLabels: Record<CaptureResolution, string> = {
  low: '160x120',
  medium: '320x240',
  high: '640x480',
};

export function CameraAttentivenessDebug({ isVisible, onToggle }: CameraAttentivenessDebugProps) {
  const attentiveness = useCameraAttentivenessOptional();

  if (!attentiveness) {
    return null;
  }

  const { state, wake, sleep, setFrequency, setResolution, start, stop } = attentiveness;
  const { userVideoEl, userVideoReady, cameraDiag } = useMultiCamera();
  const recentDiag = cameraDiag.slice(-6).reverse();

  return (
    <>
      {/* Toggle Button */}
      <Button
        variant="outline"
        size="sm"
        onClick={() => onToggle(!isVisible)}
        className={`
          fixed z-40 bg-white/90 dark:bg-gray-900/90 backdrop-blur-sm
          border border-gray-300 dark:border-gray-600
          hover:bg-white dark:hover:bg-gray-800 shadow-lg
          flex items-center gap-2 transition-all duration-200
          ${isVisible ? 'bg-purple-100/90 dark:bg-purple-900/90 border-purple-300 dark:border-purple-700' : ''}
        `}
        style={{ bottom: '1rem', right: '33rem' }}
        title="Camera Attentiveness Debug"
      >
        {state.isAwake ? (
          <Eye className="w-4 h-4 text-green-500" />
        ) : (
          <EyeOff className="w-4 h-4 text-gray-400" />
        )}
        <span className="text-sm">Attentive</span>
      </Button>

      {/* Debug Window */}
      <AnimatePresence>
        {isVisible && (
          <motion.div
            className="fixed bottom-16 right-4 z-50 w-80 bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden"
            initial={{ opacity: 0, y: 20, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.9 }}
          >
            {/* Header */}
            <div className="bg-gradient-to-r from-purple-500 to-indigo-500 px-4 py-3 flex items-center justify-between">
              <div className="flex items-center gap-2 text-white">
                <Camera className="w-5 h-5" />
                <span className="font-semibold">Camera Attentiveness</span>
              </div>
              <button type="button"
                onClick={() => onToggle(false)}
                className="text-white/80 hover:text-white"
              >
                ✕
              </button>
            </div>

            {/* Content */}
            <div className="p-4 space-y-4">
              {/* Status */}
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-600 dark:text-gray-400">Status</span>
                <div className="flex items-center gap-2">
                  {state.isRunning ? (
                    <span className="px-2 py-1 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-full text-xs font-medium">
                      Running
                    </span>
                  ) : (
                    <span className="px-2 py-1 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 rounded-full text-xs font-medium">
                      Stopped
                    </span>
                  )}
                  {state.isAwake ? (
                    <span className="px-2 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 rounded-full text-xs font-medium flex items-center gap-1">
                      <Sun className="w-3 h-3" /> Awake
                    </span>
                  ) : (
                    <span className="px-2 py-1 bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 rounded-full text-xs font-medium flex items-center gap-1">
                      <Moon className="w-3 h-3" /> Sleeping
                    </span>
                  )}
                </div>
              </div>

              {/* Motion Level */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600 dark:text-gray-400 flex items-center gap-1">
                    <Activity className="w-4 h-4" /> Motion
                  </span>
                  <span className="font-mono text-gray-900 dark:text-gray-100">
                    {(state.motionLevel * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                  <motion.div
                    className="h-full bg-gradient-to-r from-green-400 to-yellow-400"
                    initial={{ width: 0 }}
                    animate={{ width: `${state.motionLevel * 100}%` }}
                    transition={{ duration: 0.3 }}
                  />
                </div>
              </div>

              {/* Frame Count */}
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-600 dark:text-gray-400">Frames Captured</span>
                <span className="font-mono text-gray-900 dark:text-gray-100">
                  {state.frameCount}
                </span>
              </div>

              {/* Shared user-camera <video> diagnostics (iOS freeze debugging) */}
              <div className="space-y-1 pt-2 border-t border-gray-200 dark:border-gray-700">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600 dark:text-gray-400">Shared video</span>
                  <span className={`font-mono text-xs px-2 py-0.5 rounded-full ${userVideoReady ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'}`}>
                    {userVideoReady ? 'ready' : 'not ready'}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs text-gray-500 font-mono">
                  <span>readyState {userVideoEl?.readyState ?? '–'} / paused {String(userVideoEl?.paused ?? '–')}</span>
                  <span>{userVideoEl?.videoWidth ?? 0}×{userVideoEl?.videoHeight ?? 0}</span>
                </div>
                {recentDiag.length > 0 && (
                  <div className="mt-1 max-h-24 overflow-y-auto rounded bg-gray-50 dark:bg-gray-800 p-1">
                    {recentDiag.map((ev, i) => (
                      <div key={i} className="text-[10px] font-mono text-gray-600 dark:text-gray-400 leading-tight">
                        {new Date(ev.t).toLocaleTimeString()} · {ev.kind}{ev.detail ? ` (${ev.detail})` : ''}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Frequency Control */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600 dark:text-gray-400 flex items-center gap-1">
                    <Zap className="w-4 h-4" /> Frequency
                  </span>
                  <span className="text-xs text-gray-500">
                    {frequencyLabels[state.mode.frequency]}
                  </span>
                </div>
                <div className="flex gap-1">
                  {(['sleep', 'low', 'medium', 'high'] as CaptureFrequency[]).map((freq) => (
                    <button type="button"
                      key={freq}
                      onClick={() => setFrequency(freq)}
                      className={`
                        flex-1 py-1 text-xs rounded transition-colors
                        ${state.mode.frequency === freq
                          ? 'bg-purple-500 text-white'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
                        }
                      `}
                    >
                      {freq}
                    </button>
                  ))}
                </div>
              </div>

              {/* Resolution Control */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600 dark:text-gray-400 flex items-center gap-1">
                    <Image className="w-4 h-4" /> Resolution
                  </span>
                  <span className="text-xs text-gray-500">
                    {resolutionLabels[state.mode.resolution]}
                  </span>
                </div>
                <div className="flex gap-1">
                  {(['low', 'medium', 'high'] as CaptureResolution[]).map((res) => (
                    <button type="button"
                      key={res}
                      onClick={() => setResolution(res)}
                      className={`
                        flex-1 py-1 text-xs rounded transition-colors
                        ${state.mode.resolution === res
                          ? 'bg-indigo-500 text-white'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
                        }
                      `}
                    >
                      {res}
                    </button>
                  ))}
                </div>
              </div>

              {/* Control Buttons */}
              <div className="flex gap-2 pt-2 border-t border-gray-200 dark:border-gray-700">
                {state.isRunning ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={state.isAwake ? sleep : wake}
                      className="flex-1"
                    >
                      {state.isAwake ? (
                        <>
                          <Moon className="w-4 h-4 mr-1" /> Sleep
                        </>
                      ) : (
                        <>
                          <Sun className="w-4 h-4 mr-1" /> Wake
                        </>
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={stop}
                      className="flex-1 text-red-600 border-red-200 hover:bg-red-50"
                    >
                      Stop
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={start}
                    className="flex-1 text-green-600 border-green-200 hover:bg-green-50"
                  >
                    Start Monitoring
                  </Button>
                )}
              </div>

              {/* Last Frame Preview (if available) */}
              {state.lastFrameUrl && (
                <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
                  <p className="text-xs text-gray-500 mb-1">Last Frame</p>
                  <img
                    src={state.lastFrameUrl}
                    alt="Last captured frame"
                    className="w-full h-auto rounded border border-gray-200 dark:border-gray-700"
                  />
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

export default CameraAttentivenessDebug;
