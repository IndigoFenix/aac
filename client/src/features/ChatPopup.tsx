// src/features/ChatPopup.tsx
// Floating chat popup component for minimized chat mode

import { useState, useRef, useEffect, useCallback } from 'react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { 
  Bot, 
  Send, 
  Minus, 
  Maximize2, 
  MessageCircle,
  X 
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useChat } from '@/hooks/useChat';
import { useStudent } from '@/hooks/useStudent';
import { useLanguage } from '@/contexts/LanguageContext';
import { useFeaturePanel } from '@/contexts/FeaturePanelContext';
import { ChatMessage, ChatMessageContent } from '@shared/schema';
import { cn } from '@/lib/utils';

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
  } = useChat();

  const isMinimized = chatMode === 'minimized';
  const unreadCount = 0; // Could be implemented with actual unread tracking

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

  // Helper to extract display content from message
  const getMessageContent = (message: ChatMessage): string => {
    if (typeof message.content === 'string') {
      return message.content;
    }
    const content = message.content as ChatMessageContent;
    return content.html || content.text || '';
  };

  // Helper to check if content is HTML
  const isHtmlContent = (message: ChatMessage): boolean => {
    if (typeof message.content === 'string') {
      return false;
    }
    const content = message.content as ChatMessageContent;
    return !!content.html;
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
      <div className={cn(
        "bg-background border border-border rounded-2xl shadow-2xl overflow-hidden",
        "flex flex-col",
        "animate-in slide-in-from-bottom-4 duration-300"
      )}>
        {/* Header */}
        <div className={cn(
          "flex items-center justify-between px-4 py-3",
          "bg-card border-b border-border",
          isRTL && "flex-row-reverse"
        )}>
          <div className={cn(
            "flex items-center gap-2",
            isRTL && "flex-row-reverse"
          )}>
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
              <Bot className="w-4 h-4 text-primary" />
            </div>
            <div className={isRTL ? "text-right" : ""}>
              <p className="text-sm font-medium">{t('chat.assistant')}</p>
              {student && (
                <p className="text-xs text-muted-foreground">
                  {t('chat.workingWith')} {student.name}
                </p>
              )}
            </div>
          </div>
          
          <div className={cn(
            "flex items-center gap-1",
            isRTL && "flex-row-reverse"
          )}>
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
            <div className="h-full flex items-center justify-center">
              <p className="text-sm text-muted-foreground text-center">
                {t('chat.popupWelcome')}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {history.slice(-10).map((message, index) => (
                <div
                  key={`${message.timestamp}-${index}`}
                  className={cn(
                    "flex gap-2",
                    message.role === 'user' 
                      ? (isRTL ? "justify-start" : "justify-end") 
                      : (isRTL ? "justify-end" : "justify-start"),
                    isRTL && "flex-row-reverse"
                  )}
                >
                  {message.role === 'assistant' && (
                    <Avatar className="w-6 h-6 flex-shrink-0">
                      <AvatarFallback className="bg-primary/10 text-xs">
                        <Bot className="w-3 h-3 text-primary" />
                      </AvatarFallback>
                    </Avatar>
                  )}
                  <div className={cn(
                    "max-w-[80%]",
                    message.role === 'user' && (isRTL ? "text-left" : "text-right")
                  )}>
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
              
              {/* Typing indicator */}
              {isSending && (
                <div className={cn(
                  "flex gap-2",
                  isRTL ? "justify-end flex-row-reverse" : "justify-start"
                )}>
                  <Avatar className="w-6 h-6 flex-shrink-0">
                    <AvatarFallback className="bg-primary/10 text-xs">
                      <Bot className="w-3 h-3 text-primary" />
                    </AvatarFallback>
                  </Avatar>
                  <div className="rounded-xl px-3 py-2 bg-muted">
                    <div className="flex gap-1">
                      <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: '0ms' }} />
                      <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: '150ms' }} />
                      <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input area */}
        <div className="px-3 py-3 border-t border-border bg-card">
          <div className={cn(
            "flex items-center gap-2 bg-muted rounded-full px-3 py-1",
            isRTL && "flex-row-reverse"
          )}>
            <Input
              ref={inputRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t('chat.placeholderShort')}
              className={cn(
                "flex-1 border-0 bg-transparent focus-visible:ring-0 text-sm h-8 px-1",
                isRTL && "text-right"
              )}
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