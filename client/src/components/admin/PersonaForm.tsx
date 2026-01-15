// src/components/admin/PersonaForm.tsx
// Form for creating and editing personas

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Loader2 } from 'lucide-react';
import {
  usePersonaMutations,
  type Persona,
  type CreatePersonaData,
  type UpdatePersonaData,
} from '@/hooks/useAdminData';

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
        });
      } else {
        setFormData({
          title: '',
          icon: '',
          prompt: '',
          manualSelection: true,
          active: true,
        });
      }
    }
  }, [open, persona]);

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

  return (
    <Dialog open={open} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
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

        <form onSubmit={handleSubmit} className="space-y-4">
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
