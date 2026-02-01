import { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo, ReactNode } from "react";
import { apiRequest, fetchWithAuth } from "@/lib/queryClient";
import type { ParsedBoardData } from "@shared/schema";
import {
  generateAACBoardFormSchema,
  boardDataToFormValues,
  applySetValuesToBoard,
  type ButtonFormValue
} from "@/lib/aacBoardForm";
import { useAudioRecorder } from "@/hooks/useAudioRecorder";
import { useStreamingAudioPlayer, createSSEAudioHandler } from "@/hooks/useStreamingAudioPlayer";

export interface ConversationMessage {
  id: string;
  role: 'agent' | 'user';
  content: string;
  timestamp: string;
  audioUrl?: string;
}

interface ConversationContextType {
  sessionId: string | null;
  currentMessage: ConversationMessage | null;
  isInitialized: boolean;
  isLoading: boolean;
  error: string | null;
  audioEnabled: boolean;
  isPlaying: boolean;
  currentBoard: ParsedBoardData | null;

  // Voice-related state
  voiceEnabled: boolean;
  isRecording: boolean;
  audioLevel: number;
  recordingDuration: number;
  transcription: string | null;

  initialize: (greeting?: string) => Promise<void>;
  sendMessage: (text: string, includeImage?: boolean) => Promise<void>;
  clearConversation: () => Promise<void>;
  setAudioEnabled: (enabled: boolean) => void;
  playMessageAudio: (message: ConversationMessage) => Promise<void>;
  setCaptureFrame: (fn: (() => Promise<Blob | null>) | null) => void;
  setCurrentBoard: (board: ParsedBoardData | null) => void;
  onBoardUpdate: ((board: ParsedBoardData) => void) | null;
  setOnBoardUpdate: (fn: ((board: ParsedBoardData) => void) | null) => void;

  // Voice methods
  setVoiceEnabled: (enabled: boolean) => void;
  startVoiceRecording: () => Promise<void>;
  stopVoiceRecording: () => Promise<void>;
  cancelVoiceRecording: () => void;
  sendVoiceMessage: (audioBlob: Blob) => Promise<void>;
}

const ConversationContext = createContext<ConversationContextType | undefined>(undefined);

interface ConversationProviderProps {
  children: ReactNode;
  studentId: string;
  language?: string;
}

