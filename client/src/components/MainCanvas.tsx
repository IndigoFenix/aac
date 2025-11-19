import { useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Bot, Plus, Settings2, Mic, Grid3x3, MessageCircle, FileText } from "lucide-react";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
};

type MainCanvasProps = {
  messages?: Message[];
};

export function MainCanvas({ messages: initialMessages = [] }: MainCanvasProps) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [prompt, setPrompt] = useState("");
  const [selectedTool, setSelectedTool] = useState("syntaacx");
  const [isRecording, setIsRecording] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  
  const showWelcome = messages.length === 0;

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
  };

  const clientName = "Sarah";

  const quickActions = [
    {
      id: "syntaacx",
      icon: Grid3x3,
      label: "Generate AAC Board",
      testId: "button-generate-board",
    },
    {
      id: "communiacte",
      icon: MessageCircle,
      label: "Interpret AAC Intent",
      testId: "button-interpret-intent",
    },
    {
      id: "docuslp",
      icon: FileText,
      label: "Draft IEP/TLA Document",
      testId: "button-draft-document",
    },
  ];

  const handleQuickAction = (actionId: string, label: string) => {
    console.log(`Quick action triggered: ${actionId} - ${label}`);
  };

  const handleVoiceInput = () => {
    setIsRecording(!isRecording);
    console.log(`Voice input ${!isRecording ? "started" : "stopped"}`);
  };

  const handleSend = () => {
    if (prompt.trim()) {
      const userMessage: Message = {
        id: Date.now().toString(),
        role: "user",
        content: prompt,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      
      // Immediately add user message
      setMessages(prev => [...prev, userMessage]);
      setPrompt("");
      
      // Show typing indicator
      setIsTyping(true);
      
      // Simulate AI response after a delay
      setTimeout(() => {
        const assistantMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: "I'm processing your request using " + selectedTool + ". This is a UI prototype, so actual functionality will be implemented in the full application.",
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        setMessages(prev => [...prev, assistantMessage]);
        setIsTyping(false);
      }, 1500);
    }
  };

  return (
    <ScrollArea className="flex-1 px-6">
      {showWelcome ? (
        <div className="flex items-center justify-center h-full">
          <div className="w-full max-w-3xl space-y-8 py-12">
            <div className="text-center space-y-2">
              <h2 className="text-3xl font-medium text-foreground" data-testid="text-welcome">
                {getGreeting()}, {clientName}.
              </h2>
              <p className="text-base text-muted-foreground">
                What do you need to do today?
              </p>
            </div>

            <div className="space-y-4">
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
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Ask CliniAACian"
                  className="flex-1 border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 text-base h-8 px-2"
                  data-testid="input-prompt"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                />

                <Select value={selectedTool} onValueChange={setSelectedTool}>
                  <SelectTrigger className="w-40 h-8 border-0 focus:ring-0 bg-transparent" data-testid="select-tool">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="syntaacx">SyntAACx</SelectItem>
                    <SelectItem value="communiacte">CommuniACCte</SelectItem>
                    <SelectItem value="docuslp">DocuSLP</SelectItem>
                  </SelectContent>
                </Select>

                <Button
                  size="icon"
                  variant={isRecording ? "default" : "ghost"}
                  className="h-8 w-8 rounded-full hover-elevate active-elevate-2"
                  onClick={handleVoiceInput}
                  data-testid="button-voice-input"
                >
                  <Mic className={`w-4 h-4 ${isRecording ? "animate-pulse" : ""}`} />
                </Button>
              </div>

              <div className="flex flex-wrap gap-3 justify-center">
                {quickActions.map((action) => (
                  <Button
                    key={action.id}
                    variant="secondary"
                    className="rounded-full px-5 py-2 h-auto hover-elevate active-elevate-2"
                    onClick={() => handleQuickAction(action.id, action.label)}
                    data-testid={action.testId}
                  >
                    <action.icon className="w-4 h-4 mr-2" />
                    <span className="text-sm">{action.label}</span>
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col h-full">
          <div className="flex-1 py-6 space-y-6 overflow-y-auto">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`flex gap-4 ${message.role === "user" ? "justify-end" : "justify-start"}`}
                data-testid={`message-${message.role}-${message.id}`}
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
                        : "bg-card border border-card-border text-card-foreground"
                    }`}
                  >
                    <p className="text-sm">{message.content}</p>
                  </div>
                  <p className="text-xs text-muted-foreground mt-2 opacity-70">
                    {message.timestamp}
                  </p>
                </div>
              </div>
            ))}
            
            {isTyping && (
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
          </div>

          <div className="sticky bottom-0 bg-background border-t border-border p-6">
            <div className="max-w-3xl mx-auto">
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
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Ask CliniAACian"
                  className="flex-1 border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 text-base h-8 px-2"
                  data-testid="input-prompt"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                />

                <Select value={selectedTool} onValueChange={setSelectedTool}>
                  <SelectTrigger className="w-40 h-8 border-0 focus:ring-0 bg-transparent" data-testid="select-tool">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="syntaacx">SyntAACx</SelectItem>
                    <SelectItem value="communiacte">CommuniACCte</SelectItem>
                    <SelectItem value="docuslp">DocuSLP</SelectItem>
                  </SelectContent>
                </Select>

                <Button
                  size="icon"
                  variant={isRecording ? "default" : "ghost"}
                  className="h-8 w-8 rounded-full hover-elevate active-elevate-2"
                  onClick={handleVoiceInput}
                  data-testid="button-voice-input"
                >
                  <Mic className={`w-4 h-4 ${isRecording ? "animate-pulse" : ""}`} />
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </ScrollArea>
  );
}
