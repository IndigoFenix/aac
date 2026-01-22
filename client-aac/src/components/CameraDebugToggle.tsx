import { useState } from "react";
import { Camera, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface CameraDebugToggleProps {
  onToggle: () => void;
}

export function CameraDebugToggle({ onToggle }: CameraDebugToggleProps) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onToggle}
      className="fixed z-40 bg-white/90 dark:bg-gray-900/90 backdrop-blur-sm border border-gray-300 dark:border-gray-600 hover:bg-white dark:hover:bg-gray-800 shadow-lg"
      style={{ bottom: '1rem', right: '8rem' }}
      title="Open Multi-Camera Debug Window"
    >
      <Camera className="h-4 w-4 mr-1" />
      Video
    </Button>
  );
}