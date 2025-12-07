import { useState, useEffect, createContext, useContext, ReactNode, useCallback, useRef } from 'react';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { useAacUser } from './useAacUser';
import { useAuth } from './useAuth'; // Assuming you have an auth provider for the user
import { ChatMessage, ChatMode, ChatSession } from '@shared/schema';

// ============================================================================
// TYPES
// ============================================================================


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
  setMode: (mode: ChatMode) => void;
  
  // Utilities
  getLastAssistantMessage: () => ChatMessage | null;
  getLastUserMessage: () => ChatMessage | null;
}

interface SendMessageOptions {
  replyType?: 'text' | 'html';
  metadata?: Record<string, any>;
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
  defaultMode?: ChatMode;
  persistSession?: boolean; // Whether to persist session ID in localStorage
}

export const ChatProvider = ({ 
  children, 
  defaultMode = 'none',
  persistSession = false 
}: ChatProviderProps) => {
  // State
  const [session, setSession] = useState<ChatSession | null>(null);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [mode, setModeState] = useState<ChatMode>(defaultMode);
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Refs to track current context without causing re-renders
  const currentAacUserIdRef = useRef<string | null>(null);
  
  // External hooks
  const { aacUser } = useAacUser();
  const { user } = useAuth();
  
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
        setModeState(loadedSession.chatMode);
        
        // Cache in react-query
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
    const sessionMode = newMode || mode;
    
    // Clear current session
    setSession(null);
    setHistory([]);
    setError(null);
    
    if (newMode) {
      setModeState(newMode);
    }
    
    // Clear stored session ID
    if (persistSession && typeof window !== 'undefined') {
      window.localStorage.removeItem(getStorageKey());
    }
    
    // The new session will be created on first message
    return true;
  }, [mode, persistSession, getStorageKey]);

  const clearSession = useCallback(() => {
    setSession(null);
    setHistory([]);
    setError(null);
    
    if (persistSession && typeof window !== 'undefined') {
      window.localStorage.removeItem(getStorageKey());
    }
  }, [persistSession, getStorageKey]);

  const setMode = useCallback((newMode: ChatMode) => {
    if (newMode !== mode) {
      // When mode changes, we need to start a new session
      setModeState(newMode);
      clearSession();
    }
  }, [mode, clearSession]);

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
    
    const { replyType = 'html', metadata } = options;
    
    setIsSending(true);
    setError(null);
    
    // Create user message
    const userMessage: ChatMessage = {
      role: 'user',
      content: content.trim(),
      timestamp: Date.now(),
      metadata,
    };
    
    // Optimistically add user message to history
    setHistory(prev => [...prev, userMessage]);
    
    try {
      const requestBody: Record<string, any> = {
        messages: [userMessage],
        replyType,
        mode,
      };
      
      // Add session ID if we have one
      if (session?.id) {
        requestBody.sessionId = session.id;
      }
      
      // Add user/aacUser context
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
        
        // Add assistant message to history
        setHistory(prev => [...prev, assistantMessage]);
        
        // Update session if we got a new session ID
        if (data.sessionId && (!session?.id || data.sessionId !== session.id)) {
          const newSession: ChatSession = {
              id: data.sessionId,
              userId: user?.id || null,
              aacUserId: aacUser?.id || null,
              chatMode: mode,
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
          
          // Persist session ID
          if (persistSession && typeof window !== 'undefined') {
            window.localStorage.setItem(getStorageKey(), data.sessionId);
          }
        }
        
        return assistantMessage;
      }
      
      // Handle error response
      if (data?.error) {
        setError(data.error);
        
        // Add error message to history
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
      
      // Add error message to history
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
  }, [session, mode, user, aacUser, history, persistSession, getStorageKey]);

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

  // ============================================================================
  // EFFECTS
  // ============================================================================

  // Handle AAC user changes - start new session when AAC user changes
  useEffect(() => {
    const newAacUserId = aacUser?.id || null;
    
    if (currentAacUserIdRef.current !== null && 
        currentAacUserIdRef.current !== newAacUserId) {
      // AAC user changed, clear current session
      console.log('AAC user changed, clearing chat session');
      clearSession();
    }
    
    currentAacUserIdRef.current = newAacUserId;
  }, [aacUser?.id, clearSession]);

  // Load persisted session on mount
  useEffect(() => {
    if (!persistSession || typeof window === 'undefined') {
      return;
    }
    
    const storedSessionId = window.localStorage.getItem(getStorageKey());
    
    if (storedSessionId && !session) {
      loadSession(storedSessionId).catch(err => {
        console.error('Failed to load stored session:', err);
        // Clear invalid stored session
        window.localStorage.removeItem(getStorageKey());
      });
    }
  }, [persistSession, getStorageKey, session, loadSession]);

  // ============================================================================
  // CONTEXT VALUE
  // ============================================================================

  const contextValue: ChatContextType = {
    // State
    session,
    sessionId: session?.id || null,
    history,
    mode,
    isLoading,
    isSending,
    error,
    
    // Actions
    sendMessage,
    startNewSession,
    loadSession,
    clearSession,
    setMode,
    
    // Utilities
    getLastAssistantMessage,
    getLastUserMessage,
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

/**
 * Hook to get just the chat history without other context
 */
export const useChatHistory = () => {
  const { history, isLoading } = useChat();
  return { history, isLoading };
};

/**
 * Hook to send messages with simplified interface
 */
export const useSendMessage = () => {
  const { sendMessage, isSending, error } = useChat();
  return { sendMessage, isSending, error };
};

/**
 * Hook for managing chat sessions
 */
export const useChatSession = () => {
  const { session, sessionId, startNewSession, loadSession, clearSession } = useChat();
  return { session, sessionId, startNewSession, loadSession, clearSession };
};