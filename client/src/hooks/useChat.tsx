// src/hooks/useChat.tsx
import { useState, useEffect, createContext, useContext, ReactNode, useCallback, useRef } from 'react';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { useStudent } from './useStudent';
import { useInstitute } from './useInstitute';
import { useAuth } from './useAuth';
import { useFeaturePanel, useSharedState } from '@/contexts/FeaturePanelContext';
import { ChatMessage, FeatureType, ChatSession, ChatPersona } from '@shared/schema';

// ============================================================================
// TYPES
// ============================================================================

export interface ChatMessageContent {
  text?: string;
  html?: string;
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

// Icon name type - matches Lucide icon names
export type PersonaIconName = 
  | 'Bot' 
  | 'Target' 
  | 'Stethoscope' 
  | 'GraduationCap' 
  | 'Activity' 
  | 'MessageCircle' 
  | 'Hand' 
  | 'Brain';

// Persona definitions with display info
export interface PersonaInfo {
  id: ChatPersona;
  labelKey: string;        // Translation key for label
  descriptionKey: string;  // Translation key for description
  iconName: PersonaIconName; // Lucide icon name (rendered by PersonaIcon component)
  color: string;           // Tailwind color class for background
  textColor: string;       // Tailwind color class for text/icon
}

// Available personas - SINGLE SOURCE OF TRUTH
export const CHAT_PERSONAS: PersonaInfo[] = [
  {
    id: 'assistant',
    labelKey: 'chat.persona.assistant',
    descriptionKey: 'chat.persona.assistantDesc',
    iconName: 'Bot',
    color: 'bg-primary/10',
    textColor: 'text-primary',
  },
  {
    id: 'coach',
    labelKey: 'chat.persona.coach',
    descriptionKey: 'chat.persona.coachDesc',
    iconName: 'Target',
    color: 'bg-amber-500/10',
    textColor: 'text-amber-600',
  },
  {
    id: 'clinical',
    labelKey: 'chat.persona.clinical',
    descriptionKey: 'chat.persona.clinicalDesc',
    iconName: 'Stethoscope',
    color: 'bg-blue-500/10',
    textColor: 'text-blue-600',
  },
  {
    id: 'teacher',
    labelKey: 'chat.persona.teacher',
    descriptionKey: 'chat.persona.teacherDesc',
    iconName: 'GraduationCap',
    color: 'bg-green-500/10',
    textColor: 'text-green-600',
  },
  {
    id: 'pediatric_physical_therapist',
    labelKey: 'chat.persona.pediatricPT',
    descriptionKey: 'chat.persona.pediatricPTDesc',
    iconName: 'Activity',
    color: 'bg-purple-500/10',
    textColor: 'text-purple-600',
  },
  {
    id: 'speech_language_pathologist',
    labelKey: 'chat.persona.slp',
    descriptionKey: 'chat.persona.slpDesc',
    iconName: 'MessageCircle',
    color: 'bg-pink-500/10',
    textColor: 'text-pink-600',
  },
  {
    id: 'occupational_therapist',
    labelKey: 'chat.persona.ot',
    descriptionKey: 'chat.persona.otDesc',
    iconName: 'Hand',
    color: 'bg-orange-500/10',
    textColor: 'text-orange-600',
  },
  {
    id: 'behavioral_specialist',
    labelKey: 'chat.persona.behavioral',
    descriptionKey: 'chat.persona.behavioralDesc',
    iconName: 'Brain',
    color: 'bg-cyan-500/10',
    textColor: 'text-cyan-600',
  },
];

// Helper to get persona info by ID
export const getPersonaById = (id: ChatPersona): PersonaInfo | undefined => {
  return CHAT_PERSONAS.find(p => p.id === id);
};

// AI response action types
export interface ChatResponseActions {
  // Navigation
  navigateToFeature?: FeatureType;
  
  // Context switching
  selectStudentId?: string;
  selectInstituteId?: string;
  
  // Persona
  setPersona?: ChatPersona;
  
  // Board/feature specific data
  board?: any;
  interpret?: any;
  program?: any;
  programUpdated?: {
    programId?: string;
    goalId?: string;
  };
}

interface ChatContextType {
  // State
  session: ChatSession | null;
  sessionId: string | null;
  history: ChatMessage[];
  mode: FeatureType;
  isLoading: boolean;
  isSending: boolean;
  error: string | null;
  persona: ChatPersona;
  
