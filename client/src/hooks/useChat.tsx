// src/hooks/useChat.tsx
import { useState, useEffect, createContext, useContext, ReactNode, useCallback, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest, queryClient, ServiceUnavailableError } from '@/lib/queryClient';
import { useLanguage } from '@/contexts/LanguageContext';
import { useStudent } from './useStudent';
import { useInstitute } from './useInstitute';
import { useAuth } from './useAuth';
import { useFeaturePanel, useSharedState } from '@/contexts/FeaturePanelContext';
import { useBoardStore } from '@/store/board-store';
import { useCustomAppStore } from '@/store/custom-app-store';
import { ChatMessage, FeatureType, ChatSession } from '@shared/schema';
import { useChatStream } from './useChatStream';
import { toast } from '@/hooks/use-toast';

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
  type?: "document" | "image";
  // Base64 data URL for images (e.g. "data:image/png;base64,...")
  dataUrl?: string;
  // Server-extracted text content — sent back instead of raw base64 on subsequent messages
  extractedText?: string;
}

// Icon name type - matches Lucide icon names (for legacy support)
export type PersonaIconName =
  | 'Bot'
  | 'Target'
  | 'Stethoscope'
  | 'GraduationCap'
  | 'Activity'
  | 'MessageCircle'
  | 'Hand'
  | 'Brain';

// Persona from database - the new dynamic persona format
export interface PersonaInfo {
  id: string;              // UUID from database
  title: string;           // Display title (plain string or JSON multilingual)
  description?: string | null; // Description (plain string or JSON multilingual)
  icon: string;            // Emoji icon (e.g., "🤖", "🎯")
  prompt: string;          // Persona-specific prompt
  manualSelection: boolean; // Whether user can select this persona
  active: boolean;         // Whether persona is active
  testMode?: boolean;      // If true, only visible to system admins
}

// Legacy persona info type for backwards compatibility with hardcoded personas
export interface LegacyPersonaInfo {
  id: string;
  labelKey: string;        // Translation key for label
  descriptionKey: string;  // Translation key for description
  iconName: PersonaIconName; // Lucide icon name
  color: string;           // Tailwind color class for background
  textColor: string;       // Tailwind color class for text/icon
}

// Default fallback persona when API not loaded
const DEFAULT_PERSONA: PersonaInfo = {
  id: 'default',
  title: 'Assistant',
  icon: '🤖',
  prompt: '',
  manualSelection: true,
  active: true,
};

// AI response action types
export interface ChatResponseActions {
  // Navigation
  navigateToFeature?: FeatureType;

  // Context switching
  selectStudentId?: string;
  selectInstituteId?: string;

  // Persona (UUID from database)
  setPersona?: string;
  
  // Board/feature specific data
  board?: any;
  customapp?: any;
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

  // Calendar context data - extracted from Context_Calendar memory field
  calendar?: any;
  // Calendar updates - trigger CalendarPanel reload
  calendarUpdated?: boolean;

  // AAC settings - extracted from Context_AACSettings / Context_AACPrompt memory fields
  aacsettings?: any;
  aacprompt?: any;
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
  /** Current persona ID (UUID from database, or undefined for default) */
  persona: string | undefined;

  // Thinking state - for real-time AI status during tool calls
  thinkingText: string | null;
  isThinking: boolean;

  // AI-triggered data refresh state - panels use this to show loading indicators
  aiRefreshing: Set<string>;

  // File attachments
  pendingFiles: AttachedFile[];  // Newly uploaded, not yet sent with a message
  contextFiles: AttachedFile[];  // Already sent, available as context for future messages
  attachedFiles: AttachedFile[]; // Combined (pendingFiles + contextFiles) — all active files
  isUploadingFile: boolean;
  vectorStoreId: string | null;

  // Persona management
  personas: PersonaInfo[];          // Available personas from API
  isPersonasLoading: boolean;       // Loading state for personas
  setPersona: (persona: string | undefined) => void;
  getPersonaInfo: (personaId: string | undefined) => PersonaInfo | undefined;

