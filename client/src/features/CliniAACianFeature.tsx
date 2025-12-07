import { useState, useRef, useEffect, useMemo } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Bot, Plus, Settings2, Mic, Send } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useChat } from "@/hooks/useChat";
import { useAacUser } from "@/hooks/useAacUser";
import { ChatMessage, ChatMessageContent } from "@shared/schema";

export function CliniAACianFeature() {
  const [prompt, setPrompt] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  
  const { user } = useAuth();
  const { aacUser } = useAacUser();
  const { 
    history, 
    sendMessage, 
    isSending, 
    error,
    startNewSession 
  } = useChat();
  
  const showWelcome = history.length === 0;

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history, isSending]);

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
  };

  const handleVoiceInput = () => {
    setIsRecording(!isRecording);
    console.log(`Voice input ${!isRecording ? "started" : "stopped"}`);
  };

  const handleSend = async () => {
    if (prompt.trim() && !isSending) {
      const messageText = prompt.trim();
      setPrompt("");
      await sendMessage(messageText, { replyType: 'html' });
      // Refocus the input after sending
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
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

  // Input bar component (memoized to prevent recreation)
  const InputBar = useMemo(() => (
    <div className="relative bg-card border border-card-border rounded-full px-6 py-4 flex items-center gap-3">
      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8 rounded-full hover-elevate active-elevate-2"
        data-testid="button-add-attachment"
        onClick={() => console.log("Add attachment clicked")}
      >
        <Plus className="w-5 h-5" />
      </Button>
      
      <Button
        variant="ghost"
        className="h-8 rounded-full hover-elevate active-elevate-2"
        data-testid="button-tools"
        onClick={() => console.log("Tools clicked")}
      >
        <Settings2 className="w-4 h-4 mr-2" />
        <span className="text-sm">Tools</span>
      </Button>

      <Input
        ref={inputRef}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={aacUser ? `Ask about ${aacUser.name}...` : "Ask CliniAACian"}
        className="flex-1 border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 text-base h-8 px-2"
        data-testid="input-prompt"
        onKeyDown={handleKeyDown}
        disabled={isSending}
      />

      <Button
        size="icon"
        variant={isRecording ? "default" : "ghost"}
        className="h-8 w-8 rounded-full hover-elevate active-elevate-2"
        onClick={handleVoiceInput}
        data-testid="button-voice-input"
      >
        <Mic className={`w-4 h-4 ${isRecording ? "animate-pulse" : ""}`} />
      </Button>

      <Button
        size="icon"
        variant="default"
        className="h-8 w-8 rounded-full"
        onClick={handleSend}
        disabled={!prompt.trim() || isSending}
        data-testid="button-send"
      >
        <Send className="w-4 h-4" />
      </Button>
    </div>
  ), [prompt, isRecording, isSending, aacUser, handleKeyDown, handleVoiceInput, handleSend]);

  return (
    <ScrollArea className="flex-1 px-6" ref={scrollAreaRef}>
      {showWelcome ? (
        <div className="flex items-center justify-center h-full">
          <div className="w-full max-w-3xl space-y-8 py-12">
            <div className="text-center space-y-2">
              <h2 className="text-3xl font-medium text-foreground" data-testid="text-welcome">
                {getGreeting()}, {user?.firstName || 'User'}.
              </h2>
              <p className="text-base text-muted-foreground">
                {aacUser 
                  ? `How can I help you with ${aacUser.name} today?`
                  : "What do you need to do today?"
                }
              </p>
              {aacUser && (
                <p className="text-sm text-muted-foreground/70">
                  Currently working with: <span className="font-medium">{aacUser.name}</span>
                </p>
              )}
            </div>

            <div className="space-y-4">
              {InputBar}
            </div>

            {/* Quick action suggestions */}
            <div className="flex flex-wrap justify-center gap-2">
              {aacUser && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    onClick={() => {
                      setPrompt(`Tell me about ${aacUser.name}'s communication preferences`);
                    }}
                  >
                    Communication preferences
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    onClick={() => {
                      setPrompt(`What milestones should we work on with ${aacUser.name}?`);
                    }}
                  >
                    Milestone suggestions
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    onClick={() => {
                      setPrompt(`How can I better support ${aacUser.name}'s communication today?`);
                    }}
                  >
                    Daily support tips
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col h-full">
          <div className="flex-1 py-6 space-y-6 overflow-y-auto">
            {history.map((message, index) => (
              <div
                key={`${message.timestamp}-${index}`}
                className={`flex gap-4 ${message.role === "user" ? "justify-end" : "justify-start"}`}
                data-testid={`message-${message.role}-${index}`}
              >
                {message.role === "assistant" && (
                  <Avatar className="w-8 h-8 mt-1">
                    <AvatarFallback className="bg-primary/10">
                      <Bot className="w-4 h-4 text-primary" />
                    </AvatarFallback>
                  </Avatar>
                )}
                <div className={`max-w-2xl ${message.role === "user" ? "text-right" : ""}`}>
                  <div
                    className={`rounded-2xl px-4 py-3 ${
                      message.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : message.role === "system"
                        ? "bg-destructive/10 border border-destructive/20 text-destructive"
                        : "bg-card border border-card-border text-card-foreground"
                    }`}
                  >
                    {isHtmlContent(message) ? (
                      <div 
                        className="text-sm prose prose-sm dark:prose-invert max-w-none"
                        dangerouslySetInnerHTML={{ __html: getMessageContent(message) }}
                      />
                    ) : (
                      <p className="text-sm whitespace-pre-wrap">{getMessageContent(message)}</p>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-2 opacity-70">
                    {formatTimestamp(message.timestamp)}
                  </p>
                </div>
              </div>
            ))}
            
            {/* Typing indicator */}
            {isSending && (
              <div className="flex gap-4 justify-start" data-testid="typing-indicator">
                <Avatar className="w-8 h-8 mt-1">
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

            <div ref={messagesEndRef} />
          </div>

          {/* Sticky input bar at bottom */}
          <div className="sticky bottom-0 bg-background border-t border-border p-6">
            <div className="max-w-3xl mx-auto space-y-4">
              {InputBar}
              
              {/* New conversation button */}
              <div className="flex justify-center">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() => startNewSession()}
                >
                  Start new conversation
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </ScrollArea>
  );
}