// src/features/ChatPopup.tsx
// Floating chat popup component with speech-to-text and text-to-speech support

import { useState, useRef, useEffect, useCallback } from 'react';
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
  Send,
  Minus,
  Maximize2,
  MessageCircle,
  Sparkles,
  Plus,
  Paperclip,
  X,
  FileText,
  Image,
  Loader2,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useChat, type AttachedFile } from '@/hooks/useChat';
import { useStudent } from '@/hooks/useStudent';
import { useLanguage } from '@/contexts/LanguageContext';
import { useFeaturePanel } from '@/contexts/FeaturePanelContext';
import { useSpeechToText } from '@/hooks/useSpeechToText';
import { useTextToSpeech, htmlToPlainText } from '@/hooks/useTextToSpeech';
import { ChatMessage, ChatMessageContent } from '@shared/schema';
import { cn } from '@/lib/utils';
import { PersonaIcon, getPersonaColorClasses } from '@/components/chat/PersonaIcon';

export function ChatPopup() {
  const [prompt, setPrompt] = useState('');
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastReadMessageRef = useRef<number | null>(null);

  const { user } = useAuth();
  const { student } = useStudent();
  const { t, isRTL } = useLanguage();
  const {
    chatMode,
    setChatMode,
    toggleChatMode,
    isFullScreenFeature
  } = useFeaturePanel();

  const {
    history,
    sendMessage,
    isSending,
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
    toggleListening,
    error: sttError,
    isDisabled: sttDisabled,
  } = useSpeechToText({
    onResult: handleSpeechResult,
    continuous: false,
  });

  const isMinimized = chatMode === 'minimized';
  const unreadCount = 0; // Could be implemented with actual unread tracking
  const currentPersonaInfo = getPersonaInfo(persona);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (!isMinimized) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [history, isSending, isMinimized]);

  // Focus input when popup expands
  useEffect(() => {
    if (!isMinimized) {
      inputRef.current?.focus();
    }
  }, [isMinimized]);

  // Auto-read new assistant messages when TTS is enabled
  useEffect(() => {
    if (!ttsEnabled || !ttsSupported || isMinimized) return;
    
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
  }, [history, ttsEnabled, ttsSupported, isMinimized, speak]);

  // Auto-send when speech recognition completes
  useEffect(() => {
    if (!isListening && prompt.trim() && !isSending) {
      const timeout = setTimeout(() => {
        handleSend();
      }, 500);
      return () => clearTimeout(timeout);
    }
  }, [isListening]);

  const handleSend = useCallback(async () => {
    if (prompt.trim() && !isSending) {
      const messageText = prompt.trim();
      setPrompt('');
      await sendMessage(messageText, { replyType: 'html' });
      inputRef.current?.focus();
    }
  }, [prompt, isSending, sendMessage]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const handleMinimize = () => {
    setChatMode('minimized');
  };

  const handleExpand = () => {
    if (isFullScreenFeature) {
      setChatMode('popup');
    } else {
      setChatMode('expanded');
    }
  };

  const handleRestore = () => {
    setChatMode('popup');
  };

  const handlePersonaChange = (newPersona: string) => {
    setPersona(newPersona === 'default' ? undefined : newPersona);
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

  const handleToggleTts = () => {
    if (isSpeaking) {
      stopSpeaking();
    }
    setTtsEnabled(!ttsEnabled);
  };

  const handleVoiceInput = () => {
    toggleListening();
  };

  // Helper to get file icon based on mime type
  const getFileIcon = (mimeType: string) => {
    if (mimeType.startsWith('image/')) {
      return <Image className="w-3 h-3" />;
    }
    return <FileText className="w-3 h-3" />;
  };

  // Helper to format file size
  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Helper to extract display content from message
  const getMessageContent = (message: ChatMessage): string => {
    if (typeof message.content === 'string') {
      return message.content;
    }
    const content = message.content as ChatMessageContent;
    return content.html || content.text || '';
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

  // Position classes based on RTL
  const positionClasses = isRTL 
    ? 'left-4 bottom-4' 
    : 'right-4 bottom-4';

  // Minimized state - just show a floating button
  if (isMinimized) {
    return (
      <div className={cn("fixed z-50", positionClasses)}>
        <Button
          onClick={handleRestore}
          className={cn(
            "h-14 w-14 rounded-full shadow-lg",
            "bg-primary hover:bg-primary/90",
            "transition-all duration-200 hover:scale-105",
            "relative"
          )}
          data-testid="chat-popup-restore"
        >
          <MessageCircle className="w-6 h-6 text-primary-foreground" />
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 w-5 h-5 bg-destructive text-destructive-foreground text-xs rounded-full flex items-center justify-center">
              {unreadCount}
            </span>
          )}
        </Button>
      </div>
    );
  }

  // Expanded popup state
  return (
    <div 
      className={cn(
        "fixed z-50",
        positionClasses,
        "w-96 max-w-[calc(100vw-2rem)]"
      )}
    >
      <div 
        dir={isRTL ? 'rtl' : 'ltr'}
        className={cn(
          "flex flex-col rounded-2xl shadow-2xl border border-border overflow-hidden",
          "bg-background",
          "max-h-[70vh]"
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            {/* Persona icon */}
            <PersonaIcon persona={persona} size="md" withBackground />
            
            {/* Persona selector dropdown */}
            <div className="flex-1 min-w-0">
              <Select
                value={persona || 'default'}
                onValueChange={handlePersonaChange}
                disabled={isPersonasLoading}
              >
                <SelectTrigger className="h-7 text-xs border-none bg-transparent shadow-none px-1">
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
                            <div className="flex flex-col">
                              <span className="text-sm">{p.title}</span>
                            </div>
                          </div>
                        </SelectItem>
                      ))}
                    </>
                  )}
                </SelectContent>
              </Select>
              {student && (
                <p className="text-xs text-muted-foreground truncate">
                  {t('chat.workingWith')} {student.name}
                </p>
              )}
            </div>
          </div>
          
          <div className="flex items-center gap-1">
            {/* TTS Toggle */}
            {ttsSupported && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className={cn(
                      "h-7 w-7 rounded-full",
                      ttsEnabled && "bg-blue-500/20 text-blue-500",
                      isSpeaking && "animate-pulse"
                    )}
                    onClick={handleToggleTts}
                    title={ttsEnabled ? t('chat.disableTts') : t('chat.enableTts')}
                  >
                    {ttsEnabled ? (
                      <Volume2 className="w-3.5 h-3.5" />
                    ) : (
                      <VolumeX className="w-3.5 h-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {ttsEnabled ? t('chat.disableTts') : t('chat.enableTts')}
                </TooltipContent>
              </Tooltip>
            )}

            {/* Expand to full mode (only if not full-screen feature) */}
            {!isFullScreenFeature && (
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 rounded-full hover:bg-muted"
                onClick={handleExpand}
                title={t('chat.expandMode')}
                data-testid="chat-popup-expand"
              >
                <Maximize2 className="w-4 h-4" />
              </Button>
            )}
            
            {/* Minimize */}
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 rounded-full hover:bg-muted"
              onClick={handleMinimize}
              title={t('chat.minimize')}
              data-testid="chat-popup-minimize"
            >
              <Minus className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Messages area */}
        <div 
          ref={scrollAreaRef}
          className="flex-1 overflow-y-auto px-4 py-3 max-h-80 min-h-48"
        >
          {history.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center gap-3">
              <PersonaIcon persona={persona} size="lg" withBackground />
              <p className="text-sm text-muted-foreground text-center">
                {t('chat.popupWelcome')}
              </p>
              <p className="text-xs text-muted-foreground/70 text-center">
                {currentPersonaInfo?.title || t('chat.persona.assistantDesc')}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {history.slice(-10).map((message, index) => (
                <div
                  key={`${message.timestamp}-${index}`}
                  className={cn(
                    "flex gap-2",
                    message.role === 'user' ? "justify-end" : "justify-start"
                  )}
                >
                  {message.role === 'assistant' && (
                    <Avatar className="w-6 h-6 flex-shrink-0">
                      <AvatarFallback className={cn("text-xs", currentPersonaInfo && getPersonaColorClasses(currentPersonaInfo))}>
                        <PersonaIcon persona={persona} size="sm" />
                      </AvatarFallback>
                    </Avatar>
                  )}
                  <div className="max-w-[80%]">
                    <div
                      className={cn(
                        "rounded-xl px-3 py-2 text-sm",
                        message.role === 'user'
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-foreground"
                      )}
                    >
                      {isHtmlContent(message) ? (
                        <div 
                          className="prose prose-sm dark:prose-invert max-w-none text-xs"
                          dangerouslySetInnerHTML={{ __html: getMessageContent(message) }}
                        />
                      ) : (
                        <p className="whitespace-pre-wrap text-xs">
                          {getMessageContent(message)}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              
              {/* Typing/Thinking indicator */}
              {isSending && (
                <div className="flex gap-2 justify-start">
                  <Avatar className="w-6 h-6 flex-shrink-0">
                    <AvatarFallback className={cn("text-xs", currentPersonaInfo && getPersonaColorClasses(currentPersonaInfo))}>
                      <PersonaIcon persona={persona} size="sm" />
                    </AvatarFallback>
                  </Avatar>
                  <div className="rounded-xl px-3 py-2 bg-muted">
                    {isThinking && thinkingText ? (
                      // Show thinking text with animated icon
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Sparkles className="w-3 h-3 animate-pulse text-primary" />
                        <span>{thinkingText}</span>
                      </div>
                    ) : (
                      // Show bouncing dots (fallback)
                      <div className="flex gap-1">
                        <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: '0ms' }} />
                        <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: '150ms' }} />
                        <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: '300ms' }} />
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input area */}
        <div className="px-3 py-3 border-t border-border bg-card space-y-2">
          {/* Attached files list */}
          {attachedFiles.length > 0 && (
            <div
              dir={isRTL ? 'rtl' : 'ltr'}
              className="flex flex-wrap gap-1 px-1"
            >
              {attachedFiles.map((file) => (
                <div
                  key={file.fileId}
                  className="flex items-center gap-1 bg-muted/50 border border-border rounded px-2 py-0.5 text-xs"
                >
                  {getFileIcon(file.mimeType)}
                  <span className="max-w-[80px] truncate">{file.filename}</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-4 w-4 rounded-full hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => removeFile(file.fileId)}
                    aria-label={t('chat.removeFile')}
                  >
                    <X className="w-2.5 h-2.5" />
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

          {/* Listening indicator */}
          {isListening && (
            <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground pb-1">
              <div className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse" />
              <span>{t('chat.listeningIndicator')}</span>
            </div>
          )}

          <div className={cn(
            "flex items-center gap-2 rounded-full px-3 py-1",
            isListening ? "bg-red-500/10 ring-1 ring-red-500/30" : "bg-muted"
          )}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 rounded-full"
                  data-testid="chat-popup-add-attachment"
                  aria-label={t('chat.addAttachment')}
                  disabled={isUploadingFile}
                >
                  {isUploadingFile ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Plus className="w-3.5 h-3.5" />
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={handleAddFilesClick}>
                  <Paperclip className="w-3.5 h-3.5 me-2" />
                  {t('chat.addFiles')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Input
              ref={inputRef}
              value={isListening ? (interimTranscript || prompt) : prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={isListening ? t('chat.listening') : t('chat.placeholderShort')}
              className={cn(
                "flex-1 border-0 bg-transparent focus-visible:ring-0 text-sm h-8 px-1",
                isListening && "text-muted-foreground italic"
              )}
              dir={isRTL ? 'rtl' : 'ltr'}
              data-testid="chat-popup-input"
              onKeyDown={handleKeyDown}
              disabled={isSending || isListening}
            />

            {/* Voice input button */}
            {sttSupported && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className={cn(
                      "h-7 w-7 rounded-full transition-colors",
                      isListening && "bg-red-500/20 text-red-500 animate-pulse",
                      sttDisabled && "opacity-50 cursor-not-allowed"
                    )}
                    onClick={handleVoiceInput}
                    disabled={sttDisabled || isSending}
                    aria-label={isListening ? t('chat.stopListening') : t('chat.voiceInput')}
                  >
                    {isListening ? (
                      <MicOff className="w-3.5 h-3.5" />
                    ) : (
                      <Mic className="w-3.5 h-3.5" />
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

            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 rounded-full"
              onClick={handleSend}
              disabled={!prompt.trim() || isSending || isListening}
              data-testid="chat-popup-send"
            >
              <Send className={cn("w-3.5 h-3.5", isRTL && "rotate-180")} />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}