  // Persona management
  setPersona: (persona: ChatPersona) => void;
  getPersonaInfo: (persona: ChatPersona) => PersonaInfo | undefined;
  
  // Actions
  sendMessage: (content: string, options?: SendMessageOptions) => Promise<ChatMessage | null>;
  startNewSession: (mode?: FeatureType) => Promise<boolean>;
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
  const [persona, setPersonaState] = useState<ChatPersona>('assistant');
  const [error, setError] = useState<string | null>(null);
  
  // Refs
  const currentStudentIdRef = useRef<string | null>(null);
  
  // External hooks
  const { student, selectStudent } = useStudent();
  const { selectInstitute } = useInstitute();
  const { user } = useAuth();
  const { activeFeature, getFeatureMetadata, setActiveFeature } = useFeaturePanel();
  const { setSharedState } = useSharedState();

  // DEBUG: Track activeFeature and sendMessage recreation
  useEffect(() => {
    console.log('[ChatProvider] activeFeature changed to:', activeFeature);
  }, [activeFeature]);

  
  // Storage keys
  const getStorageKey = useCallback(() => {
    const userPart = user?.id || 'anonymous';
    const aacPart = student?.id || 'none';
    return `chat.session.${userPart}.${aacPart}.${activeFeature}`;
  }, [user?.id, student?.id, activeFeature]);

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

