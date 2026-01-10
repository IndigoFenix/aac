// src/features/ChatPopup.tsx
// Floating chat popup component with persona dropdown and proper RTL support

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
  Send,
  Minus,
  Maximize2,
  MessageCircle,
  Sparkles,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useChat, CHAT_PERSONAS } from '@/hooks/useChat';
import { useStudent } from '@/hooks/useStudent';
import { useLanguage } from '@/contexts/LanguageContext';
import { useFeaturePanel } from '@/contexts/FeaturePanelContext';
import { ChatMessage, ChatMessageContent, ChatPersona } from '@shared/schema';
import { cn } from '@/lib/utils';
import { PersonaIcon, getPersonaColorClasses } from '@/components/chat/PersonaIcon';

export function ChatPopup() {
  const [prompt, setPrompt] = useState('');
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  
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
    thinkingText,
    isThinking
  } = useChat();

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
    setPersona(newPersona as ChatPersona);
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
          "bg-background border border-border rounded-2xl shadow-2xl overflow-hidden",
          "flex flex-col",
          "animate-in slide-in-from-bottom-4 duration-300"
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-card border-b border-border">
          <div className="flex items-center gap-2">
            <PersonaIcon persona={persona} size="lg" withBackground />
            <div className="flex-1 min-w-0">
              {/* Persona dropdown selector */}
              <Select value={persona} onValueChange={handlePersonaChange}>
                <SelectTrigger 
                  className="h-auto py-0 px-0 border-0 bg-transparent focus:ring-0 gap-1"
                >
                  <SelectValue>
                    <span className="text-sm font-medium">
                      {t(currentPersonaInfo?.labelKey || 'chat.persona.assistant')}
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {CHAT_PERSONAS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      <div className="flex items-center gap-2">
                        <PersonaIcon persona={p} size="sm" withBackground />
                        <div className="flex flex-col">
                          <span className="text-sm">{t(p.labelKey)}</span>
                          <span className="text-xs text-muted-foreground">{t(p.descriptionKey)}</span>
                        </div>
                      </div>
                    </SelectItem>
                  ))}
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
                {t(currentPersonaInfo?.descriptionKey || 'chat.persona.assistantDesc')}
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
        <div className="px-3 py-3 border-t border-border bg-card">
          <div className="flex items-center gap-2 bg-muted rounded-full px-3 py-1">
            <Input
              ref={inputRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t('chat.placeholderShort')}
              className="flex-1 border-0 bg-transparent focus-visible:ring-0 text-sm h-8 px-1"
              dir={isRTL ? 'rtl' : 'ltr'}
              data-testid="chat-popup-input"
              onKeyDown={handleKeyDown}
              disabled={isSending}
            />
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 rounded-full"
              onClick={handleSend}
              disabled={!prompt.trim() || isSending}
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