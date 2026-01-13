// src/hooks/useChat.tsx
import { useState, useEffect, createContext, useContext, ReactNode, useCallback, useRef } from 'react';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { useStudent } from './useStudent';
import { useInstitute } from './useInstitute';
import { useAuth } from './useAuth';
import { useFeaturePanel, useSharedState } from '@/contexts/FeaturePanelContext';
import { ChatMessage, FeatureType, ChatSession, ChatPersona } from '@shared/schema';
import { useChatStream } from './useChatStream';

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

// File attachment info
export interface AttachedFile {
  fileId: string;
  vectorStoreId: string;
  filename: string;
  mimeType: string;
  size: number;
  // Local file reference for display (not sent to server)
  localFile?: File;
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

  // Institute context data - extracted from Context_Institutes memory field
  institutes?: any;
  // Institute updates - trigger InstitutePanel reload
  institutesUpdated?: boolean;
  instituteUpdated?: {
    instituteId?: string;
  };

  // Student context data - extracted from Context_Students memory field
  students?: any;
  // Student updates - trigger StudentsPanel reload
  studentsUpdated?: boolean;
  studentUpdated?: {
    studentId?: string;
  };

  // Classroom updates - trigger InstitutePanel classroom tab reload
  classroomsUpdated?: {
    instituteId?: string;
  };

  // Institute student updates - trigger InstitutePanel students tab reload
  instituteStudentsUpdated?: {
    instituteId?: string;
  };

  // Reports context data - extracted from Context_Reports memory field
  reports?: any;
  // Report updates - trigger ReportsPanel reload
  reportsUpdated?: boolean;
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

  // Thinking state - for real-time AI status during tool calls
  thinkingText: string | null;
  isThinking: boolean;

  // AI-triggered data refresh state - panels use this to show loading indicators
  aiRefreshing: Set<string>;

  // File attachments
  attachedFiles: AttachedFile[];
  isUploadingFile: boolean;
  vectorStoreId: string | null;

  // Persona management
  setPersona: (persona: ChatPersona) => void;
  getPersonaInfo: (persona: ChatPersona) => PersonaInfo | undefined;

  // Actions
  sendMessage: (content: string, options?: SendMessageOptions) => Promise<ChatMessage | null>;
  startNewSession: (mode?: FeatureType) => Promise<boolean>;
  loadSession: (sessionId: string) => Promise<boolean>;
  clearSession: () => void;

  // File management
  uploadFile: (file: File) => Promise<AttachedFile | null>;
  removeFile: (fileId: string) => void;
  clearFiles: () => void;

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

  // Thinking state - for real-time AI status during tool calls
  const [thinkingText, setThinkingText] = useState<string | null>(null);
  const [isThinking, setIsThinking] = useState(false);

  // AI-triggered data refresh state - tracks which panels are being refreshed by AI actions
  const [aiRefreshing, setAiRefreshing] = useState<Set<string>>(new Set());

  // File attachment state
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [isUploadingFile, setIsUploadingFile] = useState(false);
  const [vectorStoreId, setVectorStoreId] = useState<string | null>(null);

  // Streaming hook
  const { sendStreamingMessage } = useChatStream();
  
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
  // FILE MANAGEMENT
  // ============================================================================

  // Generate a session ID for file uploads if we don't have one
  const getOrCreateSessionId = useCallback((): string => {
    if (session?.id) return session.id;
    // Generate a temporary session ID for file uploads before session is created
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    return tempId;
  }, [session?.id]);

