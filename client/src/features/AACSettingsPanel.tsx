import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useStudent } from '@/hooks/useStudent';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTheme } from '@/contexts/ThemeContext';
import { apiRequest } from '@/lib/queryClient';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/hooks/use-toast';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  MessageSquare,
  Volume2,
  Save,
  RotateCcw,
  User,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface AACSettingsPanelProps {
  isOpen?: boolean;
  onClose?: () => void;
}

const DEFAULT_AAC_PROMPT = `You are an advanced conversational AI designed to assist AAC (Augmentative and Alternative Communication) users.
You should:
- Respond in a friendly, supportive manner
- Keep responses concise and clear
- Help expand on the user's symbol selections to form complete thoughts
- Ask clarifying questions when needed
- Be patient and encouraging`;

const VOICE_OPTIONS = [
  { value: 'auto', label: 'Auto (based on age & gender)' },
  { value: 'man', label: 'Man Voice' },
  { value: 'woman', label: 'Woman Voice' },
  { value: 'boy', label: 'Boy Voice' },
  { value: 'girl', label: 'Girl Voice' },
];

export function AACSettingsPanel({ isOpen = true, onClose }: AACSettingsPanelProps) {
  const { student, refetchStudent } = useStudent();
  const { isRTL, t } = useLanguage();
  const { theme } = useTheme();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isDark = theme === 'dark';

  // Form state
  const [chatAgentPrompt, setChatAgentPrompt] = useState('');
  const [voiceType, setVoiceType] = useState('auto');
  const [hasChanges, setHasChanges] = useState(false);

  // Load student data into form
  useEffect(() => {
    if (student) {
      setChatAgentPrompt(student.aacChatAgentPrompt || DEFAULT_AAC_PROMPT);
      setVoiceType(student.aacVoiceType || 'auto');
      setHasChanges(false);
    }
  }, [student]);

  // Track changes
  useEffect(() => {
    if (student) {
      const originalPrompt = student.aacChatAgentPrompt || DEFAULT_AAC_PROMPT;
      const originalVoice = student.aacVoiceType || 'auto';
      setHasChanges(
        chatAgentPrompt !== originalPrompt || voiceType !== originalVoice
      );
    }
  }, [chatAgentPrompt, voiceType, student]);

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: async (data: { aacChatAgentPrompt: string; aacVoiceType: string }) => {
      const response = await apiRequest('PATCH', `/api/students/${student?.id}`, data);
      return response.json();
    },
    onSuccess: async () => {
      await refetchStudent();
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      toast({
        title: 'AAC Settings Updated',
        description: 'The student\'s AAC settings have been saved.',
      });
      setHasChanges(false);
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message || 'Failed to update AAC settings.',
        variant: 'destructive',
      });
    },
  });

  const handleSave = () => {
    if (!student) return;
    updateMutation.mutate({
      aacChatAgentPrompt: chatAgentPrompt,
      aacVoiceType: voiceType,
    });
  };

  const handleReset = () => {
    if (student) {
      setChatAgentPrompt(student.aacChatAgentPrompt || DEFAULT_AAC_PROMPT);
      setVoiceType(student.aacVoiceType || 'auto');
    }
  };

  const handleResetToDefault = () => {
    setChatAgentPrompt(DEFAULT_AAC_PROMPT);
  };

  if (!isOpen) return null;

  if (!student) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center">
        <User className="w-12 h-12 text-muted-foreground mb-4" />
        <h3 className="text-lg font-medium mb-2">No Student Selected</h3>
        <p className="text-sm text-muted-foreground">
          Select a student to configure their AAC settings.
        </p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className={cn(
        "p-6",
        isDark ? "bg-background" : "bg-gray-50/50"
      )}>
        <div className="max-w-3xl mx-auto space-y-6">
          {/* Header */}
          <div className={isRTL ? "text-right" : ""}>
            <h1 className="text-2xl font-bold text-foreground mb-1">
              AAC Settings
            </h1>
            <p className="text-muted-foreground">
              Configure AAC chat behavior for {student.name}
            </p>
          </div>

          {/* Student Info Card */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className={cn(
                "flex items-center gap-2 text-base",
                isRTL && "flex-row-reverse"
              )}>
                <User className="w-4 h-4" />
                Current Student
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className={cn(
                "flex items-center gap-3",
                isRTL && "flex-row-reverse"
              )}>
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                  <User className="w-5 h-5 text-primary" />
                </div>
                <div className={cn("flex-1", isRTL && "text-right")}>
                  <p className="font-medium">{student.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {student.gender === 'male' ? 'Male' : student.gender === 'female' ? 'Female' : 'Not specified'}
                    {student.birthDate && ` • ${new Date().getFullYear() - new Date(student.birthDate).getFullYear()} years old`}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Voice Settings */}
          <Card>
            <CardHeader>
              <CardTitle className={cn(
                "flex items-center gap-2",
                isRTL && "flex-row-reverse"
              )}>
                <Volume2 className="w-5 h-5" />
                Voice Settings
              </CardTitle>
              <CardDescription>
                Choose the voice type for text-to-speech output
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className={cn(
                "flex items-center justify-between",
                isRTL && "flex-row-reverse"
              )}>
                <div className={cn("space-y-0.5", isRTL && "text-right")}>
                  <Label className="text-base font-medium">
                    Voice Type
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Select the voice used when speaking symbols
                  </p>
                </div>
                <Select value={voiceType} onValueChange={setVoiceType}>
                  <SelectTrigger className="w-[200px]">
                    <SelectValue placeholder="Select voice" />
                  </SelectTrigger>
                  <SelectContent>
                    {VOICE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          {/* Chat Agent Prompt */}
          <Card>
            <CardHeader>
              <CardTitle className={cn(
                "flex items-center gap-2",
                isRTL && "flex-row-reverse"
              )}>
                <MessageSquare className="w-5 h-5" />
                Chat Agent Behavior
              </CardTitle>
              <CardDescription>
                Customize how the AI assistant responds to this student
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="chatPrompt" className="text-base font-medium">
                  System Prompt
                </Label>
                <Textarea
                  id="chatPrompt"
                  value={chatAgentPrompt}
                  onChange={(e) => setChatAgentPrompt(e.target.value)}
                  placeholder="Enter custom instructions for the AI assistant..."
                  className="min-h-[200px] font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  This prompt defines how the AI assistant behaves when interacting with this student.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleResetToDefault}
                className="text-xs"
              >
                <RotateCcw className="w-3 h-3 mr-1" />
                Reset to Default
              </Button>
            </CardContent>
          </Card>

          {/* Action Buttons */}
          <div className={cn(
            "flex gap-3 pt-2",
            isRTL ? "flex-row-reverse" : ""
          )}>
            <Button
              onClick={handleSave}
              disabled={!hasChanges || updateMutation.isPending}
              className="flex-1"
            >
              {updateMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              Save Changes
            </Button>
            <Button
              variant="outline"
              onClick={handleReset}
              disabled={!hasChanges || updateMutation.isPending}
            >
              <RotateCcw className="w-4 h-4 mr-2" />
              Discard
            </Button>
          </div>

          {hasChanges && (
            <p className="text-sm text-amber-600 dark:text-amber-400 text-center">
              You have unsaved changes
            </p>
          )}
        </div>
      </div>
    </ScrollArea>
  );
}
