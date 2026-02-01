import { createContext, useContext, useState, useEffect, ReactNode } from "react";

export interface CameraDevice {
  deviceId: string;
  label: string;
}

interface CameraContextType {
  stream: MediaStream | null;
  isActive: boolean;
  error: string | null;
  devices: CameraDevice[];
  selectedDeviceId: string | null;
  isInitializing: boolean;
  startCamera: (deviceId?: string) => Promise<void>;
  stopCamera: () => void;
  captureFrame: () => Promise<Blob | null>;
  switchCamera: (deviceId: string) => Promise<void>;
  getAvailableDevices: () => Promise<void>;
}

const CameraContext = createContext<CameraContextType | undefined>(undefined);

interface CameraProviderProps {
  children: ReactNode;
}

export function CameraProvider({ children }: CameraProviderProps) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isActive, setIsActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(false);
  // Note: This CameraProvider is not used by home.tsx - useMultiCamera hook is used instead
  // Camera initialization task is skipped in AppInitializationContext's fallback timeout

  // Get available camera devices
  const getAvailableDevices = async () => {
    try {
      const deviceList = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = deviceList.filter(device => device.kind === 'videoinput');
      const cameraDevices: CameraDevice[] = videoDevices.map(device => ({
        deviceId: device.deviceId,
        label: device.label || `Camera ${device.deviceId.slice(0, 8)}...`
      }));
      setDevices(cameraDevices);
      
      // Prioritize integrated/built-in camera as default
      if (!selectedDeviceId && cameraDevices.length > 0) {
        const integratedCamera = cameraDevices.find(device => {
          const label = device.label.toLowerCase();
          return label.includes('integrated') || 
                 label.includes('built-in') || 
                 label.includes('facetime') ||
                 label.includes('default') ||
                 (!label.includes('external') && !label.includes('usb'));
        });
        
        const defaultCamera = integratedCamera || cameraDevices[0];
        setSelectedDeviceId(defaultCamera.deviceId);
        console.log('Selected default camera:', defaultCamera.label, '(integrated:', !!integratedCamera, ')');
      }
    } catch (err) {
      console.error('Error getting camera devices:', err);
    }
  };

  const startCamera = async (deviceId?: string) => {
    try {
      setError(null);
      
      // Stop existing stream first to prevent conflicts
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
        setStream(null);
        setIsActive(false);
        // Small delay to ensure proper cleanup
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      // Use provided deviceId or selected device or default constraints
      let constraints: MediaStreamConstraints;
      
      if (deviceId) {
        // If specific device requested, try exact match first, then fallback
        constraints = {
          video: { 
            deviceId: { exact: deviceId },
            width: { ideal: 640 },
            height: { ideal: 480 }
          }
        };
      } else if (selectedDeviceId) {
        // Use selected device if available
        constraints = {
          video: { 
            deviceId: { ideal: selectedDeviceId },
            width: { ideal: 640 },
            height: { ideal: 480 }
          }
        };
      } else {
        // Default constraints - try user camera first, then environment
        constraints = {
          video: { 
            width: { ideal: 640 },
            height: { ideal: 480 },
            facingMode: { ideal: "user" } // Try front camera first for user detection
          }
        };
      }

      let mediaStream;
      try {
        mediaStream = await Promise.race([
          navigator.mediaDevices.getUserMedia(constraints),
          new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error('Camera start timeout after 15 seconds')), 15000)
          )
        ]);
      } catch (specificError) {
        console.log('Specific device failed, trying fallback constraints:', specificError);
        // Fallback to any available camera
        const fallbackConstraints: MediaStreamConstraints = {
          video: { 
            width: { ideal: 640 },
            height: { ideal: 480 }
          }
        };
        
        try {
          mediaStream = await Promise.race([
            navigator.mediaDevices.getUserMedia(fallbackConstraints),
            new Promise<never>((_, reject) => 
              setTimeout(() => reject(new Error('Camera fallback timeout')), 20000)
            )
          ]);
        } catch (fallbackError) {
          throw new Error(`Camera access failed: ${fallbackError instanceof Error ? fallbackError.message : 'Unknown error'}`);
        }
      }
      
      setStream(mediaStream);
      setIsActive(true);
      
      // Update selected device if provided
      if (deviceId) {
        setSelectedDeviceId(deviceId);
      }
      
      console.log('Camera started successfully');
    } catch (err: any) {
      const errorMessage = err.message || "Failed to access camera";
      setError(errorMessage);
      console.error("Camera access error:", err);
      
      // Additional error details for debugging
      if (err.name === 'NotFoundError') {
        console.error('Camera device not found - check if camera is connected and permissions granted');
      } else if (err.name === 'NotAllowedError') {
        console.error('Camera access denied - check browser permissions');
      }
    }
  };

  const stopCamera = () => {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
      setIsActive(false);
    }
  };

  const switchCamera = async (deviceId: string) => {
    if (isActive) {
      stopCamera();
    }
    await startCamera(deviceId);
  };

  const captureFrame = async (): Promise<Blob | null> => {
    if (!stream) return null;

    try {
      // Create a canvas to capture the frame
      const video = document.createElement('video');
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      if (!ctx) return null;

      // Set up video
      video.srcObject = stream;
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
          
          // Wait for video to actually start playing
          video.addEventListener('canplay', () => {
            try {
              // Draw current frame
              ctx.drawImage(video, 0, 0);
              
              // Convert to blob
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
  };

  // Camera auto-start disabled: useMultiCamera hook is used instead (see home.tsx).
  // CameraProvider remains mounted for context compatibility but does not claim the device.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { return () => stopCamera(); }, []);

  // Load available devices on mount
  useEffect(() => {
    getAvailableDevices();
    
    // Listen for device changes
    navigator.mediaDevices.addEventListener('devicechange', getAvailableDevices);
    
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', getAvailableDevices);
    };
  }, []);

  const value: CameraContextType = {
    stream,
    isActive,
    error,
    devices,
    selectedDeviceId,
    isInitializing,
    startCamera,
    stopCamera,
    captureFrame,
    switchCamera,
    getAvailableDevices,
  };

  return (
    <CameraContext.Provider value={value}>
      {children}
    </CameraContext.Provider>
  );
}

export function useCamera(): CameraContextType {
  const context = useContext(CameraContext);
  if (context === undefined) {
    throw new Error('useCamera must be used within a CameraProvider');
  }
  return context;
}