  const uploadFile = useCallback(async (file: File): Promise<AttachedFile | null> => {
    setIsUploadingFile(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('sessionId', getOrCreateSessionId());

      // Use apiRequest which handles base URL, credentials, and error handling
      const response = await apiRequest('POST', '/api/chat/files/upload', formData);
      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || 'Failed to upload file');
      }

      const attachedFile: AttachedFile = {
        ...data.file,
        localFile: file,
      };

      setAttachedFiles(prev => [...prev, attachedFile]);
      setVectorStoreId(data.file.vectorStoreId);

      console.log('[useChat] File uploaded:', attachedFile.filename);

      return attachedFile;
    } catch (err: any) {
      console.error('File upload failed:', err);
      setError(err.message || 'Failed to upload file');
      return null;
    } finally {
      setIsUploadingFile(false);
    }
  }, [getOrCreateSessionId]);

  const removeFile = useCallback((fileId: string) => {
    setAttachedFiles(prev => prev.filter(f => f.fileId !== fileId));

    // Optionally delete from OpenAI (fire and forget)
    apiRequest('DELETE', `/api/chat/files/${fileId}`)
      .catch(err => console.warn('Failed to delete file from OpenAI:', err));
  }, []);

  const clearFiles = useCallback(() => {
    // Delete all files from OpenAI
    attachedFiles.forEach(file => {
      apiRequest('DELETE', `/api/chat/files/${file.fileId}`)
        .catch(err => console.warn('Failed to delete file:', err));
    });

    setAttachedFiles([]);
    setVectorStoreId(null);
  }, [attachedFiles]);

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
      setAiRefreshing(prev => new Set(prev).add('progress'));

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

    // Handle institute updates - triggers InstitutePanel reload
    // Context_Institutes becomes "institutes" in contextData
    if (contextData.institutes || contextData.institutesUpdated || contextData.instituteUpdated) {
      console.log('[ChatProvider] Institutes data updated by AI, invalidating queries');
      setAiRefreshing(prev => new Set(prev).add('institute'));

      // Invalidate the main institutes list
      queryClient.invalidateQueries({ queryKey: ['/api/institutes'] });
      // Also invalidate pending invites in case they were affected
      queryClient.invalidateQueries({ queryKey: ['/api/invites/pending'] });

      // If a specific institute was updated, also invalidate its details
      const instituteId = contextData.instituteUpdated?.instituteId;
      if (instituteId) {
        queryClient.invalidateQueries({ queryKey: ['/api/institutes', instituteId] });
        queryClient.invalidateQueries({ queryKey: ['/api/institutes', instituteId, 'members'] });
        queryClient.invalidateQueries({ queryKey: ['/api/institutes', instituteId, 'classrooms'] });
        queryClient.invalidateQueries({ queryKey: ['/api/institutes', instituteId, 'students'] });
      }
    }

    // Handle classroom updates - triggers InstitutePanel classroom tab reload
    if (contextData.classroomsUpdated) {
      console.log('[ChatProvider] Classrooms data updated by AI, invalidating queries');
      setAiRefreshing(prev => new Set(prev).add('institute'));

      if (contextData.classroomsUpdated.instituteId) {
        const instituteId = contextData.classroomsUpdated.instituteId;
        queryClient.invalidateQueries({ queryKey: ['/api/institutes', instituteId, 'classrooms'] });
      }
    }

    // Handle institute students updates - triggers InstitutePanel students tab reload
    if (contextData.instituteStudentsUpdated) {
      console.log('[ChatProvider] Institute students data updated by AI, invalidating queries');
      setAiRefreshing(prev => new Set(prev).add('institute'));

      if (contextData.instituteStudentsUpdated.instituteId) {
        const instituteId = contextData.instituteStudentsUpdated.instituteId;
        queryClient.invalidateQueries({ queryKey: ['/api/institutes', instituteId, 'students'] });
      }
    }

    // Handle student updates - triggers StudentsPanel reload
    // Context_Students becomes "students" in contextData
    if (contextData.students || contextData.studentsUpdated || contextData.studentUpdated) {
      console.log('[ChatProvider] Students data updated by AI, invalidating queries');
      setAiRefreshing(prev => new Set(prev).add('students'));

      // Invalidate the main students list
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });

      // If a specific student was updated, also invalidate their details
      const updatedStudentId = contextData.studentUpdated?.studentId;
      if (updatedStudentId) {
        queryClient.invalidateQueries({ queryKey: ['/api/students', updatedStudentId] });
        queryClient.invalidateQueries({ queryKey: ['/api/students', updatedStudentId, 'programs'] });
        queryClient.invalidateQueries({ queryKey: ['/api/students', updatedStudentId, 'programs', 'current'] });
      }
    }

    // Handle reports updates - triggers ReportsPanel reload
    if (contextData.reports || contextData.reportsUpdated) {
      console.log('[ChatProvider] Reports data updated by AI, invalidating queries');
      setAiRefreshing(prev => new Set(prev).add('reports'));

      const studentId = student?.id;
      if (studentId) {
        // Invalidate all reports queries for the student
        queryClient.invalidateQueries({ queryKey: ['/api/students', studentId, 'reports'] });
      }
    }

    // Clear AI refreshing states after a short delay to allow queries to complete
    setTimeout(() => {
      setAiRefreshing(new Set());
    }, 2000);
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
    setIsThinking(false);
    setThinkingText(null);
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

    // Build request body
    const requestBody: Record<string, any> = {
      messages: [userMessage],
      replyType,
      activeFeature,
      persona,
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
    // Include vector store ID if files are attached
    if (vectorStoreId) {
      requestBody.vectorStoreId = vectorStoreId;
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

    // Helper to process response data (used by both streaming and non-streaming paths)
    const processResponseData = (data: any): ChatMessage | null => {
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
    };

    // Ref to track result from streaming (needed for closure)
    let streamingResult: ChatMessage | null = null;

    try {
      // Try streaming endpoint first for real-time thinking updates
      const streamCompleted = await sendStreamingMessage(requestBody, {
        onThinking: (text) => {
          setIsThinking(true);
          setThinkingText(text);
        },
        onComplete: (data) => {
          setIsThinking(false);
          setThinkingText(null);
          streamingResult = processResponseData(data);
        },
        onError: (errorMsg) => {
          // Log but don't fail - we'll try non-streaming fallback
          console.warn('[useChat] Streaming error, will fallback:', errorMsg);
        }
      });

      // If streaming completed successfully, return the result
      if (streamCompleted && streamingResult) {
        return streamingResult;
      }

      // Fallback to non-streaming endpoint if streaming didn't complete
      console.log('[useChat] Falling back to non-streaming endpoint');
      const response = await apiRequest('POST', '/api/chat', requestBody);
      const data = await response.json();

      return processResponseData(data);
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
      setIsThinking(false);
      setThinkingText(null);
    }
  }, [session, activeFeature, user, student, history, persistSession, getStorageKey, getFeatureMetadata, handleContextData, persona, sendStreamingMessage, vectorStoreId]);
  
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
    thinkingText,
    isThinking,
    aiRefreshing,
    attachedFiles,
    isUploadingFile,
    vectorStoreId,
    setPersona,
    getPersonaInfo,
    sendMessage,
    startNewSession,
    loadSession,
    clearSession,
    uploadFile,
    removeFile,
    clearFiles,
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