  // Actions
  sendMessage: (content: string, options?: SendMessageOptions) => Promise<ChatMessage | null>;
  stopGeneration: () => void;
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
  replyType?: 'text' | 'html' | 'md';
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
  const [persona, setPersonaState] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  // External hooks - need user for enabled condition on personas query
  const { user } = useAuth();
  const { t } = useLanguage();

  // Fetch selectable personas from API (only when authenticated)
  const { data: personas = [], isLoading: isPersonasLoading } = useQuery({
    queryKey: ['/api/personas/selectable'],
    queryFn: async () => {
      const res = await apiRequest('GET', '/api/personas/selectable');
      const data = await res.json();
      return (data.personas || []) as PersonaInfo[];
    },
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
    enabled: !!user, // Only fetch when user is authenticated
  });

  // Thinking state - for real-time AI status during tool calls
  const [thinkingText, setThinkingText] = useState<string | null>(null);
  const [isThinking, setIsThinking] = useState(false);

  // AI-triggered data refresh state - tracks which panels are being refreshed by AI actions
  const [aiRefreshing, setAiRefreshing] = useState<Set<string>>(new Set());

  // File attachment state
  const [pendingFiles, setPendingFiles] = useState<AttachedFile[]>([]); // Not yet sent with a message
  const [contextFiles, setContextFiles] = useState<AttachedFile[]>([]); // Already sent, available as context
  const attachedFiles = [...pendingFiles, ...contextFiles]; // Combined view
  const [isUploadingFile, setIsUploadingFile] = useState(false);
  const [vectorStoreId, setVectorStoreId] = useState<string | null>(null);


  // Streaming hook
  const { sendStreamingMessage, abort: abortStream } = useChatStream();
  const stoppedByUserRef = useRef(false);

  // Refs
  const currentStudentIdRef = useRef<string | null>(null);
  
  // External hooks
  const { student, selectStudent } = useStudent();
  const { currentInstitute, selectInstitute } = useInstitute();
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
    setPendingFiles([]);
    setContextFiles([]);

    if (persistSession && typeof window !== 'undefined') {
      window.localStorage.removeItem(getStorageKey());
    }

