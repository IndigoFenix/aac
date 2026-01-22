import { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo, ReactNode } from "react";
import { apiRequest, fetchWithAuth } from "@/lib/queryClient";
import type { ParsedBoardData } from "@shared/schema";
import {
  generateAACBoardFormSchema,
  boardDataToFormValues,
  applySetValuesToBoard,
  type ButtonFormValue
} from "@/lib/aacBoardForm";

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

  initialize: (greeting?: string) => Promise<void>;
  sendMessage: (text: string, includeImage?: boolean) => Promise<void>;
  clearConversation: () => Promise<void>;
  setAudioEnabled: (enabled: boolean) => void;
  playMessageAudio: (message: ConversationMessage) => Promise<void>;
  setCaptureFrame: (fn: (() => Promise<Blob | null>) | null) => void;
  setCurrentBoard: (board: ParsedBoardData | null) => void;
  onBoardUpdate: ((board: ParsedBoardData) => void) | null;
  setOnBoardUpdate: (fn: ((board: ParsedBoardData) => void) | null) => void;
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

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const captureFrameRef = useRef<(() => Promise<Blob | null>) | null>(null);

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
        sessionId,
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
      const response = await apiRequest("POST", "/api/aac/conversation/audio", {
        messageId: message.id,
        text: message.content,
        language,
        studentId,
        isUserMessage: false
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

  const value: ConversationContextType = {
    sessionId,
    currentMessage,
    isInitialized,
    isLoading,
    error,
    audioEnabled,
    isPlaying,
    currentBoard,
    initialize,
    sendMessage,
    clearConversation,
    setAudioEnabled,
    playMessageAudio,
    setCaptureFrame,
    setCurrentBoard,
    onBoardUpdate: onBoardUpdateRef.current,
    setOnBoardUpdate,
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
