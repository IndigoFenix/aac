// src/components/admin/VoiceList.tsx
// List and manage custom TTS voices

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import {
  Plus,
  Pencil,
  Trash2,
  Loader2,
} from 'lucide-react';
import {
  useVoices,
  useVoiceMutations,
  type Voice,
} from '@/hooks/useAdminData';
import { VoiceForm } from './VoiceForm';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export function VoiceList() {
  const { toast } = useToast();
  const { data: voices, isLoading, error } = useVoices();
  const { updateVoice, deleteVoice } = useVoiceMutations();

  const [editingVoice, setEditingVoice] = useState<Voice | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const handleToggleActive = async (voice: Voice) => {
    try {
      await updateVoice.mutateAsync({
        id: voice.id,
        data: { active: !voice.active },
      });
      toast({ title: voice.active ? 'Voice deactivated' : 'Voice activated' });
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || 'Failed to update voice',
        variant: 'destructive',
      });
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirmId) return;
    try {
      await deleteVoice.mutateAsync(deleteConfirmId);
      toast({ title: 'Voice deleted' });
      setDeleteConfirmId(null);
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || 'Failed to delete voice',
        variant: 'destructive',
      });
    }
  };

  const handleEdit = (voice: Voice) => {
    setEditingVoice(voice);
    setIsFormOpen(true);
  };

  const handleCreate = () => {
    setEditingVoice(null);
    setIsFormOpen(true);
  };

  const handleFormClose = () => {
    setIsFormOpen(false);
    setEditingVoice(null);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-destructive">Error loading voices: {error.message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Voices</h1>
          <p className="text-muted-foreground">
            Manage custom TTS voices (ElevenLabs). Assign voices to students in AAC Settings.
          </p>
        </div>
        <Button onClick={handleCreate}>
          <Plus className="w-4 h-4 me-2" />
          Add Voice
        </Button>
      </div>

      {/* Voice Grid */}
      {voices && voices.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {voices.map((voice) => (
            <Card key={voice.id} className={!voice.active ? 'opacity-60' : ''}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-lg">{voice.name}</CardTitle>
                    <Badge variant="secondary" className="text-xs">
                      {voice.source}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon" onClick={() => handleEdit(voice)}>
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setDeleteConfirmId(voice.id)}>
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                </div>
                {voice.description && (
                  <CardDescription className="line-clamp-2">
                    {voice.description}
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={`active-${voice.id}`}
                      checked={voice.active}
                      onCheckedChange={() => handleToggleActive(voice)}
                    />
                    <label
                      htmlFor={`active-${voice.id}`}
                      className="text-sm text-muted-foreground cursor-pointer"
                    >
                      Active
                    </label>
                  </div>
                  <span className="text-xs text-muted-foreground font-mono">
                    {voice.externalId.substring(0, 12)}...
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-muted-foreground mb-4">No custom voices yet</p>
            <Button onClick={handleCreate}>
              <Plus className="w-4 h-4 me-2" />
              Add your first voice
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Voice Form Dialog */}
      <VoiceForm open={isFormOpen} onClose={handleFormClose} voice={editingVoice} />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteConfirmId} onOpenChange={() => setDeleteConfirmId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Voice</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this voice? Students using it will fall back to their default OpenAI voice.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
