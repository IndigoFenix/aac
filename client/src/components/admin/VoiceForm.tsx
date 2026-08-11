// src/components/admin/VoiceForm.tsx
// Form for creating and editing custom voices

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
  useVoiceMutations,
  type Voice,
  type CreateVoiceData,
  type UpdateVoiceData,
} from '@/hooks/useAdminData';

interface VoiceFormProps {
  open: boolean;
  onClose: () => void;
  voice: Voice | null; // null for create, Voice for edit
}

export function VoiceForm({ open, onClose, voice }: VoiceFormProps) {
  const { toast } = useToast();
  const { createVoice, updateVoice } = useVoiceMutations();
  const isEditing = !!voice;

  const [formData, setFormData] = useState({
    name: '',
    externalId: '',
    source: 'elevenlabs',
    description: '',
    sampleUrl: '',
    active: true,
  });

  useEffect(() => {
    if (open) {
      if (voice) {
        setFormData({
          name: voice.name,
          externalId: voice.externalId,
          source: voice.source,
          description: voice.description || '',
          sampleUrl: voice.sampleUrl || '',
          active: voice.active,
        });
      } else {
        setFormData({
          name: '',
          externalId: '',
          source: 'elevenlabs',
          description: '',
          sampleUrl: '',
          active: true,
        });
      }
    }
  }, [open, voice]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.name.trim()) {
      toast({ title: 'Validation Error', description: 'Name is required', variant: 'destructive' });
      return;
    }
    if (!formData.externalId.trim()) {
      toast({ title: 'Validation Error', description: 'External ID is required', variant: 'destructive' });
      return;
    }

    try {
      // null, not undefined — the edit path PATCHes and merges by key, so an
      // undefined key is dropped by JSON.stringify and the cleared description
      // or sample URL survives the save.
      const payload = {
        ...formData,
        description: formData.description || null,
        sampleUrl: formData.sampleUrl || null,
      };

      if (isEditing) {
        await updateVoice.mutateAsync({ id: voice.id, data: payload as UpdateVoiceData });
        toast({ title: 'Voice updated successfully' });
      } else {
        await createVoice.mutateAsync(payload as CreateVoiceData);
        toast({ title: 'Voice created successfully' });
      }
      onClose();
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || `Failed to ${isEditing ? 'update' : 'create'} voice`,
        variant: 'destructive',
      });
    }
  };

  const isLoading = createVoice.isPending || updateVoice.isPending;

  return (
    <Dialog open={open} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit Voice' : 'Add Voice'}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? 'Update the custom voice settings'
              : 'Add a custom TTS voice (e.g. from ElevenLabs)'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={formData.name}
              onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="e.g., Sarah (Warm)"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="externalId">External Voice ID</Label>
              <Input
                id="externalId"
                value={formData.externalId}
                onChange={(e) => setFormData((prev) => ({ ...prev, externalId: e.target.value }))}
                placeholder="ElevenLabs voice_id"
                className="font-mono text-sm"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="source">Source</Label>
              <Input
                id="source"
                value={formData.source}
                onChange={(e) => setFormData((prev) => ({ ...prev, source: e.target.value }))}
                placeholder="elevenlabs"
                disabled
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={formData.description}
              onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
              placeholder="Optional description of this voice..."
              rows={2}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="sampleUrl">Sample URL</Label>
            <Input
              id="sampleUrl"
              value={formData.sampleUrl}
              onChange={(e) => setFormData((prev) => ({ ...prev, sampleUrl: e.target.value }))}
              placeholder="https://..."
            />
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="active"
              checked={formData.active}
              onCheckedChange={(checked) =>
                setFormData((prev) => ({ ...prev, active: checked === true }))
              }
            />
            <Label htmlFor="active" className="cursor-pointer">Active</Label>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
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
