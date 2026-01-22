import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Camera, AlertCircle, CheckCircle, Loader2, RefreshCw } from "lucide-react";
import { useCamera } from "@/hooks/useCamera";

export function CameraActivationButton() {
  const [isActivating, setIsActivating] = useState(false);
  const { isActive, error, startCamera, stopCamera } = useCamera();

  const handleActivateCamera = async () => {
    if (isActive) {
      stopCamera();
      return;
    }

    setIsActivating(true);
    try {
      // Clear any existing error first
      if (error) {
        // Force a fresh camera permission request
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await startCamera();
    } catch (err) {
      console.error('Failed to activate camera:', err);
    } finally {
      setIsActivating(false);
    }
  };

  const getButtonContent = () => {
    if (isActivating) {
      return (
        <>
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          Activating...
        </>
      );
    }
    
    if (isActive) {
      return (
        <>
          <CheckCircle className="h-4 w-4 mr-2" />
          Camera Active
        </>
      );
    }
    
    return (
      <>
        <Camera className="h-4 w-4 mr-2" />
        Activate Camera
      </>
    );
  };

  const getButtonVariant = () => {
    if (error) return "destructive";
    if (isActive) return "default";
    return "outline";
  };

  const refreshPage = () => {
    window.location.reload();
  };

  return (
    <div className="fixed top-4 left-4 z-50 space-y-2">
      <div className="flex gap-2">
        <Button
          size="sm"
          variant={getButtonVariant()}
          onClick={handleActivateCamera}
          disabled={isActivating}
          className="bg-white/90 backdrop-blur-sm shadow-lg"
        >
          {getButtonContent()}
        </Button>
        
        {error && (
          <Button
            size="sm"
            variant="outline"
            onClick={refreshPage}
            className="bg-white/90 backdrop-blur-sm shadow-lg"
            title="Refresh page to reset camera permissions"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        )}
      </div>
      
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-2 max-w-64">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-red-500 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-red-700">
              <div className="font-medium">Camera Error</div>
              <div className="mt-1">{error}</div>
              <div className="mt-2 text-red-600">
                Please check:
                <ul className="mt-1 space-y-0.5">
                  <li>• Allow camera permissions when prompted</li>
                  <li>• Close other apps using the camera</li>
                  <li>• Click the camera icon in address bar</li>
                  <li>• Try a different browser</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}