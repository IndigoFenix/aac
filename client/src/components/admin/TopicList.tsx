// src/components/admin/TopicList.tsx
// List topics at a given level

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { useLocation } from 'wouter';
import {
  Plus,
  Pencil,
  Trash2,
  Loader2,
  ChevronRight,
  FolderOpen,
} from 'lucide-react';
import {
  useTopics,
  useTopicMutations,
  type Topic,
} from '@/hooks/useAdminData';
import { TopicForm } from './TopicForm';
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

interface TopicListProps {
  parentId: string | null;
}

export function TopicList({ parentId }: TopicListProps) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { data: topics, isLoading, error } = useTopics(parentId);
  const { updateTopic, deleteTopic } = useTopicMutations();

  const [editingTopic, setEditingTopic] = useState<Topic | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [deleteConfirmTopic, setDeleteConfirmTopic] = useState<Topic | null>(null);

  const handleToggleActive = async (topic: Topic) => {
    try {
      await updateTopic.mutateAsync({
        id: topic.id,
        data: { active: !topic.active },
      });
      toast({
        title: topic.active ? 'Topic deactivated' : 'Topic activated',
      });
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || 'Failed to update topic',
        variant: 'destructive',
      });
    }
  };

  const handleDelete = async (cascade: boolean) => {
    if (!deleteConfirmTopic) return;
    try {
      await deleteTopic.mutateAsync({ id: deleteConfirmTopic.id, cascade });
      toast({ title: 'Topic deleted' });
      setDeleteConfirmTopic(null);
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || 'Failed to delete topic',
        variant: 'destructive',
      });
    }
  };

  const handleEdit = (topic: Topic, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingTopic(topic);
    setIsFormOpen(true);
  };

  const handleCreate = () => {
    setEditingTopic(null);
    setIsFormOpen(true);
  };

  const handleFormClose = () => {
    setIsFormOpen(false);
    setEditingTopic(null);
  };

  const handleTopicClick = (topic: Topic) => {
    navigate(`/admin/library/${topic.id}`);
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
        <p className="text-destructive">Error loading topics: {error.message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Library</h1>
          <p className="text-muted-foreground">
            Manage knowledge topics for AI reference
          </p>
        </div>
        <Button onClick={handleCreate}>
          <Plus className="w-4 h-4 me-2" />
          Add Topic
        </Button>
      </div>

      {/* Topic List */}
      {topics && topics.length > 0 ? (
        <div className="space-y-2">
          {topics.map((topic) => (
            <Card
              key={topic.id}
              className={`cursor-pointer transition-colors hover:bg-accent/50 ${!topic.active ? 'opacity-60' : ''}`}
              onClick={() => handleTopicClick(topic)}
            >
              <CardHeader className="py-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <FolderOpen className="w-5 h-5 text-muted-foreground" />
                    <div>
                      <CardTitle className="text-base">{topic.title}</CardTitle>
                      {topic.content && (
                        <CardDescription className="line-clamp-1 mt-1">
                          {topic.content.substring(0, 100)}
                          {topic.content.length > 100 ? '...' : ''}
                        </CardDescription>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-2 me-4">
                      <Checkbox
                        id={`active-${topic.id}`}
                        checked={topic.active}
                        onCheckedChange={() => handleToggleActive(topic)}
                      />
                      <label
                        htmlFor={`active-${topic.id}`}
                        className="text-sm text-muted-foreground cursor-pointer"
                      >
                        Active
                      </label>
                    </div>

                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => handleEdit(topic, e)}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteConfirmTopic(topic);
                      }}
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                    <ChevronRight className="w-5 h-5 text-muted-foreground" />
                  </div>
                </div>
              </CardHeader>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-muted-foreground mb-4">No topics yet</p>
            <Button onClick={handleCreate}>
              <Plus className="w-4 h-4 me-2" />
              Create your first topic
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Topic Form Dialog */}
      <TopicForm
        open={isFormOpen}
        onClose={handleFormClose}
        topic={editingTopic}
        parentId={parentId}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteConfirmTopic} onOpenChange={() => setDeleteConfirmTopic(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Topic</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deleteConfirmTopic?.title}"?
              {deleteConfirmTopic?.childCount && deleteConfirmTopic.childCount > 0 ? (
                <span className="block mt-2 text-destructive">
                  This topic has subtopics. You can delete only this topic or delete it with all subtopics.
                </span>
              ) : (
                <span className="block mt-2">This action cannot be undone.</span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {deleteConfirmTopic?.childCount && deleteConfirmTopic.childCount > 0 ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => handleDelete(false)}
                  disabled={deleteTopic.isPending}
                >
                  Delete Only This
                </Button>
                <AlertDialogAction
                  onClick={() => handleDelete(true)}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete All
                </AlertDialogAction>
              </>
            ) : (
              <AlertDialogAction
                onClick={() => handleDelete(false)}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
