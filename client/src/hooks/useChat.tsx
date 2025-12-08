// src/hooks/useChat.tsx
import { useState, useEffect, createContext, useContext, ReactNode, useCallback, useRef } from 'react';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { useAacUser } from './useAacUser';
import { useAuth } from './useAuth';
import { useFeaturePanel } from '@/contexts/FeaturePanelContext';
import { ChatMessage, ChatMode, ChatSession } from '@shared/schema';

// ============================================================================
// TYPES
// ============================================================================

export interface ChatMessageContent {
  text?: string;
  html?: string;
  // Feature-specific response data
  boardGeneratorData?: BoardGeneratorResponse;
  interpretData?: InterpretResponse;
  [key: string]: any;
}

export interface BoardGeneratorResponse {
  board?: any;
  suggestions?: string[];
  validation?: {
    isValid: boolean;
    errors?: string[];
  };
}

export interface InterpretResponse {
  interpretation?: string;
  suggestions?: string[];
  context?: any;
}

interface ChatContextType {
  // State
  session: ChatSession | null;
  sessionId: string | null;
  history: ChatMessage[];
  mode: ChatMode;
  isLoading: boolean;
  isSending: boolean;
  error: string | null;
  
  // Actions
  sendMessage: (content: string, options?: SendMessageOptions) => Promise<ChatMessage | null>;
  startNewSession: (mode?: ChatMode) => Promise<boolean>;
  loadSession: (sessionId: string) => Promise<boolean>;
  clearSession: () => void;
  
  // Feature-specific (convenience wrappers)
  sendBoardPrompt: (prompt: string) => Promise<ChatMessage | null>;
  sendInterpretRequest: (content: string, context?: any) => Promise<ChatMessage | null>;
  
  // Utilities
  getLastAssistantMessage: () => ChatMessage | null;
  getLastUserMessage: () => ChatMessage | null;
  getFeatureData: <T>(key: string) => T | null;
}

interface SendMessageOptions {
  replyType?: 'text' | 'html';
  additionalMetadata?: Record<string, any>;
}

// ============================================================================
// CONTEXT
// ============================================================================

const ChatContext = createContext<ChatContextType | null>(null);

export const useChat = () => {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return context;
};

// ============================================================================
// PROVIDER
// ============================================================================

interface ChatProviderProps {
  children: ReactNode;
  persistSession?: boolean;
}

