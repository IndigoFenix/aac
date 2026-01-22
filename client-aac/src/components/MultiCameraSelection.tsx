import { useState, useEffect } from "react";
import { RefreshCw, Camera, Video, VideoOff, Monitor, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useMultiCamera } from "@/hooks/useMultiCamera";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

interface MultiCameraSelectionProps {
  studentId?: string;
  userProfile?: any;
  onSettingsChange?: (settings: any) => void;
}

export function MultiCameraSelection({ studentId, userProfile, onSettingsChange }: MultiCameraSelectionProps) {
  const [enableMultiCamera, setEnableMultiCamera] = useState(false);
  const [selectedUserCamera, setSelectedUserCamera] = useState<string>('');
  const [selectedEnvironmentCamera, setSelectedEnvironmentCamera] = useState<string>('');
  const [autoDetectCameras, setAutoDetectCameras] = useState(true);
  
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const {
    availableDevices,
    cameras,
    activeCameras,
    userCamera,
    environmentCamera,
    isEnumerating,
    globalError,
    startCamera,
    stopCamera,
    enumerateDevices
  } = useMultiCamera();

  // Load settings from user profile
  useEffect(() => {
    if (userProfile) {
      setEnableMultiCamera(userProfile.enableMultiCamera || false);
      setSelectedUserCamera(userProfile.selectedUserCamera || '');
      setSelectedEnvironmentCamera(userProfile.selectedEnvironmentCamera || '');
      setAutoDetectCameras(userProfile.autoDetectCameras !== undefined ? userProfile.autoDetectCameras : true);
    }
  }, [userProfile]);

  // Save settings mutation
  const saveSettingsMutation = useMutation({
    mutationFn: async (settings: any) => {
      if (!studentId) throw new Error("Student not found");

      const response = await apiRequest("PATCH", `/api/students/${studentId}`, settings);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] });
      queryClient.invalidateQueries({ queryKey: ["/api/students", studentId] });
      toast({
        title: "Settings saved",
        description: "Multi-camera settings have been saved successfully.",
      });
    },
    onError: (error) => {
      console.error("Failed to save camera settings:", error);
      toast({
        title: "Save failed",
        description: "Could not save camera settings. Please try again.",
        variant: "destructive",
      });
    },
  });

  // Handle settings changes
  const handleSettingsChange = (newSettings: any) => {
    const settings = {
      enableMultiCamera,
      selectedUserCamera,
      selectedEnvironmentCamera,
      autoDetectCameras,
      ...newSettings
    };
    
    onSettingsChange?.(settings);
    saveSettingsMutation.mutate(settings);
  };

  // Auto-detect cameras based on labels
  const detectCameraTypes = () => {
    const userCam = availableDevices.find(d => 
      d.label.toLowerCase().includes('front') || 
      d.label.toLowerCase().includes('user') ||
      d.label.toLowerCase().includes('facetime')
    );
    
    const envCam = availableDevices.find(d => 
      d.label.toLowerCase().includes('back') || 
      d.label.toLowerCase().includes('rear') ||
      d.label.toLowerCase().includes('environment')
    );

    if (userCam && userCam.deviceId !== selectedUserCamera) {
      setSelectedUserCamera(userCam.deviceId);
    }
    
    if (envCam && envCam.deviceId !== selectedEnvironmentCamera) {
      setSelectedEnvironmentCamera(envCam.deviceId);
    }
  };

  // Auto-detect when enabled
  useEffect(() => {
    if (autoDetectCameras && availableDevices.length > 0) {
      detectCameraTypes();
    }
  }, [autoDetectCameras, availableDevices]);

  // Start/stop cameras based on selections
  const handleUserCameraChange = async (deviceId: string) => {
    const actualDeviceId = deviceId === 'none' ? '' : deviceId;
    setSelectedUserCamera(actualDeviceId);
    
    if (enableMultiCamera && actualDeviceId) {
      try {
        await startCamera(actualDeviceId);
        handleSettingsChange({ selectedUserCamera: actualDeviceId });
      } catch (error) {
        console.error('Failed to start user camera:', error);
        toast({
          title: "Camera error",
          description: "Failed to start user camera. Please check permissions.",
          variant: "destructive",
        });
      }
    } else if (enableMultiCamera && !actualDeviceId) {
      // Stop user camera if none selected
      handleSettingsChange({ selectedUserCamera: '' });
    }
  };

  const handleEnvironmentCameraChange = async (deviceId: string) => {
    const actualDeviceId = deviceId === 'none' ? '' : deviceId;
    setSelectedEnvironmentCamera(actualDeviceId);
    
    if (enableMultiCamera && actualDeviceId) {
      try {
        await startCamera(actualDeviceId);
        handleSettingsChange({ selectedEnvironmentCamera: actualDeviceId });
      } catch (error) {
        console.error('Failed to start environment camera:', error);
        toast({
          title: "Camera error",
          description: "Failed to start environment camera. Please check permissions.",
          variant: "destructive",
        });
      }
    } else if (enableMultiCamera && !actualDeviceId) {
      // Stop environment camera if none selected
      handleSettingsChange({ selectedEnvironmentCamera: '' });
    }
  };

  const handleEnableMultiCamera = (enabled: boolean) => {
    setEnableMultiCamera(enabled);
    
    if (!enabled) {
      // Stop all cameras when disabling multi-camera
      activeCameras.forEach(camera => {
        stopCamera(camera.id);
      });
    }
    
    handleSettingsChange({ enableMultiCamera: enabled });
  };

  const getFacingIcon = (deviceId: string) => {
    const device = availableDevices.find(d => d.deviceId === deviceId);
    if (!device) return <Camera className="h-4 w-4" />;
    
    const label = device.label.toLowerCase();
    if (label.includes('front') || label.includes('user') || label.includes('facetime')) {
      return <Smartphone className="h-4 w-4" />;
    } else if (label.includes('back') || label.includes('rear') || label.includes('environment')) {
      return <Monitor className="h-4 w-4" />;
    }
    return <Camera className="h-4 w-4" />;
  };

  const getCameraStatus = (deviceId: string) => {
    const camera = cameras.find(c => c.deviceId === deviceId);
    return camera?.isActive ? 'Active' : 'Inactive';
  };

  return (
    <div className="space-y-4">
      {/* Multi-Camera Toggle */}
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-sm font-medium">Multi-Camera Mode</Label>
          <p className="text-xs text-gray-500">Enable simultaneous multiple camera streams</p>
        </div>
        <Switch
          checked={enableMultiCamera}
          onCheckedChange={handleEnableMultiCamera}
        />
      </div>

      {enableMultiCamera && (
        <div className="space-y-4 pl-4 border-l-2 border-blue-100 dark:border-blue-900">
          {/* Auto-detect Toggle */}
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">Auto-detect camera types</Label>
            <Switch
              checked={autoDetectCameras}
              onCheckedChange={(checked) => {
                setAutoDetectCameras(checked);
                if (checked) detectCameraTypes();
                handleSettingsChange({ autoDetectCameras: checked });
              }}
            />
          </div>

          {/* Camera Refresh */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">Available cameras: {availableDevices.length}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={enumerateDevices}
              disabled={isEnumerating}
              className="flex items-center gap-2"
            >
              <RefreshCw className={`h-4 w-4 ${isEnumerating ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>

          {/* Error Display */}
          {globalError && (
            <div className="p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-xs text-red-600 dark:text-red-400">
              {globalError}
            </div>
          )}

          {/* User Camera Selection */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Smartphone className="h-4 w-4 text-blue-600" />
              <Label className="text-sm font-medium">User Camera (Front-facing)</Label>
              {selectedUserCamera && (
                <span className={`text-xs px-2 py-1 rounded ${
                  getCameraStatus(selectedUserCamera) === 'Active' 
                    ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                    : 'bg-gray-100 text-gray-700 dark:bg-gray-900 dark:text-gray-300'
                }`}>
                  {getCameraStatus(selectedUserCamera)}
                </span>
              )}
            </div>
            <Select value={selectedUserCamera || 'none'} onValueChange={handleUserCameraChange}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select user camera" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {availableDevices.map(device => (
                  <SelectItem key={device.deviceId} value={device.deviceId}>
                    <div className="flex items-center gap-2">
                      {getFacingIcon(device.deviceId)}
                      <span className="truncate">{device.label || `Camera ${device.deviceId.slice(0, 8)}`}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Environment Camera Selection */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Monitor className="h-4 w-4 text-green-600" />
              <Label className="text-sm font-medium">Environment Camera (Rear-facing)</Label>
              {selectedEnvironmentCamera && (
                <span className={`text-xs px-2 py-1 rounded ${
                  getCameraStatus(selectedEnvironmentCamera) === 'Active' 
                    ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                    : 'bg-gray-100 text-gray-700 dark:bg-gray-900 dark:text-gray-300'
                }`}>
                  {getCameraStatus(selectedEnvironmentCamera)}
                </span>
              )}
            </div>
            <Select value={selectedEnvironmentCamera || 'none'} onValueChange={handleEnvironmentCameraChange}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select environment camera" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {availableDevices.map(device => (
                  <SelectItem key={device.deviceId} value={device.deviceId}>
                    <div className="flex items-center gap-2">
                      {getFacingIcon(device.deviceId)}
                      <span className="truncate">{device.label || `Camera ${device.deviceId.slice(0, 8)}`}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Active Cameras Summary */}
          {activeCameras && activeCameras.length > 0 && (
            <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
              <div className="text-sm font-medium text-blue-900 dark:text-blue-100 mb-2">
                Active Cameras ({activeCameras.length})
              </div>
              <div className="space-y-1">
                {activeCameras.map(camera => (
                  <div key={camera.id} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      {camera.facing === 'user' ? (
                        <Smartphone className="h-3 w-3 text-blue-600" />
                      ) : camera.facing === 'environment' ? (
                        <Monitor className="h-3 w-3 text-green-600" />
                      ) : (
                        <Camera className="h-3 w-3 text-gray-600" />
                      )}
                      <span className="truncate text-blue-800 dark:text-blue-200">{camera.label}</span>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => stopCamera(camera.id)}
                      className="h-5 w-5 p-0 text-red-600 hover:text-red-700"
                    >
                      <VideoOff className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}