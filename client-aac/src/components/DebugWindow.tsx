import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Minimize2, Maximize2, X, Eye, EyeOff, MapPin, Clock, User, Camera, Mic, Volume2 } from 'lucide-react';

interface DebugData {
  time: string;
  visualAnalysis: {
    available: boolean;
    data: string;
    fullLength: number;
  };
  personDetection: {
    personPresent: boolean;
    isMainUser: boolean;
    detectedAge: number;
    detectedGender: string;
    facialExpression: string;
    emotionalState: string;
    confidence: number;
  } | null;
  signLanguageDetection: {
    available: boolean;
    timestamp?: string;
    signLanguageDetected?: boolean;
    gesture?: string;
    interpretation?: string;
    confidence?: number;
    lastDetection?: any;
    message?: string;
  };
  locationAnalysis: {
    locationType: string;
    confidence: number;
    features: string[];
  } | null;
  environmentalObjects: string[];
  audioContext: {
    available: boolean;
    transcript?: string;
    detectedLanguage?: string;
    confidence?: number;
    ambientSounds?: string[];
    speechPresent?: boolean;
    timestamp?: string;
    age?: number;
    whisperStatus?: string;
  };
  aiModelStatus: {
    symbolGeneration: {
      primary: string;
      fallback: string;
      currentStatus: string;
      activeFallback: string;
    };
    conversationModel: {
      primary: string;
      fallback: string;
      currentStatus: string;
      activeFallback: string;
    };
    visualAnalysis: {
      primary: string;
      fallback: string;
      currentStatus: string;
      activeFallback: string;
    };
    personDetection: {
      primary: string;
      fallback: string;
      currentStatus: string;
      activeFallback: string;
    };
    voiceSynthesis: {
      primary: string;
      fallback: string;
      currentStatus: string;
      activeFallback: string;
    };
    audioTranscription: {
      primary: string;
      fallback: string;
      currentStatus: string;
      activeFallback: string;
    };
    quotaLimits: any;
    lastError: string | null;
    recommendedAction: string;
  };
}

