import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Mic, MicOff, Volume2, VolumeX, Move, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { apiRequest, fetchWithAuth } from '@/lib/queryClient';

interface ChoiceClassification {
  addressee: 'child' | 'other';
  confidence: number;
  intent: 'CHOICE_OFFER' | 'YES_NO_QUESTION' | 'NONE';
  domain?: string;
  context?: string;
  originalText: string;
  language: 'en' | 'he';
  suggestedOptions?: string[];
}

interface PassiveCoListenerProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onChoiceDetected: (options: Array<{ label: string; emoji: string; confidence: number }>) => void;
  studentId?: string;
  language: 'en' | 'he';
  userProfile?: any;
  // Audio context capture props
  showAudioCapture?: boolean;
  onAudioCaptureToggle?: () => void;
  isAudioCaptureEnabled?: boolean;
  isAudioMonitoring?: boolean;
}

interface VADResult {
  isSpeaking: boolean;
  confidence: number;
}

export default function PassiveCoListener({
  enabled,
  onEnabledChange,
  onChoiceDetected,
  studentId,
  language,
  userProfile,
  showAudioCapture = false,
  onAudioCaptureToggle,
  isAudioCaptureEnabled = false,
  isAudioMonitoring = false
}: PassiveCoListenerProps) {
  const [isListening, setIsListening] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [lastDetection, setLastDetection] = useState<ChoiceClassification | null>(null);
  const [vadActive, setVadActive] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 }); // x: 0, y: 0 means use default bottom-right position
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [isExpanded, setIsExpanded] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const vadTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const silenceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const dragRef = useRef<HTMLDivElement>(null);

  // Voice Activity Detection using Web Audio API
  const startVAD = useCallback(() => {
    if (!streamRef.current) {
      console.error('❌ No audio stream available for VAD');
      return;
    }

    console.log('🎵 Starting Voice Activity Detection...');
    audioContextRef.current = new AudioContext();
    const source = audioContextRef.current.createMediaStreamSource(streamRef.current);
    analyserRef.current = audioContextRef.current.createAnalyser();
    analyserRef.current.fftSize = 256;
    
    source.connect(analyserRef.current);

    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
    
    const checkAudioLevel = () => {
      if (!analyserRef.current) return;
      
      analyserRef.current.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
      setAudioLevel(average);
      
      // More frequent logging for debugging
      if (Math.random() < 0.005) { // Log 0.5% of the time to avoid spam
        console.log('🔊 Audio level:', average.toFixed(1));
      }

      // Simple VAD: if audio level is above threshold, consider it speech
      const speechThreshold = 15; // Lowered threshold for better detection
      const isSpeaking = average > speechThreshold;

      if (isSpeaking && !vadActive) {
        console.log('🗣️ Speech detected! Starting recording...', average);
        setVadActive(true);
        startRecording();
        
        // Clear any existing silence timeout
        if (silenceTimeoutRef.current) {
          clearTimeout(silenceTimeoutRef.current);
        }
      } else if (!isSpeaking && vadActive) {
        // Start silence timeout
        if (silenceTimeoutRef.current) {
          clearTimeout(silenceTimeoutRef.current);
        }
        
        silenceTimeoutRef.current = setTimeout(() => {
          console.log('🤫 Silence detected, stopping recording...');
          setVadActive(false);
          stopRecording();
        }, 2000); // 2 seconds of silence to stop recording
      }

      if (isListening) {
        requestAnimationFrame(checkAudioLevel);
      }
    };

    checkAudioLevel();
  }, [isListening, vadActive]);

  const startRecording = useCallback(() => {
    if (!streamRef.current || mediaRecorderRef.current?.state === 'recording') return;

    audioChunksRef.current = [];
    mediaRecorderRef.current = new MediaRecorder(streamRef.current);

    mediaRecorderRef.current.ondataavailable = (event) => {
      audioChunksRef.current.push(event.data);
    };

    mediaRecorderRef.current.onstop = async () => {
      const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
      await processAudioBlob(audioBlob);
    };

    mediaRecorderRef.current.start();
    console.log('🎤 Started recording for choice detection');
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
      console.log('🎤 Stopped recording, processing audio...');
    }
  }, []);

  const processAudioBlob = useCallback(async (audioBlob: Blob) => {
    if (!enabled || audioBlob.size < 1000) return; // Skip very small audio clips

    try {
      const formData = new FormData();
      formData.append('audio', audioBlob, 'recording.webm');
      formData.append('studentId', studentId || '');
      formData.append('language', language);

      console.log('📤 Sending audio for choice classification...');
      
      const response = await fetchWithAuth('/api/aac/choice/classify', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        throw new Error('Failed to classify audio');
      }

      const result: ChoiceClassification = await response.json();
      console.log('🧠 Choice classification result:', result);

      setLastDetection(result);

      // If it's a choice question (lowered threshold for testing)
      if (result.confidence >= 0.4 && 
          (result.intent === 'CHOICE_OFFER' || result.intent === 'YES_NO_QUESTION')) {
        
        console.log('✅ High confidence choice detected, generating AAC cards...');
        
        // Generate appropriate AAC options
        await generateAACOptions(result);
      }
    } catch (error) {
      console.error('❌ Error processing audio for choice detection:', error);
    }
  }, [enabled, studentId, language]);

  const generateAACOptions = useCallback(async (classification: ChoiceClassification) => {
    try {
      console.log('🎯 Generating AAC options for classification:', classification);

      const response = await apiRequest('POST', '/api/aac/choice/generate', {
        classification,
        studentId,
        language,
        context: {
          timeOfDay: new Date().getHours() < 12 ? 'morning' : 
                   new Date().getHours() < 17 ? 'afternoon' : 'evening',
          dayOfWeek: new Date().toLocaleDateString('en-US', { weekday: 'long' }),
        }
      });

      const options = await response.json();
      console.log('💫 Generated AAC options:', options);

      if (options.suggestions && options.suggestions.length > 0) {
        onChoiceDetected(options.suggestions);
      }
    } catch (error) {
      console.error('❌ Error generating AAC options:', error);
    }
  }, [studentId, language, onChoiceDetected]);

  const initializeAudioStream = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      });
      
      streamRef.current = stream;
      setIsListening(true);
      startVAD();
      console.log('🎧 Passive co-listener audio stream initialized');
      console.log('🔊 Enabled state:', enabled, 'User ID:', studentId);
      console.log('🎤 Microphone access granted, VAD starting...');
    } catch (error) {
      console.error('❌ Error accessing microphone:', error);
      setIsListening(false);
    }
  }, [startVAD]);

  const stopAudioStream = useCallback(() => {
    setIsListening(false);
    setVadActive(false);

    if (silenceTimeoutRef.current) {
      clearTimeout(silenceTimeoutRef.current);
    }

    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    console.log('🔇 Passive co-listener stopped');
  }, []);

  // Simple drag handle click handler (Framer Motion handles the actual dragging)
  const handleDragHandleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  // Effect to start/stop listening based on enabled state
  useEffect(() => {
    console.log('🔄 PassiveCoListener effect triggered - Enabled:', enabled, 'Is Listening:', isListening, 'User ID:', studentId);
    
    if (enabled && !isListening) {
      console.log('▶️ Starting passive co-listener...');
      console.log('🔍 Testing microphone permissions...');
      
      // Test microphone access first
      navigator.mediaDevices.getUserMedia({ audio: true })
        .then(stream => {
          console.log('✅ Microphone access granted');
          stream.getTracks().forEach(track => track.stop()); // Clean up test stream
          initializeAudioStream();
        })
        .catch(error => {
          console.error('❌ Microphone access denied:', error);
        });
    } else if (!enabled && isListening) {
      console.log('⏹️ Stopping passive co-listener...');
      stopAudioStream();
    }

    return () => {
      if (isListening) {
        stopAudioStream();
      }
    };
  }, [enabled, isListening, initializeAudioStream, stopAudioStream]);

  console.log('🎭 PassiveCoListener render - Enabled:', enabled, 'UserId:', studentId, 'IsListening:', isListening, 'AudioLevel:', audioLevel, 'VAD:', vadActive, 'Position:', position);

  return (
    <motion.div 
      ref={dragRef}
      className="fixed z-20 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 shadow-lg max-w-sm cursor-move"
      style={{
        left: position.x !== 0 ? `${position.x}px` : 'auto',
        top: position.y !== 0 ? `${position.y}px` : 'auto',
        right: position.x === 0 ? '1rem' : 'auto',
        bottom: position.y === 0 ? '1rem' : 'auto',
      }}
      drag
      dragMomentum={false}
      dragConstraints={{
        left: 0,
        right: typeof window !== 'undefined' ? window.innerWidth - 320 : 0,
        top: 0,
        bottom: typeof window !== 'undefined' ? window.innerHeight - 250 : 0,
      }}
      onDrag={(_, info) => {
        console.log('🚚 Dragging:', info.point);
      }}
      onDragEnd={(_, info) => {
        console.log('🎯 Drag ended:', info.point);
        setPosition({
          x: info.point.x,
          y: info.point.y,
        });
      }}
    >
      <div className="p-4">
        {/* Header with drag handle and controls */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center space-x-2">
            <Move className="h-4 w-4 text-gray-400 cursor-move" onClick={handleDragHandleClick} />
            <div 
              className="h-4 w-4 text-gray-500 cursor-pointer hover:text-gray-700 dark:hover:text-gray-300" 
              onClick={() => setIsExpanded(!isExpanded)}
              title="Toggle expanded view"
            >
              <Settings className="h-4 w-4" />
            </div>
          </div>
          <div className="flex items-center space-x-3">
            {/* Audio Capture Toggle */}
            {onAudioCaptureToggle && (
              <button
                onClick={onAudioCaptureToggle}
                className={`
                  flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors hover:scale-105
                  ${showAudioCapture 
                    ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 border border-blue-300 dark:border-blue-700' 
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 border border-gray-300 dark:border-gray-600 hover:bg-gray-200 dark:hover:bg-gray-600'}
                  ${!isAudioCaptureEnabled ? 'opacity-60' : ''}
                `}
                title="Audio Context Capture (Beta) - Click to toggle"
              >
                {showAudioCapture ? (
                  <Volume2 className="w-3 h-3 text-blue-500" />
                ) : (
                  <VolumeX className="w-3 h-3 text-gray-500" />
                )}
                <span>Capture</span>
                <span className="bg-orange-100 dark:bg-orange-900 text-orange-700 dark:text-orange-300 px-1 py-0.5 rounded-full font-medium">
                  BETA
                </span>
              </button>
            )}
            
            {/* Passive Co-Listener Toggle */}
            <div className="flex flex-col items-end">
              <Switch
                checked={enabled}
                onCheckedChange={onEnabledChange}
              />
              <span className="text-xs mt-1 text-gray-400">
                {enabled ? 'ON' : 'OFF'}
              </span>
            </div>
          </div>
        </div>
        {/* Main Status Display */}
        <div className="flex items-center space-x-3 mb-3">
          <div className="relative">
            {isListening ? (
              <motion.div
                animate={{ scale: vadActive ? [1, 1.2, 1] : 1 }}
                transition={{ repeat: vadActive ? Infinity : 0, duration: 1 }}
              >
                <Mic className={`h-5 w-5 ${vadActive ? 'text-green-500' : 'text-blue-500'}`} />
              </motion.div>
            ) : (
              <MicOff className="h-5 w-5 text-gray-400" />
            )}
            
            {/* Audio level indicator */}
            <div className="absolute -right-1 -top-1">
              <div className={`w-2 h-2 rounded-full ${
                isListening 
                  ? vadActive 
                    ? 'bg-red-500' 
                    : audioLevel > 10 
                      ? 'bg-yellow-500' 
                      : 'bg-green-500'
                  : 'bg-gray-400'
              }`} 
                   style={{ opacity: isListening ? Math.max(0.3, Math.min(audioLevel / 50, 1)) : 0.3 }} />
            </div>
          </div>
          
          <div className="flex-1">
            <h3 className="font-medium text-gray-900 dark:text-white text-sm">
              Audio Debug Monitor
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {!enabled ? 'Disabled - Click toggle to enable' :
               !isListening ? 'Ready - Starting audio stream...' :
               vadActive ? '🗣️ Speech detected! Processing...' : 
               audioLevel > 5 ? `🎤 Audio Level: ${audioLevel.toFixed(1)}` : 
               '👂 Monitoring for speech...'
              }
            </p>
            {showAudioCapture && (
              <p className="text-xs text-purple-600 dark:text-purple-400 mt-1">
                📡 Context capture active
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Expanded view with detailed information */}
      {isExpanded && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          className="border-t border-gray-200 dark:border-gray-700 pt-3 mt-3"
        >
          {/* Status indicators */}
          <div className="grid grid-cols-2 gap-2 mb-3">
            <div className="flex items-center space-x-2 text-xs">
              <div className={`w-2 h-2 rounded-full ${isListening ? 'bg-green-400' : 'bg-gray-400'}`} />
              <span className="text-gray-600 dark:text-gray-400">Audio Stream</span>
            </div>
            
            <div className="flex items-center space-x-2 text-xs">
              <div className={`w-2 h-2 rounded-full ${vadActive ? 'bg-blue-400' : 'bg-gray-400'}`} />
              <span className="text-gray-600 dark:text-gray-400">Voice Detection</span>
            </div>
            
            <div className="flex items-center space-x-2 text-xs">
              <div className={`w-2 h-2 rounded-full ${showAudioCapture ? 'bg-purple-400 animate-pulse' : 'bg-gray-400'}`} />
              <span className="text-gray-600 dark:text-gray-400">Context Capture</span>
            </div>
            
            <div className="flex items-center space-x-2 text-xs">
              <span className="text-gray-600 dark:text-gray-400">Lang: {language.toUpperCase()}</span>
            </div>
          </div>
          
          {/* Audio level bar */}
          {isListening && (
            <div className="mb-3">
              <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
                <span>Audio Level</span>
                <span>{audioLevel.toFixed(1)}</span>
              </div>
              <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                <div 
                  className={`h-2 rounded-full transition-all duration-200 ${
                    vadActive ? 'bg-red-500' : audioLevel > 10 ? 'bg-yellow-500' : 'bg-green-500'
                  }`}
                  style={{ width: `${Math.min(audioLevel * 2, 100)}%` }}
                />
              </div>
            </div>
          )}
        </motion.div>
      )}

      {/* Last detection display */}
      {lastDetection && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-4 p-3 bg-gray-50 dark:bg-gray-700 rounded-lg"
        >
          <div className="text-sm">
            <div className="flex items-center justify-between mb-2">
              <span className="font-medium">Last Detection:</span>
              <span className={`px-2 py-1 rounded text-xs ${
                lastDetection.confidence >= 0.6 
                  ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                  : lastDetection.confidence >= 0.4
                  ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'
                  : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
              }`}>
                {Math.round(lastDetection.confidence * 100)}% confidence
              </span>
            </div>
            
            <p className="text-gray-600 dark:text-gray-300 mb-1">
              "{lastDetection.originalText}"
            </p>
            
            <div className="flex flex-wrap gap-2 text-xs text-gray-500 dark:text-gray-400">
              <span>Addressee: {lastDetection.addressee}</span>
              <span>Intent: {lastDetection.intent}</span>
              {lastDetection.domain && <span>Domain: {lastDetection.domain}</span>}
              {lastDetection.context && <span>Context: {lastDetection.context}</span>}
            </div>
          </div>
        </motion.div>
      )}
    </motion.div>
  );
}