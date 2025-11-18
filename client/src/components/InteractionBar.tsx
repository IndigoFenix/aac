import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Mic, Grid3x3, MessageCircle, FileText, Settings2 } from "lucide-react";

export function InteractionBar() {
  const [prompt, setPrompt] = useState("");
  const [selectedTool, setSelectedTool] = useState("orchestrator");
  const [isRecording, setIsRecording] = useState(false);

  const quickActions = [
    {
      id: "syntaacx",
      icon: Grid3x3,
      label: "Generate AAC Board",
      subtitle: "SyntAACx",
      testId: "button-generate-board",
    },
    {
      id: "communiacte",
      icon: MessageCircle,
      label: "Interpret AAC Intent",
      subtitle: "CommuniACCte",
      testId: "button-interpret-intent",
    },
    {
      id: "docuslp",
      icon: FileText,
      label: "Draft IEP/TLA Document",
      subtitle: "DocuSLP",
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
      console.log(`Sending prompt: ${prompt}`);
      setPrompt("");
    }
  };

  return (
    <div className="border-t border-border bg-card p-6 space-y-4">
      <div className="space-y-4">
        <div>
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2 block">
            Current Tool
          </label>
          <Select value={selectedTool} onValueChange={setSelectedTool}>
            <SelectTrigger className="w-full" data-testid="select-tool">
              <div className="flex items-center gap-2">
                <Settings2 className="w-4 h-4" />
                <SelectValue />
              </div>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="orchestrator">CliniAACian Orchestrator</SelectItem>
              <SelectItem value="syntaacx">SyntAACx - AAC Board Generator</SelectItem>
              <SelectItem value="communiacte">CommuniACCte - Intent Interpreter</SelectItem>
              <SelectItem value="docuslp">DocuSLP - Document Generator</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="relative">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2 block">
            Your Message
          </label>
          <div className="relative">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ask the Orchestrator a question..."
              className="min-h-20 pr-12 resize-none text-sm"
              data-testid="input-prompt"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
            />
            <Button
              size="icon"
              variant={isRecording ? "default" : "ghost"}
              className="absolute right-2 bottom-2"
              onClick={handleVoiceInput}
              data-testid="button-voice-input"
            >
              <Mic className={`w-4 h-4 ${isRecording ? "animate-pulse" : ""}`} />
            </Button>
          </div>
        </div>

        <div>
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3 block">
            Quick Actions
          </label>
          <div className="grid grid-cols-3 gap-4">
            {quickActions.map((action) => (
              <Button
                key={action.id}
                variant="outline"
                className="h-auto flex-col gap-2 p-4 hover-elevate active-elevate-2"
                onClick={() => handleQuickAction(action.id, action.label)}
                data-testid={action.testId}
              >
                <action.icon className="w-7 h-7" />
                <div className="text-center">
                  <p className="text-xs font-medium leading-tight">{action.label}</p>
                  <p className="text-xs text-muted-foreground mt-1">{action.subtitle}</p>
                </div>
              </Button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
