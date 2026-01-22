import { useState, useEffect } from "react";
import { useCamera } from "@/hooks/useCamera";
import { useMultiCamera } from "@/hooks/useMultiCamera";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, fetchWithAuth } from "@/lib/queryClient";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Camera, RefreshCw, CheckCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export function CameraSelection() {
  const { 
    devices, 
    selectedDeviceId, 
    switchCamera, 
    getAvailableDevices,
    isActive
  } = useCamera();
  
  // Multi-camera support
  const {
    cameras: multiCameras,
    isMultiCameraActive,
    userCameraActive,
    environmentCameraActive,
    getUserCamera,
    getEnvironmentCamera
  } = useMultiCamera();
  
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Get user data to load saved camera selection
  const { data: user, isLoading: userLoading, error: userError } = useQuery({
    queryKey: ["/auth/user"],
  });

  // In self-use mode, the user ID is used as the student ID
  const studentId = (user as any)?.id;

  console.log("CameraSelection - User data:", { user, studentId, userLoading, userError });
  console.log("CameraSelection - Multi-camera status:", { 
    isMultiCameraActive, 
    userCameraActive, 
    environmentCameraActive,
    multiCamerasCount: multiCameras.length 
  });

  // Save camera selection mutation
  const saveCameraMutation = useMutation({
    mutationFn: async (cameraId: string) => {
      if (!studentId) throw new Error("Student not found");

      console.log("Saving camera selection:", { studentId, cameraId });

      const response = await apiRequest("PATCH", `/api/students/${studentId}`, { selectedCameraId: cameraId });
      const result = await response.json();
      console.log("Camera save successful:", result);
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/auth/user"] });
      queryClient.invalidateQueries({ queryKey: ["/api/students", studentId] });
      toast({
        title: "Camera saved",
        description: "Your camera selection has been saved successfully.",
      });
    },
    onError: (error) => {
      console.error("Failed to save camera selection:", error);
      toast({
        title: "Save failed",
        description: "Could not save camera selection. Please try again.",
        variant: "destructive",
      });
    },
  });

  // Handle camera selection change
  const handleCameraChange = async (deviceId: string) => {
    try {
      // Switch to the new camera
      await switchCamera(deviceId);
      
      // Save selection to database
      saveCameraMutation.mutate(deviceId);
    } catch (error) {
      console.error("Failed to switch camera:", error);
      toast({
        title: "Camera switch failed",
        description: "Could not switch to selected camera. Please try again.",
        variant: "destructive",
      });
    }
  };

  // Refresh available cameras
  const handleRefreshCameras = async () => {
    setIsRefreshing(true);
    try {
      await getAvailableDevices();
      toast({
        title: "Cameras refreshed",
        description: "Camera list has been updated.",
      });
    } catch (error) {
      toast({
        title: "Refresh failed",
        description: "Could not refresh camera list.",
        variant: "destructive",
      });
    } finally {
      setIsRefreshing(false);
    }
  };

  // Load saved camera on user data change
  useEffect(() => {
    const savedCameraId = (user as any)?.selectedCameraId;
    if (savedCameraId && devices.length > 0) {
      const savedCamera = devices.find(d => d.deviceId === savedCameraId);
      if (savedCamera && selectedDeviceId !== savedCameraId) {
        switchCamera(savedCameraId).catch(console.error);
      }
    }
  }, [user, devices, selectedDeviceId, switchCamera]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Label htmlFor="camera-select" className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Camera Device
        </Label>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefreshCameras}
          disabled={isRefreshing}
          className="h-8"
        >
          <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          <span className="sr-only">Refresh cameras</span>
        </Button>
      </div>

      <div className="space-y-2">
        <Select
          value={selectedDeviceId || ""}
          onValueChange={handleCameraChange}
          disabled={devices.length === 0 || saveCameraMutation.isPending}
        >
          <SelectTrigger id="camera-select" className="w-full">
            <div className="flex items-center gap-2">
              <Camera className="h-4 w-4" />
              <SelectValue placeholder="Select a camera..." />
            </div>
          </SelectTrigger>
          <SelectContent>
            {devices.length === 0 ? (
              <SelectItem value="no-devices" disabled>
                No cameras detected
              </SelectItem>
            ) : (
              devices.map((device) => (
                <SelectItem key={device.deviceId} value={device.deviceId}>
                  <div className="flex items-center gap-2">
                    {device.label}
                    {selectedDeviceId === device.deviceId && (
                      <CheckCircle className="h-4 w-4 text-green-500" />
                    )}
                  </div>
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>

        {/* Multi-camera status display */}
        {isMultiCameraActive && (
          <div className="space-y-2 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-md border border-blue-200 dark:border-blue-800">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
              <span className="text-sm font-medium text-blue-700 dark:text-blue-300">
                Multi-Camera Mode Active ({multiCameras.length} cameras)
              </span>
            </div>
            <div className="text-xs text-blue-600 dark:text-blue-400 space-y-1">
              {userCameraActive && (
                <div className="flex items-center gap-2">
                  <span className="w-1 h-1 bg-green-500 rounded-full"></span>
                  <span>User Camera (Person Detection): {getUserCamera()?.label}</span>
                </div>
              )}
              {environmentCameraActive && (
                <div className="flex items-center gap-2">
                  <span className="w-1 h-1 bg-orange-500 rounded-full"></span>
                  <span>Environment Camera (Context): {getEnvironmentCamera()?.label}</span>
                </div>
              )}
              {multiCameras.length > 0 && (
                <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  All cameras: {multiCameras.map(c => `${c.label} (${c.facing})`).join(', ')}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Single camera status */}
        {isActive && selectedDeviceId && !isMultiCameraActive && (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Single camera active: {devices.find(d => d.deviceId === selectedDeviceId)?.label}
          </p>
        )}

        {devices.length === 0 && (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            No cameras detected. Make sure cameras are connected and try refreshing.
          </p>
        )}
      </div>
    </div>
  );
}