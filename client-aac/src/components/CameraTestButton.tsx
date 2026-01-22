import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Camera, Download, RotateCcw } from "lucide-react";
import { useCamera } from "@/hooks/useCamera";
import { fetchWithAuth } from "@/lib/queryClient";

export function CameraTestButton() {
  const [isCapturing, setIsCapturing] = useState(false);
  const [lastCapture, setLastCapture] = useState<string | null>(null);
  const [currentCameraInfo, setCurrentCameraInfo] = useState<string>("");
  const { captureFrame, devices, selectedDeviceId, switchCamera, getAvailableDevices } = useCamera();

  // Update camera info when devices or selection changes
  useEffect(() => {
    if (selectedDeviceId && devices.length > 0) {
      const currentDevice = devices.find(d => d.deviceId === selectedDeviceId);
      if (currentDevice) {
        const isIntegrated = currentDevice.label.toLowerCase().includes('integrated') || 
                            currentDevice.label.toLowerCase().includes('built-in') || 
                            currentDevice.label.toLowerCase().includes('facetime');
        setCurrentCameraInfo(`${currentDevice.label} ${isIntegrated ? '(Integrated)' : '(External)'}`);
      }
    }
  }, [selectedDeviceId, devices]);

  const handleTestCapture = async () => {
    if (!captureFrame) return;
    
    setIsCapturing(true);
    try {
      const frame = await captureFrame();
      if (frame) {
        // Create a preview URL for the captured frame
        const url = URL.createObjectURL(frame);
        setLastCapture(url);
        
        console.log('Camera test capture:', {
          size: frame.size,
          type: frame.type,
          timestamp: new Date().toISOString()
        });
        
        // Also test person detection with this frame
        const formData = new FormData();
        formData.append('image', frame, 'test-frame.jpg');
        formData.append('expectedAge', '46');
        formData.append('expectedGender', 'male');
        formData.append('cameraType', 'user');

        const response = await fetchWithAuth('/api/aac/detect-person', {
          method: 'POST',
          body: formData,
        });
        
        if (response.ok) {
          const result = await response.json();
          console.log('Person detection test result:', result);
        } else {
          console.error('Person detection test failed:', response.status);
        }
      } else {
        console.log('Camera test failed: no frame captured');
      }
    } catch (error) {
      console.error('Camera test error:', error);
    } finally {
      setIsCapturing(false);
    }
  };

  const downloadLastCapture = () => {
    if (lastCapture) {
      const a = document.createElement('a');
      a.href = lastCapture;
      a.download = `camera-test-${new Date().getTime()}.jpg`;
      a.click();
    }
  };

  const switchToIntegratedCamera = async () => {
    await getAvailableDevices();
    const integratedCamera = devices.find(device => {
      const label = device.label.toLowerCase();
      return label.includes('integrated') || 
             label.includes('built-in') || 
             label.includes('facetime') ||
             label.includes('default') ||
             (!label.includes('external') && !label.includes('usb'));
    });
    
    if (integratedCamera && integratedCamera.deviceId !== selectedDeviceId) {
      console.log('Switching to integrated camera:', integratedCamera.label);
      await switchCamera(integratedCamera.deviceId);
    } else {
      console.log('Already using integrated camera or none available');
    }
  };

  return (
    <div className="fixed top-4 right-4 z-50 space-y-2">
      {/* Camera Info */}
      {currentCameraInfo && (
        <div className="bg-white/90 backdrop-blur-sm shadow-lg rounded-lg px-3 py-1 text-xs text-gray-700 max-w-64">
          📹 {currentCameraInfo}
        </div>
      )}
      
      {/* Control Buttons */}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={handleTestCapture}
          disabled={isCapturing}
          className="bg-white/90 backdrop-blur-sm shadow-lg"
        >
          <Camera className="h-4 w-4 mr-1" />
          {isCapturing ? 'Testing...' : 'Test Camera'}
        </Button>
        
        <Button
          size="sm"
          variant="outline"
          onClick={switchToIntegratedCamera}
          className="bg-white/90 backdrop-blur-sm shadow-lg"
        >
          <RotateCcw className="h-4 w-4 mr-1" />
          Use Built-in
        </Button>
        
        {lastCapture && (
          <Button
            size="sm"
            variant="outline"
            onClick={downloadLastCapture}
            className="bg-white/90 backdrop-blur-sm shadow-lg"
          >
            <Download className="h-4 w-4 mr-1" />
            Download
          </Button>
        )}
      </div>
      
      {/* Preview */}
      {lastCapture && (
        <div className="bg-white rounded-lg shadow-xl p-2 border max-w-40">
          <img 
            src={lastCapture} 
            alt="Last capture" 
            className="w-full h-24 object-cover rounded"
          />
          <p className="text-xs text-gray-600 mt-1 text-center">Last capture</p>
        </div>
      )}
    </div>
  );
}