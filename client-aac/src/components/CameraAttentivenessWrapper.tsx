/**
 * CameraAttentivenessWrapper.tsx
 *
 * Wrapper component that connects the CameraAttentivenessProvider
 * to the useMultiCamera hook. This provides intelligent camera
 * monitoring with sleep/wake functionality to the app.
 */

import { ReactNode, useRef } from 'react';
import { useMultiCamera } from '@/hooks/useMultiCamera';
import { CameraAttentivenessProvider } from '@/contexts/CameraAttentivenessContext';

interface CameraAttentivenessWrapperProps {
  children: ReactNode;
  /** Whether to auto-start monitoring (default: true) */
  autoStart?: boolean;
  /** Which camera to monitor - 'user' or 'environment' (default: 'user') */
  cameraType?: 'user' | 'environment';
}

/**
 * Wrapper that provides CameraAttentivenessContext connected to the multi-camera system.
 *
 * Usage:
 * ```tsx
 * // In your component that uses useMultiCamera
 * <CameraAttentivenessWrapper>
 *   <YourComponent />
 * </CameraAttentivenessWrapper>
 * ```
 *
 * Then in child components:
 * ```tsx
 * const { state, setFrequency, setResolution, wake, sleep } = useCameraAttentiveness();
 * ```
 */
export function CameraAttentivenessWrapper({
  children,
  autoStart = true,
  cameraType = 'user',
}: CameraAttentivenessWrapperProps) {
  const { getUserCamera, getEnvironmentCamera } = useMultiCamera();

  // Get the appropriate camera's stream
  // Use ref to track the actual stream object and only update when it actually changes
  const camera = cameraType === 'user' ? getUserCamera() : getEnvironmentCamera();
  const currentStream = camera?.stream ?? null;

  // Track previous stream to avoid unnecessary updates
  const streamRef = useRef<MediaStream | null>(null);
  if (currentStream !== streamRef.current) {
    streamRef.current = currentStream;
  }

  return (
    <CameraAttentivenessProvider videoStream={streamRef.current} autoStart={autoStart}>
      {children}
    </CameraAttentivenessProvider>
  );
}

export default CameraAttentivenessWrapper;
