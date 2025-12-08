// src/features/ChatFeature.tsx
import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Bot, Plus, Settings2, Mic, Send } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useChat } from '@/hooks/useChat';
import { useAacUser } from '@/hooks/useAacUser';
import { useLanguage } from '@/contexts/LanguageContext';
import { useSharedState } from '@/contexts/FeaturePanelContext';
import { ChatMessage, ChatMessageContent } from '@shared/schema';
import { cn } from '@/lib/utils';

export function ChatFeature() {
  const [prompt, setPrompt] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  
  const { user } = useAuth();
  const { aacUser } = useAacUser();
  const { t, isRTL } = useLanguage();
  const { sharedState, setSharedState } = useSharedState();
  
  const { 
    history, 
    sendMessage, 
    isSending, 
    error,
    startNewSession 
  } = useChat();
  
  const showWelcome = history.length === 0;
  const showTools = false; // Placeholder for future tools feature

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history, isSending]);

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

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return t('chat.greeting.morning');
    if (hour < 18) return t('chat.greeting.afternoon');
    return t('chat.greeting.evening');
  };

  const handleVoiceInput = () => {
    setIsRecording(!isRecording);
    console.log(`Voice input ${!isRecording ? 'started' : 'stopped'}`);
  };

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

  const handleSuggestionClick = (promptKey: string) => {
    const promptText = t(promptKey, { name: aacUser?.name || '' });
    setPrompt(promptText);
    inputRef.current?.focus();
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

  const formatTimestamp = (timestamp: number): string => {
    return new Date(timestamp).toLocaleTimeString([], { 
      hour: '2-digit', 
      minute: '2-digit' 
    });
  };

  const getPlaceholder = () => {
    if (aacUser) {
      return t('chat.placeholderWithUser', { name: aacUser.name });
    }
    return t('chat.placeholder');
  };

  // Input bar component
  const InputBar = useMemo(() => (
    <div className={cn(
      "relative bg-card border border-card-border rounded-full px-6 py-4 flex items-center gap-3",
      isRTL && "flex-row-reverse"
    )}>
      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8 rounded-full hover-elevate active-elevate-2"
        data-testid="button-add-attachment"
        onClick={() => console.log('Add attachment clicked')}
        aria-label={t('chat.addAttachment')}
      >
        <Plus className="w-5 h-5" />
      </Button>
      
      {showTools && (
        <Button
          variant="ghost"
          className={cn(
            "h-8 rounded-full hover-elevate active-elevate-2",
            isRTL && "flex-row-reverse"
          )}
          data-testid="button-tools"
          onClick={() => console.log('Tools clicked')}
        >
          <Settings2 className={cn("w-4 h-4", isRTL ? "ml-2" : "mr-2")} />
          <span className="text-sm">{t('chat.tools')}</span>
        </Button>
      )}

      <Input
        ref={inputRef}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={getPlaceholder()}
        className={cn(
          "flex-1 border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 text-base h-8 px-2",
          isRTL && "text-right"
        )}
        dir={isRTL ? 'rtl' : 'ltr'}
        data-testid="input-prompt"
        onKeyDown={handleKeyDown}
        disabled={isSending}
      />

      <Button
        size="icon"
        variant={isRecording ? 'default' : 'ghost'}
        className="h-8 w-8 rounded-full hover-elevate active-elevate-2"
        onClick={handleVoiceInput}
        data-testid="button-voice-input"
        aria-label={t('chat.voiceInput')}
      >
        <Mic className={cn("w-4 h-4", isRecording && "animate-pulse")} />
      </Button>

      <Button
        size="icon"
        variant="default"
        className="h-8 w-8 rounded-full"
        onClick={handleSend}
        disabled={!prompt.trim() || isSending}
        data-testid="button-send"
        aria-label={t('chat.sendMessage')}
      >
        <Send className={cn("w-4 h-4", isRTL && "rotate-180")} />
      </Button>
    </div>
  ), [prompt, isRecording, isSending, aacUser, isRTL, t, handleKeyDown, handleVoiceInput, handleSend, getPlaceholder]);

  return (
    <div className="flex flex-col h-full">
      {showWelcome ? (
        /* Welcome screen - centered content */
        <div className="flex-1 flex items-center justify-center px-6 overflow-y-auto">
          <div className="w-full max-w-3xl space-y-8 py-12">
            {/* Welcome message */}
            <div className={cn("text-center space-y-2", isRTL && "rtl")}>
              <h2 
                className="text-3xl font-medium text-foreground" 
                data-testid="text-welcome"
              >
                {getGreeting()}, {user?.firstName || 'User'}.
              </h2>
              <p className="text-base text-muted-foreground">
                {aacUser 
                  ? t('chat.welcomeWithUser', { name: aacUser.name })
                  : t('chat.welcomeMessage')
                }
              </p>
              {aacUser && (
                <p className="text-sm text-muted-foreground/70">
                  {t('chat.workingWith')} <span className="font-medium">{aacUser.name}</span>
                </p>
              )}
            </div>

            {/* Input bar */}
            <div className="space-y-4">
              {InputBar}
            </div>

            {/* Quick action suggestions */}
            <div className={cn(
              "flex flex-wrap justify-center gap-2",
              isRTL && "flex-row-reverse"
            )}>
              {aacUser && (
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
          {/* Scrollable messages area */}
          <div 
            ref={scrollAreaRef}
            className="flex-1 min-h-0 overflow-y-auto px-6 py-6"
          >
            <div className="space-y-6 max-w-4xl mx-auto">
              {history.map((message, index) => (
                <div
                  key={`${message.timestamp}-${index}`}
                  className={cn(
                    "flex gap-4",
                    message.role === 'user' 
                      ? (isRTL ? "justify-start" : "justify-end") 
                      : (isRTL ? "justify-end" : "justify-start"),
                    isRTL && "flex-row-reverse"
                  )}
                  data-testid={`message-${message.role}-${index}`}
                >
                  {message.role === 'assistant' && (
                    <Avatar className="w-8 h-8 mt-1 flex-shrink-0">
                      <AvatarFallback className="bg-primary/10">
                        <Bot className="w-4 h-4 text-primary" />
                      </AvatarFallback>
                    </Avatar>
                  )}
                  <div className={cn(
                    "max-w-2xl",
                    message.role === 'user' && (isRTL ? "text-left" : "text-right")
                  )}>
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
                          className={cn(
                            "text-sm prose prose-sm dark:prose-invert max-w-none",
                            isRTL && "text-right"
                          )}
                          dir={isRTL ? 'rtl' : 'ltr'}
                          dangerouslySetInnerHTML={{ __html: getMessageContent(message) }}
                        />
                      ) : (
                        <p className={cn(
                          "text-sm whitespace-pre-wrap",
                          isRTL && "text-right"
                        )}>
                          {getMessageContent(message)}
                        </p>
                      )}
                    </div>
                    <p className={cn(
                      "text-xs text-muted-foreground mt-2 opacity-70",
                      isRTL && "text-right"
                    )}>
                      {formatTimestamp(message.timestamp)}
                    </p>
                  </div>
                </div>
              ))}
              
              {/* Typing indicator */}
              {isSending && (
                <div 
                  className={cn(
                    "flex gap-4",
                    isRTL ? "justify-end flex-row-reverse" : "justify-start"
                  )} 
                  data-testid="typing-indicator"
                >
                  <Avatar className="w-8 h-8 mt-1 flex-shrink-0">
                    <AvatarFallback className="bg-primary/10">
                      <Bot className="w-4 h-4 text-primary" />
                    </AvatarFallback>
                  </Avatar>
                  <div className="max-w-2xl">
                    <div className="rounded-2xl px-4 py-3 bg-card border border-card-border">
                      <div className="flex gap-1">
                        <div className="w-2 h-2 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: '0ms' }} />
                        <div className="w-2 h-2 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: '150ms' }} />
                        <div className="w-2 h-2 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: '300ms' }} />
                      </div>
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