export const ChatProvider = ({ 
  children, 
  persistSession = false 
}: ChatProviderProps) => {
  // State
  const [session, setSession] = useState<ChatSession | null>(null);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Refs
  const currentAacUserIdRef = useRef<string | null>(null);
  
  // External hooks
  const { aacUser } = useAacUser();
  const { user } = useAuth();
  const { activeFeature, getFeatureMetadata } = useFeaturePanel();
  
  // Mode is derived from active feature
  const mode = activeFeature;
  
  // Storage keys
  const getStorageKey = useCallback(() => {
    const userPart = user?.id || 'anonymous';
    const aacPart = aacUser?.id || 'none';
    return `chat.session.${userPart}.${aacPart}.${mode}`;
  }, [user?.id, aacUser?.id, mode]);

  // ============================================================================
  // SESSION MANAGEMENT
  // ============================================================================

  const loadSession = useCallback(async (sessionId: string): Promise<boolean> => {
    setIsLoading(true);
    setError(null);
    
    try {
      const response = await apiRequest('GET', `/api/chat/sessions/${sessionId}`);
      const data = await response.json();
      
      if (data?.success && data.session) {
        const loadedSession: ChatSession = data.session;
        setSession(loadedSession);
        setHistory(loadedSession.log as ChatMessage[] || []);
        // setModeState(loadedSession.chatMode);
        
        queryClient.setQueryData(['chat-session', sessionId], loadedSession);
        
        return true;
      }
      
      setError('Failed to load session');
      return false;
    } catch (err) {
      console.error('Load session failed:', err);
      setError('Failed to load session');
      return false;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const startNewSession = useCallback(async (newMode?: ChatMode): Promise<boolean> => {
    setSession(null);
    setHistory([]);
    setError(null);
    
    if (persistSession && typeof window !== 'undefined') {
      window.localStorage.removeItem(getStorageKey());
    }
    
    return true;
  }, [persistSession, getStorageKey]);

  const clearSession = useCallback(() => {
    setSession(null);
    setHistory([]);
    setError(null);
    
    if (persistSession && typeof window !== 'undefined') {
      window.localStorage.removeItem(getStorageKey());
    }
  }, [persistSession, getStorageKey]);

  // ============================================================================
  // MESSAGING
  // ============================================================================

  const sendMessage = useCallback(async (
    content: string,
    options: SendMessageOptions = {}
  ): Promise<ChatMessage | null> => {
    if (!content.trim()) {
      return null;
    }
    
    const { replyType = 'html', additionalMetadata } = options;
    
    setIsSending(true);
    setError(null);
    
    // Get feature-specific metadata from the active feature's builder
    const featureMetadata = activeFeature ? getFeatureMetadata(activeFeature) : {};
    
    // Combine metadata
    const metadata = {
      ...featureMetadata,
      ...additionalMetadata,
    };
    
    // Create user message
    const userMessage: ChatMessage = {
      role: 'user',
      content: content.trim(),
      timestamp: Date.now(),
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
    
    // Optimistically add user message
    setHistory(prev => [...prev, userMessage]);
    
    try {
      const requestBody: Record<string, any> = {
        messages: [userMessage],
        replyType,
        mode, // Send the active feature as the mode
      };
      
      if (session?.id) {
        requestBody.sessionId = session.id;
      }
      
      if (user?.id) {
        requestBody.userId = user.id;
      }
      if (aacUser?.id) {
        requestBody.aacUserId = aacUser.id;
      }
      
      const response = await apiRequest('POST', '/api/chat', requestBody);
      const data = await response.json();
      
      if (data?.message) {
        const assistantMessage: ChatMessage = {
          role: data.message.role || 'assistant',
          content: data.message.content,
          timestamp: data.message.timestamp || Date.now(),
          credits: data.message.credits,
          error: data.message.error,
        };
        
        setHistory(prev => [...prev, assistantMessage]);
        
        // Update session
        if (data.sessionId && (!session?.id || data.sessionId !== session.id)) {
          const newSession: ChatSession = {
            id: data.sessionId,
            userId: user?.id || null,
            aacUserId: aacUser?.id || null,
            chatMode: mode || 'chat',
            started: new Date(),
            lastUpdate: new Date(),
            state: data.chatState || {},
            log: [...history, userMessage, assistantMessage],
            last: [userMessage, assistantMessage],
            creditsUsed: data.creditsUsed || 0,
            status: 'open',
            createdAt: data.createdAt ? new Date(data.createdAt) : new Date(),
            updatedAt: data.updatedAt ? new Date(data.updatedAt) : new Date(),
            userAacUserId: null,
            deletedAt: null,
            priority: 0,
            useResponsesAPI: null
          };
          
          setSession(newSession);
          
          if (persistSession && typeof window !== 'undefined') {
            window.localStorage.setItem(getStorageKey(), data.sessionId);
          }
        }
        
        return assistantMessage;
      }
      
      if (data?.error) {
        setError(data.error);
        
        const errorMessage: ChatMessage = {
          role: 'system',
          content: data.error,
          timestamp: Date.now(),
          error: data.error,
        };
        setHistory(prev => [...prev, errorMessage]);
        
        return errorMessage;
      }
      
      return null;
    } catch (err: any) {
      console.error('Send message failed:', err);
      const errorText = err.message || 'Failed to send message';
      setError(errorText);
      
      const errorMessage: ChatMessage = {
        role: 'system',
        content: errorText,
        timestamp: Date.now(),
        error: errorText,
      };
      setHistory(prev => [...prev, errorMessage]);
      
      return errorMessage;
    } finally {
      setIsSending(false);
    }
  }, [session, mode, user, aacUser, history, persistSession, getStorageKey, getFeatureMetadata]);

  // ============================================================================
  // FEATURE-SPECIFIC METHODS (convenience wrappers)
  // ============================================================================

  const sendBoardPrompt = useCallback(async (prompt: string): Promise<ChatMessage | null> => {
    // The metadata will be automatically added by the boards feature's metadata builder
    return sendMessage(prompt, { replyType: 'html' });
  }, [sendMessage]);

  const sendInterpretRequest = useCallback(async (
    content: string, 
    context?: any
  ): Promise<ChatMessage | null> => {
    // Pass additional context as metadata
    return sendMessage(content, {
      replyType: 'html',
      additionalMetadata: context ? { interpretContext: context } : undefined
    });
  }, [sendMessage]);

  // ============================================================================
  // UTILITIES
  // ============================================================================

  const getLastAssistantMessage = useCallback((): ChatMessage | null => {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'assistant') {
        return history[i];
      }
    }
    return null;
  }, [history]);

  const getLastUserMessage = useCallback((): ChatMessage | null => {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'user') {
        return history[i];
      }
    }
    return null;
  }, [history]);

  const getFeatureData = useCallback(<T,>(key: string): T | null => {
    const lastMessage = getLastAssistantMessage();
    if (!lastMessage) return null;
    
    const content = lastMessage.content;
    if (typeof content === 'object' && content !== null) {
      return (content as any)[key] || null;
    }
    return null;
  }, [getLastAssistantMessage]);

  // ============================================================================
  // EFFECTS
  // ============================================================================

  // Handle AAC user changes
  useEffect(() => {
    const newAacUserId = aacUser?.id || null;
    
    if (currentAacUserIdRef.current !== null && 
        currentAacUserIdRef.current !== newAacUserId) {
      console.log('AAC user changed, clearing chat session');
      clearSession();
    }
    
    currentAacUserIdRef.current = newAacUserId;
  }, [aacUser?.id, clearSession]);

  // Load persisted session
  useEffect(() => {
    if (!persistSession || typeof window === 'undefined') {
      return;
    }
    
    const storedSessionId = window.localStorage.getItem(getStorageKey());
    
    if (storedSessionId && !session) {
      loadSession(storedSessionId).catch(err => {
        console.error('Failed to load stored session:', err);
        window.localStorage.removeItem(getStorageKey());
      });
    }
  }, [persistSession, getStorageKey, session, loadSession]);

  // ============================================================================
  // CONTEXT VALUE
  // ============================================================================

  const contextValue: ChatContextType = {
    session,
    sessionId: session?.id || null,
    history,
    mode: mode || 'chat',
    isLoading,
    isSending,
    error,
    sendMessage,
    startNewSession,
    loadSession,
    clearSession,
    sendBoardPrompt,
    sendInterpretRequest,
    getLastAssistantMessage,
    getLastUserMessage,
    getFeatureData,
  };

  return (
    <ChatContext.Provider value={contextValue}>
      {children}
    </ChatContext.Provider>
  );
};

// ============================================================================
// HELPER HOOKS
// ============================================================================

export const useChatHistory = () => {
  const { history, isLoading } = useChat();
  return { history, isLoading };
};

export const useSendMessage = () => {
  const { sendMessage, isSending, error } = useChat();
  return { sendMessage, isSending, error };
};

export const useChatSession = () => {
  const { session, sessionId, startNewSession, loadSession, clearSession } = useChat();
  return { session, sessionId, startNewSession, loadSession, clearSession };
};

export const useBoardChat = () => {
  const { sendBoardPrompt, getFeatureData, isSending } = useChat();
  const boardData = getFeatureData<BoardGeneratorResponse>('boardGeneratorData');
  return { sendBoardPrompt, boardData, isSending };
};