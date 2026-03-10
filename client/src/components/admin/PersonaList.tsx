// src/components/admin/PersonaList.tsx
// List and manage AI personas

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import {
  Plus,
  Pencil,
  Trash2,
  Loader2,
} from 'lucide-react';
import {
  usePersonas,
  usePersonaMutations,
  useAllInstitutes,
  type Persona,
} from '@/hooks/useAdminData';
import { PersonaForm } from './PersonaForm';
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
import { resolveLocalizedText } from '@shared/localized-text';
import { useLanguage } from '@/contexts/LanguageContext';

export function PersonaList() {
  const { toast } = useToast();
  const { language } = useLanguage();
  const { data: personas, isLoading, error } = usePersonas();
  const { data: institutes } = useAllInstitutes();
  const { updatePersona, deletePersona } = usePersonaMutations();

  const [editingPersona, setEditingPersona] = useState<Persona | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const getInstituteName = (id: string | null) => {
    if (!id || !institutes) return null;
    return institutes.find((i) => i.id === id)?.name ?? null;
  };

  const handleToggleActive = async (persona: Persona) => {
    try {
      await updatePersona.mutateAsync({
        id: persona.id,
        data: { active: !persona.active },
      });
      toast({
        title: persona.active ? 'Persona deactivated' : 'Persona activated',
      });
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || 'Failed to update persona',
        variant: 'destructive',
      });
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirmId) return;
    try {
      await deletePersona.mutateAsync(deleteConfirmId);
      toast({ title: 'Persona deleted' });
      setDeleteConfirmId(null);
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || 'Failed to delete persona',
        variant: 'destructive',
      });
    }
  };

  const handleEdit = (persona: Persona) => {
    setEditingPersona(persona);
    setIsFormOpen(true);
  };

  const handleCreate = () => {
    setEditingPersona(null);
    setIsFormOpen(true);
  };

  const handleFormClose = () => {
    setIsFormOpen(false);
    setEditingPersona(null);
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
        <p className="text-destructive">Error loading agents: {error.message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Agents</h1>
          <p className="text-muted-foreground">
            Manage AI agents and their system prompts (personas).
          </p>
        </div>
        <Button onClick={handleCreate}>
          <Plus className="w-4 h-4 me-2" />
          Add Agent
        </Button>
      </div>

      {/* Persona Grid */}
      {personas && personas.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {personas.map((persona) => {
            const title = resolveLocalizedText(persona.title, language);
            const description = resolveLocalizedText(persona.description, language);
            const instituteName = getInstituteName(persona.instituteId);

            return (
              <Card key={persona.id} className={!persona.active ? 'opacity-60' : ''}>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-2xl flex-shrink-0">{persona.icon}</span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <CardTitle className="text-lg">{title}</CardTitle>
                          {persona.testMode && (
                            <Badge variant="outline" className="bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200 text-[10px] px-1.5 py-0">
                              Test
                            </Badge>
                          )}
                        </div>
                        {instituteName && (
                          <span className="text-xs text-muted-foreground">{instituteName}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleEdit(persona)}
                      >
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setDeleteConfirmId(persona.id)}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                  <CardDescription className="line-clamp-2">
                    {description || persona.prompt.substring(0, 100) + '...'}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id={`active-${persona.id}`}
                        checked={persona.active}
                        onCheckedChange={() => handleToggleActive(persona)}
                      />
                      <label
                        htmlFor={`active-${persona.id}`}
                        className="text-sm text-muted-foreground cursor-pointer"
                      >
                        Active
                      </label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id={`manual-${persona.id}`}
                        checked={persona.manualSelection}
                        disabled
                      />
                      <label
                        htmlFor={`manual-${persona.id}`}
                        className="text-sm text-muted-foreground"
                      >
                        Manual Selection
                      </label>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-muted-foreground mb-4">No agents yet</p>
            <Button onClick={handleCreate}>
              <Plus className="w-4 h-4 me-2" />
              Create your first agent
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Persona Form Dialog */}
      <PersonaForm
        open={isFormOpen}
        onClose={handleFormClose}
        persona={editingPersona}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteConfirmId} onOpenChange={() => setDeleteConfirmId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Agent</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this agent? This action cannot be undone.
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
