import { useState, useRef, useCallback, useEffect } from 'react';

interface CameraStream {
  id: string;
  deviceId: string;
  label: string;
  stream: MediaStream | null;
  isActive: boolean;
  error: string | null;
  facing: 'user' | 'environment' | 'unknown';
}

export function useMultiCamera(options?: { autoStart?: boolean }) {
  const autoStart = options?.autoStart ?? true;
  const [availableDevices, setAvailableDevices] = useState<MediaDeviceInfo[]>([]);
  const [cameras, setCameras] = useState<Map<string, CameraStream>>(new Map());
  const [isEnumerating, setIsEnumerating] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);

  // Determine camera facing direction from label with priority for integrated cameras
  const getFacingMode = useCallback((label: string): 'user' | 'environment' | 'unknown' => {
    const lowerLabel = label.toLowerCase();
    
    // Priority: Integrated cameras are user-facing by default
    if (lowerLabel.includes('integrated') || lowerLabel.includes('builtin') || lowerLabel.includes('built-in')) {
      return 'user';
    }
    
    // External cameras are environment-facing by default  
    if (lowerLabel.includes('hd webcam') || lowerLabel.includes('usb') || lowerLabel.includes('external')) {
      return 'environment';
    }
    
    // Fallback based on common naming patterns
    if (lowerLabel.includes('front') || lowerLabel.includes('user') || lowerLabel.includes('selfie')) {
      return 'user';
    }
    if (lowerLabel.includes('back') || lowerLabel.includes('rear') || lowerLabel.includes('environment')) {
      return 'environment';
    }
    
    return 'unknown';
  }, []);

  // Start a specific camera
  const startCamera = useCallback(async (deviceId: string, facing: 'user' | 'environment' | 'unknown' = 'unknown') => {
    try {
      console.log(`Starting camera: ${deviceId} (${facing})`);
      
      const device = availableDevices.find(d => d.deviceId === deviceId);
      if (!device) {
        throw new Error('Camera device not found');
      }

      // Request camera stream
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { 
          deviceId: { exact: deviceId },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      });

      const cameraStream: CameraStream = {
        id: deviceId,
        deviceId,
        label: device.label || `Camera ${deviceId.slice(0, 8)}`,
        stream,
        isActive: true,
        error: null,
        facing: facing === 'unknown' ? getFacingMode(device.label) : facing
      };

      setCameras(prev => new Map(prev.set(deviceId, cameraStream)));
      console.log(`Camera started successfully: ${cameraStream.label} (${cameraStream.facing})`);
      
      return cameraStream;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Failed to start camera ${deviceId}:`, error);
      
      setCameras(prev => {
        const updated = new Map(prev);
        updated.set(deviceId, {
          id: deviceId,
          deviceId,
          label: availableDevices.find(d => d.deviceId === deviceId)?.label || `Camera ${deviceId.slice(0, 8)}`,
          stream: null,
          isActive: false,
          error: errorMessage,
          facing: 'unknown'
        });
        return updated;
      });
      
      throw error;
    }
  }, [availableDevices, getFacingMode]);

  // Stop a specific camera
  const stopCamera = useCallback((deviceId: string) => {
    const camera = cameras.get(deviceId);
    if (camera?.stream) {
      camera.stream.getTracks().forEach(track => track.stop());
    }
    
    setCameras(prev => {
      const updated = new Map(prev);
      updated.delete(deviceId);
      return updated;
    });
    
    console.log(`Camera stopped: ${deviceId}`);
  }, [cameras]);

  // Auto-assign cameras by default: integrated as user, external as environment
  const autoAssignCameras = useCallback(async () => {
    const devices = availableDevices;
    if (devices.length === 0) return;

    try {
      console.log('Available cameras for assignment:', devices.map(d => ({
        deviceId: d.deviceId.slice(0, 8),
        label: d.label,
        facing: getFacingMode(d.label)
      })));

      // Strategy: If we have multiple cameras, try the second one first for user detection
      // since the current assignment seems to have the user on the second camera
      let userCamera, environmentCamera;
      
      if (devices.length >= 2) {
        // PRIORITY: Integrated camera should be the primary source for main user validation
        const integratedWebcam = devices.find(device => device.label.includes('Integrated Webcam'));
        const hdWebcam = devices.find(device => device.label.includes('HD Webcam C525'));
        
        if (integratedWebcam && hdWebcam) {
          userCamera = integratedWebcam;  // Integrated camera for main user detection
          environmentCamera = hdWebcam;   // HD Webcam for environment analysis
          console.log('Multi-camera strategy: Integrated Webcam as user camera (primary for main user validation)');
        } else {
          // Fallback: prioritize integrated cameras for user detection
          const integratedCamera = devices.find(d => getFacingMode(d.label) === 'user');
          const environmentCameraDevice = devices.find(d => getFacingMode(d.label) === 'environment');
          
          if (integratedCamera) {
            userCamera = integratedCamera;
            environmentCamera = environmentCameraDevice || devices.find(d => d !== integratedCamera);
            console.log('Multi-camera strategy: Using integrated/user-facing camera for main user detection');
          } else {
            // Last resort fallback
            userCamera = devices[0];
            environmentCamera = devices[1];
            console.log('Multi-camera strategy: Using fallback camera assignment');
          }
        }
      } else if (devices.length === 1) {
        // Single camera setup
        userCamera = devices[0];
        environmentCamera = null;
        console.log('Single camera strategy: Using only available camera as user camera');
      } else {
        console.log('No cameras available for assignment');
        return;
      }

      console.log('Auto-assigned cameras:', {
        userCamera: userCamera ? { id: userCamera.deviceId, label: userCamera.label } : null,
        environmentCamera: environmentCamera ? { id: environmentCamera.deviceId, label: environmentCamera.label } : null
      });

      // Start both cameras if available
      if (userCamera) {
        await startCamera(userCamera.deviceId, 'user');
      }
      if (environmentCamera) {
        await startCamera(environmentCamera.deviceId, 'environment');
      }
    } catch (error) {
      console.error('Failed to auto-assign cameras:', error);
      setGlobalError('Failed to start multi-camera mode');
    }
  }, [availableDevices, startCamera]);

  // Enumerate available camera devices
  const enumerateDevices = useCallback(async () => {
    try {
      setIsEnumerating(true);
      setGlobalError(null);
      
      // Check if MediaDevices API is available
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        console.warn('MediaDevices API not available - running in camera-less mode');
        setAvailableDevices([]);
        return;
      }
      
      // First, try to enumerate without permissions (basic device info)
      let devices = await navigator.mediaDevices.enumerateDevices();
      let videoDevices = devices.filter(device => device.kind === 'videoinput');
      
      // If no cameras found or no labels, request permission and re-enumerate.
      // Some browsers hide devices entirely until getUserMedia permission is granted.
      if (videoDevices.length === 0 || videoDevices.some(d => !d.label)) {
        try {
          console.log('Requesting camera permissions...');
          const tempStream = await Promise.race([
            navigator.mediaDevices.getUserMedia({ video: true }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Permission request timeout after 5 seconds')), 5000)
            )
          ]);

          // Stop the temporary stream immediately
          tempStream.getTracks().forEach(track => track.stop());

          // Re-enumerate with permissions granted
          await new Promise(resolve => setTimeout(resolve, 200));
          devices = await navigator.mediaDevices.enumerateDevices();
          videoDevices = devices.filter(device => device.kind === 'videoinput');

          console.log('Camera permissions granted, re-enumerated devices');
        } catch (permError) {
          console.warn('Camera permission request failed, continuing in camera-less mode:', permError);
          setAvailableDevices([]);
          return;
        }
      }

      if (videoDevices.length === 0) {
        console.log('No cameras found - continuing in camera-less mode');
        setAvailableDevices([]);
        return;
      }
      
      setAvailableDevices(videoDevices);
      
      console.log('Available cameras:', videoDevices.map(d => ({
        deviceId: d.deviceId,
        label: d.label || `Camera ${d.deviceId.slice(0, 8)}`,
        facing: getFacingMode(d.label || `Camera ${d.deviceId.slice(0, 8)}`)
      })));
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.warn('Camera enumeration failed, continuing in camera-less mode:', error);
      
      // Don't set as global error - app can still work with audio features
      setAvailableDevices([]);
    } finally {
      setIsEnumerating(false);
    }
  }, [getFacingMode]);

  // Auto-assign cameras when devices are available (only when autoStart is true)
  useEffect(() => {
    if (!autoStart) return;
    if (availableDevices.length > 0) {
      autoAssignCameras();
    } else {
      console.log('No cameras available - app will work in camera-less mode with audio features only');
    }
  }, [autoStart, availableDevices, autoAssignCameras]);

  // Initialize devices on mount
  useEffect(() => {
    enumerateDevices();
  }, [enumerateDevices]);

  // Get user-facing camera stream
  const getUserCamera = useCallback(() => {
    const cameraArray = Array.from(cameras.values());
    return cameraArray.find(camera => 
      camera.facing === 'user' && camera.isActive && camera.stream
    ) || null;
  }, [cameras]);

  // Get environment-facing camera stream
  const getEnvironmentCamera = useCallback(() => {
    const cameraArray = Array.from(cameras.values());
    return cameraArray.find(camera => 
      camera.facing === 'environment' && camera.isActive && camera.stream
    ) || null;
  }, [cameras]);

  // Stop all cameras
  const stopAllCameras = useCallback(() => {
    Array.from(cameras.values()).forEach(camera => {
      if (camera.stream) {
        camera.stream.getTracks().forEach((track: MediaStreamTrack) => track.stop());
      }
    });
    setCameras(new Map());
    console.log('All cameras stopped');
  }, [cameras]);

  // Capture frame from specific camera
  const captureFrameFromCamera = useCallback(async (deviceId: string): Promise<Blob | null> => {
    const camera = cameras.get(deviceId);
    if (!camera || !camera.stream || !camera.isActive) {
      console.log(`Camera ${deviceId} not available for capture`);
      return null;
    }

    try {
      const video = document.createElement('video');
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      if (!ctx) return null;

      video.srcObject = camera.stream;
      video.muted = true;
      video.playsInline = true;

      return new Promise((resolve) => {
        const cleanup = () => {
          video.pause();
          video.srcObject = null;
          video.remove();
          canvas.remove();
        };

        video.addEventListener('loadedmetadata', () => {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          
          video.addEventListener('canplay', () => {
            try {
              ctx.drawImage(video, 0, 0);
              canvas.toBlob((blob) => {
                cleanup();
                resolve(blob);
              }, 'image/jpeg', 0.8);
            } catch (drawError) {
              console.error("Error drawing video frame:", drawError);
              cleanup();
              resolve(null);
            }
          }, { once: true });
        }, { once: true });

        video.addEventListener('error', (err) => {
          console.error("Video element error:", err);
          cleanup();
          resolve(null);
        });

        video.play().catch(err => {
          console.error("Video play error:", err);
          cleanup();
          resolve(null);
        });
      });
    } catch (err) {
      console.error("Frame capture error:", err);
      return null;
    }
  }, [cameras]);

  return {
    availableDevices,
    cameras: Array.from(cameras.values()),
    isEnumerating,
    globalError,
    enumerateDevices,
    startCamera,
    stopCamera,
    stopAllCameras,
    getUserCamera,
    getEnvironmentCamera,
    captureFrameFromCamera,
    autoAssignCameras,
    isMultiCameraActive: cameras.size > 1,
    userCameraActive: getUserCamera() !== null,
    environmentCameraActive: getEnvironmentCamera() !== null
  };
}