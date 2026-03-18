// src/features/ChatFeature.tsx
// Updated with speech-to-text and text-to-speech functionality

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Plus,
  Settings2,
  Mic,
  MicOff,
  Send,
  Square,
  Minimize2,
  Sparkles,
  Paperclip,
  X,
  FileText,
  Image,
  Loader2,
  Volume2,
  VolumeX,
  Copy,
  Check,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useChat, type AttachedFile } from '@/hooks/useChat';
import { useStudent } from '@/hooks/useStudent';
import { useLanguage } from '@/contexts/LanguageContext';
import { useSharedState, useFeaturePanel } from '@/contexts/FeaturePanelContext';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useSpeechToText } from '@/hooks/useSpeechToText';
import { useTextToSpeech, htmlToPlainText } from '@/hooks/useTextToSpeech';
import { ChatMessage, ChatMessageContent } from '@shared/schema';
import { PersonaIcon, getPersonaColorClasses } from '@/components/chat/PersonaIcon';
import { resolveLocalizedText } from '@shared/localized-text';
import { cn } from '@/lib/utils';
import { marked } from 'marked';

// Configure marked for synchronous rendering
marked.setOptions({ async: false });

export function ChatFeature() {
  const [prompt, setPrompt] = useState('');
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [copiedMessageIndex, setCopiedMessageIndex] = useState<number | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastReadMessageRef = useRef<number | null>(null);
  
  const { user } = useAuth();
  const { student } = useStudent();
  const { t, isRTL, language } = useLanguage();
  const { sharedState, setSharedState } = useSharedState();
  const { 
    chatMode, 
    setChatMode, 
    activeFeature, 
    isFullScreenFeature,
    panels 
  } = useFeaturePanel();
  
  const {
    history,
    sendMessage,
    isSending,
    error,
    startNewSession,
    persona,
    setPersona,
    getPersonaInfo,
    personas,
    isPersonasLoading,
    thinkingText,
    isThinking,
    attachedFiles,
    isUploadingFile,
    uploadFile,
    removeFile,
    clearFiles,
    stopGeneration,
  } = useChat();
  
  // Text-to-speech hook
  const { 
    isSupported: ttsSupported, 
    isSpeaking, 
    speak, 
    stop: stopSpeaking,
  } = useTextToSpeech();

  // Speech-to-text hook with auto-send capability
  const handleSpeechResult = useCallback((transcript: string) => {
    if (transcript.trim() && !isSending) {
      // Append to existing prompt or set as new
      setPrompt(prev => {
        const newPrompt = prev ? `${prev} ${transcript}` : transcript;
        return newPrompt;
      });
    }
  }, [isSending]);

  const {
    isSupported: sttSupported,
    isListening,
    interimTranscript,
    startListening,
    stopListening,
    toggleListening,
    error: sttError,
    isDisabled: sttDisabled,
  } = useSpeechToText({
    onResult: handleSpeechResult,
    continuous: false,
  });
  
  const isMobile = useIsMobile();
  const showWelcome = history.length === 0;
  const showTools = false; // Placeholder for future tools feature

  // Check if a panel is currently open
  const isPanelOpen = activeFeature && activeFeature !== 'chat' && panels[activeFeature]?.isOpen;

  // Show mode switch only when there's an open panel and we're in expanded mode (desktop only)
  const showModeSwitch = isPanelOpen && chatMode === 'expanded' && !isFullScreenFeature && !isMobile;

  // Current persona info
  const currentPersonaInfo = getPersonaInfo(persona);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history, isSending]);

  // Auto-read new assistant messages when TTS is enabled
  useEffect(() => {
    if (!ttsEnabled || !ttsSupported) return;
    
    const lastMessage = history[history.length - 1];
    if (
      lastMessage?.role === 'assistant' && 
      lastMessage.timestamp !== lastReadMessageRef.current
    ) {
      const content = getMessageContent(lastMessage);
      const plainText = containsHtmlTags(content) ? htmlToPlainText(content) : content;
      
      if (plainText.trim()) {
        speak(plainText);
        lastReadMessageRef.current = lastMessage.timestamp;
      }
    }
  }, [history, ttsEnabled, ttsSupported, speak]);

  // Process chat responses for feature-specific data
  useEffect(() => {
    const lastAssistantMessage = history.filter(m => m.role === 'assistant').pop();
    
    if (lastAssistantMessage) {
      setSharedState({ lastChatResponse: lastAssistantMessage });
      
      // Check for board generator data in response
      const content = lastAssistantMessage.content;
      if (typeof content === 'object' && content !== null) {
        const contentObj = content as ChatMessageContent & { boardGeneratorData?: any };
        if (contentObj.boardGeneratorData) {
          setSharedState({ boardGeneratorData: contentObj.boardGeneratorData });
        }
      }
    }
  }, [history, setSharedState]);

  // Handle pending prompts from features
  useEffect(() => {
    if (sharedState.pendingPrompt) {
      setPrompt(sharedState.pendingPrompt);
      setSharedState({ pendingPrompt: undefined });
      inputRef.current?.focus();
    }
  }, [sharedState.pendingPrompt, setSharedState]);

  // Auto-send when speech recognition completes and not already sending
  useEffect(() => {
    // If we just stopped listening and have a prompt, send it
    if (!isListening && prompt.trim() && !isSending) {
      // Small delay to allow final transcript to be processed
      const timeout = setTimeout(() => {
        handleSend();
      }, 500);
      return () => clearTimeout(timeout);
    }
  }, [isListening]);

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return t('chat.greeting.morning');
    if (hour < 18) return t('chat.greeting.afternoon');
    return t('chat.greeting.evening');
  };

  const handleVoiceInput = () => {
    toggleListening();
  };

  const handleSend = useCallback(async () => {
    if (prompt.trim() && !isSending) {
      const messageText = prompt.trim();
      setPrompt('');
      await sendMessage(messageText);
      inputRef.current?.focus();
    }
  }, [prompt, isSending, sendMessage]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const handleSuggestionClick = (promptKey: string) => {
    const promptText = t(promptKey, { name: student?.name || '' });
    setPrompt(promptText);
    inputRef.current?.focus();
  };

  const handleSwitchToPopup = () => {
    setChatMode('popup');
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    for (const file of Array.from(files)) {
      await uploadFile(file);
    }

    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleAddFilesClick = () => {
    fileInputRef.current?.click();
  };

  // Helper to get file icon based on mime type
  const getFileIcon = (mimeType: string) => {
    if (mimeType.startsWith('image/')) {
      return <Image className="w-4 h-4" />;
    }
    return <FileText className="w-4 h-4" />;
  };

  // Helper to format file size
  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handlePersonaChange = (newPersona: string) => {
    setPersona(newPersona === 'default' ? undefined : newPersona);
  };

  const handleToggleTts = () => {
    if (isSpeaking) {
      stopSpeaking();
    }
    setTtsEnabled(!ttsEnabled);
  };

  const handleSpeakMessage = (message: ChatMessage) => {
    const content = getMessageContent(message);
    const plainText = containsHtmlTags(content) ? htmlToPlainText(content) : content;
    if (plainText.trim()) {
      if (isSpeaking) {
        stopSpeaking();
      } else {
        speak(plainText);
      }
    }
  };

  const handleCopyMessage = async (message: ChatMessage, index: number) => {
    const content = getMessageContent(message);
    const plainText = containsHtmlTags(content) ? htmlToPlainText(content) : content;
    try {
      await navigator.clipboard.writeText(plainText);
      setCopiedMessageIndex(index);
      setTimeout(() => setCopiedMessageIndex(null), 2000);
    } catch {
      // fallback silently
    }
  };

  // Helper to extract display content from message
  const getMessageContent = (message: ChatMessage): string => {
    let text: string;
    if (typeof message.content === 'string') {
      text = message.content;
    } else {
      const content = message.content as ChatMessageContent;
      if (content.md) {
        return marked.parse(content.md) as string;
      }
      text = content.html || content.text || '';
    }
    // Translate error codes (e.g. "error:MESSAGE_FAILED" → translated string)
    if (text.startsWith('error:')) {
      return t(`errors.${text.slice(6)}`);
    }
    return text;
  };

  // Helper to detect if a string contains HTML markup
  const containsHtmlTags = (str: string): boolean => {
    // Check for common HTML tag patterns (opening tags like <p>, <div>, <br>, etc.)
    const htmlTagPattern = /<[a-z][^>]*\/?>/i;
    return htmlTagPattern.test(str);
  };

  // Helper to check if content is HTML (inspects actual content, not just the property)
  const isHtmlContent = (message: ChatMessage): boolean => {
    const content = getMessageContent(message);
    return containsHtmlTags(content);
  };

  const formatTimestamp = (timestamp: number): string => {
    return new Date(timestamp).toLocaleTimeString([], { 
      hour: '2-digit', 
      minute: '2-digit' 
    });
  };

  const getPlaceholder = () => {
    if (isListening) {
      return interimTranscript || t('chat.listening');
    }
    if (student) {
      return t('chat.placeholderWithUser', { name: student.name });
    }
    return t('chat.placeholder');
  };

  // Persona selector component
  const PersonaSelector = useMemo(() => (
    <div className="flex items-center gap-2 mb-4">
      <span className="text-xs text-muted-foreground">{t('chat.selectPersona')}:</span>
      <div className="flex gap-1 flex-wrap">
        {isPersonasLoading ? (
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
        ) : (
          <>
            {/* Default general assistant persona */}
            <Button
              size="sm"
              variant={!persona || persona === 'default' ? "default" : "outline"}
              className={cn(
                "h-8 gap-1.5 text-xs rounded-full transition-all",
                (!persona || persona === 'default') && "ring-2 ring-offset-2 ring-primary"
              )}
              onClick={() => handlePersonaChange('default')}
              title={t('chat.persona.assistantDesc')}
            >
              <span>🤖</span>
              <span>{t('chat.persona.assistant')}</span>
            </Button>
            {personas.map((p) => (
              <Button
                key={p.id}
                size="sm"
                variant={persona === p.id ? "default" : "outline"}
                className={cn(
                  "h-8 gap-1.5 text-xs rounded-full transition-all",
                  persona === p.id && "ring-2 ring-offset-2 ring-primary"
                )}
                onClick={() => handlePersonaChange(p.id)}
                title={resolveLocalizedText(p.description, language) || p.prompt?.substring(0, 100) || resolveLocalizedText(p.title, language)}
              >
                <span>{p.icon}</span>
                <span>{resolveLocalizedText(p.title, language)}</span>
                {p.testMode && <span className="text-[9px] text-amber-500 font-bold">TEST</span>}
              </Button>
            ))}
          </>
        )}
      </div>
    </div>
  ), [persona, t, language, personas, isPersonasLoading]);

  // Persona dropdown for chat header (matches popup style)
  const PersonaDropdown = !showWelcome && (
    <div className="flex items-center gap-2">
      <PersonaIcon persona={persona} size="md" withBackground />
      <Select
        value={persona || 'default'}
        onValueChange={handlePersonaChange}
        disabled={isPersonasLoading}
      >
        <SelectTrigger className="h-8 text-xs border-none bg-transparent shadow-none px-1 w-auto">
          <SelectValue placeholder={t('chat.selectPersona')} />
        </SelectTrigger>
        <SelectContent>
          {isPersonasLoading ? (
            <SelectItem value="loading" disabled>
              <Loader2 className="w-3 h-3 animate-spin" />
            </SelectItem>
          ) : (
            <>
              <SelectItem value="default">
                <div className="flex items-center gap-2">
                  <span>🤖</span>
                  <span className="text-sm">{t('chat.persona.assistant')}</span>
                </div>
              </SelectItem>
              {personas.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  <div className="flex items-center gap-2">
                    <span>{p.icon}</span>
                    <span className="text-sm">{resolveLocalizedText(p.title, language)}</span>
                    {p.testMode && <span className="text-[9px] text-amber-500 font-bold">TEST</span>}
                  </div>
                </SelectItem>
              ))}
            </>
          )}
        </SelectContent>
      </Select>
    </div>
  );

  // Mode switch button component
  const ModeSwitchButton = showModeSwitch && (
    <Button
      size="sm"
      variant="outline"
      className={cn(
        "absolute top-4 z-10 gap-2 rounded-full shadow-sm",
        "bg-background/80 backdrop-blur-sm hover:bg-background",
        "transition-all duration-200",
      )}
      onClick={handleSwitchToPopup}
      title={t('chat.switchToPopup')}
      data-testid="chat-mode-switch"
    >
      <Minimize2 className="w-4 h-4" />
      <span className="text-xs">{t('chat.popupMode')}</span>
    </Button>
  );

  // Voice control buttons
  const VoiceControls = useMemo(() => (
    <div className={cn("flex items-center gap-1", isRTL && "flex-row-reverse")}>
      {/* Speech-to-Text (Microphone) */}
      {sttSupported && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className={cn(
                "h-8 w-8 rounded-full hover-elevate active-elevate-2 transition-colors",
                isListening && "bg-red-500/20 text-red-500 animate-pulse",
                sttDisabled && "opacity-50 cursor-not-allowed"
              )}
              onClick={handleVoiceInput}
              disabled={sttDisabled || isSending}
              data-testid="button-voice"
              aria-label={isListening ? t('chat.stopListening') : t('chat.voiceInput')}
            >
              {isListening ? (
                <MicOff className="w-4 h-4" />
              ) : (
                <Mic className="w-4 h-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {sttDisabled 
              ? t('chat.voiceDisabledAudioPlaying')
              : isListening 
                ? t('chat.stopListening') 
                : t('chat.voiceInput')
            }
          </TooltipContent>
        </Tooltip>
      )}

      {/* Text-to-Speech Toggle */}
      {ttsSupported && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className={cn(
                "h-8 w-8 rounded-full hover-elevate active-elevate-2 transition-colors",
                ttsEnabled && "bg-blue-500/20 text-blue-500",
                isSpeaking && "animate-pulse"
              )}
              onClick={handleToggleTts}
              data-testid="button-tts"
              aria-label={ttsEnabled ? t('chat.disableTts') : t('chat.enableTts')}
            >
              {ttsEnabled ? (
                <Volume2 className="w-4 h-4" />
              ) : (
                <VolumeX className="w-4 h-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {ttsEnabled ? t('chat.disableTts') : t('chat.enableTts')}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  ), [sttSupported, ttsSupported, isListening, ttsEnabled, isSpeaking, sttDisabled, isSending, isRTL, t]);

  // Input bar component
  const InputBar = useMemo(() => (
    <div className="space-y-2">
      {/* Attached files list */}
      {attachedFiles.length > 0 && (
        <div
          dir={isRTL ? 'rtl' : 'ltr'}
          className="flex flex-wrap gap-2 px-2"
        >
          {attachedFiles.map((file) => (
            <div
              key={file.fileId}
              className="flex items-center gap-2 bg-muted/50 border border-border rounded-lg px-3 py-1.5 text-sm"
            >
              {file.type === "image" && file.dataUrl ? (
                <img src={file.dataUrl} className="w-6 h-6 rounded object-cover" />
              ) : (
                getFileIcon(file.mimeType)
              )}
              <span className="max-w-[150px] truncate">{file.filename}</span>
              <span className="text-xs text-muted-foreground">
                ({formatFileSize(file.size)})
              </span>
              <Button
                size="icon"
                variant="ghost"
                className="h-5 w-5 rounded-full hover:bg-destructive/10 hover:text-destructive"
                onClick={() => removeFile(file.fileId)}
                aria-label={t('chat.removeFile')}
              >
                <X className="w-3 h-3" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileSelect}
        accept=".pdf,.txt,.md,.json,.csv,.xml,.html,.css,.js,.ts,.py,.java,.c,.cpp,.h,.hpp,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.gif,.webp"
      />

      {/* Speech recognition error display */}
      {sttError && (
        <div className="text-xs text-destructive px-4">
          {sttError}
        </div>
      )}

      {/* Main input bar */}
      <div
        dir={isRTL ? 'rtl' : 'ltr'}
        className={cn(
          "relative bg-card border rounded-full px-6 py-4 flex items-center gap-3",
          isListening ? "border-red-500/50 ring-2 ring-red-500/20" : "border-card-border"
        )}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 rounded-full hover-elevate active-elevate-2"
              data-testid="button-add-attachment"
              aria-label={t('chat.addAttachment')}
              disabled={isUploadingFile}
            >
              {isUploadingFile ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Plus className="w-5 h-5" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={handleAddFilesClick}>
              <Paperclip className="w-4 h-4 me-2" />
              {t('chat.addFiles')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {showTools && (
          <Button
            variant="ghost"
            className="h-8 rounded-full hover-elevate active-elevate-2"
            data-testid="button-tools"
            onClick={() => console.log('Tools clicked')}
          >
            <Settings2 className="w-4 h-4" />
            <span className="text-sm ms-2">{t('chat.tools')}</span>
          </Button>
        )}

        <Input
          ref={inputRef}
          value={isListening ? (interimTranscript || prompt) : prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={getPlaceholder()}
          className={cn(
            "flex-1 border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 text-base h-8 px-2",
            isListening && "text-muted-foreground italic"
          )}
          dir={isRTL ? 'rtl' : 'ltr'}
          data-testid="input-prompt"
          onKeyDown={handleKeyDown}
          disabled={isSending || isListening}
        />

        {/* Voice Controls */}
        {VoiceControls}

        {isSending ? (
          <Button
            size="icon"
            variant="destructive"
            className="h-8 w-8 rounded-full"
            onClick={stopGeneration}
            data-testid="button-stop"
            aria-label={t('chat.stopGeneration', { defaultValue: 'Stop generation' })}
          >
            <Square className="w-3.5 h-3.5 fill-current" />
          </Button>
        ) : (
          <Button
            size="icon"
            variant="default"
            className="h-8 w-8 rounded-full"
            onClick={handleSend}
            disabled={!prompt.trim() || isListening}
            data-testid="button-send"
            aria-label={t('chat.sendMessage')}
          >
            <Send className={cn("w-4 h-4", isRTL && "rotate-180")} />
          </Button>
        )}
      </div>

      {/* Listening indicator */}
      {isListening && (
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
          <span>{t('chat.listeningIndicator')}</span>
        </div>
      )}
    </div>
  ), [prompt, isSending, student, isRTL, t, handleKeyDown, handleSend, stopGeneration, getPlaceholder, attachedFiles, isUploadingFile, removeFile, handleFileSelect, handleAddFilesClick, VoiceControls, isListening, interimTranscript, sttError]);

  return (
    <div className="flex flex-col h-full relative">
      {/* Mode switch button */}
      {ModeSwitchButton}
      
      {showWelcome ? (
        /* Welcome screen - centered content */
        <div className="flex-1 flex items-center justify-center px-6 overflow-y-auto">
          <div className="w-full max-w-3xl space-y-8 py-12">
            {/* Welcome message */}
            <div className="text-center space-y-2">
              <h2 
                className="text-3xl font-medium text-foreground" 
                data-testid="text-welcome"
              >
                {getGreeting()}, {user?.firstName || 'User'}.
              </h2>
              <p className="text-base text-muted-foreground">
                {student 
                  ? t('chat.welcomeWithUser', { name: student.name })
                  : t('chat.welcomeMessage')
                }
              </p>
              {student && (
                <p className="text-sm text-muted-foreground/70">
                  {t('chat.workingWith')} <span className="font-medium">{student.name}</span>
                </p>
              )}
            </div>

            {/* Persona selector */}
            <div className="flex justify-center">
              {PersonaSelector}
            </div>

            {/* Input bar */}
            <div className="space-y-4">
              {InputBar}
            </div>

            {/* Quick action suggestions */}
            <div className="flex flex-wrap justify-center gap-2">
              {student && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    onClick={() => handleSuggestionClick('chat.prompts.communicationPrefs')}
                  >
                    {t('chat.suggestions.communicationPrefs')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    onClick={() => handleSuggestionClick('chat.prompts.milestones')}
                  >
                    {t('chat.suggestions.milestones')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    onClick={() => handleSuggestionClick('chat.prompts.dailyTips')}
                  >
                    {t('chat.suggestions.dailyTips')}
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      ) : (
        /* Chat conversation view */
        <>
          {/* Header with persona dropdown */}
          <div className="flex-shrink-0 border-b border-border px-6 py-3 flex items-center justify-between">
            {PersonaDropdown}
          </div>

          {/* Scrollable messages area */}
          <div 
            ref={scrollAreaRef}
            className="flex-1 min-h-0 overflow-y-auto px-6 py-6"
          >
            <div className="space-y-6 max-w-4xl mx-auto">
              {history.map((message, index) => (
                <div
                  key={`${message.timestamp}-${index}`}
                  dir={isRTL ? 'rtl' : 'ltr'}
                  className={cn(
                    "flex gap-4",
                    message.role === 'user' ? "justify-end" : "justify-start"
                  )}
                  data-testid={`message-${message.role}-${index}`}
                >
                  {message.role === 'assistant' && (
                    <Avatar className="w-8 h-8 mt-1 flex-shrink-0">
                      <AvatarFallback className={cn("bg-primary/10", currentPersonaInfo && getPersonaColorClasses(currentPersonaInfo))}>
                        <PersonaIcon persona={persona} size="md" />
                      </AvatarFallback>
                    </Avatar>
                  )}
                  <div className="max-w-2xl">
                    <div
                      className={cn(
                        "rounded-2xl px-4 py-3",
                        message.role === 'user'
                          ? "bg-primary text-primary-foreground"
                          : message.role === 'system'
                          ? "bg-destructive/10 border border-destructive/20 text-destructive"
                          : "bg-card border border-card-border text-card-foreground"
                      )}
                    >
                      {isHtmlContent(message) ? (
                        <div 
                          className="text-sm prose prose-sm dark:prose-invert max-w-none"
                          dir={isRTL ? 'rtl' : 'ltr'}
                          dangerouslySetInnerHTML={{ __html: getMessageContent(message) }}
                        />
                      ) : (
                        <p className="text-sm whitespace-pre-wrap">
                          {getMessageContent(message)}
                        </p>
                      )}
                    </div>
                    <div className={cn(
                      "flex items-center gap-2 mt-2",
                      message.role === 'user' ? "justify-end" : "justify-start"
                    )}>
                      <p className="text-xs text-muted-foreground opacity-70">
                        {formatTimestamp(message.timestamp)}
                      </p>
                      {/* TTS button for assistant messages */}
                      {message.role === 'assistant' && ttsSupported && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-5 w-5 opacity-50 hover:opacity-100"
                              onClick={() => handleSpeakMessage(message)}
                              aria-label={t('chat.speakMessage')}
                            >
                              <Volume2 className="w-3 h-3" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {t('chat.speakMessage')}
                          </TooltipContent>
                        </Tooltip>
                      )}
                      {/* Copy button for assistant messages */}
                      {message.role === 'assistant' && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-5 w-5 opacity-50 hover:opacity-100"
                              onClick={() => handleCopyMessage(message, index)}
                              aria-label={t('chat.copyMessage')}
                            >
                              {copiedMessageIndex === index ? (
                                <Check className="w-3 h-3 text-green-500" />
                              ) : (
                                <Copy className="w-3 h-3" />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {copiedMessageIndex === index ? t('chat.copied') : t('chat.copyMessage')}
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              
              {/* Typing/Thinking indicator — hidden while text is actively streaming */}
              {isSending && !(history.length > 0 && (history[history.length - 1].metadata as any)?.isStreaming) && (
                <div
                  dir={isRTL ? 'rtl' : 'ltr'}
                  className="flex gap-4 justify-start"
                  data-testid="typing-indicator"
                >
                  <Avatar className="w-8 h-8 mt-1 flex-shrink-0">
                    <AvatarFallback className={cn("bg-primary/10", currentPersonaInfo && getPersonaColorClasses(currentPersonaInfo))}>
                      <PersonaIcon persona={persona} size="md" />
                    </AvatarFallback>
                  </Avatar>
                  <div className="max-w-2xl">
                    <div className="rounded-2xl px-4 py-3 bg-card border border-card-border">
                      {isThinking && thinkingText ? (
                        // Show thinking text with animated icon
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Sparkles className="w-4 h-4 animate-pulse text-primary" />
                          <span>{thinkingText}</span>
                        </div>
                      ) : (
                        // Show bouncing dots (fallback)
                        <div className="flex gap-1">
                          <div className="w-2 h-2 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: '0ms' }} />
                          <div className="w-2 h-2 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: '150ms' }} />
                          <div className="w-2 h-2 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: '300ms' }} />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Error display */}
              {error && (
                <div className="flex justify-center">
                  <div className="bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-2 text-destructive text-sm">
                    {error}
                  </div>
                </div>
              )}

              {/* Scroll anchor */}
              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* Fixed input bar at bottom */}
          <div className="flex-shrink-0 bg-background border-t border-border px-6 py-4">
            <div className="max-w-3xl mx-auto space-y-3">
              {InputBar}
              
              {/* New conversation button */}
              <div className="flex justify-center">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() => startNewSession()}
                >
                  {t('chat.newConversation')}
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}