export function ConversationProvider({ children, studentId, language = "en" }: ConversationProviderProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [currentMessage, setCurrentMessage] = useState<ConversationMessage | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentBoard, setCurrentBoardState] = useState<ParsedBoardData | null>(null);
  const onBoardUpdateRef = useRef<((board: ParsedBoardData) => void) | null>(null);

  // Voice-related state
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [transcription, setTranscription] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const captureFrameRef = useRef<(() => Promise<Blob | null>) | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Audio recorder hook
  const audioRecorder = useAudioRecorder();

  // Streaming audio player hook
  const streamingPlayer = useStreamingAudioPlayer({
    onPlaybackStart: () => setIsPlaying(true),
    onPlaybackEnd: () => setIsPlaying(false),
    onError: (err) => console.error('[ConversationContext] Audio playback error:', err),
    autoPlay: true,
  });

  // Create audio element
  useEffect(() => {
    audioRef.current = new Audio();
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  // Load speech synthesis voices
  useEffect(() => {
    if ('speechSynthesis' in window) {
      const loadVoices = () => {
        speechSynthesis.getVoices();
      };
      if (speechSynthesis.onvoiceschanged !== undefined) {
        speechSynthesis.onvoiceschanged = loadVoices;
      }
      loadVoices();
    }
  }, []);
  // Generate the form schema for the board
  const boardFormSchema = useMemo(() => {
    const grid = currentBoard?.grid || { rows: 4, cols: 4 };
    return generateAACBoardFormSchema(grid);
  }, [currentBoard?.grid?.rows, currentBoard?.grid?.cols]);

  // Wrapper for setting current board
  const setCurrentBoard = useCallback((board: ParsedBoardData | null) => {
    setCurrentBoardState(board);
  }, []);

  // Wrapper for setting board update callback
  const setOnBoardUpdate = useCallback((fn: ((board: ParsedBoardData) => void) | null) => {
    onBoardUpdateRef.current = fn;
  }, []);

  // Process setValues from AI response and update board
  const processSetValuesResponse = useCallback((data: any): boolean => {
    const messageContent = data.message?.content;
    if (messageContent && typeof messageContent === 'object' && messageContent.setValues) {
      const setValues = messageContent.setValues as { buttons?: ButtonFormValue[] };
      const updatedBoard = applySetValuesToBoard(
        currentBoard,
        setValues,
        currentBoard?.grid || { rows: 4, cols: 4 }
      );
      if (onBoardUpdateRef.current) {
        onBoardUpdateRef.current(updatedBoard);
      }
      setCurrentBoardState(updatedBoard);
      return true;
    }
    return false;
  }, [currentBoard]);

  // Helper to send chat message
  const sendChatMessage = useCallback(async (userMessage: string, includeImage: boolean = true): Promise<any> => {
    let imageBlob: Blob | null = null;
    if (includeImage && captureFrameRef.current) {
      try {
        imageBlob = await captureFrameRef.current();
      } catch (err) {
        console.log('[ConversationContext] Frame capture failed:', err);
      }
    }

    const featureContext = currentBoard ? {
      board: {
        data: currentBoard,
        currentPageId: currentBoard.currentPageId,
      }
    } : undefined;

    const formValues = boardDataToFormValues(currentBoard);
    const messageContent = {
      text: userMessage,
      formSchema: boardFormSchema,
      formValues: formValues,
    };

    if (imageBlob) {
      const formData = new FormData();
      formData.append('studentId', studentId);
      if (sessionId) {
        formData.append('sessionId', sessionId);
      }
      formData.append('activeFeature', 'aac');
      formData.append('messages', JSON.stringify([
        { role: 'user', content: messageContent }
      ]));
      if (featureContext) {
        formData.append('featureContext', JSON.stringify(featureContext));
      }
      formData.append('replyType', 'text');
      formData.append('image', imageBlob, 'frame.jpg');

      const response = await fetchWithAuth('/api/chat', {
        method: 'POST',
        body: formData,
      });
      return response.json();
    } else {
      const response = await apiRequest('POST', '/api/chat', {
        studentId,
        ...(sessionId && { sessionId }),
        activeFeature: 'aac',
        messages: [{ role: 'user', content: messageContent }],
        featureContext,
        replyType: 'text'
      });
      return response.json();
    }
  }, [studentId, sessionId, currentBoard, boardFormSchema]);

  // Play audio for a message with fallback to browser TTS
  const playMessageAudio = useCallback(async (message: ConversationMessage) => {
    if (!audioEnabled || isPlaying) return;

    setIsPlaying(true);

    try {
      const response = await apiRequest("POST", "/api/aac/voice/synthesize", {
        text: message.content,
        language,
        studentId,
      });

      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);

      if (audioRef.current) {
        audioRef.current.src = audioUrl;
        audioRef.current.play();

        audioRef.current.onended = () => {
          setIsPlaying(false);
          URL.revokeObjectURL(audioUrl);
        };

        audioRef.current.onerror = () => {
          setIsPlaying(false);
          URL.revokeObjectURL(audioUrl);
        };
      }
    } catch (audioError) {
      // Fallback to browser TTS
      if ('speechSynthesis' in window) {
        const utterance = new SpeechSynthesisUtterance(message.content);
        utterance.rate = 0.9;
        utterance.pitch = 1.0;
        utterance.volume = 0.8;

        const voices = speechSynthesis.getVoices();
        let selectedVoice;

        if (language === "he") {
          selectedVoice = voices.find(voice =>
            voice.lang.startsWith('he') ||
            voice.lang.includes('he-IL')
          );
        }

        if (!selectedVoice) {
          selectedVoice = voices.find(voice =>
            voice.name.toLowerCase().includes('female') ||
            voice.name.toLowerCase().includes('woman') ||
            voice.name.toLowerCase().includes('samantha') ||
            voice.name.toLowerCase().includes('karen')
          );
        }

        if (selectedVoice) {
          utterance.voice = selectedVoice;
          utterance.lang = language === "he" ? "he-IL" : "en-US";
        }

        utterance.onend = () => {
          setIsPlaying(false);
        };

        speechSynthesis.speak(utterance);
      } else {
        setIsPlaying(false);
      }
    }
  }, [audioEnabled, isPlaying, language, studentId]);

  // Initialize conversation (called by ConversationBox when it becomes visible)
  const initialize = useCallback(async (greeting?: string) => {
    if (isInitialized || isLoading) return;

    setIsLoading(true);
    setError(null);

    try {
      const greetingMessage = greeting || (language === 'he' ? 'שלום!' : 'Hello!');
      const data = await sendChatMessage(greetingMessage, true);

      if (data.sessionId) {
        setSessionId(data.sessionId);
      }

      const message: ConversationMessage = {
        id: Date.now().toString(),
        role: 'agent',
        content: typeof data.message?.content === 'string'
          ? data.message.content
          : (data.message?.content?.html || data.message?.content?.text || 'Hello! How can I help you?'),
        timestamp: new Date().toISOString(),
      };

      setCurrentMessage(message);
      setIsInitialized(true);

      if (audioEnabled) {
        playMessageAudio(message);
      }

      // Process board updates
      const processedSetValues = processSetValuesResponse(data);
      if (!processedSetValues && data.contextData?.board && onBoardUpdateRef.current) {
        onBoardUpdateRef.current(data.contextData.board);
      }
    } catch (err) {
      const errorMsg = (err as Error).message || 'Failed to start conversation';
      setError(errorMsg);
    } finally {
      setIsLoading(false);
    }
  }, [isInitialized, isLoading, language, sendChatMessage, audioEnabled, playMessageAudio, processSetValuesResponse]);

  // Send message
  const sendMessage = useCallback(async (text: string, includeImage: boolean = true) => {
    if (!text.trim() || isLoading) return;

    setIsLoading(true);
    setError(null);

    try {
      const data = await sendChatMessage(text, includeImage);

      if (data.sessionId) {
        setSessionId(data.sessionId);
      }

      const message: ConversationMessage = {
        id: Date.now().toString(),
        role: 'agent',
        content: typeof data.message?.content === 'string'
          ? data.message.content
          : (data.message?.content?.html || data.message?.content?.text || ''),
        timestamp: new Date().toISOString(),
      };

      setCurrentMessage(message);

      if (audioEnabled) {
        playMessageAudio(message);
      }

      // Process board updates
      const processedSetValues = processSetValuesResponse(data);
      if (!processedSetValues && data.contextData?.board && onBoardUpdateRef.current) {
        onBoardUpdateRef.current(data.contextData.board);
      }
    } catch (err) {
      setError((err as Error).message || 'Failed to send message');
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, sendChatMessage, audioEnabled, playMessageAudio, processSetValuesResponse]);

  // Clear conversation
  const clearConversation = useCallback(async () => {
    try {
      await apiRequest("DELETE", `/api/aac/conversation/${studentId}`);
      setCurrentMessage(null);
      setSessionId(null);
      setIsInitialized(false);
      // Re-initialize after clearing
      await initialize();
    } catch (err) {
      setError((err as Error).message || 'Failed to clear conversation');
    }
  }, [studentId, initialize]);

  // Set capture frame function
  const setCaptureFrame = useCallback((fn: (() => Promise<Blob | null>) | null) => {
    captureFrameRef.current = fn;
  }, []);

  // ============= VOICE METHODS =============

  // Start voice recording
  const startVoiceRecording = useCallback(async () => {
    setError(null);
    setTranscription(null);
    streamingPlayer.clear();
    await audioRecorder.startRecording();
  }, [audioRecorder, streamingPlayer]);

  // Stop voice recording and send the message
  const stopVoiceRecording = useCallback(async () => {
    const audioBlob = await audioRecorder.stopRecording();
    if (audioBlob && audioBlob.size > 0) {
      await sendVoiceMessage(audioBlob);
    }
  }, [audioRecorder]);

  // Cancel recording without sending
  const cancelVoiceRecording = useCallback(() => {
    audioRecorder.cancelRecording();
    setTranscription(null);
  }, [audioRecorder]);

  // Send voice message using the streaming voice chat endpoint
  const sendVoiceMessage = useCallback(async (audioBlob: Blob) => {
    if (isLoading) return;

    setIsLoading(true);
    setError(null);
    setTranscription(null);

    try {
      // Close any existing event source
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }

      // Create form data for the voice chat endpoint
      const formData = new FormData();
      formData.append('audio', audioBlob, 'recording.webm');
      formData.append('studentId', studentId);
      if (sessionId) {
        formData.append('sessionId', sessionId);
      }
      if (language) {
        formData.append('languageHint', language);
      }

      // Include feature context if we have a board
      if (currentBoard) {
        formData.append('featureContext', JSON.stringify({
          board: {
            data: currentBoard,
            currentPageId: currentBoard.currentPageId,
          }
        }));
      }

      // Include form schema and values for board updates (same as regular chat)
      const formValues = boardDataToFormValues(currentBoard);
      formData.append('formSchema', JSON.stringify(boardFormSchema));
      formData.append('formValues', JSON.stringify(formValues));

      // Make the SSE request
      const response = await fetchWithAuth('/api/aac/voice/chat', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Voice chat failed: ${response.status}`);
      }

      // Read SSE stream
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let responseText = '';
      let currentEventType = 'message';

      // Helper to process SSE lines
      const processLine = (line: string) => {
        if (line.startsWith('event:')) {
          currentEventType = line.slice(6).trim();
          console.log('[SSE] Event type:', currentEventType);
          return;
        }

        if (line.startsWith('data:')) {
          try {
            const data = JSON.parse(line.slice(5).trim());
            const eventType = currentEventType;
            console.log('[SSE] Processing:', eventType, data);

            // Handle different event types
            switch (eventType) {
              case 'transcription':
                setTranscription(data.text);
                break;

              case 'text':
                responseText += data.chunk || '';
                console.log('[SSE] Text accumulated:', responseText.substring(0, 50));
                break;

              case 'audio':
                console.log('[SSE] Audio chunk, voiceEnabled:', voiceEnabled, 'audioEnabled:', audioEnabled);
                if (voiceEnabled && audioEnabled) {
                  streamingPlayer.queueChunk({
                    chunk: data.chunk,
                    format: data.format || 'mp3',
                  });
                  console.log('[SSE] Audio queued');
                }
                break;

              case 'setValues':
                console.log('[SSE] setValues received:', data.setValues);
                console.log('[SSE] currentBoard:', currentBoard);
                // Process setValues to update the board (same as processSetValuesResponse)
                if (data.setValues) {
                  const setValuesData = data.setValues as { buttons?: ButtonFormValue[] };
                  const updatedBoard = applySetValuesToBoard(
                    currentBoard,
                    setValuesData,
                    currentBoard?.grid || { rows: 4, cols: 4 }
                  );
                  console.log('[SSE] Updated board:', updatedBoard);
                  if (onBoardUpdateRef.current) {
                    onBoardUpdateRef.current(updatedBoard);
                    console.log('[SSE] Board update callback called');
                  }
                  setCurrentBoardState(updatedBoard);
                }
                break;

              case 'board':
                const boardData = data.board || data;
                if (boardData && onBoardUpdateRef.current) {
                  onBoardUpdateRef.current(boardData);
                }
                setCurrentBoardState(boardData);
                break;

              case 'complete':
                if (data.sessionId) {
                  setSessionId(data.sessionId);
                }
                // Update current message with full response
                const message: ConversationMessage = {
                  id: Date.now().toString(),
                  role: 'agent',
                  content: data.fullText || responseText,
                  timestamp: new Date().toISOString(),
                };
                setCurrentMessage(message);
                break;

              case 'ttsError':
                // TTS failed but we can still show the text - this is non-fatal
                console.warn('[ConversationContext] TTS failed:', data.error);
                break;

              case 'error':
                setError(data.error || 'Voice chat error');
                break;
            }
          } catch (e) {
            // Ignore parse errors for incomplete JSON
          }
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          processLine(line);
        }
      }

      // Process any remaining content in the buffer after stream ends
      if (buffer.trim()) {
        const remainingLines = buffer.split('\n');
        for (const line of remainingLines) {
          processLine(line);
        }
      }
    } catch (err) {
      console.error('[ConversationContext] Voice chat error:', err);
      setError((err as Error).message || 'Failed to process voice message');
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, studentId, sessionId, language, currentBoard, boardFormSchema, voiceEnabled, audioEnabled, streamingPlayer]);

  // Cleanup on unmount only (empty deps array)
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      // streamingPlayer.clear() is handled by the hook's own cleanup
    };
  }, []);

  const value: ConversationContextType = {
    sessionId,
    currentMessage,
    isInitialized,
    isLoading,
    error,
    audioEnabled,
    isPlaying,
    currentBoard,

    // Voice state
    voiceEnabled,
    isRecording: audioRecorder.isRecording,
    audioLevel: audioRecorder.audioLevel,
    recordingDuration: audioRecorder.duration,
    transcription,

    // Text methods
    initialize,
    sendMessage,
    clearConversation,
    setAudioEnabled,
    playMessageAudio,
    setCaptureFrame,
    setCurrentBoard,
    onBoardUpdate: onBoardUpdateRef.current,
    setOnBoardUpdate,

    // Voice methods
    setVoiceEnabled,
    startVoiceRecording,
    stopVoiceRecording,
    cancelVoiceRecording,
    sendVoiceMessage,
  };

  return (
    <ConversationContext.Provider value={value}>
      {children}
    </ConversationContext.Provider>
  );
}

export function useConversation(): ConversationContextType {
  const context = useContext(ConversationContext);
  if (context === undefined) {
    throw new Error('useConversation must be used within a ConversationProvider');
  }
  return context;
}
