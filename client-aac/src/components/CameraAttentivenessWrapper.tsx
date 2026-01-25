/**
 * CameraAttentivenessWrapper.tsx
 *
 * Wrapper component that connects the CameraAttentivenessProvider
 * to the useMultiCamera hook. This provides intelligent camera
 * monitoring with sleep/wake functionality to the app.
 */

import { ReactNode, useMemo } from 'react';
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
  const videoStream = useMemo(() => {
    const camera = cameraType === 'user' ? getUserCamera() : getEnvironmentCamera();
    return camera?.stream ?? null;
  }, [cameraType, getUserCamera, getEnvironmentCamera]);

  return (
    <CameraAttentivenessProvider videoStream={videoStream} autoStart={autoStart}>
      {children}
    </CameraAttentivenessProvider>
  );
}

export default CameraAttentivenessWrapper;
