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
import { Loader2, Globe } from 'lucide-react';
import {
  usePersonaMutations,
  useAllInstitutes,
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
import { isMultilingual, parseMultilingual, serializeMultilingual } from '@shared/localized-text';
import { useLanguage } from '@/contexts/LanguageContext';

const TIER_COLORS: Record<string, string> = {
  economy: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  standard: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  premium: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
};

const SYSTEM_DEFAULT = '__system_default__';
const NO_INSTITUTE = '__none__';

// Helper: parse a stored value into { multilingual, en, he } state
function parseFieldState(value: string | null | undefined): { multilingual: boolean; en: string; he: string } {
  const map = parseMultilingual(value);
  if (map) {
    return { multilingual: true, en: map.en || '', he: map.he || '' };
  }
  return { multilingual: false, en: value || '', he: '' };
}

// Helper: serialize field state back to storage value
function serializeFieldState(state: { multilingual: boolean; en: string; he: string }): string {
  if (state.multilingual) {
    return serializeMultilingual({ en: state.en, he: state.he });
  }
  return state.en;
}

interface PersonaFormProps {
  open: boolean;
  onClose: () => void;
  persona: Persona | null; // null for create, Persona for edit
}

export function PersonaForm({ open, onClose, persona }: PersonaFormProps) {
  const { toast } = useToast();
  const { t } = useLanguage();
  const { createPersona, updatePersona } = usePersonaMutations();
  const { data: institutes } = useAllInstitutes();
  const isEditing = !!persona;

  const [formData, setFormData] = useState({
    icon: '',
    prompt: '',
    manualSelection: true,
    active: true,
    testMode: false,
    instituteId: null as string | null,
    llmProvider: null as string | null,
    llmModel: null as string | null,
  });

  const [titleState, setTitleState] = useState({ multilingual: false, en: '', he: '' });
  const [descState, setDescState] = useState({ multilingual: false, en: '', he: '' });

  // Reset form when dialog opens/closes or persona changes
  useEffect(() => {
    if (open) {
      if (persona) {
        setFormData({
          icon: persona.icon,
          prompt: persona.prompt,
          manualSelection: persona.manualSelection,
          active: persona.active,
          testMode: persona.testMode,
          instituteId: persona.instituteId,
          llmProvider: persona.llmProvider,
          llmModel: persona.llmModel,
        });
        setTitleState(parseFieldState(persona.title));
        setDescState(parseFieldState(persona.description));
      } else {
        setFormData({
          icon: '',
          prompt: '',
          manualSelection: true,
          active: true,
          testMode: false,
          instituteId: null,
          llmProvider: null,
          llmModel: null,
        });
        setTitleState({ multilingual: false, en: '', he: '' });
        setDescState({ multilingual: false, en: '', he: '' });
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

    const title = serializeFieldState(titleState);
    const description = serializeFieldState(descState) || null;

    // Validation
    if (!titleState.en.trim()) {
      toast({
        title: t('common.error'),
        description: 'Title (English) is required',
        variant: 'destructive',
      });
      return;
    }
    if (titleState.multilingual && !titleState.he.trim()) {
      toast({
        title: t('common.error'),
        description: 'Title (Hebrew) is required when multilingual is enabled',
        variant: 'destructive',
      });
      return;
    }
    if (!formData.icon.trim()) {
      toast({
        title: t('common.error'),
        description: 'Icon is required',
        variant: 'destructive',
      });
      return;
    }
    if (!formData.prompt.trim()) {
      toast({
        title: t('common.error'),
        description: 'Prompt is required',
        variant: 'destructive',
      });
      return;
    }

    try {
      const payload = { ...formData, title, description };
      if (isEditing) {
        await updatePersona.mutateAsync({
          id: persona.id,
          data: payload as UpdatePersonaData,
        });
        toast({ title: 'Agent updated successfully' });
      } else {
        await createPersona.mutateAsync(payload as CreatePersonaData);
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

          {/* Title */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Label htmlFor="title-en">Title</Label>
              <Button
                type="button"
                variant={titleState.multilingual ? 'default' : 'ghost'}
                size="icon"
                className="h-6 w-6"
                onClick={() => setTitleState((prev) => ({ ...prev, multilingual: !prev.multilingual }))}
                title="Toggle multilingual"
              >
                <Globe className="h-3.5 w-3.5" />
              </Button>
            </div>
            {titleState.multilingual ? (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-muted-foreground">English</label>
                  <Input
                    id="title-en"
                    value={titleState.en}
                    onChange={(e) => setTitleState((prev) => ({ ...prev, en: e.target.value }))}
                    placeholder="e.g., Clinical Assistant"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">עברית</label>
                  <Input
                    value={titleState.he}
                    onChange={(e) => setTitleState((prev) => ({ ...prev, he: e.target.value }))}
                    placeholder="לדוגמה, עוזר קליני"
                    dir="rtl"
                  />
                </div>
              </div>
            ) : (
              <Input
                id="title-en"
                value={titleState.en}
                onChange={(e) => setTitleState((prev) => ({ ...prev, en: e.target.value }))}
                placeholder="e.g., Clinical Assistant"
              />
            )}
          </div>

          {/* Icon */}
          <div className="space-y-2">
            <Label htmlFor="icon">Icon (emoji)</Label>
            <Input
              id="icon"
              value={formData.icon}
              onChange={(e) =>
                setFormData((prev) => ({ ...prev, icon: e.target.value }))
              }
              placeholder="e.g., "
              className="text-xl w-24"
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Label htmlFor="desc-en">Description</Label>
              <Button
                type="button"
                variant={descState.multilingual ? 'default' : 'ghost'}
                size="icon"
                className="h-6 w-6"
                onClick={() => setDescState((prev) => ({ ...prev, multilingual: !prev.multilingual }))}
                title="Toggle multilingual"
              >
                <Globe className="h-3.5 w-3.5" />
              </Button>
            </div>
            {descState.multilingual ? (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-muted-foreground">English</label>
                  <Textarea
                    id="desc-en"
                    value={descState.en}
                    onChange={(e) => setDescState((prev) => ({ ...prev, en: e.target.value }))}
                    placeholder="Brief description of this agent..."
                    rows={2}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">עברית</label>
                  <Textarea
                    value={descState.he}
                    onChange={(e) => setDescState((prev) => ({ ...prev, he: e.target.value }))}
                    placeholder="תיאור קצר של הסוכן..."
                    rows={2}
                    dir="rtl"
                  />
                </div>
              </div>
            ) : (
              <Textarea
                id="desc-en"
                value={descState.en}
                onChange={(e) => setDescState((prev) => ({ ...prev, en: e.target.value }))}
                placeholder="Brief description of this agent..."
                rows={2}
              />
            )}
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

          {/* Institute restriction */}
          <div className="space-y-2">
            <Label>Institute</Label>
            <p className="text-xs text-muted-foreground -mt-1">
              Restrict this agent to a specific institute, or leave global for all users.
            </p>
            <Select
              value={formData.instituteId || NO_INSTITUTE}
              onValueChange={(v) =>
                setFormData((prev) => ({ ...prev, instituteId: v === NO_INSTITUTE ? null : v }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_INSTITUTE}>All Institutes (Global)</SelectItem>
                {institutes?.map((inst) => (
                  <SelectItem key={inst.id} value={inst.id}>
                    {inst.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Checkboxes row */}
          <div className="flex items-center gap-6 flex-wrap">
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

            <div className="flex items-center gap-2">
              <Checkbox
                id="testMode"
                checked={formData.testMode}
                onCheckedChange={(checked) =>
                  setFormData((prev) => ({
                    ...prev,
                    testMode: checked === true,
                  }))
                }
              />
              <Label htmlFor="testMode" className="cursor-pointer">
                Test Mode
              </Label>
              <span className="text-xs text-muted-foreground">
                (Only visible to system admins)
              </span>
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