export function DebugWindow() {
  const [isMinimized, setIsMinimized] = useState(false);
  const [isVisible, setIsVisible] = useState(true);
  const [position, setPosition] = useState({ x: 20, y: 20 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  // Fetch context data
  const { data: context } = useQuery<{time: string; date: string; location?: string; visualContext?: string}>({
    queryKey: ['/api/aac/context'],
    refetchInterval: 2000, // Update every 2 seconds
  });

  // Fetch debug data (may not be available in new server)
  const { data: debugData } = useQuery<DebugData>({
    queryKey: ['/api/aac/debug/environment'],
    refetchInterval: 3000, // Update every 3 seconds
    retry: false,
    enabled: false, // Disabled - endpoint not available in new server
  });

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    setDragOffset({
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    });
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (isDragging) {
      setPosition({
        x: e.clientX - dragOffset.x,
        y: e.clientY - dragOffset.y,
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, dragOffset]);

  if (!isVisible) return null;

  return (
    <div
      className="fixed z-50 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg"
      style={{
        left: position.x,
        top: position.y,
        width: isMinimized ? '200px' : '400px',
        minHeight: isMinimized ? '50px' : '300px',
        maxHeight: '80vh',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        className="bg-blue-600 text-white p-2 cursor-move flex items-center justify-between"
        onMouseDown={handleMouseDown}
      >
        <div className="flex items-center gap-2">
          <Camera className="h-4 w-4" />
          <span className="text-sm font-medium">Environment Debug</span>
        </div>
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
            onClick={() => setIsVisible(false)}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Content */}
      {!isMinimized && (
        <div className="p-3 max-h-[70vh] overflow-y-auto scrollbar-thin scrollbar-thumb-gray-400 scrollbar-track-gray-200 dark:scrollbar-thumb-gray-600 dark:scrollbar-track-gray-800">
          <div className="space-y-3">
            {/* Time & Location */}
            <Card className="p-2">
              <div className="flex items-center gap-2 mb-2">
                <Clock className="h-4 w-4 text-blue-600" />
                <span className="text-sm font-medium">Time & Location</span>
              </div>
              <div className="text-xs space-y-1">
                <div><strong>Time:</strong> {context?.time || 'Loading...'}</div>
                <div><strong>Date:</strong> {context?.date || 'Loading...'}</div>
                <div className="flex items-center gap-1">
                  <MapPin className="h-3 w-3" />
                  <strong>Location:</strong> Home
                </div>
                {debugData?.locationAnalysis && (
                  <div className="ml-4 text-xs text-gray-600 dark:text-gray-400">
                    <div><strong>Type:</strong> {debugData.locationAnalysis.locationType}</div>
                    <div><strong>Confidence:</strong> {Math.round(debugData.locationAnalysis.confidence * 100)}%</div>
                    {debugData.locationAnalysis.features.length > 0 && (
                      <div><strong>Features:</strong> {debugData.locationAnalysis.features.join(', ')}</div>
                    )}
                  </div>
                )}
              </div>
            </Card>

            {/* Person Detection */}
            <Card className="p-2">
              <div className="flex items-center gap-2 mb-2">
                <User className="h-4 w-4 text-green-600" />
                <span className="text-sm font-medium">Person Detection</span>
              </div>
              <div className="text-xs space-y-1">
                {debugData?.personDetection ? (
                  <>
                    <div className="flex items-center gap-1">
                      {debugData.personDetection.personPresent ? (
                        <Eye className="h-3 w-3 text-green-500" />
                      ) : (
                        <EyeOff className="h-3 w-3 text-red-500" />
                      )}
                      <strong>Present:</strong> {debugData.personDetection.personPresent ? 'Yes' : 'No'}
                    </div>
                    {debugData.personDetection.personPresent && (
                      <>
                        <div><strong>Main User:</strong> {debugData.personDetection.isMainUser ? 'Yes' : 'No'}</div>
                        <div><strong>Age:</strong> ~{debugData.personDetection.detectedAge} years</div>
                        <div><strong>Gender:</strong> {debugData.personDetection.detectedGender}</div>
                        <div><strong>Confidence:</strong> {Math.round(debugData.personDetection.confidence * 100)}%</div>
                        {(debugData.personDetection as any).detectionCamera && (
                          <div className="text-blue-600 dark:text-blue-400">
                            <strong>Detection Source:</strong> {(debugData.personDetection as any).detectionCamera}
                          </div>
                        )}
                        {debugData.personDetection.facialExpression && debugData.personDetection.facialExpression !== 'unknown' && (
                          <div><strong>Expression:</strong> {debugData.personDetection.facialExpression}</div>
                        )}
                        {debugData.personDetection.emotionalState && debugData.personDetection.emotionalState !== 'unknown' && (
                          <div className="text-gray-600 dark:text-gray-400 max-h-16 overflow-y-auto bg-gray-50 dark:bg-gray-800 p-2 rounded border scrollbar-thin scrollbar-thumb-gray-400 scrollbar-track-gray-200">
                            <strong>State:</strong> {debugData.personDetection.emotionalState}
                          </div>
                        )}
                      </>
                    )}
                  </>
                ) : (
                  <div className="text-gray-500">No detection data</div>
                )}
              </div>
            </Card>

            {/* Sign Language Detection */}
            <Card className="p-2">
              <div className="flex items-center gap-2 mb-2">
                <div className="h-4 w-4 text-purple-600">🤟</div>
                <span className="text-sm font-medium">Sign Language Detection</span>
              </div>
              <div className="text-xs space-y-1">
                {debugData?.signLanguageDetection?.available ? (
                  <>
                    <div className="flex items-center gap-1">
                      <div className="h-2 w-2 rounded-full bg-green-500" />
                      <strong>Status:</strong> Active
                    </div>
                    {debugData.signLanguageDetection.timestamp && (
                      <div><strong>Last Detection:</strong> {new Date(debugData.signLanguageDetection.timestamp).toLocaleTimeString()}</div>
                    )}
                    {debugData.signLanguageDetection.signLanguageDetected ? (
                      <>
                        <div><strong>Gesture:</strong> {debugData.signLanguageDetection.gesture || 'Detected'}</div>
                        <div><strong>Interpretation:</strong> {debugData.signLanguageDetection.interpretation || 'Processing...'}</div>
                        <div><strong>Confidence:</strong> {debugData.signLanguageDetection.confidence ? Math.round(debugData.signLanguageDetection.confidence * 100) + '%' : 'N/A'}</div>
                      </>
                    ) : (
                      <div className="text-gray-600 dark:text-gray-400">No sign language detected</div>
                    )}
                  </>
                ) : (
                  <div className="text-gray-600 dark:text-gray-400">
                    {debugData?.signLanguageDetection?.message || 'Sign language detection not enabled'}
                  </div>
                )}
              </div>
            </Card>

            {/* Visual Environment */}
            <Card className="p-2">
              <div className="flex items-center gap-2 mb-2">
                <Camera className="h-4 w-4 text-purple-600" />
                <span className="text-sm font-medium">Visual Environment</span>
              </div>
              <div className="text-xs space-y-2">
                {debugData?.visualAnalysis?.available && (debugData?.visualAnalysis as any)?.cameras ? (
                  <>
                    {Object.entries((debugData.visualAnalysis as any).cameras).map(([cameraKey, cameraData]: [string, any]) => (
                      <div key={cameraKey} className="border-l-2 border-gray-300 dark:border-gray-600 pl-2">
                        <div className="flex items-center gap-1 mb-1">
                          <span className="text-blue-600 dark:text-blue-400 font-medium">
                            {cameraData.cameraType === 'user' ? '👤' : '🌍'} {cameraData.deviceLabel}
                          </span>
                          <span className="text-gray-500 text-xs">
                            ({cameraData.cameraType === 'user' ? 'Face Detection' : 'Scene Analysis'})
                          </span>
                        </div>
                        <div className="text-gray-600 dark:text-gray-400 ml-2 max-h-32 overflow-y-auto text-xs bg-gray-50 dark:bg-gray-800 p-2 rounded border scrollbar-thin scrollbar-thumb-gray-400 scrollbar-track-gray-200 dark:scrollbar-thumb-gray-600 dark:scrollbar-track-gray-800">
                          {cameraData.analysis || 'No analysis available'}
                        </div>
                        <div className="text-gray-500 text-xs mt-1">
                          Model: {cameraData.model} | {new Date(cameraData.timestamp).toLocaleTimeString()}
                        </div>
                      </div>
                    ))}
                  </>
                ) : (
                  <div className="text-gray-600 dark:text-gray-400">No camera-specific visual data available</div>
                )}
                
                {debugData?.environmentalObjects && debugData.environmentalObjects.length > 0 && (
                  <>
                    <div className="mt-2"><strong>Objects Detected:</strong></div>
                    <div className="ml-2 flex flex-wrap gap-1">
                      {debugData.environmentalObjects.map((obj, index) => (
                        <span
                          key={index}
                          className="px-1 py-0.5 bg-gray-100 dark:bg-gray-700 rounded text-xs"
                        >
                          {obj}
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </Card>

            {/* Audio Context */}
            <Card className="p-2">
              <div className="flex items-center gap-2 mb-2">
                <Mic className="h-4 w-4 text-indigo-600" />
                <span className="text-sm font-medium">Audio Context</span>
                <span className="text-xs bg-orange-100 dark:bg-orange-900 text-orange-700 dark:text-orange-300 px-2 py-0.5 rounded-full font-medium">
                  BETA
                </span>
              </div>
              <div className="text-xs space-y-2">
                {debugData?.audioContext?.available || debugData?.audioContext?.whisperStatus ? (
                  <>
                    <div className="flex items-center gap-2">
                      <div className={`h-2 w-2 rounded-full ${
                        debugData.audioContext.confidence && debugData.audioContext.confidence > 0.5 ? 'bg-green-500' : 
                        debugData.audioContext.confidence && debugData.audioContext.confidence > 0 ? 'bg-yellow-500' : 'bg-red-500'
                      }`} />
                      <span className="font-medium">
                        {debugData.audioContext.whisperStatus || 'Active'}
                      </span>
                    </div>
                    
                    {debugData.audioContext.transcript && (
                      <div className="border-l-2 border-blue-400 pl-2">
                        <div className="font-medium text-blue-600 dark:text-blue-400">Transcript</div>
                        <div className="text-gray-600 dark:text-gray-400 italic max-h-16 overflow-y-auto text-xs bg-gray-50 dark:bg-gray-800 p-2 rounded border">
                          "{debugData.audioContext.transcript}"
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-2">
                      {debugData.audioContext.detectedLanguage && (
                        <div>
                          <span className="font-medium text-purple-600 dark:text-purple-400">Language:</span>
                          <span className="ml-1">{debugData.audioContext.detectedLanguage}</span>
                        </div>
                      )}
                      
                      <div>
                        <span className="font-medium text-green-600 dark:text-green-400">Speech:</span>
                        <span className="ml-1">{debugData.audioContext.speechPresent ? 'Yes' : 'No'}</span>
                      </div>
                      
                      {debugData.audioContext.confidence !== undefined && (
                        <div>
                          <span className="font-medium text-orange-600 dark:text-orange-400">Confidence:</span>
                          <span className="ml-1">{Math.round(debugData.audioContext.confidence * 100)}%</span>
                        </div>
                      )}

                      {debugData.audioContext.age !== undefined && (
                        <div>
                          <span className="font-medium text-gray-600 dark:text-gray-400">Age:</span>
                          <span className="ml-1">{debugData.audioContext.age}s ago</span>
                        </div>
                      )}
                    </div>

                    {debugData.audioContext.ambientSounds && debugData.audioContext.ambientSounds.length > 0 && (
                      <div className="border-l-2 border-indigo-400 pl-2">
                        <div className="font-medium text-indigo-600 dark:text-indigo-400">Ambient Sounds</div>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {debugData.audioContext.ambientSounds.map((sound, index) => (
                            <span
                              key={index}
                              className="px-2 py-1 bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-300 text-xs rounded"
                            >
                              {sound}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {debugData.audioContext.timestamp && (
                      <div className="text-gray-500 text-xs">
                        Last updated: {new Date(debugData.audioContext.timestamp).toLocaleTimeString()}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-gray-600 dark:text-gray-400">
                    {debugData?.audioContext?.whisperStatus || 'Audio monitoring not available or no recent data'}
                    {debugData?.aiModelStatus?.audioTranscription && (
                      <div className="mt-1 text-xs">
                        <div><strong>Status:</strong> {debugData.aiModelStatus.audioTranscription.currentStatus}</div>
                        <div><strong>Fallback:</strong> {debugData.aiModelStatus.audioTranscription.activeFallback}</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </Card>

            {/* AI Model Status */}
            <Card className="p-2">
              <div className="flex items-center gap-2 mb-2">
                <div className="h-4 w-4 bg-gradient-to-r from-blue-500 to-purple-500 rounded" />
                <span className="text-sm font-medium">AI Model Status</span>
              </div>
              <div className="text-xs space-y-2">
                {debugData?.aiModelStatus ? (
                  <>
                    {/* Conversation Agent */}
                    <div className="border-l-2 border-blue-400 pl-2">
                      <div className="font-medium text-blue-600 dark:text-blue-400">Conversation</div>
                      <div className="flex items-center gap-1">
                        <div className={`h-2 w-2 rounded-full ${
                          debugData.aiModelStatus.conversationModel?.currentStatus.includes('Working') ? 'bg-green-500' : 
                          debugData.aiModelStatus.conversationModel?.currentStatus.includes('Exhausted') ? 'bg-red-500' : 'bg-yellow-500'
                        }`} />
                        <span>{debugData.aiModelStatus.conversationModel?.primary} - {debugData.aiModelStatus.conversationModel?.currentStatus}</span>
                      </div>
                      <div className="text-gray-600 dark:text-gray-400 text-xs">
                        Active: {debugData.aiModelStatus.conversationModel?.activeFallback}
                      </div>
                      {debugData.aiModelStatus.conversationModel?.apiUsage && (
                        <div className="text-gray-500 text-xs mt-1 bg-gray-50 dark:bg-gray-800 p-1 rounded">
                          <div>Calls: {debugData.aiModelStatus.conversationModel.apiUsage.sessionCalls} | Errors: {debugData.aiModelStatus.conversationModel.apiUsage.errors}</div>
                          <div>Tokens: ~{debugData.aiModelStatus.conversationModel.apiUsage.estimatedTokens}</div>
                        </div>
                      )}
                    </div>

                    {/* Visual Analysis */}
                    <div className="border-l-2 border-green-400 pl-2">
                      <div className="font-medium text-green-600 dark:text-green-400">Visual Analysis</div>
                      <div className="flex items-center gap-1">
                        <div className={`h-2 w-2 rounded-full ${
                          debugData.aiModelStatus.visualAnalysis?.currentStatus.includes('Working') ? 'bg-green-500' : 'bg-red-500'
                        }`} />
                        <span>{debugData.aiModelStatus.visualAnalysis?.primary} - {debugData.aiModelStatus.visualAnalysis?.currentStatus}</span>
                      </div>
                      {debugData.aiModelStatus.visualAnalysis?.apiUsage && (
                        <div className="text-gray-500 text-xs mt-1 bg-gray-50 dark:bg-gray-800 p-1 rounded">
                          <div>Calls: {debugData.aiModelStatus.visualAnalysis.apiUsage.sessionCalls} | Errors: {debugData.aiModelStatus.visualAnalysis.apiUsage.errors}</div>
                          <div>Tokens: ~{debugData.aiModelStatus.visualAnalysis.apiUsage.estimatedTokens}</div>
                        </div>
                      )}
                    </div>

                    {/* Symbol Suggestions */}
                    <div className="border-l-2 border-purple-400 pl-2">
                      <div className="font-medium text-purple-600 dark:text-purple-400">Symbols</div>
                      <div className="flex items-center gap-1">
                        <div className={`h-2 w-2 rounded-full ${
                          debugData.aiModelStatus.symbolGeneration?.currentStatus.includes('Working') ? 'bg-green-500' : 
                          debugData.aiModelStatus.symbolGeneration?.currentStatus.includes('Exhausted') ? 'bg-red-500' : 'bg-yellow-500'
                        }`} />
                        <span>{debugData.aiModelStatus.symbolGeneration?.primary} - {debugData.aiModelStatus.symbolGeneration?.currentStatus}</span>
                      </div>
                      <div className="text-gray-600 dark:text-gray-400 text-xs">
                        Active: {debugData.aiModelStatus.symbolGeneration?.activeFallback}
                      </div>
                      {debugData.aiModelStatus.symbolGeneration?.apiUsage && (
                        <div className="text-gray-500 text-xs mt-1 bg-gray-50 dark:bg-gray-800 p-1 rounded">
                          <div>Calls: {debugData.aiModelStatus.symbolGeneration.apiUsage.sessionCalls} | Errors: {debugData.aiModelStatus.symbolGeneration.apiUsage.errors}</div>
                          <div>Tokens: ~{debugData.aiModelStatus.symbolGeneration.apiUsage.estimatedTokens}</div>
                        </div>
                      )}
                    </div>

                    {/* Voice Synthesis */}
                    <div className="border-l-2 border-orange-400 pl-2">
                      <div className="font-medium text-orange-600 dark:text-orange-400">Voice</div>
                      <div className="flex items-center gap-1">
                        <div className={`h-2 w-2 rounded-full ${
                          debugData.aiModelStatus.voiceSynthesis?.currentStatus.includes('Error') ? 'bg-red-500' : 'bg-green-500'
                        }`} />
                        <span>{debugData.aiModelStatus.voiceSynthesis?.primary} - {debugData.aiModelStatus.voiceSynthesis?.currentStatus}</span>
                      </div>
                      {debugData.aiModelStatus.voiceSynthesis?.apiUsage && (
                        <div className="text-gray-500 text-xs mt-1 bg-gray-50 dark:bg-gray-800 p-1 rounded">
                          <div>Calls: {debugData.aiModelStatus.voiceSynthesis.apiUsage.sessionCalls} | Errors: {debugData.aiModelStatus.voiceSynthesis.apiUsage.errors}</div>
                          <div>Tokens: ~{debugData.aiModelStatus.voiceSynthesis.apiUsage.estimatedTokens}</div>
                        </div>
                      )}
                    </div>

                    {/* Audio Transcription */}
                    <div className="border-l-2 border-indigo-400 pl-2">
                      <div className="font-medium text-indigo-600 dark:text-indigo-400">Audio</div>
                      <div className="flex items-center gap-1">
                        <div className={`h-2 w-2 rounded-full ${
                          debugData.aiModelStatus.audioTranscription?.currentStatus.includes('Working') ? 'bg-green-500' : 
                          debugData.aiModelStatus.audioTranscription?.currentStatus.includes('Quota') ? 'bg-red-500' : 'bg-yellow-500'
                        }`} />
                        <span>{debugData.aiModelStatus.audioTranscription?.primary} - {debugData.aiModelStatus.audioTranscription?.currentStatus}</span>
                      </div>
                      <div className="text-gray-600 dark:text-gray-400 text-xs">
                        Active: {debugData.aiModelStatus.audioTranscription?.activeFallback}
                      </div>
                      {debugData.aiModelStatus.audioTranscription?.apiUsage && (
                        <div className="text-gray-500 text-xs mt-1 bg-gray-50 dark:bg-gray-800 p-1 rounded">
                          <div>Calls: {debugData.aiModelStatus.audioTranscription.apiUsage.sessionCalls} | Errors: {debugData.aiModelStatus.audioTranscription.apiUsage.errors}</div>
                          <div>Tokens: ~{debugData.aiModelStatus.audioTranscription.apiUsage.estimatedTokens}</div>
                        </div>
                      )}
                    </div>

                    {/* Quota Summary */}
                    <div className="mt-2 p-1 bg-gray-100 dark:bg-gray-800 rounded text-xs">
                      <div><strong>Quota Status:</strong> {debugData.aiModelStatus.quotaLimits?.geminiCurrentUsage}</div>
                      <div><strong>Recommended:</strong> {debugData.aiModelStatus.recommendedAction}</div>
                      {debugData.aiModelStatus.lastError && (
                        <div className="text-red-600 mt-1">
                          <strong>Last Error:</strong> {debugData.aiModelStatus.lastError}
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="text-gray-500">No AI model data</div>
                )}
              </div>
            </Card>

            {/* Connection Status */}
            <Card className="p-2">
              <div className="text-xs">
                <div className="flex items-center gap-2">
                  <div
                    className={`h-2 w-2 rounded-full ${
                      debugData ? 'bg-green-500' : 'bg-red-500'
                    }`}
                  />
                  <span>Debug Data: {debugData ? 'Connected' : 'Disconnected'}</span>
                </div>
              </div>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

// Toggle button to show/hide debug window
export function DebugToggle() {
  const [showDebug, setShowDebug] = useState(
    localStorage.getItem('showDebugWindow') === 'true'
  );

  useEffect(() => {
    localStorage.setItem('showDebugWindow', showDebug.toString());
  }, [showDebug]);

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="fixed bottom-4 right-4 z-40"
        onClick={() => setShowDebug(!showDebug)}
      >
        <Camera className="h-4 w-4 mr-1" />
        Debug
      </Button>
      {showDebug && <DebugWindow />}
    </>
  );
}