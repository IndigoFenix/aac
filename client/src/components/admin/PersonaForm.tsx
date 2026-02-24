// src/components/admin/PersonaForm.tsx
// Form for creating and editing personas

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2 } from 'lucide-react';
import {
  usePersonaMutations,
  type Persona,
  type CreatePersonaData,
  type UpdatePersonaData,
} from '@/hooks/useAdminData';
import {
  PROVIDER_LABELS,
  getModelsForProvider,
  getModelOption,
  type LLMProviderKey,
} from '@shared/llm-options';

const TIER_COLORS: Record<string, string> = {
  economy: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  standard: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  premium: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
};

const SYSTEM_DEFAULT = '__system_default__';

interface PersonaFormProps {
  open: boolean;
  onClose: () => void;
  persona: Persona | null; // null for create, Persona for edit
}

export function PersonaForm({ open, onClose, persona }: PersonaFormProps) {
  const { toast } = useToast();
  const { createPersona, updatePersona } = usePersonaMutations();
  const isEditing = !!persona;

  const [formData, setFormData] = useState({
    title: '',
    icon: '',
    prompt: '',
    manualSelection: true,
    active: true,
    llmProvider: null as string | null,
    llmModel: null as string | null,
  });

  // Reset form when dialog opens/closes or persona changes
  useEffect(() => {
    if (open) {
      if (persona) {
        setFormData({
          title: persona.title,
          icon: persona.icon,
          prompt: persona.prompt,
          manualSelection: persona.manualSelection,
          active: persona.active,
          llmProvider: persona.llmProvider,
          llmModel: persona.llmModel,
        });
      } else {
        setFormData({
          title: '',
          icon: '',
          prompt: '',
          manualSelection: true,
          active: true,
          llmProvider: null,
          llmModel: null,
        });
      }
    }
  }, [open, persona]);

  const handleProviderChange = (value: string) => {
    if (value === SYSTEM_DEFAULT) {
      setFormData((prev) => ({ ...prev, llmProvider: null, llmModel: null }));
    } else {
      const models = getModelsForProvider(value as LLMProviderKey);
      setFormData((prev) => ({
        ...prev,
        llmProvider: value,
        llmModel: models[0]?.modelId || null,
      }));
    }
  };

  const handleModelChange = (value: string) => {
    setFormData((prev) => ({ ...prev, llmModel: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validation
    if (!formData.title.trim()) {
      toast({
        title: 'Validation Error',
        description: 'Title is required',
        variant: 'destructive',
      });
      return;
    }
    if (!formData.icon.trim()) {
      toast({
        title: 'Validation Error',
        description: 'Icon is required',
        variant: 'destructive',
      });
      return;
    }
    if (!formData.prompt.trim()) {
      toast({
        title: 'Validation Error',
        description: 'Prompt is required',
        variant: 'destructive',
      });
      return;
    }

    try {
      if (isEditing) {
        await updatePersona.mutateAsync({
          id: persona.id,
          data: formData as UpdatePersonaData,
        });
        toast({ title: 'Agent updated successfully' });
      } else {
        await createPersona.mutateAsync(formData as CreatePersonaData);
        toast({ title: 'Agent created successfully' });
      }
      onClose();
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || `Failed to ${isEditing ? 'update' : 'create'} agent`,
        variant: 'destructive',
      });
    }
  };

  const isLoading = createPersona.isPending || updatePersona.isPending;

  const selectedProvider = formData.llmProvider as LLMProviderKey | null;
  const availableModels = selectedProvider ? getModelsForProvider(selectedProvider) : [];
  const currentModel = selectedProvider && formData.llmModel
    ? getModelOption(selectedProvider, formData.llmModel)
    : undefined;

  return (
    <Dialog open={open} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? 'Edit Agent' : 'Create Agent'}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? 'Update the agent settings and prompt'
              : 'Create a new AI agent with a custom system prompt'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0 gap-4">
          <DialogBody className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={formData.title}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, title: e.target.value }))
                }
                placeholder="e.g., Clinical Assistant"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="icon">Icon (emoji)</Label>
              <Input
                id="icon"
                value={formData.icon}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, icon: e.target.value }))
                }
                placeholder="e.g., "
                className="text-xl"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="prompt">System Prompt</Label>
            <Textarea
              id="prompt"
              value={formData.prompt}
              onChange={(e) =>
                setFormData((prev) => ({ ...prev, prompt: e.target.value }))
              }
              placeholder="Enter the system prompt for this agent..."
              rows={12}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Use {'{{US_ONLY: content}}'} or {'{{IL_ONLY: content}}'} for jurisdiction-specific content.
            </p>
          </div>

          {/* LLM Model Override */}
          <div className="space-y-3">
            <Label>LLM Model Override</Label>
            <p className="text-xs text-muted-foreground -mt-1">
              Optionally use a specific model for this agent instead of the system default.
            </p>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Provider</label>
                <Select
                  value={formData.llmProvider || SYSTEM_DEFAULT}
                  onValueChange={handleProviderChange}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SYSTEM_DEFAULT}>System Default</SelectItem>
                    {(Object.keys(PROVIDER_LABELS) as LLMProviderKey[]).map((p) => (
                      <SelectItem key={p} value={p}>
                        {PROVIDER_LABELS[p]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Model</label>
                <Select
                  value={formData.llmModel || ''}
                  onValueChange={handleModelChange}
                  disabled={!selectedProvider}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={selectedProvider ? 'Select model' : 'Select provider first'} />
                  </SelectTrigger>
                  <SelectContent>
                    {availableModels.map((m) => (
                      <SelectItem key={m.modelId} value={m.modelId}>
                        {m.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {currentModel && (
              <div className="flex items-center gap-3 text-sm text-muted-foreground bg-muted/50 rounded-md p-3">
                <Badge variant="outline" className={TIER_COLORS[currentModel.tier]}>
                  {currentModel.tier}
                </Badge>
                <span>{currentModel.description}</span>
                <span className="ms-auto text-xs font-mono">
                  ${currentModel.inputCostPer1M}/{currentModel.outputCostPer1M} per 1M tokens
                </span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <Checkbox
                id="manualSelection"
                checked={formData.manualSelection}
                onCheckedChange={(checked) =>
                  setFormData((prev) => ({
                    ...prev,
                    manualSelection: checked === true,
                  }))
                }
              />
              <Label htmlFor="manualSelection" className="cursor-pointer">
                Manual Selection
              </Label>
              <span className="text-xs text-muted-foreground">
                (Users can select this agent in chat)
              </span>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="active"
                checked={formData.active}
                onCheckedChange={(checked) =>
                  setFormData((prev) => ({
                    ...prev,
                    active: checked === true,
                  }))
                }
              />
              <Label htmlFor="active" className="cursor-pointer">
                Active
              </Label>
            </div>
          </div>

          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
              {isEditing ? 'Update' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
