import React from 'react';
import { Button } from '@/components/ui/button';
import { Mic, MicOff } from 'lucide-react';

interface AudioToggleProps {
  isOpen: boolean;
  onToggle: () => void;
  isEnabled: boolean;
  isMonitoring: boolean;
}

export function AudioToggle({ isOpen, onToggle, isEnabled, isMonitoring }: AudioToggleProps) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onToggle}
      className={`
        fixed z-40 bg-white/90 dark:bg-gray-900/90 backdrop-blur-sm border border-gray-300 dark:border-gray-600 hover:bg-white dark:hover:bg-gray-800 shadow-lg
        flex items-center gap-2 transition-all duration-200
        ${isOpen ? 'bg-blue-100/90 dark:bg-blue-900/90 border-blue-300 dark:border-blue-700' : ''}
        ${!isEnabled ? 'opacity-60' : ''}
      `}
      style={{ bottom: '1rem', right: '15rem' }}
      title="Audio Context Capture (Beta)"
    >
      {isEnabled && isMonitoring ? (
        <Mic className="w-4 h-4 text-green-500" />
      ) : (
        <MicOff className="w-4 h-4 text-gray-500" />
      )}
      <span className="text-sm">
        Audio
      </span>
      <span className="text-xs bg-orange-100 dark:bg-orange-900 text-orange-700 dark:text-orange-300 px-1.5 py-0.5 rounded-full font-medium">
        BETA
      </span>
    </Button>
  );
}