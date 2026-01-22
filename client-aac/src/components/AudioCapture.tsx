import React, { useState, useRef, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Mic, Volume2, Minimize2, Maximize2, X, Move, TestTube2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { fetchWithAuth } from '@/lib/queryClient';

interface AudioAnalysisContext {
  transcript: string;
  detectedLanguage?: string;
  confidence: number;
  ambientSounds: string[];
  speechPresent: boolean;
  timestamp: Date;
}

interface AudioCaptureProps {
  onAudioProcessed?: (context: AudioAnalysisContext) => void;
  className?: string;
  enabled?: boolean; // Allow disabling the audio monitoring
  isVisible?: boolean; // Control visibility from parent
  onClose?: () => void; // Callback when window is closed
}

export function AudioCapture({ onAudioProcessed, className, enabled = true, isVisible = true, onClose }: AudioCaptureProps) {
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [audioContext, setAudioContext] = useState<AudioAnalysisContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  
  // Floating window state
  const [isMinimized, setIsMinimized] = useState(false);
  const [position, setPosition] = useState({ x: 20, y: 20 });
  const [isDragging, setIsDragging] = useState(false);
  
  // Handle close button click
  const handleClose = () => {
    onClose?.();
  };
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<globalThis.AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Start continuous audio monitoring on component mount (if enabled)
  useEffect(() => {
    if (enabled) {
      startContinuousMonitoring();
    } else {
      stopContinuousMonitoring();
    }
    return () => {
      stopContinuousMonitoring();
    };
  }, [enabled]);

  const startContinuousMonitoring = async () => {
    try {
      setError(null);
      console.log('Starting continuous audio monitoring...');

      // Check if mediaDevices API is available
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Audio capture not supported in this browser');
      }

      // First, enumerate audio input devices to see what's available
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(device => device.kind === 'audioinput');
      console.log('Available audio input devices:', audioInputs.map(d => ({
        deviceId: d.deviceId.slice(0, 8),
        label: d.label || 'Unknown microphone',
        groupId: d.groupId
      })));

      // Get microphone access with better error handling
      console.log('Requesting microphone permission...');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 44100,
          // Don't specify deviceId to use default microphone
          // deviceId: audioInputs.length > 0 ? audioInputs[0].deviceId : undefined
        }
      });

      console.log('Microphone access granted! Stream tracks:', stream.getTracks().map(track => ({
        kind: track.kind,
        label: track.label,
        enabled: track.enabled,
        readyState: track.readyState
      })));

      console.log('✅ Audio monitoring system initialized successfully');

      streamRef.current = stream;

      // Setup audio level monitoring
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioContextRef.current = audioCtx;
      
      const analyser = audioCtx.createAnalyser();
      analyserRef.current = analyser;
      
      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);
      
      analyser.fftSize = 256;
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      // Monitor audio levels with debugging
      const monitorAudioLevel = () => {
        if (analyserRef.current) {
          analyserRef.current.getByteFrequencyData(dataArray);
          const average = dataArray.reduce((sum, value) => sum + value, 0) / bufferLength;
          
          // Add debugging to see if we're getting audio data
          if (average > 0) {
            console.log('Audio level detected:', average, 'Raw data sample:', dataArray.slice(0, 5));
          }
          
          setAudioLevel(average);
        }
        // Continue monitoring as long as we have an analyser (independent of isMonitoring state for level display)
        if (analyserRef.current) {
          requestAnimationFrame(monitorAudioLevel);
        }
      };

      // Setup continuous recording
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus'
      });

      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        if (chunksRef.current.length > 0) {
          const audioBlob = new Blob(chunksRef.current, { type: 'audio/webm' });
          await processAudio(audioBlob);
          chunksRef.current = [];
        }
      };

      // Start recording in 15-second intervals
      const startRecordingCycle = () => {
        if (mediaRecorderRef.current && isMonitoring) {
          // Check if recorder is already recording to prevent error
          if (mediaRecorderRef.current.state === 'recording') {
            console.log('MediaRecorder already recording, waiting for next cycle...');
            return;
          }
          
          console.log('Starting 15-second audio capture cycle...');
          try {
            mediaRecorderRef.current.start();
          } catch (error) {
            console.error('Failed to start recording:', error);
            return;
          }
          
          setTimeout(() => {
            if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
              try {
                mediaRecorderRef.current.stop();
              } catch (error) {
                console.error('Failed to stop recording:', error);
              }
              
              // Start next cycle after a brief pause
              setTimeout(() => {
                if (isMonitoring && mediaRecorderRef.current) {
                  startRecordingCycle();
                }
              }, 2000); // 2 seconds pause between cycles
            }
          }, 15000); // 15 seconds recording duration
        }
      };

      startRecordingCycle();
      // Set monitoring state and start audio level monitoring
      setIsMonitoring(true);
      console.log('Starting audio level monitoring with analyser:', {
        fftSize: analyser.fftSize,
        bufferLength,
        sampleRate: audioCtx.sampleRate
      });
      monitorAudioLevel();

    } catch (err) {
      console.error('Error starting continuous monitoring:', err);
      
      // Provide specific error messages for common issues
      let userFriendlyError = 'Failed to access microphone';
      if (err instanceof Error) {
        const errorMessage = err.message;
        if (errorMessage.includes('Permission denied') || errorMessage.includes('NotAllowedError')) {
          userFriendlyError = 'Microphone permission denied. Please allow microphone access in your browser settings.';
        } else if (errorMessage.includes('NotFoundError') || errorMessage.includes('No audio input')) {
          userFriendlyError = 'No microphone found. Please check that a microphone is connected.';
        } else if (errorMessage.includes('NotReadableError')) {
          userFriendlyError = 'Microphone is being used by another application. Please close other apps using the microphone.';
        } else if (errorMessage.includes('NotSupportedError')) {
          userFriendlyError = 'Audio capture not supported in this browser. Please use Chrome, Firefox, or Safari.';
        }
      }
      
      setError(userFriendlyError);
    }
  };

  // Manual test function to check microphone permissions
  const testMicrophoneAccess = async () => {
    try {
      setError(null);
      console.log('Testing microphone access...');
      
      // First check if MediaDevices API is available
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Audio capture not supported in this browser');
      }

      // Try to get microphone access
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log('Microphone test successful! Available tracks:', stream.getTracks().map(track => ({
        kind: track.kind,
        label: track.label,
        enabled: track.enabled
      })));
      
      // Stop the test stream immediately
      stream.getTracks().forEach(track => track.stop());
      
      setError('✅ Microphone test successful! Audio monitoring should work.');
      return true;
    } catch (error) {
      console.error('Microphone test failed:', error);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      setError(`❌ Microphone test failed: ${errorMsg}`);
      return false;
    }
  };

  const stopContinuousMonitoring = () => {
    console.log('Stopping continuous audio monitoring...');
    setIsMonitoring(false);

    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }

    // Safely stop MediaRecorder with error handling
    if (mediaRecorderRef.current) {
      try {
        if (mediaRecorderRef.current.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
      } catch (error) {
        console.error('Error stopping MediaRecorder:', error);
      }
      mediaRecorderRef.current = null;
    }

    // Stop all audio tracks
    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach(track => track.stop());
      } catch (error) {
        console.error('Error stopping audio tracks:', error);
      }
      streamRef.current = null;
    }

    // Close audio context
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      try {
        audioContextRef.current.close();
      } catch (error) {
        console.error('Error closing audio context:', error);
      }
      audioContextRef.current = null;
    }

    setAudioLevel(0);
  };

  const processAudio = async (audioBlob: Blob) => {
    try {
      setIsProcessing(true);
      setError(null);

      console.log('Processing audio blob size:', audioBlob.size, 'bytes');

      if (audioBlob.size < 1000) {
        console.log('Audio blob too small, skipping processing');
        setIsProcessing(false);
        return;
      }

      const formData = new FormData();
      formData.append('audio', audioBlob, 'ambient_recording.webm');

      console.log('Sending audio to Gemini API for processing...');
      const response = await fetchWithAuth('/api/aac/audio/process', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Audio processing failed:', response.status, errorText);
        throw new Error(`HTTP error! status: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      console.log('Gemini audio analysis result:', result);
      
      const context: AudioAnalysisContext = {
        transcript: result.transcript || '',
        detectedLanguage: result.detectedLanguage,
        confidence: result.confidence || 0,
        ambientSounds: result.ambientSounds || [],
        speechPresent: result.speechPresent || false,
        timestamp: new Date(result.timestamp)
      };

      // Only update if we got meaningful results
      if (context.transcript || context.ambientSounds.length > 0) {
        console.log('Updating audio context:', context);
        setAudioContext(context);
        onAudioProcessed?.(context);
      }

    } catch (err) {
      console.error('Error processing audio:', err);
      setError(`Audio processing failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const clearAudioContext = () => {
    setAudioContext(null);
    setError(null);
  };

  // Drag handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('drag-handle')) {
      setIsDragging(true);
      const startX = e.clientX - position.x;
      const startY = e.clientY - position.y;

      const handleMouseMove = (e: MouseEvent) => {
        setPosition({
          x: e.clientX - startX,
          y: e.clientY - startY,
        });
      };

      const handleMouseUp = () => {
        setIsDragging(false);
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }
  };

  if (!isVisible) {
    return null;
  }

  return (
    <motion.div
      className="fixed z-50 select-none"
      style={{
        left: position.x,
        top: position.y,
        cursor: isDragging ? 'grabbing' : 'grab',
      }}
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3 }}
    >
        <Card className={`w-72 bg-blue-900/95 backdrop-blur-sm border-blue-700 text-white shadow-2xl ${className}`}>
          <CardHeader className="drag-handle pb-2" onMouseDown={handleMouseDown}>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-white">
                <Mic className="w-5 h-5 text-blue-300" />
                Audio Context Capture
                <span className="text-xs bg-orange-100 dark:bg-orange-900 text-orange-700 dark:text-orange-300 px-2 py-0.5 rounded-full font-medium">
                  BETA
                </span>
              </CardTitle>
              
              {/* Window Controls */}
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 text-white hover:bg-blue-700"
                  onClick={() => setIsMinimized(!isMinimized)}
                >
                  {isMinimized ? <Maximize2 className="h-3 w-3" /> : <Minimize2 className="h-3 w-3" />}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 text-white hover:bg-blue-700"
                  onClick={handleClose}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            </div>
          </CardHeader>
          
          {/* Content */}
          {!isMinimized && (
            <CardContent className="space-y-4">
              {/* Monitoring Status */}
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  {isMonitoring ? (
                    <motion.div
                      className="flex items-center space-x-2 text-green-500"
                      animate={{ opacity: [0.7, 1, 0.7] }}
                      transition={{ duration: 2, repeat: Infinity }}
                    >
                      <Mic className="w-4 h-4" />
                      <span className="text-sm font-medium">Listening...</span>
                    </motion.div>
                  ) : (
                    <div className="flex items-center space-x-2 text-gray-500">
                      <Mic className="w-4 h-4" />
                      <span className="text-sm">Audio Monitoring Disabled</span>
                    </div>
                  )}
                </div>

                {/* Audio Level Indicator */}
                {isMonitoring && (
                  <div className="flex items-center space-x-2">
                    <Volume2 className="w-3 h-3 text-blue-500" />
                    <div className="w-16 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                      <motion.div
                        className="h-full bg-blue-500"
                        style={{ width: `${Math.min(100, (audioLevel / 128) * 100)}%` }}
                        transition={{ duration: 0.1 }}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Processing Indicator */}
              {isProcessing && enabled && (
                <motion.div
                  className="flex items-center justify-center space-x-2 text-blue-500"
                  animate={{ opacity: [0.5, 1, 0.5] }}
                  transition={{ duration: 1, repeat: Infinity }}
                >
                  <div className="w-2 h-2 bg-blue-500 rounded-full" />
                  <span className="text-sm font-medium">Processing with Whisper...</span>
                </motion.div>
              )}

              {/* Test Microphone Button - Always Available */}
              <div className="flex justify-between items-center mb-2">
                <span className="text-sm text-gray-300">Test audio system:</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={testMicrophoneAccess}
                  className="text-xs bg-blue-800 border-blue-600 hover:bg-blue-700 text-white"
                >
                  <TestTube2 className="w-3 h-3 mr-1" />
                  Test Microphone
                </Button>
              </div>

              {/* Disabled State */}
              {!enabled && (
                <div className="p-3 bg-blue-800/50 border border-blue-600 rounded-md">
                  <div className="flex items-center space-x-2 text-blue-200">
                    <span>🔇</span>
                    <span className="text-sm">Audio monitoring disabled in settings</span>
                  </div>
                </div>
              )}

              {/* Error Display */}
              {error && enabled && (
                <div className="p-3 bg-red-900/50 border border-red-600 rounded-md">
                  <p className="text-sm text-red-200">{error}</p>
                </div>
              )}

              {/* Audio Context Results */}
              {audioContext && enabled && (
                <div className="space-y-3">
                  <div className="p-3 bg-green-900/30 border border-green-600 rounded-md">
                    <h4 className="font-medium text-green-200 mb-2">
                      Audio Analysis Results
                    </h4>
                    
                    {/* Transcript */}
                    {audioContext.transcript && (
                      <div className="mb-2">
                        <p className="text-xs text-green-300 font-medium">Transcript:</p>
                        <p className="text-sm text-green-100 italic">
                          "{audioContext.transcript}"
                        </p>
                      </div>
                    )}

                    {/* Language and Speech */}
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      {audioContext.detectedLanguage && (
                        <div>
                          <span className="text-green-300 font-medium">Language:</span>
                          <span className="ml-1 text-green-100">
                            {audioContext.detectedLanguage}
                          </span>
                        </div>
                      )}
                      
                      <div>
                        <span className="text-green-300 font-medium">Speech:</span>
                        <span className="ml-1 text-green-100">
                          {audioContext.speechPresent ? 'Detected' : 'None'}
                        </span>
                      </div>
                      
                      <div>
                        <span className="text-green-300 font-medium">Confidence:</span>
                        <span className="ml-1 text-green-100">
                          {(audioContext.confidence * 100).toFixed(0)}%
                        </span>
                      </div>
                    </div>

                    {/* Ambient Sounds */}
                    {audioContext.ambientSounds.length > 0 && (
                      <div className="mt-2">
                        <p className="text-xs text-green-300 font-medium">Ambient Sounds:</p>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {audioContext.ambientSounds.map((sound, index) => (
                            <span
                              key={index}
                              className="px-2 py-1 bg-green-800 text-green-100 text-xs rounded"
                            >
                              {sound}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          )}
        </Card>
      </motion.div>
    );
}

export default AudioCapture;