    return true;
  }, [persistSession, getStorageKey]);

  const clearSession = useCallback(() => {
    setSession(null);
    setHistory([]);
    setError(null);
    setPendingFiles([]);
    setContextFiles([]);

    if (persistSession && typeof window !== 'undefined') {
      window.localStorage.removeItem(getStorageKey());
    }
  }, [persistSession, getStorageKey]);

  // ============================================================================
  // PERSONA MANAGEMENT
  // ============================================================================

  const setPersona = useCallback((newPersona: string | undefined) => {
    console.log('[ChatProvider] Persona changed to:', newPersona);
    setPersonaState(newPersona);
  }, []);

  const getPersonaInfo = useCallback((personaId: string | undefined): PersonaInfo | undefined => {
    if (!personaId || personaId === 'default') return DEFAULT_PERSONA;
    return personas.find(p => p.id === personaId) ?? DEFAULT_PERSONA;
  }, [personas]);

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
      const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
      const isImage = IMAGE_TYPES.includes(file.type);

      // Read image data URL for preview thumbnail only
      let dataUrl: string | undefined;
      if (isImage) {
        dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
      }

      const attachedFile: AttachedFile = {
        fileId: `local-${isImage ? 'img' : 'doc'}-${Date.now()}`,
        vectorStoreId: "",
        filename: file.name,
        mimeType: file.type,
        size: file.size,
        localFile: file,
        type: isImage ? "image" : "document",
        dataUrl, // Only set for images (preview thumbnail)
      };
      // Same-name file overwrites: remove any existing file with the same name
      setPendingFiles(prev => prev.filter(f => f.filename !== file.name));
      setContextFiles(prev => prev.filter(f => f.filename !== file.name));
      // Add to pending (will be moved to context on send)
      setPendingFiles(prev => [...prev, attachedFile]);
      return attachedFile;
    } catch (err: any) {
      console.error('File upload failed:', err);
      toast({ variant: "destructive", title: "Upload failed", description: err.message || "Failed to upload file" });
      return null;
    } finally {
      setIsUploadingFile(false);
    }
  }, []);

  const removeFile = useCallback((fileId: string) => {
    setPendingFiles(prev => prev.filter(f => f.fileId !== fileId));
    setContextFiles(prev => prev.filter(f => f.fileId !== fileId));
  }, []);

  const clearFiles = useCallback(() => {
    setPendingFiles([]);
    setContextFiles([]);
    setVectorStoreId(null);
  }, []);

  // ============================================================================
  // HANDLE CONTEXT DATA FROM RESPONSE
  // ============================================================================

  const handleContextData = useCallback((contextData: ChatResponseActions | undefined) => {
    if (!contextData) return;

    console.log('[ChatProvider] Processing contextData:', Object.keys(contextData));

    // Handle persona change from AI
    if (contextData.setPersona) {
      // Validate that the persona ID exists in our loaded personas
      const validPersona = personas.find(p => p.id === contextData.setPersona);
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

    // Handle board data from response — update board store directly
    // (BoardSelector may not be mounted if user is on a different panel)
    if (contextData.board) {
      console.log('[ChatProvider] Received board data from response:', contextData.board);
      const { activeBoardId, board: currentBoard } = useBoardStore.getState();
      if (activeBoardId && currentBoard) {
        useBoardStore.getState().updateBoard(contextData.board);
      } else {
        useBoardStore.getState().setBoard(contextData.board);
      }
      // Also set sharedState for BoardSelector (legacy path / display updates)
      setSharedState({
        boardGeneratorData: {
          board: contextData.board
        }
      });
    }

    // Handle custom app (game) data from response — update store directly so
    // the panel doesn't need to be mounted to receive updates from the AI.
    if (contextData.customapp) {
      console.log('[ChatProvider] Received custom app data from response');
      useCustomAppStore.getState().setDefinition(contextData.customapp, { markDirty: true });
      setSharedState({ customAppGeneratorData: { app: contextData.customapp } });
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

    // Handle calendar updates - triggers CalendarPanel reload
    if (contextData.calendar || contextData.calendarUpdated) {
      console.log('[ChatProvider] Calendar data updated by AI, invalidating queries');
      queryClient.invalidateQueries({ queryKey: ['/api/calendar/events'] });
    }

    // Handle AAC settings updates - triggers AACSettingsPanel reload
    if (contextData.aacsettings || contextData.aacprompt) {
      console.log('[ChatProvider] AAC settings updated by AI, invalidating queries');
      setAiRefreshing(prev => new Set(prev).add('aac-settings'));

      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      const studentId = student?.id;
      if (studentId) {
        queryClient.invalidateQueries({ queryKey: ['/api/students', studentId] });
      }
    }

    // Clear AI refreshing states after a short delay to allow queries to complete
    setTimeout(() => {
      setAiRefreshing(new Set());
    }, 2000);
  }, [setSharedState, student?.id, setActiveFeature, selectStudent, selectInstitute, personas]);

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

    const { replyType = 'md', additionalMetadata } = options;

    stoppedByUserRef.current = false;
    setIsSending(true);
    setIsThinking(false);
    setThinkingText(null);
    setError(null);

    // Get feature-specific metadata from the active feature's builder
    const featureMetadata = activeFeature ? getFeatureMetadata(activeFeature) : {};

    console.log('[useChat] Sending message in mode:', activeFeature, featureMetadata);

    // Only newly-uploaded files get tagged on this message
    const newFileNames = pendingFiles.map(f => f.filename);
    const metadata = {
      ...featureMetadata,
      ...additionalMetadata,
      ...(newFileNames.length > 0 ? { files: newFileNames } : {}),
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

    // Move pending files to context (they've been associated with this message)
    if (pendingFiles.length > 0) {
      setContextFiles(prev => [...prev, ...pendingFiles]);
      setPendingFiles([]);
    }

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
    if (currentInstitute?.id) {
      requestBody.instituteId = currentInstitute.id;
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

        // Cache any file extractions from the response (non-streaming fallback)
        if (data.extractions && Array.isArray(data.extractions)) {
          for (const ext of data.extractions) {
            setContextFiles(prev => prev.map(f =>
              f.filename === ext.filename ? { ...f, extractedText: ext.extractedText } : f
            ));
          }
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
            useResponsesAPI: null,
            pendingMessages: [],
            interactivePrompt: null,
            monitorBusy: null,
            monitorBusySince: null,
            thinkingMode: null,
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

    // Accumulated text for md streaming mode
    let mdAccumulated = '';

    // Send all attached files — if we have cached extracted text, send that instead of raw base64
    if (attachedFiles.length > 0) {
      const documents: Array<{ dataUrl: string; filename: string; extractedText?: string }> = [];
      for (const f of attachedFiles) {
        if (f.extractedText) {
          // Server already extracted this file — send extracted text, skip raw data
          documents.push({ dataUrl: '', filename: f.filename, extractedText: f.extractedText });
        } else if (f.dataUrl) {
          // Images already have a dataUrl from when they were attached
          documents.push({ dataUrl: f.dataUrl, filename: f.filename });
        } else if (f.localFile) {
          // Documents: read from the stored File object
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(f.localFile!);
          });
          documents.push({ dataUrl, filename: f.filename });
        }
      }
      if (documents.length > 0) {
        requestBody.documents = documents;
      }
    }

    try {
      // Try streaming endpoint first for real-time thinking updates
      const streamCompleted = await sendStreamingMessage(requestBody, {
        onThinking: (text) => {
          setIsThinking(true);
          setThinkingText(text);
          // Clear accumulated text — any text before a tool call is preamble,
          // not part of the final response (the model will regenerate after tools)
          if (replyType === 'md') {
            mdAccumulated = '';
          }
        },
        onTextDelta: (text) => {
          if (replyType === 'md') {
            setIsThinking(false);
            setThinkingText(null);
            mdAccumulated += text;
            // Update streaming placeholder message in history
            const streamingMessage: ChatMessage = {
              role: 'assistant',
              content: { md: mdAccumulated },
              timestamp: Date.now(),
              metadata: { isStreaming: true },
            };
            setHistory(prev => {
              // Replace existing streaming message or add new one
              const lastIdx = prev.length - 1;
              if (lastIdx >= 0 && (prev[lastIdx].metadata as any)?.isStreaming) {
                const updated = [...prev];
                updated[lastIdx] = streamingMessage;
                return updated;
              }
              return [...prev, streamingMessage];
            });
          }
        },
        onNavigate: (feature) => {
          console.log('[useChat] AI navigating to:', feature);
          setActiveFeature(feature as any);
        },
        onSelectStudent: (studentId) => {
          console.log('[useChat] AI selecting student:', studentId);
          selectStudent(studentId);
        },
        onFileExtracted: (filename, extractedText) => {
          // Cache extracted text on the file so we send it instead of raw base64 next time
          setContextFiles(prev => prev.map(f =>
            f.filename === filename ? { ...f, extractedText } : f
          ));
        },
        onFilesNeeded: async (files) => {
          // Server needs us to re-upload expired media files
          for (const { fileId, filename } of files) {
            // Find the file in our local state
            const localFile = [...contextFiles, ...pendingFiles].find(f => f.filename === filename);
            if (!localFile?.localFile) {
              console.warn(`[useChat] Cannot re-upload ${filename}: local file not available`);
              continue;
            }
            try {
              const formData = new FormData();
              formData.append('file', localFile.localFile);
              formData.append('fileId', fileId);
              const response = await fetch(
                (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, "")
                  ? `${(import.meta.env.VITE_API_URL as string).replace(/\/+$/, "")}/api/chat/files/upload`
                  : '/api/chat/files/upload',
                { method: 'POST', body: formData, credentials: 'include' }
              );
              if (response.ok) {
                console.log(`[useChat] Re-uploaded expired file: ${filename} (${fileId})`);
              }
            } catch (err) {
              console.error(`[useChat] Failed to re-upload ${filename}:`, err);
            }
          }
        },
        onComplete: (data) => {
          try {
            setIsThinking(false);
            setThinkingText(null);
            if (replyType === 'md') {
              // Remove the streaming placeholder before adding the final message
              setHistory(prev => prev.filter(m => !(m.metadata as any)?.isStreaming));
            }
            streamingResult = processResponseData(data);
          } catch (err) {
            console.error('[useChat] Error processing streaming response:', err);
            // Still mark as completed to prevent fallback — the AI already responded
            streamingResult = {
              role: 'assistant',
              content: data?.message?.content || { md: mdAccumulated || '' },
              timestamp: Date.now(),
            };
            // Ensure contextData (board updates, etc.) is still processed
            try {
              if (data?.contextData) {
                handleContextData(data.contextData);
              }
            } catch (ctxErr) {
              console.error('[useChat] Error processing contextData in fallback:', ctxErr);
            }
          }
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

      // If user explicitly stopped, don't fall back
      if (stoppedByUserRef.current) {
        return null;
      }

      // If we already received streaming content (md mode), don't fire
      // a redundant non-streaming request that would duplicate the response
      if (replyType === 'md' && mdAccumulated) {
        console.log('[useChat] Streaming content already received, skipping fallback');
        return streamingResult;
      }

      // Retry streaming with a short delay (handles cold-start on new Lambda instance)
      console.log('[useChat] Streaming did not complete, retrying after delay...');
      await new Promise(resolve => setTimeout(resolve, 3000));

      if (stoppedByUserRef.current) return null;

      try {
        const retryResponse = await apiRequest('POST', '/api/chat', requestBody);
        const retryData = await retryResponse.json();
        return processResponseData(retryData);
      } catch (retryErr: any) {
        console.error('Retry also failed:', retryErr);
        throw retryErr; // let the outer catch handle it
      }
    } catch (err: any) {
      console.error('Send message failed:', err);
      const errorText = err instanceof ServiceUnavailableError
        ? t("error.serviceUnavailable")
        : err.message || t("chat.error");
      setError(errorText);
      toast({ variant: "destructive", title: t("error.title"), description: errorText });

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
  }, [session, activeFeature, user, student, history, persistSession, getStorageKey, getFeatureMetadata, handleContextData, persona, sendStreamingMessage, vectorStoreId, pendingFiles, contextFiles]);
  
  const stopGeneration = useCallback(() => {
    stoppedByUserRef.current = true;
    abortStream();
    setIsSending(false);
    setIsThinking(false);
    setThinkingText(null);
    // Convert any streaming placeholder to a final message
    setHistory(prev => prev.map(m =>
      (m.metadata as any)?.isStreaming
        ? { ...m, metadata: undefined }
        : m
    ));
  }, [abortStream]);

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
    pendingFiles,
    contextFiles,
    attachedFiles,
    isUploadingFile,
    vectorStoreId,
    personas,
    isPersonasLoading,
    setPersona,
    getPersonaInfo,
    sendMessage,
    stopGeneration,
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
  const { persona, setPersona, getPersonaInfo, personas, isPersonasLoading } = useChat();
  return { persona, setPersona, getPersonaInfo, personas, isPersonasLoading };
};

export const useBoardChat = () => {
  const { sendBoardPrompt, getFeatureData, isSending } = useChat();
  const boardData = getFeatureData<BoardGeneratorResponse>('boardGeneratorData');
  return { sendBoardPrompt, boardData, isSending };
};