  const startNewSession = useCallback(async (newMode?: FeatureType): Promise<boolean> => {
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
  // PERSONA MANAGEMENT
  // ============================================================================
  
  const setPersona = useCallback((newPersona: ChatPersona) => {
    console.log('[ChatProvider] Persona changed to:', newPersona);
    setPersonaState(newPersona);
  }, []);

  const getPersonaInfo = useCallback((personaId: ChatPersona): PersonaInfo | undefined => {
    return CHAT_PERSONAS.find(p => p.id === personaId);
  }, []);

  // ============================================================================
  // HANDLE CONTEXT DATA FROM RESPONSE
  // ============================================================================

  const handleContextData = useCallback((contextData: ChatResponseActions | undefined) => {
    if (!contextData) return;

    console.log('[ChatProvider] Processing contextData:', Object.keys(contextData));

    // Handle persona change from AI
    if (contextData.setPersona) {
      const validPersona = CHAT_PERSONAS.find(p => p.id === contextData.setPersona);
      if (validPersona) {
        console.log('[ChatProvider] AI requested persona change to:', contextData.setPersona);
        setPersonaState(contextData.setPersona);
      }
    }

    // Handle feature navigation from AI
    if (contextData.navigateToFeature) {
      console.log('[ChatProvider] AI requested navigation to:', contextData.navigateToFeature);
      setActiveFeature(contextData.navigateToFeature);
    }

    // Handle student selection from AI
    if (contextData.selectStudentId) {
      console.log('[ChatProvider] AI requested student selection:', contextData.selectStudentId);
      selectStudent(contextData.selectStudentId);
    }

    // Handle institute selection from AI
    if (contextData.selectInstituteId) {
      console.log('[ChatProvider] AI requested institute selection:', contextData.selectInstituteId);
      selectInstitute(contextData.selectInstituteId);
    }

    // Handle board data from boards mode
    if (contextData.board) {
      console.log('[ChatProvider] Received board data from response:', contextData.board);
      setSharedState({ 
        boardGeneratorData: { 
          board: contextData.board 
        } 
      });
    }

    // Handle interpret data (future)
    if (contextData.interpret) {
      setSharedState({ interpretData: contextData.interpret });
    }

    // Handle program updates from progress mode
    if (contextData.program || contextData.programUpdated) {
      console.log('[ChatProvider] Program data updated by AI, invalidating queries:', contextData.program);
      
      const programId = contextData.program?.id || contextData.programUpdated?.programId;
      const studentId = student?.id;
      
      if (programId) {
        queryClient.invalidateQueries({ queryKey: ['/api/programs', programId, 'full'] });
        queryClient.invalidateQueries({ queryKey: ['/api/programs', programId] });
      }
      
      if (studentId) {
        queryClient.invalidateQueries({ queryKey: ['/api/students', studentId, 'programs'] });
        queryClient.invalidateQueries({ queryKey: ['/api/students', studentId, 'programs', 'current'] });
      }
      
      if (contextData.programUpdated?.goalId) {
        queryClient.invalidateQueries({ queryKey: ['/api/goals', contextData.programUpdated.goalId] });
      }
      
      if (contextData.program) {
        setSharedState({ programData: contextData.program });
      }
    }
  }, [setSharedState, student?.id, setActiveFeature, selectStudent, selectInstitute]);

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

    console.log('[useChat] Sending message in mode:', activeFeature, featureMetadata);

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
        activeFeature,
        persona, // Include current persona in request
      };
      
      if (session?.id) {
        requestBody.sessionId = session.id;
      }
      
      if (user?.id) {
        requestBody.userId = user.id;
      }
      if (student?.id) {
        requestBody.studentId = student.id;
      }

      // Add featureContext for boards mode
      if (activeFeature === 'boards' && featureMetadata?.featureContext) {
        requestBody.featureContext = featureMetadata.featureContext;
        console.log('[useChat] Sending featureContext for boards mode:', {
          hasData: !!featureMetadata.featureContext.board?.data,
          boardName: featureMetadata.featureContext.board?.data?.name,
          pageCount: featureMetadata.featureContext.board?.data?.pages?.length,
          buttonCount: featureMetadata.featureContext.board?.data?.pages?.reduce(
            (sum: number, p: any) => sum + (p.buttons?.length || 0), 0
          ),
        });
      } else if (activeFeature === 'boards') {
        console.warn('[useChat] In boards mode but no featureContext available from metadata builder');
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

        // Handle contextData from the response
        if (data.contextData) {
          handleContextData(data.contextData);
        }
        
        // Update session
        if (data.sessionId && (!session?.id || data.sessionId !== session.id)) {
          const newSession: ChatSession = {
            id: data.sessionId,
            userId: user?.id || null,
            studentId: student?.id || null,
            chatMode: activeFeature || 'chat',
            started: new Date(),
            lastUpdate: new Date(),
            state: data.chatState || {},
            log: [...history, userMessage, assistantMessage],
            last: [userMessage, assistantMessage],
            creditsUsed: data.creditsUsed || 0,
            status: 'open',
            createdAt: data.createdAt ? new Date(data.createdAt) : new Date(),
            updatedAt: data.updatedAt ? new Date(data.updatedAt) : new Date(),
            userStudentId: null,
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
  }, [session, activeFeature, user, student, history, persistSession, getStorageKey, getFeatureMetadata, handleContextData, persona]);
  
  useEffect(() => {
    console.log('[ChatProvider] sendMessage was recreated, activeFeature is:', activeFeature);
  }, [sendMessage]);

  // ============================================================================
  // FEATURE-SPECIFIC METHODS
  // ============================================================================

  const sendBoardPrompt = useCallback(async (prompt: string): Promise<ChatMessage | null> => {
    return sendMessage(prompt, { replyType: 'html' });
  }, [sendMessage]);

  const sendInterpretRequest = useCallback(async (
    content: string, 
    context?: any
  ): Promise<ChatMessage | null> => {
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
    const newStudentId = student?.id || null;
    
    if (currentStudentIdRef.current !== null && 
        currentStudentIdRef.current !== newStudentId) {
      console.log('AAC user changed, clearing chat session');
      clearSession();
    }
    
    currentStudentIdRef.current = newStudentId;
  }, [student?.id, clearSession]);

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
    mode: activeFeature || 'chat',
    isLoading,
    isSending,
    error,
    persona,
    setPersona,
    getPersonaInfo,
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

export const useChatPersona = () => {
  const { persona, setPersona, getPersonaInfo } = useChat();
  return { persona, setPersona, getPersonaInfo, personas: CHAT_PERSONAS };
};

export const useBoardChat = () => {
  const { sendBoardPrompt, getFeatureData, isSending } = useChat();
  const boardData = getFeatureData<BoardGeneratorResponse>('boardGeneratorData');
  return { sendBoardPrompt, boardData, isSending };
};